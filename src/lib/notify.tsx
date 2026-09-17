// ─── Toasts and confirm dialogs ──────────────────────────────────────────────
// Mantine supplies the behaviour we kept hand-rolling badly: a toast stack that
// can be updated in place, and a one-line confirm dialog. Kept out of
// mantine.tsx so that file exports only a component and stays Fast-Refreshable.
import React from 'react';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

const ICON = 'w-[15px] h-[15px]';
const TONE = {
  ok:   { color: 'var(--ok)',     node: <CheckCircle2  className={ICON} strokeWidth={2} /> },
  err:  { color: 'var(--err)',    node: <AlertCircle   className={ICON} strokeWidth={2} /> },
  warn: { color: 'var(--warn)',   node: <AlertTriangle className={ICON} strokeWidth={2} /> },
  info: { color: 'var(--accent)', node: <Info          className={ICON} strokeWidth={2} /> },
};
export type ToastType = keyof typeof TONE;

/** Drop-in for the old hand-rolled `toast(type, msg)` — same signature, so the
 *  20 pages that call it need no edit. */
export function notify(type: ToastType, msg: string) {
  const tone = TONE[type] ?? TONE.info;
  notifications.show({ message: msg, color: tone.color, icon: tone.node });
}

let _taskId = 0;

/** A toast that starts as a spinner and is later resolved in place, for work
 *  with a real duration ("Pricing 12 lines…" → "Priced 12 lines"). */
export function notifyProgress(message: string) {
  const id = `vec-task-${++_taskId}`;
  notifications.show({ id, message, loading: true, autoClose: false, allowClose: false });
  const settle = (type: ToastType, m: string, ms: number) =>
    notifications.update({
      id, message: m, loading: false, allowClose: true, autoClose: ms,
      color: TONE[type].color, icon: TONE[type].node,
    });
  return {
    done: (m: string) => settle('ok',  m, 4000),
    fail: (m: string) => settle('err', m, 7000),
    /** Keep the spinner, change the wording ("Step 2 of 3…"). */
    step: (m: string) => notifications.update({ id, message: m, loading: true, autoClose: false }),
  };
}

/** Promise-shaped confirm, so an existing `if (!confirm(...)) return;` becomes
 *  `if (!await confirmAsync(...)) return;` and the surrounding flow is unchanged. */
export function confirmAsync(opts: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    modals.openConfirmModal({
      title: opts.title,
      size: 400,
      children: (
        <p className="text-[12px] leading-relaxed text-[var(--t2)] whitespace-pre-line">
          {opts.message}
        </p>
      ),
      labels: { confirm: opts.confirmLabel ?? 'Confirm', cancel: opts.cancelLabel ?? 'Cancel' },
      confirmProps: { color: opts.danger ? 'var(--err)' : 'var(--accent)', size: 'sm' },
      cancelProps:  { variant: 'default', size: 'sm' },
      onConfirm: () => finish(true),
      onCancel:  () => finish(false),
      onClose:   () => finish(false),
    });
  });
}
