import { CheckCircle2, XCircle } from 'lucide-react';
import { AsciiReveal, AsciiSkeleton } from 'ascii-reveal';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { buttonVariants } from '@/ui/button';
import { Empty as ShEmpty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from '@/ui/empty';
import { Field as ShField } from '@/ui/field';
import { Input as ShInput } from '@/ui/input';
import { Kbd as ShKbd } from '@/ui/kbd';
import { Label } from '@/ui/label';
import { NativeSelect } from '@/ui/native-select';
import { Spinner } from '@/ui/spinner';
import { Switch as ShSwitch } from '@/ui/switch';
import { Textarea as ShTextarea } from '@/ui/textarea';

// Heavier pieces live in their own modules so a page only bundles what it uses:
// ./dialogs (Dialog, ConfirmDialog), ./toast (toast, Toaster), ./data (Table, QuotaBar), ./markdown (Md).

// ---- controls: 32 px high, radius 8 (shadcn/ui on Base UI, tokens in styles/app.css) ----
// Danger looks for <Button className=…>; everything else uses <Button variant=…> from '@/ui/button'.
export const buttonDanger = cn(buttonVariants({ variant: 'outline' }), 'border-danger/40 text-danger-ink hover:bg-danger/10 hover:text-danger-ink');
// shadcn's destructive is a red tint; confirm actions are filled (docs/UI-DESIGN.md).
export const buttonDangerSolid = cn(buttonVariants({ variant: 'destructive' }), 'bg-destructive text-background hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90');

// Modifier key label: Command on Apple platforms, Ctrl elsewhere.
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcut = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);
export const Kbd = ({ children }: { children: ReactNode }) => <ShKbd>{children}</ShKbd>;

export const Wordmark = ({ height = 22 }: { height?: number }) => (
  <AsciiReveal preset="dither" origin="top-left">
    <img src="/brand/hefyn-wordmark.svg" alt="hefyn" height={height} style={{ height }} className="dark:hidden" />
    <img src="/brand/hefyn-wordmark-white.svg" alt="hefyn" height={height} style={{ height }} className="hidden dark:block" />
  </AsciiReveal>
);

// The split "h" of hefyn-mark.svg on a 13x9 grid of plain ASCII (density ramp, so any mono font draws it); decodes in on mount.
const MARK = [
  '*@@@%',
  '@@@@%',
  '@@@@% .::::::',
  '@@@@%+@@@@@@@',
  '@@@@%+@@@@@@@',
  '@@@@% .: %%%%',
  '@@@@%   +@@@@',
  '@@@@%   +@@@@',
  '*@@@%   +@@@*',
].join('\n');
export const AsciiMark = ({ className = '' }: { className?: string }) => (
  <div className={className}>
    <span className="sr-only">hefyn</span>
    <AsciiReveal preset="dither" origin="top-left"><pre aria-hidden className="font-mono text-[13px] leading-[14px] font-medium text-left text-seal select-none">{MARK}</pre></AsciiReveal>
  </div>
);

// The label wraps the control so clicking it focuses it, as before.
export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <ShField className={className}><Label className="grid w-full gap-1.5 text-[13px] leading-normal"><span>{label}</span>{children}</Label></ShField>;
}
export const Input = (p: ComponentProps<'input'>) => <ShInput {...p} />;
// NativeSelect wraps the <select> in a div: className goes on the wrapper (width, margin), everything else on the <select>.
export const Select = ({ className, ...p }: Omit<ComponentProps<'select'>, 'size'>) => <NativeSelect className={cn('w-full', className)} {...p} />;
export const Textarea = (p: ComponentProps<'textarea'>) => <ShTextarea {...p} />;

export function Switch({ checked, onChange, label, disabled, tone }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; tone?: 'caution' }) {
  return <ShSwitch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} className={tone === 'caution' ? 'data-checked:bg-warning' : undefined} />;
}

