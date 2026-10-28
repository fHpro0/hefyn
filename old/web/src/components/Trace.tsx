import { lazy, Suspense } from 'react';
import Shell from './Shell';

// /trace#<conversation id>; the view and its data code load on demand.
const TraceView = lazy(() => import('./trace/TraceView'));

export default function Trace() {
  return (
    <Shell title="Trace">
      {() => <Suspense fallback={<p className="p-6 text-[13px] text-muted-foreground">Loading…</p>}><TraceView /></Suspense>}
    </Shell>
  );
}
