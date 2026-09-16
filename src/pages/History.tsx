// ─── History page — wired to /api/jobs ───────────────────────────────────────
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, Check, AlertTriangle, Loader2, Download,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, Pill, Segmented, Button, fmtDur, relTime } from '../lib/ui';
import { MiniStackedBars, PRODUCT_COLORS } from '../lib/charts';
import { api } from '../lib/api';
import { failed } from '../lib/errors';
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
    catch (e: any) { toast('err', failed('load the run history', e)); }
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
    <div className="space-y-[22px]">
      {/* Summary band */}
      <div className="grid grid-cols-12 gap-[22px]">
        <Card className="col-span-12 md:col-span-8" padded={false}>
          <div className="px-5 py-4 flex items-center justify-between border-b border-[var(--line)]">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Last 14 days</h3>
              <p className="text-[11.5px] text-[var(--t3)] mt-0.5">{last7.length} run{last7.length !== 1 ? 's' : ''} in last 7 days</p>
            </div>
            <div className="flex items-center gap-3 text-[10.5px] text-[var(--t2)]">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--accent)' }}/>Ok</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--warn)' }}/>Warn</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm" style={{ background: 'var(--err)' }}/>Err</span>
            </div>
          </div>
          <div className="px-5 py-4">
            <MiniStackedBars days={dayArr} />
          </div>
        </Card>

        <div className="col-span-12 md:col-span-4 space-y-3">
          <Card className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-[11px] flex items-center justify-center" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
              <Check className="w-[19px] h-[19px]" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--t3)] font-semibold">Successful · 7d</p>
              <p className="text-[22px] font-semibold num text-[var(--t1)]">{ok7}</p>
            </div>
          </Card>
          <Card className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-[11px] flex items-center justify-center" style={{ background: 'var(--err-soft)', color: 'var(--err)' }}>
              <AlertTriangle className="w-[19px] h-[19px]" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--t3)] font-semibold">Errors · 7d</p>
              <p className="text-[22px] font-semibold num text-[var(--t1)]">{err7}</p>
            </div>
          </Card>
        </div>
      </div>

      {/* Run log */}
      <Card padded={false}>
        <div className="px-5 py-3 flex items-center gap-3 border-b border-[var(--line)] flex-wrap">
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
              <tr className="border-b border-[var(--line)] bg-[var(--s1)]">
                {['Time', 'Step', 'Product', 'Customer', 'SF ID', 'Status', 'Duration', 'Items', 'Note'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[var(--t3)] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(j => (
                <tr key={j.id} className="border-b border-[var(--line)] hover:bg-[var(--s3)]">
                  <td className="px-4 py-2 text-[var(--t3)] num whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {new Date(j.timestamp).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                      {j.step === 'Step 2' && j.status === 'ok' && (() => {
                        const ageD = (Date.now() - +new Date(j.timestamp)) / 864e5;
                        if (ageD > 30) return <span title={`${Math.round(ageD)}d old — may need follow-up`} className="w-1.5 h-1.5 rounded-full shrink-0 inline-block" style={{ background: 'var(--err)' }} />;
                        if (ageD > 14) return <span title={`${Math.round(ageD)}d old`} className="w-1.5 h-1.5 rounded-full shrink-0 inline-block" style={{ background: 'var(--warn)' }} />;
                        return null;
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-2"><Pill tone={j.step === 'Step 1' ? 'brand' : 'violet'}>{j.step}</Pill></td>
                  <td className="px-4 py-2">
                    {j.product ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="w-[3px] h-3 rounded-sm" style={{ background: PRODUCT_COLORS[j.product] || 'var(--t3)' }} />
                        <span className="text-[var(--t2)]">{j.product}</span>
                      </span>
                    ) : <span className="text-[var(--t4)]">—</span>}
                  </td>
                  <td className="px-4 py-2 font-medium truncate max-w-[200px] text-[var(--t1)]">{j.customer || j.pdfName || '—'}</td>
                  <td className="px-4 py-2 mono whitespace-nowrap" style={{ color: 'var(--accent-text)' }}>{j.sfId || '—'}</td>
                  <td className="px-4 py-2"><Pill tone={j.status === 'ok' ? 'ok' : j.status} dot>{j.status}</Pill></td>
                  <td className="px-4 py-2 text-[var(--t3)] num whitespace-nowrap">{j.durationSec != null ? fmtDur(j.durationSec) : '—'}</td>
                  <td className="px-4 py-2 num text-[var(--t1)]">{j.items}</td>
                  <td className="px-4 py-2 truncate max-w-[260px]" style={{ color: j.status === 'err' ? 'var(--err)' : 'var(--t3)' }} title={j.note || ''}>{j.note || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-[12px] text-[var(--t3)]">No jobs match these filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
