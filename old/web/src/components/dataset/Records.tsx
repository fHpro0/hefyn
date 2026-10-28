import { ArrowDown, ArrowUp, CheckSquare, ChevronLeft, ChevronRight, CircleHelp, Columns3, Database, Download, ExternalLink, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { menuRef } from '../AppMenu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { ConfirmDialog } from '../dialogs';
import { toast } from '../toast';
import { Empty, Input, Kbd, Select } from '../ui';
import { ImportDialog } from './Import';
import { CellView, FieldInput, inlineSelect, INLINE } from './inputs';
import { RecordSheet } from './RecordSheet';
import { trpc } from '@/lib/trpc';
import { type Collection, type Field, type Rec, type RecPage } from './types';

const EXAMPLES = ['status != "done" && due <= @today', 'title ~ "report"', 'date >= @weekStart && date <= @weekEnd', 'project.name = "Website" && billable = true', 'created > @today'];

function FilterHelp({ col, apply }: { col: Collection; apply: (s: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="icon" type="button" aria-label="Filter syntax help" />}><CircleHelp aria-hidden /></PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-1rem))] text-[13px]">
        <p><b>Fields:</b> {col.fields.map((f) => f.name).join(', ') || 'none yet'}, id, created, updated. Follow a relation with a dot: <code className="font-mono">project.name</code>.</p>
        <p><b>Operators:</b> <code className="font-mono">= != &gt; &gt;= &lt; &lt;= ~ !~</code> (<code className="font-mono">~</code> contains). Join with <code className="font-mono">&amp;&amp;</code> and <code className="font-mono">||</code>, group with parentheses.</p>
        <p><b>Values:</b> "text", numbers, true, false, null, <code className="font-mono">@today @now @me @weekStart @weekEnd @monthStart @monthEnd</code>.</p>
        <p className="text-muted-foreground">Examples (click to use):</p>
        <ul className="grid gap-1">{EXAMPLES.map((x) => <li key={x}><button type="button" className="w-full rounded-md bg-muted px-2 py-1 text-left font-mono text-xs hover:bg-foreground/10" onClick={() => apply(x)}>{x}</button></li>)}</ul>
      </PopoverContent>
    </Popover>
  );
}

// A cell that edits in place: double-click or Enter; Esc cancels, Enter or leaving saves.
function EditableCell({ col, f, rec, onSaved, onOpen }: { col: Collection; f: Field; rec: Rec; onSaved: (r: Rec) => void; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<any>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (editing) box.current?.querySelector<HTMLElement>('input,select,textarea')?.focus(); }, [editing]);
  const canInline = col.canEdit && (INLINE.includes(f.type) || inlineSelect(f)) && f.type !== 'duration';
  const commit = async (v: any) => {
    setEditing(false);
    if (JSON.stringify(v ?? null) === JSON.stringify(rec.values[f.name] ?? null)) return;
    try { const r = await trpc.data.records.update.mutate({ collection: col.id, id: rec.id, values: { [f.name]: v } }); onSaved({ ...rec, ...r, expand: rec.expand }); }
    catch (e) { toast((e as Error).message, true); }
  };
  if (f.type === 'bool' && col.canEdit) return <button type="button" className="rounded p-1 -m-1 focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${f.name}: ${rec.values[f.name] ? 'yes' : 'no'}, toggle`} onClick={(e) => { e.stopPropagation(); commit(!rec.values[f.name]); }}><CellView f={f} rec={rec} /></button>;
  if (editing) return (
    <div ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (f.type !== 'select') commit(val); } }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { if (f.type === 'select') setEditing(false); else commit(val); } }}>
      {f.type === 'select' ? <Select aria-label={f.name} value={val ?? ''} onChange={(e) => commit(e.target.value || null)}><option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</Select>
        : <FieldInput f={{ ...f, required: false }} value={val} onChange={setVal} />}
    </div>);
  return (
    <div className="min-h-5 min-w-8" onDoubleClick={canInline ? (e) => { e.stopPropagation(); setVal(rec.values[f.name]); setEditing(true); } : undefined}
      onKeyDown={canInline ? (e) => { if (e.key === 'F2') { e.preventDefault(); setVal(rec.values[f.name]); setEditing(true); } } : undefined}
      title={canInline ? 'Double-click or press F2 to edit' : undefined}><CellView f={f} rec={rec} /></div>);
}

