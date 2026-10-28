import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/ui/alert-dialog';
import { Dialog as ShDialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/ui/sheet';
import { buttonDangerSolid } from './ui';

// ---- dialogs: shadcn Dialog (Base UI: focus trap, Esc, backdrop). `side` = right-hand sheet. Mounted = open; onClose fires on any close ----
export function Dialog({ title, onClose, children, wide, xl, side, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean; side?: boolean; footer?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const change = (o: boolean) => { if (!o) { setOpen(false); onClose(); } };
  if (side) return (
    <Sheet open={open} onOpenChange={change}>
      <SheetContent className="w-[min(34rem,100vw)] sm:max-w-none">
        <SheetHeader><SheetTitle className="text-base leading-6 font-semibold">{title}</SheetTitle></SheetHeader>
        <div className="grid min-h-0 grow content-start gap-4 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <SheetFooter className="shrink-0 border-t">{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
  return (
    <ShDialog open={open} onOpenChange={change}>
      <DialogContent className={cn('max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0', xl ? 'sm:max-w-3xl' : wide ? 'sm:max-w-lg' : 'sm:max-w-sm')}>
        <DialogHeader className="p-5 pb-0"><DialogTitle className="text-base leading-6 font-semibold">{title}</DialogTitle></DialogHeader>
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto p-5">{children}</div>
        {footer && <DialogFooter className="m-0 rounded-none bg-transparent px-5 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </ShDialog>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm, onClose, danger = true }: { title: string; body: string; action: string; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  const [open, setOpen] = useState(true);
  const [done, setDone] = useState(false);
  const close = () => { setOpen(false); onClose(); };
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && close()}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{body}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={danger ? buttonDangerSolid : undefined} disabled={done} onClick={() => { setDone(true); onConfirm(); close(); }}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
