import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupTmp, deleteConversationTmp, deleteUserStorage, userFs } from '../src/server/storage.ts';

// The confined host filesystem (storage.ts userFs): non-shell users' files and every conversation's scratch dir. (The Files page, uploads and the Flue sandbox on top moved to old/.)
const data = mkdtempSync(join(tmpdir(), 'hefyn-storage-'));
process.env.HEFYN_DATA_DIR = data;
const rejects = (p: Promise<unknown>) => assert.rejects(p);
const sb = (userId = 'alice', conversationId = 'u_alice_01A') => userFs({ userId, conversationId });

test('filesystem roundtrip', async () => {
  const s = sb();
  await s.writeFile('/files/a/b.txt', 'hello'); // parents created lazily
  assert.equal(await s.readFile('/files/a/b.txt'), 'hello');
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

test('tmp isolation between conversations and users', async () => {
  await sb('u1', 'c1').writeFile('/tmp/f', 'one');
  await sb('u1', 'c2').writeFile('/tmp/f', 'two');
  await sb('u2', 'c1').writeFile('/tmp/f', 'three');
  assert.equal(await sb('u1', 'c1').readFile('/tmp/f'), 'one');
  assert.equal(await sb('u1', 'c2').readFile('/tmp/f'), 'two');
  assert.equal(await sb('u2', 'c1').readFile('/tmp/f'), 'three');
  await rejects(sb('u1', 'c1').readFile('/tmp/../../c2/f'));
  await rejects(userFs({ userId: 'u1' }).readFile('/tmp/f')); // no conversation -> no tmp
  assert.throws(() => userFs({ userId: '../x', conversationId: 'c' }));
  await rejects(sb('u1', 'c1').writeFile('/files/x', 'x').then(() => userFs({ userId: 'u1', conversationId: '../c2' }).readFile('/tmp/f')));
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

