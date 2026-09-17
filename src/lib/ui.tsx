// ─── Shared UI primitives (v2 API, v3 look) ──────────────────────────────────
// These keep the props every page already passes, and render through src/ui so
// the whole app picks up the "precision instrument" look in one place. New code
// should import from src/ui directly.
import React from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from './cn';
import {
  Badge, Button as UiButton, Segmented as UiSegmented,
  type ButtonTone, type StatusTone,
} from '../ui';

// Pill / badge
type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'err' | 'violet';
const PILL_TONE: Record<Tone, StatusTone> = {
  neutral: 'neutral', brand: 'accent', ok: 'ok', warn: 'warn', err: 'err', violet: 'ai',
};

export function Pill({
  tone = 'neutral', children, className = '', dot = false,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return <Badge tone={PILL_TONE[tone]} dot={dot} className={className}>{children}</Badge>;
}

// Card — a hairline frame. Reach for it only when content is one unit.
export function Card({
  className = '', children, padded = true,
}: {
  className?: string;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div className={cn(
      'min-w-0 rounded-panel border border-line',
      padded && 'p-4',
      className,
    )}>{children}</div>
  );
}

export function CardTitle({
  title, sub, right, className = '',
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 mb-3', className)}>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-fg leading-snug tracking-tight">{title}</h3>
        {sub && <p className="text-xs text-fg-3 mt-0.5 leading-snug">{sub}</p>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('eyebrow', className)}>{children}</div>;
}

// Segmented control
type SegOption<V> = V | { value: V; label: string };

export function Segmented<V extends string | number>({
  value, onChange, options, size = 'sm',
}: {
  value: V;
  onChange: (v: V) => void;
  options: SegOption<V>[];
  size?: 'sm' | 'md';
}) {
  // Mantine's control works in strings; numbers round-trip through the map.
  const byKey = new Map(options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    return [String(v), v] as const;
  }));
  return (
    <UiSegmented
      size={size === 'sm' ? 'xs' : 'sm'}
      value={String(value)}
      onChange={k => { const v = byKey.get(k); if (v !== undefined) onChange(v); }}
      data={options.map(o => typeof o === 'object'
        ? { value: String(o.value), label: o.label }
        : { value: String(o), label: String(o) })}
    />
  );
}

// Button
type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> & {
  tone?: 'primary' | 'dark' | 'ghost' | 'outline' | 'success' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  Icon?: LucideIcon;
};
const BTN_TONE: Record<NonNullable<ButtonProps['tone']>, ButtonTone> = {
  primary: 'primary', dark: 'primary', ghost: 'ghost', outline: 'secondary',
  success: 'primary', danger: 'danger',
};

export function Button({
  tone = 'primary', size = 'md', className = '', Icon, children, style, ...props
}: ButtonProps) {
  return (
    <UiButton
      {...props}
      tone={BTN_TONE[tone]}
      size={size === 'lg' ? 'md' : 'sm'}
      icon={Icon}
      className={className}
      style={style}
    >
      {children}
    </UiButton>
  );
}

// Status dot
export function StatusDot({ status, size = 8 }: { status: 'ok' | 'err' | 'warn' | 'skip'; size?: number }) {
  const map = { ok: 'var(--ok)', err: 'var(--err)', warn: 'var(--warn)', skip: 'var(--t4)' };
  const px = `calc(var(--sp-2) * ${size / 8})`;
  return <span className="inline-block rounded-full shrink-0" style={{ width: px, height: px, background: map[status] || map.warn }} />;
}

// Sparkline
export function Sparkline({
  data, width = 80, height = 24, color = 'var(--accent)', fill = 'var(--accent-soft)',
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
}) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const r = max - min || 1;
  const step = width / (data.length - 1 || 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / r) * (height - 4) - 2] as const);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg className="chart block" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={area} style={{ fill }} />
      <path d={d} fill="none" style={{ stroke: color }} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Trend indicator
