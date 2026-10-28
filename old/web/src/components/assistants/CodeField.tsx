import { FlaskConical, Maximize2, Sparkles } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, Input, Select } from '../ui';
import { STARTERS } from './flow';

// CodeMirror (about 400 kB) loads the first time a Code step is opened, not with the canvas.
const CodeMirror = lazy(() => import('./CodeMirror'));
const Loading = <div className="grid h-full min-h-40 place-items-center rounded-md border border-border text-[13px] text-muted-foreground">Loading the editor…</div>;
const PLACEHOLDER = 'Reads the earlier steps as JSON on stdin and prints JSON.';

interface Props { language: string; source: string; timeoutSec: number; onConfig: (patch: Record<string, any>) => void; test?: (wide: boolean) => ReactNode; label?: string }

/** The Code step's form: language, time limit, a real editor, and the same editor at full size next to the test pane. */
export function CodeField({ language, source, timeoutSec, onConfig, test, label }: Props) {
  const [big, setBig] = useState(false);
  const setLanguage = (l: string) => {
    const other = STARTERS[l === 'python' ? 'javascript' : 'python'];
    // an empty box or an untouched starter follows the language; anything the person wrote stays
    onConfig(!source.trim() || source === other ? { language: l, source: STARTERS[l] } : { language: l });
  };
  const editor = (
    <Suspense fallback={Loading}>
      <CodeMirror value={source} onChange={(v) => onConfig({ source: v })} language={language} label={label ?? 'Code'} placeholder={PLACEHOLDER} onRun={() => dispatchEvent(new Event('hefyn-test-run'))} />
    </Suspense>
  );
  return <>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" type="button" onClick={() => setBig(true)}><Maximize2 size={13} aria-hidden />Expand</Button>
      {test && <Button variant="outline" size="sm" type="button" onClick={() => document.querySelector('[data-part="test"]')?.scrollIntoView({ block: 'nearest' })}><FlaskConical size={13} aria-hidden />Test</Button>}
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      <Field label="Language"><Select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="javascript">JavaScript</option><option value="python">Python</option></Select></Field>
      <Field label="Stop after (seconds)"><Input type="number" min={1} max={300} value={timeoutSec} onChange={(e) => onConfig({ timeoutSec: Number(e.target.value) })} /></Field>
    </div>
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span id="code-label">Code</span>
        <span className="flex gap-1">
          {!source.trim() && <Button variant="ghost" size="sm" type="button" className="h-6 px-1.5 text-xs" onClick={() => onConfig({ source: STARTERS[language] })}><Sparkles size={12} aria-hidden />Use a starter</Button>}
        </span>
      </div>
      {!big && <div className="h-72 w-full min-w-0">{editor}</div>}
      {big && <div className="grid h-72 place-items-center rounded-md border border-dashed border-border text-[13px] text-muted-foreground">Open in the large editor.</div>}
    </div>
    <p className="text-[13px] text-muted-foreground">Runs in your sandbox without network access. It gets <code>{'{"input": …, "steps": …}'}</code> on stdin and prints JSON to stdout.</p>
    {!big && test?.(false)}
    <Dialog open={big} onOpenChange={setBig}>
      <DialogContent className="h-[85vh] w-[95vw] max-w-none grid-rows-[auto_minmax(0,1fr)] sm:max-w-[min(1280px,95vw)]">
        <DialogHeader><DialogTitle className="text-base leading-6 font-semibold">{label ?? 'Code'}</DialogTitle></DialogHeader>
        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-h-0">{big && editor}</div>
          <div className="min-h-0 overflow-y-auto">{big && test?.(true)}</div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
