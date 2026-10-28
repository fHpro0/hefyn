import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-mentions-'));
process.env.HEFYN_SECRET = 'mentions-test-secret-mentions-test-secret-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { ChatLinkError, acceptingChats, linkedChat, messageChat, transcript } = await import('../src/server/chat-links.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'worker');
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  const call = (path: string, method = 'GET', body?: unknown) => app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const trpc = (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
  const chat = async (title: string) => (await trpc('conversations.create', { title }, true)).json.id as string;
  return { id: r.user.id, call, trpc, chat };
}
const msg = (role: 'user' | 'assistant', ...parts: any[]) => ({ id: Math.random().toString(), role, display: 'visible', parts }) as any;
const text = (t: string) => ({ type: 'text', text: t, state: 'done' });

test('transcript: turns, tool summaries, no internals, truncated from the front', () => {
  const t = transcript([
    msg('user', text('What is 2+2?\n\nHand this message to the "writer" agent: call the task tool.\n\n<!--mentions:[{"t":"agent","n":"writer"}]-->')),
    msg('assistant', { type: 'reasoning', text: 'secret thoughts', state: 'done' }, { type: 'dynamic-tool', toolName: 'bash', toolCallId: '1', state: 'output-available', input: { command: 'echo 4' }, output: 'HIDDEN OUTPUT' }, text('Four.')),
    { ...msg('assistant', text('internal')), display: 'hidden' },
  ], 'Maths');
  assert.match(t, /^# Chat: Maths/);
  assert.match(t, /\*\*User:\*\* What is 2\+2\?\n/);
  assert.match(t, /_\(tool: bash echo 4\)_/);
  assert.match(t, /\*\*Assistant:\*\* Four\./);
  for (const hidden of ['secret thoughts', 'HIDDEN OUTPUT', 'internal', 'mentions', 'Hand this message']) assert.ok(!t.includes(hidden), hidden);
  const long = transcript(Array.from({ length: 200 }, (_, i) => msg('user', text(`line ${i} ${'x'.repeat(100)}`))), 'Long', 3000);
  assert.match(long, /left out/); assert.match(long, /line 199/); assert.ok(!long.includes('line 0 ')); assert.ok(long.length < 3400);
});

test('chat titles come from the readable text, without mention tokens', async () => {
  const { plainText, mentionLabel } = await import('../web/src/components/mention-text.ts');
  const long = 'Reply with exactly three words: hello from hefyn';
  assert.equal(plainText('@writer Write one line.', [{ n: 'writer' }]), 'Write one line.');
  assert.equal(plainText(`What did ${mentionLabel(long)}say? @writer go`, [{ n: long }, { n: 'writer' }]), 'What did say? go');
  assert.equal(plainText('no mentions here', []), 'no mentions here');
  assert.equal(plainText('@writer ', [{ n: 'writer' }]), '');
});

test('linked chat: only the owner’s chat, with its sealed title opened', async () => {
  const a = await mk('a@x.test'), b = await mk('b@x.test');
  const mine = await a.chat('Quarterly plan'), theirs = await b.chat('Secret plan');
  const history = async (_u: string, id: string) => [msg('user', text(`hello ${id}`))];
  const r = await linkedChat(a.id, mine, history);
  assert.equal(r.title, 'Quarterly plan'); assert.match(r.markdown, /hello u_/);
  assert.notEqual((db.prepare('SELECT title FROM conversations WHERE id = ?').get(mine) as any).title, 'Quarterly plan'); // sealed at rest
  await assert.rejects(linkedChat(a.id, theirs, history), (e: any) => e instanceof ChatLinkError && e.status === 404);
  await assert.rejects(linkedChat(a.id, 'u_nobody_abc', history), ChatLinkError);
});

test('accept_messages: PATCH by the owner only, list_chats filter', async () => {
  const a = await mk('c@x.test'), b = await mk('d@x.test');
  const [one, two, three] = [await a.chat('One'), await a.chat('Two'), await a.chat('Three')];
  assert.equal((await a.trpc('conversations.update', { id: one, acceptMessages: 'yes' }, true)).status, 400);
  assert.equal((await b.trpc('conversations.update', { id: one, acceptMessages: true }, true)).status, 403);
  assert.deepEqual(acceptingChats(a.id), []);
  assert.equal((await a.trpc('conversations.update', { id: two, acceptMessages: true }, true)).status, 200);
  assert.equal((await a.trpc('conversations.update', { id: three, acceptMessages: true }, true)).status, 200);
  assert.deepEqual(acceptingChats(a.id).map((c) => c.title).sort(), ['Three', 'Two']);
  assert.deepEqual(acceptingChats(a.id, two).map((c) => c.title), ['Three']); // never the current chat
  assert.deepEqual(acceptingChats(b.id), []);
  const list = (await a.trpc('conversations.list')).json as any[];
  assert.equal(list.find((c) => c.id === two).acceptMessages, true); assert.equal(list.find((c) => c.id === one).acceptMessages, false);
  assert.equal((await a.trpc('conversations.update', { id: two, acceptMessages: false }, true)).status, 200);
  assert.deepEqual(acceptingChats(a.id).map((c) => c.title), ['Three']);
});

test('message_chat: refuses self, non-accepting, other users’ chats and depth 2; marks the sender', async () => {
  const a = await mk('e@x.test'), b = await mk('f@x.test');
  const src = await a.chat('Source'), open = await a.chat('Open'), closed = await a.chat('Closed'), foreign = await b.chat('Foreign');
  await a.trpc('conversations.update', { id: open, acceptMessages: true }, true);
  await b.trpc('conversations.update', { id: foreign, acceptMessages: true }, true);
  const sent: string[] = [];
  const run = async (_u: string, chat: string, t: string) => { sent.push(`${chat}|${t}`); return 'the answer'; };
  const go = (chat: string, from = src) => messageChat({ userId: a.id, from, chat, message: 'ping', run });
  const refused = (p: Promise<unknown>, status: number) => assert.rejects(p, (e: any) => e instanceof ChatLinkError && e.status === status);
  await refused(go(src), 400);
  await refused(go(closed), 403);
  await refused(go(foreign), 404);
  assert.deepEqual(sent, []);
  assert.deepEqual(await go(open), { chat: 'Open', answer: 'the answer' });
  assert.equal(sent[0], `${open}|From chat “Source”:\n\nping`);
  // depth: while `open` answers a relayed message, it cannot message on (even though `src` accepts)
  await a.trpc('conversations.update', { id: src, acceptMessages: true }, true);
  const nested = async (_u: string, _c: string, _t: string) => { await refused(messageChat({ userId: a.id, from: open, chat: src, message: 'again', run }), 400); return 'ok'; };
  assert.equal((await messageChat({ userId: a.id, from: src, chat: open, message: 'x', run: nested })).answer, 'ok');
  // a failing or slow turn becomes a clear error and frees the target
  await refused(messageChat({ userId: a.id, from: src, chat: open, message: 'x', run: async () => { throw new Error('boom'); } }), 502);
  await refused(messageChat({ userId: a.id, from: src, chat: open, message: 'x', timeoutMs: 20, run: (_u, _c, _t, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) }), 502);
  assert.equal((await go(open)).answer, 'the answer');
});
