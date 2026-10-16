import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { FileStat } from '@flue/runtime'; // type only: the web process never loads Flue
import type { Client } from '@modelcontextprotocol/client';
import { db } from './appdb.ts';
import { decrypt, encrypt } from './crypto.ts';
import { assertPublicUrl, connectorExists, openClient } from './mcp.ts';
import { StorageError, cleanPath, maxUploadBytes, type Entry } from './storage.ts';

// Storage add-ons: external storage (WebDAV, or an MCP server with the filesystem tools) mounted as /files/<name>.
// `Adapter` is the one interface; `withAddons` routes /files/<name>/... of any per-user fs (host dir, container, agent sandbox)
// to it. Add-on bytes never count against the local quota; every read and write is capped at HEFYN_MAX_UPLOAD_MB.
// Reads reach the model only as tool results, i.e. through the privacy gate like everything else.
// shortcut: every operation opens a fresh connection (MCP: connect + tools/list + call); cache sessions if it gets slow.

export interface AddonEntry { name: string; type: 'file' | 'dir'; size: number; mtime: string } // mtime '' = unknown
export interface Caps { write: boolean; mkdir: boolean; rename: boolean; delete: boolean }
export interface Adapter {
  caps(): Promise<Caps>;
  list(rel: string): Promise<AddonEntry[]>;
  stat(rel: string): Promise<AddonEntry>;
  read(rel: string): Promise<ReadableStream<Uint8Array>>;
  write(rel: string, data: Uint8Array): Promise<void>;
  mkdir(rel: string): Promise<void>; // recursive, ok if it exists
  delete(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>; // fails if `to` exists
}

const MB = 1048576;
const tooBig = () => new StorageError(413, `file exceeds the limit of ${maxUploadBytes() / MB} MB`);
const msg = (e: unknown) => (e as Error)?.message ?? String(e);

/** Path inside an add-on as clean segments: no `..`/`.`, NUL or backslash. Names are sent literally (encoded), so `%2e%2e` is just a name. */
export function segments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\') || rel.length > 1024) throw new StorageError(400, 'invalid path');
  const s = rel.split('/').filter(Boolean);
  if (s.some((x) => x === '..' || x === '.')) throw new StorageError(403, 'path escapes the storage area');
  if (s.some((x) => x.length > 255)) throw new StorageError(400, 'path segment too long');
  return s;
}

const limited = (body: ReadableStream<Uint8Array>, max: number) => {
  let n = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { n += chunk.byteLength; if (n > max) ctl.error(tooBig()); else ctl.enqueue(chunk); } }));
};
export async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try { for await (const c of s) chunks.push(c); } catch (e) { if (e instanceof StorageError) throw e; throw new StorageError(502, `storage read failed: ${msg(e)}`); }
  return Buffer.concat(chunks);
}
const oneChunk = (b: Uint8Array) => new Blob([b as BlobPart]).stream() as ReadableStream<Uint8Array>;

// ---- WebDAV (Nextcloud, ownCloud, most NAS) over plain fetch ----
const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
const unxml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e.toLowerCase()] ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
const tag = (b: string, n: string) => new RegExp(`<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`, 'i').exec(b)?.[1];

