import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// Flows without Docker or a model: the format (validation, templates), the engine against stand-in dependencies (ordering, skipping, pause and resume, limits), the persistence of runs
// (sealed), and the ownership model (private / team, share, review, permissions). The engine against the real gate, a model upstream and a CLI agent is in flows-e2e.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-flows-'));
process.env.HEFYN_SECRET = 'flows-test-secret-flows-test-secret-123';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1'; // configured, never called
process.env.HEFYN_INTERNAL_TOKEN = 'flows-token-flows-token-0123456789012';

const { Hono } = await import('hono');
const { db, syncSimpleFlow } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { connect } = await import('../src/server/providers.ts');
const { getAssistant, visibleTo } = await import('../src/server/assistants.ts');
const { checkGraph, render, simpleFlow, isSimple } = await import('../src/assistants/flow.ts');
const { answer, compare, execute, extractJson, newRun } = await import('../src/assistants/engine.ts');
const { createRun, loadRun, saveRun } = await import('../src/assistants/runs.ts');
await import('../src/server/hub.ts');
vault.setTeamKey(vault.newKey());

type N = Record<string, any>;
const node = (id: string, type: string, config: N = {}, label?: string) => ({ id, type, label, position: { x: 0, y: 0 }, config });
const flow = (nodes: ReturnType<typeof node>[], edges: [string, string, string?][]) => ({ version: 1 as const, nodes, edges: edges.map(([from, to, port], i) => ({ id: `e${i}`, from, to, ...(port ? { port } : {}) })) });
const reply = (id = 'reply', text = '{{draft.text}}') => node(id, 'output.reply', { text });
const agent = (id: string, over: N = {}) => node(id, 'agent', { agent: null, model: null, thinking: null, instructions: '', prompt: '{{start.text}}', skills: [], history: true, subAgents: [], output: 'text', ...over });
const start = () => node('start', 'trigger.chat');
const messages = (errs: { message: string }[]) => errs.map((e) => e.message).join(' | ');

// ---------- format ----------
test('validation: the structural mistakes, in plain words', () => {
  const ok = flow([start(), agent('draft'), reply()], [['start', 'draft'], ['draft', 'reply']]);
  assert.deepEqual(checkGraph(ok).errors, []);
  const bad = (f: unknown, re: RegExp) => assert.match(messages(checkGraph(f).errors), re);
  bad(null, /not in a format/);
  bad(flow([agent('draft'), reply()], [['draft', 'reply']]), /needs a Chat message step/);
  bad(flow([start(), node('s2', 'trigger.chat'), agent('draft'), reply()], [['start', 'draft'], ['s2', 'draft'], ['draft', 'reply']]), /only one Chat message/);
  bad(flow([start(), agent('draft')], [['start', 'draft']]), /needs a Reply step/);
  bad(flow([start(), agent('draft'), reply()], [['start', 'draft'], ['draft', 'nope']]), /step that does not exist/);
  bad(flow([start(), agent('Bad Id'), reply()], [['start', 'Bad Id']]), /not a valid step id/);
  bad(flow([start(), agent('draft'), agent('draft'), reply()], []), /Two steps have the id "draft"/);
  bad(flow([start(), node('weird', 'teleport'), reply()], [['start', 'weird'], ['weird', 'reply']]), /unknown type/);
  bad(flow([start(), agent('a'), agent('b'), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'reply']]), /lead back into themselves/);
  bad(flow([start(), node('r', 'router', { mode: 'rules', branches: [{ id: 'x', label: 'X' }] }), reply('reply', 'hi')], [['start', 'r'], ['r', 'reply']]), /Choose which exit/);
  bad(flow([start(), node('r', 'router', { mode: 'rules', branches: [{ id: 'x', label: 'X' }] }), reply('reply', 'hi')], [['start', 'r'], ['r', 'reply', 'nope']]), /no exit "nope"/);
  bad(flow([start(), reply('reply', 'hi'), agent('after')], [['start', 'reply'], ['reply', 'after']]), /ends the flow/);
  bad(flow([start(), agent('draft'), reply('reply', 'hi'), agent('lonely')], [['start', 'draft'], ['draft', 'reply']]), /not connected to anything before it/);
  // templates may only name steps that ran before
  bad(flow([start(), agent('a', { prompt: '{{b.text}}' }), agent('b'), reply('reply', '{{b.text}}')], [['start', 'a'], ['a', 'b'], ['b', 'reply']]), /cannot have run before/);
  bad(flow([start(), agent('a'), reply('reply', '{{ghost.text}}')], [['start', 'a'], ['a', 'reply']]), /does not exist/);
  bad(flow([start(), agent('a'), reply('reply', '{{a}}')], [['start', 'a'], ['a', 'reply']]), /not a valid reference/);
  // a join may name both branches before it (the one not taken renders empty) ...
  const join = flow([start(), node('c', 'condition', { op: 'empty', left: '{{start.text}}', right: '' }), agent('t'), agent('f'), reply('reply', '{{t.text}}{{f.text}}')], [['start', 'c'], ['c', 't', 'true'], ['c', 'f', 'false'], ['t', 'reply'], ['f', 'reply']]);
  assert.deepEqual(checkGraph(join).errors, []);
  // ... but one branch may not name the other
  bad(flow([start(), node('c', 'condition', { op: 'empty', left: '{{start.text}}', right: '' }), agent('t'), agent('f', { prompt: '{{t.text}}' }), reply('reply', '{{t.text}}{{f.text}}')], [['start', 'c'], ['c', 't', 'true'], ['c', 'f', 'false'], ['t', 'reply'], ['f', 'reply']]), /cannot have run before/);
});

