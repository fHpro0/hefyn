import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { BUNDLE_LIMITS, collect, pack, unpack } from '../src/assistants/bundle.ts';
import { type Catalog, emptyDraft, parseDraft } from '../src/assistants/draft.ts';

// The example Assistants in docs/examples/assistants: every folder goes through the same guard as an import, then parses as a draft. No database, no model.
const ROOT = new URL('../docs/examples/assistants/', import.meta.url).pathname;
const AGENTS = [['claude-acp', 'Claude Code'], ['codex-acp', 'Codex'], ['opencode', 'OpenCode'], ['pi-acp', 'Pi']] as const; // src/modules/agents/*.json: all are headless
const catalog: Catalog = { agents: AGENTS.map(([id, name]) => ({ id, name, helper: true, mcp: true })), skills: [], mcp: [] };
const EXPECT: Record<string, { skills: string[]; helpers: string[] }> = {
  'invoice-processing': { skills: ['booking-export', 'extract-invoice', 'three-way-match'], helpers: ['review'] },
  'customer-support-triage': { skills: ['draft-reply', 'gdpr-request', 'triage'], helpers: ['qa'] },
  'employee-onboarding': { skills: ['access-request', 'onboarding-plan', 'welcome-pack'], helpers: [] },
  'sales-rfp-response': { skills: ['answer-questionnaire', 'compliance-claims-guard'], helpers: ['security-sme', 'writer'] },
  'internal-audit': { skills: ['run-process', 'sampling', 'write-finding'], helpers: ['quality-reviewer', 'senior-auditor'] },
  'scrum-sprint': { skills: ['backlog', 'run-process'], helpers: ['developer', 'reviewer'] },
};

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const read = (slug: string) => Object.fromEntries(walk(join(ROOT, slug)).map((p) => [relative(join(ROOT, slug), p), readFileSync(p, 'utf8')]));
const python = spawnSync('python3', ['--version']).status === 0;

test('the example folders are exactly the expected ones', () => {
  assert.deepEqual(readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory()).sort(), Object.keys(EXPECT).sort());
});

for (const [slug, want] of Object.entries(EXPECT)) {
  test(`${slug}: passes the import guard and parses as a draft`, () => {
    const files = read(slug);
    const total = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
    assert.ok(total < BUNDLE_LIMITS.bytes / 20, `${total} bytes is far below the cap`);
    const c = collect(Object.entries(files).map(([path, t]) => ({ path, type: '0', data: Buffer.from(t) })));
    assert.deepEqual(c.ignored, [], 'nothing is skipped');
    assert.deepEqual(unpack(pack(files)), files, 'pack and unpack keep every file');

    const { draft, errors } = parseDraft(files, catalog, emptyDraft());
    assert.deepEqual(errors, []);
    assert.equal(draft.agent, 'claude-acp');
    assert.ok(draft.name && draft.description.length > 20 && draft.instructions.length > 1000);
    assert.deepEqual(draft.newSkills.map((s) => s.name).sort(), want.skills);
    for (const s of draft.newSkills) assert.ok(s.description.length > 20 && s.body.length > 200, s.name);
    assert.deepEqual(draft.helpers.map((h) => h.role).sort(), want.helpers);
    for (const h of draft.helpers) assert.equal(catalog.agents.find((a) => a.id === h.agent)?.helper, true, h.role);
    assert.deepEqual([draft.skills, draft.mcp], [[], []]);
  });
}

test('in a chat the files are in /tmp/assistant and /files: no relative reference paths, no script paths under skills/', () => {
  const rel = /(?<![/\w.-])((?:data|policies|templates|kb|role-plans|answers-library|samples|inbox|skills|out|controls)\/|(?:routing\.yaml|access-matrix\.csv|company\.md|claims-register\.csv|methodology\.md|team\.csv|definition-of-done\.md|process\.json))/;
  for (const slug of Object.keys(EXPECT)) for (const [p, t] of Object.entries(read(slug))) {
    if (!/(^|\/)(instructions|SKILL)\.md$/.test(p)) continue;
    for (const [i, line] of t.split('\n').entries()) assert.equal(rel.exec(line)?.[0], undefined, `${slug}/${p}:${i + 1}: ${line}`);
    if (p === 'instructions.md') assert.match(t, /Reference files: \/tmp\/assistant\/ \(read-only copy, never edit\)\. Inputs and outputs: \/files\./);
  }
});

