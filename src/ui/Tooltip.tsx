// ─── Tooltip with shortcut hint ──────────────────────────────────────────────
import React from 'react';
import { Tooltip as MTooltip, type TooltipProps as MTooltipProps } from '@mantine/core';

import { Shortcut, type ShortcutName } from './shortcuts';

export type TooltipProps = Omit<MTooltipProps, 'label'> & {
  label: React.ReactNode;
  shortcut?: ShortcutName | string;
};

export function Tooltip({ label, shortcut, children, ...rest }: TooltipProps) {
  if (!label && !shortcut) return <>{children}</>;
  return (
    <MTooltip
      {...rest}
      label={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          {label}
          {shortcut && <Shortcut keys={shortcut} />}
        </span>
      }
    >
      {children}
    </MTooltip>
  );
}
