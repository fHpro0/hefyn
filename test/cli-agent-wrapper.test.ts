import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): the REAL, unmodified Claude Code (@anthropic-ai/claude-code, installed by the runner's installer container from npm) runs in a PTY in a real
// sandbox; hefyn hosts it (src/cli-agents/host.ts) through a real runner and builds the chat from its own hooks and transcript. Every model request goes to a recording
// stand-in (API-key mode) or to nothing at all (own-account mode, where the allowed Anthropic names are pointed at a local stand-in): no real model API, no login, no
// credentials of this machine are used. The relay containers that stand in for the agent process's sockets: cli-agent-stack.ts.
const TOKEN = 'cli-wrap-token-cli-wrap-token-cli-wrap-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cliwrap-'));
process.env.HEFYN_SECRET = 'cli-wrap-secret-cli-wrap-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: unmodified Claude Code in a PTY: chat from hooks and transcript, one process for both views, own-account mode', { skip, timeout: 1_800_000 }, async (t) => {
  let upstream: http.Server | undefined, anthropicStandIn: net.Server | undefined;
  let host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); upstream?.close(); anthropicStandIn?.close(); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { docker, IMAGE, runnerUrl, listenModel } = stack;
  process.env.HEFYN_RUNNER_URL = runnerUrl;

  // ---- the "model": records requests; a prompt with "WRITEFILE <file>" makes it call Write, "HANGNOW" stalls ----
  const seen: any[] = [];
  const sse = (events: [string, object][]) => events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join('');
  // what the model is asked now: everything after its own last message. A tool_result there makes the request an answer to a tool call; otherwise the texts are the prompt
  // (Claude Code adds reminders of its own around it, which is why the stand-in's commands are the distinctive WRITEFILE and HANGNOW)
  const promptOf = (j: any): { result: boolean; text: string } => {
    const msgs: any[] = j.messages ?? [], from = msgs.map((m) => m.role).lastIndexOf('assistant') + 1, tail = msgs.slice(from).flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []));
    return { result: tail.some((c: any) => c.type === 'tool_result'), text: tail.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') };
  };
  upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":7}');
      let j: any = {}; try { j = JSON.parse(raw); } catch { /* not ours */ }
      const title = /Write the title/.test(raw.slice(-600)), p = promptOf(j);
      seen.push({ url: req.url, key: req.headers['x-api-key'], raw, j, title, text: p.text, result: p.result });
      const mid = `msg_${seen.length}`; // unique: Claude Code merges the blocks of one message id into a single message
      if (!j.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: mid, type: 'message', role: 'assistant', model: j.model ?? 'x', content: [{ type: 'text', text: 'Title' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
      if (!title && !p.result && /HANGNOW/.test(p.text) && !/Request interrupted/.test(raw)) return; // stalls: Stop interrupts it
      const file = /WRITEFILE (\S+)/.exec(p.text)?.[1];
      const blocks: any[] = title ? [{ type: 'text', text: 'A title' }]
        : !p.result && file ? [{ type: 'thinking', thinking: 'I will write the file.', signature: 's' }, { type: 'text', text: 'Writing the file.' }, { type: 'tool_use', id: `toolu_${seen.length}`, name: 'Write', input: { file_path: `/files/${file}`, content: `hello ${file}\n` } }]
        : [{ type: 'text', text: p.result ? 'Done, the file is written.' : `ok: ${p.text.slice(0, 60)}` }];
      const ev: [string, object][] = [['message_start', { message: { id: mid, type: 'message', role: 'assistant', model: j.model ?? 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }]];
      blocks.forEach((b, i) => {
        if (b.type === 'text') ev.push(['content_block_start', { index: i, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } }]);
        else if (b.type === 'thinking') ev.push(['content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }], ['content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } }], ['content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } }]);
        else ev.push(['content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }], ['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
        ev.push(['content_block_stop', { index: i }]);
      });
      ev.push(['message_delta', { delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}]);
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(ev));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => upstream!.once('listening', r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // ---- what the own-account proxy dials instead of Anthropic: a TCP stand-in that records who was asked for ----
  const dialed: string[] = [];
  anthropicStandIn = net.createServer((c) => { c.on('error', () => {}); c.end(); }).listen(0, '0.0.0.0');
  await new Promise((r) => anthropicStandIn!.once('listening', r));
  const standInPort = (anthropicStandIn.address() as AddressInfo).port;

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { connect } = await import('../src/server/providers.ts');
  const { CliHost, runnerSeed } = await import('../src/cli-agents/host.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  const { containerFs } = await import('../src/server/container-fs.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey()); vault.rememberUserKey('bob', vault.newKey());
  connect({ id: 'anthropic', baseUrl: upstreamUrl }, 'sk-ant-company');
  const conv = `u_alice_01WRAP${run}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, 'claude-code', 'chat')").run(conv, new Date().toISOString());

  // ---- install the real Claude Code the way an admin does: the bundled registry entry (pinned npm package), the installer container, the hefyn-agents volume ----
  const { bundledRegistry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const entry = bundledRegistry().find((a) => a.id === 'claude-acp')!;
  assert.match(entry.distribution.npx!.package, /^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
  const done = await stack.install(installRequest(entry, profileOf('claude-acp')!));
  assert.deepEqual(done, { state: 'ready' }, JSON.stringify(done));
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', ?, 'ready', 1, '[]', ?)").run(entry.version, new Date().toISOString());

  const attaches: any[] = [], attachReal = runnerAttach({ url: runnerUrl, token: TOKEN });
  const h = new CliHost({
    attach: (u, c, spec) => (attaches.push({ ...spec, conv: c, user: u }), attachReal(u, c, spec)),
    listenModel, listenAuth: (u, c) => stack.listenAuth(u, c, (host, port) => (dialed.push(`${host}:${port}`), { host: '127.0.0.1', port: standInPort })),
    transcript: stack.transcript, seed: runnerSeed({ runnerUrl, token: TOKEN }),
  });
  host = h;
  // every subtest's failure is printed in full (the runner summarises only the first)
  const step = (name: string, fn: () => void | Promise<void>) => t.test(name, async () => { try { await fn(); } catch (e) { console.error(`SUBTEST FAILED: ${name}\n${(e as Error).stack ?? e}`); throw e; } });
  const sbx = (c = conv) => docker('ps', '-q', '--filter', `label=hefyn.conversation=${c}`).trim().split('\n')[0]!;
  const inBox = (c: string, cmd: string) => { try { return execFileSync('docker', ['exec', sbx(c), 'sh', '-c', cmd], { encoding: 'utf8', stdio: 'pipe' }); } catch { return undefined; } };
  const s = h.session('alice', conv), events: any[] = [];
  s.subscribe(0, (e) => events.push(e));
  const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.slice(-8).map((e) => e.update))}; model requests: ${JSON.stringify(seen.slice(-4).map((x) => ({ title: x.title, result: x.result, text: x.text.slice(0, 80), last: JSON.stringify(x.j.messages?.at(-1)?.content ?? '').slice(0, 200) })))}`); };
  const ends = () => events.filter((e) => e.update.hefyn === 'turn_end').length;
  const kinds = () => events.map((e) => e.update.hefyn ?? e.update.sessionUpdate);

  await step('chat: text, thinking and a tool call render; the permission is answered from the chat and the file is written only after Allow', async () => {
    s.prompt('Please WRITEFILE out.txt now');
    await until(() => events.some((e) => e.update.hefyn === 'permission'), 'permission');
    const q = events.find((e) => e.update.hefyn === 'permission').update;
    assert.equal(q.toolCall.title, 'Write /files/out.txt');
    assert.deepEqual(q.options.map((o: any) => o.optionId), ['allow', 'allow_session', 'deny']);
    await new Promise((r) => setTimeout(r, 1500)); // Claude Code is waiting on the hook: nothing is written meanwhile
    assert.equal(inBox(conv, 'test -e /files/out.txt && echo yes'), undefined, 'not written before the answer');
    assert.ok(events.some((e) => e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.text === 'Writing the file.'), 'the text before the tool call is in the chat');
    assert.ok(events.some((e) => e.update.sessionUpdate === 'agent_thought_chunk'), 'thinking too');
    const call = events.find((e) => e.update.sessionUpdate === 'tool_call').update;
    assert.deepEqual(call.content, [{ type: 'diff', path: '/files/out.txt', oldText: null, newText: 'hello out.txt\n' }]);
    s.answer(q.requestId, 'allow');
    await until(() => ends() === 1, 'turn_end');
    assert.equal(inBox(conv, 'cat /files/out.txt'), 'hello out.txt\n', 'written after Allow');
    assert.equal(events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'end_turn');
    assert.equal(events.filter((e) => e.update.sessionUpdate === 'tool_call_update').at(-1).update.status, 'completed');
    assert.ok(events.some((e) => e.update.sessionUpdate === 'agent_message_chunk' && /Done, the file is written/.test(e.update.content.text)));
    assert.equal(events.filter((e) => e.update.hefyn === 'user').length, 1, 'the prompt is logged once');
    assert.ok(seen.length > 0 && seen.every((x) => x.key === 'sk-ant-company'), 'the gateway swapped the dummy key for the connected one');
    const main = seen.filter((x) => Array.isArray(x.j.tools) && x.j.tools.length).at(-1), tools = main.j.tools.map((x: any) => x.name);
    assert.ok(tools.includes('Write') && tools.includes('Bash'), `Claude Code's own tools: ${tools}`);
    assert.ok(!tools.includes('WebSearch') && !tools.includes('WebFetch'), `managed settings deny the web tools: ${tools}`);
    assert.match(inBox(conv, 'cat /etc/claude-code/managed-settings.json')!, /allowedHttpHookUrls/);
    // a refusal reaches Claude Code as a denial: the file is never written
    const n = events.length;
    s.prompt('Please WRITEFILE refused.txt');
    await until(() => events.filter((e) => e.update.hefyn === 'permission').length === 2, 'second question');
    s.answer(events.filter((e) => e.update.hefyn === 'permission')[1].update.requestId, 'deny');
    await until(() => ends() === 2, 'second turn_end');
    assert.equal(inBox(conv, 'test -e /files/refused.txt && echo yes'), undefined);
    assert.equal(events.slice(n).filter((e) => e.update.sessionUpdate === 'tool_call_update').at(-1).update.status, 'failed');
    assert.equal(attaches.filter((a) => a.conv === conv).length, 1, 'one process for all of it');
  });

  await step('Stop interrupts a turn at once, nothing stray reaches the model, and the next prompt gets a real answer', async () => {
    const reqs = seen.length;
    s.prompt('please HANGNOW');
    await until(() => seen.length > reqs && seen.slice(reqs).some((x) => !x.title && /HANGNOW/.test(x.text)), 'the request reached the model', 60_000);
    await s.cancel();
    await until(() => ends() === 3, 'cancelled turn ends', 15_000);
    assert.equal(events.filter((e) => e.update.hefyn === 'turn_end').at(-1).update.stopReason, 'cancelled');
    const settled = seen.length;
    await new Promise((r) => setTimeout(r, 8000)); // Claude Code may retry the aborted request: the gateway refuses it after Stop
    assert.equal(seen.length, settled, `no stray model requests after Stop: ${JSON.stringify(seen.slice(settled).map((x) => x.text.slice(0, 80)))}`);
    const ev = events.length;
    s.prompt('say ok again');
    await until(() => ends() === 4, 'next turn ends', 90_000);
    const mine = events.slice(ev);
    assert.equal(mine.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'end_turn', JSON.stringify(mine.map((e) => e.update)));
    assert.ok(mine.some((e) => e.update.sessionUpdate === 'agent_message_chunk' && /^ok: say ok again/.test(e.update.content.text)), JSON.stringify(mine.map((e) => e.update)));
    assert.equal(attaches.filter((a) => a.conv === conv).length, 1, 'still the same process');
  });

  await step('terminal and chat are one session: the terminal shows the chat\'s conversation, and what is typed there shows in the chat', async () => {
    await s.openTerminal(120, 32, 'dark');
    assert.equal(attaches.filter((a) => a.conv === conv).length, 1, 'no second process');
    let first!: Buffer; const chunks: Buffer[] = [];
    const stop = s.terminalStream((b) => (first = b), (b) => chunks.push(b), () => {});
    const screen = () => Buffer.concat([first, ...chunks]).toString('utf8').replace(/\x1b\[(\d*)C/g, (_, k) => ' '.repeat(Number(k) || 1)).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    assert.match(screen().replace(/\s/g, ''), /PleaseWRITEFILEout\.txtnow/,'the chat\'s first message is on the terminal screen');
    assert.ok(!/Choose the text style|trust this folder|Welcome to Claude Code|Make auto mode/i.test(screen()), 'no onboarding, trust or auto-mode dialog');
    const reqs = seen.length, ev = events.length;
    s.terminalInput('\x1b[200~typed in the terminal\x1b[201~'); // what a browser's paste looks like
    await new Promise((r) => setTimeout(r, 300));
    s.terminalInput('\r');
    await until(() => ends() === 5, 'a turn typed in the terminal ends', 90_000);
    assert.ok(events.slice(ev).some((e) => e.update.hefyn === 'user' && e.update.text === 'typed in the terminal'), 'the chat shows the prompt typed in the terminal');
    assert.ok(events.slice(ev).some((e) => e.update.sessionUpdate === 'agent_message_chunk' && /typed in the terminal/.test(e.update.content.text)), 'and the answer');
    assert.ok(seen.slice(reqs).length > 0);
    const cfg = JSON.parse(inBox(conv, 'cat /tmp/.claude/.claude.json')!);
    assert.equal(cfg.hasSeenAutoDefaultNudge, true);
    s.prompt('and from the chat again'); await until(() => ends() === 6, 'chat after the terminal', 90_000);
    stop();
    assert.equal(attaches.filter((a) => a.conv === conv).length, 1);
  });

  await step('resume after the PTY ended: the same session id, Claude Code\'s own --resume, and the model still has the conversation', async () => {
    const sid = (db.prepare('SELECT acp_session FROM conversations WHERE id = ?').get(conv) as any).acp_session;
    assert.match(sid, /^[0-9a-f-]{36}$/);
    s.closeTerminal();
    await until(() => events.some((e) => e.update.state === 'stopped'), 'stopped');
    const reqs = seen.length, ev = events.length, said = () => events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.text === 'Writing the file.').length, before = said();
    s.prompt('what did I ask first?');
    await until(() => ends() === 7, 'turn after the resume', 120_000);
    assert.equal(attaches.filter((a) => a.conv === conv).length, 2);
    const cmdline = inBox(conv, 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep claude-code-linux');
    assert.match(cmdline ?? '', new RegExp(`--resume ${sid}`), 'Claude Code was started with --resume');
    const last = seen.slice(reqs).filter((x) => !x.title).at(-1)!;
    assert.ok(last.raw.includes('Please WRITEFILE out.txt now'),'the earlier conversation is in the model\'s context');
    assert.equal(events.slice(ev).filter((e) => e.update.hefyn === 'user').length, 1, 'what the transcript held before is not logged twice');
    assert.equal(said(), before, 'what the first run wrote is not read again after the resume');
    s.closeTerminal();
  });

  await step('an Assistant on Claude Code: its model, instructions and skill reach the real binary; an admin\'s edit applies at the next message and the session goes on', async () => {
    await import('../src/server/hub.ts'); // creates the Hub tables
    db.prepare(`INSERT INTO packages (id, kind, name, description, version, hash, source_json, visibility, status, owner_id, manifest_json, guard_json, approved_json, created_at, updated_at)
      VALUES ('sk_tone', 'skill', 'tone', 'Formal tone', '1', 'h', '{"type":"ui"}', 'team', 'approved', 'x', '{}', '{"flagged":false,"reasons":[]}', ?, 'now', 'now')`).run(JSON.stringify({
      version: '1', hash: 'h', manifest: { items: { skills: [{ name: 'tone', description: 'Formal tone ASSISTANT-SKILL-77', instructions: 'Be formal.', files: { 'refs/a.md': 'A' } }], agents: [], mcp: [] }, ignored: [], needsRunner: [] },
      files: { 'SKILL.md': '---\nname: tone\ndescription: Formal tone ASSISTANT-SKILL-77\n---\nBe formal.\n', 'refs/a.md': 'A' },
    }));
    const MODEL = 'claude-sonnet-4-5', ac = `u_alice_01ASST${run}`;
    db.prepare("INSERT INTO profiles (id, name, agent, model, instructions, skills, updated_at) VALUES ('a_cc', 'Coder', 'claude-acp', ?, 'ASSISTANT-INSTRUCTIONS-42: always answer in one short sentence.', '[\"sk_tone\"]', 'v1')").run(MODEL);
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view, assistant_id) VALUES (?, 'alice', 'x', ?, 'claude-code', 'chat', 'a_cc')").run(ac, new Date().toISOString());
    const sa = h.session('alice', ac), eva: any[] = [];
    sa.subscribe(0, (e) => eva.push(e));
    const endsA = () => eva.filter((e) => e.update.hefyn === 'turn_end').length, reqs = seen.length;
    sa.prompt('say ok');
    await until(() => endsA() === 1, 'turn with the Assistant', 120_000);
    const main = seen.slice(reqs).filter((x) => Array.isArray(x.j.tools) && x.j.tools.length).at(-1)!;
    assert.equal(main.j.model, MODEL, `the Assistant's model reached the stand-in (got ${main.j.model})`);
    assert.match(inBox(ac, 'cat /tmp/.claude/CLAUDE.md') ?? '', /^ASSISTANT-INSTRUCTIONS-42/);
    const settings = JSON.parse(inBox(ac, 'cat /tmp/.claude/settings.json') ?? '{}');
    assert.deepEqual([settings.model, settings.permissions?.defaultMode], [MODEL, 'default'], 'the model is merged in: "ask before acting" stays');
    assert.match(inBox(ac, 'cat /tmp/.claude/skills/tone/SKILL.md') ?? '', /ASSISTANT-SKILL-77/);
    assert.ok(seen.slice(reqs).some((x) => x.raw.includes('ASSISTANT-INSTRUCTIONS-42')), 'the instructions reached the model');
    assert.ok(seen.slice(reqs).some((x) => x.raw.includes('ASSISTANT-SKILL-77')), 'the skill is announced to the model');
    // an admin edits the Assistant: the next message restarts Claude Code (--resume) with the new instructions; the removed skill is gone
    db.prepare("UPDATE profiles SET instructions = 'ASSISTANT-INSTRUCTIONS-43: now answer in two words.', skills = '[]', updated_at = 'v2' WHERE id = 'a_cc'").run();
    const r2 = seen.length;
    sa.prompt('say ok a last time'); await until(() => endsA() === 2, 'turn after the edit', 120_000);
    assert.ok(!eva.some((e) => e.update.hefyn === 'error'), `no error: ${JSON.stringify(eva.slice(-12).map((e) => e.update))}`);
    assert.match(inBox(ac, 'cat /tmp/.claude/CLAUDE.md') ?? '', /^ASSISTANT-INSTRUCTIONS-43/);
    assert.equal(inBox(ac, 'cat /tmp/.claude/skills/tone/SKILL.md'), undefined, 'the skill the admin removed is gone');
    assert.ok(seen.slice(r2).some((x) => x.raw.includes('ASSISTANT-INSTRUCTIONS-43')), 'the new instructions reached the model');
    assert.equal(attaches.filter((a) => a.conv === ac).length, 2, 'a second process, resumed');
    assert.match(attaches.filter((a) => a.conv === ac).at(-1).cmd.at(-1), /--resume/);
    sa.closeTerminal();
  });

  await step('own Claude account (no real login possible: a stand-in credentials file): no base URL or dummy key, only the Anthropic proxy, the Claude home of that user only, nothing of it read by hefyn', async () => {
    const own = `u_alice_01OWN${run}`, ownFs = containerFs({ userId: 'alice', conversationId: own, runnerUrl, token: TOKEN });
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, 'claude-code', 'chat')").run(own, new Date().toISOString());
    // the "login": what Claude Code's own login would leave in the home (fake values; a real one cannot be made here)
    await ownFs.run(['sh', '-c', `echo '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-STANDIN","refreshToken":"sk-ant-ort01-STANDIN","expiresAt":4102444800000,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}' > /claude-home/.credentials.json`], { cwd: '/tmp' });
    const so = h.session('alice', own), evs: any[] = [];
    so.subscribe(0, (e) => evs.push(e));
    const reqs = seen.length;
    so.prompt('say hello on my own account');
    await until(() => attaches.some((a) => a.conv === own), 'the PTY started');
    const spec = attaches.find((a) => a.conv === own);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, undefined); assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spec.env.CLAUDE_CONFIG_DIR, '/claude-home'); assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:47001');
    // inside the sandbox, on the running Claude Code
    await until(() => !!inBox(own,'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -q "^CLAUDE_CONFIG_DIR=/claude-home" && echo $p; done; true'), 'claude is running');
    const env = inBox(own, 'for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q claude-code-linux; then tr "\\0" "\\n" < $p/environ; fi; done')!;
    assert.ok(!/^ANTHROPIC_(BASE_URL|API_KEY)=/m.test(env), 'the sandbox has no base URL and no dummy key');
    assert.match(env, /^CLAUDE_CONFIG_DIR=\/claude-home$/m); assert.match(env, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:47001$/m);
    // its only way out is the proxy, which allows Anthropic's hosts and nothing else (the allowed names dial the stand-in; the real hosts are never contacted)
    // asynchronous: the proxy lives in this process (in production, in the agent process), so this process must stay free to answer it while curl waits
    const curl = (args: string) => new Promise<string>((resolve) => execFile('docker', ['exec', sbx(own), 'sh', '-c', `curl -sS -v -m 15 ${args} 2>&1; true`], { encoding: 'utf8' }, (_e, out) => resolve(out)));
    const expectOut = async (args: string, re: RegExp, why: string) => { const out = await curl(args); assert.match(out, re, `${why}; curl said: ${out}`); };
    await expectOut('--noproxy "*" -o /dev/null https://api.anthropic.com/', /Could not resolve host|Couldn't resolve|Network is unreachable|Failed to connect/i, 'no direct route');
    await expectOut('-x http://127.0.0.1:47001 -o /dev/null https://example.org/', /403|CONNECT tunnel failed/i, 'another host is refused');
    assert.doesNotMatch(dialed.join(' '), /example\.org/);
    const before = dialed.length;
    await expectOut('-x http://127.0.0.1:47001 -o /dev/null https://api.anthropic.com/', /200 Connection established/i, 'an Anthropic host is tunnelled (to the stand-in)');
    assert.ok(dialed.slice(before).includes('api.anthropic.com:443'), `the proxy was asked for the real Anthropic name: ${dialed.slice(before)}`);
    assert.ok(dialed.every((d) => ['api.anthropic.com:443', 'platform.claude.com:443', 'claude.ai:443'].includes(d)), `only allowed names ever dialled: ${dialed}`);
    assert.equal(seen.length, reqs, 'no model request went to the API-key stand-in: the model traffic does not pass the gateway');
    // the Claude home belongs to the user: a second sandbox of alice sees it, bob's does not
    const bobConv = `u_bob_01OWN${run}`, bobFs = containerFs({ userId: 'bob', conversationId: bobConv, runnerUrl, token: TOKEN });
    const other = containerFs({ userId: 'alice', conversationId: `u_alice_01OTH${run}`, runnerUrl, token: TOKEN });
    assert.equal((await other.run(['sh', '-c', 'test -s /claude-home/.credentials.json'], { cwd: '/tmp' })).exitCode, 0, 'alice\'s other sandbox shares her home');
    assert.notEqual((await bobFs.run(['sh', '-c', 'test -e /claude-home/.credentials.json'], { cwd: '/tmp' })).exitCode, 0, 'bob\'s home is empty');
    await bobFs.run(['sh', '-c', 'echo bobs > /claude-home/marker'], { cwd: '/tmp' });
    assert.notEqual((await other.run(['sh', '-c', 'test -e /claude-home/marker'], { cwd: '/tmp' })).exitCode, 0, 'and alice cannot see his');
    const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', sbx(own))).map((m: any) => m.Destination).sort();
    assert.deepEqual(mounts, ['/accounts', '/claude-home', '/files', '/opt/agents', '/tmp'], 'the sandbox has exactly the user\'s own mounts');
    assert.equal(inBox(own, 'ls /claude-home/projects >/dev/null 2>&1 && readlink /claude-home/projects')?.trim(), '/tmp/.claude/projects', 'transcripts live in the conversation\'s /tmp, not in the home');
    await so.cancel(); so.closeTerminal();
  });

  await step('no hefyn code path reads the Claude home or its credentials', () => {
    // static: nothing in src/ names the credentials file or the home except own-account.ts, which only passes them to the sandbox (a size test through the runner) and never opens a file
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
    const files = walk(join(import.meta.dirname, '../src'));
    const naming = files.filter((f) => /claude-home|\.credentials\.json/.test(readFileSync(f, 'utf8'))).map((f) => f.split('/src/')[1]);
    assert.deepEqual(naming, ['cli-agents/own-account.ts']);
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, '../src/cli-agents/own-account.ts'), 'utf8').replace(/\/\/.*$/gm, ''), /readFile|readFileSync|openSync|createReadStream|statSync|existsSync|copyFile|readdir/, 'own-account.ts opens no file');
    // dynamic: the data directory of this process has no Claude home at all (the sandboxes' volume is elsewhere), and the sealed credential store of the old design is gone
    assert.deepEqual(files.filter((f) => /personal|signin\.ts/.test(f.split('/').pop()!)), []);
    assert.ok(!readdirSync(process.env.HEFYN_DATA_DIR!, { recursive: true }).some((f) => /claude-home|credentials/.test(String(f))));
  });
});
