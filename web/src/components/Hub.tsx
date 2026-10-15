import { BookOpen, Bot, CircleCheck, ChevronDown, ExternalLink, FileText, Layers, Package, PackageCheck, Plug, Plus, Search, Store, TriangleAlert, UserRound } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { api, can, useLoad, type Me } from './api';
import Shell, { PaneHeading, paneRow } from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, control, Dialog, Empty, Err, Field, Input, mdComponents, Page, Select, Textarea, toast, type Tone } from './ui';

// Contract: docs/HUB-API.md
export type Kind = 'skill' | 'agent' | 'mcp' | 'bundle';
export interface Pkg {
  id: string; kind: Kind; name: string; description: string; version: string; hash: string;
  source: { type: 'ui' | 'git' | 'marketplace' | 'mcp-registry'; url?: string; ref?: string };
  visibility: 'private' | 'team'; status: 'draft' | 'pending' | 'approved' | 'rejected'; rejectReason?: string;
  owner: { id: string; name: string }; installed: { me: boolean; team: boolean };
  guard: { flagged: boolean; reasons: string[] }; contains?: { skills: string[]; agents: string[]; mcp: string[] };
  createdAt: string; updatedAt: string;
}
export interface Detail extends Pkg { manifest: Record<string, any> & { ignored?: (string | { path: string })[] }; files: { path: string; size: number }[]; readme?: string }

export const KIND: Record<Kind, { label: string; plural: string; Icon: typeof Package }> = {
  skill: { label: 'Skill', plural: 'Skills', Icon: BookOpen }, agent: { label: 'Agent', plural: 'Agents', Icon: Bot },
  mcp: { label: 'MCP server', plural: 'MCP servers', Icon: Plug }, bundle: { label: 'Bundle', plural: 'Bundles', Icon: Package },
};
const SOURCE = { ui: 'Created in hefyn', git: 'GitHub', marketplace: 'Marketplace', 'mcp-registry': 'MCP Registry' };
const STATUS: Record<Pkg['status'], [string, Tone]> = { draft: ['Draft', 'neutral'], pending: ['Waiting for review', 'blue'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'alarm'] };
const q = encodeURIComponent;

export const KindIcon = ({ kind, size = 20 }: { kind: Kind; size?: number }) => { const { Icon } = KIND[kind]; return <Icon size={size} aria-hidden />; };
export const Flagged = ({ pkg }: { pkg: Pkg }) => pkg.guard.flagged ? <span title={pkg.guard.reasons.join(' ')}><Chip tone="caution"><TriangleAlert size={12} aria-hidden />Flagged</Chip></span> : null;
export const StatusBadge = ({ pkg }: { pkg: Pkg }) => <Chip tone={STATUS[pkg.status][1]}>{STATUS[pkg.status][0]}</Chip>;

type Tab = 'browse' | 'mine' | 'installed';
type KindFilter = '' | Kind;

export default function Hub() {
  const [tab, setTab] = useState<Tab>('browse');
  const [kind, setKind] = useState<KindFilter>('');
  const pane = (me: Me, pending: number) => (
    <>
      <nav aria-label="Hub sections" className="grid gap-0.5">
        {([['browse', 'Browse', Store], ['mine', 'Mine', UserRound], ['installed', 'Installed', CircleCheck]] as const).map(([t, l, Icon]) => <button key={t} aria-current={tab === t ? 'page' : undefined} className={paneRow(tab === t)} onClick={() => setTab(t)}><Icon size={16} aria-hidden />{l}</button>)}
        {can(me, 'hub.approve') && <a href="/hub/review" className={paneRow(false)}><PackageCheck size={16} aria-hidden />Review{pending > 0 && <span className="tnum ml-auto rounded-full bg-hefyn px-1.5 text-xs font-semibold text-on-hefyn">{pending}</span>}</a>}
      </nav>
      <PaneHeading>Type</PaneHeading>
      <div role="group" aria-label="Type" className="grid gap-0.5">
        {([['', 'Everything', Layers], ['skill', 'Skills', BookOpen], ['agent', 'Agents', Bot], ['mcp', 'MCP servers', Plug], ['bundle', 'Bundles', Package]] as const).map(([k, l, Icon]) => <button key={k} aria-pressed={kind === k} className={paneRow(kind === k)} onClick={() => setKind(k)}><Icon size={16} aria-hidden />{l}</button>)}
      </div>
    </>
  );
  return <Shell pane={pane}>{(me) => <Content me={me} tab={tab} kind={kind} />}</Shell>;
}

