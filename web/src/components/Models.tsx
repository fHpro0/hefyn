import { LogIn, Plug, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, can, useLoad, type Runtime } from './api';
import { ConnectModelDialog } from './ConnectModel';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, Empty, Err, Page, Row, Section, Select, Switch, toast } from './ui';

interface ProviderList { available: { id: string; name: string }[]; connected: (string | { id: string; name?: string; kind?: string; status?: string })[] }
interface Connected { provider: string; name: string; models: { id: string; name: string }[] }
interface Profile { model: string | null; agents: { name: string; description: string; model: string | null }[] }

export default function Models() {
  return <Shell>{(me, rt) => <Content rt={rt} admin={can(me, 'models.manage')} />}</Shell>;
}

function Content({ rt, admin }: { rt?: Runtime; admin: boolean }) {
  const providers = useLoad<ProviderList>('/api/models/providers');
  const models = useLoad<Connected[]>('/api/models');
  const profile = useLoad<Profile>('/api/profile');
  const [connect, setConnect] = useState<string>(); // undefined = closed, '' = pick a provider, id = sign in again
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<{ model?: string; agents: Record<string, string> }>({ agents: {} });
  const [restart, setRestart] = useState(false);
  const [confirmImages, setConfirmImages] = useState(false);
  const reloadAll = () => { dispatchEvent(new Event('hefyn-me')); providers.reload(); models.reload(); profile.reload(); };
  // `connected` is a list of ids, or of { id, kind, status } once the backend reports them
  const conns = (providers.data?.connected ?? []).map((c) => typeof c === 'string' ? { id: c, kind: 'api_key', status: 'ok' } : { kind: 'api_key', status: 'ok', ...c })
    .map((c) => ({ ...c, name: (c as { name?: string }).name ?? providers.data?.available.find((p) => p.id === c.id)?.name ?? c.id }));
  const all = models.data?.flatMap((p) => p.models) ?? [];
  const model = pick.model ?? profile.data?.model ?? '';
  const options = models.data?.map((p) => <optgroup key={p.provider} label={p.name}>{p.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>);
  const setImages = async (allowImages: boolean) => { try { await api('/api/settings/privacy', 'POST', { allowImages }); toast(allowImages ? 'Images are now sent unredacted' : 'Images are removed before sending'); } catch (x) { toast((x as Error).message, true); } dispatchEvent(new Event('hefyn-rt')); };
  const privacy = rt?.privacy;

  return (
    <Page title="Models" hint="Choose which providers and models hefyn can use, and how personal data is protected on the way.">
      <Section title="Providers">
        {!conns.length ? (
          <Empty icon={<Plug size={26} />} action={<button className={buttonPrimary} onClick={() => setConnect('')}>Connect a model</button>}>
            Connect your first model. Sign in with your Claude, ChatGPT or Copilot account, or use an API key.
          </Empty>
        ) : (
          <>
            {conns.map((c) => (
              <div key={c.id} className="flex items-center gap-4 border-b border-line py-4">
                <div className="min-w-0 grow">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{c.name}</span>
                    <Chip tone={c.status === 'ok' ? 'ok' : 'alarm'}>{c.status === 'ok' ? 'Working' : c.status === 'expired' ? 'Sign-in expired' : 'Needs attention'}</Chip></div>
                  <p className="mt-0.5 text-sm text-soft">{c.kind === 'oauth' ? 'Signed in with an account' : 'Connected with an API key'}</p>
                </div>
                {c.kind === 'oauth' && c.status !== 'ok' && <button className={buttonGhost} onClick={() => setConnect(c.id)}><LogIn size={14} aria-hidden />Sign in again</button>}
                <button className="rounded-[10px] p-2 text-soft hover:bg-alarm/10 hover:text-alarm-ink" aria-label={`Remove ${c.name}`} onClick={async () => { await api(`/api/models/providers/${c.id}`, 'DELETE'); toast(`Removed ${c.name}`); reloadAll(); }}><Trash2 size={15} /></button>
              </div>
            ))}
            <div className="py-4"><button className={buttonGhost} onClick={() => setConnect('')}><Plus size={15} aria-hidden />Connect a model</button></div>
          </>
        )}
      </Section>

      <Section title="Default models">
        {!all.length ? <Row title="Orchestrator" hint="The model that plans the work and writes the answer."><p className="text-sm text-soft">Connect a provider first.</p></Row> : (
          <form onSubmit={async (e) => {
            e.preventDefault(); setErr('');
            try { await api('/api/profile', 'PUT', { model, agents: Object.fromEntries((profile.data?.agents ?? []).map((a) => [a.name, pick.agents[a.name] ?? a.model ?? null])) }); toast('Saved'); profile.reload(); }
            catch (x) { setErr((x as Error).message); toast('Could not save. Check the message below.', true); }
          }}>
            <Row title="Orchestrator" hint="The model that plans the work and writes the answer.">
              <Select aria-label="Orchestrator model" value={model} required onChange={(e) => setPick({ ...pick, model: e.target.value })}><option value="" disabled>Choose a model</option>{options}</Select>
            </Row>
            {profile.data?.agents.map((a) => (
              <Row key={a.name} title={<span className="capitalize">{a.name}</span>} hint={a.description}>
                <Select aria-label={`Model for ${a.name}`} value={pick.agents[a.name] ?? a.model ?? ''} onChange={(e) => setPick({ ...pick, agents: { ...pick.agents, [a.name]: e.target.value } })}><option value="">Same as orchestrator</option>{options}</Select>
              </Row>
            ))}
            <div className="grid gap-3 py-5"><Err>{err}</Err><div className="flex items-center gap-4"><button className={buttonPrimary}>Save</button>{profile.data?.model && <a className="text-sm text-hefyn hover:underline" href="/settings/users">Next: add your team</a>}</div></div>
          </form>
        )}
      </Section>

      {admin && privacy && (
        <Section title="Privacy">
          <Row title="Redaction" hint="Personal data is replaced with seals before a request leaves hefyn."><Chip tone={privacy.gliner ? 'ok' : 'alarm'}>{privacy.gliner ? 'Pattern, entropy and GLiNER checks on' : 'GLiNER is off'}</Chip></Row>
          <Row title="Egress" hint="Model traffic leaves hefyn only through the hefyn proxy."><Chip tone="ok">Enforced</Chip></Row>
          <Row title="Send images to models unredacted" hint="GLiNER cannot read images, so personal data inside them would reach the model. While this is off, images such as browser screenshots are removed before sending.">
            <Switch label="Send images to models unredacted" tone="caution" checked={privacy.imagesAllowed} onChange={(on) => (on ? setConfirmImages(true) : setImages(false))} />
          </Row>
        </Section>
      )}

      {admin && (
        <Section title="Agents">
          <Row title="Restart agents" hint={`Applies provider changes. Sending pauses until running tasks finish${rt?.runningTasks ? `, ${rt.runningTasks} running now` : ''}.${rt?.requestedAt ? ` Requested by ${rt.requestedBy} on ${new Date(rt.requestedAt).toLocaleString()}.` : ''}`}>
            <div className="flex items-center gap-3"><Chip tone={rt?.state === 'running' ? 'ok' : 'seal'}>{rt?.state === 'running' ? 'Running' : rt?.state === 'draining' ? 'Finishing tasks' : rt?.state === 'restarting' ? 'Restarting' : 'Unknown'}</Chip>
              <button className={buttonGhost} disabled={!!rt && rt.state !== 'running'} onClick={() => setRestart(true)}><RotateCw size={14} aria-hidden />Restart agents</button></div>
          </Row>
        </Section>
      )}

      {connect !== undefined && <ConnectModelDialog scope="company" initial={connect || undefined} onClose={() => setConnect(undefined)} onDone={() => { setConnect(undefined); toast('Model connected'); reloadAll(); }} />}
      {confirmImages && <ConfirmDialog danger={false} title="Send images unredacted?" body="Images are not checked for personal data. Screenshots and uploaded pictures will reach the model as they are." action="Turn on" onClose={() => setConfirmImages(false)} onConfirm={() => setImages(true)} />}
      {restart && <ConfirmDialog title="Restart the agents?" body="Sending is paused for everyone until running tasks finish and the agents are back." action="Restart" onClose={() => setRestart(false)}
        onConfirm={async () => { try { await api('/api/runtime/restart', 'POST'); toast('Restart requested'); } catch (x) { toast((x as Error).message, true); } dispatchEvent(new Event('hefyn-rt')); }} />}
    </Page>
  );
}