export function Trend({
  value, suffix = '%', invert = false,
}: {
  value: number;
  suffix?: string;
  invert?: boolean;
}) {
  if (!isFinite(value)) value = 0;
  const positive = value >= 0;
  const good = invert ? !positive : positive;
  return (
    <span className={cn('inline-flex items-center gap-0.5 mono text-xs', good ? 'text-ok' : 'text-err')}>
      {positive ? '↑' : '↓'} {positive ? '+' : ''}{value.toFixed(1)}{suffix}
    </span>
  );
}

// Formatters
export function fmtMoney(n: number | null | undefined, cur = '£') {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${cur}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${cur}${(n / 1_000).toFixed(1)}k`;
  return `${cur}${Math.round(n).toLocaleString()}`;
}
export function fmtMoneyFull(n: number | null | undefined, cur = '£') {
  if (n == null) return '—';
  return `${cur}${Math.round(n).toLocaleString()}`;
}
export function fmtDur(s: number | null | undefined) {
  if (s == null || !isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}
export function relTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const diff = Date.now() - +new Date(iso);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
export function pctChange(cur: number, prev: number) {
  if (prev === 0) return cur > 0 ? 100 : 0;
  return ((cur - prev) / prev) * 100;
}
// Full GBP with 2 decimals: £1,234.50 (EL Pricer line items)
export function fmtGBP(n: number | null | undefined, cur = '£') {
  if (n == null) return '—';
  return `${cur}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── v2 primitives ───────────────────────────────────────────────────────────

// Vertical bar chart
export function MiniBars({
  data, height = 132, color = 'var(--accent)',
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 22);
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 group min-w-0">
            <span className="mono text-2xs text-fg-3 opacity-0 group-hover:opacity-100 transition-opacity">{d.value}</span>
            <div className="w-full rounded-t-control transition-colors"
              style={{ height: Math.max(2, h), background: d.value ? color : 'var(--line)' }} />
            <span className="mono text-2xs text-fg-4 truncate w-full text-center">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// KPI stat — a labelled figure. In a KpiBand it is a cell between hairlines.
export function KpiTile({
  icon: IconCmp, label, value, sub, accent = 'brand', boxed = false,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub: string;
  accent?: 'brand' | 'ok' | 'err' | 'violet' | 'amber';
  /** Framed on its own instead of sitting in a KpiBand. */
  boxed?: boolean;
}) {
  const tone: Record<string, string> = {
    brand: 'text-accent-text', ok: 'text-ok', err: 'text-err', violet: 'text-ai', amber: 'text-warn',
  };
  return (
    <div className={cn(
      'min-w-0',
      boxed ? 'p-4 rounded-panel border border-line bg-surface' : 'py-4 px-4',
    )}>
      <div className="flex items-center gap-1.5 min-w-0">
        <IconCmp className={cn('w-3.5 h-3.5 shrink-0', tone[accent] || tone.brand)} strokeWidth={1.75} />
        <span className="eyebrow flex-1 min-w-0 truncate">{label}</span>
      </div>
      <p className={cn(
        'mono font-medium leading-none tracking-tight text-fg',
        boxed ? 'mt-2.5 text-2xl' : 'mt-3 text-3xl',
      )}>{value}</p>
      <p className="mt-1.5 text-xs text-fg-3 truncate">{sub}</p>
    </div>
  );
}

// KPI band: figures in a row, divided by hairlines — no box around them.
export function KpiBand({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 border-y border-line divide-x divide-line [&>*:first-child]:pl-0">
      {children}
    </div>
  );
}

// Form-field wrapper — same label treatment as the Mantine inputs.
export function Field({
  label, required, hint, children,
}: {
  label?: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <label className="block text-xs font-medium text-fg-2 mb-1">
          {label}{required && <span className="text-err"> *</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-xs text-fg-3 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

// Styled text input — matches src/ui Input for places that need a bare <input>.
export function TextInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={cn(
        'w-full h-h-sm px-2.5 rounded-control text-sm bg-surface border border-line-2 text-fg',
        'placeholder:text-fg-4 transition-colors duration-fast',
        'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
        'disabled:bg-subtle disabled:text-fg-4',
        className,
      )} />
  );
}
