import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
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
export const modelDir = () => process.env.HEFYN_REDACT_MODEL_DIR || join(process.env.HEFYN_DATA_DIR ?? 'data', 'models', 'gliner');

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
  const dir = opts.dir ?? modelDir(), base = (opts.baseUrl ?? process.env.HEFYN_REDACT_MODEL_URL ?? defaultBaseUrl()).replace(/\/$/, ''), files = opts.files ?? GLINER_FILES;
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
