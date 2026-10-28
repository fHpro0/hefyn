import type { ReactNode } from 'react';
import type { Field as ModuleField } from '../../../src/modules/screen-schema';
import { Field, Input, Select, Switch } from './ui';

export type { ModuleField };
export type FieldValue = string | number | boolean;

/** One settings / form field of a module (text, secret, number, boolean, select). Values are kept as typed by the user; callers convert. */
export function FieldInput({ f, value, onChange, placeholder, extra }: { f: ModuleField; value: FieldValue | undefined; onChange: (v: FieldValue) => void; placeholder?: string; extra?: ReactNode }) {
  const label = <>{f.label}{f.required && <span aria-hidden className="text-danger-ink"> *</span>}</>;
  const hint = f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>;
  if (f.type === 'boolean') return <div className="grid gap-1"><label className="flex items-center gap-2 text-[13px]"><Switch label={f.label} checked={value === true} onChange={onChange} />{label}</label>{hint}</div>;
  const v = value === undefined ? '' : String(value);
  return (
    <div className="grid gap-1">
      <Field label={label}>
        {f.type === 'select'
          ? <Select value={v} onChange={(e) => onChange(e.target.value)}>{!f.required && <option value="" />}{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
          : <Input type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'} step={f.type === 'number' ? 'any' : undefined} value={v} placeholder={placeholder} required={f.required && !placeholder}
            autoComplete={f.type === 'secret' ? 'new-password' : 'off'} onChange={(e) => onChange(e.target.value)} />}
      </Field>
      {hint}{extra}
    </div>
  );
}

/** Form state to tool args / settings values: numbers parsed, empty strings dropped. */
export const toArgs = (fields: ModuleField[], vals: Record<string, FieldValue>) => Object.fromEntries(fields.flatMap((f) => {
  const x = vals[f.key];
  return x === undefined || x === '' ? [] : [[f.key, f.type === 'number' ? Number(x) : x]];
}));
