import { trpcCall } from './trpc.ts';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-modinst-'));
process.env.HEFYN_SECRET = 'modinst-test-secret-modinst-test-1234';
delete process.env.HEFYN_ALLOW_PRIVATE_URLS; // the private-address checks must run

const vault = await import('../src/server/vault.ts');
vault.setTeamKey(vault.newKey()); // module secrets are sealed with the team key
const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const hub = await import('../src/server/hub.ts');
const { parseManifest } = await import('../src/modules/manifest.ts');
const { setCaller, MAX_RESULT_BYTES } = await import('../src/modules/installed.ts');
const { egressAllowlist } = await import('../src/server/egress-list.ts');
const { hostKey } = await import('../src/server/egress-list.ts');
hub.setGuard(async () => ({ flagged: false }));
const app = new Hono().route('/api', api);

async function user(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const s = await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true });
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const t = await res.text();
    return { status: res.status, json: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
  };
  const trpc = (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
  return { id: r.user.id, req, trpc };
}
const admin = await user('admin@x.test', 'admin');
const worker = await user('worker@x.test', 'worker');
const viewer = await user('viewer@x.test', 'worker'); // moved to a role with the module permission below

const manifest = (over: object = {}): any => ({
  id: 'acme', name: 'Acme', version: '1.0.0', icon: 'Blocks',
  permissions: [{ name: 'view', label: 'View Acme' }],
  settings: [{ key: 'region', label: 'Region', type: 'select', options: ['eu', 'us'], default: 'eu' }, { key: 'apiKey', label: 'API key', type: 'secret', required: true }],
  skills: [{ name: 'acme-skill', description: 'Acme help', instructions: 'Use the Acme tools.' }],
  agents: [{ name: 'acme-agent', description: 'Acme agent', instructions: 'Work with Acme.', skills: ['acme-skill'] }],
  mcp: { url: 'https://acme.example.com/mcp' },
  screens: {
    home: { title: 'Acme', permission: 'view', blocks: [{ type: 'stat', label: 'Open', tool: 'count', path: 'n' }, { type: 'button', label: 'Docs', href: 'https://acme.example.com/docs' }] },
    admin: { title: 'Admin', permission: 'view', blocks: [{ type: 'form', fields: [{ key: 'note', label: 'Note', type: 'text' }], submit: { tool: 'save', label: 'Save' } }] },
  },
  nav: [{ place: 'main', label: 'Acme', href: '/m/acme/home', icon: 'Blocks', permission: 'view' }],
  commands: [{ label: 'Acme', href: '/m/acme/home', permission: 'view' }],
  ...over,
});
const count = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const navOf = async (u: typeof admin) => (await u.trpc('modules.list')).json.nav.map((n: any) => n.label);

test('manifest validation rejects unknown keys, __proto__, bad MCP, nav to nowhere and bad screen hrefs', () => {
  assert.doesNotThrow(() => parseManifest(manifest()));
  assert.throws(() => parseManifest(manifest({ extra: 1 })), /extra/);
  assert.throws(() => parseManifest(JSON.parse('{"id":"acme","name":"A","version":"1","__proto__":{"x":1}}')), /forbidden key/);
  assert.throws(() => parseManifest(manifest({ screens: { home: { title: 'x', blocks: [], constructor: 1 } }, nav: [], commands: [] })), /forbidden key/);
  assert.throws(() => parseManifest(manifest({ mcp: { url: 'http://acme.example.com/mcp' } })), /https/);
  assert.throws(() => parseManifest(manifest({ mcp: { url: 'https://10.0.0.5/mcp' } })), /private or internal/);
  assert.throws(() => parseManifest(manifest({ mcp: { image: 'acme/server:1' } })), /runner-hosted MCP is not supported yet/);
  assert.throws(() => parseManifest(manifest({ nav: [{ place: 'main', label: 'X', href: '/m/acme/nope', permission: 'view' }] })), /nav\.0\.href/);
  assert.throws(() => parseManifest(manifest({ nav: [{ place: 'main', label: 'X', href: '/settings/models' }] })), /nav\.0\.href/);
  assert.throws(() => parseManifest(manifest({ nav: [{ place: 'main', label: 'X', href: '/m/acme/home', permission: 'ghost' }] })), /unknown permission/);
  const btn = (href: string) => manifest({ screens: { home: { title: 'x', blocks: [{ type: 'button', label: 'b', href }] } }, nav: [], commands: [] });
  assert.throws(() => parseManifest(btn('javascript:alert(1)')), /screens\.home\.blocks\.0/);
  assert.throws(() => parseManifest(btn('/m/other/home')), /href must be/);
  assert.throws(() => parseManifest(btn('/m/acme/../x')), /href must be/);
  assert.doesNotThrow(() => parseManifest(btn('/m/acme/home')));
  assert.throws(() => parseManifest(manifest({ id: 'A' })), /id/);
  assert.throws(() => parseManifest(manifest({ description: 'x'.repeat(300_000) })), /larger than 256 KB/);
  assert.throws(() => parseManifest(manifest({ mcp: undefined })), /needs an mcp server/); // screens call tools
});

