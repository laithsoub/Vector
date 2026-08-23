// ─── Quick Quote — Inbox proposal generator (CBU BOM + luminaires → PDF) ──────
import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Plus, Trash2, FileDown, Cpu, Lightbulb, Wrench, RefreshCw, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import { fmtGBP } from '../lib/ui';
import { DATA, SALESMEN, SIZES_1PH, SIZES_3PH } from '../lib/cbuData';
import { extractMaterialHints } from '../lib/elHints';
import { openExternal } from '../lib/shell';
import type { ToastFn } from '../App';

type Src = 'cbu' | 'lum' | 'manual';
interface Line { id: number; catNo: string; product: string; description: string; qty: number; price: number; src: Src }

let _lid = 1;
const nid = () => _lid++;
const ALL_SYSTEMS = [...SIZES_1PH, ...SIZES_3PH];
const todayUK = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const gbp = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// CBU BOM rows worth quoting: real parts with qty (drop empty/N-A placeholder lines).
function cbuLines(system: string): Line[] {
  const cfg = DATA[system];
  if (!cfg) return [];
  return cfg.rows
    .filter(r => r.qty > 0 && r.price > 0 && r.catNo && !['—', 'N/A'].includes(r.catNo))
    .map(r => ({ id: nid(), catNo: r.catNo, product: r.label || '', description: r.desc || r.label, qty: r.qty, price: r.price, src: 'cbu' as Src }));
}

// Match the email sender to a salesman (by email, then by name); fall back to first.
function matchSalesman(email?: string, name?: string): number {
  const e = (email || '').trim().toLowerCase();
  if (e) { const i = SALESMEN.findIndex(s => s.email.toLowerCase() === e); if (i >= 0) return i; }
  const n = (name || '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (n) {
    const i = SALESMEN.findIndex(s => {
      const sn = s.name.toLowerCase();
      return sn === n || sn.split(' ').every(t => n.includes(t));
    });
    if (i >= 0) return i;
  }
  return 0;
}

