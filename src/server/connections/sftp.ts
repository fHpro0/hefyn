import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { Client, type SFTPWrapper } from 'ssh2';
import { StorageError, maxUploadBytes } from '../storage.ts';
import { assertPublicTarget, limited, msg, segments, tooBig, type Adapter, type ConnectCtx, type RemoteEntry, type StorageProvider } from './types.ts';

// SFTP over ssh2 (MIT). Host key pinning (TOFU): the first successful connect records the key's SHA-256 fingerprint with the connection, a changed key is refused afterwards.
// Paths are absolute on the server (`/` + the path below the connection's remote folder). One SSH session per sync run (`close()`), operations time out after 60 s.
export const fingerprint = (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
const STATUS: Record<number, number> = { 2: 404, 3: 403, 4: 502 };

export interface SftpOpts { host: string; port?: number; username: string; password?: string; privateKey?: string; passphrase?: string }

export async function sftpConnect(o: SftpOpts, ctx: Pick<ConnectCtx, 'hostKey' | 'pin'>): Promise<Adapter> {
  const client = new Client();
  let seen = '';
  const sftp = await new Promise<SFTPWrapper>((ok, no) => {
    client.on('error', (e) => no(seen && ctx.hostKey && seen !== ctx.hostKey ? new StorageError(409, `the server's host key changed (was ${ctx.hostKey}, now ${seen}); refused. Remove and re-add the connection if the change is expected.`) : new StorageError(502, `SFTP connection failed: ${msg(e)}`)));
    client.on('ready', () => client.sftp((e, s) => (e ? no(new StorageError(502, `SFTP failed: ${msg(e)}`)) : ok(s))));
    client.connect({
      host: o.host, port: o.port || 22, username: o.username, password: o.password, privateKey: o.privateKey, passphrase: o.passphrase,
      readyTimeout: 20_000, keepaliveInterval: 15_000, tryKeyboard: false,
      hostVerifier: (key: Buffer) => { seen = fingerprint(key); return !ctx.hostKey || ctx.hostKey === seen; },
    });
  });
  ctx.pin(seen);

  const call = <T>(f: (cb: (e: any, v?: T) => void) => void): Promise<T> => new Promise((ok, no) => {
    const t = setTimeout(() => no(new StorageError(502, 'the SFTP server did not answer in time')), 60_000);
    f((e, v) => { clearTimeout(t); e ? no(new StorageError(STATUS[e.code] ?? 502, e.code === 2 ? 'not found' : `SFTP: ${msg(e)}`)) : ok(v as T); });
  });
  const abs = (rel: string) => '/' + segments(rel).join('/');
  const entry = (name: string, a: { size: number; mtime: number; mode: number }): RemoteEntry =>
    ({ name, type: (a.mode & 0o170000) === 0o040000 ? 'dir' : 'file', size: a.size, mtime: a.mtime ? new Date(a.mtime * 1000).toISOString() : '' });
  async function mkdirs(rel: string) {
    let p = '';
    for (const s of segments(rel)) {
      p += '/' + s;
      const st = await call<any>((cb) => sftp.stat(p, cb)).catch(() => undefined);
      if (!st) await call((cb) => sftp.mkdir(p, cb));
      else if ((st.mode & 0o170000) !== 0o040000) throw new StorageError(409, `${p} is a file`);
    }
  }
  const stat = async (rel: string) => entry(segments(rel).at(-1) ?? '', await call<any>((cb) => sftp.stat(abs(rel), cb)));

  return {
    caps: async () => ({ write: true, mkdir: true, rename: true, delete: true, etag: false }),
    async list(rel) {
      const l = await call<any[]>((cb) => sftp.readdir(abs(rel), cb));
      // symlinks (mode 0o120000) are skipped: the engine never follows them
      return l.filter((x) => x.filename !== '.' && x.filename !== '..' && (x.attrs.mode & 0o170000) !== 0o120000).map((x) => entry(x.filename, x.attrs));
    },
    stat,
    async read(rel) {
      const e = await stat(rel);
      if (e.type !== 'file') throw new StorageError(400, 'is a directory');
      if (e.size > maxUploadBytes()) throw tooBig();
      return limited(Readable.toWeb(sftp.createReadStream(abs(rel))) as ReadableStream<Uint8Array>, maxUploadBytes());
    },
    async write(rel, data) {
      if (data.byteLength > maxUploadBytes()) throw tooBig();
      await mkdirs(posix.dirname('/' + segments(rel).join('/')));
      await call((cb) => sftp.writeFile(abs(rel), Buffer.from(data), cb));
    },
    mkdir: mkdirs,
    async delete(rel) {
      if (!segments(rel).length) throw new StorageError(403, 'the storage root cannot be deleted');
      const e = await stat(rel);
      await call((cb) => (e.type === 'dir' ? sftp.rmdir(abs(rel), cb) : sftp.unlink(abs(rel), cb)));
    },
    async rename(from, to) {
      if (await stat(to).then(() => true, () => false)) throw new StorageError(409, 'already exists');
      await mkdirs(posix.dirname('/' + segments(to).join('/')));
      await call((cb) => sftp.rename(abs(from), abs(to), cb));
    },
    close: async () => void client.end(),
  };
}

export const sftpProvider: StorageProvider = {
  kind: 'sftp', label: 'SFTP (SSH)',
  fields: [
    { name: 'host', label: 'Host', type: 'text', required: true },
    { name: 'port', label: 'Port', type: 'number', hint: '22' },
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'password', label: 'Password', type: 'secret', hint: 'Password or private key' },
    { name: 'privateKey', label: 'Private key', type: 'secret', hint: 'OpenSSH or PEM text' },
    { name: 'passphrase', label: 'Key passphrase', type: 'secret' },
  ],
  async connect(c, s, ctx) {
    const host = String(c.host ?? '').trim(), username = String(c.username ?? '').trim();
    if (!host || !username) throw new StorageError(400, 'host and username are required');
    if (!s.password && !s.privateKey) throw new StorageError(400, 'enter a password or a private key');
    const port = c.port === undefined || c.port === '' || c.port === null ? 22 : Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StorageError(400, 'port: not a valid port');
    await assertPublicTarget(host);
    return sftpConnect({ host, port, username, password: s.password || undefined, privateKey: s.privateKey || undefined, passphrase: s.passphrase || undefined }, ctx);
  },
};
