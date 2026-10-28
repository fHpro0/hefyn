import { ArrowLeft, ChevronsUpDown, LogOut, Monitor, Moon, PanelLeft, PanelLeftClose, Search, Settings, Sun } from 'lucide-react';
import { Fragment, lazy, Suspense, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, useSidebar } from '@/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { trpc } from '@/lib/trpc';
import { api, can, useMe, useModules, useQuery, useReconnecting, useRuntime, type Me, type NavItem, type Runtime } from './api';
import { iconFor } from './icons';
import { AppMenu } from './AppMenu';
import { ChatList } from './ChatList';
import { ActivityContext, useRemoteActivity } from './ActivityStatus';
import { attention, bareTitle, chatActivity, IDLE, pageTitle, type Live, type Status } from './activity';
import { AttentionBar, useNotifyHidden } from './attention';
import type { Thread } from './chat-actions';
import { useWebModules, type WebModule } from '../modules/registry';

// Palette (cmdk) opens on demand: it loads after first paint.
const Palette = lazy(() => import('./Palette'));
import { getTheme, setTheme, syncTheme, type Theme } from './theme';
import { Toaster } from './toast';
import { Loading, shortcut } from './ui';
import { Lockup, useBrand } from './brand';
import { brandHome } from './brand-label';
import { Avatar } from './Avatar';
import { settingsGroups } from './settings-nav';

// Hover/focus hint for an icon button (the button keeps its aria-label).
export const Hint = ({ label, children }: { label: string; children: ReactElement }) => (
  <Tooltip><TooltipTrigger render={children} /><TooltipContent>{label}</TooltipContent></Tooltip>
);

export const navRow = (active: boolean) =>
  `flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors ${active ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground'}`;
const iconCls = { size: 16, strokeWidth: 1.75, 'aria-hidden': true, className: 'shrink-0 text-muted-foreground' } as const;

const link = (href: string) => <a href={href} />;
const item = 'px-2 text-[13px] text-foreground/80 data-active:bg-foreground/[0.07] data-active:text-foreground';