export function QuickQuotePanel({ emailSubject, emailBody, senderName, senderEmail, toast }: {
  emailSubject: string; emailBody: string; senderName?: string; senderEmail?: string; toast: ToastFn;
}) {
  const [quoteName, setQuoteName] = useState(emailSubject || '');   // Job name
  const [quoteNumber, setQuoteNumber] = useState('');               // Job number
  const [quoteNo, setQuoteNo] = useState('');                       // Quotation No (EU1L…)
  const [date, setDate] = useState(todayUK());
  const [smIdx, setSmIdx] = useState(() => matchSalesman(senderEmail, senderName));
  const [system, setSystem] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [appendComm, setAppendComm] = useState(false);
  const [appendTC, setAppendTC] = useState(false);   // base template already carries T&C pages
  const didInit = useRef(false);

  function setSystemLines(sys: string) {
    setLines(prev => [...cbuLines(sys), ...prev.filter(l => l.src !== 'cbu')]);
  }

  async function detectCbu() {
    setDetecting(true);
    try {
      const r = await api.quoteDetectCbu(emailBody, ALL_SYSTEMS);
      if (r.system) { setSystem(r.system); setSystemLines(r.system); toast('info', `Detected ${r.system} in the email — its BOM has been added`); }
    } catch {}
    setDetecting(false);
  }
  async function pullLuminaires() {
    setPulling(true);
    try {
      const hints = extractMaterialHints(emailBody);
      const r = await api.quoteLuminaires(hints.trim() ? hints : emailBody);
      const lum: Line[] = (r.items || []).map((it: any) => ({ id: nid(), catNo: it.catNo || '', product: it.product || '', description: it.description || '', qty: it.qty || 1, price: it.price || 0, src: 'lum' as Src }));
      setLines(prev => [...prev.filter(l => l.src !== 'lum'), ...lum]);
      toast(lum.length ? 'ok' : 'info', lum.length ? `Added ${plural(lum.length, 'luminaire line')} from the email` : 'No priced luminaires were found in the email');
    } catch (e: any) { toast('err', failed('pull the luminaires from the email', e)); }
    setPulling(false);
  }

  // On first open: auto-detect CBU + pull luminaires.
  useEffect(() => { if (didInit.current) return; didInit.current = true; detectCbu(); pullLuminaires(); }, []); // eslint-disable-line

  const upd = (id: number, patch: Partial<Line>) => setLines(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  const del = (id: number) => setLines(prev => prev.filter(l => l.id !== id));
  const addManual = () => setLines(prev => [...prev, { id: nid(), catNo: '', product: '', description: '', qty: 1, price: 0, src: 'manual' }]);
  const changeSystem = (sys: string) => { setSystem(sys); setSystemLines(sys); };

  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);

  async function generate() {
    if (lines.length === 0) { toast('warn', 'Add at least one line before generating the quote'); return; }
    setGenerating(true);
    try {
      const sm = SALESMEN[smIdx];
      const r = await api.quoteGenerate({
        header: { quoteName, quoteNumber, quoteNo, date, salesman: { name: sm.name, email: sm.email, phone: sm.phone } },
        lines: lines.map((l, i) => ({ itemNo: String((i + 1) * 10).padStart(3, '0'), catNo: l.catNo, product: l.product, description: l.description, qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
        appendComm, appendTC,
      });
      if (r.error || !r.id) { toast('err', failed('build the quote PDF', r.error)); }
      else { void openExternal(`/api/download/quote/${r.id}`); toast('ok', `Quote PDF ready — ${plural(lines.length, 'line')}, ${fmtGBP(total)}`); }
    } catch (e: any) { toast('err', failed('build the quote PDF', e)); }
    setGenerating(false);
  }

  const srcTag: Record<Src, { t: string; c: string; Icon: any }> = {
    cbu:    { t: 'CBU',       c: 'text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/25',       Icon: Cpu },
    lum:    { t: 'Luminaire', c: 'text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/25',   Icon: Lightbulb },
    manual: { t: 'Manual',    c: 'text-[var(--t3)] bg-[var(--s3)]',             Icon: Wrench },
  };
  const inp = 'h-7 px-2 rounded-md text-[11.5px] bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)] focus:outline-none focus:ring-violet-400 text-[var(--t1)]';

  return (
    <div className="px-5 py-3 space-y-3">
      {/* Header fields */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">Job name</span>
          <input value={quoteName} onChange={e => setQuoteName(e.target.value)} className={inp} /></label>
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">Job number</span>
          <input value={quoteNumber} onChange={e => setQuoteNumber(e.target.value)} placeholder="CR00…" className={inp} /></label>
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">Quotation No</span>
          <input value={quoteNo} onChange={e => setQuoteNo(e.target.value)} placeholder="EU1L… (optional)" className={inp} /></label>
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">Date</span>
          <input value={date} onChange={e => setDate(e.target.value)} className={inp} /></label>
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">Salesman</span>
          <select value={smIdx} onChange={e => setSmIdx(Number(e.target.value))} className={inp}>
            {SALESMEN.map((s, i) => <option key={s.email} value={i}>{s.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-0.5"><span className="text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">CBU system</span>
          <div className="relative">
            <select value={system} onChange={e => changeSystem(e.target.value)} className={cn(inp, 'w-full appearance-none pr-6')}>
              <option value="">{detecting ? 'Detecting…' : 'None'}</option>
              {ALL_SYSTEMS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ChevronDown className="w-3 h-3 absolute right-2 top-2 text-[var(--t3)] pointer-events-none" />
          </div></label>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={detectCbu} disabled={detecting}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-[var(--s3)] disabled:opacity-50">
          {detecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cpu className="w-3 h-3" />} Detect CBU
        </button>
        <button onClick={pullLuminaires} disabled={pulling}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-[var(--s3)] disabled:opacity-50">
          {pulling ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Pull luminaires
        </button>
        <button onClick={addManual}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-[var(--s3)]">
          <Plus className="w-3 h-3" /> Add line
        </button>
      </div>

      {/* Line items */}
      <div className="rounded-lg ring-1 ring-inset ring-[var(--line-2)] overflow-hidden">
        <div className="grid grid-cols-[68px_84px_1fr_40px_76px_80px_22px] gap-1 px-2 py-1.5 bg-[var(--s3)] text-[10px] font-semibold text-[var(--t3)] uppercase tracking-wide">
          <span>Catalog No</span><span>Product</span><span>Description</span><span className="text-center">Qty</span><span className="text-right">Unit £</span><span className="text-right">Line £</span><span />
        </div>
        {lines.length === 0 && <p className="px-3 py-4 text-[11.5px] text-[var(--t3)] text-center">No lines yet — detect a CBU, pull luminaires, or add a line.</p>}
        {lines.map(l => {
          const tag = srcTag[l.src];
          return (
            <div key={l.id} className="grid grid-cols-[68px_84px_1fr_40px_76px_80px_22px] gap-1 px-2 py-1 items-center border-t border-[var(--line)]">
              <input value={l.catNo} onChange={e => upd(l.id, { catNo: e.target.value })} className={cn(inp, 'w-full !h-6 !px-1.5 !text-[10.5px]')} />
              <input value={l.product} onChange={e => upd(l.id, { product: e.target.value })} className={cn(inp, 'w-full !h-6 !px-1.5 !text-[10.5px]')} />
              <div className="flex items-center gap-1 min-w-0">
                <span className={cn('shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium', tag.c)}><tag.Icon className="w-2.5 h-2.5" /></span>
                <input value={l.description} onChange={e => upd(l.id, { description: e.target.value })} className={cn(inp, 'w-full !h-6 !px-1.5 !text-[10.5px]')} />
              </div>
              <input type="number" value={l.qty} onChange={e => upd(l.id, { qty: Number(e.target.value) })} className={cn(inp, 'w-full !h-6 !px-1 !text-[10.5px] text-center')} />
              <input type="number" step="0.01" value={l.price} onChange={e => upd(l.id, { price: Number(e.target.value) })} className={cn(inp, 'w-full !h-6 !px-1 !text-[10.5px] text-right')} />
              <span className="text-[10.5px] text-right text-[var(--t2)] tabular-nums">{gbp((Number(l.qty) || 0) * (Number(l.price) || 0))}</span>
              <button aria-label="Delete this line" onClick={() => del(l.id)} className="w-5 h-5 flex items-center justify-center text-[var(--t4)] hover:text-red-500 transition-colors"><Trash2 className="w-3 h-3" /></button>
            </div>
          );
        })}
        <div className="flex items-center justify-end gap-4 px-3 py-1.5 border-t border-[var(--line-2)] bg-[var(--s3)]">
          <span className="text-[11px] font-semibold text-[var(--t3)] uppercase tracking-wide">Total (list, ex-VAT)</span>
          <span className="text-[13px] font-bold text-[var(--t1)] tabular-nums">{gbp(total)}</span>
        </div>
      </div>

      {/* Generate */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--t2)] cursor-pointer select-none">
          <input type="checkbox" checked={appendComm} onChange={e => setAppendComm(e.target.checked)} className="accent-violet-600" />
          Commissioning
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--t2)] cursor-pointer select-none">
          <input type="checkbox" checked={appendTC} onChange={e => setAppendTC(e.target.checked)} className="accent-violet-600" />
          T&amp;C
        </label>
        <button onClick={generate} disabled={generating || lines.length === 0}
          className="ml-auto inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors">
          {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />} {generating ? 'Building…' : 'Generate quote PDF'}
        </button>
      </div>
    </div>
  );
}
