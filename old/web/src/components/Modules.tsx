import { Plus, Power, Settings2, Trash2 } from 'lucide-react';
import { MenuArea } from './AppMenu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { can, refreshModules, useQuery } from './api';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { ConfirmDialog, Dialog } from './dialogs';
import { iconFor } from './icons';
import { FieldInput, type FieldValue, type ModuleField } from './module-fields';
import { toast } from './toast';
import { buttonDanger, Chip, Empty, Err, Field, Page, Row, Section, Switch, Textarea } from './ui';

interface Installed { id: string; name: string; version: string; description?: string; icon?: string; enabled: boolean; mcp?: string; settings: number; screens: string[] }
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

export default function Modules() {
  return <Shell>{(me) => (can(me, 'modules.manage') ? <Content /> : <Page title="Modules"><Err>You need the permission to manage modules.</Err></Page>)}</Shell>;
}

function Content() {
  const { data, reload } = useQuery(() => trpc.modules.installed.query() as Promise<Installed[]>);
  const [install, setInstall] = useState(false);
  const [settings, setSettings] = useState<Installed>();
  const [del, setDel] = useState<Installed>();
  const changed = () => { reload(); refreshModules(); };
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); ok && toast(ok); } catch (x) { toast((x as Error).message, true); } changed(); };
  return (
    <Page title="Modules" hint="Installed modules add screens, skills and agents. They run code only as MCP servers; hefyn never runs a module's code itself. See docs/MODULES.md."
      actions={<Button onClick={() => setInstall(true)}><Plus size={14} aria-hidden />Install module</Button>}>
      <Section title="Installed modules">
        {data?.length === 0 && <Empty icon={<Plus size={20} aria-hidden />}>No module installed yet. Paste a module manifest to install one, or install a module package from the Hub.</Empty>}
        {data?.map((m) => {
          const Icon = iconFor(m.icon);
          return (
            <MenuArea key={m.id} items={() => <>
              <DropdownMenuItem className="text-[13px]" onClick={() => run(() => trpc.modules.setEnabled.mutate({ id: m.id, enabled: !m.enabled }))}><Power size={15} strokeWidth={1.75} aria-hidden />{m.enabled ? 'Disable' : 'Enable'}</DropdownMenuItem>
              {m.settings > 0 && <DropdownMenuItem className="text-[13px]" onClick={() => setSettings(m)}><Settings2 size={15} strokeWidth={1.75} aria-hidden />Settings</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-[13px]" variant="destructive" onClick={() => setDel(m)}><Trash2 size={15} strokeWidth={1.75} aria-hidden />Uninstall…</DropdownMenuItem></>}>
            <Row title={<span className="flex flex-wrap items-center gap-2"><Icon size={15} aria-hidden className="text-muted-foreground" />{m.name}<Chip>v{m.version}</Chip>{m.mcp && <Chip tone="blue">MCP {host(m.mcp)}</Chip>}</span>} hint={m.description}>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Switch label={`Enable ${m.name}`} checked={m.enabled} onChange={(on) => run(() => trpc.modules.setEnabled.mutate({ id: m.id, enabled: on }))} />
                {m.settings > 0 && <Button variant="outline" onClick={() => setSettings(m)}><Settings2 size={14} aria-hidden />Settings</Button>}
                <Button variant="outline" size="icon" className={buttonDanger} aria-label={`Uninstall ${m.name}`} onClick={() => setDel(m)}><Trash2 size={14} aria-hidden /></Button>
              </div>
            </Row>
            </MenuArea>
          );
        })}
      </Section>
      {install && <InstallDialog onClose={() => setInstall(false)} onDone={() => { setInstall(false); changed(); toast('Module installed'); }} />}
      {settings && <SettingsDialog m={settings} onClose={() => setSettings(undefined)} />}
      {del && <ConfirmDialog title={`Uninstall ${del.name}?`} body="Its screens, skills, agents and MCP connector are removed. Its settings and stored secrets are deleted." action="Uninstall" onClose={() => setDel(undefined)} onConfirm={() => run(() => trpc.modules.delete.mutate({ id: del.id }), 'Module uninstalled')} />}
    </Page>
  );
}

function InstallDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(text); } catch { return setErr('This is not valid JSON.'); }
    setBusy(true);
    try { await trpc.modules.install.mutate(manifest); onDone(); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Install a module" wide onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <Field label="Manifest (hefyn.module.json)"><Textarea className="min-h-56 font-mono text-xs" required value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "id": "my-module", "name": "My module", "version": "1.0.0", … }' spellCheck={false} /></Field>
        <Field label="Or pick a .json file"><input type="file" accept=".json,application/json" className="text-[13px]" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} /></Field>
        <p className="text-xs text-muted-foreground">The module's MCP server is reached over HTTPS only (no redirects, no internal addresses). Its screens are checked before they are shown.</p>
        <p className="text-xs text-muted-foreground">A module's server receives what users enter in its screens. Install only modules whose server you trust.</p>
        <Err>{err}</Err>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>Install</Button></div>
      </form>
    </Dialog>
  );
}

function SettingsDialog({ m, onClose }: { m: Installed; onClose: () => void }) {
  const { data, error } = useQuery(() => trpc.modules.settings.query({ id: m.id }) as Promise<{ fields: ModuleField[]; values: Record<string, FieldValue | { set: boolean }> }>);
  const [vals, setVals] = useState<Record<string, FieldValue>>({});
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  useEffect(() => { data && setVals(Object.fromEntries(data.fields.flatMap((f) => { const x = data.values[f.key]; return f.type === 'secret' || x === undefined || typeof x === 'object' ? [] : [[f.key, x]]; }))); }, [data]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!data) return;
    const values: Record<string, FieldValue | null> = {};
    for (const f of data.fields) {
      const x = vals[f.key];
      if (f.type === 'secret') { if (clear.has(f.key)) values[f.key] = null; else if (x) values[f.key] = x; } // empty keeps the stored secret
      else values[f.key] = x === undefined || x === '' ? null : f.type === 'number' ? Number(x) : x;
    }
    try { await trpc.modules.saveSettings.mutate({ id: m.id, values }); toast('Settings saved'); onClose(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Dialog title={`${m.name} settings`} onClose={onClose}>
      <form className="grid gap-3" onSubmit={save}>
        {data?.fields.map((f) => {
          const set = f.type === 'secret' && (data.values[f.key] as { set: boolean } | undefined)?.set && !clear.has(f.key);
          return <FieldInput key={f.key} f={f} value={vals[f.key]} onChange={(x) => setVals({ ...vals, [f.key]: x })} placeholder={f.type === 'secret' ? (set ? '••• set, leave empty to keep' : 'not set') : undefined}
            extra={f.type === 'secret' && <span className="flex items-center gap-2 text-xs text-muted-foreground">{set ? 'set' : 'not set'}{set && <Button type="button" variant="outline" size="xs" onClick={() => setClear(new Set(clear).add(f.key))}>Clear</Button>}</span>} />;
        })}
        <Err>{err || error}</Err>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!data}>Save</Button></div>
      </form>
    </Dialog>
  );
}
