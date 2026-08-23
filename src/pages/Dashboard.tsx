// ─── Dashboard page — wired to real API ──────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  FileUp, FileText, Trash2, AlertCircle, UploadCloud, Calendar, Play, Loader2, Check,
  TrendingUp, ChevronRight, Archive, Mail, Paperclip, MailSearch, X, CloudOff,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, StatusDot, KpiTile, fmtMoney, relTime } from '../lib/ui';
import { MiniBars, PRODUCT_COLORS } from '../lib/charts';
import { api, runStreamingScript } from '../lib/api';
import { failed, plural } from '../lib/errors';
import { usePolling } from '../lib/usePolling';
import type { ConflictItem } from '../lib/api';
import type { Job, PdfFile, DashboardStats, ArchiveDay, CheckupItem, CheckupResponse } from '../types';
import type { ToastFn } from '../App';

const PRODUCT_OPTS = [
  'PDC','ICP','EL','FIRE','MV-COMBINATION','MV-SWITCHGEAR','MV-TRANSFORMER',
  'DPQ','CPS','EVCI','ENERGY STORAGE','EL & FIRE',
];

const PRODUCT_LABELS: Record<string, string> = {
  'PDC': 'PDC', 'ICP': 'ICP', 'EL': 'EL', 'FIRE': 'Fire',
  'MV-COMBINATION':  'MV Combination',
  'MV-SWITCHGEAR':   'MV Switchgear',
  'MV-TRANSFORMER':  'MV Transformer',
  'DPQ':  'DPQ',  'CPS': 'CPS', 'EVCI': 'EVCI',
  'ENERGY STORAGE':  'Energy Storage',
  'EL & FIRE':       'EL & Fire',
};

