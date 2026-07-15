// ─── Schematics — Eaton EL Material Pricer (unified input) ───────────────────
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FileText, Sparkles, Copy, AlertTriangle, X, Loader2, ChevronDown, ChevronUp, RotateCcw, ClipboardList, History, Trash2, Image as ImageIcon, FileSpreadsheet, MoreHorizontal, Check, RefreshCw, Paperclip, Plus } from 'lucide-react';
import { Card, CardTitle, Button, fmtGBP } from '../lib/ui';
import { cn } from '../lib/cn';
import { runTask, isCancel } from '../lib/tasks';

interface PricedItem {
  ref:            string;
  cat_no:         string;
  description:    string;
  family:         string;
  qty:            number;
  list_price:     number;
  ntp:            number;
  line_ntp:       number;
  status:         string;
  matched:        boolean;
  match_type?:    'exact' | 'fuzzy' | 'description' | '';
  original_input?: string;
}

interface VisualCandidate {
  cat_no:        string;
  family:        string;
  description:   string;
  confidence:    'high' | 'medium' | 'low' | string;
  reasoning:     string;
  source_url:    string;
  matched:       boolean;
  list_price:    number | null;
  ntp:           number | null;
  status:        string | null;
  suggested_qty?: number;
}

interface PriceResult {
  items:           PricedItem[];
  unmatched:       string[];
  total_ntp:       number;
  source:          string;
  extracted_count: number;
  candidates?:     VisualCandidate[];
  inputs?:         { has_text: boolean; pdf_count: number; image_count: number; qty_hint: number };
  error?:          string;
}

interface Attachment {
  id:        string;
  file:      File;
  kind:      'pdf' | 'image' | 'excel';
  name:      string;
  size:      number;
  previewUrl?: string;   // for images only
}

interface RunEntry {
  id:             string;
  ts:             number;
  source:         'unified' | 'pdf' | 'list' | 'image';
  filename:       string;
  matchedCount:   number;
  unmatchedCount: number;
  totalNtp:       number;
  result:         PriceResult;
}

function round(n: number, d: number) { return Math.round(n * Math.pow(10, d)) / Math.pow(10, d); }

function loadCorrections(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('el_corrections') || '{}'); } catch { return {}; }
}
function saveCorrections(c: Record<string, string>) {
  localStorage.setItem('el_corrections', JSON.stringify(c));
}

function classifyAttachment(file: File): 'pdf' | 'image' | 'excel' | null {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (/spreadsheet|excel|ms-excel|csv/i.test(file.type) || /\.(xlsx?|xlsm|csv)$/i.test(file.name)) return 'excel';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name)) return 'image';
  return null;
}

