import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addAfter, addNode, align, badRefs, suggest, upstream, connect, copyNodes, distribute, duplicateNodes, insertOnEdge, parseClip, pasteClip, sampleInput, setConfig, type Flow } from '../web/src/components/assistants/flow.ts';

const base = (): Flow => ({
  version: 1,
  nodes: [
    { id: 'start', type: 'trigger.chat', position: { x: 0, y: 0 }, config: {} },
    { id: 'draft', type: 'agent', position: { x: 380, y: 0 }, config: { prompt: '{{start.text}}' } },
    { id: 'shout', type: 'template', position: { x: 760, y: 100 }, config: { text: 'Hi {{draft.text}} / {{start.text}} / {{x:NAME}}' } },
    { id: 'reply', type: 'output.reply', position: { x: 1140, y: 0 }, config: { text: '{{shout.text}}' } },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'draft' }, { id: 'e2', from: 'draft', to: 'shout' }, { id: 'e3', from: 'shout', to: 'reply' }],
});

test('paste: fresh ids, internal edges kept, templates between copies remapped, outside refs untouched', () => {
  const f = base();
  const clip = copyNodes(f, ['draft', 'shout', 'start']);
  const { flow, ids } = pasteClip(f, clip, { x: 1000, y: 500 });
  assert.deepEqual(ids, ['draft2', 'shout2']); // the trigger is not pasted twice
  const shout2 = flow.nodes.find((n) => n.id === 'shout2')!;
  assert.equal(shout2.config.text, 'Hi {{draft2.text}} / {{start.text}} / {{x:NAME}}');
  assert.equal(flow.nodes.find((n) => n.id === 'draft2')!.config.prompt, '{{start.text}}'); // start was not renamed: no copy of it
  assert.deepEqual(flow.edges.slice(3).map((e) => [e.from, e.to]), [['draft2', 'shout2']]);
  assert.equal(new Set(flow.edges.map((e) => e.id)).size, flow.edges.length);
  assert.deepEqual(flow.nodes.find((n) => n.id === 'draft2')!.position, { x: 1000, y: 500 }); // top-left lands on the click
  assert.deepEqual(flow.nodes.find((n) => n.id === 'shout2')!.position, { x: 1380, y: 600 });
  assert.equal(f.nodes.length, 4); // the source flow is not touched
});

test('paste: remaps when the referenced node is copied too, keeps ports, offsets without a position', () => {
  let f = addNode(base(), 'condition').flow;
  f = connect(f, 'condition', 'true', 'reply');
  f = setConfig(f, 'condition', { left: '{{draft.text}}' });
  const { flow, ids } = duplicateNodes(f, ['draft', 'condition']);
  assert.deepEqual(ids, ['draft2', 'condition2']);
  assert.equal(flow.nodes.find((n) => n.id === 'condition2')!.config.left, '{{draft2.text}}');
  assert.equal(flow.edges.some((e) => e.from === 'condition2'), false); // edges to nodes outside the copy are not copied
  assert.deepEqual(flow.nodes.find((n) => n.id === 'draft2')!.position, { x: 420, y: 40 });
});

test('paste: a code step source is left alone; parseClip only accepts our JSON', () => {
  const f = addNode(base(), 'code').flow;
  const code = setConfig(f, 'code', { source: 'const a = `{{draft.text}}`' });
  const { flow } = duplicateNodes(code, ['draft', 'code']);
  assert.equal(flow.nodes.find((n) => n.id === 'code2')!.config.source, 'const a = `{{draft.text}}`');
  assert.equal(parseClip('nope'), null);
  assert.equal(parseClip('{"a":1}'), null);
  assert.ok(parseClip(JSON.stringify(copyNodes(f, ['draft']))));
});

test('insert on edge splits it and keeps the source port; refuses what has no output', () => {
  let f = addNode(base(), 'condition').flow;
  f = connect(f, 'condition', 'true', 'reply');
  const r = insertOnEdge(f, 'e3', 'template');
  assert.equal(r.id, 'template');
  assert.deepEqual(r.flow.edges.filter((e) => e.from === 'shout' || e.to === 'reply').map((e) => [e.from, e.to]), [['condition', 'reply'], ['shout', 'template'], ['template', 'reply']]);
  assert.equal(r.flow.edges.some((e) => e.from === 'shout' && e.to === 'reply'), false);
  const c = insertOnEdge(base(), 'e1', 'condition'); // a condition has ports: first one continues
  assert.equal(c.flow.edges.find((e) => e.from === 'condition')!.port, 'true');
  assert.equal(insertOnEdge(base(), 'e1', 'output.reply').flow.edges.length, 3); // refused
  assert.equal(insertOnEdge(base(), 'e1', 'trigger.chat').id, undefined);
  assert.equal(insertOnEdge(base(), 'nope', 'template').id, undefined);
  // the port of a branch edge is kept
  let g = addNode(base(), 'condition').flow;
  g = connect(g, 'condition', 'false', 'reply');
  const s = insertOnEdge(g, 'e4', 'template');
  assert.equal(s.flow.edges.find((e) => e.to === 'template')!.port, 'false');
});