test('install needs modules.manage, rejects bad manifests with the path, and refuses built-in ids', async () => {
  assert.equal((await worker.trpc('modules.install', manifest(), true)).status, 403);
  assert.equal((await worker.trpc('modules.installed')).status, 403);
  const bad = await admin.trpc('modules.install', manifest({ mcp: { url: 'http://acme.example.com/mcp' } }), true);
  assert.equal(bad.status, 400);
  assert.match(bad.error!, /^mcp: .*https/);
  assert.equal((await admin.trpc('modules.install', 'not json', true)).status, 400);
  assert.equal((await admin.trpc('modules.install', manifest({ id: 'hub' }), true)).status, 400);
  assert.equal(count('SELECT COUNT(*) AS n FROM modules'), 0);
});

test('install, disable, enable and uninstall leave no trace; nav and egress follow', async () => {
  const adminRole = () => JSON.parse((db.prepare("SELECT permissions FROM roles WHERE id = 'admin'").get() as any).permissions) as string[];
  const clean = () => ['modules', 'module_settings'].every((t) => count(`SELECT COUNT(*) AS n FROM ${t}`) === 0)
    && count("SELECT COUNT(*) AS n FROM mcp_connectors WHERE source LIKE 'module:%'") === 0
    && count("SELECT COUNT(*) AS n FROM packages WHERE json_extract(source_json, '$.url') LIKE 'module:%'") === 0
    && count('SELECT COUNT(*) AS n FROM installs') === 0 && count('SELECT COUNT(*) AS n FROM package_files') === 0;
  assert.ok(clean());
  assert.ok(!(await navOf(admin)).includes('Acme'));

  assert.equal((await admin.trpc('modules.install', manifest(), true)).status, 200);
  assert.equal((await admin.trpc('modules.install', manifest(), true)).status, 409);
  const mods = (await admin.trpc('modules.list')).json;
  assert.ok(mods.nav.some((n: any) => n.href === '/m/acme/home' && n.place === 'main'));
  assert.ok(mods.commands.some((c: any) => c.href === '/m/acme/home'));
  assert.deepEqual(mods.permissions.find((p: any) => p.id === 'mod.acme.view'), { id: 'mod.acme.view', label: 'View Acme', group: 'Acme' });
  assert.ok(mods.modules.some((m: any) => m.id === 'acme'));
  assert.ok(adminRole().includes('mod.acme.view'));
  assert.ok(!(await navOf(worker)).includes('Acme')); // the permission is not theirs
  assert.deepEqual(hub.installedFor('anyone').skills.map((s) => s.name), ['acme-skill']);
  assert.deepEqual(hub.installedFor('anyone').agents.map((s) => s.name), ['acme-agent']);
  assert.equal(count("SELECT COUNT(*) AS n FROM mcp_connectors WHERE source = 'module:acme' AND visibility = 'team'"), 1);
  assert.ok(egressAllowlist().includes(hostKey('https://acme.example.com/mcp')!));
  assert.equal((await admin.trpc('modules.installed')).json[0].enabled, true);

  assert.equal((await admin.trpc('modules.setEnabled', { id: 'acme', enabled: false }, true)).status, 200);
  assert.ok(!(await navOf(admin)).includes('Acme'));
  assert.equal(hub.installedFor('anyone').skills.length, 0);
  assert.ok(!egressAllowlist().includes(hostKey('https://acme.example.com/mcp')!));
  assert.equal((await admin.trpc('modules.screen', { id: 'acme', screen: 'home' })).status, 404); // a disabled module contributes nothing

  assert.equal((await admin.trpc('modules.setEnabled', { id: 'acme', enabled: true }, true)).status, 200);
  assert.ok((await navOf(admin)).includes('Acme'));
  assert.equal(hub.installedFor('anyone').skills.length, 1);

  assert.equal((await admin.trpc('modules.delete', { id: 'acme' }, true)).status, 200);
  assert.ok(clean());
  assert.ok(!(await navOf(admin)).includes('Acme'));
  assert.ok(!adminRole().includes('mod.acme.view'));
  assert.equal((await admin.trpc('modules.delete', { id: 'acme' }, true)).status, 404);
});

