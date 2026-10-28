import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Agent } from '@agentclientprotocol/sdk';
import { Hono } from 'hono';

// Assistants as mods of a hosted CLI agent (src/cli-agents/mcp.ts, docs/ASSISTANTS.md "In CLI agents"): the tool list per user, the manifest rule for the MCP address, the /commands written
// into the sandbox, and a tools/call against the conversation's model-socket handler running a flow end to end, including an approval answered through /answer. No Docker; the real
// Claude Code in a sandbox is in cli-agent-wrapper.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-climods-'));
process.env.HEFYN_SECRET = 'cli-mods-secret-cli-mods-secret-123456';
process.env.HEFYN_RUNNER_URL = 'http://runner.invalid:8790';

const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { CliHost } = await import('../src/cli-agents/host.ts');
const { FlowHost } = await import('../src/assistants/session.ts');
const { cliRoutes } = await import('../src/cli-agents/routes.ts');
const { assistantTools } = await import('../src/cli-agents/mcp.ts');
const { writeAssistant } = await import('../src/server/assistant-store.ts');
const { PROFILES, toolSeeds } = await import('../src/cli-agents/profiles.ts');
const { parseAgentManifest, AgentSpecError } = await import('../src/modules/agent-manifest.ts');

vault.setTeamKey(vault.newKey());
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('opencode', '1.19.4', 'ready', 1, '[]', ?)").run(new Date().toISOString()); // the ACP host path with a fake ACP agent: OpenCode (Claude Code runs in a PTY)
for (const u of ['alice', 'bob']) vault.rememberUserKey(u, vault.newKey());

