import assert from 'node:assert/strict';
import { trpcCall } from './trpc.ts';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { requests, startFake } from './fake-anthropic.ts';
import { oauth as mcpOauth, seen, startFakeMcp } from './fake-mcp.ts';

// Runs against the BUILT server (`vite build` first): real Better Auth, real Flue, fake Anthropic upstream.
const PORT = 8000 + Math.floor(Math.random() * 500); // PORT, +600, +1200 span 8000-9700: no other test file draws from it (files run in parallel)
const base = `http://localhost:${PORT}`;
let server: ChildProcess; // web service
let agent: ChildProcess; // agent service; respawned on exit like Docker's restart policy would
let stopping = false;
const APORT = PORT + 1200;
const TOKEN = 'test-internal-token-test-internal-token-1234'; // production validation wants 32+ characters
const agentUrl = `http://127.0.0.1:${APORT}`;
let fake: Awaited<ReturnType<typeof startFake>>;
let mcp: Awaited<ReturnType<typeof startFakeMcp>>;
let dataDir = '';

class Client {
  cookie = '';
  async req(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', origin: base, cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    if (set) this.cookie = set;
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  }
  trpc(proc: string, input?: unknown, mutate = false) { return trpcCall((p, i) => fetch(base + p, i), this.cookie, proc, input, mutate, base); }
  login(email: string, password: string) { return this.req('/api/auth/sign-in/email', 'POST', { email, password }); }
}
const admin = new Client();
const worker = new Client();
const anon = new Client();

