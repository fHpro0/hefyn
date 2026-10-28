import { Play, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Chip, Field, shortcut, Textarea } from '../ui';
import { sampleInput, type Flow, type FlowNode } from './flow';

/** What `assistants.testStep` answers (docs/ASSISTANTS.md: trying one step with a sample input). */
export interface TestResult { ok: boolean; output?: { text?: string; json?: unknown }; stdout?: string; stderr?: string; error?: string; ms: number }
/** The sample input and last result of a step: kept with the editor session, never saved to the server. */
export interface TestState { input?: string; result?: TestResult }

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const Out = ({ children }: { children: string }) => <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">{children}</pre>;

/** Try one step (Code, Template, Condition, rule Router) with a sample `{ stepId: output }` and see what it gives. */
export function TestPane({ flow, node, state, onState, wide }: { flow: Flow; node: FlowNode; state: TestState; onState: (p: TestState) => void; wide?: boolean }) {
  const sample = useMemo(() => pretty(sampleInput(flow, node.id)), [node.id]); // a snapshot: editing the step must not overwrite what someone typed
  const text = state.input ?? sample;
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState('');
  useEffect(() => setBad(''), [text]);

  const run = async () => {
    let input: unknown;
    try { input = JSON.parse(text || '{}'); } catch { setBad('The sample input is not valid JSON. Check the commas and quotes.'); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { setBad('The sample input must be an object, like {"start": {"text": "Hello"}}.'); return; }
    setBusy(true);
    try {
      const r = await (trpc as any).assistants.testStep.mutate({ flow, nodeId: node.id, input }); // contract: see TestResult
      onState({ result: r });
    } catch (x) { onState({ result: { ok: false, error: (x as Error).message, ms: 0 } }); }
    finally { setBusy(false); }
  };
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => { const f = () => latest.current(); addEventListener('hefyn-test-run', f); return () => removeEventListener('hefyn-test-run', f); }, []); // the code editor's Mod-Enter
  const r = state.result;

  return (
    <section data-part="test" aria-label="Try this step" className={wide ? 'grid min-h-0 content-start gap-3' : 'grid gap-3 rounded-lg border border-border p-3'}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">Try this step</h3>
        <Button size="sm" disabled={busy} onClick={run} title={shortcut('↵')}>{busy ? <Spinner /> : <Play size={13} aria-hidden />}Run<span className="ml-1 text-xs opacity-70">{shortcut('↵')}</span></Button>
      </div>
      <Button variant="ghost" size="sm" type="button" className="h-6 justify-self-end px-1.5 text-xs text-muted-foreground" onClick={() => onState({ input: sample })}><RotateCcw size={12} aria-hidden />Reset sample</Button>
      <Field label="Sample input (what earlier steps gave)">
        <Textarea rows={wide ? 8 : 5} spellCheck={false} className="font-mono text-xs" value={text} aria-invalid={!!bad} onChange={(e) => onState({ input: e.target.value })}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } }} />
      </Field>
      {bad && <p role="alert" className="text-[13px] text-danger-ink">{bad}</p>}
      {r && (
        <div role="status" className="grid gap-2">
          <div className="flex items-center gap-2 text-[13px]"><Chip tone={r.ok ? 'ok' : 'alarm'}>{r.ok ? 'Worked' : 'Failed'}</Chip><span className="text-muted-foreground">{r.ms} ms</span></div>
          {r.error && <p className="text-[13px] text-danger-ink">{r.error}</p>}
          {r.output?.text !== undefined && <div><div className="mb-1 text-xs text-muted-foreground">Text</div><Out>{r.output.text || '(empty)'}</Out></div>}
          {r.output?.json !== undefined && <div><div className="mb-1 text-xs text-muted-foreground">Data</div><Out>{pretty(r.output.json)}</Out></div>}
          {!!r.stdout && <details><summary className="cursor-pointer text-xs text-muted-foreground">What it printed</summary><Out>{r.stdout}</Out></details>}
          {!!r.stderr && <details open={!r.ok}><summary className="cursor-pointer text-xs text-muted-foreground">Error messages from the script</summary><Out>{r.stderr}</Out></details>}
        </div>
      )}
    </section>
  );
}
