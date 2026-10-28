import { trpc } from '@/lib/trpc';
import { toast } from './toast';

// Chat management client: types, calls and the sidebar's grouping. The server side is src/server/routers/conversations.ts.
// The optional fields of a Thread are the modules' (projects: projectId; folders: folderId, position; schedules: scheduled); they are absent when the module is off.
export interface Thread { id: string; title: string; createdAt?: string; updatedAt?: string; projectId?: string | null; pinned?: boolean; scheduled?: boolean; archivedAt?: string | null; folderId?: string | null; position?: number | null; agent?: string | null; assistantId?: string | null }
export type Sort = 'activity' | 'created' | 'name' | 'custom';
export const SORTS: [Sort, string][] = [['activity', 'Last activity'], ['created', 'Created'], ['name', 'Name'], ['custom', 'Custom (drag to order)']];

export const changed = () => dispatchEvent(new Event('hefyn-threads'));
/** Runs a change, tells the sidebar to reload, and reports a failure as a toast. Returns whether it worked. */
export async function attempt(f: () => Promise<unknown>, done?: string): Promise<boolean> {
  try { await f(); changed(); if (done) toast(done); return true; } catch (e) { toast((e as Error).message, true); return false; }
}
export const patchChat = (id: string, body: object) => trpc.conversations.update.mutate({ id, ...body });
/** `extra`: the body of a module's action (folders: `move` with folderId; projects: `moveToProject` with projectId). */
export const bulk = (ids: string[], action: 'delete' | 'archive' | 'unarchive' | 'move' | 'moveToProject', extra: object = {}) =>
  trpc.conversations.bulk.mutate({ ids, action, ...extra });

const cmp: Record<Sort, (a: Thread, b: Thread) => number> = {
  activity: (a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
  created: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  custom: (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
};
export const sortChats = (list: Thread[], sort: Sort) => [...list].sort(cmp[sort]);
/** Pinned first, then (by activity / creation) Today, Yesterday, Previous 7 days, Older; by name: one alphabetical list. */
export function groupThreads(list: Thread[], sort: Sort, now = new Date()): [string, Thread[]][] {
  const sorted = [...list].sort(cmp[sort]);
  const out: [string, Thread[]][] = [['Pinned', sorted.filter((t) => t.pinned)]];
  const rest = sorted.filter((t) => !t.pinned);
  if (sort === 'name' || sort === 'custom') out.push(['Chats', rest]);
  else {
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const buckets: [string, Thread[]][] = [['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]];
    for (const t of rest) {
      const at = sort === 'created' ? t.createdAt : t.updatedAt ?? t.createdAt;
      const age = at ? Math.round((day(now) - day(new Date(at))) / 864e5) : 99;
      buckets[age <= 0 ? 0 : age === 1 ? 1 : age <= 7 ? 2 : 3]![1].push(t);
    }
    out.push(...buckets);
  }
  return out.filter(([, l]) => l.length);
}
