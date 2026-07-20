// ─── AI Assistant page ────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Send, Trash2, Copy, Check, Loader2, AlertCircle,
  Mail, ClipboardList, Zap, HelpCircle, ChevronRight, CornerDownLeft,
  MessageSquare, Plus, Search, ExternalLink, FolderOpen, X, FileText, User,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { relTime } from '../lib/ui';
import type { ToastFn } from '../App';
import type { DqDoc } from '../types';

const CONVS_KEY  = 'mu_assistant_convs';
const ACTIVE_KEY = 'mu_assistant_active';
let _mid = Date.now();

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  isEmail?: boolean;
  ts: number;
  results?: DqDoc[];                                    // quote/file cards from a smart search
  meta?: { count: number; scope: string; term: string }; // search summary header
}

interface Conversation {
  id: string;
  title: string;
  ts: number;
  messages: Message[];
}

// ─── Quick prompts ────────────────────────────────────────────────────────────
const QUICK_PROMPTS: Array<{
  label: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  prompt: string;
  emailHint?: true;
  quoteSearch?: true;
}> = [
  {
    label: 'Search for a Quote',
    sub: 'Find your quotes by customer, KVA or fitting — searches inside the quote',
    icon: Search,
    prompt: '',
    quoteSearch: true,
  },
  {
    label: 'Paste an email',
    sub: 'I\'ll figure out what needs to be done',
    icon: Mail,
    prompt: '',
    emailHint: true,
  },
  {
    label: 'Walk me through PMO',
    sub: 'Step-by-step from PO to Word doc',
    icon: ClipboardList,
    prompt: 'Walk me through raising a PMO step by step, starting from receiving a customer PO.',
  },
  {
    label: "What's in my queue?",
    sub: 'Live summary of queued files',
    icon: Zap,
    prompt: "What's in my PDF queue right now? Give me a summary and tell me what to do next.",
  },
  {
    label: 'Fix FedAuth error',
    sub: 'Reconnect cookies to SharePoint',
    icon: HelpCircle,
    prompt: 'How do I fix a FedAuth or cookie expired error when connecting to JOE?',
  },
  {
    label: 'Last failed job',
    sub: 'What went wrong and how to fix it',
    icon: AlertCircle,
    prompt: 'What went wrong with the last failed job? Explain the error and what I should do.',
  },
  {
    label: 'Run Step 1 guide',
    sub: 'Extract PDFs and push to SharePoint',
    icon: ChevronRight,
    prompt: 'Walk me through running Step 1 from scratch — what do I need to prepare and what could go wrong?',
  },
];

// ─── Email detection ──────────────────────────────────────────────────────────
function looksLikeEmail(text: string) {
  if (text.length < 80) return false;
  const signals = [
    /from:\s*\S/i,
    /to:\s*\S/i,
    /subject:/i,
    /dear\s+\w/i,
    /(regards|sincerely|best wishes|thanks|cheers),?\s*[\r\n]/i,
    /\S+@[a-z0-9.-]+\.[a-z]{2,}/i,
  ];
  return signals.filter(p => p.test(text)).length >= 2;
}

