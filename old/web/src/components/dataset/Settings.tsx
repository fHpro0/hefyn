import { ArrowDown, ArrowUp, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { ConfirmDialog, Dialog } from '../dialogs';
import { ICON_NAMES } from '../icons';
import { toast } from '../toast';
import { buttonDanger, Err, Field as Labeled, Input, Select, Textarea } from '../ui';
import { trpc } from '@/lib/trpc';
import { TYPES,type Choice, type Collection, type Field, type FieldType } from './types';

interface Row { k: string; f: Field }
let seq = 0;
const rows = (fs: Field[]): Row[] => fs.map((f) => ({ k: `r${seq++}`, f: { ...f } }));

const UNIQUE_OK: FieldType[] = ['text', 'number', 'email'];
const DEFAULT_TOKEN: Partial<Record<FieldType, [string, string]>> = { date: ['@today', 'Today'], datetime: ['@now', 'Now'] };

function DefaultInput({ f, set }: { f: Field; set: (v: unknown) => void }) {
  const v = f.default;
  const token = DEFAULT_TOKEN[f.type] ?? (f.type === 'relation' && f.collection === 'users' ? ['@me', 'The person creating it'] : undefined);
  if (token) return <Select aria-label="Default" value={String(v ?? '')} onChange={(e) => set(e.target.value || undefined)}><option value="">None</option><option value={token[0]}>{token[1]}</option></Select>;
  if (f.type === 'bool') return <Select aria-label="Default" value={v === true ? 'yes' : v === false ? 'no' : ''} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value === 'yes')}><option value="">None (no)</option><option value="yes">Yes</option><option value="no">No</option></Select>;
  if (f.type === 'select') return <Select aria-label="Default" value={String(v ?? '')} onChange={(e) => set(e.target.value || undefined)}><option value="">None</option>{f.options?.filter(Boolean).map((o) => <option key={o}>{o}</option>)}</Select>;
  if (f.type === 'number' || f.type === 'duration') return <Input aria-label="Default" type="number" placeholder={f.type === 'duration' ? 'minutes' : ''} value={String(v ?? '')} onChange={(e) => set(e.target.value === '' ? undefined : e.target.valueAsNumber)} />;
  if (['text', 'email', 'url'].includes(f.type)) return <Input aria-label="Default" value={String(v ?? '')} onChange={(e) => set(e.target.value || undefined)} />;
  return <span className="text-xs text-muted-foreground">No default for this type</span>;
}