function Content({ me, tab, kind }: { me: Me; tab: Tab; kind: KindFilter }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(location.hash.slice(1));
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Detail>();
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setTimeout(() => setTerm(text), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => { const f = () => setOpen(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const list = useLoad<Pkg[]>(`/api/hub/packages?q=${q(term)}&kind=${kind}${tab === 'mine' ? '&mine=1' : '&status=approved'}`, [term, kind, tab, tick]);
  const inst = useLoad<{ me: Pkg[]; team: Pkg[] }>('/api/hub/installed', [tick]);
  const reload = () => setTick((t) => t + 1);
  const installedAll = [...new Map([...(inst.data?.team ?? []), ...(inst.data?.me ?? [])].map((p) => [p.id, p])).values()]
    .filter((p) => (!kind || p.kind === kind) && `${p.name} ${p.description}`.toLowerCase().includes(term.toLowerCase()));
  const items = tab === 'installed' ? installedAll : list.data?.filter((p) => tab === 'mine' ? p.owner.id === me.id : true);
  const close = () => { history.replaceState(null, '', location.pathname); setOpen(''); };
  const title = { browse: 'Hub', mine: 'My packages', installed: 'Installed' }[tab];

  return (
    <Page wide title={title} hint="Skills, agents and MCP servers your team can add in one click."
      actions={can(me, 'hub.install') && <button className={buttonPrimary} onClick={() => setAdding(true)}><Plus size={16} aria-hidden />Add to hub</button>}>
      <label className="relative mb-4 block"><span className="sr-only">Search packages</span>
        <Search size={16} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-soft" />
        <input className={`${control} pl-9`} type="search" placeholder="Search the hub" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Err>{list.error}</Err>
      {items && !items.length ? <Empty icon={<Package size={28} />}>{tab === 'mine' ? 'You have not added anything yet. Choose Add to hub to start.' : tab === 'installed' ? 'Nothing is installed yet. Browse the hub to add skills and agents.' : 'No packages match your search.'}</Empty> : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-sheet">{items?.map((p) => <PackageRow key={p.id} pkg={p} me={me} showStatus={tab === 'mine'} onChange={reload} />)}</ul>
      )}
      {open && <DetailDialog id={open} me={me} onClose={close} onChange={reload} onEdit={(d) => { close(); setEdit(d); }} />}
      {adding && <AddDialog me={me} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {edit && <Dialog title={`Edit ${edit.name}`} xl onClose={() => setEdit(undefined)}><CreateForm initial={edit} onDone={() => { setEdit(undefined); reload(); }} onCancel={() => setEdit(undefined)} /></Dialog>}
    </Page>
  );
}

// One-click install; a menu with "For me" / "For the team" when the user may install for the team.
export function InstallMenu({ pkg, me, onChange }: { pkg: Pkg; me: Me; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  const team = can(me, 'profiles.edit_team') && pkg.status === 'approved';
  const mineOnly = pkg.owner.id === me.id && pkg.status !== 'approved';
  if (!can(me, 'hub.install') || (pkg.status !== 'approved' && !mineOnly)) return null;
  const go = async (target: 'me' | 'team') => {
    setMenu(false);
    try { await api(`/api/hub/packages/${pkg.id}/install`, 'POST', { target }); pkg.kind === 'mcp' ? toast(`Installed ${pkg.name}`, false, { href: '/settings/connectors', label: 'Sign in in Connectors' }) : toast(`Installed ${pkg.name}`); onChange(); } catch (x) { toast((x as Error).message, true); }
  };
  if (!team) return <button className={buttonPrimary} onClick={() => go('me')}>Install</button>;
  return (
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
      <button className={buttonPrimary} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Install<ChevronDown size={14} aria-hidden /></button>
      {menu && <div role="menu" className="absolute right-0 z-10 mt-1 w-44 rounded-[12px] bg-sheet p-1 shadow-float ring-1 ring-line">
        {(['me', 'team'] as const).map((t) => <button key={t} role="menuitem" autoFocus={t === 'me'} className="block w-full rounded-[8px] px-2.5 py-2 text-left text-sm hover:bg-ink/5" onClick={() => go(t)}>{t === 'me' ? 'Install for me' : 'Install for the team'}</button>)}
      </div>}
    </div>
  );
}

function PackageRow({ pkg, me, showStatus, onChange }: { pkg: Pkg; me: Me; showStatus: boolean; onChange: () => void }) {
  const installed = pkg.installed.me || pkg.installed.team;
  return (
    <li className="flex items-center gap-4 px-4 py-3.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-ink/[0.06] text-soft"><KindIcon kind={pkg.kind} /></span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2"><a href={`#${pkg.id}`} className="font-medium hover:underline">{pkg.name}</a>
          <Flagged pkg={pkg} />{showStatus && <StatusBadge pkg={pkg} />}{installed && <Chip tone="blue">{pkg.installed.team ? 'Installed for team' : 'Installed'}</Chip>}</div>
        <p className="line-clamp-2 text-sm text-soft">{pkg.description}</p>
        {showStatus && pkg.status === 'rejected' && pkg.rejectReason && <p className="mt-0.5 truncate text-xs text-alarm-ink" title={pkg.rejectReason}>Rejected: {pkg.rejectReason}</p>}
        <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-soft"><span>{SOURCE[pkg.source.type]}</span><span>Version {pkg.version}</span><span>By {pkg.owner.name}</span></p>
      </div>
      {!installed && <InstallMenu pkg={pkg} me={me} onChange={onChange} />}
    </li>
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
    fetch(`/api/hub/packages/${id}/file?path=${q(sel)}`).then((r) => r.text()).then(setText, () => setText('Could not load file.'));
  }, [sel]);
  if (!files.length) return <p className="text-sm text-soft">No files.</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
      <ul className="max-h-64 overflow-auto rounded-[10px] border text-sm" aria-label="Files">
        {files.map((f) => <li key={f.path}><button onClick={() => setSel(f.path)} aria-current={sel === f.path} className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-ink/5 ${sel === f.path ? 'bg-hefyn/12' : ''}`}><FileText size={13} aria-hidden className="shrink-0 text-soft" /><span className="truncate">{f.path}</span></button></li>)}
      </ul>
      <div className="max-h-64 min-w-0 overflow-auto rounded-[10px] border bg-ink/[0.06] p-3">
        {!sel ? <p className="text-sm text-soft">Select a file to view it.</p>
          : /\.md$/i.test(sel) ? (() => { const { meta, body } = splitFrontmatter(text); return <div className="text-sm">
            {meta.length > 0 && <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-[10px] border bg-sheet px-3 py-2 text-xs">{meta.map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-soft">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}</dl>}
            <Markdown components={mdComponents}>{body}</Markdown></div>; })()
          : <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>}
      </div>
    </div>
  );
}

const ignoredPath = (i: string | { path: string }) => (typeof i === 'string' ? i : i.path);

function DetailDialog({ id, me, onClose, onChange, onEdit }: { id: string; me: Me; onClose: () => void; onChange: () => void; onEdit: (d: Detail) => void }) {
  const { data: d, error, reload } = useLoad<Detail>(`/api/hub/packages/${id}`);
  const [del, setDel] = useState(false);
  const mine = d?.owner.id === me.id;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { const r = await fn(); toast(typeof ok === 'string' ? ok : ok); reload(); onChange(); return r; } catch (x) { toast((x as Error).message, true); } };
  const ignored = d?.manifest?.ignored ?? [];
  const actions = d && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {mine && d.source.type === 'ui' && <button className={buttonGhost} onClick={() => onEdit(d)}>Edit</button>}
            {mine && can(me, 'hub.publish') && d.visibility === 'private' && d.status !== 'pending' && <button className={buttonGhost} onClick={async () => { try { const r = await api<Pkg>(`/api/hub/packages/${d.id}/publish`, 'POST'); toast(r?.status === 'pending' ? 'Sent for review' : 'Published'); reload(); onChange(); } catch (x) { toast((x as Error).message, true); } }}>Publish</button>}
            {(mine || can(me, 'hub.approve')) && <button className={buttonDanger} onClick={() => setDel(true)}>Delete</button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(['me', 'team'] as const).filter((t) => d.installed[t] && (t === 'me' || can(me, 'profiles.edit_team'))).map((t) => (
              <button key={t} className={buttonGhost} onClick={() => act(() => api(`/api/hub/packages/${d.id}/install?target=${t}`, 'DELETE'), 'Uninstalled')}>Uninstall{t === 'team' ? ' for the team' : ''}</button>))}
            {!d.installed.me && <InstallMenu pkg={d} me={me} onChange={() => { reload(); onChange(); }} />}
          </div>
        </div>
  );
  const H = ({ children }: { children: string }) => <h3 className="text-sm font-semibold">{children}</h3>;
  return (
    <Dialog title={d?.name ?? 'Package'} side onClose={onClose} footer={d && actions}>
      <Err>{error}</Err>
      {d && <>
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-soft">
          <span className="inline-flex items-center gap-1.5"><KindIcon kind={d.kind} size={15} />{KIND[d.kind].label}</span><span>Version {d.version}</span><span>By {d.owner.name}</span>
        </div>
        <div className="flex flex-wrap gap-1.5"><StatusBadge pkg={d} /><Flagged pkg={d} />{d.installed.me && <Chip tone="blue">Installed for me</Chip>}{d.installed.team && <Chip tone="blue">Installed for the team</Chip>}</div>
        <p className="text-[15px] leading-6">{d.description}</p>
        {d.status === 'rejected' && d.rejectReason && <p role="alert" className="rounded-[10px] bg-alarm/10 px-3 py-2 text-sm text-alarm-ink">Rejected: {d.rejectReason}</p>}
        <section className="grid gap-1"><H>Safety check</H>
          {d.guard.flagged ? <div className="rounded-[10px] bg-caution/15 px-3 py-2 text-sm"><b className="flex items-center gap-1.5 text-caution-ink"><TriangleAlert size={14} aria-hidden />The prompt-injection guard flagged this package</b>
            <ul className="mt-1 list-disc pl-5">{d.guard.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            : <p className="text-sm text-soft">The prompt-injection guard found nothing.</p>}</section>
        {d.contains && (
          <section className="grid gap-2"><H>What is inside</H>
            <div className="grid gap-3 sm:grid-cols-3">
              {(['skills', 'agents', 'mcp'] as const).map((k) => <div key={k}><div className="mb-1 text-sm text-soft">{k === 'mcp' ? 'MCP servers' : k === 'skills' ? 'Skills' : 'Agents'}</div>
                {d.contains![k].length ? <ul className="grid gap-0.5">{d.contains![k].map((n) => <li key={n} className="truncate font-mono text-[13px]">{n}</li>)}</ul> : <span className="text-sm text-soft">None</span>}</div>)}
            </div>
          </section>
        )}
        {ignored.length > 0 && (
          <section className="grid gap-1 opacity-75"><H>Not installed</H>
            <p className="text-sm text-soft">Hooks and commands can run code, so hefyn never installs them. They are listed so you can see what the author included.</p>
            <ul className="grid gap-0.5 font-mono text-[13px] text-soft line-through">{ignored.map((i) => <li key={ignoredPath(i)}>{ignoredPath(i)}</li>)}</ul>
          </section>
        )}
        {d.readme && <section className="grid gap-1"><H>Readme</H><div className="max-h-60 overflow-auto text-sm"><Markdown components={mdComponents}>{d.readme}</Markdown></div></section>}
        <section className="grid gap-2"><H>Files</H><FileBrowser id={d.id} files={d.files} /></section>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-soft">Source</dt><dd>{SOURCE[d.source.type]}{d.source.url && <> <a className="inline-flex items-center gap-1 text-hefyn underline break-all" href={d.source.url} target="_blank" rel="noreferrer">{d.source.url}{d.source.ref && ` at ${d.source.ref}`}<ExternalLink size={11} aria-hidden /></a></>}</dd>
          <dt className="text-soft">Hash</dt><dd className="font-mono text-[13px] break-all">{d.hash}</dd>
          <dt className="text-soft">Updated</dt><dd>{new Date(d.updatedAt).toLocaleString()}</dd>
        </dl>
      </>}
      {del && d && <ConfirmDialog title={`Delete ${d.name}?`} body="It is removed from the hub and from everyone who installed it." action="Delete" onClose={() => setDel(false)}
        onConfirm={() => act(() => api(`/api/hub/packages/${d.id}`, 'DELETE'), 'Deleted').then(onClose)} />}
    </Dialog>
  );
}

// ---- Add to hub ----
interface RegistryHit { name: string; description: string; url: string; transport: string; repository?: string }

function AddDialog({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'git' | 'registry' | 'create'>('git');
  return (
    <Dialog title="Add to hub" xl onClose={onClose}>
      <div role="tablist" aria-label="How to add" className="-mt-2 flex gap-1 border-b">
        {([['git', 'Import from GitHub'], ['registry', 'MCP Registry'], ['create', 'Create']] as const).map(([m, l]) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${mode === m ? 'border-hefyn text-ink' : 'border-transparent text-soft hover:text-ink'}`}>{l}</button>
        ))}
      </div>
      {mode === 'git' && <GitImport onDone={onDone} />}
      {mode === 'registry' && <RegistrySearch onDone={onDone} />}
      {mode === 'create' && <CreateForm onDone={onDone} onCancel={onClose} />}
    </Dialog>
  );
}

