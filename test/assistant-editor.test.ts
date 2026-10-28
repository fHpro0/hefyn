import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// The Assistant editor without Docker or a model: the draft as files (round trip, catalog), the per-chat working folder, hidden editor chats (not listed, swept, a test chat on an unsaved draft),
// converting a retired flow Assistant, and the composer picker leaving retired ones out. The creator and test chats running on a real agent are a live check.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-assistant-editor-'));
process.env.HEFYN_SECRET = 'assistant-editor-test-secret-assistant-editor-1';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1'; // configured, never called
process.env.HEFYN_INTERNAL_TOKEN = 'assistant-editor-token-assistant-editor-0123456789';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
await import('../src/server/hub.ts');
const draft = await import('../src/assistants/draft.ts');
const { RESERVED, summary } = await import('../src/assistants/bundle.ts');
const { readTar, writeTar } = await import('../src/assistants/tar.ts');
const { simpleFlow } = await import('../src/assistants/flow.ts');
const { writeAssistant } = await import('../src/server/assistant-store.ts');
const { INPUT_DEFAULTS, conversationAssistant, getAssistant } = await import('../src/server/assistants.ts');
const { assistantFor, sessionItems } = await import('../src/server/session-items.ts');
const ad = await import('../src/server/assistant-draft.ts');
vault.setTeamKey(vault.newKey());

const app = new Hono().route('/api', api);
const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const r = await auth.api.signUpEmail({ body: { name: 'a', email: 'admin@x.test', password: PW } });
db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'admin')").run(r.user.id);
const cookie = cookieOf((await auth.api.signInEmail({ body: { email: 'admin@x.test', password: PW }, returnHeaders: true })).headers);
vault.rememberUserKey(r.user.id, vault.newKey());
const admin = { id: r.user.id, roleId: 'admin', trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '0.95.0', 'ready', 1, '[]', 'now')").run();

const catalog: import('../src/assistants/draft.ts').Catalog = {
  agents: [{ id: 'claude-acp', name: 'Claude Code', mcp: true }, { id: 'codex-acp', name: 'Codex', helper: true }],
  skills: [{ id: 's1', name: 'Legal', description: 'x' }], mcp: [{ id: 'm1', name: 'Mail' }],
};
const full: import('../src/assistants/draft.ts').Draft = { name: 'Contracts', description: 'Reads contracts', icon: 'emoji:📄', agent: 'claude-acp', instructions: 'Be precise.\nCite clauses.', skills: ['s1'], newSkills: [{ name: 'clause-check', description: 'Checks "clauses"', body: 'Look at each clause.\n' }], mcp: ['m1'], helpers: [{ role: 'review', agent: 'codex-acp', edit: true }] };

test('a draft survives the trip through its files', () => {
  const back = draft.parseDraft(draft.serializeDraft(full), catalog, draft.emptyDraft());
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.draft, { ...full, helpers: [{ role: 'review', agent: 'codex-acp', provider: null, model: null, edit: true }] });
  assert.deepEqual(draft.changedSections(full, back.draft), []);
});

test('files with ids outside the catalog are rejected, a broken file keeps the old part', () => {
  const files = { ...draft.serializeDraft(full), 'skills.json': '["s1","nope"]', 'mcp.json': '["m9"]', 'assistant.json': '{"name":"X","agent":"hacker","icon":"bad icon!"}', 'helpers.json': '[{"role":"x","agent":"claude-acp"}]' };
  const { draft: d, errors } = draft.parseDraft(files, catalog, full);
  assert.deepEqual(d.skills, ['s1']);
  assert.deepEqual(d.mcp, []);
  assert.equal(d.agent, 'claude-acp', 'an unknown agent is not taken');
  assert.equal(d.icon, 'emoji:📄');
  assert.equal(d.name, 'X');
  assert.equal(d.helpers.length, 0, 'claude-acp is not a helper in this catalog');
  assert.equal(errors.length, 5);
  assert.ok(errors.some((e) => e.includes('"nope"')) && errors.some((e) => e.includes('"m9"')));
  const broken = draft.parseDraft({ 'assistant.json': '{oops', 'instructions.md': 'kept', 'mcp.json': '{}' }, catalog, full);
  assert.equal(broken.draft.name, 'Contracts');
  assert.equal(broken.draft.instructions, 'kept');
  assert.equal(broken.errors.length, 2);
});

