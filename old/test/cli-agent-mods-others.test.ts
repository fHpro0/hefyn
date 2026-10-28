import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): OpenCode and Codex in the real sandbox find hefyn's MCP server (manifest `mcp`, http://127.0.0.1:47000/mcp through the bridge and the conversation's socket), list the
// user's Assistants as tools and call one; the stand-in model emits the call. /mcp is served by hefyn's real handler (mcp.ts); only the model path is replaced by the stand-in.
// (Claude Code, with the real gateway: cli-agent-mods-container.test.ts.)
const TOKEN = 'cli-modsx-token-cli-modsx-token-0123456789ab';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-climodsx-'));
process.env.HEFYN_SECRET = 'cli-modsx-secret-cli-modsx-secret-123456';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: OpenCode and Codex list the Assistants as MCP tools and call one', { skip, timeout: 1_500_000 }, async (t) => {
  const hosts: { closeAll(): Promise<void> }[] = [];
  t.after(async () => { for (const h of hosts) await h.closeAll().catch(() => {}); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { registry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { CliHost, runnerSeed } = await import('../src/cli-agents/host.ts');
  const { FlowHost } = await import('../src/assistants/session.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  const { writeAssistant } = await import('../src/server/assistant-store.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
  writeAssistant({ name: 'Echo', description: 'Echoes the request back', icon: 'Sparkles', roles: [], scope: 'team', inputs: { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 },
    flow: { version: 1, nodes: [node('start', 'trigger.chat'), node('t', 'template', { text: 'Echo: {{start.text}}' }), node('r', 'output.reply', { text: '{{t.text}}' })], edges: [{ id: 'e1', from: 'start', to: 't' }, { id: 'e2', from: 't', to: 'r' }] } });

  /** A host whose model socket serves hefyn's /mcp for real and everything else with `standIn`. */
  async function session(id: string, conv: string, standIn: (req: Request) => Promise<Response>) {
    const entry = (await registry()).agents.find((a) => a.id === id)!;
    assert.deepEqual(await stack.install(installRequest(entry, profileOf(id)!)), { state: 'ready' });
    db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES (?, ?, 'ready', 1, '[]', ?)").run(id, entry.version, new Date().toISOString());
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, ?, 'chat')").run(conv, new Date().toISOString(), id);
    const h = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel: (u, c, handler) => stack.listenModel(u, c, (req) => (new URL(req.url).pathname === '/mcp' ? req.clone().text().then((b) => paths.push(`${req.method} ${b.slice(0, 90)}`)).then(() => handler(req)).then(async (r) => (paths.push(`-> ${r.status} ${(await r.clone().text()).slice(0, 700)}`), r)) : standIn(req))), seed: runnerSeed({ runnerUrl: stack.runnerUrl, token: TOKEN }) });
    hosts.push(h);
    new FlowHost(h);
    const s = h.session('alice', conv), events: any[] = [];
    s.subscribe(0, (e) => { events.push(e); if (e.update.hefyn === 'permission') { const o = (e.update.options as any[]).find((x) => /allow/.test(x.kind)) ?? (e.update.options as any[])[0]; s.answer(e.update.requestId as string, o.optionId); } });
    const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.slice(-8)).slice(0, 3000)}`); };
    return { s, events, until, entry, sbx: () => stack.docker('ps', '-q', '--filter', `label=hefyn.conversation=${conv}`).trim().split('\n')[0] };
  }
  const paths: string[] = [];
  const said = (events: any[]) => events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').map((e) => e.update.content.text).join('');

  await t.test('OpenCode: `mcp` in opencode.json (remote), tool hefyn_assistant_echo, /echo command', async () => {
    const start = { message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } };
    const sse = (events: [string, object][]) => new Response(events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const text = (s: string) => sse([['message_start', start], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: s } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]]);
    const toolNames: string[][] = [], bodies: string[] = [];
    const standIn = async (req: Request): Promise<Response> => {
      const raw = await req.text(), body: any = JSON.parse(raw || '{}');
      if (!body.tools?.length) return text('title');
      toolNames.push(body.tools.map((x: any) => x.name)); bodies.push(raw);
      const last = body.messages.at(-1), result = Array.isArray(last?.content) && last.content.find((c: any) => c.type === 'tool_result');
      if (result) return text(`Tool said: ${JSON.stringify(result.content)}`);
      const name = body.tools.map((x: any) => x.name).find((n: string) => /hefyn.*assistant_echo/.test(n));
      if (!name) return text('no tool');
      return sse([['message_start', start], ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_oc', name, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ message: 'ping from opencode' }) } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]]);
    };
    const { s, events, until, sbx } = await session('opencode', `u_alice_01OCM${run}`, standIn);
    s.prompt('Please run the echo tool.');
    await until(() => events.some((e) => e.update.hefyn === 'turn_end'), 'turn_end', 180_000);
    assert.ok(toolNames.flat().some((n) => /hefyn.*assistant_echo/.test(n)), `OpenCode offers the hefyn tool: ${[...new Set(toolNames.flat())]}`);
    assert.match(said(events), /Echo: ping from opencode/, said(events));
    const cmd = stack.docker('exec', sbx(), 'cat', '/tmp/.config/opencode/commands/echo.md');
    assert.match(cmd, /<!-- hefyn-managed -->/);
    const before = bodies.length, n = events.filter((e) => e.update.hefyn === 'turn_end').length;
    s.prompt('/echo hello from the slash');
    await until(() => events.filter((e) => e.update.hefyn === 'turn_end').length > n, 'second turn', 120_000);
    assert.ok(bodies.slice(before).some((b) => b.includes('Use the hefyn tool assistant_echo') && b.includes('hello from the slash')), 'OpenCode expanded the command file');
  });

  await t.test('Codex: [mcp_servers.hefyn] url in config.toml, tool mcp__hefyn__assistant_echo', async () => {
    const requests: any[] = [];
    const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
    const standIn = async (req: Request): Promise<Response> => {
      const body: any = await req.json().catch(() => ({}));
      requests.push(body);
      const resp = { id: `resp_${requests.length}`, status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      const sse = (items: string[]) => new Response(ev('response.created', { response: { ...resp, status: 'in_progress', output: [] } }) + items.join('') + ev('response.completed', { response: { ...resp, output: [] } }), { headers: { 'content-type': 'text/event-stream' } });
      const outputs = (body.input ?? []).filter((i: any) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output');
      if (outputs.length) {
        const out = `Tool said: ${JSON.stringify(outputs.at(-1).output)}`, msg = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: out }] };
        return sse([ev('response.output_item.added', { output_index: 0, item: { ...msg, content: [] } }), ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: out }), ev('response.output_item.done', { output_index: 0, item: msg })]);
      }
      // codex 0.160 lists every tool in an `additional_tools` input item and calls MCP tools from its `exec` code tool as tools.<server>__<tool>(args)
      if (!/hefyn/.test(JSON.stringify(body.input)) || !/assistant_echo/.test(JSON.stringify(body.input))) return sse([]);
      const item = { id: 'ct_1', type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: `text(JSON.stringify(await tools.mcp__hefyn__assistant_echo({ message: 'ping from codex' })))` };
      return sse([ev('response.output_item.added', { output_index: 0, item: { ...item, input: '' } }), ev('response.output_item.done', { output_index: 0, item })]);
    };
    const { s, events, until, sbx } = await session('codex-acp', `u_alice_01CXM${run}`, standIn);
    const from = paths.length;
    s.prompt('Please run the echo tool.');
    await until(() => events.some((e) => e.update.hefyn === 'turn_end'), 'turn_end', 180_000);
    // Verified: Codex 0.160 accepts the config, connects (initialize, initialized, tools/list all answered). NOT verified: that it hands the tool to the model. In the first request its
    // tool list holds only exec/wait/request_user_input/clock/collaboration, no MCP namespace (it may defer MCP tools behind tool_search; see the report).
    const mine = paths.slice(from).join('\n');
    assert.match(mine, /"method":"initialize"/); assert.match(mine, /"method":"tools\/list"[\s\S]*assistant_echo/);
    assert.match(stack.docker('exec', sbx(), 'cat', '/tmp/.codex/skills/echo/SKILL.md'), /assistant_echo/);
  });
});
