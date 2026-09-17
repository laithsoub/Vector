// ─── History page — wired to /api/jobs ───────────────────────────────────────
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, Check, AlertTriangle, Loader2, Download,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { fmtDur } from '../lib/ui';
import { plural } from '../lib/errors';
import {
  Badge, DataTable, IconButton, IconLink, Section, Segmented, Stat, StatRow, Tooltip,
  statusTone, type Column,
} from '../ui';
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

  const columns: Column<Job>[] = [
    { key: 'time', header: 'Time', kind: 'num', width: 'calc(var(--sp-4) * 9.5)', render: j => {
      const ageD = (Date.now() - +new Date(j.timestamp)) / 864e5;
      const stale = j.step === 'Step 2' && j.status === 'ok' && ageD > 14;
      return (
        <span className="inline-flex items-center gap-1.5 text-fg-3">
          {stale && (
            <Tooltip label={`${Math.round(ageD)}d old${ageD > 30 ? ' — may need follow-up' : ''}`}>
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', ageD > 30 ? 'bg-err' : 'bg-warn')} />
            </Tooltip>
          )}
          {new Date(j.timestamp).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
        </span>
      );
    } },
    { key: 'step', header: 'Step', width: 'calc(var(--sp-4) * 5)', render: j => <Badge tone={j.step === 'Step 1' ? 'accent' : 'neutral'}>{j.step}</Badge> },
    { key: 'product', header: 'Product', width: 'calc(var(--sp-4) * 7)', render: j => j.product ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="w-0.5 h-3 rounded-full shrink-0" style={{ background: PRODUCT_COLORS[j.product] || 'var(--t3)' }} />
        <span className="text-fg-2 truncate">{j.product}</span>
      </span>
    ) : <span className="text-fg-4">—</span> },
    { key: 'customer', header: 'Customer', render: j => <span className="text-fg" title={j.customer || j.pdfName || ''}>{j.customer || j.pdfName || '—'}</span> },
    { key: 'sfId', header: 'SF ID', kind: 'code', width: 'calc(var(--sp-4) * 10.5)', render: j => <span className="text-fg-2">{j.sfId || '—'}</span> },
    { key: 'status', header: 'Status', width: 'calc(var(--sp-4) * 5)', render: j => <Badge tone={statusTone(j.status)} dot>{j.status}</Badge> },
    { key: 'dur', header: 'Duration', kind: 'num', width: 'calc(var(--sp-4) * 5.5)', render: j => <span className="text-fg-3">{j.durationSec != null ? fmtDur(j.durationSec) : '—'}</span> },
    { key: 'items', header: 'Items', kind: 'num', width: 'calc(var(--sp-4) * 4)', render: j => j.items },
    { key: 'note', header: 'Note', render: j => (
      <span className={j.status === 'err' ? 'text-err' : 'text-fg-3'} title={j.note || ''}>{j.note || '—'}</span>
    ) },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-12 gap-8">
        <Section className="col-span-12 md:col-span-8" title="Last 14 days"
          description={`${plural(last7.length, 'run')} in the last 7 days`}
          actions={
            <div className="flex items-center gap-3 text-xs text-fg-3">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full" style={{ background: 'var(--chart-1)' }} />Ok</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-warn" />Warn</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-err" />Err</span>
            </div>
          }>
          <MiniStackedBars days={dayArr} />
        </Section>
        <div className="col-span-12 md:col-span-4 flex flex-col justify-end">
          <StatRow columns={2}>
            <Stat label="Successful · 7d" value={ok7} icon={Check} tone="ok" />
            <Stat label="Errors · 7d" value={err7} icon={AlertTriangle} tone={err7 ? 'err' : undefined} />
          </StatRow>
        </div>
      </div>

      <Section title="Run log" description={plural(filtered.length, 'job')}
        actions={<>
          <Segmented value={filter} onChange={setFilter} data={[
            { value: 'all',  label: 'All' },
            { value: 'ok',   label: 'Ok' },
            { value: 'warn', label: 'Warn' },
            { value: 'err',  label: 'Err' },
          ]} />
          <Segmented value={stepF} onChange={setStepF} data={[
            { value: 'all',    label: 'All steps' },
            { value: 'Step 1', label: 'Step 1' },
            { value: 'Step 2', label: 'Step 2' },
          ]} />
          <IconLink icon={Download} label="Export CSV" href="/api/export/jobs.csv" />
          <IconButton icon={RefreshCw} label="Refresh" tone="secondary" loading={loading} onClick={refresh} />
        </>}>
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={j => j.id}
          maxHeight="calc(100vh - var(--header-h) - var(--sp-16) * 5)"
          empty={loading ? <div className="py-10 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-fg-4" /></div> : 'No jobs match these filters'}
        />
      </Section>
    </div>
  );
}
