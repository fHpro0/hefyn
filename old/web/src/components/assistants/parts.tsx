import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentIcon, loadAgents } from '../AgentChoice';
import { Combo } from './Combo';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { EFFORTS } from '../effort';
import { actsWithoutAskingText } from '../agent-catalog';
import { Field, Input, Select, Switch, Textarea } from '../ui';
import ModelPicker, { type ModelOption } from '../model-picker';
import type { SimpleFields } from './flow';
import { TemplateField } from './TemplateField';

export interface ModelChoice { id: string; name: string; contextWindow?: number; reasoning?: boolean; vision?: boolean }
export interface ProviderChoice { id: string; name: string; connected: boolean; reason?: string; models: ModelChoice[] }
// The shapes assistants.options returns (see docs/ASSISTANTS.md); roles only come back for people who manage Assistants.
export interface Options {
  agents: { id: string | null; name: string; api: 'hefyn' | 'anthropic' | 'openai-responses'; actsWithoutAsking?: boolean; /** CLI agents: what each can run on (connected API-key providers), with their models */ providers?: ProviderChoice[] }[];
  models: Record<string, ModelChoice[]>;
  thinking: string[]; skills: { id: string; name: string; description: string }[]; roles?: { id: string; name: string }[];
  connectors: { id: string; name: string; tools: { name: string; description: string }[] }[];
  assistants: { id: string; name: string }[];
  nodeTypes: { type: string }[];
}
export interface Inputs { images: 'off' | 'on'; maxImageEdge: number; imageQuality: number; documents: boolean; maxUploadMb: number }
export const defaultInputs = (): Inputs => ({ images: 'on', maxImageEdge: 1568, imageQuality: 0.8, documents: true, maxUploadMb: 25 });

/** A popover with checkboxes (optionally searchable): empty selection reads as `none`. */
export function Pick({ label, none, items, value, onChange, search }: { label: string; none: string; items: { id: string; name: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; search?: boolean }) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  const text = value.length ? value.map((id) => items.find((i) => i.id === id)?.name ?? id).join(', ') : none;
  return (
    <div className="grid gap-1.5 text-[13px]"><span>{label}</span>
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

/** "What people can attach" - the input rules of an Assistant. */
export function InputRules({ value: v, onChange }: { value: Inputs; onChange: (v: Inputs) => void }) {
  const set = (p: Partial<Inputs>) => onChange({ ...v, ...p });
  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-[13px] font-medium">What people can attach</legend>
      <label className="flex items-center justify-between gap-3 text-[13px]">Images<Select className="w-40" value={v.images} onChange={(e) => set({ images: e.target.value as Inputs['images'] })}><option value="on">Allowed</option><option value="off">Off</option></Select></label>
      {v.images === 'on' && <>
        <Field label="Shrink images to at most (pixels, long side)"><Input type="number" min={256} max={8192} step={64} value={v.maxImageEdge} onChange={(e) => set({ maxImageEdge: Number(e.target.value) })} /></Field>
        <Field label={`Picture quality: ${Math.round(v.imageQuality * 100)}%`}><input type="range" min={0.3} max={1} step={0.05} value={v.imageQuality} onChange={(e) => set({ imageQuality: Number(e.target.value) })} className="w-full accent-foreground" /></Field>
      </>}
      <label className="flex items-center justify-between gap-3 text-[13px]">Documents<Switch label="Documents" checked={v.documents} onChange={(documents) => set({ documents })} /></label>
      <Field label="Largest upload (MB)"><Input type="number" min={1} max={500} value={v.maxUploadMb} onChange={(e) => set({ maxUploadMb: Number(e.target.value) })} /></Field>
    </fieldset>
  );
}

/** The agent form shared by the Simple view and the Agent node's config panel. */
export function AgentFields({ value: d, onChange, options }: { value: SimpleFields; onChange: (patch: Partial<SimpleFields>) => void; options: Options }) {
  const agent = options.agents.find((a) => a.id === d.agent), cli = d.agent !== null;
  const [icons, setIcons] = useState<Record<string, string | undefined>>({});
  useEffect(() => { void loadAgents().then((l) => setIcons(Object.fromEntries(l.map((a) => [a.id, a.icon])))); }, []);
  const providers = agent?.providers ?? [], provider = providers.find((p) => p.id === (d.provider ?? providers[0]?.id));
  // hefyn takes any connected model (ids are provider/model: the provider is the group); a CLI agent the models of the provider chosen above
  const choices: ModelOption[] = cli
    ? (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name, group: provider!.name, contextWindow: m.contextWindow, reasoning: m.reasoning, vision: m.vision }))
    : (options.models.hefyn ?? []).map((m) => ({ id: m.id, name: m.name, group: m.id.split('/')[0]!, contextWindow: m.contextWindow, reasoning: m.reasoning, vision: m.vision }));
  const hint = (a: Options['agents'][number]) => {
    if (a.id === null) return `any connected provider · ${options.models.hefyn?.length ?? 0} models`;
    const on = (a.providers ?? []).filter((p) => p.connected);
    return on.length ? `${on.map((p) => p.name).join(', ')} · ${on.reduce((n, p) => n + p.models.length, 0)} models` : 'no API key connected';
  };
  return <>
    <Field label="Runs on">
      <Combo label="Agent" value={d.agent ?? ''} onChange={(id) => onChange({ agent: id || null, provider: null, model: null, thinking: null })}
        options={options.agents.map((a) => ({ id: a.id ?? '', name: a.name, hint: hint(a), icon: <AgentIcon src={a.id ? icons[a.id] : undefined} size={16} />, badge: a.actsWithoutAsking ? 'acts without asking' : undefined,
          disabledReason: a.id !== null && a.id !== d.agent && !(a.providers ?? []).some((p) => p.connected) ? (a.providers?.find((p) => p.reason)?.reason ?? 'no API key connected') : undefined }))} />
      {agent?.actsWithoutAsking && <p className="mt-1 text-xs leading-5 text-warning-ink">{actsWithoutAskingText(agent.name)}</p>}
    </Field>
    {cli && <Field label="Provider">
      <Combo label="Provider" value={provider?.id ?? d.provider ?? ''} disabled={providers.length < 2} onChange={(id) => onChange({ provider: id, model: null })}
        options={[...(!provider && d.provider ? [{ id: d.provider, name: d.provider }] : []), ...providers.map((p) => ({ id: p.id, name: p.name, hint: `${p.models.length} models`, disabledReason: p.connected ? undefined : (p.reason ?? 'no API key connected') }))]} />
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{provider && !provider.connected ? provider.reason : providers.length < 2 ? `${agent!.name} always uses ${providers[0]?.name ?? 'its own provider'}.` : `${agent!.name} can use any of these. Only providers with an API key under Settings, Providers can be picked.`}</p>
    </Field>}
    {/* one per row: the model's name and provider don't fit next to the effort select in the settings panel (they overlapped) */}
    <div className="grid gap-3">
      <Field label="Model" className="min-w-0"><ModelPicker className="w-full max-w-none min-w-0" label="Model" options={choices} value={d.model ?? ''} emptyLabel="Default" disabled={cli && !!provider && !provider.connected} onChange={(model) => onChange({ model: model || null })} /></Field>
      <Field label="Thinking effort" className="min-w-0"><Select value={d.thinking ?? ''} onChange={(e) => onChange({ thinking: e.target.value || null })}><option value="">Default</option>
        {options.thinking.map((t) => <option key={t} value={t}>{EFFORTS[t] ?? t}</option>)}</Select></Field>
    </div>
    <TemplateField label="What should be done" rows={10} limit={20_000} value={d.instructions} onChange={(instructions) => onChange({ instructions })} placeholder="Describe the job, the tone to use and any rules to follow. For example: Answer customer mails politely, in German, in under 120 words." />
    <Pick label="Skills" none="No extra skills" items={options.skills.map((s) => ({ id: s.id, name: s.name, hint: s.description }))} value={d.skills} onChange={(skills) => onChange({ skills })} search />
    {d.agent === null && <SubAgents value={d.subAgents} onChange={(subAgents) => onChange({ subAgents })} options={options} />}
  </>;
}

