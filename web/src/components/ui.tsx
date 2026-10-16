import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

// ---- controls: 32 px high, radius 8 ----
export const control = 'h-8 w-full rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60';
const btn = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
export const buttonPrimary = `${btn} bg-foreground text-background hover:bg-foreground/85`;
export const buttonGhost = `${btn} border border-border bg-transparent text-foreground hover:bg-foreground/5`;
export const buttonDanger = `${btn} border border-danger/40 bg-transparent text-danger-ink hover:bg-danger/10`;
export const buttonDangerSolid = `${btn} bg-danger text-background hover:opacity-90`;
export const iconButton = 'inline-grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-foreground/5 hover:text-foreground';

// Modifier key label: Command on Apple platforms, Ctrl elsewhere.
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcut = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);
export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="rounded border border-border px-1 font-mono text-[10.5px] font-normal text-muted">{children}</kbd>;

export const Mark = ({ size = 22 }: { size?: number }) => (
  <>
    <img src="/brand/hefyn-mark.svg" alt="" height={size} width={size} className="dark:hidden" />
    <img src="/brand/hefyn-mark-white.svg" alt="" height={size} width={size} className="hidden dark:block" />
  </>
);
export const Wordmark = ({ height = 22 }: { height?: number }) => (
  <>
    <img src="/brand/hefyn-wordmark.svg" alt="hefyn" height={height} style={{ height }} className="dark:hidden" />
    <img src="/brand/hefyn-wordmark-white.svg" alt="hefyn" height={height} style={{ height }} className="hidden dark:block" />
  </>
);
export const Logo = Mark;

export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`grid gap-1.5 text-[13px] font-medium ${className}`}><span>{label}</span>{children}</label>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${control} ${p.className ?? ''}`} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${control} ${p.className ?? ''}`} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${control.replace('h-8 ', '')} min-h-16 py-1.5 ${p.className ?? ''}`} />;

export function Switch({ checked, onChange, label, disabled, tone }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; tone?: 'caution' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? (tone === 'caution' ? 'bg-warning' : 'bg-foreground') : 'bg-input'}`}>
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  );
}

// ---- page structure ----
export function Page({ title, hint, actions, children, wide }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} px-6 py-6`}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl leading-7 font-semibold">{title}</h1>{hint && <p className="mt-0.5 max-w-xl text-sm leading-[22px] text-muted">{hint}</p>}</div>
        {actions}
      </header>
      <div className="mt-5">{children}</div>
    </div>
  );
}

// A titled group of Rows.
export const Section = ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
  <section className="mt-7 first:mt-0">{title && <h2 className="mb-1 text-[15px] leading-6 font-semibold">{title}</h2>}<div className="border-t border-border">{children}</div></section>
);

// Settings row: label and one line of help on the left, the control on the right.
export function Row({ title, hint, children, compact, wide }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; compact?: boolean; wide?: boolean }) {
  return (
    <div className={`grid items-start gap-x-8 gap-y-2 border-b border-border ${compact ? 'py-2.5' : 'py-4'} ${wide ? 'md:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]' : 'md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]'}`}>
      <div><h3 className="text-[13px] font-medium">{title}</h3>{hint && <p className="mt-0.5 max-w-md text-[13px] leading-[18px] text-muted">{hint}</p>}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export type Tone = 'neutral' | 'blue' | 'seal' | 'ok' | 'alarm' | 'caution';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-foreground/[0.06] text-muted', blue: 'bg-foreground/10 text-foreground', seal: 'bg-seal/12 text-seal',
  ok: 'bg-success/15 text-success-ink', alarm: 'bg-danger/12 text-danger-ink', caution: 'bg-warning/18 text-warning-ink',
};
export const Chip = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) => (
  <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}>{children}</span>
);
// A seal as it appears in payloads: a solid violet bar, machine text.
export const SealToken = ({ children }: { children: ReactNode }) => <span className="inline-flex items-center rounded-md bg-seal px-1.5 py-px font-mono text-[11px] font-medium text-on-seal">{children}</span>;

export const Empty = ({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) => (
  <div className="grid justify-items-center gap-2 py-12 text-center text-sm text-muted"><span aria-hidden>{icon}</span><p className="max-w-sm">{children}</p>{action}</div>
);

export const Err = ({ children }: { children?: string }) => children ? <p role="alert" className="flex items-start gap-2 text-[13px] text-danger-ink"><XCircle size={16} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />{children}</p> : null;

// Plain tabular list: hairlines only.
export const Table = ({ head, children, num = [] }: { head: string[]; children: ReactNode; num?: number[] }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-[13px]">
      <thead className="text-xs text-muted"><tr>{head.map((h, i) => <th key={h || i} className={`px-3 py-2 font-medium first:pl-0 last:pr-0 ${num.includes(i) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
      <tbody className="[&_td]:px-3 [&_td]:py-2.5 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-t [&_tr]:border-border">{children}</tbody>
    </table>
  </div>
);