test('the form is written into the files only for parts the creator has not changed', () => {
  const pushed = full, form = { ...full, name: 'Renamed', instructions: 'New' }, files = { ...full, instructions: 'Creator wrote this' };
  assert.deepEqual(draft.syncPlan(form, files, pushed), ['basics'], 'instructions: the creator changed it, so it stays a suggestion');
  assert.deepEqual(draft.changedSections(files, pushed), ['instructions']);
  assert.deepEqual(draft.applySection(form, files, 'instructions').instructions, 'Creator wrote this');
  assert.deepEqual(draft.diffLines('a\nb\nc', 'a\nc\nd').map((l) => l.t + l.s), ['samea', 'delb', 'samec', 'addd']);
});

test('the draft folder: files go below the drafts root and no path leaves it', () => {
  const dir = draft.draftDir('abcdef123456');
  assert.equal(dir, '/files/.hefyn/assistant-drafts/abcdef123456');
  assert.equal(draft.validCwd(dir), dir);
  for (const bad of ['/files', '/files/', '/files/.hefyn/assistant-drafts', `${dir}/sub`, `${dir}/..`, `${dir}/../abcdef654321x`, '/files/.hefyn/assistant-drafts/../../etc', '/files/.hefyn/assistant-drafts/ABCDEF123456', '/files/.hefyn/assistant-drafts/short', '/tmp/x', '', 'abcdef123456', '/files/.hefyn/assistant-drafts/abcdef123456\0', '/files/.hefyn/assistant-drafts/abcdef12\\..\\x', null, 7]) {
    assert.equal(draft.validCwd(bad), undefined, String(bad));
  }
  for (const id of ['../x', 'a/b', 'short', 'UPPERCASE123', '']) assert.throws(() => draft.draftDir(id));
});

/** The sandbox's file system in memory. */
function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    async writeFile(p: string, c: string) { files.set(p, c); },
    async rm(p: string) { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); },
    async tree(p: string) { const f = Object.fromEntries([...files].filter(([k]) => k.startsWith(`${p}/`)).map(([k, v]) => [k.slice(p.length + 1), v])); return Object.keys(f).length ? writeTar(f) : undefined; },
    async putTree(p: string, tar: Uint8Array, clear: boolean) {
      if (clear) for (const k of [...files.keys()]) if (k.startsWith(`${p}/`) && !RESERVED.includes(k.slice(p.length + 1))) files.delete(k);
      for (const e of readTar(Buffer.from(tar))) files.set(`${p}/${e.path}`, e.data.toString());
    },
  };
}

test('the creator folder holds the brief, the catalog and the draft; reading it back, with extra files', async () => {
  const fs = memFs(), id = 'abcdef123456', dir = draft.draftDir(id);
  await ad.seedDraft(fs, id, full, catalog);
  assert.deepEqual([...fs.files.keys()].map((k) => k.slice(dir.length + 1)).sort(), ['AGENTS.md', 'CLAUDE.md', 'assistant.json', 'catalog.json', 'helpers.json', 'instructions.md', 'mcp.json', 'skills.json', 'skills/clause-check/SKILL.md']);
  assert.match(fs.files.get(`${dir}/CLAUDE.md`)!, /Never invent a skill, MCP server or agent id/);
  assert.ok(![...fs.files.values()].some((v) => /gpt-|claude-(opus|sonnet)|"model"/.test(v)), 'no model ids reach the creator');
  fs.files.set(`${dir}/instructions.md`, 'Shorter.');
  fs.files.set(`${dir}/mcp.json`, '["m1","evil"]');
  fs.files.set(`${dir}/templates/letter.md`, 'Dear …');
  const read = await ad.readDraft(fs, id, catalog, full);
  assert.equal(read.draft.instructions, 'Shorter.');
  assert.equal(read.errors.length, 1);
  assert.deepEqual(draft.changedSections(full, read.draft), ['instructions']);
  assert.deepEqual(summary(read.bundle), { files: ['templates/letter.md'], bundledSkills: ['clause-check'] });
  assert.ok(!('CLAUDE.md' in read.bundle) && !('catalog.json' in read.bundle), 'the brief is not part of the bundle');
  // an import replaces the draft's files and keeps the brief
  await ad.putFiles(fs, id, { 'assistant.json': '{"name":"Imported"}', 'docs/a.md': 'A' }, true);
  assert.deepEqual([...fs.files.keys()].map((k) => k.slice(dir.length + 1)).sort(), ['AGENTS.md', 'CLAUDE.md', 'assistant.json', 'catalog.json', 'docs/a.md']);
  assert.equal((await ad.readDraft(fs, id, catalog, full)).draft.name, 'Imported');
  await ad.discardDraft('nobody', id, { fs }); // no chats: nothing to remove
  assert.equal(fs.files.size > 0, true);
});

