import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, Loader2, Pencil, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { ConfirmDialog, Dialog } from '../dialogs';
import { Hint } from '../Shell';
import { toast } from '../toast';
import { Err, Field, Input } from '../ui';
import { Md } from '../markdown';
import { splitFrontmatter, visualUnsafe } from '../md-frontmatter';

const MdEditor = lazy(() => import('../MdEditor')); // Tiptap stays out of the main bundle

// The draft folder's files: a compact tree and the open file, editable in place (the chat edits the same files, so a write says what text it started from). Both are read again every 3 s while this tab is open, like the overview.
const rpc = trpc;
interface Entry { path: string; size: number }
interface Open { path: string; text: string; truncated: boolean }
interface Node { name: string; path: string; size?: number; children: Node[] }

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const bytes = (s: string) => new TextEncoder().encode(s).length;
const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
const isConflict = (e: unknown) => (e as { data?: { code?: string } }).data?.code === 'CONFLICT';
/** Folders first, files after, each by name; the core files keep the server's order inside the root. */
function tree(files: Entry[]): Node[] {
  const root: Node = { name: '', path: '', children: [] };
  for (const f of files) {
    let at = root;
    f.path.split('/').forEach((name, i, all) => {
      const path = all.slice(0, i + 1).join('/');
      let n = at.children.find((c) => c.path === path);
      if (!n) at.children.push(n = { name, path, children: [] });
      if (i === all.length - 1) n.size = f.size;
      at = n;
    });
  }
  const order = (ns: Node[], top: boolean) => { ns.sort((a, b) => (a.size === undefined ? 0 : 1) - (b.size === undefined ? 0 : 1) || (top ? 0 : a.name < b.name ? -1 : 1)); ns.forEach((n) => order(n.children, false)); };
  order(root.children, true);
  return root.children;
}

