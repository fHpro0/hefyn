import { Activity, Cpu, MessageSquare, Monitor, Moon, Plus, Search, SquareTerminal, Sun } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/ui/command';
import { type Me, type ModuleCommand } from './api';
import type { Thread } from './chat-actions';
import type { PaletteItem, WebModule } from '../modules/registry';
import { iconFor } from './icons';
import { setTheme } from './theme';
import { Kbd, shortcut } from './ui';

export type { Thread };
type Item = PaletteItem;

// Command palette (⌘K): every main action is reachable here.
export default function Palette({ me, commands, mods, threads, initial = '', onClose }: { me: Me; commands: ModuleCommand[]; mods: WebModule[]; threads: Thread[]; initial?: string; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const go = (href: string) => () => { location.href = href; };
  const toggle = (what: 'terminal') => () => { location.pathname === '/' ? dispatchEvent(new CustomEvent('hefyn-toggle', { detail: what })) : (location.href = '/'); };
  const items = useMemo<Item[]>(() => {
    const it: Item[] = [
      { id: 'new', label: 'New chat', group: 'Actions', Icon: Plus, keys: shortcut('N'), run: () => { if (location.pathname === '/') { location.hash = ''; dispatchEvent(new Event('hefyn-newchat')); } else location.href = '/'; } },
      ...mods.flatMap((m) => m.paletteCommands?.() ?? []), // the modules' own entries (projects: new project / folder, project settings)
      { id: 'terminal', label: 'Toggle the terminal', group: 'Actions', Icon: SquareTerminal, keys: shortcut('J'), run: toggle('terminal') },
      ...(location.pathname === '/' && location.hash.length > 1 ? [{ id: 'trace', label: 'Open trace of this chat', group: 'Actions', Icon: Activity, run: go(`/trace${location.hash}`) }] : []),
      { id: 'connect', label: 'Connect a provider', group: 'Actions', Icon: Cpu, run: go('/settings/providers#connect') },
      ...commands.map((c) => ({ id: c.href, label: c.label, group: 'Go to', Icon: iconFor(c.icon), run: go(c.href) })),
      { id: 'theme-system', label: 'Theme: match the system', group: 'Theme', Icon: Monitor, run: () => setTheme('system') },
      { id: 'theme-light', label: 'Theme: light', group: 'Theme', Icon: Sun, run: () => setTheme('light') },
      { id: 'theme-dark', label: 'Theme: dark', group: 'Theme', Icon: Moon, run: () => setTheme('dark') },
      ...threads.map((t) => ({ id: `t-${t.id}`, label: t.title, group: 'Threads', Icon: MessageSquare, extra: mods.map((m) => m.chatLocation?.(t)).find(Boolean), run: go(`/#${t.id}`) })),
    ];
    const s = q.trim().toLowerCase();
    return s ? it.filter((x) => `${x.group} ${x.label} ${x.extra ?? ''}`.toLowerCase().includes(s)) : it;
  }, [q, threads, mods, me, commands]);
  const run = (i: Item) => { onClose(); i.run(); };
  const groups = items.reduce<[string, Item[]][]>((g, x) => { const last = g.at(-1); last?.[0] === x.group ? last[1].push(x) : g.push([x.group, [x]]); return g; }, []);
  // Filtering stays ours (group + label match), so cmdk's own is off.
  return (
    <CommandDialog open onOpenChange={(o) => !o && onClose()} title="Command palette" description="Run a command or search threads" className="top-[12vh] translate-y-0 sm:max-w-xl">
      <Command shouldFilter={false} label="Command palette" className="rounded-none! p-0">
        <CommandInput aria-label="Search commands" value={q} onValueChange={setQ} placeholder="Type a command or search threads" />
        <CommandList className="max-h-80 p-1.5">
          <CommandEmpty className="px-3 text-muted-foreground">Nothing matches. Try another word.</CommandEmpty>
          {groups.map(([group, list]) => (
            <CommandGroup key={group} heading={group}>
              {list.map((x) => (
                <CommandItem key={x.id} value={x.id} onSelect={() => run(x)} className="text-[13px]">
                  <x.Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground" /><span className="min-w-0 grow truncate">{x.label}</span>{x.extra && <span className="shrink-0 text-xs text-muted-foreground">{x.extra}</span>}
                  {x.keys && <CommandShortcut><Kbd>{x.keys}</Kbd></CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