const hiddenRow = (id: string) => db.prepare('SELECT hidden, cwd, snapshot, agent, draft_id FROM conversations WHERE id = ?').get(id) as { hidden: string | null; cwd: string | null; snapshot: string | null; agent: string; draft_id: string } | undefined;

test('hidden editor chats are not in the chat list; a test chat runs on its snapshot', async () => {
  const me = { id: admin.id, roleId: 'admin' };
  const normal = (await admin.trpc('conversations.create', { agent: 'claude-acp' }, true)).json.id as string;
  const creator = ad.createHidden(me, { agent: 'claude-acp', hidden: 'creator', draftId: 'abcdef123456' });
  const snap = { id: 'draft:abcdef123456', name: 'Draft', description: '', icon: 'Sparkles', agent: 'claude-acp', model: null, thinking: null, instructions: 'Unsaved instructions', skills: [], mcp: [], helpers: [], inputs: INPUT_DEFAULTS, roles: [], isDefault: false, archived: false, updatedAt: 'now', owner: admin.id, scope: 'private', shareStatus: null, version: 0, flow: simpleFlow({}), simple: true };
  const test1 = ad.createHidden(me, { agent: 'claude-acp', hidden: 'test', draftId: 'abcdef123456', snapshot: snap as never });
  const ids = ((await admin.trpc('conversations.list')).json as { id: string }[]).map((c) => c.id);
  assert.ok(ids.includes(normal));
  assert.ok(!ids.includes(creator) && !ids.includes(test1), 'creator and test chats stay out of the sidebar');
  assert.equal(hiddenRow(creator)!.cwd, '/files/.hefyn/assistant-drafts/abcdef123456');
  assert.equal(hiddenRow(test1)!.cwd, null, 'a test chat works in /files like any chat');
  assert.equal(conversationAssistant(test1)?.instructions, 'Unsaved instructions');
  assert.equal(assistantFor(test1)?.instructions, 'Unsaved instructions');
  assert.equal(sessionItems(admin.id, test1).instructions, 'Unsaved instructions');
  assert.equal(conversationAssistant(normal), undefined);
  assert.throws(() => ad.createHidden(me, { agent: 'nope', hidden: 'test', draftId: 'abcdef123456' }), /unknown agent/);
  assert.throws(() => ad.createHidden(me, { agent: 'claude-acp', hidden: 'creator', draftId: '../x' }), /invalid draft id/);
  assert.deepEqual(ad.hiddenOf(admin.id, 'abcdef123456').map((c) => c.hidden), ['creator', 'test']);
  // the turns of a test chat: what was asked, what came back, cut short
  const log = [{ update: { hefyn: 'user', text: 'first' } }, { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one ' } } }, { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } } },
    { update: { hefyn: 'user', text: 'x'.repeat(2000) } }, { update: { sessionUpdate: 'agent_message_chunk', agent: 'sub', content: { type: 'text', text: 'hidden sub-agent' } } }];
  assert.deepEqual(ad.turnsOf(log, 1)[0]!.agent, '');
  assert.equal(ad.turnsOf(log, 5, 100)[1]!.user.length, 100);
  assert.deepEqual(ad.turnsOf(log, 5).map((t) => [t.user.slice(0, 5), t.agent]), [['first', 'one two'], ['xxxxx', '']]);
  // leaving the editor with an unsaved draft removes the tests only; saving or discarding removes the rest
  await ad.discardDraft(admin.id, 'abcdef123456', { keepCreator: true, fs: memFs() });
  assert.deepEqual(ad.hiddenOf(admin.id, 'abcdef123456').map((c) => c.hidden), ['creator']);
  await ad.discardDraft(admin.id, 'abcdef123456', { fs: memFs() });
  assert.deepEqual(ad.hiddenOf(admin.id, 'abcdef123456'), []);
  assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(normal), 'the normal chat is untouched');
});