interface Sub { name: string; description: string; model: string | null; instructions: string; skills: string[] }
const blankSub = (): Sub => ({ name: '', description: '', model: null, instructions: '', skills: [] });

/** Helpers hefyn can hand a part of the job to. Only the hefyn agent has them. */
function SubAgents({ value, onChange, options }: { value: Sub[]; onChange: (v: Sub[]) => void; options: Options }) {
  const models = options.models[options.agents.find((a) => a.id === null)?.api ?? 'hefyn'] ?? [];
  const set = (i: number, p: Partial<Sub>) => onChange(value.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <fieldset data-part="helpers" className="grid gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-[13px] font-medium">Helpers</legend>
      <p className="text-[13px] text-muted-foreground">Smaller jobs hefyn can hand to a helper, each with its own instructions.</p>
      {value.map((s, i) => (
        <div key={i} className="grid gap-2 rounded-md bg-muted/50 p-3" role="group" aria-label={`Helper ${s.name || i + 1}`}>
          <div className="flex items-end gap-2">
            <Field label="Name" className="grow"><Input value={s.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} placeholder="Researcher" /></Field>
            <Button variant="ghost" size="icon" aria-label={`Remove helper ${s.name || i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden /></Button>
          </div>
          <Field label="What it is for"><Input value={s.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Looks things up and sums them up" /></Field>
          <Field label="Model"><Select value={s.model ?? ''} onChange={(e) => set(i, { model: e.target.value || null })}><option value="">Same as above</option>
            {s.model && !models.some((m) => m.id === s.model) && <option value={s.model}>{s.model}</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
          <TemplateField label="What should be done" rows={6} value={s.instructions} onChange={(instructions) => set(i, { instructions })} />
          <Pick label="Skills" none="No extra skills" items={options.skills.map((k) => ({ id: k.id, name: k.name, hint: k.description }))} value={s.skills} onChange={(skills) => set(i, { skills })} search />
        </div>
      ))}
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => onChange([...value, blankSub()])}><Plus size={14} aria-hidden />Add a helper</Button>
    </fieldset>
  );
}

