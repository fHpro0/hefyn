// A first message belongs to the one conversation created for it. Any other chat that opens must not pick it up.
export interface Handoff<T> { id: string; value: T }
export const handoffFor = <T,>(h: Handoff<T> | undefined, id: string): T | undefined => (h && h.id === id ? h.value : undefined);

/** A create that resolved late may open its chat only if the reader is still on the new-chat screen of the same attempt. */
export const mayOpen = (attempt: number, current: number, hash: string) => attempt === current && !hash;

/** The body of conversations.create: the Assistant that is highlighted, or a raw agent; the view only for a raw agent (an Assistant's chat opens as a chat). Every chat is a CLI agent chat; the server picks Claude Code when neither is given. */
export function createBody(o: { title: string; agent: string; view: 'chat' | 'terminal'; assistantId: string }) {
  return { title: o.title, ...(o.agent ? { agent: o.agent, view: o.view } : o.assistantId ? { assistantId: o.assistantId } : {}) };
}
