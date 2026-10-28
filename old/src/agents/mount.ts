import { createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool, useMcpConnection, useSandbox, useTool, type SandboxFactory } from '@flue/runtime';
import { moduleMounts } from '../modules/mount.ts';
import { mountable, noRedirectFetch } from '../server/mcp.ts';
import { containerSandboxFactory } from '../server/container-sandbox.ts';
import { overQuota, playwrightEnabled, playwrightFetch, playwrightUrl, shellEnabled } from '../server/runner.ts';
import { userSandboxFactory } from '../server/storage-sandbox.ts';
import { useDataTools } from './data-tools.ts';
import { type Off, hideTools, offOfConnector } from './tool-filter.ts';
import { useModuleTools } from '../modules/active.ts';
import { agentModules } from '../modules/light.ts'; // the light halves of the optional modules (the full ones pull in routes and auth)

/** The sandbox's tools minus the ones the Assistant turned off (`builtin:<name>`). Flue's default set is these six; the file-only sandbox lists its own. */
export function withoutSandboxTools(f: SandboxFactory, off: Off): SandboxFactory {
  if (![...off].some((t) => t.startsWith('builtin:'))) return f;
  return { ...f, tools: (sandbox, o) => (f.tools ? f.tools(sandbox, o) : [createBashTool(sandbox), createGrepTool(sandbox), createGlobTool(sandbox), createReadTool(sandbox), createWriteTool(sandbox), createEditTool(sandbox)]).filter((t) => !off.has(`builtin:${t.name}`)) };
}

/** The user's sandbox, connectors, data collections and modules' tools, for one agent run (chat or flow step). `conversationId` is the chat they belong to; call inside an agent function.
 *  `off`: the tools the Assistant turned off (tool-filter.ts): sandbox and data tools are not mounted, a connector's tools are hidden from the agent. Modules' tools and the browser are not switchable. */
export function mountUserTools(userId: string, conversationId: string, off: Off = new Set()) {
  const id = conversationId;
  // One mode per user: sandbox.shell + a runner means the container (shell tools, and the Files API goes through it too);
  // everyone else gets the file-only sandbox on the confined host dir.
  useSandbox(withoutSandboxTools(shellEnabled(userId)
    ? containerSandboxFactory({ userId, conversationId: id, overQuota: () => overQuota(userId) })
    : userSandboxFactory({ userId, conversationId: id }), off), { cwd: '/files' });
  if (playwrightEnabled(userId)) useMcpConnection({ name: 'playwright', url: playwrightUrl(userId, id), transport: 'streamable-http', fetch: playwrightFetch(userId, id), optional: true });
  for (const m of mountable(userId)) {
    const hidden = offOfConnector(off, m.id);
    useMcpConnection({ name: m.name, url: m.url, transport: m.transport, auth: m.token, fetch: hidden.size ? hideTools(noRedirectFetch, hidden) : noRedirectFetch, optional: true });
  }
  for (const m of moduleMounts(userId)) useMcpConnection({ ...m, fetch: noRedirectFetch, optional: true });
  useDataTools(userId, ((t: Parameters<typeof useTool>[0]) => { if (!off.has(`builtin:${(t as { name: string }).name}`)) useTool(t as never); }) as typeof useTool); // the user's data collections (docs/DATA.md)
  useModuleTools({ userId, conversationId: id, use: useTool }, agentModules); // modules' tools (schedules: scheduled tasks, docs/SCHEDULES.md)
}
