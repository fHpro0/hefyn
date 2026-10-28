import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Combo } from './Combo';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { EFFORTS } from '../effort';
import { Field, Input, Select } from '../ui';
import ModelPicker, { type ModelOption } from '../model-picker';

export interface ModelChoice { id: string; name: string; contextWindow?: number; reasoning?: boolean; vision?: boolean }
export interface ProviderChoice { id: string; name: string; connected: boolean; reason?: string; models: ModelChoice[] }
// The shapes assistants.options returns; roles only come back for people who manage Assistants.
export interface Options {
  agents: { id: string; name: string; api: 'anthropic' | 'openai-responses'; actsWithoutAsking?: boolean; /** what each agent can run on (connected API-key providers), with their models */ providers?: ProviderChoice[]; /** takes MCP servers */ mcp?: boolean; /** another agent can run it headless */ helper?: boolean }[];
  models: Record<string, ModelChoice[]>;
  /** provider, model and effort are shown to people who manage models only */ canChooseModels?: boolean;
  thinking: string[]; skills: { id: string; name: string; description: string; shared?: boolean }[]; mcp?: { id: string; name: string; shared: boolean }[]; roles?: { id: string; name: string }[];
}
export interface HelperRow { role: string; agent: string; provider?: string | null; model?: string | null; /** may change files without asking; default off = read-only */ edit?: boolean }
export interface Inputs { images: 'off' | 'on'; maxImageEdge: number; imageQuality: number; documents: boolean; maxUploadMb: number }
export const defaultInputs = (): Inputs => ({ images: 'on', maxImageEdge: 1568, imageQuality: 0.8, documents: true, maxUploadMb: 25 });
/** What a simple preset sets on its CLI agent. */
export interface SimpleFields { agent: string | null; /** the model provider; unset = the agent's own API's */ provider?: string | null; model: string | null; thinking: string | null; instructions: string; skills: string[]; mcp: string[]; helpers: HelperRow[] }

/** A popover with checkboxes (optionally searchable): empty selection reads as `none`. `hideLabel`: the section around it already names it. */
export function Pick({ label, none, items, value, onChange, search, hideLabel }: { label: string; none: string; items: { id: string; name: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; search?: boolean; hideLabel?: boolean }) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  const text = value.length ? value.map((id) => items.find((i) => i.id === id)?.name ?? id).join(', ') : none;
  return (
    <div className="grid gap-1.5 text-[13px]"><span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" type="button" aria-label={label} className="w-full justify-between font-normal" />}><span className="truncate">{text}</span><ChevronDown size={14} aria-hidden /></PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-72 gap-1 overflow-y-auto p-2">
          {search && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${label.toLowerCase()}`} />}
          {!shown.length && <p className="px-2 py-1.5 text-[13px] text-muted-foreground">Nothing found.</p>}
          {shown.map((i) => (
            <label key={i.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
              <Checkbox className="mt-0.5" checked={value.includes(i.id)} onCheckedChange={(on) => onChange(on ? [...value, i.id] : value.filter((x) => x !== i.id))} />
              <span className="min-w-0"><span className="block">{i.name}</span>{i.hint && <span className="block truncate text-xs text-muted-foreground">{i.hint}</span>}</span>
            </label>
          ))}
          {!!value.length && <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => onChange([])}>Clear</Button>}
        </PopoverContent>
      </Popover>
    </div>
  );
}

type FieldProps = { value: SimpleFields; onChange: (patch: Partial<SimpleFields>) => void; options: Options };

/** Provider, model and effort: only for people who manage models. */
export function ModelFields({ value: d, onChange, options }: FieldProps) {
  const agent = options.agents.find((a) => a.id === d.agent);
  const providers = agent?.providers ?? [], provider = providers.find((p) => p.id === (d.provider ?? providers[0]?.id));
  const choices: ModelOption[] = (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name, group: provider!.name, contextWindow: m.contextWindow, reasoning: m.reasoning, vision: m.vision }));
  return <>
    {agent && <Field label="Provider">
      <Combo label="Provider" value={provider?.id ?? d.provider ?? ''} disabled={providers.length < 2} onChange={(id) => onChange({ provider: id, model: null })}
        options={[...(!provider && d.provider ? [{ id: d.provider, name: d.provider }] : []), ...providers.map((p) => ({ id: p.id, name: p.name, hint: `${p.models.length} models`, disabledReason: p.connected ? undefined : (p.reason ?? 'no API key connected') }))]} />
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{provider && !provider.connected ? provider.reason : providers.length < 2 ? `${agent.name} always uses ${providers[0]?.name ?? 'its own provider'}.` : `${agent.name} can use any of these. Only providers with an API key under Settings, Agents & keys can be picked.`}</p>
    </Field>}
    <div className="grid gap-3">
      <Field label="Model" className="min-w-0"><ModelPicker className="w-full max-w-none min-w-0" label="Model" options={choices} value={d.model ?? ''} emptyLabel="Default" disabled={!agent || (!!provider && !provider.connected)} onChange={(model) => onChange({ model: model || null })} /></Field>
      <Field label="Thinking effort" className="min-w-0"><Select value={d.thinking ?? ''} onChange={(e) => onChange({ thinking: e.target.value || null })}><option value="">Default</option>
        {options.thinking.map((t) => <option key={t} value={t}>{EFFORTS[t] ?? t}</option>)}</Select></Field>
    </div>
  </>;
}
