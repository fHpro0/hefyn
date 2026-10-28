import { bootCheck, createKernel, loadModules } from '../kernel/index.ts';
import { foldersLight } from './folders/agent.ts';
import { projectsLight } from './projects/agent.ts';
import { schedulesLight } from './schedules/agent.ts';

// The modules' light halves (migrate, sealed, agent hooks): all the agent process may load, since the full modules pull in the routes
// and the auth stack. registry.ts builds the full modules from the same objects. Importing this migrates the enabled modules' tables.
export const lightModules = [projectsLight, foldersLight, schedulesLight];
export const kernel = createKernel();
loadModules(kernel, lightModules);
await bootCheck(kernel);
export const agentModules = kernel.modules.list();
