import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createEditTool, createReadTool, createWriteTool, type Sandbox } from '@flue/runtime';
import { cleanupTmp, deleteConversationTmp, deleteUserStorage, userFs } from '../src/server/storage.ts';
import { userSandbox, userSandboxFactory } from '../src/server/storage-sandbox.ts';
import { storageRoutes } from '../src/server/storage-routes.ts';

const data = mkdtempSync(join(tmpdir(), 'hefyn-storage-'));
process.env.HEFYN_DATA_DIR = data;
const rejects = (p: Promise<unknown>) => assert.rejects(p);
const sb = (userId = 'alice', conversationId = 'u_alice_01A') => userSandbox({ userId, conversationId });
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('');

test('sandbox roundtrip and typed as a Flue Sandbox', async () => {
  const s: Sandbox = sb();
  await s.writeFile('/files/a/b.txt', 'hello'); // parents created lazily
  assert.equal(await s.readFile('a/b.txt'), 'hello'); // relative -> cwd /files
  assert.deepEqual(await s.readdir('/'), ['files', 'tmp']);
  assert.equal((await s.stat('/files/a')).isDirectory, true);
  assert.equal(await s.exists('/files/nope'), false);
  await s.writeFile('/tmp/scratch.txt', 'x');
  assert.equal(await s.readFile('/tmp/scratch.txt'), 'x');
});

test('traversal attempts are rejected', async () => {
  const s = sb();
  writeFileSync(join(data, 'secret.txt'), 'top secret');
  for (const p of ['../x', '/files/../../etc/passwd', '/files/a/../../../x', '/etc/passwd', '/files/../tmp/../../x', 'a\0b', '/files/' + 'a'.repeat(300), '/files/' + 'a/'.repeat(600), '/files\\..\\x', '/users/bob/files/x']) {
    await rejects(s.readFile(p));
    await rejects(s.writeFile(p, 'x'));
  }
  // encoded dots are just a literal filename inside the root
  await s.writeFile('/files/%2e%2e/x.txt', 'lit');
  assert.ok(existsSync(join(data, 'users/alice/files/%2e%2e/x.txt')));
  await rejects(s.rm('/files'));
  await rejects(s.rm('/'));
});

test('symlinks pointing outside are rejected for read, write, list, rm-through', async () => {
  const s = sb();
  await s.writeFile('/files/seed', '1'); // creates the root
  const root = join(data, 'users/alice/files');
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  symlinkSync(outside, join(root, 'dirlink'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'filelink'));
  symlinkSync(join(outside, 'newfile'), join(root, 'dangling'));
  await rejects(s.readFile('/files/filelink'));
  await rejects(s.readFile('/files/dirlink/secret.txt'));
  await rejects(s.writeFile('/files/filelink', 'pwn'));
  await rejects(s.writeFile('/files/dirlink/new.txt', 'pwn'));
  await rejects(s.writeFile('/files/dirlink/deep/new.txt', 'pwn'));
  await rejects(s.writeFile('/files/dangling', 'pwn'));
  await rejects(s.readdir('/files/dirlink'));
  assert.equal(await s.exists('/files/filelink'), false);
  assert.ok(!existsSync(join(outside, 'newfile')) && !existsSync(join(outside, 'new.txt')));
  assert.equal((await import('node:fs')).readFileSync(join(outside, 'secret.txt'), 'utf8'), 'top secret');
  // removing the link itself is fine and leaves the target alone
  await s.rm('/files/dirlink');
  assert.ok(existsSync(join(outside, 'secret.txt')));
});

test('quota and upload limits', async () => {
  process.env.HEFYN_USER_QUOTA_MB = '1';
  process.env.HEFYN_MAX_UPLOAD_MB = '0.75';
  try {
    const s = sb('quota');
    await s.writeFile('/files/a', Buffer.alloc(600 * 1024));
    await rejects(s.writeFile('/files/b', Buffer.alloc(600 * 1024))); // 1.2 MB total
    await s.writeFile('/files/a', Buffer.alloc(700 * 1024)); // replacing counts the delta only
    await rejects(sb('quota', 'u_quota_01').writeFile('/tmp/t', Buffer.alloc(400 * 1024))); // tmp counts too
    await rejects(sb('other').writeFile('/files/big', Buffer.alloc(800 * 1024))); // single-file limit
  } finally { delete process.env.HEFYN_USER_QUOTA_MB; delete process.env.HEFYN_MAX_UPLOAD_MB; }
});

test('exec is unsupported', async () => {
  await assert.rejects(sb().exec('echo hi'), /container sandbox/);
});

test('tmp isolation between conversations and users', async () => {
  await sb('u1', 'c1').writeFile('/tmp/f', 'one');
  await sb('u1', 'c2').writeFile('/tmp/f', 'two');
  await sb('u2', 'c1').writeFile('/tmp/f', 'three');
  assert.equal(await sb('u1', 'c1').readFile('/tmp/f'), 'one');
  assert.equal(await sb('u1', 'c2').readFile('/tmp/f'), 'two');
  assert.equal(await sb('u2', 'c1').readFile('/tmp/f'), 'three');
  await rejects(sb('u1', 'c1').readFile('/tmp/../../c2/f'));
  await rejects(userFs({ userId: 'u1' }).readFile('/tmp/f')); // no conversation -> no tmp
  assert.throws(() => userSandbox({ userId: '../x', conversationId: 'c' }));
  await rejects(sb('u1', 'c1').writeFile('/files/x', 'x').then(() => userSandbox({ userId: 'u1', conversationId: '../c2' }).readFile('/tmp/f')));
});