export function DashboardPage({
  connected, toast, onTab,
}: {
  connected: boolean;
  toast: ToastFn;
  onTab: (t: any) => void;
}) {
  const [stats, setStats]       = useState<DashboardStats | null>(null);
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [pdfs, setPdfs]         = useState<PdfFile[]>([]);
  const [archive, setArchive]   = useState<ArchiveDay[]>([]);
  const [suggesting, setSuggesting] = useState(false); // detection in progress
  const [perFile, setPerFile]   = useState<{ name: string; lang: string; suggestion: string }[]>([]);
  const [fileLines, setFileLines] = useState<Record<string, string>>({}); // per-file manual overrides
  const [arrived, setArrived]   = useState('');
  const [step1, setStep1]       = useState<'idle' | 'running' | 'done' | 'err'>('idle');
  const [step2, setStep2]       = useState<'idle' | 'running' | 'done' | 'err'>('idle');
  const step1Abort = useRef<AbortController | null>(null);
  const step2Abort = useRef<AbortController | null>(null);

  // ── Conflict resolution state ─────────────────────────────────────────────
  const [conflicts, setConflicts]       = useState<ConflictItem[] | null>(null);
  const [conflictCtx, setConflictCtx]   = useState<{ queuedNames: string[] } | null>(null);

  // ── Inbox preview ─────────────────────────────────────────────────────────
  const [inboxEmails, setInboxEmails]   = useState<any[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);

  // ── Quick check-up ────────────────────────────────────────────────────────
  const [checkup, setCheckup]           = useState<CheckupResponse | null>(null);
  const [checkupRunning, setCheckupRun] = useState(false);
  const [checkupOpen, setCheckupOpen]   = useState(false);
  const [queueing, setQueueing]         = useState(false);
  const [picked, setPicked]             = useState<Set<string>>(new Set());

  async function runCheckup() {
    setCheckupRun(true);
    setCheckupOpen(true);
    try {
      const r = await api.quotesCheckup(30);
      if (r.error) { toast('err', failed('run the quote checkup', r.error)); setCheckup(null); }
      else {
        setCheckup(r);
        // Pre-select exactly what needs action — confirmed-missing quotes only.
        setPicked(new Set(r.items.filter(i => i.status === 'missing').map(i => i.entryId)));
        if (r.warning) toast('warn', r.warning);
        else toast(r.counts.missing ? 'warn' : 'ok',
          r.counts.missing
            ? `${plural(r.counts.missing, 'quote')} from the last 30 days are not on SharePoint`
            : 'Every quote email from the last 30 days is already on SharePoint');
      }
    } catch (e: any) { toast('err', failed('run the quote checkup', e)); }
    setCheckupRun(false);
  }

  async function queuePicked() {
    if (!picked.size) return;
    setQueueing(true);
    try {
      const r = await api.quotesCheckupQueue([...picked]);
      if (r.count) {
        toast('ok', `${plural(r.count, 'file')} added to the upload queue`);
        setCheckupOpen(false);
        // Land on Stage 1 with the bundle already in the queue.
        document.getElementById('vec-upload-workflow')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        toast('warn', failed('save any attachment from those emails', r.error));
      }
      if (r.failed?.length) toast('warn', `${plural(r.failed.length, 'email')} could not be read — see vector.log`);
      refresh();
    } catch (e: any) { toast('err', failed('queue the selected quotes', e)); }
    setQueueing(false);
  }

  const loadInbox = useCallback(async () => {
    try {
      const status = await api.outlookStatus();
      if (!status.available) { setInboxLoading(false); return; }
      const r = await api.outlookEmails('default', 9);
      setInboxEmails(r.emails || []);
    } catch { /* silent */ }
    setInboxLoading(false);
  }, []);

  useEffect(() => { loadInbox(); }, [loadInbox]);
  usePolling(loadInbox, 60_000);

  const refresh = useCallback(async () => {
    try {
      const [s, j, p, a] = await Promise.all([
        api.stats(), api.jobs(), api.pdfs(), api.archive(),
      ]);
      setStats(s); setJobs(j); setPdfs(p); setArchive(a);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Four endpoints per tick — the one most worth pausing when nobody is looking.
  usePolling(refresh, 8_000);

  // ── Auto-suggest the product line(s) for each queued file ──────────────────
  const pdfKey = pdfs.map(p => p.name).join('|');
  useEffect(() => {
    if (pdfs.length === 0) { setPerFile([]); setSuggesting(false); return; }
    let cancelled = false;
    setSuggesting(true);
    api.suggestProduct()
      .then(r => {
        if (cancelled) return;
        setPerFile(r.perFile || []);
        // Drop manual overrides for files no longer queued.
        setFileLines(prev => {
          const live = new Set((r.perFile || []).map(f => f.name));
          const next: Record<string, string> = {};
          for (const k of Object.keys(prev)) if (live.has(k)) next[k] = prev[k];
          return next;
        });
      })
      .catch(() => { /* silent — dropdowns still work manually */ })
      .finally(() => { if (!cancelled) setSuggesting(false); });
    return () => { cancelled = true; };
  }, [pdfKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-file detected line + effective line (manual override wins over detection)
  const detectedMap: Record<string, string> = {};
  perFile.forEach(f => { detectedMap[f.name] = f.suggestion || ''; });
  const lineFor = (name: string) => fileLines[name] ?? detectedMap[name] ?? '';

  // Breakdown of effective lines across the batch
  const lineCounts = pdfs.reduce<Record<string, number>>((acc, p) => {
    const k = lineFor(p.name) || 'UNKNOWN';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const lineBreakdown = Object.entries(lineCounts).sort((a, b) => b[1] - a[1]);
  const allResolved   = pdfs.length > 0 && pdfs.every(p => !!lineFor(p.name));
  const isBulk = pdfs.length > 1;

  const onDrop = useCallback(async (files: File[]) => {
    for (const f of files) {
      try { await api.uploadPdf(f); }
      catch (e: any) { toast('err', failed(`upload ${f.name}`, e)); }
    }
    if (files.length) toast('info', `${plural(files.length, 'file')} queued for processing`);
    refresh();
  }, [refresh, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf', '.PDF'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/msword': ['.doc'],
      // German Angebot templates ship as Word macro/template formats
      'application/vnd.ms-word.template.macroEnabled.12': ['.dotm'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template': ['.dotx'],
    },
  });

  async function deletePdf(name: string) {
    await api.deletePdf(name);
    toast('info', `${name} removed from the queue`);
    refresh();
  }

  // ─── Quick KPIs ───────────────────────────────────────────────────────────
  const todayJobs = jobs.filter(j => Date.now() - +new Date(j.timestamp) < 86400000);
  const todayOk   = todayJobs.filter(j => j.status === 'ok').length;
  const todayErr  = todayJobs.filter(j => j.status === 'err').length;
  const archivedToday = stats?.archivedToday ?? archive[0]?.total ?? 0;

  // ─── Quick date pickers ───────────────────────────────────────────────────
  const today = new Date();
  const fmtD = (d: Date) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const quickDates = [
    { date: fmtD(today),                                tag: 'Today' },
    { date: fmtD(new Date(today.getTime() - 864e5)),    tag: '1d ago' },
    { date: fmtD(new Date(today.getTime() - 2*864e5)),  tag: '2d ago' },
    { date: fmtD(new Date(today.getTime() - 3*864e5)),  tag: '3d ago' },
  ];

  const todayLocal = fmtD(today);
  // Each file uploads with its own product line (auto-detected, editable per file).
  // Run is allowed once every queued file has a line resolved (so none upload blank).
  const step1Ready = connected && pdfs.length > 0 && allResolved && !!arrived;
  const step2Ready = connected && pdfs.length > 0;

  // ─── Run actions (SSE) ────────────────────────────────────────────────────
  async function runStep1() {
    if (step1 === 'running') { step1Abort.current?.abort(); setStep1('idle'); return; }
    setStep1('running');
    step1Abort.current = new AbortController();
    const queuedNames = pdfs.map(p => p.name);
    // Per-file product line: { filename: division } for every queued file.
    const lines: Record<string, string> = {};
    pdfs.forEach(p => { lines[p.name] = lineFor(p.name); });
    try {
      const r = await runStreamingScript('/api/run/step1', {
        params: { lines: JSON.stringify(lines), arrived, today: todayLocal },
        signal: step1Abort.current.signal,
        onLine: () => {},
      });
      if (r.conflicts?.length) {
        setStep1('idle');
        setConflicts(r.conflicts);
        setConflictCtx({ queuedNames });
      } else {
        setStep1(r.ok ? 'done' : 'err');
        toast(r.ok ? 'ok' : 'err', r.ok ? 'Step 1 completed' : 'Step 1 failed');
      }
    } catch { setStep1('err'); }
    refresh();
  }

  async function resolveConflicts(decisions: Record<string, { action: string; existingId: number }>) {
    setConflicts(null);
    setStep1('running');
    try {
      const r = await runStreamingScript('/api/run/step1/upload', {
        // CSV (with per-file divisions) is already written by the extract phase;
        // the upload phase just pushes it, so no division payload is needed here.
        body: { decisions, queuedNames: conflictCtx?.queuedNames || [] },
        onLine: () => {},
      });
      setStep1(r.ok ? 'done' : 'err');
      toast(r.ok ? 'ok' : 'err', r.ok ? 'Step 1 completed' : 'Step 1 failed');
    } catch { setStep1('err'); }
    setConflictCtx(null);
    refresh();
  }
  async function runStep2() {
    if (step2 === 'running') { step2Abort.current?.abort(); setStep2('idle'); return; }
    setStep2('running');
    step2Abort.current = new AbortController();
    try {
      const r = await runStreamingScript('/api/run/step2', {
        signal: step2Abort.current.signal,
        onLine: () => {},
      });
      setStep2(r.ok ? 'done' : 'err');
      toast(r.ok ? 'ok' : 'err', r.ok ? 'D&Q Store built' : 'Step 2 failed');
    } catch { setStep2('err'); }
    refresh();
  }

  // ─── Mini chart: last 14 days OK runs ─────────────────────────────────────
  const chartBuckets: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    chartBuckets[d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit' })] = 0;
  }
  jobs.forEach(j => {
    if (j.status !== 'ok') return;
    const d = new Date(j.timestamp);
    if (Date.now() - +d > 14 * 864e5) return;
    const k = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit' });
    if (k in chartBuckets) chartBuckets[k]++;
  });
  const chartData = Object.entries(chartBuckets).map(([k, v]) => ({
    label: k.split(' ')[1] || k, value: v,
  }));

  return (
    <div className="space-y-5">
      {conflicts && (
        <ConflictModal
          conflicts={conflicts}
          onResolve={resolveConflicts}
          onCancel={() => { setConflicts(null); setConflictCtx(null); }}
        />
      )}
      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile icon={FileUp}        label="In queue"        value={pdfs.length}      sub="awaiting Step 1"   accent="brand" />
        <KpiTile icon={Check}         label="Processed today" value={todayOk}          sub={`${todayJobs.length} total runs`} accent="ok" />
        <KpiTile icon={AlertCircle}   label="Failed today"    value={todayErr}         sub="see History"       accent="err" />
        <KpiTile icon={Archive}       label="Archived today"  value={archivedToday}    sub="files moved"       accent="violet" />
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* Left: workflow */}
        <div className="col-span-12 lg:col-span-8 space-y-5">

          <Card padded={false}>
            <div id="vec-upload-workflow" className="px-5 py-4 flex items-center justify-between border-b border-[var(--line)]">
              <div>
                <h2 className="text-[14px] font-semibold tracking-[-0.015em]">Upload workflow</h2>
                <p className="text-[11.5px] text-[var(--t3)] mt-1">Drop files → tag → run. Each run pushes to SharePoint.</p>
              </div>
              <div className="flex items-center gap-2.5">
                <button aria-label="Scan the last 30 days of mail for quotes that never reached SharePoint" onClick={runCheckup} disabled={checkupRunning}
                  title="Scan the last 30 days of mail for quotes that never reached SharePoint"
                  className="inline-flex items-center gap-1.5 h-[28px] px-2.5 rounded-[8px] text-[11px] font-semibold border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)', borderColor: 'var(--accent-line)' }}>
                  {checkupRunning
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
                    : <><MailSearch className="w-3 h-3" /> Quick check-up</>}
                  {!checkupRunning && checkup && checkup.counts.missing > 0 && (
                    <span className="ml-0.5 px-1.5 rounded-full text-[9.5px] font-bold num"
                          style={{ background: 'var(--warn)', color: '#fff' }}>{checkup.counts.missing}</span>
                  )}
                </button>
                <div className="flex items-center gap-1.5">
                  <WfStep n={1} label="Files"   done={pdfs.length > 0} />
                  <span className="w-[22px] h-px bg-[var(--line-2)]" />
                  <WfStep n={2} label="Details" done={allResolved && !!arrived} />
                  <span className="w-[22px] h-px bg-[var(--line-2)]" />
                  <WfStep n={3} label="Run"     done={step1 === 'done' || step2 === 'done'} />
                </div>
              </div>
            </div>

            {checkupOpen && (
              <CheckupPanel
                data={checkup}
                running={checkupRunning}
                queueing={queueing}
                picked={picked}
                setPicked={setPicked}
                onQueue={queuePicked}
                onClose={() => setCheckupOpen(false)}
                onRerun={runCheckup}
              />
            )}

            {/* Stage 1 — Files */}
            <Stage n={1} title="Files" right={<Pill tone="neutral">{pdfs.length} file{pdfs.length !== 1 ? 's' : ''}</Pill>}>
              <div {...getRootProps()} className={cn(
                'rounded-[12px] px-4 py-4 flex items-center justify-center gap-3 cursor-pointer transition-colors border-[1.5px] border-dashed',
                isDragActive
                  ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]'
                  : 'border-[var(--line-3)] bg-[var(--s1)] hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]',
              )}>
                <input {...getInputProps()} />
                <span className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
                  <UploadCloud className="w-[18px] h-[18px]" />
                </span>
                <div>
                  <p className="text-[12.5px] text-[var(--t1)] font-medium">
                    {isDragActive ? 'Release to add files' : 'Drop quote files here'}
                  </p>
                  <p className="text-[10.5px] text-[var(--t3)] mt-0.5">PDF, XLSX, DOCX · max 30 MB each</p>
                </div>
              </div>
              {pdfs.length > 0 && (
                <div className="mt-2.5 space-y-0.5 max-h-40 overflow-y-auto vec-scroll">
                  {pdfs.map(p => (
                    <div key={p.name} className="flex items-center gap-2.5 px-2 py-1.5 rounded-[9px] hover:bg-[var(--s3)] group text-[11.5px]">
                      <FileText className="w-3.5 h-3.5 text-[var(--t3)] shrink-0" />
                      <span className="truncate flex-1 font-medium text-[var(--t1)]">{p.name}</span>
                      <span className="text-[var(--t3)] num shrink-0">{(p.size / 1024).toFixed(0)} KB</span>
                      <span className="text-[var(--t3)] num shrink-0">{relTime(p.modified)}</span>
                      <button aria-label="Delete this PDF" onClick={() => deletePdf(p.name)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--t3)] hover:text-[var(--err)]">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Stage>

            {/* Stage 2 — Details */}
            <Stage n={2} title="Details" right={allResolved && !!arrived && <Pill tone="ok" dot>Ready</Pill>}>
              <div className="grid grid-cols-2 gap-5">
                <div>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <label className="block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--t3)]">Product line · per quote</label>
                    {pdfs.length > 1 && (
                      <select value=""
                        onChange={e => { const v = e.target.value; if (v) setFileLines(Object.fromEntries(pdfs.map(p => [p.name, v]))); }}
                        className="shrink-0 h-6 text-[10px] rounded-[7px] px-1.5 bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:outline-none focus:border-[var(--accent-line)]">
                        <option value="">Set all…</option>
                        {PRODUCT_OPTS.map(o => <option key={o} value={o}>{PRODUCT_LABELS[o] || o}</option>)}
                      </select>
                    )}
                  </div>

                  {pdfs.length === 0 ? (
                    <p className="text-[10.5px] text-[var(--t3)]">Drop files to auto-detect product lines.</p>
                  ) : (
                    <>
                      {suggesting && (
                        <p className="flex items-center gap-1.5 text-[10px] text-[var(--t3)] mb-2">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Detecting product line{isBulk ? `s · ${pdfs.length} quotes` : ''}…
                        </p>
                      )}
                      <div className="space-y-1 max-h-56 overflow-y-auto pr-0.5 vec-scroll">
                        {pdfs.map(p => {
                          const detected = detectedMap[p.name] || '';
                          const cur      = lineFor(p.name);
                          const isAuto   = !!cur && fileLines[p.name] == null;   // showing the detected value
                          return (
                            <div key={p.name} className={cn(
                              'flex items-center gap-2 px-2 py-1 rounded-[9px]',
                              cur ? 'hover:bg-[var(--s3)]' : '',
                            )} style={cur ? undefined : { background: 'var(--warn-soft)' }}>
                              <span className="w-[3px] h-4 rounded-[3px] shrink-0" style={{ background: cur ? (PRODUCT_COLORS[cur] || 'var(--t3)') : 'var(--warn)' }} />
                              <span className="truncate flex-1 text-[11px] font-medium text-[var(--t2)]" title={p.name}>{p.name}</span>
                              {isAuto && detected && (
                                <span className="shrink-0 text-[8px] font-bold uppercase tracking-wide" style={{ color: 'var(--accent-text)' }} title="Auto-detected">auto</span>
                              )}
                              <select value={cur}
                                onChange={e => setFileLines(prev => ({ ...prev, [p.name]: e.target.value }))}
                                style={cur ? undefined : { color: 'var(--warn)', borderColor: 'color-mix(in oklab, var(--warn) 45%, transparent)' }}
                                className={cn(
                                  'shrink-0 h-6 text-[10.5px] rounded-[7px] px-1 border focus:outline-none bg-[var(--s1)]',
                                  cur ? 'border-[var(--line-2)] text-[var(--t1)]' : '',
                                )}>
                                <option value="">Not detected</option>
                                {PRODUCT_OPTS.map(o => <option key={o} value={o}>{PRODUCT_LABELS[o] || o}</option>)}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                      {isBulk && lineBreakdown.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {lineBreakdown.map(([line, n]) => (
                            <span key={line}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[7px] text-[9.5px] font-medium bg-[var(--s3)] border border-[var(--line)] text-[var(--t2)]">
                              <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: line === 'UNKNOWN' ? 'var(--t3)' : (PRODUCT_COLORS[line] || 'var(--t3)') }} />
                              {line === 'UNKNOWN' ? 'Not detected' : (PRODUCT_LABELS[line] || line)} ×{n}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--t3)] mb-2">Quote received <span className="normal-case" style={{ color: 'var(--err)' }}>*</span></label>
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {quickDates.map(d => {
                      const on = arrived === d.date;
                      return (
                        <button key={d.tag} onClick={() => setArrived(d.date)}
                          style={on
                            ? { background: 'var(--accent)', color: 'var(--accent-ink)', border: '1px solid transparent' }
                            : { background: 'var(--s1)', color: 'var(--t2)', border: '1px solid var(--line-2)' }}
                          className="px-2.5 py-[5px] rounded-[8px] text-[11px] font-medium transition-colors">
                          {d.tag}
                          <span className="ml-1 opacity-60 num">{d.date.slice(0, 5)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="relative">
                    <Calendar className="absolute left-[11px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--t3)]" />
                    <input type="text" placeholder="DD/MM/YYYY" value={arrived} maxLength={10}
                      onChange={e => {
                        let v = e.target.value.replace(/[^\d/]/g, '');
                        if (v.length === 2 && !v.includes('/')) v = v + '/';
                        if (v.length === 5 && v.split('/').length === 2) v = v + '/';
                        setArrived(v);
                      }}
                      className="w-full h-[34px] pl-[34px] pr-2.5 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none num"
                    />
                  </div>
                  <p className="text-[10px] text-[var(--t3)] mt-2 leading-relaxed">Sets arrival, on-hold and recovery dates. Processed date is always today.</p>
                </div>
              </div>
            </Stage>

            {/* Stage 3 — Run */}
            <Stage n={3} title="Run" right={!connected && <Pill tone="warn" dot>Not connected to JOE</Pill>}>
              <div className="grid grid-cols-2 gap-3">
                <RunCard badge="STEP 1" tone="brand"
                  title="Quotation list upload"
                  sub="Extract quotes → push to SharePoint list"
                  ready={step1Ready} status={step1} onRun={runStep1} />
                <RunCard badge="STEP 2" tone="ok"
                  title="D&Q Store builder"
                  sub="Create folders → match emails → upload PDFs"
                  ready={step2Ready} status={step2} onRun={runStep2} />
              </div>
            </Stage>
          </Card>

          <Card>
            <CardTitle title="Processing volume — last 14 days"
                       sub="Successful runs from the local job log"
                       right={chartData.some(d => d.value > 0)
                         ? <Pill tone="ok" dot>{chartData.reduce((s, d) => s + d.value, 0)} runs</Pill>
                         : <Pill tone="neutral">No runs yet</Pill>} />
            <MiniBars data={chartData} />
          </Card>
        </div>

        {/* Right column */}
        <div className="col-span-12 lg:col-span-4 space-y-5">

          {/* ── New mail preview ──────────────────────────────────────────── */}
          <Card padded={false}>
            <div className="flex items-center justify-between px-[18px] py-3.5 border-b border-[var(--line)]">
              <div className="flex items-center gap-2.5">
                <Mail className="w-4 h-4" style={{ color: 'var(--violet)' }} />
                <h3 className="text-[13px] font-semibold tracking-tight flex-1">New mail</h3>
                {inboxEmails.filter(e => e.unread).length > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'var(--violet-soft)', color: 'var(--violet)' }}>
                    <span className="w-[5px] h-[5px] rounded-full" style={{ background: 'var(--violet)' }} />
                    {inboxEmails.filter(e => e.unread).length} unread
                  </span>
                )}
              </div>
              <button onClick={() => onTab('Inbox')} className="text-[11px] font-medium ml-2" style={{ color: 'var(--accent-text)' }}>Open →</button>
            </div>

            {inboxLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" />
              </div>
            ) : inboxEmails.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
                <Mail className="w-8 h-8 text-[var(--t4)]" />
                <p className="text-[12px] text-[var(--t3)]">No emails — make sure Outlook is open</p>
              </div>
            ) : (
              <div>
                {inboxEmails.slice(0, 6).map((email: any) => (
                  <button
                    key={email.entryId}
                    onClick={() => onTab('Inbox')}
                    style={email.unread ? { background: 'var(--violet-soft)' } : undefined}
                    className="w-full text-left px-[18px] py-[11px] transition-colors border-b border-[var(--line)] last:border-0 hover:bg-[var(--s3)] group">
                    <div className="flex items-center gap-2 min-w-0 mb-0.5">
                      {email.unread && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--violet)' }} />}
                      <span className={cn('text-[12px] truncate flex-1', email.unread ? 'font-semibold text-[var(--t1)]' : 'font-medium text-[var(--t2)]')}>
                        {email.subject || '(no subject)'}
                      </span>
                      <span className="text-[10px] text-[var(--t3)] shrink-0 num">{relTime(email.received)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[var(--t3)] truncate flex-1">{email.sender}</span>
                      {email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] font-semibold shrink-0" style={{ color: 'var(--accent-text)' }}>
                          <FileText className="w-2.5 h-2.5" /> PDF
                        </span>
                      )}
                      {email.attachments?.length > 0 && !email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] text-[var(--t3)] shrink-0">
                          <Paperclip className="w-2.5 h-2.5" />{email.attachments.length}
                        </span>
                      )}
                    </div>
                    {email.bodyPreview && (
                      <p className="text-[11px] text-[var(--t4)] leading-relaxed line-clamp-2 mt-1">
                        {email.bodyPreview}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card padded={false}>
            <div className="flex items-center justify-between px-[18px] py-3.5 border-b border-[var(--line)]">
              <h3 className="text-[13px] font-semibold tracking-tight">Recent jobs</h3>
              <button onClick={() => onTab('History')} className="text-[11px] font-medium" style={{ color: 'var(--accent-text)' }}>All →</button>
            </div>
            <div>
              {jobs.slice(0, 6).map(j => (
                <div key={j.id} className="flex items-center gap-2.5 px-[18px] py-2.5 border-b border-[var(--line)] last:border-0">
                  <StatusDot status={j.status} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] font-medium truncate text-[var(--t1)]">{j.step} · {j.customer || j.product || j.pdfName || '—'}</p>
                    <p className="text-[10px] text-[var(--t3)] truncate mono">{j.sfId || '—'} · {j.note || ''}</p>
                  </div>
                  <span className="text-[10px] text-[var(--t3)] num shrink-0">{relTime(j.timestamp)}</span>
                </div>
              ))}
              {jobs.length === 0 && (
                <p className="px-5 py-6 text-[11.5px] text-[var(--t3)] text-center">No jobs yet — run Step 1 to get started.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle title="Archive" sub="Files moved out of PDF Quotes" />
            {archive.length === 0
              ? <p className="text-[11.5px] text-[var(--t3)]">Nothing archived yet.</p>
              : (
                <div className="space-y-3.5">
                  {archive.map(day => (
                    <div key={day.date}>
                      <div className="flex items-baseline justify-between mb-1.5">
                        <p className="text-[11.5px] font-semibold text-[var(--t1)]">{day.date}</p>
                        <Pill tone="neutral">{day.total} files</Pill>
                      </div>
                      <ul className="space-y-0.5 border-l border-[var(--line-2)] pl-2.5">
                        {day.files.slice(0, 2).map(f => (
                          <li key={f} className="text-[10.5px] text-[var(--t3)] truncate">{f}</li>
                        ))}
                        {day.total > 2 && <li className="text-[10px] text-[var(--t4)]">+ {day.total - 2} more</li>}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Quick check-up panel ───────────────────────────────────────────────────
// Only 'missing' is actionable — the rest are shown so the scan is auditable
// (you can see WHY something was left out rather than trusting a silent filter).
const CHECKUP_META: Record<string, { label: string; tone: string; hint: string }> = {
  missing:    { label: 'Not uploaded', tone: 'var(--err)',   hint: 'No row on the Quotations List' },
  unverified: { label: 'Unverified',   tone: 'var(--warn)',  hint: 'SharePoint could not be checked' },
  noref:      { label: 'No reference', tone: 'var(--warn)',  hint: 'Quote mail with no SR/CR number' },
  queued:     { label: 'In queue',     tone: 'var(--accent-text)', hint: 'Already waiting in this queue' },
  processed:  { label: 'Processed',    tone: 'var(--ok)',    hint: 'Run through Step 1 on this machine' },
  uploaded:   { label: 'Uploaded',     tone: 'var(--ok)',    hint: 'Already on the Quotations List' },
};

function CheckupPanel({
  data, running, queueing, picked, setPicked, onQueue, onClose, onRerun,
}: {
  data: CheckupResponse | null;
  running: boolean;
  queueing: boolean;
  picked: Set<string>;
  setPicked: React.Dispatch<React.SetStateAction<Set<string>>>;
  onQueue: () => void;
  onClose: () => void;
  onRerun: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const items     = data?.items ?? [];
  const actionable = items.filter(i => i.status === 'missing' || i.status === 'unverified' || i.status === 'noref');
  const rest      = items.filter(i => !actionable.includes(i));
  const shown     = showAll ? items : actionable;

  function toggle(id: string) {
    setPicked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="px-5 py-4 border-b border-[var(--line)]" style={{ background: 'var(--s1)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MailSearch className="w-3.5 h-3.5" style={{ color: 'var(--accent-text)' }} />
          <h3 className="text-[12.5px] font-semibold">Quote check-up</h3>
          {data && (
            <span className="text-[10.5px] text-[var(--t3)]">
              {data.scanned} email{data.scanned !== 1 ? 's' : ''} scanned · last {data.days} days
            </span>
          )}
        </div>
        <button aria-label="Close" onClick={onClose} className="text-[var(--t3)] hover:text-[var(--t1)]"><X className="w-3.5 h-3.5" /></button>
      </div>

      {running ? (
        <div className="flex items-center gap-2 py-6 justify-center text-[11.5px] text-[var(--t3)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          Reading your mail and checking SharePoint…
        </div>
      ) : !data ? (
        <p className="py-6 text-center text-[11.5px] text-[var(--t3)]">Check-up did not complete.</p>
      ) : (
        <>
          {!data.connected && (
            <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-[10px] text-[11px]"
                 style={{ background: 'var(--warn-soft)', color: 'var(--t2)', border: '1px solid color-mix(in oklab, var(--warn) 35%, transparent)' }}>
              <CloudOff className="w-3.5 h-3.5 shrink-0 mt-px" style={{ color: 'var(--warn)' }} />
              <span>Not connected to JOE — nothing could be confirmed against SharePoint. Connect, then run the check-up again.</span>
            </div>
          )}

          {items.length === 0 ? (
            <p className="py-6 text-center text-[11.5px] text-[var(--t3)]">
              No quote emails found in the last {data.days} days.
            </p>
          ) : shown.length === 0 ? (
            <p className="py-5 text-center text-[11.5px]" style={{ color: 'var(--ok)' }}>
              Every quote email found is already uploaded. Nothing to do.
            </p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto vec-scroll pr-0.5">
              {shown.map(it => {
                const meta     = CHECKUP_META[it.status] || CHECKUP_META.noref;
                const selectable = it.status !== 'uploaded';
                const on       = picked.has(it.entryId);
                return (
                  <div key={it.entryId}
                    className="flex items-start gap-2.5 px-2 py-1.5 rounded-[9px] hover:bg-[var(--s3)]">
                    <input type="checkbox" checked={on} disabled={!selectable}
                      onChange={() => toggle(it.entryId)}
                      style={{ accentColor: 'var(--accent)' }}
                      className="mt-[3px] shrink-0 disabled:opacity-40" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[11.5px] font-medium text-[var(--t1)]" title={it.subject}>
                          {it.subject}
                        </span>
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-px rounded-[5px]"
                          style={{ color: meta.tone, background: 'color-mix(in oklab, currentColor 12%, transparent)' }}
                          title={meta.hint}>
                          {meta.label}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--t3)] truncate">
                        {it.sfid && <span className="mono">{it.refs[0] || it.sfid}</span>}
                        {it.sfid && ' · '}
                        {it.sender || it.senderEmail}
                        {' · '}<span className="num">{relTime(it.received)}</span>
                        {' · '}{it.folder.split('\\').pop()}
                      </p>
                      <p className="text-[10px] text-[var(--t4)] truncate">
                        {it.docs.map(d => d.name).join(', ')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--line)]">
            <div className="flex items-center gap-3 text-[10.5px] text-[var(--t3)]">
              <span><b className="text-[var(--t1)] num">{data.counts.missing}</b> not uploaded</span>
              {data.counts.unverified > 0 && <span><b className="num">{data.counts.unverified}</b> unverified</span>}
              <span><b className="num">{data.counts.uploaded}</b> already filed</span>
              {rest.length > 0 && (
                <button onClick={() => setShowAll(v => !v)} className="font-medium" style={{ color: 'var(--accent-text)' }}>
                  {showAll ? 'Show only actionable' : `Show all ${items.length}`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onRerun} disabled={queueing}
                className="h-[30px] px-3 rounded-[8px] text-[11px] font-semibold text-[var(--t1)] border border-[var(--line-2)] bg-[var(--s2)] hover:bg-[var(--s-hover)] disabled:opacity-60">
                Re-scan
              </button>
              <button onClick={onQueue} disabled={!picked.size || queueing}
                style={picked.size && !queueing
                  ? { background: 'var(--accent)', color: 'var(--accent-ink)', boxShadow: 'var(--glow)' }
                  : { background: 'var(--s2)', color: 'var(--t3)', border: '1px solid var(--line-2)' }}
                className="h-[30px] px-3.5 rounded-[8px] text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:cursor-not-allowed">
                {queueing
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Queueing…</>
                  : <><UploadCloud className="w-3 h-3" /> Send {picked.size || ''} to upload</>}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
function WfStep({ n, label, done }: { n: number; label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-[17px] h-[17px] rounded-full flex items-center justify-center text-[9px] font-bold"
        style={done ? { background: 'var(--ok)', color: '#fff' } : { background: 'var(--s3)', color: 'var(--t3)' }}>{done ? '✓' : n}</span>
      <span className="font-medium" style={{ color: done ? 'var(--t1)' : 'var(--t3)' }}>{label}</span>
    </div>
  );
}

function Stage({
  n, title, right, children,
}: {
  n: number; title: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 border-b border-[var(--line)] last:border-b-0">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[12.5px] font-semibold flex items-center gap-2">
          <span className="w-[19px] h-[19px] rounded-full bg-[var(--s3)] border border-[var(--line-2)] text-[var(--t1)] text-[10px] flex items-center justify-center font-bold num">{n}</span>
          {title}
        </h3>
        {right && <div>{right}</div>}
      </div>
      {children}
    </div>
  );
}

function RunCard({
  badge, tone, title, sub, ready, status, onRun,
}: {
  badge: string;
  tone: 'brand' | 'ok';
  title: string;
  sub: string;
  ready: boolean;
  status: 'idle' | 'running' | 'done' | 'err';
  onRun: () => void;
}) {
  const running = status === 'running';
  const done    = status === 'done';
  const err     = status === 'err';
  const primary = tone === 'brand';
  // Card frame: primary/ready step glows with the accent; secondary sits on the base surface.
  const frame = done ? { border: '1px solid color-mix(in oklab, var(--ok) 40%, transparent)', background: 'var(--ok-soft)' }
    : err ? { border: '1px solid color-mix(in oklab, var(--err) 40%, transparent)', background: 'var(--err-soft)' }
    : (primary || ready) ? { border: '1px solid var(--accent-line)', background: 'var(--accent-soft)' }
    : { border: '1px solid var(--line-2)', background: 'var(--s1)' };
  const btnStyle = done ? { background: 'var(--ok)', color: '#fff' }
    : err ? { background: 'var(--err)', color: '#fff' }
    : ready && primary ? { background: 'var(--accent)', color: 'var(--accent-ink)', boxShadow: 'var(--glow)' }
    : ready ? { background: 'var(--ok)', color: '#fff' }
    : { background: 'var(--s2)', color: 'var(--t3)', border: '1px solid var(--line-2)' };
  return (
    <div className="rounded-[12px] p-3.5 transition-colors" style={frame}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[9.5px] font-bold tracking-[0.05em] px-[7px] py-0.5 rounded-[6px]"
          style={primary ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { background: 'var(--ok-soft)', color: 'var(--ok)' }}>{badge}</span>
        {ready && !done && !running && !err && <Pill tone="ok" dot>Ready</Pill>}
        {done && <Pill tone="ok" dot>Done</Pill>}
        {err  && <Pill tone="err" dot>Failed</Pill>}
      </div>
      <h4 className="text-[12.5px] font-semibold mt-1 text-[var(--t1)]">{title}</h4>
      <p className="text-[10.5px] text-[var(--t2)] mt-1 mb-3 leading-snug">{sub}</p>
      <button onClick={onRun} disabled={!ready && !running}
        style={btnStyle}
        className="w-full h-[34px] rounded-[9px] text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:cursor-not-allowed">
        {running ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Stop</>
         : done   ? <><Check className="w-3.5 h-3.5" /> Completed · run again</>
         : err    ? <><AlertCircle className="w-3.5 h-3.5" /> Retry</>
                  : <><Play className="w-3.5 h-3.5" fill="currentColor" stroke="none" /> Run {badge.split(' ')[1]}</>}
      </button>
    </div>
  );
}

// ─── Conflict resolution modal ───────────────────────────────────────────────
type ConflictDecision = { action: 'replace' | 'add' | 'skip'; existingId: number };

function ConflictModal({
  conflicts, onResolve, onCancel,
}: {
  conflicts: ConflictItem[];
  onResolve: (decisions: Record<string, ConflictDecision>) => void;
  onCancel: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>(() => {
    const d: Record<string, ConflictDecision> = {};
    for (const c of conflicts) d[c.key] = { action: c.defaultAction, existingId: c.existingId };
    return d;
  });

  function setAction(key: string, action: ConflictDecision['action'], existingId: number) {
    setDecisions(prev => ({ ...prev, [key]: { action, existingId } }));
  }

  const dupes      = conflicts.filter(c => c.kind === 'duplicate').length;
  const blanks     = conflicts.filter(c => c.kind === 'blank').length;
  const incomplete = conflicts.filter(c => c.kind === 'incomplete').length;
  const headline   = [
    dupes      && `${plural(dupes, 'duplicate')}`,
    blanks     && `${blanks} unreadable`,
    incomplete && `${incomplete} incomplete`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="v3-pop rounded-[16px] w-full max-w-lg mx-4 bg-[var(--s2)] border border-[var(--line)]">
        <div className="px-5 py-4 border-b border-[var(--line)]">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--warn)' }} />
            <h2 className="text-[13px] font-semibold">Check Before Uploading</h2>
          </div>
          <p className="text-[11.5px] text-[var(--t3)] mt-1.5">
            {headline} — choose what to do with each row:
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-80 overflow-y-auto vec-scroll">
          {conflicts.map(c => (
            <div key={c.key} className="rounded-[11px] p-3" style={{ border: '1px solid color-mix(in oklab, var(--warn) 35%, transparent)', background: 'var(--warn-soft)' }}>
              <div className="flex items-baseline gap-2">
                <p className="text-[11px] font-semibold mono text-[var(--t1)] truncate">{c.rowLabel}</p>
                <span className="text-[9.5px] font-semibold uppercase tracking-wide text-[var(--t3)] shrink-0">
                  {c.kind === 'duplicate' ? `duplicate · ${c.matchedOn}`
                    : c.kind === 'blank'  ? 'nothing extracted'
                    : 'missing fields'}
                </span>
              </div>
              {c.sfid && <p className="text-[10px] mono text-[var(--t3)] mt-0.5">{c.sfid}</p>}
              {c.kind === 'duplicate' && (c.existingTitle || c.existingCustomer) && (
                <p className="text-[10.5px] text-[var(--t2)] truncate mt-0.5">
                  Already there: {c.existingTitle}
                  {c.existingCustomer && ` · ${c.existingCustomer}`}
                  {c.existingCreated  && ` · ${c.existingCreated}`}
                </p>
              )}
              {c.missing.length > 0 && (
                <p className="text-[10px] text-[var(--t3)] mt-0.5">
                  No {c.missing.join(', no ')} — SharePoint row will be incomplete
                </p>
              )}
              <div className="flex gap-4 mt-2.5">
                {(['replace', 'add', 'skip'] as const).map(action => (
                  action === 'replace' && !c.existingId ? null : (
                    <label key={action} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name={`dec-${c.key}`} value={action}
                        checked={decisions[c.key]?.action === action}
                        onChange={() => setAction(c.key, action, c.existingId)}
                        style={{ accentColor: 'var(--accent)' }} />
                      <span className="text-[11px] font-medium text-[var(--t2)]">
                        {action === 'replace' ? 'Replace' : action === 'add' ? 'Upload anyway' : 'Skip'}
                      </span>
                    </label>
                  )
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-[var(--line)] flex justify-end gap-2">
          <button onClick={onCancel}
            className="h-[34px] px-4 rounded-[9px] text-[11.5px] font-semibold text-[var(--t1)] border border-[var(--line-2)] bg-[var(--s2)] hover:bg-[var(--s-hover)]">
            Cancel
          </button>
          <button onClick={() => onResolve(decisions)}
            className="h-[34px] px-4 rounded-[9px] text-[11.5px] font-semibold v3-glow" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
