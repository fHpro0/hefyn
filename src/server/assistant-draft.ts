import { randomBytes } from 'node:crypto';
import { BundleError, CORE, type Collected, RESERVED, fromTar, isReserved, safePath, toTar } from '../assistants/bundle.ts';
import { type Catalog, type Draft, creatorFiles, draftDir, parseDraft, serializeDraft, validCwd } from '../assistants/draft.ts';
import { usableAgents } from '../cli-agents/installed.ts';
import { profileOf } from '../cli-agents/profiles.ts';
import { db } from './appdb.ts';
import type { Assistant } from './assistants.ts';
import { purgeConversations } from './chats.ts';
import { ContainerFsError, cleanPath, containerFs } from './container-fs.ts';
import { shellEnabled } from './runner.ts';
import { openForUser, sealForUser } from './vault.ts';

// The Assistant editor's two hidden chats: the creator (a CLI agent whose working folder holds the draft as files) and the test (a chat on the unsaved draft).
// Both are conversations with `hidden` set: no chat list shows them, and they go with the draft, on reset, and after a day (`sweepHidden`).

export const TEST_TTL_MS = 24 * 3600_000, CREATOR_TTL_MS = 30 * 24 * 3600_000;

/** The slice of the sandbox's file system the draft needs (a test supplies its own). */
export interface DraftFs {
  writeFile(p: string, c: string): Promise<void>;
  rm(p: string, o?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** The regular files below the folder (no `.git`) as an uncompressed tar; a folder that is not there: undefined. */
  tree(p: string): Promise<Uint8Array | undefined>;
  /** Extracts a tar into the folder; `clear`: first removes everything in it except the creator's brief and catalog. */
  putTree(p: string, tar: Uint8Array, clear: boolean): Promise<void>;
}
export const sandboxFs = (userId: string, conversationId: string): DraftFs => {
  const fs = containerFs({ userId, conversationId });
  const keep = RESERVED.map((n) => `! -name '${n}'`).join(' ');
  return {
    writeFile: fs.writeFile,
    rm: fs.rm,
    async tree(p) {
      // exit 3: the folder is not there (no files); any other failure is an error, never "empty". node_modules and .git are not read (and do not count toward the caps).
      const find = 'find . \\( -name node_modules -o -name .git \\) -prune -o -type f';
      const script = `[ -d "$1" ] || exit 3; cd "$1" || exit 4; set -o pipefail; [ "$(${find} -printf x | wc -c)" != 0 ] || exit 0; ${find} -printf "%P\\0" | tar -cf - --null -T - | base64 -w0`;
      const r = await fs.run(['bash', '-c', script, 'hefyn', cleanPath(p)], { cwd: '/files', maxOutput: 16 * 1024 * 1024, timeoutMs: 30_000 });
      if (r.truncated) throw new ContainerFsError('EFBIG', 'The Assistant\'s folder is too large.');
      if (r.exitCode === 3) return undefined;
      if (r.timedOut || r.exitCode !== 0) throw new Error(`could not read the Assistant's folder: ${r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`}`);
      return r.stdout ? Buffer.from(r.stdout, 'base64') : new Uint8Array(1024); // an empty folder: an empty tar
    },
    async putTree(p, tar, clear) {
      const r = await fs.run(['bash', '-c', `mkdir -p -- "$1" && { [ "$2" != clear ] || find "$1" -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf -- {} +; } && tar -xf - -C "$1" --no-same-owner --no-same-permissions`, 'hefyn', cleanPath(p), clear ? 'clear' : 'keep'], { cwd: '/files', stdin: tar, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `exit ${r.exitCode}`);
    },
  };
};

/** Writes files (relative paths) into the draft's folder. */
export async function writeFiles(fs: DraftFs, draftId: string, files: Record<string, string>) {
  const dir = draftDir(draftId);
  for (const [p, text] of Object.entries(files)) await fs.writeFile(`${dir}/${p}`, text);
}

/** Starts a draft folder: the creator's brief, the catalog and every part of the draft. */
export async function seedDraft(fs: DraftFs, draftId: string, draft: Draft, catalog: Catalog) {
  await writeFiles(fs, draftId, { ...creatorFiles(catalog), ...serializeDraft(draft) });
}

/** The draft folder's files (the creator's brief and catalog are not among them) and what was left out. A folder that is not there is empty. */
export async function readFolder(fs: DraftFs, draftId: string): Promise<Collected> {
  const tar = await fs.tree(draftDir(draftId));
  return tar ? fromTar(tar) : { files: {}, ignored: [] };
}

export const VIEW_CAP = 1024 * 1024;
/** Every file that would go into the bundle with its size in bytes: the core files first, then the rest sorted. */
export function listOf(files: Record<string, string>) {
  const rank = (p: string) => (CORE.includes(p) ? CORE.indexOf(p) : CORE.length);
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).map((path) => ({ path, size: Buffer.byteLength(files[path]!) }));
}
export async function listFiles(fs: DraftFs, draftId: string) { return listOf((await readFolder(fs, draftId)).files); }
export async function readFile(fs: DraftFs, draftId: string, path: string) { return fileOf((await readFolder(fs, draftId)).files, path); }
/** One bundle file's text (cut at 1 MB: `truncated`). An unsafe path, a reserved name or a file that is not in the bundle is refused. */
export function fileOf(files: Record<string, string>, path: string) {
  if (!safePath(path) || isReserved(path) || !Object.hasOwn(files, path)) throw new BundleError('That file is not part of the Assistant.');
  const buf = Buffer.from(files[path]!), truncated = buf.length > VIEW_CAP;
  return { path, text: truncated ? buf.subarray(0, VIEW_CAP).toString('utf8') : files[path]!, truncated };
}

/** A file edit that lost a race or hit an existing name (the router answers CONFLICT). */
export class DraftConflict extends Error {}
const okPath = (p: string) => { if (!safePath(p) || isReserved(p)) throw new BundleError('That file name is not allowed.'); };
/** Writes one file (folders are made by the sandbox's writeFile). `expect`: the text the person loaded, `null`: the file must not exist yet; omitted: overwrite. */
export async function writeDraftFile(fs: DraftFs, draftId: string, path: string, text: string, expect?: string | null) {
  okPath(path);
  if (expect !== undefined) {
    const { files } = await readFolder(fs, draftId), has = Object.hasOwn(files, path);
    if (expect === null ? has : !has || files[path] !== expect) throw new DraftConflict(expect === null ? 'A file with that name already exists.' : 'This file changed since you opened it.');
  }
  await fs.writeFile(`${draftDir(draftId)}/${path}`, text);
}
export async function removeDraftFile(fs: DraftFs, draftId: string, path: string) {
  fileOf((await readFolder(fs, draftId)).files, path); // must exist and be allowed
  await fs.rm(`${draftDir(draftId)}/${path}`);
}
export async function renameDraftFile(fs: DraftFs, draftId: string, from: string, to: string) {
  const { files } = await readFolder(fs, draftId);
  fileOf(files, from);
  okPath(to);
  if (Object.hasOwn(files, to)) throw new DraftConflict('A file with that name already exists.');
  await fs.writeFile(`${draftDir(draftId)}/${to}`, files[from]!);
  await fs.rm(`${draftDir(draftId)}/${from}`);
}

/** Puts imported files into the draft folder: `replace` removes the folder's other files first (not the brief and catalog). */
export async function putFiles(fs: DraftFs, draftId: string, files: Record<string, string>, replace: boolean) {
  await fs.putTree(draftDir(draftId), toTar(files), replace);
}

/** Puts a saved Assistant's stored files back into a fresh draft folder (all but the five core files, which come from the form), so editing and saving again keeps them. */
export async function restoreBundle(fs: DraftFs, draftId: string, stored: Record<string, string> | undefined) {
  const keep = Object.fromEntries(Object.entries(stored ?? {}).filter(([p]) => !CORE.includes(p)));
  if (Object.keys(keep).length) await putFiles(fs, draftId, keep, false);
}

/** The draft the creator has made of the files now (a part it broke or filled with an unknown id is reported, not taken), and the bundle's files for the diagram. */
export async function readDraft(fs: DraftFs, draftId: string, catalog: Catalog, prev: Draft) {
  const { files } = await readFolder(fs, draftId);
  return { ...parseDraft(files, catalog, prev), bundle: files };
}

/** A fresh draft id (the folder name). */
export const newDraftId = () => randomBytes(8).toString('hex');

export type Hidden = 'creator' | 'test';
interface Who { id: string; roleId?: string }

/** A hidden chat on `agent`; the person needs the sandbox and the agent, like for any chat on a plain agent. */
export function createHidden(me: Who, o: { agent: string; hidden: Hidden; draftId: string; snapshot?: Assistant; /** a test chat's copy of the draft's files (tar.gz) */ bundle?: Buffer }): string {
  const cwd = o.hidden === 'creator' ? draftDir(o.draftId) : null;
  if (cwd && !validCwd(cwd)) throw new Error('invalid working folder');
  if (!profileOf(o.agent)) throw new Error('unknown agent');
  if (!shellEnabled(me.id)) throw new Error('This needs the sandbox, which is not available to you.');
  if (!usableAgents(me.roleId).some((r) => r.id === o.agent)) throw new Error('This agent is not available to you. Ask your administrator.');
  const id = `u_${me.id}_${Date.now().toString(36).padStart(9, '0')}${randomBytes(8).toString('hex')}`, now = new Date().toISOString();
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at, agent, view, hidden, draft_id, cwd, snapshot, bundle) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, me.id, sealForUser(me.id, o.hidden === 'creator' ? 'Assistant creator' : 'Assistant test', `conv:${id}:title`), now, now, o.agent, 'chat', o.hidden, o.draftId, cwd, o.snapshot ? JSON.stringify(o.snapshot) : null, o.bundle ?? null);
  return id;
}

export const hiddenOf = (userId: string, draftId: string, hidden?: Hidden) =>
  db.prepare(`SELECT id, agent, hidden FROM conversations WHERE user_id = ? AND draft_id = ?${hidden ? ' AND hidden = ?' : ' AND hidden IS NOT NULL'} ORDER BY created_at`).all(userId, draftId, ...(hidden ? [hidden] : [])) as { id: string; agent: string; hidden: Hidden }[];

/** Removes the draft's chats and its folder (a folder that cannot be reached right now stays; it is only a few small files). `keepCreator`: leaving an unsaved draft removes the tests only. */
export async function discardDraft(userId: string, draftId: string, o: { fs?: DraftFs; keepCreator?: boolean } = {}) {
  const chats = hiddenOf(userId, draftId).filter((c) => !o.keepCreator || c.hidden === 'test'), creator = chats.find((c) => c.hidden === 'creator');
  if (creator) { try { await (o.fs ?? sandboxFs(userId, creator.id)).rm(draftDir(draftId), { recursive: true, force: true }); } catch { /* the sandbox is down: the folder stays */ } }
  if (chats.length) purgeConversations(userId, chats.map((c) => c.id));
}

/** Removes hidden chats nobody came back to: tests after a day, creators after a month. */
export function sweepHidden(now = Date.now()) {
  const rows = db.prepare('SELECT id, user_id, hidden, COALESCE(updated_at, created_at) AS at FROM conversations WHERE hidden IS NOT NULL').all() as { id: string; user_id: string; hidden: Hidden; at: string }[];
  const old = rows.filter((r) => r.at < new Date(now - (r.hidden === 'test' ? TEST_TTL_MS : CREATOR_TTL_MS)).toISOString());
  const byUser = new Map<string, string[]>();
  for (const r of old) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.id]);
  for (const [u, ids] of byUser) purgeConversations(u, ids);
  return old.length;
}
setInterval(() => { try { sweepHidden(); } catch { /* try again next hour */ } }, 3600_000).unref();

export interface Turn { user: string; agent: string }
/** The last `n` turns of a chat's event log: what the person asked and what the agent answered, each cut to `max` characters. */
export function turnsOf(events: { update: Record<string, any> }[], n = 3, max = 1500): Turn[] {
  const turns: Turn[] = [];
  for (const { update: u } of events) {
    if (u.hefyn === 'user' && typeof u.text === 'string') turns.push({ user: u.text, agent: '' });
    else if (u.sessionUpdate === 'agent_message_chunk' && !u.agent && turns.length && u.content?.type === 'text') turns.at(-1)!.agent += String(u.content.text ?? '');
  }
  return turns.slice(-n).map((t) => ({ user: t.user.slice(0, max), agent: t.agent.length > max ? `${t.agent.slice(0, max)}…` : t.agent }));
}
/** The caller's own chat only (the router checks); the log is sealed with their key. */
export function lastTurns(userId: string, conversationId: string, n?: number): Turn[] {
  const rows = db.prepare('SELECT seq, data FROM cli_events WHERE conversation_id = ? ORDER BY seq').all(conversationId) as { seq: number; data: string }[];
  return turnsOf(rows.map((r) => JSON.parse(openForUser(userId, r.data, `cli:${conversationId}:${r.seq}`))), n);
}
