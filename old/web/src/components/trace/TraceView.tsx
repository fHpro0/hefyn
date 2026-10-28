import { ArrowLeft, Bot, Brain, ChevronRight, ChevronsUpDown, Cpu, Info, MessageSquare, Network, Search,User, Wrench, XCircle } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { copyItem, MenuArea } from '../AppMenu';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/ui/trace';
import { trpc } from '@/lib/trpc';
import { money } from '../api';
import { Label, Task, TaskContent, TaskTrigger } from '../ai-elements';
import { Page, Err, Kbd } from '../ui';
import { buildConversation, filter, totals, type ConvTrace, type Instr, type Item, type Kind } from './build';

const ChatCode = lazy(() => import('../chat-code')); // shiki loads when an input or output is first opened

const ICON: Record<Kind, ReactNode> = { user: <User />, system: <Info />, response: <Bot />, model: <Cpu />, tool: <Wrench />, subagent: <Network />, reasoning: <Brain />, text: <MessageSquare />, error: <XCircle /> };
const fmt = (ms?: number) => ms === undefined || Number.isNaN(ms) ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`;
const SHORT = 1200;

/** A value, long ones cut with "Show all". Strings as text, anything else as JSON. */
function Val({ title, value }: { title: string; value: unknown }) {
  const [all, setAll] = useState(false);
  if (value === undefined || value === '') return null;
  const isStr = typeof value === 'string';
  const full = isStr ? value : JSON.stringify(value, null, 2) ?? '';
  const cut = !all && full.length > SHORT;
  const shown = cut ? full.slice(0, SHORT) : full;
  return (
    <div className="grid min-w-0 gap-1">
      {isStr
        ? <><Label>{title}</Label><pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface p-2.5 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap">{shown}{cut && '…'}</pre></>
        : <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}><ChatCode code={shown + (cut ? '\n…' : '')} title={title} /></Suspense>}
      {full.length > SHORT && <Button variant="ghost" size="sm" className="w-fit text-xs" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all (${full.length.toLocaleString()} characters)`}</Button>}
    </div>
  );
}

function Left({ it }: { it: Item }) {
  const c = it.call!, u = c.usage;
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-surface p-3 text-[13px]">
      <div className="flex items-center gap-1.5 font-medium">Sent to {c.provider}/{c.model}</div>
      <div className="tabular-nums text-muted-foreground">Tokens: {u.input.toLocaleString()} in, {u.output.toLocaleString()} out{u.cacheRead || u.cacheWrite ? `, cache ${u.cacheRead.toLocaleString()} read / ${u.cacheWrite.toLocaleString()} written` : ''} · {money(u.cost)}</div>
    </div>
  );
}

function Instructions({ a }: { a: Instr }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Instructions it got ({a.agent})</CollapsibleTrigger>
      <CollapsibleContent><pre className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-border bg-surface p-2.5 text-[12.5px] leading-5 whitespace-pre-wrap">{a.instructions}</pre></CollapsibleContent>
    </Collapsible>
  );
}

function Body({ it }: { it: Item }) {
  return (
    <>
      {it.call && <Left it={it} />}
      <Val title="Input" value={it.input} />
      <Val title={it.kind === 'error' ? 'Error' : 'Output'} value={it.output} />
      {it.text !== undefined && it.kind !== 'response' && <Val title={it.kind === 'reasoning' ? 'Reasoning' : 'Text'} value={it.text} />}
      {it.instructions && it.kind !== 'text' && <Instructions a={it.instructions} />}
      {it.children.map((k) => <Node key={k.key} it={k} />)}
    </>
  );
}

// The open state lives here, not per row, so a search can open every match and clearing it restores what the reader had.
let ctx = { q: '', open: {} as Record<string, boolean>, set: (_k: string, _v: boolean) => {} };

function Node({ it }: { it: Item }) {
  const open = ctx.open[it.key] ?? !!ctx.q;
  const has = it.children.length > 0 || it.input !== undefined || it.output !== undefined || it.text || it.call || it.instructions;
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');
  return (
    <MenuArea items={() => <>
      {has && <DropdownMenuItem className="text-[13px]" onClick={() => ctx.set(it.key, !open)}><ChevronsUpDown size={15} strokeWidth={1.75} aria-hidden />{open ? 'Collapse' : 'Expand'}</DropdownMenuItem>}
      {it.input !== undefined && copyItem('Copy input', str(it.input), 'Input')}
      {it.output !== undefined && copyItem('Copy output', str(it.output), 'Output')}
      {!!it.text && copyItem('Copy text', it.text, 'Text')}</>}>
    <Task open={open} onOpenChange={(v) => ctx.set(it.key, v)} data-trace-item>
      <TaskTrigger data-trace-trigger disabled={!has}>
        <TraceLine status={it.status === 'running' ? 'running' : it.status === 'error' ? 'error' : undefined} className="w-full text-foreground data-[status=error]:text-destructive">
          <TraceIcon>{it.status === 'running' ? <Spinner aria-label="running" className="size-3.5" /> : ICON[it.kind]}</TraceIcon>
          <TraceTitle className="shrink-0 font-medium">{it.title}</TraceTitle>
          {it.models.slice(0, 2).map((m) => <Badge key={m} variant="outline" className="shrink-0 font-mono text-[11px]">{m}</Badge>)}
          <TraceDescription className="min-w-0 shrink grow truncate text-[13px]">{it.detail}</TraceDescription>
          <TraceDescription className="ml-auto hidden sm:inline">{it.startMs !== undefined && `+${fmt(Math.max(0, it.startMs))}`}</TraceDescription>
          <TraceDescription className="w-14 text-right">{fmt(it.durMs)}</TraceDescription>
          {has && <ChevronRight size={14} aria-hidden className="shrink-0 text-muted-foreground transition-transform group-aria-expanded/task:rotate-90" />}
        </TraceLine>
      </TaskTrigger>
      {has && <TaskContent><Body it={it} /></TaskContent>}
    </Task></MenuArea>
  );
}

