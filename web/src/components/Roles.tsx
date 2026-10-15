import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api, useLoad } from './api';
import Shell from './Shell';
import { buttonDanger, buttonGhost, buttonPrimary, Chip, ConfirmDialog, Field, Input, Page, Row, Section, Switch, toast } from './ui';

interface Role { id: string; name: string; builtin: boolean; permissions: string[] }
interface Data { permissions: string[]; roles: Role[] }

const GROUPS: [string, [string, string, string][]][] = [
  ['Models', [['models.use', 'Chat with models', 'Start conversations and use the connected models.'], ['models.manage', 'Manage models', 'Connect providers and choose the default models.']]],
  ['People', [['users.manage', 'Manage users', 'Create accounts and change who has which role.'], ['roles.manage', 'Manage roles', 'Create, edit and delete roles.']]],
  ['Insights', [['usage.view_all', 'See everyone’s usage', 'View tokens and cost for all users, not just your own.']]],
  ['Profiles', [['profiles.edit_team', 'Edit team profiles', 'Change the shared agent profile and its models.']]],
  ['Hub', [['hub.install', 'Install from the hub', 'Add skills and plugins from the hub.'], ['hub.publish', 'Publish to the hub', 'Share your own skills and plugins.'], ['hub.approve', 'Approve hub items', 'Review and approve items before others can install them.']]],
  ['Sandbox', [['sandbox.shell', 'Use a shell sandbox', 'Run commands in an isolated container with the user’s files.']]],
  ['Connectors', [['mcp.run_managed', 'Run managed connectors', 'Use MCP servers that the company runs for you.']]],
];
const known = new Set(GROUPS.flatMap(([, ps]) => ps.map(([k]) => k)));

export default function Roles() {
  return <Shell>{() => <Content />}</Shell>;
}

function Content() {
  const { data, reload } = useLoad<Data>('/api/roles');
  const [editing, setEditing] = useState<string>();
  const [del, setDel] = useState<Role>();
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); ok && toast(ok); } catch (x) { toast((x as Error).message, true); } reload(); };
  // Permissions the server knows but this list does not still show up, under "Other".
  const groups = (perms: string[]): typeof GROUPS => {
    const extra = perms.filter((p) => !known.has(p));
    return extra.length ? [...GROUPS, ['Other', extra.map((p) => [p, p, ''] as [string, string, string])]] : GROUPS;
  };
  return (
    <Page title="Roles" hint="A role is a set of permissions. Admin can do everything and cannot be changed. Deleting a role moves its members to Worker.">
      {data?.roles.map((r) => (
        <Section key={r.id} title={editing === r.id
          ? <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); setEditing(undefined); if (name && name !== r.name) run(() => api(`/api/roles/${r.id}`, 'PATCH', { name }), 'Role renamed'); }}>
              <Input name="name" aria-label={`New name for ${r.name}`} defaultValue={r.name} required autoFocus className="w-56" onKeyDown={(e) => e.key === 'Escape' && setEditing(undefined)} />
              <button className={buttonPrimary}><Check size={14} aria-hidden />Save</button>
              <button type="button" className={buttonGhost} onClick={() => setEditing(undefined)}><X size={14} aria-hidden />Cancel</button>
            </form>
          : <span className="flex flex-wrap items-center gap-3">{r.name}{r.builtin && <Chip>Built in</Chip>}
              {!r.builtin && <span className="flex gap-2 text-sm font-normal">
                <button className={buttonGhost} onClick={() => setEditing(r.id)}><Pencil size={14} aria-hidden />Rename</button>
                <button className={buttonDanger} onClick={() => setDel(r)}><Trash2 size={14} aria-hidden />Delete</button></span>}</span>}>
          {groups(data.permissions).flatMap(([, perms]) => perms.filter(([k]) => data.permissions.includes(k))).map(([key, label, desc]) => (
            <Row key={key} compact title={label} hint={desc || undefined}>
              <div className="flex justify-end"><Switch label={`${label} for ${r.name}`} disabled={r.builtin} checked={r.permissions.includes(key)}
                onChange={(on) => run(() => api(`/api/roles/${r.id}`, 'PATCH', { permissions: on ? [...r.permissions, key] : r.permissions.filter((x) => x !== key) }))} /></div>
            </Row>
          ))}
        </Section>
      ))}
      <Section title="New role">
        <Row title="Create a role" hint="It starts with permission to chat. Turn on the rest afterwards.">
          <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const name = new FormData(form).get('name'); form.reset(); run(() => api('/api/roles', 'POST', { name, permissions: ['models.use'] }), 'Role created'); }}>
            <Field label="Name" className="grow"><Input name="name" required /></Field>
            <button className={buttonPrimary}><Plus size={16} aria-hidden />Create</button>
          </form>
        </Row>
      </Section>
      {del && <ConfirmDialog title={`Delete the ${del.name} role?`} body="Its members move to Worker. This cannot be undone." action="Delete role" onClose={() => setDel(undefined)} onConfirm={() => run(() => api(`/api/roles/${del.id}`, 'DELETE'), 'Role deleted')} />}
    </Page>
  );
}
