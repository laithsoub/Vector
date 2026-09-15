// ─── Filing — D&Q Store backfill: audit sent quotes, then file the gaps ──────
//
// The audit compares every quote actually sent from Outlook against what is in
// the shared D&Q Store. It has been read-only since it was written, and what it
// reported was that only about a quarter of sent quotes are filed correctly.
//
// This page is the other half: it shows what the audit found and lets specific
// rows be filed. Because the destination is a store the whole team shares, the
// write is gated rather than convenient —
//
//   * nothing is preselected, and there is no "select all fixable" shortcut
//   * Preview (a dry run that writes nothing) must be run before File is offered
//   * the plan from that dry run is shown per row before anything is written
//   * only the three MISSING_* verdicts can be filed at all; DIFFERENT_COPY
//     means something is already filed under that reference and a person has to
//     decide which copy is right
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderTree, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Check,
  FileText, ShieldCheck, Upload, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Card, CardTitle, Button, Pill } from '../lib/ui';
import { cn } from '../lib/cn';
import { failed, plural } from '../lib/errors';
import { api, type DqAuditRow, type DqAuditResult, type DqAuditStatus, type DqFileResult, type DqVerdict } from '../lib/api';
import type { ToastFn } from '../App';

// How each verdict reads, and whether it is the app's business to fix it.
const VERDICT_META: Record<string, { label: string; tone: string; blurb: string }> = {
  MATCH:            { label: 'Filed',            tone: 'text-emerald-600 dark:text-emerald-400', blurb: 'The sent PDF is in the store, byte for byte.' },
  MATCH_RERENDER:   { label: 'Filed (re-render)',tone: 'text-emerald-600 dark:text-emerald-400', blurb: 'Same text in the store, saved from a different render.' },
  MISSING_FOLDER:   { label: 'No folder',        tone: 'text-red-500 dark:text-red-400',         blurb: 'Nothing exists in the store for this opportunity.' },
  MISSING_REVISION: { label: 'No revision',      tone: 'text-amber-600 dark:text-amber-400',     blurb: 'The folder exists but not this revision.' },
  MISSING_FILE:     { label: 'Not in folder',    tone: 'text-amber-600 dark:text-amber-400',     blurb: 'Folder and revision exist; the quote is not in them.' },
  DIFFERENT_COPY:   { label: 'Different copy',   tone: 'text-violet-500 dark:text-violet-400',   blurb: 'A file with this reference is filed but differs — needs your eye.' },
  UNRESOLVED:       { label: 'No reference',     tone: 'text-[var(--t3)]',                        blurb: 'No Salesforce id or works number to match on.' },
  ERROR:            { label: 'Check failed',     tone: 'text-[var(--t3)]',                        blurb: 'The comparison itself failed.' },
};
const meta = (v: string) => VERDICT_META[v] || { label: v, tone: 'text-[var(--t3)]', blurb: '' };

// Verdict groups, worst first: the point of the page is the top of this list.
const ORDER: DqVerdict[] = [
  'MISSING_FOLDER', 'MISSING_REVISION', 'MISSING_FILE',
  'DIFFERENT_COPY', 'UNRESOLVED', 'ERROR', 'MATCH_RERENDER', 'MATCH',
];

