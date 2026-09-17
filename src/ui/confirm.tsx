// ─── confirm() ───────────────────────────────────────────────────────────────
// Promise-shaped, so `if (!window.confirm(x)) return;` becomes
// `if (!await confirm({ ... })) return;` and the flow around it is unchanged.
//
// The three presets cover the actions that must never happen by accident:
//   confirm.send({ to, subject })     — an email leaves the building
//   confirm.remove({ what })          — a delete
//   confirm.overwrite({ what })       — a price or file is replaced
import React from 'react';
import { Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';

import { Shortcut } from './shortcuts';

export interface ConfirmOptions {
  title: React.ReactNode;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = destructive (red confirm). */
  tone?: 'primary' | 'danger';
  /** @deprecated use tone: 'danger' */
  danger?: boolean;
  /** Extra detail below the message, e.g. a recipient list or a diff. */
  detail?: React.ReactNode;
}

function open(o: ConfirmOptions): Promise<boolean> {
  const danger = o.tone === 'danger' || o.danger;
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    modals.openConfirmModal({
      title: o.title,
      children: (
        <Stack gap="sm">
          <Text size="sm" c="var(--t2)" style={{ whiteSpace: 'pre-line' }}>{o.message}</Text>
          {o.detail}
          <Text size="xs" c="var(--t3)">
            <Shortcut keys="Enter" /> to confirm · <Shortcut keys="close" /> to cancel
          </Text>
        </Stack>
      ),
      labels: { confirm: o.confirmLabel ?? 'Confirm', cancel: o.cancelLabel ?? 'Cancel' },
      confirmProps: { color: danger ? 'err' : 'ink', 'data-autofocus': true },
      cancelProps:  { variant: 'default' },
      groupProps:   { gap: 'sm', mt: 'lg' },
      onConfirm: () => finish(true),
      onCancel:  () => finish(false),
      onClose:   () => finish(false),
    });
  });
}

type ConfirmFn = typeof open & {
  send:      (o: { to: string; subject?: string; message?: React.ReactNode }) => Promise<boolean>;
  remove:    (o: { what: string; message?: React.ReactNode }) => Promise<boolean>;
  overwrite: (o: { what: string; message?: React.ReactNode }) => Promise<boolean>;
};

export const confirm: ConfirmFn = Object.assign(open, {
  send: ({ to, subject, message }: { to: string; subject?: string; message?: React.ReactNode }) => open({
    title: 'Send email',
    message: message ?? `This sends the email to ${to}. It cannot be recalled.`,
    detail: subject ? <Text size="sm" ff="monospace" c="var(--t1)">{subject}</Text> : undefined,
    confirmLabel: 'Send',
  }),
  remove: ({ what, message }: { what: string; message?: React.ReactNode }) => open({
    title: `Delete ${what}`,
    message: message ?? `Delete ${what}? This cannot be undone.`,
    confirmLabel: 'Delete',
    tone: 'danger',
  }),
  overwrite: ({ what, message }: { what: string; message?: React.ReactNode }) => open({
    title: `Replace ${what}`,
    message: message ?? `The existing ${what} will be replaced.`,
    confirmLabel: 'Replace',
    tone: 'danger',
  }),
});

/** v2 name, kept so existing call sites compile. */
export const confirmAsync = open;