test('add after: uses the first free port, offsets below existing children', () => {
  let f = addNode(base(), 'condition').flow;
  const a = addAfter(f, 'condition', 'template');
  assert.equal(a.flow.edges.at(-1)!.port, 'true');
  const b = addAfter(a.flow, 'condition', 'template');
  assert.equal(b.flow.edges.at(-1)!.port, 'false');
  assert.equal(addAfter(b.flow, 'condition', 'template', 'true').flow.edges.at(-1)!.port, 'true');
  assert.equal(addAfter(base(), 'reply', 'template').id, undefined); // Reply has no output
  const n = addAfter(base(), 'draft', 'agent');
  assert.deepEqual(n.flow.edges.at(-1), { id: 'e4', from: 'draft', to: 'agent' });
  assert.equal(n.flow.nodes.at(-1)!.position.x, 760);
});

test('align and distribute', () => {
  const f = base();
  const a = align(f, ['draft', 'shout', 'reply'], 'top');
  assert.deepEqual(a.nodes.map((n) => n.position.y), [0, 0, 0, 0]);
  assert.deepEqual(align(f, ['draft', 'shout'], 'left').nodes.map((n) => n.position.x), [0, 380, 380, 1140]);
  assert.equal(align(f, ['draft'], 'left'), f);
  const nodes = f.nodes.map((n) => (n.id === 'draft' ? { ...n, position: { x: 100, y: 0 } } : n));
  const d = distribute({ ...f, nodes }, ['start', 'draft', 'reply'], 'x');
  assert.deepEqual(d.nodes.map((n) => n.position.x), [0, 570, 760, 1140]);
  assert.equal(distribute(f, ['start', 'reply'], 'x'), f);
});

test('sample input follows the template references; a code step gets every earlier step', () => {
  const f = base();
  assert.deepEqual(sampleInput(f, 'shout'), { draft: { text: 'Hello', json: {} }, start: { text: 'Hello', files: [] } });
  const c = setConfig(addAfter(f, 'shout', 'code').flow, 'code', { source: 'x' });
  assert.deepEqual(Object.keys(sampleInput(c, 'code')).sort(), ['draft', 'shout', 'start']);
  assert.deepEqual(sampleInput(f, 'nope'), {});
});

test('suggestions: upstream steps only, then the fields of the named step, json keys from a schema', () => {
  let f = base();
  f = setConfig(f, 'draft', { output: 'json', schema: '{"type":"object","properties":{"category":{},"score":{}}}' });
  const refs = upstream(f, 'shout'); // draft and start; never reply or shout itself
  const all = suggest(refs, 'Hello {{')!;
  assert.equal(all.from, 8);
  assert.deepEqual(all.options.map((o) => o.label).sort(), ['draft.json', 'draft.json.category', 'draft.json.score', 'draft.text', 'start.files', 'start.text']);
  assert.ok(all.options.some((o) => o.label === 'draft.json.category' && o.display === 'Agent → category'));
  const after = suggest(refs, 'x {{ draft.')!;
  assert.equal(after.from, 5);
  assert.deepEqual(after.options.map((o) => o.label), ['draft.text', 'draft.json', 'draft.json.category', 'draft.json.score']);
  assert.deepEqual(suggest(refs, '{{nope.')!.options, []);
  assert.equal(suggest(refs, 'no braces'), null);
  assert.equal(suggest(refs, '{{a}} done'), null); // already closed
});

test('bad references: a step that cannot have run before is flagged, var placeholders are not', () => {
  const text = '{{start.text}} {{ghost.text}} {{x:NAME}} {{ draft.json.x }}';
  assert.deepEqual(badRefs(text, ['start', 'draft']).map((b) => [b.id, text.slice(b.from, b.to)]), [['ghost', '{{ghost.text}}']]);
});
