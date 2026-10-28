import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import { authorize, type Me } from './guard.ts';
import type { AnyPermission } from './permissions.ts';
import { LockedError } from './vault.ts';

// tRPC for the console API (docs/API.md "tRPC"). Context = the Hono request; auth is guard.ts's authorize(), the same decision requireAuth makes.
export interface Ctx { c: Context }

// Zod failures read "path: message" (the first issue), like the UI's splitError expects; a locked key carries its scope so the client can open the unlock dialog.
const t = initTRPC.context<Ctx>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message: error.cause instanceof ZodError ? error.cause.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))[0] ?? 'invalid input' : shape.message,
    data: { ...shape.data, scope: error.cause instanceof LockedError ? error.cause.scope : undefined, details: (error.cause as { details?: unknown } | undefined)?.details }, // details: a message per field (DataError 422)
  }),
});

// The ONE place domain errors become tRPC codes: any error with an HTTP `status` (HubError, ModuleError, StorageError, ...) keeps it; messages stay user-facing.
const CODES: Record<number, TRPC_ERROR_CODE_KEY> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE_CONTENT', 423: 'PRECONDITION_FAILED', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE' };
const mapErrors = t.middleware(async ({ next }) => {
  const r = await next();
  if (r.ok) return r;
  const e = r.error.cause;
  if (r.error.code !== 'INTERNAL_SERVER_ERROR') return r; // a TRPCError thrown on purpose, or a zod input failure
  if (e instanceof LockedError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'locked', cause: e });
  const status = (e as { status?: number } | undefined)?.status;
  if (status && CODES[status]) throw new TRPCError({ code: CODES[status], message: (e as Error).message, cause: e });
  console.error('[hefyn]', e);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'internal error' });
});

export const router = t.router;
export const publicProcedure = t.procedure.use(mapErrors);

const AUTH_CODES = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN' } as const;
const guarded = (keys: AnyPermission[]) => publicProcedure.use(async ({ ctx, next }) => {
  const r = await authorize(ctx.c, keys);
  if (!('id' in r)) throw new TRPCError({ code: AUTH_CODES[r.status], message: r.error });
  return next({ ctx: { ...ctx, me: r as Me } });
});
/** A signed-in user past the 2FA / password-change gate; `ctx.me` is set. */
export const authed = guarded([]);
/** Like `authed`, and the user must hold ANY of the listed permissions (same semantics as requirePermission). */
export const perm = (...ids: [AnyPermission, ...AnyPermission[]]) => guarded(ids);

/** Run domain code whose plain `Error`s are user-facing validation messages (the old REST `fail(c, e)`): they become 400s; status-carrying and locked errors keep theirs. */
export async function userFacing<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof LockedError || e instanceof TRPCError ||(e as { status?: number })?.status || !(e instanceof Error)) throw e;
    throw new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: e });
  }
}
