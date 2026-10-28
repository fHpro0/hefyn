import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Input, Select, Switch, Textarea } from '../ui';
import { trpc } from '@/lib/trpc';
import { expandLabel, firstText, fmtDuration, isEmpty, localDateTime, parseDuration, type Choice, type Field, type Rec } from './types';

// Inputs for each field type (record sheet and inline edit) and the read-only cell renderer.

let usersCache: Promise<Choice[]> | undefined;
export const loadUsers = () => (usersCache ??= trpc.data.users.query().catch(() => { usersCache = undefined; return []; }));

/** One or several related records: pick from a searchable list. `labels` are the names already known (from expand). */
export function RelationPicker({ f, value, onChange, labels, disabled }: { f: Field; value: unknown; onChange: (v: unknown) => void; labels?: Record<string, string>; disabled?: boolean }) {
  const ids: string[] = f.multiple ? (Array.isArray(value) ? value : []) : typeof value === 'string' && value ? [value] : [];
  const [known, setKnown] = useState<Record<string, string>>(labels ?? {});
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Choice[]>([]);
  useEffect(() => { setKnown((k) => ({ ...labels, ...k })); }, [labels]);
  useEffect(() => { if (f.collection === 'users') loadUsers().then((u) => setKnown((k) => ({ ...Object.fromEntries(u.map((x) => [x.id, x.name])), ...k }))); }, [f.collection]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (f.collection === 'users') loadUsers().then((u) => setOpts(u.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 50)));
      else trpc.data.records.list.query({ collection: f.collection!, perPage: 30, q }).then((r) => setOpts(r.items.map((x: Rec) => ({ id: x.id, name: String(firstText(x, x.id)) })))).catch(() => setOpts([]));
    }, 150);
    return () => clearTimeout(t);
  }, [open, q, f.collection]);
  const pick = (o: Choice) => {
    setKnown((k) => ({ ...k, [o.id]: o.name }));
    if (f.multiple) onChange(ids.includes(o.id) ? ids.filter((x) => x !== o.id) : [...ids, o.id]);
    else { onChange(ids[0] === o.id ? null : o.id); setOpen(false); }
  };
  const name = (id: string) => known[id] ?? `${id.slice(0, 8)}…`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" type="button" disabled={disabled} aria-label={`Choose ${f.name}`} className="h-auto min-h-8 w-full justify-between gap-2 py-1 font-normal" />}>
        <span className="flex min-w-0 flex-wrap gap-1">{ids.length ? ids.map((id) => <Badge key={id} variant="secondary" className="max-w-full truncate">{name(id)}</Badge>) : <span className="text-muted-foreground">Select…</span>}</span>
        <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1rem))] gap-1.5">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search" />
        <ul className="max-h-56 overflow-y-auto" role="listbox" aria-multiselectable={f.multiple}>
          {opts.map((o) => (
            <li key={o.id} role="option" aria-selected={ids.includes(o.id)}>
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none" onClick={() => pick(o)}>
                <Check size={14} aria-hidden className={ids.includes(o.id) ? 'shrink-0' : 'invisible shrink-0'} /><span className="truncate">{o.name}</span>
              </button>
            </li>))}
          {!opts.length && <li className="px-2 py-3 text-center text-[13px] text-muted-foreground">Nothing found</li>}
        </ul>
        {!f.required && !!ids.length && <Button variant="ghost" size="sm" type="button" onClick={() => { onChange(f.multiple ? [] : null); setOpen(false); }}><X aria-hidden />Clear</Button>}
      </PopoverContent>
    </Popover>
  );
}

function DurationInput({ value, onChange, label }: { value: unknown; onChange: (v: number | null) => void; label: string }) {
  const [text, setText] = useState(typeof value === 'number' ? fmtDuration(value) : '');
  const bad = text.trim() !== '' && parseDuration(text) === undefined;
  return <Input aria-label={label} aria-invalid={bad} value={text} placeholder="h:mm" inputMode="text" onChange={(e) => { setText(e.target.value); const m = parseDuration(e.target.value); if (m !== undefined) onChange(m); else if (!e.target.value.trim()) onChange(null); }} onBlur={() => { const m = parseDuration(text); if (m !== undefined) setText(fmtDuration(m)); }} />;
}

