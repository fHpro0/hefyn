import { merge, subtract, tag, validate } from './spans.ts';
import type { Span } from './spans.ts';

// Port of warden-redact redactor.rs. Fail closed: a detector error rejects, never partially redacted text.

export interface Detector { readonly name: string; detect(text: string): Span[] | Promise<Span[]> }

/** Markers produced earlier (`[REDACTED:..]`, `{{var:..}}`, `{{secret:..}}`), never re-redacted: redaction is idempotent. */
const MARKER = /\[REDACTED:[A-Z0-9_]+(?:#[0-9a-z]+)?\]|\{\{(?:var|secret):[A-Z][A-Z0-9_]{0,63}\}\}/g;

export interface Redacted {
  text: string;
  /** Merged findings, in coordinates of the original text. */
  spans: Span[];
  /** Findings per label. */
  counts: Map<string, number>;
  /** Length of what replaced each span (parallel to `spans`). */
  renderedLens: number[];
}

export type Render = (span: Span, original: string) => string | undefined;

export class Redactor {
  readonly detectors: Detector[];
  constructor(detectors: Detector[]) { this.detectors = detectors; }

  redact(text: string) { return this.redactRender(text, () => undefined); }

  /** `decorate` may return a short id (`[0-9a-z]+`, else ignored) making the marker `[REDACTED:<LABEL>#<id>]`. */
  redactWith(text: string, decorate: Render) {
    return this.redactRender(text, (s, o) => { const id = decorate(s, o); return id && /^[0-9a-z]+$/.test(id) ? `[REDACTED:${tag(s.label)}#${id}]` : undefined; });
  }

  /** `render` returns the complete replacement for a merged span (e.g. a `{{var:NAME}}` placeholder); undefined keeps `[REDACTED:<LABEL>]`. */
  async redactRender(text: string, render: Render): Promise<Redacted> {
    let all: Span[] = [];
    for (const d of this.detectors) {
      const spans = await d.detect(text);
      validate(text, spans);
      all = all.concat(spans);
    }
    const holes = [...text.matchAll(MARKER)].map((m): [number, number] => [m.index!, m.index! + m[0].length]);
    const spans = merge(holes.length ? subtract(all, holes) : all, text);
    let out = '', pos = 0;
    const counts = new Map<string, number>(), renderedLens: number[] = [];
    for (const s of spans) {
      out += text.slice(pos, s.start);
      const r = render(s, text.slice(s.start, s.end)) ?? `[REDACTED:${tag(s.label)}]`;
      out += r;
      renderedLens.push(r.length);
      pos = s.end;
      counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
    }
    return { text: out + text.slice(pos), spans, counts, renderedLens };
  }
}
