import { z } from 'zod';
import * as hub from '../hub.ts';
import { listSkills, readSkill, setOn } from '../skills.ts';
import { authed, router } from '../trpc.ts';

// skills.*: the Skills page. A skill is a Hub package of kind `skill` (SKILL.md and its files), private to its author until they share it (`skills.share`).
// Everything is the caller's own or the team's; the on/off switch is per person and applies to plain-agent chats (an Assistant names its own skills).
const id = z.object({ id: z.string() });
const files = z.array(z.object({ path: z.string().max(300), content: z.string() })).max(200).optional();
const fields = { name: z.string().max(64), description: z.string().max(2000), instructions: z.string().max(200_000), files };

export const skillsRouter = router({
  list: authed.query(({ ctx }) => listSkills(ctx.me)),
  get: authed.input(id).query(({ ctx, input }) => readSkill(ctx.me, input.id)),
  /** Create (no id) or change one of your own. A shared skill stays shared: whoever may share it approves the change at once. */
  save: authed.input(z.object({ id: z.string().optional(), ...fields })).mutation(async ({ ctx: { me }, input: { id: pid, files: extra, ...body } }) => {
    const more = extra ? { files: extra } : {}; // no files given: an update keeps the ones it has
    const p = pid ? await hub.updatePackage(me, pid, { ...body, ...more, name: undefined }) : await hub.createPackage(me, { kind: 'skill', ...body, ...more });
    return p.visibility === 'team' && me.permissions.includes('skills.share') ? hub.shareSkill(me, p.id) : p;
  }),
  remove: authed.input(id).mutation(({ ctx, input }) => { hub.deletePackage(ctx.me, input.id); return { ok: true }; }),
  share: authed.input(id).mutation(({ ctx, input }) => hub.shareSkill(ctx.me, input.id)),
  unshare: authed.input(id).mutation(({ ctx, input }) => hub.unshareSkill(ctx.me, input.id)),
  setOn: authed.input(id.extend({ on: z.boolean() })).mutation(({ ctx, input }) => { setOn(ctx.me.id, 'skill', input.id, input.on); return { ok: true }; }),
});
