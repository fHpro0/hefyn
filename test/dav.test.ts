import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-dav-'));
process.env.HEFYN_SECRET = 'dav-test-secret-dav-test-secret-dav-1';
process.env.HEFYN_MAX_UPLOAD_MB = '1';
process.env.HEFYN_USER_QUOTA_MB = '2';
delete process.env.HEFYN_RUNNER_URL;

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { dav } = await import('../src/server/dav.ts');
const { createKernel, modulePlugin } = await import('../src/kernel/index.ts');
const { builtin } = await import('../src/modules/builtin.ts');
const k = createKernel();
for (const m of builtin) k.plugin(modulePlugin(m));
const app = new Hono().route('/api', api).route('/dav', dav);

const PW = 'password-12345';
async function mk(email: string, role = 'admin') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const trpc = (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
  return { email, cookie, trpc };
}
const basic = (email: string, pw: string) => 'Basic ' + Buffer.from(`${email}:${pw}`).toString('base64');
let n = 0;
const req = (method: string, path: string, auth?: string, extra: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`http://localhost${path}`, { method, ...extra, headers: { ...(auth ? { authorization: auth } : {}), ...extra.headers } }, { incoming: { socket: { remoteAddress: `10.1.0.${++n}` } } });

const a = await mk('a@x.test'), b = await mk('b@x.test');
const rw = (await a.trpc('appPasswords.create', { name: 'MacBook', write: true }, true)).json.password as string;
const ro = (await a.trpc('appPasswords.create', { name: 'Phone', write: false }, true)).json.password as string;
const bPw = (await b.trpc('appPasswords.create', { name: 'B', write: true }, true)).json.password as string;
const A = basic(a.email, rw), AR = basic(a.email, ro);

test('app passwords: shown once, only a hash is stored, revocable', async () => {
  assert.match(rw, /^([a-z2-9]{4}-){7}[a-z2-9]{4}$/);
  const list = (await a.trpc('appPasswords.list')).json;
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes(rw.replace(/-/g, '')) && !('hash' in list[0]) && !('password' in list[0]));
  const row = db.prepare('SELECT * FROM app_passwords WHERE name = ?').get('MacBook') as any;
  assert.ok(!JSON.stringify(row).includes(rw.replace(/-/g, '')));
  assert.equal(row.prefix, rw.replace(/-/g, '').slice(0, 6));
  assert.equal(list.find((p: any) => p.name === 'Phone').write, false);
  const tmp = (await a.trpc('appPasswords.create', { name: 'tmp', write: true }, true)).json.password;
  assert.equal((await req('PROPFIND', '/dav/', basic(a.email, tmp), { headers: { depth: '0' } })).status, 207);
  const id = (await a.trpc('appPasswords.list')).json.find((p: any) => p.name === 'tmp').id;
  assert.equal((await b.trpc('appPasswords.revoke', { id }, true)).code, 'NOT_FOUND'); // not someone else's
  assert.equal((await a.trpc('appPasswords.revoke', { id }, true)).status, 200);
  assert.equal((await req('PROPFIND', '/dav/', basic(a.email, tmp), { headers: { depth: '0' } })).status, 401);
});

test('auth: account password, cookie, wrong user, no https are refused', async () => {
  assert.equal((await req('PROPFIND', '/dav/')).status, 401);
  assert.equal((await req('PROPFIND', '/dav/', basic(a.email, PW))).status, 401); // account password
  assert.equal((await req('PROPFIND', '/dav/', undefined, { headers: { cookie: a.cookie } })).status, 401); // cookie only
  assert.equal((await req('PROPFIND', '/dav/', basic('b@x.test', rw))).status, 401); // A's password for B
  assert.equal((await req('PROPFIND', '/dav/', basic(a.email, rw.toUpperCase()))).status, 207); // case and dashes are cosmetic
  const r = await app.request('http://files.example.com/dav/', { method: 'PROPFIND', headers: { authorization: A } });
  assert.equal(r.status, 403); // plain http off localhost
  const s = await app.request('http://files.example.com/dav/', { method: 'PROPFIND', headers: { authorization: A, 'x-forwarded-proto': 'https' } }, { incoming: { socket: { remoteAddress: '10.9.9.9' } } });
  assert.equal(s.status, 207);
});

test('auth: rate limit after 10 failures per ip+user', async () => {
  const peer = { incoming: { socket: { remoteAddress: '10.7.7.7' } } };
  const go = (pw: string) => app.request('http://localhost/dav/', { method: 'PROPFIND', headers: { authorization: basic(a.email, pw) } }, peer);
  for (let i = 0; i < 10; i++) assert.equal((await go('wrong')).status, 401);
  assert.equal((await go('wrong')).status, 429);
  assert.equal((await go(rw)).status, 429);
  assert.equal((await req('PROPFIND', '/dav/', A)).status, 207); // another ip is unaffected
});