function AppSidebar({ me, nav, links, path, hash, inSettings, threads, loading, mods, states, theme, onPalette }: {
  me: Me; nav: NavItem[]; links: NavItem[]; path: string; hash: string; inSettings: boolean; threads: Thread[]; loading: boolean; mods: WebModule[]; states: Record<string, Status>; theme: Theme; onPalette: () => void;
}) {
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const brand = useBrand();
  const closeSmall = () => isMobile && setOpenMobile(false);
  return (
    <Sidebar aria-label="Sidebar">
      <SidebarHeader className="h-12 shrink-0 flex-row items-center gap-1 px-3 py-0">
        <a href="/" aria-label={brandHome(brand)} className="mr-auto min-w-0 rounded"><Lockup height={18} compact /></a>
        <Hint label={`Command palette ${shortcut('K')}`}><Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Command palette, ${shortcut('K')}`} onClick={onPalette}><Search {...iconCls} /></Button></Hint>
        <Hint label={`Hide sidebar ${shortcut('B')}`}><Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Hide sidebar, ${shortcut('B')}`} onClick={toggleSidebar}><PanelLeftClose {...iconCls} /></Button></Hint>
      </SidebarHeader>
      <SidebarContent>
        {inSettings ? (
          <>
            <SidebarGroup className="pb-0"><SidebarMenu><SidebarMenuItem><SidebarMenuButton className={item} render={<a href="/#" />}><ArrowLeft {...iconCls} />Back to chats</SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarGroup>
            <SidebarGroup role="navigation" aria-label="Settings sections" className="pt-0">
              {settingsGroups(links).map((g) => (
                <Fragment key={g.label}>
                  <SidebarGroupLabel className="px-2">{g.label}</SidebarGroupLabel>
                  <SidebarMenu>
                    {g.items.map(({ href, label, icon }) => { const Icon = iconFor(icon); const on = path === href; return (
                      <SidebarMenuItem key={href}><SidebarMenuButton className={item} isActive={on} aria-current={on ? 'page' : undefined} render={link(href)}><Icon {...iconCls} />{label}</SidebarMenuButton></SidebarMenuItem>); })}
                  </SidebarMenu>
                </Fragment>))}
            </SidebarGroup>
          </>
        ) : (<>
        <SidebarGroup role="navigation" aria-label="Main" className="py-0">
          <SidebarMenu>
            {nav.filter((n) => n.place === 'main').map((n) => {
              const Icon = iconFor(n.icon);
              if (n.href === '/') return ( // the chat entry also resets the open thread
                <Fragment key={n.href}>
                  <SidebarMenuItem><SidebarMenuButton className={item} title={`${n.label} ${shortcut('N')}`} render={<a href="/#" />} onClick={() => { closeSmall(); path === '/' && dispatchEvent(new Event('hefyn-newchat')); }}><Icon {...iconCls} />{n.label}</SidebarMenuButton></SidebarMenuItem>
                  <SidebarMenuItem><SidebarMenuButton className={item} onClick={onPalette}><Search {...iconCls} />Search</SidebarMenuButton></SidebarMenuItem>
                </Fragment>
              );
              const on = path === n.href || path.startsWith(`${n.href}/`);
              return (
                <SidebarMenuItem key={n.href}><SidebarMenuButton className={item} isActive={on} aria-current={on ? 'page' : undefined} render={link(n.href)}><Icon {...iconCls} />{n.label}</SidebarMenuButton></SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
        <div className="mt-2 min-h-0 grow overflow-y-auto border-t border-border px-2 pb-2" role="navigation" aria-label="Threads">
          <ChatList threads={threads} loading={loading} mods={mods} states={states} path={path} hash={hash} closeSmall={closeSmall} />
        </div>
        </>)}
      </SidebarContent>
      <SidebarFooter className="shrink-0 flex-row items-center gap-1 border-t border-border">
        <SidebarMenu className="grow"><SidebarMenuItem><SidebarMenuButton className={item} isActive={inSettings} aria-current={inSettings ? 'page' : undefined} render={link(links[0]?.href ?? '/settings/profile')}><Settings {...iconCls} />Settings</SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" aria-label="Account" className="gap-1.5 px-1.5" />}>
            <Avatar name={me.name} image={me.image} /><ChevronsUpDown size={12} aria-hidden className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56">
            <div className="flex items-center gap-2.5 px-2.5 py-2"><Avatar name={me.name} image={me.image} size={32} /><div className="min-w-0"><div className="truncate text-[13px] font-medium">{me.name}</div><div className="text-xs text-muted-foreground">{me.role}</div>{brand?.name && <div className="truncate text-xs text-muted-foreground">{brand.name} workspace</div>}</div></div>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup aria-label="Theme" value={theme} onValueChange={(t) => setTheme(t as Theme)}>
              {([['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const).map(([t, l, Icon]) => <DropdownMenuRadioItem key={t} value={t} className="text-[13px]"><Icon {...iconCls} />{l}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[13px]" onClick={async () => { await api('/api/auth/sign-out', 'POST', {}).catch(() => {}); location.href = '/login'; }}><LogOut {...iconCls} />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

// Header button that brings the sidebar back (desktop: when collapsed; small screens: always).
function ShowSidebar() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  if (open && !isMobile) return null;
  return <Hint label={`Show sidebar ${shortcut('B')}`}><Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Show sidebar, ${shortcut('B')}`} onClick={toggleSidebar}><PanelLeft {...iconCls} /></Button></Hint>;
}

interface ShellProps {
  children: (me: Me, rt?: Runtime) => ReactNode;
  title?: ReactNode; actions?: ReactNode;
  panel?: ReactNode | ((me: Me) => ReactNode); panelOpen?: boolean; onPanelClose?: () => void;
}

export default function Shell({ children, title, actions, panel, panelOpen, onPanelClose }: ShellProps) {
  const me = useMe();
  const reconnecting = useReconnecting();
  const rt = useRuntime();
  const threads = useQuery(() => trpc.conversations.list.query() as Promise<Thread[]>);
  const { nav, commands } = useModules();
  const mods = useWebModules(); // the console parts of the modules that are on
  const [palette, setPalette] = useState(false);
  const [paletteQ, setPaletteQ] = useState(''); // prefill from the right-click menu's "Search for …"
  useEffect(() => { const f = (e: Event) => { setPaletteQ((e as CustomEvent<string | undefined>).detail ?? ''); setPalette(true); }; addEventListener('hefyn-palette', f); return () => removeEventListener('hefyn-palette', f); }, []);
  const [live, setLive] = useState<Record<string, Live>>({}); // what the open page knows about its chat (hefyn-busy); the server's poll covers the rest
  const remote = useRemoteActivity();
  const states = useMemo(() => Object.fromEntries([...new Set([...Object.keys(live), ...Object.keys(remote)])].map((id) => [id, chatActivity(live[id], remote[id])])), [live, remote]);
  const ctx = useMemo(() => ({ of: (id?: string) => (id && states[id]) || IDLE }), [states]);
  const working = Object.values(states).some((s) => s.state !== 'idle');
  const [hash, setHash] = useState(location.hash.slice(1));
  const titles = useMemo(() => Object.fromEntries((threads.data ?? []).map((t) => [t.id, t.title])), [threads.data]);
  const needs = useMemo(() => attention(states, titles, location.pathname.replace(/\/$/, '') === '' ? hash : undefined), [states, titles, hash]); // the open chat's own dock shows its request
  useNotifyHidden(needs);
  useEffect(() => { // a background tab shows it in its title
    const base = bareTitle(document.title);
    document.title = pageTitle(base, needs.length, working);
    return () => { document.title = base; };
  }, [working, needs.length]);
  const [theme, setThemeState] = useState<Theme>('system');
  const [sidebar, setSidebar] = useState(() => innerWidth >= 800 && localStorage.getItem('hefyn-sidebar') !== '0');
  useEffect(() => { syncTheme(); setThemeState(getTheme()); const f = () => setThemeState(getTheme()); addEventListener('hefyn-theme', f); return () => removeEventListener('hefyn-theme', f); }, []);
  useEffect(() => { if (innerWidth >= 800) localStorage.setItem('hefyn-sidebar', sidebar ? '1' : '0'); }, [sidebar]);
  useEffect(() => { const f = () => setHash(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { const f = () => { threads.reload(); }; addEventListener('hefyn-threads', f); return () => removeEventListener('hefyn-threads', f); }, []);
  useEffect(() => {
    const f = (e: Event) => {
      const { id, ...d } = (e as CustomEvent<{ id: string } & Live>).detail;
      setLive((s) => { const { [id]: prev, ...rest } = s; return d.busy || d.waiting ? { ...rest, [id]: { ...d, since: prev?.since ?? Date.now() } } : rest; });
      dispatchEvent(new Event('hefyn-activity'));
    };
    addEventListener('hefyn-busy', f); return () => removeEventListener('hefyn-busy', f);
  }, []);
  useEffect(() => { // shortcuts: ⌘K palette, ⌘N new chat, ⌘J terminal (Ctrl on other platforms); ⌘B is SidebarProvider's
    const f = (e: KeyboardEvent) => {
      if (!(navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        k: () => setPalette((p) => !p),
        n: () => { if (location.pathname === '/') { location.hash = ''; dispatchEvent(new Event('hefyn-newchat')); } else location.href = '/'; },
        j: () => dispatchEvent(new CustomEvent('hefyn-toggle', { detail: 'terminal' })),
      };
      if (act[k]) { e.preventDefault(); act[k](); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  if (!me) return <div className="grid min-h-dvh place-items-center text-muted-foreground">{reconnecting ? <p role="status">Reconnecting…</p> : <Loading className="w-64" n={4} />}</div>;
  const path = location.pathname.replace(/\/$/, '') || '/';
  if ((me.twoFactorSetupRequired || me.passwordChangeRequired) && path !== '/settings/security') { location.replace('/settings/security'); return null; } // policy: set up 2FA first
  const links = nav.filter((n) => n.place === 'settings');
  const inSettings = path.startsWith('/settings') || links.some((n) => n.href === path);

  return (
    <TooltipProvider>
    <ActivityContext.Provider value={ctx}>
    <SidebarProvider open={sidebar} onOpenChange={setSidebar} style={{ '--sidebar-width': '260px' } as React.CSSProperties} className="h-dvh min-h-0 bg-background text-foreground">
      <AppSidebar me={me} nav={nav} links={links} path={path} hash={hash} inSettings={inSettings} threads={threads.data ?? []} loading={!threads.data && !threads.error} mods={mods} states={states} theme={theme} onPalette={() => setPalette(true)} />
      <div className="flex min-w-0 grow flex-col">
        <Suspense fallback={null}>{mods.flatMap((m) => m.hosts ?? []).map((H, i) => <H key={i} />)}</Suspense>
        {rt && rt.state !== 'running' && (
          <div role="status" className="border-b border-seal/30 bg-seal/10 px-4 py-1.5 text-[13px] text-seal"><b>hefyn is restarting.</b> Sending is paused until running tasks finish.</div>
        )}
        <AttentionBar list={needs} />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <ShowSidebar />
          <div className="min-w-0 grow truncate text-sm font-medium">{title ?? (inSettings ? links.find((n) => n.href === path)?.label ?? 'Settings' : undefined)}</div>
          {actions}
        </header>
        <div className="flex min-h-0 grow">
          <main className="flex min-h-0 min-w-0 grow flex-col overflow-y-auto">{children(me, rt)}</main>
          {panelOpen && panel && <div className="fixed inset-0 z-30 bg-black/30 min-[1100px]:hidden" onClick={onPanelClose} aria-hidden />}
          {panelOpen && panel && (
            <aside aria-label="Panel" className="z-40 flex w-[360px] shrink-0 flex-col border-l border-border bg-surface max-[1099px]:fixed max-[1099px]:inset-y-0 max-[1099px]:right-0 max-[1099px]:w-[min(360px,100vw)] max-[1099px]:shadow-float">{typeof panel === 'function' ? panel(me) : panel}</aside>
          )}
        </div>
      </div>
      {palette && <Suspense fallback={null}><Palette initial={paletteQ} me={me} commands={commands} mods={mods} threads={threads.data ?? []} onClose={() => { setPalette(false); setPaletteQ(''); }} /></Suspense>}
      <AppMenu />
      <Toaster />
    </SidebarProvider>
    </ActivityContext.Provider>
    </TooltipProvider>
  );
}
