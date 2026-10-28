import { MessageSquareOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { can, useQuery, type Me, type Runtime } from './api';
import { AgentChoice, AgentIcon, ComposerPicker, AssistantIcon, ViewToggle, findAgent, loadAgents, loadAssistants, type CliView } from './AgentChoice';
import { createBody, handoffFor, mayOpen, type Handoff } from './chat-routing';
import { agentId } from './agent-catalog';
import { AGENT_NAMES, CliConversation } from './CliChat';
import { useComposer } from './composer';
import { liveMentions, type Mention } from './composer-text';
import { PromptInput, PromptInputSubmit, PromptInputTools } from './ai-elements';
import Shell from './Shell';
import { StatusPill } from './ActivityStatus';
import { toast } from './toast';
import { AsciiMark, Err } from './ui';
import { useWebModules } from '../modules/registry';

// Every chat is a hosted CLI agent (src/cli-agents, docs/WRAPPER.md); Claude Code unless an Assistant or the agent picker says otherwise.
// A chat made before 2026-10-27 on the retired hefyn chat (no agent) opens as a notice; the old/ folder keeps the code.
interface Convo { id: string; title: string; assistantId?: string | null; createdAt?: string; pinned?: boolean; scheduled?: boolean; agent?: string | null; view?: CliView }
const hashId = () => location.hash.slice(1);

export default function Chat() {
  const convos = useQuery(() => trpc.conversations.list.query() as Promise<Convo[]>);
  const [id, setId] = useState(hashId());
  const [pending, setPending] = useState<Handoff<string>>(); // first message of a brand-new conversation, for that conversation only
  const [pendingMentions, setPendingMentions] = useState<Mention[]>([]);
  const attempt = useRef(0); // bumps whenever the reader leaves the new-chat screen: a create still in flight must not open or send
  useEffect(() => { const f = () => { attempt.current++; setId(hashId()); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => {
    const n = () => { attempt.current++; setAgent(''); setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(), 0); };
    addEventListener('hefyn-newchat', n);
    return () => removeEventListener('hefyn-newchat', n);
  }, []);
  const current = convos.data?.find((c) => c.id === id);
  const reloadRef = useRef(convos.reload); reloadRef.current = convos.reload;
  useEffect(() => { const f = () => void reloadRef.current(); addEventListener('hefyn-threads', f); return () => removeEventListener('hefyn-threads', f); }, []); // a rename in the list reaches the header
  const webMods = useWebModules();

  const agents = useQuery(loadAgents);
  const agentName = (id: string) => findAgent(agents.data, id)?.name ?? AGENT_NAMES[agentId(id)] ?? id;
  const assistants = useQuery(loadAssistants);
  const [agent, setAgent] = useState(''); // '' = the default: the highlighted Assistant, else Claude Code
  const [picked, setPicked] = useState(() => new URLSearchParams(location.search).get('assistant') ?? ''); // "Try it" links /?assistant=<id>
  const [view, setView] = useState<CliView>('chat');
  const list = assistants.data ?? [];
  const assistantId = picked && list.some((a) => a.id === picked && a.available) ? picked : (list.find((a) => a.isDefault && a.available) ?? list.find((a) => a.available))?.id ?? '';
  const chosen = agent ? undefined : list.find((a) => a.id === assistantId);
  const noAgent = !!agents.data && !!assistants.data && !list.some((a) => a.available) && !agents.data.some((a) => a.available);
  const create = async (title: string) => {
    const { id } = await trpc.conversations.create.mutate(createBody({ title, agent, view, assistantId }));
    await convos.reload(); // the list says which view to draw
    setAgent('');
    dispatchEvent(new Event('hefyn-threads'));
    return id as string;
  };
  const assistant = current?.assistantId ? list.find((a) => a.id === current.assistantId) : undefined;
  const setCliView = async (v: CliView) => {
    if (!current || v === (current.view ?? 'chat')) return;
    try {
      await trpc.conversations.update.mutate({ id, view: v }); convos.reload();
      if (!localStorage.getItem('hefyn-cli-view-note')) { localStorage.setItem('hefyn-cli-view-note', '1'); toast(v === 'terminal' ? 'Same session, shown as the agent’s own terminal.' : 'Same session, shown as a chat.'); }
    } catch (x) { toast((x as Error).message, true); }
  };
  const actions = (
    <>
      {id && <StatusPill id={id} />}
      {id && assistant && (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium whitespace-nowrap text-foreground" title={assistant.description || undefined}><AssistantIcon name={assistant.icon} size={13} /><span className="max-sm:sr-only">{assistant.name}</span>
          {current?.agent && <span className="text-muted-foreground max-sm:sr-only">· {agentName(current.agent)}</span>}</span>
      )}
      {id && current?.agent && (<>
        {!assistant && <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-seal/12 px-2 py-1 text-xs font-medium whitespace-nowrap text-seal"><AgentIcon src={findAgent(agents.data, current.agent)?.icon} size={13} /><span className="max-sm:sr-only">{agentName(current.agent)}</span></span>}
        <ViewToggle view={current.view ?? 'chat'} onChange={setCliView} />
      </>)}
    </>
  );

  const pickerFor = (me: Me) => <ComposerPicker agents={agents.data ?? []} agent={agent} assistants={list} assistant={assistantId} onPick={(v) => { setAgent(v.agent); if (v.assistant) setPicked(v.assistant); }} canManage={can(me, 'models.manage')} sandbox={can(me, 'sandbox.shell')} />;
  const pickerBar =<>{current && webMods.flatMap((m) => m.chatBadges ?? []).map((B, i) => <B key={i} chat={current} variant="header" />)}</>;
  return (
    <Shell title={id ? current?.title ?? 'Thread' : <span className="font-normal text-muted-foreground">New chat</span>} actions={<>{actions}{pickerBar}</>}>
      {(me, rt) => <Body me={me} rt={rt}>{(blocked) => id
        ? !convos.data || (current?.assistantId && !assistants.data) ? null /* the lists say which agent this chat runs on */
          : current?.agent ? <CliConversation key={id} id={id} agent={current.agent} name={assistant?.name ?? agentName(current.agent)} view={current.view ?? 'chat'} first={handoffFor(pending, id)} firstMentions={pendingMentions} onSent={() => setPending(undefined)} />
          : <Retired />
        : <NewChat blocked={blocked}
            picker={pickerFor(me)}
            start={<AgentChoice agents={agents.data ?? []} agent={agent} view={view} onView={setView} picker={agent && view === 'terminal' ? pickerFor(me) : undefined} onStart={async () => { const at = attempt.current, id = await create(agentName(agent)); if (mayOpen(at, attempt.current, hashId())) location.hash = id; }} />}
            who={noAgent ? '' : agent ? agentName(agent) : chosen?.agent ? chosen.name : 'Claude Code'} noAgent={noAgent ? (can(me, 'models.manage') ? 'admin' : 'user') : undefined} hideForm={!!agent && view === 'terminal'}
            onFirst={async (text, mentions) => {
              const at = attempt.current; // the screen this message was typed on
              const id = await create(text.slice(0, 60) || 'New chat');
              if (!mayOpen(at, attempt.current, hashId())) return; // the reader moved on: the new chat stays in the list, nothing is sent anywhere else
              setPending({ id, value: text }); setPendingMentions(mentions); location.hash = id; // the chat links are written once the chat has an id (CliChat)
            }} />}</Body>}
    </Shell>
  );
}

interface Blocked { text: string; href?: string; label?: string }
function Body({ me, rt, children }: { me: Me; rt?: Runtime; children: (blocked?: Blocked) => React.ReactNode }) {
  return <>{children(!can(me, 'models.use') ? { text: 'Your role cannot use models. Ask an admin for access.' }
    : rt && rt.state !== 'running' ? { text: 'hefyn is restarting. You can send again in a moment.' } : undefined)}</>;
}

function Retired() {
  return (
    <div className="grid grow place-items-center px-5 text-center">
      <div className="grid max-w-sm justify-items-center gap-2 text-muted-foreground">
        <MessageSquareOff size={28} aria-hidden />
        <p className="text-sm font-medium text-foreground">This chat used the retired hefyn chat.</p>
        <p className="text-[13px] leading-5">hefyn now runs every chat on a coding agent such as Claude Code. This one can not be opened any more, but you can delete it from the list or start a new chat.</p>
        <a className="text-[13px] font-medium text-foreground underline underline-offset-2" href="/#">Start a new chat</a>
      </div>
    </div>
  );
}

const STARTERS = ['Summarise a document', 'Draft a reply to a customer', 'Compare options in a table'];

/** The new-chat screen: pick an Assistant or an agent, type the first message. */
function NewChat({ start, picker, who, noAgent, hideForm, blocked, onFirst }: { start: React.ReactNode; picker: React.ReactNode; who: string; noAgent?: 'admin' | 'user'; hideForm: boolean; blocked?: Blocked; onFirst: (text: string, mentions: Mention[]) => Promise<void> }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const composer = useComposer({ text, setText, area });
  useEffect(() => { area.current?.focus(); }, [blocked]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || blocked || composer.busy) return;
    if (await composer.exec(t)) return;
    setErr(''); setText('');
    try { await onFirst(t, liveMentions(t, composer.mentions)); composer.clear(); } catch (x) { setText(t); setErr((x as Error).message); } // not delivered: keep the draft
  };
  return (
    <div className="relative isolate grid min-h-full grow grid-rows-[34fr_auto_66fr] overflow-hidden px-5 py-6" {...(hideForm ? {} : composer.drop)}>
      {composer.overlay}
      <div className="hf-dots pointer-events-none absolute inset-0 -z-10" aria-hidden />
      <div className="row-start-2 mx-auto w-full max-w-[640px]">
        <div className="grid justify-items-center gap-6 pb-7 text-center"><AsciiMark /><h1 className="text-[1.75rem] leading-9 font-semibold tracking-[-0.02em]">What should we work on?</h1>
          {noAgent && <p className="-mt-3 text-[13px] text-muted-foreground">{noAgent === 'admin' ? <>No agent is set up yet. <a className="font-medium text-foreground underline underline-offset-2" href="/settings/providers">Set up an agent</a></> : 'Ask your admin to set up an agent.'}</p>}</div>
        {start}
        {!hideForm && (
          <form onSubmit={submit} className="w-full">
            {blocked && (
              <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
                <span>{blocked.text}</span>{blocked.href && <a className="font-medium text-foreground underline underline-offset-2" href={blocked.href}>{blocked.label}</a>}
              </div>
            )}
            <div className="hf-corners">
              {composer.popover}
              <PromptInput className={blocked ? 'opacity-60' : ''}>
                {composer.attachments}
                <textarea ref={area} rows={3} aria-label="Message" value={text} disabled={!!blocked} placeholder={`Ask ${who ? `${who} ` : ''}anything…`}
                  className="min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
                  onChange={composer.bind.onChange} onSelect={composer.bind.onSelect} onPaste={composer.bind.onPaste} aria-expanded={composer.bind['aria-expanded']}
                  onKeyDown={(e) => { if (composer.bind.onKeyDown(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
                <PromptInputTools>
                  {composer.attachButton}
                  {picker}
                  <div className="grow" />
                  <PromptInputSubmit busy={false} typed={!!text.trim()} onStop={() => {}} disabled={!text.trim() || !!blocked || composer.busy} />
                </PromptInputTools>
              </PromptInput>
            </div>
            {!noAgent && !blocked && !text.trim() && (
              <div className="mt-3.5 flex flex-wrap justify-center gap-x-5 gap-y-0.5 max-sm:flex-col max-sm:items-center">
                {STARTERS.map((s) => <button key={s} type="button" className="rounded-md px-1.5 py-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setText(s); area.current?.focus(); }}>{s}</button>)}
              </div>
            )}
          </form>
        )}
        <div className="mt-4 empty:hidden"><Err>{err}</Err></div>
      </div>
    </div>
  );
}
