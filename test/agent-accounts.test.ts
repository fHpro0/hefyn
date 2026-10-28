import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';

// Agent accounts without Docker: the login block of each manifest (output and status parsing), the account modes, team accounts and their permission rules, and the
// sign-in host against a stand-in process. No real login, no real model API.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-accts-'));
process.env.HEFYN_SECRET = 'agent-accounts-secret-agent-accounts-123456';

const { db } = await import('../src/server/appdb.ts');
const login = await import('../src/cli-agents/agent-login.ts');
const team = await import('../src/cli-agents/team-accounts.ts');
const { AccountHost } = await import('../src/cli-agents/account.ts');
const { profileOf } = await import('../src/cli-agents/profiles.ts');
const { teamLaunch } = await import('../src/cli-agents/own-account.ts');
const { wrapperLaunch } = await import('../src/cli-agents/profiles.ts');

const spec = (id: string) => profileOf(id)!.spec.login!;

test('every built-in agent has a login block; sharing is forbidden for Claude Code and Codex, allowed for OpenCode and Pi', () => {
  for (const id of ['claude-acp', 'codex-acp', 'opencode', 'pi-acp']) assert.ok(profileOf(id)!.spec.login, id);
  assert.deepEqual(['claude-acp', 'codex-acp', 'opencode', 'pi-acp'].map((id) => profileOf(id)!.spec.sharedLogin), [false, false, true, true]);
  assert.deepEqual(['claude-acp', 'codex-acp', 'opencode', 'pi-acp'].map((id) => spec(id).flow), ['code', 'device', 'terminal', 'terminal']);
  assert.equal(spec('claude-acp').verified, true);
  assert.equal(login.homeOf(profileOf('claude-acp')!, 'personal'), '/claude-home');
  assert.equal(login.homeOf(profileOf('codex-acp')!, 'personal'), '/accounts/codex-acp');
  assert.equal(login.homeOf(profileOf('codex-acp')!, 'team'), '/team-accounts/codex-acp');
});

