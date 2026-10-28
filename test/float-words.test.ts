import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floatWords } from '../web/src/components/float-words.ts';

const text = (value: string) => ({ type: 'text', value });
const el = (tagName: string, ...children: any[]) => ({ type: 'element', tagName, properties: {}, children });
const run = (tree: any, opts?: Parameters<typeof floatWords>[0]) => { floatWords(opts)(tree); return tree; };
const flat = (n: any): string => (n.value ?? n.children?.map(flat).join('') ?? '');
const spans = (n: any): any[] => (n.children ?? []).flatMap((c: any) => (c.properties?.className?.includes('hf-word') ? [c] : spans(c)));

test('floatWords: words are wrapped with increasing --i, whitespace is kept', () => {
  const tree = run(el('p', text('one  two\nthree')));
  assert.deepEqual(spans(tree).map((s) => s.properties.style), ['--i:0', '--i:1', '--i:2']);
  assert.equal(flat(tree), 'one  two\nthree');
});

test('floatWords: a re-render over the same text keeps the first run\'s delays', () => {
  const delays: number[] = [];
  run(el('p', text('a b c')), { delays });
  assert.deepEqual(spans(run(el('p', text('a b c')), { delays })).map((s) => s.properties.style), ['--i:0', '--i:1', '--i:2']);
});

test('floatWords: longer text keeps old delays and counts the appended words from the old end', () => {
  const delays: number[] = [];
  run(el('p', text('a b')), { delays });
  assert.deepEqual(spans(run(el('p', text('a b c d e')), { delays })).map((s) => s.properties.style), ['--i:0', '--i:1', '--i:0', '--i:1', '--i:2']);
});

test('floatWords: inline code floats in as one unit with its own index, a code block is left alone, other inline elements are wrapped', () => {
  const tree = run(el('div', el('p', text('see '), el('code', text('a b')), text(' now '), el('strong', text('bold'))), el('pre', el('code', text('x y')))));
  assert.deepEqual(spans(tree).map(flat), ['see', 'a b', 'now', 'bold']);
  assert.deepEqual(spans(tree).map((s) => s.properties.style), ['--i:0', '--i:1', '--i:2', '--i:3']);
  assert.equal(flat(tree), 'see a b now boldx y');
  assert.equal(spans(tree).length, 4, 'nothing inside the code is wrapped on its own');
});
