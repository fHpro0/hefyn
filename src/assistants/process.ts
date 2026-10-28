// An Assistant's optional process.json: the stages of a multi-stage, looping process. hefyn only validates and draws it; a script in the bundle runs it in the sandbox. Pure: no DOM, no database.

export interface Stage { id: string; title: string; by: string; does?: string; each?: string; end?: boolean }
export interface Next { from: string; to: string; when?: string; max?: number; then?: string }
export interface Process { version: 1; title: string; start: string; stages: Stage[]; next: Next[] }

export const NEXT_ITEM = 'next item', ALL_DONE = 'all items done';
// The same patterns as the runner (skills/run-process/process.py in the example bundles): what hefyn draws is what it runs.
const ID = /^[a-z][a-z0-9-]{0,31}$/, SCRIPT = /^script:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const LIMITS = { stages: 40, edges: 120 };

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** The process a text describes, or what is wrong with it (all problems at once, in plain words). `helperRoles`: the roles in helpers.json; `files`: every path in the bundle. */
export function parseProcess(text: string, ctx: { helperRoles: string[]; files: string[] }): { process?: Process; errors: string[] } {
  const errors: string[] = [];
  let raw: any;
  try { raw = JSON.parse(text); } catch { return { errors: ['Not valid JSON.'] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['Must be an object.'] };
  if (raw.version !== 1) errors.push('"version" must be 1.');
  if (!str(raw.title, 80)) errors.push('"title" is required (at most 80 characters).');
  if (!Array.isArray(raw.stages) || !raw.stages.length) return { errors: [...errors, '"stages" must be a list with at least one stage.'] };
  if (!Array.isArray(raw.next)) return { errors: [...errors, '"next" must be a list.'] };
  if (raw.stages.length > LIMITS.stages) errors.push(`At most ${LIMITS.stages} stages.`);
  if (raw.next.length > LIMITS.edges) errors.push(`At most ${LIMITS.edges} edges in "next".`);
  if (raw.stages.length > LIMITS.stages || raw.next.length > LIMITS.edges) return { errors }; // too big: do not walk it

  const ids = new Set<string>(), stages: Stage[] = [];
  for (const [i, s] of (raw.stages as any[]).entries()) {
    const at = typeof s?.id === 'string' ? `Stage "${s.id}"` : `Stage ${i + 1}`;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID.test(s.id)) { errors.push(`${at} needs an "id" of lower-case letters, digits and dashes (starting with a letter, at most 32).`); continue; }
    if (ids.has(s.id)) { errors.push(`${at} is defined twice.`); continue; }
    ids.add(s.id);
    if (typeof s.title !== 'string' || !s.title || s.title.length > 60) errors.push(`${at} needs a "title" (at most 60 characters).`);
    if (s.does !== undefined && (typeof s.does !== 'string' || s.does.length > 200)) errors.push(`${at}: "does" is at most 200 characters.`);
    if (s.each !== undefined && (typeof s.each !== 'string' || !ID.test(s.each))) errors.push(`${at}: "each" must name a list in lower-case letters, digits and dashes (at most 32).`);
    const by = s.by;
    if (by === 'agent' || by === 'person') { /* ok */ }
    else if (typeof by === 'string' && /^helper:[a-z][a-z0-9-]{0,31}$/.test(by)) { if (!ctx.helperRoles.includes(by.slice(7))) errors.push(`${at} is done by helper "${by.slice(7)}", which is not in helpers.json.`); }
    else if (typeof by === 'string' && SCRIPT.test(by)) { const [, skill, file] = SCRIPT.exec(by)!; if (!ctx.files.includes(`skills/${skill}/${file}`)) errors.push(`${at} runs "skills/${skill}/${file}", which is not in the Assistant's files.`); }
    else errors.push(`${at}: "by" must be "agent", "person", "helper:<role>" or "script:<skill>/<file>".`);
    stages.push({ id: s.id, title: s.title, by: s.by, ...(s.does ? { does: s.does } : {}), ...(s.each ? { each: s.each } : {}), ...(s.end ? { end: true } : {}) });
  }
  if (typeof raw.start !== 'string' || !ids.has(raw.start)) errors.push(`"start" must name a stage${typeof raw.start === 'string' ? ` ("${raw.start}" is not one)` : ''}.`);

  const next: Next[] = [], seen = new Set<string>();
  for (const e of raw.next as any[]) {
    if (!e || typeof e !== 'object' || typeof e.from !== 'string' || typeof e.to !== 'string') { errors.push('Every entry in "next" needs "from" and "to".'); continue; }
    const at = `Edge ${e.from} -> ${e.to}`;
    if (!ids.has(e.from) || !ids.has(e.to)) { errors.push(`${at} names a stage that does not exist.`); continue; }
    if (e.when === null) delete e.when; // the runner reads null as no "when"
    if (e.when !== undefined && (typeof e.when !== 'string' || !e.when || e.when.length > 40)) errors.push(`${at}: "when" is 1 to 40 characters.`);
    const k = `${e.from}\0${e.when ?? ''}`;
    if (seen.has(k)) errors.push(e.when === undefined ? `Stage "${e.from}" has more than one default way out (an edge without "when").` : `Stage "${e.from}" has "${e.when}" twice.`);
    seen.add(k);
    if (e.max !== undefined) {
      if (!Number.isInteger(e.max) || e.max < 1 || e.max > 20) errors.push(`${at}: "max" must be a whole number from 1 to 20.`);
      else if (e.then === undefined) errors.push(`Stage "${e.from}" sends "${e.when ?? 'on'}" back ${e.max} times but names no "then" stage.`);
    } else if (e.then !== undefined) errors.push(`${at}: "then" needs "max".`);
    if (e.then !== undefined && !ids.has(e.then)) errors.push(`${at}: "then" names a stage that does not exist ("${e.then}").`);
    next.push({ from: e.from, to: e.to, ...(e.when !== undefined ? { when: e.when } : {}), ...(e.max !== undefined ? { max: e.max } : {}), ...(e.then !== undefined ? { then: e.then } : {}) });
  }
  if (errors.length) return { errors };

  const out = (id: string) => next.filter((e) => e.from === id);
  for (const s of stages) {
    if (s.end && out(s.id).length) errors.push(`Stage "${s.id}" is an end stage but has edges leaving it.`);
    if (!s.end && !out(s.id).length) errors.push(`Stage "${s.id}" has no way out and is not an end stage.`);
  }
  // reachable: every edge's `to` and `then` counts, since the runner may take either
  const reach = (from: string) => { const r = new Set([from]), q = [from]; for (let id = q.pop(); id !== undefined; id = q.pop()) for (const e of out(id)) for (const t of [e.to, e.then]) if (t && !r.has(t)) { r.add(t); q.push(t); } return r; };
  const live = reach(raw.start);
  for (const s of stages) if (!live.has(s.id)) errors.push(`Stage "${s.id}" can not be reached from "${raw.start}".`);
  if (!stages.some((s) => s.end && live.has(s.id))) errors.push('No end stage can be reached.');
  for (const s of stages) {
    const items = out(s.id).filter((e) => e.when === NEXT_ITEM), done = out(s.id).filter((e) => e.when === ALL_DONE);
    if (!items.length && !done.length) continue;
    if (items.length !== done.length || out(s.id).some((e) => e.when === undefined)) { errors.push(`Stage "${s.id}": "${NEXT_ITEM}" and "${ALL_DONE}" come as a pair and without a default way out.`); continue; }
    if (!stages.some((x) => x.each && reach(x.id).has(s.id))) errors.push(`Stage "${s.id}" uses "${NEXT_ITEM}" but no stage with "each" comes before it.`);
  }
  if (errors.length) return { errors };
  return { process: { version: 1, title: raw.title, start: raw.start, stages, next }, errors: [] };
}