interface Loaded { title: string; link: string; linkLabel: string; subtitle: string; items: Item[]; instructions: Instr[]; project: string | null; notes: string[] }

async function load(id: string): Promise<Loaded> {
  const t = await trpc.trace.get.query({ id }) as ConvTrace;
  const first = [t.messages[0]?.timestamp, t.calls[0]?.ts, t.createdAt].map((x) => Date.parse(x ?? '')).find((x) => !Number.isNaN(x)) ?? Date.now();
  return {
    title: t.title, link: `/#${id}`, linkLabel: 'Open chat', items: buildConversation(t, first), instructions: t.instructions, project: t.projectInstructions,
    subtitle: t.model ?? '',
    notes: t.historyError ? [t.historyError] : [],
  };
}

export default function TraceView() {
  const [id, setId] = useState(location.hash.slice(1));
  const [data, setData] = useState<Loaded>();
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { const f = () => setId(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => {
    setData(undefined); setErr(''); setOpen({});
    if (id) load(id).then(setData, (x) => setErr(x.message));
  }, [id]);
  useEffect(() => { // j / k move between rows, Enter opens the focused one (a plain button), / searches
    const f = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('input[data-trace-search]')?.focus(); return; }
      if (e.key !== 'j' && e.key !== 'k') return;
      const rows = [...document.querySelectorAll<HTMLElement>('[data-trace-trigger]:not([disabled])')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[e.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
      next?.focus(); next?.scrollIntoView({ block: 'nearest' });
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const q = query.trim().toLowerCase();
  ctx = { q, open, set: (k, v) => setOpen((o) => ({ ...o, [k]: v })) };
  const items = useMemo(() => filter(data?.items ?? [], q), [data, q]);
  const sum = useMemo(() => totals(data?.items ?? []), [data]);

  if (!id) return <Page wide title="Trace"><p className="text-[13px] text-muted-foreground">No chat selected. Open a trace from the chat header.</p></Page>;
  if (err) return <Page wide title="Trace"><Err>{err}</Err></Page>;
  if (!data) return <Page wide title="Trace"><p className="text-[13px] text-muted-foreground">Loading…</p></Page>;
  return (
    <Page wide title={data.title} hint={data.subtitle} actions={<Button variant="ghost" nativeButton={false} render={<a href={data.link} />}><ArrowLeft size={14} aria-hidden />{data.linkLabel}</Button>}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground tabular-nums">
          <span>{sum.turns} {sum.turns === 1 ? 'turn' : 'turns'}</span><span>{sum.calls} model {sum.calls === 1 ? 'call' : 'calls'}</span><span>{sum.tools} tool {sum.tools === 1 ? 'call' : 'calls'}</span>
          {sum.durMs !== undefined && <span>{fmt(sum.durMs)}</span>}
          {sum.hasUsage ? <span>{sum.tokens.toLocaleString()} tokens · {money(sum.cost)}</span> : <span>tokens not recorded</span>}
          <span className="flex flex-wrap gap-1">{sum.models.map((m) => <Badge key={m} variant="outline" className="font-mono text-[11px]">{m}</Badge>)}</span>
        </div>
        {data.notes.map((n) => <p key={n} className="text-[13px] text-danger-ink">{n}</p>)}
        {(data.instructions.length > 0 || data.project) && (
          <Collapsible className="rounded-xl border border-border">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <ChevronRight size={14} aria-hidden className="transition-transform group-aria-expanded:rotate-90" />Instructions in effect<span className="font-normal text-muted-foreground">{data.instructions.map((a) => a.agent).join(', ')}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-3 px-4 pb-4">
              {data.project && <div className="grid gap-1"><Label>Project instructions</Label><pre className="max-h-60 overflow-auto rounded-lg border border-border bg-surface p-2.5 text-[12.5px] leading-5 whitespace-pre-wrap">{data.project}</pre></div>}
              {data.instructions.map((a) => (
                <div key={a.agent} className="grid gap-1">
                  <Label>{a.agent}{a.model ? ` · ${a.model}` : ''}{a.thinking ? ` · thinking ${a.thinking}` : ''}</Label>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-surface p-2.5 text-[12.5px] leading-5 whitespace-pre-wrap">{a.instructions}</pre>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input data-trace-search aria-label="Search the trace" placeholder="Search names, inputs, outputs" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
          </div>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex"><Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>Enter</Kbd> open <Kbd>/</Kbd> search</span>
        </div>
        <Trace className="gap-1">
          {items.length ? items.map((it) => <Node key={it.key} it={it} />) : <p className="text-[13px] text-muted-foreground">{q ? 'Nothing matches.' : 'Nothing recorded yet.'}</p>}
        </Trace>
      </div>
    </Page>
  );
}
