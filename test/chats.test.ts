import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-chats-'));
process.env.HEFYN_SECRET = 'chats-test-secret-chats-test-secret-12';
const DATA = process.env.HEFYN_DATA_DIR;

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate), call: async (path: string, method = 'GET', body?: unknown) => { const res = await app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: (await res.json().catch(() => ({}))) as any }; } };
}
const ann = await mk('ann@x.test', 'worker');
const bob = await mk('bob@x.test', 'worker');
const chat = async (u: typeof ann, extra: object = {}) => (await u.trpc('conversations.create', { title: 'Hello', ...extra }, true)).json.id as string;
const list = async (u: typeof ann, input?: object) => (await u.trpc('conversations.list', input)).json as any[];

// Rows of the retired hefyn chat (Flue's flue.db, left behind by chats made before 2026-10-27): the minimal tables, a stream and a submission per conversation.
const flueDb = join(DATA, 'flue.db');
{
  const d = new DatabaseSync(flueDb);
  d.exec('CREATE TABLE IF NOT EXISTS flue_conversation_streams (path TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS flue_agent_submissions (submission_id TEXT PRIMARY KEY, session_key TEXT); CREATE TABLE IF NOT EXISTS flue_submission_chunks (submission_id TEXT, data TEXT)');
  d.close();
}
async function flueRows(conv: string, agent = 'configurable') {
  const d = new DatabaseSync(flueDb);
  d.prepare('INSERT INTO flue_agent_submissions (submission_id, session_key) VALUES (?, ?)').run(`s-${conv}`, `agent-session:${JSON.stringify([agent, conv, 'default', 'default'])}`);
  d.prepare('INSERT INTO flue_submission_chunks (submission_id, data) VALUES (?, ?)').run(`s-${conv}`, 'hx1:sealed');
  d.prepare('INSERT INTO flue_conversation_streams (path) VALUES (?)').run(`agents/${agent}/${conv}`);
  d.close();
}
const count = (sql: string, ...a: any[]) => { const d = new DatabaseSync(flueDb); try { return (d.prepare(sql).get(...a) as any).n as number; } finally { d.close(); } };
const fluePresent = (conv: string) => count('SELECT COUNT(*) AS n FROM flue_conversation_streams WHERE path LIKE ?', `%/${conv}`) + count('SELECT COUNT(*) AS n FROM flue_agent_submissions WHERE session_key LIKE ?', `%${conv}%`);

test('every new chat is a hosted CLI agent: Claude Code (claude-acp) by default', async () => {
  const r = (await ann.trpc('conversations.create', { title: 'x' }, true)).json;
  assert.equal(r.agent, 'claude-acp');
  assert.equal((await list(ann)).find((c) => c.id === r.id).agent, 'claude-acp');
});

test('rename, pin, archive, move; lists, filters and last activity', async () => {
  const a = await chat(ann), b = await chat(ann);
  assert.equal((await ann.trpc('conversations.update', { id: a, title: '  Quarterly   plan ', pinned: true }, true)).status, 200);
  let row = (await list(ann)).find((r) => r.id === a);
  assert.deepEqual([row.title, row.pinned, row.archivedAt], ['Quarterly plan', true, null]);
  assert.ok(row.updatedAt >= row.createdAt);
  await ann.trpc('conversations.update', { id: b, archived: true }, true);
  assert.ok(!(await list(ann)).some((r) => r.id === b));
  row = (await list(ann, { archived: true })).find((r) => r.id === b);
  assert.ok(row.archivedAt);
  await ann.trpc('conversations.update', { id: b, archived: false }, true);
  assert.ok((await list(ann)).some((r) => r.id === b));
  await ann.trpc('conversations.update', { id: a, pinned: false }, true);
  row = (await list(ann)).find((r) => r.id === a);
  assert.equal(row.pinned, false);
  // validation
  assert.equal((await ann.trpc('conversations.update', { id: a, title: '  ' }, true)).status, 400);
  assert.equal((await ann.trpc('conversations.update', { id: a, pinned: 'yes' }, true)).status, 400);
  assert.equal((await ann.trpc('conversations.update', { id: a }, true)).status, 400);
  // a new chat bumps nothing by itself; a message does (the agent guard calls touchChat, here directly)
  const { touchChat } = await import('../src/server/chats.ts');
  const before = (await list(ann)).find((r) => r.id === b).updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  touchChat(b);
  assert.ok((await list(ann)).find((r) => r.id === b).updatedAt > before);
});

