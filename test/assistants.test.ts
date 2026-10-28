import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// Assistants without Docker or a model: CRUD and validation, role filtering, the default, the worker's limits (no model picks, upload size), the access paths of an Assistant
// on a CLI agent (a stand-in for the installed agent row), the images matrix, and what each agent's profile writes for an Assistant. The classic chat running on its Assistant is
// in e2e.test.ts; Claude Code reading the files and the model is in cli-agent-wrapper.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-assistants-'));
process.env.HEFYN_SECRET = 'assistants-test-secret-assistants-test-1';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1'; // configured, never called
process.env.HEFYN_INTERNAL_TOKEN = 'assistants-token-assistants-token-0123456789';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { agentGuard } = await import('../src/server/guard.ts');
const vault = await import('../src/server/vault.ts');
const { connect } = await import('../src/server/providers.ts');
const { inputsOf, skillBundles } = await import('../src/server/assistants.ts');
const { loadProfile } = await import('../src/server/profile.ts');
const { acpLaunch, assistantSeeds, profileOf, terminalLaunch, wrapperLaunch } = await import('../src/cli-agents/profiles.ts');
await import('../src/server/hub.ts'); // creates the Hub tables
vault.setTeamKey(vault.newKey());

const app = new Hono().route('/api', api);
const guarded = new Hono().use('/agents/*', agentGuard).all('/agents/*', (c) => c.text('through'));
const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  vault.rememberUserKey(r.user.id, vault.newKey());
  return {
    id: r.user.id, cookie,
    trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate),
    guard: (path: string) => guarded.request(path, { headers: { cookie } }),
  };
}
db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('auditor', 'Auditor', 0, ?)").run(JSON.stringify(['models.use']));
const admin = await mk('admin@x.test', 'admin');
const worker = await mk('worker@x.test', 'worker');
const other = await mk('other@x.test', 'auditor');

db.prepare("INSERT INTO providers (id, name, enc_key, created_at) VALUES ('openai', 'OpenAI', 'x', 'now')").run();
connect({ id: 'anthropic' }, 'sk-ant-company');
const OPTIONS0 = (await admin.trpc('assistants.options')).json; // before any agent is installed
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '0.95.0', 'ready', 1, '[]', 'now')").run();
const OPTIONS = (await admin.trpc('assistants.options')).json;
const CLAUDE_MODEL = OPTIONS.models.anthropic[0].id as string;
const GPT_MODEL = OPTIONS.models['openai-responses'][0].id as string;

const INPUTS = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 } as const;
const base = { name: 'Contracts', description: 'Reads contracts', icon: 'FileText', agent: 'claude-acp', model: null, thinking: null, instructions: 'Be precise.', skills: [] as string[], inputs: INPUTS, roles: [] as string[] };
const save = (over: object = {}, who = admin) => who.trpc('assistants.save', { ...base, ...over }, true);

// a Hub skill, approved for the team
const SKILL = 'sk_tone';
db.prepare(`INSERT INTO packages (id, kind, name, description, version, hash, source_json, visibility, status, owner_id, manifest_json, guard_json, approved_json, created_at, updated_at)
  VALUES (?, 'skill', 'tone', 'Formal tone', '1', 'h', '{"type":"ui"}', 'team', 'approved', 'x', '{}', '{"flagged":false,"reasons":[]}', ?, 'now', 'now')`).run(SKILL, JSON.stringify({
  version: '1', hash: 'h',
  manifest: { items: { skills: [{ name: 'tone', description: 'Formal tone', instructions: 'Be formal.', files: { 'refs/a.md': 'A' } }], agents: [], mcp: [] }, ignored: [], needsRunner: [] },
  files: { 'SKILL.md': '---\nname: tone\ndescription: Formal tone\n---\nBe formal.\n', 'refs/a.md': 'A', '../evil.md': 'no', 'ok/../../evil2.md': 'no' },
}));

