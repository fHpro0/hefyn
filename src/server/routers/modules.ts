import { forUser } from '../../modules/registry.ts';
import { authed, router } from '../trpc.ts';

// modules.*: what the console builds its nav, settings, palette and Roles page from. Installing and configuring declarative modules (the Modules page) moved to old/.
export const modulesRouter = router({
  list: authed.query(({ ctx }) => forUser(ctx.me.permissions)),
});
