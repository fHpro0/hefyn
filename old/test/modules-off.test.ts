import assert from 'node:assert/strict';
import { trpcCall } from './trpc.ts';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { requests, startFake } from './fake-anthropic.ts';

// The core with the optional modules (projects, schedules) switched OFF: HEFYN_MODULES_DISABLED=projects,schedules. A real web + agent
// service on a fresh data dir, fake Anthropic upstream (the same set-up as e2e.test.ts, trimmed to what the core does without the modules).
process.env.HEFYN_MODULES_DISABLED = 'projects,schedules';
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-off-inproc-'));
process.env.HEFYN_SECRET = 'modules-off-test-secret-modules-off-1';

const PORT = 6000 + Math.floor(Math.random() * 500); // PORT, +600, +1200 span 6000-7700: no other test file draws from it (files run in parallel; a shared range collided)
const base = `http://localhost:${PORT}`, APORT = PORT + 1200;
const TOKEN = 'test-internal-token-test-internal-token-1234';
let server: ChildProcess, agent: ChildProcess, stopping = false;
let fake: Awaited<ReturnType<typeof startFake>>;

class Client {
  cookie = '';
  async req(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    if (set) this.cookie = set;
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  }
  trpc(proc: string, input?: unknown, mutate = false) { return trpcCall((p, i) => fetch(base + p, i), this.cookie, proc, input, mutate, base); }
  login(email: string, password: string) { return this.req('/api/auth/sign-in/email', 'POST', { email, password }); }
}
const admin = new Client(), bob = new Client(), anon = new Client();