before(async () => {
  fake = await startFake();
  mcp = await startFakeMcp();
  dataDir = mkdtempSync(join(tmpdir(), 'hefyn-e2e-'));
  const env = { ...process.env, HEFYN_URL: base, NODE_ENV: 'production', HEFYN_SECRET: 'test-secret-test-secret-test-secret-1234', HEFYN_DATA_DIR: dataDir, HEFYN_INTERNAL_TOKEN: TOKEN, HEFYN_ALLOW_PRIVATE_URLS: '1' }; // fake upstreams listen on 127.0.0.1
  const spawnAgent = () => {
    agent = spawn('bun', ['src/agent.ts'], { env: { ...env, PORT: String(APORT), HEFYN_DRAIN_TIMEOUT_MS: '5000' }, stdio: 'ignore' });
    agent.on('exit', () => { if (!stopping) setTimeout(spawnAgent, 300); });
  };
  spawnAgent();
  server = spawn('bun', ['src/web.ts'], { env: { ...env, PORT: String(PORT), HEFYN_AGENT_URL: agentUrl }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    server.stdout!.on('data', (d) => String(d).includes('listening') && ok());
    server.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  await agentReady();
});
after(() => { stopping = true; server?.kill(); agent?.kill(); fake?.close(); mcp?.close(); });

const agentReady = async () => { for (let i = 0; i < 100 && !(await fetch(agentUrl).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100)); };
const until = async (what: string, f: () => Promise<boolean>, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await f()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const runtime = async () => (await admin.trpc('runtime.info')).json;
const back = () => until('agent running again', async () => { const r = await runtime(); return r.state === 'running' && r.agentUp; });

test('setup creates the Admin exactly once', async () => {
  assert.equal((await anon.trpc('setup.status')).json.needsSetup, true);
  assert.equal((await anon.trpc('setup.create', { name: 'Ada', email: 'ada@x.test', password: 'password-1' }, true)).status, 200);
  assert.equal((await anon.trpc('setup.create', { name: 'Eve', email: 'eve@x.test', password: 'password-2' }, true)).status, 409);
  assert.equal((await anon.req('/api/auth/sign-up/email', 'POST', { name: 'Eve', email: 'eve@x.test', password: 'password-2' })).status, 403);
  assert.equal((await admin.login('ada@x.test', 'password-1')).status, 200);
  const me = (await admin.req('/api/me')).json;
  assert.equal(me.role, 'Admin');
  const core = (await import('../src/server/permissions.ts')).PERMISSIONS; // the core's own; the modules' (projects.*) are added by the registry in the server
  assert.ok(core.every((p) => me.permissions.includes(p)) && me.permissions.includes('projects.share') && me.permissions.includes('projects.manage_team')); // Admin gets every permission (permissions.ts)
});

test('requirePermission denies Worker on admin routes; unauthenticated gets 401', async () => {
  assert.equal((await admin.trpc('users.create', { email: 'bob@x.test', password: 'password-3' }, true)).status, 200);
  assert.equal((await worker.login('bob@x.test', 'password-3')).status, 200);
  assert.equal((await worker.req('/api/me')).json.passwordChangeRequired, true); // the admin chose this password: bob picks his own first
  assert.equal((await worker.req('/api/auth/change-password', 'POST', { currentPassword: 'password-3', newPassword: 'password-3-own' })).status, 200);
  assert.equal((await worker.req('/api/me')).json.role, 'Worker');
  for (const p of ['users.list', 'usage.all', 'models.providers']) assert.equal((await worker.trpc(p)).status, 403, p);
  assert.equal((await worker.trpc('roles.list')).status, 403);
  assert.equal((await worker.trpc('roles.create', { name: 'x', permissions: [] }, true)).status, 403);
  assert.equal((await anon.trpc('roles.list')).status, 401);
  assert.equal((await anon.trpc('users.list')).status, 401);
  assert.equal((await worker.trpc('usage.me')).status, 200);
});

test('roles: custom role CRUD, built-ins protected, last Admin protected', async () => {
  const created = await admin.trpc('roles.create', { name: 'Auditor', permissions: ['usage.view_all'] }, true);
  assert.equal(created.status, 200);
  assert.equal((await admin.trpc('roles.update', { id: created.json.id, name: 'Auditors' }, true)).status, 200);
  assert.equal((await admin.trpc('roles.update', { id: 'admin', permissions: [] }, true)).status, 409);
  assert.equal((await admin.trpc('roles.delete', { id: 'admin' }, true)).status, 409);
  const bad = await admin.trpc('roles.create', { name: 'Bad', permissions: ['nope'] }, true);
  assert.equal(bad.status, 400);
  assert.match(bad.error!, /^permissions\.0: /); // zod failures read "path: message"
  assert.equal((await fetch(`${base}/api/trpc/roles.delete`, { headers: { cookie: admin.cookie } })).status, 405); // mutations are POST only
  assert.equal((await fetch(`${base}/api/trpc/roles.delete`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const users = (await admin.trpc('users.list')).json;
  const ada = users.find((u: any) => u.email === 'ada@x.test');
  assert.equal((await admin.trpc('users.setRole', { id: ada.id, roleId: 'worker' }, true)).status, 409);
  const bob = users.find((u: any) => u.email === 'bob@x.test');
  assert.equal((await admin.trpc('users.setRole', { id: bob.id, roleId: created.json.id }, true)).status, 200);
  assert.equal((await worker.trpc('usage.all')).status, 200); // bob now holds usage.view_all
  assert.equal((await admin.trpc('roles.delete', { id: created.json.id }, true)).status, 200);
  assert.equal((await worker.req('/api/me')).json.role, 'Worker'); // members fall back to Worker
});

test('connect a provider at runtime, pick models, chat; conversation prefix enforced; usage recorded for delegated calls', async () => {
  assert.equal((await admin.trpc('models.connect', { provider: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url }, true)).status, 200);
  assert.deepEqual((await admin.trpc('models.providers')).json.connected.map((c: any) => [c.id, c.kind, c.status]), [['anthropic', 'api_key', 'ok']]);
  const put = await admin.trpc('profile.update', { model: 'anthropic/claude-opus-5-5', agents: { writer: 'anthropic/claude-sonnet-5-5', explorer: null } }, true);
  assert.equal(put.status, 200);

  const { id } = (await admin.trpc('conversations.create', { title: 'fruit' }, true)).json;
  const url = `/agents/configurable/${id}`;
  const msg = { kind: 'user', body: 'Ask the writer for a haiku' };
  assert.equal((await anon.req(url, 'POST', msg)).status, 401);
  assert.equal((await worker.req(url, 'POST', msg)).status, 403); // someone else's conversation
  assert.equal((await admin.req('/agents/configurable/u_someoneelse_01', 'POST', msg)).status, 403);
  assert.equal((await admin.req(url, 'POST', msg)).status, 202);

  for (let i = 0; i < 40; i++) { // wait for the submission to settle
    const h = (await admin.req(url)).json;
    if (h.settlements?.length) { assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements)); break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const { perModel, perDay } = (await admin.trpc('usage.all')).json;
  const byModel = Object.fromEntries(perModel.map((r: any) => [r.key, r]));
  assert.equal(byModel['anthropic/claude-opus-5-5'].calls, 2, JSON.stringify(perModel)); // orchestrator: delegate + answer
  assert.equal(byModel['anthropic/claude-sonnet-5-5'].calls, 1, JSON.stringify(perModel)); // the delegated writer
  assert.ok(byModel['anthropic/claude-sonnet-5-5'].cost > 0 && perDay[0].input === 300);
  assert.ok(requests.some((r) => r.model === 'claude-sonnet-5-5' && r.system.includes('How to write a haiku')));
  assert.equal((await admin.trpc('usage.me')).json.perDay[0].calls, 3);
  // At rest: the conversation is sealed in flue.db (read here without the user's key), yet the API returns it in clear.
  const rest = new DatabaseSync(join(dataDir, 'flue.db'), { readOnly: true });
  const dump = ['flue_agent_submissions', 'flue_conversation_stream_batches'].map((t) => JSON.stringify(rest.prepare(`SELECT * FROM ${t}`).all())).join('\n');
  rest.close();
  assert.ok(dump.includes('hx1:') && !dump.includes('haiku'), 'flue.db holds chat content in clear');
  assert.ok(JSON.stringify((await admin.req(url)).json).includes('haiku'));
});

const EMAIL = 'ada.lovelace@example.com';
// Fake keys, split so secret scanners don't flag them.
const KEY = 'sk-ant-' + 'api03-UserSideSecret9876543210zyxwvuTSR';
const TOOL_KEY = 'sk-ant-' + 'api03-ToolSideSecret0123456789abcdefXYZ';
const settle = async (url: string, tries = 80, c: Client = admin) => {
  let h: any;
  for (let i = 0; i < tries; i++) {
    h = (await c.req(url)).json;
    if (h.settlements?.length) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('submission never settled: ' + JSON.stringify(h).slice(0, 1500));
};

test('a turn with tools: the model gets the request as it is, the tools run, usage is recorded', async () => {
  const { id } = (await admin.trpc('conversations.create', { title: 'pii' }, true)).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: `NOTETEST Mail ${EMAIL} using key ${KEY}` })).status, 202);
  const h = await settle(url);
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));

  const sent = requests.slice(from);
  assert.ok(sent.length >= 2);
  assert.ok(sent[0].raw.includes(EMAIL) && sent[0].raw.includes(KEY), 'the user text reaches the model unchanged');
  assert.ok(sent.at(-1)!.raw.includes(TOOL_KEY), 'so does the tool result');

  const history = JSON.stringify(h);
  assert.ok(history.includes(`${EMAIL} ${TOOL_KEY}`), 'the read tool returned what the write tool stored');
  assert.ok(history.includes(`sent it to ${EMAIL}`));

  const appDb = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
  try { assert.ok((appDb.prepare('SELECT COUNT(*) AS n FROM usage WHERE conversation_id = ?').get(id) as { n: number }).n >= 1, 'usage is recorded'); } finally { appDb.close(); }
});

test('internal token: the agent service rejects anything but the web proxy', async () => {
  const path = '/agents/configurable/u_x_01';
  assert.equal((await fetch(agentUrl + path)).status, 401);
  assert.equal((await fetch(agentUrl + path, { headers: { 'x-hefyn-internal': 'wrong' } })).status, 401);
  assert.notEqual((await fetch(agentUrl + path, { headers: { 'x-hefyn-internal': TOKEN } })).status, 401);
  assert.equal((await anon.req(path)).status, 401); // the web side still demands a session
});

test('only the configurable agent is reachable from the browser', async () => {
  const { id } = (await admin.trpc('conversations.create', { title: 'n' }, true)).json;
  assert.equal((await admin.req(`/agents/step/${id}`, 'POST', { kind: 'user', body: 'hi' })).status, 403);
  assert.equal((await admin.req(`/agents/builder/${id}`, 'POST', { kind: 'user', body: 'hi' })).status, 403);
});

const raw = (c: Client, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: 'manual', headers: { origin: base, cookie: c.cookie, ...(init.headers as object) } });
const upload = (c: Client, path: string, name: string, content: string) => { const f = new FormData(); f.append('file', new File([content], name)); return raw(c, path, { method: 'POST', body: f }); };
const chat = async (c: Client, text: string, title = 'chat') => {
  const { id } = (await c.trpc('conversations.create', { title }, true)).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await c.req(url, 'POST', { kind: 'user', body: text })).status, 202);
  const h = await settle(url, 80, c);
  return { id, h, sent: requests.slice(from), history: JSON.stringify(h) };
};

