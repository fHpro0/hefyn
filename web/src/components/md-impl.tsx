import { lazy, Suspense, useRef, type ComponentProps, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './copy';
import { floatWords } from './float-words';
import { Loading } from './ui';

const OpenUIBlock = lazy(() => import('./openui/OpenUIBlock')); // react-lang loads only when an agent writes an openui block
const isOpenUI = (n: ReactNode) => !!n && typeof n === 'object' && 'props' in n && /\blanguage-openui\b/.test(String((n.props as any).className));

const textOf = (n: ReactNode): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' && 'props' in n ? textOf((n.props as any).children) : '';

// Element styles for react-markdown: 16/24 prose in the UI font, code in mono.
const mdComponents = {
  p: (p: ComponentProps<'p'>) => <p className="my-3 first:mt-0 last:mb-0" {...p} />,
  a: (p: ComponentProps<'a'>) => <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  ul: (p: ComponentProps<'ul'>) => <ul className="my-3 list-disc pl-5 marker:text-muted-foreground" {...p} />,
  ol: (p: ComponentProps<'ol'>) => <ol className="my-3 list-decimal pl-5 marker:text-muted-foreground" {...p} />,
  li: (p: ComponentProps<'li'>) => <li className="my-1" {...p} />,
  h1: (p: ComponentProps<'h1'>) => <h3 className="mt-6 mb-2 text-lg font-semibold" {...p} />,
  h2: (p: ComponentProps<'h2'>) => <h3 className="mt-6 mb-2 text-lg font-semibold" {...p} />,
  h3: (p: ComponentProps<'h3'>) => <h3 className="mt-4 mb-1 font-semibold" {...p} />,
  blockquote: (p: ComponentProps<'blockquote'>) => <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground" {...p} />,
  code: (p: ComponentProps<'code'>) => <code className="rounded-md bg-foreground/[0.07] px-1 py-0.5 font-mono text-[0.85em]" {...p} />,
  pre: ({ children, ...p }: ComponentProps<'pre'>) => isOpenUI(children) ? <Suspense fallback={<Loading />}><OpenUIBlock source={textOf(children).replace(/\n$/, '')} /></Suspense> : (
    <div className="group/code relative my-3">
      <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] p-3 pr-10 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" {...p}>{children}</pre>
      <CopyButton text={textOf(children).replace(/\n$/, '')} label="Copy code" className="absolute top-1.5 right-1.5" />
    </div>
  ),
  table: (p: ComponentProps<'table'>) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm" {...p} /></div>,
  th: (p: ComponentProps<'th'>) => <th className="border-b border-border px-2 py-1.5 text-left font-medium" {...p} />,
  td: (p: ComponentProps<'td'>) => <td className="border-b border-border px-2 py-1.5" {...p} />,
};

export default function MdImpl({ children, animate }: { children: string; animate?: boolean }) {
  const delays = useRef<number[]>([]).current; // each word keeps the delay it first got
  return <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={animate ? [[floatWords, { delays }]] : []} components={mdComponents}>{children}</Markdown>; // GFM: tables, strikethrough, task lists
}
