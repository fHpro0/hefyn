import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-brand-'));
process.env.HEFYN_SECRET = 'brand-test-secret-brand-test-secret-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return (proc: string, body?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, proc, body, proc === 'brand.set');
}
const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

test('brand: public read, admin-only write, mime and size validated, clears', async () => {
  const admin = await mk('a@x.test', 'admin'), worker = await mk('w@x.test', 'worker');
  assert.deepEqual(((await (await app.request('/api/trpc/brand.get')).json()) as any).result.data, { name: '', logo: null, logoDark: null }); // no session needed
  assert.equal((await worker('brand.set', { name: 'TMT', logo: null, logoDark: null })).status, 403);
  assert.equal((await admin('brand.set', { name: '  TMT  ', logo: svg, logoDark: null })).status, 200);
  assert.deepEqual((await worker('brand.get')).json, { name: 'TMT', logo: svg, logoDark: null });
  const bad = [
    { name: 'x', logo: `data:image/gif;base64,AAAA`, logoDark: null },
    { name: 'x', logo: `data:text/html;base64,AAAA`, logoDark: null },
    { name: 'x', logo: 'https://evil.test/a.png', logoDark: null },
    { name: 'x', logo: `data:image/png;base64,${'A'.repeat(256 * 1024)}`, logoDark: null },
    { name: 'x'.repeat(61), logo: null, logoDark: null },
  ];
  for (const b of bad) assert.equal((await admin('brand.set', b)).status, 400, b.name);
  assert.equal((await admin('brand.set', { name: '', logo: null, logoDark: null })).status, 200);
  assert.deepEqual((await admin('brand.get')).json, { name: '', logo: null, logoDark: null });
});