// ─── Markdown renderer ────────────────────────────────────────────────────────
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let ulBuf: string[] = [];
  let olBuf: string[] = [];
  let codeBuf: string[] = [];
  let inCode = false;

  const flushUl = () => {
    if (!ulBuf.length) return;
    out.push(
      <ul key={out.length} className="my-1.5 space-y-1 pl-0.5">
        {ulBuf.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] text-ink-700 dark:text-ink-200 leading-relaxed">
            <span className="text-violet-400 shrink-0 select-none mt-0.5">•</span>
            <span>{inlineRender(item)}</span>
          </li>
        ))}
      </ul>,
    );
    ulBuf = [];
  };
  const flushOl = () => {
    if (!olBuf.length) return;
    out.push(
      <ol key={out.length} className="my-1.5 space-y-1 pl-0.5">
        {olBuf.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] text-ink-700 dark:text-ink-200 leading-relaxed">
            <span className="text-violet-500 font-semibold shrink-0 w-4 text-right mt-0.5 select-none">{i + 1}.</span>
            <span>{inlineRender(item)}</span>
          </li>
        ))}
      </ol>,
    );
    olBuf = [];
  };
  const flushCode = () => {
    if (!codeBuf.length) return;
    out.push(
      <pre key={out.length} className="my-2 px-3 py-2.5 rounded-lg bg-ink-900 dark:bg-ink-950 text-[11px] text-emerald-300 font-mono overflow-x-auto leading-relaxed">
        {codeBuf.join('\n')}
      </pre>,
    );
    codeBuf = [];
  };

  for (const line of lines) {
    const raw = line.trim();
    if (raw.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushUl(); flushOl(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (!raw) { flushUl(); flushOl(); out.push(<div key={out.length} className="h-1.5" />); continue; }
    if (/^---+$/.test(raw)) { flushUl(); flushOl(); out.push(<hr key={out.length} className="my-3 border-violet-200/60 dark:border-violet-800/40" />); continue; }
    if (raw.startsWith('### ')) { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[12px] font-bold mt-3 mb-0.5 text-ink-800 dark:text-ink-100">{inlineRender(raw.slice(4))}</p>); continue; }
    if (raw.startsWith('## '))  { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[13px] font-bold mt-3 mb-0.5 text-ink-800 dark:text-ink-100">{inlineRender(raw.slice(3))}</p>); continue; }
    if (raw.startsWith('# '))   { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[14px] font-bold mt-3 mb-1   text-ink-800 dark:text-ink-100">{inlineRender(raw.slice(2))}</p>); continue; }
    if (/^[-*•]\s/.test(raw))  { flushOl(); ulBuf.push(raw.replace(/^[-*•]\s+/, '')); continue; }
    if (/^\d+\.\s/.test(raw))  { flushUl(); olBuf.push(raw.replace(/^\d+\.\s+/, '')); continue; }
    flushUl(); flushOl();
    out.push(<p key={out.length} className="text-[12.5px] text-ink-700 dark:text-ink-200 leading-relaxed">{inlineRender(raw)}</p>);
  }
  flushUl(); flushOl(); flushCode();
  return <div className="space-y-0.5">{out}</div>;
}

function inlineRender(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={m.index} className="font-semibold text-ink-900 dark:text-ink-50">{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} className="px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-[11px] font-mono text-brand-600 dark:text-brand-300">{m[4]}</code>);
    else if (m[5]) parts.push(<img key={m.index} src={m[7]} alt={m[6]} className="inline-block max-h-32 rounded border border-ink-200 dark:border-ink-700" />);
    else if (m[8]) parts.push(<a key={m.index} href={m[10]} target="_blank" rel="noopener noreferrer" className="text-violet-600 dark:text-violet-300 underline underline-offset-2 hover:text-violet-800 dark:hover:text-violet-100">{m[9]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ─── Quote/file result card — shared by the chat and the search modal ─────────
// Renders as a link when the doc has a URL (D&Q files); salesman/metadata cards
// have no direct file URL, so they render as a plain (non-clickable) card.
function QuoteResultCard({ doc }: { doc: DqDoc }) {
  const isMail = ['msg', 'eml'].includes(doc.ext);
  const Icon = isMail ? Mail : FileText;
  const linked = !!doc.url;
  const Tag: any = linked ? 'a' : 'div';
  const linkProps = linked ? { href: doc.url, target: '_blank', rel: 'noopener noreferrer' } : {};
  return (
    <Tag
      {...linkProps}
      className={cn(
        'group flex items-start gap-3 p-3.5 rounded-xl bg-ink-50/70 dark:bg-ink-800/50 ring-1 ring-inset ring-ink-200/60 dark:ring-ink-700/40 transition-all',
        linked && 'hover:bg-brand-50/60 dark:hover:bg-brand-900/20 hover:ring-brand-200 dark:hover:ring-brand-700/40',
      )}>
      <div className="w-8 h-8 rounded-lg bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-[12.5px] font-semibold text-ink-800 dark:text-ink-100 leading-snug truncate">{doc.title || doc.filename}</p>
          {doc.ext && (
            <span className="text-[9px] uppercase font-semibold px-1 py-0.5 rounded bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 shrink-0">{doc.ext}</span>
          )}
        </div>
        {doc.summary && (
          <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5 line-clamp-2 leading-snug">{doc.summary}</p>
        )}
        {(doc.author || doc.modified) && (
          <p className="text-[10px] text-ink-400 dark:text-ink-500 mt-0.5">
            {doc.author}{doc.author && doc.modified ? ' · ' : ''}{doc.modified ? relTime(doc.modified) : ''}
          </p>
        )}
      </div>
      {linked && (
        <ExternalLink className="w-3.5 h-3.5 text-ink-300 group-hover:text-brand-500 dark:group-hover:text-brand-400 transition-colors shrink-0 mt-1" />
      )}
    </Tag>
  );
}

// ─── Thinking phrases — rotates status text so the wait isn't a blank stare ───
const THINKING_PHRASES = [
  'Reading your message…',
  'Working out what you need…',
  'Searching your quotes…',
  'Digging through the D&Q index…',
  'Pulling the details together…',
  'Almost there…',
];
function ThinkingPhrases() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI(p => Math.min(p + 1, THINKING_PHRASES.length - 1)), 1500);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-[11.5px] text-ink-400 dark:text-ink-500 italic transition-opacity">
      {THINKING_PHRASES[i]}
    </span>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function Bubble({ msg, onCopy }: { msg: Message; onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === 'user';

  function handleCopy() {
    navigator.clipboard.writeText(msg.text).then(() => {
      setCopied(true);
      onCopy();
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className={cn('flex gap-3 group', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar — AI only */}
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-200 dark:ring-violet-800/50 flex items-center justify-center shrink-0 mt-1">
          <Sparkles className="w-3.5 h-3.5 text-violet-500" />
        </div>
      )}

      <div className={cn('max-w-[78%] flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        {/* Email badge */}
        {msg.isEmail && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/30 px-2 py-0.5 rounded-full mb-0.5">
            <Mail className="w-3 h-3" /> Email detected — analysing…
          </span>
        )}

        {/* Bubble body */}
        <div className={cn(
          'rounded-2xl px-4 py-2.5',
          isUser
            ? 'bg-ink-900 dark:bg-white text-white dark:text-ink-900 rounded-tr-sm'
            : 'bg-white dark:bg-ink-800/70 ring-1 ring-inset ring-ink-200/80 dark:ring-ink-700/50 shadow-sm rounded-tl-sm',
        )}>
          {isUser
            ? <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
            : <Markdown text={msg.text} />}
        </div>

        {/* Smart-search result cards */}
        {!isUser && msg.results && msg.results.length > 0 && (
          <div className="mt-1.5 w-full space-y-2">
            {msg.meta && (
              <p className="text-[10.5px] text-ink-400 dark:text-ink-500 px-0.5">
                {msg.meta.count} match{msg.meta.count !== 1 ? 'es' : ''} for “{msg.meta.term}” · {msg.meta.scope}
                {msg.results.length < msg.meta.count ? ` · showing top ${msg.results.length}` : ''}
              </p>
            )}
            {msg.results.map((doc, i) => <QuoteResultCard key={i} doc={doc} />)}
          </div>
        )}

        {/* Actions row — visible on hover */}
        <div className={cn(
          'flex items-center gap-2.5 opacity-0 group-hover:opacity-100 transition-opacity px-1',
          isUser ? 'flex-row-reverse' : 'flex-row',
        )}>
          <button onClick={handleCopy}
            className="flex items-center gap-1 text-[10.5px] text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 transition-colors">
            {copied
              ? <><Check className="w-3 h-3 text-emerald-500" /> Copied</>
              : <><Copy className="w-3 h-3" /> Copy</>}
          </button>
          <span className="text-[10px] text-ink-300 dark:text-ink-600">
            {new Date(msg.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Smart query cleanup ──────────────────────────────────────────────────────
// Strip conversational filler so "quotes from Joe Bayley" → "Joe Bayley" and
// "find me the 4kva quote" → "4kva". Catalog tokens / names are left untouched.
const FILLER = new Set([
  'find', 'show', 'me', 'search', 'searches', 'quote', 'quotes', 'for', 'from',
  'the', 'all', 'with', 'any', 'please', 'list', 'get', 'give', 'my', 'mine',
  'inside', 'containing', 'contains', 'contain', 'has', 'have', 'that', 'of',
  'a', 'an', 'uploaded', 'upload', 'about', 'where', 'which', 'i', 'did', 'made',
]);
function cleanQuery(s: string) {
  const cleaned = s.trim().split(/\s+/).filter(w => !FILLER.has(w.toLowerCase())).join(' ');
  return cleaned || s.trim();   // fall back to raw if everything was filler
}

// ─── Quote Search Panel — smart, content-aware, scoped to my quotes ───────────
function QuoteSearchPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ]             = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DqDoc[]>([]);
  const [error, setError]     = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [mineOnly, setMineOnly] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function search(mine = mineOnly) {
    const term = cleanQuery(q);
    if (!term || loading) return;
    setLoading(true); setError(null); setResults([]); setSearched(true);
    try {
      const r = await api.dqSearch(term, mine);
      if (r.error) setError(r.error);
      else setResults(r.results || []);
    } catch (e: any) {
      setError(e.message || 'Search failed');
    }
    setLoading(false);
  }

  function toggleMine(next: boolean) {
    setMineOnly(next);
    if (searched && q.trim()) search(next);
  }

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="w-full max-w-2xl bg-white dark:bg-ink-900 rounded-2xl shadow-2xl ring-1 ring-inset ring-ink-200 dark:ring-ink-700 flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-200/70 dark:border-ink-800">
          <div className="w-8 h-8 rounded-lg bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
            <FolderOpen className="w-4 h-4 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold">{mineOnly ? 'Search my quotes' : 'Search the D&Q Store'}</p>
            <p className="text-[11px] text-ink-400 dark:text-ink-500">Customer, KVA, or catalog/fitting — searches inside the quote, not just the name</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search input */}
        <div className="px-5 py-3 border-b border-ink-100 dark:border-ink-800">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-lg bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 focus-within:ring-brand-400/70">
              <Search className="w-3.5 h-3.5 text-ink-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search(); }}
                placeholder="e.g.  quotes from Joe Bayley,  4kva,  ACM1,  EC141"
                className="flex-1 bg-transparent text-[12.5px] text-ink-900 dark:text-ink-50 placeholder:text-ink-400 outline-none min-w-0"
              />
              {q && <button onClick={() => setQ('')} className="text-ink-400 hover:text-ink-600 dark:hover:text-ink-200 shrink-0"><X className="w-3 h-3" /></button>}
            </div>
            <button
              onClick={() => search()}
              disabled={loading || !q.trim()}
              className="h-9 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-[12px] font-semibold flex items-center gap-1.5 transition-colors shrink-0">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Search
            </button>
          </div>

          {/* Mine-only toggle */}
          <div className="flex items-center gap-2 mt-2.5">
            <button onClick={() => toggleMine(!mineOnly)}
              title={mineOnly ? 'Showing only quotes you uploaded — click to search everyone’s' : 'Searching everyone’s quotes — click to show only yours'}
              className={cn(
                'h-6 px-2 rounded-md text-[10.5px] font-medium flex items-center gap-1.5 ring-1 ring-inset transition-colors',
                mineOnly
                  ? 'bg-brand-50 dark:bg-brand-900/30 ring-brand-200 dark:ring-brand-700/50 text-brand-700 dark:text-brand-300'
                  : 'ring-ink-200 dark:ring-ink-700 text-ink-500 hover:bg-ink-50 dark:hover:bg-ink-800',
              )}>
              <User className="w-3 h-3" />
              Mine only
              {mineOnly && <Check className="w-3 h-3" />}
            </button>
            <span className="text-[10px] text-ink-400 dark:text-ink-500">Searches the full text of each quote, not just its name.</span>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {/* Error */}
          {error && (
            <div className="mx-5 mt-4 flex gap-2.5 items-center px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 ring-1 ring-inset ring-red-200 dark:ring-red-700/40 text-[12px] text-red-700 dark:text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Result count */}
          {searched && !loading && !error && (
            <p className="px-5 pt-3 pb-1 text-[10.5px] text-ink-400 dark:text-ink-500">
              {results.length === 0
                ? (mineOnly ? 'No quotes you uploaded matched — try turning off “Mine only”.' : 'No matches found')
                : `${results.length} match${results.length !== 1 ? 'es' : ''}`}
            </p>
          )}

          {/* Result cards */}
          <div className="px-5 pb-5 pt-2 space-y-2">
            {results.map((r, i) => <QuoteResultCard key={i} doc={r} />)}

            {/* Empty + idle */}
            {!loading && !error && !searched && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <div className="w-12 h-12 rounded-2xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center">
                  <FolderOpen className="w-5 h-5 text-ink-400" />
                </div>
                <p className="text-[12px] text-ink-400 dark:text-ink-500 text-center max-w-xs">
                  Try a customer (“Joe Bayley”), a rating (“4kva”), or a catalog number (“ACM1”, “EC141”)
                </p>
              </div>
            )}

            {/* Loading skeleton */}
            {loading && (
              <div className="space-y-2 pt-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 rounded-xl bg-ink-100 dark:bg-ink-800/60 animate-pulse" />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function AssistantPage({
  connected,
  toast,
}: {
  connected: boolean;
  toast: ToastFn;
}) {
  // ── Conversation state ───────────────────────────────────────────────────
  const [convs, setConvs] = useState<Conversation[]>(() => {
    try { return JSON.parse(localStorage.getItem(CONVS_KEY) || '[]'); }
    catch { return []; }
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = localStorage.getItem(ACTIVE_KEY);
    if (stored) return stored;
    return genId();
  });

  // Derive messages from active conversation
  const messages: Message[] = convs.find(c => c.id === activeId)?.messages ?? [];

  const [input, setInput]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [quoteSearchOpen, setQuoteSearchOpen] = useState(false);

  // ── Side SharePoint search (real D&Q index) ──────────────────────────────
  const [searchQ, setSearchQ]         = useState('');
  const [searchRes, setSearchRes]     = useState<DqDoc[] | null>(null);
  const [searching, setSearching]     = useState(false);
  async function runSearch() {
    const q = searchQ.trim();
    if (!q) { setSearchRes(null); return; }
    setSearching(true); setSearchRes(null);
    try { const r = await api.dqSearch(q); setSearchRes(r.results || []); }
    catch { setSearchRes([]); }
    setSearching(false);
  }

  const endRef       = useRef<HTMLDivElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const historyRef   = useRef<HTMLDivElement>(null);

  // Persist activeId
  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  // Persist convs
  useEffect(() => {
    localStorage.setItem(CONVS_KEY, JSON.stringify(convs));
  }, [convs]);

  // Scroll to bottom on new message
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Check AI key
  useEffect(() => {
    api.aiStatus().then(r => setAiAvailable(r.available)).catch(() => setAiAvailable(false));
  }, []);

  // Close history panel on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (historyOpen && historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [historyOpen]);

  // Auto-resize textarea
  function resize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  // Helper: upsert a conversation
  function upsertConv(updated: Conversation) {
    setConvs(prev => {
      const exists = prev.some(c => c.id === updated.id);
      const next = exists
        ? prev.map(c => c.id === updated.id ? updated : c)
        : [updated, ...prev];
      return next.sort((a, b) => b.ts - a.ts).slice(0, 30);
    });
  }

  // New conversation
  function newChat() {
    const id = genId();
    setActiveId(id);
    setHistoryOpen(false);
    setInput('');
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  // Switch to a conversation
  function switchConv(id: string) {
    setActiveId(id);
    setHistoryOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  // Delete a conversation
  function deleteConv(id: string) {
    setConvs(prev => prev.filter(c => c.id !== id));
    if (id === activeId) {
      const remaining = convs.filter(c => c.id !== id);
      if (remaining.length > 0) {
        setActiveId(remaining[0].id);
      } else {
        setActiveId(genId());
      }
    }
  }

  // Send message
  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || loading || !aiAvailable) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsg: Message = {
      id: ++_mid,
      role: 'user',
      text: q,
      isEmail: looksLikeEmail(q),
      ts: Date.now(),
    };

    const currentConv = convs.find(c => c.id === activeId);
    const prevMessages = currentConv?.messages ?? [];
    const updatedMsgsWithUser = [...prevMessages, userMsg];

    // Optimistically update messages
    const convAfterUser: Conversation = {
      id: activeId,
      title: currentConv?.title || (q.slice(0, 40) + (q.length > 40 ? '…' : '')),
      ts: Date.now(),
      messages: updatedMsgsWithUser,
    };
    upsertConv(convAfterUser);

    setLoading(true);

    try {
      const history = prevMessages.slice(-12).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        text: m.text,
      }));
      const r = await api.quoteAsk(q, history);
      const aiMsg: Message = {
        id: ++_mid,
        role: 'assistant',
        text: r.answer || r.error || 'No response.',
        ts: Date.now(),
        results: r.results && r.results.length ? r.results : undefined,
        meta: r.meta,
      };
      const finalMessages = [...updatedMsgsWithUser, aiMsg];
      const finalConv: Conversation = {
        id: activeId,
        title: convAfterUser.title,
        ts: Date.now(),
        messages: finalMessages,
      };
      upsertConv(finalConv);
    } catch (e: unknown) {
      const errText = e instanceof Error ? e.message : String(e);
      const aiMsg: Message = {
        id: ++_mid,
        role: 'assistant',
        text: `Sorry, something went wrong: ${errText}`,
        ts: Date.now(),
      };
      const finalMessages = [...updatedMsgsWithUser, aiMsg];
      const finalConv: Conversation = {
        id: activeId,
        title: convAfterUser.title,
        ts: Date.now(),
        messages: finalMessages,
      };
      upsertConv(finalConv);
    }

    setLoading(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  // Clear active conversation messages (keep it in list but wipe messages)
  function clear() {
    const current = convs.find(c => c.id === activeId);
    if (!current) return;
    upsertConv({ ...current, messages: [], ts: Date.now() });
    toast('info', 'Conversation cleared');
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  const isEmpty = messages.length === 0;

  return (
    // Break out of the parent p-6 to fill the full content area; 2-column shell:
    // chat (left) + SharePoint search panel (right).
    <div className="-mx-6 -my-6 flex bg-ink-50 dark:bg-ink-950" style={{ height: 'calc(100vh - 56px)' }}>

      {/* ── Chat column ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-ink-200/70 dark:border-ink-800">

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-5 py-2.5 bg-white dark:bg-ink-900 border-b border-ink-200/70 dark:border-ink-800">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <div className="leading-none">
            <p className="text-[13px] font-semibold">Ask Vector</p>
            <p className="text-[10.5px] text-ink-400 dark:text-ink-500 mt-0.5">One AI brain · knows your app, quotes & Fenton's EL guidance</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cn(
            'hidden sm:inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-0.5 rounded-full ring-1 ring-inset',
            connected
              ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 ring-emerald-200 dark:ring-emerald-700/30'
              : 'bg-ink-100 dark:bg-ink-800 text-ink-500 ring-ink-200 dark:ring-ink-700',
          )}>
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', connected ? 'bg-emerald-500' : 'bg-ink-400')} />
            {connected ? 'SharePoint connected' : 'SharePoint disconnected'}
          </span>

          {!aiAvailable && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-0.5 rounded-full ring-1 ring-inset bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 ring-amber-200 dark:ring-amber-700/30">
              <AlertCircle className="w-3 h-3" /> No Gemini key
            </span>
          )}

          {messages.length > 0 && (
            <button onClick={clear}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-ink-500 hover:text-red-600 dark:hover:text-red-400 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 hover:ring-red-200 dark:hover:ring-red-700/40 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          )}

          {/* History toggle button */}
          <div className="relative" ref={historyRef}>
            <button
              onClick={() => setHistoryOpen(o => !o)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium ring-1 ring-inset transition-colors',
                historyOpen
                  ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 ring-violet-200 dark:ring-violet-700/40'
                  : 'text-ink-500 ring-ink-200 dark:ring-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800',
              )}>
              <MessageSquare className="w-3.5 h-3.5" />
              {convs.length > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-violet-500 text-white text-[9px] font-bold leading-none">
                  {convs.length}
                </span>
              )}
            </button>

            {/* History dropdown panel */}
            {historyOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-80 z-50 rounded-xl bg-white dark:bg-ink-900 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 shadow-lg overflow-hidden">
                {/* New chat button */}
                <div className="p-2 border-b border-ink-100 dark:border-ink-800">
                  <button
                    onClick={newChat}
                    className="w-full flex items-center justify-center gap-2 h-8 rounded-lg bg-violet-500 hover:bg-violet-600 text-white text-[12px] font-semibold transition-colors">
                    <Plus className="w-3.5 h-3.5" /> New chat
                  </button>
                </div>

                {/* Conversation list */}
                <div className="max-h-80 overflow-y-auto py-1">
                  {convs.length === 0 ? (
                    <p className="px-3 py-4 text-center text-[11.5px] text-ink-400 dark:text-ink-500">No conversations yet</p>
                  ) : (
                    convs.map(conv => (
                      <div
                        key={conv.id}
                        onClick={() => switchConv(conv.id)}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors',
                          conv.id === activeId
                            ? 'bg-violet-50 dark:bg-violet-900/20'
                            : 'hover:bg-ink-50 dark:hover:bg-ink-800/60',
                        )}>
                        <div className="min-w-0 flex-1">
                          <p className={cn(
                            'text-[13px] font-medium truncate leading-snug',
                            conv.id === activeId
                              ? 'text-violet-700 dark:text-violet-300'
                              : 'text-ink-700 dark:text-ink-200',
                          )}>
                            {conv.title || 'New conversation'}
                          </p>
                          <p className="text-[10.5px] text-ink-400 dark:text-ink-500 mt-0.5">
                            {relTime(new Date(conv.ts).toISOString())}
                            {conv.messages.length > 0 && ` · ${conv.messages.length} msg${conv.messages.length !== 1 ? 's' : ''}`}
                          </p>
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); deleteConv(conv.id); }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-ink-300 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Clear all */}
                {convs.length > 0 && (
                  <div className="p-2 border-t border-ink-100 dark:border-ink-800">
                    <button
                      onClick={() => {
                        setConvs([]);
                        setActiveId(genId());
                        setHistoryOpen(false);
                      }}
                      className="w-full text-center text-[11px] text-ink-400 hover:text-red-500 dark:hover:text-red-400 transition-colors py-1">
                      Clear all conversations
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Messages ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          /* ── Welcome state ── */
          <div className="flex flex-col items-center justify-center h-full px-6 py-10 text-center">
            <div className="w-14 h-14 rounded-2xl bg-violet-100 dark:bg-violet-900/30 ring-1 ring-inset ring-violet-200 dark:ring-violet-800/40 flex items-center justify-center mb-5 shadow-sm">
              <Sparkles className="w-6 h-6 text-violet-500" />
            </div>
            <h2 className="text-[16px] font-semibold text-ink-900 dark:text-ink-50 mb-2">
              What can I help with?
            </h2>
            <p className="text-[13px] text-ink-500 dark:text-ink-400 max-w-[420px] leading-relaxed">
              Ask anything about your workflow, or paste an email and I'll figure out exactly what needs to be done.
            </p>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 w-full max-w-2xl">
              {QUICK_PROMPTS.map(p => (
                <button key={p.label}
                  onClick={() => {
                    if (p.quoteSearch) { setQuoteSearchOpen(true); }
                    else if (p.emailHint) { textareaRef.current?.focus(); }
                    else { send(p.prompt); }
                  }}
                  className={cn(
                    'flex items-start gap-3 px-3.5 py-3 rounded-xl ring-1 ring-inset text-left transition-all group shadow-sm',
                    p.quoteSearch
                      ? 'bg-brand-50/60 dark:bg-brand-900/20 ring-brand-200 dark:ring-brand-700/40 hover:ring-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30'
                      : 'bg-white dark:bg-ink-900 ring-ink-200 dark:ring-ink-800 hover:ring-violet-300 dark:hover:ring-violet-600/60 hover:bg-violet-50/60 dark:hover:bg-violet-900/10',
                  )}>
                  <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 transition-colors',
                    p.quoteSearch
                      ? 'bg-brand-100 dark:bg-brand-900/50 group-hover:bg-brand-200 dark:group-hover:bg-brand-800/60'
                      : 'bg-violet-100 dark:bg-violet-900/50 group-hover:bg-violet-200 dark:group-hover:bg-violet-800/60',
                  )}>
                    <p.icon className={cn('w-3.5 h-3.5', p.quoteSearch ? 'text-brand-600 dark:text-brand-400' : 'text-violet-500')} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold text-ink-800 dark:text-ink-100 leading-snug">{p.label}</p>
                    <p className="text-[11px] text-ink-400 dark:text-ink-500 mt-0.5 leading-snug">{p.sub}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Conversation ── */
          <div className="px-5 py-5 space-y-5 w-full max-w-3xl mx-auto">
            {messages.map(msg => (
              <Bubble key={msg.id} msg={msg} onCopy={() => toast('ok', 'Copied to clipboard')} />
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-200 dark:ring-violet-800/50 flex items-center justify-center shrink-0 mt-1">
                  <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin" />
                </div>
                <div className="bg-white dark:bg-ink-800/70 ring-1 ring-inset ring-ink-200/80 dark:ring-ink-700/50 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                  <div className="flex gap-2.5 items-center h-4">
                    <div className="flex gap-1.5 items-center shrink-0">
                      {[0, 1, 2].map(i => (
                        <span key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                          style={{ animationDelay: `${i * 160}ms` }} />
                      ))}
                    </div>
                    <ThinkingPhrases />
                  </div>
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* ── Input area ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-ink-200/70 dark:border-ink-800 bg-white dark:bg-ink-900 px-5 pt-3.5 pb-4">

        {/* Quick prompt chips — shown inside conversation */}
        {!isEmpty && (
          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-0.5 -mx-1 px-1 scrollbar-none">
            {/* Quote search chip — always enabled */}
            <button
              onClick={() => setQuoteSearchOpen(true)}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 bg-brand-50 dark:bg-brand-900/30 ring-1 ring-inset ring-brand-200 dark:ring-brand-700/40 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-900/50 transition-colors">
              <Search className="w-3 h-3 shrink-0" />
              Search for a Quote
            </button>
            {QUICK_PROMPTS.filter(p => !p.emailHint && !p.quoteSearch).map(p => (
              <button key={p.label}
                disabled={loading || !aiAvailable}
                onClick={() => send(p.prompt)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-ink-600 dark:text-ink-300 hover:bg-violet-50 dark:hover:bg-violet-900/20 hover:ring-violet-200 dark:hover:ring-violet-700/40 hover:text-violet-700 dark:hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <p.icon className="w-3 h-3 shrink-0" />
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* No API key warning */}
        {!aiAvailable && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/30 text-[11.5px] text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            No Gemini API key — go to <strong className="mx-0.5">Settings</strong> and add your key.
          </div>
        )}

        <div className="flex gap-2 items-end">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              disabled={loading || !aiAvailable}
              placeholder={isEmpty ? 'Ask anything, or paste an email…' : 'Follow up…'}
              onChange={e => { setInput(e.target.value); resize(); }}
              onPaste={() => setTimeout(resize, 0)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              className="w-full resize-none rounded-xl px-4 py-2.5 pr-20 bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-[13px] text-ink-900 dark:text-ink-50 placeholder:text-ink-400 focus:outline-none focus:ring-violet-300 dark:focus:ring-violet-600 disabled:opacity-50 leading-relaxed overflow-y-auto"
              style={{ maxHeight: 200 }}
            />
            {/* Hint overlay */}
            <div className="absolute right-3 bottom-2.5 flex items-center gap-0.5 text-[10px] text-ink-300 dark:text-ink-600 pointer-events-none select-none">
              <CornerDownLeft className="w-3 h-3" />
              <span>Send</span>
            </div>
          </div>

          <button
            onClick={() => send()}
            disabled={loading || !input.trim() || !aiAvailable}
            className="h-10 w-10 rounded-xl bg-violet-500 hover:bg-violet-600 active:scale-95 text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0 shadow-sm">
            {loading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Send className="w-4 h-4" />}
          </button>
        </div>

        <p className="mt-2 text-center text-[10px] text-ink-300 dark:text-ink-600 select-none">
          Shift+Enter for new line · history saved locally
        </p>
      </div>
      </div>{/* end chat column */}

      {/* ── SharePoint search column ────────────────────────────────────────── */}
      <aside className="hidden lg:flex w-[340px] shrink-0 flex-col bg-white dark:bg-ink-900">
        <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b border-ink-200/70 dark:border-ink-800">
          <Search className="w-3.5 h-3.5 text-ink-400" />
          <span className="text-[13px] font-semibold flex-1">SharePoint search</span>
        </div>
        <div className="shrink-0 flex gap-2 px-4 py-3 border-b border-ink-200/70 dark:border-ink-800">
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
            placeholder="SR number, customer, title…"
            className="flex-1 h-8 px-2.5 rounded-md text-[12px] bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 focus:ring-brand-400 focus:outline-none" />
          <button onClick={runSearch} disabled={searching}
            className="h-8 px-3 rounded-lg text-[11.5px] font-semibold bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-800 dark:hover:bg-ink-100 disabled:opacity-50 transition-colors">
            Search
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {searching ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-ink-300" /></div>
          ) : searchRes === null ? (
            <p className="text-[11.5px] text-ink-400 text-center py-10 px-4">
              {connected ? 'Search the D&Q Store — try a customer, SR number, kVA rating or fitting code.' : 'Connect to JOE to search SharePoint.'}
            </p>
          ) : searchRes.length === 0 ? (
            <p className="text-[11.5px] text-ink-400 text-center py-10">No results.</p>
          ) : (
            <div className="space-y-2">
              {searchRes.map((d, i) => <QuoteResultCard key={i} doc={d} />)}
            </div>
          )}
        </div>
      </aside>

      {/* Quote search modal */}
      {quoteSearchOpen && <QuoteSearchPanel onClose={() => setQuoteSearchOpen(false)} />}
    </div>
  );
}
