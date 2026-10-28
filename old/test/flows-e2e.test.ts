import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { requests, startFake } from './fake-anthropic.ts';
import { trpcCall } from './trpc.ts';

// A flow chat against the BUILT-less real stack (web + agent processes, fake Anthropic upstream): trigger -> router (ai) -> agent -> approval -> reply, over the
// event-log routes the console uses. The upstream must only ever see placeholders; events arrive in order; approve and reject paths; Stop; a restart while waiting and while running.
const PORT = 3900 + Math.floor(Math.random() * 300);
const base = `http://localhost:${PORT}`;
const APORT = PORT + 1500;
const TOKEN = 'test-internal-token-test-internal-token-1234';
const agentUrl = `http://127.0.0.1:${APORT}`;
let server: ChildProcess, agent: ChildProcess, stopping = false;
let fake: Awaited<ReturnType<typeof startFake>>;
let dataDir = '';
const EMAIL = 'ada.lovelace@example.com';

let cookie = '';
const req = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (set) cookie = set;
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
};
const trpc = (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => fetch(base + p, i), cookie, proc, input, mutate, base);

before(async () => {
  fake = await startFake();
  dataDir = mkdtempSync(join(tmpdir(), 'hefyn-flows-e2e-'));
  const env = { ...process.env, HEFYN_URL: base, NODE_ENV: 'production', HEFYN_SECRET: 'test-secret-test-secret-test-secret-1234', HEFYN_DATA_DIR: dataDir, HEFYN_INTERNAL_TOKEN: TOKEN, HEFYN_ALLOW_PRIVATE_URLS: '1' };
  const spawnAgent = () => {
    agent = spawn('bun', ['src/agent.ts'], { env: { ...env, PORT: String(APORT), HEFYN_DRAIN_TIMEOUT_MS: '5000' }, stdio: 'ignore' });
    agent.on('exit', () => { if (!stopping) setTimeout(spawnAgent, 300); });
  };
  spawnAgent();
  server = spawn('bun', ['src/web.ts'], { env: { ...env, PORT: String(PORT), HEFYN_AGENT_URL: agentUrl }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => { server.stdout!.on('data', (d) => String(d).includes('listening') && ok()); server.on('exit', (c) => fail(new Error(`server exited ${c}`))); });
  await agentReady();
});
after(() => { stopping = true; server?.kill(); agent?.kill(); fake?.close(); });

const agentReady = async () => { for (let i = 0; i < 100 && !(await fetch(agentUrl).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100)); };
const until = async (what: string, f: () => Promise<boolean> | boolean, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await f()) return; throw new Error(`timed out waiting for ${what}`); };

/** The conversation's event log over the SSE route, from the start, until `done(events)`. */
async function events(conv: string, done: (e: any[]) => boolean, ms = 30000): Promise<any[]> {
  const ctl = new AbortController(), out: any[] = [];
  const res = await fetch(`${base}/agents/cli/${conv}/events?after=0`, { headers: { cookie, origin: base }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let buf = '';
    for await (const chunk of res.body as any) {
      buf += Buffer.from(chunk).toString();
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        if (line) out.push(JSON.parse(line.slice(6)));
      }
      if (done(out)) return out;
    }
  } catch (e) { if (!ctl.signal.aborted) throw e; } finally { clearTimeout(timer); ctl.abort(); }
  throw new Error(`timed out waiting for events; got ${JSON.stringify(out.map((e) => e.update.hefyn ?? e.update.sessionUpdate))}`);
}
const has = (e: any[], hefyn: string, run?: string) => e.some((x) => x.update.hefyn === hefyn && (!run || x.update.runId === run));
const kinds = (e: any[]) => e.map((x) => (x.update.hefyn ? `${x.update.hefyn}${x.update.node ? ':' + x.update.node : ''}${x.update.status ? ':' + x.update.status : ''}` : x.update.sessionUpdate));
const replies = (e: any[]) => e.filter((x) => x.update.sessionUpdate === 'agent_message_chunk' && !x.update.node).map((x) => x.update.content.text);

