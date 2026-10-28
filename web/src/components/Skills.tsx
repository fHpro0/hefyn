import { Ellipsis, FolderUp, PackageCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { can, useQuery, type Me } from './api';
import { ConfirmDialog, Dialog } from './dialogs';
import { Md } from './markdown';
import Shell from './Shell';
import { toast } from './toast';
import { Chip, Empty, Err, Field, Input, Loading, Page, Reveal, Switch, Textarea } from './ui';

// Skills: instructions a coding agent loads when they fit the job (a folder with SKILL.md). Your own are private until you share them; the team's are shared by whoever holds skills.share.
// The switch is per person and decides whether a plain-agent chat gets the skill; an Assistant names its own skills.
const rpc = trpc;

interface Skill { id: string; name: string; description: string; mine: boolean; owner: string; shared: boolean; status: string; imported: boolean; on: boolean }
interface Detail { id: string; name: string; description: string; meta: Record<string, string>; body: string; files: { path: string; size: number }[]; mine: boolean; shared: boolean; imported: boolean }

export default function Skills() {
  return <Shell title="Skills">{(me) => <Content me={me} />}</Shell>;
}

function Content({ me }: { me: Me }) {
  const list = useQuery(() => rpc.skills.list.query() as Promise<Skill[]>);
  const [view, setView] = useState<string>();
  const [edit, setEdit] = useState<{ id?: string } | undefined>();
  const [ask, setAsk] = useState<{ title: string; body: string; action: string; go: () => void }>();
  const install = can(me, 'hub.install'), share = can(me, 'skills.share');
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } list.reload(); };
  const mine = (list.data ?? []).filter((s) => s.mine), team = (list.data ?? []).filter((s) => !s.mine);

  const row = (s: Skill) => (
    <div key={s.id} className="flex items-center gap-3 border-b border-border py-3">
      <button type="button" className="min-w-0 grow text-left" onClick={() => setView(s.id)}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{s.name}</span>
          {s.mine && s.shared && <Chip tone="blue">Shared with the team</Chip>}
          {s.mine && s.shared && s.status === 'pending' && <Chip tone="caution">Waiting for review</Chip>}
          {!s.mine && <Chip>{s.owner}</Chip>}
          {s.imported && <Chip>Imported</Chip>}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{s.description}</span>
      </button>
      <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">In plain chats<Switch label={`Give ${s.name} to plain-agent chats`} checked={s.on} onChange={(on) => run(() => rpc.skills.setOn.mutate({ id: s.id, on }), on ? 'Turned on' : 'Turned off')} /></span>
      {s.mine && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${s.name}`} />}><Ellipsis size={16} aria-hidden /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {!s.imported && <DropdownMenuItem className="text-[13px]" onClick={() => setEdit({ id: s.id })}>Edit</DropdownMenuItem>}
            {share && !s.shared && <DropdownMenuItem className="text-[13px]" onClick={() => setAsk({ title: `Share ${s.name} with the team?`, body: 'Everyone on the team can then use it. Changes you make later reach them too.', action: 'Share', go: () => run(() => rpc.skills.share.mutate({ id: s.id }), 'Shared with the team') })}>Share with team</DropdownMenuItem>}
            {s.shared && <DropdownMenuItem className="text-[13px]" onClick={() => run(() => rpc.skills.unshare.mutate({ id: s.id }), 'Private again')}>Stop sharing</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[13px] text-danger-ink" onClick={() => setAsk({ title: `Delete ${s.name}?`, body: 'It is removed for good, for the team too if you shared it. Assistants that use it lose it.', action: 'Delete', go: () => run(() => rpc.skills.remove.mutate({ id: s.id }), 'Deleted') })}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return (
    <Page wide title="Skills" hint="Instructions your agents load when they fit the job. Yours are private until you share them with the team."
      actions={install && <Button onClick={() => setEdit({})}><Plus size={15} aria-hidden />New skill</Button>}>
      <Err>{list.error}</Err>
      <Reveal loading={!list.data && !list.error} fallback={<Loading shape="rows" />}>
        <h2 className="mb-1 text-[15px] font-semibold">Yours</h2>
        <div className="border-t border-border">
          {list.data && !mine.length && <Empty icon={<PackageCheck size={26} />} action={install ? <Button onClick={() => setEdit({})}>New skill</Button> : undefined}>You have no skills yet.</Empty>}
          {mine.map(row)}
        </div>
        <h2 className="mt-7 mb-1 text-[15px] font-semibold">Team</h2>
        <div className="border-t border-border">
          {list.data && !team.length && <p className="border-b border-border py-3.5 text-[13px] text-muted-foreground">Nothing shared by the team yet.</p>}
          {team.map(row)}
        </div>
      </Reveal>
      {view && <Preview id={view} onClose={() => setView(undefined)} />}
      {edit && <Editor id={edit.id} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); toast('Saved'); list.reload(); }} />}
      {ask && <ConfirmDialog title={ask.title} body={ask.body} action={ask.action} danger={ask.action === 'Delete'} onConfirm={ask.go} onClose={() => setAsk(undefined)} />}
    </Page>
  );
}

// SKILL.md shown as it is meant: the frontmatter as fields, the rest as the instructions.
function Preview({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery(() => rpc.skills.get.query({ id }) as Promise<Detail>);
  return (
    <Dialog title={d.data?.name ?? 'Skill'} onClose={onClose} xl>
      <Err>{d.error}</Err>
      {d.data && <div className="grid gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border p-3 text-[13px]">
          {Object.entries(d.data.meta).map(([k, v]) => <div key={k} className="contents"><dt className="font-medium text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
          {!Object.keys(d.data.meta).length && <div className="col-span-2 text-muted-foreground">No name or description in SKILL.md.</div>}
        </dl>
        <div className="max-h-[50vh] overflow-y-auto text-sm"><Md>{d.data.body}</Md></div>
        {!!d.data.files.length && <p className="text-xs text-muted-foreground">Also in the skill: {d.data.files.map((f) => f.path).join(', ')}</p>}
      </div>}
    </Dialog>
  );
}

const parse = (md: string) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(md);
  const field = (k: string) => m?.[1]!.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: field('name'), description: field('description'), body: (m ? m[2]! : md).trim() };
};

function Editor({ id, onClose, onDone }: { id?: string; onClose: () => void; onDone: () => void }) {
  const cur = useQuery(async () => (id ? ((await rpc.skills.get.query({ id })) as Detail) : undefined));
  if (id && !cur.data) return <Dialog title="Edit skill" onClose={onClose} xl>{cur.error ? <Err>{cur.error}</Err> : <Loading />}</Dialog>;
  return <Form id={id} start={cur.data} onClose={onClose} onDone={onDone} />;
}

function Form({ id, start, onClose, onDone }: { id?: string; start?: Detail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(start?.name ?? ''), [description, setDescription] = useState(start?.description ?? ''), [instructions, setInstructions] = useState(start?.body ?? '');
  const [files, setFiles] = useState<{ path: string; content: string }[]>();
  const [err, setErr] = useState('');
  // A folder with a SKILL.md: its text files become the skill (other kinds of file are left out).
  const pickFolder = async (list: FileList | null) => {
    const all = [...(list ?? [])].filter((f) => f.size <= 1_000_000 && !f.webkitRelativePath.split('/').some((p) => p.startsWith('.')));
    const read = (await Promise.all(all.slice(0, 200).map(async (f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), content: await f.text() })))).filter((f) => f.path && !f.content.includes('\u0000'));
    const md = read.find((f) => f.path === 'SKILL.md');
    if (!md) { setErr('The folder needs a SKILL.md at its top.'); return; }
    const p = parse(md.content);
    setErr(''); if (!id) setName(p.name || list![0]!.webkitRelativePath.split('/')[0]!); setDescription(p.description); setInstructions(p.body);
    setFiles(read.filter((f) => f.path !== 'SKILL.md'));
  };
  const save = async () => {
    setErr('');
    try { await rpc.skills.save.mutate({ ...(id && { id }), name, description, instructions, ...(files && { files }) }); onDone(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Dialog title={id ? `Edit ${start?.name}` : 'New skill'} onClose={onClose} xl>
      <div className="grid gap-3">
        {!id && <Field label="Name"><Input value={name} maxLength={64} placeholder="for example contract-review" onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label="When to use it"><Input value={description} maxLength={500} placeholder="One sentence the agent reads to decide whether this skill fits" onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Instructions (SKILL.md)"><Textarea rows={12} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What to do, step by step." /></Field>
        <label className="flex w-fit cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted">
          <FolderUp size={14} aria-hidden />Fill from a folder with a SKILL.md
          <input type="file" className="sr-only" multiple {...({ webkitdirectory: '' } as object)} onChange={(e) => { void pickFolder(e.target.files); e.target.value = ''; }} />
        </label>
        {files && <p className="text-xs text-muted-foreground">{files.length} more file{files.length === 1 ? '' : 's'} from the folder will be saved with it.</p>}
        <Err>{err}</Err>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || !description.trim() || !instructions.trim()} onClick={save}>Save</Button></div>
      </div>
    </Dialog>
  );
}
