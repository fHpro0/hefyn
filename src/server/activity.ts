import { db } from './appdb.ts';

// What each chat is doing right now, for `conversations.activity` (the console polls it). The agent process owns the live state (classic busy instances, CLI turns, flow runs), so it
// writes a row per busy chat into chat_activity; the web process reads them with one query. No message content: only state, a step label and helper names. Waiting runs of a flow
// are read from assistant_runs (they outlive the agent process), so a restart that clears the table does not lose a question that is still open.

export type ActivityState = 'running' | 'waiting';
export interface ActivityAgent { id?: string; name: string; kind: 'helper' | 'assistant' | 'agent' | 'step'; state: 'running' | 'waiting' | 'done' | 'failed'; /** what a waiting agent asks to do: the tool's kind or name only (never a path or command) */ ask?: string }
export interface ActivityEntry { state: ActivityState; since?: string; label?: string; agents?: ActivityAgent[]; /** what the chat itself (not a sub-agent) asks to do */ ask?: string }

/** A CLI terminal counts as running only while output arrived this recently (an idle shell prompt is not work). */
export const TERMINAL_QUIET_MS = 10_000;

/** The state of a hosted CLI chat: an open question = waiting, a turn = running, a terminal = running only while it prints. */
export function cliState(o: { busy: boolean; perms: number; terminal: boolean; lastOutput: number; now: number }): ActivityState | undefined {
  if (o.perms > 0) return 'waiting';
  if (o.busy) return 'running';
  return o.terminal && o.now - o.lastOutput < TERMINAL_QUIET_MS ? 'running' : undefined;
}

/** Sets (or, with no state, clears) a chat's activity. `since` stays while the state does not change. Never throws: the status must not break the work. */
export function setActivity(conversationId: string, userId: string, a?: { state: ActivityState; label?: string; agents?: ActivityAgent[]; ask?: string }) {
  try {
    if (!a) { db.prepare('DELETE FROM chat_activity WHERE conversation_id = ?').run(conversationId); return; }
    db.prepare(`INSERT INTO chat_activity (conversation_id, user_id, state, since, label, agents, ask) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (conversation_id) DO UPDATE SET user_id = excluded.user_id, since = CASE WHEN chat_activity.state = excluded.state THEN chat_activity.since ELSE excluded.since END, state = excluded.state, label = excluded.label, agents = excluded.agents, ask = excluded.ask`)
      .run(conversationId, userId, a.state, new Date().toISOString(), a.label ?? null, a.agents?.length ? JSON.stringify(a.agents) : null, a.ask?.slice(0, 60) ?? null);
  } catch { /* the database is closing or the chat is gone */ }
}
/** The agent process just started: nothing it did before is still running. */
export const resetActivity = () => { try { db.exec('DELETE FROM chat_activity'); } catch { /* no table yet */ } };

/** The user's own top-level chats that are working or waiting (idle ones are absent). */
export function activityOf(userId: string): Record<string, ActivityEntry> {
  const out: Record<string, ActivityEntry> = {};
  const rows = db.prepare('SELECT a.conversation_id AS id, a.state, a.since, a.label, a.agents, a.ask FROM chat_activity a JOIN conversations c ON c.id = a.conversation_id WHERE a.user_id = ? AND c.user_id = ? AND c.parent_id IS NULL').all(userId, userId) as
    { id: string; state: ActivityState; since: string; label: string | null; agents: string | null; ask: string | null }[];
  for (const r of rows) out[r.id] = { state: r.state, since: r.since, ...(r.label ? { label: r.label } : {}), ...(r.agents ? { agents: JSON.parse(r.agents) as ActivityAgent[] } : {}), ...(r.ask ? { ask: r.ask } : {}) };
  const waiting = db.prepare("SELECT r.conversation_id AS id, MIN(r.started_at) AS since FROM assistant_runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.user_id = ? AND c.parent_id IS NULL AND r.status = 'waiting' GROUP BY r.conversation_id").all(userId) as { id: string; since: string }[];
  for (const w of waiting) out[w.id] = { ...out[w.id], state: 'waiting', since: out[w.id]?.state === 'waiting' ? out[w.id]!.since : w.since, label: out[w.id]?.label ?? 'Waiting for your answer' };
  return out;
}
