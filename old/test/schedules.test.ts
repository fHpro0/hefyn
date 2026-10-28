import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-schedules-'));
process.env.HEFYN_SECRET = 'schedules-test-secret-schedules-test-1';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const hub = await import('../src/server/hub.ts');
const vault = await import('../src/server/vault.ts');
const rules = await import('../src/modules/schedules/schedule-rule.ts');
const sched = await import('../src/modules/schedules/scheduler.ts');
const { useScheduleTools } = await import('../src/modules/schedules/tools.ts');
const app = new Hono().route('/api', api);
hub.setGuard(async () => ({ flagged: false }));
const iso = (s: string) => Date.parse(s);
const BER = 'Europe/Berlin';

// ---------- rules ----------
test('rules: parsing is strict', () => {
  assert.deepEqual(rules.parseRule({ kind: 'daily', time: '08:30', junk: 1 }), { kind: 'daily', time: '08:30' });
  assert.deepEqual(rules.parseRule({ kind: 'weekly', days: [5, 1, 5], time: '17:00' }), { kind: 'weekly', days: [1, 5], time: '17:00' });
  for (const bad of [null, {}, { kind: 'cron' }, { kind: 'daily', time: '25:00' }, { kind: 'daily' }, { kind: 'weekly', days: [], time: '10:00' }, { kind: 'weekly', days: [7], time: '10:00' },
    { kind: 'monthly', day: 0, time: '10:00' }, { kind: 'every', minutes: 14 }, { kind: 'every', minutes: 1.5 }, { kind: 'once', at: '2026-02-30T10:00' }, { kind: 'once', at: 'tomorrow' }])
    assert.throws(() => rules.parseRule(bad), rules.RuleError, JSON.stringify(bad));
  assert.ok(rules.validTimezone(BER) && !rules.validTimezone('Mars/Base') && !rules.validTimezone(''));
});

