import { DataError, emptyValue, today, type Field, type FieldType } from './data-schema.ts';

// Filter and sort language of data collections (docs/DATA.md), a PocketBase-like subset. A hand-written tokenizer and
// recursive-descent parser build an AST; `compileFilter` turns it into a plain function. Nothing is evaluated as code,
// and string literals can only ever be compared, never interpreted.
//
//   expr   := and ('||' and)*          and := primary ('&&' primary)*
//   primary:= '(' expr ')' | path op value
//   path   := field | field '.' field   (the second is a field of the related record; users: name)
//   op     := = != > >= < <= ~ !~
//   value  := "text" | 'text' | 12.5 | true | false | null | @now | @today | @me | @weekStart | @weekEnd | @monthStart | @monthEnd

export class FilterError extends DataError {
  constructor(message: string, pos?: number) { super(400, pos === undefined ? message : `filter: ${message} (at position ${pos + 1})`); }
}

export interface Rec { id: string; created: string; updated: string; createdBy: string | null; updatedBy: string | null; data: Record<string, unknown> }
export interface Related { fields: Field[]; get(id: string): Rec | undefined }
export interface FilterCtx { fields: Field[]; me: string; now?: Date; related(f: Field): Related }

const MAX_FILTER = 2000, MAX_TOKENS = 200, MAX_DEPTH = 20;

type Tok = { k: 'str' | 'num' | 'id' | 'op' | '(' | ')' | '&&' | '||'; v: string | number; pos: number };
const OPS = ['!=', '!~', '>=', '<=', '=', '>', '<', '~'];

function tokenize(s: string): Tok[] {
  if (s.length > MAX_FILTER) throw new FilterError(`at most ${MAX_FILTER} characters`);
  const out: Tok[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (out.length >= MAX_TOKENS) throw new FilterError('too long');
    if (c === '(' || c === ')') { out.push({ k: c, v: c, pos: i }); i++; continue; }
    if (s.startsWith('&&', i) || s.startsWith('||', i)) { out.push({ k: s.slice(i, i + 2) as '&&', v: s.slice(i, i + 2), pos: i }); i += 2; continue; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) { out.push({ k: 'op', v: op, pos: i }); i += op.length; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, str = '';
      for (; j < s.length && s[j] !== c; j++) {
        if (s[j] === '\\') { j++; if (j >= s.length) break; str += ({ n: '\n', t: '\t' } as Record<string, string>)[s[j]!] ?? s[j]; } else str += s[j];
      }
      if (s[j] !== c) throw new FilterError('unterminated string', i);
      out.push({ k: 'str', v: str, pos: i }); i = j + 1; continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (num && !/[A-Za-z_]/.test(s[i + num[0].length] ?? '')) { out.push({ k: 'num', v: Number(num[0]), pos: i }); i += num[0].length; continue; }
    const id = /^@?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(s.slice(i));
    if (id) { out.push({ k: 'id', v: id[0], pos: i }); i += id[0].length; continue; }
    throw new FilterError(`unexpected "${c}"`, i);
  }
  return out;
}

type Lit = { k: 'str' | 'num' | 'bool' | 'null' | 'var'; v: string | number | boolean | null };
export type Node = { t: 'and'; a: Node; b: Node } | { t: 'or'; a: Node; b: Node } | { t: 'cmp'; path: string[]; op: string; lit: Lit; pos: number };

export function parseFilter(src: string): Node {
  const toks = tokenize(src);
  if (!toks.length) throw new FilterError('empty filter');
  let i = 0;
  const peek = () => toks[i];
  const expr = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new FilterError('nested too deeply', peek()?.pos);
    let a = and(depth);
    while (peek()?.k === '||') { i++; a = { t: 'or', a, b: and(depth) }; }
    return a;
  };
  const and = (depth: number): Node => {
    let a = primary(depth);
    while (peek()?.k === '&&') { i++; a = { t: 'and', a, b: primary(depth) }; }
    return a;
  };
  const primary = (depth: number): Node => {
    const t = peek();
    if (!t) throw new FilterError('unexpected end, expected a field or "("', src.length - 1);
    if (t.k === '(') { i++; const e = expr(depth + 1); if (peek()?.k !== ')') throw new FilterError('missing ")"', peek()?.pos ?? src.length - 1); i++; return e; }
    if (t.k !== 'id' || String(t.v).startsWith('@')) throw new FilterError('expected a field name', t.pos);
    i++;
    const op = peek();
    if (op?.k !== 'op') throw new FilterError(`expected an operator after ${t.v} (= != > >= < <= ~ !~)`, op?.pos ?? src.length - 1);
    i++;
    const val = peek();
    if (!val) throw new FilterError('expected a value', src.length - 1);
    i++;
    let lit: Lit;
    if (val.k === 'str') lit = { k: 'str', v: val.v as string };
    else if (val.k === 'num') lit = { k: 'num', v: val.v as number };
    else if (val.k === 'id') {
      if (val.v === 'true' || val.v === 'false') lit = { k: 'bool', v: val.v === 'true' };
      else if (val.v === 'null') lit = { k: 'null', v: null };
      else if (String(val.v).startsWith('@')) lit = { k: 'var', v: val.v as string };
      else throw new FilterError(`put text in quotes: "${val.v}"`, val.pos);
    } else throw new FilterError('expected a value', val.pos);
    return { t: 'cmp', path: String(t.v).split('.'), op: op.v as string, lit, pos: t.pos };
  };
  const ast = expr(0);
  if (i < toks.length) throw new FilterError(`unexpected "${toks[i]!.v}" (use && or ||)`, toks[i]!.pos);
  return ast;
}

