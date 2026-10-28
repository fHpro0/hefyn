import { posix } from 'node:path';
import { z } from 'zod';
import { installedFor } from '../hub.ts';
import { db } from '../appdb.ts';
import { fsFor } from '../runner.ts';
import { openForUser } from '../vault.ts';
import { perm, router } from '../trpc.ts';
import { userOfConversation } from '../usage.ts';
import { TRPCError } from '@trpc/server';

// The @ popover: files and agents on demand (chats come from conversations.list), and the "link" step that turns chosen files
// into attachments of the current conversation. Linking whole chats needed the retired hefyn chat's history (old/src/server/chat-links.ts).
const MAX_SCAN = 400, MAX_DEPTH = 4;
const use = perm('models.use');
const fail = (code: TRPCError['code'], message: string): never => { throw new TRPCError({ code, message }); };

const MAX_MD = 200_000;
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'chat';

/** A chat's event log as Markdown: what the person asked, what the agent answered, one line per tool call (never raw output or images). Oldest turns are cut past ~200 KB. */
function chatMarkdown(userId: string, id: string, title: string): string {
  const rows = db.prepare('SELECT seq, data FROM cli_events WHERE conversation_id = ? ORDER BY seq').all(id) as { seq: number; data: string }[];
  const blocks: string[] = [], tools = new Map<string, number>();
  let agent = false; // the last block is agent text still being streamed
  for (const r of rows) {
    const u = JSON.parse(openForUser(userId, r.data, `cli:${id}:${r.seq}`)).update ?? {};
    if (u.hefyn === 'user' && typeof u.text === 'string') { blocks.push(`## You\n\n${u.text}`); agent = false; }
    else if (u.sessionUpdate === 'agent_message_chunk' && !u.agent && u.content?.type === 'text') {
      if (agent) blocks[blocks.length - 1] += String(u.content.text ?? ''); else blocks.push(`## Agent\n\n${u.content.text ?? ''}`);
      agent = true;
    } else if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && !u.agent) {
      agent = false;
      const at = tools.get(u.toolCallId);
      const line = (t: string, s: string) => `- Tool: ${t}${s ? ` (${s})` : ''}`;
      if (at === undefined) { tools.set(u.toolCallId, blocks.length); blocks.push(line(String(u.title ?? 'Working'), String(u.status ?? ''))); }
      else { const m = /^- Tool: (.*?)(?: \((\w+)\))?$/s.exec(blocks[at]!); blocks[at] = line(String(u.title ?? m?.[1] ?? 'Working'), String(u.status ?? m?.[2] ?? '')); }
    }
  }
  if (!blocks.length) return fail('BAD_REQUEST', 'That chat has no messages yet.');
  let cut = 0, size = blocks.reduce((n, b) => n + b.length + 2, 0);
  while (size > MAX_MD && cut < blocks.length - 1) size -= blocks[cut++]!.length + 2;
  return `# ${title}\n\n${cut ? `_The first ${cut} of ${blocks.length} blocks were left out to keep this file short._\n\n` : ''}${blocks.slice(cut).join('\n\n')}\n`.slice(0, MAX_MD + 1000);
}

export const mentionsRouter = router({
  // Writes the chat `chat` as Markdown into the scratch folder of conversation `id` and returns the path the agent reads it at. Both must be the caller's.
  linkChat: use.input(z.object({ id: z.string(), chat: z.string() })).mutation(async ({ ctx: { me }, input }) => {
    if (userOfConversation(input.id) !== me.id || userOfConversation(input.chat) !== me.id) return fail('FORBIDDEN', 'forbidden');
    const row = db.prepare('SELECT title FROM conversations WHERE id = ? AND user_id = ?').get(input.chat, me.id) as { title: string } | undefined;
    if (!row) return fail('NOT_FOUND', 'That chat does not exist.');
    const title = openForUser(me.id, row.title, `conv:${input.chat}:title`); // LockedError when the key is gone: the client shows the unlock prompt
    const md = chatMarkdown(me.id, input.chat, title), fs = fsFor(me.id, input.id), dir = '/tmp/hefyn-linked';
    const taken = new Set((await fs.list(dir).catch(() => [])).map((e) => e.name));
    let name = `${slug(title)}.md`;
    for (let n = 2; taken.has(name); n++) name = `${slug(title)}-${n}.md`;
    await fs.writeFile(`${dir}/${name}`, md);
    return { path: `${dir}/${name}`, title };
  }),

  search: use.input(z.object({ q: z.string().optional() })).query(async ({ ctx: { me }, input }) => {
    const userId = me.id, q = (input.q ?? '').toLowerCase().trim();
    const fs = fsFor(userId), files: { name: string; path: string }[] = [];
    const queue: [string, number][] = [['/files', 0]];
    for (let seen = 0; queue.length && seen < MAX_SCAN && files.length < 30;) { // breadth first: shallow files first; shortcut: the first 400 entries, a deeper search needs an index
      const [dir, depth] = queue.shift()!;
      for (const e of await fs.list(dir).catch(() => [])) {
        seen++;
        const path = posix.join(dir, e.name);
        if (e.type === 'dir' && depth < MAX_DEPTH) queue.push([path, depth + 1]);
        else if (e.type === 'file' && (!q || path.toLowerCase().includes(q))) files.push({ name: e.name, path });
      }
    }
    return { files, agents: installedFor(userId).agents.map((a) => ({ name: a.name, description: a.description })) };
  }),

  // Files are written into this conversation's scratch dir (at most 10 are used).
  link: use.input(z.object({ id: z.string(), chats: z.array(z.string()).optional(), files: z.array(z.string()).optional() })).mutation(async ({ ctx: { me }, input }) => {
    const userId = me.id, id = input.id;
    if (userOfConversation(id) !== userId) return fail('FORBIDDEN', 'forbidden');
    if (input.chats?.length) return fail('BAD_REQUEST', 'Linking chats is not available any more.');
    const saved: { name: string; path: string; kind: 'chat' | 'file' }[] = [];
    const files = fsFor(userId);
    for (const f of (input.files ?? []).slice(0, 10)) {
      const path = posix.normalize('/files/' + f.replace(/^\/files\/?/, ''));
      if (!path.startsWith('/files/') || !(await files.stat(path).then((s) => s.isFile, () => false))) return fail('NOT_FOUND', `${f} is not a file.`);
      saved.push({ name: posix.basename(path), path, kind: 'file' });
    }
    return { saved };
  }),
});
