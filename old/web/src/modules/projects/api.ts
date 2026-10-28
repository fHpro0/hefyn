import { useSyncExternalStore } from 'react';
import { api } from '@/components/api';
import { attempt, bulk } from '@/components/chat-actions';
import { setProjectNodes } from '../folders/api';

// The projects module's client: types, calls and a small shared store (the projects), loaded by the module's host in the Shell and reloaded
// whenever the sidebar is ('hefyn-threads'). The server side is src/modules/projects. Folders are their own module (the tree shows the projects too).
export { askNewProject, openProjectSettings } from '../folders/api';
export type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'url' | 'email' | 'select' | 'user';
export interface ProjectField { id: string; label: string; type: FieldType; options?: string[]; value: string | number | null }
export type Level = 'editor' | 'viewer';
export interface Sharing { everyone: boolean; roleIds: string[]; userIds: string[]; access: Record<string, Level> } // access keys: user id, role id, '*' = everyone
export interface Project {
  id: string; title: string; description: string; color: string | null; instructions: string; fields: ProjectField[];
  scope: 'private' | 'team'; access: 'owner' | Level; canManage: boolean; isOwner: boolean; owner: { id: string; name: string }; sharing: Sharing | null;
  members: { everyone: boolean; everyoneAccess: Level; users: { id: string; name: string; access: Level }[]; roles: { id: string; name: string; access: Level }[] } | null;
  chatCount: number; createdAt: string; updatedAt: string;
}
export const COLORS = ['#e5484d', '#f76b15', '#e0a000', '#30a46c', '#0ea5a5', '#3e63dd', '#8e4ec6', '#6b7280'];

export const createProject = (title: string, color: string | null) => api<Project>('/api/projects', 'POST', { title, color });

/** Move chats into a project (null = out of any project and any folder). */
export const moveChats = (ids: string[], projectId: string | null) => bulk(ids, 'moveToProject', { projectId });
export const moveToProject = (target: string[], projectId: string | null, title?: string, done?: () => void) =>
  attempt(() => moveChats(target, projectId), projectId ? `Moved to ${title}` : 'Removed from the project').then((ok) => ok && done?.());

// ---- store ----
let projects: Project[] = [];
const subs = new Set<() => void>();
export async function loadProjectData() {
  projects = [...(await api<Project[]>('/api/projects').catch(() => projects))];
  subs.forEach((f) => f());
  setProjectNodes(projects); // the folder tree lists them
}
export const projectData = () => ({ projects });
export const useProjectData = () => ({ projects: useSyncExternalStore((f) => { subs.add(f); return () => void subs.delete(f); }, () => projects) });
