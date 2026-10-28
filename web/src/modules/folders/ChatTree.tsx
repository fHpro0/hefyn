import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { ChevronRight, Ellipsis, FolderInput, Folder as FolderIcon, FolderOpen, FolderPlus, Pencil, Plus, Settings2, Trash2, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { MenuArea } from '@/components/AppMenu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { SidebarGroup, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarGroupLabel, SidebarGroupContent } from '@/ui/sidebar';
import { attempt, groupThreads, patchChat, sortChats, type Sort, type Thread } from '@/components/chat-actions';
import { Input } from '@/components/ui';
import { askNewProject, deleteFolder, moveFolder, openProjectSettings, renameFolder, type Folder, type MoveSubject, type ProjectNode } from './api';
import { between, canDrop, childrenOf, folderPath, threadCount, zoneOf, type Dest, type Zone } from './chat-tree';
import { FolderDeleteDialog, NewFolderDialog } from './FolderDialogs';

const item = 'px-2 text-[13px] text-foreground/80 data-active:bg-foreground/[0.07] data-active:text-foreground';
const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;
const IND = 12;
const Dot = ({ color }: { color: string | null }) => <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-foreground/15" style={{ background: color ?? 'transparent' }} />;

// Keyboard drag starts with Space on a row's main control (a link or button marked data-drag-main), so Enter and the ⋯ menu keep their meaning.
class RowKeyboardSensor extends KeyboardSensor {
  static activators = [{ eventName: 'onKeyDown' as const, handler: (e: React.KeyboardEvent, { onActivation }: { onActivation?: (a: { event: KeyboardEvent }) => void }) => {
    if (e.code !== 'Space' || !(e.target as HTMLElement).hasAttribute?.('data-drag-main')) return false;
    e.preventDefault(); onActivation?.({ event: e.nativeEvent }); return true;
  } }];
}

let lastDragEnd = 0; // the click that follows a drop must not navigate or toggle
interface Drop { id: string; zone: Zone; ok: boolean }
interface RowProps { id: string; depth: number; drop: Drop | null; noDrag?: boolean; noDrop?: boolean; children: ReactNode }
function DragRow({ id, depth, drop, noDrag, noDrop, children }: RowProps) {
  const d = useDraggable({ id, disabled: noDrag }), o = useDroppable({ id, disabled: noDrop });
  const z = drop?.id === id && drop.ok ? drop.zone : undefined;
  return (
    <SidebarMenuItem ref={(el) => { d.setNodeRef(el); o.setNodeRef(el); }} onClickCapture={(e) => { if (Date.now() - lastDragEnd < 250) { e.preventDefault(); e.stopPropagation(); } }} {...d.listeners} aria-roledescription={d.attributes['aria-roledescription']} aria-describedby={d.attributes['aria-describedby']}
      style={{ marginLeft: depth * IND, opacity: d.isDragging ? 0.4 : undefined, borderRadius: 6,
        boxShadow: z === 'before' ? 'inset 0 2px 0 var(--seal)' : z === 'after' ? 'inset 0 -2px 0 var(--seal)' : z === 'inside' ? 'inset 0 0 0 1.5px var(--seal)' : undefined,
        background: z === 'inside' ? 'color-mix(in srgb, var(--seal) 12%, transparent)' : undefined }}>
      {children}
    </SidebarMenuItem>
  );
}

interface Props {
  threads: Thread[]; /** undefined = the projects module is off: no project nodes, no "New project". */ projects?: ProjectNode[]; folders: Folder[]; sort: Sort; setSort: (s: Sort) => void; select: boolean; path: string; hash: string; closeSmall: () => void;
  chatRow: (c: Thread) => ReactNode; askMove: (s: MoveSubject) => void; chatsHeader: ReactNode;
}

// The sidebar tree: Projects (when that module is on; each with its folders and chats), then Chats (pinned, folders, loose chats). Drag rows onto
// folders, projects or the "Chats" header; drop on the top or bottom edge of a row to reorder (needs the Custom sort for chats to show it).
export function ChatTree(p: Props) {
  const { threads, folders, sort } = p, projects = p.projects ?? [];
  const [open, setOpen] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('hefyn-tree') ?? '["#projects"]')); } catch { return new Set(['#projects']); } });
  const [drop, setDrop] = useState<Drop | null>(null);
  const [active, setActive] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [newFolder, setNewFolder] = useState<{ parentId: string | null; projectId: string | null }>();
  const [delFolder, setDelFolder] = useState<Folder>();
  const hover = useRef<{ id: string; t: ReturnType<typeof setTimeout> } | undefined>(undefined);
  useEffect(() => localStorage.setItem('hefyn-tree', JSON.stringify([...open])), [open]);
  useEffect(() => { const f = () => setNewFolder({ parentId: null, projectId: null }); addEventListener('hefyn-new-folder', f); return () => removeEventListener('hefyn-new-folder', f); }, []);
  const toggle = (id: string, on?: boolean) => setOpen((s) => { const n = new Set(s); (on ?? !n.has(id)) ? n.add(id) : n.delete(id); return n; });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 6 } }), useSensor(RowKeyboardSensor));

  const kindOf = (id: string) => (id === 'root' ? 'root' : id[0] === 'p' ? 'project' : id[0] === 'f' ? 'folder' : 'chat') as 'root' | 'project' | 'folder' | 'chat';
  const raw = (id: string) => id.slice(2);
  const chatOf = (id: string) => threads.find((t) => t.id === raw(id));
  const folderOf = (id: string) => folders.find((f) => f.id === raw(id));
  /** The place a row stands for when something is dropped "inside" it, or next to it (before/after) = the place it sits in. */
  const destOf = (id: string, zone: Zone): Dest | undefined => {
    const k = kindOf(id);
    if (k === 'root') return { kind: 'root' };
    if (k === 'project') return { kind: 'project', projectId: raw(id) };
    if (k === 'folder') { const f = folderOf(id); if (!f) return; return zone === 'inside' ? { kind: 'folder', folderId: f.id } : f.parentId ? { kind: 'folder', folderId: f.parentId } : f.projectId ? { kind: 'project', projectId: f.projectId } : { kind: 'root' }; }
    const c = chatOf(id); if (!c) return;
    return c.folderId ? { kind: 'folder', folderId: c.folderId } : c.projectId ? { kind: 'project', projectId: c.projectId } : { kind: 'root' };
  };
  const subjectOf = (id: string) => (kindOf(id) === 'folder' ? { folderId: raw(id) } : {});

  const compute = (e: DragMoveEvent | DragEndEvent): Drop | null => {
    const over = e.over, a = e.active.rect.current.translated;
    if (!over || !a || over.id === e.active.id) return null;
    const id = String(over.id), k = kindOf(id), mid = a.top + a.height / 2;
    const zone = zoneOf(k, Math.min(1, Math.max(0, (mid - over.rect.top) / over.rect.height)));
    const dest = destOf(id, zone);
    return { id, zone, ok: !!dest && canDrop(folders, subjectOf(String(e.active.id)), dest) };
  };
  const onMove = (e: DragMoveEvent) => {
    const d = compute(e); setDrop(d);
    if (hover.current && hover.current.id !== d?.id) { clearTimeout(hover.current.t); hover.current = undefined; }
    if (d?.ok && d.zone === 'inside' && d.id !== 'root' && !open.has(raw(d.id)) && !hover.current) hover.current = { id: d.id, t: setTimeout(() => { toggle(raw(d.id), true); hover.current = undefined; }, 600) }; // auto-expand
  };
  const end = () => { lastDragEnd = Date.now(); setDrop(null); setActive(undefined); if (hover.current) { clearTimeout(hover.current.t); hover.current = undefined; } };

  const onEnd = async (e: DragEndEvent) => {
    const d = compute(e), subject = String(e.active.id);
    end();
    if (!d?.ok) return;
    const dest = destOf(d.id, d.zone)!, targetKind = kindOf(d.id);
    if (kindOf(subject) === 'chat') {
      const c = chatOf(subject)!;
      // siblings in the new place, in their current order; the dropped chat goes next to the row it was dropped on
      const sibs = sortChats(threads.filter((t) => !t.pinned && t.id !== c.id && (dest.kind === 'folder' ? t.folderId === dest.folderId : !t.folderId && (t.projectId ?? null) === (dest.kind === 'project' ? dest.projectId : null))), 'custom');
      const at = targetKind === 'chat' ? sibs.findIndex((t) => t.id === raw(d.id)) : -1;
      const order = targetKind === 'chat' ? [...sibs.slice(0, at < 0 ? sibs.length : d.zone === 'before' ? at : at + 1), c, ...sibs.slice(at < 0 ? sibs.length : d.zone === 'before' ? at : at + 1)] : targetKind === 'folder' && d.zone !== 'inside' ? [c, ...sibs] : [...sibs, c];
      const sameLevel = (c.folderId ?? null) === (dest.kind === 'folder' ? dest.folderId : null) && (dest.kind === 'folder' || (c.projectId ?? null) === (dest.kind === 'project' ? dest.projectId : null));
      await attempt(async () => {
        await patchChat(c.id, dest.kind === 'folder' ? { folderId: dest.folderId, position: order.indexOf(c) + 1 } : { folderId: null, projectId: dest.kind === 'project' ? dest.projectId : null, position: order.indexOf(c) + 1 });
        await Promise.all(order.map((t, i) => (t !== c && t.position !== i + 1 ? patchChat(t.id, { position: i + 1 }) : undefined)));
      });
      if (sameLevel && targetKind === 'chat' && sort !== 'custom') p.setSort('custom');
      return;
    }
    const f = folderOf(subject)!;
    const parentId = dest.kind === 'folder' ? dest.folderId : null, projectId = dest.kind === 'project' ? dest.projectId : null;
    const sibs = dest.kind === 'folder' ? childrenOf(folders, dest.folderId, null) : childrenOf(folders, null, projectId);
    const rest = sibs.filter((x) => x.id !== f.id);
    let position: number | undefined;
    if (targetKind === 'folder' && d.zone !== 'inside') { const i = rest.findIndex((x) => x.id === raw(d.id)); position = between(d.zone === 'before' ? rest[i - 1]?.position : rest[i]?.position, d.zone === 'before' ? rest[i]?.position : rest[i + 1]?.position); }
    else if (rest.length) position = rest[rest.length - 1]!.position + 1;
    await attempt(() => moveFolder(f.id, { parentId, projectId, ...(position !== undefined && { position }) }));
  };

  // ---- rows ----
  /** One folder's actions: the items of its ⋯ menu and of its right-click MenuArea (both render this list). */
  const folderActions = (f: Folder) => (<>
    <DropdownMenuItem className="text-[13px]" onClick={() => { toggle(f.id, true); setNewFolder({ parentId: f.id, projectId: f.projectId }); }}><FolderPlus {...ico} />New subfolder</DropdownMenuItem>
    <DropdownMenuItem className="text-[13px]" onClick={() => setRenaming(f.id)}><Pencil {...ico} />Rename</DropdownMenuItem>
    <DropdownMenuItem className="text-[13px]" onClick={() => p.askMove({ folderId: f.id, label: `the folder “${f.name}”` })}><FolderInput {...ico} />Move to…</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" className="text-[13px]" onClick={() => setDelFolder(f)}><Trash2 {...ico} />Delete…</DropdownMenuItem>
  </>);
  const folderMenu = (f: Folder) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label={`Actions for folder ${f.name}`} />}><Ellipsis {...ico} /></DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-48">{folderActions(f)}</DropdownMenuContent>
    </DropdownMenu>
  );
  const folderNode = (f: Folder, depth: number): ReactNode => {
    const isOpen = open.has(f.id), n = threadCount(threads, folders, f.id);
    return (
      <div key={f.id} role="presentation">
        <DragRow id={`f:${f.id}`} depth={depth} drop={drop} noDrag={p.select}>
          {renaming === f.id ? (
            <Input aria-label="Folder name" className="h-8 text-[13px]" defaultValue={f.name} maxLength={60}
              ref={(el) => { if (el) setTimeout(() => { el.focus(); el.select(); }, 150); }}
              onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(undefined); if (e.key === 'Enter') e.currentTarget.blur(); }}
              onBlur={(e) => { const v = e.currentTarget.value.trim(); setRenaming(undefined); if (v && v !== f.name) attempt(() => renameFolder(f.id, v)); }} />
          ) : (
            <MenuArea items={() => folderActions(f)}>
              <SidebarMenuButton className={`${item} pr-7`} data-drag-main aria-expanded={isOpen} onClick={() => toggle(f.id)}>
                <ChevronRight {...ico} size={12} className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                {isOpen ? <FolderOpen {...ico} className="shrink-0 text-muted-foreground" /> : <FolderIcon {...ico} className="shrink-0 text-muted-foreground" />}
                <span className="min-w-0 grow truncate">{f.name}</span>{n > 0 && <span className="tnum text-xs text-muted-foreground group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0">{n}</span>}
              </SidebarMenuButton>
              {folderMenu(f)}
            </MenuArea>)}
        </DragRow>
        {isOpen && level(f.id, f.projectId, depth + 1)}
      </div>
    );
  };
  const chatNode = (c: Thread, depth: number) => <DragRow key={c.id} id={`c:${c.id}`} depth={depth} drop={drop} noDrag={p.select} noDrop={c.pinned}>{p.chatRow(c)}</DragRow>;

  /** Folders, then chats, of one place: (parent folder) or (a project's / the root's top level). */
  function level(parentId: string | null, projectId: string | null, depth: number, grouped = false): ReactNode {
    const fs = childrenOf(folders, parentId, projectId, sort === 'name');
    const cs = threads.filter((t) => !t.pinned && (parentId ? t.folderId === parentId : !t.folderId && (t.projectId ?? null) === projectId));
    if (!fs.length && !cs.length) return parentId ? <li className="px-2 py-1 text-xs text-muted-foreground" style={{ marginLeft: depth * IND }}>Empty. Drop chats here.</li> : null;
    return (<>
      {fs.map((f) => folderNode(f, depth))}
      {grouped ? groupThreads(cs, sort).map(([label, list]) => (
        <SidebarGroup key={label} className="p-0">{label !== 'Chats' && <SidebarGroupLabel className="h-auto px-2 pt-3 pb-1">{label}</SidebarGroupLabel>}
          <SidebarGroupContent><SidebarMenu>{list.map((c) => chatNode(c, depth))}</SidebarMenu></SidebarGroupContent></SidebarGroup>))
        : sortChats(cs, sort).map((c) => chatNode(c, depth))}
    </>);
  }

  const root = useDroppable({ id: 'root' });
  const pinned = sortChats(threads.filter((t) => t.pinned), sort);
  const projectsOpen = open.has('#projects');
  const dragged = active ? (kindOf(active) === 'folder' ? folderOf(active)?.name : chatOf(active)?.title) : undefined;
  const rootDrop = drop?.id === 'root' && drop.ok;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e: DragStartEvent) => setActive(String(e.active.id))} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={end}
      accessibility={{ announcements: { onDragStart: ({ active: a }) => `Picked up ${a.id.toString().startsWith('f:') ? 'folder' : 'chat'}.`, onDragOver: () => undefined, onDragEnd: () => 'Dropped.', onDragCancel: () => 'Move cancelled.' } }}>
      {p.projects && <SidebarGroup className="p-0">
        <div className="flex items-center pt-2">
          <button type="button" aria-expanded={projectsOpen} onClick={() => toggle('#projects')} className="flex h-6 grow items-center gap-1 rounded px-2 text-xs font-medium text-sidebar-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight {...ico} size={12} className={`transition-transform ${projectsOpen ? 'rotate-90' : ''}`} />Projects</button>
          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="New project" title="New project" onClick={() => askNewProject()}><Plus {...ico} /></Button>
        </div>
        {projectsOpen && <SidebarMenu>
          {projects.map((pr) => {
            const on = p.path === '/projects' && p.hash === pr.id, isOpen = open.has(pr.id), n = threads.filter((t) => t.projectId === pr.id).length;
            return (
              <div key={pr.id} role="presentation">
                <DragRow id={`p:${pr.id}`} depth={0} drop={drop} noDrag>
                  <div className="flex items-center">
                    <button type="button" aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${pr.title}`} aria-expanded={isOpen} onClick={() => toggle(pr.id)} className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight {...ico} size={12} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} /></button>
                    <SidebarMenuButton className={`${item} pr-14`} isActive={on} aria-current={on ? 'page' : undefined} render={<a href={`/projects#${pr.id}`} />} onClick={p.closeSmall}>
                      <Dot color={pr.color} /><span className="min-w-0 grow truncate">{pr.title}</span>
                      {pr.scope === 'team' && <Users {...ico} size={12} role="img" aria-label="Shared with the team" className="shrink-0 text-muted-foreground" />}
                      {n > 0 && <span className="tnum text-xs text-muted-foreground group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0">{n}</span>}</SidebarMenuButton>
                  </div>
                  <SidebarMenuAction showOnHover className="right-7" aria-label={`New folder in ${pr.title}`} title="New folder" onClick={() => { toggle(pr.id, true); setNewFolder({ parentId: null, projectId: pr.id }); }}><FolderPlus {...ico} /></SidebarMenuAction>
                  <SidebarMenuAction showOnHover aria-label={`Settings of ${pr.title}`} title="Project settings" onClick={() => openProjectSettings(pr.id)}><Settings2 {...ico} /></SidebarMenuAction>
                </DragRow>
                {isOpen && level(null, pr.id, 1)}
              </div>
            );
          })}
          {!projects.length && <li className="px-2 py-1 text-[13px] text-muted-foreground">Group chats by project.</li>}
        </SidebarMenu>}
      </SidebarGroup>}
      <div ref={root.setNodeRef} className={`group/chats flex h-8 items-center rounded-md ${p.projects ? 'mt-2 border-t border-border pt-1' : 'pt-2'}`} style={rootDrop ? { boxShadow: 'inset 0 0 0 1.5px var(--seal)' } : undefined}>
        <span className="grow px-2 text-xs font-medium text-sidebar-foreground/70">Chats</span>
        {p.chatsHeader}
      </div>
      {pinned.length > 0 && <SidebarGroup className="p-0"><SidebarGroupLabel className="h-auto px-2 pt-3 pb-1">Pinned</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{pinned.map((c) => chatNode(c, 0))}</SidebarMenu></SidebarGroupContent></SidebarGroup>}
      <SidebarMenu className="gap-0.5">{level(null, null, 0, true)}</SidebarMenu>
      {!threads.length && !folders.length && <p className="px-2 pt-3 text-[13px] text-muted-foreground">Your threads will appear here.</p>}
      <DragOverlay dropAnimation={null}>{dragged ? <div className="w-56 truncate rounded-md bg-popover px-2 py-1.5 text-[13px] shadow-float ring-1 ring-border">{dragged}</div> : null}</DragOverlay>
      {newFolder && <NewFolderDialog parentId={newFolder.parentId} projectId={newFolder.projectId} where={folderPath(folders, projects, newFolder.parentId, newFolder.projectId)} onClose={() => setNewFolder(undefined)} />}
      {delFolder && <FolderDeleteDialog name={delFolder.name} chats={threadCount(threads, folders, delFolder.id)} onClose={() => setDelFolder(undefined)}
        onLift={() => attempt(() => deleteFolder(delFolder.id, 'lift'), 'Folder deleted')} onDelete={() => attempt(() => deleteFolder(delFolder.id, 'delete'), 'Folder and chats deleted')} />}
    </DndContext>
  );
}
