import { requestRestart, runtimeInfo } from '../runtime.ts';
import { authed, perm, router } from '../trpc.ts';

// runtime.*: the agent process (state, restart).
const manage = perm('models.manage');

export const runtimeRouter = router({
  info: authed.query(() => runtimeInfo()),
  restart: manage.mutation(({ ctx: { me } }) => (requestRestart(me.email), runtimeInfo())),
});
