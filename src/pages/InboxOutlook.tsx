// ─── Inbox — Outlook layout ───────────────────────────────────────────────────
// The Inbox rebuilt on Outlook's own structure (2026-09-15, Laith: "an enhanced
// version of Outlook — many things but still solid and easily findable"):
//
//   ribbon tabs + search ─ Home │ Vector AI │ Tools │ View ──────── [search]
//   simplified ribbon    ─ one row of icon+label commands, grouped
//   folder pane │ date-grouped message list │ reading pane │ Vector task pane
//   status bar
//
// Built BESIDE the classic page (Inbox.tsx) so the daily tool keeps working —
// View → Classic layout switches back. The parts that already worked (email
// frame, EL Pricer, CBU, Quick Quote, history, search) are imported from
// Inbox.tsx, not copied.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Mail, Inbox as InboxIcon, Users, RefreshCw, Search, X, SlidersHorizontal, Loader2, ChevronDown, ChevronRight,
  PanelLeft, SquarePen, Trash2, Reply, Forward, Flag, Tag, ExternalLink, Sparkles, Zap, Battery, FileDown,
  History as HistoryIcon, ListTodo, Wrench, FileText, Paperclip, Image as ImageIcon, FileSpreadsheet, Download,
  LayoutPanelLeft, Rows3, PanelRight, PanelBottom, EyeOff, AArrowDown, AArrowUp, Maximize2, Minimize2, Send,
  Undo2, Check, CheckCircle2, Plus, ThumbsUp, ThumbsDown, AlignJustify, List as ListIcon, Lock, MoreHorizontal,
  WandSparkles, Database,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import type { MatchMode, SearchScope, SearchFacets } from '../lib/api';
import { failed, plural } from '../lib/errors';
import { runTask, isCancel } from '../lib/tasks';
import type { ToastFn } from '../App';
import type { TodoBucket } from '../types';
import { QuickQuotePanel } from './QuickQuote';
import {
  InboxPage, STRIPPED, CACHE_TTL, emailCache, capMap, capRecord, MAX_EMAIL_CACHE, MAX_SUMMARIES,
  _summaryCache, _storeOf, rememberStores, CATEGORIES,
  Md, parseReceived, fmtSize, openAttachmentPdf, isImageFile, isExcelFile, attViewUrl,
  CustomerHistoryPanel, ImageLightbox, PlainBody, EmailBodyFrame,
  MATCH_MODE_OPTIONS, EMPTY_FILTERS, activeFilterPills, toApiFilters, passesFilters,
  scopeHaystack, termPattern, highlightTerms, Highlight, SearchFilterPanel,
  InlineCBUGenerator, InlineELPricer, ComposeModal, EmailDetailPanel, avatarColor, avatarInitials,
} from './Inbox';
import type { Mailbox, AttachmentInfo, EmailSummary, EmailDetail, FilterState } from './Inbox';

type InboxProps = { toast: ToastFn; setTab: (t: string) => void; onUnreadCount?: (n: number) => void };

// ─── Layout switch ────────────────────────────────────────────────────────────
export function InboxRoot(props: InboxProps) {
  const [layout, setLayout] = useState<'outlook' | 'classic'>(() => {
    try { return localStorage.getItem('inbox_layout') === 'classic' ? 'classic' : 'outlook'; } catch { return 'outlook'; }
  });
  const switchTo = (l: 'outlook' | 'classic') => {
    setLayout(l);
    try { localStorage.setItem('inbox_layout', l); } catch { /* private mode */ }
  };
  return layout === 'classic'
    ? <InboxPage {...props} onSwitchLayout={() => switchTo('outlook')} />
    : <InboxOutlookPage {...props} onSwitchLayout={() => switchTo('classic')} />;
}

// ─── Types, prefs, helpers ────────────────────────────────────────────────────
type ReadingPos = 'right' | 'bottom' | 'off';
type Density    = 'comfortable' | 'compact';
type View       = 'inbox' | 'unread' | 'flagged' | 'attachments';
type TaskTab    = 'summary' | 'pricer' | 'cbu' | 'quote' | 'history';
type RibbonTab  = 'home' | 'ai' | 'tools' | 'view';
type ComposeMode = 'reply' | 'forward';

const VIEW_LABEL: Record<View, string> = { inbox: 'Inbox', unread: 'Unread', flagged: 'Flagged', attachments: 'With attachments' };
const TASK_TABS: { id: TaskTab; label: string; Icon: React.ComponentType<{ className?: string }>; ai: boolean }[] = [
  { id: 'summary', label: 'Summary', Icon: Sparkles,    ai: true },
  { id: 'pricer',  label: 'Pricer',  Icon: Zap,         ai: true },
  { id: 'cbu',     label: 'CBU',     Icon: Battery,     ai: true },
  { id: 'quote',   label: 'Quote',   Icon: FileDown,    ai: true },
  { id: 'history', label: 'History', Icon: HistoryIcon, ai: false },
];

// One localStorage-backed preference. Every layout choice here is a working
// habit, so it should survive a restart without a settings screen.
function usePref<T extends string | number | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      if (typeof initial === 'number')  { const n = parseFloat(raw); return (Number.isFinite(n) ? n : initial) as T; }
      if (typeof initial === 'boolean') return (raw === 'true') as T;
      return raw as T;
    } catch { return initial; }
  });
  const set = useCallback((next: T) => {
    setV(next);
    try { localStorage.setItem(key, String(next)); } catch { /* private mode */ }
  }, [key]);
  return [v, set];
}

const DAY = 86_400_000;
function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); }

// Outlook's own list headings.
function dateGroup(iso: string): string {
  const d = parseReceived(iso);
  const t = d.getTime();
  if (isNaN(t)) return 'Older';
  const sod = startOfToday();
  if (t >= sod) return 'Today';
  if (t >= sod - DAY) return 'Yesterday';
  const dow = (new Date(sod).getDay() + 6) % 7;          // Monday = 0
  const sow = sod - dow * DAY;
  if (t >= sow) return 'This week';
  if (t >= sow - 7 * DAY) return 'Last week';
  const now = new Date();
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return 'Earlier this month';
  return 'Older';
}

function rowDate(iso: string): string {
  const d = parseReceived(iso);
  const t = d.getTime();
  if (isNaN(t)) return '';
  const sod  = startOfToday();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (t >= sod) return time;
  if (t >= sod - 6 * DAY) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: '2-digit' });
}

function fullDate(iso: string): string {
  const d = parseReceived(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Drag with a full-window shield on top, so the email iframe cannot swallow the
// mousemove events halfway through a resize.
function startDrag(e: React.MouseEvent, cursor: string, onMove: (dx: number, dy: number) => void, onDone: () => void) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const shield = document.createElement('div');
  shield.style.cssText = `position:fixed;inset:0;z-index:99999;cursor:${cursor}`;
  document.body.appendChild(shield);
  const move = (ev: MouseEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    shield.remove();
    onDone();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Module-level so switching app tabs does not re-check Outlook or re-read stores.
let _oAvailable: boolean | null = null;
let _oError = '';
let _oMailboxes: Mailbox[] = [];
let _oSelected = '';

// ─── Small UI primitives ──────────────────────────────────────────────────────
type IconT = React.ComponentType<{ className?: string }>;

function RBtn({ icon: Icon, label, onClick, active, disabled, title, danger, locked, caret }: {
  icon: IconT; label: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean; disabled?: boolean; title?: string; danger?: boolean; locked?: boolean; caret?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title || label} aria-pressed={active}
      className={cn(
        'shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12.5px] whitespace-nowrap transition-colors',
        'disabled:opacity-35 disabled:pointer-events-none',
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] font-medium'
          : danger ? 'text-[var(--t1)] hover:bg-[var(--err-soft)] hover:text-[var(--err)]'
          : 'text-[var(--t1)] hover:bg-[var(--s-hover)]',
        locked && 'opacity-55',
      )}>
      <Icon className={cn('w-4 h-4 shrink-0', !active && 'text-[var(--t2)]')} />
      {label}
      {caret && <ChevronDown className="w-3 h-3 text-[var(--t3)]" />}
      {locked && <Lock className="w-3 h-3 text-[var(--t3)]" />}
    </button>
  );
}
const RSep = () => <span className="shrink-0 w-px h-6 bg-[var(--line-2)] mx-1.5" />;

function IconBtn({ icon: Icon, title, onClick, active, className }: {
  icon: IconT; title: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; className?: string;
}) {
  return (
    <button aria-label={title} title={title} onClick={onClick}
      className={cn('shrink-0 w-8 h-8 rounded-md flex items-center justify-center transition-colors',
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--t2)] hover:bg-[var(--s-hover)] hover:text-[var(--t1)]', className)}>
      <Icon className="w-4 h-4" />
    </button>
  );
}

function FloatingMenu({ x, y, onClose, children, minWidth = 220 }: {
  x: number; y: number; onClose: () => void; children: React.ReactNode; minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Clamp inside the window: a right-click near the bottom edge used to open a
  // menu half off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: clamp(x, 8, window.innerWidth - r.width - 8),
      top:  clamp(y, 8, window.innerHeight - r.height - 8),
    });
  }, [x, y]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-[9990]" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
      <div ref={ref} role="menu"
        className="fixed z-[9991] py-1 rounded-lg bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] text-[12.5px] max-h-[80vh] overflow-y-auto"
        style={{ ...pos, minWidth, boxShadow: 'var(--pop-sh)' }}>
        {children}
      </div>
    </>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, disabled, hint, checked }: {
  icon?: IconT; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean;
}) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick}
      className={cn('w-full flex items-center gap-2.5 h-8 px-3 text-left transition-colors disabled:opacity-35',
        danger ? 'text-[var(--err)] hover:bg-[var(--err-soft)]' : 'text-[var(--t1)] hover:bg-[var(--s-hover)]')}>
      {checked !== undefined
        ? <Check className={cn('w-4 h-4 shrink-0', checked ? 'text-[var(--accent-text)]' : 'opacity-0')} />
        : Icon ? <Icon className={cn('w-4 h-4 shrink-0', !danger && 'text-[var(--t2)]')} /> : <span className="w-4 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-[var(--t4)] pl-4">{hint}</span>}
    </button>
  );
}
const MenuSep = () => <div className="my-1 h-px bg-[var(--line)]" />;
const MenuLabel = ({ children }: { children: React.ReactNode }) =>
  <p className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--t4)]">{children}</p>;

function Avatar({ name, seed, size = 32 }: { name: string; seed: string; size?: number }) {
  return (
    <span className="shrink-0 rounded-full flex items-center justify-center font-semibold text-white select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: avatarColor(seed || name) }}>
      {avatarInitials(name)}
    </span>
  );
}

