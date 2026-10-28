import { toast as sonner } from 'sonner';
import { Toaster } from '@/ui/sonner';

// ---- toast: call toast('…') or toast('…', true) for failures; <Toaster /> (sonner) renders it ----
export { Toaster };
export const toast = (msg: string, bad = false, link?: { href: string; label: string }) =>
  (bad ? sonner.error : sonner.success)(msg, {
    duration: link ? 10000 : 4000,
    action: link && { label: link.label, onClick: () => { location.href = link.href; } },
  });
