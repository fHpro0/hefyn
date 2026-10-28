import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ADMIN_ROLE } from '../appdb.ts';
import { connectApiKey, disconnectUser, ownConnections } from '../connectors.ts';
import { agentConnectors, assertPublicUrl, createConnector, deleteConnector, infoOf, listConnectors, moduleOf, ownerOf, setBearer, startMcpOauth, testConnector, updateConnector } from '../mcp.ts';
import { offIds, setOn } from '../skills.ts';
import { completeFlow, flowStatus } from '../oauth.ts';
import { CUSTOM, validate } from '../providers.ts';
import { PLAYWRIGHT, PLAYWRIGHT_NOTE, playwrightEnabled, runnerConfigured, setPlaywright } from '../runner.ts';
import { perm, router, userFacing } from '../trpc.ts';

// connectors.*: everything is scoped to the signed-in user. The OAuth redirect callbacks stay REST (connectors-routes.ts).
const use = perm('models.use');
const forbidden = () => new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
const unknown = () => new TRPCError({ code: 'NOT_FOUND', message: 'unknown connector' });

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

// ---- model connectors (own API keys and subscription logins) ----
const models = router({
  providers: use.query(() => ({
    apiKey: [...builtinProviders().filter((p) => p.auth.apiKey?.login || (p.auth.apiKey && !p.auth.oauth)).map((p) => ({ id: p.id, name: p.name })), { id: CUSTOM, name: 'Custom OpenAI-compatible' }],
    oauth: builtinProviders().filter((p) => p.auth.oauth && p.id !== 'radius')
      .map((p) => ({ id: p.id, name: OAUTH_INFO[p.id]?.name ?? p.auth.oauth!.name, description: OAUTH_INFO[p.id]?.description ?? p.auth.oauth!.name, subscription: !!p.auth.oauth!.isSubscription, deprecated: true })) // oauth.start refuses: the UI should not offer them
      .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)),
  })),
  list: use.query(({ ctx }) => ownConnections(ctx.me.id)),
  connect: use.input(z.object({ provider: z.string().min(1), apiKey: z.string().min(1), baseUrl: z.string().optional(), models: z.array(z.string()).optional() })).mutation(({ ctx, input }) => userFacing(async () => {
    if (input.baseUrl) assertPublicUrl(input.baseUrl);
    const conn = { id: input.provider, baseUrl: input.baseUrl || undefined, models: input.models };
    await validate(conn, input.apiKey);
    connectApiKey(ctx.me.id, conn, input.apiKey);
    return { ok: true };
  })),
  disconnect: use.input(z.object({ provider: z.string() })).mutation(({ ctx, input }) => (disconnectUser(ctx.me.id, input.provider), { ok: true })),
});