test('a failed install leaves nothing behind', async () => {
  // the agent's skill name is already taken by one of the installer's own packages: the 409 happens after the row and skills were written
  await admin.trpc('hub.create', { kind: 'agent', name: 'acme-agent', description: 'mine', instructions: 'x' }, true);
  const r = await admin.trpc('modules.install', manifest(), true);
  assert.equal(r.status, 409);
  assert.equal(count('SELECT COUNT(*) AS n FROM modules'), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM packages WHERE name = 'acme-skill'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM mcp_connectors WHERE source LIKE 'module:%'"), 0);
  db.prepare("DELETE FROM packages WHERE name = 'acme-agent'").run();
  db.prepare('DELETE FROM package_files').run();
});

test('settings: secrets are sealed at rest and never returned; required settings gate calls', async () => {
  await admin.trpc('modules.install', manifest(), true);
  const get = async () => (await admin.trpc('modules.settings', { id: 'acme' })).json;
  const put = (values: object) => admin.trpc('modules.saveSettings', { id: 'acme', values }, true);
  assert.deepEqual((await get()).values, { region: 'eu', apiKey: { set: false } });
  assert.equal((await put({ nope: 'x' })).status, 400);
  assert.equal((await put({ region: 'mars' })).status, 400);
  assert.equal((await put({ apiKey: 'line\nbreak' })).status, 400);
  assert.equal((await put({ region: 'us', apiKey: 'sk-very-secret' })).status, 200);
  assert.equal((await worker.trpc('modules.settings', { id: 'acme' })).status, 403);

  const stored = db.prepare("SELECT value, secret FROM module_settings WHERE key = 'apiKey'").get() as { value: string; secret: number };
  assert.equal(stored.secret, 1);
  assert.ok(vault.isSealed(stored.value) && !stored.value.includes('sk-very-secret'));
  const body = await admin.trpc('modules.settings', { id: 'acme' });
  assert.deepEqual(body.json.values, { region: 'us', apiKey: { set: true } });
  assert.ok(!JSON.stringify(body.json).includes('sk-very-secret'));
  await put({ apiKey: '' }); // empty keeps it
  assert.deepEqual((await get()).values.apiKey, { set: true });
});

test('screens and calls: permission, referenced tools only, body and result limits, settings as headers', async () => {
  const role = await admin.trpc('roles.create', { name: 'Acme viewers', permissions: ['mod.acme.view'] }, true);
  assert.equal(role.status, 200); // module permissions are storable on roles
  assert.equal((await admin.trpc('roles.create', { name: 'Ghosts', permissions: ['mod.ghost.view'] }, true)).status, 400);
  assert.ok((await admin.trpc('roles.list')).json.permissions.includes('mod.acme.view'));
  db.prepare('UPDATE user_roles SET role_id = ? WHERE user_id = ?').run(role.json.id, viewer.id);

  const screenOf = (u: typeof admin, screen: string) => u.trpc('modules.screen', { id: 'acme', screen });
  const callOf = (u: typeof admin, tool: string, args?: unknown) => u.trpc('modules.callTool', { id: 'acme', tool, args }, true);
  assert.equal((await screenOf(worker, 'home')).status, 403);
  assert.equal((await callOf(worker, 'count', {})).status, 403);
  assert.equal((await trpcCall((p, i) => app.request(p, i), '', 'modules.screen', { id: 'acme', screen: 'home' })).status, 401);
  assert.ok((await navOf(viewer)).includes('Acme'));
  const screen = await screenOf(viewer, 'home');
  assert.equal(screen.status, 200);
  assert.equal(screen.json.title, 'Acme');
  assert.equal((await screenOf(viewer, 'nope')).status, 404);
  assert.equal((await screenOf(viewer, 'constructor')).status, 404);

  const calls: any[] = [];
  let out: unknown = { n: 3 };
  setCaller(async (userId, connectorId, tool, args, headers) => { calls.push({ userId, tool, args, headers }); return out; });
  const ok = await callOf(viewer, 'count', { q: 'open' });
  assert.deepEqual(ok.json, { result: { n: 3 } });
  assert.deepEqual(calls[0].args, { q: 'open' });
  assert.equal(calls[0].headers['x-hefyn-setting-apikey'], 'sk-very-secret');
  assert.equal(calls[0].headers['x-hefyn-setting-region'], 'us');
  assert.equal((await callOf(viewer, 'save', { note: 'hi' })).status, 200); // referenced by the form on the "admin" screen
  assert.equal((await callOf(viewer, 'delete_everything', {})).status, 403); // no screen references it
  assert.equal(calls.length, 2);
  assert.equal((await callOf(viewer, 'count', [1])).status, 400);
  assert.equal((await callOf(viewer, 'count', { big: 'x'.repeat(70_000) })).status, 413);
  out = { blob: 'x'.repeat(MAX_RESULT_BYTES) };
  assert.equal((await callOf(viewer, 'count', {})).status, 502);
  setCaller(async () => { throw new Error('boom internal detail'); });
  const down = await callOf(viewer, 'count', {});
  assert.equal(down.status, 502);
  assert.ok(!JSON.stringify(down).includes('boom'));

  // a required setting that is missing blocks the call
  db.prepare("DELETE FROM module_settings WHERE key = 'apiKey'").run();
  setCaller(async () => ({}));
  assert.equal((await callOf(viewer, 'count', {})).status, 409);

  // uninstalling takes the permission off the role
  await admin.trpc('modules.delete', { id: 'acme' }, true);
  assert.deepEqual(JSON.parse((db.prepare('SELECT permissions FROM roles WHERE id = ?').get(role.json.id) as any).permissions), []);
  assert.equal(count('SELECT COUNT(*) AS n FROM module_settings'), 0);
});

test('a Hub package of kind module installs and uninstalls through the same function', async () => {
  const made = await admin.trpc('hub.create', { kind: 'module', manifest: manifest() }, true);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.kind, 'module');
  assert.equal((await admin.trpc('hub.create', { kind: 'module', manifest: manifest({ mcp: { image: 'x' } }) }, true)).status, 400);
  const id = made.json.id;
  const target = { id, target: 'team' };
  assert.equal((await worker.trpc('hub.install', target, true)).status, 403); // needs modules.manage
  assert.equal((await admin.trpc('hub.install', target, true)).status, 409); // not approved yet
  assert.equal((await admin.trpc('hub.publish', { id }, true)).status, 200); // an approver publishes directly
  const inst = await admin.trpc('hub.install', target, true);
  assert.equal(inst.status, 200, JSON.stringify(inst.json));
  assert.equal(inst.json.installed.team, true);
  assert.equal(count("SELECT COUNT(*) AS n FROM modules WHERE id = 'acme'"), 1);
  assert.ok((await navOf(admin)).includes('Acme'));
  assert.equal((await admin.trpc('hub.install', target, true)).status, 409); // already installed
  const gone = await admin.trpc('hub.uninstall', target, true);
  assert.equal(gone.status, 200);
  assert.equal(count('SELECT COUNT(*) AS n FROM modules'), 0);
  assert.ok(!(await navOf(admin)).includes('Acme'));
});