test('templates: {{node.field.path}}, skipped or unknown render empty, objects as JSON, one pass', () => {
  const out = { start: { text: 'hi {{a.text}}' }, cls: { json: { category: 'billing', n: [1, 2] } }, q: { answers: { who: 'Ada' } } };
  assert.equal(render('{{start.text}}|{{cls.json.category}}|{{cls.json.n}}|{{q.answers.who}}|{{gone.text}}|{{cls.json.nope}}|{{ start.text }}', out), 'hi {{a.text}}|billing|[1,2]|Ada|||hi {{a.text}}');
  assert.equal(render('{{not a ref}} {{x:EMAIL_1}}', out), '{{not a ref}} {{x:EMAIL_1}}');
  assert.equal(render('{{start.__proto__}}{{start.constructor}}{{start.toString}}', out), '', 'inherited properties are not data');
  assert.equal(render('{{__proto__.x}}', out), '{{__proto__.x}}');
});

test('conditions and JSON extraction', () => {
  assert.ok(compare('equals', ' a ', 'a') && !compare('equals', 'a', 'b') && compare('contains', 'Hello World', 'WORLD') && compare('matches', 'order 123', '\\d{3}') && compare('empty', ' ', '') && compare('not_empty', 'x', ''));
  assert.ok(compare('gt', '10', '9') && compare('lt', '1,5', '2') && !compare('gt', 'abc', '1') && !compare('gt', '', '1'));
  assert.throws(() => compare('matches', 'a', '('), /regular expression/);
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": 1}}\n```\nbye'), { a: { b: 1 } });
  assert.deepEqual(extractJson('{"a":1} trailing }'), { a: 1 });
  assert.equal(extractJson('no json here'), undefined);
});

test('simple shape: only trigger -> one plain agent -> reply of its text', () => {
  const s = simpleFlow({ instructions: 'x' });
  assert.ok(isSimple(s));
  assert.ok(!isSimple({ ...s, nodes: [...s.nodes, node('extra', 'template', { text: '' })] }));
  const changed = structuredClone(s); changed.nodes[2]!.config.text = 'Answer: {{agent.text}}';
  assert.ok(!isSimple(changed));
  assert.ok(!isSimple(null));
});

// ---------- engine ----------
function harness(over: Record<string, any> = {}) {
  const events: any[] = [], ctl = new AbortController(), saved: string[] = [];
  const deps = {
    signal: ctl.signal, emit: (e: any) => events.push(e), save: (r: any) => saved.push(r.status),
    agent: async (_id: string, r: any) => `agent<${r.prompt}>`,
    model: async () => 'billing',
    code: async () => ({ stdout: '{"n":2}', stderr: '', exitCode: 0 }),
    tool: async (r: any) => ({ got: r.args }),
    file: async (r: any) => `/files/${r.path}`,
    assistant: () => undefined as any,
    ...over,
  };
  const run = (f: object, text = 'hello', extra: object = {}) => newRun({ id: 'run1', conversationId: 'c', assistantId: 'asst', version: 1, flow: f as any, text, ...extra });
  const kinds = () => events.map((e) => e.hefyn ?? e.sessionUpdate);
  const replies = () => events.filter((e) => e.sessionUpdate === 'agent_message_chunk').map((e) => e.content.text);
  return { events, ctl, saved, deps, run, kinds, replies };
}

test('engine: runs in order, events in order, the reply is an agent_message_chunk', async () => {
  const h = harness(), r = h.run(flow([start(), agent('draft'), reply()], [['start', 'draft'], ['draft', 'reply']]));
  await execute(r, h.deps);
  assert.equal(r.status, 'done');
  assert.deepEqual(h.events.filter((e) => e.hefyn).map((e) => [e.hefyn, e.node, e.status].filter(Boolean).join(':')), [
    'step_start:start', 'step_output:start', 'step_end:start:done', 'step_start:draft', 'step_output:draft', 'step_end:draft:done', 'step_start:reply', 'step_end:reply:done', 'run_end:done']);
  assert.deepEqual(h.replies(), ['agent<hello>']);
  assert.ok(h.events.every((e) => e.runId === 'run1'));
  assert.equal(h.events.find((e) => e.hefyn === 'step_start' && e.node === 'draft').label, 'Agent');
  assert.equal(h.events.find((e) => e.hefyn === 'step_start' && e.node === 'start').label, 'Chat message');
});

