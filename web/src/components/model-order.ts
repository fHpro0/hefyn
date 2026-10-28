// shortcut: recency is guessed from the id (version after the family name, then snapshot date) because the catalog has no release dates; replace if pi-ai adds them.
const key = (id: string) => {
  const s = id.slice(id.lastIndexOf('/') + 1);
  const d = s.match(/(\d{4})-?(\d{2})-?(\d{2})(?!\d)/);
  const v = s.replace(/\d{4}-?\d{2}-?\d{2}(?!\d)/, '').match(/(\d+(?:[-.]\d+)*)([a-z])?/);
  const ver = v ? v[1].split(/[-.]/).map(Number) : [];
  if (v?.[2]) ver.push(0.5); // gpt-4o sits between gpt-4 and gpt-4.1
  return { ver, date: d ? +(d[1] + d[2] + d[3]) : Infinity, s };
};

/** Sort comparator on model ids: newest first; an undated alias ahead of its own snapshots. */
export const byRecency = (a: string, b: string) => {
  const x = key(a), y = key(b);
  for (let i = 0; i < Math.max(x.ver.length, y.ver.length); i++) if ((x.ver[i] ?? 0) !== (y.ver[i] ?? 0)) return (y.ver[i] ?? 0) - (x.ver[i] ?? 0);
  return x.date !== y.date ? (y.date > x.date ? 1 : -1) : x.s < y.s ? -1 : x.s > y.s ? 1 : 0;
};
