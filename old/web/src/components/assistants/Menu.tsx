import { AlignStartHorizontal, AlignStartVertical, Bot, Braces, ClipboardPaste, Code, Copy, CopyPlus, FileText, FlaskConical, GitFork, MessageSquare, Pencil, Reply, Save, Scissors, ShieldCheck, Sparkles, Split, SquareDashedMousePointer, Trash2, Unlink, Wand2, Wrench, CircleHelp, Maximize, ZoomIn, ZoomOut, Users, SettingsIcon, Plus, AlignHorizontalSpaceAround, AlignVerticalSpaceAround, type LucideIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/ui/dropdown-menu';
import { shortcut } from '../ui';
import { GROUPS, META, metaOf, portsOf, type Flow } from './flow';
import type { Options } from './parts';

export const ICON: Record<string, LucideIcon> = {
  'trigger.chat': MessageSquare, agent: Bot, assistant: Sparkles, router: GitFork, condition: Split, approval: ShieldCheck, ask: CircleHelp,
  template: FileText, code: Code, tool: Wrench, 'output.file': Save, 'output.reply': Reply,
};
export const iconOf = (t: string) => ICON[t] ?? Braces;

/** Where the menu was opened: `at` is the flow position of a click on the canvas or on a connection. */
export type MenuTarget =
  | { kind: 'pane'; x: number; y: number; at: { x: number; y: number } }
  | { kind: 'node'; x: number; y: number; id: string }
  | { kind: 'edge'; x: number; y: number; id: string; at: { x: number; y: number } }
  | { kind: 'selection'; x: number; y: number };

export interface MenuActions {
  add: (type: string, at: { x: number; y: number }) => void;
  addAfter: (id: string, type: string, port?: string) => void;
  insertOnEdge: (id: string, type: string, at: { x: number; y: number }) => void;
  paste: (at?: { x: number; y: number }) => void;
  selectAll: () => void; tidy: () => void; fit: () => void; zoom: (dir: 1 | -1) => void;
  open: (id: string) => void; rename: (id: string) => void; test: (id: string) => void; helpers: (id: string) => void;
  duplicate: () => void; copy: () => void; cut: () => void; remove: () => void; disconnect: (id: string) => void; removeEdge: (id: string) => void;
  align: (edge: 'left' | 'top') => void; distribute: (axis: 'x' | 'y') => void;
}

const Key = ({ k }: { k: string }) => <DropdownMenuShortcut>{k}</DropdownMenuShortcut>;
const Row = ({ icon: I, children }: { icon: LucideIcon; children: React.ReactNode }) => <><I aria-hidden />{children}</>;

/** The palette's groups as menu entries. `skip` leaves types out (a Reply cannot sit in the middle of a connection). */
function Steps({ options, hasTrigger, skip = [], pick }: { options: Options; hasTrigger: boolean; skip?: string[]; pick: (t: string) => void }) {
  return <>
    {GROUPS.map((g) => {
      const types = Object.keys(META).filter((t) => metaOf(t).group === g && !skip.includes(t) && !(t === 'trigger.chat' && hasTrigger) && (!options.nodeTypes?.length || options.nodeTypes.some((n) => n.type === t)));
      return types.length > 0 && (
        <DropdownMenuGroup key={g}>
          <DropdownMenuLabel>{g}</DropdownMenuLabel>
          {types.map((t) => <DropdownMenuItem key={t} onClick={() => pick(t)}><Row icon={iconOf(t)}>{metaOf(t).label}</Row></DropdownMenuItem>)}
        </DropdownMenuGroup>
      );
    })}
  </>;
}

interface Props { target: MenuTarget; flow: Flow; selected: string[]; options: Options; readOnly: boolean; canPaste: boolean; testable: (id: string) => boolean; onClose: () => void; a: MenuActions }

/** The right-click menus (canvas, step, connection, several steps). One controlled menu anchored at the pointer; Base UI gives the arrow keys, Esc and focus. */
export function CanvasMenu({ target, flow, selected, options, readOnly, canPaste, testable, onClose, a }: Props) {
  const hasTrigger = flow.nodes.some((n) => n.type === 'trigger.chat');
  const anchor = { getBoundingClientRect: () => new DOMRect(target.x, target.y, 0, 0) };
  const ro = readOnly;
  const only = selected.length > 0 && selected.every((id) => flow.nodes.find((n) => n.id === id)?.type === 'trigger.chat'); // a trigger is neither copied twice nor cut
  const node = target.kind === 'node' ? flow.nodes.find((n) => n.id === target.id) : undefined;

  let body: React.ReactNode = null;
  if (target.kind === 'pane') {
    body = <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={ro}><Plus aria-hidden />Add step here</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-(--available-height) w-52"><Steps options={options} hasTrigger={hasTrigger} pick={(t) => a.add(t, target.at)} /></DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem disabled={ro || !canPaste} onClick={() => a.paste(target.at)}><Row icon={ClipboardPaste}>Paste</Row><Key k={shortcut('V')} /></DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!flow.nodes.length} onClick={a.selectAll}><Row icon={SquareDashedMousePointer}>Select all</Row><Key k={shortcut('A')} /></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || !flow.nodes.length} onClick={a.tidy}><Row icon={Wand2}>Tidy up</Row></DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={a.fit}><Row icon={Maximize}>Fit view</Row></DropdownMenuItem>
      <DropdownMenuItem onClick={() => a.zoom(1)}><Row icon={ZoomIn}>Zoom in</Row></DropdownMenuItem>
      <DropdownMenuItem onClick={() => a.zoom(-1)}><Row icon={ZoomOut}>Zoom out</Row></DropdownMenuItem>
    </>;
  } else if (target.kind === 'node' && node) {
    const first = portsOf(node);
    body = <>
      <DropdownMenuItem onClick={() => a.open(node.id)}><Row icon={SettingsIcon}>Open settings</Row></DropdownMenuItem>
      <DropdownMenuItem disabled={ro} onClick={() => a.rename(node.id)}><Row icon={Pencil}>Rename</Row><Key k="F2" /></DropdownMenuItem>
      {testable(node.id) && <DropdownMenuItem onClick={() => a.test(node.id)}><Row icon={FlaskConical}>Test this step</Row></DropdownMenuItem>}
      {node.type === 'agent' && node.config.agent == null && <DropdownMenuItem onClick={() => a.helpers(node.id)}><Row icon={Users}>Open sub-agents</Row></DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={ro || node.type === 'trigger.chat'} onClick={a.duplicate}><Row icon={CopyPlus}>Duplicate</Row><Key k={shortcut('D')} /></DropdownMenuItem>
      <DropdownMenuItem onClick={a.copy}><Row icon={Copy}>Copy</Row><Key k={shortcut('C')} /></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || node.type === 'trigger.chat'} onClick={a.cut}><Row icon={Scissors}>Cut</Row><Key k={shortcut('X')} /></DropdownMenuItem>
      <DropdownMenuSeparator />
      {first.length > 0 && <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={ro}><Plus aria-hidden />Add step after</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-(--available-height) w-52"><Steps options={options} hasTrigger={hasTrigger} pick={(t) => a.addAfter(node.id, t)} /></DropdownMenuSubContent>
      </DropdownMenuSub>}
      <DropdownMenuItem disabled={ro || !flow.edges.some((e) => e.from === node.id || e.to === node.id)} onClick={() => a.disconnect(node.id)}><Row icon={Unlink}>Disconnect all</Row></DropdownMenuItem>
      <DropdownMenuItem disabled={ro} variant="destructive" onClick={a.remove}><Row icon={Trash2}>Delete</Row><Key k="⌫" /></DropdownMenuItem>
    </>;
  } else if (target.kind === 'edge') {
    body = <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={ro}><Plus aria-hidden />Insert step here</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-(--available-height) w-52"><Steps options={options} hasTrigger skip={['output.reply']} pick={(t) => a.insertOnEdge(target.id, t, target.at)} /></DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem disabled={ro} variant="destructive" onClick={() => a.removeEdge(target.id)}><Row icon={Trash2}>Delete connection</Row></DropdownMenuItem>
    </>;
  } else if (target.kind === 'selection') {
    body = <>
      <DropdownMenuLabel>{selected.length} steps selected</DropdownMenuLabel>
      <DropdownMenuItem disabled={ro || only} onClick={a.duplicate}><Row icon={CopyPlus}>Duplicate</Row><Key k={shortcut('D')} /></DropdownMenuItem>
      <DropdownMenuItem onClick={a.copy}><Row icon={Copy}>Copy</Row><Key k={shortcut('C')} /></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || only} onClick={a.cut}><Row icon={Scissors}>Cut</Row><Key k={shortcut('X')} /></DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={ro || selected.length < 2} onClick={() => a.align('left')}><Row icon={AlignStartVertical}>Align left</Row></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || selected.length < 2} onClick={() => a.align('top')}><Row icon={AlignStartHorizontal}>Align top</Row></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || selected.length < 3} onClick={() => a.distribute('x')}><Row icon={AlignHorizontalSpaceAround}>Distribute horizontally</Row></DropdownMenuItem>
      <DropdownMenuItem disabled={ro || selected.length < 3} onClick={() => a.distribute('y')}><Row icon={AlignVerticalSpaceAround}>Distribute vertically</Row></DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={ro} variant="destructive" onClick={a.remove}><Row icon={Trash2}>Delete</Row><Key k="⌫" /></DropdownMenuItem>
    </>;
  }
  if (!body) return null;
  return (
    <DropdownMenu open onOpenChange={(o) => { if (!o) onClose(); }} modal={false}>
      <DropdownMenuContent anchor={anchor} side="right" align="start" sideOffset={2} className="w-60" aria-label="Flow actions">{body}</DropdownMenuContent>
    </DropdownMenu>
  );
}
