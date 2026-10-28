import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatLine, filesLine, insertMention, liveMentions, matches, mentionAt, parseCommand, pastedName, slashAt, splitContext, tokenOf, uploading, withContext, type Mention } from '../web/src/components/composer-text.ts';

test('slashAt: only at the start, until the first space', () => {
  assert.deepEqual(slashAt('/ren', 4), { q: 'ren' });
  assert.deepEqual(slashAt('/', 1), { q: '' });
  assert.equal(slashAt('hi /', 4), undefined);
  assert.equal(slashAt('/rename x', 9), undefined);
  assert.equal(slashAt('/etc/hosts', 10), undefined);
});

test('parseCommand and filtering', () => {
  assert.deepEqual(parseCommand('/rename New title'), { name: 'rename', arg: 'New title' });
  assert.equal(parseCommand(' /pin'), undefined);
  assert.equal(parseCommand('/etc/hosts is a file'), undefined);
  assert.deepEqual(matches([{ name: 'compact' }, { name: 'rename' }], 'MP').map((c) => c.name), ['compact']);
});

test('mentionAt: at the start or after whitespace', () => {
  assert.deepEqual(mentionAt('see @no', 7), { start: 4, q: 'no' });
  assert.deepEqual(mentionAt('@', 1), { start: 0, q: '' });
  assert.equal(mentionAt('mail@x', 6), undefined);
  assert.equal(mentionAt('@a b', 4), undefined);
});

test('mention tokens: insert, quote, drop when deleted', () => {
  const f: Mention = { t: 'file', i: '/files/notes.md', n: 'notes.md' }, c: Mention = { t: 'chat', i: 'u_x_1', n: 'Q3 summary' };
  assert.equal(tokenOf(f), '@notes.md');
  assert.equal(tokenOf(c), '@"Q3 summary"');
  const a = insertMention('look at @no please', { start: 8 }, 11, f);
  assert.equal(a.text, 'look at @notes.md  please');
  assert.equal(a.text.slice(0, a.pos), 'look at @notes.md ');
  const t = `compare ${tokenOf(c)} with ${tokenOf(f)}`;
  assert.deepEqual(liveMentions(t, [f, c, f]), [f, c]); // once each
  assert.deepEqual(liveMentions('compare with', [f, c]), []);
  assert.deepEqual(liveMentions(`compare ${tokenOf(c)}`, [f, c]), [c]);
});

test('context block: built, hidden again, chips back', () => {
  const lines = [filesLine(['/files/notes.md', '/files/Uploads/x.csv']), chatLine('Q3 "summary"', '/tmp/hefyn-linked/q3-summary.md')];
  const sent = withContext('compare these', lines);
  assert.match(sent, /\n\n--- context ---\nFiles: \/files\/notes\.md, \/files\/Uploads\/x\.csv\nLinked chat "Q3 'summary'": \/tmp\/hefyn-linked\/q3-summary\.md \(read it for context\)$/);
  assert.deepEqual(splitContext(sent), { text: 'compare these', chips: [{ t: 'file', n: 'notes.md' }, { t: 'file', n: 'x.csv' }, { t: 'chat', n: "Q3 'summary'" }] });
  assert.equal(withContext('plain', []), 'plain');
  assert.deepEqual(splitContext('plain'), { text: 'plain', chips: [] });
});

test('uploads: screenshot names and the busy state', () => {
  const d = new Date(2026, 9, 28, 14, 5);
  assert.equal(pastedName('image.png', 'image/png', d), 'Screenshot 2026-10-28 14.05.png');
  assert.equal(pastedName('', 'image/jpeg', d), 'Screenshot 2026-10-28 14.05.jpg');
  assert.equal(pastedName('report.pdf', 'application/pdf', d), 'report.pdf');
  const file = new File(['x'], 'a.txt');
  assert.equal(uploading([{ id: 1, file, frac: 0.5 }]), true);
  assert.equal(uploading([{ id: 1, file, frac: 1, mention: { t: 'file', i: '/files/Uploads/a.txt', n: 'a.txt' } }, { id: 2, file, frac: 0, error: 'x' }]), false);
});
