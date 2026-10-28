import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// What the agents get besides the model: skills, MCP servers and helpers per agent (pure config generation), the MCP proxy (access check, credentials injected on the way
// out), Assistant CRUD with the new fields, skill sharing and the per-person switches, and the MCP page's status and errors.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-items-'));
process.env.HEFYN_SECRET = 'items-test-secret-items-test-secret-1';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1';
process.env.HEFYN_INTERNAL_TOKEN = 'items-token-items-token-0123456789012';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { connect } = await import('../src/server/providers.ts');
const mcp = await import('../src/server/mcp.ts');
const { mcpProxy } = await import('../src/server/mcp-proxy.ts');
const { sessionSkills, setOn } = await import('../src/server/skills.ts');
const { profileOf, acpLaunch, BRIDGE_PORT } = await import('../src/cli-agents/profiles.ts');
const { planSession, roleSlug } = await import('../src/cli-agents/session-config.ts');
const { parseAgentManifest } = await import('../src/modules/agent-manifest.ts');
vault.setTeamKey(vault.newKey());

const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const helper = (agent: string, role = 'review', model: string | null = null, edit = false) => ({ role, slug: roleSlug(role), profile: profileOf(agent)!, version: '9.9.9', provider: null, model, edit });
const seedsOf = (l: { env: Record<string, string> }) => JSON.parse(l.env.HEFYN_SEED) as any[];

// ---- config generation per agent (pure) ----
test('Claude Code: MCP servers into .claude.json, a helper as a skill and a script, the allow rule, and the helper agent\'s own config', () => {
  const p = planSession({ profile: profileOf('claude-acp')!, base: BASE, instructions: 'Be brief.', skills: [{ name: 'tone', files: { 'SKILL.md': 'x' } }], helpers: [helper('codex-acp', 'Code review', 'gpt-x')], mcp: [{ name: 'docs_ab12', path: '/mcp/c1' }] });
  assert.deepEqual(p.notes, []);
  assert.ok(p.stdin.some((s: any) => s.path === '/tmp/.claude/CLAUDE.md' && s.text === 'Be brief.'));
  assert.ok(p.stdin.some((s: any) => s.path === '/tmp/.claude/skills/tone/SKILL.md'));
  const skill = p.stdin.find((s: any) => s.path === '/tmp/.claude/skills/hefyn-helper-code-review/SKILL.md') as any;
  assert.match(skill.text, /hand it to Codex/);
  assert.match(skill.text, /sh \/tmp\/\.hefyn\/helpers\/code-review\.sh "<the task>"/);
  const script = (p.stdin.find((s: any) => s.path === '/tmp/.hefyn/helpers/code-review.sh') as any).text as string;
  assert.match(script, /export CODEX_HOME='\/tmp\/\.codex'/);
  assert.match(script, /export HEFYN_GATEWAY_KEY='hefyn-gateway'/, 'the helper routes through the gateway with the dummy key, never a real one');
  assert.match(script, /exec \/opt\/agents\/codex-acp\/9\.9\.9\/node_modules\/\.bin\/codex exec --skip-git-repo-check --sandbox read-only "\$@"/, 'a helper is read-only unless it may edit');
  assert.match(script, /OPENAI_API_KEY='hefyn-gateway'/);
  const mcpSeed = p.launch.find((s: any) => s.path === '/tmp/.claude/.claude.json') as any;
  assert.deepEqual(mcpSeed.json, { mcpServers: { docs_ab12: { type: 'http', url: `${BASE}/mcp/c1` } } });
  const allow = p.launch.find((s: any) => s.path === '/tmp/.claude/settings.json') as any;
  assert.deepEqual(allow.json, { permissions: { allow: ['Bash(sh /tmp/.hefyn/helpers/code-review.sh:*)'] } });
  const codex = p.launch.find((s: any) => s.path === '/tmp/.codex/config.toml') as any;
  assert.match(codex.text, /model = "gpt-x"/);
  assert.match(codex.text, /base_url = "http:\/\/127\.0\.0\.1:47000\/a\/codex-acp\/v1"/, 'a helper reaches the bridge under its own agent path');
  const editing = planSession({ profile: profileOf('claude-acp')!, base: BASE, skills: [], helpers: [helper('codex-acp', 'fix', null, true)], mcp: [] });
  assert.match((editing.stdin.find((s: any) => s.path === '/tmp/.hefyn/helpers/fix.sh') as any).text, /--sandbox workspace-write/);
});

