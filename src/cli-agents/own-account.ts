import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerFs } from '../server/container-fs.ts';
import { baseDir } from '../server/storage.ts';
import { DUMMY_KEY } from './manifest-profile.ts';
import { type Launch, type Seed } from './profiles.ts';

// Claude Code on the user's OWN Claude account (docs/WRAPPER.md "Sign-in and model traffic"). hefyn does not handle that login: Claude Code's own `/login` or
// `claude auth login` writes its credentials into a per-user Claude home on the data volume (users/<uid>/claude-home), which the runner mounts at /claude-home in
// that user's sandboxes only and Claude Code uses as its config dir. No hefyn process opens, copies or forwards what is in it: whether someone is signed in is asked
// of the sandbox (the runner's exec), and model traffic goes from Claude Code to Anthropic through an HTTPS CONNECT proxy that allows Anthropic's hosts only.

export const CLAUDE_HOME = '/claude-home';
/** The hosts Claude Code needs on a subscription login. Measured with Claude Code 2.1.310 behind a refusing proxy (docs/WRAPPER.md): api.anthropic.com (model, profile),
 *  platform.claude.com (token exchange and refresh), claude.ai. It also tried downloads.claude.ai (update check) and github.com (plugin marketplace): both are not needed and stay refused. */
export const ANTHROPIC_HOSTS = ['api.anthropic.com:443', 'platform.claude.com:443', 'claude.ai:443'];
export const AUTH_PORT = 47001; // in the sandbox: bridge.mjs, 127.0.0.1:AUTH_PORT -> /tmp/.hefyn/auth.sock
/** The sandbox the sign-in terminal and the account status run in (no chat behind it). Id shape as every conversation id (u_<user>_<id>). */
export const accountConversation = (userId: string) => `u_${userId}_signin`;

/** HTTPS through the proxy, everything local (the hook and model bridge on 127.0.0.1) direct. */
export const proxyEnv = (): Record<string, string> => {
  const proxy = `http://127.0.0.1:${AUTH_PORT}`;
  return { HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
};

/** A launch on the user's own account: no base URL and no dummy key (the model is reached directly, through the proxy), the Claude home as config dir (the seeds follow it),
 *  and the transcript directory of the conversation behind a link in it, so that hefyn reads transcripts from the conversation's /tmp and never from the home. */
export function ownLaunch(l: Launch): Launch {
  const env: Record<string, string> = Object.fromEntries(Object.entries(l.env).filter(([k, v]) => k !== 'ANTHROPIC_BASE_URL' && v !== DUMMY_KEY));
  Object.assign(env, proxyEnv(), { CLAUDE_CONFIG_DIR: CLAUDE_HOME });
  if (env.HEFYN_SEED) { // the seeds follow the config dir, and approve no dummy key (there is none)
    env.HEFYN_SEED = JSON.stringify((JSON.parse(env.HEFYN_SEED) as Seed[]).map((s) => {
      const p = { ...s, path: inHome(s.path) };
      if ('json' in p && p.json.customApiKeyResponses) { const { customApiKeyResponses: _k, ...json } = p.json; return { ...p, json }; }
      return p;
    }));
  }
  const [run, ...rest] = l.cmd, i = rest.indexOf('-c');
  if (i >= 0) rest[i + 1] = `mkdir -p /tmp/.claude/projects; ln -sfn /tmp/.claude/projects ${CLAUDE_HOME}/projects; ${rest[i + 1]}`;
  return { cmd: [run, ...rest], env };
}
/** Where an agent's config (instructions, skills, commands) goes on the own account: in the home, which the next session of the user shares. */
export const inHome = (path: string) => path.replace(/^\/tmp\/\.claude(?=\/|$)/, CLAUDE_HOME);

/** A launch on a SHARED team login (an admin signed in once into `teamHome`, mounted for the allowed roles): the config dir stays the conversation's own /tmp/.claude (so nothing
 *  of one user's settings, skills or transcripts reaches another), and only the credentials file there is a link to the team's. Same direct, proxied model traffic as ownLaunch. */
export function teamLaunch(l: Launch, teamHome: string): Launch {
  const env: Record<string, string> = Object.fromEntries(Object.entries(l.env).filter(([k, v]) => k !== 'ANTHROPIC_BASE_URL' && v !== DUMMY_KEY));
  Object.assign(env, proxyEnv());
  if (env.HEFYN_SEED) {
    env.HEFYN_SEED = JSON.stringify((JSON.parse(env.HEFYN_SEED) as Seed[]).map((s) => {
      if ('json' in s && s.json.customApiKeyResponses) { const { customApiKeyResponses: _k, ...json } = s.json; return { ...s, json }; }
      return s;
    }));
  }
  const [run, ...rest] = l.cmd, i = rest.indexOf('-c');
  if (i >= 0) rest[i + 1] = `mkdir -p /tmp/.claude; ln -sfn ${teamHome}/.credentials.json /tmp/.claude/.credentials.json; ${rest[i + 1]}`;
  return { cmd: [run, ...rest], env };
}

/** Is this user signed in? Asked of the sandbox (a size test of the credentials file there): hefyn never reads the file. `home`: the team's home instead of the user's own. */
export async function signedIn(userId: string, conversationId: string, home = CLAUDE_HOME): Promise<boolean> {
  const r = await containerFs({ userId, conversationId }).run(['test', '-s', `${home}/.credentials.json`], { cwd: '/tmp', timeoutMs: 30_000 });
  return r.exitCode === 0;
}

const seen = new Map<string, { at: number; v: boolean }>();
/** The same question for pickers and lists (the web process): asked of the user's account sandbox, remembered for 30 seconds. Unreachable = not signed in. */
export async function signedInCached(userId: string, now = Date.now()): Promise<boolean> {
  const c = seen.get(userId);
  if (c && now - c.at < 30_000) return c.v;
  const v = await signedIn(userId, accountConversation(userId)).catch(() => false);
  seen.set(userId, { at: now, v });
  return v;
}
export const forgetSignedIn = (userId: string) => void seen.delete(userId);

/** (The status and logout commands are the manifest's `login` block: agent-login.ts.) What `claude auth status` printed: signed in or not, plus the account label Claude Code itself shows (never a token: the command prints none). */
export function parseStatus(stdout: string): { signedIn: boolean; account?: string } {
  let j: any; try { j = JSON.parse(stdout); } catch { return { signedIn: false }; }
  const plan = typeof j?.subscriptionType === 'string' && /^[a-z]{2,20}$/i.test(j.subscriptionType) ? `Claude ${j.subscriptionType[0].toUpperCase()}${j.subscriptionType.slice(1)}` : undefined;
  const email = typeof j?.email === 'string' ? j.email.slice(0, 200) : undefined;
  return { signedIn: j?.loggedIn === true, ...(email || plan ? { account: [email, plan && `(${plan})`].filter(Boolean).join(' ') } : {}) };
}

// ---- the proxy ----
// shortcut: a tunnel is cut after 10 idle minutes but has no byte cap and an allowed host may receive anything the sandbox sends it. Anthropic's hosts accept data only
// as API traffic for an account the sender would have to hold; add a cap if abuse of that path matters.

/** A TCP connection to `to`, or a CONNECT tunnel to it through `via` (the agent's only way out is the egress proxy, docker-compose.yml). */
function openUpstream(to: { host: string; port: number }, via?: URL): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = via ? net.connect(Number(via.port) || 80, via.hostname) : net.connect(to.port, to.host);
    s.on('error', reject); // stays: a later error is the caller's to handle, rejecting again is a no-op
    s.on('connect', () => {
      if (!via) return resolve(s);
      const auth = via.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(via.username)}:${decodeURIComponent(via.password)}`).toString('base64')}\r\n` : '';
      s.write(`CONNECT ${to.host}:${to.port} HTTP/1.1\r\nHost: ${to.host}:${to.port}\r\n${auth}\r\n`);
      let reply = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        reply = Buffer.concat([reply, d]);
        const end = reply.indexOf('\r\n\r\n');
        if (end < 0) { if (reply.length > 8192) { s.destroy(); reject(new Error('upstream proxy reply too long')); } return; }
        s.off('data', onData); s.pause();
        if (!/^HTTP\/1\.[01] 200[ \r]/.test(reply.toString('latin1', 0, end))) { s.destroy(); return reject(new Error('upstream proxy refused')); }
        if (end + 4 < reply.length) s.unshift(reply.subarray(end + 4));
        resolve(s);
      };
      s.on('data', onData);
    });
  });
}

