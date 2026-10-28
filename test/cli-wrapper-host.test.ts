import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';

// Claude Code in a PTY (src/cli-agents/host.ts, claude-wrapper.ts) without Docker: a fake "Claude Code" in the PTY that behaves like the real one measured with 2.1.310
// (a bracketed paste then Enter submits; it posts its http hooks to the model socket's /hooks/<event> and writes its transcript JSONL; a permission hook blocks until
// answered; Esc interrupts). The real binary against a recording model is test/cli-agent-wrapper.test.ts.
const DATA = mkdtempSync(join(tmpdir(), 'hefyn-wraphost-'));
process.env.HEFYN_DATA_DIR = DATA;
process.env.HEFYN_SECRET = 'wrap-host-secret-wrap-host-secret-123456';
process.env.HEFYN_RUNNER_URL = 'http://runner.invalid:8790';

const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { CliHost } = await import('../src/cli-agents/host.ts');
const { connect } = await import('../src/server/providers.ts');
vault.setTeamKey(vault.newKey());
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '2.1.310', 'ready', 1, '[]', ?)").run(new Date().toISOString());
const uid = 'alice';
vault.rememberUserKey(uid, vault.newKey());
let n = 0;
const newConv = (agent = 'claude-code') => {
  const id = `u_${uid}_01WRAP${String(++n).padStart(3, '0')}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?,?,?,?,?, 'chat')").run(id, uid, 'x', new Date().toISOString(), agent);
  return id;
};

// ---- the sandbox side ----
const calls = { attach: [] as any[], handlers: new Map<string, (r: Request) => Promise<Response>>(), auth: [] as string[], signedIn: false, ptys: [] as { conv: string; sid: string; got: string[]; kill(): void }[], resizes: [] as [number, number][], seeds: [] as any[][], hooks: [] as { event: string; body: any }[], answers: [] as any[] };
const sidOf = (cmd: string) => /(?:--resume|--session-id) ([0-9a-f-]{36})/.exec(cmd)?.[1] ?? '';
const tline = (conv: string, sid: string, o: unknown) => { const f = join(DATA, 'users', uid, 'tmp', conv, '.claude', 'projects', '-files', `${sid}.jsonl`); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, `${JSON.stringify(o)}\n`); };
const asst = (content: unknown[]) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content } });
const result = (id: string, text: string, error = false) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(error ? { is_error: true } : {}) }] } });

function attach(conv: string) {
  return async (_u: string, c: string, spec: any) => {
    calls.attach.push({ ...spec, conv: c });
    const toProc = new PassThrough(), fromProc = new PassThrough();
    const stream = Duplex.from({ readable: fromProc, writable: toProc } as any) as Duplex;
    const sid = sidOf(spec.cmd.join(' ')), got: string[] = [];
    let id = 0, inPaste = false, paste = '', pending: AbortController | undefined;
    const post = async (event: string, body: object) => {
      const h = calls.handlers.get(c); if (!h) return {};
      calls.hooks.push({ event, body });
      const r = await h(new Request(`http://hook/hooks/${event}`, { method: 'POST', body: JSON.stringify({ session_id: sid, cwd: '/files', hook_event_name: event, ...body }) }));
      return r.json() as Promise<any>;
    };
    const turn = async (text: string) => {
      const prompt_id = `p${++id}`, ctl = (pending = new AbortController());
      await post('UserPromptSubmit', { prompt_id, prompt: text });
      if (text.includes('hang')) return void (await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r())));
      if (text.includes('late')) { // like the real one: the hook of a tool goes out before the transcript lines about it (the text before it, then the tool_use)
        const input = { command: 'ls' }, tid = `toolu_late${id}`;
        setTimeout(() => { tline(c, sid, asst([{ type: 'text', text: 'Let me look.' }])); tline(c, sid, asst([{ type: 'tool_use', id: tid, name: 'Bash', input }])); }, 200);
        await post('PreToolUse', { prompt_id, tool_name: 'Bash', tool_input: input, tool_use_id: tid });
        tline(c, sid, result(tid, 'file.txt')); await post('PostToolUse', { prompt_id, tool_name: 'Bash', tool_input: input, tool_response: { stdout: 'file.txt' }, tool_use_id: tid });
        tline(c, sid, asst([{ type: 'text', text: 'Found one file.' }])); tline(c, sid, asst([{ type: 'text', text: 'Done.' }]));
      }
      if (text.includes('subagent')) { // an Agent call whose sub-agent writes a file and asks for it (its hooks carry agent_id, its transcript is its own file)
        const aid = 'a1b2c3', ainput = { description: 'Quiet check', prompt: 'SUBTASK', subagent_type: 'general-purpose' }, winput = { file_path: '/files/sub.txt', content: 'x\n' }, atid = `toolu_agent${id}`, wtid = `toolu_sw${id}`;
        const subline = (o: unknown) => { const f = join(DATA, 'users', uid, 'tmp', c, '.claude', 'projects', '-files', sid, 'subagents', `agent-${aid}.jsonl`); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, `${JSON.stringify({ isSidechain: true, ...(o as object) })}\n`); };
        tline(c, sid, asst([{ type: 'tool_use', id: atid, name: 'Agent', input: ainput }]));
        await post('PreToolUse', { prompt_id, tool_name: 'Agent', tool_input: ainput, tool_use_id: atid });
        await post('SubagentStart', { agent_id: aid, agent_type: 'general-purpose' });
        subline({ type: 'user', message: { role: 'user', content: 'SUBTASK' } });
        subline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: wtid, name: 'Write', input: winput }] } });
        await post('PreToolUse', { prompt_id, agent_id: aid, agent_type: 'general-purpose', tool_name: 'Write', tool_input: winput, tool_use_id: wtid });
        const a: any = await post('PermissionRequest', { prompt_id, agent_id: aid, tool_name: 'Write', tool_input: winput });
        calls.answers.push(a);
        subline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: wtid, content: 'File created' }] } });
        await post('PostToolUse', { prompt_id, agent_id: aid, tool_name: 'Write', tool_input: winput, tool_response: { type: 'create' }, tool_use_id: wtid });
        subline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All quiet.' }] } });
        await post('SubagentStop', { agent_id: aid, agent_type: 'general-purpose' });
        tline(c, sid, result(atid, 'All quiet.')); await post('PostToolUse', { prompt_id, tool_name: 'Agent', tool_input: ainput, tool_response: 'All quiet.', tool_use_id: atid });
      }
      if (text.includes('write')) {
        const input = { file_path: '/files/out.txt', content: 'hello\n' }, tid = `toolu_${id}`; // ids are unique per call
        tline(c, sid, asst([{ type: 'thinking', thinking: 'plan' }])); tline(c, sid, asst([{ type: 'text', text: 'Writing.' }])); tline(c, sid, asst([{ type: 'tool_use', id: tid, name: 'Write', input }]));
        await post('PreToolUse', { prompt_id, tool_name: 'Write', tool_input: input, tool_use_id: tid });
        const asked = post('PermissionRequest', { prompt_id, tool_name: 'Write', tool_input: input, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
        const a: any = await Promise.race([asked, new Promise((r) => ctl.signal.addEventListener('abort', () => r('esc')))]);
        if (a === 'esc') return;
        calls.answers.push(a);
        const d = a.hookSpecificOutput?.decision;
        if (d?.behavior === 'allow') { tline(c, sid, result(tid, 'File created')); await post('PostToolUse', { prompt_id, tool_name: 'Write', tool_input: input, tool_response: { type: 'create' }, tool_use_id: tid }); }
        else if (d?.behavior === 'deny') { tline(c, sid, result(tid, d.message, true)); await post('PostToolUse', { prompt_id, tool_name: 'Write', tool_input: input, tool_response: `Error: ${d.message}`, tool_use_id: tid }); }
        else { await new Promise((r) => setTimeout(r, 30)); tline(c, sid, result(tid, 'File created')); await post('PostToolUse', { prompt_id, tool_name: 'Write', tool_input: input, tool_response: { type: 'create' }, tool_use_id: tid }); } // answered in the terminal
      }
      // like the real one (measured): the hook goes out first, the last transcript lines and `turn_duration` are written behind it
      const behind = (lines: unknown[]) => setTimeout(() => { for (const l of lines) tline(c, sid, l); tline(c, sid, { type: 'system', subtype: 'turn_duration', isSidechain: false }); }, 150);
      if (text.includes('silent')) { await post('Stop', { prompt_id, last_assistant_message: '' }); behind([]); return; }
      if (text.includes('fail')) { await post('StopFailure', { prompt_id, error: 'unknown', last_assistant_message: 'API Error: 400 nope' }); behind([]); return; }
      await post('Stop', { prompt_id, last_assistant_message: `echo: ${text}` });
      behind([asst([{ type: 'text', text: `echo: ${text}` }])]);
    };
    toProc.on('data', (d: Buffer) => {
      for (const ch of d.toString()) {
        got.push(ch);
        if (inPaste) { paste += ch; if (paste.endsWith('\x1b[201~')) { inPaste = false; paste = paste.slice(0, -6); } continue; }
        const s = got.slice(-6).join('');
        if (ch === '\x1b' && !d.toString().includes('\x1b[200~')) { pending?.abort(); fromProc.write('interrupted'); continue; }
        if (s.endsWith('\x1b[200~')) { inPaste = true; paste = ''; continue; }
        if (ch === '\r' && paste) { const t = paste; paste = ''; void turn(t); }
      }
    });
    setTimeout(() => fromProc.write('welcome\r\n'), 10);
    const rec = { conv: c, sid, got: [] as string[], kill: () => stream.destroy() };
    toProc.on('data', (d) => rec.got.push(d.toString()));
    calls.ptys.push(rec);
    stream.on('close', () => { toProc.destroy(); fromProc.destroy(); });
    return { stream, resize: async (cols: number, rows: number) => void calls.resizes.push([cols, rows]) };
  };
}
const listenModel = async (_u: string, c: string, handler: (r: Request) => Promise<Response>) => { calls.handlers.set(c, handler); return { close: () => void calls.handlers.delete(c) }; };
const mkHost = (idleMs?: number) => new CliHost({ attach: (u, c, s) => attach(c)(u, c, s), listenModel, listenAuth: async (_u, c) => (calls.auth.push(c), { close() {} }), signedIn: async () => calls.signedIn, seed: async (_u, _c, seeds) => void calls.seeds.push(seeds as any[]), idleMs }, 3_600_000);
const until = async (f: () => boolean, what: string, ms = 5000) => { for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), `timeout: ${what}`); };
function watch(host: InstanceType<typeof CliHost>, conv: string, after = 0) {
  const events: any[] = [];
  const stop = host.session(uid, conv).subscribe(after, (e) => events.push(e));
  return { events, stop, kinds: () => events.map((e) => e.update.hefyn ?? e.update.sessionUpdate), has: (k: string) => events.some((e) => (e.update.hefyn ?? e.update.sessionUpdate) === k), ends: () => events.filter((e) => e.update.hefyn === 'turn_end').length };
}
const withKey = () => connect({ id: 'anthropic' }, 'sk-ant-company');