test('a helper on an agent that is missing or cannot help gets a precise error', () => {
  const cat: Catalog = { agents: [{ id: 'a', name: 'A', helper: true }, { id: 'b', name: 'B', helper: false }], skills: [], mcp: [] };
  const errs = (h: unknown[]) => parseDraft({ 'helpers.json': JSON.stringify(h) }, cat, emptyDraft()).errors;
  assert.deepEqual(errs([{ role: 'r', agent: 'a' }]), []);
  assert.deepEqual(errs([{ agent: 'a' }]), ['A helper in helpers.json needs a "role".']);
  assert.deepEqual(errs([{ role: 'r', agent: 'zz' }]), ['The helper "r" runs on "zz", which is not available here.']);
  assert.deepEqual(errs([{ role: 'r', agent: 'b' }]), ['The helper "r" runs on "b", which can not run as a helper.']);
});

test('read-only and editing helpers are as designed', () => {
  const edit = (slug: string) => Object.fromEntries((JSON.parse(read(slug)['helpers.json']!) as { role: string; edit: boolean }[]).map((h) => [h.role, h.edit]));
  assert.deepEqual(edit('invoice-processing'), { review: false });
  assert.deepEqual(edit('customer-support-triage'), { qa: false });
  assert.deepEqual(edit('sales-rfp-response'), { 'security-sme': false, writer: true });
  assert.deepEqual(edit('internal-audit'), { 'senior-auditor': false, 'quality-reviewer': false });
  assert.deepEqual(edit('scrum-sprint'), { developer: true, reviewer: false });
});

// The scripts: self-tests, then each against its own demo data.
const SCRIPTS = ['invoice-processing/skills/three-way-match/match.py', 'invoice-processing/skills/booking-export/export.py', 'employee-onboarding/skills/onboarding-plan/schedule.py',
  'sales-rfp-response/skills/answer-questionnaire/library.py', 'sales-rfp-response/skills/compliance-claims-guard/claims_check.py',
  'internal-audit/skills/run-process/process.py', 'internal-audit/skills/sampling/sample.py', 'scrum-sprint/skills/run-process/process.py',
  'scrum-sprint/skills/backlog/refine.py', 'scrum-sprint/skills/backlog/plan.py'];
const py = (cwd: string, ...args: string[]) => spawnSync('python3', ['-I', ...args], { cwd, encoding: 'utf8' });

test('every script is in the bundle and passes its self-test', { skip: !python }, () => {
  for (const s of SCRIPTS) {
    const r = py(join(ROOT, dirname(s)), join(ROOT, s), '--self-test');
    assert.equal(r.stdout.trim(), 'self-test ok', `${s}: ${r.stderr}`);
  }
});

