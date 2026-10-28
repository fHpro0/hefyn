// The flow format of an Assistant (old/docs/ASSISTANTS.md; only the simple shape is used now): types, the simple shape, templates and the structural checks. Pure: no database, so appdb.ts can migrate with it.

export interface FlowNode { id: string; type: string; label?: string; position: { x: number; y: number }; config: Record<string, any> }
export interface FlowEdge { id: string; from: string; to: string; port?: string }
/** `tools.disabled`: ids of tools this Assistant has turned off (src/agents/tool-filter.ts). Everything is on unless listed. */
export interface Flow { version: 1; nodes: FlowNode[]; edges: FlowEdge[]; tools?: { disabled: string[] } }
export interface FlowError { node?: string; edge?: string; message: string }
export interface SubAgent { name: string; description: string; model?: string | null; thinking?: string | null; instructions: string; skills: { name: string; description: string; instructions: string }[] }

export const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const LIMITS = { nodes: 100, edges: 300, branches: 10, source: 50_000, timeoutSec: 300 };
export const OPS = ['equals', 'contains', 'matches', 'empty', 'not_empty', 'gt', 'lt'] as const;

export interface NodeType { type: string; label: string; description: string; kind: 'trigger' | 'step' | 'output'; ports: string[] | 'branches' }
export const NODE_TYPES: NodeType[] = [
  { type: 'trigger.chat', label: 'Chat message', description: 'The message (and files) the person sends.', kind: 'trigger', ports: ['out'] },
  { type: 'agent', label: 'Agent', description: 'Ask hefyn or an installed agent to do a task.', kind: 'step', ports: ['out'] },
  { type: 'assistant', label: 'Assistant', description: 'Run another Assistant and use its answer.', kind: 'step', ports: ['out'] },
  { type: 'router', label: 'Router', description: 'Send the flow down one of several branches.', kind: 'step', ports: 'branches' },
  { type: 'condition', label: 'Condition', description: 'Yes/no: compare two values.', kind: 'step', ports: ['true', 'false'] },
  { type: 'approval', label: 'Approval', description: 'Pause until the person approves or rejects.', kind: 'step', ports: ['approved', 'rejected'] },
  { type: 'ask', label: 'Ask', description: 'Pause and ask the person a question.', kind: 'step', ports: ['out'] },
  { type: 'template', label: 'Text', description: 'Build text from earlier steps.', kind: 'step', ports: ['out'] },
  { type: 'code', label: 'Code', description: 'Run JavaScript or Python in your sandbox (no network).', kind: 'step', ports: ['out'] },
  { type: 'tool', label: 'Tool', description: 'Call a tool of a connector.', kind: 'step', ports: ['out'] },
  { type: 'output.reply', label: 'Reply', description: 'Show text as the Assistant\'s answer.', kind: 'output', ports: [] },
  { type: 'output.file', label: 'Write file', description: 'Save a file to your files.', kind: 'output', ports: ['out'] },
];
const TYPE = new Map(NODE_TYPES.map((t) => [t.type, t]));
export const isKnownType = (t: string) => TYPE.has(t);

/** The ports a node leaves through. */
export function portsOf(n: FlowNode): string[] {
  const t = TYPE.get(n.type);
  if (!t) return [];
  if (t.ports !== 'branches') return t.ports;
  return [...(Array.isArray(n.config?.branches) ? n.config.branches.map((b: any) => String(b?.id)) : []), 'else'];
}
/** Does the node have one unnamed port (so an edge may omit it)? */
export const singlePort = (n: FlowNode) => { const p = portsOf(n); return p.length === 1 && p[0] === 'out'; };

