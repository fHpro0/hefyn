import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-devices-'));
process.env.HEFYN_SECRET = 'devices-test-secret-devices-test-secret-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { createKernel, modulePlugin } = await import('../src/kernel/index.ts');
const { builtin } = await import('../src/modules/builtin.ts');
const k = createKernel();
for (const m of builtin) k.plugin(modulePlugin(m));
const app = new Hono().route('/api', api);

const PW = 'password-12345';
async function mk(email: string, role = 'worker') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
}
let n = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pair = (body: unknown, ip = `10.0.0.${++n}`) => app.request('/api/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress: ip } } });
const self = (secret: string, method = 'GET') => app.request('/api/devices/self', { method, headers: { authorization: `Bearer ${secret}` } });

test('devices: pair, approve, use, revoke', async () => {
  const me = await mk('a@x.test');
  const r = await pair({ name: ' Laptop\u0007 ', code: 'abcd-efgh', secretHash: sha('s1') });
  assert.equal(r.status, 201);
  assert.ok((await r.json() as any).expiresAt);
  assert.equal((await self('s1')).status, 202);
  assert.equal((await me('devices.lookup', { code: 'ABCD EFGH' })).json.name, 'Laptop');
  assert.equal((await self('s1')).status, 202); // looking is not binding
  const ok = await me('devices.approve', { code: 'ABCD-EFGH' }, true);
  assert.equal(ok.json.name, 'Laptop');
  const s = await self('s1');
  assert.equal(s.status, 200);
  assert.deepEqual((await s.json() as any).user, { email: 'a@x.test', name: 'a@x.test' });
  const list = (await me('devices.list')).json;
  assert.equal(list.length, 1);
  assert.ok(list[0].lastSeenAt);
  assert.equal((await me('devices.approve', { code: 'ABCD-EFGH' }, true)).code, 'NOT_FOUND'); // single use
  assert.equal((await me('devices.revoke', { id: list[0].id }, true)).status, 200);
  assert.equal((await self('s1')).status, 401);
  assert.equal((await self('nope')).status, 401);
  assert.deepEqual((await me('devices.list')).json, []);
});

test('devices: bad input, collisions, expiry, unpair', async () => {
  const me = await mk('b@x.test');
  for (const bad of [null, {}, { name: '', code: 'ABCDEFGH', secretHash: sha('x') }, { name: 'x'.repeat(65), code: 'ABCDEFGH', secretHash: sha('x') }, { name: 'x', code: 'ABCDEFG0', secretHash: sha('x') }, { name: 'x', code: 'ABCDEFGH', secretHash: 'abc' }])
    assert.equal((await pair(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await pair({ name: 'one', code: 'JJJJ2222', secretHash: sha('c1') })).status, 201);
  assert.equal((await pair({ name: 'two', code: 'JJJJ2222', secretHash: sha('c2') })).status, 409);
  assert.equal((await pair({ name: 'two', code: 'KKKK2222', secretHash: sha('c1') })).status, 409);
  assert.equal((await pair({ name: 'old', code: 'MMMM3333', secretHash: sha('c3') })).status, 201);
  db.prepare("UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = 'MMMM3333'").run();
  assert.equal((await me('devices.lookup', { code: 'MMMM3333' })).code, 'NOT_FOUND');
  assert.equal((await me('devices.approve', { code: 'MMMM3333' }, true)).code, 'NOT_FOUND');
  assert.equal((await self('c3')).status, 410);
  assert.equal((await self('c3')).status, 401); // the expired row is gone
  assert.equal((await me('devices.approve', { code: 'JJJJ2222' }, true)).status, 200);
  assert.equal((await self('c1', 'DELETE')).status, 204);
  assert.equal((await self('c1')).status, 401);
});

test('devices: another user cannot revoke; a role without the permission cannot connect', async () => {
  const a = await mk('c@x.test'), b = await mk('d@x.test');
  db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('plain', 'Plain', 0, '[\"models.use\"]')").run();
  const plain = await mk('e@x.test', 'plain');
  await pair({ name: 'mine', code: 'NNNN4444', secretHash: sha('d1') });
  await a('devices.approve', { code: 'NNNN4444' }, true);
  const id = (await a('devices.list')).json[0].id;
  assert.equal((await b('devices.revoke', { id }, true)).code, 'NOT_FOUND');
  assert.equal((await self('d1')).status, 200);
  await pair({ name: 'x', code: 'PPPP5555', secretHash: sha('d2') });
  assert.equal((await plain('devices.approve', { code: 'PPPP5555' }, true)).code, 'FORBIDDEN');
  assert.equal((await plain('devices.lookup', { code: 'PPPP5555' })).code, 'FORBIDDEN');
});

test('devices: pairing is throttled per IP, code tries per user', async () => {
  const me = await mk('f@x.test');
  for (let i = 0; i < 10; i++) await pair({ name: 'x', code: 'QQQQ6666', secretHash: sha('t' + i) }, '9.9.9.9');
  assert.equal((await pair({ name: 'x', code: 'QQQQ7777', secretHash: sha('t-last') }, '9.9.9.9')).status, 429);
  assert.equal((await pair({ name: 'x', code: 'QQQQ7777', secretHash: sha('t-last') }, '9.9.9.8')).status, 201);
  let last = '';
  for (let i = 0; i < 11; i++) last = (await me('devices.lookup', { code: 'ZZZZ9999' })).code!;
  assert.equal(last, 'TOO_MANY_REQUESTS');
});

test('grantAdmin keeps module permissions this process did not register (the agent process)', async () => {
  const { grantAdmin } = await import('../src/server/appdb.ts');
  const { PERMISSIONS } = await import('../src/server/permissions.ts');
  const adminHas = () => (JSON.parse((db.prepare("SELECT permissions FROM roles WHERE id = 'admin'").get() as any).permissions) as string[]).includes('devices.connect');
  assert.ok(adminHas());
  const i = PERMISSIONS.indexOf('devices.connect');
  PERMISSIONS.splice(i, 1);
  try { grantAdmin(); assert.ok(adminHas()); } finally { PERMISSIONS.splice(i, 0, 'devices.connect'); }
});
