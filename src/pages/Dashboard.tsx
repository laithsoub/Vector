// ─── Dashboard page — wired to real API ──────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  FileUp, FileText, Trash2, AlertCircle, UploadCloud, Calendar, Play, Loader2, Check,
  TrendingUp, ChevronRight, Archive, Mail, Paperclip,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, StatusDot, fmtMoney, relTime } from '../lib/ui';
import { MiniBars, PRODUCT_COLORS } from '../lib/charts';
import { api, runStreamingScript } from '../lib/api';
import type { ConflictItem } from '../lib/api';
import type { Job, PdfFile, DashboardStats, ArchiveDay } from '../types';
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
  const [product, setProduct]   = useState('');
  const [arrived, setArrived]   = useState('');
  const [step1, setStep1]       = useState<'idle' | 'running' | 'done' | 'err'>('idle');
  const [step2, setStep2]       = useState<'idle' | 'running' | 'done' | 'err'>('idle');
  const step1Abort = useRef<AbortController | null>(null);
  const step2Abort = useRef<AbortController | null>(null);

  // ── Conflict resolution state ─────────────────────────────────────────────
  const [conflicts, setConflicts]       = useState<ConflictItem[] | null>(null);
  const [conflictCtx, setConflictCtx]   = useState<{ division: string; queuedNames: string[] } | null>(null);

  // ── Inbox preview ─────────────────────────────────────────────────────────
  const [inboxEmails, setInboxEmails]   = useState<any[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);

  const loadInbox = useCallback(async () => {
    try {
      const status = await api.outlookStatus();
      if (!status.available) { setInboxLoading(false); return; }
      const r = await api.outlookEmails('default', 9);
      setInboxEmails(r.emails || []);
    } catch { /* silent */ }
    setInboxLoading(false);
  }, []);

  useEffect(() => {
    loadInbox();
    const id = setInterval(loadInbox, 60_000);
    return () => clearInterval(id);
  }, [loadInbox]);

  const refresh = useCallback(async () => {
    try {
      const [s, j, p, a] = await Promise.all([
        api.stats(), api.jobs(), api.pdfs(), api.archive(),
      ]);
      setStats(s); setJobs(j); setPdfs(p); setArchive(a);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8_000);
    return () => clearInterval(id);
  }, [refresh]);

  const onDrop = useCallback(async (files: File[]) => {
    for (const f of files) {
      try { await api.uploadPdf(f); }
      catch (e: any) { toast('err', `${f.name}: ${e.message}`); }
    }
    if (files.length) toast('info', `${files.length} file${files.length > 1 ? 's' : ''} queued`);
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
    toast('info', `${name} removed`);
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
  const step1Ready = connected && pdfs.length > 0 && !!product && !!arrived;
  const step2Ready = connected && pdfs.length > 0;

  // ─── Run actions (SSE) ────────────────────────────────────────────────────
  async function runStep1() {
    if (step1 === 'running') { step1Abort.current?.abort(); setStep1('idle'); return; }
    setStep1('running');
    step1Abort.current = new AbortController();
    const queuedNames = pdfs.map(p => p.name);
    try {
      const r = await runStreamingScript('/api/run/step1', {
        params: { division: product, arrived, today: todayLocal },
        signal: step1Abort.current.signal,
        onLine: () => {},
      });
      if (r.conflicts?.length) {
        setStep1('idle');
        setConflicts(r.conflicts);
        setConflictCtx({ division: product, queuedNames });
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
        body: { decisions, division: conflictCtx?.division || '', queuedNames: conflictCtx?.queuedNames || [] },
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
        <KpiTile Icon={FileUp}        label="In queue"        value={pdfs.length}      sub="awaiting Step 1"   accent="brand" />
        <KpiTile Icon={Check}         label="Processed today" value={todayOk}          sub={`${todayJobs.length} total runs`} accent="ok" />
        <KpiTile Icon={AlertCircle}   label="Failed today"    value={todayErr}         sub="see History"       accent="err" />
        <KpiTile Icon={Archive}       label="Archived today"  value={archivedToday}    sub="files moved"       accent="violet" />
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* Left: workflow */}
        <div className="col-span-12 lg:col-span-8 space-y-5">

          <Card padded={false}>
            <div className="px-5 py-4 flex items-center justify-between border-b border-ink-200/70 dark:border-ink-800">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">Upload workflow</h2>
                <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-1">Drop files → tag → run. Each Run pushes to SharePoint.</p>
              </div>
              <div className="flex items-center gap-1.5">
                <WfStep n={1} label="Files"   done={pdfs.length > 0} />
                <span className="w-4 h-px bg-ink-200 dark:bg-ink-800" />
                <WfStep n={2} label="Details" done={!!product && !!arrived} />
                <span className="w-4 h-px bg-ink-200 dark:bg-ink-800" />
                <WfStep n={3} label="Run"     done={step1 === 'done' || step2 === 'done'} />
              </div>
            </div>

            {/* Stage 1 — Files */}
            <Stage n={1} title="Files" right={<Pill tone="neutral">{pdfs.length} file{pdfs.length !== 1 ? 's' : ''}</Pill>}>
              <div {...getRootProps()} className={cn(
                'border-2 border-dashed rounded-lg px-5 py-5 flex items-center justify-center gap-3 cursor-pointer transition-colors',
                isDragActive
                  ? 'border-brand-400 bg-brand-50/50 dark:bg-brand-900/15'
                  : 'border-ink-200 dark:border-ink-700 hover:border-brand-400 dark:hover:border-brand-500 hover:bg-brand-50/40 dark:hover:bg-brand-900/10',
              )}>
                <input {...getInputProps()} />
                <UploadCloud className="w-5 h-5 text-ink-400 shrink-0" />
                <div>
                  <p className="text-[12px] text-ink-700 dark:text-ink-200 font-medium">
                    {isDragActive ? 'Release to add files' : 'Drop quote files here'}
                  </p>
                  <p className="text-[10.5px] text-ink-400 mt-0.5">PDF, XLSX, DOCX · max 30 MB each</p>
                </div>
              </div>
              {pdfs.length > 0 && (
                <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
                  {pdfs.map(p => (
                    <div key={p.name} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-ink-50 dark:hover:bg-ink-800/60 group text-[11.5px]">
                      <FileText className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                      <span className="truncate flex-1 font-medium">{p.name}</span>
                      <span className="text-ink-400 num shrink-0">{(p.size / 1024).toFixed(0)} KB</span>
                      <span className="text-ink-400 num shrink-0">{relTime(p.modified)}</span>
                      <button onClick={() => deletePdf(p.name)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-400 hover:text-red-500">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Stage>

            {/* Stage 2 — Details */}
            <Stage n={2} title="Details" right={!!product && !!arrived && <Pill tone="ok" dot>Ready</Pill>}>
              <div className="grid grid-cols-2 gap-5">
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500 mb-2">Product line <span className="text-red-500 normal-case">*</span></label>
                  <div className="grid grid-cols-2 gap-1">
                    {PRODUCT_OPTS.map(p => {
                      const active = product === p;
                      const color  = PRODUCT_COLORS[p] || '#65656c';
                      return (
                        <button key={p} onClick={() => setProduct(p)}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors text-left',
                            active
                              ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-700/50'
                              : 'text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800/60',
                          )}>
                          <span className="w-1.5 h-4 rounded-sm shrink-0" style={{ background: color }} />
                          <span className="truncate">{PRODUCT_LABELS[p] || p}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500 mb-2">Quote received <span className="text-red-500 normal-case">*</span></label>
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {quickDates.map(d => (
                      <button key={d.tag} onClick={() => setArrived(d.date)}
                        className={cn(
                          'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
                          arrived === d.date
                            ? 'bg-brand-600 text-white'
                            : 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-200 dark:hover:bg-ink-700',
                        )}>
                        {d.tag}
                        <span className="ml-1 opacity-60 num">{d.date.slice(0, 5)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" />
                    <input type="text" placeholder="DD/MM/YYYY" value={arrived} maxLength={10}
                      onChange={e => {
                        let v = e.target.value.replace(/[^\d/]/g, '');
                        if (v.length === 2 && !v.includes('/')) v = v + '/';
                        if (v.length === 5 && v.split('/').length === 2) v = v + '/';
                        setArrived(v);
                      }}
                      className="w-full h-8 pl-8 pr-2 rounded-md text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 focus:ring-brand-400 focus:outline-none num"
                    />
                  </div>
                  <p className="text-[10px] text-ink-400 mt-2 leading-relaxed">Sets arrival, on-hold and recovery dates. Processed date is always today.</p>
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
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-200/70 dark:border-ink-800">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-violet-500" />
                <h3 className="text-[13px] font-semibold tracking-tight">New mail</h3>
                {inboxEmails.filter(e => e.unread).length > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 text-[10px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                    {inboxEmails.filter(e => e.unread).length} unread
                  </span>
                )}
              </div>
              <button onClick={() => onTab('Inbox')} className="text-[11px] font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300">Open →</button>
            </div>

            {inboxLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-ink-300" />
              </div>
            ) : inboxEmails.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
                <Mail className="w-8 h-8 text-ink-200 dark:text-ink-700" />
                <p className="text-[12px] text-ink-400 dark:text-ink-500">No emails — make sure Outlook is open</p>
              </div>
            ) : (
              <div className="divide-y divide-ink-100 dark:divide-ink-800">
                {inboxEmails.slice(0, 6).map((email: any) => (
                  <button
                    key={email.entryId}
                    onClick={() => onTab('Inbox')}
                    className={cn(
                      'w-full text-left px-5 py-3 transition-colors hover:bg-ink-50/80 dark:hover:bg-ink-800/40 group',
                      email.unread && 'bg-violet-50/40 dark:bg-violet-900/10',
                    )}>
                    <div className="flex items-center gap-2 min-w-0 mb-0.5">
                      {email.unread && <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />}
                      <span className={cn(
                        'text-[12px] truncate flex-1',
                        email.unread ? 'font-semibold text-ink-900 dark:text-ink-50' : 'font-medium text-ink-700 dark:text-ink-300',
                      )}>
                        {email.subject || '(no subject)'}
                      </span>
                      <span className="text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0 num">{relTime(email.received)}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] text-ink-500 dark:text-ink-400 truncate flex-1">{email.sender}</span>
                      {email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] font-medium text-brand-600 dark:text-brand-400 shrink-0">
                          <FileText className="w-2.5 h-2.5" /> PDF
                        </span>
                      )}
                      {email.attachments?.length > 0 && !email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] text-ink-400 shrink-0">
                          <Paperclip className="w-2.5 h-2.5" />{email.attachments.length}
                        </span>
                      )}
                    </div>
                    {email.bodyPreview && (
                      <p className="text-[11px] text-ink-400 dark:text-ink-500 leading-relaxed line-clamp-2">
                        {email.bodyPreview}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card padded={false}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-200/70 dark:border-ink-800">
              <h3 className="text-[13px] font-semibold tracking-tight">Recent jobs</h3>
              <button onClick={() => onTab('History')} className="text-[11px] font-medium text-brand-600 hover:text-brand-700">All →</button>
            </div>
            <div className="divide-y divide-ink-100 dark:divide-ink-800">
              {jobs.slice(0, 6).map(j => (
                <div key={j.id} className="flex items-center gap-2.5 px-5 py-2.5">
                  <StatusDot status={j.status} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] font-medium truncate">{j.step} · {j.customer || j.product || j.pdfName || '—'}</p>
                    <p className="text-[10px] text-ink-500 dark:text-ink-400 truncate mono">{j.sfId || '—'} · {j.note || ''}</p>
                  </div>
                  <span className="text-[10px] text-ink-400 num shrink-0">{relTime(j.timestamp)}</span>
                </div>
              ))}
              {jobs.length === 0 && (
                <p className="px-5 py-6 text-[11.5px] text-ink-400 text-center">No jobs yet — run Step 1 to get started.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle title="Archive" sub="Files moved out of PDF Quotes" />
            {archive.length === 0
              ? <p className="text-[11.5px] text-ink-500 dark:text-ink-400">Nothing archived yet.</p>
              : (
                <div className="space-y-3">
                  {archive.map(day => (
                    <div key={day.date}>
                      <div className="flex items-baseline justify-between">
                        <p className="text-[11.5px] font-semibold text-ink-700 dark:text-ink-200">{day.date}</p>
                        <Pill tone="neutral">{day.total} files</Pill>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {day.files.slice(0, 2).map(f => (
                          <li key={f} className="text-[10.5px] text-ink-500 dark:text-ink-400 truncate pl-1.5 border-l border-ink-200 dark:border-ink-700 ml-0.5">{f}</li>
                        ))}
                        {day.total > 2 && <li className="text-[10px] text-ink-400 pl-2">+ {day.total - 2} more</li>}
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

// ─── Sub-components ─────────────────────────────────────────────────────────
function KpiTile({
  Icon, label, value, sub, accent,
}: {
  Icon: typeof FileUp;
  label: string;
  value: number | string;
  sub: string;
  accent: 'brand' | 'ok' | 'err' | 'violet';
}) {
  const tones = {
    brand:  'text-brand-600 bg-brand-50 dark:bg-brand-900/30 dark:text-brand-300',
    ok:     'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300',
    err:    'text-red-600 bg-red-50 dark:bg-red-900/30 dark:text-red-300',
    violet: 'text-violet-600 bg-violet-50 dark:bg-violet-900/30 dark:text-violet-300',
  };
  return (
    <Card>
      <div className={cn('w-7 h-7 rounded-md flex items-center justify-center', tones[accent])}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">{label}</p>
      <p className="text-2xl font-semibold tracking-tight num mt-0.5">{value}</p>
      <p className="text-[10.5px] text-ink-500 dark:text-ink-400 mt-0.5">{sub}</p>
    </Card>
  );
}

function WfStep({ n, label, done }: { n: number; label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className={cn(
        'w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold',
        done ? 'bg-emerald-500 text-white' : 'bg-ink-200 dark:bg-ink-700 text-ink-500',
      )}>{done ? '✓' : n}</span>
      <span className={cn('font-medium', done ? 'text-ink-800 dark:text-ink-100' : 'text-ink-500 dark:text-ink-400')}>{label}</span>
    </div>
  );
}

function Stage({
  n, title, right, children,
}: {
  n: number; title: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 border-b border-ink-200/70 dark:border-ink-800 last:border-b-0">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[12px] font-semibold flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 text-[10px] flex items-center justify-center font-bold num">{n}</span>
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
  return (
    <div className={cn(
      'rounded-lg ring-1 ring-inset transition-colors p-3.5',
      done ? 'ring-emerald-300/70 dark:ring-emerald-700/40 bg-emerald-50/30 dark:bg-emerald-900/10' :
      err  ? 'ring-red-300/70 dark:ring-red-700/40 bg-red-50/30 dark:bg-red-900/10' :
      ready ? 'ring-brand-200 dark:ring-brand-700/50 bg-brand-50/30 dark:bg-brand-900/10'
            : 'ring-ink-200 dark:ring-ink-700',
    )}>
      <div className="flex items-center gap-1.5 mb-1">
        <Pill tone={tone}>{badge}</Pill>
        {ready && !done && !running && !err && <Pill tone="ok" dot>Ready</Pill>}
        {done && <Pill tone="ok" dot>Done</Pill>}
        {err  && <Pill tone="err" dot>Failed</Pill>}
      </div>
      <h4 className="text-[12.5px] font-semibold mt-1">{title}</h4>
      <p className="text-[10.5px] text-ink-500 dark:text-ink-400 mt-0.5 mb-3 leading-snug">{sub}</p>
      <button onClick={onRun} disabled={!ready && !running}
        className={cn(
          'w-full h-8 rounded-md text-[11.5px] font-semibold flex items-center justify-center gap-1.5 transition-colors',
          done ? 'bg-emerald-600 text-white hover:bg-emerald-700' :
          err  ? 'bg-red-600 text-white hover:bg-red-700' :
          ready
            ? (tone === 'brand' ? 'bg-brand-600 hover:bg-brand-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white')
            : 'bg-ink-100 dark:bg-ink-800 text-ink-400',
        )}>
        {running ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Stop</>
         : done   ? <><Check className="w-3.5 h-3.5" /> Completed · run again</>
         : err    ? <><AlertCircle className="w-3.5 h-3.5" /> Retry</>
                  : <><Play className="w-3.5 h-3.5" /> Run {badge.split(' ')[1]}</>}
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
    for (const c of conflicts) d[c.sfid] = { action: 'replace', existingId: c.existingId };
    return d;
  });

  function setAction(sfid: string, action: ConflictDecision['action'], existingId: number) {
    setDecisions(prev => ({ ...prev, [sfid]: { action, existingId } }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-ink-900 rounded-xl ring-1 ring-ink-200 dark:ring-ink-700 shadow-xl w-full max-w-lg mx-4">
        <div className="px-5 py-4 border-b border-ink-200/70 dark:border-ink-800">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
            <h2 className="text-[13px] font-semibold">Duplicate Quotes Found</h2>
          </div>
          <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-1.5">
            {conflicts.length} quote{conflicts.length > 1 ? 's' : ''} already exist in SharePoint. Choose what to do with each:
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-80 overflow-y-auto">
          {conflicts.map(c => (
            <div key={c.sfid} className="rounded-lg ring-1 ring-amber-200 dark:ring-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 p-3">
              <p className="text-[11px] font-semibold mono text-ink-700 dark:text-ink-200">{c.sfid}</p>
              {c.existingTitle    && <p className="text-[10.5px] text-ink-600 dark:text-ink-300 truncate mt-0.5">{c.existingTitle}</p>}
              {c.existingCustomer && <p className="text-[10px] text-ink-400 truncate">{c.existingCustomer}</p>}
              <div className="flex gap-4 mt-2.5">
                {(['replace', 'add', 'skip'] as const).map(action => (
                  <label key={action} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name={`dec-${c.sfid}`} value={action}
                      checked={decisions[c.sfid]?.action === action}
                      onChange={() => setAction(c.sfid, action, c.existingId)}
                      className="accent-brand-600" />
                    <span className="text-[11px] font-medium text-ink-700 dark:text-ink-200">
                      {action === 'replace' ? 'Replace' : action === 'add' ? 'Add (keep both)' : 'Skip'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-ink-200/70 dark:border-ink-800 flex justify-end gap-2">
          <button onClick={onCancel}
            className="h-8 px-4 rounded-md text-[11.5px] font-semibold text-ink-700 dark:text-ink-200 ring-1 ring-ink-200 dark:ring-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800">
            Cancel
          </button>
          <button onClick={() => onResolve(decisions)}
            className="h-8 px-4 rounded-md text-[11.5px] font-semibold bg-brand-600 text-white hover:bg-brand-700">
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
