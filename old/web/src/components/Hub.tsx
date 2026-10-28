import { Blocks, BookOpen, Bot, CircleCheck, ChevronDown, Copy, ExternalLink, FileText, Layers, Link2, Package, PackageCheck, Plug, Plus, Search, Star, Store, TriangleAlert, UserRound, Workflow, X } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { api, can, refreshModules, useLoad, useQuery, type Me } from './api';
import { trpc } from '@/lib/trpc';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Separator } from '@/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { MenuArea } from './AppMenu';
import { ConfirmDialog, Dialog } from './dialogs';
import { Md } from './markdown';
import { toast } from './toast';
import { EffortSelect } from './effort';
import Picker from './model-picker';
import { buttonDanger, Chip, Empty, Err, Field, Input, Page, Select, Textarea, type Tone } from './ui';

// Contract: docs/HUB-API.md
export type Kind = 'skill' | 'agent' | 'mcp' | 'bundle' | 'module' | 'assistant';
export interface Pkg {
  id: string; kind: Kind; name: string; description: string; version: string; hash: string;
  source: { type: 'ui' | 'git' | 'marketplace' | 'mcp-registry'; url?: string; ref?: string };
  visibility: 'private' | 'team'; status: 'draft' | 'pending' | 'approved' | 'rejected'; rejectReason?: string;
  owner: { id: string; name: string }; installed: { me: boolean; team: boolean };
  guard: { flagged: boolean; reasons: string[] }; contains?: { skills: string[]; agents: string[]; mcp: string[] };
  createdAt: string; updatedAt: string; storage?: boolean;
}
export interface Detail extends Pkg { manifest: Record<string, any> & { ignored?: (string | { path: string })[] }; files: { path: string; size: number }[]; readme?: string }

export const KIND: Record<Kind, { label: string; plural: string; Icon: typeof Package }> = {
  skill: { label: 'Skill', plural: 'Skills', Icon: BookOpen }, agent: { label: 'Agent', plural: 'Agents', Icon: Bot },
  mcp: { label: 'MCP server', plural: 'MCP servers', Icon: Plug }, bundle: { label: 'Plugin', plural: 'Plugins', Icon: Package },
  module: { label: 'Module', plural: 'Modules', Icon: Blocks }, assistant: { label: 'Assistant', plural: 'Assistants', Icon: Workflow },
};
const SOURCE = { ui: 'Created in hefyn', git: 'Git link', marketplace: 'Marketplace', 'mcp-registry': 'MCP Registry' };
const STATUS: Record<Pkg['status'], [string, Tone]> = { draft: ['Draft', 'neutral'], pending: ['Waiting for review', 'blue'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'alarm'] };
const q = encodeURIComponent;
const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;

export const KindIcon = ({ kind, size = 20 }: { kind: Kind; size?: number }) => { const { Icon } = KIND[kind]; return <Icon size={size} aria-hidden />; };
export const Flagged = ({ pkg }: { pkg: Pkg }) => pkg.guard.flagged ? <span title={pkg.guard.reasons.join(' ')}><Chip tone="caution"><TriangleAlert size={12} aria-hidden />Flagged</Chip></span> : null;
export const StatusBadge = ({ pkg }: { pkg: Pkg }) => <Chip tone={STATUS[pkg.status][1]}>{STATUS[pkg.status][0]}</Chip>;

type Tab = 'browse' | 'mine' | 'installed';
type KindFilter = '' | Kind;

