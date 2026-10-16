import assert from 'node:assert/strict';
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
const PORT = 3400 + Math.floor(Math.random() * 500);
const base = `http://localhost:${PORT}`;
let server: ChildProcess; // web service
let agent: ChildProcess; // agent service; respawned on exit like Docker's restart policy would
let stopping = false;
const APORT = PORT + 1200;
const TOKEN = 'test-internal-token-test-internal-token-1234'; // production validation wants 32+ characters
const agentUrl = `http://127.0.0.1:${APORT}`;
let redact: ChildProcess; // the real redact service (dist/redact-server.mjs), regex + entropy only (GLiNER off)
const RPORT = PORT + 600;
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
  login(email: string, password: string) { return this.req('/api/auth/sign-in/email', 'POST', { email, password }); }
}
const admin = new Client();
const worker = new Client();
const anon = new Client();

before(async () => {
  fake = await startFake();
  mcp = await startFakeMcp();
  redact = spawn('node', ['dist/redact-server.mjs'], { env: { ...process.env, HEFYN_REDACT_GLINER: 'off', PORT: String(RPORT), HEFYN_REDACT_HOST: '127.0.0.1', HEFYN_INTERNAL_TOKEN: TOKEN }, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${RPORT}/live`, { headers: { 'x-hefyn-internal': TOKEN } }).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  dataDir = mkdtempSync(join(tmpdir(), 'hefyn-e2e-'));
  const env = { ...process.env, HEFYN_URL: base, NODE_ENV: 'production', HEFYN_SECRET: 'test-secret-test-secret-test-secret-1234', HEFYN_DATA_DIR: dataDir, HEFYN_INTERNAL_TOKEN: TOKEN, HEFYN_ALLOW_PRIVATE_URLS: '1', HEFYN_ALLOW_NO_GLINER: '1', HEFYN_REDACT_GLINER: 'off', HEFYN_REDACT_URL: `http://127.0.0.1:${RPORT}` }; // fake upstreams listen on 127.0.0.1
  const spawnAgent = () => {
    agent = spawn('node', ['dist/server.mjs'], { env: { ...env, PORT: String(APORT), HEFYN_DRAIN_TIMEOUT_MS: '5000' }, stdio: 'ignore' });
    agent.on('exit', () => { if (!stopping) setTimeout(spawnAgent, 300); });
  };
  spawnAgent();
  server = spawn('node', ['dist/web-server.mjs'], { env: { ...env, PORT: String(PORT), HEFYN_AGENT_URL: agentUrl }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    server.stdout!.on('data', (d) => String(d).includes('listening') && ok());
    server.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  await agentReady();
});
after(() => { stopping = true; server?.kill(); agent?.kill(); redact?.kill(); fake?.close(); mcp?.close(); });

const agentReady = async () => { for (let i = 0; i < 100 && !(await fetch(agentUrl).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100)); };
const until = async (what: string, f: () => Promise<boolean>, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await f()) return;
  throw new Error(`timed out waiting for ${what}`);
};
const runtime = async () => (await admin.req('/api/runtime')).json;
const back = () => until('agent running again', async () => { const r = await runtime(); return r.state === 'running' && r.agentUp; });

test('setup creates the Admin exactly once', async () => {
  assert.equal((await anon.req('/api/setup/status')).json.needsSetup, true);
  assert.equal((await anon.req('/api/setup', 'POST', { name: 'Ada', email: 'ada@x.test', password: 'password-1' })).status, 200);
  assert.equal((await anon.req('/api/setup', 'POST', { name: 'Eve', email: 'eve@x.test', password: 'password-2' })).status, 409);
  assert.equal((await anon.req('/api/auth/sign-up/email', 'POST', { name: 'Eve', email: 'eve@x.test', password: 'password-2' })).status, 403);
  assert.equal((await admin.login('ada@x.test', 'password-1')).status, 200);
  const me = (await admin.req('/api/me')).json;
  assert.equal(me.role, 'Admin');
  assert.equal(me.permissions.length, 11);
});

test('requirePermission denies Worker on admin routes; unauthenticated gets 401', async () => {
  assert.equal((await admin.req('/api/users', 'POST', { email: 'bob@x.test', password: 'password-3' })).status, 200);
  assert.equal((await worker.login('bob@x.test', 'password-3')).status, 200);
  assert.equal((await worker.req('/api/me')).json.role, 'Worker');
  for (const [m, p] of [['GET', '/api/users'], ['GET', '/api/roles'], ['GET', '/api/usage/all'], ['GET', '/api/models/providers'], ['POST', '/api/roles']]) {
    assert.equal((await worker.req(p, m, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
  }
  assert.equal((await anon.req('/api/users')).status, 401);
  assert.equal((await worker.req('/api/usage/me')).status, 200);
});

test('roles: custom role CRUD, built-ins protected, last Admin protected', async () => {
  const created = await admin.req('/api/roles', 'POST', { name: 'Auditor', permissions: ['usage.view_all'] });
  assert.equal(created.status, 200);
  assert.equal((await admin.req(`/api/roles/${created.json.id}`, 'PATCH', { name: 'Auditors' })).status, 200);
  assert.equal((await admin.req('/api/roles/admin', 'PATCH', { permissions: [] })).status, 409);
  assert.equal((await admin.req('/api/roles/admin', 'DELETE')).status, 409);
  const users = (await admin.req('/api/users')).json;
  const ada = users.find((u: any) => u.email === 'ada@x.test');
  assert.equal((await admin.req(`/api/users/${ada.id}/role`, 'PATCH', { roleId: 'worker' })).status, 409);
  const bob = users.find((u: any) => u.email === 'bob@x.test');
  assert.equal((await admin.req(`/api/users/${bob.id}/role`, 'PATCH', { roleId: created.json.id })).status, 200);
  assert.equal((await worker.req('/api/usage/all')).status, 200); // bob now holds usage.view_all
  assert.equal((await admin.req(`/api/roles/${created.json.id}`, 'DELETE')).status, 200);
  assert.equal((await worker.req('/api/me')).json.role, 'Worker'); // members fall back to Worker
});

test('connect a provider at runtime, pick models, chat; conversation prefix enforced; usage recorded for delegated calls', async () => {
  assert.equal((await admin.req('/api/models/providers', 'POST', { provider: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url })).status, 200);
  assert.deepEqual((await admin.req('/api/models/providers')).json.connected.map((c: any) => [c.id, c.kind, c.status]), [['anthropic', 'api_key', 'ok']]);
  const put = await admin.req('/api/profile', 'PUT', { model: 'anthropic/claude-opus-5-5', agents: { writer: 'anthropic/claude-sonnet-5-5', explorer: null } });
  assert.equal(put.status, 200);

  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'fruit' })).json;
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
  const { perModel, perDay } = (await admin.req('/api/usage/all')).json;
  const byModel = Object.fromEntries(perModel.map((r: any) => [r.key, r]));
  assert.equal(byModel['anthropic/claude-opus-5-5'].calls, 2, JSON.stringify(perModel)); // orchestrator: delegate + answer
  assert.equal(byModel['anthropic/claude-sonnet-5-5'].calls, 1, JSON.stringify(perModel)); // the delegated writer
  assert.ok(byModel['anthropic/claude-sonnet-5-5'].cost > 0 && perDay[0].input === 300);
  assert.ok(requests.some((r) => r.model === 'claude-sonnet-5-5' && r.system.includes('How to write a haiku')));
  assert.equal((await admin.req('/api/usage/me')).json.perDay[0].calls, 3);
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

test('privacy: upstream only sees placeholders; tools and history see real values; audit shows what was sent', async () => {
  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'pii' })).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: `Mail ${EMAIL} using key ${KEY}` })).status, 202);
  const h = await settle(url);
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));

  const sent = requests.slice(from);
  assert.ok(sent.length >= 2);
  for (const r of sent) for (const secret of [EMAIL, KEY, TOOL_KEY]) assert.ok(!r.raw.includes(secret), `leaked ${secret}`);
  assert.ok(sent[0].raw.includes('{{var:EMAIL_1}}'));
  assert.ok(sent.at(-1)!.raw.includes('{{var:EMAIL_1}}')); // tool result and tool call were redacted on the way back

  const history = JSON.stringify(h);
  assert.ok(history.includes(`${EMAIL} ${TOOL_KEY}`), 'the read tool returned what the write tool stored: real values');
  assert.ok(history.includes(`sent it to ${EMAIL}`), 'assistant text restored');
  assert.ok(!history.includes('{{var:'), 'no placeholder reaches the history');

  const a = (await admin.req(`/api/conversations/${id}/audit`)).json;
  assert.equal(a.requests.length, sent.length);
  assert.ok(a.requests.every((r: any) => r.status === 'ok' && r.bytes > 0));
  assert.ok(a.requests.some((r: any) => r.findings.some((f: any) => f.label === 'EMAIL')));
  const payload = JSON.stringify(a.latest.payload);
  assert.ok(payload.includes('{{var:EMAIL_1}}') && !payload.includes(EMAIL) && !payload.includes(KEY));
  assert.equal((await worker.req(`/api/conversations/${id}/audit`)).status, 403);
  assert.ok(a.requests.some((r: any) => r.seals.includes('EMAIL_1')), 'audit rows list the placeholders they used');

  // seals: the user's own transcript can mark sealed spans; owner only, values of this conversation only, never cached
  const res = await raw(admin, `/api/conversations/${id}/seals`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const seals = await res.json() as any[];
  assert.deepEqual(seals.find((x) => x.name === 'EMAIL_1'), { name: 'EMAIL_1', label: 'EMAIL', value: EMAIL });
  assert.equal((await worker.req(`/api/conversations/${id}/seals`)).status, 404);
  assert.equal((await anon.req(`/api/conversations/${id}/seals`)).status, 401);
  const other = (await admin.req('/api/conversations', 'POST', { title: 'other' })).json.id;
  assert.deepEqual((await admin.req(`/api/conversations/${other}/seals`)).json, []);
});

