import type { EditorView } from '@codemirror/view';
import { Braces } from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { shortcut } from '../ui';
import type { Upstream } from './flow';

const CodeMirror = lazy(() => import('./CodeMirror'));

/** "Insert value": what earlier steps offer as {{node.field}}. */
export function InsertMenu({ refs, label, onPick }: { refs: Upstream[]; label: string; onPick: (ref: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" type="button" className="h-6 px-1.5 text-xs text-muted-foreground" disabled={!refs.length} title={refs.length ? undefined : 'Connect an earlier step first'} aria-label={`Insert value into ${label}`} />}><Braces size={13} aria-hidden />Insert value</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
        {refs.map((u) => (
          <DropdownMenuGroup key={u.id}>
            <DropdownMenuLabel>{u.label}</DropdownMenuLabel>
            {u.refs.map((r) => <DropdownMenuItem key={r} className="font-mono text-xs" onClick={() => onPick(r)}>{r}</DropdownMenuItem>)}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The large writing view of a long text field. Edits apply live (the field behind it is the same value); Esc or the shortcut closes. `refs` set = a template: {{…}} shows as a token and values can be inserted. */
export function Writer({ title, value, onChange, onClose, refs, limit, mono, readOnly }: { title: string; value: string; onChange: (v: string) => void; onClose: () => void; refs?: Upstream[]; limit?: number; mono?: boolean; readOnly?: boolean }) {
  const view = useRef<EditorView>(null);
  const insert = (r: string) => { const v = view.current; if (v) { v.dispatch(v.state.replaceSelection(r)); v.focus(); } };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="h-[85vh] w-[95vw] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[min(1000px,95vw)]">
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-8">
          <DialogTitle className="text-base leading-6 font-semibold">{title}</DialogTitle>
          {refs && !readOnly && <InsertMenu refs={refs} label={title} onPick={insert} />}
        </DialogHeader>
        <div className="min-h-0">
          <Suspense fallback={<div className="grid h-full place-items-center text-[13px] text-muted-foreground">Loading the editor…</div>}>
            <CodeMirror value={value} onChange={onChange} language={mono ? 'text-mono' : refs ? 'template' : 'text'} label={title} onRun={onClose} viewRef={view} autoFocus refs={refs} readOnly={readOnly} />
          </Suspense>
        </div>
        <p className="flex justify-between text-xs text-muted-foreground"><span>Changes apply as you type. {shortcut('↵')} or Esc to close.</span>{limit && <span className={value.length > limit ? 'text-danger-ink' : undefined}>{value.length.toLocaleString()} / {limit.toLocaleString()}</span>}</p>
      </DialogContent>
    </Dialog>
  );
}
