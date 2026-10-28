import { db } from '../../server/appdb.ts';
import { defineModule, type SealedSpec } from '../types.ts';
import { keepFolderConsistent, projectGate } from '../folders/folders.ts';
import { canUseProject, projectInstructions } from './projects.ts';

// The light half of the projects module (what the agent process loads too): its tables, sealed columns, the chat field and the project
// instructions. index.ts adds the routes, nav, palette and permissions. The project is a column on `conversations` (project_id) that this
// module declares in `migrate`: one row per chat, no side table. Folders are their own (built-in) module; a folder may sit in a project.
projectGate.canUse = canUseProject; // folders.ts only honours it while this module is on

export const projectsLight = defineModule({
  id: 'projects', name: 'Projects', icon: 'FolderKanban', optional: true,
  migrate(db) {
    // Projects group chats (name + instructions sealed with the owner's key, or the team key once shared); `sharing` says who may see/edit a team project.
    db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const c of ['description TEXT', 'fields TEXT', "scope TEXT NOT NULL DEFAULT 'private'", 'sharing TEXT']) try { db.exec(`ALTER TABLE projects ADD COLUMN ${c}`); } catch { /* column exists */ }
    try { db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT'); } catch { /* column exists */ }
  },
  sealed: {
    // Team projects are sealed with the team key and have no legacy plaintext.
    user: (u): SealedSpec[] => [
      { sql: "SELECT id, name, instructions, description, fields FROM projects WHERE user_id = ? AND scope = 'private'", args: [u], table: 'projects', where: ['id'], server: false,
        cols: { name: (r) => `proj:${r.id}:name`, instructions: (r) => `proj:${r.id}:instructions`, description: (r) => `proj:${r.id}:description`, fields: (r) => `proj:${r.id}:fields` } },
    ],
  },
  onUserDelete(userId) {
    db.prepare("DELETE FROM projects WHERE user_id = ? AND scope = 'private'").run(userId); // team projects are sealed with the team key and stay
  },
  conversation: {
    create({ me, body }) {
      const projectId = body.projectId;
      if (projectId != null && !canUseProject(me.id, projectId)) return { error: ['projectId is not one of your projects', 403] };
      return { columns: { project_id: projectId ?? null }, response: { projectId: projectId ?? null } };
    },
    list: {
      select: ['c.project_id AS projectId'],
      filter: (q) => (q('project') ? { sql: 'AND c.project_id = ?', args: [q('project')!] } : undefined),
    },
    patch: {
      keys: ['projectId'],
      validate({ userId }, b) {
        if (b.projectId !== undefined && b.projectId !== null && !canUseProject(userId, b.projectId)) return 'projectId is not one of your projects';
      },
      apply({ id }, b) {
        if (b.projectId !== undefined) { db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run((b.projectId ?? null) as string | null, id); keepFolderConsistent(id); }
      },
    },
    bulk: {
      moveToProject: {
        validate({ userId }, b) { if (b.projectId !== null && !canUseProject(userId, b.projectId)) return 'projectId must be a project you can use, or null'; },
        meta: (b) => ({ projectId: b.projectId, folderId: null }),
      },
    },
  },
  agent: {
    // A chat in a project: the project's standing instructions.
    instructions({ conversationId }) {
      const text = projectInstructions(conversationId);
      return text ? { id: 'project', title: 'Project instructions', text } : undefined;
    },
  },
});
