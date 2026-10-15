import './server/startup.ts';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { Configurable } from './agents/configurable.ts';
import './server/agent-runtime.ts';
import { INTERNAL_TOKEN } from './server/runtime.ts';

// The agent service: only the web service (which adds the internal token) may call it.
const app = new Hono();
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
app.use('*', async (c, next) => (same(c.req.header('x-hefyn-internal') ?? '', INTERNAL_TOKEN) ? next() : c.json({ error: 'unauthorized' }, 401)));
app.route('/agents/configurable', createAgentRouter(Configurable));

export default app;
