import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, empty, fold, hasOpenAsk, openWait, pendingAsks, type CliEvent } from '../web/src/components/cli-transcript.ts';

const run = (updates: any[], from = 0) => updates.reduce((s, update, i) => fold(s, { seq: from + i + 1, update } as CliEvent), empty);
const text = (t: string) => ({ type: 'text', text: t });

test('consecutive chunks merge into one message; other kinds break the run', () => {
  const s = run([{ hefyn: 'user', text: 'hi' }, { sessionUpdate: 'agent_thought_chunk', content: text('hm') }, { sessionUpdate: 'agent_message_chunk', content: text('Hel') }, { sessionUpdate: 'agent_message_chunk', content: text('lo') }]);
  assert.deepEqual(s.items, [{ kind: 'user', text: 'hi' }, { kind: 'thought', text: 'hm' }, { kind: 'agent', text: 'Hello' }]);
});

test('ACP messages: token chunks of one messageId join without a separator; another id, a turn end or a tool call starts a new paragraph', () => {
  const m = (t: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', content: text(t), messageId });
  const texts = (u: any[]) => run(u).items.filter((x: any) => x.kind === 'agent').map((x: any) => x.text);
  assert.deepEqual(texts([m('all q', 'a'), m('uiet', 'a'), m('.', 'a')]), ['all quiet.']); // one message streamed in tokens
  assert.deepEqual(texts([m('all quiet.', 'a'), m('Noted.', 'b')]), ['all quiet.', 'Noted.']); // a new messageId
  assert.deepEqual(texts([{ hefyn: 'turn_start' }, m('all quiet.'), { hefyn: 'turn_end', stopReason: 'end_turn' }, m('Noted.')]), ['all quiet.', 'Noted.']); // a turn boundary, no ids
  assert.deepEqual(texts([m('a'), { sessionUpdate: 'tool_call', toolCallId: 't', title: 'x' }, m('b')]), ['a', 'b']);
  assert.deepEqual(texts([m('Hel'), m('lo')]), ['Hello']); // no ids, no boundary
});

test('a permission answer lands on the tool row of its call: one row, not two', () => {
  const opts = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'No', kind: 'reject_once' }];
  const go = (answer: string) => run([
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash ls', kind: 'execute', status: 'pending' },
    { hefyn: 'permission', requestId: 'r1', toolCall: { toolCallId: 't1', title: 'Bash ls' }, options: opts },
    { hefyn: 'permission_resolved', requestId: 'r1', optionId: answer },
  ]).items;
  assert.deepEqual(go('allow').map((x: any) => x.kind), ['tool']); assert.equal((go('allow')[0] as any).allowed, true);
  assert.equal((go('deny')[0] as any).allowed, false);
});

test('tool call updates fold into one card by toolCallId', () => {
  const s = run([
    { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Edit x', kind: 'edit', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'diff', path: 'x', oldText: 'a', newText: 'b' }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'zzz', status: 'failed' },
  ]);
  assert.equal(s.items.length, 1);
  assert.deepEqual(s.items[0], { kind: 'tool', id: 'a', title: 'Edit x', toolKind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'x', oldText: 'a', newText: 'b' }], rawInput: undefined, rawOutput: undefined });
});

test('a plan replaces the previous plan; permission resolves in place', () => {
  const s = run([
    { sessionUpdate: 'plan', entries: [{ content: 'one', status: 'pending' }] },
    { sessionUpdate: 'plan', entries: [{ content: 'one', status: 'completed' }] },
    { hefyn: 'permission', requestId: 'r1', toolCall: { title: 'Run ls' }, options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }] },
    { hefyn: 'permission_resolved', requestId: 'r1', optionId: 'y' },
  ]);
  assert.equal(s.items.filter((i: { kind: string }) => i.kind === 'plan').length, 1);
  assert.deepEqual((s.items[1] as any).answered, { optionId: 'y' });
});

