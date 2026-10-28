import { AsyncLocalStorage } from 'node:async_hooks';

/** The conversation (Flue instance) a model request belongs to; set around every Flue operation (model-access.ts interceptor). */
export const als = new AsyncLocalStorage<string>();
