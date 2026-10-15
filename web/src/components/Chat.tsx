import { useFlueAgent, type FlueConversationMessage, type FlueConversationPart } from '@flue/react';
import { FileText, Loader2, Paperclip, Plus, SendHorizontal, ShieldCheck, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api, can, upload, useLoad, type Me, type Runtime } from './api';
import { Ledger, SealedText, useLedger, type Seal } from './Audit';
import Shell, { PaneHeading, paneRow } from './Shell';
import ToolStep, { ThinkingStep, Timeline } from './Tools';
import { buttonGhost, Err, Logo, mdComponents, toast } from './ui';

interface Convo { id: string; title: string; createdAt?: string; model?: string | null }
interface Blocked { text: string; href?: string; label?: string }
interface Attachment { name: string; path: string }
interface ModelOpt { id: string; name: string; provider: string; scope: 'company' | 'own' }
const hashId = () => location.hash.slice(1);

function dayGroups(list: Convo[]) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(new Date());
  const out: [string, Convo[]][] = [['Today', []], ['Yesterday', []], ['Earlier', []]];
  for (const c of list) { const age = c.createdAt ? Math.round((today - day(new Date(c.createdAt))) / 864e5) : 2; out[age <= 0 ? 0 : age === 1 ? 1 : 2][1].push(c); }
  return out.filter(([, l]) => l.length);
}

export default function Chat() {
  const convos = useLoad<Convo[]>('/api/conversations');
  const [id, setId] = useState(hashId());
  const [pending, setPending] = useState<string>(); // first message of a brand-new conversation
  const [carry, setCarry] = useState<File[]>(); // files dropped on a brand-new conversation, uploaded once it exists
  const [newModel, setNewModel] = useState(''); // model picked before the conversation exists
  const [ledgerOpen, setLedgerOpen] = useState(() => innerWidth >= 1100 && localStorage.getItem('hefyn-ledger') === '1');
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setId(hashId()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { localStorage.setItem('hefyn-ledger', ledgerOpen ? '1' : '0'); }, [ledgerOpen]);
  const ledger = useLedger(id || undefined, tick);
  const current = convos.data?.find((c) => c.id === id);

  const pane = (
    <>
      <button className={`${paneRow(!id)} mb-1 font-medium`} onClick={() => (location.hash = '')}><Plus size={16} aria-hidden />New chat</button>
      {dayGroups(convos.data ?? []).map(([label, list]) => (
        <Fragment key={label}><PaneHeading>{label}</PaneHeading>
          {list.map((c) => <button key={c.id} className={paneRow(c.id === id)} title={c.title} aria-current={c.id === id ? 'page' : undefined} onClick={() => (location.hash = c.id)}><span className="truncate">{c.title}</span></button>)}</Fragment>
      ))}
      {convos.data && !convos.data.length && <p className="px-2.5 pt-3 text-sm text-soft">Your conversations will appear here.</p>}
    </>
  );
  const create = async (title: string) => {
    const { id } = await api('/api/conversations', 'POST', { title });
    if (newModel) await api(`/api/conversations/${id}`, 'PATCH', { model: newModel }).catch(() => {});
    setNewModel(''); convos.reload();
    return id as string;
  };
  const actions = (
    <>
      <ModelPicker id={id || undefined} value={id ? current?.model ?? '' : newModel} onChange={id ? convos.reload : setNewModel} />
      {id && (
        <button aria-pressed={ledgerOpen} aria-label={`Privacy ledger, ${ledger.count} ${ledger.count === 1 ? 'seal' : 'seals'}`} onClick={() => setLedgerOpen(!ledgerOpen)}
          className={`inline-flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-sm font-medium transition-colors ${ledgerOpen ? 'bg-seal/15 text-seal' : 'text-soft hover:bg-ink/5 hover:text-ink'}`}>
          <ShieldCheck size={17} aria-hidden /><span className="tnum">{ledger.count}</span>
        </button>
      )}
    </>
  );

  return (
    <Shell pane={pane} title={id ? current?.title ?? 'Conversation' : 'New chat'} actions={actions} ledgerOpen={!!id && ledgerOpen} onLedgerClose={() => setLedgerOpen(false)} ledger={<Ledger audit={ledger.audit} onClose={() => setLedgerOpen(false)} />}>
      {(me, rt) => <Body me={me} rt={rt}>{(blocked) => id
        ? <Conversation key={id} id={id} blocked={blocked} first={pending} onSent={() => setPending(undefined)} carry={carry} onCarried={() => setCarry(undefined)} seals={ledger.seals} fresh={ledger.fresh} onTurn={() => setTick((t) => t + 1)} />
        : <Conversation key="new" blocked={blocked} seals={[]} fresh={ledger.fresh}
            onFirst={async (text) => { const id = await create(text); setPending(text); location.hash = id; }}
            onAttach={async (files) => { const id = await create('New chat'); setCarry(files); location.hash = id; }} />}</Body>}
    </Shell>
  );
}

