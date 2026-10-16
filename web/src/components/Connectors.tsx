import { Cable, HardDrive, Loader2, LogIn, KeyRound, Plug, Plus, Server, Trash2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, can, useLoad } from './api';
import { ConnectModelDialog, OAuthFlow, type Start } from './ConnectModel';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, Dialog, Empty, Err, Field, Input, Page, Row, Section, Select, Switch, toast } from './ui';

// Shapes follow src/server/connectors-routes.ts.
interface ModelConn { provider: string; name: string; kind: string; baseUrl?: string | null; createdAt: string }
interface Mcp { id: string; name: string; url: string; transport: string; auth: string; visibility: 'private' | 'team'; mine: boolean; connected: boolean; sharedAccount?: boolean; builtin?: boolean; enabled?: boolean; note?: string }

interface Addon { id: string; name: string; kind: 'webdav' | 'mcp'; visibility: 'private' | 'team'; mine: boolean; mount: string; url?: string; sharedAccount?: boolean; connector?: string; connected: boolean }

export default function Connectors() {
  return <Shell>{(me, rt) => <Content team={can(me, 'profiles.edit_team')} managed={can(me, 'mcp.run_managed')} imagesAllowed={rt?.privacy?.imagesAllowed} />}</Shell>;
}


function Content({ team, managed, imagesAllowed }: { team: boolean; managed: boolean; imagesAllowed?: boolean }) {
  const models = useLoad<ModelConn[]>('/api/connectors/models');
  const mcp = useLoad<Mcp[]>('/api/connectors/mcp');
  const addons = useLoad<Addon[]>('/api/storage-addons');
  const [storageDlg, setStorageDlg] = useState(false);
  const [login, setLogin] = useState<Addon>();
  const [testingAddon, setTestingAddon] = useState<string>();
  useEffect(() => { if (location.hash === '#storage' && addons.data) document.getElementById('storage')?.scrollIntoView(); }, [!!addons.data]);
  const testAddon = async (a: Addon) => {
    setTestingAddon(a.id);
    try { const r = await api<{ ok: boolean; entries?: number; readonly?: boolean; error?: string }>(`/api/storage-addons/${a.id}/test`, 'POST', {}); toast(r.ok ? `${a.name} works. ${r.entries} items in the top folder${r.readonly ? ' (read only)' : ''}.` : `${a.name} did not answer: ${r.error ?? 'connection failed'}`, !r.ok); }
    catch (x) { toast(`${a.name} did not answer: ${(x as Error).message}`, true); }
    setTestingAddon(undefined);
  };
  const [dlg, setDlg] = useState<'model' | 'mcp' | undefined>(location.hash === '#connect' ? 'model' : undefined);
  const [signin, setSignin] = useState<Mcp>();
  const [token, setToken] = useState<Mcp>();
  const [testing, setTesting] = useState<string>();
  const test = async (s: Mcp) => {
    setTesting(s.id);
    try { const r = await api<{ ok: boolean; tools?: string[]; error?: string }>(`/api/connectors/mcp/${s.id}/test`, 'POST', {}); toast(r.ok ? `${s.name} works. ${r.tools?.length ?? 0} tools found.` : `${s.name} did not answer: ${r.error ?? 'connection failed'}`, !r.ok); }
    catch (x) { toast(`${s.name} did not answer: ${(x as Error).message}`, true); }
    setTesting(undefined);
  };
  const [del, setDel] = useState<{ label: string; run: () => Promise<unknown> }>();
  const done = (msg: string) => { setDlg(undefined); toast(msg); models.reload(); mcp.reload(); addons.reload(); dispatchEvent(new Event('hefyn-me')); };
  const servers = mcp.data?.filter((s) => !s.builtin || managed);
  return (
    <Page title="Connectors" hint="Connect your own model accounts and the tools hefyn can use for you. Private connections are visible only to you.">
      <Section title="Model accounts">
        <Err>{models.error}</Err>
        {models.data && !models.data.length ? <Empty icon={<Plug size={26} />} action={<button className={buttonPrimary} onClick={() => setDlg('model')}>Connect a model</button>}>You have not connected a personal model account yet.</Empty> : models.data && <>
          {models.data.map((c) => (
            <Row key={c.provider} wide title={c.name} hint={`Connected on ${new Date(c.createdAt).toLocaleDateString()}`}>
              <div className="flex items-center gap-2"><Chip>{c.kind === 'oauth' ? 'Signed in' : 'API key'}</Chip><span className="grow" />
                <button className={buttonDanger} onClick={() => setDel({ label: `Disconnect ${c.name}?`, run: () => api(`/api/connectors/models/${c.provider}`, 'DELETE').then(() => done('Disconnected')) })}>Disconnect</button></div>
            </Row>
          ))}
          <div className="py-4"><button className={buttonGhost} onClick={() => setDlg('model')}><Plus size={15} aria-hidden />Connect a model</button></div></>}
      </Section>
      <Section title="MCP servers">
        <Err>{mcp.error}</Err>
        {servers && !servers.length ? <Empty icon={<Server size={26} />} action={<button className={buttonPrimary} onClick={() => setDlg('mcp')}>Add a server</button>}>No MCP servers yet. Add one with its URL.</Empty> : servers && <>
          {servers.map((s) => s.builtin ? (
            <Row key={s.id} wide title={s.name ?? 'Browser'} hint={(s.note ?? (imagesAllowed === false ? 'Screenshots are removed before sending. The model works from the page’s text snapshot.' : undefined))}>
              <div className="flex items-center gap-3"><Chip tone="seal">Built in</Chip><span className="grow" />
                <Switch label={`${s.name ?? 'Browser'}`} checked={!!s.enabled} onChange={async (on) => { try { await api(`/api/connectors/mcp/${s.id}/${on ? 'enable' : 'disable'}`, 'POST', {}); toast(on ? 'Turned on' : 'Turned off'); mcp.reload(); } catch (x) { toast((x as Error).message, true); } }} /></div>
            </Row>
          ) : (
            <Row key={s.id} wide title={s.name} hint={<span className="font-mono text-[13px] break-all">{s.url}</span>}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={s.visibility === 'team' ? 'blue' : 'neutral'}>{s.visibility === 'team' ? 'Team' : 'Private'}</Chip>
                {s.sharedAccount && <span title="Everyone uses the same account on this server" tabIndex={0}><Chip tone="seal">Shared account</Chip></span>}
                <Chip tone={s.connected ? 'ok' : 'caution'}>{s.connected ? 'Connected' : 'Needs sign-in'}</Chip>
                <span className="grow" />
                <button className={buttonGhost} onClick={() => test(s)} disabled={testing === s.id}>{testing === s.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Zap size={14} aria-hidden />}Test</button>
                {!s.connected && s.auth === 'oauth' && (s.mine || s.visibility === 'team') && <button className={buttonGhost} onClick={() => setSignin(s)}><LogIn size={14} aria-hidden />Sign in</button>}
                {s.auth === 'bearer' && s.mine && (!s.sharedAccount || team) && <button className={buttonGhost} onClick={() => setToken(s)}><KeyRound size={14} aria-hidden />{s.connected ? 'Replace token' : 'Set token'}</button>}
                {s.mine && <button className="rounded-lg p-2 text-muted hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${s.name}`} onClick={() => setDel({ label: `Remove ${s.name}?`, run: () => api(`/api/connectors/mcp/${s.id}`, 'DELETE').then(() => done('Removed')) })}><Trash2 size={15} /></button>}
              </div>
            </Row>
          ))}
          <div className="py-4"><button className={buttonGhost} onClick={() => setDlg('mcp')}><Plus size={15} aria-hidden />Add a server</button></div></>}
      </Section>
      <div id="storage"><Section title="Storage">
        <Err>{addons.error}</Err>
        {addons.data && !addons.data.length ? <Empty icon={<HardDrive size={26} />} action={<button className={buttonPrimary} onClick={() => setStorageDlg(true)}>Add storage</button>}>No external storage yet. Connect Nextcloud, ownCloud or a NAS (WebDAV), or an MCP server with file tools. It shows up as a folder in Files and agents can read and write there.</Empty> : addons.data && <>
          {addons.data.map((a) => (
            <Row key={a.id} wide title={<span className="inline-flex items-center gap-2"><Cable size={15} aria-hidden className="text-seal" />{a.name}</span>} hint={<span className="font-mono text-[13px] break-all">{a.mount}{a.url ? ` · ${a.url}` : a.connector ? ` · via ${a.connector}` : ''}</span>}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="seal">{a.kind === 'webdav' ? 'WebDAV' : 'MCP storage'}</Chip>
                <Chip tone={a.visibility === 'team' ? 'blue' : 'neutral'}>{a.visibility === 'team' ? 'Team' : 'Private'}</Chip>
                {a.sharedAccount && <span title="Everyone uses the same account on this storage" tabIndex={0}><Chip tone="seal">Shared account</Chip></span>}
                <Chip tone={a.connected ? 'ok' : 'caution'}>{a.connected ? 'Connected' : 'Needs sign-in'}</Chip>
                <span className="grow" />
                <button className={buttonGhost} onClick={() => testAddon(a)} disabled={testingAddon === a.id}>{testingAddon === a.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Zap size={14} aria-hidden />}Test</button>
                {a.kind === 'webdav' && (!a.sharedAccount || team) && <button className={buttonGhost} onClick={() => setLogin(a)}><KeyRound size={14} aria-hidden />{a.connected ? 'Replace login' : 'Set login'}</button>}
                {a.mine && <button className="rounded-lg p-2 text-muted hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${a.name}`} onClick={() => setDel({ label: `Remove ${a.name}?`, run: () => api(`/api/storage-addons/${a.id}`, 'DELETE').then(() => done('Removed')) })}><Trash2 size={15} /></button>}
              </div>
            </Row>
          ))}
          <div className="py-4"><button className={buttonGhost} onClick={() => setStorageDlg(true)}><Plus size={15} aria-hidden />Add storage</button></div></>}
      </Section></div>
      {storageDlg && <StorageDialog team={team} servers={(mcp.data ?? []).filter((s) => !s.builtin && (s.visibility === 'team' ? team : s.mine) && !addons.data?.some((a) => a.kind === 'mcp' && a.connector === s.name))} onClose={() => setStorageDlg(false)} onDone={() => { setStorageDlg(false); done('Storage added'); }} />}
      {login && (
        <Dialog title={`${login.connected ? 'Replace' : 'Set'} the login for ${login.name}`} onClose={() => setLogin(undefined)}>
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
            try { await api(`/api/storage-addons/${login.id}/credentials`, 'PUT', f); setLogin(undefined); done('Login saved'); } catch (x) { toast((x as Error).message, true); }
          }}>
            <Field label="Username"><Input name="username" required autoComplete="off" autoFocus /></Field>
            <Field label="App password"><Input name="password" type="password" required autoComplete="off" /></Field>
            <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={() => setLogin(undefined)}>Cancel</button><button className={buttonPrimary}>Save login</button></div>
          </form>
        </Dialog>
      )}
      {dlg === 'model' && <ConnectModelDialog scope="me" onClose={() => setDlg(undefined)} onDone={() => done('Connected')} />}
      {dlg === 'mcp' && <McpDialog team={team} onClose={() => setDlg(undefined)} onDone={() => done('Server added')} />}
      {token && (
        <Dialog title={`${token.connected ? 'Replace' : 'Set'} the token for ${token.name}`} onClose={() => setToken(undefined)}>
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            try { await api(`/api/connectors/mcp/${token.id}/bearer`, 'PUT', { bearer: String(new FormData(e.currentTarget).get('bearer')) }); setToken(undefined); done('Token saved'); } catch (x) { toast((x as Error).message, true); }
          }}>
            <Field label="Bearer token"><Input name="bearer" type="password" required autoComplete="off" autoFocus /></Field>
            <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={() => setToken(undefined)}>Cancel</button><button className={buttonPrimary}>Save token</button></div>
          </form>
        </Dialog>
      )}
      {signin && <Dialog title={`Sign in to ${signin.name}`} onClose={() => setSignin(undefined)} wide><McpSignin id={signin.id} onDone={() => { setSignin(undefined); done('Signed in'); }} /></Dialog>}
      {del && <ConfirmDialog title={del.label} body="You can add it again later." action="Yes, continue" onClose={() => setDel(undefined)} onConfirm={() => del.run().catch((x) => toast(x.message, true))} />}
    </Page>
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
          <p className="text-sm text-muted">Server saved. Sign in so hefyn can use it.</p>
          <McpSignin id={created} onDone={onDone} />
          <div className="flex justify-end"><button className={buttonGhost} onClick={onDone}>Skip for now</button></div>
        </>
      ) : (
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
          try {
            const r = await api<{ id: string }>('/api/connectors/mcp', 'POST', { name: f.name, url: f.url, transport: f.transport, auth, bearer: auth === 'bearer' ? f.token : undefined, visibility: f.visibility ?? 'private' });
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
          <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={onClose}>Cancel</button><button className={buttonPrimary}>Add server</button></div>
        </form>
      )}
    </Dialog>
  );
}

