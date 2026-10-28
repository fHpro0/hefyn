import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpError, parseJsonRead } from '../services/runner/src/logic.ts';

// Agent updates without Docker: the version an agent reports, the update decision, the side-by-side switch, the removal of the old version only once no session
// holds it, and a failed update keeping the old one. A recording stand-in for the runner and for the ACP Registry. The real thing is test/cli-agent-update.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-agentupd-'));
process.env.HEFYN_SECRET = 'agent-upd-secret-agent-upd-secret-123456';
process.env.HEFYN_INTERNAL_TOKEN = 'agent-upd-token-agent-upd-token-0123456789';

const { PROFILES } = await import('../src/cli-agents/profiles.ts');
const { bundledRegistry, resetRegistryCache } = await import('../src/cli-agents/registry.ts');
const inst = await import('../src/cli-agents/installed.ts');
const { db } = await import('../src/server/appdb.ts');

const snap = bundledRegistry();
let registryVersion = '0.96.0';
// the ACP Registry, and (same server) npm, which is where Claude Code's version comes from (registry.ts withClaudeCode)
const fakeRegistry = Bun.serve({ port: 0, fetch: (req: Request) => (new URL(req.url).pathname.includes('claude-code') ? Response.json({ version: registryVersion }) : Response.json({ version: '1.0.0', agents: snap })) });
const reg = () => snap.map((a) => (a.id === 'claude-acp' ? { ...a, version: registryVersion } : a));
const calls: { method: string; path: string; body?: any }[] = [];
const state: Record<string, { state: string; error?: string }> = {}; // "<id>/<version>" -> what the runner says
const fakeRunner = Bun.serve({ port: 0, async fetch(req: Request) {
  const u = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
  calls.push({ method: req.method, path: u.pathname, body });
  if (u.pathname === '/agents/install') return Response.json(state[`${body.id}/${body.version}`] ??= { state: 'installing' });
  if (u.pathname.endsWith('/json')) return Response.json({ value: '2.1.310' });
  if (req.method === 'GET') return Response.json(state[u.pathname.replace('/agents/', '')] ?? { state: 'none' });
  return Response.json({ ok: true });
} });
process.env.HEFYN_RUNNER_URL = `http://127.0.0.1:${fakeRunner.port}`;
process.env.HEFYN_ACP_REGISTRY_URL = `http://127.0.0.1:${fakeRegistry.port}/registry.json`;
process.env.HEFYN_NPM_REGISTRY_URL = `http://127.0.0.1:${fakeRegistry.port}`;
test.after(() => { fakeRunner.stop(true); fakeRegistry.stop(true); });

const row = () => inst.rowOf('claude-acp')!;
const reset = (version = '0.95.0', extra = '') => {
  resetRegistryCache(); db.prepare('DELETE FROM cli_agents').run(); calls.length = 0; for (const k of Object.keys(state)) delete state[k];
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles) VALUES ('claude-acp', ?, 'ready', 1, '[]')").run(version);
  if (extra) db.prepare(`UPDATE cli_agents SET ${extra} WHERE id = 'claude-acp'`).run();
};
const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

test('versions compare numerically; a registry that is older or equal offers nothing', () => {
  assert.equal(inst.compareVersions('1.19.4', '1.9.0'), 1);
  assert.equal(inst.compareVersions('0.96.0', '0.95.0'), 1);
  assert.equal(inst.compareVersions('0.95.0', '0.95.0'), 0);
  assert.equal(inst.compareVersions('2.1.9', '2.1.10'), -1);
  const ready = { status: 'ready' as const, version: '0.95.0', update_version: null };
  assert.equal(inst.updateTarget(ready, { version: '0.96.0' }), '0.96.0');
  assert.equal(inst.updateTarget(ready, { version: '0.95.0' }), null, 'same');
  assert.equal(inst.updateTarget(ready, { version: '0.94.0' }), null, 'older: never a downgrade');
  assert.equal(inst.updateTarget({ ...ready, update_version: '0.96.0' }, { version: '0.97.0' }), null, 'one update at a time');
  assert.equal(inst.updateTarget({ ...ready, status: 'failed' as any }, { version: '0.96.0' }), null);
  assert.equal(inst.updateTarget(ready, undefined), null);
});

test('auto-update defaults on for registry agents, off for an uploaded manifest with a pinned download; the admin\'s choice wins', () => {
  const pinned = { ...PROFILES['claude-acp']!, spec: { ...PROFILES['claude-acp']!.spec, distribution: { version: '1.0.0', npm: '@agentclientprotocol/claude-agent-acp@1.0.0' } } };
  assert.equal(inst.autoUpdateOn({ auto_update: null }, PROFILES['claude-acp']!), true);
  assert.equal(inst.autoUpdateOn({ auto_update: null }, pinned), false);
  assert.equal(inst.autoUpdateOn({ auto_update: 0 }, PROFILES['claude-acp']!), false);
  assert.equal(inst.autoUpdateOn({ auto_update: 1 }, pinned), true);
});

test('the built-in manifests say where the agent\'s own version is (OpenCode: the registry version is its own)', () => {
  assert.deepEqual(PROFILES['claude-acp']!.spec.cliVersion, { packageJson: 'node_modules/@anthropic-ai/claude-code/package.json', field: 'version' });
  assert.deepEqual(PROFILES['codex-acp']!.spec.cliVersion, { packageJson: 'node_modules/@openai/codex/package.json', field: 'version' });
  assert.deepEqual(PROFILES['pi-acp']!.spec.cliVersion, { packageJson: 'node_modules/@earendil-works/pi-coding-agent/package.json', field: 'version' });
  assert.equal(PROFILES.opencode!.spec.cliVersion, undefined);
});

