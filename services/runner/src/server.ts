import { chmodSync, chownSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DockerError, dockerClient, type Docker } from './docker.ts';
import { HttpError, checkHandle, checkId, checkLimits, demux, handleOf, idleHandles, loadConfig, parseExec, tokenOk, type Config, type Kind, type Managed } from './logic.ts';

// hefyn runner: the ONLY component with the Docker socket. It exposes a narrow, token-protected API and can only
// create containers from two fixed images with fixed hardening. Callers never choose image, mounts, network or flags.

const PW_PORT = 8931;
const NAMES: Record<Kind, string> = { sandbox: 'hefyn-sbx-', playwright: 'hefyn-pw-' };
const LABEL = 'hefyn.managed';
type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
export const jsonLog: Log = (level, msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export function createRunner(cfg: Config, docker: Docker, log: Log = jsonLog) {
  const lastUsed = new Map<string, number>(), busy = new Map<string, number>(), locks = new Map<string, Promise<unknown>>();
  let createLock: Promise<unknown> = Promise.resolve();
  let mount: Promise<{ volume?: string; hostDir?: string }> | undefined;
  const key = (kind: Kind, handle: string) => `${kind}:${handle}`;
  const serial = <T>(m: Map<string, Promise<unknown>>, k: string, f: () => Promise<T>): Promise<T> => {
    const p = (m.get(k) ?? Promise.resolve()).catch(() => {}).then(f);
    m.set(k, p); p.finally(() => { if (m.get(k) === p) m.delete(k); }).catch(() => {});
    return p;
  };

  async function listManaged(): Promise<Managed[]> {
    const rows: any[] = await docker.call('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL}=true`] }))}`);
    return rows.map((r) => ({ handle: r.Labels['hefyn.handle'], kind: r.Labels['hefyn.kind'], userId: r.Labels['hefyn.user'], conversationId: r.Labels['hefyn.conversation'] }));
  }
  const inspect = (name: string) => docker.call('GET', `/containers/${name}/json`).catch((e) => { if (e instanceof DockerError && e.status === 404) return undefined; throw e; });
  const remove = (name: string) => docker.call('DELETE', `/containers/${name}?force=true`).catch((e) => { if (!(e instanceof DockerError && e.status === 404)) throw e; });

  async function ensureNetwork(name: string, icc: boolean, internal = false) {
    if (await docker.call('GET', `/networks/${name}`).catch(() => undefined)) return;
    await docker.call('POST', '/networks/create', { Name: name, Driver: 'bridge', Internal: internal, Labels: { [LABEL]: 'true' }, Options: { 'com.docker.network.bridge.enable_icc': String(icc) } }).catch((e) => { if (!(e instanceof DockerError && e.status === 409)) throw e; });
  }

  /** How the Docker daemon can see our data dir: a named volume (subpath mounts, Engine >= 26) or a host directory. */
  function dataMount() {
    return mount ??= (async () => {
      if (cfg.hostDataDir) return { hostDir: cfg.hostDataDir };
      const self = await docker.call('GET', `/containers/${process.env.HOSTNAME}/json`);
      const m = (self.Mounts as any[]).find((x) => x.Destination === cfg.dataDir);
      if (!m) throw new Error(`runner has no mount at ${cfg.dataDir}`);
      return m.Type === 'volume' ? { volume: m.Name as string } : { hostDir: m.Source as string };
    })();
  }
  async function mountFor(sub: string, target: string) {
    const d = await dataMount();
    return d.volume ? { Type: 'volume', Source: d.volume, Target: target, VolumeOptions: { Subpath: sub, NoCopy: true } } /* no copy-up: the image's root-owned /files would replace our dir's ownership */ : { Type: 'bind', Source: join(d.hostDir!, sub), Target: target, BindOptions: { CreateMountpoint: false } };
  }
  /** Create the dirs and hand every new level (not the content: web/agent run as the same uid) to the sandbox uid. */
  function prepare(dir: string) {
    mkdirSync(dir, { recursive: true });
    try {
      for (let p = dir; p.length > cfg.dataDir.length; p = join(p, '..')) chownSync(p, cfg.sandboxUid, cfg.sandboxUid);
    } catch { chmodSync(dir, 0o777); log('warn', 'chown failed, dir made world-writable', { dir }); }
  }

  const baseHost = (net: string, memoryMb: number, pids: number) => ({
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, ReadonlyRootfs: true, NetworkMode: net,
    Memory: memoryMb * 1024 * 1024, MemorySwap: memoryMb * 1024 * 1024, PidsLimit: pids, NanoCpus: Math.round(cfg.cpus * 1e9),
    Init: true, RestartPolicy: { Name: 'no' },
  });

  async function create(kind: Kind, userId: string, conversationId: string, handle: string) {
    const name = NAMES[kind] + handle;
    const Labels = { [LABEL]: 'true', 'hefyn.kind': kind, 'hefyn.handle': handle, 'hefyn.user': userId, 'hefyn.conversation': conversationId };
    if (kind === 'sandbox') {
      const files = join('users', userId, 'files'), tmp = join('users', userId, 'tmp', conversationId);
      prepare(join(cfg.dataDir, files)); prepare(join(cfg.dataDir, tmp));
      await ensureNetwork(cfg.sandboxNetwork, false, cfg.egress === 'none'); // icc off: sandboxes cannot reach each other
      await docker.call('POST', `/containers/create?name=${name}`, {
        Image: cfg.sandboxImage, User: `${cfg.sandboxUid}:${cfg.sandboxUid}`, WorkingDir: '/files', Labels,
        Env: ['HOME=/home/hefyn', 'LANG=C.UTF-8'],
        HostConfig: {
          ...baseHost(cfg.sandboxNetwork, cfg.memoryMb, cfg.pids),
          Mounts: [await mountFor(files, '/files'), await mountFor(tmp, '/tmp')],
          Tmpfs: { '/run': 'rw,noexec,nosuid,size=16m', '/home/hefyn': `rw,nosuid,size=64m,uid=${cfg.sandboxUid},gid=${cfg.sandboxUid}` },
        },
      });
    } else {
      await ensureNetwork(cfg.mcpNetwork, true); // shared with the agent service, which must reach the MCP port
      await docker.call('POST', `/containers/create?name=${name}`, {
        Image: cfg.playwrightImage, Labels, ExposedPorts: { [`${PW_PORT}/tcp`]: {} },
        // Entrypoint of the image already adds --headless --browser chromium --no-sandbox.
        Cmd: ['--host', '0.0.0.0', '--port', String(PW_PORT), '--isolated', '--allowed-hosts', '*'],
        HostConfig: { ...baseHost(cfg.mcpNetwork, cfg.playwrightMemoryMb, 512), ShmSize: 512 * 1024 * 1024, Tmpfs: { '/tmp': 'rw,nosuid,size=256m', '/home/node': 'rw,nosuid,size=128m,uid=1000,gid=1000' } },
      });
    }
    await docker.call('POST', `/containers/${name}/start`);
    log('info', `${kind} started`, { handle, userId });
  }

  /** Idempotent: one container per (kind, user, conversation). Creation is serialised so limits are exact. */
  const ensure = (kind: Kind, { userId, conversationId }: { userId: string; conversationId: string }) => {
    const handle = handleOf(userId, conversationId), name = NAMES[kind] + handle;
    return serial(locks, key(kind, handle), async () => {
      const info = await inspect(name);
      if (info?.State?.Running) { lastUsed.set(key(kind, handle), Date.now()); return { id: handle, name }; }
      createLock = createLock.catch(() => {}).then(async () => {
        if (info) await remove(name); // exited leftover
        checkLimits(await listManaged(), kind, userId, cfg);
        await create(kind, userId, conversationId, handle);
      });
      await createLock;
      lastUsed.set(key(kind, handle), Date.now());
      return { id: handle, name };
    });
  };

  async function owned(kind: Kind, handle: string) {
    const name = NAMES[kind] + handle, info = await inspect(name);
    if (!info || info.Config?.Labels?.[LABEL] !== 'true' || info.Config.Labels['hefyn.kind'] !== kind) throw new HttpError(404, 'not found');
    return { name, info };
  }

  async function exec(handle: string, body: unknown, signal: AbortSignal) {
    const r = parseExec(body, cfg), { name, info } = await owned('sandbox', handle);
    if (!info.State?.Running) throw new HttpError(404, 'sandbox is not running');
    const k = key('sandbox', handle);
    lastUsed.set(k, Date.now()); busy.set(k, (busy.get(k) ?? 0) + 1);
    const started = Date.now();
    try {
      const { Id } = await docker.call('POST', `/containers/${name}/exec`, {
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: r.cwd, Env: r.env,
        Cmd: ['timeout', '-k', '2s', `${r.timeoutMs / 1000}s`, ...r.cmd], // no exec-kill in Docker: `timeout` kills the process group
      });
      const sock = await docker.hijack(Id);
      const d = demux(r.maxOutput);
      let hardTimedOut = false;
      await new Promise<void>((done) => {
        const hard = setTimeout(() => { hardTimedOut = true; sock.destroy(); }, r.timeoutMs + 5000);
        const abort = () => sock.destroy();
        signal.addEventListener('abort', abort);
        sock.on('data', (c: Buffer) => d.push(c));
        sock.on('close', () => { clearTimeout(hard); signal.removeEventListener('abort', abort); done(); });
        sock.on('error', () => {});
        sock.end(r.stdin);
      });
      const { ExitCode } = await docker.call('GET', `/exec/${Id}/json`);
      const exitCode = hardTimedOut ? 124 : ExitCode ?? -1;
      const timedOut = hardTimedOut || ((exitCode === 124 || exitCode === 137) && Date.now() - started >= r.timeoutMs - 100);
      log('info', 'exec', { handle, exitCode, ms: Date.now() - started, timedOut }); // never log commands or output
      return { ...d.result(), exitCode, timedOut };
    } finally { busy.set(k, (busy.get(k) ?? 1) - 1); lastUsed.set(k, Date.now()); }
  }

  async function destroy(kind: Kind, handle: string) {
    const { name } = await owned(kind, handle);
    await remove(name); lastUsed.delete(key(kind, handle)); busy.delete(key(kind, handle));
    log('info', `${kind} removed`, { handle });
  }

  async function reap(now = Date.now()) {
    for (const kind of ['sandbox', 'playwright'] as Kind[]) {
      const mine = new Map([...lastUsed].filter(([k]) => k.startsWith(kind + ':')));
      for (const k of idleHandles(mine, busy, now, cfg.idleMs)) {
        await destroy(kind, k.slice(kind.length + 1)).catch((e) => log('error', 'reap failed', { k, err: String(e) }));
      }
    }
  }
  /** Re-adopt containers that survived a runner restart (fresh idle clock). */
  async function adopt() { for (const c of await listManaged()) lastUsed.set(key(c.kind, c.handle), Date.now()); }

  async function readBody(req: http.IncomingMessage) {
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > cfg.maxBody) throw new HttpError(413, 'body too large'); chunks.push(c); }
    try { return n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new HttpError(400, 'invalid JSON'); }
  }
  const idPair = (b: any) => ({ userId: checkId('user id', b?.userId), conversationId: checkId('conversation id', b?.conversationId) });

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    try {
      if (!tokenOk(req.headers['x-hefyn-internal'] as string | undefined, cfg.token)) throw new HttpError(401, 'unauthorized');
      const url = new URL(req.url ?? '/', 'http://x'), p = url.pathname, m = req.method;
      let match: RegExpExecArray | null;
      if (m === 'GET' && p === '/health') { await docker.call('GET', '/_ping').catch(() => { throw new HttpError(503, 'docker unavailable'); }); return send(200, { ok: true }); }
      if (m === 'POST' && p === '/sandboxes') { const r = await ensure('sandbox', idPair(await readBody(req))); return send(200, { id: r.id }); }
      if (m === 'POST' && p === '/mcp/playwright') { const r = await ensure('playwright', idPair(await readBody(req))); return send(200, { id: r.id, url: `http://${r.name}:${PW_PORT}/mcp` }); }
      if (m === 'POST' && (match = /^\/sandboxes\/([^/]+)\/exec$/.exec(p))) {
        const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        return send(200, await exec(checkHandle(match[1]), await readBody(req), ac.signal));
      }
      if (m === 'DELETE' && (match = /^\/sandboxes\/([^/]+)$/.exec(p))) { await destroy('sandbox', checkHandle(match[1])); return send(200, { ok: true }); }
      if (m === 'DELETE' && (match = /^\/mcp\/playwright\/([^/]+)$/.exec(p))) { await destroy('playwright', checkHandle(match[1])); return send(200, { ok: true }); }
      throw new HttpError(404, 'not found');
    } catch (e: any) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      log('error', 'request failed', { err: String(e?.message ?? e) });
      send(500, { error: 'internal error' });
    }
  };
  return { handler, reap, adopt, ensureNetwork, lastUsed };
}

// Entry point: `node src/server.ts`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (process.env.NODE_ENV === 'production' && (!cfg.token || cfg.token.length < 32 || cfg.token.startsWith('dev-only'))) { console.error('[hefyn-runner] HEFYN_INTERNAL_TOKEN is missing, a placeholder, or shorter than 32 characters. Fix: run "bun run init".'); process.exit(1); }
  const runner = createRunner(cfg, dockerClient());
  await runner.adopt().catch((e) => jsonLog('warn', 'adopt failed', { err: String(e) }));
  const server = http.createServer(runner.handler).listen(cfg.port, () => jsonLog('info', 'runner listening', { port: cfg.port }));
  const timer = setInterval(() => runner.reap().catch((e) => jsonLog('error', 'reap failed', { err: String(e) })), 60_000);
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); // containers are left running and re-adopted on start
}