test('engine: branches skip, skipped inputs skip, a join runs when any input arrived', async () => {
  const f = flow([
    start(), node('r', 'router', { mode: 'rules', branches: [{ id: 'bill', label: 'Billing', rule: { left: '{{start.text}}', op: 'contains', right: 'invoice' } }, { id: 'tech', label: 'Tech', rule: { left: '{{start.text}}', op: 'contains', right: 'error' } }] }),
    node('bill', 'template', { text: 'B:{{start.text}}' }), node('tech', 'template', { text: 'T:{{start.text}}' }), node('other', 'template', { text: 'O' }),
    node('after', 'template', { text: 'after tech' }),
    node('join', 'template', { text: '[{{bill.text}}][{{tech.text}}][{{other.text}}]' }), reply('reply', '{{join.text}}'),
  ], [['start', 'r'], ['r', 'bill', 'bill'], ['r', 'tech', 'tech'], ['r', 'other', 'else'], ['tech', 'after'], ['bill', 'join'], ['tech', 'join'], ['other', 'join'], ['join', 'reply']]);
  const a = harness(), ra = a.run(f, 'my invoice is wrong');
  await execute(ra, a.deps);
  assert.deepEqual(Object.fromEntries(Object.entries(ra.state.nodes).map(([k, v]) => [k, v.status])), { start: 'done', r: 'done', bill: 'done', tech: 'skipped', other: 'skipped', after: 'skipped', join: 'done', reply: 'done' });
  assert.deepEqual(a.replies(), ['[B:my invoice is wrong][][]'], 'a skipped node renders empty');
  assert.deepEqual(a.events.filter((e) => e.hefyn === 'step_end' && e.status === 'skipped').map((e) => e.node), ['tech', 'other', 'after']);
  const b = harness(), rb = b.run(f, 'something else');
  await execute(rb, b.deps);
  assert.deepEqual(b.replies(), ['[][][O]'], 'else');
  // condition: true / false ports
  const c = flow([start(), node('c', 'condition', { op: 'equals', left: '{{start.text}}', right: 'yes' }), node('t', 'template', { text: 'T' }), node('f', 'template', { text: 'F' }), reply('reply', '{{t.text}}{{f.text}}')],
    [['start', 'c'], ['c', 't', 'true'], ['c', 'f', 'false'], ['t', 'reply'], ['f', 'reply']]);
  for (const [text, want] of [['yes', 'T'], ['no', 'F']] as const) { const x = harness(); await execute(x.run(c, text), x.deps); assert.deepEqual(x.replies(), [want]); }
});

test('engine: router (ai) asks a model, matches by id or label, falls back to else', async () => {
  const f = flow([start(), node('r', 'router', { mode: 'ai', input: '{{start.text}}', branches: [{ id: 'refund', label: 'Refund', description: 'wants money back' }] }), node('x', 'template', { text: 'R' }), node('y', 'template', { text: 'E' }), reply('reply', '{{x.text}}{{y.text}}')],
    [['start', 'r'], ['r', 'x', 'refund'], ['r', 'y', 'else'], ['x', 'reply'], ['y', 'reply']]);
  let seen = '';
  for (const [answer, want] of [['refund', 'R'], ['"Refund".', 'R'], ['I think refund fits', 'R'], ['banana', 'E']] as const) {
    const h = harness({ model: async (_i: string, r: any) => { seen = r.prompt; return answer; } });
    await execute(h.run(f, 'give me my money'), h.deps);
    assert.deepEqual(h.replies(), [want], answer);
  }
  assert.match(seen, /- refund: Refund \(wants money back\)[\s\S]*give me my money/);
});

test('engine: approval pauses, survives a restart (sealed state), approve and reject take their ports, edited text flows on', async () => {
  const uid = 'u_flowsmoke';
  vault.rememberUserKey('flowsmoke', vault.newKey());
  const f = flow([start(), agent('draft'), node('ok', 'approval', { message: 'Send this reply?', editable: true }), node('sent', 'template', { text: 'SENT:{{ok.text}}' }), node('nope', 'template', { text: 'CANCELLED' }), reply('reply', '{{sent.text}}{{nope.text}}')],
    [['start', 'draft'], ['draft', 'ok'], ['ok', 'sent', 'approved'], ['ok', 'nope', 'rejected'], ['sent', 'reply'], ['nope', 'reply']]);
  for (const [decision, edited, want] of [[true, 'edited text', 'SENT:edited text'], [true, undefined, 'SENT:agent<hello>'], [false, undefined, 'CANCELLED']] as const) {
    const h = harness(), id = `${uid}-${decision}-${edited ?? 'none'}`;
    const r = { ...h.run(f), id, conversationId: 'c1' };
    db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, title, created_at) VALUES (?,?,?,?)').run('c1', 'flowsmoke', 'x', 'now');
    const deps = { ...h.deps, save: (x: any) => saveRun('flowsmoke', x) };
    createRun('flowsmoke', r);
    await execute(r, deps);
    assert.equal(r.status, 'waiting');
    const w = h.events.find((e) => e.hefyn === 'waiting');
    // no `content` set: the question is the heading, the draft of the step before is what gets reviewed
    assert.deepEqual([w.node, w.kind, w.message, w.editable, w.content], ['ok', 'approval', 'Send this reply?', true, 'agent<hello>']);
    assert.ok(!h.events.some((e) => e.hefyn === 'run_end'), 'not ended');
    // "restart": nothing in memory, the run is read back from the database
    const row = db.prepare('SELECT state FROM assistant_runs WHERE id = ?').get(id) as { state: string };
    assert.ok(row.state.startsWith('hx1:') && !row.state.includes('Send this'), 'the state is sealed at rest');
    const back = loadRun('flowsmoke', id)!;
    assert.equal(back.status, 'waiting');
    await assert.rejects(answer(back, { node: 'draft', approved: true }, deps), /not waiting/);
    await assert.rejects(answer(back, { node: 'ok' }, deps), /Approve or reject/);
    await answer(back, { node: 'ok', approved: decision, text: edited }, deps);
    assert.equal(back.status, 'done');
    assert.deepEqual(h.replies(), [want]);
    assert.equal(loadRun('flowsmoke', id)!.status, 'done');
    assert.deepEqual(h.events.filter((e) => e.hefyn === 'step_end' && e.node === 'ok').map((e) => e.status), ['done']);
    assert.equal(h.events.at(-1).hefyn, 'run_end');
  }
});

