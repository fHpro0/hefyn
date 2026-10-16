import { downloadModel } from './models.ts';

/** web: makes sure the GLiNER files are in `${HEFYN_DATA_DIR}/models/gliner` (verified, atomic), retrying until they are. The redact
 *  service (no internet) only reads and verifies them. No-op when GLiNER is off. Kept apart from the engine so web does not bundle it. */
export async function ensureModelFiles(log: (msg: string) => void = console.log, retryMs = 30_000) {
  if ((process.env.HEFYN_REDACT_GLINER ?? 'on').toLowerCase() === 'off') return;
  for (;;) {
    try { await downloadModel({ onProgress: log }); log('GLiNER model files are in place'); return; }
    catch (e) { log(`GLiNER model download failed, retrying: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, retryMs)); }
  }
}
