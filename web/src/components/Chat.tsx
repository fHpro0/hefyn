import { useFlueAgent, type FlueConversationMessage, type FlueConversationPart } from '@flue/react';
import { ArrowUp, FileText, Loader2, Paperclip, PanelRight, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api, can, upload, useLoad, type Me, type Runtime } from './api';
import { Ledger, SealedText, useLedger, type Seal } from './Audit';
import Shell from './Shell';
import ToolStep, { normalize, ThinkingStep, Timeline } from './Tools';
import { Err, Kbd, Mark, mdComponents, shortcut, toast } from './ui';

interface Convo { id: string; title: string; createdAt?: string; model?: string | null }
interface Blocked { text: string; href?: string; label?: string }
interface Attachment { name: string; path: string }
interface ModelOpt { id: string; name: string; provider: string; scope: 'company' | 'own' }
const hashId = () => location.hash.slice(1);

export default function Chat() {
  const convos = useLoad<Convo[]>('/api/conversations');
  const [id, setId] = useState(hashId());
  const [pending, setPending] = useState<string>(); // first message of a brand-new conversation
  const [carry, setCarry] = useState<File[]>(); // files dropped on a brand-new conversation, uploaded once it exists
  const [newModel, setNewModel] = useState(''); // model picked before the conversation exists
  const [ledgerOpen, setLedgerOpen] = useState(() => innerWidth >= 1100 && localStorage.getItem('hefyn-ledger') === '1');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setId(hashId()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { localStorage.setItem('hefyn-ledger', ledgerOpen ? '1' : '0'); }, [ledgerOpen]);
  useEffect(() => { // ⌘L / ⌘J and the palette send these
    const f = (e: Event) => { const w = (e as CustomEvent).detail; if (w === 'ledger') setLedgerOpen((o) => !o); if (w === 'terminal') setTerminalOpen((o) => !o); };
    const n = () => setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(), 0);
    addEventListener('hefyn-toggle', f); addEventListener('hefyn-newchat', n);
    return () => { removeEventListener('hefyn-toggle', f); removeEventListener('hefyn-newchat', n); };
  }, []);
  const ledger = useLedger(id || undefined, tick);
  const current = convos.data?.find((c) => c.id === id);

  const create = async (title: string) => {
    const { id } = await api('/api/conversations', 'POST', { title });
    if (newModel) await api(`/api/conversations/${id}`, 'PATCH', { model: newModel }).catch(() => {});
    setNewModel(''); convos.reload(); dispatchEvent(new Event('hefyn-threads'));
    return id as string;
  };
  const tog = (on: boolean) => `inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition-colors ${on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted hover:bg-foreground/5 hover:text-foreground'}`;
  const actions = (
    <>
      <ModelPicker id={id || undefined} value={id ? current?.model ?? '' : newModel} onChange={id ? convos.reload : setNewModel} />
      {id && (
        <button aria-pressed={ledgerOpen} aria-label={`Privacy ledger, ${ledger.count} ${ledger.count === 1 ? 'seal' : 'seals'}`} title={`Privacy ledger ${shortcut('L')}`} onClick={() => setLedgerOpen(!ledgerOpen)} className={tog(ledgerOpen)}>
          <PanelRight size={16} aria-hidden /><span className={`tnum rounded-md px-1 text-xs ${ledger.count ? 'bg-seal/15 text-seal' : ''}`}>{ledger.count}</span>
        </button>
      )}
      {id && <button aria-pressed={terminalOpen} aria-label="Terminal" title={`Terminal ${shortcut('J')}`} onClick={() => setTerminalOpen(!terminalOpen)} className={tog(terminalOpen)}><SquareTerminal size={16} aria-hidden /></button>}
    </>
  );

  return (
    <Shell title={id ? current?.title ?? 'Thread' : 'New chat'} actions={actions} panelOpen={!!id && ledgerOpen} onPanelClose={() => setLedgerOpen(false)} panel={<Ledger audit={ledger.audit} onClose={() => setLedgerOpen(false)} />}>
      {(me, rt) => <Body me={me} rt={rt}>{(blocked) => id
        ? <Conversation key={id} id={id} blocked={blocked} first={pending} onSent={() => setPending(undefined)} carry={carry} onCarried={() => setCarry(undefined)} seals={ledger.seals} fresh={ledger.fresh} onTurn={() => setTick((t) => t + 1)} terminalOpen={terminalOpen} onTerminalClose={() => setTerminalOpen(false)} />
        : <Conversation key="new" blocked={blocked} seals={[]} fresh={ledger.fresh}
            onFirst={async (text) => { const id = await create(text); setPending(text); location.hash = id; }}
            onAttach={async (files) => { const id = await create('New chat'); setCarry(files); location.hash = id; }} />}</Body>}
    </Shell>
  );
}

