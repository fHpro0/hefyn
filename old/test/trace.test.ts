import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-trace-'));
process.env.HEFYN_SECRET = 'trace-test-secret-trace-test-secret-12345';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { traceDeps } = await import('../src/server/routers/trace.ts');
const { buildConversation, filter, totals } = await import('../web/src/components/trace/build.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'worker');
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  const call = (id: string) => trpcCall((p, i) => app.request(p, i), cookie, 'trace.get', { id });
  const chat = async (title: string) => (await trpcCall((p, i) => app.request(p, i), cookie, 'conversations.create', { title }, true)).json.id as string;
  return { id: r.user.id, call, chat };
}

test('trace: the owner gets history, calls and usage; another user gets 404', async () => {
  const [a, b] = [await mk('trace-a@example.com'), await mk('trace-b@example.com')];
  const id = await a.chat('Secret plans');
  const t0 = new Date().toISOString();
  db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)').run(a.id, id, 'openai', 'gpt-x', 10, 5, 0, 0, 0.01, new Date(Date.now() + 5).toISOString());
  traceDeps.history = async () => ({
    messages: [
      { id: 'u', role: 'user', purpose: 'user', display: 'visible', timestamp: t0, parts: [{ type: 'text', text: 'hi Sam', state: 'done' }] },
      { id: 'a', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: t0, submissionId: 's1', parts: [{ type: 'dynamic-tool', toolName: 'bash', toolCallId: 't', state: 'output-available', input: { command: 'date' }, output: 'Mon', durationMs: 20 }, { type: 'text', text: 'Done', state: 'done' }] },
    ],
    settlements: [{ submissionId: 's1', outcome: 'completed', timestamp: new Date(Date.now() + 10).toISOString() }],
  }) as any;

  const r = await a.call(id);
  assert.equal(r.status, 200);
  const t = r.json;
  assert.equal(t.title, 'Secret plans');
  assert.equal(t.messages.length, 2);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].usage.input, 10);
  assert.equal((await b.call(id)).status, 404);
  assert.equal((await app.request(`/api/trpc/trace.get?input=${encodeURIComponent(JSON.stringify({ id }))}`)).status, 401);
  assert.equal((await b.call(`u_${a.id}_0000000000000nope`)).status, 404);

  // the pure part: one response with its model call, tool call and totals; search keeps matching branches
  const items = buildConversation(t, Date.parse(t0));
  const sum = totals(items);
  assert.deepEqual([sum.turns, sum.calls, sum.tools, sum.tokens], [1, 1, 1, 15]);
  assert.equal(filter(items, 'date').length, 1);
  assert.equal(filter(items, 'no-such-text').length, 0);
});
