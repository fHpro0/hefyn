import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import { requests, startFake } from './fake-anthropic.ts';
import { type FakeDav, startFakeWebdav } from './fake-webdav.ts';
import { startFakeFsMcp } from './fake-fs-mcp.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-addons-'));
process.env.HEFYN_SECRET = 'addons-test-secret-addons-test-secret-1234';
process.env.HEFYN_ALLOW_PRIVATE_URLS = '1'; // the fakes listen on 127.0.0.1 (http)
const RPORT = 4900 + Math.floor(Math.random() * 200);
const TOKEN = process.env.HEFYN_INTERNAL_TOKEN ?? 'hefyn-dev-internal-token';
process.env.HEFYN_REDACT_URL = `http://127.0.0.1:${RPORT}`;

let redact: ChildProcess;
let fake: Awaited<ReturnType<typeof startFake>>;
before(async () => {
  fake = await startFake();
  redact = spawn('node', ['dist/redact-server.mjs'], { env: { ...process.env, HEFYN_REDACT_GLINER: 'off', PORT: String(RPORT), HEFYN_REDACT_HOST: '127.0.0.1', HEFYN_INTERNAL_TOKEN: TOKEN }, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${RPORT}/live`, { headers: { 'x-hefyn-internal': TOKEN } }).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
});
// (importing the real auth module for the API test leaves a timer behind: leave 1 s for the reporter, then exit)
after(() => { redact?.kill(); fake?.close(); setTimeout(() => process.exit(0), 1000).unref(); });

const lib = () => import('../src/server/storage-addons.ts');
const dav = (users: Record<string, string> = { ada: 'pw' }, o: { redirectTo?: string; evil?: boolean } = {}) => startFakeWebdav({ users, ...o });
const ada = (d: FakeDav, extra: object = {}) => ({ url: d.base, username: 'ada', password: 'pw', ...extra });
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const status = async (p: Promise<unknown>, code: number) => assert.rejects(p, (e: any) => e.status === code, `expected ${code}`);

test('WebDAV adapter: list, stat, read, write (creates parents), mkdir, rename, delete', async () => {
  const d = await dav(); const { webdavAdapter, readAll } = await lib();
  const a = webdavAdapter(ada(d));
  await a.write('/docs/q3/report.txt', Buffer.from('hello')); // parents do not exist: MKCOL then PUT
  await a.write('/note with space & ü.txt', Buffer.from('x'));
  assert.deepEqual((await a.list('/')).map((e) => `${e.type}:${e.name}`).sort(), ['dir:docs', 'file:note with space & ü.txt']);
  assert.deepEqual((await a.list('/docs/q3')).map((e) => [e.name, e.size]), [['report.txt', 5]]);
  assert.equal(text(await readAll(await a.read('/docs/q3/report.txt'))), 'hello');
  const st = await a.stat('/docs/q3/report.txt');
  assert.deepEqual([st.type, st.size, st.mtime], ['file', 5, '2026-10-14T10:00:00.000Z']);
  assert.equal((await a.stat('/docs')).type, 'dir');
  await a.mkdir('/a/b/c'); await a.mkdir('/a/b/c'); // recursive and idempotent
  assert.ok(d.files.has('/a/b/c'));
  await a.rename('/docs/q3/report.txt', '/docs/final/report-v2.txt'); // missing target parent is created
  assert.equal(d.files.get('/docs/final/report-v2.txt')?.toString(), 'hello');
  await status(a.rename('/note with space & ü.txt', '/docs/final/report-v2.txt'), 409); // never overwrites
  await a.delete('/docs');
  assert.ok(!d.files.has('/docs/final/report-v2.txt'));
  await status(a.read('/nope.txt'), 404);
  await status(a.delete('/'), 403);
  d.close();
});

test('WebDAV adapter: auth failure, path traversal, foreign hrefs, redirects, size limit', async () => {
  const other = await dav({ ada: 'pw' }); // a second host a redirect points at
  const d = await dav({ ada: 'pw' }, { redirectTo: other.base + '/stolen', evil: true });
  const { webdavAdapter, readAll } = await lib();
  await status(webdavAdapter(ada(d, { password: 'wrong' })).list('/'), 502); // 401 -> a clear error, not a session logout
  await assert.rejects(webdavAdapter(ada(d, { password: 'wrong' })).list('/'), /login failed/);
  const a = webdavAdapter(ada(d));

  for (const p of ['/../x', '/a/../../x', '..', '/a/..', '/a/./b', '/a\\b', '/a\0b', '/' + 'x'.repeat(300)]) {
    await assert.rejects(a.read(p), (e: any) => e.status === 403 || e.status === 400, p);
    await assert.rejects(a.write(p, Buffer.from('x')), () => true, p);
    await assert.rejects(a.delete(p), () => true, p);
  }
  assert.ok(!d.log.some((r) => r.url.includes('..')), 'nothing with .. ever reached the server');
  // encoded dots are a literal file name (sent double-encoded), not a traversal
  await a.write('/%2e%2e/x.txt', Buffer.from('lit'));
  assert.ok(d.log.some((r) => r.method === 'PUT' && r.url === '/dav/%252e%252e/x.txt'));
  assert.ok(d.files.has('/%2e%2e/x.txt'));

  // a server naming paths outside the base is ignored
  assert.deepEqual((await a.list('/')).map((e) => e.name), ['%2e%2e']);

  // redirect to another host: refused, the credentials never reach it
  await assert.rejects(a.read('/redir'), /another host/);
  assert.equal(other.log.length, 0);

  // size limit on read (stream) and write
  process.env.HEFYN_MAX_UPLOAD_MB = '1';
  d.files.set('/big.bin', Buffer.alloc(1024 * 1024 + 1));
  await status(a.read('/big.bin'), 413);
  await status(a.write('/big2.bin', Buffer.alloc(1024 * 1024 + 1)), 413);
  await a.write('/ok.bin', Buffer.alloc(1024 * 1024)); // exactly the limit is fine
  assert.equal((await readAll(await a.read('/ok.bin'))).length, 1024 * 1024);
  delete process.env.HEFYN_MAX_UPLOAD_MB;
  d.close(); other.close();
});

test('assertWebdavUrl: https only, private hosts and embedded credentials refused', async () => {
  const { assertWebdavUrl } = await lib();
  assert.equal(assertWebdavUrl('https://cloud.example.com/remote.php/dav/files/ada/'), 'https://cloud.example.com/remote.php/dav/files/ada/');
  assert.throws(() => assertWebdavUrl('https://ada:pw@cloud.example.com/dav'), /own fields/);
  const keep = process.env.HEFYN_ALLOW_PRIVATE_URLS;
  delete process.env.HEFYN_ALLOW_PRIVATE_URLS;
  assert.throws(() => assertWebdavUrl('http://cloud.example.com/dav'), /https/);
  assert.throws(() => assertWebdavUrl('https://127.0.0.1/dav'), /private/);
  assert.throws(() => assertWebdavUrl('https://192.168.1.5/dav'), /private/);
  assert.throws(() => assertWebdavUrl('https://nas/dav'), /private/);
  process.env.HEFYN_ALLOW_PRIVATE_URLS = keep;
});

test('MCP storage adapter: filesystem tools mapped; read-only without write tools', async () => {
  const full = await startFakeFsMcp(), ro = await startFakeFsMcp({ readOnly: true });
  const { createConnector, connectorFor } = await import('../src/server/mcp.ts');
  const { createMcpAddon, adapterFor, readAll } = await lib();
  const mk = (url: string, name: string) => { const id = createConnector('alice', { name, url, auth: 'none' }); return adapterFor('alice', createMcpAddon('alice', name, connectorFor('alice', id)!)); };
  const a = mk(full.url, 'fsfull');
  assert.deepEqual(await a.caps(), { write: true, mkdir: true, rename: true, delete: false });
  await a.write('/notes/a.txt', Buffer.from('hello mcp'));
  assert.equal(full.files.get('/data/notes/a.txt'), 'hello mcp'); // rooted at the server's allowed directory
  assert.deepEqual((await a.list('/notes')).map((e) => [e.name, e.type, e.size]), [['a.txt', 'file', 0.01 * 1024 > 9 ? 10 : 10]]);
  assert.deepEqual((await a.list('/')).map((e) => [e.name, e.type]), [['notes', 'dir']]);
  assert.equal(text(await readAll(await a.read('/notes/a.txt'))), 'hello mcp');
  assert.deepEqual([(await a.stat('/notes/a.txt')).size, (await a.stat('/notes')).type], [9, 'dir']);
  await a.rename('/notes/a.txt', '/notes/b.txt');
  assert.equal(full.files.get('/data/notes/b.txt'), 'hello mcp');
  await status(a.read('/missing.txt'), 404);
  await assert.rejects(a.read('/../etc/passwd'), (e: any) => e.status === 403);
  await status(a.delete('/notes/b.txt'), 403); // the official server has no delete tool
  await status(a.write('/bin.dat', Buffer.from([0xff, 0xfe, 0x00])), 415); // text only

  const r = mk(ro.url, 'fsro');
  assert.equal((await r.caps()).write, false);
  assert.equal((await r.list('/')).length, 0);
  await status(r.write('/x.txt', Buffer.from('x')), 403);
  await status(r.mkdir('/d'), 403);
  await status(r.rename('/a', '/b'), 403);
  full.close(); ro.close();
});

test('mount routing: add-on vs local, shadowing, cross-mount moves, no local quota, names', async () => {
  const d = await dav(); const { createWebdav, withAddons, checkName, addonAt, isAddonPath } = await lib();
  const { userFs } = await import('../src/server/storage.ts');
  const local = userFs({ userId: 'carol' });
  await local.writeFile('/files/plain.txt', 'local');
  await local.writeFile('/files/nc/shadowed.txt', 'hidden by the add-on'); // a local folder named like the add-on
  createWebdav('carol', { name: 'NC', url: d.base, username: 'ada', password: 'pw' });
  const fs = withAddons(userFs({ userId: 'carol' }), 'carol');

  assert.deepEqual((await fs.readdir('/files')).sort(), ['nc', 'plain.txt']);
  const root = await fs.list('/files');
  assert.equal(root.find((e) => e.name === 'nc')?.type, 'dir');
  assert.equal((root.find((e) => e.name === 'nc') as any).addon.kind, 'webdav');
  assert.equal(root.filter((e) => e.name === 'nc').length, 1); // the local folder is shadowed, not duplicated
  assert.equal(await fs.readFile('/files/plain.txt'), 'local'); // local paths untouched

  await fs.writeFile('/files/nc/sub/doc.txt', 'remote');
  assert.equal(d.files.get('/sub/doc.txt')?.toString(), 'remote');
  assert.ok(!(await local.exists('/files/nc/sub')), 'never written to the local disk');
  assert.equal(await fs.readFile('/files//nc/./sub/doc.txt'), 'remote'); // normalised before routing
  assert.equal((await fs.stat('/files/nc')).isDirectory, true);
  assert.equal(addonAt('carol', '/files/nc/sub')?.name, 'nc');
  assert.equal(isAddonPath('carol', '/files/plain.txt'), false);
  assert.equal(isAddonPath('carol', '/files/ncx/a'), false);
  assert.equal(await fs.uniqueName('/files/nc/sub', 'doc.txt'), '/files/nc/sub/doc (1).txt');

  // moves across mounts and of the mount itself are refused
  await status(fs.rename('/files/plain.txt', '/files/nc/plain.txt'), 400);
  await status(fs.rename('/files/nc/sub/doc.txt', '/files/plain2.txt'), 400);
  await status(fs.rename('/files/nc', '/files/other'), 400);
  await status(fs.rm('/files/nc', { recursive: true }), 403);
  await fs.rename('/files/nc/sub/doc.txt', '/files/nc/sub/doc2.txt');
  await fs.rm('/files/nc/sub', { recursive: true });
  assert.equal(d.files.has('/sub'), false);

  // add-on bytes do not count against the local quota: with a zero quota local writes fail, add-on writes work
  process.env.HEFYN_USER_QUOTA_MB = '0';
  await status(fs.writeFile('/files/more.txt', 'x'), 413);
  await fs.writeFile('/files/nc/more.txt', 'x');
  delete process.env.HEFYN_USER_QUOTA_MB;

  // names: lowercase slug, unique among what the user can see
  assert.throws(() => checkName('carol', 'nc'), /already exists/);
  for (const bad of ['', 'Has Space', '../x', 'a/b', '-lead', 'x'.repeat(41)]) assert.throws(() => checkName('carol', bad), /name:/);
  d.close();
});

test('Files API: add-on folders listed, uploads, downloads (attachment), rename, delete, mkdir through /files/<add-on>/', async () => {
  const d = await dav(); const { createWebdav } = await lib();
  createWebdav('erin', { name: 'cloud', url: d.base, username: 'ada', password: 'pw' });
  const { storageRoutes } = await import('../src/server/storage-routes.ts');
  const app = new Hono();
  app.route('/api', storageRoutes(() => 'erin'));
  const j = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;
  const q = encodeURIComponent;

  const root = await j(app.request('/api/files'));
  assert.equal(root.addon, null);
  assert.deepEqual(root.entries.map((e: any) => [e.name, e.type, e.addon?.kind]), [['cloud', 'dir', 'webdav']]);

  process.env.HEFYN_USER_QUOTA_MB = '0'; // local quota exhausted: uploading to the add-on still works
  const fd = new FormData(); fd.append('f', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
  const up = await app.request('/api/files/upload?dir=cloud/inbox', { method: 'POST', body: fd });
  assert.equal(up.status, 200, await up.clone().text());
  delete process.env.HEFYN_USER_QUOTA_MB;
  assert.equal(d.files.get('/inbox/x.html')?.toString(), '<script>alert(1)</script>');
  const listed = await j(app.request(`/api/files?path=${q('cloud/inbox')}`));
  assert.deepEqual([listed.addon.name, listed.entries.map((e: any) => e.name)], ['cloud', ['x.html']]);

  const dl = await app.request(`/api/files/download?path=${q('cloud/inbox/x.html')}`);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await dl.text(), '<script>alert(1)</script>');

  const post = (path: string, body: object) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/files/mkdir', { path: 'cloud/new/deep' })).status, 200);
  assert.ok(d.files.has('/new/deep'));
  assert.equal((await post('/api/files/rename', { from: 'cloud/inbox/x.html', to: 'cloud/inbox/y.html' })).status, 200);
  assert.ok(d.files.has('/inbox/y.html'));
  assert.equal((await post('/api/files/rename', { from: 'cloud/inbox/y.html', to: 'local.html' })).status, 400);
  assert.equal((await app.request(`/api/files?path=${q('cloud/inbox/y.html')}`, { method: 'DELETE' })).status, 200);
  assert.ok(!d.files.has('/inbox/y.html'));
  assert.equal((await app.request(`/api/files?path=${q('cloud/../../etc')}`)).status, 403);
  d.close();
});

test('agent sandbox: read/write/list tools reach the add-on, shell exec stays unsupported', async () => {
  const d = await dav(); const { createWebdav } = await lib();
  createWebdav('frank', { name: 'nas', url: d.base, username: 'ada', password: 'pw' });
  const { userSandboxFactory } = await import('../src/server/storage-sandbox.ts');
  const f = userSandboxFactory({ userId: 'frank', conversationId: 'u_frank_01A' });
  const sb = await f.createSandbox!({} as any);
  const tools: any[] = f.tools!(sb as any, {} as any) as any;
  const tool = (n: string) => tools.find((t) => t.name === n);
  await sb.writeFile('/files/nas/agent.txt', 'from the agent');
  assert.equal(d.files.get('/agent.txt')?.toString(), 'from the agent');
  assert.equal(await sb.readFile('/files/nas/agent.txt'), 'from the agent');
  const out = await tool('list').execute('1', { path: '/files' });
  assert.match(out.content[0].text, /\/files\/nas\//); // shown as a folder
  const inner = await tool('list').execute('1', { path: '/files/nas' });
  assert.match(inner.content[0].text, /agent\.txt/);
  await assert.rejects(sb.exec('cat /files/nas/agent.txt'), /container sandbox/);
  d.close();
});

test('per-user isolation: a private add-on is invisible to others; team add-ons use per-user credentials', async () => {
  const d = await dav({ ada: 'pw-ada', bob: 'pw-bob' });
  const { createWebdav, withAddons, addonByName, addonById, setCreds, visibleAddons, adapterFor } = await lib();
  const { userFs } = await import('../src/server/storage.ts');
  const priv = createWebdav('ada', { name: 'private-box', url: d.base, username: 'ada', password: 'pw-ada' });
  const adaFs = withAddons(userFs({ userId: 'ada' }), 'ada'), bobFs = withAddons(userFs({ userId: 'bob' }), 'bob');
  await adaFs.writeFile('/files/private-box/secret.txt', 'ada only');
  assert.equal(addonByName('bob', 'private-box'), undefined);
  assert.equal(addonById('bob', priv.id), undefined);
  assert.ok(!visibleAddons('bob').some((a) => a.id === priv.id));
  // bob's path with the same name is just his own local folder: ada's remote is untouched and unreadable
  await bobFs.writeFile('/files/private-box/mine.txt', 'bob local');
  assert.ok(!d.files.has('/mine.txt'));
  await assert.rejects(bobFs.readFile('/files/private-box/secret.txt'), (e: any) => e.status === 404);
  assert.deepEqual((await bobFs.readdir('/files')).sort(), ['private-box']); // his local folder, no add-on entry
  assert.equal(((await bobFs.list('/files'))[0] as any).addon, undefined);

  // team add-on: shared definition, but nobody acts as someone else
  const team = createWebdav('ada', { name: 'team-share', url: d.base, username: 'ada', password: 'pw-ada', visibility: 'team' });
  await adaFs.writeFile('/files/team-share/by-ada.txt', 'x');
  assert.ok(visibleAddons('bob').some((a) => a.id === team.id));
  await assert.rejects(bobFs.readFile('/files/team-share/by-ada.txt'), (e: any) => e.status === 409 && /username and app password/.test(e.message)); // no creds of his own yet
  setCreds(team, 'bob', { username: 'bob', password: 'pw-bob' });
  assert.equal(await bobFs.readFile('/files/team-share/by-ada.txt'), 'x');
  await bobFs.writeFile('/files/team-share/by-bob.txt', 'y');
  const users = d.log.filter((r) => r.method === 'PUT' && r.url.includes('team-share') === false && r.url.includes('by-')).map((r) => `${r.url}:${r.user}`);
  assert.deepEqual(users, ['/dav/by-ada.txt:ada', '/dav/by-bob.txt:bob']);
  setCreds(team, 'bob', { username: 'bob', password: 'wrong' });
  await assert.rejects(bobFs.readFile('/files/team-share/by-ada.txt'), /login failed/); // bob's own failure; ada is unaffected
  assert.equal(await adaFs.readFile('/files/team-share/by-ada.txt'), 'x');

  // shared account: explicit, one login for everyone
  const shared = createWebdav('ada', { name: 'shared-acct', url: d.base, username: 'ada', password: 'pw-ada', visibility: 'team', sharedAccount: true });
  await adaFs.writeFile('/files/shared-acct/s.txt', 'z');
  assert.equal(await bobFs.readFile('/files/shared-acct/s.txt'), 'z');
  assert.equal(d.log.filter((r) => r.url === '/dav/s.txt').every((r) => r.user === 'ada'), true);
  void shared; void adapterFor;
  // a private add-on cannot be shared by flag alone
  const solo = createWebdav('ada', { name: 'solo', url: d.base, username: 'ada', password: 'pw-ada', sharedAccount: true });
  assert.equal(solo.shared, 0);
  d.close();
});

test('MCP storage add-on: a private connector is unusable by others; team connector uses each user\'s own sign-in', async () => {
  const m = await startFakeFsMcp();
  const { createConnector, connectorFor } = await import('../src/server/mcp.ts');
  const { createMcpAddon, withAddons, visibleAddons } = await lib();
  const { userFs } = await import('../src/server/storage.ts');
  const id = createConnector('gina', { name: 'gina files', url: m.url, auth: 'none' });
  assert.equal(connectorFor('hal', id), undefined, 'a private connector cannot even be marked by someone else');
  createMcpAddon('gina', 'gina-fs', connectorFor('gina', id)!);
  assert.ok(!visibleAddons('hal').some((a) => a.name === 'gina-fs'));
  const hal = withAddons(userFs({ userId: 'hal' }), 'hal');
  await hal.writeFile('/files/gina-fs/x.txt', 'local to hal');
  assert.equal(m.files.size, 1, 'nothing reached the MCP server');
  const gina = withAddons(userFs({ userId: 'gina' }), 'gina');
  await gina.writeFile('/files/gina-fs/x.txt', 'remote');
  assert.equal(m.files.get('/data/x.txt'), 'remote');
  // removing the connector removes the mount
  const { deleteConnector } = await import('../src/server/mcp.ts');
  deleteConnector(id);
  assert.ok(!visibleAddons('gina').some((a) => a.name === 'gina-fs'));
  m.close();
});

test('egress allowlist contains connected WebDAV hosts', async () => {
  const { createWebdav } = await lib();
  const { egressAllowlist } = await import('../src/server/egress-list.ts');
  createWebdav('iris', { name: 'egress-box', url: 'http://127.0.0.1:65001/dav', username: 'u', password: 'p' });
  assert.ok(egressAllowlist().includes('127.0.0.1:65001'));
});

test('privacy: an email inside a WebDAV file read by the agent is sealed in the audit payload and never sent', async () => {
  const d = await dav(); const { createWebdav } = await lib();
  d.files.set('/contacts.txt', Buffer.from('Reach Ada at ada.lovelace@example.com for the Q3 numbers.'));
  createWebdav('jane', { name: 'nc', url: d.base, username: 'ada', password: 'pw' });
  const { userSandbox } = await import('../src/server/storage-sandbox.ts');
  const content = await userSandbox({ userId: 'jane', conversationId: 'u_jane_01SEAL' }).readFile('/files/nc/contacts.txt'); // what the read tool returns
  assert.match(content, /ada\.lovelace@example\.com/);

  const { installGate } = await import('../src/server/redact.ts');
  const { installFetchGuard } = await import('../src/server/netguard.ts');
  const { build } = await import('../src/server/providers.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { als } = await import('../src/server/context.ts');
  const { auditFor } = await import('../src/server/privacy.ts');
  installGate(); await installFetchGuard();
  db.prepare("INSERT OR REPLACE INTO providers (id, name, base_url, enc_key, created_at) VALUES ('anthropic', 'Anthropic', ?, 'x', 'now')").run(fake.url);
  const models: any = createModels();
  models.setProvider(build({ id: 'anthropic', baseUrl: fake.url }, 'sk-x'));
  const model = models.getProvider('anthropic').getModels()[0];
  const before = requests.length;
  const now = Date.now();
  const context = { systemPrompt: 'be brief', messages: [
    { role: 'user', content: 'summarise /files/nc/contacts.txt', timestamp: now },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: '/files/nc/contacts.txt' } }], api: 'anthropic-messages', provider: 'anthropic', model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: now },
    { role: 'toolResult', toolCallId: 'toolu_1', toolName: 'read', content: [{ type: 'text', text: content }], isError: false, timestamp: now },
  ] };
  await als.run('u_jane_01SEAL', async () => { const s = models.streamSimple(model, context, { apiKey: 'sk-x' }); for await (const _e of s) { /* drain */ } return s.result(); });
  const sent = requests.slice(before);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].raw.includes('ada.lovelace@example.com'), 'the address never left the server');
  assert.ok(sent[0].raw.includes('{{var:EMAIL_1}}'), 'a placeholder went out instead');
  const audit = auditFor('u_jane_01SEAL');
  const row = audit.requests.find((r: any) => r.status === 'ok');
  assert.ok(row.findings.some((f: any) => f.label === 'EMAIL'));
  const payload = JSON.stringify(audit.latest?.payload);
  assert.ok(payload.includes('{{var:EMAIL_1}}') && !payload.includes('ada.lovelace@example.com'), 'audit payload shows the seal, not the value');
  d.close();
});

test('API: permissions and rules (team needs profiles.edit_team, shared account only by editors, owner-only removal, local-name collision)', async () => {
  const { db } = await import('../src/server/appdb.ts');
  const { auth } = await import('../src/server/auth.ts');
  const { mock } = await import('node:test');
  const role = (id: string, perms: string[]) => db.prepare('INSERT OR REPLACE INTO roles (id, name, builtin, permissions) VALUES (?,?,0,?)').run(id, id, JSON.stringify(perms));
  role('r-editor', ['models.use', 'profiles.edit_team']); role('r-worker', ['models.use']);
  for (const [id, r] of [['u-ed', 'r-editor'], ['u-w1', 'r-worker'], ['u-w2', 'r-worker']]) { db.prepare("INSERT OR REPLACE INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES (?,?,?,1,'now','now')").run(id, id + '@x.test', id); db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (?,?)').run(id, r); }
  mock.method(auth.api, 'getSession', async ({ headers }: any) => ({ user: { id: headers.get('x-user') } }));
  const { storageAddonRoutes } = await import('../src/server/storage-addon-routes.ts');
  const app = new Hono(); app.route('/api/storage-addons', storageAddonRoutes);
  const d = await dav({ ada: 'pw' });
  const call = async (user: string, method: string, path: string, body?: object) => { const r = await app.request('/api/storage-addons' + (path === '/' ? '' : path), { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
  const wd = (name: string, extra: object = {}) => ({ kind: 'webdav', name, url: d.base, username: 'ada', password: 'pw', ...extra });

  assert.equal((await call('u-w1', 'POST', '/', wd('t-by-worker', { visibility: 'team' }))).status, 403);
  assert.equal((await call('u-w1', 'POST', '/', wd('s-by-worker', { sharedAccount: true }))).status, 400);
  assert.equal((await call('u-w1', 'POST', '/', wd('Bad Name'))).status, 400);
  const mine = await call('u-w1', 'POST', '/', wd('w1-box'));
  assert.equal(mine.status, 200); assert.equal(mine.json.mount, '/files/w1-box');
  assert.equal((await call('u-w1', 'POST', '/', wd('w1-box'))).status, 409); // name taken
  assert.equal((await call('u-w2', 'GET', '/')).json.some((a: any) => a.name === 'w1-box'), false);
  for (const [m, p] of [['POST', `/${mine.json.id}/test`], ['DELETE', `/${mine.json.id}`], ['PUT', `/${mine.json.id}/credentials`]] as const) assert.equal((await call('u-w2', m, p, { username: 'a', password: 'b' })).status, 404, p);
  assert.equal((await call('u-w1', 'POST', `/${mine.json.id}/test`)).json.ok, true);

  // a local folder with the same name blocks the add-on (it would be hidden)
  const { userFs } = await import('../src/server/storage.ts');
  await userFs({ userId: 'u-w1' }).writeFile('/files/localdir/x.txt', 'x');
  const clash = await call('u-w1', 'POST', '/', wd('localdir'));
  assert.equal(clash.status, 409); assert.match(clash.json.error, /local folder/);

  // team: definition by an editor, credentials per user; shared account only when marked
  const team = await call('u-ed', 'POST', '/', wd('t-box', { visibility: 'team' }));
  assert.equal(team.status, 200);
  const seen = (await call('u-w2', 'GET', '/')).json.find((a: any) => a.id === team.json.id);
  assert.deepEqual([seen.connected, seen.sharedAccount, seen.mine], [false, false, false]);
  assert.equal((await call('u-w2', 'POST', `/${team.json.id}/test`)).json.ok, false); // no login of his own yet
  assert.equal((await call('u-w2', 'PUT', `/${team.json.id}/credentials`, { username: 'ada', password: 'pw' })).status, 200);
  assert.equal((await call('u-w2', 'POST', `/${team.json.id}/test`)).json.ok, true);
  assert.equal((await call('u-w2', 'DELETE', `/${team.json.id}`)).status, 403); // only the owner (or an admin)
  const shared = await call('u-ed', 'POST', '/', wd('t-shared', { visibility: 'team', sharedAccount: true }));
  assert.equal((await call('u-w2', 'PUT', `/${shared.json.id}/credentials`, { username: 'x', password: 'y' })).status, 403); // shared login: editors only
  assert.equal((await call('u-w2', 'GET', '/')).json.find((a: any) => a.id === shared.json.id).connected, true);
  assert.equal((await call('u-ed', 'DELETE', `/${shared.json.id}`)).status, 200);
  mock.restoreAll();
  d.close();
});
