import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-folders-'));
process.env.HEFYN_SECRET = 'folders-test-secret-folders-test-1234';
const DATA = process.env.HEFYN_DATA_DIR;

const { trpcCall } = await import('./trpc.ts');
const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email.split('@')[0]!, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return { id: r.user.id, tr: async (proc: string, input?: unknown, mutate = false) => { const x = await trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate); return { status: x.status, json: x.json }; }, call: async (path: string, method = 'GET', body?: unknown) => { const res = await app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: (await res.json().catch(() => ({}))) as any }; } };
}
await mk('admin@x.test', 'admin');
const ann = await mk('ann@x.test', 'worker');
const bob = await mk('bob@x.test', 'worker');
const folder = async (u: typeof ann, body: object) => u.tr('folders.create', body, true);
const chat = async (u: typeof ann) => (await u.tr('conversations.create', { title: 'c' }, true)).json.id as string;
const chatRow = async (u: typeof ann, id: string) => ((await u.tr('conversations.list')).json as any[]).find((r) => r.id === id);

const flueDb = join(DATA, 'flue.db'); // the retired hefyn chat's leftovers (legacy-flue.ts)
{ const d = new DatabaseSync(flueDb); d.exec('CREATE TABLE IF NOT EXISTS flue_conversation_streams (path TEXT PRIMARY KEY)'); d.close(); }
const flueRows = async (conv: string) => { const d = new DatabaseSync(flueDb); d.prepare('INSERT INTO flue_conversation_streams (path) VALUES (?)').run(`agents/configurable/${conv}`); d.close(); };
const fluePresent = (conv: string) => { const d = new DatabaseSync(flueDb); try { return (d.prepare('SELECT COUNT(*) AS n FROM flue_conversation_streams WHERE path LIKE ?') as any).get(`%/${conv}`).n as number; } finally { d.close(); } };

test('folder CRUD: create, nest, rename, list, sealed names, other users see nothing', async () => {
  const a = (await folder(ann, { name: 'Angebote' })).json;
  const b = (await folder(ann, { name: 'Jahresplan', parentId: a.id })).json;
  assert.deepEqual([a.parentId, a.projectId, b.parentId], [null, null, a.id]);
  assert.ok(b.position >= 1 && a.position >= 1);
  const raw = JSON.stringify(db.prepare('SELECT * FROM folders').all());
  assert.ok(!raw.includes('Angebote') && !raw.includes('Jahresplan'), 'folder names sealed at rest');
  assert.equal((await ann.tr('folders.rename', { id: a.id, name: '  Offers  ' }, true)).json.name, 'Offers');
  assert.deepEqual(((await ann.tr('folders.list')).json as any[]).map((f) => f.name).sort(), ['Jahresplan', 'Offers']);
  assert.equal(((await bob.tr('folders.list')).json as any[]).length, 0);
  assert.equal((await bob.tr('folders.rename', { id: a.id, name: 'x' }, true)).status, 404);
  assert.equal((await bob.tr('folders.move', { id: a.id, parentId: null }, true)).status, 404);
  assert.equal((await bob.tr('folders.delete', { id: a.id }, true)).status, 404);
  assert.equal((await folder(bob, { name: 'in annes folder', parentId: a.id })).status, 404);
  for (const bad of [{ name: '' }, { name: 'x'.repeat(61) }, { name: 'x', position: 'a' }, { name: 'x', projectId: 'p_nope' }]) assert.equal((await folder(ann, bad)).status, 400);
});

test('depth limit and cycle prevention', async () => {
  let parent: string | null = null; const ids: string[] = [];
  for (let i = 1; i <= 5; i++) { const r: any = await folder(ann, { name: `L${i}`, parentId: parent }); assert.equal(r.status, 200); parent = r.json.id; ids.push(parent!); }
  assert.equal((await folder(ann, { name: 'L6', parentId: parent })).status, 400); // 6th level
  assert.equal((await ann.tr('folders.move', { id: ids[0], parentId: ids[4] }, true)).status, 400); // into its own descendant
  assert.equal((await ann.tr('folders.move', { id: ids[1], parentId: ids[1] }, true)).status, 400); // into itself
  const solo = (await folder(ann, { name: 'solo' })).json;
  assert.equal((await ann.tr('folders.move', { id: solo.id, parentId: ids[4] }, true)).status, 400); // would be level 6
  assert.equal((await ann.tr('folders.move', { id: solo.id, parentId: ids[3] }, true)).status, 200); // level 5 is fine
  const deep = (await folder(ann, { name: 'deep' })).json; await folder(ann, { name: 'deep child', parentId: deep.id });
  assert.equal((await ann.tr('folders.move', { id: deep.id, parentId: ids[3] }, true)).status, 400); // subtree of height 2 under level 4 = 6
  assert.equal((await ann.tr('folders.move', { id: deep.id, parentId: ids[2] }, true)).status, 200);
});