type N = Record<string, any>;
const node = (id: string, type: string, config: N = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const edges = (l: [string, string, string?][]) => l.map(([from, to, port], i) => ({ id: `e${i}`, from, to, ...(port ? { port } : {}) }));
const ECHO = { version: 1 as const, nodes: [node('start', 'trigger.chat'), node('t', 'template', { text: 'Echo: {{start.text}}' }), node('r', 'output.reply', { text: '{{t.text}}' })], edges: edges([['start', 't'], ['t', 'r']]) };
const REFUND = { version: 1 as const, nodes: [node('start', 'trigger.chat'), node('ok', 'approval', { message: 'Refund {{start.text}}?', editable: false }), node('y', 'output.reply', { text: 'Refunded {{start.text}}' }), node('n', 'output.reply', { text: 'Declined' })], edges: edges([['start', 'ok'], ['ok', 'y', 'approved'], ['ok', 'n', 'rejected']]) };
const INPUTS = { images: 'off' as const, maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };
const make = (name: string, flow: typeof ECHO, o: { scope?: 'private' | 'team'; owner?: string; roles?: string[]; description?: string } = {}) =>
  writeAssistant({ name, description: o.description ?? `${name} description`, icon: 'Sparkles', inputs: INPUTS, roles: o.roles ?? [], flow, scope: o.scope ?? 'team', owner: o.owner ?? null }).id;

const triage = make('Support Triage', ECHO, { description: 'Sorts support mail' });
const triage2 = make('Support  triage!', ECHO); // the same slug
const refund = make('Refund', REFUND);
make('Finance Only', ECHO, { roles: ['r_finance'] }); // alice has no role: closed to her
const mine = make('My Notes', ECHO, { scope: 'private', owner: 'alice' });
make('Bobs Secret', ECHO, { scope: 'private', owner: 'bob' });
const archived = make('Old One', ECHO);
db.prepare('UPDATE profiles SET archived = 1 WHERE id = ?').run(archived);

let n = 0;
const newConv = (o: { userId?: string; assistant?: string | null; parent?: string | null } = {}) => {
  const userId = o.userId ?? 'alice', id = `u_${userId}_01MODS${String(++n).padStart(3, '0')}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view, assistant_id, parent_id) VALUES (?,?,?,?,?, 'chat', ?, ?)").run(id, userId, 'x', new Date().toISOString(), 'opencode', o.assistant ?? null, o.parent ?? null);
  return id;
};

test('the tool list: what the user may use, minus the chat\'s own Assistant, colliding slugs numbered, none for a flow step\'s hidden chat', async () => {
  const names = async (conv: string, userId = 'alice') => (await assistantTools(userId, conv)).map((t) => t.tool).sort();
  assert.deepEqual(await names(newConv()), ['assistant_my-notes', 'assistant_refund', 'assistant_support-triage', 'assistant_support-triage-2']);
  assert.deepEqual(await names(newConv({ assistant: triage })), ['assistant_my-notes', 'assistant_refund', 'assistant_support-triage'], 'the Assistant the chat runs under is left out (and the other one needs no number)');
  assert.deepEqual(await names(newConv({ userId: 'bob' }), 'bob'), ['assistant_bobs-secret', 'assistant_refund', 'assistant_support-triage', 'assistant_support-triage-2'], 'private ones are their owner\'s alone');
  const parent = newConv();
  assert.deepEqual(await names(newConv({ parent })), [], 'a flow step\'s hidden chat has no tools: a flow cannot reach itself through its own agent');
  const t = (await assistantTools('alice', newConv())).find((x) => x.assistant.id === triage)!;
  assert.deepEqual([t.slug, t.name, t.description], ['support-triage', 'Support Triage', 'Sorts support mail']);
});

test('the manifest: {{hefynMcpUrl}} is allowed in the mcp file only, and no other address is', () => {
  const base = { kind: 'agent', id: 'acme', name: 'Acme', description: 'x', distribution: { registry: 'acme' }, api: 'anthropic', asksBeforeActing: true, launch: { npm: { package: 'acme-acp', bin: 'acme-acp' } },
    terminal: { command: 'exec acme' }, config: { dir: '/tmp/.acme', instructionsFile: 'AGENTS.md', skillsDir: '/tmp/.acme/skills', mcpConfig: 'x' } };
  const mcp = { path: '/tmp/.acme/mcp.json', format: 'json-merge', content: { servers: { hefyn: { url: '{{hefynMcpUrl}}' } } } };
  assert.doesNotThrow(() => parseAgentManifest({ ...base, mcp }));
  const refused = (m: unknown, re: RegExp) => assert.throws(() => parseAgentManifest(m), (e: any) => e instanceof AgentSpecError && re.test(e.message));
  refused({ ...base, files: [mcp] }, /unknown placeholder \{\{hefynMcpUrl\}\}/);
  refused({ ...base, env: { ACME_NOTE: '{{hefynMcpUrl}}' } }, /unknown placeholder/);
  refused({ ...base, mcp: { ...mcp, content: { servers: { x: { url: 'https://evil.example/mcp' } } } } }, /network addresses are not allowed/);
  refused({ ...base, mcp: { ...mcp, when: 'assistant' } }, /every conversation/);
  refused({ ...base, config: { ...base.config, commandsDir: '/tmp/elsewhere/commands' } }, /commandsDir: must be a path under \/tmp\/\.acme/);
  // the built-in agents register hefyn (Pi has no MCP client)
  const seed = (id: string) => PROFILES[id]!.seed('http://127.0.0.1:47000');
  assert.deepEqual((seed('claude-acp').find((s: any) => s.json?.mcpServers) as any).json.mcpServers, { hefyn: { type: 'http', url: 'http://127.0.0.1:47000/mcp' } });
  assert.match((seed('codex-acp').find((s: any) => s.path === '/tmp/.codex/config.toml') as any).text, /\[model_providers\.hefyn\][\s\S]*\[mcp_servers\.hefyn\]\nurl = "http:\/\/127\.0\.0\.1:47000\/mcp"/);
  assert.deepEqual((seed('opencode').find((s: any) => s.path.endsWith('opencode.json') && s.json?.mcp) as any).json.mcp, { hefyn: { type: 'remote', url: 'http://127.0.0.1:47000/mcp', enabled: true } }); // a json-merge after the text file of the same path: seed.mjs merges it in
  assert.equal(PROFILES['pi-acp']!.hasMcp, undefined);
  assert.deepEqual(toolSeeds(PROFILES['pi-acp']!, [{ slug: 'a', tool: 'assistant_a', name: 'A', description: 'd' }], new Set(), true), [], 'nothing is written for an agent that cannot call the tool');
});

// ---- the sandbox side: a fake ACP agent and a recording model socket ----
const handlers = new Map<string, (r: Request) => Promise<Response>>(), seeded: any[][] = [];
const fakeAgent = (conn: AgentSideConnection): Agent => ({
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }), newSession: async () => ({ sessionId: '11111111-2222-3333-4444-555555555555' }), authenticate: async () => ({}), cancel: async () => {},
  prompt: async (p) => { await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } }); return { stopReason: 'end_turn' }; },
});
const attach = async () => {
  const toProc = new PassThrough(), fromProc = new PassThrough(), stream = Duplex.from({ readable: fromProc, writable: toProc } as any) as Duplex;
  new AgentSideConnection(fakeAgent, ndJsonStream(Writable.toWeb(fromProc) as any, Readable.toWeb(toProc) as any));
  stream.on('close', () => { toProc.destroy(); fromProc.destroy(); });
  return { stream, resize: async () => {} };
};
const listenModel = async (_u: string, c: string, handler: (r: Request) => Promise<Response>) => (handlers.set(c, handler), { close() { handlers.delete(c); } });
const seed = async (_u: string, _c: string, seeds: any[]) => void seeded.push(seeds);
const cli = new CliHost({ attach, listenModel, seed }, 3_600_000);
const flows = new FlowHost(cli, 3_600_000, 400); // a tool call gives up on a waiting person after 400 ms here
const app = new Hono().route('/agents/cli', cliRoutes(cli, flows));
const until = async (f: () => boolean, what: string, ms = 3000) => { for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), `timeout: ${what}`); };

/** What the agent in the sandbox does: JSON-RPC to /mcp on its model socket. A tools/call answers as an event stream; its last data line is the response. */
async function rpc(conv: string, method: string, params?: unknown, id: number | null = 1): Promise<any> {
  const res = await handlers.get(conv)!(new Request('http://127.0.0.1:47000/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === null ? {} : { id }) }) }));
  if (id === null) return res.status;
  const text = await res.text();
  return JSON.parse(res.headers.get('content-type')!.startsWith('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data: ')).at(-1)!.slice(6) : text);
}
const post = (conv: string, path: string, body: unknown) => app.request(`/agents/cli/${conv}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a CLI chat starts with the user\'s Assistants as /commands (marked, swept) and the MCP route on its socket', async () => {
  const conv = newConv();
  const events: any[] = [];
  cli.session('alice', conv).subscribe(0, (e) => events.push(e));
  cli.session('alice', conv).prompt('hello');
  await until(() => events.some((e) => e.update.hefyn === 'turn_end'), 'turn_end');
  const files = seeded.at(-1)!;
  assert.deepEqual(files[0], { path: '/tmp/.config/opencode/commands', sweep: true, files: true });
  const cmd = files.find((s) => s.path === '/tmp/.config/opencode/commands/support-triage.md');
  assert.match(cmd.text, /^---\ndescription: "Sorts support mail"\n/);
  assert.match(cmd.text, /<!-- hefyn-managed -->/);
  assert.match(cmd.text, /hefyn tool assistant_support-triage .*\$ARGUMENTS/);
  assert.ok(files.some((s) => s.path === '/tmp/.config/opencode/commands/support-triage-2.md') && !files.some((s) => /finance|bobs/.test(s.path)));
  // MCP over the socket's handler
  const init = await rpc(conv, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-06-18', 'hefyn']);
  assert.equal(await rpc(conv, 'notifications/initialized', undefined, null), 202);
  const list = (await rpc(conv, 'tools/list')).result.tools;
  assert.deepEqual(list.map((t: any) => t.name).sort(), ['assistant_my-notes', 'assistant_refund', 'assistant_support-triage', 'assistant_support-triage-2']);
  assert.deepEqual(list.find((t: any) => t.name === 'assistant_support-triage').inputSchema.required, ['message']);
  assert.equal((await rpc(conv, 'nope')).error.code, -32601);
  assert.equal((await handlers.get(conv)!(new Request('http://x/mcp'))).status, 405);
});

test('tools/call runs the flow as a run of the chat and returns the Reply', async () => {
  const conv = newConv(), events: any[] = [];
  cli.session('alice', conv).prompt('hello'); await until(() => handlers.has(conv), 'socket');
  cli.session('alice', conv).subscribe(0, (e) => events.push(e));
  const r = await rpc(conv, 'tools/call', { name: 'assistant_support-triage', arguments: { message: 'printer on fire' } }, 7);
  assert.deepEqual([r.id, r.result.isError, r.result.content], [7, undefined, [{ type: 'text', text: 'Echo: printer on fire' }]]);
  const kinds = events.map((e) => e.update.hefyn ?? e.update.sessionUpdate);
  assert.ok(kinds.includes('run_start') && kinds.includes('run_end'), kinds.join());
  assert.ok(!events.some((e) => e.update.sessionUpdate === 'agent_message_chunk' && e.update.runId), 'the reply is the tool result, not a chat message');
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'one sequence for the agent and the runs');
  const bad = await rpc(conv, 'tools/call', { name: 'assistant_support-triage', arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.equal((await rpc(conv, 'tools/call', { name: 'assistant_finance-only', arguments: { message: 'x' } })).result.isError, true, 'not in the user\'s list: refused');
});

test('an approval inside shows as a waiting event in the CLI chat and resumes through /answer', async () => {
  const conv = newConv(), events: any[] = [];
  cli.session('alice', conv).prompt('hello'); await until(() => handlers.has(conv), 'socket');
  cli.session('alice', conv).subscribe(0, (e) => events.push(e));
  const call = rpc(conv, 'tools/call', { name: 'assistant_refund', arguments: { message: 'order 42' } }, 9);
  await until(() => events.some((e) => e.update.hefyn === 'waiting'), 'waiting');
  const w = events.find((e) => e.update.hefyn === 'waiting').update;
  assert.deepEqual([w.kind, w.node, w.message, typeof w.runId], ['approval', 'ok', 'Refund order 42?', 'string']);
  assert.equal((await post(conv, '/answer', { runId: w.runId, node: 'ok', approved: 'maybe' })).status, 400, 'a mistyped answer leaves it open');
  assert.equal((await post(conv, '/answer', { runId: w.runId, node: 'ok', approved: true })).status, 202);
  const r = await call;
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'Refunded order 42' }]);
  assert.equal((await post(conv, '/answer', { runId: w.runId, node: 'ok', approved: true })).status, 404, 'answered once');
});

