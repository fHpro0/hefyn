import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { authClient, ok } from './auth';
import { AuthLayout, authMessage, useErr } from './Setup';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { Field, Input } from './ui';

const done = () => { location.href = '/'; };

async function passkeySignIn(autoFill: boolean): Promise<boolean> {
  const r = await authClient.signIn.passkey({ autoFill }) as any;
  return !!r?.data;
}

export default function Login() {
  const e = useErr();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'password' | 'code' | 'backup'>('password');
  const [mail, setMail] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); e.setErr(''); try { await f(); } catch (x) { e.setErr((x as Error).message); setBusy(false); } };

  useEffect(() => {
    localStorage.removeItem('hefyn-modules'); // the cached nav belongs to whoever was signed in before
    trpc.setup.status.query().then((s) => { if (s.needsSetup) location.href = '/setup'; setMail(s.mailConfigured); }).catch(() => {});
    // Conditional UI: the browser offers saved passkeys in the email field's autofill list.
    if (typeof PublicKeyCredential !== 'undefined' && PublicKeyCredential.isConditionalMediationAvailable) {
      PublicKeyCredential.isConditionalMediationAvailable().then((yes) => { if (yes) return passkeySignIn(true).then((ok) => { if (ok) done(); }); }).catch(() => {});
    }
  }, []);

  if (step !== 'password') {
    const backup = step === 'backup';
    return (
      <AuthLayout title="Two-factor code" hint={backup ? 'Enter one of your backup codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}>
        <form onSubmit={(ev) => { ev.preventDefault(); const code = String(new FormData(ev.currentTarget).get('code')).trim();
          run(async () => {
            await ok(backup ? authClient.twoFactor.verifyBackupCode({ code }) : authClient.twoFactor.verifyTotp({ code }), 'That code is not right. Check it and try again.');
            done();
          }); }}>
          <FieldGroup className="gap-4">
            <Field label={backup ? 'Backup code' : 'Code'}>
              <Input key={step} name="code" required autoFocus aria-describedby={e.describedBy} autoComplete={backup ? 'off' : 'one-time-code'} inputMode={backup ? 'text' : 'numeric'} pattern={backup ? undefined : '[0-9]{6}'} maxLength={backup ? 20 : 6} />
            </Field>
            {e.node}
            <Button type="submit" className="w-full" disabled={busy}>Verify</Button>
            <Button type="button" variant="link" className="h-auto self-start p-0 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => { e.setErr(''); setStep(backup ? 'code' : 'backup'); }}>{backup ? 'Use an authenticator code' : 'Use a backup code'}</Button>
          </FieldGroup>
        </form>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Sign in" hint="Use the account your admin set up for you.">
      <form onSubmit={(ev) => { ev.preventDefault(); const v = Object.fromEntries(new FormData(ev.currentTarget) as any);
        run(async () => {
          const r = await authClient.signIn.email({ email: v.email, password: v.password });
          if (r.error) throw new Error(r.error.status === 403 && /forbidden|origin/i.test(r.error.message ?? r.error.statusText ?? 'forbidden') ? authMessage('Forbidden') : r.error.status === 429 ? 'Too many attempts. Wait a moment and try again.'
            : r.error.status && r.error.status >= 500 ? 'hefyn is not reachable right now. Try again in a moment.' // a server error is not a wrong password
            : 'That email or password is not right. Check them and try again.');
          if ((r.data as any)?.twoFactorRedirect) { setStep('code'); setBusy(false); return; }
          done();
        }); }}>
        <FieldGroup className="gap-4">
          <Field label="Email"><Input name="email" type="email" required autoComplete="username webauthn" aria-describedby={e.describedBy} /></Field>
          <Field label="Password"><Input name="password" type="password" required autoComplete="current-password" aria-describedby={e.describedBy} /></Field>
          {e.node}
          <Button type="submit" className="w-full" disabled={busy}>Sign in</Button>
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => run(async () => {
            if (!(await passkeySignIn(false))) throw new Error('Passkey sign-in did not work. Try again or use your password.');
            done();
          })}><KeyRound size={14} aria-hidden />Sign in with a passkey</Button>
          {mail && <Button variant="link" className="h-auto self-start p-0 text-[13px] text-muted-foreground hover:text-foreground" render={<a href="/forgot-password" />} nativeButton={false}>Forgot your password?</Button>}
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
