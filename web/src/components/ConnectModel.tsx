import { Check, Copy, ExternalLink, Loader2, LogIn, ChevronLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, useLoad } from './api';
import { buttonGhost, buttonPrimary, Chip, Dialog, Err, Field, Input, Select, toast } from './ui';

export interface ProviderList { apiKey: { id: string; name: string; description?: string }[]; oauth: { id: string; name: string; subscription: boolean; description?: string }[] }
export interface Start { flowId: string; authUrl?: string; device?: { userCode: string; verificationUrl: string }; needsPaste: boolean; state: string }

// One dialog for connecting a model: sign in first, API key as the secondary path.
// scope 'me' = personal connection (/api/connectors/models), 'company' = shared provider (/api/models/providers).
// `initial` re-runs the sign-in of one provider ("Sign in again").
export function ConnectModelDialog({ scope, initial, onClose, onDone }: { scope: 'me' | 'company'; initial?: string; onClose: () => void; onDone: () => void }) {
  const list = useLoad<ProviderList>('/api/connectors/models/providers');
  const [picked, setPicked] = useState(initial);
  const [err, setErr] = useState('');
  const [keyProvider, setKeyProvider] = useState('');
  const p = list.data?.oauth.find((x) => x.id === picked);
  const kp = keyProvider || list.data?.apiKey[0]?.id || '';
  return (
    <Dialog title={p ? `Sign in with ${p.name}` : 'Connect a model'} onClose={onClose} xl>
      {p ? (
        <>
          <OAuthFlow key={p.id} label={`Sign in with ${p.name}`} onDone={onDone}
            start={() => api<Start>(`/api/connectors/oauth/${p.id}/start`, 'POST', { scope })}
            complete={(flowId, code) => api(`/api/connectors/oauth/${p.id}/complete`, 'POST', { flowId, code })}
            status={(flowId) => api(`/api/connectors/oauth/${flowId}/status`)} />
          <div><button className={buttonGhost} onClick={() => (initial ? onClose() : setPicked(undefined))}><ChevronLeft size={14} aria-hidden />{initial ? 'Cancel' : 'Back'}</button></div>
        </>
      ) : (
        <>
          <section className="grid gap-2"><h3 className="text-sm font-medium">Sign in with an account</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {list.data?.oauth.map((o) => (
                <button key={o.id} onClick={() => setPicked(o.id)} className="grid content-start gap-1 rounded-[12px] border border-line bg-sheet p-3 text-left text-sm transition-colors hover:border-hefyn hover:bg-hefyn/5">
                  <span className="font-medium">{o.name}</span>{o.description && <span className="line-clamp-2 text-xs text-soft">{o.description}</span>}{o.subscription && <span><Chip tone="blue">Subscription</Chip></span>}
                </button>
              ))}
            </div>
            {list.data && !list.data.oauth.length && <p className="text-sm text-soft">No sign-in providers are available. Use an API key instead.</p>}
          </section>
          <details className="rounded-[12px] bg-ink/[0.04] p-3">
            <summary className="cursor-pointer text-sm font-medium">Use an API key instead</summary>
            <form className="mt-3 grid gap-3" onSubmit={async (e) => {
              e.preventDefault(); setErr('');
              const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
              const body = { provider: kp, apiKey: f.apiKey, baseUrl: f.baseUrl || undefined, models: f.models ? f.models.split(',').map((s) => s.trim()).filter(Boolean) : undefined };
              try { await api(scope === 'company' ? '/api/models/providers' : '/api/connectors/models', 'POST', body); onDone(); } catch (x) { setErr((x as Error).message); }
            }}>
              <Field label="Provider"><Select value={kp} onChange={(e) => setKeyProvider(e.target.value)}>{list.data?.apiKey.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
              {list.data?.apiKey.find((x) => x.id === kp)?.description && <p className="-mt-1 text-xs text-soft">{list.data.apiKey.find((x) => x.id === kp)!.description}</p>}
              <Field label="API key"><Input name="apiKey" type="password" required autoComplete="off" /></Field>
              <Field label={`Base URL ${kp === 'custom' ? '(required)' : '(optional)'}`}><Input name="baseUrl" type="url" required={kp === 'custom'} placeholder="https://…/v1" /></Field>
              {kp === 'custom' && <Field label="Model ids, comma separated"><Input name="models" required placeholder="llama3.1:8b, qwen2.5" /></Field>}
              <Err>{err}</Err>
              <div><button className={buttonPrimary}>Connect</button></div>
            </form>
          </details>
          <div className="flex justify-end"><button className={buttonGhost} onClick={onClose}>Close</button></div>
        </>
      )}
    </Dialog>
  );
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
      {!s && <button type="button" className={buttonPrimary} disabled={busy} onClick={go}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <LogIn size={16} aria-hidden />}{label}</button>}
      {s?.device && (
        <div className="grid gap-2 rounded-[12px] bg-ink/[0.05] p-5 text-center">
          <p className="text-sm text-soft">Open <a className="inline-flex items-center gap-1 text-hefyn underline" href={s.device.verificationUrl} target="_blank" rel="noreferrer">{s.device.verificationUrl}<ExternalLink size={12} aria-hidden /></a> and enter this code:</p>
          <div className="flex items-center justify-center gap-3"><code className="font-mono text-3xl font-semibold tracking-widest" aria-label="Device code">{s.device.userCode}</code>
            <button type="button" className={`${buttonGhost} p-2`} aria-label="Copy code" onClick={() => navigator.clipboard.writeText(s.device!.userCode).then(() => toast('Code copied'), () => toast('Could not copy. Select the code instead.', true))}><Copy size={16} /></button></div>
          <p className="flex items-center justify-center gap-2 text-xs text-soft" role="status"><Loader2 size={12} className="animate-spin" aria-hidden />Waiting for you to confirm…</p>
        </div>
      )}
      {s?.authUrl && !s.needsPaste && (
        <p className="flex items-center gap-2 text-sm text-soft" role="status"><Loader2 size={14} className="animate-spin" aria-hidden />Finish signing in in the new tab. <a className="text-hefyn underline" href={s.authUrl} target="_blank" rel="noreferrer">Open it again</a></p>
      )}
      {s?.needsPaste && complete && (
        <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await complete(s.flowId, code.trim()); finish(r); if (r.state === 'error') setErr(r.error ?? 'Sign-in failed.'); } catch (x) { setErr((x as Error).message); } }}>
          <p className="text-sm text-soft">Sign in in the new tab{s.authUrl && <> (<a className="text-hefyn underline" href={s.authUrl} target="_blank" rel="noreferrer">open it again</a>)</>}. If the page ends on an error or shows a code, copy the code or the full address-bar URL and paste it here.</p>
          <Field label="Code or redirect URL"><Input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" /></Field>
          <div><button className={buttonPrimary}><Check size={16} aria-hidden />Complete sign-in</button></div>
        </form>
      )}
      <Err>{err}</Err>
    </div>
  );
}
