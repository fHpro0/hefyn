import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatActivity, delegations, elapsed, helperLine, mergeAgents } from '../web/src/components/activity.ts';
import { empty, fold, hasOpenAsk, nest, openWait, workers, type CliEvent, type Run } from '../web/src/components/cli-transcript.ts';

const run = (updates: any[]) => updates.reduce((s, update, i) => fold(s, { seq: i + 1, update } as CliEvent), empty);
const flow = [
  { hefyn: 'run_start', runId: 'p' }, { hefyn: 'step_start', runId: 'p', node: 'sub', label: 'Research', type: 'assistant' },
  { hefyn: 'run_start', runId: 'c', parentRunId: 'p', parentNode: 'sub' }, { hefyn: 'step_start', runId: 'c', node: 'draft', label: 'Draft', type: 'agent' },
];

test('a sub-run nests inside the step that started it and keeps its own steps', () => {
  const s = run(flow);
  assert.equal(s.items.length, 2); // the log is flat
  const n = nest(s.items) as Run[];
  assert.equal(n.length, 1);
  const child = n[0]!.steps[0]!.items[0] as Run;
  assert.equal(child.runId, 'c'); assert.equal(child.steps[0]!.label, 'Draft'); assert.equal(child.status, 'running');
  assert.equal(n[0]!.steps[0]!.items.length, 1);
});

test('a sub-run whose parent step was never seen stays at the top; replays do not change the result', () => {
  const s = run([{ hefyn: 'run_start', runId: 'p' }, { hefyn: 'run_start', runId: 'c', parentRunId: 'p', parentNode: 'ghost' }]);
  assert.equal(nest(s.items).length, 2);
  const evs = flow.map((update, i) => ({ seq: i + 1, update }) as CliEvent);
  assert.deepEqual(evs.concat(evs).reduce(fold, empty), evs.reduce(fold, empty));
});

test('a sub-run end does not end the turn or close the parent; the parent ending closes a running sub-run', () => {
  const s = run([...flow, { hefyn: 'run_end', runId: 'c', status: 'done' }]);
  assert.equal(s.busy, true);
  assert.equal((s.items[0] as Run).status, 'running');
  const ended = run([...flow, { hefyn: 'run_end', runId: 'p', status: 'failed' }]);
  assert.equal(ended.busy, false);
  assert.equal((ended.items[1] as Run).status, 'failed'); assert.equal((ended.items[1] as Run).steps[0]!.status, 'failed');
});

test('a question inside a sub-run is found', () => {
  const s = run([...flow, { hefyn: 'waiting', runId: 'c', node: 'draft', kind: 'ask', message: 'Which?' }]);
  assert.equal(hasOpenAsk(s.items), true); assert.equal(openWait(s.items)?.run.runId, 'c');
});

test('workers: running agent steps (also in sub-runs), the innermost step as label, nothing once the run ended', () => {
  const s = run(flow);
  const w = workers(s.items, true);
  assert.deepEqual(w.agents.map((a) => [a.kind, a.name]), [['step', 'Research'], ['step', 'Draft']]);
  assert.equal(w.label, 'Draft');
  assert.deepEqual(workers(nest(s.items), true).agents.length, 2);
  assert.deepEqual(workers(run([...flow, { hefyn: 'run_end', runId: 'p', status: 'done' }]).items, false).agents, []);
});

test('a Claude Code Task call becomes a sub-agent; its card keeps the description and finishes', () => {
  const s = run([
    { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Task', kind: 'think', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'Find the bug', status: 'in_progress', rawInput: { description: 'Find the bug', prompt: 'look', subagent_type: 'Explore' } },
    { sessionUpdate: 'tool_call', toolCallId: 'r', title: 'Read x', kind: 'read', status: 'in_progress' },
  ]);
  assert.equal((s.items[0] as any).sub, 'Find the bug'); assert.equal('sub' in (s.items[1] as object), false);
  assert.deepEqual(workers(s.items, true).agents, [{ name: 'Find the bug', kind: 'agent', state: 'running' }]);
  const done = fold(s, { seq: 9, update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' } });
  assert.deepEqual(workers(done.items, true).agents, []);
  assert.deepEqual(workers(s.items, false).agents, []); // a call left open by a stopped turn is not work
  const viaMeta = run([{ sessionUpdate: 'tool_call', toolCallId: 'm', title: 'Look around', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } }]);
  assert.equal((viaMeta.items[0] as any).sub, 'Look around');
});

test('classic delegations: running task parts only, named by input.agent', () => {
  const parts = [{ type: 'text' }, { type: 'dynamic-tool', toolName: 'task', input: { agent: 'Writer' }, state: 'input-available' }, { type: 'dynamic-tool', toolName: 'task', input: { agent: 'Explorer' }, state: 'output-available' }, { type: 'dynamic-tool', toolName: 'bash', state: 'input-available' }];
  const d = delegations(parts);
  assert.deepEqual(d.map((a) => a.name), ['Writer']);
  assert.equal(helperLine([...d, { name: 'Explorer', kind: 'helper', state: 'running' }]), 'Helpers working: Writer, Explorer');
  assert.equal(helperLine([]), '');
  assert.equal(helperLine([{ name: 'Draft the reply', kind: 'step', state: 'running' }, { name: 'Find', kind: 'agent', state: 'running' }]), 'Working on: Draft the reply · Sub-agent: Find');
});

test('activity: never idle while the page or the server says it works; sources merge once', () => {
  assert.equal(chatActivity(undefined, undefined).state, 'idle');
  assert.equal(chatActivity(undefined, { state: 'running', since: '2026-01-01T00:00:00Z' }).state, 'running'); // a reload before the log replayed
  assert.equal(chatActivity({ busy: true }, { state: 'waiting' }).state, 'running'); // the page knows the question was answered
  assert.equal(chatActivity({ busy: true, waiting: true }, { state: 'running' }).state, 'waiting');
  assert.equal(chatActivity({ busy: false }, { state: 'idle' }).state, 'idle');
  const a = chatActivity({ busy: true, since: 5, agents: [{ name: 'W', kind: 'helper', state: 'running' }] }, { state: 'running', since: '2026-01-01T00:00:00Z', agents: [{ name: 'W', kind: 'helper', state: 'running' }, { name: 'X', kind: 'agent', state: 'done' }, { name: 'Y', kind: 'agent', state: 'waiting' }] });
  assert.deepEqual(a.agents.map((x) => x.name), ['W', 'Y']); assert.equal(a.since, 5);
  assert.deepEqual(mergeAgents(undefined, undefined), []);
  // sub-agents carry an id: same-named ones stay two, an id-less local twin of one is dropped
  const sub = (id: string, state: 'running' | 'done' = 'running') => ({ id, name: 'Check', kind: 'agent' as const, state });
  assert.deepEqual(mergeAgents([{ name: 'Check', kind: 'agent', state: 'running' }], [sub('a'), sub('b'), sub('c', 'done')]).map((x) => x.id), ['a', 'b']);
});

test('elapsed reads as seconds, minutes, hours', () => {
  assert.deepEqual([0, 12_900, 252_000, 60_000, 2_854_000, 7_500_000, 7_200_000].map(elapsed), ['<1 s', '12 s', '4 min 12 s', '1 min', '47 min', '2 h 5 min', '2 h']);
});