test('the sweep removes tests after a day and creators after a month, never a normal chat', async () => {
  const me = { id: admin.id, roleId: 'admin' };
  const old = ad.createHidden(me, { agent: 'claude-acp', hidden: 'test', draftId: 'sweep0000001' }), fresh = ad.createHidden(me, { agent: 'claude-acp', hidden: 'test', draftId: 'sweep0000002' });
  const week = ad.createHidden(me, { agent: 'claude-acp', hidden: 'creator', draftId: 'sweep0000003' }), ancient = ad.createHidden(me, { agent: 'claude-acp', hidden: 'creator', draftId: 'sweep0000004' });
  const normal = (await admin.trpc('conversations.create', { agent: 'claude-acp' }, true)).json.id as string;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString(), H = 3600_000;
  for (const [id, ms] of [[old, 25 * H], [fresh, 23 * H], [week, 7 * 24 * H], [ancient, 31 * 24 * H], [normal, 90 * 24 * H]] as const) db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ago(ms), id);
  assert.equal(ad.sweepHidden(), 2);
  const has = (id: string) => !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id);
  assert.deepEqual([old, fresh, week, ancient, normal].map(has), [false, true, true, false, true]);
});

const retiredFlow = () => ({
  version: 1 as const,
  nodes: [
    { id: 'start', type: 'trigger.chat', position: { x: 0, y: 0 }, config: {} },
    { id: 'a1', type: 'agent', label: 'Answer', position: { x: 1, y: 0 }, config: { agent: 'claude-acp', instructions: 'Answer politely.', skills: ['missing-skill'], prompt: '{{start.text}}', output: 'text' } },
    { id: 'c', type: 'condition', position: { x: 2, y: 0 }, config: {} },
    { id: 'reply', type: 'output.reply', position: { x: 3, y: 0 }, config: { text: '{{a1.text}}' } },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'a1' }, { id: 'e2', from: 'a1', to: 'c' }, { id: 'e3', from: 'c', to: 'reply', port: 'true' }],
});

test('a retired flow Assistant becomes a simple one, and the composer picker never lists it', async () => {
  const made = writeAssistant({ name: 'Old flow', description: 'From the flow builder', icon: 'Workflow', inputs: INPUT_DEFAULTS, roles: [], flow: retiredFlow(), scope: 'private', owner: admin.id });
  const bare = writeAssistant({ name: 'No steps', description: '', icon: 'Sparkles', inputs: INPUT_DEFAULTS, roles: [], flow: { version: 1, nodes: [{ id: 'start', type: 'trigger.chat', position: { x: 0, y: 0 }, config: {} }, { id: 'x', type: 'tool', position: { x: 1, y: 0 }, config: {} }, { id: 'y', type: 'output.reply', position: { x: 2, y: 0 }, config: {} }], edges: [] }, scope: 'private', owner: admin.id });
  assert.deepEqual(draft.simpleFromFlow(retiredFlow()), { agent: 'claude-acp', instructions: 'Answer politely.', skills: ['missing-skill'] });
  assert.deepEqual(draft.simpleFromFlow(undefined), { agent: null, instructions: '', skills: [] });
  assert.equal(getAssistant(made.id)!.simple, false);
  const listed = () => admin.trpc('assistants.list').then((x) => (x.json as { id: string }[]).map((a) => a.id));
  const editable = async () => (await admin.trpc('assistants.editable')).json as { id: string; simple: boolean }[];
  assert.ok(!(await listed()).includes(made.id) && !(await listed()).includes(bare.id), 'a retired Assistant is not offered for chats');
  assert.equal((await editable()).find((a) => a.id === made.id)?.simple, false, 'but the Assistants page still finds it');

  const done = await admin.trpc('assistants.convertRetired', { id: made.id }, true);
  assert.equal(done.status, 200, String(done.error));
  const a = getAssistant(made.id)!;
  assert.deepEqual([a.simple, a.name, a.icon, a.agent, a.instructions, a.skills], [true, 'Old flow', 'Workflow', 'claude-acp', 'Answer politely.', []], 'unknown skills do not come along');
  assert.ok((await listed()).includes(made.id), 'converted: it is a normal Assistant now');
  assert.equal((await admin.trpc('assistants.convertRetired', { id: made.id }, true)).status, 400, 'already simple');
  assert.equal((await admin.trpc('assistants.convertRetired', { id: bare.id }, true)).status, 200);
  const b = getAssistant(bare.id)!;
  assert.deepEqual([b.simple, b.name, b.instructions], [true, 'No steps', ''], 'no agent step: just the name');
});