test('a chat turn: the message is pasted into the PTY, the answer is built from the transcript and hooks, the session id is stored', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi');
  await until(() => w.ends() === 1, 'turn_end');
  const k = w.kinds();
  assert.ok(k.indexOf('user') < k.indexOf('turn_start') && k.indexOf('turn_start') < k.indexOf('agent_message_chunk') && k.indexOf('agent_message_chunk') < k.indexOf('turn_end'), k.join());
  assert.equal(w.events.filter((e) => e.update.hefyn === 'user').length, 1, 'hefyn\'s own prompt is logged once, not again from the hook');
  assert.equal(w.events.find((e) => e.update.sessionUpdate === 'agent_message_chunk').update.content.text, 'echo: say hi');
  assert.equal(w.events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'end_turn');
  const sid = (db.prepare('SELECT acp_session FROM conversations WHERE id = ?').get(conv) as any).acp_session;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  const at = calls.attach.at(-1);
  assert.equal(at.tty, true); assert.equal(at.cwd, '/files'); assert.match(at.cmd.at(-1), new RegExp(`--session-id ${sid}`));
  assert.equal(at.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47000'); assert.equal(at.env.CLAUDE_CONFIG_DIR, '/tmp/.claude'); assert.equal(at.env.HTTPS_PROXY, undefined);
  const pty = calls.ptys.at(-1)!, input = pty.got.join('');
  assert.ok(input.includes('\x1b[200~say hi\x1b[201~') && input.endsWith('\r'), 'bracketed paste, then Enter');
  assert.equal(calls.auth.length, 0, 'no proxy in API-key mode');
  s.prompt('second'); // the same PTY answers the next one
  await until(() => w.ends() === 2, 'second turn');
  assert.equal(calls.attach.filter((a) => a.conv === conv).length, 1);
  await host.closeAll();
});

