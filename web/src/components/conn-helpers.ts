// Pure helpers of the Files page's Connections (docs/STORAGE.md): form values -> API input, plain-words status and errors.
export interface ConnField { name: string; label: string; type: 'text' | 'url' | 'number' | 'secret' | 'select'; required?: boolean; hint?: string; options?: { value: string; label: string }[] }
export interface ConnSummary { downloaded: number; uploaded: number; deletedLocal: number; deletedRemote: number; conflicts: number; skipped: number; errors: string[]; capped: string[] }
export interface ConnLike { syncing: boolean; status: string; lastSyncAt: string | null; lastError: string | null }

/** What the cards say, per kind. */
export const KIND_INFO: Record<string, { title: string; blurb: string }> = {
  webdav: { title: 'Nextcloud / WebDAV', blurb: 'Nextcloud, ownCloud or a NAS' },
  sftp: { title: 'SFTP', blurb: 'A server you log into over SSH' },
  ftp: { title: 'FTPS', blurb: 'An older file server or web hosting' },
  mcp: { title: 'MCP server', blurb: 'One of your own MCP servers with file tools' },
};

/** Secret fields go to `secrets`, the rest to `config`; blank values are left out (on edit a blank secret keeps the saved one) and numbers become numbers. */
export function splitForm(fields: ConnField[], values: Record<string, string>) {
  const config: Record<string, string | number> = {}, secrets: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name] ?? '';
    if (v.trim() === '' && !(f.type === 'secret' && v !== '')) continue;
    if (f.type === 'secret') secrets[f.name] = v;
    else config[f.name] = f.type === 'number' ? Number(v) : v;
  }
  return { config, secrets };
}

const n = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** "Downloaded 12 files, uploaded 3, 1 conflict — kept both copies". */
export function summarySentence(s: ConnSummary): string {
  const parts: string[] = [];
  if (s.downloaded) parts.push(`downloaded ${n(s.downloaded, 'file')}`);
  if (s.uploaded) parts.push(`uploaded ${s.downloaded ? s.uploaded : n(s.uploaded, 'file')}`);
  const gone = s.deletedLocal + s.deletedRemote;
  if (gone) parts.push(`removed ${gone}`);
  if (s.conflicts) parts.push(`${n(s.conflicts, 'conflict')} — kept both copies`);
  if (s.skipped) parts.push(`${n(s.skipped, 'file')} skipped`);
  if (s.errors.length) parts.push(`${n(s.errors.length, 'problem')}`);
  const t = parts.join(', ');
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Everything was already up to date';
}

/** Server errors in plain words for non-technical users. */
export function plainError(m: string): string {
  if (/HEFYN_ALLOW_PLAIN_FTP/.test(m)) return 'This server only offers unencrypted FTP. Ask your admin to allow it (HEFYN_ALLOW_PLAIN_FTP).';
  if (/HEFYN_ALLOW_PRIVATE_URLS|private network|private address/i.test(m)) return 'This address is on a private network. Ask your admin to allow it (HEFYN_ALLOW_PRIVATE_URLS).';
  return m.replace(/^Could not connect: /, "Couldn't connect: ");
}

/** "Synced 3 min ago" · "Syncing…" · "Error: <short>" · "Not synced yet". `ago` formats a timestamp. */
export function statusLine(c: ConnLike, ago: (iso: string) => string): string {
  if (c.syncing) return 'Syncing…';
  if (c.status === 'error') return `Error: ${(c.lastError ?? 'sync failed').split('\n')[0]!.slice(0, 80)}`;
  return c.lastSyncAt ? `Synced ${ago(c.lastSyncAt).replace(/^Just now/, 'just now')}` : 'Not synced yet';
}

export const isConflictCopy = (name: string) => / \(conflict [^)]*\)/.test(name);
