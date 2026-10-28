import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newCode, parseArgs, serverUrl, showCode } from '../device/cli.ts';

test('device cli: codes use the 32-character alphabet, urls must be https or local', () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(showCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(serverUrl('https://hefyn.example/x'), 'https://hefyn.example');
  assert.equal(serverUrl('http://localhost:8788'), 'http://localhost:8788');
  assert.equal(serverUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  assert.equal(serverUrl('http://[::1]:8788'), 'http://[::1]:8788');
  for (const bad of ['http://hefyn.example', 'http://localhost.evil.com', 'ftp://localhost', 'nope']) assert.throws(() => serverUrl(bad), bad);
});

test('device cli: argv', () => {
  const u = 'http://localhost:4422';
  assert.deepEqual(parseArgs(['pair', u]).arg, u);
  assert.deepEqual(parseArgs(['pair', u, '--name', 'X']), { cmd: 'pair', arg: u, name: 'X' });
  assert.deepEqual(parseArgs(['pair', '--name', 'X', u]), { cmd: 'pair', arg: u, name: 'X' });
  assert.deepEqual(parseArgs(['status']).arg, undefined);
  assert.equal(parseArgs(['status']).cmd, 'status');
});
