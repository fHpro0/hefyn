import { Mail as MailIcon, Pencil, Plus, Power, Send, Trash2 } from 'lucide-react';
import { MenuArea } from './AppMenu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { useState } from 'react';
import { useQuery } from './api';
import { trpc } from '@/lib/trpc';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { ConfirmDialog, Dialog } from './dialogs';
import { toast } from './toast';
import { buttonDanger, Empty, Err, Field, Input, Page, Row, Section, Switch } from './ui';

type Channel = Awaited<ReturnType<typeof trpc.mail.list.query>>[number];

// The SMTP server hefyn sends system mail through (password resets, invites). Stored as the one system `channels` row.
export default function Mail() {
  return <Shell>{() => <Content />}</Shell>;
}

function Content() {
  const { data, reload } = useQuery(() => trpc.mail.list.query());
  const [edit, setEdit] = useState<Channel | 'new'>();
  const [del, setDel] = useState<Channel>();
  const [test, setTest] = useState<Channel>();
  const c = data?.find((x) => x.system) ?? data?.[0];
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); ok && toast(ok); } catch (x) { toast((x as Error).message, true); } reload(); };
  return (
    <Page title="Mail" hint="The mail server hefyn uses for system mail: password-reset links and invites. Nothing else is sent."
      actions={!c && data && <Button variant="outline" onClick={() => setEdit('new')}><Plus size={14} aria-hidden />Set up mail (SMTP)</Button>}>
      <Section title="Mail server">
        {data && !c && <Empty icon={<MailIcon size={20} aria-hidden />}>No mail server yet. Without one, you share temporary passwords directly and there is no password-reset link.</Empty>}
        {c && (<MenuArea items={() => <>
            <DropdownMenuItem className="text-[13px]" onClick={() => setTest(c)}><Send size={15} strokeWidth={1.75} aria-hidden />Send test</DropdownMenuItem>
            <DropdownMenuItem className="text-[13px]" onClick={() => setEdit(c)}><Pencil size={15} strokeWidth={1.75} aria-hidden />Edit</DropdownMenuItem>
            <DropdownMenuItem className="text-[13px]" onClick={() => run(() => trpc.mail.update.mutate({ id: c.id, enabled: !c.enabled }))}><Power size={15} strokeWidth={1.75} aria-hidden />{c.enabled ? 'Turn off' : 'Turn on'}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[13px]" variant="destructive" onClick={() => setDel(c)}><Trash2 size={15} strokeWidth={1.75} aria-hidden />Remove…</DropdownMenuItem></>}>
          <Row title={<span className="flex flex-wrap items-center gap-2">{c.config.host}:{c.config.port}</span>} hint={`From ${c.config.from}`}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Switch label="Send system mail" checked={c.enabled} onChange={(on) => run(() => trpc.mail.update.mutate({ id: c.id, enabled: on }))} />
              <Button variant="outline" onClick={() => setTest(c)}>Send test</Button>
              <Button variant="outline" size="icon" aria-label="Edit mail server" onClick={() => setEdit(c)}><Pencil size={14} aria-hidden /></Button>
              <Button variant="outline" size="icon" className={buttonDanger} aria-label="Remove mail server" onClick={() => setDel(c)}><Trash2 size={14} aria-hidden /></Button>
            </div>
          </Row></MenuArea>
        )}
      </Section>
      {edit && <EditDialog init={edit === 'new' ? undefined : edit} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); reload(); }} />}
      {test && <TestDialog ch={test} onClose={() => setTest(undefined)} />}
      {del && <ConfirmDialog title="Remove the mail server?" body="Password-reset links and invite emails stop working until you set one up again." action="Remove" onClose={() => setDel(undefined)} onConfirm={() => run(() => trpc.mail.delete.mutate({ id: del.id }),'Mail server removed')} />}
    </Page>
  );
}

function EditDialog({ init, onClose, onSaved }: { init?: Channel; onClose: () => void; onSaved: () => void }) {
  const [err, setErr] = useState('');
  const c = init?.config ?? {};
  const [secure, setSecure] = useState(!!c.secure);
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? '');
    const body = { config: { host: g('host'), port: Number(g('port')), secure, username: g('username'), from: g('from'), fromName: g('fromName') }, secret: g('secret') || undefined };
    try { await (init ? trpc.mail.update.mutate({ id: init.id, ...body }) : trpc.mail.create.mutate(body)); onSaved(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Dialog title={`${init ? 'Edit' : 'Set up'} mail (SMTP)`} wide onClose={onClose}>
      <form className="grid gap-3" onSubmit={save}>
        <div className="grid grid-cols-[1fr_6rem] gap-3"><Field label="Host"><Input name="host" defaultValue={c.host} required /></Field><Field label="Port"><Input name="port" type="number" defaultValue={c.port ?? 587} required /></Field></div>
        <label className="flex items-center gap-2 text-[13px]"><Switch label="TLS from the start (port 465)" checked={secure} onChange={setSecure} />TLS from the start (port 465)</label>
        <Field label="Username"><Input name="username" defaultValue={c.username} autoComplete="off" /></Field>
        <Field label="Password"><Input name="secret" type="password" placeholder={init?.hasSecret ? '••• saved' : ''} autoComplete="new-password" /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="From address"><Input name="from" type="email" defaultValue={c.from} required /></Field><Field label="From name"><Input name="fromName" defaultValue={c.fromName} /></Field></div>
        <Err>{err}</Err>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Save</Button></div>
      </form>
    </Dialog>
  );
}

function TestDialog({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Send a test mail" onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await trpc.mail.test.mutate({ id: ch.id, to: String(new FormData(e.currentTarget).get('to')) }); toast('Test mail sent'); onClose(); } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <Field label="Send to (email address)"><Input name="to" required autoFocus /></Field>
        <Err>{err}</Err>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>Send test</Button></div>
      </form>
    </Dialog>
  );
}