function attKind(a: AttachmentInfo): { Icon: IconT; tone: string } {
  if (a.isPdf) return { Icon: FileText, tone: 'bg-red-500/10 text-red-600 dark:text-red-400' };
  if (a.isImage || isImageFile(a.name)) return { Icon: ImageIcon, tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' };
  if (isExcelFile(a.name)) return { Icon: FileSpreadsheet, tone: 'bg-green-600/10 text-green-700 dark:text-green-400' };
  return { Icon: Paperclip, tone: 'bg-[var(--s3)] text-[var(--t2)]' };
}

// ─── Inline compose (reply / forward) ─────────────────────────────────────────
// Opens at the top of the reading pane, above the message, as Outlook does.
// Plain text for now — HTML with formatting and send-with-undo is phase 3.
function InlineCompose({ detail, mode, onClose, toast, zoom }: {
  detail: EmailDetail; mode: ComposeMode; onClose: () => void; toast: ToastFn; zoom: number;
}) {
  const key = `inbox_draft_${detail.entryId}`;
  const [text, setText] = useState(() => {
    if (mode !== 'reply') return '';
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
  });
  const [to, setTo]           = useState('');
  const [roster, setRoster]   = useState<Array<{ name: string; email: string }>>([]);
  const [busy, setBusy]       = useState<string | null>(null);
  const [undo, setUndo]       = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState('');
  const [menu, setMenu]       = useState<{ x: number; y: number } | null>(null);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { taRef.current?.focus(); }, []);
  useEffect(() => {
    if (mode !== 'reply') return;
    try { text.trim() ? localStorage.setItem(key, text) : localStorage.removeItem(key); } catch { /* private mode */ }
  }, [text, key, mode]);
  useEffect(() => {
    if (mode !== 'forward') return;
    api.todoRecipients().then(r => setRoster((r.recipients || []).map(x => ({ name: x.name, email: x.email })))).catch(() => {});
  }, [mode]);

  // Every AI action is a click, and every one can be taken back with Undo.
  async function ai(kind: 'draft' | 'polish' | 'shorten' | 'formalize' | 'rewrite') {
    setMenu(null);
    if (busy) return;
    if (kind !== 'draft' && !text.trim()) { toast('warn', 'Write something first — the AI reshapes what is in the box'); return; }
    setBusy(kind);
    try {
      let out = '';
      const analysis = _summaryCache[detail.entryId] || '';
      if (kind === 'draft') {
        const r = await runTask('Drafting reply…', s => api.outlookDraftReply({
          subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
          received: detail.received, body: detail.body, analysis,
        }, s));
        if (r.error) toast('warn', failed('draft a reply', r.error));
        out = r.draft || '';
      } else {
        const r = await runTask(`${kind[0].toUpperCase()}${kind.slice(1)}…`, s => api.outlookPolishReply({
          text, mode: kind, subject: detail.subject, sender: detail.sender,
          senderEmail: detail.senderEmail, body: detail.body, analysis,
        }, s));
        if (r.error) toast('warn', failed('reshape that text', r.error));
        out = r.text || '';
      }
      if (out) {
        setUndo(text);
        setText(kind === 'draft' && text.trim() ? `${text.trimEnd()}\n\n${out}` : out);
        setAiDraft(out);
      }
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('run the AI on this email', e)); }
    setBusy(null);
  }

  async function send() {
    if (!text.trim() || sending) return;
    if (mode === 'forward' && !to.trim()) { toast('warn', 'Who is this going to? Fill in To'); return; }
    setSending(true);
    try {
      const r = mode === 'reply'
        ? await api.outlookSendReply(detail.entryId, text.trim())
        : await api.outlookForward(detail.entryId, to.trim(), text.trim());
      if (r.error) {
        toast('err', failed(mode === 'reply' ? `send the reply to ${detail.senderEmail}` : `forward the email to ${to.trim()}`, r.error));
      } else {
        toast('ok', mode === 'reply' ? `Reply sent to ${detail.senderEmail}` : `Forwarded to ${to.trim()}`);
        if (mode === 'reply') {
          try { localStorage.removeItem(key); } catch { /* private mode */ }
          void api.outlookFeedback({
            entryId: detail.entryId, subject: detail.subject, senderEmail: detail.senderEmail,
            draftReply: aiDraft, finalReply: text.trim(),
            feedbackType: aiDraft && aiDraft.trim() !== text.trim() ? 'edited_sent' : 'sent',
          }).catch(() => {});
        }
        onClose();
      }
    } catch (e: any) { toast('err', failed('send that email', e)); }
    setSending(false);
  }

  return (
    <div className="mx-6 mb-4 rounded-lg ring-1 ring-inset ring-[var(--line-2)] bg-[var(--s1)] overflow-hidden" style={{ boxShadow: 'var(--card-sh)' }}>
      <div className="flex items-center gap-1 px-2 h-11 border-b border-[var(--line)] bg-[var(--s3)] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        <button onClick={send} disabled={sending || !text.trim()} title="Send (Ctrl+Enter)"
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md text-[12.5px] font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-45 transition-colors">
          {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Send
        </button>
        <RBtn icon={Trash2} label="Discard" onClick={onClose} />
        <RSep />
        <RBtn icon={WandSparkles} label={busy ? 'Working…' : 'AI'} caret locked={STRIPPED}
          onClick={e => {
            if (STRIPPED) { toast('info', 'AI drafting is coming soon'); return; }
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }} />
        {undo !== null && <RBtn icon={Undo2} label="Undo AI" onClick={() => { setText(undo); setUndo(null); }} />}
        <span className="flex-1" />
        <span className="shrink-0 pr-2 text-[11.5px] text-[var(--t3)]">{mode === 'reply' ? 'Reply' : 'Forward'} · plain text</span>
      </div>
      <div className="flex items-center gap-3 px-4 min-h-10 py-1.5 border-b border-[var(--line)] text-[13px]">
        <span className="w-12 shrink-0 text-[var(--t3)]">To</span>
        {mode === 'reply' ? (
          <span className="inline-flex items-center gap-2 h-7 pl-1 pr-2.5 rounded-full bg-[var(--s3)] text-[var(--t1)] min-w-0">
            <Avatar name={detail.sender} seed={detail.senderEmail} size={22} />
            <span className="truncate">{detail.sender}</span>
            <span className="text-[var(--t3)] truncate">{detail.senderEmail}</span>
          </span>
        ) : (
          <>
            <input value={to} onChange={e => setTo(e.target.value)} list="ol-roster" placeholder="Name or email address"
              className="flex-1 min-w-0 h-7 bg-transparent outline-none text-[var(--t1)] placeholder:text-[var(--t4)]" />
            <datalist id="ol-roster">{roster.slice(0, 300).map((c, i) => <option key={i} value={c.email}>{c.name}</option>)}</datalist>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 px-4 h-10 border-b border-[var(--line)] text-[13px]">
        <span className="w-12 shrink-0 text-[var(--t3)]">Subject</span>
        <span className="truncate text-[var(--t2)]">{mode === 'reply' ? 'RE: ' : 'FW: '}{detail.subject}</span>
      </div>
      <textarea ref={taRef} value={text} onChange={e => setText(e.target.value)} rows={8}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); } }}
        placeholder={mode === 'reply' ? 'Write your reply…' : 'Add a message (optional)…'}
        className="block w-full px-4 py-3 bg-transparent resize-y outline-none leading-relaxed text-[var(--t1)] placeholder:text-[var(--t4)] font-sans"
        style={{ fontSize: 14 * Math.min(zoom, 1.3), minHeight: 160 }} />
      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuLabel>Write</MenuLabel>
          <MenuItem icon={Sparkles} label="Draft a reply from the email" onClick={() => ai('draft')} />
          <MenuSep />
          <MenuLabel>Reshape what I wrote</MenuLabel>
          <MenuItem icon={WandSparkles} label="Polish into an email" onClick={() => ai('polish')} disabled={!text.trim()} />
          <MenuItem label="Shorten" onClick={() => ai('shorten')} disabled={!text.trim()} />
          <MenuItem label="More formal" onClick={() => ai('formalize')} disabled={!text.trim()} />
          <MenuItem label="Rewrite" onClick={() => ai('rewrite')} disabled={!text.trim()} />
        </FloatingMenu>
      )}
    </div>
  );
}