test('a tool call with a permission question: the chat answers through the hook, the diff and the result are shown', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('please write it');
  await until(() => w.has('permission'), 'permission');
  const q = w.events.find((e) => e.update.hefyn === 'permission').update;
  assert.deepEqual(q.options.map((o: any) => o.optionId), ['allow', 'allow_session', 'deny']);
  assert.equal(q.toolCall.title, 'Write /files/out.txt');
  const call = w.events.find((e) => e.update.sessionUpdate === 'tool_call').update;
  assert.deepEqual(call.content, [{ type: 'diff', path: '/files/out.txt', oldText: null, newText: 'hello\n' }]);
  assert.ok(w.has('agent_thought_chunk'));
  assert.equal(calls.answers.length, w.events.filter((e) => e.update.hefyn === 'permission_resolved').length, 'nothing is answered yet');
  assert.throws(() => s.answer(q.requestId, 'nope'), (e: any) => e.status === 400);
  s.answer(q.requestId, 'allow');
  await until(() => w.ends() === 1, 'turn_end');
  assert.deepEqual(calls.answers.at(-1), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(w.events.find((e) => e.update.hefyn === 'permission_resolved').update, { hefyn: 'permission_resolved', requestId: q.requestId, optionId: 'allow' });
  const done = w.events.filter((e) => e.update.sessionUpdate === 'tool_call_update').at(-1).update;
  assert.equal(done.status, 'completed');
  // a refusal reaches Claude Code as a deny, and the tool fails
  s.prompt('write again');
  await until(() => w.events.filter((e) => e.update.hefyn === 'permission').length === 2, 'second question');
  s.answer(w.events.filter((e) => e.update.hefyn === 'permission')[1].update.requestId, 'deny');
  await until(() => w.ends() === 2, 'second turn_end');
  assert.equal(calls.answers.at(-1).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(w.events.filter((e) => e.update.sessionUpdate === 'tool_call_update').at(-1).update.status, 'failed');
  await host.closeAll();
});

test('the terminal answers first: the card closes and the hook is released without a decision', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('write here');
  await until(() => w.has('permission'), 'permission');
  const q = w.events.find((e) => e.update.hefyn === 'permission').update;
  // the fake Claude Code carries on (as if the TUI had been answered): hook-side PostToolUse for the tool
  const h = calls.handlers.get(conv)!, sid = calls.ptys.at(-1)!.sid;
  await h(new Request('http://hook/hooks/PostToolUse', { method: 'POST', body: JSON.stringify({ session_id: sid, tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: '/files/out.txt', content: 'hello\n' }, tool_response: { type: 'create' } }) }));
  await until(() => w.events.some((e) => e.update.hefyn === 'permission_resolved'), 'card closed');
  assert.equal(w.events.find((e) => e.update.hefyn === 'permission_resolved').update.requestId, q.requestId);
  await until(() => w.ends() === 1, 'turn_end');
  assert.deepEqual(calls.answers.at(-1), {}, 'the hook got no decision');
  assert.throws(() => s.answer(q.requestId, 'allow'), (e: any) => e.status === 404);
  await host.closeAll();
});

