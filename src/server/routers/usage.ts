import { usageSummary } from '../usage.ts';
import { authed, perm, router } from '../trpc.ts';

export const usageRouter = router({
  me: authed.query(({ ctx: { me } }) => usageSummary(me.id)),
  all: perm('usage.view_all').query(() => usageSummary()),
});
