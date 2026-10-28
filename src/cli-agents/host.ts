import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, PermissionOption, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { db } from '../server/appdb.ts';
import { assistantGrantsAgent, conversationAssistant } from '../server/assistants.ts';
import { validCwd } from '../assistants/draft.ts';
import { mcpProxy } from '../server/mcp-proxy.ts';
import { assistantFor, sessionItems } from '../server/session-items.ts';
import { EXTRA_DIR, extraSeeds, markSeeded } from '../server/assistant-bundle.ts';
import { containerFs, setFreeRoom, setStopChat } from '../server/container-fs.ts';
import { cliState, setActivity } from '../server/activity.ts';
import { baseDir } from '../server/storage.ts';
import { LockedError, getTeamKey, openForUser, sealForUser, userKey } from '../server/vault.ts';
import { type Attach, type AttachSpec, type Proc, runnerAttach } from './attach.ts';
import { type GatewayCtx, createGateway } from './gateway.ts';
import { createChatGateway } from './gateway-chat.ts';
import { createOpenAIGateway } from './gateway-openai.ts';
import { defaultProvider, providerApis, wireFor } from './providers.ts';
import { keyPolicy, providerProblem } from './access.ts';
import { launchable, lease, rowOf, userRole } from './installed.ts';
import { profileOf } from './profiles.ts';
import { Mapper, hookDecision, isSystemPrompt, pasteText, permissionCall, permissionOptions } from './claude-wrapper.ts';
import { inHome, listenAuthSocket, ownLaunch, signedIn, teamLaunch } from './own-account.ts';
import { homeOf } from './agent-login.ts';
import { resolveMode, teamKeyAllowed, teamLoginAllowed } from './team-accounts.ts';
import { Pty } from './pty.ts';
import { type AgentProfile, type AssistantConfig, BRIDGE_PORT, type LaunchCfg, type Seed, acpLaunch, canonicalAgent, terminalLaunch, wrapperLaunch } from './profiles.ts';
import { type Helper, planSession } from './session-config.ts';

// Hosts the user's CLI agent (any agent with a profile, profiles.ts) per conversation, lazily on first use, in the user's sandbox (via the runner's attach).
// Claude Code runs unmodified in one PTY that both views attach to: the terminal view shows it, the chat view types into it and is built from Claude Code's own
// hooks and transcript (claude-wrapper.ts, docs/WRAPPER.md). The other agents speak ACP to hefyn over stdio (chat view) or are relayed as a PTY (terminal view).
// Model traffic in API-key mode goes through a unix socket in the conversation's /tmp that this process serves with the model gateway (gateway.ts: Anthropic front,
// gateway-openai.ts: OpenAI Responses front, by path); on the user's own Claude account Claude Code reaches Anthropic directly through own-account.ts's proxy.
// Every event is logged sealed (cli_events), so a browser can replay it.

// Files connections (docs/STORAGE.md): pull before an agent process starts (bounded, 10 s), push after a turn (fire and forget).
const hasConnections = (userId: string) => !!db.prepare('SELECT 1 FROM connections WHERE user_id = ?').get(userId);
const pullConnections = async (userId: string) => { if (hasConnections(userId)) await (await import('../server/connections/sync.ts')).pullBeforeSession(userId); };
const pushConnections = (userId: string) => { if (hasConnections(userId)) void import('../server/connections/sync.ts').then((m) => m.pushAfterTurn(userId)).catch(() => {}); };
export class HostError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

/** The model socket's handler: both fronts by path (an agent only ever calls its own).
 *  `/hooks/<Event>` receives a wrapped agent's hooks (they answer with the JSON the agent expects). */
export function modelFront(ctx: GatewayCtx, session?: () => string | undefined, turn?: () => AbortSignal, hook?: (event: string, body: unknown) => Promise<unknown>): (req: Request) => Promise<Response> {
  const anthropic = createGateway(ctx), openai = createOpenAIGateway(ctx), chat = createChatGateway(ctx);
  // the key the admin picked for this agent is read per request, so a change applies to the next call
  const policy = (helper?: Helper) => {
    const agent = helper ? helper.agent : (db.prepare('SELECT agent FROM conversations WHERE id = ?').get(ctx.conversationId) as { agent: string | null } | undefined)?.agent;
    return { provider: (agent && rowOf(canonicalAgent(agent))?.key_provider) || null, session: helper ? helper.provider ?? undefined : session?.() };
  };
  return async (req) => {
    let url = new URL(req.url), helper: Helper | undefined;
    // `/a/<agent>/...`: a helper CLI the Assistant declares (session-config.ts helperBase), resolved with ITS key policy and provider; any other agent id is refused
    const ha = /^\/a\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(url.pathname);
    if (ha) {
      const id = canonicalAgent(ha[1]!);
      helper = assistantFor(ctx.conversationId)?.helpers.find((h) => canonicalAgent(h.agent) === id);
      if (!helper) return new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'This conversation\'s Assistant does not use that helper. Nothing was sent to the model.' } }), { status: 403, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
      if (!teamKeyAllowed(id, userRole(ctx.userId))) { // the same rule as the base agent's mode (chooseMode): the helper runs on keys only
        const message = `Your role may not use the team API key for ${profileOf(id)?.name ?? id}. Nothing was sent to the model.`;
        ctx.onRefusal?.(message);
        return new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message } }), { status: 403, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
      }
      helper = { ...helper, agent: id };
      url = new URL(`${ha[2]}${url.search}`, url); req = new Request(url, req);
    }
    const path = url.pathname;
    if (path.startsWith('/mcp/')) return mcpProxy(ctx)(req); // the agent's MCP servers, forwarded with credentials the sandbox never sees (mcp-proxy.ts)
    const h = /^\/hooks\/([A-Za-z]{1,40})$/.exec(path);
    if (h) { // anything in the sandbox can post here: the body is data to look at, never to obey
      if (req.method !== 'POST' || !hook) return new Response('Not Found', { status: 404 });
      let body: unknown; try { body = JSON.parse((await req.text()).slice(0, 8_000_000)); } catch { /* not JSON */ }
      const out = await hook(h[1]!, body).catch(() => ({}));
      return new Response(JSON.stringify(out ?? {}), { headers: { 'content-type': 'application/json' } });
    }
    const pol = policy(helper), api = path.startsWith('/v1/responses') ? 'openai-responses' : path.startsWith('/v1/chat/completions') ? 'openai-chat' : 'anthropic';
    // the session decides which provider (so which API) the model traffic goes to: a request on another front is refused, whatever the sandbox sends
    if (pol.session && !providerApis(pol.session).includes(api)) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `This agent session runs on ${pol.session}, which is not reached through this API. Nothing was sent to the model.` } }), { status: 400, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
    // Stop: the agent may retry or send one more request after it was stopped; nothing reaches the model until the next prompt, and what is in flight is aborted
    const stop = turn?.();
    if (stop?.aborted) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Stopped. Nothing was sent to the model.' } }), { status: 400, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
    if (stop) req = new Request(req, { signal: AbortSignal.any([req.signal, stop]) });
    return keyPolicy.run(pol, () => (api === 'openai-responses' ? openai(req) : api === 'openai-chat' ? chat(req) : anthropic(req)));
  };
}
const IDLE_MS = 10 * 60_000; // a chat with no turn, no question and no terminal watched for this long gives its sandbox back (the runner then stops it)
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILES = '/files';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CliEvent = { seq: number; at: string; update: Record<string, unknown> };
export interface HostDeps {
  attach: Attach;
  /** Serve `handler` on the model socket of the conversation's sandbox (/tmp/.hefyn/model.sock there). */
  listenModel(userId: string, conversationId: string, handler: (req: Request) => Promise<Response>): Promise<{ close(): void }>;
  /** The Anthropic-only proxy on the sandbox of a session that runs on the user's own Claude account (/tmp/.hefyn/auth.sock there; own-account.ts). Default: listenAuthSocket. */
  listenAuth?(userId: string, conversationId: string): Promise<{ close(): void }>;
  /** Is the user signed in to Claude Code in their sandbox (own-account.ts: asked of the sandbox, never read by hefyn)? Default: the runner's exec. */
  signedIn?(userId: string, conversationId: string, home?: string): Promise<boolean>;
  /** A wrapped agent's transcript from `offset` on (default: the file on the data volume, readTranscriptFile). Tests whose sandboxes live elsewhere than this process's disk supply their own. */
  transcript?(userId: string, conversationId: string, sid: string, offset: number, agent?: string): Promise<{ data: Buffer; size: number } | undefined>;
  /** Write an Assistant's files into the conversation's sandbox before the agent starts (default: seed.mjs through the runner's exec). */
  seed?(userId: string, conversationId: string, seeds: Seed[]): Promise<void>;
  idleMs?: number;
}