test('Codex: [mcp_servers.<name>] appended to config.toml, an allow rule appended to the rules file; the launch seed carries them', () => {
  const profile = profileOf('codex-acp')!;
  const p = planSession({ profile, base: BASE, skills: [], helpers: [helper('opencode', 'tests')], mcp: [{ name: 'docs_ab12', path: '/mcp/c1' }] });
  const l = acpLaunch(profile, '1.0.0', undefined, { launchSeeds: p.launch });
  const toml = seedsOf(l).find((s) => s.path === '/tmp/.codex/config.toml').text as string;
  assert.match(toml, /\[model_providers\.hefyn\][\s\S]*\[mcp_servers\.docs_ab12\]\nurl = "http:\/\/127\.0\.0\.1:47000\/mcp\/c1"/);
  assert.match(seedsOf(l).find((s) => s.path === '/tmp/.codex/rules/default.rules').text, /prefix_rule\(pattern=\[\["ls".*\n\nprefix_rule\(pattern=\["sh","\/tmp\/\.hefyn\/helpers\/tests\.sh"\], decision="allow"\)/s);
  assert.ok(seedsOf(l).some((s) => s.path === '/tmp/.config/opencode/opencode.json'), 'the helper agent\'s own config is written too');
  assert.ok(!p.stdin.some((s: any) => 'text' in s && s.path === '/tmp/.codex/AGENTS.md'), 'no instructions given: the file is left alone');
});

test('OpenCode: servers under "mcp" in opencode.json; no allow rule is written (its bash permission asks)', () => {
  const p = planSession({ profile: profileOf('opencode')!, base: BASE, skills: [], helpers: [helper('claude-acp')], mcp: [{ name: 'a_1', path: '/mcp/c1' }, { name: 'b_2', path: '/mcp/c2' }] });
  const o = p.launch.filter((s: any) => s.path === '/tmp/.config/opencode/opencode.json') as any[];
  assert.deepEqual(o.map((s) => s.json.mcp), [{ a_1: { type: 'remote', url: `${BASE}/mcp/c1`, enabled: true }, b_2: { type: 'remote', url: `${BASE}/mcp/c2`, enabled: true } }], 'one seed that owns its entries');
  assert.ok(!p.launch.some((s: any) => s.path === '/tmp/.opencode/permissions'));
});

test('Pi has no MCP: the manifest says unsupported, nothing is written, and Pi can still be a helper', () => {
  const pi = profileOf('pi-acp')!;
  assert.deepEqual(pi.spec.mcpServers, { unsupported: true });
  const p = planSession({ profile: pi, base: BASE, skills: [], helpers: [], mcp: [{ name: 'a_1', path: '/mcp/c1' }] });
  assert.deepEqual(p.launch, []);
  assert.match(p.notes[0]!, /no MCP support/);
  const viaPi = planSession({ profile: profileOf('opencode')!, base: BASE, skills: [], helpers: [helper('pi-acp', 'scripts')], mcp: [] });
  assert.match((viaPi.stdin.find((s: any) => s.path === '/tmp/.hefyn/helpers/scripts.sh') as any).text, /node_modules\/\.bin\/pi -p --tools read,grep,find,ls "\$@"/);
});

test('a launch config with only launchSeeds is not an Assistant: files that are for an Assistant stay unwritten', () => {
  const pi = profileOf('pi-acp')!;
  const withAsst = seedsOf(acpLaunch(pi, '1', undefined, { model: 'm', provider: null })).map((s) => s.path);
  const plain = seedsOf(acpLaunch(pi, '1', undefined, { launchSeeds: [{ path: '/tmp/.pi/agent/x', text: 'y' }] })).map((s) => s.path);
  assert.ok(withAsst.includes('/tmp/.pi/agent/settings.json') && !plain.includes('/tmp/.pi/agent/settings.json'));
  assert.ok(plain.includes('/tmp/.pi/agent/x'));
});

test('the manifest rules: server placeholders only in mcpServers, no addresses, text needs |json for the url, helperAllow stays under the config dir', () => {
  const base = { kind: 'agent', id: 'acme', name: 'Acme', description: 'x', distribution: { version: '1.0.0', npm: 'acme@1.0.0' }, api: 'anthropic', asksBeforeActing: true, launch: { npm: { package: 'acme', bin: 'acme' } },
    terminal: { command: 'exec acme' }, config: { dir: '/tmp/.acme', instructionsFile: 'AGENTS.md', skillsDir: '/tmp/.acme/skills', mcpConfig: 'x' } };
  const mcpServers = { path: '/tmp/.acme/mcp.json', format: 'json-merge', content: { servers: { '{{server.name}}': { url: '{{server.url}}' } } } };
  assert.doesNotThrow(() => parseAgentManifest({ ...base, mcpServers, headless: { command: 'exec acme -p "$@"' }, helperAllow: { path: '/tmp/.acme/settings.json', format: 'json-merge', at: ['allow'], rule: 'sh {{helper.script}}' } }));
  const refused = (m: object, re: RegExp) => assert.throws(() => parseAgentManifest({ ...base, ...m }), re);
  refused({ files: [{ ...mcpServers, path: '/tmp/.acme/f.json' }] }, /unknown placeholder \{\{server\.name\}\}/);
  refused({ mcpServers: { ...mcpServers, content: { servers: { x: { url: 'https://evil.example/mcp' } } } } }, /network addresses/);
  refused({ mcpServers: { path: '/tmp/.acme/c.toml', format: 'text', content: ['url = {{server.url}}'] } }, /\|json/);
  refused({ headless: { command: 'exec acme https://evil.example' } }, /network addresses/);
  refused({ helperAllow: { path: '/etc/x', format: 'text', rule: 'x' } }, /under \/tmp/);
  refused({ helperAllow: { path: '/tmp/.acme/s.json', format: 'json-merge', rule: 'x' } }, /needs `at`/);
});

// ---- MCP proxy ----
const A = 'user-a', B = 'user-b';
vault.rememberUserKey(A, vault.newKey()); vault.rememberUserKey(B, vault.newKey());
const mine = mcp.createConnector(A, { name: 'Docs', url: 'https://mcp.example.com/mcp', auth: 'bearer', bearer: 'sekret-token' });
const teamC = mcp.createConnector(A, { name: 'Wiki', url: 'https://wiki.example.com/mcp', visibility: 'team' });
const conv = (id: string, user: string, assistant: string | null = null, agent: string | null = null) => {
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?,?,?,?)').run(id, user, 't', 'now');
  if (assistant) db.prepare('UPDATE conversations SET assistant_id = ? WHERE id = ?').run(assistant, id);
  if (agent) db.prepare('UPDATE conversations SET agent = ? WHERE id = ?').run(agent, id);
};
conv('cA', A); conv('cB', B);
const seen: { url: string; headers: Headers; body: string }[] = [];
const upstream: typeof fetch = (async (url: string, init: RequestInit) => { seen.push({ url, headers: new Headers(init.headers), body: init.body ? Buffer.from(init.body as ArrayBuffer).toString() : '' }); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'mcp-session-id': 's1', 'content-encoding': 'gzip' } }); }) as any;
const post = (who: string, c: string, id: string, headers: Record<string, string> = {}) => mcpProxy({ userId: who, conversationId: c }, upstream)(new Request(`http://x/mcp/${id}`, { method: 'POST', body: '{"jsonrpc":"2.0"}', headers: { 'content-type': 'application/json', ...headers } }));