export default function Hub() {
  const [open, setOpen] = useState(location.hash.slice(1));
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState<Detail>();
  useEffect(() => { const f = () => setOpen(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const close = () => { history.replaceState(null, '', location.pathname + location.search); setOpen(''); };
  const reload = () => setTick((t) => t + 1);
  return (
    <Shell title="Hub" panelOpen={!!open} onPanelClose={close}
      panel={(me) => <DetailPanel id={open} me={me} onClose={close} onChange={reload} onEdit={(d) => { close(); setEdit(d); }} />}>
      {(me) => (<>
        <Content me={me} tick={tick} onChange={reload} />
        {edit && <Dialog title={`Edit ${edit.name}`} xl onClose={() => setEdit(undefined)}><CreateForm initial={edit} onDone={() => { setEdit(undefined); reload(); }} onCancel={() => setEdit(undefined)} /></Dialog>}
      </>)}
    </Shell>
  );
}

function Content({ me, tick, onChange }: { me: Me; tick: number; onChange: () => void }) {
  const [tab, setTab] = useState<Tab>('browse');
  const [kind, setKind] = useState<KindFilter>('');
  const [text, setText] = useState(new URLSearchParams(location.search).get('q') ?? '');
  const [term, setTerm] = useState(text);
  const [adding, setAdding] = useState<'' | 'skill' | 'agent' | 'mcp'>('');
  useEffect(() => { const t = setTimeout(() => setTerm(text), 250); return () => clearTimeout(t); }, [text]);
  const list = useQuery(() => trpc.hub.list.query({ q: term, kind, ...(tab === 'mine' ? { mine: true } : { status: 'approved' }) }), [term, kind, tab, tick]);
  const inst = useQuery(() => trpc.hub.installed.query(), [tick]);
  const installedAll = [...new Map([...(inst.data?.team ?? []), ...(inst.data?.me ?? [])].map((p) => [p.id, p])).values()]
    .filter((p) => (!kind || p.kind === kind) && `${p.name} ${p.description}`.toLowerCase().includes(term.toLowerCase()));
  const items = tab === 'installed' ? installedAll : list.data?.filter((p) => tab === 'mine' ? p.owner.id === me.id : true);

  return (
    <Page wide title="Hub" hint="Skills, MCP servers and plugins your team can add in one click."
      actions={<div className="flex flex-wrap gap-2">{can(me, 'hub.approve') && <Button variant="outline" nativeButton={false} render={<a href="/hub/review" />}><PackageCheck size={14} aria-hidden />Review</Button>}
        {can(me, 'hub.install') && <>
          <Button variant="outline" onClick={() => setAdding('mcp')}><Plug size={14} aria-hidden />Add MCP server</Button>
          <Button onClick={() => setAdding('skill')}><Plus size={14} aria-hidden />Add skill</Button></>}</div>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList aria-label="Hub">
            {([['browse', 'Browse', Store], ['mine', 'Mine', UserRound], ['installed', 'Installed', CircleCheck]] as const).map(([t, l, Icon]) => <TabsTrigger key={t} value={t} className="px-2.5 text-[13px]"><Icon size={14} aria-hidden />{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <Separator orientation="vertical" className="mx-1 h-5 max-sm:hidden" />
        <Tabs value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
          <TabsList aria-label="Type" className="flex-wrap">
            {([['', 'All'], ['skill', 'Skills'], ['mcp', 'MCP servers'], ['bundle', 'Plugins'], ['module', 'Modules']] as const).map(([k, l]) => <TabsTrigger key={k} value={k} className="px-2.5 text-[13px]">{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </div>
      <label className="relative mb-4 block"><span className="sr-only">Search packages</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" type="search" placeholder="Search the hub" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Err>{list.error}</Err>
      {items && !items.length ? <Empty icon={<Package size={28} />}>{tab === 'mine' ? 'You have not added anything yet. Choose Add skill or Add MCP server to start.' : tab === 'installed' ? 'Nothing is installed yet. Browse the hub to add skills, MCP servers and plugins.' : 'No packages match your search.'}</Empty> : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">{items?.map((p) => <PackageRow key={p.id} pkg={p} me={me} showStatus={tab === 'mine'} onChange={onChange} />)}</ul>
      )}
      {adding === 'skill' && <SkillDialog onClose={() => setAdding('')} onDone={() => { setAdding(''); onChange(); }} />}
      {adding === 'mcp' && <McpDialog onClose={() => setAdding('')} onDone={() => { setAdding(''); onChange(); }} />}
    </Page>
  );
}

// One-click install; a menu with "For me" / "For the team" when the user may install for the team.
const installGo = async (pkg: Pkg, target: 'me' | 'team', onChange: () => void) => {
  try { await trpc.hub.install.mutate({ id: pkg.id, target }); pkg.kind === 'mcp' ? toast(`Installed ${pkg.name}`, false, pkg.storage ? { href: '/settings/storage', label: 'Sign in, then use as storage' } : { href: '/settings/connectors', label: 'Sign in in Connectors' }) : toast(`Installed ${pkg.name}`); pkg.kind === 'module' && refreshModules(); onChange(); } catch (x) { toast((x as Error).message, true); }
};
// Which targets the user may install a package to (same rules as the Install button).
const installTargets = (pkg: Pkg, me: Me): ('me' | 'team')[] => {
  const mineOnly = pkg.owner.id === me.id && pkg.status !== 'approved';
  if (!can(me, 'hub.install') || (pkg.status !== 'approved' && !mineOnly)) return [];
  if (pkg.kind === 'module') return pkg.status === 'approved' && can(me, 'modules.manage') ? ['team'] : []; // modules are team-wide, Admin only
  return can(me, 'profiles.edit_team') && pkg.status === 'approved' ? ['me', 'team'] : ['me'];
};

export function InstallMenu({ pkg, me, onChange }: { pkg: Pkg; me: Me; onChange: () => void }) {
  const targets = installTargets(pkg, me);
  const go = (target: 'me' | 'team') => installGo(pkg, target, onChange);
  if (!targets.length) return null;
  if (pkg.kind === 'module') return <Button onClick={() => go('team')}>Install for the team</Button>;
  if (targets.length === 1) return <Button onClick={() => go('me')}>Install</Button>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button />}>Install<ChevronDown size={14} aria-hidden /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {(['me', 'team'] as const).map((t) => <DropdownMenuItem key={t} className="px-2.5 py-2" onClick={() => go(t)}>{t === 'me' ? 'Install for me' : 'Install for the team'}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PackageRow({ pkg, me, showStatus, onChange }: { pkg: Pkg; me: Me; showStatus: boolean; onChange: () => void }) {
  const installed = pkg.installed.me || pkg.installed.team;
  const targets = installed ? [] : installTargets(pkg, me);
  const actions = () => (<>
    <DropdownMenuItem className="text-[13px]" onClick={() => { location.hash = pkg.id; }}><ExternalLink {...ico} />Open details</DropdownMenuItem>
    {targets.map((t) => <DropdownMenuItem key={t} className="text-[13px]" onClick={() => installGo(pkg, t, onChange)}><Plus {...ico} />{t === 'me' ? (targets.length > 1 ? 'Install for me' : 'Install') : 'Install for the team'}</DropdownMenuItem>)}
    <DropdownMenuItem className="text-[13px]" onClick={() => navigator.clipboard.writeText(pkg.name).then(() => toast('Name copied'), () => toast('Copy failed', true))}><Copy {...ico} />Copy name</DropdownMenuItem>
  </>);
  return (
    <MenuArea items={actions}>
    <li className="flex items-center gap-4 px-4 py-3.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-muted-foreground"><KindIcon kind={pkg.kind} /></span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2"><a href={`#${pkg.id}`} className="font-medium hover:underline">{pkg.name}</a>
          <Flagged pkg={pkg} />{showStatus && <StatusBadge pkg={pkg} />}{installed && <Chip tone="blue">{pkg.installed.team ? 'Installed for team' : 'Installed'}</Chip>}</div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.description}</p>
        {showStatus && pkg.status === 'rejected' && pkg.rejectReason && <p className="mt-0.5 truncate text-xs text-danger-ink" title={pkg.rejectReason}>Rejected: {pkg.rejectReason}</p>}
        <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground"><span>{SOURCE[pkg.source.type]}</span><span>Version {pkg.version}</span><span>By {pkg.owner.name}</span></p>
      </div>
      {!installed && <InstallMenu pkg={pkg} me={me} onChange={onChange} />}
    </li>
    </MenuArea>
  );
}

// Leading YAML frontmatter -> compact key/value pairs (flat `key: value` lines only), rest is the body.
function splitFrontmatter(t: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  if (!m) return { meta: [] as [string, string][], body: t };
  const meta = m[1].split(/\r?\n/).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1], x[2].replace(/^["']|["']$/g, '')] as [string, string]);
  return { meta, body: t.slice(m[0].length) };
}

// Plain-text file viewer: markdown rendered, everything else as text. Never HTML.
export function FileBrowser({ id, files }: { id: string; files: { path: string; size: number }[] }) {
  const [sel, setSel] = useState<string>();
  const [text, setText] = useState('');
  useEffect(() => {
    if (!sel) return;
    setText('Loading…');
    trpc.hub.file.query({ id, path: sel }).then(setText,() => setText('Could not load file.'));
  }, [sel]);
  if (!files.length) return <p className="text-sm text-muted-foreground">No files.</p>;
  return (
    <div className="grid gap-2">
      <ul className="max-h-64 overflow-auto rounded-lg border text-sm" aria-label="Files">
        {files.map((f) => <li key={f.path}><button onClick={() => setSel(f.path)} aria-current={sel === f.path} className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-foreground/5 ${sel === f.path ? 'bg-foreground/10' : ''}`}><FileText size={13} aria-hidden className="shrink-0 text-muted-foreground" /><span className="truncate">{f.path}</span></button></li>)}
      </ul>
      <div className="max-h-64 min-w-0 overflow-auto rounded-lg border bg-foreground/[0.06] p-3">
        {!sel ? <p className="text-sm text-muted-foreground">Select a file to view it.</p>
          : /\.md$/i.test(sel) ? (() => { const { meta, body } = splitFrontmatter(text); return <div className="text-sm">
            {meta.length > 0 && <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border bg-raised px-3 py-2 text-xs">{meta.map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}</dl>}
            <Md>{body}</Md></div>; })()
          : <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>}
      </div>
    </div>
  );
}

const ignoredPath = (i: string | { path: string }) => (typeof i === 'string' ? i : i.path);

function DetailPanel({ id, me, onClose, onChange, onEdit }: { id: string; me: Me; onClose: () => void; onChange: () => void; onEdit: (d: Detail) => void }) {
  const { data: d, error, reload } = useQuery(() => trpc.hub.get.query({ id }), [id]);
  const [del, setDel] = useState(false);
  const mine = d?.owner.id === me.id;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { const r = await fn(); toast(typeof ok === 'string' ? ok : ok); reload(); onChange(); return r; } catch (x) { toast((x as Error).message, true); } };
  const ignored = d?.manifest?.ignored ?? [];
  const actions = d && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {mine && d.source.type === 'ui' && <Button variant="outline" onClick={() => onEdit(d)}>Edit</Button>}
            {mine && can(me, 'hub.publish') && d.visibility === 'private' && d.status !== 'pending' && <Button variant="outline" onClick={async () => { try { const r = await trpc.hub.publish.mutate({ id: d.id }); toast(r?.status === 'pending' ? 'Sent for review' : 'Shared with the team'); reload(); onChange(); } catch (x) { toast((x as Error).message, true); } }}>Share with team</Button>}
            {(mine || can(me, 'hub.approve')) && <Button variant="outline" className={buttonDanger} onClick={() => setDel(true)}>Delete</Button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(['me', 'team'] as const).filter((t) => d.installed[t] && (t === 'me' || can(me, 'profiles.edit_team'))).map((t) => (
              <Button key={t} variant="outline" onClick={() => act(() => trpc.hub.uninstall.mutate({ id: d.id, target: t }), 'Uninstalled')}>Uninstall{t === 'team' ? ' for the team' : ''}</Button>))}
            {!d.installed.me && <InstallMenu pkg={d} me={me} onChange={() => { reload(); onChange(); }} />}
          </div>
        </div>
  );
  const H = ({ children }: { children: string }) => <h3 className="text-sm font-semibold">{children}</h3>;
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-4"><h2 className="truncate text-sm font-medium">{d?.name ?? 'Package'}</h2>
        <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Close details" onClick={onClose}><X size={16} /></Button></div>
      <div className="grid min-h-0 grow content-start gap-4 overflow-y-auto p-4">
      <Err>{error}</Err>
      {d && <>
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><KindIcon kind={d.kind} size={15} />{KIND[d.kind].label}</span><span>Version {d.version}</span><span>By {d.owner.name}</span>
        </div>
        <div className="flex flex-wrap gap-1.5"><StatusBadge pkg={d} /><Flagged pkg={d} />{d.installed.me && <Chip tone="blue">Installed for me</Chip>}{d.installed.team && <Chip tone="blue">Installed for the team</Chip>}</div>
        <p className="text-sm leading-[22px]">{d.description}</p>
        {d.status === 'rejected' && d.rejectReason && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">Rejected: {d.rejectReason}</p>}
        <section className="grid gap-1"><H>Safety check</H>
          {d.guard.flagged ? <div className="rounded-lg bg-warning/15 px-3 py-2 text-sm"><b className="flex items-center gap-1.5 text-warning-ink"><TriangleAlert size={14} aria-hidden />The prompt-injection guard flagged this package</b>
            <ul className="mt-1 list-disc pl-5">{d.guard.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            : <p className="text-sm text-muted-foreground">The prompt-injection guard found nothing.</p>}</section>
        {d.contains && (
          <section className="grid gap-2"><H>What is inside</H>
            <div className="grid gap-3">
              {(['skills', 'agents', 'mcp'] as const).map((k) => <div key={k}><div className="mb-1 text-sm text-muted-foreground">{k === 'mcp' ? 'MCP servers' : k === 'skills' ? 'Skills' : 'Agents'}</div>
                {d.contains![k].length ? <ul className="grid gap-0.5">{d.contains![k].map((n) => <li key={n} className="truncate font-mono text-[13px]">{n}</li>)}</ul> : <span className="text-sm text-muted-foreground">None</span>}</div>)}
            </div>
          </section>
        )}
        {ignored.length > 0 && (
          <section className="grid gap-1 opacity-75"><H>Not installed</H>
            <p className="text-sm text-muted-foreground">Hooks and commands can run code, so hefyn never installs them. They are listed so you can see what the author included.</p>
            <ul className="grid gap-0.5 font-mono text-[13px] text-muted-foreground line-through">{ignored.map((i) => <li key={ignoredPath(i)}>{ignoredPath(i)}</li>)}</ul>
          </section>
        )}
        {d.readme && <section className="grid gap-1"><H>Readme</H><div className="max-h-60 overflow-auto text-sm"><Md>{d.readme}</Md></div></section>}
        <section className="grid gap-2"><H>Files</H><FileBrowser id={d.id} files={d.files} /></section>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Source</dt><dd>{SOURCE[d.source.type]}{d.source.url && <> <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 break-all" href={d.source.url} target="_blank" rel="noreferrer">{d.source.url}{d.source.ref && ` at ${d.source.ref}`}<ExternalLink size={11} aria-hidden /></a></>}</dd>
          <dt className="text-muted-foreground">Hash</dt><dd className="font-mono text-[13px] break-all">{d.hash}</dd>
          <dt className="text-muted-foreground">Updated</dt><dd>{new Date(d.updatedAt).toLocaleString()}</dd>
        </dl>
      </>}
      </div>
      {d && <div className="shrink-0 border-t border-border px-4 py-3">{actions}</div>}
      {del && d && <ConfirmDialog title={`Delete ${d.name}?`} body="It is removed from the hub and from everyone who installed it." action="Delete" onClose={() => setDel(false)}
        onConfirm={() => act(() => trpc.hub.delete.mutate({ id: d.id }), 'Deleted').then(onClose)} />}
    </>
  );
}

// ---- Add to hub ----
interface RegistryHit { name: string; description: string; url: string; transport: string; repository?: string }

// Everything lands private. Skills and agents that pass the guard are also installed for the user, so "Add" is the whole job.
interface Added { pkgs: Pkg[]; installed: string[] }
async function installMine(pkgs: Pkg[]): Promise<Added> {
  const installed: string[] = [];
  for (const p of pkgs) {
    if ((p.kind !== 'skill' && p.kind !== 'agent') || p.guard.flagged) continue;
    try { await trpc.hub.install.mutate({ id: p.id, target: 'me' }); installed.push(p.id); } catch { /* stays a private draft; Open shows it */ }
  }
  return { pkgs, installed };
}

function SkillDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'search' | 'link' | 'write'>('search');
  const [added, setAdded] = useState<Added>();
  return (
    <Dialog title="Add skill" xl onClose={onClose}>
      {added ? <Outcome added={added} onDone={onDone} /> : <>
        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="-mt-2">
          <TabsList variant="line" aria-label="How to add a skill">
            {([['search', 'Search'], ['link', 'From a link'], ['write', 'Write one']] as const).map(([m, l]) => <TabsTrigger key={m} value={m} className="px-3">{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        {mode === 'search' && <SkillSearch onAdded={setAdded} />}
        {mode === 'link' && <LinkImport onAdded={setAdded} />}
        {mode === 'write' && <CreateForm kinds={['skill']} onDone={onDone} onCancel={onClose} />}
      </>}
    </Dialog>
  );
}

function McpDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'registry' | 'create'>('registry');
  const [added, setAdded] = useState<Added>();
  return (
    <Dialog title="Add MCP server" xl onClose={onClose}>
      {added ? <Outcome added={added} onDone={onDone} /> : <>
        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="-mt-2">
          <TabsList variant="line" aria-label="How to add an MCP server">
            {([['registry', 'MCP Registry'], ['create', 'Enter a URL']] as const).map(([m, l]) => <TabsTrigger key={m} value={m} className="px-3">{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        {mode === 'registry' && <RegistrySearch onAdded={setAdded} />}
        {mode === 'create' && <CreateForm kinds={['mcp']} onDone={onDone} onCancel={onClose} />}
      </>}
    </Dialog>
  );
}

function Outcome({ added: { pkgs, installed }, onDone }: { added: Added; onDone: () => void }) {
  const flagged = pkgs.filter((p) => p.guard.flagged).length;
  return (
    <div className="grid gap-2">
      <p className={`text-sm ${flagged ? 'text-warning-ink' : 'text-success-ink'}`} role="status">
        {installed.length ? `Added ${installed.length === 1 ? 'and installed it' : `${installed.length} packages and installed them`} for you.` : `Added ${pkgs.length === 1 ? '1 package' : `${pkgs.length} packages`} as private ${pkgs.length === 1 ? 'draft' : 'drafts'}.`}
        {flagged > 0 && ' The safety check flagged some content, so it is not installed. Open it to look before you decide.'} Share it with the team from its page when you want others to use it.
      </p>
      <ul className="grid gap-1.5">{pkgs.map((p) => <li key={p.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><KindIcon kind={p.kind} size={16} /><span className="font-medium">{p.name}</span><Flagged pkg={p} />{installed.includes(p.id) && <Chip tone="blue">Installed</Chip>}<a className="ml-auto text-foreground underline underline-offset-2" href={`#${p.id}`} onClick={onDone}>Open</a></li>)}</ul>
      <div className="flex justify-end"><Button onClick={onDone}>Done</Button></div>
    </div>
  );
}

interface SkillHit { id: string; name: string; author: string; description: string; stars: number; updatedAt: string; githubUrl: string; skillUrl: string }

// SkillsMP search (the server proxies it and caches identical queries); the debounce is long because the free quota is small.
function SkillSearch({ onAdded }: { onAdded: (a: Added) => void }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SkillHit[]>();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 500); return () => clearTimeout(t); }, [text]);
  useEffect(() => {
    setErr('');
    if (!term) { setHits(undefined); return; }
    let live = true;
    trpc.hub.skillsmpSearch.query({ q: term }).then((r) => live && setHits(r.skills), (x) => live && (setHits(undefined), setErr((x as Error).message)));
    return () => { live = false; };
  }, [term]);
  const add = async (h: SkillHit) => {
    setBusy(h.id); setErr('');
    try { onAdded(await installMine(await trpc.hub.import.mutate({ url: h.githubUrl }))); } catch (x) { setErr((x as Error).message); }
    setBusy('');
  };
  return (
    <div className="grid gap-3">
      <label className="relative block"><span className="sr-only">Search skills on SkillsMP</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" type="search" autoFocus placeholder="Search skills on SkillsMP, e.g. pdf, code review" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Err>{err}</Err>
      {hits && !hits.length && <Empty icon={<Search size={24} />}>No skills found.</Empty>}
      {!hits && !err && <p className="text-sm text-muted-foreground">{term ? 'Searching…' : <>Search the open skill directory <a className="text-foreground underline underline-offset-2" href="https://skillsmp.com" target="_blank" rel="noreferrer">skillsmp.com</a>. Skills are checked by the safety guard and stay private to you until you share them.</>}</p>}
      <ul className="grid max-h-96 gap-1.5 overflow-auto">
        {hits?.map((h) => (
          <li key={h.id} className="flex items-start gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-x-2"><span className="truncate text-sm font-medium">{h.name}</span><span className="text-xs text-muted-foreground">by {h.author}</span></div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{h.description}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground"><span className="inline-flex items-center gap-1"><Star size={11} aria-hidden />{h.stars.toLocaleString()}</span>
                {h.updatedAt && <span>Updated {new Date(h.updatedAt).toLocaleDateString()}</span>}
                <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2" href={h.skillUrl} target="_blank" rel="noreferrer">View on SkillsMP<ExternalLink size={10} aria-hidden /></a></p>
            </div>
            <Button variant="outline" disabled={!!busy} onClick={() => add(h)}>{busy === h.id ? 'Adding…' : 'Add'}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// What a pasted link will import, worked out from the URL alone (the server does the real parsing).
function describeLink(raw: string): { label: string; ok: boolean } | undefined {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return undefined; }
  if (u.protocol !== 'https:') return { label: 'Only https links can be imported.', ok: false };
  const seg = u.pathname.split('/').filter(Boolean);
  if (/^(www\.)?skillsmp\.com$/.test(u.hostname)) return seg.length ? { label: `SkillsMP skill "${decodeURIComponent(seg[seg.length - 1])}": its GitHub source is looked up, then imported.`, ok: true } : undefined;
  if (u.hostname === 'github.com') return seg.length >= 2 ? { label: `GitHub repository ${seg[0]}/${seg[1].replace(/\.git$/, '')}${seg[2] === 'tree' ? `, folder ${seg.slice(4).join('/') || '/'} at ${seg[3]}` : ''}`, ok: true } : undefined;
  const dash = seg.indexOf('-');
  const proj = dash < 0 ? seg : seg.slice(0, dash);
  return proj.length >= 2 ? { label: `GitLab project ${proj.join('/').replace(/\.git$/, '')} on ${u.host}${dash >= 0 && seg[dash + 1] === 'tree' ? `, folder ${seg.slice(dash + 3).join('/') || '/'} at ${seg[dash + 2]}` : ', default branch'} (public projects only)`, ok: true } : undefined;
}

function LinkImport({ onAdded }: { onAdded: (a: Added) => void }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const what = describeLink(url);
  return (
    <form className="grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr(''); setBusy(true);
      try { onAdded(await installMine(await trpc.hub.import.mutate({ url: url.trim() }))); } catch (x) { setErr((x as Error).message); }
      setBusy(false);
    }}>
      <Field label="Link"><Input type="url" required autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo, a GitLab project or a skillsmp.com skill" /></Field>
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground" aria-live="polite">{what && <><Link2 size={14} aria-hidden className="mt-1 shrink-0" /><span className={what.ok ? '' : 'text-danger-ink'}>{what.label}</span></>}
        {!what && 'A repository with skills (SKILL.md), a Claude plugin, agents or .mcp.json also works. Plugin hooks and commands are never installed.'}</p>
      <Err>{err}</Err>
      <div className="flex justify-end"><Button type="submit" disabled={busy || (!!what && !what.ok)}>{busy ? 'Adding…' : 'Add'}</Button></div>
    </form>
  );
}

function RegistrySearch({ onAdded }: { onAdded: (a: Added) => void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<RegistryHit[]>();
  const [err, setErr] = useState('');
  return (
    <div className="grid gap-3">
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); setErr(''); setHits(undefined); try { setHits(await trpc.hub.registrySearch.query({ q: term })); } catch (x) { setErr((x as Error).message); } }}>
        <Input aria-label="Search the MCP Registry" type="search" placeholder="Search the official MCP Registry…" value={term} onChange={(e) => setTerm(e.target.value)} required /><Button type="submit">Search</Button>
      </form>
      <Err>{err}</Err>
      {hits && !hits.length && <Empty icon={<Search size={24} />}>No servers found.</Empty>}
      <ul className="grid max-h-80 gap-1.5 overflow-auto">
        {hits?.map((h) => (
          <li key={h.name} className="flex items-start gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 grow"><div className="truncate text-sm font-medium">{h.name}</div><p className="line-clamp-2 text-xs text-muted-foreground">{h.description}</p><p className="truncate font-mono text-[11px] text-muted-foreground">{h.url} · {h.transport}</p></div>
            <Button variant="outline" onClick={async () => { try { onAdded({ pkgs: [await trpc.hub.registryImport.mutate({ name: h.name })], installed: [] }); } catch (x) { setErr((x as Error).message); } }}>Import</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Create or edit (initial) a skill, agent or MCP server.
function CreateForm({ initial, kinds = ['skill', 'agent', 'mcp'], onDone, onCancel }: { initial?: Detail; kinds?: ('skill' | 'agent' | 'mcp')[]; onDone: () => void; onCancel: () => void }) {
  const m = initial?.manifest ?? {};
  const [kind, setKind] = useState<'skill' | 'agent' | 'mcp'>((initial?.kind as 'skill') ?? kinds[0]!);
  const [thinking, setThinking] = useState<string>(m.thinking ?? '');
  const [instr, setInstr] = useState<string>(m.instructions ?? '');
  const [preview, setPreview] = useState(false);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [skills, setSkills] = useState<string[]>(m.skills ?? []);
  const [auth, setAuth] = useState<string>(m.auth ?? 'none');
  const [err, setErr] = useState('');
  const [model, setModel] = useState<string>(m.model ?? '');
  const models = useQuery(() => trpc.models.available.query());
  const own = useQuery(() => trpc.hub.list.query({ kind: 'skill', mine: true }));
  const inst = useQuery(() => trpc.hub.installed.query());
  const skillNames = [...new Set([...(own.data ?? []), ...(inst.data?.me ?? []), ...(inst.data?.team ?? [])].filter((p) => p.kind === 'skill').map((p) => p.name))];
  return (
    <form className="grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
      const body = kind === 'skill' ? { kind, name: f.name, description: f.description, instructions: instr, files: files.filter((x) => x.path && x.content) }
        : kind === 'agent' ? { kind, name: f.name, description: f.description, instructions: instr, model: f.model || undefined, thinking: thinking || undefined, skills }
        : { kind, name: f.name, description: f.description, url: f.url, transport: f.transport, auth, storage: f.storage === 'on' };
      try {
        if (initial) await trpc.hub.update.mutate({ id: initial.id, body });
        else { const p = await installMine([await trpc.hub.create.mutate(body)]); toast(p.installed.length ? 'Created and installed for you' : 'Created as a private draft'); }
        if (initial) toast('Saved as a new version');
        onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      {!initial && kinds.length > 1 && <Tabs value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
        <TabsList aria-label="Kind">
          {kinds.map((k) => <TabsTrigger key={k} value={k} className="px-2.5 text-[13px]"><KindIcon kind={k} size={13} />{KIND[k].label}</TabsTrigger>)}
        </TabsList>
      </Tabs>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input name="name" required defaultValue={initial?.name} /></Field><Field label={kind === 'agent' ? 'Description (when to use it)' : 'Description'}><Input name="description" required defaultValue={initial?.description} /></Field></div>
      {kind !== 'mcp' && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between"><label htmlFor="instr" className="text-sm font-medium">Instructions (markdown)</label>
            <button type="button" className="text-xs text-foreground underline" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button></div>
          {preview ? <div className="min-h-40 rounded-lg border bg-foreground/[0.06] p-3 text-sm"><Md>{instr || '*Nothing to preview.*'}</Md></div>
            : <Textarea id="instr" className="min-h-40 font-mono text-xs" required value={instr} onChange={(e) => setInstr(e.target.value)} placeholder={kind === 'skill' ? 'When to use this skill and the steps to follow…' : 'How this agent should behave…'} />}
        </div>
      )}
      {kind === 'skill' && !initial && (
        <fieldset className="grid gap-2"><legend className="text-sm font-medium">Extra files (optional)</legend>
          {files.map((f, i) => <div key={i} className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <Input aria-label={`Path of file ${i + 1}`} placeholder="reference/notes.md" value={f.path} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
            <Textarea aria-label={`Content of file ${i + 1}`} className="font-mono text-xs" rows={2} value={f.content} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} /></div>)}
          <div><Button type="button" variant="outline" onClick={() => setFiles([...files, { path: '', content: '' }])}><Plus size={14} aria-hidden />Add file</Button></div></fieldset>
      )}
      {kind === 'agent' && <>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Model (optional)"><Picker name="model" label="Model" value={model} onChange={setModel} emptyLabel="Same as orchestrator" className="w-full max-w-none" options={(models.data ?? []).map((x) => ({ ...x, group: `${x.providerName ?? x.provider}${x.scope === 'own' ? ' · yours' : ''}` }))} /></Field>
          <Field label="Thinking effort"><EffortSelect label="Thinking effort" value={thinking} onChange={setThinking} reasoning={model ? models.data?.find((x) => x.id === model)?.reasoning : undefined} defaultLabel="Default" /></Field>
        </div>
        <fieldset className="grid gap-1"><legend className="mb-1 text-sm font-medium">Skills</legend>
          {skillNames.length ? <div className="grid gap-1 sm:grid-cols-2">{skillNames.map((n) => <label key={n} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-foreground/5"><input type="checkbox" className="size-4 accent-foreground" checked={skills.includes(n)} onChange={(e) => setSkills(e.target.checked ? [...skills, n] : skills.filter((x) => x !== n))} />{n}</label>)}</div>
            : <p className="text-sm text-muted-foreground">No skills yet. Create or install a skill first.</p>}</fieldset>
      </>}
      {kind === 'mcp' && <>
        <Field label="Server URL"><Input name="url" type="url" required defaultValue={m.url} placeholder="https://mcp.example.com/mcp" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Transport"><Select name="transport" defaultValue={m.transport ?? 'streamable-http'}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></Select></Field>
          <Field label="Authentication"><Select value={auth} onChange={(e) => setAuth(e.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option><option value="oauth">OAuth sign-in</option></Select></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="storage" className="size-4 accent-foreground" defaultChecked={m.storage} />This server has filesystem tools: offer it as storage (shown as a folder in Files)</label>
        {auth !== 'none' && <p className="text-xs text-muted-foreground">Each user supplies their own {auth === 'bearer' ? 'token' : 'sign-in'} when they install it.</p>}
      </>}
      <Err>{err}</Err>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button type="submit">{initial ? 'Save' : kind === 'agent' ? 'Create agent' : kind === 'skill' ? 'Create skill' : 'Create'}</Button></div>
    </form>
  );
}
