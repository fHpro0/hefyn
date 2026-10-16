// Port of warden-redact span.rs. Offsets are UTF-16 code units (the Rust crate used UTF-8 bytes); order and overlap
// logic are identical, only the length tie-break below is measured in UTF-8 bytes to stay faithful.

export interface Span { start: number; end: number; label: string; detector: string; score: number }
export const span = (start: number, end: number, label: string, detector: string, score: number): Span => ({ start, end, label, detector, score });

export class RedactError extends Error {}

/** Labelling priority: exact/known-secret and regex detectors beat entropy beats everything else (model based). */
const priority = (detector: string) => (detector === 'regex' || detector === 'vault' || detector === 'variable' ? 3 : detector === 'entropy' ? 2 : 1);

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff, isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
/** A boundary may not fall between the two halves of a surrogate pair. */
const boundary = (t: string, i: number) => i === 0 || i === t.length || !(isLow(t.charCodeAt(i)) && isHigh(t.charCodeAt(i - 1)));

/** Validates spans against the text (fail closed on nonsense offsets). */
export function validate(text: string, spans: Span[]) {
  for (const s of spans) {
    const ok = Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.start < s.end && s.end <= text.length && boundary(text, s.start) && boundary(text, s.end);
    if (!ok) throw new RedactError(`detector \`${s.detector}\` returned invalid span ${s.start}..${s.end}`);
  }
}

/** Removes the given (sorted, disjoint) holes from every span, splitting spans as needed. */
export function subtract(spans: Span[], holes: [number, number][]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    let cur = s.start;
    for (const [hs, he] of holes) {
      if (he <= cur) continue;
      if (hs >= s.end) break;
      if (hs > cur) out.push({ ...s, start: cur, end: hs });
      cur = Math.max(cur, he);
    }
    if (cur < s.end) out.push({ ...s, start: cur });
  }
  return out;
}

/** Unions overlapping spans. The label/detector of a merged group comes from the highest-priority span, ties broken by length, then input order. */
export function merge(spans: Span[], text: string): Span[] {
  const sorted = spans.map((s) => ({ ...s })).sort((a, b) => a.start - b.start || b.end - a.end); // stable, like Rust's sort_by
  const out: Span[] = [];
  let best: [number, number] = [0, 0];
  const bytes = (s: Span) => Buffer.byteLength(text.slice(s.start, s.end));
  for (const s of sorted) {
    const key: [number, number] = [priority(s.detector), bytes(s)];
    const cur = out.at(-1);
    if (cur && s.start < cur.end) {
      cur.end = Math.max(cur.end, s.end);
      cur.score = Math.max(cur.score, s.score);
      if (key[0] > best[0] || (key[0] === best[0] && key[1] > best[1])) { best = key; cur.label = s.label; cur.detector = s.detector; }
    } else { best = key; out.push(s); }
  }
  return out;
}

/** Marker tag: uppercase, non-alphanumerics become `_`. */
export const tag = (label: string) => { const t = Array.from(label, (c) => (/^[A-Za-z0-9]$/.test(c) ? c.toUpperCase() : '_')).join(''); return t || 'SECRET'; };
