import type { EditorState, Transaction } from '@codemirror/state';

export interface Range { from: number; to: number }

/**
 * Enter on an empty top-level list item ("- " or "1. ") ends the list: the marker goes and a blank line follows, so the next text is a plain paragraph.
 * (lang-markdown's own command first turns the list loose and keeps the marker.) Anything else falls through to its command.
 */
export function exitEmptyItem({ state, dispatch }: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const r = state.selection.main, line = state.doc.lineAt(r.head);
  if (!r.empty || r.head !== line.to || !/^([-*+]|\d{1,9}[.)])\s*$/.test(line.text)) return false;
  dispatch(state.update({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, userEvent: 'input' }));
  return true;
}

/**
 * Live markdown hides its markup characters except where the caret is: a mark stays visible when its line shares a line with any selection.
 * `lineAt` gives the line span of a position. Returns only the marks to hide.
 */
export function hiddenMarks(marks: Range[], selections: Range[], lineAt: (pos: number) => Range): Range[] {
  const spans = selections.map((s) => ({ from: lineAt(s.from).from, to: lineAt(s.to).to }));
  return marks.filter((m) => !spans.some((s) => m.from <= s.to && m.to >= s.from));
}
