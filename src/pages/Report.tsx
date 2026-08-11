// ─── Report page — what work actually got done over a period ─────────────────
// Sweeps every mail folder (including hand-made ones like "Completed by Laith"),
// groups messages into conversations — one thread = one job — and sorts each into
// a generic category. The scan runs server-side in the background; this polls it.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ClipboardList, Loader2, Play, Calendar, FolderOpen, Mail, Reply,
  CheckCircle2, AlertCircle, Search, ChevronDown, ChevronRight, Download,
  FileText, FileType2, Table2,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, KpiTile, relTime } from '../lib/ui';
import { api } from '../lib/api';
import { exportJobReport, type ReportFormat } from '../lib/export';
import type { JobsReport, JobsReportStatus, JobThread } from '../types';
import type { ToastFn } from '../App';

// Stable colour per category slot — the taxonomy is user-editable, so colours are
// assigned by position rather than hard-coded to a name.
const CAT_COLORS = [
  'var(--accent)', 'var(--ok)', 'var(--violet)', 'var(--warn)',
  '#e0629b', '#3fb8b0', '#8b7bd8', '#d98a3f', '#5aa9e6', '#9aa2b1',
];

// The same slots, frozen to the light-theme hex. Exported documents are printed on
// white whatever theme the app is wearing, and a CSS var means nothing to Python.
const CAT_HEX = [
  '#5b8cff', '#059669', '#7c3aed', '#b45309',
  '#e0629b', '#3fb8b0', '#8b7bd8', '#d98a3f', '#5aa9e6', '#9aa2b1',
];

// What the Export menu offers. PDF and Word are laid out by automation/export_report.py
// and carry internal links (contents → section, section → back); CSV stays client-side.
const EXPORT_CHOICES: Array<{
  id: ReportFormat | 'csv'; label: string; ext: string; hint: string;
  icon: typeof FileText; tint: string;
}> = [
  { id: 'pdf',  label: 'PDF document',   ext: 'pdf',  icon: FileText,  tint: 'var(--err)',
    hint: 'Designed report — charts, clickable contents, bookmarks' },
  { id: 'docx', label: 'Word document',  ext: 'docx', icon: FileType2, tint: 'var(--accent)',
    hint: 'Same layout, editable, with a working navigation pane' },
  { id: 'csv',  label: 'CSV spreadsheet', ext: 'csv', icon: Table2,    tint: 'var(--ok)',
    hint: 'One row per job — for Excel or a pivot table' },
];

const fmtD = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

const parseD = (s: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
};

const isValidRange = (from: string, to: string) => {
  const a = parseD(from), b = parseD(to);
  return !!a && !!b && a <= b;
};