test('the seeded profile is the default Assistant "General", and options list what the admin can pick', async () => {
  const list = (await admin.trpc('assistants.admin.list')).json;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].name, list[0].isDefault, list[0].agent, list[0].archived], ['default', 'General', true, 'claude-acp', false]); // stored with no agent (the retired hefyn one): reads as Claude Code
  assert.match(list[0].instructions, /You orchestrate/);
  assert.deepEqual(list[0].inputs, { images: 'on', maxImageEdge: 1568, imageQuality: 0.8, documents: true, maxUploadMb: 100 });
  assert.deepEqual(loadProfile().agents.map((a) => a.name), ['explorer', 'writer'], 'its sub-agents are still there');
  assert.deepEqual(OPTIONS0.agents, [], 'no hefyn agent: only installed CLI agents');
  assert.deepEqual(OPTIONS.agents.map((a: any) => a.id), ['claude-acp']);
  assert.ok(OPTIONS.thinking.includes('high') && OPTIONS.roles.some((r: any) => r.id === 'worker'));
  assert.deepEqual((await admin.trpc('assistants.options')).json.skills, [{ id: SKILL, name: 'tone', description: 'Formal tone', shared: true }]);
  assert.ok(CLAUDE_MODEL && GPT_MODEL && !CLAUDE_MODEL.includes('/') && !GPT_MODEL.includes('/'), 'agent models are bare ids');
  assert.equal((await worker.trpc('conversations.create', {}, true)).json.agent, 'claude-acp');
});

test('no picker offers hefyn as an agent: options, agent choices and every Assistant name only CLI agents', async () => {
  const agents = (await admin.trpc('assistants.options')).json.agents as { id: string | null; name: string }[];
  assert.ok(agents.length > 0 && agents.every((a) => typeof a.id === 'string' && a.id !== 'hefyn' && !/hefyn/i.test(a.name)));
  for (const a of [...(await admin.trpc('assistants.list')).json, ...(await admin.trpc('assistants.editable')).json]) assert.ok(a.agent === undefined || (typeof a.agent === 'string' && a.agent !== 'hefyn'), a.id);
  // the stored default has agent NULL (made for the retired hefyn agent): it reads as Claude Code, with no hefyn model, and the row is untouched
  const g = (await admin.trpc('assistants.get', { id: 'default' })).json;
  assert.deepEqual([g.agent, g.model, g.thinking], ['claude-acp', null, null]);
  assert.equal((db.prepare("SELECT agent FROM profiles WHERE id = 'default'").get() as any).agent, null);
  assert.equal((await worker.trpc('conversations.create', { assistantId: 'default' }, true)).json.agent, 'claude-acp');
});

test('save: validation, create, update', async () => {
  assert.equal((await save({ name: '  ' })).status, 400);
  assert.equal((await save({ instructions: 'x'.repeat(20_001) })).status, 400);
  assert.equal((await save({ instructions: 'x'.repeat(20_000) })).status, 200);
  assert.equal((await save({ model: 'anthropic/not-a-model' })).status, 400);
  assert.equal((await save({ thinking: 'ultra' })).status, 400);
  assert.equal((await save({ skills: ['nope'] })).status, 400);
  assert.equal((await save({ roles: ['nope'] })).status, 400);
  assert.equal((await save({ agent: 'nope' })).status, 400);
  assert.equal((await save({ agent: 'codex-acp' })).status, 400, 'an agent that is not installed');
  assert.equal((await save({ agent: null })).status, 400, 'an Assistant needs an agent');
  assert.equal((await save({ inputs: { ...INPUTS, maxUploadMb: 0 } })).status, 400);
  assert.equal((await save({ inputs: { ...INPUTS, imageQuality: 2 } })).status, 400);
  assert.equal((await save({ inputs: { ...INPUTS, images: 'maybe' } })).status, 400);
  assert.equal((await save({ id: 'ghost' })).status, 404);

  const made = await save({ model: CLAUDE_MODEL, thinking: 'high', skills: [SKILL], roles: ['worker'] });
  assert.equal(made.status, 200);
  const row = (await admin.trpc('assistants.admin.list')).json.find((a: any) => a.id === made.json.id);
  assert.deepEqual([row.name, row.model, row.thinking, row.skills, row.roles, row.isDefault, row.agent], ['Contracts', CLAUDE_MODEL, 'high', [SKILL], ['worker'], false, 'claude-acp']);
  assert.ok(row.updatedAt);
  assert.equal((await save({ id: made.json.id, name: 'Contracts 2', model: null, skills: [SKILL], roles: [] })).json.id, made.json.id);
  const after = (await admin.trpc('assistants.admin.list')).json.find((a: any) => a.id === made.json.id);
  assert.deepEqual([after.name, after.model, after.roles], ['Contracts 2', null, []]);
  assert.deepEqual(loadProfile(made.json.id).skills, [SKILL]);
  assert.deepEqual(skillBundles([SKILL, 'nope']).map((s) => [s.name, Object.keys(s.files)]), [['tone', ['refs/a.md']]]);
});

