// The flow format of docs/ASSISTANTS.md as plain data, plus every pure operation the editor needs (no React, no DOM: tested in test/flow-*.test.ts).

export interface FlowNode { id: string; type: string; label?: string; position: { x: number; y: number }; config: Record<string, any> }
export interface FlowEdge { id: string; from: string; to: string; port?: string }
export interface Flow { version: 1; nodes: FlowNode[]; edges: FlowEdge[]; /** tools turned off in the Tools tab (assistants.tools) */ tools?: { disabled: string[] } }
export interface FlowError { node?: string; edge?: string; message: string }
export interface Port { id?: string; label: string }

export const GROUPS = ['Start', 'Think', 'Decide', 'People', 'Do', 'Finish'] as const;
export interface Meta { label: string; group: (typeof GROUPS)[number]; hint: string; outputs: string[] }
// `outputs` are the fields later steps can name as {{node.field}}.
export const META: Record<string, Meta> = {
  'trigger.chat': { label: 'Chat message', group: 'Start', hint: 'The message someone sends to start the Assistant.', outputs: ['text', 'files'] },
  agent: { label: 'Agent', group: 'Think', hint: 'Ask an AI agent to do a job.', outputs: ['text', 'json'] },
  assistant: { label: 'Assistant', group: 'Think', hint: 'Hand a job to another Assistant.', outputs: ['text'] },
  router: { label: 'Router', group: 'Decide', hint: 'Send the work down one of several paths.', outputs: ['branch'] },
  condition: { label: 'Condition', group: 'Decide', hint: 'Go one way or the other after a simple check.', outputs: ['result'] },
  approval: { label: 'Approval', group: 'People', hint: 'Pause until the person says yes or no.', outputs: ['text'] },
  ask: { label: 'Ask', group: 'People', hint: 'Pause and ask the person a question.', outputs: ['answers'] },
  template: { label: 'Template', group: 'Do', hint: 'Put text together from earlier steps.', outputs: ['text'] },
  code: { label: 'Code', group: 'Do', hint: 'Run a small script in the sandbox, without network.', outputs: ['json', 'text'] },
  tool: { label: 'Tool', group: 'Do', hint: 'Use a tool from a connector.', outputs: ['json'] },
  'output.file': { label: 'Save file', group: 'Do', hint: 'Write a file to the person’s storage.', outputs: ['path'] },
  'output.reply': { label: 'Reply', group: 'Finish', hint: 'Send the answer back in the chat.', outputs: [] },
};
export const metaOf = (type: string): Meta => META[type] ?? { label: type, group: 'Do', hint: '', outputs: [] };

export const OPS = [['equals', 'is equal to'], ['contains', 'contains'], ['matches', 'matches (pattern)'], ['empty', 'is empty'], ['not_empty', 'is not empty'], ['gt', 'is greater than'], ['lt', 'is less than']] as const;
export const UNARY_OPS = ['empty', 'not_empty'];

export const defaultConfig = (type: string): Record<string, any> => {
  switch (type) {
    case 'agent': return { agent: null, model: null, thinking: null, instructions: '', prompt: '', skills: [], history: true, subAgents: [], output: 'text' };
    case 'assistant': return { assistantId: '', prompt: '' };
    case 'router': return { mode: 'ai', branches: [{ id: 'b1', label: 'Branch 1' }, { id: 'b2', label: 'Branch 2' }] };
    case 'condition': return { left: '', op: 'contains', right: '' };
    case 'approval': return { message: '', content: '', editable: false };
    case 'ask': return { question: '', fields: [] };
    case 'template': return { text: '' };
    case 'code': return { language: 'javascript', source: '', timeoutSec: 10 };
    case 'tool': return { connectorId: '', tool: '', args: {} };
    case 'output.reply': return { text: '' };
    case 'output.file': return { path: '', content: '' };
    default: return {};
  }
};

/** The output ports of a node, in drawing order. `id` is what an edge's `port` holds (undefined = the only port). */
export function portsOf(n: Pick<FlowNode, 'type' | 'config'>): Port[] {
  switch (n.type) {
    case 'output.reply': return [];
    case 'condition': return [{ id: 'true', label: 'true' }, { id: 'false', label: 'false' }];
    case 'approval': return [{ id: 'approved', label: 'approved' }, { id: 'rejected', label: 'rejected' }];
    case 'router': return [...((n.config.branches ?? []) as { id: string; label?: string }[]).map((b) => ({ id: b.id, label: b.label || b.id })), { id: 'else', label: 'else' }];
    default: return [{ label: '' }];
  }
}

