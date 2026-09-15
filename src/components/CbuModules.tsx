// ─── Inverter modules (CBU Sizer → Modules) ──────────────────────────────────
// The LoadStar inverter modules that ship as-is: a part code and a price, no
// configuring. Its own view rather than entries in the sizer's system list,
// because there is no BoM, no battery sizing and no Tech Brief behind them.
//
// Quantities are here because quoting one of these IS the qty × price sum, and
// the sizer's BoM table already reads that way. They are scratch — nothing is
// stored — so the tab opens clean every time.
import React, { useMemo, useState } from 'react';
import { Copy, Check, Info } from 'lucide-react';

import { INVERTER_MODULES, MODULES_PRICED, type InverterModule } from '../lib/inverterModules';

const f2 = (n: number) =>
  `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const niceDate = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const ROLE_LABEL: Record<InverterModule['role'], string> = {
  standalone: 'Standalone',
  master:     'Master',
  slave:      'Slave',
};

export default function CbuModules() {
  const [qty,    setQty]    = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [phase,  setPhase]  = useState<'all' | '1PH' | '3PH'>('all');

  const rows = useMemo(
    () => INVERTER_MODULES.filter(m => phase === 'all' || m.phase === phase),
    [phase]);

  const total = useMemo(
    () => INVERTER_MODULES.reduce((sum, m) => sum + (qty[m.code] || 0) * m.price, 0),
    [qty]);
  const lines = INVERTER_MODULES.filter(m => (qty[m.code] || 0) > 0);
  // The filter narrows the table, never the quote: a quantity typed under
  // "Single" still counts once "Three" is showing. Without saying so the footer
  // reads as a total with no rows behind it.
  const hiddenLines = phase === 'all' ? 0 : lines.filter(m => m.phase !== phase).length;

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
    });
  };

  const CopyBtn = ({ val, id, label }: { val: string; id: string; label: string }) => (
    <button aria-label={label} title={label} onClick={() => copy(val, id)}
      className="ml-1.5 p-0.5 rounded text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shrink-0">
      {copied === id ? <Check className="w-3 h-3 text-emerald-500"/> : <Copy className="w-3 h-3"/>}
    </button>
  );

  // Tab-separated, which is what Bidman and Excel both paste as columns.
  const copySelection = () => {
    const text = lines
      .map(m => [m.code, m.desc, qty[m.code], m.price.toFixed(2), ((qty[m.code] || 0) * m.price).toFixed(2)].join('\t'))
      .join('\n');
    copy(text, 'selection');
  };

  const ycls = 'bg-yellow-50 dark:bg-yellow-900/20 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-800 dark:text-zinc-100 rounded';

  const phaseBtn = (id: 'all' | '1PH' | '3PH', label: string) => (
    <button key={id} onClick={() => setPhase(id)}
      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all${
        phase === id
          ? ' bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm'
          : ' text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
      {label}
    </button>
  );

  return (
    <div className="space-y-3 max-w-5xl">

      {/* ── Title ────────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">LoadStar inverter modules</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            The systems that ship as-is — quoted on the part code, nothing to configure · price list of {niceDate(MODULES_PRICED)}
          </p>
        </div>
        <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-800 shrink-0">
          {phaseBtn('all', 'All')}
          {phaseBtn('1PH', 'Single')}
          {phaseBtn('3PH', 'Three')}
        </div>
      </div>

      {/* The sizer quotes Sell Out at 1.0; these are Nett Trade. Two bases on one
          quote is the mistake worth a permanent line on screen. */}
      <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2">
        <Info className="w-3.5 h-3.5 mt-px shrink-0"/>
        <span>
          These prices are <strong>Nett Trade</strong> — not the Sell Out basis the sizer's BoM uses. Do not mix the two on one quote.
          Master and slave modules pair up for a parallel system; the list carries no three-phase slave code, so check before quoting one.
        </span>
      </div>

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Part code</th>
                <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Description</th>
                <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide w-24 hidden sm:table-cell">Role</th>
                <th className="text-center px-3 py-3 text-xs font-bold uppercase tracking-wide w-20">Qty</th>
                <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wide">Nett Trade</th>
                <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wide">Line total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const n = qty[m.code] || 0;
                const stripe = i % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/50';
                return (
                  <tr key={m.code}
                    className={`border-b border-zinc-200 dark:border-zinc-700 transition-colors ${stripe}${n ? ' bg-yellow-50/60 dark:bg-yellow-900/10' : ' hover:bg-yellow-50/40 dark:hover:bg-yellow-900/5'}`}>
                    <td className="px-3 py-2.5 font-mono whitespace-nowrap text-zinc-900 dark:text-zinc-100 font-semibold">
                      <div className="flex items-center">
                        <span>{m.code}</span>
                        <CopyBtn val={m.code} id={`code-${m.code}`} label="Copy part code"/>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-300">
                      <div className="flex items-center">
                        <span>{m.desc}</span>
                        <CopyBtn val={m.desc} id={`desc-${m.code}`} label="Copy description"/>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 whitespace-nowrap hidden sm:table-cell">
                      {ROLE_LABEL[m.role]} · {m.phase === '1PH' ? 'Single' : 'Three'}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={n || ''} placeholder="0"
                        onChange={e => {
                          const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                          setQty(q => ({ ...q, [m.code]: v }));
                        }}
                        className="w-14 px-1.5 py-1 text-xs text-center rounded-lg border border-zinc-200 dark:border-zinc-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-zinc-100 focus:outline-none focus:border-blue-400 transition-colors font-semibold"/>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap font-semibold text-zinc-700 dark:text-zinc-200">
                      <div className="flex items-center justify-end">
                        {f2(m.price)}
                        <CopyBtn val={m.price.toFixed(2)} id={`price-${m.code}`} label="Copy price"/>
                      </div>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono whitespace-nowrap${n ? ' font-bold text-zinc-900 dark:text-zinc-100' : ' text-zinc-300 dark:text-zinc-600'}`}>
                      {n ? f2(n * m.price) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {lines.length > 0 && (
              <tfoot>
                <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                  <td colSpan={4} className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-right">
                    Total · {lines.length} line{lines.length === 1 ? '' : 's'}, Nett Trade
                    {hiddenLines > 0 && (
                      <span className="ml-1 normal-case font-semibold text-amber-300">
                        — {hiddenLines} hidden by the phase filter
                      </span>
                    )}
                  </td>
                  <td colSpan={2} className="px-3 py-2.5 text-right font-bold font-mono whitespace-nowrap text-emerald-300">
                    <div className="flex items-center justify-end gap-1">
                      {f2(total)}
                      <button aria-label="Copy total" title="Copy total" onClick={() => copy(total.toFixed(2), 'total')}
                        className="p-0.5 rounded text-zinc-300 hover:text-white transition-colors">
                        {copied === 'total' ? <Check className="w-3 h-3 text-emerald-300"/> : <Copy className="w-3 h-3"/>}
                      </button>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {lines.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-zinc-100 dark:border-zinc-800">
            <span className="text-[10px] text-zinc-400">
              Copies the quantified lines tab-separated — pastes into Bidman or Excel as columns.
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => setQty({})}
                className="px-2.5 py-1 rounded-lg text-[10px] font-bold text-zinc-500 dark:text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                Clear
              </button>
              <button onClick={copySelection}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white transition-all">
                {copied === 'selection' ? <Check className="w-3.5 h-3.5"/> : <Copy className="w-3.5 h-3.5"/>}
                {copied === 'selection' ? 'Copied' : 'Copy lines'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