// ---- compile ----
const iso = (d: Date) => d.toISOString();
function variable(name: string, ctx: FilterCtx, pos: number): string {
  const now = ctx.now ?? new Date(), mondayOffset = (now.getDay() + 6) % 7;
  const day = (offset: number) => today(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  switch (name) {
    case '@me': return ctx.me;
    case '@now': return iso(now);
    case '@today': return today(now);
    case '@weekStart': return day(-mondayOffset);
    case '@weekEnd': return day(6 - mondayOffset);
    case '@monthStart': return today(new Date(now.getFullYear(), now.getMonth(), 1));
    case '@monthEnd': return today(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }
  throw new FilterError(`unknown variable ${name} (@now @today @me @weekStart @weekEnd @monthStart @monthEnd)`, pos);
}

const SYSTEM: Record<string, { type: FieldType; get: (r: Rec) => unknown }> = {
  id: { type: 'text', get: (r) => r.id }, created: { type: 'datetime', get: (r) => r.created }, updated: { type: 'datetime', get: (r) => r.updated },
  createdBy: { type: 'text', get: (r) => r.createdBy }, updatedBy: { type: 'text', get: (r) => r.updatedBy },
};
interface Resolved { type: FieldType; multiple: boolean; get: (r: Rec) => unknown }

function resolve(path: string[], ctx: FilterCtx, pos: number): Resolved {
  const find = (fields: Field[], name: string) => fields.find((f) => f.name === name);
  const own = (fields: Field[], name: string, relGet?: (r: Rec) => Rec | undefined): { type: FieldType; multiple: boolean; get: (r: Rec) => unknown } | undefined => {
    const sys = Object.hasOwn(SYSTEM, name) ? SYSTEM[name]! : undefined, f = find(fields, name);
    const base = f ? { type: f.type, multiple: !!f.multiple, get: (r: Rec) => r.data[f.name] } : sys && { type: sys.type, multiple: false, get: sys.get };
    return base && (relGet ? { ...base, get: (r: Rec) => { const x = relGet(r); return x ? base.get(x) : null; } } : base);
  };
  if (path.length === 1) {
    const r = own(ctx.fields, path[0]!);
    if (!r) throw new FilterError(`unknown field "${path[0]}"`, pos);
    return r;
  }
  if (path.length > 2) throw new FilterError('only one relation level can be followed (field.field)', pos);
  const rf = find(ctx.fields, path[0]!);
  if (!rf || rf.type !== 'relation') throw new FilterError(`"${path[0]}" is not a relation field`, pos);
  const rel = ctx.related(rf);
  const leaf = own(rel.fields, path[1]!);
  if (!leaf) throw new FilterError(`unknown field "${path[1]}" on ${path[0]}`, pos);
  const ids = (r: Rec) => [r.data[rf.name]].flat().filter((x): x is string => typeof x === 'string');
  const through = (r: Rec) => ids(r).map((id) => rel.get(id)).filter((x): x is Rec => !!x).map((x) => leaf.get(x));
  return { type: leaf.type, multiple: rf.multiple || leaf.multiple, get: (r) => (rf.multiple ? through(r).flat() : through(r)[0] ?? null) };
}

const ORDERED: FieldType[] = ['number', 'duration', 'date', 'datetime', 'text', 'longtext', 'email', 'url'];
const TEXTY: FieldType[] = ['text', 'longtext', 'email', 'url', 'select', 'relation', 'date', 'datetime', 'json'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function leafTest(type: FieldType, op: string, lit: Lit, ctx: FilterCtx, pos: number): (x: unknown) => boolean {
  if (lit.k === 'null') {
    if (op !== '=' && op !== '!=') throw new FilterError('null can only be compared with = or !=', pos);
    return (x) => emptyValue(x) === (op === '=');
  }
  if ((op === '~' || op === '!~') && !TEXTY.includes(type)) throw new FilterError(`~ is for text, not ${type}`, pos);
  if (['>', '>=', '<', '<='].includes(op) && !ORDERED.includes(type)) throw new FilterError(`${op} is not available for ${type} fields`, pos);
  const raw = lit.k === 'var' ? variable(lit.v as string, ctx, pos) : lit.v;
  let L: string | number | boolean;
  if (type === 'number' || type === 'duration') {
    L = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isNaN(L)) throw new FilterError(`${type} fields compare with a number`, pos);
  } else if (type === 'bool') {
    L = typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : (undefined as never);
    if (L === undefined) throw new FilterError('bool fields compare with true or false', pos);
  } else if (type === 'date' || type === 'datetime') {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw)) throw new FilterError(`${type} fields compare with a date like "2026-10-22" (or @today, @now)`, pos);
    L = type === 'date' && op !== '~' && op !== '!~' ? raw.slice(0, 10) : raw;
  } else L = String(raw);
  const s = typeof L === 'string' ? L.toLowerCase() : '';
  // a day compared with a date-time: = matches the whole day, <= and > mean "until the end of that day"
  const dayOfTime = type === 'datetime' && typeof L === 'string' && DATE_ONLY.test(L);
  const end = dayOfTime ? `${L}T23:59:59.999Z` : L;
  switch (op) {
    case '=': return (x) => (dayOfTime && typeof x === 'string' ? x.startsWith(L as string) : x === L);
    case '!=': return (x) => !(dayOfTime && typeof x === 'string' ? x.startsWith(L as string) : x === L);
    case '~': return (x) => !emptyValue(x) && (typeof x === 'string' ? x : JSON.stringify(x)).toLowerCase().includes(s);
    case '!~': return (x) => emptyValue(x) || !(typeof x === 'string' ? x : JSON.stringify(x)).toLowerCase().includes(s);
    case '>': return (x) => !emptyValue(x) && (x as any) > (end as any);
    case '>=': return (x) => !emptyValue(x) && (x as any) >= (L as any);
    case '<': return (x) => !emptyValue(x) && (x as any) < (L as any);
    default: return (x) => !emptyValue(x) && (x as any) <= (end as any); // <=
  }
}