test('internal token: the agent service rejects anything but the web proxy', async () => {
  const path = '/agents/configurable/u_x_01';
  assert.equal((await fetch(agentUrl + path)).status, 401);
  assert.equal((await fetch(agentUrl + path, { headers: { 'x-hefyn-internal': 'wrong' } })).status, 401);
  assert.notEqual((await fetch(agentUrl + path, { headers: { 'x-hefyn-internal': TOKEN } })).status, 401);
  assert.equal((await anon.req(path)).status, 401); // the web side still demands a session
});

const raw = (c: Client, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: 'manual', headers: { origin: base, cookie: c.cookie, ...(init.headers as object) } });
const upload = (c: Client, path: string, name: string, content: string) => { const f = new FormData(); f.append('file', new File([content], name)); return raw(c, path, { method: 'POST', body: f }); };
const chat = async (c: Client, text: string, title = 'chat') => {
  const { id } = (await c.req('/api/conversations', 'POST', { title })).json;
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
  assert.ok((await admin.req('/api/files?path=/')).json.entries.some((e: any) => e.name === 'x.txt'));
  assert.equal(await (await raw(admin, '/api/files/download?path=/x.txt')).text(), 'hello-from-writer');
  assert.equal((await worker.req('/api/files?path=/')).json.entries.length, 0); // other users see nothing
  assert.equal((await anon.req('/api/files?path=/')).status, 401);

  const att = await (await upload(admin, `/api/conversations/${id}/attachments`, 'report.txt', 'quarterly')).json() as any;
  assert.deepEqual(att.saved.map((s: any) => [s.name, s.path, s.size]), [['report.txt', '/tmp/report.txt', 9]]);
  assert.ok(existsSync(join(dataDir, 'users', adminId, 'tmp', id, 'report.txt')));
  assert.equal((await upload(worker, `/api/conversations/${id}/attachments`, 'x.txt', 'no')).status, 403);
});

