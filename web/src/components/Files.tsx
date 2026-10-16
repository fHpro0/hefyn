import { ChevronRight, Download, File as FileIcon, Folder, FolderPlus, HardDrive, Loader2, Pencil, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, bytes, upload } from './api';
import Shell, { navRow } from './Shell';
import { buttonGhost, buttonPrimary, ConfirmDialog, Empty, Err, Input, Page, QuotaBar, Table, toast } from './ui';

interface Entry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: string }
interface Quota { used: number; quota: number }

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const q = encodeURIComponent;
const hashDir = () => decodeURIComponent(location.hash.slice(1));

// Folder tree for the context pane: children load when a folder opens.
function Tree({ dir, go, version }: { dir: string; go: (d: string) => void; version: number }) {
  const [kids, setKids] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set(['']));
  const load = (p: string) => api<{ entries: Entry[] }>(`/api/files?path=${q(p)}`).then((r) => setKids((k) => ({ ...k, [p]: r.entries.filter((e) => e.type === 'dir').map((e) => e.name).sort((a, b) => a.localeCompare(b)) })), () => {});
  useEffect(() => { open.forEach(load); }, [version]);
  useEffect(() => { // keep the current folder's ancestors open
    const parts = dir ? dir.split('/') : [];
    const need = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))].filter((p) => !open.has(p));
    if (need.length) { setOpen(new Set([...open, ...need])); need.forEach(load); }
  }, [dir]);
  const toggle = (p: string) => { const n = new Set(open); if (n.has(p)) n.delete(p); else { n.add(p); load(p); } setOpen(n); };
  const Node = ({ path, name, depth }: { path: string; name: string; depth: number }) => (
    <li>
      <div className={`${navRow(dir === path)} gap-1 py-0`} style={{ paddingLeft: `${depth * 14 + 6}px` }}>
        <button type="button" aria-expanded={open.has(path)} aria-label={`${open.has(path) ? 'Collapse' : 'Expand'} ${name}`} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-foreground/10" onClick={() => toggle(path)}>
          <ChevronRight size={14} aria-hidden className={`transition-transform ${open.has(path) ? 'rotate-90' : ''}`} /></button>
        <button type="button" aria-current={dir === path ? 'page' : undefined} className="flex min-w-0 grow items-center gap-2 py-1 text-left" onClick={() => go(path)}>
          {depth ? <Folder size={15} aria-hidden className="shrink-0" /> : <HardDrive size={15} aria-hidden className="shrink-0" />}<span className="truncate">{name}</span></button>
      </div>
      {open.has(path) && !!kids[path]?.length && <ul>{kids[path].map((k) => <Node key={k} path={join(path, k)} name={k} depth={depth + 1} />)}</ul>}
    </li>
  );
  return <nav aria-label="Folders"><ul><Node path="" name="My files" depth={0} /></ul></nav>;
}

