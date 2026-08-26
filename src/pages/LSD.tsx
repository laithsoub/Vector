// ─── LSD Pricing — transaction in, feedback sheet out ────────────────────────
// Drop a CPQ "Export Line Items" transaction, fill the deal header, and the page
// prices every line by the LSD Daily Work Procedure, shows the working, then
// writes a case folder holding the transaction, the Approved Offer and the
// Working File (the master model itself, filled and toggled).
//
// Pricing lives in automation/lsd_pricing.py — this page never computes a price,
// it only shows what the engine decided and why. Preview is free and repeatable;
// Create case folder is the step that writes to disk and drives Excel.
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Tags, Loader2, Upload, FileSpreadsheet, FolderOpen, Download, X, RefreshCw,
  AlertCircle, CheckCircle2, AlertTriangle, Info, ChevronRight, Play, Hammer,
  Table2, ScrollText,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, Field, TextInput, Button, relTime } from '../lib/ui';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { LsdLine, LsdResult, LsdCase, LsdMeta } from '../lib/api';
import type { ToastFn } from '../App';

// ─── formatting ──────────────────────────────────────────────────────────────
const money = (n: number | null | undefined, cur = 'USD') =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${cur === 'EUR' ? '€' : '$'}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (n: number | null | undefined, dp = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(dp)}%`;

const num = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(dp);

// Severity → how the row reads. Matches the fills the engine paints into the
// Working File, so the screen and the spreadsheet agree.
const SEV: Record<LsdLine['severity'], { label: string; color: string; bg: string }> = {
  action: { label: 'Review', color: 'var(--err)',   bg: 'color-mix(in srgb, var(--err) 9%, transparent)' },
  verify: { label: 'Verify', color: 'var(--warn)',  bg: 'color-mix(in srgb, var(--warn) 10%, transparent)' },
  info:   { label: 'Note',   color: 'var(--t3)',    bg: 'transparent' },
  ok:     { label: 'OK',     color: 'var(--ok)',    bg: 'transparent' },
};

// A blank deal header. `transaction` names the case folder, so it carries the
// required marker in the form.
const EMPTY: Omit<LsdMeta, 'file'> = {
  customer: '', customer_name: '', country: '', project: '', transaction: '', crm: '',
  half: 'auto', aprc: 'auto', ledger: 'R2321',
};

// ─── one KPI ─────────────────────────────────────────────────────────────────
function Kpi({ label, value, tone, hint }: {
  label: string; value: React.ReactNode; tone?: string; hint?: string;
}) {
  return (
    <div className="flex-1 min-w-[112px] rounded-[11px] border border-[var(--line-2)] bg-[var(--s1)] px-3 py-2.5">
      <div className="text-[15px] font-semibold tabular-nums leading-none"
           style={{ color: tone || 'var(--t1)' }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--t3)] mt-1.5">{label}</div>
      {hint && <div className="text-[9.5px] text-[var(--t4)] mt-1 leading-tight">{hint}</div>}
    </div>
  );
}

// ─── the review table ────────────────────────────────────────────────────────
// Every column an approver asked for in the Working sheet, in the order they
// read them: what the customer asked, what the guardrails say, what won.
function LineTable({ lines, cur }: { lines: LsdLine[]; cur: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const H = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={cn('px-2 py-2 font-semibold text-[10px] uppercase tracking-wider text-[var(--t3)] whitespace-nowrap',
      right ? 'text-right' : 'text-left')}>{children}</th>
  );
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-[11.5px] border-collapse">
        <thead>
          <tr className="border-b border-[var(--line-2)]">
            <H>Line</H><H right>Qty</H><H right>Unit std</H><H right>Requested</H>
            <H right>@Target E2E</H><H right>Cap</H><H right>Add. disc</H>
            <H right>Unit net</H><H right>Total net</H><H right>E2E</H><H right>RPI</H>
            <H>Binds on</H>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const s = SEV[l.severity];
            const isOpen = open === i;
            return (
              <React.Fragment key={i}>
                <tr
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="border-b border-[var(--line-1)] cursor-pointer hover:bg-[var(--s-hover)] align-top"
                  style={{ background: isOpen ? 'var(--s3)' : s.bg }}
                >
                  <td className="px-2 py-2 max-w-[240px]">
                    <div className="flex items-start gap-1.5">
                      <ChevronRight className={cn('w-3 h-3 mt-0.5 shrink-0 transition-transform text-[var(--t4)]',
                        isOpen && 'rotate-90')} />
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--t1)] truncate">{l.material}</div>
                        <div className="text-[10px] text-[var(--t3)] truncate">{l.description || '—'}</div>
                        <div className="text-[9.5px] text-[var(--t4)] truncate">{l.group || 'no pricing group'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.qty.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{num(l.unit_std)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">
                    {num(l.requested)}
                    <div className="text-[9.5px] text-[var(--t4)]">{pct(l.req_disc)}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{pct(l.disc_at_target)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t4)]">20.0%</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium text-[var(--t1)]">{pct(l.add_disc)}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-semibold text-[var(--t1)]">{num(l.unit_net)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{money(l.total_net, cur)}</td>
                  <td className="px-2 py-2 text-right tabular-nums"
                      style={{ color: l.target_e2e && l.e2e !== null && l.e2e < l.target_e2e ? 'var(--err)' : 'var(--t2)' }}>
                    {pct(l.e2e)}
                    <div className="text-[9.5px] text-[var(--t4)]">tgt {pct(l.target_e2e, 0)}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{pct(l.rpi_after)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ color: s.color, background: 'color-mix(in srgb, currentColor 12%, transparent)' }}>
                      {l.binds}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-[var(--line-1)] bg-[var(--s3)]">
                    <td colSpan={12} className="px-4 py-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-[11px]">
                        {[
                          ['List price', num(l.list)],
                          ['STD discount', pct(l.std_disc)],
                          ['Unit cost', num(l.cost)],
                          ['Target E2E', pct(l.target_e2e, 0)],
                          ['Net @ target E2E', num(l.net_at_target)],
                          ['PY customer avg', l.cust_avg ? `${num(l.cust_avg)} · qty ${num(l.cust_qty, 0)}` : 'none'],
                          ['PY ledger avg', l.ctry_avg ? `${num(l.ctry_avg)} · qty ${num(l.ctry_qty, 0)}` : 'none'],
                          ['RPI floor price', l.rpi_floor ? num(l.rpi_floor) : 'none'],
                          ['RPI before', pct(l.rpi_before)],
                          ['RPI after', pct(l.rpi_after)],
                          ['Total standard', money(l.total_std, cur)],
                          ['Total cost', money(l.total_cost, cur)],
                        ].map(([k, v]) => (
                          <div key={k as string}>
                            <div className="text-[9.5px] uppercase tracking-wider text-[var(--t4)]">{k}</div>
                            <div className="tabular-nums text-[var(--t1)]">{v}</div>
                          </div>
                        ))}
                      </div>
                      {l.flags && (
                        <div className="mt-3 pt-3 border-t border-[var(--line-1)] flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: s.color }} />
                          <div className="text-[11px] text-[var(--t2)] leading-relaxed">{l.flags}</div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── the page ────────────────────────────────────────────────────────────────
export function LsdPage({ toast }: { toast: ToastFn }) {
  const [status, setStatus]   = useState<Awaited<ReturnType<typeof api.lsdStatus>> | null>(null);
  const [meta, setMeta]       = useState(EMPTY);
  const [file, setFile]       = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy]       = useState<'' | 'upload' | 'preview' | 'build'>('');
  const [result, setResult]   = useState<LsdResult | null>(null);
  const [built, setBuilt]     = useState<LsdResult | null>(null);
  const [cases, setCases]     = useState<LsdCase[]>([]);
  const [drag, setDrag]       = useState(false);
  const [showLog, setShowLog] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try { setStatus(await api.lsdStatus()); } catch { /* the banner covers it */ }
  }, []);
  const loadCases = useCallback(async () => {
    try { setCases((await api.lsdCases()).cases || []); } catch { setCases([]); }
  }, []);
  useEffect(() => { loadStatus(); loadCases(); }, [loadStatus, loadCases]);

  // Default the ledger from config once, without clobbering a typed value.
  useEffect(() => {
    if (status?.ledger) setMeta(m => (m.ledger === 'R2321' ? { ...m, ledger: status.ledger } : m));
  }, [status?.ledger]);

  const set = (k: keyof typeof EMPTY) => (v: string) => setMeta(m => ({ ...m, [k]: v }));

  const reset = () => {
    setFile(null); setResult(null); setBuilt(null); setMeta(EMPTY);
    if (inputRef.current) inputRef.current.value = '';
  };

  const take = useCallback(async (f: File) => {
    if (!/\.(csv|xlsx|xlsb)$/i.test(f.name)) {
      toast('err', 'Drop the CPQ line-item export (.csv, .xlsx or .xlsb).');
      return;
    }
    setBusy('upload'); setResult(null); setBuilt(null);
    try {
      const r = await api.lsdUpload(f);
      if (!r.ok || !r.file) { toast('err', r.error || 'Upload failed.'); return; }
      setFile({ path: r.file, name: r.name || f.name });
      // CPQ names the export <number>_<date>; the folder it came from usually
      // carries the W-number, but the file does not — so only prefill silently
      // when the name happens to contain one.
      const w = f.name.match(/\bW\d{9,}E\d*\b/i);
      if (w) setMeta(m => ({ ...m, transaction: m.transaction || w[0].toUpperCase() }));
      toast('ok', `${f.name} ready.`);
    } catch (e) { toast('err', failed('upload the transaction', e)); }
    finally { setBusy(''); }
  }, [toast]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) take(f);
  }, [take]);

  const price = async () => {
    if (!file) return;
    setBusy('preview'); setBuilt(null);
    try {
      const r = await api.lsdPreview({ ...meta, file: file.path });
      setResult(r);
      if (!r.ok) toast('err', r.error || 'Pricing failed.');
      else toast('ok', `${plural(r.summary?.lines || 0, 'line')} priced.`);
    } catch (e) { toast('err', failed('price the transaction', e)); }
    finally { setBusy(''); }
  };

  const build = async () => {
    if (!file) return;
    if (!meta.transaction.trim() && !meta.project.trim()) {
      toast('err', 'Give the case a transaction number or a project name — it names the folder.');
      return;
    }
    setBusy('build');
    try {
      const r = await api.lsdBuild({ ...meta, file: file.path });
      if (!r.ok) { toast('err', r.error || 'Build failed.'); setResult(r); return; }
      setResult(r); setBuilt(r);
      loadCases();
      // The staged upload is consumed by the build, so the form must not offer
      // to run it again against a file that is no longer there.
      setFile(null);
      if (r.checks && !r.checks.agree) toast('warn', 'Built — but the three-way total check disagreed. Open the Working File.');
      else toast('ok', 'Case folder written.');
    } catch (e) { toast('err', failed('build the case folder', e)); }
    finally { setBusy(''); }
  };

  const reveal = async (p: string) => {
    const r = await api.lsdReveal(p);
    if (!r.ok) toast('err', r.error || 'Could not open that folder.');
  };

  const s = result?.ok ? result.summary : undefined;
  const cur = s?.currency || 'USD';
  const flagged = useMemo(
    () => (result?.lines || []).filter(l => l.severity === 'action' || l.severity === 'verify').length,
    [result],
  );

  return (
    <div className="max-w-[1500px] mx-auto space-y-4">
      {/* master model missing — nothing works without it, so say so first */}
      {status && !status.master && (
        <Card className="border-[var(--err)]">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--err)' }} />
            <div className="text-[12px] text-[var(--t2)] leading-relaxed">
              <b className="text-[var(--t1)]">No master CPQ model.</b> Put the
              {' '}<code className="text-[11px]">CPQ Pricing Model LSD … V2</code>{' '}
              <code className="text-[11px]">.xlsb</code> in
              {' '}<code className="text-[11px]">{status.masterDir}</code>, or set its full path in
              Settings → LSD Pricing. Prices, costs, E2E targets and prior-year averages all come
              from it.
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-4 items-start">
        {/* ── left: the transaction and its header ── */}
        <div className="space-y-4">
          <Card>
            <CardTitle
              title="Transaction"
              sub="The CPQ line-item export, as downloaded"
              right={file && <Button tone="ghost" size="sm" Icon={X} onClick={reset}>Clear</Button>}
            />
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={cn(
                'rounded-[12px] border border-dashed px-4 py-6 text-center cursor-pointer transition-colors',
                drag ? 'border-[var(--accent)] bg-[var(--s3)]' : 'border-[var(--line-2)] hover:bg-[var(--s-hover)]',
              )}
            >
              <input
                ref={inputRef} type="file" accept=".csv,.xlsx,.xlsb" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) take(f); }}
              />
              {busy === 'upload' ? (
                <Loader2 className="w-5 h-5 mx-auto animate-spin text-[var(--t3)]" />
              ) : file ? (
                <>
                  <FileSpreadsheet className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--ok)' }} />
                  <div className="text-[12px] font-medium text-[var(--t1)] break-all">{file.name}</div>
                  <div className="text-[10.5px] text-[var(--t3)] mt-1">Click to replace</div>
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5 mx-auto mb-2 text-[var(--t3)]" />
                  <div className="text-[12px] text-[var(--t2)]">Drop the transaction here</div>
                  <div className="text-[10.5px] text-[var(--t4)] mt-1">.csv · .xlsx · .xlsb</div>
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle
              title="Deal header"
              sub="Customer # drives the prior-year lookup and fills the name and country"
            />
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Customer #">
                  <TextInput value={meta.customer} onChange={e => set('customer')(e.target.value)} placeholder="74895" />
                </Field>
                <Field label="Country">
                  <TextInput value={meta.country} onChange={e => set('country')(e.target.value)} placeholder="UAE" />
                </Field>
              </div>
              <Field label="Customer name" hint="Left blank, it is read from the model's Customer Master Data.">
                <TextInput value={meta.customer_name} onChange={e => set('customer_name')(e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Transaction #" required>
                  <TextInput value={meta.transaction} onChange={e => set('transaction')(e.target.value)} placeholder="W262168503E" />
                </Field>
                <Field label="CRM ID">
                  <TextInput value={meta.crm} onChange={e => set('crm')(e.target.value)} />
                </Field>
              </div>
              <Field label="Project name" hint="Transaction # and project name become the case folder name.">
                <TextInput value={meta.project} onChange={e => set('project')(e.target.value)} placeholder="MOPA Project" />
              </Field>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Half-year">
                  <select value={meta.half} onChange={e => set('half')(e.target.value)}
                    className="w-full h-[34px] px-2 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)]">
                    <option value="auto">Auto</option>
                    <option value="H1">H1 · 3.5%</option>
                    <option value="H2">H2 · 6%</option>
                  </select>
                </Field>
                <Field label="APRC">
                  <select value={meta.aprc} onChange={e => set('aprc')(e.target.value)}
                    className="w-full h-[34px] px-2 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)]">
                    <option value="auto">Auto</option>
                    <option value="525">525 · EUR</option>
                    <option value="530-535">530-535 · USD</option>
                  </select>
                </Field>
                <Field label="Ledger">
                  <TextInput value={meta.ledger} onChange={e => set('ledger')(e.target.value)} />
                </Field>
              </div>
              <p className="text-[10px] text-[var(--t4)] leading-relaxed">
                Auto reads the half-year from the export's date and the APRC from the pricing-group
                mix — FIRE prices in USD, EL in EUR.
              </p>
            </div>

            <div className="flex gap-2 mt-4">
              <Button tone="primary" size="lg" className="flex-1" Icon={busy === 'preview' ? Loader2 : Play}
                      disabled={!file || !!busy || !status?.master} onClick={price}>
                {busy === 'preview' ? 'Pricing…' : 'Price it'}
              </Button>
              <Button tone="dark" size="lg" Icon={busy === 'build' ? Loader2 : Hammer}
                      disabled={!file || !!busy || !status?.master} onClick={build}>
                {busy === 'build' ? 'Building…' : 'Create case folder'}
              </Button>
            </div>
            {busy === 'build' && (
              <p className="text-[10.5px] text-[var(--t3)] mt-2 text-center">
                Filling the master model in Excel — about 15 seconds.
              </p>
            )}
          </Card>

          {/* recent cases */}
          <Card>
            <CardTitle
              title="Case folders"
              sub={status?.casesRoot}
              right={<Button tone="ghost" size="sm" Icon={RefreshCw} onClick={loadCases} />}
            />
            {cases.length === 0 ? (
              <p className="text-[11.5px] text-[var(--t3)]">Nothing here yet.</p>
            ) : (
              <div className="space-y-1 max-h-[280px] overflow-y-auto vec-scroll -mx-1 px-1">
                {cases.map(c => (
                  <button key={c.path} onClick={() => reveal(c.path)}
                    className="w-full text-left px-2.5 py-2 rounded-[9px] hover:bg-[var(--s-hover)] transition-colors group">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--t4)] group-hover:text-[var(--accent)]" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11.5px] text-[var(--t1)] truncate">{c.name}</div>
                        <div className="text-[10px] text-[var(--t4)]">
                          {plural(c.files.length, 'file')} · {relTime(new Date(c.mtime).toISOString())}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* ── right: what the engine decided ── */}
        <div className="space-y-4">
          {!result && (
            <Card className="py-16">
              <div className="text-center">
                <Tags className="w-8 h-8 mx-auto mb-3 text-[var(--t4)]" />
                <p className="text-[13px] text-[var(--t2)]">Drop a transaction and press Price it.</p>
                <p className="text-[11.5px] text-[var(--t3)] mt-2 max-w-md mx-auto leading-relaxed">
                  Every line is priced at <b>MIN(requested discount, discount @ target E2E, 20%)</b>,
                  then pulled up to the half-year RPI floor if it sits below it. Nothing is rounded.
                </p>
              </div>
            </Card>
          )}

          {result && !result.ok && (
            <Card className="border-[var(--err)]">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--err)' }} />
                <div className="text-[12px] text-[var(--t2)] leading-relaxed">{result.error}</div>
              </div>
            </Card>
          )}

          {s && (
            <Card>
              <CardTitle
                title="Result"
                sub={`${result?.meta?.half} · APRC ${result?.meta?.aprc} · ledger ${result?.meta?.ledger}`}
                right={
                  <Button tone="ghost" size="sm" Icon={ScrollText} onClick={() => setShowLog(v => !v)}>
                    {showLog ? 'Hide log' : 'Log'}
                  </Button>
                }
              />
              <div className="flex flex-wrap gap-2">
                <Kpi label="Lines" value={s.lines} />
                <Kpi label={`Total net · ${cur}`} value={money(s.grand_total, cur)} />
                <Kpi label="Overall E2E" value={pct(s.overall_e2e)}
                     tone={s.overall_e2e !== null && s.overall_e2e < 0.35 ? 'var(--warn)' : 'var(--ok)'}
                     hint="target is a floor" />
                <Kpi label="Total RPI" value={pct(s.total_rpi)}
                     tone={s.total_rpi !== null && s.total_rpi < 0.06 ? 'var(--warn)' : 'var(--ok)'}
                     hint="price + mix variance" />
                <Kpi label="Raised to RPI" value={s.raised} />
                <Kpi label="Need a look" value={flagged}
                     tone={flagged ? 'var(--warn)' : 'var(--ok)'}
                     hint={`${s.action} review · ${s.verify} verify`} />
              </div>

              {s.no_py > 0 && (
                <div className="mt-3 flex items-start gap-2 text-[11px] text-[var(--t3)] leading-relaxed">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {plural(s.no_py, 'line')} have no prior-year reference — new items, so there is
                    no RPI floor to hold them. Those are the lines where a negotiated discount
                    usually goes in by hand.
                  </span>
                </div>
              )}

              {showLog && result?.log && (
                <div className="mt-3 rounded-[10px] border border-[var(--line-2)] bg-[var(--s1)] p-3 max-h-[240px] overflow-y-auto vec-scroll font-mono text-[10.5px] leading-relaxed">
                  {result.log.map((l, i) => (
                    <div key={i} style={{
                      color: l.kind === 'error' ? 'var(--err)' : l.kind === 'warn' ? 'var(--warn)'
                           : l.kind === 'ok' ? 'var(--ok)' : 'var(--t3)',
                    }}>{l.msg}</div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* what the build wrote */}
          {built?.ok && (
            <Card>
              <CardTitle
                title="Case folder"
                sub={built.case_dir}
                right={<Button tone="outline" size="sm" Icon={FolderOpen}
                               onClick={() => reveal(built.case_dir!)}>Open</Button>}
              />
              {built.checks && (
                <div className="flex items-center gap-2 mb-3 text-[11.5px]">
                  {built.checks.agree
                    ? <><CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--ok)' }} />
                        <span className="text-[var(--t2)]">
                          Three-way total check passed — ledger, Feedback sheet and engine all read {money(built.checks.python, cur)}.
                        </span></>
                    : <><AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warn)' }} />
                        <span className="text-[var(--t2)]">
                          Totals disagree — ledger {money(built.checks.ledger_T11, cur)}, Feedback {money(built.checks.feedback_L10, cur)}, engine {money(built.checks.python, cur)}.
                        </span></>}
                </div>
              )}
              <div className="space-y-1.5">
                {([
                  ['Transaction', built.bom, 'as dropped'],
                  ['Feedback sheet', built.feedback, 'Approved Offer — values only, ready to send'],
                  ['Working file', built.working, 'the master model, filled and toggled'],
                ] as const).map(([label, p, hint]) => p && (
                  <div key={label} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] border border-[var(--line-2)] bg-[var(--s1)]">
                    <FileSpreadsheet className="w-3.5 h-3.5 shrink-0 text-[var(--t4)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-[var(--t1)] truncate">{p.split(/[\\/]/).pop()}</div>
                      <div className="text-[10px] text-[var(--t4)]">{label} · {hint}</div>
                    </div>
                    <a href={api.lsdFileUrl(p)} download
                       className="shrink-0 p-1.5 rounded-md hover:bg-[var(--s-hover)] text-[var(--t3)] hover:text-[var(--accent)]"
                       title="Download">
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {result?.ok && result.lines && result.lines.length > 0 && (
            <Card>
              <CardTitle
                title="Every line, and why"
                sub="Click a line for its guardrails — cost, target E2E, prior-year averages, the RPI solve"
                right={<Pill tone={flagged ? 'warn' : 'ok'}>
                  <Table2 className="w-3 h-3" />{plural(result.lines.length, 'line')}
                </Pill>}
              />
              <LineTable lines={result.lines} cur={cur} />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