export function webdavAdapter(o: { url: string; username: string; password: string; fetch?: typeof fetch }): Adapter {
  const base = new URL(o.url);
  const basePath = base.pathname.replace(/\/+$/, '');
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const baseParts = basePath.split('/').map(dec);
  const auth = 'Basic ' + Buffer.from(`${o.username}:${o.password}`).toString('base64');
  const doFetch = o.fetch ?? fetch;
  const urlOf = (segs: string[]) => `${base.origin}${basePath}${segs.map((s) => '/' + encodeURIComponent(s)).join('')}`;

  /** One request. Redirects are followed only inside the same origin (the credentials never leave the configured host). */
  async function req(method: string, url: string, init: { headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Response> {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      let res: Response;
      try { res = await doFetch(u, { method, redirect: 'manual', headers: { authorization: auth, ...init.headers }, body: init.body as BodyInit | undefined, signal: AbortSignal.timeout(30_000) }); }
      catch (e) { throw new StorageError(502, `storage server unreachable: ${msg(e)}`); }
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) return res;
      await res.body?.cancel().catch(() => {});
      const next = new URL(loc, u);
      if (next.origin !== base.origin) throw new StorageError(502, 'the storage server redirected to another host; refused');
      u = next.toString();
    }
    throw new StorageError(502, 'too many redirects from the storage server');
  }
  const fail = async (res: Response): Promise<never> => {
    await res.body?.cancel().catch(() => {});
    const s = res.status;
    throw new StorageError(s === 401 ? 502 : s === 403 ? 403 : s === 404 ? 404 : s === 405 ? 400 : s === 409 || s === 412 || s === 423 ? 409 : s === 413 || s === 507 ? 413 : 502,
      s === 401 ? 'storage login failed: check the username and app password' : s === 403 ? 'the storage server denied access' : s === 404 ? 'not found' : s === 405 ? 'not allowed here (is it a folder?)' : s === 409 || s === 412 ? 'already exists or the parent folder is missing' : s === 423 ? 'locked on the storage server' : `the storage server answered ${s}`);
  };

  async function propfind(segs: string[], depth: 0 | 1): Promise<AddonEntry[]> {
    const res = await req('PROPFIND', urlOf(segs), { headers: { depth: String(depth), 'content-type': 'application/xml' }, body: PROPS });
    if (res.status !== 207) return fail(res);
    const xml = new TextDecoder().decode(await readAll(limited(res.body ?? oneChunk(new Uint8Array()), 8 * MB)));
    const want = [...baseParts, ...segs];
    const out: AddonEntry[] = [];
    for (const m of xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
      const href = tag(m[1], 'href');
      if (href === undefined) continue;
      let parts: string[];
      try { parts = new URL(unxml(href).trim(), base).pathname.replace(/\/+$/, '').split('/').map(dec); } catch { continue; }
      // Only what really sits at / directly under the requested path (a server cannot hand us foreign paths).
      const self = parts.length === want.length, child = parts.length === want.length + 1;
      if (!(depth === 0 ? self : child) || !want.every((w, i) => parts[i] === w)) continue;
      const name = depth === 0 ? (segs.at(-1) ?? '') : parts[parts.length - 1];
      if (depth === 1 && (!name || name === '.' || name === '..' || /[/\0\\]/.test(name))) continue;
      const mod = Date.parse(unxml(tag(m[1], 'getlastmodified') ?? ''));
      out.push({ name, type: /<(?:[\w-]+:)?collection\b/i.test(tag(m[1], 'resourcetype') ?? '') ? 'dir' : 'file', size: Number(tag(m[1], 'getcontentlength')) || 0, mtime: Number.isNaN(mod) ? '' : new Date(mod).toISOString() });
    }
    return out;
  }
  async function mkcolAll(segs: string[]) {
    for (let i = 1; i <= segs.length; i++) {
      const res = await req('MKCOL', urlOf(segs.slice(0, i)));
      if (res.status === 405) { await res.body?.cancel().catch(() => {}); continue; } // exists
      if (!res.ok) await fail(res);
      await res.body?.cancel().catch(() => {});
    }
  }

  return {
    caps: async () => ({ write: true, mkdir: true, rename: true, delete: true }),
    list: async (rel) => propfind(segments(rel), 1),
    async stat(rel) {
      const segs = segments(rel);
      const e = (await propfind(segs, 0))[0];
      if (!e) throw new StorageError(404, 'not found');
      return e;
    },
    async read(rel) {
      const res = await req('GET', urlOf(segments(rel)));
      if (!res.ok) return fail(res);
      if (Number(res.headers.get('content-length')) > maxUploadBytes()) { await res.body?.cancel().catch(() => {}); throw tooBig(); }
      return limited(res.body ?? oneChunk(new Uint8Array()), maxUploadBytes());
    },
    async write(rel, data) {
      const segs = segments(rel);
      if (!segs.length) throw new StorageError(400, 'is a directory');
      if (data.byteLength > maxUploadBytes()) throw tooBig();
      let res = await req('PUT', urlOf(segs), { body: data });
      if (res.status === 409) { await res.body?.cancel().catch(() => {}); await mkcolAll(segs.slice(0, -1)); res = await req('PUT', urlOf(segs), { body: data }); } // missing parents
      if (!res.ok) await fail(res);
      await res.body?.cancel().catch(() => {});
    },
    mkdir: (rel) => mkcolAll(segments(rel)),
    async delete(rel) {
      const segs = segments(rel);
      if (!segs.length) throw new StorageError(403, 'the storage root cannot be deleted');
      const res = await req('DELETE', urlOf(segs));
      if (!res.ok) await fail(res);
      await res.body?.cancel().catch(() => {});
    },
    async rename(from, to) {
      const a = segments(from), b = segments(to);
      const move = () => req('MOVE', urlOf(a), { headers: { destination: urlOf(b), overwrite: 'F' } });
      let res = await move();
      if (res.status === 409) { await res.body?.cancel().catch(() => {}); await mkcolAll(b.slice(0, -1)); res = await move(); }
      if (!res.ok) await fail(res);
      await res.body?.cancel().catch(() => {});
    },
  };
}

