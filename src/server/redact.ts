import { createAssistantMessageEventStream, createModels } from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { instrument } from '@flue/runtime';
import { db } from './appdb.ts';
import { providerAllowed } from './connectors.ts';
import { als, withStamp } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { assertPrivacyReady, audit, imagesAllowed, sidecar } from './privacy.ts';
import { userOfConversation } from './usage.ts';

class Denied extends Error {}

// Privacy layer, agent process. installGate() wraps the pi-ai `Models` class itself (the one entry point Flue and every
// provider, registered by us or not, send model requests through): the whole transcript is redacted by the hefyn-redact
// sidecar first (fail closed: no sidecar answer, GLiNER not active, no request), and restore
// {{var:NAME}} placeholders in the model's text and tool-call arguments before Flue sees them.
// Thinking blocks are never touched in either direction (signed; they only ever hold placeholders).

// Flue's interceptor cannot rewrite payloads, but it runs next() inside our ALS scope: that is how the
// provider call learns the conversation id (also for delegated tasks and compaction).
instrument({ observe: () => {}, interceptor: (_op, ctx, next) => (ctx.instanceId ? als.run(ctx.instanceId, next) : next()), dispose: () => {} });

const loadVars = (id: string): Record<string, string> => {
  const r = db.prepare('SELECT enc FROM redact_vars WHERE conversation_id = ?').get(id) as { enc: string } | undefined;
  return r ? JSON.parse(decrypt(r.enc)) : {};
};

// One redaction at a time per conversation (parallel subagent calls must not allocate the same placeholder twice).
const chains = new Map<string, Promise<unknown>>();
const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const run = (chains.get(id) ?? Promise.resolve()).then(fn, fn);
  chains.set(id, run.catch(() => {}));
  return run;
};

// The model-visible strings of a transcript, as (holder, key) pairs to rewrite in place on a clone.
function refs(messages: any[]): [any, string][] {
  const out: [any, string][] = [];
  const deep = (o: any) => { for (const k of Object.keys(o)) typeof o[k] === 'string' ? out.push([o, k]) : o[k] && typeof o[k] === 'object' && deep(o[k]); };
  const blocks = (m: any) => (typeof m.content === 'string' ? out.push([m, 'content']) : m.content?.forEach((b: any) => b.type === 'text' && out.push([b, 'text'])));
  for (const m of messages) {
    if (m.role === 'assistant') m.content.forEach((b: any) => (b.type === 'text' ? out.push([b, 'text']) : b.type === 'toolCall' && deep(b.arguments)));
    else { blocks(m); if (m.sections) deep(m.sections); }
  }
  return out;
}

const IMAGE_REMOVED = '[image removed by the privacy layer]';
/** GLiNER cannot read images: replace them with text (or keep them when an admin allowed unredacted images). Returns how many. */
function handleImages(messages: any[]): number {
  let n = 0;
  const swap = (content: any) => { if (Array.isArray(content)) content.forEach((b, i) => { if (b?.type === 'image') { n++; if (!imagesAllowed()) content[i] = { type: 'text', text: IMAGE_REMOVED }; } }); };
  for (const m of messages) if (m.role !== 'assistant') swap(m.content);
  return n;
}

async function redactTranscript(id: string, ctx: any) {
  return serial(id, async () => {
    const copy = structuredClone(ctx.messages) as any[];
    const images = handleImages(copy);
    const holder = { systemPrompt: ctx.systemPrompt as string | undefined };
    const r = refs(copy);
    if (typeof holder.systemPrompt === 'string') r.push([holder, 'systemPrompt']);
    const vars = loadVars(id);
    const res = await sidecar('/redact', { texts: r.map(([o, k]) => o[k]), vars: Object.entries(vars).map(([name, value]) => ({ name, value })) });
    if (!Array.isArray(res.texts) || res.texts.length !== r.length) throw new Error('the redaction service returned an unusable answer');
    r.forEach(([o, k], i) => { o[k] = res.texts[i]; });
    for (const v of res.newVars) vars[v.name] = v.value;
    if (res.newVars.length) db.prepare('INSERT OR REPLACE INTO redact_vars (conversation_id, enc) VALUES (?, ?)').run(id, encrypt(JSON.stringify(vars)));
    const findings = res.findings as { label: string; count: number }[];
    if (images) findings.push({ label: imagesAllowed() ? 'IMAGE_SENT_UNREDACTED' : 'IMAGE_REMOVED', count: images });
    return { messages: copy, systemPrompt: holder.systemPrompt, vars, findings };
  });
}

