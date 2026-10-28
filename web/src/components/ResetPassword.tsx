import { useState } from 'react';
import { authClient, ok } from './auth';
import { AuthLayout, useErr } from './Setup';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { Field, Input } from './ui';

export default function ResetPassword() {
  const token = new URLSearchParams(location.search).get('token');
  const e = useErr();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!token) return <AuthLayout title="Link not valid" hint="This link is incomplete. Ask for a new one."><Button render={<a href="/forgot-password" />} nativeButton={false}>Request a new link</Button></AuthLayout>;
  return (
    <AuthLayout title="Set your password" hint="Choose a password with at least 8 characters.">
      {saved ? <><p role="status" className="text-sm">Your password is set.</p><Button render={<a href="/login" />} nativeButton={false}>Go to sign in</Button></> : (
        <form onSubmit={async (ev) => {
          ev.preventDefault(); setBusy(true); e.setErr('');
          try {
            await ok(authClient.resetPassword({ newPassword: String(new FormData(ev.currentTarget).get('password')), token }), 'This link has expired or was already used. Ask for a new one.');
            setSaved(true);
          } catch (x) { e.setErr((x as Error).message); setBusy(false); }
        }}>
          <FieldGroup className="gap-4">
            <Field label="New password"><Input name="password" type="password" required minLength={8} autoComplete="new-password" autoFocus aria-describedby={e.describedBy} /></Field>
            {e.node}
            <Button type="submit" className="w-full" disabled={busy}>Set password</Button>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  );
}
