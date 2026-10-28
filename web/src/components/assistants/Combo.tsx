import { ChevronsUpDown } from 'lucide-react'; // the check mark of the chosen entry comes from CommandItem (data-checked)
import { useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

export interface ComboOption { id: string; name: string; hint?: string; icon?: ReactNode; /** shown muted under a disabled entry */ disabledReason?: string; badge?: string }

/** A searchable single-choice picker (cmdk in a popover), the house look of the model picker, for short lists of named things. */
export function Combo({ label, options, value, onChange, disabled }: { label: string; options: ComboOption[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" type="button" aria-label={label} disabled={disabled} title={cur?.name} className="w-full min-w-0 justify-start text-[13px] font-medium" />}>
        {cur?.icon}<span className="min-w-0 truncate">{cur?.name ?? value}</span>
        <ChevronsUpDown size={14} className="ml-auto shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1rem))] gap-0 p-0">
        <Command label={label} className="rounded-lg!" filter={(v, q) => q.toLowerCase().split(/\s+/).every((t) => v.toLowerCase().includes(t)) ? 1 : 0}>
          <CommandInput aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}`} />
          <CommandList className="max-h-[min(24rem,60vh)] p-1">
            <CommandEmpty className="py-4 text-muted-foreground">Nothing matches.</CommandEmpty>
            {options.map((o) => (
              <CommandItem key={o.id} value={`${o.name} ${o.id}`} disabled={!!o.disabledReason} data-checked={o.id === value} onSelect={() => { setOpen(false); if (o.id !== value) onChange(o.id); }} className="text-[13px]">
                {o.icon}
                <div className="min-w-0 grow">
                  <div className="flex items-center gap-2"><span className="min-w-0 truncate">{o.name}</span>{o.badge && <span className="shrink-0 text-[11px] text-warning-ink">{o.badge}</span>}</div>
                  <div className="truncate text-xs text-muted-foreground">{o.disabledReason ?? o.hint}</div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