/** seed.mjs in the sandbox, the list on stdin (an Assistant's instructions and skills do not fit in the launch environment). */
export const runnerSeed = (o: { runnerUrl?: string; token?: string; fetch?: typeof fetch; retryMs?: number } = {}) => async (userId: string, conversationId: string, seeds: Seed[]) => {
  const r = await containerFs({ userId, conversationId, ...o }).run(['node', '/opt/hefyn/seed.mjs', '--stdin'], { cwd: '/tmp', stdin: JSON.stringify(seeds), timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`could not write the Assistant's files into the sandbox: ${r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`}`);
};
const seedViaRunner = runnerSeed();

/** The model socket on the host: <data>/users/<uid>/tmp/<conv>/.hefyn/model.sock, which the runner mounts as /tmp. */
export async function listenModelSocket(userId: string, conversationId: string, handler: (req: Request) => Promise<Response>) {
  const dir = join(baseDir(), 'users', userId, 'tmp', conversationId, '.hefyn');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777); // the sandbox user (uid 1000) may differ from ours
  // sun_path is ~104 bytes and this path can be longer: bind through a short symlink to the directory
  const short = join(tmpdir(), `hc-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`);
  rmSync(short, { force: true });
  symlinkSync(dir, short);
  rmSync(join(dir, 'model.sock'), { force: true }); // a stale one from a crashed process
  const server = Bun.serve({ unix: join(short, 'model.sock'), idleTimeout: 0, fetch: handler });
  chmodSync(join(dir, 'model.sock'), 0o666);
  return { close: () => { server.stop(true); rmSync(short, { force: true }); rmSync(join(dir, 'model.sock'), { force: true }); } };
}

/** The transcript of a wrapped session, from `offset` on: the file on the data volume (<data>/users/<uid>/tmp/<conv>/.claude/projects/-files/<sid>.jsonl, which the sandbox sees as
 *  /tmp/.claude/projects/...). The path is built from the validated session id, never taken from a hook payload. On the user's own account Claude Code writes it there too
 *  (a link in the Claude home points at it, own-account.ts), so this never touches the home. `size`: the file's size now; undefined: no such file. */
export async function readTranscriptFile(userId: string, conversationId: string, sid: string, offset: number, agent?: string): Promise<{ data: Buffer; size: number } | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(sid) || (agent !== undefined && !AGENT_ID.test(agent))) return undefined;
  let fd: number | undefined;
  try { // a sub-agent's own transcript: <sid>/subagents/agent-<id>.jsonl next to the main one
    // Claude Code names the project folder after the working folder (non-alphanumerics become "-"): /files is "-files"
    const cwd = (db.prepare('SELECT cwd FROM conversations WHERE id = ?').get(conversationId) as { cwd: string | null } | undefined)?.cwd;
    fd = openSync(join(baseDir(), 'users', userId, 'tmp', conversationId, '.claude', 'projects', (validCwd(cwd) ?? FILES).replace(/[^A-Za-z0-9]/g, '-'), ...(agent ? [sid, 'subagents', `agent-${agent}.jsonl`] : [`${sid}.jsonl`])), 'r');
    const size = fstatSync(fd).size, buf = Buffer.alloc(Math.max(0, Math.min(size - offset, 1 << 20))), n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0;
    return { data: buf.subarray(0, n), size };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

interface Term {
  proc: Proc; scroll: Buffer[]; size: number; active: number;
  subs: Set<{ data(b: Buffer): void; end(): void }>;
}
/** An open question: `resolve(null)` = not answered here (an ACP agent is told "cancelled"; a wrapped agent asks in its own terminal). */
interface Perm { options: { optionId: string }[]; resolve(optionId: string | null): void; tool?: string; agent?: string; /** the tool's kind or name, for the "waiting" notice */ kind?: string }
const askOf = (p?: Perm) => (p?.kind ? { ask: p.kind } : {});
/** A sub-agent's lane (Claude Code's Agent tool): its own mapper and transcript tail; its events carry `agent: <id>` in the log. */
interface Lane { mapper: Mapper; offset: number; buf: string; running: boolean; label: string }

class CliSession {
  private seq: number;
  private subs = new Set<(e: CliEvent) => void>();
  busy = false;
  /** Set for a run nobody is watching: never on the user's own Claude account (docs/WRAPPER.md). */
  unattended = false;
  private turnCtl = new AbortController();
  private conn?: ClientSideConnection;
  private proc?: Proc;
  private sessionId?: string;
  private starting?: Promise<void>;
  private unleaseAcp?: () => void; // holds the installed version's files while the agent process lives (an update removes the old version only after that)
  private loading = false;
  private output = 0; // agent messages and tool calls seen in the current turn
  private modelP?: Promise<{ close(): void }>;
  private authP?: Promise<{ close(): void }>;
  private modelRefs = 0;
  private closing: Promise<unknown> = Promise.resolve(); // the socket being closed: a new one at the same path must wait, or the old close deletes it
  private perms = new Map<string, Perm>();
  private term?: Term;
  private opening = false;
  active = Date.now();

  constructor(private host: CliHost, readonly userId: string, readonly conversationId: string) {
    this.seq = (db.prepare('SELECT MAX(seq) AS m FROM cli_events WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m ?? 0;
  }

  // ---- event log ----
  private append(update: Record<string, unknown>): CliEvent | undefined {
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(this.conversationId)) { void this.close(); return; } // deleted: write nothing
    const at = new Date().toISOString(), seq = ++this.seq;
    db.prepare('INSERT INTO cli_events (conversation_id, seq, data) VALUES (?,?,?)')
      .run(this.conversationId, seq, sealForUser(this.userId, JSON.stringify({ at, update }), `cli:${this.conversationId}:${seq}`));
    const e = { seq, at, update };
    for (const s of this.subs) s(e);
    return e;
  }
  /** The events after `after`, then every new one: replay and subscription happen in one tick, so nothing falls in between. */
  subscribe(after: number, push: (e: CliEvent) => void) {
    const rows = db.prepare('SELECT seq, data FROM cli_events WHERE conversation_id = ? AND seq > ? ORDER BY seq').all(this.conversationId, after) as { seq: number; data: string }[];
    for (const r of rows) push({ seq: r.seq, ...JSON.parse(openForUser(this.userId, r.data, `cli:${this.conversationId}:${r.seq}`)) });
    this.subs.add(push);
    this.active = Date.now();
    return () => { this.subs.delete(push); this.active = Date.now(); };
  }

  // ---- model socket (shared by the agent and the terminal) ----
  /** `own`: the session runs on the user's own Claude account: besides the socket (hooks, MCP) it needs the Anthropic-only proxy. */
  private async acquireModel(own = false) {
    const key = userKey(this.userId);
    if (!key) throw new LockedError('user', this.userId);
    await this.closing;
    this.modelRefs++;
    try {
      // The gateway reads keys from the vault, which every request to this conversation refreshes (acceptKeys); it fails closed once the key is gone.
      this.modelP ??= this.host.deps.listenModel(this.userId, this.conversationId, modelFront({ userId: this.userId, conversationId: this.conversationId, userKey: key, teamKey: getTeamKey(), onRefusal: (message) => { try { this.append({ hefyn: 'error', message }); } catch { /* locked */ } } }, () => this.provider, () => this.turnCtl.signal, (e, b) => this.hook(e, b)));
      await this.modelP;
      if (own) { this.authP ??= (this.host.deps.listenAuth ?? listenAuthSocket)(this.userId, this.conversationId); await this.authP; }
    } catch (e) { this.releaseModel(); throw e; }
  }
  private releaseModel() {
    if (--this.modelRefs > 0) return;
    const p = this.modelP, a = this.authP; this.modelP = this.authP = undefined; this.modelRefs = 0;
    this.closing = this.closing.then(() => Promise.all([p, a].map((x) => x?.then((m) => m.close(), () => {}))));
  }

  /** The conversation's agent: installed, ready, turned on and open to the user's role, or a HostError saying why not. */
  private agent(): { profile: AgentProfile; version: string } {
    const agent = (db.prepare('SELECT agent FROM conversations WHERE id = ?').get(this.conversationId) as { agent: string | null } | undefined)?.agent;
    const l = launchable(this.userId, agent ?? '', assistantGrantsAgent(this.userId, this.conversationId));
    if ('reason' in l) throw new HostError(409, l.reason);
    return { profile: l.profile, version: l.row.version };
  }
  private wrapped() { try { return !!this.agent().profile.wrapper; } catch { return false; } }

  /** The agent's working folder: /files, or the draft folder of an Assistant editor chat (validCwd keeps it below the drafts folder). */
  private cwd(): string {
    const c = (db.prepare('SELECT cwd FROM conversations WHERE id = ?').get(this.conversationId) as { cwd: string | null } | undefined)?.cwd;
    if (!c) return FILES;
    const ok = validCwd(c);
    if (!ok) throw new HostError(400, 'This chat has an invalid working folder.');
    return ok;
  }
  /** The Assistant this conversation runs on, if it runs on this agent: what to set on the agent, and a stamp that changes when an admin edits it. */
  private assistant(): { cfg: AssistantConfig; stamp: string } | undefined {
    const c = db.prepare('SELECT agent FROM conversations WHERE id = ?').get(this.conversationId) as { agent: string | null } | undefined;
    const a = conversationAssistant(this.conversationId);
    if (!a?.agent || !c?.agent || canonicalAgent(a.agent) !== canonicalAgent(c.agent)) return;
    return { stamp: `${a.id}@${a.updatedAt ?? ''}`, cfg: { model: a.model, provider: a.provider ?? null, instructions: a.instructions, skills: [] } }; // the skills come from sessionItems (own and team ones, not only approved team skills)
  }
  /** The session's MCP servers and helper setup, for the launch seed (set by applyAssistant, read by choose). */
  private launchSeeds: Seed[] = [];
  /** Put the instructions, skills and helpers into the agent's config in the sandbox (the model, MCP servers and helper permissions go in through the launch seed). A chat without an Assistant gets the person's own and the team's skills that are on.
   *  `home`: on the user's own Claude account the config dir is their Claude home. */
  private async applyAssistant(profile: AgentProfile, a: { cfg: AssistantConfig } | undefined, home = false) {
    const it = sessionItems(this.userId, this.conversationId);
    const extra = it.bundle && Object.keys(it.bundle.extra).length ? it.bundle : undefined; // the Assistant's files besides its skills
    const instructions = a && extra ? `${a.cfg.instructions}\n\nThis Assistant's files are in ${EXTRA_DIR}/.\n` : a?.cfg.instructions;
    const plan = planSession({ profile, base: `http://127.0.0.1:${BRIDGE_PORT}`, instructions, skills: it.skills, helpers: it.helpers, mcp: it.mcp });
    this.launchSeeds = plan.launch;
    let seeds = plan.stdin;
    if (home) seeds = seeds.map((s) => ({ ...s, path: inHome(s.path) }));
    if (extra?.fresh) seeds = [...seeds, ...extraSeeds(extra.extra)]; // a fresh copy for a new chat, once: later starts leave what the person changed alone
    if (!seeds.length) return;
    try { await (this.host.deps.seed ?? seedViaRunner)(this.userId, this.conversationId, seeds); if (extra?.fresh) markSeeded(this.conversationId); } catch (e) { if (a) throw e; /* only the /commands of the user's Assistants: the agent runs without them */ }
  }
  /** The provider the session runs on (the gateway reads it per request, never the sandbox); undefined = the agent's own API's. */
  provider?: string;
  /** What the agent runs on: the Assistant's provider and model, else the admin's default for the agent (chats without an Assistant). Sets `provider`. */
  private choose(profile: AgentProfile, a: { cfg: AssistantConfig } | undefined): LaunchCfg | undefined {
    const row = rowOf(profile.registryId);
    const sel = a ? { model: a.cfg.model, provider: a.cfg.provider ?? null } : row?.default_provider || row?.default_model ? { model: row.default_model ?? null, provider: row.default_provider ?? null } : undefined;
    if (sel?.provider && !wireFor(profile.spec, sel.provider)) throw new HostError(409, `${profile.name} cannot run on the provider "${sel.provider}". Ask your administrator.`);
    this.provider = sel?.provider || undefined;
    const launchSeeds = this.launchSeeds;
    return !launchSeeds.length ? sel : sel ? { ...sel, launchSeeds } : { launchSeeds };
  }
  private defaultStamp() { try { const r = rowOf(canonicalAgent(this.agent().profile.registryId)); return `default:${r?.default_provider ?? ''}/${r?.default_model ?? ''}`; } catch { return ''; } }
  private stampOf = (a: { stamp: string } | undefined) => a?.stamp ?? this.defaultStamp();
  private stamp?: string; // the Assistant version the running agent was started with

  private get name() { try { return this.agent().profile.name; } catch { return 'The agent'; } }
  private storedSession() { return (db.prepare('SELECT acp_session FROM conversations WHERE id = ?').get(this.conversationId) as { acp_session: string | null } | undefined)?.acp_session ?? null; }

  // ==== chat view of an ACP agent ====
  private client: Client = {
    sessionUpdate: async (p: SessionNotification) => {
      // session/load replays the history, which is in the log already; prompts are logged once, as hefyn `user` events
      if (this.loading || p.update.sessionUpdate === 'user_message_chunk') return;
      if (p.update.sessionUpdate === 'agent_message_chunk' || p.update.sessionUpdate === 'tool_call') this.output++;
      this.append(p.update as unknown as Record<string, unknown>);
    },
    requestPermission: (p: RequestPermissionRequest) => {
      const requestId = randomUUID();
      return new Promise<RequestPermissionResponse>((resolve) => {
        this.perms.set(requestId, { options: p.options, kind: p.toolCall.kind ?? undefined, resolve: (id) => resolve({ outcome: id === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: id } }) });
        this.publish();
        this.append({ hefyn: 'permission', requestId, toolCall: p.toolCall, options: p.options as PermissionOption[] });
      });
    },
  };

  /** Start a process in the user's sandbox. At the runner's per-user cap ("too many sandbox containers"), the least recently used idle chat of this user gives its process up, the runner stops that sandbox, and this retries; a chat with a turn or a question is never touched. */
  private async launch(spec: AttachSpec): Promise<Proc> {
    await pullConnections(this.userId);
    for (let i = 0; ; i++) {
      try { return await this.host.deps.attach(this.userId, this.conversationId, spec); } catch (e) {
        if (i >= 8 || !/too many sandbox containers for this user/.test(String((e as Error)?.message)) || (i === 0 && !this.host.freeSandbox(this.userId, this))) throw e;
        await sleep(1000); // the runner releases the sandbox once the killed process is gone
      }
    }
  }
  private ensureAcp(): Promise<void> {
    return this.starting ??= this.startAcp().catch((e) => { this.starting = undefined; throw e; });
  }
  private async startAcp() {
    const { profile, version } = this.agent();
    this.unleaseAcp = lease(profile.registryId, version);
    this.append({ hefyn: 'status', state: 'starting' });
    await this.acquireModel();
    let proc: Proc | undefined;
    try {
      const asst = this.assistant();
      await this.applyAssistant(profile, asst);
      this.stamp = this.stampOf(asst);
      const l = acpLaunch(profile, version, undefined, this.choose(profile, asst));
      proc = await this.launch({ cmd: l.cmd, env: l.env, tty: false, cwd: this.cwd() });
      const mine = proc;
      mine.stream.on('close', () => this.acpGone(mine));
      mine.stream.on('error', () => {});
      this.proc = mine;
      this.conn = new ClientSideConnection(() => this.client, ndJsonStream(Writable.toWeb(mine.stream as Writable) as WritableStream<Uint8Array>, Readable.toWeb(mine.stream as Readable) as ReadableStream<Uint8Array>));
      const init = await this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }); // no fs / terminal: the agent works in its own sandbox
      const stored = this.storedSession() ?? undefined;
      if (stored && init.agentCapabilities?.loadSession) {
        this.loading = true;
        try { await this.conn.loadSession({ sessionId: stored, cwd: this.cwd(), mcpServers: [] }); this.sessionId = stored; } catch { /* the agent no longer has it: start a new one */ } finally { this.loading = false; }
      }
      if (!this.sessionId) {
        this.sessionId = (await this.conn.newSession({ cwd: this.cwd(), mcpServers: [] })).sessionId;
        db.prepare('UPDATE conversations SET acp_session = ? WHERE id = ?').run(this.sessionId, this.conversationId);
      }
      this.append({ hefyn: 'status', state: 'ready' });
    } catch (e) {
      proc?.stream.destroy();
      this.unleaseAcp?.(); this.unleaseAcp = undefined;
      if (this.proc === proc) this.acpGone(proc!);
      else this.releaseModel();
      throw e;
    }
  }
  private acpGone(proc: Proc) {
    if (this.proc !== proc) return;
    this.proc = this.conn = this.sessionId = this.starting = undefined;
    this.unleaseAcp?.(); this.unleaseAcp = undefined;
    for (const id of [...this.perms.keys()]) this.answer(id, null);
    this.append({ hefyn: 'status', state: 'stopped' });
    this.releaseModel();
  }
  private closeAcp() { this.proc?.stream.destroy(); if (this.proc) this.acpGone(this.proc); }

  /** The console's theme as the browser last said it: a terminal started by a chat message (not by opening the terminal) starts in it too. */
  private theme?: 'light' | 'dark';
  private ptyTheme?: 'light' | 'dark'; // the theme the running PTY was started with
  /** `lane`: a message to (or a stop of) one sub-agent. hefyn cannot type into it, so the main agent is asked to forward it (SendMessage / TaskStop). */
  prompt(text: string, theme?: 'light' | 'dark', lane?: { agent: string; action: 'message' | 'stop' }) {
    if (theme) this.theme = theme;
    const wrapped = this.wrapped();
    if (lane) {
      if (!wrapped) throw new HostError(409, 'This agent cannot be messaged directly.');
      if (!AGENT_ID.test(lane.agent) || !this.lanes.has(lane.agent)) throw new HostError(400, 'This sub-agent is not known (any more).');
    }
    if (!wrapped && (this.term || this.opening)) throw new HostError(409, 'The terminal is open for this chat. Close it, then send your message here.');
    if (this.busy) throw new HostError(409, `${this.name} is still answering. Wait for it to finish, or stop it first.`);
    if (!userKey(this.userId)) throw new LockedError('user', this.userId); // nothing can be logged without the key
    this.busy = true;
    this.turnCtl = new AbortController(); // aborted by cancel(): the gateway refuses model requests until the next prompt
    this.active = Date.now();
    this.publish();
    void (wrapped ? this.wrapTurn(text, lane) : this.turn(text));
  }
  private async turn(text: string) {
    try {
      this.append({ hefyn: 'user', text });
      if (this.proc && this.stampOf(this.assistant()) !== this.stamp) this.closeAcp(); // an admin changed the Assistant: the next start (the session resumes) picks it up
      await this.ensureAcp();
      this.append({ hefyn: 'turn_start' });
      this.output = 0;
      const r = await this.conn!.prompt({ sessionId: this.sessionId!, prompt: [{ type: 'text', text }] });
      if (r.stopReason === 'end_turn' && !this.output) this.append({ hefyn: 'error', message: `${this.name} stopped without answering. Try sending your message again.` }); // before turn_end: the UI shows one line, not two
      this.dropPerms();
      this.append({ hefyn: 'turn_end', stopReason: r.stopReason });
    } catch (e) {
      try { // the key may have expired mid-turn: then there is nothing to write the report to
        this.append({ hefyn: 'error', message: e instanceof LockedError ? 'Your data is locked. Sign in again.' : e instanceof HostError ? e.message : `${this.name} stopped: ${(e as Error)?.message ?? e}` });
        this.dropPerms();
        this.append({ hefyn: 'turn_end', stopReason: 'error' });
      } catch { /* locked */ }
    } finally { this.busy = false; this.active = Date.now(); this.publish(); pushConnections(this.userId); }
  }
  /** Tells conversations.activity what this chat does now: waiting on an open question, running a turn, or (terminal) running while it prints. */
  private publish() {
    // a wrapped agent's hooks say when it works (also for a prompt typed in the terminal); its idle screen redraws now and then, so output means nothing there
    const state = cliState({ busy: this.busy, perms: this.perms.size, terminal: this.pty ? false : !!this.term, lastOutput: this.termOut, now: Date.now() });
    // a sub-agent runs on in the background after the turn that started it: the chat stays active (and lists it) until the last one ends
    const subs = [...this.lanes].filter(([, l]) => l.running).map(([id, l]) => ({ id, name: l.label, kind: 'agent' as const, state: [...this.perms.values()].some((p) => p.agent === id) ? 'waiting' as const : 'running' as const, ...askOf([...this.perms.values()].find((p) => p.agent === id)) }));
    const live = state ?? (subs.length ? (subs.some((a) => a.state === 'waiting') ? 'waiting' : 'running') : undefined);
    setActivity(this.conversationId, this.userId, live && { state: live, ...(subs.length ? { agents: subs } : {}), ...askOf([...this.perms.values()].find((p) => !p.agent)) });
  }
  private termOut = 0;
  private termTimer?: ReturnType<typeof setTimeout>;
  /** A question still open when its turn ends is void (the agent gave up on it): close the card before turn_end. */
  private dropPerms(keepAgents = false) { for (const [id, p] of [...this.perms]) if (!(keepAgents && p.agent && this.lanes.get(p.agent)?.running)) this.answer(id, null); } // a running sub-agent's question outlives the turn that started it
  async cancel() {
    this.dropPerms();
    if (this.wrapped()) {
      if (!this.busy) return;
      this.turnCtl.abort();
      this.pty?.write('\x1b'); // Esc: Claude Code's own interrupt
      this.stopped();
      return;
    }
    if (this.busy) this.turnCtl.abort();
    if (this.busy && this.conn && this.sessionId) await this.conn.cancel({ sessionId: this.sessionId }).catch(() => {});
  }
  answer(requestId: string, optionId: string | null) {
    const p = this.perms.get(requestId);
    if (!p) throw new HostError(404, 'This question is not waiting for an answer any more.');
    if (optionId !== null && !p.options.some((o) => o.optionId === optionId)) throw new HostError(400, 'Not one of the options.');
    this.perms.delete(requestId);
    this.publish();
    p.resolve(optionId);
    this.append({ hefyn: 'permission_resolved', requestId, optionId });
  }

  // ==== Claude Code in a PTY: one process, two views (claude-wrapper.ts) ====
  private pty?: Pty;
  private ptyStarting?: Promise<void>;
  private unleasePty?: () => void;
  private mapper = new Mapper();
  private tail?: { sid: string; offset: number; buf: string; timer: ReturnType<typeof setInterval> };
  private promptId?: string; // the turn Claude Code reported last (UserPromptSubmit)
  private echo?: string; // what hefyn itself sent: its UserPromptSubmit is not a second `user` event
  private submitted?: () => void;
  private dirty = false; // Esc may have put the unsent prompt back into Claude Code's composer: clear it before the next paste
  private cancelAt = 0;
  private ownMode = false;

  /** Which model traffic this session uses (docs/WRAPPER.md): signed in to Claude Code in the sandbox = their own account, else the API key through the gateway, else a plain message. */
  private async chooseMode(profile: AgentProfile): Promise<'own' | 'team' | 'key'> {
    // personal login > the team's shared login (their role may use it) > the team API key (their role may use it) > a plain message (team-accounts.ts resolveMode)
    const id = profile.registryId, role = userRole(this.userId), un = this.unattended, signed = (home?: string) => (this.host.deps.signedIn ?? signedIn)(this.userId, this.conversationId, home).catch(() => false); // unreachable sandbox: the key path will say so
    const personalSignedIn = !un && await signed(), tl = !un && !personalSignedIn && teamLoginAllowed(id, role), teamLoginSignedIn = tl && await signed(homeOf(profile, 'team'));
    const keyAllowed = teamKeyAllowed(id, role), row = rowOf(id);
    const problem = personalSignedIn || teamLoginSignedIn ? undefined : !keyAllowed ? `Your role may not use the team API key for ${profile.name}.`
      : await keyPolicy.run({ provider: row?.key_provider ?? null }, () => providerProblem(this.userId, row?.default_provider || defaultProvider(profile.api)));
    const mode = resolveMode({ unattended: un, personalSignedIn, teamLoginAllowed: tl, teamLoginSignedIn, teamKeyAllowed: keyAllowed, teamKeyUsable: !problem });
    if (mode === 'personal') return 'own';
    if (mode === 'team-login') return 'team';
    if (mode === 'team-key') return 'key';
    throw new HostError(409, un ? `${problem} Unattended runs (schedules, flows) use an API key, never a personal Claude account.` : `${problem} Or sign in to ${profile.name} with your own account: Settings, Agent accounts.`);
  }

  private ensurePty(cols?: number, rows?: number, theme?: 'light' | 'dark'): Promise<void> {
    if (this.pty && !this.ptyStarting) return Promise.resolve();
    return this.ptyStarting ??= this.startPty(cols, rows, theme).finally(() => { this.ptyStarting = undefined; });
  }
  private async startPty(cols = 120, rows = 32, theme = this.theme) {
    const { profile, version } = this.agent();
    this.append({ hefyn: 'status', state: 'starting' });
    const mode = await this.chooseMode(profile), own = mode === 'own', team = mode === 'team';
    const unlease = lease(profile.registryId, version);
    try { await this.acquireModel(own || team); } catch (e) { unlease(); throw e; } // before the process goes: the socket lives as long as any session of the conversation
    let proc: Proc | undefined;
    try {
      const asst = this.assistant();
      await this.applyAssistant(profile, asst, own);
      this.stamp = this.stampOf(asst);
      let sid = this.storedSession();
      if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) { sid = randomUUID(); db.prepare('UPDATE conversations SET acp_session = ? WHERE id = ?').run(sid, this.conversationId); }
      const base = wrapperLaunch(profile, version, sid, theme, undefined, this.choose(profile, asst)), l = own ? ownLaunch(base) : team ? teamLaunch(base, homeOf(profile, 'team')) : base;
      proc = await this.launch({ cmd: l.cmd, env: l.env, tty: true, cwd: this.cwd(), cols, rows });
      const pty = new Pty(proc);
      this.pty = pty; this.ptyTheme = theme; this.unleasePty = unlease; this.ownMode = own || team; this.sessionId = sid; this.mapper = new Mapper();
      const have = await this.readTranscript(sid, Number.MAX_SAFE_INTEGER).catch(() => undefined); // what the transcript holds already is in the log
      this.tail = { sid, offset: have?.size ?? 0, buf: '', timer: setInterval(() => void this.drain(), 250) };
      this.tail.timer.unref();
      let lastPublish = 0;
      pty.onData = () => { const now = Date.now(); if (pty.watching && now - lastPublish > 1000) { lastPublish = now; this.publish(); } clearTimeout(this.termTimer); this.termTimer = setTimeout(() => this.publish(), 10_100); this.termTimer.unref(); };
      pty.onEnd = () => this.ptyGone(pty);
      await this.untilQuiet(pty);
      this.append({ hefyn: 'status', state: 'ready' });
    } catch (e) {
      proc?.stream.destroy();
      if (this.pty) this.ptyGone(this.pty); else { unlease(); this.releaseModel(); }
      throw e;
    }
  }
  /** The TUI has drawn itself: it printed something and has been quiet a moment. (Pasting earlier would be lost on its startup screen.) */
  private async untilQuiet(pty: Pty, ms = 30_000) {
    const end = Date.now() + ms;
    while (!pty.ended && Date.now() < end) { if (pty.lastOutput && Date.now() - pty.lastOutput > 700) return; await sleep(100); }
    if (pty.ended) throw new HostError(502, `${this.name} stopped while starting.`);
    throw new HostError(504, `${this.name} did not start in time. Try again.`);
  }
  /** `restart`: hefyn ended it on purpose before a message (an Assistant changed): the message's turn goes on, nothing was lost. */
  private ptyGone(pty: Pty, restart = false) {
    if (this.pty !== pty) return;
    const t = this.tail;
    if (t) { clearInterval(t.timer); void this.drain(t); } // the last lines it wrote
    this.tail = this.pty = this.sessionId = undefined;
    this.unleasePty?.(); this.unleasePty = undefined;
    const wasBusy = this.busy && !restart;
    this.dropPerms();
    this.endLanes(); this.lanes.clear();
    if (wasBusy) { this.append({ hefyn: 'error', message: `${this.name} stopped.` }); this.endTurn('error'); }
    this.append({ hefyn: 'status', state: 'stopped' });
    this.releaseModel();
    this.publish();
  }
  private closePty(restart = false) { const p = this.pty; if (!p) return; p.kill(); this.ptyGone(p, restart); }

  /** New lines of the transcript, in order, before whatever a hook says next (a hook always follows the line it is about). */
  private drainQ: Promise<unknown> = Promise.resolve();
  private drain(t = this.tail): Promise<void> {
    if (!t) return Promise.resolve();
    const p = this.drainQ.then(() => this.drainOnce(t)).then(() => this.drainLanes(t.sid)).catch(() => {});
    this.drainQ = p;
    return p;
  }
  private readTranscript(sid: string, offset: number, agent?: string) {
    return (this.host.deps.transcript ?? readTranscriptFile)(this.userId, this.conversationId, sid, offset, agent);
  }
  // ---- sub-agents: one lane each, from their own transcript file and their hooks (`agent_id`) ----
  private lanes = new Map<string, Lane>();
  private logLane(id: string, u: Record<string, unknown>) { this.append({ ...u, agent: id }); }
  private async drainLanes(sid: string) {
    for (const [id, l] of this.lanes) {
      for (let more = true; more; ) {
        const r = await this.readTranscript(sid, l.offset, id);
        if (!r) break;
        if (r.size < l.offset) { l.offset = 0; l.buf = ''; continue; }
        l.offset += r.data.length; l.buf += r.data.toString('utf8'); more = r.data.length > 0 && l.offset < r.size;
      }
      let i: number;
      while ((i = l.buf.indexOf('\n')) >= 0) {
        const line = l.buf.slice(0, i); l.buf = l.buf.slice(i + 1);
        let o: unknown; try { o = JSON.parse(line); } catch { continue; }
        for (const u of l.mapper.line(o).events) this.logLane(id, u);
      }
    }
  }
  /** The lane of a sub-agent (made on first sight: SubagentStart, or any hook that carries its `agent_id`). The Agent tool call it belongs to is paired in start order. */
  private lane(id: string, type?: string): Lane {
    let l = this.lanes.get(id);
    if (!l) {
      const t = this.mapper.claimAgent();
      this.lanes.set(id, (l = { mapper: new Mapper(true), offset: 0, buf: '', running: true, label: t?.description || type || t?.type || 'Sub-agent' }));
      this.append({ hefyn: 'subagent', agentId: id, status: 'running', type: type ?? t?.type ?? '', description: t?.description ?? '', ...(t ? { toolCallId: t.id } : {}) });
      this.publish();
    }
    return l;
  }
  private endLane(id: string, status: 'done' | 'failed') {
    const l = this.lanes.get(id);
    if (!l?.running) return;
    l.running = false; for (const u of l.mapper.closeTools()) this.logLane(id, u);
    this.append({ hefyn: 'subagent', agentId: id, status });
    this.publish();
  }
  private endLanes() { for (const id of this.lanes.keys()) this.endLane(id, 'failed'); } // the turn was stopped, or the process is gone
  /** Claude Code writes a tool's transcript line behind its hook (measured): wait a moment for it, so a tool card keeps the transcript's place after the text before it. */
  private async lineFirst(m: Mapper, id: unknown) {
    for (let i = 0; typeof id === 'string' && i < 10 && !m.has(id) && this.pty; i++) { await sleep(100); await this.drain(); }
  }
  private async drainOnce(t: NonNullable<CliSession['tail']>) {
    for (let more = true; more; ) {
      const r = await this.readTranscript(t.sid, t.offset);
      if (!r) return; // not there yet
      if (r.size < t.offset) { t.offset = 0; t.buf = ''; continue; } // replaced
      t.offset += r.data.length; t.buf += r.data.toString('utf8'); more = r.data.length > 0 && t.offset < r.size;
    }
    let i: number;
    while ((i = t.buf.indexOf('\n')) >= 0) {
      const line = t.buf.slice(0, i); t.buf = t.buf.slice(i + 1);
      let o: unknown; try { o = JSON.parse(line); } catch { continue; }
      const r = this.mapper.line(o);
      for (const u of r.events) this.emit(u);
      // Esc typed in the terminal: Claude Code writes this line (Stop does not fire for an interrupt); one we caused ourselves has been answered already
      if (r.end === 'interrupted' && this.busy && Date.now() - this.cancelAt > 5000) this.stopped();
      if (r.end === 'done') this.dones++;
    }
  }
  private dones = 0; // `turn_duration` lines seen: Claude Code writes one after the Stop hooks have returned
  /** The Stop hook comes before the last lines of the turn reach the transcript (measured: Claude Code writes them behind the hook): answer the hook at once, wait for the
   *  turn's closing `turn_duration` line (at most 3 s), then end the turn, so the answer is in the chat before turn_end. */
  private async finishTurn(reason: string, before: number, failure?: string) {
    for (let i = 0; i < 30 && this.dones === before && this.pty; i++) { await sleep(100); await this.drain(); }
    if (failure && this.busy) this.append({ hefyn: 'error', message: failure });
    this.endTurn(reason);
  }
  private emit(u: Record<string, unknown>) {
    if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'tool_call') this.output++;
    this.append(u);
  }
  private endTurn(reason: string) {
    if (!this.busy) return;
    if (reason === 'end_turn' && !this.output) this.append({ hefyn: 'error', message: `${this.name} stopped without answering. Try sending your message again.` });
    this.dropPerms(true);
    this.append({ hefyn: 'turn_end', stopReason: reason });
    this.busy = false; this.active = Date.now(); this.publish();
    pushConnections(this.userId);
  }
  /** The reader (or the terminal's Esc) stopped the turn. */
  private stopped() {
    if (!this.busy) return;
    this.cancelAt = Date.now(); this.dirty = true;
    this.dropPerms();
    for (const u of this.mapper.closeTools()) this.append(u);
    this.endLanes();
    this.endTurn('cancelled');
  }

  /** A chat message: into the PTY as a bracketed paste, then Enter. The turn starts when Claude Code says it took the prompt (UserPromptSubmit). */
  private async wrapTurn(said: string, lane?: { agent: string; action: 'message' | 'stop' }) {
    try {
      const text = !lane ? said : lane.action === 'stop' ? `Use the TaskStop tool to stop the background sub-agent ${lane.agent}. Do nothing else.`
        : `Use the SendMessage tool to send the message below to the sub-agent with id ${lane.agent}, word for word. Do nothing else and do not reply to it yourself.\n\n<message>\n${said}\n</message>`;
      if (!lane) this.append({ hefyn: 'user', text });
      else if (lane.action === 'message') this.logLane(lane.agent, { hefyn: 'user', text: said }); // in the sub-agent's lane, not the main transcript
      this.echo = pasteText(text).trim();
      if (this.pty && !this.pty.watching && this.stampOf(this.assistant()) !== this.stamp) this.closePty(true); // an Assistant changed: the next start (the session resumes) picks it up
      await this.ensurePty();
      const pty = this.pty;
      if (!pty) throw new HostError(502, `${this.name} stopped. Try again.`);
      const taken = new Promise<void>((resolve, reject) => { this.submitted = resolve; setTimeout(() => reject(new HostError(504, `${this.name} did not take the message. Try again.`)), 20_000).unref(); });
      if (this.dirty) { this.dirty = false; pty.write('\x03'); await sleep(200); } // an interrupted prompt may be back in the composer
      pty.write(`\x1b[200~${pasteText(text)}\x1b[201~`);
      await sleep(80);
      pty.write('\r');
      await taken;
    } catch (e) {
      this.submitted = undefined;
      try {
        this.append({ hefyn: 'error', message: e instanceof LockedError ? 'Your data is locked. Sign in again.' : e instanceof HostError ? e.message : `${this.name} stopped: ${(e as Error)?.message ?? e}` });
        this.endTurn('error');
      } catch { /* locked */ }
      this.busy = false; this.publish();
    }
  }

  /** What Claude Code's hooks say. Returns what the hook is answered with: nothing but `{}`, except for a permission question. */
  private async hook(event: string, body: unknown): Promise<unknown> {
    const b = body as any;
    if (!this.pty || !b || typeof b !== 'object' || b.session_id !== this.sessionId) return {};
    await this.drain();
    if (!this.pty) return {};
    switch (event) {
      case 'UserPromptSubmit': {
        const prompt = String(b.prompt ?? '');
        if (b.prompt_id && b.prompt_id === this.promptId) break;
        this.promptId = b.prompt_id;
        this.turnCtl = new AbortController(); // a new turn (from the chat or typed in the terminal): the gateway answers again
        if (!this.busy) { this.busy = true; this.output = 0; }
        else this.output = 0;
        if (this.echo !== undefined && prompt.trim() === this.echo) this.echo = undefined; // hefyn's own: logged when it was sent
        else if (!isSystemPrompt(prompt)) this.append({ hefyn: 'user', text: prompt, via: 'terminal' }); // typed in the terminal
        this.append({ hefyn: 'turn_start' });
        this.publish();
        this.submitted?.(); this.submitted = undefined;
        break;
      }
      case 'SubagentStart': if (this.agentOf(b)) this.lane(b.agent_id, b.agent_type); break;
      case 'SubagentStop': {
        const id = this.agentOf(b);
        if (id && this.lanes.has(id)) { await sleep(300); await this.drain(); this.endLane(id, 'done'); } // its last lines are written behind the hook, like the main transcript's
        break;
      }
      case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure': {
        const id = this.agentOf(b), m = id ? this.lane(id, b.agent_type).mapper : this.mapper;
        if (event === 'PreToolUse') await this.lineFirst(m, b.tool_use_id);
        for (const u of m.hook(event, b)) id ? this.logLane(id, u) : this.emit(u);
        if (event !== 'PreToolUse' && typeof b.tool_use_id === 'string') for (const [rid, p] of this.perms) if (p.tool === b.tool_use_id) this.settle(rid, event === 'PostToolUse' && !(typeof b.tool_response === 'string' && /^Error:/.test(b.tool_response)) ? 'allow' : 'deny'); // answered in the terminal, or by a rule of Claude Code's own
        break;
      }
      case 'PermissionRequest': return this.ask(b);
      case 'Stop': if (this.busy) void this.finishTurn('end_turn', this.dones); break;
      case 'StopFailure': if (this.busy) void this.finishTurn('error', this.dones, String(b.last_assistant_message || `${this.name} could not get an answer from the model.`).slice(0, 500)); break;
    }
    return {};
  }
  /** A permission question of Claude Code: the chat's card, answered through the hook's response. If the terminal answers first, the hook is released and the card closes. */
  private ask(b: any): Promise<unknown> | {} {
    if (b.tool_name === 'AskUserQuestion') { this.append({ hefyn: 'error', message: `${this.name} is asking you a question. Open the Terminal view to answer it.` }); return {}; }
    // a sub-agent's question is asked in the main view (its card carries `by`): the reader answers where they are looking
    const requestId = randomUUID(), by = this.agentOf(b), tool = (by ? this.lane(by, b.agent_type).mapper : this.mapper).toolFor(b);
    const options = permissionOptions(b);
    return new Promise((resolve) => {
      this.perms.set(requestId, { options, tool, agent: by, kind: typeof b.tool_name === 'string' ? b.tool_name : undefined, resolve: (id) => resolve(hookDecision(b, id)) });
      this.publish();
      this.append({ hefyn: 'permission', requestId, toolCall: permissionCall(b, tool ?? requestId), options, ...(by ? { by } : {}) });
    });
  }
  /** The validated `agent_id` of a hook payload (a sub-agent's tool or question), or undefined. */
  private agentOf(b: any): string | undefined { return typeof b?.agent_id === 'string' && AGENT_ID.test(b.agent_id) ? b.agent_id : undefined; }
  /** The terminal answered a question the chat also showed (or Claude Code let the tool run on a rule of its own): close the card, release the hook without a decision. `by: 'claude'` = nobody clicked in the chat. */
  private settle(requestId: string, optionId: string) {
    const p = this.perms.get(requestId);
    if (!p) return;
    this.perms.delete(requestId);
    p.resolve(null);
    this.publish();
    this.append({ hefyn: 'permission_resolved', requestId, optionId, by: 'claude' });
  }

  // ---- terminal view ----
  get terminalOpen() { return this.pty ? true : !!this.term; }
  async openTerminal(cols: number, rows: number, theme?: 'light' | 'dark') {
    if (theme) this.theme = theme;
    else theme = this.theme;
    if (this.wrapped()) {
      // Claude Code reads its theme at start: an idle terminal started in the other theme is restarted (the session resumes)
      if (this.pty && theme && this.ptyTheme && theme !== this.ptyTheme && !this.busy && !this.perms.size && !this.pty.watching) this.closePty(true);
      await this.ensurePty(cols, rows, theme);
      await this.pty?.resize(cols, rows).catch(() => {});
      return;
    }
    if (this.term) { this.term.active = Date.now(); await this.term.proc.resize(cols, rows).catch(() => {}); return; }
    if (this.busy || this.opening) throw new HostError(409, this.opening ? 'The terminal is starting.' : `${this.name} is answering in the chat right now. Wait for it to finish, then open the terminal.`);
    this.opening = true;
    try {
      const { profile, version } = this.agent();
      const unlease = lease(profile.registryId, version); // until the terminal's process is gone
      try { await this.acquireModel(); } catch (e) { unlease(); throw e; } // before the agent process goes: the socket lives as long as any session of the conversation
      this.closeAcp(); // one agent at a time on this conversation's session; the chat view resumes it lazily
      let proc: Proc;
      try {
        const sid = this.storedSession();
        const asst = this.assistant();
        await this.applyAssistant(profile, asst);
        const l = terminalLaunch(profile, version, sid, theme, undefined, this.choose(profile, asst));
        proc = await this.launch({ cmd: l.cmd, env: l.env, tty: true, cwd: this.cwd(), cols, rows });
      } catch (e) { unlease(); this.releaseModel(); throw e; }
      const term: Term = { proc, scroll: [], size: 0, active: Date.now(), subs: new Set() };
      proc.stream.on('data', (b: Buffer) => {
        this.termOut = Date.now(); this.publish();
        clearTimeout(this.termTimer); this.termTimer = setTimeout(() => this.publish(), 10_100); this.termTimer.unref(); // look again once it has been quiet long enough
        term.scroll.push(b); term.size += b.length;
        while (term.size > 256 * 1024 && term.scroll.length) { const over = term.size - 256 * 1024, f = term.scroll[0]!; if (f.length <= over) { term.scroll.shift(); term.size -= f.length; } else { term.scroll[0] = f.subarray(over); term.size -= over; } }
        for (const s of term.subs) s.data(b);
      });
      proc.stream.on('error', () => {});
      proc.stream.on('close', () => {
        unlease();
        if (this.term !== term) return;
        this.term = undefined; this.publish();
        for (const s of term.subs) s.end();
        this.releaseModel();
      });
      this.term = term;
    } finally { this.opening = false; }
  }
  private needTerm() { if (!this.term) throw new HostError(409, 'The terminal is not open.'); return this.term; }
  /** The scrollback first (as one chunk), then live output. `end` is called when the terminal ends. */
  terminalStream(first: (b: Buffer) => void, push: (b: Buffer) => void, end: () => void) {
    if (this.pty) { const stop = this.pty.watch(first, push, end); this.publish(); return () => { stop(); this.publish(); }; }
    const t = this.needTerm(), sub = { data: push, end };
    first(Buffer.concat(t.scroll));
    t.subs.add(sub); t.active = Date.now();
    return () => { t.subs.delete(sub); t.active = Date.now(); };
  }
  terminalInput(data: string) {
    if (this.pty) {
      if (this.busy && (data === '\x1b' || data === '\x03')) this.stopped(); // Esc / Ctrl-C typed in the terminal interrupts the turn: the chat ends it too
      this.pty.write(data); return;
    }
    const t = this.needTerm(); t.active = Date.now(); t.proc.stream.write(data);
  }
  async terminalResize(cols: number, rows: number) {
    if (this.pty) return this.pty.resize(cols, rows);
    const t = this.needTerm(); t.active = Date.now(); await t.proc.resize(cols, rows);
  }
  closeTerminal() { if (this.pty) this.closePty(); else this.term?.proc.stream.destroy(); }

  // ---- lifetime ----
  sweep(now: number) {
    const idle = this.host.deps.idleMs ?? IDLE_MS;
    // idle = no turn, no open question, no sub-agent at work and no terminal watched; an open chat page does not count as use (the next message starts the agent again, resumed)
    if (this.holds() && this.idle() && now - this.lastUse() > idle) this.stopIdle();
  }
  private idle() {
    return !this.busy && !this.perms.size && !this.ptyStarting && !this.opening && !(this.pty?.watching) && !(this.term?.subs.size) && ![...this.lanes.values()].some((l) => l.running);
  }
  /** Something of this chat holds a sandbox process. */
  private holds() { return !!(this.proc || this.pty || this.term); }
  lastUse() { return Math.max(this.active, this.pty?.active ?? 0, this.term?.active ?? 0); }
  /** Can this chat give its sandbox process up now (it holds one and is idle)? */
  stoppable() { return this.holds() && this.idle(); }
  stopIdle() { this.closeAcp(); this.closePty(); this.closeTerminal(); }
  async close() { this.closeAcp(); this.closePty(); this.closeTerminal(); }
}

