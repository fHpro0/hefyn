import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useModules, useQuery, type ModulePermission } from './api';
import { trpc } from '@/lib/trpc';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { MenuArea } from './AppMenu';
import { ConfirmDialog, Dialog } from './dialogs';
import { toast } from './toast';
import { Chip, Field, Input, Loading, Page, Reveal } from './ui';

interface Role { id: string; name: string; description: string; builtin: boolean; permissions: string[] }

export default function Roles() {
  return <Shell>{() => <Content />}</Shell>;
}

function NameDialog({ title, action, initial, onSubmit, onClose }: { title: string; action: string; initial?: { name: string; description: string }; onSubmit: (v: { name: string; description: string }) => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<Button type="submit" form="role-name">{action}</Button>}>
      <form id="role-name" className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const name = String(f.get('name')).trim(); if (name) { onSubmit({ name, description: String(f.get('description') ?? '').trim() }); onClose(); } }}>
        <Field label="Name"><Input name="name" defaultValue={initial?.name} required autoFocus disabled={initial?.name === 'Worker'} /></Field>
        <Field label="Description (optional)"><Input name="description" defaultValue={initial?.description} /></Field>
      </form>
    </Dialog>
  );
}

function Content() {
  const { data, reload } = useQuery(() => trpc.roles.list.query());
  const { permissions } = useModules();
  const [selected, setSelected] = useState<string>();
  const [renaming, setRenaming] = useState<Role>();
  const [creating, setCreating] = useState(false);
  const [del, setDel] = useState<Role>();
  const [search, setSearch] = useState('');
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); ok && toast(ok); } catch (x) { toast((x as Error).message, true); } reload(); };
  const roles: Role[] = data?.roles ?? [];
  const role = roles.find((r) => r.id === selected) ?? roles.find((r) => r.id === 'worker') ?? roles[0];

  // Permissions grouped by the module that declares them (the server fills the group); ones no module describes land under "Other".
  const q = search.trim().toLowerCase();
  const byGroup = new Map<string, ModulePermission[]>();
  const known = new Set(permissions.map((p) => p.id));
  const all = [...permissions, ...(data?.permissions ?? []).filter((k) => !known.has(k)).map((k) => ({ id: k, label: k, group: 'Other' }) as ModulePermission)];
  for (const p of all) {
    if (q && !`${p.label} ${p.hint ?? ''} ${p.group ?? ''}`.toLowerCase().includes(q)) continue;
    const g = p.group ?? 'Other';
    byGroup.set(g, [...(byGroup.get(g) ?? []), p]);
  }

  const actions = (r: Role) => (<>
    {!r.builtin && <DropdownMenuItem onClick={() => setRenaming(r)}><Pencil aria-hidden />Rename</DropdownMenuItem>}
    <DropdownMenuItem onClick={() => run(async () => { const { id } = await trpc.roles.duplicate.mutate({ id: r.id }); setSelected(id); }, 'Role duplicated')}><Copy aria-hidden />Duplicate</DropdownMenuItem>
    {data?.defaultRole !== r.id && <DropdownMenuItem onClick={() => run(() => trpc.roles.setDefault.mutate({ id: r.id }), 'Default role changed')}><Star aria-hidden />Make default for new users</DropdownMenuItem>}
    {!r.builtin && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setDel(r)}><Trash2 aria-hidden />Delete</DropdownMenuItem></>}
  </>);
  const toggle = (key: string, on: boolean) => role && run(() => trpc.roles.update.mutate({ id: role.id, permissions: on ? [...role.permissions, key] : role.permissions.filter((x) => x !== key) }));
  const locked = role?.id === 'admin';

  return (
    <Page wide title="Roles" hint="A role is a named set of permissions; every user has one. Modules add their own permissions here. Admin always has everything."
      actions={<Button onClick={() => setCreating(true)}><Plus size={14} aria-hidden />New role</Button>}>
      <Reveal loading={!data} fallback={<Loading shape="rows" n={5} />}>{data && role && (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
          <ul className="space-y-1" aria-label="Roles">
            {roles.map((r) => (
              <li key={r.id}>
                <MenuArea items={() => actions(r)}>
                  <div className={`flex items-center gap-1 rounded-md pr-1 ${r.id === role.id ? 'bg-muted' : 'hover:bg-muted/50'}`}>
                    <button type="button" className="min-w-0 flex-1 px-2.5 py-2 text-left text-[13px]" aria-current={r.id === role.id} onClick={() => setSelected(r.id)}>
                      <span className="flex items-center gap-1.5"><span className="truncate font-medium">{r.name}</span>{r.builtin && <Chip>Built in</Chip>}{data.defaultRole === r.id && <Chip>Default</Chip>}</span>
                      {r.description && <span className="block truncate text-xs text-muted-foreground">{r.description}</span>}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={`Actions for ${r.name}`} />}><MoreHorizontal aria-hidden /></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">{actions(r)}</DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </MenuArea>
              </li>
            ))}
          </ul>
          <div className="min-w-0 rounded-lg border">
            <div className="flex items-center gap-3 border-b p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{role.name}</div>
                <div className="text-xs text-muted-foreground">{locked ? 'Admin always has every permission.' : `${role.permissions.length} permissions`}{role.id === 'worker' && ' · Used when nothing else is picked.'}</div>
              </div>
              {role.id === 'worker' || !role.builtin ? <Button variant="outline" size="sm" onClick={() => setRenaming(role)}><Pencil size={14} aria-hidden />{role.id === 'worker' ? 'Description' : 'Rename'}</Button> : null}
            </div>
            <div className="border-b p-3"><Input type="search" aria-label="Search permissions" placeholder="Search permissions" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <div className="max-h-[calc(100vh-22rem)] overflow-auto">
              {[...byGroup].map(([group, ps]) => (
                <fieldset key={group}>
                  <legend className="sticky top-0 z-10 w-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">{group}</legend>
                  {ps.map(({ id: key, label, hint }) => (
                    <label key={key} className="flex cursor-pointer items-start gap-3 border-b px-3 py-2 text-[13px]">
                      <Checkbox className="mt-0.5" disabled={locked} checked={locked || role.permissions.includes(key)} onCheckedChange={(on) => toggle(key, !!on)} />
                      <span><span className="block leading-5">{label}</span>{hint && <span className="block text-xs leading-4 text-muted-foreground">{hint}</span>}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
              {byGroup.size === 0 && <p className="p-4 text-sm text-muted-foreground">No permission matches “{search}”.</p>}
            </div>
          </div>
        </div>
      )}</Reveal>
      {creating && <NameDialog title="New role" action="Create" onClose={() => setCreating(false)} onSubmit={(v) => run(async () => { const { id } = await trpc.roles.create.mutate(v); setSelected(id); }, 'Role created')} />}
      {renaming && <NameDialog title={`Edit ${renaming.name}`} action="Save" initial={renaming} onClose={() => setRenaming(undefined)}
        onSubmit={(v) => run(() => trpc.roles.update.mutate({ id: renaming.id, ...(renaming.id === 'worker' ? {} : { name: v.name }), description: v.description }), 'Role saved')} />}
      {del && <ConfirmDialog title={`Delete the ${del.name} role?`} body="Its members move to the default role for new users. This cannot be undone." action="Delete role" onClose={() => setDel(undefined)} onConfirm={() => run(() => trpc.roles.delete.mutate({ id: del.id }), 'Role deleted')} />}
    </Page>
  );
}
