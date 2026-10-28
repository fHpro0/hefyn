import { randomBytes } from 'node:crypto';
import { db } from '../../server/appdb.ts';
import { purgeConversations } from '../../server/chats.ts';
import { userOfConversation } from '../../server/usage.ts';
import { openForTeam, openForUser, sealForTeam, sealForUser } from '../../server/vault.ts';

// Projects (docs/ENCRYPTION.md): content columns (name = title, description, instructions, fields) are sealed with the OWNER's key while the
// project is private and with the TEAM key once it is shared; the AAD is `proj:<id>:<column>` either way, and a scope switch re-seals
// every column in one transaction. `sharing` (who may see/edit) is plain: ids only, no content. Chats stay private to whoever starts them.

export class ProjectError extends Error { status: 400 | 403 | 404; constructor(status: 400 | 403 | 404, msg: string) { super(msg); this.status = status; } }
export type Access = 'owner' | 'editor' | 'viewer';
export interface Sharing { everyone: boolean; roleIds: string[]; userIds: string[]; access: Record<string, 'editor' | 'viewer'> } // access keys: user id, role id, or '*' (everyone); default viewer
export const FIELD_TYPES = ['text', 'longtext', 'number', 'date', 'url', 'email', 'select', 'user'] as const;
export interface Field { id: string; label: string; type: (typeof FIELD_TYPES)[number]; options?: string[]; value: string | number | null }
const LIMITS = { title: 60, description: 500, instructions: 8000, fields: 30, label: 60, text: 200, longtext: 2000, option: 60, options: 30, members: 200 };
const COLOR = /^#[0-9a-fA-F]{6}$/;

interface Row { id: string; user_id: string; name: string; color: string | null; instructions: string; description: string | null; fields: string | null; scope: 'private' | 'team'; sharing: string | null; created_at: string; updated_at: string }
const COLS = ['name', 'description', 'instructions', 'fields'] as const;
const aad = (id: string, col: string) => `proj:${id}:${col}`;
const sealCol = (scope: string, owner: string, id: string, col: string, plain: string) => scope === 'team' ? sealForTeam(plain, aad(id, col)) : sealForUser(owner, plain, aad(id, col));
const openCol = (r: Row, col: (typeof COLS)[number]) => { const v = r[col]; if (v == null) return ''; return r.scope === 'team' ? openForTeam(v, aad(r.id, col)) : openForUser(r.user_id, v, aad(r.id, col)); };

const who = (userId: string) => {
  const r = db.prepare('SELECT ur.role_id AS roleId, r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').get(userId) as { roleId: string; permissions: string } | undefined;
  return { roleId: r?.roleId, perms: new Set<string>(r ? JSON.parse(r.permissions) : []) };
};
const sharingOf = (r: Row): Sharing => { try { return { everyone: false, roleIds: [], userIds: [], access: {}, ...JSON.parse(r.sharing ?? '{}') }; } catch { return { everyone: false, roleIds: [], userIds: [], access: {} }; } };
const getRow = (id: string) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;

/** What this user may do with the project: owner, editor, viewer, or nothing (undefined = it does not exist for them). */
export function accessOf(r: Row, userId: string): Access | undefined {
  if (r.user_id === userId) return 'owner';
  if (r.scope !== 'team') return;
  const { roleId, perms } = who(userId), s = sharingOf(r), hits: ('editor' | 'viewer')[] = [];
  if (perms.has('projects.manage_team')) return 'editor'; // admins of team projects can always open them to manage them
  if (s.userIds.includes(userId)) hits.push(s.access[userId] ?? 'viewer');
  if (roleId && s.roleIds.includes(roleId)) hits.push(s.access[roleId] ?? 'viewer');
  if (s.everyone) hits.push(s.access['*'] ?? 'viewer');
  return hits.includes('editor') ? 'editor' : hits[0];
}
const canManage = (r: Row, userId: string) => r.user_id === userId || (r.scope === 'team' && who(userId).perms.has('projects.manage_team'));