function StorageDialog({ team, servers, onClose, onDone }: { team: boolean; servers: Mcp[]; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'webdav' | 'mcp'>('webdav');
  const [visibility, setVisibility] = useState('private');
  const [err, setErr] = useState('');
  return (
    <Dialog title="Add storage" onClose={onClose} wide>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault(); setErr('');
        const f = Object.fromEntries(new FormData(e.currentTarget) as any) as Record<string, string>;
        try { await api('/api/storage-addons', 'POST', { kind, name: f.name || undefined, url: f.url, username: f.username, password: f.password, connectorId: f.connectorId, visibility: f.visibility ?? 'private', sharedAccount: f.sharedAccount === 'on' }); onDone(); } catch (x) { setErr((x as Error).message); }
      }}>
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as 'webdav' | 'mcp')}><option value="webdav">WebDAV (Nextcloud, ownCloud, NAS)</option><option value="mcp">Use an MCP server as storage</option></Select></Field>
        <Field label="Folder name"><Input name="name" required={kind === 'webdav'} pattern="[a-z0-9][a-z0-9\-]{0,39}" placeholder="nextcloud" title="Lowercase letters, digits and dashes. Agents see it as /files/<name>." /></Field>
        {kind === 'webdav' ? <>
          <Field label="WebDAV URL"><Input name="url" type="url" required placeholder="https://cloud.example.com/remote.php/dav/files/ada/" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username"><Input name="username" required autoComplete="off" /></Field>
            <Field label="App password"><Input name="password" type="password" required autoComplete="off" /></Field>
          </div>
          <p className="text-xs text-muted">Use an app password, not your main password. It is stored encrypted and only used for your own requests. Only https addresses are accepted.</p>
        </> : <>
          <Field label="MCP server"><Select name="connectorId" required defaultValue="">{<option value="" disabled>Choose a server</option>}{servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <p className="text-xs text-muted">The server must offer the file tools of the MCP filesystem server (list_directory, read_text_file, write_file and so on). Without write tools the folder is read only. Only text files work.</p>
        </>}
        {team && kind === 'webdav' && <Field label="Who can use it"><Select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="private">Only me</option><option value="team">My team (everyone signs in with their own login)</option></Select></Field>}
        {team && kind === 'webdav' && visibility === 'team' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sharedAccount" className="size-4 accent-foreground" />Everyone uses this one account (shared login)</label>}
        <Err>{err}</Err>
        <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={onClose}>Cancel</button><button className={buttonPrimary}>Add storage</button></div>
      </form>
    </Dialog>
  );
}

// MCP OAuth: start returns { connected } or { authUrl }; the callback page runs in the new tab, so we poll the list.
function McpSignin({ id, onDone }: { id: string; onDone: () => void }) {
  return <OAuthFlow label="Sign in" onDone={onDone}
    start={async () => { const r = await api<{ connected?: boolean; authUrl?: string }>(`/api/connectors/mcp/${id}/oauth/start`, 'POST', {}); if (r.connected) onDone(); return { flowId: id, authUrl: r.authUrl, needsPaste: false, state: 'pending' } as Start; }}
    status={async () => ({ state: (await api<Mcp[]>('/api/connectors/mcp')).find((m) => m.id === id)?.connected ? 'done' : 'pending' })} />;
}