export const StatusIcon = ({ state }: { state: 'running' | 'success' | 'failure' }) =>
  state === 'running' ? <Loader2 size={14} aria-label="running" className="animate-spin text-muted" />
    : state === 'success' ? <CheckCircle2 size={14} aria-label="done" className="text-success" /> : <XCircle size={14} aria-label="failed" className="text-danger" />;

export const QuotaBar = ({ used, quota }: { used: number; quota: number }) => {
  const f = Math.min(used / quota, 1);
  return <div role="meter" aria-label="Storage used" aria-valuenow={used} aria-valuemax={quota} className="h-1 overflow-hidden rounded-full bg-foreground/10"><div className={`h-full rounded-full ${f > 0.9 ? 'bg-danger' : 'bg-foreground'}`} style={{ width: `${f * 100}%` }} /></div>;
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
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60]">
      {t && <div className="float pointer-events-auto flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium ring-1 ring-border">
        <span className={`size-2 rounded-full ${t.bad ? 'bg-danger' : 'bg-success'}`} aria-hidden />{t.msg}{t.link && <a className="underline" href={t.link.href}>{t.link.label}</a>}</div>}
    </div>
  );
}

// ---- dialogs: native <dialog> (focus trap, Esc, backdrop). `side` = right-hand sheet ----
export function Dialog({ title, onClose, children, wide, xl, side, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean; side?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const size = side ? 'my-0 mr-0 ml-auto h-dvh max-h-dvh w-[min(34rem,100vw)] rounded-l-xl rounded-r-none' : `m-auto max-h-[90vh] w-full ${xl ? 'max-w-3xl' : wide ? 'max-w-lg' : 'max-w-sm'} rounded-xl`;
  return (
    <dialog ref={ref} aria-labelledby="dlg-t" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}
      className={`${size} float overflow-hidden p-0 text-foreground ring-1 ring-border backdrop:bg-black/40 open:flex open:flex-col`}>
      <div className="grid min-h-0 grow content-start gap-4 overflow-y-auto p-5"><h2 id="dlg-t" className="text-base leading-6 font-semibold">{title}</h2>{children}</div>
      {footer && <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm, onClose, danger = true }: { title: string; body: string; action: string; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="-mt-2 text-sm text-muted">{body}</p>
      <div className="flex justify-end gap-2">
        <button className={buttonGhost} autoFocus onClick={onClose}>Cancel</button>
        <button className={danger ? buttonDangerSolid : buttonPrimary} disabled={done} onClick={() => { setDone(true); onConfirm(); onClose(); }}>{action}</button>
      </div>
    </Dialog>
  );
}

// Element styles for react-markdown: 16/24 prose in the UI font, code in mono.
export const mdComponents = {
  p: (p: ComponentProps<'p'>) => <p className="my-3 first:mt-0 last:mb-0" {...p} />,
  a: (p: ComponentProps<'a'>) => <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  ul: (p: ComponentProps<'ul'>) => <ul className="my-3 list-disc pl-5 marker:text-muted" {...p} />,
  ol: (p: ComponentProps<'ol'>) => <ol className="my-3 list-decimal pl-5 marker:text-muted" {...p} />,
  li: (p: ComponentProps<'li'>) => <li className="my-1" {...p} />,
  h1: (p: ComponentProps<'h1'>) => <h3 className="mt-6 mb-2 text-lg font-semibold" {...p} />,
  h2: (p: ComponentProps<'h2'>) => <h3 className="mt-6 mb-2 text-lg font-semibold" {...p} />,
  h3: (p: ComponentProps<'h3'>) => <h3 className="mt-4 mb-1 font-semibold" {...p} />,
  blockquote: (p: ComponentProps<'blockquote'>) => <blockquote className="my-3 border-l-2 border-border pl-4 text-muted" {...p} />,
  code: (p: ComponentProps<'code'>) => <code className="rounded-md bg-foreground/[0.07] px-1 py-0.5 font-mono text-[0.85em]" {...p} />,
  pre: (p: ComponentProps<'pre'>) => <pre className="my-3 overflow-x-auto rounded-lg bg-foreground/[0.05] p-3 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" {...p} />,
  table: (p: ComponentProps<'table'>) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm" {...p} /></div>,
  th: (p: ComponentProps<'th'>) => <th className="border-b border-border px-2 py-1.5 text-left font-medium" {...p} />,
  td: (p: ComponentProps<'td'>) => <td className="border-b border-border px-2 py-1.5" {...p} />,
};
