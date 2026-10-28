import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-sec-'));
process.env.HEFYN_SECRET = 'sec-test-secret-sec-test-secret-1234';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { setTwoFactorPolicy } = await import('../src/server/security.ts');
const app = new Hono().route('/api', api);

async function user(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const s = await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true });
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: r.user.id, get: (path: string, method = 'GET') => app.request(path, { method, headers: { cookie } }), trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
const admin = await user('admin@x.test', 'admin');
const worker = await user('worker@x.test', 'worker');

test('policy off: normal routes work', async () => {
  setTwoFactorPolicy('off');
  assert.equal((await worker.trpc('conversations.list')).status, 200);
});

test('policy everyone: users without TOTP are blocked except /api/me', async () => {
  setTwoFactorPolicy('everyone');
  const r = await worker.trpc('conversations.list');
  assert.equal(r.status, 403);
  assert.equal(r.error, '2fa_setup_required');
  assert.equal((await admin.trpc('users.list')).status, 403);
  const me = await (await worker.get('/api/me')).json() as any;
  assert.equal(me.twoFactorSetupRequired, true);
  db.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE id = ?').run(worker.id);
  assert.equal((await worker.trpc('conversations.list')).status, 200);
  db.prepare('UPDATE user SET twoFactorEnabled = 0 WHERE id = ?').run(worker.id);
});

test('policy admins: only admins are blocked', async () => {
  setTwoFactorPolicy('admins');
  assert.equal((await worker.trpc('conversations.list')).status, 200);
  assert.equal((await admin.trpc('users.list')).status, 403);
  setTwoFactorPolicy('off');
});

test('admin reset clears TOTP, backup codes and passkeys; not for yourself', async () => {
  db.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE id = ?').run(worker.id);
  db.prepare("INSERT INTO twoFactor (id, secret, backupCodes, userId, verified) VALUES ('t1', 's', 'b', ?, 1)").run(worker.id);
  db.prepare("INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES ('p1', 'k', ?, 'c', 0, 'singleDevice', 0, ?)").run(worker.id, new Date().toISOString());
  assert.equal((await admin.trpc('users.resetTwoFactor', { id: admin.id }, true)).status, 409);
  assert.equal((await worker.trpc('users.resetTwoFactor', { id: admin.id }, true)).status, 403);
  assert.equal((await admin.trpc('users.resetTwoFactor', { id: worker.id }, true)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM twoFactor WHERE userId = ?').get(worker.id)!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?').get(worker.id)!.n, 0);
  assert.equal(db.prepare('SELECT twoFactorEnabled AS t FROM user WHERE id = ?').get(worker.id)!.t, 0);
});

test('forgot-password answers the same for unknown and known emails', async () => {
  const ask = async (email: string) => {
    const r = await auth.handler(new Request('http://localhost:3000/api/auth/request-password-reset', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ email }) }));
    return [r.status, await r.json()];
  };
  assert.deepEqual(await ask('nobody@x.test'), await ask('worker@x.test'));
});