test('a bundle is stored with the Assistant, listed by get, kept by a save without a draft, shared and approved; settings change roles and model alone', async () => {
  const { pack, summary: sum } = await import('../src/assistants/bundle.ts');
  const { bundleOf } = await import('../src/server/assistant-bundle.ts');
  const files = { 'assistant.json': '{}', 'mcp.json': '["private-mcp"]', 'skills/own/SKILL.md': '---\nname: own\n---\nx', 'notes/a.md': 'A', 'z.txt': 'Z' };
  const made = writeAssistant({ name: 'Bundled', description: 'd', icon: 'Sparkles', inputs: INPUT_DEFAULTS, roles: [], flow: simpleFlow({ agent: 'claude-acp', instructions: 'Base.' }), scope: 'private', owner: admin.id, bundle: pack(files) });
  assert.deepEqual(bundleOf(made.id), files);
  const got = (await admin.trpc('assistants.get', { id: made.id })).json as { files: string[]; bundledSkills: string[]; instructions: string };
  assert.deepEqual([got.files, got.bundledSkills, got.instructions], [['notes/a.md', 'z.txt'], ['own'], 'Base.']);
  assert.deepEqual(sum({}), { files: [], bundledSkills: [] });
  const saved = await admin.trpc('assistants.save', { id: made.id, name: 'Bundled 2', description: 'd', icon: 'Sparkles', inputs: INPUT_DEFAULTS, agent: 'claude-acp', instructions: 'Base.' }, true);
  assert.equal(saved.status, 200, String(saved.error));
  assert.deepEqual(bundleOf(made.id), files, 'a save without a draft leaves the bundle alone');
  assert.equal((await admin.trpc('assistants.save', { id: made.id, draftId: 'abcdef999999', name: 'x', description: '', icon: 'Sparkles', inputs: INPUT_DEFAULTS, agent: 'claude-acp' }, true)).status, 400, 'a draft whose editor session is gone');

  const set = await admin.trpc('assistants.settings', { id: made.id, thinking: 'high' }, true);
  assert.equal(set.status, 200, String(set.error));
  assert.deepEqual([getAssistant(made.id)!.thinking, getAssistant(made.id)!.instructions, getAssistant(made.id)!.name], ['high', 'Base.', 'Bundled 2']);
  assert.deepEqual(bundleOf(made.id), files, 'settings leave the bundle alone');
  assert.equal((await admin.trpc('assistants.settings', { id: made.id, roles: ['admin'] }, true)).status, 400, 'a private Assistant has no roles');

  const shared = await admin.trpc('assistants.share', { id: made.id }, true);
  assert.equal(shared.status, 200, String(shared.error));
  const pf = db.prepare("SELECT path FROM package_files WHERE package_id = ? ORDER BY path").all(`asst_${made.id}`) as { path: string }[];
  assert.deepEqual(pf.map((r) => r.path), ['assistant.json', ...Object.keys(files).map((p) => `bundle/${p}`).sort()]);
  assert.equal((await admin.trpc('assistants.review', { id: made.id, decision: 'approve' }, true)).status, 200);
  assert.deepEqual(bundleOf(`t_${made.id}`), { ...files, 'mcp.json': '[]\n' }, 'the team copy has the files; only team MCP servers survive');
});

test('importing: one of url or zip, and a bad zip is a clear error', async () => {
  assert.equal((await admin.trpc('assistants.import', {}, true)).status, 400);
  assert.equal((await admin.trpc('assistants.import', { url: 'https://github.com/a/b', zip: 'AAAA' }, true)).status, 400);
  const bad = await admin.trpc('assistants.import', { zip: Buffer.from('not a zip, not even close to one').toString('base64') }, true);
  assert.equal(bad.status, 400);
  assert.match(bad.error!, /not a zip/);
  const nope = await admin.trpc('assistants.import', { url: 'http://github.com/a/b' }, true);
  assert.equal(nope.status, 400);
  assert.equal((await admin.trpc('assistants.import', { url: 'https://example.com/a/b' }, true)).status, 400, 'a host that is not GitHub or GitLab');
});

