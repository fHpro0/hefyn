import { randomUUID } from 'node:crypto';
import { db } from '../../server/appdb.ts';
import { type Rule, describeRule, nextRun, nextRuns, parseRule, validTimezone, RuleError } from './schedule-rule.ts';
import { openForUser, sealForUser } from '../../server/vault.ts';

// Scheduled tasks (docs/SCHEDULES.md). Store only: shared by the web process (API, scheduler) and the agent process (schedule_* tools).
// Title and prompt are sealed with the owner's user key (AAD `schedule:<id>:data`); the rule, time zone, times and a fixed
// status text stay in clear because the scheduler has to compute and compare them without the key.

// The tables are created by the module's `migrate` (agent.ts).

export const MAX_PER_USER = 20;
export const STATUS = { running: 'running', ok: 'ok', failed: 'failed', missed: 'missed', locked: 'locked — sign in to let schedules run' } as const;
export class ScheduleError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

interface Row { id: string; user_id: string; data: string; rule: string; timezone: string; enabled: number; next_run_at: string | null; lease_until: string | null;
  last_run_at: string | null; last_status: string | null; last_detail: string | null; last_conversation_id: string | null; created_at: string }
interface Data { title: string; prompt: string }
const aad = (id: string) => `schedule:${id}:data`, detailAad = (id: string) => `schedule:${id}:detail`;
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

export const rowOf = (id: string) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as Row | undefined;
export const dataOf = (r: Row): Data => JSON.parse(openForUser(r.user_id, r.data, aad(r.id)));

export function view(r: Row) {
  const rule = JSON.parse(r.rule) as Rule, d = dataOf(r);
  return { id: r.id, userId: r.user_id, title: d.title, target: { kind: 'chat' as const, prompt: d.prompt }, rule, ruleText: describeRule(rule, r.timezone), timezone: r.timezone,
    enabled: !!r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastStatus: r.last_status, lastDetail: r.last_detail ? openForUser(r.user_id, r.last_detail, detailAad(r.id)) : null,
    lastConversationId: r.last_conversation_id, createdAt: r.created_at };
}
export type ScheduleView = ReturnType<typeof view>;

export const listSchedules = (userId: string) => (db.prepare('SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as Row[]).map(view);
export const getSchedule = (userId: string, id: string) => { const r = rowOf(id); return r?.user_id === userId ? view(r) : undefined; };

export interface ScheduleInput { title: unknown; prompt: unknown; rule: unknown; timezone: unknown; enabled?: unknown }

function clean(i: ScheduleInput) {
  const title = String(i.title ?? '').trim(), prompt = String(i.prompt ?? '').trim();
  if (!title || title.length > 80) throw new ScheduleError('A title of 1 to 80 characters is required.');
  if (!prompt || prompt.length > 20_000) throw new ScheduleError('A prompt of 1 to 20000 characters is required.');
  if (!validTimezone(i.timezone)) throw new ScheduleError('timezone must be an IANA time zone such as Europe/Berlin.');
  let rule: Rule;
  try { rule = parseRule(i.rule); } catch (e) { if (e instanceof RuleError) throw new ScheduleError(e.message); throw e; }
  const next = nextRun(rule, i.timezone, Date.now());
  if (rule.kind === 'once' && next === undefined) throw new ScheduleError('That date is in the past.');
  return { data: { title, prompt } satisfies Data, rule, timezone: i.timezone, next };
}

export function createSchedule(userId: string, i: ScheduleInput): ScheduleView {
  const c = clean(i);
  if ((db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?').get(userId) as { n: number }).n >= MAX_PER_USER) throw new ScheduleError(`At most ${MAX_PER_USER} schedules per user.`, 409);
  const id = randomUUID();
  db.prepare('INSERT INTO schedules (id, user_id, data, rule, timezone, enabled, next_run_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, sealForUser(userId, JSON.stringify(c.data), aad(id)), JSON.stringify(c.rule), c.timezone, i.enabled === false ? 0 : 1, iso(c.next), new Date().toISOString());
  return getSchedule(userId, id)!;
}

export function updateSchedule(userId: string, id: string, p: Partial<ScheduleInput>): ScheduleView | undefined {
  const r = rowOf(id);
  if (r?.user_id !== userId) return;
  const cur = view(r);
  const c = clean({ title: p.title ?? cur.title, prompt: p.prompt ?? cur.target.prompt, rule: p.rule ?? cur.rule, timezone: p.timezone ?? cur.timezone });
  const enabled = p.enabled === undefined ? cur.enabled : !!p.enabled;
  db.prepare('UPDATE schedules SET data = ?, rule = ?, timezone = ?, enabled = ?, next_run_at = ? WHERE id = ?')
    .run(sealForUser(userId, JSON.stringify(c.data), aad(id)), JSON.stringify(c.rule), c.timezone, enabled ? 1 : 0, enabled ? iso(c.next) : null, id);
  return getSchedule(userId, id);
}

/** A deleted chat leaves its schedule's "last run" link dangling otherwise. */
export const unlinkConversation = (userId: string, conversationId: string) =>
  void db.prepare('UPDATE schedules SET last_conversation_id = NULL WHERE user_id = ? AND last_conversation_id = ?').run(userId, conversationId);
export const deleteSchedulesOf = (userId: string) => void db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);

export const deleteSchedule =(userId: string, id: string) => db.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;

/** The next three runs for the editor's preview (and a cheap rule check). */
export function previewRule(rule: unknown, timezone: unknown) {
  if (!validTimezone(timezone)) throw new ScheduleError('timezone must be an IANA time zone such as Europe/Berlin.');
  let r: Rule;
  try { r = parseRule(rule); } catch (e) { if (e instanceof RuleError) throw new ScheduleError(e.message); throw e; }
  return { ruleText: describeRule(r, timezone), next: nextRuns(r, timezone, Date.now(), 3).map((t) => new Date(t).toISOString()) };
}

export function setStatus(id: string, userId: string, status: string, detail?: string) {
  db.prepare('UPDATE schedules SET last_status = ?, last_detail = ? WHERE id = ?').run(status, detail ? sealForUser(userId, detail.slice(0, 300), detailAad(id)) : null, id);
}
