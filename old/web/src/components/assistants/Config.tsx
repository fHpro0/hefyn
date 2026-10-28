import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/ui/button';
import { Field, Input, Select, Switch, Textarea } from '../ui';
import { defaultConfig, metaOf, OPS, UNARY_OPS, type FlowNode, type Upstream } from './flow';
import { CodeField } from './CodeField';
import { AgentFields, type Options } from './parts';
import { TemplateField } from './TemplateField';
import { ToolsLink } from './Tools';

interface Props { node: FlowNode; refs: Upstream[]; options: Options; /** The "Try this step" pane for steps that can be tried; `wide` is the large editor's layout. */ test?: (wide: boolean) => React.ReactNode; onConfig: (patch: Record<string, any>) => void; onLabel: (label: string) => void; onDelete: () => void }

const Remove = ({ label, onClick }: { label: string; onClick: () => void }) => <Button variant="ghost" size="icon" type="button" aria-label={label} onClick={onClick}><Trash2 size={15} aria-hidden /></Button>;

/** The form for the selected node: a section per type, template fields offer the values of earlier steps. */
export function Config({ node, refs, options, test, onConfig, onLabel, onDelete }: Props) {
  const m = metaOf(node.type);
  const c = { ...defaultConfig(node.type), ...node.config };
  const T = (key: string, label: string, rows?: number, mono?: boolean, placeholder?: string) =>
    <TemplateField label={label} value={String(c[key] ?? '')} onChange={(v) => onConfig({ [key]: v })} refs={refs} rows={rows} mono={mono} placeholder={placeholder} />;

  const list = <E,>(key: string, blank: () => E, item: (e: E, set: (p: Partial<E>) => void, i: number) => React.ReactNode, addLabel: string) => {
    const items = (c[key] ?? []) as E[];
    return (
      <div className="grid gap-2">
        {items.map((e, i) => (
          <div key={i} className="grid gap-2 rounded-md bg-muted/50 p-3">
            {item(e, (p) => onConfig({ [key]: items.map((x, j) => (j === i ? { ...x, ...p } : x)) }), i)}
            <Remove label={`Remove ${i + 1}`} onClick={() => onConfig({ [key]: items.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => onConfig({ [key]: [...items, blank()] })}><Plus size={14} aria-hidden />{addLabel}</Button>
      </div>
    );
  };

  let body: React.ReactNode = null;
  switch (node.type) {
    case 'trigger.chat':
      body = <p className="text-[13px] text-muted-foreground">Nothing to set. The message is <code>{`{{${node.id}.text}}`}</code> and the attached files are <code>{`{{${node.id}.files}}`}</code>.</p>;
      break;
    case 'agent':
      body = <>
        <AgentFields value={{ agent: c.agent ?? null, provider: c.provider ?? null, model: c.model ?? null, thinking: c.thinking ?? null, instructions: c.instructions ?? '', skills: c.skills ?? [], subAgents: c.subAgents ?? [] }} onChange={onConfig} options={options} />
        <ToolsLink node={node} />
        {T('prompt', 'What it gets to work on', 10)}
        <label className="flex items-center justify-between gap-3 text-[13px]">Send the chat so far<Switch label="Send the chat so far" checked={c.history !== false} onChange={(history) => onConfig({ history })} /></label>
        <Field label="Answer as"><Select value={c.output ?? 'text'} onChange={(e) => onConfig({ output: e.target.value })}><option value="text">Text</option><option value="json">Structured data (JSON)</option></Select></Field>
        {c.output === 'json' && <Field label="Shape of the data (JSON schema)"><Textarea rows={5} className="font-mono text-xs" value={typeof c.schema === 'string' ? c.schema : c.schema ? JSON.stringify(c.schema, null, 2) : ''} onChange={(e) => onConfig({ schema: e.target.value })} placeholder='{"type":"object","properties":{"category":{"type":"string"}}}' /></Field>}
      </>;
      break;
    case 'assistant':
      body = <>
        <Field label="Assistant"><Select value={c.assistantId ?? ''} onChange={(e) => onConfig({ assistantId: e.target.value })}><option value="">Choose one</option>
          {c.assistantId && !options.assistants.some((a) => a.id === c.assistantId) && <option value={c.assistantId}>{c.assistantId}</option>}
          {options.assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        {T('prompt', 'What it gets to work on', 10)}
      </>;
      break;
    case 'router':
      body = <>
        <Field label="Who decides"><Select value={c.mode} onChange={(e) => onConfig({ mode: e.target.value })}><option value="ai">An AI model reads the message</option><option value="rules">Rules, checked in order</option></Select></Field>
        {c.mode === 'ai' && <Field label="Model"><Select value={c.model ?? ''} onChange={(e) => onConfig({ model: e.target.value || undefined })}><option value="">Default</option>
          {(options.models.hefyn ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
        <div className="text-[13px]">Paths</div>
        {list<{ id: string; label: string; description?: string; rule?: string }>('branches',
          () => { const used = new Set(c.branches.map((b: { id: string }) => b.id)); let n = c.branches.length + 1; while (used.has(`b${n}`)) n++; return { id: `b${n}`, label: `Branch ${n}` }; },
          (b, set) => <>
            <Field label="Name"><Input value={b.label} onChange={(e) => set({ label: e.target.value })} /></Field>
            {c.mode === 'ai'
              ? <Field label="Choose this path when"><Input value={b.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="The person asks about an invoice" /></Field>
              : <Field label="Rule"><Input value={b.rule ?? ''} onChange={(e) => set({ rule: e.target.value })} className="font-mono text-xs" placeholder={`{{${refs[0]?.id ?? 'start'}.text}} contains refund`} /></Field>}
          </>, 'Add a path')}
        <p className="text-[13px] text-muted-foreground">Anything that fits no path takes the <b>else</b> exit.</p>
        {c.mode === 'rules' && test?.(false)}
      </>;
      break;
    case 'condition':
      body = <>
        {T('left', 'Value')}
        <Field label="Check"><Select value={c.op} onChange={(e) => onConfig({ op: e.target.value })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        {!UNARY_OPS.includes(c.op) && T('right', 'Compared with')}
        {test?.(false)}
      </>;
      break;
    case 'approval':
      body = <>
        {T('content', 'What they review', 6, false, `{{${refs.at(-1)?.id ?? 'draft'}.text}} (empty: the text of the step before)`)}
        {T('message', 'Question', 3, false, 'Send this reply?')}
        <label className="flex items-center justify-between gap-3 text-[13px]">Let them edit the text first<Switch label="Let them edit the text first" checked={!!c.editable} onChange={(editable) => onConfig({ editable })} /></label>
      </>;
      break;
    case 'ask':
      body = <>
        {T('question', 'Question', 6)}
        <div className="text-[13px]">Answer fields (optional)</div>
        {list<{ name: string; label: string; type: 'text' | 'choice'; options?: string[] }>('fields', () => ({ name: `field${(c.fields?.length ?? 0) + 1}`, label: '', type: 'text' }),
          (f, set) => <>
            <Field label="Label"><Input value={f.label} onChange={(e) => set({ label: e.target.value })} /></Field>
            <Field label="Name in templates"><Input value={f.name} className="font-mono text-xs" onChange={(e) => set({ name: e.target.value.replace(/[^a-z0-9_]/g, '') })} /></Field>
            <Field label="Kind"><Select value={f.type} onChange={(e) => set({ type: e.target.value as 'text' | 'choice' })}><option value="text">Free text</option><option value="choice">Pick one</option></Select></Field>
            {f.type === 'choice' && <Field label="Choices (one per line)"><Textarea rows={3} value={(f.options ?? []).join('\n')} onChange={(e) => set({ options: e.target.value.split('\n') })} /></Field>}
          </>, 'Add a field')}
      </>;
      break;
    case 'template':
      body = <>{T('text', 'Text', 8)}{test?.(false)}</>;
      break;
    case 'code':
      body = <CodeField language={c.language} source={c.source ?? ''} timeoutSec={c.timeoutSec} onConfig={onConfig} test={test} label={node.label || m.label} />;
      break;
    case 'tool': {
      const conn = options.connectors.find((x) => x.id === c.connectorId);
      const args = Object.entries((c.args ?? {}) as Record<string, string>);
      const setArgs = (next: [string, string][]) => onConfig({ args: Object.fromEntries(next) });
      body = <>
        <Field label="Connector"><Select value={c.connectorId} onChange={(e) => onConfig({ connectorId: e.target.value, tool: '', args: {} })}><option value="">Choose one</option>
          {options.connectors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Tool"><Select value={c.tool} disabled={!conn} onChange={(e) => onConfig({ tool: e.target.value })}><option value="">Choose one</option>
          {conn?.tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</Select></Field>
        {conn?.tools.find((t) => t.name === c.tool)?.description && <p className="text-[13px] text-muted-foreground">{conn.tools.find((t) => t.name === c.tool)!.description}</p>}
        <div className="text-[13px]">Inputs</div>
        <div className="grid gap-2">
          {args.map(([k, v], i) => (
            <div key={i} className="grid gap-2 rounded-md bg-muted/50 p-3">
              <Field label="Name"><Input value={k} className="font-mono text-xs" onChange={(e) => setArgs(args.map((a, j): [string, string] => (j === i ? [e.target.value, a[1]] : a)))} /></Field>
              <TemplateField label="Value" value={String(v)} refs={refs} onChange={(nv) => setArgs(args.map((a, j): [string, string] => (j === i ? [a[0], nv] : a)))} />
              <Remove label={`Remove input ${k || i + 1}`} onClick={() => setArgs(args.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setArgs([...args, [`input${args.length + 1}`, '']])}><Plus size={14} aria-hidden />Add an input</Button>
        </div>
      </>;
      break;
    }
    case 'output.reply':
      body = T('text', 'Reply', 8);
      break;
    case 'output.file':
      body = <>{T('path', 'File path', undefined, true, 'reports/summary.md')}{T('content', 'Content', 10)}</>;
      break;
  }
  return (
    <div className="grid min-w-0 content-start gap-4 p-4 [&>*]:min-w-0">
      <div><h2 className="text-[15px] font-semibold">{m.label}</h2><p className="text-[13px] text-muted-foreground">{m.hint}</p></div>
      <Field label="Name on the canvas"><Input value={node.label ?? ''} maxLength={60} placeholder={m.label} onChange={(e) => onLabel(e.target.value)} /></Field>
      {body}
      <p className="text-[12px] text-muted-foreground">Later steps refer to this one as <code>{node.id}</code>.</p>
      <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={onDelete}><Trash2 size={14} aria-hidden />Delete this step</Button>
    </div>
  );
}
