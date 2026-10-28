import { z } from 'zod';

// Declarative screens (docs/MODULES.md). No server imports: the console imports the TYPES from here.
// A screen is data only: no HTML, hrefs are `https:` or the module's own `/m/<id>/...`, unknown keys are rejected.

const text = (max: number) => z.string().min(1).max(max);
const KEY = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const TOOL = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid tool name');
const PATH = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'path must be dotted keys');
const ARGS = z.record(KEY, z.union([z.string().max(500), z.number(), z.boolean()])).refine((o) => Object.keys(o).length <= 20, 'at most 20 args');

/** A zod failure as `{ path: 'a.b.0', message }` entries; an unknown key of a strict object is reported at the key itself. */
export const flatIssues = (e: z.ZodError) => e.issues.flatMap((i) =>
  i.code === 'unrecognized_keys' ? i.keys.map((k) => ({ path: [...i.path, k].join('.'), message: 'unknown key' })) : [{ path: i.path.join('.'), message: i.message }]);

/** Settings fields and form fields share this shape. */
export const fieldSchema = z.strictObject({
  key: KEY, label: text(80), hint: text(300).optional(),
  type: z.enum(['text', 'secret', 'number', 'boolean', 'select']),
  options: z.array(text(80)).max(30).optional(),
  required: z.boolean().optional(),
  default: z.union([text(500), z.number(), z.boolean()]).optional(),
})
.refine((f) => f.type !== 'select' || !!f.options?.length, 'a select needs options')
.refine((f) => typeof f.default !== 'string' || !/[\x00-\x1f\x7f]/.test(f.default), 'default must be a single line') // same rule as a saved value
.refine((f) => f.type !== 'select' || f.default === undefined || !!f.options?.includes(f.default as string), 'default must be one of the options');
export type Field = z.output<typeof fieldSchema>;

export const SCREEN_LIMITS = { blocks: 50, columns: 12, fields: 20 };

export function screenSchema(moduleId: string) {
  const own = `/m/${moduleId}/`;
  // Own paths: no escapes at all (`%2e%2e`), and the resolved path must still be under /m/<id>/ (catches `..`, `.`, `//host`).
  const inside = (h: string) => { try { const r = new URL(h, 'http://x'); return r.origin === 'http://x' && r.pathname.startsWith(own) && r.pathname.length > own.length; } catch { return false; } };
  const href = z.string().max(500).refine((h) => /^https:\/\/[^\s]+$/.test(h) || (h.startsWith(own) && !/[%\s\\]/.test(h) && inside(h)), `href must be https: or ${own}...`);
  const block = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: text(5000) }),
    z.strictObject({ type: z.literal('alert'), tone: z.enum(['info', 'warning', 'danger']), text: text(1000) }),
    z.strictObject({ type: z.literal('stat'), label: text(80), tool: TOOL, args: ARGS.optional(), path: PATH.optional() }),
    z.strictObject({
      type: z.literal('table'), tool: TOOL, args: ARGS.optional(),
      columns: z.array(z.strictObject({ key: KEY, label: text(80) })).min(1).max(SCREEN_LIMITS.columns),
      // The clicked row is passed as the tool's arguments.
      rowAction: z.strictObject({ label: text(60), tool: TOOL }).optional(),
    }),
    z.strictObject({ type: z.literal('list'), tool: TOOL, args: ARGS.optional(), primary: KEY, secondary: KEY.optional() }),
    z.strictObject({
      type: z.literal('form'), fields: z.array(fieldSchema).min(1).max(SCREEN_LIMITS.fields),
      submit: z.strictObject({ tool: TOOL, label: text(60) }),
    }),
    z.strictObject({ type: z.literal('button'), label: text(60), tool: TOOL.optional(), href: href.optional() }).refine((b) => !!b.tool !== !!b.href, 'a button needs exactly one of tool or href'),
  ]);
  return z.strictObject({
    title: text(120), hint: text(500).optional(),
    /** local permission name (the module's own); unset = every signed-in user */
    permission: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
    blocks: z.array(block).max(SCREEN_LIMITS.blocks),
  });
}
export type Screen = z.output<ReturnType<typeof screenSchema>>;
export type Block = Screen['blocks'][number];

/** Every tool a screen may call (what `modules.callTool` allows). */
export const toolsOf = (s: Screen): string[] => s.blocks.flatMap((b) =>
  b.type === 'stat' || b.type === 'list' ? [b.tool] : b.type === 'table' ? [b.tool, ...(b.rowAction ? [b.rowAction.tool] : [])] : b.type === 'form' ? [b.submit.tool] : b.type === 'button' && b.tool ? [b.tool] : []);
