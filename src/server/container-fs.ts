import { posix } from 'node:path';
// Types only: the web process uses this file (Files API for shell users) and must not load Flue.
import type { FileStat } from '@flue/runtime';

// Filesystem and command access to a per-conversation container managed by the runner service (services/runner). The Flue
// sandbox on top of it is container-sandbox.ts. Backed by a per-conversation container managed by the runner service (services/runner).
// Every operation, including file access, runs INSIDE the container, so symlinks the agent's shell creates resolve in the
// container's namespace only and never on the host. See docs/SANDBOX.md.

export class ContainerFsError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class RunnerDownError extends Error { constructor() { super('the sandbox runner is unreachable'); } }

export interface ContainerSandboxOptions {
  userId: string; conversationId: string;
  runnerUrl?: string; token?: string; // default HEFYN_RUNNER_URL / HEFYN_INTERNAL_TOKEN
  fetch?: typeof fetch;
  /** Checked before each exec and write (the caller caches it): true = the user's storage is over quota. */
  overQuota?: () => Promise<boolean>;
}
interface RunResult { stdout: string; stderr: string; exitCode: number; truncated: boolean; timedOut?: boolean }

const READ_LIMIT = 48 * 1024 * 1024; // base64 text; the runner's hard output cap is 64 MB
const MAX_PATH = 1024, MAX_SEGMENT = 255;

/** Same rules as storage.ts cleanPath, restricted to the two roots the container mounts. */
export function cleanPath(p: string): string {
  if (typeof p !== 'string') throw new ContainerFsError('EINVAL', 'invalid path');
  if (p.includes('\0') || p.includes('\\') || p.length > MAX_PATH) throw new ContainerFsError('EINVAL', 'invalid path');
  const parts = p.split('/');
  if (parts.some((s) => s === '..')) throw new ContainerFsError('EACCES', 'path escapes the storage area');
  if (parts.some((s) => s.length > MAX_SEGMENT)) throw new ContainerFsError('EINVAL', 'path segment too long');
  const v = posix.normalize('/' + p);
  if (!/^\/(files|tmp)(\/|$)/.test(v)) throw new ContainerFsError('EACCES', 'only /files and /tmp are accessible');
  return v;
}

const STDERR_CODES: [RegExp, string][] = [
  [/No such file or directory/i, 'ENOENT'], [/Is a directory/i, 'EISDIR'], [/Not a directory/i, 'ENOTDIR'],
  [/Permission denied/i, 'EACCES'], [/File exists/i, 'EEXIST'], [/Directory not empty/i, 'ENOTEMPTY'], [/Read-only file system/i, 'EROFS'],
  [/No space left/i, 'ENOSPC'],
];

