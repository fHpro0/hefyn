import { Hono, type Context } from 'hono';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { fsFor } from './runner.ts';
import { addonAt, isAddonPath } from './storage-addons.ts';
import { StorageError, maxUploadBytes, quotaBytes, usage, userOfConversation } from './storage.ts';

// Mount with e.g. app.route('/api', storageRoutes((c) => c.get('user')?.id)). Only /files is exposed (tmp is agent-only).
export function storageRoutes(getUserId: (c: Context) => string | undefined) {
  const r = new Hono();
  const files = (p = '') => '/files/' + p.replace(/^\/+/, '');
  const handle = (f: (c: Context, userId: string) => Promise<Response>) => async (c: Context) => {
    const userId = getUserId(c);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    try { return await f(c, userId); } catch (e) {
      if (e instanceof StorageError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  };
  const body = async (c: Context) => { try { return (await c.req.json()) ?? {}; } catch { throw new StorageError(400, 'invalid JSON body'); } };
  const str = (v: unknown, name: string) => { if (typeof v !== 'string') throw new StorageError(400, `${name} must be a string`); return v; };

  r.get('/files/usage', handle(async (c, u) => c.json(await usage(u))));

  r.get('/files', handle(async (c, u) => {
    const path = files(c.req.query('path'));
    return c.json({ path, entries: await fsFor(u).list(path), addon: addonAt(u, path) ?? null }); // addon: set inside a storage add-on
  }));

  r.get('/files/download', handle(async (c, u) => {
    const fs = fsFor(u);
    const path = files(c.req.query('path'));
    if (!(await fs.stat(path)).isFile) throw new StorageError(400, 'not a file');
    const name = posix.basename(path);
    // Never rendered inline: forced download, opaque type, no sniffing, sandboxed CSP.
    const remote = await fs.addonStream(path); // storage add-on: streamed from there, size-capped
    const body = remote ?? (fs.hostPath && fs.openRead ? (Readable.toWeb(fs.openRead(await fs.hostPath(path))) as ReadableStream) : new Blob([new Uint8Array(await fs.readFileBuffer(path))]));
    return new Response(body, { headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    } });
  }));

  r.post('/files/upload', handle((c, u) => saveUploads(c, u, fsFor(u), files(c.req.query('dir')), (p) => p.slice('/files'.length))));

  r.delete('/files', handle(async (c, u) => {
    await fsFor(u).rm(files(c.req.query('path')), { recursive: true });
    return c.json({ ok: true });
  }));

  r.post('/files/mkdir', handle(async (c, u) => {
    await fsFor(u).mkdir(files(str((await body(c)).path, 'path')), { recursive: true });
    return c.json({ ok: true });
  }));

  r.post('/files/rename', handle(async (c, u) => {
    const b = await body(c);
    await fsFor(u).rename(files(str(b.from, 'from')), files(str(b.to, 'to')));
    return c.json({ ok: true });
  }));

  // Copy a scratch file the agent produced into persistent files/ (conversation must belong to the user).
  r.post('/files/keep', handle(async (c, u) => {
    const b = await body(c);
    const conversationId = str(b.conversationId, 'conversationId');
    if (userOfConversation(conversationId) !== u) throw new StorageError(403, 'not your conversation');
    const from = '/tmp/' + str(b.path, 'path').replace(/^\/+/, '');
    const src = fsFor(u, conversationId), dst = fsFor(u);
    if (!(await src.stat(from)).isFile) throw new StorageError(400, 'not a file');
    const path = await dst.uniqueName(files(typeof b.dir === 'string' ? b.dir : ''), posix.basename(from));
    await dst.writeFile(path, await src.readFileBuffer(from));
    return c.json({ path: path.slice('/files'.length) });
  }));

  return r;
}

/** Multipart upload into `dir` of `fs`; the quota is checked per file before it is written. `show` maps the stored path for the answer. */
export async function saveUploads(c: Context, userId: string, fs: ReturnType<typeof fsFor>, dir: string, show: (p: string) => string): Promise<Response> {
  try {
    // Cheap early reject before the body is parsed.
    const len = Number(c.req.header('content-length') ?? 0);
    const { used } = await usage(userId);
    if (len > 0 && !isAddonPath(userId, dir) && used + len > quotaBytes() + 64 * 1024) throw new StorageError(413, 'storage quota exceeded'); // add-on storage has no local quota
    const form = await c.req.formData().catch(() => { throw new StorageError(400, 'expected multipart/form-data'); });
    const uploads = [...form.values()].filter((v): v is File => typeof v !== 'string');
    if (!uploads.length) throw new StorageError(400, 'no files');
    const saved: { name: string; path: string; size: number }[] = [];
    for (const f of uploads) {
      if (f.size > maxUploadBytes()) throw new StorageError(413, `${f.name} exceeds the upload limit of ${maxUploadBytes() / 1048576} MB`);
      const name = posix.basename(f.name.replace(/\\/g, '/')) || 'upload';
      const path = await fs.uniqueName(dir, name);
      await fs.writeFile(path, new Uint8Array(await f.arrayBuffer()));
      saved.push({ name: posix.basename(path), path: show(path), size: f.size });
    }
    return c.json({ saved });
  } catch (e) {
    if (e instanceof StorageError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
}