test('another user can not read, change, move or delete them', async () => {
  const a = await chat(ann);
  assert.equal((await bob.trpc('conversations.update', { id: a, title: 'mine now' }, true)).status, 403);
  assert.equal((await bob.trpc('conversations.delete', { id: a }, true)).status, 403);
  assert.equal((await bob.trpc('conversations.bulk', { ids: [a], action: 'delete' }, true)).status, 403);
  assert.ok(!(await list(bob)).some((r) => r.id === a));
  const bc = await chat(bob);
  // mixed bulk: nothing happens
  assert.equal((await ann.trpc('conversations.bulk', { ids: [a, bc], action: 'archive' }, true)).status, 403);
  assert.ok((await list(ann)).some((r) => r.id === a));
  assert.equal((await ann.trpc('conversations.delete', { id: bc }, true)).status, 403);
  assert.ok((await list(bob)).some((r) => r.id === bc));
});

test('DELETE purges the chat everywhere: app.db rows, flue.db rows, scratch dir', async () => {
  const keep = await chat(ann), gone = await chat(ann);
  for (const c of [keep, gone]) { await flueRows(c); mkdirSync(join(DATA, 'users', ann.id, 'tmp', c), { recursive: true }); writeFileSync(join(DATA, 'users', ann.id, 'tmp', c, 'a.txt'), 'x'); }
  db.prepare("INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)").run(ann.id, gone, 'p', 'm', 1, 1, 0, 0, 0.5, new Date().toISOString());
  db.prepare("INSERT INTO outbox (id, user_id, conversation_id, channel_id, recipient, body, status, created_at) VALUES (?,?,?,?,?,?,?,?)").run('o1', ann.id, gone, 'c', 'r', 'b', 'pending', 'now');
  db.prepare("INSERT INTO outbox (id, user_id, conversation_id, channel_id, recipient, body, status, created_at) VALUES (?,?,?,?,?,?,?,?)").run('o2', ann.id, gone, 'c', 'r', 'b', 'sent', 'now');
  assert.ok(fluePresent(gone) > 0);

  assert.equal((await ann.trpc('conversations.delete', { id: gone }, true)).status, 200);
  assert.equal((await ann.trpc('conversations.delete', { id: gone }, true)).status, 404); // already gone
  const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  assert.equal(n('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', gone), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM outbox WHERE id = 'o1'"), 0);
  assert.equal(fluePresent(gone), 0);
  assert.ok(!existsSync(join(DATA, 'users', ann.id, 'tmp', gone)));
  // kept: cost history and the record of a sent message; and the other chat is untouched
  assert.equal(n('SELECT COUNT(*) AS n FROM usage WHERE conversation_id = ?', gone), 1);
  assert.equal(n("SELECT COUNT(*) AS n FROM outbox WHERE id = 'o2'"), 1);
  assert.ok(fluePresent(keep) > 0 && existsSync(join(DATA, 'users', ann.id, 'tmp', keep, 'a.txt')));
  assert.ok((await list(ann)).some((r) => r.id === keep));
});

test('bulk: archive, unarchive, move, delete; bad input', async () => {
  const ids = [await chat(ann), await chat(ann), await chat(ann)];
  assert.equal((await ann.trpc('conversations.bulk', { ids, action: 'archive' }, true)).json.count, 3);
  assert.equal((await list(ann, { archived: true })).filter((r) => ids.includes(r.id)).length, 3);
  await ann.trpc('conversations.bulk', { ids, action: 'unarchive' }, true);
  assert.equal((await list(ann)).filter((r) => ids.includes(r.id)).length, 3);
  for (const bad of [{ ids: [], action: 'delete' }, { ids, action: 'explode' }, { action: 'delete' }, { ids: [1], action: 'delete' }]) assert.equal((await ann.trpc('conversations.bulk', bad, true)).status, 400);
  for (const id of ids) await flueRows(id);
  assert.equal((await ann.trpc('conversations.bulk', { ids, action: 'delete' }, true)).json.count, 3);
  assert.equal((await list(ann)).filter((r) => ids.includes(r.id)).length, 0);
  assert.equal(ids.reduce((s, id) => s + fluePresent(id), 0), 0);
});

test('titles are sealed at rest', async () => {
  const c = await chat(ann);
  const t = db.prepare('SELECT title FROM conversations WHERE id = ?').get(c) as any;
  assert.match(t.title, /^hx1:/);
});
