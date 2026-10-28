import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinFrontmatter, splitFrontmatter, visualUnsafe } from '../web/src/components/md-frontmatter.ts';

test('splits a leading frontmatter block and joins it back verbatim', () => {
  const src = '---\nname: x\ndescription: y\n---\n# Title\n\n---\nnot front\n';
  const { frontmatter, body } = splitFrontmatter(src);
  assert.equal(frontmatter, '---\nname: x\ndescription: y\n---\n');
  assert.equal(body, '# Title\n\n---\nnot front\n');
  assert.equal(joinFrontmatter(frontmatter, body), src);
});

test('leaves documents without frontmatter alone', () => {
  for (const s of ['', '# Hi\n', 'text\n---\na\n---\n', '---\nunterminated\n']) assert.deepEqual(splitFrontmatter(s), { frontmatter: '', body: s });
});

test('handles CRLF and an empty body', () => {
  const src = '---\r\na: 1\r\n---';
  assert.deepEqual(splitFrontmatter(src), { frontmatter: src, body: '' });
});

test('visualUnsafe flags what the visual editor would lose', () => {
  for (const s of ['<details><summary>More</summary>x</details>\n', 'a<br>b\n', '<div class="x">\nhi\n</div>\n', 'a <!-- note --> b\n', 'Foot[^1].\n\n[^1]: The source.\n', 'See [x][id].\n\n[id]: https://e.com\n', '~~~\ncode\n~~~\n<b>x</b>\n']) assert.ok(visualUnsafe(s), s);
});

test('visualUnsafe lets code, autolinks and plain documents through', () => {
  for (const s of ['```html\n<details>\n[^1]\n```\n', '````\n```\n<div>\n````\n', 'use `<br>` and ``<b>``\n', 'see <https://example.com> or <me@x.com>\n', '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n', 'a [link](https://e.com) and [text]\n', '']) assert.equal(visualUnsafe(s), undefined, s);
});
