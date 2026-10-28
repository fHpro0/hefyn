import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { type CliHost, type CliSession, HostError } from '../cli-agents/host.ts';
import { canonicalAgent } from '../cli-agents/profiles.ts';
import { setActivity } from '../server/activity.ts';
import { db } from '../server/appdb.ts';
import { containerFs } from '../server/container-fs.ts';
import { type Assistant, getAssistant, mayUseBy, roleOf, skillBundles } from '../server/assistants.ts';
import { mcpHandler } from '../cli-agents/mcp.ts';
import { openClient } from '../server/mcp.ts';
import { fsFor, runnerConfigured, shellEnabled } from '../server/runner.ts';
import { LockedError, openForUser, sealForUser, userKey } from '../server/vault.ts';
import { type Deps, type Run, AnswerError, answer, execute, newRun } from './engine.ts';
import { askHefyn } from './hefyn-step.ts';
import { createRun, failOrphan, loadRun, runsWith, saveRun } from './runs.ts';

// A chat whose Assistant is a real flow (conversations.flow = 1): the browser's side is the same event log + SSE as a hosted CLI agent (cli-agents/routes.ts), so the console renders both
// with one transport. The log is the conversation's `cli_events` (sealed with the owner's key); a flow chat's events are hefyn run events (docs/ASSISTANTS.md) and agent_message_chunk updates.
// Agent steps on a CLI agent run in a hidden child chat per agent (conversations.parent_id) that the CLI host drives, so sandbox, session and key policy are the ones of a CLI chat.

const IDLE_MS = 15 * 60_000;
const ulid = () => Date.now().toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
export type FlowEvent = { seq: number; at: string; update: Record<string, unknown> };
const plain = (e: unknown) => (e instanceof LockedError ? 'Your data is locked. Sign in again.' : e instanceof Error ? e.message : String(e));

