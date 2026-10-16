import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Tiny in-memory WebDAV server under /dav (PROPFIND, GET, PUT, MKCOL, DELETE, MOVE) with Basic auth (user -> password).
// /dav/redir answers with a redirect to `redirectTo`; with `evil` a depth-1 listing also names a path outside the base.
export interface FakeDav { url: string; base: string; files: Map<string, Buffer | null>; log: { method: string; url: string; user: string }[]; close: () => void }

export function startFakeWebdav(o: { users: Record<string, string>; redirectTo?: string; evil?: boolean }): Promise<FakeDav> {
  const files = new Map<string, Buffer | null>([['/', null]]); // path -> content, null = collection
  const log: FakeDav['log'] = [];
  const parent = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
  const enc = (p: string) => '/dav' + p.split('/').map(encodeURIComponent).join('/');
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const entry = (p: string) => {
    const c = files.get(p);
    return `<d:response><d:href>${xml(enc(p === '/' ? '' : p) + (c === null ? '/' : ''))}</d:href><d:propstat><d:prop>${c === null ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${c!.length}</d:getcontentlength>`}<d:getlastmodified>Wed, 14 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      const [user, pw] = m ? Buffer.from(m[1], 'base64').toString().split(':') : ['', ''];
      log.push({ method: req.method!, url: req.url!, user });
      if (!m || o.users[user] !== pw) return void res.writeHead(401, { 'www-authenticate': 'Basic' }).end();
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/dav/redir') return void res.writeHead(302, { location: o.redirectTo ?? '/' }).end();
      if (!url.pathname.startsWith('/dav')) return void res.writeHead(404).end();
      const p = decodeURIComponent(url.pathname.slice(4)).replace(/\/+$/, '') || '/';
      const has = files.has(p);
      switch (req.method) {
        case 'PROPFIND': {
          if (!has) return void res.writeHead(404).end();
          const kids = req.headers.depth === '0' ? [] : [...files.keys()].filter((k) => k !== '/' && parent(k) === p);
          const extra = o.evil && req.headers.depth !== '0' ? '<d:response><d:href>/outside/stolen.txt</d:href><d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat></d:response>' : '';
          return void res.writeHead(207, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[p, ...kids].map(entry).join('')}${extra}</d:multistatus>`);
        }
        case 'GET': { const c = files.get(p); return void (c ? res.writeHead(200, { 'content-length': c.length }).end(c) : res.writeHead(has ? 405 : 404).end()); }
        case 'PUT':
          if (files.get(parent(p)) !== null) return void res.writeHead(409).end();
          if (has && files.get(p) === null) return void res.writeHead(405).end();
          files.set(p, body); return void res.writeHead(has ? 204 : 201).end();
        case 'MKCOL':
          if (has) return void res.writeHead(405).end();
          if (files.get(parent(p)) !== null) return void res.writeHead(409).end();
          files.set(p, null); return void res.writeHead(201).end();
        case 'DELETE':
          if (!has || p === '/') return void res.writeHead(404).end();
          for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k);
          return void res.writeHead(204).end();
        case 'MOVE': {
          const to = decodeURIComponent(new URL(String(req.headers.destination)).pathname.slice(4)).replace(/\/+$/, '');
          if (!has) return void res.writeHead(404).end();
          if (files.has(to)) return void res.writeHead(412).end();
          if (files.get(parent(to)) !== null) return void res.writeHead(409).end();
          for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) { files.set(to + k.slice(p.length), files.get(k)!); files.delete(k); }
          return void res.writeHead(201).end();
        }
        default: return void res.writeHead(405).end();
      }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok({ url, base: url + '/dav', files, log, close: () => { server.close(); server.closeAllConnections(); } }); }));
}
