import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSI, ANSI_BG, contrast } from '../web/src/components/cli-palette.ts';

test('terminal palette: all 16 ANSI colours reach 4.5:1 on their mode', () => {
  assert.ok(contrast('#000000', '#ffffff') > 20.9); // the formula itself
  for (const mode of ['light', 'dark'] as const) {
    assert.equal(Object.keys(ANSI[mode]).length, 16);
    for (const [name, hex] of Object.entries(ANSI[mode])) assert.ok(contrast(hex, ANSI_BG[mode]) >= 4.5, `${mode} ${name} ${hex}: ${contrast(hex, ANSI_BG[mode]).toFixed(2)}`);
  }
});