export class FlowSession {
  private seq: number;
  private subs = new Set<(e: FlowEvent) => void>();
  private lives = new Map<string, { ctl: AbortController }>(); // the runs being driven now (a chat has one; a CLI chat's tool calls may overlap)
  private watch = new Map<string, (r: Run) => void>(); // runTool: told when the run ends
  private perms = new Map<string, CliSession>();
  active = Date.now();
  /** `log`: the conversation is a CLI chat (src/cli-agents/mcp.ts): runs started by the agent's tool calls write into the CLI session's log, which owns the sequence. */
  constructor(private host: FlowHost, readonly userId: string, readonly conversationId: string, private log?: (update: Record<string, unknown>) => void) {
    this.seq = (db.prepare('SELECT MAX(seq) AS m FROM cli_events WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0;
    this.recover();
  }

  // ---- event log ----
  private append(update: Record<string, unknown>) {
    if (this.log) { if (!update.sessionUpdate) this.log(update); return; } // the reply goes back as the tool's result, and a step's own chunks are not the CLI agent's words
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(this.conversationId)) return; // deleted: write nothing
    this.track(update);
    const at = new Date().toISOString(), seq = ++this.seq;
    db.prepare('INSERT INTO cli_events (conversation_id, seq, data) VALUES (?,?,?)').run(this.conversationId, seq, sealForUser(this.userId, JSON.stringify({ at, update }), `cli:${this.conversationId}:${seq}`));
    for (const s of this.subs) s({ seq, at, update });
  }
  // ---- activity (conversations.activity): the steps running now, as the chat list shows them. A waiting run is read from the database. ----
  private steps = new Map<string, { label: string; type: string }>(); // `${runId}:${node}`
  private track(u: Record<string, unknown>) {
    const key = `${u.runId}:${u.node}`;
    if (u.hefyn === 'step_start') this.steps.set(key, { label: String(u.label ?? u.node), type: String(u.type) });
    else if (u.hefyn === 'step_end' || u.hefyn === 'waiting') this.steps.delete(key);
    else if (u.hefyn === 'run_end') { for (const k of [...this.steps.keys()]) if (k.startsWith(`${u.runId}:`)) this.steps.delete(k); }
    else if (u.hefyn !== 'permission' && u.hefyn !== 'permission_resolved') return;
    this.publish();
  }
  private publish() {
    if (this.log) return; // a CLI chat: its host reports the turn
    if (!this.lives.size) return setActivity(this.conversationId, this.userId);
    const now = [...this.steps.values()];
    setActivity(this.conversationId, this.userId, { state: this.perms.size ? 'waiting' : 'running', label: now.at(-1)?.label, agents: now.filter((s) => s.type === 'agent' || s.type === 'assistant').map((s) => ({ name: s.label, kind: 'step', state: this.perms.size ? 'waiting' : 'running' })) });
  }

  subscribe(after: number, push: (e: FlowEvent) => void) {
    const rows = db.prepare('SELECT seq, data FROM cli_events WHERE conversation_id = ? AND seq > ? ORDER BY seq').all(this.conversationId, after) as { seq: number; data: string }[];
    for (const r of rows) push({ seq: r.seq, ...JSON.parse(openForUser(this.userId, r.data, `cli:${this.conversationId}:${r.seq}`)) });
    this.subs.add(push); this.active = Date.now();
    return () => { this.subs.delete(push); this.active = Date.now(); };
  }
  /** A run that was `running` when the agent process went away lost its driver: failed, said so in the log. A waiting run lives on in the database. */
  private recover() {
    try {
      for (const id of runsWith(this.conversationId, 'running')) {
        const msg = 'The server restarted while this ran. Send your message again.';
        failOrphan(this.userId, id, msg);
        this.append({ hefyn: 'error', message: msg, runId: id });
        this.append({ hefyn: 'run_end', runId: id, status: 'failed', error: msg });
      }
    } catch { /* locked: the next session retries */ }
  }

  get busy() { return this.lives.size > 0; }
  private waitingRun() { return runsWith(this.conversationId, 'waiting').at(-1); }

  /** The chat so far as plain text for agent steps that want it (user messages and answers, newest 12 000 characters). */
  private history(): string {
    const rows = db.prepare('SELECT seq, data FROM cli_events WHERE conversation_id = ? ORDER BY seq DESC LIMIT 600').all(this.conversationId) as { seq: number; data: string }[];
    const lines: string[] = [];
    for (const r of rows.reverse()) {
      const u = JSON.parse(openForUser(this.userId, r.data, `cli:${this.conversationId}:${r.seq}`)).update as Record<string, any>;
      if (u.hefyn === 'user') lines.push(`User: ${u.text}`);
      else if (u.sessionUpdate === 'agent_message_chunk' && !u.node && u.content?.text) { if (lines.at(-1)?.startsWith('Assistant: ')) lines[lines.length - 1] += `\n${u.content.text}`; else lines.push(`Assistant: ${u.content.text}`); }
    }
    return lines.join('\n\n').slice(-12_000);
  }

  prompt(text: string, files: unknown[] = []) {
    if (!userKey(this.userId)) throw new LockedError('user', this.userId);
    if (this.busy) throw new HostError(409, 'The assistant is still working. Wait for it to finish, or stop it first.');
    if (this.waitingRun()) throw new HostError(409, 'The assistant is waiting for your answer. Answer it, or stop it first.');
    const a = this.assistant();
    const history = this.history();
    const run = newRun({ id: randomUUID(), conversationId: this.conversationId, assistantId: a.id, version: a.version, flow: a.flow, text, files, history });
    createRun(this.userId, run);
    this.append({ hefyn: 'user', text });
    this.append({ hefyn: 'run_start', runId: run.id, assistantId: a.id });
    void this.drive(run, (deps) => execute(run, deps));
  }

  private assistant(): Assistant {
    const c = db.prepare('SELECT assistant_id FROM conversations WHERE id = ?').get(this.conversationId) as { assistant_id: string | null } | undefined;
    return this.allowed(c?.assistant_id);
  }
  private allowed(id: string | null | undefined): Assistant {
    const a = id ? getAssistant(id) : undefined;
    if (!a) throw new HostError(409, 'This assistant was removed. Start a new chat.');
    if (!mayUseBy(a, this.userId, roleOf(this.userId))) throw new HostError(403, 'This assistant is not available to you any more.');
    return a;
  }

  private async drive(run: Run, go: (d: Deps) => Promise<void>) {
    const ctl = new AbortController();
    this.lives.set(run.id, { ctl });
    this.publish();
    try { await go(this.deps(run, ctl.signal)); } catch (e) {
      try { // the key may have expired mid-run: then there is nothing to write the report to
        const m = plain(e);
        run.status = ctl.signal.aborted ? 'cancelled' : 'failed'; run.state.error = m; saveRun(this.userId, run);
        this.append({ hefyn: 'error', message: m, runId: run.id });
        this.append({ hefyn: 'run_end', runId: run.id, status: run.status, ...(ctl.signal.aborted ? {} : { error: m }) });
      } catch { /* locked */ }
    } finally { this.lives.delete(run.id); this.active = Date.now(); this.track({ hefyn: 'run_end', runId: run.id }); if (run.status !== 'running' && run.status !== 'waiting') this.watch.get(run.id)?.(run); }
  }

  /** A run for a CLI agent's tool call (mcp.ts). Resolves when it ends; in between it may wait for an answer (a `waiting` event in the CLI chat's log, then `answer`). */
  runTool(a: Assistant, text: string): { id: string; done: Promise<Run> } {
    if (!userKey(this.userId)) throw new LockedError('user', this.userId);
    const run = newRun({ id: randomUUID(), conversationId: this.conversationId, assistantId: a.id, version: a.version, flow: a.flow, text });
    createRun(this.userId, run);
    const done = new Promise<Run>((res) => this.watch.set(run.id, (r) => { this.watch.delete(run.id); res(r); }));
    this.append({ hefyn: 'run_start', runId: run.id, assistantId: a.id });
    void this.drive(run, (deps) => execute(run, deps));
    return { id: run.id, done };
  }

  /** Stops one run: the one being driven, or one waiting for an answer (nobody is driving it). */
  async cancelRun(id: string) {
    const live = this.lives.get(id);
    if (live) { live.ctl.abort(); return; }
    const run = loadRun(this.userId, id);
    if (run?.status !== 'waiting') return;
    run.status = 'cancelled'; run.state.pending = undefined; saveRun(this.userId, run);
    this.append({ hefyn: 'run_end', runId: run.id, status: 'cancelled' });
    this.watch.get(id)?.(run);
  }

  async cancel() {
    for (const l of this.lives.values()) l.ctl.abort();
    for (const s of new Set(this.perms.values())) await s.cancel().catch(() => {});
    for (const id of runsWith(this.conversationId, 'waiting')) if (!this.lives.has(id)) await this.cancelRun(id);
  }

  async answer(a: { runId: string; node: string; approved?: boolean; text?: string; answers?: Record<string, string> }) {
    if (this.lives.has(a.runId)) throw new HostError(409, 'The assistant is still working.');
    const mine = db.prepare('SELECT 1 FROM assistant_runs WHERE id = ? AND conversation_id = ?').get(a.runId, this.conversationId); // before opening it: another chat's run is sealed with another key
    const run = mine ? loadRun(this.userId, a.runId) : undefined;
    if (!run) throw new HostError(404, 'This question is not waiting for an answer any more.');
    this.allowed(run.assistantId); // still allowed to run it
    if (run.status !== 'waiting') throw new HostError(404, 'This question is not waiting for an answer any more.');
    answerCheck(run, a); // a mistyped answer leaves the question open
    // claim: only one answer wins
    if (db.prepare("UPDATE assistant_runs SET status = 'running' WHERE id = ? AND status = 'waiting'").run(a.runId).changes === 0) throw new HostError(404, 'This question is not waiting for an answer any more.');
    void this.drive(run, (deps) => answer(run, a, deps));
  }

  /** A CLI step's permission question: answered through the child chat that raised it. */
  permission(requestId: string, optionId: string | null) {
    const s = this.perms.get(requestId);
    if (!s) throw new HostError(404, 'This question is not waiting for an answer any more.');
    s.answer(requestId, optionId);
  }

  // ---- what the engine needs from the outside ----
  private deps(run: Run, signal: AbortSignal): Deps {
    const userId = this.userId, conv = this.conversationId;
    const sandbox = () => {
      const a = getAssistant(run.assistantId);
      if (!runnerConfigured()) throw new Error('This hefyn has no sandbox set up. Ask your administrator.');
      if (a?.scope !== 'team' && !shellEnabled(userId)) throw new Error('You cannot use the sandbox. Ask your administrator.');
    };
    return {
      signal,
      emit: (u) => this.append(u),
      save: (r) => { if (r === run) saveRun(userId, r); },
      agent: (runId, r) => {
        const c = r.node.config, prompt = (r.history ? `Conversation so far:\n${r.history}\n\n---\n\n` : '') + r.prompt;
        const off = run.state.flow.tools?.disabled ?? []; // the Assistant's Tools tab, as of this run's snapshot (a nested Assistant's steps use the outer one's)
        if (c.agent) return this.cliStep(runId, r.node.id, { ...c, skills: (c.skills ?? []).filter((k: string) => !off.includes(`skill:${k}`)) }, prompt, signal, run.assistantId);
        return askHefyn({ userId, signal, prompt, spec: { conversationId: conv, instructions: String(c.instructions ?? ''), model: c.model || null, thinking: c.thinking || null, skills: c.skills ?? [], subAgents: c.subAgents ?? [], tools: true, disabled: off } });
      },
      model: (_runId, r) => askHefyn({ userId, signal, prompt: r.prompt, spec: { conversationId: conv, instructions: r.system, model: r.model || null, thinking: null, skills: [], subAgents: [], tools: false } }),
      code: async (r) => {
        sandbox();
        const fs = containerFs({ userId, conversationId: conv }), path = `/tmp/flow-${r.node}.${r.language === 'python' ? 'py' : 'js'}`; // .js: Node detects CommonJS or ES module syntax itself
        await fs.writeFile(path, r.source);
        return fs.run(r.language === 'python' ? ['python3', path] : ['node', path], { cwd: '/tmp', stdin: r.stdin, timeoutMs: r.timeoutSec * 1000, signal });
      },
      tool: async (r) => {
        const client = await openClient(userId, r.connectorId);
        try {
          const res = await client.callTool({ name: r.tool, arguments: r.args }) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
          const text = (res.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
          if (res.isError) throw new Error(`The tool "${r.tool}" reported an error: ${text.slice(0, 300) || 'no details'}`);
          if (res.structuredContent !== undefined) return res.structuredContent;
          try { return JSON.parse(text); } catch { return text; }
        } finally { await client.close().catch(() => {}); }
      },
      file: async (r) => {
        const rel = r.path.replace(/^\/+/, '').replace(/^files\//, ''), path = `/files/${rel}`;
        if (!rel || rel.split('/').some((s) => s === '..')) throw new Error('That file name is not allowed.');
        const fs = fsFor(userId, conv);
        await fs.mkdir(dirname(path), { recursive: true }).catch(() => {});
        await fs.writeFile(path, r.content);
        return path;
      },
      assistant: (id) => { const a = getAssistant(id); return a && mayUseBy(a, userId, roleOf(userId)) ? { id: a.id, name: a.name, version: a.version, flow: a.flow } : undefined; },
    };
  }

  /** An agent step on a CLI agent: a prompt to the agent's session in the hidden child chat; resolves with the agent's text, forwards its updates and questions to this chat's log. */
  private async cliStep(runId: string, node: string, c: Record<string, any>, prompt: string, signal: AbortSignal, assistantId: string): Promise<string> {
    const agent = canonicalAgent(String(c.agent)), a = getAssistant(assistantId)!;
    if (a.scope !== 'team' && !shellEnabled(this.userId)) throw new Error('You cannot use agents in the sandbox. Ask your administrator.');
    const child = this.child(agent, a.id), s = this.host.cli.session(this.userId, child);
    const cfg = { model: c.model || null, provider: c.provider || null, instructions: String(c.instructions ?? ''), skills: skillBundles(c.skills ?? []).map((k) => ({ name: k.name, files: k.all })) };
    s.unattended = true; // a flow's step: API-key mode only, never a personal Claude account (docs/WRAPPER.md)
    s.override = { cfg, stamp: `${a.id}@${a.version}:${node}:${JSON.stringify(cfg).length}` };
    const after = (db.prepare('SELECT MAX(seq) AS m FROM cli_events WHERE conversation_id = ?').get(child) as { m: number | null }).m ?? 0;
    return new Promise<string>((resolve, reject) => {
      let out = '', started = false, error = '';
      const mine = new Set<string>();
      const unsub = s.subscribe(after, (e) => {
        const u = e.update as Record<string, any>;
        if (u.hefyn === 'turn_start') started = true;
        else if (u.hefyn === 'error') error = String(u.message);
        else if (u.hefyn === 'permission') { mine.add(u.requestId); this.perms.set(u.requestId, s); this.append({ ...u, runId, node }); }
        else if (u.hefyn === 'permission_resolved') { this.perms.delete(u.requestId); this.append({ ...u, runId, node }); }
        else if (u.hefyn === 'turn_end') {
          unsub(); signal.removeEventListener('abort', stop); for (const id of mine) this.perms.delete(id);
          if (signal.aborted || u.stopReason === 'cancelled') reject(new Error('stopped'));
          else if (u.stopReason === 'error' || error) reject(new Error(error || 'The agent stopped.'));
          else resolve(out);
        } else if (u.sessionUpdate) {
          if (u.sessionUpdate === 'agent_message_chunk' && started && u.content?.type === 'text') out += u.content.text;
          this.append({ ...u, runId, node });
        }
      });
      const stop = () => void s.cancel().catch(() => {});
      signal.addEventListener('abort', stop, { once: true });
      try { s.prompt(prompt); } catch (e) { unsub(); signal.removeEventListener('abort', stop); reject(e); }
    });
  }
  /** The hidden chat that holds this flow chat's session with one CLI agent. */
  private child(agent: string, assistantId: string): string {
    const have = db.prepare('SELECT id FROM conversations WHERE parent_id = ? AND agent = ?').get(this.conversationId, agent) as { id: string } | undefined;
    if (have) return have.id;
    const id = `u_${this.userId}_${ulid()}`, now = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at, agent, view, assistant_id, parent_id) VALUES (?,?,?,?,?,?, 'chat', ?, ?)")
      .run(id, this.userId, sealForUser(this.userId, 'Flow step', `conv:${id}:title`), now, now, agent, assistantId, this.conversationId);
    return id;
  }

  sweep(now: number) { if (!this.busy && !this.subs.size && !this.watch.size && now - this.active > IDLE_MS) this.host.drop(this.conversationId); }
  async close() { for (const l of this.lives.values()) l.ctl.abort(); }
}

/** Throws AnswerError before the run is touched when the answer does not fit (so a mistyped answer leaves the question open). */
function answerCheck(run: Run, a: { node: string; approved?: boolean; text?: string; answers?: Record<string, string> }) {
  const p = run.state.pending;
  if (!p || p.node !== a.node) throw new HostError(404, 'This question is not waiting for an answer any more.');
  if (p.kind === 'approval') { if (typeof a.approved !== 'boolean') throw new AnswerError('Approve or reject.'); return; }
  const fields = (p.fields ?? []) as { name: string; label: string; type: string; options?: string[] }[];
  if (!fields.length && !(a.text ?? a.answers?.text)?.trim()) throw new AnswerError('Please answer the question.');
  for (const f of fields) { const v = a.answers?.[f.name]; if (typeof v !== 'string' || !v.trim()) throw new AnswerError(`Please answer "${f.label}".`); if (f.type === 'choice' && !f.options?.includes(v)) throw new AnswerError(`"${f.label}": pick one of the options.`); }
}

export class FlowHost {
  private sessions = new Map<string, FlowSession>();
  private timer?: ReturnType<typeof setInterval>;
  /** `mcpWaitMs`: how long a CLI agent's tool call waits for an Assistant that needs a person's answer. */
  constructor(readonly cli: CliHost, sweepMs = 60_000, readonly mcpWaitMs = 30 * 60_000) {
    this.sweepMs = sweepMs;
    cli.deps.mcp ??= (userId, conversationId) => mcpHandler(this, userId, conversationId);
  }
  private sweepMs: number;
  session(userId: string, conversationId: string, log?: (update: Record<string, unknown>) => void): FlowSession {
    let s = this.sessions.get(conversationId);
    if (!s) this.sessions.set(conversationId, (s = new FlowSession(this, userId, conversationId, log)));
    this.timer ??= setInterval(() => { for (const x of this.sessions.values()) x.sweep(Date.now()); }, this.sweepMs).unref();
    return s;
  }
  /** The runs a CLI chat's agent starts with its Assistant tools (cli-agents/mcp.ts): they log into the CLI session. */
  forCli(userId: string, conversationId: string): FlowSession {
    return this.session(userId, conversationId, (u) => this.cli.session(userId, conversationId).log(u));
  }
  drop(conversationId: string) { this.sessions.delete(conversationId); }
  /** Stop everything of one user (their key is going away). */
  async closeUser(userId: string) { await Promise.all([...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.close())); }
  async closeAll() { clearInterval(this.timer); this.timer = undefined; await Promise.all([...this.sessions.values()].map((s) => s.close())); }
}
