import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { layoutProcess, parseProcess } from '../src/assistants/process.ts';

const ctx = { helperRoles: ['review'], files: ['skills/audit/run.py'] };
const base = () => ({
  version: 1, title: 'Internal audit', start: 'plan',
  stages: [
    { id: 'plan', title: 'Plan', by: 'agent', each: undefined },
    { id: 'test-control', title: 'Test', by: 'script:audit/run.py', each: 'controls' },
    { id: 'review', title: 'Review', by: 'helper:review' },
    { id: 'escalate', title: 'Escalate', by: 'person' },
    { id: 'next-control', title: 'Next', by: 'agent' },
    { id: 'consolidate', title: 'Consolidate', by: 'agent' },
    { id: 'done', title: 'Done', by: 'agent', end: true },
  ],
  next: [
    { from: 'plan', to: 'test-control' },
    { from: 'test-control', to: 'review' },
    { from: 'review', to: 'test-control', when: 'changes requested', max: 3, then: 'escalate' },
    { from: 'review', to: 'next-control', when: 'approved' },
    { from: 'escalate', to: 'next-control' },
    { from: 'next-control', to: 'test-control', when: 'next item' },
    { from: 'next-control', to: 'consolidate', when: 'all items done' },
    { from: 'consolidate', to: 'done' },
  ] as Record<string, unknown>[],
});
const run = (f: (p: ReturnType<typeof base>) => void, c = ctx) => { const p = base(); f(p); return parseProcess(JSON.stringify(p), c).errors; };

test('a valid audit-like process parses', () => {
  const r = parseProcess(JSON.stringify(base()), ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.process?.stages.length, 7);
});

test('each rule has its error', () => {
  assert.match(parseProcess('{', ctx).errors[0]!, /JSON/);
  assert.match(run((p) => { p.version = 2; })[0]!, /version/);
  assert.match(run((p) => { p.title = 'x'.repeat(81); })[0]!, /title/);
  assert.match(run((p) => { p.stages[0]!.id = 'Plan'; })[0]!, /id/);
  assert.match(run((p) => { p.stages[1]!.id = 'plan'; })[0]!, /twice/);
  assert.match(run((p) => { p.stages[0]!.by = 'robot'; })[0]!, /"by"/);
  assert.match(run((p) => { p.stages[2]!.by = 'helper:nope'; })[0]!, /helpers\.json/);
  assert.match(run((p) => { p.stages[1]!.by = 'script:audit/gone.py'; })[0]!, /not in the Assistant's files/);
  assert.match(run((p) => { p.start = 'zzz'; })[0]!, /start/);
  assert.match(run((p) => { p.next.push({ from: 'plan', to: 'review' }); })[0]!, /more than one default/);
  assert.match(run((p) => { p.next.push({ from: 'review', to: 'plan', when: 'approved' }); })[0]!, /"approved" twice/);
  assert.deepEqual(run((p) => { delete p.next[2]!.then; }), ['Stage "review" sends "changes requested" back 3 times but names no "then" stage.']);
  assert.match(run((p) => { p.next[2]!.max = 21; })[0]!, /1 to 20/);
  assert.match(run((p) => { p.next[2]!.then = 'zzz'; })[0]!, /"then"/);
  assert.match(run((p) => { p.next.push({ from: 'done', to: 'plan' }); })[0]!, /end stage/);
  assert.match(run((p) => { p.next.pop(); })[0]!, /no way out/);
  assert.match(run((p) => { p.stages.push({ id: 'lost', title: 'Lost', by: 'agent', end: true }); })[0]!, /can not be reached/);
  assert.ok(run((p) => { p.next = p.next.filter((e) => e.when !== 'all items done'); }).some((e) => /come as a pair/.test(e)));
  // as the runner has it: no default next to the loop edges, "then" needs "max", the runner's id and script patterns
  assert.ok(run((p) => { p.next.push({ from: 'next-control', to: 'done' }); }).some((e) => /come as a pair.*without a default/.test(e)));
  assert.match(run((p) => { delete p.next[2]!.max; })[0]!, /"then" needs "max"/);
  assert.match(run((p) => { p.stages[1]!.each = `a${'b'.repeat(32)}`; })[0]!, /"each"/);
  assert.match(run((p) => { p.stages[1]!.by = 'script:audit/sub/run.py'; })[0]!, /"by"/);
  assert.match(run((p) => { p.stages[2]!.by = `helper:${'a'.repeat(33)}`; })[0]!, /"by"/);
  assert.deepEqual(run((p) => { p.next[0]!.when = null; }), []); // null = no "when", like the runner
  assert.match(run((p) => { delete p.stages[1]!.each; })[0]!, /"each"/);
  assert.match(run((p) => { p.stages = Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, title: 's', by: 'agent' })); })[0]!, /At most 40/);
});