test('a test chat carries the draft\'s files; a saved Assistant\'s chat reads its own bundle', async () => {
  const { pack } = await import('../src/assistants/bundle.ts');
  const { chatBundle, markSeeded } = await import('../src/server/assistant-bundle.ts');
  const me = { id: admin.id, roleId: 'admin' };
  const snap = { id: 'draft:abcdef000001', name: 'D', description: '', icon: 'Sparkles', agent: 'claude-acp', model: null, thinking: null, instructions: 'i', skills: [], mcp: [], helpers: [], inputs: INPUT_DEFAULTS, roles: [], isDefault: false, archived: false, updatedAt: null, owner: admin.id, scope: 'private', shareStatus: null, version: 0, flow: simpleFlow({}), simple: true };
  const t = ad.createHidden(me, { agent: 'claude-acp', hidden: 'test', draftId: 'abcdef000001', snapshot: snap as never, bundle: pack({ 'extra.md': 'E', 'skills/s/SKILL.md': 'S' }) });
  const b = chatBundle(t)!;
  assert.deepEqual([b.extra, b.skills.map((s) => s.name), b.fresh], [{ 'extra.md': 'E' }, ['s'], true]);
  assert.deepEqual(sessionItems(admin.id, t).skills.map((s) => s.name), ['s']);
  markSeeded(t);
  assert.equal(chatBundle(t)!.fresh, false);
  assert.equal(chatBundle((await admin.trpc('conversations.create', { agent: 'claude-acp' }, true)).json.id), undefined, 'a chat without an Assistant has no bundle');
});

test('importing a repository: fetched through the Hub\'s GitHub path (stub), the top folder removed, the subfolder from the URL; a sandbox that is down leaves no draft behind', async () => {
  const { gzipSync } = await import('node:zlib');
  const hub = await import('../src/server/hub.ts');
  const { writeTar } = await import('../src/assistants/tar.ts');
  (await import('../src/server/mcp.ts')).setResolver(async () => ['140.82.112.3']); // no real DNS
  const creators = () => (db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE hidden = 'creator'").get() as { n: number }).n, before = creators();
  const real = globalThis.fetch, asked: string[] = [];
  globalThis.fetch = (async (u: string) => { asked.push(String(u)); return new Response(gzipSync(writeTar({ 'repo-abc/docs/a.md': 'A', 'repo-abc/other/b.md': 'B', 'repo-abc/CLAUDE.md': 'x' }))); }) as never;
  try {
    const t = await hub.fetchTree('https://github.com/o/r/tree/main/docs');
    assert.deepEqual([asked[0], t.path, t.entries.map((e) => e.path).sort()], ['https://codeload.github.com/o/r/tar.gz/main', 'docs', ['CLAUDE.md', 'docs/a.md', 'other/b.md']]);
    const r = await admin.trpc('assistants.import', { url: 'https://github.com/o/r/tree/main/docs' }, true);
    assert.equal(r.status, 502, String(r.error)); // the runner is not there: the files are valid, the workspace is not reachable
    assert.match(r.error!, /workspace could not be prepared/);
    const bad = await admin.trpc('assistants.import', { url: 'https://github.com/o/r', path: 'nope' }, true);
    assert.equal(bad.status, 400);
    assert.match(bad.error!, /not in the archive/);
  } finally { globalThis.fetch = real; }
  assert.equal(creators(), before, 'the failed import left no creator chat');
});

test('editing a saved Assistant again keeps its extra files and skills (the folder is restored from the stored bundle)', async () => {
  const { pack, unpack } = await import('../src/assistants/bundle.ts');
  const stored = unpack(pack({ 'assistant.json': '{}', 'instructions.md': 'old', 'notes/a.md': 'A', 'skills/own/SKILL.md': '---\nname: own\n---\nx' }));
  const fs = memFs(), id = 'abcdef777777', dir = draft.draftDir(id);
  await ad.seedDraft(fs, id, { ...full, newSkills: [] }, catalog);
  await ad.restoreBundle(fs, id, stored);
  const { bundle } = await ad.readDraft(fs, id, catalog, full);
  assert.equal(bundle['notes/a.md'], 'A');
  assert.equal(bundle['skills/own/SKILL.md'], stored['skills/own/SKILL.md']);
  assert.equal(bundle['instructions.md'], full.instructions, 'the core files come from the form, not the stored copy');
  assert.equal(fs.files.get(`${dir}/notes/a.md`), 'A');
  await ad.restoreBundle(fs, id, undefined); // an Assistant without a bundle: nothing to put back
});

test('repository hosts are resolved before connecting: private, loopback, link-local, CGNAT, ULA and v4-mapped answers are refused, on every hop', async () => {
  const mcp = await import('../src/server/mcp.ts');
  const hub = await import('../src/server/hub.ts');
  const answers: Record<string, string[]> = {};
  mcp.setResolver(async (h) => answers[h] ?? []);
  for (const bad of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.1.1', '192.168.1.1', '172.16.0.9', 'fd00::1', '::1', 'fe80::1', '::ffff:10.0.0.1']) {
    answers['git.example.com'] = ['93.184.216.34', bad]; // one bad answer is enough
    await assert.rejects(mcp.assertPublicHost('https://git.example.com/a/b'), /private|internal/, bad);
  }
  answers['git.example.com'] = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  await mcp.assertPublicHost('https://git.example.com/a/b');
  answers['nx.example.com'] = [];
  await assert.rejects(mcp.assertPublicHost('https://nx.example.com/'), /resolved/);
  // GitLab: a public name pointing inside is refused before any request; a redirect hop is checked again
  const real = globalThis.fetch, asked: string[] = [];
  globalThis.fetch = (async (u: string) => { asked.push(String(u)); return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }); }) as never;
  try {
    answers['evil.example.com'] = ['10.1.2.3'];
    answers['git.example.com'] = ['93.184.216.34'];
    await assert.rejects(hub.fetchTree('https://git.example.com/g/p'), /another host refused|not allowed/);
    answers['git.example.com'] = ['10.0.0.1'];
    asked.length = 0;
    await assert.rejects(hub.fetchTree('https://git.example.com/g/p'), /not allowed/);
    assert.equal(asked.length, 0, 'nothing was requested from an internal host');
  } finally { globalThis.fetch = real; mcp.setResolver(async () => ['140.82.112.3']); }
});

