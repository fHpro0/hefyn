import type { ActivityAgent } from './activity';

// Folds the event stream of a CLI agent (ACP SessionUpdates + hefyn events, docs: backend contract /agents/cli/:id/events) into a transcript.
// Pure and immutable: replaying the same seq twice changes nothing, so reconnects and reloads never duplicate.

export type ToolContent = { type: 'text'; text: string } | { type: 'diff'; path: string; oldText?: string | null; newText: string } | { type: 'terminal'; terminalId: string } | { type: 'image'; src: string };
export interface PermissionOption { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }
export interface PlanEntry { content: string; priority?: string; status: 'pending' | 'in_progress' | 'completed' }
export interface Waiting { kind: 'approval' | 'ask'; message: string; fields?: { name: string; label: string; type: 'text' | 'choice'; options?: string[] }[]; editable?: boolean; /** approval: what is reviewed */ content?: string }
/** One node of a run. `items` holds what a CLI agent step did (tool calls, permissions), nested under the step. */
export interface RunStep { node: string; label: string; type: string; status: 'running' | 'done' | 'skipped' | 'failed'; error?: string; text?: string; json?: unknown; items: Item[]; waiting?: Waiting }
/** `parentRunId`/`parentNode`: a sub-run, started by that step of that run (`nest` puts it inside the step). */
export type Run = { kind: 'run'; runId: string; assistantId?: string; parentRunId?: string; parentNode?: string; status: 'running' | 'done' | 'failed' | 'cancelled'; steps: RunStep[]; startedAt?: number; endedAt?: number };
export type Item =
  | Run
  | { kind: 'user'; text: string; via?: string } // via 'terminal': typed there
  | { kind: 'agent'; text: string; mid?: string; done?: boolean } // mid: ACP messageId; done: the turn ended, the next chunk is a new message
  | { kind: 'thought'; text: string; mid?: string; done?: boolean }
  | { kind: 'tool'; id: string; title: string; toolKind?: string; status: string; content: ToolContent[]; rawInput?: unknown; rawOutput?: unknown; sub?: string; agentId?: string; allowed?: boolean } // allowed: the answer to the permission question of this call (one row, not a second one) // sub: a sub-agent call (Claude Code's Task/Agent tool), its description; agentId: the sub-agent session it started
  | { kind: 'plan'; entries: PlanEntry[] }
  // by: a sub-agent asks (the card is in the main view); it stays open when the turn that started the sub-agent ends. answered.by 'claude': nobody clicked here (the terminal, or a rule of Claude Code's own)
  | { kind: 'permission'; requestId: string; toolCallId?: string; title: string; options: PermissionOption[]; by?: string; answered?: { optionId: string | null; by?: string } }
  | { kind: 'error'; message: string }
  | { kind: 'auth'; agentId: string; name: string; reason: 'expired' | 'signed_out' } // the user's own sign-in ended or is missing: a card with a way back in
  | { kind: 'stopped' } // the reader cancelled the turn
  | { kind: 'empty' }
  | { kind: 'aside' }; // the conversation continued in the terminal here (client-side marker) // the turn ended with no reply and no error
/** A sub-agent of the conversation (Claude Code's Agent tool): a session of its own, whose events carry `agent: <id>` in the log. */
export interface SubAgent { id: string; type: string; description: string; status: 'running' | 'done' | 'failed'; startedAt?: number; endedAt?: number; toolCallId?: string }
// out / errored: did the current turn produce agent output / an error event
export interface Transcript { seq: number; items: Item[]; busy: boolean; out: boolean; errored: boolean; status: 'starting' | 'ready' | 'stopped' | ''; commands: { name: string; description?: string }[]; agents: SubAgent[]; lanes: Record<string, Item[]> }
export interface CliEvent { seq: number; at?: string; update: any }

export const empty: Transcript = { seq: 0, items: [], busy: false, out: false, errored: false, status: '', commands: [], agents: [], lanes: {} };

