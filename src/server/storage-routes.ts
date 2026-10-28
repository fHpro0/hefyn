import { Hono, type Context } from 'hono';
import { posix } from 'node:path';
import { activityOf } from './activity.ts';
import { db } from './appdb.ts';
import { type Env, requirePermission } from './guard.ts';
import { fsFor } from './runner.ts';
import { StorageError, cleanPath, maxUploadBytes, quotaBytes, usage, userFs } from './storage.ts';
import { userOfConversation } from './usage.ts';
import { openForUser } from './vault.ts';

// The user's private /files folder for the browser (mounted at /api/files by the files module). Only /files is exposed: /tmp is agent-only.
// Same permission as the agent sandbox that mounts the folder; the owner is always the signed-in user, never a request parameter.
export const fileRoutes = new Hono<Env>();
fileRoutes.use('*', requirePermission('sandbox.shell'));

const files = (p = '') => '/files/' + p.replace(/^\/+/, '');
const handle = (f: (c: Context<Env>, userId: string) => Promise<Response>) => async (c: Context<Env>) => {
  try { return await f(c, c.var.me.id); } catch (e) {
    if (e instanceof StorageError) return c.json({ error: e.status === 502 ? 'Your workspace is starting. Try again in a few seconds.' : e.message }, (e.status === 502 ? 503 : e.status) as 400); // runner down / container booting
    throw e;
  }
};
const body = async (c: Context) => { try { return (await c.req.json()) ?? {}; } catch { throw new StorageError(400, 'invalid JSON body'); } };
const str = (v: unknown, name: string) => { if (typeof v !== 'string') throw new StorageError(400, `${name} must be a string`); return v; };

fileRoutes.get('/usage', handle(async (c, u) => c.json(await usage(u))));

fileRoutes.get('/', handle(async (c, u) => {
  const path = files(c.req.query('path'));
  return c.json({ path, entries: await fsFor(u).list(path) });
}));

fileRoutes.get('/download', handle(async (c, u) => download(fsFor(u), files(c.req.query('path')))));

// Details for the viewer: the same numbers as the list row, exact, plus the birth time where the filesystem has one.
fileRoutes.get('/stat', handle(async (c, u) => c.json(await statOf(fsFor(u), files(c.req.query('path'))))));
async function statOf(fs: ReturnType<typeof fsFor>, path: string) {
  const s = await fs.stat(path);
  return { path, type: s.isDirectory ? 'dir' : 'file', size: s.size ?? 0, mtime: s.mtime?.toISOString() ?? null, created: s.birthtime?.toISOString() ?? null };
}

async function download(fs: ReturnType<typeof fsFor>, path: string) {
  const st = await fs.stat(path);
  if (!st.isFile) throw new StorageError(400, 'not a file');
  const name = posix.basename(path);
  // Never rendered inline: forced download, opaque type, no sniffing, sandboxed CSP (an uploaded HTML/SVG must not run on our origin).
  return new Response(await fs.readStream(path, st.size ?? 0), { headers: {
    'content-length': String(st.size ?? 0),
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
  } });
}

// ---- chat scratch: each chat's /tmp (<data>/users/<id>/tmp/<chat>), read-only here, with clear and cleanup ----
// Read through the confined host fs (userFs) even in container mode: listing every chat through fsFor would boot a sandbox per chat.
// The agent config dirs hefyn writes there (see src/modules/agents/*.json `config.dir`; .claude/projects also holds the transcripts) are hidden and survive a clear.
const MANAGED = new Set(['.claude', '.codex', '.config', '.pi']);
const scratchPath = (p = '') => {
  const rel = cleanPath(p).replace(/^\/+/, '');
  if (MANAGED.has(rel.split('/')[0])) throw new StorageError(404, 'not found');
  return '/tmp/' + rel;
};
function scratchFs(c: Context<Env>) {
  const conv = c.req.param('conv') ?? '';
  if (userOfConversation(conv) !== c.var.me.id) throw new StorageError(404, 'not found'); // never reveals whether another user's chat exists
  return { conv, fs: userFs({ userId: c.var.me.id, conversationId: conv }) };
}
type Fs = ReturnType<typeof userFs>;
async function scratchStats(fs: Fs) { // bytes/files/newest mtime of everything visible, capped so a huge tree cannot stall the request
  let bytes = 0, count = 0, last = 0, budget = 20_000;
  const walk = async (dir: string) => {
    for (const e of await fs.list(dir).catch(() => [])) {
      if (dir === '/tmp' && MANAGED.has(e.name) || budget-- <= 0) continue;
      last = Math.max(last, Date.parse(e.mtime) || 0);
      if (e.type === 'dir') await walk(`${dir}/${e.name}`); else { bytes += e.size; count++; }
    }
  };
  await walk('/tmp');
  return { bytes, files: count, lastModified: last ? new Date(last).toISOString() : null };
}
async function clearScratch(fs: Fs) {
  const before = (await scratchStats(fs)).bytes;
  for (const e of await fs.list('/tmp').catch(() => [])) if (!MANAGED.has(e.name)) await fs.rm(`/tmp/${e.name}`, { recursive: true, force: true });
  return before;
}
const owned = (u: string) => (db.prepare('SELECT id, title FROM conversations WHERE user_id = ?').all(u) as { id: string; title: string }[]).filter((r) => userOfConversation(r.id) === u);
async function scratchChats(u: string) {
  const running = activityOf(u);
  const out = [];
  for (const r of owned(u)) {
    const s = await scratchStats(userFs({ userId: u, conversationId: r.id }));
    if (s.files) out.push({ conversationId: r.id, title: openForUser(u, r.title, `conv:${r.id}:title`), ...s, running: r.id in running });
  }
  return out.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
}

