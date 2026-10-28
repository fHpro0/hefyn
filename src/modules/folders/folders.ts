import { randomBytes } from 'node:crypto';
import { db } from '../../server/appdb.ts';
import { purgeConversations } from '../../server/chats.ts';
import { active } from '../active.ts';
import { openForUser, sealForUser } from '../../server/vault.ts';

// Chat folders: a tree per user (names sealed with the user's key, AAD `folder:<id>:name`). Rules: depth <= MAX_DEPTH, no cycles, a child
// shares its parent's project, and a folder in a project holds only chats of that project (moving a chat in sets its project).
// Projects are optional: the projects module plugs its access check into `projectGate`; with it off, a folder can not be put in a project.
export class FolderError extends Error { status: 400 | 403 | 404; constructor(status: 400 | 403 | 404, msg: string) { super(msg); this.status = status; } }
export const projectGate: { canUse?: (userId: string, id: unknown) => boolean } = {};
export const MAX_DEPTH = 5, MAX_FOLDERS = 500, NAME_MAX = 60;
interface Row { id: string; user_id: string; parent_id: string | null; project_id: string | null; name: string; position: number; created_at: string; updated_at: string }
const aad = (id: string) => `folder:${id}:name`;
const get = (userId: string, id: unknown): Row => {
  const r = typeof id === 'string' ? db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined : undefined;
  if (!r) throw new FolderError(404, 'folder not found');
  return r;
};
const present = (userId: string, r: Row) => ({ id: r.id, name: openForUser(userId, r.name, aad(r.id)), parentId: r.parent_id, projectId: r.project_id, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at });
export const listFolders = (userId: string) => (db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY position, created_at').all(userId) as unknown as Row[]).map((r) => present(userId, r));

const depthOf = (userId: string, id: string | null) => { let n = 0; for (let cur = id; cur && n <= MAX_DEPTH + 1; n++) cur = (db.prepare('SELECT parent_id FROM folders WHERE id = ? AND user_id = ?').get(cur, userId) as { parent_id: string | null } | undefined)?.parent_id ?? null; return n; };
/** The folder and everything below it, parents first. */
const subtree = (userId: string, id: string) => {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of db.prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ?').all(userId, out[i]) as { id: string }[]) out.push(c.id);
  return out;
};
const height = (userId: string, id: string) => { let h = 1; const walk = (x: string, d: number) => { h = Math.max(h, d); for (const c of db.prepare('SELECT id FROM folders WHERE user_id = ? AND parent_id = ?').all(userId, x) as { id: string }[]) walk(c.id, d + 1); }; walk(id, 1); return h; };
const nextPosition = (userId: string, parent: string | null, project: string | null) =>
  (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM folders WHERE user_id = ? AND parent_id IS ? AND project_id IS ?').get(userId, parent, project) as { p: number }).p;
const cleanName = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim()) throw new FolderError(400, 'name must be a non-empty string');
  if (v.trim().length > NAME_MAX) throw new FolderError(400, `name must be at most ${NAME_MAX} characters`);
  return v.trim().replace(/\s+/g, ' ');
};
const cleanPosition = (v: unknown) => { if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) throw new FolderError(400, 'position must be a number'); return v as number | undefined; };
const projectOf = (userId: string, v: unknown) => {
  if (v == null) return null;
  if (!active().some((m) => m.id === 'projects') || !projectGate.canUse?.(userId, v)) throw new FolderError(400, 'projectId is not a project you can use');
  return v as string;
};

