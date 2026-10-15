import { db } from './appdb.ts';
import { decrypt } from './crypto.ts';

// Shared by web and agent: no Flue imports here.
export async function sidecar(path: string, body: unknown): Promise<any> {
  const base = process.env.HEFYN_REDACT_URL;
  if (!base) throw new Error('the redaction service is not configured (HEFYN_REDACT_URL)');
  const res = await fetch(base.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    .catch((e) => { throw new Error(`the redaction service is unreachable (${(e as Error).message})`); });
  if (!res.ok) throw new Error(`the redaction service refused the request (HTTP ${res.status}: ${(await res.text()).slice(0, 200)})`);
  return res.json();
}

/** Prompt-injection check for untrusted text (hub content screening, phase 3). Throws when the sidecar fails: deny. */
export const guard = (text: string): Promise<{ flagged: boolean; score: number; reason: string }> => sidecar('/guard', { text });

const PLACEHOLDERS = /\{\{var:([A-Z][A-Z0-9_]{0,63})\}\}/g;
export function auditFor(conversationId: string) {
  const rows = (db.prepare('SELECT id, provider, model, status, findings, bytes, error, ts, payload FROM redact_audit WHERE conversation_id = ? ORDER BY id DESC LIMIT 200').all(conversationId) as any[])
    .map(({ payload, ...r }) => ({ ...r, findings: JSON.parse(r.findings), seals: [...new Set([...(payload ?? '').matchAll(PLACEHOLDERS)].map((m) => m[1]))] }));
  const last = rows.find((r) => r.status === 'ok');
  const payload = last && (db.prepare('SELECT payload FROM redact_audit WHERE id = ?').get(last.id) as { payload: string }).payload;
  return { requests: rows, latest: last ? { id: last.id, provider: last.provider, model: last.model, ts: last.ts, payload: JSON.parse(payload!) } : null };
}

/** The conversation's seals (placeholder -> real value). Secrets: only for the conversation's owner, never cached. */
export const sealsFor = (conversationId: string) => {
  const r = db.prepare('SELECT enc FROM redact_vars WHERE conversation_id = ?').get(conversationId) as { enc: string } | undefined;
  const vars: Record<string, string> = r ? JSON.parse(decrypt(r.enc)) : {};
  return Object.entries(vars).map(([name, value]) => ({ name, label: name.replace(/_\d+$/, ''), value }));
};

export const audit = (id: string, model: { provider: string; id: string }, status: 'ok' | 'blocked', findings: unknown[], payload: string | null, error?: string) =>
  Number(db.prepare('INSERT INTO redact_audit (conversation_id, provider, model, status, findings, bytes, payload, error, ts) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, model.provider, model.id, status, JSON.stringify(findings), payload ? Buffer.byteLength(payload) : 0, payload, error ?? null, new Date().toISOString()).lastInsertRowid);

// ---- settings: images (GLiNER cannot read them) ----
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
export const imagesAllowed = () => (db.prepare("SELECT value FROM settings WHERE key = 'allowImages'").get() as { value: string } | undefined)?.value === '1';
export const setImagesAllowed = (on: boolean) => void db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allowImages', ?)").run(on ? '1' : '0');

// ---- sidecar health: GLiNER is mandatory in production ----
export const glinerRequired = () => process.env.NODE_ENV === 'production' && process.env.HEFYN_ALLOW_NO_GLINER !== '1';
let healthAt = 0, healthVal: { ready: boolean; gliner: boolean } | undefined;
/** Sidecar health, cached 5 s. `gliner` = the GLiNER detector is loaded. Never throws. */
export async function sidecarHealth(fresh = false): Promise<{ ready: boolean; gliner: boolean }> {
  if (!fresh && healthVal && Date.now() - healthAt < 5000) return healthVal;
  const base = process.env.HEFYN_REDACT_URL;
  let v = { ready: false, gliner: false };
  if (base) {
    try {
      const j: any = await (await fetch(base.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(3000) })).json();
      v = { ready: !!j.ready, gliner: Array.isArray(j.detectors) && j.detectors.includes('gliner') };
    } catch { /* unreachable: not ready */ }
  }
  healthAt = Date.now(); healthVal = v;
  return v;
}
/** Throws unless the redaction service is ready (and, where required, running GLiNER). Used by the gate before every request. */
export async function assertPrivacyReady() {
  const h = await sidecarHealth();
  if (!h.ready) throw new Error('the redaction service is not ready');
  if (glinerRequired() && !h.gliner) throw new Error('GLiNER is not active in the redaction service (required in production; HEFYN_ALLOW_NO_GLINER=1 is for dev/test only)');
}
