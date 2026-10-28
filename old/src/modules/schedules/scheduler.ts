import { createFlueClient } from '@flue/sdk';
import { randomBytes } from 'node:crypto';
import { db } from '../../server/appdb.ts';
import { agentHeaders } from '../../server/chat-links.ts';
import { AGENT_URL, runtimeState } from '../../server/runtime.ts';
import { type Rule, nextRun } from './schedule-rule.ts';
import { STATUS, dataOf, rowOf, setStatus } from './schedules.ts';
import { LockedError, sealForUser, userKey } from '../../server/vault.ts';

// The scheduler loop (web process only, docs/SCHEDULES.md). Every tick fires the schedules whose time has come.
// - No double fire: claiming a due schedule is one conditional UPDATE (it must still have the `next_run_at` we read, and no live lease) that
//   also moves `next_run_at` on, so a second tick, a second process or a restart cannot fire the same time again. The lease (`lease_until`)
//   keeps one schedule from firing while its previous fire still works.
// - Missed: a time that is more than GRACE_MS in the past (the server was down) is skipped and recorded as "missed".
// - Keys: sealed data needs the user's key. In user key mode it is only in memory after sign-in; a due schedule of a locked user stays due
//   (status "locked — sign in …") and fires on a later tick if it is still inside the grace window.

export const GRACE_MS = 60 * 60_000, LEASE_MS = 30 * 60_000, TICK_MS = 30_000, MAX_CONCURRENT = 3;
const RUN_TIMEOUT_MS = 10 * 60_000;
const ulid = () => Date.now().toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Runners {
  /** Send the prompt to the chat and wait for the answer. Throws on failure. */
  run(userId: string, conversationId: string, text: string, signal: AbortSignal): Promise<void>;
}
const realRunners: Runners = {
  async run(userId, conv, text, signal) {
    if (runtimeState() !== 'running') throw new Error('The agent is restarting.');
    const c = createFlueClient({ url: `${AGENT_URL}/agents/configurable/${conv}`, headers: agentHeaders(userId) });
    await c.read(await c.send({ message: { kind: 'user', body: text } }), { signal });
  },
};
let runners = realRunners;
/** Tests plug a fake model path in here. */
export const setRunners = (r: Runners) => void (runners = r);

const inflight = new Set<string>();
export const firing = () => inflight.size;

const nowIso = () => new Date().toISOString();
/** Takes the lease; `advance` also moves next_run_at on (a due fire). False = somebody else holds it. */
function claim(id: string, advance?: { from: string; next: string | null }): boolean {
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  return (advance
    ? db.prepare('UPDATE schedules SET lease_until = ?, next_run_at = ?, enabled = ? WHERE id = ? AND enabled = 1 AND next_run_at = ? AND (lease_until IS NULL OR lease_until < ?)')
      .run(lease, advance.next, advance.next ? 1 : 0, id, advance.from, nowIso())
    : db.prepare('UPDATE schedules SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)').run(lease, id, nowIso())).changes > 0;
}

export type FireResult = { conversationId: string } | { error: string; status: 404 | 409 | 423 | 429 | 502 };

/** Creates the conversation and starts the turn; the lease must already be held. The turn is followed in the background. */
async function start(id: string): Promise<FireResult> {
  const r = rowOf(id)!, userId = r.user_id;
  const release = () => db.prepare('UPDATE schedules SET lease_until = NULL WHERE id = ?').run(id);
  try {
    const d = dataOf(r);
    const conv = `u_${userId}_${ulid()}`, now = nowIso();
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: r.timezone });
    db.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at, schedule_id) VALUES (?,?,?,?,?,?)')
      .run(conv, userId, sealForUser(userId, `${d.title} · ${day}`.slice(0, 80), `conv:${conv}:title`), now, now, id);
    db.prepare('UPDATE schedules SET last_run_at = ?, last_conversation_id = ? WHERE id = ?').run(now, conv, id);
    setStatus(id, userId, STATUS.running);
    inflight.add(id);
    void follow(id, userId, conv, d.prompt);
    return { conversationId: conv };
  } catch (e) {
    release();
    if (e instanceof LockedError) { db.prepare('UPDATE schedules SET last_status = ? WHERE id = ?').run(STATUS.locked, id); return { error: 'locked', status: 423 }; }
    throw e;
  }
}

async function follow(id: string, userId: string, conv: string, prompt: string) {
  let status: string = STATUS.ok, detail: string | undefined;
  try { await runners.run(userId, conv, prompt, AbortSignal.timeout(RUN_TIMEOUT_MS)); } catch (e) { status = STATUS.failed; detail = msg(e); }
  inflight.delete(id);
  try { setStatus(id, userId, status, detail); } catch { db.prepare('UPDATE schedules SET last_status = ? WHERE id = ?').run(status, id); } // locked meanwhile: status only
  db.prepare('UPDATE schedules SET lease_until = NULL WHERE id = ?').run(id);
}

/** "Run now" from the API: fires once, leaves the schedule's own timetable alone. */
export async function runNow(userId: string, id: string): Promise<FireResult> {
  const r = rowOf(id);
  if (r?.user_id !== userId) return { error: 'not found', status: 404 };
  if (!userKey(userId)) return { error: 'locked', status: 423 };
  if (inflight.has(id)) return { error: 'This schedule is already running.', status: 409 };
  if (inflight.size >= MAX_CONCURRENT) return { error: `At most ${MAX_CONCURRENT} scheduled tasks can run at the same time; try again in a moment.`, status: 429 };
  if (!claim(id)) return { error: 'This schedule is already running.', status: 409 };
  return start(id);
}

/** One pass over the due schedules. `now` is injectable for tests. Returns how many it fired. */
export async function tick(now = Date.now()): Promise<number> {
  const due = db.prepare('SELECT id, user_id, rule, timezone, next_run_at FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(new Date(now).toISOString()) as
    { id: string; user_id: string; rule: string; timezone: string; next_run_at: string }[];
  let fired = 0;
  for (const s of due) {
    const dueAt = Date.parse(s.next_run_at), missed = now - dueAt > GRACE_MS;
    if (!missed) {
      if (!userKey(s.user_id)) { db.prepare('UPDATE schedules SET last_status = ? WHERE id = ?').run(STATUS.locked, s.id); continue; }
      if (inflight.size >= MAX_CONCURRENT || inflight.has(s.id)) continue;
    }
    const rule = JSON.parse(s.rule) as Rule, n = nextRun(rule, s.timezone, now, dueAt);
    if (!claim(s.id, { from: s.next_run_at, next: n === undefined ? null : new Date(n).toISOString() })) continue;
    if (missed) { db.prepare('UPDATE schedules SET lease_until = NULL, last_status = ? WHERE id = ?').run(STATUS.missed, s.id); continue; }
    const r = await start(s.id);
    if (!('error' in r)) fired++;
  }
  return fired;
}

/** Web start (the module's job `init`): a fire that was working when the process stopped lost its follower; its schedule must not look busy forever. */
export const recoverStale = () => void db.prepare('UPDATE schedules SET lease_until = NULL, last_status = ? WHERE last_status = ?').run(STATUS.failed, STATUS.running);
