// Downloads the pinned GLiNER model files once and verifies them (size + SHA-256), e.g. to copy them to an offline machine, to put
// them on a mirror, or at image build time (Dockerfile, HEFYN_GLINER_BAKE=1).
//   node scripts/gliner-fetch.ts <dir> [base-url]      (bun works too)
// base-url defaults to $HEFYN_GLINER_BASE_URL (an https mirror), else Hugging Face. <dir> gets tokenizer.json and onnx/model_quint8.onnx.
import { baseUrlFor, defaultBaseUrl, downloadModel, sameHostFetch, verifyModel } from '../src/server/redact/models.ts';
import { MODEL_CARD, writeNotice } from '../src/server/redact/notice.ts';

const [dir, arg] = process.argv.slice(2);
if (!dir) { console.error('usage: node scripts/gliner-fetch.ts <dir> [base-url]'); process.exit(2); }
const mirror = arg || process.env.HEFYN_GLINER_BASE_URL;
try {
  if (mirror) {
    const u = new URL(mirror);
    if (u.protocol !== 'https:') throw new Error('the base URL must be https');
    process.env.HEFYN_GLINER_BASE_URL = mirror;
    await downloadModel({ dir, baseUrl: baseUrlFor('mirror'), fetchImpl: sameHostFetch(u), onProgress: console.log });
  } else await downloadModel({ dir, baseUrl: defaultBaseUrl(), onProgress: console.log });
  // Apache-2.0: the licence text and attribution travel with the files; the model card is a best-effort extra (pinned by SHA-256).
  writeNotice(dir);
  await downloadModel({ dir, files: [MODEL_CARD], baseUrl: mirror ? baseUrlFor('mirror') : defaultBaseUrl(), fetchImpl: mirror ? sameHostFetch(new URL(mirror)) : undefined }).catch((e) => console.warn(`model card not fetched (${(e as Error).message}); NOTICE.txt and the licence text were written`));
  const v = await verifyModel(dir);
  if (!v.ok) throw new Error(v.error);
  console.log(`GLiNER model files verified in ${dir}`);
} catch (e) { console.error(`failed: ${(e as Error).message}`); process.exit(1); }
