import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-mod-'));
process.env.HEFYN_SECRET = 'mod-test-secret-mod-test-secret-1234';
process.env.HEFYN_MODULES_DISABLED ??= ''; // schedules and projects are off by default (active.ts); scripts/test.ts sets this too, a bare `bun test` did not

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { PERMISSIONS } = await import('../src/server/permissions.ts');
const { modules, permissionInfo, validateModules } = await import('../src/modules/registry.ts');
const app = new Hono().route('/api', api);

async function user(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const s = await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true });
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { trpc: (proc: string, input?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, proc, input) };
}
const admin = await user('admin@x.test', 'admin');
const worker = await user('worker@x.test', 'worker');
const { settingsGroups } = await import('../web/src/components/settings-nav.ts');
const settings = (r: any) => Object.fromEntries(settingsGroups(r.nav).map((g: any) => [g.label, g.items.map((n: any) => n.href)]));

test('validation rejects duplicate ids, duplicate permissions, bad hrefs and unknown permissions', () => {
  assert.throws(() => validateModules([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]), /duplicate module id/);
  const p = { id: 'x.y', label: 'X' };
  assert.throws(() => validateModules([{ id: 'a', name: 'A', permissions: [p] }, { id: 'b', name: 'B', permissions: [p] }]), /duplicate permission id/);
  assert.throws(() => validateModules([{ id: 'a', name: 'A', nav: [{ place: 'main', label: 'L', href: 'nope' }] }]), /must start with \//);
  assert.throws(() => validateModules([{ id: 'a', name: 'A', commands: [{ label: 'L', href: '/l', permission: ['ghost.do'] }] }]), /unknown permission "ghost.do"/);
  assert.ok(modules().length >= 10);
});

test('the registry declares exactly the built-in permissions', () => {
  assert.deepEqual(permissionInfo(modules()).map((p) => p.id).sort(), [...PERMISSIONS].sort());
});

test('modules.list: Admin sees every settings entry in order, Worker only the ungated ones', async () => {
  const a = (await admin.trpc('modules.list')).json;
  const personal = ['/settings/profile', '/settings/appearance', '/settings/mcp', '/settings/security', '/settings/agent-accounts', '/settings/devices', '/settings/connected-apps'];
  assert.deepEqual(settings(a), { You: personal, Workspace: ['/settings/providers', '/settings/users', '/settings/roles', '/settings/branding', '/usage'] });
  assert.deepEqual(a.nav.filter((n: any) => n.place === 'main').map((n: any) => n.label), ['New chat', 'Assistants', 'Skills', 'Files']);
  assert.ok(!a.commands.some((c: any) => c.href === '/hub/review'), 'the Hub UI moved to old/');
  assert.equal(a.permissions.length, PERMISSIONS.length);
  const w = (await worker.trpc('modules.list')).json;
  assert.deepEqual(settings(w), { You: ['/settings/profile', '/settings/appearance', '/settings/providers', '/settings/mcp', '/usage', '/settings/security', '/settings/agent-accounts', '/settings/devices', '/settings/connected-apps'] }); // no Workspace group at all
});

test('modules.list needs a session; the module procedures still answer', async () => {
  const anon = (proc: string) => trpcCall((p, i) => app.request(p, i), '', proc);
  assert.equal((await anon('modules.list')).status, 401);
  assert.equal((await anon('hub.list')).status, 401);
  const r = await worker.trpc('hub.list');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  assert.equal((await admin.trpc('connectors.mcp.list')).status, 200);
});

setTimeout(() => process.exit(0), 5000).unref(); // importing the real auth module leaves a timer behind
