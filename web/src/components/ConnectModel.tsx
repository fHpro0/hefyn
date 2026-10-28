import { Check, Copy, ExternalLink, LogIn, ChevronLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { trpc } from '@/lib/trpc';
import { useQuery } from './api';
import { Dialog } from './dialogs';
import { toast } from './toast';
import { Chip, Err, Field, Input, Loading, Reveal, Select } from './ui';

export interface ProviderList { apiKey: { id: string; name: string; description?: string }[]; oauth: { id: string; name: string; subscription: boolean; description?: string }[] }
export interface Start { flowId: string; authUrl?: string; device?: { userCode: string; verificationUrl: string }; needsPaste: boolean; callback?: boolean; state: string }

// One dialog for connecting a model: sign in first, API key as the secondary path.
// scope 'me' = personal connection (connectors.models), 'company' = shared provider (models.connect).
// `initial` re-runs the sign-in of one provider ("Sign in again").
export function ConnectModelDialog({ scope, initial, onClose, onDone }: { scope: 'me' | 'company'; initial?: string; onClose: () => void; onDone: () => void }) {
  const list = useQuery<ProviderList>(() => trpc.connectors.models.providers.query());
  const [picked, setPicked] = useState(initial);
  const p = list.data?.oauth.find((x) => x.id === picked);
  return (
    <Dialog title={p ? `Sign in with ${p.name}` : 'Connect a provider'} onClose={onClose} xl>
      {p ? (
        <>
          <OAuthFlow key={p.id} label={`Sign in with ${p.name}`} onDone={onDone}
            start={() => trpc.connectors.oauth.start.mutate({ provider: p.id, scope }) as Promise<Start>}
            complete={(flowId, code) => trpc.connectors.oauth.complete.mutate({ flowId, code })}
            status={(flowId) => trpc.connectors.oauth.status.query({ id: flowId })} />
          <div><Button variant="outline" onClick={() => (initial ? onClose() : setPicked(undefined))}><ChevronLeft size={14} aria-hidden />{initial ? 'Cancel' : 'Back'}</Button></div>
        </>
      ) : (
        <>
          <section className="grid gap-2"><h3 className="text-sm font-medium">Sign in with an account</h3>
            <Reveal loading={!list.data && !list.error} fallback={<Loading shape="cards" n={3} />}><div className="grid gap-2 sm:grid-cols-3">
              {list.data?.oauth.map((o) => (
                <button key={o.id} onClick={() => setPicked(o.id)} className="grid content-start gap-1 rounded-xl border border-border bg-raised p-3 text-left text-sm transition-colors hover:border-foreground hover:bg-foreground/5">
                  <span className="font-medium">{o.name}</span>{o.description && <span className="line-clamp-2 text-xs text-muted-foreground">{o.description}</span>}{o.subscription && <span><Chip tone="blue">Subscription</Chip></span>}
                </button>
              ))}
            </div></Reveal>
            {list.data && !list.data.oauth.length && <p className="text-sm text-muted-foreground">No sign-in providers are available. Use an API key instead.</p>}
          </section>
          <details className="rounded-xl bg-foreground/[0.04] p-3">
            <summary className="cursor-pointer text-sm font-medium">Use an API key instead</summary>
            <ApiKeyForm scope={scope} onDone={onDone} />
          </details>
          <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
        </>
      )}
    </Dialog>
  );
}

/** Provider, key and optional base URL: the API-key way of connecting. */
export function ApiKeyForm({ scope, onDone }: { scope: 'me' | 'company'; onDone: () => void }) {
  const list = useQuery<ProviderList>(() => trpc.connectors.models.providers.query());
  const [keyProvider, setKeyProvider] = useState('');
  const [err, setErr] = useState('');
  const kp = keyProvider || list.data?.apiKey[0]?.id || '';
  return (
    <form className="mt-3 grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
      const body = { provider: kp, apiKey: f.apiKey, baseUrl: f.baseUrl || undefined, models: f.models ? f.models.split(',').map((s) => s.trim()).filter(Boolean) : undefined };
      try { await (scope === 'company' ? trpc.models.connect.mutate({ ...body, provider: kp }) : trpc.connectors.models.connect.mutate({ ...body, provider: kp })); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      <Field label="Provider"><Select value={kp} onChange={(e) => setKeyProvider(e.target.value)}>{list.data?.apiKey.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      {list.data?.apiKey.find((x) => x.id === kp)?.description && <p className="-mt-1 text-xs text-muted-foreground">{list.data.apiKey.find((x) => x.id === kp)!.description}</p>}
      <Field label="API key"><Input name="apiKey" type="password" required autoComplete="off" /></Field>
      <Field label={`Base URL ${kp === 'custom' ? '(required)' : '(optional)'}`}><Input name="baseUrl" type="url" required={kp === 'custom'} placeholder="https://…/v1" /></Field>
      {kp === 'custom' && <Field label="Model ids, comma separated"><Input name="models" required placeholder="llama3.1:8b, qwen2.5" /></Field>}
      <Err>{err}</Err>
      <div><Button type="submit">Connect</Button></div>
    </form>
  );
}

/** "Add API key": the key form alone, without the sign-in options. */
export function ApiKeyDialog({ scope, onClose, onDone }: { scope: 'me' | 'company'; onClose: () => void; onDone: () => void }) {
  return <Dialog title="Add an API key" onClose={onClose}><ApiKeyForm scope={scope} onDone={onDone} /></Dialog>;
}

// OAuth sign-in: browser tab (auth URL), device code, or paste-back. Polls status until done.
export function OAuthFlow({ start, status, complete, label, onDone }: {
  start: () => Promise<Start>; status: (flowId: string) => Promise<{ state: string; error?: string }>; complete?: (flowId: string, code: string) => Promise<{ state?: string; error?: string }>; label: string; onDone: () => void;
}) {
  const [s, setS] = useState<Start>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(poll.current), []);
  const finish = (r?: { state?: string; error?: string }) => {
    if (r?.state === 'done') { clearInterval(poll.current); onDone(); }
    else if (r?.state === 'error') { clearInterval(poll.current); setS(undefined); setErr(r.error ?? 'Sign-in failed.'); }
  };
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await start();
      setS(r);
      if (r.authUrl) window.open(r.authUrl, '_blank', 'noopener');
      clearInterval(poll.current);
      poll.current = setInterval(() => status(r.flowId).then(finish, () => {}), 3000);
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }
  return (
    <div className="grid gap-3">
      {!s && <Button type="button" disabled={busy} onClick={go}>{busy ? <Spinner aria-hidden /> : <LogIn size={16} aria-hidden />}{label}</Button>}
      {s?.device && (
        <div className="grid gap-2 rounded-xl bg-foreground/[0.05] p-5 text-center">
          <p className="text-sm text-muted-foreground">Open <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 underline" href={s.device.verificationUrl} target="_blank" rel="noreferrer">{s.device.verificationUrl}<ExternalLink size={12} aria-hidden /></a> and enter this code:</p>
          <div className="flex items-center justify-center gap-3"><code className="font-mono text-3xl font-semibold tracking-widest" aria-label="Device code">{s.device.userCode}</code>
            <Button type="button" variant="outline" size="icon" aria-label="Copy code" onClick={() => navigator.clipboard.writeText(s.device!.userCode).then(() => toast('Code copied'), () => toast('Could not copy. Select the code instead.', true))}><Copy size={16} /></Button></div>
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><Spinner className="size-3" aria-hidden />Waiting for you to confirm…</p>
        </div>
      )}
      {s?.authUrl && (!s.needsPaste || s.callback) && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner className="size-3.5" aria-hidden />Finish signing in in the new tab. This window updates by itself. <a className="text-foreground underline underline-offset-2 underline" href={s.authUrl} target="_blank" rel="noreferrer">Open it again</a></p>
      )}
      {s?.needsPaste && complete && (() => {
        const form = (
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await complete(s.flowId, code.trim()); finish(r); if (r.state === 'error') setErr(r.error ?? 'Sign-in failed.'); } catch (x) { setErr((x as Error).message); } }}>
            {s.callback
              ? <p className="text-sm text-muted-foreground">This happens when hefyn runs on another machine than your browser. Copy the full address from that tab's address bar and paste it here.</p>
              : <p className="text-sm text-muted-foreground">Sign in in the new tab{s.authUrl && <> (<a className="text-foreground underline underline-offset-2 underline" href={s.authUrl} target="_blank" rel="noreferrer">open it again</a>)</>}, then copy the code it shows (or the page's full address) and paste it here.</p>}
            <Field label={s.callback ? 'Address of the error page' : 'Code'}><Input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" /></Field>
            <div><Button type="submit"><Check size={16} aria-hidden />Complete sign-in</Button></div>
          </form>
        );
        return s.callback ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">The tab ended on an error page?</summary><div className="pt-3">{form}</div></details> : form;
      })()}
      <Err>{err}</Err>
    </div>
  );
}
