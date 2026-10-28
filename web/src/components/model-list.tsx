import { Brain, Eye } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { byRecency } from './model-order';
import { Face, triggerCls, type ModelOption, type PickerProps } from './model-picker';

const ctx = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;

function Item({ o, on, pick }: { o: ModelOption; on: boolean; pick: () => void }) {
  return (
    <CommandItem value={`${o.name} ${o.id} ${o.group}`} data-checked={on} onSelect={pick} className="text-[13px]">
      <div className="min-w-0 grow">
        <div className="truncate">{o.name}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono text-[11px]">{o.id.split('/').slice(1).join('/') || o.id}</span>
          {!!o.contextWindow && <span className="tnum shrink-0">{ctx(o.contextWindow)}</span>}
          {o.vision && <Eye size={13} aria-label="Reads images" className="shrink-0" />}
          {o.reasoning && <Brain size={13} aria-label="Reasoning" className="shrink-0" />}
        </div>
      </div>
    </CommandItem>
  );
}

export default function ModelList(p: PickerProps) {
  const [open, setOpen] = useState(true);
  const groups = [...new Set(p.options.map((o) => o.group))];
  const choose = (id: string) => { setOpen(false); if (id !== p.value) p.onChange(id); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" type="button" aria-label={p.label ?? 'Model'} title={p.options.find((o) => o.id === p.value)?.name} disabled={p.disabled} className={triggerCls(p)} />}><Face p={p} /></PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1rem))] gap-0 p-0">
        <Command label={p.label ?? 'Model'} className="rounded-lg!" filter={(v, q) => q.toLowerCase().split(/\s+/).every((t) => v.toLowerCase().includes(t)) ? 1 : 0}>
          <CommandInput aria-label="Search models" placeholder="Search models" />
          <CommandList className="max-h-[min(28rem,60vh)] p-1">
            <CommandEmpty className="py-4 text-muted-foreground">No model matches.</CommandEmpty>
            {p.emptyLabel && <CommandGroup><CommandItem value={`${p.emptyLabel} default`} data-checked={p.value === ''} onSelect={() => choose('')} className="text-[13px]">{p.emptyLabel}</CommandItem></CommandGroup>}
            {groups.map((g) => (
              <CommandGroup key={g} heading={g}>{p.options.filter((o) => o.group === g).sort((a, b) => byRecency(a.id, b.id)).map((o) => <Item key={o.id} o={o} on={o.id === p.value} pick={() => choose(o.id)} />)}</CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
