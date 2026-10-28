import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const rawPrepare = DatabaseSync.prototype.prepare; // before flue-vault patches it: the test's own view of flue.db stays raw
const raw = (d: DatabaseSync, sql: string) => rawPrepare.call(d, sql);
process.env.HEFYN_SECRET = 'flue-vault-test-secret-flue-vault-test-1234';
const dir = mkdtempSync(join(tmpdir(), 'hefyn-flue-vault-'));
process.env.HEFYN_DATA_DIR = dir;
const path = join(dir, 'flue.db');

const vault = await import('../src/server/vault.ts');
const fv = await import('../src/server/flue-vault.ts');
const { createAttachmentRef, createSessionStorageKey } = await import('@flue/runtime/adapter');

const SECRET = 'Project Falcon';
const kA = vault.newKey(), kB = vault.newKey();
vault.rememberUserKey('alice', Buffer.from(kA));
vault.rememberUserKey('bob', Buffer.from(kB));

const adapter = fv.vaultedSqlite(path);
await adapter.migrate!();
const stores = await adapter.connect();
const convA = 'u_alice_01HZZ', convA2 = 'u_alice_01HYY', convB = 'u_bob_01HZZ';
const streamA = `agents/configurable/${convA}`;
const input = (id: string, conv: string, body: string) => ({ kind: 'direct' as const, submissionId: id, agent: 'configurable', id: conv, message: { kind: 'user' as const, body }, acceptedAt: new Date().toISOString() });
const rawRows = (sql: string) => { const d = new DatabaseSync(path); try { return raw(d, sql).all(); } finally { d.close(); } };
const everything = () => {
  const d = new DatabaseSync(path);
  try {
    const tables = (raw(d, "SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    return tables.map((t) => JSON.stringify(raw(d, `SELECT * FROM ${t}`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))).join('\n');
  } finally { d.close(); }
};

test('userOfFlueKey: paths, session keys and conversation ids map to their user; anything else to none', () => {
  assert.equal(fv.userOfFlueKey('agents/configurable/u_alice_01HZZ'), 'alice');
  assert.equal(fv.userOfFlueKey('u_bob-2_01HZZ'), 'bob-2');
  assert.equal(fv.userOfFlueKey(createSessionStorageKey('configurable', 'u_alice_01HZZ', 'default', 'default')), 'alice');
  assert.equal(fv.userOfFlueKey(createSessionStorageKey('configurable', 'anonymous', 'u_alice_01HZZ', 'u_alice_01HZZ')), undefined);
  assert.equal(fv.userOfFlueKey('agents/configurable/anonymous'), undefined);
  assert.equal(fv.userOfFlueKey('agents/configurable/x/u_alice_01HZZ'), undefined);
  assert.equal(fv.userOfFlueKey(undefined), undefined);
});

test('round trip through the real sqlite adapter: payload, settlement, stream, spill, checkpoint, attachment; nothing readable at rest', async () => {
  // submission
  const in1 = input('s1', convA, `plan ${SECRET}`);
  const sub = await stores.submissionStore.admitDirect(in1);
  assert.equal((sub.input.message as any).body, `plan ${SECRET}`);
  assert.equal(((await stores.submissionStore.getSubmission('s1'))!.input.message as any).body, `plan ${SECRET}`);
  assert.ok((await stores.submissionStore.admitDirect(in1)).submissionId); // exact replay stays idempotent
  await stores.submissionStore.markSubmissionCanonicalReady('s1');
  assert.equal((await stores.submissionStore.listRunnableSubmissions()).length, 1);
  const attempt = { submissionId: 's1', attemptId: 'a1' };
  assert.ok(await stores.submissionStore.claimSubmission({ ...attempt, ownerId: 'o', leaseExpiresAt: Date.now() + 60_000 }));
  const record = { v: 1, id: 'settle1', type: 'submission_settled', submissionId: 's1', outcome: 'failed', error: { message: SECRET }, timestamp: new Date().toISOString() } as any;
  const ob = await stores.submissionStore.reserveSubmissionSettlement(attempt, { recordId: 'settle1', record });
  assert.deepEqual(ob!.record, record);
  assert.ok(await stores.submissionStore.reserveSubmissionSettlement(attempt, { recordId: 'settle1', record })); // retry matches inside SQL
  assert.deepEqual((await stores.submissionStore.listPendingSubmissionSettlements())[0]!.record, record);

  // stream: small batch and a >1 MiB one that spills into chunk rows
  await stores.conversationStreamStore.createStream(streamA, { agentName: 'configurable', instanceId: convA });
  const claim = await stores.conversationStreamStore.acquireProducer(streamA, 'p1');
  const small = [{ v: 1, id: 'r1', type: 'x', timestamp: 't', text: `hello ${SECRET}` }] as any[];
  const big = [{ v: 1, id: 'r2', type: 'x', timestamp: 't', text: `${SECRET} `.repeat(150_000) }] as any[];
  const at = (seq: number, records: any[]) => stores.conversationStreamStore.append({ path: streamA, producerId: 'p1', producerEpoch: claim.producerEpoch, incarnation: claim.incarnation, producerSequence: seq, records });
  await at(0, small); await at(1, big);
  const read = await stores.conversationStreamStore.read(streamA);
  assert.deepEqual(read.batches.map((b) => b.records), [small, big]);
  assert.ok(rawRows('SELECT 1 FROM flue_conversation_stream_batch_chunks').length > 1);

  // fold checkpoint (plain and spilled)
  await stores.conversationStreamStore.putFoldCheckpoint!(streamA, { offset: '0', incarnation: claim.incarnation, formatVersion: 1, data: `state ${SECRET}` });
  assert.equal((await stores.conversationStreamStore.getFoldCheckpoint!(streamA))!.data, `state ${SECRET}`);
  const bigData = `${SECRET} `.repeat(200_000);
  await stores.conversationStreamStore.putFoldCheckpoint!(streamA, { offset: '1', incarnation: claim.incarnation, formatVersion: 1, data: bigData });
  assert.equal((await stores.conversationStreamStore.getFoldCheckpoint!(streamA))!.data, bigData);

  // attachment (> one 512 KiB chunk)
  const bytes = new Uint8Array(600_000).fill(65); bytes.set(Buffer.from(SECRET));
  const ref = await createAttachmentRef({ id: 'att1', mimeType: 'text/plain', bytes });
  await stores.attachmentStore.put({ streamPath: streamA, attachment: ref, bytes, conversationId: convA });
  const got = await stores.attachmentStore.get({ streamPath: streamA, conversationId: convA, attachmentId: 'att1' });
  assert.deepEqual(Buffer.from(got!.bytes), Buffer.from(bytes));

  const raw = everything();
  assert.ok(raw.includes('"u_alice_01HZZ"') || raw.includes('u_alice_01HZZ')); // ids stay readable
  for (const t of rawRows("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]) {
    const dump = JSON.stringify(rawRows(`SELECT * FROM ${t.name}`), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    assert.ok(!dump.includes('Falcon'), `marker found in ${t.name}: ${dump.slice(0, 1500)}`);
  }
  assert.ok(!raw.includes('Falcon'));
});

test('locked user: writes and reads throw LockedError; list queries skip them; other users are unaffected', async () => {
  const subB = await stores.submissionStore.admitDirect(input('s2', convB, 'bob secret'));
  await stores.submissionStore.markSubmissionCanonicalReady(subB.submissionId);
  await stores.submissionStore.admitDirect(input('s3', convA2, 'second'));
  await stores.submissionStore.markSubmissionCanonicalReady('s3');
  vault.forgetUserKey('alice');
  await assert.rejects(stores.submissionStore.admitDirect(input('s4', convA, 'x')), (e: any) => e instanceof vault.LockedError && /locked/.test(e.message));
  await assert.rejects(stores.submissionStore.getSubmission('s1'), vault.LockedError);
  await assert.rejects(stores.conversationStreamStore.read(streamA), vault.LockedError);
  await assert.rejects(stores.attachmentStore.get({ streamPath: streamA, conversationId: convA, attachmentId: 'att1' }), vault.LockedError);
  await assert.rejects(stores.conversationStreamStore.append({ path: streamA, producerId: 'p1', producerEpoch: 1, incarnation: 'x', producerSequence: 9, records: [{ id: 'z' } as any] }));
  assert.deepEqual((await stores.submissionStore.listRunnableSubmissions()).map((s) => s.submissionId), ['s2']); // alice's queued s3 stays pending, bob's runs
  assert.deepEqual((await stores.submissionStore.listPendingSubmissionSettlements()), []);
  assert.equal(rawRows("SELECT status FROM flue_agent_submissions WHERE submission_id = 's3'")[0]!.status, 'queued');
  vault.rememberUserKey('alice', Buffer.from(kA));
  assert.deepEqual((await stores.submissionStore.listRunnableSubmissions()).map((s) => s.submissionId).sort(), ['s2', 's3']);
  assert.equal((await stores.conversationStreamStore.read(streamA)).batches.length, 2);
});

test("another user's key cannot open the data; legacy plaintext rows still read", async () => {
  vault.rememberUserKey('alice', Buffer.from(kB)); // wrong key
  await assert.rejects(stores.conversationStreamStore.read(streamA));
  vault.rememberUserKey('alice', Buffer.from(kA));
  // a row written before encryption
  const plain = JSON.stringify([{ v: 1, id: 'legacy', type: 'x', timestamp: 't', text: 'old plaintext' }]);
  const d = new DatabaseSync(path);
  raw(d, "INSERT INTO flue_conversation_stream_batches (path, seq, producer_id, producer_epoch, producer_sequence, data) VALUES (?, 2, 'p0', 0, 0, ?)").run(streamA, plain);
  raw(d, 'UPDATE flue_conversation_streams SET next_offset = 3 WHERE path = ?').run(streamA);
  d.close();
  const r = await stores.conversationStreamStore.read(streamA);
  assert.equal((r.batches[2]!.records[0] as any).text, 'old plaintext');
  // copied ciphertext does not open in another place (AAD binds path + seq)
  const d2 = new DatabaseSync(path);
  const sealed = (raw(d2, 'SELECT data FROM flue_conversation_stream_batches WHERE seq = 0').get() as any).data;
  raw(d2, 'UPDATE flue_conversation_stream_batches SET data = ? WHERE seq = 2').run(sealed);
  d2.close();
  await assert.rejects(stores.conversationStreamStore.read(streamA));
});

test('purgeUserFlueData removes one user only', async () => {
  fv.purgeUserFlueData('alice', path);
  assert.equal(rawRows('SELECT 1 FROM flue_conversation_streams').length, 0);
  assert.equal(rawRows('SELECT 1 FROM flue_conversation_stream_batches').length, 0);
  assert.equal(rawRows('SELECT 1 FROM flue_attachment_chunks').length, 0);
  assert.deepEqual(rawRows('SELECT submission_id FROM flue_agent_submissions').map((r: any) => r.submission_id), ['s2']);
});

test('agent key transport: keys are stored per conversation owner and stripped before the handler (Flue) sees the request', async () => {
  const { Hono } = await import('hono');
  const app = new Hono();
  app.use('/agents/*', fv.acceptKeys);
  app.post('/agents/configurable/:id', async (c) => c.json({ headers: [...c.req.raw.headers.keys()], body: await c.req.text() }));
  const k = vault.newKey(), t = vault.newKey();
  const res = await app.request('/agents/configurable/u_carol_01HZZ', { method: 'POST', body: 'hi', headers: { 'x-keep': '1', 'x-hefyn-user-key': k.toString('base64'), 'x-hefyn-team-key': t.toString('base64') } });
  const seen = await res.json() as { headers: string[]; body: string };
  assert.equal(seen.body, 'hi');
  assert.ok(!seen.headers.some((h) => h.includes('key')));
  assert.deepEqual(vault.userKey('carol'), k);
  assert.deepEqual(vault.getTeamKey(), t);
  await app.request('/agents/configurable/u_dave_01HZZ', { method: 'POST', headers: { 'x-hefyn-user-key': 'AAAA' } }); // malformed key: ignored
  assert.equal(vault.userKey('dave'), undefined);
});

test('error column is sealed (fail, joined fan-out) and opens again', async () => {
  vault.rememberUserKey('erin', Buffer.from(vault.newKey()));
  const c = 'u_erin_01HZZ';
  const a = input('e1', c, 'x');
  await stores.submissionStore.admitDirect(a);
  await stores.submissionStore.markSubmissionCanonicalReady('e1');
  const at = { submissionId: 'e1', attemptId: 'ea' };
  await stores.submissionStore.claimSubmission({ ...at, ownerId: 'o', leaseExpiresAt: Date.now() + 60_000 });
  assert.ok(await stores.submissionStore.failSubmission(at, new Error(`boom ${SECRET}`)));
  assert.equal((await stores.submissionStore.getSubmission('e1'))!.error, `boom ${SECRET}`);
  const dump = JSON.stringify(rawRows("SELECT error FROM flue_agent_submissions WHERE submission_id = 'e1'"));
  assert.ok(dump.includes('hx1:') && !dump.includes('Falcon'));
});

test('migrateUserFlueData: legacy plaintext rows are sealed once, idempotently, and still read back', async () => {
  const mdir = mkdtempSync(join(tmpdir(), 'hefyn-flue-mig-'));
  const mpath = join(mdir, 'flue.db');
  const ad = fv.vaultedSqlite(mpath); await ad.migrate!(); const st = await ad.connect();
  const conv = 'u_mia_01HZZ', sp = `agents/configurable/${conv}`;
  const sk = createSessionStorageKey('configurable', conv, 'default', 'default');
  const payload = JSON.stringify({ kind: 'direct', submissionId: 'm1', agent: 'configurable', id: conv, message: { kind: 'user', body: `legacy ${SECRET}` }, acceptedAt: '2026-01-01T00:00:00.000Z' });
  const rec = { v: 1, id: 'r', type: 'x', timestamp: 't', text: `legacy ${SECRET}` };
  const ref = await createAttachmentRef({ id: 'a', mimeType: 'text/plain', bytes: Buffer.from(SECRET) });
  const d = new DatabaseSync(mpath);
  const run = (sql: string, ...a: any[]) => raw(d, sql).run(...a);
  run("INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at, settled_at, error) VALUES ('m1', ?, 'direct', ?, 'settled', ?, 1, ?)", sk, payload, Date.parse('2026-01-01T00:00:00.000Z'), `failed ${SECRET}`);
  run('INSERT INTO flue_conversation_streams (path, identity_json, next_offset, incarnation) VALUES (?, ?, 1, ?)', sp, JSON.stringify({ agentName: 'configurable', instanceId: conv }), 'inc');
  run("INSERT INTO flue_conversation_stream_batches (path, seq, producer_id, producer_epoch, producer_sequence, data) VALUES (?, 0, 'p', 1, 0, ?)", sp, JSON.stringify([rec]));
  run('INSERT INTO flue_conversation_fold_checkpoints (path, head_offset, incarnation, format_version, data) VALUES (?, ?, ?, 1, ?)', sp, '0', 'inc', `fold ${SECRET}`);
  run("INSERT INTO flue_attachments (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count, created_at) VALUES (?, 'a', 'text/plain', ?, ?, ?, 1, 1)", sp, ref.size, ref.digest, conv);
  run("INSERT INTO flue_attachment_chunks (stream_path, attachment_id, chunk_index, bytes) VALUES (?, 'a', 0, ?)", sp, Buffer.from(SECRET));
  d.close();
  const scan = () => { const x = new DatabaseSync(mpath); try { return (raw(x, "SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => JSON.stringify(raw(x, `SELECT * FROM ${t.name}`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))).join(''); } finally { x.close(); } };
  assert.ok(scan().includes('Falcon'));
  vault.forgetUserKey('mia');
  assert.throws(() => fv.migrateUserFlueData('mia', mpath), vault.LockedError);
  vault.rememberUserKey('mia', Buffer.from(vault.newKey()));
  assert.equal(fv.migrateUserFlueData('mia', mpath), 5);
  assert.ok(!scan().includes('Falcon'));
  assert.equal(fv.migrateUserFlueData('mia', mpath), 0); // idempotent
  assert.equal(((await st.submissionStore.getSubmission('m1'))!.input.message as any).body, `legacy ${SECRET}`);
  assert.equal((await st.submissionStore.getSubmission('m1'))!.error, `failed ${SECRET}`);
  assert.deepEqual((await st.conversationStreamStore.read(sp)).batches[0]!.records, [rec]);
  assert.equal((await st.conversationStreamStore.getFoldCheckpoint!(sp))!.data, `fold ${SECRET}`);
  assert.equal(Buffer.from((await st.attachmentStore.get({ streamPath: sp, conversationId: conv, attachmentId: 'a' }))!.bytes).toString(), SECRET);
});

test('schema guard: an unclassified column or table stops startup', async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'hefyn-flue-schema-'));
  const spath = join(sdir, 'flue.db');
  await fv.vaultedSqlite(spath).migrate!(); // the stock schema passes
  const d = new DatabaseSync(spath);
  raw(d, 'ALTER TABLE flue_agent_submissions ADD COLUMN notes TEXT').run();
  d.close();
  await assert.rejects(fv.vaultedSqlite(spath).migrate!(), /Flue schema changed: flue_agent_submissions\.notes is not classified; refusing to start/);
  const d2 = new DatabaseSync(spath);
  raw(d2, 'ALTER TABLE flue_agent_submissions DROP COLUMN notes').run();
  raw(d2, 'CREATE TABLE flue_new_thing (x TEXT)').run();
  d2.close();
  await assert.rejects(fv.vaultedSqlite(spath).migrate!(), /Flue schema changed: flue_new_thing is not classified/);
});

test('a corrupt row of one user does not stall the submission lists of others; strict users refuse unsealed values', async () => {
  vault.rememberUserKey('fay', Buffer.from(vault.newKey()));
  vault.rememberUserKey('gus', Buffer.from(vault.newKey()));
  for (const [id, conv] of [['f1', 'u_fay_01HZZ'], ['g1', 'u_gus_01HZZ']] as const) {
    await stores.submissionStore.admitDirect(input(id, conv, 'hello'));
    await stores.submissionStore.markSubmissionCanonicalReady(id);
  }
  const d = new DatabaseSync(path);
  const row = raw(d, "SELECT payload FROM flue_agent_submissions WHERE submission_id = 'f1'").get() as any;
  raw(d, "UPDATE flue_agent_submissions SET payload = ? WHERE submission_id = 'f1'").run(row.payload.slice(0, -4) + 'AAAA'); // corrupted ciphertext
  d.close();
  const ids = () => stores.submissionStore.listRunnableSubmissions().then((l) => l.map((s) => s.submissionId));
  const had = console.error; console.error = () => {};
  try { assert.ok((await ids()).includes('g1') && !(await ids()).includes('f1')); } finally { console.error = had; }
  await assert.rejects(stores.submissionStore.getSubmission('f1')); // point reads still throw
  // downgrade: a plaintext payload written under a strict user is refused (skipped in lists, thrown on point reads)
  const d2 = new DatabaseSync(path);
  raw(d2, "UPDATE flue_agent_submissions SET payload = '{}' WHERE submission_id = 'g1'").run();
  d2.close();
  vault.markStrictUser('gus');
  console.error = () => {};
  try { assert.ok(!(await ids()).includes('g1')); } finally { console.error = had; }
  await assert.rejects(stores.submissionStore.getSubmission('g1'), vault.DowngradeError);
});

test('fold checkpoint is bound to its offset: an old checkpoint replayed under a new head does not open', async () => {
  vault.rememberUserKey('hal', Buffer.from(vault.newKey()));
  const p = 'agents/configurable/u_hal_01HZZ';
  await stores.conversationStreamStore.createStream(p, { agentName: 'configurable', instanceId: 'u_hal_01HZZ' });
  await stores.conversationStreamStore.putFoldCheckpoint!(p, { offset: '5', incarnation: 'i', formatVersion: 1, data: 'old' });
  const d = new DatabaseSync(path);
  raw(d, "UPDATE flue_conversation_fold_checkpoints SET head_offset = '9' WHERE path = ?").run(p);
  d.close();
  await assert.rejects(stores.conversationStreamStore.getFoldCheckpoint!(p));
});

// ---- regressions: ciphertext reaching Flue / values sealed twice (dev hot reload stacked a second patch on the first) ----
const batchTable = 'CREATE TABLE flue_conversation_stream_batches (path TEXT, seq INTEGER, producer_id TEXT, producer_epoch INTEGER, producer_sequence INTEGER, data TEXT, submission_id TEXT, attempt_id TEXT)';
const insertBatch = 'INSERT INTO flue_conversation_stream_batches (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const batchArgs = (data: string, seq = 0) => ['agents/configurable/u_dan_01HZZ', seq, 'p', 1, seq, data, null, null] as const;

test('re-evaluating the module (dev hot reload) does not stack a second patch: one seal layer, old and new instances both read it', async () => {
  const before = DatabaseSync.prototype.prepare;
  const fv2 = (await import('../src/server/flue-vault.ts?reload=1' as string)) as typeof fv; // a second module instance, as after a Vite SSR reload
  assert.notEqual(fv2, fv);
  const a2 = fv2.vaultedSqlite(path);
  assert.equal(DatabaseSync.prototype.prepare, before); // same installed function, nothing layered on top
  const s2 = await a2.connect();
  vault.rememberUserKey('carol', Buffer.from(vault.newKey()));
  const conv = 'u_carol_01HZZ', p = `agents/configurable/${conv}`;
  await s2.conversationStreamStore.createStream(p, { agentName: 'configurable', instanceId: conv });
  const claim = await s2.conversationStreamStore.acquireProducer(p, 'p1');
  const records = [{ v: 1, id: 'r1', type: 'x', timestamp: 't', text: `hello ${SECRET}` }] as any[];
  await s2.conversationStreamStore.append({ path: p, producerId: 'p1', producerEpoch: claim.producerEpoch, incarnation: claim.incarnation, producerSequence: 0, records });
  const data = (rawRows(`SELECT data FROM flue_conversation_stream_batches WHERE path = '${p}'`)[0] as any).data as string;
  const once = vault.open(vault.userKey('carol')!, data, `flue:batch:${p}:0`).toString('utf8');
  assert.ok(!vault.isSealed(once), 'sealed twice'); // one layer: the plaintext JSON comes out
  assert.deepEqual((await stores.conversationStreamStore.read(p)).batches[0]!.records, records);
  assert.deepEqual((await s2.conversationStreamStore.read(p)).batches[0]!.records, records);
});

test('connections are guarded whatever the open order or path form: classified before guard(), symlinked path', async () => {
  const d2 = join(dir, 'late'); const { mkdirSync, symlinkSync } = await import('node:fs'); mkdirSync(d2);
  const late = join(d2, 'flue.db');
  const early = new DatabaseSync(late);
  early.exec(batchTable);
  early.prepare('SELECT 1').get(); // classified here, while the path is not guarded yet
  fv.vaultedSqlite(late); // guarded afterwards
  vault.rememberUserKey('dan', Buffer.from(vault.newKey()));
  early.prepare(insertBatch).run(...batchArgs('[{"x":1}]'));
  const sealed = (raw(early, 'SELECT data FROM flue_conversation_stream_batches').get() as any).data as string;
  assert.ok(vault.isSealed(sealed));
  assert.equal((early.prepare('SELECT seq, data FROM flue_conversation_stream_batches WHERE path = ?').get('agents/configurable/u_dan_01HZZ') as any).data, '[{"x":1}]');
  early.close();
  const link = join(d2, 'link.db'); symlinkSync(late, link);
  const viaLink = new DatabaseSync(link);
  viaLink.prepare(insertBatch).run(...batchArgs('second', 1));
  assert.ok(vault.isSealed((raw(viaLink, "SELECT data FROM flue_conversation_stream_batches WHERE data NOT LIKE '[%'").get() as any).data));
  viaLink.close();
  vault.forgetUserKey('dan'); // no key: the write is refused, never stored in clear
  const again = new DatabaseSync(late);
  assert.throws(() => again.prepare(insertBatch).run(...batchArgs('third', 2)), vault.LockedError);
  assert.throws(() => again.prepare('SELECT seq, data FROM flue_conversation_stream_batches WHERE path = ?').all('agents/configurable/u_dan_01HZZ'), vault.LockedError);
  again.close();
});

test('background reads without a key (stream, spilled batch, fold checkpoint) throw LockedError, never hand ciphertext to Flue', async () => {
  vault.rememberUserKey('ivy', Buffer.from(vault.newKey()));
  const conv = 'u_ivy_01HZZ', p = `agents/configurable/${conv}`;
  await stores.conversationStreamStore.createStream(p, { agentName: 'configurable', instanceId: conv });
  const claim = await stores.conversationStreamStore.acquireProducer(p, 'p1');
  const big = [{ v: 1, id: 'r2', type: 'x', timestamp: 't', text: `${SECRET} `.repeat(150_000) }] as any[];
  await stores.conversationStreamStore.append({ path: p, producerId: 'p1', producerEpoch: claim.producerEpoch, incarnation: claim.incarnation, producerSequence: 0, records: big });
  await stores.conversationStreamStore.putFoldCheckpoint!(p, { offset: '0', incarnation: claim.incarnation, formatVersion: 1, data: `${SECRET} `.repeat(200_000) });
  vault.forgetUserKey('ivy');
  await assert.rejects(stores.conversationStreamStore.read(p), vault.LockedError);
  await assert.rejects(stores.conversationStreamStore.getFoldCheckpoint!(p), vault.LockedError);
});

test('repairDoubleSealedFlueData: unwraps the outer layer of a row sealed twice, leaves single-sealed rows alone', async () => {
  const k = vault.newKey();
  vault.rememberUserKey('jay', Buffer.from(k));
  const conv = 'u_jay_01HZZ', p = `agents/configurable/${conv}`;
  await stores.conversationStreamStore.createStream(p, { agentName: 'configurable', instanceId: conv });
  const claim = await stores.conversationStreamStore.acquireProducer(p, 'p1');
  const at = (seq: number, records: any[]) => stores.conversationStreamStore.append({ path: p, producerId: 'p1', producerEpoch: claim.producerEpoch, incarnation: claim.incarnation, producerSequence: seq, records });
  const r0 = [{ v: 1, id: 'a', type: 'x', timestamp: 't', text: 'one' }] as any[], r1 = [{ v: 1, id: 'b', type: 'x', timestamp: 't', text: 'two' }] as any[];
  await at(0, r0); await at(1, r1);
  const d = new DatabaseSync(path);
  const row = raw(d, 'SELECT data FROM flue_conversation_stream_batches WHERE path = ? AND seq = 1').get(p) as any;
  raw(d, 'UPDATE flue_conversation_stream_batches SET data = ? WHERE path = ? AND seq = 1').run(vault.seal(k, vault.seal(k, row.data, `flue:batch:${p}:1`), `flue:batch:${p}:1`), p); // three layers: two stacked reloads
  d.close();
  await assert.rejects(stores.conversationStreamStore.read(p), SyntaxError); // the symptom: ciphertext reaches JSON.parse
  assert.deepEqual(fv.repairDoubleSealedFlueData('jay', path), { repaired: 2, skipped: 0, failed: 0 });
  assert.deepEqual((await stores.conversationStreamStore.read(p)).batches.map((b) => b.records), [r0, r1]);
  assert.deepEqual(fv.repairDoubleSealedFlueData('jay', path), { repaired: 0, skipped: 0, failed: 0 });
  assert.ok(vault.isSealed((rawRows(`SELECT data FROM flue_conversation_stream_batches WHERE path = '${p}' AND seq = 1`)[0] as any).data));
});

test('repairDoubleSealedFlueData: submission + blob rows, other users untouched, "hx1:" plaintext skipped, unreadable row counted', async () => {
  const k = vault.newKey(), kl = vault.newKey();
  vault.rememberUserKey('kim', Buffer.from(k));
  vault.rememberUserKey('lee', Buffer.from(kl));
  const conv = 'u_kim_01HZZ', p = `agents/configurable/${conv}`;
  const sub = await stores.submissionStore.admitDirect(input('k1', conv, `kim ${SECRET}`));
  await stores.conversationStreamStore.createStream(p, { agentName: 'configurable', instanceId: conv });
  const claim = await stores.conversationStreamStore.acquireProducer(p, 'p1');
  const rec = (id: string) => [{ v: 1, id, type: 'x', timestamp: 't', text: id }] as any[];
  for (const [i, id] of ['a', 'b', 'c'].entries()) await stores.conversationStreamStore.append({ path: p, producerId: 'p1', producerEpoch: claim.producerEpoch, incarnation: claim.incarnation, producerSequence: i, records: rec(id) });
  const bytes = Buffer.from(`blob ${SECRET}`), tricky = Buffer.from('hx1:this is a user file that merely starts like a seal');
  await stores.attachmentStore.put({ streamPath: p, attachment: await createAttachmentRef({ id: 'att-a', mimeType: 'text/plain', bytes }), bytes, conversationId: conv });
  await stores.attachmentStore.put({ streamPath: p, attachment: await createAttachmentRef({ id: 'att-t', mimeType: 'text/plain', bytes: tricky }), bytes: tricky, conversationId: conv });
  // lee: a double-sealed batch that the repair for kim must not touch
  const pl = 'agents/configurable/u_lee_01HZZ';
  await stores.conversationStreamStore.createStream(pl, { agentName: 'configurable', instanceId: 'u_lee_01HZZ' });
  const cl = await stores.conversationStreamStore.acquireProducer(pl, 'p1');
  await stores.conversationStreamStore.append({ path: pl, producerId: 'p1', producerEpoch: cl.producerEpoch, incarnation: cl.incarnation, producerSequence: 0, records: rec('l') });

  const d = new DatabaseSync(path);
  const one = (sql: string, ...a: any[]) => raw(d, sql).get(...a) as any;
  const set = (sql: string, ...a: any[]) => raw(d, sql).run(...a);
  const lee = one('SELECT data FROM flue_conversation_stream_batches WHERE path = ?', pl).data as string;
  set('UPDATE flue_conversation_stream_batches SET data = ? WHERE path = ?', vault.seal(kl, lee, `flue:batch:${pl}:0`), pl);
  const leeBefore = one('SELECT data FROM flue_conversation_stream_batches WHERE path = ?', pl).data;
  // kim: submission (payload, error, deterministic settlement) sealed twice
  const sid = sub.submissionId;
  const pay = one('SELECT payload FROM flue_agent_submissions WHERE submission_id = ?', sid).payload as string;
  const errAad = `flue:suberr:${sid}`, setAad = `flue:sub:${sid}:settlement`, payAad = `flue:sub:${sid}:payload`;
  set('UPDATE flue_agent_submissions SET payload = ?, error = ?, settlement_record = ? WHERE submission_id = ?', vault.seal(k, pay, payAad),
    vault.seal(k, vault.seal(k, 'boom', errAad), errAad), vault.seal(k, vault.seal(k, '{"x":1}', setAad), setAad), sid);
  // kim: blob chunk sealed twice
  const att = one("SELECT bytes, chunk_index FROM flue_attachment_chunks WHERE attachment_id = 'att-a'");
  const attAad = `flue:att:${p}:att-a:${att.chunk_index}`;
  set("UPDATE flue_attachment_chunks SET bytes = ? WHERE attachment_id = 'att-a'", Buffer.from(vault.seal(k, Buffer.from(att.bytes), attAad)));
  const trickyBefore = Buffer.from(one("SELECT bytes FROM flue_attachment_chunks WHERE attachment_id = 'att-t'").bytes).toString('latin1');
  // kim: batch 1 sealed twice, batch 2 corrupt
  const b1 = one('SELECT data FROM flue_conversation_stream_batches WHERE path = ? AND seq = 1', p).data as string;
  set('UPDATE flue_conversation_stream_batches SET data = ? WHERE path = ? AND seq = 1', vault.seal(k, b1, `flue:batch:${p}:1`), p);
  set("UPDATE flue_conversation_stream_batches SET data = 'hx1:AAAAcorrupt' WHERE path = ? AND seq = 2", p);
  d.close();

  // payload + error + settlement + blob + batch 1 repaired; the false positive skipped; the corrupt batch failed; nothing aborted
  assert.deepEqual(fv.repairDoubleSealedFlueData('kim', path), { repaired: 5, skipped: 1, failed: 1 });
  assert.equal(((await stores.submissionStore.getSubmission(sid))!.input.message as any).body, `kim ${SECRET}`);
  const e = new DatabaseSync(path);
  const row = raw(e, 'SELECT error, settlement_record FROM flue_agent_submissions WHERE submission_id = ?').get(sid) as any;
  assert.equal(vault.open(k, row.error, errAad).toString(), 'boom');
  assert.equal(vault.open(k, row.settlement_record, setAad).toString(), '{"x":1}');
  assert.equal(Buffer.from((raw(e, "SELECT bytes FROM flue_attachment_chunks WHERE attachment_id = 'att-t'").get() as any).bytes).toString('latin1'), trickyBefore);
  assert.equal((raw(e, 'SELECT data FROM flue_conversation_stream_batches WHERE path = ?').get(pl) as any).data, leeBefore);
  e.close();
  assert.deepEqual((await stores.conversationStreamStore.read(p, { limit: 1 })).batches.map((b) => b.records), [rec('a')]);
  assert.deepEqual(Buffer.from((await stores.attachmentStore.get({ streamPath: p, conversationId: conv, attachmentId: 'att-a' }))!.bytes), bytes);
  assert.deepEqual(fv.repairDoubleSealedFlueData('lee', path), { repaired: 1, skipped: 0, failed: 0 });
});

test('a reload swaps the whole prepare decision (not just the wrapper): the installed function routes through the latest handle', async () => {
  const G = (globalThis as any)[Symbol.for('hefyn.flue-vault')];
  const seen: string[] = [];
  const stale = G.handle;
  G.handle = (_db: any, stmt: any, q: string) => { seen.push(q); return stmt; }; // stands in for an older module with a smaller SENSITIVE set
  const d = new DatabaseSync(':memory:');
  d.prepare('SELECT 1').get();
  assert.deepEqual(seen, ['SELECT 1']);
  G.handle = stale;
  await import('../src/server/flue-vault.ts?reload=2' as string); // a re-evaluation installs its own handle
  assert.notEqual(G.handle, stale);
  d.prepare('SELECT 2').get();
  assert.deepEqual(seen, ['SELECT 1']); // the stand-in is gone: the new handle decides
  d.close();
});