test('nobody answers: the call gives up with a plain message and the run is cancelled', async () => {
  const conv = newConv(), events: any[] = [];
  cli.session('alice', conv).prompt('hello'); await until(() => handlers.has(conv), 'socket');
  cli.session('alice', conv).subscribe(0, (e) => events.push(e));
  const r = await rpc(conv, 'tools/call', { name: 'assistant_refund', arguments: { message: 'order 43' } }, 3);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /waiting for a person to answer/);
  const end = events.find((e) => e.update.hefyn === 'run_end');
  assert.equal(end.update.status, 'cancelled');
  const run = db.prepare("SELECT status FROM assistant_runs WHERE conversation_id = ? ORDER BY started_at DESC").get(conv) as { status: string };
  assert.equal(run.status, 'cancelled');
});

test('the Assistants a CLI chat\'s agent runs are the user\'s alone: another user\'s chat cannot answer them', async () => {
  const conv = newConv(), events: any[] = [];
  cli.session('alice', conv).prompt('hello'); await until(() => handlers.has(conv), 'socket');
  cli.session('alice', conv).subscribe(0, (e) => events.push(e));
  const call = rpc(conv, 'tools/call', { name: 'assistant_refund', arguments: { message: 'order 44' } }, 4);
  await until(() => events.some((e) => e.update.hefyn === 'waiting'), 'waiting');
  const runId = events.find((e) => e.update.hefyn === 'waiting').update.runId;
  const other = newConv({ userId: 'bob' });
  assert.equal((await post(other, '/answer', { runId, node: 'ok', approved: true })).status, 404, 'the run belongs to another conversation');
  assert.equal((await post(conv, '/answer', { runId, node: 'ok', approved: false })).status, 202);
  assert.equal((await call).result.content[0].text, 'Declined');
});