export function containerFs(opts: ContainerSandboxOptions) {
  const url = (opts.runnerUrl ?? process.env.HEFYN_RUNNER_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEFYN_INTERNAL_TOKEN ?? '';
  const doFetch = opts.fetch ?? fetch;
  if (!url) throw new Error('HEFYN_RUNNER_URL is not set');

  async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await doFetch(url + path, { method, signal, headers: { 'x-hefyn-internal': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      throw new RunnerDownError(); // runner unreachable
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  let id: Promise<string> | undefined;
  const ensure = () => id ??= call('POST', '/sandboxes', { userId: opts.userId, conversationId: opts.conversationId }).then(({ status, json }) => {
    if (status !== 200) { id = undefined; throw new Error(`sandbox unavailable (${status}): ${json.error ?? 'unknown error'}`); }
    return json.id as string;
  }, (e) => { id = undefined; throw e; });

  /** Run a command in the container (lazy start; one transparent restart if the container was reaped). */
  async function run(cmd: string | string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string | Uint8Array; maxOutput?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const stdin = o.stdin === undefined ? undefined : Buffer.from(o.stdin).toString('base64');
    for (let attempt = 0; ; attempt++) {
      const { status, json } = await call('POST', `/sandboxes/${await ensure()}/exec`, { cmd, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, stdin, maxOutput: o.maxOutput }, o.signal);
      if (status === 404 && attempt === 0) { id = undefined; continue; }
      if (status !== 200) throw new Error(`sandbox exec failed (${status}): ${json.error ?? 'unknown error'}`);
      return json;
    }
  }
  /** Helper command: argv form, no shell parsing of the path. Non-zero exit becomes an fs-style error. */
  async function helper(path: string, cmd: string[], o: Parameters<typeof run>[1] = {}, okCodes = [0]): Promise<RunResult> {
    const r = await run(cmd, { cwd: '/files', ...o });
    if (r.timedOut) throw new ContainerFsError('ETIMEDOUT', `${path}: operation timed out`);
    if (!okCodes.includes(r.exitCode)) {
      const code = STDERR_CODES.find(([re]) => re.test(r.stderr))?.[1] ?? 'EIO';
      throw new ContainerFsError(code, `${path}: ${r.stderr.trim().split('\n')[0] || 'operation failed'}`);
    }
    return r;
  }
  const bash = (script: string, ...args: string[]) => ['bash', '-c', script, 'hefyn', ...args];

  const fs = {
    async readFileBuffer(p: string): Promise<Uint8Array> {
      const path = cleanPath(p);
      const r = await helper(path, ['base64', '-w0', '--', path], { maxOutput: READ_LIMIT });
      if (r.truncated) throw new ContainerFsError('EFBIG', `${path}: file too large to read`);
      return Buffer.from(r.stdout, 'base64');
    },
    async readFile(p: string) { return Buffer.from(await fs.readFileBuffer(p)).toString('utf8'); },
    async writeFile(p: string, content: string | Uint8Array) {
      const path = cleanPath(p);
      if (path === '/files' || path === '/tmp') throw new ContainerFsError('EISDIR', `${path}: is a directory`);
      await helper(path, bash('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', path), { stdin: content });
    },
    async stat(p: string): Promise<FileStat> {
      const path = cleanPath(p);
      const [lnk, target] = (await helper(path, bash('stat -c %F -- "$1" && stat -L -c "%F|%s|%Y" -- "$1"', path))).stdout.trim().split('\n');
      const [kind, size, mtime] = target.split('|');
      return { isFile: kind.startsWith('regular'), isDirectory: kind === 'directory', isSymbolicLink: lnk === 'symbolic link', size: Number(size), mtime: new Date(Number(mtime) * 1000) };
    },
    async readdir(p: string): Promise<string[]> {
      const path = cleanPath(p);
      return (await helper(path, bash('find "$1/" -mindepth 1 -maxdepth 1 -printf "%f\\0"', path))).stdout.split('\0').filter(Boolean);
    },
    async exists(p: string) {
      let path: string; try { path = cleanPath(p); } catch { return false; }
      return (await helper(path, ['test', '-e', path], {}, [0, 1])).exitCode === 0;
    },
    async mkdir(p: string, o?: { recursive?: boolean }) { const path = cleanPath(p); await helper(path, ['mkdir', ...(o?.recursive ?? true ? ['-p'] : []), '--', path]); },
    async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
      const path = cleanPath(p);
      if (path === '/files' || path === '/tmp') throw new ContainerFsError('EACCES', `${path} itself cannot be changed`);
      await helper(path, ['rm', ...(o?.recursive ? ['-r'] : []), ...(o?.force ? ['-f'] : []), '--', path]);
    },
    async rename(from: string, to: string) {
      const a = cleanPath(from), b = cleanPath(to);
      await helper(a, bash('[ ! -e "$2" ] && [ ! -L "$2" ] || { echo "File exists" >&2; exit 17; }; mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"', a, b));
    },
    run,
    /** Stop and remove the container (conversation end). */
    async destroy() { if (id) { const i = await id.catch(() => undefined); id = undefined; if (i) await call('DELETE', `/sandboxes/${i}`); } },
  };
  return fs;
}