test('login output: the first https address, a device code, colours and a trailing full stop ignored', () => {
  const claude = '\x1b[2mOpening browser to sign in…\x1b[0m\r\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz.\r\nPaste code here if prompted > ';
  assert.deepEqual(login.parseLoginOutput(spec('claude-acp'), claude), { url: 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz' });
  const codex = 'Follow these steps to sign in with ChatGPT using device code authorization:\n1. Open this link in your browser and sign in\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code\n   \x1b[94mABCD-12345\x1b[0m\n';
  assert.deepEqual(login.parseLoginOutput(spec('codex-acp'), codex), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  assert.deepEqual(login.parseLoginOutput(spec('claude-acp'), 'starting…'), {});
  assert.deepEqual(login.parseLoginOutput(spec('claude-acp'), 'visit http://insecure.example/x'), {}, 'only https');
  assert.equal(login.parseLoginOutput(spec('claude-acp'), 'x ABCD-12345 y').code, undefined, 'a code is only read for the device flow');
});

test('status output per manifest: signed in or not, a label, nothing else', () => {
  const c = spec('claude-acp').status;
  assert.deepEqual(login.parseLoginStatus(c, '{"loggedIn": true, "email": "ada@example.com", "subscriptionType": "max"}', 0), { signedIn: true, account: 'ada@example.com (Max)' });
  assert.deepEqual(login.parseLoginStatus(c, '{"loggedIn": false, "authMethod": "none"}', 0), { signedIn: false });
  assert.deepEqual(login.parseLoginStatus(c, '{"loggedIn": "yes"}', 0), { signedIn: false });
  assert.deepEqual(login.parseLoginStatus(c, 'not json', 0), { signedIn: false });
  assert.deepEqual(login.parseLoginStatus(spec('codex-acp').status, 'Logged in using ChatGPT', 0), { signedIn: true });
  assert.deepEqual(login.parseLoginStatus(spec('codex-acp').status, 'Not logged in', 1), { signedIn: false });
  const o = spec('opencode').status;
  assert.equal(login.parseLoginStatus(o, '\x1b[0m\n┌  Credentials ~/d/opencode/auth.json\n│\n└  0 credentials\n', 0).signedIn, false);
  assert.equal(login.parseLoginStatus(o, '└  2 credentials\n', 0).signedIn, true);
  assert.equal(spec('pi-acp').status.format, 'file');
  assert.equal(login.parseLoginStatus(spec('pi-acp').status, '', 0).signedIn, true);
  assert.equal(login.parseLoginStatus(spec('pi-acp').status, '', 1).signedIn, false);
});

test('a failed sign-in gives a short readable reason, never an address or a token-like string', () => {
  assert.equal(login.failureReason('Error: authorization code expired\r\n'), 'The sign-in did not finish: Error: authorization code expired');
  assert.equal(login.failureReason('Visit https://claude.ai/oauth/authorize?state=secret\n'), 'The sign-in did not finish. Try again.');
  assert.equal(login.failureReason('Error: bad sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'The sign-in did not finish. Try again.');
});

test('mode per session: personal > team login > team key > none; unattended runs use the key only', () => {
  const base = { unattended: false, personalSignedIn: false, teamLoginAllowed: false, teamLoginSignedIn: false, teamKeyAllowed: false, teamKeyUsable: false };
  const m = (o: Partial<typeof base>) => team.resolveMode({ ...base, ...o });
  assert.equal(m({}), 'none');
  assert.equal(m({ teamKeyAllowed: true, teamKeyUsable: true }), 'team-key');
  assert.equal(m({ teamKeyAllowed: true, teamKeyUsable: false }), 'none', 'a key nobody connected');
  assert.equal(m({ teamLoginAllowed: true, teamLoginSignedIn: true, teamKeyAllowed: true, teamKeyUsable: true }), 'team-login');
  assert.equal(m({ teamLoginAllowed: true, teamLoginSignedIn: false, teamKeyAllowed: true, teamKeyUsable: true }), 'team-key', 'the team is not signed in');
  assert.equal(m({ teamLoginAllowed: false, teamLoginSignedIn: true }), 'none', 'a role the login is not open to');
  assert.equal(m({ personalSignedIn: true, teamLoginAllowed: true, teamLoginSignedIn: true, teamKeyAllowed: true, teamKeyUsable: true }), 'personal');
  assert.equal(m({ personalSignedIn: true }), 'personal', 'roles never restrict a personal login');
  assert.equal(m({ unattended: true, personalSignedIn: true, teamLoginAllowed: true, teamLoginSignedIn: true, teamKeyAllowed: true, teamKeyUsable: true }), 'team-key');
  assert.equal(m({ unattended: true, personalSignedIn: true }), 'none');
});

test('team accounts: roles for the key and the login; a shared login only where the manifest allows it or an admin took the explicit override', () => {
  db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES ('opencode', '1', 'ready', 1, '[]', 'x'), ('claude-acp', '1', 'ready', 1, '[]', 'x')").run();
  // the key: on for everyone with the agent until an admin says otherwise
  assert.equal(team.teamKeyAllowed('claude-acp', 'worker'), true);
  team.setTeamAccount('claude-acp', { keyRoles: ['dev'] });
  assert.equal(team.teamKeyAllowed('claude-acp', 'dev'), true); assert.equal(team.teamKeyAllowed('claude-acp', 'worker'), false); assert.equal(team.teamKeyAllowed('claude-acp', undefined), false);
  team.setTeamAccount('claude-acp', { keyEnabled: false });
  assert.equal(team.teamKeyAllowed('claude-acp', 'dev'), false);
  // the shared login: not for Claude Code without the flag
  assert.throws(() => team.setTeamAccount('claude-acp', { loginEnabled: true }), /no shared team login/);
  assert.throws(() => team.setTeamAccount('claude-acp', { loginOverride: true }), /does not allow a subscription to be shared/);
  assert.equal(team.teamAccount('claude-acp').loginOverride, false);
  assert.throws(() => team.setTeamAccount('claude-acp', { loginOverride: false, loginEnabled: true, acceptTermsRisk: true }), /no shared team login/, 'the acknowledgement alone is not the override');
  team.setTeamAccount('claude-acp', { loginOverride: true, acceptTermsRisk: true });
  assert.equal(team.teamAccount('claude-acp').loginOverride, true);
  team.setTeamAccount('claude-acp', { loginEnabled: true, loginRoles: ['dev'] });
  assert.equal(team.teamLoginAllowed('claude-acp', 'dev'), true); assert.equal(team.teamLoginAllowed('claude-acp', 'worker'), false);
  // and it ends when the override is withdrawn
  team.setTeamAccount('claude-acp', { loginEnabled: false, loginOverride: false });
  assert.equal(team.teamLoginAllowed('claude-acp', 'dev'), false);
  // OpenCode shares by manifest, no warning needed; empty roles = every role
  team.setTeamAccount('opencode', { loginEnabled: true });
  assert.equal(team.teamLoginAllowed('opencode', 'anyone'), true);
  assert.throws(() => team.setTeamAccount('nope', {}), /not available/);
});

test('team homes are mounted only for the roles allowed (and the admins who sign the team in)', () => {
  db.prepare("INSERT OR REPLACE INTO roles (id, name, builtin, permissions) VALUES ('dev', 'Dev', 0, '[\"sandbox.shell\"]'), ('worker', 'Worker', 0, '[\"sandbox.shell\"]'), ('boss', 'Boss', 0, '[\"sandbox.shell\",\"accounts.team\"]')").run();
  for (const [u, r] of [['u1', 'dev'], ['u2', 'worker'], ['u3', 'boss']]) db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(u, r);
  team.setTeamAccount('opencode', { loginEnabled: true, loginRoles: ['dev'] });
  assert.deepEqual(team.teamHomes('u1'), ['opencode']);
  assert.deepEqual(team.teamHomes('u2'), [], 'a role the login is not open to gets no mount');
  assert.deepEqual(team.teamHomes('u3'), ['opencode'], 'the admin who signs the team in');
  assert.equal(team.mayManageTeamAccounts('u3'), true); assert.equal(team.mayManageTeamAccounts('u1'), false);
  team.setTeamAccount('opencode', { loginEnabled: false });
  assert.deepEqual(team.teamHomes('u1'), []);
});

test('a team-login launch keeps the conversation\'s own config dir, links only the team credentials, drops the key setup', () => {
  const l = teamLaunch(wrapperLaunch(profileOf('claude-acp')!, '2.1.310', '11111111-2222-3333-4444-555555555555', 'dark'), '/team-accounts/claude-acp');
  assert.equal(l.env.ANTHROPIC_BASE_URL, undefined); assert.equal(l.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(l.env.CLAUDE_CONFIG_DIR, '/tmp/.claude'); assert.equal(l.env.HTTPS_PROXY, 'http://127.0.0.1:47001');
  assert.match(l.cmd.at(-1)!, /^mkdir -p \/tmp\/\.claude; ln -sfn \/team-accounts\/claude-acp\/\.credentials\.json \/tmp\/\.claude\/\.credentials\.json; /);
  for (const s of JSON.parse(l.env.HEFYN_SEED)) assert.ok(s.path.startsWith('/tmp/'), s.path);
  assert.ok(!JSON.stringify(l.env).includes('hefyn-gateway'));
});

// ---- the sign-in host against a stand-in CLI ----
function standIn() {
  const toProc = new PassThrough(), fromProc = new PassThrough(), written: string[] = [];
  toProc.on('data', (b) => written.push(b.toString()));
  const stream = Duplex.from({ readable: fromProc, writable: toProc } as any) as Duplex;
  return { stream, say: (s: string) => fromProc.write(s), end: () => stream.destroy(), written };
}
const until = async (f: () => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`timed out: ${what}`); };

test('the sign-in host: address and code appear, a pasted code goes into the CLI\'s prompt, the status command decides, nothing of the screen is kept', async () => {
  db.prepare("INSERT OR REPLACE INTO roles (id, name, builtin, permissions) VALUES ('shell', 'Shell', 0, '[\"sandbox.shell\"]')").run();
  db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (?, ?)').run('u9', 'shell');
  db.prepare("UPDATE cli_agents SET status = 'ready', enabled = 1 WHERE id = 'claude-acp'").run();
  const specs: any[] = [], procs: ReturnType<typeof standIn>[] = [], hosts: string[][] = [];
  let signed = false;
  const host = new AccountHost({
    attach: async (_u, _c, s) => { specs.push(s); const p = standIn(); procs.push(p); return { stream: p.stream, resize: async () => {} }; },
    listenAuth: async (_u, _c, h) => (hosts.push(h!), { close() {} }),
    status: async () => ({ signedIn: signed, ...(signed ? { account: 'ada@example.com (Max)' } : {}) }),
  });
  await assert.rejects(host.open('u9', 'claude-acp', 'team', 100, 30), /manage team accounts/);
  await host.open('u9', 'claude-acp', 'personal', 100, 30);
  assert.deepEqual(hosts[0], ['api.anthropic.com:443', 'platform.claude.com:443', 'claude.ai:443'], 'the agent\'s own hosts, nothing else');
  assert.equal(specs[0].cols, 1000, 'wide, so an address is not broken across lines');
  assert.equal(specs[0].env.CLAUDE_CONFIG_DIR, '/claude-home'); assert.equal(specs[0].env.HTTPS_PROXY, 'http://127.0.0.1:47001');
  assert.match(specs[0].cmd.at(-1), /auth login$/);
  assert.equal(host.state('u9').phase, 'starting');
  assert.throws(() => host.submitCode('u9', 'abc#def1234'), /./, 'a code only after the CLI asked');
  procs[0]!.say('Opening browser…\r\nvisit: https://claude.ai/oauth/authorize?state=1\r\nPaste code here > ');
  await until(() => host.state('u9').phase === 'waiting', 'waiting');
  assert.equal((host.state('u9') as any).url, 'https://claude.ai/oauth/authorize?state=1');
  assert.throws(() => host.submitCode('u9', 'x'), /does not look like a sign-in code/);
  host.submitCode('u9', 'AbC123_-xyz#state9');
  assert.deepEqual(procs[0]!.written, ['AbC123_-xyz#state9\r']);
  signed = true; procs[0]!.say('Login successful\r\n'); procs[0]!.end();
  await until(() => host.state('u9').phase === 'done', 'done');
  const done = host.state('u9') as any;
  assert.equal(done.account, 'ada@example.com (Max)'); assert.equal(done.url, undefined, 'the address and the screen are dropped once it is over');
  assert.ok(!JSON.stringify(done).includes('AbC123'), 'the code is not kept');
  // a failure says why, and a new open replaces the finished one
  signed = false;
  await host.open('u9', 'claude-acp', 'personal', 100, 30);
  procs[1]!.say('Error: authorization code expired\r\n'); await new Promise((r) => setTimeout(r, 30)); procs[1]!.end();
  await until(() => host.state('u9').phase === 'failed', 'failed');
  assert.match((host.state('u9') as any).reason, /authorization code expired/);
  host.close('u9');
  assert.equal(host.state('u9').phase, 'idle');
  // an agent without a scriptable flow: its terminal; typed input reaches it
  db.prepare("UPDATE cli_agents SET status = 'ready', enabled = 1 WHERE id = 'opencode'").run();
  await host.open('u9', 'opencode', 'personal', 100, 30);
  assert.equal(specs[2].cols, 100); assert.equal(specs[2].env.XDG_DATA_HOME, '/accounts/opencode');
  host.input('u9', 'x'); assert.deepEqual(procs[2]!.written, ['x']);
  assert.throws(() => host.submitCode('u9', 'abcdef'), /not waiting for a code/);
  host.close('u9');
});

test('team sign-in needs accounts.team and an enabled shared login', async () => {
  db.prepare("INSERT OR REPLACE INTO roles (id, name, builtin, permissions) VALUES ('teamadm', 'TeamAdm', 0, '[\"sandbox.shell\",\"accounts.team\"]')").run();
  db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (?, ?)').run('u8', 'teamadm');
  const procs: ReturnType<typeof standIn>[] = [], specs: any[] = [];
  const host = new AccountHost({ attach: async (_u, _c, s) => { specs.push(s); const p = standIn(); procs.push(p); return { stream: p.stream, resize: async () => {} }; }, listenAuth: async () => ({ close() {} }), status: async () => ({ signedIn: true }) });
  team.setTeamAccount('opencode', { loginEnabled: false });
  await assert.rejects(host.open('u8', 'opencode', 'team', 100, 30), /not turned on/);
  team.setTeamAccount('opencode', { loginEnabled: true });
  await host.open('u8', 'opencode', 'team', 100, 30);
  assert.equal(specs[0].env.XDG_DATA_HOME, '/team-accounts/opencode');
  host.close('u8');
});

test('hefyn never reads the credential files: the account code opens no file, logs nothing, and is the only code that names the Claude home outside own-account.ts', () => {
  const src = join(import.meta.dirname, '../src');
  const strip = (f: string) => readFileSync(join(src, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['cli-agents/account.ts', 'cli-agents/agent-login.ts', 'cli-agents/team-accounts.ts', 'cli-agents/own-account.ts']) {
    assert.doesNotMatch(strip(f), /readFile|readFileSync|openSync|createReadStream|statSync|existsSync|copyFile|readdir|console\.(log|info|debug|warn)/, `${f} opens no file and logs nothing`);
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const naming = walk(src).filter((f) => /claude-home|\.credentials\.json/.test(readFileSync(f, 'utf8'))).map((f) => f.split('/src/')[1]);
  assert.deepEqual(naming, ['cli-agents/own-account.ts']);
});