test('storage: delegated agent writes /files, the parent reads it; files API and attachments', async () => {
  const adminId = (await admin.req('/api/me')).json.id;
  const { id, h, sent } = await chat(admin, 'FILETEST go');
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.equal(readFileSync(join(dataDir, 'users', adminId, 'files', 'x.txt'), 'utf8'), 'hello-from-writer');
  assert.ok(sent.at(-1)!.raw.includes('hello-from-writer'), 'the parent read the delegate\'s file');
  assert.ok((await admin.trpc('files.list', { path: '/' })).json.entries.some((e: any) => e.name === 'x.txt'));
  assert.equal(await (await raw(admin, '/api/files/download?path=/x.txt')).text(), 'hello-from-writer');
  assert.equal((await worker.trpc('files.list', { path: '/' })).json.entries.length, 0); // other users see nothing
  assert.equal((await anon.trpc('files.list', { path: '/' })).status, 401);
  assert.equal((await admin.trpc('files.mkdir', { path: 'sub/dir' }, true)).status, 200);
  assert.equal((await admin.trpc('files.rename', { from: 'sub/dir', to: 'sub/dir2' }, true)).status, 200);
  assert.equal((await admin.trpc('files.rename', { from: 'sub/dir2', to: '../x' }, true)).status, 403);
  assert.equal((await admin.trpc('files.delete', { path: 'sub' }, true)).status, 200);
  assert.equal((await admin.trpc('files.list', { path: 'sub' })).status, 404);
  assert.ok((await admin.trpc('files.usage')).json.used > 0);
  assert.equal((await admin.trpc('folders.rename', { id: 'nope', name: 'x' }, true)).status, 404);
  const fo = (await admin.trpc('folders.create', { name: 'Top' }, true)).json, sub = (await admin.trpc('folders.create', { name: 'Sub', parentId: fo.id }, true)).json;
  assert.equal((await admin.trpc('folders.move', { id: sub.id, parentId: null }, true)).json.parentId, null);
  assert.equal((await admin.trpc('folders.rename', { id: sub.id, name: 'Sub2' }, true)).json.name, 'Sub2');
  assert.equal((await worker.trpc('folders.delete', { id: fo.id }, true)).status, 404); // not theirs
  assert.equal((await admin.trpc('folders.delete', { id: fo.id, mode: 'delete' }, true)).status, 200);
  assert.equal((await admin.trpc('folders.delete', { id: sub.id }, true)).status, 200);

  const att = await (await upload(admin, `/api/conversations/${id}/attachments`, 'report.txt', 'quarterly')).json() as any;
  assert.deepEqual(att.saved.map((s: any) => [s.name, s.path, s.size]), [['report.txt', '/tmp/report.txt', 9]]);
  assert.ok(existsSync(join(dataDir, 'users', adminId, 'tmp', id, 'report.txt')));
  assert.equal((await upload(worker, `/api/conversations/${id}/attachments`, 'x.txt', 'no')).status, 403);
});

