// ─── Numeric inputs ──────────────────────────────────────────────────────────
// Always mono, tabular and right-aligned so a column of fields reads like a
// column of figures. PriceInput formats as currency while you type.
import { forwardRef } from 'react';
import { NumberInput as MNumberInput, type NumberInputProps as MNumberInputProps } from '@mantine/core';

export type Currency = 'EUR' | 'GBP' | 'USD' | 'AED' | 'SAR' | 'HUF';

const SYMBOL: Record<Currency, string> = {
  EUR: '€', GBP: '£', USD: '$', AED: 'AED ', SAR: 'SAR ', HUF: 'Ft ',
};

const alignEnd = { input: { textAlign: 'end' as const } };

export type NumberInputProps = MNumberInputProps & { align?: 'start' | 'end' };

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { align = 'end', styles, ...rest }, ref,
) {
  return <MNumberInput ref={ref} styles={align === 'end' ? { ...alignEnd, ...(styles as object) } : styles} {...rest} />;
});

export type PriceInputProps = Omit<NumberInputProps, 'prefix' | 'decimalScale'> & {
  currency?: Currency;
  /** Decimal places; prices default to 2, fixed. */
  decimals?: number;
};

/** Money: currency symbol, thousands separator, fixed decimals. */
export const PriceInput = forwardRef<HTMLInputElement, PriceInputProps>(function PriceInput(
  { currency = 'EUR', decimals = 2, min = 0, ...rest }, ref,
) {
  return (
    <NumberInput ref={ref}
      prefix={SYMBOL[currency]}
      decimalScale={decimals}
      fixedDecimalScale
      thousandSeparator=","
      min={min}
      allowNegative={min < 0}
      {...rest} />
  );
});

/** Whole-unit quantities. */
export const QtyInput = forwardRef<HTMLInputElement, NumberInputProps>(function QtyInput(
  { min = 0, ...rest }, ref,
) {
  return <NumberInput ref={ref} allowDecimal={false} min={min} allowNegative={false} thousandSeparator="," {...rest} />;
});

/** Percentages (discounts, RPI). */
export const PercentInput = forwardRef<HTMLInputElement, NumberInputProps>(function PercentInput(
  { decimalScale = 2, ...rest }, ref,
) {
  return <NumberInput ref={ref} suffix="%" decimalScale={decimalScale} {...rest} />;
});

// ─── Formatting to match the inputs ──────────────────────────────────────────
const fmtCache = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat) {
  let f = fmtCache.get(key);
  if (!f) { f = make(); fmtCache.set(key, f); }
  return f;
}

export function formatMoney(n: number | null | undefined, currency: Currency = 'EUR', decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const f = nf(`m${currency}${decimals}`, () => new Intl.NumberFormat('en-GB', {
    style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }));
  return f.format(n);
}

export function formatQty(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return nf(`q${decimals}`, () => new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })).format(n);
}

export function formatPct(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${formatQty(n, decimals)}%`;
}
