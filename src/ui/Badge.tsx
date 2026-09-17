// ─── Status badge ────────────────────────────────────────────────────────────
// A quiet tinted label. Colour carries status only: ok / warn / err, violet for
// anything Ask Vector produced, accent for "selected / yours", neutral else.
import React from 'react';
import { Badge as MBadge, type BadgeProps as MBadgeProps } from '@mantine/core';

export type StatusTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'ai';

const COLOR: Record<StatusTone, string> = {
  neutral: 'gray', accent: 'ink', ok: 'ok', warn: 'warn', err: 'err', ai: 'ai',
};

export type BadgeProps = Omit<MBadgeProps, 'color' | 'variant'> & {
  tone?: StatusTone;
  /** Leading dot instead of a tint — for dense tables. */
  dot?: boolean;
  /** Mono text, for codes and counts. */
  mono?: boolean;
  children?: React.ReactNode;
  title?: string;
};

export function Badge({ tone = 'neutral', dot, mono, style, ...rest }: BadgeProps) {
  return (
    <MBadge
      color={COLOR[tone]}
      variant={dot ? 'dot' : 'light'}
      style={{
        ...(mono ? { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' } : null),
        ...(tone === 'neutral' && !dot ? { color: 'var(--t2)', background: 'var(--s3)' } : null),
        ...(style as React.CSSProperties),
      }}
      {...rest}
    />
  );
}

/** Map common workflow states to a tone so screens don't each invent one. */
export function statusTone(status: string | null | undefined): StatusTone {
  const s = (status ?? '').toLowerCase();
  if (/^(done|processed|sent|ok|approved|filed|complete|completed|success|won)/.test(s)) return 'ok';
  if (/(fail|error|reject|lost|missing|cancel)/.test(s)) return 'err';
  if (/(hold|pending|wait|review|draft|stale|partial|needs)/.test(s)) return 'warn';
  if (/(ai|vector|suggest)/.test(s)) return 'ai';
  if (/(new|open|active|progress)/.test(s)) return 'accent';
  return 'neutral';
}
