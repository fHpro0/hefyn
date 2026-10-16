import { LogIn, Plug, Plus, RotateCw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, can, useLoad, type Runtime } from './api';
import { ConnectModelDialog } from './ConnectModel';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, Empty, Err, Page, Row, Section, Select, Switch, toast } from './ui';

interface ProviderList { available: { id: string; name: string }[]; connected: (string | { id: string; name?: string; kind?: string; status?: string })[] }
interface Connected { provider: string; name: string; models: { id: string; name: string }[] }
interface Profile { model: string | null; agents: { name: string; description: string; model: string | null }[] }

const SOURCE_LABEL = { huggingface: 'Downloaded from Hugging Face', mirror: 'Downloaded from a mirror', image: 'Built into the image', local: 'Provided by you' } as const;
const STATE_LABEL = { ready: 'Ready', missing: 'Files missing', downloading: 'Downloading', invalid: 'Files invalid', error: 'Download failed' } as const;

// Where the GLiNER model comes from and whether it is in place; with source "local" the admin can upload the files (verified server-side).
function GlinerSource({ privacy }: { privacy: NonNullable<Runtime['privacy']> }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number>();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const { glinerSource: source, glinerState: state, glinerDetail: detail, glinerHost: host } = privacy;
  if (!source || !state) return null;
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/settings/privacy/gliner/upload');
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      setProgress(undefined);
      let j: { error?: string; state?: string } = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      setResult(xhr.status < 300 ? { ok: true, text: j.state === 'ready' ? 'Model files verified and saved. The redaction service picks them up in a few seconds.' : 'Files verified and saved. The other model file is still missing.' } : { ok: false, text: j.error ?? `Upload failed (HTTP ${xhr.status})` });
      dispatchEvent(new Event('hefyn-rt'));
    };
    xhr.onerror = () => { setProgress(undefined); setResult({ ok: false, text: 'Upload failed: the connection was interrupted.' }); };
    setResult(undefined); setProgress(0);
    xhr.send(form);
    if (input.current) input.current.value = '';
  };
  const hint = `${SOURCE_LABEL[source]}${host ? ` (${host})` : ''}.${detail && state !== 'ready' ? ` ${detail}` : ''}`;
  return (
    <Row title="GLiNER model" hint={hint}>
      <div className="flex flex-col items-end gap-2">
        <Chip tone={state === 'ready' ? 'ok' : state === 'downloading' ? 'seal' : 'alarm'}>{STATE_LABEL[state]}</Chip>
        {source === 'local' && state !== 'ready' && (
          <div className="flex items-center gap-3">
            <input ref={input} type="file" multiple accept=".json,.onnx,.tar,.zip" className="sr-only" aria-label="GLiNER model files" onChange={(e) => upload(e.target.files)} />
            <button className={buttonGhost} disabled={progress !== undefined} onClick={() => input.current?.click()}><Upload size={14} aria-hidden />{progress !== undefined ? `Uploading ${progress}%` : 'Upload model files'}</button>
          </div>
        )}
        {progress !== undefined && <progress className="h-1 w-40" max={100} value={progress} aria-label="Upload progress" />}
        {result && <p role="status" className={`max-w-sm text-right text-sm ${result.ok ? 'text-muted' : 'text-danger-ink'}`}>{result.text}</p>}
      </div>
    </Row>
  );
}

export default function Models() {
  return <Shell>{(me, rt) => <Content rt={rt} admin={can(me, 'models.manage')} />}</Shell>;
}

function Content({ rt, admin }: { rt?: Runtime; admin: boolean }) {
  const providers = useLoad<ProviderList>('/api/models/providers');
  const models = useLoad<Connected[]>('/api/models');
  const profile = useLoad<Profile>('/api/profile');
  const [connect, setConnect] = useState<string | undefined>(location.hash === '#connect' ? '' : undefined); // undefined = closed, '' = pick a provider, id = sign in again
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
              <div key={c.id} className="flex items-center gap-4 border-b border-border py-4">
                <div className="min-w-0 grow">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{c.name}</span>
                    <Chip tone={c.status === 'ok' ? 'ok' : 'alarm'}>{c.status === 'ok' ? 'Working' : c.status === 'expired' ? 'Sign-in expired' : 'Needs attention'}</Chip></div>
                  <p className="mt-0.5 text-sm text-muted">{c.kind === 'oauth' ? 'Signed in with an account' : 'Connected with an API key'}</p>
                </div>
                {c.kind === 'oauth' && c.status !== 'ok' && <button className={buttonGhost} onClick={() => setConnect(c.id)}><LogIn size={14} aria-hidden />Sign in again</button>}
                <button className="rounded-lg p-2 text-muted hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${c.name}`} onClick={async () => { await api(`/api/models/providers/${c.id}`, 'DELETE'); toast(`Removed ${c.name}`); reloadAll(); }}><Trash2 size={15} /></button>
              </div>
            ))}
            <div className="py-4"><button className={buttonGhost} onClick={() => setConnect('')}><Plus size={15} aria-hidden />Connect a model</button></div>
          </>
        )}
      </Section>

      <Section title="Default models">
        {!all.length ? <Row title="Orchestrator" hint="The model that plans the work and writes the answer."><p className="text-sm text-muted">Connect a provider first.</p></Row> : (
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
            <div className="grid gap-3 py-5"><Err>{err}</Err><div className="flex items-center gap-4"><button className={buttonPrimary}>Save</button>{profile.data?.model && <a className="text-sm text-foreground underline underline-offset-2" href="/settings/users">Next: add your team</a>}</div></div>
          </form>
        )}
      </Section>

      {admin && privacy && (
        <Section title="Privacy">
          <Row title="Redaction" hint="Personal data is replaced with seals before a request leaves hefyn."><Chip tone={privacy.gliner ? 'ok' : 'alarm'}>{privacy.gliner ? 'Pattern, entropy and GLiNER checks on' : 'GLiNER is off'}</Chip></Row>
          <GlinerSource privacy={privacy} />
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