export function FilingPage({ toast }: { toast: ToastFn }) {
  const [status, setStatus]   = useState<DqAuditStatus | null>(null);
  const [result, setResult]   = useState<DqAuditResult | null>(null);
  const [months, setMonths]   = useState(3);
  const [picked, setPicked]   = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['MISSING_FOLDER']));
  const [preview, setPreview] = useState<DqFileResult | null>(null);
  const [busy, setBusy]       = useState<'' | 'preview' | 'file'>('');
  const pollRef               = useRef<number | null>(null);

  const loadResult = useCallback(async () => {
    try { setResult(await api.dqAuditResult()); }
    catch (e: any) { toast('err', failed('load the audit', e)); }
  }, [toast]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.dqAuditStatus();
      setStatus(s);
      if (!s.running && pollRef.current) {
        window.clearInterval(pollRef.current); pollRef.current = null;
        if (s.phase === 'done') { await loadResult(); toast('ok', 'Audit finished'); }
        else if (s.phase === 'error') toast('err', failed('run the audit', s.error));
      }
      return s;
    } catch { return null; }
  }, [loadResult, toast]);

  useEffect(() => {
    void (async () => {
      const s = await loadStatus();
      await loadResult();
      if (s?.running && !pollRef.current) pollRef.current = window.setInterval(loadStatus, 2000);
    })();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  async function runAudit() {
    // A fresh audit invalidates any plan built from the previous one.
    setPicked(new Set()); setPreview(null);
    try {
      const s = await api.dqAuditStart(months);
      setStatus(s);
      if (!pollRef.current) pollRef.current = window.setInterval(loadStatus, 2000);
    } catch (e: any) { toast('err', failed('start the audit', e)); }
  }

  // Changing the selection invalidates the preview — the plan shown must always
  // be the plan for what is currently ticked.
  function toggle(id: number) {
    setPreview(null);
    setPicked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function runPreview() {
    setBusy('preview');
    try {
      const r = await api.dqFile([...picked], true);
      setPreview(r);
      if (r.error) toast('err', failed('preview the filing', r.error));
    } catch (e: any) { toast('err', failed('preview the filing', e)); }
    finally { setBusy(''); }
  }

  async function runFile() {
    setBusy('file');
    try {
      const r = await api.dqFile([...picked], false);
      setPreview(r);
      if (r.error) { toast('err', failed('file the quotes', r.error)); return; }
      toast(r.failed ? 'warn' : 'ok',
        `Filed ${r.filed} of ${r.approved} · ${r.skipped} skipped · ${r.failed} failed`);
      setPicked(new Set());
      await loadResult();            // verdicts change once files land
    } catch (e: any) { toast('err', failed('file the quotes', e)); }
    finally { setBusy(''); }
  }

  const rows     = result?.rows || [];
  const running  = !!status?.running;
  const grouped  = ORDER.map(v => ({ verdict: v, items: rows.filter(r => r.verdict === v) }))
                        .filter(g => g.items.length > 0);
  // Only rows the server marked fileable can be ticked, so the UI can never
  // offer to write something the writer would refuse.
  const pickedFileable = rows.filter(r => picked.has(r.id) && r.fileable).length;
  const wouldFile      = preview?.results.filter(r => r.status === 'would-file').length ?? 0;
  const previewIsFor   = preview && !preview.dryRun ? null : preview;

  return (
    <div className="space-y-4">
      {/* ── Run the audit ── */}
      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <CardTitle title="D&Q filing audit"
              sub="Compares the quotes you actually sent against what is in the shared store" />
            {result?.generatedAt && (
              <p className="text-[11px] text-[var(--t3)] mt-1.5">
                Last audit {new Date(result.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                {result.months != null && ` · ${result.months} month${result.months === 1 ? '' : 's'} of Sent Items`}
                {' · '}{plural(result.total, 'quote revision')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-[11px] text-[var(--t3)]">Months</label>
            <input type="number" min={1} max={24} value={months} disabled={running}
              onChange={e => setMonths(Math.min(24, Math.max(1, Number(e.target.value) || 3)))}
              className="w-14 text-[12px] text-right bg-[var(--s3)] rounded-md px-2 py-1 ring-1 ring-inset ring-[var(--line-2)] focus:outline-none focus:ring-violet-400 text-[var(--t1)] disabled:opacity-50" />
            <Button tone="primary" Icon={running ? Loader2 : RefreshCw} onClick={runAudit} disabled={running}>
              {running ? 'Auditing…' : 'Run audit'}
            </Button>
          </div>
        </div>

        {running && (
          <div className="mt-3 rounded-lg bg-[var(--s3)] px-3 py-2">
            <p className="text-[11.5px] text-[var(--t2)] flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              {status?.message || 'Working…'}
            </p>
            <p className="text-[10px] text-[var(--t3)] mt-1">
              Reads months of Sent Items and indexes the store — this takes minutes.
            </p>
          </div>
        )}

        {/* The tally, worst first */}
        {result && result.total > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {ORDER.filter(v => result.tally[v]).map(v => (
              <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)]">
                <span className={meta(v).tone}>{meta(v).label}</span>
                <span className="text-[var(--t2)] font-semibold">{result.tally[v]}</span>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* ── The review list ── */}
      {result && result.total > 0 && (
        <Card padded={false}>
          <div className="px-5 py-3 border-b border-[var(--line)] flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">Review</h3>
              <p className="text-[10.5px] text-[var(--t3)] mt-0.5">
                {result.fileable > 0
                  ? `${plural(result.fileable, 'quote')} could be filed. Tick the ones you want, preview, then file.`
                  : 'Nothing here can be filed automatically.'}
              </p>
            </div>
            {picked.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--t2)] font-medium">
                  {plural(pickedFileable, 'row')} selected
                </span>
                <button onClick={() => { setPicked(new Set()); setPreview(null); }}
                  className="text-[11px] text-[var(--t3)] hover:text-[var(--t1)] underline">clear</button>
              </div>
            )}
          </div>

          <div className="divide-y divide-[var(--line)]">
            {grouped.map(g => {
              const open = expanded.has(g.verdict);
              const m    = meta(g.verdict);
              return (
                <div key={g.verdict}>
                  <button
                    onClick={() => setExpanded(prev => {
                      const n = new Set(prev);
                      n.has(g.verdict) ? n.delete(g.verdict) : n.add(g.verdict);
                      return n;
                    })}
                    className="w-full flex items-center gap-2 px-5 py-2 hover:bg-[var(--s3)] transition-colors text-left">
                    {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--t3)]" />
                          : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--t3)]" />}
                    <span className={cn('text-[12px] font-semibold', m.tone)}>{m.label}</span>
                    <span className="text-[11px] text-[var(--t3)]">{g.items.length}</span>
                    <span className="text-[10.5px] text-[var(--t3)] truncate hidden sm:block ml-1">{m.blurb}</span>
                  </button>

                  {open && (
                    <div className="pb-1">
                      {g.items.map(r => <RowLine key={r.id} row={r} picked={picked.has(r.id)} onToggle={toggle} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── The gate: preview, then write ── */}
      {picked.size > 0 && (
        <Card>
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent-text)]" />
            <div className="min-w-0 flex-1">
              <h3 className="text-[12.5px] font-semibold text-[var(--t1)]">
                Filing {plural(pickedFileable, 'quote')} into the shared store
              </h3>
              <p className="text-[10.5px] text-[var(--t3)] mt-0.5 leading-relaxed">
                This writes to the D&Q Store everyone uses. Preview first — it checks each destination
                and reports what it would do without writing anything.
              </p>

              {previewIsFor && (
                <div className="mt-2.5 rounded-lg bg-[var(--s3)] px-3 py-2 max-h-[220px] overflow-y-auto">
                  <p className="text-[11px] font-semibold text-[var(--t2)] mb-1">
                    {preview!.dryRun ? 'Plan' : 'Result'} · {preview!.considered} considered
                  </p>
                  {preview!.results.map((x, i) => (
                    <p key={i} className="text-[10.5px] leading-relaxed flex gap-1.5">
                      <span className={cn('shrink-0 font-medium',
                        x.status === 'filed'      ? 'text-emerald-600 dark:text-emerald-400'
                        : x.status === 'would-file' ? 'text-[var(--accent-text)]'
                        : x.status === 'failed'     ? 'text-red-500'
                        : 'text-[var(--t3)]')}>
                        {x.status === 'would-file' ? 'would file' : x.status}
                      </span>
                      <span className="text-[var(--t2)] truncate">{x.label}</span>
                      <span className="text-[var(--t3)] truncate hidden md:block">{x.detail}</span>
                    </p>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <Button Icon={busy === 'preview' ? Loader2 : FileText}
                  onClick={runPreview} disabled={!!busy || pickedFileable === 0}>
                  {busy === 'preview' ? 'Checking…' : 'Preview'}
                </Button>
                {/* Only offered once a dry run has actually produced a plan. */}
                <Button tone="primary" Icon={busy === 'file' ? Loader2 : Upload}
                  onClick={runFile}
                  disabled={!!busy || !preview?.dryRun || wouldFile === 0}>
                  {busy === 'file' ? 'Filing…' : `File ${wouldFile || ''}`.trim()}
                </Button>
                {!preview?.dryRun && (
                  <span className="text-[10.5px] text-[var(--t3)]">Preview before filing.</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Nothing has been run yet */}
      {!running && (!result || result.total === 0) && (
        <Card className="text-center py-10">
          <FolderTree className="w-7 h-7 mx-auto text-[var(--t3)]" />
          <p className="text-[13px] font-medium text-[var(--t2)] mt-2">No audit yet</p>
          <p className="text-[11.5px] text-[var(--t3)] mt-1 max-w-md mx-auto leading-relaxed">
            Run the audit to compare the quotes you have sent against the D&Q Store. It reads Outlook and
            SharePoint only — nothing is written until you approve specific rows.
          </p>
        </Card>
      )}
    </div>
  );
}

function RowLine({ row, picked, onToggle }: {
  row: DqAuditRow; picked: boolean; onToggle: (id: number) => void;
}) {
  const selectable = row.fileable;
  return (
    <div className={cn('flex items-start gap-2.5 px-5 py-1.5 transition-colors',
      selectable ? 'hover:bg-[var(--s3)] cursor-pointer' : 'opacity-70')}
      onClick={selectable ? () => onToggle(row.id) : undefined}>
      <span className={cn('mt-0.5 w-3.5 h-3.5 shrink-0 rounded flex items-center justify-center ring-1 ring-inset transition-colors',
        !selectable ? 'ring-[var(--line)] bg-[var(--s3)]'
        : picked    ? 'bg-[var(--accent)] ring-[var(--accent)]'
                    : 'ring-[var(--line-2)]')}>
        {picked && <Check className="w-2.5 h-2.5 text-white" />}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] text-[var(--t1)] truncate">
          {row.code || row.sfid || row.works || row.attachment}
          {row.revision && <span className="text-[var(--t3)] ml-1.5">{row.revision}</span>}
        </p>
        <p className="text-[10px] text-[var(--t3)] truncate">
          {row.sent?.slice(0, 10)}
          {row.timesSent > 1 && ` · sent ${row.timesSent}×`}
          {row.subject && ` · ${row.subject}`}
        </p>
        {row.detail && <p className="text-[10px] text-[var(--t3)] truncate italic">{row.detail}</p>}
      </div>

      {row.folderCount > 1 && <Pill tone="warn">{row.folderCount} folders</Pill>}
      {!selectable && row.verdict !== 'MATCH' && row.verdict !== 'MATCH_RERENDER' && (
        <span className="text-[9.5px] text-[var(--t3)] shrink-0 mt-0.5">needs you</span>
      )}
    </div>
  );
}
