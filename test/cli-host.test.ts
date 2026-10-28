import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Agent } from '@agentclientprotocol/sdk';
import { Hono } from 'hono';
import { trpcCall } from './trpc.ts';

// The CLI-agent host (src/cli-agents/host.ts, routes.ts) without Docker: an injected transport whose "sandbox process" is a fake ACP agent built on the
// SDK's AgentSideConnection (or an echoing PTY), and a recording stand-in for the model socket.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-clihost-'));
process.env.HEFYN_SECRET = 'cli-host-secret-cli-host-secret-123456';
process.env.HEFYN_RUNNER_URL = 'http://runner.invalid:8790';

const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { CliHost } = await import('../src/cli-agents/host.ts');
const { cliRoutes } = await import('../src/cli-agents/routes.ts');
const { purgeConversations } = await import('../src/server/chats.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');

vault.setTeamKey(vault.newKey());
// The ACP path of the host, tested with OpenCode (an ACP agent on the Anthropic front); Claude Code runs in a PTY instead (test/cli-wrapper-host.test.ts). Both turned on for every role.
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '2.1.310', 'ready', 1, '[]', ?), ('opencode', '1.19.4', 'ready', 1, '[]', ?)").run(new Date().toISOString(), new Date().toISOString());
const uid = 'alice';
vault.rememberUserKey(uid, vault.newKey());
let n = 0;
const newConv = (agent: string | null = 'opencode', userId = uid) => {
  const id = `u_${userId}_01HOST${String(++n).padStart(3, '0')}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?,?,?,?,?, 'chat')").run(id, userId, 'x', new Date().toISOString(), agent);
  return id;
};

// ---- the sandbox side ----
const calls = { attach: [] as any[], loads: [] as string[], news: 0, resizes: [] as [number, number][], modelOpen: 0, modelClosed: 0, cancels: 0, handlers: [] as ((r: Request) => Promise<Response>)[], alive: new Map<string, boolean>() };
function fakeAgent(conn: AgentSideConnection): Agent {
  let release: (() => void) | undefined;
  return {
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    newSession: async () => (calls.news++, { sessionId: '11111111-2222-3333-4444-555555555555' }),
    loadSession: async (p) => { calls.loads.push(p.sessionId); await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } } }); return {}; },
    authenticate: async () => ({}),
    cancel: async () => { calls.cancels++; release?.(); },
    prompt: async (p) => {
      const text = (p.prompt[0] as any).text as string, sessionId = p.sessionId;
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } }); // an echo of the prompt: not to be logged
      if (text.includes('orphan')) { void conn.requestPermission({ sessionId, toolCall: { toolCallId: 't2', title: 'x' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }).catch(() => {}); return { stopReason: 'cancelled' }; } // gives up on its question
      if (text.includes('silent')) return { stopReason: 'end_turn' }; // ends with nothing to show
      if (text.includes('slow')) { await new Promise<void>((r) => (release = r)); return { stopReason: 'cancelled' }; }
      if (text.includes('ask')) {
        const r = await conn.requestPermission({ sessionId, toolCall: { toolCallId: 't1', title: 'Write a file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `outcome ${r.outcome.outcome === 'selected' ? r.outcome.optionId : r.outcome.outcome}` } } });
        return { stopReason: 'end_turn' };
      }
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } } });
      return { stopReason: 'end_turn' };
    },
  };
}
const attach = async (_u: string, _c: string, spec: any) => {
  calls.attach.push(spec);
  const toProc = new PassThrough(), fromProc = new PassThrough();
  const stream = Duplex.from({ readable: fromProc, writable: toProc } as any) as Duplex;
  if (spec.tty) { // a PTY: echoes what it is given, after a greeting
    fromProc.write('welcome\r\n');
    toProc.on('data', (d) => fromProc.write(d));
  } else new AgentSideConnection(fakeAgent, ndJsonStream(Writable.toWeb(fromProc) as any, Readable.toWeb(toProc) as any));
  stream.on('close', () => { toProc.destroy(); fromProc.destroy(); });
  return { stream, resize: async (c: number, r: number) => void calls.resizes.push([c, r]) };
};
const listenModel = async (_u: string, c: string, handler: (r: Request) => Promise<Response>) => {
  // like the real socket: creating takes a moment, closing removes the file at the path (also a newer socket's)
  await new Promise((r) => setTimeout(r, 5)); calls.modelOpen++; calls.handlers.push(handler); calls.alive.set(c, true);
  return { close: async () => { await new Promise((r) => setTimeout(r, 20)); calls.modelClosed++; calls.alive.set(c, false); } };
};
const mkHost = (idleMs?: number) => new CliHost({ attach, listenModel, idleMs }, 3_600_000);

const until = async (f: () => boolean, what: string, ms = 3000) => { for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), `timeout: ${what}`); };
function watch(host: InstanceType<typeof CliHost>, conv: string, after = 0) {
  const events: any[] = [];
  const stop = host.session(uid, conv).subscribe(after, (e) => events.push(e));
  return { events, stop, kinds: () => events.map((e) => e.update.hefyn ?? e.update.sessionUpdate), has: (k: string) => events.some((e) => (e.update.hefyn ?? e.update.sessionUpdate) === k) };
}

test('a prompt: events are persisted in order, replayed with `after`, and the prompt is logged once', async () => {
  const host = mkHost(), conv = newConv();
  const w = watch(host, conv);
  host.session(uid, conv).prompt('hello');
  await until(() => w.has('turn_end'), 'turn_end');
  assert.deepEqual(w.kinds(), ['user', 'status', 'status', 'turn_start', 'agent_message_chunk', 'turn_end']);
  assert.deepEqual(w.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(w.events[0].update, { hefyn: 'user', text: 'hello' });
  assert.deepEqual(w.events.filter((e) => e.update.hefyn === 'status').map((e) => e.update.state), ['starting', 'ready']);
  assert.equal(w.events[4].update.content.text, 'echo: hello');
  assert.equal(w.events[5].update.stopReason, 'end_turn');
  assert.match(w.events[1].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal((db.prepare('SELECT acp_session FROM conversations WHERE id = ?').get(conv) as any).acp_session, '11111111-2222-3333-4444-555555555555');
  const at = calls.attach.at(-1);
  assert.deepEqual([at.cmd, at.tty, at.cwd], [['/opt/hefyn/run-agent.sh', '/opt/agents/opencode/1.19.4/opencode', 'acp'], false, '/files']);
  assert.equal(at.env.ANTHROPIC_API_KEY, 'hefyn-gateway');
  assert.ok(JSON.parse(at.env.HEFYN_SEED).some((s: any) => s.path === '/tmp/.config/opencode/opencode.json'));
  // replay: a late subscriber gets what it missed, then the live ones
  const late = watch(host, conv, 4);
  assert.deepEqual(late.events.map((e) => e.seq), [5, 6]);
  host.session(uid, conv).prompt('again');
  await until(() => late.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'second turn');
  assert.deepEqual(late.events.map((e) => e.seq), [5, 6, 7, 8, 9, 10]);
  assert.equal(calls.news, 1, 'one ACP session for both prompts');
  // sealed at rest
  const rows = db.prepare('SELECT data FROM cli_events WHERE conversation_id = ?').all(conv) as { data: string }[];
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => vault.isSealed(r.data) && !r.data.includes('hello') && !r.data.includes('echo')));
  await host.closeAll();
});

test('a new host resumes the stored session with session/load and does not log the replay', async () => {
  const conv = newConv();
  const a = mkHost();
  a.session(uid, conv).prompt('one');
  const wa = watch(a, conv); await until(() => wa.has('turn_end'), 'first turn');
  await a.closeAll(); // the agent process went away
  assert.ok(wa.events.some((e) => e.update.state === 'stopped'));
  const b = mkHost(), wb = watch(b, conv, wa.events.at(-1).seq + 1);
  b.session(uid, conv).prompt('two');
  await until(() => wb.has('turn_end'), 'second turn');
  assert.deepEqual(calls.loads.at(-1), '11111111-2222-3333-4444-555555555555');
  const all = db.prepare('SELECT data FROM cli_events WHERE conversation_id = ?').all(conv).map((r: any) => JSON.parse(vault.openForUser(uid, r.data, `cli:${conv}:${(db.prepare('SELECT seq FROM cli_events WHERE data = ?').get(r.data) as any).seq}`)));
  assert.ok(!JSON.stringify(all).includes('REPLAYED'), 'history replayed by session/load is already in the log');
  assert.equal(wb.events.find((e) => e.update.sessionUpdate === 'agent_message_chunk').update.content.text, 'echo: two');
  await b.closeAll();
});

test('an ACP agent cannot be asked to message a sub-agent', () => {
  const s = mkHost().session(uid, newConv());
  assert.throws(() => s.prompt('hi', undefined, { agent: 'a1b2c3', action: 'message' }), (e: any) => e.status === 409 && /cannot be messaged/.test(e.message));
});

test('a second prompt while a turn runs is refused; cancel ends the turn', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('slow please');
  assert.throws(() => s.prompt('more'), (e: any) => e.status === 409 && /still answering/.test(e.message));
  await until(() => w.has('turn_start'), 'turn_start');
  await s.cancel();
  await until(() => w.has('turn_end'), 'turn_end');
  assert.equal(w.events.find((e) => e.update.hefyn === 'turn_end').update.stopReason, 'cancelled');
  s.prompt('after'); // free again
  await until(() => w.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'next turn');
  await host.closeAll();
});

test('a turn that ends with no output says so, before its turn_end', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('silent');
  await until(() => w.has('turn_end'), 'turn_end');
  const k = w.kinds();
  assert.ok(k.indexOf('error') > 0 && k.indexOf('error') < k.indexOf('turn_end'), k.join());
  assert.match(w.events.find((e) => e.update.hefyn === 'error').update.message, /stopped without answering/);
  await host.closeAll();
});

test('after Stop the same agent process answers the next prompt (no replacement)', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('slow');
  await until(() => w.has('turn_start'), 'turn_start');
  const attaches = calls.attach.length;
  await s.cancel();
  await until(() => w.has('turn_end'), 'turn_end');
  s.prompt('again');
  await until(() => w.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'next turn');
  assert.equal(calls.attach.length, attaches, 'no new agent process');
  assert.equal(w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text, 'echo: again');
  assert.ok(!w.events.some((e) => e.update.hefyn === 'error'));
  await host.closeAll();
});

test('a refusal by the model gateway reaches the conversation at once, as a plain error event, and cannot be retried', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hi');
  await until(() => w.has('turn_end'), 'turn_end');
  const handler = calls.handlers.at(-1)!; // the real gateway; no model connected in this test, so it refuses
  const res = await handler(new Request('http://gateway/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-should-retry'), 'false');
  const e = w.events.filter((x) => x.update.hefyn === 'error').at(-1);
  assert.equal(e.update.message, ((await res.json()) as any).error.message);
  assert.match(e.update.message, /Nothing was sent to the model/);
  await host.closeAll();
});

test('the key the admin picked for the agent is what the socket\'s gateway uses (company key only, read per request)', async () => {
  const { connectApiKey } = await import('../src/server/connectors.ts');
  connectApiKey(uid, { id: 'anthropic' }, 'sk-ant-alice-own'); // the user has a key; no company key is connected in this test
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hi');
  await until(() => w.has('turn_end'), 'turn_end');
  const call = () => calls.handlers.at(-1)!(new Request('http://gateway/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) })).then((r) => r.json() as Promise<any>);
  const auto = await call();
  assert.doesNotMatch(auto.error.message, /No Anthropic API key/, 'automatic: the user\'s own key is found');
  db.prepare("UPDATE cli_agents SET key_provider = 'anthropic' WHERE id = 'opencode'").run();
  assert.match((await call()).error.message, /No Anthropic API key/, 'pinned: only the company\'s key counts');
  db.prepare('UPDATE cli_agents SET key_provider = NULL WHERE id = ?').run('opencode');
  db.prepare("DELETE FROM user_credentials WHERE provider = 'anthropic'").run();
  await host.closeAll();
});

test('a helper CLI reaches the socket under /a/<agent>: that agent\'s key policy applies, and only helpers the Assistant declares', async () => {
  const { connectApiKey } = await import('../src/server/connectors.ts');
  const { writeAssistant } = await import('../src/server/assistant-store.ts');
  const { simpleFlow } = await import('../src/assistants/flow.ts');
  connectApiKey(uid, { id: 'anthropic' }, 'sk-ant-alice-own');
  const a = writeAssistant({ name: 'With helper', description: '', icon: 'Sparkles', inputs: { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 }, roles: [], flow: simpleFlow({ agent: 'opencode' }), helpers: [{ role: 'review', agent: 'claude-code' }] });
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  db.prepare('UPDATE conversations SET assistant_id = ? WHERE id = ?').run(a.id, conv);
  s.prompt('hi');
  await until(() => w.has('turn_end'), 'turn_end');
  const call = (path: string) => calls.handlers.at(-1)!(new Request(`http://gateway${path}`, { method: 'POST', body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) })).then(async (r) => ({ status: r.status, error: ((await r.json()) as any).error?.message as string }));
  db.prepare("UPDATE cli_agents SET key_provider = 'anthropic' WHERE id = 'claude-acp'").run(); // the helper's agent is pinned to the company's key; the conversation's agent is not
  assert.doesNotMatch((await call('/v1/messages')).error, /No Anthropic API key/, 'the base agent: automatic, the user\'s own key');
  assert.match((await call('/a/claude-acp/v1/messages')).error, /No Anthropic API key/, 'the helper: its own policy (company key only)');
  const other = await call('/a/codex-acp/v1/messages');
  assert.deepEqual([other.status, /does not use that helper/.test(other.error)], [403, true], 'an agent the Assistant does not declare is refused');
  // a role the admin did not allow the helper agent's team key: refused like the base agent would be, before any upstream call
  db.prepare("INSERT INTO team_accounts (agent_id, key_enabled, key_roles, login_enabled, login_roles, login_override) VALUES ('claude-acp', 1, '[\"some-other-role\"]', 0, '[]', 0)").run();
  const denied = await call('/a/claude-acp/v1/messages');
  assert.deepEqual([denied.status, /role may not use the team API key for Claude Code/.test(denied.error), /Nothing was sent to the model/.test(denied.error)], [403, true, true]);
  assert.ok(w.events.some((e) => e.update.hefyn === 'error' && /team API key/.test(e.update.message)), 'the chat says so');
  db.prepare("DELETE FROM team_accounts WHERE agent_id = 'claude-acp'").run();
  db.prepare('UPDATE cli_agents SET key_provider = NULL WHERE id = ?').run('claude-acp');
  db.prepare("DELETE FROM user_credentials WHERE provider = 'anthropic'").run();
  await host.closeAll();
});