const nameOf = (id: string) => (db.prepare('SELECT name FROM user WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '';
function view(r: Row, userId: string) {
  const access = accessOf(r, userId)!, s = sharingOf(r);
  const fields = JSON.parse(openCol(r, 'fields') || '[]') as Field[];
  const members = r.scope === 'team' ? {
    everyone: s.everyone,
    users: s.userIds.map((id) => ({ id, name: nameOf(id), access: s.access[id] ?? 'viewer' })),
    roles: s.roleIds.map((id) => ({ id, name: (db.prepare('SELECT name FROM roles WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id, access: s.access[id] ?? 'viewer' })),
    everyoneAccess: s.access['*'] ?? 'viewer',
  } : null;
  return {
    id: r.id, title: openCol(r, 'name'), description: openCol(r, 'description'), color: r.color, instructions: openCol(r, 'instructions'), fields,
    scope: r.scope, access, canManage: canManage(r, userId), isOwner: r.user_id === userId, owner: { id: r.user_id, name: nameOf(r.user_id) },
    sharing: r.scope === 'team' ? s : null, members,
    // only the caller's own chats: chats stay private to whoever starts them
    chatCount: (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id = ? AND user_id = ? AND archived_at IS NULL').get(r.id, userId) as { n: number }).n,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const listProjects = (userId: string) =>
  (db.prepare("SELECT * FROM projects WHERE user_id = ? OR scope = 'team' ORDER BY created_at").all(userId) as unknown as Row[]).filter((r) => accessOf(r, userId)).map((r) => view(r, userId));
export function getProject(userId: string, id: string) { const r = getRow(id); return r && accessOf(r, userId) ? view(r, userId) : undefined; }
export const canUseProject = (userId: string, id: unknown) => typeof id === 'string' && !!getProject(userId, id);
/** People and roles a sharer can pick (names only; needs projects.share or projects.manage_team, checked by the route). */
export const directory = () => ({
  users: db.prepare('SELECT u.id, u.name, u.email, ur.role_id AS roleId FROM user u JOIN user_roles ur ON ur.user_id = u.id ORDER BY u.name').all(),
  roles: db.prepare('SELECT id, name FROM roles ORDER BY name').all(),
});

// ---- input ----
const str = (v: unknown, max: number, what: string, req = false) => {
  if (typeof v !== 'string') throw new ProjectError(400, `${what} must be text`);
  const t = v.trim();
  if (req && !t) throw new ProjectError(400, `${what} is required`);
  if (t.length > max) throw new ProjectError(400, `${what} must be at most ${max} characters`);
  return t;
};
function cleanFields(raw: unknown): Field[] {
  if (!Array.isArray(raw) || raw.length > LIMITS.fields) throw new ProjectError(400, `fields must be a list of at most ${LIMITS.fields}`);
  const seen = new Set<string>();
  return raw.map((f: any, i) => {
    if (!f || typeof f !== 'object') throw new ProjectError(400, `fields[${i}] must be an object`);
    const id = typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(f.id) ? f.id : '';
    if (!id || seen.has(id)) throw new ProjectError(400, `fields[${i}].id must be unique (letters, digits, - and _)`);
    seen.add(id);
    if (!FIELD_TYPES.includes(f.type)) throw new ProjectError(400, `fields[${i}].type must be one of ${FIELD_TYPES.join(', ')}`);
    const label = str(f.label, LIMITS.label, `fields[${i}].label`, true), t: Field['type'] = f.type;
    let options: string[] | undefined;
    if (t === 'select') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > LIMITS.options) throw new ProjectError(400, `fields[${i}].options must list 1-${LIMITS.options} choices`);
      options = f.options.map((o: unknown) => str(o, LIMITS.option, `fields[${i}].options`, true));
    }
    const v = f.value, empty = v == null || v === '';
    let value: Field['value'] = null;
    if (!empty) {
      const bad = (m: string) => new ProjectError(400, `fields[${i}] (${label}): ${m}`);
      if (t === 'number') { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; if (!Number.isFinite(n)) throw bad('must be a number'); value = n; }
      else {
        if (typeof v !== 'string') throw bad('must be text');
        value = v.trim();
        if (value.length > (t === 'longtext' ? LIMITS.longtext : LIMITS.text)) throw bad('is too long');
        if (t === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)))) throw bad('must be a date (YYYY-MM-DD)');
        if (t === 'url') { try { if (!/^https?:$/.test(new URL(value).protocol)) throw 0; } catch { throw bad('must be an http(s) URL'); } }
        if (t === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw bad('must be an email address');
        if (t === 'select' && !options!.includes(value)) throw bad('must be one of the options');
        if (t === 'user' && !db.prepare('SELECT 1 FROM user WHERE id = ?').get(value)) throw bad('must be a user of this team');
      }
    }
    return { id, label, type: t, ...(options ? { options } : {}), value };
  });
}
function cleanSharing(raw: unknown): Sharing {
  const b = (raw && typeof raw === 'object' ? raw : {}) as any;
  const ids = (v: unknown, what: string, exists: (id: string) => boolean) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > LIMITS.members || !v.every((x) => typeof x === 'string')) throw new ProjectError(400, `sharing.${what} must be a list of ids`);
    const out = [...new Set(v as string[])];
    const missing = out.find((x) => !exists(x));
    if (missing) throw new ProjectError(400, `sharing.${what}: unknown id ${missing}`);
    return out;
  };
  const roleIds = ids(b.roleIds, 'roleIds', (x) => !!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(x));
  const userIds = ids(b.userIds, 'userIds', (x) => !!db.prepare('SELECT 1 FROM user WHERE id = ?').get(x));
  const access: Sharing['access'] = {};
  for (const [k, v] of Object.entries(b.access ?? {})) {
    if (v !== 'editor' && v !== 'viewer') throw new ProjectError(400, 'sharing.access values must be editor or viewer');
    if (k === '*' || roleIds.includes(k) || userIds.includes(k)) access[k] = v;
  }
  return { everyone: b.everyone === true, roleIds, userIds, access };
}

export interface Input { title?: string; description?: string; color?: string | null; instructions?: string; fields?: Field[]; scope?: 'private' | 'team'; sharing?: Sharing }
/** Validates the body (throws ProjectError); only the keys that were sent come back. */
export function parseInput(b: any): Input {
  b = b && typeof b === 'object' ? b : {};
  const o: Input = {};
  if (b.title !== undefined) o.title = str(b.title, LIMITS.title, 'title', true);
  if (b.description !== undefined) o.description = str(b.description, LIMITS.description, 'description');
  if (b.instructions !== undefined) { if (typeof b.instructions !== 'string' || b.instructions.length > LIMITS.instructions) throw new ProjectError(400, `instructions must be text of up to ${LIMITS.instructions} characters`); o.instructions = b.instructions; }
  if (b.color !== undefined) { if (b.color !== null && !(typeof b.color === 'string' && COLOR.test(b.color))) throw new ProjectError(400, 'color must be #rrggbb or null'); o.color = b.color; }
  if (b.fields !== undefined) o.fields = cleanFields(b.fields);
  if (b.scope !== undefined) { if (b.scope !== 'private' && b.scope !== 'team') throw new ProjectError(400, "scope must be 'private' or 'team'"); o.scope = b.scope; }
  if (b.sharing !== undefined) o.sharing = cleanSharing(b.sharing);
  return o;
}

// ---- writes ----
const write = (r: Row, c: { title: string; description: string; instructions: string; fields: Field[]; color: string | null; scope: 'private' | 'team'; sharing: Sharing | null }) => {
  db.prepare('UPDATE projects SET name = ?, description = ?, instructions = ?, fields = ?, color = ?, scope = ?, sharing = ?, updated_at = ? WHERE id = ?')
    .run(sealCol(c.scope, r.user_id, r.id, 'name', c.title), sealCol(c.scope, r.user_id, r.id, 'description', c.description), sealCol(c.scope, r.user_id, r.id, 'instructions', c.instructions),
      sealCol(c.scope, r.user_id, r.id, 'fields', JSON.stringify(c.fields)), c.color, c.scope, c.scope === 'team' ? JSON.stringify(c.sharing ?? sharingOf(r)) : null, new Date().toISOString(), r.id);
};

export function createProject(userId: string, i: Input): string {
  if (!i.title) throw new ProjectError(400, 'title is required');
  const scope = i.scope ?? 'private';
  if (scope === 'team' && !who(userId).perms.has('projects.share')) throw new ProjectError(403, 'You may not share projects with the team.');
  const id = `p_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`, now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO projects (id, user_id, name, instructions, scope, created_at, updated_at) VALUES (?,?,'','',?,?,?)").run(id, userId, scope, now, now);
    write(getRow(id)!, { title: i.title, description: i.description ?? '', instructions: i.instructions ?? '', fields: i.fields ?? [], color: i.color ?? null, scope, sharing: i.sharing ?? null });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return id;
}

export function updateProject(userId: string, id: string, i: Input) {
  const r = getRow(id), acc = r && accessOf(r, userId);
  if (!r || !acc) throw new ProjectError(404, 'not found');
  const content = i.title !== undefined || i.description !== undefined || i.instructions !== undefined || i.color !== undefined || i.fields !== undefined;
  if (content && acc === 'viewer') throw new ProjectError(403, 'You can view this project but not change it.');
  const perms = who(userId).perms, scope = i.scope ?? r.scope;
  if (i.scope && i.scope !== r.scope && r.user_id !== userId) throw new ProjectError(403, 'Only the owner can change whether a project is private or shared.');
  if (scope === 'team' && (i.scope === 'team' || i.sharing) && !perms.has('projects.share') && !perms.has('projects.manage_team')) throw new ProjectError(403, 'You may not share projects with the team.');
  if (i.sharing && !canManage(r, userId)) throw new ProjectError(403, 'Only the owner or a team-project manager can change who has access.');
  if (i.sharing && scope !== 'team') throw new ProjectError(400, 'sharing applies to team projects only');
  const cur = view(r, userId); // opens with the current scope's key first, then re-seals with the new one
  const next = { title: i.title ?? cur.title, description: i.description ?? cur.description, instructions: i.instructions ?? cur.instructions, fields: i.fields ?? cur.fields,
    color: i.color !== undefined ? i.color : r.color, scope, sharing: i.sharing ?? sharingOf(r) };
  db.exec('BEGIN IMMEDIATE');
  try {
    write(r, next);
    // people who lost access keep no chats in it (their chats move out, nothing is deleted)
    const after = getRow(id)!;
    for (const { user_id } of db.prepare('SELECT user_id FROM conversations WHERE project_id = ? UNION SELECT user_id FROM folders WHERE project_id = ?').all(id, id) as { user_id: string }[]) if (!accessOf(after, user_id)) { db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ? AND user_id = ?').run(id, user_id); db.prepare('UPDATE folders SET project_id = NULL WHERE project_id = ? AND user_id = ?').run(id, user_id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Owner or team-project manager. Everyone's chats move out of it; `withChats` also deletes the CALLER's chats in it (others' chats are theirs). */
export function deleteProject(userId: string, id: string, withChats: boolean) {
  const r = getRow(id);
  if (!r || !accessOf(r, userId)) throw new ProjectError(404, 'not found');
  if (!canManage(r, userId)) throw new ProjectError(403, 'Only the owner or a team-project manager can delete this project.');
  if (withChats) purgeConversations(userId, (db.prepare('SELECT id FROM conversations WHERE project_id = ? AND user_id = ?').all(id, userId) as { id: string }[]).map((c) => c.id));
  db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id);
  db.prepare('UPDATE folders SET project_id = NULL WHERE project_id = ?').run(id); // people keep their folders, now outside any project
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ---- for chats ----
/** The project instructions a chat starts with (agent side: free chats append them to the orchestrator's). Needs the chat owner to still have access. */
export function projectInstructions(conversationId: string): string | undefined {
  const userId = userOfConversation(conversationId);
  const c = (userId ? db.prepare('SELECT project_id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) : undefined) as { project_id: string | null } | undefined;
  const r = c?.project_id ? getRow(c.project_id) : undefined;
  if (!r || !accessOf(r, userId!)) return;
  return openCol(r, 'instructions').trim() || undefined;
}