const node = (id: string, type: string, config: Record<string, any> = {}, label?: string) => ({ id, type, label, position: { x: 0, y: 0 }, config });
const FLOW = {
  version: 1,
  nodes: [
    node('start', 'trigger.chat'),
    node('route', 'router', { mode: 'ai', input: '{{start.text}}', branches: [{ id: 'refund', label: 'Refund', description: 'wants money back' }] }, 'Route'),
    node('draft', 'agent', { agent: null, model: null, thinking: null, instructions: 'You draft refund mails.', prompt: 'FLOWDRAFT {{start.text}}', skills: [], history: true, subAgents: [], output: 'text' }, 'Draft'),
    node('ok', 'approval', { message: 'Send this? {{draft.text}}', editable: false }, 'Approve'),
    node('sent', 'output.reply', { text: 'Sent: {{draft.text}}' }),
    node('no', 'output.reply', { text: 'Cancelled.' }),
    node('other', 'output.reply', { text: 'No refund needed.' }),
  ],
  edges: [['start', 'route'], ['route', 'draft', 'refund'], ['draft', 'ok'], ['ok', 'sent', 'approved'], ['ok', 'no', 'rejected'], ['route', 'other', 'else']].map(([from, to, port], i) => ({ id: `e${i}`, from, to, ...(port ? { port } : {}) })),
};
const INPUTS = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };
let conv = '';
const prompt = (text: string) => req(`/agents/cli/${conv}/prompt`, 'POST', { text });
const runOf = (e: any[]) => e.filter((x) => x.update.hefyn === 'run_start').at(-1).update.runId as string;

test('setup: an admin, a provider, a flow Assistant, a flow chat', async () => {
  assert.equal((await trpcCall((p, i) => fetch(base + p, i), '', 'setup.create', { name: 'Ada', email: 'ada@x.test', password: 'password-1' }, true, base)).status, 200);
  assert.equal((await req('/api/auth/sign-in/email', 'POST', { email: 'ada@x.test', password: 'password-1' })).status, 200);
  assert.equal((await trpc('models.connect', { provider: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url }, true)).status, 200);
  assert.equal((await trpc('profile.update', { model: 'anthropic/claude-opus-5-5' }, true)).status, 200);
  const made = await trpc('assistants.save', { name: 'Refunds', description: 'Handles refund requests', icon: 'Sparkles', inputs: INPUTS, flow: FLOW, roles: [] }, true);
  assert.equal(made.status, 200, String(made.error));
  const c = await trpc('conversations.create', { assistantId: made.json.id }, true);
  assert.equal(c.status, 200, String(c.error));
  assert.equal(c.json.flow, true);
  conv = c.json.id;
  assert.equal((await req(`/agents/configurable/${conv}`, 'POST', { kind: 'user', body: 'hi' })).status, 409, 'the classic route refuses a flow chat');
  assert.equal((await req(`/agents/cli/${conv}/terminal`, 'POST', { cols: 80, rows: 24 })).status, 409, 'no terminal for a flow chat');
});

test('router -> agent -> approval -> reply: events in order, upstream sees only placeholders, the person sees real values', async () => {
  const from = requests.length;
  assert.equal((await prompt(`REFUNDFLOW please refund ${EMAIL}`)).status, 202);
  const e = await events(conv, (x) => has(x, 'waiting'));
  assert.deepEqual(kinds(e), ['user', 'run_start', 'step_start:start', 'step_output:start', 'step_end:start:done', 'step_start:route', 'step_end:route:done', 'step_start:draft', 'step_output:draft', 'step_end:draft:done', 'step_end:other:skipped', 'step_start:ok', 'waiting:ok']);
  const w = e.find((x) => x.update.hefyn === 'waiting').update;
  assert.deepEqual([w.kind, w.node, w.editable], ['approval', 'ok', false]);
  assert.equal(w.message, `Send this? Dear ${EMAIL}, the refund is granted.`);
  assert.deepEqual(e.map((x) => x.seq), e.map((_, i) => i + 1), 'sequence numbers without gaps');
  const sent = requests.slice(from);
  assert.ok(sent.length >= 2, 'the router and the draft step each asked the model');
  assert.ok(sent.some((r) => r.system.includes('You route requests')) && sent.some((r) => r.system.includes('You draft refund mails')));
  assert.equal((await req(`/agents/cli/${conv}/prompt`, 'POST', { text: 'again' })).status, 409, 'a new message waits for the open question');

  const run = runOf(e);
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: run, node: 'ok' })).status, 400, 'approve or reject');
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: run, node: 'draft', approved: true })).status, 404);
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: run, node: 'ok', approved: true })).status, 202);
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: run, node: 'ok', approved: true })).status, 404, 'only the first answer counts');
  const all = await events(conv, (x) => has(x, 'run_end', run));
  assert.deepEqual(replies(all), [`Sent: Dear ${EMAIL}, the refund is granted.`]);
  assert.deepEqual(kinds(all).slice(13), ['step_output:ok', 'step_end:ok:done', 'step_start:sent', 'agent_message_chunk', 'step_end:sent:done', 'step_end:no:skipped', 'run_end:done']);
  // at rest: the run state and the log are sealed
  const rest = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
  const st = rest.prepare('SELECT status, state FROM assistant_runs WHERE id = ?').get(run) as { status: string; state: string };
  const log = rest.prepare('SELECT data FROM cli_events WHERE conversation_id = ?').all(conv) as { data: string }[];
  rest.close();
  assert.equal(st.status, 'done');
  assert.ok(st.state.startsWith('hx1:') && log.every((r) => r.data.startsWith('hx1:')) && !JSON.stringify(log).includes('refund is granted'));
  // the usage of the model steps is counted
  assert.ok((await trpc('usage.me')).json.perDay[0].calls >= 2);
});

