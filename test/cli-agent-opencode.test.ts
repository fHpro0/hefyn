import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): OpenCode (registry binary) in the real sandbox. Its default allows edits and commands unasked; hefyn's profile sets
// permission edit/bash to "ask", so each is an ACP permission request in the chat. A stand-in for the Anthropic API emits the tool calls.
const TOKEN = 'cli-oc-token-cli-oc-token-cli-oc-token-0123456789abcd';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-clioc-'));
process.env.HEFYN_SECRET = 'cli-oc-secret-cli-oc-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: OpenCode asks before it edits a file or runs a command', { skip, timeout: 900_000 }, async (t) => {
  let host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { registry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const entry = (await registry()).agents.find((a) => a.id === 'opencode')!;
  assert.deepEqual(await stack.install(installRequest(entry, profileOf('opencode')!)), { state: 'ready' });

  const sse = (events: [string, object][]) => new Response(events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const start = { message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } };
  const text = (s: string) => sse([['message_start', start], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: s } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]]);
  const tool = (name: string, input: object) => sse([['message_start', start], ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${name}`, name, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]]);
  let plan: (() => Response) | undefined;
  const standIn = async (req: Request): Promise<Response> => {
    const body: any = await req.json().catch(() => ({}));
    if (!body.tools?.length) return text('title'); // OpenCode's own title request
    const last = body.messages.at(-1);
    if (Array.isArray(last?.content) && last.content.some((c: any) => c.type === 'tool_result')) return text('all done');
    return plan!();
  };

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { CliHost } = await import('../src/cli-agents/host.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('opencode', ?, 'ready', 1, '[]', ?)").run(entry.version, new Date().toISOString());
  const conv = `u_alice_01OC${run}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, 'opencode', 'chat')").run(conv, new Date().toISOString());
  const h = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel: (u, c) => stack.listenModel(u, c, standIn) });
  host = h;
  const s = h.session('alice', conv), events: any[] = [];
  s.subscribe(0, (e) => events.push(e));
  const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.slice(-6)).slice(0, 2500)}`); };
  const sbx = () => stack.docker('ps', '-q', '--filter', `label=hefyn.conversation=${conv}`).trim().split('\n')[0];
  const cat = (f: string) => { try { return stack.docker('exec', sbx(), 'cat', f).trim(); } catch { return null; } };

  for (const [what, name, input, file] of [['an edit', 'write', { path: '/files/edit.txt', filePath: '/files/edit.txt', content: 'edited' }, '/files/edit.txt'], ['a command', 'bash', { command: 'echo ran > /files/cmd.txt', description: 'write a file' }, '/files/cmd.txt']] as const) {
    await t.test(`${what} is a permission request; nothing happens until it is allowed`, async () => {
      const before = events.length;
      plan = () => tool(name, input);
      s.prompt(`Please do ${what}`);
      await until(() => events.slice(before).some((e) => e.update.hefyn === 'permission'), 'a permission request', 90_000);
      assert.equal(cat(file), null, 'not written before the user answered');
      const p = events.slice(before).find((e) => e.update.hefyn === 'permission').update;
      s.answer(p.requestId, (p.options.find((o: any) => o.kind === 'allow_once') ?? p.options[0]).optionId);
      await until(() => events.slice(before).some((e) => e.update.hefyn === 'turn_end'), 'turn_end', 90_000);
      assert.equal(cat(file), name === 'write' ? 'edited' : 'ran', 'allowed: it happened');
    });
  }
  await t.test('denying keeps the edit from happening', async () => {
    const before = events.length;
    plan = () => tool('write', { path: '/files/denied.txt', filePath: '/files/denied.txt', content: 'x' });
    s.prompt('Please edit again');
    await until(() => events.slice(before).some((e) => e.update.hefyn === 'permission'), 'a permission request', 90_000);
    const p = events.slice(before).find((e) => e.update.hefyn === 'permission').update;
    s.answer(p.requestId, p.options.find((o: any) => o.kind === 'reject_once').optionId);
    await until(() => events.slice(before).some((e) => e.update.hefyn === 'turn_end'), 'turn_end', 90_000);
    assert.equal(cat('/files/denied.txt'), null);
  });
});
