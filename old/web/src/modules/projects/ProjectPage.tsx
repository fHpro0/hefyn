import { MessageSquarePlus, Settings2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { useLoad, useQuery } from '@/components/api';
import { trpc } from '@/lib/trpc';
import type { Thread } from '@/components/chat-actions';
import Shell from '@/components/Shell';
import { Chip, Err, Page, Section } from '@/components/ui';
import { openProjectSettings, type Project } from './api';

const hashId = () => location.hash.slice(1);

export default function ProjectPage() {
  const [id, setId] = useState(hashId());
  useEffect(() => { const f = () => setId(hashId()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return <Shell title="Project">{() => <Content key={id} id={id} />}</Shell>;
}

const Initial = ({ name, title }: { name: string; title?: string }) => <span title={title ?? name} className="grid size-6 place-items-center rounded-full bg-foreground/10 text-xs font-semibold">{name.slice(0, 1).toUpperCase()}</span>;
const show = (f: Project['fields'][number], users: Map<string, string>) => {
  if (f.value == null || f.value === '') return <span className="text-muted-foreground">Not set</span>;
  if (f.type === 'url') return <a className="underline underline-offset-2" href={String(f.value)} target="_blank" rel="noopener noreferrer">{String(f.value)}</a>;
  if (f.type === 'email') return <a className="underline underline-offset-2" href={`mailto:${f.value}`}>{String(f.value)}</a>;
  if (f.type === 'user') return <>{users.get(String(f.value)) ?? 'Unknown person'}</>;
  if (f.type === 'date') return <>{new Date(`${f.value}T00:00:00`).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}</>;
  if (f.type === 'number') return <span className="tnum">{Number(f.value).toLocaleString('en')}</span>;
  return <span className="whitespace-pre-wrap">{String(f.value)}</span>;
};

function Content({ id }: { id: string }) {
  const p = useLoad<Project>(`/api/projects/${id}`);
  const chats = useQuery(() => trpc.conversations.list.query({ project: id }) as Promise<Thread[]>, [id]);
  const dir = useLoad<{ users: { id: string; name: string }[] }>('/api/projects/directory');
  useEffect(() => { const f = () => { p.reload(); chats.reload(); }; addEventListener('hefyn-threads', f); return () => removeEventListener('hefyn-threads', f); }, []);
  if (!id) return <Page title="Project"><Err>Pick a project in the sidebar.</Err></Page>;
  const project = p.data;
  if (!project) return <Page title="Project">{p.error ? <Err>{p.error === 'not found' ? 'This project does not exist, or you do not have access to it.' : p.error}</Err> : <p className="text-muted-foreground">Loading…</p>}</Page>;
  const users = new Map((dir.data?.users ?? []).map((u) => [u.id, u.name]));
  const m = project.members, mine = chats.data ?? [];
  return (
    <Page title={project.title} hint={project.description || undefined}
      actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => openProjectSettings(project.id)}><Settings2 size={14} aria-hidden />{project.access === 'viewer' ? 'Details' : 'Settings'}</Button>
        <Button nativeButton={false} render={<a href={`/?project=${encodeURIComponent(project.id)}`} />}><MessageSquarePlus size={14} aria-hidden />New chat in project</Button>
      </div>}>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        {project.color && <span aria-hidden className="size-2.5 rounded-full" style={{ background: project.color }} />}
        {project.scope === 'team' ? <Chip tone="blue"><Users size={12} aria-hidden className="mr-1 inline" />Team{project.access === 'viewer' ? ' · view only' : ''}</Chip> : <Chip>Private</Chip>}
        <span>Owner: {project.owner.name}</span>
      </div>
      {project.fields.length > 0 && <Section title="Details">
        <dl className="grid gap-x-6 gap-y-3 py-4 sm:grid-cols-2">{project.fields.map((f) => <div key={f.id} className="min-w-0"><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="mt-0.5 text-sm break-words">{show(f, users)}</dd></div>)}</dl>
      </Section>}
      {m && <Section title="People">
        <div className="flex flex-wrap items-center gap-2 py-4">
          <Initial name={project.owner.name} title={`${project.owner.name} (owner)`} />
          {m.everyone && <Chip>Everyone · {m.everyoneAccess}</Chip>}
          {m.roles.map((r) => <Chip key={r.id}>{r.name} · {r.access}</Chip>)}
          {m.users.map((u) => <Initial key={u.id} name={u.name} title={`${u.name} · ${u.access}`} />)}
        </div>
      </Section>}
      <Section title={`${m ? 'Your chats' : 'Chats'} (${mine.length})`}>
        {mine.length ? <ul>{[...mine].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((c) => (
          <li key={c.id} className="border-b border-border last:border-b-0"><a href={`/#${c.id}`} className="flex items-baseline gap-3 py-2.5 hover:text-foreground">
            <span className="min-w-0 grow truncate text-sm">{c.title}</span><span className="tnum shrink-0 text-xs text-muted-foreground">{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''}</span></a></li>))}</ul>
          : <p className="py-4 text-sm text-muted-foreground">No chats yet. Start one here, or move chats in from the sidebar.</p>}
        {m && <p className="pb-2 text-xs text-muted-foreground">Chats stay private to whoever starts them.</p>}
      </Section>
    </Page>
  );
}
