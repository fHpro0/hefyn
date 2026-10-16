import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { GLINER_FILES } from './models.ts';
import { OPTIONAL_FILES } from './notice.ts';
import type { ModelFile } from './models.ts';

// Admin upload of the GLiNER files (source `local`): the model files themselves or one .tar / .zip. Everything is checked against the
// pinned size + SHA-256 list before anything is written; nothing else is accepted; the destination path never comes from the upload.
export class UploadError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
export const MAX_UPLOAD = 300 << 20;
export interface Input { name: string; data: Uint8Array }

const JUNK = /(^|\/)(\._[^/]*|\.DS_Store|__MACOSX(\/.*)?|Thumbs\.db)$/; // what macOS/Windows archivers add on their own

/** Normalized entry name, or throws on anything that could escape (absolute, `..`, drive, NUL, backslash tricks). */
function safeName(raw: string): string {
  const n = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) throw new UploadError(400, `unsafe file name "${raw.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}"`);
  return n;
}

function untar(buf: Uint8Array): Input[] {
  const out: Input[] = [];
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off + 512 <= b.length;) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0) throw new UploadError(400, 'corrupt tar archive');
    const prefix = str(345, 155), name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const data = b.subarray(off + 512, off + 512 + size);
    if (data.length < size) throw new UploadError(400, 'truncated tar archive');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g' || type === '5' || name.endsWith('/')) continue; // pax headers, directories
    if (type !== '0') throw new UploadError(400, `unsupported entry in tar archive (${name}): only regular files`);
    out.push({ name, data });
  }
  return out;
}

function unzip(buf: Uint8Array): Input[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new UploadError(400, 'not a valid zip archive');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: Input[] = [];
  const limit = Math.max(...GLINER_FILES.map((f) => f.size)) + 1;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new UploadError(400, 'corrupt zip archive');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24), nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), lh = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (usize > limit) throw new UploadError(400, `${name} is larger than any model file`);
    if (lh + 30 > b.length || b.readUInt32LE(lh) !== 0x04034b50) throw new UploadError(400, 'corrupt zip archive');
    const start = lh + 30 + b.readUInt16LE(lh + 26) + b.readUInt16LE(lh + 28);
    const raw = b.subarray(start, start + csize);
    if (raw.length < csize) throw new UploadError(400, 'truncated zip archive');
    try { out.push({ name, data: method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: limit }) : (() => { throw new UploadError(400, `unsupported zip compression in ${name}`); })() }); }
    catch (e) { throw e instanceof UploadError ? e : new UploadError(400, `cannot read ${name} from the zip archive`); }
  }
  return out;
}

const isTar = (i: Input) => /\.tar$/i.test(i.name);
const isZip = (i: Input) => /\.zip$/i.test(i.name);

/** Validates every file (known name, exact size, SHA-256) and only then moves them into `dir`. Returns the saved relative paths. */
export function saveModelFiles(dir: string, inputs: Input[], files: ModelFile[] = [...GLINER_FILES, ...OPTIONAL_FILES]): string[] {
  if (!inputs.length) throw new UploadError(400, 'no files uploaded');
  let entries = inputs;
  if (inputs.length === 1 && (isTar(inputs[0]) || isZip(inputs[0]))) entries = isTar(inputs[0]) ? untar(inputs[0].data) : unzip(inputs[0].data);
  const picked = new Map<string, Uint8Array>();
  for (const e of entries) {
    const name = safeName(e.name);
    if (JUNK.test(name)) continue;
    const f = files.find((x) => basename(x.path) === basename(name));
    if (!f) throw new UploadError(400, `unexpected file "${basename(name)}": only ${files.map((x) => basename(x.path)).join(' and ')} are accepted`);
    if (picked.has(f.path)) throw new UploadError(400, `${basename(f.path)} was uploaded twice`);
    if (e.data.length !== f.size) throw new UploadError(400, `${basename(f.path)} has the wrong size (${e.data.length} bytes, expected ${f.size}); is it the right model file?`);
    if (createHash('sha256').update(e.data).digest('hex') !== f.sha256) throw new UploadError(400, `${basename(f.path)} fails its SHA-256 check; it is not the pinned model file`);
    picked.set(f.path, e.data);
  }
  if (!picked.size) throw new UploadError(400, 'the upload contains none of the model files');
  const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}`);
  try {
    for (const [path, data] of picked) { const t = join(tmp, path); mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, data); }
    for (const path of picked.keys()) { const dest = join(dir, path); mkdirSync(dirname(dest), { recursive: true }); renameSync(join(tmp, path), dest); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return [...picked.keys()];
}
