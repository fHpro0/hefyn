import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BUNDLE_LIMITS, BundleError, collect, pack, parts, readZip, safePath, summary, unpack } from '../src/assistants/bundle.ts';
import { readTar, writeTar } from '../src/assistants/tar.ts';

// The Assistant bundle's trust boundary: paths, links, caps, the single top folder, and the zip reader. No database, no network.
const file = (path: string, text = 'x', type = '0') => ({ path, type, data: Buffer.from(text) });
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

test('the path guard', () => {
  for (const ok of ['a', 'a/b.txt', 'skills/x/SKILL.md', '.hidden/file']) assert.equal(safePath(ok), true, ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a\0b', 'a/', '.', '..', 'x'.repeat(256)]) assert.equal(safePath(bad), false, JSON.stringify(bad));
  for (const bad of ['../evil', '/abs', 'a/../../b', 'a\\b']) assert.throws(() => collect([file(bad)]), BundleError, bad);
});

test('links and devices are never taken (skipped and listed); a link outside the chosen subfolder does not matter; directories are skipped', () => {
  const r = collect([file('l', '/etc/passwd', '2'), file('h', '', '1'), file('d', '', '3'), file('ok.md', 'A')]);
  assert.deepEqual([r.files, r.ignored], [{ 'ok.md': 'A' }, ['d', 'h', 'l']]);
  assert.deepEqual(collect([file('dir/', '', '5'), file('dir/a.md', 'A')]).files, { 'dir/a.md': 'A' });
  const repo = [file('r/CLAUDE.md', 'AGENTS.md', '2'), file('r/../evil', 'x'), file('r/docs/a.md', 'A'), file('r/docs/link', 'x', '2')];
  const sub = collect(repo, { strip: true, path: 'docs' });
  assert.deepEqual([sub.files, sub.ignored], [{ 'a.md': 'A' }, ['link']]);
  assert.throws(() => collect(repo, { strip: true }), /not a valid path/, 'without a subfolder every path counts');
  assert.equal(safePath('é'.repeat(128)), false, 'a segment is 255 bytes at most, not characters');
  assert.equal(safePath('é'.repeat(127)), true);
});

test('a cut-off tar is corrupt', async () => {
  const tar = writeTar({ 'a.md': 'x'.repeat(2000) });
  assert.throws(() => readTar(tar.subarray(0, 512 + 1000)), /corrupt archive/);
  assert.deepEqual(readTar(tar).map((e) => e.path), ['a.md']);
});

test('caps are errors, not truncation', () => {
  const many = Array.from({ length: BUNDLE_LIMITS.files + 1 }, (_, i) => file(`f${i}`, ''));
  assert.throws(() => collect(many), /Too many files/);
  assert.equal(Object.keys(collect(many.slice(1)).files).length, BUNDLE_LIMITS.files);
  assert.throws(() => collect([file('big', 'a'.repeat(BUNDLE_LIMITS.bytes + 1))]), /Too large/);
  assert.throws(() => collect([file('a', 'x'), file('a/b', 'y')]), /both a file and a folder/);
  assert.throws(() => collect([file('a', 'x'), file('a', 'y')]), /twice/);
});

test('reserved names, .git and binaries are ignored; one top folder and a subfolder are stripped', () => {
  const r = collect([file('repo/CLAUDE.md'), file('repo/catalog.json'), file('repo/.git/config'), file('repo/img.png', 'a\0b'), file('repo/assistant.json', '{}'), file('repo/docs/a.md', 'A'), file('repo/other/b.md', 'B')], { strip: true });
  assert.deepEqual(r.files, { 'assistant.json': '{}', 'docs/a.md': 'A', 'other/b.md': 'B' });
  assert.deepEqual(r.ignored, ['CLAUDE.md', '.git/config', 'catalog.json', 'img.png'].sort());
  assert.deepEqual(collect([file('repo/docs/a.md', 'A'), file('repo/other/b.md')], { strip: true, path: 'docs' }).files, { 'a.md': 'A' });
  assert.throws(() => collect([file('a.md')], { path: 'nope' }), /not in the archive/);
  assert.throws(() => collect([file('a.md')], { path: '../x' }), BundleError);
  assert.deepEqual(collect([file('top/a.md'), file('b.md')], { strip: true }).files, { 'top/a.md': 'x', 'b.md': 'x' }, 'two roots: nothing is stripped');
  assert.deepEqual(collect([file('__MACOSX/x'), file('p/a.md')], { strip: true }).files, { 'a.md': 'x' });
});

test('pack and unpack round trip; parts and summary', async () => {
  const files = { 'assistant.json': '{}', 'instructions.md': 'hi', 'skills.json': '[]', 'skills/legal/SKILL.md': 's', 'skills/legal/ref.md': 'r', 'data/a.csv': '1,2', 'README.md': 'r', 'CLAUDE.md': 'brief' };
  const back = unpack(await pack(files));
  const { 'CLAUDE.md': _brief, ...want } = files;
  assert.deepEqual(back, want);
  assert.deepEqual(summary(back), { files: ['README.md', 'data/a.csv'], bundledSkills: ['legal'] });
  const p = parts(back);
  assert.deepEqual(Object.keys(p.extra).sort(), ['README.md', 'data/a.csv']);
  assert.deepEqual(p.skills, [{ name: 'legal', files: { 'SKILL.md': 's', 'ref.md': 'r' } }]);
  assert.throws(() => pack({ '../x': 'y' }), BundleError);
});

test('a tar with a symlink is refused', async () => {
  const tar = Buffer.from(await new Bun.Archive({ 'a.md': 'A' }).bytes());
  assert.deepEqual(readTar(tar).map((e) => e.path), ['a.md']);
  tar[156] = '2'.charCodeAt(0); // the entry becomes a symlink
  assert.deepEqual(collect(readTar(tar)).ignored, ['a.md']);
});

test('zip: deflate and stored entries, the top folder, reserved names', () => {
  for (const n of ['bundle.zip', 'bundle-stored.zip']) {
    const r = collect(readZip(fixture(n)), { strip: true });
    assert.deepEqual(Object.keys(r.files).sort(), ['assistant.json', 'notes/a.md', 'skills/x/SKILL.md'], n);
    assert.equal(r.files['notes/a.md'], 'hello hello hello hello hello hello\n');
    assert.deepEqual(r.ignored, ['CLAUDE.md']);
  }
});

test('zip rejections', () => {
  const linked = collect(readZip(fixture('bundle-link.zip')), { strip: true });
  assert.ok(linked.ignored.includes('link') && !('link' in linked.files), 'a symlink in a zip is skipped');
  assert.throws(() => readZip(Buffer.from('abc')), /not a zip/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, just text that is long enough')), /not a zip/);
  const patch = (at: (z: Buffer) => void) => { const z = Buffer.from(fixture('bundle.zip')); at(z); return z; };
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]), eocd = (z: Buffer) => z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const eachCd = (z: Buffer, f: (at: number) => void) => { for (let i = z.indexOf(sig); i >= 0; i = z.indexOf(sig, i + 4)) f(i); };
  assert.throws(() => readZip(patch((z) => eachCd(z, (i) => z.writeUInt16LE(1, i + 8)))), /Encrypted/);
  assert.throws(() => readZip(patch((z) => eachCd(z, (i) => z.writeUInt16LE(12, i + 10)))), /not supported/);
  assert.throws(() => readZip(patch((z) => z.writeUInt16LE(0xffff, eocd(z) + 10))), /Zip64/);
  assert.throws(() => readZip(patch((z) => eachCd(z, (i) => z.writeUInt32LE(0xffffffff, i + 24)))), /Zip64/);
  assert.throws(() => readZip(patch((z) => z.writeUInt32LE(z.length + 10, eocd(z) + 16))), /corrupt/);
  assert.throws(() => readZip(Buffer.alloc(BUNDLE_LIMITS.zip + 1)), /too large/);
  assert.throws(() => readZip(patch((z) => eachCd(z, (i) => z.writeUInt32LE(900_000_000, i + 24)))), /Too large/, 'a declared size over the cap is refused before inflating');
});