fileRoutes.get('/scratch', handle(async (c, u) => c.json({ chats: await scratchChats(u) })));
fileRoutes.get('/scratch/:conv/list', handle(async (c, u) => {
  const { fs } = scratchFs(c), path = scratchPath(c.req.query('path'));
  const entries = (await fs.list(path)).filter((e) => path !== '/tmp/' && path !== '/tmp' || !MANAGED.has(e.name));
  return c.json({ path, entries });
}));
fileRoutes.get('/scratch/:conv/stat', handle(async (c) => { const { fs } = scratchFs(c); return c.json(await statOf(fs, scratchPath(c.req.query('path')))); }));
fileRoutes.get('/scratch/:conv/download', handle(async (c) => { const { fs } = scratchFs(c); return download(fs, scratchPath(c.req.query('path'))); }));
fileRoutes.delete('/scratch/:conv', handle(async (c, u) => {
  const { conv, fs } = scratchFs(c);
  if (conv in activityOf(u)) throw new StorageError(409, 'This chat is running. Clear its scratch files once it has finished.');
  return c.json({ freed: await clearScratch(fs) });
}));
fileRoutes.post('/scratch/cleanup', handle(async (c, u) => {
  const days = Number((await body(c)).olderThanDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new StorageError(400, 'olderThanDays must be 1 to 3650');
  const cutoff = Date.now() - days * 86_400_000, running = activityOf(u);
  let freed = 0, chats = 0;
  for (const r of await scratchChats(u)) {
    if (r.running || r.conversationId in running || !r.lastModified || Date.parse(r.lastModified) >= cutoff) continue;
    freed += await clearScratch(userFs({ userId: u, conversationId: r.conversationId })); chats++;
  }
  return c.json({ freed, chats });
}));

// Multipart upload into ?dir=; the quota is checked up front and again per file by the fs layer.
fileRoutes.post('/upload', handle(async (c, u) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 0 && (await usage(u)).used + len > quotaBytes() + 64 * 1024) throw new StorageError(413, 'storage quota exceeded'); // cheap reject before the body is parsed
  const form = await c.req.formData().catch(() => { throw new StorageError(400, 'expected multipart/form-data'); });
  const uploads = [...form.values()].filter((v): v is File => typeof v !== 'string');
  if (!uploads.length) throw new StorageError(400, 'no files');
  const fs = fsFor(u), dir = files(c.req.query('dir'));
  const saved: { name: string; path: string; size: number }[] = [];
  for (const f of uploads) {
    if (f.size > maxUploadBytes()) throw new StorageError(413, `${f.name} exceeds the upload limit of ${maxUploadBytes() / 1048576} MB`);
    const path = await fs.uniqueName(dir, posix.basename(f.name.replace(/\\/g, '/')) || 'upload');
    await fs.writeFile(path, new Uint8Array(await f.arrayBuffer()));
    saved.push({ name: posix.basename(path), path: path.slice('/files'.length), size: f.size });
  }
  return c.json({ saved });
}));

// Save text from the viewer. ?mtime= is what the editor loaded: a newer file (the agent edited it) is a 409; ?new=1 refuses to replace an existing file.
const MAX_EDIT = 5 * 1048576;
fileRoutes.put('/content', handle(async (c, u) => {
  const fs = fsFor(u), path = files(c.req.query('path'));
  if (Number(c.req.header('content-length') ?? 0) > MAX_EDIT) throw new StorageError(413, 'file is over the 5 MB editing limit');
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_EDIT) throw new StorageError(413, 'file is over the 5 MB editing limit');
  const old = await fs.stat(path).catch((e) => { if (e instanceof StorageError && e.status === 404) return null; throw e; });
  if (old && !old.isFile) throw new StorageError(400, 'not a file');
  const seen = c.req.query('mtime');
  // whole seconds: the container reports nothing finer
  if (old && (c.req.query('new') || (seen && Math.floor(+new Date(seen) / 1000) !== Math.floor(+old.mtime! / 1000)))) throw new StorageError(409, c.req.query('new') ? 'a file with that name already exists' : 'the file changed since you opened it');
  if (!old && seen) throw new StorageError(409, 'the file was deleted since you opened it');
  await fs.writeFile(path, text);
  const s = await fs.stat(path);
  return c.json({ size: s.size, mtime: s.mtime!.toISOString() });
}));

fileRoutes.delete('/',handle(async (c, u) => {
  await fsFor(u).rm(files(c.req.query('path')), { recursive: true });
  return c.json({ ok: true });
}));

fileRoutes.post('/mkdir', handle(async (c, u) => {
  await fsFor(u).mkdir(files(str((await body(c)).path, 'path')), { recursive: true });
  return c.json({ ok: true });
}));

fileRoutes.post('/rename', handle(async (c, u) => {
  const b = await body(c);
  await fsFor(u).rename(files(str(b.from, 'from')), files(str(b.to, 'to')));
  return c.json({ ok: true });
}));
