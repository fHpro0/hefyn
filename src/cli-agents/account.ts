import { Hono } from 'hono';
import { permissionsOf } from '../server/runner.ts';
import { type Scope, failureReason, loginCommand, loginEnv, loginStatus, parseLoginOutput } from './agent-login.ts';
import { type Attach, runnerAttach } from './attach.ts';
import { HostError } from './host.ts';
import { rowOf } from './installed.ts';
import { accountConversation, forgetSignedIn, listenAuthSocket } from './own-account.ts';
import { Pty } from './pty.ts';
import { profileOf } from './profiles.ts';
import { size, sse } from './routes.ts';
import { TEAM_ACCOUNTS_PERMISSION, teamAccount, sharedLoginPossible } from './team-accounts.ts';

// Agent accounts, "Sign in" (docs/WRAPPER.md): the agent's own login command (manifest `login`) runs in a PTY in the user's sandbox behind the agent's egress proxy.
// The screen is read for the sign-in address and device code, which the dialog shows as a button and a code; a code the page gives is typed into the CLI's own prompt.
// The login's output and the code live in memory only and are never logged or stored; what the login writes goes to the account home in the sandbox (agent-login.ts).
// For an agent with no scriptable flow (flow: terminal) the same PTY is shown as a terminal. A `team` sign-in (an admin, accounts.team) goes to the team account home.

export type Phase = 'starting' | 'waiting' | 'checking' | 'done' | 'failed';
interface Session {
  agent: string; scope: Scope; flow: 'code' | 'device' | 'terminal'; pty: Pty; auth: { close(): void }; timer: ReturnType<typeof setTimeout>;
  buf: string; phase: Phase; url?: string; code?: string; account?: string; reason?: string; version: string;
}
export interface AccountDeps { attach: Attach; listenAuth?: typeof listenAuthSocket; ttlMs?: number; status?: typeof loginStatus }
const KEEP = 64 * 1024; // of the screen: enough for an address, never more than this in memory

export class AccountHost {
  private sessions = new Map<string, Session>();
  constructor(private deps: AccountDeps = { attach: runnerAttach() }) {}

