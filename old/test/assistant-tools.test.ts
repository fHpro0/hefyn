import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// assistants.testStep (the pure steps; code in the sandbox is in cli-agent-test-step.test.ts), assistants.tools / tryTool and the "tools turned off" setting: stored with the Assistant,
// listed per agent step, and honoured where the agent process mounts tools (tool-filter.ts, mount.ts, cli-agents/mcp.ts). A tiny MCP server stands in for a connector.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-asstools-'));
process.env.HEFYN_SECRET = 'assistant-tools-secret-assistant-tools-12';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1'; // configured, never reachable
process.env.HEFYN_ALLOW_PRIVATE_URLS = '1'; // the stand-in connector listens on 127.0.0.1

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { connect } = await import('../src/server/providers.ts');
const { createConnector } = await import('../src/server/mcp.ts');
const { hideTools, offOf } = await import('../src/agents/tool-filter.ts');
const { withoutSandboxTools } = await import('../src/agents/mount.ts');
const { userSandboxFactory } = await import('../src/server/storage-sandbox.ts');
const { assistantTools } = await import('../src/cli-agents/mcp.ts');
await import('../src/server/hub.ts');
vault.setTeamKey(vault.newKey());
connect({ id: 'anthropic' }, 'sk-ant-company');

// ---- a connector with three tools ----
const calls: { name: string; args: unknown }[] = [];
const TOOLS = [
  { name: 'lookup', description: 'Look up a contact', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { who: { type: 'string', description: 'A name' }, limit: { type: 'integer' } }, required: ['who'] } },
  { name: 'big', description: 'Returns a lot', inputSchema: { type: 'object', properties: {} } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
];
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const m = JSON.parse(raw || '{}');
    if (m.id === undefined) return void res.writeHead(202).end();
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
    const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : m.method === 'tools/list' ? { tools: TOOLS }
      : m.method === 'tools/call' ? (calls.push({ name: m.params.name, args: m.params.arguments }), m.params.name === 'big' ? text('x'.repeat(100_000)) : m.params.name === 'boom' ? text('it broke', true) : text(JSON.stringify({ found: m.params.arguments.who })))
      : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

const app = new Hono().route('/api', api);
const PW = 'password-12345';
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  vault.rememberUserKey(r.user.id, vault.newKey());
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('plain', 'Plain', 0, ?)").run(JSON.stringify(['models.use']));
const admin = await mk('admin@x.test', 'admin'), worker = await mk('worker@x.test', 'worker'), plain = await mk('plain@x.test', 'plain');
const conn = createConnector(admin.id, { name: 'Contacts', url: mcpUrl });

