import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang';
import { Component, useContext, useState, type ReactNode } from 'react';
import { ChatActions, Streaming } from './context';
import { library } from './library';

/** The form values of an action as "name: value" lines (the store keeps `{ form: { field: { value } } }`). */
export function formLines(state: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const walk = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('$') || !v || typeof v !== 'object') continue;
      if ('value' in v && 'componentType' in v) out.push(`${k}: ${String((v as { value: unknown }).value ?? '')}`);
      else walk(v as Record<string, unknown>);
    }
  };
  if (state) walk(state);
  return out;
}

/** The message an action sends to the agent, or the URL to open (http(s) only; the click is the user's). */
export function actionOf(e: ActionEvent): { send: string } | { open: string } | undefined {
  if (e.type === 'continue_conversation') return { send: [e.humanFriendlyMessage, ...formLines(e.formState)].filter(Boolean).join('\n') };
  if (e.type === 'open_url') { try { const u = new URL(String(e.params.url)); if (u.protocol === 'https:' || u.protocol === 'http:') return { open: u.href }; } catch { /* not a URL */ } }
}

class Guard extends Component<{ fallback: ReactNode; children: ReactNode }, { bad: boolean }> {
  state = { bad: false };
  static getDerivedStateFromError() { return { bad: true }; }
  render() { return this.state.bad ? this.props.fallback : this.props.children; }
}

const Source = ({ source }: { source: string }) => <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] p-3 font-mono text-[13px] leading-relaxed">{source}</pre>;

/** An ```openui block: the agent's OpenUI Lang rendered live with hefyn's components. If it cannot be rendered the source shows instead, never a blank. */
export default function OpenUIBlock({ source }: { source: string }) {
  const { send } = useContext(ChatActions), streaming = useContext(Streaming);
  const [errors, setErrors] = useState<OpenUIError[]>([]), [show, setShow] = useState(false);
  const failed = !streaming && errors.some((e) => e.severity !== 'warning');
  const onAction = (e: ActionEvent) => {
    const a = actionOf(e);
    if (a && 'send' in a) send?.(a.send);
    else if (a) window.open(a.open, '_blank', 'noopener,noreferrer');
  };
  return (
    <div className="my-3 grid gap-2">
      {failed || show ? <Source source={source} /> : null}
      {!failed && (
        <Guard fallback={<Source source={source} />}>
          <Renderer response={source} library={library} isStreaming={streaming} onAction={onAction} onError={setErrors} />
        </Guard>
      )}
      {!failed && <button type="button" className="justify-self-start font-mono text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShow(!show)}>{show ? 'Hide source' : 'Show source'}</button>}
    </div>
  );
}
