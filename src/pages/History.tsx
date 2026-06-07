// ─── History page — wired to /api/jobs ───────────────────────────────────────
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, Check, AlertTriangle, Loader2, Download,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, Pill, Segmented, Button, fmtDur, relTime } from '../lib/ui';
import { MiniStackedBars, PRODUCT_COLORS } from '../lib/charts';
import { api } from '../lib/api';
import type { Job } from '../types';
import type { ToastFn } from '../App';

export function HistoryPage({ toast }: { toast: ToastFn }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'ok' | 'warn' | 'err'>('all');
  const [stepF, setStepF]   = useState<'all' | 'Step 1' | 'Step 2'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setJobs(await api.jobs()); }
    catch (e: any) { toast('err', `Couldn't load jobs: ${e.message}`); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => jobs.filter(j =>
    (filter === 'all' || j.status === filter) &&
    (stepF === 'all' || j.step === stepF)
  ), [jobs, filter, stepF]);

  // Last 14 days mini chart
  const dayArr = useMemo(() => {
    const map: Record<number, { label: string; ok: number; warn: number; err: number }> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5); d.setHours(0, 0, 0, 0);
      map[+d] = { label: d.toLocaleDateString('en-GB', { day: '2-digit' }), ok: 0, warn: 0, err: 0 };
    }
    jobs.forEach(j => {
      const t = new Date(j.timestamp); t.setHours(0, 0, 0, 0);
      const k = +t;
      if (map[k]) map[k][j.status]++;
    });
    return Object.values(map);
  }, [jobs]);

  const last7 = jobs.filter(j => Date.now() - +new Date(j.timestamp) < 7 * 864e5);
  const ok7   = last7.filter(j => j.status === 'ok').length;
  const err7  = last7.filter(j => j.status === 'err').length;

  return (
    <div className="space-y-5">
      {/* Summary band */}
      <div className="grid grid-cols-12 gap-5">
        <Card className="col-span-12 md:col-span-8" padded={false}>
          <div className="px-5 py-4 flex items-center justify-between border-b border-ink-200/70 dark:border-ink-800">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Last 14 days</h3>
              <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-0.5">{last7.length} run{last7.length !== 1 ? 's' : ''} in last 7 days</p>
            </div>
            <div className="flex items-center gap-3 text-[10.5px]">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-brand-600"/>Ok</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-amber-500"/>Warn</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-red-500"/>Err</span>
            </div>
          </div>
          <div className="px-5 py-4">
            <MiniStackedBars days={dayArr} />
          </div>
        </Card>

        <div className="col-span-12 md:col-span-4 space-y-3">
          <Card className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Check className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-ink-400 font-semibold">Successful · 7d</p>
              <p className="text-[20px] font-semibold num">{ok7}</p>
            </div>
          </Card>
          <Card className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10.5px] uppercase tracking-wider text-ink-400 font-semibold">Errors · 7d</p>
              <p className="text-[20px] font-semibold num">{err7}</p>
            </div>
          </Card>
        </div>
      </div>

      {/* Run log */}
      <Card padded={false}>
        <div className="px-5 py-3 flex items-center gap-3 border-b border-ink-200/70 dark:border-ink-800 flex-wrap">
          <h3 className="text-[13px] font-semibold tracking-tight">Run log</h3>
          <Pill tone="neutral">{filtered.length} job{filtered.length !== 1 ? 's' : ''}</Pill>
          <div className="flex-1" />
          <Segmented value={filter} onChange={v => setFilter(v as typeof filter)} options={[
            { value: 'all',  label: 'All' },
            { value: 'ok',   label: 'Ok' },
            { value: 'warn', label: 'Warn' },
            { value: 'err',  label: 'Err' },
          ]} />
          <Segmented value={stepF} onChange={v => setStepF(v as typeof stepF)} options={[
            { value: 'all',    label: 'Steps' },
            { value: 'Step 1', label: 'Step 1' },
            { value: 'Step 2', label: 'Step 2' },
          ]} />
          <Button tone="outline" size="md" Icon={Download} onClick={() => { window.location.href = '/api/export/jobs.csv'; }}>Export CSV</Button>
          <Button tone="outline" size="md" Icon={loading ? Loader2 : RefreshCw} onClick={refresh}>Refresh</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-ink-200/70 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-950/30">
                {['Time', 'Step', 'Product', 'Customer', 'SF ID', 'Status', 'Duration', 'Items', 'Note'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(j => (
                <tr key={j.id} className="border-b border-ink-100 dark:border-ink-800/70 hover:bg-ink-50/60 dark:hover:bg-ink-800/30">
                  <td className="px-4 py-2 text-ink-500 num whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {new Date(j.timestamp).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                      {j.step === 'Step 2' && j.status === 'ok' && (() => {
                        const ageD = (Date.now() - +new Date(j.timestamp)) / 864e5;
                        if (ageD > 30) return <span title={`${Math.round(ageD)}d old — may need follow-up`} className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 inline-block" />;
                        if (ageD > 14) return <span title={`${Math.round(ageD)}d old`} className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 inline-block" />;
                        return null;
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-2"><Pill tone={j.step === 'Step 1' ? 'brand' : 'violet'}>{j.step}</Pill></td>
                  <td className="px-4 py-2">
                    {j.product ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="w-1.5 h-3 rounded-sm" style={{ background: PRODUCT_COLORS[j.product] || '#65656c' }} />
                        <span className="text-ink-600 dark:text-ink-300">{j.product}</span>
                      </span>
                    ) : <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-4 py-2 font-medium truncate max-w-[200px]">{j.customer || j.pdfName || '—'}</td>
                  <td className="px-4 py-2 mono text-brand-600 dark:text-brand-300 whitespace-nowrap">{j.sfId || '—'}</td>
                  <td className="px-4 py-2"><Pill tone={j.status === 'ok' ? 'ok' : j.status} dot>{j.status}</Pill></td>
                  <td className="px-4 py-2 text-ink-500 num whitespace-nowrap">{j.durationSec != null ? fmtDur(j.durationSec) : '—'}</td>
                  <td className="px-4 py-2 num">{j.items}</td>
                  <td className={cn('px-4 py-2 truncate max-w-[260px]', j.status === 'err' ? 'text-red-600 dark:text-red-400' : 'text-ink-500 dark:text-ink-400')} title={j.note || ''}>{j.note || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-[12px] text-ink-400">No jobs match these filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
