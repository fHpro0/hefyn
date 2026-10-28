import { noRedirectFetch, proxyTarget } from './mcp.ts';
import { mcpFor } from './session-items.ts';

// MCP for the hosted CLI agents. Their sandbox has no network, so the config hefyn writes (session-config.ts) points every server at /mcp/<connectorId> on the model bridge,
// and this forwards the request to the real server with the credentials added here: a bearer token or the person's own OAuth token never enters the sandbox.
// A request is forwarded only if the conversation's user may use that connector (their own, or the team's) AND the conversation's agent was given it (the Assistant's
// servers, or the ones switched on); a stale config in the sandbox cannot reach anything else. Streamable HTTP only: one request in, one response (or event stream) out.

const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);
const reply = (status: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }), { status, headers: { 'content-type': 'application/json' } });

export function mcpProxy(ctx: { userId: string; conversationId: string }, fetchFn: typeof fetch = noRedirectFetch): (req: Request) => Promise<Response> {
  return async (req) => {
    const id = /^\/mcp\/([\w-]{1,64})\/?$/.exec(new URL(req.url).pathname)?.[1];
    if (!id || !['GET', 'POST', 'DELETE'].includes(req.method)) return reply(404, 'Not found');
    if (!mcpFor(ctx.userId, ctx.conversationId).some((c) => c.id === id)) return reply(403, 'This MCP server is not available to this agent.');
    const target = await proxyTarget(ctx.userId, id).catch((e) => e as Error);
    if (target instanceof Error) return reply(502, target.message === 'sign-in needed' ? 'Sign in to this MCP server in hefyn first.' : 'The MCP server could not be reached.');
    if (!target) return reply(403, 'This MCP server is not available to this agent.');
    const headers = new Headers();
    for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers.set(h, v); }
    for (const [k, v] of Object.entries(target.headers)) headers.set(k, v); // after the copy: the sandbox cannot send its own authorization
    const up = await fetchFn(target.url, { method: req.method, headers, body: req.method === 'POST' ? await req.arrayBuffer() : undefined, signal: req.signal }).catch(() => undefined);
    if (!up) return reply(502, 'The MCP server could not be reached.');
    const out = new Headers();
    up.headers.forEach((v, k) => { if (!DROP.has(k)) out.set(k, v); });
    return new Response(up.body, { status: up.status, headers: out });
  };
}