export function createFolder(userId: string, b: { name?: unknown; parentId?: unknown; projectId?: unknown; position?: unknown }): string {
  const name = cleanName(b.name), position = cleanPosition(b.position);
  const parent = b.parentId == null ? null : get(userId, b.parentId);
  if (depthOf(userId, parent?.id ?? null) + 1 > MAX_DEPTH) throw new FolderError(400, `folders can be nested ${MAX_DEPTH} levels deep`);
  if ((db.prepare('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?').get(userId) as { n: number }).n >= MAX_FOLDERS) throw new FolderError(400, `at most ${MAX_FOLDERS} folders`);
  const project = parent ? parent.project_id : projectOf(userId, b.projectId), id = `f_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`, now = new Date().toISOString();
  db.prepare('INSERT INTO folders (id, user_id, parent_id, project_id, name, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, parent?.id ?? null, project, sealForUser(userId, name, aad(id)), position ?? nextPosition(userId, parent?.id ?? null, project), now, now);
  return id;
}
export function renameFolder(userId: string, id: string, name: unknown) {
  const r = get(userId, id);
  db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(sealForUser(userId, cleanName(name), aad(r.id)), new Date().toISOString(), r.id);
}

/** { parentId, projectId } (either key present = re-parent: a parent decides the project, else projectId does) and/or { position }. */
export function moveFolder(userId: string, id: string, b: { parentId?: unknown; projectId?: unknown; position?: unknown }) {
  const r = get(userId, id), position = cleanPosition(b.position);
  let parent = r.parent_id, project = r.project_id;
  if ('parentId' in b || 'projectId' in b) {
    const p = b.parentId == null ? null : get(userId, b.parentId);
    const tree = subtree(userId, r.id);
    if (p && tree.includes(p.id)) throw new FolderError(400, 'a folder can not move into itself or into one of its subfolders');
    if (depthOf(userId, p?.id ?? null) + height(userId, r.id) > MAX_DEPTH) throw new FolderError(400, `folders can be nested ${MAX_DEPTH} levels deep`);
    parent = p?.id ?? null; project = p ? p.project_id : projectOf(userId, b.projectId);
    if (project !== r.project_id) { // the whole subtree and the chats in it follow
      const q = tree.map(() => '?').join(',');
      db.prepare(`UPDATE folders SET project_id = ? WHERE user_id = ? AND id IN (${q})`).run(project, userId, ...tree);
      db.prepare(`UPDATE conversations SET project_id = ? WHERE user_id = ? AND folder_id IN (${q})`).run(project, userId, ...tree);
    }
  }
  db.prepare('UPDATE folders SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?').run(parent, position ?? (parent === r.parent_id && project === r.project_id ? r.position : nextPosition(userId, parent, project)), new Date().toISOString(), r.id);
}

/** `lift`: subfolders and chats move up to the parent. `delete`: the subtree and the chats in it are deleted for good (same purge as a chat delete). */
export function deleteFolder(userId: string, id: string, mode: 'lift' | 'delete') {
  const r = get(userId, id);
  if (mode === 'delete') {
    const tree = subtree(userId, id), q = tree.map(() => '?').join(',');
    purgeConversations(userId, (db.prepare(`SELECT id FROM conversations WHERE user_id = ? AND folder_id IN (${q})`).all(userId, ...tree) as { id: string }[]).map((c) => c.id));
    db.prepare(`DELETE FROM folders WHERE user_id = ? AND id IN (${q})`).run(userId, ...tree);
  } else {
    db.prepare('UPDATE folders SET parent_id = ? WHERE user_id = ? AND parent_id = ?').run(r.parent_id, userId, id);
    db.prepare('UPDATE conversations SET folder_id = ? WHERE user_id = ? AND folder_id = ?').run(r.parent_id, userId, id);
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
  }
}

/** Puts a chat into a folder (null = out of any folder): it takes the folder's project. */
export function placeChat(userId: string, chatId: string, folderId: unknown) {
  if (folderId == null) { db.prepare('UPDATE conversations SET folder_id = NULL WHERE id = ?').run(chatId); return; }
  const f = get(userId, folderId);
  db.prepare('UPDATE conversations SET folder_id = ?, project_id = ? WHERE id = ?').run(f.id, f.project_id, chatId);
}
/** A chat that changes project leaves its folder unless the folder is in the new project. */
export function keepFolderConsistent(chatId: string) {
  db.prepare('UPDATE conversations SET folder_id = NULL WHERE id = ? AND folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = conversations.folder_id AND f.project_id IS conversations.project_id)').run(chatId);
}
