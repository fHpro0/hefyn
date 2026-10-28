import { type Flow, type FlowEdge, type FlowNode, checkGraph, label, render } from './flow.ts';

// The flow engine (docs/ASSISTANTS.md "Running"). Pure with respect to the outside world: models, the sandbox, connectors, files and persistence come in as `Deps`, so the engine is
// tested without any of them. A run is a state object (sealed at rest by runs.ts): which nodes are settled with what output, and where it waits. Settled nodes are never run again,
// so a run that waited survives a restart: `answer()` loads the state and continues.

export const MAX_DEPTH = 4;
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export interface NodeState { status: 'done' | 'skipped' | 'failed' | 'waiting'; output?: Record<string, unknown>; /** the ports an edge may leave through (done only) */ ports?: string[]; error?: string }
export interface Pending { node: string; kind: 'approval' | 'ask'; message: string; fields?: unknown[]; editable?: boolean; /** approval: what is reviewed */ content?: string }
export interface RunState {
  flow: Flow; input: { text: string; files: unknown[] }; /** the chat so far, as text, for agents that want it */ history: string;
  nodes: Record<string, NodeState>; chain: string[]; depth: number; replies: string[]; pending?: Pending; error?: string;
}
export interface Run { id: string; conversationId: string; assistantId: string; version: number; status: RunStatus; state: RunState; quiet?: boolean }

