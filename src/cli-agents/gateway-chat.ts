import { db } from '../server/appdb.ts';
import { build } from '../server/providers.ts';
import { getTeamKey, rememberUserKey, setTeamKey } from '../server/vault.ts';
import { Refused, chatUpstream, keyPolicy } from './access.ts';
import type { GatewayCtx } from './gateway.ts';
import { providerApis } from './providers.ts';
import { watchSse } from './sse.ts';

// Model gateway for agents on an OpenAI-compatible provider (OpenCode, Pi ... on OpenRouter, Mistral, Groq, DeepSeek, xAI, OpenAI, a custom endpoint): an OpenAI chat completions
// front (POST /v1/chat/completions). Same shape as the other fronts: the request is forwarded unchanged, the agent's own key is ignored. The upstream is the
// provider the SESSION runs on (keyPolicy.session, set by the host from the Assistant / the admin's default), never anything in the request.

const errorResponse = (status: number, type: string, message: string) =>
  // OpenCode (AI SDK) and Pi (openai SDK) retry 408, 409, 429 and 5xx but not 400/403 (measured, see docs/SANDBOX.md); x-should-retry: false for the SDKs that read it. 502 may be retried.
  new Response(JSON.stringify({ error: { message, type, code: type } }), { status, headers: { 'content-type': 'application/json', ...(status === 502 ? {} : { 'x-should-retry': 'false' }) } });

export function createChatGateway(ctx: GatewayCtx): (req: Request) => Promise<Response> {
  const { userId, conversationId } = ctx;
  rememberUserKey(userId, ctx.userKey);
  if (ctx.teamKey && !getTeamKey()) setTeamKey(ctx.teamKey);

  const usageOf = (j: any) => {
    const u = j?.usage ?? {}, cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
    return { input: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead), output: u.completion_tokens ?? 0, cacheRead };
  };
  function writeUsage(provider: string, pid: string, model: string, u: ReturnType<typeof usageOf>) {
    if (!(u.input || u.output || u.cacheRead)) return;
    let cost = 0;
    try {
      const c = (build({ id: pid }, 'x').getAllModels?.() ?? []).find((m: any) => m.id === model)?.cost;
      if (c) cost = (u.input * c.input + u.output * c.output + u.cacheRead * (c.cacheRead ?? 0)) / 1e6;
    } catch { /* unknown model or a custom provider: no price */ }
    // shortcut: the usage table has no source column, so CLI-agent calls look like any other call of the provider.
    db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(userId, conversationId, provider, model, u.input, u.output, u.cacheRead, 0, cost, new Date().toISOString());
  }

  const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

  async function completions(req: Request): Promise<Response> {
    let model = '';
    try {
      let body: any;
      try { body = JSON.parse(await req.text()); } catch { throw new Refused(400, 'invalid_request_error', 'the request body is not valid JSON'); }
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) throw new Refused(400, 'invalid_request_error', 'the request needs a messages array');
      model = typeof body.model === 'string' ? body.model : '';
      const pid = keyPolicy.getStore()?.session ?? '';
      if (!pid || !providerApis(pid).includes('openai-chat')) throw new Refused(400, 'invalid_request_error', 'This agent session does not run on an OpenAI-compatible provider. Nothing was sent to the model.');
      const target = await chatUpstream(userId, pid);
      const provider = target.provider;
      if (body.stream) body.stream_options = { ...(body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {}), include_usage: true }; // hefyn counts the tokens
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${target.key}`, accept: req.headers.get('accept') ?? 'application/json' };
      const up = await fetch(`${target.root}/chat/completions${new URL(req.url).search}`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal })
        .catch((e) => { throw new Refused(502, 'api_error', `the model provider is unreachable (${(e as Error).message})`); });
      const out = new Headers();
      up.headers.forEach((v, k) => { if (!SKIP_RESPONSE_HEADERS.has(k)) out.set(k, v); });
      if (!up.ok || !up.body) return new Response(up.body, { status: up.status, headers: out });
      if ((up.headers.get('content-type') ?? '').includes('text/event-stream')) {
        let usage = { input: 0, output: 0, cacheRead: 0 };
        const finish = () => { try { writeUsage(provider, pid, model, usage); } catch { /* a locked key must not break the stream */ } };
        return new Response(watchSse(up.body, (e) => { if (e.usage) usage = usageOf(e); }, finish), { status: up.status, headers: out });
      }
      const j: any = await up.json().catch(() => undefined);
      if (!j) throw new Refused(502, 'api_error', 'the model provider returned an unreadable answer');
      try { writeUsage(provider, pid, model, usageOf(j)); } catch { /* see above */ }
      out.set('content-type', 'application/json');
      return new Response(JSON.stringify(j), { status: up.status, headers: out });
    } catch (e) {
      const r = e instanceof Refused ? e : new Refused(500, 'api_error', (e as Error).message);
      if (r.status !== 502) try { ctx.onRefusal?.(r.message); } catch { /* the session is gone */ }
      // OpenCode retries (2, 4, 8, 16 ... s, for over a minute) an error whose text says to try again (measured 1.19.4); a refusal here is answered once, so that sentence stays out of what the agent sees
      return errorResponse(r.status, r.type, r.message.replace(/\s*Try again[^.]*\.$/i, ''));
    }
  }

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'POST' && path === '/v1/chat/completions') return completions(req);
    return errorResponse(404, 'not_found_error', `${req.method} ${path} is not available through the hefyn model gateway`);
  };
}