test('per-user providers: isolation, model per conversation, enforced where requests leave the server', async () => {
  const adminId = (await admin.req('/api/me')).json.id;
  const bobId = (await worker.req('/api/me')).json.id;
  assert.equal((await worker.trpc('connectors.models.connect', { provider: 'anthropic', apiKey: 'sk-bob-own', baseUrl: fake.url }, true)).status, 200);
  const own = (c: Client) => c.trpc('models.available').then((r) => r.json.filter((m: any) => m.scope === 'own'));
  assert.deepEqual((await worker.trpc('models.available')).json, []); // models are the admin's choice (Assistants carry them): no picker data for a worker
  assert.equal((await own(admin)).length, 0);
  assert.deepEqual((await worker.trpc('connectors.models.list')).json.map((c: any) => [c.provider, c.kind, c.status]), [['anthropic', 'api_key', 'ok']]);
  const model = `u-${bobId}-anthropic/claude-opus-5-5`;

  // bob cannot pick a model; a chat that carries his own (as chats did before Assistants) still sends the orchestrator's request with his key (the sub-agents stay on the company model)
  const conv = (await worker.trpc('conversations.create', { title: 'mine' }, true)).json.id;
  assert.equal((await worker.trpc('conversations.update', { id: conv, model }, true)).status, 403);
  const appDb = new DatabaseSync(join(dataDir, 'app.db'));
  appDb.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model, conv);
  appDb.close();
  const from = requests.length;
  assert.equal((await worker.req(`/agents/configurable/${conv}`, 'POST', { kind: 'user', body: 'hello' })).status, 202);
  assert.equal((await settle(`/agents/configurable/${conv}`, 80, worker)).settlements[0].outcome, 'completed');
  const orchestrator = requests.slice(from).filter((r) => r.model === 'claude-opus-5-5'); // his model; the delegate (sonnet) uses the company key
  assert.ok(orchestrator.length > 0 && orchestrator.every((r) => r.key === 'sk-bob-own'), 'sent with the user\'s own key');
  assert.ok(requests.slice(from).filter((r) => r.model === 'claude-sonnet-5-5').every((r) => r.key !== 'sk-bob-own'));

  // the admin cannot choose it ...
  const mine = (await admin.trpc('conversations.create', { title: 'x' }, true)).json.id;
  assert.equal((await admin.trpc('conversations.update', { id: mine, model }, true)).status, 403);
  assert.equal((await admin.trpc('conversations.update', { id: conv, model: null }, true)).status, 403); // nor touch his conversation
  assert.ok(adminId !== bobId);
  assert.equal((await worker.trpc('connectors.models.disconnect', { provider: 'anthropic' }, true)).status, 200);
});

