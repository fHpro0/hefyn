import { KeyRound, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Me } from './api';
import { authClient, ok } from './auth';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { ConfirmDialog } from './dialogs';
import { toast } from './toast';
import { buttonDanger, Empty, Err, Field, Input, Loading, Page, Reveal, Row, Section } from './ui';

const refreshMe = () => dispatchEvent(new Event('hefyn-me'));

export default function Security() {
  return <Shell>{(me) => <Content me={me} />}</Shell>;
}

function Content({ me }: { me: Me }) {
  return (
    <Page title="Security" hint="Protect your account with a second step at sign-in and with passkeys.">
      {me.twoFactorSetupRequired && (
        <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
          <ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
          <p>Your admin requires two-factor authentication. Turn it on below to keep using hefyn.</p>
        </div>
      )}
      {me.passwordChangeRequired && (
        <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
          <ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
          <p>Choose your own password. Your admin set the current one, so it cannot protect your encrypted data. Use the temporary password as the current one below.</p>
        </div>
      )}
      <Section title="Password"><PasswordRow reload={!!me.passwordChangeRequired} /></Section>
      <Section title="Two-factor authentication"><TwoFactor me={me} /></Section>
      <Section title="Passkeys"><Passkeys /></Section>
    </Page>
  );
}

// Runs an async action with a shared error line.
function useAction() {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setErr(''); setBusy(true); try { await f(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  return { err, setErr, busy, run };
}

function PasswordRow({ reload }: { reload: boolean }) {
  const a = useAction();
  return (
    <Row title="Change password" hint="Other devices are signed out.">
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const v = new FormData(form);
        a.run(async () => {
          await ok(authClient.changePassword({ currentPassword: String(v.get('current')), newPassword: String(v.get('next')), revokeOtherSessions: true }), 'Could not change the password. Check the current one.');
          toast('Password changed'); form.reset();
          if (reload) location.reload(); // the 'choose your own password' notice goes away
        }); }}>
        <Field label="Current password"><Input name="current" type="password" required autoComplete="current-password" /></Field>
        <Field label="New password"><Input name="next" type="password" required minLength={8} autoComplete="new-password" /></Field>
        <Err>{a.err}</Err>
        <div><Button type="submit" disabled={a.busy}>Change password</Button></div>
      </form>
    </Row>
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="grid gap-3">
      <p className="text-[13px]">Save these backup codes somewhere safe. Each works once if you lose your authenticator. They are shown only now.</p>
      <ul className="grid grid-cols-2 gap-1 rounded-lg border border-border p-3 font-mono text-[13px]">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied'))}>Copy codes</Button>
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function TwoFactor({ me }: { me: Me }) {
  const a = useAction();
  const [setup, setSetup] = useState<{ uri: string; qr: string; codes: string[] }>();
  const [codes, setCodes] = useState<string[]>();
  const [confirm, setConfirm] = useState<'disable' | 'regen'>();
  const pw = (form: HTMLFormElement) => String(new FormData(form).get('password'));

  if (codes) return <Row title="Backup codes"><Codes codes={codes} onDone={() => { setCodes(undefined); refreshMe(); }} /></Row>;
  if (setup) {
    const secret = new URL(setup.uri).searchParams.get('secret') ?? '';
    return (
      <Row title="Set up an authenticator app" hint="Scan the code with an authenticator app, then enter the 6-digit code it shows.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const code = String(new FormData(e.currentTarget).get('code'));
          a.run(async () => { await ok(authClient.twoFactor.verifyTotp({ code }), 'That code is not right. Check it and try again.'); setCodes(setup.codes); setSetup(undefined); }); }}>
          <img src={setup.qr} alt="QR code for the authenticator app" width={176} height={176} className="rounded-lg bg-white p-2" />
          <p className="text-[13px] text-muted-foreground">Cannot scan? Enter this key by hand: <code className="font-mono break-all text-foreground select-all">{secret}</code></p>
          <Field label="6-digit code"><Input name="code" required autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} /></Field>
          <Err>{a.err}</Err>
          <div className="flex gap-2"><Button type="submit" disabled={a.busy}>Turn on</Button><Button type="button" variant="outline" onClick={() => setSetup(undefined)}>Cancel</Button></div>
        </form>
      </Row>
    );
  }
  const pwForm = (label: string, danger: boolean, submit: (password: string) => Promise<void>) => (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const p = pw(e.currentTarget); a.run(async () => submit(p)); }}>
      <Field label="Your password"><Input name="password" type="password" required autoComplete="current-password" /></Field>
      <Err>{a.err}</Err>
      <div><Button type="submit" variant={danger ? 'outline' : 'default'} className={danger ? buttonDanger : undefined} disabled={a.busy}>{label}</Button></div>
    </form>
  );
  return me.twoFactorEnabled ? (
    <>
      <Row title="Authenticator app is on" hint="You enter a code from your app after your password.">
        {confirm === 'disable' ? pwForm('Turn off two-factor', true, async (password) => {
          await ok(authClient.twoFactor.disable({ password }), 'Could not turn off. Check your password.'); toast('Two-factor turned off'); refreshMe();
        }) : <Button variant="outline" className={buttonDanger} onClick={() => { a.setErr(''); setConfirm('disable'); }}>Turn off…</Button>}
      </Row>
      <Row title="Backup codes" hint="Making new codes invalidates the old ones.">
        {confirm === 'regen' ? pwForm('Make new codes', false, async (password) => {
          const r = await ok(authClient.twoFactor.generateBackupCodes({ password }), 'Could not make new codes. Check your password.'); setCodes(r.backupCodes); setConfirm(undefined);
        }) : <Button variant="outline" onClick={() => { a.setErr(''); setConfirm('regen'); }}>Make new backup codes…</Button>}
      </Row>
    </>
  ) : (
    <Row title="Authenticator app" hint="Use an app such as 1Password, Authy or Google Authenticator.">
      {pwForm('Set up', false, async (password) => {
        const r = await ok(authClient.twoFactor.enable({ password }), 'Could not start setup. Check your password.');
        if (r.method !== 'totp') throw new Error('Could not start setup.');
        setSetup({ uri: r.totpURI, qr: await (await import('qrcode')).default.toDataURL(r.totpURI, { margin: 0, width: 176 }), codes: r.backupCodes });
      })}
    </Row>
  );
}