export type Predicate = (r: Rec) => boolean;

export function compileFilter(src: string, ctx: FilterCtx): Predicate {
  const compile = (n: Node): Predicate => {
    if (n.t === 'and') { const a = compile(n.a), b = compile(n.b); return (r) => a(r) && b(r); }
    if (n.t === 'or') { const a = compile(n.a), b = compile(n.b); return (r) => a(r) || b(r); }
    const { type, multiple, get } = resolve(n.path, ctx, n.pos);
    const test = leafTest(type, n.op, n.lit, ctx, n.pos);
    if (!multiple) return (r) => test(get(r));
    if (n.lit.k === 'null') return (r) => test(get(r)); // [] and null are both empty
    if (!['=', '!=', '~', '!~'].includes(n.op)) throw new FilterError(`${n.op} is not available for fields with several values`, n.pos);
    const positive = n.op === '=' || n.op === '~', one = leafTest(type, n.op === '!=' ? '=' : n.op === '!~' ? '~' : n.op, n.lit, ctx, n.pos);
    return (r) => { const a = [get(r)].flat().filter((x) => !emptyValue(x)); return positive ? a.some(one) : !a.some(one); };
  };
  return compile(parseFilter(src));
}

/** Case-insensitive "contains" over the text-like fields: the search box. */
export function compileSearch(q: string, fields: Field[]): Predicate {
  const s = q.toLowerCase(), names = fields.filter((f) => ['text', 'longtext', 'email', 'url', 'select'].includes(f.type)).map((f) => f.name);
  return (r) => names.some((n) => [r.data[n]].flat().some((x) => typeof x === 'string' && x.toLowerCase().includes(s)));
}

/** `-due,title`: a leading minus sorts descending. Empty values come last either way; ties fall back to creation order. */
export function compileSort(spec: string, fields: Field[]): (a: Rec, b: Rec) => number {
  const keys = spec.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length > 5) throw new DataError(400, 'sort: at most 5 keys');
  const cols = keys.map((k) => {
    const desc = k.startsWith('-'), name = desc || k.startsWith('+') ? k.slice(1) : k;
    const f = fields.find((x) => x.name === name), sys = Object.hasOwn(SYSTEM, name) ? SYSTEM[name]! : undefined;
    if (!f && !sys) throw new DataError(400, `sort: unknown field "${name}"`);
    return { desc, get: f ? (r: Rec) => r.data[f.name] : sys!.get };
  });
  const rank = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : typeof x === 'object' ? JSON.stringify(x) : x) as string | number | boolean;
  return (a, b) => {
    for (const c of cols) {
      const x = c.get(a), y = c.get(b), ex = emptyValue(x), ey = emptyValue(y);
      if (ex || ey) { if (ex && ey) continue; return ex ? 1 : -1; }
      const p = rank(x), q = rank(y);
      if (p !== q) return (p < q ? -1 : 1) * (c.desc ? -1 : 1);
    }
    return a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1;
  };
}
