import { Plus, RotateCw, Trash2 } from 'lucide-react';
import { AgentsAndKeys } from './Agents';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { can, useHashFlag, useQuery, type Runtime } from './api';
import { ConnectModelDialog } from './ConnectModel';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { MenuArea } from './AppMenu';
import { ConfirmDialog } from './dialogs';
import { toast } from './toast';
import { Chip, Err, Loading, Page, Reveal, Row, Section } from './ui';

interface OwnConn { provider: string; name: string; kind: string; createdAt: string }

// Models are picked per chat; this page only connects the providers they draw from.
export default function Providers() {
  return <Shell>{(me, rt) => <Page title="Agents & keys" hint="Install the agents your team works with, and give them an API key.">
    {can(me, 'models.manage') && <Team rt={rt} />}
    <Own admin={can(me, 'models.manage')} />
  </Page>}</Shell>;
}

// Personal providers: visible and usable only by their owner (connectors.models).
function Own({ admin }: { admin: boolean }) {
  const own = useQuery(() => trpc.connectors.models.list.query());
  const [dlg, setDlg] = useState(useHashFlag('#connect') && !admin);
  const [del, setDel] = useState<OwnConn>();
  const done = () => { dispatchEvent(new Event('hefyn-me')); own.reload(); };
  return (
    <Section title="Your own providers">
      <Err>{own.error}</Err>
      <Row title="Connect your own account or API key" hint="Only you can use it."><Button variant="outline" onClick={() => setDlg(true)}><Plus size={14} aria-hidden />Connect a provider</Button></Row>
      <Reveal loading={!own.data && !own.error} fallback={<Loading shape="rows" n={1} />}>{own.data?.map((c) => (
        <MenuArea key={c.provider} items={() => <DropdownMenuItem className="text-[13px]" variant="destructive" onClick={() => setDel(c)}><Trash2 size={15} strokeWidth={1.75} aria-hidden />Disconnect…</DropdownMenuItem>}>
        <Row title={<span className="flex flex-wrap items-center gap-2">{c.name}<Chip>{c.kind === 'oauth' ? 'Signed in' : 'API key'}</Chip></span>} hint={`Connected on ${new Date(c.createdAt).toLocaleDateString()}`}>
          <Button variant="outline" className="text-danger-ink" onClick={() => setDel(c)}>Disconnect</Button>
        </Row>
        </MenuArea>
      ))}</Reveal>
      {dlg && <ConnectModelDialog scope="me" onClose={() => setDlg(false)} onDone={() => { setDlg(false); toast('Connected'); done(); }} />}
      {del && <ConfirmDialog title={`Disconnect ${del.name}?`} body="You can connect it again later." action="Disconnect" onClose={() => setDel(undefined)}
        onConfirm={() => trpc.connectors.models.disconnect.mutate({ provider: del.provider }).then(() => { toast('Disconnected'); done(); }).catch((x) => toast(x.message, true))} />}
    </Section>
  );
}

function Team({ rt }: { rt?: Runtime }) {
  const [restart, setRestart] = useState(false);

  return (
    <>
      <AgentsAndKeys />

      <Section title="Restart">
        <Row title="Restart agents" hint={`Applies provider changes. Sending pauses until running tasks finish${rt?.runningTasks ? `, ${rt.runningTasks} running now` : ''}.${rt?.requestedAt ? ` Requested by ${rt.requestedBy} on ${new Date(rt.requestedAt).toLocaleString()}.` : ''}`}>
          <div className="flex items-center gap-3"><Chip tone={rt?.state === 'running' ? 'ok' : 'seal'}>{rt?.state === 'running' ? 'Running' : rt?.state === 'draining' ? 'Finishing tasks' : rt?.state === 'restarting' ? 'Restarting' : 'Unknown'}</Chip>
            <Button variant="outline" disabled={!!rt && rt.state !== 'running'} onClick={() => setRestart(true)}><RotateCw size={14} aria-hidden />Restart agents</Button></div>
        </Row>
      </Section>

      {restart && <ConfirmDialog title="Restart the agents?" body="Sending is paused for everyone until running tasks finish and the agents are back." action="Restart" onClose={() => setRestart(false)}
        onConfirm={async () => { try { await trpc.runtime.restart.mutate(); toast('Restart requested'); } catch (x) { toast((x as Error).message, true); } dispatchEvent(new Event('hefyn-rt')); }} />}
    </>
  );
}