// ---- MCP filesystem-style servers (official filesystem server tool names) ----
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: MB, GB: MB * 1024, TB: MB * 1048576 };
const mcpError = (text: string) => new StorageError(/ENOENT|not found|no such file/i.test(text) ? 404 : /exist/i.test(text) ? 409 : /outside|not allowed|denied|permission/i.test(text) ? 403 : 502, `storage server: ${text.slice(0, 200) || 'error'}`);

export function mcpAdapter(open: () => Promise<Client>): Adapter {
  interface S { tools: Set<string>; call(name: string, args: Record<string, unknown>): Promise<string>; root?: string }
  async function session<T>(f: (s: S) => Promise<T>): Promise<T> {
    let c: Client;
    try { c = await open(); } catch (e) { throw new StorageError(502, `storage server unreachable: ${msg(e)}`); }
    try {
      const s: S = {
        tools: new Set((await c.listTools()).tools.map((t) => t.name)),
        async call(name, args) {
          const r: any = await c.callTool({ name, arguments: args });
          const text = (r.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
          if (r.isError) throw mcpError(text);
          return text;
        },
      };
      return await f(s);
    } catch (e) {
      throw e instanceof StorageError ? e : new StorageError(502, `storage server error: ${msg(e)}`);
    } finally { await c.close().catch(() => {}); }
  }
  const need = (s: S, ...names: string[]) => names.find((n) => s.tools.has(n)) ?? (() => { throw new StorageError(403, `this storage server cannot do that (needs ${names.join(' or ')})`); })();
  // The server's first allowed directory is the add-on root; without that tool paths start at "/".
  async function abs(s: S, rel: string, ...extra: string[]) {
    const segs = [...segments(rel), ...extra];
    if (s.root === undefined) {
      const t = s.tools.has('list_allowed_directories') ? (await s.call('list_allowed_directories', {})).split('\n').map((l) => l.trim()).find((l) => l && !/^allowed/i.test(l)) : undefined;
      s.root = t ?? '/';
    }
    return posix.join(s.root, ...segs);
  }
  const parse = (text: string): AddonEntry[] => text.split('\n').flatMap((l) => {
    const m = /^\[(DIR|FILE)\]\s+(.*?)\s*$/.exec(l);
    if (!m) return [];
    const sz = m[1] === 'FILE' ? /^(.*?)\s+(\d+(?:\.\d+)?) (B|KB|MB|GB|TB)$/.exec(m[2]) : null;
    const name = sz ? sz[1] : m[2];
    return name ? [{ name, type: m[1] === 'DIR' ? 'dir' as const : 'file' as const, size: sz ? Math.round(Number(sz[2]) * UNITS[sz[3]]) : 0, mtime: '' }] : [];
  });
  const list = (s: S, rel: string) => abs(s, rel).then((p) => s.call(need(s, 'list_directory_with_sizes', 'list_directory'), { path: p })).then(parse);
  const write = (s: S) => need(s, 'write_file');

  return {
    caps: () => session(async (s) => ({ write: s.tools.has('write_file'), mkdir: s.tools.has('create_directory'), rename: s.tools.has('move_file'), delete: s.tools.has('delete_file') || s.tools.has('delete') })),
    list: (rel) => session((s) => list(s, rel)),
    stat: (rel) => session(async (s) => {
      const segs = segments(rel);
      if (!segs.length) return { name: '', type: 'dir' as const, size: 0, mtime: '' };
      if (s.tools.has('get_file_info')) {
        const t = await s.call('get_file_info', { path: await abs(s, rel) });
        const mod = Date.parse(/^modified:\s*(.+)$/im.exec(t)?.[1] ?? '');
        return { name: segs.at(-1)!, type: /^isDirectory:\s*true/im.test(t) ? 'dir' as const : 'file' as const, size: Number(/^size:\s*(\d+)/im.exec(t)?.[1]) || 0, mtime: Number.isNaN(mod) ? '' : new Date(mod).toISOString() };
      }
      const e = (await list(s, '/' + segs.slice(0, -1).join('/'))).find((x) => x.name === segs.at(-1));
      if (!e) throw new StorageError(404, 'not found');
      return e;
    }),
    read: (rel) => session(async (s) => {
      const text = await s.call(need(s, 'read_text_file', 'read_file'), { path: await abs(s, rel) });
      const bytes = Buffer.from(text);
      if (bytes.byteLength > maxUploadBytes()) throw tooBig();
      return oneChunk(bytes);
    }),
    write: (rel, data) => session(async (s) => {
      const tool = write(s);
      if (!segments(rel).length) throw new StorageError(400, 'is a directory');
      if (data.byteLength > maxUploadBytes()) throw tooBig();
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new StorageError(415, 'this storage only holds text files (the server has no binary write tool)'); }
      if (s.tools.has('create_directory')) await s.call('create_directory', { path: posix.dirname(await abs(s, rel)) }); // official tool is recursive
      await s.call(tool, { path: await abs(s, rel), content });
    }),
    mkdir: (rel) => session(async (s) => void await s.call(need(s, 'create_directory'), { path: await abs(s, rel) })),
    delete: (rel) => session(async (s) => {
      const tool = need(s, 'delete_file', 'delete');
      if (!segments(rel).length) throw new StorageError(403, 'the storage root cannot be deleted');
      await s.call(tool, { path: await abs(s, rel) });
    }),
    rename: (from, to) => session(async (s) => void await s.call(need(s, 'move_file'), { source: await abs(s, from), destination: await abs(s, to) })),
  };
}

