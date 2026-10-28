import { useState } from 'react';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { ALL_ICON_NAMES, iconFor } from './icons';
import { Input } from './ui';

// An icon is stored as one string: a lucide component name (`Sparkles`) or an emoji (`emoji:🙂`). Old values are lucide names, so nothing needs converting.
export const EMOJI = 'emoji:';
export const emojiValue = (char: string) => `${EMOJI}${char}`;

/** Shows a stored icon value (a lucide icon or an emoji). */
export function IconView({ value, size = 16, className }: { value?: string; size?: number; className?: string }) {
  if (value?.startsWith(EMOJI)) return <span className={className} style={{ fontSize: Math.round(size * 0.85), lineHeight: 1, display: 'inline-block', textAlign: 'center', width: size }} aria-hidden>{value.slice(EMOJI.length)}</span>;
  const I = iconFor(value || 'Sparkles');
  return <I size={size} className={className} aria-hidden />;
}

// A compact built-in set, no dependency: the character and the words it is searched by.
const EMOJIS = `🙂 smile happy face|😀 grin|😎 cool sunglasses|🤓 nerd study|🤔 think question|🤖 robot bot ai|👾 alien game|🧠 brain mind|💡 idea light bulb|✨ sparkles magic new|⭐ star favourite|🔥 fire hot|⚡ lightning fast zap|🚀 rocket launch|🎯 target goal|🏆 trophy win|🎨 art palette design|✏️ pencil write|📝 memo note|📄 page document|📚 books library|📖 book read|📊 chart graph data|📈 growth trend|🔍 search magnifier|🔎 inspect review|🧪 test tube lab|🧰 toolbox tools|🔧 wrench fix|🛠️ build tools|⚙️ gear settings|🔒 lock secure|🔑 key|🛡️ shield safe|🐛 bug|🪲 beetle bug|🧹 clean broom|🧩 puzzle piece|📦 package box|🗂️ folder files|📁 folder|💬 chat speech|📣 megaphone announce|📧 mail email|📞 phone|🎧 headset support|🌍 globe world|🌱 seed plant grow|🌳 tree|☀️ sun|🌙 moon night|☁️ cloud|⚖️ scales law legal|💼 briefcase work business|💰 money|🧾 receipt invoice|🏦 bank|🏥 hospital health|🎓 graduation learn|🧑‍💻 developer coder|👩‍🔬 scientist|🧑‍🏫 teacher|🕵️ detective investigate|🦉 owl wise|🦊 fox|🐱 cat|🐶 dog|🐝 bee|🦾 robot arm|🧭 compass|🗺️ map|⏱️ timer|📅 calendar|✅ check done|❌ cross|⚠️ warning|❓ question|❗ exclamation|♻️ recycle|🔁 repeat loop|🔀 shuffle|🏁 finish flag|🎬 film|🎵 music|📷 camera photo|🖼️ picture image|🧮 abacus calculate|🔬 microscope|🛰️ satellite|🧬 dna|🍀 clover luck|🎁 gift|🛒 cart shop|🍕 pizza|☕ coffee`.split('|').map((s) => { const [char, ...words] = s.split(' '); return { char: char!, words: words.join(' ') }; });

/** Icon or emoji, searchable. `value` and `onChange` use the stored string. */
export function IconPicker({ value, onChange, disabled, label = 'Icon' }: { value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false), [tab, setTab] = useState(value.startsWith(EMOJI) ? 'emoji' : 'icons'); // controlled: Base UI warns when a Tabs' default changes
  const pick = (v: string) => { onChange(v); setOpen(false); };
  const names = ALL_ICON_NAMES.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()));
  const emojis = EMOJIS.filter((e) => `${e.char} ${e.words}`.toLowerCase().includes(q.trim().toLowerCase()));
  const tile = (on: boolean) => `grid size-8 place-items-center rounded-md border ${on ? 'border-foreground bg-muted' : 'border-border hover:bg-muted'}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="icon" type="button" aria-label={label} disabled={disabled} />}><IconView value={value} /></PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${label.toLowerCase()}s`} />
        <Tabs value={tab} onValueChange={(v) => setTab(v as string)}>
          <TabsList aria-label={label}><TabsTrigger value="icons">Icons</TabsTrigger><TabsTrigger value="emoji">Emoji</TabsTrigger></TabsList>
          <TabsContent value="icons" className="mt-2 max-h-56 overflow-y-auto">
            {!names.length && <p className="px-1 py-2 text-[13px] text-muted-foreground">Nothing found.</p>}
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icons">
              {names.map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={n} title={n} className={tile(value === n)} onClick={() => pick(n)}><IconView value={n} /></button>)}
            </div>
          </TabsContent>
          <TabsContent value="emoji" className="mt-2 max-h-56 overflow-y-auto">
            {!emojis.length && <p className="px-1 py-2 text-[13px] text-muted-foreground">Nothing found.</p>}
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Emoji">
              {emojis.map((e) => <button key={e.char} type="button" role="radio" aria-checked={value === emojiValue(e.char)} aria-label={e.words.split(' ')[0] || e.char} title={e.words} className={tile(value === emojiValue(e.char))} onClick={() => pick(emojiValue(e.char))}><span aria-hidden>{e.char}</span></button>)}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
