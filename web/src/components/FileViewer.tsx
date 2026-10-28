import { Download, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useHighlightedCode } from '@/hooks/use-highlighted-code';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { bytes } from './api';
import type { Conn } from './Connections';
import { KIND_INFO } from './conn-helpers';
import { CopyButton } from './copy';
import { ConfirmDialog } from './dialogs';
import { kindOf } from './file-kind';
import { Conflict, type Details, type Entry, type FilesClient, absolute, when } from './files-client';
import { Md } from './markdown';
import { splitFrontmatter, visualUnsafe } from './md-frontmatter';
import { Hint } from './Shell';
import { toast } from './toast';

const MdEditor = lazy(() => import('./MdEditor')); // Tiptap stays out of the main bundle

const MAX_TEXT =2 * 1048576, MAX_HIGHLIGHT = 200 * 1024, MAX_ROWS = 500;

// Quoted fields, doubled quotes and newlines inside quotes; enough for a preview.
function parseCsv(text: string, sep: string, limit: number) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length && rows.length <= limit; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Code({ text, lang }: { text: string; lang: string }) {
  const lines = useHighlightedCode(text, text.length > MAX_HIGHLIGHT ? 'plain' : lang);
  return <pre className="min-h-full w-full overflow-auto p-4 font-mono text-[13px] leading-5">{lines.map((l, i) => <div key={i} className="whitespace-pre">{l || ' '}</div>)}</pre>;
}