test('per-user providers: isolation, model per conversation, enforced where requests leave the server', async () => {
  const adminId = (await admin.req('/api/me')).json.id;
  const bobId = (await worker.req('/api/me')).json.id;
  assert.equal((await worker.req('/api/connectors/models', 'POST', { provider: 'anthropic', apiKey: 'sk-bob-own', baseUrl: fake.url })).status, 200);
  const own = (c: Client) => c.req('/api/models/available').then((r) => r.json.filter((m: any) => m.scope === 'own'));
  const bobsModels = await own(worker);
  assert.ok(bobsModels.length > 0 && bobsModels.every((m: any) => m.id.startsWith(`u-${bobId}-anthropic/`) && m.label.includes('yours')));
  assert.equal((await own(admin)).length, 0);
  assert.deepEqual((await worker.req('/api/connectors/models')).json.map((c: any) => [c.provider, c.kind, c.status]), [['anthropic', 'api_key', 'ok']]);
  const model = bobsModels.find((m: any) => m.id.endsWith('claude-opus-5-5')).id;

  // bob picks it for a conversation and the request goes out with his key
  const conv = (await worker.req('/api/conversations', 'POST', { title: 'mine' })).json.id;
  assert.equal((await worker.req(`/api/conversations/${conv}`, 'PATCH', { model })).status, 200);
  assert.equal((await worker.req('/api/conversations')).json.find((c: any) => c.id === conv).model, model);
  const from = requests.length;
  assert.equal((await worker.req(`/agents/configurable/${conv}`, 'POST', { kind: 'user', body: 'hello' })).status, 202);
  assert.equal((await settle(`/agents/configurable/${conv}`, 80, worker)).settlements[0].outcome, 'completed');
  const orchestrator = requests.slice(from).filter((r) => r.model === 'claude-opus-5-5'); // delegates still use the company profile models
  assert.ok(orchestrator.length > 0 && orchestrator.every((r) => r.key === 'sk-bob-own'), 'sent with the user\'s own key');

  // the admin cannot choose it ...
  const mine = (await admin.req('/api/conversations', 'POST', { title: 'x' })).json.id;
  assert.equal((await admin.req(`/api/conversations/${mine}`, 'PATCH', { model })).status, 403);
  assert.equal((await admin.req(`/api/conversations/${conv}`, 'PATCH', { model: null })).status, 403); // nor touch his conversation
  // ... and even a tampered conversation row is refused when the request would leave the server
  const sdb = new DatabaseSync(join(dataDir, 'app.db'));
  sdb.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model, mine);
  sdb.close();
  const before = requests.length;
  assert.equal((await admin.req(`/agents/configurable/${mine}`, 'POST', { kind: 'user', body: 'sneaky' })).status, 202);
  const h = await settle(`/agents/configurable/${mine}`);
  assert.match(JSON.stringify(h), /Blocked: this model is not available to you/);
  assert.equal(requests.length, before);
  assert.ok((await admin.req(`/api/conversations/${mine}/audit`)).json.requests.every((r: any) => r.status === 'blocked'));
  assert.ok(adminId !== bobId);
  assert.equal((await worker.req('/api/connectors/models/anthropic', 'DELETE')).status, 200);
});

