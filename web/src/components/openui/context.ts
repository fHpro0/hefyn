import { createContext } from 'react';

/** What a rendered OpenUI block can do in its chat: `send` writes a follow-up message to the agent (absent outside a chat: the actions are inert). */
export const ChatActions = createContext<{ send?: (text: string) => void }>({});
/** True while the agent message holding the block is still streaming. */
export const Streaming = createContext(false);