const PLACEHOLDER = /\{\{var:([A-Z][A-Z0-9_]{0,63})\}\}/g;
// What may still grow into a placeholder at the end of a streamed chunk: hold it back until the next one.
const PARTIAL = /\{(?:\{(?:v(?:a(?:r(?::[A-Z0-9_]*\}?)?)?)?)?)?$/;

function restorer(vars: Record<string, string>) {
  const text = (s: string, json = false) => s.replace(PLACEHOLDER, (m, n) => (n in vars ? (json ? JSON.stringify(vars[n]).slice(1, -1) : vars[n]) : m));
  const deep = (o: any) => { for (const k of Object.keys(o)) typeof o[k] === 'string' ? (o[k] = text(o[k])) : o[k] && typeof o[k] === 'object' && deep(o[k]); };
  const msg = (m: AssistantMessage) => {
    const c = structuredClone(m);
    for (const b of c.content) b.type === 'text' ? (b.text = text(b.text)) : b.type === 'toolCall' && deep(b.arguments);
    return c;
  };
  return { text, deep, msg };
}

function failure(model: any, message: string): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: 'error', errorMessage: message, timestamp: Date.now() };
}

function gatedStream(call: (model: any, ctx: any, options?: any) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
  return (model: any, ctx: any, options?: any) => {
    const out = createAssistantMessageEventStream();
    (async () => {
      const id = als.getStore();
      let r: Awaited<ReturnType<typeof redactTranscript>>;
      try {
        if (!id) throw new Error('no conversation context for this model request');
        // Per-user providers are usable by their owner only (checked where the request leaves the server).
        if (!providerAllowed(userOfConversation(id) ?? '', model.provider)) throw new Denied('this model is not available to you');
        await assertPrivacyReady();
        r = await redactTranscript(id, ctx);
      } catch (e) {
        const why = (e as Error).message;
        if (id) audit(id, model, 'blocked', [], null, why);
        const error = failure(model, `${e instanceof Denied ? 'Blocked' : 'Blocked by the privacy layer'}: ${why}. Nothing was sent to the model.`);
        out.push({ type: 'error', reason: 'error', error });
        return out.end(error);
      }
      const rowId = audit(id!, model, 'ok', r.findings, JSON.stringify({ systemPrompt: r.systemPrompt, messages: r.messages }));
      // The provider-native body is the exact payload that leaves the server; it replaces the redacted transcript.
      const onPayload = async (p: unknown, m: unknown) => {
        const own = await options?.onPayload?.(p, m);
        const json = JSON.stringify(own ?? p);
        db.prepare('UPDATE redact_audit SET payload = ?, bytes = ? WHERE id = ?').run(json, Buffer.byteLength(json), rowId);
        return own;
      };
      const { text, deep, msg } = restorer(r.vars);
      const live = Object.keys(r.vars).length > 0;
      const held = new Map<number, string>();
      const mapEvent = (e: any): any => {
        if (!live) return e;
        const n = { ...e };
        if (e.partial) n.partial = msg(e.partial);
        if (e.type === 'done') n.message = msg(e.message);
        if (e.type === 'error') n.error = msg(e.error);
        if (e.type === 'toolcall_end') { n.toolCall = structuredClone(e.toolCall); deep(n.toolCall.arguments); }
        if (e.type === 'text_end') n.content = text(e.content);
        return n;
      };
      const flush = (e: any) => { // deltas held back for a split placeholder go out before the block ends
        const rest = held.get(e.contentIndex);
        if (!rest) return;
        held.delete(e.contentIndex);
        out.push(mapEvent({ ...e, type: e.type === 'text_end' ? 'text_delta' : 'toolcall_delta', delta: text(rest, e.type !== 'text_end') }));
      };
      try {
        const src = withStamp('model', () => call(model, { ...ctx, messages: r.messages, systemPrompt: r.systemPrompt }, { ...options, onPayload })); // the network guard lets only stamped requests out
        for await (const e of src as AsyncIterable<any>) {
          if (live && (e.type === 'text_end' || e.type === 'toolcall_end')) flush(e);
          if (live && (e.type === 'text_delta' || e.type === 'toolcall_delta')) {
            const buf = (held.get(e.contentIndex) ?? '') + e.delta;
            const keep = buf.match(PARTIAL)?.[0].length ?? 0;
            held.set(e.contentIndex, buf.slice(buf.length - keep));
            out.push(mapEvent({ ...e, delta: text(buf.slice(0, buf.length - keep), e.type === 'toolcall_delta') }));
          } else out.push(mapEvent(e));
        }
        out.end();
      } catch (e) {
        const error = failure(model, (e as Error).message);
        out.push({ type: 'error', reason: 'error', error });
        out.end(error);
      }
    })();
    return out;
  };
}

/**
 * Make the redaction gate unbypassable in this process: every `Models` instance (Flue's runtime registry included) sends
 * chat requests through stream/streamSimple (complete* call them), so patching the shared prototype gates all providers,
 * including ones registered with plain setProvider or built-in defaults nobody connected (those are refused outright).
 */
let installed = false;
export function installGate() {
  if (installed) return;
  installed = true;
  const proto = Object.getPrototypeOf(createModels());
  for (const name of ['stream', 'streamSimple'] as const) {
    const orig = proto[name];
    proto[name] = function (this: unknown, model: unknown, ctx: unknown, options?: unknown) {
      return gatedStream((m, c, o) => orig.call(this, m, c, o))(model, ctx, options);
    };
  }
}
