// ─── Inbox — Outlook email reader + AI triage ────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mail, RefreshCw, Paperclip, FileText, Sparkles, Loader2,
  Filter, Users, ChevronRight, ChevronDown, Download,
  CheckCircle2, Inbox as InboxIcon,
  ThumbsUp, ThumbsDown, Send, Edit3, Trash2, RotateCcw,
  Play, ArrowLeft, Zap, Eye, X, Image as ImageIcon, ChevronLeft,
  Pin, PinOff, Search, FolderOpen, MoreHorizontal, Star, ExternalLink,
  Forward, MessageSquare, PenLine, Plus, GripVertical, Battery, Lock, Check, FileSpreadsheet, FileDown,
  Flag, Archive, Globe, SlidersHorizontal, BookMarked, History as HistoryIcon, Trophy, CircleSlash,
  AArrowUp, AArrowDown,
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

// These caches deliberately outlive the component so switching tabs does not
// re-read the mailbox — but nothing ever removed an entry, so a day of browsing
// kept every summary and every store mapping in memory until the app was closed.
// Caps chosen to cover normal use (a few mailbox/filter combinations, a working
// set of messages) while putting a ceiling on a long session.
const MAX_EMAIL_CACHE = 12;      // one entry per storeId + filter combination
const MAX_SUMMARIES   = 200;     // AI summaries; the durable copy is in SQLite
const MAX_STORE_OF    = 5000;    // entryId -> storeId, one small string each

// Map preserves insertion order, so the first key is the oldest.
function capMap<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    m.delete(oldest.value);
  }
}
function capRecord(r: Record<string, unknown>, max: number) {
  const keys = Object.keys(r);
  for (let i = 0; i < keys.length - max; i++) delete r[keys[i]];
}

// These are initialised once and kept alive while the app is open
let _available: boolean | null = null;
let _availError = '';
let _newOutlook = false;
let _graphAuth  = false;
let _mailboxes: Mailbox[] = [];
// Session cache of generated summaries (the durable copy lives in SQLite).
let _summaryCache: Record<string, string> = {};
// Which mailbox each EntryID came from. An id minted in a shared mailbox does
// not resolve against the default store, so opening a search hit from another
// mailbox fails unless we send the store back with the request.
const _storeOf: Record<string, string> = {};
function rememberStores(list: { entryId: string; storeId?: string }[], fallback = '') {
  for (const e of list) {
    const sid = e.storeId || fallback;
    if (e.entryId && sid) _storeOf[e.entryId] = sid;
  }
  capRecord(_storeOf, MAX_STORE_OF);
}
let _selectedId = '';
let _detail: EmailDetail | null = null;
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import type { MatchMode, SearchMatch, SearchScope, SearchFilters, SearchFacets, Snippet, CustomerHistory } from '../lib/api';
import { useSalesmen } from '../lib/salesmen';
import { failed, plural } from '../lib/errors';
import { sendToPricer } from '../lib/pricerHandoff';
import { fmtGBP } from '../lib/ui';
import type { TodoBucket } from '../types';
import type { ToastFn } from '../App';
import {
  tokenValue, Button as UiButton, IconButton as UiIconButton,
  AiMessage, UserMessage, AiThinking, AiComposer, AiPanelHeader, AiFileChip, CopyAction,
} from '../ui';

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
  // Set only on full-mailbox search hits — where the message actually lives.
  folder?:     string;
  // Set only on search hits: which field each term landed in, with context.
  matches?:    SearchMatch[];
  store?:      string;
  storeId?:    string;
}

interface EmailDetail extends EmailSummary {
  to:       string;
  cc:       string;
  body:     string;
  htmlBody?: string;
  // Real SMTP addresses of everyone on the thread (to/cc). `to`/`cc` above are
  // display names only, which cannot be put in a To field.
  recipients?: Array<{ name: string; email: string; type: 'to' | 'cc' }>;
}

// How the assistant reshapes text: 'polish' turns the user's raw note into an
// email; the other three act on whatever it produced last.
type PolishMode = 'polish' | 'shorten' | 'formalize' | 'rewrite';

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
          <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
            <span className="text-ai shrink-0 mt-0.5">•</span>
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
          <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
            <span className="text-ai font-semibold shrink-0 w-4 text-right mt-0.5">{i + 1}.</span>
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
    if (raw.startsWith('### ')) { flushUl(); flushOl(); out.push(<p key={out.length} className="text-xs font-semibold mt-2 mb-0.5 text-fg">{inline(raw.slice(4))}</p>); continue; }
    if (raw.startsWith('## '))  { flushUl(); flushOl(); out.push(<p key={out.length} className="text-sm font-semibold mt-2.5 mb-0.5 text-fg">{inline(raw.slice(3))}</p>); continue; }
    if (raw.startsWith('# '))   { flushUl(); flushOl(); out.push(<p key={out.length} className="text-base font-semibold mt-2.5 mb-1 text-fg">{inline(raw.slice(2))}</p>); continue; }
    if (/^[-*•]\s/.test(raw))  { flushOl(); ulBuf.push(raw.replace(/^[-*•]\s+/, '')); continue; }
    if (/^\d+\.\s/.test(raw))  { flushUl(); olBuf.push(raw.replace(/^\d+\.\s+/, '')); continue; }
    if (/^---+$/.test(raw))    { flushUl(); flushOl(); out.push(<hr key={out.length} className="my-2 border-ai-line " />); continue; }
    flushUl(); flushOl();
    out.push(<p key={out.length} className="text-sm text-fg-2 leading-relaxed">{inline(raw)}</p>);
  }
  flushUl(); flushOl();
  return <div className="space-y-0.5">{out}</div>;
}

