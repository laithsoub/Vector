// ─── Custom SVG charts (no external charting lib) ────────────────────────────
import React, { useState, useMemo, useRef } from 'react';
import { cn } from './cn';

function niceMax(n: number) {
  if (n <= 5) return 5;
  if (n <= 10) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const v = n / mag;
  if (v <= 1) return 1 * mag;
  if (v <= 2) return 2 * mag;
  if (v <= 5) return 5 * mag;
  return 10 * mag;
}

// ─── Stacked area chart ──────────────────────────────────────────────────────
export type DailyPoint = { label: string; ok: number; warn: number; err: number };

export function StackedAreaChart({
  days, height = 220,
}: {
  days: DailyPoint[];
  height?: number;
}) {
  const W = 880, H = height, padL = 36, padR = 12, padT = 12, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = useMemo(() => niceMax(Math.max(1, ...days.map(d => d.ok + d.err + d.warn))), [days]);
  const x = (i: number) => padL + (i / (days.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  const buildBand = (getTop: (d: DailyPoint, i: number) => number, getBottom: (d: DailyPoint, i: number) => number) => {
    const top    = days.map((d, i) => `${x(i)},${y(getTop(d, i))}`);
    const bottom = days.map((d, i) => `${x(i)},${y(getBottom(d, i))}`).reverse();
    return `M${top.join(' L')} L${bottom.join(' L')} Z`;
  };
  const okPath   = buildBand(d => d.ok,                       () => 0);
  const errPath  = buildBand(d => d.ok + d.err,               d => d.ok);
  const warnPath = buildBand(d => d.ok + d.err + d.warn,      d => d.ok + d.err);
  const linePath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.ok)}`).join(' ');

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => Math.round((max / ticks) * i));

  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((px - padL) / innerW) * (days.length - 1));
    if (idx >= 0 && idx < days.length) setHover(idx);
    else setHover(null);
  }

  const labelEvery = Math.max(1, Math.floor(days.length / 7));

  return (
    <div className="relative">
      <svg ref={svgRef} className="chart w-full" viewBox={`0 0 ${W} ${H}`}
           onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)}
                  stroke="currentColor" className="text-line" strokeDasharray="2 4" />
            <text x={padL - 8} y={y(t) + 3} textAnchor="end"
                  className="fill-fg-3" style={{ fontSize: 'var(--fs-2xs)' }}>{t}</text>
          </g>
        ))}
        <path d={okPath}   style={{ fill: 'var(--chart-1)' }} fillOpacity="0.85" />
        <path d={errPath}  style={{ fill: 'var(--err)' }} fillOpacity="0.85" />
        <path d={warnPath} style={{ fill: 'var(--warn)' }} fillOpacity="0.85" />
        <path d={linePath} style={{ stroke: 'var(--chart-1)' }} strokeWidth="1.25" fill="none" />

        {days.map((d, i) => (
          i % labelEvery === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle"
                  className="fill-fg-3" style={{ fontSize: 'var(--fs-2xs)' }}>{d.label}</text>
          ) : null
        ))}

        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB}
                  stroke="currentColor" className="text-fg-4" strokeWidth="1" />
            {[
              { v: days[hover].ok,                                   c: 'var(--chart-1)' },
              { v: days[hover].ok + days[hover].err,                 c: 'var(--err)' },
              { v: days[hover].ok + days[hover].err + days[hover].warn, c: 'var(--warn)' },
            ].map((p, i) => (
              <circle key={i} cx={x(hover)} cy={y(p.v)} r="3" style={{ fill: p.c, stroke: 'var(--s1)' }} strokeWidth="1.5" />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && (() => {
        const d = days[hover];
        const total = d.ok + d.err + d.warn;
        return (
          <div className="absolute top-3 left-12 px-3 py-2 rounded-panel border border-line-2 bg-raised shadow-float pointer-events-none mono text-xs">
            <p className="text-2xs text-fg-3 uppercase tracking-wide">{d.label}</p>
            <p className="font-semibold mt-1 text-fg">{total} jobs</p>
            <div className="flex gap-3 mt-1.5 text-2xs">
              <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--chart-1)' }}/>{d.ok}</span>
              <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--warn)' }}/>{d.warn}</span>
              <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--err)' }}/>{d.err}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Donut chart ─────────────────────────────────────────────────────────────
export function Donut({
  slices, size = 180, centerLabel, centerSub,
}: {
  slices: Array<{ label: string; value: number; color: string }>;
  size?: number;
  centerLabel?: React.ReactNode;
  centerSub?: React.ReactNode;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 4;
  const ir = r * 0.62;
  const cx = size / 2, cy = size / 2;
  let acc = -Math.PI / 2;
  const paths = slices.map(s => {
    const angle = (s.value / total) * Math.PI * 2;
    const a0 = acc, a1 = acc + angle;
    acc = a1;
    const large = angle > Math.PI ? 1 : 0;
    const p0 = [cx + Math.cos(a0) * r,  cy + Math.sin(a0) * r];
    const p1 = [cx + Math.cos(a1) * r,  cy + Math.sin(a1) * r];
    const q1 = [cx + Math.cos(a1) * ir, cy + Math.sin(a1) * ir];
    const q0 = [cx + Math.cos(a0) * ir, cy + Math.sin(a0) * ir];
    const d = `M${p0[0]},${p0[1]} A${r},${r} 0 ${large} 1 ${p1[0]},${p1[1]} L${q1[0]},${q1[1]} A${ir},${ir} 0 ${large} 0 ${q0[0]},${q0[1]} Z`;
    return { d, color: s.color };
  });
  return (
    <div className="flex items-center gap-5">
      <svg className="chart shrink-0" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {paths.map((p, i) => (<path key={i} d={p.d} style={{ fill: p.color }} />))}
        {centerLabel && (
          <g textAnchor="middle">
            <text x={cx} y={cy - 2} style={{ fill: 'var(--t1)', fontSize: 'var(--fs-2xl)', fontFamily: 'var(--font-mono)' }} fontWeight="500">{centerLabel}</text>
            {centerSub && <text x={cx} y={cy + 14} style={{ fill: 'var(--t3)', fontSize: 'var(--fs-2xs)' }}>{centerSub}</text>}
          </g>
        )}
      </svg>
      <div className="space-y-1.5 min-w-0 flex-1">
        {slices.map((s, i) => {
          const pct = ((s.value / total) * 100).toFixed(1);
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-fg-2 font-medium truncate">{s.label}</span>
              <span className="num text-fg-3 ml-auto pl-2">{pct}%</span>
              <span className="mono text-fg w-9 text-right">{s.value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Horizontal bars ─────────────────────────────────────────────────────────
export function HorizontalBars({
  items,
}: {
  items: Array<{ label: string; color: string; ok: number; err: number; warn: number; total: number }>;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-fg-3">No product data yet.</p>;
  }
  const max = Math.max(1, ...items.map(i => i.total));
  return (
    <div className="space-y-2.5">
      {items.map((it, i) => {
        const okPct   = (it.ok   / max) * 100;
        const warnPct = (it.warn / max) * 100;
        const errPct  = (it.err  / max) * 100;
        const successRate = it.total === 0 ? 0 : (it.ok / it.total) * 100;
        return (
          <div key={i}>
            <div className="flex items-baseline justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-sm" style={{ background: it.color }} />
                <span className="text-xs font-medium text-fg">{it.label}</span>
              </div>
              <span className="text-xs text-fg-3 mono">
                {it.total} <span className="text-fg-4">·</span> {successRate.toFixed(0)}% ok
              </span>
            </div>
            <div className="relative h-1 rounded-full bg-line overflow-hidden">
              <div className="absolute inset-y-0 left-0" style={{ width: `${okPct}%`, background: 'var(--chart-1)' }} />
              <div className="absolute inset-y-0" style={{ left: `${okPct}%`, width: `${warnPct}%`, background: 'var(--warn)' }} />
              <div className="absolute inset-y-0" style={{ left: `${okPct + warnPct}%`, width: `${errPct}%`, background: 'var(--err)' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────
export function Heatmap({
  grid, hours, days, max,
}: {
  grid: number[][];
  hours: string[];
  days: string[];
  max: number;
}) {
  const cell = 18, gap = 3;
  const w = hours.length * (cell + gap);
  const h = days.length * (cell + gap);
  return (
    <svg className="chart block" width={w + 30} height={h + 22} viewBox={`0 0 ${w + 30} ${h + 22}`}>
      {hours.map((hr, i) => (
        (i % 3 === 0) && <text key={hr} x={30 + i * (cell + gap) + cell / 2} y={10}
                                textAnchor="middle" className="fill-fg-3" style={{ fontSize: 'var(--fs-2xs)' }}>{hr}</text>
      ))}
      {days.map((day, di) => (
        <g key={day}>
          <text x={26} y={18 + di * (cell + gap) + cell / 2 + 3}
                textAnchor="end" className="fill-fg-3" style={{ fontSize: 'var(--fs-2xs)' }}>{day}</text>
          {hours.map((hr, hi) => {
            const v = grid[di]?.[hi] || 0;
            const opacity = v === 0 ? 0.08 : Math.max(0.12, v / max);
            return (
              <rect key={hr}
                    x={30 + hi * (cell + gap)} y={18 + di * (cell + gap)}
                    width={cell} height={cell} rx={3}
                    style={{ fill: 'var(--chart-1)' }} fillOpacity={opacity}>
                <title>{day} {hr}:00 — {v} jobs</title>
              </rect>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

// ─── Stacked-bar chart (small, for History) ──────────────────────────────────
export function MiniStackedBars({ days }: { days: DailyPoint[] }) {
  const max = Math.max(1, ...days.map(d => d.ok + d.err + d.warn));
  return (
    <div className="flex items-stretch gap-1.5 h-24">
      {days.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5 group h-full">
          <div className="w-full flex-1 flex flex-col-reverse rounded-t-control overflow-hidden border-b border-line-2">
            <div className="w-full" style={{ height: `${(d.ok / max) * 100}%`, background: 'var(--chart-1)' }} />
            <div className="w-full" style={{ height: `${(d.warn / max) * 100}%`, background: 'var(--warn)' }} />
            <div className="w-full" style={{ height: `${(d.err / max) * 100}%`, background: 'var(--err)' }} />
          </div>
          <span className="text-2xs text-fg-3 mono">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Mini bar chart (single series, for Dashboard) ───────────────────────────
export function MiniBars({ data, color = 'var(--chart-1)' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="flex items-stretch gap-2 h-32 px-1">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5 group h-full">
          <div className="w-full flex-1 flex items-end relative">
            <div className="w-full rounded-t-control transition-colors group-hover:opacity-90"
                 style={{ height: `${(d.value / max) * 100}%`, minHeight: 2, background: color }} />
            <span className="opacity-0 group-hover:opacity-100 absolute -top-5 left-1/2 -translate-x-1/2 text-2xs font-semibold num text-fg-2">{d.value}</span>
          </div>
          <span className="text-2xs text-fg-3 mono truncate w-full text-center">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Product colour map (matches server.ts) ──────────────────────────────────
export const PRODUCT_COLORS: Record<string, string> = {
  'PDC':              'var(--cat-1)',
  'ICP':              'var(--cat-2)',
  'EL':               'var(--cat-3)',
  'FIRE':             'var(--cat-4)',
  'MV-COMBINATION':   'var(--cat-5)',
  'MV-SWITCHGEAR':    'var(--cat-6)',
  'MV-TRANSFORMER':   'var(--cat-7)',
  'DPQ':              'var(--cat-8)',
  'CPS':              'var(--cat-9)',
  'EVCI':             'var(--cat-10)',
  'ENERGY STORAGE':   'var(--cat-11)',
  'EL & FIRE':        'var(--cat-12)',
};