function JsonInput({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const [text, setText] = useState(isEmpty(value) ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return <Textarea aria-label={label} aria-invalid={bad} rows={5} className="font-mono text-xs" spellCheck={false} value={text} onChange={(e) => {
    setText(e.target.value);
    if (!e.target.value.trim()) { setBad(false); return onChange(null); }
    try { onChange(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); onChange(undefined); }
  }} />;
}

export function FieldInput({ f, value, onChange, labels, disabled }: { f: Field; value: any; onChange: (v: unknown) => void; labels?: Record<string, string>; disabled?: boolean }) {
  const common = { 'aria-label': f.name, disabled };
  const v = value ?? '';
  switch (f.type) {
    case 'longtext': return <Textarea {...common} rows={4} value={v} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <Input {...common} type="number" step={f.integer ? 1 : 'any'} min={f.min} max={f.max} value={v} onChange={(e) => onChange(e.target.value === '' ? null : e.target.valueAsNumber)} />;
    case 'bool': return <div><Switch checked={!!value} onChange={onChange} label={f.name} disabled={disabled} /></div>;
    case 'date': return <Input {...common} type="date" value={v} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime': return <Input {...common} type="datetime-local" value={value ? localDateTime(value) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'email': return <Input {...common} type="email" value={v} onChange={(e) => onChange(e.target.value)} />;
    case 'url': return <Input {...common} type="url" placeholder="https://" value={v} onChange={(e) => onChange(e.target.value)} />;
    case 'duration': return <DurationInput label={f.name} value={value} onChange={onChange} />;
    case 'json': return <JsonInput label={f.name} value={value} onChange={onChange} />;
    case 'relation': return <RelationPicker f={f} value={value} onChange={onChange} labels={labels} disabled={disabled} />;
    case 'select':
      if (!f.multiple) return <Select {...common} value={v} onChange={(e) => onChange(e.target.value || null)}><option value="">{f.required ? 'Choose…' : '—'}</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>;
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label={f.name}>
          {f.options?.map((o) => { const on = Array.isArray(value) && value.includes(o); return (
            <label key={o} className="flex items-center gap-1.5 text-[13px]"><Checkbox checked={on} disabled={disabled} onCheckedChange={(c) => onChange(c ? [...(value ?? []), o] : (value ?? []).filter((x: string) => x !== o))} />{o}</label>); })}
        </div>);
    default: return <Input {...common} value={v} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Read-only rendering of one cell. */
export function CellView({ f, rec }: { f: Field; rec: Rec }) {
  const x = rec.values[f.name];
  if (f.type === 'bool') return x ? <Check size={15} aria-label="Yes" className="text-success-ink" /> : <span aria-label="No" className="text-muted-foreground">–</span>;
  if (isEmpty(x)) return <span className="text-muted-foreground">–</span>;
  switch (f.type) {
    case 'select': return <span className="flex flex-wrap gap-1">{[x].flat().map((o: string) => <Badge key={o} variant="secondary">{o}</Badge>)}</span>;
    case 'relation': { const e = rec.expand?.[f.name], list = [e].flat().filter(Boolean); return list.length ? <span className="flex flex-wrap gap-1">{list.map((r: any) => <Badge key={r.id} variant="outline" className="max-w-48 truncate">{expandLabel(r)}</Badge>)}</span> : <span className="text-muted-foreground">{[x].flat().length} linked</span>; }
    case 'duration': return <span className="tabular-nums">{fmtDuration(x)}</span>;
    case 'number': return <span className="tabular-nums">{x}</span>;
    case 'datetime': return <span className="tabular-nums">{new Date(x).toLocaleString()}</span>;
    case 'date': return <span className="tabular-nums">{x}</span>;
    case 'url': return /^https?:\/\//.test(x) ? <a href={x} target="_blank" rel="noopener noreferrer" className="text-seal underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{x}</a> : <span>{x}</span>;
    case 'email': return <a href={`mailto:${x}`} className="text-seal underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{x}</a>;
    case 'json': return <code className="font-mono text-xs">{JSON.stringify(x)}</code>;
    default: return <span>{String(x)}</span>;
  }
}

/** Fields the table edits in place (everything else opens the record sheet). */
export const INLINE: Field['type'][] = ['text', 'number', 'bool', 'date', 'email', 'url', 'duration'];
export const inlineSelect = (f: Field) => f.type === 'select' && !f.multiple;