before(async () => {
  fake = await startFake();
  const env = { ...process.env, HEFYN_URL: base, NODE_ENV: 'production', HEFYN_SECRET: 'test-secret-test-secret-test-secret-1234', HEFYN_DATA_DIR: mkdtempSync(join(tmpdir(), 'hefyn-off-')), HEFYN_INTERNAL_TOKEN: TOKEN, HEFYN_ALLOW_PRIVATE_URLS: '1' };
  const spawnAgent = () => {
    agent = spawn('bun', ['src/agent.ts'], { env: { ...env, PORT: String(APORT), HEFYN_DRAIN_TIMEOUT_MS: '5000' }, stdio: 'ignore' });
    agent.on('exit', () => { if (!stopping) setTimeout(spawnAgent, 300); });
  };
  spawnAgent();
  server = spawn('bun', ['src/web.ts'], { env: { ...env, PORT: String(PORT), HEFYN_AGENT_URL: `http://127.0.0.1:${APORT}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => { server.stdout!.on('data', (d) => String(d).includes('listening') && ok()); server.on('exit', (c) => fail(new Error(`server exited ${c}`))); });
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${APORT}`).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
});
after(() => { stopping = true; server?.kill(); agent?.kill(); fake?.close(); });

const settle = async (url: string, c: Client = admin) => {
  let h: any;
  for (let i = 0; i < 80; i++) { h = (await c.req(url)).json; if (h.settlements?.length) return h; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('submission never settled: ' + JSON.stringify(h).slice(0, 800));
};

test('setup, sign-in, and the module list shows neither module', async () => {
  assert.equal((await anon.trpc('setup.create', { name: 'Ada', email: 'ada@x.test', password: 'password-1' }, true)).status, 200);
  assert.equal((await admin.login('ada@x.test', 'password-1')).status, 200);
  const mods = (await admin.trpc('modules.list')).json;
  const ids = mods.modules.map((m: any) => m.id);
  assert.ok(ids.includes('files') && ids.includes('folders'), 'the other built-in modules are still there');
  assert.ok(!ids.includes('projects') && !ids.includes('schedules'), JSON.stringify(ids));
  assert.ok(!mods.nav.some((n: any) => n.href === '/schedules') && !mods.commands.some((n: any) => n.href === '/schedules'));
  assert.ok(!mods.permissions.some((p: any) => p.id.startsWith('projects.')), 'no project permissions are offered');
  assert.ok(!(await admin.trpc('roles.list')).json.permissions.includes('projects.share'));
});

test('the modules\' routes do not exist (404), signed in', async () => {
  for (const p of ['/api/projects', '/api/schedules', '/api/projects/directory']) assert.equal((await admin.req(p)).status, 404, p);
  assert.equal((await admin.trpc('folders.list')).status, 200); // folders are a built-in module: they stay on
  assert.equal((await admin.trpc('folders.create', { name: 'in a project', projectId: 'p_x' }, true)).status, 400); // ...but there are no projects to put one in
  const f = (await admin.trpc('folders.create', { name: 'Kunden' }, true)).json;
  assert.ok(f.id && f.projectId === null, JSON.stringify(f));
  assert.equal((await admin.req('/api/schedules', 'POST', {})).status, 404);
});

test('chat: create, list, patch, bulk and delete work without the modules; their fields are absent', async () => {
  const made = (await admin.trpc('conversations.create', { title: 'plain', projectId: 'p_ignored' }, true)).json;
  assert.ok(made.id && !('projectId' in made), JSON.stringify(made));
  const row = (await admin.trpc('conversations.list')).json.find((c: any) => c.id === made.id);
  assert.equal(row.title, 'plain');
  assert.ok(!('projectId' in row) && !('scheduled' in row) && row.folderId === null, JSON.stringify(row)); // folders are built in
  assert.equal((await admin.trpc('conversations.update', { id: made.id, title: 'renamed', pinned: true }, true)).status, 200);
  assert.equal((await admin.trpc('conversations.update', { id: made.id, projectId: 'x' }, true)).status, 400); // nothing owns that field now
  const fid = (await admin.trpc('folders.create', { name: 'Ablage' }, true)).json.id;
  assert.equal((await admin.trpc('conversations.update', { id: made.id, folderId: fid, position: 2 }, true)).status, 200);
  assert.equal((await admin.trpc('conversations.list')).json.find((c: any) => c.id === made.id).folderId, fid);
  assert.equal((await admin.trpc('conversations.bulk', { ids: [made.id], action: 'moveToProject', projectId: null }, true)).status, 400);
  assert.equal((await admin.trpc('conversations.bulk', { ids: [made.id], action: 'move', folderId: null }, true)).status, 200); // folders are built in
  assert.equal((await admin.trpc('conversations.bulk', { ids: [made.id], action: 'archive' }, true)).status, 200);
  assert.equal((await admin.trpc('conversations.bulk', { ids: [made.id], action: 'unarchive' }, true)).status, 200);
  assert.equal((await admin.trpc('conversations.delete', { id: made.id }, true)).status, 200);
  assert.ok(!(await admin.trpc('conversations.list')).json.some((c: any) => c.id === made.id));
});

test('a chat turn with the fake provider: no schedule tools, no project instructions in what the model sees', async () => {
  assert.equal((await admin.trpc('models.connect', { provider: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url }, true)).status, 200);
  assert.equal((await admin.trpc('profile.update', { model: 'anthropic/claude-opus-5-5', agents: { writer: 'anthropic/claude-sonnet-5-5', explorer: null } }, true)).status, 200);
  const { id } = (await admin.trpc('conversations.create', { title: 'turn' }, true)).json;
  const from = requests.length;
  assert.equal((await admin.req(`/agents/configurable/${id}`, 'POST', { kind: 'user', body: 'Ask the writer for a haiku' })).status, 202);
  const h = await settle(`/agents/configurable/${id}`);
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  const sent = requests.slice(from);
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((r) => r.raw.includes('"tools"') && !r.raw.includes('schedule_create') && !r.raw.includes('schedule_list') && !r.system.includes('Project instructions')));
});

test('key rotation and start fresh work without the modules', async () => {
  assert.equal((await admin.trpc('users.create', { email: 'bob@x.test', password: 'password-3' }, true)).status, 200);
  assert.equal((await bob.login('bob@x.test', 'password-3')).status, 200);
  assert.equal((await bob.req('/api/auth/change-password', 'POST', { currentPassword: 'password-3', newPassword: 'password-3-own' })).status, 200);
  await bob.req('/api/security/status');
  assert.match((await bob.req('/api/security/recovery-key/rotate', 'POST', { password: 'password-3-own' })).json.recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  const mine = (await bob.trpc('conversations.create', { title: 'gone soon' }, true)).json.id;
  assert.equal((await bob.req('/api/security/reset-data', 'POST', { password: 'password-3-own', confirm: 'DELETE MY DATA' })).status, 200);
  assert.equal((await bob.login('bob@x.test', 'password-3-own')).status, 200);
  const list = (await bob.trpc('conversations.list')).json;
  assert.ok(Array.isArray(list) && !list.some((c: any) => c.id === mine), JSON.stringify(list));
  assert.equal((await bob.trpc('conversations.create', { title: 'new start' }, true)).status, 200);
});

test('in-process: the registry lists neither module, registers no jobs, and the scheduler job never starts', async () => {
  const { modules, startJobs } = await import('../src/modules/registry.ts');
  const { agentModules } = await import('../src/modules/light.ts');
  assert.ok(!modules().some((m) => m.id === 'projects' || m.id === 'schedules'));
  assert.deepEqual(agentModules.map((m) => m.id), ['folders']); // the agent side registers no tools or instructions either (folders have none)
  assert.deepEqual(startJobs(), ['models.agent-updates']); // the only job left: the agent update check, which belongs to a core module
  const { PERMISSIONS } = await import('../src/server/permissions.ts');
  assert.ok(!PERMISSIONS.includes('projects.share'));
});