export interface AgentRequest { node: FlowNode; prompt: string; history: string; /** what the answer must be, for a JSON step */ json: boolean }
export interface Deps {
  signal: AbortSignal;
  /** A run event (the engine adds `runId`). */
  emit(update: Record<string, unknown>): void;
  save(run: Run): void;
  agent(runId: string, r: AgentRequest): Promise<string>;
  /** A small model call (router): no tools, no history. */
  model(runId: string, r: { system: string; prompt: string; model?: string | null }): Promise<string>;
  code(r: { language: 'javascript' | 'python'; source: string; stdin: string; timeoutSec: number; node: string }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>;
  tool(r: { connectorId: string; tool: string; args: Record<string, string> }): Promise<unknown>;
  file(r: { path: string; content: string }): Promise<string>;
  /** Another Assistant, if the user may run it. */
  assistant(id: string): { id: string; name: string; version: number; flow: Flow } | undefined;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (m: string): never => { throw new Error(m); };

export function newRun(o: { id: string; conversationId: string; assistantId: string; version: number; flow: Flow; text: string; files?: unknown[]; history?: string; chain?: string[]; depth?: number; quiet?: boolean }): Run {
  return { id: o.id, conversationId: o.conversationId, assistantId: o.assistantId, version: o.version, status: 'running', quiet: o.quiet,
    state: { flow: o.flow, input: { text: o.text, files: o.files ?? [] }, history: o.history ?? '', nodes: {}, chain: o.chain ?? [o.assistantId], depth: o.depth ?? 0, replies: [] } };
}

/** The outputs templates read: node id -> output (skipped and unfinished nodes have none, so they render empty). */
const outputs = (s: RunState) => Object.fromEntries(Object.entries(s.nodes).filter(([, n]) => n.status === 'done').map(([id, n]) => [id, n.output]));

// ---- conditions ----
export function compare(op: string, left: string, right: string): boolean {
  switch (op) {
    case 'equals': return left.trim() === right.trim();
    case 'contains': return left.toLowerCase().includes(right.toLowerCase());
    case 'matches': {
      if (right.length > 300) fail('The pattern is too long.');
      try { return new RegExp(right, 'i').test(left.slice(0, 100_000)); } catch { return fail('The pattern is not a valid regular expression.'); } // shortcut: a pathological pattern can be slow (no RE2 here); upgrade with a linear-time engine
    }
    case 'empty': return left.trim() === '';
    case 'not_empty': return left.trim() !== '';
    case 'gt': case 'lt': {
      const a = Number(left.trim().replace(',', '.')), b = Number(right.trim().replace(',', '.'));
      return left.trim() !== '' && right.trim() !== '' && Number.isFinite(a) && Number.isFinite(b) && (op === 'gt' ? a > b : a < b);
    }
    default: return fail(`Unknown comparison ${op}.`);
  }
}

/** The first JSON object in a model answer (it may be wrapped in a code fence or prose). */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fence.indexOf('{');
  if (start < 0) return undefined;
  for (let end = fence.lastIndexOf('}'); end > start; end = fence.lastIndexOf('}', end - 1)) {
    try { const v = JSON.parse(fence.slice(start, end + 1)); if (v && typeof v === 'object') return v; } catch { /* a shorter slice may parse */ }
  }
  return undefined;
}

const textOf = (n: unknown) => (typeof n === 'string' ? n : n == null ? '' : JSON.stringify(n));

/** Runs the flow until it ends, waits for a person, fails or is cancelled. Mutates `run`; every settled node is saved. */
export async function execute(run: Run, deps: Deps): Promise<void> {
  const s = run.state, g = checkGraph(s.flow);
  const ev = (u: Record<string, unknown>) => { if (!run.quiet) deps.emit({ ...u, runId: run.id }); };
  const finish = (status: RunStatus, error?: string) => {
    run.status = status; if (error) s.error = error;
    deps.save(run);
    if (status !== 'waiting') ev({ hefyn: 'run_end', status: status === 'done' || status === 'failed' || status === 'cancelled' ? status : 'failed', ...(error ? { error } : {}) });
  };
  if (!g.flow) return finish('failed', g.errors[0]!.message);
  run.status = 'running';
  const byId = new Map(s.flow.nodes.map((n) => [n.id, n]));
  const into = (id: string) => s.flow.edges.filter((e) => e.to === id);
  const delivers = (e: FlowEdge) => { const f = s.nodes[e.from]; return f?.status === 'done' && (f.ports ?? ['out']).includes(e.port ?? 'out'); };
  const done = (id: string, output: Record<string, unknown> | undefined, ports: string[] = ['out']) => { s.nodes[id] = { status: 'done', output, ports }; };
  const present = (id: string, n: FlowNode, o: Record<string, unknown> | undefined) => { ev({ hefyn: 'step_output', node: id, ...(typeof o?.text === 'string' ? { text: o.text } : {}), ...(o?.json !== undefined ? { json: o.json } : {}) }); };

  for (const id of g.order!) {
    if (deps.signal.aborted) return finish('cancelled');
    const node = byId.get(id)!, prev = s.nodes[id];
    if (prev?.status === 'waiting') return finish('waiting');
    if (prev) continue; // settled in an earlier pass (a resumed run)
    if (node.type !== 'trigger.chat' && !into(id).some(delivers)) {
      s.nodes[id] = { status: 'skipped' }; ev({ hefyn: 'step_end', node: id, status: 'skipped' }); deps.save(run); continue;
    }
    ev({ hefyn: 'step_start', node: id, label: label(node), type: node.type });
    try {
      const r = await step(node);
      if (r === 'waiting') return finish('waiting');
    } catch (e) {
      if (deps.signal.aborted) return finish('cancelled');
      const m = msg(e);
      s.nodes[id] = { status: 'failed', error: m };
      ev({ hefyn: 'step_end', node: id, status: 'failed', error: m });
      return finish('failed', `The step "${label(node)}" failed: ${m}`);
    }
    ev({ hefyn: 'step_end', node: id, status: 'done' });
    deps.save(run);
  }
  if (!s.replies.length && !run.quiet && run.state.depth === 0) { const t = 'The flow finished without a reply.'; deps.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t }, runId: run.id }); }
  finish('done');

  /** One node. Returns 'waiting' when it paused the run. */
  async function step(node: FlowNode): Promise<'waiting' | void> {
    const c = node.config, id = node.id, out = outputs(s), tpl = (t: unknown) => render(typeof t === 'string' ? t : '', out);
    switch (node.type) {
      case 'trigger.chat': done(id, { text: s.input.text, files: s.input.files }); return present(id, node, s.nodes[id]!.output);
      case 'template': { done(id, { text: tpl(c.text) }); return present(id, node, s.nodes[id]!.output); }
      case 'condition': {
        const result = compare(c.op, tpl(c.left), tpl(c.right));
        done(id, { result }, [result ? 'true' : 'false']); return;
      }
      case 'router': {
        const branches = (c.branches ?? []) as { id: string; label: string; description?: string; rule?: { left: string; op: string; right: string } }[];
        let pick = 'else';
        if (c.mode === 'rules') pick = branches.find((b) => b.rule && compare(b.rule.op, tpl(b.rule.left), tpl(b.rule.right)))?.id ?? 'else';
        else {
          const list = branches.map((b) => `- ${b.id}: ${b.label}${b.description ? ` (${b.description})` : ''}`).join('\n');
          const answer = await deps.model(run.id, { model: c.model, system: 'You route requests. Choose the one branch that fits the text best and answer with its id only, nothing else. If none fits, answer else.',
            prompt: `Branches:\n${list}\n- else: none of the above\n\nText:\n${tpl(c.input)}` });
          const a = answer.trim().replace(/^[`"'\s]+|[`"'.\s]+$/g, '').toLowerCase();
          pick = branches.find((b) => b.id.toLowerCase() === a)?.id ?? branches.find((b) => b.label.toLowerCase() === a)?.id ?? (branches.filter((b) => new RegExp(`\\b${b.id}\\b`, 'i').test(answer)).length === 1 ? branches.find((b) => new RegExp(`\\b${b.id}\\b`, 'i').test(answer))!.id : 'else');
        }
        done(id, { branch: pick }, [pick]); return;
      }
      case 'agent': {
        const json = c.output === 'json', base = tpl(c.prompt);
        const ask = (p: string) => deps.agent(run.id, { node, prompt: p, history: c.history === false ? '' : s.history, json });
        let text = await ask(json ? `${base}\n\nAnswer with one JSON object and nothing else.${c.schema ? ` It must match this JSON schema:\n${JSON.stringify(c.schema)}` : ''}` : base), parsed: unknown;
        if (json) {
          const bad = (v: unknown) => !v ? 'it was not JSON' : Array.isArray(c.schema?.required) && c.schema.required.find((k: string) => !(k in (v as object))) ? `the field "${c.schema.required.find((k: string) => !(k in (v as object)))}" is missing` : '';
          let why = bad((parsed = extractJson(text)));
          if (why) { text = await ask(`Your last answer was not usable (${why}). Answer again with one JSON object and nothing else.`); why = bad((parsed = extractJson(text))); }
          if (why) fail(`The answer was not valid JSON (${why}).`);
        }
        done(id, { text, ...(json ? { json: parsed } : {}) }); return present(id, node, s.nodes[id]!.output);
      }
      case 'assistant': {
        const sub = deps.assistant(String(c.assistantId));
        if (!sub) fail('That Assistant is not available.');
        if (s.depth + 1 > MAX_DEPTH) fail(`Assistants can be nested at most ${MAX_DEPTH} deep.`);
        if (s.chain.includes(sub!.id)) fail(`"${sub!.name}" is already running in this chain; an Assistant cannot call itself.`);
        const subRun = newRun({ id: `${run.id}.${id}`, conversationId: run.conversationId, assistantId: sub!.id, version: sub!.version, flow: sub!.flow, text: tpl(c.prompt), chain: [...s.chain, sub!.id], depth: s.depth + 1, quiet: true });
        await execute(subRun, { ...deps, emit: () => {}, save: () => {} });
        if (subRun.status !== 'done') fail(subRun.status === 'waiting' ? `"${sub!.name}" needs a person to answer, which is not possible inside another Assistant.` : `"${sub!.name}" did not finish: ${subRun.state.error ?? subRun.status}`);
        done(id, { text: subRun.state.replies.join('\n\n') }); return present(id, node, s.nodes[id]!.output);
      }
      case 'approval': {
        const message = tpl(c.message);
        let content = tpl(c.content);
        if (!content.trim()) { // nothing set: review the text of the nearest step before this one that made some
          const seen = new Set<string>();
          for (let level = [id]; level.length && !content.trim(); level = [...new Set(level.flatMap((x) => into(x).filter(delivers).map((e) => e.from)))].filter((x) => !seen.has(x) && seen.add(x))) {
            content = level.map((x) => s.nodes[x]?.output?.text).find((t): t is string => typeof t === 'string' && !!t.trim()) ?? '';
          }
        }
        s.nodes[id] = { status: 'waiting' };
        s.pending = { node: id, kind: 'approval', message, content, editable: !!c.editable };
        ev({ hefyn: 'waiting', node: id, kind: 'approval', message, content, editable: !!c.editable });
        return 'waiting';
      }
      case 'ask': {
        const message = tpl(c.question);
        s.nodes[id] = { status: 'waiting' };
        s.pending = { node: id, kind: 'ask', message, fields: c.fields ?? [] };
        ev({ hefyn: 'waiting', node: id, kind: 'ask', message, fields: c.fields ?? [] });
        return 'waiting';
      }
      case 'code': {
        const steps = Object.fromEntries(Object.entries(out).filter(([k]) => k !== id));
        const r = await deps.code({ language: c.language, source: c.source, node: id, timeoutSec: c.timeoutSec ?? 30, stdin: JSON.stringify({ input: { text: s.input.text, files: s.input.files }, steps }) });
        if (r.timedOut) fail(`The code ran longer than ${c.timeoutSec ?? 30} seconds.`);
        if (r.exitCode !== 0) {
          const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean); // the line that names the error (Python: the last; Node: "Error: ..." above the stack)
          fail(`The code stopped with an error: ${(lines.find((l) => /^(?:\w+\.)*\w*(?:Error|Exception)\b/.test(l)) ?? lines.at(-1) ?? `exit ${r.exitCode}`).slice(0, 500)}`);
        }
        let json: unknown;
        try { json = r.stdout.trim() ? JSON.parse(r.stdout) : undefined; } catch { fail('The code must print its result as JSON.'); }
        done(id, { json, text: r.stdout.trim() }); return present(id, node, s.nodes[id]!.output);
      }
      case 'tool': {
        const args = Object.fromEntries(Object.entries((c.args ?? {}) as Record<string, string>).map(([k, v]) => [k, tpl(v)]));
        const json = await deps.tool({ connectorId: c.connectorId, tool: c.tool, args });
        done(id, { json, text: textOf(json) }); return present(id, node, s.nodes[id]!.output);
      }
      case 'output.reply': {
        const text = tpl(c.text);
        s.replies.push(text);
        done(id, { text }, []);
        if (!run.quiet) deps.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, runId: run.id }); // no `node`: the chat shows it as the answer (forwarded agent chunks carry runId and node)
        return;
      }
      case 'output.file': {
        const path = await deps.file({ path: tpl(c.path), content: tpl(c.content) });
        done(id, { path }); return present(id, node, { text: path });
      }
      default: return fail(`Unknown step type ${node.type}.`);
    }
  }
}

