import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { HttpError, parseInstall } from '../services/runner/src/logic.ts';
import { trpcCall } from './trpc.ts';

// Agent profiles, the ACP Registry catalog, install validation, roles and the `agents` / `cliAgents` routers, without Docker: a recording stand-in for the
// runner's agent endpoints and for the registry. The real install (installer container, sha256, volume) is test/cli-agent-install.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cliagents-'));
process.env.HEFYN_SECRET = 'cli-agents-secret-cli-agents-secret-123';
process.env.HEFYN_INTERNAL_TOKEN = 'cli-agents-token-cli-agents-token-0123456789';

const { PROFILES, acpLaunch, canonicalAgent, profileOf, terminalLaunch, wrapperLaunch } = await import('../src/cli-agents/profiles.ts');
const { bundledRegistry, parseRegistry } = await import('../src/cli-agents/registry.ts');
const inst = await import('../src/cli-agents/installed.ts');
const { mcpServerSeeds } = await import('../src/cli-agents/manifest-profile.ts');
const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');

vault.setTeamKey(vault.newKey());
const snap = bundledRegistry();
const entry = (id: string) => structuredClone(snap.find((a) => a.id === id)!);

// ---------- profiles ----------
test('profiles: one per supported registry id, each pointed at the model bridge with a dummy key', () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ['claude-acp', 'codex-acp', 'opencode', 'pi-acp']);
  assert.deepEqual(Object.values(PROFILES).map((p) => [p.registryId, p.api]).sort(), [['claude-acp', 'anthropic'], ['codex-acp', 'openai-responses'], ['opencode', 'anthropic'], ['pi-acp', 'anthropic']]);
  assert.equal(profileOf('constructor'), undefined); // a table lookup, not a prototype one
  assert.equal(canonicalAgent('claude-code'), 'claude-acp'); assert.equal(canonicalAgent('opencode'), 'opencode');
  for (const p of Object.values(PROFILES)) {
    for (const l of [acpLaunch(p, '9.9.9'), terminalLaunch(p, '9.9.9', null, 'dark')]) {
      assert.equal(l.cmd[0], '/opt/hefyn/run-agent.sh');
      assert.ok(Object.values(l.env).every((v) => typeof v === 'string' && v.length < 32_000));
      const seeds = JSON.parse(l.env.HEFYN_SEED) as { path: string }[];
      assert.ok(seeds.length && seeds.every((s) => s.path.startsWith('/tmp/') && !s.path.includes('..')), 'config lives under /tmp, which is persisted per conversation');
      assert.ok(!JSON.stringify(l).includes('sk-'), 'no real key anywhere');
    }
    assert.ok(p.configDir.startsWith('/tmp/') && p.skillsDir.startsWith('/tmp/') && p.instructionsFile);
  }
});