test('a process with no reachable end stage is refused', () => {
  const p = { version: 1, title: 't', start: 'a', stages: [{ id: 'a', title: 'A', by: 'agent' }, { id: 'b', title: 'B', by: 'agent' }, { id: 'e', title: 'E', by: 'agent', end: true }], next: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
  assert.ok(parseProcess(JSON.stringify(p), ctx).errors.some((e) => /No end stage/.test(e)));
});

test('layout: top to bottom, loops are back edges', () => {
  const l = layoutProcess(parseProcess(JSON.stringify(base()), ctx).process!);
  assert.deepEqual(l.stages.map((s) => s.id), ['plan', 'test-control', 'review', 'next-control', 'consolidate', 'done', 'escalate']);
  assert.equal(l.side, 6); // escalate is only a "then" target: a side stage
  const kind = (from: string, to: string) => l.edges.find((e) => e.from === from && e.to === to)!.kind;
  assert.equal(kind('plan', 'test-control'), 'forward');
  assert.equal(kind('review', 'test-control'), 'back');
  assert.equal(kind('next-control', 'test-control'), 'back');
  assert.equal(kind('escalate', 'next-control'), 'forward');
  assert.deepEqual(l.loops, [{ list: 'controls', from: 1, to: 3 }]);
});

const example = (slug: string) => {
  const dir = join(new URL('../docs/examples/assistants/', import.meta.url).pathname, slug), file = join(dir, 'process.json');
  if (!existsSync(file)) return;
  const roles = (JSON.parse(readFileSync(join(dir, 'helpers.json'), 'utf8')) as { role: string }[]).map((h) => h.role);
  const files = (function walk(d: string): string[] { return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))])); })(dir);
  return layoutProcess(parseProcess(readFileSync(file, 'utf8'), { helperRoles: roles, files }).process!);
};
const ids = (l: NonNullable<ReturnType<typeof example>>) => [l.stages.slice(0, l.side).map((s) => s.id), l.stages.slice(l.side).map((s) => s.id)];
const backs = (l: NonNullable<ReturnType<typeof example>>) => l.edges.filter((e) => e.kind === 'back').map((e) => `${e.from}>${e.to}`);

test('layout of the internal-audit example: main path, loop body, side stages, arcs', () => {
  const l = example('internal-audit');
  if (!l) return;
  assert.deepEqual(ids(l), [
    ['scope-and-plan', 'plan-approval', 'evidence-request', 'test-control', 'sample', 'draft-finding', 'peer-review', 'next-control', 'consolidate', 'management-response', 'qa-review', 'final-report', 'follow-up-plan'],
    ['escalate-audit-lead', 'escalate-finding'],
  ]);
  assert.deepEqual(l.loops, [{ list: 'controls', from: 3, to: 7 }]); // the bracket spans exactly test-control..next-control
  assert.deepEqual(backs(l).sort(), ['management-response>consolidate', 'next-control>test-control', 'peer-review>draft-finding', 'plan-approval>scope-and-plan', 'qa-review>consolidate']);
});

test('layout of the scrum-sprint example: main path, loop body, side stages, arcs', () => {
  const l = example('scrum-sprint');
  if (!l) return;
  assert.deepEqual(ids(l), [
    ['backlog-refinement', 'po-review-backlog', 'sprint-planning', 'implement-story', 'code-review', 'acceptance', 'next-story', 'sprint-review', 'retrospective', 'next-sprint-decision', 'release'],
    ['carry-over'],
  ]);
  assert.deepEqual(l.loops, [{ list: 'stories', from: 3, to: 6 }]);
  assert.deepEqual(backs(l).sort(), ['acceptance>implement-story', 'code-review>implement-story', 'next-sprint-decision>backlog-refinement', 'next-story>implement-story', 'po-review-backlog>backlog-refinement']);
});

// The example Assistants' process.json (if there is one) is valid against their own helpers and files.
const ROOT = new URL('../docs/examples/assistants/', import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
for (const slug of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory())) {
  const file = join(ROOT, slug, 'process.json');
  if (!existsSync(file)) continue;
  test(`${slug}: process.json is valid`, () => {
    const roles = (JSON.parse(readFileSync(join(ROOT, slug, 'helpers.json'), 'utf8')) as { role: string }[]).map((h) => h.role);
    const r = parseProcess(readFileSync(file, 'utf8'), { helperRoles: roles, files: walk(join(ROOT, slug)).map((p) => relative(join(ROOT, slug), p)) });
    assert.deepEqual(r.errors, []);
  });
}