test('the team procedures are for models.manage / assistants.manage; a worker lists and builds private ones only', async () => {
  for (const [p, i, m] of [['assistants.admin.list', undefined, false], ['assistants.setDefault', { id: 'default' }, true]] as const) {
    assert.equal((await worker.trpc(p, i, m)).status, 403, p);
  }
  assert.equal((await worker.trpc('assistants.archive', { id: 'default', archived: false }, true)).status, 404, 'a team assistant is not theirs to touch');
  assert.equal((await worker.trpc('assistants.save', { ...base, scope: 'team' }, true)).status, 403);
  const mine = (await worker.trpc('assistants.list')).json;
  assert.ok(mine.length > 0 && mine.every((a: any) => !('instructions' in a) && !('model' in a) && !('roles' in a)));
  assert.deepEqual(Object.keys(mine[0]).sort(), ['agent', 'available', 'description', 'icon', 'id', 'inputs', 'isDefault', 'name', 'owner']);
});

test('roles decide who sees and starts an Assistant; archive and default rules', async () => {
  const only = (await save({ name: 'Audit only', roles: ['auditor'] })).json.id as string;
  const open = (await save({ name: 'Everyone', roles: [] })).json.id as string;
  const names = async (who: typeof admin) => (await who.trpc('assistants.list')).json.map((a: any) => a.name);
  assert.ok((await names(other)).includes('Audit only') && (await names(other)).includes('Everyone'));
  assert.ok(!(await names(worker)).includes('Audit only') && (await names(worker)).includes('Everyone'));
  assert.equal((await worker.trpc('conversations.create', { assistantId: only }, true)).status, 403);
  assert.equal((await other.trpc('conversations.create', { assistantId: only }, true)).status, 200);
  assert.equal((await worker.trpc('conversations.create', { assistantId: 'ghost' }, true)).status, 400);

  // the default is first; it cannot be archived; an archived one is hidden and cannot start chats
  assert.equal((await worker.trpc('assistants.list')).json[0].id, 'default');
  assert.equal((await admin.trpc('assistants.archive', { id: 'default', archived: true }, true)).status, 400);
  assert.equal((await admin.trpc('assistants.archive', { id: open, archived: true }, true)).status, 200);
  assert.ok(!(await names(worker)).includes('Everyone'));
  assert.equal((await worker.trpc('conversations.create', { assistantId: open }, true)).status, 403);
  assert.equal((await admin.trpc('assistants.setDefault', { id: open }, true)).status, 400, 'an archived one cannot become the default');
  assert.equal((await admin.trpc('assistants.archive', { id: open, archived: false }, true)).status, 200);
  assert.equal((await admin.trpc('assistants.setDefault', { id: open }, true)).status, 200);
  const list = (await worker.trpc('assistants.list')).json;
  assert.deepEqual([list[0].id, list.filter((a: any) => a.isDefault).length], [open, 1]);
  assert.equal((await admin.trpc('assistants.archive', { id: open, archived: true }, true)).status, 400, 'the new default is protected');
  // a chat without an assistantId runs on the default; one that already exists keeps its Assistant when the default changes
  const c1 = (await worker.trpc('conversations.create', {}, true)).json;
  assert.equal(c1.assistantId, open);
  assert.equal((await admin.trpc('assistants.setDefault', { id: 'default' }, true)).status, 200);
  assert.equal((await worker.trpc('conversations.list')).json.find((c: any) => c.id === c1.id).assistantId, open);
  const c2 = (await worker.trpc('conversations.create', {}, true)).json; // the stored default has no agent: it reads as Claude Code
  assert.deepEqual([c2.assistantId, c2.agent], ['default', 'claude-acp']);
});

