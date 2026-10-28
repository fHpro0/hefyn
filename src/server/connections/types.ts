import { isIP } from 'node:net';
import { assertPublicHost } from '../mcp.ts';
import { StorageError, maxUploadBytes } from '../storage.ts';

// Connections (docs/STORAGE.md): a StorageProvider turns a connection's config + secrets into an Adapter for one remote; the sync engine
// (sync.ts) mirrors the remote into /files/<name>. Built-in modules register providers with `ctx.storage` (docs/MODULES.md, slot `storageProviders`).

export interface RemoteEntry { name: string; type: 'file' | 'dir'; size: number; mtime: string; etag?: string } // mtime '' = unknown
export interface Caps { write: boolean; mkdir: boolean; rename: boolean; delete: boolean; etag: boolean }
export interface Adapter {
  caps(): Promise<Caps>;
  list(rel: string): Promise<RemoteEntry[]>;
  stat(rel: string): Promise<RemoteEntry>;
  read(rel: string): Promise<ReadableStream<Uint8Array>>;
  write(rel: string, data: Uint8Array): Promise<void>; // creates missing parents
  mkdir(rel: string): Promise<void>; // recursive, ok if it exists
  delete(rel: string): Promise<void>; // a folder: only when the engine knows it is empty (WebDAV deletes recursively)
  rename(from: string, to: string): Promise<void>; // fails if `to` exists
  close?(): Promise<void>;
}

export interface Field { name: string; label: string; type: 'text' | 'url' | 'number' | 'secret' | 'select'; required?: boolean; hint?: string; options?: { value: string; label: string }[] }
/** `userId` and the pinned host key (SFTP) come with every connect; `pin` is called once a fresh host key proved good. */
export interface ConnectCtx { userId: string; hostKey?: string; pin(fingerprint: string): void }
export interface StorageProvider {
  kind: string;
  label: string;
  fields: Field[] | ((userId: string) => Field[]);
  connect(config: Record<string, any>, secrets: Record<string, string>, ctx: ConnectCtx): Promise<Adapter>;
}

/** The providers of the loaded modules (filled by StorageService in src/kernel/index.ts; the agent process fills it from sync.ts). */
export const providerRegistry = new Map<string, StorageProvider>();

const MB = 1048576;
export const tooBig = () => new StorageError(413, `file exceeds the limit of ${maxUploadBytes() / MB} MB`);
export const msg = (e: unknown) => (e as Error)?.message ?? String(e);

/** Path inside a remote as clean segments: no `..`/`.`, NUL or backslash. Names are sent literally (encoded), so `%2e%2e` is just a name. */
export function segments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\') || rel.length > 1024) throw new StorageError(400, 'invalid path');
  const s = rel.split('/').filter(Boolean);
  if (s.some((x) => x === '..' || x === '.')) throw new StorageError(403, 'path escapes the storage area');
  if (s.some((x) => x.length > 255)) throw new StorageError(400, 'path segment too long');
  return s;
}

export const limited = (body: ReadableStream<Uint8Array>, max: number) => {
  let n = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { n += chunk.byteLength; if (n > max) ctl.error(tooBig()); else ctl.enqueue(chunk); } }));
};
export async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try { for await (const c of s) chunks.push(c); } catch (e) { if (e instanceof StorageError) throw e; throw new StorageError(502, `storage read failed: ${msg(e)}`); }
  return Buffer.concat(chunks);
}
export const oneChunk = (b: Uint8Array) => new Blob([b as BlobPart]).stream() as ReadableStream<Uint8Array>;

/** Every provider calls this before it connects: private, loopback and link-local addresses are refused unless the admin set HEFYN_ALLOW_PRIVATE_URLS=1 (a NAS on the LAN).
 *  shortcut: the check and the connection resolve separately, so DNS rebinding in between is not covered (same as MCP connectors). */
export async function assertPublicTarget(host: string) {
  if (!host || /[\s/@]/.test(host)) throw new StorageError(400, 'host: enter a host name or IP address only');
  try { await assertPublicHost(`https://${isIP(host) === 6 ? `[${host}]` : host}/`); } catch (e) {
    throw new StorageError(400, `${msg(e)}. For a server on your own network the admin must set HEFYN_ALLOW_PRIVATE_URLS=1.`);
  }
}

/** Prefix an adapter with a remote folder: the connection's `remote_root`. */
export function rooted(a: Adapter, root: string): Adapter {
  const prefix = segments(root).join('/');
  if (!prefix) return a;
  const p = (rel: string) => [prefix, ...segments(rel)].join('/');
  return {
    caps: () => a.caps(), list: (r) => a.list(p(r)), stat: (r) => a.stat(p(r)), read: (r) => a.read(p(r)), write: (r, d) => a.write(p(r), d),
    mkdir: (r) => a.mkdir(p(r)), delete: (r) => a.delete(p(r)), rename: (x, y) => a.rename(p(x), p(y)), close: () => a.close?.() ?? Promise.resolve(),
  };
}
