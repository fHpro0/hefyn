import { createHash, timingSafeEqual } from 'node:crypto';

// Pure parts of the runner: validation, limits, reaper selection, config, docker stream demux. No I/O here.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const checkId = (kind: string, v: unknown): string => {
  if (typeof v !== 'string' || !ID.test(v)) throw new HttpError(400, `invalid ${kind}`);
  return v;
};
/** Container handle: derived from user + conversation, so the caller never picks container names. */
export const handleOf = (userId: string, conversationId: string) =>
  createHash('sha256').update(`${userId}\0${conversationId}`).digest('hex').slice(0, 16);
export const checkHandle = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v)) throw new HttpError(400, 'invalid sandbox id');
  return v;
};

export const tokenOk = (given: string | undefined, expected: string): boolean => {
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b); // hashing equalises lengths
};

export type Kind = 'sandbox' | 'playwright';
export interface Config {
  token: string; dataDir: string; hostDataDir?: string; port: number;
  sandboxImage: string; playwrightImage: string; egress: 'internet' | 'none'; sandboxNetwork: string; mcpNetwork: string;
  sandboxUid: number; pids: number; memoryMb: number; cpus: number; playwrightMemoryMb: number;
  idleMs: number; maxPerUser: Record<Kind, number>; maxGlobal: Record<Kind, number>;
  defaultOutput: number; hardOutput: number; maxTimeoutMs: number; maxBody: number;
  maxAttachPerSandbox: number; attachGraceMs: number;
  agentsDir: string; installNetwork: string; installMemoryMb: number; installTimeoutMs: number; maxInstalls: number;
}
const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && n > 0 && Number.isFinite(n) ? n : d; };
export const loadConfig = (e: Record<string, string | undefined> = process.env): Config => ({
  token: e.HEFYN_INTERNAL_TOKEN ?? '',
  dataDir: e.HEFYN_DATA_DIR || '/data',
  hostDataDir: e.HEFYN_RUNNER_HOST_DATA_DIR || undefined, // bind mode (local runs); unset = discover our own volume
  port: num(e.PORT, 8790),
  sandboxImage: e.HEFYN_SANDBOX_IMAGE || 'hefyn-sandbox',
  // Pinned by digest (the build that was tested on 2026-10-15); bump deliberately.
  playwrightImage: e.HEFYN_PLAYWRIGHT_IMAGE || 'mcr.microsoft.com/playwright/mcp@sha256:690763cbb437ee7233f538a953bb5390bf03791eb5c965b471e59d17a6132fcb',
  // Default none: the sandbox network is Docker-internal (no route out). Tool arguments reach a shell with the real values, so open internet
  // lets a prompt-injected model send files out. 'internet' is an explicit opt-in (docs/SANDBOX.md).
  egress: e.HEFYN_SANDBOX_EGRESS === 'internet' ? 'internet' : 'none',
  sandboxNetwork: e.HEFYN_SANDBOX_NETWORK || 'hefyn-sandbox',
  mcpNetwork: e.HEFYN_MCP_NETWORK || 'hefyn-mcp',
  sandboxUid: num(e.HEFYN_SANDBOX_UID, 1000),
  pids: num(e.HEFYN_SANDBOX_PIDS, 256), memoryMb: num(e.HEFYN_SANDBOX_MEMORY_MB, 1024), cpus: num(e.HEFYN_SANDBOX_CPUS, 1),
  playwrightMemoryMb: num(e.HEFYN_PLAYWRIGHT_MEMORY_MB, 2048),
  idleMs: num(e.HEFYN_RUNNER_IDLE_MINUTES, 5) * 60_000,
  maxPerUser: { sandbox: num(e.HEFYN_RUNNER_MAX_SANDBOXES_PER_USER, 2), playwright: num(e.HEFYN_RUNNER_MAX_PLAYWRIGHT_PER_USER, 1) },
  maxGlobal: { sandbox: num(e.HEFYN_RUNNER_MAX_SANDBOXES, 20), playwright: num(e.HEFYN_RUNNER_MAX_PLAYWRIGHT, 5) },
  defaultOutput: num(e.HEFYN_RUNNER_OUTPUT_BYTES, 1024 * 1024),
  hardOutput: num(e.HEFYN_RUNNER_MAX_OUTPUT_BYTES, 64 * 1024 * 1024),
  maxTimeoutMs: num(e.HEFYN_RUNNER_MAX_TIMEOUT_MS, 600_000),
  maxBody: num(e.HEFYN_RUNNER_MAX_BODY_BYTES, 96 * 1024 * 1024),
  attachGraceMs: num(e.HEFYN_RUNNER_ATTACH_GRACE_MS, 5000),
  maxAttachPerSandbox: num(e.HEFYN_RUNNER_MAX_ATTACH, 4), // long-lived attached processes (agents, terminals) per sandbox
  agentsDir: e.HEFYN_AGENTS_DIR || '/agents', // where this container sees the hefyn-agents volume (read-only); the Docker daemon is told its name or path
  installNetwork: e.HEFYN_INSTALL_NETWORK || 'hefyn-install', // internet, for installer containers only
  installMemoryMb: num(e.HEFYN_INSTALL_MEMORY_MB, 2048), installTimeoutMs: num(e.HEFYN_INSTALL_TIMEOUT_MINUTES, 10) * 60_000, maxInstalls: num(e.HEFYN_RUNNER_MAX_INSTALLS, 2),
});

