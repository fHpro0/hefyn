import { Check, Copy, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, can, type Me } from './api';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Dialog } from './dialogs';
import { enrolPasskey, prfSupported, unlockWithPasskey } from './prf';
import { toast } from './toast';
import { buttonDangerSolid, Err, Field, Input } from './ui';

export interface KeyStatus {
  unlocked: boolean; state: 'none' | 'ok' | 'needs_recovery'; hasRecoveryKey: boolean; keyMode?: 'user' | 'server';
  recoveryKeyToShow?: string; teamUnlocked: boolean; teamRecoveryKeyToShow?: string; isAdmin: boolean;
  passkeyUnlock: string[]; passkeyUnlockAt: Record<string, string>; // credential ids enrolled for unlock, and when
}

// Passkeys that could be enrolled for unlock but are not yet (offered once after a password unlock).
const notEnrolled = (status: KeyStatus) => !prfSupported() ? Promise.resolve([] as string[])
  : api<{ credentialID: string }[]>('/api/auth/passkey/list-user-passkeys').then((l) => l.map((p) => p.credentialID).filter((id) => !status.passkeyUnlock.includes(id)), () => []);

// A recovery key is shown once: the dialog cannot be closed until the person confirms they saved it.
export function RecoveryKeyDialog({ title, intro, value, onDone }: { title: string; intro: string; value: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [n, setN] = useState(0); // remounting reopens the dialog after Esc or a backdrop click
  return (
    <Dialog key={n} title={title} wide onClose={() => (saved ? onDone() : setN(n + 1))}>
      <p className="-mt-2 text-sm text-muted-foreground">{intro}</p>
      <code className="block rounded-lg border border-border bg-surface p-3 text-center font-mono text-[15px] leading-6 tracking-wide break-all select-all" aria-label="Recovery key">{value}</code>
      <div>
        <Button variant="outline" onClick={() => navigator.clipboard?.writeText(value).then(() => toast('Copied'))}><Copy size={14} aria-hidden />Copy</Button>
      </div>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved it somewhere safe</label>
      <div className="flex justify-end"><Button disabled={!saved} onClick={onDone}><Check size={14} aria-hidden />Done</Button></div>
    </Dialog>
  );
}

type Mode = 'password' | 'recovery' | 'fresh';

function UnlockDialog({ status, onUnlocked, onClose }: { status: KeyStatus; onUnlocked: (recoveryKey?: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(status.state === 'needs_recovery' ? 'recovery' : 'password');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<string[]>(); // passkeys to offer for unlock after the password worked
  const run = async (f: () => Promise<void>) => { setErr(''); setBusy(true); try { await f(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  const get = (form: HTMLFormElement, k: string) => String(new FormData(form).get(k) ?? '');
  const hint = mode === 'recovery'
    ? 'Your password was reset, so your data needs the recovery key you saved. Enter it together with your current password.'
    : mode === 'fresh'
      ? 'Without your password or recovery key your chats and personal connections cannot be read by anyone. You can start with empty data. This deletes them for good.'
      : 'Your chats and personal secrets are encrypted. Enter your password to unlock them.';
  if (offer) return (
    <Dialog title="Unlock with your passkey next time" onClose={() => onUnlocked()}>
      <p className="-mt-2 text-sm text-muted-foreground">Your data is unlocked. Use a passkey to unlock it with a single touch instead of typing your password.</p>
      <Err>{err}</Err>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => run(async () => {
          if (await enrolPasskey(offer) === 'noprf') { setErr("This passkey can't unlock your data (the browser or authenticator does not support it). Your password still works."); return; }
          onUnlocked();
        })}>Use my passkey</Button>
        <Button variant="outline" onClick={() => onUnlocked()}>Not now</Button>
      </div>
    </Dialog>
  );
  return (
    <Dialog title={mode === 'fresh' ? 'Start fresh' : 'Unlock your data'} onClose={onClose}>
      <p className="-mt-2 text-sm text-muted-foreground">{hint}</p>
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault(); const f = e.currentTarget;
        run(async () => {
          if (mode === 'fresh') {
            const r = await api<{ recoveryKey: string }>('/api/security/reset-data', 'POST', { password: get(f, 'password'), confirm: get(f, 'confirm') });
            return onUnlocked(r.recoveryKey);
          }
          try { await api('/api/security/unlock', 'POST', { password: get(f, 'password'), recoveryKey: mode === 'recovery' ? get(f, 'recovery') : undefined }); } catch (x) {
            if ((x as Error).message === 'recovery_key_required') { setMode('recovery'); throw new Error('Enter your recovery key as well.'); }
            throw x;
          }
          const more = await notEnrolled(status);
          if (more.length) setOffer(more); else onUnlocked();
        });
      }}>
        <Field label="Password"><Input name="password" type="password" required autoFocus autoComplete="current-password" /></Field>
        {mode === 'recovery' && <Field label="Recovery key"><Input name="recovery" required autoComplete="off" spellCheck={false} className="font-mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" /></Field>}
        {mode === 'fresh' && <Field label="Type DELETE MY DATA to confirm"><Input name="confirm" required autoComplete="off" pattern="DELETE MY DATA" /></Field>}
        <Err>{err}</Err>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" className={mode === 'fresh' ? buttonDangerSolid : undefined} disabled={busy}>{mode === 'fresh' ? 'Delete my data and start fresh' : 'Unlock'}</Button>
          {mode !== 'password' && <Button type="button" variant="outline" onClick={() => setMode('password')}>Back</Button>}
        </div>
        {mode !== 'fresh' && status.state !== 'none' && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Can't unlock?</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {mode === 'password' && <Button type="button" variant="outline" size="sm" onClick={() => setMode('recovery')}>Use your recovery key</Button>}
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setMode('fresh')}>Start fresh…</Button>
            </div>
          </details>
        )}
      </form>
    </Dialog>
  );
}

function TeamUnlockDialog({ onClose }: { onClose: () => void }) {
  const [err, setErr] = useState('');
  return (
    <Dialog title="Unlock team secrets" onClose={onClose}>
      <p className="-mt-2 text-sm text-muted-foreground">Enter the team recovery key that was shown when the team key was created.</p>
      <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); const recoveryKey = String(new FormData(e.currentTarget).get('key'));
        try { await api('/api/security/team-unlock', 'POST', { recoveryKey }); location.reload(); } catch (x) { setErr((x as Error).message); } }}>
        <Field label="Team recovery key"><Input name="key" required autoFocus autoComplete="off" spellCheck={false} className="font-mono" /></Field>
        <Err>{err}</Err>
        <div><Button type="submit">Unlock</Button></div>
      </form>
    </Dialog>
  );
}

