import { trpcCall } from './trpc.ts';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-enc-'));
process.env.HEFYN_SECRET = 'enc-test-secret-enc-test-secret-1234567';
process.env.HEFYN_KEY_MODE = 'user'; // the zero-access mode (the server default is server-held keys since 2026-10-27)

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { encrypt } = await import('../src/server/crypto.ts');
const ch = await import('../src/server/channels.ts');
const providers = await import('../src/server/providers.ts');
const seal = await import('../src/server/seal.ts');
const vault = await import('../src/server/vault.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string, legacy?: (id: string) => void) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  legacy?.(r.user.id);
  const u: { id: string; email: string; password: string; cookie: string; login: (password?: string) => Promise<any>; req: (path: string, method?: string, body?: unknown, cookie?: string) => Promise<Response> | Response; status: (peek?: boolean) => Promise<any> } = {
    id: r.user.id, email, password: PW, cookie: '',
    async login(password = PW) {
      const s = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
      u.cookie = cookieOf(s.headers);
      return s.response as any;
    },
    req: (path: string, method = 'GET', body?: unknown, cookie = u.cookie) =>
      app.request(path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }),
    status: async (peek = false) => (await u.req(`/api/security/key-status${peek ? '?peek=1' : ''}`)).json() as Promise<any>,
  };
  return u;
}
const tr = (u: { cookie: string }, proc: string, input?: unknown, mutate = false, cookie = u.cookie) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
// /internal/forget (the agent) is stubbed: it answers ok unless a test says the agent is down.
let forgetOk = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => (String(url).endsWith('/internal/forget') ? new Response('{}', { status: forgetOk ? 200 : 502 }) : realFetch(url, init))) as typeof fetch;
const prov = (id: string) => seal.openProviderSecret(raw('SELECT id, base_url, enc_key FROM providers WHERE id = ?', id));
const raw = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const lockedUser = (id: string) => assert.equal(vault.userKey(id), undefined);

// Legacy state from before encryption (server-key values and plaintext), written BEFORE anybody signs in.
db.prepare("INSERT INTO providers (id, name, enc_key, created_at) VALUES ('anthropic', 'Anthropic', ?, 'now')").run(encrypt('sk-legacy-provider'));
db.prepare("INSERT INTO channels (id, kind, name, config, enc, created_at) VALUES ('c-old', 'telegram', 'old-tg', '{\"recipients\":[]}', ?, 'now')").run(encrypt('legacy-bot-token'));

const admin = await mk('admin@x.test', 'admin');
let teamRecovery = '';

