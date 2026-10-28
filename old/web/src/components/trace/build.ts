// Turns the data behind /api/trace/<conversation> into one tree of trace items. Pure: no React, no fetching.

export interface Usage { provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ts: string }
export interface Call { id: number; provider: string; model: string; ts: string; usage: Usage }
export interface Instr { agent: string; description: string | null; model: string | null; thinking: string | null; instructions: string }
export interface Part { type: string; text?: string; toolName?: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown; errorText?: string; durationMs?: number; data?: unknown; filename?: string; mediaType?: string }
export interface Msg { id: string; role: string; purpose: string; display: string; submissionId?: string; timestamp?: string; parts: Part[] }
export interface Settle { submissionId: string; outcome: string; error?: unknown; timestamp?: string }
export interface ConvTrace {
  id: string; title: string; createdAt: string | null; model: string | null;
  instructions: Instr[]; projectInstructions: string | null; messages: Msg[]; settlements: Settle[]; historyError: string | null; calls: Call[];
}

export type Kind = 'user' | 'system' | 'response' | 'model' | 'tool' | 'subagent' | 'reasoning' | 'text' | 'error';
export interface Item {
  key: string; kind: Kind; title: string; detail?: string; status: 'ok' | 'error' | 'running';
  models: string[]; startMs?: number; durMs?: number; // startMs: offset from the trace start
  input?: unknown; output?: unknown; text?: string; call?: Call; instructions?: Instr; meta?: string[];
  children: Item[]; search: string;
}

const ms = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
const mk = (key: string, kind: Kind, title: string, o: Partial<Item> = {}): Item => {
  const it: Item = { status: 'ok', models: [], children: [], search: '', ...o, key, kind, title };
  it.search = [title, it.detail, str(it.input), str(it.output), it.text, ...it.models, ...(it.meta ?? [])].join('\n').toLowerCase();
  return it;
};
const uniq = <T,>(a: T[]) => [...new Set(a)];
const modelOf = (c: Call) => `${c.provider}/${c.model}`;

