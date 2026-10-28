import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Data collections (docs/DATA.md): field definitions and per-type value validation. Pure: no database, no keys.
// The server is the source of truth; the UI only mirrors these rules.

export class DataError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 422;
  readonly details?: unknown;
  constructor(status: 400 | 403 | 404 | 409 | 413 | 422, message: string, details?: unknown) { super(message); this.status = status; this.details = details; }
}

export const FIELD_TYPES = ['text', 'longtext', 'number', 'bool', 'date', 'datetime', 'select', 'relation', 'email', 'url', 'json', 'duration'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  id: string; // stable across renames: the schema diff uses it
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean; // text, number, email
  default?: unknown; // a value of the type; date/datetime also '@today' / '@now', relation to users '@me'
  min?: number; max?: number; integer?: boolean; // number
  options?: string[]; // select
  multiple?: boolean; // select, relation
  collection?: string; // relation: a collection id, or 'users'
}

export const RESERVED = new Set(['id', 'created', 'updated', 'createdby', 'updatedby', 'expand', 'values']);
export const MAX_FIELDS = 60;
export const newFieldId = () => 'f' + randomBytes(5).toString('hex');

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const FieldInput = z.strictObject({
  id: z.string().max(40).optional(),
  name: z.string().regex(NAME, 'must start with a letter and use only letters, digits and _ (max 40)'),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  options: z.array(z.string().min(1).max(80)).max(100).optional(),
  multiple: z.boolean().optional(),
  collection: z.string().max(60).optional(),
});

const MAX_TEXT = 5000, MAX_LONGTEXT = 100_000, MAX_JSON = 65_536;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
const httpUrl = (s: string) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };
const jsonOk = (x: unknown) => { try { const s = JSON.stringify(x); return s !== undefined && s.length <= MAX_JSON; } catch { return false; } };

