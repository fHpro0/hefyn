import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Progress } from '@/ui/progress';
import { Table as ShTable, TableBody, TableHead, TableHeader, TableRow } from '@/ui/table';

// Plain tabular list: hairlines only.
export const Table = ({ head, children, num = [] }: { head: string[]; children: ReactNode; num?: number[] }) => (
  <ShTable className="text-[13px]">
    <TableHeader className="text-xs text-muted-foreground [&_tr]:border-b-0">
      <TableRow className="hover:bg-transparent">{head.map((h, i) => <TableHead key={h || i} className={cn('h-auto px-3 py-2 text-muted-foreground first:pl-0 last:pr-0', num.includes(i) ? 'text-right' : 'text-left')}>{h}</TableHead>)}</TableRow>
    </TableHeader>
    <TableBody className="[&_td]:px-3 [&_td]:py-2.5 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-t [&_tr]:border-b-0 [&_tr:last-child]:border-t">{children}</TableBody>
  </ShTable>
);

export const QuotaBar = ({ used, quota }: { used: number; quota: number }) => {
  const f = Math.min(used / quota, 1);
  return <Progress value={f * 100} aria-label="Storage used" className={f > 0.9 ? '[&_[data-slot=progress-indicator]]:bg-danger' : undefined} />;
};