test('assistants: a chat runs on its Assistant (instructions, model, skill); a worker never picks a model and is held to the Assistant\'s upload limit', async () => {
  const opts = (await admin.trpc('assistants.options')).json;
  const opus = opts.models.hefyn.find((m: any) => m.id.endsWith('claude-opus-5-5')).id;
  const inputs = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 1 };
  const made = await admin.trpc('assistants.save', { name: 'Pirate', description: 'Talks like a pirate', icon: 'anchor', agent: null, model: opus, thinking: null, instructions: 'You are a PIRATEBOT. Answer briefly.', skills: [], inputs, roles: [] }, true);
  assert.equal(made.status, 200, String(made.error));
  assert.ok((await worker.trpc('assistants.list')).json.some((a: any) => a.id === made.json.id && a.available));

  const conv = (await worker.trpc('conversations.create', { title: 'arr', assistantId: made.json.id }, true)).json;
  assert.equal(conv.assistantId, made.json.id);
  const from = requests.length;
  assert.equal((await worker.req(`/agents/configurable/${conv.id}`, 'POST', { kind: 'user', body: 'hello' })).status, 202);
  assert.equal((await settle(`/agents/configurable/${conv.id}`, 80, worker)).settlements[0].outcome, 'completed');
  const sent = requests.slice(from);
  assert.ok(sent.length > 0 && sent.every((r) => r.model === 'claude-opus-5-5' && r.system.includes('PIRATEBOT') && !r.system.includes('You orchestrate')), 'the Assistant\'s model and instructions, not the default\'s');
  const plain = (await chat(worker, 'hello again')).sent; // no assistantId: the default Assistant (General) as before
  assert.ok(plain.some((r) => r.system.includes('You orchestrate')) && plain.every((r) => !r.system.includes('PIRATEBOT')));

  assert.equal((await worker.trpc('conversations.update', { id: conv.id, model: opus }, true)).status, 403);
  assert.equal((await upload(worker, `/api/conversations/${conv.id}/attachments`, 'big.txt', 'x'.repeat(1.5 * 1048576))).status, 413);
  assert.equal((await upload(worker, `/api/conversations/${conv.id}/attachments`, 'small.txt', 'fine')).status, 200);
});

test('MCP connector with a bearer token: tools mounted, the tool output reaches the model', async () => {
  const made = await admin.trpc('connectors.mcp.create', { name: 'Contacts', url: mcp.url + '/mcp', auth: 'bearer', bearer: 'bearer-ok' }, true);
  assert.equal(made.status, 200);
  const item = (await admin.trpc('connectors.mcp.list')).json.find((m: any) => m.id === made.json.id);
  assert.deepEqual(Object.keys(item).sort(), ['auth', 'connected', 'id', 'mine', 'name', 'sharedAccount', 'transport', 'url', 'visibility']);
  assert.equal((await worker.trpc('connectors.mcp.list')).json.length, 0); // private
  assert.deepEqual((await admin.trpc('connectors.mcp.test', { id: made.json.id }, true)).json, { ok: true, tools: ['lookup'] });
  assert.equal((await worker.trpc('connectors.mcp.test', { id: made.json.id }, true)).json.ok, false);

  const { h, sent, history } = await chat(admin, 'MCPTEST look him up');
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(history.includes('mcp-person@acme-corp.example'), 'the tool ran and its real output is in the history');
  assert.ok(sent.at(-1)!.raw.includes('mcp-person@acme-corp.example'), 'MCP output reached the model');
  assert.ok(seen.some((s) => s.auth === 'Bearer bearer-ok'));
  assert.equal((await worker.trpc('connectors.mcp.delete', { id: made.json.id }, true)).status, 403);
  assert.equal((await admin.trpc('connectors.mcp.delete', { id: made.json.id }, true)).status, 200);
});

