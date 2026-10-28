import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): Codex (codex-acp from the registry) in the real sandbox, turns with a tool call against a stand-in for the OpenAI Responses API
// ("RUN <command>" in the prompt = the command the model runs): ls/cat/grep run unasked (rg is not allowlisted: `--pre CMD` runs any program); a write, a patch, rm and curl are ACP permission requests in hefyn's chat
// and nothing happens until allowed (rejecting leaves no change). Then the terminal UI, which must follow the same rule.
const TOKEN = 'cli-codex-token-cli-codex-token-cli-codex-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-clicodex-'));
process.env.HEFYN_SECRET = 'cli-codex-secret-cli-codex-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: Codex runs read-only commands freely, asks before edits and risky commands; its terminal follows the same rule', { skip, timeout: 900_000 }, async (t) => {
  let host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { registry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const entry = (await registry()).agents.find((a) => a.id === 'codex-acp')!;
  assert.deepEqual(await stack.install(installRequest(entry, profileOf('codex-acp')!)), { state: 'ready' });

  // ---- the stand-in for the Responses API ----
  const requests: any[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const standIn = async (req: Request): Promise<Response> => {
    const body: any = await req.json().catch(() => ({}));
    requests.push(body);
    const resp = { id: `resp_${requests.length}`, status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    const sse = (items: string[]) => new Response(ev('response.created', { response: { ...resp, status: 'in_progress', output: [] } }) + items.join('') + ev('response.completed', { response: { ...resp, output: [] } }), { headers: { 'content-type': 'text/event-stream' } });
    // what the model does: runs the command the prompt names ("RUN <command>") as its one tool call, then reports its output
    const call = (n: number, args: object) => {
      const item = { id: `fc_${n}`, type: 'function_call', call_id: `call_${requests.length}`, name: 'exec_command', arguments: JSON.stringify(args) };
      return sse([ev('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } }), ev('response.output_item.done', { output_index: 0, item })]);
    };
    const lastUser: any[] = (body.input ?? []).filter((i: any) => i.role === 'user').at(-1)?.content ?? [];
    const cmd = lastUser.map((c) => /^RUN (.*)$/ms.exec(c.text ?? '')?.[1]).find(Boolean) ?? 'true';
    const sinceUser = (body.input ?? []).slice((body.input ?? []).map((i: any) => i.role === 'user').lastIndexOf(true));
    const done = sinceUser.filter((i: any) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output');
    if (done.length === 0 && cmd.startsWith('PATCH ')) { // an edit: codex 0.160 offers apply_patch to the model inside its `exec` code tool
      const item = { id: 'ct_1', type: 'custom_tool_call', call_id: `call_${requests.length}`, name: 'exec', input: `text(JSON.stringify(await tools.apply_patch(${JSON.stringify(cmd.slice(6))})))` };
      return sse([ev('response.output_item.added', { output_index: 0, item: { ...item, input: '' } }), ev('response.output_item.done', { output_index: 0, item })]);
    }
    if (done.length === 0) return call(1, { cmd });
    const text = `The command printed: ${JSON.stringify(done.at(-1).output).slice(0, 300)}`;
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    return sse([ev('response.output_item.added', { output_index: 0, item: { ...msg, content: [] } }), ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }), ev('response.output_item.done', { output_index: 0, item: msg })]);
  };

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { CliHost } = await import('../src/cli-agents/host.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('codex-acp', ?, 'ready', 1, '[]', ?)").run(entry.version, new Date().toISOString());
  const conv = `u_alice_01CODEX${run}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, 'codex-acp', 'chat')").run(conv, new Date().toISOString());
  const h = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel: (u, c) => stack.listenModel(u, c, standIn) });
  host = h;
  const s = h.session('alice', conv), events: any[] = [];
  s.subscribe(0, (e) => events.push(e));
  const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.filter((e) => e.update.sessionUpdate !== 'available_commands_update').slice(-8)).slice(0, 3000)}`); };

  const sbx = () => stack.docker('ps', '-q', '--filter', `label=hefyn.conversation=${conv}`).trim().split('\n')[0];
  const fileThere = (f: string) => { try { return stack.docker('exec', sbx(), 'cat', f).trim(); } catch { return null; } };
  /** One turn: the model runs `cmd`. Returns whether a permission request came up; with `answer`, the user allows or rejects it, else the turn must end by itself. */
  const turn = async (cmd: string, answer?: 'allow' | 'reject') => {
    const before = events.length, reqs = requests.length;
    s.prompt(`RUN ${cmd}`);
    if (answer) {
      await until(() => events.slice(before).some((e) => e.update.hefyn === 'permission'), `a permission request for ${cmd}`, 90_000);
      const p = events.slice(before).find((e) => e.update.hefyn === 'permission').update;
      assert.ok(!events.slice(before).some((e) => e.update.hefyn === 'turn_end'), 'the turn waits for the answer');
      assert.equal(requests.length, reqs + 1, 'the model is not asked again before the user answered');
      s.answer(p.requestId, p.options.find((o: any) => o.kind === (answer === 'allow' ? 'allow_once' : 'reject_once'))!.optionId);
    }
    await until(() => events.slice(before).some((e) => e.update.hefyn === 'turn_end'), `turn_end of ${cmd}`, 90_000);
    const mine = events.slice(before);
    assert.equal(mine.find((e) => e.update.hefyn === 'turn_end').update.stopReason, answer === 'reject' ? 'cancelled' : 'end_turn', JSON.stringify(mine).slice(0, 3000)); // rejecting ends the turn
    return { asked: mine.some((e) => e.update.hefyn === 'permission'), output: JSON.stringify(requests.slice(reqs).at(-1)?.input?.filter((i: any) => i.type === 'function_call_output').at(-1) ?? '') };
  };

  await t.test('known-safe read-only commands (ls, cat, grep) run without a permission request', async () => {
    for (const cmd of ['ls /files', 'cat /etc/hostname', 'grep -n hostname /etc/hostname']) {
      const r = await turn(cmd);
      assert.equal(r.asked, false, `${cmd} must not ask`);
      assert.doesNotMatch(r.output, /bubblewrap|exited with code 101|rejected/, `${cmd} ran: ${r.output}`);
    }
    assert.match((await turn('cat /etc/hostname')).output, /output/, 'the output went back to the model');
  });

  await t.test('a write asks; nothing happens until it is allowed; allowing runs it', async () => {
    const before = events.length;
    s.prompt('RUN echo hello-from-codex > /files/out.txt');
    await until(() => events.slice(before).some((e) => e.update.hefyn === 'permission'), 'a permission request', 90_000);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fileThere('/files/out.txt'), null, 'nothing written before the user answered');
    const p = events.slice(before).find((e) => e.update.hefyn === 'permission').update;
    s.answer(p.requestId, p.options.find((o: any) => o.kind === 'allow_once').optionId);
    await until(() => events.slice(before).some((e) => e.update.hefyn === 'turn_end'), 'turn_end', 90_000);
    assert.equal(fileThere('/files/out.txt'), 'hello-from-codex', 'allowed: it ran, outside any codex sandbox');
    assert.ok(events.some((e) => e.update.sessionUpdate === 'tool_call' || e.update.sessionUpdate === 'tool_call_update'));
  });

  await t.test('a patch asks; rejecting leaves the file as it was', async () => {
    const patch = 'PATCH *** Begin Patch\n*** Add File: /files/patched.txt\n+patched\n*** End Patch';
    assert.equal((await turn(patch, 'reject')).asked, true);
    assert.equal(fileThere('/files/patched.txt'), null, 'rejected: no file');
    assert.equal((await turn(patch, 'allow')).asked, true);
    assert.equal(fileThere('/files/patched.txt'), 'patched', 'allowed: patched');
  });

  await t.test('rm and curl ask; rejecting keeps rm from deleting', async () => {
    assert.equal((await turn('rm /files/out.txt', 'reject')).asked, true);
    assert.equal(fileThere('/files/out.txt'), 'hello-from-codex', 'rejected: still there');
    assert.equal((await turn('curl -sS -m 5 http://example.com', 'reject')).asked, true);
    assert.equal((await turn('rm /files/out.txt', 'allow')).asked, true);
    assert.equal(fileThere('/files/out.txt'), null, 'allowed: deleted');
  });

  await t.test('the terminal UI starts in the sandbox, without a sign-in or trust prompt', async () => {
    await until(() => !(s as any).busy, 'idle');
    await s.openTerminal(110, 32, 'dark');
    let first!: Buffer; const chunks: Buffer[] = [];
    const stop = s.terminalStream((b) => (first = b), (b) => chunks.push(b), () => {});
    const screen = () => Buffer.concat([first, ...chunks]).toString('utf8').replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
    await until(() => screen().length > 300, 'TUI output', 60_000);
    await new Promise((r) => setTimeout(r, 3000));
    const text = screen();
    assert.match(text.replace(/\s/g, ''), /Codex/i, text.slice(0, 1500));
    assert.doesNotMatch(text, /Sign in|Log in|Do you trust|Welcome to Codex/i, text.slice(0, 1500));
    // the terminal follows the same rule: a read-only command runs, a write waits for the user
    const say = async (line: string) => { s.terminalInput(line); await new Promise((r) => setTimeout(r, 400)); s.terminalInput('\r'); };
    const asking = () => /Would you like to run|Yes, proceed/i.test(screen());
    await say('RUN ls /files');
    await until(() => /The command printed/.test(screen()), 'the ls answer in the TUI', 60_000);
    assert.equal(asking(), false, `ls must not ask: ${screen().slice(-1500)}`);
    await say('RUN touch /files/tui.txt'); // a plain command no rule allows (a redirect would be asked about anyway)
    await until(asking, 'an approval prompt in the TUI', 60_000);
    assert.equal(fileThere('/files/tui.txt'), null, 'nothing written while the prompt is open');
    stop(); s.closeTerminal();
    await until(() => !s.terminalOpen, 'terminal closed');
  });
});
