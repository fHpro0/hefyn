import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// hefyn egress proxy: HTTP forward proxy (plain HTTP + CONNECT) with a host allowlist and a token. The agent container has
// no other route out. The allowlist (host:port keys) is polled from the web service, which derives it from app.db:
// connected providers (company and per-user), OAuth token endpoints of signed-in providers, MCP connector hosts.
// Playwright containers (hefyn-pw-<16 hex>) are always allowed: they are managed by the runner. Zero dependencies.

export interface Config { port: number; token: string; allowlistUrl: string; refreshMs: number }
export const loadConfig = (e: Record<string, string | undefined> = process.env): Config => ({
  port: Number(e.PORT) || 3128,
  token: e.HEFYN_INTERNAL_TOKEN ?? '',
  allowlistUrl: e.HEFYN_EGRESS_ALLOWLIST_URL ?? 'http://web:3000/internal/egress-allowlist',
  refreshMs: Number(e.HEFYN_EGRESS_REFRESH_MS) || 5000,
});

const PLAYWRIGHT = /^hefyn-pw-[0-9a-f]{16}$/;
const digest = (s: string) => createHash('sha256').update(s).digest();
export const tokenOk = (given: string, expected: string) => !!expected && timingSafeEqual(digest(given), digest(expected));

/** `Proxy-Authorization: Basic base64(user:token)` (clients take it from http://user:token@egress:3128). */
export function authOk(header: string | undefined, token: string): boolean {
  const m = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return tokenOk(decoded.slice(decoded.indexOf(':') + 1), token);
}

export const keyOf = (host: string, port: number) => `${host.toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
export const allowed = (hosts: Set<string>, host: string, port: number) => hosts.has(keyOf(host, port)) || (PLAYWRIGHT.test(host) && port === 8931);

export function createProxy(cfg: Config, log: (o: Record<string, unknown>) => void = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))) {
  let hosts = new Set<string>();
  let loaded = false;
  async function refresh() {
    try {
      const res = await fetch(cfg.allowlistUrl, { headers: { 'x-hefyn-internal': cfg.token }, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      hosts = new Set(((await res.json()) as { hosts: string[] }).hosts.map((h) => h.toLowerCase()));
      loaded = true;
    } catch (e) { log({ level: 'warn', msg: 'allowlist refresh failed, keeping the last list', err: String((e as Error).message) }); }
  }

  const decide = (method: string, host: string, port: number) => {
    const ok = allowed(hosts, host, port);
    log({ level: 'info', msg: 'connection', method, host, port, decision: ok ? 'allowed' : 'blocked' }); // conversation-agnostic: no user data
    return ok;
  };
  const deny = (res: http.ServerResponse | Duplex, status: number, text: string) => {
    if (!('writeHead' in res)) { res.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="hefyn-egress"\r\n' : ''}\r\n`); return; }
    res.writeHead(status, { 'content-type': 'text/plain', ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="hefyn-egress"' } : {}) }).end(text + '\n');
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(200).end('ok');
    if (!authOk(req.headers['proxy-authorization'] as string | undefined, cfg.token)) return deny(res, 407, 'proxy authentication required');
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { return deny(res, 400, 'absolute URL required'); }
    if (u.protocol !== 'http:') return deny(res, 400, 'only http: via plain proxying; use CONNECT for https');
    const port = Number(u.port) || 80;
    if (!loaded || !decide(req.method ?? 'GET', u.hostname, port)) return deny(res, 403, 'host not allowed by the hefyn egress proxy');
    const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const up = http.request({ host: u.hostname, port, method: req.method, path: u.pathname + u.search, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) deny(res, 502, 'upstream unreachable'); else res.destroy(); });
    req.pipe(up);
  });

  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    if (!authOk(req.headers['proxy-authorization'] as string | undefined, cfg.token)) return deny(socket, 407, 'Proxy Authentication Required');
    const m = /^(.+):(\d+)$/.exec(req.url ?? '');
    if (!m) return deny(socket, 400, 'Bad Request');
    const host = m[1], port = Number(m[2]);
    if (!loaded || !decide('CONNECT', host, port)) return deny(socket, 403, 'Forbidden');
    const up = net.connect(port, host.replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => deny(socket, 502, 'Bad Gateway'));
    socket.on('close', () => up.destroy());
  });
  return { server, refresh };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (process.env.NODE_ENV === 'production' && (!cfg.token || cfg.token.length < 32 || cfg.token.startsWith('dev-only'))) { console.error('[hefyn-egress] HEFYN_INTERNAL_TOKEN is missing, a placeholder, or shorter than 32 characters. Fix: run "bun run init".'); process.exit(1); }
  const { server, refresh } = createProxy(cfg);
  await refresh();
  const timer = setInterval(refresh, cfg.refreshMs);
  server.listen(cfg.port, () => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'egress proxy listening', port: cfg.port })));
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
