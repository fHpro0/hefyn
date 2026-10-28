import { FolderInput, FolderPlus } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { attempt } from '@/components/chat-actions';
import type { WebModule } from '../registry';
import { askMove, askNewFolder, loadFolders, locationOf, moveSubject, useFolderData, type MoveSubject } from './api';

// The folders module's console parts (server: src/modules/folders): the folder tree that replaces the flat chat list, "Move to…" in chat menus,
// "New folder" in the chat options and the palette, and the host that owns the folder data and the move dialog. The tree also shows the
// projects module's nodes when that module is on (it fills the store: api.ts `setProjectNodes`).
const ChatTree = lazy(() => import('./ChatTree').then((m) => ({ default: m.ChatTree })));
const MoveToDialog = lazy(() => import('./FolderDialogs').then((m) => ({ default: m.MoveToDialog })));

const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;

const Section: NonNullable<WebModule['sidebarSections']>[number] = (p) => {
  const { projects, folders } = useFolderData();
  return <ChatTree {...p} projects={projects} folders={folders} askMove={askMove} />;
};

const ChatMenu: NonNullable<WebModule['chatMenuItems']>[number] = ({ chat, done }) => (
  <DropdownMenuItem className="text-[13px]" onClick={() => askMove({ chats: [chat.id], label: 'this chat', done })}><FolderInput {...ico} />Move to…</DropdownMenuItem>
);

const NewFolderItem = () => <DropdownMenuItem className="text-[13px]" onClick={askNewFolder}><FolderPlus {...ico} />New folder</DropdownMenuItem>;

const SelectionMove: NonNullable<WebModule['selectionActions']>[number] = ({ ids, done }) => (
  <Button variant="ghost" size="icon" aria-label="Move selected to…" title="Move to…" disabled={!ids.length} onClick={() => askMove({ chats: ids, label: `${ids.length} chats`, done })}><FolderInput {...ico} /></Button>
);

/** Loads the folders (and reloads with the sidebar) and owns the move dialog. */
function Host() {
  const [moving, setMoving] = useState<MoveSubject>();
  const { projects, folders } = useFolderData();
  useEffect(() => { loadFolders(); addEventListener('hefyn-threads', loadFolders); return () => removeEventListener('hefyn-threads', loadFolders); }, []);
  useEffect(() => {
    const mv = (e: Event) => setMoving((e as CustomEvent).detail);
    addEventListener('hefyn-move-to', mv);
    return () => removeEventListener('hefyn-move-to', mv);
  }, []);
  return (
    <Suspense fallback={null}>
      {moving && <MoveToDialog subject={moving} folders={folders} projects={projects ?? []} onClose={() => setMoving(undefined)} onPick={(d) => attempt(() => moveSubject(moving, d), 'Moved').then((ok) => ok && moving.chats && moving.done?.())} />}
    </Suspense>
  );
}

export const foldersWeb: WebModule = {
  id: 'folders',
  sidebarSections: [Section],
  chatsMenuItems: [NewFolderItem],
  chatMenuItems: [ChatMenu],
  selectionActions: [SelectionMove],
  hosts: [Host],
  chatLocation: locationOf,
  paletteCommands: () => [{ id: 'new-folder', label: 'New folder', group: 'Actions', Icon: FolderPlus, run: askNewFolder }],
};