test('replaying events by seq is idempotent; turn and status events set flags', () => {
  const evs: CliEvent[] = [
    { seq: 1, update: { hefyn: 'turn_start' } }, { seq: 2, update: { sessionUpdate: 'agent_message_chunk', content: text('a') } }, { seq: 3, update: { sessionUpdate: 'agent_message_chunk', content: text('b') } },
  ];
  const once = evs.reduce(fold, empty);
  const twice = [...evs, ...evs].reduce(fold, empty);
  assert.deepEqual(twice, once);
  assert.equal(twice.busy, true);
  assert.equal(fold(twice, { seq: 4, update: { hefyn: 'turn_end', stopReason: 'end_turn' } }).busy, false);
  assert.equal((twice.items[0] as any).text, 'ab');
});

test('diffLines cuts unchanged ends', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nX\nc'), [{ sign: '-', text: 'b' }, { sign: '+', text: 'X' }]);
  assert.deepEqual(diffLines(null, 'new'), [{ sign: '+', text: 'new' }]);
});

test('turn end notes: stopped, empty, and nothing extra when an error already said it', () => {
  const end = (reason: string, mid: any[] = []) => run([{ hefyn: 'turn_start' }, ...mid, { hefyn: 'turn_end', stopReason: reason }]).items.map((i: { kind: string }) => i.kind);
  assert.deepEqual(end('cancelled', [{ sessionUpdate: 'agent_message_chunk', content: text('x') }]), ['agent', 'stopped']);
  assert.deepEqual(end('end_turn'), ['empty']);
  assert.deepEqual(end('end_turn', [{ hefyn: 'error', message: 'no' }]), ['error']);
  assert.deepEqual(end('end_turn', [{ sessionUpdate: 'agent_message_chunk', content: text('x') }]), ['agent']);
});

test('replay of a whole turn in one batch keeps both agent texts, even after empty first chunks', () => {
  const chunks = (...t: string[]) => t.map((x) => ({ sessionUpdate: 'agent_message_chunk', content: text(x) }));
  const s = run([
    { hefyn: 'user', text: 'write' }, { hefyn: 'status', state: 'starting' }, { hefyn: 'status', state: 'ready' }, { hefyn: 'turn_start' },
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ...chunks('', 'I\'ll wr', 'ite tha', 't note ', 'into yo', 'ur file', 's.'),
    { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Write note.txt', kind: 'edit', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', content: [{ type: 'content', content: text('boom') }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'Write note.txt' },
    ...chunks('', 'Done. T', 'hanks.'),
    { hefyn: 'turn_end', stopReason: 'end_turn' }, { hefyn: 'status', state: 'stopped' },
  ]);
  assert.deepEqual(s.items.map((i: any) => i.kind === 'agent' ? i.text : i.kind), ['user', "I'll write that note into your files.", 'tool', 'Done. Thanks.']);
});

const flow = (updates: any[]) => updates.reduce((s, update, i) => fold(s, { seq: i + 1, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 4)).toISOString(), update } as CliEvent), empty);

test('a run folds into one card: steps, skipped, failed, outputs, reply after it', () => {
  const s = flow([
    { hefyn: 'user', text: 'go' }, { hefyn: 'run_start', runId: 'r', assistantId: 'a' },
    { hefyn: 'step_start', runId: 'r', node: 'n1', label: 'Draft', type: 'agent' }, { hefyn: 'step_output', runId: 'r', node: 'n1', text: 'hi' }, { hefyn: 'step_end', runId: 'r', node: 'n1', status: 'done' },
    { hefyn: 'step_end', runId: 'r', node: 'n2', status: 'skipped' },
    { hefyn: 'step_start', runId: 'r', node: 'n3', label: 'Code', type: 'code' }, { hefyn: 'step_output', runId: 'r', node: 'n3', json: { a: 1 } }, { hefyn: 'step_end', runId: 'r', node: 'n3', status: 'failed', error: 'boom' },
    { sessionUpdate: 'agent_message_chunk', content: text('Done') }, { hefyn: 'run_end', runId: 'r', status: 'failed' },
  ]);
  const run = s.items[1] as any;
  assert.deepEqual(s.items.map((i: any) => i.kind), ['user', 'run', 'agent']);
  assert.deepEqual(run.steps.map((x: any) => [x.node, x.status]), [['n1', 'done'], ['n2', 'skipped'], ['n3', 'failed']]);
  assert.equal(run.steps[0].text, 'hi'); assert.deepEqual(run.steps[2].json, { a: 1 }); assert.equal(run.steps[2].error, 'boom');
  assert.equal(run.status, 'failed'); assert.equal(run.endedAt! - run.startedAt!, 36000); assert.equal(s.busy, false);
});

