import { useMemo, type ComponentType, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useModules } from '@/components/api';
import type { Sort, Thread } from '@/components/chat-actions';
import { foldersWeb } from './folders';

// The console's side of the module system (docs/HARNESS.md "Extension points (console)"). The core components (Shell, ChatList, Chat, Palette)
// render these slots and never import a module; a module appears only when the server lists it in GET /api/modules (it is switched on).
export interface PaletteItem { id: string; label: string; group: string; Icon: LucideIcon; keys?: string; extra?: string; run: () => void }
export interface SidebarSectionProps {
  threads: Thread[]; sort: Sort; setSort: (s: Sort) => void; select: boolean; path: string; hash: string; closeSmall: () => void;
  /** The core's row for one chat (title, badges, actions menu). */
  chatRow: (c: Thread) => ReactNode;
  /** The core's "Chat options" menu (sort, select, archive). */
  chatsHeader: ReactNode;
}

/** A slash command that needs a yes first; `run` does the work after it. */
export interface SlashConfirm { title: string; body: string; action: string; run: () => Promise<boolean> }
export interface SlashCommand { name: string; arg?: string; help: string; Icon?: LucideIcon; run: (arg: string, chatId: string) => Promise<boolean | SlashConfirm> }

export interface WebModule {
  /** The server module id (GET /api/modules). */
  id: string;
  /** Renders the whole chat area of the sidebar (the core's flat list is the fallback when no module provides one). */
  sidebarSections?: ComponentType<SidebarSectionProps>[];
  /** Small marks after a chat's title (`variant`: the sidebar row, or the chat's header bar). */
  chatBadges?: ComponentType<{ chat: Thread; inArchive?: boolean; variant: 'row' | 'header' }>[];
  /** Entries in the sidebar's "Chat options" menu (folders: New folder). */
  chatsMenuItems?: ComponentType[];
  /** Entries in a chat row's ⋯ menu (and its right-click menu); `done` clears the selection. */
  chatMenuItems?: ComponentType<{ chat: Thread; done: () => void }>[];
  /** Buttons in the toolbar over selected chats. */
  selectionActions?: ComponentType<{ ids: string[]; done: () => void }>[];
  /** Mounted once in the Shell: loads the module's data and owns its dialogs. */
  hosts?: ComponentType[];
  /** "/" commands of the composer; they work on an existing chat. */
  slashCommands?: SlashCommand[];
  /** Entries for the ⌘K palette (read the module's own store; no hooks). */
  paletteCommands?: () => PaletteItem[];
  /** Where a chat sits ("Kunden / Angebote"), for tooltips and the palette. */
  chatLocation?: (c: Thread) => string;
}

const all: WebModule[] = [foldersWeb]; // projects and schedules moved to old/

/** The console parts of the modules that are switched on. */
export function useWebModules(): WebModule[] {
  const { modules } = useModules();
  return useMemo(() => all.filter((m) => modules.some((x) => x.id === m.id)), [modules]);
}