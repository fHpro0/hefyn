// A first message or dropped files belong to the one conversation created for them. Any other chat that opens must not pick them up.
export interface Handoff<T> { id: string; value: T }
export const handoffFor = <T,>(h: Handoff<T> | undefined, id: string): T | undefined => (h && h.id === id ? h.value : undefined);

/** A create that resolved late may open its chat only if the reader is still on the new-chat screen of the same attempt. */
export const mayOpen = (attempt: number, current: number, hash: string) => attempt === current && !hash;

/** The body of conversations.create: the Assistant that is highlighted, and a view only for a CLI agent chat (flows have none). */
export function createBody(o: { title: string; project?: string | null; cli: boolean; agent: string; view: 'chat' | 'terminal'; assistantId: string; flow?: boolean }) {
  return {
    title: o.title, ...(o.project && { projectId: o.project }),
    ...(o.cli && o.agent ? { agent: o.agent, view: o.view } : o.assistantId && { assistantId: o.assistantId, ...(o.cli && !o.flow && { view: o.view }) }),
  };
}