export class CliHost {
  private sessions = new Map<string, CliSession>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly deps: HostDeps, private sweepMs = 30_000) {}

  session(userId: string, conversationId: string): CliSession {
    let s = this.sessions.get(conversationId);
    if (!s) this.sessions.set(conversationId, (s = new CliSession(this, userId, conversationId)));
    this.timer ??= setInterval(() => { for (const x of this.sessions.values()) x.sweep(Date.now()); }, this.sweepMs).unref();
    return s;
  }
  /** The user's sandbox cap is reached: the least recently used idle chat of theirs (never `except`, never one with a turn or a question) gives its process up. Returns whether one did. */
  freeSandbox(userId: string, except?: CliSession): boolean {
    const s = [...this.sessions.values()].filter((x) => x !== except && x.userId === userId && x.stoppable()).sort((a, b) => a.lastUse() - b.lastUse())[0];
    s?.stopIdle();
    return !!s;
  }
  peek(conversationId: string) { return this.sessions.get(conversationId); }
  /** A deleted chat: end its agent process and forget the session. */
  forget(conversationId: string) { const s = this.sessions.get(conversationId); this.sessions.delete(conversationId); void s?.close(); }
  /** Chats with a turn in flight (a restart waits for them). */
  busyCount() { return [...this.sessions.values()].filter((s) => s.busy).length; }
  /** Stop everything of one user (their key is going away). */
  async closeUser(userId: string) { await Promise.all([...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.close())); }
  async closeAll() { clearInterval(this.timer); this.timer = undefined; await Promise.all([...this.sessions.values()].map((s) => s.close())); }
}
export type { CliSession };

let shared: CliHost | undefined;
// every sandbox creation (seed, exec, attach) frees an idle chat at the user's cap; a deleted chat stops its process
setFreeRoom((userId, conversationId) => !!shared?.freeSandbox(userId, shared.peek(conversationId)));
setStopChat((_u, conversationId) => shared?.forget(conversationId));
/** The host of this process: the runner's attach and the real model socket. */
export const cliHost = () => (shared ??= new CliHost({ attach: runnerAttach(), listenModel: listenModelSocket, listenAuth: listenAuthSocket }));