test('the proxy forwards to the real server with the stored credential, and the sandbox cannot send its own', async () => {
  const r = await post(A, 'cA', mine, { authorization: 'Bearer from-the-sandbox', cookie: 'x=1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 's1');
  assert.equal(r.headers.get('content-encoding'), null);
  assert.equal(seen.at(-1)!.url, 'https://mcp.example.com/mcp');
  assert.equal(seen.at(-1)!.headers.get('authorization'), 'Bearer sekret-token');
  assert.equal(seen.at(-1)!.headers.get('cookie'), null);
  assert.equal(seen.at(-1)!.body, '{"jsonrpc":"2.0"}');
});

test('the proxy refuses another user\'s private connector, unknown ids, other methods, and a team connector is open to everyone', async () => {
  const n = seen.length;
  assert.equal((await post(B, 'cB', mine)).status, 403, 'someone else\'s private server');
  assert.equal((await post(A, 'cA', 'nope')).status, 403);
  assert.equal((await mcpProxy({ userId: A, conversationId: 'cA' }, upstream)(new Request(`http://x/mcp/${mine}`, { method: 'PUT' }))).status, 404);
  assert.equal(seen.length, n, 'nothing was forwarded');
  assert.equal((await post(B, 'cB', teamC)).status, 200);
  assert.equal(seen.at(-1)!.headers.get('authorization'), null, 'a connector without auth gets none');
});

test('plain chats get the servers that are on; an Assistant chat gets exactly its own list', async () => {
  const { mcpFor } = await import('../src/server/session-items.ts');
  assert.deepEqual(mcpFor(A, 'cA').map((c) => c.id).sort(), [mine, teamC].sort());
  setOn(A, 'mcp', mine, false);
  assert.deepEqual(mcpFor(A, 'cA').map((c) => c.id), [teamC]);
  assert.equal((await post(A, 'cA', mine)).status, 403, 'switched off: a stale config in the sandbox reaches nothing');
  db.prepare("INSERT INTO profiles (id, name, instructions, scope, owner_id, mcp, agent) VALUES ('asst1', 'X', '', 'private', ?, ?, 'claude-acp')").run(A, JSON.stringify([mine]));
  conv('cAsst', A, 'asst1', 'claude-acp');
  assert.deepEqual(mcpFor(A, 'cAsst').map((c) => c.id), [mine], 'the Assistant names it: the switch does not apply, the team server is not given');
  assert.equal((await post(A, 'cAsst', mine)).status, 200);
  assert.equal((await post(A, 'cAsst', teamC)).status, 403);
  setOn(A, 'mcp', mine, true);
});

// ---- the MCP page: edit, status, readable errors ----
test('editing moves a connector between private and team without losing its secret, and a new address drops it', async () => {
  const id = mcp.createConnector(A, { name: 'Moves', url: 'https://moves.example.com/mcp', auth: 'bearer', bearer: 'tok-1' });
  mcp.updateConnector(id, { name: 'Moved', visibility: 'team' });
  assert.deepEqual([mcp.listConnectors(B).find((c) => c.id === id)?.name, (await mcp.proxyTarget(B, id))?.headers.authorization], ['Moved', 'Bearer tok-1'], 'sealed again under the team key');
  mcp.updateConnector(id, { visibility: 'private' });
  assert.equal(await mcp.proxyTarget(B, id), undefined);
  assert.equal((await mcp.proxyTarget(A, id))?.headers.authorization, 'Bearer tok-1');
  mcp.updateConnector(id, { url: 'https://elsewhere.example.com/mcp' });
  await assert.rejects(mcp.proxyTarget(A, id), /sign-in needed/, 'the token never follows the connector to another address');
  assert.throws(() => mcp.updateConnector(id, { url: 'http://127.0.0.1/x' }), /private or internal/);
});

test('the status is the last real test; a failed test gives a short sentence, never HTML', async () => {
  const id = mcp.createConnector(A, { name: 'Flaky', url: 'https://flaky.example.com/mcp' });
  assert.equal(mcp.listConnectors(A).find((c) => c.id === id)!.status, 'untested');
  const html = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: <!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1></body></html>'), { code: 404 });
  const bad = await mcp.testConnector(A, id, false, (async () => { throw html; }) as any);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /web page \(HTTP 404\), not an MCP endpoint/);
  assert.doesNotMatch(bad.error!, /</);
  const listed = mcp.listConnectors(A).find((c) => c.id === id)!;
  assert.deepEqual([listed.status, listed.error], ['failed', bad.error]);
  const ok = await mcp.testConnector(A, id, false, (async () => ({ listTools: async () => ({ tools: [{ name: 't1' }] }), close: async () => {} })) as any);
  assert.deepEqual([ok.ok, ok.tools], [true, ['t1']]);
  assert.equal(mcp.listConnectors(A).find((c) => c.id === id)!.status, 'ok');
  for (const [e, re] of [[new Error('getaddrinfo ENOTFOUND x'), /name was not found/], [new Error('fetch failed'), /Could not reach/], [Object.assign(new Error('x'), { code: 401 }), /refused the credentials/]] as const) assert.match(mcp.readableError(e), re);
  assert.ok(mcp.readableError(new Error('x'.repeat(2000))).length <= 160);
});

// ---- Assistants and skills through the API ----
const app = new Hono().route('/api', api);
const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  vault.rememberUserKey(r.user.id, vault.newKey());
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
const admin = await mk('admin@items.test', 'admin');
const worker = await mk('worker@items.test', 'worker');
const w2 = await mk('worker2@items.test', 'worker');
connect({ id: 'anthropic' }, 'sk-ant-company');
db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('claude-acp', '1', 'ready', 1, '[]', 'now')").run();
const INPUTS = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 } as const;
const asst = { name: 'Reviewer', description: 'Reviews', icon: 'emoji:🧐', agent: 'claude-acp', model: null, thinking: null, instructions: 'Review carefully.', skills: [] as string[], inputs: INPUTS, roles: [] as string[] };

