import { createFlueClient, FlueApiError, type FlueConversationMessage } from '@flue/sdk';
import { db } from './appdb.ts';
import { AGENT_URL, INTERNAL_TOKEN } from './runtime.ts';
import { userOfConversation } from './usage.ts';
import { LockedError, getTeamKey, openForUser, userKey } from './vault.ts';

// Chats that talk about or to each other. Both directions stay inside one user's own chats and go through the normal agent path
// a linked chat reaches the model as an attachment; message_chat runs a turn in the other chat.

export class ChatLinkError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

const TRANSCRIPT_CAP = 30_000;
// What the composer appends to a message (web/src/components/mentions.ts): a machine-readable footer and, for an @agent, a hand-off line.
const FOOTER = /\n*<!--mentions:.*?-->\s*$/s;
const HANDOFF = /^(?:Hand this message to the |Use the skill ").*$/gm; // an @agent hand-off line or a /skill line
export const cleanUserText = (t: string) => t.replace(FOOTER, '').replace(HANDOFF, '').trim();

/** The chat's title, only if it is the user's own; anything else is "not found" (no hint that another user's chat exists). */
export function ownTitle(userId: string, id: string): string {
  const r = userOfConversation(id) === userId ? db.prepare('SELECT title FROM conversations WHERE id = ? AND user_id = ?').get(id, userId) as { title: string } | undefined : undefined;
  if (!r) throw new ChatLinkError(404, 'Chat not found.');
  return openForUser(userId, r.title, `conv:${id}:title`);
}

const oneLine = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').slice(0, 80);

/** Markdown of the visible turns: no reasoning, no tool output, one line per tool call. The last `cap` characters are kept. */
export function transcript(messages: FlueConversationMessage[], title: string, cap = TRANSCRIPT_CAP): string {
  const turns = messages.filter((m) => m.display === 'visible').flatMap((m) => {
    const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    if (m.role === 'user') return [`**User:** ${cleanUserText(text)}`];
    const tools = m.parts.flatMap((p) => (p.type === 'dynamic-tool' ? [`_(tool: ${p.toolName} ${oneLine(Object.values((p.input ?? {}) as object)[0])})_`] : []));
    return [`**Assistant:** ${text.trim()}${tools.length ? '\n' + tools.join('\n') : ''}`];
  });
  let body = turns.join('\n\n');
  const cut = body.length > cap;
  if (cut) { body = body.slice(-cap); body = body.slice(body.indexOf('\n\n') + 2); } // start on a turn boundary
  return `# Chat: ${title}\n\n${cut ? '_The start of this chat was left out: it is longer than the transcript limit._\n\n' : ''}${body || '_This chat is empty._'}\n`;
}

export const agentHeaders = (userId: string) => {
  const key = userKey(userId);
  if (!key) throw new LockedError('user', userId);
  const team = getTeamKey();
  return { 'x-hefyn-internal': INTERNAL_TOKEN, 'x-hefyn-user-key': key.toString('base64'), ...(team ? { 'x-hefyn-team-key': team.toString('base64') } : {}) };
};
// The web process reaches the agent at AGENT_URL; the agent calls itself on loopback (its other hostnames go through the egress proxy).
const SELF_URL = `http://127.0.0.1:${process.env.HEFYN_AGENT_PORT ?? process.env.PORT ?? 5174}`;
const clientFor = (userId: string, chat: string, base = AGENT_URL) => createFlueClient({ url: `${base}/agents/configurable/${chat}`, headers: agentHeaders(userId) });

async function flueHistory(userId: string, chat: string): Promise<FlueConversationMessage[]> {
  try { return (await clientFor(userId, chat).history()).messages; } catch (e) { if (e instanceof FlueApiError && e.status === 404) return []; if (e instanceof LockedError) throw e; throw new ChatLinkError(502, 'That chat could not be read.'); }
}

/** Transcript of one of the user's chats as a Markdown file body. `history` is injectable for tests. */
export async function linkedChat(userId: string, chat: string, history = flueHistory) {
  const title = ownTitle(userId, chat);
  return { title, markdown: transcript(await history(userId, chat), title) };
}

// ---- opt-in messaging between a user's own chats ----
export function acceptingChats(userId: string, except?: string) {
  return (db.prepare('SELECT id, title FROM conversations WHERE user_id = ? AND accept_messages = 1 AND id != ? ORDER BY created_at DESC').all(userId, except ?? '') as { id: string; title: string }[])
    .map((r) => ({ id: r.id, title: openForUser(userId, r.title, `conv:${r.id}:title`) }));
}
export const hasAcceptingChats = (userId: string, except: string) =>
  !!db.prepare('SELECT 1 FROM conversations WHERE user_id = ? AND accept_messages = 1 AND id != ?').get(userId, except);

// Depth 1: a chat that is answering a message_chat must not message on (checked in the tool and when the tools are registered).
const relayed = new Set<string>();
export const isRelayed = (chat: string) => relayed.has(chat);

async function runTurn(userId: string, chat: string, text: string, signal: AbortSignal): Promise<string> {
  const c = clientFor(userId, chat, SELF_URL);
  return (await c.read(await c.send({ message: { kind: 'user', body: text } }), { signal })).text;
}

export async function messageChat(o: { userId: string; from: string; chat: string; message: string; run?: typeof runTurn; timeoutMs?: number }) {
  const { userId, from, chat, message, run = runTurn, timeoutMs = 5 * 60_000 } = o;
  if (chat === from) throw new ChatLinkError(400, 'A chat cannot message itself.');
  if (relayed.has(from)) throw new ChatLinkError(400, 'This chat is answering a message from another chat and cannot message further chats.');
  const title = ownTitle(userId, chat);
  if (!(db.prepare('SELECT accept_messages AS a FROM conversations WHERE id = ?').get(chat) as { a: number }).a) throw new ChatLinkError(403, `"${title}" does not accept messages from other chats.`);
  if (relayed.has(chat)) throw new ChatLinkError(409, `"${title}" is already answering another chat.`);
  relayed.add(chat);
  try {
    const answer = await run(userId, chat, `From chat “${ownTitle(userId, from)}”:\n\n${message}`, AbortSignal.timeout(timeoutMs));
    return { chat: title, answer };
  } catch (e) {
    if (e instanceof ChatLinkError) throw e;
    throw new ChatLinkError(502, (e as Error).name === 'TimeoutError' ? `"${title}" did not answer within ${Math.round(timeoutMs / 60000)} minutes.` : `"${title}" could not answer: ${(e as Error).message}`);
  } finally { relayed.delete(chat); }
}