const clip = (s: unknown, n = 44) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** One short line for the canvas: what the node is set to do. */
export function summary(n: FlowNode): string {
  const c = n.config;
  switch (n.type) {
    case 'agent': return clip(c.instructions) || (c.agent ? String(c.agent) : 'hefyn');
    case 'assistant': return c.assistantId ? String(c.assistantId) : 'Choose an Assistant';
    case 'router': return `${(c.branches ?? []).length} paths, ${c.mode === 'rules' ? 'by rules' : 'chosen by AI'}`;
    case 'condition': return clip(`${c.left} ${c.op} ${UNARY_OPS.includes(c.op) ? '' : c.right}`);
    case 'approval': return clip(c.message);
    case 'ask': return clip(c.question);
    case 'template': return clip(c.text);
    case 'code': return `${c.language ?? 'javascript'}, ${clip(c.source, 30)}`.replace(/, $/, '');
    case 'tool': return c.tool ? `${c.connectorId}: ${c.tool}` : 'Choose a tool';
    case 'output.reply': return clip(c.text);
    case 'output.file': return clip(c.path);
    default: return '';
  }
}

export const emptyFlow = (): Flow => ({ version: 1, nodes: [], edges: [] });
const byId = (f: Flow, id: string) => f.nodes.find((n) => n.id === id);
const BASE: Record<string, string> = { 'trigger.chat': 'start', 'output.reply': 'reply', 'output.file': 'file' };
export function newId(f: Flow, type: string): string {
  const base = BASE[type] ?? type.replace(/[^a-z0-9]/g, '');
  const taken = new Set(f.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}
const newEdgeId = (f: Flow) => { const t = new Set(f.edges.map((e) => e.id)); for (let i = 1; ; i++) if (!t.has(`e${i}`)) return `e${i}`; };

/** Adds a node (a second trigger is refused). Without a position it goes right of the rightmost node. */
export function addNode(f: Flow, type: string, position?: { x: number; y: number }): { flow: Flow; id?: string } {
  if (!META[type] || (type === 'trigger.chat' && f.nodes.some((n) => n.type === type))) return { flow: f };
  const id = newId(f, type);
  const config = defaultConfig(type);
  const trigger = f.nodes.find((n) => n.type === 'trigger.chat');
  if (trigger && 'prompt' in config) config.prompt = `{{${trigger.id}.text}}`;
  const right = f.nodes.reduce((m, n) => Math.max(m, n.position.x), -LAYER_GAP);
  const at = position ?? { x: right + LAYER_GAP, y: 0 };
  return { flow: { ...f, nodes: [...f.nodes, { id, type, position: { x: Math.round(at.x), y: Math.round(at.y) }, config }] }, id };
}

export const removeEdge = (f: Flow, id: string): Flow => ({ ...f, edges: f.edges.filter((e) => e.id !== id) });
/** Removes a node and every edge that touches it. */
export const removeNode = (f: Flow, id: string): Flow => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) });
export const moveNode = (f: Flow, id: string, x: number, y: number): Flow => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, position: { x: Math.round(x), y: Math.round(y) } } : n)) });
export const setLabel = (f: Flow, id: string, label: string): Flow => ({ ...f, nodes: f.nodes.map((n) => { if (n.id !== id) return n; const { label: _l, ...rest } = n; return label ? { ...rest, label } : rest; }) });
/** Merges `patch` into a node's config; edges that leave through a port the node no longer has (a deleted branch) are dropped. */
export function setConfig(f: Flow, id: string, patch: Record<string, any>): Flow {
  const nodes = f.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n));
  const node = nodes.find((n) => n.id === id);
  const ports = node ? new Set(portsOf(node).map((p) => p.id)) : new Set();
  return { ...f, nodes, edges: f.edges.filter((e) => e.from !== id || ports.has(e.port)) };
}