test('the model socket outlives the agent process: opening the terminal after a chat turn keeps (or re-creates) it', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hi'); await until(() => w.has('turn_end'), 'turn_end');
  assert.ok(calls.alive.get(conv));
  await s.openTerminal(100, 30, 'light');
  await new Promise((r) => setTimeout(r, 100)); // an old socket's late close must not take the new one with it
  assert.ok(calls.alive.get(conv), 'the PTY has a model socket');
  s.closeTerminal();
  await until(() => !calls.alive.get(conv), 'the socket goes when the last session does');
  await host.closeAll();
});

test('a question still open when the turn ends is closed before turn_end', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('orphan'); await until(() => w.has('turn_end'), 'turn_end');
  const k = w.kinds();
  assert.ok(k.indexOf('permission') > 0 && k.indexOf('permission_resolved') > k.indexOf('permission') && k.indexOf('permission_resolved') < k.indexOf('turn_end'), k.join());
  assert.equal(w.events.find((e) => e.update.hefyn === 'permission_resolved').update.optionId, null);
  await host.closeAll();
});

test('permission round trip: the question is an event, the answer reaches the agent, bad answers are refused', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('please ask');
  await until(() => w.has('permission'), 'permission');
  const q = w.events.find((e) => e.update.hefyn === 'permission').update;
  assert.deepEqual(q.options.map((o: any) => o.optionId), ['allow', 'deny']);
  assert.equal(q.toolCall.title, 'Write a file');
  assert.throws(() => s.answer(q.requestId, 'nope'), (e: any) => e.status === 400);
  assert.throws(() => s.answer('unknown', 'allow'), (e: any) => e.status === 404);
  s.answer(q.requestId, 'allow');
  await until(() => w.has('turn_end'), 'turn_end');
  assert.deepEqual(w.events.find((e) => e.update.hefyn === 'permission_resolved').update, { hefyn: 'permission_resolved', requestId: q.requestId, optionId: 'allow' });
  assert.equal(w.events.find((e) => e.update.sessionUpdate === 'agent_message_chunk').update.content.text, 'outcome allow');
  // null cancels
  s.prompt('ask again');
  await until(() => w.events.filter((e) => e.update.hefyn === 'permission').length === 2, 'second permission');
  s.answer(w.events.filter((e) => e.update.hefyn === 'permission')[1].update.requestId, null);
  await until(() => w.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'second turn_end');
  assert.equal(w.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk')[1].update.content.text, 'outcome cancelled');
  await host.closeAll();
});

