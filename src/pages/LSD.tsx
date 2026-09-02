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
  Table2, ScrollText, Search, CloudDownload, CloudUpload, ClipboardList, ExternalLink,
  Mail, History, Plus, Minus, ArrowRight,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, Field, TextInput, Button, relTime } from '../lib/ui';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { LsdLine, LsdResult, LsdCase, LsdMeta, LsdRegister, LsdPushResult } from '../lib/api';
import { openExternal } from '../lib/shell';
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
// The wash has to survive a bright screen, so it is stronger than a hint, and
// every flagged row also carries a solid bar down its left edge — colour alone
// is both low-contrast and invisible to anyone who cannot separate red and amber.
const SEV: Record<LsdLine['severity'], { label: string; color: string; bg: string; bar: string }> = {
  action: { label: 'Review', color: 'var(--err)',  bar: 'var(--err)',
            bg: 'color-mix(in srgb, var(--err) 16%, transparent)' },
  verify: { label: 'Verify', color: 'var(--warn)', bar: 'var(--warn)',
            bg: 'color-mix(in srgb, var(--warn) 17%, transparent)' },
  info:   { label: 'Note',   color: 'var(--t2)',   bar: 'transparent', bg: 'transparent' },
  ok:     { label: 'OK',     color: 'var(--ok)',   bar: 'transparent', bg: 'transparent' },
};

// A blank deal header. `transaction` names the case folder, so it carries the
// required marker in the form.
const EMPTY: Omit<LsdMeta, 'file'> = {
  customer: '', customer_name: '', country: '', project: '', transaction: '', crm: '',
  half: 'auto', aprc: 'auto', ledger: 'R2321', revision: '',
  // These never touch the price — they are the daily register's own columns,
  // filled here because this is the only moment anyone knows them.
  bu: '', status: 'Priced', sales_name: '', cpq_updated: '', notes: '', rpi_comment: '',
};

// Statuses the daily sheet uses. Free text is allowed underneath, but the
// common four are one click.
const STATUSES = ['Priced', 'Pending Approval', 'Approved', 'Sent', 'On Hold'];

// ─── one KPI ─────────────────────────────────────────────────────────────────
function Kpi({ label, value, tone, hint }: {
  label: string; value: React.ReactNode; tone?: string; hint?: string;
}) {
  // A toned KPI carries its colour in the border and a wash behind it, not in
  // the number alone — a coloured digit on a white card is the first thing that
  // disappears on a bright screen.
  return (
    <div className="rounded-[11px] border px-3 py-2.5"
         style={{
           borderColor: tone ? `color-mix(in srgb, ${tone} 45%, transparent)` : 'var(--line-2)',
           background: tone ? `color-mix(in srgb, ${tone} 8%, var(--s1))` : 'var(--s1)',
         }}>
      <div className="text-[16px] font-semibold tabular-nums leading-none"
           style={{ color: tone || 'var(--t1)' }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--t2)] mt-1.5">{label}</div>
      {hint && <div className="text-[9.5px] text-[var(--t3)] mt-1 leading-tight">{hint}</div>}
    </div>
  );
}

