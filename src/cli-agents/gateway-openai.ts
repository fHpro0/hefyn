import { db } from '../server/appdb.ts';
import { build } from '../server/providers.ts';
import { getTeamKey, rememberUserKey, setTeamKey } from '../server/vault.ts';
import { Refused, openaiUpstream } from './access.ts';
import type { GatewayCtx } from './gateway.ts';
import { watchSse } from './sse.ts';

// Model gateway for Codex: an OpenAI Responses API front (POST /v1/responses). Same shape as the Anthropic front in gateway.ts:
// the request is forwarded unchanged, the agent's own key is ignored. Wire format checked against what codex-cli 0.154 sends.

const errorResponse = (status: number, type: string, message: string) =>
  // Codex 0.154 retries every status but 400 (up to 5 more times, ~6 s, and ignores x-should-retry), so refusals are sent as 400 (see the catch below). 502 may be retried.
  new Response(JSON.stringify({ error: { message, type, code: type } }), { status, headers: { 'content-type': 'application/json', ...(status === 502 ? {} : { 'x-should-retry': 'false' }) } });

export function createOpenAIGateway(ctx: GatewayCtx): (req: Request) => Promise<Response> {
  const { userId, conversationId } = ctx;
  rememberUserKey(userId, ctx.userKey);
  if (ctx.teamKey && !getTeamKey()) setTeamKey(ctx.teamKey);

  const usageOf = (r: any) => {
    const u = r?.usage ?? {}, cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
    return { input: Math.max(0, (u.input_tokens ?? 0) - cacheRead), output: u.output_tokens ?? 0, cacheRead, cacheWrite: 0 };
  };
  function writeUsage(provider: string, model: string, u: ReturnType<typeof usageOf>) {
    if (!(u.input || u.output || u.cacheRead)) return;
    let cost = 0;
    try {
      const c = (build({ id: 'openai' }, 'x').getAllModels?.() ?? []).find((m: any) => m.id === model)?.cost;
      if (c) cost = (u.input * c.input + u.output * c.output + u.cacheRead * (c.cacheRead ?? 0)) / 1e6;
    } catch { /* unknown model: no price */ }
    // shortcut: the usage table has no source column, so CLI-agent calls look like any other call of the provider.
    db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(userId, conversationId, provider, model, u.input, u.output, u.cacheRead, u.cacheWrite, cost, new Date().toISOString());
  }

  const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

  async function responses(req: Request): Promise<Response> {
    let model = '';
    try {
      let body: any;
      const raw = await req.text();
      try { body = JSON.parse(raw); } catch { throw new Refused(400, 'invalid_request_error', 'the request body is not valid JSON'); }
      if (!body || typeof body !== 'object' || !(Array.isArray(body.input) || typeof body.input === 'string')) throw new Refused(400, 'invalid_request_error', 'the request needs an input');
      model = typeof body.model === 'string' ? body.model : '';
      const target = await openaiUpstream(userId);
      const provider = target.provider;
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${target.key}`, accept: req.headers.get('accept') ?? 'application/json' };
      const url = `${target.root}/v1/responses`;
      const up = await fetch(url + new URL(req.url).search, { method: 'POST', headers, body: raw, signal: req.signal })
        .catch((e) => { throw new Refused(502, 'api_error', `the model provider is unreachable (${(e as Error).message})`); });
      const out = new Headers();
      up.headers.forEach((v, k) => { if (!SKIP_RESPONSE_HEADERS.has(k)) out.set(k, v); });
      if (!up.ok || !up.body) return new Response(up.body, { status: up.status, headers: out });
      if ((up.headers.get('content-type') ?? '').includes('text/event-stream')) {
        let usage = usageOf(undefined);
        const finish = () => { try { writeUsage(provider, model, usage); } catch { /* a locked key must not break the stream */ } };
        const done = new Set(['response.completed', 'response.incomplete', 'response.failed']);
        return new Response(watchSse(up.body, (e) => { if (done.has(e.type)) usage = usageOf(e.response); }, finish), { status: up.status, headers: out });
      }
      const j: any = await up.json().catch(() => undefined);
      if (!j) throw new Refused(502, 'api_error', 'the model provider returned an unreadable answer');
      try { writeUsage(provider, model, usageOf(j)); } catch { /* see above */ }
      out.set('content-type', 'application/json');
      return new Response(JSON.stringify(j), { status: up.status, headers: out });
    } catch (e) {
      const r = e instanceof Refused ? e : new Refused(500, 'api_error', (e as Error).message);
      if (r.status !== 502) try { ctx.onRefusal?.(r.message); } catch { /* the session is gone */ }
      return errorResponse(r.status === 403 ? 400 : r.status, r.type, r.message); // Codex retries 403 (measured: 6 attempts) but not 400
    }
  }

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'POST' && path === '/v1/responses') return responses(req);
    if (req.method === 'GET' && path === '/v1/models') {
      const data = (build({ id: 'openai' }, 'x').getModels() as any[]).map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'openai' }));
      return new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } });
    }
    return errorResponse(404, 'not_found_error', `${req.method} ${path} is not available through the hefyn model gateway`);
  };
}
