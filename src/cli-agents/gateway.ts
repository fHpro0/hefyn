import { db } from '../server/appdb.ts';
import { build } from '../server/providers.ts';
import { getTeamKey, rememberUserKey, setTeamKey } from '../server/vault.ts';
import { Refused, anthropicUpstream } from './access.ts';
import { watchSse } from './sse.ts';

// Model gateway for hosted CLI agents (Claude Code): an Anthropic Messages API front. The agent's sandbox has no network; its only way to a
// model is the unix socket that the server binds to this handler. The request is forwarded unchanged; the agent's own key is ignored and the real key is resolved here.

/** onRefusal: called with the plain message whenever the gateway refuses a request, so the user sees it at once (Claude Code only shows it after its own handling). */
export interface GatewayCtx { userId: string; conversationId: string; userKey: Buffer; teamKey?: Buffer; onRefusal?: (message: string) => void }

const errorBody = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } });
// x-should-retry: false: Claude Code retries 5xx, 408, 409 and 429 with a growing pause (and would sit silent for minutes); a refusal here never gets better by retrying. 502 (provider unreachable) may.
const errorResponse = (status: number, type: string, message: string) => new Response(errorBody(type, message), { status, headers: { 'content-type': 'application/json', ...(status === 502 ? {} : { 'x-should-retry': 'false' }) } });

export function createGateway(ctx: GatewayCtx): (req: Request) => Promise<Response> {
  const { userId, conversationId } = ctx;
  rememberUserKey(userId, ctx.userKey); // the vault keeps keys in memory only; this process may not have seen the user's key yet
  if (ctx.teamKey && !getTeamKey()) setTeamKey(ctx.teamKey);

  function writeUsage(provider: string, model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
    if (!(u.input || u.output || u.cacheRead || u.cacheWrite)) return;
    let cost = 0;
    try {
      const c = (build({ id: 'anthropic' }, 'x').getAllModels?.() ?? []).find((m: any) => m.id === model)?.cost;
      if (c) cost = (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead + u.cacheWrite * c.cacheWrite) / 1e6;
    } catch { /* unknown model: no price */ }
    // shortcut: the usage table has no source column (and no migration here), so CLI-agent calls look like any other call of provider `anthropic`.
    db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(userId, conversationId, provider, model, u.input, u.output, u.cacheRead, u.cacheWrite, cost, new Date().toISOString());
  }

  const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

  async function messages(req: Request, countOnly: boolean): Promise<Response> {
    let model = '';
    try {
      let body: any;
      const raw = await req.text();
      try { body = JSON.parse(raw); } catch { throw new Refused(400, 'invalid_request_error', 'the request body is not valid JSON'); }
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) throw new Refused(400, 'invalid_request_error', 'the request needs a messages array');
      model = typeof body.model === 'string' ? body.model : '';
      const target = await anthropicUpstream(userId);
      const provider = target.provider;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': target.key, 'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01' };
      const beta = req.headers.get('anthropic-beta');
      if (beta) headers['anthropic-beta'] = beta;
      const url = `${target.root}/v1/messages${countOnly ? '/count_tokens' : ''}${new URL(req.url).search}`;
      const up = await fetch(url, { method: 'POST', headers, body: raw, signal: req.signal })
        .catch((e) => { throw new Refused(502, 'api_error', `the model provider is unreachable (${(e as Error).message})`); });
      const out = new Headers();
      up.headers.forEach((v, k) => { if (!SKIP_RESPONSE_HEADERS.has(k)) out.set(k, v); });
      const ct = up.headers.get('content-type') ?? '';
      if (!up.ok || countOnly || !up.body) return new Response(up.body, { status: up.status, headers: out });
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const note = (u: any) => {
        for (const x of [u?.start, u?.delta]) {
          if (!x) continue;
          if (typeof x.input_tokens === 'number' && x.input_tokens > 0) usage.input = x.input_tokens;
          if (typeof x.output_tokens === 'number') usage.output = x.output_tokens;
          if (typeof x.cache_read_input_tokens === 'number') usage.cacheRead = x.cache_read_input_tokens;
          if (typeof x.cache_creation_input_tokens === 'number') usage.cacheWrite = x.cache_creation_input_tokens;
        }
      };
      // usage is written when the stream ends or the agent goes away, whichever comes first
      const finish = () => { try { writeUsage(provider, model, usage); } catch { /* a locked key must not break the stream */ } };
      if (ct.includes('text/event-stream')) {
        const stream = watchSse(up.body, (e) => (e.type === 'message_start' ? note({ start: e.message?.usage }) : e.type === 'message_delta' ? note({ delta: e.usage }) : undefined), finish);
        return new Response(stream, { status: up.status, headers: out });
      }
      const j: any = await up.json().catch(() => undefined);
      if (!j) throw new Refused(502, 'api_error', 'the model provider returned an unreadable answer');
      note({ start: j.usage });
      finish();
      out.set('content-type', 'application/json');
      return new Response(JSON.stringify(j), { status: up.status, headers: out });
    } catch (e) {
      const r = e instanceof Refused ? e : new Refused(500, 'api_error', (e as Error).message);
      if (r.status !== 502) try { ctx.onRefusal?.(r.message); } catch { /* the session is gone */ }
      return errorResponse(r.status, r.type, r.message);
    }
  }

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'POST' && path === '/v1/messages') return messages(req, false);
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') return messages(req, true);
    return errorResponse(404, 'not_found_error', `${req.method} ${path} is not available through the hefyn model gateway`);
  };
}
