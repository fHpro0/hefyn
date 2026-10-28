import { ArrowDown, ArrowUp, Plus, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { api, can, useLoad, useMe } from '@/components/api';
import { attempt } from '@/components/chat-actions';
import { ConfirmDialog } from '@/components/dialogs';
import { Field, Input, Select, Switch, Textarea, buttonDanger } from '@/components/ui';
import { COLORS, type FieldType, type Level, type Project, type ProjectField, type Sharing } from './api';

const TYPES: [FieldType, string][] = [['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['url', 'Link'], ['email', 'Email'], ['select', 'Choice'], ['user', 'Person']];
const NO_SHARING: Sharing = { everyone: false, roleIds: [], userIds: [], access: {} };
const newId = () => `f${Math.random().toString(36).slice(2, 8)}`;
interface Dir { users: { id: string; name: string; email?: string }[]; roles: { id: string; name: string }[] }

/** Mounted once in Shell: any "project settings" button dispatches `hefyn-project-settings` with the project id. */
export default function ProjectSettingsHost() {
  const [id, setId] = useState<string>();
  const [project, setProject] = useState<Project>();
  useEffect(() => { const f = (e: Event) => setId((e as CustomEvent).detail); addEventListener('hefyn-project-settings', f); return () => removeEventListener('hefyn-project-settings', f); }, []);
  useEffect(() => { setProject(undefined); if (id) api<Project>(`/api/projects/${id}`).then(setProject).catch(() => setId(undefined)); }, [id]);
  return project ? <Settings key={project.id} project={project} onClose={() => setId(undefined)} /> : null;
}

function Settings({ project: p, onClose }: { project: Project; onClose: () => void }) {
  const me = useMe();
  const readOnly = p.access === 'viewer';
  const [title, setTitle] = useState(p.title), [description, setDescription] = useState(p.description), [color, setColor] = useState(p.color);
  const [fields, setFields] = useState<ProjectField[]>(p.fields), [instructions, setInstructions] = useState(p.instructions);
  const [scope, setScope] = useState(p.scope), [sharing, setSharing] = useState<Sharing>(p.sharing ?? NO_SHARING);
  const [open, setOpen] = useState(true), [discard, setDiscard] = useState(false), [del, setDel] = useState<'keep' | 'all'>(), [saving, setSaving] = useState(false);
  const dir = useLoad<Dir>('/api/projects/directory');
  const canShare = !!me && (can(me, 'projects.share') || can(me, 'projects.manage_team'));
  const dirty = useMemo(() => JSON.stringify([title, description, color, fields, instructions, scope, sharing]) !== JSON.stringify([p.title, p.description, p.color, p.fields, p.instructions, p.scope, p.sharing ?? NO_SHARING]), [title, description, color, fields, instructions, scope, sharing]);
  const close = () => { setOpen(false); onClose(); };
  const save = async () => {
    setSaving(true);
    const ok = await attempt(() => api(`/api/projects/${p.id}`, 'PATCH', {
      title, description, color, instructions, fields,
      ...(p.isOwner && scope !== p.scope && { scope }), ...(p.canManage && scope === 'team' && { sharing }),
    }), 'Project saved');
    setSaving(false);
    if (ok) close();
  };
  const remove = (withChats: boolean) => attempt(() => api(`/api/projects/${p.id}${withChats ? '?withChats=1' : ''}`, 'DELETE'), 'Project deleted').then((ok) => { if (ok) { close(); if (location.pathname === '/projects' && location.hash.slice(1) === p.id) location.href = '/'; } });
  const setField = (i: number, patch: Partial<ProjectField>) => setFields((l) => l.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => setFields((l) => { const n = [...l]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; return n; });

  const valueInput = (f: ProjectField, i: number) => {
    const set = (v: string) => setField(i, { value: v });
    const common = { 'aria-label': `${f.label || 'Field'} value`, disabled: readOnly, value: f.value ?? '' };
    switch (f.type) {
      case 'longtext': return <Textarea rows={3} {...common} onChange={(e) => set(e.target.value)} />;
      case 'number': return <Input type="number" inputMode="decimal" {...common} onChange={(e) => set(e.target.value)} />;
      case 'date': return <Input type="date" {...common} onChange={(e) => set(e.target.value)} />;
      case 'url': return <Input type="url" placeholder="https://" {...common} onChange={(e) => set(e.target.value)} />;
      case 'email': return <Input type="email" {...common} onChange={(e) => set(e.target.value)} />;
      case 'select': return <Select {...common} onChange={(e) => set(e.target.value)}><option value="">Not set</option>{(f.options ?? []).map((o) => <option key={o}>{o}</option>)}</Select>;
      case 'user': return <Select {...common} onChange={(e) => set(e.target.value)}><option value="">Nobody</option>{(dir.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>;
      default: return <Input {...common} onChange={(e) => set(e.target.value)} />;
    }
  };

  const taken = new Set([...sharing.roleIds, ...sharing.userIds]);
  const addMember = (v: string) => {
    const [kind, id] = [v.slice(0, 1), v.slice(2)];
    setSharing((s) => ({ ...s, ...(kind === 'r' ? { roleIds: [...s.roleIds, id] } : { userIds: [...s.userIds, id] }), access: { ...s.access, [id]: 'viewer' } }));
  };
  const dropMember = (id: string) => setSharing((s) => { const { [id]: _, ...access } = s.access; return { ...s, roleIds: s.roleIds.filter((x) => x !== id), userIds: s.userIds.filter((x) => x !== id), access }; });
  const level = (id: string, v: Level) => setSharing((s) => ({ ...s, access: { ...s.access, [id]: v } }));
  const LevelSelect = ({ id, label }: { id: string; label: string }) => (
    <Select aria-label={label} className="w-28" disabled={!p.canManage} value={sharing.access[id] ?? 'viewer'} onChange={(e) => level(id, e.target.value as Level)}><option value="viewer">Viewer</option><option value="editor">Editor</option></Select>);
  const nameOf = (id: string) => dir.data?.users.find((u) => u.id === id)?.name ?? p.members?.users.find((u) => u.id === id)?.name ?? id;
  const roleName = (id: string) => dir.data?.roles.find((r) => r.id === id)?.name ?? p.members?.roles.find((r) => r.id === id)?.name ?? id;

  return (<>
    <Dialog open={open} onOpenChange={(o) => { if (!o) dirty && !readOnly ? setDiscard(true) : close(); }}>
      <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="p-5 pb-0"><DialogTitle className="text-base leading-6 font-semibold">{readOnly ? 'Project' : 'Project settings'}{readOnly && ' (view only)'}</DialogTitle></DialogHeader>
        <Tabs defaultValue="general" className="min-h-0 flex-col gap-0 p-5">
          <TabsList className="h-8"><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="fields">Fields{fields.length ? ` (${fields.length})` : ''}</TabsTrigger><TabsTrigger value="instructions">Instructions</TabsTrigger><TabsTrigger value="sharing">Sharing</TabsTrigger></TabsList>
          <div className="mt-4 min-h-0 overflow-y-auto pr-1">
            <TabsContent value="general" className="grid gap-4">
              <Field label="Title"><Input value={title} maxLength={60} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="Description"><Textarea rows={3} maxLength={500} disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" /></Field>
              <Field label="Color"><div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
                {COLORS.map((c) => <button key={c} type="button" role="radio" disabled={readOnly} aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className={`size-6 rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring ${c === color ? 'ring-2 ring-foreground' : ''}`} style={{ background: c }} />)}
              </div></Field>
              {p.canManage && <div className="mt-2 grid gap-2 border-t border-border pt-4"><h3 className="text-sm font-medium">Delete project</h3>
                <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setDel('keep')}>Delete project, keep chats</Button>
                  <button type="button" className={`${buttonDanger} inline-flex h-8 items-center gap-1.5 px-3 text-sm`} onClick={() => setDel('all')}><Trash2 size={14} aria-hidden />Delete project and my chats in it</button></div></div>}
            </TabsContent>
            <TabsContent value="fields" className="grid gap-3">
              <p className="text-[13px] text-muted-foreground">Facts about the project, like the client, a budget or a deadline. Everyone with access sees them.</p>
              {fields.map((f, i) => (
                <div key={f.id} className="grid gap-2 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input aria-label="Field name" className="min-w-0 flex-1 basis-36" placeholder="Field name" maxLength={60} disabled={readOnly} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                    <Select aria-label="Field type" className="w-32" disabled={readOnly} value={f.type} onChange={(e) => { const t = e.target.value as FieldType; setField(i, { type: t, value: null, ...(t === 'select' ? { options: f.options ?? [] } : { options: undefined }) }); }}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                    {!readOnly && <div className="flex">
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move ${f.label || 'field'} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden /></Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move ${f.label || 'field'} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden /></Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${f.label || 'field'}`} onClick={() => setFields((l) => l.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden /></Button></div>}
                  </div>
                  {f.type === 'select' && <Input aria-label="Choices, comma separated" placeholder="Choices, separated by commas" disabled={readOnly} defaultValue={(f.options ?? []).join(', ')} onBlur={(e) => setField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean), value: null })} />}
                  {valueInput(f, i)}
                </div>
              ))}
              {!fields.length && <p className="text-sm text-muted-foreground">No fields yet.</p>}
              {!readOnly && <div><Button type="button" variant="outline" disabled={fields.length >= 30} onClick={() => setFields((l) => [...l, { id: newId(), label: '', type: 'text', value: null }])}><Plus size={14} aria-hidden />Add field</Button></div>}
            </TabsContent>
            <TabsContent value="instructions" className="grid gap-4">
              <Field label="Instructions"><Textarea rows={8} maxLength={8000} disabled={readOnly} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Standing context for every chat in this project, e.g. tone, audience, vocabulary." /></Field>
              <p className="-mt-2 text-xs text-muted-foreground">They apply to every member's chats in this project.</p>
            </TabsContent>
            <TabsContent value="sharing" className="grid gap-4">
              <fieldset className="grid gap-2" disabled={!p.isOwner || (!canShare && scope === 'private')}>
                <legend className="mb-1 text-sm font-medium">Who can see this project</legend>
                {([['private', 'Private', 'Only you.'], ['team', 'Team', 'People you choose below.']] as const).map(([v, l, h]) => (
                  <label key={v} className="flex items-start gap-2 text-sm"><input type="radio" name="scope" className="mt-1" checked={scope === v} disabled={v === 'team' && !canShare} onChange={() => setScope(v)} /><span><b className="font-medium">{l}</b> <span className="text-muted-foreground">{h}</span></span></label>))}
                {!p.isOwner && <p className="text-xs text-muted-foreground">Only the owner switches a project between private and team.</p>}
                {p.isOwner && !canShare && <p className="text-xs text-muted-foreground">Your role may not share projects with the team.</p>}
              </fieldset>
              {scope === 'team' && (<>
                <div className="flex items-center gap-2 text-sm"><span className="grid size-6 place-items-center rounded-full bg-foreground/10 text-xs font-semibold">{p.owner.name.slice(0, 1).toUpperCase()}</span><span className="grow">{p.owner.name} <span className="text-muted-foreground">(owner)</span></span></div>
                <div className="flex items-center gap-2 text-sm"><Users size={16} aria-hidden className="text-muted-foreground" /><span className="grow">Everyone in the team</span>
                  <Switch label="Everyone in the team" checked={sharing.everyone} disabled={!p.canManage} onChange={(v) => setSharing((s) => ({ ...s, everyone: v }))} />
                  {sharing.everyone && <LevelSelect id="*" label="Access for everyone" />}</div>
                {[...sharing.roleIds.map((id) => ({ id, name: roleName(id), role: true })), ...sharing.userIds.map((id) => ({ id, name: nameOf(id), role: false }))].map((m) => (
                  <div key={m.id} className="flex items-center gap-2 text-sm"><span className="grid size-6 place-items-center rounded-full bg-foreground/10 text-xs font-semibold">{m.name.slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 grow truncate">{m.name}{m.role && <span className="text-muted-foreground"> (role)</span>}</span>
                    <LevelSelect id={m.id} label={`Access for ${m.name}`} />
                    {p.canManage && <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${m.name}`} onClick={() => dropMember(m.id)}><Trash2 size={14} aria-hidden /></Button>}</div>))}
                {p.canManage && <Select aria-label="Add a role or a person" value="" onChange={(e) => e.target.value && addMember(e.target.value)}>
                  <option value="">Add a role or a person…</option>
                  <optgroup label="Roles">{(dir.data?.roles ?? []).filter((r) => !taken.has(r.id)).map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}</optgroup>
                  <optgroup label="People">{(dir.data?.users ?? []).filter((u) => u.id !== p.owner.id && !taken.has(u.id)).map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}</optgroup>
                </Select>}
                <p className="text-xs text-muted-foreground">Only people with access see this project. Chats stay private to whoever starts them.</p>
              </>)}
            </TabsContent>
          </div>
        </Tabs>
        <DialogFooter className="m-0 rounded-none bg-transparent px-5 py-3">
          <Button variant="outline" onClick={() => (dirty && !readOnly ? setDiscard(true) : close())}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button disabled={!dirty || !title.trim() || saving} onClick={save}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {discard && <ConfirmDialog title="Discard your changes?" body="The changes in this dialog have not been saved." action="Discard" danger={false} onClose={() => setDiscard(false)} onConfirm={close} />}
    {del === 'keep' && <ConfirmDialog title="Delete this project?" action="Delete project" danger={false} body="The chats stay and move out of the project, for everyone who had chats in it." onClose={() => setDel(undefined)} onConfirm={() => remove(false)} />}
    {del === 'all' && <ConfirmDialog title="Delete the project and your chats in it?" action="Delete everything" body={`The project and your ${p.chatCount} chats in it (messages, attachments) will be removed for good. Other people's chats stay and move out of the project. This can not be undone.`} onClose={() => setDel(undefined)} onConfirm={() => remove(true)} />}
  </>);
}