test('Assistant CRUD with an emoji icon, MCP servers and helpers; models stay with models.manage', async () => {
  const wMcp = mcp.createConnector(worker.id, { name: 'Mine', url: 'https://mine.example.com/mcp' });
  const made = await worker.trpc('assistants.save', { ...asst, mcp: [wMcp], helpers: [{ role: 'Review', agent: 'codex-acp', provider: 'openai', model: 'gpt-x' }, { role: 'tests', agent: 'opencode' }] }, true);
  assert.equal(made.status, 200, made.error ?? '');
  const got = (await worker.trpc('assistants.get', { id: made.json.id })).json;
  assert.deepEqual([got.icon, got.mcp, got.helpers.map((h: any) => [h.role, h.agent, h.provider, h.model])], ['emoji:🧐', [wMcp], [['Review', 'codex-acp', null, null], ['tests', 'opencode', null, null]]], 'a worker cannot set a helper\'s provider or model');
  assert.deepEqual((await worker.trpc('assistants.list')).json.find((a: any) => a.id === made.json.id).icon, 'emoji:🧐');
  const byAdmin = await admin.trpc('assistants.save', { ...asst, name: 'Mgr', helpers: [{ role: 'Review', agent: 'codex-acp', provider: 'openai', model: 'gpt-x' }] }, true);
  assert.equal(byAdmin.status, 200, byAdmin.error ?? '');
  assert.deepEqual((await admin.trpc('assistants.get', { id: byAdmin.json.id })).json.helpers, [{ role: 'Review', agent: 'codex-acp', provider: 'openai', model: 'gpt-x', edit: false }], 'whoever manages models sets a helper\'s provider and model');
  assert.equal((await admin.trpc('assistants.save', { ...asst, name: 'Mgr2', helpers: [{ role: 'Review', agent: 'codex-acp', provider: 'no$such' }] }, true)).status, 400);
  const upd = await worker.trpc('assistants.save', { ...asst, id: made.json.id, name: 'Reviewer 2' }, true); // no mcp/helpers sent: unchanged
  assert.equal(upd.status, 200);
  assert.deepEqual((await worker.trpc('assistants.get', { id: made.json.id })).json.mcp, [wMcp]);
  assert.equal((await worker.trpc('assistants.save', { ...asst, id: made.json.id, mcp: [], helpers: [] }, true)).status, 200);
  const cleared = (await worker.trpc('assistants.get', { id: made.json.id })).json;
  assert.deepEqual([cleared.mcp, cleared.helpers], [[], []]);
});

