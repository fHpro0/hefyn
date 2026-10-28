import { useState } from 'react';
import { Button } from '@/ui/button';
import { attempt } from '@/components/chat-actions';
import { Dialog } from '@/components/dialogs';
import { Field, Input } from '@/components/ui';
import { COLORS, createProject, type Project } from './api';

/** "New project" dialog; `onCreated` lets "Move to project > New project..." move the chat(s) straight in. */
export function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (p: Project) => void }) {
  const [name, setName] = useState(''), [color, setColor] = useState(COLORS[5]!), [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const ok = await attempt(async () => { const p = await createProject(name.trim(), color); onCreated?.(p); });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title="New project" onClose={onClose} footer={<Button disabled={!name.trim() || busy} onClick={submit}>Create project</Button>}>
      <form onSubmit={(e) => { e.preventDefault(); name.trim() && !busy && submit(); }} className="grid gap-4">
        <Field label="Name"><Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kunden" /></Field>
        <Field label="Color"><div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
          {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className={`size-6 rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring ${c === color ? 'ring-2 ring-foreground' : ''}`} style={{ background: c }} />)}
        </div></Field>
      </form>
    </Dialog>
  );
}
