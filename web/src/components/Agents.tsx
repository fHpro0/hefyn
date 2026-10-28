import { Bot, ChevronDown, ExternalLink, KeyRound, Plus, RotateCw, Trash2, Upload } from 'lucide-react';
import { AgentIcon } from './AgentChoice';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useQuery } from './api';
import { ApiKeyDialog } from './ConnectModel';
import { ConfirmDialog, Dialog } from './dialogs';
import { toast } from './toast';
import { API_PROVIDER, actsWithoutAskingText, sourceLabel, usedBy, type CatalogAgent } from './agent-catalog';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import { Chip, Empty, Err, Loading, Reveal, Row, Section, Select, Switch } from './ui';
import ModelPicker, { type ModelOption } from './model-picker';
import type { ProviderChoice } from './assistants/parts';

const rpc = trpc;

interface Conn { id: string; name: string; kind: string; status: string; deprecated?: boolean }
interface ProviderList { available: { id: string; name: string }[]; connected: (string | Partial<Conn> & { id: string })[] }

/** Settings → Agents & keys: the hosted agents, and the API keys they run on. */
export function AgentsAndKeys() {
  const catalog = useQuery(() => rpc.agents.catalog.query() as Promise<CatalogAgent[]>);
  const providers = useQuery(() => trpc.models.providers.query() as Promise<ProviderList>);
  const list = catalog.data ?? [];
  const installing = list.some((a) => a.installed?.status === 'installing' || a.updating);
  useEffect(() => { if (!installing) return; const t = setInterval(catalog.reload, 2000); return () => clearInterval(t); }, [installing]);
  const conns: Conn[] = (providers.data?.connected ?? []).map((c) => {
    const o = typeof c === 'string' ? { id: c } : c;
    return { kind: 'api_key', status: 'ok', ...o, name: o.name ?? providers.data?.available.find((p) => p.id === o.id)?.name ?? o.id };
  });
  const reloadKeys = () => { dispatchEvent(new Event('hefyn-me')); providers.reload(); catalog.reload(); };
  return (
    <>
      <AgentsSection list={list} loading={!catalog.data && !catalog.error} error={catalog.error} keys={conns} reload={catalog.reload} />
      <KeysSection conns={conns} list={list} loading={!providers.data && !providers.error} reload={reloadKeys} />
    </>
  );
}

function AgentsSection({ list, loading, error, keys, reload }: { list: CatalogAgent[]; loading: boolean; error: string; keys: Conn[]; reload: () => void }) {
  const [add, setAdd] = useState(false);
  const [checking, setChecking] = useState(false);
  const check = async () => { setChecking(true); try { await rpc.agents.checkUpdates.mutate(); toast('Checked for updates'); } catch (x) { toast((x as Error).message, true); } setChecking(false); reload(); };
  const last = list.map((a) => a.lastChecked).filter((x): x is string => !!x).sort().pop();
  return (
    <Section title="Agents">
      <Err>{error}</Err>
      <Reveal loading={loading} fallback={<Loading shape="rows" n={3} />}>{list.map((a) => <AgentRow key={a.id} a={a} keys={keys} reload={reload} />)}</Reveal>
      <div className="flex flex-wrap items-center gap-2 py-4">
        <Button variant="outline" onClick={() => setAdd(true)}><Plus size={15} aria-hidden />Add agent</Button>
        {list.some((a) => a.installed) && <Button variant="outline" disabled={checking} onClick={check}>{checking ? <Spinner aria-hidden /> : <RotateCw size={14} aria-hidden />}Check for updates</Button>}
        {last && <span className="text-xs text-muted-foreground">Last checked {new Date(last).toLocaleString()}</span>}
      </div>
      {add && <AddAgentDialog onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(); }} />}
    </Section>
  );
}

