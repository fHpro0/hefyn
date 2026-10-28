import { defineModule } from '../types.ts';
import { projectsLight } from './agent.ts';
import { projectRoutes } from './routes.ts';

// Projects: /api/projects, the project field of a conversation, project instructions for the agent, and (in the console) the project nodes in
// the folders tree. A project groups chats (folders are their own module).
export const projects = defineModule({
  ...projectsLight,
  permissions: [
    { id: 'projects.share', label: 'Share projects with the team', hint: 'Make a project visible to colleagues and choose who may view or edit it.', group: 'Projects', worker: true },
    { id: 'projects.manage_team', label: 'Manage team projects', hint: 'Edit, re-share and delete any team project, whoever created it.', group: 'Projects' },
  ],
  routes: [{ path: '/projects', app: projectRoutes }],
});
