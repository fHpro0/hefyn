import { useState } from 'react';
import { authClient } from './auth';
import { AuthLayout } from './Setup';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { Field, Input } from './ui';

export default function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title="Forgot your password?" hint="Enter your email. If an account exists, we send a link to set a new password.">
      {sent ? <p role="status" className="text-sm">If that email has an account, a reset link is on its way. It works for 1 hour.</p> : (
        <form onSubmit={async (ev) => {
          ev.preventDefault(); setBusy(true);
          // Same answer whatever happens, so the page never reveals which emails have accounts.
          await authClient.requestPasswordReset({ email: String(new FormData(ev.currentTarget).get('email')), redirectTo: '/reset-password' }).catch(() => {});
          setSent(true);
        }}>
          <FieldGroup className="gap-4">
            <Field label="Email"><Input name="email" type="email" required autoComplete="email" autoFocus /></Field>
            <Button type="submit" className="w-full" disabled={busy}>Send reset link</Button>
          </FieldGroup>
        </form>
      )}
      <a href="/login" className="justify-self-start text-[13px] text-muted-foreground underline hover:text-foreground">Back to sign in</a>
    </AuthLayout>
  );
}