test('docs/examples/hello-module.json is a valid manifest that uses every block type', async () => {
  const { readFileSync } = await import('node:fs');
  const m = parseManifest(JSON.parse(readFileSync(new URL('../docs/examples/hello-module.json', import.meta.url), 'utf8')));
  assert.deepEqual([...new Set(m.screens!.home.blocks.map((b) => b.type))].sort(), ['alert', 'button', 'form', 'list', 'stat', 'table', 'text']);
  assert.ok(m.settings?.length);
});

test('assertPublicUrl refuses the known bypasses', async () => {
  const { assertPublicUrl } = await import('../src/server/mcp.ts');
  for (const h of ['[::ffff:127.0.0.1]', '[::ffff:169.254.169.254]', '[::127.0.0.1]', 'agent.', 'runner.:8790', 'localhost.', 'metadata.google.internal.', '100.64.0.1', '198.18.0.1', '[fe90::1]', '[64:ff9b::7f00:1]',
    '127.0.0.1', '0x7f.1', '2130706433', '10.1.2.3', '192.168.1.1', '172.20.0.1', '224.0.0.1', '240.0.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', 'db', 'x.local'])
    assert.throws(() => assertPublicUrl(`https://${h}/mcp`), /private or internal/, h);
  for (const h of ['acme.example.com', '8.8.8.8', '[2606:4700::1111]', '100.63.255.255']) assert.doesNotThrow(() => assertPublicUrl(`https://${h}/mcp`), h);
});

