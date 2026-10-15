import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

// ---- controls: radius 10, one look everywhere ----
export const control = 'w-full rounded-[10px] border border-field bg-sheet px-3 py-2 text-sm text-ink placeholder:text-soft/70 disabled:cursor-not-allowed disabled:opacity-60';
const btn = 'inline-flex items-center justify-center gap-2 rounded-[10px] px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
export const buttonPrimary = `${btn} bg-hefyn text-on-hefyn hover:brightness-95`;
export const buttonGhost = `${btn} border border-line bg-sheet text-ink hover:bg-ink/5`;
export const buttonDanger = `${btn} border border-alarm/40 bg-sheet text-alarm-ink hover:bg-alarm/10`;
export const iconButton = 'inline-grid size-9 shrink-0 place-items-center rounded-[10px] text-soft transition-colors hover:bg-ink/5 hover:text-ink';

export const Logo = ({ size = 28 }: { size?: number }) => <img src="/brand/hefyn-mark.svg" alt="" height={size} width={size * 0.76} />;
export const Wordmark = () => (
  <picture><source media="(prefers-color-scheme: dark)" srcSet="/brand/hefyn-wordmark-white.svg" /><img src="/brand/hefyn-wordmark.svg" alt="hefyn" className="h-6" /></picture>
);

export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`grid gap-1.5 text-sm font-medium ${className}`}><span>{label}</span>{children}</label>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${control} ${p.className ?? ''}`} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${control} ${p.className ?? ''}`} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${control} ${p.className ?? ''}`} />;

export function Switch({ checked, onChange, label, disabled, tone = 'blue' }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; tone?: 'blue' | 'caution' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? (tone === 'caution' ? 'bg-caution' : 'bg-hefyn') : 'bg-field'}`}>
      <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

// ---- page structure ----
export function Page({ title, hint, actions, children, wide }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} px-6 py-8 sm:px-10`}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.01em]">{title}</h1>{hint && <p className="mt-1 max-w-xl text-[15px] leading-6 text-soft">{hint}</p>}</div>
        {actions}
      </header>
      <div className="mt-6">{children}</div>
    </div>
  );
}

// A titled group of Rows.
export const Section = ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
  <section className="mt-8 first:mt-0">{title && <h2 className="mb-1 text-[17px] leading-6 font-semibold tracking-[-0.01em]">{title}</h2>}<div className="border-t border-line">{children}</div></section>
);

// Settings row: name and one sentence on the left, the control on the right.
export function Row({ title, hint, children, compact, wide }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; compact?: boolean; wide?: boolean }) {
  return (
    <div className={`grid items-start gap-x-10 gap-y-3 border-b border-line ${compact ? 'py-3' : 'py-5'} ${wide ? 'md:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]' : 'md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]'}`}>
      <div><h3 className="text-sm font-medium">{title}</h3>{hint && <p className="mt-0.5 max-w-md text-sm text-soft">{hint}</p>}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export type Tone = 'neutral' | 'blue' | 'seal' | 'ok' | 'alarm' | 'caution';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-ink/[0.07] text-soft', blue: 'bg-hefyn/12 text-hefyn', seal: 'bg-seal/12 text-seal',
  ok: 'bg-ok/15 text-ok-ink', alarm: 'bg-alarm/12 text-alarm-ink', caution: 'bg-caution/15 text-caution-ink',
};
export const Chip = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}>{children}</span>
);
// A seal as it appears in payloads: solid violet, machine text.
export const SealToken = ({ children }: { children: ReactNode }) => <span className="inline-flex items-center rounded-full bg-seal px-2 py-0.5 font-mono text-[11px] font-medium text-on-seal">{children}</span>;

export const Empty = ({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) => (
  <div className="grid justify-items-center gap-2 py-12 text-center text-sm text-soft"><span aria-hidden>{icon}</span><p className="max-w-sm">{children}</p>{action}</div>
);

export const Err = ({ children }: { children?: string }) => children ? <p role="alert" className="flex items-start gap-2 text-sm text-alarm-ink"><XCircle size={16} aria-hidden className="mt-0.5 shrink-0" />{children}</p> : null;

// Plain tabular list: hairlines only.
export const Table = ({ head, children, num = [] }: { head: string[]; children: ReactNode; num?: number[] }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead className="text-xs text-soft"><tr>{head.map((h, i) => <th key={h || i} className={`px-3 py-2 font-medium first:pl-0 last:pr-0 ${num.includes(i) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
      <tbody className="[&_td]:px-3 [&_td]:py-3 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-t [&_tr]:border-line">{children}</tbody>
    </table>
  </div>
);

export const StatusIcon = ({ state }: { state: 'running' | 'success' | 'failure' }) =>
  state === 'running' ? <Loader2 size={14} aria-label="running" className="animate-spin text-hefyn" />
    : state === 'success' ? <CheckCircle2 size={14} aria-label="done" className="text-ok" /> : <XCircle size={14} aria-label="failed" className="text-alarm" />;

