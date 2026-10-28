import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { type TarEntry, readTar, writeTar } from './tar.ts';

// An Assistant bundle: the Assistant's files, like a plugin. Its layout is the draft folder's (src/assistants/draft.ts): assistant.json, instructions.md, skills.json, mcp.json, helpers.json, skills/<name>/...
// plus any other ("extra") files. Each new chat gets a fresh copy of the extra files. Team skills and MCP servers are only referenced by id (skills.json, mcp.json), never copied in.
// Pure: no database, no sandbox, no network. Every path that enters a bundle goes through `collect` (the trust boundary).

export const BUNDLE_LIMITS = { files: 1000, bytes: 10 * 1024 * 1024, zip: 10 * 1024 * 1024, path: 255 };
export type Files = Record<string, string>;
/** The creator's brief and catalog: in the draft folder, never in a bundle. `.git/` is never either. */
export const RESERVED = ['catalog.json', 'CLAUDE.md', 'AGENTS.md'];
/** The files the existing pipeline handles (the form fields and skills); everything else is an extra file. */
export const CORE = ['assistant.json', 'instructions.md', 'skills.json', 'mcp.json', 'helpers.json'];

export class BundleError extends Error {}
const fail = (m: string): never => { throw new BundleError(m); };

export const isReserved = (p: string) => RESERVED.includes(p) || p === '.git' || p.startsWith('.git/');
export const isCore = (p: string) => CORE.includes(p) || p.startsWith('skills/');

/** Relative POSIX path with no `..`, no absolute start, no backslash, no NUL, no empty or `.` segment, at most 255 characters in all and 255 UTF-8 bytes per segment. */
export function safePath(p: string): boolean {
  return p.length > 0 && p.length <= BUNDLE_LIMITS.path && !p.includes('\\') && !p.includes('\0') && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && Buffer.byteLength(s) <= 255);
}

export interface Collected { files: Files; ignored: string[] }
interface Opts { /** remove the one top folder that holds everything (a GitHub tarball, most zips) */ strip?: boolean; /** keep only this subfolder, and remove it from the paths */ path?: string }

/** Validates archive entries into bundle files. A path that breaks the guard or a cap is an error; links, devices, reserved, binary and `__MACOSX` entries are skipped and listed in `ignored`. */
export function collect(entries: TarEntry[], o: Opts = {}): Collected {
  const dec = new TextDecoder('utf-8', { fatal: true });
  let list = entries.filter((e) => !(e.type === '5' || e.path.endsWith('/')));
  const ignored: string[] = [];
  list = list.filter((e) => !e.path.startsWith('__MACOSX/') || void ignored.push(e.path));
  const top = new Set(list.map((e) => e.path.split('/')[0]));
  if (o.strip && top.size === 1 && list.every((e) => e.path.includes('/'))) list = list.map((e) => ({ ...e, path: e.path.slice(e.path.indexOf('/') + 1) }));
  if (o.path) {
    const sub = o.path.replace(/\/+$/, '');
    if (!safePath(sub)) fail(`"${o.path}" is not a valid folder`);
    list = list.filter((e) => e.path.startsWith(`${sub}/`)).map((e) => ({ ...e, path: e.path.slice(sub.length + 1) }));
    if (!list.length) fail(`The folder "${o.path}" is not in the archive.`);
  }
  const files: Files = {};
  let bytes = 0;
  for (const e of list) { // only what is left after the strip and the subfolder is checked: a link elsewhere in a repository does not matter
    if (!safePath(e.path)) fail(`"${e.path}" is not a valid path`);
    if (e.type !== '0' && e.type !== '\0') { ignored.push(e.path); continue; } // links and devices are never taken
    if (isReserved(e.path)) { ignored.push(e.path); continue; }
    let text: string;
    try { text = dec.decode(e.data); } catch { ignored.push(e.path); continue; } // binary files are not part of a bundle
    if (text.includes('\0')) { ignored.push(e.path); continue; }
    if (e.path in files) fail(`"${e.path}" is in the archive twice`);
    if (Object.keys(files).length >= BUNDLE_LIMITS.files) fail(`Too many files (at most ${BUNDLE_LIMITS.files}).`);
    bytes += e.data.length;
    if (bytes > BUNDLE_LIMITS.bytes) fail(`Too large (at most ${BUNDLE_LIMITS.bytes / 1024 / 1024} MB of files).`);
    files[e.path] = text;
  }
  for (const p of Object.keys(files)) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (p.slice(0, i) in files) fail(`"${p.slice(0, i)}" is both a file and a folder`);
  return { files, ignored: ignored.sort() };
}

