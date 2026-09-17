// ─── Tabs and Segmented ──────────────────────────────────────────────────────
// Tabs switch between views of one thing (underline, weight marks the active
// one). Segmented switches a mode or a filter inline.
import React from 'react';
import { SegmentedControl, Tabs as MTabs, type SegmentedControlProps } from '@mantine/core';
import type { LucideIcon } from 'lucide-react';

export const Tabs = MTabs;

export interface TabItem<V extends string> {
  value: V;
  label: React.ReactNode;
  icon?: LucideIcon;
  /** A count rendered in mono after the label. */
  count?: number;
  disabled?: boolean;
}

/** Tab strip from data; pair it with <Tabs.Panel value=…> or use it alone as a switch. */
export function TabBar<V extends string>({ items, value, onChange, children }: {
  items: TabItem<V>[];
  value: V;
  onChange: (v: NoInfer<V>) => void;
  children?: React.ReactNode;
}) {
  return (
    <MTabs value={value} onChange={v => v && onChange(v as V)}>
      <MTabs.List>
        {items.map(({ value: v, label, icon: I, count, disabled }) => (
          <MTabs.Tab key={v} value={v} disabled={disabled}
            leftSection={I ? <I strokeWidth={1.75} /> : undefined}
            rightSection={count != null
              ? <span className="mono" style={{ color: 'var(--t3)', fontSize: 'var(--fs-xs)' }}>{count}</span>
              : undefined}>
            {label}
          </MTabs.Tab>
        ))}
      </MTabs.List>
      {children}
    </MTabs>
  );
}

export type SegmentedProps<V extends string> = Omit<SegmentedControlProps, 'value' | 'onChange' | 'data'> & {
  value: V;
  onChange: (v: NoInfer<V>) => void;
  data: (V | { value: V; label: React.ReactNode })[];
};

export function Segmented<V extends string>({ value, onChange, data, ...rest }: SegmentedProps<V>) {
  return (
    <SegmentedControl
      value={value}
      onChange={v => onChange(v as V)}
      data={data.map(d => typeof d === 'string' ? { value: d, label: d } : d) as SegmentedControlProps['data']}
      {...rest}
    />
  );
}
