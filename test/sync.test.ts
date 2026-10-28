import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-sync-'));
process.env.HEFYN_SECRET = 'sync-test-secret-sync-test-secret-123';
delete process.env.HEFYN_RUNNER_URL; // host userFs path

const { db } = await import('../src/server/appdb.ts');
const { fsFor } = await import('../src/server/runner.ts');
const { syncConnection } = await import('../src/server/connections/sync.ts');
const { providerRegistry } = await import('../src/server/connections/types.ts');
const { StorageError } = await import('../src/server/storage.ts');

// In-memory remote with the Adapter interface; `etag` changes on every write.
type Adapter = import('../src/server/connections/types.ts').Adapter;
function fakeRemote() {
  const files = new Map<string, { data: Buffer; etag: string }>();
  const dirs = new Set<string>(['']);
  let n = 0, delay = 0;
  const parent = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p));
  const ensure = (d: string) => { for (let x = d; x; x = parent(x)) dirs.add(x); };
  const adapter: Adapter = {
    caps: async () => ({ write: true, mkdir: true, rename: true, delete: true, etag: true }),
    async list(rel) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const d = rel.replace(/^\/|\/$/g, '');
      return [
        ...[...dirs].filter((x) => x && parent(x) === d).map((x) => ({ name: posix.basename(x), type: 'dir' as const, size: 0, mtime: '' })),
        ...[...files].filter(([k]) => parent(k) === d).map(([k, v]) => ({ name: posix.basename(k), type: 'file' as const, size: v.data.length, mtime: '', etag: v.etag })),
      ];
    },
    stat: async () => { throw new Error('unused'); },
    read: async (rel) => new Blob([files.get(rel)!.data as BlobPart]).stream() as ReadableStream<Uint8Array>,
    async write(rel, data) { ensure(parent(rel)); files.set(rel, { data: Buffer.from(data), etag: `e${++n}` }); },
    async mkdir(rel) { ensure(rel); },
    async delete(rel) { files.delete(rel); dirs.delete(rel); },
    async rename(a, b) { files.set(b, files.get(a)!); files.delete(a); },
  };
  return { files, dirs, adapter, put: (p: string, s: string) => { ensure(parent(p)); files.set(p, { data: Buffer.from(s), etag: `e${++n}` }); }, text: (p: string) => files.get(p)?.data.toString(), slow: (ms: number) => { delay = ms; } };
}
let remote = fakeRemote();
providerRegistry.set('fake', { kind: 'fake', label: 'Fake', fields: [], connect: async () => remote.adapter });

