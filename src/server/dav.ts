import { Hono, type Context } from 'hono';
import { posix } from 'node:path';
import { checkAppPassword, touchAppPassword } from './app-passwords.ts';
import { db } from './appdb.ts';
import { clientIp, peerOf } from './clientip.ts';
import { meFromUserId } from './guard.ts';
import { fsFor } from './runner.ts';
import { StorageError, cleanPath, maxUploadBytes } from './storage.ts';

// WebDAV on /dav/ (docs/STORAGE.md "Access from other apps"): the user's own /files for Finder, Windows, Nextcloud clients, rclone.
// HTTP Basic only: username = account email, password = an app password. No cookies are read here, so a browser cannot be made to act (CSRF),
// and the account password never works. Everything goes through fsFor(userId) rooted at /files.
// shortcut: LOCK/UNLOCK are fake (a token is handed out, nothing is held or checked) so Finder and Windows will write; two clients can still overwrite each other.
// shortcut: GET reads the file into memory (like Files download for the sandbox path); upgrade to streaming if big files hurt.
export const dav = new Hono();

const ALLOW = 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK';
const READ = new Set(['OPTIONS', 'PROPFIND', 'GET', 'HEAD']);
const BASE = '/dav';

// Failed sign-ins per IP+user: 10 a minute, then 429 even for the right password.
const fails = new Map<string, { n: number; at: number }>();
const blocked = (k: string) => { const f = fails.get(k); return !!f && Date.now() - f.at < 60_000 && f.n >= 10; };
function fail(k: string, why: string) {
  const f = fails.get(k);
  if (fails.size > 10_000) for (const [x, v] of fails) if (Date.now() - v.at > 60_000) fails.delete(x);
  fails.set(k, !f || Date.now() - f.at >= 60_000 ? { n: 1, at: Date.now() } : { n: f.n + 1, at: f.at });
  console.warn(`[hefyn] dav: failed sign-in (${why}) ${k}`);
}

const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
const xml = (status: number, body: string, headers: Record<string, string> = {}) => new Response('<?xml version="1.0" encoding="utf-8"?>' + body, { status, headers: { 'content-type': 'application/xml; charset=utf-8', ...headers } });
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const href = (parts: string[], dir: boolean) => BASE + '/' + parts.map((p) => encodeURIComponent(p)).join('/') + (dir && parts.length ? '/' : '');

/** Request path under /dav -> segments (no empty, `.`, `..`, or encoded slashes). */
function segments(pathname: string): string[] {
  if (pathname !== BASE && !pathname.startsWith(BASE + '/')) throw new StorageError(400, 'not a WebDAV path');
  const out: string[] = [];
  for (const raw of pathname.slice(BASE.length).split('/')) {
    if (!raw) continue;
    let s: string;
    try { s = decodeURIComponent(raw); } catch { throw new StorageError(400, 'bad path encoding'); }
    if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) throw new StorageError(403, 'bad path');
    out.push(s);
  }
  return out;
}
const vpath = (parts: string[]) => cleanPath('/files/' + parts.join('/'));

const localhost = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);

type Fs = ReturnType<typeof fsFor>;
type Who = { userId: string; write: boolean };

function propEntry(parts: string[], dir: boolean, size: number, mtime: Date) {
  return `<D:response><D:href>${esc(href(parts, dir))}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${esc(parts.at(-1) ?? 'files')}</D:displayname>`
    + `<D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>`
    + (dir ? '' : `<D:getcontentlength>${size}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype><D:getetag>"${size}-${mtime.getTime()}"</D:getetag>`)
    + `<D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified><D:creationdate>${mtime.toISOString()}</D:creationdate>`
    + `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/>`
    + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const tooBig = () => new StorageError(413, `file exceeds the upload limit of ${max / 1048576} MB`);
  if (Number(req.headers.get('content-length') ?? 0) > max) throw tooBig();
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  const r = req.body.getReader();
  for (let x = await r.read(); !x.done; x = await r.read()) {
    n += x.value.byteLength;
    if (n > max) { void r.cancel(); throw tooBig(); }
    chunks.push(x.value);
  }
  return Buffer.concat(chunks);
}

