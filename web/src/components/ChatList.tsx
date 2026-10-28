import { Archive, ArchiveRestore, ArrowLeft, ArrowUpDown, CheckSquare, Ellipsis, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from '@/ui/sidebar';
import type { WebModule } from '../modules/registry';
import { trpc } from '@/lib/trpc';
import { attempt, bulk, groupThreads, patchChat, SORTS, type Sort, type Thread } from './chat-actions';
import { MenuArea } from './AppMenu';
import { AgentIcon, AssistantIcon, findAgent, loadAgents, loadAssistants, type AssistantInfo, type CliAgent } from './AgentChoice';
import { ConfirmDialog } from './dialogs';
import { ActivityDot, LaneGlyph, useLeaving, type LaneState } from './ActivityStatus';
import type { Status } from './activity';
import { Input, Loading } from './ui';

const item = 'px-2 text-[13px] text-foreground/80 data-active:bg-foreground/[0.07] data-active:text-foreground';
const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;

interface Lane { id: string; label: string; state: LaneState }

/** The sub-agents at work in a chat, under its row: only active ones, rows fade in and fold away as they start and finish. */
function SubList({ agents, current, onOpen }: { agents: Lane[]; current?: string; onOpen: (lane: string) => void }) {
  const rows = useLeaving(agents);
  if (!rows.length) return null;
  return (
    <SidebarMenuSub className="mx-2 gap-px">
      {rows.map(({ a, leaving }) => (
        <SidebarMenuSubItem key={a.id} className={leaving ? 'hf-row-out' : 'hf-row-in'}><div className="min-h-0 overflow-hidden">
          <SidebarMenuSubButton render={<button type="button" />} isActive={current === a.id} className="w-full text-[13px]" tabIndex={leaving ? -1 : undefined} onClick={() => onOpen(a.id)}>
            <span className="grid shrink-0 place-items-center"><LaneGlyph state={a.state} /></span><span className="min-w-0 grow truncate text-left">{a.label}</span></SidebarMenuSubButton></div></SidebarMenuSubItem>))}
    </SidebarMenuSub>);
}

interface Props { threads: Thread[]; /** the list has not arrived yet: skeleton rows instead of the empty text */ loading?: boolean; mods: WebModule[]; states: Record<string, Status>; path: string; hash: string; closeSmall: () => void }

// The sidebar's chat list: pinned, grouped by day, sortable, per-chat actions, a select mode and the archive. Modules plug in through the slots of
// web/src/modules/registry.ts: a section that replaces the flat list (folders: the folder tree), badges, menu entries and selection buttons.
// Right-click on a chat opens the same actions as its ⋯ menu (a MenuArea; not while selecting chats).
export function ChatList({ threads, loading, mods, states, path, hash, closeSmall }: Props) {
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('hefyn-sort') as Sort) || 'activity');
  const [select, setSelect] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string>();
  const [confirm, setConfirm] = useState<{ ids: string[]; label: string }>();
  const [archivedView, setArchivedView] = useState(false);
  const [archived, setArchived] = useState<Thread[]>([]);
  const [cli, setCli] = useState<CliAgent[]>();
  const [assistants, setAssistants] = useState<AssistantInfo[]>([]);
  const [lanes, setLanes] = useState<Record<string, { lane: string; agents: Lane[] }>>({}); // the open chat's sub-agents, announced by CliChat
  useEffect(() => {
    const on = (e: Event) => { const { id, lane, agents } = (e as CustomEvent<{ id: string; lane: string; agents: Lane[] }>).detail; setLanes((s) => ({ ...s, [id]: { lane, agents } })); };
    addEventListener('hefyn-lanes', on); return () => removeEventListener('hefyn-lanes', on);
  }, []);
  const hasAssistant = threads.some((t) => t.assistantId);
  useEffect(() => { if (hasAssistant) loadAssistants().then(setAssistants); }, [hasAssistant]);
  const hasCli = threads.some((t) => t.agent && !t.assistantId);
  useEffect(() => { if (hasCli) loadAgents().then(setCli); }, [hasCli]); // the agents' icons, fetched only when a chat needs one
  useEffect(() => localStorage.setItem('hefyn-sort', sort), [sort]);
  const loadArchived = () => (trpc.conversations.list.query({ archived: true }) as Promise<Thread[]>).then(setArchived).catch(() => {});
  useEffect(() => { if (!archivedView) return; loadArchived(); addEventListener('hefyn-threads', loadArchived); return () => removeEventListener('hefyn-threads', loadArchived); }, [archivedView]);
  const leave = (ids: string[]) => { if (ids.includes(hash)) location.hash = ''; setPicked(new Set()); setSelect(false); };
  const remove = (ids: string[]) => attempt(() => bulk(ids, 'delete'), ids.length > 1 ? `${ids.length} chats deleted` : 'Chat deleted').then((ok) => ok && leave(ids));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ids = [...picked];
  const clear = () => setPicked(new Set());
  const sections = mods.flatMap((m) => m.sidebarSections ?? []), badges = mods.flatMap((m) => m.chatBadges ?? []);
  const menuItems = mods.flatMap((m) => m.chatMenuItems ?? []), chatsMenuItems = mods.flatMap((m) => m.chatsMenuItems ?? []), selectionActions = mods.flatMap((m) => m.selectionActions ?? []);
  const whereOf = (c: Thread) => mods.map((m) => m.chatLocation?.(c)).find(Boolean) ?? '';

  /** The inside of a chat row (a section may wrap it, e.g. in a draggable li). */
  const row = (c: Thread, inArchive = false) => {
    const on = path === '/' && hash === c.id;
    if (renaming === c.id) return (
      <Input aria-label="Chat name" className="h-8 text-[13px]" defaultValue={c.title} maxLength={80}
        ref={(el) => { if (el) setTimeout(() => { el.focus(); el.select(); }, 150); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(undefined); if (e.key === 'Enter') e.currentTarget.blur(); }}
        onBlur={(e) => { const v = e.currentTarget.value.trim(); setRenaming(undefined); if (v && v !== c.title) attempt(() => patchChat(c.id, { title: v })); }} />);
    const where = whereOf(c);
    const body = select && !inArchive ? (
      <SidebarMenuButton className={item} aria-pressed={picked.has(c.id)} onClick={() => toggle(c.id)}>
        <Checkbox tabIndex={-1} aria-hidden checked={picked.has(c.id)} className="pointer-events-none" /><span className="min-w-0 grow truncate">{c.title}</span></SidebarMenuButton>
    ) : (
      <MenuArea items={() => actions(c, inArchive)}>
        <SidebarMenuButton className={`${item} pr-7`} isActive={on} aria-current={on ? 'page' : undefined} title={where ? `${c.title} (${where})` : c.title} data-drag-main render={<a href={`/#${c.id}`} />} onClick={closeSmall}>
          {c.pinned && <Pin {...ico} size={12} className="shrink-0 text-muted-foreground" />}
          {(c.assistantId || c.agent) && <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden>
            {c.assistantId ? <AssistantIcon name={assistants.find((a) => a.id === c.assistantId)?.icon} size={12} /> : c.agent && <AgentIcon src={findAgent(cli, c.agent)?.icon} size={12} />}</span>}
          <span className="min-w-0 grow truncate">{c.title}</span>
          {badges.map((B, i) => <B key={i} chat={c} inArchive={inArchive} variant="row" />)}
          <ActivityDot status={states[c.id]} /></SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label={`Actions for ${c.title}`} />}><Ellipsis {...ico} /></DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-52">{actions(c, inArchive)}</DropdownMenuContent>
        </DropdownMenu>
      </MenuArea>);
    const open = (lane: string) => { // the open chat switches lane at once; another chat opens first and its CliChat picks the lane up when it mounts
      if (on) dispatchEvent(new CustomEvent('hefyn-open-lane', { detail: { id: c.id, lane } }));
      else { sessionStorage.setItem('hefyn-open-lane', JSON.stringify({ id: c.id, lane })); location.hash = c.id; }
      closeSmall();
    };
    return (<>{body}{!select && !inArchive && <SubList agents={activeLanes(c)} current={on ? lanes[c.id]?.lane : undefined} onOpen={open} />}</>);
  };
  /** The sub-agents at work in a chat: what the open chat's page announces, else the server's activity. */
  const activeLanes = (c: Thread): Lane[] => (path === '/' && hash === c.id && lanes[c.id] ? lanes[c.id]!.agents : (states[c.id]?.agents ?? []).filter((a) => a.kind === 'agent' && a.id).map((a) => ({ id: a.id!, label: a.name, state: a.state as LaneState }))).filter((a) => a.state === 'running' || a.state === 'waiting');

  /** One chat's actions: the items of its ⋯ menu and of its right-click menu (both render this list). */
  const actions = (c: Thread, inArchive: boolean) => (<>
    {inArchive ? (
      <DropdownMenuItem className="text-[13px]" onClick={() => attempt(() => patchChat(c.id, { archived: false }), 'Restored')}><ArchiveRestore {...ico} />Restore</DropdownMenuItem>
    ) : (<>
      <DropdownMenuItem className="text-[13px]" onClick={() => setRenaming(c.id)}><Pencil {...ico} />Rename</DropdownMenuItem>
      <DropdownMenuItem className="text-[13px]" onClick={() => attempt(() => patchChat(c.id, { pinned: !c.pinned }))}>{c.pinned ? <PinOff {...ico} /> : <Pin {...ico} />}{c.pinned ? 'Unpin' : 'Pin'}</DropdownMenuItem>
      {menuItems.map((M, i) => <M key={i} chat={c} done={clear} />)}
      <DropdownMenuItem className="text-[13px]" onClick={() => attempt(() => patchChat(c.id, { archived: true }), 'Archived').then((ok) => ok && leave([c.id]))}><Archive {...ico} />Archive</DropdownMenuItem>
    </>)}
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" className="text-[13px]" onClick={() => setConfirm({ ids: [c.id], label: c.title })}><Trash2 {...ico} />Delete</DropdownMenuItem>
  </>);

  // Chats that wait for the reader float to the top; answered, they return to their place.
  const needsYou = threads.filter((c) => states[c.id]?.state === 'waiting'), rest = needsYou.length ? threads.filter((c) => states[c.id]?.state !== 'waiting') : threads;
  // One quiet menu instead of a row of icons; while selecting, a plain "Done" ends it.
  const chatsHeader = select ? (
    <Button variant="ghost" size="xs" className="text-[12px]" onClick={() => { setSelect(false); setPicked(new Set()); }}>Done</Button>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-6 text-muted-foreground opacity-0 group-hover/chats:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100" aria-label="Chat options" title="Chat options" />}><Ellipsis {...ico} /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs"><ArrowUpDown {...ico} size={12} className="mr-1 inline" />Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup aria-label="Sort by" value={sort} onValueChange={(v) => setSort(v as Sort)}>
            {SORTS.map(([v, l]) => <DropdownMenuRadioItem key={v} value={v} className="text-[13px]">{l}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {chatsMenuItems.map((M, i) => <M key={i} />)}
        <DropdownMenuItem className="text-[13px]" onClick={() => { setSelect(true); setPicked(new Set()); }}><CheckSquare {...ico} />Select chats</DropdownMenuItem>
        <DropdownMenuItem className="text-[13px]" onClick={() => setArchivedView(true)}><Archive {...ico} />Archived chats</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // No module provides a chat area: pinned, then the chats grouped by day (the sort "custom" needs the folders module's drag and drop, so it falls back to activity here).
  const flat = (
    <>
      <div className="group/chats flex h-8 items-center pt-2"><span className="grow px-2 text-xs font-medium text-sidebar-foreground/70">Chats</span>{chatsHeader}</div>
      {groupThreads(rest, sort).map(([label, list]) => (
        <SidebarGroup key={label} className="p-0"><SidebarGroupLabel className="h-auto px-2 pt-3 pb-1">{label}</SidebarGroupLabel>
          <SidebarGroupContent><SidebarMenu className="gap-px">{list.map((c) => <SidebarMenuItem key={c.id}>{row(c)}</SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>))}
      {!threads.length && <p className="px-2 pt-3 text-[13px] text-muted-foreground">Your chats will appear here.</p>}
    </>
  );

  return (
    <>
      {archivedView ? (
        <SidebarGroup className="p-0">
          <div className="flex items-center gap-1 px-1 pt-2"><Button variant="ghost" size="icon" aria-label="Back to chats" onClick={() => setArchivedView(false)}><ArrowLeft {...ico} /></Button><span className="text-xs font-medium text-muted-foreground">Archived</span></div>
          <SidebarMenu>{archived.map((c) => <SidebarMenuItem key={c.id}>{row(c, true)}</SidebarMenuItem>)}</SidebarMenu>
          {!archived.length && <p className="px-2 pt-2 text-[13px] text-muted-foreground">No archived chats.</p>}
        </SidebarGroup>
      ) : (<>
        {!!needsYou.length && (
          <SidebarGroup className="p-0"><SidebarGroupLabel className="h-auto px-2 pt-3 pb-1 text-warning-ink">Needs you</SidebarGroupLabel>
            <SidebarGroupContent><SidebarMenu className="gap-px">{needsYou.map((c) => <SidebarMenuItem key={c.id}>{row(c)}</SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>)}
        <Suspense fallback={<Loading shape="rows" n={5} className="px-2 pt-3" />}>
          {loading ? <Loading shape="rows" n={5} className="px-2 pt-3" /> : sections.length ? sections.map((S, i) => <S key={i} threads={rest} sort={sort} setSort={setSort} select={select} path={path} hash={hash} closeSmall={closeSmall} chatRow={(c) => row(c)} chatsHeader={chatsHeader} />) : flat}
        </Suspense>
      </>)}
      {select && !archivedView && (
        <div role="toolbar" aria-label="Selected chats" className="sticky bottom-0 -mx-2 mt-2 flex flex-wrap items-center gap-1 border-t border-border bg-sidebar px-2 py-2">
          <span className="tnum mr-auto text-xs text-muted-foreground">{ids.length} selected</span>
          <Button variant="ghost" size="icon" aria-label="Archive selected" title="Archive" disabled={!ids.length} onClick={() => attempt(() => bulk(ids, 'archive'), 'Archived').then((ok) => ok && leave(ids))}><Archive {...ico} /></Button>
          {selectionActions.map((A, i) => <A key={i} ids={ids} done={clear} />)}
          <Button variant="ghost" size="icon" aria-label="Delete selected" title="Delete" disabled={!ids.length} className="text-danger-ink" onClick={() => setConfirm({ ids, label: `${ids.length} chats` })}><Trash2 {...ico} /></Button>
        </div>
      )}
      {confirm && <ConfirmDialog title={confirm.ids.length > 1 ? `Delete ${confirm.ids.length} chats?` : 'Delete this chat?'} action="Delete"
        body={`${confirm.ids.length > 1 ? confirm.label : `“${confirm.label}”`} will be removed for good: the messages and attachments. This can not be undone.`}
        onClose={() => setConfirm(undefined)} onConfirm={() => remove(confirm.ids)} />}
    </>
  );
}
