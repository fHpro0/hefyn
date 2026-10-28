import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-roles-'));
process.env.HEFYN_SECRET = 'roles-test-secret-roles-test-secret-1234';
process.env.HEFYN_MODULES_DISABLED ??= '';

const { Hono } = await import('hono');
const { db, defaultRole } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { createKernel, modulePlugin } = await import('../src/kernel/index.ts');
const { permissionInfo } = await import('../src/modules/registry.ts');
const app = new Hono().route('/api', api);

async function signIn(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const s = await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true });
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: r.user.id, q: (proc: string, input?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, proc, input), m: (proc: string, input?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, true) };
}
const admin = await signIn('admin@r.test', 'admin');
const rolesOf = async () => (await admin.q('roles.list')).json.roles as { id: string; name: string; permissions: string[] }[];
const roleOf = (id: string) => (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').get(id) as { role_id: string }).role_id;

test('Worker can use the sandbox; a new role starts with chat and the sandbox only', async () => {
  const worker = (await rolesOf()).find((r) => r.id === 'worker')!;
  assert.ok(worker.permissions.includes('sandbox.shell'));
  const { id } = (await admin.m('roles.create', { name: 'Fresh' })).json;
  assert.deepEqual((await rolesOf()).find((r) => r.id === id)!.permissions, ['models.use', 'sandbox.shell']);
});

test('the sandbox.shell seed only reaches a Worker that still has the original defaults', () => {
  const run = (perms: string[]) => {
    db.prepare("DELETE FROM instance_settings WHERE key = 'seed_worker_sandbox_shell'").run();
    db.prepare("UPDATE roles SET permissions = ? WHERE id = 'worker'").run(JSON.stringify(perms));
    return import(`../src/server/appdb.ts?seed=${Math.random()}`).then(() => JSON.parse((db.prepare("SELECT permissions FROM roles WHERE id = 'worker'").get() as any).permissions) as string[]);
  };
  return Promise.all([]).then(async () => {
    assert.ok((await run(['models.use', 'hub.install', 'assistants.create', 'assistants.share'])).includes('sandbox.shell'));
    assert.ok(!(await run(['models.use'])).includes('sandbox.shell')); // edited: left alone
    db.prepare("UPDATE roles SET permissions = ? WHERE id = 'worker'").run(JSON.stringify(['models.use', 'sandbox.shell']));
  });
});

test('Worker is editable, Admin is locked', async () => {
  assert.equal((await admin.m('roles.update', { id: 'worker', permissions: ['models.use', 'sandbox.shell', 'hub.install'], description: 'Everyday staff' })).status, 200);
  const w = (await rolesOf()).find((r) => r.id === 'worker')!;
  assert.ok(w.permissions.includes('hub.install'));
  assert.equal((await admin.m('roles.update', { id: 'worker', name: 'Staff' })).code, 'CONFLICT');
  assert.equal((await admin.m('roles.update', { id: 'admin', permissions: [] })).code, 'CONFLICT');
  assert.equal((await admin.m('roles.delete', { id: 'worker' })).code, 'CONFLICT');
  assert.equal((await admin.m('roles.delete', { id: 'admin' })).code, 'CONFLICT');
});

test('duplicate copies permissions under a free name', async () => {
  const { id } = (await admin.m('roles.create', { name: 'Support', permissions: ['models.use', 'usage.view_all'] })).json;
  const a = (await admin.m('roles.duplicate', { id })).json.id, b = (await admin.m('roles.duplicate', { id })).json.id;
  const roles = await rolesOf();
  assert.equal(roles.find((r) => r.id === a)!.name, 'Support copy');
  assert.equal(roles.find((r) => r.id === b)!.name, 'Support copy 2');
  assert.deepEqual(roles.find((r) => r.id === a)!.permissions, ['models.use', 'usage.view_all']);
});

test('default role: new users get it; deleting a role moves members to it', async () => {
  const { id: lead } = (await admin.m('roles.create', { name: 'Lead' })).json;
  const { id: temp } = (await admin.m('roles.create', { name: 'Temp' })).json;
  assert.equal((await admin.q('roles.list')).json.defaultRole, 'worker');
  assert.equal((await admin.m('roles.setDefault', { id: lead })).status, 200);
  assert.equal(defaultRole(), lead);

  const created = await admin.m('users.create', { email: 'new@r.test', password: 'password-12345' });
  assert.equal(created.status, 200, String(created.error));
  assert.equal(roleOf(created.json.id), lead);

  const member = await signIn('temp@r.test', temp);
  assert.equal((await admin.m('roles.delete', { id: lead })).code, 'CONFLICT'); // the default cannot go
  assert.equal((await admin.m('roles.delete', { id: temp })).status, 200);
  assert.equal(roleOf(member.id), lead);
});

test('a plugin permission appears under its module and can be granted', async () => {
  const mod = { id: 'acme', name: 'Acme CRM', permissions: [{ id: 'acme.sync', label: 'Sync contacts', hint: 'Pull contacts.' }, { id: 'acme.admin', label: 'Administer', group: 'Acme admin' }] };
  const k = createKernel();
  k.plugin(modulePlugin(mod));
  await new Promise((r) => setTimeout(r, 0));
  const info = permissionInfo([mod]);
  assert.equal(info.find((p) => p.id === 'acme.sync')!.group, 'Acme CRM');
  assert.equal(info.find((p) => p.id === 'acme.admin')!.group, 'Acme admin');
  const { id } = (await admin.m('roles.create', { name: 'Sales' })).json;
  assert.equal((await admin.m('roles.update', { id, permissions: ['models.use', 'acme.sync'] })).status, 200);
  assert.ok((await rolesOf()).find((r) => r.id === id)!.permissions.includes('acme.sync'));
  assert.ok((await rolesOf()).find((r) => r.id === 'admin')!.permissions.includes('acme.sync'));
});
