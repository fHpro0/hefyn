import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { db } from './appdb.ts';
import { ContainerFsError, cleanPath, containerFs } from './container-fs.ts';
import type { Permission } from './permissions.ts';
import { StorageError, maxUploadBytes, quotaBytes, usageBytes, userFs, type Entry } from './storage.ts';

// Container sandbox mode, one per user: a user with `sandbox.shell` (and a configured runner) gets the container for
// agent runs AND for the Files API, so no host-side realpath check ever races a shell that can create symlinks (TOCTOU).

export const permissionsOf = (userId: string): Permission[] => {
  const r = db.prepare('SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').get(userId) as { permissions: string } | undefined;
  return r ? JSON.parse(r.permissions) : [];
};
export const runnerConfigured = () => !!process.env.HEFYN_RUNNER_URL;
export const shellEnabled = (userId: string) => runnerConfigured() && permissionsOf(userId).includes('sandbox.shell');

const usageCache = new Map<string, { at: number; over: boolean }>();
/** Over quota? Cached for 60 s: it walks the user's tree. */
export async function overQuota(userId: string): Promise<boolean> {
  const hit = usageCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.over;
  const over = (await usageBytes(userId)) >= quotaBytes();
  usageCache.set(userId, { at: Date.now(), over });
  return over;
}

const STATUS: Record<string, number> = { ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EISDIR: 400, ENOTDIR: 400, EINVAL: 400, ENOSPC: 413, EFBIG: 413 };

/** Same surface as `userFs` (what storage-routes uses), executed inside the user's files container. No host paths. */
export function containerStorage(userId: string, conversationId = 'files') {
  const fs = containerFs({ userId, conversationId });
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) {
      if (e instanceof ContainerFsError) throw new StorageError(STATUS[e.code] ?? 500, e.message);
      if (e instanceof StorageError) throw e;
      throw new StorageError(502, `the sandbox runner is unavailable (${(e as Error).message})`);
    }
  };
  const self = {
    readFileBuffer: (p: string) => wrap(() => fs.readFileBuffer(p)),
    async writeFile(p: string, content: string | Uint8Array) {
      const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      if (bytes > maxUploadBytes()) throw new StorageError(413, `file exceeds the upload limit of ${maxUploadBytes() / 1048576} MB`);
      if ((await usageBytes(userId)) + bytes > quotaBytes()) throw new StorageError(413, `storage quota of ${quotaBytes() / 1048576} MB exceeded`);
      await wrap(() => fs.writeFile(p, content));
    },
    async stat(p: string) { return wrap(() => fs.stat(p)); },
    async list(p: string): Promise<Entry[]> {
      const r = await wrap(async () => { const dir = cleanPath(p); return fs.run(['find', dir + '/', '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0%y\\0%s\\0%T@\\0']); });
      if (r.exitCode !== 0) throw new StorageError(/No such file/.test(r.stderr) ? 404 : 400, `${p}: ${/No such file/.test(r.stderr) ? 'not found' : 'cannot list'}`);
      const f = r.stdout.split('\0');
      const out: Entry[] = [];
      for (let i = 0; i + 3 < f.length; i += 4) out.push({ name: f[i], type: f[i + 1] === 'l' ? 'symlink' : f[i + 1] === 'd' ? 'dir' : 'file', size: Number(f[i + 2]), mtime: new Date(Number(f[i + 3]) * 1000).toISOString() });
      return out;
    },
    exists: (p: string) => fs.exists(p),
    mkdir: (p: string, o?: { recursive?: boolean }) => wrap(() => fs.mkdir(p, o)),
    rm: (p: string, o?: { recursive?: boolean; force?: boolean }) => wrap(() => fs.rm(p, o)),
    rename: (a: string, b: string) => wrap(() => fs.rename(a, b)),
    async uniqueName(dir: string, name: string) {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let i = 0; ; i++) {
        const p = posix.join(posix.normalize('/' + dir), i ? `${stem} (${i})${ext}` : name);
        const r = await wrap(() => fs.run(['bash', '-c', '[ -e "$1" ] || [ -L "$1" ]', 'x', p]));
        if (r.exitCode !== 0) return p;
      }
    },
    async readStream(p: string, size: number) { return fs.readStream(p, size); },
  };
  return self;
}

/** Storage for the @ popover's files: the container for shell users, the confined host dir for everyone else. */
export function fsFor(userId: string, conversationId?: string) {
  return shellEnabled(userId) ? containerStorage(userId, conversationId) : userFs({ userId, conversationId });
}

// ---- built-in managed connector: Playwright (browser) in its own container, started lazily by the runner ----
export const PLAYWRIGHT = 'builtin:playwright';
export const PLAYWRIGHT_NOTE = 'Browser pages reach the model as text and as screenshots. The browser has open internet access: page URLs and form input the model writes leave hefyn to the sites it visits, so only enable it for people who may browse.';
export const playwrightEnabled = (userId: string) =>
  runnerConfigured() && permissionsOf(userId).includes('mcp.run_managed') && !!db.prepare('SELECT 1 FROM user_builtins WHERE user_id = ? AND id = ? AND enabled = 1').get(userId, PLAYWRIGHT);
export const setPlaywright = (userId: string, on: boolean) => void db.prepare('INSERT OR REPLACE INTO user_builtins (user_id, id, enabled) VALUES (?,?,?)').run(userId, PLAYWRIGHT, on ? 1 : 0);

/** Container names are derived (sha256 of user + conversation), so the URL is known before the container exists. */
export const playwrightUrl = (userId: string, conversationId: string) =>
  `http://hefyn-pw-${createHash('sha256').update(`${userId}\0${conversationId}`).digest('hex').slice(0, 16)}:8931/mcp`;

/** fetch for the MCP transport that makes sure the container runs first. A failure surfaces as a failed connection (the connector is optional). */
export function playwrightFetch(userId: string, conversationId: string): typeof fetch {
  let ready: Promise<void> | undefined;
  const start = async () => {
    const res = await fetch(`${process.env.HEFYN_RUNNER_URL!.replace(/\/$/, '')}/mcp/playwright`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hefyn-internal': process.env.HEFYN_INTERNAL_TOKEN ?? '' }, body: JSON.stringify({ userId, conversationId }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`browser unavailable (${res.status}): ${j.error ?? 'unknown error'}`);
    if (j.url !== playwrightUrl(userId, conversationId)) throw new Error('runner returned an unexpected browser address');
  };
  return async (input, init) => { await (ready ??= start().catch((e) => { ready = undefined; throw e; })); return fetch(input, init); };
}
