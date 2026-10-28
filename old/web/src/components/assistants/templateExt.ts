import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, tooltips, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { badRefs, suggest, type Upstream } from './flow';

// CodeMirror pieces for template fields ({{node.field}}): each reference is one token (red wavy underline when no earlier step has that id), and typing `{{` offers the values of earlier steps.
const ok = Decoration.mark({ class: 'cm-ref' });
const bad = (id: string) => Decoration.mark({ class: 'cm-ref cm-ref-bad', attributes: { title: `No earlier step called “${id}”` } });

function build(view: EditorView, ids: string[]): DecorationSet {
  const text = view.state.doc.toString(), b = new RangeSetBuilder<Decoration>();
  const wrong = new Map(badRefs(text, ids).map((x) => [x.from, x]));
  for (const m of text.matchAll(/\{\{[^{}\n]*\}\}/g)) { const w = wrong.get(m.index!); b.add(m.index!, m.index! + m[0].length, w ? bad(w.id) : ok); }
  return b.finish();
}

export const templateTheme = EditorView.theme({
  '.cm-ref': { backgroundColor: 'color-mix(in oklab, var(--ring) 18%, transparent)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '0.9em', padding: '1px 2px' },
  '.cm-ref-bad': { backgroundColor: 'color-mix(in oklab, var(--danger) 14%, transparent)', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-completionDetail': { marginLeft: '1em', opacity: 0.6, fontStyle: 'normal' },
  '.cm-completionLabel': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  // the app's UI font for the list (only the reference token stays mono), kept inside the editor's width
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxWidth: 'min(360px, calc(100vw - 32px))' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', display: 'flex', alignItems: 'baseline', overflow: 'hidden' },
  '.cm-completionLabel, .cm-completionDetail': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/** Reference tokens plus `{{` suggestions. `refs` is read on every keystroke, so it may change while the editor is open. */
export function templateExtensions(getRefs: () => Upstream[] | undefined): Extension[] {
  const source = (ctx: CompletionContext) => {
    const refs = getRefs();
    if (!refs) return null;
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 80), ctx.pos), r = suggest(refs, before);
    if (!r || (!r.options.length && !ctx.explicit)) return null;
    return {
      from: ctx.pos - (before.length - r.from), validFor: /^[\w.]*$/,
      options: r.options.map((o) => ({
        label: o.label, displayLabel: o.display, detail: o.detail, type: 'variable',
        // close the braces unless they are already there; the caret ends after them
        apply: (v: EditorView, _c: unknown, from: number, to: number) => {
          const closed = v.state.sliceDoc(to, to + 2) === '}}';
          v.dispatch({ changes: { from, to, insert: closed ? o.label : `${o.label}}}` }, selection: { anchor: from + o.label.length + 2 }, userEvent: 'input.complete' });
        },
      })),
    };
  };
  return [
    templateTheme,
    autocompletion({ override: [source], icons: false }),
    tooltips({ position: 'fixed' }), // fixed: CodeMirror keeps it inside the viewport instead of the panel clipping it
    ViewPlugin.fromClass(class {
      deco: DecorationSet;
      constructor(v: EditorView) { this.deco = build(v, (getRefs() ?? []).map((u) => u.id)); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.deco = build(u.view, (getRefs() ?? []).map((x) => x.id)); }
    }, { decorations: (p) => p.deco }),
  ];
}