test('a worker cannot pick a model or an effort, and is served no model list; an admin can', async () => {
  const c = (await worker.trpc('conversations.create', {}, true)).json.id;
  assert.equal((await worker.trpc('conversations.update', { id: c, model: 'anthropic/x' }, true)).status, 403);
  assert.equal((await worker.trpc('conversations.update', { id: c, thinking: 'low' }, true)).status, 403);
  assert.equal((await worker.trpc('conversations.update', { id: c, title: 'ok' }, true)).status, 200);
  assert.deepEqual((await worker.trpc('models.available')).json, []);
  assert.deepEqual((await worker.trpc('models.connected')).json, []);
  assert.ok((await admin.trpc('models.available')).json.length > 0);
  const a = (await admin.trpc('conversations.create', {}, true)).json.id;
  assert.equal((await admin.trpc('conversations.update', { id: a, thinking: 'low' }, true)).status, 200);
});

test('input rules: unreadable or invalid values take the closed defaults', () => {
  assert.deepEqual(inputsOf('not json'), { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 });
  assert.equal(inputsOf({ images: 'yes', maxUploadMb: -3, documents: 'true' }).images, 'off');
});

// ---------- an Assistant on a CLI agent ----------
test('an Assistant on a CLI agent: usable by its roles without sandbox.shell, only while the agent and its key work; raw use still needs the shell', async () => {
  db.prepare("UPDATE roles SET permissions = ? WHERE id = 'worker'").run(JSON.stringify(['models.use'])); // Worker has the shell by default now; this test is about a role without it
  db.prepare("UPDATE cli_agents SET roles = '[\"nobody\"]' WHERE id = 'claude-acp'").run(); // the agent's own role list excludes everyone
  const opts = (await admin.trpc('assistants.options')).json;
  assert.deepEqual(opts.agents.map((a: any) => [a.id, a.api]), [['claude-acp', 'anthropic']]);
  assert.equal((await save({ agent: 'claude-acp', model: GPT_MODEL ?? 'gpt-x' })).status, 400, 'an OpenAI model on an Anthropic agent');
  assert.equal((await save({ agent: 'claude-acp', model: 'anthropic/' + CLAUDE_MODEL })).status, 400, 'a provider/model id is not an agent model id');
  const made = await save({ name: 'Coder', agent: 'claude-acp', model: CLAUDE_MODEL, instructions: 'Write tidy code.', skills: [SKILL], roles: ['worker'] });
  assert.equal(made.status, 200, String(made.error));
  const aid = made.json.id as string;

  const row = (await worker.trpc('assistants.list')).json.find((a: any) => a.id === aid);
  assert.deepEqual([row.agent, row.available, row.reason], ['claude-acp', true, undefined]);
  assert.equal((await other.trpc('assistants.list')).json.some((a: any) => a.id === aid), false, 'not in the roles it lists');
  const c = (await worker.trpc('conversations.create', { assistantId: aid, agent: 'codex-acp' }, true)).json; // a client agent is ignored
  assert.deepEqual([c.agent, c.assistantId, c.view], ['claude-acp', aid, 'chat']);
  assert.equal((await worker.trpc('conversations.list')).json.find((x: any) => x.id === c.id).assistantId, aid);

  // the web guard lets the worker reach the agent through the Assistant, not without it
  assert.equal(await (await worker.guard(`/agents/cli/${c.id}/events`)).text(), 'through');
  const raw = (await admin.trpc('conversations.create', { agent: 'claude-acp' }, true)); // raw use: the admin has the shell, but the agent's own roles exclude everyone
  assert.equal(raw.status, 403);
  db.prepare("UPDATE cli_agents SET roles = '[]' WHERE id = 'claude-acp'").run();
  assert.equal((await worker.trpc('conversations.create', { agent: 'claude-acp' }, true)).status, 403, 'raw use needs sandbox.shell');
  const rawAdmin = (await admin.trpc('conversations.create', { agent: 'claude-acp' }, true)).json;
  assert.equal(rawAdmin.assistantId, undefined);
  assert.equal(db.prepare('SELECT assistant_id FROM conversations WHERE id = ?').get(rawAdmin.id)!.assistant_id, null);
  db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent) VALUES (?, ?, ?, 'now', 'claude-acp')").run(`u_${worker.id}_01RAWAGENT`, worker.id, vault.sealForUser(worker.id, 'raw', `conv:u_${worker.id}_01RAWAGENT:title`));
  assert.equal((await worker.guard(`/agents/cli/u_${worker.id}_01RAWAGENT/events`)).status, 403, 'no Assistant, no shell: no sandbox');

  // unavailable with a plain reason: key, agent state, role, archive
  db.prepare("DELETE FROM providers WHERE id = 'anthropic'").run();
  const noKey = (await worker.trpc('assistants.list')).json.find((a: any) => a.id === aid);
  assert.deepEqual([noKey.available, /No Anthropic API key/.test(noKey.reason)], [false, true], noKey.reason);
  assert.equal((await worker.trpc('conversations.create', { assistantId: aid }, true)).status, 403);
  // Claude Code can also run on the user's own Claude account (own-account.ts), so the reason points there; whether someone is signed in is asked of the sandbox (test/cli-wrapper-host.test.ts)
  const noKeyReason = (await worker.trpc('assistants.list')).json.find((a: any) => a.id === aid).reason;
  assert.match(noKeyReason, /No Anthropic API key.* Or sign in with your own account: Settings, Agent accounts\.$/);
  connect({ id: 'anthropic' }, 'sk-ant-company');
  db.prepare("UPDATE cli_agents SET enabled = 0 WHERE id = 'claude-acp'").run();
  assert.equal((await worker.trpc('assistants.list')).json.find((a: any) => a.id === aid).available, false);
  db.prepare("UPDATE cli_agents SET enabled = 1 WHERE id = 'claude-acp'").run();
  assert.equal((await worker.trpc('assistants.list')).json.find((a: any) => a.id === aid).available, true);
  assert.equal((await admin.trpc('assistants.archive', { id: aid, archived: true }, true)).status, 200);
  assert.equal((await worker.guard(`/agents/cli/${c.id}/events`)).status, 403, 'an archived Assistant grants nothing');
  assert.equal((await admin.trpc('assistants.archive', { id: aid, archived: false }, true)).status, 200);
  assert.equal((await save({ id: aid, name: 'Coder', agent: 'claude-acp', model: CLAUDE_MODEL, instructions: 'x', roles: ['auditor'] })).status, 200);
  assert.equal((await worker.guard(`/agents/cli/${c.id}/events`)).status, 403, 'the worker\'s role is no longer listed');
});