test('Stop sends Esc to the PTY and ends the turn at once; the next prompt clears the composer first', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hang on');
  await until(() => w.has('turn_start'), 'turn_start');
  assert.throws(() => s.prompt('more'), (e: any) => e.status === 409 && /still answering/.test(e.message));
  const pty = calls.ptys.at(-1)!;
  await s.cancel();
  assert.ok(pty.got.join('').endsWith('\x1b'), 'Esc went into the PTY');
  await until(() => w.ends() === 1, 'turn_end');
  assert.equal(w.events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'cancelled');
  s.prompt('after');
  await until(() => w.ends() === 2, 'next turn');
  assert.ok(pty.got.join('').includes('\x03\x1b[200~after'), 'Ctrl-C cleared what Esc put back into the composer');
  assert.equal(calls.attach.filter((a) => a.conv === conv).length, 1, 'no new process');
  await host.closeAll();
});

test('one session, two views: the terminal attaches to the chat\'s PTY, typing there shows up in the chat', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'turn_end');
  const before = calls.attach.length;
  await s.openTerminal(100, 30, 'light');
  assert.equal(calls.attach.length, before, 'no second process');
  assert.deepEqual(calls.resizes.at(-1), [100, 30]);
  let first!: Buffer; const chunks: string[] = [];
  const stop = s.terminalStream((b) => (first = b), (b) => chunks.push(b.toString()), () => {});
  assert.match(first.toString(), /welcome/, 'the scrollback of the PTY the chat started');
  // a prompt typed in the terminal: pasted by the browser, then Enter
  s.terminalInput('\x1b[200~typed there\x1b[201~'); s.terminalInput('\r');
  await until(() => w.ends() === 2, 'turn from the terminal');
  assert.ok(w.events.some((e) => e.update.hefyn === 'user' && e.update.text === 'typed there'), 'the chat shows what was typed in the terminal');
  assert.ok(w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text.includes('typed there'));
  await s.terminalResize(120, 40);
  assert.deepEqual(calls.resizes.at(-1), [120, 40]);
  s.prompt('and again from the chat'); await until(() => w.ends() === 3, 'chat turn after the terminal');
  stop();
  await host.closeAll();
});

test('Esc typed in the terminal ends a running turn in the chat too; a prompt Claude Code made up is not a user message', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hang here'); await until(() => w.has('turn_start'), 'turn_start');
  await s.openTerminal(80, 24);
  s.terminalInput('\x1b');
  await until(() => w.ends() === 1, 'turn_end');
  assert.equal(w.events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'cancelled');
  const h = calls.handlers.get(conv)!, sid = calls.ptys.at(-1)!.sid;
  await h(new Request('http://hook/hooks/UserPromptSubmit', { method: 'POST', body: JSON.stringify({ session_id: sid, prompt_id: 'bg1', prompt: '<task-notification>\n<status>completed</status>\n</task-notification>' }) }));
  assert.ok(!w.events.some((e) => e.update.hefyn === 'user' && /task-notification/.test(e.update.text)));
  assert.equal(w.events.at(-1).update.hefyn, 'turn_start');
  await h(new Request('http://hook/hooks/Stop', { method: 'POST', body: JSON.stringify({ session_id: sid, prompt_id: 'bg1' }) }));
  await host.closeAll();
});

test('resume after the PTY ended: the stored session id is passed again, and what the transcript held before is not logged twice', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'turn_end');
  const sid = (db.prepare('SELECT acp_session FROM conversations WHERE id = ?').get(conv) as any).acp_session;
  s.closeTerminal(); // the PTY is gone
  await until(() => w.events.some((e) => e.update.state === 'stopped'), 'stopped');
  const chunks = w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').length;
  s.prompt('after');
  await until(() => w.ends() === 2, 'second turn');
  assert.equal(calls.attach.filter((a) => a.conv === conv).length, 2);
  assert.match(calls.attach.at(-1).cmd.at(-1), new RegExp(`--resume ${sid}; else exec "\\$bin" --session-id ${sid}`), 'the script resumes when the transcript exists');
  assert.equal(w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').length, chunks + 1, 'only the new answer is logged');
  await host.closeAll();
});

test('the console\'s theme reaches Claude Code when a chat message (not the terminal view) starts it, in the settings seed that Claude Code reads first', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi', 'light'); await until(() => w.ends() === 1, 'first turn');
  const seed = JSON.parse(calls.attach.at(-1).env.HEFYN_SEED);
  assert.equal(seed.find((x: any) => x.path === '/tmp/.claude/.claude.json' && x.force).json.theme, 'light');
  assert.ok(seed.some((x: any) => x.path === '/tmp/.claude/settings.json' && x.json.theme === 'light'), 'settings.json carries the theme');
  const procs = calls.attach.length;
  await host.session(uid, conv).openTerminal(100, 30, 'dark'); // an idle terminal started in the other theme restarts (resumed)
  assert.equal(calls.attach.length, procs + 1);
  assert.equal(JSON.parse(calls.attach.at(-1).env.HEFYN_SEED).find((x: any) => x.path === '/tmp/.claude/settings.json' && x.json.theme).json.theme, 'dark');
  await host.closeAll();
});

