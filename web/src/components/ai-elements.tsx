import { ArrowUp, Bot, Brain, Check, ChevronRight, Circle, Clock, Link2, Square, X, XCircle } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Spinner } from '@/ui/spinner';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/ui/trace';
import { Loading } from './ui';

// AI Elements patterns (https://ui.shadcn.com/docs/ai-elements/base/plan, /task, /confirmation) composed from our shadcn primitives.
// Same part names as the docs, so a later chat rework can swap in the originals.

export const Plan = ({ className, ...p }: ComponentProps<'section'>) => <section data-slot="plan" className={cn('rounded-xl border border-border bg-card text-card-foreground', className)} {...p} />;
export const PlanHeader = ({ className, ...p }: ComponentProps<'header'>) => <header data-slot="plan-header" className={cn('flex flex-wrap items-start justify-between gap-3 px-4 pt-4', className)} {...p} />;
export const PlanTitle = ({ className, ...p }: ComponentProps<'h2'>) => <h2 data-slot="plan-title" className={cn('text-[15px] leading-6 font-semibold', className)} {...p} />;
export const PlanDescription = ({ className, ...p }: ComponentProps<'p'>) => <p data-slot="plan-description" className={cn('mt-0.5 text-[13px] leading-[18px] text-muted-foreground', className)} {...p} />;
export const PlanContent = ({ className, ...p }: ComponentProps<'div'>) => <div data-slot="plan-content" className={cn('px-4 py-4', className)} {...p} />;

/** A collapsible unit of work: the trigger is the always-visible line, the content its details. */
export const Task = ({ className, ...p }: ComponentProps<typeof Collapsible>) => <Collapsible data-slot="task" className={cn('min-w-0', className)} {...p} />;
export const TaskTrigger = ({ className, ...p }: ComponentProps<typeof CollapsibleTrigger>) => (
  <CollapsibleTrigger data-slot="task-trigger" className={cn('group/task flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50', className)} {...p} />
);
export const TaskContent = ({ className, ...p }: ComponentProps<typeof CollapsibleContent>) => <CollapsibleContent data-slot="task-content" className={cn('ml-2 grid min-w-0 gap-3 border-l border-border py-2 pl-5', className)} {...p} />;

