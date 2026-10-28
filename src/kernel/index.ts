import { Context, Service } from 'cordis';
import { db, grantAdmin, seedWorkerPermission } from '../server/appdb.ts';
import { PERMISSIONS, registerPermissions } from '../server/permissions.ts';
import { enabled } from '../modules/active.ts';
import { providerRegistry, type StorageProvider } from '../server/connections/types.ts';
import type { HefynModule } from '../modules/types.ts';

// The plugin kernel (Cordis, vendored in vendor/cordis) of one process. A HefynModule is loaded as a plugin by `modulePlugin`; switching a
// module off means not loading it, and disposing its fiber takes back everything it contributed.

declare module 'cordis' {
  interface Context { modules: ModulesService; storage: StorageService }
  interface Events { 'modules/start-jobs'(ids: string[]): void }
}

/** Owns the module registry state of a kernel: the loaded modules, in load order. The array is mutated in place (callers hold it). */
export class ModulesService extends Service {
  private mods: HefynModule[] = [];
  constructor(ctx: Context) { super(ctx, 'modules'); }
  list = () => this.mods;

  /** Registers a module's contributions; the returned function removes them again. */
  add(m: HefynModule): () => void {
    this.mods.push(m);
    const added = (m.permissions ?? []).map((p) => p.id).filter((id) => !PERMISSIONS.includes(id));
    if (m.permissions?.length) {
      registerPermissions(added);
      for (const p of m.permissions) if (p.worker) seedWorkerPermission(p.id);
      grantAdmin(); // Admin always has every permission, including the ones modules added after appdb loaded
    }
    return () => {
      this.mods.splice(this.mods.indexOf(m), 1);
      for (const id of added) PERMISSIONS.splice(PERMISSIONS.indexOf(id), 1);
    };
  }

  /** Starts the background jobs of every loaded module (once per call; the web process calls it once). Returns the job names. */
  startJobs(): string[] {
    const ids: string[] = [];
    this.ctx.emit('modules/start-jobs', ids);
    return ids;
  }
}

/** The Files connection kinds (docs/STORAGE.md) that loaded modules registered; the map is shared with the sync engine, which also runs where no kernel does. */
export class StorageService extends Service {
  constructor(ctx: Context) { super(ctx, 'storage'); }
  list = () => [...providerRegistry.values()];
  get = (kind: string) => providerRegistry.get(kind);
  /** Registers a kind; the returned function removes it again. */
  add(p: StorageProvider): () => void {
    providerRegistry.set(p.kind, p); // one registry per process; a second kernel (tests) just replaces the entry
    return () => void (providerRegistry.get(p.kind) === p && providerRegistry.delete(p.kind));
  }
}

/** One existing HefynModule as a Cordis plugin: migrate, register its contributions, and (on `startJobs`) run its jobs until disposed. */
export const modulePlugin = (m: HefynModule) => ({
  name: m.id,
  inject: ['modules', 'storage'],
  apply(ctx: Context) {
    m.migrate?.(db);
    ctx.effect(() => ctx.modules.add(m));
    for (const p of m.storageProviders ?? []) ctx.effect(() => ctx.storage.add(p));
    ctx.on('modules/start-jobs', (ids) => {
      for (const j of m.jobs ?? []) {
        const id = `${m.id}.${j.name}`;
        try { j.init?.(); } catch (e) { console.error(`[hefyn] job ${id} init:`, e); }
        const go = async () => { try { await j.run(); } catch (e) { console.error(`[hefyn] job ${id}:`, e); } };
        const every = setInterval(go, j.everyMs), first = setTimeout(go, j.first ?? j.everyMs);
        every.unref(); first.unref();
        ctx.effect(() => () => { clearInterval(every); clearTimeout(first); });
        ids.push(id);
      }
    });
  },
});

export function createKernel(): Context {
  const ctx = new Context();
  ctx.plugin(ModulesService);
  ctx.plugin(StorageService);
  return ctx;
}

/** Loads the modules that are switched on (HEFYN_MODULES_DISABLED / `modules_disabled`) as plugins; the rest are never loaded. */
export const loadModules = (ctx: Context, list: HefynModule[]) => enabled(list).map((m) => ctx.plugin(modulePlugin(m)));

/** Boot check: throws when any plugin is not active, naming it and the services it waits for (a pending plugin would otherwise stay silent). */
export async function bootCheck(ctx: Context) {
  await new Promise((r) => setTimeout(r, 0)); // plugins whose services are there start within this tick
  const fibers = [...ctx.registry.values()].flatMap((r) => [...r.fibers]);
  await Promise.allSettled(fibers.filter((f) => f.state === 1)); // still loading (async apply): wait for the outcome
  for (const f of fibers) {
    if (f.state === 2) continue;
    if (f.state === 3) throw new Error(`plugin "${f.name}" failed to start`, { cause: await f.await().then(() => undefined, (e: unknown) => e) });
    const missing = Object.keys(f.inject).filter((k) => !f.parent.get(k));
    throw new Error(`plugin "${f.name}" did not start: missing service(s) ${missing.join(', ') || '(unknown)'}`);
  }
}