// ACP content blocks: only text is shown; anything else (image, resource) becomes a short placeholder.
const textOf = (c: any): string => (c?.type === 'text' ? String(c.text ?? '') : c ? `[${c.type ?? 'attachment'}]` : '');
const contentOf = (list: any[] | undefined): ToolContent[] => (list ?? []).flatMap((c): ToolContent[] =>
  c?.type === 'diff' ? [{ type: 'diff', path: String(c.path), oldText: c.oldText, newText: String(c.newText ?? '') }]
  : c?.type === 'terminal' ? [{ type: 'terminal', terminalId: String(c.terminalId) }]
  : c?.type === 'content' && c.content?.type === 'image' ? imageOf(c.content)
  : c?.type === 'content' && textOf(c.content) ? [{ type: 'text', text: textOf(c.content) }] : []);
/** An ACP image block as an inline src: base64 data, or a data:image/ URL. Never a remote URL: an agent-supplied <img src> would leak through the browser, past the egress gate. */
const imageOf = (c: any): ToolContent[] => {
  const d = typeof c.data === 'string' ? c.data : '', u = typeof c.uri === 'string' ? c.uri : '';
  const src = [d, u].find((x) => x.startsWith('data:image/')) ?? (d && !d.startsWith('data:') ? `data:${/^image\/[\w.+-]+$/.test(c.mimeType) ? c.mimeType : 'image/png'};base64,${d}` : '');
  return src ? [{ type: 'image', src }] : [];
};

/** Appends to the last item when it has the same kind (a stream of chunks is one message), else starts a new one. A message ends at another messageId, a finished turn, or any other item (a tool call); chunks are never joined with a separator. */
const chunk = (items: Item[], kind: 'user' | 'agent' | 'thought', text: string, mid?: string | null): Item[] => {
  const tail = items.at(-1);
  if (tail?.kind === 'aside' && items.at(-2)?.kind === kind) return [...chunk(items.slice(0, -1), kind, text, mid), tail]; // a terminal marker never splits a message
  const last = items.at(-1) as { kind: string; text: string; mid?: string; done?: boolean } | undefined, m = (kind !== 'user' && mid) || undefined;
  if (last?.kind === kind && !last.done && !(m && last.mid && m !== last.mid)) return [...items.slice(0, -1), { ...last, text: last.text + text, ...(m && { mid: last.mid ?? m }) } as Item];
  return [...items, { kind, text, ...(m && { mid: m }) } as Item];
};

/** A turn boundary closes the message before it: the next chunk starts a new one. */
const endMessage = (items: Item[]): Item[] => {
  const last = items.at(-1);
  return last && (last.kind === 'agent' || last.kind === 'thought') && !last.done ? [...items.slice(0, -1), { ...last, done: true }] : items;
};

