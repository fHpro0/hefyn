import { writeNotice } from './notice.ts';
import { baseUrlFor, downloadModel, mirrorBase, modelDir, sameHostFetch, sourceOf, verifyModel } from './models.ts';
import type { Source } from './models.ts';

// web side of the GLiNER model: download for `huggingface` / `mirror`, nothing at all for `image` / `local` (no network request is
// made); and the status shown in the UI. The redact service only reads and verifies the files (no internet there).
const glinerOff = () => (process.env.HEFYN_REDACT_GLINER ?? 'on').toLowerCase() === 'off';

let dl: { state: 'idle' | 'downloading' | 'error'; detail?: string } = { state: 'idle' };

export async function ensureModelFiles(log: (msg: string) => void = console.log, retryMs = 30_000) {
  if (glinerOff()) return;
  let source: Source;
  try { source = sourceOf(); if (source === 'mirror') mirrorBase(); } catch (e) { dl = { state: 'error', detail: (e as Error).message }; log(`GLiNER model: ${(e as Error).message}`); return; }
  if (source === 'image' || source === 'local') { log(`GLiNER model source is "${source}": no download (files are read from ${modelDir()})`); return; }
  const fetchImpl = source === 'mirror' ? sameHostFetch(mirrorBase()) : undefined;
  for (;;) {
    dl = { state: 'downloading' };
    try { await downloadModel({ baseUrl: baseUrlFor(source), fetchImpl, onProgress: log }); try { writeNotice(modelDir()); } catch { /* best effort */ } dl = { state: 'idle' }; invalidateGlinerInfo(); log('GLiNER model files are in place'); return; }
    catch (e) { dl = { state: 'error', detail: (e as Error).message }; log(`GLiNER model download failed, retrying: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, retryMs).unref()); }
  }
}

export interface GlinerInfo { source: Source; state: 'ready' | 'missing' | 'downloading' | 'invalid' | 'error'; detail?: string; host?: string }
let cache: { at: number; v: GlinerInfo } | undefined;
export const invalidateGlinerInfo = () => { cache = undefined; };

/** What the UI shows. Hashing 86 MB is cached for 30 s (and dropped after an upload or a finished download). Never throws. */
export async function glinerInfo(): Promise<GlinerInfo> {
  if (cache && Date.now() - cache.at < 30_000) return cache.v;
  let source: Source = 'huggingface', host: string | undefined;
  try { source = sourceOf(); if (source === 'mirror') host = mirrorBase().host; } catch (e) { return { source, state: 'error', detail: (e as Error).message }; }
  if (glinerOff()) return { source, state: 'missing', detail: 'GLiNER is switched off (HEFYN_REDACT_GLINER=off)', host };
  const v = await verifyModel(modelDir());
  let info: GlinerInfo;
  if (v.ok) info = { source, state: 'ready', host };
  else if (!v.missing) info = { source, state: 'invalid', detail: v.error, host };
  else if (source === 'huggingface' || source === 'mirror') info = dl.state === 'error' ? { source, state: 'error', detail: dl.detail, host } : { source, state: 'downloading', host };
  else info = { source, state: 'missing', detail: `${v.error} (looked in ${modelDir()})`, host };
  if (info.state === 'ready' || info.state === 'invalid') cache = { at: Date.now(), v: info };
  return info;
}
