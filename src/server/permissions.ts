// The core's own permissions. Built-in modules declare theirs in `permissions` and the registry adds them at boot (registerPermissions),
// so this list is derived, not edited, for every feature that is a module.
const CORE = [
  'models.manage', 'models.use', 'users.manage', 'roles.manage', 'usage.view_all',
  'profiles.edit_team', 'hub.install', 'hub.publish', 'hub.approve', 'mcp.run_managed', 'sandbox.shell',
  'channels.manage','modules.manage', // data.use / data.manage went with the Data module to old/; a role that still holds them keeps the string
  'assistants.create', 'assistants.share', 'assistants.manage',
];
export const PERMISSIONS: string[] = [...CORE];
export type Permission = string;
// Installed modules add `mod.<id>.<name>` permissions (src/modules/installed.ts).
export type AnyPermission = string;

export const registerPermissions = (ids: string[]) => { for (const id of ids) if (!PERMISSIONS.includes(id)) PERMISSIONS.push(id); };

let installed: () => string[] = () => [];
export const setInstalledPermissions = (f: () => string[]) => void (installed = f);

export const isPermission = (p: unknown): p is AnyPermission => PERMISSIONS.includes(p as string) || (typeof p === 'string' && p.startsWith('mod.') && installed().includes(p));

// Worker defaults: chat with the connected models and install from the hub; nothing administrative. Modules add theirs (`worker: true`).
export const WORKER_DEFAULTS: Permission[] = ['models.use', 'hub.install', 'assistants.create', 'assistants.share', 'sandbox.shell'];
// A new role starts with just enough to chat with the agents (the sandbox is where the coding agents run); everything else is granted on purpose.
export const NEW_ROLE_DEFAULTS: Permission[] = ['models.use', 'sandbox.shell'];
