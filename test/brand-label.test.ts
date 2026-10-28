import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandHome, hasBrand } from '../web/src/components/brand-label.ts';

test('brand label', () => {
  assert.equal(hasBrand(null), false);
  assert.equal(hasBrand({ name: '', logo: null, logoDark: null }), false);
  assert.equal(hasBrand({ name: '', logo: 'data:x', logoDark: null }), true);
  assert.equal(brandHome(undefined), 'hefyn home');
  assert.equal(brandHome({ name: 'Test Co.', logo: null, logoDark: null }), 'hefyn × Test Co. home');
  assert.equal(brandHome({ name: '', logo: 'data:x', logoDark: null }), 'hefyn home');
});
