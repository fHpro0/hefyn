import { Cloud, Eye, EyeOff, Plug, Server, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Dialog } from './dialogs';
import { type ConnField, type ConnSummary, KIND_INFO, plainError, splitForm, summarySentence } from './conn-helpers';
import { when } from './files-client';
import { toast } from './toast';
import { Err, Field, Input, Select, Switch } from './ui';

export type Conn = Awaited<ReturnType<typeof trpc.connections.list.query>>[number];
type Kind = Awaited<ReturnType<typeof trpc.connections.kinds.query>>[number];

export const KIND_ICON: Record<string, LucideIcon> = { webdav: Cloud, sftp: Server, ftp: Server, mcp: Plug };
const msg = (e: unknown) => plainError((e as Error).message);

/** Sync now with a toast; resolves when the run is over. */
export async function syncNow(c: Conn, after: () => void) {
  try { const s = await trpc.connections.syncNow.mutate({ id: c.id }); toast(`${c.name}: ${summarySentence(s)}`); } catch (e) { toast(msg(e), true); }
  after();
}

export async function testConn(c: Conn) {
  try { const t = await trpc.connections.test.mutate({ id: c.id }); if (t.ok) toast(`${c.name} works${t.readonly ? ' (read only)' : ''}`); else toast(plainError(t.error ?? 'Could not connect'), true); } catch (e) { toast(msg(e), true); }
}

function Secret({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" className="pr-9" />
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`${show ? 'Hide' : 'Show'} ${label}`} className="absolute top-1/2 right-1.5 -translate-y-1/2" onClick={() => setShow(!show)}>{show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}</Button>
    </div>
  );
}

