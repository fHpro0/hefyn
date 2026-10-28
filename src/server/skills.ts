import { db } from './appdb.ts';
import type { Me } from './guard.ts';
import * as hub from './hub.ts';

// Skills and MCP servers a person has switched off for their plain-agent chats (the default is on). An Assistant ignores these: it names its own skills and servers.
// Skills themselves are Hub packages of kind `skill` (hub.ts): private to their author, or shared with the team (`skills.share`).
db.exec('CREATE TABLE IF NOT EXISTS item_off (user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (user_id, kind, item_id))');

export type ItemKind = 'skill' | 'mcp';
export const offIds = (userId: string, kind: ItemKind) => new Set((db.prepare('SELECT item_id FROM item_off WHERE user_id = ? AND kind = ?').all(userId, kind) as { item_id: string }[]).map((r) => r.item_id));
export function setOn(userId: string, kind: ItemKind, id: string, on: boolean) {
  if (on) db.prepare('DELETE FROM item_off WHERE user_id = ? AND kind = ? AND item_id = ?').run(userId, kind, id);
  else db.prepare('INSERT OR IGNORE INTO item_off (user_id, kind, item_id) VALUES (?,?,?)').run(userId, kind, id);
}

/** The skills page: the person's own, and the team's approved ones, each with their own on/off switch. */
export function listSkills(me: Pick<Me, 'id'>) {
  const off = offIds(me.id, 'skill');
  const rows = db.prepare(`SELECT p.id, p.name, p.description, p.owner_id, p.visibility, p.status, p.source_json, p.updated_at, (SELECT name FROM user WHERE id = p.owner_id) AS owner_name
    FROM packages p WHERE p.kind = 'skill' AND (p.owner_id = ? OR (p.visibility = 'team' AND p.approved_json IS NOT NULL)) ORDER BY (p.owner_id = ?) DESC, p.name`).all(me.id, me.id) as any[];
  return rows.map((p) => ({ id: p.id as string, name: p.name as string, description: p.description as string, mine: p.owner_id === me.id, owner: (p.owner_name ?? p.owner_id) as string, shared: p.visibility === 'team', status: p.status as string,
    imported: (JSON.parse(p.source_json).type ?? 'ui') !== 'ui', on: !off.has(p.id), updatedAt: p.updated_at as string }));
}

/** SKILL.md without its frontmatter, and the frontmatter's fields: the preview shows these apart. */
export function readSkill(me: Pick<Me, 'id' | 'permissions'>, id: string) {
  const p = hub.getPackage(me, id);
  if (p.kind !== 'skill') throw new hub.HubError(404, 'package not found');
  const md = hub.getFile(me, id, 'SKILL.md'), { data, body } = hub.frontmatter(md);
  return { id: p.id, name: p.name, description: p.description, meta: data, body: body.trim(), files: p.files.filter((f) => f.path !== 'SKILL.md'), mine: p.owner.id === me.id, shared: p.visibility === 'team', status: p.status, imported: p.source.type !== 'ui' };
}

/** The skills a session gets. `ids` (an Assistant's): exactly those the person may use. Without (a plain-agent chat): their own and the team's that are switched on; the first of a name wins. */
export function sessionSkills(userId: string, ids?: string[]): { name: string; files: Record<string, string> }[] {
  const off = ids ? new Set<string>() : offIds(userId, 'skill'), seen = new Set<string>(), out: { name: string; files: Record<string, string> }[] = [];
  for (const id of ids ?? hub.skillIdsOf(userId)) {
    if (off.has(id)) continue;
    const s = hub.skillContent(userId, id);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, files: s.files });
  }
  return out;
}
