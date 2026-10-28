import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNode, canConnect, connect, fromSimple, insertAt, isSimple, layout, portsOf, removeNode, setConfig, toSimple, upstream, type Flow } from '../web/src/components/assistants/flow.ts';

const simple = () => fromSimple(null, { instructions: 'Be kind', skills: ['a'] });

test('graph ops: add keeps ids unique, one trigger, remove drops edges', () => {
  let f = simple();
  assert.equal(addNode(f, 'trigger.chat').id, undefined); // a second trigger is refused
  const a = addNode(f, 'agent'); f = a.flow;
  assert.equal(a.id, 'agent');
  assert.equal(f.nodes.find((n) => n.id === 'agent')!.config.prompt, '{{start.text}}');
  assert.equal(addNode(f, 'agent').id, 'agent2');
  f = removeNode(f, 'draft');
  assert.deepEqual(f.nodes.map((n) => n.id), ['start', 'reply', 'agent']);
  assert.equal(f.edges.length, 0);
});

test('connect: ports, duplicates, cycles, trigger input', () => {
  let f = simple();
  f = addNode(f, 'condition').flow;
  assert.deepEqual(portsOf(f.nodes.find((n) => n.id === 'condition')!).map((p) => p.id), ['true', 'false']);
  assert.equal(connect(f, 'condition', 'maybe', 'reply'), f); // unknown port
  const g = connect(f, 'condition', 'true', 'reply');
  assert.equal(g.edges.at(-1)!.port, 'true');
  assert.equal(connect(g, 'condition', 'true', 'reply'), g); // repeat
  assert.equal(canConnect(g, 'draft', undefined, 'start'), false); // into the trigger
  assert.equal(canConnect(g, 'reply', undefined, 'draft'), false); // out of a reply
  const h = connect(g, 'draft', undefined, 'condition');
  assert.equal(canConnect(h, 'reply', undefined, 'draft'), false);
  assert.equal(canConnect(connect(f, 'draft', undefined, 'condition'), 'condition', 'false', 'draft'), false); // cycle
});

test('removing a router branch drops its edges', () => {
  let f: Flow = addNode(simple(), 'router').flow;
  f = connect(f, 'router', 'b1', 'reply');
  assert.equal(f.edges.length, 3);
  f = setConfig(f, 'router', { branches: [{ id: 'b2', label: 'Two' }] });
  assert.equal(f.edges.length, 2);
});

test('layout: layers left to right, branches get their own rows', () => {
  let f = simple();
  f = addNode(f, 'condition').flow;
  f = connect(connect(f, 'start', undefined, 'condition'), 'condition', 'true', 'draft');
  f = addNode(f, 'output.reply').flow;
  f = connect(f, 'condition', 'false', 'reply2');
  const l = layout(f);
  const at = (id: string) => l.nodes.find((n) => n.id === id)!.position;
  assert.ok(at('start').x < at('condition').x && at('condition').x < at('draft').x && at('draft').x < at('reply').x);
  assert.equal(at('draft').x, at('reply2').x);
  assert.notEqual(at('draft').y, at('reply2').y);
});

test('upstream lists only steps that can run before', () => {
  let f = simple();
  f = addNode(f, 'template').flow;
  f = connect(f, 'draft', undefined, 'template');
  assert.deepEqual(upstream(f, 'template').map((u) => u.id), ['start', 'draft']);
  assert.deepEqual(upstream(f, 'reply').map((u) => u.id), ['start', 'draft']);
  assert.deepEqual(upstream(f, 'draft').map((u) => u.id), ['start']);
  assert.deepEqual(upstream(f, 'start'), []);
  assert.deepEqual(upstream(f, 'draft')[0]!.refs, ['{{start.text}}', '{{start.files}}']);
});

test('simple <-> flow round trip', () => {
  const f = simple();
  assert.ok(isSimple(f));
  const s = toSimple(f)!;
  assert.equal(s.instructions, 'Be kind');
  assert.deepEqual(s.skills, ['a']);
  const g = fromSimple(f, { ...s, model: 'm1' });
  assert.equal(g.nodes.find((n) => n.id === 'draft')!.config.prompt, '{{start.text}}'); // untouched
  assert.equal(toSimple(g)!.model, 'm1');
  const big = addNode(g, 'template').flow;
  assert.equal(isSimple(big), false);
  assert.equal(toSimple(big), null);
  assert.equal(isSimple(connect(g, 'start', undefined, 'reply')), false); // extra edge
});

test('insertAt puts the value at the caret', () => {
  assert.deepEqual(insertAt('Hi , bye', 3, 3, '{{a.text}}'), { text: 'Hi {{a.text}}, bye', caret: 13 });
  assert.equal(insertAt('abc', 1, 2, 'X').text, 'aXc');
});
