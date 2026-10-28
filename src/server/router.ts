import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { foldersRouter } from '../modules/folders/router.ts';
import { connectorsRouter } from './routers/connectors.ts';
import { brandRouter } from './routers/brand.ts';
import { hubRouter } from './routers/hub.ts';
import { skillsRouter } from './routers/skills.ts';
import { modulesRouter } from './routers/modules.ts';
import { rolesRouter } from './routers/roles.ts';
import { conversationsRouter } from './routers/conversations.ts';
import { agentsRouter } from './routers/agents.ts';
import { assistantsRouter } from './routers/assistants.ts';
import { appPasswordsRouter } from './routers/appPasswords.ts';
import { cliAgentsRouter } from './routers/cli-agents.ts';
import { connectionsRouter } from './routers/connections.ts';
import { devicesRouter } from './routers/devices.ts';
import { mentionsRouter } from './routers/mentions.ts';
import { profileRouter } from './routers/profile.ts';
import { modelsRouter } from './routers/models.ts';
import { runtimeRouter } from './routers/runtime.ts';
import { setupRouter } from './routers/setup.ts';
import { themeRouter } from './routers/theme.ts';
import { usageRouter } from './routers/usage.ts';
import { usersRouter } from './routers/users.ts';
import { router } from './trpc.ts';
import type { Env } from './guard.ts';

// The console API. One router per area under routers/; add it here. The client imports only the TYPE (web/src/lib/trpc.ts).
export const appRouter = router({ agents: agentsRouter, appPasswords: appPasswordsRouter, assistants: assistantsRouter, brand: brandRouter, cliAgents: cliAgentsRouter, connections: connectionsRouter, devices: devicesRouter, connectors: connectorsRouter, hub: hubRouter, skills: skillsRouter, modules: modulesRouter, folders: foldersRouter, roles: rolesRouter, conversations: conversationsRouter, mentions: mentionsRouter, models: modelsRouter, profile: profileRouter, runtime: runtimeRouter, setup: setupRouter, theme: themeRouter, usage: usageRouter, users: usersRouter });
export type AppRouter = typeof appRouter;

// Mounted at /api/trpc: queries are GET, mutations POST only (tRPC refuses a mutation over GET). A mutation must be application/json: a cross-site <form> cannot send that without a CORS preflight.
export const trpcRoutes = new Hono<Env>();
trpcRoutes.all('/*', async (c) =>
  c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')
    ? c.json({ error: 'application/json required' }, 415)
    : fetchRequestHandler({ endpoint: '/api/trpc', req: c.req.raw, router: appRouter, createContext: () => ({ c }), responseMeta: () => ({ headers: { 'cache-control': 'no-store' } }) })); // private per-user data: never cached, like the REST routes it replaces