test('MCP connector with a bearer token: tools mounted, tool output redacted before the model sees it', async () => {
  const made = await admin.req('/api/connectors/mcp', 'POST', { name: 'Contacts', url: mcp.url + '/mcp', auth: 'bearer', bearer: 'bearer-ok' });
  assert.equal(made.status, 200);
  const item = (await admin.req('/api/connectors/mcp')).json.find((m: any) => m.id === made.json.id);
  assert.deepEqual(Object.keys(item).sort(), ['auth', 'connected', 'id', 'mine', 'name', 'sharedAccount', 'transport', 'url', 'visibility']);
  assert.equal((await worker.req('/api/connectors/mcp')).json.length, 0); // private
  assert.deepEqual((await admin.req(`/api/connectors/mcp/${made.json.id}/test`, 'POST')).json, { ok: true, tools: ['lookup'] });
  assert.equal((await worker.req(`/api/connectors/mcp/${made.json.id}/test`, 'POST')).json.ok, false);

  const { h, sent, history } = await chat(admin, 'MCPTEST look him up');
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(history.includes('mcp-person@acme-corp.example'), 'the tool ran and its real output is in the history');
  assert.ok(sent.every((r) => !r.raw.includes('mcp-person@acme-corp.example')), 'MCP output was redacted on the way to the model');
  assert.ok(sent.at(-1)!.raw.includes('{{var:EMAIL_'));
  assert.ok(seen.some((s) => s.auth === 'Bearer bearer-ok'));
  assert.equal((await worker.req(`/api/connectors/mcp/${made.json.id}`, 'DELETE')).status, 403);
  assert.equal((await admin.req(`/api/connectors/mcp/${made.json.id}`, 'DELETE')).status, 200);
});