/** Connect storage (no `edit`: choose a kind, then the form) or Edit connection (prefilled, with the last sync). */
export function ConnectDialog({ edit, onClose, onDone, onRemove }: { edit?: Conn; onClose: () => void; onDone: () => void; onRemove?: () => void }) {
  const [kinds, setKinds] = useState<Kind[]>();
  const [kind, setKind] = useState<string | undefined>(edit?.kind);
  const [name, setName] = useState(edit?.name ?? '');
  const [root, setRoot] = useState(edit?.remoteRoot ?? '');
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(edit?.config ?? {}).map(([k, v]) => [k, String(v ?? '')])));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState<string>();
  useEffect(() => { trpc.connections.kinds.query().then(setKinds).catch((e) => setErr(msg(e))); }, []);
  const k = kinds?.find((x) => x.kind === kind);
  const fields = (k?.fields ?? []) as ConnField[];
  // selects start on their first option, as the server would otherwise ask for one
  const val = (f: ConnField) => vals[f.name] ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : '');
  const set = (n: string, v: string) => setVals((o) => ({ ...o, [n]: v }));
  const label = k?.label ?? 'storage';

  async function submit() {
    setErr(''); setBusy(true);
    const { config, secrets } = splitForm(fields, Object.fromEntries(fields.map((f) => [f.name, val(f)])));
    try {
      if (edit) {
        await trpc.connections.update.mutate({ id: edit.id, name: name.trim(), config, secrets, remoteRoot: root.trim() });
        toast(`Saved ${name.trim()}`); onDone(); onClose();
      } else {
        const c = await trpc.connections.create.mutate({ kind: kind!, name: name.trim(), config, secrets, remoteRoot: root.trim() || undefined });
        toast(`Connected ${c.name} — syncing now`); onDone();
        void syncNow(c, onDone);
        if (c.kind === 'sftp' && c.hostKey) setPinned(c.hostKey); else onClose();
      }
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }

  if (pinned) return (
    <Dialog title="Connected" onClose={onClose} wide footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-sm">Server identity saved: <code className="break-all text-[13px]">{pinned}</code></p>
      <p className="text-[13px] text-muted-foreground">Compare it with the fingerprint your server shows. If it ever changes, hefyn refuses to connect.</p>
    </Dialog>
  );

  if (!kind) return (
    <Dialog title="Connect storage" onClose={onClose} wide footer={<Button variant="outline" onClick={onClose}>Cancel</Button>}>
      <p className="text-[13px] text-muted-foreground">Pick where your files live. They show up as a folder in My files.</p>
      <Err>{err}</Err>
      <div className="grid gap-2 sm:grid-cols-2">
        {kinds?.map((x) => { const Icon = KIND_ICON[x.kind] ?? Cloud, info = KIND_INFO[x.kind]; return (
          <button key={x.kind} type="button" onClick={() => setKind(x.kind)} className="grid gap-1 rounded-lg border p-3 text-left hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex items-center gap-2 text-sm font-medium"><Icon size={16} aria-hidden className="text-muted-foreground" />{info?.title ?? x.label}</span>
            <span className="text-[13px] text-muted-foreground">{info?.blurb ?? x.label}</span>
          </button>); })}
      </div>
    </Dialog>
  );

  const ready = !!name.trim() && fields.every((f) => !f.required || (f.type === 'secret' ? !!vals[f.name] || edit?.secretsSet.includes(f.name) : !!val(f).trim()));
  const s = edit?.lastSummary as ConnSummary | null | undefined;
  return (
    <Dialog title={edit ? `Edit ${edit.name}` : `Connect ${KIND_INFO[kind]?.title ?? label}`} onClose={onClose} wide
      footer={<>
        {edit && onRemove && <Button variant="ghost" className="mr-auto text-danger-ink" onClick={onRemove}>Remove</Button>}
        {!edit && <Button variant="ghost" className="mr-auto" onClick={() => { setKind(undefined); setErr(''); }}>Back</Button>}
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !ready} onClick={() => void submit()}>{busy ? 'Connecting…' : edit ? 'Save' : 'Connect'}</Button>
      </>}>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
        {edit && (
          <div className="grid gap-1 rounded-lg bg-foreground/[0.05] p-3 text-[13px]">
            <span className="font-medium">Last sync{edit.lastSyncAt ? ` · ${when(edit.lastSyncAt)}` : ''}</span>
            <span>{s ? summarySentence(s) : 'Not synced yet'}</span>
            {s?.errors.slice(0, 3).map((x, i) => <span key={i} className="text-danger-ink">{x}</span>)}
            {edit.lastError && <span className="text-danger-ink">Last error: {edit.lastError}</span>}
          </div>)}
        {fields.map((f) => {
          const lab = <>{f.label}{f.required && !(f.type === 'secret' && edit?.secretsSet.includes(f.name)) && <span aria-hidden className="text-danger-ink"> *</span>}</>;
          return (
            <div key={f.name} className="grid gap-1">
              <Field label={lab}>
                {f.type === 'select' ? <Select value={val(f)} onChange={(e) => set(f.name, e.target.value)}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                  : f.type === 'secret' ? <Secret label={f.label} value={vals[f.name] ?? ''} onChange={(v) => set(f.name, v)} placeholder={edit?.secretsSet.includes(f.name) ? 'Saved — leave blank to keep' : undefined} />
                  : <Input type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'} value={val(f)} onChange={(e) => set(f.name, e.target.value)} autoComplete="off" />}
              </Field>
              {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
            </div>);
        })}
        <Field label="Remote folder (optional)"><Input value={root} placeholder="Top level" onChange={(e) => setRoot(e.target.value)} autoComplete="off" /></Field>
        <div className="grid gap-1">
          <Field label={<>Folder name <span aria-hidden className="text-danger-ink">*</span></>}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nextcloud" autoComplete="off" /></Field>
          <span className="text-xs text-muted-foreground">{edit ? <>The folder stays <code>/files/{edit.folder}</code></> : <>Appears as <code>/files/{name.trim() || '…'}</code></>}</span>
        </div>
        <p className="text-[13px] text-muted-foreground">hefyn keeps this folder in sync both ways. Your agents can use it like any other folder. If both sides change a file, you keep both copies.</p>
        <Err>{err}</Err>
      </form>
    </Dialog>
  );
}

export function RemoveDialog({ conn, onClose, onDone }: { conn: Conn; onClose: () => void; onDone: () => void }) {
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Remove ${conn.name}?`} onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button disabled={busy} className="bg-destructive text-background hover:bg-destructive/90" onClick={async () => {
        setBusy(true);
        try { await trpc.connections.delete.mutate({ id: conn.id, keepLocalCopy: keep }); toast(`Removed ${conn.name}`); onDone(); onClose(); } catch (e) { toast(msg(e), true); setBusy(false); }
      }}>Remove</Button></>}>
      <p className="text-[13px] text-muted-foreground">The files on the server are never touched. hefyn just stops syncing.</p>
      <label className="flex items-center justify-between gap-3 text-sm"><span>Keep a local copy of the files</span><Switch checked={keep} onChange={setKeep} label="Keep a local copy of the files" /></label>
      {!keep && <p className="text-[13px] text-danger-ink">The folder /files/{conn.folder} and everything in it will be deleted from hefyn.</p>}
    </Dialog>
  );
}
