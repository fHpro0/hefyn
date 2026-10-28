import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Agent } from '@agentclientprotocol/sdk';

// A CLI agent as a step of a flow, without Docker: the CLI host with a fake ACP agent behind an injected transport (as cli-host.test.ts), driven by a flow chat (src/assistants/session.ts).
// The Docker version with a real runner is in flows-docker.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-flowscli-'));
process.env.HEFYN_SECRET = 'flows-cli-secret-flows-cli-secret-1234';
process.env.HEFYN_RUNNER_URL = 'http://runner.invalid:8790';

const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { CliHost } = await import('../src/cli-agents/host.ts');
const { FlowHost } = await import('../src/assistants/session.ts');
const { writeAssistant } = await import('../src/server/assistant-store.ts');
const { purgeConversations } = await import('../src/server/chats.ts');
vault.setTeamKey(vault.newKey());
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('opencode', '1.19.4', 'ready', 1, '[]', ?)").run(new Date().toISOString());
const uid = 'alice';
vault.rememberUserKey(uid, vault.newKey());

const calls = { attach: 0, seeds: [] as any[][], perm: [] as string[] };
function fakeAgent(conn: AgentSideConnection): Agent {
  let release: (() => void) | undefined;
  return {
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
    newSession: async () => ({ sessionId: '11111111-2222-3333-4444-555555555555' }),
    authenticate: async () => ({}),
    cancel: async () => { release?.(); },
    prompt: async (p) => {
      const text = (p.prompt[0] as any).text as string, sessionId = p.sessionId;
      const say = (t: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } });
      if (text.includes('slow')) { await new Promise<void>((r) => (release = r)); return { stopReason: 'cancelled' }; }
      if (text.includes('ask')) {
        const r = await conn.requestPermission({ sessionId, toolCall: { toolCallId: 't1', title: 'Write a file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
        await say(`outcome ${r.outcome.outcome === 'selected' ? r.outcome.optionId : r.outcome.outcome}`);
        return { stopReason: 'end_turn' };
      }
      await say(`echo: ${text}`);
      return { stopReason: 'end_turn' };
    },
  };
}
const attach = async (_u: string, _c: string, _spec: any) => {
  calls.attach++;
  const toProc = new PassThrough(), fromProc = new PassThrough();
  const stream = Duplex.from({ readable: fromProc, writable: toProc } as any) as Duplex;
  new AgentSideConnection(fakeAgent, ndJsonStream(Writable.toWeb(fromProc) as any, Readable.toWeb(toProc) as any));
  stream.on('close', () => { toProc.destroy(); fromProc.destroy(); });
  return { stream, resize: async () => {} };
};
const listenModel = async () => ({ close: () => {} });
const cli = new CliHost({ attach, listenModel, seed: async (_u, _c, seeds) => void calls.seeds.push(seeds as any[]) }, 3_600_000);
const flows = new FlowHost(cli, 3_600_000);

const node = (id: string, type: string, config: Record<string, any> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const INPUTS = { images: 'off' as const, maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };
function assistant(name: string, scope: 'team' | 'private') {
  const flow = {
    version: 1 as const,
    nodes: [node('start', 'trigger.chat'), node('coder', 'agent', { agent: 'opencode', model: null, thinking: null, instructions: 'STEP-INSTRUCTIONS-1', prompt: '{{start.text}}', skills: [], history: false, subAgents: [], output: 'text' }), node('reply', 'output.reply', { text: 'Agent said: {{coder.text}}' })],
    edges: [{ id: 'e1', from: 'start', to: 'coder' }, { id: 'e2', from: 'coder', to: 'reply' }],
  };
  return writeAssistant({ name, description: '', icon: 'Sparkles', inputs: INPUTS, roles: [], flow, scope, owner: scope === 'private' ? uid : null }).id;
}
let n = 0;
const chat = (assistantId: string) => {
  const id = `u_${uid}_01FLOW${String(++n).padStart(3, '0')}`;
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, assistant_id, flow) VALUES (?,?,?,?,?,1)").run(id, uid, 'x', new Date().toISOString(), assistantId);
  const s = flows.session(uid, id), events: any[] = [];
  s.subscribe(0, (e) => events.push(e));
  return { id, s, events, kinds: () => events.map((e) => e.update.hefyn ?? e.update.sessionUpdate), until: async (f: () => boolean, what: string, ms = 5000) => { for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), `timeout: ${what}; ${JSON.stringify(events.slice(-8).map((e) => e.update))}`); } };
};
const ended = (c: ReturnType<typeof chat>) => c.events.some((e) => e.update.hefyn === 'run_end');

