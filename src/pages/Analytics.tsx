// ─── Analytics page — wired to /api/analytics ────────────────────────────────
import React, { useState, useEffect } from 'react';
import {
  Calendar, Download, TrendingUp, TrendingDown, AlertCircle, Loader2,
} from 'lucide-react';

import { cn } from '../lib/cn';
import {
  Card, CardTitle, Pill, Segmented, Sparkline, Trend, Button,
  fmtMoney, fmtMoneyFull, fmtDur, pctChange,
} from '../lib/ui';
import {
  StackedAreaChart, Donut, HorizontalBars, Heatmap, PRODUCT_COLORS,
} from '../lib/charts';
import { api } from '../lib/api';
import type { AnalyticsResponse } from '../types';

export function AnalyticsPage() {
  const [range, setRange] = useState<number>(30);
  const [data, setData]   = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.analytics(range)
      .then(r => { setData(r); setLoading(false); })
      .catch(e => { setError(e.message || 'Failed to load analytics'); setLoading(false); });
  }, [range]);

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 text-[var(--t3)]">
      <Loader2 className="w-5 h-5 animate-spin" />
      <p className="text-[12px] mt-3">Loading analytics…</p>
    </div>
  );
  if (error) return (
    <Card className="max-w-md mx-auto text-center py-10">
      <AlertCircle className="w-6 h-6 mx-auto" style={{ color: 'var(--err)' }} />
      <p className="text-[13px] font-semibold mt-3">Couldn't load analytics</p>
      <p className="text-[11.5px] text-[var(--t3)] mt-1">{error}</p>
    </Card>
  );
  if (!data) return null;

  const { totals, prevTotals, daily, byProduct, byCustomer, bySalesman, byStep, errorReasons, heatmap } = data;

  // Sparklines from daily
  const sparkVolume = daily.map(d => d.ok + d.err + d.warn);
  const sparkOkPct  = daily.map(d => {
    const t = d.ok + d.err + d.warn;
    return t === 0 ? 0 : (d.ok / t) * 100;
  });

  const statusSlices = [
    { label: 'Successful', value: totals.ok,   color: '#5b8cff' },
    { label: 'Errors',     value: totals.err,  color: '#f87171' },
    { label: 'Warnings',   value: totals.warn, color: '#fbbf24' },
  ];

  const stepTotal = (byStep['Step 1'] || 0) + (byStep['Step 2'] || 0);

  // Format date range string
  const from = new Date(data.range.from);
  const to   = new Date(data.range.to);
  const rangeLabel = `${from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  return (
    <div className="space-y-[22px]">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.025em]">Operational health</h2>
          <p className="text-[12px] text-[var(--t3)] mt-1">
            {totals.count.toLocaleString()} runs across {Math.min(range, daily.length)} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented value={range} onChange={v => setRange(Number(v))} options={[
            { value: 7,  label: '7d' },
            { value: 14, label: '14d' },
            { value: 30, label: '30d' },
            { value: 60, label: '60d' },
            { value: 90, label: '90d' },
          ]} />
          <Button tone="outline" Icon={Calendar} size="md">{rangeLabel}</Button>
        </div>
      </div>

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-[17px]">
        <HeroKpi label="Quotes processed"
                 value={totals.count.toLocaleString()}
                 trend={pctChange(totals.count, prevTotals.count)}
                 spark={sparkVolume} />
        <HeroKpi label="Success rate"
                 value={`${totals.okPct.toFixed(1)}%`}
                 trend={pctChange(totals.okPct, prevTotals.okPct)}
                 spark={sparkOkPct}
                 color="#10b981" fill="rgba(16,185,129,0.12)" />
        <HeroKpi label="Avg run time"
                 value={fmtDur(Math.round(totals.avgDur))}
                 trend={pctChange(totals.avgDur, prevTotals.avgDur)}
                 invert
                 spark={daily.map(_ => totals.avgDur)}
                 color="#7c3aed" fill="rgba(124,58,237,0.12)" />
        <HeroKpi label="Quote value pushed"
                 value={fmtMoney(totals.value)}
                 fullValue={fmtMoneyFull(totals.value)}
                 trend={pctChange(totals.value, prevTotals.value)}
                 spark={sparkVolume} />
      </div>

      {/* Main chart + status donut */}
      <div className="grid grid-cols-12 gap-[22px]">
        <Card className="col-span-12 lg:col-span-8" padded={false}>
          <div className="px-5 py-4 flex items-center justify-between border-b border-[var(--line)]">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Daily throughput</h3>
              <p className="text-[11.5px] text-[var(--t3)] mt-0.5">All runs by outcome · hover the chart</p>
            </div>
            <div className="flex items-center gap-3 text-[10.5px] text-[var(--t2)]">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--accent)' }}/>Successful</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--warn)' }}/>Warning</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--err)' }}/>Error</span>
            </div>
          </div>
          <div className="px-3 py-3">
            <StackedAreaChart days={daily} />
          </div>
        </Card>

        <Card className="col-span-12 lg:col-span-4">
          <CardTitle title="Outcome mix"
                     sub="Successful vs warning vs error"
                     right={<Pill tone="ok">{totals.okPct.toFixed(0)}% ok</Pill>} />
          <Donut slices={statusSlices}
                 centerLabel={totals.count.toLocaleString()}
                 centerSub="runs" />
        </Card>
      </div>

      {/* Product breakdown + Step split */}
      <div className="grid grid-cols-12 gap-[22px]">
        <Card className="col-span-12 lg:col-span-8">
          <CardTitle title="By product line"
                     sub="Volume and success rate per division" />
          <HorizontalBars items={byProduct
            .filter(p => p.total > 0)
            .map(p => ({
              label: p.label,
              color: PRODUCT_COLORS[p.code] || p.color || '#5b8cff',
              ok: p.ok, err: p.err, warn: p.warn, total: p.total,
            }))} />
        </Card>

        <Card className="col-span-12 lg:col-span-4 flex flex-col">
          <CardTitle title="Step 1 vs Step 2" sub="Where the work splits" />
          <div className="flex-1 flex flex-col justify-center gap-3">
            {[
              { name: 'Step 1 — Quotation list', value: byStep['Step 1'] || 0, color: 'var(--accent)' },
              { name: 'Step 2 — D&Q store',      value: byStep['Step 2'] || 0, color: 'var(--violet)' },
            ].map(s => {
              const pct = (s.value / (stepTotal || 1)) * 100;
              return (
                <div key={s.name}>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[11.5px] font-medium text-[var(--t1)]">{s.name}</span>
                    <span className="text-[11px] num text-[var(--t2)]">{s.value} <span className="text-[var(--t4)]">({pct.toFixed(0)}%)</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--s3)]">
                    <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: s.color }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-5 pt-4 border-t border-[var(--line)]">
            <Stat label="Total items" value={totals.items.toLocaleString()} />
            <Stat label="Avg items/run" value={(totals.count ? totals.items / totals.count : 0).toFixed(1)} />
          </div>
        </Card>
      </div>

      {/* Customers + Salesman */}
      <div className="grid grid-cols-12 gap-[22px]">
        <Card className="col-span-12 lg:col-span-7" padded={false}>
          <div className="px-5 py-4 flex items-center justify-between border-b border-[var(--line)]">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Top customers</h3>
              <p className="text-[11.5px] text-[var(--t3)] mt-0.5">By total value of successfully uploaded quotes</p>
            </div>
            <Pill tone="neutral">£ value</Pill>
          </div>
          <Leaderboard items={byCustomer.slice(0, 8).map(c => ({
            name: c.customer, primary: fmtMoney(c.value), secondary: `${c.count} runs${c.err > 0 ? ` · ${c.err} err` : ''}`,
            value: c.value,
          }))} maxValue={byCustomer[0]?.value || 1} barColor="var(--accent)" />
        </Card>

        <Card className="col-span-12 lg:col-span-5" padded={false}>
          <div className="px-5 py-4 flex items-center justify-between border-b border-[var(--line)]">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Inside Sales</h3>
              <p className="text-[11.5px] text-[var(--t3)] mt-0.5">Quotes credited per salesman</p>
            </div>
          </div>
          <Leaderboard items={bySalesman.slice(0, 8).map(s => ({
            name: s.salesman, primary: String(s.count), secondary: fmtMoney(s.value),
            value: s.value, avatar: s.salesman.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(),
          }))} maxValue={bySalesman[0]?.value || 1} barColor="var(--violet)" />
        </Card>
      </div>

      {/* Heatmap + errors */}
      <div className="grid grid-cols-12 gap-[22px]">
        <Card className="col-span-12 lg:col-span-6">
          <CardTitle title="Activity heatmap"
                     sub="When the team uploads. Darker = busier." />
          <Heatmap grid={heatmap.grid} hours={heatmap.hours} days={heatmap.days} max={heatmap.max} />
          <div className="flex items-center gap-1.5 mt-4 text-[10px] text-[var(--t3)]">
            <span>Quiet</span>
            <span className="flex gap-0.5">
              {[0.1, 0.25, 0.45, 0.65, 0.85, 1].map((o, i) => (
                <span key={i} className="w-3 h-3 rounded-sm" style={{ background: '#5b8cff', opacity: o }} />
              ))}
            </span>
            <span>Busy</span>
          </div>
        </Card>

        <Card className="col-span-12 lg:col-span-6">
          <CardTitle title="Top failure reasons"
                     sub="Most-seen error notes in this range"
                     right={<Pill tone="err">{totals.err} errors</Pill>} />
          <div className="space-y-2">
            {errorReasons.length === 0 && (
              <p className="text-[12px] text-[var(--t3)]">No errors in this range — nice work.</p>
            )}
            {errorReasons.map(r => {
              const maxV = errorReasons[0].count;
              return (
                <div key={r.reason}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[12px] font-medium text-[var(--t1)] truncate">{r.reason}</span>
                    <span className="text-[11px] num text-[var(--t2)] shrink-0 ml-3">
                      {r.count} <span className="text-[var(--t4)]">({((r.count / totals.err) * 100).toFixed(0)}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--s3)] overflow-hidden">
                    <div className="h-1.5 rounded-full" style={{ width: `${(r.count / maxV) * 100}%`, background: 'var(--err)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function HeroKpi({
  label, value, fullValue, trend, invert, spark, color = '#5b8cff', fill,
}: {
  label: string;
  value: string;
  fullValue?: string;
  trend: number;
  invert?: boolean;
  spark: number[];
  color?: string;
  fill?: string;
}) {
  return (
    <Card className="!rounded-[14px] !p-[17px]">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--t3)]">{label}</p>
        <Trend value={trend} invert={invert} />
      </div>
      <p className="text-[24px] font-semibold tracking-[-0.03em] num mt-2 leading-none text-[var(--t1)]" title={fullValue}>{value}</p>
      <div className="mt-3">
        <Sparkline data={spark} width={220} height={28} color={color} fill={fill || `${color}1f`} />
      </div>
      <p className="text-[10px] text-[var(--t4)] mt-2">vs previous period</p>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)]">{label}</p>
      <p className="text-[18px] font-semibold tracking-tight num mt-0.5 text-[var(--t1)]">{value}</p>
    </div>
  );
}

function Leaderboard({
  items, maxValue, barColor,
}: {
  items: Array<{ name: string; primary: string; secondary: string; value: number; avatar?: string }>;
  maxValue: number;
  barColor: string;
}) {
  if (items.length === 0) {
    return <p className="px-5 py-6 text-[11.5px] text-[var(--t3)] text-center">No data yet — Step 1 runs need to populate the customer/salesman fields first.</p>;
  }
  return (
    <div>
      {items.map((c, i) => {
        const w = (c.value / (maxValue || 1)) * 100;
        return (
          <div key={c.name} className="px-5 py-2.5 flex items-center gap-3 border-t border-[var(--line)] first:border-t-0">
            {c.avatar ? (
              <div className="w-7 h-7 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                style={{ background: 'linear-gradient(140deg, var(--accent), color-mix(in oklab, var(--accent) 50%, #8b5cf6))', color: 'var(--accent-ink)' }}>{c.avatar}</div>
            ) : (
              <span className="w-5 text-[10.5px] text-[var(--t4)] num text-center font-medium shrink-0">{i + 1}</span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium truncate text-[var(--t1)]">{c.name}</p>
              <div className="h-1 rounded-full bg-[var(--s3)] mt-1.5 overflow-hidden">
                <div className="h-1 rounded-full" style={{ width: `${w}%`, background: barColor }} />
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[12px] num font-semibold text-[var(--t1)]">{c.primary}</p>
              <p className="text-[10px] text-[var(--t4)] num">{c.secondary}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