// ---------- what each agent's profile writes for an Assistant ----------
const cfg: { model: string | null; instructions: string; skills: { name: string; files: Record<string, string> }[] } = { model: 'm-1', instructions: 'Be formal.', skills: [{ name: 'tone', files: { 'SKILL.md': '---\nname: tone\n---\nx', 'refs/a.md': 'A', '../evil.md': 'no', '/abs.md': 'no', 'a/../../b.md': 'no' } }, { name: '../bad', files: { 'SKILL.md': 'no' } }] };
const launchSeeds = (id: string, terminal = false) => {
  const p = profileOf(id)!, l = p.wrapper ? wrapperLaunch(p, '1.0.0', '11111111-2222-3333-4444-555555555555', undefined, undefined, cfg) : terminal ? terminalLaunch(p, '1.0.0', null, undefined, undefined, cfg) : acpLaunch(p, '1.0.0', undefined, cfg);
  return JSON.parse(l.env.HEFYN_SEED) as any[];
};

test('seeding: every agent gets its instructions file and skills in its own user-level config, and the model in its own setting', () => {
  const files = { 'claude-acp': ['/tmp/.claude', 'CLAUDE.md'], 'codex-acp': ['/tmp/.codex', 'AGENTS.md'], opencode: ['/tmp/.config/opencode', 'AGENTS.md'], 'pi-acp': ['/tmp/.pi/agent', 'AGENTS.md'] } as const;
  for (const [id, [dir, file]] of Object.entries(files)) {
    const p = profileOf(id)!, seeds = assistantSeeds(p, cfg), paths = seeds.map((s) => s.path);
    assert.deepEqual(seeds[0], { path: `${dir}/${file}`, text: 'Be formal.' }, id);
    assert.deepEqual(seeds[1], { path: `${dir}/skills`, sweep: true }, id);
    assert.deepEqual(paths.slice(2), [`${dir}/skills/tone/.hefyn-managed`, `${dir}/skills/tone/SKILL.md`, `${dir}/skills/tone/refs/a.md`], `${id}: unsafe paths and names are dropped`);
    for (const t of [false, true]) assert.ok(launchSeeds(id, t).length > 0);
  }
  const text = (id: string, path: string) => launchSeeds(id).find((s) => s.path === path)!.text as string;
  const claudeSettings = (c: any) => JSON.parse(wrapperLaunch(profileOf('claude-acp')!, '1', '11111111-2222-3333-4444-555555555555', undefined, undefined, c).env.HEFYN_SEED).filter((s: any) => s.path === '/tmp/.claude/settings.json');
  assert.deepEqual(claudeSettings(cfg), [{ path: '/tmp/.claude/settings.json', json: { permissions: { defaultMode: 'default' } }, force: false }, { path: '/tmp/.claude/settings.json', json: { model: 'm-1' }, force: true }]); // merged: the model never wipes "ask before acting"
  assert.match(text('codex-acp', '/tmp/.codex/config.toml'), /^model = "m-1"\nmodel_provider = "hefyn"/);
  const oc = launchSeeds('opencode').filter((s) => s.path === '/tmp/.config/opencode/opencode.json'); // the common file, then the provider's block merged into it
  assert.equal(oc[1].json.model, 'anthropic/m-1');
  assert.deepEqual(JSON.parse(text('pi-acp', '/tmp/.pi/agent/settings.json')), { defaultProvider: 'anthropic', defaultModel: 'm-1' });
  // an Assistant without a model clears an earlier one; no Assistant writes none of it
  assert.ok(claudeSettings({ model: null }).every((s: any) => !('model' in s.json)));
  assert.doesNotMatch(JSON.parse(acpLaunch(profileOf('codex-acp')!, '1', undefined, { model: null }).env.HEFYN_SEED)[0].text, /^model = /m);
  for (const id of Object.keys(files).filter((x) => x !== 'claude-acp')) assert.ok(!JSON.parse(acpLaunch(profileOf(id)!, '1').env.HEFYN_SEED).some((s: any) => /settings\.json$/.test(s.path) || /(^|\n)model = /.test(s.text ?? '') || s.json?.model), `${id}: raw use is untouched`);
});