const INPUTS = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 } as const;
const base = { name: 'Helper', description: 'Helps', icon: 'Sparkles', agent: null, model: null, thinking: null, instructions: 'Be kind.', skills: [] as string[], inputs: INPUTS, roles: [] as string[] };
const node = (id: string, type: string, config: Record<string, any> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const flowOf = (...mid: ReturnType<typeof node>[]) => ({ version: 1, nodes: [node('start', 'trigger.chat'), ...mid, node('reply', 'output.reply', { text: 'ok' })], edges: [] as unknown[] });
const names = (step: any) => step.groups.flatMap((g: any) => g.items.map((i: any) => i.id)) as string[];

// ---- testStep ----
test('testStep: a template renders against the sample input', async () => {
  const f = flowOf(node('greet', 'template', { text: 'Hi {{start.text}}, you said {{other.json.a.b}}!' }));
  const r = (await admin.trpc('assistants.testStep', { flow: f, nodeId: 'greet', input: { start: { text: 'Ann' }, other: { json: { a: { b: 7 } } } } }, true)).json;
  assert.equal(r.ok, true); assert.equal(r.output.text, 'Hi Ann, you said 7!'); assert.equal(typeof r.ms, 'number');
});

test('testStep: conditions and rule routers decide; a model router, an agent and a missing step say why they cannot be tried', async () => {
  const f = flowOf(node('big', 'condition', { op: 'gt', left: '{{start.text}}', right: '10' }),
    node('r', 'router', { mode: 'rules', branches: [{ id: 'urgent', label: 'Urgent', rule: { left: '{{start.text}}', op: 'contains', right: 'urgent' } }, { id: 'long', label: 'Long', rule: { left: '{{start.text}}', op: 'gt', right: '5' } }] }),
    node('ai', 'router', { mode: 'ai', branches: [] }), node('a', 'agent', { prompt: 'x' }), node('bad', 'condition', { op: 'matches', left: 'x', right: '(' }));
  const t = async (nodeId: string, text: string) => (await admin.trpc('assistants.testStep', { flow: f, nodeId, input: { start: { text } } }, true)).json;
  assert.deepEqual([(await t('big', '11')).output.json, (await t('big', '9')).output.json], [{ result: true }, { result: false }]);
  assert.equal((await t('r', 'This is URGENT')).output.json.branch, 'urgent');
  assert.equal((await t('r', '12')).output.json.branch, 'long');
  assert.equal((await t('r', 'no')).output.json.branch, 'else');
  const ai = await t('ai', 'x'); assert.equal(ai.ok, false); assert.match(ai.error, /only be tried inside a chat/);
  const ag = await t('a', 'x'); assert.equal(ag.ok, false); assert.match(ag.error, /can only be tried inside a chat/);
  assert.match((await t('bad', 'x')).error, /regular expression/);
  const none = await t('ghost', 'x'); assert.equal(none.ok, false); assert.match(none.error, /not in the flow/);
});

test('testStep: a code step needs the sandbox; permissions and ownership are checked; the sample may not be huge', async () => {
  const f = flowOf(node('c', 'code', { language: 'javascript', source: 'console.log(1)', timeoutSec: 600 }));
  const call = (who: typeof admin, body: object) => who.trpc('assistants.testStep', { flow: f, nodeId: 'c', input: { start: { text: 'x' } }, ...body }, true);
  const noShell = await call(worker, {});
  assert.equal(noShell.json.ok, false); assert.match(noShell.json.error, /cannot use the sandbox/);
  const down = await call(admin, {});
  assert.equal(down.json.ok, false); assert.match(down.json.error, /sandbox|runner/i, 'the unreachable runner is reported, not thrown');
  assert.equal((await call(plain, {})).status, 403, 'needs assistants.create');
  const mine = (await admin.trpc('assistants.save', { ...base, name: 'Mine', scope: 'private' }, true)).json.id;
  assert.equal((await call(worker, { id: mine })).status, 404, 'another person\'s Assistant is as if it did not exist');
  assert.equal((await call(admin, { id: mine })).json.ok, false);
  assert.equal((await call(admin, { input: { start: { text: 'x'.repeat(1_100_000) } } })).status, 400);
  assert.equal((await admin.trpc('assistants.testStep', { flow: 'nope', nodeId: 'c', input: {} }, true)).status, 400);
});

// ---- tools ----
test('tools: a simple Assistant lists the built-ins, the connector\'s tools with their schemas, and what a person without the sandbox gets', async () => {
  const r = (await admin.trpc('assistants.tools', {})).json;
  assert.equal(r.steps.length, 1); assert.equal(r.steps[0].node, 'agent'); assert.equal(r.steps[0].agentName, 'hefyn');
  const ids = names(r.steps[0]);
  for (const id of ['builtin:bash', 'builtin:read', 'builtin:write', `connector:${conn}:lookup`, `connector:${conn}:big`]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('builtin:list'), 'the file-only tool is for people without the sandbox');
  const lookup = r.steps[0].groups.find((g: any) => g.name === 'Contacts').items.find((i: any) => i.name === 'lookup');
  assert.deepEqual([lookup.enabled, lookup.tryable, lookup.readOnly, lookup.schema.required], [true, true, true, ['who']]);
  assert.equal(r.steps[0].on, r.steps[0].total);
  assert.deepEqual(r.disabled, []);
  const w = names((await worker.trpc('assistants.tools', {})).json.steps[0]);
  assert.ok(w.includes('builtin:list') && !w.includes('builtin:bash'), w.join());
  assert.ok(!w.some((x: string) => x.startsWith('connector:')), 'a worker does not see the admin\'s private connector');
  assert.equal((await plain.trpc('assistants.tools', {})).status, 403);
});

test('tools: flow steps are listed one by one; a CLI agent lists its own tools as a note, and Assistants only when it is the whole Assistant', async () => {
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '0.95.0', 'ready', 1, '[]', ?)").run(new Date().toISOString());
  const other = (await admin.trpc('assistants.save', { ...base, name: 'Other one', scope: 'team' }, true)).json.id;
  const simpleCli = (await admin.trpc('assistants.save', { ...base, name: 'Coder', agent: 'claude-acp', scope: 'team' }, true)).json.id;
  const r = (await admin.trpc('assistants.tools', { id: simpleCli })).json.steps[0];
  assert.equal(r.agentName, 'Claude Code'); assert.equal(r.groups[0].source, 'agent'); assert.match(r.groups[0].note, /own tools/);
  assert.ok(names(r).includes(`assistant:${other}`) && !names(r).includes(`assistant:${simpleCli}`), 'other Assistants, never itself');
  const flow = flowOf(node('one', 'agent', { agent: 'claude-acp', prompt: 'x', skills: ['sk_none'] }), node('two', 'agent', { agent: null, prompt: 'y', skills: [] }));
  const steps = (await admin.trpc('assistants.tools', { flow })).json.steps;
  assert.deepEqual(steps.map((s: any) => s.node), ['one', 'two']);
  assert.ok(names(steps[1]).includes('builtin:read'));
  assert.equal(steps[0].groups.find((g: any) => g.source === 'assistant').items.length, 0);
  assert.match(steps[0].groups.find((g: any) => g.source === 'assistant').note, /only step/);
  assert.ok(names(steps[0]).includes('skill:sk_none'), 'a step\'s skills can be switched too');
});