test('idle: no turn and no subscriber closes the agent and the model socket; a subscriber keeps it', async () => {
  const host = mkHost(50), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('hi');
  await until(() => w.has('turn_end'), 'turn_end');
  const open = calls.modelOpen, closed = calls.modelClosed;
  s.sweep(Date.now() + 10_000);
  assert.equal(calls.modelClosed, closed, 'a subscriber is still there');
  w.stop();
  s.sweep(Date.now() + 10_000);
  await until(() => calls.modelClosed === closed + 1, 'socket closed');
  assert.equal(calls.modelOpen, open);
  assert.equal((db.prepare('SELECT data FROM cli_events WHERE conversation_id = ? ORDER BY seq DESC').all(conv) as any[]).length, 7); // ..., status stopped
  s.prompt('back'); // lazily resumed: socket again, session/load
  const w2 = watch(host, conv, 7);
  await until(() => w2.has('turn_end'), 'turn after idle');
  assert.equal(calls.modelOpen, open + 1);
  await host.closeAll();
});

test('terminal: opens a PTY with --resume, replays the scrollback first, takes input and resizes; chat and terminal exclude each other', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv);
  const w = watch(host, conv);
  s.prompt('slow');
  await until(() => w.has('turn_start'), 'turn_start');
  await assert.rejects(s.openTerminal(100, 30), (e: any) => e.status === 409 && /answering/.test(e.message));
  await s.cancel(); await until(() => w.has('turn_end'), 'turn_end');
  await s.openTerminal(100, 30);
  const ttys = calls.attach.filter((a) => a.tty).length;
  const spec = calls.attach.at(-1);
  assert.equal(spec.tty, true); assert.deepEqual([spec.cols, spec.rows], [100, 30]);
  assert.match(spec.cmd.at(-1), /^exec \/opt\/agents\/opencode\/1\.19\.4\/opencode\s*$/); // the stored session id is not an OpenCode one: no resume
  assert.throws(() => s.prompt('no'), (e: any) => e.status === 409 && /terminal is open/.test(e.message));
  await s.openTerminal(90, 20); // reuse
  assert.equal(calls.attach.filter((a) => a.tty).length, ttys);
  assert.deepEqual(calls.resizes.at(-1), [90, 20]);
  const chunks: string[] = [];
  let first: Buffer | undefined, ended = false;
  await until(() => true, 'tick'); await new Promise((r) => setTimeout(r, 30));
  const stop = s.terminalStream((b) => (first = b), (b) => chunks.push(b.toString()), () => (ended = true));
  assert.equal(first!.toString(), 'welcome\r\n', 'the scrollback comes first');
  s.terminalInput('ls\r');
  await until(() => chunks.join('') === 'ls\r', 'echo');
  await s.terminalResize(120, 40);
  assert.deepEqual(calls.resizes.at(-1), [120, 40]);
  stop();
  s.sweep(Date.now() + 1e9); // idle: no subscriber, no input
  await until(() => ended || !s.terminalOpen, 'terminal closed by idleness');
  s.prompt('chat again'); // the chat works again
  await until(() => w.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'chat after terminal');
  await host.closeAll();
});

