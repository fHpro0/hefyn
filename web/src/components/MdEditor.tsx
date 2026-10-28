import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Code2, Heading1, Heading2, Heading3, Italic, Link, List, ListOrdered, Quote, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { joinFrontmatter, splitFrontmatter } from './md-frontmatter';
import { Hint } from './Shell';

// Same look as the rendered preview (md-impl.tsx), expressed as descendant selectors on ProseMirror's DOM.
const PROSE = 'min-h-[40vh] px-5 py-4 outline-none [&_p]:my-3 [&_p:first-child]:mt-0 [&_a]:underline [&_a]:underline-offset-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li::marker]:text-muted-foreground '
  + '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1 [&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:gap-2 [&_ul[data-type=taskList]_li>label]:mt-0.5 [&_ul[data-type=taskList]_li>div]:grow '
  + '[&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:font-semibold '
  + '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground '
  + '[&_code]:rounded-md [&_code]:bg-foreground/[0.07] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] '
  + '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-foreground/[0.05] [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre_code]:bg-transparent [&_pre_code]:p-0 '
  + '[&_table]:my-3 [&_table]:w-full [&_table]:text-sm [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 '
  + '[&_hr]:my-4 [&_hr]:border-border';

export default function MdEditor({ value, onChange, label, onSave, autoFocus }: { value: string; onChange: (markdown: string) => void; label: string; onSave?: () => void; autoFocus?: boolean }) {
  const init = splitFrontmatter(value);
  const [front, setFront] = useState(init.frontmatter);
  const frontRef = useRef(init.frontmatter);
  const last = useRef(value); // what we last emitted: our own echo must not reset the editor
  const save = useRef(onSave); save.current = onSave;
  const emit = useRef(onChange); emit.current = onChange;

  const editor = useEditor({
    extensions: [StarterKit.configure({ underline: false }), Markdown, TableKit, TaskList, TaskItem.configure({ nested: true })],
    content: init.body, contentType: 'markdown', autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', class: PROSE },
      handleKeyDown: (_v, e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save.current?.(); return true; } return false; },
    },
    onUpdate: ({ editor }) => { const md = joinFrontmatter(frontRef.current, editor.getMarkdown()); last.current = md; emit.current(md); },
  });

  useEffect(() => {
    if (!editor || value === last.current) return;
    const s = splitFrontmatter(value);
    last.current = value; frontRef.current = s.frontmatter; setFront(s.frontmatter);
    editor.commands.setContent(s.body, { contentType: 'markdown', emitUpdate: false });
  }, [value, editor]);

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => e && ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), code: e.isActive('code'), h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      ul: e.isActive('bulletList'), ol: e.isActive('orderedList'), quote: e.isActive('blockquote'), block: e.isActive('codeBlock'), link: e.isActive('link'), undo: e.can().undo(), redo: e.can().redo(),
    }),
  });

  if (!editor || !st) return null;
  const run = () => editor.chain().focus();
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (empty removes the link)', prev ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') run().extendMarkRange('link').unsetLink().run();
    else run().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const btn = (name: string, icon: React.ReactNode, onClick: () => void, pressed?: boolean, disabled?: boolean) => (
    <Hint label={name}><Button type="button" variant="ghost" size="icon" aria-label={name} aria-pressed={pressed} disabled={disabled} onClick={onClick} className={pressed ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}>{icon}</Button></Hint>
  );
  const i = { size: 16, 'aria-hidden': true } as const;
  return (
    <div className="flex min-h-full flex-col">
      <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-0.5 border-b bg-popover px-2 py-1">
        {btn('Bold', <Bold {...i} />, () => run().toggleBold().run(), st.bold)}
        {btn('Italic', <Italic {...i} />, () => run().toggleItalic().run(), st.italic)}
        {btn('Inline code', <Code {...i} />, () => run().toggleCode().run(), st.code)}
        {btn('Heading 1', <Heading1 {...i} />, () => run().toggleHeading({ level: 1 }).run(), st.h1)}
        {btn('Heading 2', <Heading2 {...i} />, () => run().toggleHeading({ level: 2 }).run(), st.h2)}
        {btn('Heading 3', <Heading3 {...i} />, () => run().toggleHeading({ level: 3 }).run(), st.h3)}
        {btn('Bullet list', <List {...i} />, () => run().toggleBulletList().run(), st.ul)}
        {btn('Numbered list', <ListOrdered {...i} />, () => run().toggleOrderedList().run(), st.ol)}
        {btn('Quote', <Quote {...i} />, () => run().toggleBlockquote().run(), st.quote)}
        {btn('Code block', <Code2 {...i} />, () => run().toggleCodeBlock().run(), st.block)}
        {btn('Link', <Link {...i} />, setLink, st.link)}
        {btn('Undo', <Undo2 {...i} />, () => run().undo().run(), undefined, !st.undo)}
        {btn('Redo', <Redo2 {...i} />, () => run().redo().run(), undefined, !st.redo)}
      </div>
      {front && <label className="block border-b px-4 py-2 text-xs text-muted-foreground">Frontmatter
        <textarea spellCheck={false} rows={Math.min(10, front.split('\n').length)} value={front}
          onChange={(e) => { const f = e.target.value; frontRef.current = f; setFront(f); const md = joinFrontmatter(f, editor.getMarkdown()); last.current = md; emit.current(md); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save.current?.(); } }}
          className="mt-1 block w-full resize-y rounded-md border bg-transparent p-2 font-mono text-[13px] leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>}
      <EditorContent editor={editor} className="min-h-0 grow rounded-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring" />
    </div>
  );
}
