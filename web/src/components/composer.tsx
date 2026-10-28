import { Archive, Check, FileText, MessagesSquare, Paperclip, Pencil, Pin, RotateCw, SquarePen, Sparkles, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { upload } from './api';
import { Command, CommandGroup, CommandItem, CommandList } from '@/ui/command';
import { trpc } from '@/lib/trpc';
import { attempt, bulk, patchChat } from './chat-actions';
import { chatLine, filesLine, HEFYN_COMMANDS, insertMention, liveMentions, matches, mentionAt, NEEDS_CHAT, parseCommand, pastedName, slashAt, splitContext, tokenOf, UPLOAD_DIR, uploading, withContext, type Mention, type Up } from './composer-text';
import { toast } from './toast';

// "/" and "@" in the composers (CliChat, the new-chat screen). Pure parts: composer-text.ts; the server side of a chat link: routers/mentions.ts.
// "/" at the start lists the agent's own commands (sent as text) and hefyn's (run here). "@" links files and chats: the token stays in the text,
// and on send the agent gets a "--- context ---" block with the paths; the transcript hides it again and shows chips.
export type { Mention };
const ICON: Record<string, LucideIcon> = { new: SquarePen, rename: Pencil, pin: Pin, archive: Archive };
const HEADING = { agent: '', hefyn: 'hefyn', file: 'Files', chat: 'Chats' };
type Row = { key: string; g: keyof typeof HEADING; label: string; hint?: string; Icon: LucideIcon; cmd?: string; mention?: Mention };

/** The message the agent receives: the typed text plus the context block. A chosen chat is written into this conversation's /tmp first. */
export async function messageWithContext(id: string, text: string, mentions: Mention[]) {
  const live = liveMentions(text, mentions), lines: string[] = [], files = live.filter((m) => m.t === 'file').map((m) => m.i);
  if (files.length) lines.push(filesLine(files));
  for (const m of live.filter((x) => x.t === 'chat')) { const r = await trpc.mentions.linkChat.mutate({ id, chat: m.i }); lines.push(chatLine(r.title, r.path)); }
  return withContext(text, lines);
}

/** A sent user message: its text without the context block, then the chips that block stands for. */
export function UserText({ text }: { text: string }) {
  const s = splitContext(text);
  return (
    <>{s.text}
      {s.chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Mentions">
          {s.chips.map((c, i) => { const Icon = c.t === 'file' ? FileText : MessagesSquare; return (
            <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-0.5 text-xs whitespace-normal"><Icon size={12} aria-hidden className="text-muted-foreground" /><span className="max-w-48 truncate">{c.n}</span></li>); })}
        </ul>)}
    </>
  );
}

/** `bind` goes on the textarea, `popover` renders in its (relative) box. `exec(message)`: the whole message is a hefyn command (true = handled, nothing is sent). */
export function useComposer(o: { id?: string; commands?: { name: string; description?: string }[]; agent?: string; text: string; setText: (t: string) => void; area: React.RefObject<HTMLTextAreaElement | null> }) {
  const { id, text, setText, area } = o;
  const [caret, setCaret] = useState(0), [closed, setClosed] = useState(''), [active, setActive] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]), [chats, setChats] = useState<{ id: string; name: string }[]>([]);
  const loaded = useRef(false);
  const [ups, setUps] = useState<Up[]>([]), [over, setOver] = useState(false);
  const latest = useRef(text); latest.current = text;
  const depth = useRef(0), picker = useRef<HTMLInputElement>(null);
  const patch = (uid: number, p: Partial<Up>) => setUps((l) => l.map((u) => (u.id === uid ? { ...u, ...p } : u)));
  async function push(u: Up) { // one file into /files/Uploads (the server keeps names unique); done = a file mention whose token goes into the text
    patch(u.id, { frac: 0, error: undefined });
    try {
      const r = await upload<{ saved: { name: string; path: string }[] }>(`/api/files/upload?dir=${UPLOAD_DIR}`, [u.file], (frac) => patch(u.id, { frac }));
      const s = r.saved[0]!, m: Mention = { t: 'file', i: `/files${s.path}`, n: s.name }, t = latest.current;
      patch(u.id, { frac: 1, mention: m }); setMentions((x) => [...x, m]);
      setText(`${t}${t && !/\s$/.test(t) ? ' ' : ''}${tokenOf(m)} `);
    } catch (x) { patch(u.id, { error: (x as Error).message }); }
  }
  function attach(list: File[]) {
    for (const f of list) { const u: Up = { id: Date.now() + Math.random(), file: new File([f], pastedName(f.name, f.type), { type: f.type }), frac: 0 }; setUps((l) => [...l, u]); void push(u); }
  }
  function unattach(u: Up) {
    setUps((l) => l.filter((x) => x.id !== u.id));
    if (u.mention) { setMentions((x) => x.filter((m) => m !== u.mention)); setText(latest.current.replace(`${tokenOf(u.mention)} `, '').replace(tokenOf(u.mention), '')); }
  }
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const drop = {
    onDragEnter: (e: React.DragEvent) => { if (hasFiles(e)) { depth.current++; setOver(true); } },
    onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
    onDragLeave: (e: React.DragEvent) => { if (hasFiles(e) && --depth.current <= 0) { depth.current = 0; setOver(false); } },
    onDrop: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setOver(false); attach([...e.dataTransfer.files]); },
  };
  const overlay = over ? <div aria-hidden className="pointer-events-none absolute inset-0 z-40 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground/30 bg-background/75 text-sm font-medium text-muted-foreground">Drop to add to this chat</div> : null;
  const attachButton = (
    <>
      <input ref={picker} type="file" multiple hidden tabIndex={-1} onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-full text-muted-foreground" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}><Paperclip size={16} aria-hidden /></Button>
    </>
  );
  const attachments = ups.length > 0 ? (
    <ul className="flex flex-wrap gap-1.5 px-1 pt-1" aria-label="Attachments">
      {ups.map((u) => (
        <li key={u.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised py-0.5 pr-1 pl-2 text-xs">
          {u.error ? <X size={12} aria-hidden className="text-danger-ink" /> : u.mention ? <Check size={12} aria-hidden className="text-success" /> : <FileText size={12} aria-hidden className="text-muted-foreground" />}
          <span className="max-w-48 truncate" title={u.error}>{u.file.name}</span>
          {u.error ? <span className="text-danger-ink">{u.error.length > 40 ? 'Failed' : u.error}</span> : !u.mention && <span role="progressbar" aria-valuenow={Math.round(u.frac * 100)} className="tnum text-muted-foreground">{Math.round(u.frac * 100)}%</span>}
          {u.error && <Button type="button" variant="ghost" size="icon-xs" className="size-5" aria-label={`Retry ${u.file.name}`} onClick={() => void push(u)}><RotateCw size={12} /></Button>}
          <Button type="button" variant="ghost" size="icon-xs" className="size-5" aria-label={`Remove ${u.file.name}`} onClick={() => unattach(u)}><X size={12} /></Button>
        </li>))}
    </ul>) : null;

  const sl = slashAt(text, caret), mn = sl ? undefined : mentionAt(text, caret);
  const trig = sl ? '/' : mn ? `@${mn.start}` : '';
  const open = !!trig && closed !== trig;
  useEffect(() => { if (!trig) setClosed(''); }, [trig]);
  const q = (sl ?? mn)?.q ?? '';
  useEffect(() => {
    if (!open || !mn) return;
    if (!loaded.current) { loaded.current = true; (trpc.conversations.list.query() as Promise<{ id: string; title: string }[]>).then((l) => setChats(l.map((c) => ({ id: c.id, name: c.title })))).catch(() => { loaded.current = false; }); }
    let dead = false;
    const t = setTimeout(() => trpc.mentions.search.query({ q }).then((r) => { if (!dead) setFiles(r.files); }).catch(() => {}), 150);
    return () => { dead = true; clearTimeout(t); };
  }, [open, !!mn, q]);

  const rows = useMemo((): Row[] => !open ? [] : sl ? [
    ...matches((o.commands ?? []).map((c) => ({ name: c.name, help: c.description ?? '' })), q).map((c): Row => ({ key: `a:${c.name}`, g: 'agent', label: `/${c.name}`, hint: c.help, Icon: Sparkles, cmd: c.name })),
    ...matches(HEFYN_COMMANDS.filter((c) => id || !NEEDS_CHAT.includes(c.name)), q).map((c): Row => ({ key: `h:${c.name}`, g: 'hefyn', label: `/${c.name}${c.arg ? ` <${c.arg}>` : ''}`, hint: c.help, Icon: ICON[c.name]!, cmd: c.name })),
  ] : [
    ...files.slice(0, 6).map((f): Row => ({ key: `f:${f.path}`, g: 'file', label: f.name, hint: f.path.replace(/^\/files\//, '').slice(0, -f.name.length) || undefined, Icon: FileText, mention: { t: 'file', i: f.path, n: f.name } })),
    ...matches(chats.filter((c) => c.id !== id), q).slice(0, 6).map((c): Row => ({ key: `c:${c.id}`, g: 'chat', label: c.name, Icon: MessagesSquare, mention: { t: 'chat', i: c.id, n: c.name } })),
  ], [open, !!sl, q, files, chats, id, o.commands]);
  const cur = rows.find((r) => r.key === active) ?? rows[0];
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cur?.key]);

  const focusAt = (pos: number) => { setCaret(pos); setTimeout(() => { area.current?.focus(); area.current?.setSelectionRange(pos, pos); }, 0); };
  /** Runs one of hefyn's commands; true = done. */
  async function run(name: string, arg: string): Promise<boolean> {
    try {
      if (name === 'new') { if (id) location.hash = ''; return true; }
      if (!id) { toast('Send a message first: this command works on an existing chat.', true); return false; }
      if (name === 'rename') return await attempt(() => patchChat(id, { title: arg }), `Renamed to “${arg}”`);
      if (name === 'pin') {
        const pinned = !!((await trpc.conversations.list.query()) as { id: string; pinned?: boolean }[]).find((c) => c.id === id)?.pinned;
        return await attempt(() => patchChat(id, { pinned: !pinned }), pinned ? 'Unpinned' : 'Pinned');
      }
      const ok = await attempt(() => bulk([id], 'archive'), 'Archived'); // archive
      if (ok) setTimeout(() => { location.hash = ''; }, 600);
      return ok;
    } catch (x) { toast((x as Error).message, true); return false; }
  }
  async function exec(message: string): Promise<boolean> {
    const c = parseCommand(message), cmd = c && !o.commands?.some((x) => x.name === c.name) ? HEFYN_COMMANDS.find((x) => x.name === c.name) : undefined;
    if (!c || !cmd) return false; // anything else, an unknown /word too, goes to the agent as text
    if (cmd.arg && !c.arg) { toast(`Usage: /${cmd.name} <${cmd.arg}>`, true); return true; }
    if (await run(cmd.name, c.arg)) setText('');
    return true;
  }
  function pick(r: Row) {
    const rest = text.slice(caret).replace(/^[ \t]+/, '');
    if (r.mention && mn) {
      const x = insertMention(text, mn, caret, r.mention);
      setText(x.text); setMentions((m) => [...m, r.mention!]); focusAt(x.pos);
    } else if (r.g === 'agent' || HEFYN_COMMANDS.find((c) => c.name === r.cmd)?.arg) { const t = `/${r.cmd} ${rest}`; setText(t); focusAt(r.cmd!.length + 2); }
    else run(r.cmd!, '').then((ok) => { if (ok) setText(rest); focusAt(rest.length); });
  }

  const bind = {
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setText(e.target.value); setCaret(e.target.selectionStart); },
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart),
    onPaste: (e: React.ClipboardEvent) => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); attach(f); } },
    onKeyDown: (e: React.KeyboardEvent) => { // true = handled here
      if (!open) return false;
      if (e.key === 'Escape') setClosed(trig);
      else if (!rows.length) return false;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive(rows[(rows.indexOf(cur!) + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]!.key);
      else if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') pick(cur!);
      else return false;
      e.preventDefault();
      return true;
    },
    'aria-expanded': open && (!!sl || rows.length > 0),
  };
  const popover = open && (sl || rows.length > 0) ? (
    <div ref={box} className="absolute bottom-full left-0 z-30 mb-2 w-[min(34rem,100%)] overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-float ring-1 ring-foreground/10">
      {rows.length === 0 ? <p role="status" className="px-3 py-2.5 text-[13px] text-muted-foreground">No commands match</p> : (
        <Command shouldFilter={false} value={cur!.key} onValueChange={setActive} label={sl ? 'Commands' : 'Mention'} className="rounded-lg!">
          <p role="status" className="sr-only">{rows.length} suggestions. Selected: {cur!.label}</p>
          <CommandList className="max-h-72 p-1">
            {(['agent', 'hefyn', 'file', 'chat'] as const).map((g) => rows.some((r) => r.g === g) && (
              <CommandGroup key={g} heading={g === 'agent' ? o.agent ?? 'Agent' : HEADING[g]}>
                {rows.filter((r) => r.g === g).map((r) => (
                  <CommandItem key={r.key} value={r.key} onSelect={() => pick(r)} onMouseDown={(e) => e.preventDefault()} className="grid! grid-cols-[16px_12rem_1fr] items-center gap-3 text-[13px] [&>svg:last-child]:hidden">
                    <r.Icon size={14} aria-hidden className="text-muted-foreground" />
                    <span className={`min-w-0 truncate ${g === 'file' || g === 'chat' ? '' : 'font-mono text-xs'}`}>{r.label}</span>
                    <span className={`min-w-0 truncate text-left text-xs text-muted-foreground ${g === 'file' ? 'font-mono text-[11px]' : ''}`}>{r.hint}</span>
                  </CommandItem>))}
              </CommandGroup>))}
          </CommandList>
        </Command>)}
    </div>
  ) : null;
  return { mentions, clear: () => { setMentions([]); setUps([]); }, popover, bind, exec, drop, overlay, attachButton, attachments, busy: uploading(ups) };
}