test('MCP connector with OAuth: discovery, dynamic registration, PKCE, single-use state, refresh', async () => {
  mcpOauth.expiresIn = 30; // inside the 60 s refresh margin: the next use refreshes
  const made = (await admin.req('/api/connectors/mcp', 'POST', { name: 'Secured', url: mcp.url + '/mcp', auth: 'oauth', visibility: 'team' })).json.id;
  assert.equal((await worker.req('/api/connectors/mcp')).json[0].connected, false); // team connectors are visible to everyone
  const { authUrl } = (await admin.req(`/api/connectors/mcp/${made}/oauth/start`, 'POST')).json;
  assert.ok(authUrl.includes('code_challenge=') && authUrl.includes('code_challenge_method=S256'));
  assert.equal(mcpOauth.registered, 1);
  const location = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location')!);
  assert.equal((await raw(worker, location.pathname + location.search)).status, 400); // someone else's callback
  const ok = await raw(admin, location.pathname + location.search);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Connected/);
  assert.match(ok.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.equal((await raw(admin, location.pathname + location.search)).status, 400); // state is single use
  assert.equal((await admin.req('/api/connectors/mcp')).json.find((m: any) => m.id === made).connected, true);

  const { h, history } = await chat(admin, 'MCPTEST with oauth');
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(history.includes('mcp-person@acme-corp.example'));
  assert.ok(mcpOauth.refreshes >= 1 && seen.some((s) => s.auth === 'Bearer at-2'), 'the expiring token was refreshed before use');
  // Team connector, per-user tokens: the worker is not signed in, so the agent does not use the admin's token.
  const bobItem = () => worker.req('/api/connectors/mcp').then((r) => r.json.find((m: any) => m.id === made));
  assert.equal((await bobItem()).connected, false);
  assert.equal((await bobItem()).sharedAccount, false);
  const adminTokens = new Set(seen.map((s) => s.auth));
  const before = seen.length;
  const bobNo = await chat(worker, 'MCPTEST as bob');
  assert.equal(seen.length, before, 'no request reached the MCP server with anyone\'s token');
  assert.ok(!bobNo.history.includes('mcp-person@acme-corp.example'));
  // bob signs in for himself
  const b = (await worker.req(`/api/connectors/mcp/${made}/oauth/start`, 'POST')).json;
  const loc = new URL((await fetch(b.authUrl, { redirect: 'manual' })).headers.get('location')!);
  assert.equal((await raw(worker, loc.pathname + loc.search)).status, 200);
  assert.equal((await bobItem()).connected, true);
  const bobYes = await chat(worker, 'MCPTEST as bob again');
  assert.ok(bobYes.history.includes('mcp-person@acme-corp.example'));
  const used = seen.slice(before).map((s) => s.auth).filter((a) => a.startsWith('Bearer at-'));
  assert.ok(used.length > 0 && used.every((a) => !adminTokens.has(a)), 'bob\'s own token, never the admin\'s');
  assert.equal((await admin.req(`/api/connectors/mcp/${made}`, 'DELETE')).status, 200);
});

test('MCP team connector with a bearer token is an explicit shared account', async () => {
  const id = (await admin.req('/api/connectors/mcp', 'POST', { name: 'Shared', url: mcp.url + '/mcp', auth: 'bearer', bearer: 'bearer-ok', visibility: 'team' })).json.id;
  for (const c of [admin, worker]) {
    const m = (await c.req('/api/connectors/mcp')).json.find((x: any) => x.id === id);
    assert.deepEqual([m.sharedAccount, m.connected], [true, true]);
  }
  assert.equal((await worker.req(`/api/connectors/mcp/${id}/bearer`, 'PUT', { bearer: 'x' })).status, 403); // only team editors replace it
  assert.equal((await admin.req(`/api/connectors/mcp/${id}/bearer`, 'PUT', { bearer: 'bearer-ok' })).status, 200);
  const bob = await chat(worker, 'MCPTEST shared');
  assert.ok(bob.history.includes('mcp-person@acme-corp.example'));
  assert.equal((await admin.req(`/api/connectors/mcp/${id}`, 'DELETE')).status, 200);
});

test('hub over HTTP: permission matrix', async () => {
  const mk = (c: Client, name: string, extra: object = {}) => c.req('/api/hub/packages', 'POST', { kind: 'skill', name, description: name + ' skill', instructions: 'Always say arr', ...extra });
  const priv = (await mk(admin, 'pirate-speak')).json.id;
  assert.equal((await worker.req(`/api/hub/packages/${priv}`)).status, 404); // someone else's private package
  assert.equal((await worker.req(`/api/hub/packages/${priv}/approve`, 'POST')).status, 403); // needs hub.approve
  const mine = (await mk(worker, 'bobs-skill')).json.id;
  assert.equal((await worker.req(`/api/hub/packages/${mine}/publish`, 'POST')).status, 403); // needs hub.publish
  const team = (await mk(admin, 'team-skill')).json.id;
  assert.equal((await admin.req(`/api/hub/packages/${team}/publish`, 'POST')).json.status, 'approved'); // reviewers publish directly
  assert.equal((await worker.req(`/api/hub/packages/${team}/install`, 'POST', { target: 'team' })).status, 403); // needs profiles.edit_team
  assert.equal((await anon.req('/api/hub/packages')).status, 401);
  assert.equal((await worker.req('/api/hub/review')).status, 403);
  assert.ok((await worker.req('/api/hub/packages')).json.some((p: any) => p.id === team) && !(await worker.req('/api/hub/packages')).json.some((p: any) => p.id === priv));
});

