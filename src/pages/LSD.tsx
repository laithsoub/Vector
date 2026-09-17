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

import { Checkbox, EmptyState, Select, IconButton as UiIconButton } from '../ui';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, Field, TextInput, Button, relTime } from '../lib/ui';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { LsdLine, LsdResult, LsdCase, LsdMeta, LsdRegister, LsdPushResult,
              LsdKeepalive, LsdKeepaliveTab, LsdQueue, LsdQueueRow } from '../lib/api';
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
  half: 'auto', aprc: 'auto', ledger: 'R2321', revision: '', baseline: true,
  // These never touch the price — they are the daily register's own columns,
  // filled here because this is the only moment anyone knows them.
  bu: '', status: 'Priced', sales_name: '', cpq_updated: '', notes: '', rpi_comment: '',
  // The customer's earlier approved offer to carry from, staged by Fetch.
  history_offer: '', history_label: '',
};

// Statuses the daily sheet uses. Free text is allowed underneath, but the
// common four are one click.
const STATUSES = ['Priced', 'Pending Approval', 'Approved', 'Sent', 'On Hold'];

// ─── one KPI ─────────────────────────────────────────────────────────────────
// The bit of a work-tab URL worth showing a human: OneDrive and CPQ URLs are
// hundreds of characters of session ids, and the host is what identifies them.
function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
}

// ── CPQ session button ───────────────────────────────────────────────────────
// Fetch-from-CPQ reads tabs that are already signed in inside the debug-rail
// Edge, and those sessions expire while nobody is looking. Vector reloads them
// on a timer (automation/tab_keepalive.py) — this is the one control that shows
// it, shaped like the JOE button in the header because it means the same thing:
// one dot, one word, green when the session is good, and a click to redo it.
// The four tabs behind it are the tooltip, not the page; the only failure a
// timer cannot fix is a page asking for a password, and that turns it amber.
function CpqDot({ toast }: { toast: ToastFn }) {
  const [ka, setKa]     = useState<LsdKeepalive | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setKa(await api.lsdKeepalive()); } catch {}
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);   // the sweep itself runs server-side
    return () => clearInterval(t);
  }, [load]);

  async function sweep() {
    setBusy(true);
    try {
      const r = await api.lsdKeepaliveRun();
      setKa(r);
      if (r.needs_signin?.length) toast('warn', `Sign in once: ${r.needs_signin.map(hostOf).join(', ')}`);
      else if (r.ok) toast('ok', 'CPQ session is live — every work tab is open and signed in.');
      else toast('err', r.error || 'The CPQ session could not be refreshed.');
    } catch (e: any) { toast('err', failed('refresh the CPQ session', e)); }
    setBusy(false);
  }

  if (!ka) return null;
  const working  = busy || ka.running;
  const rows     = ka.tabs || [];
  // Every array here is read defensively. The strip is a status readout, and a
  // field missing from one payload should degrade it, not take the whole LSD tab
  // down through the error boundary — which is exactly what `ka.urls.length` did
  // when the sweep's own response turned out not to carry `urls`.
  const urls     = ka.urls || [];
  // Connected means all of it: every configured tab present, signed in, no error.
  const connected = rows.length > 0 && rows.length === urls.length
                 && rows.every(t => t.signed_in === true && !t.error);
  const needs     = (ka.needs_signin || []).length > 0;
  const label     = working ? 'Connecting…' : connected ? 'Connected'
                  : needs   ? 'Sign in to CPQ' : 'Connect to CPQ';
  const tone      = connected ? 'var(--ok)' : needs ? 'var(--warn)' : null;
  const tip = [
    connected ? 'CPQ, both OneDrive pages and the EMEA site are open and signed in.'
              : 'Click to open and refresh the tabs every LSD fetch reads.',
    ...(rows.length ? rows : urls.map(u => ({ url: u, signed_in: null, error: null } as any)))
      .map((t: LsdKeepaliveTab) =>
        `${t.error ? '✕' : t.signed_in === false ? '!' : t.signed_in ? '✓' : '·'} ${hostOf(t.url)}${t.error ? ` — ${t.error}` : ''}`),
    ka.enabled ? `Refreshed automatically every ${ka.everyMin} min.` : 'The automatic refresh is off (Settings → LSD Pricing).',
  ].join('\n');

  // A dot on the action row, not a band of its own. The whole state — which
  // pages are warm, which need signing into, when it last swept — is already in
  // the tooltip, and the strip was spending a full row to repeat two words of
  // it. Colour carries the status; the label only appears when it needs a hand.
  return (
    <button
      onClick={sweep} disabled={working} title={tip}
      aria-label={working ? 'Refreshing the CPQ session' : label}
      className={cn(
        'h-9 shrink-0 rounded-panel border flex items-center gap-1.5 transition-colors',
        needs && !working ? 'px-2.5' : 'px-2.5',
        working ? 'border-line-2 bg-raised cursor-not-allowed'
                : 'border-line-2 hover:bg-hover',
      )}
      style={tone && !working
        ? { borderColor: `color-mix(in oklab, ${tone} 32%, transparent)`,
            background: connected ? 'var(--ok-soft)' : 'var(--warn-soft)' }
        : undefined}>
      {working
        ? <Loader2 className="w-3.5 h-3.5 animate-spin text-fg-3" />
        : <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tone || 'var(--t3)' }} />}
      {/* Signed in and quiet needs no words. Anything else does. */}
      {!connected && !working && (
        <span className="text-xs font-medium whitespace-nowrap"
              style={{ color: tone || 'var(--t2)' }}>{label}</span>
      )}
    </button>
  );
}

// ── Dalia's daily sheet: what is waiting to be fetched ───────────────────────
// She adds a row to "LSD Daily work" for every transaction that needs pricing.
// The server reads the workbook every few minutes (automation/lsd_queue.py); this
// lists the rows nobody has picked up — Status not Done/Cancelled, no "Done by
// Laith" in Notes, no case folder here — each with one click to fetch it.
const QUEUE_KIND: Record<LsdQueueRow['kind'], string> = {
  fetch:     'To fetch',
  priced:    'Priced here — still open in her sheet',
  laith:     'Noted done by Laith — status still open',
  hold:      'On hold',
  no_number: 'No transaction number yet',
  no_bu:     'BU blank in her sheet — check it is Fire',
};