// ---- page structure ----
export function Page({ title, hint, actions, children, wide }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} px-6 py-6`}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl leading-7 font-semibold tracking-[-0.02em]">{title}</h1>{hint && <p className="mt-0.5 max-w-xl text-sm leading-[22px] text-muted-foreground">{hint}</p>}</div>
        {actions}
      </header>
      <div className="mt-5">{children}</div>
    </div>
  );
}

// A titled group of Rows.
export const Section = ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
  <section className="mt-7 first:mt-0">{title && <h2 className="mb-2 text-[13px] leading-6 font-medium text-muted-foreground">{title}</h2>}<div className="border-t border-border">{children}</div></section>
);

// Settings row: label and one line of help on the left, the control on the right.
export function Row({ title, hint, children, compact, wide }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; compact?: boolean; wide?: boolean }) {
  return (
    <div className={`grid items-start gap-x-8 gap-y-2 border-b border-border ${compact ? 'py-2.5' : 'py-4'} ${wide ? 'md:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]' : 'md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]'}`}>
      <div><h3 className="text-[13px] font-medium">{title}</h3>{hint && <p className="mt-0.5 max-w-md text-[13px] leading-[18px] text-muted-foreground">{hint}</p>}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export type Tone = 'neutral' | 'blue' | 'seal' | 'ok' | 'alarm' | 'caution';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-foreground/[0.06] text-muted-foreground', blue: 'bg-foreground/10 text-foreground', seal: 'bg-seal/12 text-seal',
  ok: 'bg-success/15 text-success-ink', alarm: 'bg-danger/12 text-danger-ink', caution: 'bg-warning/18 text-warning-ink',
};
export const Chip = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) => (
  <Badge variant="secondary" className={cn('rounded-md', toneClass[tone])}>{children}</Badge>
);

export const Empty = ({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) => (
  <ShEmpty className="py-12">
    <EmptyHeader><EmptyMedia aria-hidden>{icon}</EmptyMedia><EmptyDescription>{children}</EmptyDescription></EmptyHeader>
    {action && <EmptyContent>{action}</EmptyContent>}
  </ShEmpty>
);

/** ASCII placeholder while data loads: `lines` a paragraph, `rows` a list, `cards` a grid. `n` = how many. */
export function Loading({ shape = 'lines', n, className }: { shape?: 'lines' | 'rows' | 'cards'; n?: number; className?: string }) {
  const k = n ?? (shape === 'lines' ? 3 : shape === 'rows' ? 4 : 6);
  return (
    <div role="status" className={cn('font-mono text-[13px] text-muted-foreground', shape === 'rows' && 'grid gap-3', shape === 'cards' && 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)} style={{ '--ascii-font': 'var(--font-mono)' } as CSSProperties}>
      <span className="sr-only">Loading…</span>
      {shape === 'lines' ? <AsciiSkeleton as="div" variant="dither" lines={k} />
        : Array.from({ length: k }, (_, i) => shape === 'rows' ? <AsciiSkeleton key={i} as="div" variant="dither" lines={1} seed={i} /> : <AsciiSkeleton key={i} as="div" variant="dither" rows={5} width="100%" seed={i} />)}
    </div>
  );
}

/** Shows `fallback` (a <Loading/>) while `loading`, then decodes the children in. */
export const Reveal = ({ loading, fallback = <Loading />, children }: { loading: boolean; fallback?: ReactNode; children: ReactNode }) => (
  <AsciiReveal loading={loading} revealOnMount={false} preset="dither" origin="top-left">{loading ? fallback : children}</AsciiReveal>
);

export const Err = ({ children }: { children?: string }) => children ? (
  <Alert variant="destructive" className="border-0 bg-transparent p-0 text-[13px] text-danger-ink">
    <XCircle size={16} strokeWidth={1.75} aria-hidden /><AlertDescription className="text-danger-ink">{children}</AlertDescription>
  </Alert>
) : null;

export const StatusIcon = ({ state }: { state: 'running' | 'success' | 'failure' }) =>
  state === 'running' ? <Spinner aria-label="running" className="size-3.5 text-muted-foreground" />
    : state === 'success' ? <CheckCircle2 size={14} aria-label="done" className="text-success" /> : <XCircle size={14} aria-label="failed" className="text-danger" />;