test('seed.mjs --stdin writes the Assistant\'s files and sweeps only the skills hefyn wrote earlier', () => {
  const dir = `/tmp/hefyn-asst-${Math.random().toString(36).slice(2)}`;
  const move = (list: any[]) => list.map((s) => ({ ...s, path: s.path.replace('/tmp/.claude', `${dir}/.claude`) }));
  const run = (list: unknown[]) => spawnSync('node', ['services/sandbox-image/seed.mjs', '--stdin'], { input: JSON.stringify(list), encoding: 'utf8', env: { ...process.env, HEFYN_SEED: '' } });
  try {
    mkdirSync(`${dir}/.claude/skills/mine`, { recursive: true }); // the agent's own skill (no marker) stays
    writeFileSync(`${dir}/.claude/skills/mine/SKILL.md`, 'mine');
    const p = profileOf('claude-acp')!;
    assert.equal(run(move(assistantSeeds(p, cfg))).status, 0);
    assert.equal(readFileSync(`${dir}/.claude/CLAUDE.md`, 'utf8'), 'Be formal.');
    assert.equal(readFileSync(`${dir}/.claude/skills/tone/refs/a.md`, 'utf8'), 'A');
    assert.ok(!existsSync(`${dir}/.claude/evil.md`) && !existsSync(`${dir}/.claude/skills/evil.md`) && !existsSync(`${dir}/abs.md`));
    // the admin removed the skill and changed the instructions: the next start has neither the skill nor the old text, and the agent's own skill is still there
    assert.equal(run(move(assistantSeeds(p, { model: null, instructions: 'New.', skills: [] }))).status, 0);
    assert.equal(readFileSync(`${dir}/.claude/CLAUDE.md`, 'utf8'), 'New.');
    assert.ok(!existsSync(`${dir}/.claude/skills/tone`) && existsSync(`${dir}/.claude/skills/mine/SKILL.md`));
    assert.notEqual(run([{ path: '/etc/hefyn-seed-test', text: 'x' }]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