// ---- the simple shape: trigger.chat -> agent -> output.reply ----
export const emptyAgent = (): Record<string, any> => ({ agent: null, model: null, thinking: null, instructions: '', prompt: '{{start.text}}', skills: [], history: true, subAgents: [], output: 'text' });
export function simpleFlow(c: { agent?: string | null; model?: string | null; thinking?: string | null; instructions?: string; skills?: string[]; subAgents?: SubAgent[] }): Flow {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'trigger.chat', position: { x: 0, y: 0 }, config: {} },
      { id: 'agent', type: 'agent', label: 'Answer', position: { x: 260, y: 0 }, config: { ...emptyAgent(), agent: c.agent ?? null, model: c.model ?? null, thinking: c.thinking ?? null, instructions: c.instructions ?? '', skills: c.skills ?? [], subAgents: c.subAgents ?? [] } },
      { id: 'reply', type: 'output.reply', position: { x: 520, y: 0 }, config: { text: '{{agent.text}}' } },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'agent' }, { id: 'e2', from: 'agent', to: 'reply' }],
  };
}
/** Is the flow exactly trigger -> one plain agent -> reply of that agent's text? Then the editor's Simple view applies and chats use the classic paths. */
export function isSimple(f: Flow | undefined | null): boolean {
  if (!f || !Array.isArray(f.nodes) || f.nodes.length !== 3 || f.edges.length !== 2) return false;
  const t = f.nodes.find((n) => n.type === 'trigger.chat'), a = f.nodes.find((n) => n.type === 'agent'), r = f.nodes.find((n) => n.type === 'output.reply');
  if (!t || !a || !r) return false;
  const has = (from: string, to: string) => f.edges.some((e) => e.from === from && e.to === to && (e.port === undefined || e.port === 'out'));
  return has(t.id, a.id) && has(a.id, r.id) && a.config.prompt === `{{${t.id}.text}}` && r.config.text === `{{${a.id}.text}}` && (a.config.output ?? 'text') === 'text';
}
/** The agent node of a simple flow. */
export const simpleAgent = (f: Flow) => f.nodes.find((n) => n.type === 'agent')!;