// Flow runs: a run card per runId, a step per node. An event for a run or step we never saw (stream started mid-way) creates it.
const patchRun = (items: Item[], runId: string, fn: (r: Run) => Run): Item[] => {
  const i = items.findIndex((x) => x.kind === 'run' && x.runId === runId);
  const n = fn(i < 0 ? { kind: 'run', runId, status: 'running', steps: [] } : (items[i] as Run));
  return i < 0 ? [...items, n] : items.map((x, j) => (j === i ? n : x));
};
const patchStep = (r: Run, node: string, fn: (s: RunStep) => RunStep): Run => {
  const i = r.steps.findIndex((x) => x.node === node);
  const n = fn(i < 0 ? { node, label: node, type: '', status: 'running', items: [] } : r.steps[i]);
  return { ...r, steps: i < 0 ? [...r.steps, n] : r.steps.map((x, j) => (j === i ? n : x)) };
};
/** Maps the items, and those nested in run steps. */
const deep = (items: Item[], f: (x: Item) => Item): Item[] => items.map((x) => (x.kind === 'run' ? { ...x, steps: x.steps.map((st) => ({ ...st, items: deep(st.items, f) })) } : f(x)));
const closeAsks = (items: Item[]) => deep(items, (x) => (x.kind === 'permission' && !x.answered && !x.by ? { ...x, answered: { optionId: null } } : x)); // a sub-agent's question is closed by the host (permission_resolved), not by the end of the turn
/** Claude Code's sub-agents arrive as ordinary tool calls. Recognised by _meta tool name, a subagent_type input, or a bare "Task"/"Agent" title; tolerant on purpose (other agents name theirs differently). Returns the description, or `prev` when this does not look like one. */
const NAMED = /^(task|agent)$/i;
function subOf(u: any, prev?: string): string | undefined {
  const i = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}, title = typeof u.title === 'string' ? u.title : '';
  const is = NAMED.test(String(u._meta?.claudeCode?.toolName ?? '')) || typeof i.subagent_type === 'string' || NAMED.test(title) || (u.kind === 'think' && typeof i.prompt === 'string' && typeof i.description === 'string');
  return is ? String(i.description ?? (title && !NAMED.test(title) ? title : i.subagent_type ?? 'Working')) : prev;
}
const NESTED = ['tool_call', 'tool_call_update', 'permission', 'permission_resolved', 'plan', 'agent_thought_chunk']; // CLI agent updates that belong under their step; message chunks are the Reply

