import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { ensureModelFiles, glinerInfo, invalidateGlinerInfo } from '../src/server/redact/download.ts';
import { GLINER_FILES, baseUrlFor, downloadModel, mirrorBase, modelDir, sameHostFetch, sourceOf, verifyModel } from '../src/server/redact/models.ts';
import { NOTICE_FILES, writeNotice } from '../src/server/redact/notice.ts';
import { UploadError, saveModelFiles } from '../src/server/redact/upload.ts';

// Where the GLiNER model comes from: huggingface | mirror | image | local. Only the first two ever make a network request.
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `hefyn-${p}-`));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const small = (name: string, content: string) => ({ path: name, size: Buffer.byteLength(content), sha256: sha(content) });
const FILES = [small('tokenizer.json', 'tok-bytes'), small('onnx/model_quint8.onnx', 'model-bytes!')];
const realModel = existsSync('/tmp/gliner-pii/tokenizer.json') ? '/tmp/gliner-pii' : undefined;

const env = { ...process.env };
beforeEach(() => { delete process.env.HEFYN_REDACT_MODEL_DIR; delete process.env.HEFYN_GLINER_SOURCE; }); // an exported override must not leak into these tests
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const k of ['HEFYN_GLINER_SOURCE', 'HEFYN_GLINER_BASE_URL', 'HEFYN_GLINER_DIR', 'HEFYN_REDACT_MODEL_DIR', 'HEFYN_REDACT_GLINER']) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]);
  globalThis.fetch = realFetch;
  invalidateGlinerInfo();
});

// ---- mirror ----
const route = (table: Record<string, () => Response>, seen: string[] = []): typeof fetch => (async (input: any) => { const u = String(input); seen.push(u); const r = table[u]; if (!r) throw new Error(`unexpected request ${u}`); return r(); }) as any;

test('mirror: https only, files fetched from the mirror with the pinned layout and verified', async () => {
  process.env.HEFYN_GLINER_SOURCE = 'mirror';
  process.env.HEFYN_GLINER_BASE_URL = 'http://plain.example/gliner';
  assert.throws(mirrorBase, /must be https/);
  process.env.HEFYN_GLINER_BASE_URL = 'https://files.example/models/gliner/';
  assert.equal(baseUrlFor('mirror'), 'https://files.example/models/gliner');
  const seen: string[] = [];
  globalThis.fetch = route({ 'https://files.example/models/gliner/tokenizer.json': () => new Response('tok-bytes'), 'https://files.example/models/gliner/onnx/model_quint8.onnx': () => new Response('model-bytes!') }, seen);
  const dir = tmp('mirror');
  await downloadModel({ dir, files: FILES, baseUrl: baseUrlFor('mirror'), fetchImpl: sameHostFetch(mirrorBase()) });
  assert.deepEqual(await verifyModel(dir, FILES), { ok: true });
  assert.deepEqual(seen, ['https://files.example/models/gliner/tokenizer.json', 'https://files.example/models/gliner/onnx/model_quint8.onnx']);
  assert.equal((await glinerInfo()).host, 'files.example');
});

test('mirror: wrong hash is rejected and leaves nothing behind', async () => {
  const dir = tmp('mirror-bad');
  const origin = new URL('https://files.example/m');
  globalThis.fetch = route({ 'https://files.example/m/tokenizer.json': () => new Response('tok-BYTES'), 'https://files.example/m/onnx/model_quint8.onnx': () => new Response('x') });
  await assert.rejects(downloadModel({ dir, files: FILES, baseUrl: 'https://files.example/m', fetchImpl: sameHostFetch(origin) }), /corrupt/);
  assert.deepEqual(readdirSync(dir), []);
});

test('mirror: a redirect to another host (or to http) is refused, a redirect within the host is followed', async () => {
  const origin = new URL('https://files.example/m');
  const dir = tmp('mirror-redir');
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  globalThis.fetch = route({ 'https://files.example/m/tokenizer.json': redirect('https://evil.example/tokenizer.json'), 'https://evil.example/tokenizer.json': () => { throw new Error('must not be requested'); } });
  await assert.rejects(downloadModel({ dir, files: FILES, baseUrl: 'https://files.example/m', fetchImpl: sameHostFetch(origin) }), /another host \(evil\.example\)/);
  globalThis.fetch = route({ 'https://files.example/m/tokenizer.json': redirect('http://files.example/tokenizer.json') });
  await assert.rejects(downloadModel({ dir, files: FILES, baseUrl: 'https://files.example/m', fetchImpl: sameHostFetch(origin) }), /refused/);
  globalThis.fetch = route({ 'https://files.example/m/tokenizer.json': redirect('/cdn/tok'), 'https://files.example/cdn/tok': () => new Response('tok-bytes'), 'https://files.example/m/onnx/model_quint8.onnx': () => new Response('model-bytes!') });
  await downloadModel({ dir, files: FILES, baseUrl: 'https://files.example/m', fetchImpl: sameHostFetch(origin) });
  assert.deepEqual(await verifyModel(dir, FILES), { ok: true });
});