const statOr = async (fs: Fs, p: string) => { try { return await fs.stat(p); } catch (e) { if (e instanceof StorageError && e.status === 404) return null; throw e; } };

/** Copy a file or a folder tree (symlinks are skipped, depth is capped). */
async function copyTree(fs: Fs, from: string, to: string, deep: boolean, depth = 0): Promise<void> {
  if (depth > 32) throw new StorageError(400, 'folder is nested too deep');
  const s = await fs.stat(from);
  if (s.isFile) return fs.writeFile(to, await fs.readFileBuffer(from));
  await fs.mkdir(to, { recursive: false });
  if (!deep) return;
  for (const e of await fs.list(from)) if (e.type !== 'symlink') await copyTree(fs, posix.join(from, e.name), posix.join(to, e.name), true, depth + 1);
}

async function handle(c: Context, who: Who): Promise<Response> {
  const m = c.req.method;
  const url = new URL(c.req.url);
  const parts = segments(url.pathname);
  const fs = fsFor(who.userId);
  const p = vpath(parts);
  if (!READ.has(m) && !who.write) return text(403, 'This app password is read-only');

  if (m === 'OPTIONS') return new Response(null, { status: 200, headers: { dav: '1, 2', allow: ALLOW, 'ms-author-via': 'DAV', 'content-length': '0' } });
  if (m === 'LOCK') {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    return xml(200, `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`, { 'lock-token': `<${token}>` });
  }
  if (m === 'UNLOCK') return new Response(null, { status: 204 });
  if (!parts.length) await fs.mkdir('/files', { recursive: true }); // first use: the folder may not exist yet (the root cannot be changed otherwise)
  const s = await statOr(fs, p);

  if (m === 'PROPFIND') {
    const depth = (c.req.header('depth') ?? '1').toLowerCase();
    if (depth === 'infinity') return xml(403, '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>');
    if (!s) return text(404, 'Not found');
    let out = propEntry(parts, s.isDirectory, s.size ?? 0, s.mtime ?? new Date(0));
    if (s.isDirectory && depth !== '0') for (const e of await fs.list(p)) if (e.type !== 'symlink') out += propEntry([...parts, e.name], e.type === 'dir', e.size, new Date(e.mtime));
    return xml(207, `<D:multistatus xmlns:D="DAV:">${out}</D:multistatus>`);
  }
  if (m === 'PROPPATCH') { // accepted, nothing stored
    if (!s) return text(404, 'Not found');
    return xml(207, `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${esc(href(parts, s.isDirectory))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
  }
  if (m === 'GET' || m === 'HEAD') {
    if (!s) return text(404, 'Not found');
    if (s.isDirectory) return text(405, 'This is a folder', { allow: ALLOW });
    const size = s.size ?? 0;
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: `"${size}-${s.mtime?.getTime() ?? 0}"`, 'last-modified': (s.mtime ?? new Date(0)).toUTCString() };
    let start = 0, end = size - 1, status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (r && (r[1] || r[2])) {
      start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
      end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start > end || start >= size) return text(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` });
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(status === 206 ? end - start + 1 : size);
    if (m === 'HEAD') return new Response(null, { status, headers });
    return new Response(Buffer.from(await fs.readFileBuffer(p)).subarray(start, end + 1), { status, headers });
  }
  if (!parts.length && m !== 'COPY') return text(403, 'The top folder cannot be changed');

  if (m === 'PUT') {
    if (s?.isDirectory) return text(405, 'This is a folder', { allow: ALLOW });
    if (!(await statOr(fs, posix.dirname(p)))?.isDirectory) return text(409, 'The parent folder does not exist');
    await fs.writeFile(p, await readCapped(c.req.raw, maxUploadBytes()));
    return new Response(null, { status: s ? 204 : 201 });
  }
  if (m === 'DELETE') {
    if (!s) return text(404, 'Not found');
    await fs.rm(p, { recursive: true });
    return new Response(null, { status: 204 });
  }
  if (m === 'MKCOL') {
    if (Number(c.req.header('content-length') ?? 0) > 0) return text(415, 'MKCOL takes no body');
    if (s) return text(405, 'Already exists', { allow: ALLOW });
    if (!(await statOr(fs, posix.dirname(p)))?.isDirectory) return text(409, 'The parent folder does not exist');
    await fs.mkdir(p, { recursive: false });
    return new Response(null, { status: 201 });
  }
  if (m === 'MOVE' || m === 'COPY') {
    if (!s) return text(404, 'Not found');
    if (m === 'MOVE' && !parts.length) return text(403, 'The top folder cannot be changed');
    let d: URL;
    try { d = new URL(c.req.header('destination') ?? '', url); } catch { return text(400, 'Bad Destination'); }
    if (d.host !== url.host || d.protocol !== url.protocol) return text(502, 'Destination is on another server');
    const dparts = segments(d.pathname);
    if (!dparts.length) return text(403, 'The top folder cannot be replaced');
    const dp = vpath(dparts);
    if (dp === p || dp.startsWith(p + '/')) return text(403, 'Destination is the source or inside it');
    if (!(await statOr(fs, posix.dirname(dp)))?.isDirectory) return text(409, 'The parent folder does not exist');
    const had = await statOr(fs, dp);
    if (had && (c.req.header('overwrite') ?? 'T').toUpperCase() === 'F') return text(412, 'Destination exists');
    if (had) await fs.rm(dp, { recursive: true });
    if (m === 'MOVE') await fs.rename(p, dp);
    else await copyTree(fs, p, dp, (c.req.header('depth') ?? 'infinity') !== '0');
    return new Response(null, { status: had ? 204 : 201 });
  }
  return text(405, 'Method not allowed', { allow: ALLOW });
}