test('without projects: chats move into folders (single and bulk), another user\'s folder is refused, a project id is refused', async () => {
  const f = (await folder(ann, { name: 'Angebote' })).json;
  const sub = (await folder(ann, { name: 'Sub', parentId: f.id })).json;
  const c = await chat(ann);
  assert.equal((await ann.tr('conversations.update', { id: c, folderId: sub.id }, true)).status, 200);
  const r = await chatRow(ann, c);
  assert.deepEqual([r.folderId, r.projectId ?? null], [sub.id, null]);
  assert.equal((await folder(ann, { name: 'x', projectId: 'p_nope' })).status, 400); // the projects module is gone
  const c2 = await chat(ann);
  assert.equal((await ann.tr('conversations.bulk', { ids: [c2], action: 'move', folderId: f.id }, true)).json.count, 1);
  assert.equal((await chatRow(ann, c2)).folderId, f.id);
  assert.equal((await ann.tr('conversations.bulk', { ids: [c2], action: 'move', folderId: 'f_nope' }, true)).status, 400);
  const bc = await chat(bob);
  assert.equal((await bob.tr('conversations.update', { id: bc, folderId: f.id }, true)).status, 400);
});

test('positions: reorder folders and chats', async () => {
  const [x, y] = [(await folder(ann, { name: 'X' })).json, (await folder(ann, { name: 'Y' })).json];
  assert.ok(x.position < y.position);
  await ann.tr('folders.move', { id: y.id, position: x.position - 0.5 }, true);
  const order = ((await ann.tr('folders.list')).json as any[]).filter((f) => f.id === x.id || f.id === y.id).map((f) => f.name);
  assert.deepEqual(order, ['Y', 'X']);
  const c = await chat(ann);
  await ann.tr('conversations.update', { id: c, position: 2.5 }, true);
  assert.equal((await chatRow(ann, c)).position, 2.5);
  assert.equal((await ann.tr('conversations.update', { id: c, position: 'top' }, true)).status, 400);
});

test('delete: lift moves children up, delete purges the chats inside', async () => {
  const top = (await folder(ann, { name: 'Top' })).json, mid = (await folder(ann, { name: 'Mid', parentId: top.id })).json, leaf = (await folder(ann, { name: 'Leaf', parentId: mid.id })).json;
  const [c1, c2] = [await chat(ann), await chat(ann)];
  await ann.tr('conversations.update', { id: c1, folderId: mid.id }, true); await ann.tr('conversations.update', { id: c2, folderId: leaf.id }, true);
  assert.equal((await ann.tr('folders.delete', { id: mid.id }, true)).status, 200); // default = lift
  assert.equal(((await ann.tr('folders.list')).json as any[]).find((f) => f.id === leaf.id).parentId, top.id);
  assert.equal((await chatRow(ann, c1)).folderId, top.id);
  assert.equal((await chatRow(ann, c2)).folderId, leaf.id);

  await flueRows(c1); await flueRows(c2);
  assert.ok(fluePresent(c1) && fluePresent(c2));
  assert.equal((await ann.tr('folders.delete', { id: top.id, mode: 'bogus' }, true)).status, 400);
  assert.equal((await ann.tr('folders.delete', { id: top.id, mode: 'delete' }, true)).status, 200);
  assert.equal(((await ann.tr('folders.list')).json as any[]).some((f) => [top.id, leaf.id].includes(f.id)), false);
  assert.equal(await chatRow(ann, c1), undefined);
  assert.equal(await chatRow(ann, c2), undefined);
  assert.equal(fluePresent(c1) + fluePresent(c2), 0); // same purge as deleting a chat
});