test('MCP connector with OAuth: discovery, dynamic registration, PKCE, single-use state, refresh', async () => {
  mcpOauth.expiresIn = 30; // inside the 60 s refresh margin: the next use refreshes
  const made = (await admin.trpc('connectors.mcp.create', { name: 'Secured', url: mcp.url + '/mcp', auth: 'oauth', visibility: 'team' }, true)).json.id;
  assert.equal((await worker.trpc('connectors.mcp.list')).json[0].connected, false); // team connectors are visible to everyone
  const { authUrl } = (await admin.trpc('connectors.mcp.oauthStart', { id: made }, true)).json;
  assert.ok(authUrl.includes('code_challenge=') && authUrl.includes('code_challenge_method=S256'));
  assert.equal(mcpOauth.registered, 1);
  const location = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location')!);
  assert.equal((await raw(worker, location.pathname + location.search)).status, 400); // someone else's callback
  const ok = await raw(admin, location.pathname + location.search);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Connected/);
  assert.match(ok.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.equal((await raw(admin, location.pathname + location.search)).status, 400); // state is single use
  assert.equal((await admin.trpc('connectors.mcp.list')).json.find((m: any) => m.id === made).connected, true);

  const { h, history } = await chat(admin, 'MCPTEST with oauth');
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(history.includes('mcp-person@acme-corp.example'));
  assert.ok(mcpOauth.refreshes >= 1 && seen.some((s) => s.auth === 'Bearer at-2'), 'the expiring token was refreshed before use');
  // Team connector, per-user tokens: the worker is not signed in, so the agent does not use the admin's token.
  const bobItem = () => worker.trpc('connectors.mcp.list').then((r) => r.json.find((m: any) => m.id === made));
  assert.equal((await bobItem()).connected, false);
  assert.equal((await bobItem()).sharedAccount, false);
  const adminTokens = new Set(seen.map((s) => s.auth));
  const before = seen.length;
  const bobNo = await chat(worker, 'MCPTEST as bob');
  assert.equal(seen.length, before, 'no request reached the MCP server with anyone\'s token');
  assert.ok(!bobNo.history.includes('mcp-person@acme-corp.example'));
  // bob signs in for himself
  const b = (await worker.trpc('connectors.mcp.oauthStart', { id: made }, true)).json;
  const loc = new URL((await fetch(b.authUrl, { redirect: 'manual' })).headers.get('location')!);
  assert.equal((await raw(worker, loc.pathname + loc.search)).status, 200);
  assert.equal((await bobItem()).connected, true);
  const bobYes = await chat(worker, 'MCPTEST as bob again');
  assert.ok(bobYes.history.includes('mcp-person@acme-corp.example'));
  const used = seen.slice(before).map((s) => s.auth).filter((a) => a.startsWith('Bearer at-'));
  assert.ok(used.length > 0 && used.every((a) => !adminTokens.has(a)), 'bob\'s own token, never the admin\'s');
  assert.equal((await admin.trpc('connectors.mcp.delete', { id: made }, true)).status, 200);
});

test('MCP team connector with a bearer token is an explicit shared account', async () => {
  const id = (await admin.trpc('connectors.mcp.create', { name: 'Shared', url: mcp.url + '/mcp', auth: 'bearer', bearer: 'bearer-ok', visibility: 'team' }, true)).json.id;
  for (const c of [admin, worker]) {
    const m = (await c.trpc('connectors.mcp.list')).json.find((x: any) => x.id === id);
    assert.deepEqual([m.sharedAccount, m.connected], [true, true]);
  }
  assert.equal((await worker.trpc('connectors.mcp.setBearer', { id, bearer: 'x' }, true)).status, 403); // only team editors replace it
  assert.equal((await admin.trpc('connectors.mcp.setBearer', { id, bearer: 'bearer-ok' }, true)).status, 200);
  const bob = await chat(worker, 'MCPTEST shared');
  assert.ok(bob.history.includes('mcp-person@acme-corp.example'));
  assert.equal((await admin.trpc('connectors.mcp.delete', { id }, true)).status, 200);
});

test('hub over HTTP: permission matrix', async () => {
  const mk = (c: Client, name: string, extra: object = {}) => c.trpc('hub.create', { kind: 'skill', name, description: name + ' skill', instructions: 'Always say arr', ...extra }, true);
  const priv = (await mk(admin, 'pirate-speak')).json.id;
  assert.equal((await worker.trpc('hub.get', { id: priv })).status, 404); // someone else's private package
  assert.equal((await worker.trpc('hub.approve', { id: priv }, true)).status, 403); // needs hub.approve
  const mine = (await mk(worker, 'bobs-skill')).json.id;
  assert.equal((await worker.trpc('hub.publish', { id: mine }, true)).status, 403); // needs hub.publish
  const team = (await mk(admin, 'team-skill')).json.id;
  assert.equal((await admin.trpc('hub.publish', { id: team }, true)).json.status, 'approved'); // reviewers publish directly
  assert.equal((await worker.trpc('hub.install', { id: team, target: 'team' }, true)).status, 403); // needs profiles.edit_team
  assert.equal((await anon.trpc('hub.list')).status, 401);
  assert.equal((await worker.trpc('hub.review')).status, 403);
  assert.ok((await worker.trpc('hub.list')).json.some((p: any) => p.id === team) && !(await worker.trpc('hub.list')).json.some((p: any) => p.id === priv));
});

