import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): a flow's code steps run in the user's sandbox container (JavaScript and Python, stdin/stdout JSON, no network), and a CLI agent step runs the real
// Claude Code (installed from the ACP Registry like an admin does) against a recording model stand-in, returning its text into the flow. Same stack as cli-agent-container.test.ts.
const TOKEN = 'flows-docker-token-flows-docker-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-flowsdocker-'));
process.env.HEFYN_SECRET = 'flows-docker-secret-flows-docker-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

const node = (id: string, type: string, config: Record<string, any> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const INPUTS = { images: 'off' as const, maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };

test('integration: code steps in the sandbox and a Claude Code step, inside a flow chat', { skip, timeout: 1_200_000 }, async (t) => {
  let upstream: http.Server | undefined, host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); upstream?.close(); });
  const stack = await startStack(t, { run, token: TOKEN });
  process.env.HEFYN_RUNNER_URL = stack.runnerUrl;

  const seen: any[] = [];
  upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":7}');
      let j: any = {}; try { j = JSON.parse(raw); } catch { /* not ours */ }
      seen.push({ raw, j });
      const text = 'ok-from-claude';
      const sse = (events: [string, object][]) => events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join('');
      if (!j.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse([
        ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
        ['message_stop', {}],
      ]));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => upstream!.once('listening', r));

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { connect } = await import('../src/server/providers.ts');
  const { CliHost, runnerSeed } = await import('../src/cli-agents/host.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  const { FlowHost } = await import('../src/assistants/session.ts');
  const { writeAssistant } = await import('../src/server/assistant-store.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  connect({ id: 'anthropic', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }, 'sk-ant-company');

  const cli = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel: stack.listenModel, transcript: stack.transcript, seed: runnerSeed({ runnerUrl: stack.runnerUrl, token: TOKEN }) });
  const flows = new FlowHost(cli);
  host = { closeAll: async () => { await cli.closeAll(); await flows.closeAll(); } };
  let n = 0;
  async function chat(nodes: ReturnType<typeof node>[], edges: [string, string][], text: string) {
    const flow = { version: 1 as const, nodes, edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })) };
    const aid = writeAssistant({ name: `F${++n}`, description: '', icon: 'Sparkles', inputs: INPUTS, roles: [], flow, scope: 'team', owner: null }).id;
    const id = `u_alice_01FDOCK${run}${n}`;
    db.prepare('INSERT INTO conversations (id, user_id, title, created_at, assistant_id, flow) VALUES (?,?,?,?,?,1)').run(id, 'alice', 'x', new Date().toISOString(), aid);
    const s = flows.session('alice', id), events: any[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt(text);
    for (let i = 0; i < 2400 && !events.some((e) => e.update.hefyn === 'run_end'); i++) await new Promise((r) => setTimeout(r, 50));
    return events.map((e) => e.update);
  }
  const replies = (u: any[]) => u.filter((x) => x.sessionUpdate === 'agent_message_chunk' && !x.node).map((x) => x.content.text);

  await t.test('code steps: JavaScript then Python, JSON on stdin and stdout, and no network', async () => {
    const js = `const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
fetch('http://example.com', { signal: AbortSignal.timeout(3000) }).then(() => 'open', () => 'blocked').then((net) => console.log(JSON.stringify({ upper: i.input.text.toUpperCase(), net })));`;
    const py = `import sys, json
d = json.load(sys.stdin)
print(json.dumps({"len": len(d["steps"]["c1"]["json"]["upper"])}))`;
    const u = await chat([node('start', 'trigger.chat'), node('c1', 'code', { language: 'javascript', source: js, timeoutSec: 30 }), node('c2', 'code', { language: 'python', source: py, timeoutSec: 30 }),
      node('reply', 'output.reply', { text: 'Upper {{c1.json.upper}} len {{c2.json.len}} net {{c1.json.net}}' })], [['start', 'c1'], ['c1', 'c2'], ['c2', 'reply']], 'hello docker');
    assert.deepEqual(replies(u), ['Upper HELLO DOCKER len 12 net blocked'], JSON.stringify(u.slice(-4)));
    assert.equal(u.at(-1).status, 'done');
    // a failing program stops the run with its error
    const f = await chat([node('start', 'trigger.chat'), node('c', 'code', { language: 'python', source: 'raise ValueError("boom")', timeoutSec: 30 }), node('reply', 'output.reply', { text: 'x' })], [['start', 'c'], ['c', 'reply']], 'x');
    assert.equal(f.at(-1).status, 'failed');
    assert.match(f.at(-1).error, /ValueError: boom/);
    const slow = await chat([node('start', 'trigger.chat'), node('c', 'code', { language: 'javascript', source: 'setTimeout(() => {}, 60000)', timeoutSec: 2 }), node('reply', 'output.reply', { text: 'x' })], [['start', 'c'], ['c', 'reply']], 'x');
    assert.match(slow.at(-1).error, /longer than 2 seconds/);
  });

  await t.test('a Claude Code step: installed from the registry, runs in the sandbox, its text flows on', async () => {
    const { bundledRegistry } = await import('../src/cli-agents/registry.ts');
    const { installRequest } = await import('../src/cli-agents/installed.ts');
    const { profileOf } = await import('../src/cli-agents/profiles.ts');
    const entry = bundledRegistry().find((a) => a.id === 'claude-acp')!;
    assert.deepEqual(await stack.install(installRequest(entry, profileOf('claude-acp')!)), { state: 'ready' });
    db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', ?, 'ready', 1, '[]', ?)").run(entry.version, new Date().toISOString());
    const u = await chat([node('start', 'trigger.chat'), node('coder', 'agent', { agent: 'claude-acp', model: 'claude-sonnet-4-5', thinking: null, instructions: 'FLOW-STEP-INSTRUCTIONS-9', prompt: 'Say something about {{start.text}}', skills: [], history: false, subAgents: [], output: 'text' }),
      node('reply', 'output.reply', { text: 'Claude: {{coder.text}}' })], [['start', 'coder'], ['coder', 'reply']], 'flows');
    assert.deepEqual(replies(u), ['Claude: ok-from-claude'], JSON.stringify(u.slice(-6)));
    assert.ok(u.some((x) => x.sessionUpdate === 'agent_message_chunk' && x.node === 'coder' && x.runId), 'the agent\'s own updates carry runId and node');
    assert.ok(seen.some((x) => x.raw.includes('FLOW-STEP-INSTRUCTIONS-9')), 'the step\'s instructions reached the model through the gateway');
    assert.ok(seen.every((x) => x.j.model === undefined || x.j.model === 'claude-sonnet-4-5' || /haiku/.test(x.j.model)), 'the step\'s model');
  });
});
