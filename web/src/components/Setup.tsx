import { useEffect, useId, useState, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc';
import { api } from './api';
import { Lockup } from './brand';
import { Button } from '@/ui/button';
import { FieldGroup } from '@/ui/field';
import { AsciiMark, Err, Field, Input } from './ui';

// Branded split layout (>= 1024 px): brand panel left, form right. One column with the lockup on small screens.
export function AuthLayout({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-surface p-12 lg:flex">
        <div className="hf-dots pointer-events-none absolute inset-0" aria-hidden />
        <span aria-hidden />
        <div className="relative">
          <AsciiMark />
          <div className="mt-8"><Lockup height={28} /></div>
          <p className="mt-4 max-w-sm text-4xl leading-[1.1] font-semibold tracking-[-0.03em]">Your team's AI workspace.</p>
        </div>
        <span className="relative text-xs font-medium text-muted-foreground">Self-hosted</span>
      </aside>
      <div className="relative grid place-items-center p-6">
        <div className="hf-dots pointer-events-none absolute inset-0" aria-hidden />
        <div className="hf-frame grid w-full max-w-sm gap-6 bg-background px-8 py-10">
          <div className="lg:hidden"><Lockup height={22} /></div>
          <div><h1 className="text-xl leading-7 font-semibold tracking-[-0.02em]">{title}</h1>{hint && <p className="mt-0.5 text-sm leading-[22px] text-muted-foreground">{hint}</p>}</div>
          {children}
        </div>
      </div>
    </main>
  );
}

// Better Auth answers an untrusted browser origin with a bare 403.
export const authMessage = (m: string) => /forbidden|invalid origin|\b403\b/i.test(m) ? 'This address isn’t allowed to sign in. Open hefyn at the address it was set up with.' : m;

// An error line tied to its input via aria-describedby.
export function useErr() {
  const id = useId();
  const [err, setErr] = useState('');
  return { err, setErr, id, describedBy: err ? id : undefined, node: <div id={id}><Err>{err}</Err></div> };
}

export function AuthCard({ title, hint, button, onSubmit, fields }: { title: string; hint: string; button: string; fields: ('name' | 'email' | 'password')[]; onSubmit: (v: Record<string, string>) => Promise<void> }) {
  const e = useErr();
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title={title} hint={hint}>
      <form onSubmit={async (ev) => {
        ev.preventDefault(); setBusy(true); e.setErr('');
        try { await onSubmit(Object.fromEntries(new FormData(ev.currentTarget) as any)); } catch (x) { e.setErr(authMessage((x as Error).message)); setBusy(false); }
      }}>
        <FieldGroup className="gap-4">
        {fields.includes('name') && <Field label="Your name"><Input name="name" required autoComplete="name" aria-describedby={e.describedBy} /></Field>}
        <Field label="Email"><Input name="email" type="email" required autoComplete="email" aria-describedby={e.describedBy} /></Field>
        <Field label="Password"><Input name="password" type="password" required minLength={8} autoComplete={fields.includes('name') ? 'new-password' : 'current-password'} aria-describedby={e.describedBy} /></Field>
        {e.node}
        <Button type="submit" className="w-full" disabled={busy}>{button}</Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}

export default function Setup() {
  useEffect(() => { trpc.setup.status.query().then((s) => { if (!s.needsSetup) location.replace('/login'); }).catch(() => {}); }, []);
  return <AuthCard title="Set up hefyn" hint="Create the first account. It becomes the admin account." button="Create account" fields={['name', 'email', 'password']}
    onSubmit={async (v) => {
      await trpc.setup.create.mutate({ name: v.name!, email: v.email!, password: v.password! });
      await api('/api/auth/sign-in/email', 'POST', { email: v.email, password: v.password });
      location.href = '/settings/providers';
    }} />;
}
