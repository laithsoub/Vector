// ─── Menu ────────────────────────────────────────────────────────────────────
// The Mantine compound component, plus a data-driven ActionMenu for the common
// "⋯" row menu, with shortcut hints and a danger tone.
import React from 'react';
import { Menu as MMenu } from '@mantine/core';
import type { LucideIcon } from 'lucide-react';
import { MoreHorizontal } from 'lucide-react';

import { IconButton } from './Button';
import { Shortcut, type ShortcutName } from './shortcuts';

export const Menu = MMenu;

export type ActionMenuItem =
  | { label: React.ReactNode; onClick: () => void; icon?: LucideIcon; shortcut?: ShortcutName | string;
      danger?: boolean; disabled?: boolean }
  | { divider: true }
  | { heading: React.ReactNode };

export function ActionMenu({ items, label = 'More actions', target }: {
  items: ActionMenuItem[];
  label?: string;
  target?: React.ReactElement;
}) {
  return (
    <MMenu>
      <MMenu.Target>{target ?? <IconButton icon={MoreHorizontal} label={label} />}</MMenu.Target>
      <MMenu.Dropdown>
        {items.map((it, i) => {
          if ('divider' in it) return <MMenu.Divider key={i} />;
          if ('heading' in it) return <MMenu.Label key={i}>{it.heading}</MMenu.Label>;
          const I = it.icon;
          return (
            <MMenu.Item key={i} onClick={it.onClick} disabled={it.disabled}
              color={it.danger ? 'err' : undefined}
              leftSection={I ? <I strokeWidth={1.75} /> : undefined}
              rightSection={it.shortcut ? <Shortcut keys={it.shortcut} /> : undefined}>
              {it.label}
            </MMenu.Item>
          );
        })}
      </MMenu.Dropdown>
    </MMenu>
  );
}
