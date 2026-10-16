import { Loader2, LogIn, KeyRound, Plug, Plus, Server, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { api, can, useLoad } from './api';
import { ConnectModelDialog, OAuthFlow, type Start } from './ConnectModel';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, Dialog, Empty, Err, Field, Input, Page, Row, Section, Select, Switch, toast } from './ui';

// Shapes follow src/server/connectors-routes.ts.
interface ModelConn { provider: string; name: string; kind: string; baseUrl?: string | null; createdAt: string }
interface Mcp { id: string; name: string; url: string; transport: string; auth: string; visibility: 'private' | 'team'; mine: boolean; connected: boolean; sharedAccount?: boolean; builtin?: boolean; enabled?: boolean; note?: string }

export default function Connectors() {
  return <Shell>{(me, rt) => <Content team={can(me, 'profiles.edit_team')} managed={can(me, 'mcp.run_managed')} imagesAllowed={rt?.privacy?.imagesAllowed} />}</Shell>;
}


function Content({ team, managed, imagesAllowed }: { team: boolean; managed: boolean; imagesAllowed?: boolean }) {
  const models = useLoad<ModelConn[]>('/api/connectors/models');
  const mcp = useLoad<Mcp[]>('/api/connectors/mcp');
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
  const done = (msg: string) => { setDlg(undefined); toast(msg); models.reload(); mcp.reload(); dispatchEvent(new Event('hefyn-me')); };
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

// MCP OAuth: start returns { connected } or { authUrl }; the callback page runs in the new tab, so we poll the list.
function McpSignin({ id, onDone }: { id: string; onDone: () => void }) {
  return <OAuthFlow label="Sign in" onDone={onDone}
    start={async () => { const r = await api<{ connected?: boolean; authUrl?: string }>(`/api/connectors/mcp/${id}/oauth/start`, 'POST', {}); if (r.connected) onDone(); return { flowId: id, authUrl: r.authUrl, needsPaste: false, state: 'pending' } as Start; }}
    status={async () => ({ state: (await api<Mcp[]>('/api/connectors/mcp')).find((m) => m.id === id)?.connected ? 'done' : 'pending' })} />;
}