test('cleanup and deletion', async () => {
  await sb('clean', 'old').writeFile('/tmp/f', 'x');
  await sb('clean', 'new').writeFile('/tmp/f', 'x');
  await sb('clean', 'old').writeFile('/files/keep', 'x');
  const old = new Date(Date.now() - 10 * 86_400_000);
  const dir = join(data, 'users/clean/tmp/old');
  utimesSync(join(dir, 'f'), old, old);
  utimesSync(dir, old, old);
  assert.equal(await cleanupTmp({ olderThanDays: 7 }), 1);
  assert.ok(!existsSync(dir) && existsSync(join(data, 'users/clean/tmp/new')) && existsSync(join(data, 'users/clean/files/keep')));
  await deleteConversationTmp('clean', 'new');
  assert.ok(!existsSync(join(data, 'users/clean/tmp/new')));
  await deleteUserStorage('clean');
  assert.ok(!existsSync(join(data, 'users/clean')));
  await rejects(deleteUserStorage('../x'));
});

test('router: upload / list / download / delete / mkdir / rename / usage / keep', async () => {
  const app = new Hono();
  app.route('/', storageRoutes((c) => c.req.header('x-user') || undefined));
  const as = (user: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...init.headers, 'x-user': user } });
  const ada = as('ada'), eve = as('eve');
  assert.equal((await app.request('/files')).status, 401);

  const form = () => { const f = new FormData(); f.append('f', new File(['<script>alert(1)</script>'], 'a.html')); f.append('f', new File(['two'], '../../evil.txt')); return f; };
  let r = await ada('/files/upload?dir=docs', { method: 'POST', body: form() });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as any).saved.map((s: any) => s.path), ['/docs/a.html', '/docs/evil.txt']);
  r = await ada('/files/upload?dir=docs', { method: 'POST', body: form() }); // conflict -> unique names
  assert.deepEqual((await r.json() as any).saved.map((s: any) => s.name), ['a (1).html', 'evil (1).txt']);

  const list = await (await ada('/files?path=docs')).json() as any;
  assert.equal(list.entries.length, 4);
  assert.equal((await (await eve('/files?path=docs')).json() as any).entries?.length, undefined); // eve sees nothing of ada's

  r = await ada('/files/download?path=docs/a.html');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.equal(await r.text(), '<script>alert(1)</script>');
  assert.equal((await ada('/files/download?path=../../etc/passwd')).status, 403);
  assert.equal((await ada('/files/download?path=docs')).status, 400);

  assert.equal((await ada('/files/mkdir', { method: 'POST', body: JSON.stringify({ path: 'x/y' }) })).status, 200);
  assert.equal((await ada('/files/rename', { method: 'POST', body: JSON.stringify({ from: 'docs/a.html', to: 'x/y/b.html' }) })).status, 200);
  assert.equal((await ada('/files/rename', { method: 'POST', body: JSON.stringify({ from: 'docs/evil.txt', to: 'x/y/b.html' }) })).status, 409);
  assert.equal((await ada('/files/rename', { method: 'POST', body: JSON.stringify({ from: 'docs/evil.txt', to: '../b' }) })).status, 403);

  // keep: agent writes to tmp, user keeps it; foreign conversation refused
  await sb('ada', 'u_ada_01J').writeFile('/tmp/out/report.md', '# r');
  const keep = (user: typeof ada, conversationId: string) => user('/files/keep', { method: 'POST', body: JSON.stringify({ conversationId, path: 'out/report.md' }) });
  assert.equal((await keep(eve, 'u_ada_01J')).status, 403);
  assert.equal((await keep(ada, 'u_ada_01J')).status, 200);
  assert.equal(await (await ada('/files/download?path=report.md')).text(), '# r');
  assert.equal((await ada('/files/keep', { method: 'POST', body: JSON.stringify({ conversationId: 'u_ada_01J', path: '../../../etc/passwd' }) })).status, 403);

  const u = await (await ada('/files/usage')).json() as any;
  assert.ok(u.used > 0 && u.quota === 1024 * 1024 * 1024);
  assert.equal((await ada('/files?path=docs', { method: 'DELETE' })).status, 200);
  assert.equal((await ada('/files?path=')).status, 200);
  assert.equal((await ada('/files?path=docs')).status, 404);

  process.env.HEFYN_USER_QUOTA_MB = '0';
  try { assert.equal((await ada('/files/upload', { method: 'POST', body: form() })).status, 413); } finally { delete process.env.HEFYN_USER_QUOTA_MB; }
});

test('the real Flue file tools run against the confined sandbox', async () => {
  const s = sb('tools', 'u_tools_01K');
  const run = (t: any, args: object) => t.execute('call', args);
  assert.match(text(await run(createWriteTool(s), { path: '/files/notes/a.txt', content: 'alpha\nbeta\n' })), /./);
  assert.match(text(await run(createReadTool(s), { path: '/files/notes/a.txt' })), /beta/);
  await run(createEditTool(s), { path: '/files/notes/a.txt', oldText: 'beta', newText: 'gamma' });
  const f = userSandboxFactory({ userId: 'tools', conversationId: 'u_tools_01K' });
  assert.deepEqual((f.tools!(s, { subagents: {} }) as any[]).map((t) => t.name), ['read', 'write', 'edit', 'list']); // no exec-backed tools
  const list = (f.tools!(s, { subagents: {} }) as any[]).find((t) => t.name === 'list');
  assert.match(text(await run(list, { path: '/files', recursive: true })), /notes\/a\.txt/);
  assert.equal(text(await run(list, { path: '/files/../..' })), '/files/\n/tmp/'); // Flue collapses .. before the driver: lands on the virtual root
  await assert.rejects(run(createWriteTool(s), { path: '/files/../../x', content: 'x' }));
  await assert.rejects(run(createReadTool(s), { path: '/etc/passwd' }));
});