test('rules: next run across DST in Europe/Berlin', () => {
  const daily = rules.parseRule({ kind: 'daily', time: '09:00' }) as import('../src/modules/schedules/schedule-rule.ts').Rule;
  const at = (t: string, r = daily, after = '2026-03-27T12:00:00Z') => new Date(rules.nextRun(r, BER, iso(after), iso(after))!).toISOString();
  assert.equal(at('', daily, '2026-03-27T12:00:00Z'), '2026-03-28T08:00:00.000Z'); // CET, UTC+1
  assert.equal(at('', daily, '2026-03-28T12:00:00Z'), '2026-03-29T07:00:00.000Z'); // after the switch: CEST, UTC+2
  // spring forward 2026-03-29: 02:30 does not exist, it runs right after the gap (03:30 CEST = 01:30Z)
  const night = rules.parseRule({ kind: 'daily', time: '02:30' });
  assert.equal(at('', night, '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z');
  assert.equal(at('', night, '2026-03-29T12:00:00Z'), '2026-03-30T00:30:00.000Z'); // the next day is plain CEST
  // fall back 2026-10-25: 02:30 happens twice, it runs at the first one (CEST, 00:30Z) and only once that day
  assert.equal(at('', night, '2026-10-24T12:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(at('', night, '2026-10-25T00:30:00Z'), '2026-10-26T01:30:00.000Z'); // CET again
  // a week crossing the switch keeps 17:00 local
  const fri = rules.parseRule({ kind: 'weekly', days: [5], time: '17:00' });
  assert.deepEqual(rules.nextRuns(fri, BER, iso('2026-03-20T18:00:00Z'), 2).map((t) => new Date(t).toISOString()), ['2026-03-27T16:00:00.000Z', '2026-04-03T15:00:00.000Z']);
  // monthly day 31 clamps to the month's last day; Feb 2026 has 28
  const m31 = rules.parseRule({ kind: 'monthly', day: 31, time: '10:00' });
  assert.deepEqual(rules.nextRuns(m31, 'UTC', iso('2026-01-31T11:00:00Z'), 3).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-02-28', '2026-03-31', '2026-04-30']);
  // one-off: local time, never in the past
  const once = rules.parseRule({ kind: 'once', at: '2026-12-24T09:00' });
  assert.equal(new Date(rules.nextRun(once, BER, iso('2026-01-01T00:00:00Z'))!).toISOString(), '2026-12-24T08:00:00.000Z');
  assert.equal(rules.nextRun(once, BER, iso('2026-12-25T00:00:00Z')), undefined);
  // every N minutes counts from the scheduled time and skips what was missed
  const every = rules.parseRule({ kind: 'every', minutes: 60 });
  assert.equal(new Date(rules.nextRun(every, BER, iso('2026-01-01T10:20:00Z'), iso('2026-01-01T09:00:00Z'))!).toISOString(), '2026-01-01T11:00:00.000Z');
  // another zone, west of UTC
  assert.equal(new Date(rules.nextRun(rules.parseRule({ kind: 'daily', time: '02:30' }), 'America/New_York', iso('2026-03-07T12:00:00Z'))!).toISOString(), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('rules: described in words', () => {
  assert.equal(rules.describeRule(rules.parseRule({ kind: 'weekly', days: [5], time: '17:00' }), BER), 'Every Friday at 17:00 (Europe/Berlin)');
  assert.equal(rules.describeRule(rules.parseRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00' }), 'UTC'), 'Every weekday at 08:00 (UTC)');
  assert.equal(rules.describeRule(rules.parseRule({ kind: 'every', minutes: 120 }), 'UTC'), 'Every 2 hours');
  assert.equal(rules.describeRule(rules.parseRule({ kind: 'every', minutes: 45 }), 'UTC'), 'Every 45 minutes');
});

// ---------- API, scheduler ----------
const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const signIn = async () => cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  const u = { id: r.user.id, cookie: await signIn(), signIn, t: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), u.cookie, proc, input, mutate), call: async (path: string, method = 'GET', body?: unknown) => { const res = await app.request(`/api${path}`, { method, headers: { cookie: u.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: (await res.json().catch(() => ({}))) as any }; } };
  return u;
}
db.prepare("INSERT INTO providers (id, name, enc_key, created_at) VALUES ('openai', 'OpenAI', 'x', 'now')").run();
const admin = await mk('admin@x.test', 'admin');
const ann = await mk('ann@x.test', 'worker');
const bob = await mk('bob@x.test', 'worker');
assert.equal((await admin.t('profile.update', { model: 'openai/gpt-5', agents: {} }, true)).status, 200);

const freeSent: { user: string; conv: string; text: string }[] = [];
sched.setRunners({ async run(user, conv, text) { freeSent.push({ user, conv, text }); } });

const body = (o: object = {}) => ({ title: 'Weekly report', prompt: 'Write the weekly report', rule: { kind: 'weekly', days: [5], time: '17:00' }, timezone: BER, ...o });
const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;

test('api: CRUD, validation, ownership, sealed at rest, limit', async () => {
  assert.equal((await ann.call('/schedules', 'POST', body({ rule: { kind: 'every', minutes: 5 } }))).status, 400);
  assert.equal((await ann.call('/schedules', 'POST', body({ timezone: 'Mars/Base' }))).status, 400);
  assert.equal((await ann.call('/schedules', 'POST', body({ title: '' }))).status, 400);
  assert.equal((await ann.call('/schedules', 'POST', body({ rule: { kind: 'once', at: '2020-01-01T10:00' } }))).status, 400);
  const prev = (await ann.call('/schedules/preview', 'POST', { rule: { kind: 'daily', time: '09:00' }, timezone: BER })).json;
  assert.equal(prev.next.length, 3);
  assert.equal(prev.ruleText, 'Every day at 09:00 (Europe/Berlin)');

  const made = await ann.call('/schedules', 'POST', body({ title: 'Zebra-title', prompt: 'zebra-prompt-secret' }));
  assert.equal(made.status, 201);
  const s = made.json;
  assert.deepEqual([s.ruleText, s.enabled, s.lastStatus, s.target.kind, s.target.prompt], ['Every Friday at 17:00 (Europe/Berlin)', true, null, 'chat', 'zebra-prompt-secret']);
  assert.ok(Date.parse(s.nextRunAt) > Date.now());
  const raw = JSON.stringify(db.prepare('SELECT * FROM schedules').all());
  assert.ok(!raw.includes('Zebra-title') && !raw.includes('zebra-prompt-secret') && raw.includes('hx1:'), 'title/prompt must be sealed');

  assert.equal((await bob.call(`/schedules/${s.id}`)).status, 404);
  assert.equal((await bob.call(`/schedules/${s.id}`, 'PATCH', { enabled: false })).status, 404);
  assert.equal((await bob.call(`/schedules/${s.id}`, 'DELETE')).status, 404);
  assert.equal((await bob.call(`/schedules/${s.id}/run-now`, 'POST')).status, 404);
  assert.deepEqual((await bob.call('/schedules')).json, []);

  const upd = await ann.call(`/schedules/${s.id}`, 'PATCH', { rule: { kind: 'daily', time: '07:15' }, enabled: false });
  assert.deepEqual([upd.json.ruleText, upd.json.enabled, upd.json.nextRunAt], ['Every day at 07:15 (Europe/Berlin)', false, null]);
  assert.equal((await ann.call(`/schedules/${s.id}`, 'DELETE')).status, 200);

  for (let i = 0; i < 20; i++) assert.equal((await ann.call('/schedules', 'POST', body({ title: `t${i}`, enabled: false }))).status, 201);
  assert.equal((await ann.call('/schedules', 'POST', body())).status, 409); // max 20
  for (const x of (await ann.call('/schedules')).json) await ann.call(`/schedules/${x.id}`, 'DELETE');
});

const makeDue = async (u: typeof ann, o: object = {}, agoMs = 1000) => {
  const s = (await u.call('/schedules', 'POST', body(o))).json;
  db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - agoMs).toISOString(), s.id);
  return s.id as string;
};
const get = async (u: typeof ann, id: string) => (await u.call(`/schedules/${id}`)).json;
const settle = async (u: typeof ann, id: string) => { for (let i = 0; i < 100 && (await get(u, id)).lastStatus === 'running'; i++) await new Promise((r) => setTimeout(r, 20)); return get(u, id); };

test('scheduler: a due schedule starts a titled, flagged chat once; two ticks do not double fire', async () => {
  const id = await makeDue(ann, { title: 'Daily note' });
  freeSent.length = 0;
  const [a, b] = await Promise.all([sched.tick(), sched.tick()]);
  assert.equal(a + b, 1);
  const s = await settle(ann, id);
  assert.equal(freeSent.length, 1);
  assert.equal(freeSent[0]!.text, 'Write the weekly report');
  assert.equal(s.lastStatus, 'ok');
  assert.equal(s.lastConversationId, freeSent[0]!.conv);
  assert.ok(Date.parse(s.nextRunAt) > Date.now(), 'next run moved on');
  assert.equal(conv(s.lastConversationId).schedule_id, id);
  assert.match(vault.openForUser(ann.id, conv(s.lastConversationId).title, `conv:${s.lastConversationId}:title`), /^Daily note · \d{4}-\d{2}-\d{2}$/);
  const listed = (await ann.t('conversations.list')).json.find((c: any) => c.id === s.lastConversationId);
  assert.equal(listed.scheduled, true);
  assert.equal(await sched.tick(), 0); // nothing due any more
  assert.equal(freeSent.length, 1);
});

test('scheduler: a live lease blocks a second claim; a conditional claim is exclusive', async () => {
  const id = await makeDue(ann);
  db.prepare('UPDATE schedules SET lease_until = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), id);
  freeSent.length = 0;
  assert.equal(await sched.tick(), 0);
  assert.equal((await ann.call(`/schedules/${id}/run-now`, 'POST')).status, 409);
  db.prepare('UPDATE schedules SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id); // expired lease
  assert.equal(await sched.tick(), 1);
  await settle(ann, id);
  await ann.call(`/schedules/${id}`, 'DELETE');
});

test('scheduler: missed fires inside the grace window run once, older ones are skipped and recorded', async () => {
  freeSent.length = 0;
  const recent = await makeDue(ann, {}, 30 * 60_000), old = await makeDue(ann, {}, 3 * 3600_000);
  assert.equal(await sched.tick(), 1);
  await settle(ann, recent);
  assert.equal((await get(ann, recent)).lastStatus, 'ok');
  const o = await get(ann, old);
  assert.equal(o.lastStatus, 'missed');
  assert.equal(o.lastConversationId, null);
  assert.ok(Date.parse(o.nextRunAt) > Date.now());
  assert.equal(freeSent.length, 1);
  // a one-off in the past is missed and then done (disabled, no next run)
  const onceId = await makeDue(ann, { rule: { kind: 'once', at: '2099-01-01T09:00' } }, 5 * 3600_000);
  db.prepare('UPDATE schedules SET rule = ? WHERE id = ?').run(JSON.stringify({ kind: 'once', at: '2020-01-01T09:00' }), onceId); // its time has passed
  await sched.tick();
  const d = await get(ann, onceId);
  assert.deepEqual([d.lastStatus, d.enabled, d.nextRunAt], ['missed', false, null]);
  for (const x of (await ann.call('/schedules')).json) await ann.call(`/schedules/${x.id}`, 'DELETE');
});

test('scheduler: a one-off fires once and finishes', async () => {
  const id = await makeDue(ann, { rule: { kind: 'once', at: '2099-01-01T09:00' } });
  db.prepare('UPDATE schedules SET rule = ? WHERE id = ?').run(JSON.stringify({ kind: 'once', at: '2020-01-01T09:00' }), id);
  assert.equal(await sched.tick(), 1);
  const s = await settle(ann, id);
  assert.deepEqual([s.lastStatus, s.enabled, s.nextRunAt], ['ok', false, null]);
  await ann.call(`/schedules/${id}`, 'DELETE');
});

test('scheduler: a locked user is recorded as locked and fires after sign-in; an unlocked user is not blocked', async () => {
  const annId = await makeDue(ann);
  const bid = await makeDue(bob);
  vault.forgetUserKey(bob.id);
  freeSent.length = 0;
  assert.equal(await sched.tick(), 1); // ann's
  await settle(ann, annId);
  assert.equal(db.prepare('SELECT last_status AS s, next_run_at AS n FROM schedules WHERE id = ?').get(bid)!.s, 'locked — sign in to let schedules run');
  assert.equal((await sched.runNow(bob.id, bid) as any).status, 423);
  assert.deepEqual(freeSent.map((f) => f.user), [ann.id]);
  bob.cookie = await bob.signIn(); // the key is back in memory
  assert.equal(await sched.tick(), 1);
  assert.equal((await settle(bob, bid)).lastStatus, 'ok');
  assert.equal(freeSent.at(-1)!.user, bob.id);
  for (const u of [ann, bob]) for (const x of (await u.call('/schedules')).json) await u.call(`/schedules/${x.id}`, 'DELETE');
});

test('scheduler: run-now, global cap of 3, failures are recorded', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  sched.setRunners({ async run() { await gate; } });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await ann.call('/schedules', 'POST', body({ title: `s${i}` }))).json.id);
  for (const id of ids.slice(0, 3)) assert.equal((await ann.call(`/schedules/${id}/run-now`, 'POST')).status, 202);
  assert.equal((await ann.call(`/schedules/${ids[3]}/run-now`, 'POST')).status, 429);
  assert.equal((await ann.call(`/schedules/${ids[0]}/run-now`, 'POST')).status, 409);
  assert.equal(sched.firing(), 3);
  release();
  for (const id of ids.slice(0, 3)) assert.equal((await settle(ann, id)).lastStatus, 'ok');
  assert.ok(Date.parse((await get(ann, ids[0]!)).nextRunAt) > Date.now(), 'run-now keeps the timetable');
  sched.setRunners({ async run() { throw new Error('the model run failed'); } });
  assert.equal((await ann.call(`/schedules/${ids[3]}/run-now`, 'POST')).status, 202);
  const f = await settle(ann, ids[3]!);
  assert.deepEqual([f.lastStatus, f.lastDetail], ['failed', 'the model run failed']);
  assert.equal(sched.firing(), 0);
  for (const id of ids) await ann.call(`/schedules/${id}`, 'DELETE');
});

test('tools: schedule_create / list / delete act for the chat\'s user only', async () => {
  const tools = new Map<string, (a: { data: any }) => Promise<string>>();
  const chat = `u_${ann.id}_tools1`;
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?,?,?,?)').run(chat, ann.id, vault.sealForUser(ann.id, 'x', `conv:${chat}:title`), 'now');
  useScheduleTools(ann.id, chat, ((t: any) => void tools.set(t.name, t.run)) as any);
  assert.deepEqual([...tools.keys()], ['schedule_create', 'schedule_list', 'schedule_delete']);
  assert.equal(await tools.get('schedule_list')!({ data: {} }), 'No scheduled tasks.');
  const made = await tools.get('schedule_create')!({ data: { title: 'Friday report', prompt: 'Write it', rule: { kind: 'weekly', days: [5], time: '17:00' }, timezone: BER } });
  assert.match(made, /Scheduled "Friday report" \(id [\w-]+\): Every Friday at 17:00 \(Europe\/Berlin\)\. Next run: /);
  assert.match(await tools.get('schedule_create')!({ data: { title: 'x', prompt: 'y', rule: { kind: 'every', minutes: 1 } } }), /^Error: minutes must be/);
  const listed = await tools.get('schedule_list')!({ data: {} });
  const id = /^- ([\w-]+):/.exec(listed)![1]!;
  assert.match(listed, /"Friday report", Every Friday at 17:00/);
  assert.equal((await ann.call('/schedules')).json.length, 1);
  // bob's tool cannot see or delete ann's schedule
  const bt = new Map<string, (a: { data: any }) => Promise<string>>();
  const bchat = `u_${bob.id}_tools2`;
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?,?,?,?)').run(bchat, bob.id, vault.sealForUser(bob.id, 'x', `conv:${bchat}:title`), 'now');
  useScheduleTools(bob.id, bchat, ((t: any) => void bt.set(t.name, t.run)) as any);
  assert.equal(await bt.get('schedule_list')!({ data: {} }), 'No scheduled tasks.');
  assert.match(await bt.get('schedule_delete')!({ data: { id } }), /^No scheduled task/);
  assert.match(await tools.get('schedule_delete')!({ data: { id } }), /^Deleted/);
  assert.equal((await ann.call('/schedules')).json.length, 0);
  // a chat started by a schedule gets no schedule tools
  const sid = (await ann.call('/schedules', 'POST', body())).json.id;
  db.prepare('UPDATE conversations SET schedule_id = ? WHERE id = ?').run(sid, chat);
  const none = new Map();
  useScheduleTools(ann.id, chat, ((t: any) => void none.set(t.name, t)) as any);
  assert.equal(none.size, 0);
  await ann.call(`/schedules/${sid}`, 'DELETE');
});
