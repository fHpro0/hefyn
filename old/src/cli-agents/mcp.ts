import type { FlowHost } from '../assistants/session.ts';
import { db } from '../server/appdb.ts';
import { assistantAvailability } from '../server/assistant-access.ts';
import { offOf } from '../agents/tool-filter.ts';
import { type Assistant, getAssistant, roleOf, visibleTo } from '../server/assistants.ts';
import { LockedError } from '../server/vault.ts';

// hefyn's own MCP server for a hosted CLI agent (docs/ASSISTANTS.md "In CLI agents"): the Assistants the conversation's user may use, one tool each, so Claude Code, Codex, OpenCode
// ... can call them like mods. It is the third route on the conversation's model socket (/mcp, next to /v1/messages and /v1/responses, host.ts); the sandbox reaches it as
// http://127.0.0.1:47000/mcp through the same bridge. Streamable HTTP, hand-written: the MCP SDK installed here is the client only, and four methods do not need a server SDK.
// shortcut: no server-to-client stream (GET is 405) and so no tools/list_changed; tools/list is computed on every request, so a new Assistant shows up on the agent's next list.

export interface AssistantTool { slug: string; /** the tool's name */ tool: string; name: string; description: string; assistant: Assistant }

const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'assistant';

/**
 * The Assistants this conversation's user may use right now (role, availability as `assistants.list` judges them), minus the one the chat runs under. Names are
 * `assistant_<slug>`; equal slugs get -2, -3 ... in the list's order. The hidden chats of a flow's CLI steps get none, so a flow cannot reach itself through its own agent.
 */
export async function assistantTools(userId: string, conversationId: string): Promise<AssistantTool[]> {
  const c = db.prepare('SELECT assistant_id, parent_id FROM conversations WHERE id = ?').get(conversationId) as { assistant_id: string | null; parent_id: string | null } | undefined;
  if (!c || c.parent_id) return [];
  const off = offOf(c.assistant_id ? getAssistant(c.assistant_id)?.flow : undefined); // turned off in the chat's Assistant (Tools tab)
  const mine = visibleTo(userId, roleOf(userId)).filter((a) => a.id !== c.assistant_id && !off.has(`assistant:${a.id}`));
  const ok = await Promise.all(mine.map((a) => assistantAvailability(userId, a).then((r) => r.available, () => false)));
  const used = new Set<string>();
  return mine.filter((_, i) => ok[i]).map((a) => {
    const base = slugOf(a.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    used.add(slug);
    return { slug, tool: `assistant_${slug}`, name: a.name, description: a.description.trim() || a.name, assistant: a };
  });
}

// Codex builds a turn's tool list from what tools/list answered within about a second of starting its MCP servers (measured 0.160.1: 700 ms fine, 1500 ms never listed, so the model
// never saw a tool and the server still showed as connected). Working out the list takes an availability check per Assistant, so the host works it out before it starts the agent
// (and at each turn, host.ts toolsFor) and hands it over here: the next tools/list answers from it at once, once. Later lists are computed.
const primed = new Map<string, { at: number; tools: AssistantTool[] }>();
export function primeTools(conversationId: string, tools: AssistantTool[]) {
  primed.delete(conversationId); primed.set(conversationId, { at: Date.now(), tools });
  if (primed.size > 500) primed.delete(primed.keys().next().value!);
}
const PRIMED_MS = 60_000;

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const say = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** The MCP endpoint of one CLI conversation. A tool call runs the Assistant's flow as a run of this chat (events in its log, approvals through /answer) and returns the Reply. */
export function mcpHandler(flows: FlowHost, userId: string, conversationId: string): (req: Request) => Promise<Response> {
  async function call(params: any, signal: AbortSignal) {
    const message = params?.arguments?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 200_000) return say('Pass what you want done as "message" (a non-empty text).', true);
    const tool = (await assistantTools(userId, conversationId)).find((t) => t.tool === params?.name);
    if (!tool) return say('This Assistant is not available to you (any more).', true);
    const f = flows.forCli(userId, conversationId);
    let started: ReturnType<typeof f.runTool>;
    try { started = f.runTool(tool.assistant, message); } catch (e) { return say(e instanceof LockedError ? 'Your data is locked. Sign in to hefyn again.' : `Could not start "${tool.name}": ${(e as Error).message}`, true); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => void f.cancelRun(started.id); // the agent gave up on the call (Stop, or the connection closed)
    signal.addEventListener('abort', stop, { once: true });
    const r = await Promise.race([started.done, new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), flows.mcpWaitMs); timer.unref?.(); })]);
    clearTimeout(timer); signal.removeEventListener('abort', stop);
    if (r === 'timeout') {
      await f.cancelRun(started.id);
      return say(`"${tool.name}" was waiting for a person to answer in hefyn for ${Math.round(flows.mcpWaitMs / 60_000)} minutes and was stopped. Ask the user to try again and to answer its question in hefyn promptly.`, true);
    }
    if (r.status === 'done') return say(r.state.replies.join('\n\n') || 'The flow finished without a reply.');
    if (r.status === 'cancelled') return say(`"${tool.name}" was stopped.`, true);
    return say(r.state.error ?? `"${tool.name}" did not finish.`, true);
  }

  return async (req) => {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    let m: any;
    try { m = await req.json(); } catch { return json(fail(null, -32700, 'Parse error'), 400); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.method !== 'string') return m && 'result' in m ? new Response(null, { status: 202 }) : json(fail(null, -32600, 'Invalid request'), 400);
    if (m.id === undefined) return new Response(null, { status: 202 }); // a notification (initialized, cancelled ...)
    const ok = (result: unknown) => json({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': {
        const v = m.params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hefyn', version: '1' },
          instructions: 'Each tool runs one of the user\'s hefyn Assistants. Pass the request as "message"; the Assistant\'s reply comes back as the result. It may take a while, or wait for the user to approve something in hefyn.' });
      }
      case 'ping': return ok({});
      case 'tools/list': {
        let tools: AssistantTool[] = [];
        const hit = primed.get(conversationId); primed.delete(conversationId);
        try { tools = hit && Date.now() - hit.at < PRIMED_MS ? hit.tools : await assistantTools(userId, conversationId); } catch { /* locked: no tools */ }
        return ok({ tools: tools.map((t) => ({ name: t.tool, title: t.name, description: t.description, inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'What you want the Assistant to do, with everything it needs to know.' } }, required: ['message'] } })) });
      }
      case 'tools/call': {
        // A run can wait minutes for a person: answer as an event stream that starts at once and keeps alive, so no client times out waiting for response headers.
        const ctl = new AbortController(), enc = new TextEncoder();
        req.signal.addEventListener('abort', () => ctl.abort(), { once: true });
        let beat: ReturnType<typeof setInterval>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(': hefyn\n\n'));
            beat = setInterval(() => { try { c.enqueue(enc.encode(': ping\n\n')); } catch { /* closed */ } }, 15_000);
            call(m.params, ctl.signal).catch((e) => say(`The Assistant failed: ${(e as Error)?.message ?? e}`, true)).then((result) => {
              clearInterval(beat);
              try { c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`)); c.close(); } catch { /* the client left */ }
            });
          },
          cancel() { clearInterval(beat); ctl.abort(); },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' } });
      }
      default: return json(fail(m.id, -32601, `Method not found: ${m.method}`));
    }
  };
}
