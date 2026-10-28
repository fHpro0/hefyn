import { ArrowLeft, Check, ChevronDown, Circle, FilePen, FileText, Globe, ShieldQuestion, Search, SquareTerminal, Terminal as TerminalIcon, Wrench, X } from 'lucide-react';
import { lazy, Suspense, type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Message, MessageContent, Plan, PlanContent, PlanHeader, PlanTitle, PromptInput, PromptInputSubmit, PromptInputTools, Reasoning, Tool, ToolContent, ToolHeader, ToolInput, ToolCode } from './ai-elements';
import { Elapsed, LaneGlyph, useActivity, useLeaving, Working, type LaneState } from './ActivityStatus';
import { elapsed, helperLine } from './activity';
import { diffLines, empty, fold, hasOpenAsk, nest, pendingAsks, workers, type Ask, type CliEvent, type Item, type PermissionOption, type SubAgent, type Transcript } from './cli-transcript';
import { messageWithContext, useComposer, UserText, type Mention } from './composer';
import { Md } from './markdown';
import { ChatActions, Streaming } from './openui/context';
import { SignInDialog } from './SignInDialog';
import { Shot } from './tool-parts';
import { describeStep } from './tool-labels';
import { AsciiMark, Err } from './ui';

type Run = ComponentProps<typeof ToolHeader>['state'];
const CliTerminal = lazy(() => import('./CliTerminal')); // xterm loads only when the terminal view opens

export const AGENT_NAMES: Record<string, string> = { 'claude-acp': 'Claude Code', 'codex-acp': 'Codex', opencode: 'OpenCode', pi: 'Pi' }; // fallback while cliAgents.list loads

