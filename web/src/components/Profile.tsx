import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '@/ui/button';
import { api, type Me } from './api';
import { Avatar } from './Avatar';
import { authClient, ok } from './auth';
import { Dialog } from './dialogs';
import { describeAgent } from './session-label';
import Shell from './Shell';
import { toast } from './toast';
import { buttonDanger, Err, Field, Input, Page, Row, Section } from './ui';

const refreshMe = () => dispatchEvent(new Event('hefyn-me'));
const TYPES = ['image/png', 'image/jpeg', 'image/webp'], MAX = 256 * 1024; // the server checks the same (src/server/avatar.ts)

export default function Profile() {
  return <Shell>{(me) => (
    <Page title="Profile" hint="How you appear to your team, and how you sign in.">
      <Section title="Account"><Identity me={me} /></Section>
      <Section title="Password"><Password /></Section>
      <Section title="Sessions"><Sessions /></Section>
      <Section title="Danger zone"><Wipe /></Section>
    </Page>)}</Shell>;
}

// Runs an async action with a shared error line.
function useAction() {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setErr(''); setBusy(true); try { await f(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  return { err, busy, run };
}

function Identity({ me }: { me: Me }) {
  const pic = useAction(), nm = useAction();
  const [name, setName] = useState(me.name);
  useEffect(() => setName(me.name), [me.name]);
  const save = (image: string | null) => pic.run(async () => { await ok(authClient.updateUser({ image }), 'Could not save the picture.'); refreshMe(); toast(image ? 'Picture saved' : 'Picture removed'); });
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!TYPES.includes(f.type)) return void pic.run(async () => { throw new Error('Use a PNG, JPEG or WebP image.'); });
    if (f.size > MAX) return void pic.run(async () => { throw new Error('That image is too large. Keep it under 256 KB.'); });
    const r = new FileReader();
    r.onload = () => void save(r.result as string);
    r.readAsDataURL(f);
  };
  return (<>
    <Row title="Picture" hint="PNG, JPEG or WebP, 256 KB at most." wide>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={me.name} image={me.image} size={56} />
        <Button variant="outline" size="sm" render={<label />} nativeButton={false}>Choose picture<input type="file" accept={TYPES.join(',')} className="sr-only" aria-label="Choose picture" disabled={pic.busy} onChange={pick} /></Button>
        {me.image && <Button variant="ghost" size="sm" disabled={pic.busy} onClick={() => void save(null)}>Remove</Button>}
      </div>
      <div className="mt-2"><Err>{pic.err}</Err></div>
    </Row>
    <Row title="Name" hint="Shown in the sidebar and to other people on your team.">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void nm.run(async () => { await ok(authClient.updateUser({ name: name.trim() }), 'Could not save the name.'); refreshMe(); toast('Name saved'); }); }}>
        <Input aria-label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
        <Button type="submit" disabled={nm.busy || !name.trim() || name.trim() === me.name}>Save</Button>
      </form>
      <div className="mt-2"><Err>{nm.err}</Err></div>
    </Row>
    <Row title="Email" hint="Ask an admin to change your email."><span className="text-[13px]">{me.email}</span></Row>
  </>);
}

function Password() {
  const a = useAction();
  const [others, setOthers] = useState(true);
  return (
    <Row title="Change password" hint="Use at least 8 characters." wide>
      <form className="grid max-w-sm gap-3" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const v = new FormData(form);
        void a.run(async () => {
          if (v.get('next') !== v.get('again')) throw new Error('The new passwords do not match.');
          await ok(authClient.changePassword({ currentPassword: String(v.get('current')), newPassword: String(v.get('next')), revokeOtherSessions: others }), 'Could not change the password. Check the current one.');
          toast('Password changed'); form.reset();
        }); }}>
        <Field label="Current password"><Input name="current" type="password" required autoComplete="current-password" /></Field>
        <Field label="New password"><Input name="next" type="password" required minLength={8} autoComplete="new-password" /></Field>
        <Field label="New password again"><Input name="again" type="password" required minLength={8} autoComplete="new-password" /></Field>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />Sign out my other devices</label>
        <Err>{a.err}</Err>
        <div><Button type="submit" disabled={a.busy}>Change password</Button></div>
      </form>
    </Row>
  );
}

interface Sess { id: string; token: string; userAgent?: string | null; updatedAt: string | Date }

function Sessions() {
  const a = useAction();
  const [list, setList] = useState<Sess[]>();
  const [here, setHere] = useState('');
  const load = () => a.run(async () => {
    const [s, cur] = await Promise.all([ok(authClient.listSessions(), 'Could not load your sessions.'), authClient.getSession()]);
    setHere(cur.data?.session.token ?? ''); setList(s as Sess[]);
  });
  useEffect(() => { void load(); }, []);
  const out = (token: string) => a.run(async () => { await ok(authClient.revokeSession({ token })); await load(); toast('Signed out'); });
  const others = (list ?? []).filter((s) => s.token !== here).length;
  return (<>
    {list?.sort((x, y) => +(y.token === here) - +(x.token === here)).map((s) => (
      <Row key={s.id} title={<span>{describeAgent(s.userAgent)}{s.token === here && <span className="ml-2 text-xs font-normal text-muted-foreground">This browser</span>}</span>}
        hint={`Last active ${new Date(s.updatedAt).toLocaleString()}`}>
        {s.token !== here && <Button variant="outline" size="sm" disabled={a.busy} onClick={() => void out(s.token)}>Sign out</Button>}
      </Row>))}
    <div className="flex items-center gap-3 py-4">
      <Button variant="outline" disabled={a.busy || !others} onClick={() => void a.run(async () => { await ok(authClient.revokeOtherSessions()); await load(); toast('Signed out everywhere else'); })}>Sign out everywhere else</Button>
      <Err>{a.err}</Err>
    </div>
  </>);
}

// "Start fresh" (src/server/security-routes.ts /reset-data): deletes the user's sealed data (chats, connections, tokens, module rows); the account stays.
function Wipe() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const a = useAction();
  return (<>
    <Row title="Delete my data" hint="Deletes your chats, saved connections and other data stored in hefyn. Your account stays and you get a new recovery key. This cannot be undone."><Button className={buttonDanger} variant="outline" onClick={() => setOpen(true)}>Delete my data…</Button></Row>
    {open && <Dialog title="Delete my data" onClose={() => { setOpen(false); setKey(''); }}>
      {key ? (
        <div className="grid gap-3">
          <p className="text-[13px]">Your data is deleted. Save your new recovery key somewhere safe. It is shown only now.</p>
          <code className="rounded-lg border border-border p-3 font-mono text-[13px] break-all">{key}</code>
          <div><Button onClick={() => navigator.clipboard?.writeText(key).then(() => toast('Copied'))}>Copy key</Button></div>
        </div>
      ) : (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget);
          void a.run(async () => { const r = await api<{ recoveryKey: string }>('/api/security/reset-data', 'POST', { password: v.get('password'), confirm: v.get('confirm') }); setKey(r.recoveryKey); }); }}>
          <p className="text-[13px]">This removes everything you have stored in hefyn. Type <b>DELETE MY DATA</b> and your password to confirm.</p>
          <Field label="Password"><Input name="password" type="password" required autoComplete="current-password" /></Field>
          <Field label="Type DELETE MY DATA"><Input name="confirm" required autoComplete="off" /></Field>
          <Err>{a.err}</Err>
          <div><Button type="submit" className={buttonDanger} variant="outline" disabled={a.busy}>Delete my data</Button></div>
        </form>)}
    </Dialog>}
  </>);
}
