import { BarChart3, Check, ChevronsUpDown, Cpu, Folder, LogOut, Monitor, Moon, PackageCheck, PanelLeft, PanelLeftClose, Plug, Search, Settings, Shield, ShieldAlert, SquarePen, Store, Sun, Users, X } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api, can, useLoad, useMe, useRuntime, type Me, type Runtime } from './api';
import Palette, { type Thread } from './Palette';
import { getTheme, setTheme, type Theme } from './theme';
import { iconButton, shortcut, Toaster, Wordmark } from './ui';

const SETTINGS = [
  ['/settings/models', 'Models', Cpu, 'models.manage'], ['/settings/users', 'Users', Users, 'users.manage'], ['/settings/roles', 'Roles', Shield, 'roles.manage'],
  ['/settings/connectors', 'Connectors', Plug, undefined], ['/usage', 'Usage', BarChart3, undefined],
] as const;

export const navRow = (active: boolean) =>
  `flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors ${active ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground'}`;
const iconCls = { size: 16, strokeWidth: 1.75, 'aria-hidden': true, className: 'shrink-0 text-muted' } as const;

function dayGroups(list: Thread[]) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(new Date());
  const out: [string, Thread[]][] = [['Today', []], ['Yesterday', []], ['Earlier', []]];
  for (const c of list) { const age = c.createdAt ? Math.round((today - day(new Date(c.createdAt))) / 864e5) : 2; out[age <= 0 ? 0 : age === 1 ? 1 : 2][1].push(c); }
  return out.filter(([, l]) => l.length);
}

interface ShellProps {
  children: (me: Me, rt?: Runtime) => ReactNode;
  title?: ReactNode; actions?: ReactNode;
  panel?: ReactNode | ((me: Me) => ReactNode); panelOpen?: boolean; onPanelClose?: () => void;
}

