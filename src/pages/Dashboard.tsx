// ─── Dashboard page — wired to real API ──────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileUp, FileText, Trash2, AlertCircle, UploadCloud, Calendar, Play, Loader2, Check,
  TrendingUp, ChevronRight, Archive, Mail, Paperclip, MailSearch, X, CloudOff,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { StatusDot, KpiTile, KpiBand, relTime } from '../lib/ui';
import {
  Badge, Button, Checkbox, DataTable, EmptyState, FileDrop, IconButton, Input, Modal, Panel,
  Section, Segmented, Select, Tooltip, useFormHotkeys, type StatusTone,
} from '../ui';
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

// Every format a quote arrives in, including German Angebot Word templates.
const ACCEPT = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.ms-word.template.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
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

const PRODUCT_DATA = PRODUCT_OPTS.map(o => ({ value: o, label: PRODUCT_LABELS[o] || o }));

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

  const unread = inboxEmails.filter(e => e.unread).length;
  const runsTotal = chartData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="flex flex-col gap-8">
      <ConflictModal
        conflicts={conflicts}
        onResolve={resolveConflicts}
        onCancel={() => { setConflicts(null); setConflictCtx(null); }}
      />

      <KpiBand>
        <KpiTile icon={FileUp}      label="In queue"        value={pdfs.length}   sub="awaiting Step 1"   accent="brand" />
        <KpiTile icon={Check}       label="Processed today" value={todayOk}       sub={`${todayJobs.length} total runs`} accent="ok" />
        <KpiTile icon={AlertCircle} label="Failed today"    value={todayErr}      sub="see History"       accent="err" />
        <KpiTile icon={Archive}     label="Archived today"  value={archivedToday} sub="files moved"       accent="violet" />
      </KpiBand>

      <div className="grid grid-cols-12 gap-x-8 gap-y-8">
        {/* ── Left: the workflow ── */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-8 min-w-0">
          <section id="vec-upload-workflow" className="min-w-0">
            <div className="flex items-end justify-between gap-4 pb-3 border-b border-line">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold tracking-tight">Upload workflow</h2>
                <p className="text-sm text-fg-3 mt-0.5">Drop files → tag → run. Each run pushes to SharePoint.</p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <ol className="hidden md:flex items-center gap-3">
                  <WfStep n={1} label="Files"   done={pdfs.length > 0} />
                  <WfStep n={2} label="Details" done={allResolved && !!arrived} />
                  <WfStep n={3} label="Run"     done={step1 === 'done' || step2 === 'done'} />
                </ol>
                <Button tone="secondary" icon={MailSearch} onClick={runCheckup} loading={checkupRunning}
                  hint="Scan the last 30 days of mail for quotes that never reached SharePoint"
                  trailing={!checkupRunning && checkup && checkup.counts.missing > 0
                    ? <Badge tone="warn" mono>{checkup.counts.missing}</Badge> : undefined}>
                  Quick check-up
                </Button>
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
            <Stage n={1} title="Files" right={<span className="mono text-xs text-fg-3">{plural(pdfs.length, 'file')}</span>}>
              <FileDrop onDrop={onDrop} accept={ACCEPT} inline
                label="Drop quote files here or click to browse"
                hint="PDF, XLSX, DOCX · max 30 MB each" />
              {pdfs.length > 0 && (
                <div className="mt-3">
                  <DataTable
                    dense
                    maxHeight="calc(var(--sp-16) * 3)"
                    rows={pdfs}
                    rowKey={p => p.name}
                    columns={[
                      { key: 'name', header: 'File', render: p => (
                        <span className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-fg-3 shrink-0" strokeWidth={1.75} />
                          <span className="truncate">{p.name}</span>
                        </span>
                      ) },
                      { key: 'size', header: 'Size', kind: 'num', width: 'calc(var(--sp-4) * 5.5)', render: p => `${(p.size / 1024).toFixed(0)} KB` },
                      { key: 'modified', header: 'Added', kind: 'num', width: 'calc(var(--sp-4) * 5.5)', render: p => relTime(p.modified) },
                      { key: 'x', header: '', width: 'var(--h-md)', align: 'end', render: p => (
                        <IconButton icon={Trash2} label="Remove from queue" tone="danger" size="sm" onClick={() => deletePdf(p.name)} />
                      ) },
                    ]}
                  />
                </div>
              )}
            </Stage>

            {/* Stage 2 — Details */}
            <Stage n={2} title="Details" right={allResolved && !!arrived && <Badge tone="ok" dot>Ready</Badge>}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="min-w-0">
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span className="text-xs font-medium text-fg-2">Product line · per quote</span>
                    {pdfs.length > 1 && (
                      <Select size="xs" placeholder="Set all…" value={null} data={PRODUCT_DATA} w="calc(var(--sp-16) * 2)"
                        onChange={v => { if (v) setFileLines(Object.fromEntries(pdfs.map(p => [p.name, v]))); }} />
                    )}
                  </div>

                  {pdfs.length === 0 ? (
                    <p className="text-sm text-fg-3">Drop files to auto-detect product lines.</p>
                  ) : (
                    <>
                      {suggesting && (
                        <p className="flex items-center gap-1.5 text-xs text-fg-3 mb-2">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Detecting product line{isBulk ? `s · ${pdfs.length} quotes` : ''}…
                        </p>
                      )}
                      <div className="flex flex-col max-h-56 overflow-y-auto border-t border-line">
                        {pdfs.map(p => {
                          const detected = detectedMap[p.name] || '';
                          const cur      = lineFor(p.name);
                          const isAuto   = !!cur && fileLines[p.name] == null;
                          return (
                            <div key={p.name} className={cn('flex items-center gap-2 py-1.5 border-b border-line', !cur && 'bg-warn-soft')}>
                              <span className="w-0.5 h-4 rounded-full shrink-0"
                                style={{ background: cur ? (PRODUCT_COLORS[cur] || 'var(--t3)') : 'var(--warn)' }} />
                              <span className="truncate flex-1 text-sm text-fg-2" title={p.name}>{p.name}</span>
                              {isAuto && detected && <Badge tone="accent" size="xs">auto</Badge>}
                              <Select size="xs" w="calc(var(--sp-4) * 9)" value={cur || null} placeholder="Not detected"
                                data={PRODUCT_DATA} error={!cur}
                                onChange={v => setFileLines(prev => ({ ...prev, [p.name]: v ?? '' }))} />
                            </div>
                          );
                        })}
                      </div>
                      {isBulk && lineBreakdown.length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                          {lineBreakdown.map(([line, n]) => (
                            <span key={line} className="inline-flex items-center gap-1.5 text-xs text-fg-2">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: line === 'UNKNOWN' ? 'var(--t3)' : (PRODUCT_COLORS[line] || 'var(--t3)') }} />
                              {line === 'UNKNOWN' ? 'Not detected' : (PRODUCT_LABELS[line] || line)}
                              <span className="mono text-fg-3">×{n}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="min-w-0">
                  <span className="block text-xs font-medium text-fg-2 mb-2">Quote received <span className="text-err">*</span></span>
                  <Segmented fullWidth
                    value={quickDates.find(d => d.date === arrived)?.tag ?? ''}
                    onChange={tag => { const d = quickDates.find(q => q.tag === tag); if (d) setArrived(d.date); }}
                    data={quickDates.map(d => ({
                      value: d.tag,
                      label: d.tag,
                    }))}
                  />
                  <Input mono icon={Calendar} className="mt-2" placeholder="DD/MM/YYYY" value={arrived} maxLength={10}
                    onChange={e => {
                      let v = e.currentTarget.value.replace(/[^\d/]/g, '');
                      if (v.length === 2 && !v.includes('/')) v = v + '/';
                      if (v.length === 5 && v.split('/').length === 2) v = v + '/';
                      setArrived(v);
                    }}
                    description="Sets arrival, on-hold and recovery dates. Processed date is always today."
                  />
                </div>
              </div>
            </Stage>

            {/* Stage 3 — Run */}
            <Stage n={3} title="Run" right={!connected && <Badge tone="warn" dot>Not connected to JOE</Badge>}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RunCard step={1} primary
                  title="Quotation list upload"
                  sub="Extract quotes → push to SharePoint list"
                  ready={step1Ready} status={step1} onRun={runStep1} />
                <RunCard step={2}
                  title="D&Q Store builder"
                  sub="Create folders → match emails → upload PDFs"
                  ready={step2Ready} status={step2} onRun={runStep2} />
              </div>
            </Stage>
          </section>

          <Section title="Processing volume" description="Successful runs over the last 14 days, from the local job log"
            actions={<span className="mono text-xs text-fg-3">{runsTotal ? plural(runsTotal, 'run') : 'No runs yet'}</span>}>
            <MiniBars data={chartData} />
          </Section>
        </div>

        {/* ── Right column ── */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-8 min-w-0">
          <Section title="New mail" icon={Mail}
            description={unread ? `${plural(unread, 'unread message')}` : undefined}
            actions={<Button tone="ghost" size="xs" onClick={() => onTab('Inbox')} trailing={<ChevronRight className="w-3 h-3" />}>Open</Button>}>
            {inboxLoading ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="w-4 h-4 animate-spin text-fg-4" /></div>
            ) : inboxEmails.length === 0 ? (
              <EmptyState compact icon={Mail} title="No emails" description="Make sure Outlook is open." />
            ) : (
              <div className="flex flex-col -mt-3">
                {inboxEmails.slice(0, 6).map((email: any) => (
                  <button key={email.entryId} onClick={() => onTab('Inbox')}
                    className="w-full text-left py-2.5 border-b border-line last:border-0 hover:bg-hover transition-colors -mx-2 px-2 rounded-control">
                    <div className="flex items-center gap-2 min-w-0">
                      {email.unread && <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent" />}
                      <span className={cn('text-sm truncate flex-1', email.unread ? 'font-semibold text-fg' : 'text-fg-2')}>
                        {email.subject || '(no subject)'}
                      </span>
                      <span className="mono text-2xs text-fg-3 shrink-0">{relTime(email.received)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-fg-3 truncate flex-1">{email.sender}</span>
                      {email.hasPdf && <Badge tone="accent" size="xs" leftSection={<FileText className="w-2.5 h-2.5" />}>PDF</Badge>}
                      {email.attachments?.length > 0 && !email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 mono text-2xs text-fg-3 shrink-0">
                          <Paperclip className="w-2.5 h-2.5" />{email.attachments.length}
                        </span>
                      )}
                    </div>
                    {email.bodyPreview && (
                      <p className="text-xs text-fg-4 leading-snug line-clamp-2 mt-1">{email.bodyPreview}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Recent jobs"
            actions={<Button tone="ghost" size="xs" onClick={() => onTab('History')} trailing={<ChevronRight className="w-3 h-3" />}>All</Button>}>
            {jobs.length === 0 ? (
              <EmptyState compact title="No jobs yet" description="Run Step 1 to get started." />
            ) : (
              <div className="flex flex-col -mt-3">
                {jobs.slice(0, 6).map(j => (
                  <div key={j.id} className="flex items-center gap-2.5 py-2 border-b border-line last:border-0">
                    <StatusDot status={j.status} size={6} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate text-fg">{j.step} · {j.customer || j.product || j.pdfName || '—'}</p>
                      <p className="mono text-2xs text-fg-3 truncate">{j.sfId || '—'}{j.note ? ` · ${j.note}` : ''}</p>
                    </div>
                    <span className="mono text-2xs text-fg-3 shrink-0">{relTime(j.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Archive" description="Files moved out of PDF Quotes">
            {archive.length === 0
              ? <p className="text-sm text-fg-3">Nothing archived yet.</p>
              : (
                <div className="flex flex-col gap-3">
                  {archive.map(day => (
                    <div key={day.date}>
                      <div className="flex items-baseline justify-between mb-1">
                        <p className="mono text-xs text-fg">{day.date}</p>
                        <span className="mono text-2xs text-fg-3">{plural(day.total, 'file')}</span>
                      </div>
                      <ul className="flex flex-col gap-0.5 border-l border-line-2 pl-2.5">
                        {day.files.slice(0, 2).map(f => (
                          <li key={f} className="text-xs text-fg-3 truncate">{f}</li>
                        ))}
                        {day.total > 2 && <li className="text-xs text-fg-4">+ {day.total - 2} more</li>}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Quick check-up panel ───────────────────────────────────────────────────
// Only 'missing' is actionable — the rest are shown so the scan is auditable
// (you can see WHY something was left out rather than trusting a silent filter).
const CHECKUP_META: Record<string, { label: string; tone: StatusTone; hint: string }> = {
  missing:    { label: 'Not uploaded', tone: 'err',    hint: 'No row on the Quotations List' },
  unverified: { label: 'Unverified',   tone: 'warn',   hint: 'SharePoint could not be checked' },
  noref:      { label: 'No reference', tone: 'warn',   hint: 'Quote mail with no SR/CR number' },
  queued:     { label: 'In queue',     tone: 'accent', hint: 'Already waiting in this queue' },
  processed:  { label: 'Processed',    tone: 'ok',     hint: 'Run through Step 1 on this machine' },
  uploaded:   { label: 'Uploaded',     tone: 'ok',     hint: 'Already on the Quotations List' },
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

  const items      = data?.items ?? [];
  const actionable = items.filter(i => i.status === 'missing' || i.status === 'unverified' || i.status === 'noref');
  const rest       = items.filter(i => !actionable.includes(i));
  const shown      = showAll ? items : actionable;

  function toggle(id: string) {
    setPicked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <Panel className="mt-4" icon={MailSearch} title="Quote check-up" tone="accent"
      description={data ? `${plural(data.scanned, 'email')} scanned · last ${data.days} days` : undefined}
      actions={<IconButton icon={X} label="Close check-up" size="sm" onClick={onClose} />}
      padding={running || !data || items.length === 0 || shown.length === 0 ? 'md' : 'none'}
      footer={data && !running ? (
        <div className="flex items-center justify-between w-full gap-3">
          <div className="flex items-center gap-3 text-xs text-fg-3">
            <span><span className="mono text-fg">{data.counts.missing}</span> not uploaded</span>
            {data.counts.unverified > 0 && <span><span className="mono">{data.counts.unverified}</span> unverified</span>}
            <span><span className="mono">{data.counts.uploaded}</span> already filed</span>
            {rest.length > 0 && (
              <Button tone="ghost" size="xs" onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show only actionable' : `Show all ${items.length}`}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={onRerun} disabled={queueing}>Re-scan</Button>
            <Button tone="primary" icon={UploadCloud} onClick={onQueue} loading={queueing} disabled={!picked.size}>
              Send {picked.size || ''} to upload
            </Button>
          </div>
        </div>
      ) : undefined}>
      {running ? (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-fg-3">
          <Loader2 className="w-4 h-4 animate-spin" />
          Reading your mail and checking SharePoint…
        </div>
      ) : !data ? (
        <p className="py-4 text-center text-sm text-fg-3">Check-up did not complete.</p>
      ) : (
        <>
          {!data.connected && (
            <div className="flex items-start gap-2 m-3 px-3 py-2 rounded-control text-sm text-fg-2 bg-warn-soft border border-warn-line">
              <CloudOff className="w-3.5 h-3.5 shrink-0 mt-0.5 text-warn" />
              <span>Not connected to JOE — nothing could be confirmed against SharePoint. Connect, then run the check-up again.</span>
            </div>
          )}
          {items.length === 0 ? (
            <p className="py-4 text-center text-sm text-fg-3">No quote emails found in the last {data.days} days.</p>
          ) : shown.length === 0 ? (
            <p className="py-4 text-center text-sm text-ok">Every quote email found is already uploaded. Nothing to do.</p>
          ) : (
            <DataTable
              dense wrap
              maxHeight="calc(var(--sp-16) * 4.5)"
              rows={shown}
              rowKey={it => it.entryId}
              columns={[
                { key: 'pick', header: '', width: 'var(--h-sm)', render: it => (
                  <Checkbox checked={picked.has(it.entryId)} disabled={it.status === 'uploaded'}
                    onChange={() => toggle(it.entryId)} aria-label={`Select ${it.subject}`} />
                ) },
                { key: 'subject', header: 'Email', render: it => (
                  <div className="min-w-0">
                    <p className="truncate text-fg" title={it.subject}>{it.subject}</p>
                    <p className="text-2xs text-fg-3 truncate">
                      {it.sfid && <span className="mono">{it.refs[0] || it.sfid} · </span>}
                      {it.sender || it.senderEmail} · {it.folder.split('\\').pop()}
                    </p>
                    <p className="text-2xs text-fg-4 truncate">{it.docs.map(d => d.name).join(', ')}</p>
                  </div>
                ) },
                { key: 'received', header: 'Received', kind: 'num', width: 'calc(var(--sp-4) * 5.5)', render: it => relTime(it.received) },
                { key: 'status', header: 'Status', width: 'calc(var(--sp-4) * 7.5)', render: it => {
                  const meta = CHECKUP_META[it.status] || CHECKUP_META.noref;
                  return <Tooltip label={meta.hint}><span><Badge tone={meta.tone} dot>{meta.label}</Badge></span></Tooltip>;
                } },
              ]}
            />
          )}
        </>
      )}
    </Panel>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
function WfStep({ n, label, done }: { n: number; label: string; done: boolean }) {
  return (
    <li className="flex items-center gap-1.5 text-xs">
      <span className={cn(
        'w-4 h-4 rounded-full flex items-center justify-center mono text-2xs border',
        done ? 'bg-ok border-ok text-on-status' : 'border-line-3 text-fg-3',
      )}>{done ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : n}</span>
      <span className={done ? 'text-fg' : 'text-fg-3'}>{label}</span>
    </li>
  );
}

function Stage({
  n, title, right, children,
}: {
  n: number; title: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="py-5 border-b border-line last:border-b-0 grid grid-cols-[var(--sp-8)_1fr] gap-x-2">
      <span className="mono text-sm text-fg-4 pt-px">{String(n).padStart(2, '0')}</span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between mb-3 gap-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          {right && <div>{right}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

function RunCard({
  step, primary = false, title, sub, ready, status, onRun,
}: {
  step: number;
  primary?: boolean;
  title: string;
  sub: string;
  ready: boolean;
  status: 'idle' | 'running' | 'done' | 'err';
  onRun: () => void;
}) {
  const running = status === 'running';
  const done    = status === 'done';
  const err     = status === 'err';
  return (
    <Panel padding="md" tone={done ? 'ok' : err ? 'err' : ready ? 'accent' : undefined}
      eyebrow={<span className="flex items-center gap-2">Step {step}
        {ready && !done && !running && !err && <Badge tone="ok" dot size="xs">Ready</Badge>}
        {done && <Badge tone="ok" dot size="xs">Done</Badge>}
        {err  && <Badge tone="err" dot size="xs">Failed</Badge>}
      </span>}
      title={title} description={sub}>
      <Button fullWidth size="md"
        tone={running ? 'secondary' : err ? 'danger' : ready && (primary || !done) ? 'primary' : 'secondary'}
        disabled={!ready && !running}
        onClick={onRun}
        icon={running ? <Loader2 className="animate-spin" /> : done ? Check : err ? AlertCircle : Play}>
        {running ? 'Stop' : done ? 'Completed · run again' : err ? 'Retry' : `Run step ${step}`}
      </Button>
    </Panel>
  );
}

// ─── Conflict resolution modal ───────────────────────────────────────────────
type ConflictDecision = { action: 'replace' | 'add' | 'skip'; existingId: number };

function ConflictModal({
  conflicts, onResolve, onCancel,
}: {
  conflicts: ConflictItem[] | null;
  onResolve: (decisions: Record<string, ConflictDecision>) => void;
  onCancel: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
  // Reset the choices each time a new batch of conflicts arrives.
  useEffect(() => {
    const d: Record<string, ConflictDecision> = {};
    for (const c of conflicts ?? []) d[c.key] = { action: c.defaultAction, existingId: c.existingId };
    setDecisions(d);
  }, [conflicts]);

  const list       = conflicts ?? [];
  const dupes      = list.filter(c => c.kind === 'duplicate').length;
  const blanks     = list.filter(c => c.kind === 'blank').length;
  const incomplete = list.filter(c => c.kind === 'incomplete').length;
  const headline   = [
    dupes      && `${plural(dupes, 'duplicate')}`,
    blanks     && `${blanks} unreadable`,
    incomplete && `${incomplete} incomplete`,
  ].filter(Boolean).join(' · ');
  const proceed = () => onResolve(decisions);
  useFormHotkeys({ onSubmit: proceed, enabled: !!conflicts });

  return (
    <Modal opened={!!conflicts} onClose={onCancel}
      title={<span className="flex items-center gap-2"><AlertCircle className="w-4 h-4 text-warn" />Check before uploading</span>}>
      <p className="text-sm text-fg-2 mb-3">{headline} — choose what to do with each row.</p>
      <div className="flex flex-col max-h-96 overflow-y-auto border-t border-line">
        {list.map(c => (
          <div key={c.key} className="py-3 border-b border-line">
            <div className="flex items-baseline gap-2 min-w-0">
              <p className="mono text-sm text-fg truncate">{c.rowLabel}</p>
              <Badge tone="warn" size="xs">
                {c.kind === 'duplicate' ? `duplicate · ${c.matchedOn}`
                  : c.kind === 'blank'  ? 'nothing extracted'
                  : 'missing fields'}
              </Badge>
            </div>
            {c.sfid && <p className="mono text-2xs text-fg-3 mt-0.5">{c.sfid}</p>}
            {c.kind === 'duplicate' && (c.existingTitle || c.existingCustomer) && (
              <p className="text-xs text-fg-2 truncate mt-0.5">
                Already there: {c.existingTitle}
                {c.existingCustomer && ` · ${c.existingCustomer}`}
                {c.existingCreated  && ` · ${c.existingCreated}`}
              </p>
            )}
            {c.missing.length > 0 && (
              <p className="text-xs text-fg-3 mt-0.5">No {c.missing.join(', no ')} — SharePoint row will be incomplete</p>
            )}
            <Segmented className="mt-2" size="xs"
              value={decisions[c.key]?.action ?? c.defaultAction}
              onChange={action => setDecisions(prev => ({ ...prev, [c.key]: { action, existingId: c.existingId } }))}
              data={([
                ...(c.existingId ? [{ value: 'replace' as const, label: 'Replace' }] : []),
                { value: 'add' as const, label: 'Upload anyway' },
                { value: 'skip' as const, label: 'Skip' },
              ])} />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button tone="ghost" onClick={onCancel}>Cancel</Button>
        <Button tone="primary" onClick={proceed} shortcut="submit">Proceed</Button>
      </div>
    </Modal>
  );
}
