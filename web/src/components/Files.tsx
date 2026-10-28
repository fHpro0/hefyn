import { ArrowDown, ArrowUp, ChevronRight, Cloud, Download, Ellipsis, Eraser, FilePlus, Folder, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Unplug, Upload as UploadIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { bytes } from './api';
import { type Conn, ConnectDialog, KIND_ICON, RemoveDialog, syncNow, testConn } from './Connections';
import { isConflictCopy, statusLine } from './conn-helpers';
import { QuotaBar } from './data';
import { ConfirmDialog, Dialog } from './dialogs';
import FileViewer from './FileViewer';
import { kindOf } from './file-kind';
import { type Entry, type FileSource, type Quota, type ScratchChat, MY_FILES, filesClient, join, scratchClient, scratchSource, when } from './files-client';
import Scratch from './Scratch';
import Shell from './Shell';
import { toast } from './toast';
import { Empty, Err, Input, Loading, Page, Reveal } from './ui';

interface Job { id: number; name: string; frac: number; error?: string }
type SortKey = 'name' | 'kind' | 'size' | 'mtime';

const q = encodeURIComponent;
const hashPath = () => decodeURIComponent(location.hash.slice(1));
const SCRATCH = 'scratch'; // the hash of the Chat scratch root: #scratch, #scratch/<chat>/<folder>
const useHash = () => { const [h, setH] = useState(hashPath()); useEffect(() => { const f = () => setH(hashPath()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []); return h; };
const MOVE = 'application/x-hefyn-move'; // dragging a row of this page onto a folder
const COLS = 'grid-cols-[minmax(0,1fr)_90px_40px] sm:grid-cols-[minmax(0,1fr)_120px_90px_130px_40px]';


// Dropped folders (webkitGetAsEntry): every file with its path relative to the drop.
async function walk(e: FileSystemEntry, prefix = ''): Promise<{ file: File; rel: string }[]> {
  if (e.isFile) return [{ file: await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no)), rel: prefix }];
  const r = (e as FileSystemDirectoryEntry).createReader(), kids: FileSystemEntry[] = [];
  for (;;) { const b = await new Promise<FileSystemEntry[]>((ok, no) => r.readEntries(ok, no)); if (!b.length) break; kids.push(...b); }
  return (await Promise.all(kids.map((k) => walk(k, join(prefix, e.name))))).flat();
}

export default function Files() {
  return <Shell title="Files">{() => <Roots />}</Shell>;
}

// The sources: My files, and each chat's scratch (read-only). The root is a value handed down, so more sources (FTP, WebDAV) slot in here.
function Roots() {
  const h = useHash();
  const m = /^scratch\/([^/]+)/.exec(h);
  const [chats, setChats] = useState<ScratchChat[]>();
  const loadChats = () => scratchClient.chats().then(setChats).catch(() => setChats([]));
  useEffect(() => { if (h === SCRATCH || m) void loadChats(); }, [h === SCRATCH, m?.[1]]);
  const tabs = <SourceTabs scratch={h === SCRATCH || !!m} />;
  if (m) { const c = chats?.find((x) => x.conversationId === m[1]); return <Content key={m[1]} source={scratchSource(m[1], c?.title ?? 'Chat')} top={tabs} />; }
  if (h === SCRATCH) return <Scratch chats={chats} reload={loadChats} top={tabs} />;
  return <Content source={MY_FILES} top={tabs} />;
}

const SourceTabs = ({ scratch }: { scratch: boolean }) => (
  <div role="tablist" aria-label="Where" className="mb-3 flex gap-1 text-sm">
    {[['My files', false, ''], ['Chat scratch', true, SCRATCH]].map(([label, s, hash]) => (
      <button key={String(label)} role="tab" type="button" aria-selected={scratch === s} onClick={() => (location.hash = String(hash))}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-ring ${scratch === s ? 'bg-foreground/[0.07] font-medium' : 'text-muted-foreground hover:bg-foreground/5'}`}>
        {s ? <Eraser size={14} aria-hidden /> : <Folder size={14} aria-hidden />}{String(label)}</button>
    ))}
  </div>
);

function Content({ source, top }: { source: FileSource; top: React.ReactNode }) {
  const fc = useMemo(() => filesClient(source), [source.id]);
  const ro = !!source.readOnly, prefix = source.prefix ?? '';
  const hashDir = () => hashPath().slice(prefix.length);
  const [dir, setDir] = useState(hashDir()); // relative to the source root, kept in the URL hash
  const [entries, setEntries] = useState<Entry[]>();
  const [quota, setQuota] = useState<Quota>();
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(false); // 503: the workspace container may still be booting
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true });
  const [mk, setMk] = useState<'folder' | 'file'>();
  const [rename, setRename] = useState<Entry>();
  const [del, setDel] = useState<Entry>();
  const [view, setView] = useState<{ entry: Entry; edit?: boolean }>();
  const [over, setOver] = useState<string>(); // folder (path) a row is being dragged over
  const pick = useRef<HTMLInputElement>(null);
  const depth = useRef(0); // dragenter/leave fire for every child: count them
  const [conns, setConns] = useState<Conn[]>([]); // storage connections: each is the folder /files/<folder>
  const [connDlg, setConnDlg] = useState<'new' | Conn>();
  const [rmConn, setRmConn] = useState<Conn>();
  const connOf = (folder: string) => (dir === '' ? conns.find((c) => c.folder === folder) : undefined);
  const inConn = conns.find((c) => c.folder === dir.split('/')[0]);

  const loadConns = () => { if (!ro) trpc.connections.list.query().then(setConns).catch(() => {}); };
  const load = () => {
    setStarting(false);
    fc.list(dir).then((r) => { setEntries(r); setErr(''); })
      .catch((e) => { setEntries([]); if (e.status === 503 || e instanceof TypeError) setStarting(true); else setErr(e.message); });
    if (!ro) fc.usage().then(setQuota).catch(() => {});
    loadConns();
  };
  useEffect(load, [dir, fc]);
  // while a sync runs, look again every 3 s; when it ends the files below changed too
  const syncing = conns.some((c) => c.syncing);
  useEffect(() => { if (!syncing) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [syncing, dir, fc]);
  useEffect(() => { const f = () => setDir(hashDir()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const go = (d: string) => (location.hash = prefix + q(d).replace(/%2F/g, '/'));
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } load(); };

  async function send(list: { file: File; rel?: string }[]) {
    const target = dir; // a drop while navigating still lands where it was dropped
    const batch = list.map(({ file, rel }, i) => ({ file, to: join(target, rel ?? ''), job: { id: Date.now() + i, name: join(rel ?? '', file.name), frac: 0 } as Job }));
    if (!batch.length) return;
    setJobs((j) => [...j, ...batch.map((b) => b.job)]);
    const patch = (id: number, p: Partial<Job>) => setJobs((j) => j.map((x) => (x.id === id ? { ...x, ...p } : x)));
    let ok = 0, renamed = 0, last = '';
    for (const { file, to, job } of batch) {
      try {
        const r = await fc.upload(to, file, (frac) => patch(job.id, { frac }));
        patch(job.id, { frac: 1 }); ok++; last = r.saved?.[0]?.name ?? file.name;
        if (last !== file.name) renamed++; // the server keeps both: "a (1).txt"
      } catch (x) { patch(job.id, { error: (x as Error).message }); }
    }
    load();
    if (ok) toast(ok === 1 ? `Uploaded ${last}` : `Uploaded ${ok} files${renamed ? `, ${renamed} renamed to keep both` : ''}`);
    setTimeout(() => setJobs((j) => j.filter((x) => !batch.some((b) => b.job.id === x.id) || x.error)), 1500);
  }

  function drop(e: React.DragEvent) {
    // entries must be read synchronously, before the event ends
    const ents = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (ents.some((x) => x.isDirectory)) void Promise.all(ents.map((x) => walk(x))).then((l) => send(l.flat())).catch((x) => toast((x as Error).message, true));
    else void send([...e.dataTransfer.files].map((file) => ({ file })));
  }

  const move = (name: string, toDir: string) => {
    if (join(dir, name) === toDir || toDir.startsWith(join(dir, name) + '/')) return;
    void run(() => fc.rename(join(dir, name), join(toDir, name)), `Moved ${name} to ${toDir.split('/').at(-1) || source.label}`);
  };
  const dropTarget = (toDir: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(MOVE)) { e.preventDefault(); e.stopPropagation(); setOver(toDir); } },
    onDragLeave: () => setOver((o) => (o === toDir ? undefined : o)),
    onDrop: (e: React.DragEvent) => { const n = e.dataTransfer.getData(MOVE); if (!n) return; e.preventDefault(); e.stopPropagation(); setOver(undefined); move(n, toDir); },
  });

  const open = (en: Entry) => (en.type === 'dir' ? go(join(dir, en.name)) : setView({ entry: en }));
  const sorted = useMemo(() => {
    const v = (e: Entry) => (sort.key === 'name' ? e.name.toLowerCase() : sort.key === 'kind' ? kindOf(e.name, e.type === 'dir').label : sort.key === 'size' ? e.size : e.mtime);
    const have = new Set((entries ?? []).map((e) => e.name));
    const extra: Entry[] = entries && dir === '' && !ro ? conns.filter((c) => !have.has(c.folder)).map((c) => ({ name: c.folder, type: 'dir', size: 0, mtime: c.createdAt })) : []; // not synced yet: no folder on disk
    return [...(entries ?? []), ...extra].sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1; // folders first
      const x = v(a), y = v(b);
      return ((x < y ? -1 : x > y ? 1 : 0) || a.name.localeCompare(b.name)) * (sort.asc ? 1 : -1);
    });
  }, [entries, sort, conns]);
  const th = (key: SortKey, label: string, cls = '') => (
    <button type="button" role="columnheader" aria-sort={sort.key === key ? (sort.asc ? 'ascending' : 'descending') : 'none'} className={`inline-flex items-center gap-1 rounded text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${cls}`}
      onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>{label}{sort.key === key && (sort.asc ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}</button>
  );

  const crumbs = dir ? dir.split('/') : [];
  const hasFiles = (e: React.DragEvent) => !ro && e.dataTransfer.types.includes('Files');
  const cell = 'flex h-[40px] items-center';
  return (
    <div className="relative min-h-full grow" onDragEnter={(e) => { if (hasFiles(e)) { depth.current++; setDrag(true); } }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => { if (hasFiles(e) && --depth.current <= 0) { depth.current = 0; setDrag(false); } }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setDrag(false); drop(e); }}>
      <Page wide title="Files" hint={ro ? 'What this chat’s agent left in its scratch space (/tmp). You can look at it here; it is cleared by hand or by Clean up.' : 'Your private folder. Every chat’s agent sees it as /files and can read and edit what you put here.'}
        actions={ro ? undefined : <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setMk('file')}><FilePlus size={16} aria-hidden />New file</Button>
          <Button variant="outline" onClick={() => setMk('folder')}><FolderPlus size={16} aria-hidden />New folder</Button>
          <Button variant="outline" onClick={() => setConnDlg('new')}><Cloud size={16} aria-hidden />Connect storage</Button>
          <Button onClick={() => pick.current?.click()}><UploadIcon size={16} aria-hidden />Upload</Button>
          <input ref={pick} type="file" multiple className="sr-only" aria-label="Upload files" tabIndex={-1} onChange={(e) => { void send([...(e.target.files ?? [])].map((file) => ({ file }))); e.target.value = ''; }} />
        </div>}>
        {top}
        <nav aria-label="Path" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
          <Crumb current={!crumbs.length} over={over === ''} drop={dropTarget('')} onClick={() => go('')}>{source.label}</Crumb>
          {crumbs.map((c, i) => { const p = crumbs.slice(0, i + 1).join('/'); return <span key={i} className="flex items-center gap-1"><ChevronRight size={14} aria-hidden className="text-muted-foreground" />
            <Crumb current={i === crumbs.length - 1} over={over === p} drop={dropTarget(p)} onClick={() => go(p)}>{c}</Crumb></span>; })}
          {inConn && <ConnBadge c={inConn} />}
        </nav>
        <Err>{err}</Err>
        {starting && <div role="status" className="mb-3 flex items-center gap-3 rounded-lg bg-foreground/[0.06] px-4 py-3 text-sm"><Loader2 size={16} className="animate-spin" aria-hidden /><span className="grow">Starting your workspace. This can take a few seconds.</span><Button size="sm" variant="outline" onClick={load}>Try again</Button></div>}
        {jobs.length > 0 && <ul aria-label="Uploads" className="mb-3 grid gap-2 text-[13px]">
          {jobs.map((j) => (
            <li key={j.id} className="grid gap-1">
              <div className="flex items-center justify-between gap-3"><span className="truncate">{j.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={j.error ? 'text-danger-ink' : 'tnum text-muted-foreground'}>{j.error ?? (j.frac >= 1 ? 'Done' : `${Math.round(j.frac * 100)}%`)}</span>
                  {j.error && <Button variant="ghost" size="icon-xs" aria-label={`Dismiss ${j.name}`} onClick={() => setJobs((l) => l.filter((x) => x.id !== j.id))}><X aria-hidden /></Button>}
                </span></div>
              {!j.error && <div role="progressbar" aria-label={`Uploading ${j.name}`} aria-valuenow={Math.round(j.frac * 100)} className="h-1 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${j.frac * 100}%` }} /></div>}
            </li>
          ))}
        </ul>}
        <Reveal loading={!entries} fallback={<Loading shape="rows" n={4} />}>
          {entries && !sorted.length && !err && !starting && jobs.length === 0 && <Empty icon={<Folder size={28} />}>No files yet. Upload a file or drop it here — every chat’s agent can use it.</Empty>}
          {!!sorted.length && (
            <div role="table" aria-label="Files" className="text-[13px]">
              <div role="row" className={`grid ${COLS} items-center gap-x-3 pb-1 text-xs text-muted-foreground`}>
                {th('name', 'Name')}<span className="max-sm:hidden">{th('kind', 'Kind')}</span>
                <span className="flex justify-end">{th('size', 'Size')}</span><span className="max-sm:hidden">{th('mtime', 'Modified')}</span><span />
              </div>
              {sorted.map((en) => {
                const dirRow = en.type === 'dir', c = dirRow ? connOf(en.name) : undefined, conflict = !dirRow && isConflictCopy(en.name);
                const k = kindOf(en.name, dirRow), Icon = c ? KIND_ICON[c.kind] ?? Cloud : k.icon, p = join(dir, en.name);
                return (
                  <div key={en.name} role="row" tabIndex={0} draggable={!ro && !c} onDragStart={(e) => { e.dataTransfer.setData(MOVE, en.name); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => open(en)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(en); }}
                    {...(dirRow && !ro ? dropTarget(p) : {})}
                    className={`group grid ${COLS} cursor-pointer select-none items-center gap-x-3 border-t transition-colors last:border-b hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${over === p ? 'bg-foreground/10' : ''}`}>
                    <div role="cell" className={`${cell} min-w-0 gap-2 font-medium`}><Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" /><span className="truncate">{en.name}</span>{c && <ConnBadge c={c} />}</div>
                    <div role="cell" className={`${cell} truncate text-muted-foreground max-sm:hidden`}>{c ? 'Connection' : conflict ? <span className="italic">Conflict copy</span> : k.label}</div>
                    <div role="cell" className={`${cell} tnum justify-end text-muted-foreground`}>{dirRow ? '' : bytes(en.size)}</div>
                    <div role="cell" className={`${cell} tnum whitespace-nowrap text-muted-foreground max-sm:hidden`}>{when(en.mtime)}</div>
                    <div role="cell" className={`${cell} justify-end`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${en.name}`} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100" />}><Ellipsis size={16} aria-hidden /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {!dirRow && <DropdownMenuItem className="text-[13px]" render={<a href={fc.url(p)} download />}><Download size={15} aria-hidden />Download</DropdownMenuItem>}
                          {c && <>
                            <DropdownMenuItem className="text-[13px]" disabled={c.syncing} onClick={() => void syncNow(c, load)}><RefreshCw size={15} aria-hidden />Sync now</DropdownMenuItem>
                            <DropdownMenuItem className="text-[13px]" onClick={() => setConnDlg(c)}><Pencil size={15} aria-hidden />Edit connection</DropdownMenuItem>
                            <DropdownMenuItem className="text-[13px]" onClick={() => void testConn(c)}><Cloud size={15} aria-hidden />Test</DropdownMenuItem>
                            <DropdownMenuItem className="text-[13px]" variant="destructive" onClick={() => setRmConn(c)}><Unplug size={15} aria-hidden />Remove</DropdownMenuItem>
                          </>}
                          {!ro && !c && <DropdownMenuItem className="text-[13px]" onClick={() => setRename(en)}><Pencil size={15} aria-hidden />Rename</DropdownMenuItem>}
                          {!ro && !c && <DropdownMenuItem className="text-[13px]" variant="destructive" onClick={() => setDel(en)}><Trash2 size={15} aria-hidden />Delete</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Reveal>
        {quota && <div className="mt-6 grid max-w-xs gap-1.5"><QuotaBar {...quota} /><span className="tnum text-xs text-muted-foreground">{bytes(quota.used)} of {bytes(quota.quota)} used</span></div>}
      </Page>
      {drag && <div aria-hidden className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground/40 bg-background/70 text-sm font-medium">Drop to upload to {crumbs.at(-1) ?? source.label}</div>}
      {mk === 'folder' && <NameDialog title="New folder" label="Folder name" action="Create" onClose={() => setMk(undefined)} onSubmit={(name) => run(() => fc.mkdir(join(dir, name)), `Created folder ${name}`)} />}
      {mk === 'file' && <NameDialog title="New file" label="File name" action="Create" initial="untitled.md" onClose={() => setMk(undefined)}
        onSubmit={async (name) => { try { const r = await fc.write(join(dir, name), '', { create: true }); load(); setView({ entry: { name, type: 'file', ...r }, edit: true }); } catch (x) { toast((x as Error).message, true); } }} />}
      {rename && <NameDialog title={`Rename ${rename.name}`} label="New name" action="Save" initial={rename.name} onClose={() => setRename(undefined)}
        onSubmit={(to) => to !== rename.name && run(() => fc.rename(join(dir, rename.name), join(dir, to)), `Renamed to ${to}`)} />}
      {del && <ConfirmDialog title={`Delete ${del.name}?`} body={del.type === 'dir' ? 'The folder and everything in it will be deleted.' : 'This cannot be undone.'} action="Delete" onClose={() => setDel(undefined)}
        onConfirm={() => { const d = del; setDel(undefined); void run(() => fc.remove(join(dir, d.name)), `Deleted ${d.name}`); }} />}
      {connDlg && <ConnectDialog edit={connDlg === 'new' ? undefined : connDlg} onClose={() => setConnDlg(undefined)} onDone={load} onRemove={connDlg === 'new' ? undefined : () => { setRmConn(connDlg); setConnDlg(undefined); }} />}
      {rmConn && <RemoveDialog conn={rmConn} onClose={() => setRmConn(undefined)} onDone={() => { if (inConn?.id === rmConn.id) go(''); load(); }} />}
      {view && <FileViewer key={view.entry.name + dir} client={fc} path={join(dir, view.entry.name)} entry={view.entry} edit={view.edit} readOnly={ro} conn={inConn} onClose={() => setView(undefined)} onChanged={load}
        onRename={() => { setRename(view.entry); setView(undefined); }} onDelete={() => { setDel(view.entry); setView(undefined); }} />}
    </div>
  );
}

// Sync state next to a connection's folder: "Synced 3 min ago", "Syncing…" (.hf-working), "Error: …".
const ConnBadge = ({ c }: { c: Conn }) => (
  <span className={`ml-2 inline-flex min-w-0 shrink items-center gap-1.5 truncate text-xs font-normal ${c.status === 'error' && !c.syncing ? 'text-danger-ink' : 'text-muted-foreground'}`} title={c.lastError ?? undefined}>
    {c.syncing && <span className="hf-working" aria-hidden><i /><i /><i /></span>}<span className="truncate">{statusLine(c, when)}</span>
  </span>
);

const Crumb = ({ current, over, drop, onClick, children }: { current: boolean; over: boolean; drop: object; onClick: () => void; children: string }) => (
  <button type="button" aria-current={current ? 'page' : undefined} {...drop} className={`rounded px-1.5 py-0.5 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring ${over ? 'bg-foreground/10' : ''} ${current ? 'font-medium' : 'text-muted-foreground'}`} onClick={onClick}>{children}</button>
);

function NameDialog({ title, label, action, initial = '', onSubmit, onClose }: { title: string; label: string; action: string; initial?: string; onSubmit: (name: string) => unknown; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const submit = () => { const n = name.trim(); if (!n) return; onClose(); void onSubmit(n); };
  return (
    <Dialog title={title} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!name.trim()} onClick={submit}>{action}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input aria-label={label} placeholder={label} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
      </form>
    </Dialog>
  );
}
