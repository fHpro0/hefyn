import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { linter, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import type { Upstream } from './flow';
import { liveMarkdown } from './liveMarkdown';
import { templateExtensions } from './templateExt';

// The real code editor (CodeMirror 6). Loaded lazily by CodeEditor users, so none of this is in the main bundle.
// Colours come from the app's CSS variables; only the syntax palette needs a light and a dark set, switched when <html class="dark"> changes.
const palette = (dark: boolean) => HighlightStyle.define(dark ? [
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: '#c4b5fd' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#86efac' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#fdba74' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#a1a1aa', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.variableName), t.function(t.propertyName)], color: '#93c5fd' },
  { tag: [t.typeName, t.className, t.propertyName], color: '#67e8f9' },
  { tag: t.invalid, color: '#fca5a5' },
] : [
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: '#7c3aed' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#15803d' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b45309' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#71717a', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.variableName), t.function(t.propertyName)], color: '#1d4ed8' },
  { tag: [t.typeName, t.className, t.propertyName], color: '#0e7490' },
  { tag: t.invalid, color: '#b91c1c' },
]);

const base = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'var(--background)', fontSize: '12.5px', height: '100%' },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted-foreground)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in oklab, var(--ring) 28%, transparent)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--ring) 25%, transparent)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul': { fontFamily: 'var(--font-mono)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-textfield': { backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: '6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--muted)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--foreground)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--warning) 35%, transparent)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

/** Syntax errors as squiggles: every error node of the parse tree. */
const syntaxLint = linter((view): Diagnostic[] => {
  const out: Diagnostic[] = [];
  syntaxTree(view.state).iterate({ enter: (n) => { if (n.type.isError && out.length < 20) out.push({ from: n.from, to: Math.max(n.to, Math.min(n.from + 1, view.state.doc.length)), severity: 'error', message: 'This does not look right here (syntax error).' }); } });
  return out;
}, { delay: 300 });

const isDark = () => document.documentElement.classList.contains('dark');

// Writing mode (long text fields, not code): wrapped prose without line numbers; "template" also marks {{node.field}} as tokens.
const prose = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', fontSize: '14px', lineHeight: '1.7', padding: '6px 4px' },
  '.cm-gutters': { display: 'none' }, '.cm-activeLine': { backgroundColor: 'transparent' },
});
// no bracket matching or auto-closing in prose: `{{` must stay plain text (the template tokens and suggestions are in templateExt)
const proseSetup = [history(), drawSelection(), keymap.of([...defaultKeymap, ...historyKeymap])];
const isProse = (l: string) => l === 'template' || l === 'text' || l === 'text-mono';
// every prose field is live markdown, except one-line fields (values, names) where `*` and `_` are just characters
const lang = (l: string, getRefs: () => Upstream[] | undefined, singleLine?: boolean) => {
  const md = singleLine ? [] : [markdown(), liveMarkdown];
  if (l === 'python') return [python()];
  // Prec.high: the code theme's mono font would otherwise win over the prose font
  if (l === 'template') return [EditorView.lineWrapping, Prec.high(prose), ...md, ...templateExtensions(getRefs)];
  if (l === 'text') return [EditorView.lineWrapping, Prec.high(prose), ...md];
  if (l === 'text-mono') return [EditorView.lineWrapping, ...md];
  return [javascript(), syntaxLint]; // Python: highlighting only
};
// grows with its text up to 60% of the screen, then scrolls: the textarea look of the inline fields
const grow = EditorView.theme({ '&': { height: 'auto', maxHeight: '60vh' }, '.cm-scroller': { overflow: 'auto' } });
const oneLine = EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.newDoc.lines > 1 ? [] : tr));

export interface CodeMirrorProps {
  value: string; onChange: (v: string) => void; language: string; readOnly?: boolean; onRun?: () => void; label: string; placeholder?: string; viewRef?: { current: EditorView | null }; autoFocus?: boolean;
  /** Template mode: the steps `{{…}}` may name (suggestions, red underline for others). */
  refs?: Upstream[];
  /** Inline field: textarea look and auto height (`minHeight` in rem); `singleLine` refuses line breaks. */
  inline?: { minRem: number; singleLine?: boolean };
}

export default function CodeMirror({ value, onChange, language, readOnly, onRun, label, placeholder, viewRef, autoFocus, refs, inline }: CodeMirrorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const cb = useRef({ onChange, onRun, refs });
  cb.current = { onChange, onRun, refs };
  const getRefs = () => cb.current.refs;
  const langC = useRef(new Compartment()), themeC = useRef(new Compartment()), roC = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          isProse(language) ? proseSetup : basicSetup, base,
          keymap.of([{ key: 'Mod-Enter', run: () => { cb.current.onRun?.(); return !!cb.current.onRun; } }, ...(isProse(language) ? [] : [indentWithTab])]),
          ...(inline ? [grow] : []), ...(inline?.singleLine ? [oneLine] : []),
          langC.current.of(lang(language, getRefs, inline?.singleLine)), themeC.current.of(syntaxHighlighting(palette(isDark()))), roC.current.of(EditorState.readOnly.of(!!readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          ...(placeholder ? [placeholderExt(placeholder)] : []),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    if (viewRef) viewRef.current = v;
    // follow theme switches without rebuilding the editor
    const mo = new MutationObserver(() => v.dispatch({ effects: themeC.current.reconfigure(syntaxHighlighting(palette(isDark()))) }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    if (autoFocus) v.focus(); // the large writing view takes the caret; inline editors must not steal it
    return () => { mo.disconnect(); v.destroy(); view.current = null; if (viewRef) viewRef.current = null; };
  }, []);

  useEffect(() => { view.current?.dispatch({ effects: langC.current.reconfigure(lang(language, getRefs, inline?.singleLine)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: roC.current.reconfigure(EditorState.readOnly.of(!!readOnly)) }); }, [readOnly]);
  // an outside change (a starter inserted, an undo of the whole document) replaces the text; typing already matches
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  if (inline) return <div ref={host} style={{ minHeight: `${inline.minRem}rem` }} className="w-full min-w-0 cursor-text overflow-hidden rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30" />;
  return <div ref={host} className="h-full min-h-0 w-full min-w-0 overflow-hidden rounded-md border border-border" />;
}
