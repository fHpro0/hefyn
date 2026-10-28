import { Hono } from 'hono';
import { type Env, requirePermission } from '../../server/guard.ts';
import { createProject, deleteProject, directory, getProject, listProjects, parseInput, ProjectError, updateProject } from './projects.ts';

// /api/projects (projects.ts has the rules: private = owner only, team = per `sharing`).
// Renaming, pinning, archiving and moving a chat go through PATCH /conversations/:id (the module's `conversation.patch`).
export const projectRoutes = new Hono<Env>();
const mu = requirePermission('models.use'); // per route: a use('*') would guard every route registered after it
const err = (c: any, msg: string, status = 400) => c.json({ error: msg }, status);
const guarded = async (c: any, f: () => unknown) => { try { return await f(); } catch (e) { if (e instanceof ProjectError) return err(c, e.message, e.status); throw e; } };

projectRoutes.get('/', mu, (c) => c.json(listProjects(c.var.me.id)));
// People and roles for the sharing picker and `user` fields; emails only for those who may share.
projectRoutes.get('/directory', mu, (c) => { const d = directory(), em = c.var.me.permissions.some((p) => p === 'projects.share' || p === 'projects.manage_team'); return c.json({ roles: d.roles, users: d.users.map((u: any) => ({ id: u.id, name: u.name, ...(em && { email: u.email }) })) }); });
projectRoutes.get('/:id', mu, (c) => { const p = getProject(c.var.me.id, c.req.param('id')); return p ? c.json(p) : err(c, 'not found', 404); });
projectRoutes.post('/', mu, (c) => guarded(c, async () => {
  const f = parseInput(await c.req.json().catch(() => ({})));
  return c.json(getProject(c.var.me.id, createProject(c.var.me.id, f)));
}));
projectRoutes.patch('/:id', mu, (c) => guarded(c, async () => {
  const me = c.var.me.id, id = c.req.param('id');
  const f = parseInput(await c.req.json().catch(() => ({})));
  if (!Object.keys(f).length) return err(c, 'title, description, color, instructions, fields, scope or sharing is required');
  updateProject(me, id, f);
  return c.json(getProject(me, id));
}));
// Everyone's chats move out of the project; ?withChats=1 deletes the caller's own chats in it too (irreversible).
projectRoutes.delete('/:id', mu, (c) => guarded(c, () => { deleteProject(c.var.me.id, c.req.param('id'), c.req.query('withChats') === '1'); return c.body(null, 204); }));
