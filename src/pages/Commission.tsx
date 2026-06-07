// ─── Commission Calculator — CG Line+ and Easicheck ──────────────────────────
import React, { useState } from 'react';
import { Printer, Copy, Check, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '../lib/cn';

// ── Calculation logic extracted from commission_calculators.xlsx formulas ─────
// CG Line+: day rate = Q2*1.05 = 896.28*1.05 = K2 = 941.094
const CG_DAY = 896.28 * 1.05;
const CG_MIN_NOTE = 766.50;

function cgTier(p: number) {
  if (p === 1)  return { label: '1 Panel',      pr: CG_DAY/1.25, lr: CG_DAY/175, sr: CG_DAY/2    };
  if (p <= 4)   return { label: '2–4 Panels',   pr: CG_DAY/1.5,  lr: CG_DAY/175, sr: CG_DAY/1.75 };
  if (p <= 9)   return { label: '5–9 Panels',   pr: CG_DAY/1.5,  lr: CG_DAY/175, sr: CG_DAY/1.5  };
  if (p <= 15)  return { label: '10–15 Panels', pr: CG_DAY/1.5,  lr: CG_DAY/175, sr: CG_DAY/1.25 };
  return null;
}

function calcCG(panels: number, lumis: number, sw: boolean, cl: boolean) {
  if (panels <= 0) return null;
  const t = cgTier(panels);
  if (!t) return null;
  const pt = panels * t.pr, lt = lumis * t.lr, st = sw ? t.sr : 0;
  const sub = pt + lt + st, clc = cl ? 75 : 0;
  return { tier: t, pt, lt, st, sub, clc, total: Math.max(sub, CG_DAY) + clc, capped: sub < CG_DAY };
}

// Easicheck: day rate = K2 = 896.17 (hardcoded in sheet)
const EC_DAY = 896.17;
const EC_MIN_NOTE = 695.00;

function ecTier(p: number) {
  if (p === 1)  return { label: '1 Panel',      pr: EC_DAY/2,   lr: EC_DAY/175, cr: 0,      sr: EC_DAY/2    };
  if (p <= 4)   return { label: '2–4 Panels',   pr: EC_DAY/2,   lr: EC_DAY/175, cr: 150,    sr: EC_DAY/1.25 };
  if (p <= 9)   return { label: '5–9 Panels',   pr: 384.90,     lr: 3.57,       cr: 124.16, sr: EC_DAY/1    };
  if (p <= 15)  return { label: '10–15 Panels', pr: 446.98,     lr: 3.57,       cr: 124.16, sr: EC_DAY/0.75 };
  return         { label: '16+ Panels',   pr: 542.01,     lr: 3.57,       cr: 124.16, sr: EC_DAY/0.5  };
}

function calcEC(panels: number, lumis: number, cards: number, sw: boolean, cl: boolean) {
  if (panels <= 0) return null;
  const t = ecTier(panels);
  const pt = panels * t.pr, lt = lumis * t.lr, ct = t.cr > 0 ? cards * t.cr : 0, st = sw ? t.sr : 0;
  const sub = pt + lt + ct + st, clc = cl ? 75 : 0;
  return { tier: t, pt, lt, ct, st, sub, clc, total: Math.max(sub, EC_DAY) + clc, capped: sub < EC_DAY };
}

const gbp = (n: number) => '£' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── Shared small components ───────────────────────────────────────────────────

function NumInput({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-[12px] text-ink-600 dark:text-ink-300 flex-1">{label}</label>
      <input
        type="number" min={0} value={value || ''}
        onChange={e => onChange(Math.max(0, parseInt(e.target.value) || 0))}
        placeholder="0"
        className="w-20 text-right text-[12.5px] font-mono bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-violet-400 text-ink-800 dark:text-ink-100 placeholder:text-ink-400"
      />
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-[12px] text-ink-600 dark:text-ink-300 flex-1">{label}</label>
      <button onClick={() => onChange(!value)}
        className={cn('relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400 focus:ring-offset-1', value ? 'bg-violet-600' : 'bg-ink-200 dark:bg-ink-700')}>
        <span className={cn('inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform', value ? 'translate-x-4' : 'translate-x-1')} />
      </button>
    </div>
  );
}

function RRow({ label, value, dim = false, bold = false }: { label: string; value: string; dim?: boolean; bold?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-1 border-b border-ink-100 dark:border-ink-800 last:border-0', dim && 'opacity-35')}>
      <span className={cn('text-[12px]', bold ? 'font-semibold text-ink-800 dark:text-ink-100' : 'text-ink-600 dark:text-ink-300')}>{label}</span>
      <span className={cn('text-[12.5px] font-mono', bold ? 'font-bold text-ink-900 dark:text-ink-50' : 'text-ink-700 dark:text-ink-200')}>{value}</span>
    </div>
  );
}

// ── CG Line+ Calculator ───────────────────────────────────────────────────────

function CGLineCalc() {
  const [panels, setPanels] = useState(0);
  const [lumis, setLumis]   = useState(0);
  const [sw, setSw]         = useState(false);
  const [cl, setCl]         = useState(false);
  const [ref, setRef]       = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');
  const [copied, setCopied]       = useState(false);

  const result = calcCG(panels, lumis, sw, cl);
  const t = panels > 0 ? cgTier(panels) : null;
  const overMax = panels > 15;

  async function exportPdf() {
    setExporting(true); setExportErr('');
    try {
      const r = await fetch('/api/run/commission', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'cg', panels, lumis, cards: 0, software: sw ? 'yes' : 'no', centralLondon: cl ? 'yes' : 'no' }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Server error');
      const dl = await fetch(`/api/download/commission/${json.id}`);
      if (!dl.ok) throw new Error('Download failed');
      const blob = await dl.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ref.trim() ? `Commission_CG_${ref.trim()}.pdf` : 'Commission_CGLine.pdf';
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e: any) { setExportErr(e.message || 'Export failed'); }
    finally { setExporting(false); }
  }

  function copyText() {
    if (!result || !t) return;
    const lines = [
      'CG Line+ Commissioning Calculation',
      `Tier: ${result.tier.label}`,
      '',
      `Panels (${panels} × ${gbp(t.pr)}):  ${gbp(result.pt)}`,
      `Luminaires (${lumis} × ${gbp(t.lr)}):  ${gbp(result.lt)}`,
      sw ? `CG Vision PC Software:  ${gbp(result.st)}` : null,
      cl ? `Central London surcharge:  £75.00` : null,
      '',
      `Sub-Total:  ${gbp(result.sub)}`,
      result.capped ? `(Minimum day rate applied: ${gbp(CG_DAY)})` : null,
      '',
      `TOTAL COMMISSIONING VALUE:  ${gbp(result.total)}  (ex VAT)`,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(lines).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* ── Inputs ── */}
      <div className="bg-white dark:bg-ink-900 rounded-xl ring-1 ring-ink-200 dark:ring-ink-700 p-5 space-y-3.5">
        <p className="text-[10.5px] font-semibold text-ink-400 dark:text-ink-500 uppercase tracking-widest">Inputs</p>
        <NumInput label="Number of panels" value={panels} onChange={setPanels} />
        <NumInput label="Number of luminaires" value={lumis} onChange={setLumis} />
        <Toggle label="Include CG Vision PC Software" value={sw} onChange={setSw} />
        <Toggle label="Central London site" value={cl} onChange={setCl} />
        <div className="pt-1 border-t border-ink-100 dark:border-ink-800">
          <input type="text" placeholder="Reference (optional)" value={ref} onChange={e => setRef(e.target.value)}
            className="w-full text-[12px] bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-400 text-ink-700 dark:text-ink-200 placeholder:text-ink-400" />
        </div>
        <div className="flex gap-2 pt-0.5">
          <button onClick={exportPdf} disabled={!result || exporting || overMax}
            className={cn('flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-semibold transition-colors',
              result && !exporting && !overMax ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'bg-ink-100 dark:bg-ink-800 text-ink-400 cursor-not-allowed')}>
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
            {exporting ? 'Generating…' : 'Export PDF'}
          </button>
          <button onClick={copyText} disabled={!result}
            className={cn('flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold transition-colors ring-1 ring-inset',
              result ? 'bg-white dark:bg-ink-800 ring-ink-200 dark:ring-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700' : 'bg-ink-50 dark:bg-ink-900 ring-ink-100 dark:ring-ink-800 text-ink-300 cursor-not-allowed')}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {exportErr && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200 dark:ring-red-700/40">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] text-red-700 dark:text-red-300">{exportErr}</p>
          </div>
        )}
        {overMax && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-700/40">
            <AlertCircle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] text-amber-700 dark:text-amber-300">CG Line+ calculator covers up to 15 panels. Contact the service team for larger installations.</p>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      <div className="bg-white dark:bg-ink-900 rounded-xl ring-1 ring-ink-200 dark:ring-ink-700 p-5">
        <p className="text-[10.5px] font-semibold text-ink-400 dark:text-ink-500 uppercase tracking-widest mb-3">Breakdown</p>
        {!result ? (
          <div className="flex items-center justify-center h-40">
            <p className="text-[12px] text-ink-400">Enter panel count to calculate.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 px-2.5 py-1 bg-violet-50 dark:bg-violet-900/20 rounded-lg">
              <span className="text-[11px] font-semibold text-violet-600 dark:text-violet-300">Tier: {result.tier.label}</span>
            </div>
            <div className="space-y-0">
              <RRow label={`Panels  ${panels} × ${gbp(t!.pr)}`}    value={gbp(result.pt)} />
              <RRow label={`Luminaires  ${lumis} × ${gbp(t!.lr)}`} value={gbp(result.lt)} dim={lumis === 0} />
              <RRow label="CG Vision PC Software" value={sw ? gbp(result.st) : '—'} dim={!sw} />
              <RRow label="Central London"         value={cl ? gbp(result.clc) : '—'} dim={!cl} />
            </div>
            <div className="mt-2 pt-2 border-t border-ink-200 dark:border-ink-700 space-y-0">
              <RRow label="Sub-Total" value={gbp(result.sub)} bold />
              {result.capped && <p className="text-[10.5px] text-amber-600 dark:text-amber-400 py-1">Minimum day rate applied ({gbp(CG_DAY)})</p>}
            </div>
            <div className="mt-3 pt-3 border-t-2 border-violet-200 dark:border-violet-700/50 flex items-end justify-between">
              <div>
                <p className="text-[12px] font-semibold text-ink-700 dark:text-ink-200">Total Commissioning Value</p>
                <p className="text-[10px] text-ink-400 mt-0.5">Ex VAT · Min. {gbp(CG_MIN_NOTE)}</p>
              </div>
              <span className="text-[20px] font-bold text-violet-600 dark:text-violet-400 num">{gbp(result.total)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Easicheck Calculator ──────────────────────────────────────────────────────

function EasicheckCalc() {
  const [panels, setPanels] = useState(0);
  const [lumis, setLumis]   = useState(0);
  const [cards, setCards]   = useState(0);
  const [sw, setSw]         = useState(false);
  const [cl, setCl]         = useState(false);
  const [ref, setRef]       = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');
  const [copied, setCopied]       = useState(false);

  const result = calcEC(panels, lumis, cards, sw, cl);
  const t = panels > 0 ? ecTier(panels) : null;
  const showCards = t !== null && t.cr > 0;

  async function exportPdf() {
    setExporting(true); setExportErr('');
    try {
      const r = await fetch('/api/run/commission', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'easicheck', panels, lumis, cards, software: sw ? 'yes' : 'no', centralLondon: cl ? 'yes' : 'no' }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Server error');
      const dl = await fetch(`/api/download/commission/${json.id}`);
      if (!dl.ok) throw new Error('Download failed');
      const blob = await dl.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ref.trim() ? `Commission_Easicheck_${ref.trim()}.pdf` : 'Commission_Easicheck.pdf';
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e: any) { setExportErr(e.message || 'Export failed'); }
    finally { setExporting(false); }
  }

  function copyText() {
    if (!result || !t) return;
    const lines = [
      'Easicheck Commissioning Calculation',
      `Tier: ${result.tier.label}`,
      '',
      `Panels (${panels} × ${gbp(t.pr)}):  ${gbp(result.pt)}`,
      `Luminaires (${lumis} × ${gbp(t.lr)}):  ${gbp(result.lt)}`,
      t.cr > 0 ? `Network Cards (${cards} × ${gbp(t.cr)}):  ${gbp(result.ct)}` : null,
      sw ? `PC Software:  ${gbp(result.st)}` : null,
      cl ? `Central London surcharge:  £75.00` : null,
      '',
      `Sub-Total:  ${gbp(result.sub)}`,
      result.capped ? `(Minimum day rate applied: ${gbp(EC_DAY)})` : null,
      '',
      `TOTAL COMMISSIONING VALUE:  ${gbp(result.total)}  (ex VAT)`,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(lines).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* ── Inputs ── */}
      <div className="bg-white dark:bg-ink-900 rounded-xl ring-1 ring-ink-200 dark:ring-ink-700 p-5 space-y-3.5">
        <p className="text-[10.5px] font-semibold text-ink-400 dark:text-ink-500 uppercase tracking-widest">Inputs</p>
        <NumInput label="Number of panels" value={panels} onChange={setPanels} />
        <NumInput label="Number of luminaries" value={lumis} onChange={setLumis} />
        <NumInput label="Number of network cards" value={cards} onChange={setCards} />
        <Toggle label="Include PC Software" value={sw} onChange={setSw} />
        <Toggle label="Central London site" value={cl} onChange={setCl} />
        <div className="pt-1 border-t border-ink-100 dark:border-ink-800">
          <input type="text" placeholder="Reference (optional)" value={ref} onChange={e => setRef(e.target.value)}
            className="w-full text-[12px] bg-ink-50 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-400 text-ink-700 dark:text-ink-200 placeholder:text-ink-400" />
        </div>
        <div className="flex gap-2 pt-0.5">
          <button onClick={exportPdf} disabled={!result || exporting}
            className={cn('flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-semibold transition-colors',
              result && !exporting ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'bg-ink-100 dark:bg-ink-800 text-ink-400 cursor-not-allowed')}>
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
            {exporting ? 'Generating…' : 'Export PDF'}
          </button>
          <button onClick={copyText} disabled={!result}
            className={cn('flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold transition-colors ring-1 ring-inset',
              result ? 'bg-white dark:bg-ink-800 ring-ink-200 dark:ring-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700' : 'bg-ink-50 dark:bg-ink-900 ring-ink-100 dark:ring-ink-800 text-ink-300 cursor-not-allowed')}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        {exportErr && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200 dark:ring-red-700/40">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
            <p className="text-[11.5px] text-red-700 dark:text-red-300">{exportErr}</p>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      <div className="bg-white dark:bg-ink-900 rounded-xl ring-1 ring-ink-200 dark:ring-ink-700 p-5">
        <p className="text-[10.5px] font-semibold text-ink-400 dark:text-ink-500 uppercase tracking-widest mb-3">Breakdown</p>
        {!result ? (
          <div className="flex items-center justify-center h-40">
            <p className="text-[12px] text-ink-400">Enter panel count to calculate.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 px-2.5 py-1 bg-violet-50 dark:bg-violet-900/20 rounded-lg">
              <span className="text-[11px] font-semibold text-violet-600 dark:text-violet-300">Tier: {result.tier.label}</span>
            </div>
            <div className="space-y-0">
              <RRow label={`Panels  ${panels} × ${gbp(t!.pr)}`}    value={gbp(result.pt)} />
              <RRow label={`Luminaries  ${lumis} × ${gbp(t!.lr)}`} value={gbp(result.lt)} dim={lumis === 0} />
              <RRow label={`Network Cards  ${showCards ? `${cards} × ${gbp(t!.cr)}` : '(1-panel tier)'}`} value={showCards ? gbp(result.ct) : '—'} dim={!showCards} />
              <RRow label="PC Software" value={sw ? gbp(result.st) : '—'} dim={!sw} />
              <RRow label="Central London" value={cl ? gbp(result.clc) : '—'} dim={!cl} />
            </div>
            <div className="mt-2 pt-2 border-t border-ink-200 dark:border-ink-700 space-y-0">
              <RRow label="Sub-Total" value={gbp(result.sub)} bold />
              {result.capped && <p className="text-[10.5px] text-amber-600 dark:text-amber-400 py-1">Minimum day rate applied ({gbp(EC_DAY)})</p>}
            </div>
            <div className="mt-3 pt-3 border-t-2 border-violet-200 dark:border-violet-700/50 flex items-end justify-between">
              <div>
                <p className="text-[12px] font-semibold text-ink-700 dark:text-ink-200">Total Commissioning Value</p>
                <p className="text-[10px] text-ink-400 mt-0.5">Ex VAT · Min. {gbp(EC_MIN_NOTE)}</p>
              </div>
              <span className="text-[20px] font-bold text-violet-600 dark:text-violet-400 num">{gbp(result.total)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CommissionPage() {
  const [tab, setTab] = useState<'cg' | 'easicheck'>('cg');
  return (
    <div className="space-y-5">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 bg-ink-100 dark:bg-ink-800 rounded-xl p-1 w-fit">
        {(['cg', 'easicheck'] as const).map(id => (
          <button key={id} onClick={() => setTab(id)}
            className={cn(
              'px-4 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all',
              tab === id
                ? 'bg-white dark:bg-ink-900 text-ink-900 dark:text-ink-50 shadow-sm'
                : 'text-ink-500 dark:text-ink-400 hover:text-ink-700 dark:hover:text-ink-200'
            )}>
            {id === 'cg' ? 'CG Line+' : 'Easicheck'}
          </button>
        ))}
      </div>

      {/* Calculator */}
      {tab === 'cg' ? <CGLineCalc /> : <EasicheckCalc />}

      {/* Day rate info footer */}
      <div className="text-[10.5px] text-ink-400 dark:text-ink-500 space-y-0.5">
        {tab === 'cg'
          ? <p>CG Line+ base day rate: {gbp(CG_DAY)} (inc. cover) · Standard: {gbp(896.28)} · Central London +£75</p>
          : <p>Easicheck base day rate: {gbp(EC_DAY)} · Central London +£75 · Min. commission: {gbp(EC_MIN_NOTE)}</p>
        }
        <p>All prices are list prices ex VAT. Source: commission_calculators.xlsx</p>
      </div>
    </div>
  );
}