test('the file viewer lists the bundle files, reads one, cuts at 1 MB and refuses reserved, outside and foreign paths', async () => {
  const fs = memFs(), id = 'viewer123456', dir = draft.draftDir(id);
  await ad.seedDraft(fs, id, full, catalog);
  fs.files.set(`${dir}/templates/letter.md`, 'Dear …');
  fs.files.set(`${dir}/big.txt`, 'a'.repeat(ad.VIEW_CAP + 10));
  const list = await ad.listFiles(fs, id);
  assert.deepEqual(list.map((f) => f.path), ['assistant.json', 'instructions.md', 'skills.json', 'mcp.json', 'helpers.json', 'big.txt', 'skills/clause-check/SKILL.md', 'templates/letter.md']);
  assert.equal(list.find((f) => f.path === 'templates/letter.md')!.size, Buffer.byteLength('Dear …'));
  assert.ok(!list.some((f) => RESERVED.includes(f.path)), 'the brief and catalog are not listed');
  assert.deepEqual(await ad.readFile(fs, id, 'instructions.md'), { path: 'instructions.md', text: 'Be precise.\nCite clauses.', truncated: false });
  const big = await ad.readFile(fs, id, 'big.txt');
  assert.equal(big.truncated, true); assert.equal(big.text.length, ad.VIEW_CAP);
  for (const p of ['CLAUDE.md', 'catalog.json', '../x', '/etc/passwd', 'skills/../CLAUDE.md', 'nope.md', '__proto__', '.git/config']) await assert.rejects(ad.readFile(fs, id, p), /not part of the Assistant/, p);
  // another person's draft id is not found (checked before the sandbox is touched)
  const me = { id: admin.id, roleId: 'admin' };
  ad.createHidden(me, { agent: 'claude-acp', hidden: 'creator', draftId: id });
  const o = await auth.api.signUpEmail({ body: { name: 'o', email: 'other@x.test', password: PW } });
  db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'admin')").run(o.user.id);
  vault.rememberUserKey(o.user.id, vault.newKey());
  const otherCookie =cookieOf((await auth.api.signInEmail({ body: { email: 'other@x.test', password: PW }, returnHeaders: true })).headers);
  const other = (proc: string, input: unknown) => trpcCall((p, i) => app.request(p, i), otherCookie, proc, input, false);
  assert.ok(o.user.id);
  assert.equal((await other('assistants.draft.files', { draftId: id })).code, 'NOT_FOUND');
  assert.equal((await other('assistants.draft.file', { draftId: id, path: 'instructions.md' })).code, 'NOT_FOUND');
});

