import { BellRing, ChevronDown } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import type { Attention } from './activity';

// A request from an agent in any chat, seen from any page. The feed (conversations.activity) names the chat, the asker and the kind of tool, but not the
// target, the request id or the options (those stay in the chat, sealed): so the bar can only take the reader there, where the PermissionDock answers it.

const KEY = 'hefyn-notify';
/** Per device: the browser's permission is per browser too. */
export const notifyOn = () => localStorage.getItem(KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
export const notifyWanted = () => localStorage.getItem(KEY) === '1';
/** Call from a click only: the browser asks for permission then. Returns whether notifications are on now. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (!on) { localStorage.removeItem(KEY); return false; }
  if (typeof Notification === 'undefined') return false;
  const ok = (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted';
  if (ok) localStorage.setItem(KEY, '1');
  return ok;
}

/** Go to the chat (and the sub-agent's lane); the chat's dock shows the request. */
export function openAttention(a: Pick<Attention, 'chatId' | 'lane'>) {
  if (a.lane) sessionStorage.setItem('hefyn-open-lane', JSON.stringify({ id: a.chatId, lane: a.lane }));
  if (location.pathname === '/') location.hash = a.chatId; else location.href = `/#${a.chatId}`;
}

/** While the tab is hidden, one desktop notification per request that is new. No sound; a click brings the tab back and opens the chat. */
export function useNotifyHidden(list: Attention[]) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const keys = new Set(list.map((a) => a.key));
    for (const a of list) {
      if (seen.current.has(a.key)) continue;
      seen.current.add(a.key);
      if (!document.hidden || !notifyOn()) continue;
      const n = new Notification('hefyn needs you', { body: `${a.text} in “${a.title}”`, tag: a.key, silent: true });
      n.onclick = () => { window.focus(); openAttention(a); n.close(); };
    }
    for (const k of seen.current) if (!keys.has(k)) seen.current.delete(k); // answered: a later request asks again
  }, [list]);
}

/** The slim bar at the top of the main area. aria-live assertive: it is announced when it appears or changes. */
export function AttentionBar({ list }: { list: Attention[] }) {
  if (!list.length) return <div aria-live="assertive" aria-atomic className="empty:hidden" />;
  const first = list[0]!;
  return (
    <div aria-live="assertive" aria-atomic>
      <div className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-[color-mix(in_srgb,var(--warning)_6%,var(--background))] py-1.5 pr-3 pl-5 text-[13px] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-warning">
        <BellRing size={15} aria-hidden className="shrink-0 text-warning-ink" />
        <p className="min-w-0 grow basis-60">
          {list.length === 1 ? <><span className="font-medium">{first.text}</span><span className="text-muted-foreground"> in “{first.title}”</span></> : <span className="font-medium">{list.length} requests waiting for you</span>}
        </p>
        {list.length === 1
          ? <Button size="xs" onClick={() => openAttention(first)}>Open</Button>
          : <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="xs" />}>Show<ChevronDown size={12} aria-hidden /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-1.5rem)]">
                {list.map((a) => <DropdownMenuItem key={a.key} className="grid gap-0 text-[13px]" onClick={() => openAttention(a)}><span className="truncate font-medium">{a.text}</span><span className="truncate text-xs text-muted-foreground">“{a.title}”</span></DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>}
      </div>
    </div>
  );
}
