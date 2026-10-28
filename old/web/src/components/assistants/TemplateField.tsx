import type { EditorView } from '@codemirror/view';
import { Maximize2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '../ui';
import { insertAt, type Upstream } from './flow';
import { InsertMenu, Writer } from './Writer';

const CodeMirror = lazy(() => import('./CodeMirror'));

/**
 * A text field. With `refs` it is a template: `{{node.field}}` shows as one token, `{{` suggests the values of earlier steps, and "Insert value" lists them.
 * Long fields (`rows`) are live markdown: it renders as you type, the markup shows only on the caret's line. Without `refs` or `rows` it is a plain input. `rows` makes it a long field: at least that many lines, growing to 60% of the screen, with an Expand button.
 */
export function TemplateField({ label, value, onChange, refs, rows, mono, placeholder, limit }: { label: string; value: string; onChange: (v: string) => void; refs?: Upstream[]; rows?: number; mono?: boolean; placeholder?: string; limit?: number }) {
  const id = useId();
  const [big, setBig] = useState(false);
  const [ro, setRo] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const view = useRef<EditorView>(null);
  useEffect(() => setRo(!!wrap.current?.closest('fieldset:disabled')), []); // a read-only Assistant disables its fieldset; the editor does not know
  const insert = (ref: string) => {
    const v = view.current;
    if (v) { v.dispatch(v.state.replaceSelection(ref)); v.focus(); return; }
    const e = el.current;
    const { text, caret } = insertAt(value, e?.selectionStart ?? value.length, e?.selectionEnd ?? value.length, ref);
    onChange(text);
    requestAnimationFrame(() => { e?.focus(); e?.setSelectionRange(caret, caret); });
  };
  const common = { id, ref: el, value, placeholder, onChange: (e: { target: { value: string } }) => onChange(e.target.value), className: mono ? 'font-mono text-xs' : undefined };
  const minRem = rows ? (rows * 23.8 + 12) / 16 : 2.25;
  const fallback = <div style={{ minHeight: `${minRem}rem` }} className="rounded-lg border border-input" />;
  return (
    <div className="grid gap-1.5 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={refs || rows ? undefined : id} id={`${id}-l`}>{label}</label>
        <span className="flex items-center">
          {refs && !ro && <InsertMenu refs={refs} label={label} onPick={insert} />}
          {rows && <Button variant="ghost" size="sm" type="button" className="h-6 px-1.5 text-xs text-muted-foreground" aria-label={`Expand ${label}`} onClick={() => setBig(true)}><Maximize2 size={12} aria-hidden />Expand</Button>}
        </span>
      </div>
      <div ref={wrap} className={cn('grid min-w-0', mono && '[&_.cm-scroller]:!font-mono [&_.cm-scroller]:!text-xs')}>
        {refs || rows
          ? <Suspense fallback={fallback}><CodeMirror value={value} onChange={onChange} language={refs ? 'template' : 'text'} label={label} placeholder={placeholder} refs={refs} readOnly={ro} viewRef={view} inline={{ minRem, singleLine: !rows }} /></Suspense>
          : <Input {...common} />}
      </div>
      {limit && value.length > limit * 0.5 && <span className={cn('justify-self-end text-xs', value.length > limit ? 'text-danger-ink' : 'text-muted-foreground')}>{value.length.toLocaleString()} / {limit.toLocaleString()}</span>}
      {big && <Writer title={label} value={value} onChange={onChange} refs={refs} limit={limit} mono={mono} readOnly={ro} onClose={() => setBig(false)} />}
    </div>
  );
}
