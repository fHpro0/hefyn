import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ADMIN_ROLE, db, defaultRole } from '../appdb.ts';
import { auth, sendInvite } from '../auth.ts';
import { systemMailConfigured } from '../channels.ts';
import { cleanedHeaders, peerOf } from '../clientip.ts';
import { meFromUserId } from '../guard.ts';
import { dropTeamWrap } from '../keys.ts';
import { POLICIES, resetTwoFactor, setTwoFactorPolicy, twoFactorPolicy } from '../security.ts';
import { perm, router, userFacing } from '../trpc.ts';

// users.*: accounts, their role and the two-factor policy. All `users.manage`.
const manage = perm('users.manage');
const adminCount = () => (db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?').get(ADMIN_ROLE) as { n: number }).n;
const err = (code: TRPCError['code'], message: string): never => { throw new TRPCError({ code, message }); };

export const usersRouter = router({
  list: manage.query(() =>
    db.prepare('SELECT u.id, u.email, u.name, r.id AS roleId, r.name AS role FROM user u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id ORDER BY u.createdAt').all() as { id: string; email: string; name: string; roleId: string; role: string }[]),

  // Invite = admin creates the account with a temporary password; signups are otherwise closed. `invite` + system mail: the password is ignored and a "set your password" mail is sent.
  create: manage.input(z.object({ name: z.string().optional(), email: z.string(), password: z.string().optional(), roleId: z.string().optional(), invite: z.boolean().optional() })).mutation(({ ctx: { c }, input: { name, email, password, roleId = defaultRole(), invite } }) => {
    const mail = !!invite && systemMailConfigured();
    if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) err('BAD_REQUEST', 'Unknown role');
    return userFacing(async () => {
      const r = await auth.api.signUpEmail({ body: { name: name || email, email, password: (!mail && password) || randomUUID() }, headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) });
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, roleId);
      if (!mail && password) db.prepare('INSERT OR IGNORE INTO password_set_by_admin (user_id) VALUES (?)').run(r.user.id); // the admin knows it: it never wraps a data key
      if (mail) await sendInvite(email);
      return { id: r.user.id, invited: mail };
    });
  }),

  setRole: manage.input(z.object({ id: z.string(), roleId: z.string() })).mutation(({ input: { id, roleId } }) => {
    if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) err('BAD_REQUEST', 'Unknown role');
    const cur = meFromUserId(id);
    if (!cur) err('NOT_FOUND', 'Unknown user');
    if (cur!.roleId === ADMIN_ROLE && roleId !== ADMIN_ROLE && adminCount() <= 1) err('CONFLICT', 'The last Admin cannot be demoted.');
    db.prepare('UPDATE user_roles SET role_id = ? WHERE user_id = ?').run(roleId, id);
    if (roleId !== ADMIN_ROLE) dropTeamWrap(id); // a demoted admin no longer opens the team key at sign-in
    return { ok: true };
  }),

  twoFactorPolicy: manage.query(() => ({ policy: twoFactorPolicy() })),
  setTwoFactorPolicy: manage.input(z.object({ policy: z.enum(POLICIES, 'policy must be off, admins or everyone') })).mutation(({ input }) => (setTwoFactorPolicy(input.policy), { ok: true })),
  // Lost device: turns TOTP off and removes backup codes and passkeys. Not for yourself (use Security).
  resetTwoFactor: manage.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input: { id } }) => {
    if (id === me.id) err('CONFLICT', 'Use the Security page for your own account.');
    if (!meFromUserId(id)) err('NOT_FOUND', 'Unknown user');
    resetTwoFactor(id);
    return { ok: true };
  }),
});