test('first admin sign-in creates the user key, a one-shot recovery key, and the team key (legacy team secrets are sealed)', async () => {
  assert.equal(vault.getTeamKey(), undefined);
  await admin.login();
  const s = await admin.status();
  assert.deepEqual([s.unlocked, s.state, s.hasRecoveryKey, s.teamUnlocked, s.isAdmin], [true, 'ok', true, true, true]);
  assert.match(s.recoveryKeyToShow, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.match(s.teamRecoveryKeyToShow, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  teamRecovery = s.teamRecoveryKeyToShow;
  const again = await admin.status();
  assert.equal(again.recoveryKeyToShow, undefined); // one-shot
  assert.equal(again.teamRecoveryKeyToShow, undefined);
  assert.ok(raw('SELECT 1 AS x FROM team_key_wraps WHERE user_id = ?', admin.id));
  // legacy team secrets were re-sealed under the team key
  const p = raw("SELECT enc_key FROM providers WHERE id = 'anthropic'");
  assert.ok(vault.isSealed(p.enc_key) && !p.enc_key.includes('legacy'));
  assert.equal(prov('anthropic'), 'sk-legacy-provider');
  assert.equal(seal.openTeamSecret(raw("SELECT enc FROM channels WHERE id = 'c-old'").enc, ch.chanAad('c-old', 'telegram', { recipients: [] })), 'legacy-bot-token');
});

test('conversation titles are sealed in the database and readable for their owner', async () => {
  const { id } = (await tr(admin, 'conversations.create', { title: 'Project Falcon' }, true)).json;
  const col = raw('SELECT title FROM conversations WHERE id = ?', id).title as string;
  assert.ok(vault.isSealed(col) && !col.includes('Falcon'));
  const list = (await tr(admin, 'conversations.list')).json as any[];
  assert.equal(list.find((c) => c.id === id).title, 'Project Falcon');
  assert.throws(() => vault.open(vault.newKey(), col, `conv:${id}:title`));
});

test('sign-out locks: the other session gets 423; unlock with the password (what passkey sign-in uses)', async () => {
  const w = await mk('worker@x.test', 'worker');
  await w.login(); const a = w.cookie;
  await w.login(); const b = w.cookie;
  await w.status(); // consume the one-shot key
  assert.equal((await tr(w, 'conversations.create', { title: 'Mine' }, true, a)).status, 200);
  await auth.api.signOut({ headers: { cookie: a } });
  lockedUser(w.id);
  const r = await tr(w, 'conversations.list', undefined, false, b);
  assert.equal(r.status, 412); // tRPC: PRECONDITION_FAILED with the scope (REST answers 423)
  assert.deepEqual([r.error, r.scope], ['locked', 'user']);
  assert.equal((await w.req('/api/security/unlock', 'POST', { password: 'wrong-password' }, b)).status, 401);
  assert.equal((await w.req('/api/security/unlock', 'POST', { password: PW }, b)).status, 200);
  assert.equal((await tr(w, 'conversations.list', undefined, false, b)).json[0].title, 'Mine');
});

test('2FA: the key is not unlocked before the second factor, only by the verifying user', async () => {
  const u = await mk('twofa@x.test', 'worker');
  await u.login();
  const en = await auth.api.enableTwoFactor({ body: { password: PW }, headers: { cookie: u.cookie } }) as any;
  const secret = new TextDecoder().decode(base32.decode(new URL(en.totpURI).searchParams.get('secret')!)); // the URI carries it base32-encoded
  const code = () => createOTP(secret, { digits: 6, period: 30 }).totp();
  await auth.api.verifyTOTP({ body: { code: await code() }, headers: { cookie: u.cookie } });
  vault.forgetUserKey(u.id);

  const s = await auth.api.signInEmail({ body: { email: u.email, password: PW }, returnHeaders: true });
  assert.equal((s.response as any).twoFactorRedirect, true);
  lockedUser(u.id); // password alone did not unlock
  const tfCookie = cookieOf(s.headers);
  await assert.rejects(auth.api.verifyTOTP({ body: { code: '000000' }, headers: { cookie: tfCookie } }));
  lockedUser(u.id);
  const v = await auth.api.verifyTOTP({ body: { code: await code() }, headers: { cookie: tfCookie }, returnHeaders: true });
  assert.ok(vault.userKey(u.id));
  u.cookie = cookieOf(v.headers);
  assert.equal((await tr(u, 'conversations.list')).status, 200);
});

test('password change keeps the data readable under the new password', async () => {
  const u = await mk('pwchange@x.test', 'worker');
  await u.login(); await u.status();
  await tr(u, 'conversations.create', { title: 'Before the change' }, true);
  await auth.api.changePassword({ body: { currentPassword: PW, newPassword: 'brand-new-pass-1' }, headers: { cookie: u.cookie } });
  vault.forgetUserKey(u.id);
  await u.login('brand-new-pass-1');
  assert.equal((await tr(u, 'conversations.list')).json[0].title, 'Before the change');
  // the old password no longer opens the key
  const row = raw('SELECT * FROM user_keys WHERE user_id = ?', u.id);
  await assert.rejects(async () => vault.unwrap(await vault.kdf(PW, Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, `user:${u.id}:pw`));
});

test('password reset -> needs_recovery; the recovery key (and only it) unlocks; the new password then works alone', async () => {
  const u = await mk('reset@x.test', 'worker');
  await u.login();
  const recovery = (await u.status()).recoveryKeyToShow as string;
  await tr(u, 'conversations.create', { title: 'Survives a reset' }, true);
  db.prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('v1', 'reset-password:tok1', ?, ?, ?, ?)").run(u.id, new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString(), new Date().toISOString());
  await auth.api.resetPassword({ body: { token: 'tok1', newPassword: 'after-reset-pass-1' } });
  assert.equal(raw('SELECT state, pw_wrapped FROM user_keys WHERE user_id = ?', u.id).state, 'needs_recovery');
  assert.ok(raw('SELECT pw_wrapped AS w FROM user_keys WHERE user_id = ?', u.id).w); // kept: nothing is destroyed by a reset
  lockedUser(u.id);
  await u.login('after-reset-pass-1');
  lockedUser(u.id); // a sign-in with the new password does not unlock
  const st = await u.status(true);
  assert.deepEqual([st.unlocked, st.state], [false, 'needs_recovery']);
  assert.equal((await u.req('/api/security/unlock', 'POST', { password: 'after-reset-pass-1' })).status, 409);
  assert.equal((await u.req('/api/security/unlock', 'POST', { password: 'after-reset-pass-1', recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH' })).status, 401);
  lockedUser(u.id);
  assert.equal((await u.req('/api/security/unlock', 'POST', { password: 'after-reset-pass-1', recoveryKey: recovery.toLowerCase() })).status, 200);
  assert.equal((await tr(u, 'conversations.list')).json[0].title, 'Survives a reset');
  assert.equal(raw('SELECT state FROM user_keys WHERE user_id = ?', u.id).state, 'ok');
  vault.forgetUserKey(u.id);
  await u.login('after-reset-pass-1'); // re-wrapped with the new password
  assert.ok(vault.userKey(u.id));
});

test('start fresh: data is deleted, a new key set starts, confirmation is required', async () => {
  const u = await mk('fresh@x.test', 'worker');
  await u.login(); await u.status();
  const { id } = (await tr(u, 'conversations.create', { title: 'Gone soon' }, true)).json;
  db.prepare("INSERT INTO user_credentials (user_id, provider, enc, created_at) VALUES (?, 'anthropic', ?, 'now')").run(u.id, vault.sealForUser(u.id, '{"type":"api_key","key":"k"}', `cred:${u.id}:anthropic`));
  const oldWrap = raw('SELECT rec_wrapped FROM user_keys WHERE user_id = ?', u.id).rec_wrapped;
  forgetOk = false; // the agent cannot be reached: nothing may be deleted
  assert.equal((await u.req('/api/security/reset-data', 'POST', { password: PW, confirm: 'DELETE MY DATA' })).status, 502);
  assert.equal(raw('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?', u.id).n, 1);
  forgetOk = true;
  assert.equal((await u.req('/api/security/reset-data', 'POST', { password: PW, confirm: 'yes' })).status, 400);
  assert.equal((await u.req('/api/security/reset-data', 'POST', { password: 'nope-nope-nope', confirm: 'DELETE MY DATA' })).status, 401);
  const r = await u.req('/api/security/reset-data', 'POST', { password: PW, confirm: 'DELETE MY DATA' });
  assert.equal(r.status, 200);
  assert.match(((await r.json()) as any).recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  for (const t of ['conversations', 'user_credentials']) assert.equal(raw(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'conversations' ? 'id' : 'user_id'} LIKE ?`, t === 'user_credentials' ? u.id : `%${u.id}%`).n, 0, t);
  assert.notEqual(raw('SELECT rec_wrapped FROM user_keys WHERE user_id = ?', u.id).rec_wrapped, oldWrap);
  assert.equal((await tr(u, 'conversations.create', { title: 'New start' }, true)).status, 200); // unlocked with the new key
});

test('admins cannot read another user\'s titles', async () => {
  const w = await mk('victim@x.test', 'worker');
  await w.login(); await w.status();
  await tr(w, 'conversations.create', { title: 'Secret plans' }, true);
  // the admin's conversation list has none of the worker's titles
  assert.ok(!JSON.stringify((await tr(admin, 'conversations.list')).json).includes('Secret plans'));
});

test('team key: locked after restart (423 team), unlocked by an admin sign-in; second admin gets a wrap; demotion removes it; recovery key', async () => {
  const c = ch.createChannel({ name: 'locked-check', secret: 'tok2', config: { host: 'smtp.example.com', port: 587, from: 'a@b.de' } });
  providers.connect({ id: 'openai' }, 'sk-team-key');
  const enc = raw("SELECT enc_key FROM providers WHERE id = 'openai'").enc_key as string;
  assert.ok(vault.isSealed(enc) && !enc.includes('sk-team'));
  vault.setTeamKey(undefined); // process restart
  assert.throws(() => prov('openai'), (e: any) => e instanceof vault.LockedError && e.scope === 'team');
  await assert.rejects(ch.testChannel(c.id, 'a@b.de'), (e: any) => e instanceof vault.LockedError && e.scope === 'team'); // the mail secret is sealed with the team key
  await admin.login(); // wrap exists: opens the team key
  assert.equal(prov('openai'), 'sk-team-key');
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps').n, 1);

  const a2 = await mk('admin2@x.test', 'admin');
  await a2.login();
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps').n, 1); // a role row alone gets no wrap
  assert.equal((await a2.req('/api/security/team-grant', 'POST', { userId: a2.id })).status, 409); // not for yourself
  assert.deepEqual(((await (await admin.req('/api/security/team-pending')).json()) as any).pending.map((p: any) => p.id), [a2.id]);
  assert.equal((await admin.req('/api/security/team-grant', 'POST', { userId: a2.id })).status, 200); // a2 is unlocked: the wrap is added now
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps').n, 2);
  assert.equal(raw('SELECT COUNT(*) AS n FROM instance_settings WHERE key = ?', 'team_key_recovery').n, 1); // still one team key

  // restart; a third admin without a wrap cannot open it, the second admin can
  const a3 = await mk('admin3@x.test', 'admin');
  vault.setTeamKey(undefined);
  await a3.login();
  assert.equal(vault.getTeamKey(), undefined);
  assert.equal((await a3.req('/api/security/team-unlock', 'POST', { recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH' })).status, 401);
  await a2.login();
  assert.ok(vault.getTeamKey());

  // demotion deletes the wrap
  assert.equal((await tr(admin, 'users.setRole', { id: a2.id, roleId: 'worker' }, true)).status, 200);
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps WHERE user_id = ?', a2.id).n, 0);

  // the instance recovery key shown at creation opens the team key for an admin whose wrap does not work (a3 is signed in and unlocked)
  vault.setTeamKey(undefined);
  assert.equal((await a3.req('/api/security/team-unlock', 'POST', { recoveryKey: teamRecovery.toLowerCase() })).status, 200);
  assert.ok(vault.getTeamKey());
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps WHERE user_id = ?', a3.id).n, 1);
  assert.equal(prov('openai'), 'sk-team-key');
});

test('legacy plaintext and server-key values of a user are sealed at their first unlock (idempotent)', async () => {
  const u = await mk('legacy@x.test', 'worker', (id) => {
    const conv = `u_${id}_01abc`;
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, 'Old plaintext title', 'now')").run(conv, id);
    db.prepare("INSERT INTO outbox (id, user_id, conversation_id, channel_id, recipient, subject, body, status, created_at) VALUES ('o-old', ?, ?, 'c', 'old@x.de', 'Old subject', 'Old body', 'pending', 'now')").run(id, conv);
    db.prepare("INSERT INTO user_credentials (user_id, provider, enc, created_at) VALUES (?, 'anthropic', ?, 'now')").run(id, encrypt('{"type":"api_key","key":"old-key"}'));
    db.prepare("INSERT INTO mcp_connectors (id, owner_id, name, visibility, url, transport, auth, created_at) VALUES ('m1', ?, 'n', 'private', 'https://mcp.example.com/', 'sse', 'oauth', 'now')").run(id);
    db.prepare("INSERT INTO mcp_tokens (connector_id, user_id, enc) VALUES ('m1', ?, ?)").run(id, encrypt('{"access_token":"old-token"}'));
  });
  await u.login();
  const conv = raw('SELECT id, title FROM conversations WHERE user_id = ?', u.id);
  assert.ok(vault.isSealed(conv.title) && !conv.title.includes('Old'));
  const o = raw("SELECT recipient, subject, body FROM outbox WHERE id = 'o-old'");
  assert.ok([o.recipient, o.subject, o.body].every(vault.isSealed));
  assert.ok(vault.isSealed(raw('SELECT enc FROM user_credentials WHERE user_id = ?', u.id).enc));
  assert.equal(vault.openForUser(u.id, raw('SELECT enc FROM user_credentials WHERE user_id = ?', u.id).enc, `cred:${u.id}:anthropic:`), '{"type":"api_key","key":"old-key"}');
  assert.equal(vault.openForUser(u.id, raw('SELECT enc FROM mcp_tokens WHERE user_id = ?', u.id).enc, `mcptok:m1:${u.id}:https://mcp.example.com/`), '{"access_token":"old-token"}');
  assert.equal((await tr(u, 'conversations.list')).json[0].title, 'Old plaintext title');
  const before = raw('SELECT title FROM conversations WHERE id = ?', conv.id).title;
  vault.forgetUserKey(u.id); await u.login();
  assert.equal(raw('SELECT title FROM conversations WHERE id = ?', conv.id).title, before); // second unlock changes nothing
});

test('sign-out tells the agent to forget the key (internal token)', async () => {
  const u = await mk('forget@x.test', 'worker');
  await u.login();
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response('{}'); }) as typeof fetch;
  try { await auth.api.signOut({ headers: { cookie: u.cookie } }); } finally { globalThis.fetch = real; }
  const c = calls.find((x) => x.url.endsWith('/internal/forget'));
  assert.ok(c && c.init.method === 'POST' && c.init.headers['x-hefyn-internal'] && JSON.parse(c.init.body).userId === u.id);
  lockedUser(u.id);
});

test('two concurrent first-admin unlocks create exactly one team key; all secrets open afterwards', async () => {
  // a fresh instance: no team key, no wraps
  db.prepare('DELETE FROM team_key_wraps').run(); db.prepare("DELETE FROM instance_settings WHERE key IN ('team_key_recovery', 'team_strict')").run();
  vault.setTeamKey(undefined);
  db.prepare("INSERT OR REPLACE INTO providers (id, name, enc_key, created_at) VALUES ('race', 'Race', ?, 'now')").run(encrypt('sk-race'));
  const a = await mk('race-a@x.test', 'admin'), b = await mk('race-b@x.test', 'admin');
  await Promise.all([a.login(), b.login()]);
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps').n, 1);
  assert.equal(raw("SELECT COUNT(*) AS n FROM instance_settings WHERE key = 'team_key_recovery'").n, 1);
  assert.equal(prov('race'), 'sk-race');
  const wrapOwner = raw('SELECT user_id FROM team_key_wraps').user_id;
  vault.setTeamKey(undefined); // restart: the wrap holder opens the same key again
  await (wrapOwner === a.id ? a : b).login();
  assert.equal(prov('race'), 'sk-race');
});

test('a forged admin role row gets no team wrap until an admin confirms it', async () => {
  const f = await mk('forged@x.test', 'worker');
  db.prepare("UPDATE user_roles SET role_id = 'admin' WHERE user_id = ?").run(f.id); // attacker edits the database
  await f.login();
  assert.equal(raw('SELECT COUNT(*) AS n FROM team_key_wraps WHERE user_id = ?', f.id).n, 0);
  const wrapped = raw("SELECT enc_key FROM providers WHERE id = 'race'").enc_key;
  assert.ok(vault.isSealed(wrapped));
});

test('an admin-chosen password never wraps a key; the user must choose their own first', async () => {
  const adm = (await auth.api.signInEmail({ body: { email: 'race-a@x.test', password: PW }, returnHeaders: true }));
  const cookie = cookieOf(adm.headers);
  const mkr = await tr({ cookie }, 'users.create', { name: 'T', email: 'temp@x.test', password: 'temp-password-1' }, true);
  assert.equal(mkr.status, 200);
  const id = mkr.json.id as string;
  const s = await auth.api.signInEmail({ body: { email: 'temp@x.test', password: 'temp-password-1' }, returnHeaders: true });
  const c = cookieOf(s.headers);
  assert.equal(raw('SELECT COUNT(*) AS n FROM user_keys WHERE user_id = ?', id).n, 0);
  lockedUser(id);
  const r = await tr({ cookie: c }, 'conversations.list');
  assert.equal(r.status, 403);
  assert.equal(r.error, 'password_change_required');
  assert.equal(((await (await app.request('/api/me', { headers: { cookie: c } })).json()) as any).passwordChangeRequired, true);
  assert.equal((await app.request('/api/security/unlock', { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'temp-password-1' }) })).status, 403);
  await auth.api.changePassword({ body: { currentPassword: 'temp-password-1', newPassword: 'my-own-password-1' }, headers: { cookie: c } });
  assert.equal(raw('SELECT COUNT(*) AS n FROM user_keys WHERE user_id = ?', id).n, 1);
  assert.ok(vault.userKey(id));
  const row = raw('SELECT * FROM user_keys WHERE user_id = ?', id);
  await assert.rejects(async () => vault.unwrap(await vault.kdf('temp-password-1', Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, `user:${id}:pw`));
  assert.equal((await tr({ cookie: c }, 'conversations.list')).status, 200);
});

test('a wrong unwrap does not destroy the password wrap; the right password restores state ok', async () => {
  const u = await mk('keepwrap@x.test', 'worker');
  await u.login(); await u.status();
  const before = raw('SELECT pw_wrapped FROM user_keys WHERE user_id = ?', u.id).pw_wrapped;
  const { needRecovery, deriveKey } = await import('../src/server/keys.ts');
  needRecovery(u.id);
  assert.equal(raw('SELECT pw_wrapped FROM user_keys WHERE user_id = ?', u.id).pw_wrapped, before);
  assert.equal(await deriveKey(u.id, 'wrong-wrong-wrong'), undefined);
  assert.ok(await deriveKey(u.id, PW));
  assert.equal(raw('SELECT state FROM user_keys WHERE user_id = ?', u.id).state, 'ok');
});

test('strict mode: an unsealed (downgraded) value is refused after migration; routing fields are bound into the AAD', async () => {
  const u = await mk('strict@x.test', 'worker');
  await u.login(); await u.status();
  assert.equal(raw('SELECT strict FROM user_keys WHERE user_id = ?', u.id).strict, 1);
  const { id } = (await tr(u, 'conversations.create', { title: 'Strict one' }, true)).json;
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('plain downgrade', id);
  assert.equal((await tr(u, 'conversations.list')).status, 500);
  // base_url is bound: editing it makes the credential unreadable
  const conns = await import('../src/server/connectors.ts');
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(u.id);
  db.prepare("INSERT OR IGNORE INTO providers (id, name, enc_key, created_at) VALUES ('openai', 'x', 'x', 'now')").run();
  conns.connectApiKey(u.id, { id: 'openai', baseUrl: 'https://llm.example.com/v1' }, 'sk-bound');
  assert.equal(await new conns.DbCredentialStore(u.id).read('openai').then((c: any) => c.key), 'sk-bound');
  db.prepare("UPDATE user_credentials SET base_url = 'https://evil.example.com/v1' WHERE user_id = ?").run(u.id);
  await assert.rejects(new conns.DbCredentialStore(u.id).read('openai'));
});

test('SMTP hosts must be public', async () => {
  assert.throws(() => ch.createChannel({ name: 'bad-smtp', secret: 'x', config: { host: '127.0.0.1', port: 25, from: 'a@b.de' } }), /private or internal/);
});

test('team routing fields are bound: editing providers.base_url or channels.config in the database makes the secret unreadable', async () => {
  const dbl = await import('../src/server/vault.ts');
  providers.connect({ id: 'anthropic', baseUrl: 'https://llm.example.com' }, 'sk-routed');
  const p = () => raw("SELECT id, base_url, enc_key FROM providers WHERE id = 'anthropic'");
  assert.equal(seal.openProviderSecret(p()), 'sk-routed');
  db.prepare("UPDATE providers SET base_url = 'https://evil.example.com' WHERE id = 'anthropic'").run();
  assert.throws(() => seal.openProviderSecret(p()));
  db.prepare("UPDATE providers SET base_url = 'https://llm.example.com' WHERE id = 'anthropic'").run();
  assert.equal(seal.openProviderSecret(p()), 'sk-routed');
  // a value sealed before the endpoint was bound opens only while the team is not strict
  db.prepare("DELETE FROM instance_settings WHERE key = 'team_strict'").run();
  db.prepare("UPDATE providers SET enc_key = ? WHERE id = 'anthropic'").run(dbl.sealForTeam('sk-old', 'provider:anthropic'));
  assert.equal(seal.openProviderSecret(p()), 'sk-old');
  db.prepare("INSERT OR REPLACE INTO instance_settings (key, value) VALUES ('team_strict', '1')").run();
  assert.throws(() => seal.openProviderSecret(p()));

  const c = ch.createChannel({ name: 'routed-mail', secret: 'smtp-pass', config: { host: 'smtp.example.com', port: 587, from: 'a@b.de', username: 'bot' } });
  let seen = '';
  ch.setTransport(async (x) => { seen = x.secret; });
  ch.updateChannel(c.id, { system: true });
  await ch.sendSystemMail({ to: 'a@b.de', subject: 's', text: 't' });
  assert.equal(seen, 'smtp-pass');
  ch.updateChannel(c.id, { config: { host: 'smtp2.example.com', port: 587, from: 'a@b.de', username: 'bot' } }); // an admin edit re-seals
  await ch.sendSystemMail({ to: 'a@b.de', subject: 's', text: 't' });
  assert.equal(seen, 'smtp-pass');
  db.prepare("UPDATE channels SET config = ? WHERE id = ?").run(JSON.stringify({ host: 'evil.example.com', port: 587, secure: false, username: 'bot', from: 'a@b.de', fromName: '' }), c.id);
  await assert.rejects(ch.sendSystemMail({ to: 'a@b.de', subject: 's', text: 't' }));
});
