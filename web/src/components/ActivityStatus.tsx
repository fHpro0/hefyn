import { Check, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { elapsed, IDLE, type Activity, type Status } from './activity';
import { notifyWanted } from './attention';

// The pieces that show what a chat is doing: the live dot (sidebar), the header pill, a live elapsed time and the poll of conversations.activity.
// Shell owns the state (poll + the open page's own `hefyn-busy` events) and provides it here.

export const ActivityContext = createContext<{ of: (id?: string) => Status }>({ of: () => IDLE });
export const useActivity = (id?: string) => useContext(ActivityContext).of(id);

/** Ticks every second while mounted. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  return now;
}
/** Time since `since` (ms); without it, since this mounted (a running tool part that appeared in this page). */
export function Elapsed({ since }: { since?: number }) {
  const t0 = useRef(since ?? Date.now()), now = useNow();
  return <span className="tnum">{elapsed(now - (since ?? t0.current))}</span>;
}

/** The "working" mark: three dots orbiting with staggered easing (app.css); a static dot under reduced motion. `label` makes it a status for screen readers. */
export function Working({ label, className }: { label?: string; className?: string }) {
  return <span role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn('hf-working', className)}><i /><i /><i /></span>;
}

/** The rows of a list that just lost one stay for `ms` more, flagged `leaving`, so they can animate out. */
export function useLeaving<T extends { id: string }>(list: T[], ms = 250): { a: T; leaving: boolean }[] {
  const prev = useRef(list), [gone, setGone] = useState<T[]>([]);
  useEffect(() => {
    const left = prev.current.filter((p) => !list.some((x) => x.id === p.id));
    prev.current = list;
    if (!left.length) return;
    setGone((g) => [...g, ...left]);
    setTimeout(() => setGone((g) => g.filter((x) => !left.includes(x))), ms);
  }, [list]);
  return [...list.map((a) => ({ a, leaving: false })), ...gone.filter((g) => !list.some((x) => x.id === g.id)).map((a) => ({ a, leaving: true }))];
}

export type LaneState = 'running' | 'waiting' | 'done' | 'failed';
/** A sub-agent's state as a glyph (the tray above the composer and the sidebar sub-list). */
export function LaneGlyph({ state }: { state: LaneState }) {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const glyph = state === 'running' ? <Working label="Running" />
    : state === 'waiting' ? <span role="img" aria-label="Waiting for you" className="size-2 shrink-0 rounded-full bg-warning" />
    : state === 'done' ? <Check size={12} aria-label="Done" className="shrink-0 text-success" />
    : <X size={12} aria-label="Failed" className="shrink-0 text-danger" />;
  return <span key={state} className={cn('inline-grid shrink-0 place-items-center', mounted.current && 'animate-in fade-in zoom-in-50 duration-200')}>{glyph}</span>; // a change of state pops; the first paint does not
}

/** The sidebar's dot: pulsing while running, a steady larger one when the chat waits for the reader. */
export function ActivityDot({ status }: { status?: Status }) {
  if (!status || status.state === 'idle') return null;
  return status.state === 'waiting'
    ? <span role="img" aria-label="Waiting for your answer" className="shrink-0 rounded-md bg-warning/15 px-1.5 text-[11px] leading-5 font-medium text-warning-ink">Waiting</span>
    : <span role="img" aria-label="Running" className="size-1.5 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none" />;
}

/** The header pill of the open chat: nothing while idle. */
export function StatusPill({ id }: { id: string }) {
  const s = useActivity(id);
  if (s.state === 'idle') return null;
  return s.state === 'waiting'
    ? <span role="status" className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1 text-xs font-medium whitespace-nowrap text-warning-ink"><span aria-hidden className="size-1.5 rounded-full bg-warning" />Waiting for you</span>
    : <span role="status" className="inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-seal/12 px-2 py-1 text-xs font-medium whitespace-nowrap text-seal">
        <Working />Working…{s.label && <span className="max-w-40 truncate font-normal max-sm:sr-only">· {s.label}</span>}{s.since && <span className="font-normal max-sm:sr-only">· <Elapsed since={s.since} /></span>}</span>;
}

/** conversations.activity every 3 s while the tab is visible, and again on `hefyn-activity` (events of the open chat) and when the tab returns.
 * A server without the procedure is asked rarely (30 s) and the sidebar falls back to what the open page knows. */
export function useRemoteActivity() {
  const [map, setMap] = useState<Record<string, Activity>>({});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>, last = 0, slow = false, dead = false;
    const load = async () => {
      clearTimeout(timer); last = Date.now();
      const watch = document.hidden && notifyWanted(); // a hidden tab still polls (slowly) when the reader asked to be notified
      if (!document.hidden || watch) await (trpc.conversations as any).activity.query().then((m: Record<string, Activity>) => { slow = false; if (!dead) setMap(m ?? {}); }, () => { slow = true; });
      if (!dead) timer = setTimeout(load, slow ? 30000 : watch ? 8000 : 3000);
    };
    const soon = () => { if (Date.now() - last > 1000) load(); }; // bursts of events make one request; the poll catches the rest
    load();
    addEventListener('hefyn-activity', soon); document.addEventListener('visibilitychange', soon);
    return () => { dead = true; clearTimeout(timer); removeEventListener('hefyn-activity', soon); document.removeEventListener('visibilitychange', soon); };
  }, []);
  return map;
}