const reaches = (f: Flow, from: string, to: string): boolean => {
  const seen = new Set<string>(), stack = [from];
  while (stack.length) { const x = stack.pop()!; if (x === to) return true; if (seen.has(x)) continue; seen.add(x); for (const e of f.edges) if (e.from === x) stack.push(e.to); }
  return false;
};
/** Why not: a self loop, a second trigger input, an unknown port, a repeat, or a cycle (v1 flows are acyclic). */
export function canConnect(f: Flow, from: string, port: string | undefined, to: string): boolean {
  const a = byId(f, from), b = byId(f, to);
  if (!a || !b || from === to || b.type === 'trigger.chat') return false;
  if (!portsOf(a).some((p) => p.id === port)) return false;
  if (f.edges.some((e) => e.from === from && e.to === to && e.port === port)) return false;
  return !reaches(f, to, from);
}
/** Connects an output port to a node; returns the same flow object when the connection is not allowed. */
export function connect(f: Flow, from: string, port: string | undefined, to: string): Flow {
  if (!canConnect(f, from, port, to)) return f;
  const src = byId(f, from), dst = byId(f, to);
  // an Approval's "what they review" starts as the text of the step it is first connected from
  const nodes = dst?.type === 'approval' && !dst.config.content && src && metaOf(src.type).outputs.includes('text') ? f.nodes.map((n) => (n.id === to ? { ...n, config: { ...n.config, content: `{{${from}.text}}` } } : n)) : f.nodes;
  return { ...f, nodes, edges: [...f.edges, { id: newEdgeId(f), from, to, ...(port !== undefined && { port }) }] };
}

export const LAYER_GAP = 380, ROW_GAP = 190;
/** Simple left-to-right layers: a node sits one layer right of its deepest parent; rows follow the parents' average row. */
export function layout(f: Flow): Flow {
  const depth = new Map<string, number>();
  const parents = (id: string) => f.edges.filter((e) => e.to === id).map((e) => e.from);
  const left = new Set(f.nodes.map((n) => n.id));
  for (let guard = 0; left.size && guard <= f.nodes.length; guard++) {
    for (const id of [...left]) {
      const ps = parents(id).filter((p) => byId(f, p));
      if (ps.every((p) => depth.has(p))) { depth.set(id, ps.length ? Math.max(...ps.map((p) => depth.get(p)!)) + 1 : 0); left.delete(id); }
    }
  }
  for (const id of left) depth.set(id, 0); // only reachable with a cycle, which validation rejects anyway
  const layers: string[][] = [];
  for (const n of [...f.nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)) (layers[depth.get(n.id)!] ??= []).push(n.id);
  const row = new Map<string, number>();
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, x) => {
    if (!ids) return;
    const key = (id: string) => { const ps = parents(id).filter((p) => row.has(p)); return ps.length ? ps.reduce((s, p) => s + row.get(p)!, 0) / ps.length : 0; };
    const sorted = x === 0 ? ids : [...ids].sort((a, b) => key(a) - key(b));
    sorted.forEach((id, i) => { const r = i - (sorted.length - 1) / 2; row.set(id, r); pos.set(id, { x: x * LAYER_GAP, y: Math.round(r * ROW_GAP) }); });
  });
  return { ...f, nodes: f.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}

