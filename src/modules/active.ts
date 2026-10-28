import { db } from '../server/appdb.ts';
import type { HefynModule } from './types.ts';

// The modules that are switched on in this process, and the helpers the core uses to call their extension points. Deliberately a leaf
// (no imports of the registry or of any module): core files import this, the registry fills it at boot. A core file never imports a module.

/** Ids switched off: instance setting `modules_disabled` (comma list) plus env HEFYN_MODULES_DISABLED. Read once, at boot. */
const disabled = new Set([db.prepare("SELECT value FROM instance_settings WHERE key = 'modules_disabled'").get() as { value: string } | undefined]
  .flatMap((r) => (r?.value ?? '').split(',')).concat((process.env.HEFYN_MODULES_DISABLED ?? '').split(',')).map((s) => s.trim()).filter(Boolean));

/** Optional modules that are switched off are dropped; everything else stays. */
export const enabled = <T extends HefynModule>(list: T[]): T[] => list.filter((m) => !(m.optional && disabled.has(m.id)));

let list: HefynModule[] = [];
export const setActive = (l: HefynModule[]) => void (list = l);
export const active = () => list;

let all: HefynModule[] = [];
export const setAll = (l: HefynModule[]) => void (all = l);
/** Deleting a user's or a chat's data must reach every module, also one that is switched off now (its rows stay in the DB).
 *  A module that was never switched on has no tables: that one error is expected and skipped. */
export const forgetInAll = (call: (m: HefynModule) => void) => {
  for (const m of new Set([...all, ...list])) { // built-in (on or off) plus whatever is active (e.g. installed modules)
    try { call(m); } catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e; }
  }
};