/** Approval request. Put the question in `title`, the buttons in `actions`; `state` swaps them for the outcome. */
export function Confirmation({ title, children, actions, state, className }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; state: 'requested' | 'approved' | 'rejected'; className?: string }) {
  return (
    <Alert data-slot="confirmation" data-state={state} className={cn('grid-cols-1 gap-3', className)}>
      <div data-slot="confirmation-title" className="text-[13px] font-medium">{title}</div>
      {children}
      {state === 'requested' && actions && <div data-slot="confirmation-actions" className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </Alert>
  );
}

// ---- chat: Message, Reasoning, Tool, Subagent, Terminal, Queue, Sources, Suggestion, PromptInput (same part names as the docs) ----
const ChatCode = lazy(() => import('./chat-code')); // shiki loads when a line is first expanded

/** from="user": a subtle surface block, full column width; from="assistant": prose at 68ch. */
export const Message = ({ from, className, ...p }: ComponentProps<'div'> & { from: 'user' | 'assistant' }) => <div data-slot="message" data-from={from} className={cn('group grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2', className)} {...p} />;
export const MessageContent = ({ className, ...p }: ComponentProps<'div'>) => (
  <div data-slot="message-content" className={cn('min-w-0 group-data-[from=assistant]:max-w-[68ch] group-data-[from=assistant]:text-[1.143rem] group-data-[from=assistant]:leading-[1.857rem] group-data-[from=user]:grid group-data-[from=user]:gap-2 group-data-[from=user]:rounded-[10px] group-data-[from=user]:border group-data-[from=user]:border-border group-data-[from=user]:bg-surface group-data-[from=user]:px-4 group-data-[from=user]:py-3 group-data-[from=user]:text-[1.071rem] group-data-[from=user]:leading-[1.714rem] group-data-[from=user]:whitespace-pre-wrap', className)} {...p} />
);
export const MessageActions = ({ className, ...p }: ComponentProps<'div'>) => <div data-slot="message-actions" className={cn('-ml-1.5 flex gap-0.5 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0', className)} {...p} />;

export const Chevron = () => <ChevronRight size={14} aria-hidden className="shrink-0 text-muted-foreground transition-transform group-aria-expanded/task:rotate-90" />;
type RunState = 'running' | 'done' | 'error' | 'waiting' | 'pending';
const STATE_ICON: Record<RunState, ReactNode> = {
  running: <Spinner aria-label="running" className="size-3.5" />, done: <Check aria-label="done" className="text-success" />, error: <XCircle aria-label="failed" />, waiting: <Clock aria-label="waiting" />, pending: <Circle aria-label="pending" />,
};
/** The always-visible line of a Tool / Subagent / Task: status icon, title, detail, duration. */
export function ToolHeader({ title, detail, state, ms, icon, badge, className }: { title: ReactNode; detail?: ReactNode; state: RunState; ms?: ReactNode; icon?: ReactNode; badge?: ReactNode; className?: string }) {
  return (
    <TaskTrigger>
      <TraceLine status={state === 'running' ? 'running' : state === 'error' ? 'error' : undefined} className={cn('w-full font-mono text-[0.893rem] data-[status=error]:text-destructive', className)}>
        <TraceIcon>{state === 'running' || state === 'error' || !icon ? STATE_ICON[state] : icon}</TraceIcon>
        <TraceTitle className="shrink-0">{title}</TraceTitle>{badge}
        {detail && <TraceDescription className="min-w-0 grow truncate">{detail}</TraceDescription>}
        {ms && <TraceDescription className="ml-auto">{ms}</TraceDescription>}
        <Chevron />
      </TraceLine>
    </TaskTrigger>
  );
}
export const Tool = Task;
export const ToolContent = TaskContent;
export const Label = ({ children }: { children: ReactNode }) => <div className="mb-1 text-xs font-medium text-muted-foreground">{children}</div>;
/** Input / output as a CodeBlock (lazy). */
export function ToolCode({ code, lang, title, error }: { code: string; lang?: string; title: string; error?: boolean }) {
  return <Suspense fallback={<Loading n={4} className="rounded-lg border border-input p-3 text-xs" />}><ChatCode code={code} lang={lang} title={title} destructive={error} /></Suspense>;
}
export const ToolInput = ({ input }: { input: unknown }) => <ToolCode code={JSON.stringify(input, null, 2) ?? ''} title="Input" />;
export const ToolOutput = ({ output, errorText }: { output?: string; errorText?: string }) => (errorText || output ? <ToolCode code={errorText ?? output ?? ''} lang="text" title={errorText ? 'Error' : 'Output'} error={!!errorText} /> : null);

/** Thinking: open while streaming, then "Thought for Ns". */
export function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const t0 = useRef(Date.now()); const [secs, setSecs] = useState<number>(); const [open, setOpen] = useState<boolean>();
  useEffect(() => { if (!streaming) return; return () => setSecs(Math.max(1, Math.round((Date.now() - t0.current) / 1000))); }, [streaming]); // only a live part knows how long it took
  return (
    <Task open={open ?? !!streaming} onOpenChange={setOpen}>
      <ToolHeader icon={<Brain />} state={streaming ? 'running' : 'done'} title={<span className="font-normal text-muted-foreground">{streaming ? 'Thinking…' : secs ? `Thought for ${secs}s` : 'Thought'}</span>} />
      <TaskContent><p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">{text}</p></TaskContent>
    </Task>
  );
}

/** A hand-off to another agent: badge with the agent name and its model, the task, the result. Indents with a seal-coloured rail. */
export const Subagent = ({ className, ...p }: ComponentProps<typeof Task>) => <Task className={cn('[&_[data-slot=task-content]]:border-seal [&_[data-slot=task-content]]:border-l-2', className)} {...p} />;
export const SubagentHeader = ({ name, model, task, state, ms }: { name: string; model?: string; task?: ReactNode; state: RunState; ms?: ReactNode }) => (
  <ToolHeader state={state} title={<Badge className="bg-seal/12 text-seal"><Bot />{name}</Badge>} badge={model ? <Badge variant="outline" className="font-mono font-normal text-muted-foreground">{model.split('/').pop()}</Badge> : undefined} detail={task} ms={ms} />
);
export const SubagentContent = TaskContent;

