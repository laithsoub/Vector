// ─── Shared UI primitives ────────────────────────────────────────────────────
import React from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from './cn';

// Pill / badge
type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'err' | 'violet';

export function Pill({
  tone = 'neutral', children, className = '', dot = false,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  const tones: Record<Tone, string> = {
    neutral:  'bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-300 ring-ink-200/60 dark:ring-ink-700/60',
    brand:    'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 ring-brand-200/60 dark:ring-brand-700/40',
    ok:       'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 ring-emerald-200/60 dark:ring-emerald-700/40',
    warn:     'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 ring-amber-200/60 dark:ring-amber-700/40',
    err:      'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 ring-red-200/60 dark:ring-red-700/40',
    violet:   'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-violet-200/60 dark:ring-violet-700/40',
  };
  const dotColor: Record<Tone, string> = {
    neutral: 'bg-ink-400', brand: 'bg-brand-500', ok: 'bg-emerald-500',
    warn: 'bg-amber-500', err: 'bg-red-500', violet: 'bg-violet-500',
  };
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium ring-1 ring-inset whitespace-nowrap',
      tones[tone], className,
    )}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', dotColor[tone])} />}
      {children}
    </span>
  );
}

// Card
export function Card({
  className = '', children, padded = true,
}: {
  className?: string;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div className={cn(
      'bg-white dark:bg-ink-900 ring-1 ring-ink-200/70 dark:ring-ink-800 rounded-xl',
      padded && 'p-5',
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
    <div className={cn('flex items-start justify-between gap-4 mb-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 leading-none tracking-tight">{title}</h3>
        {sub && <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-1.5 leading-tight">{sub}</p>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      'text-[10px] font-semibold tracking-[0.14em] uppercase text-ink-400 dark:text-ink-500',
      className,
    )}>{children}</div>
  );
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
  return (
    <div className={cn(
      'inline-flex items-center p-0.5 rounded-lg bg-ink-100 dark:bg-ink-800/80',
      size === 'sm' ? 'text-[11.5px]' : 'text-xs',
    )}>
      {options.map(opt => {
        const v = typeof opt === 'object' ? opt.value : opt;
        const l = typeof opt === 'object' ? opt.label : String(opt);
        const active = value === v;
        return (
          <button key={String(v)} onClick={() => onChange(v)}
            className={cn(
              'px-2.5 py-1 rounded-md font-medium transition-colors',
              active
                ? 'bg-white dark:bg-ink-700 text-ink-900 dark:text-ink-50 shadow-sm ring-1 ring-ink-200/70 dark:ring-ink-700'
                : 'text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-100',
            )}>{l}</button>
        );
      })}
    </div>
  );
}

// Button
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'dark' | 'ghost' | 'outline' | 'success' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  Icon?: LucideIcon;
};

export function Button({
  tone = 'primary', size = 'md', className = '', Icon, children, ...props
}: ButtonProps) {
  const tones = {
    primary:   'bg-brand-600 hover:bg-brand-700 text-white shadow-sm',
    dark:      'bg-ink-900 hover:bg-ink-800 text-white dark:bg-white dark:text-ink-900 dark:hover:bg-ink-100',
    ghost:     'bg-transparent text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800',
    outline:   'ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-ink-800 dark:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-800',
    success:   'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm',
    danger:    'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  };
  const sizes = {
    sm: 'h-7 px-2.5 text-[11.5px]',
    md: 'h-8 px-3 text-xs',
    lg: 'h-10 px-4 text-sm',
  };
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed',
        tones[tone], sizes[size], className,
      )}
    >
      {Icon && <Icon className={size === 'lg' ? 'w-4 h-4' : 'w-3.5 h-3.5'} strokeWidth={2} />}
      {children}
    </button>
  );
}

// Status dot
export function StatusDot({ status, size = 8 }: { status: 'ok' | 'err' | 'warn' | 'skip'; size?: number }) {
  const map = { ok: 'bg-emerald-500', err: 'bg-red-500', warn: 'bg-amber-500', skip: 'bg-ink-300 dark:bg-ink-600' };
  return <span className={cn('inline-block rounded-full shrink-0', map[status] || map.warn)} style={{ width: size, height: size }} />;
}

// Sparkline
export function Sparkline({
  data, width = 80, height = 24, color = '#0044a7', fill = 'rgba(0,68,167,0.12)',
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
      <path d={area} fill={fill} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
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
    <span className={cn(
      'inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums',
      good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
    )}>
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
  data, height = 132, color = '#0044a7',
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 22);
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 group min-w-0">
            <span className="text-[9px] text-ink-400 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">{d.value}</span>
            <div className="w-full rounded-t-[3px] transition-colors"
              style={{ height: Math.max(2, h), background: d.value ? color : '#ececef', opacity: d.value ? 1 : 0.55 }} />
            <span className="text-[8.5px] text-ink-400 tabular-nums truncate w-full text-center">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// KPI stat tile
export function KpiTile({
  icon: IconCmp, label, value, sub, accent = 'brand',
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub: string;
  accent?: 'brand' | 'ok' | 'err' | 'violet' | 'amber';
}) {
  const tones: Record<string, string> = {
    brand:  'text-brand-600 bg-brand-50 dark:bg-brand-900/30 dark:text-brand-300',
    ok:     'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300',
    err:    'text-red-600 bg-red-50 dark:bg-red-900/30 dark:text-red-300',
    violet: 'text-violet-600 bg-violet-50 dark:bg-violet-900/30 dark:text-violet-300',
    amber:  'text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-300',
  };
  return (
    <Card>
      <div className={cn('w-7 h-7 rounded-md flex items-center justify-center', tones[accent])}>
        <IconCmp className="w-3.5 h-3.5" strokeWidth={2} />
      </div>
      <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums mt-0.5">{value}</p>
      <p className="text-[10.5px] text-ink-500 dark:text-ink-400 mt-0.5">{sub}</p>
    </Card>
  );
}

// Form-field wrapper
export function Field({
  label, required, hint, children,
}: {
  label?: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {label && (
        <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500 mb-2">
          {label} {required && <span className="text-red-500 normal-case">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-[10px] text-ink-400 mt-2 leading-relaxed">{hint}</p>}
    </div>
  );
}

// Styled text input
export function TextInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={cn('w-full h-8 px-2.5 rounded-md text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 focus:ring-brand-400 focus:outline-none transition-shadow', className)} />
  );
}
