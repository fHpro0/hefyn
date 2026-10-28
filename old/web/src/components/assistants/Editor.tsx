import { ArrowLeft, Monitor, Redo2, SlidersHorizontal, TriangleAlert, Undo2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { can, useQuery, type Me } from '../api';
import { AssistantIcon } from '../AgentChoice';
import { ConfirmDialog, Dialog } from '../dialogs';
import Shell, { Hint } from '../Shell';
import { toast } from '../toast';
import { Err, Input, shortcut } from '../ui';
import { fromSimple, isSimple, toSimple, type Flow, type FlowError } from './flow';
import { AgentFields, defaultInputs, InputRules, Pick, type Inputs, type Options } from './parts';
import Tools, { ToolsCtx, ToolsLink } from './Tools';

// The canvas (and @xyflow/react with it) loads only when someone opens the Flow view.
const Canvas = lazy(() => import('./Canvas'));
const rpc = trpc;

interface Doc { name: string; description: string; icon: string; inputs: Inputs; roles: string[]; flow: Flow }
interface Meta { id?: string; owner: 'me' | 'team'; scope: string; isDefault?: boolean; archived?: boolean; shareStatus?: string | null }
const ICONS: Record<string, string> = { Sparkles: 'Sparkles', MessageSquare: 'Chat', PenLine: 'Pen', Headset: 'Headset', Briefcase: 'Briefcase', Scale: 'Scales', FileText: 'Document', Mail: 'Mail', Globe: 'Globe', Database: 'Database', Bot: 'Robot', Wrench: 'Wrench' };
/** The flow with its list of turned-off tools replaced (an empty list leaves no setting, like the server). */
const withTools = (f: Flow, disabled: string[]): Flow => { const { tools: _t, ...rest } = f; return disabled.length ? { ...rest, tools: { disabled } } : rest; };
const blank = (): Doc => ({ name: '', description: '', icon: 'Sparkles', inputs: defaultInputs(), roles: [], flow: fromSimple(null, {}) });

/** Flow errors from a failed save: the server's errorFormatter puts them in `data.details`. */
function errorsOf(x: any): FlowError[] | null {
  const d = x?.data?.details;
  return Array.isArray(d) && d.length > 0 && d.every((e) => typeof e?.message === 'string') ? d : null;
}

/** In-memory undo/redo over the whole document. Quick edits of one field (same `key`) share one step. */
function useHistory() {
  const [h, setH] = useState<{ past: Doc[]; now?: Doc; future: Doc[] }>({ past: [], future: [] });
  const last = useRef({ key: '', at: 0 });
  const reset = useCallback((d: Doc) => { last.current = { key: '', at: 0 }; setH({ past: [], now: d, future: [] }); }, []);
  const set = useCallback((p: Partial<Doc>, key?: string, push = true) => {
    const t = Date.now(), join = !!key && last.current.key === key && t - last.current.at < 1500;
    last.current = { key: key ?? '', at: t };
    setH((s) => (s.now ? { past: push && !join ? [...s.past, s.now].slice(-100) : s.past, now: { ...s.now, ...p }, future: push ? [] : s.future } : s));
  }, []);
  const checkpoint = useCallback(() => { last.current = { key: '', at: 0 }; setH((s) => (s.now ? { ...s, past: [...s.past, s.now].slice(-100), future: [] } : s)); }, []);
  const undo = useCallback(() => setH((s) => (s.past.length && s.now ? { past: s.past.slice(0, -1), now: s.past.at(-1), future: [s.now, ...s.future] } : s)), []);
  const redo = useCallback(() => setH((s) => (s.future.length && s.now ? { past: [...s.past, s.now], now: s.future[0], future: s.future.slice(1) } : s)), []);
  return { doc: h.now, set, reset, checkpoint, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

const useNarrow = () => {
  const [n, setN] = useState(() => matchMedia('(max-width: 799px)').matches);
  useEffect(() => { const m = matchMedia('(max-width: 799px)'), f = () => setN(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return n;
};

export default function AssistantEditor() {
  return <Shell title="Assistant">{(me) => <Body me={me} />}</Shell>;
}

function Body({ me }: { me: Me }) {
  const id = location.hash.slice(1) || 'new';
  const options = useQuery(() => rpc.assistants.options.query());
  const hist = useHistory();
  const { doc } = hist;
  const [meta, setMeta] = useState<Meta>({ owner: 'me', scope: new URLSearchParams(location.search).get('scope') === 'team' && can(me, 'assistants.manage') ? 'team' : 'private' });
  const [saved, setSaved] = useState('');
  const [mode, setMode] = useState<'simple' | 'flow' | 'tools'>('simple');
  const [errors, setErrors] = useState<FlowError[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [leave, setLeave] = useState(false);
  const [access, setAccess] = useState(false);
  const [draft, setDraft] = useState<Doc>();
  const narrow = useNarrow();
  const draftKey = `hefyn-assistant-draft:${id}`;

  useEffect(() => {
    const start = (d: Doc, m?: Partial<Meta>) => {
      try { const x = JSON.parse(localStorage.getItem(draftKey) ?? 'null'); if (x?.doc && JSON.stringify(x.doc) !== JSON.stringify(d)) setDraft(x.doc); } catch { /* no usable draft */ }
      hist.reset(d); setSaved(JSON.stringify(d)); setMode(isSimple(d.flow) ? 'simple' : 'flow'); if (m) setMeta((x) => ({ ...x, ...m })); };
    if (id === 'new') return start(blank());
    rpc.assistants.get.query({ id }).then((a: any) => start({ name: a.name, description: a.description ?? '', icon: a.icon || 'Sparkles', inputs: a.inputs ?? defaultInputs(), roles: a.roles ?? [], flow: a.flow },
      { id: a.id, owner: a.owner, scope: a.scope, isDefault: a.isDefault, archived: a.archived, shareStatus: a.shareStatus })).catch((x: Error) => setFailed(x.message));
  }, [id]);

  const readOnly = meta.owner === 'team' && !can(me, 'assistants.manage');
  const dirty = !!doc && JSON.stringify(doc) !== saved;
  const flowJson = doc && JSON.stringify(doc.flow);

  // Check the flow on the server shortly after the last change; errors mark nodes and edges and keep Save off.
  useEffect(() => {
    if (!doc) return;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await rpc.assistants.validate.query({ flow: doc.flow });
        setErrors(r.errors);
      } catch { /* offline: keep the last answer, save will say */ }
      setChecking(false);
    }, 500);
    return () => clearTimeout(t);
  }, [flowJson]);

  // Keep an unsaved draft in this browser so a reload does not lose it. Not while the restore question is open.
  useEffect(() => {
    if (!doc || draft || readOnly) return;
    if (!dirty) { localStorage.removeItem(draftKey); return; }
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify({ at: Date.now(), doc })); } catch { /* storage full or off */ } }, 800);
    return () => clearTimeout(t);
  }, [doc, dirty, draft, readOnly]);

  useEffect(() => {
    if (!dirty || readOnly) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f);
  }, [dirty, readOnly]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return; // let a text field undo its own typing
      e.preventDefault(); e.shiftKey ? hist.redo() : hist.undo();
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);

  if (failed) return <div className="p-6"><Err>{failed}</Err><Button variant="outline" className="mt-3" onClick={() => (location.href = '/assistants')}>Back to Assistants</Button></div>;
  if (!doc || !options.data) return <div className="p-6 text-muted-foreground">{options.error ? <Err>{options.error}</Err> : 'Loading…'}</div>;
  const o = options.data;
  const set = (p: Partial<Doc>, key?: string) => hist.set(p, key);
  const simple = toSimple(doc.flow);
  const showRoles = !!o.roles && meta.scope === 'team';

  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc.assistants.save.mutate({ ...(meta.id && { id: meta.id }), ...doc, ...(!meta.id && meta.scope === 'team' && { scope: 'team' }) });
      if (r.errors?.length) { setErrors(r.errors); toast('Fix the marked steps first.', true); return; }
      setSaved(JSON.stringify(doc)); localStorage.removeItem(draftKey);
      if (!meta.id) { setMeta((m) => ({ ...m, id: r.id })); history.replaceState(null, '', `${location.pathname}${location.search}#${r.id}`); }
      toast('Saved');
    } catch (x) {
      const es = errorsOf(x);
      if (es) { setErrors(es); toast('Fix the marked steps first.', true); } else toast((x as Error).message, true);
    } finally { setBusy(false); }
  };
  const back = () => (dirty && !readOnly ? setLeave(true) : (location.href = '/assistants'));

  const rules = <>
    <InputRules value={doc.inputs} onChange={(inputs) => set({ inputs }, 'inputs')} />
    {showRoles && <Pick label="Who may use it" none="Everyone" items={o.roles!} value={doc.roles} onChange={(roles) => set({ roles })} />}
  </>;

  const toolsCtx = { disabled: doc.flow.tools?.disabled ?? [], assistantId: meta.id, manage: () => setMode('tools') };
  return (
    <ToolsCtx.Provider value={toolsCtx}>
    <div className="flex min-h-0 grow flex-col">
      <header className="grid gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Hint label="Back to Assistants"><Button variant="ghost" size="icon" aria-label="Back to Assistants" onClick={back}><ArrowLeft size={16} aria-hidden /></Button></Hint>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" size="icon" aria-label="Icon" disabled={readOnly} />}><AssistantIcon name={doc.icon} /></PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <div className="flex max-w-60 flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
                {Object.entries(ICONS).map(([n, label]) => <button key={n} type="button" role="radio" aria-checked={doc.icon === n} aria-label={label} title={label}
                  className={`grid size-8 place-items-center rounded-md border ${doc.icon === n ? 'border-foreground bg-muted' : 'border-border hover:bg-muted'}`} onClick={() => set({ icon: n })}><AssistantIcon name={n} /></button>)}
              </div>
            </PopoverContent>
          </Popover>
          <Input className="min-w-40 max-w-sm grow" aria-label="Name" value={doc.name} maxLength={60} disabled={readOnly} autoFocus={id === 'new'} placeholder="Name, for example Customer replies" onChange={(e) => set({ name: e.target.value }, 'name')} />
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'simple' | 'flow' | 'tools')} className="shrink-0">
            <TabsList aria-label="How to edit"><TabsTrigger value="simple" disabled={!simple} title={simple ? undefined : 'This Assistant has more than one step'}>Simple</TabsTrigger><TabsTrigger value="flow">Flow</TabsTrigger><TabsTrigger value="tools">Tools</TabsTrigger></TabsList>
          </Tabs>
          <div className="ml-auto flex items-center gap-1">
            {!readOnly && <>
              <Hint label={`Undo ${shortcut('Z')}`}><Button variant="ghost" size="icon" aria-label="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Undo2 size={16} aria-hidden /></Button></Hint>
              <Hint label={`Redo ${shortcut('⇧Z')}`}><Button variant="ghost" size="icon" aria-label="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Redo2 size={16} aria-hidden /></Button></Hint>
            </>}
            {mode === 'flow' && <Button variant="ghost" onClick={() => setAccess(true)}><SlidersHorizontal size={14} aria-hidden />Attachments{showRoles ? ' and access' : ''}</Button>}
            {!readOnly && <Button disabled={busy || checking || !dirty || !doc.name.trim() || errors.length > 0} onClick={save}>Save</Button>}
          </div>
        </div>
        <Input aria-label="What it is for" value={doc.description} maxLength={140} disabled={readOnly} placeholder="What it is for: a short line people see when choosing" onChange={(e) => set({ description: e.target.value }, 'description')} />
        {draft && !readOnly && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-[13px]">
            <span className="grow">You have unsaved changes from earlier in this browser.</span>
            <Button size="sm" onClick={() => { set({ ...draft }); setMode(isSimple(draft.flow) ? 'simple' : 'flow'); setDraft(undefined); }}>Restore unsaved changes</Button>
            <Button size="sm" variant="ghost" onClick={() => { localStorage.removeItem(draftKey); setDraft(undefined); }}>Discard</Button>
          </div>
        )}
        {readOnly && <p role="status" className="text-[13px] text-muted-foreground">This is a team Assistant. You can look at it; an admin changes it.</p>}
        {!simple && mode === 'flow' && <p className="text-[13px] text-muted-foreground">The Simple view is off because this Assistant has more than one step.</p>}
        {errors.length > 0 && mode === 'simple' && <p role="alert" className="flex items-center gap-1.5 text-[13px] text-danger-ink"><TriangleAlert size={14} aria-hidden />{errors[0]!.message} Open the Flow view to see where.</p>}
      </header>

      {mode === 'simple' && simple && (
        <fieldset disabled={readOnly} className="mx-auto grid w-full max-w-2xl content-start gap-4 px-6 py-5">
          <AgentFields value={simple} options={o} onChange={(p) => set({ flow: fromSimple(doc.flow, p) }, `simple:${Object.keys(p).join()}`)} />
          <ToolsLink node={doc.flow.nodes.find((n) => n.type === 'agent')!} flow={doc.flow} />
          {rules}
        </fieldset>
      )}
      {mode === 'tools' && <div className="min-h-0 grow overflow-y-auto"><Tools flow={doc.flow} assistantId={meta.id} readOnly={readOnly} onChange={(disabled) => set({ flow: withTools(doc.flow, disabled) }, 'tools')} /></div>}
      {mode === 'flow' && (narrow
        ? <div className="grid justify-items-center gap-2 p-8 text-center text-muted-foreground"><Monitor size={26} aria-hidden /><p>Open on a larger screen to edit the flow.</p>{simple && <Button variant="outline" onClick={() => setMode('simple')}>Use the Simple view</Button>}</div>
        : <div className="flex min-h-[480px] min-w-0 grow">
            <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
              <Canvas flow={doc.flow} options={o} errors={errors} readOnly={readOnly} edit={(flow, key) => hist.set({ flow }, key)} drag={(flow) => hist.set({ flow }, undefined, false)} checkpoint={hist.checkpoint} />
            </Suspense>
          </div>)}

      {access && <Dialog title="Attachments and access" side onClose={() => setAccess(false)}><fieldset disabled={readOnly} className="grid gap-4">{rules}</fieldset></Dialog>}
      {leave && <ConfirmDialog title="Leave without saving?" body="Your changes to this Assistant have not been saved." action="Leave" onConfirm={() => (location.href = '/assistants')} onClose={() => setLeave(false)} />}
    </div>
    </ToolsCtx.Provider>
  );
}
