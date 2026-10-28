import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '@/ui/button';
import { trpc } from '@/lib/trpc';
import { useQuery } from './api';
import { Lockup, refreshBrand } from './brand';
import Shell from './Shell';
import { toast } from './toast';
import { Input, Page, Row, Section } from './ui';

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], MAX = 256 * 1024;
type Brand = { name: string; logo: string | null; logoDark: string | null };

export default function Branding() {
  return <Shell>{() => <Content />}</Shell>;
}

// Admin-only: the company shown beside hefyn on the sign-in pages. Logos travel as data: URLs and are only ever drawn through <img>.
function Content() {
  const { data, reload } = useQuery(() => trpc.brand.get.query());
  const [b, setB] = useState<Brand>({ name: '', logo: null, logoDark: null });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setB(data); }, [data]);
  const dirty = !!data && JSON.stringify(b) !== JSON.stringify(data);
  const pick = (k: 'logo' | 'logoDark') => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!TYPES.includes(f.type)) return setErr('Use a PNG, JPEG, WebP or SVG image.');
    if (f.size > MAX * 0.74) return setErr('That image is too large. Keep it under 190 KB.'); // 256 KB once base64-encoded
    const r = new FileReader();
    r.onload = () => { setErr(''); setB((x) => ({ ...x, [k]: r.result as string })); };
    r.readAsDataURL(f);
  };
  const save = async () => {
    setBusy(true);
    try { await trpc.brand.set.mutate(b); reload(); refreshBrand(); toast('Company brand saved.'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const logoRow = (k: 'logo' | 'logoDark', title: string, hint: string, bg: string) => (
    <Row title={title} hint={hint} wide>
      <div className="flex flex-wrap items-center gap-3">
        <div className={`grid h-14 w-40 place-items-center rounded-lg border border-border px-3 ${bg}`}>
          {b[k] ? <img src={b[k]!} alt="" className="max-h-7 max-w-full object-contain" /> : <span className="text-[13px] text-muted-foreground">None</span>}
        </div>
        <Button variant="outline" size="sm" render={<label />} nativeButton={false}>Choose file<input type="file" accept={TYPES.join(',')} className="sr-only" aria-label={title} onChange={pick(k)} /></Button>
        {b[k] && <Button variant="ghost" size="sm" onClick={() => setB((x) => ({ ...x, [k]: null }))}>Remove</Button>}
      </div>
    </Row>
  );
  return (
    <Page title="Branding" hint="Your company beside hefyn, for everyone in the workspace.">
      <Section title="Company brand">
        <Row title="Company name" hint="Shown as “hefyn × name” on the sign-in pages when there is no logo."><Input aria-label="Company name" maxLength={60} value={b.name} onChange={(e) => setB((x) => ({ ...x, name: e.target.value }))} /></Row>
        {logoRow('logo', 'Logo', 'PNG, JPEG, WebP or SVG, 256 KB at most. Shown on the light theme.', 'bg-background')}
        {logoRow('logoDark', 'Dark-mode logo', 'Optional. Without it the logo above is used on the dark theme too.', 'bg-[#09090b]')}
        <div className="flex items-center gap-3 py-4">
          <Button disabled={busy || !dirty} onClick={save}>Save brand</Button>
          {err && <span role="alert" className="text-[13px] text-danger-ink">{err}</span>}
        </div>
      </Section>
      <Section title="Preview">
        <div className="grid gap-4 py-4 md:grid-cols-2" aria-label="Preview">
          <div className="space-y-2"><div className="text-xs text-muted-foreground">Sign-in page</div><div className="rounded-lg border border-border bg-background p-5"><Lockup height={28} brand={b} /></div></div>
          <div className="space-y-2"><div className="text-xs text-muted-foreground">Sidebar</div><div className="w-[260px] max-w-full rounded-lg border border-border bg-sidebar px-3 py-3.5"><Lockup height={18} compact brand={b} /></div></div>
        </div>
      </Section>
    </Page>
  );
}