// ---- subscription logins (pi-ai OAuth flows, driven from the browser) ----
// scope 'company' (models.manage): the signed-in provider becomes a company provider for everyone.
const oauth = router({
  // Closed to new sign-ins (2026-10): subscriptions may not be used in other products (Anthropic) or behind a gateway, and the hosted CLI agents refuse them.
  // Existing sign-ins keep working for the classic chat and are reported `deprecated`. MCP and storage OAuth are separate (mcp.oauthStart) and unaffected.
  start: use.input(z.object({ provider: z.string(), scope: z.enum(['me', 'company']).default('me') })).mutation(({ ctx, input }) => {
    if (input.scope === 'company' && !ctx.me.permissions.includes('models.manage')) throw forbidden();
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Signing in with a subscription is no longer offered: subscriptions are not meant for use in other products. Connect an API key instead.' });
  }),
  complete: use.input(z.object({ flowId: z.string().min(1), code: z.string().min(1) })).mutation(({ ctx, input }) => userFacing(() => completeFlow(ctx.me.id, input.flowId, input.code))),
  status: use.input(z.object({ id: z.string() })).query(({ ctx, input }) => flowStatus(ctx.me.id, input.id) ?? (() => { throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown or expired sign-in' }); })()),
});

// ---- MCP connectors ----
const managed = (id: string) => {
  const m = moduleOf(id);
  if (m) throw new TRPCError({ code: 'CONFLICT', message: `managed by module ${m}; disable or uninstall it in Settings → Modules` });
};
const mcp = router({
  list: use.query(({ ctx: { me } }) => {
    const builtin = me.permissions.includes('mcp.run_managed')
      ? [{ id: PLAYWRIGHT, name: 'Browser (Playwright)', visibility: 'private', url: '', transport: 'streamable-http', auth: 'none', mine: true, sharedAccount: false,
        builtin: true, enabled: playwrightEnabled(me.id), connected: playwrightEnabled(me.id), available: runnerConfigured(), note: PLAYWRIGHT_NOTE }]
      : [];
    const off = offIds(me.id, 'mcp'); // `on`: given to plain-agent chats (an Assistant names its own servers)
    return [...builtin, ...listConnectors(me.id, me.permissions.includes('modules.manage')).map((c) => ({ ...c, on: !off.has(c.id) }))];
  }),
  /** Change a server you own (an admin: any). Moving it to the team needs the team permission, like creating one there. A new address drops the sign-ins: they never follow it. */
  update: use.input(z.object({ id: z.string(), name: z.string().optional(), url: z.string().optional(), transport: z.string().optional(), visibility: z.enum(['private', 'team']).optional() })).mutation(({ ctx: { me }, input: { id, ...patch } }) => {
    const info = infoOf(id);
    if (!info) throw unknown();
    managed(id);
    if (info.owner !== me.id && me.roleId !== ADMIN_ROLE) throw forbidden();
    if (patch.visibility === 'team' && info.visibility !== 'team' && !me.permissions.includes('profiles.edit_team')) throw forbidden();
    return userFacing(() => (updateConnector(id, patch), { ok: true }));
  }),
  /** Whether plain-agent chats get this server (default on). */
  setOn: use.input(z.object({ id: z.string(), on: z.boolean() })).mutation(({ ctx: { me }, input }) => {
    if (!agentConnectors(me.id).some((c) => c.id === input.id)) throw unknown();
    setOn(me.id, 'mcp', input.id, input.on);
    return { ok: true };
  }),
  // Built-in managed connector: needs mcp.run_managed and a configured runner.
  setPlaywright: use.input(z.object({ enabled: z.boolean() })).mutation(({ ctx, input }) => {
    if (!ctx.me.permissions.includes('mcp.run_managed')) throw forbidden();
    if (input.enabled && !runnerConfigured()) throw new TRPCError({ code: 'CONFLICT', message: 'The sandbox runner is not configured on this server.' });
    setPlaywright(ctx.me.id, input.enabled);
    return { ok: true, enabled: input.enabled };
  }),
  create: use.input(z.object({ name: z.string(), url: z.string(), transport: z.string().optional(), visibility: z.string().optional(), auth: z.string().optional(), bearer: z.string().optional() })).mutation(({ ctx, input }) => {
    if (input.visibility === 'team' && !ctx.me.permissions.includes('profiles.edit_team')) throw forbidden();
    return userFacing(() => ({ id: createConnector(ctx.me.id, input) }));
  }),
  delete: use.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    const owner = ownerOf(input.id);
    if (!owner) throw unknown();
    managed(input.id);
    if (owner !== ctx.me.id && ctx.me.roleId !== ADMIN_ROLE) throw forbidden();
    deleteConnector(input.id);
    return { ok: true };
  }),
  setBearer: use.input(z.object({ id: z.string(), bearer: z.string().min(1) })).mutation(({ ctx, input }) => {
    const info = infoOf(input.id);
    if (!info) throw unknown();
    managed(input.id);
    // A team bearer is a shared account: only team editors may set or replace it.
    if (!(info.visibility === 'team' ? ctx.me.permissions.includes('profiles.edit_team') : info.owner === ctx.me.id)) throw forbidden();
    return userFacing(() => (setBearer(input.id, input.bearer), { ok: true }));
  }),
  test: use.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => testConnector(ctx.me.id, input.id, ctx.me.permissions.includes('modules.manage'))),
  oauthStart: use.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => userFacing(() => startMcpOauth(ctx.me.id, input.id))),
});

export const connectorsRouter = router({ models, oauth, mcp });
