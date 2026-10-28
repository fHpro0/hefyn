import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client, FileType } from 'basic-ftp';
import { StorageError, maxUploadBytes } from '../storage.ts';
import { assertPublicTarget, msg, oneChunk, segments, tooBig, type Adapter, type RemoteEntry, type StorageProvider } from './types.ts';

// FTP / FTPS over basic-ftp (MIT). Explicit FTPS (TLS, certificate checked) is required; plain FTP sends the password unencrypted and only works when the admin set HEFYN_ALLOW_PLAIN_FTP=1.
// shortcut: a file is held in memory while it transfers (capped by HEFYN_MAX_UPLOAD_MB); one control connection per sync run, 30 s timeout.
export const plainFtpAllowed = () => process.env.HEFYN_ALLOW_PLAIN_FTP === '1';

export interface FtpOpts { host: string; port?: number; username: string; password: string; secure: boolean }

export async function ftpConnect(o: FtpOpts): Promise<Adapter> {
  if (!o.secure && !plainFtpAllowed()) throw new StorageError(400, 'plain FTP sends the password unencrypted, so it is switched off. Use FTPS, or ask the admin to set HEFYN_ALLOW_PLAIN_FTP=1.');
  const c = new Client(30_000);
  try { await c.access({ host: o.host, port: o.port || 21, user: o.username, password: o.password, secure: o.secure, secureOptions: { servername: o.host } }); }
  catch (e) { c.close(); throw new StorageError(502, `FTP connection failed: ${msg(e)}`); }

  const abs = (rel: string) => { const s = segments(rel); if (s.some((x) => /[\r\n]/.test(x))) throw new StorageError(400, 'invalid path'); return '/' + s.join('/'); };
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) {
      if (e instanceof StorageError) throw e;
      const code = (e as { code?: number })?.code;
      throw new StorageError(code === 550 ? 404 : 502, code === 550 ? 'not found' : `FTP: ${msg(e)}`);
    }
  };
  const entry = (f: { name: string; type: number; size: number; modifiedAt?: Date }): RemoteEntry =>
    ({ name: f.name, type: f.type === FileType.Directory ? 'dir' : 'file', size: f.size, mtime: f.modifiedAt ? f.modifiedAt.toISOString() : '' });
  const list = (rel: string) => wrap(async () => (await c.list(abs(rel))).filter((f) => f.type !== FileType.SymbolicLink && f.name !== '.' && f.name !== '..').map(entry));
  async function mkdirs(rel: string) {
    let p = '';
    for (const s of segments(rel)) { p += '/' + s; await c.send('MKD ' + p).catch(() => {}); } // exists: a later upload fails clearly if it is really missing
  }
  const stat = async (rel: string) => {
    const s = segments(rel);
    const e = (await list('/' + s.slice(0, -1).join('/'))).find((x) => x.name === s.at(-1));
    if (!e) throw new StorageError(404, 'not found');
    return e;
  };

  return {
    caps: async () => ({ write: true, mkdir: true, rename: true, delete: true, etag: false }),
    list,
    stat,
    async read(rel) {
      const e = await stat(rel);
      if (e.type !== 'file') throw new StorageError(400, 'is a directory');
      if (e.size > maxUploadBytes()) throw tooBig();
      const chunks: Buffer[] = [];
      let n = 0;
      await wrap(() => c.downloadTo(new Writable({ write(b, _, cb) { n += b.length; if (n > maxUploadBytes()) return cb(tooBig()); chunks.push(b); cb(); } }), abs(rel)));
      return oneChunk(Buffer.concat(chunks));
    },
    async write(rel, data) {
      if (data.byteLength > maxUploadBytes()) throw tooBig();
      await wrap(async () => { await mkdirs(posix.dirname(abs(rel))); await c.uploadFrom(Readable.from([Buffer.from(data)]), abs(rel)); });
    },
    mkdir: (rel) => wrap(() => mkdirs(rel)),
    async delete(rel) {
      if (!segments(rel).length) throw new StorageError(403, 'the storage root cannot be deleted');
      const e = await stat(rel);
      await wrap(async () => { if (e.type === 'dir') await c.send('RMD ' + abs(rel)); else await c.remove(abs(rel)); }); // RMD: never recursive
    },
    async rename(from, to) {
      if (await stat(to).then(() => true, () => false)) throw new StorageError(409, 'already exists');
      await wrap(async () => { await mkdirs(posix.dirname(abs(to))); await c.rename(abs(from), abs(to)); });
    },
    close: async () => c.close(),
  };
}

export const ftpProvider: StorageProvider = {
  kind: 'ftp', label: 'FTP / FTPS',
  fields: [
    { name: 'host', label: 'Host', type: 'text', required: true },
    { name: 'port', label: 'Port', type: 'number', hint: '21' },
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'password', label: 'Password', type: 'secret', required: true },
    { name: 'security', label: 'Encryption', type: 'select', required: true, options: [{ value: 'ftps', label: 'FTPS (explicit TLS)' }, { value: 'plain', label: 'None (only if the admin allows it)' }] },
  ],
  async connect(c, s) {
    const host = String(c.host ?? '').trim(), username = String(c.username ?? '').trim();
    if (!host || !username) throw new StorageError(400, 'host and username are required');
    const secure = (c.security ?? 'ftps') !== 'plain';
    const port = c.port === undefined || c.port === '' || c.port === null ? 21 : Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StorageError(400, 'port: not a valid port');
    await assertPublicTarget(host);
    return ftpConnect({ host, port, username, password: s.password ?? '', secure });
  },
};
