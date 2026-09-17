// ─── Past quotes (CBU Sizer → Past quotes) ───────────────────────────────────
// Pick a system size, get the quote number to copy in Bidman.
//
// A repeat CBU enquiry — "10kVA single phase, 3hr" — is nearly always the last
// one of that size with a different project name on it. Finding that last one
// used to mean searching Ask Vector for "10kva-1ph", which returns nothing:
// no mail subject, CRM row or D&Q folder name records a system SIZE. The size
// exists only inside the Tech Brief the sizer exported, so that is what the
// scan reads (automation/cbu_ref_scan.py).
//
// This is a view of its own rather than a panel inside the sizer. Looking up
// what was quoted before and configuring a new system are two different jobs,
// and sharing one page put a second system selector next to the sizer's own.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Copy, Check, Star, RefreshCw, FolderOpen, Plus, X, AlertTriangle, Search,
  Sliders,
} from 'lucide-react';

import { api, type CbuRef, type CbuRefScan } from '../lib/api';
import { SIZES_1PH, SIZES_3PH } from '../lib/cbuData';
import { Dropdown, DItem } from './Dropdown';
import { Button as UiButton, IconButton as UiIconButton } from '../ui';

const ALL_SIZES = [...SIZES_1PH, ...SIZES_3PH];

// '3PH- 12KVA' → '12KVA'. The phase is already the group heading.
const shortSize = (s: string) => s.replace(/^[13]PH-\s*/, '');

// '2026-08-25' → '25 Aug 2026'. Anything unparseable is shown as it came.
function niceDate(s: string) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const SOURCE_LABEL: Record<string, string> = {
  brief:      'Tech Brief',
  calculator: 'Sizing calculator',
  mail:       'Outlook attachment',
  manual:     'Added by hand',
};

