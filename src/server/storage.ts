import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, join, resolve as resolveHost, sep } from 'node:path';
import { posix } from 'node:path';
import type { FileStat } from '@flue/runtime'; // type only: the web process never loads Flue

// Per-user storage: <HEFYN_DATA_DIR>/users/<userId>/files/ (persistent) and .../tmp/<conversationId>/ (scratch).
// Agents see `/files/...` and `/tmp/...`; nothing outside those two roots is reachable.
// shortcut: checks are realpath-before-use, so a symlink swapped in between check and use (TOCTOU) is not
// covered; it needs a local attacker who can create symlinks, which only the (future) shell sandbox could.

export class StorageError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MB = 1024 * 1024;
const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && n >= 0 && Number.isFinite(n) ? n : d; };
export const baseDir = () => resolveHost(process.env.HEFYN_DATA_DIR || './data');
export const quotaBytes = () => num(process.env.HEFYN_USER_QUOTA_MB, 1024) * MB;
export const maxUploadBytes = () => num(process.env.HEFYN_MAX_UPLOAD_MB, 100) * MB;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
// Conversation ids are u_<userId>_<ulid> (same rule as usage.ts, duplicated on purpose).
export const userOfConversation = (id: string) => /^u_([A-Za-z0-9-]+)_[0-9A-Za-z]+$/.exec(id)?.[1];
const checkId = (kind: string, v: string) => { if (!ID.test(v)) throw new StorageError(400, `invalid ${kind}`); return v; };

const userDir = (userId: string) => join(baseDir(), 'users', checkId('user id', userId));
const MAX_PATH = 1024, MAX_SEGMENT = 255;

/** Validate and normalise an agent-visible path to an absolute POSIX path (no `..`, no NUL, bounded length). */
export function cleanPath(p: string): string {
  if (typeof p !== 'string') throw new StorageError(400, 'invalid path');
  if (p.includes('\0')) throw new StorageError(400, 'path contains a NUL byte');
  if (p.length > MAX_PATH) throw new StorageError(400, 'path too long');
  if (p.includes('\\')) throw new StorageError(400, 'backslashes are not allowed in paths');
  const parts = p.split('/');
  if (parts.some((s) => s === '..')) throw new StorageError(403, 'path escapes the storage area');
  if (parts.some((s) => s.length > MAX_SEGMENT)) throw new StorageError(400, 'path segment too long');
  return posix.normalize('/' + p);
}

const within = (child: string, root: string) => child === root || child.startsWith(root + sep);

const codes: Record<string, [number, string]> = {
  ENOENT: [404, 'not found'], EEXIST: [409, 'already exists'], ENOTDIR: [400, 'not a directory'],
  EISDIR: [400, 'is a directory'], ENOTEMPTY: [409, 'directory not empty'], ENAMETOOLONG: [400, 'path too long'],
};
const wrap = async <T>(path: string, f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e: any) {
    if (e instanceof StorageError) throw e;
    const [status, msg] = codes[e?.code] ?? [500, 'storage error'];
    throw new StorageError(status, `${path}: ${msg}`);
  }
};

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await sizeOf(p);
    else total += (await fsp.lstat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Bytes used by a user's files/ + tmp/. */
export const usageBytes = (userId: string) => sizeOf(join(userDir(userId), 'files')).then(async (a) => a + (await sizeOf(join(userDir(userId), 'tmp'))));
export const usage = async (userId: string) => ({ used: await usageBytes(userId), quota: quotaBytes() });

export interface Entry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: string }