test('activity: a turn is running, an open question is waiting, an open terminal is running only while it prints', async () => {
  const { activityOf, cliState } = await import('../src/server/activity.ts');
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  assert.equal(activityOf(uid)[conv], undefined, 'idle chats are absent');
  s.prompt('slow');
  assert.equal(activityOf(uid)[conv]?.state, 'running');
  await until(() => w.has('turn_start'), 'turn_start');
  await s.cancel(); await until(() => w.has('turn_end'), 'turn_end');
  assert.equal(activityOf(uid)[conv], undefined, 'idle again after the turn');
  s.prompt('please ask');
  await until(() => w.has('permission'), 'permission');
  assert.equal(activityOf(uid)[conv]?.state, 'waiting');
  s.answer(w.events.find((e) => e.update.hefyn === 'permission').update.requestId, 'allow');
  await until(() => w.has('turn_end') && w.events.filter((e) => e.update.hefyn === 'turn_end').length === 2, 'second turn_end');
  assert.equal(activityOf(uid)[conv], undefined);
  await s.openTerminal(100, 30);
  await until(() => activityOf(uid)[conv]?.state === 'running', 'terminal printing');
  const t0 = Date.now();
  assert.equal(cliState({ busy: false, perms: 0, terminal: true, lastOutput: t0, now: t0 + 9_000 }), 'running');
  assert.equal(cliState({ busy: false, perms: 0, terminal: true, lastOutput: t0, now: t0 + 11_000 }), undefined, 'quiet for 10 s: not running');
  s.closeTerminal();
  await until(() => !s.terminalOpen && activityOf(uid)[conv] === undefined, 'terminal closed');
  await host.closeAll();
});

