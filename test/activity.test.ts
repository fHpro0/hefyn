import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// conversations.activity: what the agent process wrote into chat_activity, plus the waiting flow runs of the database, for the caller's own top-level chats only. The CLI host's and
// the flow session's writers are tested with their hosts (cli-host.test.ts, flows-cli.test.ts).
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-activity-'));
process.env.HEFYN_SECRET = 'activity-test-secret-activity-test-1234';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { cliState, resetActivity, setActivity } = await import('../src/server/activity.ts');
vault.setTeamKey(vault.newKey());

const app = new Hono().route('/api', api);
const PW = 'password-12345';
async function mk(email: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'admin');
  const cookie = (await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  vault.rememberUserKey(r.user.id, vault.newKey());
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}
const ann = await mk('ann@x.test'), bob = await mk('bob@x.test');
let n = 0;
const chat = (user: string, parent: string | null = null) => {
  const id = `u_${user}_01ACT${String(++n).padStart(3, '0')}`;
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at, parent_id) VALUES (?,?,?,?,?)').run(id, user, 'x', new Date().toISOString(), parent);
  return id;
};
const activity = async (who: typeof ann) => (await who.trpc('conversations.activity')).json as Record<string, any>;

test('idle chats are absent; a working chat carries state, since, label and agents; only the owner sees it', async () => {
  const a = chat(ann.id), b = chat(bob.id);
  assert.deepEqual(await activity(ann), {});
  setActivity(a, ann.id, { state: 'running', label: 'Draft', agents: [{ id: 'a1b2', name: 'Draft', kind: 'agent', state: 'running' }] });
  setActivity(b, bob.id, { state: 'running' });
  const mine = await activity(ann);
  assert.deepEqual(Object.keys(mine), [a]);
  assert.equal(mine[a].state, 'running'); assert.equal(mine[a].label, 'Draft'); assert.deepEqual(mine[a].agents, [{ id: 'a1b2', name: 'Draft', kind: 'agent', state: 'running' }]);
  assert.match(mine[a].since, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(Object.keys(await activity(bob)), [b]);
  assert.equal((await app.request('/api/trpc/conversations.activity')).status, 401, 'signed-in users only');
  setActivity(a, ann.id);
  assert.deepEqual(await activity(ann), {});
});

test('since stays while the state does not change and moves when it does', async () => {
  const a = chat(ann.id);
  setActivity(a, ann.id, { state: 'running', label: 'one' });
  const first = (await activity(ann))[a].since;
  await new Promise((r) => setTimeout(r, 5));
  setActivity(a, ann.id, { state: 'running', label: 'two' });
  assert.equal((await activity(ann))[a].since, first);
  assert.equal((await activity(ann))[a].label, 'two');
  await new Promise((r) => setTimeout(r, 5));
  setActivity(a, ann.id, { state: 'waiting' });
  const w = (await activity(ann))[a];
  assert.equal(w.state, 'waiting'); assert.notEqual(w.since, first);
  setActivity(a, ann.id);
});

test('hidden child chats are not listed; a waiting flow run is, from the database, and survives the agent process restarting', async () => {
  const parent = chat(ann.id), child = chat(ann.id, parent);
  setActivity(child, ann.id, { state: 'running' });
  assert.equal((await activity(ann))[child], undefined);
  db.prepare("INSERT INTO assistant_runs (id, conversation_id, assistant_id, version, status, state, started_at) VALUES ('run1', ?, 'x', 1, 'waiting', 'sealed', '2026-10-26T10:00:00.000Z')").run(parent);
  setActivity(parent, ann.id, { state: 'running', label: 'Approve' });
  assert.deepEqual([(await activity(ann))[parent].state, (await activity(ann))[parent].label], ['waiting', 'Approve']);
  resetActivity(); // the agent process restarted: what it published is gone
  const r = (await activity(ann))[parent];
  assert.deepEqual([r.state, r.since, r.label], ['waiting', '2026-10-26T10:00:00.000Z', 'Waiting for your answer']);
  assert.deepEqual(Object.keys(await activity(bob)), []);
  db.prepare("UPDATE assistant_runs SET status = 'done' WHERE id = 'run1'").run();
  assert.equal((await activity(ann))[parent], undefined);
});

test('a CLI chat: a turn runs, a question waits, a terminal runs only while it prints (10 s)', () => {
  const t = 1_000_000, base = { busy: false, perms: 0, terminal: false, lastOutput: 0, now: t };
  assert.equal(cliState(base), undefined);
  assert.equal(cliState({ ...base, busy: true }), 'running');
  assert.equal(cliState({ ...base, busy: true, perms: 1 }), 'waiting');
  assert.equal(cliState({ ...base, terminal: true, lastOutput: t - 9_000 }), 'running');
  assert.equal(cliState({ ...base, terminal: true, lastOutput: t - 10_000 }), undefined);
  assert.equal(cliState({ ...base, terminal: false, lastOutput: t - 1 }), undefined, 'a closed terminal is never running');
});

test('what a chat asks to do (a tool kind, no target) is listed for its owner only', async () => {
  const a = chat(ann.id);
  setActivity(a, ann.id, { state: 'waiting', ask: 'edit', agents: [{ id: 'a1', name: 'Draft', kind: 'agent', state: 'waiting', ask: 'Bash' }] });
  const mine = (await activity(ann))[a];
  assert.equal(mine.ask, 'edit'); assert.equal(mine.agents[0].ask, 'Bash');
  assert.deepEqual(await activity(bob), {}, "another user does not see ann's request");
  setActivity(a, ann.id, { state: 'running' });
  assert.equal((await activity(ann))[a].ask, undefined, 'answered: the ask is gone');
  setActivity(a, ann.id);
});
