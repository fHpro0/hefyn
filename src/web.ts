import './server/startup.ts';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { api } from './server/api.ts';
import { cleanedHeaders, peerOf } from './server/clientip.ts';
import { auth } from './server/auth.ts';
import { agentGuard } from './server/guard.ts';
import { AGENT_URL, INTERNAL_TOKEN, runtimeState } from './server/runtime.ts';
import { installFetchGuard } from './server/netguard.ts';
import { egressAllowlist } from './server/egress-list.ts';
import { cleanupTmp } from './server/storage.ts';
import { ensureModelFiles } from './server/redact/download.ts';

// The web process never sends model requests: any model-API call from here is a bypass and is refused.
await installFetchGuard();
// The agent has no internet: web downloads the GLiNER model files (a plain file download from the Hugging Face file hosts, not a model API call) into the models volume; the redact service reads them.
void ensureModelFiles((m) => console.log(`[hefyn] ${m}`));

// The web service: auth, /api, the UI, and a guarded reverse proxy to the agent service.
const app = new Hono();

// Signups are closed: accounts come from /api/setup (first Admin) or an Admin creating users.
app.on('POST', '/api/auth/sign-up/*', (c) => c.json({ error: 'signups are closed' }, 403));
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(new Request(c.req.raw, { headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) })));
app.route('/api', api);

// The egress proxy polls this (internal token): the hosts the agent may reach.
app.get('/internal/egress-allowlist', (c) => (c.req.header('x-hefyn-internal') === INTERNAL_TOKEN ? c.json({ hosts: egressAllowlist() }) : c.json({ error: 'unauthorized' }, 401)));

app.use('/agents/*', agentGuard);
// A pending restart blocks new tasks; reads and streams of existing conversations keep working.
app.on('POST', '/agents/*', (c, next) => (runtimeState() === 'running' ? next() : c.json({ state: runtimeState(), error: 'The agent is restarting; try again shortly.' }, 503)));
app.all('/agents/*', async (c) => {
  const u = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  headers.delete('cookie');
  headers.delete('host');
  headers.set('x-hefyn-internal', INTERNAL_TOKEN);
  const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body;
  const res = await fetch(AGENT_URL + u.pathname + u.search, { method: c.req.method, headers, body, signal: c.req.raw.signal, redirect: 'manual', duplex: 'half' } as RequestInit)
    .catch(() => undefined);
  if (!res) return c.json({ error: 'agent unavailable' }, 502);
  const out = new Headers(res.headers); // fetch already decoded the body
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
  return new Response(res.body, { status: res.status, headers: out });
});

// Built web app (Astro static output); second pass serves directory indexes (/setup -> /setup/index.html).
app.use('*', serveStatic({ root: './dist/web' }));
app.use('*', serveStatic({ root: './dist/web', rewriteRequestPath: (p) => p.replace(/\/?$/, '/index.html') }));

// Scratch dirs untouched for 7 days go.
setInterval(() => cleanupTmp({ olderThanDays: 7 }).catch(console.error), 6 * 3600_000).unref();

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[hefyn] web listening on :${port}`));
