import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-prefs-'));
process.env.HEFYN_SECRET = 'agent-prefs-test-secret-agent-prefs-test-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { loadProfile } = await import('../src/server/profile.ts');
const { hasDefaultModel, resolveRun } = await import('../src/server/agent-prefs.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const THINKS = 'openai/gpt-5', PLAIN = 'openai/gpt-4';
db.prepare("INSERT INTO providers (id, name, enc_key, created_at) VALUES ('openai', 'OpenAI', 'x', 'now')").run();
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate), call: (path: string, method = 'GET', body?: unknown) => app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) };
}

test('team profile: thinking per orchestrator and agent, validated', async () => {
  const admin = await mk('admin@x.test', 'admin');
  assert.equal((await admin.trpc('profile.update', { model: THINKS, thinking: 'ultra', agents: {} }, true)).status, 400);
  assert.equal((await admin.trpc('profile.update', { model: THINKS, agents: {}, agentThinking: { explorer: 'nope' } }, true)).status, 400);
  assert.equal((await admin.trpc('profile.update', { model: THINKS, thinking: 'high', agents: { explorer: PLAIN }, agentThinking: { writer: 'xhigh', explorer: '' } }, true)).status, 200);
  const p = (await admin.trpc('profile.get')).json;
  assert.equal(p.thinking, 'high');
  assert.equal(p.agents.find((a: any) => a.name === 'writer').thinking, 'xhigh');
  assert.equal(p.agents.find((a: any) => a.name === 'explorer').thinking, null);
  assert.equal((await admin.trpc('profile.update', { model: THINKS, thinking: '', agents: {} }, true)).status, 200); // '' clears
  assert.equal(loadProfile().thinking, null);
  await admin.trpc('profile.update', { model: THINKS, thinking: 'high', agents: { explorer: PLAIN }, agentThinking: { writer: 'low' } }, true);
});

test('a chat\'s own effort is validated and cleared with an empty value', async () => {
  const w = await mk('w@x.test', 'admin'); // only models.manage may set a chat's effort (a worker gets 403, see assistants.test.ts)
  assert.equal((await w.call('/me/agents')).status, 404); // the per-user agent overrides are gone
  const { id: cid } = (await w.trpc('conversations.create', { title: 't' }, true)).json;
  assert.equal((await w.trpc('conversations.update', { id: cid, thinking: 'ultra' }, true)).status, 400);
  assert.equal((await w.trpc('conversations.update', { id: cid }, true)).status, 400);
  assert.equal((await w.trpc('conversations.update', { id: cid, thinking: 'low' }, true)).status, 200);
  assert.equal((await w.trpc('conversations.list')).json[0].thinking, 'low');
  assert.equal((await w.trpc('conversations.update', { id: cid, thinking: '' }, true)).status, 200); // '' = default again
  assert.equal((await w.trpc('conversations.list')).json[0].thinking, null);
});

test('resolution: conversation > team, no thinking level for a model that cannot think', () => {
  const models = [{ id: THINKS, reasoning: true }, { id: PLAIN, reasoning: false }];
  const profile = loadProfile(); // orchestrator THINKS/high, explorer PLAIN, writer inherits/low
  const team = resolveRun(profile, undefined, models);
  assert.equal(team.model, THINKS); assert.equal(team.thinkingLevel, 'high');
  assert.deepEqual(team.agents.explorer, { model: PLAIN, thinkingLevel: undefined }); // PLAIN cannot think
  assert.deepEqual(team.agents.writer, { model: undefined, thinkingLevel: 'low' }); // inherits the orchestrator model
  assert.equal(resolveRun(profile, PLAIN, models).model, PLAIN); // a chat's model beats the team's
  assert.equal(resolveRun(profile, PLAIN, models).thinkingLevel, undefined); // ...and a plain model gets no level
  assert.equal(resolveRun(profile, undefined, models, 'off').thinkingLevel, 'off'); // a chat's effort beats the team's
  assert.equal(resolveRun(profile, PLAIN, models, 'high').thinkingLevel, undefined);
  assert.equal(resolveRun(profile, undefined, []).thinkingLevel, undefined); // unknown model: send nothing
});

test('without a profile model a connected provider\'s first model is the fallback; no provider, no chat', async () => {
  const saved = loadProfile().model;
  db.prepare("UPDATE profiles SET model = NULL WHERE id = 'default'").run();
  const u = await mk('solo@example.com', 'worker');
  assert.equal(hasDefaultModel(), false);
  db.prepare("INSERT INTO user_agent_prefs (user_id, agent, model, thinking) VALUES (?, 'orchestrator', ?, NULL)").run(u.id, THINKS);
  assert.equal((await (await u.call('/me')).json()).modelReady, true); // the connected provider offers models (a stale personal override counts for nothing)
  assert.equal(resolveRun(loadProfile(), undefined, [{ id: PLAIN, reasoning: false }]).model, PLAIN); // the first available model
  db.prepare("DELETE FROM providers WHERE id = 'openai'").run();
  assert.equal((await (await u.call('/me')).json()).modelReady, false);
  db.prepare("INSERT INTO providers (id, name, enc_key, created_at) VALUES ('openai', 'OpenAI', 'x', 'now')").run();
  db.prepare("UPDATE profiles SET model = ? WHERE id = 'default'").run(THINKS);
  assert.equal(hasDefaultModel(), true);
  db.prepare("UPDATE profiles SET model = ? WHERE id = 'default'").run(saved);
});
