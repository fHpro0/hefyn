import { AlertTriangle, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import Shell from './Shell';
import { applyTheme, cachedTheme, contrast, DEFAULT_THEME, nearSeal, saveTheme, type ThemePrefs } from './theme';
import { toast } from './toast';
import { notifyOn, setNotify } from './attention';
import { Chip, Input, Page, Row, Section } from './ui';

const PRESETS: { name: string; accent: string }[] = [
  { name: 'Default', accent: 'default' }, { name: 'Blue', accent: '#2563eb' }, { name: 'Violet', accent: '#7c3aed' }, { name: 'Emerald', accent: '#059669' },
  { name: 'Amber', accent: '#d97706' }, { name: 'Rose', accent: '#e11d48' }, { name: 'Teal', accent: '#0d9488' }, { name: 'Graphite', accent: '#3f3f46' },
];
const BASES = { zinc: '#f4f4f5', neutral: '#f5f5f5', slate: '#f1f5f9', stone: '#f5f5f4' };
const HEX = /^#[0-9a-f]{6}$/i;

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([v, text]) => <Button key={v} type="button" size="sm" variant={value === v ? 'default' : 'outline'} aria-pressed={value === v} onClick={() => onChange(v)}>{text}</Button>)}
    </div>
  );
}

// Per device, not per account: the browser grants the permission to this browser only, so the choice is kept here (localStorage) and does not follow you.
function NotifyRow() {
  const [on, setOn] = useState(notifyOn);
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const set = async (want: boolean) => {
    const ok = await setNotify(want);
    setOn(ok);
    if (want && !ok) toast(typeof Notification === 'undefined' ? 'This browser can not show notifications.' : 'Notifications are blocked for this site. Allow them in your browser’s site settings.', true);
  };
  return (
    <Row title="Notify me when an agent needs me" hint={`Only while this tab is in the background: a desktop notification when an agent or sub-agent asks for your answer, without sound. Clicking it opens the chat. This applies to this browser only; the permission is asked when you turn it on.${blocked ? ' Your browser currently blocks notifications for this site.' : ''}`}>
      <Choice label="Notify me when an agent needs me" value={on ? 'on' : 'off'} onChange={(v) => void set(v === 'on')} options={[['off', 'Off'], ['on', 'On']]} />
    </Row>
  );
}

export default function Appearance() {
  return <Shell>{() => <Content />}</Shell>;
}