function ago(iso: string | null | undefined): string {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function QueueTable({ rows, onFetch, disabled, todo }: {
  rows: LsdQueueRow[]; onFetch: (w: string) => void; disabled: boolean; todo?: boolean;
}) {
  const th = 'px-2 py-1 font-medium whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-2xs uppercase tracking-wide text-fg-3 text-left">
            <th className={th}>Transaction</th><th className={th}>Project · customer</th>
            <th className={th}>Country · BU</th><th className={th}>Sales</th>
            <th className={th} title="Days since CPQ Last Updated">Age</th>
            <th className={cn(th, 'text-right')}>Value</th>
            <th className={th}>{todo ? 'Status · notes' : 'Why it is here'}</th><th className={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const fresh = !!r.first_seen && Date.now() - new Date(r.first_seen).getTime() < 864e5;
            return (
              <tr key={`${r.transaction}-${r.row}`} className="border-t border-line-2">
                <td className="px-2 py-1.5 whitespace-nowrap font-medium text-fg tabular-nums">
                  {r.transaction || r.raw_transaction || '—'}
                  {fresh && (
                    <span className="ml-1.5 text-2xs font-semibold px-1 rounded"
                          style={{ color: 'var(--ok)', background: 'var(--ok-soft)' }}>NEW</span>
                  )}
                </td>
                <td className="px-2 py-1.5 max-w-72 truncate text-fg-2"
                    title={`${r.name} — ${r.customer_name} (${r.customer})`}>
                  {r.name}<span className="text-fg-3"> · {r.customer_name}</span>
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-fg-2">
                  {[r.country, r.bu].filter(Boolean).join(' · ')}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-fg-2">{r.sales}</td>
                <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-fg-3"
                    title={r.cpq_updated || ''}>
                  {r.age_days == null ? '—' : r.age_days <= 0 ? 'today' : `${r.age_days} d`}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-right mono text-fg-2">
                  {typeof r.value === 'number'
                    ? r.value.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    : r.value || '—'}
                </td>
                <td className="px-2 py-1.5 max-w-60 truncate text-fg-3"
                    title={[r.status, r.notes].filter(Boolean).join(' — ')}>
                  {todo ? [r.status, r.notes].filter(Boolean).join(' · ') : QUEUE_KIND[r.kind]}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  {r.transaction && (
                    <button
                      onClick={() => onFetch(r.transaction)} disabled={disabled}
                      className={cn(
                        'inline-flex items-center gap-1 h-6 px-2 rounded-md border text-xs font-medium transition-colors',
                        disabled ? 'border-line-2 text-fg-3 cursor-not-allowed'
                                 : 'border-line-2 text-fg hover:bg-hover',
                      )}>
                      <CloudDownload className="w-3 h-3" />
                      {r.kind === 'fetch' ? 'Fetch' : 'Fetch anyway'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueuePanel({ toast, onFetch, disabled }: {
  toast: ToastFn; onFetch: (w: string) => void; disabled: boolean;
}) {
  const [q, setQ]               = useState<LsdQueue | null>(null);
  const [busy, setBusy]         = useState(false);
  const [open, setOpen]         = useState(true);
  const [showOther, setShowOther] = useState(false);
  // The to-fetch numbers already shown, so a row Dalia adds while the tab is
  // open gets a toast instead of appearing silently in a list nobody is watching.
  const known = useRef<Set<string> | null>(null);

  const take = useCallback((r: LsdQueue) => {
    setQ(r);
    if (!r.ok) return;
    const now = new Set((r.rows || []).filter(x => x.kind === 'fetch').map(x => x.transaction));
    if (known.current) {
      const fresh = [...now].filter(w => !known.current!.has(w));
      if (fresh.length) toast('ok', `New in Dalia's sheet: ${fresh.join(', ')}`);
    }
    known.current = now;
  }, [toast]);

  useEffect(() => {
    const load = async () => { try { take(await api.lsdQueue()); } catch {} };
    load();
    const t = setInterval(load, 60_000);   // the read itself runs server-side
    return () => clearInterval(t);
  }, [take]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.lsdQueueRefresh();
      take(r);
      if (!r.ok) toast('err', r.error || "Could not read Dalia's sheet.");
    } catch (e) { toast('err', failed("read Dalia's daily sheet", e)); }
    setBusy(false);
  };

  if (!q) return null;
  const rows    = q.rows || [];
  const todo    = rows.filter(r => r.kind === 'fetch');
  const other   = rows.filter(r => r.kind !== 'fetch');
  const working = busy || q.running;

  return (
    <Card className="order-1">
      <div className="flex items-center gap-2 min-w-0">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 min-w-0 text-left">
          <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
          <ClipboardList className="w-4 h-4 shrink-0 text-fg-2" />
          <span className="text-sm font-semibold text-fg truncate"
                title={q.bu_filter?.length
                  ? `Only BU ${q.bu_filter.join(', ')} — ${q.other_bu ?? 0} open row(s) in other BUs are not listed`
                  : 'Every BU'}>
            {q.bu_filter?.length ? `${q.bu_filter.map(b => b[0] + b.slice(1).toLowerCase()).join(' / ')} waiting` : 'Waiting'} in Dalia's sheet
          </span>
        </button>
        <span className="text-xs tabular-nums px-1.5 py-px rounded-md shrink-0"
              style={todo.length ? { color: 'var(--accent)', background: 'var(--s3)' } : { color: 'var(--t3)' }}>
          {q.ran == null && q.ok == null ? 'not read yet' : todo.length ? `${todo.length} to fetch` : 'nothing new'}
        </span>
        <span className="ml-auto min-w-0 text-2xs text-fg-3 truncate"
              title={[q.file?.name, q.file?.modified && `saved ${q.file.modified}`, q.error].filter(Boolean).join('\n')}>
          {q.ok === false
            ? <span style={{ color: 'var(--err)' }}>{q.error}</span>
            : `Read ${ago(q.ran)}`}
          {q.enabled ? ` · every ${q.everyMin} min` : ' · auto-read off'}
        </span>
        <UiIconButton icon={RefreshCw} label="Read the sheet now" className="shrink-0" onClick={refresh} disabled={working} />
      </div>

      {open && q.ran != null && (
        <div className="mt-2.5 flex flex-col gap-2">
          {todo.length > 0
            ? <QueueTable rows={todo} onFetch={onFetch} disabled={disabled} todo />
            : <p className="text-xs text-fg-3">Nothing to pick up — every open row is priced here, on hold, or has no number.</p>}
          {other.length > 0 && (
            <>
              <button onClick={() => setShowOther(s => !s)}
                      className="self-start flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                <ChevronRight className={cn('w-3 h-3 transition-transform', showOther && 'rotate-90')} />
                {plural(other.length, 'other open row')} — priced here, on hold, no number or no BU
              </button>
              {showOther && <QueueTable rows={other} onFetch={onFetch} disabled={disabled} />}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Kpi({ label, value, tone, hint }: {
  label: string; value: React.ReactNode; tone?: string; hint?: string;
}) {
  // A toned figure carries its state in a leading rule as well as the digits,
  // so it still reads on a bright screen without a tinted box around it.
  return (
    <div className="pl-3 py-1 border-l-2" style={{ borderColor: tone || 'var(--line-2)' }}>
      <div className="eyebrow">{label}</div>
      <div className="mono text-2xl font-medium leading-tight mt-1" style={{ color: tone || 'var(--t1)' }}>{value}</div>
      {hint && <div className="text-xs text-fg-3 mt-0.5 leading-snug">{hint}</div>}
    </div>
  );
}

// ─── the review table ────────────────────────────────────────────────────────
// Every column an approver asked for in the Working sheet, in the order they
// read them: what the customer asked, what the guardrails say, what won.
function LineTable({ lines, cur }: { lines: LsdLine[]; cur: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const H = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={cn('px-2 py-2 font-semibold text-2xs uppercase tracking-wider text-fg-2 whitespace-nowrap',
      right ? 'text-right' : 'text-left')}>{children}</th>
  );
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b-2 border-line-3 bg-subtle">
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
                  className="border-b border-line-2 cursor-pointer hover:bg-hover align-top"
                  style={{
                    background: isOpen ? 'var(--s3)' : s.bg,
                    boxShadow: `inset var(--focus-w) 0 0 0 ${s.bar}`,
                  }}
                >
                  <td className="px-2 py-2 max-w-60">
                    <div className="flex items-start gap-1.5">
                      <ChevronRight className={cn('w-3 h-3 mt-0.5 shrink-0 transition-transform text-fg-3',
                        isOpen && 'rotate-90')} />
                      <div className="min-w-0">
                        <div className="font-medium text-fg truncate">{l.material}</div>
                        <div className="text-2xs text-fg-2 truncate">{l.description || '—'}</div>
                        <div className="text-2xs text-fg-3 truncate">{l.group || 'no pricing group'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right mono">{l.qty.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right mono text-fg-2">{num(l.unit_std)}</td>
                  <td className="px-2 py-2 text-right mono text-fg-2">
                    {num(l.requested)}
                    <div className="text-2xs text-fg-3">{pct(l.req_disc)}</div>
                  </td>
                  <td className="px-2 py-2 text-right mono text-fg-2">{pct(l.disc_at_target)}</td>
                  <td className="px-2 py-2 text-right mono text-fg-3">20.0%</td>
                  <td className="px-2 py-2 text-right mono font-medium text-fg">{pct(l.add_disc)}</td>
                  <td className="px-2 py-2 text-right mono font-semibold text-fg">{num(l.unit_net)}</td>
                  <td className="px-2 py-2 text-right mono">{money(l.total_net, cur)}</td>
                  <td className="px-2 py-2 text-right mono"
                      style={{ color: l.target_e2e && l.e2e !== null && l.e2e < l.target_e2e ? 'var(--err)' : 'var(--t2)' }}>
                    {pct(l.e2e)}
                    <div className="text-2xs text-fg-3">tgt {pct(l.target_e2e, 0)}</div>
                  </td>
                  <td className="px-2 py-2 text-right mono text-fg-2">{pct(l.rpi_after)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="text-2xs font-medium px-1.5 py-0.5 rounded border"
                          style={{ color: s.color,
                                   borderColor: 'color-mix(in srgb, currentColor 35%, transparent)',
                                   background: 'color-mix(in srgb, currentColor 14%, transparent)' }}>
                      {l.binds}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-line-2 bg-subtle">
                    <td colSpan={12} className="px-4 py-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
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
                            <div className="text-2xs uppercase tracking-wider text-fg-3">{k}</div>
                            <div className="tabular-nums text-fg">{v}</div>
                          </div>
                        ))}
                      </div>
                      {l.flags && (
                        <div className="mt-3 pt-3 border-t border-line-2 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: s.color }} />
                          <div className="text-xs text-fg-2 leading-relaxed">{l.flags}</div>
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

// ─── one run, one progress line ──────────────────────────────────────────────
// Fetching, pricing and building used to be three separate spinners with their
// own notes underneath. They are one job to the person doing it, so they share
// one bar. The step names say where the run is, not how it is done — what Excel
// or the browser rail are up to underneath is not the analyst's problem.
//
// There is no real percentage to report: the engine returns once, at the end. So
// each step eases towards its own share of the bar on a curve that never quite
// arrives (1 - e^-t/τ) and snaps forward when the step actually finishes. It
// keeps moving during a slow step without ever claiming to be done early.
type RunStep = 'fetch' | 'price' | 'build' | 'upload';

// What the single button says and does in each state.
const ACTION = {
  fetch:   { label: 'Fetch',            Icon: CloudDownload, tone: 'primary' as const },
  price:   { label: 'Price it',         Icon: Play,          tone: 'primary' as const },
  build:   { label: 'Create case folder', Icon: Hammer,      tone: 'dark' as const },
  rebuild: { label: 'Rebuild',          Icon: RefreshCw,     tone: 'outline' as const },
  upload:  { label: 'File it',          Icon: CloudUpload,   tone: 'dark' as const },
};

const RUN_STEP: Record<RunStep, { label: string; secs: number }> = {
  fetch:  { label: 'Getting the transaction', secs: 10 },
  price:  { label: 'Pricing',                 secs: 22 },
  build:  { label: 'Writing the case',        secs: 16 },
  upload: { label: 'Filing to SharePoint',    secs: 12 },
};

function useRunProgress() {
  const [run, setRun] = useState<{ steps: RunStep[]; idx: number; pct: number; secs: number } | null>(null);
  const started = useRef(0);
  const base    = useRef(0);

  const begin = (steps: RunStep[]) => {
    started.current = Date.now();
    base.current = 0;
    setRun({ steps, idx: 0, pct: 0, secs: 0 });
  };
  // Called as each step lands, so the bar jumps to that step's true boundary
  // rather than drifting on the curve alone.
  const next = () => setRun(r => {
    if (!r) return r;
    const total = r.steps.reduce((s, k) => s + RUN_STEP[k].secs, 0);
    base.current = r.steps.slice(0, r.idx + 1).reduce((s, k) => s + RUN_STEP[k].secs, 0) / total;
    started.current = Date.now();
    return { ...r, idx: r.idx + 1, pct: Math.round(base.current * 100), secs: 0 };
  });
  const end = () => setRun(r => (r ? { ...r, idx: r.steps.length, pct: 100 } : r));
  const clear = () => setRun(null);

  useEffect(() => {
    if (!run || run.idx >= run.steps.length) return;
    const total = run.steps.reduce((s, k) => s + RUN_STEP[k].secs, 0);
    const share = RUN_STEP[run.steps[run.idx]].secs / total;
    const tick = setInterval(() => {
      const t = (Date.now() - started.current) / 1000;
      const within = 1 - Math.exp(-t / RUN_STEP[run.steps[run.idx!]].secs);
      setRun(r => (r ? { ...r,
        pct: Math.min(99, Math.round((base.current + share * within) * 100)),
        secs: Math.floor(t) } : r));
    }, 120);
    return () => clearInterval(tick);
  }, [run?.idx, run?.steps]);

  return { run, begin, next, end, clear };
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
  const progress = useRunProgress();
  // One button, whose job is whatever the run needs next. Four buttons meant
  // three of them were disabled at any moment and the eye still had to check
  // which; this way the only control on the row is the one that does something.
  //   nothing staged, a number typed  → fetch it
  //   an export staged, not yet priced → price it
  //   priced and not yet built         → write the case
  //   nothing staged, a case on file   → rebuild it
  // A priced result only earns the "build next" step while it still matches
  // what is on screen. Change the customer number, the ledger or the staged
  // export and the button falls back to Price it, rather than offering to write
  // a case folder from numbers that are no longer the ones in the form.
  const sigNow = JSON.stringify([meta, file?.path ?? '']);
  const pricedSig = useRef('');
  const priceFresh = !!result?.ok && !result.cancelled && pricedSig.current === sigNow;

  const action: RunStep | 'rebuild' =
      file   ? (priceFresh && !built ? 'build' : 'price')
    : cpqNum.trim() ? 'fetch'
    : (built?.ok || meta.transaction.trim()) ? 'rebuild'
    : 'fetch';
  const runningNow = !!busy || !!(progress.run && progress.run.idx < progress.run.steps.length);
  const canRun =
      action === 'fetch' ? !!cpqNum.trim()
    : !!status?.master && (action !== 'price' || !!file);
  const advance = () => {
    if (action === 'fetch')   return void fetchCpq();
    if (action === 'price')   return void price();
    if (action === 'rebuild') return void build(true);
    return void build(false);
  };
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
      // A staged history offer belongs to the fetched deal, never to an upload.
      setMeta(m => ({ ...m, history_offer: '', history_label: '' }));
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
  // `num` lets the daily-sheet queue hand a transaction straight in; the typed
  // field is only read when nothing was handed over.
  const fetchCpq = async (num?: string) => {
    const w = (num ?? cpqNum).trim();
    if (!w) return;
    setCpqBusy(true); setCpqNote(''); setRevNote(''); setResult(null); setBuilt(null);
    progress.begin(['fetch']);
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
      // A re-upload under a new number: the server searched the customer's own
      // history and staged the best-matching approved offer for the build to carry.
      const hist = r.history;
      const pick = hist?.ok ? hist.pick : null;
      setMeta(m => ({ ...m, history_offer: pick?.offer || '', history_label: pick?.label || '' }));
      if (rv?.ok && (rv.latest || 0) > 0) {
        setMeta(m => ({ ...m, revision: rv.next || m.revision }));
        setRevNote(`Priced before — R${rv.latest} is the newest on file, so this is ${rv.next}.`
                   + (rv.pulled ? ` Pulled ${rv.pulled.name} to diff against.`
                                : ' No approved file found to carry prices from.'));
      } else if (pick) {
        setRevNote(`New number, old deal: ${pick.transaction} (${pick.name || 'no name'}, `
                   + `${pick.cpq_updated || 'undated'}) has an approved offer pricing ${pick.matched ?? '?'} `
                   + `of these materials${pick.overlap != null ? ` (${Math.round(pick.overlap * 100)}%)` : ''} — `
                   + `its prices will be carried.`
                   + (pick.check?.header_total && !pick.check.match
                      ? ' Its total does not add up to its lines — check it before trusting the carry.' : ''));
      } else if (rv?.ok) {
        const n = hist?.ok ? (hist.candidates || []).length : 0;
        setRevNote(n
          ? `Nothing on file for this transaction. The customer has ${n} earlier deal(s), none pricing 60% of these materials — first version.`
          : 'Nothing on file for this transaction — first version.'
          + (hist && !hist.ok ? ` Customer history not checked: ${hist.error}` : ''));
      } else if (rv?.error) {
        setRevNote(`Could not check for earlier revisions: ${rv.error}`);
      }
      // CPQ's header customer is the sold-to; some deals price a different
      // account, so make the auto-filled number visible, not silent.
      setCpqNote(`Fetched ${r.lines ?? ''} line(s). Customer ${h.customer || '?'} — CPQ's own; change it if you price a different account.`);
      toast('ok', `Pulled ${w} from CPQ.`);
    } catch (e) { setCpqNote(failed('reach CPQ', e)); toast('err', failed('reach CPQ', e)); }
    finally { setCpqBusy(false); progress.end(); setTimeout(progress.clear, 900); }
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
    progress.begin(['price']);
    try {
      const r = await api.lsdPreview({ ...meta, file: file.path, job_id: run.id }, run.ctl.signal);
      setResult(r);
      if (r.ok && !r.cancelled) pricedSig.current = JSON.stringify([meta, file.path]);
      if (r.cancelled) toast('warn', 'Cancelled.');
      else if (!r.ok) toast('err', r.error || 'Pricing failed.');
      else toast('ok', `${plural(r.summary?.lines || 0, 'line')} priced.`);
    } catch (e) { toast('err', failed('price the transaction', e)); }
    finally {
      setBusy(''); setCancelling(false); runRef.current = null;
      progress.end(); setTimeout(progress.clear, 900);
    }
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
    progress.begin(['build']);
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
    finally {
      setBusy(''); setCancelling(false); runRef.current = null;
      progress.end(); setTimeout(progress.clear, 900);
    }
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
  // The single line behind the RPI, when there is one. Below 40% of the total no
  // line is "the reason" and naming one would be misleading.
  const rpiDriver = useMemo(
    () => (s?.rpi_drivers || []).find(d => (d.share || 0) > 0.4),
    [s],
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
    <div className="flex flex-col gap-5">
      {/* master model missing — nothing works without it, so say so first */}
      {status && !status.master && (
        <Card className="border-err-line bg-err-soft">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--err)' }} />
            <div className="text-sm text-fg-2 leading-relaxed">
              <b className="text-fg">No master CPQ model.</b> Put the
              {' '}<code className="text-xs">CPQ Pricing Model LSD … V2</code>{' '}
              <code className="text-xs">.xlsb</code> in
              {' '}<code className="text-xs">{status.masterDir}</code>, or set its full path in
              Settings → LSD Pricing. Prices, costs, E2E targets and prior-year averages all come
              from it.
            </div>
          </div>
        </Card>
      )}

      {/* ── one row: what to price, and the one button that moves it on ──
          The transaction number and the dropped export were two controls doing
          the same job — naming the deal — so they are one field: type the
          number, or drop the export onto it. The button is whatever the run
          needs next, in one place, rather than four that are mostly disabled. */}
      {/* What Dalia has added and nobody has picked up. Fetching one starts a
          clean run, so whatever was staged before is cleared first. */}
      <QueuePanel
        toast={toast} disabled={runningNow || cpqBusy}
        onFetch={w => { reset(); setCpqNum(w); void fetchCpq(w); }} />

      <Card className="order-1">
        <div
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className="flex items-center gap-2 min-w-0"
        >
          <input
            ref={inputRef} type="file" accept=".csv,.xlsx,.xlsb" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) take(f); }}
          />

          <div className={cn(
            'relative flex-1 min-w-0 h-9 rounded-panel border flex items-center transition-colors',
            drag  ? 'border-accent bg-subtle border-dashed'
                  : 'border-line-2 bg-surface focus-within:border-accent-line',
          )}>
            {file ? (
              /* A staged export owns the field: its name IS what will be priced. */
              <>
                {busy === 'upload'
                  ? <Loader2 className="w-4 h-4 animate-spin text-fg-3 shrink-0 ml-2.5" />
                  : <FileSpreadsheet className="w-4 h-4 shrink-0 ml-2.5" style={{ color: 'var(--ok)' }} />}
                <span className="text-sm text-fg truncate ml-2">{file.name}</span>
                <UiIconButton icon={X} label="Clear" className="ml-auto mr-1.5 shrink-0" onClick={reset} />
              </>
            ) : (
              <>
                <Search className="w-3.5 h-3.5 absolute left-2.5 text-fg-3 pointer-events-none" />
                <input
                  value={cpqNum}
                  onChange={e => setCpqNum(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !runningNow && canRun) advance(); }}
                  placeholder="Transaction #, or drop the export here"
                  className="w-full h-full pl-8 pr-2.5 bg-transparent rounded-panel text-sm text-fg focus:outline-none" />
                <UiIconButton icon={Upload} label="Choose a file" className="mr-1.5 shrink-0" onClick={() => inputRef.current?.click()} />
              </>
            )}
          </div>

          {runningNow ? (
            // Mid-run the only useful control is the one that stops it. Cancel
            // asks the engine to unwind so Excel closes with it — a killed
            // process would leave Excel holding the master open.
            <Button tone="outline" Icon={cancelling ? Loader2 : X}
                    disabled={cancelling || !busy} onClick={cancelRun}>
              {cancelling ? 'Stopping…'
                : busy === 'build' ? 'Cancel the build'
                : busy === 'preview' ? 'Cancel pricing'
                // A fetch is a browser round trip with nothing to unwind, so the
                // button is inert here and must not name a step that is not running.
                : 'Cancel'}
            </Button>
          ) : (
            <Button tone={ACTION[action].tone} Icon={ACTION[action].Icon}
                    disabled={!canRun} onClick={advance}>
              {ACTION[action].label}
            </Button>
          )}

          <CpqDot toast={toast} />
        </div>

        {/* Both notes on one muted line — they are the same kind of aside. */}
        {(cpqNote || revNote) && !runningNow && (
          <p className="text-2xs text-fg-3 mt-2 leading-relaxed flex items-start gap-1.5">
            <Info className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              {[cpqNote, revNote].filter(Boolean).join('  ·  ')}
              {meta.history_offer && (
                <button type="button"
                        className="ml-1.5 underline text-accent hover:opacity-80"
                        onClick={() => {
                          setMeta(m => ({ ...m, history_offer: '', history_label: '' }));
                          setRevNote(n => `${n} Carry switched off — priced from scratch.`);
                        }}>
                  Don't carry
                </button>
              )}
            </span>
          </p>
        )}

        {/* One line for the whole run. No step-by-step commentary — where it is
            and how far along, and that is all. */}
        {progress.run && (
          <div className="mt-2.5">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-xs font-medium text-fg">
                {progress.run.idx >= progress.run.steps.length
                  ? 'Done'
                  : RUN_STEP[progress.run.steps[progress.run.idx]].label}
              </span>
              <span className="ml-auto text-2xs tabular-nums text-fg-3">
                {(() => {
                  const st = progress.run.steps[progress.run.idx];
                  const slow = st && progress.run.secs > RUN_STEP[st].secs * 1.5;
                  const m = Math.floor(progress.run.secs / 60), sec = progress.run.secs % 60;
                  return slow
                    ? `${m ? `${m}m ` : ''}${sec}s · ${progress.run.pct}%`
                    : `${progress.run.pct}%`;
                })()}
              </span>
            </div>
            <div className="h-0.5 rounded-full bg-subtle overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration ease-out"
                style={{
                  width: `${progress.run.pct}%`,
                  background: progress.run.pct >= 100 ? 'var(--ok)' : 'var(--accent)',
                }} />
            </div>
          </div>
        )}

        {/* who the deal is for: one readable line, expandable to the real form */}
        <div className="mt-3 pt-3 border-t border-line-2">
          <button type="button" onClick={() => setEditHdr(v => !v)}
                  className="w-full flex items-center gap-2 text-left">
            <span className="text-2xs uppercase tracking-wider font-semibold text-fg-2 shrink-0">
              Deal header
            </span>
            <span className="text-xs text-fg truncate">
              {[meta.transaction, meta.customer && `#${meta.customer}`, meta.customer_name,
                meta.country, meta.project].filter(Boolean).join(' · ') || 'Nothing filled in yet'}
            </span>
            <span className="ml-auto shrink-0 flex items-center gap-2">
              <span className="text-2xs text-fg-3 whitespace-nowrap">
                {meta.half === 'auto' ? 'half auto' : meta.half} · APRC {meta.aprc} · {meta.ledger}
              </span>
              <ChevronRight className={cn('w-3.5 h-3.5 text-fg-3 transition-transform',
                                          headerOpen && 'rotate-90')} />
            </span>
          </button>
        </div>

        {headerOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-2xs text-fg-3">
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
                <Select value={meta.half} onChange={v => set('half')(v ?? 'auto')}
                  data={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'H1',   label: 'H1 · 3.5%' },
                    { value: 'H2',   label: 'H2 · 6%' },
                  ]} />
              </Field>
              <Field label="APRC">
                <Select value={meta.aprc} onChange={v => set('aprc')(v ?? 'auto')}
                  data={[
                    { value: 'auto',    label: 'Auto' },
                    { value: '525',     label: '525 · EUR' },
                    { value: '530-535', label: '530-535 · USD' },
                  ]} />
              </Field>
              <Field label="Ledger">
                <TextInput value={meta.ledger} onChange={e => set('ledger')(e.target.value)} />
              </Field>
              <Field label="Revision"
                     hint="R1, R2, R3 … Blank = first version.">
                <TextInput value={meta.revision || ''} onChange={e => set('revision')(e.target.value)}
                           placeholder="R4" />
              </Field>
              <Checkbox
                className="col-span-2 pt-1"
                size="xs"
                checked={!!meta.baseline}
                onChange={e => setMeta(m => ({ ...m, baseline: e.currentTarget.checked }))}
                label={
                  <span className="text-2xs text-fg-3 leading-relaxed">
                    <span className="text-fg-2 font-medium">Keep the first draft ("as pasted")</span> —
                    a second Working File beside the final one, holding the master with nothing but
                    the transaction in it: every column still its own formula, no discount decided,
                    nothing corrected. Open it when a number looks wrong — what it shows is the
                    model's, what differs in the final one is Vector's.
                  </span>
                }
              />
              <p className="text-2xs text-fg-3 leading-relaxed self-end pb-1.5 col-span-2">
                Auto reads the half-year from the export's date and the APRC from the
                pricing-group mix — FIRE in USD, EL in EUR. A revision writes into the same
                case folder with its prefix, and every line the previous revision already
                carried keeps the price the customer was quoted.
              </p>
            </div>

            {/* The register's own columns. None of them touch a price — they are
                what the daily sheet asks for beside the numbers, and this is the
                only screen where anyone knows them. */}
            <div className="mt-4 pt-3 border-t border-line-2 space-y-3">
              <button type="button" onClick={() => setShowReg(v => !v)}
                      className="w-full flex items-center gap-2 text-left group">
                <ClipboardList className="w-3.5 h-3.5 text-fg-2" />
                <span className="text-2xs uppercase tracking-wider font-semibold text-fg-2">
                  Daily register
                </span>
                <span className="text-2xs text-fg-3 truncate">
                  {meta.bu || 'auto'} · {meta.status || 'Priced'}
                  {meta.sales_name ? ` · ${meta.sales_name}` : ''}
                </span>
                <ChevronRight className={cn('w-3.5 h-3.5 ml-auto shrink-0 text-fg-3 transition-transform',
                                            showReg && 'rotate-90')} />
              </button>
              {!showReg && (
                <p className="text-2xs text-fg-3 leading-relaxed">
                  CPQ fills these. Open only to correct one — building the case writes the row either way.
                </p>
              )}
              {showReg && <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <Field label="BU">
                  {/* Blank means "let the engine decide", which is a cleared
                      field, not a value — hence clearable + placeholder. */}
                  <Select clearable placeholder="Auto"
                    value={meta.bu || null} onChange={v => set('bu')(v ?? '')}
                    data={['EL', 'FIRE', 'CBS']} />
                </Field>
                <Field label="Status">
                  <Select data={STATUSES}
                    value={meta.status || 'Priced'} onChange={v => set('status')(v ?? 'Priced')} />
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
              <p className="text-2xs text-fg-3 leading-relaxed">
                Creating the case folder also writes one row into
                {' '}<b className="text-fg-2">{reg?.name || 'the daily register'}</b>. Building the
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
                <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-fg-3 transition-transform',
                                            showCases && 'rotate-90')} />
                <span className="text-sm font-semibold text-fg shrink-0">Case folders</span>
                <span className="text-2xs text-fg-3 truncate">
                  {cases.length ? `${plural(cases.length, 'case')} · ${status?.casesRoot || ''}` : status?.casesRoot}
                </span>
              </button>
              <Button tone="ghost" size="sm" Icon={RefreshCw} onClick={loadCases} />
            </div>
            {showCases && (cases.length === 0 ? (
              <p className="text-xs text-fg-3 mt-2">Nothing here yet.</p>
            ) : (
              <div className="space-y-1 max-h-72 overflow-y-auto vec-scroll -mx-1 px-1 mt-2">
                {cases.map(c => (
                  <button key={c.path} onClick={() => reveal(c.path)}
                    className="w-full text-left px-2.5 py-2 rounded-panel hover:bg-hover transition-colors group">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 shrink-0 text-fg-3 group-hover:text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-fg truncate">{c.name}</div>
                        <div className="text-2xs text-fg-3">
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
                <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-fg-3 transition-transform',
                                            showRegCard && 'rotate-90')} />
                <span className="text-sm font-semibold text-fg shrink-0">Daily register</span>
                <span className="text-2xs text-fg-3 truncate">
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
              <p className="text-xs mb-2" style={{ color: 'var(--err)' }}>{reg.error}</p>
            )}
            {reg?.rows && reg.rows.length > 0 && (
              <div className="overflow-x-auto -mx-1 px-1 mb-3">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line-2 text-2xs uppercase tracking-wider text-fg-3">
                      <th className="text-left py-1.5 pr-2 font-semibold">Transaction</th>
                      <th className="text-left py-1.5 pr-2 font-semibold">Status</th>
                      <th className="text-right py-1.5 pr-2 font-semibold">Total</th>
                      <th className="text-right py-1.5 font-semibold">Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...reg.rows].reverse().slice(0, 8).map(r => (
                      <tr key={r._row} className="border-b border-line-2">
                        <td className="py-1.5 pr-2 max-w-36">
                          <div className="text-fg truncate">{r.transaction || '—'}</div>
                          <div className="text-2xs text-fg-3 truncate">{r.transaction_name || ''}</div>
                        </td>
                        <td className="py-1.5 pr-2 text-fg-2 whitespace-nowrap">{r.status || '—'}</td>
                        <td className="py-1.5 pr-2 text-right mono text-fg-2 whitespace-nowrap">
                          {typeof r.total_value === 'number'
                            ? r.total_value.toLocaleString(undefined, { maximumFractionDigits: 0 })
                            : '—'}
                        </td>
                        <td className="py-1.5 text-right text-2xs text-fg-3 whitespace-nowrap">{r.out_date || '—'}</td>
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
                     className="shrink-0 p-1.5 rounded-md hover:bg-hover text-fg-3 hover:text-accent"
                     title="Download the register">
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </>
              )}
            </div>

            {!reg?.connected && (
              <p className="text-2xs text-fg-3 mt-2 leading-relaxed">
                Not connected to SharePoint — run Connect to JOE and the upload button lights up.
              </p>
            )}
            <p className="text-2xs text-fg-3 mt-2 leading-relaxed">
              The workbook stays on this machine. Upload posts each transaction as an item in
              {' '}<b className="text-fg-3">{reg?.sp?.list || 'Quotations List'}</b> — the same
              list the quotes go to — as {reg?.sp?.requestType || 'Standard CTO'}. A transaction
              already in the list is updated, not duplicated.
            </p>
            {pushed && (
              <div className="mt-2 rounded-panel border border-line-2 bg-surface p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs text-fg-2">
                    {pushed.added || 0} added · {pushed.updated || 0} updated
                    {pushed.skipped ? ` · ${pushed.skipped} skipped` : ''}
                    {pushed.failed ? ` · ${pushed.failed} failed` : ''}
                  </span>
                  {pushed.site && (
                    <button onClick={() => void openExternal(pushed.site!)}
                      className="inline-flex items-center gap-1 text-2xs text-accent hover:underline">
                      <ExternalLink className="w-3 h-3" />Open the list
                    </button>
                  )}
                </div>
                {/* Only the rows that did not land — a clean run says nothing. */}
                {(pushed.results || []).filter(x => x.action === 'skipped' || x.action === 'failed')
                  .slice(0, 6).map(x => (
                    <div key={x.transaction} className="text-2xs text-fg-3 leading-relaxed">
                      <b className="text-fg-2">{x.transaction || '—'}</b>: {x.reason}
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
            <div className="rounded-panel border border-dashed border-line-2">
              <EmptyState icon={Tags} title="Drop a transaction and press Price it."
                description={<>
                  Every line takes the <b className="text-fg-2 font-medium">requested discount as asked</b>, then lifts to the
                  prior-year average × the half-year RPI gate if it prices under it. A margin
                  below its target E2E is flagged for approval, never priced away. Nothing is rounded.
                </>} />
            </div>
          )}

          {result && !result.ok && (
            <Card className="border-err-line bg-err-soft">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--err)' }} />
                <div className="text-sm text-fg-2 leading-relaxed">{result.error}</div>
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
                <div className="mb-3 px-3 py-2.5 rounded-panel border border-line-2 bg-subtle
                                text-sm text-fg leading-relaxed">
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
                {/* A double-digit RPI is what the approver challenges first, and
                    the total alone does not answer it — name the line it came
                    from when one line dominates. */}
                <Kpi label="Total RPI" value={pct(s.total_rpi)}
                     tone={s.rpi_rate !== undefined && s.total_rpi !== null && s.total_rpi < s.rpi_rate
                             ? 'var(--warn)' : 'var(--ok)'}
                     hint={[
                             // Dalia works a normal case to ~6.8% so her yearly 6%
                             // average survives Kiran's exceptions — show the gap.
                             s.rpi_working_level != null && s.total_rpi !== null
                               ? `${s.total_rpi >= s.rpi_working_level ? '+' : ''}`
                                 + `${((s.total_rpi - s.rpi_working_level) * 100).toFixed(1)} pts vs `
                                 + `${pct(s.rpi_working_level, 1)} working level`
                               : null,
                             rpiDriver ? `${pct(rpiDriver.share, 0)} ${rpiDriver.material}` : null,
                           ].filter(Boolean).join(' · ') || 'price + mix variance'} />
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

              {/* The rate this case was priced on, when it is not the half-year's.
                  It is the first thing an approver queries, so it sits above the
                  table rather than inside a line's flags. */}
              {s.rpi_exception && (
                <div className="mt-3 flex items-start gap-2 rounded-panel border border-warn
                                bg-[var(--warn)]/[0.07] px-3 py-2.5 text-xs text-fg leading-relaxed">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
                  <span>
                    <b>{s.rpi_exception.label}</b> — priced on last year's price{' '}
                    <b>+ {pct(s.rpi_exception.rate, 1)}</b>, not the {s.half}{' '}
                    {pct(s.rpi_exception.standard, 1)}: {s.rpi_exception.why}.{' '}
                    The rate itself still needs approving.
                  </span>
                </div>
              )}

              {s.no_py > 0 && (
                <div className="mt-3 flex items-start gap-2 text-xs text-fg-3 leading-relaxed">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {plural(s.no_py, 'line')} have no prior-year reference — new items, so there is
                    no RPI floor to hold them. Those are the lines where a negotiated discount
                    usually goes in by hand.
                  </span>
                </div>
              )}

              {showLog && result?.log && (
                <div className="mt-3 rounded-panel border border-line-2 bg-surface p-3 max-h-60 overflow-y-auto vec-scroll mono text-2xs leading-relaxed">
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
                <div className="flex items-center gap-2 mb-3 text-xs">
                  {built.checks.agree
                    ? <><CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--ok)' }} />
                        <span className="text-fg-2">
                          Three-way total check passed — ledger, Feedback sheet and engine all read {money(built.checks.python, cur)}.
                        </span></>
                    : <><AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warn)' }} />
                        <span className="text-fg-2">
                          Totals disagree — ledger {money(built.checks.ledger_T11, cur)}, Feedback {money(built.checks.feedback_L10, cur)}, engine {money(built.checks.python, cur)}.
                        </span></>}
                </div>
              )}
              {built.register && (
                <div className="flex items-center gap-2 mb-3 text-xs">
                  {built.register.ok
                    ? <><ClipboardList className="w-3.5 h-3.5" style={{ color: 'var(--ok)' }} />
                        <span className="text-fg-2">
                          Register row {built.register.action === 'updated' ? 'updated' : 'added'} in{' '}
                          {built.register.path.split(/[\/]/).pop()}
                          {built.register.skipped.length > 0
                            && ` · ${plural(built.register.skipped.length, 'column')} not in that sheet`}
                        </span></>
                    : <><AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--warn)' }} />
                        <span className="text-fg-2">
                          Not registered — {built.register.error}. Press <b>Register this one</b> to retry.
                        </span></>}
                </div>
              )}
              {/* The approval ask. Two ways in: a line still priced under its
                  target E2E (that margin is somebody's decision), or a line the
                  target floor lifted off the customer's own ask (that COUNTER is
                  somebody's decision, and the concession band is what they grant). */}
              {!!(built.summary?.below_target || built.summary?.floored) && (
                <div className="mb-3 p-3 rounded-panel border border-line-2"
                     style={{ background: 'color-mix(in srgb, var(--warn) 7%, transparent)' }}>
                  <div className="flex items-start gap-2 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                    <div className="text-xs text-fg-2 leading-relaxed">
                      {built.summary.below_target ? <>
                        {plural(built.summary.below_target, 'line')} price under target —{' '}
                        <b>E2E {pct(built.summary.overall_e2e)}</b> against a{' '}
                        {pct(built.summary.target_e2e, 0)} target. The price was not raised to
                        cover it, so this margin needs an approval.
                      </> : <>
                        {plural(built.summary.floored!, 'line')} asked for a price under the{' '}
                        {pct(built.summary.target_e2e, 0)} target and{' '}
                        <b>were priced at it</b> — {money(built.summary.floored_value, cur)} over
                        what the customer asked. Nothing goes out at cost.
                        {!!built.summary.e2e_concession?.length && <>{' '}If they push back,
                          concede no further than{' '}
                          {built.summary.e2e_concession.map(r => pct(r, 0)).join(' then ')} E2E.</>}
                      </>}
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
                    <div className="mt-2 text-2xs text-fg-3 leading-relaxed">{mailNote}</div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
                {([
                  ['Transaction', built.bom, 'as dropped'],
                  ['Feedback sheet', built.feedback, 'Approved Offer — values only'],
                  ['Ledger only', built.ledger, 'what the approval mail attaches'],
                  ['Working file', built.working, 'the master model, filled'],
                  ['First draft', built.baseline, 'BOM pasted, nothing else touched'],
                ] as const).map(([label, p, hint]) => p && (
                  <div key={label} className="flex items-center gap-2.5 px-3 py-2 rounded-panel border border-line-2 bg-surface">
                    <FileSpreadsheet className="w-3.5 h-3.5 shrink-0 text-fg-3" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-fg truncate">{p.split(/[\\/]/).pop()}</div>
                      <div className="text-2xs text-fg-3">{label} · {hint}</div>
                    </div>
                    <a href={api.lsdFileUrl(p)} download
                       className="shrink-0 p-1.5 rounded-md hover:bg-hover text-fg-3 hover:text-accent"
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
                  <div key={`a-${a.material}`} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-panel"
                       style={{ background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }}>
                    <Plus className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--warn)' }} />
                    <b className="text-fg">{a.material}</b>
                    <span className="text-fg-2 truncate">{a.description}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-fg-2">×{a.qty.toLocaleString()}</span>
                    <span className="shrink-0 text-2xs text-fg-3">new — priced by the rule</span>
                  </div>
                ))}
                {result.diff.qty_changed.map(c => (
                  <div key={`q-${c.material}`} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-panel border border-line-2">
                    <ArrowRight className="w-3.5 h-3.5 shrink-0 text-fg-3" />
                    <b className="text-fg">{c.material}</b>
                    <span className="text-fg-2 truncate">{c.description}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-fg-2">
                      {c.old_qty?.toLocaleString()} → {c.new_qty.toLocaleString()}
                    </span>
                    <span className="shrink-0 tabular-nums text-2xs"
                          style={{ color: c.delta > 0 ? 'var(--ok)' : 'var(--err)' }}>
                      {c.delta > 0 ? '+' : ''}{c.delta.toLocaleString()}
                    </span>
                    {c.unit_net != null && (
                      <span className="shrink-0 text-2xs text-fg-3">held at {num(c.unit_net)}</span>
                    )}
                  </div>
                ))}
                {result.diff.removed.map(r => (
                  <div key={`r-${r.material}`} className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-panel border border-line-2">
                    <Minus className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--err)' }} />
                    <b className="text-fg">{r.material}</b>
                    <span className="ml-auto shrink-0 tabular-nums text-fg-3">was ×{r.qty.toLocaleString()}</span>
                    <span className="shrink-0 text-2xs text-fg-3">dropped</span>
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