/** The bundle as tar.gz. */
export function pack(files: Files): Buffer {
  const ok = collect(Object.entries(files).map(([path, c]) => ({ path, type: '0', data: Buffer.from(c) }))).files; // the guard and the caps, once more
  return gzipSync(writeTar(ok));
}
/** The same files as an uncompressed tar (what goes into a sandbox in one command). */
export const toTar = (files: Files): Uint8Array => writeTar(files);

/** Reads a tar.gz bundle (every path is checked again). */
export function unpack(gz: Uint8Array): Files {
  let tar: Buffer;
  try { tar = gunzipSync(gz, { maxOutputLength: BUNDLE_LIMITS.bytes * 2 }); } catch { return fail('The bundle is corrupt or too large.'); }
  return collect(readTar(tar)).files;
}
/** Reads an uncompressed tar (a sandbox folder). */
export const fromTar = (tar: Uint8Array): Collected => collect(readTar(Buffer.from(tar)));

/** Sorted extra files and the names of the bundled skills, for the diagram. */
export function summary(files: Files) {
  const paths = Object.keys(files);
  return { files: paths.filter((p) => !isCore(p)).sort(), bundledSkills: [...new Set(paths.filter((p) => p.startsWith('skills/') && p.split('/').length > 2).map((p) => p.split('/')[1]!))].sort() };
}

/** What a chat gets from the bundle: the extra files (copied once) and the bundled skills (name -> files, SKILL.md included; written to the agent's skills dir at every start). */
export function parts(files: Files) {
  const skills = new Map<string, Files>(), extra: Files = {};
  for (const [p, c] of Object.entries(files)) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(p);
    if (m) skills.set(m[1]!, { ...skills.get(m[1]!), [m[2]!]: c });
    else if (!isCore(p)) extra[p] = c;
  }
  return { extra, skills: [...skills].map(([name, f]) => ({ name, files: f })) };
}

// ---------- zip (stored + deflate only) ----------

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o), u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

/** Reads a zip: the central directory, stored and deflate entries. Zip64, encrypted entries and other methods are rejected. shortcut: CRCs are not checked. */
export function readZip(zip: Buffer): TarEntry[] {
  if (zip.length < 22) fail('This is not a zip file.');
  if (zip.length > BUNDLE_LIMITS.zip) fail(`The zip is too large (at most ${BUNDLE_LIMITS.zip / 1024 / 1024} MB).`);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('This is not a zip file.');
  if ((eocd >= 20 && u32(zip, eocd - 20) === 0x07064b50) || u16(zip, eocd + 10) === 0xffff || u32(zip, eocd + 16) === 0xffffffff) fail('Zip64 files are not supported.');
  const count = u16(zip, eocd + 10), out: TarEntry[] = [];
  let o = u32(zip, eocd + 16), declared = 0;
  const need = (end: number) => { if (end > zip.length) fail('The zip is corrupt.'); };
  for (let n = 0; n < count; n++) {
    need(o + 46);
    if (u32(zip, o) !== 0x02014b50) fail('The zip is corrupt.');
    const flags = u16(zip, o + 8), method = u16(zip, o + 10), csize = u32(zip, o + 20), usize = u32(zip, o + 24), nl = u16(zip, o + 28), el = u16(zip, o + 30), cl = u16(zip, o + 32), attr = u32(zip, o + 38), lo = u32(zip, o + 42);
    need(o + 46 + nl);
    const path = zip.subarray(o + 46, o + 46 + nl).toString('utf8');
    o += 46 + nl + el + cl;
    if (flags & 0x41) fail('Encrypted zip entries are not supported.');
    if (csize === 0xffffffff || usize === 0xffffffff) fail('Zip64 files are not supported.');
    if (path.endsWith('/')) continue;
    if (method !== 0 && method !== 8) fail(`"${path}" uses a compression method that is not supported (use a plain zip).`);
    declared += usize;
    if (declared > BUNDLE_LIMITS.bytes + 1024 * 1024) fail(`Too large (at most ${BUNDLE_LIMITS.bytes / 1024 / 1024} MB of files).`); // before anything is inflated
    need(lo + 30);
    if (u32(zip, lo) !== 0x04034b50) fail('The zip is corrupt.');
    const start = lo + 30 + u16(zip, lo + 26) + u16(zip, lo + 28);
    need(start + csize);
    const raw = zip.subarray(start, start + csize);
    let data: Buffer;
    try { data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: usize + 1 }); } catch { return fail(`"${path}" could not be unpacked.`); }
    if (data.length !== usize) fail(`"${path}" is corrupt.`);
    out.push({ path, type: ((attr >>> 16) & 0xf000) === 0xa000 ? '2' : '0', data });
  }
  return out;
}
