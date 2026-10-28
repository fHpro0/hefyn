import { Folder as FolderIcon, FolderInput, FolderPlus, Settings2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/ui/dropdown-menu';
import { attempt } from '@/components/chat-actions';
import type { WebModule } from '../registry';
import { api } from '@/components/api';
import { setProjectNodes } from '../folders/api';
import { askNewProject, createProject, loadProjectData, moveChats, moveToProject, openProjectSettings, projectData, useProjectData, type Project } from './api';
import { ProjectDialog } from './ProjectDialog';

// The projects module's console parts (server: src/modules/projects): "Move to project" in chat menus, the palette commands, the project
// colour on archived chats, and the host that owns the projects and their dialogs. The project nodes in the sidebar tree belong to the folders
// module (it shows them once this host has filled its store). Pages: ProjectPage.tsx (/projects).
const ProjectSettings = lazy(() => import('./ProjectSettings')); // listens for hefyn-project-settings

const Dot = ({ color }: { color: string | null }) => <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-foreground/15" style={{ background: color ?? 'transparent' }} />;
const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** "Move to project" in a chat's ⋯ menu. */
const ChatMenu: NonNullable<WebModule['chatMenuItems']>[number] = ({ chat, done }) => {
  const { projects } = useProjectData();
  const current = chat.projectId;
  return (
    <DropdownMenuSub><DropdownMenuSubTrigger className="text-[13px]"><FolderInput {...ico} />Move to project</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        {current && <DropdownMenuItem className="text-[13px]" onClick={() => moveToProject([chat.id], null, undefined, done)}>No project</DropdownMenuItem>}
        {projects.filter((p) => p.id !== current).map((p) => <DropdownMenuItem key={p.id} className="text-[13px]" onClick={() => moveToProject([chat.id], p.id, p.title, done)}><Dot color={p.color} />{p.title}</DropdownMenuItem>)}
        {(current || projects.length > 0) && <DropdownMenuSeparator />}
        <DropdownMenuItem className="text-[13px]" onClick={() => askNewProject([chat.id], done)}><FolderPlus {...ico} />New project…</DropdownMenuItem>
      </DropdownMenuSubContent></DropdownMenuSub>
  );
};

/** In the archive list a chat shows its project's colour. */
const Badge: NonNullable<WebModule['chatBadges']>[number] = ({ chat, inArchive }) => {
  const { projects } = useProjectData();
  const proj = inArchive ? projects.find((p) => p.id === chat.projectId) : undefined;
  return proj ? <span title={proj.title} className="flex shrink-0"><Dot color={proj.color} /></span> : null;
};

/** Loads the projects (and reloads with the sidebar) and owns the module's dialogs: project settings, new project. */
function Host() {
  const [newProject, setNewProject] = useState<{ move?: string[]; done?: () => void }>();
  useEffect(() => { setProjectNodes([]); loadProjectData(); addEventListener('hefyn-threads', loadProjectData); return () => { removeEventListener('hefyn-threads', loadProjectData); setProjectNodes(undefined); }; }, []);
  useEffect(() => {
    const np = (e: Event) => setNewProject((e as CustomEvent).detail ?? {});
    addEventListener('hefyn-new-project', np);
    return () => removeEventListener('hefyn-new-project', np);
  }, []);
  return (
    <Suspense fallback={null}>
      <ProjectSettings />
      {newProject && <ProjectDialog onClose={() => setNewProject(undefined)} onCreated={(p) => newProject.move && attempt(() => moveChats(newProject.move!, p.id)).then(() => newProject.done?.())} />}
    </Suspense>
  );
}

export const projectsWeb: WebModule = {
  id: 'projects',
  chatBadges: [Badge],
  chatMenuItems: [ChatMenu],
  hosts: [Host],
  slashCommands: [{
    name: 'project', arg: 'name', help: 'Move this chat to a project (created if missing)', Icon: FolderInput,
    async run(arg, id) {
      const p = (await api<Project[]>('/api/projects')).find((x) => x.title.toLowerCase() === arg.toLowerCase());
      if (p) return attempt(() => moveChats([id], p.id), `Moved to ${p.title}`);
      return { title: `Create project “${arg}”?`, body: 'No project has this name yet. Create it and move this chat into it.', action: 'Create and move',
        run: () => attempt(async () => { await moveChats([id], (await createProject(arg, null)).id); }, `Moved to ${arg}`) };
    },
  }],
  paletteCommands: () => {
    const { projects } = projectData();
    const go = (href: string) => () => { location.href = href; };
    return [
      { id: 'new-project', label: 'New project', group: 'Actions', Icon: FolderPlus, run: () => askNewProject() },
      ...projects.map((p: Project) => ({ id: `p-${p.id}`, label: p.title, group: 'Projects', Icon: FolderIcon, run: go(`/projects#${p.id}`) })),
      ...projects.map((p: Project) => ({ id: `ps-${p.id}`, label: `Project settings: ${p.title}`, group: 'Projects', Icon: Settings2, run: () => openProjectSettings(p.id) })),
    ];
  },
};