function apply(s: Transcript, u: any, at?: number): Transcript {
  const items = s.items;
  const kind = u?.hefyn ?? u?.sessionUpdate;
  if (u?.runId && u?.node && NESTED.includes(kind)) {
    const { runId, node, ...inner } = u;
    return { ...s, items: patchRun(items, runId, (r) => patchStep(r, node, (st) => ({ ...st, items: apply({ ...s, items: st.items }, inner).items }))) };
  }
  switch (kind) {
    case 'run_start': return { ...s, busy: true, errored: false, items: patchRun(items, u.runId, (r) => ({ ...r, assistantId: u.assistantId, parentRunId: u.parentRunId ?? r.parentRunId, parentNode: u.parentNode ?? r.parentNode, startedAt: r.startedAt ?? at })) };
    case 'step_start': return { ...s, items: patchRun(items, u.runId, (r) => patchStep(r, u.node, (st) => ({ ...st, label: u.label ?? st.label, type: u.type ?? st.type, status: 'running' }))) };
    case 'step_output': return { ...s, items: patchRun(items, u.runId, (r) => patchStep(r, u.node, (st) => ({ ...st, text: u.text ?? st.text, json: u.json ?? st.json }))) }; // the latest output replaces: a repeat never duplicates
    case 'step_end': return { ...s, items: patchRun(items, u.runId, (r) => patchStep(r, u.node, (st) => ({ ...st, status: u.status ?? 'done', error: u.error ? String(u.error) : st.error }))) };
    case 'waiting': return { ...s, items: patchRun(items, u.runId, (r) => patchStep(r, u.node, (st) => ({ ...st, waiting: { kind: u.kind, message: String(u.message ?? ''), fields: u.fields, editable: u.editable, content: u.content ?? u.text } }))) };
    case 'run_end': {
      const status = u.status === 'failed' || u.status === 'cancelled' ? u.status : 'done';
      const close = (st: RunStep): RunStep => (st.status === 'running' ? { ...st, status: status === 'failed' ? 'failed' : 'skipped' } : st); // nothing runs after the run ended
      const ended = patchRun(items, u.runId, (r) => ({ ...r, status, endedAt: at, steps: r.steps.map(close) }));
      // a sub-run cannot outlive its parent; its own run_end closes it when it ends first (a sub-run's end is not the end of the turn)
      const sub = ended.map((x) => (x.kind === 'run' && x.parentRunId === u.runId && x.status === 'running' ? { ...x, status: status === 'failed' ? 'failed' as const : 'cancelled' as const, endedAt: at, steps: x.steps.map(close) } : x));
      const isSub = items.some((x) => x.kind === 'run' && x.runId === u.runId && x.parentRunId);
      return isSub ? { ...s, items: sub } : { ...s, busy: false, items: closeAsks(sub) };
    }
    case 'user': { // one prompt = one message, never merged
      const via = u.via === 'terminal' ? 'terminal' : undefined, prev = [...items].reverse().find((x) => x.kind === 'user');
      const aside: Item[] = via && prev?.kind === 'user' && prev.via !== 'terminal' ? [{ kind: 'aside' }] : []; // the first prompt typed in the terminal after the chat's own: say where it came from
      return { ...s, items: [...items, ...aside, { kind: 'user', text: String(u.text ?? ''), ...(via && { via }) }] };
    }
    case 'user_message_chunk': return { ...s, items: chunk(items, 'user', textOf(u.content)) };
    case 'agent_message_chunk': return { ...s, items: chunk(items, 'agent', textOf(u.content), u.messageId) };
    case 'agent_thought_chunk': return { ...s, items: chunk(items, 'thought', textOf(u.content), u.messageId) };
    case 'tool_call': {
      const t: Item = { kind: 'tool', id: u.toolCallId, title: u.title ?? 'Working', toolKind: u.kind, status: u.status ?? 'pending', content: contentOf(u.content), rawInput: u.rawInput, rawOutput: u.rawOutput, ...(subOf(u) !== undefined && { sub: subOf(u) }) };
      const i = items.findIndex((x) => x.kind === 'tool' && x.id === u.toolCallId);
      return { ...s, items: i < 0 ? [...items, t] : items.map((x, j) => (j === i ? t : x)) };
    }
    case 'tool_call_update': {
      const i = items.findIndex((x) => x.kind === 'tool' && x.id === u.toolCallId);
      if (i < 0) return s; // an update for a call we never saw (stream started mid-way): nothing to attach to
      const x = items[i] as Extract<Item, { kind: 'tool' }>;
      const next = { ...x, title: u.title ?? x.title, toolKind: u.kind ?? x.toolKind, status: u.status ?? x.status, content: u.content ? contentOf(u.content) : x.content, rawInput: u.rawInput ?? x.rawInput, rawOutput: u.rawOutput ?? x.rawOutput };
      const sub = subOf({ ...u, title: u.title ?? x.title, kind: u.kind ?? x.toolKind, rawInput: u.rawInput ?? x.rawInput }, x.sub);
      if (sub !== undefined) next.sub = sub;
      return { ...s, items: items.map((y, j) => (j === i ? next : y)) };
    }
    case 'plan': { // a plan always replaces the previous one
      const p: Item = { kind: 'plan', entries: u.entries ?? [] }, i = items.map((x) => x.kind).lastIndexOf('plan');
      return { ...s, items: i < 0 ? [...items, p] : items.map((x, j) => (j === i ? p : x)) };
    }
    case 'available_commands_update': return { ...s, commands: u.availableCommands ?? [] };
    case 'permission': return { ...s, items: [...items, { kind: 'permission', requestId: u.requestId, ...(typeof u.toolCall?.toolCallId === 'string' && { toolCallId: u.toolCall.toolCallId }), title: u.toolCall?.title ?? 'a step', options: u.options ?? [], ...(typeof u.by === 'string' && { by: u.by }) }] };
    case 'permission_resolved': {
      const ask = items.find((x) => x.kind === 'permission' && x.requestId === u.requestId) as Extract<Item, { kind: 'permission' }> | undefined;
      const tool = ask?.toolCallId ? items.find((x) => x.kind === 'tool' && x.id === ask.toolCallId) : undefined;
      if (ask && tool) { // the tool row already says what ran: it takes the answer and the question row goes
        const allowed = !!ask.options.find((o) => o.optionId === u.optionId)?.kind.startsWith('allow');
        return { ...s, items: items.filter((x) => x !== ask).map((x) => (x === tool ? { ...x, allowed } : x)) };
      }
      return { ...s, items: deep(items, (x) => (x.kind === 'permission' && x.requestId === u.requestId ? { ...x, answered: { optionId: u.optionId ?? null, ...(u.by === 'claude' && { by: 'claude' }) } } : x)) };
    }
    case 'turn_start': return { ...s, busy: true, out: false, errored: false, items: endMessage(items) };
    case 'turn_end': {
      const note: Item[] = u.stopReason === 'cancelled' ? [{ kind: 'stopped' }] : s.out || s.errored ? [] : [{ kind: 'empty' }]; // an error event already says what happened
      return { ...s, busy: false, items: [...closeAsks(endMessage(items)), ...note] }; // a finished turn has no open question
    }
    case 'status': return { ...s, status: u.state, busy: u.state === 'stopped' ? false : s.busy };
    case 'error': return { ...s, items: [...items, { kind: 'error', message: String(u.message ?? 'Something went wrong.') }], busy: false, status: s.status === 'starting' ? '' : s.status }; // a start that failed is not still starting
    case 'auth_expired': return { ...s, items: [...items, { kind: 'auth', agentId: String(u.agentId), name: String(u.name ?? 'The agent'), reason: u.reason === 'signed_out' ? 'signed_out' : 'expired' }], busy: false };
    default: return s; // current_mode_update and anything newer: not shown
  }
}