test('hub installs reach the agent: skills and delegable agents, team vs own', async () => {
  const hubAgent = await admin.trpc('hub.create', { kind: 'agent', name: 'hub-helper', description: 'Helps with hub things', instructions: 'HUB-AGENT-INSTRUCTIONS', skills: [] }, true);
  assert.equal(hubAgent.status, 200, JSON.stringify(hubAgent.json));
  const list = (await admin.trpc('hub.list', { mine: true })).json;
  const idOf = (n: string) => list.find((p: any) => p.name === n).id;
  assert.equal((await admin.trpc('hub.install', { id: hubAgent.json.id, target: 'me' }, true)).status, 200);
  assert.equal((await admin.trpc('hub.install', { id: idOf('pirate-speak'), target: 'me' }, true)).status, 200);

  const mineRun = await chat(admin, 'HUBTEST please');
  assert.equal(mineRun.h.settlements[0].outcome, 'completed', JSON.stringify(mineRun.h.settlements));
  assert.ok(mineRun.sent[0].system.includes('pirate-speak') && mineRun.sent[0].system.includes('hub-helper'), 'skill and agent are in the catalogs');
  assert.ok(mineRun.sent.some((r) => r.system.includes('HUB-AGENT-INSTRUCTIONS')), 'the hub agent was delegated to and ran');

  const bob = await chat(worker, 'HUBTEST please'); // did not install anything
  assert.ok(bob.sent.every((r) => !r.system.includes('pirate-speak') && !r.system.includes('hub-helper')));

  // installed for the team: everyone gets it
  assert.equal((await admin.trpc('hub.install', { id: idOf('team-skill'), target: 'team' }, true)).status, 200);
  const bob2 = await chat(worker, 'hello again');
  assert.ok(bob2.sent[0].system.includes('team-skill'));
  assert.ok(!bob2.sent[0].system.includes('pirate-speak'));
});

test('hub MCP install creates connector entries that need sign-in; uninstall removes them', async () => {
  const pkg = (await admin.trpc('hub.create', { kind: 'mcp', name: 'hubmcp', url: mcp.url + '/mcp', transport: 'streamable-http', auth: 'bearer' }, true)).json.id;
  assert.equal((await admin.trpc('hub.install', { id: pkg, target: 'me' }, true)).status, 200);
  const find = async (c: Client) => (await c.trpc('connectors.mcp.list')).json.find((m: any) => m.name === 'hubmcp');
  const mine = await find(admin);
  assert.deepEqual([mine.mine, mine.visibility, mine.auth, mine.connected], [true, 'private', 'bearer', false]); // sign-in needed
  assert.equal(await find(worker), undefined);
  assert.equal((await worker.trpc('connectors.mcp.setBearer', { id: mine.id, bearer: 'x' }, true)).status, 403);
  assert.equal((await admin.trpc('connectors.mcp.setBearer', { id: mine.id, bearer: 'bearer-ok' }, true)).status, 200);
  assert.equal((await find(admin)).connected, true);
  assert.deepEqual((await admin.trpc('connectors.mcp.test', { id: mine.id }, true)).json, { ok: true, tools: ['lookup'] });
  assert.equal((await admin.trpc('hub.uninstall', { id: pkg, target: 'me' }, true)).status, 200);
  assert.equal(await find(admin), undefined);

  // team install (reviewer publishes, then installs): one team connector everyone sees, owned by the installer
  assert.equal((await admin.trpc('hub.publish', { id: pkg }, true)).json.status, 'approved');
  assert.equal((await admin.trpc('hub.install', { id: pkg, target: 'team' }, true)).status, 200);
  assert.equal((await find(worker)).visibility, 'team');
  assert.equal((await admin.trpc('hub.uninstall', { id: pkg, target: 'team' }, true)).status, 200);
  assert.equal(await find(worker), undefined);
});

test('sandbox.shell is Admin-only; the Playwright connector is a built-in entry that needs mcp.run_managed and a runner', async () => {
  assert.ok((await admin.req('/api/me')).json.permissions.includes('sandbox.shell'));
  assert.ok(!(await worker.req('/api/me')).json.permissions.includes('sandbox.shell'));
  const pw = (await admin.trpc('connectors.mcp.list')).json.find((m: any) => m.id === 'builtin:playwright');
  assert.equal(pw.builtin, true); assert.equal(pw.enabled, false); assert.match(pw.note, /screenshots/i);
  assert.equal((await worker.trpc('connectors.mcp.list')).json.some((m: any) => m.builtin), false);
  assert.equal((await worker.trpc('connectors.mcp.setPlaywright', { enabled: true }, true)).status, 403);
  assert.equal((await admin.trpc('connectors.mcp.setPlaywright', { enabled: true }, true)).status, 409); // no runner configured in this test stack
  assert.equal((await admin.trpc('connectors.mcp.setPlaywright', { enabled: false }, true)).status, 200);
});

