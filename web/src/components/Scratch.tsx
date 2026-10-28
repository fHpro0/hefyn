import { Eraser } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { bytes } from './api';
import { ConfirmDialog, Dialog } from './dialogs';
import { type ScratchChat, scratchClient, when } from './files-client';
import { toast } from './toast';
import { Empty, Loading, Page, Reveal } from './ui';

const COLS = 'grid-cols-[minmax(0,1fr)_90px_80px] sm:grid-cols-[minmax(0,1fr)_90px_130px_80px_72px]';
const DAYS = [7, 30, 90];

// Each chat's scratch space (its /tmp) with what it holds: open one to look inside, clear it, or clean up the old ones in one go.
export default function Scratch({ chats, reload, top }: { chats?: ScratchChat[]; reload: () => void; top: React.ReactNode }) {
  const [clear, setClear] = useState<ScratchChat>();
  const [tidy, setTidy] = useState(false);
  const total = (chats ?? []).reduce((n, c) => n + c.bytes, 0);
  const doClear = async (c: ScratchChat) => { try { const r = await scratchClient.clear(c.conversationId); toast(`Freed ${bytes(r.freed)}`); } catch (e) { toast((e as Error).message, true); } reload(); };
  const cell = 'flex h-[40px] items-center';
  return (
    <Page wide title="Files" hint="What each chat’s agent left in its scratch space (/tmp). It counts toward your storage; old chats’ scratch is also cleared automatically after 7 days."
      actions={<Button variant="outline" disabled={!chats?.length} onClick={() => setTidy(true)}><Eraser size={16} aria-hidden />Clean up…</Button>}>
      {top}
      <Reveal loading={!chats} fallback={<Loading shape="rows" n={4} />}>
        {chats && !chats.length && <Empty icon={<Eraser size={28} />}>No scratch files. Nothing is using space here.</Empty>}
        {!!chats?.length && (
          <div role="table" aria-label="Chat scratch" className="text-[13px]">
            <div role="row" className={`grid ${COLS} items-center gap-x-3 pb-1 text-xs text-muted-foreground`}>
              <span>Chat</span><span className="text-right">Size</span><span className="max-sm:hidden">Last change</span><span className="max-sm:hidden">Status</span><span />
            </div>
            {chats.map((c) => (
              <div key={c.conversationId} role="row" tabIndex={0} onClick={() => (location.hash = `scratch/${c.conversationId}`)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = `scratch/${c.conversationId}`; }}
                className={`group grid ${COLS} cursor-pointer select-none items-center gap-x-3 border-t transition-colors last:border-b hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}>
                <div role="cell" className={`${cell} min-w-0 flex-col items-start justify-center`}><span className="w-full truncate font-medium">{c.title}</span><span className="tnum text-xs text-muted-foreground">{c.files} {c.files === 1 ? 'file' : 'files'}</span></div>
                <div role="cell" className={`${cell} tnum justify-end text-muted-foreground`}>{bytes(c.bytes)}</div>
                <div role="cell" className={`${cell} tnum whitespace-nowrap text-muted-foreground max-sm:hidden`}>{c.lastModified ? when(c.lastModified) : ''}</div>
                <div role="cell" className={`${cell} max-sm:hidden`}>{c.running && <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs">Running</span>}</div>
                <div role="cell" className={`${cell} justify-end`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" disabled={c.running} title={c.running ? 'This chat is running' : undefined} aria-label={`Clear ${c.title}`} onClick={() => setClear(c)}>Clear</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Reveal>
      {!!chats?.length && <p className="tnum mt-6 text-xs text-muted-foreground">{bytes(total)} in chat scratch, part of your storage.</p>}
      {clear && <ConfirmDialog title={`Clear scratch of “${clear.title}”?`} body={`Its ${clear.files} ${clear.files === 1 ? 'file' : 'files'} (${bytes(clear.bytes)}) are deleted. The chat and its messages stay.`} action="Clear" onClose={() => setClear(undefined)} onConfirm={() => void doClear(clear)} />}
      {tidy && <Tidy chats={chats ?? []} onClose={() => setTidy(false)} onDone={reload} />}
    </Page>
  );
}

function Tidy({ chats, onClose, onDone }: { chats: ScratchChat[]; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const old = chats.filter((c) => !c.running && c.lastModified && Date.now() - Date.parse(c.lastModified) > days * 86_400_000);
  const size = old.reduce((n, c) => n + c.bytes, 0);
  const go = async () => {
    setBusy(true);
    try { const r = await scratchClient.cleanup(days); toast(`Freed ${bytes(r.freed)}`); onClose(); } catch (e) { toast((e as Error).message, true); setBusy(false); }
    onDone();
  };
  return (
    <Dialog title="Clean up chat scratch" onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !old.length} onClick={() => void go()}>Clear {old.length} {old.length === 1 ? 'chat' : 'chats'}</Button></>}>
      <p className="text-sm">Clear the scratch files of chats idle for more than</p>
      <div role="radiogroup" aria-label="Idle for more than" className="flex gap-2">
        {DAYS.map((d) => <Button key={d} role="radio" aria-checked={days === d} variant={days === d ? 'default' : 'outline'} onClick={() => setDays(d)}>{d} days</Button>)}
      </div>
      <p aria-live="polite" className="text-sm text-muted-foreground">{old.length ? `Frees about ${bytes(size)} in ${old.length} ${old.length === 1 ? 'chat' : 'chats'}.` : 'Nothing is that old.'} Running chats are skipped.</p>
    </Dialog>
  );
}