export function ReportPage({ toast }: { toast: ToastFn }) {
  const today = new Date();
  const [from, setFrom]   = useState(fmtD(new Date(today.getTime() - 29 * 864e5)));
  const [to, setTo]       = useState(fmtD(today));
  const [status, setStatus] = useState<JobsReportStatus | null>(null);
  const [report, setReport] = useState<JobsReport | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('');
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting]   = useState<ReportFormat | null>(null);
  const pollRef = useRef<number | null>(null);

  // Load whatever was last built, so reopening the tab is instant.
  const loadResult = useCallback(async () => {
    try {
      const r = await api.jobsReportResult();
      if (r.report) {
        setReport(r.report);
        setLastScanAt(r.lastScanAt || null);
        if (r.report.range?.from) { setFrom(r.report.range.from); setTo(r.report.range.to); }
      }
    } catch { /* first run — nothing stored yet */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadResult(); }, [loadResult]);

  // Poll while a scan is in flight; a full-mailbox sweep takes minutes.
  const poll = useCallback(async () => {
    try {
      const s = await api.jobsReportStatus();
      setStatus(s);
      if (!s.running) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (s.phase === 'done') { await loadResult(); toast('ok', s.message || 'Report ready'); }
        if (s.phase === 'error') toast('err', s.error || 'Scan failed');
      }
    } catch { /* transient — keep polling */ }
  }, [loadResult, toast]);

  useEffect(() => {
    // Resume polling if a scan was already running when the tab opened.
    api.jobsReportStatus().then(s => {
      setStatus(s);
      if (s.running && !pollRef.current) pollRef.current = window.setInterval(poll, 2000);
    }).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [poll]);

  async function runScan() {
    if (!isValidRange(from, to)) { toast('err', 'Enter a valid date range (DD/MM/YYYY, from ≤ to)'); return; }
    try {
      const s = await api.jobsReportScan(from, to);
      setStatus(s);
      if ((s as any).error) { toast('err', (s as any).error); return; }
      toast('info', 'Scanning your mailbox — this can take a few minutes');
      if (!pollRef.current) pollRef.current = window.setInterval(poll, 2000);
    } catch (e: any) { toast('err', e.message); }
  }

  const running = !!status?.running;

  // ── Derived view ──────────────────────────────────────────────────────────
  const threads: JobThread[] = report?.threads ?? [];
  const q = filter.trim().toLowerCase();
  const visible = threads.filter(t =>
    (!catFilter || t.category === catFilter)
    && (!q || t.topic.toLowerCase().includes(q)
         || t.summary.toLowerCase().includes(q)
         || t.counterpart.toLowerCase().includes(q)),
  );

  const slotFor  = (cat: string) => {
    const i = (report?.byCategory ?? []).findIndex(c => c.category === cat);
    return i < 0 ? 0 : i;
  };
  const colorFor = (cat: string) => CAT_COLORS[slotFor(cat) % CAT_COLORS.length];

  function toggleRow(conv: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(conv) ? next.delete(conv) : next.add(conv);
      return next;
    });
  }

  function exportCsv() {
    if (!report) return;
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Category', 'Job', 'What was done', 'With', 'Messages', 'Replies sent', 'First', 'Last', 'Folders', 'Filed as completed'],
      ...visible.map(t => [
        t.category, t.topic, t.summary, t.counterpart, t.msgs, t.sent,
        (t.first || '').slice(0, 10), (t.last || '').slice(0, 10),
        t.folders.join(' | '), t.completed ? 'yes' : 'no',
      ]),
    ].map(r => r.map(esc).join(',')).join('\r\n');

    const url = URL.createObjectURL(new Blob(['﻿' + rows], { type: 'text/csv;charset=utf-8' }));
    const a   = document.createElement('a');
    a.href = url;
    a.download = `vector-job-report_${report.range.from.replace(/\//g, '-')}_${report.range.to.replace(/\//g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('ok', `${visible.length} jobs exported`);
  }

  // PDF / Word are laid out server-side. We send the jobs that are on screen, in the
  // order they are shown, plus the colour each category was drawn in — so the
  // document reads like the page, filter and all.
  async function exportDoc(fmt: ReportFormat) {
    if (!report || !visible.length) return;
    setExporting(fmt);
    try {
      const catColors: Record<string, string> = {};
      for (const t of visible) catColors[t.category] = CAT_HEX[slotFor(t.category) % CAT_HEX.length];
      await exportJobReport(fmt, {
        convs:     visible.map(t => t.conv),
        catColors,
        filter:    { category: catFilter, query: filter.trim() },
        filename:  `vector-job-report_${report.range.from.replace(/\//g, '-')}_${report.range.to.replace(/\//g, '-')}`,
      });
      toast('ok', `${visible.length} jobs exported to ${fmt === 'pdf' ? 'PDF' : 'Word'}`);
      setExportOpen(false);
    } catch (e: any) {
      toast('err', e?.message || 'Export failed');
    }
    setExporting(null);
  }

  const quickRanges = [
    { label: 'Last 7 days',  days: 6 },
    { label: 'Last 30 days', days: 29 },
    { label: 'Last 90 days', days: 89 },
  ];

  const maxDaily = Math.max(1, ...(report?.daily ?? []).map(d => d.count));

  return (
    <div className="space-y-5">
      {/* ── Range + run ─────────────────────────────────────────────────────── */}
      <Card>
        <CardTitle
          title="Job report"
          sub="Scans every folder in your mailbox — including the ones you made — and groups the work into jobs"
          right={report && (
            <Pill tone="neutral">
              {lastScanAt ? `Built ${relTime(lastScanAt)}` : 'Saved report'}
            </Pill>
          )}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--t3)] mb-1.5">From</label>
            <DateBox value={from} onChange={setFrom} />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--t3)] mb-1.5">To</label>
            <DateBox value={to} onChange={setTo} />
          </div>
          <div className="flex gap-1.5">
            {quickRanges.map(r => (
              <button key={r.label}
                onClick={() => { setFrom(fmtD(new Date(Date.now() - r.days * 864e5))); setTo(fmtD(new Date())); }}
                className="h-[34px] px-2.5 rounded-[8px] text-[11px] font-medium bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t2)] hover:border-[var(--accent-line)]">
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={runScan} disabled={running || !isValidRange(from, to)}
            style={running || !isValidRange(from, to)
              ? { background: 'var(--s2)', color: 'var(--t3)', border: '1px solid var(--line-2)' }
              : { background: 'var(--accent)', color: 'var(--accent-ink)', boxShadow: 'var(--glow)' }}
            className="h-[34px] px-4 rounded-[9px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:cursor-not-allowed">
            {running
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</>
              : <><Play className="w-3.5 h-3.5" fill="currentColor" stroke="none" /> Build report</>}
          </button>
        </div>

        {running && status && (
          <div className="mt-3.5 px-3.5 py-2.5 rounded-[10px]" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
            <div className="flex items-center gap-2 text-[11.5px] font-medium" style={{ color: 'var(--accent-text)' }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {status.message || 'Working…'}
            </div>
            <div className="flex gap-4 mt-1.5 text-[10.5px] text-[var(--t3)]">
              <span><b className="num text-[var(--t1)]">{status.messages}</b> messages read</span>
              <span><b className="num text-[var(--t1)]">{status.threads}</b> jobs found</span>
              {status.toClassify > 0 && (
                <span><b className="num text-[var(--t1)]">{status.classified}</b>/{status.toClassify} categorised</span>
              )}
            </div>
            <p className="text-[10px] text-[var(--t3)] mt-1.5">
              Outlook must stay open. A 90-day sweep of a busy mailbox can take several minutes.
            </p>
          </div>
        )}

        {status?.phase === 'error' && !running && (
          <div className="mt-3.5 flex items-start gap-2 px-3.5 py-2.5 rounded-[10px] text-[11.5px]"
               style={{ background: 'var(--err-soft)', border: '1px solid color-mix(in oklab, var(--err) 35%, transparent)' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" style={{ color: 'var(--err)' }} />
            <span className="text-[var(--t2)]">{status.error}</span>
          </div>
        )}
      </Card>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" /></div>
      ) : !report ? (
        <Card>
          <div className="flex flex-col items-center gap-2.5 py-12 text-center">
            <ClipboardList className="w-9 h-9 text-[var(--t4)]" />
            <p className="text-[13px] font-medium text-[var(--t1)]">No report yet</p>
            <p className="text-[11.5px] text-[var(--t3)] max-w-sm">
              Pick a period and hit <b>Build report</b>. Vector reads every mail folder, groups
              each conversation into one job, and sorts them into categories.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {report.truncated && (
            <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-[12px] text-[11.5px]"
                 style={{ background: 'var(--warn-soft)', border: '1px solid color-mix(in oklab, var(--warn) 35%, transparent)' }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" style={{ color: 'var(--warn)' }} />
              <span className="text-[var(--t2)]">
                The scan hit its message cap, so this period is only partly covered. Narrow the date range for a complete picture.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiTile icon={ClipboardList} label="Jobs done"    value={report.totals.threads}        sub={`${report.range.from} → ${report.range.to}`} accent="brand" />
            <KpiTile icon={Reply}         label="Replies sent" value={report.totals.replies}        sub="messages you wrote" accent="ok" />
            <KpiTile icon={Mail}          label="Mail handled" value={report.totals.messages}       sub={`${report.totals.scanned} scanned`} accent="violet" />
            <KpiTile icon={CheckCircle2}  label="Filed done"   value={report.totals.completedFiled} sub="in a completed folder" accent="amber" />
          </div>

          {/* ── Category breakdown ────────────────────────────────────────────── */}
          <Card>
            <CardTitle title="Work by category"
                       sub="One job = one email conversation you replied to or filed as done"
                       right={catFilter && (
                         <button onClick={() => setCatFilter(null)} className="text-[11px] font-medium" style={{ color: 'var(--accent-text)' }}>
                           Clear filter
                         </button>
                       )} />
            {report.byCategory.length === 0 ? (
              <p className="text-[11.5px] text-[var(--t3)]">No jobs found in this period.</p>
            ) : (
              <div className="space-y-2.5">
                {report.byCategory.map(c => {
                  const on = catFilter === c.category;
                  return (
                    <button key={c.category}
                      onClick={() => setCatFilter(on ? null : c.category)}
                      className={cn(
                        'w-full text-left rounded-[10px] px-3 py-2 transition-colors',
                        on ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--s3)]',
                      )}>
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorFor(c.category) }} />
                        <span className="text-[12px] font-medium text-[var(--t1)] flex-1 truncate">{c.category}</span>
                        <span className="text-[11px] text-[var(--t2)] num shrink-0">
                          <b className="text-[var(--t1)]">{c.threads}</b> job{c.threads !== 1 ? 's' : ''}
                        </span>
                        <span className="text-[10.5px] text-[var(--t3)] num shrink-0 w-9 text-right">{c.pct}%</span>
                      </div>
                      <div className="h-[6px] rounded-full overflow-hidden" style={{ background: 'var(--s3)' }}>
                        <div className="h-full rounded-full transition-all"
                             style={{ width: `${c.pct}%`, background: colorFor(c.category) }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ── Activity per day ──────────────────────────────────────────────── */}
          {report.daily.length > 1 && (
            <Card>
              <CardTitle title="Jobs closed per day" sub="Dated by the last message in each conversation" />
              <div className="flex items-end gap-[3px] h-24">
                {report.daily.map(d => (
                  <div key={d.date} className="flex-1 min-w-[3px] rounded-t-[3px] transition-all hover:opacity-80"
                       style={{ height: `${Math.max(4, (d.count / maxDaily) * 100)}%`, background: 'var(--accent)' }}
                       title={`${d.date}: ${d.count} job${d.count !== 1 ? 's' : ''}`} />
                ))}
              </div>
              <div className="flex justify-between mt-1.5 text-[10px] text-[var(--t3)] num">
                <span>{report.daily[0]?.date}</span>
                <span>{report.daily[report.daily.length - 1]?.date}</span>
              </div>
            </Card>
          )}

          {/* ── The jobs ──────────────────────────────────────────────────────── */}
          <Card padded={false}>
            <div className="px-5 py-4 border-b border-[var(--line)] flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-[13px] font-semibold tracking-tight">
                  {catFilter || 'All jobs'}
                  <span className="ml-2 text-[11px] font-normal text-[var(--t3)] num">{visible.length}</span>
                </h3>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--t3)]" />
                <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter jobs…"
                  className="h-[30px] w-44 pl-7 pr-2.5 rounded-[8px] text-[11.5px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
              </div>
              <div className="relative shrink-0">
                <button onClick={() => setExportOpen(o => !o)} disabled={!visible.length}
                  className="h-[30px] px-3 rounded-[8px] text-[11px] font-semibold inline-flex items-center gap-1.5 text-[var(--t1)] border border-[var(--line-2)] bg-[var(--s2)] hover:bg-[var(--s-hover)] disabled:opacity-50">
                  {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                  Export
                  <ChevronDown className={cn('w-3 h-3 text-[var(--t3)] transition-transform', exportOpen && 'rotate-180')} />
                </button>
                {exportOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => !exporting && setExportOpen(false)} />
                    <div className="absolute right-0 top-full mt-1.5 z-50 w-[248px] rounded-[12px] overflow-hidden py-1"
                         style={{ background: 'var(--s1)', border: '1px solid var(--line-2)', boxShadow: 'var(--pop-sh)' }}>
                      <p className="px-3 pt-1.5 pb-2 text-[10px] uppercase tracking-[0.05em] text-[var(--t3)]">
                        {visible.length} job{visible.length !== 1 ? 's' : ''}
                        {(catFilter || filter.trim()) && ' — filtered'}
                      </p>
                      {EXPORT_CHOICES.map(c => (
                        <button key={c.id} disabled={!!exporting}
                          onClick={() => (c.id === 'csv' ? (exportCsv(), setExportOpen(false)) : exportDoc(c.id))}
                          className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--s3)] disabled:opacity-50 transition-colors">
                          {exporting === c.id
                            ? <Loader2 className="w-3.5 h-3.5 mt-px shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                            : <c.icon className="w-3.5 h-3.5 mt-px shrink-0" style={{ color: c.tint }} />}
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-medium text-[var(--t1)]">{c.label}</span>
                            <span className="block text-[10.5px] text-[var(--t3)] leading-snug">{c.hint}</span>
                          </span>
                          <span className="text-[10px] text-[var(--t4)] mono mt-px">.{c.ext}</span>
                        </button>
                      ))}
                      {exporting && (
                        <p className="px-3 pt-1 pb-1.5 text-[10px] text-[var(--t3)]">
                          Laying out the document…
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="px-5 py-10 text-center text-[11.5px] text-[var(--t3)]">No jobs match.</p>
            ) : (
              <div className="max-h-[560px] overflow-y-auto vec-scroll">
                {visible.map(t => {
                  const open = expanded.has(t.conv);
                  return (
                    <div key={t.conv} className="border-b border-[var(--line)] last:border-0">
                      <button onClick={() => toggleRow(t.conv)}
                        className="w-full text-left px-5 py-2.5 flex items-start gap-2.5 hover:bg-[var(--s3)] transition-colors">
                        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--t3)]" />
                              : <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--t3)]" />}
                        <span className="w-2 h-2 rounded-sm shrink-0 mt-1.5" style={{ background: colorFor(t.category) }} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-medium text-[var(--t1)] truncate">{t.topic}</span>
                            {t.completed && <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: 'var(--ok)' }} />}
                          </div>
                          <p className="text-[11px] text-[var(--t3)] truncate mt-0.5">
                            {t.summary || t.category}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[10.5px] text-[var(--t3)] num">{(t.last || '').slice(0, 10)}</p>
                          <p className="text-[10px] text-[var(--t4)] num">{t.msgs} msg · {t.sent} sent</p>
                        </div>
                      </button>
                      {open && (
                        <div className="px-5 pb-3 pl-[52px] space-y-1 text-[11px] text-[var(--t2)]">
                          <p><span className="text-[var(--t3)]">Category:</span> {t.category}</p>
                          {t.counterpart && <p><span className="text-[var(--t3)]">With:</span> {t.counterpart}</p>}
                          <p><span className="text-[var(--t3)]">Period:</span>{' '}
                            <span className="num">{(t.first || '').slice(0, 10)} → {(t.last || '').slice(0, 10)}</span></p>
                          <p className="flex items-start gap-1.5">
                            <FolderOpen className="w-3 h-3 shrink-0 mt-0.5 text-[var(--t3)]" />
                            <span>{t.folders.join(' · ') || '—'}</span>
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ── Where the work sat ────────────────────────────────────────────── */}
          {report.folders.length > 0 && (
            <Card>
              <CardTitle title="Folders scanned" sub="Every mail folder that held messages in this period" />
              <div className="flex flex-wrap gap-1.5">
                {(() => {
                  // "Inbox" and "Sent Items" exist in BOTH the personal and the
                  // shared quote-factory mailbox. Showing the bare leaf twice is
                  // unreadable, so qualify a name with its mailbox when it repeats.
                  const leafOf  = (p: string) => p.split('\\').pop() || p;
                  const seen: Record<string, number> = {};
                  for (const f of report.folders) {
                    const l = leafOf(f.folder);
                    seen[l] = (seen[l] || 0) + 1;
                  }
                  return report.folders.slice(0, 40)
                    .sort((a, b) => b.count - a.count)
                    .map(f => {
                      const leaf = leafOf(f.folder);
                      const box  = f.folder.split('\\')[0].replace(/@.*$/, '');
                      return (
                        <span key={f.folder}
                          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] text-[10.5px] bg-[var(--s3)] border border-[var(--line)] text-[var(--t2)]"
                          title={f.folder}>
                          <FolderOpen className="w-2.5 h-2.5 text-[var(--t3)]" />
                          {seen[leaf] > 1 && <span className="text-[var(--t4)]">{box} ›</span>}
                          {leaf}
                          <span className="num text-[var(--t3)]">{f.count}</span>
                        </span>
                      );
                    });
                })()}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── DD/MM/YYYY input with the same auto-slash behaviour as the Dashboard ────
function DateBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Calendar className="absolute left-[11px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--t3)]" />
      <input type="text" placeholder="DD/MM/YYYY" value={value} maxLength={10}
        onChange={e => {
          let v = e.target.value.replace(/[^\d/]/g, '');
          if (v.length === 2 && !v.includes('/')) v = v + '/';
          if (v.length === 5 && v.split('/').length === 2) v = v + '/';
          onChange(v);
        }}
        className="w-[140px] h-[34px] pl-[34px] pr-2.5 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none num"
      />
    </div>
  );
}
