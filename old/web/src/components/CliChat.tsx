import { Check, Circle, FileText, Globe, Search, SquareTerminal, Terminal as TerminalIcon, Wrench, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Confirmation, Message, MessageContent, Plan, PlanContent, PlanHeader, PlanTitle, PromptInput, PromptInputSubmit, PromptInputTools, Reasoning, Subagent, SubagentContent, SubagentHeader, Tool, ToolContent, ToolHeader, ToolInput, ToolCode } from './ai-elements';
import { Elapsed, useActivity } from './ActivityStatus';
import { helperLine } from './activity';
import { diffLines, empty, fold, hasOpenAsk, nest, workers, type CliEvent, type Item, type PermissionOption, type Transcript } from './cli-transcript';
import { Md } from './markdown';
import { RunCard } from './RunCard';
import { SignInDialog } from './SignInDialog';
import { Err, Mark } from './ui';

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
export function CliConversation({ id, agent, name = AGENT_NAMES[agent] ?? agent, view, flow, first, onSent }: { id: string; agent: string; name?: string; view: 'chat' | 'terminal'; flow?: boolean; first?: string; onSent?: () => void }) {
  return view === 'terminal' && !flow
    ? <Suspense fallback={<div className="grid grow place-items-center text-[13px] text-muted-foreground">Opening the terminal…</div>}><CliTerminal id={id} name={name} agent={agent} /></Suspense>
    : <CliChat id={id} name={name} flow={flow} first={first} onSent={onSent} />;
}

// "Continued in the terminal": the terminal view flags the conversation; the chat view that follows pins a divider at the seq where it was left.
// Kept in localStorage (this browser only): other devices will not show it.
export const markTerminalUsed = (id: string) => localStorage.setItem(`hefyn-cli-term-${id}`, '1');

function useTranscript(id: string) {
  const [t, setT] = useState<Transcript>(empty);
  const [offline, setOffline] = useState(false);
  const seq = useRef(0);
  const mark = useRef(0); // the seq after which the terminal was used (0: never)
  useEffect(() => { seq.current = t.seq; }, [t.seq]);
  useEffect(() => { // SSE with our own resume: the browser's retry would reuse the first URL, and we want ?after=<last seq>
    let es: EventSource | undefined, timer: ReturnType<typeof setTimeout>, dead = false;
    const last = `hefyn-cli-last-${id}`, flag = `hefyn-cli-term-${id}`, saved = `hefyn-cli-mark-${id}`;
    if (localStorage.getItem(flag)) { localStorage.removeItem(flag); const l = Number(localStorage.getItem(last)); if (l) localStorage.setItem(saved, String(l)); }
    mark.current = Number(localStorage.getItem(saved)) || 0;
    const open = () => {
      es = new EventSource(`/agents/cli/${id}/events?after=${seq.current}`);
      es.onopen = () => setOffline(false);
      es.onmessage = (m) => { try { const e = JSON.parse(m.data) as CliEvent; seq.current = Math.max(seq.current, e.seq); setT((s) => { const n = fold(s, e); return n !== s && e.seq === mark.current ? { ...n, items: [...n.items, { kind: 'aside' }] } : n; }); } catch { /* a malformed line is skipped */ } };
      es.onerror = () => { es?.close(); if (dead) return; setOffline(true); timer = setTimeout(open, 1500); };
    };
    open();
    return () => { dead = true; clearTimeout(timer); es?.close(); localStorage.setItem(last, String(seq.current)); };
  }, [id]);
  return { t, offline };
}