export interface Managed { handle: string; kind: Kind; userId: string; conversationId: string }

/** Throws 429 when creating one more `kind` container for `userId` would exceed a limit. Existing = running containers. */
export function checkLimits(existing: Managed[], kind: Kind, userId: string, cfg: Pick<Config, 'maxPerUser' | 'maxGlobal'>) {
  const same = existing.filter((c) => c.kind === kind);
  if (same.length >= cfg.maxGlobal[kind]) throw new HttpError(429, `too many ${kind} containers on this server`);
  if (same.filter((c) => c.userId === userId).length >= cfg.maxPerUser[kind]) throw new HttpError(429, `too many ${kind} containers for this user`);
}

/** When creating one more `kind` container would hit the user's cap: the handle of their least recently used idle one (never one with a running exec or attach), to stop instead of refusing. */
export function evictable(existing: Managed[], kind: Kind, userId: string, lastUsed: Map<string, number>, busy: Map<string, number>, cfg: Pick<Config, 'maxPerUser'>): string | undefined {
  const mine = existing.filter((c) => c.kind === kind && c.userId === userId);
  if (mine.length < cfg.maxPerUser[kind]) return undefined;
  return mine.filter((c) => !(busy.get(`${kind}:${c.handle}`) ?? 0)).sort((a, b) => (lastUsed.get(`${kind}:${a.handle}`) ?? 0) - (lastUsed.get(`${kind}:${b.handle}`) ?? 0))[0]?.handle;
}

/** Handles whose last use is older than `idleMs`. Busy ones (running exec) never count as idle. */
export const idleHandles = (lastUsed: Map<string, number>, busy: Map<string, number>, now: number, idleMs: number): string[] =>
  [...lastUsed].filter(([h, t]) => !(busy.get(h) ?? 0) && now - t >= idleMs).map(([h]) => h);