test('hub installs reach the agent: skills and delegable agents, team vs own', async () => {
  const hubAgent = await admin.req('/api/hub/packages', 'POST', { kind: 'agent', name: 'hub-helper', description: 'Helps with hub things', instructions: 'HUB-AGENT-INSTRUCTIONS', skills: [] });
  assert.equal(hubAgent.status, 200, JSON.stringify(hubAgent.json));
  const list = (await admin.req('/api/hub/packages?mine=1')).json;
  const idOf = (n: string) => list.find((p: any) => p.name === n).id;
  assert.equal((await admin.req(`/api/hub/packages/${hubAgent.json.id}/install`, 'POST', { target: 'me' })).status, 200);
  assert.equal((await admin.req(`/api/hub/packages/${idOf('pirate-speak')}/install`, 'POST', { target: 'me' })).status, 200);

  const mineRun = await chat(admin, 'HUBTEST please');
  assert.equal(mineRun.h.settlements[0].outcome, 'completed', JSON.stringify(mineRun.h.settlements));
  assert.ok(mineRun.sent[0].system.includes('pirate-speak') && mineRun.sent[0].system.includes('hub-helper'), 'skill and agent are in the catalogs');
  assert.ok(mineRun.sent.some((r) => r.system.includes('HUB-AGENT-INSTRUCTIONS')), 'the hub agent was delegated to and ran');

  const bob = await chat(worker, 'HUBTEST please'); // did not install anything
  assert.ok(bob.sent.every((r) => !r.system.includes('pirate-speak') && !r.system.includes('hub-helper')));

  // installed for the team: everyone gets it
  assert.equal((await admin.req(`/api/hub/packages/${idOf('team-skill')}/install`, 'POST', { target: 'team' })).status, 200);
  const bob2 = await chat(worker, 'hello again');
  assert.ok(bob2.sent[0].system.includes('team-skill'));
  assert.ok(!bob2.sent[0].system.includes('pirate-speak'));
});

test('hub MCP install creates connector entries that need sign-in; uninstall removes them', async () => {
  const pkg = (await admin.req('/api/hub/packages', 'POST', { kind: 'mcp', name: 'hubmcp', url: mcp.url + '/mcp', transport: 'streamable-http', auth: 'bearer' })).json.id;
  assert.equal((await admin.req(`/api/hub/packages/${pkg}/install`, 'POST', { target: 'me' })).status, 200);
  const find = async (c: Client) => (await c.req('/api/connectors/mcp')).json.find((m: any) => m.name === 'hubmcp');
  const mine = await find(admin);
  assert.deepEqual([mine.mine, mine.visibility, mine.auth, mine.connected], [true, 'private', 'bearer', false]); // sign-in needed
  assert.equal(await find(worker), undefined);
  assert.equal((await worker.req(`/api/connectors/mcp/${mine.id}/bearer`, 'PUT', { bearer: 'x' })).status, 403);
  assert.equal((await admin.req(`/api/connectors/mcp/${mine.id}/bearer`, 'PUT', { bearer: 'bearer-ok' })).status, 200);
  assert.equal((await find(admin)).connected, true);
  assert.deepEqual((await admin.req(`/api/connectors/mcp/${mine.id}/test`, 'POST')).json, { ok: true, tools: ['lookup'] });
  assert.equal((await admin.req(`/api/hub/packages/${pkg}/install?target=me`, 'DELETE')).status, 200);
  assert.equal(await find(admin), undefined);

  // team install (reviewer publishes, then installs): one team connector everyone sees, owned by the installer
  assert.equal((await admin.req(`/api/hub/packages/${pkg}/publish`, 'POST')).json.status, 'approved');
  assert.equal((await admin.req(`/api/hub/packages/${pkg}/install`, 'POST', { target: 'team' })).status, 200);
  assert.equal((await find(worker)).visibility, 'team');
  assert.equal((await admin.req(`/api/hub/packages/${pkg}/install?target=team`, 'DELETE')).status, 200);
  assert.equal(await find(worker), undefined);
});

