import { ArrowLeft, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { emptyDraft, type Draft } from '../../../../src/assistants/draft';
import { can, useQuery, type Me } from '../api';
import { ConfirmDialog } from '../dialogs';
import { IconView } from '../IconPicker';
import Shell, { Hint } from '../Shell';
import { toast } from '../toast';
import { Chip, Err, Loading } from '../ui';
import { Diagram } from './Diagram';
import { ProcessDiagram } from './ProcessDiagram';
import { FilesTab } from './Files';
import { IgnoredNotice, ImportMenu } from './Import';
import { SettingsDialog } from './Settings';
import { TestPanel } from './TestPanel';
import { BuildPanel, useCreator, type DraftIn, type Read } from './creator';
import { defaultInputs, type Inputs } from './parts';

// An Assistant is a folder of files (assistant.json, instructions.md, skills, MCP, helpers, anything else). The editor shows what the files say and what they use (the diagram);
// the right side changes them: "Build with chat" (a CLI agent edits the draft's files, creator.tsx) and "Test" (a throwaway chat on the draft, TestPanel.tsx). Import fills the draft from a repository or a zip.
const rpc = trpc;

interface Meta { id?: string; owner: 'me' | 'team'; scope: string; simple: boolean }
/** What the files do not hold: kept as saved and sent back with the draft. */
interface Extra { inputs: Inputs; roles: string[]; provider: string | null; model: string | null; thinking: string | null }
// The open draft survives a reload: its id (and the agent that builds it) stay in this browser until the draft is saved away or thrown out.
const LS = (id: string) => `hefyn:assistant-draft:${id}`;
export const IGNORED = 'hefyn:assistant-import-ignored';
interface Stored { draftId: string; agent?: string }
const readStored = (id: string): Stored | undefined => { try { return JSON.parse(localStorage.getItem(LS(id)) ?? 'null') ?? undefined; } catch { return undefined; } };
const newDraftId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
const key = (r: Pick<Read, 'draft' | 'files' | 'bundledSkills'>) => JSON.stringify({ ...r, draft: { ...r.draft, newSkills: undefined } });

export default function AssistantEditor() {
  // a same-document hash change (#a_123 -> #new) fires no reload, so remount Body or it keeps the old Assistant's id and draft; a counter, not the hash value, because replaceState after a first save
  // changes the hash without an event, so navigating back to the old value (#new) must still remount; replaceState itself fires no hashchange, so that Body stays
  const [n, setN] = useState(0);
  useEffect(() => { const f = () => setN((x) => x + 1); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return <Shell title="Assistant">{(me) => <Body key={n} me={me} />}</Shell>;
}

function Body({ me }: { me: Me }) {
  const id = location.hash.slice(1) || 'new';
  const options = useQuery(() => rpc.assistants.options.query());
  const [seed, setSeed] = useState<Draft>();
  const [first, setFirst] = useState<Read>(); // the stored Assistant's files, for the view before the chat has read anything
  const [extra, setExtra] = useState<Extra>({ inputs: defaultInputs(), roles: [], provider: null, model: null, thinking: null });
  const [meta, setMeta] = useState<Meta>({ owner: 'me', simple: true, scope: new URLSearchParams(location.search).get('scope') === 'team' && can(me, 'assistants.manage') ? 'team' : 'private' });
  const [savedKey, setSavedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [stored] = useState(() => readStored(id));
  const [draftId] = useState(() => stored?.draftId ?? newDraftId());
  const [tab, setTab] = useState<'build' | 'test'>('build');
  const [seen, setSeen] = useState({ build: true, test: false }); // a tab starts its chat the first time it opens
  const [ignored, setIgnored] = useState<string[]>(() => { try { const s = JSON.parse(sessionStorage.getItem(IGNORED) ?? '[]'); sessionStorage.removeItem(IGNORED); return s; } catch { return []; } });
  const [ask, setAsk] = useState<'leave' | 'discard'>();
  const [settings, setSettings] = useState(false);
  const [left, setLeft] = useState<'overview' | 'files'>('overview');
  const [file, setFile] = useState<string>();
  const [filesDirty, setFilesDirty] = useState(false);
  const [leaveFiles, setLeaveFiles] = useState<'overview' | 'files'>();
  const openFile = (p: string) => { setFile(p); setLeft('files'); };

  useEffect(() => {
    if (id === 'new') { setSeed(emptyDraft()); return; }
    rpc.assistants.get.query({ id }).then((a) => {
      const d: Draft = { name: a.name, description: a.description ?? '', icon: a.icon || 'Sparkles', agent: a.agent, instructions: a.instructions, skills: a.skills, newSkills: [], mcp: a.mcp ?? [], helpers: a.helpers ?? [] };
      const r = { draft: d, errors: a.errors ?? [], files: a.files ?? [], bundledSkills: a.bundledSkills ?? [], process: a.process };
      setSeed(d); setFirst(r); setSavedKey(key(r));
      setExtra({ inputs: a.inputs ?? defaultInputs(), roles: a.roles ?? [], provider: a.provider ?? null, model: a.model ?? null, thinking: a.thinking ?? null });
      setMeta((m) => ({ ...m, id: a.id, owner: a.owner, scope: a.scope, simple: a.simple }));
    }).catch((x: Error) => setFailed(x.message));
  }, [id]);

  // a new Assistant runs on the first agent that can run (Claude Code) until the chat or the files name another
  useEffect(() => {
    if (id !== 'new' || !seed || seed.agent || !options.data) return;
    const a = options.data.agents.find((x) => x.providers?.some((p) => p.connected)) ?? options.data.agents[0];
    if (!a) return;
    const d = { ...seed, agent: a.id };
    setSeed(d); setSavedKey(key({ draft: d, files: [], bundledSkills: [] }));
  }, [id, seed, options.data]);

  const creator = useCreator({ draftId, seed: seed ?? emptyDraft(), agent: stored?.agent, assistantId: meta.id, options: options.data ?? { agents: [], models: {}, thinking: [], skills: [] } });
  useEffect(() => { if (creator.chat) localStorage.setItem(LS(id), JSON.stringify({ draftId, agent: creator.chat.agent } satisfies Stored)); }, [creator.chat?.id]);
  // the test chats go when the page closes; the creator stays so a reload picks the draft up again (the server sweeps old ones)
  useEffect(() => {
    const f = () => void fetch('/api/trpc/assistants.draft.discard', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftId, keepCreator: true }) }).catch(() => {});
    addEventListener('pagehide', f); return () => removeEventListener('pagehide', f);
  }, [draftId]);

  if (failed) return <div className="p-6"><Err>{failed}</Err><Button variant="outline" className="mt-3" onClick={() => (location.href = '/assistants')}>Back to Assistants</Button></div>;
  // a new draft waits for its default agent: the build panel's effect seeds the folder before the effect above runs
  if (!seed || !options.data || (id === 'new' && !seed.agent && options.data.agents.length > 0)) return <div className="p-6 text-muted-foreground">{options.error ? <Err>{options.error}</Err> : <Loading n={5} />}</div>;
  const o = options.data;
  const view: Read = creator.read ?? first ?? { draft: seed, errors: [], files: [], bundledSkills: [] };
  const d = view.draft;
  const readOnly = (meta.owner === 'team' && !can(me, 'assistants.manage')) || !meta.simple;
  const chat = !readOnly && o.agents.length > 0;
  const dirty = key(view) !== savedKey;
  const form: DraftIn = { ...d, provider: extra.provider, model: extra.model, thinking: extra.thinking };

  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc.assistants.save.mutate({ ...(meta.id && { id: meta.id }), draftId, name: d.name, description: d.description, icon: d.icon, inputs: extra.inputs, roles: extra.roles, agent: d.agent,
        provider: extra.provider, model: extra.model, thinking: extra.thinking, instructions: d.instructions, skills: d.skills, mcp: d.mcp, helpers: d.helpers, ...(!meta.id && { scope: meta.scope === 'team' ? 'team' as const : 'private' as const }) });
      setSavedKey(key(view));
      if (!meta.id) {
        setMeta((m) => ({ ...m, id: r.id }));
        const s = localStorage.getItem(LS('new')); if (s) { localStorage.setItem(LS(r.id), s); localStorage.removeItem(LS('new')); }
        history.replaceState(null, '', `${location.pathname}${location.search}#${r.id}`);
      }
      toast('Saved');
    } catch (x) { toast((x as Error).message, true); } finally { setBusy(false); }
  };
  const throwOut = async (keepCreator: boolean) => { await rpc.assistants.draft.discard.mutate({ draftId, keepCreator }).catch(() => {}); if (!keepCreator) localStorage.removeItem(LS(id)); };
  const leave = async () => { await throwOut(!meta.id && (!!d.name || view.files.length > 0)); location.href = '/assistants'; };
  const back = () => (meta.id && dirty ? setAsk('leave') : void leave());
  const imported = (r: { ignored: string[] }) => { setIgnored(r.ignored); void creator.ensure().then(() => creator.refresh()).catch(() => {}); };

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Hint label="Back to Assistants"><Button variant="ghost" size="icon" aria-label="Back to Assistants" onClick={back}><ArrowLeft size={16} aria-hidden /></Button></Hint>
        <h1 className="min-w-0 truncate text-[15px] leading-6 font-semibold">{d.name || (meta.id ? 'Assistant' : 'New Assistant')}</h1>
        {meta.scope === 'team' ? <Chip tone="blue">Team</Chip> : <Chip>Private</Chip>}
        {dirty && !readOnly && <span className="text-xs text-muted-foreground">Not saved yet</span>}
        {!readOnly && <div className="ml-auto flex flex-wrap items-center gap-1">
          <ImportMenu draftId={draftId} agent={creator.agent} onDone={imported} />
          {meta.id && <Button variant="outline" onClick={() => setSettings(true)}><Settings size={15} aria-hidden />Settings</Button>}
          <Button variant="ghost" onClick={() => setAsk('discard')}>Discard</Button>
          <Button disabled={busy || !dirty || !creator.read || !d.name.trim() || !d.agent} onClick={save}>Save</Button>
        </div>}
      </header>
      {!meta.simple && <p role="status" className="border-b border-border px-4 py-2 text-[13px] text-muted-foreground">This Assistant was built with the retired flow builder. It can not start new chats. Convert it to a simple Assistant from the list.</p>}
      {meta.simple && readOnly && <p role="status" className="border-b border-border px-4 py-2 text-[13px] text-muted-foreground">This is a team Assistant. You can look at it; an admin changes it.</p>}
      {ignored.length > 0 && <IgnoredNotice paths={ignored} onDismiss={() => setIgnored([])} />}
      <div className={`grid min-h-0 grow ${chat ? 'lg:grid-cols-2' : ''}`}>
        <div className="min-h-0 min-w-0 overflow-y-auto">
          <div className={`mx-auto grid w-full content-start gap-4 px-5 py-5 ${left === 'files' ? '' : 'max-w-4xl'}`}>
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted"><IconView value={d.icon} size={20} /></div>
              <div className="min-w-0">
                <h2 className="text-base leading-6 font-semibold break-words">{d.name || 'No title yet'}</h2>
                <p className="text-[13px] leading-5 break-words text-muted-foreground">{d.description || 'No description yet.'}</p>
              </div>
            </div>
            <Tabs value={left} onValueChange={(v) => { if (filesDirty) setLeaveFiles(v as 'overview' | 'files'); else setLeft(v as 'overview' | 'files'); }}>
              <TabsList aria-label="Overview or files"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="files">Files</TabsTrigger></TabsList>
            </Tabs>
            {left === 'overview' ? <>
              {view.errors.length > 0 && (
                <div role="status" className="rounded-md border border-border bg-muted/40 px-4 py-2 text-[13px]">
                  Left out because it can not be used:
                  <ul className="list-disc pl-4 text-muted-foreground">{view.errors.map((e) => <li key={e} className="break-words">{e}</li>)}</ul>
                </div>
              )}
              {view.process && <ProcessDiagram process={view.process} onOpen={openFile} />}
              <Diagram data={{ agent: d.agent, skills: d.skills, bundledSkills: view.bundledSkills, mcp: d.mcp, helpers: d.helpers, files: view.files, instructions: d.instructions }} options={o} onOpen={openFile} title={view.process ? 'What it uses' : undefined} />
            </> : <FilesTab draftId={draftId} id={chat ? undefined : meta.id} ready={chat ? !!creator.chat : !!meta.id} selected={file} onSelect={setFile} readOnly={readOnly} onChanged={() => void creator.refresh()} onDirty={setFilesDirty} />}
            {leaveFiles && <ConfirmDialog title="Discard unsaved changes?" body="Your edits to the open file have not been saved." action="Discard" onClose={() => setLeaveFiles(undefined)} onConfirm={() => { setFilesDirty(false); setLeft(leaveFiles); }} />}
          </div>
        </div>
        {chat && (
          <div className="flex min-h-[28rem] min-w-0 flex-col border-t border-border lg:min-h-0 lg:border-t-0 lg:border-l">
            <div className="flex items-center border-b border-border px-3 py-2">
              <Tabs value={tab} onValueChange={(v) => { setTab(v as 'build' | 'test'); setSeen((s) => ({ ...s, [v as string]: true })); }}>
                <TabsList aria-label="Build or test"><TabsTrigger value="build">Build with chat</TabsTrigger><TabsTrigger value="test">Test</TabsTrigger></TabsList>
              </Tabs>
            </div>
            <div className={tab === 'build' ? 'flex min-h-0 grow flex-col' : 'hidden'}>
              {seen.build && <BuildPanel creator={creator} options={o} />}
            </div>
            <div className={tab === 'test' ? 'flex min-h-0 grow flex-col' : 'hidden'}>
              {seen.test && <TestPanel draftId={draftId} form={form} options={o} assistantId={meta.id} scope={meta.scope === 'team' ? 'team' : 'private'}
                onImprove={(text) => { setTab('build'); void creator.send(text).then(() => toast('Sent to the chat'), (x: Error) => toast(x.message, true)); }} />}
            </div>
          </div>
        )}
      </div>
      {settings && meta.id && <SettingsDialog id={meta.id} onClose={() => setSettings(false)} onSaved={() => location.reload()} />}
      {ask === 'leave' && <ConfirmDialog title="Leave without saving?" body="Changes made in the chat since the last save are lost." action="Leave" onConfirm={() => void leave()} onClose={() => setAsk(undefined)} />}
      {ask === 'discard' && <ConfirmDialog title="Discard this draft?" body={meta.id ? 'The files go back to the last saved version.' : 'The draft and its files are removed.'} action="Discard"
        onConfirm={() => void throwOut(false).then(() => location.reload())} onClose={() => setAsk(undefined)} />}
    </div>
  );
}
