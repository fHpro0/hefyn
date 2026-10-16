import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RedactError, span } from './spans.ts';
import type { Span } from './spans.ts';
import { rx } from './rules.ts';

// Port of warden-redact gliner_detector.rs + the parts of gline-rs it uses: token mode (gliner-pii-small), word splitting,
// prompt/label encoding, logits decoding (start/end/inside scores), greedy flat NER. Runs inside the worker thread
// (gliner-worker.ts); only this file touches onnxruntime-node and the tokenizer.

export const LABELS = ['person', 'name', 'email', 'phone number', 'address', 'credit card number'];
const THRESHOLD = 0.5;
const MAX_CHUNK_CHARS = 1500;
/** gline-rs silently drops words beyond max_length (512), so chunks stay below it to guarantee full coverage. */
const MAX_WORDS_PER_CHUNK = 384;
const MAX_LENGTH = 512;
const BATCH = 8;

const WORD = rx(String.raw`\w+(?:[-_]\w+)*|\S`, 'g'); // gline-rs' default splitter
const words = (s: string, limit?: number) => {
  const out: { start: number; end: number; text: string }[] = [];
  for (const m of s.matchAll(WORD)) { out.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] }); if (limit !== undefined && out.length >= limit) break; }
  return out;
};
const countWords = (s: string) => { let n = 0; for (const _ of s.matchAll(WORD)) n++; return n; };
const chars = (s: string) => { let n = 0; for (const _ of s) n++; return n; }; // code points, like Rust's chars().count()

interface Atom { start: number; end: number; chars: number; words: number }

/** Splits one over-long line into word-aligned pieces within the limits. */
function splitLong(line: string, base: number, maxChars: number, maxWords: number, out: Atom[]) {
  let pieceStart = 0, c = 0, w = 0, lastEnd = 0;
  for (const m of line.matchAll(WORD)) {
    const ws = m.index!, we = ws + m[0].length;
    const gap = chars(line.slice(lastEnd, we));
    if (w > 0 && (w + 1 > maxWords || c + gap > maxChars)) {
      out.push({ start: base + pieceStart, end: base + ws, chars: chars(line.slice(pieceStart, ws)), words: w });
      pieceStart = ws; c = 0; w = 0; lastEnd = ws;
    }
    c += chars(line.slice(lastEnd, we)); w++; lastEnd = we;
  }
  out.push({ start: base + pieceStart, end: base + line.length, chars: chars(line.slice(pieceStart)), words: w });
}

/** Splits text into contiguous chunks on line boundaries, each within max chars/words; over-long lines split at word boundaries. */
export function chunkRanges(text: string, maxChars = MAX_CHUNK_CHARS, maxWords = MAX_WORDS_PER_CHUNK): [number, number][] {
  const atoms: Atom[] = [];
  let pos = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) { // split_inclusive('\n')
    const c = chars(line), w = countWords(line);
    if (c <= maxChars && w <= maxWords) atoms.push({ start: pos, end: pos + line.length, chars: c, words: w });
    else splitLong(line, pos, maxChars, maxWords, atoms);
    pos += line.length;
  }
  const chunks: [number, number][] = [];
  let cur: [number, number, number, number] | undefined; // start, end, chars, words
  for (const a of atoms) {
    if (cur && (cur[2] + a.chars > maxChars || cur[3] + a.words > maxWords)) { chunks.push([cur[0], cur[1]]); cur = [a.start, a.end, a.chars, a.words]; }
    else cur = cur ? [cur[0], a.end, cur[2] + a.chars, cur[3] + a.words] : [a.start, a.end, a.chars, a.words];
  }
  if (cur) chunks.push([cur[0], cur[1]]);
  return chunks;
}

// ---- decoding ----
const f = Math.fround;
const sigmoid = (x: number) => f(1 / f(1 + f(Math.exp(-x)))); // f32 arithmetic like gline-rs