test('sandbox.shell is Admin-only; the Playwright connector is a built-in entry that needs mcp.run_managed and a runner', async () => {
  assert.ok((await admin.req('/api/me')).json.permissions.includes('sandbox.shell'));
  assert.ok(!(await worker.req('/api/me')).json.permissions.includes('sandbox.shell'));
  const pw = (await admin.req('/api/connectors/mcp')).json.find((m: any) => m.id === 'builtin:playwright');
  assert.equal(pw.builtin, true); assert.equal(pw.enabled, false); assert.match(pw.note, /screenshots/i);
  assert.equal((await worker.req('/api/connectors/mcp')).json.some((m: any) => m.builtin), false);
  assert.equal((await worker.req('/api/connectors/mcp/builtin:playwright/enable', 'POST')).status, 403);
  assert.equal((await admin.req('/api/connectors/mcp/builtin:playwright/enable', 'POST')).status, 409); // no runner configured in this test stack
  assert.equal((await admin.req('/api/connectors/mcp/builtin:playwright/disable', 'POST')).status, 200);
});

test('startup validation: placeholder or short secrets stop web with a one-line fix hint', async () => {
  const run = (env: Record<string, string>) => spawnSync('node', ['dist/web-server.mjs'], { env: { ...process.env, NODE_ENV: 'production', PORT: '1', ...env }, encoding: 'utf8', timeout: 20000 });
  for (const bad of [{ HEFYN_SECRET: 'dev-only-secret-do-not-use-in-production', HEFYN_INTERNAL_TOKEN: TOKEN }, { HEFYN_SECRET: 'x'.repeat(40), HEFYN_INTERNAL_TOKEN: 'short' }, { HEFYN_SECRET: '', HEFYN_INTERNAL_TOKEN: TOKEN }]) {
    const r = run({ HEFYN_DATA_DIR: mkdtempSync(join(tmpdir(), 'hefyn-val-')), ...bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bun run init/);
  }
});

test('privacy status and settings: GLiNER flag in /api/runtime, images off by default, admin-only toggle', async () => {
  const rt = (await admin.req('/api/runtime')).json;
  assert.deepEqual(Object.keys(rt.privacy).sort(), ['gliner', 'glinerDetail', 'glinerSource', 'glinerState', 'imagesAllowed']);
  assert.deepEqual([rt.privacy.glinerSource, rt.privacy.glinerState], ['huggingface', 'missing']); // GLiNER switched off in this test stack
  // model upload: admin only, and only with source `local` (here: huggingface)
  assert.equal((await anon.req('/api/settings/privacy/gliner/upload', 'POST', {})).status, 401);
  assert.equal((await worker.req('/api/settings/privacy/gliner/upload', 'POST', {})).status, 403);
  assert.equal((await admin.req('/api/settings/privacy/gliner/upload', 'POST', {})).status, 409);
  assert.equal(rt.privacy.gliner, false); // the test sidecar runs with GLiNER off (HEFYN_ALLOW_NO_GLINER=1): the UI shows the red warning
  assert.equal(rt.privacy.imagesAllowed, false);
  assert.equal((await worker.req('/api/settings/privacy', 'POST', { allowImages: true })).status, 403);
  assert.equal((await admin.req('/api/settings/privacy', 'POST', { allowImages: 'yes' })).status, 400);
  assert.equal((await admin.req('/api/settings/privacy', 'POST', { allowImages: true })).json.allowImages, true);
  assert.equal((await admin.req('/api/runtime')).json.privacy.imagesAllowed, true);
  assert.equal((await admin.req('/api/settings/privacy', 'POST', { allowImages: false })).json.allowImages, false);
});

test('company-scope sign-in: only models.manage may start it; the catalogue is labelled and sorted', async () => {
  const cat = (await admin.req('/api/connectors/models/providers')).json;
  assert.deepEqual(cat.oauth.slice(0, 5).map((p: any) => p.id), ['anthropic', 'openai', 'github-copilot', 'openrouter', 'xai']);
  assert.ok(cat.oauth.every((p: any) => p.name && p.description) && !cat.oauth.some((p: any) => p.id === 'radius'));
  assert.equal(cat.oauth.find((p: any) => p.id === 'openai-codex').name, 'OpenAI Codex (legacy)');
  assert.equal((await worker.req('/api/connectors/oauth/anthropic/start', 'POST', { scope: 'company' })).status, 403);
  assert.equal((await admin.req('/api/connectors/oauth/anthropic/start', 'POST', { scope: 'planet' })).status, 400);
  const own = await worker.req('/api/connectors/oauth/anthropic/start', 'POST', {}); // default scope: personal
  assert.equal(own.status, 200);
  assert.match(own.json.authUrl, /claude\.ai/);
  const co = await admin.req('/api/connectors/oauth/anthropic/start', 'POST', { scope: 'company' });
  assert.equal(co.status, 200);
  assert.equal((await admin.req(`/api/connectors/oauth/${co.json.flowId}/status`)).json.state, 'pending');
});

test('restart queue: draining blocks new tasks while a running one completes, then the agent is back', async () => {
  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'slow' })).json;
  const url = `/agents/configurable/${id}`;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: 'SLOW2500 take your time' })).status, 202);
  await until('a running task', async () => (await runtime()).runningTasks > 0);
  assert.equal((await worker.req('/api/runtime/restart', 'POST')).status, 403);
  assert.equal((await admin.req('/api/runtime/restart', 'POST')).json.state, 'draining');
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
  assert.equal((await admin.req('/api/models/providers', 'POST', { provider: 'openai', apiKey: 'sk-other', baseUrl: fake.url })).status, 200);
  assert.equal((await runtime()).state, 'running');
  assert.equal((await admin.req('/api/models/providers/openai', 'DELETE')).status, 200);
  const r = await runtime();
  assert.ok(['draining', 'restarting'].includes(r.state));
  assert.equal(r.requestedBy, 'system: provider removed');
  await back();
});