// ---- Clipboard, insert, align: the pure side of the right-click menus ----
export interface Clip { hefynSteps: 1; nodes: FlowNode[]; edges: FlowEdge[] }
const REF = /\{\{(\s*)([a-z][a-z0-9_]*)(?=[.\s}])/g;
/** Renames the node part of every {{node.field}} in every string of `v` that names a key of `map`. */
const remapRefs = (v: unknown, map: Map<string, string>): unknown => {
  if (typeof v === 'string') return v.replace(REF, (m, sp: string, id: string) => (map.has(id) ? `{{${sp}${map.get(id)}` : m));
  if (Array.isArray(v)) return v.map((x) => remapRefs(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapRefs(x, map)]));
  return v;
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** The chosen nodes and the edges between them, as a detached copy. */
export function copyNodes(f: Flow, ids: string[]): Clip {
  const set = new Set(ids);
  return clone({ hefynSteps: 1 as const, nodes: f.nodes.filter((n) => set.has(n.id)), edges: f.edges.filter((e) => set.has(e.from) && set.has(e.to)) });
}
/** Parses what the system clipboard held; null when it is not a copy of steps. */
export function parseClip(text: string): Clip | null {
  try { const c = JSON.parse(text); return c?.hefynSteps === 1 && Array.isArray(c.nodes) && Array.isArray(c.edges) ? c : null; } catch { return null; }
}
/** Adds a clip with fresh node and edge ids; templates of the copies that name another copy follow the new ids. The top-left lands on `at` (default: 40 px down-right of where it was). A trigger is skipped when the flow has one. */
export function pasteClip(f: Flow, clip: Clip, at?: { x: number; y: number }): { flow: Flow; ids: string[] } {
  const keep = clip.nodes.filter((n) => n.type !== 'trigger.chat' || !f.nodes.some((x) => x.type === n.type));
  if (!keep.length) return { flow: f, ids: [] };
  const minX = Math.min(...keep.map((n) => n.position.x)), minY = Math.min(...keep.map((n) => n.position.y));
  const dx = at ? at.x - minX : 40, dy = at ? at.y - minY : 40;
  const map = new Map<string, string>();
  let nodes = f.nodes;
  for (const n of keep) { // a copy of "draft" is "draft2": the name people chose stays recognisable
    const taken = new Set(nodes.map((x) => x.id)), stem = n.id.replace(/\d+$/, '').slice(0, 28) || n.type.replace(/[^a-z]/g, '');
    let id = stem, i = 2;
    while (taken.has(id)) id = `${stem}${i++}`;
    map.set(n.id, id); nodes = [...nodes, { ...n, id, position: { x: 0, y: 0 } }];
  }
  const added = keep.map((n): FlowNode => ({
    ...clone(n), id: map.get(n.id)!, position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) },
    // a code step's source is code, not a template: its `{{` is not a reference
    config: n.type === 'code' ? clone(n.config) : (remapRefs(clone(n.config), map) as Record<string, any>),
  }));
  let g: Flow = { ...f, nodes: [...f.nodes, ...added] };
  for (const e of clip.edges) if (map.has(e.from) && map.has(e.to)) g = { ...g, edges: [...g.edges, { id: newEdgeId(g), from: map.get(e.from)!, to: map.get(e.to)!, ...(e.port !== undefined && { port: e.port }) }] };
  return { flow: g, ids: added.map((n) => n.id) };
}
export const duplicateNodes = (f: Flow, ids: string[]) => pasteClip(f, copyNodes(f, ids));
/** Removes every edge that touches the node. */
export const disconnectNode = (f: Flow, id: string): Flow => ({ ...f, edges: f.edges.filter((e) => e.from !== id && e.to !== id) });

/** Puts a new node on an edge: from -> new -> to. Same flow back when it cannot be (a node with no input or no output, a second trigger). */
export function insertOnEdge(f: Flow, edgeId: string, type: string, at?: { x: number; y: number }): { flow: Flow; id?: string } {
  const e = f.edges.find((x) => x.id === edgeId), a = e && byId(f, e.from), b = e && byId(f, e.to);
  if (!e || !a || !b || type === 'trigger.chat') return { flow: f };
  const out = portsOf({ type, config: defaultConfig(type) })[0];
  if (!out) return { flow: f };
  const mid = at ?? { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 };
  const added = addNode(removeEdge(f, edgeId), type, mid);
  if (!added.id) return { flow: f };
  const g = connect(connect(added.flow, e.from, e.port, added.id), added.id, out.id, e.to);
  return g.edges.length === added.flow.edges.length + 2 ? { flow: g, id: added.id } : { flow: f };
}
/** Adds a node to the right of `from` and connects `port` (default: the first unused output) to it. */
export function addAfter(f: Flow, from: string, type: string, port?: string): { flow: Flow; id?: string } {
  const n = byId(f, from);
  if (!n || type === 'trigger.chat') return { flow: f };
  const ports = portsOf(n);
  const p = port ?? (ports.find((x) => !f.edges.some((e) => e.from === from && e.port === x.id))?.id ?? ports[0]?.id);
  if (!ports.length) return { flow: f };
  const kids = f.edges.filter((e) => e.from === from).length;
  const added = addNode(f, type, { x: n.position.x + LAYER_GAP, y: n.position.y + kids * ROW_GAP });
  if (!added.id) return { flow: f };
  return { flow: connect(added.flow, from, p, added.id), id: added.id };
}

