import { ChevronsUpDown } from 'lucide-react';
import { lazy, Suspense, useState, type ComponentProps } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

/** `group` is the heading (a provider, or "Provider · yours" for a personal connection). */
export interface ModelOption { id: string; name: string; group: string; contextWindow?: number; reasoning?: boolean; vision?: boolean }
export interface PickerProps {
  options: ModelOption[]; value: string; onChange: (id: string) => void;
  label?: string; /** the '' entry, e.g. "Default model"; without it the user must choose */ emptyLabel?: string; placeholder?: string;
  name?: string; className?: string; disabled?: boolean;
}

// The list (popover, cmdk) loads on first use, so the trigger stays a plain button in the route bundle.
const List = lazy(() => import('./model-list'));

export function Face({ p }: { p: PickerProps }) {
  const m = p.options.find((o) => o.id === p.value);
  return (
    <>
      <span className="min-w-0 truncate">{m ? m.name : p.value ? p.value : p.value === '' && p.emptyLabel ? p.emptyLabel : p.placeholder ?? 'Choose a model'}</span>
      {m && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{m.group}</span>}
      <ChevronsUpDown size={14} className="ml-auto text-muted-foreground" aria-hidden />
    </>
  );
}

export const triggerCls = (p: PickerProps) => cn('max-w-64 justify-start text-[13px] font-medium', p.className);

export default function ModelPicker(p: PickerProps) {
  const [armed, setArmed] = useState(false);
  const arm = () => setArmed(true);
  const props: ComponentProps<typeof Button> = { variant: 'outline', type: 'button', 'aria-label': p.label ?? 'Model', title: p.options.find((o) => o.id === p.value)?.name, 'aria-haspopup': 'dialog', 'aria-expanded': false, disabled: p.disabled, className: triggerCls(p) };
  return (
    <>
      {p.name && <input type="hidden" name={p.name} value={p.value} />}
      {armed
        ? <Suspense fallback={<Button {...props}><Face p={p} /></Button>}><List {...p} /></Suspense>
        : <Button {...props} onClick={arm} onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), arm())}><Face p={p} /></Button>}
    </>
  );
}