test('an Assistant: its instructions and model are seeded before the start; an admin\'s edit restarts Claude Code (resumed) at the next message, not while the terminal is watched', async () => {
  withKey(); calls.signedIn = false;
  db.prepare("INSERT INTO profiles (id, name, agent, model, instructions, skills, updated_at) VALUES ('a_cc', 'Coder', 'claude-acp', 'claude-sonnet-4-5', 'INSTRUCTIONS-42', '[]', 'v1')").run();
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  db.prepare("UPDATE conversations SET assistant_id = 'a_cc' WHERE id = ?").run(conv);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'first turn');
  const seeded = (i: number) => calls.seeds[i]!.find((x: any) => x.path === '/tmp/.claude/CLAUDE.md')?.text;
  assert.equal(seeded(calls.seeds.length - 1), 'INSTRUCTIONS-42');
  assert.ok(JSON.parse(calls.attach.at(-1).env.HEFYN_SEED).some((x: any) => x.json?.model === 'claude-sonnet-4-5'), 'the model goes in through the settings seed');
  const procs = calls.attach.length;
  db.prepare("UPDATE profiles SET instructions = 'INSTRUCTIONS-43', updated_at = 'v2' WHERE id = 'a_cc'").run();
  await s.openTerminal(80, 24); const stop = s.terminalStream(() => {}, () => {}, () => {});
  s.prompt('while watched'); await until(() => w.ends() === 2, 'second turn');
  assert.equal(calls.attach.length, procs, 'a watched terminal is not cut off');
  stop();
  s.prompt('after the edit'); await until(() => w.ends() === 3, 'third turn');
  assert.equal(calls.attach.length, procs + 1, 'restarted once');
  assert.ok(!w.events.some((e) => e.update.hefyn === 'error'), `the restart is not an error: ${JSON.stringify(w.events.slice(-8).map((e) => e.update))}`);
  assert.equal(w.events.filter((e) => e.update.hefyn === 'turn_end').at(-1).update.stopReason, 'end_turn');
  assert.equal(seeded(calls.seeds.length - 1), 'INSTRUCTIONS-43');
  assert.match(calls.attach.at(-1).cmd.at(-1), /--resume/);
  await host.closeAll();
});

test('an Assistant bundle: a new chat gets a fresh copy of its extra files once, its own skills at every start, and a later edit never overwrites the chat\'s copy', async () => {
  withKey(); calls.signedIn = false;
  const { pack } = await import('../src/assistants/bundle.ts');
  const bundle = pack({ 'instructions.md': 'x', 'skills/own/SKILL.md': '---\nname: own\n---\nhi', 'notes/a.md': 'A', 'data.csv': '1,2' });
  db.prepare("INSERT INTO profiles (id, name, agent, instructions, skills, updated_at, bundle) VALUES ('a_bun', 'Bundled', 'claude-acp', 'BASE', '[]', 'v1', ?)").run(bundle);
  const host = mkHost(), conv = newConv(), other = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  db.prepare("UPDATE conversations SET assistant_id = 'a_bun' WHERE id IN (?, ?)").run(conv, other);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'first turn');
  const at = (i: number, p: string) => calls.seeds[i]!.find((x: any) => x.path === p);
  const first = calls.seeds.length - 1;
  assert.equal(at(first, '/tmp/assistant/notes/a.md')?.text, 'A');
  assert.equal(at(first, '/tmp/assistant/data.csv')?.text, '1,2');
  assert.equal(at(first, '/tmp/.claude/skills/own/SKILL.md')?.text, '---\nname: own\n---\nhi', 'a bundled skill reaches the skills dir');
  assert.match(at(first, '/tmp/.claude/CLAUDE.md')!.text, /^BASE\n\nThis Assistant's files are in \/tmp\/assistant\//);
  const newer = pack({ 'notes/a.md': 'CHANGED', 'skills/own/SKILL.md': '---\nname: own\n---\nv2' });
  db.prepare("UPDATE profiles SET bundle = ?, updated_at = 'v2' WHERE id = 'a_bun'").run(newer);
  s.prompt('after the edit'); await until(() => w.ends() === 2, 'second turn');
  const last = calls.seeds.length - 1;
  assert.ok(last > first && !at(last, '/tmp/assistant/notes/a.md'), 'the chat\'s copy is written once');
  assert.equal(at(last, '/tmp/.claude/skills/own/SKILL.md')?.text, '---\nname: own\n---\nv2', 'the skills follow the Assistant');
  const w2 = watch(host, other);
  host.session(uid, other).prompt('hello'); await until(() => w2.ends() === 1, 'other chat');
  assert.equal(at(calls.seeds.length - 1, '/tmp/assistant/notes/a.md')?.text, 'CHANGED', 'a new chat copies the current files');
  await host.closeAll();
});