function ItemMenu({
  item,
  onRetry,
}: {
  item: PricedItem;
  onRetry: (catNo: string) => void;
}) {
  const [open, setOpen]             = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [input, setInput]           = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setCorrecting(false); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function markCorrect() { setOpen(false); }

  function saveCorrection() {
    if (!input.trim()) return;
    const corrections = loadCorrections();
    corrections[item.original_input || item.cat_no] = input.trim().toUpperCase();
    saveCorrections(corrections);
    onRetry(input.trim());
    setCorrecting(false);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="Feedback on this match"
        className="w-5 h-5 rounded flex items-center justify-center text-amber-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-52 bg-white dark:bg-ink-900 rounded-lg shadow-lg ring-1 ring-inset ring-ink-200 dark:ring-ink-700 py-1 text-[12px]">
          {item.original_input && item.original_input !== item.cat_no && (
            <div className="px-3 py-1.5 border-b border-ink-100 dark:border-ink-800 text-[10.5px] text-ink-400">
              Input: <span className="font-mono text-ink-600 dark:text-ink-300">{item.original_input}</span>
              <br />Matched: <span className="font-mono text-brand-600 dark:text-brand-400">{item.cat_no}</span>
            </div>
          )}
          <button
            onClick={markCorrect}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-50 dark:hover:bg-ink-800 text-emerald-700 dark:text-emerald-400">
            <Check className="w-3.5 h-3.5" /> This match is correct
          </button>
          <button
            onClick={() => setCorrecting(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-200">
            <MoreHorizontal className="w-3.5 h-3.5" /> Wrong — enter correct catalogue no
          </button>
          <button
            onClick={() => { onRetry(item.original_input || item.cat_no); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-200">
            <RefreshCw className="w-3.5 h-3.5" /> Try again with original
          </button>
          {correcting && (
            <div className="px-3 py-2 border-t border-ink-100 dark:border-ink-800 flex gap-1.5">
              <input
                autoFocus
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveCorrection(); if (e.key === 'Escape') setCorrecting(false); }}
                placeholder="e.g. IP65LEDCGS"
                className="flex-1 h-7 px-2 rounded bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-[11.5px] font-mono focus:outline-none focus:ring-brand-400"
              />
              <button onClick={saveCorrection} className="h-7 px-2 rounded bg-brand-600 text-white text-[11px] hover:bg-brand-700">Save</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function buildEmailText(result: PriceResult, projectName: string): string {
  const matched = result.items.filter(i => i.matched);
  const lines = [
    `Project: ${projectName || 'Emergency Lighting — Material Schedule'}`,
    `Date: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`,
    `Price list: Eaton EL Global Price List Jul 2026`,
    ``,
    `MATERIAL SCHEDULE — EATON EMERGENCY LIGHTING`,
    `${'─'.repeat(70)}`,
    `${'Ref'.padEnd(8)} ${'Catalogue No'.padEnd(18)} ${'Description'.padEnd(36)} ${'Qty'.padStart(4)} ${'NTP/Unit'.padStart(10)}`,
    `${'─'.repeat(70)}`,
    ...matched.map(i =>
      `${(i.ref || '').padEnd(8)} ${i.cat_no.padEnd(18)} ${i.description.slice(0, 35).padEnd(36)} ${String(i.qty).padStart(4)} ${fmtGBP(i.ntp).padStart(10)}`
    ),
    `${'─'.repeat(70)}`,
  ];

  if (result.unmatched.length > 0) {
    lines.push('', `Items not found in price list: ${result.unmatched.join(', ')}`);
  }

  lines.push(
    '',
    'Prices shown are Net Trade Price (NTP) from Eaton EL Global Price List Jul 2026.',
    'All prices ex VAT. Subject to confirmation.',
  );

  return lines.join('\n');
}

// One line in the live read-out: item number → catalogue + description → price.
// The row fades up; the price fades in a beat later; the in-flight row breathes.
function ProgressRow({ idx, item, active }: { idx: number; item: PricedItem; active?: boolean }) {
  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2 rounded-lg animate-fade-up',
      active
        ? 'bg-brand-50/60 dark:bg-brand-900/10 ring-1 ring-inset ring-brand-200/60 dark:ring-brand-700/30 animate-soft-pulse'
        : 'bg-ink-50/50 dark:bg-ink-900/30',
    )}>
      <span className="w-6 shrink-0 text-right font-mono text-[11px] text-ink-400 tabular-nums">{idx}</span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[11.5px] font-semibold text-brand-700 dark:text-brand-400 truncate">
          {item.cat_no || '—'}
        </p>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 truncate">
          {item.description || (item.matched ? '' : 'not found in price list')}
        </p>
      </div>
      {item.qty > 1 && (
        <span className="shrink-0 text-[10.5px] text-ink-400 tabular-nums">×{item.qty}</span>
      )}
      <div className="shrink-0 text-right animate-fade-in" style={{ animationDelay: '120ms' }}>
        {item.matched
          ? <span className="font-mono text-[12px] font-semibold text-ink-800 dark:text-ink-100 tabular-nums">{fmtGBP(item.ntp)}</span>
          : <span className="text-[10.5px] text-amber-500">no price</span>}
      </div>
    </div>
  );
}

export function SchematicsPage({ toast }: { toast: (type: 'ok'|'err'|'warn', msg: string) => void }) {
  const [text, setText]                     = useState('');
  const [attachments, setAttachments]       = useState<Attachment[]>([]);
  const [loading, setLoading]               = useState(false);
  const [result, setResult]                 = useState<PriceResult | null>(null);
  const [projectName, setProjectName]       = useState('');
  const [showUnmatched, setShowUnmatched]   = useState(false);
  const [savedRuns, setSavedRuns]           = useState<RunEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('mu_el_runs') || '[]'); }
    catch { return []; }
  });
  const [activeRunId, setActiveRunId]       = useState<string | null>(null);
  // Live streaming read-out (pasted lists)
  const [streaming, setStreaming]           = useState(false);
  const [progress, setProgress]             = useState<PricedItem[]>([]);
  const [progressTotal, setProgressTotal]   = useState(0);
  const [phase, setPhase]                   = useState('');
  const fileRef    = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 360) + 'px';
  }, [text]);

  const addFiles = useCallback((files: File[] | FileList) => {
    const newAttachments: Attachment[] = [];
    for (const f of Array.from(files)) {
      const kind = classifyAttachment(f);
      if (!kind) {
        toast('warn', `${f.name}: unsupported file type — PDF, image, or Excel/CSV only`);
        continue;
      }
      const att: Attachment = {
        id:   `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        kind,
        name: f.name,
        size: f.size,
      };
      if (kind === 'image') {
        att.previewUrl = URL.createObjectURL(f);
      }
      newAttachments.push(att);
    }
    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  }, [toast]);

  // Global paste — capture images from clipboard into the workspace
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imgItems = items.filter(i => i.type.startsWith('image/'));
      if (imgItems.length === 0) return;
      const target = e.target as HTMLElement | null;
      // If the user is typing into a textarea/input that already accepted text from this paste,
      // still extract the image but let the text path through.
      const files = imgItems.map(i => i.getAsFile()).filter(Boolean) as File[];
      if (files.length > 0) {
        addFiles(files);
      }
    }
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [addFiles]);

  // Revoke preview URLs on unmount / removal
  useEffect(() => {
    return () => attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function removeAttachment(id: string) {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }

  function clearAll() {
    setText('');
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    setAttachments([]);
    setResult(null);
    setProjectName('');
    setActiveRunId(null);
    setStreaming(false);
    setProgress([]);
    setProgressTotal(0);
    setPhase('');
  }

  // Shared: turn a finished PriceResult into UI state, a toast, and a saved run.
  function finalizeResult(data: PriceResult) {
    if (data.error) {
      toast('err', data.error);
      setResult(data);
      return;
    }
    setResult(data);
    const matched = data.items.filter(i => i.matched).length;
    const cands   = data.candidates?.length || 0;
    if (matched > 0) {
      toast('ok', `Priced ${matched} item${matched === 1 ? '' : 's'}${cands ? ` · ${cands} suggestion${cands === 1 ? '' : 's'}` : ''}`);
    } else if (cands > 0) {
      toast('ok', `Found ${cands} candidate match${cands === 1 ? '' : 'es'} — pick one to add`);
    } else {
      toast('warn', 'No matches or candidates found — try a more specific description');
    }
    const entry: RunEntry = {
      id: Date.now().toString(),
      ts: Date.now(),
      source: 'unified',
      filename:
        attachments.length > 0
          ? attachments.map(a => a.name).slice(0, 2).join(', ') + (attachments.length > 2 ? ` +${attachments.length - 2}` : '')
          : (text.trim().slice(0, 40) + (text.length > 40 ? '…' : '')),
      matchedCount:   data.items.filter(i => i.matched).length,
      unmatchedCount: data.items.filter(i => !i.matched).length,
      totalNtp:       data.total_ntp,
      result:         data,
    };
    setSavedRuns(prev => {
      const next = [entry, ...prev].slice(0, 20);
      localStorage.setItem('mu_el_runs', JSON.stringify(next));
      return next;
    });
  }

  async function run() {
    if (!text.trim() && attachments.length === 0) {
      toast('warn', 'Enter a description, cat numbers, or attach a PDF/image');
      return;
    }
    setLoading(true);
    setResult(null);
    // Everything streams — pasted lists AND uploads (images/PDFs) — so items
    // appear with a live count instead of a frozen spinner.
    await runStream();
    setLoading(false);
  }

  // Streaming read-out: parse NDJSON progress events and fill the list live.
  async function runStream() {
    setStreaming(true);
    setProgress([]);
    setProgressTotal(0);
    setPhase(attachments.length > 0 ? 'Reading your upload…' : 'Reading list…');
    try {
      const fd = new FormData();
      if (text.trim()) fd.append('text', text);
      for (const a of attachments) fd.append('files', a.file, a.name);
      fd.append('stream', '1');
      await runTask('Pricing EL items…', async (signal) => {
        const resp = await fetch('/api/schematics/price', { method: 'POST', body: fd, signal });
        if (!resp.body) {
          // Server didn't stream — fall back to a single JSON parse.
          finalizeResult(await resp.json());
          return;
        }
        const reader  = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let finalData: PriceResult | null = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.t === 'start') {
              setProgressTotal(ev.total || 0);
              setProgress([]);
              setPhase(ev.total ? 'Reading items…' : 'Searching…');
            } else if (ev.t === 'item' || ev.t === 'update') {
              setProgress(prev => { const next = prev.slice(); next[ev.i] = ev.item; return next; });
            } else if (ev.t === 'phase') {
              setPhase(ev.label || '');
            } else if (ev.t === 'done') {
              finalData = ev as PriceResult;
            } else if (ev.t === 'error') {
              throw new Error(ev.error || 'Stream error');
            }
          }
        }
        if (finalData) finalizeResult(finalData);
        else toast('warn', 'No items read — try again');
      });
    } catch (e: any) {
      if (!isCancel(e)) toast('err', e.message);
      else toast('warn', 'Pricing canceled');
    } finally {
      setStreaming(false);
    }
  }

  function copyEmail() {
    if (!result) return;
    navigator.clipboard.writeText(buildEmailText(result, projectName));
    toast('ok', 'Email text copied to clipboard');
  }

  const matched   = result?.items.filter(i => i.matched)  || [];
  const unmatched = result?.items.filter(i => !i.matched) || [];

  async function retryItem(originalInput: string, overrideCatNo?: string) {
    const catNo = overrideCatNo || originalInput;
    if (!catNo || !result) return;
    try {
      const resp = await fetch('/api/schematics/price', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: catNo,
      });
      const data: PriceResult = await resp.json();
      if (data.error) { toast('err', data.error); return; }
      const found = data.items.find(i => i.matched);
      if (!found) { toast('warn', `Still couldn't find ${catNo}`); return; }
      setResult(prev => {
        if (!prev) return prev;
        const items = prev.items.map(it =>
          (it.original_input === originalInput || it.cat_no === originalInput)
            ? { ...found, qty: it.qty, line_ntp: round(found.ntp * it.qty, 2) }
            : it
        );
        return { ...prev, items, total_ntp: items.filter(i => i.matched).reduce((s, i) => s + i.line_ntp, 0) };
      });
      toast('ok', `Updated: ${originalInput} → ${found.cat_no}`);
    } catch (e: any) { toast('err', e.message); }
  }

  function pickCandidate(c: VisualCandidate, replace: boolean) {
    if (!result) return;
    if (!c.matched || c.ntp == null) {
      toast('warn', `${c.cat_no} is not in the price list — try retry/correct on it`);
      return;
    }
    const qty = c.suggested_qty && c.suggested_qty > 0 ? c.suggested_qty : 1;
    const newItem: PricedItem = {
      ref:            '',
      cat_no:         c.cat_no,
      description:    c.description,
      family:         c.family,
      qty,
      list_price:     c.list_price ?? 0,
      ntp:            c.ntp,
      line_ntp:       round(c.ntp * qty, 2),
      status:         c.status ?? '',
      matched:        true,
      match_type:     'exact',
      original_input: c.cat_no,
    };
    setResult(prev => {
      if (!prev) return prev;
      const baseItems = replace ? [] : prev.items;
      const items = [...baseItems, newItem];
      return {
        ...prev,
        items,
        total_ntp: items.filter(i => i.matched).reduce((s, i) => s + i.line_ntp, 0),
      };
    });
    toast('ok', replace ? `Replaced with ${c.cat_no}` : `Added ${c.cat_no} × ${qty}`);
  }

  function onDropZone(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-12 gap-5 items-start">
      <div className="col-span-12 lg:col-span-5 space-y-5">

      {/* Unified Input card */}
      <Card>
        <div className="flex items-start justify-between gap-3 mb-3">
          <CardTitle
            title="EL Pricer"
            sub="Paste material lists, descriptions, photos, Excel/CSV or schematic PDFs — anything goes. AI auto-routes to price-list lookup or online search."
          />
          {(text || attachments.length > 0 || result) && (
            <button
              onClick={clearAll}
              className="text-[11.5px] text-ink-400 hover:text-red-500 inline-flex items-center gap-1 shrink-0">
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>

        {/* Unified drop / paste / type workspace */}
        <div
          onDrop={onDropZone}
          onDragOver={e => e.preventDefault()}
          className={cn(
            'rounded-xl ring-1 ring-inset transition-colors',
            'bg-ink-50/40 dark:bg-ink-900/30 ring-ink-200 dark:ring-ink-700',
            'focus-within:ring-brand-400 focus-within:bg-white dark:focus-within:bg-ink-900',
          )}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={`Describe the items or paste a material list — e.g.\n\n5 no. Eaton wire suspended exit signs for a mall.\nThe drop is quite long, 2 or 3 m. Self-contained exit/emergency.\n\n— or —\n\nMP2ES230CGS, 6\nNXL100, 12\nLUM22216, 3`}
            className="w-full bg-transparent px-4 pt-3.5 pb-2 text-[12.5px] leading-relaxed focus:outline-none resize-none placeholder:text-ink-400 dark:placeholder:text-ink-600 min-h-[140px]"
          />

          {/* Attachment chips */}
          {attachments.length > 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-2 border-t border-ink-200/60 dark:border-ink-700/60 pt-2.5">
              {attachments.map(a => (
                <div
                  key={a.id}
                  className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-[11.5px]">
                  {a.kind === 'image' && a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} className="w-8 h-8 rounded object-cover ring-1 ring-ink-200 dark:ring-ink-700" />
                  ) : a.kind === 'image' ? (
                    <ImageIcon className="w-4 h-4 text-brand-500" />
                  ) : a.kind === 'excel' ? (
                    <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <FileText className="w-4 h-4 text-rose-500" />
                  )}
                  <div className="min-w-0">
                    <p className="text-ink-800 dark:text-ink-100 font-medium truncate max-w-[180px]">{a.name}</p>
                    <p className="text-[10px] text-ink-400 dark:text-ink-500">{(a.size / 1024).toFixed(0)} KB · {a.kind === 'pdf' ? 'PDF' : a.kind === 'excel' ? 'Excel' : 'Image'}</p>
                  </div>
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="ml-1 text-ink-300 hover:text-red-500 transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-ink-200/60 dark:border-ink-700/60">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Attach PDF or image"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors">
                <Paperclip className="w-3.5 h-3.5" /> Attach
              </button>
              <span className="text-[10.5px] text-ink-400 dark:text-ink-500 ml-1">
                or drop files · paste image with <kbd className="px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-[10px] font-mono">Ctrl+V</kbd>
              </span>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,image/*,.xlsx,.xls,.xlsm,.csv"
                className="hidden"
                onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
            <Button tone="primary" Icon={loading ? Loader2 : Sparkles} onClick={run} disabled={loading}>
              {loading ? 'Pricing…' : 'Get NTP Prices'}
            </Button>
          </div>
        </div>

        {/* Status line */}
        {result && !result.error && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-400 dark:text-ink-500">
            <span>{matched.length} matched</span>
            {unmatched.length > 0 && <span>{unmatched.length} unmatched</span>}
            {result.candidates && result.candidates.length > 0 && (
              <span>{result.candidates.length} candidate{result.candidates.length === 1 ? '' : 's'}</span>
            )}
            {result.inputs && (
              <span className="text-ink-400">
                {result.inputs.has_text ? 'text · ' : ''}
                {result.inputs.pdf_count ? `${result.inputs.pdf_count} PDF · ` : ''}
                {result.inputs.image_count ? `${result.inputs.image_count} image${result.inputs.image_count === 1 ? '' : 's'} · ` : ''}
                qty hint {result.inputs.qty_hint}
              </span>
            )}
          </div>
        )}
        <p className="mt-2 text-[10.5px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />
          Uses your Gemini API key configured in Settings. Web search runs automatically for descriptions and uncertain matches.
        </p>
      </Card>
      </div>

      <div className="col-span-12 lg:col-span-7 space-y-5">

      {/* Live read-out — items stream in as they're priced */}
      {streaming && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <CardTitle
              title="Reading items"
              sub={progressTotal
                ? `${progress.filter(Boolean).length} of ${progressTotal} priced`
                : 'Working through your list…'}
            />
            <Loader2 className="w-4 h-4 animate-spin text-brand-500 shrink-0" />
          </div>
          {progress.filter(Boolean).length > 0 ? (
            <div className="space-y-1 max-h-[420px] overflow-y-auto pr-0.5">
              {progress.map((it, i) => it && (
                <ProgressRow key={i} idx={i + 1} item={it} active={i === progress.length - 1} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 py-6 text-[12px] text-ink-400 animate-soft-pulse">
              <Sparkles className="w-4 h-4 text-brand-500" /> {phase || 'Reading list…'}
            </div>
          )}
          {phase && progress.filter(Boolean).length > 0 && (
            <p className="mt-3 text-[11px] text-ink-400 dark:text-ink-500 flex items-center gap-1.5 animate-soft-pulse">
              <Loader2 className="w-3 h-3 animate-spin" /> {phase}
            </p>
          )}
        </Card>
      )}

      {/* Candidate suggestions — descriptive / visual matches */}
      {result && !result.error && result.candidates && result.candidates.length > 0 && (
        <Card>
          <CardTitle
            title="Suggested matches"
            sub="AI ranked these Eaton/Cooper products against your description and any images. Confidence + reasoning shown — pick the right one."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            {result.candidates.map((c, idx) => {
              const tone = c.confidence === 'high'
                ? 'bg-emerald-50 dark:bg-emerald-900/20 ring-emerald-200 dark:ring-emerald-800/40'
                : c.confidence === 'low'
                  ? 'bg-amber-50 dark:bg-amber-900/20 ring-amber-200 dark:ring-amber-800/40'
                  : 'bg-ink-50 dark:bg-ink-800/40 ring-ink-200 dark:ring-ink-700';
              return (
                <div key={`${c.cat_no}-${idx}`} className={cn('rounded-lg ring-1 ring-inset p-3', tone)}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
                          {c.confidence || 'medium'}
                        </span>
                        {c.matched
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium">in price list</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-200 dark:bg-ink-700 text-ink-600 dark:text-ink-300 font-medium">not priced</span>}
                        {c.suggested_qty && c.suggested_qty > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 font-medium">qty {c.suggested_qty}</span>
                        )}
                      </div>
                      <p className="font-mono text-[12.5px] font-semibold text-ink-800 dark:text-ink-100 truncate">{c.cat_no}</p>
                      {c.family && <p className="text-[11px] text-brand-600 dark:text-brand-400 truncate">{c.family}</p>}
                      {c.description && <p className="text-[11px] text-ink-600 dark:text-ink-300 line-clamp-2 mt-0.5">{c.description}</p>}
                      {c.reasoning && <p className="text-[10.5px] text-ink-500 dark:text-ink-400 italic mt-1 line-clamp-3">"{c.reasoning}"</p>}
                      {c.source_url && (
                        <a href={c.source_url} target="_blank" rel="noreferrer"
                           className="text-[10.5px] text-brand-600 dark:text-brand-400 hover:underline mt-1 inline-block truncate max-w-full">
                          source ↗
                        </a>
                      )}
                    </div>
                    {c.matched && c.ntp != null && (
                      <div className="text-right shrink-0">
                        <p className="text-[10px] uppercase tracking-wide text-ink-400">NTP</p>
                        <p className="text-[14px] font-semibold tabular-nums">{fmtGBP(c.ntp)}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-2.5 pt-2.5 border-t border-ink-200/60 dark:border-ink-700/60">
                    <Button tone="primary" size="sm" Icon={Plus} onClick={() => pickCandidate(c, false)}>
                      Add to schedule
                    </Button>
                    <Button tone="ghost" size="sm" onClick={() => pickCandidate(c, true)}>
                      Use as match
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Results */}
      {result && !result.error && matched.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <CardTitle title="Material Schedule" sub="Eaton EL Global Price List — Jul 2026 NTP" />
            </div>
            <div className="flex items-center gap-2">
              <input
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                placeholder="Project name…"
                className="h-8 px-3 rounded-lg bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-[12px] focus:outline-none focus:ring-brand-400 w-48"
              />
              <Button tone="ghost" Icon={Copy} size="sm" onClick={copyEmail}>
                Copy email
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-ink-100 dark:ring-ink-800">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-ink-50 dark:bg-ink-900">
                  <th className="px-3 py-2 text-left font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Ref</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Catalogue No</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Description</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Family</th>
                  <th className="px-3 py-2 text-right font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">NTP/Unit</th>
                  <th className="px-3 py-2 text-right font-semibold text-ink-500 dark:text-ink-400 text-[10.5px] uppercase tracking-wide">Line NTP</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {matched.map((item, i) => {
                  const uncertain = item.match_type === 'description' || item.match_type === 'fuzzy';
                  return (
                  <tr key={i} className={cn('border-t border-ink-50 dark:border-ink-800/60',
                    i % 2 === 0 ? '' : 'bg-ink-50/40 dark:bg-ink-900/20')}>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-500">{item.ref || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <span className="font-mono font-semibold text-brand-700 dark:text-brand-400">{item.cat_no}</span>
                        {uncertain && item.original_input && item.original_input !== item.cat_no && (
                          <span className="text-[9.5px] text-amber-500 font-mono truncate max-w-[80px]" title={`From: ${item.original_input}`}>
                            ← {item.original_input}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-ink-700 dark:text-ink-200 max-w-xs">
                      <span className="line-clamp-2">{item.description}</span>
                    </td>
                    <td className="px-3 py-2 text-ink-400 dark:text-ink-500 text-[11px]">{item.family}</td>
                    <td className="px-3 py-2 text-right text-ink-600 dark:text-ink-300">{item.qty}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-600 dark:text-ink-300">{fmtGBP(item.ntp)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-ink-800 dark:text-ink-100">{fmtGBP(item.line_ntp)}</td>
                    <td className="px-2 py-2 text-center">
                      {uncertain && (
                        <ItemMenu
                          item={item}
                          onRetry={catNo => retryItem(item.original_input || item.cat_no, catNo)}
                        />
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-900">
                  <td colSpan={6} className="px-3 py-2.5 text-right font-semibold text-ink-700 dark:text-ink-200 text-[12px]">
                    Total NTP (ex VAT)
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono font-bold text-[13px] text-ink-900 dark:text-white">
                    {fmtGBP(result.total_ntp)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-3 text-[10.5px] text-ink-400 dark:text-ink-500">
            Prices are Net Trade Price (NTP) from Eaton EL Global Price List Jul 2026. All prices ex VAT. Subject to confirmation.
          </p>

          {unmatched.length > 0 && (
            <div className="mt-4">
              <button onClick={() => setShowUnmatched(s => !s)}
                className="flex items-center gap-1.5 text-[11.5px] text-amber-600 dark:text-amber-400 hover:text-amber-700">
                <AlertTriangle className="w-3.5 h-3.5" />
                {unmatched.length} item{unmatched.length > 1 ? 's' : ''} not found in price list
                {showUnmatched ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showUnmatched && (
                <div className="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/10 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/30">
                  <div className="flex flex-wrap gap-1.5">
                    {unmatched.map((item, i) => (
                      <span key={i} className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-[11px] font-mono text-amber-700 dark:text-amber-300">
                        {item.cat_no}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[10.5px] text-amber-600 dark:text-amber-400">
                    Check catalogue numbers against the Eaton EL price list. Items may be discontinued, not in the EL range, or have a different part number format.
                  </p>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Empty-results hint */}
      {result && !result.error && matched.length === 0 && (!result.candidates || result.candidates.length === 0) && (
        <Card>
          <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="text-[12.5px]">
              <p className="font-medium">No matches or candidates found.</p>
              <p className="mt-1 text-[11.5px] text-ink-500 dark:text-ink-400">
                Try giving more detail — product family ("exit sign", "anti-panic"), mounting ("wall", "wire-suspended", "recessed"),
                power source (self-contained / central battery), or attach a photo.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Error */}
      {result?.error && (
        <Card>
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <p className="text-[12px]">{result.error}</p>
          </div>
        </Card>
      )}

      {/* Empty / loading placeholder for the results column */}
      {!result && !streaming && (
        <Card className="min-h-[320px] flex flex-col items-center justify-center text-center py-20">
          {loading ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-brand-500 mb-3" />
              <p className="text-[12px] text-ink-400">Matching catalogue numbers…</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-2xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center mb-3">
                <Sparkles className="w-5 h-5 text-ink-400" />
              </div>
              <p className="text-[12.5px] font-medium text-ink-600 dark:text-ink-300">Priced items appear here</p>
              <p className="text-[11px] text-ink-400 mt-1 max-w-[240px]">Paste a list, drop a PDF or image, then hit Get NTP Prices.</p>
            </>
          )}
        </Card>
      )}
      </div>
      </div>

      {/* Recent Runs */}
      {savedRuns.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-ink-400 dark:text-ink-500" />
              <span className="text-[13px] font-semibold text-ink-800 dark:text-ink-100">Recent Runs</span>
            </div>
            <button
              onClick={() => { setSavedRuns([]); localStorage.removeItem('mu_el_runs'); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-red-500 hover:text-red-700 dark:hover:text-red-400 transition-colors">
              <Trash2 className="w-3 h-3" /> Clear all
            </button>
          </div>
          <div className="space-y-1.5">
            {savedRuns.map(run => (
              <div key={run.id}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg ring-1 ring-inset transition-colors cursor-pointer',
                  activeRunId === run.id
                    ? 'bg-brand-50 dark:bg-brand-900/10 ring-brand-200 dark:ring-brand-700/40'
                    : 'bg-ink-50 dark:bg-ink-900/40 ring-ink-100 dark:ring-ink-800',
                )}
                onClick={() => setActiveRunId(id => id === run.id ? null : run.id)}>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {run.source === 'pdf'
                    ? <FileText className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                    : run.source === 'image'
                    ? <ImageIcon className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                    : <ClipboardList className="w-3.5 h-3.5 text-ink-400 shrink-0" />}
                  <span className="text-[12px] text-ink-700 dark:text-ink-200 truncate font-medium">{run.filename}</span>
                  <span className="text-[10.5px] text-ink-400 dark:text-ink-500 shrink-0">
                    {new Date(run.ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })},{' '}
                    {new Date(run.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">{run.matchedCount}✓</span>
                  {run.unmatchedCount > 0 && (
                    <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">{run.unmatchedCount}✗</span>
                  )}
                </div>
                <span className="text-[12px] font-bold text-ink-800 dark:text-ink-100 shrink-0 font-mono">
                  £{run.totalNtp.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    title="Restore"
                    onClick={e => {
                      e.stopPropagation();
                      setResult(run.result);
                      setProjectName('');
                      setShowUnmatched(false);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="p-1 rounded text-ink-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                    <RotateCcw style={{ width: 11, height: 11 }} />
                  </button>
                  <button
                    title="Remove"
                    onClick={e => {
                      e.stopPropagation();
                      setSavedRuns(prev => {
                        const next = prev.filter(r => r.id !== run.id);
                        localStorage.setItem('mu_el_runs', JSON.stringify(next));
                        return next;
                      });
                    }}
                    className="p-1 rounded text-ink-300 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
