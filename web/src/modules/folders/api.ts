import { useSyncExternalStore } from 'react';
import { trpc } from '@/lib/trpc';
import { bulk, type Thread } from '@/components/chat-actions';
import { folderPath } from './chat-tree';

// The folders module's client: types, calls and a small shared store, loaded by the module's host in the Shell and reloaded whenever the sidebar
// is ('hefyn-threads'). The server side is src/modules/folders. Projects are optional: when that module is on, its host fills `projects`
// (undefined = off: the tree shows no project nodes and no "New project").
export interface Folder { id: string; name: string; parentId: string | null; projectId: string | null; position: number }
/** What the tree needs of a project. */
export interface ProjectNode { id: string; title: string; color: string | null; scope: 'private' | 'team' }

/** Project dialogs belong to the projects module; the tree only fires events (as the chat menus do). */
export const openProjectSettings = (id: string) => dispatchEvent(new CustomEvent('hefyn-project-settings', { detail: id }));
export const askNewProject = (move?: string[], done?: () => void) => dispatchEvent(new CustomEvent('hefyn-new-project', { detail: { move, done } }));
export const askNewFolder = () => dispatchEvent(new Event('hefyn-new-folder'));

export const createFolder = (name: string, parentId: string | null, projectId: string | null) => trpc.folders.create.mutate({ name, parentId, projectId });
export const renameFolder = (id: string, name: string) => trpc.folders.rename.mutate({ id, name });
export const moveFolder = (id: string, body: { parentId?: string | null; projectId?: string | null; position?: number }) => trpc.folders.move.mutate({ id, ...body });
export const deleteFolder = (id: string, mode: 'lift' | 'delete') => trpc.folders.delete.mutate({ id, mode });

/** Move chats into a folder (null = out of any folder; the folder decides the project). */
export const moveToFolder = (ids: string[], folderId: string | null) => bulk(ids, 'move', { folderId });
export interface MoveSubject { chats?: string[]; folderId?: string; label: string; done?: () => void }
/** "Move to…" for chats or one folder (the drag and drop path adds positions on top of this). */
export function moveSubject(s: MoveSubject, d: { kind: 'root' } | { kind: 'project'; projectId: string } | { kind: 'folder'; folderId: string }) {
  if (s.chats) return d.kind === 'folder' ? moveToFolder(s.chats, d.folderId) : d.kind === 'project' || data.projects ? bulk(s.chats, 'moveToProject', { projectId: d.kind === 'project' ? d.projectId : null }) : moveToFolder(s.chats, null);
  return moveFolder(s.folderId!, d.kind === 'folder' ? { parentId: d.folderId } : { parentId: null, projectId: d.kind === 'project' ? d.projectId : null });
}
/** "Move to…" opener: the host (Shell) owns the dialog, so the menus and the tree only fire an event. */
export const askMove = (s: MoveSubject) => dispatchEvent(new CustomEvent('hefyn-move-to', { detail: s }));

// ---- store ----
interface Data { folders: Folder[]; projects?: ProjectNode[] }
let data: Data = { folders: [] };
const subs = new Set<() => void>();
const set = (d: Data) => { data = d; subs.forEach((f) => f()); };
export async function loadFolders() {
  const folders = await trpc.folders.list.query().catch(() => data.folders);
  set({ ...data, folders: [...folders] });
}
/** Called by the projects module's host. */
export const setProjectNodes = (projects?: ProjectNode[]) => set({ ...data, projects });
export const folderData = () => data;
export const useFolderData = () => useSyncExternalStore((f) => { subs.add(f); return () => void subs.delete(f); }, () => data);

/** "Projects / Folder / Subfolder" for a chat, for tooltips and the palette (reads the store, no hook). */
export const locationOf = (c: Thread) => folderPath(data.folders, data.projects ?? [], c.folderId, c.projectId);