test('a saved Assistant\'s files can be looked at by whoever may see it, and by nobody else', async () => {
  const { pack } = await import('../src/assistants/bundle.ts');
  const files = { 'instructions.md': 'Team rules.', 'skills/own/SKILL.md': 'S', 'notes/a.md': 'A' };
  const mk = { name: 'x', description: '', icon: 'Sparkles', inputs: INPUT_DEFAULTS, roles: [], flow: simpleFlow({ agent: 'claude-acp', instructions: 'Base.' }) };
  const team = writeAssistant({ ...mk, name: 'Team one', scope: 'team', owner: admin.id, bundle: pack(files) });
  const priv = writeAssistant({ ...mk, name: 'Private one', scope: 'private', owner: admin.id, bundle: pack(files) });
  const legacy = writeAssistant({ ...mk, name: 'Legacy', scope: 'team', owner: admin.id });
  const w = await auth.api.signUpEmail({ body: { name: 'w', email: 'worker@x.test', password: PW } });
  db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'worker')").run(w.user.id);
  vault.rememberUserKey(w.user.id, vault.newKey());
  const wc = cookieOf((await auth.api.signInEmail({ body: { email: 'worker@x.test', password: PW }, returnHeaders: true })).headers);
  const worker = (proc: string, input: unknown) => trpcCall((p, i) => app.request(p, i), wc, proc, input, false);
  const list = await worker('assistants.draft.files', { id: team.id });
  assert.deepEqual(list.json.files.map((f: { path: string }) => f.path), ['instructions.md', 'notes/a.md', 'skills/own/SKILL.md']);
  assert.deepEqual((await worker('assistants.draft.file', { id: team.id, path: 'notes/a.md' })).json, { path: 'notes/a.md', text: 'A', truncated: false });
  assert.deepEqual((await admin.trpc('assistants.draft.files', { id: priv.id })).json.files.length, 3, 'the owner reads their private one');
  assert.equal((await worker('assistants.draft.files', { id: priv.id })).code, 'NOT_FOUND', 'another person\'s private Assistant');
  assert.equal((await worker('assistants.draft.file', { id: priv.id, path: 'notes/a.md' })).code, 'NOT_FOUND');
  for (const p of ['../x', '/etc/passwd', 'CLAUDE.md', 'skills/../x', 'nope']) assert.equal((await worker('assistants.draft.file', { id: team.id, path: p })).code, 'BAD_REQUEST', p);
  assert.equal((await worker('assistants.draft.files', { id: team.id, draftId: 'abcdef123456' })).code, 'BAD_REQUEST', 'exactly one of id and draftId');
  assert.equal((await worker('assistants.draft.files', {})).code, 'BAD_REQUEST');
  const old = (await worker('assistants.draft.files', { id: legacy.id })).json.files.map((f: { path: string }) => f.path);
  assert.deepEqual(old.slice(0, 2), ['assistant.json', 'instructions.md'], 'no bundle: the core files its columns make');
});

test('editing draft files: expect guards a changed file and a taken name; reserved and outside paths are refused; rename and remove', async () => {
  const fs = memFs(), id = 'abcdef123456', dir = draft.draftDir(id), at = (p: string) => fs.files.get(`${dir}/${p}`);
  await ad.seedDraft(fs, id, full, catalog);
  await ad.writeDraftFile(fs, id, 'docs/a.md', 'A', null); // new file, folder made
  assert.equal(at('docs/a.md'), 'A');
  await assert.rejects(ad.writeDraftFile(fs, id, 'docs/a.md', 'B', null), { message: 'A file with that name already exists.' });
  await ad.writeDraftFile(fs, id, 'docs/a.md', 'B', 'A');
  await assert.rejects(ad.writeDraftFile(fs, id, 'docs/a.md', 'C', 'A'), (e) => e instanceof ad.DraftConflict && e.message === 'This file changed since you opened it.');
  await ad.writeDraftFile(fs, id, 'docs/a.md', 'D'); // unconditional
  assert.equal(at('docs/a.md'), 'D');
  for (const p of ['CLAUDE.md', 'catalog.json', '.git/config', '../x', '/etc/passwd', 'a//b']) await assert.rejects(ad.writeDraftFile(fs, id, p, 'x'), { name: 'Error' }, p);
  assert.notEqual(at('CLAUDE.md'), 'x');
  await assert.rejects(ad.renameDraftFile(fs, id, 'docs/a.md', 'instructions.md'), ad.DraftConflict);
  await assert.rejects(ad.renameDraftFile(fs, id, 'docs/a.md', 'CLAUDE.md'));
  await assert.rejects(ad.renameDraftFile(fs, id, 'docs/none.md', 'docs/b.md'));
  await ad.renameDraftFile(fs, id, 'docs/a.md', 'docs/b.md');
  assert.deepEqual([at('docs/a.md'), at('docs/b.md')], [undefined, 'D']);
  await assert.rejects(ad.removeDraftFile(fs, id, 'CLAUDE.md'));
  await assert.rejects(ad.removeDraftFile(fs, id, 'docs/a.md'));
  await ad.removeDraftFile(fs, id, 'docs/b.md');
  assert.equal(at('docs/b.md'), undefined);
});