/** POST to the CLI agent proxy; a refusal comes back as its plain message (409: busy, 423: key locked). */
export async function cliPost(id: string, path: string, body?: unknown, base: 'cli' | 'account' = 'cli') {
  const restarting = new Error('hefyn is restarting. That didn’t go through. Try again in a moment.'); // also for a dropped connection
  const r = await fetch(`/agents/${base}/${id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).catch(() => { throw restarting; });
  if (r.status === 423) dispatchEvent(new CustomEvent('hefyn-locked', { detail: { scope: 'user' } }));
  if (r.status === 502 || r.status === 503 || r.status === 504) throw restarting;
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `The request failed (${r.status}). Try again.`);
}

/** The conversation of a CLI agent: its transcript as a chat, or its own terminal, per `view`. */
export function CliConversation({ id, agent, name = AGENT_NAMES[agent] ?? agent, view, first, firstMentions, onSent, prefix, placeholder, empty }: { id: string; agent: string; name?: string; view: 'chat' | 'terminal'; first?: string; /** the @ mentions picked in `first` */ firstMentions?: Mention[]; onSent?: () => void; /** put before every message the person types (the Assistant creator: "Improving: Instructions") */ prefix?: string; placeholder?: string; /** replaces the greeting of an empty chat */ empty?: React.ReactNode }) {
  return view === 'terminal'
    ? <Suspense fallback={<div className="grid grow place-items-center text-[13px] text-muted-foreground">Opening the terminal…</div>}><CliTerminal id={id} name={name} agent={agent} /></Suspense>
    : <CliChat id={id} name={name} first={first} firstMentions={firstMentions} onSent={onSent} prefix={prefix} placeholder={placeholder} empty={empty} />;
}

// "Typed in the terminal": the host marks a prompt that came from the terminal (`via`), and the transcript puts a divider before the first one after a chat message.
// Kept so the terminal view's call still works; there is nothing to remember in this browser any more.
export const markTerminalUsed = (_id: string) => {};

function useTranscript(id: string) {
  const [t, setT] = useState<Transcript>(empty);
  const [offline, setOffline] = useState(false);
  const seq = useRef(0);
  useEffect(() => { seq.current = t.seq; }, [t.seq]);
  useEffect(() => { // SSE with our own resume: the browser's retry would reuse the first URL, and we want ?after=<last seq>
    let es: EventSource | undefined, timer: ReturnType<typeof setTimeout>, dead = false;
    const open = () => {
      es = new EventSource(`/agents/cli/${id}/events?after=${seq.current}`);
      es.onopen = () => setOffline(false);
      es.onmessage = (m) => { try { const e = JSON.parse(m.data) as CliEvent; seq.current = Math.max(seq.current, e.seq); setT((s) => fold(s, e)); } catch { /* a malformed line is skipped */ } };
      es.onerror = () => { es?.close(); if (dead) return; setOffline(true); timer = setTimeout(open, 1500); };
    };
    open();
    return () => { dead = true; clearTimeout(timer); es?.close(); };
  }, [id]);
  return { t, offline };
}

/** A sub-agent's state as the reader sees it: its own end, or the failure of the Agent call that started it. */
const stateOf = (a: SubAgent, items: Item[]): SubAgent['status'] => (a.status === 'done' && items.some((x) => x.kind === 'tool' && x.id === a.toolCallId && x.status === 'failed') ? 'failed' : a.status);

function CliChat({ id, name, first, firstMentions, onSent, prefix, placeholder, empty }: { id: string; name: string; first?: string; firstMentions?: Mention[]; onSent?: () => void; prefix?: string; placeholder?: string; empty?: React.ReactNode }) {
  const { t, offline } = useTranscript(id);
  const [lane, setLaneNow] = useState(''); // '' = the main conversation, else a sub-agent's session
  const settled = useRef(false); // false while the history of this lane replays: only text that arrives after it floats in
  const switched = useRef(false); // the first lane view appears without a fade; later switches crossfade
  const setLane = (l: string) => { if (l === lane) return; settled.current = false; switched.current = true; setLaneNow(l); };
  useEffect(() => { // a click on a sub-agent in the sidebar under another chat: that chat opened first, and left the lane for us
    try { const p = JSON.parse(sessionStorage.getItem('hefyn-open-lane') ?? 'null'); if (p?.id === id && typeof p.lane === 'string') { sessionStorage.removeItem('hefyn-open-lane'); setLane(p.lane); } } catch { /* nothing pending */ }
  }, [id]);
  useEffect(() => { const h = setTimeout(() => { settled.current = true; }, 800); return () => clearTimeout(h); }, [lane, id]);
  const sub = t.agents.find((a) => a.id === lane);
  const items = useMemo(() => nest(sub ? t.lanes[sub.id] ?? [] : t.items), [t.items, t.lanes, sub?.id]); // sub-runs inside the step that started them
  const who = useMemo(() => workers(t.items, t.busy), [t.items, t.busy]);
  const act = useActivity(id); // this page's own state plus the server's: covers a reload before the log has replayed
  const asking = hasOpenAsk(t.items); // waiting for the reader, not the model
  const names = who.agents.map((a) => `${a.kind}:${a.name}:${a.state}`).join('\n');
  useEffect(() => { // tell the shell (sidebar dot, header pill, tab title); the effect below clears it when this chat closes
    dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy: t.busy, waiting: asking && t.busy, label: who.label, agents: who.agents } }));
  }, [id, t.busy, asking, who.label, names]);
  useEffect(() => () => void dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy: false } })), [id]);
  const laneList = useMemo(() => t.agents.map((a) => ({ id: a.id, label: a.description || a.type || 'Sub-agent', state: (t.items.some((x) => x.kind === 'permission' && !x.answered && x.by === a.id) ? 'waiting' : stateOf(a, t.items)) as LaneState, since: a.startedAt })), [t.agents, t.items]);
  const lanesKey = JSON.stringify(laneList);
  useEffect(() => { dispatchEvent(new CustomEvent('hefyn-lanes', { detail: { id, lane, agents: laneList.map(({ since, ...a }) => a) } })); }, [id, lane, lanesKey]); // the sidebar lists them under this chat
  useEffect(() => () => void dispatchEvent(new CustomEvent('hefyn-lanes', { detail: { id, agents: [] } })), [id]);
  useEffect(() => { // a click in the sidebar list
    const on = (e: Event) => { const d = (e as CustomEvent<{ id: string; lane: string }>).detail; if (d.id === id) setLane(d.lane); };
    addEventListener('hefyn-open-lane', on); return () => removeEventListener('hefyn-open-lane', on);
  });
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const composer = useComposer({ id, commands: sub ? undefined : t.commands, agent: name, text, setText, area });
  const [err, setErr] = useState('');
  const lastUser = useMemo(() => [...t.items].reverse().find((x): x is Extract<Item, { kind: 'user' }> => x.kind === 'user')?.text, [t.items]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [quiet, setQuiet] = useState(false); // 15 s of a running turn with no event
  useEffect(() => { setQuiet(false); if (!t.busy || asking) return; const h = setTimeout(() => setQuiet(true), 15000); return () => clearTimeout(h); }, [t.seq, t.busy, asking]);
  const [unsent, setUnsent] = useState<string>(); // a prompt that did not go out: shown as a failed message with Retry, never lost
  const send = async (msg: string) => {
    setErr('');
    try { await cliPost(id, '/prompt', { text: msg, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' }); setUnsent(undefined); } catch (x) { setUnsent(msg); setErr((x as Error).message); }
  };
  const sent = useRef(false);
  useEffect(() => {
    if (!first || sent.current) return;
    sent.current = true; onSent?.();
    messageWithContext(id, first, firstMentions ?? []).then(send, (x: Error) => { setUnsent(first); setErr(x.message); }); // a chat link that failed: the draft stays as a failed message with Retry
  }, [first]);
  const dock = useRef<HTMLDivElement>(null), [dockH, setDockH] = useState(160); // the transcript ends at the composer's real height, whatever sits above it (sub-agent panel, request)
  useEffect(() => { const el = dock.current; if (!el) return; const ro = new ResizeObserver(() => setDockH(el.offsetHeight)); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [items, t.busy, dockH]);
  const asksOpen = useMemo(() => pendingAsks(t), [t]); // every open request, from any lane: shown above the composer
  useEffect(() => { stick.current = true; }, [lane]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || t.busy || composer.busy) return;
    if (sub) { // hefyn cannot type into a sub-agent: the main agent forwards it (host.ts)
      setText(''); setErr('');
      cliPost(id, '/prompt', { text: msg, lane: { agent: sub.id, action: 'message' } }).catch((x) => { setText(msg); setErr(x.message); });
      return;
    }
    if (await composer.exec(msg)) return;
    let out: string;
    try { out = await messageWithContext(id, msg, composer.mentions); } catch (x) { setErr((x as Error).message); return; } // the draft stays
    setText(''); composer.clear(); await send(prefix ? `${prefix}\n\n${out}` : out);
  };
  const stop = () => cliPost(id, '/cancel').catch((x) => setErr(x.message));
  const stopLane = (agent: string) => { setErr(''); cliPost(id, '/prompt', { lane: { agent, action: 'stop' } }).catch((x) => setErr(x.message)); };
  const active = useMemo(() => laneList.filter((a) => a.state === 'running' || a.state === 'waiting'), [laneList]);
  const asks = useMemo(() => (sub ? t.items.filter((x): x is Extract<Item, { kind: 'permission' }> => x.kind === 'permission' && x.by === sub.id && !x.answered) : []), [t.items, sub?.id]); // the sub-agent's own questions are answered in its lane
  const subState = sub ? laneList.find((a) => a.id === sub.id)?.state : undefined;
  const status = t.status === 'starting' ? `Starting ${name}…` : t.status === 'stopped' ? `${name} is paused. It starts again when you send a message.` : offline ? 'Connection lost. Reconnecting…' : asking || act.state === 'waiting' ? 'Waiting for your answer' : t.busy || act.state === 'running' ? 'Working…' : '';
  const helpers = helperLine(act.agents);

  return (
    <ChatActions.Provider value={{ send: sub ? undefined : send }}>{/* a sub-agent's lane has no one to answer: its buttons stay inert */}
    <div className="relative min-h-0 grow" {...composer.drop}>
      {composer.overlay}
      <div ref={scroller} className="absolute inset-0 overflow-y-auto" aria-live="polite" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div key={lane} className={cn('mx-auto grid max-w-[54.5rem] grid-cols-[minmax(0,1fr)] gap-6 px-6 pt-8', switched.current && 'hf-fade')} style={{ paddingBottom: dockH + 16 }}>
          {sub && (
            <div className="flex items-center gap-2 text-[13px]">
              <Button type="button" size="sm" variant="ghost" onClick={() => setLane('')}><ArrowLeft size={14} aria-hidden />Back to chat</Button>
              {subState && <LaneGlyph state={subState} />}<span className="min-w-0 truncate font-medium">{laneList.find((a) => a.id === sub.id)?.label}</span>
              {(subState === 'running' || subState === 'waiting') && <Button type="button" size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => stopLane(sub.id)}>Stop</Button>}
            </div>
          )}
          {!sub && !t.items.length && (empty ??
            <div className="grid justify-items-center gap-3 pt-10 text-center"><AsciiMark /><h1 className="text-xl leading-7 font-semibold">What should {name} work on?</h1>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">{name} works in your sandbox. It asks before it changes anything.</p></div>
          )}
          {sub && !items.length && <p className="text-[13px] text-muted-foreground">{stateOf(sub, t.items) === 'running' ? 'This sub-agent has not written anything yet.' : 'This sub-agent left nothing to show.'}</p>}
          {groupSteps(items).map((g) => { // consecutive steps share one hairline rail
            const views = g.items.map((it, k) => { const i = g.start + k; return <ItemView key={`${lane}:${i}`} it={it} live={(sub ? stateOf(sub, t.items) === 'running' : t.busy) && i === items.length - 1} settled={settled} id={id} name={name} agents={t.agents} all={t.items} onOpen={setLane} onError={setErr} onRetry={!sub && i === items.length - 1 && lastUser ? () => send(lastUser) : undefined} />; });
            return g.step ? <div key={`${lane}:g${g.start}`} className="grid min-w-0 gap-0.5 border-l border-border pl-3 [&_[data-slot=task-content]]:ml-0 [&_[data-slot=task-content]]:border-l-0 [&_[data-slot=task-content]]:pl-1.5">{views}</div> : views;
          })}
          {asks.map((it) => <ItemView key={it.requestId} it={it} live={false} settled={settled} id={id} name={name} agents={t.agents} all={t.items} onOpen={setLane} onError={setErr} />)}
          {!sub && unsent !== undefined && (
            <Message from="user"><MessageContent><UserText text={unsent} /></MessageContent>
              <p className="flex items-center gap-2 text-[13px] text-danger-ink">Couldn’t send<Button type="button" size="sm" variant="outline" onClick={() => send(unsent)}>Retry</Button></p></Message>
          )}
          <div role="status" className="grid gap-0.5 text-[13px] text-muted-foreground empty:hidden">{sub ? (stateOf(sub, t.items) === 'running' && <p className="flex items-center gap-2"><Working className="text-seal" /><span className="hf-shimmer">Sub-agent working…</span></p>) : <>{status && <p className="flex items-center gap-2">{status === 'Working…' && <Working className="text-seal" />}<span className={status === 'Working…' ? 'hf-shimmer' : undefined}>{status}</span></p>}{helpers && <p>{helpers}</p>}{t.busy && quiet && !asking && <p>Still waiting for the model…</p>}</>}</div>
          <Err>{err}</Err>
        </div>
      </div>
      <div ref={dock} className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pt-3 pb-6 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-12 before:bg-gradient-to-t before:from-background before:to-transparent">
        <div className="pointer-events-auto mx-auto grid max-w-[54.5rem] gap-3 px-6">
          <ActivePanel agents={active} current={lane} settled={settled} onOpen={setLane} onStop={stopLane} />
          <form onSubmit={submit}>
          <div className="hf-corners">
          {composer.popover}
          <PermissionDock asks={asksOpen} id={id} name={name} agents={t.agents} onError={setErr} />
          <PromptInput className={asksOpen.length ? 'rounded-t-none' : undefined}>
            {composer.attachments}
            <textarea ref={area} rows={1} aria-label="Message" value={text} placeholder={sub ? `Message ${laneList.find((a) => a.id === sub.id)?.label}…` : placeholder ?? `Ask ${name} anything…`} autoFocus={!sub && !placeholder}
              className="min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
              onChange={composer.bind.onChange} onSelect={composer.bind.onSelect} onPaste={composer.bind.onPaste} aria-expanded={composer.bind['aria-expanded']}
              onKeyDown={(e) => { if (composer.bind.onKeyDown(e)) return; if (e.key === 'Escape' && t.busy) { e.preventDefault(); stop(); } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <PromptInputTools>{!sub && composer.attachButton}<PromptInputSubmit busy={t.busy} typed={false} onStop={stop} disabled={!text.trim() || t.busy || composer.busy} /></PromptInputTools>
          </PromptInput>
          </div>
          </form>
        </div>
      </div>
    </div>
    </ChatActions.Provider>
  );
}

/** Runs of tool calls, thoughts and answered permissions (the quiet rows) become one group each; everything else stands alone. */
const isStep = (it: Item) => it.kind === 'thought' || (it.kind === 'tool' && it.sub === undefined) || it.kind === 'permission';
function groupSteps(items: Item[]) {
  const out: { start: number; step: boolean; items: Item[] }[] = [];
  items.forEach((it, i) => { const step = isStep(it), g = out[out.length - 1]; if (g && g.step && step) g.items.push(it); else out.push({ start: i, step, items: [it] }); });
  return out;
}

/** A failed tool's text arrives fenced and wrapped in <tool_use_error>: show the sentence. */
const plainError = (s: string) => s.replace(/^\s*```\w*\n?|\n?```\s*$/g, '').replace(/<\/?tool_use_error>/g, '').trim();
const KIND_ICON: Record<string, typeof Wrench> = { read: FileText, edit: FileText, delete: FileText, move: FileText, search: Search, execute: TerminalIcon, fetch: Globe };

/** The user's own sign-in ended (or is missing): say so in plain words and offer the same dialog as Settings; after a success, offer to send the last message again. */
function AuthCard({ it, onRetry }: { it: Extract<Item, { kind: 'auth' }>; onRetry?: () => void }) {
  const [open, setOpen] = useState(false), [done, setDone] = useState(false);
  return (
    <div role="alert" className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-[13px]">
      <p className="font-medium">{done ? `You are signed in to ${it.name} again.` : it.reason === 'signed_out' ? `Sign in to use ${it.name} with your own account.` : `Your ${it.name} sign-in has expired.`}</p>
      <div className="flex flex-wrap gap-2">
        {done ? (onRetry && <Button type="button" size="sm" onClick={onRetry}>Retry last message</Button>) : <Button type="button" size="sm" onClick={() => setOpen(true)}>{it.reason === 'signed_out' ? 'Sign in' : 'Sign in again'}</Button>}
      </div>
      {open && <SignInDialog agentId={it.agentId} name={it.name} onDone={() => setDone(true)} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Open/closed state decided when the card first shows (a running sub-agent, a diff) and the reader's own after that: a Collapsible must not change its default later. */
function useOpen(initial: boolean) { return useState(initial); }

function ToolCard({ it, run }: { it: Extract<Item, { kind: 'tool' }>; Icon: typeof Wrench; run: Run }) {
  const [open, setOpen] = useOpen(it.content.some((c) => c.type === 'diff'));
  const images = it.content.filter((c): c is Extract<typeof c, { type: 'image' }> => c.type === 'image');
  const written = (it.rawInput as { content?: unknown } | undefined)?.content; // a Write's real content, from the tool input
  const step = describeStep(it), failed = run === 'error' && it.allowed !== false, StepIcon = step.icon;
  const fullText = it.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  const error = failed && fullText ? plainError(fullText) : '';
  const raw = it.rawOutput != null ? (typeof it.rawOutput === 'string' ? it.rawOutput : JSON.stringify(it.rawOutput, null, 2)) : '';
  const title = step.object && step.text.includes(step.object) ? (() => { const k = step.text.indexOf(step.object); return <>{step.text.slice(0, k)}<span className="font-medium text-foreground">{step.object}</span>{step.text.slice(k + step.object.length)}</>; })() : step.text;
  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader icon={<StepIcon />} state={it.allowed === false && run !== 'error' ? 'error' : run} title={title} className={cn('font-sans text-[0.929rem]', failed && 'text-danger-ink')} />
      {error && <p className="px-1 pl-6 text-[13px] text-danger-ink">{error.split('\n')[0]}</p>}
      {images.length > 0 && <div className="flex flex-wrap gap-2 px-1 pt-2">{images.map((c, i) => <Shot key={i} img={{ src: c.src }} />)}</div>}
      <ToolContent>
        {it.content.map((c, i) => c.type === 'image' ? null : c.type === 'diff' ? (diffLines(c.oldText, c.newText).length || typeof written !== 'string' ? <Diff key={i} path={c.path} oldText={c.oldText} newText={c.newText} /> : <ToolCode key={i} code={written} lang="text" title={c.path} />)
          : c.type === 'text' ? (run === 'error' ? null : <ToolCode key={i} code={c.text.split('\n').slice(0, 12).join('\n')} lang="text" title={c.text.split('\n').length > 12 ? 'Output (first 12 lines)' : 'Output'} />)
          : <p key={i} className="flex items-center gap-1.5 text-sm text-muted-foreground"><SquareTerminal size={14} aria-hidden />This ran in the agent's terminal. Switch to Terminal to see it.</p>)}
        {(step.detail || it.rawInput != null || raw || fullText) && (
          <details className="group/tech text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer select-none rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">Technical details</summary>
            <div className="mt-1.5 grid gap-2">
              {step.detail && <div className="flex min-w-0 items-center gap-2"><code className="min-w-0 break-all rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground select-all">{step.detail}</code><button type="button" className="shrink-0 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => void navigator.clipboard?.writeText(step.detail!)}>Copy</button></div>}
              {it.rawInput != null && <ToolInput input={it.rawInput} />}
              {(raw || fullText) && <ToolCode code={raw || fullText} lang="text" title="Output" />}
            </div>
          </details>
        )}
      </ToolContent>
    </Tool>
  );
}

/** Agent text: floats in only if it appeared after the history replayed (decided once, so it keeps floating while the turn streams in). */
function AgentText({ text, settled, live }: { text: string; settled: React.RefObject<boolean>; live: boolean }) {
  const [animate] = useState(() => settled.current);
  return <Streaming.Provider value={live}><Md animate={animate}>{text}</Md></Streaming.Provider>;
}

/** Rises and fades in when it appears after the history replayed (decided once, at mount). */
function Rise({ settled, children }: { settled: React.RefObject<boolean>; children: React.ReactNode }) {
  const [fresh] = useState(() => settled.current);
  return <div className={fresh ? 'hf-rise' : undefined}>{children}</div>;
}

/** Where a finished sub-agent was started: its end state, how long it took, and a way to read it again. A running one lives in the panel above the composer. */
function SubDone({ a, state, onOpen }: { a: SubAgent; state: SubAgent['status']; onOpen: (agent: string) => void }) {
  const label = a.description || a.type || 'Sub-agent', ms = a.startedAt && a.endedAt ? a.endedAt - a.startedAt : undefined;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-[13px]">
      <LaneGlyph state={state === 'failed' ? 'failed' : 'done'} /><span className="min-w-0 truncate font-medium">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{state === 'failed' ? 'Failed' : 'Done'}{ms !== undefined && ` · ${elapsed(ms)}`}</span>
      <Button type="button" size="sm" variant="outline" className="ml-auto shrink-0" aria-label={`Open ${label}`} onClick={() => onOpen(a.id)}>Open</Button>
    </div>
  );
}

type PanelAgent = { id: string; label: string; state: LaneState; since?: number };
/** The sub-agents that are working now, above the composer: collapsible, a row each with its state, Open (the row) and Stop. Finished ones leave the list and show up in the chat. */
function ActivePanel({ agents, current, settled, onOpen, onStop }: { agents: PanelAgent[]; current: string; settled: React.RefObject<boolean>; onOpen: (agent: string) => void; onStop: (agent: string) => void }) {
  const rows = useLeaving(agents);
  return rows.length ? <PanelBody rows={rows} current={current} settled={settled} onOpen={onOpen} onStop={onStop} /> : null;
}
function PanelBody({ rows, current, settled, onOpen, onStop }: { rows: { a: PanelAgent; leaving: boolean }[]; current: string; settled: React.RefObject<boolean>; onOpen: (agent: string) => void; onStop: (agent: string) => void }) {
  const [open, setOpen] = useState(true), [fresh] = useState(() => settled.current);
  const n = rows.filter((r) => !r.leaving).length || rows.length, waiting = rows.some((r) => !r.leaving && r.a.state === 'waiting');
  return (
    <div className={cn('rounded-lg border border-border bg-surface text-[13px]', fresh && 'animate-in fade-in slide-in-from-bottom-2 duration-200')}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <Working />{n} sub-agent{n === 1 ? '' : 's'} working{waiting && <span className="text-warning-ink">· needs your answer</span>}
        <ChevronDown size={14} aria-hidden className={cn('ml-auto text-muted-foreground transition-transform duration-200', !open && '-rotate-90')} />
      </button>
      <div className={cn('grid transition-[grid-template-rows] duration-200', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')} inert={!open}>
        <div className="min-h-0 overflow-hidden"><ul className="max-h-44 overflow-y-auto border-t border-border">{rows.map(({ a, leaving }) => <PanelRow key={a.id} a={a} leaving={leaving} on={current === a.id} settled={settled} onOpen={onOpen} onStop={onStop} />)}</ul></div>
      </div>
    </div>
  );
}
function PanelRow({ a, leaving, on, settled, onOpen, onStop }: { a: PanelAgent; leaving: boolean; on: boolean; settled: React.RefObject<boolean>; onOpen: (agent: string) => void; onStop: (agent: string) => void }) {
  const [fresh] = useState(() => settled.current);
  return (
    <li className={leaving ? 'hf-row-out' : fresh ? 'hf-row-in' : undefined}>
      <div className="relative min-h-0 overflow-hidden">
        <button type="button" title="Open" tabIndex={leaving ? -1 : undefined} aria-current={on ? 'true' : undefined} onClick={() => onOpen(a.id)}
          className={cn('flex h-8 w-full items-center gap-2 px-3 pr-16 text-left outline-none hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.07]', on && 'bg-foreground/[0.07]')}>
          <LaneGlyph state={a.state} /><span className="min-w-0 truncate">{a.label}</span>
          {a.state === 'waiting' ? <span className="shrink-0 text-xs text-warning-ink">needs your answer</span> : a.since ? <span className="shrink-0 text-xs text-muted-foreground"><Elapsed since={a.since} /></span> : null}
        </button>
        <button type="button" tabIndex={leaving ? -1 : undefined} aria-label={`Stop ${a.label}`} onClick={() => onStop(a.id)}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">Stop</button>
      </div>
    </li>
  );
}

function ItemView({ it, live, settled, id, name, agents, all, onOpen, onError, onRetry }: { it: Item; live: boolean; settled: React.RefObject<boolean>; id: string; name: string; agents: SubAgent[]; all: Item[]; onOpen: (agent: string) => void; onError: (m: string) => void; onRetry?: () => void }) {
  const rise = (n: React.ReactNode) => <Rise settled={settled}>{n}</Rise>;
  switch (it.kind) {
    case 'run': return null; // flow runs belonged to the Assistant flow builder (old/)
    case 'user': return rise(<Message from="user"><MessageContent><UserText text={it.text} /></MessageContent></Message>);
    case 'agent': return <Message from="assistant"><MessageContent><AgentText text={it.text} settled={settled} live={live} /></MessageContent></Message>;
    case 'thought': return <Reasoning text={it.text} streaming={live} />;
    case 'error': return <Err>{it.message}</Err>;
    case 'auth': return <AuthCard it={it} onRetry={onRetry} />;
    case 'aside': return <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:grow before:bg-border after:h-px after:grow after:bg-border"><span>Typed in the terminal</span></p>;
    case 'stopped': return <p className="text-[13px] text-muted-foreground">Stopped</p>;
    case 'empty': return <p className="text-[13px] text-muted-foreground">{name} ended the turn without a reply.</p>;
    case 'plan': return rise(
      <Plan><PlanHeader><PlanTitle>Plan</PlanTitle></PlanHeader>
        <PlanContent><ul className="grid gap-1.5 text-sm">{it.entries.map((e, i) => (
          <li key={i} className={cn('flex items-start gap-2', e.status === 'completed' && 'text-muted-foreground line-through')}>
            <span className="mt-1 shrink-0">{e.status === 'completed' ? <Check size={14} className="text-success" aria-label="done" /> : e.status === 'in_progress' ? <Working label="in progress" /> : <Circle size={14} className="text-muted-foreground" aria-label="to do" />}</span>{e.content}
          </li>))}</ul></PlanContent></Plan>
    );
    case 'permission':
      if (!it.answered && all.some((x) => x.kind === 'tool' && x.id === it.toolCallId)) return null; // the call's own row already shows it waiting
      return rise(<PermissionCard it={it} />);
    case 'tool': {
      if (it.sub !== undefined) { // the Agent call that started a sub-agent: nothing while it works (the panel above the composer lists it); its own end state, never the call's, once it is over
        const a = agents.find((x) => x.toolCallId === it.id || x.id === it.agentId), s = a && stateOf(a, all);
        return a && s !== 'running' ? rise(<SubDone a={a} state={s!} onOpen={onOpen} />) : null;
      }
      const Icon = KIND_ICON[it.toolKind ?? ''] ?? Wrench, run: Run = it.status === 'completed' ? 'done' : it.status === 'failed' ? 'error' : it.status === 'in_progress' ? 'running' : 'pending';
      return rise(<ToolCard it={it} Icon={Icon} run={run} />);
    }
  }
}

function Diff({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const lines = diffLines(oldText, newText);
  return (
    <div className="overflow-hidden rounded-lg border border-border text-[13px]">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">{path}</div>
      <pre className="max-h-72 overflow-auto py-1 font-mono leading-5">{lines.length ? lines.map((l, i) => (
        <div key={i} className={cn('px-3 break-words whitespace-pre-wrap', l.sign === '+' ? 'bg-success/10 text-success-ink' : 'bg-destructive/10 text-danger-ink')}><span aria-hidden className="mr-2 select-none">{l.sign}</span><span className="sr-only">{l.sign === '+' ? 'added: ' : 'removed: '}</span>{l.text}</div>
      )) : <div className="px-3 text-muted-foreground">No changes.</div>}</pre>
    </div>
  );
}

/** The compact record of a request in the transcript: waiting, or its outcome. The question itself is in PermissionDock above the composer. */
function PermissionCard({ it }: { it: Extract<Item, { kind: 'permission' }> }) {
  const chosen = it.options.find((o) => o.optionId === it.answered?.optionId);
  if (!it.answered) return <p className="flex items-center gap-2 font-mono text-[0.893rem] text-muted-foreground"><Circle size={14} aria-hidden className="text-warning-ink" /><span>Waiting for your answer: {it.title}</span></p>;
  const ok = chosen?.kind.startsWith('allow'), Icon = ok ? Check : X;
  // nobody clicked here: the terminal answered, or Claude Code's own rule (an earlier “always allow”) let the tool run
  const label = it.answered.by === 'claude' ? (ok ? 'Allowed by Claude Code (in the terminal, or by your earlier “always allow”)' : 'Not allowed (in the terminal)') : chosen ? LABEL[chosen.kind].done : 'Not allowed';
  return <p className="flex items-center gap-2 font-mono text-[0.893rem] text-muted-foreground"><Icon size={14} aria-hidden className={ok ? 'text-success' : ''} /><span>{label}: {it.title}</span></p>;
}

/** What a request is about, in plain words: icon, the sentence, and the target (path, command, address). */
function describeAsk({ ask, tool }: Ask) {
  const word = (ask.title.split(/\s+/)[0] ?? '').toLowerCase(), kind = tool?.toolKind ?? '';
  const raw = (tool?.rawInput ?? {}) as Record<string, unknown>, str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
  const is = (k: string, ...w: string[]) => kind === k || w.includes(word);
  const [Icon, verb] = is('edit', 'write', 'edit', 'multiedit', 'notebookedit') || kind === 'delete' || kind === 'move' ? [FilePen, 'wants to write a file']
    : is('read', 'read') ? [FileText, 'wants to read a file']
      : is('execute', 'bash') ? [SquareTerminal, 'wants to run a command']
        : is('fetch', 'webfetch', 'websearch') ? [Globe, 'wants to fetch a page']
          : is('search', 'grep', 'glob') ? [Search, 'wants to search the files'] : [ShieldQuestion, 'wants to use a tool'];
  const target = str('file_path') ?? str('path') ?? str('command') ?? str('url') ?? str('query') ?? str('pattern') ?? ask.title.replace(/^\w+\s+/, '');
  return { Icon, verb, target };
}

/** Every open request of the chat and its sub-agents, docked on the composer: the oldest first, one at a time. An alert, not a modal. Enter allows, Escape does not. */
function PermissionDock({ asks, id, name, agents, onError }: { asks: Ask[]; id: string; name: string; agents: SubAgent[]; onError: (m: string) => void }) {
  const first = asks[0];
  return <div aria-live="assertive" aria-atomic className="empty:hidden">{first && <AskCard key={first.ask.requestId} a={first} n={asks.length} id={id} who={first.agent ? agents.find((x) => x.id === first.agent)?.description || 'A sub-agent' : name} onError={onError} />}</div>;
}
function AskCard({ a, n, id, who, onError }: { a: Ask; n: number; id: string; who: string; onError: (m: string) => void }) {
  const [sending, setSending] = useState(false), [more, setMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { Icon, verb, target } = describeAsk(a);
  const options = [...a.ask.options].sort((x, y) => RANK.indexOf(x.kind) - RANK.indexOf(y.kind));
  const answer = async (optionId: string | null) => {
    if (sending) return;
    setSending(true);
    try { await cliPost(id, '/permission', { requestId: a.ask.requestId, optionId }); } catch (x) { onError((x as Error).message); setSending(false); }
  };
  useEffect(() => { // take focus, unless the reader is mid-sentence in the composer (the live region still announces it)
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement && el.value)) box.current?.focus();
  }, []);
  const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow')), deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject'));
  const written = typeof (a.tool?.rawInput as { content?: unknown } | undefined)?.content === 'string' ? (a.tool!.rawInput as { content: string }).content : undefined;
  const diff = a.tool?.content.find((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff');
  const command = a.tool?.toolKind === 'execute' || /^bash$/i.test(a.ask.title.split(/\s+/)[0] ?? '') ? target : undefined;
  const preview = diff ? (diffLines(diff.oldText, diff.newText).length || written === undefined ? <Diff path={diff.path} oldText={diff.oldText} newText={diff.newText} /> : <ToolCode code={written} lang="text" title={diff.path} />)
    : written !== undefined ? <ToolCode code={written} lang="text" title="Content" /> : command ? <ToolCode code={command} lang="bash" title="Command" /> : null;
  return (
    <div ref={box} tabIndex={-1} role="group" aria-label={`${who} ${verb}: ${target}. Enter allows, Escape does not.`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void answer(deny?.optionId ?? null); } else if (e.key === 'Enter' && e.target === e.currentTarget && allow) { e.preventDefault(); void answer(allow.optionId); } }}
      className="hf-rise pointer-events-auto relative grid gap-2.5 overflow-hidden rounded-t-2xl border border-b-0 border-border bg-[color-mix(in_srgb,var(--warning)_6%,var(--background))] py-3 pr-4 pl-5 text-[13px] outline-none before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-warning focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon size={16} aria-hidden className="shrink-0 text-warning-ink" />
        <span className="max-w-48 truncate rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">{who}</span>
        <span className="font-medium">{verb}</span>
        {n > 1 && <span className="ml-auto text-xs text-muted-foreground tnum">1 of {n}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code title={target} className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs ring-1 ring-border/60">{target}</code>
        {preview && <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{more ? 'Hide' : 'Show'} details<ChevronDown size={14} aria-hidden className={cn('transition-transform', more && 'rotate-180')} /></button>}
      </div>
      {more && preview && <div className="max-h-64 overflow-auto">{preview}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {options.map((o) => <Button key={o.optionId} type="button" size="sm" disabled={sending} variant={o.kind === 'allow_once' ? 'default' : o.kind.startsWith('allow') ? 'outline' : 'ghost'} className={o.kind.startsWith('reject') ? 'hover:bg-destructive/10 hover:text-danger-ink' : undefined} onClick={() => void answer(o.optionId)}>{LABEL[o.kind].button}</Button>)}
      </div>
    </div>
  );
}
const RANK = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const LABEL: Record<PermissionOption['kind'], { button: string; done: string }> = {
  allow_once: { button: 'Allow', done: 'Allowed' }, allow_always: { button: 'Always allow', done: 'Always allowed' },
  reject_once: { button: 'Don’t allow', done: 'Not allowed' }, reject_always: { button: 'Never allow', done: 'Never allowed' },
};
