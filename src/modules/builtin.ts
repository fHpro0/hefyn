import { connectorRoutes } from '../server/connectors-routes.ts';
import { securityRoutes } from '../server/security-routes.ts';
import { fileRoutes } from '../server/storage-routes.ts';
import { connections } from './connections.ts';
import { folders } from './folders/index.ts';
import { defineModule } from './types.ts';

// Models, users, roles and usage keep their routes in api.ts; here they only declare permissions, nav and commands.
export const builtin = [
  defineModule({
    id: 'models', name: 'Models', icon: 'Cpu',
    permissions: [
      { id: 'models.use', label: 'Chat with models', hint: 'Start conversations and use the connected models.', group: 'Models' },
      { id: 'models.manage', label: 'Manage agents and keys', hint: 'Install agents, choose who may use them, and connect the API keys they run on.', group: 'Models' },
      { id: 'profiles.edit_team', label: 'Share with the team', hint: 'Make connectors, storage and hub installs visible to the whole team, not only to yourself.', group: 'Profiles' },
      { id: 'assistants.create', label: 'Create assistants', hint: 'Build private assistants for yourself.', group: 'Assistants', worker: true },
      { id: 'assistants.share', label: 'Share assistants', hint: 'Send your assistants to the team for review.', group: 'Assistants', worker: true },
      { id: 'assistants.manage', label: 'Manage the team’s assistants', hint: 'Edit, archive and choose who may use the team’s assistants, and pick the default.', group: 'Assistants' },
    ],
    nav: [
      { place: 'main', label: 'New chat', href: '/', icon: 'SquarePen', order: 10 },
      // Same page twice: admins get the team part in Workspace; a plain models.use user only has "Your own providers" on it, so it is a personal page for them (settingsGroups drops the duplicate).
      { place: 'settings', group: 'workspace', label: 'Agents & keys', href: '/settings/providers', icon: 'Cpu', permission: 'models.manage', order: 10 },
      { place: 'settings', label: 'Your providers', href: '/settings/providers', icon: 'Cpu', permission: 'models.use', order: 50 },
      { place: 'main', label: 'Assistants', href: '/assistants', icon: 'Sparkles', permission: ['assistants.create', 'assistants.manage'], order: 12 },
    ],
    // finishes agent updates and removes replaced versions every 10 minutes; asks the ACP Registry every 6 hours (src/cli-agents/installed.ts)
    jobs: [{ name: 'agent-updates', everyMs: 10 * 60_000, first: 60_000, run: async () => (await import('../cli-agents/installed.ts')).updateTick() }],
    commands: [
      { label: 'Assistants', href: '/assistants', icon: 'Sparkles', permission: ['assistants.create', 'assistants.manage'], order: 41 },
      { label: 'Settings: Agents & keys', href: '/settings/providers', icon: 'Cpu', permission: ['models.manage', 'models.use'], order: 40 },
    ],
  }),
  defineModule({
    id: 'users', name: 'Users', icon: 'Users',
    permissions: [{ id: 'users.manage', label: 'Manage users', hint: 'Create accounts and change who has which role.', group: 'People' }],
    nav: [{ place: 'settings', group: 'workspace', label: 'Users', href: '/settings/users', icon: 'Users', permission: 'users.manage', order: 20 }],
    commands: [{ label: 'Settings: Users', href: '/settings/users', icon: 'Users', permission: 'users.manage', order: 50 }],
  }),
  defineModule({
    id: 'roles', name: 'Roles', icon: 'Shield',
    permissions: [{ id: 'roles.manage', label: 'Manage roles', hint: 'Create, edit and delete roles.', group: 'People' }],
    nav: [{ place: 'settings', group: 'workspace', label: 'Roles', href: '/settings/roles', icon: 'Shield', permission: 'roles.manage', order: 30 }],
    commands: [{ label: 'Settings: Roles', href: '/settings/roles', icon: 'Shield', permission: 'roles.manage', order: 60 }],
  }),
  defineModule({
    id: 'usage', name: 'Usage', icon: 'BarChart3',
    permissions: [{ id: 'usage.view_all', label: 'See everyone’s usage', hint: 'View tokens and cost for all users, not just your own.', group: 'Insights' }],
    nav: [ // one page: everyone sees their own numbers; usage.view_all adds everyone's (the Workspace entry replaces the personal one)
      { place: 'settings', group: 'workspace', label: 'Usage', href: '/usage', icon: 'BarChart3', permission: 'usage.view_all', order: 70 },
      { place: 'settings', label: 'Your usage', href: '/usage', icon: 'BarChart3', order: 70 },
    ],
    commands: [{ label: 'Settings: Usage', href: '/usage', icon: 'BarChart3', order: 80 }],
  }),
  defineModule({
    id: 'hub', name: 'Hub', icon: 'Store',
    permissions: [
      { id: 'hub.install', label: 'Install from the hub', hint: 'Add skills and plugins from the hub.', group: 'Hub' },
      { id: 'hub.publish', label: 'Publish to the hub', hint: 'Share your own skills and plugins.', group: 'Hub' },
      { id: 'hub.approve', label: 'Approve hub items', hint: 'Review and approve items before others can install them.', group: 'Hub' },
      { id: 'skills.share', label: 'Share skills with the team', hint: 'Make your own skills available to everyone on the team at once.', group: 'Hub' },
    ],
    nav: [{ place: 'main', label: 'Skills', href: '/skills', icon: 'PackageCheck', permission: ['hub.install', 'skills.share'], order: 13 }],
    commands: [{ label: 'Skills', href: '/skills', icon: 'PackageCheck', permission: ['hub.install', 'skills.share'], order: 42 }],
  }),
  defineModule({
    id: 'files', name: 'Sandbox', icon: 'Folder', // the Files page (/files) is the browser side of the user's private /files folder
    permissions: [{ id: 'sandbox.shell', label: 'Use a shell sandbox', hint: 'Run commands in an isolated container with the user’s files.', group: 'Sandbox' }],
    nav: [{ place: 'main', label: 'Files', href: '/files', icon: 'Folder', permission: 'sandbox.shell', order: 14 }],
    commands: [{ label: 'Files', href: '/files', icon: 'Folder', permission: 'sandbox.shell', order: 43 }],
    routes: [{ path: '/files', app: fileRoutes }],
  }),
  connections,
  folders,
  defineModule({
    id: 'connectors', name: 'Connectors', icon: 'Plug',
    permissions: [{ id: 'mcp.run_managed', label: 'Run managed connectors', hint: 'Use MCP servers that the company runs for you.', group: 'Connectors' }],
    nav: [{ place: 'settings', label: 'MCP', href: '/settings/mcp', icon: 'Plug', order: 60 }],
    commands: [{ label: 'Settings: MCP', href: '/settings/mcp', icon: 'Plug', order: 70 }],
    routes: [{ path: '/connectors', app: connectorRoutes }],
  }),
  defineModule({
    id: 'channels', name: 'Mail', icon: 'Mail', // the Mail settings page moved to old/ (an SMTP server saved earlier still sends resets); id and permission stay: stored roles use them
    permissions: [
      { id: 'channels.manage', label: 'Manage mail settings', hint: 'Set up the SMTP server hefyn sends password-reset and invite mails through.', group: 'Mail' },
    ],
  }),
  defineModule({
    id: 'modules', name: 'Modules', icon: 'Blocks', // the Modules page moved to old/; the permission stays (roles store it)
    permissions: [{ id: 'modules.manage', label: 'Manage modules', hint: 'Install, enable and configure modules.', group: 'Modules' }],
  }),
  defineModule({
    id: 'security', name: 'Security', icon: 'Lock',
    nav: [{ place: 'settings', label: 'Security', href: '/settings/security', icon: 'Lock', order: 80 }],
    routes: [{ path: '/security', app: securityRoutes }],
  }),
  defineModule({
    id: 'agent-accounts', name: 'Agent accounts', icon: 'KeyRound', // a person's own Claude / ChatGPT sign-ins for the hosted agents (cliAgents.accounts); shown to whoever may use a sandbox
    permissions: [{ id: 'accounts.team', label: 'Manage team accounts', hint: 'Choose which roles may use a team API key or a shared team login for each coding agent, and sign the team in.', group: 'Sandbox' }],
    nav: [{ place: 'settings', label: 'Agent accounts', href: '/settings/agent-accounts', icon: 'KeyRound', permission: 'sandbox.shell', order: 82 }],
    commands: [{ label: 'Settings: Agent accounts', href: '/settings/agent-accounts', icon: 'KeyRound', permission: 'sandbox.shell', order: 94 }],
  }),
  defineModule({
    id: 'devices', name: 'Devices', icon: 'Laptop', // a person's own laptop, paired by code (docs/DEVICES.md)
    permissions: [{ id: 'devices.connect', label: 'Connect own devices', hint: 'Pair a laptop and run agents on it', group: 'Sandbox', worker: true }],
    nav: [{ place: 'settings', label: 'Devices', href: '/settings/devices', icon: 'Laptop', permission: 'devices.connect', order: 83 }],
  }),
  defineModule({
    id: 'app-passwords', name: 'Connected apps', icon: 'HardDrive', // app passwords for WebDAV access to /files (src/server/dav.ts)
    nav: [{ place: 'settings', label: 'Connected apps', href: '/settings/connected-apps', icon: 'HardDrive', permission: 'sandbox.shell', order: 84 }],
  }),
  defineModule({
    id: 'appearance', name: 'Appearance', icon: 'Palette',
    nav: [{ place: 'settings', label: 'Appearance', href: '/settings/appearance', icon: 'Palette', order: 6 }],
    commands: [{ label: 'Settings: Appearance', href: '/settings/appearance', icon: 'Palette', order: 95 }],
  }),
  defineModule({
    id: 'profile', name: 'Profile', icon: 'User', // the signed-in user's own name, picture, password and sessions
    nav: [{ place: 'settings', label: 'Profile', href: '/settings/profile', icon: 'User', order: 5 }],
    commands: [{ label: 'Settings: Profile', href: '/settings/profile', icon: 'User', order: 94 }],
  }),
  defineModule({
    id: 'branding', name: 'Branding', icon: 'Image', // the company logo and name beside hefyn (brand.set, users.manage)
    nav: [{ place: 'settings', group: 'workspace', label: 'Branding', href: '/settings/branding', icon: 'Image', permission: 'users.manage', order: 40 }],
    commands: [{ label: 'Settings: Branding', href: '/settings/branding', icon: 'Image', permission: 'users.manage', order: 61 }],
  }),
];
