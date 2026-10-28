import './server/startup.ts';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { cliHost } from './cli-agents/host.ts';
import { cliRoutes } from './cli-agents/routes.ts';
import { accountHost, accountRoutes } from './cli-agents/account.ts';
import { acceptKeys } from './server/agent-keys.ts';
import { INTERNAL_TOKEN } from './server/runtime.ts';
import { LockedError, forgetUserKey } from './server/vault.ts';

// The agent service: only the web service (which adds the internal token) may call it. It hosts the CLI agents (src/cli-agents) and the Agent accounts' sign-in terminal.
const app = new Hono();
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
app.use('*', async (c, next) => (same(c.req.header('x-hefyn-internal') ?? '', INTERNAL_TOKEN) ? next() : c.json({ error: 'unauthorized' }, 401)));

app.post('/internal/forget', async (c) => {
  const { userId } = await c.req.json().catch(() => ({})) as { userId?: string };
  if (typeof userId !== 'string' || !userId) return c.json({ error: 'userId required' }, 400);
  // Stop in-flight work first, then drop the key: from then on any write of a still-running attempt throws LockedError.
  accountHost().close(userId);
  await cliHost().closeUser(userId); // hosted CLI agents of this user: their model socket goes with the key
  forgetUserKey(userId);
  return c.json({ ok: true });
});
app.use('/agents/*', acceptKeys);
app.onError((e, c) => (e instanceof LockedError ? c.json({ error: 'locked', scope: e.scope }, 423) : (console.error(e), c.json({ error: 'internal error' }, 500))));
app.route('/agents/cli', cliRoutes(cliHost()));
app.route('/agents/account', accountRoutes(accountHost())); // the sign-in terminal of Agent accounts (src/cli-agents/account.ts)

export default app;
