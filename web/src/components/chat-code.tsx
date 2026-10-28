import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/ui/code-block';
import { useHighlightedCode } from '@/hooks/use-highlighted-code';

// Loaded lazily (shiki) the first time a tool, hand-off or step is expanded: AI Elements CodeBlock for inputs and outputs.
export default function ChatCode({ code, lang = 'json', title, destructive }: { code: string; lang?: string; title: string; destructive?: boolean }) {
  const lines = useHighlightedCode(code, lang);
  return (
    <CodeBlock size="sm" variant={destructive ? 'destructive' : 'default'}>
      <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value={code} /></CodeBlockActions></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-80">{lines.map((l, i) => <CodeBlockLine key={i}>{l}</CodeBlockLine>)}</CodeBlockContent>
    </CodeBlock>
  );
}