test('tools turned off are saved with the Assistant, validated, kept by the old-style save, and flagged in the list', async () => {
  const off = ['builtin:bash', `connector:${conn}:big`];
  const id = (await admin.trpc('assistants.save', { ...base, name: 'Strict', scope: 'private', tools: { disabled: off } }, true)).json.id;
  assert.deepEqual((await admin.trpc('assistants.get', { id })).json.tools, { disabled: off });
  assert.deepEqual((await admin.trpc('assistants.get', { id })).json.flow.tools, { disabled: off });
  const r = (await admin.trpc('assistants.tools', { id })).json;
  assert.deepEqual(r.disabled, off);
  const items = r.steps[0].groups.flatMap((g: any) => g.items);
  assert.equal(items.find((i: any) => i.id === 'builtin:bash').enabled, false);
  assert.equal(items.find((i: any) => i.id === 'builtin:read').enabled, true);
  assert.equal(r.steps[0].on, r.steps[0].total - 2);
  // the old fields (no flow, no tools) keep what was set; a saved flow carries its own; `tools` wins over the flow's
  await admin.trpc('assistants.save', { ...base, id, name: 'Strict', instructions: 'Changed.' }, true);
  assert.deepEqual((await admin.trpc('assistants.get', { id })).json.tools, { disabled: off });
  const flow = (await admin.trpc('assistants.get', { id })).json.flow;
  await admin.trpc('assistants.save', { ...base, id, flow: { ...flow, tools: { disabled: ['skill:a', 'skill:a'] } } }, true);
  assert.deepEqual((await admin.trpc('assistants.get', { id })).json.tools, { disabled: ['skill:a'] });
  await admin.trpc('assistants.save', { ...base, id, flow, tools: { disabled: [] } }, true);
  assert.deepEqual((await admin.trpc('assistants.get', { id })).json.tools, { disabled: [] });
  assert.equal((await admin.trpc('assistants.get', { id })).json.flow.tools, undefined, 'nothing off: no setting stored');
  for (const bad of [{ disabled: ['nonsense'] }, { disabled: [1] }, { disabled: 'x' }, { disabled: Array(501).fill('builtin:x') }]) {
    const e = await admin.trpc('assistants.save', { ...base, id, tools: bad }, true);
    assert.equal(e.status, 400, JSON.stringify(bad).slice(0, 40));
  }
});

// ---- trying a tool ----
test('tryTool: a connector tool runs as the caller; big results are cut; errors come back as errors', async () => {
  const t = (tool: string, args: object = {}, who = admin) => who.trpc('assistants.tryTool', { tool, args }, true);
  const ok = (await t(`connector:${conn}:lookup`, { who: 'Ann' })).json;
  assert.deepEqual([ok.ok, ok.result, typeof ok.ms], [true, { found: 'Ann' }, 'number']);
  assert.deepEqual(calls.at(-1), { name: 'lookup', args: { who: 'Ann' } });
  const big = (await t(`connector:${conn}:big`)).json;
  assert.equal(big.ok, true); assert.equal(big.truncated, true); assert.equal(big.result.length, 64 * 1024);
  const boom = (await t(`connector:${conn}:boom`)).json;
  assert.deepEqual([boom.ok, boom.error], [false, 'it broke']);
  assert.equal((await t(`connector:${conn}:lookup`, { who: 'x' }, worker)).json.ok, false, 'a connector the caller cannot see');
  assert.match((await t(`connector:${conn}:lookup`, { who: 'x' }, worker)).json.error, /not available/);
  assert.equal((await t('connector:nope:x', {}, admin)).json.ok, false);
  assert.equal((await t(`connector:${conn}:lookup`, {}, plain)).status, 403);
  assert.equal((await admin.trpc('assistants.tryTool', { tool: 'junk', args: {} }, true)).status, 400);
  assert.equal((await admin.trpc('assistants.tryTool', { tool: `connector:${conn}:lookup`, assistantId: 'a_nope' }, true)).status, 404);
});

