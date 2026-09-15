import React, { useState } from 'react';
import { Printer, Copy, Check } from 'lucide-react';

import { DATA, SIZES_1PH, SIZES_3PH } from './lib/cbuData';
import { useSalesmen } from './lib/salesmen';
import { Dropdown, DItem } from './components/Dropdown';

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

  const ycls = "bg-yellow-50 dark:bg-yellow-900/20 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-800 dark:text-zinc-100 rounded";

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
    <button aria-label="Copy" onClick={() => copy(val, id)} title="Copy"
      className="ml-1.5 p-0.5 rounded text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shrink-0">
      {copied === id
        ? <Check className="w-3 h-3 text-emerald-500"/>
        : <Copy className="w-3 h-3"/>}
    </button>
  );

  return (
    <div className="space-y-3 max-w-5xl">

      {/* ── Title + Export button ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">UK CSO Loadstar-PS Quote Configurator V3</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">Only edit yellow cells</p>
        </div>
        <button onClick={handleExport} disabled={!ok || loading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all${ok&&!loading?' bg-blue-600 hover:bg-blue-700 text-white':' bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'}`}>
          <Printer className="w-3.5 h-3.5"/>
          {loading
            ? `Generating${toPrint.length > 1 ? ` ${toPrint.length} briefs` : ''}…`
            : !ok ? 'Fill all fields to export'
            : toPrint.length > 1 ? `Export ${toPrint.length} systems + Commissioning + T&C`
            : 'Export CBU Tech Brief PDF'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2">
          {error}
        </div>
      )}

      {/* ── System / Build / Duration + Project info — all in one card ────────── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">

        {/* Row 1: System selector + auto fields */}
        <div className="grid grid-cols-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">System</div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Build</div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Duration (Hrs)</div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-zinc-100 dark:border-zinc-800">
          <Dropdown label="" value={size} placeholder="Select system…" required>
            <div className="px-3 pt-2 pb-1 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Single Phase</div>
            {SIZES_1PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
            <div className="px-3 pt-2 pb-1 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-t border-zinc-100 dark:border-zinc-700 mt-1">Three Phase</div>
            {SIZES_3PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
          </Dropdown>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.build || <span className="text-zinc-400">—</span>}</span>
            {cfg?.build && <CopyBtn val={cfg.build} id="build"/>}
          </div>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.duration || <span className="text-zinc-400">—</span>}</span>
            {cfg?.duration && <CopyBtn val={cfg.duration} id="duration"/>}
          </div>
        </div>

        {/* Row 1b: systems in this quote — one brief each, merged into one PDF */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
          <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mr-1">Systems in this quote</span>
          {systems.map((s, i) => (
            <span key={i}
              className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-semibold border${
                s === size
                  ? ' bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                  : ' bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200'}`}>
              <button onClick={() => setSize(s)} title="Show this system's BoM">{i + 1}. {s}</button>
              <button aria-label={`Remove ${s}`} title="Remove"
                onClick={() => setSystems(list => list.filter((_, j) => j !== i))}
                className="px-1 rounded text-zinc-400 hover:text-red-500">×</button>
            </span>
          ))}
          <button disabled={!cfg} onClick={() => setSystems(list => [...list, size])}
            className={`px-2 py-0.5 rounded-md text-[11px] font-bold border border-dashed${cfg
              ? ' border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
              : ' border-zinc-200 dark:border-zinc-700 text-zinc-400 cursor-not-allowed'}`}>
            + Add {cfg ? size : 'selected system'}
          </button>
          {systems.length > 0 && (
            <span className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              Quote total <span className="font-mono font-bold text-zinc-800 dark:text-zinc-100">{f2(quoteTotal)}</span>
              <CopyBtn val={quoteTotal.toFixed(2)} id="quote-total"/>
              <button onClick={() => setSystems([])} className="hover:text-red-500">Clear</button>
            </span>
          )}
          {systems.length === 0 && (
            <span className="text-[10px] text-zinc-400">Empty = export just the selected system. Each added system prints its own brief; Commissioning + T&C go once at the end.</span>
          )}
        </div>

        {/* Row 2: Project info */}
        <div className="grid grid-cols-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Project Title <span className="text-red-400">*</span></div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Quote Reference <span className="text-red-400">*</span></div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Sales Engineer <span className="text-red-400">*</span></div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-1">
            <input value={pn} onChange={e=>setPN(e.target.value)} placeholder="e.g. Heathrow T5"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-zinc-100 focus:outline-none focus:border-blue-400 transition-colors font-semibold"/>
            {pn && <CopyBtn val={pn} id="pn"/>}
          </div>
          <div className="flex items-center gap-1">
            <input value={qr} onChange={e=>setQR(e.target.value)} placeholder="e.g. QB28154"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-zinc-100 focus:outline-none focus:border-blue-400 transition-colors font-semibold"/>
            {qr && <CopyBtn val={qr} id="qr"/>}
          </div>
          <Dropdown label="" value={sm?.name||''} placeholder="Select engineer…" required>
            {SALESMEN.map((s,i)=>(
              <DItem key={s.name} onClick={()=>setSmIdx(i)} active={smIdx===i}>
                <div className="text-xs font-medium">{s.name}</div>
                <div className="text-[10px] text-zinc-400">{s.phone}</div>
              </DItem>
            ))}
          </Dropdown>
        </div>

        <div className="px-4 py-2 text-[10px] text-amber-600 dark:text-amber-400">
          * Ensure Unit prices are added to Bidman and correctly quantified. Pricing is Sell Out at 1.0 multiplier.
        </div>
      </div>

      {/* ── BoM table ────────────────────────────────────────────────────────── */}
      {cfg && (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide w-44">Item</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Catalogue #</th>
                  <th className="text-center px-3 py-3 text-xs font-bold uppercase tracking-wide w-12">Qty</th>
                  <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wide">Unit Price</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Description</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Product ID</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden lg:table-cell">Cabinet Type</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden xl:table-cell">H×W×D (mm)</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden xl:table-cell">Weight</th>
                </tr>
              </thead>
              <tbody>
                {cfg.rows.map((r,i)=>{
                  const active = r.qty > 0 && r.catNo !== 'N/A' && r.catNo !== '—' && r.catNo !== 'Included';
                  const stripe = i % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/50';
                  return (
                    <tr key={i} className={`border-b border-zinc-200 dark:border-zinc-700 transition-colors ${stripe}${active?' hover:bg-yellow-50/60 dark:hover:bg-yellow-900/10':' opacity-40'}`}>
                      <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400 font-semibold">{r.label}</td>
                      <td className={`px-3 py-2.5 font-mono whitespace-nowrap${active?' text-zinc-900 dark:text-zinc-100':' text-zinc-400'}`}>
                        <div className="flex items-center gap-1">
                          <span>{r.catNo}</span>
                          {active && <CopyBtn val={r.catNo} id={`cat-${i}`}/>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={active ? ycls + ' font-bold' : 'text-zinc-400'}>{r.qty || '—'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap font-semibold text-zinc-700 dark:text-zinc-200">
                        {r.price > 0 ? f2(r.price) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-300">{r.desc || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{r.productId || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 hidden lg:table-cell whitespace-nowrap">{r.cabType || '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-500 dark:text-zinc-400 text-[10px] hidden xl:table-cell whitespace-nowrap">{r.dims || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 hidden xl:table-cell whitespace-nowrap">{r.weight || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                  <td colSpan={3} className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-right">System Total Cost</td>
                  <td className="px-3 py-2.5 text-right font-bold font-mono whitespace-nowrap text-emerald-300">
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
