// ─── Inbox — Outlook email reader + AI triage ────────────────────────────────
import React, { useState, useEffect, useCallback, useRef, KeyboardEvent } from 'react';
import {
  Mail, RefreshCw, Paperclip, FileText, Sparkles, Loader2,
  Filter, Users, ChevronRight, ChevronDown, Download,
  CheckCircle2, Inbox as InboxIcon,
  ThumbsUp, ThumbsDown, Send, Edit3, Trash2, RotateCcw,
  Play, ArrowLeft, Zap, Eye, X, Image as ImageIcon, ChevronLeft,
  Pin, PinOff, Search, FolderOpen, MoreHorizontal, Star, ExternalLink,
  Forward, MessageSquare, PenLine, Plus, GripVertical, Battery, Lock, Check, FileSpreadsheet, FileDown,
} from 'lucide-react';
import { runTask, isCancel } from '../lib/tasks';
import { QuickQuotePanel } from './QuickQuote';
import { extractMaterialHints } from '../lib/elHints';
import { openExternal } from '../lib/shell';

// ─── Module-level state — survives tab switches / component remounts ─────────
// Locked behind a "Coming Soon" wall in the stripped ship build (personal API
// keys / tooling not ready for team rollout), full locally — same gate as App.tsx.
const STRIPPED = import.meta.env.PROD;

const CACHE_TTL = 15 * 60 * 1000;
interface CacheEntry { emails: EmailSummary[]; ts: number; }
const emailCache = new Map<string, CacheEntry>();

// These are initialised once and kept alive while the app is open
let _available: boolean | null = null;
let _availError = '';
let _newOutlook = false;
let _graphAuth  = false;
let _mailboxes: Mailbox[] = [];
// Session cache of generated summaries (the durable copy lives in SQLite).
let _summaryCache: Record<string, string> = {};
let _selectedId = '';
let _detail: EmailDetail | null = null;
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { fmtGBP } from '../lib/ui';
import type { ToastFn } from '../App';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Mailbox {
  storeId:   string;
  name:      string;
  type:      'personal' | 'shared' | 'other';
  inboxName: string;
}

interface AttachmentInfo {
  index:      number;
  name:       string;
  size:       number;
  isPdf:      boolean;
  isImage?:   boolean;
  isInline?:  boolean;
  contentId?: string;
}

interface EmailSummary {
  entryId:     string;
  subject:     string;
  sender:      string;
  senderEmail: string;
  received:    string;
  bodyPreview: string;
  unread:      boolean;
  attachments: AttachmentInfo[];
  hasPdf:      boolean;
}

interface EmailDetail extends EmailSummary {
  to:       string;
  cc:       string;
  body:     string;
  htmlBody?: string;
}

interface AttachSuggestion {
  sourceEntryId:   string;
  attachmentIndex: number;
  attachmentName:  string;
  attachmentSize:  number;
  emailSubject:    string;
  sender:          string;
  received:        string;
  score:           number;
}

const CATEGORIES = ['Quote Request', 'Approval', 'Follow-up', 'Urgent', 'Info', 'Admin'] as const;

// ─── Tiny markdown renderer (for AI analysis) ─────────────────────────────────
function Md({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let ulBuf: string[] = [];
  let olBuf: string[] = [];

  const flushUl = () => {
    if (!ulBuf.length) return;
    out.push(
      <ul key={out.length} className="my-1 space-y-1 pl-0.5">
        {ulBuf.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">
            <span className="text-violet-400 shrink-0 mt-0.5">•</span>
            <span>{inline(item)}</span>
          </li>
        ))}
      </ul>,
    );
    ulBuf = [];
  };
  const flushOl = () => {
    if (!olBuf.length) return;
    out.push(
      <ol key={out.length} className="my-1 space-y-1 pl-0.5">
        {olBuf.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">
            <span className="text-violet-500 font-semibold shrink-0 w-4 text-right mt-0.5">{i + 1}.</span>
            <span>{inline(item)}</span>
          </li>
        ))}
      </ol>,
    );
    olBuf = [];
  };

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) { flushUl(); flushOl(); out.push(<div key={out.length} className="h-1" />); continue; }
    if (raw.startsWith('### ')) { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[11.5px] font-bold mt-2 mb-0.5 text-ink-800 dark:text-ink-100">{inline(raw.slice(4))}</p>); continue; }
    if (raw.startsWith('## '))  { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[12.5px] font-bold mt-2.5 mb-0.5 text-ink-800 dark:text-ink-100">{inline(raw.slice(3))}</p>); continue; }
    if (raw.startsWith('# '))   { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[13px] font-bold mt-2.5 mb-1 text-ink-800 dark:text-ink-100">{inline(raw.slice(2))}</p>); continue; }
    if (/^[-*•]\s/.test(raw))  { flushOl(); ulBuf.push(raw.replace(/^[-*•]\s+/, '')); continue; }
    if (/^\d+\.\s/.test(raw))  { flushUl(); olBuf.push(raw.replace(/^\d+\.\s+/, '')); continue; }
    if (/^---+$/.test(raw))    { flushUl(); flushOl(); out.push(<hr key={out.length} className="my-2 border-violet-200/60 dark:border-violet-800/40" />); continue; }
    flushUl(); flushOl();
    out.push(<p key={out.length} className="text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">{inline(raw)}</p>);
  }
  flushUl(); flushOl();
  return <div className="space-y-0.5">{out}</div>;
}

function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={m.index} className="font-semibold text-ink-900 dark:text-ink-50">{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} className="px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-[11px] font-mono text-brand-600 dark:text-brand-300">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  } catch { return iso; }
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Opens a PDF attachment in a real OS window (Tauri: default browser; web: tab)
function openAttachmentPdf(entryId: string, index: number) {
  void openExternal(`/api/outlook/attachment-view/${encodeURIComponent(entryId)}/${index}`);
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff']);
function isImageFile(name: string) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTS.has(name.slice(dot).toLowerCase());
}
const EXCEL_EXTS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']);
function isExcelFile(name: string) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && EXCEL_EXTS.has(name.slice(dot).toLowerCase());
}
function attViewUrl(entryId: string, index: number) {
  return `/api/outlook/attachment-view/${encodeURIComponent(entryId)}/${index}`;
}