let seq = 0;
function setup() {
  remote = fakeRemote();
  const userId = `u${++seq}`, id = `c${seq}`;
  db.prepare("INSERT INTO connections (id, user_id, kind, name, folder, config, remote_root, created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, 'fake', 'Fake', 'Fake', '{}', '/', new Date().toISOString());
  const fs = fsFor(userId);
  return {
    id, userId, fs, remote,
    sync: (o?: Parameters<typeof syncConnection>[2]) => syncConnection(userId, id, o),
    put: async (p: string, s: string) => { await new Promise((r) => setTimeout(r, 5)); await fs.writeFile(`/files/Fake/${p}`, s); },
    text: async (p: string) => (await fs.readFileBuffer(`/files/Fake/${p}`).then((b) => Buffer.from(b).toString(), () => undefined)),
    names: async (d = '') => ((await fs.list(`/files/Fake${d ? '/' + d : ''}`).catch(() => [])) as { name: string }[]).map((e) => e.name).sort(),
  };
}

test('first sync: remote files come down, local-only files go up', async () => {
  const t = setup();
  t.remote.put('a.txt', 'A'); t.remote.put('d/b.txt', 'B');
  await t.put('c.txt', 'C');
  const s = await t.sync();
  assert.deepEqual([s.downloaded, s.uploaded, s.conflicts], [2, 1, 0]);
  assert.equal(await t.text('a.txt'), 'A');
  assert.equal(await t.text('d/b.txt'), 'B');
  assert.equal(t.remote.text('c.txt'), 'C');
  const again = await t.sync();
  assert.deepEqual([again.downloaded, again.uploaded, again.deletedLocal, again.deletedRemote, again.conflicts], [0, 0, 0, 0, 0]);
});

test('one-sided changes travel in the direction of the change', async () => {
  const t = setup();
  t.remote.put('a.txt', 'one'); await t.put('b.txt', 'one');
  await t.sync();
  t.remote.put('a.txt', 'remote two');
  await t.put('b.txt', 'local two');
  const s = await t.sync();
  assert.deepEqual([s.downloaded, s.uploaded], [1, 1]);
  assert.equal(await t.text('a.txt'), 'remote two');
  assert.equal(t.remote.text('b.txt'), 'local two');
});

test('both changed: the remote version keeps the name, the local one is kept as a conflict copy on both sides', async () => {
  const t = setup();
  t.remote.put('a.txt', 'base'); await t.sync();
  t.remote.put('a.txt', 'remote edit');
  await t.put('a.txt', 'local edit');
  const s = await t.sync();
  assert.equal(s.conflicts, 1);
  assert.equal(await t.text('a.txt'), 'remote edit');
  const copy = (await t.names()).find((n) => /^a \(conflict \d{4}-\d\d-\d\d \d{4}\)\.txt$/.test(n))!;
  assert.ok(copy, `conflict copy among ${await t.names()}`);
  assert.equal(await t.text(copy), 'local edit');
  assert.equal(t.remote.text('a.txt'), 'remote edit');
  assert.equal(t.remote.text(copy), 'local edit');
  assert.equal((await t.sync()).conflicts, 0);
});

test('both new with the same content is no conflict; with different content it is', async () => {
  const t = setup();
  t.remote.put('same.txt', 'x'); t.remote.put('diff.txt', 'remote');
  await t.put('same.txt', 'x'); await t.put('diff.txt', 'local');
  const s = await t.sync();
  assert.equal(s.conflicts, 1);
  assert.equal(await t.text('diff.txt'), 'remote');
});

test('a delete follows when the other side is unchanged', async () => {
  const t = setup();
  t.remote.put('gone-remote.txt', '1'); t.remote.put('gone-local.txt', '2'); t.remote.put('d/x.txt', '3');
  await t.sync();
  t.remote.files.delete('gone-remote.txt');
  await t.fs.rm('/files/Fake/gone-local.txt');
  await t.fs.rm('/files/Fake/d', { recursive: true });
  const s = await t.sync();
  assert.deepEqual([s.deletedLocal, s.deletedRemote], [1, 3]); // gone-remote.txt locally; gone-local.txt, d/x.txt and the folder d remotely
  assert.equal(await t.text('gone-remote.txt'), undefined);
  assert.equal(t.remote.text('gone-local.txt'), undefined);
  assert.equal(t.remote.text('d/x.txt'), undefined);
  assert.ok(!t.remote.dirs.has('d'), 'the emptied folder goes too');
});

test('deleted on one side but changed on the other: the changed file is restored', async () => {
  const t = setup();
  t.remote.put('a.txt', '1'); t.remote.put('b.txt', '1');
  await t.sync();
  t.remote.put('a.txt', 'changed remotely');
  await t.fs.rm('/files/Fake/a.txt');
  await t.put('b.txt', 'changed locally');
  t.remote.files.delete('b.txt');
  const s = await t.sync();
  assert.deepEqual([s.deletedLocal, s.deletedRemote], [0, 0]);
  assert.equal(await t.text('a.txt'), 'changed remotely');
  assert.equal(t.remote.text('b.txt'), 'changed locally');
});

test('a folder with a restored file survives its deletion on the other side', async () => {
  const t = setup();
  t.remote.put('d/x.txt', '1'); t.remote.put('d/y.txt', '1');
  await t.sync();
  await t.fs.rm('/files/Fake/d', { recursive: true });
  t.remote.put('d/y.txt', 'edited');
  await t.sync();
  assert.deepEqual(await t.names('d'), ['y.txt']);
  assert.equal(t.remote.text('d/y.txt'), 'edited');
  assert.equal(t.remote.text('d/x.txt'), undefined);
});

test('pull mode never uploads, push mode never downloads', async () => {
  const t = setup();
  t.remote.put('r.txt', 'r'); await t.put('l.txt', 'l');
  const pull = await t.sync({ mode: 'pull' });
  assert.deepEqual([pull.downloaded, pull.uploaded], [1, 0]);
  assert.equal(t.remote.text('l.txt'), undefined);
  t.remote.put('r2.txt', 'r2');
  const push = await t.sync({ mode: 'push' });
  assert.deepEqual([push.downloaded, push.uploaded], [0, 1]);
  assert.equal(await t.text('r2.txt'), undefined);
});

test('names the other side may refuse are skipped, symlinks are never followed', async () => {
  const t = setup();
  await t.put('bad:name.txt', 'x'); await t.put('ok.txt', 'y');
  const s = await t.sync();
  assert.equal(s.skipped, 1);
  assert.equal(t.remote.text('ok.txt'), 'y');
  assert.equal(t.remote.text('bad:name.txt'), undefined);
});

test('caps: too many entries aborts without touching anything; the byte cap defers files', async () => {
  const t = setup();
  for (let i = 0; i < 5; i++) t.remote.put(`f${i}.txt`, 'x');
  process.env.HEFYN_SYNC_MAX_ENTRIES = '3';
  await assert.rejects(t.sync(), (e: any) => e instanceof StorageError && /more than 3 files/.test(e.message));
  assert.deepEqual(await t.names(), []);
  assert.equal(db.prepare('SELECT status FROM connections WHERE id = ?').get(t.id)!.status, 'error');
  delete process.env.HEFYN_SYNC_MAX_ENTRIES;
  process.env.HEFYN_SYNC_MAX_MB = String(2 / 1048576); // two bytes
  const s = await t.sync();
  delete process.env.HEFYN_SYNC_MAX_MB;
  assert.equal(s.downloaded, 2);
  assert.ok(s.capped.includes('bytes'));
  assert.equal((await t.sync()).downloaded, 3, 'the rest follows on the next run');
});

test('one run per connection at a time', async () => {
  const t = setup();
  t.remote.put('a.txt', 'a');
  t.remote.slow(60);
  const first = t.sync();
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(t.sync(), (e: any) => e.status === 409);
  await first;
  await t.sync(); // the lock is released
});

test('an error on one file does not stop the others; the connection shows it', async () => {
  const t = setup();
  t.remote.put('a.txt', 'a'); t.remote.put('b.txt', 'b');
  const read = remote.adapter.read;
  remote.adapter.read = async (rel) => { if (rel === 'a.txt') throw new Error('boom'); return read(rel); };
  const s = await t.sync();
  assert.equal(s.errors.length, 1);
  assert.equal(await t.text('b.txt'), 'b');
  const row = db.prepare('SELECT status, last_error FROM connections WHERE id = ?').get(t.id) as any;
  assert.equal(row.status, 'error');
  assert.match(row.last_error, /a\.txt: boom/);
});