export default function CbuRefQuotes({
  size, onPickSize, onOpenSizer,
}: {
  size: string;
  onPickSize: (s: string) => void;
  onOpenSizer: () => void;
}) {
  const [refs,     setRefs]     = useState<CbuRef[]>([]);
  const [lastScan, setLastScan] = useState<CbuRefScan | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanMail, setScanMail] = useState(false);
  const [error,    setError]    = useState('');
  const [copied,   setCopied]   = useState<number | null>(null);
  const [q,        setQ]        = useState('');
  const [adding,   setAdding]   = useState(false);
  const [newRef,   setNewRef]   = useState('');
  const [newProj,  setNewProj]  = useState('');

  useEffect(() => {
    api.cbuRefs()
      .then(d => { setRefs(d.refs || []); setLastScan(d.lastScan || null); })
      .catch(e => setError(e?.message || 'Could not load the past quotes'))
      .finally(() => setLoading(false));
  }, []);

  // Server orders pinned-first, then newest, so grouping preserves that.
  const bySize = useMemo(() => {
    const m = new Map<string, CbuRef[]>();
    for (const r of refs) {
      const list = m.get(r.system);
      if (list) list.push(r); else m.set(r.system, [r]);
    }
    return m;
  }, [refs]);

  // Sizes the scan found that the calculator no longer lists — a brief exported
  // before a size was renamed, or a one-off. Offered at the bottom of the menu
  // rather than dropped, but they have no BoM behind them in the sizer.
  const strays = useMemo(
    () => [...bySize.keys()].filter(s => !ALL_SIZES.includes(s)).sort(),
    [bySize]);

  const covered = useMemo(
    () => ALL_SIZES.filter(s => (bySize.get(s)?.length ?? 0) > 0).length,
    [bySize]);

  // Searching cuts across every size: sometimes the project name is what is
  // remembered, not the rating.
  const term = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!term) return [];
    return refs.filter(r =>
      r.quoteRef.toLowerCase().includes(term)
      || (r.project || '').toLowerCase().includes(term)
      || r.system.toLowerCase().replace(/\s+/g, '').includes(term.replace(/\s+/g, '')));
  }, [refs, term]);

  const mine = size ? (bySize.get(size) ?? []) : [];

  const runScan = async () => {
    setScanning(true); setError('');
    try {
      const d = await api.cbuRefScan({ scanMail });
      if (!d.ok) throw new Error(d.error || 'The scan failed');
      setRefs(d.refs || []);
      setLastScan(d);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'The scan failed');
    } finally { setScanning(false); }
  };

  const copy = (r: CbuRef) => {
    navigator.clipboard.writeText(r.quoteRef).then(() => {
      setCopied(r.id);
      setTimeout(() => setCopied(c => (c === r.id ? null : c)), 1500);
    });
  };

  const pin = async (r: CbuRef) => {
    const on = !r.pinned;
    // One pin per size — the server clears the siblings, so mirror that here.
    setRefs(rs => rs.map(x =>
      x.system === r.system ? { ...x, pinned: on && x.id === r.id } : x));
    try { await api.cbuRefPin(r.id, on); }
    catch (e: any) { setError(e?.message || 'Could not pin that'); }
  };

  const hide = async (r: CbuRef) => {
    setRefs(rs => rs.filter(x => x.id !== r.id));
    try { await api.cbuRefHide(r.id); }
    catch (e: any) { setError(e?.message || 'Could not remove that'); }
  };

  const reveal = async (r: CbuRef) => {
    try {
      const d = await api.cbuRefReveal(r.id);
      if (!d.ok) setError(d.error || 'That file is no longer where it was scanned from');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not open that file');
    }
  };

  const addByHand = async () => {
    const ref = newRef.trim();
    if (!size || !ref) return;
    try {
      const d = await api.cbuRefSave({ system: size, quoteRef: ref, project: newProj.trim() });
      if (!d.ok || !d.ref) throw new Error(d.error || 'Could not save that');
      setRefs(rs => [d.ref!, ...rs.filter(x => x.id !== d.ref!.id)]);
      setNewRef(''); setNewProj(''); setAdding(false);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save that');
    }
  };

  // ── One quote ──────────────────────────────────────────────────────────────
  const Row = ({ r, lead, showSize }: { r: CbuRef; lead?: boolean; showSize?: boolean }) => (
    <div className={`flex items-start gap-2 px-4 py-2.5 border-b border-line last:border-b-0${
      lead ? ' bg-warn-soft' : ''}`}>
      <button onClick={() => pin(r)} title={r.pinned ? 'Unpin' : 'Keep this one as the quote to reuse at this size'}
        className={`mt-0.5 p-0.5 rounded shrink-0 transition-colors${
          r.pinned ? ' text-warn' : ' text-fg-4 hover:text-warn'}`}>
        <Star className="w-3.5 h-3.5" fill={r.pinned ? 'currentColor' : 'none'}/>
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`mono font-semibold text-fg ${lead ? 'text-base' : 'text-xs'}`}>
            {r.quoteRef}
          </span>
          <UiButton tone="ghost" className="shrink-0" aria-label="Copy quote reference" onClick={() => copy(r)} hint="Copy">
            {copied === r.id ? <Check className="w-3.5 h-3.5 text-ok"/> : <Copy className="w-3.5 h-3.5"/>}
          </UiButton>
          {showSize && (
            <span className="px-1.5 py-px rounded text-2xs font-semibold uppercase tracking-wide bg-subtle text-fg-3">
              {r.system.trim()}
            </span>
          )}
          {r.confidence === 'weak' && (
            <span title="The reference in this brief is not a recognisable Salesforce or BidManager id — likely a practice export"
              className="inline-flex items-center gap-0.5 px-1 py-px rounded text-2xs font-semibold uppercase tracking-wide bg-warn-soft text-warn">
              <AlertTriangle className="w-2.5 h-2.5"/> unverified
            </span>
          )}
        </div>
        <div className="text-xs text-fg-3 truncate">
          {r.project || <span className="italic text-fg-4">no project title in the brief</span>}
        </div>
        <div className="text-2xs text-fg-4 mt-0.5">
          {[niceDate(r.dated), r.duration, SOURCE_LABEL[r.source] || r.source]
            .filter(Boolean).join(' · ')}
        </div>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {r.source !== 'mail' && r.detail && (
          <UiIconButton icon={FolderOpen} label="Show the brief in Explorer" onClick={() => reveal(r)} />
        )}
        <UiIconButton icon={X} label="Not a real quote — remove it from the list" tone="danger" onClick={() => hide(r)} />
      </div>
    </div>
  );

  // One line in the system menu: the rating, and how many quotes sit behind it.
  const MenuItem = ({ s }: { s: string }) => {
    const n = bySize.get(s)?.length ?? 0;
    return (
      <DItem onClick={() => onPickSize(s)} active={s === size} dim={n === 0}>
        <span className="flex items-center justify-between gap-3">
          <span>{shortSize(s)}</span>
          <span className={`text-2xs font-semibold${n ? ' text-accent-text' : ' text-fg-4'}`}>
            {n ? `${n} quote${n > 1 ? 's' : ''}` : '—'}
          </span>
        </span>
      </DItem>
    );
  };

  const scanned = lastScan
    ? `${lastScan.found} found in ${lastScan.filesScanned} file${lastScan.filesScanned === 1 ? '' : 's'}`
      + (lastScan.mailsScanned ? ` and ${lastScan.mailsScanned} messages` : '')
      + ` · ${niceDate(lastScan.at.slice(0, 10))}`
    : 'never scanned';

  return (
    <div className="space-y-3 max-w-5xl">

      {/* ── Title + scan ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">Past LoadStar-PS quotes</h2>
          <p className="text-xs text-fg-4 mt-0.5">
            Pick a system to get the quote number to copy in Bidman · {covered} of {ALL_SIZES.length} sizes covered, {refs.length} quotes · {scanned}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label title="Also open the Outlook messages that carry a Tech Brief or a filled sizing calculator. Slower — one COM read per message."
            className="flex items-center gap-1 text-2xs text-fg-3 cursor-pointer select-none">
            <input type="checkbox" checked={scanMail} onChange={e => setScanMail(e.target.checked)}
              className="w-3 h-3 accent-accent"/>
            Outlook too
          </label>
          <button onClick={runScan} disabled={scanning}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all${
              scanning ? ' bg-subtle text-fg-4 cursor-not-allowed'
                       : ' bg-accent hover:bg-accent-hover text-on-accent'}`}>
            <RefreshCw className={`w-3.5 h-3.5${scanning ? ' animate-spin' : ''}`}/>
            {scanning ? (scanMail ? 'Scanning Outlook…' : 'Scanning…') : 'Scan for new quotes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-err bg-err-soft border border-err-soft rounded-xl px-4 py-2">
          {error}
        </div>
      )}
      {!!lastScan?.errors?.length && (
        <div className="text-2xs text-warn bg-warn-soft border border-warn-soft rounded-xl px-4 py-1.5">
          {lastScan.errors.length} file{lastScan.errors.length === 1 ? '' : 's'} could not be read: {lastScan.errors.slice(0, 3).join('; ')}
        </div>
      )}

      {/* ── Pick a system, or search across all of them ──────────────────────── */}
      <div className="bg-raised border border-line rounded-2xl p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
          <Dropdown label="System" value={size ? size.trim() : ''} placeholder="Select system…" wide>
            <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-fg-4 uppercase tracking-widest">Single phase</div>
            {SIZES_1PH.map(s => <MenuItem key={s} s={s}/>)}
            <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-fg-4 uppercase tracking-widest border-t border-line mt-1">Three phase</div>
            {SIZES_3PH.map(s => <MenuItem key={s} s={s}/>)}
            {strays.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-fg-4 uppercase tracking-widest border-t border-line mt-1">
                  Sizes the calculator no longer lists
                </div>
                {strays.map(s => (
                  <DItem key={s} onClick={() => onPickSize(s)} active={s === size}>
                    <span className="flex items-center justify-between gap-3">
                      <span>{s.trim()}</span>
                      <span className="text-2xs font-semibold text-accent-text">{bySize.get(s)!.length}</span>
                    </span>
                  </DItem>
                ))}
              </>
            )}
          </Dropdown>

          <div>
            <label className="block text-2xs font-semibold text-fg-4 uppercase tracking-wide mb-1">
              Or search every size
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-fg-4 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"/>
              <input value={q} onChange={e => setQ(e.target.value)}
                placeholder="Quote number or project…"
                className="w-full pl-8 pr-7 py-2 text-xs rounded-xl border border-line bg-surface focus:outline-none focus:border-accent-line transition-colors"/>
              {q && (
                <UiIconButton icon={X} label="Clear search" tone="danger" className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setQ('')} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────────── */}
      {term ? (
        <div className="bg-raised border border-line rounded-2xl overflow-hidden">
          <div className="px-4 py-2 bg-subtle border-b border-line text-2xs font-semibold text-fg-3 uppercase tracking-wide">
            {hits.length} match{hits.length === 1 ? '' : 'es'} for “{q.trim()}”
          </div>
          {hits.length === 0
            ? <div className="px-4 py-4 text-xs text-fg-4">Nothing recorded under that. Scan for new quotes, or clear the search and add one by hand.</div>
            : hits.map(r => <Row key={r.id} r={r} showSize/>)}
        </div>
      ) : size ? (
        <div className="bg-raised border border-line rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-subtle border-b border-line">
            <div className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">
              {size.trim()} · {mine.length} quote{mine.length === 1 ? '' : 's'}
              {mine.length > 1 && <span className="ml-1 normal-case font-semibold text-fg-4">— starred first, then newest</span>}
            </div>
            <UiButton tone="ghost" className="shrink-0" onClick={onOpenSizer} hint="Configure this system in the sizer">
              <Sliders className="w-3 h-3"/> Open in sizer
            </UiButton>
          </div>

          {mine.length === 0 ? (
            <div className="px-4 py-4 text-xs text-fg-4">
              {loading ? 'Loading…'
                : <>No quote recorded at <span className="font-semibold text-fg-3">{size.trim()}</span> yet.
                    Scan for new ones, or add the reference by hand.</>}
            </div>
          ) : mine.map((r, i) => <Row key={r.id} r={r} lead={i === 0}/>)}

          {/* Add by hand — for the quote whose brief was never saved locally */}
          {adding ? (
            <div className="flex items-center gap-2 px-4 py-2 border-t border-line">
              <input value={newRef} onChange={e => setNewRef(e.target.value)} placeholder="Quote reference"
                onKeyDown={e => { if (e.key === 'Enter') addByHand(); }}
                className="w-48 px-2 py-1 text-xs rounded-lg border border-line bg-warn-soft focus:outline-none focus:border-accent-line mono font-semibold"/>
              <input value={newProj} onChange={e => setNewProj(e.target.value)} placeholder="Project (optional)"
                onKeyDown={e => { if (e.key === 'Enter') addByHand(); }}
                className="flex-1 min-w-0 px-2 py-1 text-xs rounded-lg border border-line bg-surface focus:outline-none focus:border-accent-line"/>
              <button onClick={addByHand} disabled={!newRef.trim()}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold${
                  newRef.trim() ? ' bg-accent hover:bg-accent-hover text-on-accent' : ' bg-subtle text-fg-4'}`}>
                Save
              </button>
              <UiButton tone="quiet-danger" onClick={() => { setAdding(false); setNewRef(''); setNewProj(''); }}><X className="w-3.5 h-3.5"/></UiButton>
            </div>
          ) : (
            <button onClick={() => setAdding(true)}
              className="w-full flex items-center gap-1 px-4 py-2 text-2xs font-semibold text-fg-4 hover:text-accent-text border-t border-line transition-colors">
              <Plus className="w-3 h-3"/> Add a quote reference for {size.trim()} by hand
            </button>
          )}
        </div>
      ) : (
        <div className="bg-raised border border-line rounded-2xl px-4 py-6 text-xs text-fg-4 text-center">
          {loading ? 'Loading…' : 'Pick a system above, or search by quote number or project.'}
        </div>
      )}
    </div>
  );
}
