// ─── Tables ──────────────────────────────────────────────────────────────────
// The hero of the app. DataTable takes column definitions and gets the rules
// right by construction: sticky header, numbers in mono and right-aligned,
// subtle row hover, optional footer totals, keyboard-selectable rows.
import React from 'react';
import { ScrollArea, Table as MTable, type TableProps } from '@mantine/core';

import { extClasses } from './theme';
import { EmptyState } from './EmptyState';

export const Table = MTable;

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Cell content; defaults to row[key]. */
  render?: (row: T, index: number) => React.ReactNode;
  /** `num` = mono, tabular, right-aligned. Use for every price, qty, %. */
  kind?: 'text' | 'num' | 'code';
  align?: 'start' | 'center' | 'end';
  /** CSS width, e.g. 'var(--sp-16)' or '12ch'. */
  width?: string;
  /** Footer cell (totals). */
  footer?: React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => React.Key;
  onRowClick?: (row: T) => void;
  selectedKey?: React.Key | null;
  /** Max height before the body scrolls under the sticky header. */
  maxHeight?: string;
  empty?: React.ReactNode;
  caption?: React.ReactNode;
  dense?: boolean;
  striped?: boolean;
  /** Fixed layout (default): columns keep their widths and long text truncates. */
  fixed?: boolean;
  /** Let cell text wrap instead of truncating on one line. */
  wrap?: boolean;
  tableProps?: Omit<TableProps, 'children'>;
}

const monoCell: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums slashed-zero',
};

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, selectedKey, maxHeight, empty, caption,
  dense, striped, tableProps, fixed = true, wrap = false,
}: DataTableProps<T>) {
  const hasFooter = columns.some(c => c.footer !== undefined);

  const cellProps = (c: Column<T>) => {
    const align = c.align ?? (c.kind === 'num' ? 'end' : 'start');
    return {
      className: c.kind === 'num' ? extClasses.tableNum : undefined,
      style: {
        textAlign: align,
        width: c.width,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: wrap ? undefined : 'nowrap',
        ...(c.kind === 'code' ? monoCell : null),
      } as React.CSSProperties,
    };
  };

  if (rows.length === 0 && empty !== null) {
    return typeof empty === 'object' && empty
      ? <>{empty}</>
      : <EmptyState title={empty ?? 'Nothing to show'} compact />;
  }

  const table = (
    <MTable
      verticalSpacing={dense ? 'var(--sp-1)' : undefined}
      striped={striped}
      layout={fixed ? 'fixed' : 'auto'}
      {...tableProps}
    >
      {caption && <MTable.Caption>{caption}</MTable.Caption>}
      <MTable.Thead>
        <MTable.Tr>
          {columns.map(c => <MTable.Th key={c.key} {...cellProps(c)}>{c.header}</MTable.Th>)}
        </MTable.Tr>
      </MTable.Thead>
      <MTable.Tbody>
        {rows.map((row, i) => {
          const key = rowKey(row, i);
          const selected = selectedKey != null && key === selectedKey;
          return (
            <MTable.Tr key={key}
              data-selected={selected || undefined}
              aria-selected={onRowClick ? selected : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? e => { if (e.key === 'Enter') onRowClick(row); } : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}>
              {columns.map(c => (
                <MTable.Td key={c.key} {...cellProps(c)}>
                  {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                </MTable.Td>
              ))}
            </MTable.Tr>
          );
        })}
      </MTable.Tbody>
      {hasFooter && (
        <MTable.Tfoot>
          <MTable.Tr>
            {columns.map(c => <MTable.Td key={c.key} {...cellProps(c)}>{c.footer}</MTable.Td>)}
          </MTable.Tr>
        </MTable.Tfoot>
      )}
    </MTable>
  );

  return maxHeight
    ? <ScrollArea.Autosize mah={maxHeight} type="auto">{table}</ScrollArea.Autosize>
    : table;
}

/** Inline mono figure outside a table (totals, KPI values, ids in prose). */
export function Num({ children, tone, strong, className }: {
  children: React.ReactNode;
  tone?: 'ok' | 'warn' | 'err' | 'muted';
  strong?: boolean;
  className?: string;
}) {
  const color = tone === 'muted' ? 'var(--t3)' : tone ? `var(--${tone})` : undefined;
  return (
    <span className={['mono', className].filter(Boolean).join(' ')}
      style={{ color, fontWeight: strong ? 'var(--fw-semibold)' : undefined }}>
      {children}
    </span>
  );
}
