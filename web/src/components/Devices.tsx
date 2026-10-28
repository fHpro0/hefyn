import { Laptop } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { useQuery } from './api';
import { ConfirmDialog } from './dialogs';
import Shell from './Shell';
import { toast } from './toast';
import { Empty, Err, Field, Input, Loading, Page, Reveal, Row, Section } from './ui';

export default function Devices() {
  return <Shell>{() => <Content />}</Shell>;
}

type Device = Awaited<ReturnType<typeof trpc.devices.list.query>>[number];
const day = (iso: string) => new Date(iso).toLocaleDateString();

function Content() {
  const { data, error, reload } = useQuery(() => trpc.devices.list.query());
  const [code, setCode] = useState('');
  const [found, setFound] = useState<string>();
  const [remove, setRemove] = useState<Device>();
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<void>) => { setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } };
  const find = () => run(async () => setFound((await trpc.devices.lookup.query({ code })).name));
  const approve = () => run(async () => { const d = await trpc.devices.approve.mutate({ code }); toast(`${d.name} is paired.`); setCode(''); setFound(undefined); void reload(); });
  return (
    <Page title="Devices" hint={<>Run agents on your own computer. There, run <code className="font-mono text-foreground select-all">bun run device pair {location.origin}</code> and enter the code it shows.</>}>
      <Section title="Add a device">
        <form className="flex items-end gap-2 py-3" onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <Field label="Code shown on your computer" className="max-w-56"><Input value={code} onChange={(e) => { setCode(e.target.value); setFound(undefined); }} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} /></Field>
          <Button type="submit" disabled={!code.trim()}>Find</Button>
        </form>
        {found && (
          <div className="flex items-center gap-2 pb-3 text-[13px]" role="status">
            <span>Pair “{found}”?</span>
            <Button size="sm" onClick={approve}>Confirm</Button>
            <Button size="sm" variant="ghost" onClick={() => { setFound(undefined); setCode(''); }}>Cancel</Button>
          </div>
        )}
      </Section>
      <Section title="Your devices">
        <Reveal loading={!data && !error} fallback={<Loading shape="rows" n={2} />}>
          {data?.map((d) => (
            <Row key={d.id} title={d.name} hint={`Paired ${day(d.approvedAt)} · last seen ${d.lastSeenAt ? day(d.lastSeenAt) : 'never'}`}>
              <Button type="button" size="sm" variant="outline" onClick={() => setRemove(d)}>Remove</Button>
            </Row>
          ))}
          {data && !data.length && <Empty icon={<Laptop />}>No device is paired yet.</Empty>}
        </Reveal>
      </Section>
      <Err>{error || err}</Err>
      {remove && <ConfirmDialog title={`Remove ${remove.name}?`} body="It can no longer connect. You can pair it again later." action="Remove"
        onConfirm={() => { const d = remove; setRemove(undefined); void run(async () => { await trpc.devices.revoke.mutate({ id: d.id }); void reload(); }); }} onClose={() => setRemove(undefined)} />}
    </Page>
  );
}
