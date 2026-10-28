import { Cable, LogIn, KeyRound, Pencil, Plus, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { can, useQuery } from './api';
import { trpc } from '@/lib/trpc';
import { OAuthFlow, type Start } from './ConnectModel';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { MenuArea } from './AppMenu';
import { Spinner } from '@/ui/spinner';
import { ConfirmDialog, Dialog } from './dialogs';
import { toast } from './toast';
import { Chip, Err, Field, Input, Loading, Page, Reveal, Select, Switch } from './ui';

// Shapes follow src/server/connectors-routes.ts.
interface Mcp { id: string; name: string; url: string; transport: string; auth: string; visibility: 'private' | 'team'; mine: boolean; connected: boolean; sharedAccount?: boolean; builtin?: boolean; enabled?: boolean; note?: string;
  /** the last real test: untested until someone presses Test */ status?: 'untested' | 'ok' | 'failed'; error?: string; /** given to plain-agent chats */ on?: boolean; /** agents can reach it (streamable HTTP only) */ agents?: boolean }

// MCP servers (/settings/mcp). External storage (add-ons) moved to old/.
export default function Mcp() {
  return <Shell>{(me) => <Content team={can(me, 'profiles.edit_team')} managed={can(me, 'mcp.run_managed')} />}</Shell>;
}
// Section with its add action in the header.
const Group = ({ title, add, empty, children }: { title: string; add: ReactNode; empty?: ReactNode; children?: ReactNode }) => (
  <section className="mt-7 first:mt-0">
    <div className="mb-1 flex items-center justify-between gap-3"><h2 className="text-[15px] leading-6 font-semibold">{title}</h2>{add}</div>
    <div className="border-t border-border">{empty ? <div className="border-b border-border py-3.5"><p className="max-w-2xl text-[13px] leading-[18px] text-muted-foreground">{empty}</p></div> : children}</div>
  </section>
);
const AddButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => <Button size="sm" variant="outline" onClick={onClick}><Plus size={14} aria-hidden />{children}</Button>;

// One list item: name and chips on the first line, controls right-aligned on it, description below at full width.
function Item({ title, chips, hint, more, menu, children }: { title: ReactNode; chips?: ReactNode; hint?: ReactNode; more?: string; menu?: () => ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const row = (
    <div className="border-b border-border py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 grow flex-wrap items-center gap-x-2 gap-y-1"><h3 className="text-[13px] font-medium">{title}</h3>{chips}</div>
        {children && <div className="flex flex-wrap items-center gap-1.5">{children}</div>}
      </div>
      {(hint || more) && <p className="mt-1 max-w-2xl text-[13px] leading-[18px] text-muted-foreground">{hint}{more && <>{open && ` ${more}`}{' '}<button type="button" aria-expanded={open} className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button></>}</p>}
    </div>
  );
  return menu ? <MenuArea items={menu}>{row}</MenuArea> : row;
}
// Right-click menu entry.
const mi = (Icon: typeof Zap, label: string, run: () => void, destructive?: boolean) =>
  <DropdownMenuItem className="text-[13px]" variant={destructive ? 'destructive' : undefined} onClick={run}><Icon size={15} strokeWidth={1.75} aria-hidden />{label}</DropdownMenuItem>;
// Split a long description after its first sentence; the rest goes behind "More".
const lead = (s: string): { hint: string; more?: string } => { const i = s.search(/[.!?]\s/); return s.length > 140 && i > 0 ? { hint: s.slice(0, i + 1), more: s.slice(i + 2) } : { hint: s }; };

function Content({ team, managed }: { team: boolean; managed: boolean }) {
  const mcp = useQuery(() => trpc.connectors.mcp.list.query() as Promise<Mcp[]>);
  const [dlg, setDlg] = useState<'mcp' | undefined>();
  const [signin, setSignin] = useState<Mcp>();
  const [token, setToken] = useState<Mcp>();
  const [testing, setTesting] = useState<string>();
  const test = async (s: Mcp) => {
    setTesting(s.id);
    try { const r = await trpc.connectors.mcp.test.mutate({ id: s.id }); toast(r.ok ? `${s.name} works. ${r.tools?.length ?? 0} tools found.` : `${s.name} did not answer: ${r.error ?? 'connection failed'}`, !r.ok); }
    catch (x) { toast(`${s.name} did not answer: ${(x as Error).message}`, true); }
    setTesting(undefined);
    mcp.reload(); // the status chip is the last real test
  };
  const [edit, setEdit] = useState<Mcp>();
  const give = async (s: Mcp, on: boolean) => { try { await trpc.connectors.mcp.setOn.mutate({ id: s.id, on }); mcp.reload(); } catch (x) { toast((x as Error).message, true); } };
  const [del, setDel] = useState<{ label: string; run: () => Promise<unknown> }>();
  const done = (msg: string) => { setDlg(undefined); toast(msg); mcp.reload(); dispatchEvent(new Event('hefyn-me')); };
  const servers = mcp.data?.filter((s) => !s.builtin || managed);
  const toggle = async (s: Mcp, on: boolean) => { try { await trpc.connectors.mcp.setPlaywright.mutate({ enabled: on }); toast(on ? 'Turned on' : 'Turned off'); mcp.reload(); } catch (x) { toast((x as Error).message, true); } };
  const canSignin = (s: Mcp) => !s.connected && s.auth === 'oauth' && (s.mine || s.visibility === 'team');
  const canToken = (s: Mcp) => s.auth === 'bearer' && s.mine && (!s.sharedAccount || team);
  const removeMcp = (s: Mcp) => setDel({ label: `Remove ${s.name}?`, run: () => trpc.connectors.mcp.delete.mutate({ id: s.id }).then(() => done('Removed')) });
  return (
    <Page title="MCP" hint="MCP servers give your agents tools to use for you. Private connections are visible only to you.">
      <Group title="MCP servers" add={<AddButton onClick={() => setDlg('mcp')}>Add a server</AddButton>} empty={servers && !servers.length ? 'No MCP servers yet. Add one with its URL.' : undefined}>
        <Err>{mcp.error}</Err>
        <Reveal loading={!mcp.data && !mcp.error} fallback={<Loading shape="rows" n={3} />}>{servers?.map((s) => s.builtin ? (
          <Item key={s.id} title={s.name ?? 'Browser'} chips={<Chip tone="seal">Built in</Chip>} menu={() => mi(s.enabled ? PowerOff : Power, s.enabled ? 'Turn off' : 'Turn on', () => toggle(s, !s.enabled))} {...lead(s.note ?? '')}>
            <Switch label={`${s.name ?? 'Browser'}`} checked={!!s.enabled} onChange={(on) => toggle(s, on)} />
          </Item>
        ) : (
          <Item key={s.id} title={s.name} menu={() => <>
            {mi(Zap, 'Test', () => test(s))}
            {canSignin(s) && mi(LogIn, 'Sign in', () => setSignin(s))}
            {canToken(s) && mi(KeyRound, s.connected ? 'Replace token' : 'Set token', () => setToken(s))}
            {s.mine && <><DropdownMenuSeparator />{mi(Pencil, 'Edit', () => setEdit(s))}{mi(Trash2, 'Remove…', () => removeMcp(s), true)}</>}</>} hint={<span className="font-mono text-[13px] break-all">{s.url}</span>} chips={<>
            <Chip tone={s.visibility === 'team' ? 'blue' : 'neutral'}>{s.visibility === 'team' ? 'Team' : 'Private'}</Chip>
            {s.sharedAccount && <span title="Everyone uses the same account on this server" tabIndex={0}><Chip tone="seal">Shared account</Chip></span>}
            {!s.connected ? <Chip tone="caution">Needs sign-in</Chip>
              : s.status === 'failed' ? <span title={s.error} tabIndex={0}><Chip tone="alarm">Not reachable</Chip></span>
              : s.status === 'ok' ? <Chip tone="ok">Works</Chip> : <Chip tone="neutral">Not tested</Chip>}
            {s.agents === false && <span title="Agents reach streamable HTTP servers only; this one uses SSE." tabIndex={0}><Chip tone="caution">Not for agents</Chip></span>}</>}>
                {s.status === 'failed' && s.error && <span className="basis-full text-[13px] text-danger-ink">{s.error}</span>}
                {s.agents !== false && <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">In plain chats<Switch label={`Give ${s.name} to plain-agent chats`} checked={s.on !== false} onChange={(on) => give(s, on)} /></span>}
                {s.mine && <Button variant="outline" onClick={() => setEdit(s)}><Pencil size={14} aria-hidden />Edit</Button>}
                <Button variant="outline" onClick={() => test(s)} disabled={testing === s.id}>{testing === s.id ? <Spinner className="size-3.5" aria-hidden /> : <Zap size={14} aria-hidden />}Test</Button>
                {canSignin(s) && <Button variant="outline" onClick={() => setSignin(s)}><LogIn size={14} aria-hidden />Sign in</Button>}
                {canToken(s) && <Button variant="outline" onClick={() => setToken(s)}><KeyRound size={14} aria-hidden />{s.connected ? 'Replace token' : 'Set token'}</Button>}
                {s.mine && <Button variant="ghost" size="icon" className="text-muted-foreground hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${s.name}`} onClick={() => removeMcp(s)}><Trash2 size={15} /></Button>}
          </Item>
        ))}</Reveal>
      </Group>
      {dlg === 'mcp' && <McpDialog team={team} onClose={() => setDlg(undefined)} onDone={() => done('Server added')} />}
      {edit && (
        <Dialog title={`Edit ${edit.name}`} onClose={() => setEdit(undefined)} wide>
          <EditMcp s={edit} team={team} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); done('Saved'); }} />
        </Dialog>
      )}
      {token && (
        <Dialog title={`${token.connected ? 'Replace' : 'Set'} the token for ${token.name}`} onClose={() => setToken(undefined)}>
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            try { await trpc.connectors.mcp.setBearer.mutate({ id: token.id, bearer: String(new FormData(e.currentTarget).get('bearer')) }); setToken(undefined); done('Token saved'); } catch (x) { toast((x as Error).message, true); }
          }}>
            <Field label="Bearer token"><Input name="bearer" type="password" required autoComplete="off" autoFocus /></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setToken(undefined)}>Cancel</Button><Button type="submit">Save token</Button></div>
          </form>
        </Dialog>
      )}
      {signin && <Dialog title={`Sign in to ${signin.name}`} onClose={() => setSignin(undefined)} wide><McpSignin id={signin.id} onDone={() => { setSignin(undefined); done('Signed in'); }} /></Dialog>}
      {del && <ConfirmDialog title={del.label} body="You can add it again later." action="Yes, continue" onClose={() => setDel(undefined)} onConfirm={() => del.run().catch((x) => toast(x.message, true))} />}
    </Page>
  );
}