export interface LaidEdge extends Next { kind: 'forward' | 'back' }
/** `loops`: an "each" stage and the stage that holds its "all items done" edge, as positions in `stages`. */
export interface Layout { stages: Stage[]; /** `stages` from this index on are the side stages */ side: number; edges: LaidEdge[]; loops: { list: string; from: number; to: number }[] }

/** Stages top to bottom: the main path first (depth first from `start` along "to" edges: the default way out, then the "when" edges, "all items done" last), then the side stages (reached only as a `then` target, or from other side stages) from index `side` on. `back` = a real loop-back inside the main path (an arc); everything else is `forward`. */
export function layoutProcess(p: Process): Layout {
  const by = new Map(p.stages.map((s) => [s.id, s])), out = (id: string) => p.next.filter((e) => e.from === id);
  const rank = (e: Next) => (e.when === undefined ? 0 : e.when === ALL_DONE ? 2 : 1);
  const order: string[] = [], seen = new Set<string>();
  const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); order.push(id); for (const e of out(id).sort((a, b) => rank(a) - rank(b))) walk(e.to); };
  walk(p.start);
  const side = order.length;
  const add = (id: string) => { if (seen.has(id)) return; seen.add(id); order.push(id); for (const e of out(id)) add(e.to); };
  for (const id of order.slice(0, side)) for (const e of out(id)) if (e.then) add(e.then);
  for (const s of p.stages) add(s.id); // only a process that did not validate
  const pos = new Map(order.map((id, i) => [id, i]));
  const edges = p.next.map((e): LaidEdge => ({ ...e, kind: pos.get(e.from)! < side && pos.get(e.to)! <= pos.get(e.from)! ? 'back' : 'forward' }));
  const loops = order.flatMap((id, from) => {
    const s = by.get(id)!;
    if (!s.each) return [];
    const to = order.findIndex((x, i) => i >= from && p.next.some((e) => e.from === x && e.when === ALL_DONE));
    return [{ list: s.each, from, to: to < 0 ? from : to }];
  });
  return { stages: order.map((id) => by.get(id)!), side, edges, loops };
}

/** The process view of a bundle's files: nothing without a process.json, else the process (or null) and its errors prefixed with the file name. */
export function processOf(files: Record<string, string>): { process: Process | null; errors: string[] } {
  const text = files['process.json'];
  if (text === undefined) return { process: null, errors: [] };
  let roles: string[] = [];
  try { const h = JSON.parse(files['helpers.json'] ?? '[]'); roles = Array.isArray(h) ? h.map((x) => x?.role).filter((r) => typeof r === 'string') : []; } catch { /* helpers.json is reported by the draft */ }
  const r = parseProcess(text, { helperRoles: roles, files: Object.keys(files) });
  return { process: r.process ?? null, errors: r.errors.map((e) => `process.json: ${e}`) };
}
