// ─── Button / IconButton ─────────────────────────────────────────────────────
// Tones, not Mantine variants: a screen says what the action IS, the theme
// decides how that looks. Only `primary` wears the accent.
import React, { forwardRef } from 'react';
import {
  ActionIcon, Button as MButton,
  type ActionIconProps, type ButtonProps as MButtonProps,
} from '@mantine/core';
import type { LucideIcon } from 'lucide-react';

import { Tooltip } from './Tooltip';
import type { ShortcutName } from './shortcuts';

export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet-danger' | 'ai';

const TONE: Record<ButtonTone, Pick<MButtonProps, 'variant' | 'color'>> = {
  primary:        { variant: 'filled',  color: 'ink' },
  secondary:      { variant: 'default' },
  ghost:          { variant: 'subtle',  color: 'gray' },
  danger:         { variant: 'filled',  color: 'err' },
  'quiet-danger': { variant: 'subtle',  color: 'err' },
  ai:             { variant: 'light',   color: 'ai' },
};

type Size = 'xs' | 'sm' | 'md' | 'lg';

export type ButtonProps = Omit<MButtonProps, 'variant' | 'color' | 'leftSection' | 'rightSection'> &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color' | 'style'> & {
    tone?: ButtonTone;
    size?: Size;
    /** Leading icon (component or node). */
    icon?: LucideIcon | React.ReactNode;
    trailing?: React.ReactNode;
    /** Show this shortcut in a tooltip. Does NOT bind it — see useFormHotkeys. */
    shortcut?: ShortcutName | string;
    /** Tooltip text; defaults to the label when a shortcut is given. */
    hint?: React.ReactNode;
    style?: React.CSSProperties;
  };

function renderIcon(icon: ButtonProps['icon']) {
  if (!icon) return undefined;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && 'render' in (icon as object))) {
    const I = icon as LucideIcon;
    return <I strokeWidth={1.75} />;
  }
  return icon as React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'secondary', size = 'sm', icon, trailing, shortcut, hint, children, ...rest }, ref,
) {
  const btn = (
    <MButton ref={ref} size={size} {...TONE[tone]}
      leftSection={renderIcon(icon)} rightSection={trailing} {...rest}>
      {children}
    </MButton>
  );
  if (!shortcut && !hint) return btn;
  return <Tooltip label={hint ?? children} shortcut={shortcut}>{btn}</Tooltip>;
});

export type IconButtonProps = Omit<ActionIconProps, 'children' | 'variant' | 'color'> &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color' | 'style'> & {
    icon: LucideIcon;
    /** Required: becomes the aria-label and the tooltip. */
    label: string;
    tone?: 'ghost' | 'secondary' | 'primary' | 'danger';
    shortcut?: ShortcutName | string;
    active?: boolean;
    style?: React.CSSProperties;
  };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: I, label, tone = 'ghost', shortcut, active, size = 'md', ...rest }, ref,
) {
  const look: Pick<ActionIconProps, 'variant' | 'color'> =
    active            ? { variant: 'light', color: 'ink' } :
    tone === 'primary' ? { variant: 'filled', color: 'ink' } :
    tone === 'danger'  ? { variant: 'subtle', color: 'err' } :
    tone === 'secondary' ? { variant: 'default' } :
                         { variant: 'subtle', color: 'gray' };
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <ActionIcon ref={ref} size={size} aria-label={label} aria-pressed={active} {...look} {...rest}>
        <I strokeWidth={1.75} />
      </ActionIcon>
    </Tooltip>
  );
});

/** Icon-only link styled like a secondary IconButton (downloads, external files). */
export function IconLink({ icon: I, label, href, download, target }: {
  icon: LucideIcon;
  label: string;
  href: string;
  download?: string | boolean;
  target?: string;
}) {
  return (
    <Tooltip label={label}>
      <ActionIcon component="a" href={href} download={download} target={target}
        rel={target === '_blank' ? 'noopener' : undefined}
        variant="default" size="md" aria-label={label}>
        <I strokeWidth={1.75} />
      </ActionIcon>
    </Tooltip>
  );
}
