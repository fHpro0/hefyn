import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The retired hefyn chat (Flue, moved to old/) left its conversations in flue.db. Nothing reads them any more, but deleting a chat or
// "start fresh" still removes their rows (they are sealed, never plain text). Needs no key and no Flue code.
const CONVERSATION = /^u_([A-Za-z0-9-]+)_[0-9A-Za-z]+$/;
/** The conversation id inside a Flue stream path (`agents/<agent>/<id>`) or session key (`agent-session:["agent","<id>",…]`). */
function instanceOf(k: string): string | undefined {
  if (k.startsWith('agents/')) { const p = k.split('/'); return p.length === 3 ? p[2] : undefined; }
  if (k.startsWith('agent-session:')) { try { const v = JSON.parse(k.slice(14)); return Array.isArray(v) ? v[1] : undefined; } catch { return undefined; } }
  return undefined;
}

/** Removes every Flue row of the user's conversations (or only `only`). A missing flue.db is nothing to do. */
export function purgeUserFlueData(userId: string, only?: Set<string>, path = `${process.env.HEFYN_DATA_DIR ?? './data'}/flue.db`) {
  if (!existsSync(path)) return;
  const mine = (k: string) => { const id = instanceOf(k); return !!id && CONVERSATION.exec(id)?.[1] === userId && (!only || only.has(id)); };
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const del = (t: string, col: string, ids: string[]) => { if (has(t)) for (const id of ids) db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(id); };
    const ids = (t: string, col: string) => has(t) ? (db.prepare(`SELECT ${col} AS k FROM ${t}`).all() as { k: string }[]).map((r) => r.k) : [];
    db.exec('BEGIN');
    const subs = has('flue_agent_submissions')
      ? (db.prepare('SELECT submission_id, session_key FROM flue_agent_submissions').all() as any[]).filter((r) => mine(r.session_key)).map((r) => r.submission_id) : [];
    const paths = [...new Set(ids('flue_conversation_streams', 'path'))].filter(mine);
    const attPaths = [...new Set(ids('flue_attachments', 'stream_path'))].filter(mine);
    del('flue_submission_chunks', 'submission_id', subs);
    del('flue_agent_submissions', 'submission_id', subs);
    for (const t of ['flue_conversation_stream_batch_chunks', 'flue_conversation_stream_batches', 'flue_conversation_fold_checkpoint_chunks', 'flue_conversation_fold_checkpoints', 'flue_conversation_streams']) del(t, 'path', paths);
    del('flue_attachment_chunks', 'stream_path', attPaths);
    del('flue_attachments', 'stream_path', attPaths);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw e;
  } finally { db.close(); }
}