export default function Shell({ children, title, actions, panel, panelOpen, onPanelClose }: ShellProps) {
  const me = useMe();
  const rt = useRuntime();
  const threads = useLoad<Thread[]>('/api/conversations');
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [theme, setThemeState] = useState<Theme>('system');
  const [hash, setHash] = useState(location.hash.slice(1));
  const [sidebar, setSidebar] = useState(() => innerWidth >= 800 && localStorage.getItem('hefyn-sidebar') !== '0');
  useEffect(() => { setThemeState(getTheme()); const f = () => setThemeState(getTheme()); addEventListener('hefyn-theme', f); return () => removeEventListener('hefyn-theme', f); }, []);
  useEffect(() => { me && can(me, 'hub.approve') && api<unknown[]>('/api/hub/review').then((r) => setPending(r.length)).catch(() => {}); }, [me]);
  useEffect(() => { if (innerWidth >= 800) localStorage.setItem('hefyn-sidebar', sidebar ? '1' : '0'); }, [sidebar]);
  useEffect(() => { const f = () => setHash(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { const f = () => threads.reload(); addEventListener('hefyn-threads', f); return () => removeEventListener('hefyn-threads', f); }, []);
  useEffect(() => {
    const f = (e: Event) => { const { id, busy: b } = (e as CustomEvent).detail; setBusy((s) => { const n = new Set(s); b ? n.add(id) : n.delete(id); return n; }); };
    addEventListener('hefyn-busy', f); return () => removeEventListener('hefyn-busy', f);
  }, []);
  useEffect(() => { // shortcuts: ⌘K palette, ⌘B sidebar, ⌘N new chat, ⌘L ledger, ⌘J terminal (Ctrl on other platforms)
    const f = (e: KeyboardEvent) => {
      if (!(navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        k: () => setPalette((p) => !p), b: () => setSidebar((s) => !s),
        n: () => { if (location.pathname === '/') { location.hash = ''; dispatchEvent(new Event('hefyn-newchat')); } else location.href = '/'; },
        l: () => dispatchEvent(new CustomEvent('hefyn-toggle', { detail: 'ledger' })), j: () => dispatchEvent(new CustomEvent('hefyn-toggle', { detail: 'terminal' })),
      };
      if (act[k]) { e.preventDefault(); act[k](); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  if (!me) return <div className="grid min-h-dvh place-items-center text-muted">Loading…</div>;
  const path = location.pathname.replace(/\/$/, '') || '/';
  const inSettings = path.startsWith('/settings') || path === '/usage';
  const links = SETTINGS.filter(([, , , p]) => !p || can(me, p));
  const glinerOff = rt?.privacy?.gliner === false;
  const small = innerWidth < 800;
  const closeSmall = () => small && setSidebar(false);

  const sidebarEl = (
    <aside aria-label="Sidebar" className="z-40 flex w-[260px] shrink-0 flex-col border-r border-border bg-surface max-[799px]:fixed max-[799px]:inset-y-0 max-[799px]:left-0 max-[799px]:shadow-float">
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        <a href="/" aria-label="hefyn home" className="mr-auto rounded"><Wordmark height={20} /></a>
        <button className={iconButton} aria-label={`Command palette, ${shortcut('K')}`} title={`Command palette ${shortcut('K')}`} onClick={() => setPalette(true)}><Search {...iconCls} /></button>
        <button className={iconButton} aria-label={`Hide sidebar, ${shortcut('B')}`} title={`Hide sidebar ${shortcut('B')}`} onClick={() => setSidebar(false)}><PanelLeftClose {...iconCls} /></button>
      </div>
      <nav aria-label="Main" className="grid gap-0.5 px-2">
        <a href="/#" title={`New chat ${shortcut('N')}`} className={navRow(false)} onClick={() => { closeSmall(); path === '/' && dispatchEvent(new Event('hefyn-newchat')); }}><SquarePen {...iconCls} />New chat</a>
        <button className={navRow(false)} onClick={() => setPalette(true)}><Search {...iconCls} />Search</button>
        <a href="/files" aria-current={path === '/files' ? 'page' : undefined} className={navRow(path === '/files')}><Folder {...iconCls} />Files</a>
        <a href="/hub" aria-current={path.startsWith('/hub') ? 'page' : undefined} className={navRow(path.startsWith('/hub'))}><Store {...iconCls} />Hub
          {pending > 0 && <span className="tnum ml-auto rounded-md bg-foreground px-1.5 text-[11px] font-medium text-background" aria-label={`${pending} to review`}>{pending}</span>}</a>
      </nav>
      <nav aria-label="Threads" className="mt-2 min-h-0 grow overflow-y-auto border-t border-border px-2 pb-2">
        {dayGroups(threads.data ?? []).map(([label, list]) => (
          <Fragment key={label}><div className="px-2 pt-3 pb-1 text-xs font-medium text-muted">{label}</div>
            {list.map((c) => { const on = path === '/' && hash === c.id; return (
              <a key={c.id} href={`/#${c.id}`} title={c.title} aria-current={on ? 'page' : undefined} className={navRow(on)} onClick={closeSmall}>
                <span className="min-w-0 grow truncate">{c.title}</span>{busy.has(c.id) && <span role="img" aria-label="Running" className="size-1.5 shrink-0 rounded-full bg-seal" />}</a>); })}
          </Fragment>
        ))}
        {threads.data && !threads.data.length && <p className="px-2 pt-3 text-[13px] text-muted">Your threads will appear here.</p>}
      </nav>
      <div className="relative flex items-center gap-1 border-t border-border p-2">
        <a href="/settings/models" aria-current={inSettings ? 'page' : undefined} className={`${navRow(inSettings)} w-auto grow`}><Settings {...iconCls} />Settings</a>
        {glinerOff && <span role="img" title="Redaction is reduced: GLiNER is off" aria-label="Redaction is reduced: GLiNER is off" className="text-danger"><ShieldAlert size={16} strokeWidth={1.75} /></span>}
        <button aria-label="Account" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 hover:bg-foreground/5">
          <span className="grid size-6 place-items-center rounded-full bg-foreground/10 text-xs font-semibold">{me.name.slice(0, 1).toUpperCase()}</span><ChevronsUpDown size={12} aria-hidden className="text-muted" /></button>
        {menu && (
          <div role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)} className="float absolute right-2 bottom-12 z-50 w-56 rounded-xl p-1 ring-1 ring-border">
            <div className="px-2.5 py-2"><div className="truncate text-[13px] font-medium">{me.name}</div><div className="text-xs text-muted">{me.role}</div></div>
            <div className="border-t border-border py-1" role="group" aria-label="Theme">
              {([['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const).map(([t, l, Icon]) => (
                <button key={t} role="menuitemradio" aria-checked={theme === t} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-foreground/5" onClick={() => setTheme(t)}><Icon {...iconCls} />{l}{theme === t && <Check size={14} aria-hidden className="ml-auto" />}</button>))}
            </div>
            <div className="border-t border-border pt-1"><button role="menuitem" className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-foreground/5" onClick={async () => { await api('/api/auth/sign-out', 'POST', {}).catch(() => {}); location.href = '/login'; }}><LogOut {...iconCls} />Sign out</button></div>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex h-dvh bg-background text-foreground">
      {sidebar && small && <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setSidebar(false)} aria-hidden />}
      {sidebar && sidebarEl}
      <div className="flex min-w-0 grow flex-col">
        {glinerOff && can(me, 'models.manage') && (
          <div role="alert" className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[13px] text-danger-ink"><ShieldAlert size={14} strokeWidth={1.75} aria-hidden />GLiNER is off, so personal data in free text may reach the model. Use this setup for development and tests only.</div>
        )}
        {rt && rt.state !== 'running' && (
          <div role="status" className="border-b border-seal/30 bg-seal/10 px-4 py-1.5 text-[13px] text-seal"><b>hefyn is restarting.</b> Sending is paused until running tasks finish.</div>
        )}
        {!me.providerConnected && (
          <div role="status" className="border-b border-border bg-foreground/[0.04] px-4 py-1.5 text-[13px]"><b>Connect a model to start chatting.</b>{' '}
            {can(me, 'models.manage') ? <a className="underline underline-offset-2" href="/settings/models#connect">Connect a model</a> : 'Ask an admin to connect one.'}</div>
        )}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          {!sidebar && <button className={iconButton} aria-label={`Show sidebar, ${shortcut('B')}`} title={`Show sidebar ${shortcut('B')}`} onClick={() => setSidebar(true)}><PanelLeft {...iconCls} /></button>}
          <div className="min-w-0 grow truncate text-sm font-medium">{title ?? (inSettings ? 'Settings' : undefined)}</div>
          {actions}
        </header>
        <div className="flex min-h-0 grow">
          <div className="flex min-w-0 grow flex-col max-[799px]:flex-col min-[800px]:flex-row">
            {inSettings && (
              <nav aria-label="Settings sections" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border p-2 min-[800px]:w-48 min-[800px]:flex-col min-[800px]:border-r min-[800px]:border-b-0">
                {links.map(([href, label, Icon]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined} className={`${navRow(path === href)} w-auto min-[800px]:w-full`}><Icon {...iconCls} />{label}</a>)}
              </nav>
            )}
            <main className="flex min-h-0 min-w-0 grow flex-col overflow-y-auto">{children(me, rt)}</main>
          </div>
          {panelOpen && panel && <div className="fixed inset-0 z-30 bg-black/30 min-[1100px]:hidden" onClick={onPanelClose} aria-hidden />}
          {panelOpen && panel && (
            <aside aria-label="Panel" className="z-40 flex w-[360px] shrink-0 flex-col border-l border-border bg-surface max-[1099px]:fixed max-[1099px]:inset-y-0 max-[1099px]:right-0 max-[1099px]:w-[min(360px,100vw)] max-[1099px]:shadow-float">{typeof panel === 'function' ? panel(me) : panel}</aside>
          )}
        </div>
      </div>
      {palette && <Palette me={me} threads={threads.data ?? []} onClose={() => setPalette(false)} />}
      <Toaster />
    </div>
  );
}
