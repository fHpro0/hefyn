import { useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog } from '../dialogs';
import { iconFor } from '../icons';
import { Err, Field as Labeled, Input, Select } from '../ui';
import { trpc } from '@/lib/trpc';
import { TEMPLATES, type Collection, type Field, type Template } from './types';

const BLANK: Template = { key: 'blank', name: 'Blank', icon: 'Database', blurb: 'Start with one text field and add your own.', fields: () => [{ name: 'name', type: 'text', required: true }] };
const PROJECTS = TEMPLATES.find((t) => t.key === 'projects')!;

// Create from a template or blank. A template that links to Projects uses the Projects collection you already have, offers to create it
// when it is missing, and otherwise leaves the link out.
export function NewCollection({ collections, canTeam, initial, onClose, onCreated }: { collections: Collection[]; canTeam: boolean; initial?: string; onClose: () => void; onCreated: (slug: string) => void }) {
  const [tpl, setTpl] = useState<Template>(TEMPLATES.find((t) => t.key === initial) ?? BLANK);
  const [name, setName] = useState(tpl.key === 'blank' ? '' : tpl.name);
  const [scope, setScope] = useState<'personal' | 'team'>('personal');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const projects = collections.find((c) => c.scope === scope && (c.slug === 'projects' || c.name.toLowerCase() === 'projects'));

  const create = async (withProjects: 'use' | 'make' | 'skip') => {
    setBusy(true); setErr('');
    try {
      let pid = projects?.id;
      if (withProjects === 'make') pid = (await trpc.data.collections.create.mutate({ scope, name: PROJECTS.name, icon: PROJECTS.icon, fields: PROJECTS.fields() })).id;
      const fields: Field[] = tpl.fields(withProjects === 'skip' ? undefined : pid);
      const c = await trpc.data.collections.create.mutate({ scope, name: name.trim(), icon: tpl.icon, fields });
      onCreated(c.slug); onClose();
    } catch (e) { setErr((e as Error).message); setAsk(false); } finally { setBusy(false); }
  };
  const submit = () => (tpl.needs && !projects ? setAsk(true) : create('use'));
  const pick = (t: Template) => { setTpl(t); setName(t.key === 'blank' ? '' : t.name); setAsk(false); };

  return (
    <Dialog title="New collection" wide onClose={onClose}
      footer={ask ? <span className="text-[13px] text-muted-foreground">Choose how to continue.</span> : <><Button variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" form="new-col" disabled={busy || !name.trim()}>Create</Button></>}>
      <form id="new-col" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Start from">
          {[...TEMPLATES, BLANK].map((t) => { const Icon = iconFor(t.icon), on = t.key === tpl.key; return (
            <button key={t.key} type="button" role="radio" aria-checked={on} onClick={() => pick(t)}
              className={`grid gap-1 rounded-lg border p-3 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring ${on ? 'border-foreground bg-foreground/[0.04]' : 'border-border hover:bg-foreground/[0.03]'}`}>
              <span className="flex items-center gap-2 font-medium"><Icon size={15} aria-hidden className="text-muted-foreground" />{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.blurb}</span>
            </button>); })}
        </div>
        <Labeled label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Invoices" /></Labeled>
        {canTeam && (
          <Labeled label="Who can use it"><Select value={scope} onChange={(e) => { setScope(e.target.value as 'personal' | 'team'); setAsk(false); }}>
            <option value="personal">Only me (personal)</option><option value="team">The team (you choose the roles afterwards)</option></Select></Labeled>)}
        {ask && (
          <div className="grid gap-2 rounded-lg border border-border bg-muted/50 p-3 text-[13px]" role="alert">
            <p>{tpl.name} links each entry to a project, but there is no Projects collection {scope === 'team' ? 'for the team ' : ''}yet.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => create('make')}>Create Projects too</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => create('skip')}>Skip the project link</Button>
            </div>
          </div>)}
        <Err>{err}</Err>
      </form>
    </Dialog>
  );
}