/** An HTTP CONNECT proxy that tunnels to `hosts` (`host:port`) and refuses everything else, plain HTTP included. Outbound goes through `upstream` (an HTTP proxy URL) when set. */
export function createAuthProxy(hosts: string[], dial: (host: string, port: number) => { host: string; port: number } = (host, port) => ({ host, port }), upstream = process.env.HTTPS_PROXY || process.env.https_proxy) { // dial: tests point an allowed name at a stand-in
  const ok = new Set(hosts.map((h) => h.toLowerCase())), via = upstream ? new URL(upstream) : undefined;
  const server = http.createServer((_req, res) => void res.writeHead(405, { allow: 'CONNECT' }).end());
  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const m = /^([^:\s]+):(\d+)$/.exec(req.url ?? '');
    if (!m || !ok.has(`${m[1].toLowerCase()}:${m[2]}`)) return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    openUpstream(dial(m[1], Number(m[2])), via).then((up) => {
      if (socket.destroyed) return void up.destroy();
      const drop = () => { up.destroy(); socket.destroy(); };
      up.on('error', drop); socket.on('close', drop); up.on('close', drop); (socket as net.Socket).setTimeout(10 * 60_000, drop);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    }, () => void socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  });
  return server;
}

/** The proxy on the conversation's sandbox: <data>/users/<uid>/tmp/<conv>/.hefyn/auth.sock, next to the model socket (same short-path trick, host.ts). */
export async function listenAuthSocket(userId: string, conversationId: string, hosts = ANTHROPIC_HOSTS, dial?: Parameters<typeof createAuthProxy>[1]): Promise<{ close(): void }> {
  const dir = join(baseDir(), 'users', userId, 'tmp', conversationId, '.hefyn');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
  const short = join(tmpdir(), `ha-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`);
  rmSync(short, { force: true });
  symlinkSync(dir, short);
  rmSync(join(dir, 'auth.sock'), { force: true });
  const server = createAuthProxy(hosts, dial);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(short, 'auth.sock'), resolve); });
  chmodSync(join(dir, 'auth.sock'), 0o666);
  return { close: () => { server.close(); server.closeAllConnections?.(); rmSync(short, { force: true }); rmSync(join(dir, 'auth.sock'), { force: true }); } };
}