test('terminal scrollback is bounded', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv);
  await s.openTerminal(80, 24);
  for (let i = 0; i < 40; i++) s.terminalInput('x'.repeat(10_000)); // echoed back by the fake PTY
  await new Promise((r) => setTimeout(r, 200));
  let first!: Buffer; s.terminalStream((b) => (first = b), () => {}, () => {});
  assert.ok(first.length > 200_000 && first.length <= 256 * 1024, String(first.length));
  await host.closeAll();
});

test('deleting a conversation deletes its events; a deleted conversation logs nothing more', async () => {
  const host = mkHost(), conv = newConv(), s = host.session(uid, conv), w = watch(host, conv);
  s.prompt('x'); await until(() => w.has('turn_end'), 'turn_end');
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM cli_events WHERE conversation_id = ?').get(conv) as any).n > 0);
  purgeConversations(uid, [conv]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cli_events WHERE conversation_id = ?').get(conv) as any).n, 0);
  s.prompt('after delete');
  await until(() => !(s as any).busy, 'turn over');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cli_events WHERE conversation_id = ?').get(conv) as any).n, 0);
  await host.closeAll();
});

test('a locked account (no key) cannot start an agent: refused up front, no sandbox process', async () => {
  const host = mkHost(), conv = newConv(null, 'dave');
  db.prepare('UPDATE conversations SET agent = ? WHERE id = ?').run('opencode', conv);
  const s = host.session('dave', conv), before = calls.attach.length;
  assert.throws(() => s.prompt('hello'), (e: any) => e.code === 'locked');
  assert.equal(calls.attach.length, before);
  await host.closeAll();
});

test('HTTP routes: prompt 202 / 409, SSE events with `after`, permission, terminal; other conversations are 404', async () => {
  const host = mkHost(), conv = newConv(), app = new Hono().route('/agents/cli', cliRoutes(host));
  const post = (path: string, body?: unknown) => app.request(`/agents/cli/${conv}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  assert.equal((await post('/prompt', {})).status, 400);
  assert.equal((await post('/prompt', { text: 'slow' })).status, 202);
  const busy = await post('/prompt', { text: 'again' });
  assert.equal(busy.status, 409); assert.match(((await busy.json()) as any).error, /still answering/);
  const read = async (after: number, until: (e: any) => boolean) => {
    const res = await app.request(`/agents/cli/${conv}/events?after=${after}`);
    assert.match(res.headers.get('content-type')!, /text\/event-stream/);
    const rd = res.body!.getReader(), dec = new TextDecoder(), got: any[] = [];
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value);
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) { const d = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); if (d) got.push(JSON.parse(d.slice(6))); }
      if (got.some(until)) break;
    }
    await rd.cancel();
    return got;
  };
  const live = read(0, (e) => e.update.hefyn === 'turn_end');
  await until(() => (db.prepare('SELECT COUNT(*) AS n FROM cli_events WHERE conversation_id = ?').get(conv) as any).n >= 4, 'turn started');
  assert.equal((await post('/cancel')).status, 200);
  const got = await live;
  assert.deepEqual(got.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'seq', 'update']);
  assert.deepEqual((await read(3, (e) => e.seq === 5)).map((e) => e.seq), [4, 5]);
  // permission over HTTP
  await post('/prompt', { text: 'ask' });
  await until(() => (db.prepare("SELECT COUNT(*) AS n FROM cli_events WHERE conversation_id = ?").get(conv) as any).n >= 8, 'permission asked');
  const q = (await read(5, (e) => e.update.hefyn === 'permission')).find((e) => e.update.hefyn === 'permission').update;
  assert.equal((await post('/permission', { requestId: q.requestId, optionId: 'nope' })).status, 400);
  assert.equal((await post('/permission', { requestId: q.requestId })).status, 400);
  assert.equal((await post('/permission', { requestId: q.requestId, optionId: null })).status, 200);
  assert.equal((await post('/permission', { requestId: q.requestId, optionId: null })).status, 404);
  await until(() => !host.session(uid, conv).busy, 'turn over');
  // terminal over HTTP
  assert.equal((await post('/terminal', { cols: 0, rows: 5 })).status, 400);
  assert.equal((await app.request(`/agents/cli/${conv}/terminal/stream`)).status, 409, 'not open yet');
  assert.equal((await post('/terminal', { cols: 100, rows: 30, theme: 'purple' })).status, 400);
  assert.equal((await post('/terminal', { cols: 100, rows: 30, theme: 'dark' })).status, 200);
  assert.equal((await post('/prompt', { text: 'no' })).status, 409);
  await new Promise((r) => setTimeout(r, 30)); // the greeting arrives
  const res = await app.request(`/agents/cli/${conv}/terminal/stream`), rd = res.body!.getReader(), dec = new TextDecoder();
  const next = async () => /^data: (.*)\n\n/s.exec(dec.decode((await rd.read()).value))![1];
  assert.equal(Buffer.from(await next(), 'base64').toString(), 'welcome\r\n');
  assert.equal((await post('/terminal/input', { data: 'é\r' })).status, 200);
  assert.equal(Buffer.from(await next(), 'base64').toString(), 'é\r');
  assert.equal((await post('/terminal/resize', { cols: 50, rows: 10 })).status, 200);
  assert.deepEqual(calls.resizes.at(-1), [50, 10]);
  await rd.cancel();
  // not an agent chat, not someone else's
  const plain = newConv(null);
  assert.equal((await app.request(`/agents/cli/${plain}/events`)).status, 404);
  assert.equal((await app.request(`/agents/cli/u_nobody_01X/events`)).status, 404);
  await host.closeAll();
});

// ---- tRPC: creating agent chats and the availability list ----
const web = new Hono().route('/api', api);
const PW = 'password-12345';
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => web.request(p, i), cookie, proc, input, mutate) };
}
test('tRPC: agent chats carry agent and view; cliAgents.list explains why it is unavailable', async () => {
  db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('noshell', 'No shell', 0, '[\"models.use\"]')").run(); // Worker has sandbox.shell by default
  const boss = await mk('boss@x.test', 'admin'), worker = await mk('worker@x.test', 'noshell');
  // no Anthropic connection yet
  let l = (await boss.trpc('cliAgents.list')).json;
  assert.deepEqual(l.map((a: any) => [a.id, a.name, a.available]), [['claude-acp', 'Claude Code', false], ['opencode', 'OpenCode', false]]);
  assert.match(l[0].reason, /No Anthropic API key/);
  assert.match(l[0].reason, /Or sign in with your own account/, 'Claude Code can run on its own account');
  assert.doesNotMatch(l[1].reason, /own account/);
  assert.match((await worker.trpc('cliAgents.list')).json[0].reason, /not allowed to use the sandbox/);
  const { connect } = await import('../src/server/providers.ts');
  vault.rememberUserKey(boss.id, vault.newKey());
  connect({ id: 'anthropic' }, 'sk-ant-x');
  l = (await boss.trpc('cliAgents.list')).json;
  assert.equal(l[0].available, true); assert.equal(l[0].reason, undefined);
  db.prepare("UPDATE providers SET kind = 'oauth' WHERE id = 'anthropic'").run();
  assert.match((await boss.trpc('cliAgents.list')).json[0].reason, /subscription/);
  db.prepare("UPDATE providers SET kind = 'api_key' WHERE id = 'anthropic'").run();

  const created = (await boss.trpc('conversations.create', { agent: 'claude-code', view: 'terminal' }, true)).json;
  assert.equal(created.agent, 'claude-acp'); assert.equal(created.view, 'terminal'); // the legacy id is mapped
  assert.equal((await boss.trpc('conversations.create', { agent: 'claude-code' }, true)).json.view, 'chat');
  const plain = (await boss.trpc('conversations.create', {}, true)).json.id;
  const rows = (await boss.trpc('conversations.list')).json as any[];
  assert.deepEqual(rows.find((r) => r.id === created.id) && [rows.find((r) => r.id === created.id).agent, rows.find((r) => r.id === created.id).view], ['claude-acp', 'terminal']);
  assert.deepEqual([rows.find((r) => r.id === plain).agent, rows.find((r) => r.id === plain).view], ['claude-acp', 'chat']); // no agent given: Claude Code
  assert.equal((await boss.trpc('conversations.update', { id: created.id, view: 'chat' }, true)).json.view, 'chat');
  assert.equal(((await boss.trpc('conversations.list')).json as any[]).find((r) => r.id === created.id).view, 'chat');
  assert.equal((await boss.trpc('conversations.update', { id: plain, view: 'terminal' }, true)).status, 200); // every chat has an agent now
  const retired = `u_${boss.id}_01RETIRED`; // a chat of the retired hefyn chat: no agent
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, ?, 'now')").run(retired, boss.id, vault.sealForUser(boss.id, 'old', `conv:${retired}:title`));
  assert.equal((await boss.trpc('conversations.update', { id: retired, view: 'terminal' }, true)).status, 400, 'view only applies to a chat with an agent');
  assert.equal((await boss.trpc('conversations.create', { view: 'terminal' }, true)).json.view, 'terminal'); // the default Claude Code chat, shown as its terminal
  assert.equal((await boss.trpc('conversations.create', { agent: 'other' }, true)).status, 400);
  assert.equal((await worker.trpc('conversations.create', { agent: 'claude-code' }, true)).status, 403);
});
