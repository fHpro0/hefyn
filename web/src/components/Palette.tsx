import { BarChart3, CornerDownLeft, Cpu, Folder, MessageSquare, Monitor, Moon, PanelRight, Plug, Plus, Search, Settings, Shield, SquareTerminal, Store, Sun, Users, PackageCheck, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { can, type Me } from './api';
import { setTheme } from './theme';
import { Kbd, shortcut } from './ui';

export interface Thread { id: string; title: string; createdAt?: string }
interface Item { id: string; label: string; group: string; Icon: LucideIcon; keys?: string; run: () => void }

// Command palette (⌘K): every main action is reachable here.
export default function Palette({ me, threads, onClose }: { me: Me; threads: Thread[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => { ref.current?.showModal(); }, []);
  const go = (href: string) => () => { location.href = href; };
  const toggle = (what: 'ledger' | 'terminal') => () => { location.pathname === '/' ? dispatchEvent(new CustomEvent('hefyn-toggle', { detail: what })) : (location.href = '/'); };
  const items = useMemo<Item[]>(() => {
    const it: Item[] = [
      { id: 'new', label: 'New chat', group: 'Actions', Icon: Plus, keys: shortcut('N'), run: () => { if (location.pathname === '/') { location.hash = ''; dispatchEvent(new Event('hefyn-newchat')); } else location.href = '/'; } },
      { id: 'ledger', label: 'Toggle the privacy ledger', group: 'Actions', Icon: PanelRight, keys: shortcut('L'), run: toggle('ledger') },
      { id: 'terminal', label: 'Toggle the terminal', group: 'Actions', Icon: SquareTerminal, keys: shortcut('J'), run: toggle('terminal') },
      { id: 'connect', label: 'Connect a model', group: 'Actions', Icon: Cpu, run: go(can(me, 'models.manage') ? '/settings/models#connect' : '/settings/connectors#connect') },
      { id: 'files', label: 'Files', group: 'Go to', Icon: Folder, run: go('/files') },
      { id: 'hub', label: 'Hub', group: 'Go to', Icon: Store, run: go('/hub') },
      ...(can(me, 'hub.approve') ? [{ id: 'review', label: 'Hub review', group: 'Go to', Icon: PackageCheck, run: go('/hub/review') }] : []),
      ...([['Models', '/settings/models', Cpu, 'models.manage'], ['Users', '/settings/users', Users, 'users.manage'], ['Roles', '/settings/roles', Shield, 'roles.manage'], ['Connectors', '/settings/connectors', Plug, undefined], ['Usage', '/usage', BarChart3, undefined]] as const)
        .filter(([, , , p]) => !p || can(me, p)).map(([l, h, Icon]) => ({ id: h, label: `Settings: ${l}`, group: 'Go to', Icon: Icon as LucideIcon, run: go(h) })),
      { id: 'theme-system', label: 'Theme: match the system', group: 'Theme', Icon: Monitor, run: () => setTheme('system') },
      { id: 'theme-light', label: 'Theme: light', group: 'Theme', Icon: Sun, run: () => setTheme('light') },
      { id: 'theme-dark', label: 'Theme: dark', group: 'Theme', Icon: Moon, run: () => setTheme('dark') },
      ...threads.map((t) => ({ id: `t-${t.id}`, label: t.title, group: 'Threads', Icon: MessageSquare, run: go(`/#${t.id}`) })),
    ];
    const s = q.trim().toLowerCase();
    const out = s ? it.filter((x) => `${x.group} ${x.label}`.toLowerCase().includes(s)) : it;
    return s ? [...out, { id: 'hub-search', label: `Search the hub for “${q.trim()}”`, group: 'Hub', Icon: Search, run: go(`/hub?q=${encodeURIComponent(q.trim())}`) }] : out;
  }, [q, threads, me]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const run = (i?: Item) => { if (!i) return; ref.current?.close(); i.run(); };
  return (
    <dialog ref={ref} aria-label="Command palette" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}
      className="float m-0 mx-auto mt-[12vh] w-[min(36rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0 text-foreground ring-1 ring-border backdrop:bg-black/40">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search size={16} strokeWidth={1.75} aria-hidden className="text-muted" />
        <input autoFocus role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[sel] ? `p-${items[sel].id}` : undefined} aria-label="Search commands" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command or search threads"
          className="h-11 grow bg-transparent text-sm outline-none placeholder:text-muted"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % Math.max(items.length, 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + items.length) % Math.max(items.length, 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
          }} />
        <Kbd>Esc</Kbd>
      </div>
      <div id="palette-list" ref={list} role="listbox" className="max-h-80 overflow-y-auto p-1.5">
        {!items.length && <p className="px-3 py-6 text-center text-sm text-muted">Nothing matches. Try another word.</p>}
        {items.map((x, i) => (
          <div key={x.id}>
            {(i === 0 || items[i - 1].group !== x.group) && <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted">{x.group}</div>}
            <div id={`p-${x.id}`} role="option" aria-selected={i === sel} onMouseMove={() => setSel(i)} onClick={() => run(x)}
              className={`flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] ${i === sel ? 'bg-foreground/[0.07]' : ''}`}>
              <x.Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" /><span className="min-w-0 grow truncate">{x.label}</span>
              {x.keys && <Kbd>{x.keys}</Kbd>}{i === sel && !x.keys && <CornerDownLeft size={13} aria-hidden className="text-muted" />}
            </div>
          </div>
        ))}
      </div>
    </dialog>
  );
}