test('reject takes the other port; the else branch needs no approval; both are plain runs', async () => {
  assert.equal((await prompt(`REFUNDFLOW again ${EMAIL}`)).status, 202);
  let e = await events(conv, (x) => x.filter((y) => y.update.hefyn === 'waiting').length === 2);
  const run = runOf(e);
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: run, node: 'ok', approved: false })).status, 202);
  e = await events(conv, (x) => has(x, 'run_end', run));
  assert.equal(replies(e).at(-1), 'Cancelled.');
  assert.ok(kinds(e).includes('step_end:sent:skipped'));

  assert.equal((await prompt('what time is it?')).status, 202);
  e = await events(conv, (x) => x.filter((y) => y.update.hefyn === 'run_end').length === 3);
  assert.equal(replies(e).at(-1), 'No refund needed.');
  assert.ok(!kinds(e).slice(-12).includes('waiting:ok'), 'the else branch never asks');
});

test('Stop cancels a run that is working', async () => {
  const before = 3; // runs finished so far
  assert.equal((await prompt('REFUNDFLOW SLOW15000')).status, 202); // the router call is held by the upstream
  await events(conv, (x) => x.filter((y) => y.update.hefyn === 'step_start' && y.update.node === 'route').length === before + 1, 10000);
  const t0 = Date.now();
  assert.equal((await req(`/agents/cli/${conv}/cancel`, 'POST', {})).status, 200);
  const e = await events(conv, (x) => x.filter((y) => y.update.hefyn === 'run_end').length === before + 1, 10000);
  assert.equal(e.at(-1).update.status, 'cancelled');
  assert.ok(Date.now() - t0 < 8000, 'Stop does not wait for the upstream');
  assert.equal((await prompt('what time is it?')).status, 202, 'the chat takes the next message');
  await events(conv, (x) => x.filter((y) => y.update.hefyn === 'run_end').length === before + 2);
});

test('a restart of the agent process: a waiting run resumes on the answer, a running one is marked failed', async () => {
  assert.equal((await prompt(`REFUNDFLOW restart ${EMAIL}`)).status, 202);
  let e = await events(conv, (x) => x.filter((y) => y.update.hefyn === 'waiting').length === 3);
  const waiting = runOf(e);
  agent.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  await agentReady();
  assert.equal((await req(`/agents/cli/${conv}/answer`, 'POST', { runId: waiting, node: 'ok', approved: true })).status, 202, 'the waiting run lives in the database');
  e = await events(conv, (x) => has(x, 'run_end', waiting));
  assert.equal(e.filter((x) => x.update.hefyn === 'run_end' && x.update.runId === waiting).at(-1).update.status, 'done');
  assert.equal(replies(e).at(-1), `Sent: Dear ${EMAIL}, the refund is granted.`);

  // a run that was working when the process died
  assert.equal((await prompt('REFUNDFLOW SLOW15000 again')).status, 202);
  e = await events(conv, (x) => x.filter((y) => y.update.hefyn === 'run_start').length === 7);
  const running = runOf(e);
  await new Promise((r) => setTimeout(r, 800));
  agent.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  await agentReady();
  e = await events(conv, (x) => has(x, 'run_end', running));
  const end = e.filter((x) => x.update.hefyn === 'run_end' && x.update.runId === running).at(-1).update;
  assert.deepEqual([end.status, /restarted/.test(end.error)], ['failed', true]);
  assert.equal((await prompt('what time is it?')).status, 202, 'and the chat goes on');
});
