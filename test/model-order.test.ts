import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byRecency } from '../web/src/components/model-order.ts';

const sorted = (ids: string[]) => [...ids].sort(byRecency);

test('model ids sort newest first', () => {
  assert.deepEqual(sorted(['claude-opus-4-5-20251101', 'claude-opus-4-8', 'claude-opus-5-5']), ['claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-5-20251101']);
  assert.deepEqual(sorted(['gpt-4', 'gpt-4o', 'gpt-4.1', 'gpt-5']), ['gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4']);
  assert.deepEqual(sorted(['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-haiku-5-5']), ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(sorted(['p/gpt-4o-2024-05-13', 'p/gpt-4o-2024-08-06', 'p/gpt-4o']), ['p/gpt-4o', 'p/gpt-4o-2024-08-06', 'p/gpt-4o-2024-05-13']);
  assert.deepEqual(sorted(['o1', 'o3-mini']), ['o3-mini', 'o1']);
});
