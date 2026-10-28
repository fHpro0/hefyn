import { createFlueClient } from '@flue/sdk';
import { useFlueAgent, type FlueConversationMessage, type FlueConversationPart } from '@flue/react';
import { useWebModules } from '../modules/registry';
import { Activity, ArrowDown, Code, FileText, Loader2, Mail, MessagesSquare, Paperclip, RefreshCw, Search, SquareTerminal, X } from 'lucide-react';
import { AgentChoice, AgentIcon, AssistantIcon, ViewToggle, findAgent, loadAgents, loadAssistants, type AssistantInfo, type CliView } from './AgentChoice';
import { shrinkImage } from './image-fit';
import { createBody, handoffFor, mayOpen, type Handoff } from './chat-routing';
import { agentId } from './agent-catalog';
import { AGENT_NAMES, CliConversation } from './CliChat';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { can, upload, useQuery, type Me, type Runtime } from './api';
import { Message, MessageActions, MessageContent, PromptInput, PromptInputSubmit, PromptInputTools, Queue, QueueItem, Reasoning, Source, Sources, Suggestion } from './ai-elements';
import { Button } from '@/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { copyItem, MenuArea } from './AppMenu';
import Shell, { Hint } from './Shell';
import ToolPart, { normalize, sourcesOf } from './tool-parts';
import { CopyButton } from './copy';
import { Md } from './markdown';
import { plainText } from './mention-text';
import { composeMessage, MentionChips, parseMessage, useMentions, type Mention } from './mentions';
import { useSlash, type SlashCtx } from './slash';
import { toast } from './toast';
import { Err, Kbd, Mark, shortcut } from './ui';
import { StatusPill, useActivity } from './ActivityStatus';
import { delegations, helperLine } from './activity';

interface Convo { id: string; title: string; assistantId?: string | null; createdAt?: string; acceptMessages?: boolean; pinned?: boolean; scheduled?: boolean; agent?: string | null; view?: CliView }
const rpc = trpc;
interface Blocked { text: string; href?: string; label?: string }
interface Attachment { name: string; path: string }
const hashId = () => location.hash.slice(1);

