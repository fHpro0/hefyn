import { api, upload } from './api';

// Every file operation of the Files page goes through here, addressed by path under the source's root. A future source (FTP, WebDAV) implements the same shape.
export interface Entry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: string }
/** `created` is null where the filesystem keeps no birth time (the sandbox does not). */
export interface Details { path: string; type: 'file' | 'dir'; size: number; mtime: string | null; created: string | null }
export interface Quota{ used: number; quota: number }
/** `prefix`: where this source's folders live in the URL hash; `list`: the list endpoint when it is not `base`; `readOnly`: no upload, edit, rename, delete or move. */
export interface FileSource { id: string; label: string; base: string; prefix?: string; list?: string; readOnly?: boolean }
export const MY_FILES: FileSource = { id: 'files', label: 'My files', base: '/api/files' };
export const scratchSource = (conv: string, title: string): FileSource => ({ id: `scratch:${conv}`, label: title, base: `/api/files/scratch/${conv}`, list: `/api/files/scratch/${conv}/list`, prefix: `scratch/${conv}/`, readOnly: true });

export interface ScratchChat { conversationId: string; title: string; bytes: number; files: number; lastModified: string | null; running: boolean }
export const scratchClient = {
  chats: () => api<{ chats: ScratchChat[] }>('/api/files/scratch').then((r) => r.chats),
  clear: (conv: string) => api<{ freed: number }>(`/api/files/scratch/${conv}`, 'DELETE'),
  cleanup: (olderThanDays: number) => api<{ freed: number; chats: number }>('/api/files/scratch/cleanup', 'POST', { olderThanDays }),
};

const q = encodeURIComponent;
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Relative for the last 7 days ("2 h ago"), else the date. */
export function when(iso: string) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s >= 0 && s < 7 * 86400) return s < 60 ? 'Just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 27, 2026, 11:44:34 AM". */
export const absolute = (iso: string) => new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' });

export class Conflict extends Error {}

export const filesClient = (s: FileSource = MY_FILES) => ({
  list: (path: string) => api<{ entries: Entry[] }>(`${s.list ?? s.base}?path=${q(path)}`).then((r) => r.entries),
  usage: () => api<Quota>(`${s.base}/usage`),
  stat: (path: string) => api<Details>(`${s.base}/stat?path=${q(path)}`),
  url: (path: string) => `${s.base}/download?path=${q(path)}`,
  async read(path: string): Promise<ArrayBuffer> {
    const res = await fetch(this.url(path));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.arrayBuffer();
  },
  /** `mtime` = what you loaded (409 -> Conflict if it changed); `create` refuses to replace an existing file. */
  async write(path: string, text: string, o: { mtime?: string; create?: boolean } = {}) {
    const res = await fetch(`${s.base}/content?path=${q(path)}${o.mtime ? `&mtime=${q(o.mtime)}` : ''}${o.create ? '&new=1' : ''}`, { method: 'PUT', body: text });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && !o.create) throw new Conflict(data.error);
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data as { size: number; mtime: string };
  },
  mkdir: (path: string) => api(`${s.base}/mkdir`, 'POST', { path }),
  rename: (from: string, to: string) => api(`${s.base}/rename`, 'POST', { from, to }),
  remove: (path: string) => api(`${s.base}?path=${q(path)}`, 'DELETE'),
  upload: (dir: string, f: File, onProgress: (frac: number) => void) => upload(`${s.base}/upload?dir=${q(dir)}`, [f], onProgress),
});
export type FilesClient = ReturnType<typeof filesClient>;