// ---- image / local: no network at all ----
for (const source of ['image', 'local']) {
  test(`${source}: web makes no model request at all; missing files are reported, never fetched`, async () => {
    process.env.HEFYN_GLINER_SOURCE = source;
    process.env.HEFYN_GLINER_DIR = tmp(source);
    const calls: string[] = [];
    globalThis.fetch = (async (u: any) => { calls.push(String(u)); throw new Error('network is off'); }) as any;
    await ensureModelFiles(() => {}, 10);
    assert.deepEqual(calls, []);
    assert.equal(modelDir(), process.env.HEFYN_GLINER_DIR);
    const info = await glinerInfo();
    assert.deepEqual([info.source, info.state], [source, 'missing']);
    assert.match(info.detail!, /not downloaded yet/);
    assert.deepEqual(calls, []);
  });
}

test('image: files in the baked directory are used as they are (ready, no download attempted)', { skip: realModel ? false : 'GLiNER model files not at /tmp/gliner-pii' }, async () => {
  process.env.HEFYN_GLINER_SOURCE = 'image';
  process.env.HEFYN_GLINER_DIR = realModel;
  globalThis.fetch = (async () => { throw new Error('network is off'); }) as any;
  await ensureModelFiles(() => {}, 10);
  assert.deepEqual(await glinerInfo(), { source: 'image', state: 'ready', host: undefined });
});

test('source selection: default huggingface, invalid value is an error state, off is reported', async () => {
  delete process.env.HEFYN_GLINER_SOURCE;
  assert.equal(sourceOf(), 'huggingface');
  process.env.HEFYN_GLINER_SOURCE = 'ftp';
  assert.throws(sourceOf, /must be one of/);
  assert.equal((await glinerInfo()).state, 'error');
  process.env.HEFYN_GLINER_SOURCE = 'mirror';
  delete process.env.HEFYN_GLINER_BASE_URL;
  assert.match((await glinerInfo()).detail!, /needs HEFYN_GLINER_BASE_URL/);
  process.env.HEFYN_REDACT_GLINER = 'off';
  process.env.HEFYN_GLINER_SOURCE = 'local';
  assert.match((await glinerInfo()).detail!, /switched off/);
});

test('state reporting: downloading, error after a failed download, invalid files', async () => {
  process.env.HEFYN_REDACT_MODEL_DIR = tmp('state');
  process.env.HEFYN_GLINER_SOURCE = 'huggingface';
  assert.equal((await glinerInfo()).state, 'downloading'); // web has not finished (or started) the download
  globalThis.fetch = (async () => { throw new Error('connection refused'); }) as any;
  void ensureModelFiles(() => {}, 3_600_000); // fails once, then waits
  await new Promise((r) => setTimeout(r, 300));
  const e = await glinerInfo();
  assert.equal(e.state, 'error');
  assert.match(e.detail!, /fetch failed|connection refused/);
  // files that are not the pinned ones
  mkdirSync(join(process.env.HEFYN_REDACT_MODEL_DIR, 'onnx'), { recursive: true });
  writeFileSync(join(process.env.HEFYN_REDACT_MODEL_DIR, 'tokenizer.json'), 'not the tokenizer');
  invalidateGlinerInfo();
  const bad = await glinerInfo();
  assert.equal(bad.state, 'invalid');
  assert.match(bad.detail!, /wrong size/);
});