function CliChat({ id, name, flow, first, onSent }: { id: string; name: string; flow?: boolean; first?: string; onSent?: () => void }) {
  const { t, offline } = useTranscript(id);
  const items = useMemo(() => nest(t.items), [t.items]); // sub-runs inside the step that started them
  const who = useMemo(() => workers(t.items, t.busy), [t.items, t.busy]);
  const act = useActivity(id); // this page's own state plus the server's: covers a reload before the log has replayed
  const asking = hasOpenAsk(t.items); // waiting for the reader, not the model
  const names = who.agents.map((a) => `${a.kind}:${a.name}:${a.state}`).join('\n');
  useEffect(() => { // tell the shell (sidebar dot, header pill, tab title); the effect below clears it when this chat closes
    dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy: t.busy, waiting: asking && t.busy, label: who.label, agents: who.agents } }));
  }, [id, t.busy, asking, who.label, names]);
  useEffect(() => () => void dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy: false } })), [id]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const lastUser = useMemo(() => [...t.items].reverse().find((x): x is Extract<Item, { kind: 'user' }> => x.kind === 'user')?.text, [t.items]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [quiet, setQuiet] = useState(false); // 15 s of a running turn with no event
  useEffect(() => { setQuiet(false); if (!t.busy || asking) return; const h = setTimeout(() => setQuiet(true), 15000); return () => clearTimeout(h); }, [t.seq, t.busy, asking]);
  const [unsent, setUnsent] = useState<string>(); // a prompt that did not go out: shown as a failed message with Retry, never lost
  const send = async (msg: string) => {
    setErr('');
    try { await cliPost(id, '/prompt', { text: msg }); setUnsent(undefined); } catch (x) { setUnsent(msg); setErr((x as Error).message); }
  };
  const sent = useRef(false);
  useEffect(() => { if (first && !sent.current) { sent.current = true; send(first); onSent?.(); } }, [first]);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [t.items, t.busy]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || t.busy) return;
    setText(''); await send(msg);
  };
  const stop = () => cliPost(id, '/cancel').catch((x) => setErr(x.message));
  const status = t.status === 'starting' ? `Starting ${name}…` : t.status === 'stopped' ? `${name} is paused. It starts again when you send a message.` : offline ? 'Connection lost. Reconnecting…' : asking || act.state === 'waiting' ? 'Waiting for your answer' : t.busy || act.state === 'running' ? 'Working…' : '';
  const helpers = helperLine(act.agents);

  return (
    <div className="relative min-h-0 grow">
      <div ref={scroller} className="absolute inset-0 overflow-y-auto" aria-live="polite" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 px-5 pt-6 pb-40">
          {!t.items.length && (
            <div className="grid justify-items-center gap-3 pt-10 text-center"><Mark size={40} /><h1 className="text-xl leading-7 font-semibold">What should {name} work on?</h1>
              {!flow && <p className="max-w-sm text-xs leading-5 text-muted-foreground">{name} works in your sandbox. It asks before it changes anything.</p>}</div>
          )}
          {items.map((it, i) => <ItemView key={i} it={it} live={t.busy && i === items.length - 1} id={id} name={name} onError={setErr} onRetry={i === items.length - 1 && lastUser ? () => send(lastUser) : undefined} />)}
          {unsent !== undefined && (
            <Message from="user"><MessageContent>{unsent}</MessageContent>
              <p className="flex items-center gap-2 text-[13px] text-danger-ink">Couldn’t send<Button type="button" size="sm" variant="outline" onClick={() => send(unsent)}>Retry</Button></p></Message>
          )}
          <div role="status" className="grid gap-0.5 text-[13px] text-muted-foreground empty:hidden">{status && <p>{status}</p>}{helpers && <p>{helpers}</p>}{t.busy && quiet && !asking && <p>Still waiting for the model…</p>}</div>
          <Err>{err}</Err>
        </div>
      </div>
      <form onSubmit={submit} className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background from-60% to-transparent px-5 pt-8 pb-4">
        <div className="pointer-events-auto mx-auto max-w-3xl">
          <PromptInput>
            <textarea rows={1} aria-label="Message" value={text} placeholder={`Ask ${name} anything…`} autoFocus
              className="min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && t.busy) { e.preventDefault(); stop(); } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <PromptInputTools><PromptInputSubmit busy={t.busy} typed={false} onStop={stop} disabled={!text.trim() || t.busy} /></PromptInputTools>
          </PromptInput>
        </div>
      </form>
    </div>
  );
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

