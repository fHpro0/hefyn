export const PERMISSIONS = [
  'models.manage', 'models.use', 'users.manage', 'roles.manage', 'usage.view_all',
  'profiles.edit_team', 'hub.install', 'hub.publish', 'hub.approve', 'mcp.run_managed', 'sandbox.shell',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (p: unknown): p is Permission => PERMISSIONS.includes(p as Permission);

// Worker defaults: chat with the connected models and install from the hub; nothing administrative.
export const WORKER_DEFAULTS: Permission[] = ['models.use', 'hub.install'];
