import assert from 'node:assert/strict';
import { test } from 'node:test';
import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Folder, Presentation } from 'lucide-react';
import { kindOf } from '../web/src/components/file-kind.ts';

test('kindOf maps names to icon, label and preview', () => {
  assert.equal(kindOf('x', true).icon, Folder);
  assert.equal(kindOf('a.PNG').icon, FileImage);
  assert.equal(kindOf('a.png').mime, 'image/png');
  assert.equal(kindOf('a.svg').mime, 'image/svg+xml');
  assert.deepEqual([kindOf('n.md').icon === FileText, kindOf('n.md').label, kindOf('n.md').preview], [true, 'Markdown', 'markdown']);
  assert.equal(kindOf('a.ts').icon, FileCode);
  assert.equal(kindOf('a.html').preview, 'code'); // never rendered
  assert.equal(kindOf('a.csv').icon, FileSpreadsheet);
  assert.equal(kindOf('a.xlsx').preview, 'none');
  assert.equal(kindOf('a.key').icon, Presentation);
  assert.equal(kindOf('a.tar').icon, FileArchive);
  assert.equal(kindOf('noext').icon, File);
  assert.equal(kindOf('.env').label, 'Config');
  assert.equal(kindOf('a.weird').label, 'WEIRD file');
});
