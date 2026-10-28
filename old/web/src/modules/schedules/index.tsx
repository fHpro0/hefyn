import { CalendarClock } from 'lucide-react';
import type { WebModule } from '../registry';

// The schedules module's console parts: the "Scheduled" mark on chats a schedule started. The page itself is Schedules.tsx (route /schedules, web/src/entry.tsx).
export const schedulesWeb: WebModule = {
  id: 'schedules',
  chatBadges: [({ chat, variant }) => !chat.scheduled ? null : variant === 'header'
    ? <span className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-xs text-muted-foreground"><CalendarClock size={12} aria-hidden />Scheduled</span>
    : <span title="Scheduled" role="img" aria-label="Scheduled" className="flex shrink-0 text-muted-foreground"><CalendarClock size={12} strokeWidth={1.75} aria-hidden /></span>],
};