test('a CLI agent step returns its final text into the flow; its updates are forwarded with runId and node; the reply is the flow\'s', async () => {
  const c = chat(assistant('Coder', 'team'));
  c.s.prompt('hello');
  await c.until(() => ended(c), 'run_end');
  const run = c.events.find((e) => e.update.hefyn === 'run_start').update.runId;
  const fwd = c.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk');
  assert.deepEqual(fwd.map((e) => [e.update.content.text, e.update.runId, e.update.node ?? null]), [['echo: hello', run, 'coder'], ['Agent said: echo: hello', run, null]]);
  assert.deepEqual(c.kinds().filter((k) => k !== 'agent_message_chunk'), ['user', 'run_start', 'step_start', 'step_output', 'step_end', 'step_start', 'step_output', 'step_end', 'step_start', 'step_end', 'run_end']);
  assert.equal(c.events.find((e) => e.update.hefyn === 'step_output' && e.update.node === 'coder').update.text, 'echo: hello');
  assert.equal(c.events.at(-1).update.status, 'done');
  // the step's instructions went to the agent's config; the work happened in a hidden child chat
  assert.ok(calls.seeds.some((s) => s.some((x: any) => JSON.stringify(x).includes('STEP-INSTRUCTIONS-1'))), 'the step\'s own instructions reached the agent');
  const child = db.prepare('SELECT id, agent, assistant_id FROM conversations WHERE parent_id = ?').get(c.id) as any;
  assert.deepEqual([child.agent, child.assistant_id], ['opencode', (db.prepare('SELECT assistant_id FROM conversations WHERE id = ?').get(c.id) as any).assistant_id]);
  // a second run reuses the same agent session
  const before = calls.attach;
  c.s.prompt('again');
  await c.until(() => c.events.filter((e) => e.update.hefyn === 'run_end').length === 2, 'second run');
  assert.equal(calls.attach, before, 'the agent process is still there');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE parent_id = ?').get(c.id) as any).n, 1);
  // deleting the chat takes the child with it
  purgeConversations(uid, [c.id]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ? OR parent_id = ?').get(c.id, c.id) as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_runs WHERE conversation_id = ?').get(c.id) as any).n, 0);
});

test('the agent\'s permission questions reach the flow chat and are answered through it', async () => {
  const c = chat(assistant('Coder 2', 'team'));
  c.s.prompt('please ask me');
  await c.until(() => c.events.some((e) => e.update.hefyn === 'permission'), 'permission');
  const p = c.events.find((e) => e.update.hefyn === 'permission').update;
  assert.equal(p.node, 'coder'); assert.ok(p.runId && p.requestId && p.options.length === 2);
  assert.throws(() => c.s.permission('nope', 'allow'), (e: any) => e.status === 404);
  c.s.permission(p.requestId, 'allow');
  await c.until(() => ended(c), 'run_end');
  assert.ok(c.events.some((e) => e.update.hefyn === 'permission_resolved' && e.update.requestId === p.requestId && e.update.node === 'coder'));
  assert.equal(c.events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk' && !e.update.node).at(-1).update.content.text, 'Agent said: outcome allow');
});

test('Stop reaches the agent; a private Assistant cannot use the sandbox without the permission', async () => {
  const c = chat(assistant('Coder 3', 'team'));
  c.s.prompt('slow please');
  await c.until(() => c.events.some((e) => e.update.hefyn === 'step_start' && e.update.node === 'coder') && c.s.busy, 'working');
  await new Promise((r) => setTimeout(r, 100));
  await c.s.cancel();
  await c.until(() => ended(c), 'run_end');
  assert.equal(c.events.at(-1).update.status, 'cancelled');
});

test('activity: a working flow chat shows its step and agent, an open agent question is waiting, and a finished chat is idle', async () => {
  const { activityOf } = await import('../src/server/activity.ts');
  const c = chat(assistant('Coder 4', 'team'));
  assert.equal(activityOf(uid)[c.id], undefined);
  c.s.prompt('slow please');
  await c.until(() => activityOf(uid)[c.id]?.label === 'Agent', 'the agent step shows');
  const a = activityOf(uid)[c.id]!;
  assert.deepEqual([a.state, a.agents], ['running', [{ name: 'Agent', kind: 'step', state: 'running' }]]); // an unlabelled step shows the palette name of its type
  assert.match(a.since!, /^\d{4}-\d\d-\d\dT/);
  assert.equal(Object.keys(activityOf(uid)).length, 1, 'the hidden child chat of the step is not listed');
  await c.s.cancel();
  await c.until(() => ended(c), 'run_end');
  assert.equal(activityOf(uid)[c.id], undefined);
  const d = chat(assistant('Coder 5', 'team'));
  d.s.prompt('please ask me');
  await d.until(() => activityOf(uid)[d.id]?.state === 'waiting', 'waiting for the answer to the agent\'s question');
  d.s.permission(d.events.find((e) => e.update.hefyn === 'permission').update.requestId, 'allow');
  await d.until(() => ended(d), 'run_end');
  assert.equal(activityOf(uid)[d.id], undefined);
});

test('a private Assistant needs the user to have the sandbox themselves (it grants nothing)', async () => {
  const c = chat(assistant('Mine', 'private'));
  c.s.prompt('hello');
  await c.until(() => ended(c), 'run_end');
  const end = c.events.at(-1).update;
  assert.equal(end.status, 'failed');
  assert.match(end.error, /cannot use agents in the sandbox/);
});
