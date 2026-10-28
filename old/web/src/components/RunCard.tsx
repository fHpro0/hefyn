import { Bot, Code, FileText, GitBranch, MessageCircleQuestion, MessageSquare, Reply, ShieldCheck, Sparkles, Split, Wrench, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Tool, ToolCode, ToolContent, ToolHeader } from './ai-elements';
import { type Item, type Run, type RunStep, type Waiting } from './cli-transcript';
import { Select } from './ui';
import { Elapsed } from './ActivityStatus';
import { elapsed } from './activity';

const CodeMirror = lazy(() => import('./assistants/CodeMirror')); // the same live-markdown editor as the flow fields, in its own chunk

const TYPE_ICON: Record<string, LucideIcon> = { 'trigger.chat': MessageSquare, agent: Bot, assistant: Sparkles, router: GitBranch, condition: Split, approval: ShieldCheck, ask: MessageCircleQuestion, template: FileText, code: Code, tool: Wrench, 'output.reply': Reply, 'output.file': FileText };
const summary = (r: Run) => {
  const n = `${r.steps.length} ${r.steps.length === 1 ? 'step' : 'steps'}`;
  return [r.status === 'failed' ? 'Failed' : r.status === 'cancelled' ? 'Stopped' : '', n, r.startedAt && r.endedAt ? elapsed(r.endedAt - r.startedAt) : ''].filter(Boolean).join(' · ');
};

/** One run of a flow: the step timeline. Open while it runs (or asks), a summary line once it ended. */
export function RunCard({ it, id, renderItem, post }: { it: Run; id: string; renderItem: (it: Item, i: number) => ReactNode; post: (path: string, body: unknown) => Promise<void> }) {
  const [pick, setPick] = useState<boolean>();
  const asking = it.steps.some((s) => s.waiting && s.status === 'running') && it.status === 'running';
  const open = asking || (pick ?? it.status === 'running'); // a question is never hidden; a run that still works stays open
  const active = it.steps.findLast((s) => s.status === 'running')?.label; // the step in the header
  return (
    <Tool open={open} onOpenChange={setPick}>
      <ToolHeader icon={<Sparkles />} state={it.status === 'running' ? 'running' : it.status === 'failed' ? 'error' : 'done'} title={it.status === 'running' ? (asking ? 'Waiting for your answer' : 'Working…') : summary(it)}
        detail={it.status === 'running' && active ? <span className="font-sans">{active}</span> : undefined} ms={it.status === 'running' ? <Elapsed since={it.startedAt} /> : undefined} />
      <ToolContent>
        {it.steps.map((st) => <StepRow key={st.node} st={st} run={it} id={id} renderItem={renderItem} post={post} />)}
        {!it.steps.length && <p className="text-[13px] text-muted-foreground">Starting…</p>}
      </ToolContent>
    </Tool>
  );
}

function StepRow({ st, run, renderItem, post }: { st: RunStep; run: Run; id: string; renderItem: (it: Item, i: number) => ReactNode; post: (path: string, body: unknown) => Promise<void> }) {
  const Icon = TYPE_ICON[st.type] ?? Wrench;
  const hasOut = !!st.text || st.json !== undefined, detail = hasOut || st.items.length > 0 || !!st.error;
  const skipped = st.status === 'skipped';
  const body = (
    <>
      {st.error && <p className="text-sm text-danger-ink">{st.error}</p>}
      {st.items.map((x, i) => renderItem(x, i))}
      {st.text && <ToolCode code={st.text} lang="text" title="Output" />}
      {st.json !== undefined && <ToolCode code={JSON.stringify(st.json, null, 2) ?? ''} lang="json" title="Output" />}
    </>
  );
  return (
    <div className={skipped ? 'text-muted-foreground' : undefined}>
      {detail ? (
        <Tool defaultOpen={st.status === 'failed' || (st.status === 'running' && st.items.some((x) => x.kind === 'run'))}>
          <ToolHeader icon={<Icon />} state={st.status === 'failed' ? 'error' : st.status === 'running' ? 'running' : skipped ? 'pending' : 'done'} title={st.label} badge={skipped ? <span className="text-xs">skipped</span> : undefined} />
          <ToolContent>{body}</ToolContent>
        </Tool>
      ) : (
        <ToolHeaderOnly state={st.status} Icon={Icon} label={st.label} />
      )}
      {st.waiting && <WaitCard w={st.waiting} open={st.status === 'running' && run.status === 'running'} run={run.runId} node={st.node} post={post} />}
    </div>
  );
}