interface Ent { start: number; end: number; label: string; p: number }

/** Greedy flat NER (gline-rs greedy.rs, flat_ner=true): spans sorted by (start, end); overlap (touching counts) keeps the more probable one. */
export function greedy(spans: Ent[]): Ent[] {
  if (!spans.length) return [];
  const overlaps = (a: Ent, b: Ent) => !(b.start > a.end || b.end < a.start);
  const out: Ent[] = [];
  let prev = 0;
  for (let next = 1; next < spans.length; next++) {
    if (!overlaps(spans[prev], spans[next])) { out.push(spans[prev]); prev = next; }
    else if (spans[prev].p < spans[next].p) prev = next;
  }
  out.push(spans[prev]);
  return out;
}

interface Word { start: number; end: number; text: string }

/** Token-mode decoding of one sequence: scores(k, word, class) with k = 0 start, 1 end, 2 inside. */
export function decodeSequence(score: (k: number, w: number, c: number) => number, numWords: number, classes: number, toks: Word[], thr: number): Ent[] {
  const out: Ent[] = [];
  for (let c = 0; c < classes; c++) {
    for (let s = 0; s < numWords; s++) {
      if (sigmoid(score(0, s, c)) < thr) continue;
      for (let e = s; e < numWords; e++) {
        if (sigmoid(score(1, e, c)) < thr) continue;
        let sum = 0, ok = true;
        for (let i = s; i <= e; i++) { const v = sigmoid(score(2, i, c)); if (v < thr) { ok = false; break; } sum = f(sum + v); }
        if (!ok) continue; // a span with an inside score below the threshold scores 0
        const p = f(sum / f(e - s + 1));
        if (p < thr) continue;
        const a = toks[s], b = toks[e];
        if (!a || !b) throw new RedactError('gliner: span outside the sequence'); // gline-rs: IndexError, fail closed
        out.push({ start: a.start, end: b.end, label: LABELS[c], p });
      }
    }
  }
  return greedy(out.sort((x, y) => x.start - y.start || x.end - y.end));
}

// ---- model ----
const ONNX = ['onnx/model.onnx', 'onnx/model_quint8.onnx', 'model_quint8.onnx', 'model.onnx'];

export class GlinerModel {
  private cache = new Map<string, number[]>();
  private session: any; private ort: any; private tok: any; private bounds: [number, number];
  private constructor(session: any, ort: any, tok: any, bounds: [number, number]) { this.session = session; this.ort = ort; this.tok = tok; this.bounds = bounds; }

  static async load(dir: string): Promise<GlinerModel> {
    const tokPath = join(dir, 'tokenizer.json');
    if (!existsSync(tokPath)) throw new RedactError(`detector \`gliner\` failed: missing ${tokPath}`);
    const onnx = ONNX.map((p) => join(dir, p)).find((p) => existsSync(p));
    if (!onnx) throw new RedactError(`detector \`gliner\` failed: no ONNX model under ${dir}`);
    const [{ Tokenizer }, ort] = await Promise.all([import('@huggingface/tokenizers'), import('onnxruntime-node')]);
    const tok = new Tokenizer(JSON.parse(readFileSync(tokPath, 'utf8')), {});
    const session = await ort.InferenceSession.create(onnx, { intraOpNumThreads: 4, graphOptimizationLevel: 'all', executionProviders: ['cpu'] }); // the Rust engine's (orp) defaults
    return new GlinerModel(session, ort, tok, [tok.token_to_id('[CLS]') ?? 1, tok.token_to_id('[SEP]') ?? 2]);
  }

  private encode(word: string): number[] {
    let ids = this.cache.get(word);
    if (!ids) { ids = this.tok.encode(word, { add_special_tokens: false }).ids as number[]; if (this.cache.size > 20_000) this.cache.clear(); this.cache.set(word, ids); }
    return ids;
  }

