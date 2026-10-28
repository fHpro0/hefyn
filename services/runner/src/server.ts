import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DockerError, dockerClient, type Docker } from './docker.ts';
import { EXEC_ID, HttpError, checkAgentId, checkAgentVersion, checkAttachLimit, checkHandle, checkId, checkLimits, demux, evictable, frames, handleOf, idleHandles, loadConfig, parseAttach, parseExec, parseInstall, parseJsonRead, parseResize, tokenOk, type Config, type Kind, type Managed } from './logic.ts';

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
    const cur = await docker.call('GET', `/networks/${name}`).catch(() => undefined);
    if (cur && (!internal || cur.Internal)) return;
    if (cur) { // an older network that still has a route out, where none is wanted: replace it (its containers go with it) rather than keep an open door
      for (const id of Object.keys(cur.Containers ?? {})) await remove(id);
      await docker.call('DELETE', `/networks/${name}`);
      log('warn', 'replaced a sandbox network that had internet access', { name });
    }
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
  /** The hefyn-agents volume, as this container sees it at cfg.agentsDir (read-only): its name (or host path) is what the Docker daemon needs to mount it elsewhere. Undefined = agent installs are not set up. */
  let agents: { volume?: string; hostDir?: string } | undefined;
  async function agentsMount(target: string, readOnly: boolean) {
    if (!agents) {
      try {
        const m = ((await docker.call('GET', `/containers/${process.env.HOSTNAME}/json`)).Mounts as any[]).find((x) => x.Destination === cfg.agentsDir);
        if (m) agents = m.Type === 'volume' ? { volume: m.Name as string } : { hostDir: m.Source as string };
      } catch { /* not in a container, or no Docker: no agents */ }
    }
    if (!agents) return undefined;
    return agents.volume ? { Type: 'volume', Source: agents.volume, Target: target, ReadOnly: readOnly, VolumeOptions: { NoCopy: true } } : { Type: 'bind', Source: agents.hostDir!, Target: target, ReadOnly: readOnly, BindOptions: { CreateMountpoint: false } };
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

  async function create(kind: Kind, userId: string, conversationId: string, handle: string, teamHomes: string[] = []) {
    const name = NAMES[kind] + handle;
    const Labels = { [LABEL]: 'true', 'hefyn.kind': kind, 'hefyn.handle': handle, 'hefyn.user': userId, 'hefyn.conversation': conversationId };
    if (kind === 'sandbox') {
      // the user's Claude home (Claude Code's own login and settings, docs/WRAPPER.md): a fixed subpath of the validated user id, mounted into that user's sandboxes only
      const files = join('users', userId, 'files'), tmp = join('users', userId, 'tmp', conversationId), home = join('users', userId, 'claude-home');
      prepare(join(cfg.dataDir, files)); prepare(join(cfg.dataDir, tmp)); prepare(join(cfg.dataDir, home));
      // Agent accounts (docs/WRAPPER.md): the user's own account homes of every agent, and the team account homes hefyn says this user may use (checked ids only)
      const accounts = join('users', userId, 'accounts');
      prepare(join(cfg.dataDir, accounts));
      const team = [] as { Type: string }[];
      for (const a of teamHomes) { const sub = join('team-accounts', a); prepare(join(cfg.dataDir, sub)); team.push(await mountFor(sub, `/team-accounts/${a}`)); }
      await ensureNetwork(cfg.sandboxNetwork, false, cfg.egress === 'none'); // icc off: sandboxes cannot reach each other
      const agentsVol = await agentsMount('/opt/agents', true); // installed agents, read-only: a sandbox can run them, never change them
      await docker.call('POST', `/containers/create?name=${name}`, {
        Image: cfg.sandboxImage, User: `${cfg.sandboxUid}:${cfg.sandboxUid}`, WorkingDir: '/files', Labels,
        Env: ['HOME=/home/hefyn', 'LANG=C.UTF-8'],
        HostConfig: {
          ...baseHost(cfg.sandboxNetwork, cfg.memoryMb, cfg.pids),
          Mounts: [await mountFor(files, '/files'), await mountFor(tmp, '/tmp'), await mountFor(home, '/claude-home'), await mountFor(accounts, '/accounts'), ...team, ...(agentsVol ? [agentsVol] : [])],
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
  const ensure = (kind: Kind, { userId, conversationId, teamHomes = [] }: { userId: string; conversationId: string; teamHomes?: string[] }) => {
    const handle = handleOf(userId, conversationId), name = NAMES[kind] + handle;
    return serial(locks, key(kind, handle), async () => {
      const info = await inspect(name);
      // a sandbox from before the agents volume existed has no /opt/agents: replace it (its /files and /tmp are on volumes and stay); so is one whose team account homes differ from what is allowed now
      const have = ((info?.Mounts ?? []) as any[]).map((m) => String(m.Destination));
      const teamNow = have.filter((d) => d.startsWith('/team-accounts/')).sort().join(), teamWant = teamHomes.map((a) => `/team-accounts/${a}`).sort().join();
      const stale = kind === 'sandbox' && info?.State?.Running && (!have.includes('/claude-home') || !have.includes('/accounts') || teamNow !== teamWant || (!!(await agentsMount('/opt/agents', true)) && !have.includes('/opt/agents')));
      if (info?.State?.Running && !stale) { lastUsed.set(key(kind, handle), Date.now()); return { id: handle, name }; }
      createLock = createLock.catch(() => {}).then(async () => {
        if (info) await remove(name); // exited leftover, or a sandbox without the agents volume
        let all = await listManaged();
        const old = evictable(all, kind, userId, lastUsed, busy, cfg);
        if (old) { await destroy(kind, old); log('info', `${kind} stopped to make room`, { handle: old, userId }); all = await listManaged(); }
        checkLimits(all, kind, userId, cfg);
        await create(kind, userId, conversationId, handle, teamHomes);
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
      const sock = await docker.hijack(`/exec/${Id}/start`, { Detach: false, Tty: false });
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

  // ---- attach: a long-lived exec (an agent over stdio, or a terminal in a PTY) piped to the caller's upgraded connection ----
  const attachCount = new Map<string, number>(), attachExecs = new Map<string, string>(); // handle -> open attaches; exec id -> handle (resize only for ours)
  // Docker has no exec-kill: every attach runs with a private env marker, and a second exec kills whatever carries it.
  const killScript = 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qxF "HEFYN_ATTACH=$1" && kill -KILL "${p#/proc/}" 2>/dev/null; done; true';
  const STDERR_LINES = 50;
  async function attach(handle: string, spec: unknown, client: Duplex, head: Buffer) {
    const r = parseAttach(spec), { name, info } = await owned('sandbox', handle);
    if (!info.State?.Running) throw new HttpError(404, 'sandbox is not running');
    const k = key('sandbox', handle);
    checkAttachLimit(attachCount.get(handle) ?? 0, cfg);
    attachCount.set(handle, (attachCount.get(handle) ?? 0) + 1); busy.set(k, (busy.get(k) ?? 0) + 1); lastUsed.set(k, Date.now());
    const marker = randomBytes(16).toString('hex');
    let Id = '', sock: Duplex | undefined, closed = false;
    const release = () => {
      attachExecs.delete(Id);
      attachCount.set(handle, (attachCount.get(handle) ?? 1) - 1); busy.set(k, (busy.get(k) ?? 1) - 1); lastUsed.set(k, Date.now());
    };
    try {
      ({ Id } = await docker.call('POST', `/containers/${name}/exec`, {
        AttachStdin: true, AttachStdout: true, AttachStderr: !r.tty, Tty: r.tty, ...(r.tty ? { ConsoleSize: [r.rows, r.cols] } : {}), WorkingDir: r.cwd, Env: [...r.env, `HEFYN_ATTACH=${marker}`], Cmd: r.cmd,
      }));
      attachExecs.set(Id, handle);
      sock = await docker.hijack(`/exec/${Id}/start`, { Detach: false, Tty: r.tty });
    } catch (e) { release(); throw e; }
    const s = sock;
    let errLines = 0;
    const logErr = (body: Buffer) => { for (const line of body.toString('utf8').split('\n').filter(Boolean)) if (errLines++ < STDERR_LINES) log('warn', 'attach stderr', { handle, line: line.slice(0, 500) }); };
    const end = (byClient: boolean) => {
      if (closed) return;
      closed = true;
      s.destroy(); if (byClient) client.destroy(); else client.end(); // the process ended: let what is buffered reach the caller
      // the caller went away first: the process may still run (no TTY hangup, no stdin EOF handling), so kill it by marker
      const killed = byClient ? docker.call('POST', `/containers/${name}/exec`, { Cmd: ['sh', '-c', killScript, 'sh', marker] })
        .then(({ Id: kid }) => docker.hijack(`/exec/${kid}/start`, { Detach: false, Tty: false })).then((ks) => new Promise<void>((done) => { ks.on('close', () => done()); ks.on('error', () => done()); ks.resume(); setTimeout(done, 5000).unref(); })).catch(() => {}) : Promise.resolve();
      void killed.finally(release);
      log('info', 'attach closed', { handle, by: byClient ? 'client' : 'process', tty: r.tty });
    };
    client.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nX-Hefyn-Exec-Id: ${Id}\r\n\r\n`);
    const toClient = (c: Buffer) => { if (client.writable && !client.write(c)) { s.pause(); client.once('drain', () => s.resume()); } };
    if (r.tty) s.on('data', toClient); else s.on('data', frames((i, body) => (i === 0 ? toClient(body) : logErr(body))));
    s.on('close', () => end(false)); s.on('error', () => {});
    client.on('close', () => end(true)); client.on('error', () => {});
    client.on('data', (c: Buffer) => { if (s.writable && !s.write(c)) { client.pause(); s.once('drain', () => client.resume()); } });
    // A FIN is both "stdin EOF" and what a destroyed client socket looks like: pass the EOF on, and kill what has not ended after the grace period (a terminal has no EOF: closing it is a hangup).
    client.on('end', () => { if (r.tty) return end(true); s.end(); setTimeout(() => end(true), cfg.attachGraceMs).unref(); });
    if (head.length) s.write(head);
  }
  async function resize(handle: string, execId: string, body: unknown) {
    if (!EXEC_ID.test(execId) || attachExecs.get(execId) !== handle) throw new HttpError(404, 'not found');
    const { cols, rows } = parseResize(body);
    await docker.call('POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`).catch((e) => { if (e instanceof DockerError && e.status === 404) throw new HttpError(404, 'not found'); throw e; });
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
        await destroy(kind, k.slice(kind.length + 1)).catch((e) => {
          if (e instanceof HttpError && e.status === 404) { lastUsed.delete(k); busy.delete(k); return log('info', 'reaped a container that was already gone', { k }); } // else it fails again every minute
          log('error', 'reap failed', { k, err: String(e) });
        });
      }
    }
    if (await agentsMount('/agents', true)) await reapInstallers(now).catch((e) => log('error', 'installer reap failed', { err: String(e) }));
  }
  /** Re-adopt containers that survived a runner restart (fresh idle clock). */
  async function adopt() {
    for (const c of await listManaged()) {
      lastUsed.set(key(c.kind, c.handle), Date.now());
    }
  }

  // ---- agent installs: a short-lived container from the sandbox image, the only one that may write the hefyn-agents volume ----
  // Not a sandbox: its own network (internet, nothing else on it), no user data, fixed command, hardened like the others. It runs no package code
  // (npm --ignore-scripts; archives are only unpacked), so what it can reach is what install-agent.mjs asks for. State lives in the container and the volume.
  // container names are daemon-wide: the volume is in the hash, so two stacks on one daemon (dev and production) never touch each other's installer
  const installName = (id: string, version: string) => 'hefyn-inst-' + createHash('sha256').update(`${agents?.volume ?? agents?.hostDir ?? ''}\0${id}\0${version}`).digest('hex').slice(0, 16);
  const JOB = 'hefyn.installer', stackOf = () => createHash('sha256').update(agents?.volume ?? agents?.hostDir ?? '').digest('hex').slice(0, 12); // label value: only this runner's installers are counted and reaped
  const jobFilter = () => encodeURIComponent(JSON.stringify({ label: [`${JOB}=${stackOf()}`] }));
  const ready = (id: string, version: string) => existsSync(join(cfg.agentsDir, id, version, '.hefyn-installed'));
  async function needAgents() {
    const rw = await agentsMount('/agents', false);
    if (!rw) throw new HttpError(503, 'Agent installs are not set up on this server (the hefyn-agents volume is not mounted at the runner).');
    return rw;
  }
  async function startJob(name: string, id: string, version: string, spec: unknown, network: string, memoryMb: number) {
    await docker.call('POST', `/containers/create?name=${name}`, {
      Image: cfg.sandboxImage, User: '0:0', Tty: true /* raw logs */, WorkingDir: '/tmp', Cmd: ['node', '/opt/hefyn/install-agent.mjs'],
      Env: ['HOME=/tmp', 'LANG=C.UTF-8', `HEFYN_INSTALL=${JSON.stringify(spec)}`],
      Labels: { [JOB]: stackOf(), 'hefyn.agent': id, 'hefyn.version': version },
      HostConfig: { ...baseHost(network, memoryMb, 256), Mounts: [await needAgents()], Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=1g' } }, // root, but with every capability dropped; it only ever writes /agents
    });
    await docker.call('POST', `/containers/${name}/start`);
  }
  async function failureOf(name: string, exitCode: number) {
    const logs = String(await docker.call('GET', `/containers/${name}/logs?stdout=1&stderr=1&tail=15`).catch(() => '')).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    const ours = [...logs].reverse().find((l) => l.startsWith('hefyn-install:'));
    if (ours) return ours.slice('hefyn-install:'.length).trim().slice(0, 500);
    if (exitCode === 137) return 'The install was stopped (out of memory or too slow).';
    return (logs.slice(-3).join(' | ') || `the installer exited with code ${exitCode}`).slice(0, 500);
  }
  async function installStatus(id: string, version: string): Promise<{ state: 'ready' | 'installing' | 'failed' | 'none'; error?: string }> {
    if (ready(id, version)) return { state: 'ready' };
    const name = installName(id, version), info = await inspect(name);
    if (!info) return { state: 'none' };
    if (info.State?.Running || info.State?.Status === 'created' || info.State?.Status === 'restarting') return { state: 'installing' }; // `created` also reads as exit code 0
    if (info.State?.ExitCode === 0) {
      await new Promise((r) => setTimeout(r, 500)); // the marker is written before the exit: a second look rules out a view that is a moment behind
      return ready(id, version) ? { state: 'ready' } : { state: 'failed', error: 'The installer finished without installing anything.' };
    }
    return { state: 'failed', error: await failureOf(name, info.State?.ExitCode ?? -1) };
  }
  /** One string field of a JSON file in an installed version (null if unreadable): how hefyn learns the agent's own version. Reads through the volume this runner has mounted read-only. */
  function readInstallJson(id: string, version: string, r: { path: string; field: string }): string | null {
    try {
      const root = realpathSync(join(cfg.agentsDir, id, version)), file = realpathSync(join(root, r.path));
      if (!file.startsWith(root + '/')) return null;
      const v = JSON.parse(readFileSync(file, 'utf8'))?.[r.field];
      return typeof v === 'string' && v.length <= 64 ? v : null;
    } catch { return null; }
  }
  const install = async (body: unknown) => {
    const r = parseInstall(body);
    await needAgents(); // first: the container name depends on which volume this is
    const name = installName(r.id, r.version);
    return serial(locks, `install:${name}`, async () => {
      const st = await installStatus(r.id, r.version);
      if (st.state === 'ready' || st.state === 'installing') return st;
      await remove(name); // the leftover of a failed attempt
      const busyNow: unknown = await docker.call('GET', `/containers/json?filters=${jobFilter()}`);
      if (Array.isArray(busyNow) && busyNow.length >= cfg.maxInstalls) throw new HttpError(429, 'Too many installs are running. Try again in a minute.');
      await ensureNetwork(cfg.installNetwork, false);
      await startJob(name, r.id, r.version, { id: r.id, version: r.version, check: r.check, ...(r.npm ? { npm: r.npm } : { binary: r.binary }) }, cfg.installNetwork, cfg.installMemoryMb);
      log('info', 'agent install started', { id: r.id, version: r.version });
      return { state: 'installing' as const };
    });
  };
  async function uninstall(id: string, version: string) {
    await needAgents();
    await remove(installName(id, version));
    const name = `hefyn-rm-${randomBytes(6).toString('hex')}`;
    await startJob(name, id, version, { id, version, remove: true }, 'none', 256);
    try {
      const { StatusCode } = await docker.call('POST', `/containers/${name}/wait`);
      if (StatusCode !== 0) throw new HttpError(500, 'The agent could not be removed.');
    } finally { await remove(name); }
    log('info', 'agent removed', { id, version });
  }
  /** Installers that ran too long are stopped; finished ones are kept an hour (for their error message), then removed. */
  async function reapInstallers(now = Date.now()) {
    const rows: unknown = await docker.call('GET', `/containers/json?all=true&filters=${jobFilter()}`);
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const st = (await inspect(r.Id))?.State;
      if (!st) continue;
      if (now - Date.parse(st.Running ? st.StartedAt : st.FinishedAt) > (st.Running ? cfg.installTimeoutMs : 3_600_000)) { await remove(r.Id); log('info', st.Running ? 'installer stopped: too slow' : 'installer removed', { id: r.Labels?.['hefyn.agent'] }); }
    }
  }

  async function readBody(req: http.IncomingMessage) {
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > cfg.maxBody) throw new HttpError(413, 'body too large'); chunks.push(c); }
    try { return n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new HttpError(400, 'invalid JSON'); }
  }
  const idPair = (b: any) => ({ userId: checkId('user id', b?.userId), conversationId: checkId('conversation id', b?.conversationId),
    teamHomes: Array.isArray(b?.teamHomes) ? [...new Set<string>(b.teamHomes.filter((a: unknown): a is string => typeof a === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(a)))].slice(0, 16) : [] }); // team account homes to mount: agent ids

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
      if (m === 'POST' && (match = /^\/sandboxes\/([^/]+)\/attach\/([^/]+)\/resize$/.exec(p))) { await resize(checkHandle(match[1]), match[2], await readBody(req)); return send(200, { ok: true }); }
      if (m === 'DELETE' && (match = /^\/sandboxes\/([^/]+)$/.exec(p))) { await destroy('sandbox', checkHandle(match[1])); return send(200, { ok: true }); }
      if (m === 'POST' && p === '/agents/install') return send(200, await install(await readBody(req)));
      if (m === 'GET' && (match = /^\/agents\/([^/]+)\/([^/]+)$/.exec(p))) { await needAgents(); return send(200, await installStatus(checkAgentId(match[1]), checkAgentVersion(match[2]))); }
      if (m === 'POST' && (match = /^\/agents\/([^/]+)\/([^/]+)\/json$/.exec(p))) { await needAgents(); return send(200, { value: readInstallJson(checkAgentId(match[1]), checkAgentVersion(match[2]), parseJsonRead(await readBody(req))) }); }
      if (m === 'DELETE' && (match = /^\/agents\/([^/]+)\/([^/]+)$/.exec(p))) { await uninstall(checkAgentId(match[1]), checkAgentVersion(match[2])); return send(200, { ok: true }); }
      if (m === 'DELETE' && (match = /^\/mcp\/playwright\/([^/]+)$/.exec(p))) { await destroy('playwright', checkHandle(match[1])); return send(200, { ok: true }); }
      throw new HttpError(404, 'not found');
    } catch (e: any) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      log('error', 'request failed', { err: String(e?.message ?? e) });
      send(500, { error: 'internal error' });
    }
  };
  /** `server.on('upgrade', runner.upgrade)`: POST /sandboxes/:id/attach?spec=<json>. Bytes after the headers are stdin; the 101 carries X-Hefyn-Exec-Id. */
  const upgrade = async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const fail = (status: number, message: string) => { const b = JSON.stringify({ error: message }); socket.end(`HTTP/1.1 ${status} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n${b}`); };
    socket.on('error', () => {});
    try {
      if (!tokenOk(req.headers['x-hefyn-internal'] as string | undefined, cfg.token)) throw new HttpError(401, 'unauthorized');
      const url = new URL(req.url ?? '/', 'http://x'), match = /^\/sandboxes\/([^/]+)\/attach$/.exec(url.pathname);
      if (req.method !== 'POST' || !match) throw new HttpError(404, 'not found');
      let spec: unknown; try { spec = JSON.parse(url.searchParams.get('spec') ?? ''); } catch { throw new HttpError(400, 'invalid spec'); }
      await attach(checkHandle(match[1]), spec, socket, head);
    } catch (e: any) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      log('error', 'attach failed', { err: String(e?.message ?? e) });
      fail(500, 'internal error');
    }
  };
  return { handler, upgrade, reap, adopt, ensureNetwork, lastUsed };
}

// Entry point: `node src/server.ts`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (process.env.NODE_ENV === 'production' && (!cfg.token || cfg.token.length < 32 || cfg.token.startsWith('dev-only'))) { console.error('[hefyn-runner] HEFYN_INTERNAL_TOKEN is missing, a placeholder, or shorter than 32 characters. Fix: run "bun run init".'); process.exit(1); }
  const runner = createRunner(cfg, dockerClient());
  await runner.adopt().catch((e) => jsonLog('warn', 'adopt failed', { err: String(e) }));
  const server = http.createServer(runner.handler).on('upgrade', runner.upgrade).listen(cfg.port, () => jsonLog('info', 'runner listening', { port: cfg.port }));
  const timer = setInterval(() => runner.reap().catch((e) => jsonLog('error', 'reap failed', { err: String(e) })), 60_000);
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); // containers are left running and re-adopted on start
}
