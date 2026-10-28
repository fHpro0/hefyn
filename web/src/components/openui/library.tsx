import { action, createLibrary, defineComponent, FormNameContext, useFormName, useGetFieldValue, useIsStreaming, useSetFieldValue, useTriggerAction } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { NativeSelect } from '@/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';

// hefyn's own OpenUI library for the CLI chat, on the console's ui kit. Nothing here loads a URL (no img, no iframe, no link): a URL the agent controls
// would bypass the sandbox egress gate. A link is only the OpenUrl action, which the chat opens on a user click (OpenUIBlock.tsx).
// The prompt the agents get is generated from this file (scripts/openui-skill.ts): change a description here, run `bun run openui:skill`.

// react-lang reads `process.env["NODE_ENV"]` (bracket form, which bundler defines miss) when a library is created: a browser has no `process`.
(globalThis as { process?: unknown }).process ??= { env: {} };

const kids =z.array(z.any()).describe('child components');
const cell = z.union([z.string(), z.number()]);
const tones = { neutral: 'bg-foreground/[0.06] text-muted-foreground', ok: 'bg-success/15 text-success-ink', warn: 'bg-warning/18 text-warning-ink', bad: 'bg-danger/12 text-danger-ink' };

const Stack = defineComponent({
  name: 'Stack', description: 'Lays children out in a column (default) or a row. Use as the root.',
  props: z.object({ children: kids, direction: z.enum(['column', 'row']).optional(), gap: z.enum(['sm', 'md', 'lg']).optional() }),
  component: ({ props: p, renderNode }) => <div className={cn('flex', p.direction === 'row' ? 'flex-row flex-wrap items-center' : 'flex-col', p.gap === 'sm' ? 'gap-1.5' : p.gap === 'lg' ? 'gap-5' : 'gap-3')}>{renderNode(p.children)}</div>,
});
const Card = defineComponent({
  name: 'Card', description: 'A bordered box with an optional title around its children.',
  props: z.object({ title: z.string().optional(), children: kids }),
  component: ({ props: p, renderNode }) => (
    <div className="grid gap-3 rounded-lg border border-border p-3">{p.title && <div className="text-xs font-medium text-muted-foreground">{p.title}</div>}{renderNode(p.children)}</div>
  ),
});
const Heading = defineComponent({
  name: 'Heading', description: 'A heading.', props: z.object({ text: z.string() }),
  component: ({ props: p }) => <h3 className="font-semibold">{p.text}</h3>,
});
const Text = defineComponent({
  name: 'Text', description: 'A paragraph of plain text (no markdown).', props: z.object({ text: z.string(), muted: z.boolean().optional() }),
  component: ({ props: p }) => <p className={cn('text-sm whitespace-pre-wrap', p.muted && 'text-muted-foreground')}>{p.text}</p>,
});
const Tag = defineComponent({
  name: 'Tag', description: 'A small status label. tone: neutral, ok, warn or bad.', props: z.object({ text: z.string(), tone: z.enum(['neutral', 'ok', 'warn', 'bad']).optional() }),
  component: ({ props: p }) => <Badge variant="secondary" className={cn('rounded-md', tones[p.tone ?? 'neutral'])}>{p.text}</Badge>,
});
const DataTable = defineComponent({
  name: 'DataTable', description: 'A table: column titles and rows, each row a list of cells in column order.', props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(cell)) }),
  component: ({ props: p }) => (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table><TableHeader><TableRow>{p.columns.map((c, i) => <TableHead key={i}>{c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{p.rows.map((r, i) => <TableRow key={i}>{r.map((c, j) => <TableCell key={j} className="whitespace-normal">{String(c)}</TableCell>)}</TableRow>)}</TableBody></Table>
    </div>
  ),
});
const KeyValue = defineComponent({
  name: 'KeyValue', description: 'Labelled facts or stats: a list of [label, value] pairs.', props: z.object({ items: z.array(z.array(cell)) }),
  component: ({ props: p }) => (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{p.items.map(([k, v], i) => <div key={i} className="contents"><dt className="text-muted-foreground">{String(k)}</dt><dd>{String(v ?? '')}</dd></div>)}</dl>
  ),
});

const Btn = defineComponent({
  name: 'Button', description: 'A button. Without an action it sends its label to the assistant. Inside a Form it also sends the form values.',
  props: z.object({ label: z.string(), action: action().optional(), variant: z.enum(['primary', 'outline']).optional() }),
  component: ({ props: p }) => {
    const trigger = useTriggerAction(), form = useFormName(), busy = useIsStreaming();
    return <Button type="button" size="default" className="justify-self-start" variant={p.variant === 'outline' ? 'outline' : 'default'} disabled={busy} onClick={() => trigger(p.label, form, p.action as any)}>{p.label}</Button>;
  },
});
const Choices = defineComponent({
  name: 'Choices', description: 'A row of quick-reply buttons. Clicking one sends that option text to the assistant as the answer. Best way to ask the user to pick.',
  props: z.object({ options: z.array(z.string()) }),
  component: ({ props: p }) => {
    const trigger = useTriggerAction(), busy = useIsStreaming();
    return <div className="flex flex-wrap gap-2">{p.options.map((o, i) => <Button key={i} type="button" variant="outline" disabled={busy} onClick={() => trigger(o)}>{o}</Button>)}</div>;
  },
});

const Form = defineComponent({
  name: 'Form', description: 'Groups fields and a submit Button. A Button inside sends every field value to the assistant. name is a short unique id.',
  props: z.object({ name: z.string(), children: kids }),
  component: ({ props: p, renderNode }) => <FormNameContext.Provider value={p.name}><div className="grid gap-3">{renderNode(p.children)}</div></FormNameContext.Provider>,
});
/** The stored value of a field is `{ value, componentType }`. */
const useField = (name: string) => {
  const form = useFormName(), get = useGetFieldValue(), set = useSetFieldValue();
  const v = get(form, name);
  return [v && typeof v === 'object' && 'value' in v ? v.value : v, (type: string, x: unknown) => set(form, type, name, x, false)] as const;
};
const Label = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1.5 text-[13px]"><span>{label}</span>{children}</label>;
const TextField = defineComponent({
  name: 'TextField', description: 'A one-line text input inside a Form. name is the key its value is sent under.', props: z.object({ name: z.string(), label: z.string(), placeholder: z.string().optional() }),
  component: ({ props: p }) => {
    const [v, set] = useField(p.name), busy = useIsStreaming();
    return <Label label={p.label}><Input value={(v as string) ?? ''} placeholder={p.placeholder} disabled={busy} onChange={(e) => set('TextField', e.target.value)} /></Label>;
  },
});
const SelectField = defineComponent({
  name: 'SelectField', description: 'A dropdown inside a Form: one of the options.', props: z.object({ name: z.string(), label: z.string(), options: z.array(z.string()) }),
  component: ({ props: p }) => {
    const [v, set] = useField(p.name), busy = useIsStreaming();
    return <Label label={p.label}><NativeSelect className="w-full" value={(v as string) ?? ''} disabled={busy} onChange={(e) => set('SelectField', e.target.value)}><option value="">Choose…</option>{p.options.map((o, i) => <option key={i}>{o}</option>)}</NativeSelect></Label>;
  },
});
const CheckField = defineComponent({
  name: 'CheckField', description: 'A checkbox inside a Form; its value is true or false.', props: z.object({ name: z.string(), label: z.string() }),
  component: ({ props: p }) => {
    const [v, set] = useField(p.name), busy = useIsStreaming();
    return <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={v === true} disabled={busy} onCheckedChange={(c) => set('CheckField', c)} />{p.label}</label>;
  },
});

export const library = createLibrary({ components: [Stack, Card, Heading, Text, Tag, DataTable, KeyValue, Btn, Choices, Form, TextField, SelectField, CheckField], root: 'Stack' });

export const promptOptions = {
  preamble: 'In the hefyn chat you can show interactive UI instead of plain text. Write it as OpenUI Lang inside a fenced code block tagged openui. Text around the block is normal markdown.',
  additionalRules: [
    'Put the OpenUI Lang in a ```openui fenced block in your reply, never outside one. One block per reply is usually enough; add a sentence of normal text before or after it.',
    'Use it for tables, comparisons, status cards, choices the user should pick from (Choices), and forms. Plain answers stay plain text.',
    'A click sends a message back to you: Choices and Button send their label, a Button inside a Form also sends every field as "name: value". Treat that message as the user\'s answer.',
    'There are no images, iframes or links to load. To offer a link, use a Button with @OpenUrl("https://...").',
  ],
  examples: [
    '```openui\nroot = Stack([card, ask])\ncard = Card("Build status", [KeyValue([["Branch", "main"], ["Tests", "42 passed"]]), Tag("green", "ok")])\nask = Choices(["Deploy", "Wait", "Show the log"])\n```',
  ],
};
export const skillPrompt = () => library.prompt(promptOptions);
