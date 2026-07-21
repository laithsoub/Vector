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
    neutral:  'bg-[var(--s3)] text-[var(--t2)] border-[var(--line)]',
    brand:    'bg-[var(--accent-soft)] text-[var(--accent-text)] border-[var(--accent-line)]',
    ok:       'bg-[var(--ok-soft)] text-[var(--ok)] border-transparent',
    warn:     'bg-[var(--warn-soft)] text-[var(--warn)] border-transparent',
    err:      'bg-[var(--err-soft)] text-[var(--err)] border-transparent',
    violet:   'bg-[var(--violet-soft)] text-[var(--violet)] border-transparent',
  };
  const dotColor: Record<Tone, string> = {
    neutral: 'var(--t3)', brand: 'var(--accent)', ok: 'var(--ok)',
    warn: 'var(--warn)', err: 'var(--err)', violet: 'var(--violet)',
  };
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold border whitespace-nowrap',
      tones[tone], className,
    )}>
      {dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor[tone] }} />}
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
      'v3-card rounded-[16px]',
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
        <h3 className="text-[13px] font-semibold text-[var(--t1)] leading-none tracking-tight">{title}</h3>
        {sub && <p className="text-[11.5px] text-[var(--t3)] mt-1.5 leading-tight">{sub}</p>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      'text-[10px] font-semibold tracking-[0.14em] uppercase text-[var(--t3)]',
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
      'inline-flex items-center p-0.5 rounded-[9px] bg-[var(--s3)]',
      size === 'sm' ? 'text-[11.5px]' : 'text-xs',
    )}>
      {options.map(opt => {
        const v = typeof opt === 'object' ? opt.value : opt;
        const l = typeof opt === 'object' ? opt.label : String(opt);
        const active = value === v;
        return (
          <button key={String(v)} onClick={() => onChange(v)}
            style={active ? { boxShadow: 'var(--card-sh)' } : undefined}
            className={cn(
              'px-2.5 py-1 rounded-[7px] font-medium transition-colors',
              active
                ? 'bg-[var(--s1)] text-[var(--t1)]'
                : 'text-[var(--t3)] hover:text-[var(--t1)]',
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
    primary:   'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-ink)] v3-glow',
    dark:      'bg-[var(--t1)] text-[var(--bg)] hover:opacity-90',
    ghost:     'bg-transparent text-[var(--t2)] hover:bg-[var(--s3)] hover:text-[var(--t1)]',
    outline:   'border border-[var(--line-2)] bg-[var(--s2)] text-[var(--t1)] hover:bg-[var(--s-hover)]',
    success:   'bg-[var(--ok)] hover:opacity-90 text-white',
    danger:    'bg-[var(--err)] hover:opacity-90 text-white',
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
  const map = { ok: 'var(--ok)', err: 'var(--err)', warn: 'var(--warn)', skip: 'var(--t3)' };
  return <span className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: map[status] || map.warn }} />;
}

// Sparkline
export function Sparkline({
  data, width = 80, height = 24, color = '#5b8cff', fill = 'rgba(91,140,255,0.14)',
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
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums"
      style={{ color: good ? 'var(--ok)' : 'var(--err)' }}>
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
    <div className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 22);
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 group min-w-0">
            <span className="text-[9px] text-[var(--t3)] tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">{d.value}</span>
            <div className="w-full rounded-t-[3px] transition-colors"
              style={{ height: Math.max(2, h), background: d.value ? color : 'var(--s3)', opacity: d.value ? 1 : 0.55 }} />
            <span className="text-[8.5px] text-[var(--t3)] tabular-nums truncate w-full text-center">{d.label}</span>
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
  const tones: Record<string, { c: string; b: string }> = {
    brand:  { c: 'var(--accent-text)', b: 'var(--accent-soft)' },
    ok:     { c: 'var(--ok)',          b: 'var(--ok-soft)' },
    err:    { c: 'var(--err)',         b: 'var(--err-soft)' },
    violet: { c: 'var(--violet)',      b: 'var(--violet-soft)' },
    amber:  { c: 'var(--warn)',        b: 'var(--warn-soft)' },
  };
  const t = tones[accent] || tones.brand;
  return (
    <Card className="!rounded-[14px] !p-[17px]">
      <div className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center" style={{ color: t.c, background: t.b }}>
        <IconCmp className="w-4 h-4" strokeWidth={1.9} />
      </div>
      <p className="mt-3.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--t3)]">{label}</p>
      <p className="text-[27px] font-semibold tracking-[-0.03em] tabular-nums mt-0.5 leading-none text-[var(--t1)]">{value}</p>
      <p className="text-[11px] text-[var(--t3)] mt-1.5">{sub}</p>
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
        <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-2">
          {label} {required && <span className="normal-case" style={{ color: 'var(--err)' }}>*</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-[10px] text-[var(--t4)] mt-2 leading-relaxed">{hint}</p>}
    </div>
  );
}

// Styled text input
export function TextInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={cn('w-full h-[34px] px-[11px] rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none transition-colors', className)} />
  );
}