export default function Chat() {
  const convos = useQuery(() => trpc.conversations.list.query() as Promise<Convo[]>);
  const [id, setId] = useState(hashId());
  const [pending, setPending] = useState<Handoff<string>>(); // first message of a brand-new conversation, for that conversation only
  const [carry, setCarry] = useState<Handoff<File[]>>(); // files dropped on a brand-new conversation, uploaded once it exists
  const attempt = useRef(0); // bumps whenever the reader leaves the new-chat screen: a create still in flight must not open or send
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => { const f = () => { attempt.current++; setId(hashId()); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { // ⌘J and the palette send these
    const f = (e: Event) => { if ((e as CustomEvent).detail === 'terminal') setTerminalOpen((o) => !o); };
    const n = () => { attempt.current++; setAgent(''); setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(), 0); };
    addEventListener('hefyn-toggle', f); addEventListener('hefyn-newchat', n);
    return () => { removeEventListener('hefyn-toggle', f); removeEventListener('hefyn-newchat', n); };
  }, []);
  const current = convos.data?.find((c) => c.id === id);
  const webMods = useWebModules();
  const chats = useMemo(() => (convos.data ?? []).filter((c) => c.id !== id).map(({ id, title }) => ({ id, title })), [convos.data, id]);

  const agents = useQuery(loadAgents); // none offered (or no sandbox): the new-chat screen stays as it was
  const agentName = (id: string) => findAgent(agents.data, id)?.name ?? AGENT_NAMES[agentId(id)] ?? id;
  const assistants = useQuery(loadAssistants);
  const [agent, setAgent] = useState(''); // '' = hefyn, the classic chat
  const [picked, setPicked] = useState(() => new URLSearchParams(location.search).get('assistant') ?? ''); // the Assistant chosen on the new-chat screen ("Try it" links /?assistant=<id>); '' = the default one
  const [view, setView] = useState<CliView>('chat');
  const list = assistants.data ?? [];
  const assistantId = picked && list.some((a) => a.id === picked && a.available) ? picked : (list.find((a) => a.isDefault && a.available) ?? list.find((a) => a.available))?.id ?? '';
  const chosen = agent ? undefined : list.find((a) => a.id === assistantId);
  const asCli = !!chosen?.agent || !!chosen?.flow; // an Assistant that runs on an installed agent, or a flow: opened like a raw agent chat (event log)
  const viaCli = !!agent || asCli;
  const create = async (title: string, cli = false) => {
    const project = new URLSearchParams(location.search).get('project'); // "New chat in project" from the project page
    const { id } = await rpc.conversations.create.mutate(createBody({ title, project, cli, agent, view, assistantId, flow: chosen?.flow }));
    if (cli) { await convos.reload(); setAgent(''); } else convos.reload(); // a CLI chat must be in the list before its page opens: the list says which view to draw
    dispatchEvent(new Event('hefyn-threads'));
    return id as string;
  };
  const assistant = current?.assistantId ? list.find((a) => a.id === current.assistantId) : undefined;
  const isFlow = !!assistant?.flow; // a conversation of a flow Assistant: the same event view as a CLI chat
  const isCli = !!current?.agent || isFlow;
  const setCliView = async (v: CliView) => {
    if (!current || v === (current.view ?? 'chat')) return;
    try {
      await rpc.conversations.update.mutate({ id, view: v }); convos.reload();
      if (!localStorage.getItem('hefyn-cli-view-note')) { localStorage.setItem('hefyn-cli-view-note', '1'); toast(v === 'terminal' ? 'Same session, shown as the agent’s own terminal.' : 'Same session, shown as a chat.'); }
    } catch (x) { toast((x as Error).message, true); }
  };
  const tog = (on: boolean) => `text-[13px] font-medium ${on ? 'bg-muted text-foreground' : 'text-muted-foreground'}`;
  const toggleAccept = async () => {
    if (!current) return;
    try { await trpc.conversations.update.mutate({ id, acceptMessages: !current.acceptMessages }); convos.reload(); } catch (x) { toast((x as Error).message, true); }
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
      {id && current && !isCli && (
        <Hint label={current.acceptMessages ? 'Other chats may message this one (on)' : 'Other chats may message this one (off)'}>
          <Button variant="ghost" aria-pressed={!!current.acceptMessages} aria-label="Other chats may message this one" onClick={toggleAccept} className={tog(!!current.acceptMessages)}><MessagesSquare size={16} aria-hidden /></Button>
        </Hint>
      )}
      {id && !isCli && <Hint label="Trace: turns, tool calls, timing"><Button variant="ghost" nativeButton={false} aria-label="Trace" render={<a href={`/trace#${id}`} />}><Activity size={16} aria-hidden /></Button></Hint>}
      {id && !isCli && <Hint label={`Terminal ${shortcut('J')}`}><Button variant="ghost" aria-pressed={terminalOpen} aria-label="Terminal" onClick={() => setTerminalOpen(!terminalOpen)} className={tog(terminalOpen)}><SquareTerminal size={16} aria-hidden /></Button></Hint>}
    </>
  );

  const slash: SlashCtx = { thread: current, reload: convos.reload };
  const pickerBar = <>{current && webMods.flatMap((m) => m.chatBadges ?? []).map((B, i) => <B key={i} chat={current} variant="header" />)}</>;
  return (
    <Shell title={id ? current?.title ?? 'Thread' : 'New chat'} actions={actions}>
      {(me, rt) => <Body me={me} rt={rt}>{(blocked) => id
        ? !convos.data || (current?.assistantId && !assistants.data) ? null /* the lists say whether this is a CLI agent or flow chat */ : current?.agent || isFlow ? <CliConversation key={id} id={id} agent={current?.agent ?? ''} flow={isFlow && !current?.agent} name={assistant?.name ?? agentName(current?.agent ?? '')} view={current?.view ?? 'chat'} first={handoffFor(pending, id)} onSent={() => setPending(undefined)} /> : <Conversation key={id} id={id} inputs={assistant?.inputs} askAs={assistant?.name} picker={pickerBar} slash={slash} blocked={blocked} first={handoffFor(pending, id)} onSent={() => setPending(undefined)} carry={handoffFor(carry, id)}onCarried={() => setCarry(undefined)} chats={chats} terminalOpen={terminalOpen} onTerminalClose={() => setTerminalOpen(false)} />
        : <Conversation key="new" picker={pickerBar} slash={slash} blocked={viaCli ? undefined : blocked} askAs={chosen?.name} chats={chats}
            start={<AgentChoice agents={agents.data ?? []} agent={agent} onAgent={setAgent} view={view} onView={setView} onStart={async () => { const at = attempt.current, id = await create(agentName(agent), true); if (mayOpen(at, attempt.current, hashId())) location.hash = id; }} canManage={can(me, 'models.manage')} assistants={list} assistant={assistantId} onAssistant={setPicked} />} agentName={agent ? agentName(agent) : asCli ? chosen!.name : undefined} hideForm={viaCli && !chosen?.flow && view === 'terminal'}
            onFirst={async (text, mentions) => {
              const at = attempt.current; // the screen this message was typed on
              const id = await create(viaCli ? text.slice(0, 60) || 'New chat' : plainText(text, mentions) || 'New chat', viaCli);
              const msg = viaCli ? text : await composeMessage(id, text, [], mentions);
              if (!mayOpen(at, attempt.current, hashId())) return; // the reader moved on: the new chat stays in the list, nothing is sent anywhere else
              setPending({ id, value: msg }); location.hash = id;
            }}
            onAttach={async (files) => { if (viaCli) return void toast('Attachments are not available for this agent yet.', true); const at = attempt.current, id = await create('New chat'); if (!mayOpen(at, attempt.current, hashId())) return; setCarry({ id, value: files }); location.hash = id; }} />}</Body>}
    </Shell>
  );
}

