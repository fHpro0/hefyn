import { db } from '../server/appdb.ts';
import { openForUser, sealForUser } from '../server/vault.ts';
import type { Run, RunState, RunStatus } from './engine.ts';

// assistant_runs: one row per run of an Assistant's flow in a chat. The state (flow snapshot, every step's input and output) is sealed with the owner's key, bound to the row.
const aad = (id: string) => `run:${id}`;
const iso = () => new Date().toISOString();

export function createRun(userId: string, run: Run) {
  db.prepare('INSERT INTO assistant_runs (id, conversation_id, assistant_id, version, status, state, started_at) VALUES (?,?,?,?,?,?,?)')
    .run(run.id, run.conversationId, run.assistantId, run.version, run.status, sealForUser(userId, JSON.stringify(run.state), aad(run.id)), iso());
}
export function saveRun(userId: string, run: Run) {
  const end = run.status === 'running' || run.status === 'waiting';
  db.prepare('UPDATE assistant_runs SET status = ?, state = ?, ended_at = ? WHERE id = ?').run(run.status, sealForUser(userId, JSON.stringify(run.state), aad(run.id)), end ? null : iso(), run.id);
}
export function loadRun(userId: string, id: string): Run | undefined {
  const r = db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(id) as { id: string; conversation_id: string; assistant_id: string; version: number; status: RunStatus; state: string } | undefined;
  return r && { id: r.id, conversationId: r.conversation_id, assistantId: r.assistant_id, version: r.version, status: r.status, state: JSON.parse(openForUser(userId, r.state, aad(id))) as RunState };
}
/** Run ids of a chat in a status (oldest first). */
export const runsWith = (conversationId: string, ...status: RunStatus[]) =>
  (db.prepare(`SELECT id FROM assistant_runs WHERE conversation_id = ? AND status IN (${status.map(() => '?').join(',')}) ORDER BY started_at, rowid`).all(conversationId, ...status) as { id: string }[]).map((r) => r.id);
/** A run that was `running` lost its driver (the agent process restarted): failed, with a plain reason. */
export function failOrphan(userId: string, id: string, why: string) {
  const run = loadRun(userId, id);
  if (!run) return;
  run.status = 'failed'; run.state.error = why;
  saveRun(userId, run);
}
