// Data collections (docs/DATA.md): shapes of data.* (tRPC) and the helpers the Data page shares.

export type FieldType = 'text' | 'longtext' | 'number' | 'bool' | 'date' | 'datetime' | 'select' | 'relation' | 'email' | 'url' | 'json' | 'duration';
export interface Field {
  id?: string; name: string; type: FieldType; required?: boolean; unique?: boolean; default?: unknown;
  min?: number; max?: number; integer?: boolean; options?: string[]; multiple?: boolean; collection?: string;
}
export interface Collection {
  id: string; scope: 'personal' | 'team'; name: string; slug: string; icon: string; description: string; fields: Field[];
  access?: { view: string[]; edit: string[] }; canEdit: boolean; canManage: boolean; records?: number; createdAt: string; updatedAt: string;
}
export interface Rec { id: string; created: string; updated: string; createdBy: string | null; updatedBy: string | null; values: Record<string, any>; expand?: Record<string, any> }
export interface RecPage { page: number; perPage: number; totalItems: number; totalPages: number; items: Rec[] }
export interface Choice { id: string; name: string }

export const TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: 'Text' }, { type: 'longtext', label: 'Long text' }, { type: 'number', label: 'Number' }, { type: 'bool', label: 'Yes / no' },
  { type: 'date', label: 'Date' }, { type: 'datetime', label: 'Date and time' }, { type: 'select', label: 'Select' }, { type: 'relation', label: 'Relation' },
  { type: 'email', label: 'Email' }, { type: 'url', label: 'URL' }, { type: 'json', label: 'JSON' }, { type: 'duration', label: 'Duration' },
];
export const typeLabel = (t: FieldType) => TYPES.find((x) => x.type === t)?.label ?? t;

// ---- values ----
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const fmtDuration = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
/** "1:30", "1.5" (hours), "90m", "2h" -> minutes; undefined when it is none of these. */
export function parseDuration(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(',', '.');
  let m: RegExpExecArray | null;
  if ((m = /^(\d+):([0-5]\d)$/.exec(t))) return +m[1]! * 60 + +m[2]!;
  if ((m = /^(\d+(\.\d+)?)\s*h$/.exec(t)) || (m = /^(\d+(\.\d+)?)$/.exec(t))) return Math.round(+m[1]! * 60);
  if ((m = /^(\d+)\s*m(in)?$/.exec(t))) return +m[1]!;
  return undefined;
}
export const isEmpty = (x: unknown) => x === undefined || x === null || x === '' || (Array.isArray(x) && !x.length);
export const firstText = (r: { values: Record<string, any> }, fallback: string) => Object.values(r.values).find((x) => typeof x === 'string' && x) ?? fallback;
/** The label of an expanded relation value (a record, or {id, name} for users). */
export const expandLabel = (e: any): string => (e ? (typeof e.name === 'string' ? e.name : firstText(e, e.id)) : '');
export const localDateTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

// ---- templates ----
export interface Template { key: string; name: string; icon: string; blurb: string; needs?: 'Projects'; fields: (projects?: string) => Field[] }
const projectField = (projects?: string, required = false): Field[] => (projects ? [{ name: 'project', type: 'relation', collection: projects, required }] : []);
export const TEMPLATES: Template[] = [
  { key: 'tasks', name: 'Tasks', icon: 'Briefcase', blurb: 'Title, status, due date, priority, project, assignee, notes.', needs: 'Projects',
    fields: (p) => [
      { name: 'title', type: 'text', required: true }, { name: 'status', type: 'select', options: ['todo', 'doing', 'done'], default: 'todo', required: true }, { name: 'due', type: 'date' },
      { name: 'priority', type: 'select', options: ['low', 'medium', 'high'], default: 'medium' }, ...projectField(p), { name: 'assignee', type: 'relation', collection: 'users' }, { name: 'notes', type: 'longtext' }] },
  { key: 'projects', name: 'Projects', icon: 'Folder', blurb: 'Name, client, status, start and end, budget hours, notes.',
    fields: () => [
      { name: 'name', type: 'text', required: true }, { name: 'client', type: 'text' }, { name: 'status', type: 'select', options: ['planned', 'active', 'paused', 'done'], default: 'active' },
      { name: 'start', type: 'date' }, { name: 'end', type: 'date' }, { name: 'budget_hours', type: 'number', min: 0 }, { name: 'notes', type: 'longtext' }] },
  { key: 'time-tracking', name: 'Time tracking', icon: 'Calendar', blurb: 'Date, project, duration, description, billable, person.', needs: 'Projects',
    fields: (p) => [
      { name: 'date', type: 'date', required: true, default: '@today' }, ...projectField(p, true), { name: 'duration', type: 'duration', required: true },
      { name: 'description', type: 'text' }, { name: 'billable', type: 'bool', default: true }, { name: 'user', type: 'relation', collection: 'users', default: '@me' }] },
];