test('manifest: capitalised icons only, own hrefs without escapes, single-line defaults', () => {
  assert.throws(() => parseManifest(manifest({ icon: 'constructor' })), /icon/);
  assert.throws(() => parseManifest(manifest({ icon: 'hasOwnProperty' })), /icon/);
  const btn = (href: string) => manifest({ screens: { home: { title: 'x', blocks: [{ type: 'button', label: 'b', href }] } }, nav: [], commands: [] });
  for (const h of ['/m/acme/%2e%2e/x', '/m/acme/.%2e/x', '/m/acme/%2E%2E/other', '/m/acme/./../../x', '/m/acme/']) assert.throws(() => parseManifest(btn(h)), /href must be/, h);
  assert.doesNotThrow(() => parseManifest(btn('/m/acme/home?tab=1')));
  const field = (f: object) => manifest({ settings: [{ key: 'k', label: 'K', ...f }] });
  assert.throws(() => parseManifest(field({ type: 'text', default: 'a\nb' })), /single line/);
  assert.throws(() => parseManifest(field({ type: 'select', options: ['a', 'b'], default: 'c' })), /one of the options/);
  assert.doesNotThrow(() => parseManifest(field({ type: 'select', options: ['a', 'b'], default: 'b' })));
  assert.throws(() => parseManifest(manifest({ agent: { tools: ['count'], permission: 'ghost' } })), /unknown permission/);
  assert.throws(() => parseManifest(manifest({ mcp: undefined, screens: undefined, nav: undefined, commands: undefined, agent: { tools: ['x'] } })), /needs an mcp server/);
});

test('install bodies are capped', async () => {
  const r = await admin.trpc('modules.install', { pad: 'x'.repeat(310_000) }, true);
  assert.equal(r.status, 413);
});

