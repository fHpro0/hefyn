import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-theme-'));
process.env.HEFYN_SECRET = 'theme-test-secret-theme-test-secret-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'worker');
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return (method = 'GET', body?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, method === 'GET' ? 'theme.get' : 'theme.save', body, method !== 'GET');
}
const good = { mode: 'dark', accent: '#059669', base: 'slate', radius: 'large', density: 'compact', textSize: 'large' };

test('theme: needs a session, defaults, round-trips per user, strict validation', async () => {
  assert.equal((await app.request('/api/trpc/theme.get')).status, 401);
  const a = await mk('a@x.test'), b = await mk('b@x.test');
  assert.deepEqual((await a()).json, { mode: 'system', accent: 'default', base: 'zinc', radius: 'default', density: 'comfortable', textSize: 'default' });
  assert.equal((await a('PUT', good)).status, 200);
  assert.deepEqual((await a()).json, good);
  assert.equal((await b()).json.mode, 'system'); // another user is untouched
  for (const bad of [{ ...good, accent: 'red' }, { ...good, accent: '#fff' }, { ...good, accent: 'url(x)' }, { ...good, base: 'gray' }, { ...good, extra: 1 }, { mode: 'dark' }, null])
    assert.equal((await a('PUT', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await a('PUT', { ...good, accent: 'default' })).status, 200);
  assert.deepEqual((await a()).json, { ...good, accent: 'default' });
});