test('restart queue: a forced restart (drain timeout) resumes the interrupted task', async () => {
  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'forced' })).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: 'SLOW12000 very long' })).status, 202);
  await until('a running task', async () => (await runtime()).runningTasks > 0);
  const pid = agent.pid;
  await admin.req('/api/runtime/restart', 'POST');
  await until('forced restart', async () => agent.pid !== pid && agent.exitCode === null, 30000);
  await back();
  const h = await settle(url, 400); // Flue reclaims an interrupted submission once its 30 s lease expires
  assert.equal(h.settlements[0].outcome, 'completed', JSON.stringify(h.settlements));
  assert.ok(requests.length - from >= 2, 'the interrupted call was made again after the restart');
});

test('the redact service stays warm when the agent restarts (same process), and the first request after the restart is redacted', async () => {
  const health = () => fetch(`http://127.0.0.1:${RPORT}/health`, { headers: { 'x-hefyn-internal': TOKEN } }).then((r) => r.json());
  const before = await health();
  agent.kill();
  await new Promise((r) => setTimeout(r, 500));
  await agentReady();
  const after = await health();
  assert.equal(after.pid, before.pid);
  assert.equal(after.startedAt, before.startedAt);
  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'warm' })).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: `Mail ${EMAIL}` })).status, 202);
  await settle(url);
  assert.ok(requests.length > from && requests.slice(from).every((r) => !r.raw.includes(EMAIL)));
});

test('privacy: sidecar down fails closed, nothing reaches the upstream', async () => {
  redact.kill();
  await new Promise((r) => setTimeout(r, 300));
  const { id } = (await admin.req('/api/conversations', 'POST', { title: 'down' })).json;
  const url = `/agents/configurable/${id}`;
  const from = requests.length;
  assert.equal((await admin.req(url, 'POST', { kind: 'user', body: `Mail ${EMAIL}` })).status, 202);
  const h = await settle(url);
  assert.equal(requests.length, from);
  assert.match(JSON.stringify(h), /Blocked by the privacy layer: the redaction service is (unreachable|not ready)/);
  const a = (await admin.req(`/api/conversations/${id}/audit`)).json;
  assert.ok(a.requests.length >= 1 && a.requests.every((r: any) => r.status === 'blocked'));
  assert.equal(a.latest, null);
});

test('rate limiting uses the socket address: a spoofed X-Forwarded-For does not buy a fresh bucket', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `203.0.113.${i}` }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong-password' }) });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected the shared per-address bucket to trip, got ${statuses}`);
});
