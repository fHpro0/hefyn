import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-kernel-'));
process.env.HEFYN_SECRET = 'kernel-test-secret-kernel-test-secret-1';
process.env.HEFYN_MODULES_DISABLED = 'off';

const { bootCheck, createKernel, loadModules, modulePlugin } = await import('../src/kernel/index.ts');
const { PERMISSIONS } = await import('../src/server/permissions.ts');

const mod = (id: string, extra: object = {}) => ({ id, name: id, ...extra });

test('a module loads and contributes; dispose takes it back and stops its jobs', async () => {
  const k = createKernel();
  let ran = 0, migrated = 0;
  const [f] = loadModules(k, [mod('kt', { permissions: [{ id: 'kt.use', label: 'Use' }], migrate: () => void migrated++, jobs: [{ name: 'tick', everyMs: 5, first: 1, run: () => void ran++ }] })]);
  await bootCheck(k);
  assert.deepEqual(k.modules.list().map((m) => m.id), ['kt']);
  assert.equal(migrated, 1);
  assert.ok(PERMISSIONS.includes('kt.use'));
  assert.deepEqual(k.modules.startJobs(), ['kt.tick']);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ran > 0);
  await f.dispose();
  assert.deepEqual(k.modules.list(), []);
  assert.ok(!PERMISSIONS.includes('kt.use'));
  const seen = ran;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, seen);
});

test('a switched-off optional module is never loaded', async () => {
  const k = createKernel();
  loadModules(k, [mod('on'), mod('off', { optional: true })]);
  await bootCheck(k);
  assert.deepEqual(k.modules.list().map((m) => m.id), ['on']);
});

test('the boot check names a plugin and its missing service', async () => {
  const k = createKernel();
  k.plugin({ name: 'needy', inject: ['nope'], apply() {} } as any);
  await assert.rejects(bootCheck(k), /plugin "needy" did not start: missing service\(s\) nope/);
  const k2 = createKernel();
  k2.plugin({ name: 'broken', apply() { throw new Error('boom'); } } as any).then(undefined, () => {});
  await assert.rejects(bootCheck(k2), /plugin "broken" failed to start/);
});

test('two kernels in one process are independent', async () => {
  const a = createKernel(), b = createKernel();
  a.plugin(modulePlugin(mod('only-a')));
  await bootCheck(a);
  await bootCheck(b);
  assert.deepEqual(a.modules.list().map((m) => m.id), ['only-a']);
  assert.deepEqual(b.modules.list(), []);
});