dav.all('*', async (c) => {
  const url = new URL(c.req.url);
  const send = (res: Response) => {
    // This is the console origin: whatever is stored must never render here.
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('content-security-policy', 'sandbox');
    res.headers.set('cache-control', 'no-store');
    if (c.req.method === 'GET' || c.req.method === 'HEAD') res.headers.set('content-disposition', 'attachment');
    return res;
  };
  const challenge = () => send(text(401, 'Sign in with your email and an app password', { 'www-authenticate': 'Basic realm="hefyn files", charset="UTF-8"' }));
  // Basic auth must not travel in the clear; plain http is only for localhost.
  const proto = (c.req.header('x-forwarded-proto') ?? url.protocol).split(',')[0].replace(':', '').trim();
  if (proto !== 'https' && !localhost(url.hostname)) return send(text(403, 'WebDAV needs https'));

  const [email, ...rest] = Buffer.from(/^Basic (\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '', 'base64').toString('utf8').split(':');
  if (!email) return challenge();
  const ip = clientIp(peerOf(c), { xff: c.req.header('x-forwarded-for'), realIp: c.req.header('x-real-ip') });
  const key = `${ip}|${email.toLowerCase()}`;
  if (blocked(key)) return send(text(429, 'Too many failed attempts, try again in a minute', { 'retry-after': '60' }));
  const u = db.prepare('SELECT id FROM user WHERE lower(email) = ?').get(email.toLowerCase()) as { id: string } | undefined;
  const ok = u && checkAppPassword(u.id, rest.join(':'));
  const me = u && meFromUserId(u.id);
  if (!u || !ok || !me) { fail(key, u ? 'bad password' : 'unknown user'); return challenge(); }
  if (!me.permissions.includes('sandbox.shell')) return send(text(403, 'This account may not use files'));
  touchAppPassword(ok.id, ip);
  try { return send(await handle(c, { userId: u.id, write: ok.write })); } catch (e) {
    if (e instanceof StorageError) return send(text(e.status === 502 ? 503 : e.status, e.message));
    throw e;
  }
});
