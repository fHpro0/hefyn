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
  egress: e.HEFYN_SANDBOX_EGRESS === 'none' ? 'none' : 'internet', // none: the sandbox network is Docker-internal (no route out)
  sandboxNetwork: e.HEFYN_SANDBOX_NETWORK || 'hefyn-sandbox',
  mcpNetwork: e.HEFYN_MCP_NETWORK || 'hefyn-mcp',
  sandboxUid: num(e.HEFYN_SANDBOX_UID, 1000),
  pids: num(e.HEFYN_SANDBOX_PIDS, 256), memoryMb: num(e.HEFYN_SANDBOX_MEMORY_MB, 1024), cpus: num(e.HEFYN_SANDBOX_CPUS, 1),
  playwrightMemoryMb: num(e.HEFYN_PLAYWRIGHT_MEMORY_MB, 2048),
  idleMs: num(e.HEFYN_RUNNER_IDLE_MINUTES, 15) * 60_000,
  maxPerUser: { sandbox: num(e.HEFYN_RUNNER_MAX_SANDBOXES_PER_USER, 2), playwright: num(e.HEFYN_RUNNER_MAX_PLAYWRIGHT_PER_USER, 1) },
  maxGlobal: { sandbox: num(e.HEFYN_RUNNER_MAX_SANDBOXES, 20), playwright: num(e.HEFYN_RUNNER_MAX_PLAYWRIGHT, 5) },
  defaultOutput: num(e.HEFYN_RUNNER_OUTPUT_BYTES, 1024 * 1024),
  hardOutput: num(e.HEFYN_RUNNER_MAX_OUTPUT_BYTES, 64 * 1024 * 1024),
  maxTimeoutMs: num(e.HEFYN_RUNNER_MAX_TIMEOUT_MS, 600_000),
  maxBody: num(e.HEFYN_RUNNER_MAX_BODY_BYTES, 96 * 1024 * 1024),
});

export interface Managed { handle: string; kind: Kind; userId: string; conversationId: string }

/** Throws 429 when creating one more `kind` container for `userId` would exceed a limit. Existing = running containers. */
export function checkLimits(existing: Managed[], kind: Kind, userId: string, cfg: Pick<Config, 'maxPerUser' | 'maxGlobal'>) {
  const same = existing.filter((c) => c.kind === kind);
  if (same.length >= cfg.maxGlobal[kind]) throw new HttpError(429, `too many ${kind} containers on this server`);
  if (same.filter((c) => c.userId === userId).length >= cfg.maxPerUser[kind]) throw new HttpError(429, `too many ${kind} containers for this user`);
}

/** Handles whose last use is older than `idleMs`. Busy ones (running exec) never count as idle. */
export const idleHandles = (lastUsed: Map<string, number>, busy: Map<string, number>, now: number, idleMs: number): string[] =>
  [...lastUsed].filter(([h, t]) => !(busy.get(h) ?? 0) && now - t >= idleMs).map(([h]) => h);

// ---- exec request validation ----
export interface ExecReq { cmd: string[]; cwd: string; env: string[]; timeoutMs: number; stdin?: Buffer; maxOutput: number }
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function parseExec(b: any, cfg: Pick<Config, 'defaultOutput' | 'hardOutput' | 'maxTimeoutMs'>): ExecReq {
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

/** Incremental demux of Docker's non-TTY attach stream (8-byte header: type, 000, big-endian length) with per-stream caps. */
export function demux(cap: number) {
  const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], sizes: [0, 0], truncated: false };
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 8) {
        const len = buf.readUInt32BE(4);
        if (buf.length < 8 + len) break;
        const i = buf[0] === 2 ? 1 : 0, body = buf.subarray(8, 8 + len);
        const room = Math.max(0, cap - out.sizes[i]);
        if (body.length > room) out.truncated = true;
        const keep = body.subarray(0, room);
        out[i ? 'stderr' : 'stdout'].push(Buffer.from(keep)); out.sizes[i] += keep.length;
        buf = buf.subarray(8 + len);
      }
    },
    result: () => ({ stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8'), truncated: out.truncated }),
  };
}
