import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): the real Claude Code in the real sandbox lists hefyn's MCP tools (the user's Assistants, src/cli-agents/mcp.ts, reached at 127.0.0.1:47000/mcp
// through the bridge and the model socket), the stand-in model emits a tool_use for one, hefyn runs the flow as a run of the chat and the Reply comes back as the tool result.
// The /command written for it reaches the model as its prompt. Setup as in cli-agent-wrapper.test.ts.
const TOKEN = 'cli-mods-token-cli-mods-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-climodsit-'));
process.env.HEFYN_SECRET = 'cli-mods-it-secret-cli-mods-it-secret-12';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: Claude Code lists the hefyn MCP tools and calls one; the /command reaches the model', { skip, timeout: 1_200_000 }, async (t) => {
  let upstream: http.Server | undefined;
  let host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); upstream?.close(); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { docker, listenModel, runnerUrl } = stack;

  // ---- the "model": calls the echo tool once per user turn, then reports what the tool returned ----
  const seen: any[] = [];
  let asks = 0, ids = 0; // a runaway stand-in must not loop the agent
  const sse = (events: [string, object][]) => events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join('');
  upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":7}');
      let j: any = {}; try { j = JSON.parse(raw); } catch { /* not ours */ }
      seen.push({ raw, j });
      const tail: any[][] = []; // the user message(s) since the model last spoke (Claude Code appends a reminder after the tool results)
      for (const m of [...(j.messages ?? [])].reverse()) { if (m.role === 'assistant') break; tail.unshift(Array.isArray(m.content) ? m.content : []); }
      const blocks = tail.flat();
      const result = blocks.filter((b) => b.type === 'tool_result').at(-1); // Claude Code folds the results of earlier calls into the same message
      // Claude Code defers MCP tools: they are named in a list and loaded with ToolSearch first. The stand-in does what a model would: ToolSearch, then the tool, then the report.
      const answered = result && j.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === 'tool_use' && b.id === result.tool_use_id).at(-1)?.name;
      const echo = 'mcp__hefyn__assistant_echo', main = j.stream && (j.tools ?? []).some((x: any) => x.name === 'Bash');
      const message = !main ? { text: 'ok' }
        : answered === echo ? { text: `Tool said: ${(Array.isArray(result.content) ? result.content.map((c: any) => c.text).join('') : result.content)}` }
        : answered === 'ToolSearch' ? { tool: echo, input: { message: 'ping from claude' } }
        : raw.includes(echo) && !blocks.some((b) => b.type === 'tool_result') && ++asks <= 4 ? (j.tools.some((x: any) => x.name === echo) ? { tool: echo, input: { message: 'ping from claude' } } : { tool: 'ToolSearch', input: { query: `select:${echo}`, max_results: 3 } })
        : { text: 'ok' };
      const head = ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }] as [string, object];
      if (!j.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse('tool' in message
        ? [head, ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_hefyn${++ids}`, name: message.tool, input: {} } }],
          ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(message.input) } }], ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }], ['message_stop', {}]]
        : [head, ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: message.text } }], ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]]));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => upstream!.once('listening', r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { connect } = await import('../src/server/providers.ts');
  const { CliHost, runnerSeed } = await import('../src/cli-agents/host.ts');
  const { FlowHost } = await import('../src/assistants/session.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  const { writeAssistant } = await import('../src/server/assistant-store.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  connect({ id: 'anthropic', baseUrl: upstreamUrl }, 'sk-ant-company');
  const conv = `u_alice_01MODIT${run}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, 'claude-acp', 'chat')").run(conv, new Date().toISOString());

  const { bundledRegistry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const entry = bundledRegistry().find((a) => a.id === 'claude-acp')!;
  const done = await stack.install(installRequest(entry, profileOf('claude-acp')!));
  assert.deepEqual(done, { state: 'ready' }, JSON.stringify(done));
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', ?, 'ready', 1, '[]', ?)").run(entry.version, new Date().toISOString());

  // an Assistant without a model step: trigger -> template -> reply
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
  writeAssistant({ name: 'Echo', description: 'Echoes the request back', icon: 'Sparkles', roles: [], scope: 'team', inputs: { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 },
    flow: { version: 1, nodes: [node('start', 'trigger.chat'), node('t', 'template', { text: 'Echo: {{start.text}}' }), node('r', 'output.reply', { text: '{{t.text}}' })], edges: [{ id: 'e1', from: 'start', to: 't' }, { id: 'e2', from: 't', to: 'r' }] } });

  const sbx = () => docker('ps', '-q', '--filter', 'label=hefyn.conversation=' + conv).trim().split('\n')[0];
  const inBox = (path: string) => { try { return execFileSync('docker', ['exec', sbx(), 'cat', path], { encoding: 'utf8', stdio: 'pipe' }); } catch { return undefined; } };
  const h = new CliHost({ attach: runnerAttach({ url: runnerUrl, token: TOKEN }), listenModel, transcript: stack.transcript, seed: runnerSeed({ runnerUrl, token: TOKEN }) });
  host = h;
  new FlowHost(h); // serves /mcp on the conversations' sockets
  const s = h.session('alice', conv), events: any[] = [];
  s.subscribe(0, (e) => {
    events.push(e);
    if (e.update.hefyn === 'permission') { const o = (e.update.options as any[]).find((x) => /allow/.test(x.kind)); s.answer(e.update.requestId as string, o.optionId); } // the user allows the tool
  });
  const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.slice(-8))}`); };
  const turns = () => events.filter((e) => e.update.hefyn === 'turn_end').length;

  await t.test('Claude Code lists the Assistant as a tool, calls it, and the Reply comes back as the tool result', async () => {
    s.prompt('Please run the echo tool.');
    await until(() => turns() === 1, 'turn_end');
    assert.equal(events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'end_turn', JSON.stringify(events));
    const names = seen.flatMap((x) => (x.j.tools ?? []).map((y: any) => y.name));
    assert.ok(seen.some((x) => x.raw.includes('mcp__hefyn__assistant_echo')) && names.includes('ToolSearch'), `the hefyn tool is listed (deferred, behind ToolSearch): ${[...new Set(names)]}`);
    const said = events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').map((e) => e.update.content.text).join('');
    assert.ok(said.includes('Tool said: Echo: ping from claude'), `the agent reported the reply, got ${JSON.stringify(said)}; `);
    assert.ok(events.some((e) => e.update.hefyn === 'run_start') && events.some((e) => e.update.hefyn === 'run_end' && e.update.status === 'done'), 'the run is in the chat log');
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  await t.test('the /command is in the sandbox, marked as hefyn\'s, and typing it sends its text to the model', async () => {
    const cmd = inBox('/tmp/.claude/commands/echo.md') ?? '';
    assert.match(cmd, /description: "Echoes the request back"/);
    assert.match(cmd, /<!-- hefyn-managed -->/);
    assert.equal(JSON.parse(inBox('/tmp/.claude/.claude.json') ?? '{}').mcpServers.hefyn.url, 'http://127.0.0.1:47000/mcp');
    const reqs = seen.length;
    s.prompt('/echo hello from the slash');
    await until(() => turns() === 2, 'second turn');
    const after = seen.slice(reqs);
    assert.ok(after.some((x) => x.raw.includes('Use the hefyn tool assistant_echo') && x.raw.includes('hello from the slash')), 'the command expanded to its text with the arguments');
  });
});