test('PUT / GET / PROPFIND roundtrip with safe headers', async () => {
  assert.equal((await req('MKCOL', '/dav/docs', A)).status, 201);
  assert.equal((await req('MKCOL', '/dav/docs', A)).status, 405);
  assert.equal((await req('PUT', '/dav/docs/a%20b.html', A, { body: '<script>alert(1)</script>' })).status, 201);
  assert.equal((await req('PUT', '/dav/docs/a%20b.html', A, { body: '<b>x</b>' })).status, 204);
  assert.equal((await req('PUT', '/dav/nope/x.txt', A, { body: 'x' })).status, 409);
  const g = await req('GET', '/dav/docs/a%20b.html', A);
  assert.equal(await g.text(), '<b>x</b>');
  assert.equal(g.headers.get('content-type'), 'application/octet-stream');
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(g.headers.get('content-security-policy'), 'sandbox');
  assert.equal(g.headers.get('content-disposition'), 'attachment');
  const part = await req('GET', '/dav/docs/a%20b.html', A, { headers: { range: 'bytes=3-3' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'x');
  const p0 = await (await req('PROPFIND', '/dav/', A, { headers: { depth: '1' } })).text();
  assert.match(p0, /<D:href>\/dav\/docs\/<\/D:href>/);
  const p1 = await req('PROPFIND', '/dav/docs/', A, { headers: { depth: '1' } });
  assert.equal(p1.status, 207);
  const x = await p1.text();
  assert.match(x, /<D:href>\/dav\/docs\/a%20b\.html<\/D:href>/);
  assert.match(x, /<D:getcontentlength>8<\/D:getcontentlength>/);
  assert.equal((await req('PROPFIND', '/dav/', A, { headers: { depth: 'infinity' } })).status, 403);
  assert.equal((await req('PROPFIND', '/dav/missing', A)).status, 404);
  const o = await req('OPTIONS', '/dav/', A);
  assert.equal(o.headers.get('dav'), '1, 2');
  assert.equal((await req('LOCK', '/dav/docs/new.txt', A)).status, 200);
  assert.equal((await req('PROPPATCH', '/dav/docs/', A, { body: '<x/>' })).status, 207);
  // files live in the user's /files
  const { fsFor } = await import('../src/server/runner.ts');
  const id = db.prepare('SELECT id FROM user WHERE email = ?').get(a.email) as { id: string };
  assert.equal(await fsFor(id.id).exists('/files/docs/a b.html'), true);
});

test('MOVE, COPY, DELETE, Destination checks', async () => {
  await req('PUT', '/dav/m.txt', A, { body: 'one' });
  const dest = (p: string) => ({ headers: { destination: p } });
  assert.equal((await req('MOVE', '/dav/m.txt', A, dest('http://localhost/dav/docs/m2.txt'))).status, 201);
  assert.equal((await req('GET', '/dav/m.txt', A)).status, 404);
  assert.equal((await req('COPY', '/dav/docs/m2.txt', A, dest('/dav/m3.txt'))).status, 201);
  assert.equal((await req('COPY', '/dav/docs', A, dest('/dav/docs2'))).status, 201);
  assert.equal(await (await req('GET', '/dav/docs2/m2.txt', A)).text(), 'one');
  assert.equal((await req('COPY', '/dav/m3.txt', A, { headers: { destination: '/dav/docs/m2.txt', overwrite: 'F' } })).status, 412);
  assert.equal((await req('MOVE', '/dav/m3.txt', A, dest('http://evil.example/dav/m3.txt'))).status, 502); // other server
  assert.equal((await req('MOVE', '/dav/m3.txt', A, dest('/api/files'))).status, 400); // outside /dav
  assert.equal((await req('MOVE', '/dav/m3.txt', A, dest('/dav/../../x'))).status, 400); // the URL parser folds `..` to /x, outside /dav
  assert.equal((await req('MOVE', '/dav/docs', A, dest('/dav/docs/in'))).status, 403); // into itself
  assert.equal((await req('GET', '/dav/m3.txt', A)).status, 200);
  assert.equal((await req('DELETE', '/dav/docs2', A)).status, 204);
  assert.equal((await req('DELETE', '/dav/docs2', A)).status, 404);
  assert.equal((await req('DELETE', '/dav/', A)).status, 403);
});

test('read-only password: reads work, writes are 403', async () => {
  assert.equal((await req('GET', '/dav/m3.txt', AR)).status, 200);
  assert.equal((await req('PROPFIND', '/dav/', AR)).status, 207);
  const dest = { headers: { destination: '/dav/z.txt' } };
  for (const [m, p, x] of [['PUT', '/dav/r.txt', { body: 'x' }], ['DELETE', '/dav/m3.txt', {}], ['MOVE', '/dav/m3.txt', dest], ['COPY', '/dav/m3.txt', dest], ['MKCOL', '/dav/d', {}], ['LOCK', '/dav/m3.txt', {}]] as const)
    assert.equal((await req(m, p, AR, x)).status, 403, m);
  assert.equal((await req('GET', '/dav/m3.txt', A)).status, 200);
});

test('traversal and other users', async () => {
  for (const p of ['/dav/..%2f..%2fetc/passwd', '/dav/%2e%2e/x', '/dav/docs/%2e%2e/%2e%2e/x', '/dav/a%5cb', '/dav/a%00b'])
    assert.ok([400, 403, 404].includes((await req('GET', p, A)).status), p);
  assert.equal((await req('GET', '/dav/docs/../../x', A)).status === 200, false);
  const B = basic(b.email, bPw);
  assert.equal((await req('GET', '/dav/m3.txt', B)).status, 404); // B's /files is empty
  const x = await (await req('PROPFIND', '/dav/', B)).text();
  assert.ok(!x.includes('docs') && !x.includes('m3.txt'));
  assert.equal((await req('PROPFIND', '/dav/', basic(a.email, bPw))).status, 401);
});

test('size and quota limits give 413', async () => {
  assert.equal((await req('PUT', '/dav/big.bin', A, { body: new Uint8Array(1024 * 1024 + 1) })).status, 413);
  assert.equal((await req('PUT', '/dav/big.bin', A, { body: 'x', headers: { 'content-length': String(5 * 1024 * 1024) } })).status, 413);
  for (let i = 0; i < 2; i++) assert.equal((await req('PUT', `/dav/f${i}.bin`, A, { body: new Uint8Array(900 * 1024) })).status, 201);
  assert.equal((await req('PUT', '/dav/f2.bin', A, { body: new Uint8Array(900 * 1024) })).status, 413); // 2 MB quota
});