test('CLI agent updates with runId/node nest under their step; permission resolves there', () => {
  const s = flow([
    { hefyn: 'run_start', runId: 'r' }, { hefyn: 'step_start', runId: 'r', node: 'n', label: 'Code agent', type: 'agent' },
    { sessionUpdate: 'tool_call', runId: 'r', node: 'n', toolCallId: 't', title: 'Edit x', status: 'pending' },
    { hefyn: 'permission', runId: 'r', node: 'n', requestId: 'p', toolCall: { title: 'Edit x' }, options: [] },
    { hefyn: 'permission_resolved', requestId: 'p', optionId: 'y' },
    { sessionUpdate: 'tool_call_update', runId: 'r', node: 'n', toolCallId: 't', status: 'completed' },
  ]);
  assert.equal(s.items.length, 1);
  const inner = (s.items[0] as any).steps[0].items;
  assert.deepEqual(inner.map((i: any) => i.kind), ['tool', 'permission']);
  assert.equal(inner[0].status, 'completed'); assert.deepEqual(inner[1].answered, { optionId: 'y' });
});

test('waiting stays open until its step ends; run end closes it; replay by seq is idempotent', () => {
  const evs: CliEvent[] = [
    { seq: 1, update: { hefyn: 'run_start', runId: 'r' } }, { seq: 2, update: { hefyn: 'step_start', runId: 'r', node: 'ok', label: 'Approve', type: 'approval' } },
    { seq: 3, update: { hefyn: 'waiting', runId: 'r', node: 'ok', kind: 'approval', message: 'Send?', editable: true, content: 'hello' } },
  ];
  const w = evs.reduce(fold, empty);
  assert.deepEqual(evs.concat(evs).reduce(fold, empty), w);
  assert.equal(hasOpenAsk(w.items), true);
  assert.equal(openWait(w.items)?.step.waiting?.content, 'hello');
  const answered = fold(w, { seq: 4, update: { hefyn: 'step_end', runId: 'r', node: 'ok', status: 'done' } });
  assert.equal(hasOpenAsk(answered.items), false);
  const stopped = fold(w, { seq: 4, update: { hefyn: 'run_end', runId: 'r', status: 'cancelled' } });
  assert.equal(hasOpenAsk(stopped.items), false); assert.equal((stopped.items[0] as any).steps[0].status, 'skipped'); assert.equal(stopped.busy, false);
});

test('a terminal marker in the middle of a message does not split it', () => {
  const chunks = [{ sessionUpdate: 'agent_message_chunk', content: text('ab') }, { sessionUpdate: 'agent_message_chunk', content: text('cd') }];
  let s = fold(empty, { seq: 1, update: chunks[0] });
  s = { ...s, items: [...s.items, { kind: 'aside' }] };
  s = fold(s, { seq: 2, update: chunks[1] });
  assert.deepEqual(s.items, [{ kind: 'agent', text: 'abcd' }, { kind: 'aside' }]);
});