/** Paste or upload an agent manifest (docs/MODULES.md, "Agent modules"). Anything that is not valid is refused with the reason in plain words. */
function AddAgentDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async (f?: File) => { if (f) { setText(await f.text()); setError(''); } };
  const submit = async () => {
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(text); } catch { setError('This is not valid JSON. Check for a missing comma or quote.'); return; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { setError('The manifest must be a JSON object, starting with {.'); return; }
    setBusy(true); setError('');
    try {
      const r = await rpc.agents.addModule.mutate(manifest) as { status: 'added' | 'pending'; id: string };
      toast(r.status === 'added' ? `Added ${r.id}. Install it below.` : `${r.id} is waiting for review in the Hub.`);
      onDone();
    } catch (x) { setError((x as Error).message); }
    setBusy(false);
  };
  return (
    <Dialog title="Add an agent" xl onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !text.trim()} onClick={submit}>{busy && <Spinner aria-hidden />}Add agent</Button></>}>
      <p className="text-[13px] text-muted-foreground">An agent module describes how hefyn runs a coding agent: where to get it, how to start it and which settings to write. hefyn never runs anything from it outside the sandbox, and all of the agent’s model traffic still goes through hefyn.</p>
      <label className="grid gap-1.5 text-[13px] font-medium">Manifest (JSON)
        <Textarea className="min-h-56 font-mono text-xs" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{ "kind": "agent", "id": "my-agent", … }'} /></label>
      <label className="flex w-fit items-center gap-2 text-[13px]"><Upload size={14} aria-hidden />Or upload a file
        <input type="file" accept=".json,application/json" className="text-[13px]" onChange={(e) => pick(e.target.files?.[0])} /></label>
      <Err>{error}</Err>
    </Dialog>
  );
}

function License({ a }: { a: CatalogAgent }) {
  const text = /proprietary/i.test(a.license) ? 'Proprietary licence' : a.license;
  return a.licenseUrl ? <a className="inline-flex items-center gap-0.5 underline underline-offset-2" href={a.licenseUrl} target="_blank" rel="noreferrer">{text}<ExternalLink size={11} aria-hidden /></a> : <span>{text}</span>;
}

