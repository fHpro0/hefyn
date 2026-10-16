import { BookOpen, Bot, CircleCheck, ChevronDown, ExternalLink, FileText, Layers, Package, PackageCheck, Plug, Plus, Search, Store, TriangleAlert, UserRound, X } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { api, can, useLoad, type Me } from './api';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, control, Dialog, Empty, Err, Field, iconButton, Input, mdComponents, Page, Select, Textarea, toast, type Tone } from './ui';

// Contract: docs/HUB-API.md
export type Kind = 'skill' | 'agent' | 'mcp' | 'bundle';
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
  const [adding, setAdding] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(text), 250); return () => clearTimeout(t); }, [text]);
  const list = useLoad<Pkg[]>(`/api/hub/packages?q=${q(term)}&kind=${kind}${tab === 'mine' ? '&mine=1' : '&status=approved'}`, [term, kind, tab, tick]);
  const inst = useLoad<{ me: Pkg[]; team: Pkg[] }>('/api/hub/installed', [tick]);
  const installedAll = [...new Map([...(inst.data?.team ?? []), ...(inst.data?.me ?? [])].map((p) => [p.id, p])).values()]
    .filter((p) => (!kind || p.kind === kind) && `${p.name} ${p.description}`.toLowerCase().includes(term.toLowerCase()));
  const items = tab === 'installed' ? installedAll : list.data?.filter((p) => tab === 'mine' ? p.owner.id === me.id : true);
  const seg = (on: boolean) => `h-8 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${on ? 'bg-foreground/[0.08] text-foreground' : 'text-muted hover:bg-foreground/5 hover:text-foreground'}`;

  return (
    <Page wide title="Hub" hint="Skills, agents and MCP servers your team can add in one click."
      actions={<div className="flex gap-2">{can(me, 'hub.approve') && <a href="/hub/review" className={buttonGhost}><PackageCheck size={14} aria-hidden />Review</a>}{can(me, 'hub.install') && <button className={buttonPrimary} onClick={() => setAdding(true)}><Plus size={14} aria-hidden />Add to hub</button>}</div>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Hub" className="flex gap-0.5">
          {([['browse', 'Browse', Store], ['mine', 'Mine', UserRound], ['installed', 'Installed', CircleCheck]] as const).map(([t, l, Icon]) => <button key={t} role="tab" aria-selected={tab === t} className={`${seg(tab === t)} inline-flex items-center gap-1.5`} onClick={() => setTab(t)}><Icon size={14} aria-hidden />{l}</button>)}
        </div>
        <span className="mx-1 h-5 w-px bg-border max-sm:hidden" aria-hidden />
        <div role="group" aria-label="Type" className="flex flex-wrap gap-0.5">
          {([['', 'All'], ['skill', 'Skills'], ['agent', 'Agents'], ['mcp', 'MCP servers'], ['bundle', 'Bundles']] as const).map(([k, l]) => <button key={k} aria-pressed={kind === k} className={seg(kind === k)} onClick={() => setKind(k)}>{l}</button>)}
        </div>
      </div>
      <label className="relative mb-4 block"><span className="sr-only">Search packages</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
        <input className={`${control} pl-8`} type="search" placeholder="Search the hub" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Err>{list.error}</Err>
      {items && !items.length ? <Empty icon={<Package size={28} />}>{tab === 'mine' ? 'You have not added anything yet. Choose Add to hub to start.' : tab === 'installed' ? 'Nothing is installed yet. Browse the hub to add skills and agents.' : 'No packages match your search.'}</Empty> : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">{items?.map((p) => <PackageRow key={p.id} pkg={p} me={me} showStatus={tab === 'mine'} onChange={onChange} />)}</ul>
      )}
      {adding && <AddDialog me={me} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChange(); }} />}
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
    try { await api(`/api/hub/packages/${pkg.id}/install`, 'POST', { target }); pkg.kind === 'mcp' ? toast(`Installed ${pkg.name}`, false, pkg.storage ? { href: '/settings/connectors#storage', label: 'Sign in, then use as storage' } : { href: '/settings/connectors', label: 'Sign in in Connectors' }) : toast(`Installed ${pkg.name}`); onChange(); } catch (x) { toast((x as Error).message, true); }
  };
  if (!team) return <button className={buttonPrimary} onClick={() => go('me')}>Install</button>;
  return (
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
      <button className={buttonPrimary} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Install<ChevronDown size={14} aria-hidden /></button>
      {menu && <div role="menu" className="absolute right-0 z-10 mt-1 w-44 rounded-xl bg-raised p-1 shadow-float ring-1 ring-border">
        {(['me', 'team'] as const).map((t) => <button key={t} role="menuitem" autoFocus={t === 'me'} className="block w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-foreground/5" onClick={() => go(t)}>{t === 'me' ? 'Install for me' : 'Install for the team'}</button>)}
      </div>}
    </div>
  );
}