test('engine: approval content is its own template; a rejection passes it on unchanged even if edited', async () => {
  const f = flow([start(), agent('draft'), node('ok', 'approval', { message: 'Fine?', content: 'Hi: {{draft.text}}', editable: true }), node('no', 'template', { text: 'R:{{ok.text}}' }), reply('reply', '{{no.text}}')],
    [['start', 'draft'], ['draft', 'ok'], ['ok', 'no', 'rejected'], ['no', 'reply']]);
  const h = harness(), r = h.run(f);
  await execute(r, h.deps);
  assert.equal(h.events.find((e) => e.hefyn === 'waiting').content, 'Hi: agent<hello>');
  await answer(r, { node: 'ok', approved: false, text: 'changed' }, h.deps);
  assert.deepEqual(h.replies(), ['R:Hi: agent<hello>']);
});

test('engine: ask validates the answers and puts them in {{ask.answers.name}}', async () => {
  const f = flow([start(), node('q', 'ask', { question: 'Which?', fields: [{ name: 'who', label: 'Who', type: 'text' }, { name: 'size', label: 'Size', type: 'choice', options: ['S', 'L'] }] }), reply('reply', '{{q.answers.who}}/{{q.answers.size}}')], [['start', 'q'], ['q', 'reply']]);
  const h = harness(), r = h.run(f);
  await execute(r, h.deps);
  assert.equal(h.events.find((e) => e.hefyn === 'waiting').fields.length, 2);
  await assert.rejects(answer(r, { node: 'q', answers: { who: 'Ada' } }, h.deps), /Size/);
  await assert.rejects(answer(r, { node: 'q', answers: { who: 'Ada', size: 'XL' } }, h.deps), /pick one/);
  assert.equal(r.status, 'waiting', 'a bad answer leaves the question open');
  await answer(r, { node: 'q', answers: { who: 'Ada', size: 'L' } }, h.deps);
  assert.deepEqual(h.replies(), ['Ada/L']);
});

