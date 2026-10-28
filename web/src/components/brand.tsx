import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { hasBrand, type Brand } from './brand-label';
import { Wordmark } from './ui';

// brand.get once per page load; refreshBrand() after brand.set.
let cached: Brand | null | undefined;
const subs = new Set<(b: Brand | null) => void>();
let inflight: Promise<void> | undefined;
const load = () => (inflight ??= trpc.brand.get.query().then((b) => { cached = b as Brand; }, () => { cached = null; }).then(() => { inflight = undefined; subs.forEach((f) => f(cached!)); }));
export const refreshBrand = () => { cached = undefined; void load(); };

export function useBrand(): Brand | null {
  const [b, setB] = useState<Brand | null>(cached ?? null);
  useEffect(() => { subs.add(setB); if (cached === undefined) void load(); else setB(cached); return () => { subs.delete(setB); }; }, []);
  return b;
}

// "hefyn × company": the wordmark, a thin ×, then the company logo (dark variant in dark mode), else its name. Just the wordmark when no brand is set.
// compact: shrinks and truncates inside a tight header (logo max 96px wide).
// brand: show this one (a draft preview) instead of the saved company brand.
export function Lockup({ height, compact, brand }: { height: number; compact?: boolean; brand?: Brand | null }) {
  const saved = useBrand();
  const b = brand === undefined ? saved : brand;
  const lh = compact ? 20 : height;
  const img = (src: string, cls: string) => <img src={src} alt={b?.name || 'Company logo'} style={{ height: lh, maxWidth: compact ? 96 : height * 5.5 }} className={`w-auto min-w-0 object-contain object-left ${cls}`} />;
  return (
    <div className={`flex min-w-0 items-center ${compact ? 'gap-2' : 'gap-4'}`}>
      <span className="shrink-0"><Wordmark height={height} /></span>
      {hasBrand(b) && <>
        <span aria-hidden className="shrink-0 font-mono leading-none font-extralight text-muted-foreground" style={{ fontSize: height * 0.8 }}>×</span>
        {b.logo ? <>{img(b.logo, b.logoDark ? 'dark:hidden' : '')}{b.logoDark && img(b.logoDark, 'hidden dark:block')}</> : <span className="truncate font-medium" style={{ fontSize: height * 0.8 }}>{b.name}</span>}
      </>}
    </div>
  );
}