function ItemView({ it, live, id, name, onError, onRetry }: { it: Item; live: boolean; id: string; name: string; onError: (m: string) => void; onRetry?: () => void }) {
  switch (it.kind) {
    case 'run': return <RunCard it={it} id={id} renderItem={(x, i) => <ItemView key={i} it={x} live={false} id={id} name={name} onError={onError} />}
      post={(path, body) => cliPost(id, path, body).catch((x) => { onError(x.message); throw x; })} />;
    case 'user': return <Message from="user"><MessageContent>{it.text}</MessageContent></Message>;
    case 'agent': return <Message from="assistant"><MessageContent><Md>{it.text}</Md></MessageContent></Message>;
    case 'thought': return <Reasoning text={it.text} streaming={live} />;
    case 'error': return <Err>{it.message}</Err>;
    case 'auth': return <AuthCard it={it} onRetry={onRetry} />;
    case 'aside': return <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:grow before:bg-border after:h-px after:grow after:bg-border"><span>Continued in the terminal. Switch to Terminal to see that part.</span></p>;
    case 'stopped': return <p className="text-[13px] text-muted-foreground">Stopped</p>;
    case 'empty': return <p className="text-[13px] text-muted-foreground">{name} ended the turn without a reply.</p>;
    case 'plan': return (
      <Plan><PlanHeader><PlanTitle>Plan</PlanTitle></PlanHeader>
        <PlanContent><ul className="grid gap-1.5 text-sm">{it.entries.map((e, i) => (
          <li key={i} className={cn('flex items-start gap-2', e.status === 'completed' && 'text-muted-foreground line-through')}>
            <span className="mt-1 shrink-0">{e.status === 'completed' ? <Check size={14} className="text-success" aria-label="done" /> : e.status === 'in_progress' ? <Spinner className="size-3.5" aria-label="in progress" /> : <Circle size={14} className="text-muted-foreground" aria-label="to do" />}</span>{e.content}
          </li>))}</ul></PlanContent></Plan>
    );
    case 'permission': return <PermissionCard it={it} id={id} onError={onError} />;
    case 'tool': {
      const Icon = KIND_ICON[it.toolKind ?? ''] ?? Wrench, run = it.status === 'completed' ? 'done' : it.status === 'failed' ? 'error' : it.status === 'in_progress' ? 'running' : 'pending';
      if (it.sub !== undefined) { // a sub-agent of the agent (Claude Code's Task tool): its brief and what it came back with
        const prompt = (it.rawInput as { prompt?: unknown } | undefined)?.prompt;
        return (
          <Subagent defaultOpen={run === 'running'}>
            <SubagentHeader name="Sub-agent" task={it.sub} state={run} ms={run === 'running' ? <Elapsed /> : undefined} />
            <SubagentContent>
              {typeof prompt === 'string' && <p className="text-sm whitespace-pre-wrap">{prompt}</p>}
              {it.content.map((c, i) => c.type === 'text' ? (run === 'error' ? <p key={i} className="text-sm text-danger-ink">{plainError(c.text)}</p> : <div key={i} className="text-sm"><Md>{c.text}</Md></div>) : null)}
            </SubagentContent>
          </Subagent>
        );
      }
      return (
        <Tool defaultOpen={it.content.some((c) => c.type === 'diff')}>
          <ToolHeader icon={<Icon />} state={run} title={it.title} />
          <ToolContent>
            {it.content.map((c, i) => c.type === 'diff' ? <Diff key={i} path={c.path} oldText={c.oldText} newText={c.newText} />
              : c.type === 'text' ? (run === 'error' ? <p key={i} className="text-sm text-danger-ink">{plainError(c.text)}</p> : <ToolCode key={i} code={c.text} lang="text" title="Output" />)
              : <p key={i} className="flex items-center gap-1.5 text-sm text-muted-foreground"><SquareTerminal size={14} aria-hidden />This ran in the agent's terminal. Switch to Terminal to see it.</p>)}
            {!it.content.length && it.rawInput != null && <ToolInput input={it.rawInput} />}
          </ToolContent>
        </Tool>
      );
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

function PermissionCard({ it, id, onError }: { it: Extract<Item, { kind: 'permission' }>; id: string; onError: (m: string) => void }) {
  const [sending, setSending] = useState(false);
  const answer = async (optionId: string | null) => {
    setSending(true);
    try { await cliPost(id, '/permission', { requestId: it.requestId, optionId }); } catch (x) { onError((x as Error).message); setSending(false); }
  };
  const chosen = it.options.find((o) => o.optionId === it.answered?.optionId);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { // focus the main button, unless the reader is mid-sentence in the composer
    const a = document.activeElement;
    if (!it.answered && !(a instanceof HTMLTextAreaElement && a.value)) primary.current?.focus();
  }, []);
  if (it.answered) {
    const ok = chosen?.kind.startsWith('allow'), Icon = ok ? Check : X;
    return <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><Icon size={14} aria-hidden className={ok ? 'text-success' : ''} /><span className="font-medium text-foreground">{it.title}</span><span>{chosen ? LABEL[chosen.kind].done : 'Not allowed'}</span></p>;
  }
  const options = [...it.options].sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind));
  return (
    <Confirmation state="requested" title={`Allow “${it.title}”?`}
      actions={options.map((o, i) => <Button key={o.optionId} ref={i === 0 ? primary : undefined} type="button" size="sm" disabled={sending} variant={o.kind === 'allow_once' ? 'default' : o.kind.startsWith('allow') ? 'outline' : 'ghost'} onClick={() => answer(o.optionId)}>{LABEL[o.kind].button}</Button>)} />
  );
}
const RANK = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const LABEL: Record<PermissionOption['kind'], { button: string; done: string }> = {
  allow_once: { button: 'Allow', done: 'Allowed' }, allow_always: { button: 'Always allow', done: 'Always allowed' },
  reject_once: { button: 'Don’t allow', done: 'Not allowed' }, reject_always: { button: 'Never allow', done: 'Never allowed' },
};
