import { Cable, ChevronRight, Copy, Download, File as FileIcon, Folder, FolderOpen, FolderPlus, HardDrive, Pencil, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { trpc } from '@/lib/trpc';
import { bytes, upload } from './api';
import { MenuArea, menuRef } from './AppMenu';
import Shell, { navRow } from './Shell';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { QuotaBar, Table } from './data';
import { ConfirmDialog } from './dialogs';
import { toast } from './toast';
import { Chip, Empty, Err, Input, Page } from './ui';

interface AddonRef { id: string; name: string; kind: 'webdav' | 'mcp'; visibility: 'private' | 'team' }
interface Entry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: string; addon?: AddonRef }
const SOURCE = { webdav: 'WebDAV', mcp: 'MCP storage' };
interface Quota { used: number; quota: number }

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const q = encodeURIComponent;
const hashDir = () => decodeURIComponent(location.hash.slice(1));

// Folder tree for the context pane: children load when a folder opens.
function Tree({ dir, go, version }: { dir: string; go: (d: string) => void; version: number }) {
  const [kids, setKids] = useState<Record<string, Entry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set(['']));
  const load = (p: string) => trpc.files.list.query({ path: p }).then((r) => setKids((k) => ({ ...k, [p]: r.entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name)) })), () => {});
  useEffect(() => { open.forEach(load); }, [version]);
  useEffect(() => { // keep the current folder's ancestors open
    const parts = dir ? dir.split('/') : [];
    const need = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))].filter((p) => !open.has(p));
    if (need.length) { setOpen(new Set([...open, ...need])); need.forEach(load); }
  }, [dir]);
  const toggle = (p: string) => { const n = new Set(open); if (n.has(p)) n.delete(p); else { n.add(p); load(p); } setOpen(n); };
  const Node = ({ path, name, depth, addon }: { path: string; name: string; depth: number; addon?: boolean }) => (
    <li>
      <div className={`${navRow(dir === path)} gap-1 py-0`} style={{ paddingLeft: `${depth * 14 + 6}px` }}>
        <button type="button" aria-expanded={open.has(path)} aria-label={`${open.has(path) ? 'Collapse' : 'Expand'} ${name}`} className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10" onClick={() => toggle(path)}>
          <ChevronRight size={14} aria-hidden className={`transition-transform ${open.has(path) ? 'rotate-90' : ''}`} /></button>
        <button type="button" aria-current={dir === path ? 'page' : undefined} className="flex min-w-0 grow items-center gap-2 py-1 text-left" onClick={() => go(path)}>
          {addon ? <Cable size={15} aria-hidden className="shrink-0 text-seal" /> : depth ? <Folder size={15} aria-hidden className="shrink-0" /> : <HardDrive size={15} aria-hidden className="shrink-0" />}<span className="truncate">{name}</span></button>
      </div>
      {open.has(path) && !!kids[path]?.length && <ul>{kids[path].map((k) => <Node key={k.name} path={join(path, k.name)} name={k.name} depth={depth + 1} addon={!!k.addon} />)}</ul>}
    </li>
  );
  return <nav aria-label="Folders"><ul><Node path="" name="My files" depth={0} /></ul></nav>;
}

