import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';


// The console's router: every page is a full document load of the same shell (web/shell.ts) and this picks the one component for the URL.
// Dynamic imports keep each route's JS to its own chunk plus the shared ones.
type Page = [title: string, load: () => Promise<{ default: ComponentType }>];
const pages: Record<string, Page> = {
  '/': ['Chat', () => import('./components/Chat.tsx')],
  '/login': ['Sign in', () => import('./components/Login.tsx')],
  '/setup': ['Set up hefyn', () => import('./components/Setup.tsx')],
  '/forgot-password': ['Forgot password', () => import('./components/ForgotPassword.tsx')],
  '/reset-password': ['Set password', () => import('./components/ResetPassword.tsx')],
  '/usage': ['Usage', () => import('./components/Usage.tsx')],
  '/assistants': ['Assistants', () => import('./components/Assistants.tsx')],
  '/files': ['Files', () => import('./components/Files.tsx')],
  '/skills':['Skills', () => import('./components/Skills.tsx')],
  '/assistants/edit': ['Edit assistant', () => import('./components/assistants/Editor.tsx')],
  '/settings/assistants': ['Assistants', async () => { location.replace('/assistants#team'); return { default: () => null }; }], // moved: the team tab of the main page
  '/settings/agent-accounts': ['Agent accounts', () => import('./components/AgentAccounts.tsx')],
  '/settings/appearance': ['Appearance', () => import('./components/Appearance.tsx')],
  '/settings/branding': ['Branding', () => import('./components/Branding.tsx')],
  '/settings/profile': ['Profile', () => import('./components/Profile.tsx')],
  '/settings/connected-apps': ['Connected apps', () => import('./components/ConnectedApps.tsx')],
  '/settings/devices': ['Devices', () => import('./components/Devices.tsx')],
  '/settings/mcp': ['MCP', () => import('./components/Connectors.tsx')],
  '/settings/providers': ['Agents & keys', () => import('./components/Providers.tsx')],
  '/settings/roles': ['Roles', () => import('./components/Roles.tsx')],
  '/settings/security': ['Security', () => import('./components/Security.tsx')],
  '/settings/users': ['Users', () => import('./components/Users.tsx')],
};

const path = location.pathname.replace(/\/+$/, '') || '/';
const notFound: Page = ['Page not found', async () => {
  const [{ AuthLayout }, { Button }] = await Promise.all([import('./components/Setup.tsx'), import('@/ui/button')]);
  return { default: () => <AuthLayout title="Page not found" hint="This address does not lead anywhere in hefyn. Check it, or go back to your chats."><Button className="w-full" render={<a href="/" />} nativeButton={false}>Back to chats</Button></AuthLayout> };
}];
const page: Page = pages[path] ?? (path === '/settings' ? ['Profile', async () => { location.replace('/settings/profile'); return { default: () => null }; }] : notFound);
document.title = `${page[0]} · hefyn`;
const { default: Component } = await page[1]();
createRoot(document.body.appendChild(document.createElement('div'))).render(<Component />);
