import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenMarks } from '../web/src/components/assistants/mdHide.ts';

// "# a\nbold **b**" : line 0 = 0..3, line 1 = 4..14
const doc = '# a\nbold **b**';
const lineAt = (p: number) => (p <= 3 ? { from: 0, to: 3 } : { from: 4, to: doc.length });
const marks = [{ from: 0, to: 2 }, { from: 9, to: 11 }, { from: 12, to: 14 }];

test('marks on the caret line stay visible, the others hide', () => {
  assert.deepEqual(hiddenMarks(marks, [{ from: 1, to: 1 }], lineAt), [{ from: 9, to: 11 }, { from: 12, to: 14 }]);
  assert.deepEqual(hiddenMarks(marks, [{ from: 6, to: 6 }], lineAt), [{ from: 0, to: 2 }]);
});
test('a selection across lines reveals both; no selection hides all', () => {
  assert.deepEqual(hiddenMarks(marks, [{ from: 1, to: 6 }], lineAt), []);
  assert.deepEqual(hiddenMarks(marks, [], lineAt), marks);
});
