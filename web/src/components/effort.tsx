import { Brain, ChevronsUpDown } from 'lucide-react';

export const EFFORTS: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
/** Classes for the model picker next to an EffortSelect: it takes what the effort control leaves. */
export const PICKER_CLS = 'w-full min-w-0 max-w-none sm:w-auto sm:flex-1';

/** Thinking effort, styled like the picker trigger. '' = the default; `reasoning === false` (a model that cannot think) disables it. */
export function EffortSelect({ label, value, onChange, reasoning, defaultLabel = 'Default', compact }: { label: string; value: string; onChange: (v: string) => void; reasoning?: boolean; defaultLabel?: string; compact?: boolean }) {
  const none = reasoning === false;
  return (
    <div className={`relative shrink-0 ${compact ? 'w-auto' : 'w-full sm:w-52'} ${none ? 'opacity-60' : ''}`} title={none ? 'This model does not think, so there is no effort to set.' : undefined}>
      <Brain size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
      <select aria-label={label} disabled={none} value={none ? '' : value} onChange={(e) => onChange(e.target.value)}
        className={`h-8 min-w-0 cursor-pointer appearance-none truncate rounded-lg border py-1 pr-7 pl-8 text-[13px] font-medium outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed ${compact ? 'w-auto max-w-[9rem] border-transparent bg-transparent text-muted-foreground hover:text-foreground' : 'w-full border-border bg-background dark:border-input dark:bg-input/30 dark:hover:bg-input/50'}`}>
        {none ? <option value="">No thinking</option> : <>
          <option value="">{defaultLabel}</option>
          {Object.entries(EFFORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </>}
      </select>
      <ChevronsUpDown size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
