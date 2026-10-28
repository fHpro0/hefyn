import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Dialog } from '../dialogs';
import { Err, Field, Input } from '../ui';
import { MAX_ZIP } from './diagram-model';

const rpc = trpc;
export interface Imported { id: string; agent: string; draftId: string; ignored: string[] }

const base64 = (f: File) => new Promise<string>((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] ?? '');
  r.onerror = () => no(new Error('The file could not be read.'));
  r.readAsDataURL(f);
});

/** "Import" menu: a repository (GitHub or GitLab, optional subfolder) or a zip. With `draftId` it replaces that open draft's files; without, it starts a new draft. */
export function ImportMenu({ draftId, agent, onDone, variant = 'outline' }: { draftId?: string; agent?: string; onDone: (r: Imported) => void; variant?: 'outline' | 'default' }) {
  const [kind, setKind] = useState<'repo' | 'zip'>();
  const [url, setUrl] = useState(''), [path, setPath] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const close = () => { setKind(undefined); setError(''); };
  const go = async () => {
    setBusy(true); setError('');
    try {
      let src: { url: string; path?: string } | { zip: string };
      if (kind === 'repo') src = { url: url.trim(), ...(path.trim() && { path: path.trim() }) };
      else {
        const f = file.current?.files?.[0];
        if (!f) throw new Error('Choose a zip file first.');
        if (f.size > MAX_ZIP) throw new Error('This zip is larger than 10 MB.');
        src = { zip: await base64(f) };
      }
      const r = await rpc.assistants.import.mutate({ ...(draftId && { draftId }), ...(agent && { agent }), ...src });
      close(); onDone(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant={variant} />}><Download size={15} aria-hidden />Import</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem className="text-[13px]" onClick={() => setKind('repo')}>From repository…</DropdownMenuItem>
        <DropdownMenuItem className="text-[13px]" onClick={() => setKind('zip')}>Upload zip…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {kind && (
      <Dialog title={kind === 'repo' ? 'Import from a repository' : 'Import from a zip'} onClose={close}
        footer={<><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={busy || (kind === 'repo' && !url.trim())} onClick={go}>{busy ? 'Importing…' : 'Import'}</Button></>}>
        {kind === 'repo' ? <>
          <Field label="Repository address (GitHub or GitLab)"><Input value={url} placeholder="https://github.com/owner/repo" onChange={(e) => setUrl(e.target.value)} autoFocus /></Field>
          <Field label="Subfolder (optional)"><Input value={path} placeholder="assistants/support" onChange={(e) => setPath(e.target.value)} /></Field>
        </> : <Field label="Zip file, at most 10 MB"><input ref={file} type="file" accept=".zip" className="text-[13px]" onChange={() => setError('')} /></Field>}
        <p className="text-xs leading-5 text-muted-foreground">{draftId ? 'The files of this draft are replaced by the ones you import.' : 'This starts a new draft you can change in the chat.'}</p>
        <Err>{error}</Err>
      </Dialog>
    )}
  </>;
}

/** Paths an import left out (the creator's brief, .git, binaries), dismissible. */
export function IgnoredNotice({ paths, onDismiss }: { paths: string[]; onDismiss: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-start gap-2 border-b border-border bg-muted/40 px-4 py-2 text-[13px]">
      <p className="min-w-0 grow">Imported. {paths.length} {paths.length === 1 ? 'file was' : 'files were'} left out: <span className="break-all text-muted-foreground">{paths.slice(0, 8).join(', ')}{paths.length > 8 ? `, and ${paths.length - 8} more` : ''}</span></p>
      <Button variant="outline" size="sm" onClick={onDismiss}>Dismiss</Button>
    </div>
  );
}