// ─── Vector task pane: Summary ────────────────────────────────────────────────
function VectorSummary({ detail, toast, setAppTab }: { detail: EmailDetail; toast: ToastFn; setAppTab: (t: string) => void }) {
  const id = detail.entryId;
  const [analysis, setAnalysis] = useState(() => _summaryCache[id] || '');
  const [busy, setBusy]         = useState(false);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [liked, setLiked]       = useState<'up' | 'down' | null>(null);
  const [chat, setChat]         = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [q, setQ]               = useState('');
  const [asking, setAsking]     = useState(false);
  const [todo, setTodo]         = useState<TodoBucket | null>(null);
  const [addingTodo, setAddingTodo] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A stored summary costs nothing to show; only the button spends tokens.
  useEffect(() => {
    if (_summaryCache[id]) return;
    let live = true;
    api.outlookGetSummary(id).then(s => {
      if (live && s.summary) { _summaryCache[id] = s.summary; capRecord(_summaryCache, MAX_SUMMARIES); setAnalysis(s.summary); }
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [chat, asking]);

  const inc = () => Array.from(included).sort((a, b) => a - b);

  async function summarize(force = false) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await runTask(force ? 'Re-summarizing…' : 'Summarizing…', s => api.outlookSummarize({
        entryId: id, subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
        received: detail.received, body: detail.body, attachments: detail.attachments,
        includeIndices: inc(), force,
      }, s));
      const text = r.summary || r.error || 'No summary returned.';
      setAnalysis(text);
      _summaryCache[id] = text;
      capRecord(_summaryCache, MAX_SUMMARIES);
      if (r.imagesRead) toast('info', `Read ${plural(r.imagesRead, 'image')} from the email`);
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('summarize the email', e)); }
    setBusy(false);
  }

  async function ask() {
    const question = q.trim();
    if (!question || asking) return;
    setQ('');
    const history = chat;
    setChat(prev => [...prev, { role: 'user', text: question }]);
    setAsking(true);
    try {
      const r = await runTask('Assistant thinking…', s => api.outlookChat({
        entryId: id, subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
        body: detail.body, analysis, history, question, includeIndices: inc(),
      }, s));
      setChat(prev => [...prev, { role: 'ai', text: r.answer || r.error || 'No response.' }]);
    } catch (e: any) {
      if (!isCancel(e)) setChat(prev => [...prev, { role: 'ai', text: 'Error: ' + e.message }]);
    }
    setAsking(false);
  }

  async function addTodo(bucket: TodoBucket) {
    setAddingTodo(true);
    try {
      const due = new Date();
      due.setDate(due.getDate() + (bucket === 'direct' ? 1 : 2));
      const r = await api.todoSave({
        conv: '', entryId: id, subject: detail.subject, sender: detail.sender, senderEmail: detail.senderEmail,
        received: detail.received, bucket, title: detail.subject || '(no subject)', summary: analysis,
        recipients: bucket === 'needs_info' && detail.senderEmail
          ? [{ name: detail.sender || detail.senderEmail, email: detail.senderEmail }] : [],
        attachments: detail.attachments.filter(a => !a.isInline).map(a => ({ index: a.index, name: a.name, size: a.size })),
        due: due.toISOString().slice(0, 10), source: 'inbox',
      });
      if (r.item) { setTodo(bucket); toast('ok', `Added to the To-Do board — due ${due.toISOString().slice(0, 10)}`); }
    } catch (e: any) { toast('err', failed('add this email to the To-Do board', e)); }
    setAddingTodo(false);
  }

  function feedback(type: 'up' | 'down') {
    if (liked) return;
    setLiked(type);
    api.outlookFeedback({
      entryId: id, subject: detail.subject, senderEmail: detail.senderEmail,
      feedbackType: type === 'up' ? 'liked_analysis' : 'disliked_analysis',
    }).catch(() => {});
  }

  const readable = detail.attachments.filter(a => a.isPdf || a.isImage || isImageFile(a.name));

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex-1 px-4 py-4 space-y-4">
        {!analysis && (
          <div className="rounded-lg bg-[var(--s3)] p-4">
            <p className="text-[13px] font-medium text-[var(--t1)]">Summarize this email</p>
            <p className="mt-1 text-[12px] text-[var(--t3)] leading-relaxed">
              Reads the text only. Tick a picture or PDF below if the AI needs to see it.
            </p>
            <button onClick={() => summarize()} disabled={busy}
              className="mt-3 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md text-[12.5px] font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {busy ? 'Reading…' : 'Summarize'}
            </button>
          </div>
        )}

        {analysis && (
          <section>
            <div className="flex items-center gap-1 mb-2">
              <p className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--t3)]">Summary</p>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--t3)]" />}
              <IconBtn icon={ThumbsUp} title="Helpful" onClick={() => feedback('up')} active={liked === 'up'} className="w-7 h-7" />
              <IconBtn icon={ThumbsDown} title="Not helpful" onClick={() => feedback('down')} active={liked === 'down'} className="w-7 h-7" />
              <IconBtn icon={RefreshCw} title="Summarize again" onClick={() => summarize(true)} className="w-7 h-7" />
            </div>
            <div className="text-[13px]"><Md text={analysis} /></div>
          </section>
        )}

        {readable.length > 0 && (
          <section>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--t3)] mb-2">Let the AI read</p>
            <div className="flex flex-wrap gap-1.5">
              {readable.map(a => {
                const on = included.has(a.index);
                return (
                  <button key={a.index} title={on ? 'The AI reads this — click to exclude' : 'Click so the AI reads this'}
                    onClick={() => setIncluded(prev => { const n = new Set(prev); n.has(a.index) ? n.delete(a.index) : n.add(a.index); return n; })}
                    className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] ring-1 ring-inset max-w-full transition-colors',
                      on ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] ring-[var(--accent-line)]'
                         : 'text-[var(--t2)] ring-[var(--line-2)] hover:bg-[var(--s-hover)]')}>
                    {on ? <Check className="w-3.5 h-3.5 shrink-0" /> : a.isPdf ? <FileText className="w-3.5 h-3.5 shrink-0" /> : <ImageIcon className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate max-w-[180px]">{a.name}</span>
                  </button>
                );
              })}
            </div>
            {analysis && included.size > 0 && (
              <button onClick={() => summarize(true)} disabled={busy}
                className="mt-2 text-[12px] font-medium text-[var(--accent-text)] hover:underline">
                Summarize again with {plural(included.size, 'file')}
              </button>
            )}
          </section>
        )}

        {analysis && (
          <section className="pt-3 border-t border-[var(--line)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--t3)] mb-2">To-Do board</p>
            {todo ? (
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--t2)]">
                <CheckCircle2 className="w-4 h-4 text-[var(--ok)] shrink-0" />
                <span className="flex-1">Added as {todo === 'direct' ? 'yours to finish' : todo === 'needs_info' ? 'waiting on info' : 'one for the team'}</span>
                <button onClick={() => setAppTab('Todo')} className="font-medium text-[var(--accent-text)] hover:underline">Open</button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {([['direct', 'I can do this'], ['needs_info', 'Needs info'], ['needs_team', 'Needs the team']] as Array<[TodoBucket, string]>).map(([b, label]) => (
                  <button key={b} onClick={() => addTodo(b)} disabled={addingTodo}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] text-[var(--t1)] ring-1 ring-inset ring-[var(--line-2)] hover:bg-[var(--s-hover)] disabled:opacity-50">
                    <Plus className="w-3.5 h-3.5 text-[var(--t3)]" />{label}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {chat.length > 0 && (
          <section className="pt-3 border-t border-[var(--line)] space-y-2">
            {chat.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[92%] px-3 py-2 rounded-xl text-[12.5px]',
                  m.role === 'user' ? 'bg-[var(--accent)] text-white rounded-br-sm' : 'bg-[var(--s3)] text-[var(--t1)] rounded-bl-sm')}>
                  {m.role === 'ai' ? <Md text={m.text} /> : m.text}
                </div>
              </div>
            ))}
            {asking && (
              <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--s3)] text-[12.5px] text-[var(--t3)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />Thinking…
              </div>
            )}
            <div ref={endRef} />
          </section>
        )}
      </div>

      <div className="sticky bottom-0 px-3 py-2.5 bg-[var(--s1)] border-t border-[var(--line)]">
        <div className="flex items-center gap-2 h-9 pl-3 pr-1 rounded-lg bg-[var(--s3)] ring-1 ring-inset ring-[var(--line)] focus-within:ring-[var(--accent-line)]">
          <input value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void ask(); } }}
            placeholder="Ask about this email…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-[var(--t1)] placeholder:text-[var(--t4)]" />
          <button aria-label="Ask" onClick={ask} disabled={!q.trim() || asking}
            className="w-7 h-7 rounded-md flex items-center justify-center bg-[var(--accent)] text-white disabled:opacity-40">
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────────
function InboxOutlookPage({ toast, setTab, onUnreadCount, onSwitchLayout }: InboxProps & { onSwitchLayout: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(_oAvailable);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(_oMailboxes);
  const [storeId, setStoreIdRaw]  = useState(() => localStorage.getItem('inbox_storeId') || 'default');
  const [view, setView]           = usePref<View>('ol_view', 'inbox');
  const [emails, setEmails]       = useState<EmailSummary[]>([]);
  const [loading, setLoading]     = useState(false);
  const [limit, setLimit]         = useState(50);
  const [hasMore, setHasMore]     = useState(true);
  const [syncedAt, setSyncedAt]   = useState<number | null>(null);
  const [, setClock]              = useState(0);
  const [selectedId, setSelectedRaw] = useState(_oSelected);
  const [detail, setDetail]       = useState<EmailDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [compose, setCompose]     = useState<ComposeMode | null>(null);
  const [ribbon, setRibbon]       = usePref<RibbonTab>('ol_ribbon', 'home');
  const [readingPos, setReadingPos] = usePref<ReadingPos>('ol_reading', 'right');
  const [density, setDensity]     = usePref<Density>('ol_density', 'comfortable');
  const [showPreview, setShowPreview] = usePref<boolean>('ol_preview', true);
  const [folderPane, setFolderPane] = usePref<boolean>('ol_folders', true);
  const [taskTab, setTaskTabRaw]  = usePref<string>('ol_task', '');
  const [taskW, setTaskW]         = usePref<number>('ol_task_w', 400);
  const [listW, setListW]         = usePref<number>('ol_list_w', 360);
  const [listH, setListH]         = usePref<number>('ol_list_h', 280);
  const [zoom, setZoomRaw]        = usePref<number>('inbox_text_zoom', 1.15);
  const [expanded, setExpanded]   = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('ol_expanded') || '{}'); } catch { return {}; }
  });
  const [flagged, setFlagged]     = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ol_flagged') || '[]')); } catch { return new Set(); }
  });
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [menu, setMenu]           = useState<{ kind: 'row' | 'categorize' | 'filter'; id: string; x: number; y: number } | null>(null);
  const [pendingDel, setPendingDel] = useState<{ id: string; label: string } | null>(null);
  const [lightbox, setLightbox]   = useState<{ src: string; name: string } | null>(null);
  const [popout, setPopout]       = useState(false);
  const [classicId, setClassicId] = useState<string | null>(null);
  const [composeNew, setComposeNew] = useState(false);
  const [showInline, setShowInline] = useState(false);
  const [dropView, setDropView]   = useState<string | null>(null);
  const [rootW, setRootW]         = useState(1200);

  // Search — the same two layers as the classic page: typing narrows the loaded
  // list, Enter searches the quote folders through the local index.
  const [q, setQ]                 = useState('');
  const [matchMode, setMatchModeRaw] = useState<MatchMode>(() =>
    MATCH_MODE_OPTIONS.some(o => o.id === localStorage.getItem('inboxMatchMode')) ? localStorage.getItem('inboxMatchMode') as MatchMode : 'part');
  const [filters, setFiltersRaw]  = useState<FilterState>(EMPTY_FILTERS);
  const [facets, setFacets]       = useState<SearchFacets | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [deep, setDeep]           = useState<{ q: string; mode: MatchMode; scope: SearchScope; list: EmailSummary[]; total: number; truncated: boolean } | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);

  const rootRef    = useRef<HTMLDivElement>(null);
  const listRef    = useRef<HTMLElement>(null);
  const taskRef    = useRef<HTMLElement>(null);
  const listScroll = useRef<HTMLDivElement>(null);
  const searchRef  = useRef<HTMLInputElement>(null);
  const storeRef   = useRef(storeId);
  const limitRef   = useRef(limit);
  const deepAbort  = useRef<AbortController | null>(null);
  const delTimer   = useRef<number | null>(null);
  const pendingRef = useRef<string | null>(null);
  storeRef.current = storeId;
  limitRef.current = limit;

  const setSelected = (id: string) => { _oSelected = id; setSelectedRaw(id); };
  const setZoom = (z: number) => setZoomRaw(Math.round(clamp(z, 0.8, 1.8) * 100) / 100);
  const setMatchMode = (m: MatchMode) => { setMatchModeRaw(m); try { localStorage.setItem('inboxMatchMode', m); } catch { /* private */ } };
  const setFilters = useCallback((p: Partial<FilterState>) => setFiltersRaw(f => ({ ...f, ...p })), []);
  const taskOpen = (taskTab || null) as TaskTab | null;

  // ── Outlook + mailboxes ────────────────────────────────────────────────────
  const loadMailboxes = useCallback(async () => {
    if (_oMailboxes.length) { setMailboxes(_oMailboxes); return; }
    try {
      const r = await api.outlookMailboxes();
      const list: Mailbox[] = r.mailboxes || [];
      _oMailboxes = list;
      setMailboxes(list);
      const saved = localStorage.getItem('inbox_storeId');
      if (!(saved && (saved === 'default' || list.some(m => m.storeId === saved)))) {
        const shared = list.find(m => m.type === 'shared');
        if (shared) selectBox(shared.storeId, 'inbox');
      }
    } catch { /* the personal box still works */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (_oAvailable !== null) { if (_oAvailable) void loadMailboxes(); return; }
    api.outlookStatus()
      .then(r => { _oAvailable = r.available; _oError = r.error || ''; setAvailable(r.available); if (r.available) void loadMailboxes(); })
      .catch(e => { _oAvailable = false; _oError = e.message; setAvailable(false); });
  }, [loadMailboxes]);

  const loadEmails = useCallback(async (opts: { force?: boolean; silent?: boolean; limit?: number } = {}) => {
    const sid = storeRef.current;
    const lim = opts.limit ?? limitRef.current;
    const key = `${sid}:false:${lim}`;              // same key shape as the classic page — shared cache
    const cached = emailCache.get(key);
    if (!opts.force && cached && Date.now() - cached.ts < CACHE_TTL) {
      rememberStores(cached.emails, sid);
      setEmails(cached.emails);
      setSyncedAt(cached.ts);
      return;
    }
    if (!opts.silent) setLoading(true);
    try {
      const r = opts.silent
        ? await api.outlookEmails(sid, lim, false)
        : await runTask(`Fetching ${lim} emails…`, s => api.outlookEmails(sid, lim, false, s));
      if (sid === storeRef.current) {
        if (r.error && !opts.silent) toast('warn', failed('load the email list', r.error));
        const list = (r.emails || []) as EmailSummary[];
        emailCache.set(key, { emails: list, ts: Date.now() });
        capMap(emailCache, MAX_EMAIL_CACHE);
        rememberStores(list, sid);
        setEmails(list);
        setHasMore(list.length >= lim);
        setSyncedAt(Date.now());
      }
    } catch (e: any) {
      if (!opts.silent && !isCancel(e)) toast('err', failed('load the email list', e));
    }
    if (!opts.silent) setLoading(false);
  }, [toast]);

  useEffect(() => { if (available) void loadEmails(); }, [available, storeId, loadEmails]);
  useEffect(() => {
    if (!available) return;
    const t = setInterval(() => { void loadEmails({ force: true, silent: true }); setClock(c => c + 1); }, 30_000);
    return () => clearInterval(t);
  }, [available, storeId, loadEmails]);
  useEffect(() => { onUnreadCount?.(emails.filter(e => e.unread).length); }, [emails, onUnreadCount]);

  // ── Detail of the selected email ───────────────────────────────────────────
  // Debounced a touch so holding ↓ through the list does not open every message.
  useEffect(() => {
    setCompose(null);
    setShowInline(false);
    if (!selectedId) { setDetail(null); return; }
    const ctl = new AbortController();
    setLoadingDetail(true);
    const t = setTimeout(() => {
      api.outlookEmail(selectedId, _storeOf[selectedId], ctl.signal)
        .then((r: any) => {
          if (ctl.signal.aborted) return;
          if (r.error) { toast('warn', failed('open that email', r.error)); setDetail(null); return; }
          setDetail(r as EmailDetail);
          setEmails(prev => prev.map(e => e.entryId === selectedId ? { ...e, unread: false } : e));
        })
        .catch(e => { if (!ctl.signal.aborted && !isCancel(e)) toast('err', failed('open that email', e)); })
        .finally(() => { if (!ctl.signal.aborted) setLoadingDetail(false); });
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [selectedId, toast]);

  // ── Width: the folder pane steps down to icons when the Vector pane needs room
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([en]) => setRootW(en.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [available]);
  const foldersWide = folderPane && !(taskOpen && rootW < 1360);

  // ── Actions ────────────────────────────────────────────────────────────────
  function selectBox(sid: string, v: View) {
    setStoreIdRaw(sid);
    try { localStorage.setItem('inbox_storeId', sid); } catch { /* private */ }
    setView(v);
    clearSearch();
    if (sid !== storeRef.current) { setEmails([]); setSelected(''); setLimit(50); }
  }

  function toggleFlag(id: string) {
    const on = !flagged.has(id);
    const next = new Set(flagged);
    on ? next.add(id) : next.delete(id);
    setFlagged(next);
    try { localStorage.setItem('ol_flagged', JSON.stringify([...next].slice(-500))); } catch { /* private */ }
    api.outlookFlag(id, on)
      .then(r => { if (r.error) toast('err', failed(on ? 'flag the email in Outlook' : 'clear the flag in Outlook', r.error)); })
      .catch(e => toast('err', failed('flag the email in Outlook', e)));
  }

  function markUnread(id: string) {
    setEmails(prev => prev.map(e => e.entryId === id ? { ...e, unread: true } : e));
    api.outlookMarkUnread(id).catch(e => toast('err', failed('mark the email unread', e)));
  }

  function categorize(id: string, cat: string) {
    setCategories(prev => ({ ...prev, [id]: cat }));
    api.outlookCategorize(id, cat)
      .then(r => r.error ? toast('err', failed(`categorise as ${cat}`, r.error)) : toast('ok', `Categorised as ${cat}`))
      .catch(e => toast('err', failed(`categorise as ${cat}`, e)));
  }

  // Delete waits a few seconds with Undo before Outlook is told — the row goes
  // at once, the message only moves when the undo window closes.
  function commitDelete() {
    const id = pendingRef.current;
    pendingRef.current = null;
    if (delTimer.current) { clearTimeout(delTimer.current); delTimer.current = null; }
    setPendingDel(null);
    if (!id) return;
    setEmails(prev => prev.filter(e => e.entryId !== id));
    for (const [k, v] of emailCache) emailCache.set(k, { ...v, emails: v.emails.filter(e => e.entryId !== id) });
    api.outlookDelete(id)
      .then(r => { if (r.error) toast('err', failed('delete the email', r.error)); })
      .catch(e => toast('err', failed('delete the email', e)));
  }
  function deleteEmail(id: string) {
    if (pendingRef.current) commitDelete();
    const list = displayRef.current;
    const idx = list.findIndex(e => e.entryId === id);
    if (selectedId === id) setSelected((list[idx + 1] || list[idx - 1])?.entryId || '');
    pendingRef.current = id;
    setPendingDel({ id, label: list[idx]?.subject || 'Email' });
    delTimer.current = window.setTimeout(commitDelete, 6000);
  }
  function undoDelete() {
    if (delTimer.current) { clearTimeout(delTimer.current); delTimer.current = null; }
    pendingRef.current = null;
    setPendingDel(null);
  }
  useEffect(() => () => { if (pendingRef.current) api.outlookDelete(pendingRef.current).catch(() => {}); }, []);

  function openTask(t: TaskTab) {
    const meta = TASK_TABS.find(x => x.id === t);
    if (STRIPPED && meta?.ai) { toast('info', `${meta.label} is coming soon`); return; }
    if (taskOpen === t) { setTaskTabRaw(''); return; }
    setTaskTabRaw(t);
    if (!selectedId) toast('info', 'Select an email — the Vector pane works on the open message');
  }

  function openCompose(m: ComposeMode) {
    if (!detail) { toast('info', 'Select an email first'); return; }
    if (readingPos === 'off') setPopout(true);
    setCompose(m);
  }

  async function queuePdfs() {
    if (!detail) return;
    try {
      const r = await api.outlookSaveAttachment(detail.entryId);
      if (r.error) toast('err', failed('queue the PDF attachments', r.error));
      else if (r.count === 0) toast('warn', 'This email has no PDF attachments to queue');
      else toast('ok', `Queued ${plural(r.count, 'PDF')}`);
    } catch (e: any) { toast('err', failed('queue the PDF attachments', e)); }
  }

  async function rebuildIndex() {
    try {
      const r = await runTask('Rebuilding the search index…', () => api.outlookIndexSync(true));
      if (r.error) toast('err', failed('rebuild the search index', r.error));
      else toast('ok', `Search index rebuilt — ${plural(r.total ?? 0, 'email')}`);
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('rebuild the search index', e)); }
  }

  function openAttachment(a: AttachmentInfo) {
    if (!detail) return;
    if (a.isPdf) openAttachmentPdf(detail.entryId, a.index);
    else if (a.isImage || isImageFile(a.name)) setLightbox({ src: attViewUrl(detail.entryId, a.index), name: a.name });
    else if (isExcelFile(a.name)) openTask('pricer');
    else api.outlookOpenInOutlook(detail.entryId).catch(e => toast('err', failed('open the email in Outlook', e)));
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  async function runSearch() {
    const text = q.trim();
    if (text.length < 2 && !activeFilterPills(filters).length) {
      toast('warn', 'Type at least 2 characters, or set a filter, before searching');
      return;
    }
    deepAbort.current?.abort();
    const ctl = new AbortController();
    deepAbort.current = ctl;
    setDeepLoading(true);
    setShowFilters(false);
    try {
      const r = await api.outlookSearch(text, { mode: matchMode, scope: filters.scope, filters: toApiFilters(filters) }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.error) toast('warn', failed(text ? `search for "${text}"` : 'filter the quote folders', r.error));
      const list = (r.emails || []) as EmailSummary[];
      rememberStores(list);
      setDeep({ q: text, mode: r.mode || matchMode, scope: r.scope || filters.scope, list, total: r.total ?? list.length, truncated: !!r.truncated });
    } catch (e: any) {
      if (!ctl.signal.aborted && !isCancel(e)) toast('err', failed(`search for "${text}"`, e));
    } finally {
      if (deepAbort.current === ctl) setDeepLoading(false);
    }
  }
  function clearSearch() {
    deepAbort.current?.abort();
    setDeep(null);
    setDeepLoading(false);
    setQ('');
    setFiltersRaw(EMPTY_FILTERS);
  }
  useEffect(() => {
    if (showFilters && !facets) api.outlookSearchFacets().then(setFacets).catch(() => {});
  }, [showFilters, facets]);

  // ── Derived list ───────────────────────────────────────────────────────────
  const regs = highlightTerms(q, 1).map(t => new RegExp(termPattern(t, matchMode), 'i'));
  const inView = (e: EmailSummary) =>
    view === 'unread' ? e.unread
    : view === 'flagged' ? flagged.has(e.entryId)
    : view === 'attachments' ? e.attachments.some(a => !a.isInline)
    : true;
  const deepActive = deepLoading || deep !== null;
  const displayEmails = (deepActive ? (deep?.list || []) : emails
    .filter(inView)
    .filter(e => regs.every(r => r.test(scopeHaystack(e, filters.scope))) && passesFilters(e, filters)))
    .filter(e => e.entryId !== pendingDel?.id);
  const displayRef = useRef(displayEmails);
  displayRef.current = displayEmails;
  const hlTerms = highlightTerms(deepActive ? (deep?.q || '') : q);
  const hlMode  = deepActive ? (deep?.mode || matchMode) : matchMode;
  const selected = emails.find(e => e.entryId === selectedId) || deep?.list.find(e => e.entryId === selectedId) || null;
  const liveDetail = detail && detail.entryId === selectedId ? detail : null;
  const unreadCount = emails.filter(e => e.unread).length;
  const pills = activeFilterPills(filters);

  // ── Keyboard — Outlook's shortcuts where they exist ────────────────────────
  const kb = useRef<(e: KeyboardEvent) => void>(() => {});
  kb.current = (e: KeyboardEvent) => {
    if (!rootRef.current || rootRef.current.offsetParent === null) return;       // Inbox not on screen
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); searchRef.current?.focus(); return; }
    if (typing || menu || lightbox || classicId || composeNew) return;
    const list = displayRef.current;
    const idx = list.findIndex(x => x.entryId === selectedId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = list[e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1)];
      if (next) {
        setSelected(next.entryId);
        listScroll.current?.querySelector(`[data-entry-id="${CSS.escape(next.entryId)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Delete' && selectedId) { e.preventDefault(); deleteEmail(selectedId); }
    else if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); openCompose('reply'); }
    else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openCompose('forward'); }
    else if (ctrl && e.key.toLowerCase() === 'u' && selectedId) { e.preventDefault(); markUnread(selectedId); }
    else if (e.key === 'Insert' && selectedId) { e.preventDefault(); toggleFlag(selectedId); }
    else if (e.key === 'Enter' && selectedId) { e.preventDefault(); setPopout(true); }
    else if (e.key === 'Escape') { if (popout) setPopout(false); else if (compose) setCompose(null); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => kb.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── Early states ───────────────────────────────────────────────────────────
  if (available === null) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--t3)]" /></div>;
  }
  if (available === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
        <Mail className="w-8 h-8 text-[var(--warn)]" />
        <p className="text-[15px] font-semibold text-[var(--t1)]">Outlook not available</p>
        <p className="text-[13px] text-[var(--t3)] max-w-sm">Make sure Classic Outlook is open. {_oError}</p>
        <div className="flex gap-2">
          <button onClick={() => { _oAvailable = null; setAvailable(null); api.outlookStatus().then(r => { _oAvailable = r.available; setAvailable(r.available); if (r.available) void loadMailboxes(); }).catch(() => { _oAvailable = false; setAvailable(false); }); }}
            className="inline-flex items-center gap-2 h-8 px-4 rounded-md text-[13px] font-medium bg-[var(--t1)] text-[var(--bg)]">
            <RefreshCw className="w-4 h-4" />Retry
          </button>
          <button onClick={onSwitchLayout} className="h-8 px-4 rounded-md text-[13px] text-[var(--t2)] ring-1 ring-inset ring-[var(--line-2)]">Classic layout</button>
        </div>
      </div>
    );
  }

  const boxes: { storeId: string; name: string; shared: boolean }[] = [
    { storeId: 'default', name: 'Personal', shared: false },
    ...mailboxes.filter(m => m.type === 'shared').map(m => ({ storeId: m.storeId, name: m.name, shared: true })),
  ];
  const boxName = boxes.find(b => b.storeId === storeId)?.name || 'Mailbox';
  const lockAI = (fn: () => void, label: string) => () => (STRIPPED ? toast('info', `${label} is coming soon`) : fn());
  const needSel = !selectedId;
  const isFlagged = !!selectedId && flagged.has(selectedId);
  const syncedLabel = syncedAt ? (() => { const m = Math.floor((Date.now() - syncedAt) / 60000); return m < 1 ? 'just now' : `${m} min ago`; })() : '';

  // ── Ribbon ─────────────────────────────────────────────────────────────────
  const ribbonBody = (() => {
    switch (ribbon) {
      case 'home': return (
        <>
          <RBtn icon={SquarePen} label="New email" onClick={() => setComposeNew(true)} />
          <RSep />
          <RBtn icon={Trash2} label="Delete" danger disabled={needSel} onClick={() => deleteEmail(selectedId)} title="Delete (Del)" />
          <RSep />
          <RBtn icon={Reply} label="Reply" disabled={!liveDetail} onClick={() => openCompose('reply')} title="Reply (Ctrl+R)" />
          <RBtn icon={Forward} label="Forward" disabled={!liveDetail} onClick={() => openCompose('forward')} title="Forward (Ctrl+F)" />
          <RSep />
          <RBtn icon={Flag} label={isFlagged ? 'Unflag' : 'Flag'} active={isFlagged} disabled={needSel} onClick={() => toggleFlag(selectedId)} title="Flag (Insert)" />
          <RBtn icon={Mail} label="Mark unread" disabled={needSel || !!selected?.unread} onClick={() => markUnread(selectedId)} title="Mark unread (Ctrl+U)" />
          <RBtn icon={Tag} label="Categorize" caret disabled={needSel}
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'categorize', id: selectedId, x: r.left, y: r.bottom + 4 }); }} />
          <RSep />
          <RBtn icon={ExternalLink} label="Open in Outlook" disabled={needSel}
            onClick={() => api.outlookOpenInOutlook(selectedId).catch(e => toast('err', failed('open the email in Outlook', e)))} />
          <RBtn icon={RefreshCw} label="Refresh" onClick={() => loadEmails({ force: true })} disabled={loading} />
        </>
      );
      case 'ai': return (
        <>
          <RBtn icon={Sparkles} label="Summarize" active={taskOpen === 'summary'} locked={STRIPPED} onClick={() => openTask('summary')} />
          <RSep />
          <RBtn icon={Zap} label="EL Pricer" active={taskOpen === 'pricer'} locked={STRIPPED} onClick={() => openTask('pricer')} />
          <RBtn icon={Battery} label="CBU Sheet" active={taskOpen === 'cbu'} locked={STRIPPED} onClick={() => openTask('cbu')} />
          <RBtn icon={FileDown} label="Quick Quote" active={taskOpen === 'quote'} locked={STRIPPED} onClick={() => openTask('quote')} />
          <RSep />
          <RBtn icon={HistoryIcon} label="Customer history" active={taskOpen === 'history'} onClick={() => openTask('history')} />
          <RBtn icon={ListTodo} label="To-Do board" onClick={() => setTab('Todo')} />
          <RSep />
          <RBtn icon={Paperclip} label="Send a quote…" disabled={needSel} locked={STRIPPED}
            title="Attach & Send — pick the quote, the recipient and the covering note"
            onClick={lockAI(() => setClassicId(selectedId), 'Send a quote')} />
        </>
      );
      case 'tools': return (
        <>
          <RBtn icon={Download} label="Queue PDFs" disabled={!liveDetail?.hasPdf} onClick={queuePdfs} title="Save this email's PDFs to the processing queue" />
          <RBtn icon={Wrench} label="Classic tools" disabled={needSel} onClick={() => setClassicId(selectedId)} title="Open this email with every classic panel" />
          <RSep />
          <RBtn icon={Database} label="Rebuild search index" onClick={rebuildIndex} />
        </>
      );
      case 'view': return (
        <>
          <RBtn icon={PanelLeft} label="Folder pane" active={folderPane} onClick={() => setFolderPane(!folderPane)} />
          <RSep />
          <RBtn icon={PanelRight} label="Reading right" active={readingPos === 'right'} onClick={() => setReadingPos('right')} />
          <RBtn icon={PanelBottom} label="Bottom" active={readingPos === 'bottom'} onClick={() => setReadingPos('bottom')} />
          <RBtn icon={EyeOff} label="Off" active={readingPos === 'off'} onClick={() => setReadingPos('off')} title="Reading pane off — Enter or double-click opens a message" />
          <RSep />
          <RBtn icon={AlignJustify} label="Comfortable" active={density === 'comfortable'} onClick={() => setDensity('comfortable')} />
          <RBtn icon={ListIcon} label="Compact" active={density === 'compact'} onClick={() => setDensity('compact')} />
          <RBtn icon={Rows3} label="Preview text" active={showPreview} onClick={() => setShowPreview(!showPreview)} />
          <RSep />
          <IconBtn icon={AArrowDown} title="Smaller text" onClick={() => setZoom(zoom - 0.1)} />
          <button onClick={() => setZoom(1.15)} title="Reset text size" className="shrink-0 h-8 px-1.5 rounded-md text-[12.5px] tabular-nums text-[var(--t1)] hover:bg-[var(--s-hover)]">{Math.round(zoom * 100)}%</button>
          <IconBtn icon={AArrowUp} title="Larger text" onClick={() => setZoom(zoom + 0.1)} />
          <RSep />
          <RBtn icon={Sparkles} label="Vector pane" active={!!taskOpen} onClick={() => (taskOpen ? setTaskTabRaw('') : openTask(STRIPPED ? 'history' : 'summary'))} />
          <RSep />
          <RBtn icon={LayoutPanelLeft} label="Classic layout" onClick={onSwitchLayout} />
        </>
      );
    }
  })();

  // ── Reading pane contents ──────────────────────────────────────────────────
  const reading = (inPopout: boolean) => {
    if (!selectedId) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
          <Mail className="w-10 h-10 text-[var(--t4)]" strokeWidth={1.25} />
          <p className="text-[14px] font-medium text-[var(--t2)]">Select an item to read</p>
          <p className="text-[12px] text-[var(--t4)]">↑ ↓ to move · Ctrl+R reply · Del delete · Ctrl+E search</p>
        </div>
      );
    }
    if (!liveDetail) {
      return <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" /></div>;
    }
    const d = liveDetail;
    const files  = d.attachments.filter(a => !a.isInline);
    const inline = d.attachments.filter(a => a.isInline);
    const shownAtts = showInline ? d.attachments : files;
    return (
      <div className="h-full overflow-y-auto bg-[var(--s1)]">
        <header className="px-6 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <h1 className="flex-1 min-w-0 text-[19px] leading-snug font-semibold text-[var(--t1)] break-words">{d.subject || '(no subject)'}</h1>
            {categories[d.entryId] && (
              <span className="shrink-0 mt-1 px-2 h-6 inline-flex items-center rounded text-[11.5px] bg-[var(--violet-soft)] text-[var(--violet)]">{categories[d.entryId]}</span>
            )}
            {!inPopout && <IconBtn icon={Maximize2} title="Open in its own window (Enter)" onClick={() => setPopout(true)} />}
          </div>
          <div className="mt-4 flex items-start gap-3">
            <Avatar name={d.sender} seed={d.senderEmail} size={40} />
            <div className="flex-1 min-w-0">
              {/* Name and address on their own lines — side by side, a narrow
                  reading pane (Vector pane open) cut the name to "Steve…". */}
              <p className="text-[14px] font-semibold text-[var(--t1)] truncate">{d.sender}</p>
              <p className="text-[12.5px] text-[var(--t3)] truncate" title={d.senderEmail}>{d.senderEmail}</p>
              {d.to && <p className="text-[12.5px] text-[var(--t2)] truncate" title={d.to}><span className="text-[var(--t3)]">To:</span> {d.to}</p>}
              {d.cc && <p className="text-[12.5px] text-[var(--t2)] truncate" title={d.cc}><span className="text-[var(--t3)]">Cc:</span> {d.cc}</p>}
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              <div className="flex items-center gap-0.5">
                <IconBtn icon={Reply} title="Reply (Ctrl+R)" onClick={() => openCompose('reply')} active={compose === 'reply'} />
                <IconBtn icon={Forward} title="Forward (Ctrl+F)" onClick={() => openCompose('forward')} active={compose === 'forward'} />
                <IconBtn icon={MoreHorizontal} title="More actions"
                  onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'row', id: d.entryId, x: r.right - 220, y: r.bottom + 4 }); }} />
              </div>
              <span className="text-[12px] text-[var(--t3)] whitespace-nowrap">{fullDate(d.received)}</span>
            </div>
          </div>

          {shownAtts.length > 0 || inline.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {shownAtts.map(a => {
                const k = attKind(a);
                return (
                  <button key={a.index} onClick={() => openAttachment(a)}
                    draggable onDragStart={e => { e.dataTransfer.setData('vector/attachment', JSON.stringify({ attIndex: a.index, attName: a.name, isImage: a.isImage || isImageFile(a.name) })); e.dataTransfer.effectAllowed = 'copy'; }}
                    title={`${a.name} · ${fmtSize(a.size)} — click to open, drag into the Pricer`}
                    className="w-[220px] max-w-full h-12 flex items-center gap-2.5 pl-2 pr-3 rounded-md ring-1 ring-inset ring-[var(--line-2)] hover:bg-[var(--s-hover)] text-left transition-colors">
                    <span className={cn('w-8 h-8 shrink-0 rounded flex items-center justify-center', k.tone)}><k.Icon className="w-4 h-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-[var(--t1)] truncate">{a.name}</span>
                      <span className="block text-[11px] text-[var(--t3)]">{fmtSize(a.size)}</span>
                    </span>
                  </button>
                );
              })}
              {inline.length > 0 && (
                <button onClick={() => setShowInline(s => !s)}
                  className="h-12 px-3 rounded-md text-[12px] text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--s-hover)]">
                  {showInline ? 'Hide inline images' : `+ ${plural(inline.length, 'inline image')}`}
                </button>
              )}
            </div>
          ) : null}
        </header>

        {compose && <InlineCompose key={`${d.entryId}:${compose}`} detail={d} mode={compose} onClose={() => setCompose(null)} toast={toast} zoom={zoom} />}

        <div className="border-t border-[var(--line)]">
          {d.htmlBody
            ? <EmailBodyFrame key={d.entryId} html={d.htmlBody} entryId={d.entryId} attachments={d.attachments} onImageOpen={setLightbox} zoom={zoom} />
            : <PlainBody text={d.body} zoom={zoom} />}
        </div>
      </div>
    );
  };

  // ── Message list ───────────────────────────────────────────────────────────
  let lastGroup = '';
  const listBody = (
    <div ref={listScroll} role="listbox" aria-label="Messages" className="flex-1 min-h-0 overflow-y-auto">
      {(loading && !emails.length && !deepActive) || deepLoading ? (
        <div className="h-full flex flex-col items-center justify-center gap-2 text-[12.5px] text-[var(--t3)] px-6 text-center">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" />
          {deepLoading ? 'Searching the quote folders…' : 'Loading messages…'}
        </div>
      ) : displayEmails.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
          <InboxIcon className="w-9 h-9 text-[var(--t4)]" strokeWidth={1.25} />
          <p className="text-[13px] text-[var(--t2)]">
            {deepActive ? 'Nothing in the quote folders matches' : q || pills.length ? 'No loaded messages match' : view === 'inbox' ? 'All caught up' : `Nothing in ${VIEW_LABEL[view]}`}
          </p>
          {!deepActive && (q.trim().length >= 2 || pills.length > 0) && (
            <button onClick={runSearch} className="text-[12.5px] font-medium text-[var(--accent-text)] hover:underline">Search the quote folders</button>
          )}
        </div>
      ) : (
        <>
          {displayEmails.map(e => {
            const g = deepActive ? '' : dateGroup(e.received);
            const head = !deepActive && g !== lastGroup ? g : null;
            lastGroup = g;
            const sel = e.entryId === selectedId;
            const fl = flagged.has(e.entryId);
            const hasFiles = e.attachments.some(a => !a.isInline);
            return (
              <React.Fragment key={e.entryId}>
                {head && (
                  <div className="sticky top-0 z-[1] flex items-center h-8 px-4 text-[12px] font-semibold text-[var(--t2)] bg-[var(--s1)] border-b border-[var(--line)]">{head}</div>
                )}
                <div role="option" aria-selected={sel} data-entry-id={e.entryId}
                  draggable onDragStart={ev => { ev.dataTransfer.setData('vector/email-row', e.entryId); ev.dataTransfer.effectAllowed = 'copyMove'; }}
                  onClick={() => { setSelected(e.entryId); if (readingPos === 'off') setPopout(true); }}
                  onDoubleClick={() => { setSelected(e.entryId); setPopout(true); }}
                  onContextMenu={ev => { ev.preventDefault(); setSelected(e.entryId); setMenu({ kind: 'row', id: e.entryId, x: ev.clientX, y: ev.clientY }); }}
                  className={cn('group relative flex gap-3 pl-4 pr-3 border-b border-[var(--line)] cursor-default select-none',
                    density === 'compact' ? 'py-1.5' : 'py-2.5',
                    sel ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--s-hover)]')}>
                  {e.unread && <span className="absolute left-0 inset-y-0 w-[3px] bg-[var(--accent)]" />}
                  {density === 'comfortable' && <span className="mt-0.5"><Avatar name={e.sender} seed={e.senderEmail} size={32} /></span>}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 h-5">
                      <span className={cn('flex-1 min-w-0 truncate text-[13px] text-[var(--t1)]', e.unread && 'font-semibold')}>
                        <Highlight text={e.sender} terms={hlTerms} mode={hlMode} />
                      </span>
                      <span className="shrink-0 flex items-center gap-1.5 text-[var(--t3)] group-hover:hidden">
                        {hasFiles && <Paperclip className="w-3.5 h-3.5" />}
                        {fl && <Flag className="w-3.5 h-3.5 text-[var(--err)] fill-current" />}
                        <span className={cn('text-[11.5px] tabular-nums', e.unread && 'text-[var(--accent-text)] font-semibold')}>{rowDate(e.received)}</span>
                      </span>
                      <span className="shrink-0 hidden group-hover:flex items-center">
                        {([
                          [Trash2, 'Delete', () => deleteEmail(e.entryId), false],
                          [Flag, fl ? 'Unflag' : 'Flag', () => toggleFlag(e.entryId), fl],
                          ...(e.unread ? [] : [[Mail, 'Mark unread', () => markUnread(e.entryId), false]]),
                        ] as Array<[IconT, string, () => void, boolean]>).map(([I, label, fn, on]) => (
                          <button key={label} aria-label={label} title={label}
                            onClick={ev => { ev.stopPropagation(); fn(); }}
                            className={cn('w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--s3)]',
                              on ? 'text-[var(--err)]' : 'text-[var(--t2)] hover:text-[var(--t1)]')}>
                            <I className="w-3.5 h-3.5" />
                          </button>
                        ))}
                      </span>
                    </div>
                    <p className={cn('truncate text-[12.5px]', e.unread ? 'text-[var(--accent-text)] font-semibold' : 'text-[var(--t1)]')}>
                      <Highlight text={e.subject || '(no subject)'} terms={hlTerms} mode={hlMode} />
                    </p>
                    {showPreview && density === 'comfortable' && e.bodyPreview && (
                      <p className="truncate text-[12px] text-[var(--t3)]">{e.bodyPreview}</p>
                    )}
                    {(categories[e.entryId] || (deepActive && e.folder)) && (
                      <div className="mt-1 flex items-center gap-1.5">
                        {categories[e.entryId] && <span className="px-1.5 h-5 inline-flex items-center rounded text-[11px] bg-[var(--violet-soft)] text-[var(--violet)]">{categories[e.entryId]}</span>}
                        {deepActive && e.folder && <span className="px-1.5 h-5 inline-flex items-center rounded text-[11px] bg-[var(--s3)] text-[var(--t3)] truncate">{e.folder}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {!deepActive && hasMore && (
            <button onClick={() => { const n = limit + 50; setLimit(n); void loadEmails({ force: true, limit: n }); }} disabled={loading}
              className="w-full h-10 text-[12.5px] font-medium text-[var(--accent-text)] hover:bg-[var(--s-hover)] disabled:opacity-50">
              {loading ? 'Loading…' : 'Load older messages'}
            </button>
          )}
        </>
      )}
    </div>
  );

  const listPane = (
    <section ref={listRef as React.RefObject<HTMLElement>}
      className={cn('min-w-0 min-h-0 flex flex-col bg-[var(--s1)]', readingPos === 'off' ? 'flex-1' : 'shrink-0')}
      style={readingPos === 'right' ? { width: listW } : readingPos === 'bottom' ? { height: listH } : undefined}>
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-2 h-11 border-b border-[var(--line)]">
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--t1)] truncate">{deepActive ? 'Search results' : VIEW_LABEL[view]}</h2>
          <span className="text-[12px] text-[var(--t3)] truncate">{deepActive ? (deep ? plural(deep.total, 'result') : '') : boxName}</span>
        </div>
        {deepActive ? (
          <button onClick={clearSearch} className="shrink-0 h-8 px-2.5 rounded-md text-[12.5px] font-medium text-[var(--accent-text)] hover:bg-[var(--s-hover)]">Back to {VIEW_LABEL[view]}</button>
        ) : (
          <RBtn icon={SlidersHorizontal} label={view === 'inbox' ? 'All' : VIEW_LABEL[view]} caret
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'filter', id: '', x: r.left, y: r.bottom + 4 }); }} />
        )}
      </div>
      {pills.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-[var(--line)]">
          {pills.map(p => (
            <button key={p.key} onClick={() => setFilters(p.patch)} title="Remove this filter"
              className="inline-flex items-center gap-1 h-6 pl-2.5 pr-1.5 rounded-full text-[11.5px] bg-[var(--accent-soft)] text-[var(--accent-text)]">
              <span className="truncate max-w-[160px]">{p.label}</span><X className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}
      {listBody}
    </section>
  );

  // Resizers — DOM width during the drag, one state write on release.
  const dragList = (e: React.MouseEvent) => {
    const el = listRef.current;
    if (!el) return;
    const base = readingPos === 'bottom' ? el.offsetHeight : el.offsetWidth;
    let v = base;
    startDrag(e, readingPos === 'bottom' ? 'row-resize' : 'col-resize', (dx, dy) => {
      v = readingPos === 'bottom' ? clamp(base + dy, 140, window.innerHeight - 260) : clamp(base + dx, 260, Math.max(300, rootW * 0.55));
      if (readingPos === 'bottom') el.style.height = v + 'px'; else el.style.width = v + 'px';
    }, () => (readingPos === 'bottom' ? setListH(v) : setListW(v)));
  };
  const dragTask = (e: React.MouseEvent) => {
    const el = taskRef.current;
    if (!el) return;
    const base = el.offsetWidth;
    let v = base;
    startDrag(e, 'col-resize', dx => { v = clamp(base - dx, 320, Math.max(340, rootW * 0.5)); el.style.width = v + 'px'; }, () => setTaskW(v));
  };

  const menuEmail = menu ? (emails.find(e => e.entryId === menu.id) || deep?.list.find(e => e.entryId === menu.id) || null) : null;

  return (
    <div ref={rootRef} className="h-full min-h-0 flex flex-col bg-[var(--s1)] text-[var(--t1)]">
      {/* ── Ribbon tabs + search ─────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-4 px-3 h-11 border-b border-[var(--line)] bg-[var(--s1)]">
        <div role="tablist" aria-label="Ribbon" className="flex items-center">
          {([['home', 'Home'], ['ai', 'Vector AI'], ['tools', 'Tools'], ['view', 'View']] as Array<[RibbonTab, string]>).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={ribbon === id} onClick={() => setRibbon(id)}
              className={cn('relative h-11 px-3 text-[13px] transition-colors',
                ribbon === id
                  ? 'font-semibold text-[var(--t1)] after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[3px] after:rounded-t after:bg-[var(--accent)]'
                  : 'text-[var(--t2)] hover:text-[var(--t1)]')}>
              {id === 'ai' && <Sparkles className="inline w-3.5 h-3.5 mr-1 -mt-0.5 text-[var(--accent-text)]" />}{label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative w-[min(460px,42%)]">
          <div className="flex items-center gap-2 h-8 pl-2.5 pr-1 rounded-md bg-[var(--s3)] ring-1 ring-inset ring-[var(--line)] focus-within:bg-[var(--s1)] focus-within:ring-[var(--accent-line)]">
            <Search className="w-4 h-4 text-[var(--t3)] shrink-0" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void runSearch(); }
                if (e.key === 'Escape') { e.preventDefault(); clearSearch(); (e.target as HTMLInputElement).blur(); }
              }}
              placeholder="Search — type to filter, Enter searches the quote folders"
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-[var(--t1)] placeholder:text-[var(--t4)]" />
            {(q || deepActive) && (
              <button aria-label="Clear search" onClick={clearSearch} className="w-6 h-6 rounded flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)]"><X className="w-3.5 h-3.5" /></button>
            )}
            <button aria-label="Search filters" title="Filters — sender, date, folder, attachments, read state"
              onClick={() => setShowFilters(s => !s)}
              className={cn('h-6 px-1.5 rounded flex items-center gap-1 text-[11.5px]',
                pills.length || showFilters ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--t3)] hover:text-[var(--t1)]')}>
              <SlidersHorizontal className="w-3.5 h-3.5" />{pills.length || ''}
            </button>
          </div>
          {showFilters && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowFilters(false)} />
              <div className="absolute right-0 top-10 z-50 w-[380px] max-w-[90vw] rounded-lg bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] overflow-hidden" style={{ boxShadow: 'var(--pop-sh)' }}>
                <SearchFilterPanel filters={filters} setFilters={setFilters} matchMode={matchMode} setMatchMode={setMatchMode}
                  facets={facets} onReset={() => setFiltersRaw(EMPTY_FILTERS)} pillCount={pills.length} />
                <div className="flex justify-end gap-2 px-3 py-2 border-t border-[var(--line)]">
                  <button onClick={() => setShowFilters(false)} className="h-8 px-3 rounded-md text-[12.5px] text-[var(--t2)] hover:bg-[var(--s-hover)]">Close</button>
                  <button onClick={runSearch} className="h-8 px-3.5 rounded-md text-[12.5px] font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]">Search quote folders</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Simplified ribbon ────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-0.5 px-2 h-12 border-b border-[var(--line-2)] bg-[var(--s1)] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {ribbonBody}
      </div>

      {/* ── Panes ────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        {/* Folder pane */}
        {folderPane && (
          <nav aria-label="Folders" className="shrink-0 flex flex-col min-h-0 bg-[var(--s3)] border-r border-[var(--line-2)]" style={{ width: foldersWide ? 220 : 52 }}>
            <div className={cn('shrink-0 flex items-center gap-1 p-2', !foldersWide && 'flex-col')}>
              <IconBtn icon={PanelLeft} title="Hide folder pane" onClick={() => setFolderPane(false)} />
              {foldersWide ? (
                <button onClick={() => setComposeNew(true)}
                  className="flex-1 inline-flex items-center justify-center gap-2 h-8 rounded-md text-[13px] font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]">
                  <SquarePen className="w-4 h-4" />New email
                </button>
              ) : <IconBtn icon={SquarePen} title="New email" onClick={() => setComposeNew(true)} />}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              {boxes.map(b => {
                const open = expanded[b.storeId] ?? b.storeId === storeId;
                const current = b.storeId === storeId;
                const counts: Record<View, number | null> = current
                  ? { inbox: unreadCount, unread: unreadCount, flagged: emails.filter(e => flagged.has(e.entryId)).length, attachments: null }
                  : { inbox: null, unread: null, flagged: null, attachments: null };
                if (!foldersWide) {
                  return (
                    <div key={b.storeId} className="flex justify-center py-0.5">
                      <IconBtn icon={b.shared ? Users : InboxIcon} title={`${b.name} — Inbox`} active={current && !deepActive} onClick={() => selectBox(b.storeId, 'inbox')} />
                    </div>
                  );
                }
                return (
                  <div key={b.storeId} className="mt-2">
                    <button onClick={() => { const n = { ...expanded, [b.storeId]: !open }; setExpanded(n); try { localStorage.setItem('ol_expanded', JSON.stringify(n)); } catch { /* private */ } }}
                      className="w-full flex items-center gap-1.5 h-8 px-1.5 rounded-md text-[12.5px] font-semibold text-[var(--t1)] hover:bg-[var(--s-hover)]">
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-[var(--t3)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--t3)]" />}
                      <span className="truncate">{b.name}</span>
                    </button>
                    {open && ([
                      ['inbox', InboxIcon], ['unread', Mail], ['flagged', Flag], ['attachments', Paperclip],
                    ] as Array<[View, IconT]>).map(([v, I]) => {
                      const active = current && view === v && !deepActive;
                      const n = counts[v];
                      const dropKey = `${b.storeId}:${v}`;
                      return (
                        <button key={v} onClick={() => selectBox(b.storeId, v)}
                          onDragOver={v === 'flagged' && current ? (ev => { if (ev.dataTransfer.types.includes('vector/email-row')) { ev.preventDefault(); setDropView(dropKey); } }) : undefined}
                          onDragLeave={() => setDropView(cur => (cur === dropKey ? null : cur))}
                          onDrop={v === 'flagged' && current ? (ev => { ev.preventDefault(); setDropView(null); const id = ev.dataTransfer.getData('vector/email-row'); if (id && !flagged.has(id)) toggleFlag(id); }) : undefined}
                          className={cn('relative w-full flex items-center gap-2.5 h-8 pl-7 pr-2 rounded-md text-[13px] transition-colors',
                            dropView === dropKey ? 'bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent-line)]'
                              : active ? 'bg-[var(--s1)] font-semibold text-[var(--t1)] shadow-sm' : 'text-[var(--t1)] hover:bg-[var(--s-hover)]')}>
                          {active && <span className="absolute left-2 top-2 bottom-2 w-[3px] rounded-full bg-[var(--accent)]" />}
                          <I className={cn('w-4 h-4 shrink-0', active ? 'text-[var(--accent-text)]' : 'text-[var(--t2)]')} />
                          <span className="flex-1 text-left truncate">{VIEW_LABEL[v]}</span>
                          {n ? <span className={cn('text-[12px] tabular-nums', v === 'inbox' || v === 'unread' ? 'font-semibold text-[var(--accent-text)]' : 'text-[var(--t3)]')}>{n}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </nav>
        )}

        {/* List + reading pane */}
        <div className={cn('flex-1 min-w-0 min-h-0 flex', readingPos === 'bottom' ? 'flex-col' : 'flex-row')}>
          {listPane}
          {readingPos !== 'off' && (
            <div role="separator" onMouseDown={dragList} onDoubleClick={() => (readingPos === 'bottom' ? setListH(280) : setListW(360))}
              title="Drag to resize · double-click to reset"
              className={cn('shrink-0 relative bg-[var(--line-2)] hover:bg-[var(--accent)] transition-colors z-[2]',
                readingPos === 'bottom' ? 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1.5 before:-bottom-1.5' : 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5')} />
          )}
          {readingPos !== 'off' && (
            <section aria-label="Reading pane" className="flex-1 min-w-0 min-h-0">{reading(false)}</section>
          )}
        </div>

        {/* Vector task pane */}
        {taskOpen && (
          <>
            <div role="separator" onMouseDown={dragTask} title="Drag to resize"
              className="shrink-0 relative w-px bg-[var(--line-2)] hover:bg-[var(--accent)] cursor-col-resize transition-colors z-[2] before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5" />
            <aside ref={taskRef as React.RefObject<HTMLElement>} aria-label="Vector" className="shrink-0 min-h-0 flex flex-col bg-[var(--s1)]" style={{ width: taskW }}>
              <div className="shrink-0 flex items-center gap-1 pl-3 pr-1.5 h-11 border-b border-[var(--line)]">
                <Sparkles className="w-4 h-4 text-[var(--accent-text)]" />
                <span className="flex-1 text-[14px] font-semibold">Vector</span>
                <IconBtn icon={taskW > 520 ? Minimize2 : Maximize2} title={taskW > 520 ? 'Narrower' : 'Wider'} onClick={() => setTaskW(taskW > 520 ? 400 : 680)} />
                <IconBtn icon={X} title="Close the Vector pane" onClick={() => setTaskTabRaw('')} />
              </div>
              <div role="tablist" className="shrink-0 flex items-center gap-0.5 px-2 h-11 border-b border-[var(--line)] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {TASK_TABS.map(t => (
                  <button key={t.id} role="tab" aria-selected={taskOpen === t.id} onClick={() => openTask(t.id)}
                    className={cn('shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12.5px] transition-colors',
                      taskOpen === t.id ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] font-medium' : 'text-[var(--t2)] hover:bg-[var(--s-hover)] hover:text-[var(--t1)]')}>
                    <t.Icon className="w-3.5 h-3.5" />{t.label}{STRIPPED && t.ai && <Lock className="w-3 h-3 opacity-60" />}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {!liveDetail ? (
                  <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-[var(--t3)]">
                    {selectedId ? <Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" /> : <>
                      <Sparkles className="w-8 h-8 text-[var(--t4)]" strokeWidth={1.25} />
                      Select an email and Vector works on it here.
                    </>}
                  </div>
                ) : taskOpen === 'summary' ? (
                  <VectorSummary key={liveDetail.entryId} detail={liveDetail} toast={toast} setAppTab={setTab} />
                ) : taskOpen === 'pricer' ? (
                  <div className="p-3">
                    <InlineELPricer key={liveDetail.entryId} emailBody={liveDetail.body || ''} entryId={liveDetail.entryId} attachments={liveDetail.attachments}
                      toast={toast} setAppTab={setTab} subject={liveDetail.subject} emailList={displayEmails} storeId={_storeOf[liveDetail.entryId] || storeId} />
                  </div>
                ) : taskOpen === 'cbu' ? (
                  <div className="p-3"><InlineCBUGenerator key={liveDetail.entryId} emailSubject={liveDetail.subject} emailBody={liveDetail.body || ''} toast={toast} /></div>
                ) : taskOpen === 'quote' ? (
                  <QuickQuotePanel key={liveDetail.entryId} emailSubject={liveDetail.subject} emailBody={liveDetail.body || ''} senderName={liveDetail.sender} senderEmail={liveDetail.senderEmail} toast={toast} />
                ) : (
                  <div className="p-3"><CustomerHistoryPanel key={liveDetail.entryId} senderEmail={liveDetail.senderEmail} senderName={liveDetail.sender} toast={toast} /></div>
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────── */}
      <footer className="shrink-0 flex items-center gap-4 px-4 h-7 text-[11.5px] text-[var(--t3)] bg-[var(--s3)] border-t border-[var(--line-2)]">
        <span>Items: {emails.length}</span>
        <span>Unread: {unreadCount}</span>
        {loading && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Updating…</span>}
        {deep?.truncated && <span className="text-[var(--warn)]">Search hit its time limit — partial results</span>}
        <span className="flex-1" />
        {syncedLabel && <span>Updated {syncedLabel}</span>}
        <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[var(--ok)]" />Connected to Outlook</span>
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
      </footer>

      {/* ── Undo delete ──────────────────────────────────────────────────── */}
      {pendingDel && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-10 z-[9980] flex items-center gap-4 pl-4 pr-2 h-11 rounded-lg bg-[var(--t1)] text-[var(--bg)] text-[13px]" style={{ boxShadow: 'var(--pop-sh)' }}>
          <span className="truncate max-w-[340px]">Deleted “{pendingDel.label}”</span>
          <button onClick={undoDelete} className="h-8 px-3 rounded-md font-semibold text-[var(--accent)] hover:bg-white/10">Undo</button>
          <button aria-label="Dismiss" onClick={commitDelete} className="w-8 h-8 rounded-md flex items-center justify-center opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Menus ────────────────────────────────────────────────────────── */}
      {menu?.kind === 'row' && menuEmail && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} minWidth={240}>
          <MenuItem icon={Reply} label="Reply" hint="Ctrl+R" onClick={() => { setMenu(null); openCompose('reply'); }} disabled={!liveDetail} />
          <MenuItem icon={Forward} label="Forward" hint="Ctrl+F" onClick={() => { setMenu(null); openCompose('forward'); }} disabled={!liveDetail} />
          <MenuItem icon={Maximize2} label="Open in its own window" hint="Enter" onClick={() => { setMenu(null); setPopout(true); }} />
          <MenuSep />
          <MenuItem icon={Flag} label={flagged.has(menu.id) ? 'Clear flag' : 'Flag'} hint="Insert" onClick={() => { setMenu(null); toggleFlag(menu.id); }} />
          <MenuItem icon={Mail} label="Mark as unread" hint="Ctrl+U" disabled={menuEmail.unread} onClick={() => { setMenu(null); markUnread(menu.id); }} />
          <MenuLabel>Categorize</MenuLabel>
          <div className="px-3 pb-1.5 flex flex-wrap gap-1">
            {CATEGORIES.map(c => (
              <button key={c} onClick={() => { setMenu(null); categorize(menu.id, c); }}
                className={cn('h-6 px-2 rounded text-[11.5px] transition-colors',
                  categories[menu.id] === c ? 'bg-[var(--violet-soft)] text-[var(--violet)]' : 'bg-[var(--s3)] text-[var(--t2)] hover:text-[var(--t1)]')}>{c}</button>
            ))}
          </div>
          <MenuSep />
          <MenuLabel>Vector</MenuLabel>
          <MenuItem icon={Sparkles} label="Summarize" onClick={() => { setMenu(null); openTask('summary'); }} />
          <MenuItem icon={Zap} label="EL Pricer" onClick={() => { setMenu(null); openTask('pricer'); }} />
          <MenuItem icon={Battery} label="CBU Sheet" onClick={() => { setMenu(null); openTask('cbu'); }} />
          <MenuItem icon={FileDown} label="Quick Quote" onClick={() => { setMenu(null); openTask('quote'); }} />
          <MenuItem icon={HistoryIcon} label="Customer history" onClick={() => { setMenu(null); openTask('history'); }} />
          <MenuItem icon={Paperclip} label="Send a quote…" onClick={() => { setMenu(null); if (STRIPPED) toast('info', 'Send a quote is coming soon'); else setClassicId(menu.id); }} />
          <MenuSep />
          <MenuItem icon={ExternalLink} label="Open in Outlook" onClick={() => { setMenu(null); api.outlookOpenInOutlook(menu.id).catch(e => toast('err', failed('open the email in Outlook', e))); }} />
          <MenuItem icon={Wrench} label="Classic tools" onClick={() => { setMenu(null); setClassicId(menu.id); }} />
          <MenuSep />
          <MenuItem icon={Trash2} label="Delete" hint="Del" danger onClick={() => { const id = menu.id; setMenu(null); deleteEmail(id); }} />
        </FloatingMenu>
      )}
      {menu?.kind === 'categorize' && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} minWidth={200}>
          {CATEGORIES.map(c => (
            <MenuItem key={c} label={c} checked={categories[menu.id] === c} onClick={() => { setMenu(null); categorize(menu.id, c); }} />
          ))}
        </FloatingMenu>
      )}
      {menu?.kind === 'filter' && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} minWidth={200}>
          {(['inbox', 'unread', 'flagged', 'attachments'] as View[]).map(v => (
            <MenuItem key={v} label={v === 'inbox' ? 'All' : VIEW_LABEL[v]} checked={view === v} onClick={() => { setMenu(null); setView(v); }} />
          ))}
        </FloatingMenu>
      )}

      {/* ── Overlays ─────────────────────────────────────────────────────── */}
      {lightbox && <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />}

      {popout && selectedId && (
        <div className="fixed inset-0 z-[9960] bg-black/50 flex items-center justify-center p-3" onClick={e => { if (e.target === e.currentTarget) setPopout(false); }}>
          <div className="flex flex-col bg-[var(--s1)] rounded-xl overflow-hidden ring-1 ring-inset ring-[var(--line-2)]"
            style={{ width: 'min(96vw, 1280px)', height: 'min(95vh, 1200px)', boxShadow: 'var(--pop-sh)' }}>
            <div className="shrink-0 flex items-center gap-1 px-2 h-12 border-b border-[var(--line-2)] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              <RBtn icon={Reply} label="Reply" disabled={!liveDetail} onClick={() => openCompose('reply')} />
              <RBtn icon={Forward} label="Forward" disabled={!liveDetail} onClick={() => openCompose('forward')} />
              <RSep />
              <RBtn icon={Trash2} label="Delete" danger onClick={() => { setPopout(false); deleteEmail(selectedId); }} />
              <RBtn icon={Flag} label={isFlagged ? 'Unflag' : 'Flag'} active={isFlagged} onClick={() => toggleFlag(selectedId)} />
              <RSep />
              <RBtn icon={Sparkles} label="Vector pane" onClick={() => { setPopout(false); openTask('summary'); }} locked={STRIPPED} />
              <span className="flex-1" />
              <IconBtn icon={X} title="Close (Esc)" onClick={() => setPopout(false)} />
            </div>
            <div className="flex-1 min-h-0">{reading(true)}</div>
          </div>
        </div>
      )}

      {classicId && (
        <div className="fixed inset-0 z-[9960] bg-black/50 flex items-center justify-center p-3" onClick={e => { if (e.target === e.currentTarget) setClassicId(null); }}>
          <div className="flex flex-col bg-[var(--s1)] rounded-xl overflow-hidden ring-1 ring-inset ring-[var(--line-2)]"
            style={{ width: 'min(96vw, 1280px)', height: 'min(95vh, 1200px)', boxShadow: 'var(--pop-sh)' }}>
            <div className="shrink-0 flex items-center gap-2 pl-4 pr-2 h-11 border-b border-[var(--line-2)]">
              <Wrench className="w-4 h-4 text-[var(--t3)]" />
              <span className="flex-1 text-[13px] font-semibold truncate">Classic tools — {(emails.find(e => e.entryId === classicId) || selected)?.subject || ''}</span>
              <IconBtn icon={X} title="Close" onClick={() => setClassicId(null)} />
            </div>
            <div className="flex-1 min-h-0">
              <EmailDetailPanel initialEntryId={classicId} emailList={displayEmails} toast={toast} setAppTab={setTab}
                onMarkRead={() => {}} onLabelChange={() => {}} storeId={_storeOf[classicId] || storeId} />
            </div>
          </div>
        </div>
      )}

      {composeNew && <ComposeModal onClose={() => setComposeNew(false)} toast={toast} />}
    </div>
  );
}