function AgentRow({ a, keys, reload }: { a: CatalogAgent; keys: Conn[]; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast(ok); } catch (x) { toast((x as Error).message, true); } setBusy(false); reload(); };
  const inst = a.installed, mod = a.source.type !== 'builtin'; // an added agent module can be removed altogether; a built-in one only uninstalled
  const update =(patch: { enabled?: boolean; autoUpdate?: boolean; roles?: string[]; keyProvider?: string | null; defaultProvider?: string | null; defaultModel?: string | null }) => run(() => rpc.agents.update.mutate({ id: a.id, ...patch }));
  const install = () => run(() => rpc.agents.install.mutate({ id: a.id }));
  const [warn, setWarn] = useState<{ action: string; go: () => void } | null>(null);
  const sure = (action: string, go: () => void) => (a.actsWithoutAsking ? setWarn({ action, go }) : go()); // an agent that acts without asking needs a yes first
  return (
    <div className="border-b border-border py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center">{a.icon ? <AgentIcon src={a.icon} /> : <div className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground"><Bot size={16} aria-hidden /></div>}</div>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{a.name}</span>
            <span className="text-xs text-muted-foreground">{a.version}</span>
            {a.adapterVersion && a.adapterVersion !== a.version && <span className="text-xs text-muted-foreground/70">adapter {a.adapterVersion}</span>}
            {inst?.status === 'ready' && <Chip tone="ok">Ready</Chip>}
            {inst?.status === 'failed' && <Chip tone="alarm">Failed</Chip>}
            {a.actsWithoutAsking && <Chip tone="caution">Acts without asking</Chip>}
          </div>
          <p className="mt-0.5 max-w-xl text-[13px] leading-[18px] text-muted-foreground">{a.description}</p>
          {a.actsWithoutAsking && <p className="mt-0.5 max-w-xl text-[13px] leading-[18px] text-warning-ink">{actsWithoutAskingText(a.name)}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground">{sourceLabel(a.source)}{a.license && <> · <License a={a} /></>}</p>
          {inst?.status === 'ready' && !a.enabled && <p className="mt-2 text-[13px] text-muted-foreground">Installed. Turn on “Available to users” so people can pick it.</p>}
          {inst?.status === 'installing' && <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-3.5" aria-hidden />Installing…</p>}
          {inst?.status === 'failed' && <div className="mt-2"><Err>{inst.error ?? 'The installation failed.'}</Err></div>}
          {inst?.status === 'ready' && a.updating && <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner className="size-3.5" aria-hidden />Updating to {a.updating}… It stays available meanwhile; new chats switch over when it is ready.</p>}
          {inst?.status === 'ready' && !a.updating && a.lastUpdateError && <p className="mt-2 max-w-xl text-[13px] text-warning-ink">{a.lastUpdateError.message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!inst && <Button variant="outline" disabled={busy} onClick={() => sure('Install', install)}>{busy && <Spinner aria-hidden />}Install</Button>}
          {inst?.status === 'failed' && <Button variant="outline" disabled={busy} onClick={() => sure('Install', install)}><RotateCw size={14} aria-hidden />Retry</Button>}
          {inst?.status === 'ready' && a.updateAvailable && !a.updating && <Button variant="outline" disabled={busy} onClick={() => run(() => rpc.agents.install.mutate({ id: a.id }), `Updating ${a.name}`)}>Update to {a.updateAvailable}</Button>}
          {((inst && inst.status !== 'installing') || (mod && !inst)) && <Button variant="ghost" size="icon" className="text-muted-foreground hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${a.name}`} disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={15} /></Button>}
        </div>
      </div>
      {inst?.status === 'ready' && (
        <div className="mt-2 ml-11 border-t border-border/60">
          <Row compact title="Available to users" hint="Off keeps it installed but hides it from everyone."><Switch label={`${a.name} available to users`} checked={a.enabled} disabled={busy} onChange={(enabled) => (enabled ? sure('Make available', () => update({ enabled })) : update({ enabled }))} /></Row>
          <Row compact title="Who may use it" hint="Empty means everyone who has sandbox access."><RolePicker value={a.roles} disabled={busy} onChange={(roles) => update({ roles })} /></Row>
          <Row compact title="Update automatically" hint="New versions are installed next to the current one. Open chats keep running; the next chat uses the new version."><Switch label={`${a.name} update automatically`} checked={a.autoUpdate} disabled={busy} onChange={(autoUpdate) => update({ autoUpdate })} /></Row>
          <KeyRow a={a} disabled={busy} onChange={(keyProvider) => update({ keyProvider })} />
          <DefaultModelRow a={a} disabled={busy} onChange={update} />
        </div>
      )}
      {warn && <ConfirmDialog danger={false} title={`${warn.action} ${a.name}?`} body={actsWithoutAskingText(a.name)} action={warn.action} onClose={() => setWarn(null)} onConfirm={warn.go} />}
      {confirm && <ConfirmDialog title={`Remove ${a.name}?`} body={mod ? 'Users can no longer start it, and it is uninstalled. Their earlier conversations stay readable. To use it again, add the agent module again.' : 'Users can no longer start it. Their earlier conversations stay readable. You can install it again later.'} action="Remove" onClose={() => setConfirm(false)}
        onConfirm={() => run(() => (mod ? rpc.agents.removeModule.mutate({ id: a.id }) : rpc.agents.uninstall.mutate({ id: a.id })), `Removed ${a.name}`)} />}
    </div>
  );
}

/** "Runs on": which connected API-key provider pays for this agent, any the agent supports (agents.models); Automatic picks a matching one. */
function KeyRow({ a, disabled, onChange }: { a: CatalogAgent; disabled: boolean; onChange: (v: string | null) => void }) {
  const all = useQuery(() => rpc.agents.models.query() as Promise<Record<string, ProviderChoice[]>>);
  const connected = (all.data?.[a.id] ?? []).filter((p) => p.connected);
  const options: ModelOption[] = connected.map((p) => ({ id: p.id, name: p.name, group: 'API key' }));
  if (a.keyProvider && !options.some((o) => o.id === a.keyProvider)) options.push({ id: a.keyProvider, name: `${a.keyProvider} (not connected)`, group: 'API key' });
  const none = !options.length;
  return (
    <Row compact title="Runs on" hint={none ? 'Add an API key for a provider this agent supports below first.' : 'Which API key pays for this agent. Automatic picks a matching one.'}>
      <ModelPicker label={`${a.name} runs on`} options={options} value={a.keyProvider ?? ''} emptyLabel="Automatic" disabled={disabled} onChange={(v) => onChange(v || null)} />
    </Row>
  );
}

/** "Default model": what a chat on this agent runs on when no Assistant says otherwise (provider and model together, from the providers with a key). */
function DefaultModelRow({ a, disabled, onChange }: { a: CatalogAgent; disabled: boolean; onChange: (v: { defaultProvider: string | null; defaultModel: string | null }) => void }) {
  const all = useQuery(() => rpc.agents.models.query() as Promise<Record<string, ProviderChoice[]>>);
  const [pid, setPid] = useState(a.defaultProvider ?? '');
  const providers = all.data?.[a.id] ?? [], provider = providers.find((p) => p.id === (pid || providers[0]?.id));
  const options: ModelOption[] = (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name, group: provider!.name, contextWindow: m.contextWindow, reasoning: m.reasoning, vision: m.vision }));
  return (
    <Row compact title="Default model" hint={provider && !provider.connected ? provider.reason : 'Used for chats on this agent that run no Assistant. Empty: the agent chooses itself. An Assistant sets its own.'}>
      <div className="flex gap-2">
        {providers.length > 1 && (
          <Select aria-label={`${a.name} default provider`} value={provider?.id ?? ''} disabled={disabled} onChange={(e) => { setPid(e.target.value); if (a.defaultModel) onChange({ defaultProvider: null, defaultModel: null }); }}>
            {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.connected}>{p.name}{p.connected ? '' : ' (no API key)'}</option>)}
          </Select>
        )}
        <ModelPicker label={`${a.name} default model`} options={options} value={a.defaultModel && a.defaultProvider === provider?.id ? a.defaultModel : ''} emptyLabel="Agent's own choice" disabled={disabled || !provider?.connected}
          onChange={(model) => onChange(model ? { defaultProvider: provider!.id, defaultModel: model } : { defaultProvider: null, defaultModel: null })} />
      </div>
    </Row>
  );
}

function RolePicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const roles = useQuery(() => trpc.roles.list.query());
  const all = roles.data?.roles ?? [];
  const label = !value.length ? 'Everyone with sandbox access' : value.map((id) => all.find((r) => r.id === id)?.name ?? id).join(', ');
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" type="button" disabled={disabled} aria-label="Who may use it" className="w-full justify-between font-normal" />}><span className="truncate">{label}</span><ChevronDown size={14} aria-hidden /></PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-2">
        {all.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
            <Checkbox checked={value.includes(r.id)} onCheckedChange={(on) => onChange(on ? [...value, r.id] : value.filter((x) => x !== r.id))} />{r.name}
          </label>
        ))}
        {!!value.length && <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => onChange([])}>Allow everyone</Button>}
      </PopoverContent>
    </Popover>
  );
}

function KeysSection({ conns, list, loading, reload }: { conns: Conn[]; list: CatalogAgent[]; loading: boolean; reload: () => void }) {
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<Conn>();
  return (
    <Section title="API keys">
      {loading ? <Loading shape="rows" n={2} /> : !conns.length ? (
        <Empty icon={<KeyRound size={26} />} action={<Button onClick={() => setAdd(true)}>Add API key</Button>}>Agents need an API key to work. Add the key of your Anthropic or OpenAI account.</Empty>
      ) : (
        <>
          {conns.map((c) => { const users = usedBy(list, c.id); return (
            <div key={c.id} className="flex items-center gap-4 border-b border-border py-4">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{c.name}</span>
                  {c.deprecated ? <Chip tone="caution">Sign-in connection — replace with an API key</Chip> : <Chip tone={c.status === 'ok' ? 'ok' : 'alarm'}>{c.status === 'ok' ? 'Working' : 'Needs attention'}</Chip>}</div>
                {c.status === 'error' && !c.deprecated
                  ? <p className="mt-0.5 text-sm text-warning-ink">This key can’t be read any more — enter it again. <button type="button" className="underline underline-offset-2" onClick={() => setAdd(true)}>Enter it again</button></p>
                  : <p className="mt-0.5 text-sm text-muted-foreground">{users.length ? `Used by: ${users.join(', ')}` : 'Not used by any agent yet'}</p>}
              </div>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:bg-danger/10 hover:text-danger-ink" aria-label={`Remove ${c.name}`} onClick={() => setDel(c)}><Trash2 size={15} /></Button>
            </div>); })}
          <div className="py-4"><Button variant="outline" onClick={() => setAdd(true)}><Plus size={15} aria-hidden />Add API key</Button></div>
        </>
      )}
      {add && <ApiKeyDialog scope="company" onClose={() => setAdd(false)} onDone={() => { setAdd(false); toast('API key added'); reload(); }} />}
      {del && <ConfirmDialog title={`Remove ${del.name}?`} body="Agents that run on it stop working until you add another key." action="Remove" onClose={() => setDel(undefined)}
        onConfirm={() => trpc.models.disconnect.mutate({ id: del.id }).then(() => { toast(`Removed ${del.name}`); reload(); }).catch((x) => toast(x.message, true))} />}
    </Section>
  );
}
