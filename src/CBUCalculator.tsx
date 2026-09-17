import React, { useState } from 'react';
import { Printer, Copy, Check } from 'lucide-react';

import { DATA, SIZES_1PH, SIZES_3PH } from './lib/cbuData';
import { useSalesmen } from './lib/salesmen';
import { Dropdown, DItem } from './components/Dropdown';
import { Button as UiButton } from './ui';

const f2 = (n:number) => `£${n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

// ── Main export ───────────────────────────────────────────────────────────────
export default function CBUCalculator({ size, onSize }: { size: string; onSize: (s: string) => void }) {
  const setSize = onSize;
  const [pn,    setPN]     = useState('');
  const [qr,    setQR]     = useState('');
  const [smIdx, setSmIdx]  = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  // Systems going into one quote, in print order. Empty means "just the one on
  // screen", so the single-system flow is unchanged. The same size may appear
  // more than once — a site with two identical 10KVA systems is two briefs.
  const [systems, setSystems] = useState<string[]>([]);

  const SALESMEN = useSalesmen();
  const cfg = size ? DATA[size] : null;
  const sm  = smIdx !== null ? SALESMEN[smIdx] ?? null : null;
  const toPrint = systems.length ? systems : (size ? [size] : []);
  const ok  = toPrint.length > 0 && toPrint.every(s => DATA[s]) && !!pn.trim() && !!qr.trim() && sm !== null;
  const quoteTotal = toPrint.reduce((t, s) => t + (DATA[s]?.total || 0), 0);

  const ycls = "bg-warn-soft border border-line px-2 py-1 text-xs font-semibold text-fg rounded";

  const handleExport = async () => {
    if (!ok || !sm) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/run/cbu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systems:  toPrint,
          project:  pn.trim(),
          quote:    qr.trim(),
          engineer: sm.name,
          email:    sm.email,
          phone:    sm.phone,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Server error');

      const dl = await fetch(`/api/download/cbu/${json.id}`);
      if (!dl.ok) throw new Error('Download failed');
      const blob = await dl.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      // The server builds the name — quote reference as typed, revision and all,
      // plus the system, so two sizes quoted under one reference do not collide.
      // Falling back to the old name only if an older sidecar answers without it.
      a.download = json.fileName || `CBU_Tech_Brief_${qr.trim()}.pdf`;
      // A detached anchor's click is ignored by some engines, WebView2 included,
      // which is how the desktop app ended up falling through to the download
      // header instead of using this name at all.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoked on the next tick: revoking synchronously can cancel the save
      // before the engine has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const [copied, setCopied] = useState<string|null>(null);

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const CopyBtn = ({ val, id }: { val: string; id: string }) => (
    <UiButton tone="ghost" className="ml-1.5 shrink-0" aria-label="Copy" onClick={() => copy(val, id)} hint="Copy">
      {copied === id
        ? <Check className="w-3 h-3 text-ok"/>
        : <Copy className="w-3 h-3"/>}
    </UiButton>
  );

  return (
    <div className="space-y-3 max-w-5xl">

      {/* ── Title + Export button ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-fg">UK CSO Loadstar-PS Quote Configurator V3</h2>
          <p className="text-xs text-fg-4 mt-0.5">Only edit yellow cells</p>
        </div>
        <button onClick={handleExport} disabled={!ok || loading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all${ok&&!loading?' bg-accent hover:bg-accent-hover text-on-accent':' bg-subtle text-fg-4 cursor-not-allowed'}`}>
          <Printer className="w-3.5 h-3.5"/>
          {loading
            ? `Generating${toPrint.length > 1 ? ` ${toPrint.length} briefs` : ''}…`
            : !ok ? 'Fill all fields to export'
            : toPrint.length > 1 ? `Export ${toPrint.length} systems + Commissioning + T&C`
            : 'Export CBU Tech Brief PDF'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-err bg-err-soft border border-err-soft rounded-xl px-4 py-2">
          {error}
        </div>
      )}

      {/* ── System / Build / Duration + Project info — all in one card ────────── */}
      <div className="bg-raised border border-line rounded-2xl overflow-hidden">

        {/* Row 1: System selector + auto fields */}
        <div className="grid grid-cols-3 bg-subtle border-b border-line">
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">System</div>
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">Build</div>
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">Duration (Hrs)</div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-line">
          <Dropdown label="" value={size} placeholder="Select system…" required>
            <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-fg-4 uppercase tracking-widest">Single Phase</div>
            {SIZES_1PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
            <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-fg-4 uppercase tracking-widest border-t border-line mt-1">Three Phase</div>
            {SIZES_3PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
          </Dropdown>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.build || <span className="text-fg-4">—</span>}</span>
            {cfg?.build && <CopyBtn val={cfg.build} id="build"/>}
          </div>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.duration || <span className="text-fg-4">—</span>}</span>
            {cfg?.duration && <CopyBtn val={cfg.duration} id="duration"/>}
          </div>
        </div>

        {/* Row 1b: systems in this quote — one brief each, merged into one PDF */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line">
          <span className="text-2xs font-semibold text-fg-3 uppercase tracking-wide mr-1">Systems in this quote</span>
          {systems.map((s, i) => (
            <span key={i}
              className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-xs font-semibold border${
                s === size
                  ? ' bg-accent-soft border-accent-line text-accent-text'
                  : ' bg-surface border-line text-fg-2'}`}>
              <button onClick={() => setSize(s)} title="Show this system's BoM">{i + 1}. {s}</button>
              <button aria-label={`Remove ${s}`} title="Remove"
                onClick={() => setSystems(list => list.filter((_, j) => j !== i))}
                className="px-1 rounded text-fg-4 hover:text-err">×</button>
            </span>
          ))}
          <button disabled={!cfg} onClick={() => setSystems(list => [...list, size])}
            className={`px-2 py-0.5 rounded-md text-xs font-semibold border border-dashed${cfg
              ? ' border-accent-line text-accent-text hover:bg-accent-soft'
              : ' border-line text-fg-4 cursor-not-allowed'}`}>
            + Add {cfg ? size : 'selected system'}
          </button>
          {systems.length > 0 && (
            <span className="ml-auto flex items-center gap-2 text-xs text-fg-3">
              Quote total <span className="mono font-semibold text-fg">{f2(quoteTotal)}</span>
              <CopyBtn val={quoteTotal.toFixed(2)} id="quote-total"/>
              <button onClick={() => setSystems([])} className="hover:text-err">Clear</button>
            </span>
          )}
          {systems.length === 0 && (
            <span className="text-2xs text-fg-4">Empty = export just the selected system. Each added system prints its own brief; Commissioning + T&C go once at the end.</span>
          )}
        </div>

        {/* Row 2: Project info */}
        <div className="grid grid-cols-3 bg-subtle border-b border-line">
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">Project Title <span className="text-err">*</span></div>
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">Quote Reference <span className="text-err">*</span></div>
          <div className="px-4 py-2 text-xs font-semibold text-fg-2 uppercase tracking-wide">Sales Engineer <span className="text-err">*</span></div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-line">
          <div className="flex items-center gap-1">
            <input value={pn} onChange={e=>setPN(e.target.value)} placeholder="e.g. Heathrow T5"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-line bg-warn-soft focus:outline-none focus:border-accent-line transition-colors font-semibold"/>
            {pn && <CopyBtn val={pn} id="pn"/>}
          </div>
          <div className="flex items-center gap-1">
            <input value={qr} onChange={e=>setQR(e.target.value)} placeholder="e.g. QB28154"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-line bg-warn-soft focus:outline-none focus:border-accent-line transition-colors font-semibold"/>
            {qr && <CopyBtn val={qr} id="qr"/>}
          </div>
          <Dropdown label="" value={sm?.name||''} placeholder="Select engineer…" required>
            {SALESMEN.map((s,i)=>(
              <DItem key={s.name} onClick={()=>setSmIdx(i)} active={smIdx===i}>
                <div className="text-xs font-medium">{s.name}</div>
                <div className="text-2xs text-fg-4">{s.phone}</div>
              </DItem>
            ))}
          </Dropdown>
        </div>

        <div className="px-4 py-2 text-2xs text-warn">
          * Ensure Unit prices are added to Bidman and correctly quantified. Pricing is Sell Out at 1.0 multiplier.
        </div>
      </div>

      {/* ── BoM table ────────────────────────────────────────────────────────── */}
      {cfg && (
        <div className="bg-raised border border-line rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-term text-on-accent">
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide w-44">Item</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide">Catalogue #</th>
                  <th className="text-center px-3 py-3 text-xs font-semibold uppercase tracking-wide w-12">Qty</th>
                  <th className="text-right px-3 py-3 text-xs font-semibold uppercase tracking-wide">Unit Price</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide">Description</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide">Product ID</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide hidden lg:table-cell">Cabinet Type</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide hidden xl:table-cell">H×W×D (mm)</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold uppercase tracking-wide hidden xl:table-cell">Weight</th>
                </tr>
              </thead>
              <tbody>
                {cfg.rows.map((r,i)=>{
                  const active = r.qty > 0 && r.catNo !== 'N/A' && r.catNo !== '—' && r.catNo !== 'Included';
                  const stripe = i % 2 === 0 ? 'bg-raised' : 'bg-subtle';
                  return (
                    <tr key={i} className={`border-b border-line transition-colors ${stripe}${active?' hover:bg-warn-soft':' opacity-40'}`}>
                      <td className="px-3 py-2.5 text-fg-2 font-semibold">{r.label}</td>
                      <td className={`px-3 py-2.5 mono whitespace-nowrap${active?' text-fg':' text-fg-4'}`}>
                        <div className="flex items-center gap-1">
                          <span>{r.catNo}</span>
                          {active && <CopyBtn val={r.catNo} id={`cat-${i}`}/>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={active ? ycls + ' font-semibold' : 'text-fg-4'}>{r.qty || '—'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right mono whitespace-nowrap font-semibold text-fg-2">
                        {r.price > 0 ? f2(r.price) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-fg-2">{r.desc || '—'}</td>
                      <td className="px-3 py-2.5 text-fg-3 whitespace-nowrap">{r.productId || '—'}</td>
                      <td className="px-3 py-2.5 text-fg-3 hidden lg:table-cell whitespace-nowrap">{r.cabType || '—'}</td>
                      <td className="px-3 py-2.5 mono text-fg-3 text-2xs hidden xl:table-cell whitespace-nowrap">{r.dims || '—'}</td>
                      <td className="px-3 py-2.5 text-fg-3 hidden xl:table-cell whitespace-nowrap">{r.weight || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-term text-on-accent">
                  <td colSpan={3} className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-right">System Total Cost</td>
                  <td className="px-3 py-2.5 text-right font-semibold mono whitespace-nowrap text-ok">
                    <div className="flex items-center justify-end gap-1">
                      {f2(cfg.total)}
                      <CopyBtn val={cfg.total.toFixed(2)} id="total"/>
                    </div>
                  </td>
                  <td colSpan={5}/>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