function Body({ me, rt, children }: { me: Me; rt?: Runtime; children: (blocked?: Blocked) => React.ReactNode }) {
  const admin = can(me, 'models.manage');
  return <>{children(!can(me, 'models.use') ? { text: 'Your role cannot use models. Ask an admin for access.' }
    : !me.providerConnected ? { text: admin ? 'Connect a provider to start chatting.' : 'An admin still needs to connect a provider.', href: admin ? '/settings/providers#connect' : undefined, label: 'Connect a provider' }
    : !me.modelReady ? { text: admin ? 'The connected provider offers no models yet.' : 'An admin still needs to connect a provider that offers models.', href: admin ? '/settings/providers' : undefined, label: 'Open providers' }
    : rt && rt.state !== 'running' ? { text: 'hefyn is restarting. You can send again in a moment.' } : undefined)}</>;
}

// The thread's shell commands and their output, dark in both themes.
export function TerminalDrawer({ messages, onClose }: { messages: FlueConversationMessage[]; onClose: () => void }) {
  const runs = messages.flatMap((m) => m.parts.filter((p): p is Extract<FlueConversationPart, { type: 'dynamic-tool' }> => p.type === 'dynamic-tool' && p.toolName === 'bash'));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [runs.length]);
  return (
    <section aria-label="Terminal" className="flex h-60 shrink-0 flex-col border-t border-border bg-[#09090b] text-[#fafafa]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 pr-1 pl-3 text-xs text-[#a1a1aa]"><span>Terminal <Kbd>{shortcut('J')}</Kbd></span>
        <Button variant="ghost" size="icon-sm" className="text-[#a1a1aa] hover:bg-white/10 hover:text-white dark:hover:bg-white/10" aria-label="Close terminal" onClick={onClose}><X size={14} /></Button></div>
      <div className="min-h-0 grow overflow-auto p-3 font-mono text-[12.5px] leading-5">
        {!runs.length && <p className="text-[#a1a1aa]">No commands yet. Shell commands the agent runs in this thread appear here.</p>}
        {runs.map((p, i) => {
          const o = normalize(p.state === 'output-available' ? p.output : p.state === 'output-error' ? p.errorText : undefined);
          return (
            <div key={i} className="mb-3">
              <div className="break-words whitespace-pre-wrap"><span className="text-[#4ade80]">$</span> {String((p.input as any)?.command ?? '')}</div>
              {p.state === 'input-available' && <div className="text-[#a1a1aa]">running…</div>}
              {o.stdout !== undefined || o.stderr !== undefined ? <>{o.stdout && <pre className="break-words whitespace-pre-wrap">{o.stdout}</pre>}{o.stderr && <pre className="break-words whitespace-pre-wrap text-[#f87171]">{o.stderr}</pre>}</>
                : o.text && <pre className="break-words whitespace-pre-wrap">{o.text}</pre>}
              {o.exit !== undefined && o.exit !== 0 && <div className="text-[#f87171]">exit {o.exit}</div>}
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </section>
  );
}

const SUGGESTIONS = [
  { icon: FileText, label: 'Summarize a file', prompt: 'Summarize the attached file in five bullet points.' },
  { icon: Mail, label: 'Draft an email', prompt: 'Draft a short, friendly email to ' },
  { icon: Search, label: 'Research a topic', prompt: 'Research the following topic and give me the key points: ' },
  { icon: Code, label: 'Explain some code', prompt: 'Explain what this code does:\n\n' },
];

export function Conversation({ id, inputs, askAs, picker, start, hideForm, agentName, first, onSent, onFirst, blocked, carry, onCarried, onAttach, chats, terminalOpen, onTerminalClose, slash: slashCtx = {} }: {
  id?: string; inputs?: AssistantInfo['inputs']; askAs?: string; slash?: SlashCtx; picker?: React.ReactNode; start?: React.ReactNode; hideForm?: boolean; agentName?: string; first?: string; onSent?: () => void; onFirst?: (t: string, m: Mention[]) => Promise<void>; blocked?: Blocked; chats: { id: string; title: string }[];
  carry?: File[]; onCarried?: () => void; onAttach?: (f: File[]) => Promise<void>;  terminalOpen?: boolean; onTerminalClose?: () => void;
}) {
  // A 423 from the agent proxy means the user's key is not in memory: tell the Unlock dialog; the draft stays in the composer.
  const locked = useRef(false);
  const client = useMemo(() => id ? createFlueClient({ url: `/agents/configurable/${id}`, fetch: async (...a) => {
    const r = await fetch(...a);
    if (r.status === 423) locked.current = true;
    if (r.status === 423) dispatchEvent(new CustomEvent('hefyn-locked', { detail: { scope: 'user' } }));
    return r;
  } }) : undefined, [id]);
  const agent = useFlueAgent({ client });
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const sent = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const stick = useRef(true); // was the reader at the bottom? then new content keeps following
  const [away, setAway] = useState(false); // scrolled up from the bottom: offer "Jump to latest"
  const [pad, setPad] = useState(120);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const mention = useMentions(text, setText, area, chats);
  const slash = useSlash({ id, ctx: slashCtx, text, setText, area, setMentions: mention.setMentions });
  const busy = agent.status === 'submitted' || agent.status === 'streaming';
  const failed = agent.settlements.filter((s) => s.outcome === 'failed').at(-1);
  const visible = agent.messages.filter((m) => m.display === 'visible');
  const count = visible.length;
  const stopped = !busy && agent.settlements.at(-1)?.outcome === 'aborted';
  const lastUser = visible.findLast((m) => m.role === 'user');
  const lastUserText = lastUser?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
  const halted = useRef(false); // the reader pressed Stop: the queue waits instead of sending itself
  const deliver = (msg: string) => agent.sendMessage(msg);
  const stop = () => { halted.current = true; (client?.abort() ?? Promise.resolve()).catch((x) => setErr(x.message)); }; // the partial answer stays; the run settles as aborted
  const resend = () => { setErr(''); locked.current = false; agent.sendMessage(lastUserText).catch((x) => setErr(x.message)); }; // Flue has no regenerate: send the last message again
  const [queue, setQueue] = useState<{ key: number; text: string; msg: string }[]>([]);
  const wasBusy = useRef(false);
  const sendNext = () => { const [n, ...rest] = queue; if (!n) return; setQueue(rest); halted.current = false; deliver(n.msg).catch((x) => setErr(x.message)); };
  useEffect(() => { // an answer finished: the next queued message goes out
    if (wasBusy.current && !busy && !halted.current && agent.status !== 'error') sendNext();
    wasBusy.current = busy;
  }, [busy]);
  const [wide, setWide] = useState(() => innerWidth >= 640);
  useEffect(() => { const m = matchMedia('(min-width: 640px)'), f = () => setWide(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  const hero = !count && wide; // empty thread on a wide screen: the composer sits in the middle group
  useEffect(() => { if (first && !sent.current) { sent.current = true; deliver(first).catch((e) => setErr(e.message)); onSent?.(); } }, [first]);
  const toBottom = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
  const lastInput = useRef(0); // when the reader last scrolled by hand: a scroll event without it is the page growing (markdown, images), not the reader leaving
  useEffect(toBottom, [agent.messages, queue.length, pad]);
  useEffect(() => { // keep the transcript padded by the composer's height as it grows (lines, attachments) and when the terminal opens
    const c = composer.current, sc = scroller.current;
    if (!c || !sc) return;
    const ro = new ResizeObserver(() => { setPad(c.offsetHeight); toBottom(); });
    ro.observe(c); ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild); // content growing after the first paint keeps an opened chat at its end
    return () => ro.disconnect();
  }, [hero]);
  useEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = `${Math.min(a.scrollHeight, innerHeight * 0.4)}px`; } }, [text, hero]);
  useEffect(() => { if (!id) area.current?.focus(); }, [hero, blocked]); // a new chat is ready to type in; the composer moves when the first message lands
  useEffect(() => { if (carry && id) { attach(carry); onCarried?.(); } }, [carry, id]);
  const act = useActivity(id); // this page's state plus the server's: a reload mid-run is still "working"
  const helpers = busy ? delegations(visible.at(-1)?.role === 'assistant' ? visible.at(-1)!.parts as any : []) : []; // delegations still running in the answer being written
  const helperKey = helpers.map((h) => h.name).join('\n');
  useEffect(() => { if (id) dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy, agents: helpers } })); }, [busy, helperKey]);
  useEffect(() => () => { if (id) dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy: false } })); }, [id]);

  async function attach(list: File[]) {
    if (!list.length || blocked) return;
    if (!id) return void onAttach?.(list).catch((x) => setErr(x.message));
    setUploading(true); setErr('');
    try {
      if (inputs) { // the Assistant's input rules; the server enforces them too
        const ok: File[] = [];
        for (const f of list) {
          const img = f.type.startsWith('image/');
          if (img && inputs.images === 'off') toast('This assistant doesn’t accept images.', true);
          else if (!img && !inputs.documents) toast('This assistant doesn’t accept documents.', true);
          else if (f.size > inputs.maxUploadMb * 1048576) toast(`${f.name} is larger than ${inputs.maxUploadMb} MB.`, true);
          else ok.push(img ? await shrinkImage(f, inputs.maxImageEdge, inputs.imageQuality) : f);
        }
        list = ok;
        if (!list.length) return void setUploading(false);
      }
      const r = await upload<{ saved?: Attachment[]; path?: string; name?: string }>(`/api/conversations/${id}/attachments`, list);
      setFiles((f) => [...f, ...(r.saved ?? (r.path ? [{ name: r.name ?? r.path.split('/').pop()!, path: r.path }] : []))]);
    } catch (x) { setErr((x as Error).message); }
    setUploading(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if ((!t && !files.length) || blocked) return;
    if (!files.length && await slash.exec(text)) return; // "/rename …" and friends run here instead of being sent
    const kept = files, mentions = mention.mentions;
    let failed = false;
    setText(''); setFiles([]); mention.clear(); setErr(''); locked.current = false;
    try {
      if (onFirst) await onFirst(t, mentions);
      else if (busy) { const msg = await composeMessage(id!, t, kept, mentions); setQueue((q) => [...q, { key: Date.now(), text: plainText(t, mentions) || 'Attachment', msg }]); } // waits for the answer to finish
      else { halted.current = false; await deliver(await composeMessage(id!, t, kept, mentions)); }
    } catch (x) { failed = true; setErr((x as Error).message); }
    if (locked.current || failed) { setText(t); setFiles(kept); mention.setMentions(mentions); } // locked or not delivered: keep the draft
  }

  const form = (
    <form ref={composer} onSubmit={submit} className={hero ? 'w-full' : 'pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background from-60% to-transparent px-5 pt-8 pb-4'}>
      <div className="pointer-events-auto mx-auto max-w-3xl">
        {blocked && (
          <div role="status" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
            <span>{blocked.text}</span>{blocked.href && <a className="font-medium text-foreground underline underline-offset-2" href={blocked.href}>{blocked.label}</a>}
          </div>
        )}
        {(files.length > 0 || uploading) && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
            {files.map((f) => <li key={f.path} className="inline-flex"><MenuArea items={() => <>{copyItem('Copy name', f.name, 'Name')}<DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" className="text-[13px]" onClick={() => setFiles(files.filter((x) => x !== f))}><X {...ico} />Remove</DropdownMenuItem></>}>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised py-0.5 pr-1 pl-2 text-xs"><FileText size={12} aria-hidden className="text-muted-foreground" />{f.name}
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} className="size-5" onClick={() => setFiles(files.filter((x) => x !== f))}><X size={12} /></Button></span></MenuArea></li>)}
            {uploading && <li className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" aria-hidden />Uploading…</li>}
          </ul>
        )}
        {mention.mentions.length > 0 && <div className="mb-2"><MentionChips mentions={mention.mentions} onRemove={(m) => mention.setMentions(mention.mentions.filter((x) => x !== m))} /></div>}
        {queue.length > 0 && <Queue>{queue.map((q) => <QueueItem key={q.key} text={q.text} onRemove={() => setQueue(queue.filter((x) => x !== q))} onSend={!busy ? sendNext : undefined} />)}</Queue>}
        <PromptInput className={blocked ? 'opacity-60' : ''}>
          {mention.popover}{slash.popover}
          <textarea ref={area} rows={hero ? 3 : 1} aria-label="Message" value={text} disabled={!!blocked} placeholder={agentName || askAs ? `Ask ${agentName ?? askAs} anything…` : 'Ask hefyn anything… @ links a file, chat or agent, / for commands'}
            className="min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            aria-expanded={mention.bind['aria-expanded'] || slash.bind['aria-expanded']} aria-haspopup={mention.bind['aria-haspopup']} onSelect={(e) => { mention.bind.onSelect(e); slash.bind.onSelect(e); }}
            onChange={(e) => { setText(e.target.value); mention.bind.onSelect(e); slash.bind.onSelect(e); }}
            onKeyDown={(e) => { if (mention.bind.onKeyDown(e) || slash.bind.onKeyDown(e)) return; if (e.key === 'Escape' && busy) { e.preventDefault(); stop(); } if (e.key === 'Enter'&& !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
          <PromptInputTools>
            {!agentName && <>
            <Hint label="Attach files">
              <Button type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label="Attach files" disabled={!!blocked} onClick={() => fileIn.current?.click()}><Paperclip size={16} aria-hidden /></Button>
            </Hint>
            <Hint label="Commands and skills">
              <Button type="button" variant="ghost" size="icon" className="shrink-0 font-mono text-base text-muted-foreground" aria-label="Commands" disabled={!!blocked} onClick={slash.openList}><span aria-hidden>/</span></Button>
            </Hint></>}
            <input ref={fileIn} type="file" multiple hidden tabIndex={-1} aria-hidden onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <div className="flex min-w-0 items-center">{picker}</div>
            <PromptInputSubmit busy={busy} typed={!!text.trim() || files.length > 0} onStop={stop} disabled={(!text.trim() && !files.length) || uploading || !!blocked} />
          </PromptInputTools>
        </PromptInput>
      </div>
    </form>
  );

  return (
    <div className="flex min-h-0 grow flex-col">
    <div className="relative min-h-0 grow" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); attach([...e.dataTransfer.files]); }}>
      {drag && <div className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground bg-foreground/[0.04] text-sm font-medium">Drop files to attach them</div>}
      <div ref={scroller} className="absolute inset-0 overflow-y-auto" aria-live="polite"
        onWheel={() => { lastInput.current = Date.now(); }} onTouchMove={() => { lastInput.current = Date.now(); }} onKeyDown={() => { lastInput.current = Date.now(); }}
        onPointerDown={() => { lastInput.current = Date.now() + 5000; }} // the scrollbar thumb: no wheel events while dragging
        onScroll={(e) => {
          const el = e.currentTarget, near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (!near && stick.current && Date.now() - lastInput.current > 1000) return void (el.scrollTop = el.scrollHeight); // grew under a follower: stay at the end
          stick.current = near; setAway(!near);
        }}>
        {hero ? (
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-5 pt-6 pb-[12vh]">
            <div className="grid justify-items-center gap-3 pb-7 text-center"><Mark size={40} /><h1 className="text-2xl leading-8 font-semibold">What should we work on?</h1></div>
            {start}
            {!hideForm && form}
            <ul className="mt-4 flex flex-wrap justify-center gap-2 empty:hidden" aria-label="Suggestions">
              {(agentName ? [] : SUGGESTIONS).map(({ icon: Icon, label, prompt }) => (
                <li key={label}><Suggestion disabled={!!blocked} onClick={() => { setText(prompt); area.current?.focus(); }}><Icon size={14} aria-hidden />{label}</Suggestion></li>
              ))}
            </ul>
            <div className="mt-4"><Err>{err}</Err></div>
          </div>
        ) : (
        <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 px-5 pt-6" style={{ paddingBottom: pad + 16 }}>
          {!count && (
            <div className="grid justify-items-center gap-4 pt-10 pb-4 text-center">
              <Mark size={40} /><h1 className="text-xl leading-7 font-semibold">What should we work on?</h1>
              {start}
              <ul className="flex flex-wrap justify-center gap-2 empty:hidden" aria-label="Suggestions">
                {(agentName ? [] : SUGGESTIONS).map(({ icon: Icon, label, prompt }) => (
                  <li key={label}><Suggestion disabled={!!blocked} onClick={() => { setText(prompt); area.current?.focus(); }}><Icon size={14} aria-hidden />{label}</Suggestion></li>
                ))}
              </ul>
            </div>
          )}
          {visible.map((m, i) => <ChatMessage key={m.id} m={m} streaming={busy && i === visible.length - 1} onRegenerate={!busy && !blocked && i === visible.length - 1 && lastUserText ? resend : undefined} />)}
          <div role="status" className="grid gap-0.5 text-[13px] text-muted-foreground empty:hidden">{busy || act.state === 'running' ? <><p>Working…</p>{helperLine(act.agents) && <p>{helperLine(act.agents)}</p>}</> : stopped ? <p>Stopped.</p> : null}</div>
          <Err>{err || (agent.status === 'error' && failed ? (failed as any)?.error?.message || 'The request failed. Try sending it again.' : '')}</Err>
          {!busy && !blocked && lastUserText && (err || (agent.status === 'error' && failed)) && <div><Button type="button" variant="outline" size="sm" onClick={resend}><RefreshCw size={14} aria-hidden />Retry</Button></div>}
        </div>
        )}
      </div>
      {!hero && away && <div className="pointer-events-none absolute inset-x-0 z-10 flex justify-center" style={{ bottom: pad + 8 }}>
        <Button type="button" variant="outline" size="sm" className="pointer-events-auto rounded-full bg-background shadow-float" onClick={() => { stick.current = true; setAway(false); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={14} aria-hidden />Jump to latest</Button>
      </div>}
      {!hero && !hideForm && form}
    </div>
      {terminalOpen && id && <TerminalDrawer messages={visible} onClose={() => onTerminalClose?.()} />}
    </div>
  );
}

function ChatMessage({ m, streaming, onRegenerate }: { m: FlueConversationMessage; streaming?: boolean; onRegenerate?: () => void }) {
  if (m.role === 'user') {
    const { text: t, mentions } = parseMessage(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
    const from = /^From chat “(.+?)”:\n\n/.exec(t); // set by message_chat: another chat of this user wrote this
    const body = from ? t.slice(from[0].length) : t;
    return (
      <MenuArea items={() => copyItem('Copy message', body, 'Message')}><Message from="user"><MessageContent>
        {from && <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><MessagesSquare size={12} aria-hidden />From chat “{from[1]}”</div>}
        <div>{body}</div>
        <MentionChips mentions={mentions} />
      </MessageContent></Message></MenuArea>
    );
  }
  const answer = m.parts.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n\n');
  const sources = streaming ? [] : sourcesOf(m.parts as any);
  return (
    <MenuArea items={() => <>{answer && copyItem('Copy answer', answer, 'Answer')}{answer && onRegenerate && !streaming && <DropdownMenuItem className="text-[13px]" onClick={onRegenerate}><RefreshCw {...ico} />Regenerate answer</DropdownMenuItem>}</>}>
    <Message from="assistant">
      {m.parts.map((p, i) => p.type === 'text' ? <MessageContent key={i}><Md>{p.text}</Md></MessageContent>
        : p.type === 'reasoning' ? <Reasoning key={i} text={p.text} streaming={p.state === 'streaming'} />
        : p.type === 'dynamic-tool' ? <MenuArea key={i} items={() => <>{copyItem('Copy input', JSON.stringify(p.input ?? {}, null, 2), 'Input')}
            {(p.state === 'output-available' || p.state === 'output-error') && copyItem(p.state === 'output-error' ? 'Copy error' : 'Copy output', normalize(p.state === 'output-error' ? p.errorText : p.output).text, 'Output')}</>}>
          <ToolPart name={p.toolName} input={(p.input ?? {}) as Record<string, any>} state={p.state}
            output={p.state === 'output-available' ? p.output : undefined} errorText={p.state === 'output-error' ? p.errorText : undefined} ms={'durationMs' in p && p.durationMs ? `${p.durationMs} ms` : ''} /></MenuArea>
        : null)}
      {sources.length > 0 && <Sources count={sources.length}>{sources.map((s) => <Source key={s.href} {...s} />)}</Sources>}
      {answer && !streaming && (
        <MessageActions>
          <CopyButton text={answer} label="Copy answer" />
          {onRegenerate && <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Regenerate answer" title="Regenerate answer" onClick={onRegenerate}><RefreshCw size={14} aria-hidden /></Button>}
        </MessageActions>
      )}
    </Message></MenuArea>
  );
}

const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;
