import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-files-'));
process.env.HEFYN_SECRET = 'files-test-secret-files-test-secret-123';
delete process.env.HEFYN_RUNNER_URL; // host userFs path

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
async function mk(email: string, role = 'worker') {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return (path: string, init: RequestInit = {}) => app.request(`/api/files${path}`, { ...init, headers: { ...init.headers, cookie } });
}
const ann = await mk('ann@x.test'), bob = await mk('bob@x.test');
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const form = (name: string, content: string) => { const f = new FormData(); f.append('file', new File([content], name)); return { method: 'POST', body: f } as RequestInit; };

test('needs a session', async () => {
  assert.equal((await app.request('/api/files')).status, 401);
});

test('upload, list, download, rename, delete for one user', async () => {
  let r = await ann('/upload?dir=docs', form('a.html', '<script>alert(1)</script>'));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as any).saved.map((s: any) => s.path), ['/docs/a.html']);
  r = await ann('/upload?dir=docs', form('../../evil.txt', 'x')); // the name is reduced to its basename
  assert.deepEqual((await r.json() as any).saved.map((s: any) => s.path), ['/docs/evil.txt']);
  assert.deepEqual((await (await ann('?path=docs')).json() as any).entries.map((e: any) => e.name).sort(), ['a.html', 'evil.txt']);

  r = await ann('/download?path=docs/a.html'); // never rendered same-origin
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.equal(await r.text(), '<script>alert(1)</script>');
  assert.equal((await ann('/download?path=docs')).status, 400);

  assert.equal((await ann('/mkdir', json({ path: 'x/y' }))).status, 200);
  assert.equal((await ann('/rename', json({ from: 'docs/a.html', to: 'x/y/b.html' }))).status, 200);
  assert.equal((await ann('/rename', json({ from: 'docs/evil.txt', to: 'x/y/b.html' }))).status, 409);
  assert.equal((await ann('/usage')).status, 200);
  assert.equal((await ann('?path=docs', { method: 'DELETE' })).status, 200);
  assert.equal((await ann('?path=docs')).status, 404);
});

test('another user cannot see or read it', async () => {
  await ann('/upload', form('secret.txt', 'mine'));
  assert.equal((await bob('/download?path=secret.txt')).status, 404);
  assert.deepEqual((await (await bob('')).json() as any).entries, []);
  assert.equal((await bob('?path=secret.txt', { method: 'DELETE' })).status, 404);
  assert.equal(await (await ann('/download?path=secret.txt')).text(), 'mine');
});

test('.. cannot leave the folder', async () => {
  for (const p of ['../../etc/passwd', '..', 'a/../../b']) assert.ok([403, 404].includes((await ann(`/download?path=${encodeURIComponent(p)}`)).status), p);
  assert.equal((await ann('?path=..')).status, 403);
  assert.equal((await ann('/rename', json({ from: 'secret.txt', to: '../b' }))).status, 403);
  assert.equal((await ann('/mkdir', json({ path: '../x' }))).status, 403);
});

test('upload limits', async () => {
  process.env.HEFYN_MAX_UPLOAD_MB = '0';
  try { assert.equal((await ann('/upload', form('big.bin', 'x'))).status, 413); } finally { delete process.env.HEFYN_MAX_UPLOAD_MB; }
  process.env.HEFYN_USER_QUOTA_MB = '0';
  try { assert.equal((await ann('/upload', form('q.bin', 'x'.repeat(70_000)))).status, 413); } finally { delete process.env.HEFYN_USER_QUOTA_MB; }
});

test('PUT /content saves text, guards against stale writes and limits', async () => {
  const put = (u: typeof ann, path: string, text: string, extra = '') => u(`/content?path=${encodeURIComponent(path)}${extra}`, { method: 'PUT', body: text });
  let r = await put(ann, 'notes/a.md', 'one', '&new=1'); // new file, parents are created
  assert.equal(r.status, 200);
  const first = await r.json() as any;
  assert.equal(first.size, 3);
  assert.equal(await (await ann('/download?path=notes/a.md')).text(), 'one');
  assert.equal((await put(ann, 'notes/a.md', 'x', '&new=1')).status, 409); // would replace
  assert.equal((await put(ann, 'notes/a.md', 'two', `&mtime=${encodeURIComponent(first.mtime)}`)).status, 200);
  const stale = new Date(Date.parse(first.mtime) - 60_000).toISOString();
  r = await put(ann, 'notes/a.md', 'three', `&mtime=${encodeURIComponent(stale)}`);
  assert.equal(r.status, 409);
  assert.equal(await (await ann('/download?path=notes/a.md')).text(), 'two');
  assert.equal((await put(ann, 'notes/a.md', 'forced')).status, 200); // overwrite: no mtime
  assert.equal((await put(ann, 'gone.md', 'x', `&mtime=${encodeURIComponent(first.mtime)}`)).status, 409);
  assert.equal((await put(ann, 'notes', 'x')).status, 400); // a folder
  assert.equal((await put(ann, 'big.txt', 'x'.repeat(5 * 1048576 + 1))).status, 413);
  for (const p of ['../evil.txt', 'a/../../evil.txt']) assert.equal((await put(ann, p, 'x')).status, 403, p);
  assert.equal((await put(bob, 'notes/a.md', 'bob was here')).status, 200); // bob's own /files/notes/a.md ...
  assert.equal(await (await ann('/download?path=notes/a.md')).text(), 'forced'); // ... never ann's
  assert.equal((await put(bob, 'secret.txt', 'x', '&mtime=2020-01-01T00:00:00Z')).status, 409); // ann's secret.txt does not exist for bob
});

