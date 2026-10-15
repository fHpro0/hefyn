import { BarChart3, Cpu, Folder, LogOut, MessageSquare, PanelLeft, PackageCheck, Plug, Settings, Shield, ShieldAlert, Store, Users, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, can, useMe, useRuntime, type Me, type Runtime } from './api';
import { Toaster } from './ui';

const SETTINGS = [
  ['/settings/models', 'Models', Cpu, 'models.manage'], ['/settings/users', 'Users', Users, 'users.manage'], ['/settings/roles', 'Roles', Shield, 'roles.manage'],
  ['/settings/connectors', 'Connectors', Plug, undefined], ['/usage', 'Usage', BarChart3, undefined],
] as const;

export const paneRow = (active: boolean) =>
  `flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm transition-colors ${active ? 'bg-hefyn/12 font-medium text-hefyn' : 'text-ink hover:bg-ink/5'}`;
export const PaneHeading = ({ children }: { children: ReactNode }) => <div className="px-2.5 pt-4 pb-1 text-xs font-medium text-soft">{children}</div>;

type Area = 'chat' | 'files' | 'hub' | 'settings';
const areaOf = (path: string): Area => (path === '/' ? 'chat' : path.startsWith('/files') ? 'files' : path.startsWith('/hub') ? 'hub' : 'settings');
const RAIL = [['chat', '/', 'Chat', MessageSquare], ['files', '/files', 'Files', Folder], ['hub', '/hub', 'Hub', Store], ['settings', '/settings/models', 'Settings', Settings]] as const;

interface ShellProps {
  children: (me: Me, rt?: Runtime) => ReactNode;
  pane?: ReactNode | ((me: Me, pending: number) => ReactNode); paneTitle?: string; title?: ReactNode; actions?: ReactNode;
  ledger?: ReactNode; ledgerOpen?: boolean; onLedgerClose?: () => void;
  pending?: number; // hub review count, shown on the rail
}

