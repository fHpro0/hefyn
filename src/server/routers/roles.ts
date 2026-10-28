import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ADMIN_ROLE, WORKER_ROLE, db, defaultRole, modulePermissions } from '../appdb.ts';
import { isPermission, NEW_ROLE_DEFAULTS, PERMISSIONS } from '../permissions.ts';
import { perm, router } from '../trpc.ts';

// roles.*: who may do what. Listing is open to users.manage too (the user editor picks a role); changes need roles.manage.
// Admin is locked (always every permission); Worker is editable (permissions, description) but keeps its name and cannot be deleted.
const permissions = z.array(z.string().refine(isPermission, 'unknown permission'));
const name = z.string().trim().min(1, 'a name is required');
const manage = perm('roles.manage');
const taken = () => new TRPCError({ code: 'CONFLICT', message: 'A role with this name already exists.' });
const known = (id: string) => {
  const role = db.prepare('SELECT name, description, permissions FROM roles WHERE id = ?').get(id) as { name: string; description: string; permissions: string } | undefined;
  if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown role' });
  return role;
};
const conflict = (message: string) => new TRPCError({ code: 'CONFLICT', message });

export const rolesRouter = router({
  list: perm('roles.manage', 'users.manage').query(() => ({
    permissions: [...PERMISSIONS, ...modulePermissions()],
    defaultRole: defaultRole(),
    roles: (db.prepare('SELECT id, name, description, builtin, permissions FROM roles ORDER BY builtin DESC, name').all() as any[]).map((r): { id: string; name: string; description: string; builtin: boolean; permissions: string[] } => ({ ...r, builtin: !!r.builtin, permissions: JSON.parse(r.permissions) })),
  })),
  create: manage.input(z.object({ name, description: z.string().trim().default(''), permissions: permissions.default(NEW_ROLE_DEFAULTS) })).mutation(({ input }) => {
    const id = randomUUID();
    try { db.prepare('INSERT INTO roles (id, name, description, builtin, permissions) VALUES (?, ?, ?, 0, ?)').run(id, input.name, input.description, JSON.stringify(input.permissions)); } catch { throw taken(); }
    return { id };
  }),
  duplicate: manage.input(z.object({ id: z.string() })).mutation(({ input }) => {
    const src = known(input.id), id = randomUUID();
    let n = 1, label = `${src.name} copy`;
    while (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(label)) label = `${src.name} copy ${++n}`;
    db.prepare('INSERT INTO roles (id, name, description, builtin, permissions) VALUES (?, ?, ?, 0, ?)').run(id, label, src.description, src.permissions);
    return { id };
  }),
  update: manage.input(z.object({ id: z.string(), name: name.optional(), description: z.string().trim().optional(), permissions: permissions.optional() })).mutation(({ input }) => {
    known(input.id);
    if (input.id === ADMIN_ROLE) throw conflict('Admin always has every permission and cannot be changed.');
    if (input.id === WORKER_ROLE && input.name) throw conflict('Worker cannot be renamed.');
    try {
      if (input.name) db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(input.name, input.id);
      if (input.description !== undefined) db.prepare('UPDATE roles SET description = ? WHERE id = ?').run(input.description, input.id);
      if (input.permissions) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(input.permissions), input.id);
    } catch { throw taken(); }
    return { ok: true };
  }),
  delete: manage.input(z.object({ id: z.string() })).mutation(({ input }) => {
    known(input.id);
    if (input.id === ADMIN_ROLE || input.id === WORKER_ROLE) throw conflict('Built-in roles cannot be deleted.');
    if (input.id === defaultRole()) throw conflict('This is the default role for new users. Pick another default first.');
    db.prepare('UPDATE user_roles SET role_id = ? WHERE role_id = ?').run(defaultRole(), input.id); // members move to the default role
    db.prepare('DELETE FROM roles WHERE id = ?').run(input.id);
    return { ok: true };
  }),
  setDefault: manage.input(z.object({ id: z.string() })).mutation(({ input }) => {
    known(input.id);
    db.prepare("INSERT INTO instance_settings (key, value) VALUES ('default_role', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(input.id);
    return { ok: true };
  }),
});