test('chat scratch: list, download, clear, cleanup; ownership, running, managed dirs, age', async () => {
  const { sealForUser } = await import('../src/server/vault.ts');
  const { userFs, baseDir } = await import('../src/server/storage.ts');
  const { utimesSync } =await import('node:fs');
  const uid = (email: string) => (db.prepare('SELECT id FROM user WHERE email = ?').get(email) as { id: string }).id;
  const a = uid('ann@x.test'), b = uid('bob@x.test');
  const chat = async (u: string, n: string, title: string, files: Record<string, string>, daysOld = 0) => {
    const id = `u_${u}_${n}`;
    db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, ?, ?)').run(id, u, sealForUser(u, title, `conv:${id}:title`), new Date().toISOString());
    const fs = userFs({ userId: u, conversationId: id });
    for (const [p, t] of Object.entries(files)) {
      await fs.writeFile(`/tmp/${p}`, t);
      const when = new Date(Date.now() - daysOld * 86_400_000);
      utimesSync(join(baseDir(), 'users', u, 'tmp', id, p), when, when);
    }
    return id;
  };
  const fresh = await chat(a, 'FRESH1', 'Fresh chat', { 'out/a.txt': 'hello', '.claude/projects/s.jsonl': 'transcript' });
  const old = await chat(a, 'OLD1', 'Old chat', { 'b.bin': 'x'.repeat(100), '.codex/config.toml': 'k' }, 40);
  const busy = await chat(a, 'BUSY1', 'Busy chat', { 'c.txt': 'zz' }, 40);
  await chat(b, 'BOB1', 'Bob chat', { 'secret.txt': 'bob' });
  db.prepare("INSERT INTO chat_activity (conversation_id, user_id, state, since) VALUES (?, ?, 'running', ?)").run(busy, a, new Date().toISOString());

  let r = await (await ann('/scratch')).json() as any;
  assert.deepEqual(r.chats.map((c: any) => c.title).sort(), ['Busy chat', 'Fresh chat', 'Old chat']);
  const f = r.chats.find((c: any) => c.conversationId === fresh);
  assert.equal(f.bytes, 5); assert.equal(f.files, 1); assert.equal(f.running, false); // the managed .claude is not counted
  assert.equal(r.chats.find((c: any) => c.conversationId === busy).running, true);
  assert.deepEqual((await (await ann(`/scratch/${fresh}/list`)).json() as any).entries.map((e: any) => e.name), ['out']); // .claude hidden
  assert.equal((await ann(`/scratch/${fresh}/list?path=.claude`)).status, 404);
  assert.equal((await ann(`/scratch/${fresh}/download?path=.claude/projects/s.jsonl`)).status, 404);
  assert.equal((await ann(`/scratch/${fresh}/list?path=../../x`)).status, 403);
  const d = await ann(`/scratch/${fresh}/download?path=out/a.txt`);
  assert.equal(await d.text(), 'hello'); assert.equal(d.headers.get('content-security-policy'), 'sandbox');
  assert.equal(((await (await ann(`/scratch/${fresh}/stat?path=out/a.txt`)).json()) as any).size, 5);
  assert.equal((await bob(`/scratch/${fresh}/stat?path=out/a.txt`)).status, 404);

  // user B sees nothing of A's, and cannot list, read or clear it
  assert.deepEqual((await (await bob('/scratch')).json() as any).chats.map((c: any) => c.title), ['Bob chat']);
  assert.equal((await bob(`/scratch/${fresh}/list`)).status, 404);
  assert.equal((await bob(`/scratch/${fresh}/download?path=out/a.txt`)).status, 404);
  assert.equal((await bob(`/scratch/${fresh}`, { method: 'DELETE' })).status, 404);
  assert.equal(await (await ann(`/scratch/${fresh}/download?path=out/a.txt`)).text(), 'hello');

  assert.equal((await ann(`/scratch/${busy}`, { method: 'DELETE' })).status, 409); // running
  assert.equal((await ann('/scratch/cleanup', json({ olderThanDays: 0 }))).status, 400);
  r = await (await ann('/scratch/cleanup', json({ olderThanDays: 30 }))).json();
  assert.deepEqual([r.freed, r.chats], [100, 1]); // only the idle chat older than 30 days; fresh and busy stay
  assert.equal((await (await ann('/scratch')).json() as any).chats.length, 2);
  assert.ok(await Bun.file(join(baseDir(), 'users', a, 'tmp', old, '.codex', 'config.toml')).exists()); // managed config survives a clear

  r = await (await ann(`/scratch/${fresh}`, { method: 'DELETE' })).json();
  assert.equal(r.freed, 5);
  assert.ok(await Bun.file(join(baseDir(), 'users', a, 'tmp', fresh, '.claude', 'projects', 's.jsonl')).exists());
  assert.equal((await (await bob('/scratch')).json() as any).chats.length, 1); // B untouched by A's cleanup
});