export default function Files() {
  const [dir, setDir] = useState(hashDir()); // relative to /files, kept in the URL hash
  const [entries, setEntries] = useState<Entry[]>();
  const [addon, setAddon] = useState<AddonRef>(); // set while the current folder is inside a storage add-on
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
    trpc.files.list.query({ path: dir }).then((r) => { setAddon(r.addon ?? undefined); setEntries(r.entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))); setErr(''); })
      .catch((e) => { setEntries([]); if (!e.data || e.data.httpStatus === 503) setStarting(true); else setErr(e.message); }); // starting = no server answer (proxy 504, network) or 503 (sandbox starting)
    trpc.files.usage.query().then(setQuota).catch(() => {});
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

  const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;
  /** Right-click on a row: the actions of its buttons, plus Open and Copy path. */
  const rowItems = (en: Entry) => (<>
    {en.type === 'dir' && <DropdownMenuItem className="text-[13px]" onClick={() => go(join(dir, en.name))}><FolderOpen {...ico} />Open</DropdownMenuItem>}
    {en.type === 'file' && <DropdownMenuItem className="text-[13px]" onClick={() => { location.href = `/api/files/download?path=${q(join(dir, en.name))}`; }}><Download {...ico} />Download</DropdownMenuItem>}
    <DropdownMenuItem className="text-[13px]" onClick={() => navigator.clipboard.writeText(`/files/${join(dir, en.name)}`).then(() => toast('Path copied'), () => toast('Copy failed', true))}><Copy {...ico} />Copy path</DropdownMenuItem>
    {!en.addon && <><DropdownMenuItem className="text-[13px]" onClick={() => setRename(en.name)}><Pencil {...ico} />Rename</DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" className="text-[13px]" onClick={() => setDel(en)}><Trash2 {...ico} />Delete</DropdownMenuItem></>}
  </>);
  const crumbs = dir ? dir.split('/') : [];
  const tree = (
    <aside aria-label="Folders" className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border p-2 max-[799px]:hidden">
      <Tree dir={dir} go={go} version={version} />
      {quota && <div className="mt-auto grid gap-1.5 px-2.5 pt-4"><QuotaBar {...quota} /><span className="tnum text-xs text-muted-foreground">{bytes(quota.used)} of {bytes(quota.quota)} used</span></div>}
    </aside>
  );

  return (
    <Shell title="Files">
      {() => (
        <div className="flex min-h-0 grow">{tree}<div className="relative min-w-0 grow overflow-y-auto" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
          onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); send([...e.dataTransfer.files]); }}>
          <MenuArea items={() => <><DropdownMenuItem className="text-[13px]" onClick={() => setMk(true)}><FolderPlus {...ico} />New folder</DropdownMenuItem>
            <DropdownMenuItem className="text-[13px]" onClick={() => pick.current?.click()}><Upload {...ico} />Upload</DropdownMenuItem></>}>
          <Page title={crumbs.at(-1) ?? 'My files'} hint={addon ? `Stored on ${addon.name} (${SOURCE[addon.kind]}), not in hefyn, and not counted against your storage. Agents see it as /files/${addon.name}.` : 'Your saved files. Agents see this folder as /files and can read and write here. Connected storage shows up as folders; add it in Connectors.'}
            actions={<div className="flex gap-2">
              <Button variant="outline" onClick={() => setMk(true)}><FolderPlus size={16} aria-hidden />New folder</Button>
              <Button onClick={() => pick.current?.click()}><Upload size={16} aria-hidden />Upload</Button>
              <input ref={pick} type="file" multiple className="sr-only" aria-label="Upload files" tabIndex={-1} onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </div>}>
            {crumbs.length > 0 && <nav aria-label="Path" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
              <button className="rounded px-1.5 py-0.5 text-foreground hover:bg-foreground/5" onClick={() => go('')}>My files</button>
              {crumbs.map((c, i) => <span key={i} className="flex items-center gap-1"><ChevronRight size={14} aria-hidden className="text-muted-foreground" />
                <button className="rounded px-1.5 py-0.5 hover:bg-foreground/5" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
            </nav>}
            <Err>{err}</Err>
            {starting && <div role="status" className="flex items-center gap-3 rounded-xl bg-foreground/[0.06] px-4 py-3 text-sm"><Spinner className="size-4 text-foreground" aria-hidden /><span className="grow">Starting your workspace. This can take a few seconds.</span><Button variant="outline" onClick={load}>Try again</Button></div>}
            {progress !== undefined && <div role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress * 100)} className="mb-3 h-1.5 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${progress * 100}%` }} /></div>}
            {mk && (
              <form className="mb-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); setMk(false); name && run(() => trpc.files.mkdir.mutate({ path: join(dir, name) }), 'Folder created'); }}>
                <Input name="name" aria-label="Folder name" placeholder="Folder name" required autoFocus className="max-w-xs" onKeyDown={(e) => e.key === 'Escape' && setMk(false)} />
                <Button type="submit">Create</Button><Button type="button" variant="outline" onClick={() => setMk(false)}>Cancel</Button>
              </form>
            )}
            {entries && !entries.length && !err && !starting ? <Empty icon={<Folder size={28} />}>This folder is empty. Drop files here or choose Upload.</Empty> : entries?.length ? (
              <Table head={['Name', 'Size', 'Modified', '']} num={[1]}>
                {entries.map((en) => (
                  <tr key={en.name} ref={menuRef(() => rowItems(en))} className="hover:bg-foreground/[0.03]">
                    <td className="font-medium">{rename === en.name
                      ? <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const to = String(new FormData(e.currentTarget).get('name')).trim(); setRename(undefined); to && to !== en.name && run(() => trpc.files.rename.mutate({ from: join(dir, en.name), to: join(dir, to) }), 'Renamed'); }}>
                        <Input name="name" aria-label={`New name for ${en.name}`} defaultValue={en.name} required autoFocus className="max-w-xs py-1" onKeyDown={(e) => e.key === 'Escape' && setRename(undefined)} />
                        <Button type="submit">Save</Button></form>
                      : en.type === 'dir'
                        ? <button className="inline-flex items-center gap-2 hover:underline" onClick={() => go(join(dir, en.name))}>{en.addon ? <Cable size={16} aria-hidden className="text-seal" /> : <Folder size={16} aria-hidden className="text-foreground" />}{en.name}{en.addon && <Chip tone="seal">{SOURCE[en.addon.kind]}</Chip>}</button>
                        : <span className="inline-flex items-center gap-2"><FileIcon size={16} aria-hidden className="text-muted-foreground" />{en.name}</span>}</td>
                    <td className="tnum text-right text-muted-foreground">{en.type === 'file' ? bytes(en.size) : ''}</td>
                    <td className="tnum whitespace-nowrap text-muted-foreground">{en.mtime && !en.addon ? new Date(en.mtime).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</td>
                    <td className="w-1 whitespace-nowrap"><div className="flex justify-end gap-0.5">
                      {en.type === 'file' && <Button variant="ghost" size="icon" className="text-muted-foreground" nativeButton={false} render={<a href={`/api/files/download?path=${q(join(dir, en.name))}`} />} aria-label={`Download ${en.name}`} title="Download"><Download size={15} /></Button>}
                      {!en.addon && <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Rename ${en.name}`} title="Rename" onClick={() => setRename(en.name)}><Pencil size={15} /></Button>}
                      {!en.addon && <Button variant="ghost" size="icon" className="text-muted-foreground hover:bg-danger/10 hover:text-danger-ink" aria-label={`Delete ${en.name}`} title="Delete" onClick={() => setDel(en)}><Trash2 size={15} /></Button>}</div></td>
                  </tr>
                ))}
              </Table>
            ) : null}
          </Page></MenuArea>
          {drag && <div className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground bg-foreground/[0.06] text-sm font-medium text-foreground">Drop to upload to {crumbs.at(-1) ?? 'My files'}</div>}
          {del && <ConfirmDialog title={`Delete ${del.name}?`} body={del.type === 'dir' ? 'The folder and everything in it will be deleted.' : 'This cannot be undone.'} action="Delete" onClose={() => setDel(undefined)}
            onConfirm={() => run(() => trpc.files.delete.mutate({ path: join(dir, del.name) }), 'Deleted')} />}
        </div></div>
      )}
    </Shell>
  );
}