/** Lines the chosen nodes up on their leftmost x / topmost y. */
export function align(f: Flow, ids: string[], edge: 'left' | 'top'): Flow {
  const set = new Set(ids), ns = f.nodes.filter((n) => set.has(n.id));
  if (ns.length < 2) return f;
  const k = edge === 'left' ? 'x' : 'y', v = Math.min(...ns.map((n) => n.position[k]));
  return { ...f, nodes: f.nodes.map((n) => (set.has(n.id) ? { ...n, position: { ...n.position, [k]: v } } : n)) };
}
/** Spaces the chosen nodes evenly between the two outermost ones along an axis (three or more). */
export function distribute(f: Flow, ids: string[], axis: 'x' | 'y'): Flow {
  const set = new Set(ids), ns = f.nodes.filter((n) => set.has(n.id)).sort((a, b) => a.position[axis] - b.position[axis]);
  if (ns.length < 3) return f;
  const first = ns[0]!.position[axis], step = (ns.at(-1)!.position[axis] - first) / (ns.length - 1);
  const to = new Map(ns.map((n, i) => [n.id, Math.round(first + step * i)]));
  return { ...f, nodes: f.nodes.map((n) => (to.has(n.id) ? { ...n, position: { ...n.position, [axis]: to.get(n.id)! } } : n)) };
}

// ---- Trying a step ----
export const TESTABLE = ['code', 'template', 'condition'];
export const canTest = (n: Pick<FlowNode, 'type' | 'config'>) => TESTABLE.includes(n.type) || (n.type === 'router' && n.config.mode === 'rules');
const SAMPLE: Record<string, unknown> = { text: 'Hello', files: [], json: {}, branch: 'else', result: true, answers: {}, path: 'file.txt' };
const stringsOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsOf) : v && typeof v === 'object' ? Object.values(v).flatMap(stringsOf) : []);
/** A sample `{ nodeId: output }` to try a step with: the nodes its templates name (a code step: every earlier step), each with a made-up value per output field. */
export function sampleInput(f: Flow, id: string): Record<string, unknown> {
  const n = byId(f, id);
  if (!n) return {};
  const names = new Set<string>();
  if (n.type === 'code') for (const u of upstream(f, id)) names.add(u.id);
  else for (const s of stringsOf(n.config)) for (const m of s.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\.([a-z]+)/g)) names.add(m[1]!);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const t = byId(f, name);
    if (!t) { out[name] = { text: SAMPLE.text }; continue; }
    const fields = metaOf(t.type).outputs;
    const o: Record<string, unknown> = {};
    for (const k of fields) o[k] = SAMPLE[k];
    // a template may name a field the type does not list (a path into json): keep what it names too
    for (const s of stringsOf(n.config)) for (const m of s.matchAll(new RegExp(`\\{\\{\\s*${name}\\.([a-z]+)`, 'g'))) o[m[1]!] ??= SAMPLE[m[1]!] ?? 'sample';
    out[name] = o;
  }
  return out;
}

/** Starter code that follows the engine's contract (docs/ASSISTANTS.md, code): JSON `{input, steps}` on stdin, JSON on stdout. */
export const STARTERS: Record<string, string> = {
  javascript: `// Reads {"input": {"text", "files"}, "steps": {"<step id>": <its output>}} from stdin, prints JSON to stdout.
const fs = require('node:fs');
const { input, steps } = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');

const result = { shout: String(input?.text ?? '').toUpperCase() };
console.log(JSON.stringify(result));
`,
  python: `# Reads {"input": {"text", "files"}, "steps": {"<step id>": <its output>}} from stdin, prints JSON to stdout.
import json
import sys

data = json.load(sys.stdin)
text = (data.get("input") or {}).get("text", "")

print(json.dumps({"shout": text.upper()}))
`,
};

/** `outputs` are the field names; `fields` the known keys inside `json` (an agent's JSON schema), for suggestions. */
export interface Upstream { id: string; label: string; type: string; refs: string[]; outputs?: string[]; fields?: string[] }
const schemaKeys = (s: unknown): string[] => {
  try { const p = (typeof s === 'string' ? JSON.parse(s) : s) as { properties?: Record<string, unknown> } | null; return p?.properties && typeof p.properties === 'object' ? Object.keys(p.properties) : []; } catch { return []; }
};
/** Steps that can run before `id` (everything with a path to it) and the {{node.field}} each offers. Only these may be named in a template. */
export function upstream(f: Flow, id: string): Upstream[] {
  const seen = new Set<string>(), stack = [id];
  while (stack.length) { const x = stack.pop()!; for (const e of f.edges) if (e.to === x && !seen.has(e.from)) { seen.add(e.from); stack.push(e.from); } }
  seen.delete(id);
  return f.nodes.filter((n) => seen.has(n.id) && metaOf(n.type).outputs.length)
    .map((n) => ({ id: n.id, label: n.label || metaOf(n.type).label, type: n.type, refs: metaOf(n.type).outputs.map((o) => `{{${n.id}.${o}}}`), outputs: metaOf(n.type).outputs, ...(n.type === 'agent' && n.config.output === 'json' && { fields: schemaKeys(n.config.schema) }) }));
}

