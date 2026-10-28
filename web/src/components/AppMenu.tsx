import { ArrowLeft, ArrowRight, Copy, ExternalLink, Image as ImageIcon, Link as LinkIcon, MessageSquarePlus, RotateCw, Search, SquareArrowOutUpRight } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@/ui/dropdown-menu';
import { toast } from './toast';
import { shortcut } from './ui';

const ico = { size: 15, strokeWidth: 1.75, 'aria-hidden': true } as const;
const cls = 'text-[13px]';

// The app's one right-click menu (mounted by Shell). An area declares its items with <MenuArea items={() => <>…DropdownMenuItem…</>}>; the innermost area
// under the pointer wins and the generic entries (selection, link, image, code, page) are added around it. Native menu: editable fields, Shift+right-click, dialogs.
const areas = new WeakMap<Element, () => ReactNode>();
export const menuRef = (items: () => ReactNode) => (el: Element | null) => { if (el) areas.set(el, items); }; // re-set each render = latest closure; for elements MenuArea's div cannot wrap (a <tr>)
export function MenuArea({ items, children }: { items: () => ReactNode; children: ReactNode }) {
  return <div className="contents" ref={menuRef(items)}>{children}</div>;
}

const NATIVE = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],.cm-editor,.monaco-editor,.xterm,[role=dialog],[role=alertdialog]';
const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Copy failed', true));
const copyImage = async (src: string) => {
  try { const b = await (await fetch(src)).blob(); await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]); toast('Image copied'); } catch { toast('Copy failed', true); }
};
/** An area's "Copy …" item (label, the text, and what the toast calls it). */
export const copyItem = (label: string, text: string, what: string) => <DropdownMenuItem className={cls} onClick={() => copy(text, what)}><Copy {...ico} />{label}</DropdownMenuItem>;
const openTab = (href: string) => window.open(href, '_blank', 'noopener');
const newChat = () => { if (location.pathname === '/') { location.hash = ''; dispatchEvent(new Event('hefyn-newchat')); } else location.href = '/'; };

interface Hit { x: number; y: number; items?: () => ReactNode; sel: string; href?: string; img?: string; code?: string }

export function AppMenu() {
  const [hit, setHit] = useState<Hit>();
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (e.defaultPrevented || (t instanceof Element && t.closest('[data-own-context-menu]'))) { setHit(undefined); return; } // another menu (the flow canvas) owns this click: only one menu at a time
      if (!(t instanceof Element) || t.closest('[role=menu]')) { t instanceof Element && e.preventDefault(); return; } // our own popup: no browser menu on it
      if ((e.shiftKey && e.button === 2) || t.closest(NATIVE)) return; // escape hatches: Shift+right-click, editable fields, dialogs
      e.preventDefault();
      let items: Hit['items'];
      for (let n: Element | null = t; n && !items; n = n.parentElement) items = areas.get(n);
      setHit({ x: e.clientX, y: e.clientY, items, sel: getSelection()?.toString().trim() ?? '',
        href: t.closest<HTMLAnchorElement>('a[href]')?.href, img: t.closest<HTMLImageElement>('img')?.src, code: t.closest('pre,code')?.textContent?.trim() });
    };
    addEventListener('contextmenu', f); return () => removeEventListener('contextmenu', f);
  }, []);
  if (!hit) return null;
  const { sel, img, code } = hit, href = hit.href && /^(https?|mailto):/i.test(hit.href) ? hit.href : undefined, row = (Icon: typeof Copy, label: string, run: () => void, keys?: string) =>
    <DropdownMenuItem className={cls} onClick={run}><Icon {...ico} />{label}{keys && <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>}</DropdownMenuItem>;
  const groups: ReactNode[] = [
    hit.items?.(),
    sel && <>{row(Copy, 'Copy', () => copy(sel, 'Text'))}{row(Search, `Search for “${sel.length > 24 ? `${sel.slice(0, 24)}…` : sel}”`, () => dispatchEvent(new CustomEvent('hefyn-palette', { detail: sel.slice(0, 200) })))}</>,
    href && <>{row(ExternalLink, 'Open', () => { location.href = href; })}{row(SquareArrowOutUpRight, 'Open in new tab', () => openTab(href))}{row(LinkIcon, 'Copy link', () => copy(href, 'Link'))}</>,
    img && <>{row(ImageIcon, 'Open image in new tab', () => openTab(img))}{typeof ClipboardItem !== 'undefined' && row(Copy, 'Copy image', () => copyImage(img))}</>,
    code && !hit.items && row(Copy, 'Copy code', () => copy(code, 'Code')),
    <>{row(ArrowLeft, 'Back', () => history.back())}{row(ArrowRight, 'Forward', () => history.forward())}{row(RotateCw, 'Reload', () => location.reload())}
      {row(MessageSquarePlus, 'New chat', newChat, shortcut('N'))}{row(Search, 'Command palette', () => dispatchEvent(new CustomEvent('hefyn-palette')), shortcut('K'))}
      {row(LinkIcon, 'Copy page link', () => copy(location.href, 'Page link'))}</>,
  ].filter(Boolean);
  const point = { getBoundingClientRect: () => DOMRect.fromRect({ x: hit.x, y: hit.y, width: 0, height: 0 }) };
  return (
    <DropdownMenu open onOpenChange={(o) => !o && setHit(undefined)}>
      <DropdownMenuContent anchor={point} align="start" sideOffset={0} className="w-56">
        {groups.map((g, i) => <Fragment key={i}>{i > 0 && <DropdownMenuSeparator />}{g}</Fragment>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
