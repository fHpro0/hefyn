import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'hefyn-forget-'));
const { forgetInAll, setActive, setAll } = await import('../src/modules/active.ts');

test('deletions reach switched-off modules; a never-migrated module (no table) is skipped, other errors stop the delete', () => {
  const seen: string[] = [];
  const on = { id: 'on', name: 'On', onUserDelete: (u: string) => void seen.push(`on:${u}`) };
  const off = { id: 'off', name: 'Off', optional: true, onUserDelete: (u: string) => void seen.push(`off:${u}`) };
  const fresh = { id: 'fresh', name: 'Fresh', onUserDelete: () => { throw new Error('no such table: fresh_rows'); } };
  setActive([on]); // "off" is switched off: not active, but still installed
  setAll([on, off, fresh]);
  forgetInAll((m) => m.onUserDelete?.('u1'));
  assert.deepEqual(seen, ['on:u1', 'off:u1']);
  setAll([{ id: 'broken', name: 'Broken', onUserDelete: () => { throw new Error('disk I/O error'); } }]);
  assert.throws(() => forgetInAll((m) => m.onUserDelete?.('u1')), /disk I\/O error/);
});