// ---- templates ----
const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;
const REF_OK = /^([a-z][a-z0-9_]{0,31})((?:\.[A-Za-z0-9_]+)+)$/;
/** `{{node.field.path}}` references in a text (malformed ones come back with `node: undefined`). */
export function refsOf(text: string): { node?: string; raw: string }[] {
  const out: { node?: string; raw: string }[] = [];
  for (const m of text.matchAll(REF)) out.push({ raw: m[0], node: REF_OK.exec(m[1]!)?.[1] });
  return out;
}
const pick = (o: unknown, path: string[]): unknown => { let v: any = o; for (const k of path) { if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined; v = v[k]; } return v; };
/** Renders a template; a skipped or unknown node, or a missing field, renders empty. Objects render as JSON. Single pass: values are never rendered again. */
export function render(text: string, outputs: Record<string, Record<string, unknown> | undefined>): string {
  return String(text ?? '').replace(REF, (all, ref: string) => {
    const m = REF_OK.exec(ref);
    if (!m) return all;
    const v = pick(outputs[m[1]!], m[2]!.slice(1).split('.'));
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** The template fields of a node: [field label, text] pairs. */
export function templatesOf(n: FlowNode): [string, string][] {
  const c = n.config ?? {}, s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (n.type) {
    case 'agent': case 'assistant': return [['prompt', s(c.prompt)]];
    case 'router': return [['input', s(c.input)], ...((Array.isArray(c.branches) ? c.branches : []) as any[]).flatMap((b, i): [string, string][] => (b?.rule ? [[`branch ${i + 1} left`, s(b.rule.left)], [`branch ${i + 1} right`, s(b.rule.right)]] : []))];
    case 'condition': return [['left', s(c.left)], ['right', s(c.right)]];
    case 'approval': return [['content', s(c.content)], ['message', s(c.message)]];
    case 'ask': return [['question', s(c.question)]];
    case 'template': return [['text', s(c.text)]];
    case 'tool': return Object.entries(c.args && typeof c.args === 'object' ? c.args : {}).map(([k, v]): [string, string] => [`argument ${k}`, s(v)]);
    case 'output.reply': return [['text', s(c.text)]];
    case 'output.file': return [['path', s(c.path)], ['content', s(c.content)]];
    default: return [];
  }
}

/** The structural checks: shape, ids, ports, cycles, connectivity and template references to ancestors. Availability of agents/models/... is validate.ts. */
export function checkGraph(raw: unknown): { errors: FlowError[]; flow?: Flow; ancestors?: Map<string, Set<string>>; order?: string[] } {
  const errors: FlowError[] = [];
  const f = raw as Flow;
  if (!f || typeof f !== 'object' || f.version !== 1 || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) return { errors: [{ message: 'The flow is not in a format hefyn understands.' }] };
  if (f.nodes.length > LIMITS.nodes) errors.push({ message: `A flow can have at most ${LIMITS.nodes} steps.` });
  if (f.edges.length > LIMITS.edges) errors.push({ message: `A flow can have at most ${LIMITS.edges} connections.` });
  if (errors.length) return { errors };
  const byId = new Map<string, FlowNode>();
  for (const n of f.nodes) {
    if (!n || typeof n.id !== 'string' || !NODE_ID.test(n.id)) { errors.push({ message: `"${String((n as any)?.id)}" is not a valid step id (lower-case letters, digits and _, starting with a letter).` }); continue; }
    if (byId.has(n.id)) { errors.push({ node: n.id, message: `Two steps have the id "${n.id}".` }); continue; }
    if (!TYPE.has(n.type)) { errors.push({ node: n.id, message: `"${label(n)}" has an unknown type (${String(n.type)}).` }); }
    if (!n.config || typeof n.config !== 'object' || Array.isArray(n.config)) { errors.push({ node: n.id, message: `"${label(n)}" has no settings.` }); n.config = {}; }
    byId.set(n.id, n);
  }
  const triggers = f.nodes.filter((n) => n?.type === 'trigger.chat');
  if (triggers.length !== 1) errors.push({ message: triggers.length ? 'A flow can have only one Chat message step.' : 'A flow needs a Chat message step to start from.' });
  if (!f.nodes.some((n) => n?.type === 'output.reply')) errors.push({ message: 'A flow needs a Reply step, so the person gets an answer.' });

  const seenEdges = new Set<string>(), incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  for (const e of f.edges) {
    if (!e || typeof e.id !== 'string' || seenEdges.has(e.id)) { errors.push({ edge: String((e as any)?.id), message: 'Two connections have the same id.' }); continue; }
    seenEdges.add(e.id);
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) { errors.push({ edge: e.id, message: 'A connection points to a step that does not exist.' }); continue; }
    const ports = portsOf(from);
    if (e.port === undefined || e.port === null) { if (!singlePort(from)) errors.push({ edge: e.id, node: from.id, message: `Choose which exit of "${label(from)}" this connection leaves from.` }); }
    else if (!ports.includes(e.port)) errors.push({ edge: e.id, node: from.id, message: `"${label(from)}" has no exit "${e.port}".` });
    if (!ports.length) errors.push({ edge: e.id, node: from.id, message: `"${label(from)}" ends the flow; nothing can follow it.` });
    if (to.type === 'trigger.chat') errors.push({ edge: e.id, node: to.id, message: 'Nothing can lead into the Chat message step.' });
    (incoming.get(to.id) ?? incoming.set(to.id, []).get(to.id)!).push(from.id);
    (outgoing.get(from.id) ?? outgoing.set(from.id, []).get(from.id)!).push(to.id);
  }
  if (errors.length) return { errors };

  // cycles (Kahn) and the order
  const indeg = new Map([...byId.keys()].map((id) => [id, incoming.get(id)?.length ?? 0]));
  const queue = [...byId.keys()].filter((id) => !indeg.get(id)), order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of outgoing.get(id) ?? []) { indeg.set(t, indeg.get(t)! - 1); if (!indeg.get(t)) queue.push(t); }
  }
  if (order.length !== byId.size) {
    const stuck = [...byId.values()].filter((n) => !order.includes(n.id));
    return { errors: [{ node: stuck[0]!.id, message: `The steps ${stuck.map((n) => `"${label(n)}"`).join(', ')} lead back into themselves. Flows cannot loop.` }] };
  }
  for (const n of f.nodes) if (n.type !== 'trigger.chat' && !incoming.has(n.id)) errors.push({ node: n.id, message: `"${label(n)}" is not connected to anything before it, so it would never run.` });

  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const s = new Set<string>();
    for (const p of incoming.get(id) ?? []) { s.add(p); for (const a of ancestors.get(p)!) s.add(a); }
    ancestors.set(id, s);
  }
  for (const n of f.nodes) for (const [field, text] of templatesOf(n)) for (const r of refsOf(text)) {
    if (!r.node) errors.push({ node: n.id, message: `${r.raw} in "${label(n)}" (${field}) is not a valid reference. Use {{step.field}}, for example {{${triggers[0]?.id ?? 'start'}.text}}.` });
    else if (!byId.has(r.node)) errors.push({ node: n.id, message: `${r.raw} in "${label(n)}" (${field}) names a step that does not exist.` });
    else if (!ancestors.get(n.id)!.has(r.node)) errors.push({ node: n.id, message: `${r.raw} in "${label(n)}" (${field}) names "${label(byId.get(r.node)!)}", which cannot have run before this step.` });
  }
  return { errors, flow: f, ancestors, order };
}
/** What a step is called to a person: its own label, else the palette name of its type (never the raw id unless the type is unknown). */
export const label = (n: FlowNode) => (typeof n.label === 'string' && n.label ? n.label : TYPE.get(n.type)?.label ?? n.id);
