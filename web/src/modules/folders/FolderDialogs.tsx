import { CornerDownRight, Folder as FolderIcon, MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/ui/alert-dialog';
import { Command, CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { attempt } from '@/components/chat-actions';
import { Dialog } from '@/components/dialogs';
import { Field, Input, buttonDangerSolid } from '@/components/ui';
import { createFolder, type Folder, type MoveSubject, type ProjectNode } from './api';
import { canDrop, childrenOf, type Dest } from './chat-tree';

/** "New folder": name only; `parent` / `projectId` say where it goes (shown, not editable: drag it afterwards or use Move to…). */
export function NewFolderDialog({ where, parentId, projectId, onClose }: { where: string; parentId: string | null; projectId: string | null; onClose: () => void }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); const ok = await attempt(() => createFolder(name.trim(), parentId, projectId)); setBusy(false); if (ok) onClose(); };
  return (
    <Dialog title="New folder" onClose={onClose} footer={<Button disabled={!name.trim() || busy} onClick={submit}>Create folder</Button>}>
      <form onSubmit={(e) => { e.preventDefault(); name.trim() && !busy && submit(); }} className="grid gap-3">
        <Field label="Name"><Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Angebote" /></Field>
        <p className="text-xs text-muted-foreground">In: {where || 'Chats'}</p>
      </form>
    </Dialog>
  );
}

export type { MoveSubject };
/** "Move to…": a searchable list of every place a chat or folder can go (keyboard: type, arrows, Enter). */
export function MoveToDialog({ subject, folders, projects, onPick, onClose }: { subject: MoveSubject; folders: Folder[]; projects: ProjectNode[]; onPick: (d: Dest) => void; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const rows = useMemo(() => {
    const out: { key: string; label: string; depth: number; dest: Dest; icon: 'chat' | 'folder'; disabled?: boolean }[] = [{ key: 'root', label: 'Chats (top level)', depth: 0, dest: { kind: 'root' }, icon: 'chat' }];
    const walk = (parent: string | null, project: string | null, depth: number, trail: string) => {
      for (const f of childrenOf(folders, parent, project)) {
        const dest: Dest = { kind: 'folder', folderId: f.id }, path = `${trail} ${f.name}`.trim();
        if (canDrop(folders, subject, dest)) out.push({ key: `f:${f.id}`, label: path, depth, dest, icon: 'folder' });
        walk(f.id, project, depth + 1, `${path} /`);
      }
    };
    walk(null, null, 1, '');
    for (const p of projects) { out.push({ key: `p:${p.id}`, label: p.title, depth: 0, dest: { kind: 'project', projectId: p.id }, icon: 'folder' }); walk(null, p.id, 1, `${p.title} /`); }
    return out;
  }, [folders, projects, subject]);
  const close = () => { setOpen(false); onClose(); };
  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && close()} title="Move to…" description={`Choose where to put ${subject.label}`} className="top-[12vh] translate-y-0 sm:max-w-md">
      <Command label="Move to" className="rounded-none! p-0">
        <CommandInput aria-label="Search folders and projects" placeholder={`Move ${subject.label} to…`} />
        <CommandList className="max-h-72 p-1.5">
          <CommandEmpty className="px-3 text-muted-foreground">No folder matches.</CommandEmpty>
          {rows.map((r) => (
            <CommandItem key={r.key} value={r.label} onSelect={() => { close(); onPick(r.dest); }} className="text-[13px]" style={{ paddingLeft: 8 + r.depth * 14 }}>
              {r.depth > 0 ? <CornerDownRight size={14} aria-hidden className="shrink-0 text-muted-foreground" /> : r.icon === 'chat' ? <MessageSquare size={14} aria-hidden className="shrink-0 text-muted-foreground" /> : <FolderIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />}
              <span className="min-w-0 grow truncate">{r.depth > 0 ? r.label.split(' / ').pop() : r.label}</span>
              {r.depth > 0 && <span className="shrink-0 text-xs text-muted-foreground">{r.label.split(' / ').slice(0, -1).join(' / ')}</span>}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** Deleting a folder: keep what is inside (it moves up a level) or delete it with the chats. */
export function FolderDeleteDialog({ name, chats, onLift, onDelete, onClose }: { name: string; chats: number; onLift: () => void; onDelete: () => void; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const close = () => { setOpen(false); onClose(); };
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && close()}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the folder “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>{chats
            ? <>It holds {chats} {chats === 1 ? 'chat' : 'chats'} (plus any archived ones). Keep them — they and the subfolders move up one level — or delete them with the folder. Deleting chats can not be undone.</>
            : 'The folder has no chats. Its subfolders, if any, move up one level.'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-wrap">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { onLift(); close(); }}>{chats ? 'Delete folder, keep chats' : 'Delete folder'}</AlertDialogAction>
          {chats > 0 && <AlertDialogAction className={buttonDangerSolid} onClick={() => { onDelete(); close(); }}>Delete folder and chats</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