export const QuotaBar = ({ used, quota }: { used: number; quota: number }) => {
  const f = Math.min(used / quota, 1);
  return <div role="meter" aria-label="Storage used" aria-valuenow={used} aria-valuemax={quota} className="h-1.5 overflow-hidden rounded-full bg-ink/10"><div className={`h-full rounded-full ${f > 0.9 ? 'bg-alarm' : 'bg-hefyn'}`} style={{ width: `${f * 100}%` }} /></div>;
};

// ---- toast: call toast('…') or toast('…', true) for failures; <Toaster /> renders it ----
export const toast = (msg: string, bad = false, link?: { href: string; label: string }) => dispatchEvent(new CustomEvent('hefyn-toast', { detail: { msg, bad, link } }));
export function Toaster() {
  const [t, setT] = useState<{ msg: string; bad: boolean; link?: { href: string; label: string } }>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const f = (e: Event) => { setT((e as CustomEvent).detail); clearTimeout(timer); timer = setTimeout(() => setT(undefined), (e as CustomEvent).detail.link ? 10000 : 4000); };
    addEventListener('hefyn-toast', f);
    return () => { removeEventListener('hefyn-toast', f); clearTimeout(timer); };
  }, []);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-20 z-50 sm:bottom-4">
      {t && <div className="pointer-events-auto flex items-center gap-2 rounded-[10px] bg-sheet px-4 py-2.5 text-sm font-medium shadow-float ring-1 ring-line">
        <span className={`size-2 rounded-full ${t.bad ? 'bg-alarm' : 'bg-ok'}`} aria-hidden />{t.msg}{t.link && <a className="text-hefyn underline" href={t.link.href}>{t.link.label}</a>}</div>}
    </div>
  );
}

// ---- dialogs: native <dialog> (focus trap, Esc, backdrop). `side` = right-hand sheet ----
export function Dialog({ title, onClose, children, wide, xl, side, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean; side?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const size = side ? 'my-0 mr-0 ml-auto h-dvh max-h-dvh w-[min(36rem,100vw)] rounded-l-2xl rounded-r-none' : `m-auto max-h-[90vh] w-full ${xl ? 'max-w-3xl' : wide ? 'max-w-lg' : 'max-w-sm'} rounded-2xl`;
  return (
    <dialog ref={ref} aria-labelledby="dlg-t" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}
      className={`${size} overflow-hidden bg-sheet p-0 text-ink shadow-float backdrop:bg-ink/40 open:flex open:flex-col`}>
      <div className="grid min-h-0 grow content-start gap-4 overflow-y-auto p-6"><h2 id="dlg-t" className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">{title}</h2>{children}</div>
      {footer && <div className="shrink-0 border-t border-line px-6 py-4">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm, onClose, danger = true }: { title: string; body: string; action: string; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="-mt-2 text-sm text-soft">{body}</p>
      <div className="flex justify-end gap-2">
        <button className={buttonGhost} autoFocus onClick={onClose}>Cancel</button>
        <button className={danger ? buttonDanger : buttonPrimary} disabled={done} onClick={() => { setDone(true); onConfirm(); onClose(); }}>{action}</button>
      </div>
    </Dialog>
  );
}

// Element styles for react-markdown: prose in the UI font, code in mono.
export const mdComponents = {
  p: (p: ComponentProps<'p'>) => <p className="my-3 first:mt-0 last:mb-0" {...p} />,
  a: (p: ComponentProps<'a'>) => <a className="text-hefyn underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  ul: (p: ComponentProps<'ul'>) => <ul className="my-3 list-disc pl-5 marker:text-soft" {...p} />,
  ol: (p: ComponentProps<'ol'>) => <ol className="my-3 list-decimal pl-5 marker:text-soft" {...p} />,
  li: (p: ComponentProps<'li'>) => <li className="my-1" {...p} />,
  h1: (p: ComponentProps<'h1'>) => <h3 className="mt-6 mb-2 text-lg font-semibold tracking-[-0.01em]" {...p} />,
  h2: (p: ComponentProps<'h2'>) => <h3 className="mt-6 mb-2 text-lg font-semibold tracking-[-0.01em]" {...p} />,
  h3: (p: ComponentProps<'h3'>) => <h3 className="mt-4 mb-1 font-semibold" {...p} />,
  blockquote: (p: ComponentProps<'blockquote'>) => <blockquote className="my-3 border-l-2 border-line pl-4 text-soft" {...p} />,
  code: (p: ComponentProps<'code'>) => <code className="rounded-md bg-ink/[0.07] px-1.5 py-0.5 font-mono text-[0.85em]" {...p} />,
  pre: (p: ComponentProps<'pre'>) => <pre className="my-3 overflow-x-auto rounded-[10px] bg-ink/[0.06] p-3.5 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" {...p} />,
  table: (p: ComponentProps<'table'>) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm" {...p} /></div>,
  th: (p: ComponentProps<'th'>) => <th className="border-b border-line px-2 py-1.5 text-left font-medium" {...p} />,
  td: (p: ComponentProps<'td'>) => <td className="border-b border-line px-2 py-1.5" {...p} />,
};
