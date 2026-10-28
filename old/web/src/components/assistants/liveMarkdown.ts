import { syntaxTree } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { exitEmptyItem, hiddenMarks, type Range } from './mdHide';

// Live markdown (Obsidian/Typora style): one field, the markup renders as you type and its characters are hidden except on the caret's line.
// Read-only editors have no caret line, so they show the rendered text only.
class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-md-bullet'; s.textContent = '•'; return s; }
}
const bullet = Decoration.replace({ widget: new Bullet() });
const hide = Decoration.replace({});
const line = (c: string) => Decoration.line({ class: c });
const mark = (c: string) => Decoration.mark({ class: c });

const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'CodeInfo', 'URL']);
const MARK_CLASS: Record<string, string> = { Emphasis: 'cm-md-em', StrongEmphasis: 'cm-md-strong', InlineCode: 'cm-md-code', Link: 'cm-md-link', Strikethrough: 'cm-md-del' };

function build(view: EditorView): DecorationSet {
  const { state } = view, doc = state.doc;
  const out: { from: number; to: number; d: Decoration }[] = [];
  const hideable: Range[] = [], bullets: Range[] = [];
  const lineClass = (pos: number, c: string) => out.push({ from: doc.lineAt(pos).from, to: doc.lineAt(pos).from, d: line(c) });
  for (const r of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: r.from, to: r.to,
      enter: (n) => {
        const name = n.name;
        if (/^ATXHeading[1-6]$/.test(name)) lineClass(n.from, `cm-md-h${name.at(-1)}`);
        else if (name === 'Blockquote') for (let p = n.from; p <= n.to; p = doc.lineAt(p).to + 1) { lineClass(p, 'cm-md-quote'); if (doc.lineAt(p).to >= n.to) break; }
        else if (name === 'FencedCode') for (let p = n.from; p <= n.to; p = doc.lineAt(p).to + 1) { lineClass(p, 'cm-md-fence'); if (doc.lineAt(p).to >= n.to) break; }
        else if (MARK_CLASS[name]) out.push({ from: n.from, to: n.to, d: mark(MARK_CLASS[name]) });
        else if (name === 'ListMark') {
          const t = doc.sliceString(n.from, n.to);
          if (/^[-*+]$/.test(t)) bullets.push({ from: n.from, to: n.to }); else out.push({ from: n.from, to: n.to, d: mark('cm-md-num') });
        } else if (MARKS.has(name) && !(name === 'URL' && n.node.parent?.name !== 'Link')) {
          // a heading or quote marker takes the space after it along
          const to = (name === 'HeaderMark' || name === 'QuoteMark') && doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to;
          hideable.push({ from: n.from, to });
        }
      },
    });
  }
  const sel = state.readOnly ? [] : state.selection.ranges.map((s) => ({ from: s.from, to: s.to }));
  const lineAt = (p: number) => { const l = doc.lineAt(p); return { from: l.from, to: l.to }; };
  for (const m of hiddenMarks(hideable, sel, lineAt)) out.push({ ...m, d: hide });
  for (const m of hiddenMarks(bullets, sel, lineAt)) out.push({ ...m, d: bullet });
  return Decoration.set(out.map((x) => x.d.range(x.from, x.to)), true);
}

const theme = EditorView.theme({
  '.cm-md-h1': { fontSize: '1.7em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-md-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.35' },
  '.cm-md-h3': { fontSize: '1.2em', fontWeight: '600' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '1.05em', fontWeight: '600' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-del': { textDecoration: 'line-through' },
  '.cm-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.9em', backgroundColor: 'var(--muted)', borderRadius: '4px', padding: '1px 3px' },
  '.cm-md-link': { color: 'var(--primary)', textDecoration: 'underline' },
  '.cm-md-quote': { borderLeft: '3px solid var(--border)', paddingLeft: '10px !important', color: 'var(--muted-foreground)' },
  '.cm-md-fence': { fontFamily: 'var(--font-mono)', fontSize: '0.9em', backgroundColor: 'var(--muted)' },
  '.cm-md-bullet': { display: 'inline-block', width: '1.1em', textAlign: 'center' },
  '.cm-md-num': { color: 'var(--muted-foreground)' },
});

export const liveMarkdown: Extension = [theme, Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyItem }])), ViewPlugin.fromClass(class {
  deco: DecorationSet;
  constructor(v: EditorView) { this.deco = build(v); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.state.readOnly !== u.startState.readOnly || syntaxTree(u.state) !== syntaxTree(u.startState)) this.deco = build(u.view); }
}, { decorations: (p) => p.deco })];
