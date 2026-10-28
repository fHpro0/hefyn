import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import type { Draft } from '../../../../src/assistants/draft';
import type { Process } from '../../../../src/assistants/process';
import { cliPost, CliConversation } from '../CliChat';
import { Err, Select } from '../ui';
import type { Options } from './parts';

const rpc = trpc;
/** The form as the server takes it: the draft, plus the model settings (only people who manage models have any). */
export type DraftIn = Draft & { provider?: string | null; model?: string | null; thinking?: string | null };
/** What draft.read returns: the draft the files make, what is wrong in them, the extra files and the bundled skills. */
export interface Read { draft: Draft; errors: string[]; files: string[]; bundledSkills: string[]; /** the bundle's process.json, when it has a valid one */ process?: Process | null }

/** The creator chat of one draft: a hidden CLI agent chat that edits the draft as files. The editor only reads them back (every 3 s, and after an import). `seed` is the draft a new chat starts from. */
export function useCreator({ draftId, seed, options, agent: first, assistantId }: { draftId: string; seed: Draft; options: Options; agent?: string; /** the saved Assistant being edited: its stored files are restored into the draft folder */ assistantId?: string }) {
  const [picked, setAgent] = useState(first ?? '');
  const agent = picked || (options.agents.find((a) => a.id === 'claude-acp') ?? options.agents[0])?.id || ''; // Claude Code unless the person chose another
  const [chat, setChat] = useState<{ id: string; agent: string }>();
  const [error, setError] = useState('');
  const [read, setRead] = useState<Read>();
  const seedRef = useRef(seed); seedRef.current = seed;
  const idRef = useRef(assistantId); idRef.current = assistantId;
  const starting = useRef<Promise<{ id: string; agent: string }> | undefined>(undefined);
  const refreshing = useRef<() => Promise<void>>(async () => {});

  const ensure = () => starting.current ??= rpc.assistants.draft.start.mutate({ draftId, agent, draft: seedRef.current, ...(idRef.current && { assistantId: idRef.current }) }).then((c) => { setChat(c); setError(''); return c; }, (e: Error) => { starting.current = undefined; setError(e.message); throw e; });
  const pick = (id: string) => { starting.current = undefined; setChat(undefined); setRead(undefined); setAgent(id); };

  useEffect(() => {
    if (!chat) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await rpc.assistants.draft.read.mutate({ conversationId: chat.id, draft: seedRef.current });
        if (stop) return;
        setRead((p) => (JSON.stringify(p) === JSON.stringify(r) ? p : r)); setError('');
      } catch (e) { if (!stop) setError((e as Error).message); }
    };
    refreshing.current = tick;
    void tick();
    const h = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(h); };
  }, [chat?.id]);

  const send = async (text: string) => { const c = await ensure(); await cliPost(c.id, '/prompt', { text }); };
  return { agent, pick, chat, error, read, ensure, send, refresh: () => refreshing.current() };
}
export type Creator = ReturnType<typeof useCreator>;

const STARTERS: [string, string][] = [
  ['Write the instructions', 'Write good instructions for this Assistant. Ask me what it is for if you are not sure.'],
  ['Suggest skills and servers', 'Which of the available skills and MCP servers fit this Assistant? Add the ones that help.'],
  ['Make it shorter and clearer', 'Make the instructions shorter and clearer without losing any rule.'],
];

/** "Build with chat": the creator conversation. The agent edits the Assistant's files; the left side shows the result. */
export function BuildPanel({ creator, options }: { creator: Creator; options: Options }) {
  const { chat, error } = creator;
  useEffect(() => { if (creator.agent) void creator.ensure().catch(() => {}); }, [creator.agent]);
  const name = options.agents.find((a) => a.id === chat?.agent)?.name ?? 'The agent';
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[13px]">
        <label className="flex items-center gap-2 text-muted-foreground">Built by
          <Select className="w-44" aria-label="Agent that builds the Assistant" value={creator.agent} onChange={(e) => creator.pick(e.target.value)}>{options.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </label>
      </div>
      <Err>{error}</Err>
      {chat
        ? <CliConversation key={chat.id} id={chat.id} agent={chat.agent} name={name} view="chat"
            placeholder="Describe the Assistant you want, or what to change"
            empty={<div className="grid gap-3 pt-6"><h2 className="text-base leading-6 font-semibold">Build this Assistant in a chat</h2>
              <p className="text-[13px] leading-5 text-muted-foreground">Say what it should do. {name} writes the Assistant's files, and the left side shows the result. Nothing is saved until you press Save.</p>
              <div className="flex flex-wrap gap-2">{STARTERS.map(([label, text]) => <Button key={label} type="button" size="sm" variant="outline" onClick={() => void creator.send(text).catch(() => {})}>{label}</Button>)}</div></div>} />
        : <div className="grid grow place-items-center p-6 text-[13px] text-muted-foreground">{error ? <Button variant="outline" size="sm" onClick={() => void creator.ensure().catch(() => {})}>Try again</Button> : 'Getting the workspace ready…'}</div>}
    </div>
  );
}