test('hooks are data: a wrong session, a wrong event or garbage changes nothing; a transcript path in a payload is never read', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'turn_end');
  const h = calls.handlers.get(conv)!, sid = calls.ptys.at(-1)!.sid, n = w.events.length;
  const post = (path: string, body: unknown, method = 'POST') => h(new Request(`http://hook${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  for (const [p, b] of [['/hooks/UserPromptSubmit', { session_id: 'other', prompt_id: 'x', prompt: 'forged' }], ['/hooks/Stop', 'not json'], ['/hooks/PermissionRequest', { session_id: 'other', tool_name: 'Write' }], ['/hooks/PreToolUse', { session_id: sid, transcript_path: '/etc/passwd', tool_use_id: 't', tool_name: 'Bash', tool_input: {} }]] as const) assert.equal((await post(p, b)).status, 200);
  assert.equal((await post('/hooks/Stop', {}, 'GET')).status, 404);
  assert.ok(!w.events.slice(n).some((e) => e.update.hefyn === 'user' || e.update.hefyn === 'permission'), 'forged session ids are ignored');
  // a nested `claude -p` (a helper) has its own session id and fires the same managed hooks: every event, sub-agent lanes included, is ignored
  const before = w.events.length;
  for (const event of ['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure']) {
    const r = await post(`/hooks/${event}`, { session_id: 'nested-helper', agent_id: 'sub1', agent_type: 'general-purpose', prompt_id: 'n1', prompt: 'x', tool_name: 'Write', tool_input: {}, tool_use_id: 'tn' });
    assert.deepEqual(await r.json(), {}, `${event} gets no decision`);
  }
  assert.equal(w.events.length, before, 'nothing of the helper reached the conversation');
  await host.closeAll();
});

test('own Claude account: signed in = no base URL, no key, the Anthropic proxy, the Claude home as config dir; flows and schedules stay on the API key', async () => {
  withKey(); calls.signedIn = true;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('say hi'); await until(() => w.ends() === 1, 'turn_end');
  const at = calls.attach.filter((a) => a.conv === conv).at(-1);
  assert.equal(at.env.ANTHROPIC_BASE_URL, undefined); assert.equal(at.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(at.env.CLAUDE_CONFIG_DIR, '/claude-home'); assert.equal(at.env.HTTPS_PROXY, 'http://127.0.0.1:47001'); assert.match(at.env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(at.cmd.at(-1), /ln -sfn \/tmp\/\.claude\/projects \/claude-home\/projects; /, 'transcripts stay in the conversation\'s /tmp');
  assert.ok(JSON.parse(at.env.HEFYN_SEED).every((x: any) => x.path.startsWith('/claude-home/')), 'seeds follow the config dir');
  assert.deepEqual(calls.auth, [conv], 'the proxy is served for this conversation');
  await host.closeAll();
  // unattended (a flow step): the key path, even though the user is signed in
  const conv2 = newConv(), s2 = host.session(uid, conv2), w2 = watch(host, conv2);
  s2.unattended = true; s2.prompt('say hi'); await until(() => w2.ends() === 1, 'unattended turn');
  const at2 = calls.attach.filter((a) => a.conv === conv2).at(-1);
  assert.equal(at2.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47000'); assert.equal(at2.env.CLAUDE_CONFIG_DIR, '/tmp/.claude');
  await host.closeAll();
});

test('no key and not signed in: a plain message, no process; unattended with only a login says so', async () => {
  db.prepare("DELETE FROM providers WHERE id = 'anthropic'").run(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv), before = calls.attach.length;
  s.prompt('say hi'); await until(() => w.ends() === 1, 'turn_end');
  const e = w.events.find((x) => x.update.hefyn === 'error').update.message;
  assert.match(e, /No Anthropic API key is connected yet\. Connect one under Settings, Agents & keys\. Or sign in to Claude Code with your own account: Settings, Agent accounts\./);
  assert.equal(w.events.find((x) => x.update.hefyn === 'turn_end').update.stopReason, 'error');
  assert.equal(calls.attach.length, before);
  calls.signedIn = true;
  const conv2 = newConv(), s2 = host.session(uid, conv2), w2 = watch(host, conv2);
  s2.unattended = true; s2.prompt('x'); await until(() => w2.ends() === 1, 'turn_end');
  assert.match(w2.events.find((x) => x.update.hefyn === 'error').update.message, /Unattended runs \(schedules, flows\) use an API key, never a personal Claude account/);
  await host.closeAll();
});

test('an API error ends the turn with its message; a turn with no output says so; idle PTYs are closed, busy ones are not', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(50), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('fail please'); await until(() => w.ends() === 1, 'turn_end');
  assert.equal(w.events.find((e) => e.update.hefyn === 'error').update.message, 'API Error: 400 nope');
  assert.equal(w.events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'error');
  s.prompt('silent one'); await until(() => w.ends() === 2, 'second');
  assert.match(w.events.filter((e) => e.update.hefyn === 'error').at(-1).update.message, /stopped without answering/);
  await s.openTerminal(80, 24);
  const stopTerm = s.terminalStream(() => {}, () => {}, () => {});
  s.sweep(Date.now() + 10_000);
  assert.ok(!w.events.some((e) => e.update.state === 'stopped'), 'a watched terminal keeps it');
  stopTerm();
  const procs = calls.attach.length;
  s.sweep(Date.now() + 10_000);
  assert.ok(w.events.some((e) => e.update.state === 'stopped'), 'an open chat page does not count as use: the idle agent is given up');
  w.stop();
  const w4 = watch(host, conv, w.events.at(-1).seq);
  s.prompt('back'); await until(() => w4.ends() === 1, 'a new PTY after the idle one was closed');
  assert.equal(calls.attach.length, procs + 1);
  const s3 = host.session(uid, newConv());
  s3.prompt('hang forever'); const w3 = watch(host, (s3 as any).conversationId); await until(() => w3.has('turn_start'), 'busy');
  s3.sweep(Date.now() + 1e9);
  assert.ok(!w3.events.some((e) => e.update.state === 'stopped'), 'a busy PTY stays');
  await host.closeAll();
});

test('a tool card keeps the transcript\'s order: the text before it first, even when the tool\'s hook is faster; separate text blocks are separate paragraphs', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('please be late'); await until(() => w.ends() === 1, 'turn_end');
  const k = w.events.map((e) => e.update.sessionUpdate ?? e.update.hefyn);
  const say = w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').map((e) => e.update.content.text);
  assert.ok(say[0] === 'Let me look.' && k.indexOf('agent_message_chunk') < k.indexOf('tool_call'), `text first, then the card: ${k.join()}`);
  assert.equal(k.filter((x) => x === 'tool_call').length, 1);
  assert.deepEqual(say.slice(1, 3), ['Found one file.', '\n\nDone.']);
  assert.equal(w.events.filter((e) => e.update.sessionUpdate === 'tool_call_update').at(-1).update.status, 'completed');
  await host.closeAll();
});

test('a message to a sub-agent is forwarded by the main agent: logged in its lane, not as a main prompt; a stop asks for TaskStop; unknown ids are refused', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  assert.throws(() => s.prompt('hi', undefined, { agent: 'a1b2c3', action: 'message' }), (e: any) => e.status === 400, 'no such sub-agent yet');
  s.prompt('run the subagent'); await until(() => w.has('permission'), 'the sub-agent\'s question');
  s.answer(w.events.find((e) => e.update.hefyn === 'permission').update.requestId, 'allow');
  await until(() => w.ends() === 1, 'turn_end');
  assert.throws(() => s.prompt('hi', undefined, { agent: 'zzz', action: 'message' }), (e: any) => e.status === 400);
  assert.throws(() => s.prompt('hi', undefined, { agent: '../x', action: 'message' }), (e: any) => e.status === 400);
  const mains = () => w.events.filter((e) => e.update.hefyn === 'user' && !e.update.agent).length, before = mains();
  s.prompt('hello there', undefined, { agent: 'a1b2c3', action: 'message' });
  await until(() => w.ends() === 2, 'second turn_end');
  const sent = calls.ptys.at(-1)!.got.join('');
  assert.ok(sent.includes('SendMessage') && sent.includes('a1b2c3') && sent.includes('<message>\nhello there\n</message>'), 'the wrapper reached the PTY');
  assert.deepEqual(w.events.filter((e) => e.update.hefyn === 'user' && e.update.agent === 'a1b2c3').map((e) => e.update.text), ['SUBTASK', 'hello there']);
  assert.equal(mains(), before, 'neither the wrapper nor its echo became a main prompt');
  s.prompt('', undefined, { agent: 'a1b2c3', action: 'stop' });
  await until(() => w.ends() === 3, 'third turn_end');
  assert.ok(calls.ptys.at(-1)!.got.join('').includes('TaskStop tool to stop the background sub-agent a1b2c3'));
  assert.equal(mains(), before);
  await host.closeAll();
});

test('a sub-agent is a session of its own: its lines and tools are logged in its lane, a question from it is a card in the main view, it ends with its Stop', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('run the subagent'); await until(() => w.has('permission'), 'the sub-agent\'s question');
  const q = w.events.find((e) => e.update.hefyn === 'permission').update;
  assert.equal(q.by, 'a1b2c3'); assert.equal(q.toolCall.title, 'Write /files/sub.txt'); assert.equal(q.toolCall.toolCallId, 'toolu_sw1', 'matched to the sub-agent\'s own PreToolUse');
  const row = () => db.prepare('SELECT state, agents FROM chat_activity WHERE conversation_id = ?').get(conv) as { state: string; agents: string | null } | undefined;
  assert.deepEqual(JSON.parse(row()!.agents!), [{ id: 'a1b2c3', name: 'Quiet check', kind: 'agent', state: 'waiting', ask: 'Write' }], 'the sidebar of other chats lists the sub-agent with its id and what it asks');
  const start = w.events.find((e) => e.update.hefyn === 'subagent').update;
  assert.deepEqual(start, { hefyn: 'subagent', agentId: 'a1b2c3', status: 'running', type: 'general-purpose', description: 'Quiet check', toolCallId: 'toolu_agent1' });
  s.answer(q.requestId, 'allow');
  await until(() => w.ends() === 1, 'turn_end');
  assert.deepEqual(calls.answers.at(-1), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const lane = w.events.filter((e) => e.update.agent === 'a1b2c3').map((e) => e.update);
  assert.deepEqual(lane.map((u) => u.hefyn ?? u.sessionUpdate), ['user', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call_update', 'agent_message_chunk'], 'brief, text, the Write with its progress and result, the closing text: all in the sub-agent\'s lane');
  assert.equal(lane[0].text, 'SUBTASK'); assert.equal(lane[4].status, 'completed');
  assert.ok(w.events.some((e) => e.update.hefyn === 'subagent' && e.update.status === 'done'), 'SubagentStop ends it');
  assert.equal(row()?.agents ?? null, null, 'no active sub-agent is listed once it ended');
  const main = w.events.filter((e) => !e.update.agent && e.update.sessionUpdate === 'tool_call').map((e) => e.update.toolCallId);
  assert.deepEqual(main, ['toolu_agent1'], 'the main lane shows only the Agent call');
  // a reload replays the same lanes from the sealed log
  const again = watch(host, conv);
  assert.equal(again.events.filter((e) => e.update.agent === 'a1b2c3').length, lane.length);
  await host.closeAll();
});

test('a sub-agent\'s question outlives the turn that started it; Stop closes it and so does the process ending', async () => {
  withKey(); calls.signedIn = false;
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hang around'); await until(() => w.has('turn_start'), 'turn_start');
  const h = calls.handlers.get(conv)!, sid = calls.ptys.at(-1)!.sid;
  const post = (event: string, body: object) => h(new Request(`http://hook/hooks/${event}`, { method: 'POST', body: JSON.stringify({ session_id: sid, ...body }) })).then((r) => r.json());
  const input = { file_path: '/files/b.txt', content: 'x' };
  await post('SubagentStart', { agent_id: 'bg1', agent_type: 'general-purpose' });
  const answered = post('PermissionRequest', { agent_id: 'bg1', tool_name: 'Write', tool_input: input });
  await until(() => w.has('permission'), 'card');
  setTimeout(() => tline(conv, sid, { type: 'system', subtype: 'turn_duration', isSidechain: false }), 150);
  await post('Stop', {}); await until(() => w.ends() === 1, 'turn_end');
  assert.ok(!w.events.some((e) => e.update.hefyn === 'permission_resolved'), 'the main turn ended; the background sub-agent still waits for its answer');
  const q = w.events.find((e) => e.update.hefyn === 'permission').update;
  s.answer(q.requestId, 'deny');
  assert.equal(((await answered) as any).hookSpecificOutput.decision.behavior, 'deny');
  await host.closeAll();
});

