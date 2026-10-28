// A minimal tar reader shared by the Hub's repo import and the Assistant bundles. Pure: no database, no network.

export interface TarEntry { path: string; type: string; data: Buffer }

/** Minimal ustar/pax/GNU reader. shortcut: checksums are not verified, sparse files unsupported. */
export function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let longName: string | undefined;
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const cstr = (a: number, b: number) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
    const size = parseInt(cstr(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt archive');
    if (o + 512 + size > tar.length) throw new Error('corrupt archive'); // a cut-off last entry
    const type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { for (const m of data.toString('utf8').matchAll(/\d+ path=([^\n]*)\n/g)) longName = m[1]; continue; }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    const prefix = cstr(345, 500);
    out.push({ path: longName ?? (prefix ? prefix + '/' : '') + cstr(0, 100), type, data });
    longName = undefined;
  }
  return out;
}

const block = (name: string, size: number, type: string) => {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${h.reduce((s, b) => s + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return h;
};
const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A ustar tar of text files (a name over 100 bytes goes in a GNU long-name entry, which `readTar` reads). Synchronous, unlike Bun.Archive. */
export function writeTar(files: Record<string, string>): Buffer {
  const out: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(text);
    if (name.length > 100) out.push(block('././@LongLink', name.length + 1, 'L'), padded(Buffer.concat([name, Buffer.alloc(1)])));
    out.push(block(path, data.length, '0'), padded(data));
  }
  return Buffer.concat([...out, Buffer.alloc(1024)]);
}
