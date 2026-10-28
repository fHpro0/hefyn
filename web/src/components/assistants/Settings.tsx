import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Dialog } from '../dialogs';
import { toast } from '../toast';
import { Err } from '../ui';
import { ModelFields, Pick, type Options, type SimpleFields } from './parts';

const rpc = trpc;

/** Roles (team Assistants) and provider, model and effort (people who manage models): what is not part of the Assistant's files. */
export function SettingsDialog({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved?: () => void }) {
  const [o, setO] = useState<Options>();
  const [scope, setScope] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [f, setF] = useState<SimpleFields>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([rpc.assistants.options.query(), rpc.assistants.get.query({ id })]).then(([opts, a]) => {
      setO(opts as Options); setScope(a.scope); setRoles(a.roles ?? []);
      setF({ agent: a.agent, provider: a.provider, model: a.model, thinking: a.thinking, instructions: '', skills: [], mcp: [], helpers: [] });
    }).catch((e: Error) => setError(e.message));
  }, [id]);
  const showRoles = !!o?.roles && scope === 'team', showModel = !!o?.canChooseModels && !!f?.agent;
  const save = async () => {
    setBusy(true); setError('');
    try {
      await rpc.assistants.settings.mutate({ id, ...(showRoles && { roles }), ...(showModel && { provider: f!.provider ?? null, model: f!.model, thinking: f!.thinking }) });
      toast('Saved'); onSaved?.(); onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Assistant settings" wide onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !f || (!showRoles && !showModel)} onClick={save}>Save</Button></>}>
      <Err>{error}</Err>
      {!f && !error && <p className="text-[13px] text-muted-foreground">Loading…</p>}
      {f && !showRoles && !showModel && <p className="text-[13px] text-muted-foreground">Nothing to set here for you. The name, instructions and files are changed in the editor.</p>}
      {f && showRoles && <Pick label="Who may use it" none="Everyone" items={o!.roles!} value={roles} onChange={setRoles} />}
      {f && showModel && <ModelFields value={f} options={o!} onChange={(p) => setF({ ...f, ...p })} />}
    </Dialog>
  );
}
