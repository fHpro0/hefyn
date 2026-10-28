import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './appdb.ts';
import { dropSandbox } from './container-fs.ts';
import { purgeUserFlueData } from './legacy-flue.ts';
import { baseDir } from './storage.ts';
import { userOfConversation } from './usage.ts';
import { sealForUser } from './vault.ts';
import { active, forgetInAll } from '../modules/active.ts';

// Chat management: per-chat metadata and the irreversible delete.
// Projects, folders and schedules plug in through the modules' `conversation` / `onConversationDelete` hooks (src/modules/types.ts).

/** Rename / pin / archive one chat, plus whatever the modules own (project, folder, position…); the caller checked ownership. Returns an error text or undefined. */
export function chatMeta(userId: string, id: string, b: { title?: unknown; pinned?: unknown; archived?: unknown; [moduleKey: string]: unknown }): string | undefined {
  if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim())) return 'title must be a non-empty string';
  if (b.pinned !== undefined && typeof b.pinned !== 'boolean') return 'pinned must be a boolean';
  if (b.archived !== undefined && typeof b.archived !== 'boolean') return 'archived must be a boolean';
  const patches = active().flatMap((m) => (m.conversation?.patch ? [m.conversation.patch] : []));
  for (const p of patches) { const e = p.validate({ userId, id }, b); if (e) return e; }
  if (b.title !== undefined) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(sealForUser(userId, (b.title as string).trim().replace(/\s+/g, ' ').slice(0, 80), `conv:${id}:title`), id);
  if (b.pinned !== undefined) db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(b.pinned ? 1 : 0, id);
  if (b.archived !== undefined) db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(b.archived ? new Date().toISOString() : null, id);
  for (const p of patches) p.apply({ userId, id }, b);
}

/** Last activity of a chat: a message sent to the agent (conversations.updated_at), else its creation. */
export const ACTIVITY_SQL = 'COALESCE(c.updated_at, c.created_at)';
export const touchChat = (id: string) => void db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);

/**
 * Irreversible delete of the user's chats. Removed: the conversation row, every row of the retired hefyn chat for it (flue.db, legacy-flue.ts), the scratch dirs, and outbox messages never sent (pending/rejected).
 * Kept: usage rows (token counts and cost only, no content; they keep the cost history right) and decided outbox rows (a record of what left the account).
 */
export function purgeConversations(userId: string, ids: string[]) {
  let mine = ids.filter((id) => userOfConversation(id) === userId);
  if (!mine.length) return;
  // the hidden chats of a flow chat (its CLI-agent sessions) and its runs go with it
  mine = [...new Set([...mine, ...(db.prepare(`SELECT id FROM conversations WHERE user_id = ? AND parent_id IN (${mine.map(() => '?').join(',')})`).all(userId, ...mine) as { id: string }[]).map((c) => c.id)])];
  const steps = db.prepare(`SELECT instance_id FROM assistant_steps WHERE conversation_id IN (${mine.map(() => '?').join(',')})`).all(...mine) as { instance_id: string }[];
  mine = [...mine, ...steps.map((s) => s.instance_id)]; // their Flue rows go the same way
  const q = mine.map(() => '?').join(',');
  for (const id of mine) void dropSandbox(userId, id); // first, so the stopped agent logs nothing after the rows are gone: its process and sandbox go with the chat
  purgeUserFlueData(userId, new Set(mine)); // first: if it fails nothing else is gone and the delete can be retried
  for (const id of mine) rmSync(join(baseDir(), 'users', userId, 'tmp', id), { recursive: true, force: true });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of ['cli_events', 'assistant_runs', 'assistant_steps']) db.prepare(`DELETE FROM ${t} WHERE conversation_id IN (${q})`).run(...mine);
    // legacy, no writer since outbox removal: existing unsent rows still go with their chat
    db.prepare(`DELETE FROM outbox WHERE user_id = ? AND status IN ('pending', 'rejected') AND conversation_id IN (${q})`).run(userId, ...mine);
    forgetInAll((m) => { for (const id of mine) m.onConversationDelete?.(id, userId); });
    db.prepare(`DELETE FROM conversations WHERE user_id = ? AND id IN (${q})`).run(userId, ...mine);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