// ---- exec request validation ----
export interface ExecReq { cmd: string[]; cwd: string; env: string[]; timeoutMs: number; stdin?: Buffer; maxOutput: number }
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function parseCmd(b: any): { cmd: string[]; cwd: string; env: string[] } {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'invalid body');
  let cmd: string[];
  if (typeof b.cmd === 'string' && b.cmd.length > 0 && b.cmd.length <= 1_000_000) cmd = ['bash', '-c', b.cmd];
  else if (Array.isArray(b.cmd) && b.cmd.length > 0 && b.cmd.length <= 4096 && b.cmd.every((s: unknown) => typeof s === 'string' && !s.includes('\0'))) cmd = b.cmd;
  else throw new HttpError(400, 'invalid cmd');
  if (cmd.join('').includes('\0')) throw new HttpError(400, 'invalid cmd');
  const cwd = b.cwd ?? '/files';
  if (typeof cwd !== 'string' || !/^\/(files|tmp)(\/[^\0]*)?$/.test(cwd) || cwd.split('/').includes('..') || cwd.length > 1024) throw new HttpError(400, 'cwd must be inside /files or /tmp');
  const env: string[] = [];
  if (b.env !== undefined) {
    if (!b.env || typeof b.env !== 'object' || Array.isArray(b.env) || Object.keys(b.env).length > 64) throw new HttpError(400, 'invalid env');
    for (const [k, v] of Object.entries(b.env)) {
      if (!ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\0') || v.length > 32_768) throw new HttpError(400, `invalid env ${k}`);
      env.push(`${k}=${v}`);
    }
  }
  return { cmd, cwd, env };
}
export function parseExec(b: any, cfg: Pick<Config, 'defaultOutput' | 'hardOutput' | 'maxTimeoutMs'>): ExecReq {
  const { cmd, cwd, env } = parseCmd(b);
  const t = b.timeoutMs === undefined ? 120_000 : b.timeoutMs;
  if (typeof t !== 'number' || !(t > 0)) throw new HttpError(400, 'invalid timeoutMs');
  const mo = b.maxOutput === undefined ? cfg.defaultOutput : b.maxOutput;
  if (typeof mo !== 'number' || !(mo > 0)) throw new HttpError(400, 'invalid maxOutput');
  let stdin: Buffer | undefined;
  if (b.stdin !== undefined) {
    if (typeof b.stdin !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.stdin)) throw new HttpError(400, 'stdin must be base64');
    stdin = Buffer.from(b.stdin, 'base64');
  }
  return { cmd, cwd, env, timeoutMs: Math.min(t, cfg.maxTimeoutMs), stdin, maxOutput: Math.min(mo, cfg.hardOutput) };
}

/** Incremental parser of Docker's non-TTY stream (8-byte header: type, 000, big-endian length): calls `onFrame(0 stdout | 1 stderr, body)`. */
export function frames(onFrame: (stream: 0 | 1, body: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      onFrame(buf[0] === 2 ? 1 : 0, buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
    }
  };
}

/** Demux of a non-TTY exec stream with per-stream caps. */
export function demux(cap: number) {
  const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], sizes: [0, 0], truncated: false };
  return {
    push: frames((i, body) => {
      const room = Math.max(0, cap - out.sizes[i]);
      if (body.length > room) out.truncated = true;
      const keep = body.subarray(0, room);
      out[i ? 'stderr' : 'stdout'].push(Buffer.from(keep)); out.sizes[i] += keep.length;
    }),
    result: () => ({ stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8'), truncated: out.truncated }),
  };
}

// ---- attach (long-lived exec, HTTP Upgrade) ----
export interface AttachReq { cmd: string[]; cwd: string; env: string[]; tty: boolean; cols: number; rows: number }
const dim = (v: unknown, d: number, what: string) => {
  const n = v === undefined ? d : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) throw new HttpError(400, `invalid ${what}`);
  return n;
};
/** Same cmd/cwd/env rules as an exec; no timeout and no output cap (the caller owns the stream). */
export function parseAttach(b: any): AttachReq {
  const { cmd, cwd, env } = parseCmd(b);
  if (typeof b.tty !== 'boolean') throw new HttpError(400, 'tty must be true or false');
  return { cmd, cwd, env, tty: b.tty, cols: dim(b.cols, 80, 'cols'), rows: dim(b.rows, 24, 'rows') };
}
export const parseResize = (b: any) => ({ cols: dim(b?.cols, NaN, 'cols'), rows: dim(b?.rows, NaN, 'rows') });
/** Throws 429 when another attach would exceed the per-sandbox cap. */
export function checkAttachLimit(open: number, cfg: Pick<Config, 'maxAttachPerSandbox'>) {
  if (open >= cfg.maxAttachPerSandbox) throw new HttpError(429, 'too many attached processes in this sandbox');
}
export const EXEC_ID = /^[0-9a-f]{64}$/;