function Csv({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = useMemo(() => parseCsv(text, tsv ? '\t' : ',', MAX_ROWS), [text, tsv]);
  const [head, ...body] = rows;
  if (!head) return <p className="p-4 text-muted-foreground">This file is empty.</p>;
  return (
    <div className="overflow-auto">
      <table className="w-max min-w-full border-collapse text-[13px]">
        <thead className="sticky top-0 bg-popover"><tr>{head.map((h, i) => <th key={i} className="border-b px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
        <tbody>{body.slice(0, MAX_ROWS).map((r, i) => <tr key={i} className="border-b last:border-0">{r.map((c, j) => <td key={j} className="max-w-[24rem] truncate px-3 py-1.5">{c}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > MAX_ROWS && <p className="p-3 text-xs text-muted-foreground">Showing the first {MAX_ROWS} rows.</p>}
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => <><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></>;

// Path, kind, exact size, dates and (inside a connection folder) the connection: what the list row only hints at.
function DetailsPanel({ client, path, kind, size, mtime, conn }: { client: FilesClient; path: string; kind: string; size: number; mtime: string; conn?: Conn }) {
  const [d, setD] = useState<Details>();
  const [err, setErr] = useState('');
  useEffect(() => { setErr(''); client.stat(path).then(setD).catch((e) => setErr(e.message)); }, [client, path, size, mtime]);
  const date = (iso: string | null) => { if (!iso) return '—'; const rel = Date.now() - Date.parse(iso) < 7 * 86400_000 ? when(iso) : ''; return <>{absolute(iso)}{rel && <span className="text-muted-foreground"> ({rel})</span>}</>; };
  if (err) return <p role="alert" className="p-4 text-danger-ink">{err}</p>;
  if (!d) return <div className="grid h-full place-items-center"><Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 p-5 text-[13px]">
      <Row label="Path"><span className="inline-flex max-w-full items-center gap-1"><code className="break-all font-mono">{d.path}</code><CopyButton text={d.path} label="Copy path" /></span></Row>
      <Row label="Kind">{kind}</Row>
      <Row label="Size"><span className="tnum">{d.size.toLocaleString('en')} bytes</span>{d.size >= 1024 && <span className="text-muted-foreground"> ({bytes(d.size)})</span>}</Row>
      <Row label="Modified">{date(d.mtime)}</Row>
      {d.created && <Row label="Created">{date(d.created)}</Row>}
      {conn && <Row label="Connection">{conn.name} <span className="text-muted-foreground">· {KIND_INFO[conn.kind]?.title ?? conn.kind} · folder {conn.folder}</span></Row>}
      {conn && <Row label="Last sync">{conn.lastSyncAt ? date(conn.lastSyncAt) : 'Not synced yet'}</Row>}
    </dl>
  );
}

export default function FileViewer({ client, path, entry, edit, readOnly, conn, onClose, onChanged, onRename, onDelete }: {
  client: FilesClient; path: string; entry: Entry; edit?: boolean; readOnly?: boolean; conn?: Conn; onClose: () => void; onChanged: () => void; onRename: () => void; onDelete: () => void;
}) {
  const kind = kindOf(entry.name);
  const textual = kind.preview === 'markdown' || kind.preview === 'code' || kind.preview === 'csv';
  const media = kind.preview === 'image' || kind.preview === 'pdf' || kind.preview === 'audio' || kind.preview === 'video';
  const tooBig = textual && entry.size > MAX_TEXT;
  const [text, setText] = useState<string>();
  const [draft, setDraft] = useState('');
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState('');
  const [mtime, setMtime] = useState(entry.mtime);
  const [size, setSize] = useState(entry.size);
  const [tab, setTab] = useState(edit && !readOnly ? 'edit' : 'view');
  const mdUnsafe = kind.preview === 'markdown' ? visualUnsafe(splitFrontmatter(draft).body) : undefined; // re-checked on every keystroke in Source
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const [zoom, setZoom] = useState(false);
  const [source, setSource] = useState(false);
  const [open, setOpen] = useState(true);
  const startEdit = !!edit && !readOnly; // the editor takes focus once it mounts, not the Download button
  const dirty = text !== undefined && draft !== text;
  const gen = useRef(0);

  const load = () => {
    const mine = ++gen.current;
    setErr(''); setConflict(false);
    if (edit && entry.size === 0) { setText(''); setDraft(''); return; }
    if (textual && !tooBig) client.read(path).then((b) => { if (mine === gen.current) { const t = new TextDecoder().decode(b); setText(t); setDraft(t); } }).catch((e) => setErr(e.message));
    else if (media) client.read(path).then((b) => { if (mine === gen.current) setUrl(URL.createObjectURL(new Blob([b], { type: kind.mime }))); }).catch((e) => setErr(e.message)); // typed by extension, never the server's type
  };
  useEffect(() => { load(); return () => { gen.current++; }; }, [path]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { // browser tab close with unsaved edits
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f);
  }, [dirty]);

  const guard = (then: () => void) => (dirty ? setDiscard(() => then) : then());
  const close = () => { setOpen(false); onClose(); };
  const save = async (overwrite = false) => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const r = await client.write(path, draft, overwrite ? {} : { mtime });
      setText(draft); setMtime(r.mtime); setSize(r.size); setConflict(false); toast(`Saved ${entry.name}`); onChanged();
    } catch (e) { if (e instanceof Conflict) setConflict(true); else toast((e as Error).message, true); }
    setSaving(false);
  };
  const reload = () => { setText(undefined); setMtime(''); client.list(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').then((l) => { const e = l.find((x) => x.name === entry.name); if (e) { setMtime(e.mtime); setSize(e.size); } }).finally(load); };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const t = e.currentTarget; t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end'); setDraft(t.value); }
  };

  const Icon = kind.icon;
  const sub = textual && !tooBig;
  const spin = <div className="grid h-full place-items-center"><Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  const canEdit = sub && !readOnly, cur = tab === 'edit' && !canEdit ? 'view' : tab;
  const preview = err ? <p role="alert" className="p-4 text-danger-ink">{err}</p>
    : sub ? (text === undefined ? spin : kind.preview === 'markdown' ? <div className="p-5"><Md>{draft}</Md></div> : kind.preview === 'csv' ? <Csv text={draft} tsv={entry.name.toLowerCase().endsWith('.tsv')} /> : <Code text={draft} lang={kind.lang ?? 'plain'} />)
    : media ? (!url ? spin
      : kind.preview === 'image' ? <div className={`grid p-4 ${zoom ? 'min-h-full w-max min-w-full place-items-start' : 'h-full place-items-center'}`}><img src={url} alt={entry.name} onClick={() => setZoom(!zoom)} className={zoom ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'} /></div>
      : kind.preview === 'pdf' ? <iframe src={url} title={entry.name} className="h-full w-full border-0" />
      : kind.preview === 'audio' ? <div className="grid h-full place-items-center p-4"><audio src={url} controls className="w-full" /></div>
      : <div className="grid h-full place-items-center bg-black/5 p-2"><video src={url} controls className="max-h-full max-w-full" /></div>)
    : <div className="grid h-full place-content-center justify-items-center gap-3 p-6 text-center text-muted-foreground"><Icon size={32} aria-hidden /><p>{tooBig ? 'This file is too large to preview.' : 'No preview for this file type.'}</p>
        <Button variant="outline" nativeButton={false} render={<a href={client.url(path)} download />}><Download size={16} aria-hidden />Download</Button></div>;
  const act = (label: string, icon: React.ReactNode, props: React.ComponentProps<typeof Button>) => <Hint label={label}><Button variant="ghost" size="icon" aria-label={label} {...props}>{icon}</Button></Hint>;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) guard(close); }}>
      <DialogContent showCloseButton={false} initialFocus={startEdit ? false : undefined} className="flex h-[min(86vh,900px)] w-[min(1000px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-xl border p-0 shadow-float ring-0 sm:max-w-none max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:w-screen max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0">
        <header className="flex shrink-0 items-center gap-3 p-3 pl-4">
          <Icon size={20} aria-hidden className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 grow">
            <DialogTitle className="truncate text-sm leading-5 font-medium">{entry.name}</DialogTitle>
            <DialogDescription className="truncate text-xs">{kind.label} · <span className="tnum">{bytes(size)}</span>{when(mtime) && <> · {when(mtime)}</>}</DialogDescription>
          </div>
          {act('Download', <Download size={16} aria-hidden />, { nativeButton: false, render: <a href={client.url(path)} download /> })}
          {!readOnly && act('Rename', <Pencil size={16} aria-hidden />, { onClick: () => guard(onRename) })}
          {!readOnly && act('Delete', <Trash2 size={16} aria-hidden />, { onClick: () => guard(onDelete) })}
          {act('Close', <X size={16} aria-hidden />, { onClick: () => guard(close) })}
        </header>
        {conflict && <div role="alert" className="flex flex-wrap items-center gap-2 border-y bg-foreground/[0.06] px-4 py-2 text-[13px]"><span className="grow">This file changed since you opened it.</span>
          <Button size="sm" variant="outline" onClick={reload}>Reload</Button><Button size="sm" onClick={() => void save(true)}>Overwrite</Button></div>}
        <Tabs value={cur} onValueChange={(v) => setTab(String(v))} className="min-h-0 grow flex-col gap-0 border-t">
          <TabsList variant="line" className="shrink-0 px-3"><TabsTrigger value="view">{kind.preview === 'code' ? 'View' : 'Preview'}</TabsTrigger>{canEdit && <TabsTrigger value="edit">Edit</TabsTrigger>}<TabsTrigger value="details">Details</TabsTrigger></TabsList>
          <TabsContent value="view" className="min-h-0 grow overflow-auto border-t">{preview}</TabsContent>
          {canEdit && <TabsContent value="edit" className="min-h-0 grow overflow-auto border-t">{text === undefined ? spin : <>
            {kind.preview === 'markdown' && <div role="group" aria-label="Editor mode" className="flex shrink-0 justify-end gap-1 border-b px-2 py-1">
              {mdUnsafe && <span className="mr-auto self-center text-xs text-muted-foreground">Visual editing is off for this file: {mdUnsafe}</span>}
              {[['Visual', false], ['Source', true]].map(([l, s]) => <Button key={String(l)} type="button" size="sm" variant={(source || !!mdUnsafe) === s ? 'secondary' : 'ghost'} aria-pressed={(source || !!mdUnsafe) === s} disabled={!s && !!mdUnsafe} onClick={() => setSource(s as boolean)}>{l}</Button>)}</div>}
            {kind.preview === 'markdown' && !source && !mdUnsafe ? <Suspense fallback={spin}><MdEditor value={draft} onChange={setDraft} label={`Edit ${entry.name}`} onSave={() => void save()} autoFocus={startEdit} /></Suspense>
              : <textarea autoFocus={startEdit} aria-label={`Edit ${entry.name}`} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
                className="block h-full min-h-[40vh] w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-5 outline-none" />}</>}</TabsContent>}
          <TabsContent value="details" className="min-h-0 grow overflow-auto border-t"><DetailsPanel client={client} path={path} kind={kind.label} size={size} mtime={mtime} conn={conn} /></TabsContent>
        </Tabs>
        {cur === 'edit' && <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
          <span className="text-[13px] text-muted-foreground">{dirty ? 'Unsaved changes' : 'No changes'}</span>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}Save</Button>
        </footer>}
        {discard && <ConfirmDialog title="Discard unsaved changes?" body={`Your edits to ${entry.name} have not been saved.`} action="Discard" onClose={() => setDiscard(null)} onConfirm={() => { const f = discard; setDiscard(null); f(); }} />}
      </DialogContent>
    </Dialog>
  );
}
