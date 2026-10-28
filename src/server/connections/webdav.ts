import { StorageError, maxUploadBytes } from '../storage.ts';
import { assertPublicTarget, limited, msg, oneChunk, readAll, segments, tooBig, type Adapter, type RemoteEntry, type StorageProvider } from './types.ts';

// WebDAV (Nextcloud, ownCloud, most NAS) over plain fetch: PROPFIND, GET, PUT, MKCOL, DELETE, MOVE. Safeguards: https only (http with HEFYN_ALLOW_PRIVATE_URLS=1),
// no private hosts, no credentials in the URL, redirects only inside the configured origin, `..` refused, PROPFIND entries outside the folder ignored, 30 s timeout.
const MB = 1048576;
const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';
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

  async function propfind(segs: string[], depth: 0 | 1): Promise<RemoteEntry[]> {
    const res = await req('PROPFIND', urlOf(segs), { headers: { depth: String(depth), 'content-type': 'application/xml' }, body: PROPS });
    if (res.status !== 207) return fail(res);
    const xml = new TextDecoder().decode(await readAll(limited(res.body ?? oneChunk(new Uint8Array()), 8 * MB)));
    const want = [...baseParts, ...segs];
    const out: RemoteEntry[] = [];
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
      const etag = unxml(tag(m[1], 'getetag') ?? '').trim();
      out.push({ name, type: /<(?:[\w-]+:)?collection\b/i.test(tag(m[1], 'resourcetype') ?? '') ? 'dir' : 'file', size: Number(tag(m[1], 'getcontentlength')) || 0, mtime: Number.isNaN(mod) ? '' : new Date(mod).toISOString(), ...(etag ? { etag } : {}) });
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
    caps: async () => ({ write: true, mkdir: true, rename: true, delete: true, etag: true }),
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

/** https only (http only when HEFYN_ALLOW_PRIVATE_URLS=1 for a LAN server or tests), no private hosts, no credentials in the URL. */
export async function assertWebdavUrl(raw: string): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new StorageError(400, 'url: not a valid address'); }
  if (!/^https?:$/.test(u.protocol)) throw new StorageError(400, 'url: only http(s) addresses are allowed');
  if (u.username || u.password) throw new StorageError(400, 'put the username and password in their own fields, not in the URL');
  if (u.protocol !== 'https:' && process.env.HEFYN_ALLOW_PRIVATE_URLS !== '1') throw new StorageError(400, 'url: WebDAV needs an https address');
  await assertPublicTarget(u.hostname.replace(/^\[|\]$/g, ''));
  return u.toString();
}

export const webdavProvider: StorageProvider = {
  kind: 'webdav', label: 'WebDAV / Nextcloud',
  fields: [
    { name: 'url', label: 'Address', type: 'url', required: true, hint: 'Nextcloud: https://your-host/remote.php/dav/files/<user>/' },
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'password', label: 'App password', type: 'secret', required: true, hint: 'Nextcloud: Settings, Security, create an app password' },
  ],
  connect: async (c, s) => webdavAdapter({ url: await assertWebdavUrl(String(c.url ?? '')), username: String(c.username ?? ''), password: s.password ?? '' }),
};