// First run: admins go to "Connect a model" from the chat page only; settings stay reachable.
function Body({ me, rt, children }: { me: Me; rt?: Runtime; children: (blocked?: Blocked) => React.ReactNode }) {
  const redirect = can(me, 'models.manage') && !me.providerConnected;
  useEffect(() => { if (redirect) location.href = '/settings/models'; }, [redirect]);
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
    <label className="flex items-center gap-2 text-sm text-soft"><span className="sr-only sm:not-sr-only">Model</span>
      <select className="h-9 max-w-52 rounded-[10px] border border-line bg-sheet px-2.5 text-sm text-ink" value={value}
        onChange={async (e) => { const m = e.target.value; if (!id) return onChange(m); try { await api(`/api/conversations/${id}`, 'PATCH', { model: m || null }); onChange(m); } catch (x) { toast((x as Error).message, true); } }}>
        <option value="">Default model</option>
        {(['company', 'own'] as const).map((sc) => data.some((m) => m.scope === sc) && <optgroup key={sc} label={sc === 'company' ? 'Company models' : 'My connections'}>{data.filter((m) => m.scope === sc).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}
      </select>
    </label>
  );
}

function Conversation({ id, first, onSent, onFirst, blocked, carry, onCarried, onAttach, seals, fresh, onTurn }: {
  id?: string; first?: string; onSent?: () => void; onFirst?: (t: string) => Promise<void>; blocked?: Blocked;
  carry?: File[]; onCarried?: () => void; onAttach?: (f: File[]) => Promise<void>; seals: Seal[]; fresh: Set<string>; onTurn?: () => void;
}) {
  const agent = useFlueAgent({ url: id ? `/agents/configurable/${id}` : undefined });
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const sent = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = agent.status === 'submitted' || agent.status === 'streaming';
  const failed = agent.settlements.filter((s) => s.outcome === 'failed').at(-1);
  const visible = agent.messages.filter((m) => m.display === 'visible');
  useEffect(() => { if (first && !sent.current) { sent.current = true; agent.sendMessage(first).catch((e) => setErr(e.message)); onSent?.(); } }, [first]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [agent.messages]);
  useEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = `${Math.min(a.scrollHeight, 200)}px`; } }, [text]);
  useEffect(() => { if (carry && id) { attach(carry); onCarried?.(); } }, [carry, id]);
  useEffect(() => { onTurn?.(); }, [agent.status, visible.length]); // the audit row for a turn arrives with it

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
    <div className="relative flex min-h-0 grow flex-col" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); attach([...e.dataTransfer.files]); }}>
      {drag && <div className="pointer-events-none absolute inset-0 z-20 m-3 grid place-items-center rounded-2xl border-2 border-dashed border-hefyn bg-hefyn/10 text-sm font-medium text-hefyn">Drop files to attach them</div>}
      <div className="grow overflow-y-auto" aria-live="polite">
        <div className="mx-auto grid max-w-[46rem] grid-cols-[minmax(0,1fr)] gap-5 px-5 py-4">
          {!visible.length && (
            <div className="grid justify-items-center gap-3 py-24 text-center">
              <Logo size={44} /><h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.01em]">What should we work on?</h1>
              <p className="max-w-sm text-[15px] leading-6 text-soft">Ask in plain language. Personal data is sealed before anything reaches the model, and you can check it in the ledger.</p>
            </div>
          )}
          {visible.map((m) => <Message key={m.id} m={m} seals={seals} fresh={fresh} />)}
          {busy && <p className="text-sm text-soft">Working…</p>}
          <Err>{err || (agent.status === 'error' && failed ? (failed as any)?.error?.message || 'The request failed. Try sending it again.' : '')}</Err>
          <div ref={end} />
        </div>
      </div>
      <form onSubmit={submit} className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-[46rem]">
          {(files.length > 0 || uploading) && (
            <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
              {files.map((f) => <li key={f.path} className="inline-flex items-center gap-1.5 rounded-full bg-sheet py-1 pr-1.5 pl-3 text-xs ring-1 ring-line"><FileText size={12} aria-hidden className="text-soft" />{f.name}
                <button type="button" aria-label={`Remove ${f.name}`} className="rounded-full p-0.5 hover:bg-ink/5" onClick={() => setFiles(files.filter((x) => x !== f))}><X size={12} /></button></li>)}
              {uploading && <li className="inline-flex items-center gap-1.5 text-xs text-soft"><Loader2 size={12} className="animate-spin" aria-hidden />Uploading…</li>}
            </ul>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl bg-sheet p-2 shadow-float ring-1 ring-line focus-within:ring-2 focus-within:ring-hefyn">
            <label className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-[10px] text-soft hover:bg-ink/5 hover:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-hefyn ${blocked ? 'pointer-events-none opacity-50' : ''}`} title="Attach files">
              <Paperclip size={17} aria-hidden /><span className="sr-only">Attach files</span>
              <input type="file" multiple className="sr-only" disabled={!!blocked} onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </label>
            {blocked ? <div role="status" className="flex min-h-9 grow flex-wrap items-center gap-x-3 px-1.5 py-1.5 text-[15px] text-soft"><span>{blocked.text}</span>{blocked.href && <a className="font-medium text-hefyn hover:underline" href={blocked.href}>{blocked.label}</a>}</div> : (
            <textarea ref={area} rows={1} aria-label="Message" value={text} placeholder="Message hefyn. Shift+Enter adds a line."
              className="max-h-52 min-h-9 grow resize-none bg-transparent px-1.5 py-1.5 text-[15px] outline-none placeholder:text-soft/70 disabled:cursor-not-allowed"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            )}
            <button className="grid size-9 shrink-0 place-items-center rounded-full bg-hefyn text-on-hefyn transition-opacity disabled:opacity-40" aria-label="Send" disabled={(!text.trim() && !files.length) || busy || uploading || !!blocked}><SendHorizontal size={16} /></button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function Message({ m, seals, fresh }: { m: FlueConversationMessage; seals: Seal[]; fresh: Set<string> }) {
  if (m.role === 'user') {
    const t = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return <div className="max-w-[85%] justify-self-end rounded-[12px] bg-sheet px-3.5 py-2.5 text-[15px] leading-6 whitespace-pre-wrap ring-1 ring-line"><SealedText text={t} seals={seals} fresh={fresh} /></div>;
  }
  // Runs of tool calls and reasoning become one timeline; text stays prose.
  const blocks: (FlueConversationPart | FlueConversationPart[])[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') blocks.push(p);
    else if (p.type === 'reasoning' || p.type === 'dynamic-tool') { const last = blocks.at(-1); Array.isArray(last) ? last.push(p) : blocks.push([p]); }
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {blocks.map((b, i) => Array.isArray(b)
        ? <Timeline key={i}>{b.map((p, j) => <Step key={j} p={p} />)}</Timeline>
        : b.type === 'text' ? <div key={i} className="max-w-[68ch] text-[15px] leading-6"><Markdown components={mdComponents}>{b.text}</Markdown></div> : null)}
    </div>
  );
}

function Step({ p }: { p: FlueConversationPart }) {
  if (p.type === 'reasoning') return <ThinkingStep text={p.text} />;
  if (p.type !== 'dynamic-tool') return null;
  return <ToolStep name={p.toolName} input={(p.input ?? {}) as Record<string, any>} state={p.state} output={p.state === 'output-available' ? p.output : undefined} errorText={p.state === 'output-error' ? p.errorText : undefined} ms={'durationMs' in p && p.durationMs ? `${p.durationMs} ms` : ''} />;
}