test('tryTool: tools that write or run commands are not tried; reading is limited to /files', async () => {
  const t = (tool: string, args: object = {}) => admin.trpc('assistants.tryTool', { tool, args }, true).then((r) => r.json);
  for (const w of ['builtin:write', 'builtin:edit', 'builtin:bash', 'builtin:data_create', 'builtin:data_update']) {
    const r = await t(w, { path: '/files/x', content: 'y' });
    assert.equal(r.ok, false, w); assert.match(r.error, /cannot be tried here/);
  }
  assert.match((await t('builtin:read', { path: '/etc/passwd' })).error, /inside \/files/);
  assert.match((await t('builtin:read', { path: '/files/../etc/passwd' })).error, /inside \/files/);
  assert.equal((await t('skill:x')).ok, false);
  assert.equal((await t('builtin:nothing')).ok, false);
});

// ---- where the agent process honours it ----
const json = (r: Response) => r.json() as Promise<any>;
const rpc = (method: string, params: object, id = 1) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
test('hideTools: off tools leave the list (JSON and event-stream answers) and cannot be called; others pass untouched', async () => {
  const seen: string[] = [];
  const list = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } };
  const inner = (async (_u: unknown, init?: RequestInit) => {
    const m = JSON.parse(String(init?.body)); seen.push(m.method);
    if (m.method === 'tools/list' && (init?.headers as any)?.sse) return new Response(`event: message\ndata: ${JSON.stringify(list)}\n\n`, { headers: { 'content-type': 'text/event-stream', 'content-length': '999' } });
    if (m.method === 'tools/list') return new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ran ' + m.params.name }] } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const f = hideTools(inner, new Set(['b']));
  assert.deepEqual((await json(await f('http://x', rpc('tools/list', {})))).result.tools.map((t: any) => t.name), ['a', 'c']);
  const sse = await f('http://x', { ...rpc('tools/list', {}), headers: { sse: '1' } } as any);
  assert.match(await sse.text(), /^event: message\ndata: \{.*"tools":\[\{"name":"a"\},\{"name":"c"\}\]/);
  assert.equal((await json(await f('http://x', rpc('tools/call', { name: 'a' })))).result.content[0].text, 'ran a');
  const before = seen.length;
  const blocked = await json(await f('http://x', rpc('tools/call', { name: 'b' }, 7)));
  assert.equal(blocked.id, 7); assert.match(blocked.error.message, /turned off/);
  assert.equal(seen.length, before, 'the server is not even asked');
  assert.equal((await json(await f('http://x', rpc('ping', {})))).result.content[0].text, 'ran undefined');
});

test('the sandbox tools an Assistant turned off are not mounted', () => {
  const sandbox = {} as never;
  const names2 = (f: any) => f.tools(sandbox, { subagents: {} }).map((t: any) => t.name);
  assert.deepEqual(names2(withoutSandboxTools({ createSandbox: async () => ({}) as never }, new Set(['builtin:bash', 'builtin:write', 'skill:x']))).sort(), ['edit', 'glob', 'grep', 'read']);
  const all = userSandboxFactory({ userId: 'u', conversationId: 'c' });
  assert.deepEqual(names2(withoutSandboxTools(all, new Set(['builtin:list', 'builtin:edit']))), ['read', 'write']);
  assert.equal(withoutSandboxTools(all, new Set(['skill:x', `connector:${conn}:big`])), all, 'nothing of the sandbox off: the factory is untouched');
  assert.deepEqual([...offOf({ tools: { disabled: ['skill:a'] } })], ['skill:a']);
  assert.equal(offOf(undefined).size, 0);
});

test('a CLI agent is offered the Assistants as tools minus the ones turned off', async () => {
  const a = (await admin.trpc('assistants.save', { ...base, name: 'Sidekick A', scope: 'team' }, true)).json.id;
  const b = (await admin.trpc('assistants.save', { ...base, name: 'Sidekick B', scope: 'team' }, true)).json.id;
  const host = (await admin.trpc('assistants.save', { ...base, name: 'Host', agent: 'claude-acp', scope: 'team', tools: { disabled: [`assistant:${a}`] } }, true)).json.id;
  const conv = `u_${admin.id}_01ASSTOOLS`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, assistant_id, agent) VALUES (?,?,?,?,?, 'claude-acp')").run(conv, admin.id, 'x', new Date().toISOString(), host);
  const listed = (await assistantTools(admin.id, conv)).map((t) => t.assistant.id);
  assert.ok(listed.includes(b) && !listed.includes(a) && !listed.includes(host), listed.join());
  await admin.trpc('assistants.save', { ...base, id: host, name: 'Host', agent: 'claude-acp', tools: { disabled: [] } }, true);
  assert.ok((await assistantTools(admin.id, conv)).some((t) => t.assistant.id === a), 'back on');
});

test.after(() => server.close());
