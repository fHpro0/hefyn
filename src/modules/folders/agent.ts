import { db } from '../../server/appdb.ts';
import { defineModule, type SealedSpec } from '../types.ts';
import { placeChat } from './folders.ts';

// The light half of the folders module (what the agent process loads too): the folders table, the chat fields and the sealed names. index.ts adds
// the routes. A folder is a per-user tree of chats; folder_id and position are columns on `conversations` that this module declares in `migrate`.
const folderOf = (userId: string, id: unknown) => !!db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(id as string, userId);

export const foldersLight = defineModule({
  id: 'folders', name: 'Folders', icon: 'Folder',
  migrate(db) {
    // Folders: a per-user tree (also inside shared projects: chats are private, so are folders). A folder in a project holds only chats of that project.
    // project_id is the projects module's, declared here too (idempotent) because moving a chat into a folder sets it.
    db.exec('CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, project_id TEXT, name TEXT NOT NULL, position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const c of ['folder_id TEXT', 'position REAL', 'project_id TEXT']) try { db.exec(`ALTER TABLE conversations ADD COLUMN ${c}`); } catch { /* column exists */ }
  },
  sealed: {
    // Folder names are always written sealed.
    user: (u): SealedSpec[] => [{ sql: 'SELECT id, name FROM folders WHERE user_id = ?', args: [u], table: 'folders', where: ['id'], server: false, cols: { name: (r) => `folder:${r.id}:name` } }],
  },
  onUserDelete(userId) { db.prepare('DELETE FROM folders WHERE user_id = ?').run(userId); },
  conversation: {
    list: { select: ['c.folder_id AS folderId', 'c.position AS position'] },
    patch: {
      keys: ['folderId', 'position'],
      validate({ userId }, b) {
        if (b.position !== undefined && !(typeof b.position === 'number' && Number.isFinite(b.position))) return 'position must be a number';
        if (b.folderId != null && !folderOf(userId, b.folderId)) return 'folderId is not one of your folders';
        if (b.folderId !== undefined && typeof b.folderId !== 'string' && b.folderId !== null) return 'folderId must be a folder id or null';
      },
      apply({ userId, id }, b) {
        if (b.folderId !== undefined) placeChat(userId, id, b.folderId); // a folder decides the project
        if (b.position !== undefined) db.prepare('UPDATE conversations SET position = ? WHERE id = ?').run(b.position as number, id);
      },
    },
    bulk: {
      move: {
        validate({ userId }, b) { if (b.folderId != null && !folderOf(userId, b.folderId)) return 'folderId is not one of your folders'; },
        meta: (b) => ({ folderId: b.folderId ?? null }),
      },
    },
  },
});