test('profiles: claude-acp (Claude Code, the official package in a PTY: no ACP adapter)', () => {
  const UUID = '11111111-2222-3333-4444-555555555555', p = profileOf('claude-acp')!, a = wrapperLaunch(p, '2.1.310', UUID, 'light');
  assert.equal(p.wrapper, 'claude-code'); assert.equal(p.npm!.package, '@anthropic-ai/claude-code');
  assert.deepEqual(a.cmd.slice(0, 3), ['/opt/hefyn/run-agent.sh', 'sh', '-c']);
  assert.match(a.cmd[3]!, /\/opt\/agents\/claude-acp\/2\.1\.310\/node_modules\/@anthropic-ai\/claude-code-linux-\*\/claude/); // the platform binary of the unmodified package
  assert.match(a.cmd[3]!, /--resume 11111111-2222-3333-4444-555555555555; else exec "\$bin" --session-id 11111111-2222-3333-4444-555555555555/);
  assert.doesNotMatch(a.cmd[3]!, /claude-agent/);
  assert.equal(a.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47000'); assert.equal(a.env.ANTHROPIC_API_KEY, 'hefyn-gateway');
  assert.equal(a.env.TERM, 'xterm-256color'); assert.equal(a.env.COLORTERM, 'truecolor'); // xterm.js does truecolor; without it the prompt bar is inverse video
  assert.equal(terminalLaunch(p, '2.1.310', null).env.COLORTERM, 'truecolor');
  for (const k of ['DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_INSTALLATION_CHECKS']) assert.equal(a.env[k], '1');
  assert.equal(a.env.CLAUDE_CONFIG_DIR, '/tmp/.claude');
  const seeds = JSON.parse(a.env.HEFYN_SEED);
  assert.deepEqual(seeds[0].json.customApiKeyResponses, { approved: ['hefyn-gateway'] }); assert.equal(seeds[0].json.theme, 'light'); assert.equal(seeds[0].json.hasSeenAutoDefaultNudge, true); // no "make auto mode your default" dialog over the chat's paste
  assert.deepEqual(seeds[1], { path: '/tmp/.claude/.claude.json', json: { theme: 'dark' }, force: false });
  assert.deepEqual(seeds[2], { path: '/tmp/.claude/settings.json', json: { permissions: { defaultMode: 'default' } }, force: false }); // asks before acting
  assert.throws(() => wrapperLaunch(p, '2.1.310', 'not-a-uuid; rm -rf /'), /invalid session id/); // the shell only ever sees a uuid
});

test('profiles: codex-acp points a model_providers entry at /v1/responses on the bridge', () => {
  const l = acpLaunch(profileOf('codex-acp')!, '2.2.2'), toml = JSON.parse(l.env.HEFYN_SEED)[0].text as string;
  assert.equal(l.env.CODEX_HOME, '/tmp/.codex'); assert.equal(l.env.HEFYN_GATEWAY_KEY, 'hefyn-gateway');
  for (const line of ['model_provider = "hefyn"', '[model_providers.hefyn]', 'base_url = "http://127.0.0.1:47000/v1"', 'wire_api = "responses"', 'env_key = "HEFYN_GATEWAY_KEY"', 'web_search = "disabled"', 'check_for_update_on_startup = false']) assert.ok(toml.includes(line), line);
  assert.match(terminalLaunch(profileOf('codex-acp')!, '2.2.2', null).cmd.at(-1)!, /^exec \/opt\/agents\/codex-acp\/2\.2\.2\/node_modules\/\.bin\/codex --no-daemon$/);
  // asks for what no rule allows: codex-acp gets "untrusted" from the shim, the terminal from config (granular); the allowlist is a rules file
  assert.equal(l.env.CODEX_PATH, '/opt/hefyn/codex-shim.mjs'); assert.equal(l.env.CODEX_REAL, '/opt/agents/codex-acp/2.2.2/node_modules/.bin/codex'); assert.equal(l.env.INITIAL_AGENT_MODE, undefined);
  assert.ok(toml.includes('sandbox_mode = "danger-full-access"') && toml.includes('granular'));
  const rules = JSON.parse(l.env.HEFYN_SEED)[1]; assert.equal(rules.path, '/tmp/.codex/rules/default.rules'); assert.match(rules.text, /pattern=\[\["ls","cat"/);
});

test('profiles: opencode (binary) gets opencode.json with the anthropic baseURL on the bridge', () => {
  const p = profileOf('opencode')!, l = acpLaunch(p, '1.19.4'), seeds = JSON.parse(l.env.HEFYN_SEED), cfg = { ...JSON.parse(seeds[0].text), ...seeds[1].json }; // the common file, then the provider's block merged into it
  assert.deepEqual(l.cmd, ['/opt/hefyn/run-agent.sh', '/opt/agents/opencode/1.19.4/opencode', 'acp']);
  assert.equal(cfg.provider.anthropic.options.baseURL, 'http://127.0.0.1:47000/v1'); assert.equal(cfg.autoupdate, false); assert.equal(cfg.share, 'disabled');
  assert.equal(l.env.XDG_CONFIG_HOME, '/tmp/.config');
  assert.match(terminalLaunch(p, '1.19.4', 'ses_abc123').cmd.at(-1)!, /--session ses_abc123/);
});

test('profiles: pi-acp installs pi next to it and writes models.json with baseUrl', () => {
  const p = profileOf('pi-acp')!, l = acpLaunch(p, '0.0.34');
  assert.deepEqual(JSON.parse(l.env.HEFYN_SEED).find((s: any) => s.path.endsWith('models.json')), { path: '/tmp/.pi/agent/models.json', json: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:47000' } } }, force: true });
  assert.equal(l.env.PI_ACP_PI_COMMAND, '/opt/agents/pi-acp/0.0.34/node_modules/.bin/pi'); assert.equal(l.env.PI_CODING_AGENT_DIR, '/tmp/.pi/agent');
  assert.equal(l.env.PI_OFFLINE, '1'); assert.equal(l.env.PI_TELEMETRY, '0');
  assert.match(p.npm!.extra![0], /^@earendil-works\/pi-coding-agent@\d+\.\d+\.\d+$/);
});

test('seed.mjs: text files replace, JSON merges (the seed wins only when forced), and nothing outside /tmp is written', () => {
  const dir = `/tmp/hefyn-seedtest-${Math.random().toString(36).slice(2)}`;
  const seed = (list: unknown[]) => spawnSync('node', ['services/sandbox-image/seed.mjs'], { env: { ...process.env, HEFYN_SEED: JSON.stringify(list) }, encoding: 'utf8' });
  try {
    mkdirSync(`${dir}/.claude`, { recursive: true });
    writeFileSync(`${dir}/.claude/.claude.json`, JSON.stringify({ theme: 'light', mine: { a: 1 }, projects: { '/x': { y: 1 } } }));
    const SID = '11111111-2222-3333-4444-555555555555';
    const claude = JSON.parse(wrapperLaunch(profileOf('claude-acp')!, '2.1.310', SID).env.HEFYN_SEED).map((s: any) => ({ ...s, path: s.path.replace('/tmp/.claude', `${dir}/.claude`) }));
    assert.equal(seed(claude).status, 0);
    const j = JSON.parse(readFileSync(`${dir}/.claude/.claude.json`, 'utf8'));
    assert.equal(j.theme, 'light', 'the user\'s choice stays when the browser sent none'); assert.equal(j.mine.a, 1); assert.equal(j.hasCompletedOnboarding, true);
    assert.deepEqual(j.projects, { '/x': { y: 1 }, '/files': { hasTrustDialogAccepted: true } });
    const forced = JSON.parse(wrapperLaunch(profileOf('claude-acp')!, '2.1.310', SID, 'dark').env.HEFYN_SEED).map((s: any) => ({ ...s, path: s.path.replace('/tmp/.claude', `${dir}/.claude`) }));
    assert.equal(seed(forced).status, 0);
    assert.equal(JSON.parse(readFileSync(`${dir}/.claude/.claude.json`, 'utf8')).theme, 'dark');
    assert.equal(seed([{ path: `${dir}/c/config.toml`, text: 'a = 1\n' }]).status, 0); assert.equal(readFileSync(`${dir}/c/config.toml`, 'utf8'), 'a = 1\n');
    for (const bad of ['/etc/hefyn-seed-test', '/tmp/../etc/hefyn-seed-test']) { assert.notEqual(seed([{ path: bad, text: 'x' }]).status, 0, bad); assert.ok(!existsSync('/etc/hefyn-seed-test')); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP servers: one seed owns its entries; a server no longer chosen is removed, the user\'s own and the retired "hefyn" one are handled right', () => {
  const dir = `/tmp/hefyn-mcpown-${Math.random().toString(36).slice(2)}`, f = `${dir}/.claude.json`;
  const seed = (list: unknown[]) => assert.equal(spawnSync('node', ['services/sandbox-image/seed.mjs'], { env: { ...process.env, HEFYN_SEED: JSON.stringify(list) }, encoding: 'utf8' }).status, 0);
  const plan = (names: string[]) => mcpServerSeeds(profileOf('claude-acp')!.spec, names.map((name) => ({ name, url: `http://127.0.0.1:47000/mcp/${name}` }))).map((s) => ({ ...s, path: f }));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, JSON.stringify({ mcpServers: { hefyn: { type: 'http', url: 'http://x/mcp' }, mine: { type: 'stdio', command: 'x' } } }));
    seed(plan(['a_1', 'b_2']));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers).sort(), ['a_1', 'b_2', 'mine'], 'the retired hefyn server is gone, the user\'s own stays');
    seed(plan(['b_2']));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers).sort(), ['b_2', 'mine']);
    seed(plan([]));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers), ['mine'], 'none chosen: everything hefyn wrote is removed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- registry + install requests ----------
test('registry: malformed entries are dropped; the bundled snapshot lists the four supported agents', () => {
  assert.deepEqual(snap.map((a) => a.id).sort(), ['claude-acp', 'codex-acp', 'opencode', 'pi-acp']);
  assert.deepEqual(parseRegistry({ agents: [{ id: 'a', name: 'A', version: '1', distribution: { npx: { package: 'a@1.0.0' } } }, { id: 'b' }, null, 5, { id: 'c', name: 'C', version: '1' }] }).map((a) => a.id), ['a']);
  assert.throws(() => parseRegistry({}), /registry/);
});

test('registry: OpenCode 2.x from the live registry is replaced by the bundled 1.x (not supported yet)', async () => {
  const { registry, resetRegistryCache } = await import('../src/cli-agents/registry.ts');
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: any) => /registry\.json/.test(String(u)) ? Response.json({ agents: [{ id: 'opencode', name: 'OpenCode', version: '2.2.0', description: 'x', distribution: { binary: {} } }] }) : new Response('', { status: 404 })) as typeof fetch;
  try {
    resetRegistryCache();
    const c = await registry();
    assert.equal(c.source, 'live');
    assert.equal(c.agents.find((a) => a.id === 'opencode')!.version, bundledRegistry().find((a) => a.id === 'opencode')!.version);
  } finally { globalThis.fetch = real; resetRegistryCache(); }
});

test('install request: pinned from the registry entry, refused when the entry no longer matches the profile', () => {
  const claude = inst.installRequest(entry('claude-acp'), profileOf('claude-acp')!);
  assert.deepEqual(claude, { id: 'claude-acp', version: '2.1.310', check: ['node_modules/.bin/claude', 'node_modules/@anthropic-ai/claude-code/package.json'], distribution: { npx: { package: '@anthropic-ai/claude-code@2.1.310', extra: [] } } });
  assert.deepEqual(inst.installRequest(entry('pi-acp'), profileOf('pi-acp')!).distribution, { npx: { package: 'pi-acp@0.0.34', extra: ['@earendil-works/pi-coding-agent@1.4.0'] } });
  const oc = inst.installRequest(entry('opencode'), profileOf('opencode')!) as any;
  assert.deepEqual(Object.keys(oc.distribution.binary).sort(), ['linux-aarch64', 'linux-x86_64']);
  const other = entry('claude-acp'); other.distribution.npx!.package = '@evil/claude-code@2.1.310';
  assert.throws(() => inst.installRequest(other, profileOf('claude-acp')!), (e: any) => e.status === 409 && /changed how/.test(e.message));
  const args = entry('claude-acp'); args.distribution.npx!.args = ['--do-something'];
  assert.throws(() => inst.installRequest(args, profileOf('claude-acp')!), (e: any) => e.status === 409);
  const swapped = entry('claude-acp'); swapped.distribution = entry('opencode').distribution;
  assert.throws(() => inst.installRequest(swapped, profileOf('claude-acp')!), (e: any) => e.status === 409);
  const cmd = entry('opencode'); cmd.distribution.binary!['linux-x86_64'].cmd = './sh';
  assert.throws(() => inst.installRequest(cmd, profileOf('opencode')!), (e: any) => e.status === 409);
  const none = entry('opencode'); none.distribution.binary = { 'darwin-aarch64': none.distribution.binary!['linux-aarch64'] };
  assert.throws(() => inst.installRequest(none, profileOf('opencode')!), /no download for Linux/);
});

test('runner: install requests are validated before any container exists', () => {
  const sha = 'a'.repeat(64), bin = (o: object = {}) => ({ id: 'opencode', version: '1.19.4', distribution: { binary: { 'linux-x86_64': { archive: 'https://github.com/x/y/releases/download/v1/o.tar.gz', sha256: sha, cmd: './opencode', ...o } } } });
  const npx = (o: object = {}) => ({ id: 'claude-acp', version: '2.1.310', distribution: { npx: { package: '@anthropic-ai/claude-code@2.1.310', ...o } } });
  assert.equal(parseInstall(npx()).npm!.package, '@anthropic-ai/claude-code@2.1.310');
  assert.equal(parseInstall(bin()).binary!['linux-x86_64'].sha256, sha);
  assert.deepEqual(Object.keys(parseInstall({ ...bin(), distribution: { binary: { ...bin().distribution.binary, 'darwin-aarch64': { archive: 'https://x/y.zip', sha256: sha, cmd: './o' } } } }).binary!), ['linux-x86_64'], 'other platforms are dropped');
  const bad = (b: unknown, re: RegExp) => assert.throws(() => parseInstall(b), (e: any) => e instanceof HttpError && e.status === 400 && re.test(e.message), JSON.stringify(b));
  bad(null, /body/); bad({}, /agent id/);
  bad({ ...npx(), id: '../x' }, /agent id/); bad({ ...npx(), id: 'A_B' }, /agent id/); bad({ ...npx(), version: '1/../2' }, /version/); bad({ ...npx(), version: '' }, /version/);
  bad({ ...npx(), distribution: {} }, /exactly one/); bad({ ...npx(), distribution: { npx: {}, binary: {} } }, /exactly one/);
  for (const p of ['pkg', 'pkg@^1.0.0', 'pkg@latest', 'pkg@1', 'pkg@https://evil/x.tgz', 'git+https://evil/x@1.0.0', '../pkg@1.0.0', 'pkg@1.0.0 --registry=http://evil']) bad(npx({ package: p }), /pinned/);
  bad(npx({ extra: ['pkg@latest'] }), /pinned/); bad({ ...npx(), check: ['../etc/passwd'] }, /check/); bad({ ...npx(), check: ['/etc/passwd'] }, /check/);
  bad(bin({ sha256: undefined }), /sha256/); bad(bin({ sha256: 'ABC' }), /sha256/); bad(bin({ sha256: 'a'.repeat(63) }), /sha256/);
  bad(bin({ archive: 'http://github.com/x.tar.gz' }), /https/); bad(bin({ archive: 'https://user:pw@github.com/x.tar.gz' }), /https/); bad(bin({ archive: 'file:///etc/passwd' }), /https/); bad(bin({ archive: 'nonsense' }), /https/);
  bad(bin({ cmd: '../../bin/sh' }), /cmd/); bad(bin({ cmd: '/bin/sh' }), /cmd/); bad(bin({ cmd: 'opencode' }), /cmd/);
  bad({ id: 'x', version: '1', distribution: { binary: { 'darwin-aarch64': { archive: 'https://x/y.zip', sha256: sha, cmd: './o' } } } }, /no Linux/);
});

// ---------- catalog, roles, legacy ids ----------
test('catalog: registry entries merged with install state; supported first; update offered only for a ready, older install', () => {
  const extra = { id: 'zed-x', name: 'Zed X', version: '1.0.0', description: 'd', distribution: { npx: { package: 'zed-x@1.0.0' } } };
  const rows = [
    { id: 'claude-acp', version: '0.90.0', status: 'ready', error: null, enabled: 1, roles: '["worker"]', key_provider: 'anthropic', installed_at: 'x' },
    { id: 'opencode', version: '1.19.4', status: 'failed', error: 'sha mismatch', enabled: 0, roles: '[]', key_provider: null, installed_at: null },
  ] as any[];
  const c = inst.mergeCatalog([extra as any, ...snap], rows);
  assert.deepEqual(c.map((x) => x.id), ['claude-acp', 'codex-acp', 'opencode', 'pi-acp'], 'only agents with a module, by name: the registry\'s other entries are not listed');
  const claude = c[0];
  assert.deepEqual([claude.source, claude.api, claude.installed, claude.enabled, claude.roles, claude.keyProvider, claude.updateAvailable], [{ type: 'builtin' }, 'anthropic', { version: '0.90.0', status: 'ready' }, true, ['worker'], 'anthropic', '2.1.310']);
  assert.deepEqual(c.find((x) => x.id === 'opencode')!.installed, { version: '1.19.4', status: 'failed', error: 'sha mismatch' });
  assert.equal(c.find((x) => x.id === 'opencode')!.updateAvailable, null);
  assert.deepEqual(c.slice(0, 4).map((x) => [x.name, x.description]), [['Claude Code', 'Anthropic\'s coding agent.'], ['Codex', 'OpenAI\'s coding agent.'], ['OpenCode', 'Open-source coding agent that works with many models.'], ['Pi', 'A small, fast open-source coding agent.']]);
  assert.equal(claude.registryName, 'Claude Code');
  assert.deepEqual(c.map((x) => [x.id, x.actsWithoutAsking]), [['claude-acp', false], ['codex-acp', false], ['opencode', false], ['pi-acp', true]], 'only Pi acts without asking');
  assert.deepEqual(Object.keys(claude).sort(), ['actsWithoutAsking', 'adapterVersion', 'api', 'autoUpdate', 'defaultModel', 'defaultProvider', 'description', 'enabled', 'icon', 'id', 'installed', 'keyProvider', 'lastChecked', 'lastUpdateError', 'license', 'licenseUrl', 'name', 'registryName', 'roles', 'source', 'updateAvailable', 'updating', 'version']);
});

test('roles: an agent lists the roles that may use it; an empty list is every role', () => {
  assert.ok(inst.roleMayUse({ roles: '[]' }, 'any')); assert.ok(inst.roleMayUse({ roles: '[]' }, undefined));
  assert.ok(inst.roleMayUse({ roles: '["r1","r2"]' }, 'r2')); assert.ok(!inst.roleMayUse({ roles: '["r1"]' }, 'r2')); assert.ok(!inst.roleMayUse({ roles: '["r1"]' }, undefined));
  assert.ok(!inst.roleMayUse({ roles: 'not json' }, 'r1')); // unreadable: closed, not open
  db.prepare('DELETE FROM cli_agents').run();
  const add = (id: string, status: string, enabled: number, roles: string) => db.prepare('INSERT INTO cli_agents (id, version, status, enabled, roles) VALUES (?,?,?,?,?)').run(id, '1', status, enabled, roles);
  add('claude-acp', 'ready', 1, '["worker"]'); add('opencode', 'ready', 1, '[]'); add('pi-acp', 'installing', 1, '[]'); add('codex-acp', 'ready', 0, '[]'); add('not-supported', 'ready', 1, '[]');
  assert.deepEqual(inst.usableAgents('worker').map((r) => r.id).sort(), ['claude-acp', 'opencode']);
  assert.deepEqual(inst.usableAgents('admin').map((r) => r.id), ['opencode']);
  assert.deepEqual(inst.usableAgents(undefined).map((r) => r.id), ['opencode']);
});

test('legacy: conversations that say `claude-code` run the installed claude-acp', () => {
  db.prepare('DELETE FROM cli_agents').run();
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles) VALUES ('claude-acp', '2.1.310', 'ready', 1, '[]')").run();
  const l = inst.launchable('nobody', 'claude-code');
  assert.ok(!('reason' in l)); assert.equal((l as any).row.id, 'claude-acp'); assert.equal((l as any).profile.name, 'Claude Code');
  db.prepare("UPDATE cli_agents SET enabled = 0 WHERE id = 'claude-acp'").run();
  assert.match((inst.launchable('nobody', 'claude-code') as any).reason, /not available to you/);
  db.prepare('DELETE FROM cli_agents').run();
  assert.match((inst.launchable('nobody', 'claude-code') as any).reason, /not installed/);
  assert.match((inst.launchable('nobody', 'something-else') as any).reason, /not installed/);
});

// ---------- the routers, with a recording stand-in for the runner and the registry ----------
const runnerCalls: { method: string; path: string; body?: any }[] = [];
let runnerState: { state: string; error?: string } = { state: 'installing' };
const fakeRunner = Bun.serve({ port: 0, async fetch(req: Request) {
  const u = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
  assert.equal(req.headers.get('x-hefyn-internal'), process.env.HEFYN_INTERNAL_TOKEN);
  runnerCalls.push({ method: req.method, path: u.pathname, body });
  if (u.pathname === '/agents/install') return Response.json({ state: 'installing' });
  if (req.method === 'GET') return Response.json(runnerState);
  return Response.json({ ok: true });
} });
const extra = { id: 'zed-x', name: 'Zed X', version: '1.0.0', description: 'd', distribution: { npx: { package: 'zed-x@1.0.0' } } };
const fakeRegistry = Bun.serve({ port: 0, fetch: () => Response.json({ version: '1.0.0', agents: [extra, ...snap] }) });
process.env.HEFYN_RUNNER_URL = `http://127.0.0.1:${fakeRunner.port}`;
process.env.HEFYN_ACP_REGISTRY_URL = `http://127.0.0.1:${fakeRegistry.port}/registry.json`;
test.after(() => { fakeRunner.stop(true); fakeRegistry.stop(true); });

const web = new Hono().route('/api', api);
const PW = 'password-12345';
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => web.request(p, i), cookie, proc, input, mutate) };
}

