import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// The Files routes against the container surface (runner configured): a fake runner answers the exact commands container-fs.ts and runner.ts send,
// like GNU coreutils in the sandbox would. No hostPath/openRead, base64 reads capped at READ_LIMIT, `stat` in whole seconds, `find` with fractions.
const root = mkdtempSync(join(tmpdir(), 'hefyn-fake-sbx-'));
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-files-c-'));
process.env.HEFYN_SECRET = 'files-test-secret-files-test-secret-123';
process.env.HEFYN_INTERNAL_TOKEN = 'tok';
const host = (p: string) => join(root, p);
const noent = { stdout: '', stderr: "x: cannot statx 'y': No such file or directory", exitCode: 1, truncated: false };
let execs = 0;

function sh(cmd: string[], stdin: Buffer, maxOutput: number) {
  const out = (stdout: string, exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, truncated: stdout.length > maxOutput });
  const [a0, ...rest] = cmd;
  if (a0 === 'base64') { const p = host(rest.at(-1)!); return existsSync(p) ? out(readFileSync(p).toString('base64')) : noent; }
  if (a0 === 'find') { // list: name, type, size, fractional mtime
    const d = host(rest[0]); if (!existsSync(d)) return noent;
    return out(readdirSync(d).map((n) => { const s = statSync(join(d, n)); return [n, s.isDirectory() ? 'd' : 'f', s.size, s.mtimeMs / 1000].join('\0') + '\0'; }).join(''));
  }
  if (a0 === 'mkdir') { mkdirSync(host(rest.at(-1)!), { recursive: true }); return out(''); }
  if (a0 === 'rm') { const p = host(rest.at(-1)!); if (!existsSync(p)) return noent; rmSync(p, { recursive: true }); return out(''); }
  if (a0 === 'test') return out('', existsSync(host(rest[1])) ? 0 : 1);
  assert.equal(a0, 'bash', `unexpected command ${cmd.join(' ')}`);
  const script = cmd[2], args = cmd.slice(4), p = host(args[0]);
  if (script.includes('cat >')) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, stdin); return out(''); }
  if (script.startsWith('stat -c')) {
    if (!existsSync(p)) return noent;
    const s = statSync(p), k = s.isDirectory() ? 'directory' : 'regular file';
    return out(`${k}\n${k}|${s.size}|${Math.floor(s.mtimeMs / 1000)}|0\n`); // %W 0: no birth time
  }
  if (script.startsWith('dd ')) { const n = Number(args[1]), i = Number(args[2]); return existsSync(p) ? out(readFileSync(p).subarray(i * n, (i + 1) * n).toString('base64')) : noent; }
  if (script.startsWith('[ -e')) return out('', existsSync(p) ? 0 : 1);
  if (script.includes('mv --')) { const to = host(args[1]); if (existsSync(to)) return out('', 17, 'File exists'); mkdirSync(dirname(to), { recursive: true }); renameSync(p, to); return out(''); }
  throw new Error('unexpected script ' + script);
}
const runner = Bun.serve({ port: 0, async fetch(req: Request) {
  const u = new URL(req.url);
  if (req.headers.get('x-hefyn-internal') !== 'tok') return Response.json({ error: 'no' }, { status: 401 });
  if (u.pathname === '/sandboxes') return Response.json({ id: 'sbx' });
  if (u.pathname === '/sandboxes/sbx/exec') {
    execs++;
    const b: any = await req.json();
    return Response.json(sh(b.cmd, Buffer.from(b.stdin ?? '', 'base64'), b.maxOutput ?? 1 << 20));
  }
  return Response.json({ error: 'nope' }, { status: 404 });
} });
process.env.HEFYN_RUNNER_URL = `http://127.0.0.1:${runner.port}`;

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { shellEnabled } = await import('../src/server/runner.ts');
const app = new Hono().route('/api', api);
const PW = 'password-12345';
const r0 = await auth.api.signUpEmail({ body: { name: 'c', email: 'c@x.test', password: PW } });
db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r0.user.id, 'worker');
const cookie = (await auth.api.signInEmail({ body: { email: 'c@x.test', password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const f = (path: string, init: RequestInit = {}) => app.request(`/api/files${path}`, { ...init, headers: { ...init.headers, cookie } });
const q = encodeURIComponent;
const put = (path: string, text: string, extra = '') => f(`/content?path=${q(path)}${extra}`, { method: 'PUT', body: text });

test('the routes really take the container path', () => assert.ok(shellEnabled(r0.user.id)));

test('write, list, stat, download in the container', async () => {
  const first = await (await put('notes/a.md', 'héllo', '&new=1')).json() as any;
  assert.equal(first.size, 6);
  const list = (await (await f('?path=notes')).json() as any).entries;
  assert.deepEqual(list.map((e: any) => [e.name, e.type, e.size]), [['a.md', 'file', 6]]);
  const d = await f('/download?path=notes/a.md');
  assert.equal(d.headers.get('content-length'), '6');
  assert.equal(d.headers.get('content-security-policy'), 'sandbox');
  assert.equal(await d.text(), 'héllo');
  const s = await (await f('/stat?path=notes/a.md')).json() as any;
  assert.deepEqual([s.path, s.type, s.size, s.created], ['/files/notes/a.md', 'file', 6, null]); // no birth time in the container: null, not 1970
  assert.equal(Date.parse(s.mtime), Date.parse(first.mtime));
  assert.equal((await f('/stat?path=nope')).status, 404);
  assert.equal(await (await f('?path=nope')).text(), '{"error":"/files/nope: not found"}');
  assert.equal(await (await f('/download?path=nope.txt')).text(), '{"error":"/files/nope.txt: not found"}'); // not the raw stat stderr
  assert.equal((await f('/download?path=notes')).status, 400);
});

test('second-resolution mtime: the list value (with fractions) saves, a stale one conflicts', async () => {
  await put('m.txt', 'one', '&new=1');
  const listed = (await (await f('')).json() as any).entries.find((e: any) => e.name === 'm.txt');
  const sameSecond = new Date(Math.floor(Date.parse(listed.mtime) / 1000) * 1000 + 400).toISOString();
  assert.equal((await put('m.txt', 'two', `&mtime=${q(listed.mtime)}`)).status, 200);
  assert.equal((await put('m.txt', 'three', `&mtime=${q(sameSecond)}`)).status, 200); // another fraction of the same second: no false conflict
  utimesSync(host('/files/m.txt'), new Date(), new Date(Date.now() + 120_000)); // the agent edited it
  assert.equal((await put('m.txt', 'four', `&mtime=${q(listed.mtime)}`)).status, 409);
  assert.equal(await (await f('/download?path=m.txt')).text(), 'three');
  assert.equal((await put('m.txt', 'five')).status, 200);
});

test('upload, unique names, rename, delete', async () => {
  const form = (name: string, content: Uint8Array<ArrayBuffer>) => { const d = new FormData(); d.append('file', new File([content], name)); return { method: 'POST', body: d } as RequestInit; };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1]);
  assert.equal(((await (await f('/upload?dir=pics', form('a.png', png))).json()) as any).saved[0].path, '/pics/a.png');
  assert.equal(((await (await f('/upload?dir=pics', form('a.png', png))).json()) as any).saved[0].path, '/pics/a (1).png');
  assert.deepEqual([...new Uint8Array(await (await f('/download?path=pics/a.png')).arrayBuffer())], [...png]); // binary round-trips
  const mv = (from: string, to: string) => f('/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) });
  assert.equal((await mv('pics/a.png', 'pics/b.png')).status, 200);
  assert.equal((await mv('pics/b.png', 'pics/a (1).png')).status, 409);
  assert.equal((await f('?path=pics', { method: 'DELETE' })).status, 200);
  assert.equal((await f('?path=pics')).status, 404);
});

test('a file over the base64 read limit still downloads, in chunks', async () => {
  const big = Buffer.alloc(40 * 1048576 + 5, 7); big.write('head', 0); big.write('tail', big.length - 4); // 40 MB: its base64 alone is over READ_LIMIT
  mkdirSync(host('/files'), { recursive: true }); writeFileSync(host('/files/big.bin'), big);
  execs = 0;
  const d = await f('/download?path=big.bin');
  assert.equal(d.status, 200); assert.equal(d.headers.get('content-length'), String(big.length));
  const got = Buffer.from(await d.arrayBuffer());
  assert.equal(got.length, big.length);
  assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(big).digest('hex'));
  assert.ok(execs >= 3, 'stat plus two chunks');
  await put('zero.txt', '', '&new=1');
  assert.equal((await (await f('/download?path=zero.txt')).arrayBuffer()).byteLength, 0);
});
