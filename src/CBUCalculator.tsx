import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, ChevronDown, Copy, Check } from 'lucide-react';

import { DATA, SALESMEN, SIZES_1PH, SIZES_3PH } from './lib/cbuData';

const f2 = (n:number) => `£${n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

// ── Dropdown component ────────────────────────────────────────────────────────
const DropdownClose = React.createContext<()=>void>(()=>{});

function Dropdown({label,value,placeholder,children,required}:{label:string;value:string;placeholder:string;children:React.ReactNode;required?:boolean}) {
  const [open,setOpen] = useState(false);
  const ref        = useRef<HTMLDivElement>(null);
  const btnRef     = useRef<HTMLButtonElement>(null);
  const dropRef    = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({top:0,left:0,width:0});

  const close = () => setOpen(false);

  useEffect(()=>{
    const h=(e:MouseEvent)=>{
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown',h);
    return ()=>document.removeEventListener('mousedown',h);
  },[]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: Math.max(r.width, 220) });
    }
    setOpen(v=>!v);
  };

  return (
    <DropdownClose.Provider value={close}>
      <div ref={ref} className="relative">
        <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-wide mb-1">
          {label}{required&&<span className="text-red-400 ml-0.5">*</span>}
        </label>
        <button ref={btnRef} onClick={handleOpen}
          className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:border-blue-400 transition-all text-left${open?' border-blue-400 ring-2 ring-blue-100 dark:ring-blue-900/30':''}`}>
          <span className={value?'font-semibold text-zinc-900 dark:text-white':'text-zinc-400'}>{value||placeholder}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform shrink-0 ml-1${open?' rotate-180':''}`}/>
        </button>
        {open && createPortal(
          <div ref={dropRef} style={{position:'absolute', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999}}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-auto max-h-80">
            {children}
          </div>,
          document.body
        )}
      </div>
    </DropdownClose.Provider>
  );
}

// Item inside a Dropdown — calls close via context then runs onClick
function DItem({onClick,active,children}:{onClick:()=>void;active:boolean;children:React.ReactNode}) {
  const close = React.useContext(DropdownClose);
  return (
    <button onClick={()=>{ onClick(); close(); }}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors${active?' bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 font-semibold':''}`}>
      {children}
    </button>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function CBUCalculator() {
  const [size,  setSize]   = useState('');
  const [pn,    setPN]     = useState('');
  const [qr,    setQR]     = useState('');
  const [smIdx, setSmIdx]  = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const cfg = size ? DATA[size] : null;
  const sm  = smIdx !== null ? SALESMEN[smIdx] : null;
  const ok  = !!cfg && !!pn.trim() && !!qr.trim() && sm !== null;

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
          system:   size,
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
      a.download = `CBU_Tech_Brief_${qr.trim()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
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
          {loading ? 'Generating…' : ok ? 'Export CBU Tech Brief PDF' : 'Fill all fields to export'}
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
