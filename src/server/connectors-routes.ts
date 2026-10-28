import { Hono } from 'hono';
import { type Env, requirePermission } from './guard.ts';
import { finishMcpOauth } from './mcp.ts';
import { callbackFlow } from './oauth.ts';

// Mounted at /api/connectors. Only the OAuth redirect callbacks stay REST (the browser lands here from the authorization server);
// everything else is tRPC (routers/connectors.ts).
export const connectorRoutes = new Hono<Env>();
const use = requirePermission('models.use');
// Callback pages: static text, no scripts or styles, locked-down CSP.
const page = (c: any, msg: string, status = 200) => c.html(`<!doctype html><meta charset="utf-8"><title>hefyn</title><p>${msg.replace(/[<>&"']/g, '')}</p>`, status, { 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' });

connectorRoutes.get('/oauth/callback', use, async (c) => {
  try {
    const q = c.req.query();
    if (!q.state) throw new Error('missing state');
    const r = await callbackFlow(c.var.me.id, q.state, c.req.url);
    return r.state === 'done' ? page(c, 'Connected — you can close this window.') : page(c, `Sign-in failed: ${r.error ?? 'unknown error'}`, 400);
  } catch (e) { return page(c, `Sign-in failed: ${(e as Error).message}`, ((e as any).status ?? 400)); }
});
// The authorization server redirects the browser here; the page is shown in the popup/tab the user opened.
connectorRoutes.get('/mcp/oauth/callback', use, async (c) => {
  const { state, code, iss, error } = c.req.query();
  try {
    if (error || !state || !code) throw new Error(error || 'missing code or state');
    await finishMcpOauth(c.var.me.id, state, code, iss);
    return page(c, 'Connected — you can close this window.');
  } catch (e) { return page(c, `Sign-in failed: ${(e as Error).message}`, 400); }
});