  /** Start the sign-in of `agent` (or resize the one that runs). */
  async open(userId: string, agent: string, scope: Scope, cols: number, rows: number) {
    const have = this.sessions.get(userId);
    if (have && !have.pty.ended && have.agent === agent && have.scope === scope) { if (have.flow === 'terminal') await have.pty.resize(cols, rows).catch(() => {}); return; }
    if (have) this.drop(userId, have);
    const profile = profileOf(agent), row = rowOf(agent), login = profile?.spec.login;
    if (!profile || !login || !row || row.status !== 'ready' || !row.enabled) throw new HostError(409, 'This agent is not available.');
    if (!permissionsOf(userId).includes('sandbox.shell')) throw new HostError(403, 'Your role is not allowed to use the sandbox. Ask an administrator.');
    if (scope === 'team') {
      if (!permissionsOf(userId).includes(TEAM_ACCOUNTS_PERMISSION)) throw new HostError(403, 'Only people who manage team accounts can sign in for the team.');
      if (!teamAccount(agent).loginEnabled || !sharedLoginPossible(agent)) throw new HostError(409, `The shared team login of ${profile.name} is not turned on.`);
    }
    const conv = accountConversation(userId), auth = await (this.deps.listenAuth ?? listenAuthSocket)(userId, conv, login.hosts);
    let pty: Pty;
    try {
      const wide = login.flow !== 'terminal'; // an address must not be broken across lines
      const env = { ...loginEnv(profile, row.version, scope), TERM: 'xterm-256color' };
      pty = new Pty(await this.deps.attach(userId, conv, { cmd: ['/opt/hefyn/run-agent.sh', 'sh', '-c', loginCommand(profile, row.version)], tty: true, cwd: '/tmp', cols: wide ? 1000 : cols, rows, env }));
    } catch (e) { auth.close(); throw e; }
    const s: Session = { agent, scope, flow: login.flow, pty, auth, buf: '', phase: 'starting', version: row.version, timer: setTimeout(() => this.drop(userId, s), this.deps.ttlMs ?? 15 * 60_000) };
    s.timer.unref();
    pty.onData = (b) => {
      s.buf = (s.buf + b.toString('utf8')).slice(-KEEP);
      if (s.flow !== 'terminal' && s.phase === 'starting') {
        const p = parseLoginOutput(login, s.buf);
        if (p.url && (s.flow !== 'device' || p.code)) { s.url = p.url; s.code = p.code; s.phase = 'waiting'; }
      }
    };
    pty.onEnd = () => void this.finished(userId, s);
    this.sessions.set(userId, s);
  }
  /** The login process ended: ask the agent whether it worked. */
  private async finished(userId: string, s: Session) {
    if (this.sessions.get(userId) !== s) return; // closed or replaced: nothing to report
    s.phase = 'checking'; s.auth.close();
    const st = await (this.deps.status ?? loginStatus)(userId, profileOf(s.agent)!, s.version, s.scope);
    if (this.sessions.get(userId) !== s) return;
    forgetSignedIn(userId);
    if (st.signedIn) { s.phase = 'done'; s.account = st.account; } else { s.phase = 'failed'; s.reason = failureReason(s.buf); }
    s.buf = ''; s.url = s.code = undefined; // nothing of the screen is kept once it is over
  }
  private drop(userId: string, s: Session) {
    clearTimeout(s.timer); s.pty.kill(); s.auth.close(); s.buf = '';
    if (this.sessions.get(userId) === s) this.sessions.delete(userId);
  }
  state(userId: string) {
    const s = this.sessions.get(userId);
    if (!s) return { phase: 'idle' as const };
    return { phase: s.phase, agent: s.agent, scope: s.scope, flow: s.flow, ...(s.url ? { url: s.url } : {}), ...(s.code ? { code: s.code } : {}), ...(s.account ? { account: s.account } : {}), ...(s.reason ? { reason: s.reason } : {}) };
  }
  /** The code the sign-in page shows, typed into the CLI's own prompt (like the terminal did). Not stored, not logged. */
  submitCode(userId: string, code: string) {
    const s = this.sessions.get(userId);
    if (!s || s.pty.ended || s.flow !== 'code' || s.phase !== 'waiting') throw new HostError(409, 'The sign-in is not waiting for a code. Start it again.');
    if (!/^[\w\-#.~+/=]{4,4000}$/.test(code)) throw new HostError(400, 'That does not look like a sign-in code. Copy the whole code from the page.');
    s.pty.write(`${code}\r`);
  }
  private need(userId: string) { const s = this.sessions.get(userId); if (!s || s.pty.ended) throw new HostError(409, 'The sign-in is not running. Start it again.'); return s; }
  running(userId: string) { const s = this.sessions.get(userId); return !!s && !s.pty.ended; }
  watch(userId: string, first: (b: Buffer) => void, push: (b: Buffer) => void, end: () => void) { return this.need(userId).pty.watch(first, push, end); }
  input(userId: string, data: string) { const s = this.need(userId); if (s.flow === 'terminal') s.pty.write(data); }
  resize(userId: string, cols: number, rows: number) { const s = this.need(userId); return s.flow === 'terminal' ? s.pty.resize(cols, rows) : undefined; }
  close(userId: string) { const s = this.sessions.get(userId); if (s) this.drop(userId, s); }
}

/** /agents/account/<u_user_signin>/{open,state,code,stream,input,resize,close}: web's agentGuard has proved the caller is that user. */
export function accountRoutes(host: AccountHost) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((e, c) => (e instanceof HostError ? c.json({ error: e.message }, e.status as 400) : (console.error(e), c.json({ error: 'internal error' }, 500))));
  app.use('/:conv/*', async (c, next) => {
    const userId = /^u_([A-Za-z0-9-]+)_signin$/.exec(c.req.param('conv'))?.[1];
    if (!userId) return c.json({ error: 'not found' }, 404);
    c.set('userId', userId);
    await next();
  });
  app.post('/:conv/open', async (c) => {
    const b = await c.req.json().catch(() => ({})), sz = size(b);
    if (!sz) return c.json({ error: 'cols and rows are required' }, 400);
    if (typeof b.agent !== 'string' || (b.scope !== undefined && b.scope !== 'personal' && b.scope !== 'team')) return c.json({ error: 'agent is required' }, 400);
    await host.open(c.get('userId'), b.agent, b.scope ?? 'personal', sz.cols, sz.rows);
    return c.json({ ok: true });
  });
  app.get('/:conv/state', (c) => c.json(host.state(c.get('userId'))));
  app.post('/:conv/code', async (c) => {
    const code = (await c.req.json().catch(() => ({})))?.code;
    if (typeof code !== 'string') return c.json({ error: 'code is required' }, 400);
    host.submitCode(c.get('userId'), code.trim());
    return c.json({ ok: true });
  });
  app.get('/:conv/stream', (c) => {
    const id = c.get('userId');
    if (!host.running(id)) return c.json({ error: 'The sign-in is not running. Start it again.' }, 409);
    return sse(c.req.raw.signal, (send, end) => host.watch(id, (b) => send(b.toString('base64')), (b) => send(b.toString('base64')), end));
  });
  app.post('/:conv/input', async (c) => {
    const d = (await c.req.json().catch(() => ({})))?.data;
    if (typeof d !== 'string' || d.length > 100_000) return c.json({ error: 'data is required' }, 400);
    host.input(c.get('userId'), d);
    return c.json({ ok: true });
  });
  app.post('/:conv/resize', async (c) => {
    const sz = size(await c.req.json().catch(() => ({})));
    if (!sz) return c.json({ error: 'cols and rows are required' }, 400);
    await host.resize(c.get('userId'), sz.cols, sz.rows);
    return c.json({ ok: true });
  });
  app.post('/:conv/close', (c) => { host.close(c.get('userId')); return c.json({ ok: true }); });
  return app;
}

let shared: AccountHost | undefined;
export const accountHost = () => (shared ??= new AccountHost());
