// Structural types (not imported from chat-actions: this file is also type-checked by the server's tsconfig through its test).
interface Folder { id: string; name: string; parentId: string | null; projectId: string | null; position: number }
interface Project { id: string; title: string }
interface Thread { folderId?: string | null }

// Pure tree helpers for the sidebar: which folders sit where, what may be dropped where, and the new order after a drop.
export const MAX_DEPTH = 5;

/** A place a chat or folder can be filed: the top level, a project (its top level), or a folder. */
export type Dest = { kind: 'root' } | { kind: 'project'; projectId: string } | { kind: 'folder'; folderId: string };
export type Zone = 'before' | 'inside' | 'after';

export const childrenOf = (folders: Folder[], parentId: string | null, projectId: string | null, byName = false) =>
  folders.filter((f) => f.parentId === parentId && (parentId ? true : f.projectId === projectId))
    .sort((a, b) => (byName ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.position - b.position));

/** The folder and everything below it. */
export function subtreeIds(folders: Folder[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; } }
  return out;
}
export const depthOf = (folders: Folder[], id: string | null) => { let n = 0; for (let cur = id; cur && n <= MAX_DEPTH + 1; n++) cur = folders.find((f) => f.id === cur)?.parentId ?? null; return n; };
export const heightOf = (folders: Folder[], id: string): number => 1 + Math.max(0, ...folders.filter((f) => f.parentId === id).map((f) => heightOf(folders, f.id)));

/** "Kunden / Angebote / 2026": where a folder (or a chat in it) lives. */
export function folderPath(folders: Folder[], projects: Project[], folderId?: string | null, projectId?: string | null): string {
  const names: string[] = [];
  for (let cur = folderId ? folders.find((f) => f.id === folderId) : undefined, n = 0; cur && n < 10; n++, cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined) names.unshift(cur.name);
  const pid = projectId ?? (folderId ? folders.find((f) => f.id === folderId)?.projectId : null);
  const p = pid ? projects.find((x) => x.id === pid)?.title : undefined;
  return [...(p ? [p] : []), ...names].join(' / ');
}

/** May `subject` (a folder id, or a chat) be dropped into `dest`? Folders can not go into themselves or below, nor past the depth limit. */
export function canDrop(folders: Folder[], subject: { folderId?: string }, dest: Dest): boolean {
  if (!subject.folderId) return true;
  if (dest.kind !== 'folder') return true;
  if (subtreeIds(folders, subject.folderId).has(dest.folderId)) return false;
  return depthOf(folders, dest.folderId) + heightOf(folders, subject.folderId) <= MAX_DEPTH;
}

/** Where on a row the dragged item is: folders accept "inside" in the middle half, chats only before/after, projects and the root only inside. */
export function zoneOf(kind: 'chat' | 'folder' | 'project' | 'root', rel: number): Zone {
  if (kind === 'project' || kind === 'root') return 'inside';
  if (kind === 'chat') return rel < 0.5 ? 'before' : 'after';
  return rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'inside';
}

/** A position between two neighbours (undefined = no neighbour on that side). */
export const between = (prev?: number, next?: number) => prev !== undefined && next !== undefined ? (prev + next) / 2 : prev !== undefined ? prev + 1 : next !== undefined ? next - 1 : 1;

/** `list` without `id`, with `id` inserted before/after `targetId` (or at the end). */
export function insertAround<T extends { id: string }>(list: T[], item: T, targetId: string | undefined, zone: Zone): T[] {
  const rest = list.filter((x) => x.id !== item.id), i = targetId ? rest.findIndex((x) => x.id === targetId) : -1;
  rest.splice(i < 0 ? rest.length : zone === 'before' ? i : i + 1, 0, item);
  return rest;
}

export const threadCount = (threads: Thread[], folders: Folder[], folderId: string) => { const ids = subtreeIds(folders, folderId); return threads.filter((t) => t.folderId && ids.has(t.folderId)).length; };
