import { Hono } from 'hono';
import { db } from '../server/appdb.ts';
import { userOfConversation } from '../server/usage.ts';
import { LockedError, userKey } from '../server/vault.ts';
import { type CliHost, type CliSession, HostError } from './host.ts';
import { canonicalAgent, profileOf } from './profiles.ts';

// /agents/cli/:conversationId/…  The browser's side of a hosted CLI agent (docs/SANDBOX.md). web's agentGuard has proved ownership, the agent and the
// sandbox; this process trusts only the internal token (app.ts) and looks the conversation up again.

const text = (v: unknown, max = 200_000) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
export const size = (v: any) => (v && Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols > 0 && v.rows > 0 && v.cols <= 1000 && v.rows <= 1000 ? { cols: v.cols as number, rows: v.rows as number } : undefined);

/** An SSE response; `start` gets `send` and `end` and returns the cleanup. */
export function sse(signal: AbortSignal, start: (send: (data: string) => void, end: () => void) => () => void): Response {
  const enc = new TextEncoder();
  let stop = () => {}, beat: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let done = false;
      const finish = () => { if (done) return; done = true; clearInterval(beat); stop(); try { ctrl.close(); } catch { /* already closed */ } };
      const send = (d: string) => { if (!done) try { ctrl.enqueue(enc.encode(`data: ${d}\n\n`)); } catch { finish(); } };
      beat = setInterval(() => { if (!done) try { ctrl.enqueue(enc.encode(': ping\n\n')); } catch { finish(); } }, 15_000); // keeps proxies from idling the stream out
      stop = start(send, finish);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    },
    cancel() { clearInterval(beat); stop(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

/** The hosted CLI agent of a chat (conversations.agent): events, prompt, permission, cancel and the terminal. */
export function cliRoutes(host: CliHost) {
  const app = new Hono<{ Variables: { s: CliSession } }>();
  app.onError((e, c) => (e instanceof HostError ? c.json({ error: e.message }, e.status as 400)
    : e instanceof LockedError ? c.json({ error: 'locked', scope: e.scope }, 423) : (console.error(e), c.json({ error: 'internal error' }, 500))));
  app.use('/:id/*', async (c, next) => {
    const id = c.req.param('id'), userId = userOfConversation(id);
    const row = userId && (db.prepare('SELECT agent FROM conversations WHERE id = ? AND user_id = ?').get(id, userId) as { agent: string | null } | undefined);
    if (!row || !row.agent || !profileOf(canonicalAgent(row.agent))) return c.json({ error: 'not found' }, 404);
    if (!userKey(userId)) return c.json({ error: 'locked', scope: 'user' }, 423);
    c.set('s', host.session(userId, id));
    await next();
  });

  app.get('/:id/events', (c) => {
    const s = c.get('s'), after = Math.max(0, Number(c.req.query('after')) || 0);
    return sse(c.req.raw.signal, (send) => s.subscribe(after, (e) => send(JSON.stringify(e))));
  });
  app.post('/:id/prompt', async (c) => {
    const body = await c.req.json().catch(() => ({})), l = body?.lane;
    if (l !== undefined && !(l && typeof l === 'object' && typeof l.agent === 'string' && (l.action === 'message' || l.action === 'stop'))) return c.json({ error: 'lane needs an agent and an action (message or stop)' }, 400);
    const t = text(body?.text) ?? (l?.action === 'stop' ? '' : undefined);
    if (t === undefined) return c.json({ error: 'text is required' }, 400);
    c.get('s').prompt(t, body?.theme === 'light' || body?.theme === 'dark' ? body.theme : undefined, l && { agent: l.agent, action: l.action });
    return c.json({ ok: true }, 202);
  });
  app.post('/:id/permission', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (typeof b?.requestId !== 'string' || !(typeof b.optionId === 'string' || b.optionId === null)) return c.json({ error: 'requestId and optionId (or null) are required' }, 400);
    c.get('s').answer(b.requestId, b.optionId);
    return c.json({ ok: true });
  });
  app.post('/:id/cancel', async (c) => { await c.get('s').cancel(); return c.json({ ok: true }); });

  app.post('/:id/terminal', async (c) => {
    const body = await c.req.json().catch(() => ({})), sz = size(body);
    if (!sz) return c.json({ error: 'cols and rows are required' }, 400);
    const theme = body?.theme;
    if (theme !== undefined && theme !== 'light' && theme !== 'dark') return c.json({ error: 'theme must be light or dark' }, 400);
    await c.get('s').openTerminal(sz.cols, sz.rows, theme);
    return c.json({ ok: true });
  });
  app.get('/:id/terminal/stream', (c) => {
    const s = c.get('s');
    if (!s.terminalOpen) return c.json({ error: 'The terminal is not open.' }, 409);
    return sse(c.req.raw.signal, (send, end) => s.terminalStream((b) => send(b.toString('base64')), (b) => send(b.toString('base64')), end));
  });
  app.post('/:id/terminal/input', async (c) => {
    const d = (await c.req.json().catch(() => ({})))?.data;
    if (typeof d !== 'string' || d.length > 1_000_000) return c.json({ error: 'data is required' }, 400);
    c.get('s').terminalInput(d);
    return c.json({ ok: true });
  });
  app.post('/:id/terminal/resize', async (c) => {
    const sz = size(await c.req.json().catch(() => ({})));
    if (!sz) return c.json({ error: 'cols and rows are required' }, 400);
    await c.get('s').terminalResize(sz.cols, sz.rows);
    return c.json({ ok: true });
  });
  return app;
}