export function Records({ col, me, onChanged }: { col: Collection; me: string; onChanged: () => void }) {
  const colsKey = `hefyn-data-cols:${col.id}`;
  const [q, setQ] = useState('');
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('-created');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(30);
  const [res, setRes] = useState<RecPage>();
  const [err, setErr] = useState('');
  const [filterErr, setFilterErr] = useState('');
  const [version, setVersion] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(colsKey) ?? '[]')); } catch { return new Set(); } });
  const [sheet, setSheet] = useState<{ rec?: Rec } | undefined>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const expand = useMemo(() => col.fields.filter((f) => f.type === 'relation').map((f) => f.name).join(','), [col]);
  const shown = col.fields.filter((f) => !hidden.has(f.name));

  useEffect(() => { setQ(''); setFilterText(''); setFilter(''); setSort('-created'); setPage(1); setSel(new Set()); setRes(undefined); setErr(''); setFilterErr(''); try { setHidden(new Set(JSON.parse(localStorage.getItem(colsKey) ?? '[]'))); } catch { setHidden(new Set()); } }, [col.id]);
  // the search and filter boxes apply as you type (debounced); the server checks the syntax
  const [qApplied, setQApplied] = useState('');
  useEffect(() => { const t = setTimeout(() => { setQApplied(q); setPage(1); }, 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setTimeout(() => { setFilter(filterText); setPage(1); }, 500); return () => clearTimeout(t); }, [filterText]);
  useEffect(() => {
    let live = true;
    trpc.data.records.list.query({ collection: col.id, page, perPage, sort, expand, ...(qApplied ? { q: qApplied } : {}), ...(filter.trim() ? { filter } : {}) }).then((r) => { if (live) { setRes(r); setErr(''); setFilterErr(''); if (r.page !== page) setPage(r.page); } })
      .catch((e) => { if (!live) return; if (e.data?.code === 'BAD_REQUEST' && filter.trim()) setFilterErr(e.message); else setErr(e.message); });
    return () => { live = false; };
  }, [col.id, col.updatedAt, qApplied, filter, sort, page, perPage, version]);
  useEffect(() => { // "/" searches, "n" adds a record
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable],[role=dialog]')) return;
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); } else if (e.key === 'n' && col.canEdit) { e.preventDefault(); setSheet({}); }
    };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [col.canEdit]);

  const reload = () => { setVersion((v) => v + 1); onChanged(); };
  const toggleSort = (name: string) => setSort(sort === name ? `-${name}` : sort === `-${name}` ? '-created' : name);
  const items = res?.items ?? [];
  const allOn = items.length > 0 && items.every((r) => sel.has(r.id));
  const setHiddenSaved = (s: Set<string>) => { setHidden(s); localStorage.setItem(colsKey, JSON.stringify([...s])); };
  const exportHref = `/api/data/${col.id}/export.csv?${new URLSearchParams({ sort, ...(qApplied ? { q: qApplied } : {}), ...(filter.trim() ? { filter } : {}) })}`;
  const sortIcon = (name: string) => (sort === name ? <ArrowUp size={13} aria-hidden /> : sort === `-${name}` ? <ArrowDown size={13} aria-hidden /> : null);

  const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;
  /** Right-click on a row: Open, select, delete (the delete goes through the bulk confirm). */
  const rowItems = (r: Rec) => (<>
    <DropdownMenuItem className="text-[13px]" onClick={() => setSheet({ rec: r })}><ExternalLink {...ico} />{col.canEdit ? 'Open / edit' : 'Open'}</DropdownMenuItem>
    <DropdownMenuItem className="text-[13px]" onClick={() => setSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}><CheckSquare {...ico} />{sel.has(r.id) ? 'Deselect' : 'Select'}</DropdownMenuItem>
    {col.canEdit && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" className="text-[13px]" onClick={() => { setSel(new Set([r.id])); setConfirmDel(true); }}><Trash2 {...ico} />Delete</DropdownMenuItem></>}
  </>);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 grow basis-48 sm:max-w-64">
          <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input ref={search} type="search" aria-label="Search records" placeholder="Search…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex min-w-48 grow basis-72 items-center gap-2">
          <Input aria-label="Filter" aria-invalid={!!filterErr} aria-describedby="filter-err" className="font-mono text-xs" placeholder='Filter, e.g. status != "done" && due <= @today' value={filterText} onChange={(e) => setFilterText(e.target.value)} spellCheck={false} autoComplete="off" />
          <FilterHelp col={col} apply={(s) => { setFilterText(s); }} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" aria-label="Columns" />}><Columns3 aria-hidden /><span className="hidden sm:inline">Columns</span></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {col.fields.map((f) => <DropdownMenuCheckboxItem key={f.name} checked={!hidden.has(f.name)} onCheckedChange={(c) => { const s = new Set(hidden); if (c) s.delete(f.name); else s.add(f.name); setHiddenSaved(s); }}>{f.name}</DropdownMenuCheckboxItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {col.canEdit && <Button variant="outline" onClick={() => setImporting(true)} aria-label="Import CSV"><Upload aria-hidden /><span className="hidden sm:inline">Import</span></Button>}
        <a href={exportHref} download aria-label="Export CSV" className={buttonVariants({ variant: 'outline' })}><Download aria-hidden /><span className="hidden sm:inline">Export</span></a>
        {col.canEdit && <Button onClick={() => setSheet({})}><Plus aria-hidden />New record<Kbd>N</Kbd></Button>}
      </div>
      <p id="filter-err" role="alert" className={filterErr ? 'text-[13px] text-danger-ink' : 'sr-only'}>{filterErr}</p>

      {!!sel.size && (
        <div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-1.5 text-[13px]">
          <span>{sel.size} selected</span>
          {col.canEdit && <Button variant="outline" size="sm" onClick={() => setConfirmDel(true)}><Trash2 aria-hidden />Delete</Button>}
          <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>Clear</Button>
        </div>)}

      {err ? <p role="alert" className="text-[13px] text-danger-ink">{err}</p> : !res ? <p className="py-8 text-center text-[13px] text-muted-foreground" role="status">Loading…</p>
        : !items.length ? (
          <Empty icon={<Database size={26} />} action={col.canEdit && !qApplied && !filter.trim() ? <Button onClick={() => setSheet({})}><Plus aria-hidden />Add the first record</Button> : undefined}>
            {qApplied || filter.trim() ? 'No record matches.' : 'No records yet.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-9"><Checkbox aria-label="Select all on this page" checked={allOn} onCheckedChange={(c) => setSel(c ? new Set([...sel, ...items.map((r) => r.id)]) : new Set([...sel].filter((id) => !items.some((r) => r.id === id))))} /></TableHead>
                  {shown.map((f) => (
                    <TableHead key={f.name} aria-sort={sort === f.name ? 'ascending' : sort === `-${f.name}` ? 'descending' : undefined}>
                      <button type="button" className="-mx-1 inline-flex items-center gap-1 rounded px-1 font-medium hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggleSort(f.name)}>{f.name}{sortIcon(f.name)}</button>
                    </TableHead>))}
                  <TableHead aria-sort={sort === 'updated' ? 'ascending' : sort === '-updated' ? 'descending' : undefined}><button type="button" className="inline-flex items-center gap-1 font-medium" onClick={() => toggleSort('updated')}>updated{sortIcon('updated')}</button></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} ref={menuRef(() => rowItems(r))} tabIndex={0} data-state={sel.has(r.id) ? 'selected' : undefined} className="cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none"
                    onClick={() => setSheet({ rec: r })}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') setSheet({ rec: r }); }}>
                    <TableCell onClick={(e) => e.stopPropagation()}><Checkbox aria-label="Select record" checked={sel.has(r.id)} onCheckedChange={(c) => setSel((s) => { const n = new Set(s); if (c) n.add(r.id); else n.delete(r.id); return n; })} /></TableCell>
                    {shown.map((f) => <TableCell key={f.name} className="max-w-72 truncate align-top"><EditableCell col={col} f={f} rec={r} onOpen={() => setSheet({ rec: r })} onSaved={(n) => setRes((p) => p && { ...p, items: p.items.map((x) => (x.id === n.id ? n : x)) })} /></TableCell>)}
                    <TableCell className="text-muted-foreground tabular-nums">{new Date(r.updated).toLocaleDateString()}</TableCell>
                  </TableRow>))}
              </TableBody>
            </Table>
          </div>)}

      {res && res.totalItems > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
          <span aria-live="polite">{(res.page - 1) * res.perPage + 1}–{Math.min(res.page * res.perPage, res.totalItems)} of {res.totalItems}</span>
          <div className="flex items-center gap-2">
            <Select aria-label="Rows per page" className="w-24" value={perPage} onChange={(e) => { setPerPage(+e.target.value); setPage(1); }}>{[15, 30, 50, 100].map((n) => <option key={n} value={n}>{n} rows</option>)}</Select>
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={res.page <= 1} onClick={() => setPage(res.page - 1)}><ChevronLeft aria-hidden /></Button>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={res.page >= res.totalPages} onClick={() => setPage(res.page + 1)}><ChevronRight aria-hidden /></Button>
          </div>
        </div>)}

      {sheet && <RecordSheet key={sheet.rec?.id ?? 'new'} col={col} rec={sheet.rec} me={me} onClose={() => setSheet(undefined)} onSaved={reload} />}
      {importing && <ImportDialog col={col} onClose={() => setImporting(false)} onDone={reload} />}
      {confirmDel && <ConfirmDialog title={`Delete ${sel.size} record${sel.size === 1 ? '' : 's'}?`} body="They are removed for good." action="Delete" onClose={() => setConfirmDel(false)}
        onConfirm={async () => { try { const r = await trpc.data.records.delete.mutate({ collection: col.id, ids: [...sel] }); toast(`${r.deleted} deleted`); setSel(new Set()); reload(); } catch (e) { toast((e as Error).message, true); } }} />}
    </div>
  );
}