test('the runner reads only a .json file inside the install', () => {
  assert.deepEqual(parseJsonRead({ path: 'node_modules/@openai/codex/package.json', field: 'version' }), { path: 'node_modules/@openai/codex/package.json', field: 'version' });
  for (const b of [{ path: '../x.json', field: 'version' }, { path: '/etc/passwd', field: 'version' }, { path: 'a/../b.json', field: 'version' }, { path: 'a.txt', field: 'version' }, { path: 'a.json', field: '__proto__ x' }, {}]) assert.throws(() => parseJsonRead(b), HttpError);
});

test('catalog: the agent\'s own version first, the adapter\'s next to it', async () => {
  reset('0.96.0');
  await inst.reconcile(); // reads cli_version through the runner
  assert.equal(row().cli_version, '2.1.310');
  const c = inst.mergeCatalog(snap.map((a) => (a.id === 'claude-acp' ? { ...a, version: '0.96.0' } : a)), inst.allRows()).find((x) => x.id === 'claude-acp')!;
  assert.deepEqual([c.version, c.adapterVersion, c.updateAvailable, c.autoUpdate, c.updating], ['2.1.310', '0.96.0', null, true, null]);
  const open = inst.mergeCatalog(snap, []).find((x) => x.id === 'opencode')!;
  assert.equal(open.version, open.adapterVersion, 'no separate adapter: one version');
});

test('update: installed next to the old version; the old one stays usable until the new one is ready; removed only when no session holds it', async () => {
  reset('0.95.0');
  const release = inst.lease('claude-acp', '0.95.0'); // an open chat
  await inst.checkUpdates(true);
  assert.deepEqual(calls.find((c) => c.path === '/agents/install')!.body.version, '0.96.0');
  assert.deepEqual([row().status, row().version, row().update_version], ['ready', '0.95.0', '0.96.0'], 'the agent keeps working on the old version');
  assert.ok(!('reason' in inst.launchable('u', 'claude-acp', true)), 'still launchable');
  assert.equal(inst.mergeCatalog(reg(), inst.allRows()).find((x) => x.id === 'claude-acp')!.updating, '0.96.0');
  await inst.reconcile();
  assert.equal(row().version, '0.95.0', 'not ready yet: nothing changes');

  state['claude-acp/0.96.0'] = { state: 'ready' };
  await inst.reconcile();
  assert.deepEqual([row().version, row().update_version, row().last_update_error], ['0.96.0', null, null], 'new sessions start on the new version');
  assert.equal((inst.launchable('u', 'claude-acp', true) as any).row.version, '0.96.0');
  assert.deepEqual(deletes(), [], 'an open session still runs on 0.95.0: its files stay');
  assert.deepEqual(JSON.parse(row().retired!), ['0.95.0']);

  release();
  await inst.reconcile();
  assert.deepEqual(deletes(), ['/agents/claude-acp/0.95.0']);
  assert.deepEqual(JSON.parse(row().retired!), []);
});

test('update that fails keeps the old version, ready, and says why in plain words', async () => {
  reset('0.95.0');
  state['claude-acp/0.96.0'] = { state: 'failed', error: 'the download does not match the checksum' };
  await inst.checkUpdates(true); // the runner answers `failed` at once
  await inst.reconcile();
  const r = row();
  assert.deepEqual([r.status, r.version, r.update_version], ['ready', '0.95.0', null]);
  assert.match(r.last_update_error!, /Could not update to 0\.96\.0; still on 0\.95\.0, which keeps working\. .*checksum/);
  const c = inst.mergeCatalog(reg(), inst.allRows()).find((x) => x.id === 'claude-acp')!;
  assert.match(c.lastUpdateError!.message, /checksum/); assert.ok(c.lastUpdateError!.at);
  assert.equal(c.updateAvailable, '0.96.0', 'still offered by hand');
});

test('an unreachable runner during the update start keeps the old version', async () => {
  reset('0.95.0');
  const keep = process.env.HEFYN_RUNNER_URL; process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1';
  try { await inst.checkUpdates(true); } finally { process.env.HEFYN_RUNNER_URL = keep; }
  assert.deepEqual([row().status, row().version, row().update_version], ['ready', '0.95.0', null]);
  assert.match(row().last_update_error!, /unreachable/);
});

test('auto-update off, or nothing newer: the registry is looked at, nothing is installed', async () => {
  reset('0.95.0', 'auto_update = 0');
  await inst.checkUpdates(true);
  assert.equal(calls.some((c) => c.path === '/agents/install'), false);
  assert.ok(row().last_checked);
  assert.equal(inst.mergeCatalog(reg(), inst.allRows()).find((x) => x.id === 'claude-acp')!.updateAvailable, '0.96.0');
  reset('0.96.0'); await inst.checkUpdates(true);
  assert.equal(calls.some((c) => c.path === '/agents/install'), false, 'same version');
  registryVersion = '0.90.0'; reset('0.96.0'); await inst.checkUpdates(true); registryVersion = '0.96.0';
  assert.equal(calls.some((c) => c.path === '/agents/install'), false, 'older registry: no downgrade');
});

test('a manual update (the button) is side by side too', async () => {
  reset('0.95.0');
  await inst.installAgent('claude-acp');
  assert.deepEqual([row().status, row().version, row().update_version], ['ready', '0.95.0', '0.96.0']);
});

test('uninstall removes the current, the retired and the incoming versions', async () => {
  reset('0.96.0', `retired = '["0.94.0"]', update_version = '0.97.0'`);
  await inst.uninstallAgent('claude-acp');
  assert.deepEqual(deletes().sort(), ['/agents/claude-acp/0.94.0', '/agents/claude-acp/0.96.0', '/agents/claude-acp/0.97.0']);
});
