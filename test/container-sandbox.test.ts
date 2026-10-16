import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxDiedError } from '@flue/runtime';
import { dockerClient, type Docker } from '../services/runner/src/docker.ts';
import { checkLimits, demux, handleOf, idleHandles, loadConfig, parseExec, tokenOk, HttpError, type Config } from '../services/runner/src/logic.ts';
import { createRunner } from '../services/runner/src/server.ts';

// The sandbox code reaches app.db (storage add-ons): point it at a scratch dir before it is first imported.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cs-db-'));
const { containerFs, containerSandbox, containerSandboxFactory } = await import('../src/server/container-sandbox.ts');

const TOKEN = 'test-token';
const listen = (h: http.RequestListener) => new Promise<{ url: string; close: () => void }>((r) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() })); });
const silent = () => {};
const noDocker: Docker = { call: async (_m, p) => { if (p === '/_ping') return 'OK'; throw new Error('docker must not be called: ' + p); }, hijack: async () => { throw new Error('no docker'); } };
const post = (url: string, path: string, body: unknown, token: string | null | undefined = undefined, method = 'POST') =>
  fetch(url + path, { method, headers: { 'content-type': 'application/json', ...((token === undefined ? TOKEN : token) ? { 'x-hefyn-internal': token ?? TOKEN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const cfgOf = (o: Partial<Config> = {}): Config => ({ ...loadConfig({ HEFYN_INTERNAL_TOKEN: TOKEN }), ...o });

// ---------- runner: pure logic ----------
test('runner: token compare', () => {
  assert.ok(tokenOk('abc', 'abc'));
  for (const bad of [undefined, '', 'abd', 'abcd']) assert.ok(!tokenOk(bad, 'abc'));
  assert.ok(!tokenOk('', '')); // an unset server token never authenticates
});

test('runner: exec request validation', () => {
  const c = cfgOf();
  assert.deepEqual(parseExec({ cmd: 'ls' }, c).cmd, ['bash', '-c', 'ls']);
  assert.equal(parseExec({ cmd: ['ls'], timeoutMs: 1e12, maxOutput: 1e12 }, c).timeoutMs, c.maxTimeoutMs);
  assert.equal(parseExec({ cmd: ['ls'], maxOutput: 1e12 }, c).maxOutput, c.hardOutput);
  assert.equal(parseExec({ cmd: 'x', stdin: Buffer.from('hi').toString('base64') }, c).stdin?.toString(), 'hi');
  for (const bad of [{}, { cmd: '' }, { cmd: [] }, { cmd: [1] }, { cmd: ['a\0b'] }, { cmd: 'x', cwd: '/etc' }, { cmd: 'x', cwd: '/files/../etc' }, { cmd: 'x', cwd: '/filesx' },
    { cmd: 'x', env: { 'A-B': '1' } }, { cmd: 'x', env: { A: 1 } }, { cmd: 'x', env: [] }, { cmd: 'x', timeoutMs: -1 }, { cmd: 'x', stdin: '***' }, { cmd: 'x', stdin: 5 }, null]) {
    assert.throws(() => parseExec(bad, c), HttpError, JSON.stringify(bad));
  }
});

test('runner: limits and reaper selection', () => {
  const m = (handle: string, kind: 'sandbox' | 'playwright', userId: string) => ({ handle, kind, userId, conversationId: 'c' });
  const lim = { maxPerUser: { sandbox: 2, playwright: 1 }, maxGlobal: { sandbox: 4, playwright: 1 } };
  const ex = [m('a', 'sandbox', 'u1'), m('b', 'sandbox', 'u1'), m('c', 'sandbox', 'u2')];
  assert.throws(() => checkLimits(ex, 'sandbox', 'u1', lim), /for this user/);
  assert.throws(() => checkLimits([...ex, m('d', 'sandbox', 'u4')], 'sandbox', 'u3', lim), /on this server/);
  checkLimits(ex, 'playwright', 'u1', lim); // separate budget per kind
  assert.throws(() => checkLimits([m('p', 'playwright', 'u9')], 'playwright', 'u1', lim), /on this server/);
  const last = new Map([['old', 0], ['new', 9_000], ['busy', 0]]);
  assert.deepEqual(idleHandles(last, new Map([['busy', 1]]), 10_000, 5_000), ['old']);
  assert.deepEqual(idleHandles(last, new Map(), 10_000, 5_000).sort(), ['busy', 'old']);
  assert.notEqual(handleOf('a', 'bc'), handleOf('ab', 'c')); // no ambiguity between user and conversation
});

test('runner: docker stream demux with caps and split frames', () => {
  const frame = (t: number, s: string) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = t; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const d = demux(5);
  const all = Buffer.concat([frame(1, 'hello world'), frame(2, 'err')]);
  d.push(all.subarray(0, 10)); d.push(all.subarray(10));
  assert.deepEqual(d.result(), { stdout: 'hello', stderr: 'err', truncated: true });
});

// ---------- runner: HTTP surface with a fake docker ----------
test('runner: auth and validation reject before docker is touched', async () => {
  const srv = await listen(createRunner(cfgOf(), noDocker, silent).handler);
  try {
    for (const t of [null, 'wrong', '']) {
      assert.equal((await post(srv.url, '/sandboxes', { userId: 'a', conversationId: 'b' }, t)).status, 401);
      assert.equal((await post(srv.url, '/health', undefined, t, 'GET')).status, 401);
    }
    assert.equal((await post(srv.url, '/health', undefined, TOKEN, 'GET')).status, 200);
    for (const body of [{}, { userId: '../x', conversationId: 'b' }, { userId: 'a', conversationId: 'b/c' }, { userId: 'a'.repeat(200), conversationId: 'b' }, { userId: 5, conversationId: 'b' }]) {
      assert.equal((await post(srv.url, '/sandboxes', body)).status, 400, JSON.stringify(body));
      assert.equal((await post(srv.url, '/mcp/playwright', body)).status, 400);
    }
    for (const id of ['x', '../etc', 'ZZZZZZZZZZZZZZZZ', '0123456789abcdef0']) {
      assert.equal((await post(srv.url, `/sandboxes/${encodeURIComponent(id)}/exec`, { cmd: 'ls' })).status, 400);
      assert.equal((await post(srv.url, `/sandboxes/${encodeURIComponent(id)}`, undefined, TOKEN, 'DELETE')).status, 400);
    }
    assert.equal((await post(srv.url, '/sandboxes/0123456789abcdef/exec', { cmd: 'ls', cwd: '/etc' })).status, 400);
    assert.equal((await post(srv.url, '/nope', {})).status, 404);
  } finally { srv.close(); }
});

test('runner: creates hardened containers and enforces limits (fake docker)', async () => {
  const data = mkdtempSync(join(tmpdir(), 'hefyn-runner-'));
  const created: any[] = [], running: any[] = [];
  const docker: Docker = {
    hijack: async () => { throw new Error('unused'); },
    async call(method, path, body) {
      if (path.startsWith('/containers/json')) return running.map((r) => ({ Labels: r.Labels }));
      if (path.startsWith('/networks/')) return {};
      if (method === 'GET' && path.startsWith('/containers/')) { const e: any = new Error('nf'); e.status = 404; throw Object.assign(e, { name: 'DockerError' }); }
      if (path.startsWith('/containers/create')) { created.push(body); running.push(body); return {}; }
      return {};
    },
  };
  // DockerError identity: use the real class so 404 handling matches
  const { DockerError } = await import('../services/runner/src/docker.ts');
  const realCall = docker.call;
  docker.call = (m, p, b) => realCall(m, p, b).catch((e) => { throw e.status === 404 ? new DockerError(404, 'nf') : e; });
  const cfg = cfgOf({ dataDir: data, hostDataDir: '/host/data', maxPerUser: { sandbox: 1, playwright: 1 }, maxGlobal: { sandbox: 5, playwright: 5 } });
  const srv = await listen(createRunner(cfg, docker, silent).handler);
  try {
    assert.equal((await post(srv.url, '/sandboxes', { userId: 'alice', conversationId: 'c1' })).status, 200);
    assert.equal((await post(srv.url, '/sandboxes', { userId: 'alice', conversationId: 'c2' })).status, 429);
    assert.equal((await post(srv.url, '/sandboxes', { userId: 'bob', conversationId: 'c1' })).status, 200);
    const c = created[0], h = c.HostConfig;
    assert.equal(c.Image, 'hefyn-sandbox');
    assert.equal(c.User, '1000:1000');
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.deepEqual(h.SecurityOpt, ['no-new-privileges:true']);
    assert.equal(h.ReadonlyRootfs, true); assert.equal(h.Privileged, false);
    assert.equal(h.NetworkMode, 'hefyn-sandbox');
    assert.deepEqual(h.Mounts.map((m: any) => [m.Source, m.Target]), [['/host/data/users/alice/files', '/files'], ['/host/data/users/alice/tmp/c1', '/tmp']]);
    assert.ok(!JSON.stringify(c).includes('docker.sock'));
    assert.equal(c.Labels['hefyn.user'], 'alice');
    assert.ok(existsSync(join(data, 'users/alice/files')) && existsSync(join(data, 'users/alice/tmp/c1')));
  } finally { srv.close(); }
});

// ---------- driver <-> fake runner ----------
/** In-memory "container" speaking the runner protocol; recognises the helper commands the driver issues. */
function fakeRunner() {
  const files = new Map<string, Buffer>(), calls: any[] = [];
  let ensured = 0, die404 = 0;
  const srv = listen(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const out = (status: number, j: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    if (req.headers['x-hefyn-internal'] !== TOKEN) return out(401, { error: 'unauthorized' });
    if (req.url === '/sandboxes') { ensured++; return out(200, { id: '0123456789abcdef' }); }
    if (req.method === 'DELETE') return out(200, { ok: true });
    calls.push(body);
    if (die404 > 0) { die404--; return out(404, { error: 'not found' }); }
    const [c0, ...rest] = Array.isArray(body.cmd) ? body.cmd : ['sh-string'];
    const ok = (stdout = '') => out(200, { stdout, stderr: '', exitCode: 0, truncated: false });
    const fail = (stderr: string, exitCode = 1) => out(200, { stdout: '', stderr, exitCode, truncated: false });
    if (c0 === 'base64') { const f = files.get(rest[rest.length - 1]); return f ? ok(f.toString('base64')) : fail('base64: x: No such file or directory'); }
    if (c0 === 'bash' && /cat >/.test(rest[1])) { files.set(rest[3], Buffer.from(body.stdin, 'base64')); return ok(); }
    if (c0 === 'bash' && /stat -c/.test(rest[1])) { const f = files.get(rest[3]); return f ? ok(`regular file\nregular file|${f.length}|1700000000\n`) : fail('stat: No such file or directory'); }
    if (c0 === 'bash' && /find/.test(rest[1])) return rest[3] === '/files' ? ok([...files.keys()].map((k) => k.slice(7)).join('\0') + '\0') : fail('find: Not a directory');
    if (c0 === 'test') return out(200, { stdout: '', stderr: '', exitCode: files.has(rest[rest.length - 1]) ? 0 : 1, truncated: false });
    if (c0 === 'rm') { return files.delete(rest[rest.length - 1]) ? ok() : fail('rm: cannot remove: No such file or directory'); }
    if (c0 === 'sh-string') return body.cmd === 'sleep' ? out(200, { stdout: '', stderr: 'partial', exitCode: 124, truncated: true, timedOut: true }) : ok(`ran:${body.cmd}@${body.cwd}`);
    return fail('unexpected ' + c0);
  });
  return { srv, files, calls, ensured: () => ensured, dieOnce: () => { die404 = 1; } };
}

test('driver: lazy start, binary-safe round trip, error mapping, exec', async () => {
  const f = fakeRunner(), srv = await f.srv;
  try {
    const opts = { userId: 'alice', conversationId: 'u_alice_01A', runnerUrl: srv.url, token: TOKEN };
    const sb = containerSandbox(opts);
    assert.equal(f.ensured(), 0, 'no container before first use');
    const bin = new Uint8Array(Array.from({ length: 256 }, (_, i) => i)); // every byte value
    await sb.writeFile('/files/dir/bin.dat', bin);
    assert.equal(f.ensured(), 1);
    assert.deepEqual(new Uint8Array(await sb.readFileBuffer('/files/dir/bin.dat')), bin);
    assert.deepEqual([...f.files.get('/files/dir/bin.dat')!], [...bin]); // base64 over stdin decoded to the same bytes
    await sb.writeFile('/files/t.txt', 'héllo ✓');
    assert.equal(await sb.readFile('t.txt'), 'héllo ✓'); // relative -> cwd /files
    assert.equal((await sb.stat('/files/t.txt')).isFile, true);
    assert.equal(await sb.exists('/files/t.txt'), true);
    assert.equal(await sb.exists('/files/nope'), false);
    assert.equal(await sb.exists('/etc/passwd'), false);
    assert.ok((await sb.readdir('/files')).includes('t.txt'));
    await assert.rejects(sb.readFile('/files/missing'), (e: any) => e.code === 'ENOENT');
    await assert.rejects(sb.readdir('/files/t.txt'), (e: any) => e.code === 'ENOTDIR' || /Not a directory/.test(e.message));
    for (const p of ['/etc/passwd', '/files/../etc/passwd', '/files/a\0b', '/files\\x']) await assert.rejects(sb.readFile(p));
    await assert.rejects(sb.rm('/files'));
    await sb.rm('/files/t.txt');
    assert.ok(f.calls.every((c) => c.cwd === '/files' && c.cmd));
    const r = await sb.exec('echo hi', { cwd: '/tmp' });
    assert.deepEqual(r, { stdout: 'ran:echo hi@/tmp', stderr: '', exitCode: 0 });
    const t = await sb.exec('sleep', { timeoutMs: 50 });
    assert.equal(t.exitCode, 124); assert.match(t.stderr, /timed out after 50 ms/); assert.match(t.stderr, /truncated/);
    // container reaped meanwhile: runner answers 404 once, the driver restarts it transparently
    f.dieOnce(); const before = f.ensured();
    assert.equal(await sb.readFile('/files/dir/bin.dat').then(() => true), true);
    assert.equal(f.ensured(), before + 1);
  } finally { srv.close(); }
});

test('driver: runner down -> SandboxDiedError; bad token -> error; factory shape', async () => {
  const sb = containerSandbox({ userId: 'a', conversationId: 'b', runnerUrl: 'http://127.0.0.1:1', token: TOKEN });
  await assert.rejects(sb.exec('ls'), (e) => e instanceof SandboxDiedError);
  const f = fakeRunner(), srv = await f.srv;
  try {
    await assert.rejects(containerSandbox({ userId: 'a', conversationId: 'b', runnerUrl: srv.url, token: 'bad' }).exec('ls'), /unauthorized/);
    const fac = containerSandboxFactory({ userId: 'a', conversationId: 'b', runnerUrl: srv.url, token: TOKEN });
    assert.equal(fac.tools, undefined); // default Flue tools (bash, grep, glob, ...)
    assert.equal(typeof (await fac.createSandbox({ id: 'x' })).exec, 'function');
  } finally { srv.close(); }
  assert.throws(() => containerFs({ userId: 'a', conversationId: 'b', runnerUrl: '' }), /HEFYN_RUNNER_URL/);
});

test('driver: over quota refuses exec and writes with a clear error, without touching the runner', async () => {
  const f = fakeRunner(), srv = await f.srv;
  try {
    const sb = containerSandbox({ userId: 'a', conversationId: 'b', runnerUrl: srv.url, token: TOKEN, overQuota: async () => true });
    const r = await sb.exec('echo hi');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /storage quota exceeded/);
    await assert.rejects(sb.writeFile('/files/x', 'y'), /storage quota exceeded/);
    const ok = containerSandbox({ userId: 'a', conversationId: 'b', runnerUrl: srv.url, token: TOKEN, overQuota: async () => false });
    assert.equal((await ok.exec('echo hi')).exitCode, 0);
  } finally { srv.close(); }
});

test('runner config: egress and the pinned Playwright image', () => {
  assert.equal(loadConfig({ HEFYN_INTERNAL_TOKEN: 'x' }).egress, 'internet');
  assert.equal(loadConfig({ HEFYN_INTERNAL_TOKEN: 'x', HEFYN_SANDBOX_EGRESS: 'none' }).egress, 'none');
  assert.match(loadConfig({}).playwrightImage, /@sha256:[0-9a-f]{64}$/);
});

// ---------- integration (real Docker) ----------
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const sock = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
const hasSock = existsSync(sock);
test('integration: real Docker', { skip: !(dockerUp && hasSock) && 'Docker daemon / socket not available (set DOCKER_HOST or start Docker)', timeout: 600_000 }, async (t) => {
  const run = Math.random().toString(36).slice(2, 8);
  const IMAGE = `hefyn-sandbox-test:${run}`, SBX_NET = `hefyn-sbx-test-${run}`, MCP_NET = `hefyn-mcp-test-${run}`;
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'hefyn-int-')));
  const handles: string[] = [];
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const quiet = (...a: string[]) => { try { docker(...a); } catch { /* best effort cleanup */ } };
  process.env.HEFYN_DATA_DIR = data; // for the host-side file-only sandbox
  const cfg = cfgOf({ dataDir: data, hostDataDir: data, sandboxImage: IMAGE, sandboxNetwork: SBX_NET, mcpNetwork: MCP_NET, idleMs: 3_600_000,
    maxPerUser: { sandbox: 3, playwright: 2 }, maxGlobal: { sandbox: 50, playwright: 10 } });
  const runner = createRunner(cfg, dockerClient(), silent);
  const srv = await listen(runner.handler);
  t.after(() => {
    srv.close();
    for (const h of handles) { quiet('rm', '-f', `hefyn-sbx-${h}`); quiet('rm', '-f', `hefyn-pw-${h}`); }
    try { for (const id of docker('ps', '-aq', '--filter', `label=hefyn.test=${run}`).split('\n').filter(Boolean)) quiet('rm', '-f', id); } catch { /* ignore */ }
    quiet('network', 'rm', SBX_NET); quiet('network', 'rm', MCP_NET); quiet('rmi', '-f', IMAGE);
  });

  docker('build', '-q', '-t', IMAGE, '--label', `hefyn.test=${run}`, join(import.meta.dirname, '../services/sandbox-image'));
  const mk = (userId: string) => { const conversationId = `u_${userId}_${run}`; handles.push(handleOf(userId, conversationId)); return { userId, conversationId, runnerUrl: srv.url, token: TOKEN }; };
  const alice = mk('alice'), bob = mk('bob');
  const A = containerSandbox(alice), B = containerSandbox(bob), fsA = containerFs(alice);
  const sh = (s: Awaited<ReturnType<typeof A.exec>>) => s.stdout.trim();

  await t.test('files written by the shell land on the host', async () => {
    const r = await A.exec('echo hi > /files/a.txt && id -u');
    assert.equal(r.exitCode, 0, r.stderr); assert.equal(sh(r), '1000');
    assert.equal(readFileSync(join(data, 'users/alice/files/a.txt'), 'utf8'), 'hi\n');
    await A.writeFile('/tmp/scratch.txt', 'x');
    assert.equal(readFileSync(join(data, `users/alice/tmp/${alice.conversationId}/scratch.txt`), 'utf8'), 'x');
    const bin = new Uint8Array(Array.from({ length: 256 }, (_, i) => 255 - i));
    await A.writeFile('/files/sub/bin.dat', bin);
    assert.deepEqual(new Uint8Array(readFileSync(join(data, 'users/alice/files/sub/bin.dat'))), bin);
    assert.deepEqual(new Uint8Array(await A.readFileBuffer('/files/sub/bin.dat')), bin);
    assert.deepEqual((await A.readdir('/files')).sort(), ['a.txt', 'sub']);
    await fsA.rename('/files/a.txt', '/files/b.txt');
    assert.equal(await A.readFile('/files/b.txt'), 'hi\n');
    await assert.rejects(fsA.rename('/files/b.txt', '/files/sub/bin.dat'), (e: any) => e.code === 'EEXIST');
    await assert.rejects(A.readFile('/files/none'), (e: any) => e.code === 'ENOENT');
    assert.equal(await A.exists('/files/none'), false); // Flue probes AGENTS.md like this before every run
    assert.equal(await A.exists('/files/b.txt'), true);
    const to = await A.exec('sleep 30', { timeoutMs: 1000 });
    assert.equal(to.exitCode === 124 || to.exitCode === 137, true); assert.match(to.stderr, /timed out/);
  });

  await t.test('symlink to /etc/passwd resolves in the container, and the host-side sandbox refuses it', async () => {
    assert.equal((await A.exec('ln -s /etc/passwd /files/p')).exitCode, 0);
    const viaDriver = await A.readFile('/files/p');
    assert.match(viaDriver, /^root:/m); assert.match(viaDriver, /^hefyn:/m); // the container's passwd, not the host's
    assert.equal(readlinkSync(join(data, 'users/alice/files/p')), '/etc/passwd'); // just a link on the host
    const { userSandbox } = await import('../src/server/storage-sandbox.ts');
    await assert.rejects(userSandbox({ userId: 'alice', conversationId: alice.conversationId }).readFile('/files/p'));
    assert.ok(lstatSync(join(data, 'users/alice/files/p')).isSymbolicLink());
  });

  await t.test('Files API for a shell user runs in the container: a shell-made symlink never reaches host files (TOCTOU)', async () => {
    handles.push(handleOf('alice', 'files'));
    process.env.HEFYN_RUNNER_URL = srv.url; process.env.HEFYN_INTERNAL_TOKEN = TOKEN;
    const { db } = await import('../src/server/appdb.ts');
    db.prepare("INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES ('alice', 'admin')").run();
    const { Hono } = await import('hono');
    const { storageRoutes } = await import('../src/server/storage-routes.ts');
    const app = new Hono();
    app.route('/api', storageRoutes(() => 'alice'));
    // /files/p -> /etc/passwd was made by the shell in the previous step
    const dl = await app.request('/api/files/download?path=/p');
    assert.equal(dl.status, 200);
    const body = await dl.text();
    assert.match(body, /^hefyn:/m); // the container's passwd; the host's has no such user
    const list = (await (await app.request('/api/files?path=/')).json() as any).entries;
    assert.equal(list.find((e: any) => e.name === 'p').type, 'symlink');
    // uploads and the quota run through the same path
    const form = new FormData(); form.append('f', new File(['via container'], 'up.txt'));
    assert.equal((await app.request('/api/files/upload?dir=/', { method: 'POST', body: form })).status, 200);
    assert.equal(readFileSync(join(data, 'users/alice/files/up.txt'), 'utf8'), 'via container');
    assert.equal((await app.request('/api/files/rename', { method: 'POST', body: JSON.stringify({ from: '/up.txt', to: '/up2.txt' }), headers: { 'content-type': 'application/json' } })).status, 200);
    assert.equal((await app.request('/api/files?path=/../etc')).status, 403);
  });

  await t.test('hardening', async () => {
    assert.notEqual((await A.exec('touch /usr/x')).exitCode, 0);
    assert.notEqual((await A.exec('touch /etc/x')).exitCode, 0);
    assert.equal((await A.exec('touch /files/ok /tmp/ok')).exitCode, 0);
    assert.equal(sh(await A.exec("grep CapEff /proc/self/status | awk '{print $2}'")), '0000000000000000');
    assert.equal(sh(await A.exec("grep NoNewPrivs /proc/self/status | awk '{print $2}'")), '1');
    assert.equal((await A.exec('test -e /var/run/docker.sock')).exitCode, 1);
    assert.notEqual((await A.exec('sudo -n true 2>/dev/null || su -c true 2>/dev/null')).exitCode, 0);
    const insp = JSON.parse(docker('inspect', `hefyn-sbx-${handleOf(alice.userId, alice.conversationId)}`))[0];
    assert.equal(insp.HostConfig.ReadonlyRootfs, true); assert.equal(insp.HostConfig.Privileged, false);
    assert.ok(insp.HostConfig.PidsLimit > 0 && insp.HostConfig.Memory > 0);
    assert.deepEqual(Object.keys(insp.NetworkSettings.Networks), [SBX_NET]);
  });

  await t.test('users cannot see each other and cannot resolve internal hostnames', async () => {
    assert.equal(sh(await B.exec('ls -A /files | wc -l')), '0');
    await B.writeFile('/files/bob.txt', 'b');
    assert.ok(!(await A.readdir('/files')).includes('bob.txt'));
    assert.equal((await B.exec('ls /files/../users 2>&1; test -e /data')).exitCode, 1);
    // decoys with the service names on a different network (like the compose network); the sandbox must not resolve them
    const NET = `hefyn-decoy-${run}`; docker('network', 'create', '--label', `hefyn.test=${run}`, NET); t.after(() => quiet('network', 'rm', NET));
    const alias = ['runner', 'web', 'agent', 'redact'].flatMap((n) => ['--network-alias', n]);
    docker('run', '-d', '--rm', '--name', `hefyn-decoy-${run}`, '--label', `hefyn.test=${run}`, '--network', NET, ...alias, IMAGE);
    const ip = JSON.parse(docker('inspect', `hefyn-decoy-${run}`))[0].NetworkSettings.Networks[NET].IPAddress as string;
    for (const host of ['runner', 'web', 'agent', 'redact']) assert.ok(!(await A.exec(`getent hosts ${host}`)).stdout.includes(ip), `${host} must not resolve to the internal network`);
    assert.notEqual((await A.exec(`bash -c 'echo > /dev/tcp/${ip}/80' 2>&1`, { timeoutMs: 5000 })).exitCode, 0, 'cannot connect to the decoy IP');
  });

  await t.test('limits: a user cannot exceed the per-user sandbox cap', async () => {
    const tight = await listen(createRunner({ ...cfg, maxPerUser: { sandbox: 1, playwright: 1 } }, dockerClient(), silent).handler);
    try {
      const o = mk('carol');
      assert.equal((await post(tight.url, '/sandboxes', { userId: 'carol', conversationId: o.conversationId })).status, 200);
      const second = `u_carol_${run}b`; handles.push(handleOf('carol', second));
      assert.equal((await post(tight.url, '/sandboxes', { userId: 'carol', conversationId: second })).status, 429);
      assert.equal((await post(srv.url, `/sandboxes/${handleOf('alice', alice.conversationId)}`, undefined, TOKEN, 'DELETE')).status, 200);
      assert.equal((await post(srv.url, '/sandboxes/' + handleOf('alice', alice.conversationId) + '/exec', { cmd: 'true' })).status, 404);
    } finally { tight.close(); }
  });

  await t.test('playwright MCP answers initialize + tools/list', { timeout: 300_000 }, async (tt) => {
    const o = mk('dave');
    const res = await post(srv.url, '/mcp/playwright', { userId: 'dave', conversationId: o.conversationId });
    assert.equal(res.status, 200);
    const { url } = await res.json() as { url: string };
    const script = `
      const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const parse = async (r) => { const t = await r.text(); const m = t.match(/^data: (.*)$/m); return JSON.parse(m ? m[1] : t); };
      (async () => {
        let r, id = null;
        for (let i = 0; i < 60; i++) { try { r = await fetch(process.argv[1], { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) }); break; } catch { await new Promise((s) => setTimeout(s, 1000)); } }
        if (!r) throw new Error('no connection');
        const init = await parse(r); id = r.headers.get('mcp-session-id'); const sh = id ? { ...h, 'mcp-session-id': id } : h;
        await fetch(process.argv[1], { method: 'POST', headers: sh, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        const tools = await parse(await fetch(process.argv[1], { method: 'POST', headers: sh, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
        console.log(JSON.stringify({ server: init.result?.serverInfo?.name, tools: tools.result?.tools?.map((x) => x.name) }));
      })().catch((e) => { console.error(e); process.exit(1); });`;
    // The MCP port is only reachable on the MCP network, so probe from a throwaway container attached to it.
    const out = docker('run', '--rm', '--label', `hefyn.test=${run}`, '--network', MCP_NET, '--entrypoint', 'node', cfg.playwrightImage, '-e', script, url);
    const got = JSON.parse(out.trim().split('\n').pop()!);
    assert.ok(got.tools.includes('browser_navigate'), out);
    // the sandbox network cannot reach it
    assert.notEqual((await B.exec(`getent hosts ${new URL(url).hostname}`)).exitCode, 0);
    const del = await post(srv.url, `/mcp/playwright/${handleOf('dave', o.conversationId)}`, undefined, TOKEN, 'DELETE');
    assert.equal(del.status, 200);
    void tt;
  });
});
