import { createTRPCClient, httpBatchLink, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '../../../src/server/router.ts'; // type only: no server code reaches the bundle

// Same-origin, cookies as fetch sends them. Errors surface `message` like api() does; a locked key opens the unlock dialog (Unlock.tsx).
const errors: TRPCLink<AppRouter> = () => ({ op, next }) => observable((o) => next(op).subscribe({
  next: o.next, complete: o.complete,
  error(e) {
    const scope = e.data?.scope;
    if (scope) { dispatchEvent(new CustomEvent('hefyn-locked', { detail: { scope } })); e.message = 'Locked'; }
    o.error(e);
  },
}));

export const trpc = createTRPCClient<AppRouter>({ links: [errors, httpBatchLink({ url: '/api/trpc' })] });