/** Confined filesystem for one user. `/tmp` is only available when a conversationId is given. */
export function userFs({ userId, conversationId }: { userId: string; conversationId?: string }) {
  const filesRoot = join(userDir(userId), 'files');
  const tmpRoot = conversationId ? join(userDir(userId), 'tmp', checkId('conversation id', conversationId)) : undefined;

  /** Map a virtual path to a host path, creating the root lazily, and prove (via realpath) it stays inside it. */
  async function locate(virtual: string, o: { noFollow?: boolean } = {}): Promise<{ real: string; virtual: string } | { virtual: '/' }> {
    const v = cleanPath(virtual);
    if (v === '/') return { virtual: '/' };
    const m = /^\/(files|tmp)(\/.*)?$/.exec(v);
    if (!m) throw new StorageError(403, 'only /files and /tmp are accessible');
    const root = m[1] === 'files' ? filesRoot : tmpRoot;
    if (!root) throw new StorageError(403, '/tmp is not available here');
    await fsp.mkdir(root, { recursive: true });
    const rootReal = await fsp.realpath(root);
    const target = join(rootReal, m[2] ?? '');
    // Resolve symlinks on the deepest existing ancestor (the parent only when `noFollow`, so a link itself can be removed/renamed).
    let probe = o.noFollow ? dirname(target) : target;
    const tail: string[] = o.noFollow && target !== probe ? [target.slice(probe.length + 1)] : [];
    for (;;) {
      try { probe = await fsp.realpath(probe); break; } catch (e: any) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        // A dangling symlink would be followed by a later write: refuse it.
        if ((await fsp.lstat(probe).catch(() => null))?.isSymbolicLink()) throw new StorageError(403, 'dangling symlink');
        tail.unshift(probe.slice(dirname(probe).length + 1));
        probe = dirname(probe);
      }
    }
    const real = join(probe, ...tail);
    if (!within(real, rootReal)) throw new StorageError(403, 'path escapes the storage area');
    return { real, virtual: v };
  }
  const need = async (p: string, o?: { noFollow?: boolean }) => {
    const r = await locate(p, o);
    if (!('real' in r)) throw new StorageError(403, 'operation not allowed on the storage root');
    if (r.virtual === '/files' || r.virtual === '/tmp') { if (o?.noFollow) throw new StorageError(403, `${r.virtual} itself cannot be changed`); }
    return r;
  };

  async function checkQuota(extra: number, replacing: number) {
    if (extra > maxUploadBytes()) throw new StorageError(413, `file exceeds the upload limit of ${maxUploadBytes() / MB} MB`);
    const used = await usageBytes(userId);
    if (used - replacing + extra > quotaBytes()) throw new StorageError(413, `storage quota of ${quotaBytes() / MB} MB exceeded`);
  }

  const self = {
    /** Verified host path of an existing path (for streaming). */
    async hostPath(p: string) { return (await need(p)).real; },
    async readFileBuffer(p: string): Promise<Uint8Array> { const { real } = await need(p); return wrap(p, () => fsp.readFile(real)); },
    async readFile(p: string) { return Buffer.from(await self.readFileBuffer(p)).toString('utf8'); },
    async writeFile(p: string, content: string | Uint8Array) {
      const { real } = await need(p);
      const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      const old = (await fsp.stat(real).catch(() => null));
      if (old?.isDirectory()) throw new StorageError(400, `${p}: is a directory`);
      await checkQuota(bytes, old?.size ?? 0);
      await fsp.mkdir(dirname(real), { recursive: true }); // parent already proven inside the root
      await wrap(p, () => fsp.writeFile(real, content));
    },
    async stat(p: string): Promise<FileStat> {
      const r = await locate(p);
      if (!('real' in r)) return { isFile: false, isDirectory: true };
      const s = await wrap(p, () => fsp.stat(r.real));
      const l = await fsp.lstat(r.real);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: l.isSymbolicLink(), size: s.size, mtime: s.mtime };
    },
    async readdir(p: string): Promise<string[]> {
      const r = await locate(p);
      if (!('real' in r)) return tmpRoot ? ['files', 'tmp'] : ['files'];
      return wrap(p, () => fsp.readdir(r.real));
    },
    async list(p: string): Promise<Entry[]> {
      const names = await self.readdir(p);
      const out: Entry[] = [];
      for (const name of names) {
        const r = await locate(posix.join(cleanPath(p), name), { noFollow: true }).catch(() => null);
        const s = r && 'real' in r ? await fsp.lstat(r.real).catch(() => null) : null;
        if (s) out.push({ name, type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtime.toISOString() });
      }
      return out;
    },
    async exists(p: string) { try { const r = await locate(p); return !('real' in r) || await fsp.access(r.real).then(() => true, () => false); } catch { return false; } },
    async mkdir(p: string, o?: { recursive?: boolean }) { const { real } = await need(p); await wrap(p, () => fsp.mkdir(real, { recursive: o?.recursive ?? true })); },
    async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
      const { real } = await need(p, { noFollow: true });
      await wrap(p, () => fsp.rm(real, { recursive: o?.recursive ?? false, force: o?.force ?? false }));
    },
    async rename(from: string, to: string) {
      const a = await need(from, { noFollow: true }), b = await need(to, { noFollow: true });
      if (await fsp.lstat(b.real).then(() => true, () => false)) throw new StorageError(409, `${to}: already exists`);
      await fsp.mkdir(dirname(b.real), { recursive: true });
      await wrap(from, () => fsp.rename(a.real, b.real));
    },
    /** First free name in `dir` for `name` ("a.txt" -> "a (1).txt"). */
    async uniqueName(dir: string, name: string) {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let i = 0; ; i++) {
        const n = i ? `${stem} (${i})${ext}` : name;
        const p = posix.join(cleanPath(dir), n);
        if (!(await fsp.lstat((await need(p, { noFollow: true })).real).then(() => true, () => false))) return p;
      }
    },
    openRead: (real: string) => createReadStream(real),
  };
  return self;
}

/** Remove conversation tmp dirs whose newest file/dir mtime is older than N days. Returns the number removed. */
export async function cleanupTmp({ olderThanDays = 7, now = Date.now() }: { olderThanDays?: number; now?: number } = {}): Promise<number> {
  const cutoff = now - olderThanDays * 86_400_000;
  const newest = async (p: string): Promise<number> => {
    let m = (await fsp.lstat(p)).mtimeMs;
    for (const e of await fsp.readdir(p, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) m = Math.max(m, await newest(join(p, e.name))); else m = Math.max(m, (await fsp.lstat(join(p, e.name)).catch(() => null))?.mtimeMs ?? 0);
    return m;
  };
  let removed = 0;
  const users = join(baseDir(), 'users');
  for (const u of await fsp.readdir(users).catch(() => [])) {
    const tmp = join(users, u, 'tmp');
    for (const c of await fsp.readdir(tmp).catch(() => [])) {
      const dir = join(tmp, c);
      if ((await newest(dir).catch(() => Infinity)) < cutoff) { await fsp.rm(dir, { recursive: true, force: true }); removed++; }
    }
  }
  return removed;
}

export const deleteConversationTmp = async (userId: string, conversationId: string) =>
  fsp.rm(join(userDir(userId), 'tmp', checkId('conversation id', conversationId)), { recursive: true, force: true });

/** GDPR: remove everything stored for a user. */
export const deleteUserStorage = async (userId: string) => fsp.rm(userDir(userId), { recursive: true, force: true });
