import { bootCheck, createKernel, loadModules } from '../kernel/index.ts';
import { setActive, setAll } from './active.ts';
import { builtin } from './builtin.ts';
import { installedModules } from './installed.ts';
import type { HefynModule } from './types.ts';

// Throws at startup on a broken module list; the message names the offender.
export function validateModules(list: HefynModule[]): HefynModule[] {
  const ids = new Set<string>();
  const perms = new Set<string>();
  for (const m of list) {
    if (ids.has(m.id)) throw new Error(`module "${m.id}": duplicate module id`);
    ids.add(m.id);
    for (const p of m.permissions ?? []) {
      if (perms.has(p.id)) throw new Error(`module "${m.id}": duplicate permission id "${p.id}"`);
      perms.add(p.id);
    }
  }
  for (const m of list) {
    for (const e of [...(m.nav ?? []), ...(m.commands ?? [])]) {
      if (!e.href.startsWith('/')) throw new Error(`module "${m.id}": href "${e.href}" must start with /`);
      for (const p of [e.permission ?? []].flat()) if (!perms.has(p)) throw new Error(`module "${m.id}": "${e.label}" needs unknown permission "${p}"`);
    }
  }
  return list;
}

// Optional modules that are switched off (instance setting / HEFYN_MODULES_DISABLED) are not in this list, so they register nothing anywhere.
const every = validateModules(builtin);
export const kernel = createKernel();
loadModules(kernel, every);
await bootCheck(kernel);
const list = kernel.modules.list();
export const modules = () => list;
setActive(list);
setAll(every); // deletions (start fresh, chat delete) also reach switched-off modules

/** Starts every enabled module's background jobs (web process only); a failing run is logged and the loop goes on. Returns the job names. */
let started = false;
export function startJobs(): string[] {
  if (started) return [];
  started = true;
  return kernel.modules.startJobs();
}

// Built-in modules plus the enabled installed ones (read per call: install and enable take effect at once).
const current = () => [...list, ...installedModules()];

export const permissionInfo = (all = current()) => all.flatMap((m) => (m.permissions ?? []).map(({ id, label, hint, group }) => ({ id, label, hint, group: group ?? m.name })));

const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? 100) - (b.order ?? 100);

// What the console builds its sidebar, settings list, palette and Roles page from: only entries the user may use.
export function forUser(held: readonly string[]) {
  const all = current();
  const ok = (p?: string | string[]) => !p || [p].flat().some((k) => held.includes(k));
  return {
    modules: all.map(({ id, name, icon }) => ({ id, name, icon })),
    nav: all.flatMap((m) => m.nav ?? []).filter((n) => ok(n.permission)).sort(byOrder),
    commands: all.flatMap((m) => m.commands ?? []).filter((n) => ok(n.permission)).sort(byOrder),
    permissions: permissionInfo(all),
  };
}