  /** One inference batch: entities per chunk, offsets relative to the chunk. */
  private async infer(chunks: string[]): Promise<Ent[][]> {
    const toks = chunks.map((c) => words(c, MAX_LENGTH));
    const ents = LABELS.flatMap((l) => ['<<ENT>>', l]).concat('<<SEP>>');
    const entEnc = ents.map((w) => this.encode(w));
    const entTokens = entEnc.reduce((n, e) => n + e.length, 0);
    const textOffset = entTokens + 1;
    const enc = toks.map((t) => entEnc.concat(t.map((w) => this.encode(w.text))));
    const T = Math.max(...enc.map((e) => 2 + e.reduce((n, x) => n + x.length, 0)));
    const B = chunks.length, numWords = Math.max(...toks.map((t) => t.length));
    const ids = new BigInt64Array(B * T), attn = new BigInt64Array(B * T), wmask = new BigInt64Array(B * T), lens = new BigInt64Array(B);
    enc.forEach((prompt, b) => {
      const row = b * T;
      let idx = 0, wordId = 0;
      ids[row] = BigInt(this.bounds[0]); attn[row] = 1n; idx++;
      for (const w of prompt) {
        w.forEach((t, ti) => {
          ids[row + idx] = BigInt(t); attn[row + idx] = 1n;
          if (idx >= textOffset && ti === 0) wmask[row + idx] = BigInt(wordId);
          idx++;
        });
        if (idx >= textOffset) wordId++; // quirk kept: the id grows right after <<SEP>>, so text words are numbered from 1
      }
      ids[row + idx] = BigInt(this.bounds[1]); attn[row + idx] = 1n;
      lens[b] = BigInt(toks[b].length);
    });
    const { Tensor } = this.ort;
    const out = await this.session.run({
      input_ids: new Tensor('int64', ids, [B, T]), attention_mask: new Tensor('int64', attn, [B, T]),
      words_mask: new Tensor('int64', wmask, [B, T]), text_lengths: new Tensor('int64', lens, [B, 1]),
    });
    const logits = out.logits;
    if (!logits) throw new RedactError('detector `gliner` failed: logits not found in model output');
    const C = LABELS.length, dims = Array.from(logits.dims as ArrayLike<number>), d = logits.data as Float32Array;
    let at: (k: number, b: number, w: number, c: number) => number;
    if (dims.length === 4 && dims[0] === 3 && dims[1] === B && dims[2] === numWords && dims[3] === C) at = (k, b, w, c) => d[((k * B + b) * numWords + w) * C + c];
    else if (dims.length === 4 && dims[0] === B && dims[1] === numWords && dims[2] === C && dims[3] === 3) at = (k, b, w, c) => d[((b * numWords + w) * C + c) * 3 + k];
    else throw new RedactError('detector `gliner` failed: unexpected logits shape');
    return toks.map((t, b) => decodeSequence((k, w, c) => at(k, b, w, c), numWords, C, t, THRESHOLD));
  }

  async detect(text: string): Promise<Span[]> {
    // A chunk without words (whitespace only) cannot hold an entity; the Rust engine errored on it (zero-word ONNX input), blocking the whole request.
    const ranges = chunkRanges(text).filter(([a, b]) => words(text.slice(a, b), 1).length);
    const out: Span[] = [];
    for (let i = 0; i < ranges.length; i += BATCH) {
      const batch = ranges.slice(i, i + BATCH);
      const results = await this.infer(batch.map(([a, b]) => text.slice(a, b)));
      if (results.length !== batch.length) throw new RedactError('detector `gliner` failed: model returned wrong number of sequences');
      batch.forEach(([base, end], j) => {
        for (const e of results[j]) {
          const s = base + e.start, t = base + e.end;
          if (t > end || s >= t) throw new RedactError(`detector \`gliner\` failed: span ${e.start}..${e.end} outside chunk`);
          out.push(span(s, t, e.label, 'gliner', e.p));
        }
      });
    }
    return out;
  }
}
