import './server/startup.ts';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { api } from './server/api.ts';
import { dav } from './server/dav.ts';
import { cleanedHeaders, peerOf } from './server/clientip.ts';
import { auth } from './server/auth.ts';
import { agentGuard, type Env } from './server/guard.ts';
import { getTeamKey, userKey } from './server/vault.ts';
import { AGENT_URL, INTERNAL_TOKEN, runtimeState } from './server/runtime.ts';
import { egressAllowlist } from './server/egress-list.ts';
import { cleanupTmp } from './server/storage.ts';
import { startJobs } from './modules/registry.ts';

// The web service: auth, /api, the UI, and a guarded reverse proxy to the agent service.
const app = new Hono<Env>();

// Signups are closed: accounts come from /api/setup (first Admin) or an Admin creating users.
app.on('POST', '/api/auth/sign-up/*', (c) => c.json({ error: 'signups are closed' }, 403));
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(new Request(c.req.raw, { headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) })));
app.route('/api', api);
app.route('/dav', dav); // WebDAV for the user's files: Basic auth with an app password, never the session cookie

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
  // The agent holds keys only per request: pass the caller's (never a client-supplied one). agentGuard already proved the conversation is theirs.
  headers.delete('x-hefyn-user-key');
  headers.delete('x-hefyn-team-key');
  const key = userKey(c.get('me').id);
  if (!key) return c.json({ error: 'locked', scope: 'user' }, 423);
  headers.set('x-hefyn-user-key', key.toString('base64'));
  const team = getTeamKey();
  if (team) headers.set('x-hefyn-team-key', team.toString('base64'));
  const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body;
  const res = await fetch(AGENT_URL + u.pathname + u.search, { method: c.req.method, headers, body, signal: c.req.raw.signal, redirect: 'manual', duplex: 'half' } as RequestInit)
    .catch(() => undefined);
  if (!res) return c.json({ error: 'agent unavailable' }, 502);
  const out = new Headers(res.headers); // fetch already decoded the body
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
  return new Response(res.body, { status: res.status, headers: out });
});

// Built console (web/build.ts): hashed assets and /brand are files; every other page URL (/setup, /m/<id>/<screen>, …) is the one index.html shell,
// which routes by URL itself. API-ish prefixes that matched nothing stay 404.
app.use('*', serveStatic({ root: './dist/web' }));
app.get('*', async (c) => {
  if (/^\/(api|agents|dav|internal)(\/|$)|\.[a-z0-9]{1,5}$/i.test(c.req.path)) return c.notFound(); // missing files and API paths are 404s, not the shell
  const f = Bun.file('./dist/web/index.html');
  return (await f.exists()) ? c.html(await f.text()) : c.notFound();
});

// Scratch dirs untouched for 7 days go.
setInterval(() => cleanupTmp({ olderThanDays: 7 }).catch(console.error), 6 * 3600_000).unref();

startJobs(); // the modules' background loops (agent updates); this process only, so a job runs once

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[hefyn] web listening on :${port}`));