/** A sub-agent's events (`agent: <id>`) fold into its own lane, never into the conversation's flow or its busy/out state; `subagent` events keep the list. */
function foldAgent(s: Transcript, u: any, at: number | undefined): Transcript {
  if (u.hefyn === 'subagent') {
    const id = String(u.agentId), old = s.agents.find((a) => a.id === id);
    const next: SubAgent = { id, type: u.type ?? old?.type ?? '', description: u.description ?? old?.description ?? '', status: u.status === 'done' || u.status === 'failed' ? u.status : 'running', startedAt: old?.startedAt ?? at, endedAt: u.status === 'running' ? undefined : at ?? old?.endedAt, toolCallId: u.toolCallId ?? old?.toolCallId };
    return { ...s, agents: old ? s.agents.map((a) => (a === old ? next : a)) : [...s.agents, next], items: next.toolCallId ? s.items.map((x) => (x.kind === 'tool' && x.id === next.toolCallId ? { ...x, agentId: id } : x)) : s.items };
  }
  const { agent, ...inner } = u;
  return { ...s, lanes: { ...s.lanes, [agent]: apply({ ...s, items: s.lanes[agent] ?? [] }, inner).items } };
}

export function fold(s: Transcript, e: CliEvent): Transcript {
  if (e.seq <= s.seq) return s; // already seen (replay after a reconnect)
  const at = Date.parse(e.at ?? '');
  if (e.update?.hefyn === 'subagent' || typeof e.update?.agent === 'string') return { ...foldAgent(s, e.update, Number.isNaN(at) ? undefined : at), seq: e.seq };
  const n = apply(s, e.update, Number.isNaN(at) ? undefined : at), k = e.update?.hefyn ?? e.update?.sessionUpdate;
  return { ...n, seq: e.seq, out: n.out || ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan', 'run_start'].includes(k), errored: n.errored || k === 'error' || k === 'auth_expired' };
}

/** The run's step that waits for the reader, if any: the question is open while its step and run are. */
export const openWait = (items: Item[]) => {
  for (const x of items) if (x.kind === 'run' && x.status === 'running') for (const st of x.steps) if (st.waiting && st.status === 'running') return { run: x, step: st };
  return undefined;
};
/** Any unanswered question (a flow's approval or ask, or a CLI agent's permission), also inside run steps. */
export const hasOpenAsk = (items: Item[]): boolean => !!openWait(items) || items.some((x) => (x.kind === 'permission' && !x.answered) || (x.kind === 'run' && x.steps.some((st) => hasOpenAsk(st.items))));

/** The items for display: a sub-run moves into the step of its parent that started it (the log keeps them flat). One whose parent or step we never saw stays where it is. */
export function nest(items: Item[]): Item[] {
  const runs = items.filter((x): x is Run => x.kind === 'run'), placed = new Set<string>();
  const attach = (r: Run, depth: number): Run => {
    const kids = depth > 5 ? [] : runs.filter((c) => c !== r && c.parentRunId === r.runId && !placed.has(c.runId) && r.steps.some((s) => s.node === c.parentNode));
    kids.forEach((c) => placed.add(c.runId));
    return kids.length ? { ...r, steps: r.steps.map((s) => { const mine = kids.filter((c) => c.parentNode === s.node); return mine.length ? { ...s, items: [...s.items, ...mine.map((c) => attach(c, depth + 1))] } : s; }) } : r;
  };
  const rooted = items.map((x) => (x.kind === 'run' && !(x.parentRunId && runs.some((p) => p.runId === x.parentRunId)) ? attach(x, 0) : x));
  return rooted.filter((x) => !(x.kind === 'run' && placed.has(x.runId)));
}

/** Who is working now, from the log: running flow steps that are agents or Assistants, and sub-agent calls (only while the turn runs: a call left open by a stopped turn is not work). `label` is the innermost running step. */
export function workers(items: Item[], busy: boolean): { label?: string; agents: ActivityAgent[] } {
  const out = new Map<string, ActivityAgent>();
  let label: string | undefined;
  const walk = (list: Item[]) => {
    for (const x of list) {
      if (x.kind === 'tool' && busy && x.sub !== undefined && (x.status === 'in_progress' || x.status === 'pending')) out.set(`agent:${x.sub}`, { name: x.sub, kind: 'agent', state: 'running' });
      if (x.kind === 'run' && x.status === 'running') for (const st of x.steps) if (st.status === 'running') {
        label = st.label;
        if (st.type === 'agent' || st.type === 'assistant') out.set(`${st.type}:${st.label}`, { name: st.label, kind: 'step', state: st.waiting ? 'waiting' : 'running' });
        walk(st.items);
      }
    }
  };
  walk(items);
  return { label, agents: [...out.values()] };
}

/** A compact diff: the unchanged lines at both ends are cut, what is left shows as removed then added. */
export function diffLines(oldText: string | null | undefined, newText: string): { sign: '-' | '+'; text: string }[] {
  const a = oldText ? oldText.split('\n') : [], b = newText.split('\n');
  let h = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) h++;
  let t = 0;
  while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  return [...a.slice(h, a.length - t).map((text) => ({ sign: '-' as const, text })), ...b.slice(h, b.length - t).map((text) => ({ sign: '+' as const, text }))];
}

export type Ask = { ask: Extract<Item, { kind: 'permission' }>; tool?: Extract<Item, { kind: 'tool' }>; agent?: string };
/** Every unanswered permission request of the conversation and of its sub-agents' lanes, once each, in the order they arrived (main chat first); `tool` is the call it asks about. */
export function pendingAsks(s: Transcript): Ask[] {
  const out: Ask[] = [], seen = new Set<string>();
  const scan = (items: Item[], lane?: string) => {
    for (const x of items) {
      if (x.kind === 'run') x.steps.forEach((st) => scan(st.items, lane));
      else if (x.kind === 'permission' && !x.answered && !seen.has(x.requestId)) {
        seen.add(x.requestId);
        const tool = x.toolCallId ? [...items, ...s.items, ...(lane ? [] : Object.values(s.lanes).flat())].find((t): t is Extract<Item, { kind: 'tool' }> => t.kind === 'tool' && t.id === x.toolCallId) : undefined;
        out.push({ ask: x, tool, agent: x.by ?? lane });
      }
    }
  };
  scan(s.items);
  for (const [id, items] of Object.entries(s.lanes)) scan(items, id);
  return out;
}
