import { useState } from 'react';
import { api } from './api';
import { buttonPrimary, Err, Field, Input, Wordmark } from './ui';

export function AuthCard({ title, hint, button, onSubmit, fields }: { title: string; hint: string; button: string; fields: ('name' | 'email' | 'password')[]; onSubmit: (v: Record<string, string>) => Promise<void> }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center bg-paper p-4">
      <form className="grid w-full max-w-sm gap-4 rounded-2xl bg-sheet p-8 shadow-float ring-1 ring-line" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await onSubmit(Object.fromEntries(new FormData(e.currentTarget) as any)); } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <Wordmark />
        <div className="mt-2"><h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.01em]">{title}</h1><p className="mt-1 text-[15px] leading-6 text-soft">{hint}</p></div>
        {fields.includes('name') && <Field label="Your name"><Input name="name" required autoComplete="name" /></Field>}
        <Field label="Email"><Input name="email" type="email" required autoComplete="email" /></Field>
        <Field label="Password"><Input name="password" type="password" required minLength={8} autoComplete={fields.includes('name') ? 'new-password' : 'current-password'} /></Field>
        <Err>{err}</Err>
        <button className={buttonPrimary} disabled={busy}>{button}</button>
      </form>
    </main>
  );
}

export default function Setup() {
  return <AuthCard title="Set up hefyn" hint="Create the first account. It becomes the admin account." button="Create account" fields={['name', 'email', 'password']}
    onSubmit={async (v) => {
      await api('/api/setup', 'POST', v);
      await api('/api/auth/sign-in/email', 'POST', { email: v.email, password: v.password });
      location.href = '/settings/models';
    }} />;
}
