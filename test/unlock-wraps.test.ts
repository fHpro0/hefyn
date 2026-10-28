import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-unlock-'));
process.env.HEFYN_SECRET = 'unlock-test-secret-unlock-test-secret-12';
process.env.HEFYN_KEY_MODE = 'user'; // the zero-access mode (the server default is server-held keys since 2026-10-27)

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const keys = await import('../src/server/keys.ts');
const wraps = await import('../src/server/unlock-wraps.ts');
const vault = await import('../src/server/vault.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch; // the agent's /internal/forget
const rows = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM unlock_wraps WHERE user_id = ?').get(id) as { n: number }).n;

async function mk(email: string, role = 'worker') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const u: any = {
    id: r.user.id, email, cookie: '',
    async login(password = PW) {
      const s = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
      u.cookie = cookieOf(s.headers);
      return s;
    },
    req: (path: string, method = 'GET', body?: unknown, cookie = u.cookie) =>
      app.request(path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }),
    unlocked: async (cookie = u.cookie) => ((await (await u.req('/api/security/key-status?peek=1', 'GET', undefined, cookie)).json()) as any).unlocked as boolean,
  };
  return u;
}
const without = (cookie: string) => cookie.split('; ').filter((c: string) => !c.startsWith('hefyn_unlock=')).join('; ');
let pk = 0;
const addPasskey = (userId: string, credId: string) => db.prepare('INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(`pk-${++pk}`, 'x', 'AA', userId, credId, 0, 'singleDevice', 0, new Date().toISOString());
const restart = (id: string) => vault.forgetUserKey(id); // memory is all a restart loses

test('sign-in sets the hefyn_unlock cookie (HttpOnly, Strict) and a restart restores the same key from it', async () => {
  const u = await mk('a@x.test', 'admin');
  const s = await u.login();
  const set = s.headers.getSetCookie().find((c: string) => c.startsWith('hefyn_unlock='))!;
  assert.match(set, /HttpOnly/i); assert.match(set, /SameSite=Strict/i); assert.match(set, /Path=\//); assert.doesNotMatch(set, /Secure/);
  assert.equal(rows(u.id), 1);
  const before = Buffer.from(vault.userKey(u.id)!);
  restart(u.id);
  assert.equal(vault.userKey(u.id), undefined);
  assert.equal(await u.unlocked(), true);
  assert.deepEqual(vault.userKey(u.id), before);
});

test('a missing or wrong cookie stays locked; a wrong one also drops the row and clears the cookie', async () => {
  const u = await mk('b@x.test');
  await u.login();
  restart(u.id);
  assert.equal(await u.unlocked(without(u.cookie)), false);
  assert.equal(rows(u.id), 1);
  const wrong = `${without(u.cookie)}; hefyn_unlock=${randomBytes(32).toString('base64url')}`;
  const r = await u.req('/api/security/key-status', 'GET', undefined, wrong);
  assert.equal(((await r.json()) as any).unlocked, false);
  assert.match(r.headers.getSetCookie().join('|'), /hefyn_unlock=;/);
  assert.equal(rows(u.id), 0);
  assert.equal(await u.unlocked(), false); // the right cookie no longer helps
});

test('an expired row is refused', async () => {
  const u = await mk('c@x.test');
  await u.login();
  db.prepare('UPDATE unlock_wraps SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), u.id);
  restart(u.id);
  assert.equal(await u.unlocked(), false);
  assert.equal(rows(u.id), 0);
});

test('sign-out deletes all of the user\'s rows', async () => {
  const u = await mk('d@x.test');
  await u.login();
  const other = u.cookie;
  await u.login();
  assert.equal(rows(u.id), 2);
  await auth.api.signOut({ headers: new Headers({ cookie: u.cookie }) });
  assert.equal(rows(u.id), 0);
  restart(u.id);
  assert.equal(await u.unlocked(other), false);
});

test('password change and start fresh replace the rows (old cookie is useless)', async () => {
  const u = await mk('e@x.test');
  await u.login();
  const oldHash = (db.prepare('SELECT session_hash h FROM unlock_wraps WHERE user_id = ?').get(u.id) as any).h;
  await auth.api.changePassword({ body: { currentPassword: PW, newPassword: 'brand-new-pass-1', revokeOtherSessions: true }, headers: { cookie: u.cookie } });
  assert.equal(db.prepare('SELECT 1 FROM unlock_wraps WHERE session_hash = ?').get(oldHash), undefined);

  await u.login('brand-new-pass-1');
  addPasskey(u.id, 'cred-1');
  wraps.savePasskeyWrap(u.id, 'cred-1', randomBytes(32), vault.userKey(u.id)!);
  const h = (db.prepare('SELECT session_hash h FROM unlock_wraps WHERE user_id = ?').get(u.id) as any).h;
  const r = await u.req('/api/security/reset-data', 'POST', { password: 'brand-new-pass-1', confirm: 'DELETE MY DATA' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM unlock_wraps WHERE session_hash = ?').get(h), undefined);
  assert.deepEqual(wraps.passkeyWrapIds(u.id), []);
  assert.equal(rows(u.id), 1); // the new key set, wrapped for this session
});

test('password reset (needs_recovery) drops the restart and passkey wraps', async () => {
  const u = await mk('f@x.test');
  await u.login();
  addPasskey(u.id, 'cred-2');
  wraps.savePasskeyWrap(u.id, 'cred-2', randomBytes(32), vault.userKey(u.id)!);
  await keys.onPasswordReset({ user: { id: u.id } });
  assert.equal(rows(u.id), 0);
  assert.deepEqual(wraps.passkeyWrapIds(u.id), []);
});

test('2FA pending state creates no wrap; the verified code does', async () => {
  const u = await mk('g@x.test');
  await u.login();
  const en = await auth.api.enableTwoFactor({ body: { password: PW }, headers: { cookie: u.cookie } }) as any;
  const secret = new TextDecoder().decode(base32.decode(new URL(en.totpURI).searchParams.get('secret')!));
  const code = () => createOTP(secret, { digits: 6, period: 30 }).totp();
  await auth.api.verifyTOTP({ body: { code: await code() }, headers: { cookie: u.cookie } });
  dropAll(u.id);
  const s = await auth.api.signInEmail({ body: { email: u.email, password: PW }, returnHeaders: true });
  assert.equal((s.response as any).twoFactorRedirect, true);
  assert.equal(rows(u.id), 0);
  const v = await auth.api.verifyTOTP({ body: { code: await code() }, headers: { cookie: cookieOf(s.headers) }, returnHeaders: true });
  assert.equal(rows(u.id), 1);
  assert.ok(v.headers.getSetCookie().some((c) => c.startsWith('hefyn_unlock=')));
});
function dropAll(id: string) { wraps.dropUnlockWraps(id); vault.forgetUserKey(id); }

test('PRF wrap: right bytes open, wrong bytes / wrong credential / another user fail, passkey deletion removes it', async () => {
  const u = await mk('h@x.test');
  await u.login();
  const dek = Buffer.from(vault.userKey(u.id)!), prf = randomBytes(32);
  addPasskey(u.id, 'cred-A'); addPasskey(u.id, 'cred-B');
  wraps.savePasskeyWrap(u.id, 'cred-A', prf, dek);
  assert.deepEqual(wraps.openPasskeyWrap(u.id, 'cred-A', prf), dek);
  assert.equal(wraps.openPasskeyWrap(u.id, 'cred-A', randomBytes(32)), undefined);
  assert.equal(wraps.openPasskeyWrap(u.id, 'cred-B', prf), undefined);
  assert.equal(wraps.openPasskeyWrap('someone-else', 'cred-A', prf), undefined);
  // The same wrap moved to another credential id does not open either (HKDF info + AAD bind it).
  db.prepare('INSERT INTO passkey_key_wraps (credential_id, user_id, wrap, created_at) SELECT ?, user_id, wrap, created_at FROM passkey_key_wraps WHERE credential_id = ?').run('cred-B', 'cred-A');
  assert.equal(wraps.openPasskeyWrap(u.id, 'cred-B', prf), undefined);
  wraps.dropPasskeyWrap(u.id, 'cred-B');

  // unlock path: locked -> passkey unlock -> unlocked
  restart(u.id);
  assert.deepEqual(await keys.unlockWithPasskey(u.id, 'cred-A', prf), dek);
  assert.deepEqual(vault.userKey(u.id), dek);
  restart(u.id);
  assert.equal(await keys.unlockWithPasskey(u.id, 'cred-A', randomBytes(32)), undefined);
  lockedAfter(u.id);

  // deleting the passkey (Better Auth endpoint) removes its wrap
  const pkId = (db.prepare("SELECT id FROM passkey WHERE userId = ? AND credentialID = 'cred-A'").get(u.id) as any).id;
  await auth.api.deletePasskey({ body: { id: pkId }, headers: { cookie: u.cookie } });
  assert.equal(wraps.openPasskeyWrap(u.id, 'cred-A', prf), undefined);
  assert.deepEqual(wraps.passkeyWrapIds(u.id), []);
});
function lockedAfter(id: string) { assert.equal(vault.userKey(id), undefined); }

test('raw deletion of the passkey row (admin 2FA reset) leaves no usable wrap; resetTwoFactor drops them', async () => {
  const { resetTwoFactor } = await import('../src/server/security.ts');
  const u = await mk('i@x.test');
  await u.login();
  const dek = Buffer.from(vault.userKey(u.id)!), prf = randomBytes(32);
  addPasskey(u.id, 'cred-R');
  wraps.savePasskeyWrap(u.id, 'cred-R', prf, dek);
  db.prepare("DELETE FROM passkey WHERE credentialID = 'cred-R'").run(); // a path that bypasses the hook
  assert.equal(wraps.openPasskeyWrap(u.id, 'cred-R', prf), undefined);
  resetTwoFactor(u.id); // and the reset itself removes the leftover wrap row
  assert.equal(db.prepare('SELECT 1 FROM passkey_key_wraps WHERE user_id = ?').get(u.id), undefined);
});

test('two users with the same credential id do not affect each other', async () => {
  const a = await mk('j1@x.test'), b = await mk('j2@x.test');
  await a.login(); await b.login();
  const pa = randomBytes(32), pb = randomBytes(32);
  addPasskey(a.id, 'shared'); addPasskey(b.id, 'shared');
  wraps.savePasskeyWrap(a.id, 'shared', pa, vault.userKey(a.id)!);
  wraps.savePasskeyWrap(b.id, 'shared', pb, vault.userKey(b.id)!);
  assert.deepEqual(wraps.openPasskeyWrap(a.id, 'shared', pa), vault.userKey(a.id));
  assert.deepEqual(wraps.openPasskeyWrap(b.id, 'shared', pb), vault.userKey(b.id));
  assert.equal(wraps.openPasskeyWrap(a.id, 'shared', pb), undefined);
  wraps.dropPasskeyWrap(a.id, 'shared');
  assert.equal(wraps.openPasskeyWrap(a.id, 'shared', pa), undefined);
  assert.deepEqual(wraps.openPasskeyWrap(b.id, 'shared', pb), vault.userKey(b.id)); // b untouched
});

test('2FA enable / disable rotate the session: the new session gets a restart wrap', async () => {
  const u = await mk('k@x.test');
  await u.login();
  const en = await auth.api.enableTwoFactor({ body: { password: PW }, headers: { cookie: u.cookie }, returnHeaders: true }) as any;
  const secret = new TextDecoder().decode(base32.decode(new URL(en.response.totpURI).searchParams.get('secret')!));
  const v = await auth.api.verifyTOTP({ body: { code: await createOTP(secret, { digits: 6, period: 30 }).totp() }, headers: { cookie: u.cookie }, returnHeaders: true });
  const merged = new Map(u.cookie.split('; ').map((c: string) => c.split('=') as [string, string]));
  for (const c of v.headers.getSetCookie()) { const [k, val] = c.split(';')[0].split('='); merged.set(k, val); }
  const cookie = [...merged].map(([k, val]) => `${k}=${val}`).join('; ');
  restart(u.id);
  assert.equal(await u.unlocked(cookie), true);
});