test('agents router: catalog, install (async, polled), update validation, uninstall; admin only', async () => {
  db.prepare('DELETE FROM cli_agents').run();
  const boss = await mk('boss@agents.test', 'admin'), worker = await mk('worker@agents.test', 'worker');
  assert.equal((await worker.trpc('agents.catalog')).status, 403);
  assert.equal((await worker.trpc('agents.install', { id: 'claude-acp' }, true)).status, 403);

  let cat = (await boss.trpc('agents.catalog')).json as any[];
  assert.deepEqual(cat.map((a) => a.id), ['claude-acp', 'codex-acp', 'opencode', 'pi-acp'], 'no "not supported yet" entries');
  assert.ok(cat.every((a) => a.installed === null && a.enabled === false && a.keyProvider === null));

  assert.equal((await boss.trpc('agents.install', { id: 'zed-x' }, true)).status, 400, 'no module: not available');
  assert.equal((await boss.trpc('agents.install', { id: 'nope' }, true)).status, 400);
  assert.equal((await boss.trpc('agents.update', { id: 'claude-acp', enabled: true }, true)).status, 404, 'not installed');
  assert.equal((await boss.trpc('agents.uninstall', { id: 'claude-acp' }, true)).status, 404);

  assert.deepEqual((await boss.trpc('agents.install', { id: 'claude-acp' }, true)).json, { ok: true });
  const sent = runnerCalls.find((c) => c.path === '/agents/install')!;
  assert.deepEqual(sent.body, { id: 'claude-acp', version: '2.1.310', check: ['node_modules/.bin/claude', 'node_modules/@anthropic-ai/claude-code/package.json'], distribution: { npx: { package: '@anthropic-ai/claude-code@2.1.310', extra: [] } } });
  cat = (await boss.trpc('agents.catalog')).json;
  assert.deepEqual(cat.find((a) => a.id === 'claude-acp').installed, { version: '2.1.310', status: 'installing' });
  assert.equal((await boss.trpc('agents.update', { id: 'claude-acp', enabled: true }, true)).status, 409, 'cannot be turned on before it is ready');

  runnerState = { state: 'ready' };
  cat = (await boss.trpc('agents.catalog')).json;
  assert.deepEqual(cat.find((a) => a.id === 'claude-acp').installed, { version: '2.1.310', status: 'ready' });
  assert.equal(cat.find((a) => a.id === 'claude-acp').updateAvailable, null);

  const bad = (b: object) => boss.trpc('agents.update', { id: 'claude-acp', ...b }, true);
  assert.equal((await bad({ roles: ['no-such-role'] })).status, 400);
  assert.equal((await bad({ keyProvider: 'openai' })).status, 400, 'a Claude agent cannot use an OpenAI key');
  assert.equal((await bad({ keyProvider: 'anthropic', roles: ['worker'], enabled: true })).status, 200);
  cat = (await boss.trpc('agents.catalog')).json;
  const c = cat.find((a) => a.id === 'claude-acp');
  assert.deepEqual([c.enabled, c.roles, c.keyProvider], [true, ['worker'], 'anthropic']);

  // cliAgents.list: only roles that may use it (the admin role is not listed in `roles`)
  assert.deepEqual((await boss.trpc('cliAgents.list')).json, []);
  assert.deepEqual(((await worker.trpc('cliAgents.list')).json as any[]).map((a) => [a.id, a.name, a.available]), [['claude-acp', 'Claude Code', false]]);
  assert.equal((await bad({ roles: [], keyProvider: null })).status, 200);
  const l = (await boss.trpc('cliAgents.list')).json as any[];
  assert.deepEqual(l.map((a) => a.id), ['claude-acp']); assert.equal(typeof l[0].reason, 'string'); assert.ok('icon' in l[0]);
  assert.equal((await boss.trpc('agents.catalog')).json.find((a: any) => a.id === 'claude-acp').keyProvider, null);

  // failed installs say why in plain words; a runner that lost the job means it did not finish
  runnerCalls.length = 0;
  db.prepare("UPDATE cli_agents SET status = 'installing' WHERE id = 'claude-acp'").run();
  runnerState = { state: 'failed', error: 'the download does not match the checksum' };
  assert.deepEqual((await boss.trpc('agents.catalog')).json.find((a: any) => a.id === 'claude-acp').installed, { version: '2.1.310', status: 'failed', error: 'the download does not match the checksum' });
  db.prepare("UPDATE cli_agents SET status = 'installing' WHERE id = 'claude-acp'").run();
  runnerState = { state: 'none' };
  assert.match((await boss.trpc('agents.catalog')).json.find((a: any) => a.id === 'claude-acp').installed.error, /did not finish/);
  assert.deepEqual((await boss.trpc('cliAgents.list')).json, [], 'failed = not offered');

  // a newer registry version is an update; the old files are removed once the new ones are ready
  db.prepare("UPDATE cli_agents SET status = 'ready', version = '0.90.0' WHERE id = 'claude-acp'").run();
  assert.equal((await boss.trpc('agents.catalog')).json.find((a: any) => a.id === 'claude-acp').updateAvailable, '2.1.310');
  runnerState = { state: 'installing' }; runnerCalls.length = 0;
  await boss.trpc('agents.install', { id: 'claude-acp' }, true);
  runnerState = { state: 'ready' };
  await boss.trpc('agents.catalog');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(runnerCalls.some((x) => x.method === 'DELETE' && x.path === '/agents/claude-acp/0.90.0'), JSON.stringify(runnerCalls));
  assert.equal(rowOfVersion(), '2.1.310');

  runnerCalls.length = 0;
  assert.deepEqual((await boss.trpc('agents.uninstall', { id: 'claude-acp' }, true)).json, { ok: true });
  assert.deepEqual(runnerCalls.map((x) => [x.method, x.path]), [['DELETE', '/agents/claude-acp/2.1.310']]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cli_agents').get()!.n, 0);
});
const rowOfVersion = () => (db.prepare("SELECT version FROM cli_agents WHERE id = 'claude-acp'").get() as any).version;

test('subscription sign-ins: new ones are refused; existing ones are reported deprecated', async () => {
  const { connect } = await import('../src/server/providers.ts');
  vault.rememberUserKey('x', vault.newKey());
  const boss = await mk('boss2@agents.test', 'admin');
  const r = await boss.trpc('connectors.oauth.start', { provider: 'anthropic' }, true);
  assert.equal(r.status, 403); assert.match(r.error!, /no longer offered/);
  assert.equal((await boss.trpc('connectors.oauth.start', { provider: 'openai', scope: 'company' }, true)).status, 403);
  const prov = (await boss.trpc('connectors.models.providers')).json;
  assert.ok(prov.oauth.length > 0 && prov.oauth.every((p: any) => p.deprecated === true));
  assert.ok(prov.apiKey.every((p: any) => p.deprecated === undefined));
  connect({ id: 'anthropic' }, 'sk-ant-x');
  assert.deepEqual(((await boss.trpc('models.providers')).json.connected as any[]).map((c) => [c.id, c.kind, c.deprecated]), [['anthropic', 'api_key', false]]);
  db.prepare("UPDATE providers SET kind = 'oauth' WHERE id = 'anthropic'").run();
  assert.equal((await boss.trpc('models.providers')).json.connected[0].deprecated, true);
});

test('key provider: an agent pinned to a key uses the company connection and ignores the user\'s own; automatic keeps the user\'s own first', async () => {
  const { keyPolicy, anthropicUpstream, openaiUpstream, anthropicProblem } = await import('../src/cli-agents/access.ts');
  const { connect } = await import('../src/server/providers.ts');
  const { connectApiKey } = await import('../src/server/connectors.ts');
  vault.rememberUserKey('kate', vault.newKey());
  connect({ id: 'anthropic' }, 'sk-ant-company'); connect({ id: 'openai' }, 'sk-oai-company');
  connectApiKey('kate', { id: 'anthropic' }, 'sk-ant-kate'); connectApiKey('kate', { id: 'openai' }, 'sk-oai-kate');
  assert.equal((await anthropicUpstream('kate')).key, 'sk-ant-kate');
  assert.equal((await keyPolicy.run({ provider: null }, () => anthropicUpstream('kate'))).key, 'sk-ant-kate');
  assert.equal((await keyPolicy.run({ provider: 'anthropic' }, () => anthropicUpstream('kate'))).key, 'sk-ant-company');
  assert.equal((await keyPolicy.run({ provider: 'openai' }, () => openaiUpstream('kate'))).key, 'sk-oai-company');
  assert.equal((await keyPolicy.run({ provider: 'openai' }, () => anthropicUpstream('kate'))).key, 'sk-ant-kate', 'a pin on another provider does not touch this one');
  // pinned and no company key: refused, even though the user has their own
  db.prepare("DELETE FROM providers WHERE id = 'anthropic'").run();
  assert.equal(await anthropicProblem('kate'), undefined);
  assert.match((await keyPolicy.run({ provider: 'anthropic' }, () => anthropicProblem('kate')))!, /No Anthropic API key/);
  // still API keys only: a company sign-in is refused when pinned
  connect({ id: 'anthropic' }, 'sk-ant-company'); db.prepare("UPDATE providers SET kind = 'oauth' WHERE id = 'anthropic'").run();
  await assert.rejects(keyPolicy.run({ provider: 'anthropic' }, () => anthropicUpstream('kate')), /subscription/);
});