test('invoice demo data: the expected invoices are flagged, and only clean ones are booked', { skip: !python }, () => {
  const dir = join(ROOT, 'invoice-processing'), tmp = mkdtempSync(join(tmpdir(), 'inv-'));
  mkdirSync(join(tmp, 'out'));
  const m = py(tmp, join(dir, 'skills/three-way-match/match.py'), '--root', dir, '--invoices', join(dir, 'samples/invoices.json'), '--out', join(tmp, 'out/match.json'));
  assert.equal(m.status, 0, m.stderr);
  const res = JSON.parse(readFileSync(join(tmp, 'out/match.json'), 'utf8')).results as { invoice_no: string; status: string; findings: { code: string }[] }[];
  assert.deepEqual(res.map((r) => [r.invoice_no, r.findings.map((f) => f.code).join()]), [
    ['INV-2026-5501', ''], ['INV-88213', ''], ['INV-0000731', 'PRICE_DIFF'], ['INV-88213', 'DUPLICATE'], ['INV-77120', 'QTY_OVER_RECEIVED'],
    ['INV-2026-118', 'NO_PO'], ['INV-2026-5502', 'IBAN_MISMATCH'], ['INV-0000744', 'NO_RECEIPT']]);
  const e = py(tmp, join(dir, 'skills/booking-export/export.py'), '--root', dir, '--invoices', join(dir, 'samples/invoices.json'), '--match', join(tmp, 'out/match.json'), '--out', join(tmp, 'out/booking.csv'), '--release', 'INV-0000731,INV-88213');
  assert.equal(e.status, 0, e.stderr);
  const rows = readFileSync(join(tmp, 'out/booking.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[1]);
  assert.deepEqual([...new Set(rows)], ['INV-2026-5501', 'INV-88213', 'INV-0000731']); // the released duplicate adds no second INV-88213 booking
  assert.equal(rows.filter((r) => r === 'INV-88213').length, 2);
});

test('rfp demo data: three answers are stale on 2026-10-28; the claims guard catches an invented SOC 2 claim', { skip: !python }, () => {
  const dir = join(ROOT, 'sales-rfp-response');
  const lib = py(dir, join(dir, 'skills/answer-questionnaire/library.py'), '--dir', join(dir, 'answers-library'), '--today', '2026-10-28', '--json');
  assert.deepEqual((JSON.parse(lib.stdout) as { id: string; stale: boolean }[]).filter((r) => r.stale).map((r) => r.id), ['SEC-004', 'SEC-007', 'SEC-010']);
  const tmp = mkdtempSync(join(tmpdir(), 'rfp-')), head = 'id,section,question,answer,source_id,status,owner,reviewed,notes\n';
  const check = (row: string) => { writeFileSync(join(tmp, 'r.csv'), head + row); return py(dir, join(dir, 'skills/compliance-claims-guard/claims_check.py'), '--response', join(tmp, 'r.csv'), '--register', join(dir, 'claims-register.csv'), '--today', '2026-10-28'); };
  assert.equal(check('Q006,Governance,SOC 2?,We have a SOC 2 Type II report.,SEC-009,answered,,,\n').status, 1);
  assert.equal(check('Q005,Governance,ISO?,Certified to ISO/IEC 27001 until 2027-03-31.,SEC-009,answered,,,\n').status, 0);
  assert.equal(check('Q006,Governance,SOC 2?,Needs SME,,needs_sme,Mara,,\n').status, 0);
});

test('onboarding demo offer: the schedule script gives the plan dates', { skip: !python }, () => {
  const dir = join(ROOT, 'employee-onboarding'), offer = JSON.parse(readFileSync(join(dir, 'samples/offer.json'), 'utf8'));
  const r = py(dir, join(dir, 'skills/onboarding-plan/schedule.py'), '--start', offer.start_date, '--location', offer.location);
  assert.equal(JSON.parse(r.stdout).review_30, '2026-12-02');
  assert.equal(py(dir, join(dir, 'skills/onboarding-plan/schedule.py'), '--start', '2026-11-07').status, 1, 'a Saturday is refused');
  const roles = new Set(readFileSync(join(dir, 'access-matrix.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[0]));
  assert.ok(roles.has(offer.role) && readdirSync(join(dir, 'role-plans')).includes(`${offer.role}.md`));
});

test('the two run-process copies are identical', () => {
  const f = (slug: string, n: string) => readFileSync(join(ROOT, slug, 'skills/run-process', n), 'utf8');
  for (const n of ['process.py', 'SKILL.md']) assert.equal(f('internal-audit', n), f('scrum-sprint', n), n);
});

// The looping processes, driven end to end with the runner: temp state, the example folder as --root, a fixed clock.
const NOW = '2026-10-28T09:00:00Z';
function runner(slug: string, state: string) {
  const dir = join(ROOT, slug);
  const call = (...args: string[]) => py(dir, join(dir, 'skills/run-process/process.py'), ...args, '--root', dir, '--state', state, '--now', NOW);
  const ok = (...args: string[]) => { const r = call(...args); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return JSON.parse(r.stdout); };
  const go = (outcome: string, extra: string[] = [], person = false) => ok('advance', '--outcome', outcome, '--note', `n:${outcome}`, ...(person ? ['--by-person'] : []), ...extra);
  const trail = (): string[] => { const h = ok('history'); return [h[0].to, ...h.slice(1).map((e: { to: string }) => e.to)]; };
  return { call, ok, go, trail, history: () => ok('history') as { from: string; to: string; via: string; item: string | null; outcome: string; by_person: boolean; note: string; at: string; abandoned_items?: string[] }[] };
}

test('internal-audit: three controls, a peer-review loop on control 2 that escalates the finding and the audit goes on, one disputed response, QA pass, end', { skip: !python }, () => {
  const r = runner('internal-audit', join(mkdtempSync(join(tmpdir(), 'audit-')), 'state.json'));
  assert.equal(r.ok('start', '--items-controls', 'A.5.15,A.5.18,A.8.32').stage.id, 'scope-and-plan');
  r.go('done');
  assert.notEqual(r.call('advance', '--outcome', 'done').status, 0, 'a person stage is refused without --by-person');
  assert.equal(r.go('done', [], true).stage.id, 'evidence-request');
  assert.equal(r.go('done').stage.loop.item, 'A.5.15');
  r.go('done'); r.go('done'); r.go('done'); r.go('done'); // first control: sample, draft-finding, peer-review (approved), next-control
  assert.equal(r.go('done').stage.id, 'test-control');
  assert.equal(r.ok('status').stage.loop.item, 'A.5.18');
  r.go('done'); r.go('done'); // second control: test-control -> sample -> draft-finding
  for (let i = 0; i < 3; i++) { r.go('done'); assert.equal(r.go('changes requested').stage.id, 'draft-finding'); } // peer-review sends it back, three times
  r.go('done');
  const esc = r.go('changes requested');
  assert.equal(esc.moved.via, 'max-then');
  assert.equal(esc.stage.id, 'escalate-finding');
  assert.notEqual(r.call('advance', '--outcome', 'finding accepted').status, 0);
  assert.equal(r.go('finding accepted', [], true).stage.id, 'next-control');
  assert.equal(r.go('done').stage.loop.item, 'A.8.32'); // the third control is still tested
  r.go('done'); r.go('done'); r.go('done'); r.go('done'); // sample, draft-finding, peer-review, next-control
  assert.equal(r.go('done').stage.id, 'consolidate');
  r.go('done');
  assert.equal(r.go('disputed', [], true).stage.id, 'consolidate');
  r.go('done');
  assert.equal(r.go('done', [], true).stage.id, 'qa-review');
  assert.equal(r.go('done').stage.id, 'final-report');
  const end = r.go('done');
  assert.deepEqual([end.finished, end.stage.id, end.stage.end], [true, 'follow-up-plan', true]);
  assert.notEqual(r.call('advance', '--outcome', 'done').status, 0);

  const ctl = ['test-control', 'sample', 'draft-finding', 'peer-review', 'next-control'], loop = ['draft-finding', 'peer-review'];
  assert.deepEqual(r.trail(), ['scope-and-plan', 'plan-approval', 'evidence-request', ...ctl, 'test-control', 'sample', ...loop, ...loop, ...loop, ...loop,
    'escalate-finding', 'next-control', ...ctl, 'consolidate', 'management-response', 'consolidate', 'management-response', 'qa-review', 'final-report', 'follow-up-plan']);
  const h = r.history().slice(1);
  assert.ok(h.every((e) => e.at === NOW));
  assert.deepEqual(h.filter((e) => e.via === 'max-then').map((e) => [e.from, e.to, e.item]), [['peer-review', 'escalate-finding', 'A.5.18']]);
  assert.deepEqual(h.filter((e) => e.from === 'next-control').map((e) => [e.outcome, e.item]), [['next item', 'A.5.15'], ['next item', 'A.5.18'], ['all items done', 'A.8.32']]);
  assert.deepEqual(h.filter((e) => e.abandoned_items !== undefined), [], 'the escalation does not abandon the remaining controls');
  assert.deepEqual(h.filter((e) => e.by_person).map((e) => e.from), ['plan-approval', 'escalate-finding', 'management-response', 'management-response']);
  assert.ok(h.filter((e) => e.by_person).every((e) => e.note.startsWith('n:')));
  assert.deepEqual(h.find((e) => e.from === 'management-response')!.outcome, 'disputed');
});

test('internal-audit: QA rework hits its max, the audit lead resolves it, and the audit ends', { skip: !python }, () => {
  const r = runner('internal-audit', join(mkdtempSync(join(tmpdir(), 'audit-qa-')), 'state.json'));
  r.ok('start', '--items-controls', 'A.5.15');
  r.go('done'); r.go('done', [], true); r.go('done'); // plan, plan approval, evidence request
  for (let i = 0; i < 4; i++) r.go('done'); // test-control, sample, draft-finding, peer-review
  assert.equal(r.go('done').stage.id, 'consolidate'); // next-control: all items done
  const toQa = () => { r.go('done'); assert.equal(r.go('done', [], true).stage.id, 'qa-review'); }; // consolidate, management response
  toQa();
  for (let i = 0; i < 2; i++) { assert.equal(r.go('rework').stage.id, 'consolidate'); toQa(); }
  const esc = r.go('rework');
  assert.deepEqual([esc.moved.via, esc.stage.id], ['max-then', 'escalate-audit-lead']);
  assert.equal(r.go('resolved', [], true).stage.id, 'consolidate');
  toQa();
  assert.equal(r.go('done').stage.id, 'final-report');
  const end = r.go('done');
  assert.deepEqual([end.finished, end.stage.id], [true, 'follow-up-plan']);
  const h = r.history().slice(1);
  assert.deepEqual(h.filter((e) => e.via === 'max-then').map((e) => [e.from, e.to]), [['qa-review', 'escalate-audit-lead']]);
  assert.deepEqual(h.filter((e) => e.outcome === 'rework').length, 3);
  assert.deepEqual(h.filter((e) => e.from === 'escalate-audit-lead').map((e) => [e.outcome, e.to, e.by_person]), [['resolved', 'consolidate', true]]);
  assert.ok(h.every((e) => e.abandoned_items === undefined));
});

test('internal-audit: the audit lead stops the audit after the plan is rejected three times', { skip: !python }, () => {
  const r = runner('internal-audit', join(mkdtempSync(join(tmpdir(), 'audit-stop-')), 'state.json'));
  r.ok('start', '--items-controls', 'A.5.15');
  r.go('done');
  for (let i = 0; i < 2; i++) { assert.equal(r.go('changes requested', [], true).stage.id, 'scope-and-plan'); r.go('done'); }
  const esc = r.go('changes requested', [], true);
  assert.deepEqual([esc.moved.via, esc.stage.id], ['max-then', 'escalate-audit-lead']);
  assert.equal(r.go('stop', [], true).stage.id, 'final-report');
  const end = r.go('done');
  assert.deepEqual([end.finished, end.stage.id], [true, 'follow-up-plan']);
  const h = r.history().slice(1);
  assert.deepEqual(h.filter((e) => e.by_person).map((e) => [e.from, e.outcome, e.to]), [
    ['plan-approval', 'changes requested', 'scope-and-plan'], ['plan-approval', 'changes requested', 'scope-and-plan'],
    ['plan-approval', 'changes requested', 'escalate-audit-lead'], ['escalate-audit-lead', 'stop', 'final-report']]);
  assert.deepEqual(h.filter((e) => e.via === 'max-then').map((e) => [e.from, e.to]), [['plan-approval', 'escalate-audit-lead']]);
});

test('scrum-sprint: a story rejected twice goes to carry-over, a second sprint finishes it, then release', { skip: !python }, () => {
  const r = runner('scrum-sprint', join(mkdtempSync(join(tmpdir(), 'scrum-')), 'state.json'));
  r.ok('start');
  r.go('done');
  assert.equal(r.go('done', [], true).stage.id, 'sprint-planning');
  assert.notEqual(r.call('advance', '--outcome', 'done').status, 0, 'planning needs the items');
  assert.equal(r.go('done', ['--items-stories', 'US-101,US-102,US-103']).stage.loop.item, 'US-101');
  r.go('done'); r.go('done'); r.go('done', [], true); // implement, code review, acceptance for US-101
  assert.equal(r.go('done').stage.loop.item, 'US-102'); // next-story
  r.go('done'); r.go('done'); // implement, code-review
  for (let i = 0; i < 2; i++) { assert.equal(r.go('rejected', [], true).stage.id, 'implement-story'); r.go('done'); r.go('done'); }
  const co = r.go('rejected', [], true);
  assert.deepEqual([co.moved.via, co.stage.id], ['max-then', 'carry-over']);
  assert.equal(r.go('done').stage.id, 'next-story'); // carry-over
  assert.equal(r.go('done').stage.loop.item, 'US-103');
  r.go('done'); r.go('done'); r.go('done', [], true);
  assert.equal(r.go('done').stage.id, 'sprint-review');
  r.go('done'); r.go('done');
  assert.equal(r.go('another sprint', [], true).stage.id, 'backlog-refinement');
  r.go('done'); r.go('done', [], true);
  assert.equal(r.go('done', ['--items-stories', 'US-102']).stage.loop.item, 'US-102');
  r.go('done'); r.go('done'); r.go('done', [], true);
  assert.equal(r.go('done').stage.id, 'sprint-review');
  r.go('done'); r.go('done');
  const end = r.go('release', [], true);
  assert.deepEqual([end.finished, end.stage.id], [true, 'release']);

  const sprint = ['implement-story', 'code-review', 'acceptance'], base = ['backlog-refinement', 'po-review-backlog', 'sprint-planning'];
  assert.deepEqual(r.trail(), [...base, ...sprint, 'next-story', ...sprint, ...sprint, ...sprint, 'carry-over', 'next-story', ...sprint, 'next-story',
    'sprint-review', 'retrospective', 'next-sprint-decision', ...base, ...sprint, 'next-story', 'sprint-review', 'retrospective', 'next-sprint-decision', 'release']);
  const h = r.history().slice(1);
  assert.deepEqual(h.filter((e) => e.via === 'max-then').map((e) => [e.from, e.to, e.item]), [['acceptance', 'carry-over', 'US-102']]);
  assert.deepEqual(h.filter((e) => e.outcome === 'rejected').map((e) => e.item), ['US-102', 'US-102', 'US-102']);
  assert.deepEqual(h.filter((e) => e.from === 'next-story').map((e) => [e.outcome, e.item, e.to]), [
    ['next item', 'US-101', 'implement-story'], ['next item', 'US-102', 'implement-story'], ['all items done', 'US-103', 'sprint-review'], ['all items done', 'US-102', 'sprint-review']]);
  assert.deepEqual(h.filter((e) => e.by_person).map((e) => e.from).filter((f) => f === 'next-sprint-decision'), ['next-sprint-decision', 'next-sprint-decision']);
});

test('process.json is validated: an unknown helper, a lone "next item" and an unreachable stage are named', { skip: !python }, () => {
  const dir = join(ROOT, 'internal-audit'), tmp = mkdtempSync(join(tmpdir(), 'proc-'));
  const proc = JSON.parse(readFileSync(join(dir, 'process.json'), 'utf8'));
  const check = (mut: (p: any) => void) => {
    const p = structuredClone(proc); mut(p);
    writeFileSync(join(tmp, 'process.json'), JSON.stringify(p));
    return py(dir, join(dir, 'skills/run-process/process.py'), 'start', '--root', dir, '--process', join(tmp, 'process.json'), '--state', join(tmp, 'state.json'), '--force');
  };
  assert.match(check((p) => { p.stages.find((s: any) => s.id === 'peer-review').by = 'helper:ghost'; }).stderr, /helper .{1,3}ghost.{1,3} is not in helpers.json/);
  assert.match(check((p) => { p.next = p.next.filter((e: any) => e.when !== 'all items done'); }).stderr, /come as a pair/);
  assert.match(check((p) => { p.stages.push({ id: 'island', title: 'Island', by: 'agent', end: true }); }).stderr, /island is not reachable/);
  assert.match(check((p) => { p.stages.find((s: any) => s.id === 'sample').by = 'script:sampling/nope.py'; }).stderr, /does not exist/);
  assert.match(check((p) => { p.next.find((e: any) => e.when === 'disputed').max = 21; }).stderr, /max.{1,3} must be 1 to 20/);
});