// ---- definitions, visibility, credentials ----
export interface Addon { id: string; owner_id: string; name: string; visibility: 'private' | 'team'; kind: 'webdav' | 'mcp'; url: string | null; connector_id: string | null; shared: number; created_at: string }
export const ADDON_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
interface Creds { username: string; password: string }

/** Own + team add-ons. An MCP add-on whose connector was removed is gone with it. */
export const visibleAddons = (userId: string) => (db.prepare("SELECT * FROM storage_addons WHERE owner_id = ? OR visibility = 'team' ORDER BY name").all(userId) as unknown as Addon[])
  .filter((a) => a.kind !== 'mcp' || (a.connector_id && connectorExists(a.connector_id)));
export const addonById = (userId: string, id: string) => visibleAddons(userId).find((a) => a.id === id);
export const addonByName = (userId: string, name: string) => { const l = visibleAddons(userId).filter((a) => a.name === name); return l.find((a) => a.owner_id === userId) ?? l[0]; };

const credRow = (a: Addon, userId: string) => db.prepare('SELECT enc FROM storage_addon_creds WHERE addon_id = ? AND user_id = ?').get(a.id, a.shared ? '' : userId) as { enc: string } | undefined;
export const credsOf = (a: Addon, userId: string): Creds | undefined => { const r = credRow(a, userId); return r ? JSON.parse(decrypt(r.enc)) : undefined; };
export const setCreds = (a: Addon, userId: string, c: Creds) => void db.prepare('INSERT OR REPLACE INTO storage_addon_creds (addon_id, user_id, enc) VALUES (?,?,?)').run(a.id, a.shared ? '' : userId, encrypt(JSON.stringify({ username: c.username, password: c.password })));
export const deleteAddon = (id: string) => { db.prepare('DELETE FROM storage_addons WHERE id = ?').run(id); db.prepare('DELETE FROM storage_addon_creds WHERE addon_id = ?').run(id); };

/** https only (http only when HEFYN_ALLOW_PRIVATE_URLS=1 for local dev/tests), no private hosts, no credentials in the URL. */
export function assertWebdavUrl(raw: string): string {
  const url = assertPublicUrl(raw);
  const u = new URL(url);
  if (u.username || u.password) throw new Error('put the username and password in their own fields, not in the URL');
  if (u.protocol !== 'https:' && process.env.HEFYN_ALLOW_PRIVATE_URLS !== '1') throw new Error('WebDAV needs an https URL');
  return url;
}

export function checkName(userId: string, raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!ADDON_NAME.test(name)) throw new StorageError(400, 'name: use lowercase letters, digits and dashes (max 40); it becomes the folder name');
  if (visibleAddons(userId).some((a) => a.name === name)) throw new StorageError(409, 'a storage add-on with that name already exists');
  return name;
}

