import { HardDrive } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { useQuery } from './api';
import { CopyButton } from './copy';
import { ConfirmDialog, Dialog } from './dialogs';
import Shell from './Shell';
import { toast } from './toast';
import { Chip, Empty, Err, Field, Input, Loading, Page, Reveal, Row, Section, Switch } from './ui';

export default function ConnectedApps() {
  return <Shell>{(me) => <Content email={me.email} />}</Shell>;
}

type Pw = Awaited<ReturnType<typeof trpc.appPasswords.list.query>>[number];
const day = (iso: string) => new Date(iso).toLocaleDateString();
const Code = ({ children }: { children: string }) => <code className="font-mono text-foreground select-all">{children}</code>;

function Content({ email }: { email: string }) {
  const { data, error, reload } = useQuery(() => trpc.appPasswords.list.query());
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string>();
  const [revoke, setRevoke] = useState<Pw>();
  const [err, setErr] = useState('');
  const url = `${location.origin}/dav/`;
  const host = location.host;
  return (
    <Page title="Connected apps" hint="Reach your files from other apps on your computer or phone.">
      <Section title="Access your files from other apps">
        <Row title="WebDAV address" hint="Sign in with your email and an app password (not your account password).">
          <div className="flex items-center gap-1"><Code>{url}</Code><CopyButton text={url} label="Copy address" /></div>
          <p className="mt-1 text-[13px] text-muted-foreground">Username: <Code>{email}</Code></p>
        </Row>
        <Row title="How to connect" wide>
          <ul className="grid gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
            <li><b className="font-medium text-foreground">Mac Finder:</b> Go, Connect to Server, enter the address.</li>
            <li><b className="font-medium text-foreground">Windows:</b> Map network drive, folder <Code>{`\\\\${host.replace(/:.*/, '')}@SSL\\dav`}</Code> or the https address. Needs https.</li>
            <li><b className="font-medium text-foreground">Nextcloud, Cyberduck, WinSCP, rclone:</b> choose WebDAV with https and the address above.</li>
          </ul>
        </Row>
      </Section>
      <Section title="App passwords">
        <Reveal loading={!data && !error} fallback={<Loading shape="rows" n={2} />}>
          {data?.map((p) => (
            <Row key={p.id} title={<>{p.name} <Chip tone={p.write ? 'caution' : 'neutral'}>{p.write ? 'Read and write' : 'Read only'}</Chip></>}
              hint={<>Starts with <span className="font-mono">{p.prefix}</span> · created {day(p.createdAt)} · last used {p.lastUsedAt ? day(p.lastUsedAt) : 'never'}</>}>
              <Button type="button" size="sm" variant="outline" onClick={() => setRevoke(p)}>Revoke</Button>
            </Row>
          ))}
          {data && !data.length && <Empty icon={<HardDrive />}>No app password yet.</Empty>}
        </Reveal>
        <div className="py-3"><Button type="button" onClick={() => setCreating(true)}>Create app password</Button></div>
      </Section>
      <Err>{error || err}</Err>
      {creating && <Create onClose={() => setCreating(false)} onDone={(pw) => { setCreating(false); setShown(pw); void reload(); }} />}
      {shown && (
        <Dialog title="Your app password" onClose={() => setShown(undefined)} footer={<Button onClick={() => setShown(undefined)}>Done</Button>}>
          <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-3 py-2"><Code>{shown}</Code><CopyButton text={shown} label="Copy password" /></div>
          <p className="text-[13px] text-muted-foreground">You won’t see it again. Paste it into the other app now; if you lose it, revoke it and make a new one.</p>
        </Dialog>
      )}
      {revoke && <ConfirmDialog title={`Revoke ${revoke.name}?`} body="Apps using this password lose access to your files right away." action="Revoke"
        onConfirm={() => { const p = revoke; setRevoke(undefined); trpc.appPasswords.revoke.mutate({ id: p.id }).then(() => { toast('Revoked.'); void reload(); }, (e) => setErr((e as Error).message)); }} onClose={() => setRevoke(undefined)} />}
    </Page>
  );
}

function Create({ onClose, onDone }: { onClose: () => void; onDone: (password: string) => void }) {
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(''); setBusy(true);
    try { onDone((await trpc.appPasswords.create.mutate({ name, write })).password); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Create app password" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || busy} onClick={go}>Create</Button></>}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook Finder" maxLength={64} autoFocus /></Field>
        <label className="flex items-center gap-2 text-[13px]"><Switch label="Allow changes" checked={write} onChange={setWrite} />Allow changes (add, edit and delete files)</label>
      </form>
      <Err>{err}</Err>
    </Dialog>
  );
}
