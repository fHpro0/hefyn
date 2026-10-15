import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { Hono } from 'hono';
import { ADMIN_ROLE } from './appdb.ts';
import { connectApiKey, disconnectUser, ownConnections } from './connectors.ts';
import { type Env, requirePermission } from './guard.ts';
import { assertPublicUrl, createConnector, deleteConnector, finishMcpOauth, infoOf, listConnectors, ownerOf, setBearer, startMcpOauth, testConnector } from './mcp.ts';
import { callbackFlow, completeFlow, flowStatus, startFlow } from './oauth.ts';
import { CUSTOM, validate } from './providers.ts';
import { PLAYWRIGHT, PLAYWRIGHT_NOTE, playwrightEnabled, runnerConfigured, setPlaywright } from './runner.ts';

// Mounted at /api/connectors. Everything is scoped to the logged-in user.
export const connectorRoutes = new Hono<Env>();
const fail = (c: any, e: unknown, status = 400) => c.json({ error: (e as Error).message }, ((e as any)?.status ?? status) as 400);
const use = requirePermission('models.use');
// Callback pages: static text, no scripts or styles, locked-down CSP.
const page = (c: any, msg: string, status = 200) => c.html(`<!doctype html><meta charset="utf-8"><title>hefyn</title><p>${msg.replace(/[<>&"']/g, '')}</p>`, status, { 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' });

// ---- model connectors (own API keys and subscription logins) ----
// OAuth catalogue: what each pi-ai flow really gives access to (from its source), most popular first. Radius needs a gateway option: not offered.
const OAUTH_INFO: Record<string, { name: string; description: string }> = {
  anthropic: { name: 'Claude (Anthropic)', description: 'Sign in with Claude Pro or Max: Claude models through your subscription. Anthropic may restrict subscription tokens outside its own apps.' },
  openai: { name: 'ChatGPT (OpenAI)', description: 'Sign in with your ChatGPT account: the token is used directly against the OpenAI API (Responses), so you get OpenAI models without an API key.' },
  'openai-codex': { name: 'OpenAI Codex (legacy)', description: 'Sign in with ChatGPT Plus or Pro: Codex coding models through the ChatGPT backend. Older flow; prefer ChatGPT (OpenAI) unless you need Codex.' },
  'github-copilot': { name: 'GitHub Copilot', description: 'Sign in with GitHub (device code): the models included in your Copilot subscription. GitHub Enterprise domains are supported.' },
  openrouter: { name: 'OpenRouter', description: 'Sign in to OpenRouter: creates a permanent API key under your account (pay as you go, models from many labs).' },
  xai: { name: 'xAI Grok', description: 'Sign in with SuperGrok or X Premium (device code): Grok models through your subscription.' },
  'kimi-coding': { name: 'Kimi Code (Moonshot)', description: 'Sign in with your Kimi Code subscription (device code): Kimi coding models.' },
  meta: { name: 'Meta Muse', description: 'Sign in with your Meta account (device code): Muse models; the session lasts about a day and must then be renewed by signing in again.' },
};
const OAUTH_ORDER = ['anthropic', 'openai', 'github-copilot', 'openrouter', 'xai'];
const rank = (id: string) => { const i = OAUTH_ORDER.indexOf(id); return i < 0 ? OAUTH_ORDER.length : i; };

connectorRoutes.get('/models/providers', use, (c) => c.json({
  apiKey: [...builtinProviders().filter((p) => p.auth.apiKey?.login || (p.auth.apiKey && !p.auth.oauth)).map((p) => ({ id: p.id, name: p.name })), { id: CUSTOM, name: 'Custom OpenAI-compatible' }],
  oauth: builtinProviders().filter((p) => p.auth.oauth && p.id !== 'radius')
    .map((p) => ({ id: p.id, name: OAUTH_INFO[p.id]?.name ?? p.auth.oauth!.name, description: OAUTH_INFO[p.id]?.description ?? p.auth.oauth!.name, subscription: !!p.auth.oauth!.isSubscription }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)),
}));
connectorRoutes.get('/models', use, async (c) => c.json(await ownConnections(c.var.me.id)));
connectorRoutes.post('/models', use, async (c) => {
  const { provider, apiKey, baseUrl, models } = await c.req.json();
  if (!provider || !apiKey) return fail(c, new Error('provider and apiKey are required'));
  try {
    if (baseUrl) assertPublicUrl(baseUrl);
    const conn = { id: provider, baseUrl: baseUrl || undefined, models: Array.isArray(models) ? models : undefined };
    await validate(conn, apiKey);
    connectApiKey(c.var.me.id, conn, apiKey);
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});
connectorRoutes.delete('/models/:provider', use, (c) => (disconnectUser(c.var.me.id, c.req.param('provider')), c.json({ ok: true })));

// ---- subscription logins (pi-ai OAuth flows, driven from the browser) ----
// scope 'company' (models.manage): the signed-in provider becomes a company provider for everyone.
connectorRoutes.post('/oauth/:provider/start', use, async (c) => {
  const { scope = 'me' } = await c.req.json().catch(() => ({}));
  if (scope !== 'me' && scope !== 'company') return fail(c, new Error("scope must be 'me' or 'company'"));
  if (scope === 'company' && !c.var.me.permissions.includes('models.manage')) return c.json({ error: 'forbidden' }, 403);
  try { return c.json(await startFlow(c.var.me.id, c.req.param('provider'), undefined, scope)); } catch (e) { return fail(c, e); }
});
connectorRoutes.post('/oauth/:provider/complete', use, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const input = b.code ?? b.pastedUrl;
  if (!b.flowId || typeof input !== 'string' || !input) return fail(c, new Error('flowId and code or pastedUrl are required'));
  try { return c.json(await completeFlow(c.var.me.id, b.flowId, input)); } catch (e) { return fail(c, e); }
});
connectorRoutes.get('/oauth/callback', use, async (c) => {
  try {
    const q = c.req.query();
    if (!q.state) throw new Error('missing state');
    const r = await callbackFlow(c.var.me.id, q.state, c.req.url);
    return r.state === 'done' ? page(c, 'Connected — you can close this window.') : page(c, `Sign-in failed: ${r.error ?? 'unknown error'}`, 400);
  } catch (e) { return page(c, `Sign-in failed: ${(e as Error).message}`, ((e as any).status ?? 400)); }
});
connectorRoutes.get('/oauth/:id/status', use, (c) => {
  const s = flowStatus(c.var.me.id, c.req.param('id'));
  return s ? c.json(s) : c.json({ error: 'unknown or expired sign-in' }, 404);
});

// ---- MCP connectors ----
connectorRoutes.get('/mcp', use, (c) => {
  const me = c.var.me;
  const builtin = me.permissions.includes('mcp.run_managed')
    ? [{ id: PLAYWRIGHT, name: 'Browser (Playwright)', visibility: 'private', url: '', transport: 'streamable-http', auth: 'none', mine: true, sharedAccount: false,
      builtin: true, enabled: playwrightEnabled(me.id), connected: playwrightEnabled(me.id), available: runnerConfigured(), note: PLAYWRIGHT_NOTE }]
    : [];
  return c.json([...builtin, ...listConnectors(me.id)]);
});
// Built-in managed connector: needs mcp.run_managed and a configured runner.
for (const on of [true, false]) {
  connectorRoutes.post(`/mcp/${PLAYWRIGHT}/${on ? 'enable' : 'disable'}`, use, (c) => {
    if (!c.var.me.permissions.includes('mcp.run_managed')) return c.json({ error: 'forbidden' }, 403);
    if (on && !runnerConfigured()) return c.json({ error: 'The sandbox runner is not configured on this server.' }, 409);
    setPlaywright(c.var.me.id, on);
    return c.json({ ok: true, enabled: on });
  });
}
connectorRoutes.post('/mcp', use, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.visibility === 'team' && !c.var.me.permissions.includes('profiles.edit_team')) return c.json({ error: 'forbidden' }, 403);
  try { return c.json({ id: createConnector(c.var.me.id, b) }); } catch (e) { return fail(c, e); }
});
connectorRoutes.delete('/mcp/:id', use, (c) => {
  const owner = ownerOf(c.req.param('id'));
  if (!owner) return c.json({ error: 'unknown connector' }, 404);
  if (owner !== c.var.me.id && c.var.me.roleId !== ADMIN_ROLE) return c.json({ error: 'forbidden' }, 403);
  deleteConnector(c.req.param('id'));
  return c.json({ ok: true });
});
connectorRoutes.put('/mcp/:id/bearer', use, async (c) => {
  const info = infoOf(c.req.param('id'));
  if (!info) return c.json({ error: 'unknown connector' }, 404);
  // A team bearer is a shared account: only team editors may set or replace it.
  const allowed = info.visibility === 'team' ? c.var.me.permissions.includes('profiles.edit_team') : info.owner === c.var.me.id;
  if (!allowed) return c.json({ error: 'forbidden' }, 403);
  const { bearer } = await c.req.json().catch(() => ({}));
  if (!bearer || typeof bearer !== 'string') return fail(c, new Error('bearer is required'));
  try { setBearer(c.req.param('id'), bearer); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
connectorRoutes.post('/mcp/:id/test', use, async (c) => c.json(await testConnector(c.var.me.id, c.req.param('id'))));
connectorRoutes.post('/mcp/:id/oauth/start', use, async (c) => {
  try { return c.json(await startMcpOauth(c.var.me.id, c.req.param('id'))); } catch (e) { return fail(c, e); }
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
