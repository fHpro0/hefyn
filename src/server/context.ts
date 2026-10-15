import { AsyncLocalStorage } from 'node:async_hooks';

/** The conversation (Flue instance) a model request belongs to; set around every Flue operation (redact.ts interceptor). */
export const als = new AsyncLocalStorage<string>();
/** Set by the privacy gate only after redaction succeeded: 'model' = a redacted model request, 'auth' = token refresh (no user content). */
export const stampAls = new AsyncLocalStorage<'model' | 'auth'>();
export const withStamp = <T>(kind: 'model' | 'auth', fn: () => T): T => stampAls.run(kind, fn);