test('sub-agents: their events fold into a lane of their own, the list keeps status and times, the Agent card links to it; the main flow is untouched', () => {
  const at = (s: string) => new Date(s).toISOString();
  let s = empty, seq = 0;
  const feed = (update: any, when = '2026-10-27T10:00:00Z') => (s = fold(s, { seq: ++seq, at: at(when), update }));
  feed({ hefyn: 'turn_start' });
  feed({ sessionUpdate: 'tool_call', toolCallId: 'toolu_04', title: 'Agent sub job', kind: 'think', status: 'in_progress', rawInput: { description: 'sub job', prompt: 'p', subagent_type: 'general-purpose' } });
  feed({ hefyn: 'subagent', agentId: 'a1', status: 'running', type: 'general-purpose', description: 'sub job', toolCallId: 'toolu_04' }, '2026-10-27T10:00:01Z');
  feed({ hefyn: 'user', text: 'the brief', agent: 'a1' });
  feed({ sessionUpdate: 'agent_message_chunk', content: text('looking'), agent: 'a1' });
  feed({ sessionUpdate: 'tool_call', toolCallId: 'toolu_05', title: 'Write sub.txt', kind: 'edit', status: 'in_progress', agent: 'a1' });
  assert.deepEqual(s.items.map((x) => x.kind), ['tool'], 'nothing of the sub-agent in the main flow');
  assert.equal((s.items[0] as any).agentId, 'a1');
  assert.deepEqual(s.lanes.a1!.map((x) => x.kind), ['user', 'agent', 'tool']);
  assert.deepEqual(s.agents.map((a) => [a.id, a.status, a.description, a.startedAt]), [['a1', 'running', 'sub job', Date.parse('2026-10-27T10:00:01Z')]]);
  feed({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_05', status: 'completed', agent: 'a1' });
  feed({ hefyn: 'subagent', agentId: 'a1', status: 'done' }, '2026-10-27T10:00:09Z');
  assert.deepEqual([s.agents[0]!.status, s.agents[0]!.endedAt, s.agents[0]!.description], ['done', Date.parse('2026-10-27T10:00:09Z'), 'sub job'], 'an end event keeps the description');
  assert.equal((s.lanes.a1!.at(-1) as any).status, 'completed');
  assert.equal(s.busy, true, 'a sub-agent\'s events do not end or start the turn');
  assert.equal(fold(s, { seq: 1, update: { hefyn: 'subagent', agentId: 'a1', status: 'failed' } }), s, 'a replayed seq changes nothing');
});

test('a sub-agent\'s question stays open when the turn ends, and its answer by Claude Code says nobody clicked', () => {
  const s = run([
    { hefyn: 'turn_start' },
    { hefyn: 'permission', requestId: 'r1', toolCall: { title: 'Write x' }, options: [], by: 'a1' },
    { hefyn: 'permission', requestId: 'r2', toolCall: { title: 'Write y' }, options: [] },
    { hefyn: 'turn_end', stopReason: 'end_turn' },
  ]);
  assert.deepEqual(s.items.filter((x: any) => x.kind === 'permission').map((x: any) => [x.requestId, !!x.answered]), [['r1', false], ['r2', true]]);
  assert.equal(hasOpenAsk(s.items), true);
  const r = fold(s, { seq: 99, update: { hefyn: 'permission_resolved', requestId: 'r1', optionId: 'allow', by: 'claude' } });
  assert.deepEqual((r.items.find((x: any) => x.requestId === 'r1') as any).answered, { optionId: 'allow', by: 'claude' });
});

test('a prompt typed in the terminal gets a divider after a chat message; a failed start is not "starting" any more', () => {
  const s = run([{ hefyn: 'user', text: 'chat' }, { hefyn: 'user', text: 'term', via: 'terminal' }, { hefyn: 'user', text: 'term 2', via: 'terminal' }, { hefyn: 'user', text: 'chat again' }]);
  assert.deepEqual(s.items.map((x: any) => x.kind), ['user', 'aside', 'user', 'user', 'user']);
  const f = run([{ hefyn: 'status', state: 'starting' }, { hefyn: 'error', message: 'nope' }]);
  assert.equal(f.status, '');
});

test('an ACP image in a tool update becomes an image content with a data URL', () => {
  const s = run([
    { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read x.png', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }, { type: 'content', content: { type: 'image', uri: 'javascript:1' } }, { type: 'content', content: { type: 'image', uri: 'https://evil.test/a.png' } }, { type: 'content', content: { type: 'image', data: 'data:text/html;base64,AA' } }] },
  ]);
  assert.deepEqual((s.items[0] as any).content, [{ type: 'image', src: 'data:image/png;base64,AAAA' }]);
});

test('pendingAsks lists open permissions of the chat and of every lane, once each', () => {
  const opts = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
  const s = run([
    { hefyn: 'permission', requestId: 'r1', toolCall: { title: 'Bash ls' }, options: opts },
    { hefyn: 'permission', requestId: 'r2', agent: 'a1', toolCall: { toolCallId: 't', title: 'Write /f.md' }, options: opts },
    { hefyn: 'permission', requestId: 'r3', agent: 'a1', toolCall: { title: 'Bash x' }, options: opts },
    { hefyn: 'permission_resolved', requestId: 'r3', agent: 'a1', optionId: 'allow' },
  ]);
  assert.deepEqual(pendingAsks(s).map((x) => [x.ask.requestId, x.agent]), [['r1', undefined], ['r2', 'a1']]);
});