export default function Files() {
  const [dir, setDir] = useState(hashDir()); // relative to /files, kept in the URL hash
  const [entries, setEntries] = useState<Entry[]>();
  const [quota, setQuota] = useState<Quota>();
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(false); // 503 / timeout: the user's workspace container may still be booting
  const [progress, setProgress] = useState<number>();
  const [drag, setDrag] = useState(false);
  const [mk, setMk] = useState(false);
  const [rename, setRename] = useState<string>();
  const [del, setDel] = useState<Entry>();
  const [version, setVersion] = useState(0);
  const pick = useRef<HTMLInputElement>(null);

  const load = () => {
    setStarting(false);
    setVersion((v) => v + 1);
    api<{ entries: Entry[] }>(`/api/files?path=${q(dir)}`).then((r) => { setEntries(r.entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))); setErr(''); })
      .catch((e) => { setEntries([]); if (e.status === 503 || e.status === 504 || e.status === 408 || e instanceof TypeError) setStarting(true); else setErr(e.message); });
    api<Quota>('/api/files/usage').then(setQuota).catch(() => {});
  };
  useEffect(load, [dir]);
  useEffect(() => { const f = () => setDir(hashDir()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const go = (d: string) => (location.hash = q(d).replace(/%2F/g, '/'));
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } load(); };

  async function send(list: File[]) {
    if (!list.length) return;
    setProgress(0); setErr('');
    try { await upload(`/api/files/upload?dir=${q(dir)}`, list, setProgress); toast(list.length === 1 ? 'File uploaded' : `${list.length} files uploaded`); }
    catch (x) { setErr((x as Error).message); toast('Upload failed', true); }
    setProgress(undefined); load();
  }

  const crumbs = dir ? dir.split('/') : [];
  const tree = (
    <aside aria-label="Folders" className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border p-2 max-[799px]:hidden">
      <Tree dir={dir} go={go} version={version} />
      {quota && <div className="mt-auto grid gap-1.5 px-2.5 pt-4"><QuotaBar {...quota} /><span className="tnum text-xs text-muted">{bytes(quota.used)} of {bytes(quota.quota)} used</span></div>}
    </aside>
  );

  return (
    <Shell title="Files">
      {() => (
        <div className="flex min-h-0 grow">{tree}<div className="relative min-w-0 grow overflow-y-auto" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
          onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); send([...e.dataTransfer.files]); }}>
          <Page title={crumbs.at(-1) ?? 'My files'} hint="Your saved files. Agents see this folder as /files and can read and write here."
            actions={<div className="flex gap-2">
              <button className={buttonGhost} onClick={() => setMk(true)}><FolderPlus size={16} aria-hidden />New folder</button>
              <button className={buttonPrimary} onClick={() => pick.current?.click()}><Upload size={16} aria-hidden />Upload</button>
              <input ref={pick} type="file" multiple className="sr-only" aria-label="Upload files" tabIndex={-1} onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </div>}>
            {crumbs.length > 0 && <nav aria-label="Path" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
              <button className="rounded px-1.5 py-0.5 text-foreground hover:bg-foreground/5" onClick={() => go('')}>My files</button>
              {crumbs.map((c, i) => <span key={i} className="flex items-center gap-1"><ChevronRight size={14} aria-hidden className="text-muted" />
                <button className="rounded px-1.5 py-0.5 hover:bg-foreground/5" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
            </nav>}
            <Err>{err}</Err>
            {starting && <div role="status" className="flex items-center gap-3 rounded-xl bg-foreground/[0.06] px-4 py-3 text-sm"><Loader2 size={16} className="animate-spin text-foreground" aria-hidden /><span className="grow">Starting your workspace. This can take a few seconds.</span><button className={buttonGhost} onClick={load}>Try again</button></div>}
            {progress !== undefined && <div role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress * 100)} className="mb-3 h-1.5 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${progress * 100}%` }} /></div>}
            {mk && (
              <form className="mb-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); setMk(false); name && run(() => api('/api/files/mkdir', 'POST', { path: join(dir, name) }), 'Folder created'); }}>
                <Input name="name" aria-label="Folder name" placeholder="Folder name" required autoFocus className="max-w-xs" onKeyDown={(e) => e.key === 'Escape' && setMk(false)} />
                <button className={buttonPrimary}>Create</button><button type="button" className={buttonGhost} onClick={() => setMk(false)}>Cancel</button>
              </form>
            )}
            {entries && !entries.length && !err && !starting ? <Empty icon={<Folder size={28} />}>This folder is empty. Drop files here or choose Upload.</Empty> : entries?.length ? (
              <Table head={['Name', 'Size', 'Modified', '']} num={[1]}>
                {entries.map((en) => (
                  <tr key={en.name} className="hover:bg-foreground/[0.03]">
                    <td className="font-medium">{rename === en.name
                      ? <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const to = String(new FormData(e.currentTarget).get('name')).trim(); setRename(undefined); to && to !== en.name && run(() => api('/api/files/rename', 'POST', { from: join(dir, en.name), to: join(dir, to) }), 'Renamed'); }}>
                        <Input name="name" aria-label={`New name for ${en.name}`} defaultValue={en.name} required autoFocus className="max-w-xs py-1" onKeyDown={(e) => e.key === 'Escape' && setRename(undefined)} />
                        <button className={buttonPrimary}>Save</button></form>
                      : en.type === 'dir'
                        ? <button className="inline-flex items-center gap-2 hover:underline" onClick={() => go(join(dir, en.name))}><Folder size={16} aria-hidden className="text-foreground" />{en.name}</button>
                        : <span className="inline-flex items-center gap-2"><FileIcon size={16} aria-hidden className="text-muted" />{en.name}</span>}</td>
                    <td className="tnum text-right text-muted">{en.type === 'file' ? bytes(en.size) : ''}</td>
                    <td className="tnum whitespace-nowrap text-muted">{new Date(en.mtime).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td className="w-1 whitespace-nowrap"><div className="flex justify-end gap-0.5">
                      {en.type === 'file' && <a className="grid size-9 place-items-center rounded-lg text-muted hover:bg-foreground/5 hover:text-foreground" aria-label={`Download ${en.name}`} title="Download" href={`/api/files/download?path=${q(join(dir, en.name))}`}><Download size={15} /></a>}
                      <button className="grid size-9 place-items-center rounded-lg text-muted hover:bg-foreground/5 hover:text-foreground" aria-label={`Rename ${en.name}`} title="Rename" onClick={() => setRename(en.name)}><Pencil size={15} /></button>
                      <button className="grid size-9 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger-ink" aria-label={`Delete ${en.name}`} title="Delete" onClick={() => setDel(en)}><Trash2 size={15} /></button></div></td>
                  </tr>
                ))}
              </Table>
            ) : null}
          </Page>
          {drag && <div className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground bg-foreground/[0.06] text-sm font-medium text-foreground">Drop to upload to {crumbs.at(-1) ?? 'My files'}</div>}
          {del && <ConfirmDialog title={`Delete ${del.name}?`} body={del.type === 'dir' ? 'The folder and everything in it will be deleted.' : 'This cannot be undone.'} action="Delete" onClose={() => setDel(undefined)}
            onConfirm={() => run(() => api(`/api/files?path=${q(join(dir, del.name))}`, 'DELETE'), 'Deleted')} />}
        </div></div>
      )}
    </Shell>
  );
}
