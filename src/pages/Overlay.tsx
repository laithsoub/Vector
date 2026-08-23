// ─── Overlay — companion app: floating V button + on-demand EL pricer ────────
// Loaded when App.tsx detects ?embed=1. Two visual states:
//   • Collapsed: a tiny circular V button you drag anywhere on screen.
//   • Expanded: a full pricer panel that fetches the current Outlook email
//     ON DEMAND (no polling) when you press "Pull from Outlook".
// Adding candidates appends to a live editable text area at the bottom.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Mail, Sparkles, Loader2, AlertTriangle, CheckCircle2, Paperclip,
  FileText, Image as ImageIcon, RefreshCw, X, Pin, PinOff, Copy, Plus,
  Sun, Moon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { failed, plural } from '../lib/errors';
import type { ToastFn } from '../App';

// ── Backend response types ──────────────────────────────────────────────────
interface PricedItem {
  ref: string; cat_no: string; description: string; family: string;
  qty: number; list_price: number; ntp: number; line_ntp: number;
  status: string; matched: boolean;
  match_type?: string; original_input?: string;
}
interface OverlayCandidate {
  cat_no: string; family: string; description: string;
  confidence: string; reasoning: string; source_url: string;
  matched: boolean;
  list_price: number | null; ntp: number | null; status: string | null;
  suggested_qty?: number;
}
interface QueryGroup {
  id:        string;
  label:     string;
  keywords:  string;
  qty:       number;
  candidates: OverlayCandidate[];
}
interface PriceResult {
  items:       PricedItem[];
  unmatched:   string[];
  total_ntp:   number;
  source:      string;
  candidates?: OverlayCandidate[];
  queries?:    QueryGroup[];
  inputs?:     { has_text: boolean; pdf_count: number; image_count: number; qty_hint: number };
  error?:      string;
}
interface CurrentEmail {
  selected:     boolean;
  reason?:      string;
  error?:       string;
  entryId?:     string;
  subject?:     string;
  sender?:      string;
  senderEmail?: string;
  received?:    string;
  body?:        string;
  attachments?: { index: number; name: string; size: number; isPdf: boolean }[];
  hasPdf?:      boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n: number) {
  return '£' + (n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function isImageName(n: string) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(n);
}
function extractMaterialHints(body: string): string {
  const hits: string[] = [];
  const catalogRe = /\b(MP2[A-Z0-9\-]*|NXL[A-Z0-9\-]*|LUM[A-Z0-9\-]*|AT-S[A-Z0-9\-]*|LP-STAR[A-Z0-9\-]*|I-P65[A-Z0-9 \-]*|IP65[A-Z0-9\-]*|CGS[A-Z0-9\-]*|CG-S[A-Z0-9\-]*|CGLine[A-Z0-9\-]*|CrystalWay[A-Z0-9\-]*|RoundTech[A-Z0-9\-]*|NexiLite[A-Z0-9\-]*|ExLin[A-Z0-9\-]*|LHID[A-Z0-9\-]*|EMP[A-Z0-9\-]*|CEAG[A-Z0-9\-]*)\b/i;
  const qtyLineRe = /\d+\s*[xX×]\s*[A-Z][A-Z0-9\-]{3,}|[A-Z][A-Z0-9\-]{3,}\s*[,;]\s*\d+/;
  for (const line of (body || '').split('\n')) {
    const t = line.trim();
    if (!t || t.length > 200) continue;
    if (catalogRe.test(t) || qtyLineRe.test(t)) hits.push(t);
  }
  return hits.join('\n');
}

// PyWebView JS bridge — set by outlook_overlay.py
function py() { return (window as any).pywebview?.api; }
function callPy(method: string, ...a: any[]) {
  try { py()?.[method]?.(...a); } catch {/* not running inside PyWebView */}
}

// ── V Button (collapsed mode) ──────────────────────────────────────────────
function VButton({ onExpand }: { onExpand: () => void }) {
  // Drag the window using the screen-relative mouse coordinates passed to
  // the Python API. A small move threshold distinguishes drag from click.
  const dragged = useRef(false);

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    dragged.current = false;
    callPy('begin_drag', e.screenX, e.screenY);
    const startX = e.screenX, startY = e.screenY;
    function move(ev: MouseEvent) {
      if (!dragged.current && (Math.abs(ev.screenX - startX) > 3 || Math.abs(ev.screenY - startY) > 3)) {
        dragged.current = true;
      }
      callPy('drag_to', ev.screenX, ev.screenY);
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      callPy('end_drag');
      if (!dragged.current) onExpand();
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  return (
    <div
      onMouseDown={onMouseDown}
      title="EL Pricer — click to expand, drag to move"
      className="w-full h-full rounded-full flex items-center justify-center cursor-pointer select-none transition-transform duration-150 hover:scale-105 active:scale-95"
      style={{
        background: 'radial-gradient(circle at 30% 25%, #fbbf24 0%, #f59e0b 45%, #b45309 100%)',
        boxShadow:
          // outer glow + soft drop shadow + crisp inner highlight
          '0 4px 14px rgba(217, 119, 6, 0.55), ' +
          '0 1px 3px rgba(0,0,0,0.25), ' +
          'inset 0 1px 1px rgba(255,255,255,0.45), ' +
          'inset 0 -2px 4px rgba(120,53,15,0.35)',
      }}>
      <span
        className="text-white font-bold drop-shadow-sm"
        style={{
          fontFamily: 'system-ui, sans-serif',
          fontSize:   'calc(min(100vw, 100vh) * 0.45)',
          lineHeight: 1,
          letterSpacing: '-0.02em',
        }}>
        V
      </span>
    </div>
  );
}

// ── Expanded panel ─────────────────────────────────────────────────────────
function ExpandedPanel({
  onCollapse, toast, dark, setDark,
}: {
  onCollapse: () => void;
  toast:      ToastFn;
  dark:       boolean;
  setDark:    (d: boolean) => void;
}) {
  const [current, setCurrent] = useState<CurrentEmail | null>(null);
  const [pulling, setPulling] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [result,  setResult]  = useState<PriceResult | null>(null);
  const [hints,   setHints]   = useState('');
  const [override, setOverride] = useState(false);
  const [pinned,  setPinned]    = useState(true);
  // Editable, copyable running schedule. Persists across multiple Price runs.
  const [schedule, setSchedule] = useState<string>(() => localStorage.getItem('mu_overlay_schedule') || '');

  useEffect(() => { localStorage.setItem('mu_overlay_schedule', schedule); }, [schedule]);

  // ── Drag the header strip ────────────────────────────────────────────────
  function onDragMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,input,textarea,select,a')) return;
    callPy('begin_drag', e.screenX, e.screenY);
    function move(ev: MouseEvent) { callPy('drag_to', ev.screenX, ev.screenY); }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      callPy('end_drag');
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ── On-demand pull from Outlook (no polling) ────────────────────────────
  const pullFromOutlook = useCallback(async () => {
    setPulling(true);
    try {
      const r = await fetch('/api/outlook/current');
      const data: CurrentEmail = await r.json();
      setCurrent(data);
      if (data.selected) {
        if (!override) setHints(extractMaterialHints(data.body || ''));
        setResult(null);
      }
    } catch (e: any) {
      toast('err', failed('read the selected email from Outlook', e));
      setCurrent({ selected: false, error: e.message });
    }
    setPulling(false);
  }, [override, toast]);

  // Pull once on expand
  useEffect(() => { pullFromOutlook(); }, [pullFromOutlook]);

  function togglePin() {
    setPinned(p => !p);
    callPy('toggle_pin');
  }

  // ── Price the current email ─────────────────────────────────────────────
  async function priceEmail() {
    if (!current?.selected) {
      toast('warn', 'No email is selected in Outlook — click one, then pull again');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      const text = [hints.trim(), current.body?.slice(0, 4000) || ''].filter(Boolean).join('\n\n— body —\n');
      fd.append('text', text);

      const candidates = (current.attachments || []).filter(a => a.isPdf || isImageName(a.name));
      for (const att of candidates) {
        try {
          const got = await fetch(`/api/outlook/get-attachment?entryId=${encodeURIComponent(current.entryId!)}&index=${att.index}`);
          if (!got.ok) continue;
          const blob = await got.blob();
          fd.append('files', blob, att.name);
        } catch {/* skip */}
      }

      const resp = await fetch('/api/schematics/price', { method: 'POST', body: fd });
      const data: PriceResult = await resp.json();
      if (data.error) {
        toast('err', failed('price this email', data.error));
        setResult(data);
      } else {
        setResult(data);
        const matched = data.items.filter(i => i.matched).length;
        const groups  = data.queries?.length || 0;
        const cands   = data.candidates?.length || 0;
        if (groups > 0) {
          toast('ok', `Detected ${plural(groups, 'item')} · ${plural(cands, 'extra suggestion')}`);
        } else if (matched > 0 || cands > 0) {
          toast('ok', `Priced ${plural(matched, 'match', 'matches')}${cands ? ` · ${plural(cands, 'suggestion')} to review` : ''}`);
        } else {
          toast('warn', 'Nothing in this email matched the price list');
        }
      }
    } catch (e: any) {
      toast('err', failed('price this email', e));
    }
    setBusy(false);
  }

  // ── Add candidate to the running schedule text ───────────────────────────
  function addToSchedule(c: OverlayCandidate, contextLabel?: string) {
    if (c.ntp == null) {
      toast('warn', `${c.cat_no} has no price in the list — nothing to add`);
      return;
    }
    const qty  = c.suggested_qty && c.suggested_qty > 0 ? c.suggested_qty : 1;
    const line = (c.ntp || 0) * qty;
    const desc = (c.description || c.family || '').slice(0, 38);
    const tag  = contextLabel ? ` (${contextLabel})` : '';
    const row = `${c.cat_no.padEnd(18)} ${desc.padEnd(38)} ${String(qty).padStart(3)}  ${fmt(c.ntp).padStart(8)}  ${fmt(line).padStart(9)}${tag}`;
    setSchedule(prev => {
      const header = prev.trim() ? prev : (
        `MATERIAL SCHEDULE — EATON EMERGENCY LIGHTING\n` +
        `${'─'.repeat(78)}\n` +
        `${'Catalogue No'.padEnd(18)} ${'Description'.padEnd(38)} ${'Qty'.padStart(3)}  ${'NTP'.padStart(8)}  ${'Line'.padStart(9)}\n` +
        `${'─'.repeat(78)}`
      );
      return header + '\n' + row;
    });
    toast('ok', `Added ${c.cat_no} × ${qty} to the schedule`);
  }

  function clearSchedule() {
    setSchedule('');
    toast('ok', 'Schedule cleared');
  }
  function copySchedule() {
    if (!schedule.trim()) return;
    navigator.clipboard.writeText(schedule);
    toast('ok', 'Schedule copied to the clipboard');
  }

  const atts = current?.attachments || [];
  const pricerAtts = atts.filter(a => a.isPdf || isImageName(a.name));

  return (
    <div className="flex flex-col w-screen h-screen bg-[var(--bg)] text-[var(--t1)] text-[12px] select-none overflow-hidden">

      {/* Drag bar */}
      <div
        onMouseDown={onDragMouseDown}
        className="flex items-center gap-2 px-3 h-9 border-b border-[var(--line)] bg-gradient-to-r from-amber-500 to-amber-600 text-white shrink-0 cursor-grab active:cursor-grabbing">
        <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center font-bold text-[12px]">V</span>
        <p className="font-semibold text-[12px] flex-1 truncate">EL Pricer</p>
        <button aria-label={dark ? 'Light mode' : 'Dark mode'}
          onClick={() => setDark(!dark)}
          title={dark ? 'Light mode' : 'Dark mode'}
          className="p-1 rounded hover:bg-white/20 transition-colors">
          {dark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
        </button>
        <button aria-label={pinned ? 'Pinned on top' : 'Not on top'}
          onClick={togglePin}
          title={pinned ? 'Pinned on top' : 'Not on top'}
          className="p-1 rounded hover:bg-white/20 transition-colors">
          {pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
        </button>
        <button aria-label="Collapse to V button"
          onClick={onCollapse}
          title="Collapse to V button"
          className="p-1 rounded hover:bg-white/20 transition-colors">
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">

        {!current ? (
          <div className="flex items-center justify-center h-24 text-[var(--t3)]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Reading Outlook…
          </div>
        ) : !current.selected ? (
          <div className="flex flex-col items-center justify-center h-24 text-[var(--t3)] text-center px-2">
            <Mail className="w-5 h-5 mb-1 opacity-50" />
            <p className="text-[11.5px]">{current.error || current.reason || 'No email selected'}</p>
            <button
              onClick={pullFromOutlook}
              disabled={pulling}
              className="mt-2 inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] font-medium text-[var(--accent-text)] hover:bg-[var(--accent-soft)]">
              {pulling ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Pull from Outlook
            </button>
          </div>
        ) : (
          <>
            {/* Email header */}
            <div className="rounded-lg ring-1 ring-inset ring-[var(--line-2)] bg-[var(--s1)] p-2.5">
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
                  <Mail className="w-3 h-3 text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[12px] truncate">{current.subject}</p>
                  <p className="text-[10.5px] text-[var(--t3)] truncate">
                    {current.sender}{current.senderEmail ? ` · ${current.senderEmail}` : ''}
                  </p>
                  {current.body && (
                    <p className="text-[10.5px] text-[var(--t3)] mt-1 line-clamp-2 leading-tight">
                      {current.body.slice(0, 240).replace(/\s+/g, ' ').trim()}
                    </p>
                  )}
                </div>
                <button aria-label="Re-read current Outlook selection"
                  onClick={pullFromOutlook}
                  disabled={pulling}
                  title="Re-read current Outlook selection"
                  className="p-1 rounded text-[var(--t3)] hover:text-[var(--accent-text)] hover:bg-[var(--s3)] transition-colors">
                  {pulling
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <RefreshCw className="w-3 h-3" />}
                </button>
              </div>
            </div>

            {pricerAtts.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <Paperclip className="w-3 h-3 text-[var(--t3)]" />
                <span className="text-[10px] text-[var(--t3)] uppercase tracking-wide font-semibold">
                  {pricerAtts.length} attachment{pricerAtts.length === 1 ? '' : 's'}
                </span>
                {pricerAtts.map(a => (
                  <span
                    key={a.index}
                    title={`${a.name} · ${(a.size / 1024).toFixed(0)} KB`}
                    className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] ring-1 ring-inset bg-[var(--s2)] ring-[var(--line-2)]">
                    {a.isPdf
                      ? <FileText className="w-2.5 h-2.5 text-rose-500" />
                      : <ImageIcon className="w-2.5 h-2.5 text-[var(--accent-text)]" />}
                    <span className="truncate max-w-[120px]">{a.name}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Hints */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[var(--t3)] uppercase tracking-wide font-semibold">Description / hints</span>
                {override && (
                  <button onClick={() => { setOverride(false); setHints(extractMaterialHints(current.body || '')); }}
                    className="text-[10px] text-[var(--accent-text)] hover:underline">
                    Reset
                  </button>
                )}
              </div>
              <textarea
                value={hints}
                onChange={e => { setHints(e.target.value); setOverride(true); }}
                placeholder="Auto-pulled from email. Edit to refine the AI's search."
                rows={3}
                className="w-full rounded-md bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] p-2 text-[11px] font-mono focus:outline-none focus:ring-[var(--accent-line)] resize-none placeholder:text-[var(--t4)]"
              />
            </div>

            {/* Price button */}
            <button
              onClick={priceEmail}
              disabled={busy || (pricerAtts.length === 0 && !hints.trim())}
              className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12px] font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shadow-sm">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {busy ? 'Pricing email…' : 'Price this email'}
            </button>

            {/* Per-item query groups */}
            {result?.queries && result.queries.length > 0 && (
              <div className="space-y-2.5">
                {result.queries.map((q, gi) => (
                  <div key={q.id} className="rounded-lg ring-1 ring-inset ring-[var(--line-2)] overflow-hidden">
                    <div className="px-2.5 py-1.5 bg-[var(--accent-soft)] border-b border-[var(--accent-line)]">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-text)]">
                          Item {gi + 1}
                        </span>
                        {q.qty > 1 && (
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)]">qty {q.qty}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--t2)] mt-0.5">{q.label || '(unlabelled)'}</p>
                    </div>
                    {q.candidates.length === 0 ? (
                      <p className="px-3 py-2 text-[10.5px] text-[var(--t3)]">No price-list candidates for this item.</p>
                    ) : (
                      <div className="divide-y divide-[var(--line)]">
                        {q.candidates.slice(0, 4).map((c, i) => (
                          <CandidateRow
                            key={`${c.cat_no}-${i}`}
                            c={c}
                            label={`Item ${gi + 1}`}
                            onAdd={() => addToSchedule(c, `Item ${gi + 1}`)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Description-driven extras */}
            {result?.candidates && result.candidates.length > 0 && (!result.queries || result.queries.length === 0) && (
              <div className="rounded-lg ring-1 ring-inset ring-[var(--line-2)] overflow-hidden">
                <div className="px-2.5 py-1.5 bg-[var(--s1)] border-b border-[var(--line)]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--t3)]">From description</span>
                </div>
                <div className="divide-y divide-[var(--line)]">
                  {result.candidates.slice(0, 6).map((c, i) => (
                    <CandidateRow key={`${c.cat_no}-${i}`} c={c} onAdd={() => addToSchedule(c)} />
                  ))}
                </div>
              </div>
            )}

            {/* Explicit matched items (PDF / cat-no list) */}
            {result && result.items.filter(i => i.matched).length > 0 && (
              <div className="rounded-lg ring-1 ring-inset ring-emerald-200 dark:ring-emerald-700/40 bg-emerald-50/40 dark:bg-emerald-900/10 overflow-hidden">
                <div className="px-2.5 py-1.5 bg-emerald-100/60 dark:bg-emerald-900/30 border-b border-emerald-200 dark:border-emerald-700/40">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    Exact matches ({result.items.filter(i => i.matched).length})
                  </span>
                </div>
                <div className="divide-y divide-emerald-100 dark:divide-emerald-900/40">
                  {result.items.filter(i => i.matched).map((item, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]">
                      <div className="flex-1 min-w-0">
                        <p className="font-mono font-semibold text-[var(--accent-text)] truncate">{item.cat_no}</p>
                        <p className="text-[var(--t3)] truncate">{item.description}</p>
                      </div>
                      <span className="font-mono text-[var(--t2)] shrink-0">×{item.qty}</span>
                      <span className="font-mono text-[var(--t1)] shrink-0">{fmt(item.line_ntp)}</span>
                      <button
                        onClick={() => addToSchedule({
                          cat_no: item.cat_no, family: item.family, description: item.description,
                          confidence: 'exact', reasoning: '', source_url: '',
                          matched: true, list_price: item.list_price, ntp: item.ntp,
                          status: item.status, suggested_qty: item.qty,
                        })}
                        className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded text-[9.5px] font-semibold bg-amber-500 hover:bg-amber-600 text-white">
                        <Plus className="w-2.5 h-2.5" /> Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result?.error && (
              <div className="rounded-md ring-1 ring-inset ring-red-200 dark:ring-red-700/40 bg-red-50 dark:bg-red-900/10 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                {result.error}
              </div>
            )}

            {result && !result.error
              && (!result.queries || result.queries.length === 0)
              && (!result.candidates || result.candidates.length === 0)
              && result.items.filter(i => i.matched).length === 0 && (
              <div className="text-center text-[var(--t3)] text-[11px] py-3">
                <CheckCircle2 className="w-4 h-4 mx-auto mb-1 opacity-50" />
                No matches. Try editing the hints above.
              </div>
            )}
          </>
        )}
      </div>

      {/* Running schedule — always visible at the bottom */}
      <div className="border-t border-[var(--line)] bg-[var(--s1)] shrink-0">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--t3)]">
            Material schedule {schedule.split('\n').length > 4 ? `(${schedule.split('\n').length - 4} item${schedule.split('\n').length - 4 === 1 ? '' : 's'})` : ''}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={copySchedule} disabled={!schedule.trim()}
              className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium text-[var(--t2)] hover:bg-[var(--s-hover)] disabled:opacity-40 transition-colors">
              <Copy className="w-2.5 h-2.5" /> Copy
            </button>
            <button onClick={clearSchedule} disabled={!schedule.trim()}
              className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 transition-colors">
              Clear
            </button>
          </div>
        </div>
        <textarea
          value={schedule}
          onChange={e => setSchedule(e.target.value)}
          placeholder="Adding candidates above will append rows here. Edit freely, then Copy."
          className="w-full h-32 px-3 pb-2 bg-transparent text-[10.5px] font-mono focus:outline-none resize-none placeholder:text-[var(--t4)]"
        />
      </div>
    </div>
  );
}

// ── Candidate row (reused by per-item groups + description fallback) ──────
function CandidateRow({
  c, onAdd, label,
}: {
  c:     OverlayCandidate;
  onAdd: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9.5px] font-semibold uppercase tracking-wide text-[var(--t3)]">{c.confidence}</span>
          {c.matched
            ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">in list</span>
            : <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--s3)] text-[var(--t2)]">not priced</span>}
          {c.suggested_qty && c.suggested_qty > 1 && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)]">qty {c.suggested_qty}</span>
          )}
        </div>
        <p className="font-mono text-[11px] font-semibold truncate">{c.cat_no}</p>
        {c.family && <p className="text-[10px] text-[var(--accent-text)] truncate">{c.family}</p>}
        {c.description && <p className="text-[10px] text-[var(--t3)] line-clamp-1">{c.description}</p>}
        {c.reasoning && <p className="text-[9.5px] text-[var(--t3)] italic line-clamp-2 mt-0.5">"{c.reasoning}"</p>}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {c.matched && c.ntp != null && (
          <p className="text-[12px] font-semibold tabular-nums leading-none">{fmt(c.ntp)}</p>
        )}
        <button
          onClick={onAdd}
          disabled={!c.matched}
          className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded text-[9.5px] font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white transition-colors">
          <Plus className="w-2.5 h-2.5" /> Add
        </button>
      </div>
    </div>
  );
}

// ── Root: collapsed V or expanded panel ───────────────────────────────────
export function OverlayPage({ toast }: { toast: ToastFn }) {
  // The Python window decides physical size — we only swap visual state.
  // Persist the user's last mode so the window opens where they left off.
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem('mu_overlay_expanded') === '1',
  );
  useEffect(() => { localStorage.setItem('mu_overlay_expanded', expanded ? '1' : '0'); }, [expanded]);

  // Match the rest of the app's dark mode preference but allow per-overlay toggle.
  const [dark, setDarkState] = useState<boolean>(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  function expand() {
    callPy('expand');
    setExpanded(true);
  }
  function collapse() {
    callPy('collapse');
    setExpanded(false);
  }

  // Strip the default page background so the V button can be a clean circle.
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden bg-transparent">
      {expanded ? (
        <ExpandedPanel onCollapse={collapse} toast={toast} dark={dark} setDark={setDarkState} />
      ) : (
        <VButton onExpand={expand} />
      )}
    </div>
  );
}
