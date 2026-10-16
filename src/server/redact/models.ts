import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Port of warden-redact gliner_download.rs: the pinned GLiNER files, verified by size and SHA-256. web downloads (it has
// internet; the agent has none), the agent only reads and verifies.

export const GLINER_REPO = 'knowledgator/gliner-pii-small-v1.0';
export interface ModelFile { path: string; size: number; sha256: string }
/** Pinned from the repo's main branch (quantized ONNX export, token mode). */
export const GLINER_FILES: ModelFile[] = [
  { path: 'tokenizer.json', size: 3_583_593, sha256: '84b3a9b18f04a0ccd03b72d9f871b7e0bec40fd7021ef50bc30a7c3693c11205' },
  { path: 'onnx/model_quint8.onnx', size: 82_680_500, sha256: '891589426ee96f2748b16439f44fad8c3f97e198e002a6637e58dee989500216' },
];
export const defaultBaseUrl = () => `https://huggingface.co/${GLINER_REPO}/resolve/main`;

/** Where hefyn gets the model: `huggingface` (web downloads), `mirror` (web downloads from HEFYN_GLINER_BASE_URL), `image` (baked into the
 *  image at build time), `local` (files placed by the admin, or uploaded in the UI). Only the first two ever make a network request. */
export type Source = 'huggingface' | 'mirror' | 'image' | 'local';
export const SOURCES: Source[] = ['huggingface', 'mirror', 'image', 'local'];
export const sourceOf = (): Source => {
  const v = (process.env.HEFYN_GLINER_SOURCE || (existsSync('/opt/hefyn/BAKED') ? 'image' : 'huggingface')).toLowerCase(); // BAKED: image built with HEFYN_GLINER_BAKE=1
  if (!SOURCES.includes(v as Source)) throw new Error(`HEFYN_GLINER_SOURCE must be one of ${SOURCES.join(', ')} (got "${v}")`);
  return v as Source;
};
export const BAKED_DIR = '/opt/hefyn/models/gliner';
/** HEFYN_REDACT_MODEL_DIR overrides everything (tests); else image -> the baked dir, local -> HEFYN_GLINER_DIR, others -> the data volume. */
export const modelDir = () => {
  if (process.env.HEFYN_REDACT_MODEL_DIR) return process.env.HEFYN_REDACT_MODEL_DIR;
  const dflt = join(process.env.HEFYN_DATA_DIR ?? 'data', 'models', 'gliner');
  let s: Source = 'huggingface';
  try { s = sourceOf(); } catch { /* reported by the status */ }
  return s === 'image' ? process.env.HEFYN_GLINER_DIR || BAKED_DIR : s === 'local' ? process.env.HEFYN_GLINER_DIR || dflt : dflt;
};
/** The mirror base URL: https only. Throws with a clear message otherwise. */
export function mirrorBase(): URL {
  const raw = process.env.HEFYN_GLINER_BASE_URL;
  if (!raw) throw new Error('HEFYN_GLINER_SOURCE=mirror needs HEFYN_GLINER_BASE_URL');
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('HEFYN_GLINER_BASE_URL is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('HEFYN_GLINER_BASE_URL must be https');
  return u;
}
/** The base URL files are fetched from for the given source (never for image/local). */
export const baseUrlFor = (s: Source) => (s === 'mirror' ? mirrorBase().toString().replace(/\/$/, '') : defaultBaseUrl());

/** fetch that follows redirects by hand and only within the same host (and https): a mirror may not bounce us to a third party. */
export const sameHostFetch = (origin: URL): typeof fetch => async (input, init) => {
  let url = new URL(String(input));
  for (let hops = 0; hops < 5; hops++) {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    const next = new URL(loc, url);
    if (next.protocol !== 'https:' || next.host !== origin.host) throw new Error(`the mirror redirected to another host (${next.host}); refused`);
    url = next;
  }
  throw new Error('too many redirects');
};

const hashFile = async (path: string) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
};

export type Verdict = { ok: true } | { ok: false; missing: boolean; error: string };
/** Size and SHA-256 of every pinned file. `missing` = nothing wrong yet, the download just has not finished. */
export async function verifyModel(dir = modelDir(), files = GLINER_FILES): Promise<Verdict> {
  for (const f of files) {
    const p = join(dir, f.path);
    let size: number;
    try { size = statSync(p).size; } catch { return { ok: false, missing: true, error: `${f.path} is not downloaded yet` }; }
    if (size !== f.size) return { ok: false, missing: false, error: `${f.path} has the wrong size (${size}, expected ${f.size})` };
    if ((await hashFile(p)) !== f.sha256) return { ok: false, missing: false, error: `${f.path} fails its SHA-256 check` };
  }
  return { ok: true };
}

/** Fetches every missing or invalid file into `<file>.partial`, verifies it, then renames it into place (atomic). Resolves when the model is complete. */
export async function downloadModel(opts: { dir?: string; baseUrl?: string; files?: ModelFile[]; onProgress?: (msg: string) => void; fetchImpl?: typeof fetch } = {}) {
  const dir = opts.dir ?? modelDir(), base = (opts.baseUrl ?? defaultBaseUrl()).replace(/\/$/, ''), files = opts.files ?? GLINER_FILES;
  for (const f of files) {
    const dest = join(dir, f.path);
    if ((await verifyModel(dir, [f])).ok) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const part = `${dest}.partial`;
    opts.onProgress?.(`downloading ${f.path}`);
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}/${f.path}`, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok || !res.body) throw new Error(`model server answered HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
      if (statSync(part).size !== f.size || (await hashFile(part)) !== f.sha256) throw new Error(`downloaded file ${f.path} is corrupt (size or checksum mismatch)`);
      renameSync(part, dest);
    } catch (e) { rmSync(part, { force: true }); throw e; }
  }
}