export interface Suggestion { /** what is inserted after `{{`, e.g. `draft.text` */ label: string; display: string; detail: string }
/** What to offer after `{{` given the text before the caret: earlier steps only; after `node.` that step's fields (and the keys of its JSON schema). Null when the caret is not inside a `{{`. */
export function suggest(refs: Upstream[], before: string): { from: number; options: Suggestion[] } | null {
  const m = /\{\{\s*([A-Za-z0-9_.]*)$/.exec(before);
  if (!m) return null;
  const word = m[1]!, from = before.length - word.length, dot = word.indexOf('.');
  const of = (u: Upstream): Suggestion[] => (u.outputs ?? []).flatMap((o) => [
    { label: `${u.id}.${o}`, display: `${u.label} → ${o}`, detail: o },
    ...(o === 'json' ? (u.fields ?? []).map((k) => ({ label: `${u.id}.json.${k}`, display: `${u.label} → ${k}`, detail: 'json field' })) : []),
  ]);
  if (dot < 0) return { from, options: refs.flatMap(of) };
  const node = refs.find((u) => u.id === word.slice(0, dot));
  return { from, options: node ? of(node) : [] };
}
/** `{{node.field}}` references in `text` that name a step which is not in `ids` (a step that cannot have run before). */
export function badRefs(text: string, ids: string[]): { from: number; to: number; id: string }[] {
  const out: { from: number; to: number; id: string }[] = [];
  for (const m of text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)(?=[.\s}])[^{}\n]*\}\}/g)) if (!ids.includes(m[1]!)) out.push({ from: m.index!, to: m.index! + m[0].length, id: m[1]! });
  return out;
}
/** Text with `ins` put where the caret / selection was. */
export const insertAt = (text: string, start: number, end: number, ins: string) => ({ text: text.slice(0, start) + ins + text.slice(end), caret: start + ins.length });

// ---- Simple view: trigger.chat -> agent -> output.reply ----
export interface SimpleFields { agent: string | null; /** the model provider of a CLI agent; unset = the agent's own API's */ provider?: string | null; model: string | null; thinking: string | null; instructions: string; skills: string[]; subAgents: any[] }
export const SIMPLE_KEYS: (keyof SimpleFields)[] = ['agent', 'provider', 'model', 'thinking', 'instructions', 'skills', 'subAgents'];

const simpleAgent = (f: Flow): FlowNode | null => {
  if (f.nodes.length !== 3 || f.edges.length !== 2) return null;
  const t = f.nodes.find((n) => n.type === 'trigger.chat'), a = f.nodes.find((n) => n.type === 'agent'), r = f.nodes.find((n) => n.type === 'output.reply');
  if (!t || !a || !r) return null;
  const has = (from: string, to: string) => f.edges.some((e) => e.from === from && e.to === to && e.port === undefined);
  return has(t.id, a.id) && has(a.id, r.id) ? a : null;
};
export const isSimple = (f: Flow) => simpleAgent(f) !== null;
/** The Simple form's fields, or null when the flow has anything else in it. */
export function toSimple(f: Flow): SimpleFields | null {
  const a = simpleAgent(f);
  if (!a) return null;
  const c = { ...defaultConfig('agent'), ...a.config };
  return { agent: c.agent ?? null, provider: c.provider || null, model: c.model || null, thinking: c.thinking || null, instructions: c.instructions ?? '', skills: c.skills ?? [], subAgents: c.subAgents ?? [] };
}
/** Writes Simple fields back: into the agent node of a simple flow (its prompt, history and position stay), or into a fresh simple flow. */
export function fromSimple(f: Flow | null, s: Partial<SimpleFields>): Flow {
  const a = f && simpleAgent(f);
  if (f && a) return setConfig(f, a.id, s);
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'trigger.chat', position: { x: 0, y: 0 }, config: {} },
      { id: 'draft', type: 'agent', label: 'Draft the reply', position: { x: LAYER_GAP, y: 0 }, config: { ...defaultConfig('agent'), prompt: '{{start.text}}', ...s } },
      { id: 'reply', type: 'output.reply', position: { x: LAYER_GAP * 2, y: 0 }, config: { text: '{{draft.text}}' } },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'draft' }, { id: 'e2', from: 'draft', to: 'reply' }],
  };
}
