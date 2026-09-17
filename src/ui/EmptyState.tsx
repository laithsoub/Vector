// ─── Empty state ─────────────────────────────────────────────────────────────
// No illustration, no box: an icon, one line of what is missing, one line of
// why or what to do, and at most one action.
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

export function EmptyState({ icon: I = Inbox, title, description, action, compact }: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Tighter padding for use inside a table or panel. */
  compact?: boolean;
}) {
  return (
    <div role="status" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
      gap: 'var(--sp-2)',
      padding: compact ? 'var(--sp-6) var(--sp-4)' : 'var(--sp-12) var(--sp-6)',
      color: 'var(--t3)',
    }}>
      <I strokeWidth={1.5} style={{ width: 'var(--icon-lg)', height: 'var(--icon-lg)', color: 'var(--t4)' }} />
      <p style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-medium)', color: 'var(--t2)' }}>{title}</p>
      {description && (
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', maxWidth: 'var(--measure)', lineHeight: 'var(--lh-body)' }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: 'var(--sp-2)' }}>{action}</div>}
    </div>
  );
}