/** Shell output: dark in both themes, like the terminal drawer. */
export function Terminal({ command, stdout, stderr, text, exit, running }: { command: string; stdout?: string; stderr?: string; text?: string; exit?: number; running?: boolean }) {
  const pre = 'max-h-72 overflow-auto font-mono text-[13px] leading-5 break-words whitespace-pre-wrap';
  return (
    <div data-slot="terminal" className="grid gap-1.5 rounded-lg bg-[#09090b] p-3 text-[#fafafa] ring-1 ring-border">
      <div className="font-mono text-[13px] break-words whitespace-pre-wrap"><span className="text-[#3dd68c]">$</span> {command}</div>
      {running && <div className="font-mono text-[13px] text-[#9aa2bf]">running…</div>}
      {stdout !== undefined || stderr !== undefined ? <>{stdout && <pre className={pre}>{stdout}</pre>}{stderr && <pre className={cn(pre, 'text-[#ff6369]')}>{stderr}</pre>}</> : text && <pre className={cn(pre, exit ? 'text-[#ff8f93]' : 'text-[#e6e9f5]')}>{text}</pre>}
      {!!exit && <div className="font-mono text-xs text-[#ff6369]">exit {exit}</div>}
    </div>
  );
}

/** Messages waiting for the current answer to finish; each can be removed (or sent now when the run stopped). */
export const Queue = ({ className, ...p }: ComponentProps<'section'>) => <section data-slot="queue" aria-label="Queued messages" className={cn('mb-2 grid gap-0.5 rounded-xl border border-border bg-background p-1.5 shadow-float dark:bg-raised', className)} {...p} />;
export const QueueItem = ({ text, onRemove, onSend }: { text: string; onRemove: () => void; onSend?: () => void }) => (
  <div data-slot="queue-item" className="group/queue flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] hover:bg-muted">
    <Circle size={12} aria-hidden className="shrink-0 text-muted-foreground" /><span className="min-w-0 grow truncate">{text}</span>
    {onSend && <Button type="button" variant="ghost" size="xs" onClick={onSend}>Send now</Button>}
    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove “${text}” from the queue`} className="text-muted-foreground" onClick={onRemove}><X size={14} aria-hidden /></Button>
  </div>
);

/** "Used N sources", collapsed. */
export function Sources({ children, count }: { children: ReactNode; count: number }) {
  return (
    <Task className="max-w-[68ch]">
      <TaskTrigger><TraceLine><TraceIcon><Link2 /></TraceIcon><TraceTitle>Used {count} {count === 1 ? 'source' : 'sources'}</TraceTitle><Chevron /></TraceLine></TaskTrigger>
      <TaskContent><ul className="grid gap-1.5 text-[13px]">{children}</ul></TaskContent>
    </Task>
  );
}
export const Source = ({ href, title, icon }: { href: string; title: string; icon?: ReactNode }) => (
  <li><a href={href} target={/^https?:/.test(href) ? '_blank' : undefined} rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{icon ?? <Link2 size={13} aria-hidden />}<span className="truncate">{title}</span></a></li>
);

export const Suggestion = ({ className, ...p }: ComponentProps<typeof Button>) => <Button type="button" variant="outline" size="sm" data-slot="suggestion" className={cn('rounded-full text-[13px] text-muted-foreground hover:text-foreground', className)} {...p} />;

/** The composer: textarea on top, tools and submit below. */
export const PromptInput = ({ className, ...p }: ComponentProps<'div'>) => <div data-slot="prompt-input" className={cn('relative flex flex-col rounded-2xl border border-border bg-background p-2 shadow-float focus-within:border-foreground/40 dark:bg-raised', className)} {...p} />;
export const PromptInputTools = ({ className, ...p }: ComponentProps<'div'>) => <div data-slot="prompt-input-tools" className={cn('flex items-center gap-1 pt-1', className)} {...p} />;
/** While busy: Stop, or "Queue message" once something is typed. */
export const PromptInputSubmit = ({ busy, onStop, disabled, typed }: { busy?: boolean; onStop: () => void; disabled?: boolean; typed?: boolean }) => busy && !typed
  ? <Button type="button" size="icon" className="ml-auto shrink-0 rounded-full" aria-label="Stop" title="Stop (Esc)" onClick={onStop}><Square size={14} fill="currentColor" aria-hidden /></Button>
  : <Button type="submit" size="icon" className="ml-auto shrink-0 rounded-full disabled:opacity-30" aria-label={busy ? 'Queue message' : 'Send'} title={busy ? 'Queue message: sent when the answer is done' : undefined} disabled={disabled}><ArrowUp size={16} /></Button>;
