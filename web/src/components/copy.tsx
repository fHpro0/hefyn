import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/ui/button';

/** Copies `text`; the icon and label say "Copied" for a moment. */
export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<number>(undefined);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setDone(true); clearTimeout(t.current); t.current = window.setTimeout(() => setDone(false), 1500);
  };
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={done ? 'Copied' : label} title={done ? 'Copied' : label} onClick={copy} className={`text-muted-foreground ${className}`}>
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}<span role="status" className="sr-only">{done ? 'Copied' : ''}</span>
    </Button>
  );
}
