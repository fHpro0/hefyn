import { span } from './spans.ts';
import type { Span } from './spans.ts';

// Port of warden-redact entropy.rs: flags long, high-entropy tokens that look like keys (unknown key formats).
// Candidates are maximal runs of [A-Za-z0-9+/_-] (plus up to two trailing `=`) of at least minLen chars; hex strings,
// UUIDs and path-like strings are skipped. Effective threshold: min(minBits, log2(len) - 0.4). Tokens are ASCII only.

export const shannon = (tok: string): number => {
  const counts = new Array<number>(256).fill(0);
  for (let i = 0; i < tok.length; i++) counts[tok.charCodeAt(i)]++;
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / tok.length; h += -p * Math.log2(p); }
  return h;
};

const isTokenCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 95 || c === 45;

function looksLikePath(tok: string): boolean {
  if (!tok.includes('/')) return false;
  const letters = (tok.match(/[A-Za-z]/g) ?? []).length, upper = (tok.match(/[A-Z]/g) ?? []).length, digits = (tok.match(/[0-9]/g) ?? []).length;
  const lowercasePath = letters > 0 && upper * 5 < letters && digits * 7 < tok.length; // paths are mostly lowercase words; base64 is ~40% uppercase
  const segs = tok.split('/'), slashes = segs.length - 1;
  const wordy = segs.filter((s) => !/[0-9]/.test(s)).reduce((n, s) => n + s.length, 0);
  const segmentPath = (slashes >= 2 || tok[0] === '/') && wordy * 2 >= tok.length - slashes;
  return lowercasePath || segmentPath;
}

export class EntropyDetector {
  readonly name = 'entropy';
  private minLen: number;
  private minBits: number;
  constructor(minLen = 20, minBits = 4.0) { this.minLen = minLen; this.minBits = minBits; }

  private secretLike(tok: string): number | undefined {
    if (/^[0-9a-fA-F-]*$/.test(tok)) return undefined; // hex digests, git SHAs, UUIDs
    const classes = Number(/[a-z]/.test(tok)) + Number(/[A-Z]/.test(tok)) + Number(/[0-9]/.test(tok)) + Number(/[+/_=-]/.test(tok));
    if (classes < 3 || looksLikePath(tok)) return undefined;
    const h = shannon(tok);
    return h >= Math.min(this.minBits, Math.log2(tok.length) - 0.4) ? h : undefined;
  }

  detect(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;
    while (i < text.length) {
      if (!isTokenCode(text.charCodeAt(i))) { i++; continue; }
      const start = i;
      while (i < text.length && isTokenCode(text.charCodeAt(i))) i++;
      let end = i, pad = 0;
      while (pad < 2 && end < text.length && text[end] === '=') { end++; pad++; }
      if (end - start >= this.minLen) {
        const h = this.secretLike(text.slice(start, end));
        if (h !== undefined) out.push(span(start, end, 'high_entropy_token', 'entropy', Math.min(h / 6, 1)));
      }
      i = end;
    }
    return out;
  }
}