export default function Shell({ children, pane, paneTitle, title, actions, ledger, ledgerOpen, onLedgerClose }: ShellProps) {
  const me = useMe();
  const rt = useRuntime();
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState(false);
  const [paneOpen, setPaneOpen] = useState(() => innerWidth >= 900 && localStorage.getItem('hefyn-pane') !== '0');
  useEffect(() => { me && can(me, 'hub.approve') && api<unknown[]>('/api/hub/review').then((r) => setPending(r.length)).catch(() => {}); }, [me]);
  useEffect(() => { if (innerWidth >= 900) localStorage.setItem('hefyn-pane', paneOpen ? '1' : '0'); }, [paneOpen]);
  if (!me) return <div className="grid min-h-dvh place-items-center text-soft">Loading…</div>;
  const path = location.pathname.replace(/\/$/, '') || '/';
  const area = areaOf(path);
  const links = SETTINGS.filter(([, , , p]) => !p || can(me, p));
  const glinerOff = rt?.privacy?.gliner === false;
  const settingsNav = (
    <nav aria-label="Settings" className="grid gap-0.5">
      {links.map(([href, label, Icon]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined} className={paneRow(path === href)}><Icon size={16} aria-hidden />{label}</a>)}
    </nav>
  );

  return (
    <div className="flex h-dvh bg-paper max-sm:flex-col-reverse">
      <nav aria-label="Main" className="flex w-16 shrink-0 flex-col items-center gap-1 py-3 max-sm:h-14 max-sm:w-full max-sm:flex-row max-sm:justify-around max-sm:border-t max-sm:bg-sheet max-sm:py-0">
        <a href="/" aria-label="hefyn home" className="mb-3 grid size-10 place-items-center rounded-[10px] max-sm:hidden"><img src="/brand/hefyn-mark.svg" alt="" className="h-7" /></a>
        {RAIL.map(([a, href, label, Icon]) => (
          <a key={a} href={href} aria-label={label} aria-current={area === a ? 'page' : undefined}
            className={`group relative grid size-11 place-items-center rounded-[12px] transition-colors ${area === a ? 'bg-hefyn/12 text-hefyn' : 'text-soft hover:bg-ink/5 hover:text-ink'}`}>
            <Icon size={20} aria-hidden />
            {a === 'hub' && pending > 0 && <span className="absolute top-1 right-1 min-w-4 rounded-full bg-hefyn px-1 text-center text-[10px] leading-4 font-semibold text-on-hefyn" aria-label={`${pending} to review`}>{pending}</span>}
            <span role="tooltip" className="pointer-events-none absolute left-full z-50 ml-2 hidden rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-paper group-hover:block group-focus-visible:block max-sm:hidden">{label}</span>
          </a>
        ))}
        <div className="relative mt-auto flex flex-col items-center gap-2 max-sm:mt-0">
          {glinerOff && <span role="img" title="Redaction is reduced: GLiNER is off" aria-label="Redaction is reduced: GLiNER is off" className="text-alarm"><ShieldAlert size={18} /></span>}
          <button aria-label="Account" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="grid size-9 place-items-center rounded-full bg-hefyn/15 text-sm font-semibold text-hefyn">{me.name.slice(0, 1).toUpperCase()}</button>
          {menu && (
            <div role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)} className="absolute bottom-0 left-full z-50 ml-2 w-56 rounded-[12px] bg-sheet p-2 shadow-float ring-1 ring-line max-sm:right-0 max-sm:bottom-full max-sm:left-auto max-sm:mr-0 max-sm:mb-2">
              <div className="px-2.5 py-2"><div className="truncate text-sm font-medium">{me.name}</div><div className="text-xs text-soft">{me.role}</div></div>
              <button role="menuitem" autoFocus className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-sm hover:bg-ink/5" onClick={async () => { await api('/api/auth/sign-out', 'POST', {}).catch(() => {}); location.href = '/login'; }}><LogOut size={15} aria-hidden />Sign out</button>
            </div>
          )}
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 grow">
        {paneOpen && <div className="fixed inset-0 z-30 bg-ink/30 min-[900px]:hidden" onClick={() => setPaneOpen(false)} aria-hidden />}
        {paneOpen && (
          <aside aria-label={paneTitle ?? 'Menu'} className="z-40 my-2 flex w-[260px] shrink-0 flex-col overflow-hidden rounded-2xl bg-sheet max-[899px]:fixed max-[899px]:inset-y-2 max-[899px]:left-[4.5rem] max-[899px]:shadow-float max-sm:bottom-[4.25rem] max-sm:left-2 max-sm:w-[min(20rem,calc(100vw-1rem))]">
            <div className="flex h-12 shrink-0 items-center justify-between px-4"><span className="text-[17px] font-semibold tracking-[-0.01em]">{paneTitle ?? { chat: 'Conversations', files: 'Files', hub: 'Hub', settings: 'Settings' }[area]}</span>
              <button className="rounded-md p-1 text-soft hover:bg-ink/5" aria-label="Hide menu" onClick={() => setPaneOpen(false)}><X size={16} /></button></div>
            <div className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto px-2 pb-3">{typeof pane === 'function' ? pane(me, pending) : pane ?? settingsNav}</div>
          </aside>
        )}
        <div className="flex min-w-0 grow flex-col">
          {glinerOff && can(me, 'models.manage') && (
            <div role="alert" className="flex items-center gap-2 bg-alarm/12 px-6 py-2 text-sm text-alarm-ink"><ShieldAlert size={16} aria-hidden />GLiNER is off, so personal data in free text may reach the model. Use this setup for development and tests only.</div>
          )}
          {rt && rt.state !== 'running' && (
            <div role="status" className="bg-seal/12 px-6 py-2 text-sm text-seal"><b>hefyn is restarting.</b> Sending is paused until running tasks finish.</div>
          )}
          {!me.providerConnected && (
            <div role="status" className="bg-hefyn/10 px-6 py-2 text-sm"><b>Connect a model to start chatting.</b>{' '}
              {can(me, 'models.manage') ? <a className="text-hefyn underline" href="/settings/models">Connect a model</a> : 'Ask an admin to connect one.'}</div>
          )}
          <header className="flex h-14 shrink-0 items-center gap-2 px-3">
            {!paneOpen && <button className="grid size-9 place-items-center rounded-[10px] text-soft hover:bg-ink/5" aria-label="Show menu" onClick={() => setPaneOpen(true)}><PanelLeft size={18} /></button>}
            <div className="min-w-0 grow truncate text-[17px] font-semibold tracking-[-0.01em]">{title}</div>
            {actions}
          </header>
          <main className="flex min-h-0 grow flex-col overflow-y-auto max-sm:pb-0">{children(me, rt)}</main>
        </div>
        {ledgerOpen && ledger && <div className="fixed inset-0 z-30 bg-ink/30 min-[1100px]:hidden" onClick={onLedgerClose} aria-hidden />}
        {ledgerOpen && ledger && (
          <aside aria-label="Privacy ledger" className="z-40 my-2 mr-2 flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl bg-sheet max-[1099px]:fixed max-[1099px]:inset-y-2 max-[1099px]:right-0 max-[1099px]:w-[min(360px,calc(100vw-1rem))] max-[1099px]:shadow-float max-sm:bottom-[4.25rem]">{ledger}</aside>
        )}
      </div>
      <Toaster />
    </div>
  );
}
