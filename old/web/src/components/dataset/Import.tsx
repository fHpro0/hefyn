import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog } from '../dialogs';
import { toast } from '../toast';
import { Err, Select } from '../ui';
import { trpc } from '@/lib/trpc';
import { type Collection } from './types';

// First CSV row (quotes allowed), enough to offer a column mapping; the server parses the whole file.
function header(text: string): string[] {
  const out: string[] = []; let cell = '', q = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && !cell) q = true; else if (c === ',') { out.push(cell); cell = ''; } else if (c === '\n' || c === '\r') break; else cell += c;
  }
  out.push(cell);
  return out;
}

interface Report { created: number; invalid: number; errors: { row: number; error: string }[] }

export function ImportDialog({ col, onClose, onDone }: { col: Collection; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState(false);
  const [rep, setRep] = useState<Report>();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const mapping = () => Object.fromEntries(cols.map((c) => [c, map[c] || null]));

  // a dry run after every change shows what would happen before anything is written
  useEffect(() => {
    if (!text || !cols.length) return;
    let live = true; setErr(''); setRep(undefined);
    trpc.data.importCsv.mutate({ collection: col.id, csv: text, mapping: mapping(), skipInvalid: true, dryRun: true }).then((r) => live && setRep(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [text, map, cols]);

  const pick = async (f?: File) => {
    if (!f) return;
    const t = await f.text(), h = header(t);
    setText(t); setName(f.name); setCols(h);
    setMap(Object.fromEntries(h.map((c) => [c, col.fields.find((x) => x.name.toLowerCase() === c.trim().toLowerCase())?.name ?? ''])));
  };
  const run = async () => {
    setBusy(true); setErr('');
    try { const r = await trpc.data.importCsv.mutate({ collection: col.id, csv: text, mapping: mapping(), skipInvalid: skip }); toast(`${r.created} record${r.created === 1 ? '' : 's'} imported`); onDone(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Import CSV into ${col.name}`} wide onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !rep || !rep.created || (!!rep.invalid && !skip)} onClick={run}>Import{rep ? ` ${rep.created}` : ''}</Button></>}>
      <p className="text-[13px] text-muted-foreground">The first row names the columns. Lists (several select values or relations) are separated by <code className="font-mono">|</code>, durations are minutes or h:mm, relations are record ids.</p>
      <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => pick(e.target.files?.[0])} />
      <div className="flex items-center gap-3"><Button variant="outline" onClick={() => file.current?.click()}>{name ? 'Choose another file' : 'Choose a CSV file'}</Button>{name && <span className="truncate text-[13px]">{name}</span>}</div>
      {!!cols.length && (
        <div className="grid gap-2">
          {cols.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr] items-center gap-3 text-[13px]">
              <span className="truncate" title={c}>{c || <em className="text-muted-foreground">(no name)</em>}</span>
              <Select aria-label={`Field for column ${c}`} value={map[c] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [c]: e.target.value }))}>
                <option value="">Skip this column</option>{col.fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </Select>
            </div>))}
        </div>)}
      {rep && (
        <div className="grid gap-1.5 text-[13px]" role="status">
          <p>{rep.created} row{rep.created === 1 ? '' : 's'} can be imported{rep.invalid ? `, ${rep.invalid} cannot` : ''}.</p>
          {!!rep.errors.length && <ul className="max-h-32 overflow-y-auto rounded-md bg-muted p-2 text-xs">{rep.errors.map((e) => <li key={e.row}>Row {e.row}: {e.error}</li>)}</ul>}
          {!!rep.invalid && <label className="flex items-center gap-2"><Checkbox checked={skip} onCheckedChange={(c) => setSkip(!!c)} />Import the valid rows and skip the others</label>}
        </div>)}
      <Err>{err}</Err>
    </Dialog>
  );
}