// First run: admins go to "Connect a model" from the chat page only; settings stay reachable.
function Body({ me, rt, children }: { me: Me; rt?: Runtime; children: (blocked?: Blocked) => React.ReactNode }) {
  const redirect = can(me, 'models.manage') && !me.providerConnected;
  useEffect(() => { if (redirect) location.href = '/settings/models#connect'; }, [redirect]);
  if (redirect) return null;
  const admin = can(me, 'models.manage');
  return <>{children(!can(me, 'models.use') ? { text: 'Your role cannot use models. Ask an admin for access.' }
    : !me.modelReady ? { text: admin ? 'No default model is chosen yet.' : 'An admin still needs to choose the default models.', href: admin ? '/settings/models' : undefined, label: 'Choose models' }
    : rt && rt.state !== 'running' ? { text: 'hefyn is restarting. You can send again in a moment.' } : undefined)}</>;
}

function ModelPicker({ id, value, onChange }: { id?: string; value: string; onChange: (m: string) => void }) {
  const { data } = useLoad<ModelOpt[]>('/api/models/available');
  if (!data?.length) return null;
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted"><span className="sr-only">Model</span>
      <select className="h-8 max-w-52 rounded-lg border border-border bg-background px-2 text-[13px] text-foreground" value={value}
        onChange={async (e) => { const m = e.target.value; if (!id) return onChange(m); try { await api(`/api/conversations/${id}`, 'PATCH', { model: m || null }); onChange(m); } catch (x) { toast((x as Error).message, true); } }}>
        <option value="">Default model</option>
        {(['company', 'own'] as const).map((sc) => data.some((m) => m.scope === sc) && <optgroup key={sc} label={sc === 'company' ? 'Company models' : 'My connections'}>{data.filter((m) => m.scope === sc).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}
      </select>
    </label>
  );
}

// The thread's shell commands and their output, dark in both themes.
export function TerminalDrawer({ messages, onClose }: { messages: FlueConversationMessage[]; onClose: () => void }) {
  const runs = messages.flatMap((m) => m.parts.filter((p): p is Extract<FlueConversationPart, { type: 'dynamic-tool' }> => p.type === 'dynamic-tool' && p.toolName === 'bash'));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [runs.length]);
  return (
    <section aria-label="Terminal" className="flex h-60 shrink-0 flex-col border-t border-border bg-[#09090b] text-[#fafafa]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 pr-1 pl-3 text-xs text-[#a1a1aa]"><span>Terminal <Kbd>{shortcut('J')}</Kbd></span>
        <button className="grid size-7 place-items-center rounded-md hover:bg-white/10" aria-label="Close terminal" onClick={onClose}><X size={14} /></button></div>
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

function Conversation({ id, first, onSent, onFirst, blocked, carry, onCarried, onAttach, seals, fresh, onTurn, terminalOpen, onTerminalClose }: {
  id?: string; first?: string; onSent?: () => void; onFirst?: (t: string) => Promise<void>; blocked?: Blocked;
  carry?: File[]; onCarried?: () => void; onAttach?: (f: File[]) => Promise<void>; seals: Seal[]; fresh: Set<string>; onTurn?: () => void;
  terminalOpen?: boolean; onTerminalClose?: () => void;
}) {
  const agent = useFlueAgent({ url: id ? `/agents/configurable/${id}` : undefined });
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const sent = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const stick = useRef(true); // was the reader at the bottom? then new content keeps following
  const [pad, setPad] = useState(120);
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = agent.status === 'submitted' || agent.status === 'streaming';
  const failed = agent.settlements.filter((s) => s.outcome === 'failed').at(-1);
  const visible = agent.messages.filter((m) => m.display === 'visible');
  useEffect(() => { if (first && !sent.current) { sent.current = true; agent.sendMessage(first).catch((e) => setErr(e.message)); onSent?.(); } }, [first]);
  const toBottom = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
  useEffect(toBottom, [agent.messages, pad]);
  useEffect(() => { // keep the transcript padded by the composer's height as it grows (lines, attachments) and when the terminal opens
    const c = composer.current, sc = scroller.current;
    if (!c || !sc) return;
    const ro = new ResizeObserver(() => { setPad(c.offsetHeight); toBottom(); });
    ro.observe(c); ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = `${Math.min(a.scrollHeight, 200)}px`; } }, [text]);
  useEffect(() => { if (carry && id) { attach(carry); onCarried?.(); } }, [carry, id]);
  useEffect(() => { onTurn?.(); }, [agent.status, visible.length]); // the audit row for a turn arrives with it
  useEffect(() => { if (id) dispatchEvent(new CustomEvent('hefyn-busy', { detail: { id, busy } })); }, [busy]);

  async function attach(list: File[]) {
    if (!list.length || blocked) return;
    if (!id) return void onAttach?.(list).catch((x) => setErr(x.message));
    setUploading(true); setErr('');
    try {
      const r = await upload<{ saved?: Attachment[]; path?: string; name?: string }>(`/api/conversations/${id}/attachments`, list);
      setFiles((f) => [...f, ...(r.saved ?? (r.path ? [{ name: r.name ?? r.path.split('/').pop()!, path: r.path }] : []))]);
    } catch (x) { setErr((x as Error).message); }
    setUploading(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if ((!t && !files.length) || busy || blocked) return;
    const msg = [t, ...files.map((f) => `Attached: ${f.path}`)].filter(Boolean).join('\n\n');
    setText(''); setFiles([]); setErr('');
    try { onFirst ? await onFirst(msg) : await agent.sendMessage(msg); } catch (x) { setErr((x as Error).message); }
  }

  return (
    <div className="flex min-h-0 grow flex-col">
    <div className="relative min-h-0 grow" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); attach([...e.dataTransfer.files]); }}>
      {drag && <div className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-xl border-2 border-dashed border-foreground bg-foreground/[0.04] text-sm font-medium">Drop files to attach them</div>}
      <div ref={scroller} className="absolute inset-0 overflow-y-auto" aria-live="polite"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="mx-auto grid max-w-[44rem] grid-cols-[minmax(0,1fr)] gap-4 px-5 pt-6" style={{ paddingBottom: pad + 16 }}>
          {!visible.length && (
            <div className="grid justify-items-center gap-3 py-24 text-center">
              <Mark size={40} /><h1 className="text-xl leading-7 font-semibold">What should we work on?</h1>
              <p className="max-w-sm text-sm leading-[22px] text-muted">Ask in plain language. Personal data is sealed before anything reaches the model, and you can check it in the ledger.</p>
            </div>
          )}
          {visible.map((m) => <Message key={m.id} m={m} seals={seals} fresh={fresh} />)}
          {busy && <p className="text-[13px] text-muted">Working…</p>}
          <Err>{err || (agent.status === 'error' && failed ? (failed as any)?.error?.message || 'The request failed. Try sending it again.' : '')}</Err>
        </div>
      </div>
      <form ref={composer} onSubmit={submit} className="absolute inset-x-0 bottom-0 px-4 pb-4">
        <div className="mx-auto max-w-[44rem]">
          {(files.length > 0 || uploading) && (
            <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
              {files.map((f) => <li key={f.path} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised py-0.5 pr-1 pl-2 text-xs"><FileText size={12} aria-hidden className="text-muted" />{f.name}
                <button type="button" aria-label={`Remove ${f.name}`} className="rounded p-0.5 hover:bg-foreground/5" onClick={() => setFiles(files.filter((x) => x !== f))}><X size={12} /></button></li>)}
              {uploading && <li className="inline-flex items-center gap-1.5 text-xs text-muted"><Loader2 size={12} className="animate-spin" aria-hidden />Uploading…</li>}
            </ul>
          )}
          <div className="float flex items-end gap-1 rounded-xl p-1.5 ring-1 ring-border focus-within:ring-2 focus-within:ring-foreground">
            <label className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-foreground/5 hover:text-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-foreground ${blocked ? 'pointer-events-none opacity-50' : ''}`} title="Attach files">
              <Paperclip size={16} aria-hidden /><span className="sr-only">Attach files</span>
              <input type="file" multiple className="sr-only" disabled={!!blocked} onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </label>
            {blocked ? <div role="status" className="flex min-h-8 grow flex-wrap items-center gap-x-3 px-1.5 py-1 text-sm text-muted"><span>{blocked.text}</span>{blocked.href && <a className="font-medium text-foreground underline underline-offset-2" href={blocked.href}>{blocked.label}</a>}</div> : (
              <textarea ref={area} rows={1} aria-label="Message" value={text} placeholder="Ask hefyn. Shift+Enter adds a line."
                className="max-h-52 min-h-8 grow resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            )}
            <button className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-background transition-opacity disabled:opacity-30" aria-label="Send" disabled={(!text.trim() && !files.length) || busy || uploading || !!blocked}><ArrowUp size={16} /></button>
          </div>
        </div>
      </form>
    </div>
      {terminalOpen && id && <TerminalDrawer messages={visible} onClose={() => onTerminalClose?.()} />}
    </div>
  );
}

export function Message({ m, seals, fresh }: { m: FlueConversationMessage; seals: Seal[]; fresh: Set<string> }) {
  if (m.role === 'user') {
    const t = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base leading-6 whitespace-pre-wrap"><SealedText text={t} seals={seals} fresh={fresh} /></div>;
  }
  // Runs of tool calls and reasoning become one list of steps; text stays prose.
  const blocks: (FlueConversationPart | FlueConversationPart[])[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') blocks.push(p);
    else if (p.type === 'reasoning' || p.type === 'dynamic-tool') { const last = blocks.at(-1); Array.isArray(last) ? last.push(p) : blocks.push([p]); }
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {blocks.map((b, i) => Array.isArray(b)
        ? <Timeline key={i}>{b.map((p, j) => <Step key={j} p={p} />)}</Timeline>
        : b.type === 'text' ? <div key={i} className="max-w-[68ch] text-base leading-6"><Markdown components={mdComponents}>{b.text}</Markdown></div> : null)}
    </div>
  );
}

function Step({ p }: { p: FlueConversationPart }) {
  if (p.type === 'reasoning') return <ThinkingStep text={p.text} />;
  if (p.type !== 'dynamic-tool') return null;
  return <ToolStep name={p.toolName} input={(p.input ?? {}) as Record<string, any>} state={p.state} output={p.state === 'output-available' ? p.output : undefined} errorText={p.state === 'output-error' ? p.errorText : undefined} ms={'durationMs' in p && p.durationMs ? `${p.durationMs} ms` : ''} />;
}
