import { Copy, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api, bytes } from './api';
import { Chip, SealToken, iconButton, shortcut, toast } from './ui';

export interface Seal { name: string; label: string; value: string }
interface Req { id: number; provider: string; model: string; status: 'ok' | 'blocked'; findings: { label: string; count: number }[]; bytes: number; error: string | null; ts: string; seals?: string[] }
export interface AuditData { requests: Req[]; latest: { id: number; provider: string; model: string; ts: string; payload: unknown } | null }

// Audit rows + the seals of a conversation. Reloads when `tick` changes; `fresh` holds seal names that appeared since the last load
// (they get the one-time stamp animation, which clears itself).
export function useLedger(id: string | undefined, tick: unknown) {
  const [audit, setAudit] = useState<AuditData>();
  const [seals, setSeals] = useState<Seal[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | undefined>(undefined);
  useEffect(() => { known.current = undefined; setAudit(undefined); setSeals([]); }, [id]);
  useEffect(() => {
    if (!id) return;
    api<AuditData>(`/api/conversations/${id}/audit`).then(setAudit, () => setAudit(undefined));
    api<Seal[]>(`/api/conversations/${id}/seals`).then((s) => {
      setSeals(s);
      const names = new Set(s.map((x) => x.name));
      if (known.current) {
        const added = new Set([...names].filter((n) => !known.current!.has(n)));
        if (added.size) { setFresh(added); setTimeout(() => setFresh(new Set()), 800); }
      }
      known.current = names;
    }, () => setSeals([]));
  }, [id, tick]);
  const count = seals.length || new Set(audit?.requests.flatMap((r) => r.seals ?? [])).size || (audit?.requests.find((r) => r.status === 'ok')?.findings ?? []).filter((f) => !f.label.startsWith('IMAGE_')).reduce((a, f) => a + f.count, 0);
  return { audit, seals, fresh, count };
}

// A user's own text with sealed spans underlined in violet. Hover or focus shows the placeholder the model saw.
export function SealedText({ text, seals, fresh }: { text: string; seals: Seal[]; fresh: Set<string> }) {
  const live = seals.filter((s) => s.value && text.includes(s.value)).sort((a, b) => b.value.length - a.value.length);
  if (!live.length) return <>{text}</>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${live.map((s) => esc(s.value)).join('|')})`));
  return (
    <>{parts.map((p, i) => {
      const s = i % 2 ? live.find((x) => x.value === p) : undefined;
      return s ? (
        <span key={i} tabIndex={0} className={`group relative seal-bar ${fresh.has(s.name) ? 'fresh' : ''}`}>
          {p}
          <span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden rounded-md bg-foreground px-2 py-1 font-sans text-xs font-normal whitespace-nowrap text-background group-hover:block group-focus-visible:block">Sent to the model as {s.name}</span>
        </span>
      ) : <Fragment key={i}>{p}</Fragment>;
    })}</>
  );
}

const PLACEHOLDER = /(\{\{(?:var|secret):[A-Za-z0-9_]+\}\})/;
const Payload = ({ text }: { text: string }) => (
  <pre tabIndex={0} aria-label="Exact payload" className="max-h-72 overflow-auto rounded-md bg-foreground/[0.05] p-2.5 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap">
    {text.split(PLACEHOLDER).map((t, i) => (i % 2 ? <SealToken key={i}>{t.slice(2, -2).split(':')[1]}</SealToken> : <Fragment key={i}>{t}</Fragment>))}
  </pre>
);

const Findings = ({ f }: { f: Req['findings'] }) => (
  <>{f.map((x) => x.label === 'IMAGE_REMOVED' ? <Chip key={x.label}>image removed ×{x.count}</Chip>
    : x.label === 'IMAGE_SENT_UNREDACTED' ? <Chip key={x.label} tone="caution">image sent unredacted ×{x.count}</Chip> : <SealToken key={x.label}>{x.label} ×{x.count}</SealToken>)}</>
);

function Entry({ r, payload }: { r: Req; payload?: unknown }) {
  const [open, setOpen] = useState(false);
  const time = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (r.status === 'blocked') {
    return (
      <article role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3">
        <div className="flex items-center justify-between gap-2 text-sm"><b className="text-danger-ink">Blocked by the privacy layer</b><span className="tnum text-xs text-muted">{time}</span></div>
        <p className="mt-1 text-sm">Nothing was sent to {r.model}.{r.error && <span className="text-muted"> {r.error}</span>}</p>
        {r.error && /bypass/i.test(r.error) && <div className="mt-2"><Chip tone="alarm">Bypass blocked</Chip></div>}
      </article>
    );
  }
  const text = payload ? JSON.stringify(payload, null, 2) : '';
  return (
    <article className="rounded-lg border border-border bg-raised p-3">
      <div className="flex items-center justify-between gap-2 text-sm"><span className="font-medium">{r.model}</span><span className="tnum text-xs text-muted">{time}</span></div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">{r.seals?.length ? r.seals.map((s) => <SealToken key={s}>{s}</SealToken>) : <Findings f={r.findings} />}
        {!r.seals?.length && !r.findings.length && <span className="text-sm text-muted">Nothing needed sealing.</span>}</div>
      {r.seals?.length ? <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden"><Findings f={r.findings.filter((f) => f.label.startsWith('IMAGE_'))} /></div> : null}
      <div className="mt-2 flex items-center justify-between text-xs text-muted"><span className="tnum">{bytes(r.bytes)} sent</span>
        {payload != null && <button className="text-foreground hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide payload' : 'Show payload'}</button>}</div>
      {open && payload != null && (
        <div className="mt-2 grid gap-1.5">
          <div className="flex justify-end"><button className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy. Select the text instead.', true))}><Copy size={12} aria-hidden />Copy</button></div>
          <Payload text={text} />
        </div>
      )}
    </article>
  );
}

export function Ledger({ audit, onClose }: { audit?: AuditData; onClose: () => void }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-4"><h2 className="text-sm font-medium">Privacy ledger</h2>
        <button className={iconButton} aria-label={`Close ledger, ${shortcut('L')}`} title={`Close ${shortcut('L')}`} onClick={onClose}><X size={16} /></button></div>
      <p className="px-4 py-3 text-[13px] text-muted">Every request to a model, and exactly what was sealed before it left.</p>
      <div className="grid min-h-0 grow content-start gap-2.5 overflow-y-auto px-3 pb-4">
        {audit?.requests.length ? audit.requests.map((r) => <Entry key={r.id} r={r} payload={audit.latest?.id === r.id ? audit.latest.payload : undefined} />)
          : <p className="px-1 py-6 text-center text-sm text-muted">Nothing has been sent yet. Each request to a model will show up here.</p>}
      </div>
    </>
  );
}
