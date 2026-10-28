import { RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { CliConversation } from '../CliChat';
import { toast } from '../toast';
import { Err } from '../ui';
import type { DraftIn } from './creator';
import type { Options } from './parts';

const rpc = trpc;
const key = (d: DraftIn) => JSON.stringify({ ...d, newSkills: undefined });

/** "Test": a throwaway chat on the draft as it is now. Starting again (Reset test) replaces it; the server removes it when the editor closes. */
export function TestPanel({ draftId, form, options, assistantId, scope, onImprove }: { draftId: string; form: DraftIn; options: Options; assistantId?: string; scope: 'private' | 'team'; onImprove: (text: string) => void }) {
  const [test, setTest] = useState<{ id: string; agent: string; made: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const agent = options.agents.find((a) => a.id === form.agent);
  const start = async () => {
    setBusy(true); setError('');
    try { const t = await rpc.assistants.test.start.mutate({ draftId, draft: form, assistantId, scope }); setTest({ ...t, made: key(form) }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (form.agent && !test && !busy && !error) void start(); }, [form.agent]);
  const improve = async () => {
    if (!test) return;
    try {
      const turns = await rpc.assistants.test.turns.query({ id: test.id });
      if (!turns.length) return void toast('Send a message in the test first.', true);
      onImprove(`Improve the assistant based on this test.\n\n${turns.map((t) => `The person wrote:\n${t.user}\n\nThe Assistant answered:\n${t.agent || '(no answer yet)'}`).join('\n\n---\n\n')}\n\nSay what went wrong or could be better, and change the draft so it works better next time.`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const stale = !!test && test.made !== key(form);
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" variant="outline" disabled={busy || !form.agent} onClick={start}><RotateCcw size={14} aria-hidden />Reset test</Button>
        <Button size="sm" variant="outline" disabled={!test} onClick={improve}><Sparkles size={14} aria-hidden />Improve from this test</Button>
        {stale && <span role="status" className="ml-auto text-xs text-warning-ink">The draft changed since this test began. Reset to try the latest.</span>}
      </div>
      <Err>{error}</Err>
      {!form.agent ? <p className="p-6 text-[13px] text-muted-foreground">Pick the agent this Assistant runs on, then you can try it here.</p>
        : test ? <CliConversation key={test.id} id={test.id} agent={test.agent} name={form.name || agent?.name} view="chat" placeholder="Write what a person would write"
            empty={<div className="grid gap-1 pt-6"><h2 className="text-base leading-6 font-semibold">Try {form.name || 'this Assistant'}</h2><p className="text-[13px] leading-5 text-muted-foreground">This chat uses the draft as you see it, saved or not. It is deleted when you leave.</p></div>} />
        : <p className="p-6 text-[13px] text-muted-foreground">{busy ? 'Starting the test…' : ''}</p>}
    </div>
  );
}