test('startup validation: placeholder or short secrets stop web with a one-line fix hint', async () => {
  const run = (env: Record<string, string>) => spawnSync('bun', ['src/web.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: '1', ...env }, encoding: 'utf8', timeout: 20000 });
  for (const bad of [{ HEFYN_SECRET: 'dev-only-secret-do-not-use-in-production', HEFYN_INTERNAL_TOKEN: TOKEN }, { HEFYN_SECRET: 'x'.repeat(40), HEFYN_INTERNAL_TOKEN: 'short' }, { HEFYN_SECRET: '', HEFYN_INTERNAL_TOKEN: TOKEN }]) {
    const r = run({ HEFYN_DATA_DIR: mkdtempSync(join(tmpdir(), 'hefyn-val-')), ...bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bun run init/);
  }
});

test('runtime info is open to signed-in users and carries no privacy block; restart is for admins', async () => {
  const rt = (await worker.trpc('runtime.info')).json;
  assert.equal(rt.state, 'running');
  assert.equal(rt.privacy, undefined);
  assert.equal((await worker.trpc('runtime.restart', undefined, true)).status, 403);
  assert.equal((await anon.trpc('runtime.info')).status, 401);
});

test('subscription sign-in: refused for everyone (closed 2026-10); the catalogue is labelled, sorted and deprecated', async () => {
  const cat = (await admin.trpc('connectors.models.providers')).json;
  assert.deepEqual(cat.oauth.slice(0, 5).map((p: any) => p.id), ['anthropic', 'openai', 'github-copilot', 'openrouter', 'xai']);
  assert.ok(cat.oauth.every((p: any) => p.name && p.description) && !cat.oauth.some((p: any) => p.id === 'radius'));
  assert.equal(cat.oauth.find((p: any) => p.id === 'openai-codex').name, 'OpenAI Codex (legacy)');
  assert.equal((await worker.trpc('connectors.oauth.start', { provider: 'anthropic', scope: 'company' }, true)).status, 403);
  assert.equal((await admin.trpc('connectors.oauth.start', { provider: 'anthropic', scope: 'planet' }, true)).status, 400);
  // new subscription sign-ins are closed (2026-10), personal and company alike; the catalogue says so
  const own = await worker.trpc('connectors.oauth.start', { provider: 'anthropic' }, true); // default scope: personal
  assert.equal(own.status, 403); assert.match(own.error!, /no longer offered/);
  assert.equal((await admin.trpc('connectors.oauth.start', { provider: 'anthropic', scope: 'company' }, true)).status, 403);
  assert.ok(cat.oauth.every((p: any) => p.deprecated === true));
});

test('restart queue: draining blocks new tasks while a running one completes, then the agent is back', async () => {
  const { id } = (await admin.trpc('conversations.create', { title: 'slow' }, true)).json;
  const url = `/agents/configurable/${id}`;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: 'SLOW2500 take your time' })).status, 202);
  await until('a running task', async () => (await runtime()).runningTasks > 0);
  assert.equal((await worker.trpc('runtime.restart', undefined, true)).status, 403);
  assert.equal((await admin.trpc('runtime.restart', undefined, true)).json.state, 'draining');
  const blocked = await admin.req(url, 'POST', { kind: 'user', body: 'one more' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.json.state, 'draining');
  assert.equal((await admin.req(url)).status, 200); // reads keep working
  const h = await settle(url);
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements)); // the running task was not cut off
  await until('restart', async () => (await runtime()).state !== 'draining');
  await back();
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: 'and again' })).status, 202);
  await until('second run', async () => (await admin.req(url)).json.settlements?.length > 1);
});

test('restart queue: removing a provider requests a restart', async () => {
  assert.equal((await admin.trpc('models.connect', { provider: 'openai', apiKey: 'sk-other', baseUrl: fake.url }, true)).status, 200);
  assert.equal((await runtime()).state, 'running');
  assert.equal((await admin.trpc('models.disconnect', { id: 'openai' }, true)).status, 200);
  const r = await runtime();
  assert.ok(['draining', 'restarting'].includes(r.state));
  assert.equal(r.requestedBy, 'system: provider removed');
  await back();
});

test('restart queue: a forced restart (drain timeout) resumes the interrupted task', async () => {
  const { id } = (await admin.trpc('conversations.create', { title: 'forced' }, true)).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: 'SLOW12000 very long' })).status, 202);
  await until('a running task', async () => (await runtime()).runningTasks > 0);
  const pid = agent.pid;
  await admin.trpc('runtime.restart', undefined, true);
  await until('forced restart', async () => agent.pid !== pid && agent.exitCode === null, 30000);
  await back();
  const h = await settle(url, 400); // Flue reclaims an interrupted submission once its 30 s lease expires
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(requests.length - from >= 2, 'the interrupted call was made again after the restart');
});

test('the first request after an agent restart reaches the model', async () => {
  agent.kill();
  await new Promise((r) => setTimeout(r, 500));
  await agentReady();
  const { id } = (await admin.trpc('conversations.create', { title: 'warm' }, true)).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: `Mail ${EMAIL}` })).status, 202);
  await settle(url);
  assert.ok(requests.length > from && requests.slice(from).some((r) => r.raw.includes(EMAIL)));
});

test('rate limiting uses the socket address: a spoofed X-Forwarded-For does not buy a fresh bucket', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `203.0.113.${i}` }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong-password' }) });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected the shared per-address bucket to trip, got ${statuses}`);
});