function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // bold | code | [label](url) markdown link (links open in a new tab)
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={m.index} className="font-semibold text-fg">{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} className="px-1 py-0.5 rounded bg-subtle text-xs mono text-accent-text">{m[4]}</code>);
    else if (m[5]) parts.push(
      <a key={m.index} href={m[7]} target="_blank" rel="noopener noreferrer"
         className="text-ai underline decoration-ai-line hover:decoration-ai-line break-all">{m[6]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Outlook COM (str(item.ReceivedTime)) hands back LOCAL wall-clock time stamped
// "+00:00", so parsing it as UTC put every email two hours in the future and the
// list read "-116m ago". That shape has a space separator; Graph/IMAP isoformat()
// uses "T" and is genuinely UTC, so only the COM shape is re-read as local.
function parseReceived(s: string): Date {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)?\+00:00$/.exec(s || '');
  return m ? new Date(`${m[1]}T${m[2]}`) : new Date(s);
}

function fmtDate(iso: string) {
  try {
    const d = parseReceived(iso);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60)    return 'just now';
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

// An attachment chip that says "photo.jpg" next to a generic picture icon tells
// you nothing — the whole question is which photo. The server hands back a
// downscaled copy (?thumb=), so this is a few KB per chip rather than the whole
// attachment, and the browser is never asked to decode a 12 MP phone photo to
// paint 20 pixels. Falls back to the icon if the image can't be fetched.
const CHIP_THUMB_PX = 96;

function AttThumb({ entryId, index }: { entryId: string; index: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImageIcon className="w-2.5 h-2.5 shrink-0" />;
  return (
    <img
      src={`${attViewUrl(entryId, index)}?thumb=${CHIP_THUMB_PX}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="w-5 h-5 shrink-0 rounded object-cover bg-subtle ring-1 ring-line-3 "
    />
  );
}

// ─── Customer history ────────────────────────────────────────────────────────
// What this account was quoted before, beside the email being answered. The
// alternative was leaving the app mid-reply to dig through D&Q or old mail.
//
// Everything shown is already synced from the Quotations List; nothing here
// fetches from SharePoint. When no account matches the panel says so plainly
// rather than guessing — a wrong customer's history next to a reply box would
// be worse than none.
function fmtMoney(n: number): string {
  if (!n) return '—';
  return n >= 1000
    ? `£${Math.round(n).toLocaleString('en-GB')}`
    : `£${n.toFixed(0)}`;
}

function CustomerHistoryPanel({ senderEmail, senderName, toast }: {
  senderEmail: string; senderName: string; toast: ToastFn;
}) {
  const [data, setData]       = useState<CustomerHistory | null>(null);
  const [loading, setLoading] = useState(false);
  // Set once the user names the customer themselves; from then on the lookup is
  // by that name rather than by whatever could be read off the sender.
  const [picked, setPicked]   = useState('');

  useEffect(() => { setPicked(''); }, [senderEmail, senderName]);

  useEffect(() => {
    let live = true;
    setLoading(true); setData(null);
    api.customerHistory({ email: senderEmail, name: senderName, q: picked || undefined, limit: 12 })
      .then(r => { if (live) setData(r); })
      .catch(e => { if (live) toast('err', failed('load the customer history', e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [senderEmail, senderName, picked]);

  if (loading) {
    return <p className="text-xs text-fg-3 flex items-center gap-1.5 px-1 py-3">
      <Loader2 className="w-3 h-3 animate-spin" />Looking this sender up…
    </p>;
  }
  if (!data) return null;

  // Could not tell who this is. Offering the busiest customers to pick from is
  // deliberate: a confidently wrong history beside a reply box is worse than
  // none, so nothing here falls back to a fuzzy best guess.
  if (!data.matched) {
    return (
      <div className="px-1 py-2">
        <p className="text-xs text-fg-2 font-medium">Couldn’t tell which customer this is</p>
        <p className="text-2xs text-fg-3 mt-1 leading-relaxed">
          Nothing in {senderName || senderEmail || 'this sender'} matched a customer on your Quotations List.
          Pick one to see their history:
        </p>
        <div className="flex flex-wrap gap-1 mt-2">
          {data.suggestions.map(s => (
            <UiButton tone="secondary" key={s.customer} onClick={() => setPicked(s.customer)}>
              {s.customer}<span className="opacity-50">{s.count}</span>
            </UiButton>
          ))}
        </div>
      </div>
    );
  }

  const { totals } = data;
  const decided = totals.won + totals.lost;
  const winRate = decided > 0 ? Math.round((totals.won / decided) * 100) : null;

  return (
    <div className="space-y-2.5">
      {/* Who this is, and on what evidence */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg truncate">{data.customer}</p>
          <p className="text-2xs text-fg-3 mt-0.5">
            {data.matchedOn === 'picked'      ? 'you picked this customer'
             : data.matchedOn === 'domain'     ? 'matched on the email domain'
             : 'matched on the sender name'}
            {data.spellings.length > 1 && ` · ${data.spellings.length} spellings merged`}
            {data.matchedOn !== 'picked' && ' · '}
            {data.matchedOn !== 'picked' && (
              <button onClick={() => setPicked('')} className="underline hover:text-fg-2"
                title="Clear and pick a different customer">not them?</button>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-2xs px-1.5 py-0.5 rounded bg-subtle text-fg-2 font-medium">
            {totals.count} quote{totals.count === 1 ? '' : 's'}
          </span>
          {winRate != null && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-ok-soft text-ok font-medium">
              {winRate}% won
            </span>
          )}
        </div>
      </div>

      {/* The relationship in four numbers */}
      <div className="grid grid-cols-4 gap-1.5">
        {([
          ['Won',  totals.won,  'text-ok '],
          ['Lost', totals.lost, 'text-err '],
          ['Open', totals.open, 'text-fg-2'],
        ] as const).map(([label, n, tone]) => (
          <div key={label} className="rounded-lg bg-subtle px-2 py-1.5">
            <p className={cn('text-lg font-semibold leading-none', tone)}>{n}</p>
            <p className="text-2xs text-fg-3 mt-1">{label}</p>
          </div>
        ))}
        <div className="rounded-lg bg-subtle px-2 py-1.5">
          {/* Total quoted, not won: won/lost is only tracked once someone marks
              it in the CRM, so a zero here means unmarked, not lost. */}
          <p className="text-lg font-semibold leading-none text-fg">{fmtMoney(totals.value)}</p>
          <p className="text-2xs text-fg-3 mt-1">Quoted</p>
        </div>
      </div>

      {/* What they buy for */}
      {data.projects.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.projects.map(p => (
            <span key={p.name}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs bg-subtle text-fg-3 max-w-48">
              <span className="truncate">{p.name}</span><span className="opacity-60 shrink-0">{p.count}</span>
            </span>
          ))}
        </div>
      )}

      {/* The quotes themselves, newest first */}
      {data.quotes.length > 0 ? (
        <div className="space-y-0.5">
          {data.quotes.map((q, i) => (
            <div key={i} className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-subtle transition-colors">
              {q.state === 'won'  ? <Trophy className="w-3 h-3 shrink-0 text-ok" />
               : q.state === 'lost' ? <CircleSlash className="w-3 h-3 shrink-0 text-err" />
               : <span className="w-3 h-3 shrink-0 rounded-full ring-1 ring-inset ring-line-2" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs text-fg truncate">
                  {q.account || q.quoteName || q.title || q.sfId || 'Untitled quote'}
                </p>
                <p className="text-2xs text-fg-3 truncate">
                  {q.arrivedOn ? fmtDate(q.arrivedOn) : '—'}
                  {q.salesman ? ` · ${q.salesman}` : ''}
                  {q.status ? ` · ${q.status}` : ''}
                </p>
              </div>
              <span className="text-2xs font-medium text-fg-2 shrink-0 num">
                {q.price ? fmtMoney(q.price) : '—'}
              </span>
            </div>
          ))}
          {totals.count > data.quotes.length && (
            <p className="text-2xs text-fg-3 px-1.5 pt-1">
              Showing the {data.quotes.length} most recent of {totals.count}.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-3 px-1 py-2">No quotes synced against this customer yet.</p>
      )}
    </div>
  );
}

// ─── Reply snippets ──────────────────────────────────────────────────────────
// The fixed wordings typed every week — lead times, commissioning terms, the
// standard questions back. Distinct from AI Draft on purpose: that regenerates
// prose each time, these come out identical every time, which is what a term or
// a lead time needs to do.
function SnippetPicker({ onInsert, toast }: {
  onInsert: (body: string) => void;
  toast: ToastFn;
}) {
  const [open, setOpen]         = useState(false);
  const [items, setItems]       = useState<Snippet[]>([]);
  const [loading, setLoading]   = useState(false);
  const [filter, setFilter]     = useState('');
  const [editing, setEditing]   = useState<{ id?: number; title: string; body: string } | null>(null);
  const boxRef                  = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems((await api.snippets()).snippets || []); }
    catch (e: any) { toast('err', failed('load your snippets', e)); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (open && items.length === 0 && !loading) void load(); }, [open]);

  // Click-away closes, but never while the editor is open — losing a half-typed
  // snippet to a stray click is worse than an extra Escape.
  useEffect(() => {
    if (!open || editing) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, editing]);

  async function insert(s: Snippet) {
    onInsert(s.body);
    setOpen(false);
    // Ordering is by use, so record it — but a failed count must never look
    // like a failed insert.
    try { await api.snippetUsed(s.id); setItems(prev => prev.map(x => x.id === s.id ? { ...x, useCount: x.useCount + 1 } : x)); }
    catch { /* the text is already in the box */ }
  }

  async function save() {
    if (!editing) return;
    const { id, title, body } = editing;
    if (!title.trim() || !body.trim()) { toast('warn', 'A snippet needs a title and a body'); return; }
    try {
      const r = await api.snippetSave({ id, title: title.trim(), body: body.trim() });
      if (!r.ok) { toast('err', failed('save the snippet', r.error || '')); return; }
      setEditing(null);
      await load();
      toast('ok', id ? 'Snippet updated' : 'Snippet saved');
    } catch (e: any) { toast('err', failed('save the snippet', e)); }
  }

  async function remove(s: Snippet) {
    try { await api.snippetDelete(s.id); setItems(prev => prev.filter(x => x.id !== s.id)); }
    catch (e: any) { toast('err', failed('delete the snippet', e)); }
  }

  const shown = filter.trim()
    ? items.filter(s => (s.title + ' ' + s.body).toLowerCase().includes(filter.trim().toLowerCase()))
    : items;

  return (
    <div className="relative" ref={boxRef}>
      <button onClick={() => setOpen(o => !o)}
        className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium ring-1 ring-inset transition-colors',
          open
            ? 'bg-accent-soft text-accent-text ring-accent-line '
            : 'text-fg-3 ring-line-2 hover:bg-subtle')}>
        <BookMarked className="w-3 h-3" />Snippets
      </button>

      {open && (
        <div className="absolute z-30 bottom-full mb-1.5 left-0 w-96 max-w-[86vw] rounded-xl bg-surface ring-1 ring-line-2 shadow-float p-2">
          {editing ? (
            <div className="space-y-1.5">
              <input autoFocus value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })}
                placeholder="Title — e.g. Standard lead time"
                className="w-full text-sm bg-subtle rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-line-2 focus:outline-none focus:ring-accent-line text-fg placeholder:text-fg-3" />
              <textarea value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })}
                rows={5} placeholder="The exact wording to insert…"
                className="w-full text-sm bg-subtle rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-line-2 resize-none focus:outline-none focus:ring-accent-line text-fg placeholder:text-fg-3 leading-relaxed" />
              <div className="flex items-center gap-1.5">
                <button onClick={save}
                  className="h-6 px-2.5 rounded-md text-xs font-semibold bg-fg text-page hover:opacity-90">Save</button>
                <UiButton tone="secondary" size="xs" onClick={() => setEditing(null)}>Cancel</UiButton>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-1.5">
                <input value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Filter snippets…"
                  className="flex-1 text-xs bg-subtle rounded-md px-2 py-1 ring-1 ring-inset ring-line-2 focus:outline-none focus:ring-accent-line text-fg placeholder:text-fg-3" />
                <UiIconButton icon={Plus} label="New snippet" tone="secondary" size="xs" className="shrink-0" onClick={() => setEditing({ title: '', body: '' })} />
              </div>

              <div className="max-h-64 overflow-y-auto -mx-0.5 px-0.5">
                {loading && <p className="text-xs text-fg-3 px-1 py-2">Loading…</p>}
                {!loading && shown.length === 0 && (
                  <p className="text-xs text-fg-3 px-1 py-3 leading-relaxed">
                    {items.length === 0
                      ? 'No snippets yet. Save the sentences you retype — lead times, commissioning terms, the questions you always ask back.'
                      : 'Nothing matches that filter.'}
                  </p>
                )}
                {shown.map(s => (
                  <div key={s.id} className="group rounded-lg hover:bg-subtle transition-colors">
                    <button onClick={() => insert(s)} className="w-full text-left px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-fg truncate flex-1">{s.title}</span>
                        {s.useCount > 0 && <span className="text-2xs text-fg-3 shrink-0">{s.useCount}×</span>}
                      </div>
                      <p className="text-2xs text-fg-3 line-clamp-2 leading-snug mt-0.5">{s.body}</p>
                    </button>
                    <div className="flex items-center gap-1 px-2 pb-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setEditing({ id: s.id, title: s.title, body: s.body })}
                        className="text-2xs text-fg-3 hover:text-fg">Edit</button>
                      <button onClick={() => remove(s)}
                        className="text-2xs text-err hover:text-err">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: Event) => { if ((e as globalThis.KeyboardEvent).key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-modal bg-overlay flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}>
      <div
        className="relative max-w-[90vw] max-h-[90vh] cursor-default"
        onClick={e => e.stopPropagation()}>
        <img
          src={src}
          alt={name}
          className="block max-w-[88vw] max-h-[85vh] rounded-xl object-contain"
        />
        <div className="absolute top-2 right-2 flex items-center gap-2">
          <span className="text-on-accent text-xs bg-overlay px-2 py-0.5 rounded-md truncate max-w-64">{name}</span>
          <UiIconButton icon={X} label="Close image" size="sm" onClick={onClose} />
        </div>
      </div>
    </div>
  );
}

// ─── HTML email renderer (iframe, sandboxed, Outlook-matched fonts) ──────────
function wrapEmailHtml(html: string): string {
  const t = html.trim();
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  // The frame is a separate document: CSS variables don't cross into it, so the
  // live token values are resolved here and written in as literals.
  const bg   = tokenValue('--s1');
  const fg   = tokenValue('--t1');
  const link = tokenValue('--accent-text');
  const injectStyle = [
    `<style>`,
    `* { max-width: 100%; box-sizing: border-box; }`,
    // The frame is sized to its content and the pane outside scrolls; a
    // scrollbar inside as well showed as a double bar once text was enlarged.
    `html { overflow: hidden; }`,
    `img { max-width: 100%; height: auto; }`,
    `body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: ${fg}; margin: 20px 28px; line-height: 1.55; background: ${bg}; word-wrap: break-word; }`,
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

// A name for the lightbox caption. An inline picture that came from a real
// attachment gets that attachment's filename; anything else (a remote <img> in
// a marketing mail) falls back to its alt text, then its URL's last segment.
function inlineImageName(src: string, img: HTMLImageElement, attachments: AttachmentInfo[]): string {
  const m = /\/api\/outlook\/attachment-view\/[^/]+\/(\d+)/.exec(src);
  if (m) {
    const hit = attachments.find(a => a.index === Number(m[1]));
    if (hit) return hit.name;
  }
  const alt = (img.getAttribute('alt') || '').trim();
  if (alt) return alt;
  try {
    const last = decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || '');
    if (last) return last;
  } catch { /* data: URI or something unparseable — the generic label is fine */ }
  return 'Image';
}

// Links in an email body carry every shape Outlook has ever produced. Normalise
// what can be opened; return '' for what must be ignored (cid: refs, javascript:,
// in-page anchors).
function bodyLinkUrl(href: string): string {
  const h = (href || '').trim();
  if (!h || h.startsWith('#')) return '';
  if (/^(https?|mailto|tel|callto|sip):/i.test(h)) return h;
  if (/^www\./i.test(h)) return 'https://' + h;      // bare domain, no scheme
  return '';                                          // cid:, file:, javascript:, …
}

// Mirrors SEARCH_SCOPE in outlook_reader.py — the only folders search reads.
const SEARCH_SCOPE_LABEL = 'UKQuoteFactoryEL · Inbox + Completed by Laith';

// ─── Match modes ─────────────────────────────────────────────────────────────
// What it takes for a term to count as a hit. The server runs the same three
// rules (MATCH_MODES in server.ts / outlook_reader.py); highlighting reuses them
// so the marks on screen are exactly what the search matched on.
const MATCH_MODE_OPTIONS: { id: MatchMode; short: string; label: string; hint: string }[] = [
  { id: 'part',  short: 'Part',  label: 'part of a word',
    hint: 'Part of a word — “gate” also finds “delegate”. The widest rule, and the one search always used.' },
  { id: 'word',  short: 'Word',  label: 'whole word',
    hint: 'Whole word — “gate” will not find “delegate”. Underscores still count as a break, so “quote” finds EL_quote_2026.' },
  { id: 'start', short: 'Start', label: 'start of a word',
    hint: 'Start of a word — “quo” finds “quote” but not “misquoted”.' },
];

// Deliberately not \b: Eaton joins words with underscores in filenames and
// references, and \w counts `_` as a word character, so \bquote\b never fires
// inside EL_quote_2026_R2.
const WORD_CHAR = '[A-Za-z0-9]';
const rxEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termPattern(term: string, mode: MatchMode): string {
  const esc = rxEscape(term);
  if (mode === 'word')  return `(?<!${WORD_CHAR})${esc}(?!${WORD_CHAR})`;
  if (mode === 'start') return `(?<!${WORD_CHAR})${esc}`;
  return esc;
}

// ─── Search filters ──────────────────────────────────────────────────────────
// Narrowing that runs ALONGSIDE the terms instead of inside them. A query is one
// question ("QW28237"); who it came from, when it landed and whether it carried
// a PDF are separate axes, and folding them into the term list only ever
// produced accidental body hits. Mirrors index_where() in outlook_reader.py, so
// the loaded-list filter and the server search narrow by the same rules.
type DatePreset = 'any' | '7d' | '30d' | '90d' | '12m' | 'custom';

interface FilterState {
  scope:      SearchScope;
  from:       string;
  datePreset: DatePreset;
  since:      string;          // YYYY-MM-DD, only read when datePreset is 'custom'
  until:      string;
  folder:     string;
  att:        'any' | 'yes' | 'no' | 'pdf';
  read:       'any' | 'read' | 'unread';
  sort:       'new' | 'old';
}

// Deliberately NOT persisted, unlike the match mode: a date filter left over
// from last week would silently answer a different question than the one typed.
const EMPTY_FILTERS: FilterState = {
  scope: 'all', from: '', datePreset: 'any', since: '', until: '',
  folder: '', att: 'any', read: 'any', sort: 'new',
};

// Which text the terms are matched against.
const SCOPE_OPTIONS: { id: SearchScope; label: string; hint: string }[] = [
  { id: 'all',        label: 'Everything',  hint: 'Subject, sender, recipients, attachment names and the body.' },
  { id: 'meta',       label: 'Not body',    hint: 'Everything except the body — the fastest way past a term that appears in every signature.' },
  { id: 'subject',    label: 'Subject',     hint: 'The subject line only.' },
  { id: 'from',       label: 'From',        hint: 'Sender name and address only.' },
  { id: 'recipients', label: 'To/CC',       hint: 'The To and CC lines only.' },
  { id: 'atts',       label: 'Files',       hint: 'Attachment filenames only.' },
  { id: 'body',       label: 'Body',        hint: 'The message body only.' },
];

// Folder is a substring of the path the index stores ("UKQuoteFactoryEL\Inbox").
const FOLDER_OPTIONS: { id: string; label: string }[] = [
  { id: '',                   label: 'Both' },
  { id: 'inbox',              label: 'Inbox' },
  { id: 'completed by laith', label: 'Completed' },
];

const ATT_OPTIONS: { id: FilterState['att']; label: string }[] = [
  { id: 'any', label: 'Any' }, { id: 'yes', label: 'Has files' },
  { id: 'pdf', label: 'PDF' }, { id: 'no',  label: 'None' },
];

const READ_OPTIONS: { id: FilterState['read']; label: string }[] = [
  { id: 'any', label: 'Any' }, { id: 'unread', label: 'Unread' }, { id: 'read', label: 'Read' },
];

const DATE_PRESETS: { id: DatePreset; label: string; days: number | null }[] = [
  { id: 'any',    label: 'Any time',  days: null },
  { id: '7d',     label: '7 days',    days: 7 },
  { id: '30d',    label: '30 days',   days: 30 },
  { id: '90d',    label: '3 months',  days: 90 },
  { id: '12m',    label: '12 months', days: 365 },
  { id: 'custom', label: 'Custom',    days: null },
];

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The preset resolved to real dates. A preset is stored as the preset, not as a
// pair of dates, so "30 days" still means 30 days from today tomorrow.
function dateBounds(f: FilterState): { since: string; until: string } {
  if (f.datePreset === 'custom') return { since: f.since, until: f.until };
  const days = DATE_PRESETS.find(p => p.id === f.datePreset)?.days;
  if (!days) return { since: '', until: '' };
  const d = new Date();
  d.setDate(d.getDate() - days);
  return { since: isoDay(d), until: '' };
}

function toApiFilters(f: FilterState): SearchFilters {
  const { since, until } = dateBounds(f);
  return { from: f.from.trim(), since, until, folder: f.folder, att: f.att, read: f.read, sort: f.sort };
}

// Sort is an ordering, not a narrowing, so it never counts as an active filter —
// the badge has to mean "these hits are not everything".
function activeFilterPills(f: FilterState): { key: string; label: string; patch: Partial<FilterState> }[] {
  const out: { key: string; label: string; patch: Partial<FilterState> }[] = [];
  if (f.scope !== 'all')
    out.push({ key: 'scope', label: `in ${SCOPE_OPTIONS.find(o => o.id === f.scope)?.label}`, patch: { scope: 'all' } });
  if (f.from.trim())
    out.push({ key: 'from', label: `from ${f.from.trim()}`, patch: { from: '' } });
  if (f.datePreset !== 'any') {
    const { since, until } = dateBounds(f);
    const label = f.datePreset === 'custom'
      ? (since && until ? `${since} → ${until}` : since ? `since ${since}` : `until ${until}`)
      : `last ${DATE_PRESETS.find(p => p.id === f.datePreset)?.label}`;
    if (f.datePreset !== 'custom' || since || until)
      out.push({ key: 'date', label, patch: { datePreset: 'any', since: '', until: '' } });
  }
  if (f.folder)
    out.push({ key: 'folder', label: FOLDER_OPTIONS.find(o => o.id === f.folder)?.label || f.folder, patch: { folder: '' } });
  if (f.att !== 'any')
    out.push({ key: 'att', label: ATT_OPTIONS.find(o => o.id === f.att)?.label || f.att, patch: { att: 'any' } });
  if (f.read !== 'any')
    out.push({ key: 'read', label: READ_OPTIONS.find(o => o.id === f.read)?.label || f.read, patch: { read: 'any' } });
  return out;
}

// 'YYYY-MM-DD' for a received timestamp, so a date filter can be applied to the
// loaded list with the same bounds the server uses on the index.
function dayKey(received: string): string {
  const d = new Date(received);
  if (!isNaN(d.getTime())) return isoDay(d);
  return (received || '').slice(0, 10);
}

// The same filters, applied to an email already in hand. Folder is skipped:
// only a search hit knows which folder it came from.
function passesFilters(e: EmailSummary, f: FilterState): boolean {
  const from = f.from.trim().toLowerCase();
  if (from && !`${e.sender || ''} ${e.senderEmail || ''}`.toLowerCase().includes(from)) return false;
  const { since, until } = dateBounds(f);
  if (since || until) {
    const day = dayKey(e.received);
    if (since && day < since) return false;
    if (until && day > until) return false;
  }
  const nAtts = e.attachments?.length || 0;
  if (f.att === 'yes' && !nAtts) return false;
  if (f.att === 'no'  && nAtts)  return false;
  if (f.att === 'pdf' && !e.hasPdf) return false;
  if (f.read === 'unread' && !e.unread) return false;
  if (f.read === 'read'   &&  e.unread) return false;
  return true;
}

// The text one scope covers on a loaded email. The body is not held locally
// beyond the preview, so 'all'/'body' search what there is of it.
function scopeHaystack(e: EmailSummary, scope: SearchScope): string {
  const attNames = (e.attachments || []).map(a => a.name).join(' ');
  switch (scope) {
    case 'subject':    return e.subject || '';
    case 'from':       return `${e.sender || ''} ${e.senderEmail || ''}`;
    case 'recipients': return (e.matches || []).filter(m => m.field === 'To/CC').map(m => m.text).join(' ');
    case 'atts':       return attNames;
    case 'body':       return `${e.bodyPreview || ''} ${(e.matches || []).filter(m => m.field === 'Body').map(m => m.text).join(' ')}`;
    case 'meta':       return [e.subject, e.sender, e.senderEmail, attNames].join(' \u0000 ');
    default:           return [e.subject, e.sender, e.senderEmail, e.bodyPreview, attNames,
                               ...(e.matches || []).map(m => m.text)].join(' \u0000 ');
  }
}

// ─── Filter panel ────────────────────────────────────────────────────────────
// One compact row per axis in a 344 px pane: a label, then wrapping chips. Chips
// rather than <select>s because the whole point is seeing what is set without
// opening anything.
function FilterChips<V extends string>({ value, onChange, options, title }: {
  value: V;
  onChange: (v: V) => void;
  options: { id: V; label: string; hint?: string }[];
  title?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" title={title}>
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} title={o.hint}
          className={cn(
            'h-5 px-2 rounded-panel text-2xs font-medium transition-colors',
            value === o.id
              ? 'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line'
              : 'text-fg-3 ring-1 ring-inset ring-line-2 hover:bg-subtle hover:text-fg',
          )}>{o.label}</button>
      ))}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-10 shrink-0 pt-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-4">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SearchFilterPanel({ filters, setFilters, matchMode, setMatchMode, facets, onReset, pillCount }: {
  filters: FilterState;
  setFilters: (patch: Partial<FilterState>) => void;
  matchMode: MatchMode;
  setMatchMode: (m: MatchMode) => void;
  facets: SearchFacets | null;
  onReset: () => void;
  pillCount: number;
}) {
  return (
    <div className="shrink-0 border-b border-line bg-raised px-2.5 py-2.5 flex flex-col gap-2">

      <FilterRow label="Match">
        {/* Short labels: at this width "part of a word" wraps the row on its
            own. The full rule stays one hover away. */}
        <FilterChips value={matchMode} onChange={setMatchMode}
          options={MATCH_MODE_OPTIONS.map(o => ({ id: o.id, label: o.short, hint: o.hint }))} />
      </FilterRow>

      <FilterRow label="In">
        <FilterChips value={filters.scope} onChange={v => setFilters({ scope: v })} options={SCOPE_OPTIONS} />
      </FilterRow>

      <FilterRow label="From">
        <div className="flex items-center gap-1.5">
          <input
            list="inbox-sender-facets"
            value={filters.from}
            onChange={e => setFilters({ from: e.target.value })}
            placeholder={facets?.senders?.length ? `Any of ${facets.senders.length}+ senders` : 'Any sender'}
            title="Part of a sender's name or address. The list offers who the index has actually seen."
            className="flex-1 min-w-0 h-6 px-2 rounded-panel bg-surface ring-1 ring-inset ring-line-2 text-xs text-fg-2 placeholder:text-fg-4 outline-none focus:ring-ai-line"
          />
          {filters.from && (
            <button aria-label="Clear the sender filter" onClick={() => setFilters({ from: '' })}
              className="shrink-0 text-fg-3 hover:text-fg"><X className="w-3 h-3" /></button>
          )}
          <datalist id="inbox-sender-facets">
            {(facets?.senders || []).map(s => (
              <option key={s.email || s.name} value={s.name}>{`${s.count} email${s.count === 1 ? '' : 's'}`}</option>
            ))}
          </datalist>
        </div>
      </FilterRow>

      <FilterRow label="When">
        <div className="flex flex-col gap-1.5">
          <FilterChips value={filters.datePreset} onChange={v => setFilters({ datePreset: v })} options={DATE_PRESETS} />
          {filters.datePreset === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input type="date" value={filters.since} max={filters.until || undefined}
                onChange={e => setFilters({ since: e.target.value })}
                title={facets?.oldest ? `The index reaches back to ${facets.oldest}` : 'Start of the range'}
                className="flex-1 min-w-0 h-6 px-1.5 rounded-panel bg-surface ring-1 ring-inset ring-line-2 text-2xs text-fg-2 outline-none focus:ring-ai-line" />
              <span className="text-2xs text-fg-4">→</span>
              <input type="date" value={filters.until} min={filters.since || undefined}
                onChange={e => setFilters({ until: e.target.value })}
                title={facets?.newest ? `The newest indexed email is from ${facets.newest}` : 'End of the range'}
                className="flex-1 min-w-0 h-6 px-1.5 rounded-panel bg-surface ring-1 ring-inset ring-line-2 text-2xs text-fg-2 outline-none focus:ring-ai-line" />
            </div>
          )}
        </div>
      </FilterRow>

      <FilterRow label="Folder">
        <FilterChips value={filters.folder} onChange={v => setFilters({ folder: v })}
          options={FOLDER_OPTIONS.map(o => ({
            ...o,
            hint: facets?.folders?.find(fo => fo.folder.toLowerCase().includes(o.id))?.count
              ? `${facets!.folders.find(fo => fo.folder.toLowerCase().includes(o.id))!.count.toLocaleString()} indexed`
              : undefined,
          }))}
          title="Which of the two searched folders to look in" />
      </FilterRow>

      <FilterRow label="Files">
        <FilterChips value={filters.att} onChange={v => setFilters({ att: v })} options={ATT_OPTIONS} />
      </FilterRow>

      <FilterRow label="State">
        <FilterChips value={filters.read} onChange={v => setFilters({ read: v })} options={READ_OPTIONS} />
      </FilterRow>

      <div className="flex items-center gap-2 pt-1.5 border-t border-line-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-4">Sort</span>
        <FilterChips value={filters.sort} onChange={v => setFilters({ sort: v })}
          options={[{ id: 'new' as const, label: 'Newest' }, { id: 'old' as const, label: 'Oldest' }]} />
        <div className="flex-1" />
        <button onClick={onReset} disabled={!pillCount}
          className="text-2xs font-medium text-fg-3 hover:text-fg disabled:opacity-35 disabled:hover:text-fg-3">
          Reset {pillCount ? `(${pillCount})` : ''}
        </button>
      </div>
    </div>
  );
}

// ─── Match highlighting ──────────────────────────────────────────────────────
// The terms actually searched: "quoted phrases" stay whole, same split the
// Python side uses, so what is highlighted is what matched.
function highlightTerms(q: string, min = 2): string[] {
  const out: string[] = [];
  for (const m of (q || '').matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] || m[2] || '').trim();
    if (t.length >= min) out.push(t);
  }
  return out;
}

function Highlight({ text, terms, mode = 'part' }: { text: string; terms: string[]; mode?: MatchMode }) {
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp('(' + terms.map(t => termPattern(t, mode)).join('|') + ')', 'ig');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <mark key={i} className="bg-warn-soft text-inherit rounded-control px-px">{p}</mark>
        : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}

// The hit evidence under a row: the field a term landed in and the text around
// it. Without this, a hit deep in the body or in a recipient list arrived with
// nothing highlighted anywhere on the row and read as a false positive.
function MatchTrail({ matches, terms, mode }: { matches?: SearchMatch[]; terms: string[]; mode: MatchMode }) {
  if (!matches?.length) return null;
  return (
    <div className="flex flex-col gap-0.5 mt-0.5">
      {matches.map((m, i) => (
        <div key={i} className="flex items-start gap-1 text-2xs leading-[1.35] min-w-0">
          <span className="shrink-0 px-1 rounded-control bg-subtle text-fg-4 font-medium uppercase tracking-wide">{m.field}</span>
          <span className="flex-1 min-w-0 truncate text-fg-3" title={m.text}>
            <Highlight text={m.text} terms={terms} mode={mode} />
          </span>
        </div>
      ))}
    </div>
  );
}

// Plain-text emails have no anchors at all, so their URLs used to be dead text.
// Linkify them through the same OS-browser route as the HTML body.
function PlainBody({ text, zoom = 1 }: { text: string; zoom?: number }) {
  const parts = (text || '(no body)').split(/(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|[\w.+-]+@[\w-]+\.[\w.]+)/g);
  return (
    <pre className="px-7 py-5 text-fg leading-relaxed whitespace-pre-wrap font-sans" style={{ fontSize: 14.5 * zoom }}>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const url = p.includes('@') && !/^https?:/i.test(p) ? 'mailto:' + p : bodyLinkUrl(p);
        if (!url) return p;
        return (
          <a key={i} href={url}
            onClick={e => { e.preventDefault(); void openExternal(url); }}
            className="text-accent-text hover:underline break-all">{p}</a>
        );
      })}
    </pre>
  );
}

// Pictures pasted into an email are the usual case — a photo of a board, a
// screenshot of a schedule — and they arrive as inline <img> inside the body,
// not as an attachment chip. Only images worth opening get the zoom treatment:
// signature logos, spacers and tracking pixels are all small, so a size floor
// separates "content" from "furniture" without needing to guess from the markup.
const ZOOMABLE_MIN_PX = 64;

function EmailBodyFrame({ html, entryId, attachments, onImageOpen, zoom = 1 }: {
  html: string; entryId: string; attachments: AttachmentInfo[];
  onImageOpen: (img: { src: string; name: string }) => void;
  zoom?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // The frame's height used to be measured ONCE, at load. Anything that reflowed
  // the text afterwards — dragging the list pane, maximising the window, opening
  // the popout, or a tab that loaded while hidden (display:none measures 0, so it
  // froze at the 200px floor) — left the body clipped or trailing blank space.
  // That is the "scaling works only sometimes". A ResizeObserver re-fits on every
  // reflow instead.
  const fitRef  = useRef<() => void>(() => {});
  const roRef   = useRef<ResizeObserver | null>(null);
  const zoomRef = useRef(zoom);
  useEffect(() => () => roRef.current?.disconnect(), []);
  useEffect(() => {
    zoomRef.current = zoom;
    let doc: Document | null = null;
    try { doc = ref.current?.contentDocument ?? null; } catch { doc = null; }
    if (doc?.documentElement) { doc.documentElement.style.zoom = String(zoom); fitRef.current(); }
  }, [zoom]);
  // The handler below lives inside the frame's document for as long as that
  // document does, so it must not close over a stale callback.
  const openRef = useRef(onImageOpen);
  useEffect(() => { openRef.current = onImageOpen; }, [onImageOpen]);
  // Remount counter: if the frame ever leaves its srcdoc document anyway (a
  // redirect, a meta refresh, a link shape the handler below didn't catch), the
  // email is gone from the pane. Rebuild it instead of leaving a blank body.
  const [reloadTick, setReloadTick] = useState(0);
  const rebuilds = useRef(0);

  function onLoad() {
    const frame = ref.current;
    if (!frame) return;
    let doc: Document | null = null;
    try { doc = frame.contentDocument; } catch { doc = null; }   // cross-origin = navigated away
    if (!doc || !/^about:/i.test(doc.URL || '')) {
      if (rebuilds.current < 3) { rebuilds.current += 1; setReloadTick(t => t + 1); }
      return;
    }
    // Re-measured after every image lands, not just once: at load time the
    // pictures have no intrinsic size yet, so measuring only here clipped the
    // bottom off any email whose body is mostly images.
    doc.documentElement.style.zoom = String(zoomRef.current);
    const fit = () => {
      if (!ref.current || !doc?.body) return;
      if (ref.current.offsetParent === null) return;   // hidden tab: measure when shown
      // Rects inside a zoomed document already come back zoomed — scaling them
      // again left a blank tail a third as long as the email.
      const h = Math.max(120, Math.ceil(doc.body.getBoundingClientRect().bottom));
      const next = (h + 24) + 'px';
      if (ref.current.style.height !== next) ref.current.style.height = next;
    };
    fitRef.current = fit;
    fit();
    roRef.current?.disconnect();
    const ro = new ResizeObserver(() => fit());
    if (doc.body) ro.observe(doc.body);
    ro.observe(frame);
    roRef.current = ro;

    // Mark the images big enough to be worth opening. Done per image on its own
    // load event because intrinsic size is the only reliable signal and it is
    // not known until the bytes arrive.
    const markZoomable = (img: HTMLImageElement) => {
      if (img.naturalWidth < ZOOMABLE_MIN_PX || img.naturalHeight < ZOOMABLE_MIN_PX) return;
      if (img.closest('a[href]')) return;          // the link wins; leave it alone
      img.style.cursor = 'zoom-in';
      img.dataset.vectorZoom = '1';
    };
    for (const img of Array.from(doc.images)) {
      if (img.complete) markZoomable(img);
      else img.addEventListener('load', () => { markZoomable(img); fit(); }, { once: true });
    }

    // A click on a link inside this frame must never navigate the frame. The
    // body is a sandboxed srcdoc document, so navigating it throws away the
    // rendered email and lands on a blank/blocked page — the "link does nothing
    // but corrupts the body" symptom. Catch every click here (capture phase,
    // the frame has no scripts of its own) and hand the URL to the OS browser,
    // which is also the only thing that works inside Tauri's single webview.
    const openFromEvent = (e: Event) => {
      const target = e.target as Element | null;
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (a) {
        const raw = a.getAttribute('href') || '';
        if (raw.startsWith('#')) return;              // in-page anchor: harmless
        e.preventDefault();
        e.stopPropagation();
        const url = bodyLinkUrl(raw);
        if (url) void openExternal(url);
        return;
      }
      // Not a link — an inline picture opens in the same lightbox the
      // attachment chips use, so a pasted screenshot is readable without
      // hunting for a chip that was never there.
      // Primary button only. Chrome routes right-click through auxclick too, and
      // swallowing that would cost the reader "Save image as" / "Copy image".
      if ((e as globalThis.MouseEvent).button !== 0) return;
      const img = target?.closest?.('img[data-vector-zoom]') as HTMLImageElement | null;
      if (!img) return;
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('cid:')) return;     // never resolved to a real URL
      e.preventDefault();
      e.stopPropagation();
      openRef.current({ src, name: inlineImageName(src, img, attachments) });
    };
    doc.addEventListener('click', openFromEvent, true);
    doc.addEventListener('auxclick', openFromEvent, true);   // middle-click
  }
  return (
    <iframe
      key={reloadTick}
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

// The CBU salesman roster comes from gitignored config -- see src/lib/salesmen.ts.

// Known CBU system capacities in kVA — used to validate watt-to-kVA conversions
const CBU_KNOWN_KVA = [0.5,1,2,4,5,6,8,10,12,14,15,16,18,20,24,28,30,32,36,40,42,48,54,56,60];
function isNearKnownCBU(kva: number) {
  return CBU_KNOWN_KVA.some(k => Math.abs(k - kva) / k <= 0.15);
}

// The sizing sheet rates 1 kVA as 950 W, so that — not 1000 — is the divisor
// that turns a load in watts into the system that carries it.
const CBU_W_PER_KVA = 950;

// Numbers written next to these words describe losses or draw, never the system
// size, and used to invent phantom systems ("0.4 kW heat dissipation" → 0.5 kVA).
const CBU_NOISE_NEAR = /(heat|dissipat|loss|losses|consumption|standby|charg\w*|per\s+luminaire|luminaire|fitting|battery pack|inrush|draw)/i;

// Everything that tells us how many phases a number is about, read from the text
// AROUND that number rather than from the whole email — a mail can quote a 3PH
// and a 1PH system in consecutive lines.
const CBU_3PH_NEAR = /(three[\s-]?phase|3[\s-]?phase|\b3\s?ph\b|\b3ph\b|400\s?v|415\s?v|tp&?n)/i;
const CBU_1PH_NEAR = /(single[\s-]?phase|1[\s-]?phase|\b1\s?ph\b|\b1ph\b|230\s?v|240\s?v|sp&?n)/i;

export interface CBUHint { kva: number; phase: '1PH' | '3PH'; raw: string; system: string; }

// The phase belongs to whichever cue sits CLOSEST to the number. Taking the
// first cue that matched the window made "one 3PH 20kVA unit and a single phase
// 2kVA unit" call both of them three-phase.
function nearestPhase(hay: string, idx: number): '1PH' | '3PH' | null {
  const lo  = Math.max(0, idx - 90);
  const win = hay.slice(lo, idx + 90);
  const rel = idx - lo;
  const nearest = (re: RegExp) => {
    const g = new RegExp(re.source, 'gi');
    let best = Infinity, m: RegExpExecArray | null;
    while ((m = g.exec(win)) !== null) best = Math.min(best, Math.abs(m.index - rel));
    return best;
  };
  const d3 = nearest(CBU_3PH_NEAR), d1 = nearest(CBU_1PH_NEAR);
  if (d3 === Infinity && d1 === Infinity) return null;
  return d3 <= d1 ? '3PH' : '1PH';
}

// Pull the CBU system size(s) out of an enquiry. Reads the SUBJECT as well as
// the body (half of them say "20kVA CBU" in the subject and nowhere else), takes
// kVA / kW / VA / W, and decides the phase per mention instead of once for the
// whole email.
function extractCBUHints(text: string): { detected: boolean; detectedSystems: CBUHint[] } {
  // 1,600 W / 1.600,5 kVA — strip the thousands separator so the number parses.
  const hay = (text || '').replace(/(\d)[, \s](\d{3})\b/g, '$1$2');

  const detected = /\bcbu\b|central battery|loadstar(?:[-\s]?ps)?|static inverter|\bcps\b/i.test(hay) ||
    (/\bups\b/i.test(hay) && /\bk?va\b/i.test(hay));
  if (!detected) return { detected: false, detectedSystems: [] };

  const hits: CBUHint[] = [];
  const unitRe = /(\d+(?:[.,]\d+)?)\s*(kva|kw|va|w(?:atts?)?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(hay)) !== null) {
    const val  = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(val) || val <= 0) continue;

    const before = hay.slice(Math.max(0, m.index - 45), m.index);
    if (CBU_NOISE_NEAR.test(before)) continue;

    let kva: number;
    if (unit === 'kva')                       kva = val;
    else if (unit === 'kw')                   kva = val / 0.95;      // sheet PF
    else if (unit === 'va')                   kva = val / 1000;
    else                                      kva = val / CBU_W_PER_KVA;

    // An explicit kVA figure is the customer telling us the system. Anything
    // derived from a load only counts when it lands on a system that exists,
    // which is what keeps currents and heat figures out of the list.
    if (unit !== 'kva' && !isNearKnownCBU(kva)) continue;
    if (kva < 0.4 || kva > 70) continue;

    const phase: '1PH' | '3PH' =
      nearestPhase(hay, m.index)
      ?? (CBU_3PH_NEAR.test(hay) ? '3PH'
        : CBU_1PH_NEAR.test(hay) ? '1PH'
        : kva >= 6 ? '3PH' : '1PH');

    hits.push({ kva, phase, raw: m[0].trim(), system: pickCBUSystem(kva, phase) });
  }

  // One entry per distinct system, explicit kVA mentions winning over derived
  // ones when both snap to the same box.
  const seen = new Set<string>();
  const detectedSystems: CBUHint[] = [];
  for (const h of [...hits.filter(h => /kva/i.test(h.raw)), ...hits.filter(h => !/kva/i.test(h.raw))]) {
    if (seen.has(h.system)) continue;
    seen.add(h.system);
    detectedSystems.push(h);
    if (detectedSystems.length >= 6) break;
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
      className="flex-1 h-7 px-2 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg focus:outline-none focus:ring-accent-line">
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
  // Subject first: plenty of enquiries carry the size there and nowhere else.
  const hints = extractCBUHints(`${emailSubject}\n${emailBody}`);
  const cleanSubject = emailSubject.replace(/^(RE:|FW:|Fwd:)\s*/gi, '').replace(/SR00[A-Z0-9]+\s*/gi, '').trim();

  const [systems,  setSystems]  = useState<string[]>(() =>
    hints.detectedSystems.length > 0 ? hints.detectedSystems.map(h => h.system) : [CBU_SYSTEMS[0]]);
  const [project, setProject] = useState(cleanSubject);
  const [quote,   setQuote]   = useState('');
  const [smIdx,   setSmIdx]   = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [dlId,    setDlId]    = useState<string | null>(null);

  const CBU_SALESMEN = useSalesmen();
  const sm = smIdx !== null ? CBU_SALESMEN[smIdx] ?? null : null;
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
      toast('ok', `CBU tech sheet ready — ${plural(systems.length, 'system')}`);
    } catch (e: any) { toast('err', failed('build the CBU tech sheet', e)); }
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
        <Battery className="w-3.5 h-3.5 text-accent-text shrink-0" />
        <p className="text-xs font-semibold text-fg flex-1">CBU Tech Sheet Generator</p>
        {hints.detectedSystems.length > 0 && (
          // Show what was READ, not just what was picked — a wrong snap is only
          // obvious next to the text it came from.
          <span title={hints.detectedSystems.map(h => `"${h.raw}" → ${h.system}`).join('\n')}
            className="px-2 py-0.5 rounded-full text-2xs font-semibold bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line ">
            read {hints.detectedSystems.map(h => h.raw).join(' + ')}
          </span>
        )}
      </div>

      {/* Systems list */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide flex-1">Systems</label>
          <UiButton tone="ghost" size="xs" onClick={addSystem}>
            <Plus className="w-2.5 h-2.5" />Add
          </UiButton>
        </div>
        {systems.map((sys, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-2xs text-fg-3 w-4 text-right shrink-0">{i + 1}</span>
            <CBUSystemSelect value={sys} onChange={v => updateSystem(i, v)} />
            {systems.length > 1 && (
              <UiIconButton icon={X} label="Remove this system" tone="danger" size="xs" className="shrink-0" onClick={() => removeSystem(i)} />
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Project Name</label>
          <input value={project} onChange={e => setProject(e.target.value)} placeholder="Project name…"
            className="mt-1 w-full h-7 px-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-accent-line" />
        </div>
        <div>
          <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Quote Ref</label>
          <input value={quote} onChange={e => setQuote(e.target.value)} placeholder="Q-XXXX…"
            className="mt-1 w-full h-7 px-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-accent-line" />
        </div>
        <div className="col-span-2">
          <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Sales Engineer</label>
          <select value={smIdx ?? ''} onChange={e => setSmIdx(e.target.value === '' ? null : Number(e.target.value))}
            className="mt-1 w-full h-7 px-2 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg focus:outline-none focus:ring-accent-line">
            <option value="">Select salesman…</option>
            {CBU_SALESMEN.length === 0 && <option value="" disabled>No salesmen configured (config.json)</option>}
            {CBU_SALESMEN.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <UiButton tone="primary" onClick={generate} disabled={!ok || loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Battery className="w-3 h-3" />}
          Generate {systems.length > 1 ? `${systems.length} Sheets` : 'Tech Sheet'}
        </UiButton>
        {dlId && (
          <UiButton tone="ghost" onClick={download}>
            <Download className="w-3 h-3" />Download PDF
          </UiButton>
        )}
      </div>
    </div>
  );
}

/**
 * Subject with every reply/forward prefix stripped, for deciding which emails
 * belong together. 'RE: FW: Bristol Hippodrome' and 'Bristol Hippodrome' are one
 * enquiry; Outlook's own conversation id is not on the summary rows, so the
 * subject is what there is to match on. Handles the non-English prefixes that
 * turn up on forwarded European mail (AW/TR/VS) as well as RE/FW/FWD.
 */
function baseSubject(s: string) {
  let t = String(s || '').trim();
  // ONE loop over both kinds of prefix, because they interleave. Real subject
  // off the UK box: 'Re: [EXTERNAL] FW: 8204 - em lighting - Amazon Exeter' —
  // stripping all the RE/FW first and the '[EXTERNAL]' after leaves the second
  // 'FW:' sitting there, and the four emails of that enquiry stop matching each
  // other. Strip whichever comes next until nothing is left to strip.
  for (;;) {
    const next = t
      .replace(/^\s*(re|fw|fwd|aw|tr|vs)\s*(\[\d+\])?\s*:\s*/i, '')   // Re: / FW: / AW:
      .replace(/^\s*\[[^\]]{1,20}\]\s*/, '');                          // [EXTERNAL], [EXT]
    if (next === t) break;
    t = next;
  }
  // An enquiry sent in chunks numbers its parts in the SUBJECT, so the pieces
  // never match each other on it. Real ones off the UK box, four days apart:
  // 'Bristol Hippodrome 2 of 2' and 'Bristol Hippodrome 3 of 3' — the sender
  // does not even keep the total straight. Drop the counter and they are one
  // enquiry again, which is the whole point of the picker.
  t = t
    .replace(/[\s\-–—(\[]*\b(part|pt)?\s*\d{1,3}\s*(of|\/)\s*\d{1,3}\s*[)\]]*\s*$/i, '')
    .replace(/[\s\-–—(\[]*\b(part|pt)\s*\d{1,3}\s*[)\]]*\s*$/i, '');
  return t.trim().toLowerCase();
}

/** One priceable file, and which email it came out of. */
interface PricerSource {
  key: string;                 // entryId:index — unique across emails
  entryId: string;
  att: AttachmentInfo;
  sender: string;              // shown on the chip when it is not this email's
  own: boolean;                // true = the email currently open
}

function InlineELPricer({
  emailBody, entryId, attachments, toast, setAppTab, subject, emailList, storeId,
}: {
  emailBody: string;
  entryId: string;
  attachments: AttachmentInfo[];
  toast: ToastFn;
  setAppTab: (t: string) => void;
  subject?: string;
  emailList: EmailSummary[];
  storeId: string;
}) {
  const [listText, setListText] = useState(() => extractMaterialHints(emailBody));
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<{ items: MiniPricedItem[]; total_ntp: number; unmatched: string[]; candidates?: MiniCandidate[] } | null>(null);
  const [copied, setCopied]     = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pdfSource, setPdfSource] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>(() => _pricerSchedule);
  const [schedCopied, setSchedCopied] = useState(false);
  // Which attachments are ticked for a single combined run. Empty = none picked,
  // and the chips behave the way they always did (click one, price one).
  const [picked, setPicked]     = useState<Set<string>>(new Set());
  const [handingOff, setHandingOff] = useState(false);
  // The in-flight run, so Cancel has something to abort.
  const abortRef = useRef<AbortController | null>(null);
  // The manual list collapses once there are attachments to work with — it is
  // the least-used control in the panel and it was costing three lines of a
  // panel that is 288px tall by default.
  const [showList, setShowList] = useState(false);

  const priceable = useCallback(
    (a: AttachmentInfo) => a.isPdf || isImageFile(a.name) || isExcelFile(a.name), []);

  // This email's priceable files. Pooling ACROSS emails happens on the EL Pricer
  // screen, not here — the shape is kept so both ends share one pricing path.
  const sources: PricerSource[] = React.useMemo(
    () => attachments.filter(priceable).map(a => ({
      key: `${entryId}:${a.index}`, entryId, att: a, sender: '', own: true,
    })),
    [attachments, entryId, priceable]);

  // ── Emails worth offering ─────────────────────────────────────────────────
  // Only the COUNT is used here — enough to offer the way through to the EL
  // Pricer screen, which is where the emails are actually chosen.
  const { related, others } = React.useMemo(() => {
    const mine = baseSubject(subject || '');
    const rel: EmailSummary[] = [], oth: EmailSummary[] = [];
    for (const e of emailList) {
      if (e.entryId === entryId) continue;
      if (!(e.attachments || []).some(priceable)) continue;
      // SUBJECT ONLY. Matching the sender too was tried and it is useless here:
      // the quotes arrive through shared mailboxes ('UK Customer Service' sends
      // everything), so it offered seven unrelated emails on the first case it
      // was pointed at. The subject is what actually identifies an enquiry — the
      // Amazon Exeter one runs to four emails from three different senders.
      if (!!mine && baseSubject(e.subject) === mine) rel.push(e);
      else oth.push(e);
    }
    return { related: rel, others: oth };
  }, [emailList, entryId, subject, priceable]);
  void others;   // the full list is offered on the EL Pricer screen, not here

  /** Pull an Outlook attachment down as a real File, so it can be priced the
   *  same way a dropped file is — one code path for both, and it works for an
   *  attachment on any email, not just the one on screen. */
  const fetchAttachmentFile = useCallback(async (s: PricerSource): Promise<File | null> => {
    try {
      const resp = await fetch(attViewUrl(s.entryId, s.att.index));
      if (!resp.ok) throw new Error(`${resp.status}`);
      const blob = await resp.blob();
      return new File([blob], s.att.name, { type: blob.type || 'application/octet-stream' });
    } catch (e: any) {
      toast('err', failed(`open ${s.att.name}`, e));
      return null;
    }
  }, [toast]);

  /**
   * Price any number of files in ONE request. `/api/schematics/price` already
   * takes repeated `files` parts — the same endpoint the EL Pricer tab posts to
   * — so several attachments come back as a single merged list with one total,
   * instead of the one-at-a-time route that threw the previous result away on
   * every drop.
   */
  async function priceFiles(files: File[], label: string) {
    if (!files.length) return;
    setLoading(true);
    setResult(null);
    setPdfSource(label);
    try {
      // Registered as a task so the floating dock can kill it, AND held on a ref
      // so the panel's own Cancel button can. Pricing a pooled run is minutes of
      // AI on someone else's clock; starting one by mistake and having no way to
      // stop it is the worst version of this panel.
      await runTask(`Pricing ${label}`, async (signal) => {
        const ctl = new AbortController();
        abortRef.current = ctl;
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', () => ctl.abort());

        const fd = new FormData();
        for (const f of files) fd.append('files', f, f.name);
        // Anything typed in the box is priced alongside the files, not discarded.
        if (listText.trim()) fd.append('text', listText);
        const resp = await fetch('/api/schematics/price', { method: 'POST', body: fd, signal: ctl.signal });
        const data = await resp.json();
        if (data.error) { toast('err', failed(`price ${label}`, data.error)); setPdfSource(null); }
        else setResult(data);
      });
    } catch (e: any) {
      setPdfSource(null);
      if (isCancel(e)) toast('warn', 'Pricing cancelled — nothing was priced');
      else toast('err', failed(`price ${label}`, e));
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  /** Stop an in-flight run from the panel itself. */
  function cancelRun() {
    abortRef.current?.abort();
  }

  /** A label naming what a combined run was built from, so the schedule entry
   *  and the header say "3 emails · 7 files" rather than one arbitrary filename. */
  function runLabel(chosen: PricerSource[]) {
    if (chosen.length === 1) return chosen[0].att.name;
    const emails = new Set(chosen.map(s => s.entryId)).size;
    return emails > 1
      ? `${plural(emails, 'email')} · ${plural(chosen.length, 'file')}`
      : `${chosen.length} attachments`;
  }

  async function priceSelected() {
    const chosen = sources.filter(s => picked.has(s.key));
    if (!chosen.length) return;
    setLoading(true);
    const files = (await Promise.all(chosen.map(fetchAttachmentFile))).filter(Boolean) as File[];
    setLoading(false);
    if (!files.length) return;
    await priceFiles(files, runLabel(chosen));
  }

  /** Send this email's list and attachments to the full EL Pricer tab. */
  async function openInPricerTab() {
    setHandingOff(true);
    try {
      // Ticked ones if any are ticked, otherwise everything priceable — the
      // point of the jump is to arrive with the work already loaded.
      const wanted = picked.size ? sources.filter(s => picked.has(s.key)) : sources;
      const files = (await Promise.all(wanted.map(fetchAttachmentFile))).filter(Boolean) as File[];
      sendToPricer({
        text: listText, files, source: subject || 'Outlook email',
        origin: { entryId, subject: subject || '', storeId },
      });
      setAppTab('Schematics');
      toast('ok', files.length
        ? `Opened EL Pricer with ${plural(files.length, 'file')} from this email`
        : 'Opened EL Pricer');
    } finally { setHandingOff(false); }
  }

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
      if (data.error) { toast('err', failed('price that list', data.error)); }
      else setResult(data);
    } catch (e: any) { toast('err', failed('price that list', e)); }
    setLoading(false);
  }

  function pickCandidate(c: MiniCandidate) {
    if (!c.matched || c.ntp == null) {
      toast('warn', `${c.cat_no} is not in the price list — no price to add`);
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
    toast('ok', `Added ${c.cat_no} × ${qty} to the schedule`);
  }

  async function priceFromAttachment(attIndex: number, attName: string, isImage = false) {
    setLoading(true);
    setResult(null);
    setPdfSource(attName);
    try {
      await runTask(`Pricing ${attName}`, async (signal) => {
        const ctl = new AbortController();
        abortRef.current = ctl;
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', () => ctl.abort());
        const resp = await fetch('/api/outlook/attachment-price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId, index: attIndex, isImage }),
          signal: ctl.signal,
        });
        const data = await resp.json();
        if (data.error) { toast('err', failed(`price ${attName}`, data.error)); setPdfSource(null); }
        else setResult(data);
      });
    } catch (e: any) {
      setPdfSource(null);
      if (isCancel(e)) toast('warn', 'Pricing cancelled — nothing was priced');
      else toast('err', failed(`price ${attName}`, e));
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    // 'Files' is what Explorer, the desktop and Outlook itself put on the drag —
    // the panel used to ignore all of it and only take its own attachment chips,
    // which is why selecting several files and dropping them did nothing.
    if (e.dataTransfer.types.includes('vector/attachment')
      || e.dataTransfer.types.includes('Files')) setDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  }
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    // Real files off the desktop, a folder window, or several selected at once.
    const dropped = Array.from(e.dataTransfer.files || []);
    if (dropped.length) {
      const usable = dropped.filter(f => f.name && (isImageFile(f.name) || isExcelFile(f.name) || /\.pdf$/i.test(f.name)));
      const skipped = dropped.length - usable.length;
      if (skipped) toast('warn', `${plural(skipped, 'file')} skipped — only PDF, image, Excel and CSV can be priced`);
      if (usable.length) {
        await priceFiles(usable, usable.length === 1 ? usable[0].name : `${usable.length} files`);
      }
      return;
    }

    // An attachment chip dragged out of the email above. Dragging one that is
    // ticked brings every ticked one with it, so a multi-select can be dropped
    // in a single gesture.
    try {
      const raw = e.dataTransfer.getData('vector/attachment');
      if (!raw) return;
      const { attIndex, attName, isImage } = JSON.parse(raw);
      if (picked.size > 1 && picked.has(attIndex)) { await priceSelected(); return; }
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
    toast('ok', `Added ${plural(matched.length, 'item')} to the schedule`);
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
    toast('ok', `Full schedule copied to the clipboard — ${plural(allItems.length, 'item')}`);
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
    toast('ok', `Material schedule copied to the clipboard — ${plural(matched.length, 'item')}`);
  }

  const matched   = result?.items.filter(i => i.matched) || [];
  const unmatched = result?.items.filter(i => !i.matched) || [];

  return (
    <div
      className={cn(
        'rounded-xl ring-1 ring-inset p-4 space-y-3 transition-colors',
        dragOver
          ? 'bg-warn-soft ring-warn-line '
          : 'bg-surface ring-warn-line ',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}>

      {/* Header — one line, and the two controls that were missing from it:
          pick every attachment at once, and take the lot to the full tab. */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 flex items-center justify-center shrink-0 text-warn">
          <Zap className="w-3 h-3 text-warn" />
        </div>
        <p className="text-sm font-semibold text-fg shrink-0">EL Material Pricer</p>
        {pdfSource && (
          <span className="text-2xs text-accent-text bg-accent-soft px-2 py-0.5 rounded-full ring-1 ring-inset ring-accent-line truncate min-w-0">{pdfSource}</span>
        )}
        <div className="flex-1" />
        {sources.length > 1 && (
          <button
            onClick={() => setPicked(p => p.size === sources.length ? new Set() : new Set(sources.map(s => s.key)))}
            title={picked.size === sources.length ? 'Clear the selection' : 'Select every attachment'}
            className="shrink-0 text-2xs font-medium text-fg-3 hover:text-accent-text transition-colors">
            {picked.size === sources.length ? 'Select none' : 'Select all'}
          </button>
        )}
        <UiButton tone="secondary" size="xs" className="shrink-0" onClick={openInPricerTab} disabled={handingOff} hint="Open the full EL Pricer tab with this email's list and attachments">
          {handingOff ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
          Open in EL Pricer
        </UiButton>
      </div>

      {/* Attachment chips — PDF, images and Excel, from THIS email and from any
          email folded in below. One scrolling row rather than a wrapping block,
          so six attachments cost one line, not three. */}
      {sources.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto vec-scroll pb-1 -mb-0.5">
          {sources.map(src => {
            const a   = src.att;
            const img = isImageFile(a.name);
            const xls = isExcelFile(a.name);
            const on  = picked.has(src.key);
            return (
              <button aria-label={`${on ? 'Deselect' : 'Select'} ${a.name}`}
                key={src.key}
                // Click ticks it; that is what makes "all of them at once"
                // possible. Double-click still prices this one on its own.
                onClick={() => setPicked(p => {
                  const n = new Set(p);
                  if (n.has(src.key)) n.delete(src.key); else n.add(src.key);
                  return n;
                })}
                onDoubleClick={() => { if (src.own) priceFromAttachment(a.index, a.name, img); }}
                draggable={src.own}
                onDragStart={e => {
                  if (!src.own) return;
                  e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: a.index, attName: a.name, isImage: img }));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                disabled={loading}
                title={src.own
                  ? `${a.name} — click to select, double-click to price on its own`
                  : `${a.name} — from the email by ${src.sender}`}
                className={cn(
                  'inline-flex items-center gap-1.5 h-6 pl-2 pr-2.5 rounded-md text-2xs font-medium ring-1 ring-inset shrink-0 disabled:opacity-50 transition-colors cursor-pointer',
                  on
                    ? 'bg-warn text-on-status ring-warn-line'
                    : xls
                      ? 'bg-ok-soft text-ok ring-ok-line hover:bg-ok-soft '
                      : img
                        ? 'bg-ok-soft text-ok ring-ok-line hover:bg-ok-soft '
                        : 'bg-accent-soft text-accent-text ring-accent-line hover:bg-accent-soft',
                )}>
                {on
                  ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                  : xls ? <FileSpreadsheet className="w-3 h-3 shrink-0" />
                    : img ? <ImageIcon className="w-3 h-3 shrink-0" />
                      : <FileText className="w-3 h-3 shrink-0" />}
                <span className="truncate max-w-36">{a.name}</span>
                {/* Whose email this came out of — without it a pooled run is a
                    row of filenames with no way to tell them apart. */}
                {!src.own && <span className="opacity-60 shrink-0">· {src.sender}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* The enquiry picker used to sit here. It moved to the EL Pricer screen
          (Schematics.tsx): choosing among several emails needs room, and this
          panel is 288px tall by default — the crowding was the complaint that
          started all this. What stays here is the count and the way through. */}
      {related.length > 0 && (
        <button
          onClick={openInPricerTab}
          disabled={handingOff || loading}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left ring-1 ring-inset ring-line-2 bg-raised hover:bg-subtle disabled:opacity-50 transition-colors">
          <Mail className="w-3 h-3 shrink-0 text-fg-3" />
          <span className="flex-1 min-w-0 text-2xs text-fg-2 truncate">
            {plural(related.length, 'more email')} in this enquiry — price them together
          </span>
          <ExternalLink className="w-3 h-3 shrink-0 text-fg-3" />
        </button>
      )}

      {/* One button for the whole selection — the thing the panel had no way of
          expressing before, when every attachment was priced on its own and each
          run threw the last result away. */}
      {picked.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <UiButton tone="ghost" onClick={priceSelected} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {loading ? 'Pricing…' : (() => {
              const emails = new Set(sources.filter(x => picked.has(x.key)).map(x => x.entryId)).size;
              return `Price ${plural(picked.size, 'file')} together`
                   + (emails > 1 ? ` · ${emails} emails` : '');
            })()}
          </UiButton>
          {loading ? (
            <UiButton tone="secondary" onClick={cancelRun}>
              <X className="w-3 h-3" /> Cancel
            </UiButton>
          ) : (
            <button
              onClick={() => setPicked(new Set())}
              className="text-2xs text-fg-3 hover:text-fg transition-colors">
              Clear
            </button>
          )}
          <span className="text-2xs text-fg-3">one list, one total</span>
        </div>
      )}

      {/* Drop zone highlight */}
      {dragOver && (
        <div className="flex items-center justify-center h-10 rounded-lg border-2 border-dashed border-warn-line text-xs font-medium text-warn ">
          Drop PDFs, images or Excel — as many as you like
        </div>
      )}

      {/* Loading state for PDF pricing */}
      {loading && pdfSource && (
        <div className="flex items-center gap-2 text-sm text-warn py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="flex-1 min-w-0 truncate">Extracting items from {pdfSource} via AI…</span>
          <UiButton tone="secondary" size="xs" className="shrink-0" onClick={cancelRun}>
            <X className="w-3 h-3" /> Cancel
          </UiButton>
        </div>
      )}

      {/* Manual list. Folded away when the email brought attachments — those are
          what gets priced nine times out of ten, and three rows of textarea is a
          third of the panel's default height. One click brings it back, and it
          opens by itself when there is nothing else to work with. */}
      {!pdfSource && (
        showList || sources.length === 0 ? (
          <textarea
            value={listText}
            onChange={e => setListText(e.target.value)}
            placeholder={`Paste material list here…\nMP2ES230CGS, 6\nNXL100, 12`}
            rows={3}
            className="w-full rounded-lg bg-surface ring-1 ring-inset ring-line-2 p-2.5 text-xs mono focus:outline-none focus:ring-accent-line resize-none placeholder:text-fg-4"
          />
        ) : (
          <button
            onClick={() => setShowList(true)}
            className="w-full text-left px-2.5 py-1.5 rounded-lg text-2xs text-fg-3 ring-1 ring-inset ring-line-2 hover:bg-subtle transition-colors">
            {listText.trim()
              ? `${plural(listText.trim().split('\n').length, 'line')} detected in the email — click to edit or price as text`
              : 'Paste a material list instead'}
          </button>
        )
      )}

      {/* Action row */}
      <div className="flex items-center gap-2 flex-wrap">
        {!pdfSource && (showList || sources.length === 0) && (
          <UiButton tone="ghost" onClick={run} disabled={loading || !listText.trim()}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {loading ? 'Pricing…' : 'Get NTP Prices'}
          </UiButton>
        )}
        {pdfSource && !loading && (
          <UiButton tone="secondary" onClick={() => { setResult(null); setPdfSource(null); }}>
            ← Manual input
          </UiButton>
        )}
        {result && matched.length > 0 && (
          <>
            <UiButton tone="ghost" onClick={addToSchedule}>
              <Plus className="w-3 h-3" />
              Add to Schedule
            </UiButton>
            <UiButton tone="secondary" onClick={copySchedule}>
              {copied ? <CheckCircle2 className="w-3 h-3 text-ok" /> : <FileText className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy result'}
            </UiButton>
          </>
        )}
        {result && (
          <span className="text-2xs text-fg-3">
            {matched.length} matched{unmatched.length > 0 ? ` · ${unmatched.length} not found` : ''}
          </span>
        )}
      </div>

      {/* Candidate suggestions (descriptive search) */}
      {result && result.candidates && result.candidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">
            Suggested matches · pick to add
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {result.candidates.map((c, idx) => {
              const tone = c.confidence === 'high'
                ? 'bg-ok-soft ring-ok-line '
                : c.confidence === 'low'
                  ? 'bg-warn-soft ring-warn-line '
                  : 'bg-subtle ring-line-2';
              return (
                <div key={`${c.cat_no}-${idx}`} className={cn('rounded-lg ring-1 ring-inset p-2.5 text-xs', tone)}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="text-2xs font-semibold uppercase tracking-wide text-fg-3">
                          {c.confidence || 'med'}
                        </span>
                        {c.matched
                          ? <span className="text-2xs px-1 py-0.5 rounded bg-ok-soft text-ok ">in list</span>
                          : <span className="text-2xs px-1 py-0.5 rounded bg-subtle text-fg-2">not priced</span>}
                        {c.suggested_qty && c.suggested_qty > 1 && (
                          <span className="text-2xs px-1 py-0.5 rounded bg-accent-soft text-accent-text">qty {c.suggested_qty}</span>
                        )}
                      </div>
                      <p className="mono text-xs font-semibold text-fg truncate">{c.cat_no}</p>
                      {c.family && <p className="text-2xs text-accent-text truncate">{c.family}</p>}
                      {c.description && <p className="text-2xs text-fg-2 line-clamp-2">{c.description}</p>}
                      {c.reasoning && <p className="text-2xs text-fg-3 italic mt-0.5 line-clamp-2">"{c.reasoning}"</p>}
                    </div>
                    {c.matched && c.ntp != null && (
                      <div className="text-right shrink-0">
                        <p className="text-2xs uppercase text-fg-3">NTP</p>
                        <p className="text-sm font-semibold tabular-nums">{fmtGBP(c.ntp)}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5 mt-1.5">
                    <UiButton tone="ghost" size="xs" onClick={() => pickCandidate(c)} disabled={!c.matched}>
                      <Plus className="w-2.5 h-2.5" /> Add
                    </UiButton>
                    {c.source_url && (
                      <a href={c.source_url} target="_blank" rel="noreferrer"
                         className="inline-flex items-center h-6 px-2 rounded text-2xs text-accent-text hover:underline">
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
        <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-line">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface text-2xs text-fg-3 font-semibold uppercase tracking-wide">
                <th className="px-3 py-1.5 text-left">Catalogue No</th>
                <th className="px-3 py-1.5 text-left">Description</th>
                <th className="px-3 py-1.5 text-right">Qty</th>
                <th className="px-3 py-1.5 text-right">NTP/Unit</th>
              </tr>
            </thead>
            <tbody>
              {matched.map((item, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-1.5">
                    <span className="mono font-semibold text-accent-text">{item.cat_no}</span>
                    {item.original_input && item.original_input !== item.cat_no && (
                      <span className="ml-1.5 text-2xs text-warn mono">← {item.original_input}</span>
                    )}
                    {item.search_note && /^[⚠]|range header/i.test(item.search_note) ? (
                      <span className="ml-1.5 text-2xs bg-warn-soft text-warn px-1 py-0.5 rounded cursor-help" title={item.search_note}>⚠ verify</span>
                    ) : item.search_note ? (
                      <span className="ml-1.5 text-2xs bg-ai-soft text-ai px-1 py-0.5 rounded cursor-help" title={item.search_note}>Google</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-fg-2 max-w-48 truncate">{item.description}</td>
                  <td className="px-3 py-1.5 text-right text-fg-2">{item.qty}</td>
                  <td className="px-3 py-1.5 text-right mono text-fg">{fmtGBP(item.ntp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Unmatched items with closest matches */}
      {result && unmatched.length > 0 && (
        <div className="rounded-lg ring-1 ring-inset ring-err-line overflow-hidden">
          <div className="px-3 py-1.5 bg-err-soft text-2xs font-semibold text-err uppercase tracking-wide">
            {unmatched.length} not found in price list
          </div>
          {unmatched.map((item, i) => (
            <div key={i} className="border-t border-err-line px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono text-xs font-semibold text-err ">{item.cat_no}</span>
                {item.description && <span className="text-2xs text-fg-3 truncate">{item.description}</span>}
                {item.status === 'Non-Eaton' && (
                  <span className="text-2xs bg-subtle text-fg-3 px-1.5 py-0.5 rounded">Non-Eaton</span>
                )}
                {item.search_note && (
                  <span className="text-2xs text-fg-3 italic truncate max-w-48">{item.search_note}</span>
                )}
              </div>
              {item.closest_matches && item.closest_matches.length > 0 && (
                <div className="space-y-0.5">
                  <p className="text-2xs text-fg-3 font-medium">Closest in price list:</p>
                  {item.closest_matches.map((m, j) => (
                    <div key={j} className="flex items-center gap-2 text-2xs">
                      <span className="mono text-accent-text">{m.cat_no}</span>
                      <span className="text-fg-3 truncate flex-1">{m.description}</span>
                      {m.ntp > 0 && <span className="mono text-fg-2 shrink-0">{fmtGBP(m.ntp)}</span>}
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
        <div className="rounded-lg ring-1 ring-inset ring-ok-line overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-ok-soft ">
            <p className="text-2xs font-semibold text-ok uppercase tracking-wide flex-1">
              Schedule · {schedule.reduce((s, e) => s + e.items.length, 0)} items · {fmtGBP(schedule.reduce((s, e) => s + e.total_ntp, 0))} NTP
            </p>
            <UiButton tone="ghost" size="xs" onClick={copyFullSchedule}>
              {schedCopied ? <CheckCircle2 className="w-2.5 h-2.5" /> : <FileText className="w-2.5 h-2.5" />}
              {schedCopied ? 'Copied!' : 'Copy all'}
            </UiButton>
            <UiButton tone="quiet-danger" size="xs" onClick={clearSchedule}>
              Clear
            </UiButton>
          </div>
          {schedule.map((entry, ei) => (
            <div key={ei} className="border-t border-ok-line ">
              {schedule.length > 1 && (
                <div className="px-3 py-1 text-2xs font-medium text-fg-3 bg-surface">{entry.source}</div>
              )}
              {entry.items.map((item, ii) => (
                <div key={ii} className="flex items-center gap-2 px-3 py-1 text-2xs border-t border-ok-line first:border-t-0">
                  <span className="mono text-accent-text shrink-0">{item.cat_no}</span>
                  <span className="text-fg-3 flex-1 truncate">{item.description}</span>
                  <span className="text-fg-3 shrink-0">×{item.qty}</span>
                  <span className="mono text-fg-2 shrink-0">{fmtGBP(item.line_ntp)}</span>
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
    if (!subject.trim()) { toast('warn', 'Type a subject first — it is what the attachment search uses'); return; }
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
    if (!to.trim() || !subject.trim()) { toast('warn', 'Fill in both To and Subject before sending'); return; }
    setSending(true);
    try {
      const r = await api.outlookSendNew(to.trim(), subject.trim(), body, atts.map(a => ({ entryId: a.sourceEntryId, index: a.attachmentIndex })));
      if (r.error) { toast('err', failed('send the email', r.error)); }
      else { toast('ok', `Email sent to ${to.trim()}`); onClose(); }
    } catch (e: any) { toast('err', failed('send the email', e)); }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-modal bg-overlay flex items-end sm:items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl bg-surface rounded-2xl ring-1 ring-inset ring-line-2 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line-2">
          <PenLine className="w-4 h-4 text-fg-3 shrink-0" />
          <p className="text-base font-semibold flex-1">New Email</p>
          <UiIconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">To</label>
            <input value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com"
              className="mt-1 w-full h-8 px-3 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line" />
          </div>
          <div>
            <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject…"
              className="mt-1 w-full h-8 px-3 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line" />
          </div>
          <div>
            <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Message</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="Write your message…"
              className="mt-1 w-full px-3 py-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line resize-none" />
          </div>
          {/* Attachments */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide flex-1">Attachments from Outlook</label>
              <UiButton tone="ghost" size="xs" onClick={searchAtts} disabled={loadingSugg}>
                {loadingSugg ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                {loadingSugg ? 'Searching…' : 'Search'}
              </UiButton>
            </div>
            {atts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {atts.map((a, i) => (
                  <span key={i} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md text-2xs bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line">
                    <FileText className="w-3 h-3 shrink-0" />
                    <span className="max-w-40 truncate">{a.attachmentName}</span>
                    <button aria-label="Remove attachment" onClick={() => setAtts(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {suggestions.filter(s => !atts.some(a => a.sourceEntryId === s.sourceEntryId && a.attachmentIndex === s.attachmentIndex)).map((s, i) => (
                  <button key={i} onClick={() => setAtts(prev => [...prev, s])}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left hover:bg-subtle transition-colors ring-1 ring-inset ring-line">
                    <FileText className="w-3 h-3 text-accent-text shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium text-fg-2 truncate block">{s.attachmentName}</span>
                      <span className="text-fg-3 truncate block">{s.emailSubject}</span>
                    </span>
                    <Plus className="w-3 h-3 text-fg-3 shrink-0" />
                  </button>
                ))}
              </div>
            )}
            {searchedQ && !loadingSugg && suggestions.length === 0 && (
              <p className="text-xs text-fg-3">No matching PDFs found in Outlook for "{searchedQ}"</p>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-line-2 flex items-center gap-2">
          <button onClick={send} disabled={sending || !to.trim() || !subject.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-lg text-sm font-semibold bg-fg text-page hover:opacity-90 disabled:opacity-50 transition-colors">
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? 'Sending…' : 'Send'}
          </button>
          <UiButton tone="ghost" size="md" onClick={onClose}>Cancel</UiButton>
        </div>
      </div>
    </div>
  );
}

// ─── Who a quote should actually go to ───────────────────────────────────────
// The sender is very often NOT the recipient: half the "can you send the quote"
// mails come from a colleague forwarding a customer's request. So the panel
// offers every address that appears anywhere on the thread, each labelled with
// where it came from, and the user picks.
interface SendCandidate { name?: string; email: string; why: string; }

const NO_REPLY_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|postmaster|mailer[-_.]?daemon|notifications?)@/i;

function recipientCandidates(d: EmailDetail): SendCandidate[] {
  const out: SendCandidate[] = [];
  const seen = new Set<string>();
  const push = (email: string, name: string, why: string) => {
    const e = (email || '').trim();
    if (!e || !e.includes('@') || NO_REPLY_RE.test(e)) return;
    const key = e.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email: e, name: name || '', why });
  };

  push(d.senderEmail, d.sender, 'sent this email');
  for (const r of d.recipients || []) {
    push(r.email, r.name, r.type === 'cc' ? 'was in Cc' : 'was in To');
  }
  // Addresses written in the body — "please send it to john@customer.com" is the
  // single most common way the real recipient is named.
  const bodyAddrs = (d.body || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const a of bodyAddrs.slice(0, 30)) push(a, '', 'named in the email body');
  return out.slice(0, 20);
}

// A covering note that needs no AI call. The AI Suggest button replaces it with
// something email-specific; this is what the panel opens with.
function defaultCoverNote(d: EmailDetail, fileNames: string[]): string {
  const first = (d.sender || '').split(/[ ,]/)[0] || 'all';
  const what  = fileNames.length ? fileNames.join(', ') : 'the quotation';
  const ref   = (d.subject || '').replace(/^(RE|FW|FWD)\s*:\s*/gi, '').trim();
  return [
    `Hi ${first},`,
    ``,
    `Please find attached ${what}${ref ? ` for ${ref}` : ''}.`,
    ``,
    `Let me know if you need anything else.`,
  ].join('\n');
}

function fwdSubject(subject: string): string {
  const clean = (subject || '').replace(/^(RE|FW|FWD)\s*:\s*/gi, '').trim();
  return `FW: ${clean || 'Quotation'}`;
}

// ─── Email Detail Panel — one instance per open tab ──────────────────────────
function EmailDetailPanel({
  initialEntryId,
  emailList,
  toast,
  setAppTab,
  onMarkRead,
  onLabelChange,
  storeId,
}: {
  initialEntryId: string;
  emailList: EmailSummary[];
  toast: ToastFn;
  setAppTab: (t: string) => void;
  storeId: string;
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
  const [sendingReply, setSendingReply]             = useState(false);
  const [replySent, setReplySent]                   = useState(false);
  // Reply composer assist. The reply box itself stays exactly as the user left
  // it — everything the AI produces lands here first and only reaches the email
  // body when Insert is pressed.
  const [assistOpen, setAssistOpen]                 = useState(false);
  const [assistIdea, setAssistIdea]                 = useState('');
  const [assistOut,  setAssistOut]                  = useState('');
  const [assistBusy, setAssistBusy]                 = useState<PolishMode | null>(null);
  const [analysisLiked, setAnalysisLiked]           = useState<'up' | 'down' | null>(null);
  // Which bucket this email was filed under on the To-Do board, if any.
  const [todoBucket, setTodoBucket]                 = useState<TodoBucket | null>(null);
  const [addingTodo, setAddingTodo]                 = useState(false);
  const [lightbox, setLightbox]                     = useState<{ src: string; name: string } | null>(null);
  const [chatMessages, setChatMessages]             = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [chatInput, setChatInput]                   = useState('');
  const [chatLoading, setChatLoading]               = useState(false);
  const [activePanel, setActivePanel]               = useState<'summarize' | 'reply' | 'reply-attach' | 'pricer' | 'cbu' | 'quote' | 'history' | null>(null);
  const [attachSuggestions, setAttachSuggestions]   = useState<AttachSuggestion[]>([]);
  const [loadingSugg, setLoadingSugg]               = useState(false);
  const [selectedAtts, setSelectedAtts]             = useState<AttachSuggestion[]>([]);
  const [replyAttachText, setReplyAttachText]       = useState('');
  const [sendingWithAtts, setSendingWithAtts]       = useState(false);
  // Attach panel addressing — who the files actually go to, which is not always
  // whoever wrote in.
  const [sendTo, setSendTo]                         = useState('');
  const [sendCc, setSendCc]                         = useState('');
  const [sendSubject, setSendSubject]               = useState('');
  const [sendWhy, setSendWhy]                       = useState('');
  const [suggestingSend, setSuggestingSend]         = useState(false);
  const [roster, setRoster]                         = useState<Array<{ name: string; email: string }>>([]);
  const bodyRef    = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── EL Pricer panel height resize ────────────────────────────────────────
  const [panelHeight, setPanelHeight]     = useState(() => {
    const s = localStorage.getItem('inbox_panel_height');
    return s ? parseInt(s, 10) : 288;
  });
  const [panelMaximized, setPanelMaximized] = useState(false);
  // Reading size for the email body, remembered across emails and restarts.
  const [textZoom, setTextZoomState] = useState(() => {
    const v = parseFloat(localStorage.getItem('inbox_text_zoom') || '');
    return Number.isFinite(v) ? v : 1.15;
  });
  const setTextZoom = (z: number) => {
    const v = Math.round(Math.min(1.8, Math.max(0.8, z)) * 100) / 100;
    setTextZoomState(v);
    try { localStorage.setItem('inbox_text_zoom', String(v)); } catch { /* private mode */ }
  };
  // Signature logos and pasted pictures arrive as inline attachments and used to
  // fill the strip; they stay one click away instead.
  const [showInlineAtts, setShowInlineAtts] = useState(false);
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

  // The panel's real ceiling, and the ONLY place it is decided. The drag used to
  // clamp at a flat 800 while the element carried `maxHeight: calc(100vh-300px)`,
  // so on any window under 1100px tall the panel stopped growing while the mouse
  // kept going, and the height committed on release was not the one dragged to.
  // That is the resize that "still feels off": two limits disagreeing.
  // Tracked in state, not read straight off `window`, so the panel re-renders
  // when the window itself is resized instead of keeping a stale ceiling.
  const [viewportH, setViewportH] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const panelMaxH = useCallback(() => Math.max(160, viewportH - 300), [viewportH]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (panelResizingRef.current) {
        // The panel now opens under the toolbar with its grip on the BOTTOM edge,
        // so dragging down grows it.
        const h = Math.max(120, Math.min(panelMaxH(), panelResizeStartH.current + (e.clientY - panelResizeStartY.current)));
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
    setDraft(''); setReplyText('');
    setAssistOpen(false); setAssistIdea(''); setAssistOut(''); setAssistBusy(null);
    setReplySent(false); setAnalysisLiked(null);
    setTodoBucket(null);
    setChatMessages([]); setChatInput('');
    setActivePanel(null); setIncluded(new Set());
    setAttachSuggestions([]); setSelectedAtts([]);
    setSendTo(''); setSendCc(''); setSendSubject(''); setSendWhy(''); setReplyAttachText('');
    setLoadingDetail(true);
    bodyRef.current?.scrollTo({ top: 0 });
    try {
      const r = await api.outlookEmail(id, _storeOf[id]) as EmailDetail & { error?: string };
      if (r.error) { toast('warn', failed('open that email', r.error)); setLoadingDetail(false); return; }
      setDetail(r);
      // Nothing visual is fed to the AI unless it is ticked. Reading images is
      // what makes a summary expensive, and most emails do not need it.
      setIncluded(new Set());
      onMarkRead(id);
      onLabelChange(r.subject);
      // Pull the persisted summary (survives restart) if we don't have it in-session.
      if (!_summaryCache[id]) {
        try {
          const s = await api.outlookGetSummary(id);
          if (s.summary) { _summaryCache[id] = s.summary; capRecord(_summaryCache, MAX_SUMMARIES); setAnalysis(s.summary); }
        } catch { /* no persisted summary — fine */ }
      }
    } catch (e: any) { toast('err', failed('open that email', e)); }
    setLoadingDetail(false);
  }

  const emailIdx  = emailList.findIndex(e => e.entryId === entryId);
  const prevEmail = emailIdx > 0 ? emailList[emailIdx - 1] : null;
  const nextEmail = emailIdx < emailList.length - 1 ? emailList[emailIdx + 1] : null;

  // What actually gets fed to the AI = exactly what's ticked in the panel, which
  // starts empty. Images used to be auto-included and quietly burned tokens on
  // every summary; now reading one is always a deliberate click.
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
      capRecord(_summaryCache, MAX_SUMMARIES);
      if (r.imagesRead) toast('info', `Read ${plural(r.imagesRead, 'image')} from the email`);
    } catch (e: any) { if (!isCancel(e)) setAnalysis(`Error: ${e.message}`); }
    setAnalyzing(false);
  }

  // Write a reply from the email alone. The result goes into the assist box, NOT
  // into the reply body — nothing is ever put in the email the user didn't put
  // there or explicitly insert.
  async function draftReply(emailData: EmailDetail) {
    setDraftingReply(true);
    setReplySent(false);
    try {
      const r = await runTask('Drafting reply…', s => api.outlookDraftReply({
        subject: emailData.subject, sender: emailData.sender,
        senderEmail: emailData.senderEmail, received: emailData.received,
        body: emailData.body, analysis,
      }, s));
      if (r.error) { toast('warn', failed('draft a reply', r.error)); }
      else { setDraft(r.draft || ''); setAssistOut(r.draft || ''); }
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('draft a reply', e)); }
    setDraftingReply(false);
  }

  // Polish / shorten / formalize / rewrite. 'polish' works on the raw idea the
  // user typed; the rest chain off the last result so they can keep tightening
  // it without retyping anything.
  async function runAssist(mode: PolishMode) {
    if (assistBusy) return;
    const source = (mode === 'polish' ? assistIdea : (assistOut || assistIdea)).trim();
    if (!source) { toast('warn', 'Write your idea in the box first'); return; }
    setAssistBusy(mode);
    try {
      const r = await runTask(mode === 'polish' ? 'Polishing…' : `${mode[0].toUpperCase()}${mode.slice(1)}…`,
        s => api.outlookPolishReply({
          text: source, mode,
          subject: detail?.subject, sender: detail?.sender,
          senderEmail: detail?.senderEmail, body: detail?.body,
          analysis,
        }, s));
      if (r.error) { toast('warn', failed('polish that text', r.error)); }
      else if (r.text) { setAssistOut(r.text); setDraft(r.text); }
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('polish that text', e)); }
    setAssistBusy(null);
  }

  // The only path from the assist box into the actual email body.
  function insertAssist() {
    if (!assistOut.trim()) return;
    setReplyText(prev => prev.trim() ? `${prev.trimEnd()}\n\n${assistOut.trim()}` : assistOut.trim());
    setAssistOpen(false);
    setAssistIdea(''); setAssistOut('');
  }

  async function sendReply() {
    if (!detail || !replyText.trim()) return;
    setSendingReply(true);
    try {
      const r = await api.outlookSendReply(detail.entryId, replyText.trim());
      if (r.error) { toast('err', failed(`send the reply to ${detail.senderEmail}`, r.error)); }
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
    } catch (e: any) { toast('err', failed(`send the reply to ${detail.senderEmail}`, e)); }
    setSendingReply(false);
  }

  const sendToList = sendTo.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  // Replying keeps the thread; anything else is a new mail to someone who was
  // never in this conversation, so it goes to Outlook Drafts for a human check.
  const isThreadReply = !!detail
    && sendToList.length === 1
    && !sendCc.trim()
    && sendToList[0].toLowerCase() === (detail.senderEmail || '').toLowerCase();

  async function sendWithAtts() {
    if (!detail || !replyAttachText.trim() || sendToList.length === 0) return;
    setSendingWithAtts(true);
    const attSources = selectedAtts.map(a => ({ entryId: a.sourceEntryId, index: a.attachmentIndex }));
    try {
      if (isThreadReply) {
        const r = await api.outlookReplyWithAtts(detail.entryId, replyAttachText.trim(), attSources);
        if (r.error) { toast('err', failed('send the reply with attachments', r.error)); }
        else {
          toast('ok', `Reply sent to ${detail.senderEmail} with ${plural(selectedAtts.length, 'attachment')}`);
          setActivePanel(null); setSelectedAtts([]); setReplyAttachText('');
        }
      } else {
        if (!sendSubject.trim()) { toast('warn', 'Give the new email a subject'); setSendingWithAtts(false); return; }
        const r = await api.outlookSendNew(
          sendToList.join(';'), sendSubject.trim(), replyAttachText.trim(), attSources,
          { cc: sendCc.split(/[;,]/).map(s => s.trim()).filter(Boolean).join(';'), draft: true },
        );
        if (r.error) { toast('err', failed('build that email', r.error)); }
        else {
          toast('ok', `Draft ready in Outlook for ${sendToList.join(', ')} — press Send there`);
          setActivePanel(null); setSelectedAtts([]); setReplyAttachText('');
        }
      }
    } catch (e: any) { toast('err', failed('send that email', e)); }
    setSendingWithAtts(false);
  }

  // Ask the AI who this should go to and what the covering note says. It only
  // ever picks from the addresses already on the thread — it cannot invent one.
  async function aiSuggestSend() {
    if (!detail || suggestingSend) return;
    setSuggestingSend(true);
    try {
      const r = await runTask('Working out who to send to…', s => api.outlookSuggestSend({
        subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
        body: detail.body, analysis,
        candidates: recipientCandidates(detail),
        attachmentNames: selectedAtts.map(a => a.attachmentName),
      }, s));
      if (r.error) { toast('warn', failed('suggest a recipient', r.error)); }
      else {
        if (r.to)      setSendTo(r.to);
        if (r.cc?.length) setSendCc(r.cc.join('; '));
        if (r.subject) setSendSubject(r.subject);
        if (r.body)    setReplyAttachText(r.body);
        setSendWhy(r.why || '');
        if (!r.to) toast('warn', 'No recipient could be picked from the thread — type one yourself');
      }
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('suggest a recipient', e)); }
    setSuggestingSend(false);
  }

  // Park this email on the To-Do board under the bucket the user picked. The
  // AI summary becomes the item's context and every real attachment is carried
  // over by index, so a hand-off later can re-attach them off the original mail.
  async function addToTodo(bucket: TodoBucket) {
    if (!detail) return;
    setAddingTodo(true);
    try {
      const due = new Date();
      due.setDate(due.getDate() + (bucket === 'direct' ? 1 : 2));
      const r = await api.todoSave({
        conv: '',                       // hand-filed: never re-triaged by a scan
        entryId: detail.entryId,
        subject: detail.subject,
        sender: detail.sender,
        senderEmail: detail.senderEmail,
        received: detail.received,
        bucket,
        title: detail.subject || '(no subject)',
        summary: analysis,
        // needs_info is nearly always a question back to whoever wrote in.
        recipients: bucket === 'needs_info' && detail.senderEmail
          ? [{ name: detail.sender || detail.senderEmail, email: detail.senderEmail }]
          : [],
        attachments: detail.attachments
          .filter(a => !a.isInline)
          .map(a => ({ index: a.index, name: a.name, size: a.size })),
        due: due.toISOString().slice(0, 10),
        source: 'inbox',
      });
      if (r.item) {
        setTodoBucket(bucket);
        toast('ok', `Added to the To-Do board — due ${due.toISOString().slice(0, 10)}`);
      }
    } catch (e: any) {
      toast('err', failed('add this email to the To-Do board', e));
    } finally {
      setAddingTodo(false);
    }
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
      if (r.error) { toast('err', failed('queue the PDF attachments', r.error)); }
      else if (r.count === 0) { toast('warn', 'This email has no PDF attachments to queue'); }
      else { toast('ok', `Queued ${plural(r.count, 'PDF')} — ${r.saved.map((s: any) => s.name).join(', ')}`); }
    } catch (e: any) { toast('err', failed('queue the PDF attachments', e)); }
    setSavingPdf(false);
  }

  function togglePanel(p: typeof activePanel) {
    const next = activePanel === p ? null : p;
    setActivePanel(next);
    if (next === 'summarize' && !_summaryCache[entryId] && detail && !analyzing) {
      runSummarize(detail);
    }
    // Reply deliberately does NOT generate anything here — the box opens blank
    // and stays blank until the user asks for a draft.
    if (next === 'reply-attach' && detail) {
      if (!sendTo) setSendTo(detail.senderEmail || '');
      if (!sendSubject) setSendSubject(fwdSubject(detail.subject));
      if (!replyAttachText.trim()) {
        setReplyAttachText(replyText.trim() || defaultCoverNote(detail, selectedAtts.map(a => a.attachmentName)));
      }
      if (attachSuggestions.length === 0 && !loadingSugg) loadAttachSuggestions(detail);
      if (roster.length === 0) {
        api.todoRecipients()
          .then(r => setRoster((r.recipients || []).map(x => ({ name: x.name, email: x.email }))))
          .catch(() => {});
      }
    }
  }

  // Primary actions carry an outline; tools are quiet ghost buttons. One active
  // style for all — the old per-colour `bg-${color}-100` classes were built at
  // runtime, which Tailwind never generates, so "active" often looked like nothing.
  function ABtn({ panel, icon: Icon, label, primary, locked }: { panel: NonNullable<typeof activePanel>; icon: React.ComponentType<{className?: string}>; label: string; primary?: boolean; locked?: boolean }) {
    const active = activePanel === panel;
    const base = 'shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-sm font-medium transition-colors';
    if (locked) {
      return (
        <button aria-label="Coming soon" onClick={() => toast('info', `${label} is coming soon`)} title="Coming soon"
          className={cn(base, 'text-fg-4 hover:bg-subtle cursor-default')}>
          <Icon className="w-3.5 h-3.5 shrink-0 opacity-60" />
          {label}
          <Lock className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      );
    }
    return (
      <button onClick={() => togglePanel(panel)} aria-pressed={active}
        className={cn(
          base,
          active
            ? 'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line'
            : primary
              ? 'text-fg ring-1 ring-inset ring-line-2 hover:bg-subtle'
              : 'text-fg-2 hover:bg-subtle hover:text-fg',
        )}>
        <Icon className="w-3.5 h-3.5 shrink-0" />
        {label}
      </button>
    );
  }

  return (
    <div className="h-full min-w-0 flex flex-col min-h-0">
      {lightbox && <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />}
      {/* Drag shield — captures the mouse over the email iframe so resizing is smooth */}
      {resizeMode && <div className="fixed inset-0 z-modal" style={{ cursor: resizeMode === 'panel' ? 'row-resize' : 'ns-resize' }} />}

      {loadingDetail ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-fg-4" />
        </div>
      ) : detail ? (
        <>
          {/* ── Compact header ──────────────────────────────────────────────── */}
          <div className="shrink-0 px-6 pt-4 pb-3 border-b border-line-2 bg-surface">
            {/* Subject + quiet controls (reading size, prev/next) on one line */}
            <div className="flex items-start gap-3">
              <h2 className="flex-1 min-w-0 text-xl font-semibold text-fg leading-snug break-words">{detail.subject}</h2>
              <div className="shrink-0 flex items-center gap-0.5 text-fg-3">
                <UiIconButton icon={AArrowDown} label="Smaller text" size="sm" onClick={() => setTextZoom(textZoom - 0.1)} disabled={textZoom <= 0.8} />
                <UiButton tone="ghost" className="min-w-10" aria-label="Reset text size" onClick={() => setTextZoom(1.15)} hint="Reset text size">
                  {Math.round(textZoom * 100)}%
                </UiButton>
                <UiIconButton icon={AArrowUp} label="Larger text" size="sm" onClick={() => setTextZoom(textZoom + 0.1)} disabled={textZoom >= 1.8} />
                <span className="w-px h-4 bg-line-2 mx-1.5" />
                <UiIconButton icon={ChevronLeft} label={prevEmail?.subject} size="sm" onClick={() => prevEmail && setEntryId(prevEmail.entryId)} disabled={!prevEmail} />
                {emailIdx >= 0 && <span className="text-xs num px-0.5">{emailIdx + 1}/{emailList.length}</span>}
                <UiIconButton icon={ChevronRight} label={nextEmail?.subject} size="sm" onClick={() => nextEmail && setEntryId(nextEmail.entryId)} disabled={!nextEmail} />
              </div>
            </div>

            {/* Meta row — one line, addresses truncate instead of wrapping */}
            <div className="mt-2 flex items-center gap-2.5 min-w-0 text-sm text-fg-3">
              <span className="w-7 h-7 rounded-full flex items-center justify-center text-2xs font-semibold text-on-accent shrink-0" style={{ background: 'linear-gradient(140deg, var(--t3), var(--t4))' }}>
                {detail.sender.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <span className="font-medium text-fg shrink-0 max-w-[40%] truncate">{detail.sender}</span>
              <span className="flex-1 min-w-0 truncate"
                title={[detail.senderEmail, detail.to && `To: ${detail.to}`, detail.cc && `CC: ${detail.cc}`].filter(Boolean).join('\n')}>
                {detail.senderEmail}{detail.to ? `  →  ${detail.to}` : ''}{detail.cc ? `  ·  CC ${detail.cc}` : ''}
              </span>
              <span className="shrink-0">
                {(() => { try { return parseReceived(detail.received).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return detail.received; } })()}
              </span>
            </div>

            {/* Attachments strip */}
            {detail.attachments.length > 0 && (() => {
              const inlineCount = detail.attachments.filter(a => a.isInline).length;
              const visible = showInlineAtts ? detail.attachments : detail.attachments.filter(a => !a.isInline);
              return (
              <div className="mt-3">
                <div
                  ref={attStripRef}
                  className="flex flex-wrap gap-1.5 overflow-y-auto"
                  style={{ maxHeight: attStripHeight }}>
                  {visible.map(att => (
                    att.isPdf ? (
                      <UiButton tone="secondary" aria-label="View · Drag to EL Pricer" key={att.index} onClick={() => openAttachmentPdf(detail.entryId, att.index)} draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name })); e.dataTransfer.effectAllowed = 'copy'; }} hint="View · Drag to EL Pricer">
                        <FileText className="w-2.5 h-2.5 shrink-0" />{att.name}<span className="opacity-50 ml-0.5">{fmtSize(att.size)}</span>
                      </UiButton>
                    ) : isImageFile(att.name) ? (
                      <button aria-label="View · Drag to EL Pricer" key={att.index} onClick={() => setLightbox({ src: attViewUrl(detail.entryId, att.index), name: att.name })}
                        draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name, isImage: true })); e.dataTransfer.effectAllowed = 'copy'; }}
                        title={`View · Drag to EL Pricer · ${fmtSize(att.size)}`}
                        className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-md text-2xs font-medium ring-1 ring-inset cursor-pointer select-none bg-ok-soft text-ok ring-ok-line hover:bg-ok-soft transition-colors">
                        <AttThumb entryId={detail.entryId} index={att.index} />{att.name}<span className="opacity-50 ml-0.5">→ Pricer</span>
                      </button>
                    ) : isExcelFile(att.name) ? (
                      <UiButton tone="secondary" aria-label="Open EL Pricer · Drag to EL Pricer" key={att.index} onClick={() => setActivePanel('pricer')} draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: att.index, attName: att.name })); e.dataTransfer.effectAllowed = 'copy'; }} hint="Open EL Pricer · Drag to EL Pricer">
                        <FileSpreadsheet className="w-2.5 h-2.5 shrink-0" />{att.name}<span className="opacity-50 ml-0.5">→ Pricer</span>
                      </UiButton>
                    ) : (
                      <span key={att.index} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-medium ring-1 ring-inset bg-subtle text-fg-3 ring-line-2">
                        <Paperclip className="w-2.5 h-2.5" />{att.name}
                      </span>
                    )
                  ))}
                  {detail.hasPdf && (detail.senderEmail.toLowerCase().includes('manualnotification') || /SR00[A-Za-z0-9]+/i.test(detail.subject)) && (
                    <UiButton tone="primary" onClick={queuePdf} disabled={savingPdf}>
                      {savingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}Queue
                    </UiButton>
                  )}
                  {inlineCount > 0 && (
                    <UiButton tone="ghost" onClick={() => setShowInlineAtts(s => !s)}>
                      <ImageIcon className="w-2.5 h-2.5" />
                      {showInlineAtts ? 'Hide inline images' : `${plural(inlineCount, 'inline image')}`}
                    </UiButton>
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
                  <div className="w-6 h-0.5 rounded-full bg-subtle group-hover:bg-ai transition-colors" />
                </div>
              </div>
              );
            })()}
          </div>

          {/* ── Action toolbar — at the top, under the header ──────────────────
              It used to be a wrapped row of seven same-weight buttons jammed under
              the email. Now: three primary actions, a divider, quiet tools. It
              scrolls sideways on a narrow pane instead of wrapping into two rows. */}
          <div className="shrink-0 flex items-center gap-1 px-5 py-2 border-b border-line-2 bg-surface overflow-x-auto"
            style={{ scrollbarWidth: 'none' }}>
            <ABtn panel="summarize"    icon={Sparkles}    label="Summarize"     primary locked={STRIPPED} />
            <ABtn panel="reply"        icon={Edit3}       label="Reply"         primary locked={STRIPPED} />
            <ABtn panel="reply-attach" icon={Paperclip}   label="Attach & Send" primary locked={STRIPPED} />
            <span className="shrink-0 w-px h-5 bg-line-2 mx-1.5" />
            <ABtn panel="pricer"       icon={Zap}         label="EL Pricer"     locked={STRIPPED} />
            <ABtn panel="cbu"          icon={Battery}     label="CBU Sheet"     locked={STRIPPED} />
            <ABtn panel="quote"        icon={FileDown}    label="Quick Quote"   locked={STRIPPED} />
            {/* Reads only the already-synced CRM tables, so it stays available
                in the stripped build where the AI-backed panels do not. */}
            <ABtn panel="history"      icon={HistoryIcon} label="History" />
          </div>

            {/* Expanded panel — opens right under the toolbar, like Outlook's
                inline reply, with the email continuing below it */}
            {activePanel && (
              // Shrinkable, so on a short window the email keeps its floor
              // (min-h on the body below) instead of being squeezed to nothing.
              <div className="shrink min-h-0 flex flex-col bg-surface border-b border-line-2">
                {/* Scrollable panel content */}
                <div
                  ref={panelRef}
                  className="shrink min-h-0 overflow-y-auto"
                  // Cap to the space left below the app + inbox headers so the panel
                  // (and its follow-up input at the bottom) plus the action bar can
                  // never spill under the Windows taskbar / off-screen.
                  // One limit, shared with the drag (panelMaxH), so the handle
                  // always tracks the pointer. Maximise takes the whole ceiling
                  // rather than a flat 600 — which used to SHRINK a panel that
                  // had been dragged taller than that.
                  style={{ height: Math.min(panelMaximized ? panelMaxH() : panelHeight, panelMaxH()) }}>

                {/* ── Summarize panel — summary + inline chat + vision ── */}
                {activePanel === 'summarize' && (
                  <div className="px-5 py-3 flex flex-col gap-4">
                    <div className="-mx-5 -mt-3"><AiPanelHeader title="Vector summary"
                      sub={analyzing ? `Reading email${effectiveInclude(detail).length ? ' + images' : ''}…` : 'Reads the text only unless you tick a file'} /></div>

                    {/* Vision controls — tick an image/PDF to feed it to the AI
                        (summary AND follow-up chat). Nothing is ticked by default:
                        reading images costs real tokens. Tiny inline logos
                        (< 12 KB) are hidden entirely. */}
                    {(() => {
                      const visual = detail.attachments.filter(a =>
                        (a.isPdf || a.isImage || isImageFile(a.name)) && !(a.isInline && a.size < 12_000));
                      if (visual.length === 0) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 text-2xs text-fg-3" title="Text only unless you tick something here — images cost tokens">
                            <Eye className="w-3 h-3" />Let Vector read:
                          </span>
                          {visual.map(a => (
                            <AiFileChip key={a.index} name={a.name} on={included.has(a.index)}
                              kind={a.isImage || isImageFile(a.name) ? 'image' : 'file'}
                              onToggle={() => setIncluded(prev => { const n = new Set(prev); n.has(a.index) ? n.delete(a.index) : n.add(a.index); return n; })} />
                          ))}
                          {analysis && !analyzing && (
                            <UiButton tone="primary" size="xs" aria-label="Re-summarize with the current image selection" onClick={() => runSummarize(detail, true)} hint="Re-summarize with the current image selection">
                              Apply
                            </UiButton>
                          )}
                        </div>
                      );
                    })()}

                    {/* Summary body */}
                    {analyzing && !analysis
                      ? <AiThinking label={`Reading email${effectiveInclude(detail).length ? ' + images' : ''}…`} />
                      : analysis
                        ? (
                          <AiMessage badge={analyzing ? <Loader2 className="w-3 h-3 animate-spin text-fg-3" /> : undefined}
                            actions={analyzing ? undefined : <>
                              <CopyAction text={analysis} />
                              <UiIconButton size="xs" icon={ThumbsUp} label="Mark this summary helpful" onClick={() => submitAnalysisFeedback('up')} disabled={!!analysisLiked} />
                              <UiIconButton size="xs" icon={ThumbsDown} label="Mark this summary unhelpful" onClick={() => submitAnalysisFeedback('down')} disabled={!!analysisLiked} />
                              <UiIconButton size="xs" icon={RefreshCw} label="Summarize again" onClick={() => runSummarize(detail, true)} />
                            </>}>
                            <Md text={analysis} />
                          </AiMessage>
                        )
                        : (
                          <div className="flex flex-col items-start gap-2">
                            <p className="text-sm text-fg-3">No summary yet — Vector reads the email text. Tick a file above if it needs to see it.</p>
                            <UiButton tone="primary" onClick={() => runSummarize(detail)}>
                              <Sparkles className="w-3 h-3" /> Summarize
                            </UiButton>
                          </div>
                        )
                    }

                    {/* ── Park it on the To-Do board ──
                        One click files the summary, the attachments and (for a
                        blocked item) the sender as the person to chase. Nothing
                        is emailed here — the hand-off is written and sent from
                        the To-Do tab. */}
                    {analysis && !analyzing && (
                      <div className="pt-3 border-t border-line">
                        {todoBucket ? (
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-ok shrink-0" />
                            <p className="text-xs text-fg-2 flex-1">
                              On your To-Do list as{' '}
                              <span className="font-semibold">
                                {todoBucket === 'direct' ? 'yours to finish'
                                  : todoBucket === 'needs_info' ? 'waiting on info'
                                  : 'one for the team'}
                              </span>.
                            </p>
                            <UiButton tone="ghost" size="xs" onClick={() => setAppTab('Todo')}>Open To-Do</UiButton>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-2xs text-fg-3 mr-0.5">Add to To-Do:</span>
                            {([
                              ['direct',     'I can do this'],
                              ['needs_info', 'Needs more info'],
                              ['needs_team', 'Needs the team'],
                            ] as Array<[TodoBucket, string]>).map(([b, label]) => (
                              <UiButton tone="secondary" size="xs" key={b} onClick={() => addToTodo(b)} disabled={addingTodo}>
                                {addingTodo ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Plus className="w-2.5 h-2.5" />}
                                {label}
                              </UiButton>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Inline follow-up chat (only once there is a summary) */}
                    {analysis && (
                      <div className="pt-3 border-t border-line flex flex-col gap-4">
                        {(chatMessages.length > 0 || chatLoading) && (
                          <div className="flex flex-col gap-5">
                            {chatMessages.map((m, i) => m.role === 'user'
                              ? <UserMessage key={i} text={m.text} />
                              : <AiMessage key={i} actions={<CopyAction text={m.text} />}><Md text={m.text} /></AiMessage>)}
                            {chatLoading && <AiThinking />}
                            <div ref={chatEndRef} />
                          </div>
                        )}
                        <div className="sticky bottom-0 -mx-5 px-5 py-2 bg-surface border-t border-line">
                          <AiComposer size="sm" value={chatInput} onChange={setChatInput} onSubmit={() => sendChatMessage()}
                            loading={chatLoading} placeholder="Ask Vector about this email or its images…" maxRows={5} />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Reply panel ── */}
                {activePanel === 'reply' && (
                  <div className="px-5 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-fg-3 flex-1">Reply to {detail.senderEmail}</p>
                      {draftingReply && <Loader2 className="w-3 h-3 animate-spin text-fg-3" />}
                      {replySent && <span className="text-xs text-ok flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Sent</span>}
                    </div>
                    {!replySent && (
                      <>
                        {/* The reply body. Blank on open, and nothing writes into
                            it except the user and the Insert button below. */}
                        <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={9}
                          placeholder="Write your reply…"
                          style={{ fontSize: 14 * Math.min(textZoom, 1.3) }}
                          className="w-full min-h-40 text-fg bg-surface rounded-lg px-3.5 py-3 ring-1 ring-inset ring-line-2 resize-y focus:outline-none focus:ring-ai-line leading-relaxed font-sans placeholder:text-fg-3" />
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={sendReply} disabled={sendingReply || !replyText.trim()}
                            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-semibold bg-fg text-page hover:opacity-90 disabled:opacity-50 transition-colors">
                            {sendingReply ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}Send
                          </button>
                          <button onClick={() => setAssistOpen(o => !o)}
                            className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium ring-1 ring-inset transition-colors',
                              assistOpen
                                ? 'bg-ai-soft text-ai ring-ai-line '
                                : 'text-fg-3 ring-line-2 hover:bg-subtle')}>
                            <Sparkles className="w-3 h-3" />AI Draft
                          </button>
                          <SnippetPicker toast={toast}
                            onInsert={body => setReplyText(prev =>
                              prev.trim() ? `${prev.trimEnd()}\n\n${body}` : body)} />
                          {replyText && (
                            <UiButton tone="quiet-danger" onClick={() => setReplyText('')}>
                              <Trash2 className="w-3 h-3" />Clear
                            </UiButton>
                          )}
                        </div>

                        {/* ── AI Draft box ──
                            Write the idea in your own words, the AI turns it into
                            an email, and it only reaches the reply above when you
                            press Insert. */}
                        {assistOpen && (
                          <div className="mt-1 rounded-lg ring-1 ring-inset ring-ai-line bg-ai-soft p-2.5 space-y-2">
                            <div className="flex items-center gap-2">
                              <Sparkles className="w-3 h-3 text-ai shrink-0" />
                              <p className="text-2xs font-semibold text-fg-2 uppercase tracking-wide flex-1">Your idea → polished email</p>
                              <UiIconButton icon={X} label="Close the AI draft box" size="xs" onClick={() => setAssistOpen(false)} />
                            </div>

                            <textarea value={assistIdea} onChange={e => setAssistIdea(e.target.value)} rows={3}
                              placeholder="Rough notes are fine — e.g. 'tell him the 8kVA is 12 weeks lead time, quote follows tomorrow'"
                              className="w-full text-sm text-fg bg-surface rounded-lg px-2.5 py-2 ring-1 ring-inset ring-line-2 resize-none focus:outline-none focus:ring-ai-line leading-relaxed font-sans placeholder:text-fg-3" />

                            <div className="flex items-center gap-1.5 flex-wrap">
                              <UiButton tone="primary" onClick={() => runAssist('polish')} disabled={!!assistBusy || !assistIdea.trim()}>
                                {assistBusy === 'polish' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                                Polish
                              </UiButton>
                              {(['shorten', 'formalize', 'rewrite'] as PolishMode[]).map(m => (
                                <UiButton tone="secondary" key={m} onClick={() => runAssist(m)} disabled={!!assistBusy || !(assistOut || assistIdea).trim()} hint={m === 'shorten' ? 'Cut it down, keep every fact'
                                    : m === 'formalize' ? 'More formal register for an external customer'
                                    : 'Same meaning, fresh wording'}>
                                  {assistBusy === m ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                  {m === 'shorten' ? 'Shorten' : m === 'formalize' ? 'Formalize' : 'Rewrite'}
                                </UiButton>
                              ))}
                              <span className="flex-1" />
                              <UiButton tone="secondary" onClick={() => draftReply(detail)} disabled={draftingReply || !!assistBusy} hint="Ignore the box and write a reply straight from the email">
                                {draftingReply ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />}
                                From email
                              </UiButton>
                            </div>

                            {(assistOut || assistBusy || draftingReply) && (
                              <div className="space-y-1.5">
                                <p className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Result — edit here, then insert</p>
                                <textarea value={assistOut} onChange={e => setAssistOut(e.target.value)} rows={6}
                                  placeholder={assistBusy || draftingReply ? 'Writing…' : ''}
                                  className="w-full text-sm text-fg bg-surface rounded-lg px-2.5 py-2 ring-1 ring-inset ring-line-2 resize-none focus:outline-none focus:ring-ai-line leading-relaxed font-sans placeholder:text-fg-3" />
                                <div className="flex items-center gap-1.5">
                                  <UiButton tone="ghost" onClick={insertAssist} disabled={!assistOut.trim()}>
                                    <Check className="w-3 h-3" />Insert
                                  </UiButton>
                                  <UiButton tone="secondary" onClick={() => setAssistOut('')} disabled={!assistOut.trim()}>
                                    <RotateCcw className="w-3 h-3" />Discard
                                  </UiButton>
                                  <span className="text-2xs text-fg-3">
                                    {replyText.trim() ? 'Appends to what you have written' : 'Goes into the reply above'}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* ── Attach & send panel ──
                    Suggests the quote, WHO it should go to (rarely just the
                    sender) and a short covering note. */}
                {activePanel === 'reply-attach' && (
                  <div className="px-5 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Paperclip className="w-3.5 h-3.5 text-accent-text shrink-0" />
                      <p className="text-xs font-semibold text-fg flex-1">Send a quote</p>
                      <UiButton tone="primary" size="xs" onClick={aiSuggestSend} disabled={suggestingSend} hint="Work out who this should go to and write the covering note">
                        {suggestingSend ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Sparkles className="w-2.5 h-2.5" />}
                        AI suggest
                      </UiButton>
                    </div>

                    {/* Addressing */}
                    <div className="grid grid-cols-[var(--sp-10)_1fr] items-center gap-x-2 gap-y-1.5">
                      <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">To</label>
                      <input value={sendTo} onChange={e => setSendTo(e.target.value)} list="vector-send-roster"
                        placeholder="who actually needs the quote…"
                        className="h-7 px-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line" />
                      <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Cc</label>
                      <input value={sendCc} onChange={e => setSendCc(e.target.value)} list="vector-send-roster"
                        placeholder="optional — e.g. keep the sender in the loop"
                        className="h-7 px-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line" />
                      {!isThreadReply && (
                        <>
                          <label className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Subj</label>
                          <input value={sendSubject} onChange={e => setSendSubject(e.target.value)}
                            placeholder="Subject…"
                            className="h-7 px-2.5 rounded-lg text-sm bg-subtle ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line" />
                        </>
                      )}
                    </div>
                    {/* Autocomplete over everyone you have corresponded with */}
                    <datalist id="vector-send-roster">
                      {roster.slice(0, 300).map((c, i) => <option key={i} value={c.email}>{c.name}</option>)}
                    </datalist>

                    {/* One click per address that appears anywhere on the thread */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-2xs text-fg-3">On this thread:</span>
                      {recipientCandidates(detail).map((c, i) => {
                        const on = sendToList.some(t => t.toLowerCase() === c.email.toLowerCase());
                        return (
                          <button key={i} onClick={() => setSendTo(c.email)} title={`${c.email} — ${c.why}`}
                            className={cn('inline-flex items-center gap-1 h-6 px-2 rounded-md text-2xs font-medium ring-1 ring-inset transition-colors max-w-48',
                              on ? 'bg-ai-soft text-ai ring-ai-line '
                                 : 'bg-subtle text-fg-3 ring-line-2 hover:text-fg')}>
                            {on && <Check className="w-2.5 h-2.5 shrink-0" />}
                            <span className="truncate">{c.name || c.email}</span>
                          </button>
                        );
                      })}
                    </div>
                    {sendWhy && (
                      <p className="text-2xs text-fg-3 italic flex items-start gap-1">
                        <Sparkles className="w-2.5 h-2.5 mt-0.5 shrink-0 text-ai" />{sendWhy}
                      </p>
                    )}

                    <textarea value={replyAttachText} onChange={e => setReplyAttachText(e.target.value)} rows={7}
                      placeholder="Covering note…"
                      style={{ fontSize: 14 * Math.min(textZoom, 1.3) }}
                      className="w-full min-h-36 text-fg bg-surface rounded-lg px-3.5 py-3 ring-1 ring-inset ring-line-2 resize-y focus:outline-none focus:ring-ai-line leading-relaxed font-sans placeholder:text-fg-3" />
                    {/* Suggested attachments */}
                    <div>
                      <p className="text-2xs font-semibold text-fg-3 uppercase tracking-wide mb-1.5 flex items-center gap-2">
                        Suggested attachments from Outlook
                        {loadingSugg && <Loader2 className="w-3 h-3 animate-spin text-ai" />}
                      </p>
                      {selectedAtts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {selectedAtts.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md text-2xs bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line">
                              <FileText className="w-3 h-3 shrink-0" />
                              <span className="max-w-36 truncate">{a.attachmentName}</span>
                              <button aria-label="Remove attachment" onClick={() => setSelectedAtts(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
                            </span>
                          ))}
                        </div>
                      )}
                      {!loadingSugg && attachSuggestions.length === 0 && (
                        <p className="text-xs text-fg-3">No matching PDFs found in Outlook</p>
                      )}
                      {attachSuggestions.filter(s => !selectedAtts.some(a => a.sourceEntryId === s.sourceEntryId && a.attachmentIndex === s.attachmentIndex)).map((s, i) => (
                        <button key={i} onClick={() => setSelectedAtts(prev => [...prev, s])}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 mb-1 rounded-lg text-xs text-left hover:bg-subtle transition-colors ring-1 ring-inset ring-line">
                          <FileText className="w-3 h-3 text-accent-text shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="font-medium text-fg-2 truncate block">{s.attachmentName}</span>
                            <span className="text-fg-3 truncate block text-2xs">{s.emailSubject} · {s.sender}</span>
                          </span>
                          <Plus className="w-3 h-3 text-fg-3 shrink-0" />
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={sendWithAtts} disabled={sendingWithAtts || !replyAttachText.trim() || sendToList.length === 0}
                        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-semibold bg-fg text-page hover:opacity-90 disabled:opacity-50 transition-colors">
                        {sendingWithAtts ? <Loader2 className="w-3 h-3 animate-spin" />
                          : isThreadReply ? <Send className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                        {isThreadReply ? 'Send reply' : 'Draft in Outlook'}
                        {selectedAtts.length > 0 ? ` (${plural(selectedAtts.length, 'file')})` : ''}
                      </button>
                      <span className="text-2xs text-fg-3">
                        {isThreadReply
                          ? `Replies in the thread to ${detail.senderEmail}`
                          : `New email — lands in Outlook Drafts so you press Send there`}
                      </span>
                    </div>
                  </div>
                )}

                {/* ── EL Pricer panel ── */}
                {activePanel === 'pricer' && (
                  <div className="px-5 py-3">
                    <InlineELPricer emailBody={detail.body || ''} entryId={detail.entryId} attachments={detail.attachments}
                      toast={toast} setAppTab={setAppTab} subject={detail.subject} emailList={emailList}
                      storeId={storeId} />
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

                {/* ── Customer history panel ── */}
                {activePanel === 'history' && (
                  <div className="px-5 py-3">
                    <CustomerHistoryPanel senderEmail={detail.senderEmail} senderName={detail.sender} toast={toast} />
                  </div>
                )}
                </div>

                {/* ── Resize grip — bottom edge, OUTSIDE the scroll container so drag works ── */}
                <div
                  className="group flex items-center h-6 border-t border-line select-none hover:bg-subtle transition-colors"
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
                    <div className="w-10 h-1 rounded-full bg-line-3 group-hover:bg-fg-4 transition-colors" />
                  </div>
                  <div className="flex items-center gap-0.5 pr-2">
                    <UiButton tone="ghost" size="xs" aria-label={panelMaximized ? 'Restore' : 'Maximise'} onClick={() => setPanelMaximized(p => !p)} hint={panelMaximized ? 'Restore' : 'Maximise'}>
                      {panelMaximized
                        ? <ChevronLeft className="w-3.5 h-3.5 rotate-90" />
                        : <ChevronRight className="w-3.5 h-3.5 rotate-90" />}
                    </UiButton>
                    <UiIconButton icon={X} label="Close" size="xs" onClick={() => setActivePanel(null)} />
                  </div>
                </div>
              </div>
            )}

          {/* ── Email body — main scrollable area ───────────────────────────── */}
          <div ref={bodyRef} className={cn('flex-1 overflow-y-auto bg-surface', activePanel ? 'min-h-44' : 'min-h-0')}>
            {detail.htmlBody
              ? <EmailBodyFrame key={detail.entryId} html={detail.htmlBody} entryId={detail.entryId}
                  attachments={detail.attachments} onImageOpen={setLightbox} zoom={textZoom} />
              : <PlainBody text={detail.body} zoom={textZoom} />
            }
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
      <div className="w-14 h-14 flex items-center justify-center text-ai">
        <Mail className="w-6 h-6 text-ai" />
      </div>

      <div>
        <p className="text-lg font-semibold text-fg">Connect your Eaton inbox</p>
        <p className="text-sm text-fg-3 mt-1 max-w-xs leading-relaxed">
          Eaton blocks standard login for apps. You need a one-time <strong>App Password</strong> from Microsoft — it takes about 60 seconds.
        </p>
      </div>

      {step === 'intro' && (
        <div className="w-full max-w-sm space-y-3">
          {/* Step 1 */}
          <div className="rounded-xl bg-surface ring-1 ring-inset ring-line-2 px-4 py-3 text-left space-y-2">
            <p className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Step 1 — Open Microsoft Security</p>
            <p className="text-xs text-fg-2 leading-relaxed">
              Click the button below. Sign in with your Eaton account if asked.
            </p>
            <a
              href="https://mysignins.microsoft.com/security-info"
              target="_blank"
              rel="noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent transition-colors">
              <ExternalLink className="w-3.5 h-3.5" /> Open mysignins.microsoft.com
            </a>
          </div>

          {/* Step 2 */}
          <div className="rounded-xl bg-surface ring-1 ring-inset ring-line-2 px-4 py-3 text-left space-y-1.5">
            <p className="text-2xs font-semibold text-fg-3 uppercase tracking-wide">Step 2 — Create an App Password</p>
            <ol className="text-xs text-fg-2 leading-relaxed list-decimal list-inside space-y-0.5">
              <li>Click <strong>+ Add sign-in method</strong></li>
              <li>Choose <strong>App password</strong> from the dropdown</li>
              <li>Name it anything (e.g. <em>Vector</em>)</li>
              <li>Copy the generated password — shown <strong>once only</strong></li>
            </ol>
            <p className="text-2xs text-warn mt-1">
              If "App password" is not in the list, Eaton IT has disabled it — contact IT support.
            </p>
          </div>

          <UiButton tone="primary" size="lg" className="w-full" onClick={() => setStep('paste')}>
            I have my app password →
          </UiButton>

          <div className="flex justify-end">
            <UiButton tone="ghost" onClick={onRetry}>
              <RefreshCw className="w-3 h-3" /> Retry connection
            </UiButton>
          </div>
        </div>
      )}

      {step === 'paste' && (
        <div className="w-full max-w-sm space-y-3">
          <div>
            <label className="block text-2xs font-semibold text-fg-3 uppercase tracking-wide mb-1 text-left">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full h-9 px-3 rounded-lg text-sm bg-surface ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 focus:outline-none focus:ring-ai-line"
            />
          </div>
          <div>
            <label className="block text-2xs font-semibold text-fg-3 uppercase tracking-wide mb-1 text-left">App Password</label>
            <input
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') connect(); }}
              placeholder="Paste app password here"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="w-full h-9 px-3 rounded-lg text-sm mono bg-surface ring-1 ring-inset ring-line-2 text-fg placeholder:text-fg-3 placeholder:font-sans focus:outline-none focus:ring-ai-line"
            />
          </div>

          <UiButton tone="primary" size="lg" className="w-full" onClick={connect} disabled={connecting || !email.trim() || !password.trim()}>
            {connecting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting…</>
              : <><Mail className="w-3.5 h-3.5" /> Connect</>}
          </UiButton>

          {error && (
            <div className="rounded-lg bg-err-soft ring-1 ring-inset ring-err-line px-3 py-2.5 text-left">
              <p className="text-xs text-err leading-relaxed">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => { setStep('intro'); setError(''); }}
              className="text-xs text-fg-3 hover:text-ai transition-colors">
              ← Back to instructions
            </button>
            <div className="flex-1" />
            <UiButton tone="ghost" onClick={onRetry}>
              <RefreshCw className="w-3 h-3" /> Retry
            </UiButton>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── List-row avatar helpers (mockup 3-pane look) ────────────────────────────
const AVATAR_COLORS = ['var(--cat-1)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-10)', 'var(--cat-12)', 'var(--cat-8)', 'var(--cat-7)', 'var(--cat-3)'];
function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarInitials(name: string) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Folder rail definitions — client-side filters over the loaded mailbox.
type InboxFolder = 'inbox' | 'flagged' | 'attachments' | 'processed' | 'archive';

// ─── Main component ──────────────────────────────────────────────────────────
export function InboxPage({
  toast,
  setTab,
  onUnreadCount,
  onSwitchLayout,
}: {
  toast: ToastFn;
  setTab: (t: string) => void;
  onUnreadCount?: (n: number) => void;
  onSwitchLayout?: () => void;
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
  const [folder, setFolder]             = useState<InboxFolder>(() => (localStorage.getItem('inbox_folder') as InboxFolder) || 'inbox');
  const [railDragOver, setRailDragOver] = useState<InboxFolder | null>(null);
  const selectFolder = (f: InboxFolder) => { setFolder(f); localStorage.setItem('inbox_folder', f); };
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
    return saved ? parseInt(saved, 10) : 344;
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
  // Two layers: typing filters the emails already loaded (instant), Enter runs a
  // real search across the quote folders — UKQuoteFactoryEL's Inbox and
  // "Completed by Laith" — through a local SQLite mirror of those messages.
  // Classic Outlook's own search box leans on a Windows index that misses mail
  // here, and reading messages back through COM costs ~64 ms each, so the mirror
  // is what makes this both correct and instant.
  const [emailSearch, setEmailSearch] = useState('');
  // How strict a term has to be. Persisted: it is a working preference, not a
  // per-query one, and silently resetting it makes the same search change answer.
  const [matchMode,   setMatchMode]   = useState<MatchMode>(
    () => (MATCH_MODE_OPTIONS.some(o => o.id === localStorage.getItem('inboxMatchMode'))
      ? localStorage.getItem('inboxMatchMode') as MatchMode : 'part'));
  const [deepResults, setDeepResults] = useState<EmailSummary[] | null>(null);
  const [deepQuery,   setDeepQuery]   = useState('');
  // The mode the showing results were fetched with — the marks have to follow
  // what the server matched, not what the picker was moved to afterwards.
  const [deepMode,    setDeepMode]    = useState<MatchMode>('part');
  const [deepScope,   setDeepScope]   = useState<SearchScope>('all');
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepMeta,    setDeepMeta]    = useState<{ total: number; truncated: boolean; source?: string } | null>(null);
  const [indexInfo,   setIndexInfo]   = useState<{ built: boolean; total: number; lastSync?: string | null; syncing?: boolean } | null>(null);
  const [indexBusy,   setIndexBusy]   = useState(false);
  // ── Filters ───────────────────────────────────────────────────────────────
  // The panel is collapsed by default — the box alone answers most questions,
  // and a search pane that opens with eight rows of controls is the crowding
  // this replaced. Whether it is open persists; what is set in it does not.
  const [showFilters, setShowFilters] = useState(() => localStorage.getItem('inboxShowFilters') === '1');
  const [filters,     setFiltersRaw]  = useState<FilterState>(EMPTY_FILTERS);
  const [facets,      setFacets]      = useState<SearchFacets | null>(null);
  const setFilters = useCallback((patch: Partial<FilterState>) => setFiltersRaw(f => ({ ...f, ...patch })), []);
  const pills      = activeFilterPills(filters);
  const anyFilter  = pills.length > 0;
  const deepAbort  = useRef<AbortController | null>(null);

  const loadIndexStatus = useCallback(async () => {
    try { setIndexInfo(await api.outlookIndexStatus()); } catch { /* status is cosmetic */ }
  }, []);

  async function reindex() {
    setIndexBusy(true);
    try {
      const r = await api.outlookIndexSync(true);
      if (r.error) toast('err', failed('rebuild the search index', r.error));
      else toast('ok', `Search index rebuilt — ${plural(r.total ?? 0, 'email')} in ${r.seconds ?? '?'}s`);
      await loadIndexStatus();
      void loadFacets();
      if (deepActiveRef.current) await runDeepSearch(deepQuery);
    } catch (e: any) { toast('err', failed('rebuild the search index', e)); }
    setIndexBusy(false);
  }

  function clearDeepSearch() {
    deepAbort.current?.abort();
    deepAbort.current = null;
    setDeepResults(null);
    setDeepQuery('');
    setDeepMeta(null);
    setDeepLoading(false);
  }

  const runDeepSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    const f = filtersRef.current;
    const active = activeFilterPills(f).length > 0;
    // A filter is a question on its own — "everything from Fenton with a PDF
    // this month" needs no term — so the box only has to carry the search when
    // nothing else does.
    if (q.length < 2 && !active) {
      toast('warn', 'Type at least 2 characters, or set a filter, before searching');
      return;
    }
    deepAbort.current?.abort();
    const ctl = new AbortController();
    deepAbort.current = ctl;
    setDeepLoading(true);
    setDeepQuery(q);
    setDeepResults(null);
    setDeepMeta(null);
    const mode  = modeRef.current;
    const scope = f.scope;
    try {
      const r = await api.outlookSearch(q, { mode, scope, filters: toApiFilters(f) }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.error) toast('warn', failed(q ? `search for "${q}"` : 'filter the quote folders', r.error));
      const list: EmailSummary[] = r.emails || [];
      rememberStores(list);
      setDeepResults(list);
      setDeepMode(r.mode || mode);
      setDeepScope(r.scope || scope);
      setDeepMeta({ total: r.total ?? list.length, truncated: !!r.truncated, source: r.source });
      if (r.truncated) toast('warn', `Search hit its time limit — showing the first ${plural(list.length, 'match', 'matches')}`);
      // A live answer means the index was cold; the server starts building it,
      // so refresh the badge shortly.
      if (r.source !== 'index') setTimeout(() => { void loadIndexStatus(); }, 3_000);
    } catch (e: any) {
      if (ctl.signal.aborted || isCancel(e)) return;
      toast('err', failed(q ? `search for "${q}"` : 'filter the quote folders', e));
      setDeepQuery('');
    } finally {
      if (deepAbort.current === ctl) setDeepLoading(false);
    }
  }, [toast, loadIndexStatus]);

  // runDeepSearch reads the mode and the filters through refs so its identity
  // stays stable — every re-run would otherwise restart the in-flight request.
  const modeRef = useRef<MatchMode>(matchMode);
  useEffect(() => { modeRef.current = matchMode; }, [matchMode]);
  const filtersRef = useRef<FilterState>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  // Whether results are on screen, for the effects that must not start a search
  // of their own when there are none.
  const deepActiveRef = useRef(false);

  // The sender list the From filter offers. Cheap (one GROUP BY over the index)
  // and only fetched once the pane is up.
  const loadFacets = useCallback(async () => {
    try { setFacets(await api.outlookSearchFacets()); } catch { /* the filter still takes free text */ }
  }, []);

  // Changing the rule re-asks the server: 'word' can only be enforced there, and
  // leaving the old hit list up under a stricter rule would show non-matches.
  // The same goes for every filter — the hits on screen were fetched under the
  // old ones. Debounced, because "From" is typed a letter at a time.
  useEffect(() => { localStorage.setItem('inboxMatchMode', matchMode); }, [matchMode]);
  const firstFilterRender = useRef(true);
  useEffect(() => {
    if (firstFilterRender.current) { firstFilterRender.current = false; return; }
    if (!deepActiveRef.current) return;
    const t = setTimeout(() => { void runDeepSearch(emailSearch); }, 350);
    return () => clearTimeout(t);
  }, [matchMode, filters]);

  useEffect(() => { localStorage.setItem('inboxShowFilters', showFilters ? '1' : '0'); }, [showFilters]);

  // Index badge + filter values: load once when the pane comes up.
  useEffect(() => {
    if (!available) return;
    void loadIndexStatus();
    void loadFacets();
  }, [available, loadIndexStatus, loadFacets]);

  // Emptying the box drops back to the plain (loaded-emails) view — unless a
  // filter is still doing the asking, in which case the hits are still an answer.
  useEffect(() => {
    if (!emailSearch.trim() && !activeFilterPills(filtersRef.current).length) clearDeepSearch();
  }, [emailSearch]);

  // Abort an in-flight search when the pane goes away.
  useEffect(() => () => deepAbort.current?.abort(), []);

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
    if (pdfEmails.length === 0) { toast('warn', 'None of the emails in this list carry a PDF'); return; }
    pdfEmails.forEach(e => openEmail(e.entryId));
    toast('ok', `Opened ${plural(pdfEmails.length, 'email')} with a PDF`);
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
      rememberStores(cached.emails, sid);
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
      if (r.error && !silent) toast('warn', failed('load the email list', r.error));
      const list = r.emails || [];
      emailCache.set(key, { emails: list, ts: Date.now() });
      capMap(emailCache, MAX_EMAIL_CACHE);
      rememberStores(list, sid);
      setEmails(list);
      // Fewer returned than asked → no more to fetch
      setHasMoreEmails(list.length >= limit);
      if (!silent) setCacheAge('just now');
    } catch (e: any) {
      if (!silent && !isCancel(e)) toast('err', failed('load the email list', e));
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
    const meta   = emails.find(e => e.entryId === entryId)
                || deepResults?.find(e => e.entryId === entryId);
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
    try { await api.outlookFlag(entryId, !isStarred); }
    catch (e: any) { toast('err', failed(isStarred ? 'remove the flag in Outlook' : 'flag the email in Outlook', e)); }
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
    try { await api.outlookMarkUnread(entryId); } catch (e: any) { toast('err', failed('mark the email unread', e)); }
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
      toast('ok', 'Email moved to Deleted Items in Outlook');
    } catch (e: any) { toast('err', failed('delete the email', e)); }
  }

  async function handleForward(entryId: string) {
    setEmailMenu(null);
    const to = window.prompt('Forward to (email address):');
    if (!to?.trim()) return;
    try {
      const r = await api.outlookForward(entryId, to.trim());
      if (r.error) toast('err', failed(`forward the email to ${to.trim()}`, r.error));
      else toast('ok', `Email forwarded to ${to.trim()}`);
    } catch (e: any) { toast('err', failed(`forward the email to ${to.trim()}`, e)); }
  }

  async function handleOpenInOutlook(entryId: string) {
    setEmailMenu(null);
    try { await api.outlookOpenInOutlook(entryId); } catch (e: any) { toast('err', failed('open the email in Outlook', e)); }
  }

  async function handleCategorize(entryId: string, category: string) {
    setEmailMenu(null);
    setCategoryMenuId(null);
    setEmailCategories(prev => ({ ...prev, [entryId]: category }));
    try {
      const r = await api.outlookCategorize(entryId, category);
      if (r.error) toast('err', failed(`categorise the email as ${category}`, r.error));
      else toast('ok', `Email categorised as ${category}`);
    } catch (e: any) { toast('err', failed(`categorise the email as ${category}`, e)); }
  }

  // ── Move an email to a rail folder (drag-drop or context menu) ─────────────
  // These folders are views over real Outlook state, so "moving" applies the
  // matching backed action: Flagged→flag, Processed→mark read, Archive→category
  // "Archived", Inbox→clear the Archived category.
  async function moveToFolder(entryId: string, target: InboxFolder) {
    setEmailMenu(null);
    setCategoryMenuId(null);
    if (target === 'attachments') return;   // derived — not a move target
    try {
      switch (target) {
        case 'flagged':
          if (!starredEmails.has(entryId)) {
            const next = new Set(starredEmails); next.add(entryId); setStarredEmails(next);
            await api.outlookFlag(entryId, true);
          }
          toast('ok', 'Email flagged — it now shows under Flagged'); break;
        case 'processed':
          handleMarkRead(entryId);
          toast('ok', 'Email marked read — it now shows under Processed'); break;
        case 'archive':
          setEmailCategories(prev => ({ ...prev, [entryId]: 'Archived' }));
          await api.outlookCategorize(entryId, 'Archived');
          toast('ok', 'Email categorised Archived'); break;
        case 'inbox':
          setEmailCategories(prev => { const n = { ...prev }; delete n[entryId]; return n; });
          await api.outlookCategorize(entryId, '');
          toast('ok', 'Archived category cleared — email is back in Inbox'); break;
      }
    } catch (e: any) { toast('err', failed(`move the email to ${target}`, e)); }
  }

  // ─── Unavailable state ─────────────────────────────────────────────────────
  if (available === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-fg-3" />
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
        <div className="w-14 h-14 flex items-center justify-center text-warn">
          <Mail className="w-6 h-6 text-warn" />
        </div>
        <div>
          <p className="text-lg font-semibold text-fg">Outlook not available</p>
          <p className="text-sm text-fg-3 mt-1 max-w-sm leading-relaxed">
            Make sure Classic Outlook is open and <code className="text-xs bg-subtle px-1 rounded">pywin32</code> is installed.
          </p>
        </div>
        <div className="mt-1 px-4 py-3 rounded-xl bg-surface ring-1 ring-inset ring-line-2 text-left max-w-sm w-full">
          <p className="text-xs font-semibold text-fg-3 uppercase tracking-wide mb-2">Setup</p>
          <p className="text-sm text-fg-2 mono bg-subtle rounded px-2 py-1.5">pip install pywin32</p>
          {availError && <p className="text-xs text-err mt-2">{availError}</p>}
        </div>
        <button onClick={retryStatus}
          className="inline-flex items-center gap-2 h-8 px-4 rounded-lg text-sm font-medium bg-fg text-page hover:opacity-90 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      </div>
    );
  }

  // Filtered email list (search)
  // Folder rail predicate (client-side view over the loaded mailbox).
  // Plain function — NOT a hook — so it stays clear of the early returns above.
  const isArchived = (id: string) => emailCategories[id] === 'Archived';
  const inFolder = (e: typeof emails[number]) => {
    // Archived mail only surfaces under Archive, never the other views.
    if (folder !== 'archive' && isArchived(e.entryId)) return false;
    switch (folder) {
      case 'flagged':     return starredEmails.has(e.entryId);
      case 'attachments': return e.attachments.length > 0;
      case 'processed':   return !e.unread;
      case 'archive':     return isArchived(e.entryId);
      default:            return true;   // inbox
    }
  };

  const folderCounts = {
    inbox:       emails.filter(e => !isArchived(e.entryId)).length,
    flagged:     emails.filter(e => starredEmails.has(e.entryId) && !isArchived(e.entryId)).length,
    attachments: emails.filter(e => e.attachments.length > 0 && !isArchived(e.entryId)).length,
    processed:   emails.filter(e => !e.unread && !isArchived(e.entryId)).length,
    archive:     emails.filter(e => isArchived(e.entryId)).length,
  };
  const FOLDERS: { id: InboxFolder; label: string; Icon: any; count: number }[] = [
    { id: 'inbox',       label: 'Inbox',            Icon: InboxIcon,  count: folderCounts.inbox },
    { id: 'flagged',     label: 'Flagged',          Icon: Flag,       count: folderCounts.flagged },
    { id: 'attachments', label: 'With attachments', Icon: Paperclip,  count: folderCounts.attachments },
    { id: 'processed',   label: 'Processed',        Icon: Check,      count: folderCounts.processed },
    { id: 'archive',     label: 'Archive',          Icon: Archive,    count: folderCounts.archive },
  ];

  const sq = emailSearch.trim().toLowerCase();
  // The typed-filter path gets the same rules as the server search — match mode
  // AND scope — so switching to "Whole word" or "Subject only" narrows the
  // loaded list too instead of only the deep hits.
  const sqTerms = highlightTerms(emailSearch, 1);
  const sqRegexes = sqTerms.map(t => new RegExp(termPattern(t, matchMode), 'i'));
  // A full-mailbox search replaces the list outright: its hits come from folders
  // and mailboxes the rail knows nothing about, so the rail/archive filters
  // would only hide them.
  const deepActive    = deepLoading || deepResults !== null;
  deepActiveRef.current = deepActive;
  const textMatch = (e: EmailSummary, scope: SearchScope) =>
    sqRegexes.every(r => r.test(scopeHaystack(e, scope)));
  const localFiltered = emails
    .filter(e => (!sq || textMatch(e, filters.scope)) && passesFilters(e, filters))
    .filter(inFolder);
  // Editing the box after a search narrows the hits already on screen; Enter
  // runs the new text against Outlook again.
  const deepFiltered = (deepResults || []).filter(
    e => !sq || sq === deepQuery.toLowerCase() || textMatch(e, deepScope));
  const displayEmails = deepActive ? deepFiltered : localFiltered;
  // What to mark up in the rows: the terms the server matched on while search
  // results are showing, otherwise whatever is being typed.
  const hlTerms = highlightTerms(deepActive ? deepQuery : emailSearch);
  const hlMode  = deepActive ? deepMode : matchMode;

  return (
    <div className="flex flex-col h-full">

      {/* ── Compose modal ───────────────────────────────────────────────────── */}
      {composeOpen && <ComposeModal onClose={() => setComposeOpen(false)} toast={toast} />}

      {/* ── Full-screen email popout (double-click) ─────────────────────────── */}
      {popoutId && (
        <div className="fixed inset-0 z-overlay bg-overlay flex items-center justify-center p-3"
          onClick={e => { if (e.target === e.currentTarget) setPopoutId(null); }}>
          <div className="bg-surface rounded-2xl ring-1 ring-inset ring-line-2 flex flex-col overflow-hidden"
            style={{ width: 'min(96vw, var(--modal-2xl))', height: 'min(95vh, var(--modal-h))' }}>
            {/* Popout header */}
            <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-surface">
              <Mail className="w-4 h-4 text-fg-3 shrink-0" />
              <p className="flex-1 text-sm font-semibold text-fg-2 truncate">
                {emails.find(e => e.entryId === popoutId)?.subject || '…'}
              </p>
              <UiIconButton icon={X} label="Close" size="sm" onClick={() => setPopoutId(null)} />
            </div>
            {/* Popout body */}
            <div className="flex-1 min-h-0">
              <EmailDetailPanel
                initialEntryId={popoutId}
                emailList={displayEmails}
                toast={toast}
                setAppTab={setTab}
                onMarkRead={handleMarkRead}
                onLabelChange={() => {}}
                storeId={storeId}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Email row context menu ──────────────────────────────────────────── */}
      {emailMenu && (
        <>
          <div className="fixed inset-0 z-modal" onClick={() => { setEmailMenu(null); setCategoryMenuId(null); }} />
          <div
            className="fixed z-modal bg-surface rounded-xl shadow-float ring-1 ring-inset ring-line-2 py-1 min-w-44 text-sm"
            style={{ top: emailMenu.y, left: emailMenu.x }}>
            <UiButton tone="ghost" className="w-full" onClick={() => handleFlag(emailMenu.id)}>
              <Star className={cn('w-3.5 h-3.5', starredEmails.has(emailMenu.id) ? 'text-warn fill-warn' : 'text-fg-3')} />
              {starredEmails.has(emailMenu.id) ? 'Unflag' : 'Flag'}
            </UiButton>
            <UiButton tone="ghost" className="w-full" onClick={() => handleMarkUnread(emailMenu.id)}>
              <Mail className="w-3.5 h-3.5 text-fg-3" />
              Mark as Unread
            </UiButton>
            {/* Move to folder */}
            <div className="px-3 pt-1.5 pb-1">
              <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-4 mb-1">Move to</p>
              <div className="flex flex-wrap gap-1">
                {([
                  { id: 'inbox' as InboxFolder,    label: 'Inbox',     Icon: InboxIcon },
                  { id: 'flagged' as InboxFolder,  label: 'Flagged',   Icon: Flag },
                  { id: 'processed' as InboxFolder,label: 'Processed', Icon: Check },
                  { id: 'archive' as InboxFolder,  label: 'Archive',   Icon: Archive },
                ]).map(m => (
                  <UiButton tone="ghost" key={m.id} onClick={() => moveToFolder(emailMenu.id, m.id)}>
                    <m.Icon className="w-3 h-3" />{m.label}
                  </UiButton>
                ))}
              </div>
            </div>
            <hr className="my-1 border-line" />
            <UiButton tone="ghost" className="w-full" onClick={() => handleForward(emailMenu.id)}>
              <Forward className="w-3.5 h-3.5 text-fg-3" />
              Forward
            </UiButton>
            <UiButton tone="ghost" className="w-full" onClick={() => handleOpenInOutlook(emailMenu.id)}>
              <ExternalLink className="w-3.5 h-3.5 text-fg-3" />
              Open in Outlook
            </UiButton>
            <UiButton tone="ghost" className="w-full" onClick={() => setCategoryMenuId(categoryMenuId === emailMenu.id ? null : emailMenu.id)}>
              <FolderOpen className="w-3.5 h-3.5 text-fg-3" />
              <span className="flex-1">Categorize</span>
              <ChevronRight className="w-3 h-3 text-fg-3" />
            </UiButton>
            {categoryMenuId === emailMenu.id && (
              <div className="px-3 pb-2 flex flex-wrap gap-1.5">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => handleCategorize(emailMenu.id, cat)}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-2xs font-medium ring-1 ring-inset transition-colors',
                      emailCategories[emailMenu.id] === cat
                        ? 'bg-ai-soft text-ai ring-ai-line '
                        : 'bg-subtle text-fg-2 ring-line-2 hover:bg-subtle',
                    )}>
                    {cat}
                  </button>
                ))}
              </div>
            )}
            <hr className="my-1 border-line" />
            <UiButton tone="quiet-danger" className="w-full" onClick={() => handleDelete(emailMenu.id)}>
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </UiButton>
          </div>
        </>
      )}

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-surface border-b border-line-2">

        {/* Mailbox tabs */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {/* Default personal inbox */}
          <button
            onClick={() => { setStoreId('default'); localStorage.setItem('inbox_storeId', 'default'); }}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
              storeId === 'default'
                ? 'bg-fg text-page'
                : 'text-fg-3 hover:bg-subtle',
            )}>
            <InboxIcon className="w-3 h-3 shrink-0" />
            Personal
          </button>
          {mailboxes.filter(m => m.type === 'shared').map(m => (
            <button
              key={m.storeId}
              onClick={() => { setStoreId(m.storeId); localStorage.setItem('inbox_storeId', m.storeId); }}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
                storeId === m.storeId
                  ? 'bg-fg text-page'
                  : 'text-fg-3 hover:bg-subtle',
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
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium ring-1 ring-inset transition-colors',
            unreadOnly
              ? 'bg-ai-soft text-ai ring-ai-line '
              : 'text-fg-3 ring-line-2 hover:bg-subtle',
          )}>
          <Filter className="w-3 h-3" />
          Unread
        </button>

        {/* Open every PDF in the list as a tab. It acts on the list, not on the
            search, which is why it sits with the mailbox actions rather than
            beside the search box it used to crowd. */}
        <UiButton tone="secondary" aria-label="Open all emails with PDFs as tabs" onClick={openAllPdf} hint="Open all emails with PDFs as tabs">
          <FolderOpen className="w-3 h-3" />
          PDFs
        </UiButton>

        {/* Compose */}
        <UiButton tone="secondary" onClick={() => setComposeOpen(true)}>
          <PenLine className="w-3 h-3" />
          Compose
        </UiButton>

        {onSwitchLayout && (
          <UiButton tone="secondary" onClick={onSwitchLayout} hint="Switch to the Outlook-style layout">
            <Sparkles className="w-3 h-3" />
            New layout
          </UiButton>
        )}

        {/* Refresh */}
        <UiIconButton icon={RefreshCw} label="Refresh emails" size="sm" onClick={() => loadEmails(storeId, unreadOnly, true)} disabled={loadingEmails} />
      </div>

      {/* ── Content: folder rail + email list + detail split pane ── */}
      <div className="flex-1 flex min-h-0">

        {/* ── Folder rail (far left) ───────────────────────────────────────── */}
        <div className="shrink-0 w-48 flex flex-col gap-0.5 border-r border-line bg-surface p-3 overflow-y-auto vec-scroll">
          {FOLDERS.map(f => {
            const active = folder === f.id;
            const dropTarget = f.id !== 'attachments';   // 'attachments' is a derived view, not movable-to
            const over = railDragOver === f.id;
            return (
              <button aria-label={dropTarget ? `Drag an email here to move it to ${f.label}` : undefined} key={f.id} onClick={() => selectFolder(f.id)}
                onDragOver={dropTarget ? (e => { if (e.dataTransfer.types.includes('vector/email-row')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRailDragOver(f.id); } }) : undefined}
                onDragLeave={dropTarget ? (() => setRailDragOver(cur => cur === f.id ? null : cur)) : undefined}
                onDrop={dropTarget ? (e => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('vector/email-row');
                  setRailDragOver(null);
                  if (id) moveToFolder(id, f.id);
                }) : undefined}
                title={dropTarget ? `Drag an email here to move it to ${f.label}` : undefined}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-panel text-sm transition-colors',
                  over ? 'bg-accent-soft text-accent-text font-semibold ring-1 ring-inset ring-accent-line'
                    : active ? 'bg-subtle text-fg font-semibold'
                    : 'text-fg-2 font-medium hover:bg-subtle hover:text-fg',
                )}>
                <f.Icon className="w-4 h-4 shrink-0 opacity-85" />
                <span className="flex-1 text-left">{f.label}</span>
                {f.count > 0 && (
                  <span className="text-2xs tabular-nums" style={{ color: active ? 'var(--t2)' : 'var(--t4)' }}>{f.count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Email list (left) ────────────────────────────────────────────── */}
        <div ref={listPaneRef} className="shrink-0 flex flex-col border-r border-line-2 bg-surface" style={{ width: listWidth }}>

          {/* ── Search bar ────────────────────────────────────────────────
              One row: the box, the filter toggle, and the button that goes to
              the quote folders. Everything else that used to sit here (the
              match-mode picker, "open every PDF") moved into the filter panel
              and the header — at 344 px, four controls beside the box left the
              box itself too narrow to read a query back in. */}
          <div className="shrink-0 px-2 py-1.5 border-b border-line flex items-center gap-1.5">
            <div className="flex-1 flex items-center gap-1.5 h-7 px-2 rounded-md bg-subtle ring-1 ring-inset ring-line focus-within:ring-ai-line">
              <Search className="w-3 h-3 text-fg-3 shrink-0" />
              <input
                type="text"
                value={emailSearch}
                onChange={e => setEmailSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); runDeepSearch(emailSearch); }
                  if (e.key === 'Escape' && deepActive) { e.preventDefault(); clearDeepSearch(); }
                }}
                placeholder="Search… (Enter = quote folders)"
                title="Type to filter the loaded list — press Enter to search the quote folders (Inbox + Completed by Laith)"
                className="flex-1 bg-transparent text-xs text-fg-2 placeholder:text-fg-3 outline-none min-w-0"
              />
              {emailSearch && (
                <button aria-label="Clear search" onClick={() => setEmailSearch('')} className="text-fg-3 hover:text-fg">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {/* Filters. The count is the badge: a narrowed search must never
                look like a plain one. */}
            <button aria-label={showFilters ? 'Hide the search filters' : 'Show the search filters'}
              onClick={() => setShowFilters(v => !v)}
              title={anyFilter ? `Filters — ${pills.map(p => p.label).join(', ')}` : 'Filter by sender, date, folder, attachments or read state'}
              className={cn(
                'shrink-0 h-7 pl-1.5 pr-2 rounded-md flex items-center gap-1 text-2xs font-medium transition-colors',
                anyFilter
                  ? 'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line'
                  : showFilters ? 'bg-subtle text-fg' : 'text-fg-3 hover:bg-subtle hover:text-fg',
              )}>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {anyFilter ? pills.length : ''}
              <ChevronDown className={cn('w-3 h-3 transition-transform', showFilters && 'rotate-180')} />
            </button>
            <button aria-label={deepLoading ? 'Stop the search' : 'Search UKQuoteFactoryEL — Inbox + Completed by Laith (subject, sender, body, attachment names)'}
              onClick={() => (deepLoading ? clearDeepSearch() : runDeepSearch(emailSearch))}
              disabled={!deepLoading && emailSearch.trim().length < 2 && !anyFilter}
              title={deepLoading ? 'Stop the search' : 'Search UKQuoteFactoryEL — Inbox + Completed by Laith (subject, sender, body, attachment names)'}
              className={cn(
                'shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-colors',
                deepLoading ? 'text-warn hover:bg-warn-soft '
                  : 'text-accent-text hover:bg-accent-soft disabled:opacity-35 disabled:hover:bg-transparent',
              )}>
              {deepLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* ── Filter panel ──────────────────────────────────────────────── */}
          {showFilters && (
            <SearchFilterPanel
              filters={filters}
              setFilters={setFilters}
              matchMode={matchMode}
              setMatchMode={setMatchMode}
              facets={facets}
              onReset={() => setFiltersRaw(EMPTY_FILTERS)}
              pillCount={pills.length}
            />
          )}

          {/* What is narrowing the list, when the panel that says so is shut.
              Each pill drops its own filter. */}
          {!showFilters && anyFilter && (
            <div className="shrink-0 px-2 py-1.5 border-b border-line flex flex-wrap items-center gap-1">
              {pills.map(p => (
                <UiButton tone="secondary" size="xs" key={p.key} onClick={() => setFilters(p.patch)} hint={`Remove this filter`}>
                  <span className="truncate max-w-32">{p.label}</span>
                  <X className="w-2.5 h-2.5 shrink-0" />
                </UiButton>
              ))}
              <button onClick={() => setFiltersRaw(EMPTY_FILTERS)}
                className="text-2xs font-medium text-fg-3 hover:text-fg px-1">Clear all</button>
            </div>
          )}

          {/* ── Search status bar ─────────────────────────────────────────
              The scope of a search is fixed (SEARCH_SCOPE in outlook_reader.py),
              so it is stated, not chosen. */}
          {(deepActive || (!!sq && !deepLoading)) && (
            <div className="shrink-0 px-2.5 py-1.5 border-b border-line bg-raised flex items-center gap-2 text-2xs">
              {deepActive ? (
                <>
                  <Globe className="w-3 h-3 shrink-0 text-accent-text" />
                  <span className="flex-1 min-w-0 truncate text-fg-3"
                    title={[
                      `Searched ${SEARCH_SCOPE_LABEL}`,
                      `Rule: ${MATCH_MODE_OPTIONS.find(o => o.id === deepMode)?.label}`,
                      `In: ${SCOPE_OPTIONS.find(o => o.id === deepScope)?.label}`,
                      deepMeta?.source === 'index' ? 'Answered from the local index' : 'Read live from Outlook',
                      deepMeta?.truncated ? 'Partial — the search hit its time limit' : '',
                    ].filter(Boolean).join('\n')}>
                    {deepLoading
                      ? <>Searching {SEARCH_SCOPE_LABEL}{deepQuery ? <> for “{deepQuery}”</> : ' '}…</>
                      : <>
                          <span className="font-semibold text-fg-2">{deepMeta?.total ?? displayEmails.length}</span>
                          {' '}hit{(deepMeta?.total ?? 0) === 1 ? '' : 's'}{deepQuery ? <> for “{deepQuery}”</> : ''}
                          {deepScope !== 'all' ? ` · in ${SCOPE_OPTIONS.find(o => o.id === deepScope)?.label}` : ''}
                          {deepMode !== 'part' ? ` · ${MATCH_MODE_OPTIONS.find(o => o.id === deepMode)?.label}` : ''}
                          {deepMeta?.source === 'index' ? '' : ' · live Outlook'}
                          {deepMeta?.truncated ? ' · partial' : ''}
                          {deepMeta && deepMeta.total > displayEmails.length ? ` · showing ${displayEmails.length}` : ''}
                        </>}
                  </span>
                  <button onClick={clearDeepSearch} className="shrink-0 text-fg-3 hover:text-fg font-medium">
                    {deepLoading ? 'Stop' : 'Back to list'}
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 truncate text-fg-3">
                    {localFiltered.length} of {emails.length} loaded emails
                  </span>
                  <button onClick={() => runDeepSearch(emailSearch)}
                    className="shrink-0 font-medium text-accent-text hover:underline">
                    Search quote folders ↵
                  </button>
                </>
              )}
              <span
                title={`Search covers ${SEARCH_SCOPE_LABEL} — subject, sender, recipients, body and attachment names.`
                     + (indexInfo?.lastSync ? `\nIndex last synced ${indexInfo.lastSync}` : '')}
                className="shrink-0 text-fg-4 tabular-nums">
                {indexInfo?.built ? `${indexInfo.total.toLocaleString()} indexed` : 'index cold'}
              </span>
              <button aria-label="Re-read the quote folders from Outlook and rebuild the local index" onClick={reindex} disabled={indexBusy}
                title="Re-read the quote folders from Outlook and rebuild the local index"
                className="shrink-0 text-fg-3 hover:text-fg disabled:opacity-40">
                {indexBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </button>
            </div>
          )}

          {(deepLoading || (loadingEmails && !deepActive)) ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Loader2 className="w-5 h-5 animate-spin text-fg-4" />
              {deepLoading && (
                <p className="text-xs text-fg-3 leading-relaxed">
                  Searching {SEARCH_SCOPE_LABEL} — subject, sender, body and attachment names.
                  Instant off the local index; the first run reads the folders from Outlook and takes a couple of minutes.
                </p>
              )}
            </div>
          ) : displayEmails.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
              <Mail className="w-8 h-8 text-fg-4" />
              <p className="text-sm text-fg-3">
                {deepActive
                  ? (deepQuery
                      ? `Nothing in the quote folders matches “${deepQuery}”`
                      : 'Nothing in the quote folders matches these filters')
                  : emailSearch ? 'No emails match your search'
                  : anyFilter  ? 'No loaded emails match these filters'
                  : unreadOnly ? 'No unread emails' : 'No emails found'}
              </p>
              {/* An empty result under filters is usually the filters, not the
                  mailbox — say which ones are doing it, and offer the way out. */}
              {anyFilter && (
                <p className="text-2xs text-fg-4 max-w-60 leading-relaxed">
                  Filtered by {pills.map(p => p.label).join(', ')}.{' '}
                  <button onClick={() => setFiltersRaw(EMPTY_FILTERS)}
                    className="font-medium text-accent-text hover:underline">Clear the filters</button>
                </p>
              )}
              {!deepActive && (emailSearch.trim().length >= 2 || anyFilter) && (
                <button onClick={() => runDeepSearch(emailSearch)}
                  className="text-xs font-medium text-accent-text hover:underline">
                  Search the quote folders instead
                </button>
              )}
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
                    'w-full flex gap-2.5 items-start px-3 py-2.5 text-left border-b border-line transition-colors cursor-pointer select-none relative group',
                    email.entryId === selectedId
                      ? 'bg-subtle border-l-2 border-l-ai-line pl-2.5'
                      : 'hover:bg-subtle',
                  )}>
                  {/* Three-dot menu */}
                  <UiIconButton icon={MoreHorizontal} label="Email actions" size="xs" className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 z-10" onClick={e => { e.stopPropagation(); setEmailMenu({ id: email.entryId, x: e.clientX, y: e.clientY }); }} />
                  {/* Round avatar */}
                  <span className="w-7 h-7 mt-0.5 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold text-on-accent select-none"
                    style={{ background: avatarColor(email.senderEmail || email.sender) }}>
                    {avatarInitials(email.sender)}
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 min-w-0 pr-5">
                      {email.unread && (
                        <span className="w-1.5 h-1.5 rounded-full bg-ai shrink-0" />
                      )}
                      {starredEmails.has(email.entryId) && (
                        <Star className="w-3 h-3 text-warn fill-warn shrink-0" />
                      )}
                      <p className={cn(
                        'text-sm truncate flex-1',
                        email.unread ? 'font-semibold text-fg' : 'font-medium text-fg-2',
                      )}>
                        <Highlight text={email.sender} terms={hlTerms} mode={hlMode} />
                      </p>
                      <span className="text-2xs text-fg-3 shrink-0 tabular-nums">{fmtDate(email.received)}</span>
                    </div>
                    <p className={cn('text-xs truncate', email.unread ? 'font-medium text-fg-2' : 'text-fg-3')}>
                      <Highlight text={email.subject} terms={hlTerms} mode={hlMode} />
                    </p>
                    {/* Search hits can come from anywhere — say where. */}
                    {email.folder && (
                      <span className="inline-flex items-center gap-1 text-2xs text-fg-4 truncate" title={email.folder}>
                        <FolderOpen className="w-2.5 h-2.5 shrink-0" />
                        <span className="truncate">{email.folder}</span>
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-2xs text-fg-3 truncate flex-1"><Highlight text={email.bodyPreview || ' '} terms={hlTerms} mode={hlMode} /></span>
                      {emailCategories[email.entryId] && (
                        <span className="shrink-0 text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-ai-soft text-ai truncate max-w-16">
                          {emailCategories[email.entryId]}
                        </span>
                      )}
                      {email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-2xs text-accent-text font-medium shrink-0">
                          <FileText className="w-2.5 h-2.5" /> PDF
                        </span>
                      )}
                      {email.attachments.length > 0 && !email.hasPdf && (
                        <span className="inline-flex items-center gap-0.5 text-2xs text-fg-3 shrink-0">
                          <Paperclip className="w-2.5 h-2.5" /> {email.attachments.length}
                        </span>
                      )}
                    </div>
                    {/* Proof of the hit: sender/subject/preview cover a fraction of
                        what search reads, so anything matched elsewhere is quoted here. */}
                    <MatchTrail matches={email.matches} terms={hlTerms} mode={hlMode} />
                  </div>
                </div>
              ))}
              {!sq && hasMoreEmails && (
                <UiButton tone="ghost" className="w-full" onClick={loadMoreEmails} disabled={loadingMore}>
                  {loadingMore
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</>
                    : <><ChevronDown className="w-3.5 h-3.5" /> Load more</>}
                </UiButton>
              )}
            </div>
          )}
          {emails.length > 0 && (
            <div className="shrink-0 px-3 py-2 border-t border-line flex items-center justify-between">
              <p className="text-2xs text-fg-3">
                {sq ? `${displayEmails.length} of ${emails.length}` : (
                  emails.filter(e => e.unread).length > 0
                    ? `${emails.filter(e => e.unread).length} unread · ${emails.length}`
                    : `${emails.length} emails`
                )}
              </p>
              {cacheAge && (
                <p className="text-2xs text-fg-4">Updated {cacheAge}</p>
              )}
            </div>
          )}
        </div>

        {/* ── Resize handle — wide hit area, visible grip on hover ── */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          className="group relative w-2 shrink-0 cursor-col-resize flex items-center justify-center bg-subtle hover:bg-ai-soft transition-colors"
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
          <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-subtle group-hover:bg-ai " />
          <span className="relative flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="w-0.5 h-0.5 rounded-full bg-ai" />
            <span className="w-0.5 h-0.5 rounded-full bg-ai" />
            <span className="w-0.5 h-0.5 rounded-full bg-ai" />
          </span>
        </div>

        {/* ── Detail pane (right) — browser-style tabs ────────────────────── */}
        {/* min-w-0 matters as much as min-h-0 and was missing: a flex item will
            not shrink below its content, so a wide child — the attachment strip,
            a long subject, the pricer's chip row — pushed this whole column past
            the window edge (measured at 1604px inside a 1440px viewport) and
            everything on the right was quietly clipped, buttons included. That
            is why the pane felt crowded only sometimes: only wide emails did it. */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">

          {/* Tab bar */}
          {openTabs.length > 0 && (
            <div className="shrink-0 flex items-center border-b border-line-2 bg-surface">
              {/* Scroll-left arrow */}
              <button aria-label="Scroll tabs left"
                onClick={() => scrollTabBar('left')}
                className="shrink-0 w-6 h-full flex items-center justify-center text-fg-3 hover:text-fg hover:bg-subtle transition-colors border-r border-line">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Scrollable tab strip */}
              <div
                ref={tabBarRef}
                className={cn(
                  'flex-1 flex items-center overflow-x-auto scrollbar-none transition-colors',
                  tabBarDragOver && 'bg-ai-soft ',
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
                      'group relative flex items-center gap-1.5 px-3 py-2 border-r border-line shrink-0 cursor-grab active:cursor-grabbing min-w-20 max-w-48 transition-colors select-none',
                      t.id === activeTabId
                        ? 'bg-surface text-fg after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-ai'
                        : 'text-fg-3 hover:bg-surface ',
                      dragOverIdx === tabIdx && dragTabIdx !== null && dragTabIdx !== tabIdx
                        ? 'ring-1 ring-inset ring-ai-line bg-ai-soft '
                        : '',
                    )}>
                    {/* Pin indicator */}
                    {t.pinned
                      ? <Pin className="w-2.5 h-2.5 shrink-0 text-ai" />
                      : <Mail className="w-3 h-3 shrink-0 opacity-40" />}
                    {/* Unread dot */}
                    {t.unread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    <span className="text-xs font-medium truncate flex-1">{t.label}</span>
                    {/* Close button — hidden for pinned tabs */}
                    {!t.pinned && (
                      <button aria-label="Close tab"
                        onClick={e => { e.stopPropagation(); closeTab(t.id); }}
                        title="Close tab"
                        className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-hover transition-all shrink-0 ml-0.5">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Scroll-right arrow */}
              <button aria-label="Scroll tabs right"
                onClick={() => scrollTabBar('right')}
                className="shrink-0 w-6 h-full flex items-center justify-center text-fg-3 hover:text-fg hover:bg-subtle transition-colors border-l border-line">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Tab right-click context menu */}
          {tabCtxMenu && (
            <>
              <div className="fixed inset-0 z-modal" onClick={() => setTabCtxMenu(null)} />
              <div
                className="fixed z-modal bg-surface rounded-lg shadow-float ring-1 ring-inset ring-line py-1 min-w-36 text-sm"
                style={{ top: tabCtxMenu.y, left: tabCtxMenu.x }}>
                <UiButton tone="ghost" className="w-full" onClick={() => togglePinTab(tabCtxMenu.id)}>
                  {openTabs.find(t => t.id === tabCtxMenu.id)?.pinned
                    ? <><PinOff className="w-3.5 h-3.5 text-fg-3" /> Unpin tab</>
                    : <><Pin className="w-3.5 h-3.5 text-ai" /> Pin tab</>}
                </UiButton>
                {!openTabs.find(t => t.id === tabCtxMenu.id)?.pinned && (
                  <UiButton tone="quiet-danger" className="w-full" onClick={() => { closeTab(tabCtxMenu.id); setTabCtxMenu(null); }}>
                    <X className="w-3.5 h-3.5" /> Close tab
                  </UiButton>
                )}
              </div>
            </>
          )}

          {/* Empty state */}
          {openTabs.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="w-12 h-12 flex items-center justify-center">
                <Mail className="w-5 h-5 text-fg-3" />
              </div>
              <p className="text-base text-fg-3">Select an email to read and analyse</p>
            </div>
          )}

          {/* One EmailDetailPanel per tab — inactive tabs hidden via display:none */}
          {openTabs.map(t => (
            <div key={t.id}
              className="flex-1 min-w-0 min-h-0"
              style={t.id !== activeTabId ? { display: 'none' } : undefined}>
              <EmailDetailPanel
                initialEntryId={t.id}
                emailList={displayEmails}
                toast={toast}
                setAppTab={setTab}
                onMarkRead={handleMarkRead}
                onLabelChange={label => updateTabLabel(t.id, label)}
                storeId={storeId}
              />
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}

// ─── Shared with the Outlook layout (InboxOutlook.tsx) ───────────────────────
// The Outlook-style page reuses these rather than keeping a second copy of the
// email frame, the tool panels, search and the session caches.
export {
  STRIPPED, CACHE_TTL, emailCache, capMap, capRecord, MAX_EMAIL_CACHE, MAX_SUMMARIES,
  _summaryCache, _storeOf, rememberStores, CATEGORIES,
  Md, fmtDate, parseReceived, fmtSize, openAttachmentPdf, isImageFile, isExcelFile, attViewUrl,
  CustomerHistoryPanel, ImageLightbox, PlainBody, EmailBodyFrame,
  MATCH_MODE_OPTIONS, EMPTY_FILTERS, SCOPE_OPTIONS, activeFilterPills, toApiFilters, passesFilters,
  scopeHaystack, termPattern, highlightTerms, Highlight, SearchFilterPanel,
  InlineCBUGenerator, InlineELPricer, ComposeModal, EmailDetailPanel, avatarColor, avatarInitials,
};
export type { Mailbox, AttachmentInfo, EmailSummary, EmailDetail, FilterState, PolishMode };