/** Validates a field list: shapes, names, type-specific options. Returns it with ids filled in. Defaults are checked against their own field. */
export function checkFields(input: unknown): Field[] {
  if (!Array.isArray(input)) throw new DataError(400, 'fields must be a list');
  if (input.length > MAX_FIELDS) throw new DataError(400, `at most ${MAX_FIELDS} fields`);
  const seen = new Set<string>(), ids = new Set<string>();
  const out = input.map((raw, i): Field => {
    const r = FieldInput.safeParse(raw);
    if (!r.success) throw new DataError(400, `field ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.') || 'field'} ${x.message}`).join('; ')}`);
    const f: Field = { ...r.data, id: r.data.id || newFieldId() };
    const where = `field "${f.name}"`;
    if (RESERVED.has(f.name.toLowerCase())) throw new DataError(400, `${where}: the name is reserved`);
    if (seen.has(f.name.toLowerCase())) throw new DataError(400, `${where}: duplicate name`);
    if (ids.has(f.id)) throw new DataError(400, `${where}: duplicate field id`);
    seen.add(f.name.toLowerCase()); ids.add(f.id);
    const t = f.type;
    if (f.unique && !['text', 'number', 'email'].includes(t)) throw new DataError(400, `${where}: unique is only for text, number and email`);
    if ((f.min !== undefined || f.max !== undefined || f.integer !== undefined) && t !== 'number') throw new DataError(400, `${where}: min, max and integer are only for number`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new DataError(400, `${where}: min is greater than max`);
    if (t === 'select') {
      if (!f.options?.length) throw new DataError(400, `${where}: a select needs at least one option`);
      if (new Set(f.options).size !== f.options.length) throw new DataError(400, `${where}: duplicate options`);
    } else if (f.options) throw new DataError(400, `${where}: options are only for select`);
    if (f.multiple && t !== 'select' && t !== 'relation') throw new DataError(400, `${where}: multiple is only for select and relation`);
    if (t === 'relation' ? !f.collection : f.collection) throw new DataError(400, `${where}: ${t === 'relation' ? 'a relation needs a target collection' : 'collection is only for relation'}`);
    if (t === 'bool') f.required = undefined; // a bool is always true or false
    return f;
  });
  for (const f of out) if (f.default !== undefined && f.default !== null) {
    const r = valueSchema(f, true).safeParse(f.default);
    if (!r.success) throw new DataError(400, `field "${f.name}": default ${r.error.issues[0]!.message}`);
  }
  return out;
}

/** The zod schema of one non-empty value. `allowTokens`: defaults may be '@today' / '@now' / '@me'. */
export function valueSchema(f: Field, allowTokens = false): z.ZodType {
  const one: z.ZodType = (() => {
    switch (f.type) {
      case 'text': return z.string().max(MAX_TEXT);
      case 'longtext': return z.string().max(MAX_LONGTEXT);
      case 'number': return z.number().refine((x) => !f.integer || Number.isInteger(x), 'must be a whole number')
        .refine((x) => f.min === undefined || x >= f.min, `must be at least ${f.min}`).refine((x) => f.max === undefined || x <= f.max, `must be at most ${f.max}`);
      case 'bool': return z.boolean();
      case 'date': return z.string().refine((s) => (allowTokens && s === '@today') || validDate(s), 'must be a date as YYYY-MM-DD');
      case 'datetime': return z.string().refine((s) => (allowTokens && s === '@now') || !Number.isNaN(Date.parse(s)), 'must be a date and time (ISO 8601)')
        .transform((s) => (s === '@now' ? s : new Date(s).toISOString()));
      case 'select': return z.string().refine((s) => (f.options ?? []).includes(s), 'must be one of the options');
      case 'relation': return z.string().min(1).max(80).refine((s) => allowTokens || s !== '@me', 'invalid id');
      case 'email': return z.string().trim().toLowerCase().max(254).email();
      case 'url': return z.string().trim().max(2000).refine(httpUrl, 'must be an http or https URL');
      case 'json': return z.unknown().refine(jsonOk, `must be JSON of at most ${MAX_JSON} characters`);
      case 'duration': return z.number().int('must be whole minutes').min(0).max(5_256_000);
    }
  })();
  return f.multiple ? z.array(one).max(200).refine((a) => new Set(a.map((x) => JSON.stringify(x))).size === a.length, 'duplicate entries') : one;
}

const isEmpty = (x: unknown) => x === undefined || x === null || x === '' || (Array.isArray(x) && !x.length);
export const emptyValue = isEmpty;

/** Today as YYYY-MM-DD in the server's time zone (set TZ for the team's own). */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function defaultFor(f: Field, me: string): unknown {
  const d = f.default;
  if (d === undefined || d === null) return f.type === 'bool' ? false : null;
  if (d === '@today') return today();
  if (d === '@now') return new Date().toISOString();
  if (d === '@me') return f.multiple ? [me] : me;
  return d;
}

/**
 * Checks `input` against the fields and returns the full record data (every field present, empty = null).
 * Unknown keys are refused. `create` fills defaults for keys that are absent; for an update pass the merged data.
 */
export function normalizeValues(fields: Field[], input: unknown, mode: 'create' | 'update', me: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataError(400, 'values must be an object');
  const src = input as Record<string, unknown>, byName = new Map(fields.map((f) => [f.name, f]));
  const problems: Record<string, string> = {};
  for (const k of Object.keys(src)) if (!byName.has(k)) problems[k] = 'unknown field';
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    let x = Object.hasOwn(src, f.name) ? src[f.name] : undefined;
    if (x === undefined && mode === 'create') x = defaultFor(f, me);
    // @today / @now / @me stand for the value they name (handy for agents); on any other type they are plain text
    if (x === '@today' && f.type === 'date') x = today();
    else if (x === '@now' && f.type === 'datetime') x = new Date().toISOString();
    else if (x === '@me' && f.type === 'relation' && f.collection === 'users') x = f.multiple ? [me] : me;
    if (isEmpty(x)) {
      if (f.required && f.type !== 'bool') problems[f.name] = 'is required';
      out[f.name] = f.type === 'bool' ? false : null;
      continue;
    }
    const r = valueSchema(f).safeParse(x);
    if (r.success) out[f.name] = r.data;
    else problems[f.name] = r.error.issues[0]!.message;
  }
  if (Object.keys(problems).length) throw new DataError(422, 'Some values are not valid: ' + Object.entries(problems).map(([k, m]) => `${k} ${m}`).join('; '), problems);
  return out;
}