test('Assistant validation: icons, helpers, and which MCP servers may be named', async () => {
  const bad = async (over: object, re: RegExp) => { const r = await worker.trpc('assistants.save', { ...asst, ...over }, true); assert.equal(r.status, 400, JSON.stringify(over)); assert.match(r.error!, re); };
  await bad({ icon: 'bad icon!' }, /icon or an emoji/);
  await bad({ helpers: [{ role: 'x', agent: 'no-such-agent' }] }, /cannot be used as a helper/);
  await bad({ helpers: [{ role: 'Review', agent: 'opencode' }, { role: 'review', agent: 'pi-acp' }] }, /two helpers/);
  await bad({ helpers: [{ role: '!!!', agent: 'opencode' }] }, /letters or digits/);
  await bad({ mcp: [mine] }, /not yours or the team's/); // user A's private server
  const teamMcp = (await admin.trpc('assistants.save', { ...asst, name: 'Team one', scope: 'team', mcp: [mine] }, true));
  assert.equal(teamMcp.status, 400, 'a team Assistant cannot name a private server');
});

test('skills: create, preview without raw frontmatter, share needs skills.share, team skills reach everyone, the switch is per person', async () => {
  const made = await worker.trpc('skills.save', { name: 'tone', description: 'Formal tone', instructions: 'Write formally.\n\n- no slang', files: [{ path: 'refs/a.md', content: 'A' }] }, true);
  assert.equal(made.status, 200, made.error ?? '');
  const id = made.json.id as string;
  const detail = (await worker.trpc('skills.get', { id })).json;
  assert.deepEqual([detail.meta.name, detail.meta.description, detail.body.startsWith('---'), detail.files.map((f: any) => f.path)], ['tone', 'Formal tone', false, ['refs/a.md']]);
  assert.equal((await w2.trpc('skills.list')).json.length, 0, 'private until shared');
  assert.equal((await worker.trpc('skills.share', { id }, true)).status, 403, 'a worker does not hold skills.share by default');
  const shared = await admin.trpc('skills.save', { name: 'house-style', description: 'House style', instructions: 'Use the house style.' }, true);
  assert.equal((await admin.trpc('skills.share', { id: shared.json.id }, true)).json.visibility, 'team');
  const seen2 = (await w2.trpc('skills.list')).json;
  assert.deepEqual(seen2.map((s: any) => [s.name, s.mine, s.shared, s.on]), [['house-style', false, true, true]]);
  assert.deepEqual(sessionSkills(w2.id).map((s) => s.name), ['house-style']);
  assert.deepEqual(sessionSkills(w2.id)[0]!.files['SKILL.md']!.startsWith('---\nname: "house-style"'), true);
  assert.equal((await w2.trpc('skills.setOn', { id: shared.json.id, on: false }, true)).status, 200);
  assert.deepEqual(sessionSkills(w2.id), [], 'switched off for this person');
  assert.deepEqual(sessionSkills(admin.id).map((s) => s.name), ['house-style'], 'on for everyone else');
  assert.deepEqual(sessionSkills(w2.id, [shared.json.id]).map((s) => s.name), ['house-style'], 'an Assistant names its skills: the switch does not apply');
  assert.deepEqual(sessionSkills(w2.id, [id]), [], 'someone else\'s private skill is never given');
  assert.deepEqual(sessionSkills(worker.id, [id]).map((s) => [s.name, Object.keys(s.files).sort()]), [['tone', ['SKILL.md', 'refs/a.md']]]);
  assert.equal((await admin.trpc('skills.unshare', { id: shared.json.id }, true)).json.visibility, 'private');
  assert.equal((await w2.trpc('skills.list')).json.length, 0);
  // a private Assistant may now use the worker's own skill
  assert.equal((await worker.trpc('assistants.save', { ...asst, name: 'With skill', skills: [id] }, true)).status, 200);
  assert.equal((await w2.trpc('assistants.save', { ...asst, name: 'Stolen', skills: [id] }, true)).status, 400);
});