function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: Event) => { if ((e as globalThis.KeyboardEvent).key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}>
      <div
        className="relative max-w-[90vw] max-h-[90vh] cursor-default"
        onClick={e => e.stopPropagation()}>
        <img
          src={src}
          alt={name}
          className="block max-w-[88vw] max-h-[85vh] rounded-xl shadow-2xl object-contain"
        />
        <div className="absolute top-2 right-2 flex items-center gap-2">
          <span className="text-white/80 text-[11px] bg-black/50 px-2 py-0.5 rounded-md truncate max-w-[260px]">{name}</span>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-black/50 hover:bg-black/80 text-white flex items-center justify-center transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── HTML email renderer (iframe, sandboxed, Outlook-matched fonts) ──────────
function wrapEmailHtml(html: string): string {
  const t = html.trim();
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const bg   = dark ? '#1a1a1f' : '#fff';
  const fg   = dark ? '#e6e6ee' : '#1f1f1f';
  const link = dark ? '#8ab4ff' : '#0563C1';
  const injectStyle = [
    `<style>`,
    `* { max-width: 100%; box-sizing: border-box; }`,
    `img { max-width: 100%; height: auto; }`,
    `body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: ${fg}; margin: 16px 20px; line-height: 1.5; background: ${bg}; word-wrap: break-word; }`,
    // Force sender's hardcoded near-white/near-black text to inherit so it stays
    // readable on the dark canvas (covers most inline-styled marketing emails).
    dark ? `body, body * { color: ${fg} !important; background-color: transparent !important; }` : ``,
    `a { color: ${link}${dark ? ' !important' : ''}; }`,
    `p { margin: 0 0 8px; }`,
    `pre, code { white-space: pre-wrap; word-break: break-all; }`,
    `</style>`,
  ].join('');
  if (/^<!DOCTYPE|^<html/i.test(t)) {
    return t.includes('<head') ? t.replace(/<head([^>]*)>/i, `<head$1>${injectStyle}`) : t;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${injectStyle}</head><body>${t}</body></html>`;
}

// Inline images in an email arrive as <img src="cid:XYZ"> — the browser can't
// resolve cid:, so they render broken. Rewrite each cid: ref to the real image
// URL (/api/outlook/attachment-view/:entryId/:index), matching by Content-ID
// first, then by filename (Outlook cids are usually "filename@host").
function resolveCidImages(html: string, entryId: string, attachments: AttachmentInfo[]): string {
  if (!html || !/cid:/i.test(html)) return html;
  return html.replace(/(["'])cid:([^"']+)\1/gi, (whole, q, ref) => {
    const cid  = String(ref).trim().replace(/^<|>$/g, '');
    const base = cid.split('@')[0].toLowerCase();
    const hit  = attachments.find(a => (a.contentId || '').replace(/^<|>$/g, '').toLowerCase() === cid.toLowerCase())
              || attachments.find(a => a.name.toLowerCase() === base)
              || attachments.find(a => (a.contentId || '').split('@')[0].toLowerCase() === base);
    if (!hit) return whole;
    return `${q}${attViewUrl(entryId, hit.index)}${q}`;
  });
}

function EmailBodyFrame({ html, entryId, attachments }: { html: string; entryId: string; attachments: AttachmentInfo[] }) {
  const ref = useRef<HTMLIFrameElement>(null);
  function onLoad() {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const h = Math.max(200, doc.documentElement.scrollHeight || doc.body?.scrollHeight || 200);
    if (ref.current) ref.current.style.height = (h + 20) + 'px';
  }
  return (
    <iframe
      ref={ref}
      srcDoc={wrapEmailHtml(resolveCidImages(html, entryId, attachments))}
      sandbox="allow-same-origin"
      onLoad={onLoad}
      className="w-full border-0 block"
      style={{ minHeight: 200 }}
      title="email-body"
    />
  );
}

// ─── Inline EL Material Pricer ───────────────────────────────────────────────
interface MiniPricedItem {
  ref: string; cat_no: string; description: string;
  qty: number; ntp: number; line_ntp: number;
  matched: boolean; match_type?: string; original_input?: string;
  search_note?: string; status?: string;
  closest_matches?: { cat_no: string; description: string; family: string; ntp: number; list_price: number }[];
}

interface MiniCandidate {
  cat_no:        string;
  family:        string;
  description:   string;
  confidence:    string;
  reasoning:     string;
  source_url:    string;
  matched:       boolean;
  list_price:    number | null;
  ntp:           number | null;
  status:        string | null;
  suggested_qty?: number;
}

interface ScheduleEntry { source: string; items: MiniPricedItem[]; total_ntp: number; }
let _pricerSchedule: ScheduleEntry[] = [];


// ─── CBU Tech Sheet Generator ─────────────────────────────────────────────────
const CBU_SYSTEMS = [
  '1PH- 0.5KVA','1PH- 1KVA','1PH- 2KVA','1PH- 4KVA','1PH- 5KVA',
  '1PH- 8KVA','1PH- 10KVA','1PH- 12KVA','1PH- 15KVA','1PH- 16KVA','1PH- 20KVA',
  '3PH- 6KVA','3PH- 8KVA','3PH- 10KVA','3PH- 12KVA','3PH- 14KVA',
  '3PH- 16KVA','3PH- 18KVA','3PH- 20KVA','3PH- 24KVA','3PH- 28KVA',
  '3PH- 30KVA','3PH- 32KVA','3PH- 36KVA','3PH- 40KVA','3PH- 42KVA',
  '3PH- 48KVA','3PH- 54KVA','3PH- 56KVA','3PH- 60KVA',
];

const CBU_SALESMEN = [
  { name: 'Blair McDonald',  email: 'blairgmcdonald@eaton.com',  phone: '07890954552' },
  { name: 'Craig Donaldson', email: 'craigdonaldson@eaton.com',  phone: '07811692079' },
  { name: 'Joe Bayley',      email: 'joebayley@eaton.com',       phone: '07713325534' },
  { name: 'Mark Fenton',     email: 'MarkAFenton@Eaton.com',     phone: '07713325528' },
  { name: 'Ollie Bailey',    email: 'olliejbailey@eaton.com',    phone: '07866893068' },
  { name: 'Ryan Houston',    email: 'ryanhouston@eaton.com',     phone: '07773949386' },
];

// Known CBU system capacities in kVA — used to validate watt-to-kVA conversions
const CBU_KNOWN_KVA = [0.5,1,2,4,5,6,8,10,12,14,15,16,18,20,24,28,30,32,36,40,42,48,54,56,60];
function isNearKnownCBU(kva: number) {
  return CBU_KNOWN_KVA.some(k => Math.abs(k - kva) / k <= 0.15);
}

function extractCBUHints(body: string): { detected: boolean; detectedSystems: Array<{ kva: number; phase: '1PH' | '3PH' }> } {
  const detected = /\bcbu\b|central battery unit|loadstar(?:-ps)?/i.test(body) ||
    (/\bups\b/i.test(body) && /\bkva\b/i.test(body));
  if (!detected) return { detected: false, detectedSystems: [] };

  const kvaVals: number[] = [];
  // explicit kVA mentions
  const kvaRe = /(\d+(?:\.\d+)?)\s*[kK][vV][aA]/g;
  let m: RegExpExecArray | null;
  while ((m = kvaRe.exec(body)) !== null) kvaVals.push(parseFloat(m[1]));
  // watt mentions — only accept if within 15% of a known CBU system capacity
  // (prevents heat dissipation / current draw values triggering false extra systems)
  const wRe = /(\d+(?:\.\d+)?)\s*[wW](?:att(?:s)?)?\b/g;
  while ((m = wRe.exec(body)) !== null) {
    const kva = Math.round((parseFloat(m[1]) / 1000) * 10) / 10;
    if (isNearKnownCBU(kva)) kvaVals.push(kva);
  }

  const phase3 = /three.?phase|3.?ph\b/i.test(body);
  const phase1 = /single.?phase|1.?ph\b/i.test(body);

  // deduplicate, snap each to nearest CBU system key
  const seen = new Set<string>();
  const detectedSystems: Array<{ kva: number; phase: '1PH' | '3PH' }> = [];
  for (const kva of kvaVals) {
    const phase: '1PH' | '3PH' = phase3 ? '3PH' : phase1 ? '1PH' : kva >= 6 ? '3PH' : '1PH';
    const key = pickCBUSystem(kva, phase);
    if (!seen.has(key)) { seen.add(key); detectedSystems.push({ kva, phase }); }
  }
  return { detected, detectedSystems };
}

function pickCBUSystem(kva: number | null, phase: '1PH' | '3PH' | null): string {
  const pool = phase ? CBU_SYSTEMS.filter(k => k.startsWith(phase)) : CBU_SYSTEMS;
  const candidates = pool.length ? pool : CBU_SYSTEMS;
  if (!kva) return candidates[0];
  let best = candidates[0]; let bestDiff = Infinity;
  for (const k of candidates) {
    const m = k.match(/(\d+(?:\.\d+)?)\s*KVA/i);
    if (m) { const d = Math.abs(parseFloat(m[1]) - kva); if (d < bestDiff) { bestDiff = d; best = k; } }
  }
  return best;
}

function CBUSystemSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="flex-1 h-7 px-2 rounded-lg text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 focus:outline-none focus:ring-blue-400">
      <optgroup label="Single Phase">
        {CBU_SYSTEMS.filter(s => s.startsWith('1PH')).map(s => <option key={s} value={s}>{s}</option>)}
      </optgroup>
      <optgroup label="Three Phase">
        {CBU_SYSTEMS.filter(s => s.startsWith('3PH')).map(s => <option key={s} value={s}>{s}</option>)}
      </optgroup>
    </select>
  );
}

function InlineCBUGenerator({ emailSubject, emailBody, toast }: { emailSubject: string; emailBody: string; toast: ToastFn }) {
  const hints = extractCBUHints(emailBody);
  const cleanSubject = emailSubject.replace(/^(RE:|FW:|Fwd:)\s*/gi, '').replace(/SR00[A-Z0-9]+\s*/gi, '').trim();

  const [systems,  setSystems]  = useState<string[]>(() => {
    if (hints.detectedSystems.length > 0)
      return hints.detectedSystems.map(h => pickCBUSystem(h.kva, h.phase));
    return [CBU_SYSTEMS[0]];
  });
  const [project, setProject] = useState(cleanSubject);
  const [quote,   setQuote]   = useState('');
  const [smIdx,   setSmIdx]   = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [dlId,    setDlId]    = useState<string | null>(null);

  const sm = smIdx !== null ? CBU_SALESMEN[smIdx] : null;
  const ok = systems.length > 0 && !!project.trim() && !!quote.trim() && sm !== null;

  function updateSystem(i: number, v: string) {
    setSystems(prev => prev.map((s, idx) => idx === i ? v : s));
  }
  function removeSystem(i: number) {
    setSystems(prev => prev.filter((_, idx) => idx !== i));
  }
  function addSystem() {
    setSystems(prev => [...prev, CBU_SYSTEMS[0]]);
  }

  async function generate() {
    if (!ok || !sm) return;
    setLoading(true); setDlId(null);
    try {
      const res = await fetch('/api/run/cbu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systems, project: project.trim(), quote: quote.trim(), engineer: sm.name, email: sm.email, phone: sm.phone }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Server error');
      setDlId(json.id);
      toast('ok', `CBU Tech Sheet ready (${systems.length} system${systems.length > 1 ? 's' : ''})`);
    } catch (e: any) { toast('err', e.message); }
    setLoading(false);
  }

  async function download() {
    if (!dlId) return;
    const dl = await fetch(`/api/download/cbu/${dlId}`);
    const blob = await dl.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `CBU_Tech_Brief_${quote.trim()}.pdf`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Battery className="w-3.5 h-3.5 text-blue-500 shrink-0" />
        <p className="text-[11.5px] font-semibold text-ink-800 dark:text-ink-100 flex-1">CBU Tech Sheet Generator</p>
        {hints.detectedSystems.length > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-200 dark:ring-blue-700">
            {hints.detectedSystems.map(h => `${h.kva}kVA`).join(' + ')} detected
          </span>
        )}
      </div>

      {/* Systems list */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-semibold text-ink-400 uppercase tracking-wide flex-1">Systems</label>
          <button onClick={addSystem}
            className="inline-flex items-center gap-1 h-5 px-2 rounded text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
            <Plus className="w-2.5 h-2.5" />Add
          </button>
        </div>
        {systems.map((sys, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-400 w-4 text-right shrink-0">{i + 1}</span>
            <CBUSystemSelect value={sys} onChange={v => updateSystem(i, v)} />
            {systems.length > 1 && (
              <button onClick={() => removeSystem(i)}
                className="w-5 h-5 rounded flex items-center justify-center text-ink-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-semibold text-ink-400 uppercase tracking-wide">Project Name</label>
          <input value={project} onChange={e => setProject(e.target.value)} placeholder="Project name…"
            className="mt-1 w-full h-7 px-2.5 rounded-lg text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-blue-400" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-ink-400 uppercase tracking-wide">Quote Ref</label>
          <input value={quote} onChange={e => setQuote(e.target.value)} placeholder="Q-XXXX…"
            className="mt-1 w-full h-7 px-2.5 rounded-lg text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-blue-400" />
        </div>
        <div className="col-span-2">
          <label className="text-[10px] font-semibold text-ink-400 uppercase tracking-wide">Sales Engineer</label>
          <select value={smIdx ?? ''} onChange={e => setSmIdx(e.target.value === '' ? null : Number(e.target.value))}
            className="mt-1 w-full h-7 px-2 rounded-lg text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 focus:outline-none focus:ring-blue-400">
            <option value="">Select salesman…</option>
            {CBU_SALESMEN.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={generate} disabled={!ok || loading}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Battery className="w-3 h-3" />}
          Generate {systems.length > 1 ? `${systems.length} Sheets` : 'Tech Sheet'}
        </button>
        {dlId && (
          <button onClick={download}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors">
            <Download className="w-3 h-3" />Download PDF
          </button>
        )}
      </div>
    </div>
  );
}

function InlineELPricer({
  emailBody, entryId, attachments, toast,
}: {
  emailBody: string;
  entryId: string;
  attachments: AttachmentInfo[];
  toast: ToastFn;
}) {
  const [listText, setListText] = useState(() => extractMaterialHints(emailBody));
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<{ items: MiniPricedItem[]; total_ntp: number; unmatched: string[]; candidates?: MiniCandidate[] } | null>(null);
  const [copied, setCopied]     = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pdfSource, setPdfSource] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>(() => _pricerSchedule);
  const [schedCopied, setSchedCopied] = useState(false);

  const pricerAtts = attachments.filter(a => a.isPdf || isImageFile(a.name) || isExcelFile(a.name));

  async function run() {
    if (!listText.trim()) return;
    setLoading(true);
    setPdfSource(null);
    try {
      // Use multipart so the unified endpoint can auto-route descriptive text
      // through Gemini + Google Search and return candidate suggestions.
      const fd = new FormData();
      fd.append('text', listText);
      const resp = await fetch('/api/schematics/price', { method: 'POST', body: fd });
      const data = await resp.json();
      if (data.error) { toast('err', data.error); }
      else setResult(data);
    } catch (e: any) { toast('err', e.message); }
    setLoading(false);
  }

  function pickCandidate(c: MiniCandidate) {
    if (!c.matched || c.ntp == null) {
      toast('warn', `${c.cat_no} is not in the price list`);
      return;
    }
    const qty = c.suggested_qty && c.suggested_qty > 0 ? c.suggested_qty : 1;
    const newItem: MiniPricedItem = {
      ref:        '',
      cat_no:     c.cat_no,
      description: c.description,
      qty,
      ntp:        c.ntp,
      line_ntp:   Math.round(c.ntp * qty * 100) / 100,
      matched:    true,
      match_type: 'exact',
      original_input: c.cat_no,
      status:     c.status || '',
    };
    setResult(prev => {
      if (!prev) return { items: [newItem], total_ntp: newItem.line_ntp, unmatched: [], candidates: [] };
      const items = [...prev.items, newItem];
      return {
        ...prev,
        items,
        total_ntp: items.filter(i => i.matched).reduce((s, i) => s + i.line_ntp, 0),
      };
    });
    toast('ok', `Added ${c.cat_no} × ${qty}`);
  }

  async function priceFromAttachment(attIndex: number, attName: string, isImage = false) {
    setLoading(true);
    setResult(null);
    setPdfSource(attName);
    try {
      const resp = await fetch('/api/outlook/attachment-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, index: attIndex, isImage }),
      });
      const data = await resp.json();
      if (data.error) { toast('err', data.error); setPdfSource(null); }
      else setResult(data);
    } catch (e: any) { toast('err', e.message); setPdfSource(null); }
    setLoading(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.types.includes('vector/attachment')) setDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    try {
      const raw = e.dataTransfer.getData('vector/attachment');
      if (!raw) return;
      const { attIndex, attName, isImage } = JSON.parse(raw);
      priceFromAttachment(attIndex, attName, !!isImage);
    } catch {}
  }

  function addToSchedule() {
    if (!result) return;
    const matched = result.items.filter(i => i.matched);
    if (!matched.length) return;
    const entry: ScheduleEntry = {
      source:    pdfSource || 'Manual list',
      items:     matched,
      total_ntp: matched.reduce((s, i) => s + i.line_ntp, 0),
    };
    const updated = [..._pricerSchedule.filter(e => e.source !== entry.source), entry];
    _pricerSchedule = updated;
    setSchedule(updated);
    toast('ok', `Added ${matched.length} item${matched.length !== 1 ? 's' : ''} to schedule`);
  }

  function clearSchedule() {
    _pricerSchedule = [];
    setSchedule([]);
  }

  function copyFullSchedule() {
    if (!schedule.length) return;
    const allItems = schedule.flatMap(e => e.items);
    const grandTotal = schedule.reduce((s, e) => s + e.total_ntp, 0);
    const lines = [
      'MATERIAL SCHEDULE — EATON EMERGENCY LIGHTING',
      '─'.repeat(70),
      `${'Ref'.padEnd(8)} ${'Catalogue No'.padEnd(18)} ${'Description'.padEnd(36)} ${'Qty'.padStart(4)} ${'NTP/Unit'.padStart(10)} ${'Line NTP'.padStart(10)}`,
      '─'.repeat(70),
    ];
    for (const entry of schedule) {
      if (schedule.length > 1) lines.push(`  [${entry.source}]`);
      for (const i of entry.items) {
        lines.push(
          `${(i.ref || '').padEnd(8)} ${i.cat_no.padEnd(18)} ${i.description.slice(0, 35).padEnd(36)} ${String(i.qty).padStart(4)} ${fmtGBP(i.ntp).padStart(10)} ${fmtGBP(i.line_ntp).padStart(10)}`
        );
      }
    }
    lines.push('─'.repeat(70));
    lines.push(`${'TOTAL NTP'.padEnd(68)} ${fmtGBP(grandTotal).padStart(10)}`);
    lines.push('');
    lines.push('Prices: Eaton EL Global Price List July 2026 (valid from 1 July 2026). Ex VAT. Subject to confirmation.');
    navigator.clipboard.writeText(lines.join('\n'));
    setSchedCopied(true);
    setTimeout(() => setSchedCopied(false), 2000);
    toast('ok', 'Full schedule copied');
  }

  function copySchedule() {
    if (!result) return;
    const matched = result.items.filter(i => i.matched);
    const src = pdfSource ? `Source: ${pdfSource}` : 'Source: manual list';
    const lines = [
      `MATERIAL SCHEDULE — EATON EMERGENCY LIGHTING`,
      `${'─'.repeat(70)}`,
      `${'Ref'.padEnd(8)} ${'Catalogue No'.padEnd(18)} ${'Description'.padEnd(36)} ${'Qty'.padStart(4)} ${'NTP/Unit'.padStart(10)}`,
      `${'─'.repeat(70)}`,
      ...matched.map(i =>
        `${(i.ref || '').padEnd(8)} ${i.cat_no.padEnd(18)} ${i.description.slice(0, 35).padEnd(36)} ${String(i.qty).padStart(4)} ${fmtGBP(i.ntp).padStart(10)}`
      ),
      `${'─'.repeat(70)}`,
      '',
      'Prices: Eaton EL Global Price List July 2026 (valid from 1 July 2026). Ex VAT. Subject to confirmation.',
      src,
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast('ok', 'Material schedule copied');
  }

  const matched   = result?.items.filter(i => i.matched) || [];
  const unmatched = result?.items.filter(i => !i.matched) || [];

  return (
    <div
      className={cn(
        'rounded-xl ring-1 ring-inset p-4 space-y-3 transition-colors',
        dragOver
          ? 'bg-amber-50/70 dark:bg-amber-900/20 ring-amber-400 dark:ring-amber-500'
          : 'bg-white dark:bg-ink-900 ring-amber-200/70 dark:ring-amber-700/30',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}>

      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-6 h-6 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0">
          <Zap className="w-3 h-3 text-amber-500" />
        </div>
        <p className="text-[12px] font-semibold text-ink-800 dark:text-ink-100">EL Material Pricer</p>
        {pdfSource
          ? <span className="text-[10px] text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20 px-2 py-0.5 rounded-full ring-1 ring-inset ring-brand-200 dark:ring-brand-700/30 truncate max-w-[200px]">{pdfSource}</span>
          : <span className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full ring-1 ring-inset ring-amber-200 dark:ring-amber-700/30">detected</span>}
      </div>

      {/* Attachment chips — PDF and images */}
      {pricerAtts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-0.5">
          {pricerAtts.map(a => {
            const img = isImageFile(a.name);
            const xls = isExcelFile(a.name);
            return (
              <button
                key={a.index}
                onClick={() => priceFromAttachment(a.index, a.name, img)}
                disabled={loading}
                title={`Price ${a.name} with AI`}
                className={cn(
                  'inline-flex items-center gap-1.5 h-6 pl-2 pr-2.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset disabled:opacity-50 transition-colors cursor-pointer',
                  xls
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 ring-green-200 dark:ring-green-700/30 hover:bg-green-100 dark:hover:bg-green-900/40'
                    : img
                      ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-700/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/40'
                      : 'bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 ring-brand-200 dark:ring-brand-700/30 hover:bg-brand-100 dark:hover:bg-brand-900/40',
                )}>
                {xls ? <FileSpreadsheet className="w-3 h-3 shrink-0" /> : img ? <ImageIcon className="w-3 h-3 shrink-0" /> : <FileText className="w-3 h-3 shrink-0" />}
                <span className="truncate max-w-[160px]">{a.name}</span>
                <span className="opacity-50 ml-0.5">→ Price</span>
              </button>
            );
          })}
          <span className="text-[10px] text-ink-400 dark:text-ink-500 self-center ml-1">or drag here</span>
        </div>
      )}

      {/* Drop zone highlight */}
      {dragOver && (
        <div className="flex items-center justify-center h-10 rounded-lg border-2 border-dashed border-amber-400 dark:border-amber-500 text-[11.5px] font-medium text-amber-600 dark:text-amber-400">
          Drop PDF, image or Excel to price
        </div>
      )}

      {/* Loading state for PDF pricing */}
      {loading && pdfSource && (
        <div className="flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400 py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          Extracting items from {pdfSource} via AI…
        </div>
      )}

      {/* Manual text input (shown when not in PDF mode or alongside) */}
      {!pdfSource && (
        <textarea
          value={listText}
          onChange={e => setListText(e.target.value)}
          placeholder={`Paste material list here…\nMP2ES230CGS, 6\nNXL100, 12`}
          rows={3}
          className="w-full rounded-lg bg-ink-50 dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 p-2.5 text-[11.5px] font-mono focus:outline-none focus:ring-brand-400 resize-none placeholder:text-ink-300 dark:placeholder:text-ink-600"
        />
      )}

      {/* Action row */}
      <div className="flex items-center gap-2 flex-wrap">
        {!pdfSource && (
          <button
            onClick={run} disabled={loading || !listText.trim()}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {loading ? 'Pricing…' : 'Get NTP Prices'}
          </button>
        )}
        {pdfSource && !loading && (
          <button
            onClick={() => { setResult(null); setPdfSource(null); }}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-ink-500 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors">
            ← Manual input
          </button>
        )}
        {result && matched.length > 0 && (
          <>
            <button
              onClick={addToSchedule}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-emerald-500 hover:bg-emerald-600 text-white transition-colors">
              <Plus className="w-3 h-3" />
              Add to Schedule
            </button>
            <button
              onClick={copySchedule}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-medium ring-1 ring-inset ring-ink-200 dark:ring-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors">
              {copied ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <FileText className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy result'}
            </button>
          </>
        )}
        {result && (
          <span className="text-[10.5px] text-ink-400">
            {matched.length} matched{unmatched.length > 0 ? ` · ${unmatched.length} not found` : ''}
          </span>
        )}
      </div>

      {/* Candidate suggestions (descriptive search) */}
      {result && result.candidates && result.candidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-ink-500 dark:text-ink-400 uppercase tracking-wide">
            Suggested matches · pick to add
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {result.candidates.map((c, idx) => {
              const tone = c.confidence === 'high'
                ? 'bg-emerald-50 dark:bg-emerald-900/20 ring-emerald-200 dark:ring-emerald-800/40'
                : c.confidence === 'low'
                  ? 'bg-amber-50 dark:bg-amber-900/20 ring-amber-200 dark:ring-amber-800/40'
                  : 'bg-ink-50 dark:bg-ink-800/40 ring-ink-200 dark:ring-ink-700';
              return (
                <div key={`${c.cat_no}-${idx}`} className={cn('rounded-lg ring-1 ring-inset p-2.5 text-[11px]', tone)}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="text-[9.5px] font-semibold uppercase tracking-wide text-ink-500">
                          {c.confidence || 'med'}
                        </span>
                        {c.matched
                          ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">in list</span>
                          : <span className="text-[9px] px-1 py-0.5 rounded bg-ink-200 dark:bg-ink-700 text-ink-600">not priced</span>}
                        {c.suggested_qty && c.suggested_qty > 1 && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300">qty {c.suggested_qty}</span>
                        )}
                      </div>
                      <p className="font-mono text-[11.5px] font-semibold text-ink-800 dark:text-ink-100 truncate">{c.cat_no}</p>
                      {c.family && <p className="text-[10.5px] text-brand-600 dark:text-brand-400 truncate">{c.family}</p>}
                      {c.description && <p className="text-[10.5px] text-ink-600 dark:text-ink-300 line-clamp-2">{c.description}</p>}
                      {c.reasoning && <p className="text-[10px] text-ink-500 dark:text-ink-400 italic mt-0.5 line-clamp-2">"{c.reasoning}"</p>}
                    </div>
                    {c.matched && c.ntp != null && (
                      <div className="text-right shrink-0">
                        <p className="text-[9px] uppercase text-ink-400">NTP</p>
                        <p className="text-[12.5px] font-semibold tabular-nums">{fmtGBP(c.ntp)}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      onClick={() => pickCandidate(c)}
                      disabled={!c.matched}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white transition-colors">
                      <Plus className="w-2.5 h-2.5" /> Add
                    </button>
                    {c.source_url && (
                      <a href={c.source_url} target="_blank" rel="noreferrer"
                         className="inline-flex items-center h-6 px-2 rounded text-[10.5px] text-brand-600 dark:text-brand-400 hover:underline">
                        source ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Results table */}
      {result && matched.length > 0 && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-ink-100 dark:ring-ink-800">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-ink-50 dark:bg-ink-900 text-[10px] text-ink-400 font-semibold uppercase tracking-wide">
                <th className="px-3 py-1.5 text-left">Catalogue No</th>
                <th className="px-3 py-1.5 text-left">Description</th>
                <th className="px-3 py-1.5 text-right">Qty</th>
                <th className="px-3 py-1.5 text-right">NTP/Unit</th>
              </tr>
            </thead>
            <tbody>
              {matched.map((item, i) => (
                <tr key={i} className="border-t border-ink-50 dark:border-ink-800/60">
                  <td className="px-3 py-1.5">
                    <span className="font-mono font-semibold text-brand-700 dark:text-brand-400">{item.cat_no}</span>
                    {item.original_input && item.original_input !== item.cat_no && (
                      <span className="ml-1.5 text-[9.5px] text-amber-500 font-mono">← {item.original_input}</span>
                    )}
                    {item.search_note && (
                      <span className="ml-1.5 text-[9px] bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 px-1 py-0.5 rounded">Google</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-ink-600 dark:text-ink-300 max-w-[200px] truncate">{item.description}</td>
                  <td className="px-3 py-1.5 text-right text-ink-600 dark:text-ink-300">{item.qty}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-800 dark:text-ink-100">{fmtGBP(item.ntp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Unmatched items with closest matches */}
      {result && unmatched.length > 0 && (
        <div className="rounded-lg ring-1 ring-inset ring-red-100 dark:ring-red-900/30 overflow-hidden">
          <div className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
            {unmatched.length} not found in price list
          </div>
          {unmatched.map((item, i) => (
            <div key={i} className="border-t border-red-50 dark:border-red-900/20 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[11px] font-semibold text-red-700 dark:text-red-400">{item.cat_no}</span>
                {item.description && <span className="text-[10.5px] text-ink-500 dark:text-ink-400 truncate">{item.description}</span>}
                {item.status === 'Non-Eaton' && (
                  <span className="text-[9px] bg-ink-100 dark:bg-ink-800 text-ink-500 px-1.5 py-0.5 rounded">Non-Eaton</span>
                )}
                {item.search_note && (
                  <span className="text-[9.5px] text-ink-400 italic truncate max-w-[200px]">{item.search_note}</span>
                )}
              </div>
              {item.closest_matches && item.closest_matches.length > 0 && (
                <div className="space-y-0.5">
                  <p className="text-[9.5px] text-ink-400 dark:text-ink-500 font-medium">Closest in price list:</p>
                  {item.closest_matches.map((m, j) => (
                    <div key={j} className="flex items-center gap-2 text-[10px]">
                      <span className="font-mono text-brand-600 dark:text-brand-400">{m.cat_no}</span>
                      <span className="text-ink-500 dark:text-ink-400 truncate flex-1">{m.description}</span>
                      {m.ntp > 0 && <span className="font-mono text-ink-600 dark:text-ink-300 shrink-0">{fmtGBP(m.ntp)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Accumulated schedule */}
      {schedule.length > 0 && (
        <div className="rounded-lg ring-1 ring-inset ring-emerald-200 dark:ring-emerald-800/40 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20">
            <p className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide flex-1">
              Schedule · {schedule.reduce((s, e) => s + e.items.length, 0)} items · {fmtGBP(schedule.reduce((s, e) => s + e.total_ntp, 0))} NTP
            </p>
            <button
              onClick={copyFullSchedule}
              className="inline-flex items-center gap-1 h-5 px-2 rounded text-[10px] font-semibold bg-emerald-500 hover:bg-emerald-600 text-white transition-colors">
              {schedCopied ? <CheckCircle2 className="w-2.5 h-2.5" /> : <FileText className="w-2.5 h-2.5" />}
              {schedCopied ? 'Copied!' : 'Copy all'}
            </button>
            <button
              onClick={clearSchedule}
              className="h-5 px-1.5 rounded text-[10px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              Clear
            </button>
          </div>
          {schedule.map((entry, ei) => (
            <div key={ei} className="border-t border-emerald-100 dark:border-emerald-900/30">
              {schedule.length > 1 && (
                <div className="px-3 py-1 text-[10px] font-medium text-ink-500 dark:text-ink-400 bg-ink-50/50 dark:bg-ink-900/30">{entry.source}</div>
              )}
              {entry.items.map((item, ii) => (
                <div key={ii} className="flex items-center gap-2 px-3 py-1 text-[10.5px] border-t border-emerald-50 dark:border-emerald-900/20 first:border-t-0">
                  <span className="font-mono text-brand-700 dark:text-brand-400 shrink-0">{item.cat_no}</span>
                  <span className="text-ink-500 dark:text-ink-400 flex-1 truncate">{item.description}</span>
                  <span className="text-ink-500 dark:text-ink-400 shrink-0">×{item.qty}</span>
                  <span className="font-mono text-ink-700 dark:text-ink-200 shrink-0">{fmtGBP(item.line_ntp)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Compose Modal ────────────────────────────────────────────────────────────
function ComposeModal({ onClose, toast }: { onClose: () => void; toast: ToastFn }) {
  const [to, setTo]           = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [atts, setAtts]       = useState<AttachSuggestion[]>([]);
  const [suggestions, setSuggestions]       = useState<AttachSuggestion[]>([]);
  const [loadingSugg, setLoadingSugg]       = useState(false);
  const [searchedQ, setSearchedQ]           = useState('');
  const [sending, setSending] = useState(false);

  async function searchAtts() {
    if (!subject.trim()) { toast('warn', 'Enter a subject first'); return; }
    const q = subject;
    setLoadingSugg(true);
    setSearchedQ(q);
    try {
      const r = await api.outlookSuggestAtts(q);
      setSuggestions(r.results || []);
    } catch {}
    setLoadingSugg(false);
  }

  async function send() {
    if (!to.trim() || !subject.trim()) { toast('warn', 'To and Subject are required'); return; }
    setSending(true);
    try {
      const r = await api.outlookSendNew(to.trim(), subject.trim(), body, atts.map(a => ({ entryId: a.sourceEntryId, index: a.attachmentIndex })));
      if (r.error) { toast('err', 'Send failed: ' + r.error); }
      else { toast('ok', 'Email sent'); onClose(); }
    } catch (e: any) { toast('err', e.message); }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-[9980] bg-black/50 flex items-end sm:items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl bg-white dark:bg-ink-900 rounded-2xl shadow-2xl ring-1 ring-inset ring-ink-200 dark:ring-ink-600 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-ink-200 dark:border-ink-700">
          <PenLine className="w-4 h-4 text-ink-400 shrink-0" />
          <p className="text-[13px] font-semibold flex-1">New Email</p>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className="text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide">To</label>
            <input value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com"
              className="mt-1 w-full h-8 px-3 rounded-lg text-[12.5px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-violet-400" />
          </div>
          <div>
            <label className="text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject…"
              className="mt-1 w-full h-8 px-3 rounded-lg text-[12.5px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-violet-400" />
          </div>
          <div>
            <label className="text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide">Message</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="Write your message…"
              className="mt-1 w-full px-3 py-2.5 rounded-lg text-[12.5px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-violet-400 resize-none" />
          </div>
          {/* Attachments */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide flex-1">Attachments from Outlook</label>
              <button onClick={searchAtts} disabled={loadingSugg}
                className="inline-flex items-center gap-1 h-6 px-2.5 rounded-md text-[10.5px] font-medium bg-ink-100 dark:bg-ink-800 hover:bg-ink-200 dark:hover:bg-ink-700 text-ink-600 dark:text-ink-300 transition-colors disabled:opacity-50">
                {loadingSugg ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                {loadingSugg ? 'Searching…' : 'Search'}
              </button>
            </div>
            {atts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {atts.map((a, i) => (
                  <span key={i} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md text-[10.5px] bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-700/40">
                    <FileText className="w-3 h-3 shrink-0" />
                    <span className="max-w-[160px] truncate">{a.attachmentName}</span>
                    <button onClick={() => setAtts(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {suggestions.filter(s => !atts.some(a => a.sourceEntryId === s.sourceEntryId && a.attachmentIndex === s.attachmentIndex)).map((s, i) => (
                  <button key={i} onClick={() => setAtts(prev => [...prev, s])}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-left hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors ring-1 ring-inset ring-ink-100 dark:ring-ink-700">
                    <FileText className="w-3 h-3 text-brand-500 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium text-ink-700 dark:text-ink-200 truncate block">{s.attachmentName}</span>
                      <span className="text-ink-400 dark:text-ink-500 truncate block">{s.emailSubject}</span>
                    </span>
                    <Plus className="w-3 h-3 text-ink-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
            {searchedQ && !loadingSugg && suggestions.length === 0 && (
              <p className="text-[11px] text-ink-400 dark:text-ink-500">No matching PDFs found in Outlook for "{searchedQ}"</p>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-ink-200 dark:border-ink-700 flex items-center gap-2">
          <button onClick={send} disabled={sending || !to.trim() || !subject.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-lg text-[12.5px] font-semibold bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-700 dark:hover:bg-ink-100 disabled:opacity-50 transition-colors">
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? 'Sending…' : 'Send'}
          </button>
          <button onClick={onClose} className="h-8 px-3 rounded-lg text-[12px] text-ink-500 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Email Detail Panel — one instance per open tab ──────────────────────────
function EmailDetailPanel({
  initialEntryId,
  emailList,
  toast,
  setAppTab,
  onMarkRead,
  onLabelChange,
}: {
  initialEntryId: string;
  emailList: EmailSummary[];
  toast: ToastFn;
  setAppTab: (t: string) => void;
  onMarkRead: (entryId: string) => void;
  onLabelChange: (label: string) => void;
}) {
  const [entryId, setEntryId]             = useState(initialEntryId);
  const [detail, setDetail]               = useState<EmailDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [analysis, setAnalysis]           = useState(() => _summaryCache[initialEntryId] || '');
  const [analyzing, setAnalyzing]         = useState(false);
  // Attachments (real files, incl. PDFs) the user opted into feeding the AI.
  const [included, setIncluded]           = useState<Set<number>>(new Set());
  const [savingPdf, setSavingPdf]         = useState(false);
  const [draft, setDraft]                 = useState('');
  const [draftingReply, setDraftingReply] = useState(false);
  const [replyText, setReplyText]         = useState(() => {
    try { return localStorage.getItem(`inbox_draft_${initialEntryId}`) || ''; } catch { return ''; }
  });
  const [editingReply, setEditingReply]   = useState(() => {
    try { return !!localStorage.getItem(`inbox_draft_${initialEntryId}`); } catch { return false; }
  });
  const [sendingReply, setSendingReply]             = useState(false);
  const [replySent, setReplySent]                   = useState(false);
  const [analysisLiked, setAnalysisLiked]           = useState<'up' | 'down' | null>(null);
  const [lightbox, setLightbox]                     = useState<{ src: string; name: string } | null>(null);
  const [chatMessages, setChatMessages]             = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [chatInput, setChatInput]                   = useState('');
  const [chatLoading, setChatLoading]               = useState(false);
  const [activePanel, setActivePanel]               = useState<'summarize' | 'reply' | 'reply-attach' | 'pricer' | 'cbu' | 'quote' | null>(null);
  const [attachSuggestions, setAttachSuggestions]   = useState<AttachSuggestion[]>([]);
  const [loadingSugg, setLoadingSugg]               = useState(false);
  const [selectedAtts, setSelectedAtts]             = useState<AttachSuggestion[]>([]);
  const [replyAttachText, setReplyAttachText]       = useState('');
  const [sendingWithAtts, setSendingWithAtts]       = useState(false);
  const bodyRef    = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── EL Pricer panel height resize ────────────────────────────────────────
  const [panelHeight, setPanelHeight]     = useState(() => {
    const s = localStorage.getItem('inbox_panel_height');
    return s ? parseInt(s, 10) : 288;
  });
  const [panelMaximized, setPanelMaximized] = useState(false);
  const panelRef          = useRef<HTMLDivElement>(null);
  const panelResizingRef  = useRef(false);
  const panelResizeStartY = useRef(0);
  const panelResizeStartH = useRef(288);
  // While dragging a resize handle, a full-screen overlay sits above the email
  // iframe so mousemove keeps reaching the document (iframes otherwise swallow
  // the events, which is what made resizing stutter/jump).
  const [resizeMode, setResizeMode] = useState<null | 'panel' | 'att'>(null);

  // ── Attachment strip height resize ───────────────────────────────────────
  const [attStripHeight, setAttStripHeight] = useState(() => {
    const s = localStorage.getItem('inbox_att_height');
    return s ? parseInt(s, 10) : 80;
  });
  const attStripRef      = useRef<HTMLDivElement>(null);
  const attResizingRef   = useRef(false);
  const attResizeStartY  = useRef(0);
  const attResizeStartH  = useRef(80);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (panelResizingRef.current) {
        const h = Math.max(120, Math.min(800, panelResizeStartH.current - (e.clientY - panelResizeStartY.current)));
        if (panelRef.current) panelRef.current.style.height = h + 'px';
      }
      if (attResizingRef.current) {
        const h = Math.max(36, Math.min(400, attResizeStartH.current + (e.clientY - attResizeStartY.current)));
        if (attStripRef.current) attStripRef.current.style.maxHeight = h + 'px';
      }
    }
    function onMouseUp() {
      if (panelResizingRef.current) {
        panelResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (panelRef.current) {
          const h = panelRef.current.offsetHeight;
          setPanelHeight(h);
          localStorage.setItem('inbox_panel_height', String(h));
        }
      }
      if (attResizingRef.current) {
        attResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (attStripRef.current) {
          const h = attStripRef.current.offsetHeight;
          setAttStripHeight(h);
          localStorage.setItem('inbox_att_height', String(h));
        }
      }
      setResizeMode(null);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    const key = `inbox_draft_${initialEntryId}`;
    if (replyText.trim()) { try { localStorage.setItem(key, replyText); } catch {} }
    else                  { try { localStorage.removeItem(key); } catch {} }
  }, [replyText, initialEntryId]);

  useEffect(() => { fetchDetail(entryId); }, [entryId]);

  async function fetchDetail(id: string) {
    setDetail(null);
    setAnalysis(_summaryCache[id] || '');
    setDraft(''); setReplyText(''); setEditingReply(false);
    setReplySent(false); setAnalysisLiked(null);
    setChatMessages([]); setChatInput('');
    setActivePanel(null); setIncluded(new Set());
    setAttachSuggestions([]); setSelectedAtts([]);
    setLoadingDetail(true);
    bodyRef.current?.scrollTo({ top: 0 });
    try {
      const r = await api.outlookEmail(id) as EmailDetail & { error?: string };
      if (r.error) { toast('warn', r.error); setLoadingDetail(false); return; }
      setDetail(r);
      // Pre-check the inline photos we'll auto-read, so the panel reflects reality
      // and the user can uncheck logos or add attachments before summarizing/chatting.
      setIncluded(new Set(autoInlineIndices(r)));
      onMarkRead(id);
      onLabelChange(r.subject);
      // Pull the persisted summary (survives restart) if we don't have it in-session.
      if (!_summaryCache[id]) {
        try {
          const s = await api.outlookGetSummary(id);
          if (s.summary) { _summaryCache[id] = s.summary; setAnalysis(s.summary); }
        } catch { /* no persisted summary — fine */ }
      }
    } catch (e: any) { toast('err', e.message); }
    setLoadingDetail(false);
  }

  const emailIdx  = emailList.findIndex(e => e.entryId === entryId);
  const prevEmail = emailIdx > 0 ? emailList[emailIdx - 1] : null;
  const nextEmail = emailIdx < emailList.length - 1 ? emailList[emailIdx + 1] : null;

  // Inline body images (photos/screenshots pasted into the email) are fed to the
  // AI automatically. Tiny inline images (< 12 KB) are almost always logos or
  // signature icons, so we skip those. Real attachments join only when the user
  // opts in by clicking them in the Summarize panel.
  function autoInlineIndices(emailData: EmailDetail): number[] {
    return emailData.attachments
      .filter(a => a.isInline && a.isImage && a.size >= 12_000)
      .map(a => a.index);
  }
  // What actually gets fed to the AI = exactly what's checked in the panel
  // (seeded from autoInlineIndices on load, then user-editable).
  function effectiveInclude(_emailData: EmailDetail): number[] {
    return Array.from(included).sort((a, b) => a - b);
  }

  async function runSummarize(emailData: EmailDetail, force = false) {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      const r = await runTask(force ? 'Re-summarizing…' : 'Summarizing…', s => api.outlookSummarize({
        entryId: emailData.entryId,
        subject: emailData.subject, sender: emailData.sender,
        senderEmail: emailData.senderEmail, received: emailData.received,
        body: emailData.body, attachments: emailData.attachments,
        includeIndices: effectiveInclude(emailData), force,
      }, s));
      const text = r.summary || r.error || 'No summary returned.';
      setAnalysis(text);
      _summaryCache[emailData.entryId] = text;
      if (r.imagesRead) toast('info', `Read ${r.imagesRead} image${r.imagesRead !== 1 ? 's' : ''} from the email`);
    } catch (e: any) { if (!isCancel(e)) setAnalysis(`Error: ${e.message}`); }
    setAnalyzing(false);
  }

  async function draftReply(emailData: EmailDetail) {
    setDraftingReply(true);
    setDraft(''); setReplyText(''); setEditingReply(false); setReplySent(false);
    try {
      const r = await runTask('Drafting reply…', s => api.outlookDraftReply({
        subject: emailData.subject, sender: emailData.sender,
        senderEmail: emailData.senderEmail, received: emailData.received,
        body: emailData.body, analysis,
      }, s));
      if (r.error) { toast('warn', r.error); }
      else { setDraft(r.draft || ''); setReplyText(r.draft || ''); }
    } catch (e: any) { if (!isCancel(e)) toast('err', e.message); }
    setDraftingReply(false);
  }

  async function sendReply() {
    if (!detail || !replyText.trim()) return;
    setSendingReply(true);
    try {
      const r = await api.outlookSendReply(detail.entryId, replyText.trim());
      if (r.error) { toast('err', 'Send failed: ' + r.error); }
      else {
        setReplySent(true);
        try { localStorage.removeItem(`inbox_draft_${initialEntryId}`); } catch {}
        toast('ok', `Reply sent to ${detail.senderEmail}`);
        const edited = replyText.trim() !== draft.trim();
        await api.outlookFeedback({
          entryId: detail.entryId, subject: detail.subject,
          senderEmail: detail.senderEmail, draftReply: draft,
          finalReply: replyText.trim(), feedbackType: edited ? 'edited_sent' : 'sent',
        });
      }
    } catch (e: any) { toast('err', e.message); }
    setSendingReply(false);
  }

  async function sendReplyWithAtts() {
    if (!detail || !replyAttachText.trim()) return;
    setSendingWithAtts(true);
    try {
      const r = await api.outlookReplyWithAtts(
        detail.entryId,
        replyAttachText.trim(),
        selectedAtts.map(a => ({ entryId: a.sourceEntryId, index: a.attachmentIndex }))
      );
      if (r.error) { toast('err', 'Send failed: ' + r.error); }
      else {
        toast('ok', `Reply sent with ${selectedAtts.length} attachment${selectedAtts.length !== 1 ? 's' : ''}`);
        setActivePanel(null);
        setSelectedAtts([]);
        setReplyAttachText('');
      }
    } catch (e: any) { toast('err', e.message); }
    setSendingWithAtts(false);
  }

  async function submitAnalysisFeedback(type: 'up' | 'down') {
    if (!detail || analysisLiked) return;
    setAnalysisLiked(type);
    await api.outlookFeedback({
      entryId: detail.entryId, subject: detail.subject, senderEmail: detail.senderEmail,
      feedbackType: type === 'up' ? 'liked_analysis' : 'disliked_analysis',
    }).catch(() => {});
  }

  async function sendChatMessage() {
    if (!detail || !chatInput.trim() || chatLoading) return;
    const question = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user' as const, text: question }]);
    setChatLoading(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const r = await runTask('Assistant thinking…', s => api.outlookChat({
        entryId: detail.entryId,
        subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
        body: detail.body, analysis, history: chatMessages, question,
        includeIndices: effectiveInclude(detail),
      }, s));
      setChatMessages(prev => [...prev, { role: 'ai', text: r.answer || r.error || 'No response.' }]);
    } catch (e: any) {
      if (!isCancel(e)) setChatMessages(prev => [...prev, { role: 'ai', text: 'Error: ' + e.message }]);
    }
    setChatLoading(false);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  async function loadAttachSuggestions(emailData: EmailDetail) {
    const sfMatch = (emailData.subject + ' ' + emailData.body).match(/SR00[A-Za-z0-9]+/i);
    const q = sfMatch ? sfMatch[0] + ' ' + emailData.subject : emailData.subject;
    setLoadingSugg(true);
    setAttachSuggestions([]);
    try {
      const r = await api.outlookSuggestAtts(q);
      setAttachSuggestions(r.results || []);
    } catch {}
    setLoadingSugg(false);
  }

  async function queuePdf() {
    if (!detail) return;
    setSavingPdf(true);
    try {
      const r = await api.outlookSaveAttachment(detail.entryId);
      if (r.error) { toast('err', r.error); }
      else if (r.count === 0) { toast('warn', 'No PDF attachments found'); }
      else { toast('ok', `Queued: ${r.saved.map((s: any) => s.name).join(', ')}`); }
    } catch (e: any) { toast('err', e.message); }
    setSavingPdf(false);
  }

  function togglePanel(p: typeof activePanel) {
    const next = activePanel === p ? null : p;
    setActivePanel(next);
    if (next === 'summarize' && !_summaryCache[entryId] && detail && !analyzing) {
      runSummarize(detail);
    }
    if (next === 'reply' && !draft && detail && !draftingReply) {
      draftReply(detail);
    }
    if (next === 'reply-attach' && detail) {
      setReplyAttachText(replyText || '');
      if (attachSuggestions.length === 0 && !loadingSugg) loadAttachSuggestions(detail);
    }
  }

  function ABtn({ panel, icon: Icon, label, color, locked }: { panel: NonNullable<typeof activePanel>; icon: React.ComponentType<{className?: string}>; label: string; color?: string; locked?: boolean }) {
    const active = activePanel === panel;
    if (locked) {
      return (
        <button onClick={() => toast('info', `${label} — coming soon`)} title="Coming soon"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium ring-1 ring-inset transition-colors text-ink-400 dark:text-ink-600 ring-ink-200/60 dark:ring-ink-700/50 hover:bg-ink-50 dark:hover:bg-ink-800/50 cursor-default">
          <Icon className="w-3 h-3 shrink-0 opacity-60" />
          {label}
          <Lock className="w-2.5 h-2.5 shrink-0 opacity-60" />
        </button>
      );
    }
    return (
      <button onClick={() => togglePanel(panel)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium ring-1 ring-inset transition-colors',
          active
            ? `bg-${color || 'violet'}-100 dark:bg-${color || 'violet'}-900/30 text-${color || 'violet'}-700 dark:text-${color || 'violet'}-300 ring-${color || 'violet'}-200 dark:ring-${color || 'violet'}-600`
            : 'text-ink-600 dark:text-ink-300 ring-ink-200 dark:ring-ink-600 hover:bg-ink-50 dark:hover:bg-ink-800',
        )}>
        <Icon className="w-3 h-3 shrink-0" />
        {label}
      </button>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {lightbox && <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />}
      {/* Drag shield — captures the mouse over the email iframe so resizing is smooth */}
      {resizeMode && <div className="fixed inset-0 z-[9999]" style={{ cursor: resizeMode === 'panel' ? 'row-resize' : 'ns-resize' }} />}

      {loadingDetail ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-ink-300" />
        </div>
      ) : detail ? (
        <>
          {/* ── Compact header ──────────────────────────────────────────────── */}
          <div className="shrink-0 px-5 pt-4 pb-3 border-b border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900">
            {/* Nav + counter */}
            <div className="flex items-center gap-1 mb-2">
              <button onClick={() => prevEmail && setEntryId(prevEmail.entryId)} disabled={!prevEmail} title={prevEmail?.subject}
                className="w-6 h-6 rounded flex items-center justify-center text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-25 transition-colors">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => nextEmail && setEntryId(nextEmail.entryId)} disabled={!nextEmail} title={nextEmail?.subject}
                className="w-6 h-6 rounded flex items-center justify-center text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-25 transition-colors">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              {emailIdx >= 0 && <span className="text-[10px] text-ink-400 ml-1 num">{emailIdx + 1} / {emailList.length}</span>}
            </div>

            {/* Subject */}
            <h2 className="text-[15px] font-bold text-ink-900 dark:text-ink-50 leading-snug mb-1.5">{detail.subject}</h2>

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-500 dark:text-ink-400">
              <span className="w-6 h-6 rounded-full bg-gradient-to-br from-ink-300 to-ink-500 dark:from-ink-600 dark:to-ink-800 flex items-center justify-center text-[9px] font-bold text-white shrink-0">
                {detail.sender.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <span className="font-medium text-ink-700 dark:text-ink-200">{detail.sender}</span>
              <span className="text-ink-400 dark:text-ink-500">&lt;{detail.senderEmail}&gt;</span>
              {detail.to && <span>→ {detail.to}</span>}
              {detail.cc && <span className="truncate max-w-[200px]">CC: {detail.cc}</span>}
              <span className="ml-auto shrink-0 text-ink-400 dark:text-ink-500">
                {(() => { try { return new Date(detail.received).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return detail.received; } })()}
              </span>
            </div>

            {/* Attachments strip */}
            {detail.attachments.length > 0 && (
              <div className="mt-2.5 pt-2.5 border-t border-ink-100 dark:border-ink-700">
                <div
                  ref={attStripRef}
                  className="flex flex-wrap gap-1.5 overflow-y-auto"
                  style={{ maxHeight: attStripHeight }}>
                  {detail.attachments.map(att => (
                    att.isPdf ? (
                      <button key={att.index} onClick={() => openAttachmentPdf(detail.entryId, att.index)}
                        draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name })); e.dataTransfer.effectAllowed = 'copy'; }}
                        title="View · Drag to EL Pricer"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset cursor-pointer select-none bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 ring-brand-200 dark:ring-brand-600 hover:bg-brand-100 dark:hover:bg-brand-900/40 transition-colors">
                        <FileText className="w-2.5 h-2.5 shrink-0" />{att.name}<span className="opacity-50 ml-0.5">{fmtSize(att.size)}</span>
                      </button>
                    ) : isImageFile(att.name) ? (
                      <button key={att.index} onClick={() => setLightbox({ src: attViewUrl(detail.entryId, att.index), name: att.name })}
                        draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name, isImage: true })); e.dataTransfer.effectAllowed = 'copy'; }}
                        title="View · Drag to EL Pricer"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset cursor-pointer select-none bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-600 hover:bg-emerald-100 transition-colors">
                        <ImageIcon className="w-2.5 h-2.5 shrink-0" />{att.name}<span className="opacity-50 ml-0.5">→ Pricer</span>
                      </button>
                    ) : isExcelFile(att.name) ? (
                      <button key={att.index} onClick={() => setActivePanel('pricer')}
                        draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name })); e.dataTransfer.effectAllowed = 'copy'; }}
                        title="Open EL Pricer · Drag to EL Pricer"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset cursor-pointer select-none bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 ring-green-200 dark:ring-green-600 hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors">
                        <FileSpreadsheet className="w-2.5 h-2.5 shrink-0" />{att.name}<span className="opacity-50 ml-0.5">→ Pricer</span>
                      </button>
                    ) : (
                      <span key={att.index} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset bg-ink-50 dark:bg-ink-800 text-ink-500 dark:text-ink-400 ring-ink-200 dark:ring-ink-600">
                        <Paperclip className="w-2.5 h-2.5" />{att.name}
                      </span>
                    )
                  ))}
                  {detail.hasPdf && (detail.senderEmail.toLowerCase().includes('manualnotification') || /SR00[A-Za-z0-9]+/i.test(detail.subject)) && (
                    <button onClick={queuePdf} disabled={savingPdf}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-60 transition-colors">
                      {savingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}Queue
                    </button>
                  )}
                </div>
                {/* Attachment strip resize handle */}
                <div
                  className="flex items-center justify-center h-2.5 mt-0.5 cursor-ns-resize select-none group"
                  onMouseDown={e => {
                    attResizingRef.current = true;
                    setResizeMode('att');
                    attResizeStartY.current = e.clientY;
                    attResizeStartH.current = attStripRef.current?.offsetHeight ?? attStripHeight;
                    document.body.style.cursor = 'ns-resize';
                    document.body.style.userSelect = 'none';
                    e.preventDefault();
                  }}>
                  <div className="w-6 h-0.5 rounded-full bg-ink-200 dark:bg-ink-700 group-hover:bg-violet-400 dark:group-hover:bg-violet-500 transition-colors" />
                </div>
              </div>
            )}
          </div>

          {/* ── Email body — main scrollable area ───────────────────────────── */}
          <div ref={bodyRef} className="flex-1 overflow-y-auto bg-white dark:bg-ink-900">
            {detail.htmlBody
              ? <EmailBodyFrame key={detail.entryId} html={detail.htmlBody} entryId={detail.entryId} attachments={detail.attachments} />
              : <pre className="px-5 py-4 text-[12.5px] text-ink-700 dark:text-ink-200 leading-relaxed whitespace-pre-wrap font-sans">{detail.body || '(no body)'}</pre>
            }
          </div>

          {/* ── Bottom: expanded panel + action bar ─────────────────────────── */}
          <div className="shrink-0 border-t border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900">

            {/* Expanded panel */}
            {activePanel && (
              <>
                {/* ── Resize handle — OUTSIDE the scroll container so drag works ── */}
                <div
                  className="group flex items-center h-5 border-b border-ink-100 dark:border-ink-800 select-none bg-ink-50 dark:bg-ink-900/80 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
                  style={{ cursor: 'row-resize' }}
                  onMouseDown={e => {
                    if ((e.target as HTMLElement).closest('button')) return;
                    panelResizingRef.current = true;
                    setResizeMode('panel');
                    panelResizeStartY.current = e.clientY;
                    panelResizeStartH.current = panelRef.current?.offsetHeight ?? panelHeight;
                    document.body.style.cursor = 'row-resize';
                    document.body.style.userSelect = 'none';
                    e.preventDefault();
                  }}>
                  <div className="flex-1 flex items-center justify-center pointer-events-none">
                    <div className="w-8 h-0.5 rounded-full bg-ink-300 dark:bg-ink-600 group-hover:bg-violet-400 dark:group-hover:bg-violet-500 transition-colors" />
                  </div>
                  <div className="flex items-center gap-0.5 pr-1.5">
                    <button
                      onClick={() => setPanelMaximized(p => !p)}
                      title={panelMaximized ? 'Restore' : 'Maximise'}
                      className="w-5 h-5 rounded flex items-center justify-center text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors">
                      {panelMaximized
                        ? <ChevronRight className="w-3 h-3 rotate-90" />
                        : <ChevronLeft className="w-3 h-3 -rotate-90" />}
                    </button>
                    <button
                      onClick={() => openExternal('/schematics')}
                      title="Open EL Pricer in new window"
                      className="w-5 h-5 rounded flex items-center justify-center text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors">
                      <ExternalLink className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setActivePanel(null)}
                      title="Close"
                      className="w-5 h-5 rounded flex items-center justify-center text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Scrollable panel content */}
                <div
                  ref={panelRef}
                  className="overflow-y-auto border-b border-ink-200 dark:border-ink-700"
                  // Cap to the space left below the app + inbox headers so the panel
                  // (and its follow-up input at the bottom) plus the action bar can
                  // never spill under the Windows taskbar / off-screen.
                  style={{ height: panelMaximized ? 600 : panelHeight, maxHeight: 'calc(100vh - 300px)' }}>

                {/* ── Summarize panel — summary + inline chat + vision ── */}
                {activePanel === 'summarize' && (
                  <div className="px-5 py-3 flex flex-col gap-3">
                    {/* Header */}
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                      <p className="text-[11.5px] font-semibold text-ink-800 dark:text-ink-100 flex-1">AI Summary</p>
                      {analyzing && <Loader2 className="w-3 h-3 animate-spin text-violet-400" />}
                      {!analyzing && analysis && (
                        <div className="flex items-center gap-1">
                          <button onClick={() => submitAnalysisFeedback('up')} disabled={!!analysisLiked}
                            className={cn('w-5 h-5 rounded flex items-center justify-center', analysisLiked === 'up' ? 'text-emerald-500' : 'text-ink-300 hover:text-emerald-500 disabled:opacity-40')}>
                            <ThumbsUp className="w-2.5 h-2.5" />
                          </button>
                          <button onClick={() => submitAnalysisFeedback('down')} disabled={!!analysisLiked}
                            className={cn('w-5 h-5 rounded flex items-center justify-center', analysisLiked === 'down' ? 'text-red-500' : 'text-ink-300 hover:text-red-500 disabled:opacity-40')}>
                            <ThumbsDown className="w-2.5 h-2.5" />
                          </button>
                          <button onClick={() => runSummarize(detail, true)} className="text-[10px] text-ink-400 hover:text-violet-600 dark:hover:text-violet-300 ml-1 transition-colors">Refresh</button>
                        </div>
                      )}
                    </div>

                    {/* Vision controls — check any image/PDF to feed it to the AI
                        (summary AND follow-up chat). Big inline photos start checked;
                        tiny inline logos (< 12 KB) are hidden. */}
                    {(() => {
                      const visual = detail.attachments.filter(a =>
                        (a.isPdf || a.isImage || isImageFile(a.name)) && !(a.isInline && a.size < 12_000));
                      if (visual.length === 0) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-400 dark:text-ink-500"><Eye className="w-2.5 h-2.5" />Feed to AI:</span>
                          {visual.map(a => {
                            const on  = included.has(a.index);
                            const img = a.isImage || isImageFile(a.name);
                            return (
                              <button key={a.index}
                                onClick={() => setIncluded(prev => { const n = new Set(prev); n.has(a.index) ? n.delete(a.index) : n.add(a.index); return n; })}
                                title={on ? `${a.name} — the AI reads this, click to exclude` : `Include ${a.name} — the AI will read it`}
                                className={cn('inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-medium ring-1 ring-inset transition-colors',
                                  on ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-violet-300 dark:ring-violet-600'
                                     : 'bg-ink-50 dark:bg-ink-800 text-ink-500 dark:text-ink-400 ring-ink-200 dark:ring-ink-600 hover:bg-ink-100 dark:hover:bg-ink-700')}>
                                {on ? <Check className="w-2.5 h-2.5 shrink-0" /> : (img ? <ImageIcon className="w-2.5 h-2.5 shrink-0" /> : <FileText className="w-2.5 h-2.5 shrink-0" />)}
                                <span className="truncate max-w-[130px]">{a.name}</span>
                              </button>
                            );
                          })}
                          {analysis && !analyzing && (
                            <button onClick={() => runSummarize(detail, true)}
                              title="Re-summarize with the current image selection"
                              className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors">
                              Apply
                            </button>
                          )}
                        </div>
                      );
                    })()}

                    {/* Summary body */}
                    {analyzing && !analysis
                      ? <p className="text-[12px] text-ink-400 py-1">Reading email{effectiveInclude(detail).length ? ' + images' : ''}…</p>
                      : analysis
                        ? <Md text={analysis} />
                        : (
                          <div className="py-1">
                            <p className="text-[12px] text-ink-400 mb-2">No summary yet — reads the email plus any inline photos.</p>
                            <button onClick={() => runSummarize(detail)}
                              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors">
                              <Sparkles className="w-3 h-3" /> Summarize
                            </button>
                          </div>
                        )
                    }

                    {/* Inline follow-up chat (only once there is a summary) */}
                    {analysis && (
                      <div className="pt-2.5 mt-0.5 border-t border-ink-100 dark:border-ink-800 flex flex-col gap-2">
                        <p className="text-[10.5px] font-semibold text-ink-400 dark:text-ink-500 uppercase tracking-wide">Ask a follow-up</p>
                        {chatMessages.length > 0 && (
                          <div className="space-y-2">
                            {chatMessages.map((m, i) => (
                              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                                <div className={cn('max-w-[90%] px-3 py-1.5 rounded-xl text-[12px]',
                                  m.role === 'user' ? 'bg-violet-600 text-white rounded-br-sm' : 'bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-100 rounded-bl-sm')}>
                                  {m.role === 'ai' ? <Md text={m.text} /> : m.text}
                                </div>
                              </div>
                            ))}
                            {chatLoading && <div className="flex justify-start"><div className="px-3 py-1.5 rounded-xl bg-ink-100 dark:bg-ink-800 text-[12px] text-ink-400 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Thinking…</div></div>}
                            <div ref={chatEndRef} />
                          </div>
                        )}
                        <div className="flex gap-2 sticky bottom-0 -mx-5 px-5 py-2 bg-white dark:bg-ink-900 border-t border-ink-100/60 dark:border-ink-800/60">
                          <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }}
                            placeholder="Ask about this email or its images…"
                            className="flex-1 h-7 px-2.5 rounded-lg text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 focus:outline-none focus:ring-violet-400 placeholder:text-ink-400 text-ink-800 dark:text-ink-100" />
                          <button onClick={sendChatMessage} disabled={!chatInput.trim() || chatLoading}
                            className="w-7 h-7 rounded-lg flex items-center justify-center bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 transition-colors shrink-0">
                            <Send className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Reply panel ── */}
                {activePanel === 'reply' && (
                  <div className="px-5 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] font-semibold text-ink-500 dark:text-ink-400 flex-1">Reply to {detail.senderEmail}</p>
                      {draftingReply && <Loader2 className="w-3 h-3 animate-spin text-ink-400" />}
                      {replySent && <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Sent</span>}
                    </div>
                    {!replySent && (
                      <>
                        <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={5}
                          placeholder={draftingReply ? 'Drafting AI reply…' : 'Write your reply…'}
                          className="w-full text-[12.5px] text-ink-800 dark:text-ink-100 bg-ink-50 dark:bg-ink-800 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 resize-none focus:outline-none focus:ring-violet-400 leading-relaxed font-sans placeholder:text-ink-400" />
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={sendReply} disabled={sendingReply || !replyText.trim()}
                            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-700 dark:hover:bg-ink-100 disabled:opacity-50 transition-colors">
                            {sendingReply ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}Send
                          </button>
                          <button onClick={() => draftReply(detail)} disabled={draftingReply}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-ink-500 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50 transition-colors">
                            <Sparkles className="w-3 h-3" />AI Draft
                          </button>
                          {draft && (
                            <button onClick={() => draftReply(detail)} disabled={draftingReply}
                              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-ink-500 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50 transition-colors">
                              <RotateCcw className="w-3 h-3" />Regen
                            </button>
                          )}
                          {replyText && (
                            <button onClick={() => { setDraft(''); setReplyText(''); }}
                              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-red-500 ring-1 ring-inset ring-red-200 dark:ring-red-700/50 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                              <Trash2 className="w-3 h-3" />Clear
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ── Reply + Attach panel ── */}
                {activePanel === 'reply-attach' && (
                  <div className="px-5 py-3 space-y-2">
                    <p className="text-[11px] font-semibold text-ink-500 dark:text-ink-400">Reply to {detail.senderEmail} with attachments</p>
                    <textarea value={replyAttachText} onChange={e => setReplyAttachText(e.target.value)} rows={4}
                      placeholder="Write your reply…"
                      className="w-full text-[12.5px] text-ink-800 dark:text-ink-100 bg-ink-50 dark:bg-ink-800 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 resize-none focus:outline-none focus:ring-violet-400 leading-relaxed font-sans placeholder:text-ink-400" />
                    {/* Suggested attachments */}
                    <div>
                      <p className="text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide mb-1.5 flex items-center gap-2">
                        Suggested attachments from Outlook
                        {loadingSugg && <Loader2 className="w-3 h-3 animate-spin text-violet-400" />}
                      </p>
                      {selectedAtts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {selectedAtts.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md text-[10.5px] bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-600">
                              <FileText className="w-3 h-3 shrink-0" />
                              <span className="max-w-[140px] truncate">{a.attachmentName}</span>
                              <button onClick={() => setSelectedAtts(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
                            </span>
                          ))}
                        </div>
                      )}
                      {!loadingSugg && attachSuggestions.length === 0 && (
                        <p className="text-[11px] text-ink-400 dark:text-ink-500">No matching PDFs found in Outlook</p>
                      )}
                      {attachSuggestions.filter(s => !selectedAtts.some(a => a.sourceEntryId === s.sourceEntryId && a.attachmentIndex === s.attachmentIndex)).map((s, i) => (
                        <button key={i} onClick={() => setSelectedAtts(prev => [...prev, s])}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 mb-1 rounded-lg text-[11px] text-left hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors ring-1 ring-inset ring-ink-100 dark:ring-ink-700">
                          <FileText className="w-3 h-3 text-brand-500 shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="font-medium text-ink-700 dark:text-ink-200 truncate block">{s.attachmentName}</span>
                            <span className="text-ink-400 dark:text-ink-500 truncate block text-[10.5px]">{s.emailSubject} · {s.sender}</span>
                          </span>
                          <Plus className="w-3 h-3 text-ink-400 shrink-0" />
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={sendReplyWithAtts} disabled={sendingWithAtts || !replyAttachText.trim()}
                        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-700 dark:hover:bg-ink-100 disabled:opacity-50 transition-colors">
                        {sendingWithAtts ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                        Send {selectedAtts.length > 0 ? `(${selectedAtts.length} file${selectedAtts.length > 1 ? 's' : ''})` : ''}
                      </button>
                    </div>
                  </div>
                )}

                {/* ── EL Pricer panel ── */}
                {activePanel === 'pricer' && (
                  <div className="px-5 py-3">
                    <InlineELPricer emailBody={detail.body || ''} entryId={detail.entryId} attachments={detail.attachments} toast={toast} />
                  </div>
                )}

                {/* ── CBU Tech Sheet panel ── */}
                {activePanel === 'cbu' && (
                  <div className="px-5 py-3">
                    <InlineCBUGenerator emailSubject={detail.subject} emailBody={detail.body || ''} toast={toast} />
                  </div>
                )}

                {activePanel === 'quote' && (
                  <QuickQuotePanel emailSubject={detail.subject} emailBody={detail.body || ''} senderName={detail.sender} senderEmail={detail.senderEmail} toast={toast} />
                )}
                </div>
              </>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-1.5 px-4 py-2 flex-wrap">
              <ABtn panel="summarize"    icon={Sparkles}      label="Summarize" color="violet" locked={STRIPPED} />
              <ABtn panel="reply"        icon={Edit3}         label="Reply"     color="ink"    locked={STRIPPED} />
              <ABtn panel="reply-attach" icon={Paperclip}     label="+ Attach"  color="brand"  locked={STRIPPED} />
              <ABtn panel="pricer"       icon={Zap}           label="EL Pricer" color="amber"  locked={STRIPPED} />
              <ABtn panel="cbu"         icon={Battery}       label="CBU Sheet" color="blue"   locked={STRIPPED} />
              <ABtn panel="quote"        icon={FileDown}      label="Quick Quote" color="emerald" locked={STRIPPED} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
// (ImapSetupScreen removed — using Classic Outlook / win32com)
function _ImapSetupScreen_UNUSED({
  availError,
  onConnected,
  onRetry,
}: {
  availError: string;
  onConnected: () => void;
  onRetry: () => void;
}) {
  const [email, setEmail]       = useState('laithal-soub@eaton.com');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError]       = useState('');
  const [step, setStep]         = useState<'intro'|'paste'>('intro');

  async function connect() {
    if (!email.trim()) { setError('Email is required'); return; }
    if (!password.trim()) { setError('Paste your app password first'); return; }
    setConnecting(true);
    setError('');
    try {
      const r = await api.outlookImapConfig(email.trim(), password);
      if (r.ok) { onConnected(); }
      else {
        const msg = r.error || 'Connection failed';
        const hint = msg.includes('535') || msg.includes('AUTHENTICATIONFAILED') || msg.includes('AUTHENTICATE failed')
          ? 'Wrong password — make sure you copied the full app password (no spaces).'
          : msg;
        setError(hint);
      }
    } catch (e: any) { setError(e.message || 'Connection failed'); }
    setConnecting(false);
  }

  return (
    <div className="flex flex-col items-center justify-center gap-5 h-full px-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-violet-100 dark:bg-violet-900/30 ring-1 ring-inset ring-violet-200 dark:ring-violet-700/40 flex items-center justify-center">
        <Mail className="w-6 h-6 text-violet-500" />
      </div>

      <div>
        <p className="text-[15px] font-semibold text-ink-900 dark:text-ink-50">Connect your Eaton inbox</p>
        <p className="text-[12.5px] text-ink-500 dark:text-ink-400 mt-1 max-w-xs leading-relaxed">
          Eaton blocks standard login for apps. You need a one-time <strong>App Password</strong> from Microsoft — it takes about 60 seconds.
        </p>
      </div>

      {step === 'intro' && (
        <div className="w-full max-w-sm space-y-3">
          {/* Step 1 */}
          <div className="rounded-xl bg-ink-50 dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 px-4 py-3 text-left space-y-2">
            <p className="text-[10.5px] font-bold text-ink-400 uppercase tracking-wide">Step 1 — Open Microsoft Security</p>
            <p className="text-[11.5px] text-ink-600 dark:text-ink-300 leading-relaxed">
              Click the button below. Sign in with your Eaton account if asked.
            </p>
            <a
              href="https://mysignins.microsoft.com/security-info"
              target="_blank"
              rel="noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg text-[12.5px] font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors">
              <ExternalLink className="w-3.5 h-3.5" /> Open mysignins.microsoft.com
            </a>
          </div>

          {/* Step 2 */}
          <div className="rounded-xl bg-ink-50 dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 px-4 py-3 text-left space-y-1.5">
            <p className="text-[10.5px] font-bold text-ink-400 uppercase tracking-wide">Step 2 — Create an App Password</p>
            <ol className="text-[11.5px] text-ink-600 dark:text-ink-300 leading-relaxed list-decimal list-inside space-y-0.5">
              <li>Click <strong>+ Add sign-in method</strong></li>
              <li>Choose <strong>App password</strong> from the dropdown</li>
              <li>Name it anything (e.g. <em>Vector</em>)</li>
              <li>Copy the generated password — shown <strong>once only</strong></li>
            </ol>
            <p className="text-[10.5px] text-amber-600 dark:text-amber-400 mt-1">
              If "App password" is not in the list, Eaton IT has disabled it — contact IT support.
            </p>
          </div>

          <button
            onClick={() => setStep('paste')}
            className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg text-[12.5px] font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors">
            I have my app password →
          </button>

          <div className="flex justify-end">
            <button onClick={onRetry}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors">
              <RefreshCw className="w-3 h-3" /> Retry connection
            </button>
          </div>
        </div>
      )}

      {step === 'paste' && (
        <div className="w-full max-w-sm space-y-3">
          <div>
            <label className="block text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide mb-1 text-left">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full h-9 px-3 rounded-lg text-[12.5px] bg-white dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-violet-400"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold text-ink-400 uppercase tracking-wide mb-1 text-left">App Password</label>
            <input
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') connect(); }}
              placeholder="Paste app password here"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="w-full h-9 px-3 rounded-lg text-[12.5px] font-mono bg-white dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-800 dark:text-ink-100 placeholder:text-ink-400 placeholder:font-sans focus:outline-none focus:ring-violet-400"
            />
          </div>

          <button
            onClick={connect}
            disabled={connecting || !email.trim() || !password.trim()}
            className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg text-[12.5px] font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors">
            {connecting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting…</>
              : <><Mail className="w-3.5 h-3.5" /> Connect</>}
          </button>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 ring-1 ring-inset ring-red-200 dark:ring-red-700/40 px-3 py-2.5 text-left">
              <p className="text-[11.5px] text-red-700 dark:text-red-300 leading-relaxed">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => { setStep('intro'); setError(''); }}
              className="text-[11px] text-ink-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors">
              ← Back to instructions
            </button>
            <div className="flex-1" />
            <button onClick={onRetry}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Main component ──────────────────────────────────────────────────────────
export function InboxPage({
  toast,
  setTab,
  onUnreadCount,
}: {
  toast: ToastFn;
  setTab: (t: string) => void;
  onUnreadCount?: (n: number) => void;
}) {
  // Backed by module-level variables so state survives tab switches
  const [available, _setAvailable]      = useState<boolean | null>(_available);
  const setAvailable = (v: boolean | null) => { _available = v; _setAvailable(v); };

  const [availError, _setAvailError]    = useState(_availError);
  const setAvailError = (v: string) => { _availError = v; _setAvailError(v); };
  const [newOutlook, _setNewOutlook]    = useState(_newOutlook);
  const setNewOutlook = (v: boolean) => { _newOutlook = v; _setNewOutlook(v); };
  const [graphAuth,  _setGraphAuth]     = useState(_graphAuth);
  const setGraphAuth  = (v: boolean) => { _graphAuth  = v; _setGraphAuth(v); };

  const [mailboxes, _setMailboxes]      = useState<Mailbox[]>(_mailboxes);
  const setMailboxes = (v: Mailbox[]) => { _mailboxes = v; _setMailboxes(v); };

  const [storeId, setStoreId]           = useState(() => localStorage.getItem('inbox_storeId') || 'default');
  const [emails, setEmails]             = useState<EmailSummary[]>([]);

  const [selectedId, _setSelectedId]    = useState(_selectedId);
  const setSelectedId = (v: string) => { _selectedId = v; _setSelectedId(v); };

  const [unreadOnly, setUnreadOnly]     = useState(() => localStorage.getItem('inbox_unreadOnly') === 'true');
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [cacheAge, setCacheAge]         = useState('');
  const [emailLimit, setEmailLimit]     = useState(50);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [hasMoreEmails, setHasMoreEmails] = useState(true);

  const [composeOpen, setComposeOpen]         = useState(false);
  const [emailMenu, setEmailMenu]             = useState<{ id: string; x: number; y: number } | null>(null);
  const [starredEmails, setStarredEmails]     = useState<Set<string>>(new Set());
  const [emailCategories, setEmailCategories] = useState<Record<string, string>>({});
  const [dragTabIdx, setDragTabIdx]           = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx]         = useState<number | null>(null);
  const [categoryMenuId, setCategoryMenuId]   = useState<string | null>(null);
  const [popoutId, setPopoutId]               = useState<string | null>(null);

  // ── Resizable list panel — direct DOM to avoid re-render jank ───────────
  const [listWidth, setListWidth] = useState(() => {
    const saved = localStorage.getItem('inbox_list_width');
    return saved ? parseInt(saved, 10) : 288;
  });
  const listPaneRef      = useRef<HTMLDivElement>(null);
  const resizingRef      = useRef(false);
  const resizeStartX     = useRef(0);
  const resizeStartWidth = useRef(288);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      const w = Math.max(180, Math.min(520, resizeStartWidth.current + e.clientX - resizeStartX.current));
      if (listPaneRef.current) listPaneRef.current.style.width = w + 'px';
    }
    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (listPaneRef.current) {
        const w = listPaneRef.current.offsetWidth;
        setListWidth(w);
        localStorage.setItem('inbox_list_width', String(w));
      }
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // ── Browser-style email tabs ─────────────────────────────────────────────
  type Tab = { id: string; label: string; unread: boolean; pinned: boolean };
  const [openTabs, setOpenTabs]       = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [tabCtxMenu, setTabCtxMenu]   = useState<{ id: string; x: number; y: number } | null>(null);
  const [tabBarDragOver, setTabBarDragOver] = useState(false);
  const tabBarRef = useRef<HTMLDivElement>(null);

  // ── Email list search ─────────────────────────────────────────────────────
  const [emailSearch, setEmailSearch] = useState('');

  function scrollTabBar(dir: 'left' | 'right') {
    tabBarRef.current?.scrollBy({ left: dir === 'left' ? -160 : 160, behavior: 'smooth' });
  }

  // Restore pinned tabs from localStorage on first load
  useEffect(() => {
    const pinned: string[] = JSON.parse(localStorage.getItem('inbox_pinned_tabs') || '[]');
    if (pinned.length === 0) return;
    setOpenTabs(prev => {
      const existing = new Set(prev.map(t => t.id));
      const newPins: Tab[] = pinned
        .filter(id => !existing.has(id))
        .map(id => ({ id, label: '…', unread: false, pinned: true }));
      return [...newPins, ...prev];
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function savePinnedToStorage(tabs: Tab[]) {
    const ids = tabs.filter(t => t.pinned).map(t => t.id);
    localStorage.setItem('inbox_pinned_tabs', JSON.stringify(ids));
  }

  function togglePinTab(id: string) {
    setOpenTabs(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, pinned: !t.pinned } : t);
      // Pinned tabs always sit at the front
      const pinned   = updated.filter(t => t.pinned);
      const unpinned = updated.filter(t => !t.pinned);
      const sorted   = [...pinned, ...unpinned];
      savePinnedToStorage(sorted);
      return sorted;
    });
    setTabCtxMenu(null);
  }

  function openAllPdf() {
    const pdfEmails = displayEmails.filter(e => e.hasPdf);
    if (pdfEmails.length === 0) { toast('warn', 'No emails with PDFs visible'); return; }
    pdfEmails.forEach(e => openEmail(e.entryId));
    toast('ok', `Opened ${pdfEmails.length} PDF email${pdfEmails.length > 1 ? 's' : ''}`);
  }

  // ── Check Outlook availability on mount (skip if already known) ─────────
  useEffect(() => {
    if (_available !== null) return; // already checked this session
    api.outlookStatus()
      .then(r => {
        setAvailable(r.available);
        if (!r.available) {
          setAvailError(r.error || 'Outlook not available');
          setNewOutlook(!!r.newOutlook);
          setGraphAuth(!!r.graphAuth);
        } else {
          setGraphAuth(false);
          loadMailboxes();
        }
      })
      .catch(e => { setAvailable(false); setAvailError(e.message); });
  }, []);

  const loadMailboxes = useCallback(async () => {
    if (_mailboxes.length > 0) return;
    try {
      const r = await api.outlookMailboxes();
      const list: Mailbox[] = r.mailboxes || [];
      setMailboxes(list);
      // Default to first shared mailbox if available
      const saved = localStorage.getItem('inbox_storeId');
      const savedExists = saved && (saved === 'default' || list.some(m => m.storeId === saved));
      if (!savedExists) {
        const firstShared = list.find(m => m.type === 'shared');
        if (firstShared) { setStoreId(firstShared.storeId); localStorage.setItem('inbox_storeId', firstShared.storeId); }
      }
    } catch {}
  }, []);

  const loadEmails = useCallback(async (sid = storeId, uread = unreadOnly, force = false, silent = false, limit = emailLimit) => {
    const key = `${sid}:${uread}:${limit}`;
    const cached = emailCache.get(key);
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
      setEmails(cached.emails);
      const ageMin = Math.floor((Date.now() - cached.ts) / 60000);
      setCacheAge(ageMin === 0 ? 'just now' : `${ageMin}m ago`);
      return;
    }
    if (!silent) setLoadingEmails(true);
    try {
      const r = silent
        ? await api.outlookEmails(sid, limit, uread)
        : await runTask(`Fetching ${limit} emails…`, s => api.outlookEmails(sid, limit, uread, s));
      if (r.error && !silent) toast('warn', r.error);
      const list = r.emails || [];
      emailCache.set(key, { emails: list, ts: Date.now() });
      setEmails(list);
      // Fewer returned than asked → no more to fetch
      setHasMoreEmails(list.length >= limit);
      if (!silent) setCacheAge('just now');
    } catch (e: any) {
      if (!silent && !isCancel(e)) toast('err', e.message);
    }
    if (!silent) setLoadingEmails(false);
  }, [storeId, unreadOnly, toast, emailLimit]);

  // Fetch the next window of older emails (+25 each click).
  const loadMoreEmails = useCallback(async () => {
    const next = emailLimit + 25;
    setEmailLimit(next);
    setLoadingMore(true);
    await loadEmails(storeId, unreadOnly, true, false, next);
    setLoadingMore(false);
  }, [emailLimit, storeId, unreadOnly, loadEmails]);

  // Load emails when store or unread filter changes
  useEffect(() => {
    if (available) loadEmails(storeId, unreadOnly);
  }, [available, storeId, unreadOnly]);

  // Silent background refresh every 30 seconds — no spinner, no visual disruption
  useEffect(() => {
    if (!available) return;
    const id = setInterval(() => loadEmails(storeId, unreadOnly, true, true), 30_000);
    return () => clearInterval(id);
  }, [available, storeId, unreadOnly, loadEmails]);

  // Report unread count to parent (sidebar badge)
  useEffect(() => {
    onUnreadCount?.(emails.filter(e => e.unread).length);
  }, [emails, onUnreadCount]);

  // ── Tab management ────────────────────────────────────────────────────────
  function openEmail(entryId: string) {
    const existing = openTabs.find(t => t.id === entryId);
    if (existing) { setActiveTabId(entryId); setSelectedId(entryId); return; }
    const meta   = emails.find(e => e.entryId === entryId);
    const label  = meta?.subject || '…';
    const unread = meta?.unread ?? false;
    setOpenTabs(prev => {
      const pinned   = prev.filter(t => t.pinned);
      const unpinned = prev.filter(t => !t.pinned);
      return [...pinned, ...unpinned, { id: entryId, label, unread, pinned: false }];
    });
    setActiveTabId(entryId);
    setSelectedId(entryId);
  }

  function closeTab(id: string) {
    setOpenTabs(prev => {
      const tab = prev.find(t => t.id === id);
      if (tab?.pinned) return prev; // pinned tabs cannot be closed
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        const idx = prev.findIndex(t => t.id === id);
        const fallback = next[idx] || next[idx - 1] || null;
        setActiveTabId(fallback?.id || '');
        setSelectedId(fallback?.id || '');
      }
      return next;
    });
  }

  function handleMarkRead(entryId: string) {
    setEmails(prev => {
      const updated = prev.map(e => e.entryId === entryId ? { ...e, unread: false } : e);
      const key = `${storeId}:${unreadOnly}`;
      const cached = emailCache.get(key);
      if (cached) emailCache.set(key, { ...cached, emails: updated });
      return updated;
    });
    setOpenTabs(prev => prev.map(t => t.id === entryId ? { ...t, unread: false } : t));
  }

  function updateTabLabel(tabId: string, label: string) {
    setOpenTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t));
  }

  // ── Email row action handlers ─────────────────────────────────────────────
  async function handleFlag(entryId: string) {
    const isStarred = starredEmails.has(entryId);
    const next = new Set(starredEmails);
    if (isStarred) next.delete(entryId); else next.add(entryId);
    setStarredEmails(next);
    setEmailMenu(null);
    try { await api.outlookFlag(entryId, !isStarred); } catch (e: any) { toast('err', e.message); }
  }

  async function handleMarkUnread(entryId: string) {
    setEmails(prev => {
      const updated = prev.map(e => e.entryId === entryId ? { ...e, unread: true } : e);
      const key = `${storeId}:${unreadOnly}`;
      const cached = emailCache.get(key);
      if (cached) emailCache.set(key, { ...cached, emails: updated });
      return updated;
    });
    setEmailMenu(null);
    try { await api.outlookMarkUnread(entryId); } catch (e: any) { toast('err', e.message); }
  }

  async function handleDelete(entryId: string) {
    setEmailMenu(null);
    setEmails(prev => {
      const updated = prev.filter(e => e.entryId !== entryId);
      const key = `${storeId}:${unreadOnly}`;
      const cached = emailCache.get(key);
      if (cached) emailCache.set(key, { ...cached, emails: updated });
      return updated;
    });
    closeTab(entryId);
    try {
      await api.outlookDelete(entryId);
      toast('ok', 'Email deleted');
    } catch (e: any) { toast('err', e.message); }
  }

  async function handleForward(entryId: string) {
    setEmailMenu(null);
    const to = window.prompt('Forward to (email address):');
    if (!to?.trim()) return;
    try {
      const r = await api.outlookForward(entryId, to.trim());
      if (r.error) toast('err', r.error); else toast('ok', 'Forwarded');
    } catch (e: any) { toast('err', e.message); }
  }

  async function handleOpenInOutlook(entryId: string) {
    setEmailMenu(null);
    try { await api.outlookOpenInOutlook(entryId); } catch (e: any) { toast('err', e.message); }
  }

  async function handleCategorize(entryId: string, category: string) {
    setEmailMenu(null);
    setCategoryMenuId(null);
    setEmailCategories(prev => ({ ...prev, [entryId]: category }));
    try {
      const r = await api.outlookCategorize(entryId, category);
      if (r.error) toast('err', r.error); else toast('ok', `Categorized: ${category}`);
    } catch (e: any) { toast('err', e.message); }
  }

  // ─── Unavailable state ─────────────────────────────────────────────────────
  if (available === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-ink-400" />
      </div>
    );
  }

  if (available === false) {
    const retryStatus = () => {
      setAvailable(null); setNewOutlook(false); setGraphAuth(false);
      api.outlookStatus().then(r => {
        setAvailable(r.available);
        if (!r.available) {
          setAvailError(r.error || '');
          setNewOutlook(!!r.newOutlook);
          setGraphAuth(!!r.graphAuth);
        } else { setGraphAuth(false); loadMailboxes(); }
      }).catch(() => setAvailable(false));
    };

    // ── Classic Outlook / pywin32 error screen ────────────────────────────
    return (
      <div className="flex flex-col items-center justify-center gap-4 h-full px-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-900/30 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/40 flex items-center justify-center">
          <Mail className="w-6 h-6 text-amber-500" />
        </div>
        <div>
          <p className="text-[15px] font-semibold text-ink-900 dark:text-ink-50">Outlook not available</p>
          <p className="text-[12.5px] text-ink-500 dark:text-ink-400 mt-1 max-w-sm leading-relaxed">
            Make sure Classic Outlook is open and <code className="text-[11px] bg-ink-100 dark:bg-ink-800 px-1 rounded">pywin32</code> is installed.
          </p>
        </div>
        <div className="mt-1 px-4 py-3 rounded-xl bg-white dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-left max-w-sm w-full">
          <p className="text-[11px] font-semibold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-2">Setup</p>
          <p className="text-[12px] text-ink-700 dark:text-ink-200 font-mono bg-ink-50 dark:bg-ink-800 rounded px-2 py-1.5">pip install pywin32</p>
          {availError && <p className="text-[11px] text-red-500 dark:text-red-400 mt-2">{availError}</p>}
        </div>
        <button onClick={retryStatus}
          className="inline-flex items-center gap-2 h-8 px-4 rounded-lg text-[12px] font-medium bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-700 dark:hover:bg-ink-100 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      </div>
    );
  }

  // Filtered email list (search)
  const sq = emailSearch.trim().toLowerCase();
  const displayEmails = sq
    ? emails.filter(e =>
        e.subject.toLowerCase().includes(sq) ||
        e.sender.toLowerCase().includes(sq) ||
        e.senderEmail.toLowerCase().includes(sq) ||
        e.bodyPreview.toLowerCase().includes(sq)
      )
    : emails;

  return (
    <div className="flex flex-col h-full">

      {/* ── Compose modal ───────────────────────────────────────────────────── */}
      {composeOpen && <ComposeModal onClose={() => setComposeOpen(false)} toast={toast} />}

      {/* ── Full-screen email popout (double-click) ─────────────────────────── */}
      {popoutId && (
        <div className="fixed inset-0 z-[9960] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={e => { if (e.target === e.currentTarget) setPopoutId(null); }}>
          <div className="w-full max-w-4xl bg-white dark:bg-ink-900 rounded-2xl shadow-2xl ring-1 ring-inset ring-ink-200 dark:ring-ink-700 flex flex-col overflow-hidden"
            style={{ height: 'min(90vh, 860px)' }}>
            {/* Popout header */}
            <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-ink-200 dark:border-ink-700 bg-ink-50/60 dark:bg-ink-950/40">
              <Mail className="w-4 h-4 text-ink-400 shrink-0" />
              <p className="flex-1 text-[12.5px] font-semibold text-ink-700 dark:text-ink-200 truncate">
                {emails.find(e => e.entryId === popoutId)?.subject || '…'}
              </p>
              <button onClick={() => setPopoutId(null)}
                className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-800 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Popout body */}
            <div className="flex-1 min-h-0">
              <EmailDetailPanel
                initialEntryId={popoutId}
                emailList={emails}
                toast={toast}
                setAppTab={setTab}
                onMarkRead={handleMarkRead}
                onLabelChange={() => {}}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Email row context menu ──────────────────────────────────────────── */}
      {emailMenu && (
        <>
          <div className="fixed inset-0 z-[9990]" onClick={() => { setEmailMenu(null); setCategoryMenuId(null); }} />
          <div
            className="fixed z-[9991] bg-white dark:bg-ink-900 rounded-xl shadow-xl ring-1 ring-inset ring-ink-200 dark:ring-ink-700 py-1 min-w-[176px] text-[12px]"
            style={{ top: emailMenu.y, left: emailMenu.x }}>
            <button onClick={() => handleFlag(emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
              <Star className={cn('w-3.5 h-3.5', starredEmails.has(emailMenu.id) ? 'text-amber-400 fill-amber-400' : 'text-ink-400')} />
              {starredEmails.has(emailMenu.id) ? 'Unflag' : 'Flag'}
            </button>
            <button onClick={() => handleMarkUnread(emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
              <Mail className="w-3.5 h-3.5 text-ink-400" />
              Mark as Unread
            </button>
            <button onClick={() => handleForward(emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
              <Forward className="w-3.5 h-3.5 text-ink-400" />
              Forward
            </button>
            <button onClick={() => handleOpenInOutlook(emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
              <ExternalLink className="w-3.5 h-3.5 text-ink-400" />
              Open in Outlook
            </button>
            <button onClick={() => setCategoryMenuId(categoryMenuId === emailMenu.id ? null : emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
              <FolderOpen className="w-3.5 h-3.5 text-ink-400" />
              <span className="flex-1">Categorize</span>
              <ChevronRight className="w-3 h-3 text-ink-400" />
            </button>
            {categoryMenuId === emailMenu.id && (
              <div className="px-3 pb-2 flex flex-wrap gap-1.5">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => handleCategorize(emailMenu.id, cat)}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset transition-colors',
                      emailCategories[emailMenu.id] === cat
                        ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-violet-300 dark:ring-violet-600'
                        : 'bg-ink-50 dark:bg-ink-800 text-ink-600 dark:text-ink-300 ring-ink-200 dark:ring-ink-700 hover:bg-ink-100 dark:hover:bg-ink-700',
                    )}>
                    {cat}
                  </button>
                ))}
              </div>
            )}
            <hr className="my-1 border-ink-100 dark:border-ink-800" />
            <button onClick={() => handleDelete(emailMenu.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-red-600 dark:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </>
      )}

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-white dark:bg-ink-900 border-b border-ink-200 dark:border-ink-700">

        {/* Mailbox tabs */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {/* Default personal inbox */}
          <button
            onClick={() => { setStoreId('default'); localStorage.setItem('inbox_storeId', 'default'); }}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium whitespace-nowrap transition-colors',
              storeId === 'default'
                ? 'bg-ink-900 dark:bg-white text-white dark:text-ink-900'
                : 'text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800',
            )}>
            <InboxIcon className="w-3 h-3 shrink-0" />
            Personal
          </button>
          {mailboxes.filter(m => m.type === 'shared').map(m => (
            <button
              key={m.storeId}
              onClick={() => { setStoreId(m.storeId); localStorage.setItem('inbox_storeId', m.storeId); }}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium whitespace-nowrap transition-colors',
                storeId === m.storeId
                  ? 'bg-ink-900 dark:bg-white text-white dark:text-ink-900'
                  : 'text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800',
              )}>
              <Users className="w-3 h-3 shrink-0" />
              {m.name}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Unread filter */}
        <button
          onClick={() => setUnreadOnly(u => { const next = !u; localStorage.setItem('inbox_unreadOnly', String(next)); return next; })}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium ring-1 ring-inset transition-colors',
            unreadOnly
              ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-violet-200 dark:ring-violet-700/40'
              : 'text-ink-500 ring-ink-200 dark:ring-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800',
          )}>
          <Filter className="w-3 h-3" />
          Unread
        </button>

        {/* Compose */}
        <button
          onClick={() => setComposeOpen(true)}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium ring-1 ring-inset ring-ink-200 dark:ring-ink-600 text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors">
          <PenLine className="w-3 h-3" />
          Compose
        </button>

        {/* Refresh */}
        <button
          onClick={() => loadEmails(storeId, unreadOnly, true)}
          disabled={loadingEmails}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-40 transition-colors">
          <RefreshCw className={cn('w-3.5 h-3.5', loadingEmails && 'animate-spin')} />
        </button>
      </div>

      {/* ── Content: email list + detail split pane ── */}
      <div className="flex-1 flex min-h-0">

        {/* ── Email list (left) ────────────────────────────────────────────── */}
        <div ref={listPaneRef} className="shrink-0 flex flex-col border-r border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900" style={{ width: listWidth }}>

          {/* Search + open-all-PDF toolbar */}
          <div className="shrink-0 px-2 py-1.5 border-b border-ink-100 dark:border-ink-700 flex items-center gap-1.5">
            <div className="flex-1 flex items-center gap-1.5 h-7 px-2 rounded-md bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200/70 dark:ring-ink-700/50 focus-within:ring-violet-400/60">
              <Search className="w-3 h-3 text-ink-400 shrink-0" />
              <input
                type="text"
                value={emailSearch}
                onChange={e => setEmailSearch(e.target.value)}
                placeholder="Search…"
                className="flex-1 bg-transparent text-[11.5px] text-ink-700 dark:text-ink-200 placeholder:text-ink-400 outline-none min-w-0"
              />
              {emailSearch && (
                <button onClick={() => setEmailSearch('')} className="text-ink-400 hover:text-ink-600 dark:hover:text-ink-200">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <button
              onClick={openAllPdf}
              title="Open all emails with PDFs as tabs"
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors">
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </div>

          {loadingEmails ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-ink-300" />
            </div>
          ) : displayEmails.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
              <Mail className="w-8 h-8 text-ink-200 dark:text-ink-700" />
              <p className="text-[12px] text-ink-400 dark:text-ink-500">
                {emailSearch ? 'No emails match your search' : unreadOnly ? 'No unread emails' : 'No emails found'}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto py-1">
              {displayEmails.map(email => (
                <div
                  key={email.entryId}
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData('vector/email-row', email.entryId);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => openEmail(email.entryId)}
                  onDoubleClick={() => setPopoutId(email.entryId)}
                  className={cn(
                    'w-full flex flex-col gap-0.5 px-3 py-2.5 text-left border-b border-ink-100 dark:border-ink-700 transition-colors cursor-pointer select-none relative group',
                    email.entryId === selectedId
                      ? 'bg-ink-100 dark:bg-ink-800 border-l-2 border-l-violet-500 dark:border-l-violet-400 pl-[10px]'
                      : 'hover:bg-ink-50 dark:hover:bg-ink-800/40',
                  )}>
                  {/* Three-dot menu */}
                  <button
                    onClick={e => { e.stopPropagation(); setEmailMenu({ id: email.entryId, x: e.clientX, y: e.clientY }); }}
                    className="absolute right-2 top-2 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 text-ink-400 hover:bg-ink-200 dark:hover:bg-ink-700 transition-all z-10">
                    <MoreHorizontal className="w-3 h-3" />
                  </button>
                  <div className="flex items-center gap-1.5 min-w-0 pr-5">
                    {email.unread && (
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                    )}
                    {starredEmails.has(email.entryId) && (
                      <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
                    )}
                    <p className={cn(
                      'text-[12px] truncate flex-1',
                      email.unread ? 'font-semibold text-ink-900 dark:text-ink-50' : 'font-medium text-ink-700 dark:text-ink-300',
                    )}>
                      {email.subject}
                    </p>
                    {emailCategories[email.entryId] && (
                      <span className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 truncate max-w-[64px]">
                        {emailCategories[email.entryId]}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-500 dark:text-ink-400 truncate">{email.sender}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10.5px] text-ink-400 dark:text-ink-500 flex-1">{fmtDate(email.received)}</span>
                    {email.hasPdf && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-brand-600 dark:text-brand-400 font-medium">
                        <FileText className="w-2.5 h-2.5" /> PDF
                      </span>
                    )}
                    {email.attachments.length > 0 && !email.hasPdf && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-400">
                        <Paperclip className="w-2.5 h-2.5" /> {email.attachments.length}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {!sq && hasMoreEmails && (
                <button
                  onClick={loadMoreEmails}
                  disabled={loadingMore}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11.5px] font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/15 disabled:opacity-50 transition-colors">
                  {loadingMore
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</>
                    : <><ChevronDown className="w-3.5 h-3.5" /> Load more</>}
                </button>
              )}
            </div>
          )}
          {emails.length > 0 && (
            <div className="shrink-0 px-3 py-2 border-t border-ink-100 dark:border-ink-700 flex items-center justify-between">
              <p className="text-[10.5px] text-ink-400 dark:text-ink-500">
                {sq ? `${displayEmails.length} of ${emails.length}` : (
                  emails.filter(e => e.unread).length > 0
                    ? `${emails.filter(e => e.unread).length} unread · ${emails.length}`
                    : `${emails.length} emails`
                )}
              </p>
              {cacheAge && (
                <p className="text-[10px] text-ink-300 dark:text-ink-600">Updated {cacheAge}</p>
              )}
            </div>
          )}
        </div>

        {/* ── Resize handle — wide hit area, visible grip on hover ── */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          className="group relative w-2 shrink-0 cursor-col-resize flex items-center justify-center bg-ink-100/60 dark:bg-ink-800/60 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
          onMouseDown={e => {
            resizingRef.current = true;
            resizeStartX.current = e.clientX;
            resizeStartWidth.current = listPaneRef.current?.offsetWidth ?? listWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
          }}
          onDoubleClick={() => { setListWidth(288); localStorage.setItem('inbox_list_width', '288'); if (listPaneRef.current) listPaneRef.current.style.width = '288px'; }}
        >
          <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-ink-200 dark:bg-ink-700 group-hover:bg-violet-400 dark:group-hover:bg-violet-500" />
          <span className="relative flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="w-0.5 h-0.5 rounded-full bg-violet-500" />
            <span className="w-0.5 h-0.5 rounded-full bg-violet-500" />
            <span className="w-0.5 h-0.5 rounded-full bg-violet-500" />
          </span>
        </div>

        {/* ── Detail pane (right) — browser-style tabs ────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* Tab bar */}
          {openTabs.length > 0 && (
            <div className="shrink-0 flex items-center border-b border-ink-200 dark:border-ink-700 bg-ink-50/60 dark:bg-ink-950/40">
              {/* Scroll-left arrow */}
              <button
                onClick={() => scrollTabBar('left')}
                className="shrink-0 w-6 h-full flex items-center justify-center text-ink-400 hover:text-ink-600 dark:hover:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors border-r border-ink-200/40 dark:border-ink-800/40">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Scrollable tab strip */}
              <div
                ref={tabBarRef}
                className={cn(
                  'flex-1 flex items-center overflow-x-auto scrollbar-none transition-colors',
                  tabBarDragOver && 'bg-violet-50/60 dark:bg-violet-900/20',
                )}
                onWheel={e => { e.stopPropagation(); tabBarRef.current?.scrollBy({ left: e.deltaY + e.deltaX, behavior: 'auto' }); }}
                onDragOver={e => {
                  if (e.dataTransfer.types.includes('vector/tab')) return;
                  if (e.dataTransfer.types.includes('vector/email-row')) { e.preventDefault(); setTabBarDragOver(true); }
                }}
                onDragLeave={() => setTabBarDragOver(false)}
                onDrop={e => {
                  setTabBarDragOver(false);
                  const id = e.dataTransfer.getData('vector/email-row');
                  if (id) openEmail(id);
                }}>
                {openTabs.map((t, tabIdx) => (
                  <div key={t.id}
                    draggable
                    onDragStart={e => {
                      e.stopPropagation();
                      setDragTabIdx(tabIdx);
                      e.dataTransfer.setData('vector/tab', t.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={e => {
                      if (!e.dataTransfer.types.includes('vector/tab')) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (tabIdx !== dragTabIdx) setDragOverIdx(tabIdx);
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragTabIdx !== null && dragTabIdx !== tabIdx) {
                        setOpenTabs(prev => {
                          const next = [...prev];
                          const [moved] = next.splice(dragTabIdx, 1);
                          next.splice(tabIdx, 0, moved);
                          return next;
                        });
                      }
                      setDragTabIdx(null);
                      setDragOverIdx(null);
                    }}
                    onDragEnd={() => { setDragTabIdx(null); setDragOverIdx(null); }}
                    onClick={() => { setActiveTabId(t.id); setSelectedId(t.id); }}
                    onContextMenu={e => { e.preventDefault(); setTabCtxMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
                    className={cn(
                      'group relative flex items-center gap-1.5 px-3 py-2 border-r border-ink-200/40 dark:border-ink-700/40 shrink-0 cursor-grab active:cursor-grabbing min-w-[80px] max-w-[200px] transition-colors select-none',
                      t.id === activeTabId
                        ? 'bg-white dark:bg-ink-900 text-ink-800 dark:text-ink-100 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-violet-500'
                        : 'text-ink-500 dark:text-ink-400 hover:bg-white/70 dark:hover:bg-ink-900/50',
                      dragOverIdx === tabIdx && dragTabIdx !== null && dragTabIdx !== tabIdx
                        ? 'ring-1 ring-inset ring-violet-400 dark:ring-violet-500 bg-violet-50/60 dark:bg-violet-900/20'
                        : '',
                    )}>
                    {/* Pin indicator */}
                    {t.pinned
                      ? <Pin className="w-2.5 h-2.5 shrink-0 text-violet-500" />
                      : <Mail className="w-3 h-3 shrink-0 opacity-40" />}
                    {/* Unread dot */}
                    {t.unread && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
                    <span className="text-[11px] font-medium truncate flex-1">{t.label}</span>
                    {/* Close button — hidden for pinned tabs */}
                    {!t.pinned && (
                      <button
                        onClick={e => { e.stopPropagation(); closeTab(t.id); }}
                        title="Close tab"
                        className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-ink-200 dark:hover:bg-ink-700 transition-all shrink-0 ml-0.5">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Scroll-right arrow */}
              <button
                onClick={() => scrollTabBar('right')}
                className="shrink-0 w-6 h-full flex items-center justify-center text-ink-400 hover:text-ink-600 dark:hover:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors border-l border-ink-200/40 dark:border-ink-800/40">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Tab right-click context menu */}
          {tabCtxMenu && (
            <>
              <div className="fixed inset-0 z-[9990]" onClick={() => setTabCtxMenu(null)} />
              <div
                className="fixed z-[9991] bg-white dark:bg-ink-900 rounded-lg shadow-xl ring-1 ring-inset ring-ink-200/80 dark:ring-ink-700/50 py-1 min-w-[140px] text-[12px]"
                style={{ top: tabCtxMenu.y, left: tabCtxMenu.x }}>
                <button
                  onClick={() => togglePinTab(tabCtxMenu.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors text-ink-700 dark:text-ink-200">
                  {openTabs.find(t => t.id === tabCtxMenu.id)?.pinned
                    ? <><PinOff className="w-3.5 h-3.5 text-ink-400" /> Unpin tab</>
                    : <><Pin className="w-3.5 h-3.5 text-violet-500" /> Pin tab</>}
                </button>
                {!openTabs.find(t => t.id === tabCtxMenu.id)?.pinned && (
                  <button
                    onClick={() => { closeTab(tabCtxMenu.id); setTabCtxMenu(null); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-red-600 dark:text-red-400">
                    <X className="w-3.5 h-3.5" /> Close tab
                  </button>
                )}
              </div>
            </>
          )}

          {/* Empty state */}
          {openTabs.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="w-12 h-12 rounded-2xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center">
                <Mail className="w-5 h-5 text-ink-400" />
              </div>
              <p className="text-[13px] text-ink-500 dark:text-ink-400">Select an email to read and analyse</p>
            </div>
          )}

          {/* One EmailDetailPanel per tab — inactive tabs hidden via display:none */}
          {openTabs.map(t => (
            <div key={t.id}
              className="flex-1 min-h-0"
              style={t.id !== activeTabId ? { display: 'none' } : undefined}>
              <EmailDetailPanel
                initialEntryId={t.id}
                emailList={emails}
                toast={toast}
                setAppTab={setTab}
                onMarkRead={handleMarkRead}
                onLabelChange={label => updateTabLabel(t.id, label)}
              />
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}