function PackageRow({ pkg, me, showStatus, onChange }: { pkg: Pkg; me: Me; showStatus: boolean; onChange: () => void }) {
  const installed = pkg.installed.me || pkg.installed.team;
  return (
    <li className="flex items-center gap-4 px-4 py-3.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-muted"><KindIcon kind={pkg.kind} /></span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2"><a href={`#${pkg.id}`} className="font-medium hover:underline">{pkg.name}</a>
          <Flagged pkg={pkg} />{showStatus && <StatusBadge pkg={pkg} />}{installed && <Chip tone="blue">{pkg.installed.team ? 'Installed for team' : 'Installed'}</Chip>}</div>
        <p className="line-clamp-2 text-sm text-muted">{pkg.description}</p>
        {showStatus && pkg.status === 'rejected' && pkg.rejectReason && <p className="mt-0.5 truncate text-xs text-danger-ink" title={pkg.rejectReason}>Rejected: {pkg.rejectReason}</p>}
        <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted"><span>{SOURCE[pkg.source.type]}</span><span>Version {pkg.version}</span><span>By {pkg.owner.name}</span></p>
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
  if (!files.length) return <p className="text-sm text-muted">No files.</p>;
  return (
    <div className="grid gap-2">
      <ul className="max-h-64 overflow-auto rounded-lg border text-sm" aria-label="Files">
        {files.map((f) => <li key={f.path}><button onClick={() => setSel(f.path)} aria-current={sel === f.path} className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-foreground/5 ${sel === f.path ? 'bg-foreground/10' : ''}`}><FileText size={13} aria-hidden className="shrink-0 text-muted" /><span className="truncate">{f.path}</span></button></li>)}
      </ul>
      <div className="max-h-64 min-w-0 overflow-auto rounded-lg border bg-foreground/[0.06] p-3">
        {!sel ? <p className="text-sm text-muted">Select a file to view it.</p>
          : /\.md$/i.test(sel) ? (() => { const { meta, body } = splitFrontmatter(text); return <div className="text-sm">
            {meta.length > 0 && <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border bg-raised px-3 py-2 text-xs">{meta.map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-muted">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}</dl>}
            <Markdown components={mdComponents}>{body}</Markdown></div>; })()
          : <pre className="font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>}
      </div>
    </div>
  );
}

const ignoredPath = (i: string | { path: string }) => (typeof i === 'string' ? i : i.path);

function DetailPanel({ id, me, onClose, onChange, onEdit }: { id: string; me: Me; onClose: () => void; onChange: () => void; onEdit: (d: Detail) => void }) {
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
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-4"><h2 className="truncate text-sm font-medium">{d?.name ?? 'Package'}</h2>
        <button className={iconButton} aria-label="Close details" onClick={onClose}><X size={16} /></button></div>
      <div className="grid min-h-0 grow content-start gap-4 overflow-y-auto p-4">
      <Err>{error}</Err>
      {d && <>
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="inline-flex items-center gap-1.5"><KindIcon kind={d.kind} size={15} />{KIND[d.kind].label}</span><span>Version {d.version}</span><span>By {d.owner.name}</span>
        </div>
        <div className="flex flex-wrap gap-1.5"><StatusBadge pkg={d} /><Flagged pkg={d} />{d.installed.me && <Chip tone="blue">Installed for me</Chip>}{d.installed.team && <Chip tone="blue">Installed for the team</Chip>}</div>
        <p className="text-sm leading-[22px]">{d.description}</p>
        {d.status === 'rejected' && d.rejectReason && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink">Rejected: {d.rejectReason}</p>}
        <section className="grid gap-1"><H>Safety check</H>
          {d.guard.flagged ? <div className="rounded-lg bg-warning/15 px-3 py-2 text-sm"><b className="flex items-center gap-1.5 text-warning-ink"><TriangleAlert size={14} aria-hidden />The prompt-injection guard flagged this package</b>
            <ul className="mt-1 list-disc pl-5">{d.guard.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            : <p className="text-sm text-muted">The prompt-injection guard found nothing.</p>}</section>
        {d.contains && (
          <section className="grid gap-2"><H>What is inside</H>
            <div className="grid gap-3">
              {(['skills', 'agents', 'mcp'] as const).map((k) => <div key={k}><div className="mb-1 text-sm text-muted">{k === 'mcp' ? 'MCP servers' : k === 'skills' ? 'Skills' : 'Agents'}</div>
                {d.contains![k].length ? <ul className="grid gap-0.5">{d.contains![k].map((n) => <li key={n} className="truncate font-mono text-[13px]">{n}</li>)}</ul> : <span className="text-sm text-muted">None</span>}</div>)}
            </div>
          </section>
        )}
        {ignored.length > 0 && (
          <section className="grid gap-1 opacity-75"><H>Not installed</H>
            <p className="text-sm text-muted">Hooks and commands can run code, so hefyn never installs them. They are listed so you can see what the author included.</p>
            <ul className="grid gap-0.5 font-mono text-[13px] text-muted line-through">{ignored.map((i) => <li key={ignoredPath(i)}>{ignoredPath(i)}</li>)}</ul>
          </section>
        )}
        {d.readme && <section className="grid gap-1"><H>Readme</H><div className="max-h-60 overflow-auto text-sm"><Markdown components={mdComponents}>{d.readme}</Markdown></div></section>}
        <section className="grid gap-2"><H>Files</H><FileBrowser id={d.id} files={d.files} /></section>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Source</dt><dd>{SOURCE[d.source.type]}{d.source.url && <> <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 break-all" href={d.source.url} target="_blank" rel="noreferrer">{d.source.url}{d.source.ref && ` at ${d.source.ref}`}<ExternalLink size={11} aria-hidden /></a></>}</dd>
          <dt className="text-muted">Hash</dt><dd className="font-mono text-[13px] break-all">{d.hash}</dd>
          <dt className="text-muted">Updated</dt><dd>{new Date(d.updatedAt).toLocaleString()}</dd>
        </dl>
      </>}
      </div>
      {d && <div className="shrink-0 border-t border-border px-4 py-3">{actions}</div>}
      {del && d && <ConfirmDialog title={`Delete ${d.name}?`} body="It is removed from the hub and from everyone who installed it." action="Delete" onClose={() => setDel(false)}
        onConfirm={() => act(() => api(`/api/hub/packages/${d.id}`, 'DELETE'), 'Deleted').then(onClose)} />}
    </>
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
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${mode === m ? 'border-foreground text-foreground' : 'border-transparent text-muted hover:text-foreground'}`}>{l}</button>
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
      <p className="text-sm text-success-ink" role="status">Imported {pkgs.length} {pkgs.length === 1 ? 'package' : 'packages'} as private drafts.</p>
      <ul className="grid gap-1.5">{pkgs.map((p) => <li key={p.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><KindIcon kind={p.kind} size={16} /><span className="font-medium">{p.name}</span><Flagged pkg={p} /><a className="ml-auto text-foreground underline underline-offset-2 underline" href={`#${p.id}`} onClick={onDone}>Open</a></li>)}</ul>
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
      <p className="text-sm text-muted">Point at a GitHub repository with skills (<code className="font-mono text-xs">SKILL.md</code>), a Claude plugin, agents or <code className="font-mono text-xs">.mcp.json</code>, or a marketplace. Plugin hooks and commands are ignored.</p>
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
          <li key={h.name} className="flex items-start gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 grow"><div className="truncate text-sm font-medium">{h.name}</div><p className="line-clamp-2 text-xs text-muted">{h.description}</p><p className="truncate font-mono text-[11px] text-muted">{h.url} · {h.transport}</p></div>
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
        : { kind, name: f.name, description: f.description, url: f.url, transport: f.transport, auth, storage: f.storage === 'on' };
      try { await (initial ? api(`/api/hub/packages/${initial.id}`, 'PATCH', body) : api('/api/hub/packages', 'POST', body)); toast(initial ? 'Saved as a new version' : 'Created as a private draft'); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      {!initial && <div role="group" aria-label="Kind" className="flex gap-1.5">
        {(['skill', 'agent', 'mcp'] as const).map((k) => <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${kind === k ? 'border-foreground bg-foreground text-background' : 'hover:bg-foreground/5'}`}><KindIcon kind={k} size={13} />{KIND[k].label}</button>)}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input name="name" required defaultValue={initial?.name} /></Field><Field label="Description"><Input name="description" required defaultValue={initial?.description} /></Field></div>
      {kind !== 'mcp' && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between"><label htmlFor="instr" className="text-sm font-medium">Instructions (markdown)</label>
            <button type="button" className="text-xs text-foreground underline" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button></div>
          {preview ? <div className="min-h-40 rounded-lg border bg-foreground/[0.06] p-3 text-sm"><Markdown components={mdComponents}>{instr || '*Nothing to preview.*'}</Markdown></div>
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
          {skillNames.length ? <div className="grid gap-1 sm:grid-cols-2">{skillNames.map((n) => <label key={n} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-foreground/5"><input type="checkbox" className="size-4 accent-foreground" checked={skills.includes(n)} onChange={(e) => setSkills(e.target.checked ? [...skills, n] : skills.filter((x) => x !== n))} />{n}</label>)}</div>
            : <p className="text-sm text-muted">No skills yet. Create or install a skill first.</p>}</fieldset>
      </>}
      {kind === 'mcp' && <>
        <Field label="Server URL"><Input name="url" type="url" required defaultValue={m.url} placeholder="https://mcp.example.com/mcp" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Transport"><Select name="transport" defaultValue={m.transport ?? 'streamable-http'}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></Select></Field>
          <Field label="Authentication"><Select value={auth} onChange={(e) => setAuth(e.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option><option value="oauth">OAuth sign-in</option></Select></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="storage" className="size-4 accent-foreground" defaultChecked={m.storage} />This server has filesystem tools: offer it as storage (shown as a folder in Files)</label>
        {auth !== 'none' && <p className="text-xs text-muted">Each user supplies their own {auth === 'bearer' ? 'token' : 'sign-in'} when they install it.</p>}
      </>}
      <Err>{err}</Err>
      <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={onCancel}>Cancel</button><button className={buttonPrimary}>{initial ? 'Save' : 'Create draft'}</button></div>
    </form>
  );
}