interface Pk { id: string; credentialID: string; name?: string | null; createdAt: string | Date }

function Passkeys() {
  const a = useAction();
  const [list, setList] = useState<Pk[]>();
  const [del, setDel] = useState<Pk>();
  const load = () => authClient.passkey.listUserPasskeys().then((r) => setList((r.data as Pk[] | null) ?? [])).catch(() => setList([]));
  useEffect(() => void load(), []);
  const supported = typeof PublicKeyCredential !== 'undefined';
  let body: ReactNode;
  if (list && !list.length) body = <Empty icon={<KeyRound size={26} />}>No passkeys yet.</Empty>;
  else body = (
    <ul>{list?.map((p) => (
      <li key={p.id} className="flex items-center gap-2 border-b border-border py-2">
        <form className="flex grow items-center gap-2" onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name'));
          a.run(async () => { await ok(authClient.passkey.updatePasskey({ id: p.id, name })); toast('Passkey renamed'); await load(); }); }}>
          <Input aria-label="Passkey name" name="name" defaultValue={p.name ?? 'Passkey'} required className="max-w-56" />
          <Button type="submit" variant="outline">Rename</Button>
          <span className="ml-auto text-[13px] text-muted-foreground">Added {new Date(p.createdAt).toLocaleDateString()}</span>
        </form>
        <Button variant="outline" className={buttonDanger} onClick={() => setDel(p)}>Delete</Button>
      </li>))}</ul>
  );
  return (
    <>
      <Row title="Your passkeys" hint="Sign in with your fingerprint, face or a security key instead of typing. A passkey is an extra way in; it does not replace two-factor.">
        {supported ? <Reveal loading={!list} fallback={<Loading shape="rows" n={1} />}>{body}</Reveal> : <p className="text-[13px] text-muted-foreground">This browser does not support passkeys.</p>}
        <Err>{a.err}</Err>
        {supported && <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const name = String(new FormData(form).get('name'));
          a.run(async () => {
            const r = await authClient.passkey.addPasskey({ name: name || undefined });
            if (r?.error) throw new Error('Could not add the passkey. It may have been cancelled, or this address does not match the one set for hefyn.');
            toast('Passkey added'); form.reset(); await load();
          }); }}>
          <Input aria-label="Name for the new passkey" name="name" placeholder="Name, e.g. Work laptop" className="max-w-56" />
          <Button type="submit" disabled={a.busy}>Add a passkey</Button>
        </form>}
      </Row>
      {del && <ConfirmDialog title="Delete this passkey?" body={`"${del.name ?? 'Passkey'}" can no longer be used to sign in.`} action="Delete" onClose={() => setDel(undefined)}
        onConfirm={() => a.run(async () => { await ok(authClient.passkey.deletePasskey({ id: del.id })); toast('Passkey deleted'); await load(); })} />}
    </>
  );
}
