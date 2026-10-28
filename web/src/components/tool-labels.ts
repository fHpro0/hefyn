import { Brain, FilePen, FileText, Globe, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react';

/** A tool step as a plain sentence for non-technical readers. `object` is the friendly target inside `text`, `detail` the full technical one (path, command, address). */
export type Step = { text: string; object?: string; detail?: string; icon: LucideIcon };
type In = { title: string; toolKind?: string; status: string; allowed?: boolean; rawInput?: unknown; content?: { type: string; oldText?: string | null }[] };

const MCP_NAME = /^mcp__(.+?)_[0-9a-f]{4}__(.+)$/;
const TOOLS = /^(Read|Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob|WebFetch|WebSearch|Task|Agent|TodoWrite)$/;
const words = (n: string) => n.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** Agent-internal places: scratch files, the agent's own home, sub-agent output. */
const internal = (p: string) => /^\/(tmp|claude-home)\//.test(p) || /(^|\/)\.claude\//.test(p);
/** Under /files the reader's own folder ("My files"): the path relative to it. */
const friendly = (p: string) => (p.startsWith('/files/') ? p.slice(7) : base(p));

type Verb = [prog: string, past: string, fail: string];

export function describeStep(it: In): Step {
  const i = (it.rawInput && typeof it.rawInput === 'object' ? it.rawInput : {}) as Record<string, unknown>;
  const str = (...k: string[]) => { for (const x of k) if (typeof i[x] === 'string' && i[x]) return i[x] as string; };
  const tok = it.title.split(/\s+/)[0] ?? '', mcp = MCP_NAME.exec(tok), named = TOOLS.test(tok);
  const tail = (named || mcp ? it.title.slice(tok.length) : it.title).trim();
  const kind = it.toolKind ?? '', is = (k: string, ...n: string[]) => (named ? n.includes(tok) : kind === k);
  const denied = it.allowed === false, run = !denied && (it.status === 'in_progress' || it.status === 'pending'), failed = it.status === 'failed' || denied;
  const say = (v: Verb, obj?: string, pre = '', post = '') => {
    const head = run ? v[0] : denied ? v[2].replace(/^Couldn't/, "Didn't") : failed ? v[2] : v[1], o = obj ? `${pre}${obj}` : '';
    return { text: `${head}${o ? ` ${o}` : ''}${post}${run ? '…' : denied ? " — you didn't allow it" : ''}`, ...(obj && { object: obj }) };
  };
  const file = str('file_path', 'notebook_path', 'path') ?? (tail || undefined);

  if (mcp) { const t = words(mcp[2]); return { ...say(['Using', 'Used', "Couldn't use"], `${words(mcp[1]).replace(/\b\w/g, (c) => c.toUpperCase())}: ${t}`), icon: /playwright|browser/i.test(mcp[1]) ? Globe : Wrench, ...(file && { detail: file }) }; }

  const reads = is('read', 'Read'), writes = is('edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit') || kind === 'delete' || kind === 'move';
  if ((reads || writes) && file && internal(file)) {
    if (reads && /\/tasks\/[^/]+\.output$/.test(file)) return { ...say(["Checking a sub-agent's progress", "Checked a sub-agent's progress", "Couldn't check a sub-agent's progress"]), icon: FileText, detail: file };
    return { ...say(reads ? ['Reading a working file', 'Read a working file', "Couldn't read a working file"] : ['Updating a working file', 'Updated a working file', "Couldn't update a working file"]), icon: reads ? FileText : FilePen, detail: file };
  }
  if (reads) return { ...say(['Reading', 'Read', "Couldn't read"], file && friendly(file)), icon: FileText, ...(file && { detail: file }) };
  if (kind === 'delete') return { ...say(['Deleting', 'Deleted', "Couldn't delete"], file && friendly(file)), icon: FilePen, ...(file && { detail: file }) };
  if (kind === 'move') {
    const from = str('from', 'source', 'oldPath', 'old_path') ?? file, to = str('to', 'destination', 'newPath', 'new_path');
    return { ...say(['Moving', 'Moved', "Couldn't move"], from && to ? `${friendly(from)} to ${friendly(to)}` : from && friendly(from)), icon: FilePen, ...(from && { detail: to ? `${from} → ${to}` : from }) };
  }
  if (is('edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit')) {
    const made = tok === 'Write' || (!named && it.content?.some((c) => c.type === 'diff' && c.oldText == null));
    return { ...say(made ? ['Creating', 'Created', "Couldn't create"] : ['Editing', 'Edited', "Couldn't edit"], file && friendly(file)), icon: FilePen, ...(file && { detail: file }) };
  }
  if (is('search', 'Grep', 'Glob', 'WebSearch') || tok === 'WebSearch') {
    const q = str('pattern', 'query') ?? (tail || undefined), icon = tok === 'WebSearch' ? Globe : Search;
    if (tok === 'Glob') return { ...say(['Looking for files matching', 'Looked for files matching', "Couldn't look for files matching"], q), icon, ...(q && { detail: q }) };
    return { ...say(tok === 'WebSearch' ? ['Searching the web for', 'Searched the web for', "Couldn't search the web for"] : ['Searching your files for', 'Searched your files for', "Couldn't search your files for"], q && `“${q}”`), icon, ...(q && { detail: q }) };
  }
  if (is('fetch', 'WebFetch', 'WebSearch')) {
    const u = str('url') ?? (tail || undefined);
    return { ...say(['Opening', 'Opened', "Couldn't open"], u && host(u)), icon: Globe, ...(u && { detail: u }) };
  }
  if (is('execute', 'Bash')) {
    const cmd = str('command') ?? (tail || undefined), d = str('description');
    // technical paths leave the sentence (they stay in `detail`)
    const clean = d?.replace(/\s+(in|at|to|from|into|under)?\s*~?\/[\w.\-/~]*/g, '').replace(/[.\s]+$/, '').trim();
    const t = clean ? up(clean) : undefined, obj = t;
    if (!t) return { ...say(['Running a command', 'Ran a command', "Couldn't run the command"]), icon: Terminal, ...(cmd && { detail: cmd }) };
    return { text: run ? `${t}…` : denied ? `Didn't ${t.charAt(0).toLowerCase()}${t.slice(1)} — you didn't allow it` : failed ? `Couldn’t ${t.charAt(0).toLowerCase()}${t.slice(1)}` : t, object: obj, icon: Terminal, ...(cmd && { detail: cmd }) };
  }
  const x = tail || tok, t = /^\S+$/.test(x) ? words(x) : x; // a single token is a tool name; a sentence is the agent's own words
  return { text: up(t) || 'Working…', icon: kind === 'think' ? Brain : Wrench };
}
