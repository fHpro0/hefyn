import { useMemo, useState } from 'react';
import { Button } from '@/ui/button';
import { ConfirmDialog, Dialog } from '../dialogs';
import { toast } from '../toast';
import { buttonDanger, Err, Field as Labeled } from '../ui';
import { FieldInput } from './inputs';
import { trpc } from '@/lib/trpc';
import { expandLabel, today, type Collection, type Rec } from './types';

// Create or edit one record in a side sheet. The server validates (422 with a message per field); the form only shows what it says.
export function RecordSheet({ col, rec, me, onClose, onSaved }: { col: Collection; rec?: Rec; me: string; onClose: () => void; onSaved: () => void }) {
  const init = useMemo(() => {
    const v: Record<string, any> = {};
    for (const f of col.fields) {
      let x = rec ? rec.values[f.name] : f.default;
      if (!rec) { if (x === '@today') x = today(); else if (x === '@now') x = new Date().toISOString(); else if (x === '@me') x = f.multiple ? [me] : me; }
      v[f.name] = x ?? (f.type === 'bool' ? false : null);
    }
    return v;
  }, [col.id, rec?.id]);
  const [vals, setVals] = useState<Record<string, any>>(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const labels = (name: string) => {
    const e = rec?.expand?.[name];
    return Object.fromEntries([e].flat().filter(Boolean).map((r: any) => [r.id, expandLabel(r)]));
  };
  const save = async () => {
    setMsg(''); setErrors({}); setBusy(true);
    try {
      const values = Object.fromEntries(Object.entries(vals).filter(([, x]) => x !== undefined));
      const bad = col.fields.filter((f) => vals[f.name] === undefined).map((f) => f.name); // JSON that does not parse
      if (bad.length) { setErrors(Object.fromEntries(bad.map((n) => [n, 'is not valid JSON']))); return; }
      if (rec) await trpc.data.records.update.mutate({ collection: col.id, id: rec.id, values }); else await trpc.data.records.create.mutate({ collection: col.id, values });
      toast(rec ? 'Saved' : 'Record added');
      onSaved(); onClose();
    } catch (e: any) {
      setMsg(e.message);
      const d = e.data?.details;
      if (d && typeof d === 'object' && !Array.isArray(d)) setErrors(d);
    } finally { setBusy(false); }
  };
  const readOnly = !col.canEdit;
  return (
    <>
      <Dialog side title={rec ? 'Edit record' : 'New record'} onClose={onClose}
        footer={<div className="flex w-full items-center gap-2">
          {rec && col.canEdit && <Button variant="outline" className={buttonDanger} type="button" onClick={() => setDel(true)}>Delete</Button>}
          <span className="grow" />
          <Button variant="outline" type="button" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" form="record-form" disabled={busy}>{rec ? 'Save' : 'Create'}</Button>}
        </div>}>
        <form id="record-form" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {col.fields.map((f) => (
            <Labeled key={f.name} label={<span>{f.name}{f.required && <span className="text-danger-ink"> *</span>}{f.type === 'duration' && <span className="text-muted-foreground"> (h:mm)</span>}</span>}>
              <FieldInput f={f} value={vals[f.name]} labels={labels(f.name)} disabled={readOnly} onChange={(x) => setVals((s) => ({ ...s, [f.name]: x }))} />
              {errors[f.name] && <span className="text-xs text-danger-ink" role="alert">{errors[f.name]}</span>}
            </Labeled>))}
          {!col.fields.length && <p className="text-[13px] text-muted-foreground">This collection has no fields yet. Add some in its settings.</p>}
          <Err>{msg}</Err>
          {rec && <p className="text-xs text-muted-foreground">Created {new Date(rec.created).toLocaleString()} · updated {new Date(rec.updated).toLocaleString()}</p>}
        </form>
      </Dialog>
      {del && rec && <ConfirmDialog title="Delete this record?" body="It is removed for good." action="Delete" onClose={() => setDel(false)}
        onConfirm={async () => { try { await trpc.data.records.delete.mutate({ collection: col.id, ids: [rec.id] }); toast('Record deleted'); onSaved(); onClose(); } catch (e) { toast((e as Error).message, true); } }} />}
    </>
  );
}
