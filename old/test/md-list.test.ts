import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { exitEmptyItem } from '../web/src/components/assistants/mdHide.ts';

// the editor's Enter: our list exit first, then lang-markdown's continue-markup
const enter = (s: EditorState) => {
  ensureSyntaxTree(s, s.doc.length, 1000);
  let out = s;
  const d = { state: s, dispatch: (tr: any) => { out = tr.state; } };
  exitEmptyItem(d) || insertNewlineContinueMarkup(d);
  return out;
};
const start = (doc: string) => EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown()] });
const type = (s: EditorState, text: string) => s.update({ changes: { from: s.selection.main.head, insert: text }, selection: { anchor: s.selection.main.head + text.length } }).state;

test('Enter, Enter on a list item ends the list', () => {
  let s = enter(start('- a'));
  assert.equal(s.doc.toString(), '- a\n- ');
  s = enter(start(s.doc.toString()));
  assert.equal(type(s, 'b').doc.toString(), '- a\n\nb');
});
test('Enter on an empty numbered item ends the list too', () => {
  assert.equal(enter(start('1. a\n2. ')).doc.toString(), '1. a\n\n');
});
test('Backspace after the marker removes it first', () => {
  const s = start('- a\n- ');
  ensureSyntaxTree(s, s.doc.length, 1000);
  let out = s;
  deleteMarkupBackward({ state: s, dispatch: (tr) => { out = tr.state; } });
  assert.equal(out.doc.toString(), '- a\n  '); // marker gone; a second Backspace removes the indent
});
