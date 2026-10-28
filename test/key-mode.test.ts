import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-keymode-'));
process.env.HEFYN_SECRET = 'key-mode-test-secret-key-mode-test-secret-1';
process.env.HEFYN_KEY_MODE = 'server';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const keys = await import('../src/server/keys.ts');
const vault = await import('../src/server/vault.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch; // the agent's /internal/forget
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');

async function mk(email: string, role = 'worker') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const u: any = {
    id: r.user.id, email, cookie: '',
    async login(password = PW) { u.cookie = cookieOf((await auth.api.signInEmail({ body: { email, password }, returnHeaders: true })).headers); },
    status: async (peek = false) => (await app.request(`/api/security/key-status${peek ? '?peek=1' : ''}`, { headers: { cookie: u.cookie } })).json() as Promise<any>,
  };
  return u;
}
// A restart loses exactly the in-memory keys; startKeyMode is what the web process runs at boot.
const restart = async () => { for (const { id } of db.prepare('SELECT id FROM user').all() as { id: string }[]) vault.forgetUserKey(id); vault.setTeamKey(undefined); await keys.startKeyMode(); };
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

test('server mode: user and team keys survive a restart without a sign-in, and no recovery key is shown', async () => {
  const admin = await mk('admin@x.test', 'admin');
  await admin.login();
  const st = await admin.status();
  assert.equal(st.recoveryKeyToShow, undefined); assert.equal(st.teamRecoveryKeyToShow, undefined);
  assert.equal(st.hasRecoveryKey, false); assert.equal(st.keyMode, 'server');
  assert.equal(db.prepare("SELECT 1 FROM instance_settings WHERE key = 'team_key_recovery'").get(), undefined);
  const dek = Buffer.from(vault.userKey(admin.id)!), team = Buffer.from(vault.getTeamKey()!);
  await restart();
  assert.deepEqual(vault.userKey(admin.id), dek);
  assert.deepEqual(vault.getTeamKey(), team);
  const after = await admin.status(true);
  assert.equal(after.unlocked, true); assert.equal(after.teamUnlocked, true);
});

test('server mode: an expired in-memory key is restored from the server wrap on the next request', async () => {
  const u = await mk('expire@x.test');
  await u.login();
  const dek = Buffer.from(vault.userKey(u.id)!);
  vault.forgetUserKey(u.id);
  db.prepare('DELETE FROM unlock_wraps WHERE user_id = ?').run(u.id); // the cookie wrap must not be what restores it
  assert.equal((await u.status(true)).unlocked, true);
  assert.deepEqual(vault.userKey(u.id), dek);
});

test('server mode: start fresh replaces the server wrap, so the old key cannot come back', async () => {
  const u = await mk('fresh@x.test');
  await u.login();
  const old = Buffer.from(vault.userKey(u.id)!);
  const r = await app.request('/api/security/reset-data', { method: 'POST', headers: { cookie: u.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, confirm: 'DELETE MY DATA' }) });
  assert.equal(r.status, 200);
  const fresh = Buffer.from(vault.userKey(u.id)!);
  assert.notDeepEqual(fresh, old);
  vault.forgetUserKey(u.id);
  db.prepare('DELETE FROM unlock_wraps WHERE user_id = ?').run(u.id);
  assert.equal((await u.status(true)).unlocked, true);
  assert.deepEqual(vault.userKey(u.id), fresh);
  assert.equal(count('user_keys WHERE rec_wrapped = \'\' AND user_id = \'' + u.id + '\''), 1); // no unseen recovery wrap
});

test('server mode: changing the password after a reset re-wraps the key with the new one', async () => {
  const u = await mk('chg@x.test');
  await u.login();
  const dek = Buffer.from(vault.userKey(u.id)!);
  await keys.onPasswordReset({ user: { id: u.id } });
  assert.equal((db.prepare('SELECT state FROM user_keys WHERE user_id = ?').get(u.id) as any).state, 'needs_recovery'); // stale wrap is recorded
  await auth.api.changePassword({ body: { currentPassword: PW, newPassword: 'changed-pass-123' }, headers: { cookie: u.cookie } });
  const row = db.prepare('SELECT pw_salt, pw_wrapped, state FROM user_keys WHERE user_id = ?').get(u.id) as any;
  assert.equal(row.state, 'ok');
  assert.deepEqual(vault.unwrap(await vault.kdf('changed-pass-123', Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, `user:${u.id}:pw`), dek);
});

test('server mode: a reset password loses no data; the next sign-in re-wraps the key', async () => {
  const u = await mk('reset@x.test');
  await u.login();
  const dek = Buffer.from(vault.userKey(u.id)!);
  await keys.onPasswordReset({ user: { id: u.id } });
  db.prepare("UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'").run(await (await import('better-auth/crypto')).hashPassword('another-pass-123'), u.id);
  assert.equal(keys.keyState(u.id).state, 'ok');
  await restart();
  await u.login('another-pass-123');
  assert.deepEqual(vault.userKey(u.id), dek);
  // the pw wrap now opens with the new password (a later switch to user mode works)
  vault.forgetUserKey(u.id);
  const row = db.prepare('SELECT pw_salt, pw_wrapped FROM user_keys WHERE user_id = ?').get(u.id) as any;
  assert.deepEqual(vault.unwrap(await vault.kdf('another-pass-123', Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, `user:${u.id}:pw`), dek);
});

test('server mode: a second admin gets team access at unlock, with no confirmation step', async () => {
  const a2 = await mk('admin2@x.test', 'admin');
  assert.deepEqual(keys.pendingAdmins(), []);
  await a2.login();
  assert.ok(db.prepare('SELECT 1 FROM team_key_wraps WHERE user_id = ?').get(a2.id));
  assert.equal(db.prepare('SELECT 1 FROM team_key_grants WHERE user_id = ?').get(a2.id), undefined);
});

// keys.ts reads HEFYN_KEY_MODE at import and runs its startup there: a fresh query string re-evaluates it as "a start in user mode".
const startUser = (tag: string) => import(`../src/server/keys.ts?${tag}`.replace('', '')) as Promise<typeof keys>;

test('user mode: startup refuses while a user has a stale password wrap, then deletes the server wraps', async () => {
  const stale = await mk('stale@x.test');
  await stale.login();
  await keys.onPasswordReset({ user: { id: stale.id } }); // server mode: wrap kept, state needs_recovery
  assert.ok(count('server_key_wraps') > 0);
  assert.ok(db.prepare("SELECT 1 FROM instance_settings WHERE key = 'team_key_server'").get());
  process.env.HEFYN_KEY_MODE = 'user';
  await assert.rejects(startUser('refuse'), /stale@x\.test/);
  assert.ok(count('server_key_wraps') > 0); // nothing deleted

  db.prepare("UPDATE user_keys SET state = 'ok' WHERE user_id = ?").run(stale.id); // as after their sign-in
  const user = await startUser('user-mode');
  assert.equal(user.SERVER_MODE, false);
  assert.equal(count('server_key_wraps'), 0);
  assert.equal(db.prepare("SELECT 1 FROM instance_settings WHERE key = 'team_key_server'").get(), undefined);
  assert.ok(count('user_keys') > 0 && count('team_key_wraps') > 0); // password wraps and admin team wraps stay

  await keys.finishUnlock(stale.id, vault.userKey(stale.id)!); // server module writes a wrap again
  db.prepare("UPDATE user_keys SET state = 'needs_recovery' WHERE user_id = ?").run(stale.id);
  process.env.HEFYN_KEY_MODE_FORCE = '1';
  await startUser('force');
  assert.equal(count('server_key_wraps'), 0);
});
