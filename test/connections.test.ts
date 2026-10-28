import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { startFakeFsMcp } from './fake-fs-mcp.ts';
import { startFakeWebdav } from './fake-webdav.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-conns-'));
process.env.HEFYN_SECRET = 'conns-test-secret-conns-test-secret-1234';
delete process.env.HEFYN_RUNNER_URL; // host userFs path
process.env.HEFYN_ALLOW_PRIVATE_URLS = '1'; // the fakes listen on 127.0.0.1 (http)

const { trpcCall } = await import('./trpc.ts');
const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { createConnector } = await import('../src/server/mcp.ts');
const { webdavAdapter } = await import('../src/server/connections/webdav.ts');
const { sftpConnect, sftpProvider, fingerprint } = await import('../src/server/connections/sftp.ts');
const { ftpProvider } = await import('../src/server/connections/ftp.ts');
const { webdavProvider } = await import('../src/server/connections/webdav.ts');
const { readAll } = await import('../src/server/connections/types.ts');
const { fsFor } = await import('../src/server/runner.ts');
const app = new Hono().route('/api', api);
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const read = async (userId: string, p: string) => Buffer.from(await fsFor(userId).readFileBuffer(p)).toString();
const closers: (() => void)[] = [];
after(() => { closers.forEach((c) => c()); setTimeout(() => process.exit(0), 500).unref(); });

const PW = 'password-12345';
async function mk(email: string, role = 'worker') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: r.user.id, tr: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
const ann = await mk('ann@x.test'), bob = await mk('bob@x.test');

async function dav() { const d = await startFakeWebdav({ users: { ada: 'dav-secret-pw' } }); closers.push(d.close); return d; }

test('WebDAV adapter: list, read, write (creates parents), mkdir, rename, delete, etag', async () => {
  const d = await dav();
  const a = webdavAdapter({ url: d.base, username: 'ada', password: 'dav-secret-pw' });
  await a.write('/docs/q3/report.txt', Buffer.from('hello'));
  assert.deepEqual((await a.list('')).map((e) => `${e.type}:${e.name}`), ['dir:docs']);
  assert.deepEqual((await a.list('/docs/q3')).map((e) => [e.name, e.size]), [['report.txt', 5]]);
  assert.equal(text(await readAll(await a.read('/docs/q3/report.txt'))), 'hello');
  await a.mkdir('/a/b'); await a.mkdir('/a/b');
  await a.rename('/docs/q3/report.txt', '/docs/final/r.txt');
  assert.equal(d.files.get('/docs/final/r.txt')?.toString(), 'hello');
  await a.delete('/docs/final/r.txt');
  assert.ok(!d.files.has('/docs/final/r.txt'));
  await assert.rejects(webdavAdapter({ url: d.base, username: 'ada', password: 'wrong' }).list(''), /login failed/);
  await assert.rejects(a.list('../x'), (e: any) => e.status === 403);
});

test('WebDAV adapter: foreign hrefs in a listing are ignored, redirects to another host are refused', async () => {
  const evil = await startFakeWebdav({ users: { ada: 'pw' }, evil: true }); closers.push(evil.close);
  const a = webdavAdapter({ url: evil.base, username: 'ada', password: 'pw' });
  assert.deepEqual(await a.list(''), []);
  const redir = await startFakeWebdav({ users: { ada: 'pw' }, redirectTo: 'http://127.0.0.1:1/steal' }); closers.push(redir.close);
  await assert.rejects(webdavAdapter({ url: `${redir.base}/redir`, username: 'ada', password: 'pw' }).list(''), /redirected to another host/);
});

test('private addresses are refused without HEFYN_ALLOW_PRIVATE_URLS=1 (every provider)', async () => {
  delete process.env.HEFYN_ALLOW_PRIVATE_URLS;
  try {
    const ctx = { userId: 'x', pin() {} };
    await assert.rejects(webdavProvider.connect({ url: 'https://10.0.0.5/dav', username: 'a' }, { password: 'p' }, ctx), /HEFYN_ALLOW_PRIVATE_URLS/);
    await assert.rejects(webdavProvider.connect({ url: 'http://example.com/dav', username: 'a' }, { password: 'p' }, ctx), /https/);
    await assert.rejects(sftpProvider.connect({ host: '192.168.1.10', username: 'a' }, { password: 'p' }, ctx), /HEFYN_ALLOW_PRIVATE_URLS/);
    await assert.rejects(sftpProvider.connect({ host: 'localhost', username: 'a' }, { password: 'p' }, ctx), /HEFYN_ALLOW_PRIVATE_URLS/);
    await assert.rejects(ftpProvider.connect({ host: '169.254.169.254', username: 'a' }, { password: 'p' }, ctx), /HEFYN_ALLOW_PRIVATE_URLS/);
  } finally { process.env.HEFYN_ALLOW_PRIVATE_URLS = '1'; }
});