export function createWebdav(ownerId: string, b: { name: unknown; url: string; username: string; password: string; visibility?: string; sharedAccount?: boolean }) {
  const name = checkName(ownerId, b.name);
  if (!b.username || !b.password) throw new StorageError(400, 'username and app password are required');
  const team = b.visibility === 'team';
  const a: Addon = { id: randomUUID(), owner_id: ownerId, name, visibility: team ? 'team' : 'private', kind: 'webdav', url: assertWebdavUrl(b.url), connector_id: null, shared: team && b.sharedAccount ? 1 : 0, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO storage_addons (id, owner_id, name, visibility, kind, url, connector_id, shared, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(a.id, a.owner_id, a.name, a.visibility, a.kind, a.url, null, a.shared, a.created_at);
  setCreds(a, ownerId, { username: b.username, password: b.password });
  return a;
}
export function createMcpAddon(ownerId: string, name: unknown, connector: { id: string; visibility: string }) {
  const a: Addon = { id: randomUUID(), owner_id: ownerId, name: checkName(ownerId, name), visibility: connector.visibility === 'team' ? 'team' : 'private', kind: 'mcp', url: null, connector_id: connector.id, shared: 0, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO storage_addons (id, owner_id, name, visibility, kind, url, connector_id, shared, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(a.id, a.owner_id, a.name, a.visibility, a.kind, null, a.connector_id, 0, a.created_at);
  return a;
}

export function adapterFor(userId: string, a: Addon): Adapter {
  if (a.kind === 'mcp') return mcpAdapter(() => openClient(userId, a.connector_id!));
  const c = credsOf(a, userId);
  if (!c) throw new StorageError(409, `${a.name}: add your username and app password in Connectors first`);
  return webdavAdapter({ url: assertWebdavUrl(a.url!), ...c });
}

/** "Test connection": list the root. Never throws. */
export async function testAddon(userId: string, a: Addon): Promise<{ ok: boolean; entries?: number; readonly?: boolean; error?: string }> {
  try { const ad = adapterFor(userId, a); const entries = (await ad.list('')).length; return { ok: true, entries, readonly: !(await ad.caps()).write }; }
  catch (e) { return { ok: false, error: msg(e) }; }
}

// ---- the filesystem facade and the mount router ----
/** Same surface as `userFs` for one add-on; `rel` is relative to the add-on root ('' = the root). */
function addonFs(get: () => Adapter) {
  const bytesOf = (c: string | Uint8Array) => (typeof c === 'string' ? Buffer.from(c) : c);
  const root = (rel: string, what: string) => { if (!segments(rel).length) throw new StorageError(403, `the storage root cannot be ${what}`); };
  const self = {
    readFileBuffer: async (rel: string) => readAll(await get().read(rel)),
    readFile: async (rel: string) => Buffer.from(await self.readFileBuffer(rel)).toString('utf8'),
    writeFile: async (rel: string, c: string | Uint8Array) => { const b = bytesOf(c); if (b.byteLength > maxUploadBytes()) throw tooBig(); await get().write(rel, b); },
    async stat(rel: string): Promise<FileStat> {
      const e: AddonEntry = segments(rel).length ? await get().stat(rel) : { name: '', type: 'dir', size: 0, mtime: '' };
      return { isFile: e.type === 'file', isDirectory: e.type === 'dir', isSymbolicLink: false, size: e.size, ...(e.mtime ? { mtime: new Date(e.mtime) } : {}) };
    },
    list: async (rel: string): Promise<Entry[]> => (await get().list(rel)).map((e) => ({ ...e })),
    readdir: async (rel: string) => (await get().list(rel)).map((e) => e.name),
    exists: async (rel: string) => { try { await self.stat(rel); return true; } catch { return false; } },
    mkdir: async (rel: string) => { if (segments(rel).length) await get().mkdir(rel); },
    async rm(rel: string, o?: { recursive?: boolean; force?: boolean }) {
      root(rel, 'deleted');
      try { await get().delete(rel); } catch (e) { if (!(o?.force && e instanceof StorageError && e.status === 404)) throw e; }
    },
    rename: async (a: string, b: string) => { root(a, 'renamed'); root(b, 'replaced'); await get().rename(a, b); },
  };
  return self;
}

export interface AddonRef { id: string; name: string; kind: 'webdav' | 'mcp'; visibility: 'private' | 'team' }
const stripSlash = (s: string) => s.replace(/\/+$/, '');
/** Which add-on (and path inside it) an agent-visible path belongs to; undefined = a normal local path. */
function mountOf(userId: string, p: string) {
  let v: string;
  try { v = cleanPath(p); } catch { return undefined; } // let the base fs reject it with its own error
  const m = /^\/files\/([^/]+)(\/.*)?$/.exec(v);
  const a = m && addonByName(userId, m[1]);
  return a ? { a, rel: stripSlash(m![2] ?? '') } : undefined;
}
export const addonAt = (userId: string, p: string): AddonRef | undefined => { const m = mountOf(userId, p); return m && { id: m.a.id, name: m.a.name, kind: m.a.kind, visibility: m.a.visibility }; };
export const isAddonPath = (userId: string, p: string) => !!mountOf(userId, p);

/**
 * Route /files/<add-on>/... of a per-user fs (host dir, container or sandbox) to the add-on; /files lists the add-ons as folders
 * (they shadow a local folder of the same name). Moving between a local folder and an add-on, or between two add-ons, is refused.
 */
export function withAddons<T extends object>(fs: T, userId: string): T & { addonStream(p: string): Promise<ReadableStream<Uint8Array> | undefined> } {
  const base = fs as any;
  const on = (p: string) => { const m = mountOf(userId, p); return m && { fs: addonFs(() => adapterFor(userId, m.a)), rel: m.rel, a: m.a }; };
  const isFilesRoot = (p: string) => { try { return stripSlash(cleanPath(p)) === '/files'; } catch { return false; } };
  const mounts = () => visibleAddons(userId).filter((a, i, all) => all.findIndex((b) => b.name === a.name) === i);
  const o = {
    readFileBuffer: async (p: string) => { const m = on(p); return m ? m.fs.readFileBuffer(m.rel) : base.readFileBuffer(p); },
    readFile: async (p: string) => { const m = on(p); return m ? m.fs.readFile(m.rel) : base.readFile(p); },
    writeFile: async (p: string, c: string | Uint8Array) => { const m = on(p); return m ? m.fs.writeFile(m.rel, c) : base.writeFile(p, c); },
    stat: async (p: string) => { const m = on(p); return m ? m.fs.stat(m.rel) : base.stat(p); },
    exists: async (p: string) => { const m = on(p); return m ? m.fs.exists(m.rel) : base.exists(p); },
    mkdir: async (p: string, opt?: { recursive?: boolean }) => { const m = on(p); return m ? m.fs.mkdir(m.rel) : base.mkdir(p, opt); },
    rm: async (p: string, opt?: { recursive?: boolean; force?: boolean }) => { const m = on(p); return m ? m.fs.rm(m.rel, opt) : base.rm(p, opt); },
    async readdir(p: string) {
      const m = on(p);
      if (m) return m.fs.readdir(m.rel);
      const names: string[] = await base.readdir(p);
      if (!isFilesRoot(p)) return names;
      const add = mounts().map((a) => a.name);
      return [...names.filter((n) => !add.includes(n)), ...add];
    },
    async rename(from: string, to: string) {
      const a = on(from), b = on(to);
      if (!a && !b) return base.rename(from, to);
      if (!a || !b || a.a.id !== b.a.id) throw new StorageError(400, 'files cannot be moved between storages; download and upload instead');
      return a.fs.rename(a.rel, b.rel);
    },
    async uniqueName(dir: string, name: string) {
      const m = on(dir);
      if (!m) return base.uniqueName(dir, name);
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let i = 0; ; i++) {
        const n = i ? `${stem} (${i})${ext}` : name;
        if (!(await m.fs.exists(posix.join(m.rel, n)))) return posix.join(cleanPath(dir), n);
      }
    },
    async addonStream(p: string) { const m = on(p); return m ? adapterFor(userId, m.a).read(m.rel) : undefined; },
    ...(base.list ? { async list(p: string): Promise<Entry[]> {
      const m = on(p);
      if (m) return m.fs.list(m.rel);
      const entries: Entry[] = await base.list(p);
      if (!isFilesRoot(p)) return entries;
      const add = mounts();
      return [...entries.filter((e) => !add.some((a) => a.name === e.name)), ...add.map((a) => ({ name: a.name, type: 'dir' as const, size: 0, mtime: a.created_at, addon: { id: a.id, kind: a.kind, visibility: a.visibility } }))];
    } } : {}),
  };
  return { ...fs, ...o };
}