// Mounted in Shell: asks for the password when the user's data is locked, shows one-shot recovery keys, and warns when team secrets are locked.
export default function Unlock({ me }: { me: Me }) {
  const [status, setStatus] = useState<KeyStatus>();
  const [asking, setAsking] = useState(false);
  const [teamLocked, setTeamLocked] = useState(false);
  const [teamDialog, setTeamDialog] = useState(false);
  type Shown = { title: string; intro: string; value: string; then?: () => void };
  const [shown, setShown] = useState<Shown[]>([]); // both keys can arrive together (first admin sign-in): shown one after the other
  const keyShown = shown[0];

  const load = () => api<KeyStatus>('/api/security/key-status').then((s) => {
    setStatus(s);
    const add: Shown[] = [];
    if (s.recoveryKeyToShow) add.push({ title: 'Save your recovery key', intro: 'This key opens your encrypted data if you forget your password or an admin resets it. It is shown only now; store it in a password manager or print it.', value: s.recoveryKeyToShow });
    if (s.teamRecoveryKeyToShow) add.push({ title: 'Save the team recovery key', intro: 'The team secrets (model keys, connectors, mail password) are now encrypted. This key opens them if no admin can sign in. It is shown only now.', value: s.teamRecoveryKeyToShow });
    if (add.length) setShown((cur) => [...cur, ...add]);
    setTeamLocked(!s.teamUnlocked && me.providerConnected);
  }).catch(() => {});
  useEffect(() => {
    load();
    const f = (e: Event) => { if ((e as CustomEvent).detail?.scope === 'team') setTeamLocked(true); else load(); }; // a locked answer only shows the notice; the dialog opens on click
    addEventListener('hefyn-locked', f); return () => removeEventListener('hefyn-locked', f);
  }, []);

  const unlocked = (recoveryKey?: string) => {
    setAsking(false);
    if (recoveryKey) return setShown([{ title: 'Save your new recovery key', intro: 'Your old data was deleted and a new key was created. This recovery key is shown only now.', value: recoveryKey, then: () => location.reload() }]);
    location.reload(); // pages that loaded while locked reload their data
  };
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyErr, setPasskeyErr] = useState('');
  const withPasskey = status && status.passkeyUnlock.length > 0 && prfSupported();
  const touch = async () => {
    setPasskeyErr(''); setPasskeyBusy(true);
    try { if (await unlockWithPasskey(status!.passkeyUnlock)) return location.reload(); setPasskeyErr('That passkey could not unlock your data.'); } catch { setPasskeyErr('The passkey was not used.'); }
    setPasskeyBusy(false);
  };
  return (
    <>
      {status && !status.unlocked && !keyShown && (
        <Alert role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-none border-0 border-b border-border bg-foreground/[0.04] px-4 py-1.5 text-[13px]">
          <span className="flex items-center gap-2 font-medium"><Lock size={14} strokeWidth={1.75} aria-hidden />Your chats are locked</span>
          {passkeyErr && <span className="text-danger-ink">{passkeyErr}</span>}
          <span className="ml-auto flex gap-2">
            {withPasskey && <Button size="sm" disabled={passkeyBusy} onClick={touch}>Unlock with passkey</Button>}
            <Button size="sm" variant={withPasskey ? 'outline' : 'default'} onClick={() => setAsking(true)}>{withPasskey ? 'Use password' : 'Unlock'}</Button>
          </span>
        </Alert>
      )}
      {teamLocked && (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-foreground/[0.04] px-4 py-1.5 text-[13px]">
          <Lock size={14} strokeWidth={1.75} aria-hidden /><span>Team models and connectors are locked until an admin signs in.</span>
          {can(me, 'users.manage') && <Button variant="link" className="ml-1 h-auto p-0 text-[13px] text-foreground" onClick={() => setTeamDialog(true)}>Use the team recovery key</Button>}
        </div>
      )}
      {asking && status && !keyShown && <UnlockDialog status={status} onUnlocked={unlocked} onClose={() => setAsking(false)} />}
      {teamDialog && <TeamUnlockDialog onClose={() => setTeamDialog(false)} />}
      {keyShown && <RecoveryKeyDialog title={keyShown.title} intro={keyShown.intro} value={keyShown.value} onDone={() => { const t = keyShown.then; setShown((cur) => cur.slice(1)); t?.(); }} />}
    </>
  );
}