function Row({ n, depth, selected, closed, toggle, onSelect }: { n: Node; depth: number; selected?: string; closed: Set<string>; toggle: (p: string) => void; onSelect: (p: string) => void }) {
  const pad = { paddingLeft: `${depth * 14 + 6}px` };
  if (n.size === undefined) {
    const shut = closed.has(n.path);
    return (
      <li>
        <button type="button" style={pad} aria-expanded={!shut} onClick={() => toggle(n.path)} className="flex w-full min-w-0 items-center gap-1.5 rounded py-1 pr-2 text-left text-[13px] leading-5 hover:bg-muted">
          {shut ? <ChevronRight size={14} aria-hidden className="shrink-0" /> : <ChevronDown size={14} aria-hidden className="shrink-0" />}<Folder size={14} aria-hidden className="shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{n.name}</span>
        </button>
        {!shut && <ul>{n.children.map((c) => <Row key={c.path} n={c} depth={depth + 1} selected={selected} closed={closed} toggle={toggle} onSelect={onSelect} />)}</ul>}
      </li>
    );
  }
  return (
    <li>
      <button type="button" style={pad} aria-current={selected === n.path ? 'true' : undefined} onClick={() => onSelect(n.path)}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded py-1 pr-2 text-left text-[13px] leading-5 hover:bg-muted ${selected === n.path ? 'bg-muted font-medium' : ''}`}>
        <FileText size={14} aria-hidden className="ml-[14px] shrink-0 text-muted-foreground" /><span className="min-w-0 grow break-all">{n.name}</span><span className="shrink-0 text-xs text-muted-foreground">{size(n.size)}</span>
      </button>
    </li>
  );
}

/** One path typed into a dialog (a new file, a rename); the server says what is not allowed. */
function PathDialog({ title, action, initial, onClose, onSubmit }: { title: string; action: string; initial: string; onClose: () => void; onSubmit: (path: string) => Promise<void> }) {
  const [path, setPath] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const p = path.trim().replace(/^\/+/, '');
    if (!p || busy) return;
    setBusy(true); setErr('');
    try { await onSubmit(p); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !path.trim()} onClick={() => void go()}>{action}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }} className="grid gap-3">
        <Field label="Path"><Input autoFocus value={path} spellCheck={false} placeholder="notes/todo.md" onChange={(e) => setPath(e.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Folders come from the path.</p>
        <Err>{err}</Err>
      </form>
    </Dialog>
  );
}

export function FilesTab({ draftId, id, ready, selected, onSelect, readOnly, onChanged, onDirty }: { draftId: string; /** a saved Assistant looked at without a draft: its stored files, read once */ id?: string; /** the creator chat is there (the folder can be read) */ ready: boolean; selected?: string; onSelect: (p: string | undefined) => void; readOnly?: boolean; /** after a write, delete or rename */ onChanged?: () => void; /** unsaved edits exist (the parent guards its own tab switch) */ onDirty?: (dirty: boolean) => void }) {
  const src = id ? { id } : { draftId };
  const ro = !!id || !!readOnly;
  const [files, setFiles] = useState<Entry[]>();
  const [open, setOpen] = useState<Open>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saveErr, setSaveErr] = useState(''); // a refused save or delete, next to the Save button; the poll never touches it
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [raw, setRaw] = useState(false); // read-only markdown: rendered or raw; editable markdown: Visual or Source
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete'>();
  const base = useRef(0); // byte size of the text the user loaded; a different listed size means someone else wrote
  const gen = useRef(0);
  const nodes = useMemo(() => tree(files ?? []), [files]);
  const entry = files?.find((f) => f.path === selected);
  const dirty = !ro && !!open && open.path === selected && !open.truncated && draft !== open.text;

  const relist = async () => { const r = await rpc.assistants.draft.files.query(src); setFiles(r.files); };
  const load = (path: string) => {
    const mine = ++gen.current;
    setConflict(false);
    rpc.assistants.draft.file.query({ ...src, path }).then((r) => { if (mine === gen.current) { setOpen(r); setDraft(r.text); base.current = bytes(r.text); setError(''); } }, (e: Error) => { if (mine === gen.current) setError(e.message); });
  };

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await rpc.assistants.draft.files.query(src);
        if (stop) return;
        setFiles((p) => (JSON.stringify(p) === JSON.stringify(r.files) ? p : r.files)); setError('');
      } catch (e) { if (!stop) setError((e as Error).message); }
    };
    void tick();
    const h = id ? undefined : setInterval(tick, 3000); // a stored Assistant does not change under the viewer
    return () => { stop = true; clearInterval(h); };
  }, [draftId, id, ready]);

  // the open file is read when it is picked; a file that is gone clears the selection
  useEffect(() => {
    if (!files || !selected) { gen.current++; setOpen(undefined); return; }
    if (!entry) { onSelect(undefined); return; }
    if (open?.path !== selected) load(selected);
  }, [draftId, id, selected, !!files, !!entry]);
  // it changed on the server: read it again, unless the user has edits (then they choose)
  useEffect(() => {
    if (!entry || open?.path !== selected || entry.size === base.current) return;
    if (dirty) setConflict(true); else load(entry.path);
  }, [entry?.size]);
  useEffect(() => { setSaveErr(''); }, [draft, selected]);
  useEffect(() => { onDirty?.(dirty); }, [dirty]);
  useEffect(() => () => onDirty?.(false), []);
  useEffect(() => { // browser tab close with unsaved edits
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f);
  }, [dirty]);

  const guard = (then: () => void) => (dirty ? setDiscard(() => then) : then());
  const pick = (p: string) => { if (p !== selected) guard(() => onSelect(p)); };
  const changed = async () => { await relist().catch(() => {}); onChanged?.(); };

  const save = async (overwrite = false) => {
    if (!open || ro || open.truncated || saving || !(dirty || overwrite)) return;
    if (/^(assistant|skills|mcp|helpers)\.json$/.test(open.path)) {
      try { JSON.parse(draft); } catch (e) { setSaveErr(`${open.path} is not valid JSON: ${(e as Error).message}`); return; }
    }
    setSaving(true); setSaveErr('');
    try {
      await rpc.assistants.draft.write.mutate({ draftId, path: open.path, text: draft, ...(overwrite ? {} : { expect: open.text }) });
      setOpen({ path: open.path, text: draft, truncated: false }); base.current = bytes(draft); setConflict(false);
      toast(`Saved ${open.path}`); await changed();
    } catch (e) { if (isConflict(e)) setConflict(true); else setSaveErr((e as Error).message); }
    setSaving(false);
  };
  const create = async (path: string) => {
    await rpc.assistants.draft.write.mutate({ draftId, path, text: '', expect: null });
    await changed(); guard(() => onSelect(path));
  };
  const rename = async (to: string) => {
    if (!selected || to === selected) return;
    await rpc.assistants.draft.rename.mutate({ draftId, from: selected, to });
    await changed(); setOpen(undefined); onSelect(to);
  };
  const remove = async () => {
    if (!selected) return;
    try { await rpc.assistants.draft.remove.mutate({ draftId, path: selected }); toast(`Deleted ${selected}`); setOpen(undefined); onSelect(undefined); await changed(); }
    catch (e) { setSaveErr((e as Error).message); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const t = e.currentTarget; t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end'); setDraft(t.value); }
  };

  if (!ready || !files) return <div className="text-[13px] text-muted-foreground">{error ? <Err>{error}</Err> : 'Reading the files…'}</div>;
  const toggle = (p: string) => setClosed((s) => { const n = new Set(s); if (!n.delete(p)) n.add(p); return n; });
  const md = !!selected && isMd(selected);
  const here = !!selected && open?.path === selected;
  const edit = here && !ro && !open.truncated;
  const unsafe = md && edit ? visualUnsafe(splitFrontmatter(draft).body) : undefined; // re-checked on every keystroke in Source
  const spin = <div className="grid place-items-center p-6"><Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  const newBtn = !ro && <Button type="button" size="sm" variant="outline" onClick={() => setDialog('new')}><FilePlus size={14} aria-hidden />New file</Button>;
  return (
    <div className="@container grid gap-3">
      <Err>{error}</Err>
      <div className="grid items-start gap-3 @2xl:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="grid gap-2">
          {newBtn}
          {files.length ? <nav aria-label="Files" className="rounded-xl border border-border p-1.5"><ul>{nodes.map((n) => <Row key={n.path} n={n} depth={0} selected={selected} closed={closed} toggle={toggle} onSelect={pick} />)}</ul></nav>
            : <p className="text-[13px] text-muted-foreground">No files yet.</p>}
        </div>
        {here ? (
          <section aria-label={selected} className="min-w-0 overflow-hidden rounded-xl border border-border">
            <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
              <h3 className="min-w-0 grow font-mono text-xs leading-5 break-all">{selected}</h3>
              {md && <div role="group" aria-label={edit ? 'Editor mode' : 'View mode'} className="flex gap-1">
                {(edit ? [['Visual', false], ['Source', true]] : [['Rendered', false], ['Raw', true]]).map(([l, s]) => { const on = (raw || !!unsafe) === s; return <Button key={String(l)} type="button" size="sm" variant={on ? 'secondary' : 'ghost'} aria-pressed={on} disabled={!s && !!unsafe} onClick={() => setRaw(s as boolean)}>{l}</Button>; })}</div>}
              {edit && <>
                <Hint label="Rename"><Button type="button" size="icon" variant="ghost" aria-label="Rename file" onClick={() => guard(() => setDialog('rename'))}><Pencil size={14} aria-hidden /></Button></Hint>
                <Hint label="Delete"><Button type="button" size="icon" variant="ghost" aria-label="Delete file" onClick={() => setDialog('delete')}><Trash2 size={14} aria-hidden /></Button></Hint>
              </>}
            </header>
            {open.truncated && <p role="status" className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">Shown up to 1 MB; the file is longer, so it can only be viewed here.</p>}
            {conflict && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border bg-foreground/[0.06] px-3 py-2 text-[13px]"><span className="grow">This file changed since you opened it.</span>
              <Button size="sm" variant="outline" onClick={() => load(open.path)}>Reload</Button><Button size="sm" onClick={() => void save(true)}>Overwrite</Button></div>}
            {edit
              ? <>
                {unsafe && <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">Visual editing is off for this file: {unsafe}</p>}
                {md && !raw && !unsafe ? <Suspense fallback={spin}><MdEditor value={draft} onChange={setDraft} label={`Edit ${selected}`} onSave={() => void save()} /></Suspense>
                  : <textarea aria-label={`Edit ${selected}`} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
                    className="block h-[min(32rem,60vh)] w-full resize-y bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring" />}
                <footer className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
                  <span role="status" className="text-[13px] text-muted-foreground">{dirty ? 'Unsaved changes' : 'No changes'}</span>
                  {saveErr && <p role="alert" className="min-w-0 grow break-words text-right text-[13px] text-danger-ink">{saveErr}</p>}
                  <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving && <Loader2 size={14} className="animate-spin" aria-hidden />}Save file</Button>
                </footer>
              </>
              : md && !raw
                ? <div className="max-h-[32rem] overflow-auto px-3 py-2 text-[13px]"><Md>{open.text}</Md></div>
                : <pre tabIndex={0} className="max-h-[32rem] overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{open.text || ' '}</pre>}
          </section>
        ) : selected ? spin : (
          <p className="text-[13px] text-muted-foreground">{ro ? 'Pick a file to read it.' : 'Pick a file to view or edit it. The chat can change files too.'}</p>
        )}
      </div>
      {dialog === 'new' && <PathDialog title="New file" action="Create" initial="" onClose={() => setDialog(undefined)} onSubmit={create} />}
      {dialog === 'rename' && selected && <PathDialog title="Rename file" action="Rename" initial={selected} onClose={() => setDialog(undefined)} onSubmit={rename} />}
      {dialog === 'delete' && selected && <ConfirmDialog title={`Delete ${selected}?`} body="This removes the file from the draft." action="Delete" onClose={() => setDialog(undefined)} onConfirm={() => void remove()} />}
      {discard && <ConfirmDialog title="Discard unsaved changes?" body={`Your edits to ${selected} have not been saved.`} action="Discard" onClose={() => setDiscard(null)} onConfirm={() => { const f = discard; setDiscard(null); f(); }} />}
    </div>
  );
}
