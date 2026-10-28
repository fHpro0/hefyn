import { createHash } from 'node:crypto';
import { pack } from '../assistants/bundle.ts';
import { validateFlow } from '../assistants/validate.ts';
import { bundleOf } from './assistant-bundle.ts';
import type { FlowError } from '../assistants/flow.ts';
import { db } from './appdb.ts';
import { writeAssistant } from './assistant-store.ts';
import { getAssistant, inputsOf } from './assistants.ts';
import { reviewHooks } from './hub.ts';
import { infoOf } from './mcp.ts';

// Sharing an Assistant with the team (old/docs/ASSISTANTS.md): the owner's private Assistant becomes a Hub package of kind `assistant` (status pending), which shows in the Hub review queue
// like any other package (reviewers read `assistant.json`). Approving it creates or updates the team copy `t_<id>` owned by the team; the owner keeps the private one. Rejecting marks it declined.

export const packageIdOf = (assistantId: string) => `asst_${assistantId}`;
export const assistantIdOfPackage = (packageId: string) => (packageId.startsWith('asst_') ? packageId.slice(5) : packageId);
export class ShareError extends Error { status = 400; errors: FlowError[]; constructor(message: string, errors: FlowError[] = []) { super(message); this.errors = errors; } }
const BUNDLE_DIR = 'bundle/'; // the Assistant's own files in the package, next to assistant.json
const EMPTY =JSON.stringify({ items: { skills: [], agents: [], mcp: [] }, ignored: [], needsRunner: [] });

export function share(me: { id: string; roleId?: string }, id: string) {
  const a = getAssistant(id);
  if (!a || a.scope !== 'private' || a.owner !== me.id) throw Object.assign(new ShareError('Unknown assistant'), { status: 404 });
  if (a.shareStatus === 'pending') throw Object.assign(new ShareError('This assistant is already waiting for review.'), { status: 409 });
  const errors = validateFlow(a.flow, { userId: me.id, roleId: me.roleId, scope: 'team', selfId: a.id });
  if (errors.length) throw new ShareError(`This assistant cannot be shared yet: ${errors[0]!.message}`, errors);
  const files: Record<string, string> = { 'assistant.json': JSON.stringify({ name: a.name, description: a.description, icon: a.icon, inputs: a.inputs, flow: a.flow, helpers: a.helpers, mcp: a.mcp }, null, 2) };
  for (const [p, c] of Object.entries(bundleOf(a.id) ?? {})) files[`${BUNDLE_DIR}${p}`] = c; // the Assistant's own files, readable in the review
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex'), pid = packageIdOf(a.id), now = new Date().toISOString();
  const clash = db.prepare('SELECT id FROM packages WHERE owner_id = ? AND kind = ? AND name = ? AND id != ?').get(me.id, 'assistant', a.name, pid);
  const name = clash ? `${a.name} (${a.id.slice(-4)})` : a.name;
  db.exec('BEGIN');
  try {
    if (db.prepare('SELECT 1 FROM packages WHERE id = ?').get(pid)) {
      db.prepare("UPDATE packages SET name = ?, description = ?, version = ?, hash = ?, visibility = 'team', status = 'pending', reject_reason = NULL, updated_at = ? WHERE id = ?").run(name, a.description, String(a.version), hash, now, pid);
      db.prepare('DELETE FROM package_files WHERE package_id = ?').run(pid);
    } else {
      db.prepare(`INSERT INTO packages (id, kind, name, description, version, hash, source_json, visibility, status, owner_id, manifest_json, guard_json, created_at, updated_at)
        VALUES (?, 'assistant', ?, ?, ?, ?, '{"type":"ui"}', 'team', 'pending', ?, ?, '{"flagged":false,"reasons":[]}', ?, ?)`).run(pid, name, a.description, String(a.version), hash, me.id, EMPTY, now, now);
    }
    for (const [p, c] of Object.entries(files)) db.prepare('INSERT INTO package_files (package_id, path, content, size) VALUES (?,?,?,?)').run(pid, p, c, Buffer.byteLength(c));
    db.prepare("UPDATE profiles SET share_status = 'pending' WHERE id = ?").run(a.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { packageId: pid };
}

/** Hub review hook: approve = the team copy, reject = declined. */
reviewHooks.assistant = (packageId, decision) => {
  const id = assistantIdOfPackage(packageId), a = getAssistant(id);
  if (!a) return;
  if (decision === 'rejected') { db.prepare("UPDATE profiles SET share_status = 'declined' WHERE id = ?").run(id); return; }
  const snap = db.prepare("SELECT content FROM package_files WHERE package_id = ? AND path = 'assistant.json'").get(packageId) as { content: string } | undefined;
  if (!snap) return;
  const j = JSON.parse(snap.content), copy = getAssistant(`t_${id}`);
  const teamMcp = (Array.isArray(j.mcp) ? j.mcp : []).filter((c: string) => infoOf(c)?.visibility === 'team'); // only the team's own servers: nobody can use another person's private one
  const bundle: Record<string, string> = {};
  for (const r of db.prepare('SELECT path, content FROM package_files WHERE package_id = ? AND path LIKE ?').all(packageId, `${BUNDLE_DIR}%`) as { path: string; content: string }[]) bundle[r.path.slice(BUNDLE_DIR.length)] = r.content;
  if (Object.keys(bundle).length) bundle['mcp.json'] = `${JSON.stringify(teamMcp, null, 2)}\n`; // the copy's files name the same servers as its column
  writeAssistant({ id: copy?.id, newId: `t_${id}`, name: j.name, description: j.description, icon: j.icon, inputs: inputsOf(j.inputs), roles: copy?.roles ?? [], flow: j.flow, scope: 'team', owner: null,
    helpers: Array.isArray(j.helpers) ? j.helpers : [], mcp: teamMcp, bundle: Object.keys(bundle).length ? pack(bundle) : undefined });
  db.prepare('UPDATE profiles SET share_status = NULL WHERE id = ?').run(id);
};