// ─── the review table ────────────────────────────────────────────────────────
// Every column an approver asked for in the Working sheet, in the order they
// read them: what the customer asked, what the guardrails say, what won.
function LineTable({ lines, cur }: { lines: LsdLine[]; cur: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const H = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={cn('px-2 py-2 font-semibold text-[10px] uppercase tracking-wider text-[var(--t2)] whitespace-nowrap',
      right ? 'text-right' : 'text-left')}>{children}</th>
  );
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-[11.5px] border-collapse">
        <thead>
          <tr className="border-b-2 border-[var(--line-3)] bg-[var(--s3)]">
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
                  className="border-b border-[var(--line-2)] cursor-pointer hover:bg-[var(--s-hover)] align-top"
                  style={{
                    background: isOpen ? 'var(--s3)' : s.bg,
                    boxShadow: `inset 3px 0 0 0 ${s.bar}`,
                  }}
                >
                  <td className="px-2 py-2 max-w-[240px]">
                    <div className="flex items-start gap-1.5">
                      <ChevronRight className={cn('w-3 h-3 mt-0.5 shrink-0 transition-transform text-[var(--t3)]',
                        isOpen && 'rotate-90')} />
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--t1)] truncate">{l.material}</div>
                        <div className="text-[10px] text-[var(--t2)] truncate">{l.description || '—'}</div>
                        <div className="text-[9.5px] text-[var(--t3)] truncate">{l.group || 'no pricing group'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.qty.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{num(l.unit_std)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">
                    {num(l.requested)}
                    <div className="text-[9.5px] text-[var(--t3)]">{pct(l.req_disc)}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{pct(l.disc_at_target)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t3)]">20.0%</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium text-[var(--t1)]">{pct(l.add_disc)}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-semibold text-[var(--t1)]">{num(l.unit_net)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{money(l.total_net, cur)}</td>
                  <td className="px-2 py-2 text-right tabular-nums"
                      style={{ color: l.target_e2e && l.e2e !== null && l.e2e < l.target_e2e ? 'var(--err)' : 'var(--t2)' }}>
                    {pct(l.e2e)}
                    <div className="text-[9.5px] text-[var(--t3)]">tgt {pct(l.target_e2e, 0)}</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--t2)]">{pct(l.rpi_after)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border"
                          style={{ color: s.color,
                                   borderColor: 'color-mix(in srgb, currentColor 35%, transparent)',
                                   background: 'color-mix(in srgb, currentColor 14%, transparent)' }}>
                      {l.binds}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-[var(--line-2)] bg-[var(--s3)]">
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
                            <div className="text-[9.5px] uppercase tracking-wider text-[var(--t3)]">{k}</div>
                            <div className="tabular-nums text-[var(--t1)]">{v}</div>
                          </div>
                        ))}
                      </div>
                      {l.flags && (
                        <div className="mt-3 pt-3 border-t border-[var(--line-2)] flex items-start gap-2">
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
  const [cpqNum, setCpqNum]   = useState('');
  const [cpqBusy, setCpqBusy] = useState(false);
  const [cpqNote, setCpqNote] = useState('');
  // What the analyst's OneDrive already holds for this transaction.
  const [revNote, setRevNote] = useState('');
  const [reg, setReg]         = useState<LsdRegister | null>(null);
  const [regBusy, setRegBusy] = useState<'' | 'load' | 'upload' | 'save'>('');
  const [pushed, setPushed]   = useState<LsdPushResult | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailNote, setMailNote] = useState('');
  // The register's own columns are collapsed by default — CPQ fills them, and
  // open they doubled the height of the form.
  const [showReg, setShowReg] = useState(false);
  // The deal header folds away once there is a transaction to work on.
  const [editHdr, setEditHdr] = useState(false);
  // The archive lives at the foot of the page, shut until asked for.
  const [showCases, setShowCases] = useState(false);
  const [showRegCard, setShowRegCard] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try { setStatus(await api.lsdStatus()); } catch { /* the banner covers it */ }
  }, []);
  const loadCases = useCallback(async () => {
    try { setCases((await api.lsdCases()).cases || []); } catch { setCases([]); }
  }, []);
  const loadReg = useCallback(async () => {
    setRegBusy('load');
    try { setReg(await api.lsdRegister()); } catch { setReg(null); }
    finally { setRegBusy(''); }
  }, []);
  useEffect(() => { loadStatus(); loadCases(); loadReg(); }, [loadStatus, loadCases, loadReg]);

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

  // Pull the transaction straight from CPQ: BOM + customer/project/CRM, all filled.
  const fetchCpq = async () => {
    const w = cpqNum.trim();
    if (!w) return;
    setCpqBusy(true); setCpqNote(''); setRevNote(''); setResult(null); setBuilt(null);
    try {
      const r = await api.lsdCpqFetch(w);
      if (!r.ok || !r.file) { setCpqNote(r.error || 'Fetch failed.'); toast('err', r.error || 'CPQ fetch failed.'); return; }
      const h = r.header || {};
      setFile({ path: r.file, name: r.file.split(/[\\/]/).pop() || 'CPQ export' });
      setMeta(m => ({
        ...m,
        transaction:   h.transaction   || w,
        customer:      h.customer       ?? m.customer,
        customer_name: h.customer_name  ?? m.customer_name,
        project:       h.project        ?? m.project,
        crm:           h.crm            ?? m.crm,
        // Register columns CPQ is the only source for.
        sales_name:    h.sales_name     || m.sales_name,
        cpq_updated:   h.cpq_updated    || m.cpq_updated,
        status:        h.cpq_status     || m.status,
      }));
      // Has this been priced before? The lookup runs server-side on every fetch,
      // so the revision number and the file to diff against are already here.
      const rv = r.revisions;
      if (rv?.ok && (rv.latest || 0) > 0) {
        setMeta(m => ({ ...m, revision: rv.next || m.revision }));
        setRevNote(`Priced before — R${rv.latest} is the newest on file, so this is ${rv.next}.`
                   + (rv.pulled ? ` Pulled ${rv.pulled.name} to diff against.`
                                : ' No approved file found to carry prices from.'));
      } else if (rv?.ok) {
        setRevNote('Nothing on file for this transaction — first version.');
      } else if (rv?.error) {
        setRevNote(`Could not check for earlier revisions: ${rv.error}`);
      }
      // CPQ's header customer is the sold-to; some deals price a different
      // account, so make the auto-filled number visible, not silent.
      setCpqNote(`Fetched ${r.lines ?? ''} line(s). Customer ${h.customer || '?'} — CPQ's own; change it if you price a different account.`);
      toast('ok', `Pulled ${w} from CPQ.`);
    } catch (e) { setCpqNote(failed('reach CPQ', e)); toast('err', failed('reach CPQ', e)); }
    finally { setCpqBusy(false); }
  };

  // One run at a time, and Cancel needs a handle on it: the id goes to the
  // server with the job, the AbortController only stops us waiting.
  const runRef = useRef<{ id: string; ctl: AbortController } | null>(null);

  const startRun = () => {
    const run = { id: crypto.randomUUID(), ctl: new AbortController() };
    runRef.current = run;
    return run;
  };

  const cancelRun = async () => {
    const run = runRef.current;
    if (!run) return;
    setCancelling(true);
    try {
      const r = await api.lsdCancel(run.id);
      if (!r.ok) toast('warn', r.error || 'Nothing to cancel.');
      else toast('ok', 'Stopping — Excel is being closed cleanly.');
    } catch (e) { toast('err', failed('cancel the run', e)); }
  };

  const price = async () => {
    if (!file) return;
    const run = startRun();
    setBusy('preview'); setBuilt(null);
    try {
      const r = await api.lsdPreview({ ...meta, file: file.path, job_id: run.id }, run.ctl.signal);
      setResult(r);
      if (r.cancelled) toast('warn', 'Cancelled.');
      else if (!r.ok) toast('err', r.error || 'Pricing failed.');
      else toast('ok', `${plural(r.summary?.lines || 0, 'line')} priced.`);
    } catch (e) { toast('err', failed('price the transaction', e)); }
    finally { setBusy(''); setCancelling(false); runRef.current = null; }
  };

  // `rebuild` re-runs a case that is already on disk: no staged upload, the
  // transaction in the case folder is the source, and the files are overwritten
  // in place. Used after an engine fix, when the numbers should not move.
  const build = async (rebuild = false) => {
    if (!file && !rebuild) return;
    if (!meta.transaction.trim() && !meta.project.trim()) {
      toast('err', 'Give the case a transaction number or a project name — it names the folder.');
      return;
    }
    const run = startRun();
    setBusy('build');
    try {
      const r = await api.lsdBuild(
        { ...meta, file: file?.path || '', rebuild, job_id: run.id }, run.ctl.signal);
      if (r.cancelled) { toast('warn', 'Cancelled — the case folder may hold a part-written file.'); setResult(r); return; }
      if (!r.ok) { toast('err', r.error || 'Build failed.'); setResult(r); return; }
      setResult(r); setBuilt(r);
      loadCases(); loadReg();
      // The staged upload is consumed by the build, so the form must not offer
      // to run it again against a file that is no longer there.
      setFile(null);
      if (r.register && !r.register.ok) {
        toast('warn', `Built — but the register was not updated: ${r.register.error || 'unknown error'}`);
      } else if (r.checks && !r.checks.agree) {
        toast('warn', 'Built — but the three-way total check disagreed. Open the Working File.');
      } else {
        toast('ok', `Case folder written and ${r.register?.action === 'updated' ? 'register row updated' : 'registered'}.`);
      }
    } catch (e) { toast('err', failed('build the case folder', e)); }
    finally { setBusy(''); setCancelling(false); runRef.current = null; }
  };

  const reveal = async (p: string) => {
    const r = await api.lsdReveal(p);
    if (!r.ok) toast('err', r.error || 'Could not open that folder.');
  };

  // The approval ask. The engine does not raise a sub-target margin to hide it —
  // it goes to the approver instead, in his own format, with the ledger-only
  // .xlsm attached. This only ever DRAFTS: Outlook opens it and a human sends.
  const draftApproval = async () => {
    if (!built?.ok || !built.summary || !built.meta) return;
    setMailBusy(true); setMailNote('');
    try {
      const r = await api.lsdApprovalMail({
        summary: built.summary, meta: built.meta,
        attach: built.ledger ? [built.ledger] : [],
      });
      if (!r.ok) { setMailNote(r.error || 'Could not draft the mail.'); toast('err', r.error || 'Could not draft the mail.'); return; }
      setMailNote(`Draft open in Outlook — to ${r.to}${r.cc ? `, cc ${r.cc}` : ''}`
                  + `${r.attached?.length ? ` · ${r.attached[0]}` : ''}. Nothing is sent until you press Send.`);
      toast('ok', 'Approval draft opened in Outlook.');
    } catch (e) { setMailNote(failed('draft the approval mail', e)); toast('err', failed('draft the approval mail', e)); }
    finally { setMailBusy(false); }
  };

  // Register the transaction on its own — for a case that was built before the
  // register existed, or one priced but not built.
  const registerNow = async () => {
    const sm = result?.ok ? result.summary : undefined;
    if (!sm) { toast('err', 'Price the transaction first — the register logs its totals.'); return; }
    setRegBusy('save');
    try {
      const r = await api.lsdRegisterSave({
        country: meta.country, bu: meta.bu || (result?.meta?.aprc === '530-535' ? 'FIRE' : 'EL'),
        transaction: meta.transaction, transaction_name: meta.project,
        customer: meta.customer, customer_name: meta.customer_name,
        status: meta.status, sales_name: meta.sales_name, cpq_updated: meta.cpq_updated,
        total_value: sm.grand_total, out_date: new Date().toISOString().slice(0, 10),
        notes: meta.notes || `Vector · ${sm.lines} lines · ${sm.currency}`,
        rpi_comment: meta.rpi_comment,
        pv_pct: sm.overall_rpi, rpi_pct: sm.total_rpi, rpi_value: sm.rpi_value,
      });
      if (!r.ok) { toast('err', r.error || 'Could not write the register.'); return; }
      toast('ok', r.action === 'updated' ? 'Register row updated.' : 'Registered.');
      loadReg();
    } catch (e) { toast('err', failed('write the register', e)); }
    finally { setRegBusy(''); }
  };

  // Post the register's transactions to the Quotations List — one item each,
  // the same list and the same cookies the quotes go up with. The register file
  // itself stays on this machine.
  const pushReg = async (only: string[] = []) => {
    setRegBusy('upload'); setPushed(null);
    try {
      const r = await api.lsdRegisterPush(only);
      if (!r.ok) { toast('err', r.error || 'Upload failed.'); return; }
      setPushed(r);
      const bits = [r.added ? `${r.added} added` : '', r.updated ? `${r.updated} updated` : '',
                    r.skipped ? `${r.skipped} skipped` : '', r.failed ? `${r.failed} failed` : '']
                   .filter(Boolean).join(', ');
      toast(r.failed ? 'warn' : 'ok', `Quotations List — ${bits || 'nothing to post'}.`);
    } catch (e) { toast('err', failed('post to the Quotations List', e)); }
    finally { setRegBusy(''); }
  };

  const s = result?.ok ? result.summary : undefined;
  const cur = s?.currency || 'USD';
  const flagged = useMemo(
    () => (result?.lines || []).filter(l => l.severity === 'action' || l.severity === 'verify').length,
    [result],
  );

  // The deal header is the widest thing on the page while it is open and dead
  // weight once a case is priced, so it lives in a strip that folds shut. It
  // opens on its own when there is nothing to price yet — a blank page with a
  // collapsed form has nothing to act on.
  const headerOpen = editHdr || !file;

  return (
    // Source order is strip → archive → result; `order` puts the result second
    // on screen. It saves moving 130 lines of archive markup that is otherwise
    // unchanged, and the archive is the one block that never needs to be near
    // the top.
    <div className="max-w-[1600px] mx-auto flex flex-col gap-3">
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

      {/* ── the strip: where the transaction comes from, who it is for, and the
          two buttons. One band across the top, so nothing that matters after
          pricing sits in a narrow column. ── */}
      <Card className="order-1">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)_auto] gap-3 items-center">
          {/* Fetch straight from CPQ — BOM + customer/project/CRM in one go */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--t3)] pointer-events-none" />
              <input
                value={cpqNum}
                onChange={e => setCpqNum(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !cpqBusy) fetchCpq(); }}
                placeholder="Transaction #  ·  W262168503E"
                className="w-full h-[36px] pl-8 pr-2.5 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
            </div>
            <Button tone="primary" Icon={cpqBusy ? Loader2 : CloudDownload}
                    disabled={cpqBusy || !cpqNum.trim()} onClick={fetchCpq}>
              {cpqBusy ? 'Fetching…' : 'Fetch'}
            </Button>
          </div>

          {/* the drop target, on the same line rather than under it */}
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'h-[36px] flex items-center gap-2 px-3 rounded-[9px] border border-dashed cursor-pointer transition-colors min-w-0',
              drag ? 'border-[var(--accent)] bg-[var(--s3)]'
                   : file ? 'border-[var(--line-3)] bg-[var(--s1)]'
                          : 'border-[var(--line-2)] hover:bg-[var(--s-hover)]',
            )}
          >
            <input
              ref={inputRef} type="file" accept=".csv,.xlsx,.xlsb" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) take(f); }}
            />
            {busy === 'upload'
              ? <Loader2 className="w-4 h-4 animate-spin text-[var(--t3)] shrink-0" />
              : file
                ? <FileSpreadsheet className="w-4 h-4 shrink-0" style={{ color: 'var(--ok)' }} />
                : <Upload className="w-4 h-4 text-[var(--t3)] shrink-0" />}
            <span className={cn('text-[12px] truncate', file ? 'text-[var(--t1)]' : 'text-[var(--t2)]')}>
              {file ? file.name : 'Drop the transaction here — .csv · .xlsx · .xlsb'}
            </span>
            {file && (
              <button onClick={e => { e.stopPropagation(); reset(); }}
                      className="ml-auto shrink-0 p-1 rounded hover:bg-[var(--s-hover)] text-[var(--t3)]"
                      title="Clear">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex gap-2 justify-end">
            {busy ? (
              // While a run is in flight the only useful control is the one that
              // stops it. Cancel asks the engine to unwind so Excel closes with
              // it — a killed process would leave Excel holding the master open.
              <Button tone="outline" Icon={cancelling ? Loader2 : X}
                      disabled={cancelling} onClick={cancelRun}>
                {cancelling ? 'Stopping…' : `Cancel ${busy === 'build' ? 'the build' : 'pricing'}`}
              </Button>
            ) : (
              <>
                <Button tone="primary" Icon={Play}
                        disabled={!file || !status?.master} onClick={() => price()}>
                  Price it
                </Button>
                <Button tone="dark" Icon={Hammer}
                        disabled={!file || !status?.master} onClick={() => build(false)}>
                  Create case folder
                </Button>
                {/* A case already on disk can be re-run without a fresh export —
                    after an engine fix, or when a build was cancelled part-way. */}
                {!file && (built?.ok || meta.transaction.trim()) && (
                  <Button tone="outline" Icon={RefreshCw}
                          disabled={!status?.master} onClick={() => build(true)}>
                    Rebuild
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {cpqNote && (
          <p className="text-[10.5px] text-[var(--t3)] mt-2 leading-relaxed flex items-start gap-1.5">
            <Info className="w-3 h-3 shrink-0 mt-0.5" />{cpqNote}
          </p>
        )}
        {revNote && (
          <p className="text-[10.5px] mt-1.5 leading-relaxed flex items-start gap-1.5"
             style={{ color: 'var(--t2)' }}>
            <History className="w-3 h-3 shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
            {revNote}
          </p>
        )}
        {busy === 'build' && (
          <p className="text-[10.5px] text-[var(--t3)] mt-2">
            Filling the master model in Excel — about 15 seconds.
          </p>
        )}

        {/* who the deal is for: one readable line, expandable to the real form */}
        <div className="mt-3 pt-3 border-t border-[var(--line-2)]">
          <button type="button" onClick={() => setEditHdr(v => !v)}
                  className="w-full flex items-center gap-2 text-left">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--t2)] shrink-0">
              Deal header
            </span>
            <span className="text-[11.5px] text-[var(--t1)] truncate">
              {[meta.transaction, meta.customer && `#${meta.customer}`, meta.customer_name,
                meta.country, meta.project].filter(Boolean).join(' · ') || 'Nothing filled in yet'}
            </span>
            <span className="ml-auto shrink-0 flex items-center gap-2">
              <span className="text-[10px] text-[var(--t3)] whitespace-nowrap">
                {meta.half === 'auto' ? 'half auto' : meta.half} · APRC {meta.aprc} · {meta.ledger}
              </span>
              <ChevronRight className={cn('w-3.5 h-3.5 text-[var(--t3)] transition-transform',
                                          headerOpen && 'rotate-90')} />
            </span>
          </button>
        </div>

        {headerOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-[10.5px] text-[var(--t3)]">
              Customer # drives the prior-year lookup and fills the name and country. Transaction #
              and project name become the case folder name.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              <Field label="Customer #">
                <TextInput value={meta.customer} onChange={e => set('customer')(e.target.value)} placeholder="74895" />
              </Field>
              <Field label="Country">
                <TextInput value={meta.country} onChange={e => set('country')(e.target.value)} placeholder="UAE" />
              </Field>
              <div className="col-span-2">
                <Field label="Customer name" hint="Blank = read from the model's Customer Master Data.">
                  <TextInput value={meta.customer_name} onChange={e => set('customer_name')(e.target.value)} />
                </Field>
              </div>

              <Field label="Transaction #" required>
                <TextInput value={meta.transaction} onChange={e => set('transaction')(e.target.value)} placeholder="W262168503E" />
              </Field>
              <Field label="CRM ID">
                <TextInput value={meta.crm} onChange={e => set('crm')(e.target.value)} />
              </Field>
              <div className="col-span-2">
                <Field label="Project name">
                  <TextInput value={meta.project} onChange={e => set('project')(e.target.value)} placeholder="MOPA Project" />
                </Field>
              </div>

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
              <Field label="Revision"
                     hint="R1, R2, R3 … Blank = first version.">
                <TextInput value={meta.revision || ''} onChange={e => set('revision')(e.target.value)}
                           placeholder="R4" />
              </Field>
              <p className="text-[10px] text-[var(--t3)] leading-relaxed self-end pb-1.5 col-span-2">
                Auto reads the half-year from the export's date and the APRC from the
                pricing-group mix — FIRE in USD, EL in EUR. A revision writes into the same
                case folder with its prefix, and every line the previous revision already
                carried keeps the price the customer was quoted.
              </p>
            </div>

            {/* The register's own columns. None of them touch a price — they are
                what the daily sheet asks for beside the numbers, and this is the
                only screen where anyone knows them. */}
            <div className="mt-4 pt-3 border-t border-[var(--line-2)] space-y-3">
              <button type="button" onClick={() => setShowReg(v => !v)}
                      className="w-full flex items-center gap-2 text-left group">
                <ClipboardList className="w-3.5 h-3.5 text-[var(--t2)]" />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--t2)]">
                  Daily register
                </span>
                <span className="text-[10.5px] text-[var(--t3)] truncate">
                  {meta.bu || 'auto'} · {meta.status || 'Priced'}
                  {meta.sales_name ? ` · ${meta.sales_name}` : ''}
                </span>
                <ChevronRight className={cn('w-3.5 h-3.5 ml-auto shrink-0 text-[var(--t3)] transition-transform',
                                            showReg && 'rotate-90')} />
              </button>
              {!showReg && (
                <p className="text-[10px] text-[var(--t3)] leading-relaxed">
                  CPQ fills these. Open only to correct one — building the case writes the row either way.
                </p>
              )}
              {showReg && <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <Field label="BU">
                  <select value={meta.bu || ''} onChange={e => set('bu')(e.target.value)}
                    className="w-full h-[34px] px-2 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)]">
                    <option value="">Auto</option>
                    <option value="EL">EL</option>
                    <option value="FIRE">FIRE</option>
                    <option value="CBS">CBS</option>
                  </select>
                </Field>
                <Field label="Status">
                  <select value={meta.status || 'Priced'} onChange={e => set('status')(e.target.value)}
                    className="w-full h-[34px] px-2 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)]">
                    {STATUSES.map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                </Field>
                <Field label="CPQ updated">
                  <TextInput value={meta.cpq_updated || ''} onChange={e => set('cpq_updated')(e.target.value)}
                             placeholder="2026-08-26" />
                </Field>
                <Field label="Sales name">
                  <TextInput value={meta.sales_name || ''} onChange={e => set('sales_name')(e.target.value)}
                             placeholder="Blank = Settings" />
                </Field>
                <Field label="RPI comment">
                  <TextInput value={meta.rpi_comment || ''} onChange={e => set('rpi_comment')(e.target.value)} />
                </Field>
                <Field label="Notes" hint="Blank writes lines, E2E and currency.">
                  <TextInput value={meta.notes || ''} onChange={e => set('notes')(e.target.value)} />
                </Field>
              </div>
              <p className="text-[10px] text-[var(--t3)] leading-relaxed">
                Creating the case folder also writes one row into
                {' '}<b className="text-[var(--t2)]">{reg?.name || 'the daily register'}</b>. Building the
                same transaction again updates that row rather than adding a second one.
              </p>
              </>}
            </div>
          </div>
        )}
      </Card>

      {/* ── the archive, at the foot of the page: two strips side by side, and
          neither of them competes with the working area any more. ── */}
      <div className="order-3 grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
          {/* recent cases */}
          <Card>
            {/* The refresh control is a sibling of the toggle, never inside it —
                a button nested in a button is invalid and swallows the click. */}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowCases(v => !v)}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left">
                <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-[var(--t3)] transition-transform',
                                            showCases && 'rotate-90')} />
                <span className="text-[12.5px] font-semibold text-[var(--t1)] shrink-0">Case folders</span>
                <span className="text-[10.5px] text-[var(--t3)] truncate">
                  {cases.length ? `${plural(cases.length, 'case')} · ${status?.casesRoot || ''}` : status?.casesRoot}
                </span>
              </button>
              <Button tone="ghost" size="sm" Icon={RefreshCw} onClick={loadCases} />
            </div>
            {showCases && (cases.length === 0 ? (
              <p className="text-[11.5px] text-[var(--t3)] mt-2">Nothing here yet.</p>
            ) : (
              <div className="space-y-1 max-h-[280px] overflow-y-auto vec-scroll -mx-1 px-1 mt-2">
                {cases.map(c => (
                  <button key={c.path} onClick={() => reveal(c.path)}
                    className="w-full text-left px-2.5 py-2 rounded-[9px] hover:bg-[var(--s-hover)] transition-colors group">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--t3)] group-hover:text-[var(--accent)]" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11.5px] text-[var(--t1)] truncate">{c.name}</div>
                        <div className="text-[10px] text-[var(--t3)]">
                          {plural(c.files.length, 'file')} · {relTime(new Date(c.mtime).toISOString())}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </Card>

          {/* the daily register — one row per priced transaction, and the button
              that puts it on SharePoint */}
          <Card>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowRegCard(v => !v)}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left">
                <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-[var(--t3)] transition-transform',
                                            showRegCard && 'rotate-90')} />
                <span className="text-[12.5px] font-semibold text-[var(--t1)] shrink-0">Daily register</span>
                <span className="text-[10.5px] text-[var(--t3)] truncate">
                  {reg?.exists
                    ? `${plural(reg.total || 0, 'transaction')} · ${reg.name}`
                    : 'Nothing registered yet'}
                </span>
              </button>
              <Button tone="ghost" size="sm" Icon={regBusy === 'load' ? Loader2 : RefreshCw}
                      onClick={loadReg} />
            </div>
            {showRegCard && <div className="mt-2">
            {reg?.error && (
              <p className="text-[11px] mb-2" style={{ color: 'var(--err)' }}>{reg.error}</p>
            )}
            {reg?.rows && reg.rows.length > 0 && (
              <div className="overflow-x-auto -mx-1 px-1 mb-3">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--line-2)] text-[9.5px] uppercase tracking-wider text-[var(--t3)]">
                      <th className="text-left py-1.5 pr-2 font-semibold">Transaction</th>
                      <th className="text-left py-1.5 pr-2 font-semibold">Status</th>
                      <th className="text-right py-1.5 pr-2 font-semibold">Total</th>
                      <th className="text-right py-1.5 font-semibold">Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...reg.rows].reverse().slice(0, 8).map(r => (
                      <tr key={r._row} className="border-b border-[var(--line-2)]">
                        <td className="py-1.5 pr-2 max-w-[150px]">
                          <div className="text-[var(--t1)] truncate">{r.transaction || '—'}</div>
                          <div className="text-[9.5px] text-[var(--t3)] truncate">{r.transaction_name || ''}</div>
                        </td>
                        <td className="py-1.5 pr-2 text-[var(--t2)] whitespace-nowrap">{r.status || '—'}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-[var(--t2)] whitespace-nowrap">
                          {typeof r.total_value === 'number'
                            ? r.total_value.toLocaleString(undefined, { maximumFractionDigits: 0 })
                            : '—'}
                        </td>
                        <td className="py-1.5 text-right text-[10px] text-[var(--t3)] whitespace-nowrap">{r.out_date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button tone="primary" size="sm" className="flex-1"
                      Icon={regBusy === 'upload' ? Loader2 : CloudUpload}
                      disabled={!!regBusy || !reg?.exists || !reg?.connected}
                      onClick={() => pushReg()}>
                {regBusy === 'upload' ? 'Posting…' : 'Upload to SharePoint'}
              </Button>
              <Button tone="outline" size="sm" Icon={ClipboardList}
                      disabled={!result?.ok || !!regBusy} onClick={registerNow}>
                Register this one
              </Button>
              {reg?.exists && (
                <>
                  <Button tone="ghost" size="sm" Icon={FolderOpen}
                          onClick={() => reveal(reg.register)}>Open</Button>
                  <a href={api.lsdRegisterFileUrl()} download
                     className="shrink-0 p-1.5 rounded-md hover:bg-[var(--s-hover)] text-[var(--t3)] hover:text-[var(--accent)]"
                     title="Download the register">
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </>
              )}
            </div>

            {!reg?.connected && (
              <p className="text-[10px] text-[var(--t3)] mt-2 leading-relaxed">
                Not connected to SharePoint — run Connect to JOE and the upload button lights up.
              </p>
            )}
            <p className="text-[10px] text-[var(--t3)] mt-2 leading-relaxed">
              The workbook stays on this machine. Upload posts each transaction as an item in
              {' '}<b className="text-[var(--t3)]">{reg?.sp?.list || 'Quotations List'}</b> — the same
              list the quotes go to — as {reg?.sp?.requestType || 'Standard CTO'}. A transaction
              already in the list is updated, not duplicated.
            </p>
            {pushed && (
              <div className="mt-2 rounded-[9px] border border-[var(--line-2)] bg-[var(--s1)] p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] text-[var(--t2)]">
                    {pushed.added || 0} added · {pushed.updated || 0} updated
                    {pushed.skipped ? ` · ${pushed.skipped} skipped` : ''}
                    {pushed.failed ? ` · ${pushed.failed} failed` : ''}
                  </span>
                  {pushed.site && (
                    <button onClick={() => void openExternal(pushed.site!)}
                      className="inline-flex items-center gap-1 text-[10.5px] text-[var(--accent)] hover:underline">
                      <ExternalLink className="w-3 h-3" />Open the list
                    </button>
                  )}
                </div>
                {/* Only the rows that did not land — a clean run says nothing. */}
                {(pushed.results || []).filter(x => x.action === 'skipped' || x.action === 'failed')
                  .slice(0, 6).map(x => (
                    <div key={x.transaction} className="text-[10px] text-[var(--t3)] leading-relaxed">
                      <b className="text-[var(--t2)]">{x.transaction || '—'}</b>: {x.reason}
                    </div>
                  ))}
              </div>
            )}
            </div>}
          </Card>
        </div>

      {/* ── what the engine decided: the whole width, because the line table is
          the widest thing on this page and was the one thing boxed in. ── */}
      <div className="order-2 space-y-3">
          {!result && (
            <Card className="py-10">
              <div className="text-center">
                <Tags className="w-8 h-8 mx-auto mb-3 text-[var(--t3)]" />
                <p className="text-[13px] text-[var(--t1)]">Drop a transaction and press Price it.</p>
                <p className="text-[11.5px] text-[var(--t2)] mt-2 max-w-md mx-auto leading-relaxed">
                  Every line takes the <b>requested discount as asked</b>, then lifts to the
                  prior-year average × the half-year RPI gate if it prices under it. A margin
                  below its target E2E is flagged for approval, never priced away. Nothing is rounded.
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
              {/* The one-liner first: what this transaction is, before any table. */}
              {s.headline && (
                <div className="mb-3 px-3 py-2.5 rounded-[10px] border border-[var(--line-2)] bg-[var(--s3)]
                                text-[12.5px] text-[var(--t1)] leading-relaxed">
                  {s.headline}
                </div>
              )}
              {/* One row on a wide screen, two up on a phone — never a column. */}
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
                <Kpi label="Lines" value={s.lines} />
                <Kpi label={`Total net · ${cur}`} value={money(s.grand_total, cur)} />
                <Kpi label="E2E @ proposed" value={pct(s.overall_e2e)}
                     tone={s.target_e2e && s.overall_e2e !== null && s.overall_e2e < s.target_e2e
                             ? 'var(--warn)' : 'var(--ok)'}
                     hint={s.target_e2e ? `target ${pct(s.target_e2e, 0)}` : 'no target on these groups'} />
                <Kpi label="Total RPI" value={pct(s.total_rpi)}
                     tone={s.rpi_rate !== undefined && s.total_rpi !== null && s.total_rpi < s.rpi_rate
                             ? 'var(--warn)' : 'var(--ok)'}
                     hint="price + mix variance" />
                <Kpi label="E2E @ target" value={pct(s.at_target?.e2e)}
                     hint={s.at_target ? `${money(s.at_target.target_price, cur)} · RPI ${pct(s.at_target.rpi_pct)}` : 'as requested'} />
                {!!s.carried && (
                  <Kpi label="Held from prior" value={s.carried}
                       hint={`${s.lines - s.carried} priced fresh`} />
                )}
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
                right={<div className="flex gap-2">
                  <Button tone="outline" size="sm" Icon={busy === 'build' ? Loader2 : RefreshCw}
                          disabled={!!busy} onClick={() => build(true)}>Rebuild</Button>
                  <Button tone="outline" size="sm" Icon={FolderOpen}
                          onClick={() => reveal(built.case_dir!)}>Open</Button>
                </div>}
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
              {built.register && (
                <div className="flex items-center gap-2 mb-3 text-[11.5px]">
                  {built.register.ok
                    ? <><ClipboardList className="w-3.5 h-3.5" style={{ color: 'var(--ok)' }} />
                        <span className="text-[var(--t2)]">
                          Register row {built.register.action === 'updated' ? 'updated' : 'added'} in{' '}
                          {built.register.path.split(/[\/]/).pop()}
                          {built.register.skipped.length > 0
                            && ` · ${plural(built.register.skipped.length, 'column')} not in that sheet`}
                        </span></>
                    : <><AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warn)' }} />
                        <span className="text-[var(--t2)]">
                          Not registered — {built.register.error}. Press <b>Register this one</b> to retry.
                        </span></>}
                </div>
              )}
              {/* The approval ask. Shown whenever a line prices under its target
                  E2E — that margin is somebody's decision, not the engine's. */}
              {!!built.summary?.below_target && (
                <div className="mb-3 p-3 rounded-[10px] border border-[var(--line-2)]"
                     style={{ background: 'color-mix(in srgb, var(--warn) 7%, transparent)' }}>
                  <div className="flex items-start gap-2 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                    <div className="text-[11.5px] text-[var(--t2)] leading-relaxed">
                      {plural(built.summary.below_target, 'line')} price under target —{' '}
                      <b>E2E {pct(built.summary.overall_e2e)}</b> against a{' '}
                      {pct(built.summary.target_e2e, 0)} target. The price was not raised to
                      cover it, so this margin needs an approval.
                      {built.summary.at_target && (
                        <> At the customer's target price{' '}
                          {money(built.summary.at_target.target_price, cur)} it would be{' '}
                          E2E {pct(built.summary.at_target.e2e)}, RPI{' '}
                          {pct(built.summary.at_target.rpi_pct)}.</>
                      )}
                    </div>
                  </div>
                  <Button tone="outline" size="sm" Icon={mailBusy ? Loader2 : Mail}
                          disabled={mailBusy} onClick={draftApproval}>
                    {mailBusy ? 'Drafting…' : 'Draft the approval mail'}
                  </Button>
                  {mailNote && (
                    <div className="mt-2 text-[10.5px] text-[var(--t3)] leading-relaxed">{mailNote}</div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
                {([
                  ['Transaction', built.bom, 'as dropped'],
                  ['Feedback sheet', built.feedback, 'Approved Offer — values only'],
                  ['Ledger only', built.ledger, 'what the approval mail attaches'],
                  ['Working file', built.working, 'the master model, filled'],
                ] as const).map(([label, p, hint]) => p && (
                  <div key={label} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] border border-[var(--line-2)] bg-[var(--s1)]">
                    <FileSpreadsheet className="w-3.5 h-3.5 shrink-0 text-[var(--t3)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-[var(--t1)] truncate">{p.split(/[\\/]/).pop()}</div>
                      <div className="text-[10px] text-[var(--t3)]">{label} · {hint}</div>
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

          {/* What changed since the previous revision — the first thing to read
              on a revision, and the reason nobody has to open two workbooks. */}
          {result?.ok && result.diff && (
            <Card>
              <CardTitle
                title={`What changed since ${result.diff.prior}`}
                sub={`${result.diff.prior_lines} line(s) then · ${result.diff.lines} now`}
                right={<Pill tone={result.diff.added.length ? 'warn' : 'ok'}>
                  {result.diff.added.length
                    ? `${plural(result.diff.added.length, 'new item')}`
                    : 'no new items'}
                </Pill>}
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <Kpi label="Unchanged" value={result.diff.unchanged} />
                <Kpi label="Qty changed" value={result.diff.qty_changed.length}
                     hint="price carried" />
                <Kpi label="New items" value={result.diff.added.length}
                     tone={result.diff.added.length ? 'var(--warn)' : undefined}
                     hint="priced by the rule" />
                <Kpi label="Removed" value={result.diff.removed.length} />
              </div>
              <div className="space-y-1">
                {result.diff.added.map(a => (
                  <div key={`a-${a.material}`} className="flex items-center gap-2 text-[11.5px] px-2.5 py-1.5 rounded-[8px]"
                       style={{ background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }}>
                    <Plus className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--warn)' }} />
                    <b className="text-[var(--t1)]">{a.material}</b>
                    <span className="text-[var(--t2)] truncate">{a.description}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[var(--t2)]">×{a.qty.toLocaleString()}</span>
                    <span className="shrink-0 text-[10px] text-[var(--t3)]">new — priced by the rule</span>
                  </div>
                ))}
                {result.diff.qty_changed.map(c => (
                  <div key={`q-${c.material}`} className="flex items-center gap-2 text-[11.5px] px-2.5 py-1.5 rounded-[8px] border border-[var(--line-2)]">
                    <ArrowRight className="w-3.5 h-3.5 shrink-0 text-[var(--t3)]" />
                    <b className="text-[var(--t1)]">{c.material}</b>
                    <span className="text-[var(--t2)] truncate">{c.description}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[var(--t2)]">
                      {c.old_qty?.toLocaleString()} → {c.new_qty.toLocaleString()}
                    </span>
                    <span className="shrink-0 tabular-nums text-[10px]"
                          style={{ color: c.delta > 0 ? 'var(--ok)' : 'var(--err)' }}>
                      {c.delta > 0 ? '+' : ''}{c.delta.toLocaleString()}
                    </span>
                    {c.unit_net != null && (
                      <span className="shrink-0 text-[10px] text-[var(--t3)]">held at {num(c.unit_net)}</span>
                    )}
                  </div>
                ))}
                {result.diff.removed.map(r => (
                  <div key={`r-${r.material}`} className="flex items-center gap-2 text-[11.5px] px-2.5 py-1.5 rounded-[8px] border border-[var(--line-2)]">
                    <Minus className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--err)' }} />
                    <b className="text-[var(--t1)]">{r.material}</b>
                    <span className="ml-auto shrink-0 tabular-nums text-[var(--t3)]">was ×{r.qty.toLocaleString()}</span>
                    <span className="shrink-0 text-[10px] text-[var(--t3)]">dropped</span>
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
  );
}
