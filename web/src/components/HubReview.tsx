import { PackageCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, useLoad } from './api';
import { FileBrowser, KIND, KindIcon, type Detail, type Pkg } from './Hub';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, Dialog, Empty, Err, Field, Page, Textarea, toast } from './ui';

export default function HubReview() {
  return <Shell title="Hub review">{() => <Content />}</Shell>;
}

function Content() {
  const { data, error, reload } = useLoad<Pkg[]>('/api/hub/review');
  const [rej, setRej] = useState<Pkg>();
  const [reason, setReason] = useState('');
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } reload(); dispatchEvent(new Event('hefyn-me')); };
  return (
    <Page title="Review" hint="Packages waiting to be shared with your team. Nothing is approved automatically, so read flagged ones carefully.">
      <Err>{error}</Err>
      {data && !data.length ? <Empty icon={<PackageCheck size={28} />}>Nothing is waiting for review.</Empty> : (
        <ul className="grid gap-4">{data?.map((p) => <Item key={p.id} pkg={p} onApprove={() => act(() => api(`/api/hub/packages/${p.id}/approve`, 'POST'), `Approved ${p.name}`)} onReject={() => { setReason(''); setRej(p); }} />)}</ul>
      )}
      {rej && (
        <Dialog title={`Reject ${rej.name}`} onClose={() => setRej(undefined)}>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const p = rej; setRej(undefined); act(() => api(`/api/hub/packages/${p.id}/reject`, 'POST', { reason }), `Rejected ${p.name}`); }}>
            <Field label="Reason the author will see"><Textarea rows={3} required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex justify-end gap-2"><button type="button" className={buttonGhost} onClick={() => setRej(undefined)}>Cancel</button><button className={buttonDanger}>Reject</button></div>
          </form>
        </Dialog>
      )}
    </Page>
  );
}

function Item({ pkg, onApprove, onReject }: { pkg: Pkg; onApprove: () => void; onReject: () => void }) {
  const [show, setShow] = useState(false);
  const d = useLoad<Detail>(`/api/hub/packages/${pkg.id}`, [show]);
  return (
    <li className="rounded-xl bg-raised p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-muted"><KindIcon kind={pkg.kind} /></span>
        <div className="min-w-0 grow"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{pkg.name}</h2><Chip>{KIND[pkg.kind].label}</Chip></div>
          <p className="mt-0.5 text-sm text-muted">Version {pkg.version}, by {pkg.owner.name}</p></div>
        <div className="flex gap-2"><button className={buttonDanger} onClick={onReject}>Reject</button><button className={buttonPrimary} onClick={onApprove}>Approve</button></div>
      </div>
      <p className="mt-3 text-sm leading-[22px]">{pkg.description}</p>
      {pkg.guard.flagged && (
        <div role="alert" className="mt-3 rounded-lg bg-warning/15 px-3.5 py-2.5 text-sm">
          <b className="flex items-center gap-1.5 text-warning-ink"><TriangleAlert size={15} aria-hidden />The prompt-injection guard flagged this package</b>
          <ul className="mt-1 list-disc pl-5">{pkg.guard.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      {pkg.contains && <p className="mt-3 text-sm text-muted">Contains {pkg.contains.skills.length} skills, {pkg.contains.agents.length} agents and {pkg.contains.mcp.length} MCP servers.</p>}
      <button className="mt-3 text-sm text-foreground hover:underline" aria-expanded={show} onClick={() => setShow(!show)}>{show ? 'Hide files' : 'Show files'}</button>
      {show && <div className="mt-2">{d.data ? <FileBrowser id={pkg.id} files={d.data.files} /> : <p className="text-sm text-muted">Loading…</p>}</div>}
    </li>
  );
}