function FieldRow({ r, existing, first, last, targets, upd, move, remove }: { r: Row; existing: boolean; first: boolean; last: boolean; targets: Choice[]; upd: (p: Partial<Field>) => void; move: (d: -1 | 1) => void; remove: () => void }) {
  const f = r.f;
  const [optText, setOptText] = useState((f.options ?? []).join(', '));
  return (
    <li className="grid gap-2 rounded-lg border border-border p-3" aria-label={`Field ${f.name || '(new)'}`}>
      <div className="grid grid-cols-[1fr_9rem] items-center gap-2 sm:grid-cols-[1fr_10rem_auto]">
        <Input aria-label="Field name" placeholder="field_name" value={f.name} onChange={(e) => upd({ name: e.target.value })} autoComplete="off" spellCheck={false} />
        <Select aria-label="Field type" value={f.type} disabled={existing} title={existing ? 'The type of an existing field cannot change' : undefined} onChange={(e) => upd({ type: e.target.value as FieldType, options: undefined, collection: undefined, multiple: undefined, unique: undefined, default: undefined, min: undefined, max: undefined, integer: undefined })}>
          {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </Select>
        <div className="col-span-2 flex items-center justify-end gap-0.5 sm:col-span-1">
          <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={first} onClick={() => move(-1)}><ArrowUp aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={last} onClick={() => move(1)}><ArrowDown aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete field ${f.name}`} className="text-danger-ink" onClick={remove}><Trash2 aria-hidden /></Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
        {f.type !== 'bool' && <label className="flex items-center gap-1.5"><Checkbox checked={!!f.required} onCheckedChange={(c) => upd({ required: c || undefined })} />Required</label>}
        {UNIQUE_OK.includes(f.type) && <label className="flex items-center gap-1.5"><Checkbox checked={!!f.unique} onCheckedChange={(c) => upd({ unique: c || undefined })} />Unique</label>}
        {(f.type === 'select' || f.type === 'relation') && <label className="flex items-center gap-1.5"><Checkbox checked={!!f.multiple} disabled={existing} onCheckedChange={(c) => upd({ multiple: c || undefined })} />Several values</label>}
        {f.type === 'number' && <label className="flex items-center gap-1.5"><Checkbox checked={!!f.integer} onCheckedChange={(c) => upd({ integer: c || undefined })} />Whole numbers</label>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {f.type === 'select' && <Labeled label="Options (comma separated)" className="sm:col-span-2"><Input value={optText} onChange={(e) => { setOptText(e.target.value); upd({ options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }); }} placeholder="todo, doing, done" /></Labeled>}
        {f.type === 'relation' && <Labeled label="Points to"><Select value={f.collection ?? ''} disabled={existing} onChange={(e) => upd({ collection: e.target.value || undefined, default: undefined })}><option value="">Choose…</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Labeled>}
        {f.type === 'number' && <><Labeled label="Minimum"><Input type="number" value={f.min ?? ''} onChange={(e) => upd({ min: e.target.value === '' ? undefined : e.target.valueAsNumber })} /></Labeled><Labeled label="Maximum"><Input type="number" value={f.max ?? ''} onChange={(e) => upd({ max: e.target.value === '' ? undefined : e.target.valueAsNumber })} /></Labeled></>}
        {f.type !== 'json' && f.type !== 'longtext' && <Labeled label="Default"><DefaultInput f={f} set={(v) => upd({ default: v })} /></Labeled>}
      </div>
    </li>
  );
}

export function SettingsDialog({ col, collections, onClose, onSaved, onDeleted }: { col: Collection; collections: Collection[]; onClose: () => void; onSaved: (slug: string) => void; onDeleted: () => void }) {
  const [name, setName] = useState(col.name);
  const [slug, setSlug] = useState(col.slug);
  const [icon, setIcon] = useState(col.icon);
  const [description, setDescription] = useState(col.description);
  const [fields, setFields] = useState<Row[]>(() => rows(col.fields));
  const [access, setAccess] = useState(col.access ?? { view: [], edit: [] });
  const [roles, setRoles] = useState<Choice[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const manage = col.canManage;
  useEffect(() => { if (col.scope === 'team' && manage) trpc.data.roles.query().then(setRoles).catch(() => {}); }, []);

  const targets: Choice[] = [{ id: 'users', name: 'Users' }, ...collections.filter((c) => c.scope === 'personal' ? col.scope === 'personal' : true).map((c) => ({ id: c.id, name: c.id === col.id ? `${c.name} (itself)` : c.name }))];
  const existingIds = new Set(col.fields.map((f) => f.id));
  const removed = col.fields.filter((f) => !fields.some((r) => r.f.id === f.id));
  const renamed = fields.filter((r) => r.f.id && col.fields.find((o) => o.id === r.f.id && o.name !== r.f.name));
  const patch = (k: string, p: Partial<Field>) => setFields((s) => s.map((r) => (r.k === k ? { ...r, f: { ...r.f, ...p } } : r)));
  const level = (id: string) => (access.edit.includes(id) ? 'edit' : access.view.includes(id) ? 'view' : '');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = { name, slug, icon, description };
      if (manage) {
        body.fields = fields.map(({ f }) => Object.fromEntries(Object.entries({ ...f, name: f.name.trim(), collection: f.collection === col.id ? 'self' : f.collection }).filter(([, v]) => v !== undefined && v !== '')));
        if (col.scope === 'team') body.access = access;
      }
      const r = await trpc.data.collections.update.mutate({ collection: col.id, patch: body });
      toast('Saved'); onSaved(r.slug); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <Dialog title={`${col.name} settings`} xl onClose={onClose}
        footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !manage} onClick={save}>Save</Button></>}>
        {!manage && <Alert><AlertDescription>Only someone with data.manage can change this team collection’s schema and access.</AlertDescription></Alert>}
        <Tabs defaultValue="general" className="flex-col">
          <TabsList><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="fields">Fields</TabsTrigger>{col.scope === 'team' && <TabsTrigger value="access">Access</TabsTrigger>}</TabsList>
          <TabsContent value="general" className="mt-4 grid gap-4">
            <Labeled label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!manage} maxLength={80} /></Labeled>
            <div className="grid gap-4 sm:grid-cols-2">
              <Labeled label="Address (slug)"><Input value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!manage} className="font-mono text-xs" /></Labeled>
              <Labeled label="Icon"><Select value={icon} onChange={(e) => setIcon(e.target.value)} disabled={!manage}>{[...new Set([icon, ...ICON_NAMES])].map((n) => <option key={n}>{n}</option>)}</Select></Labeled>
            </div>
            <Labeled label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!manage} maxLength={500} /></Labeled>
            <p className="text-[13px] text-muted-foreground">{col.scope === 'team' ? 'A team collection: shared with the roles chosen under Access. Its records are sealed with the team key.' : 'A personal collection: only you can see it. Its records are sealed with your key.'} The scope cannot change later.</p>
            {manage && <div><Button variant="outline" className={buttonDanger} onClick={() => setDel(true)}><Trash2 aria-hidden />Delete collection</Button></div>}
          </TabsContent>
          <TabsContent value="fields" className="mt-4 grid gap-3">
            {(!!removed.length || !!renamed.length) && (
              <Alert><TriangleAlert aria-hidden /><AlertDescription>
                {!!removed.length && <span>Removing {removed.map((f) => f.name).join(', ')} deletes those values in all {col.records} record{col.records === 1 ? '' : 's'}. </span>}
                {!!renamed.length && <span>Renamed fields keep their values. </span>}
                The change applies to every record when you save; nothing changes if a record would no longer fit.
              </AlertDescription></Alert>)}
            <ul className="grid gap-3">
              {fields.map((r, i) => <FieldRow key={r.k} r={r} existing={!!r.f.id && existingIds.has(r.f.id)} first={i === 0} last={i === fields.length - 1} targets={targets} upd={(p) => patch(r.k, p)}
                move={(d) => setFields((s) => { const n = [...s]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; return n; })} remove={() => setFields((s) => s.filter((x) => x.k !== r.k))} />)}
            </ul>
            {!fields.length && <p className="text-[13px] text-muted-foreground">No fields yet. A record is made of its fields: add the first one.</p>}
            {manage && <div><Button variant="outline" onClick={() => setFields((s) => [...s, ...rows([{ name: '', type: 'text' }])])}><Plus aria-hidden />Add a field</Button></div>}
            <p className="text-xs text-muted-foreground">A field’s type, “several values” and relation target are fixed once it exists: add a new field and delete the old one to change them. Field names are used in filters, so keep them short.</p>
          </TabsContent>
          {col.scope === 'team' && (
            <TabsContent value="access" className="mt-4 grid gap-3">
              <p className="text-[13px] text-muted-foreground">Who may open this collection. People with data.manage always see and change everything.</p>
              {roles.map((r) => (
                <div key={r.id} className="grid grid-cols-[1fr_9rem] items-center gap-3 text-[13px]">
                  <span>{r.name}</span>
                  <Select aria-label={`Access for ${r.name}`} value={level(r.id)} disabled={!manage} onChange={(e) => setAccess((a) => {
                    const view = a.view.filter((x) => x !== r.id), edit = a.edit.filter((x) => x !== r.id), v = e.target.value;
                    return { view: v ? [...view, r.id] : view, edit: v === 'edit' ? [...edit, r.id] : edit };
                  })}><option value="">No access</option><option value="view">Can view</option><option value="edit">Can edit records</option></Select>
                </div>))}
            </TabsContent>)}
        </Tabs>
        <Err>{err}</Err>
      </Dialog>
      {del && <ConfirmDialog title={`Delete “${col.name}”?`} body={`This deletes the collection and its ${col.records} record${col.records === 1 ? '' : 's'} for good.`} action="Delete collection" onClose={() => setDel(false)}
        onConfirm={async () => { try { await trpc.data.collections.delete.mutate({ collection: col.id }); toast('Collection deleted'); onDeleted(); onClose(); } catch (e) { toast((e as Error).message, true); } }} />}
    </>
  );
}
