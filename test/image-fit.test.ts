import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitSize } from '../web/src/components/image-fit.ts';

test('fitSize scales the long side and keeps the aspect', () => {
  assert.deepEqual(fitSize(4000, 2000, 1000), { width: 1000, height: 500, scaled: true });
  assert.deepEqual(fitSize(1000, 3000, 1500), { width: 500, height: 1500, scaled: true });
});

test('fitSize never upscales', () => {
  assert.deepEqual(fitSize(800, 600, 2000), { width: 800, height: 600, scaled: false });
});
