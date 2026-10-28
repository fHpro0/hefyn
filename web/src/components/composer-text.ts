// Pure text parts of the composer's "/" and "@" (no imports, so the server tests can load them). The popover and the send step: composer.tsx.
export interface Mention { t: 'file' | 'chat'; i: string; n: string } // kind, /files path or conversation id, label
export interface CommandItem { name: string; arg?: string; help: string }

/** hefyn's own commands in a chat. An agent's commands (from its session) are sent as plain text. */
export const HEFYN_COMMANDS: CommandItem[] = [
  { name: 'new', help: 'Start a new chat' },
  { name: 'rename', arg: 'title', help: 'Rename this chat' },
  { name: 'pin', help: 'Pin or unpin this chat' },
  { name: 'archive', help: 'Archive this chat' },
];
export const NEEDS_CHAT = ['rename', 'pin', 'archive'];

/** The "/query" being typed at the caret: only at the very start of the message, no space yet. */
export function slashAt(text: string, caret: number): { q: string } | undefined {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? { q: m[1]! } : undefined;
}
/** The "@query" being typed at the caret: at the start or after whitespace. */
export function mentionAt(text: string, caret: number): { start: number; q: string } | undefined {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, q: m[2]! } : undefined;
}
export const matches = <T extends { name: string }>(list: T[], q: string) => list.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));

/** A whole message that is a command: "/rename New title" -> { name: 'rename', arg: 'New title' }. "/etc/hosts" and plain text are not. */
export function parseCommand(text: string): { name: string; arg: string } | undefined {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() } : undefined;
}

/** What the picker puts in the text: "@notes.md", or "@"Q3 summary"" when the name has spaces. */
export const tokenOf = (m: Mention) => { const n = m.n.replace(/"/g, '').slice(0, 40); return /\s/.test(n) ? `@"${n}"` : `@${n}`; };
/** Replaces the typed "@query" (start..caret) by the token and a space. `pos` is the new caret. */
export function insertMention(text: string, at: { start: number }, caret: number, m: Mention): { text: string; pos: number } {
  const tok = tokenOf(m) + ' ';
  return { text: text.slice(0, at.start) + tok + text.slice(caret), pos: at.start + tok.length };
}
/** The mentions whose token is still in the text (deleting the token drops the mention), once each. */
export const liveMentions = (text: string, ms: Mention[]) => ms.filter((m, k) => text.includes(tokenOf(m)) && ms.findIndex((x) => x.t === m.t && x.i === m.i) === k);

// What the agent receives after the typed text. The UI hides it again and shows chips instead.
export const DELIM = '--- context ---';
const BLOCK = new RegExp(`\\n\\n${DELIM}\\n([\\s\\S]*)$`);
export const filesLine = (paths: string[]) => `Files: ${paths.join(', ')}`;
export const chatLine = (title: string, path: string) => `Linked chat "${title.replace(/"/g, "'")}": ${path} (read it for context)`;
export const withContext = (text: string, lines: string[]) => (lines.length ? `${text}\n\n${DELIM}\n${lines.join('\n')}` : text);

/** The text without its context block, and the chips that block stands for. */
export function splitContext(text: string): { text: string; chips: { t: 'file' | 'chat'; n: string }[] } {
  const m = BLOCK.exec(text);
  if (!m) return { text, chips: [] };
  const chips: { t: 'file' | 'chat'; n: string }[] = [];
  for (const line of m[1]!.split('\n')) {
    const f = /^Files: (.*)$/.exec(line), c = /^Linked chat "(.*)": \S+ \(read it for context\)$/.exec(line);
    if (f) chips.push(...f[1]!.split(', ').map((p) => ({ t: 'file' as const, n: p.split('/').pop() || p }))); // shortcut: a path with ", " in it splits in two
    else if (c) chips.push({ t: 'chat', n: c[1]! });
  }
  return { text: text.slice(0, m.index), chips };
}

// Files added by drop, paste or the attach button: uploaded into /files/Uploads, then they are mentions like a picked @file.
export const UPLOAD_DIR = 'Uploads';
export interface Up { id: number; file: File; frac: number; error?: string; mention?: Mention }
export const uploading = (ups: Up[]) => ups.some((u) => !u.mention && !u.error);
const two = (n: number) => String(n).padStart(2, '0');
/** A pasted image is called "image.png" by every browser: name it like a screenshot ("Screenshot 2026-10-28 14.05.png"). */
export function pastedName(name: string, type: string, d = new Date()): string {
  if (name && !/^image\.\w+$/i.test(name)) return name;
  return `Screenshot ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${(name.split('.')[1] || type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
}
