import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// mentions.linkChat: a chat of the caller written as Markdown into another of their chats' /tmp (host filesystem here, no runner).
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-chat-link-'));
process.env.HEFYN_SECRET = 'chat-link-test-secret-chat-link-test-secret-1';
delete process.env.HEFYN_RUNNER_URL;

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { userFs } = await import('../src/server/storage.ts');
vault.setTeamKey(vault.newKey());
const app = new Hono().route('/api', api);
const PW = 'password-12345';

async function mk(email: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'worker')").run(r.user.id);
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  vault.rememberUserKey(r.user.id, vault.newKey());
  let n = 0;
  return {
    id: r.user.id,
    call: (input: unknown) => trpcCall((p, i) => app.request(p, i), cookie, 'mentions.linkChat', input, true),
    chat(title: string, updates: Record<string, unknown>[] = []) {
      const id = `u_${r.user.id}_01LINK${String(++n).padStart(3, '0')}`;
      db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?,?,?,?)').run(id, r.user.id, vault.sealForUser(r.user.id, title, `conv:${id}:title`), 'now');
      updates.forEach((u, k) => db.prepare('INSERT INTO cli_events (conversation_id, seq, data) VALUES (?,?,?)').run(id, k + 1, vault.sealForUser(r.user.id, JSON.stringify({ at: 'now', update: u }), `cli:${id}:${k + 1}`)));
      return id;
    },
  };
}
const ann = await mk('ann@x.test'), bob = await mk('bob@x.test');
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const read = (userId: string, conv: string, path: string) => userFs({ userId, conversationId: conv }).readFile(path).then((b) => Buffer.from(b).toString());

test('the owner links a chat: user text, agent text and tool titles, no raw output', async () => {
  const src = ann.chat('Q3 summary', [
    { hefyn: 'user', text: 'Summarise Q3' }, chunk('Revenue '), chunk('grew.'),
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read report.csv', status: 'pending', rawOutput: 'SECRET-RAW' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'SECRET-RAW' } }] },
    { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Sub-agent step', agent: 'sub1' },
  ]);
  const dst = ann.chat('Now');
  const r = await ann.call({ id: dst, chat: src });
  assert.equal(r.status, 200, r.error ?? '');
  assert.deepEqual(r.json, { path: '/tmp/hefyn-linked/q3-summary.md', title: 'Q3 summary' });
  const md = await read(ann.id, dst, r.json.path);
  assert.match(md, /^# Q3 summary/);
  assert.match(md, /## You\n\nSummarise Q3/);
  assert.match(md, /## Agent\n\nRevenue grew\./);
  assert.match(md, /- Tool: Read report\.csv \(completed\)/);
  assert.doesNotMatch(md, /SECRET-RAW|Sub-agent step/);
  const again = await ann.call({ id: dst, chat: src }); // a second link of the same chat does not overwrite the first
  assert.equal(again.json.path, '/tmp/hefyn-linked/q3-summary-2.md');
});

test('another user\'s chat, or another user\'s target, is FORBIDDEN', async () => {
  const mine = ann.chat('mine', [{ hefyn: 'user', text: 'hi' }]), theirs = bob.chat('theirs', [{ hefyn: 'user', text: 'secret' }]);
  assert.equal((await ann.call({ id: mine, chat: theirs })).code, 'FORBIDDEN');
  assert.equal((await ann.call({ id: theirs, chat: mine })).code, 'FORBIDDEN');
  assert.equal((await ann.call({ id: mine, chat: 'nonsense' })).code, 'FORBIDDEN');
});

test('an empty chat is a clear error', async () => {
  const r = await ann.call({ id: ann.chat('target'), chat: ann.chat('empty') });
  assert.equal(r.code, 'BAD_REQUEST');
  assert.match(r.error!, /no messages/);
});

test('a long chat is cut at the oldest turns', async () => {
  const big = 'x'.repeat(50_000);
  const src = ann.chat('Big', [1, 2, 3, 4, 5, 6].flatMap((n) => [{ hefyn: 'user', text: `question ${n} ${big}` }]));
  const dst = ann.chat('t2');
  const md = await read(ann.id, dst, (await ann.call({ id: dst, chat: src })).json.path);
  assert.ok(md.length < 205_000, String(md.length));
  assert.match(md, /left out to keep this file short/);
  assert.match(md, /question 6/);
  assert.doesNotMatch(md, /question 1 /);
});