function Imported({ pkgs, onDone }: { pkgs: Pkg[]; onDone: () => void }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-ok-ink" role="status">Imported {pkgs.length} {pkgs.length === 1 ? 'package' : 'packages'} as private drafts.</p>
      <ul className="grid gap-1.5">{pkgs.map((p) => <li key={p.id} className="flex items-center gap-2 rounded-[10px] border px-3 py-2 text-sm"><KindIcon kind={p.kind} size={16} /><span className="font-medium">{p.name}</span><Flagged pkg={p} /><a className="ml-auto text-hefyn underline" href={`#${p.id}`} onClick={onDone}>Open</a></li>)}</ul>
      <div className="flex justify-end"><button className={buttonPrimary} onClick={onDone}>Done</button></div>
    </div>
  );
}

function GitImport({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Pkg[]>();
  if (res) return <Imported pkgs={res} onDone={onDone} />;
  return (
    <form className="grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr(''); setBusy(true);
      const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
      try { setRes(await api<Pkg[]>('/api/hub/import', 'POST', { url: f.url, ref: f.ref || undefined })); } catch (x) { setErr((x as Error).message); }
      setBusy(false);
    }}>
      <p className="text-sm text-soft">Point at a GitHub repository with skills (<code className="font-mono text-xs">SKILL.md</code>), a Claude plugin, agents or <code className="font-mono text-xs">.mcp.json</code>, or a marketplace. Plugin hooks and commands are ignored.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]"><Field label="Git URL"><Input name="url" type="url" required placeholder="https://github.com/owner/repo" /></Field><Field label="Ref (optional)"><Input name="ref" placeholder="main" /></Field></div>
      <Err>{err}</Err>
      <div className="flex justify-end"><button className={buttonPrimary} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button></div>
    </form>
  );
}

