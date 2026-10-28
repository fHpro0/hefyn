import { DataError, emptyValue, type Field } from './data-schema.ts';

// CSV for data collections (RFC 4180 subset). Cells that a spreadsheet would run as a formula get a leading apostrophe on export
// (text-like fields only; numbers keep their sign) and lose it on import.

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 20_000;

export function parseCsv(text: string): string[][] {
  if (text.length > MAX_CSV_BYTES) throw new DataError(413, 'The CSV is larger than 5 MB.');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, i = text.charCodeAt(0) === 0xfeff ? 1 : 0, any = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') { quoted = true; any = true; }
    else if (c === ',') { row.push(cell); cell = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cell !== '') { row.push(cell); rows.push(row); }
      row = []; cell = ''; any = false;
      if (rows.length > MAX_CSV_ROWS + 1) throw new DataError(413, `At most ${MAX_CSV_ROWS} rows per import.`);
    } else { cell += c; any = true; }
  }
  if (quoted) throw new DataError(400, 'The CSV has an unterminated quote.');
  if (any || cell !== '') { row.push(cell); rows.push(row); }
  return rows;
}

const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';

const TEXTUAL = ['text', 'longtext', 'email', 'url', 'select'];
const FORMULA = /^[=+\-@\t\r]/;

/** One value as a CSV cell. Lists join with `|`, json is JSON, duration is minutes. */
export function cellOf(f: Field, x: unknown): string {
  if (emptyValue(x)) return '';
  const one = (y: unknown) => (typeof y === 'string' ? y : typeof y === 'object' ? JSON.stringify(y) : String(y));
  const s = Array.isArray(x) ? x.map(one).join('|') : one(x);
  return TEXTUAL.includes(f.type) && FORMULA.test(s) ? `'${s}` : s;
}

/** A cell back to a value for `f` (not yet validated; the caller runs normalizeValues). Throws on shapes it cannot read. */
export function valueOfCell(f: Field, raw: string): unknown {
  let s = raw.trim();
  if (TEXTUAL.includes(f.type) && /^'[=+\-@\t\r]/.test(raw)) s = raw.slice(1);
  else if (f.type === 'text' || f.type === 'longtext') s = raw; // keep the spaces the user typed
  if (s === '') return null;
  const many = (t: string) => t.split('|').map((p) => p.trim()).filter(Boolean);
  switch (f.type) {
    case 'number': return Number(s.replace(',', '.')); // NaN fails validation
    case 'bool': { const l = s.toLowerCase(); if (['true', '1', 'yes', 'ja'].includes(l)) return true; if (['false', '0', 'no', 'nein'].includes(l)) return false; throw new Error('expected true or false'); }
    case 'duration': { const m = /^(\d+):([0-5]\d)$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : Number(s); }
    case 'json': try { return JSON.parse(s); } catch { throw new Error('not valid JSON'); }
    case 'select': case 'relation': return f.multiple ? many(s) : s;
    default: return s;
  }
}