test('plain FTP is refused unless the admin allows it; credentials never go in the URL', async () => {
  delete process.env.HEFYN_ALLOW_PLAIN_FTP;
  await assert.rejects(ftpProvider.connect({ host: '93.184.216.34', username: 'a', security: 'plain' }, { password: 'p' }, { userId: 'x', pin() {} }), /HEFYN_ALLOW_PLAIN_FTP=1/);
  await assert.rejects(webdavProvider.connect({ url: 'https://u:p@example.com/dav', username: 'a' }, { password: 'p' }, { userId: 'x', pin() {} }), /own fields/);
});

// ---- SFTP against an in-process ssh2 server (password login, one folder with one file) ----
function sshd() {
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');
  const { STATUS_CODE } = utils.sftp;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'ada' && ctx.password === 'ssh-secret-pw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => {
      const sftp = acceptSftp(), done = new Set<number>();
      sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p, longname: p, attrs: {} as any }]));
      sftp.on('STAT', (id, p) => (p === '/' ? sftp.attrs(id, { mode: 0o40755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)));
      sftp.on('OPENDIR', (id) => { const h = Buffer.alloc(4); h.writeUInt32BE(done.size + 1); sftp.handle(id, h); });
      sftp.on('READDIR', (id, h) => {
        const k = h.readUInt32BE(0);
        if (done.has(k)) return sftp.status(id, STATUS_CODE.EOF);
        done.add(k);
        sftp.name(id, [{ filename: 'hello.txt', longname: '-rw-r--r-- 1 u g 5 Jan 1 00:00 hello.txt', attrs: { mode: 0o100644, size: 5, uid: 0, gid: 0, atime: 0, mtime: 1_700_000_000 } }]);
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
    })));
  });
  return new Promise<{ port: number; fp: string }>((ok) => server.listen(0, '127.0.0.1', () => {
    closers.push(() => server.close());
    const parsed = utils.parseKey(hostKey) as any;
    ok({ port: (server.address() as AddressInfo).port, fp: fingerprint(parsed.getPublicSSH()) });
  }));
}

test('SFTP: lists over a real SSH session, pins the host key, refuses a changed key and a wrong password', async () => {
  const a = await sshd(), b = await sshd();
  let pinned = '';
  const opts = (port: number, password = 'ssh-secret-pw') => ({ host: '127.0.0.1', port, username: 'ada', password });
  const ad = await sftpConnect(opts(a.port), { pin: (fp) => { pinned = fp; } });
  assert.deepEqual((await ad.list('/')).map((e) => [e.name, e.type, e.size]), [['hello.txt', 'file', 5]]);
  await ad.close?.();
  assert.equal(pinned, a.fp);
  // same pin, other server key: refused
  await assert.rejects(sftpConnect(opts(b.port), { hostKey: a.fp, pin() {} }), (e: any) => e.status === 409 && /host key changed/.test(e.message));
  await sftpConnect(opts(a.port), { hostKey: a.fp, pin() {} }).then((x) => x.close?.()); // the pinned key still works
  await assert.rejects(sftpConnect(opts(a.port, 'nope'), { pin() {} }), /SFTP connection failed/);
  assert.notEqual(a.fp, b.fp);
});