function RegistrySearch({ onDone }: { onDone: () => void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<RegistryHit[]>();
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Pkg[]>();
  if (res) return <Imported pkgs={res} onDone={onDone} />;
  return (
    <div className="grid gap-3">
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); setErr(''); setHits(undefined); try { setHits(await api<RegistryHit[]>(`/api/hub/registry/mcp?q=${q(term)}`)); } catch (x) { setErr((x as Error).message); } }}>
        <Input aria-label="Search the MCP Registry" type="search" placeholder="Search the official MCP Registry…" value={term} onChange={(e) => setTerm(e.target.value)} required /><button className={buttonPrimary}>Search</button>
      </form>
      <Err>{err}</Err>
      {hits && !hits.length && <Empty icon={<Search size={24} />}>No servers found.</Empty>}
      <ul className="grid max-h-80 gap-1.5 overflow-auto">
        {hits?.map((h) => (
          <li key={h.name} className="flex items-start gap-3 rounded-[10px] border px-3 py-2">
            <div className="min-w-0 grow"><div className="truncate text-sm font-medium">{h.name}</div><p className="line-clamp-2 text-xs text-soft">{h.description}</p><p className="truncate font-mono text-[11px] text-soft">{h.url} · {h.transport}</p></div>
            <button className={buttonGhost} onClick={async () => { try { setRes([await api<Pkg>('/api/hub/registry/mcp/import', 'POST', { name: h.name })]); } catch (x) { setErr((x as Error).message); } }}>Import</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Create or edit (initial) a skill, agent or MCP server.
function CreateForm({ initial, onDone, onCancel }: { initial?: Detail; onDone: () => void; onCancel: () => void }) {
  const m = initial?.manifest ?? {};
  const [kind, setKind] = useState<'skill' | 'agent' | 'mcp'>((initial?.kind as 'skill') ?? 'skill');
  const [instr, setInstr] = useState<string>(m.instructions ?? '');
  const [preview, setPreview] = useState(false);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [skills, setSkills] = useState<string[]>(m.skills ?? []);
  const [auth, setAuth] = useState<string>(m.auth ?? 'none');
  const [err, setErr] = useState('');
  const models = useLoad<{ id: string; name: string }[]>('/api/models/available');
  const own = useLoad<Pkg[]>('/api/hub/packages?kind=skill&mine=1');
  const inst = useLoad<{ me: Pkg[]; team: Pkg[] }>('/api/hub/installed');
  const skillNames = [...new Set([...(own.data ?? []), ...(inst.data?.me ?? []), ...(inst.data?.team ?? [])].filter((p) => p.kind === 'skill').map((p) => p.name))];
  return (
    <form className="grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
      const body = kind === 'skill' ? { kind, name: f.name, description: f.description, instructions: instr, files: files.filter((x) => x.path && x.content) }
        : kind === 'agent' ? { kind, name: f.name, description: f.description, instructions: instr, model: f.model || undefined, skills }
        : { kind, name: f.name, description: f.description, url: f.url, transport: f.transport, auth };
      try { await (initial ? api(`/api/hub/packages/${initial.id}`, 'PATCH', body) : api('/api/hub/packages', 'POST', body)); toast(initial ? 'Saved as a new version' : 'Created as a private draft'); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      {!initial && <div role="group" aria-label="Kind" className="flex gap-1.5">
        {(['skill', 'agent', 'mcp'] as const).map((k) => <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${kind === k ? 'border-hefyn bg-hefyn text-on-hefyn' : 'hover:bg-ink/5'}`}><KindIcon kind={k} size={13} />{KIND[k].label}</button>)}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input name="name" required defaultValue={initial?.name} /></Field><Field label="Description"><Input name="description" required defaultValue={initial?.description} /></Field></div>
      {kind !== 'mcp' && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between"><label htmlFor="instr" className="text-sm font-medium">Instructions (markdown)</label>
            <button type="button" className="text-xs text-hefyn underline" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button></div>
          {preview ? <div className="min-h-40 rounded-[10px] border bg-ink/[0.06] p-3 text-sm"><Markdown components={mdComponents}>{instr || '*Nothing to preview.*'}</Markdown></div>
            : <textarea id="instr" className={`${control} min-h-40 font-mono text-xs`} required value={instr} onChange={(e) => setInstr(e.target.value)} placeholder={kind === 'skill' ? 'When to use this skill and the steps to follow…' : 'How this agent should behave…'} />}
        </div>
      )}
      {kind === 'skill' && !initial && (
        <fieldset className="grid gap-2"><legend className="text-sm font-medium">Extra files (optional)</legend>
          {files.map((f, i) => <div key={i} className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <Input aria-label={`Path of file ${i + 1}`} placeholder="reference/notes.md" value={f.path} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
            <textarea aria-label={`Content of file ${i + 1}`} className={`${control} font-mono text-xs`} rows={2} value={f.content} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} /></div>)}
          <div><button type="button" className={buttonGhost} onClick={() => setFiles([...files, { path: '', content: '' }])}><Plus size={14} aria-hidden />Add file</button></div></fieldset>
      )}
      {kind === 'agent' && <>
        <Field label="Model"><Select name="model" defaultValue={m.model ?? ''}><option value="">Same as orchestrator</option>{models.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <fieldset className="grid gap-1"><legend className="mb-1 text-sm font-medium">Skills</legend>
          {skillNames.length ? <div className="grid gap-1 sm:grid-cols-2">{skillNames.map((n) => <label key={n} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-ink/5"><input type="checkbox" className="size-4 accent-hefyn" checked={skills.includes(n)} onChange={(e) => setSkills(e.target.checked ? [...skills, n] : skills.filter((x) => x !== n))} />{n}</label>)}</div>
            : <p className="text-sm text-soft">No skills yet. Create or install a skill first.</p>}</fieldset>
      </>}
      {kind === 'mcp' && <>
        <Field label="Server URL"><Input name="url" type="url" required defaultValue={m.url} placeholder="https://mcp.example.com/mcp" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Transport"><Select name="transport" defaultValue={m.transport ?? 'streamable-http'}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></Select></Field>
          <Field label="Authentication"><Select value={auth} onChange={(e) => setAuth(e.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option><option value="oauth">OAuth sign-in</option></Select></Field>
        </div>
        {auth !== 'none' && <p className="text-xs text-soft">Each user supplies their own {auth === 'bearer' ? 'token' : 'sign-in'} when they install it.</p>}
      </>}
      <Err>{err}</Err>
      <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={onCancel}>Cancel</button><button className={buttonPrimary}>{initial ? 'Save' : 'Create draft'}</button></div>
    </form>
  );
}