/** Chat -> items. `t0` = the trace start (ms). */
export function buildConversation(t: ConvTrace, t0: number, prefix = '', instr: Instr[] = t.instructions): Item[] {
  const byAgent = new Map(instr.map((i) => [i.agent, i]));
  const calls = t.calls.slice().sort((a, b) => ms(a.ts) - ms(b.ts));
  const settleOf = (m: Msg) => t.settlements.find((s) => s.submissionId === m.submissionId);
  const out: Item[] = [];
  const claimed = new Set<number>();
  t.messages.forEach((m, i) => {
    const key = `${prefix}m${i}`, start = ms(m.timestamp);
    const off = Number.isNaN(start) ? undefined : start - t0;
    const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    if (m.role !== 'assistant') {
      out.push(mk(key, m.role === 'user' ? 'user' : 'system', m.role === 'user' ? 'User message' : `System (${m.purpose})`, { startMs: off, text, detail: text.replace(/\s+/g, ' ').slice(0, 100), meta: m.display === 'visible' ? [] : [m.display] }));
      return;
    }
    // A response ends when its submission settles, else where the next message starts.
    const end = ms(settleOf(m)?.timestamp) || ms(t.messages[i + 1]?.timestamp) || Infinity;
    const from = ms(t.messages.slice(0, i).reverse().find((x) => x.role === 'user')?.timestamp) || start;
    const mine = calls.filter((c) => !claimed.has(c.id) && ms(c.ts) >= from - 1 && ms(c.ts) < end);
    mine.forEach((c) => claimed.add(c.id));
    const kids: Item[] = mine.map((c) => callItem(c, t0, `${key}c${c.id}`));
    m.parts.forEach((p, j) => {
      const k = `${key}p${j}`;
      if (p.type === 'reasoning') kids.push(mk(k, 'reasoning', 'Reasoning', { text: p.text, detail: (p.text ?? '').replace(/\s+/g, ' ').slice(0, 100) }));
      else if (p.type === 'text') kids.push(mk(k, 'text', 'Answer', { text: p.text, detail: (p.text ?? '').replace(/\s+/g, ' ').slice(0, 100) }));
      else if (p.type === 'dynamic-tool') {
        const sub = p.toolName === 'task', inp = (p.input ?? {}) as Record<string, unknown>, agent = String(inp.agent ?? '');
        const a = sub ? byAgent.get(agent) : undefined;
        kids.push(mk(k, sub ? 'subagent' : 'tool', sub ? `Hand-off to ${agent || 'agent'}` : p.toolName ?? 'tool', {
          status: p.state === 'output-error' ? 'error' : p.state === 'output-available' ? 'ok' : 'running', durMs: p.durationMs, input: p.input,
          output: p.state === 'output-error' ? p.errorText : p.output, instructions: a, models: a?.model ? [a.model] : [],
          detail: sub ? str(inp.description ?? inp.prompt).slice(0, 100) : str(Object.values(inp)[0]).replace(/\s+/g, ' ').slice(0, 100),
          meta: a ? [a.instructions] : [], // searchable
        }));
      } else if (p.type === 'file') kids.push(mk(k, 'text', `File ${p.filename ?? p.mediaType ?? ''}`, { text: p.mediaType }));
      else if (p.type.startsWith('data-')) kids.push(mk(k, 'text', p.type, { output: p.data }));
    });
    const s = settleOf(m);
    if (s && s.outcome !== 'completed') kids.push(mk(`${key}s`, 'error', `Response ${s.outcome}`, { status: 'error', output: s.error, startMs: ms(s.timestamp) - t0 }));
    const tools = m.parts.filter((p) => p.type === 'dynamic-tool').length;
    out.push(mk(key, 'response', 'Assistant response', {
      startMs: off, durMs: Number.isFinite(end) && !Number.isNaN(start) ? end - start : undefined, children: kids, models: uniq(mine.map(modelOf)),
      status: s && s.outcome !== 'completed' ? 'error' : 'ok', detail: `${mine.length} model ${mine.length === 1 ? 'call' : 'calls'}, ${tools} tool ${tools === 1 ? 'call' : 'calls'}`,
    }));
  });
  const rest = calls.filter((c) => !claimed.has(c.id)); // blocked requests and calls outside any response
  if (rest.length) out.push(mk(`${prefix}rest`, 'response', 'Other model calls', { children: rest.map((c) => callItem(c, t0, `${prefix}c${c.id}`)), models: uniq(rest.map(modelOf)), detail: 'not tied to a response' }));
  return out;
}

function callItem(c: Call, t0: number, key: string): Item {
  const u = c.usage;
  return mk(key, 'model', 'Model call', {
    call: c, models: [modelOf(c)], startMs: ms(c.ts) - t0, detail: `${u.input} in, ${u.output} out`,
  });
}

export interface Totals { turns: number; tools: number; calls: number; durMs?: number; tokens: number; cost: number; hasUsage: boolean; models: string[] }
export function totals(items: Item[]): Totals {
  const t: Totals = { turns: 0, tools: 0, calls: 0, tokens: 0, cost: 0, hasUsage: false, models: [] };
  const walk = (it: Item) => {
    if (it.kind === 'response') t.turns++;
    if (it.kind === 'tool' || it.kind === 'subagent') t.tools++;
    if (it.kind === 'model') { t.calls++; const u = it.call?.usage; if (u) { t.hasUsage = true; t.tokens += u.input + u.output; t.cost += u.cost; } }
    it.models.forEach((m) => !t.models.includes(m) && t.models.push(m));
    it.children.forEach(walk);
  };
  items.forEach(walk);
  const ends = items.map((i) => (i.startMs ?? 0) + (i.durMs ?? 0)).filter(Boolean);
  if (ends.length) t.durMs = Math.max(...ends);
  return t;
}

/** Keeps items whose own text or any descendant's matches; `q` is lower case. */
export function filter(items: Item[], q: string): Item[] {
  if (!q) return items;
  return items.flatMap((it) => {
    const kids = filter(it.children, q);
    return it.search.includes(q) || kids.length ? [{ ...it, children: it.search.includes(q) && !kids.length ? it.children : kids }] : [];
  });
}