export class AnswerError extends Error { status = 400; constructor(m: string) { super(m); } }
/** Applies a person's answer to the step the run waits at, then continues the run. */
export async function answer(run: Run, a: { node: string; approved?: boolean; text?: string; answers?: Record<string, string> }, deps: Deps): Promise<void> {
  const p = run.state.pending, st = p && run.state.nodes[p.node];
  if (run.status !== 'waiting' || !p || st?.status !== 'waiting' || p.node !== a.node) throw new AnswerError('This question is not waiting for an answer any more.');
  const ev = (u: Record<string, unknown>) => deps.emit({ ...u, runId: run.id });
  if (p.kind === 'approval') {
    if (typeof a.approved !== 'boolean') throw new AnswerError('Approve or reject.');
    const content = p.content ?? p.message; // a run paused before `content` existed
    const text = a.approved && p.editable && typeof a.text === 'string' ? a.text : content; // a rejection passes the content on unchanged
    run.state.nodes[p.node] = { status: 'done', output: { text, approved: a.approved }, ports: [a.approved ? 'approved' : 'rejected'] };
  } else {
    const fields = (p.fields ?? []) as { name: string; label: string; type: string; options?: string[] }[];
    let answers: Record<string, string> = {};
    if (fields.length) {
      for (const f of fields) {
        const v = a.answers?.[f.name];
        if (typeof v !== 'string' || !v.trim()) throw new AnswerError(`Please answer "${f.label}".`);
        if (f.type === 'choice' && !f.options?.includes(v)) throw new AnswerError(`"${f.label}": pick one of the options.`);
        answers[f.name] = v;
      }
    } else {
      const t = a.text ?? a.answers?.text;
      if (typeof t !== 'string' || !t.trim()) throw new AnswerError('Please answer the question.');
      answers = { text: t };
    }
    run.state.nodes[p.node] = { status: 'done', output: { answers, text: Object.values(answers).join('\n') }, ports: ['out'] };
  }
  const o = run.state.nodes[p.node]!.output!;
  run.state.pending = undefined;
  ev({ hefyn: 'step_output', node: p.node, text: String(o.text ?? ''), ...(p.kind === 'ask' ? { json: o.answers } : { json: { approved: o.approved } }) });
  ev({ hefyn: 'step_end', node: p.node, status: 'done' });
  deps.save(run);
  await execute(run, deps);
}