function Content() {
  const [saved, setSaved] = useState<ThemePrefs>(cachedTheme);
  const [t, setT] = useState<ThemePrefs>(saved);
  const [hex, setHex] = useState(HEX.test(saved.accent) ? saved.accent : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { trpc.theme.get.query().then((s) => { setSaved(s); setT(s); setHex(HEX.test(s.accent) ? s.accent : ''); }).catch(() => {}); }, []);
  useEffect(() => { applyTheme(t); }, [t]); // live: the page itself is the preview
  useEffect(() => () => applyTheme(cachedTheme()), []); // leaving without saving drops the draft
  const set = (p: Partial<ThemePrefs>) => setT((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(t) !== JSON.stringify(saved);
  const custom = HEX.test(t.accent) ? t.accent : null;
  const ratio = custom ? contrast(custom, '#ffffff') : null; // on the light page; dark mode lifts the accent, so light is the case that can fail
  const save = async (next: ThemePrefs) => {
    setBusy(true);
    try { await saveTheme(next); setSaved(next); setT(next); setHex(HEX.test(next.accent) ? next.accent : ''); toast('Appearance saved.'); } catch { toast('Could not save. Try again.', true); } finally { setBusy(false); }
  };
  return (
    <Page title="Appearance" hint="Your own look for hefyn. It follows you to every device you sign in on. Seal blue, the status colours and the fonts stay the same for everyone." actions={
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || JSON.stringify(t) === JSON.stringify(DEFAULT_THEME) && !dirty} onClick={() => save(DEFAULT_THEME)}>Reset to default</Button>
        <Button disabled={busy || !dirty} onClick={() => save(t)}>Save</Button>
      </div>}>
      <Section title="Colour">
        <Row title="Mode" hint="System follows your device, live.">
          <Choice label="Mode" value={t.mode} onChange={(mode) => void save({ ...t, mode })} options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]} />
        </Row>
        <Row title="Accent" hint="Primary buttons, focus rings, the active sidebar item and links. Warnings, errors and seals keep their own colours." wide>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Accent presets">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" aria-pressed={t.accent === p.accent} onClick={() => { set({ accent: p.accent }); setHex(p.accent === 'default' ? '' : p.accent); }}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[13px]', t.accent === p.accent ? 'border-foreground' : 'border-border hover:bg-muted')}>
                <span aria-hidden className="size-4 rounded-full border border-border" style={{ background: p.accent === 'default' ? 'linear-gradient(135deg, #09090b 50%, #fafafa 50%)' : p.accent }} />{p.name}
              </button>))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input type="color" aria-label="Pick an accent colour" value={custom ?? '#2563eb'} onChange={(e) => { set({ accent: e.target.value }); setHex(e.target.value); }} className="size-8 cursor-pointer rounded-md border border-border bg-transparent p-0.5" />
            <Input aria-label="Custom accent as hex" placeholder="#rrggbb" value={hex} maxLength={7} className="w-32 font-mono" aria-invalid={!!hex && !HEX.test(hex)}
              onChange={(e) => { const v = e.target.value; setHex(v); if (HEX.test(v)) set({ accent: v.toLowerCase() }); }} />
            {hex && !HEX.test(hex) && <span role="alert" className="text-[13px] text-danger-ink">Use a colour like #2563eb.</span>}
          </div>
          {ratio !== null && ratio < 3 && (
            <p role="alert" className="mt-2 flex items-start gap-1.5 text-[13px] text-warning-ink"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />On a light background this accent has only {ratio.toFixed(1)}:1 contrast (3:1 is the minimum for buttons and focus rings). You can still save it.</p>)}
          {custom && nearSeal(custom) && (
            <p role="status" className="mt-2 flex items-start gap-1.5 text-[13px] text-warning-ink"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />This is close to seal blue. Seals stay blue, so they could be harder to tell apart from buttons.</p>)}
        </Row>
        <Row title="Base colours" hint="The neutral tone of backgrounds, borders and muted text.">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Base colours">
            {(Object.keys(BASES) as ThemePrefs['base'][]).map((b) => (
              <button key={b} type="button" aria-pressed={t.base === b} onClick={() => set({ base: b })}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[13px] capitalize', t.base === b ? 'border-foreground' : 'border-border hover:bg-muted')}>
                <span aria-hidden className="size-4 rounded-full border border-border" style={{ background: BASES[b] }} />{b}
              </button>))}
          </div>
        </Row>
      </Section>
      <Section title="Shape and size">
        <Row title="Corner radius"><Choice label="Corner radius" value={t.radius} onChange={(radius) => set({ radius })} options={[['none', 'None'], ['small', 'Small'], ['default', 'Default'], ['large', 'Large']]} /></Row>
        <Row title="Density" hint="Compact tightens spacing and sidebar items."><Choice label="Density" value={t.density} onChange={(density) => set({ density })} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} /></Row>
        <Row title="Text size"><Choice label="Text size" value={t.textSize} onChange={(textSize) => set({ textSize })} options={[['small', 'Small'], ['default', 'Default'], ['large', 'Large']]} /></Row>
      </Section>
      <Section title="Notifications"><NotifyRow /></Section>
      <Section title="Preview">
        <div className="grid gap-4 py-4 md:grid-cols-2" aria-label="Preview">
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap gap-2"><Button>Primary</Button><Button variant="outline">Outline</Button><Button variant="secondary">Secondary</Button></div>
            <div className="flex items-center gap-2"><Chip>Neutral</Chip><Chip tone="ok">Ok</Chip><Chip tone="alarm">Blocked</Chip></div>
            <Input aria-label="Sample input" placeholder="A text field" />
          </div>
          <div className="space-y-3 rounded-lg border border-border bg-sidebar p-4">
            <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-[13px] font-medium text-sidebar-accent-foreground"><MessageSquare size={14} aria-hidden />Active chat</div>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground"><MessageSquare size={14} aria-hidden />Another chat</div>
            <div className="ml-auto w-fit max-w-full rounded-lg bg-muted px-3 py-2 text-[13px]">Please draft a reply to Maria Keller.</div>
          </div>
        </div>
      </Section>
    </Page>
  );
}