test('the terminal or a rule of Claude Code\'s own let a tool run while the card is open: the card closes marked "by claude", not as a click', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('write once more'); await until(() => w.has('permission'), 'permission');
  const h = calls.handlers.get(conv)!, sid = calls.ptys.at(-1)!.sid;
  await h(new Request('http://hook/hooks/PostToolUse', { method: 'POST', body: JSON.stringify({ session_id: sid, tool_name: 'Write', tool_use_id: w.events.find((e) => e.update.sessionUpdate === 'tool_call').update.toolCallId, tool_input: { file_path: '/files/out.txt', content: 'hello\n' }, tool_response: { type: 'create' } }) }));
  await until(() => w.events.some((e) => e.update.hefyn === 'permission_resolved'), 'closed');
  assert.deepEqual(w.events.find((e) => e.update.hefyn === 'permission_resolved').update.by, 'claude');
  await host.closeAll();
});

test('at the runner\'s sandbox cap the least recently used idle chat gives its process up and the new one starts; a chat with a turn is never stopped', async () => {
  withKey(); calls.signedIn = false;
  const live = new Set<string>(), CAP = 'sandbox unavailable (429): too many sandbox containers for this user';
  const capped = async (u: string, c: string, spec: any) => {
    if (live.size >= 1 && !live.has(c)) throw new Error(CAP);
    const p = await attach(c)(u, c, spec); live.add(c); p.stream.on('close', () => live.delete(c)); return p;
  };
  const host = new CliHost({ attach: capped, listenModel, signedIn: async () => false, seed: async () => {} }, 3_600_000);
  const c1 = newConv(), s1 = host.session(uid, c1), w1 = watch(host, c1);
  s1.prompt('say hi'); await until(() => w1.ends() === 1, 'first chat answered');
  assert.deepEqual([...live], [c1]);
  const c2 = newConv(), s2 = host.session(uid, c2), w2 = watch(host, c2);
  s2.prompt('say hi'); await until(() => w2.ends() === 1, 'second chat starts after the first gave up its process', 8000);
  assert.deepEqual([...live], [c2]);
  assert.ok(w1.events.some((e) => e.update.state === 'stopped'));
  // now the one that holds the sandbox is working: the next chat is refused, nobody is killed
  s2.prompt('hang on'); await until(() => w2.events.filter((e) => e.update.hefyn === 'turn_start').length === 2, 'working');
  const c3 = newConv(), s3 = host.session(uid, c3), w3 = watch(host, c3);
  s3.prompt('say hi'); await until(() => w3.ends() === 1, 'refused');
  assert.match(w3.events.find((e) => e.update.hefyn === 'error').update.message, /too many sandbox containers/);
  assert.deepEqual([...live], [c2]);
  await host.closeAll();
});