// ---- upload (source local) ----
const tar = (entries: [string, string | Buffer][]) => {
  const blocks: Buffer[] = [];
  for (const [name, data] of entries) {
    const d = Buffer.from(data), h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(d.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
    h.write(h.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, d, Buffer.alloc((512 - (d.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
};
const zip = (entries: [string, string | Buffer][], deflate = false) => {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, data] of entries) {
    const d = Buffer.from(data), c = deflate ? deflateRawSync(d) : d, n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(deflate ? 8 : 0, 8); l.writeUInt32LE(crc32(d), 14); l.writeUInt32LE(c.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(deflate ? 8 : 0, 10); h.writeUInt32LE(crc32(d), 16); h.writeUInt32LE(c.length, 20); h.writeUInt32LE(d.length, 24); h.writeUInt16LE(n.length, 28); h.writeUInt32LE(off, 42);
    locals.push(l, n, c); central.push(h, n); off += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
};
const inp = (name: string, data: string | Buffer) => ({ name, data: new Uint8Array(Buffer.from(data)) });
const status = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof UploadError ? e.status : e; } return 0; };
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

test('upload: the two model files, flat or inside a tar / zip (stored or deflated), are verified and stored atomically', async () => {
  for (const make of [
    () => [inp('tokenizer.json', 'tok-bytes'), inp('model_quint8.onnx', 'model-bytes!')],
    () => [inp('m.tar', tar([['gliner/tokenizer.json', 'tok-bytes'], ['gliner/onnx/model_quint8.onnx', 'model-bytes!'], ['gliner/onnx/', ''], ['._tokenizer.json', 'apple junk']]))],
    () => [inp('m.zip', zip([['tokenizer.json', 'tok-bytes'], ['onnx/model_quint8.onnx', 'model-bytes!'], ['__MACOSX/x', 'junk']]))],
    () => [inp('m.zip', zip([['tokenizer.json', 'tok-bytes'], ['onnx/model_quint8.onnx', 'model-bytes!']], true))],
  ]) {
    const dir = tmp('up');
    assert.deepEqual(saveModelFiles(dir, make(), FILES).sort(), ['onnx/model_quint8.onnx', 'tokenizer.json']);
    assert.deepEqual(await verifyModel(dir, FILES), { ok: true });
    assert.deepEqual(listing(dir), ['onnx', 'onnx/model_quint8.onnx', 'tokenizer.json']); // no temp leftovers
  }
});

test('upload: wrong content, wrong size, unknown or duplicate files are rejected and nothing is written', () => {
  const dir = tmp('up-bad');
  assert.equal(status(() => saveModelFiles(dir, [inp('tokenizer.json', 'tok-BYTES')], FILES)), 400); // same size, other hash
  assert.equal(status(() => saveModelFiles(dir, [inp('tokenizer.json', 'tok')], FILES)), 400); // size
  assert.equal(status(() => saveModelFiles(dir, [inp('tokenizer.json', 'tok-bytes'), inp('evil.sh', 'rm -rf /')], FILES)), 400); // good + unknown: all or nothing
  assert.equal(status(() => saveModelFiles(dir, [inp('tokenizer.json', 'tok-bytes'), inp('x/tokenizer.json', 'tok-bytes')], FILES)), 400);
  assert.equal(status(() => saveModelFiles(dir, [inp('m.tar', tar([['tokenizer.json', 'tok-bytes'], ['README.md', 'hi']]))], FILES)), 400);
  assert.equal(status(() => saveModelFiles(dir, [], FILES)), 400);
  assert.equal(status(() => saveModelFiles(dir, [inp('m.zip', Buffer.from('not a zip'))], FILES)), 400);
  assert.deepEqual(listing(dir), []);
});

test('upload: path traversal is impossible (rejected names; the destination never comes from the upload)', () => {
  const dir = tmp('up-trav'), outside = join(dir, '..', 'hefyn-pwned');
  for (const name of ['../hefyn-pwned', '../../tokenizer.json', '/etc/tokenizer.json', 'a/../../tokenizer.json', 'C:\\tokenizer.json', '..\\tokenizer.json']) {
    assert.equal(status(() => saveModelFiles(dir, [inp(name, 'tok-bytes')], FILES)), 400, name);
    assert.equal(status(() => saveModelFiles(dir, [inp('m.tar', tar([[name, 'tok-bytes']]))], FILES)), 400, `tar ${name}`);
    assert.equal(status(() => saveModelFiles(dir, [inp('m.zip', zip([[name, 'tok-bytes']]))], FILES)), 400, `zip ${name}`);
  }
  assert.ok(!existsSync(outside));
  assert.deepEqual(listing(dir), []);
  // a harmless-looking name still lands only at the pinned path
  saveModelFiles(dir, [inp('whatever/dir/tokenizer.json', 'tok-bytes')], FILES);
  assert.deepEqual(listing(dir), ['tokenizer.json']);
});

test('upload: oversize files and zip bombs are rejected', () => {
  const dir = tmp('up-big');
  assert.equal(status(() => saveModelFiles(dir, [inp('tokenizer.json', Buffer.alloc(FILES[0].size + 1, 1))], FILES)), 400);
  const bomb = zip([['tokenizer.json', Buffer.alloc(120 * 1024 * 1024, 0)]], true); // deflates to ~120 KB, far above the largest model file
  assert.ok(bomb.length < 2_000_000);
  assert.equal(status(() => saveModelFiles(dir, [inp('b.zip', bomb)])), 400); // pinned list: 82 MB limit
  assert.deepEqual(listing(dir), []);
  assert.ok(GLINER_FILES.length === 2);
});

test('licence: NOTICE and the Apache-2.0 text are written next to the files; an upload may include them (verified) but never needs them', async () => {
  const dir = tmp('notice');
  writeNotice(dir);
  assert.match(readFileSync(join(dir, 'NOTICE.txt'), 'utf8'), /knowledgator\/gliner-pii-small-v1\.0[\s\S]*revision d21aad5[\s\S]*Wordcab and Knowledgator[\s\S]*Apache License 2\.0/);
  assert.match(readFileSync(join(dir, 'LICENSE-Apache-2.0.txt'), 'utf8'), /Apache License\s+Version 2\.0, January 2004/);
  const up = tmp('notice-up');
  assert.deepEqual(saveModelFiles(up, [inp('NOTICE.txt', NOTICE_FILES['NOTICE.txt']), inp('LICENSE-Apache-2.0.txt', NOTICE_FILES['LICENSE-Apache-2.0.txt'])]).sort(), ['LICENSE-Apache-2.0.txt', 'NOTICE.txt']);
  assert.equal(status(() => saveModelFiles(up, [inp('NOTICE.txt', 'tampered')])), 400);
  assert.deepEqual((await verifyModel(up)).ok, false); // still needs the model files; the notice files are not part of the requirement
});
