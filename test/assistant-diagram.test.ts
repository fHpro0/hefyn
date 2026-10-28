import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapse, groups, snippet, trace } from '../web/src/components/assistants/diagram-model.ts';

const names = { agent: (id: string) => id.toUpperCase(), skill: (id: string) => `skill ${id}`, mcp: (id: string) => `mcp ${id}` };
const base = { agent: 'a', skills: [], bundledSkills: [], mcp: [], helpers: [], files: [] };

test('empty groups are left out; skills say where they live', () => {
  assert.deepEqual(groups(base, names), []);
  const g = groups({ ...base, skills: ['s1'], bundledSkills: ['mine'], helpers: [{ role: 'review', agent: 'c' }, { role: 'fix', agent: 'c', edit: true }], files: ['docs/a.md'] }, names);
  assert.deepEqual(g.map((x) => x.key), ['skills', 'helpers', 'files']);
  assert.deepEqual(g[0]!.items, [{ label: 'skill s1', tag: 'on hefyn', hint: undefined }, { label: 'mine', tag: 'own', file: 'skills/mine/SKILL.md' }]);
  assert.deepEqual(g[1]!.items[0], { label: 'review', tag: 'read-only', hint: '→ C' });
  assert.equal(g[1]!.items[1]!.tag, 'can edit files');
  assert.equal(g[1]!.file, 'helpers.json');
  assert.equal(g[2]!.title, 'Files (1)');
  assert.equal(g[2]!.items[0]!.file, 'docs/a.md');
  assert.deepEqual(g.map((x) => x.verb), ['uses skill', 'delegates to', 'reads']);
});

test('catalog skills carry their description as a hint', () => {
  assert.equal(groups({ ...base, skills: ['s1'] }, { ...names, skillHint: () => 'does x' })[0]!.items[0]!.hint, 'does x');
});

test('snippet folds whitespace and cuts; trace runs from You through the agent', () => {
  assert.equal(snippet('a\n\n b  c'), 'a b c');
  assert.equal(snippet('x'.repeat(200)).length, 121);
  assert.equal(snippet(undefined), '');
  assert.equal(snippet('# Research helper\n\nYou answer with **sources**.\n\n- first point\n2. _second_ `code`'), 'Research helper You answer with sources. first point second code');
  assert.equal(snippet('> quote [t](http://u) ![img](a.png) <b>x</b>\n```js\nfoo_bar\n```'), 'quote t img x foo_bar');
  assert.deepEqual([...trace('skills:2')].sort(), ['agent', 'skills', 'skills:2', 'you']);
  assert.deepEqual([...trace('mcp')].sort(), ['agent', 'mcp', 'you']);
});

test('a long list collapses until show all', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(collapse(items, 6, false), { shown: [1, 2, 3, 4, 5, 6], more: 2 });
  assert.deepEqual(collapse(items, 6, true), { shown: items, more: 0 });
  assert.deepEqual(collapse([1], 6, false), { shown: [1], more: 0 });
});