test('engine: an Assistant step runs a sub-run quietly; no recursion, depth at most 4', async () => {
  const inner = (name: string) => flow([start(), node('t', 'template', { text: `${name}:{{start.text}}` }), reply('reply', '{{t.text}}')], [['start', 't'], ['t', 'reply']]);
  const lookup: Record<string, any> = { inner: { id: 'inner', name: 'Inner', version: 1, flow: inner('inner') } };
  const outerFlow = flow([start(), node('a', 'assistant', { assistantId: 'inner', prompt: 'sub:{{start.text}}' }), reply('reply', 'got {{a.text}}')], [['start', 'a'], ['a', 'reply']]);
  const h = harness({ assistant: (id: string) => lookup[id] });
  const r = h.run(outerFlow);
  await execute(r, h.deps);
  assert.equal(r.status, 'done');
  assert.deepEqual(h.replies(), ['got inner:sub:hello'], 'only the outer reply reaches the chat');
  assert.equal(h.events.filter((e) => e.hefyn === 'step_start').length, 3, 'the sub-run shows as one step');
  // itself
  lookup.loop = { id: 'loop', name: 'Loop', version: 1, flow: flow([start(), node('a', 'assistant', { assistantId: 'loop', prompt: 'x' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]) };
  const h2 = harness({ assistant: (id: string) => lookup[id] }), r2 = h2.run(outerFlow.nodes.length ? flow([start(), node('a', 'assistant', { assistantId: 'loop', prompt: 'x' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]) : outerFlow);
  await execute(r2, h2.deps);
  assert.equal(r2.status, 'failed');
  assert.match(r2.state.error!, /"Loop" is already running in this chain/);
  // a chain of 6 distinct Assistants
  for (let i = 0; i < 6; i++) lookup[`d${i}`] = { id: `d${i}`, name: `D${i}`, version: 1, flow: i === 5 ? inner('leaf') : flow([start(), node('a', 'assistant', { assistantId: `d${i + 1}`, prompt: 'x' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]) };
  const h3 = harness({ assistant: (id: string) => lookup[id] }), r3 = h3.run(flow([start(), node('a', 'assistant', { assistantId: 'd0', prompt: 'x' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]));
  await execute(r3, h3.deps);
  assert.equal(r3.status, 'failed');
  assert.match(r3.state.error!, /nested at most 4 deep/);
  // an approval inside a sub-run cannot be answered by anybody
  lookup.asks = { id: 'asks', name: 'Asks', version: 1, flow: flow([start(), node('ok', 'approval', { message: 'ok?' }), node('n', 'template', { text: 'y' }), reply('reply', 'x')], [['start', 'ok'], ['ok', 'n', 'approved'], ['n', 'reply']]) };
  const h4 = harness({ assistant: (id: string) => lookup[id] }), r4 = h4.run(flow([start(), node('a', 'assistant', { assistantId: 'asks', prompt: 'x' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]));
  await execute(r4, h4.deps);
  assert.equal(r4.status, 'failed');
  assert.match(r4.state.error!, /needs a person to answer/);
});

test('engine: code, tool, file and JSON agent steps; failures stop the run with a plain message', async () => {
  let codeIn = '';
  const h = harness({
    code: async (r: any) => { codeIn = r.stdin; return { stdout: '{"n": 2}\n', stderr: '', exitCode: 0 }; },
    tool: async (r: any) => ({ got: r.args }),
    agent: async (_i: string, r: any) => (r.json ? 'Here you go: {"category":"billing"}' : 'plain'),
  });
  const f = flow([start(), agent('cls', { output: 'json', schema: { required: ['category'] } }), node('code', 'code', { language: 'javascript', source: 'x', timeoutSec: 5 }), node('tool', 'tool', { connectorId: 'c1', tool: 'lookup', args: { q: '{{cls.json.category}}' } }),
    node('file', 'output.file', { path: 'out/{{cls.json.category}}.txt', content: 'n={{code.json.n}} g={{tool.json.got.q}}' }), reply('reply', '{{file.path}}')],
    [['start', 'cls'], ['cls', 'code'], ['code', 'tool'], ['tool', 'file'], ['file', 'reply']]);
  const r = h.run(f);
  await execute(r, h.deps);
  assert.equal(r.status, 'done', r.state.error ?? '');
  assert.deepEqual(h.replies(), ['/files/out/billing.txt']);
  assert.equal(JSON.parse(codeIn).input.text, 'hello');
  assert.deepEqual(JSON.parse(codeIn).steps.cls.json, { category: 'billing' });
  // JSON repair, then give up
  let calls = 0;
  const bad = harness({ agent: async () => (++calls, 'not json at all') });
  const rb = bad.run(flow([start(), agent('cls', { output: 'json' }), reply('reply', '{{cls.text}}')], [['start', 'cls'], ['cls', 'reply']]));
  await execute(rb, bad.deps);
  assert.equal(calls, 2);
  assert.equal(rb.status, 'failed');
  assert.match(rb.state.error!, /The step "Agent" failed: The answer was not valid JSON/);
  assert.deepEqual(bad.events.filter((e) => e.hefyn === 'step_end' && e.status === 'failed').map((e) => e.node), ['cls']);
  for (const [out, re] of [[{ stdout: '', stderr: 'Traceback\nValueError: boom', exitCode: 1 }, /ValueError: boom/], [{ stdout: 'not json', stderr: '', exitCode: 0 }, /print its result as JSON/], [{ stdout: '', stderr: '', exitCode: 124, timedOut: true }, /longer than 5 seconds/]] as const) {
    const x = harness({ code: async () => out }), rx = x.run(flow([start(), node('code', 'code', { language: 'python', source: 'x', timeoutSec: 5 }), reply('reply', '{{code.text}}')], [['start', 'code'], ['code', 'reply']]));
    await execute(rx, x.deps);
    assert.equal(rx.status, 'failed');
    assert.match(rx.state.error!, re);
  }
});

test('engine: Stop cancels a running step; no reply at all still says so', async () => {
  const h = harness({ agent: (_i: string, _r: any) => new Promise((_ok, no) => { h.ctl.signal.addEventListener('abort', () => no(new Error('stopped'))); }) });
  const r = h.run(flow([start(), agent('draft'), reply()], [['start', 'draft'], ['draft', 'reply']]));
  const p = execute(r, h.deps);
  await new Promise((ok) => setTimeout(ok, 10));
  h.ctl.abort();
  await p;
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(h.events.at(-1), { hefyn: 'run_end', status: 'cancelled', runId: 'run1' });
  const n = harness(), rn = n.run(flow([start(), node('c', 'condition', { op: 'equals', left: 'a', right: 'b' }), reply('reply', 'x')], [['start', 'c'], ['c', 'reply', 'true']]));
  await execute(rn, n.deps);
  assert.equal(rn.status, 'done');
  assert.deepEqual(n.replies(), ['The flow finished without a reply.']);
});

// ---------- ownership, sharing, permissions, migration ----------
const app = new Hono().route('/api', api);
const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  vault.rememberUserKey(r.user.id, vault.newKey());
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
const admin = await mk('admin@x.test', 'admin');
const ann = await mk('ann@x.test', 'worker');
const bob = await mk('bob@x.test', 'worker');
connect({ id: 'anthropic' }, 'sk-ant-company');
const INPUTS = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };
const meta = { description: 'd', icon: 'Sparkles', inputs: INPUTS };
const twoStep = (name = 'Support') => flow([start(), node('r', 'router', { mode: 'rules', branches: [{ id: 'x', label: 'X', rule: { left: '{{start.text}}', op: 'contains', right: 'x' } }] }), agent('draft', { instructions: name }), reply('reply', '{{draft.text}}')],
  [['start', 'r'], ['r', 'draft', 'x'], ['r', 'draft', 'else'], ['draft', 'reply']]);

test('migration: every existing Assistant has the simple flow built from its columns (General keeps its sub-agents)', async () => {
  const g = getAssistant('default')!;
  assert.ok(g.simple && g.version === 1 && g.scope === 'team' && g.owner === null);
  const a = g.flow.nodes.find((n) => n.type === 'agent')!;
  assert.deepEqual(g.flow.nodes.map((n) => n.type), ['trigger.chat', 'agent', 'output.reply']);
  assert.deepEqual(a.config.subAgents.map((s: any) => s.name), ['explorer', 'writer']);
  assert.match(a.config.instructions, /You orchestrate/);
  // a legacy row (no flow yet) gets one
  db.prepare("INSERT INTO profiles (id, name, model, instructions, skills, agent) VALUES ('legacy', 'Old', 'anthropic/x', 'Be old.', '[\"s1\"]', 'codex-acp')").run();
  syncSimpleFlow('legacy');
  const l = getAssistant('legacy')!;
  assert.deepEqual([l.simple, l.flow.nodes[1]!.config.agent, l.flow.nodes[1]!.config.model, l.flow.nodes[1]!.config.instructions, l.flow.nodes[1]!.config.skills], [true, 'codex-acp', 'anthropic/x', 'Be old.', ['s1']]);
  // profile.update keeps the default's flow in step with its columns
  const opus = (await admin.trpc('assistants.options')).json.models.hefyn[0].id;
  assert.equal((await admin.trpc('profile.update', { model: opus, agents: { writer: opus } }, true)).status, 200);
  const after = getAssistant('default')!.flow.nodes[1]!.config;
  assert.equal(after.model, opus);
  assert.equal(after.subAgents.find((s: any) => s.name === 'writer').model, opus);
  db.prepare("DELETE FROM profiles WHERE id = 'legacy'").run();
});

test('private by default: only the owner sees, edits and starts it; the team and others do not', async () => {
  const made = await ann.trpc('assistants.save', { name: 'Ann private', ...meta, flow: twoStep(), roles: ['worker'] }, true);
  assert.equal(made.status, 200, String(made.error));
  assert.deepEqual([made.json.version, made.json.errors], [1, []]);
  const id = made.json.id as string;
  const a = getAssistant(id)!;
  assert.deepEqual([a.scope, a.owner, a.roles, a.simple, a.agent, a.instructions], ['private', ann.id, [], false, null, ''], 'private ones have no role list; a flow has no classic mirror');
  const listed = (u: typeof ann) => u.trpc('assistants.list').then((r) => r.json.map((x: any) => [x.name, x.owner, x.flow]));
  assert.deepEqual((await listed(ann)).find((x: any) => x[0] === 'Ann private'), ['Ann private', 'me', true]);
  for (const other of [bob, admin]) assert.ok(!(await listed(other)).some((x: any) => x[0] === 'Ann private'));
  assert.ok((await ann.trpc('assistants.editable')).json.some((x: any) => x.id === id && x.owner === 'me' && x.simple === false && x.shareStatus === null));
  assert.ok(!(await admin.trpc('assistants.editable')).json.some((x: any) => x.id === id), 'not even an admin sees a private one');
  assert.equal((await admin.trpc('assistants.get', { id })).status, 404);
  assert.equal((await bob.trpc('assistants.get', { id })).status, 404);
  assert.equal((await bob.trpc('assistants.save', { id, name: 'hijack', ...meta, flow: twoStep() }, true)).status, 404);
  assert.equal((await bob.trpc('assistants.remove', { id }, true)).status, 404);
  assert.equal((await bob.trpc('conversations.create', { assistantId: id }, true)).status, 403);
  const full = (await ann.trpc('assistants.get', { id })).json;
  assert.deepEqual([full.version, full.flow.nodes.length, full.owner, full.scope, Object.keys(full.inputs).length], [1, 4, 'me', 'private', 5]);
  // a chat on it is a flow chat
  const chat = (await ann.trpc('conversations.create', { assistantId: id }, true)).json;
  assert.equal(chat.flow, true);
  assert.equal(chat.agent, undefined);
  assert.equal((db.prepare('SELECT flow FROM conversations WHERE id = ?').get(chat.id) as any).flow, 1);
  assert.equal((await ann.trpc('conversations.list')).json.find((c: any) => c.id === chat.id).flow, true);
  // saving bumps the version
  const v2 = await ann.trpc('assistants.save', { id, name: 'Ann private', ...meta, flow: twoStep('v2') }, true);
  assert.equal(v2.json.version, 2);
});

test('save refuses invalid flows with the errors, plain; validate previews them', async () => {
  const cyc = flow([start(), agent('a'), agent('b'), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'b'], ['b', 'a'], ['a', 'reply']]);
  const bad = await ann.trpc('assistants.save', { name: 'Cyc', ...meta, flow: cyc }, true);
  assert.equal(bad.status, 400);
  assert.match(bad.error!, /lead back into themselves/);
  const v = (await ann.trpc('assistants.validate', { flow: cyc })).json;
  assert.match(v.errors[0].message, /lead back/);
  assert.ok(v.errors[0].node);
  const unknown = flow([start(), agent('a', { model: 'anthropic/not-a-model', skills: ['nope'], agent: 'ghost' }), reply('reply', '{{a.text}}')], [['start', 'a'], ['a', 'reply']]);
  const msgs = (await ann.trpc('assistants.validate', { flow: unknown })).json.errors.map((e: any) => e.message).join(' | ');
  assert.match(msgs, /agent that is not installed/);
  assert.match(msgs, /model chosen/);
  assert.match(msgs, /not an approved team skill/);
  const tool = flow([start(), node('t', 'tool', { connectorId: 'nope', tool: 'x', args: {} }), node('c', 'code', { language: 'python', source: 'print(1)' }), node('as', 'assistant', { assistantId: 'ghost', prompt: 'x' }), reply('reply', 'ok')], [['start', 't'], ['t', 'c'], ['c', 'as'], ['as', 'reply']]);
  const m2 = (await ann.trpc('assistants.validate', { flow: tool })).json.errors.map((e: any) => e.message).join(' | ');
  assert.match(m2, /connector that does not exist/);
  assert.match(m2, /does not exist or that you cannot use/);
  assert.match(m2, /sandbox, which you cannot use/, 'a private code step needs the sandbox permission');
  assert.equal((await ann.trpc('assistants.save', { name: 'x', ...meta, flow: { nope: true } }, true)).status, 400);
});

test('share: pending in the Hub review queue, approve makes a team copy, decline marks it; permissions apply', async () => {
  const id = (await ann.trpc('assistants.save', { name: 'Shared one', ...meta, flow: twoStep('team me'), roles: [] }, true)).json.id as string;
  assert.equal((await bob.trpc('assistants.share', { id }, true)).status, 404);
  const sh = await ann.trpc('assistants.share', { id }, true);
  assert.equal(sh.status, 200, String(sh.error));
  assert.equal((await ann.trpc('assistants.share', { id }, true)).status, 409, 'already waiting');
  assert.equal(getAssistant(id)!.shareStatus, 'pending');
  const queue = (await admin.trpc('hub.review')).json;
  const item = queue.find((p: any) => p.kind === 'assistant' && p.name === 'Shared one');
  assert.ok(item && item.status === 'pending' && item.owner.id === ann.id);
  const file = (await admin.trpc('hub.file', { id: item.id, path: 'assistant.json' })).json;
  assert.equal(JSON.parse(file).flow.nodes.length, 4);
  assert.equal((await bob.trpc('hub.get', { id: item.id })).status, 404, 'other users never see it in the Hub');
  assert.ok(!(await bob.trpc('hub.list')).json.some((p: any) => p.kind === 'assistant'));
  assert.equal((await bob.trpc('assistants.review', { id, decision: 'approve' }, true)).status, 403);
  assert.equal((await ann.trpc('assistants.review', { id, decision: 'approve' }, true)).status, 403, 'not even for your own');
  assert.ok(!(await bob.trpc('assistants.list')).json.some((a: any) => a.name === 'Shared one'), 'not before approval');

  assert.equal((await admin.trpc('assistants.review', { id, decision: 'approve' }, true)).status, 200);
  assert.equal(getAssistant(id)!.shareStatus, null);
  const copy = getAssistant(`t_${id}`)!;
  assert.deepEqual([copy.scope, copy.owner, copy.roles, copy.name], ['team', null, [], 'Shared one']);
  assert.ok((await bob.trpc('assistants.list')).json.some((a: any) => a.id === `t_${id}` && a.owner === 'team'));
  assert.ok((await ann.trpc('assistants.list')).json.some((a: any) => a.id === id && a.owner === 'me'), 'the owner keeps the private one');
  assert.ok((await admin.trpc('assistants.editable')).json.some((a: any) => a.id === `t_${id}`));
  assert.equal((await bob.trpc('assistants.get', { id: `t_${id}` })).status, 404, 'team ones are edited with assistants.manage');
  assert.equal((await admin.trpc('assistants.save', { id: `t_${id}`, name: 'Shared one', ...meta, flow: twoStep('admin edit'), roles: ['worker'] }, true)).json.version, 2);
  assert.deepEqual(visibleTo(bob.id, 'worker').map((a) => a.id).includes(`t_${id}`), true);
  assert.deepEqual(getAssistant(`t_${id}`)!.roles, ['worker']);

  // decline, with a note; sharing again after an edit starts a new review
  const id2 = (await ann.trpc('assistants.save', { name: 'Declined one', ...meta, flow: twoStep(), roles: [] }, true)).json.id as string;
  await ann.trpc('assistants.share', { id: id2 }, true);
  assert.equal((await admin.trpc('assistants.review', { id: id2, decision: 'decline', note: 'too vague' }, true)).status, 200);
  assert.equal(getAssistant(id2)!.shareStatus, 'declined');
  assert.ok(!getAssistant(`t_${id2}`));
  assert.equal((await admin.trpc('hub.get', { id: `asst_${id2}` })).json.rejectReason, 'too vague');
  assert.equal((await ann.trpc('assistants.share', { id: id2 }, true)).status, 200, 'again');
  assert.equal(getAssistant(id2)!.shareStatus, 'pending');
  // an Assistant that uses private things cannot be shared yet
  const priv = flow([start(), node('t', 'tool', { connectorId: 'nope', tool: 'x', args: {} }), reply('reply', 'ok')], [['start', 't'], ['t', 'reply']]);
  assert.equal((await ann.trpc('assistants.save', { name: 'Bad', ...meta, flow: priv }, true)).status, 400);
});

test('permissions: create, share and manage are separate switches per role', async () => {
  db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('viewer', 'Viewer', 0, ?)").run(JSON.stringify(['models.use']));
  db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('maker', 'Maker', 0, ?)").run(JSON.stringify(['models.use', 'assistants.create']));
  const viewer = await mk('viewer@x.test', 'viewer'), maker = await mk('maker@x.test', 'maker');
  const f = twoStep();
  assert.equal((await viewer.trpc('assistants.save', { name: 'V', ...meta, flow: f }, true)).status, 403);
  assert.equal((await viewer.trpc('assistants.options')).status, 403);
  assert.equal((await viewer.trpc('assistants.list')).status, 200, 'everyone with models.use still picks');
  const mine = await maker.trpc('assistants.save', { name: 'M', ...meta, flow: f }, true);
  assert.equal(mine.status, 200);
  assert.equal((await maker.trpc('assistants.share', { id: mine.json.id }, true)).status, 403, 'creating without sharing');
  assert.equal((await maker.trpc('assistants.save', { name: 'T', ...meta, flow: f, scope: 'team' }, true)).status, 403, 'a team one needs assistants.manage');
  assert.equal((await maker.trpc('assistants.setDefault', { id: mine.json.id }, true)).status, 403);
  const opts = (await maker.trpc('assistants.options')).json;
  assert.deepEqual(opts.roles, [], 'roles are for managers');
  assert.deepEqual(opts.nodeTypes.map((t: any) => t.type).slice(0, 3), ['trigger.chat', 'agent', 'assistant']);
  assert.ok(Array.isArray(opts.connectors) && Array.isArray(opts.assistants) && opts.agents[0].id === null && opts.thinking.includes('high'));
  assert.ok((await admin.trpc('assistants.options')).json.roles.some((r: any) => r.id === 'worker'));
  const team = await admin.trpc('assistants.save', { name: 'Team made', ...meta, flow: f, scope: 'team', roles: ['maker'] }, true);
  assert.equal(team.status, 200);
  assert.equal(getAssistant(team.json.id)!.scope, 'team');
  assert.ok((await maker.trpc('assistants.list')).json.some((a: any) => a.name === 'Team made'));
  assert.ok(!(await bob.trpc('assistants.list')).json.some((a: any) => a.name === 'Team made'), 'roles decide who sees a team one');
  assert.equal((await maker.trpc('assistants.archive', { id: team.json.id, archived: true }, true)).status, 404);
  assert.equal((await admin.trpc('assistants.archive', { id: team.json.id, archived: true }, true)).status, 200);
  // remove: own private (and the chats on it fall back), the default never
  const chat = (await maker.trpc('conversations.create', { assistantId: mine.json.id }, true)).json;
  assert.equal((await maker.trpc('assistants.remove', { id: mine.json.id }, true)).status, 200);
  assert.ok(!getAssistant(mine.json.id));
  assert.equal((await admin.trpc('assistants.remove', { id: 'default' }, true)).status, 400);
  assert.equal((await admin.trpc('assistants.remove', { id: team.json.id }, true)).status, 200);
  assert.ok(chat.id);
});

test('legacy save (no flow) still works for the first console: it builds the simple flow and keeps sub-agents', async () => {
  const made = await admin.trpc('assistants.save', { name: 'Legacy', ...meta, agent: null, model: null, thinking: null, instructions: 'Be old.', skills: [], roles: [] }, true);
  assert.equal(made.status, 200, String(made.error));
  const a = getAssistant(made.json.id)!;
  assert.deepEqual([a.simple, a.scope, a.instructions], [true, 'team', 'Be old.']);
  db.prepare('INSERT INTO profile_agents (profile_id, name, description, instructions, skills) VALUES (?,?,?,?,?)').run(a.id, 'helper', 'helps', 'Help.', '[]');
  syncSimpleFlow(a.id);
  assert.deepEqual(getAssistant(a.id)!.flow.nodes[1]!.config.subAgents.map((s: any) => s.name), ['helper']);
  await admin.trpc('assistants.save', { id: a.id, name: 'Legacy 2', ...meta, instructions: 'Newer.', roles: [] }, true);
  assert.deepEqual(getAssistant(a.id)!.flow.nodes[1]!.config.subAgents.map((s: any) => s.name), ['helper'], 'sub-agents survive a legacy save');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM profile_agents WHERE profile_id = ?').get(a.id) as any).n, 1);
  assert.equal((await admin.trpc('assistants.admin.list')).json.some((x: any) => x.id === a.id && x.simple), true);
});
