import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Claude Code on the user's own account (src/cli-agents/own-account.ts) without Docker: the launch, `claude auth status`, and the Anthropic-only proxy against stand-ins
// (no real host is dialled: the allowed names are mapped to a local server). The real sandbox side is test/cli-agent-wrapper.test.ts.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-ownacct-'));
process.env.HEFYN_SECRET = 'own-account-secret-own-account-123456789';

const own = await import('../src/cli-agents/own-account.ts');
const { profileOf, wrapperLaunch } = await import('../src/cli-agents/profiles.ts');

test('the own-account launch: no base URL, no dummy key, the Claude home, the proxy; seeds follow the config dir', () => {
  const base = wrapperLaunch(profileOf('claude-acp')!, '2.1.310', '11111111-2222-3333-4444-555555555555', 'dark'), l = own.ownLaunch(base);
  assert.equal(base.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47000'); // the API-key launch is untouched
  assert.equal(l.env.ANTHROPIC_BASE_URL, undefined); assert.equal(l.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(l.env.CLAUDE_CONFIG_DIR, '/claude-home'); assert.equal(l.env.HTTPS_PROXY, 'http://127.0.0.1:47001'); assert.equal(l.env.NO_PROXY, '127.0.0.1,localhost');
  assert.ok(!JSON.stringify(l.env).includes('hefyn-gateway'), 'no dummy key anywhere, not even as an approved key in the config');
  for (const s of JSON.parse(l.env.HEFYN_SEED)) assert.ok(s.path.startsWith('/claude-home/'), s.path);
  assert.match(l.cmd.at(-1)!, /^mkdir -p \/tmp\/\.claude\/projects; ln -sfn \/tmp\/\.claude\/projects \/claude-home\/projects; bin=/);
  assert.equal(own.inHome('/tmp/.claude/skills/a/SKILL.md'), '/claude-home/skills/a/SKILL.md'); assert.equal(own.inHome('/tmp/.claudex'), '/tmp/.claudex');
});

test('`claude auth status` output: signed in or not, a label if there is one, never more', () => {
  assert.deepEqual(own.parseStatus('{"loggedIn": false, "authMethod": "none"}'), { signedIn: false });
  assert.deepEqual(own.parseStatus('{"loggedIn": true, "email": "ada@example.com", "subscriptionType": "max"}'), { signedIn: true, account: 'ada@example.com (Claude Max)' });
  assert.deepEqual(own.parseStatus('{"loggedIn": true}'), { signedIn: true });
  assert.deepEqual(own.parseStatus('not json'), { signedIn: false });
  assert.equal(own.parseStatus('{"loggedIn": "yes"}').signedIn, false, 'only a real true counts');
});

test('the proxy tunnels to Anthropic\'s names and refuses everything else; the dialled target is the allowed name', async () => {
  const hits: string[] = [];
  const standIn = net.createServer((c) => c.end('STAND-IN')).listen(0, '127.0.0.1');
  await new Promise((r) => standIn.once('listening', r));
  const proxy = own.createAuthProxy(own.ANTHROPIC_HOSTS, (host, port) => (hits.push(`${host}:${port}`), { host: '127.0.0.1', port: (standIn.address() as AddressInfo).port }));
  proxy.listen(0, '127.0.0.1'); await new Promise((r) => proxy.once('listening', r));
  const port = (proxy.address() as AddressInfo).port;
  const connect = (target: string) => new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => resolve(out)); s.on('error', () => resolve(out)); setTimeout(() => s.destroy(), 2000);
  });
  assert.deepEqual(own.ANTHROPIC_HOSTS, ['api.anthropic.com:443', 'platform.claude.com:443', 'claude.ai:443']);
  for (const h of own.ANTHROPIC_HOSTS) assert.match(await connect(h), /^HTTP\/1\.1 200 Connection Established\r\n\r\nSTAND-IN$/, h);
  assert.deepEqual(hits, own.ANTHROPIC_HOSTS);
  for (const bad of ['example.org:443', 'api.anthropic.com:80', 'api.anthropic.com.evil.example:443', 'evil-claude.ai:443', 'api.openai.com:443', '127.0.0.1:47000', 'downloads.claude.ai:443', 'github.com:443']) assert.match(await connect(bad), /^HTTP\/1\.1 403 /, bad);
  assert.equal(hits.length, 3, 'a refused host is never dialled');
  const plain = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
  assert.equal(plain.status, 405); assert.equal(plain.headers.get('allow'), 'CONNECT');
  proxy.close(); proxy.closeAllConnections?.(); standIn.close();
});

test('behind an upstream proxy (egress) the tunnel is a CONNECT through it, with its credentials; a refusal there is a 502', async () => {
  const seen: string[] = [];
  const upstream = net.createServer((c) => c.once('data', (d) => {
    const head = d.toString('latin1'); seen.push(head);
    if (head.startsWith('CONNECT platform.claude.com:443 ')) c.end('HTTP/1.1 200 Connection Established\r\n\r\nVIA-EGRESS');
    else c.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  })).listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  const proxy = own.createAuthProxy(own.ANTHROPIC_HOSTS, undefined, `http://hefyn:t%40k@127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  proxy.listen(0, '127.0.0.1'); await new Promise((r) => proxy.once('listening', r));
  const port = (proxy.address() as AddressInfo).port;
  const connect = (target: string) => new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => resolve(out)); s.on('error', () => resolve(out)); setTimeout(() => s.destroy(), 2000);
  });
  assert.equal(await connect('platform.claude.com:443'), 'HTTP/1.1 200 Connection Established\r\n\r\nVIA-EGRESS');
  assert.match(seen[0], new RegExp(`\r\nProxy-Authorization: Basic ${Buffer.from('hefyn:t@k').toString('base64')}\r\n`));
  assert.match(await connect('api.anthropic.com:443'), /^HTTP\/1\.1 502 /, 'egress refused it');
  assert.match(await connect('example.org:443'), /^HTTP\/1\.1 403 /);
  assert.equal(seen.length, 2, 'a host the proxy refuses never reaches egress');
  proxy.close(); proxy.closeAllConnections?.(); upstream.close();
});

test('no process of hefyn asks for the file itself: the sign-in check is a size test run in the sandbox', async () => {
  const seen: any[] = [];
  const fake = Bun.serve({ port: 0, fetch: async (req: Request) => { const u = new URL(req.url), b = req.method === 'POST' ? await req.json().catch(() => ({})) : {}; seen.push({ path: u.pathname, body: b }); return u.pathname === '/sandboxes' ? Response.json({ id: 'abcdef0123456789' }) : Response.json({ stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false }); } });
  process.env.HEFYN_RUNNER_URL = `http://127.0.0.1:${fake.port}`; process.env.HEFYN_INTERNAL_TOKEN = 'own-account-token-own-account-0123456789';
  try {
    assert.equal(await own.signedIn('alice', 'u_alice_01X'), true);
    const exec = seen.find((x) => x.path.endsWith('/exec'))!;
    assert.deepEqual(exec.body.cmd, ['test', '-s', '/claude-home/.credentials.json'], 'exit code only: nothing of the file comes back');
  } finally { fake.stop(true); }
});