// ---- the API ----
test('connections API: create tests the login first, secrets never come back, sync brings files into /files/<name>', async () => {
  const d = await dav();
  d.files.set('/hello.txt', Buffer.from('hi from dav'));
  const kinds = (await ann.tr('connections.kinds')).json as any[];
  assert.deepEqual(kinds.map((k) => k.kind).sort(), ['ftp', 'mcp', 'sftp', 'webdav']);
  assert.ok(kinds.find((k) => k.kind === 'webdav').fields.some((f: any) => f.type === 'secret'));

  const bad = await ann.tr('connections.create', { kind: 'webdav', name: 'Work', config: { url: d.base, username: 'ada' }, secrets: { password: 'wrong' } }, true);
  assert.equal(bad.status, 400);
  assert.match(bad.error!, /Could not connect/);
  assert.equal(((await ann.tr('connections.list')).json as any[]).length, 0);

  const made = await ann.tr('connections.create', { kind: 'webdav', name: 'Work', config: { url: d.base, username: 'ada' }, secrets: { password: 'dav-secret-pw' } }, true);
  assert.equal(made.status, 200, String(made.error));
  const id = made.json.id;
  assert.equal(made.json.path, '/files/Work');
  assert.deepEqual(made.json.secretsSet, ['password']);

  const s = await ann.tr('connections.syncNow', { id }, true);
  assert.equal(s.json.downloaded, 1, String(s.error));
  assert.equal(await read(ann.id, '/files/Work/hello.txt'), 'hi from dav');
  await fsFor(ann.id).writeFile('/files/Work/up.txt', 'from hefyn');
  await ann.tr('connections.syncNow', { id }, true);
  assert.equal(d.files.get('/up.txt')?.toString(), 'from hefyn');

  const st = (await ann.tr('connections.status', { id })).json;
  assert.equal(st.status, 'ok');
  assert.ok(st.lastSyncAt);
  const everything = JSON.stringify([made.json, st, (await ann.tr('connections.list')).json, kinds, s.json, (await ann.tr('connections.test', { id }, true)).json]);
  assert.ok(!everything.includes('dav-secret-pw'), 'no secret in any API output');
  const raw = JSON.stringify(db.prepare('SELECT * FROM connections').all());
  assert.ok(!raw.includes('dav-secret-pw'), 'sealed at rest');

  // user B sees and reaches nothing of A's
  assert.equal(((await bob.tr('connections.list')).json as any[]).length, 0);
  for (const [p, mutate] of [['status', false], ['test', true], ['syncNow', true]] as const) assert.equal((await bob.tr(`connections.${p}`, { id }, mutate)).status, 404, p);
  assert.equal((await bob.tr('connections.update', { id, name: 'x' }, true)).status, 404);
  assert.equal((await bob.tr('connections.delete', { id, keepLocalCopy: false }, true)).status, 404);
  assert.equal((await fsFor(bob.id).list('/files')).length, 0);

  // update keeps a blank secret; delete can keep the local copy
  const up = await ann.tr('connections.update', { id, name: 'Work 2', secrets: { password: '' } }, true);
  assert.equal(up.status, 200, String(up.error));
  assert.equal(up.json.name, 'Work 2');
  assert.equal(up.json.folder, 'Work');
  assert.equal((await ann.tr('connections.delete', { id, keepLocalCopy: true }, true)).status, 200);
  assert.equal(await read(ann.id, '/files/Work/hello.txt'), 'hi from dav');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_state WHERE connection_id = ?').get(id)!.n, 0);
});

test('the folder name is unique and never takes over an existing folder; delete without keepLocalCopy removes the folder', async () => {
  const d = await dav();
  const body = (name: string) => ({ kind: 'webdav', name, config: { url: d.base, username: 'ada' }, secrets: { password: 'dav-secret-pw' } });
  await fsFor(bob.id).mkdir('/files/Docs', { recursive: true });
  assert.equal((await bob.tr('connections.create', body('docs'), true)).status, 409);
  const odd = await bob.tr('connections.create', body('a/b: c?'), true);
  assert.equal(odd.json.folder, 'a-b- c-');
  assert.equal((await bob.tr('connections.create', body('A-B- C-'), true)).status, 409);
  await fsFor(bob.id).writeFile('/files/a-b- c-/x.txt', 'x');
  assert.equal((await bob.tr('connections.delete', { id: odd.json.id, keepLocalCopy: false }, true)).status, 200);
  assert.ok(!(await fsFor(bob.id).exists('/files/a-b- c-')));
  assert.ok(await fsFor(bob.id).exists('/files/Docs'));
});

test('MCP connection: a connector with filesystem tools syncs text files', async () => {
  const m = await startFakeFsMcp(); closers.push(m.close);
  m.files.set('/data/note.txt', 'from mcp');
  const connectorId = createConnector(ann.id, { name: 'fs', url: m.url });
  const made = await ann.tr('connections.create', { kind: 'mcp', name: 'Mcp', config: { connectorId }, secrets: {} }, true);
  assert.equal(made.status, 200, String(made.error));
  assert.equal((await ann.tr('connections.syncNow', { id: made.json.id }, true)).json.downloaded, 1);
  assert.equal(await read(ann.id, '/files/Mcp/note.txt'), 'from mcp');
  await fsFor(ann.id).writeFile('/files/Mcp/new.txt', 'to mcp');
  await ann.tr('connections.syncNow', { id: made.json.id }, true);
  assert.equal(m.files.get('/data/new.txt'), 'to mcp');
  assert.equal((await bob.tr('connections.create', { kind: 'mcp', name: 'Steal', config: { connectorId }, secrets: {} }, true)).status, 400, "another user's connector is not pickable");
});