test('a module reaches the chat agent only through its agent section, for users holding its permission', async () => {
  const { moduleMounts } = await import('../src/modules/mount.ts');
  const { mountable, listConnectors } = await import('../src/server/mcp.ts');
  const withAgent = manifest({ agent: { tools: ['count'], permission: 'view' } });
  await admin.trpc('modules.install', withAgent, true);
  await admin.trpc('modules.saveSettings', { id: 'acme', values: { apiKey: 'k-1' } }, true);
  const holder = await user('holder@x.test', 'worker');
  const role = await admin.trpc('roles.create', { name: 'Acme agent users', permissions: ['models.use', 'mod.acme.view'] }, true);
  db.prepare('UPDATE user_roles SET role_id = ? WHERE user_id = ?').run(role.json.id, holder.id);

  assert.ok(!mountable(admin.id).some((m) => m.url.includes('acme.example.com'))); // module connectors are never mounted as ordinary ones
  const mine = moduleMounts(holder.id);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0]!.tools, ['count']);
  assert.equal(mine[0]!.headers['x-hefyn-setting-apikey'], 'k-1');
  assert.equal(moduleMounts(worker.id).length, 0); // no module permission
  assert.equal(moduleMounts(admin.id).length, 1);

  // hidden from Connectors for everyone but module managers
  const named = (rows: any[]) => rows.some((c) => c.name === 'Acme');
  assert.ok(!named(listConnectors(holder.id)));
  assert.ok(named(listConnectors(admin.id, true)));
  assert.ok(!named((await holder.trpc('connectors.mcp.list')).json));
  assert.ok(named((await admin.trpc('connectors.mcp.list')).json));
  const cid = (db.prepare("SELECT id FROM mcp_connectors WHERE source = 'module:acme'").get() as any).id;
  assert.equal((await holder.trpc('connectors.mcp.test', { id: cid }, true)).json.ok, false);
  const del = await admin.trpc('connectors.mcp.delete', { id: cid }, true);
  assert.equal(del.status, 409);
  assert.match(del.error!, /managed by module acme/);
  assert.equal((await admin.trpc('connectors.mcp.setBearer', { id: cid, bearer: 'x' }, true)).status, 409);

  // enabling an enabled module restores a connector that went missing
  db.prepare('DELETE FROM mcp_connectors WHERE id = ?').run(cid);
  assert.equal((await admin.trpc('modules.setEnabled', { id: 'acme', enabled: true }, true)).status, 200);
  assert.equal(count("SELECT COUNT(*) AS n FROM mcp_connectors WHERE source = 'module:acme'"), 1);

  // without an agent section nothing is mounted for anyone
  await admin.trpc('modules.delete', { id: 'acme' }, true);
  await admin.trpc('modules.install', manifest(), true);
  assert.equal(moduleMounts(admin.id).length, 0);
  await admin.trpc('modules.delete', { id: 'acme' }, true);
});

test('Hub install state and uninstall follow the package, not the module id', async () => {
  db.prepare("DELETE FROM packages WHERE kind = 'module'").run(); // the earlier test's package
  await admin.trpc('modules.install', manifest(), true); // installed directly
  const made = await admin.trpc('hub.create', { kind: 'module', manifest: manifest() }, true);
  const target = { id: made.json.id, target: 'team' };
  await admin.trpc('hub.publish', { id: made.json.id }, true);
  const pkgs = async () => (await admin.trpc('hub.get', { id: made.json.id })).json;
  assert.equal((await pkgs()).installed.team, false); // same id, other origin
  assert.equal((await admin.trpc('hub.install', target, true)).status, 409);
  assert.equal((await admin.trpc('hub.uninstall', target, true)).status, 404);
  assert.equal(count("SELECT COUNT(*) AS n FROM modules WHERE id = 'acme'"), 1); // the direct install survives
  await admin.trpc('modules.delete', { id: 'acme' }, true);
  assert.equal((await admin.trpc('hub.install', target, true)).status, 200);
  assert.equal((await pkgs()).installed.team, true);
  await admin.trpc('hub.uninstall', target, true);
  assert.equal(count('SELECT COUNT(*) AS n FROM modules'), 0);
});

setTimeout(() => process.exit(0), 5000).unref(); // importing the real auth module leaves a timer behind