// Change name, address, transport and who can use it. A new address means signing in again; moving it to the team needs the team permission.
function EditMcp({ s, team, onClose, onDone }: { s: Mcp; team: boolean; onClose: () => void; onDone: () => void }) {
  const [err, setErr] = useState('');
  return (
    <form className="grid gap-3" onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
      try { await trpc.connectors.mcp.update.mutate({ id: s.id, name: f.name, url: f.url, transport: f.transport, ...(f.visibility ? { visibility: f.visibility as 'private' | 'team' } : {}) }); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      <Field label="Name"><Input name="name" required defaultValue={s.name} /></Field>
      <Field label="Server URL"><Input name="url" type="url" required defaultValue={s.url} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Transport"><Select name="transport" defaultValue={s.transport}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></Select></Field>
        {(team || s.visibility === 'team') && <Field label="Who can use it"><Select name="visibility" defaultValue={s.visibility} disabled={!team}><option value="private">Only me</option><option value="team">My team</option></Select></Field>}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">If you change the address, the saved token or sign-in is dropped: they never follow a server to another address.</p>
      <Err>{err}</Err>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Save</Button></div>
    </form>
  );
}

function McpDialog({ team, onClose, onDone }: { team: boolean; onClose: () => void; onDone: () => void }) {
  const [auth, setAuth] = useState('none');
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<string>();
  return (
    <Dialog title="Add an MCP server" onClose={onClose} wide>
      {created ? (
        <>
          <p className="text-sm text-muted-foreground">Server saved. Sign in so hefyn can use it.</p>
          <McpSignin id={created} onDone={onDone} />
          <div className="flex justify-end"><Button variant="outline" onClick={onDone}>Skip for now</Button></div>
        </>
      ) : (
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
          try {
            const r = await trpc.connectors.mcp.create.mutate({ name: f.name, url: f.url, transport: f.transport, auth, bearer: auth === 'bearer' ? f.token : undefined, visibility: f.visibility ?? 'private' });
            auth === 'oauth' ? setCreated(r.id) : onDone();
          } catch (x) { setErr((x as Error).message); }
        }}>
          <Field label="Name"><Input name="name" required /></Field>
          <Field label="Server URL"><Input name="url" type="url" required placeholder="https://mcp.example.com/mcp" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Transport"><Select name="transport" defaultValue="streamable-http"><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></Select></Field>
            <Field label="Authentication"><Select value={auth} onChange={(e) => setAuth(e.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option><option value="oauth">OAuth sign-in</option></Select></Field>
          </div>
          {auth === 'bearer' && <Field label="Bearer token"><Input name="token" type="password" required autoComplete="off" /></Field>}
          {team && <Field label="Who can use it"><Select name="visibility" defaultValue="private"><option value="private">Only me</option><option value="team">My team</option></Select></Field>}
          <Err>{err}</Err>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Add server</Button></div>
        </form>
      )}
    </Dialog>
  );
}

// MCP OAuth: start returns { connected } or { authUrl }; the callback page runs in the new tab, so we poll the list.
function McpSignin({ id, onDone }: { id: string; onDone: () => void }) {
  return <OAuthFlow label="Sign in" onDone={onDone}
    start={async () => { const r: { connected?: boolean; authUrl?: string } = await trpc.connectors.mcp.oauthStart.mutate({ id }); if (r.connected) onDone(); return { flowId: id, authUrl: r.authUrl, needsPaste: false, state: 'pending' } as Start; }}
    status={async () => ({ state: (await trpc.connectors.mcp.list.query()).find((m) => m.id === id)?.connected ? 'done' : 'pending' })} />;
}

