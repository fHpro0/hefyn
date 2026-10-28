import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConflictCopy, plainError, splitForm, statusLine, summarySentence, type ConnField } from '../web/src/components/conn-helpers.ts';

const F: ConnField[] = [
  { name: 'host', label: 'Host', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number' },
  { name: 'password', label: 'Password', type: 'secret' }, { name: 'key', label: 'Key', type: 'secret' },
];
const S = { downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, errors: [], capped: [] };

test('splitForm: secrets apart, blanks dropped, numbers typed', () => {
  assert.deepEqual(splitForm(F, { host: 'h', port: '22', password: 'pw', key: '' }), { config: { host: 'h', port: 22 }, secrets: { password: 'pw' } });
  assert.deepEqual(splitForm(F, { host: 'h', port: ' ' }), { config: { host: 'h' }, secrets: {} });
});

test('summarySentence', () => {
  assert.equal(summarySentence({ ...S, downloaded: 12, uploaded: 3, conflicts: 1 }), 'Downloaded 12 files, uploaded 3, 1 conflict — kept both copies');
  assert.equal(summarySentence({ ...S, uploaded: 1 }), 'Uploaded 1 file');
  assert.equal(summarySentence(S), 'Everything was already up to date');
});

test('plainError, statusLine, isConflictCopy', () => {
  assert.match(plainError('x. Set HEFYN_ALLOW_PRIVATE_URLS=1.'), /private network/);
  assert.match(plainError('plain FTP ... HEFYN_ALLOW_PLAIN_FTP=1.'), /unencrypted FTP/);
  const c = { syncing: false, status: 'ok' as const, lastSyncAt: 'x', lastError: null };
  assert.equal(statusLine(c, () => '3 min ago'), 'Synced 3 min ago');
  assert.equal(statusLine({ ...c, syncing: true }, () => ''), 'Syncing…');
  assert.equal(statusLine({ ...c, status: 'error', lastError: 'login failed' }, () => ''), 'Error: login failed');
  assert.ok(isConflictCopy('a (conflict 2026-10-28 1200).txt') && !isConflictCopy('a.txt'));
});