/** A step with nothing to expand: the same line without a trigger. */
function ToolHeaderOnly({ state, Icon, label }: { state: RunStep['status']; Icon: LucideIcon; label: string }) {
  return (
    <div className={`flex items-center gap-2 py-1 text-[13px] ${state === 'failed' ? 'text-destructive' : state === 'skipped' ? 'text-muted-foreground' : 'text-foreground'}`}>
      <Icon size={14} aria-hidden className="shrink-0" /><span className="font-medium">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{state === 'running' ? 'running…' : state === 'done' ? '✓' : state === 'failed' ? '✕ failed' : 'skipped'}</span>
    </div>
  );
}

/** An approval or an ask inside the run. Answers POST once; the card locks and keeps the answer in one line. */
function WaitCard({ w, open, run, node, post }: { w: Waiting; open: boolean; run: string; node: string; post: (path: string, body: unknown) => Promise<void> }) {
  const [text, setText] = useState(w.content ?? '');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string>(); // the compact line shown once answered
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLElement>(null);
  const [grab] = useState(() => { const a = document.activeElement; return !(a instanceof HTMLTextAreaElement && a.value); }); // do not steal the caret from a half-written message
  useEffect(() => { // focus the first control, unless the reader is mid-sentence in the composer
    const a = document.activeElement;
    if (open && !(a instanceof HTMLTextAreaElement && a.value)) card.current?.querySelector<HTMLElement>('[data-first]')?.focus();
  }, []);
  const answer = async (body: Record<string, unknown>, shown: string) => {
    setBusy(true);
    try { await post('/answer', { runId: run, node, ...body }); setSent(shown); } catch { setBusy(false); } // cliPost's refusal shows in the chat; the card stays open to retry
  };
  if (!open || sent !== undefined) return <p className="py-1 text-[13px] text-muted-foreground">{sent ?? 'Answered'}</p>;
  const fields = w.fields?.length ? w.fields : undefined;
  return (
    <section ref={card} aria-label={w.kind === 'approval' ? 'Approval needed' : 'Question'} className="my-2 grid gap-2.5 rounded-xl border border-border bg-card p-3.5 text-card-foreground">
      <p className="text-[13px] font-medium whitespace-pre-wrap">{w.message}</p>
      {w.kind === 'approval' ? (
        <>
          {(w.editable || !!w.content) && (
            <Suspense fallback={<div className="min-h-24 rounded-lg border border-input" />}>
              <CodeMirror value={w.editable ? text : w.content ?? ''} onChange={setText} language="text" label={w.editable ? 'Text to approve' : 'Text to approve (read only)'} readOnly={busy || !w.editable} autoFocus={w.editable && grab} inline={{ minRem: w.editable ? 6 : 1.5 }} />
            </Suspense>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => answer({ approved: false }, 'Rejected')}>Reject</Button>
            <Button type="button" size="sm" data-first={w.editable ? undefined : ''} disabled={busy} onClick={() => answer({ approved: true, ...(w.editable && { text }) }, w.editable && text !== w.content ? 'Approved with your edits' : 'Approved')}>Approve</Button>
          </div>
        </>
      ) : (
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (fields) answer({ answers: vals }, fields.map((f) => `${f.label}: ${vals[f.name] ?? ''}`).join(' · ')); else if (text.trim()) answer({ text }, text.trim()); }}>
          {fields ? fields.map((f, i) => (
            <label key={f.name} className="grid gap-1 text-xs font-medium text-muted-foreground">{f.label}
              {f.type === 'choice'
                ? <Select data-first={i === 0 ? '' : undefined} value={vals[f.name] ?? ''} disabled={busy} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}><option value="" disabled>Choose…</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                : <Input data-first={i === 0 ? '' : undefined} value={vals[f.name] ?? ''} disabled={busy} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />}
            </label>
          )) : <Textarea data-first aria-label="Your answer" rows={2} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />}
          <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy || (fields ? fields.some((f) => !vals[f.name]) : !text.trim())}>Send</Button></div>
        </form>
      )}
    </section>
  );
}