// ---- agent installs (docs/SANDBOX.md): what the installer container may be asked to fetch ----
export interface InstallReq {
  id: string; version: string; check: string[];
  npm?: { package: string; extra: string[] };
  binary?: Record<string, { archive: string; sha256: string; cmd: string }>;
}
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/, AGENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
export const checkAgentId = (v: unknown): string => { if (typeof v !== 'string' || !AGENT_ID.test(v)) throw new HttpError(400, 'invalid agent id'); return v; };
export const checkAgentVersion = (v: unknown): string => { if (typeof v !== 'string' || !AGENT_VERSION.test(v)) throw new HttpError(400, 'invalid agent version'); return v; };
/** `{path, field}` of a read of one string field of a JSON file inside an install (the agent's own version): the relative path, checked, and the field name. */
export function parseJsonRead(b: any): { path: string; field: string } {
  const path = b?.path, field = b?.field;
  if (typeof path !== 'string' || !/^[\w.@-]+(\/[\w.@-]+)*$/.test(path) || path.length > 200 || path.split('/').some((s) => s === '..' || s === '.') || !path.endsWith('.json')) throw new HttpError(400, 'invalid path');
  if (typeof field !== 'string' || !/^[A-Za-z]\w{0,40}$/.test(field)) throw new HttpError(400, 'invalid field');
  return { path, field };
}
const NPM_PIN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/; // an exact version: no ranges, tags or URLs
/** Throws 400 on anything the installer must not fetch: unpinned packages, non-https or credentialed URLs, a missing or malformed sha256. */
export function parseInstall(b: any): InstallReq {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'invalid body');
  const id = checkAgentId(b.id), version = checkAgentVersion(b.version), d = b.distribution;
  if (!d || typeof d !== 'object' || Array.isArray(d) || (!!d.npx === !!d.binary)) throw new HttpError(400, 'distribution needs exactly one of npx or binary');
  const check: string[] = [];
  for (const f of b.check ?? []) {
    if (typeof f !== 'string' || !/^[A-Za-z0-9._@+-][A-Za-z0-9._@/+-]{0,200}$/.test(f) || f.split('/').includes('..') || check.length >= 8) throw new HttpError(400, 'invalid check path');
    check.push(f);
  }
  if (d.npx) {
    const extra = d.npx.extra ?? [];
    if (typeof d.npx.package !== 'string' || !NPM_PIN.test(d.npx.package) || !Array.isArray(extra) || extra.length > 4 || !extra.every((x: unknown) => typeof x === 'string' && NPM_PIN.test(x))) throw new HttpError(400, 'npm packages must be pinned to an exact version');
    return { id, version, check, npm: { package: d.npx.package, extra } };
  }
  const binary: NonNullable<InstallReq['binary']> = {};
  for (const [plat, e] of Object.entries<any>(d.binary)) {
    if (plat !== 'linux-aarch64' && plat !== 'linux-x86_64') continue; // other platforms are of no use to a Linux sandbox
    let u: URL | undefined; try { u = new URL(e?.archive); } catch { /* checked below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password || String(e.archive).length > 2048) throw new HttpError(400, `${plat}: the archive must be an https URL`);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new HttpError(400, `${plat}: the sha256 is missing or malformed; hefyn installs nothing it cannot verify`);
    if (typeof e.cmd !== 'string' || !/^\.\/[A-Za-z0-9._+/-]+$/.test(e.cmd) || e.cmd.split('/').includes('..')) throw new HttpError(400, `${plat}: invalid cmd`);
    binary[plat] = { archive: e.archive, sha256: e.sha256, cmd: e.cmd };
  }
  if (!Object.keys(binary).length) throw new HttpError(400, 'this agent has no Linux download');
  return { id, version, check, binary };
}
