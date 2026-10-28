import type { useTool } from '@flue/runtime';
import * as v from 'valibot';
import { actorOf, countRecords, createRecord, getCol, hasCollections, listCollections, queryRecords, updateRecord, type Col, type Out } from '../server/data.ts';
import { DataError, today } from '../server/data-schema.ts';
import { LockedError } from '../server/vault.ts';

// Agent tools for data collections (docs/DATA.md). Only for users with data.use who can see at least one collection, and only for the
// collections they can access. There is no delete tool: deleting stays in the UI. Results go to the model like every tool result.

const MAX_CHARS = 60_000;
const FILTER_HELP = 'Filter syntax: field op value, joined with && and || and grouped with ( ). Operators: = != > >= < <= ~ (contains, case-insensitive) !~. '
  + 'Values: "text" or \'text\' in quotes, numbers, true, false, null, and @today, @now, @me (the user), @weekStart, @weekEnd, @monthStart, @monthEnd. '
  + 'Dates are "YYYY-MM-DD". For a relation field, follow it one level with a dot: project.name ~ "web". For fields with several values, = means "contains". '
  + 'Examples: status != "done" && due <= @today   |   date >= @weekStart && date <= @weekEnd   |   project.name = "Website" && billable = true. '
  + 'System fields: id, created, updated.';

const label = (o: Out) => Object.values(o.values).find((x) => typeof x === 'string' && x) ?? o.id;

/** A record as the model sees it: id plus the values; relations as {id, label}. */
function compact(col: Col, r: Out) {
  const row: Record<string, unknown> = { id: r.id, ...r.values };
  for (const f of col.fields) {
    const e = r.expand?.[f.name];
    if (f.type !== 'relation' || e === undefined) continue;
    const one = (x: any) => (x ? { id: x.id, label: f.collection === 'users' ? x.name : label(x) } : null);
    row[f.name] = Array.isArray(e) ? e.map(one) : one(e) ?? row[f.name];
  }
  return row;
}

function guarded(f: () => unknown): string {
  try { return JSON.stringify(f()); } catch (e) {
    if (e instanceof DataError) return `Error: ${e.message}`;
    if (e instanceof LockedError) return 'Error: the user’s data is locked until they sign in again.';
    throw e;
  }
}

/** Registers the four tools through `use` (Flue's useTool) when the user has data.use and at least one collection. */
export function useDataTools(userId: string, use: typeof useTool): void {
  const a = actorOf(userId);
  if (!a || !a.permissions.includes('data.use') || !hasCollections(a)) return;
  const relations = (c: Col) => c.fields.filter((f) => f.type === 'relation').map((f) => f.name).join(',');
  const shown = (c: Col, r: Out) => compact(c, queryRecords(a, c, { filter: `id = "${r.id}"`, expand: relations(c), perPage: 1 }).items[0] ?? r); // with relation labels
  const slugOf =(id: string, all: Col[]) => (id === 'users' ? 'users' : all.find((c) => c.id === id)?.slug ?? id);
  use({
    name: 'data_collections',
    description: 'List the user’s data collections (their own tables such as tasks, projects or time entries, plus shared team ones): name, slug, fields with types, and record counts. Call this first to learn the field names, select options and relations. Also returns today’s date.',
    input: v.object({}),
    async run() {
      return guarded(() => {
        const { items } = listCollections(a);
        return { today: today(), collections: items.map((c) => ({ name: c.name, slug: c.slug, scope: c.scope, description: c.description || undefined, records: countRecords(c.id), canEdit: c.level !== 'view',
          fields: c.fields.map((f) => ({ name: f.name, type: f.type, required: f.required || undefined, options: f.options, multiple: f.multiple || undefined, relatesTo: f.type === 'relation' ? slugOf(f.collection!, items) : undefined })) })) };
      });
    },
  });
  use({
    name: 'data_query',
    description: `Read records of a data collection. \`collection\` is its slug or name. ${FILTER_HELP} \`sort\` is a comma list of fields, "-" first for descending ("-due,title"). \`limit\` is at most 200 (default 50). Relations come back as {id, label}.`,
    input: v.object({ collection: v.string(), filter: v.optional(v.string()), sort: v.optional(v.string()), limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))) }),
    async run({ data }) {
      return guarded(() => {
        const col = getCol(a, data.collection);
        const r = queryRecords(a, col, { filter: data.filter, sort: data.sort, perPage: data.limit ?? 50, page: 1, expand: relations(col) });
        const records: unknown[] = [];
        let size = 0;
        for (const it of r.items) { const row = compact(col, it); size += JSON.stringify(row).length; if (size > MAX_CHARS) break; records.push(row); }
        return { collection: col.slug, total: r.totalItems, shown: records.length, records, note: records.length < r.totalItems ? 'More records match: narrow the filter or raise limit (max 200).' : undefined };
      });
    },
  });
  use({
    name: 'data_create',
    description: 'Add a record to a data collection the user can edit. `values` maps field names to values: text as string, number as number, bool as true/false, date as "YYYY-MM-DD", datetime as ISO 8601, select as one of its options (a list if multiple), duration as whole minutes (2 h = 120), relation as the related record’s id (look it up with data_query first; users: their id). Omitted fields get their default. Returns the new record.',
    input: v.object({ collection: v.string(), values: v.record(v.string(), v.any()) }),
    async run({ data }) {
      return guarded(() => { const col = getCol(a, data.collection); return shown(col, createRecord(a, col, data.values)); });
    },
  });
  use({
    name: 'data_update',
    description: 'Change a record: `id` from data_query, `values` only the fields to change (same value formats as data_create; null clears a field). Returns the updated record. Deleting records is not possible from here.',
    input: v.object({ collection: v.string(), id: v.string(), values: v.record(v.string(), v.any()) }),
    async run({ data }) {
      return guarded(() => { const col = getCol(a, data.collection); return shown(col, updateRecord(a, col, data.id, data.values)); });
    },
  });
}
