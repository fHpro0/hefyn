import { Check, Copy, ExternalLink } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { cliPost } from './CliChat';
import { Dialog } from './dialogs';
import { Input, Loading } from './ui';

const CliTerminal = lazy(() => import('./CliTerminal')); // xterm loads only when a terminal is needed

interface State { phase: 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed'; url?: string; code?: string; account?: string; reason?: string; flow?: string }

/** Sign in to an agent with a person's own account, or (scope team, an admin) the team's shared login. The agent's own login runs in the sandbox (src/cli-agents/account.ts); this
 *  shows its sign-in page as a button, its device code, a field for the code the page gives, and the result. hefyn never sees the account's password or token: the code is typed
 *  into the agent's own prompt. An agent without a scriptable login gets its own terminal instead. */
export function SignInDialog({ agentId, name, terminal: t0, flow: f0, scope = 'personal', onClose, onDone }: { agentId: string; name: string; /** the sign-in's conversation and flow: looked up when the caller (a chat) does not have them */ terminal?: string; flow?: 'code' | 'device' | 'terminal'; scope?: 'personal' | 'team'; onClose: () => void; onDone?: () => void }) {
  const [info, setInfo] = useState(t0 && f0 ? { terminal: t0, flow: f0 } : undefined);
  useEffect(() => { if (!info) void trpc.cliAgents.accounts.query().then((l) => { const a = l.find((x) => x.agentId === agentId); setInfo(a?.flow ? { terminal: a.terminal, flow: a.flow } : undefined); }).catch(() => {}); }, []);
  const terminal = info?.terminal ?? '', flow = info?.flow;
  const [st, setSt] = useState<State>({ phase: 'starting' });
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [ended, setEnded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dead = useRef(false);
  const body = { agent: agentId, scope };
  const guided = flow !== 'terminal';

  useEffect(() => {
    if (!flow || !guided) return;
    dead.current = false; setSt({ phase: 'starting' }); setSent(false); setCode(''); setMsg('');
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(`/agents/account/${terminal}/state`);
        const j = await r.json().catch(() => ({}));
        if (dead.current) return;
        if (!r.ok) throw new Error(j.error ?? `The request failed (${r.status}).`);
        if (j.phase === 'idle') throw new Error('The sign-in stopped. Start it again.');
        setSt(j);
        if (j.phase === 'done' || j.phase === 'failed') return;
      } catch (e) { if (!dead.current) setMsg((e as Error).message); return; }
      timer = setTimeout(poll, 1000);
    };
    cliPost(terminal, '/open', { cols: 1000, rows: 24, ...body }, 'account').then(poll).catch((e) => !dead.current && setMsg(e.message));
    return () => { dead.current = true; clearTimeout(timer); };
  }, [attempt, flow]);
  // closing the dialog ends the sign-in (a retry does not: the host replaces a finished one itself)
  useEffect(() => terminal ? () => void fetch(`/agents/account/${terminal}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {}) : undefined, [terminal]);

  const finish = () => { onDone?.(); onClose(); };
  const submit = async () => {
    setMsg('');
    try { await cliPost(terminal, '/code', { code }, 'account'); setSent(true); setCode(''); } catch (e) { setMsg((e as Error).message); }
  };
  const copy = () => { void navigator.clipboard?.writeText(st.code ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  const finished = st.phase === 'done' || st.phase === 'failed' || ended;
  const who = scope === 'team' ? `the team’s ${name} login` : name;

  return (
    <Dialog title={scope === 'team' ? `Sign the team in to ${name}` : `Sign in to ${name}`} wide={guided} xl={!guided} onClose={finish}
      footer={st.phase === 'failed' ? <><Button type="button" variant="outline" onClick={finish}>Close</Button><Button type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</Button></>
        : <Button type="button" variant={finished ? 'default' : 'outline'} onClick={finish}>{finished ? 'Done' : 'Cancel'}</Button>}>
      {!info ? <Loading /> : !guided ? (
        <>
          <p className="text-[13px] text-muted-foreground">{name} signs in in its own terminal. Follow what it asks; when it says you are signed in, press Done. hefyn never sees your password.</p>
          <div className="flex h-[55vh] min-h-72 flex-col overflow-hidden rounded-lg border border-border">
            <Suspense fallback={<p className="p-3 text-[13px] text-muted-foreground">Opening the sign-in…</p>}><CliTerminal id={terminal} name={name} account openBody={body} onEnd={() => setEnded(true)} /></Suspense>
          </div>
        </>
      ) : (
        <div className="grid gap-4" aria-live="polite">
          {st.phase === 'starting' && !msg && <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner /> Starting {name}’s sign-in…</p>}
          {st.phase === 'waiting' && (
            <>
              <p className="text-[13px] text-muted-foreground">1. Open the sign-in page and sign in with {scope === 'team' ? 'the team’s account' : 'your account'}. hefyn never sees your password.</p>
              <Button type="button" className="justify-self-start" render={<a href={st.url} target="_blank" rel="noopener noreferrer" />} nativeButton={false}><ExternalLink size={14} aria-hidden /> Open sign-in page</Button>
              {st.code && (
                <div className="grid gap-1.5">
                  <p className="text-[13px] text-muted-foreground">2. Enter this code on that page.</p>
                  <div className="flex items-center gap-2"><code className="rounded-md bg-muted px-3 py-1.5 text-lg font-semibold tracking-widest" aria-label="Sign-in code">{st.code}</code>
                    <Button type="button" variant="ghost" size="icon" aria-label="Copy the code" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</Button></div>
                </div>
              )}
              {flow === 'code' && (
                <form className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void submit(); }}>
                  <label htmlFor="signin-code" className="text-[13px] text-muted-foreground">2. Paste the code the page shows you.</label>
                  <div className="flex gap-2"><Input id="signin-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the code here" disabled={sent} /><Button type="submit" disabled={!code.trim() || sent}>Continue</Button></div>
                </form>
              )}
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner /> {sent || flow === 'device' ? 'Waiting for the sign-in to finish…' : `Waiting for you. This window closes ${who} on its own when it works.`}</p>
            </>
          )}
          {st.phase === 'checking' && <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner /> Checking the sign-in…</p>}
          {st.phase === 'done' && <p className="flex items-center gap-2 text-[13px]"><Check size={16} className="text-success" aria-hidden /> Signed in to {name}{st.account ? ` as ${st.account}` : ''}.</p>}
          {st.phase === 'failed' && <p role="alert" className="text-[13px] text-danger-ink">{st.reason ?? 'The sign-in did not finish. Try again.'}</p>}
          {msg && <p role="alert" className="text-[13px] text-danger-ink">{msg}</p>}
        </div>
      )}
    </Dialog>
  );
}
