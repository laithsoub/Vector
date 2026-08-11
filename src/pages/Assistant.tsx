// ─── AI Assistant page ────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Send, Trash2, Copy, Check, Loader2, AlertCircle,
  Mail, ClipboardList, Zap, HelpCircle, ChevronRight, CornerDownLeft,
  MessageSquare, Plus, Search, ExternalLink, FolderOpen, X, FileText, User,
  Download,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { relTime } from '../lib/ui';
import { exportAnswer, EXPORT_FORMATS, type ExportFormat } from '../lib/export';
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
  suggestions?: string[];                               // AI quick-action offers (clickable chips)
  title?: string;                                       // AI topic title (used to name exports)
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

// ─── Fallback export title — derive a topic when the AI didn't supply one ───────
function deriveTitle(text: string): string {
  const t = text || '';
  const h = t.match(/^#{1,6}\s+(.+)$/m);                              // first heading
  if (h) return h[1].replace(/\*\*/g, '').trim().slice(0, 60);
  const cat = t.match(/\b\d{6,}\b|\b[A-Z]{2,}[A-Z0-9-]{3,}\b/);        // catalogue no / code
  const bold = t.match(/\*\*(.+?)\*\*/);                              // first bold phrase
  if (bold) return (bold[1].trim() + (cat ? ` ${cat[0]}` : '')).slice(0, 60);
  const words = t.replace(/[#*`>|_-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  return words.slice(0, 60) || 'Vector answer';
}

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
  let tableBuf: string[] = [];
  let inCode = false;

  const flushUl = () => {
    if (!ulBuf.length) return;
    out.push(
      <ul key={out.length} className="my-1.5 space-y-1 pl-0.5">
        {ulBuf.map((item, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] text-[var(--t2)] leading-relaxed">
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
          <li key={i} className="flex gap-2 text-[12.5px] text-[var(--t2)] leading-relaxed">
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
      <pre key={out.length} className="my-2 px-3 py-2.5 rounded-lg bg-[var(--term)] text-[11px] text-emerald-300 font-mono overflow-x-auto leading-relaxed">
        {codeBuf.join('\n')}
      </pre>,
    );
    codeBuf = [];
  };
  // GFM tables: a header row, a |---|---| separator, then body rows.
  const flushTable = () => {
    if (!tableBuf.length) return;
    const cells = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const isSep = tableBuf.length >= 2 && /-/.test(tableBuf[1]) && /^[\s|:-]+$/.test(tableBuf[1]);
    if (isSep) {
      const header = cells(tableBuf[0]);
      const rows = tableBuf.slice(2).map(cells);
      out.push(
        <div key={out.length} className="my-2.5 overflow-x-auto rounded-lg ring-1 ring-inset ring-[var(--line-2)]">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr>{header.map((h, i) => (
                <th key={i} className="text-left font-semibold text-[var(--t1)] px-2.5 py-1.5 border-b border-[var(--line-2)] bg-[var(--s3)] whitespace-nowrap">{inlineRender(h)}</th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri} className="odd:bg-[var(--s1)] even:bg-[var(--s2)]">
                {r.map((c, ci) => <td key={ci} className="px-2.5 py-1.5 text-[var(--t2)] align-top border-b border-[var(--line)]">{inlineRender(c)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
    } else {
      // Not a real table — render the buffered lines as plain paragraphs.
      for (const l of tableBuf) out.push(<p key={out.length} className="text-[12.5px] text-[var(--t2)] leading-relaxed">{inlineRender(l)}</p>);
    }
    tableBuf = [];
  };

  for (const line of lines) {
    const raw = line.trim();
    if (raw.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushUl(); flushOl(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    // Table rows: buffer consecutive pipe lines; anything else flushes the table.
    const isTableRow = raw.includes('|') && !raw.startsWith('#') && !/^[-*•]\s/.test(raw) && !/^\d+\.\s/.test(raw);
    if (isTableRow) { flushUl(); flushOl(); tableBuf.push(raw); continue; }
    flushTable();
    if (!raw) { flushUl(); flushOl(); out.push(<div key={out.length} className="h-1.5" />); continue; }
    if (/^---+$/.test(raw)) { flushUl(); flushOl(); out.push(<hr key={out.length} className="my-3 border-violet-200/60 dark:border-violet-800/40" />); continue; }
    if (raw.startsWith('### ')) { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[12px] font-bold mt-3 mb-0.5 text-[var(--t1)]">{inlineRender(raw.slice(4))}</p>); continue; }
    if (raw.startsWith('## '))  { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[13px] font-bold mt-3 mb-0.5 text-[var(--t1)]">{inlineRender(raw.slice(3))}</p>); continue; }
    if (raw.startsWith('# '))   { flushUl(); flushOl(); out.push(<p key={out.length} className="text-[14px] font-bold mt-3 mb-1   text-[var(--t1)]">{inlineRender(raw.slice(2))}</p>); continue; }
    if (/^[-*•]\s/.test(raw))  { flushOl(); ulBuf.push(raw.replace(/^[-*•]\s+/, '')); continue; }
    if (/^\d+\.\s/.test(raw))  { flushUl(); olBuf.push(raw.replace(/^\d+\.\s+/, '')); continue; }
    flushUl(); flushOl();
    out.push(<p key={out.length} className="text-[12.5px] text-[var(--t2)] leading-relaxed">{inlineRender(raw)}</p>);
  }
  flushUl(); flushOl(); flushCode(); flushTable();
  return <div className="space-y-0.5">{out}</div>;
}

function inlineRender(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={m.index} className="font-semibold text-[var(--t1)]">{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} className="px-1 py-0.5 rounded bg-[var(--s3)] text-[11px] font-mono text-[var(--accent-text)]">{m[4]}</code>);
    else if (m[5]) parts.push(<img key={m.index} src={m[7]} alt={m[6]} className="inline-block max-h-32 rounded border border-[var(--line-2)]" />);
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
        'group flex items-start gap-3 p-3.5 rounded-xl bg-[var(--s3)] ring-1 ring-inset ring-[var(--line)] transition-all',
        linked && 'hover:bg-[var(--accent-soft)] hover:ring-[var(--accent-line)]',
      )}>
      <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-[var(--accent-text)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-[12.5px] font-semibold text-[var(--t1)] leading-snug truncate">{doc.title || doc.filename}</p>
          {doc.ext && (
            <span className="text-[9px] uppercase font-semibold px-1 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] shrink-0">{doc.ext}</span>
          )}
        </div>
        {doc.summary && (
          <p className="text-[11px] text-[var(--t3)] mt-0.5 line-clamp-2 leading-snug">{doc.summary}</p>
        )}
        {(doc.author || doc.modified) && (
          <p className="text-[10px] text-[var(--t3)] mt-0.5">
            {doc.author}{doc.author && doc.modified ? ' · ' : ''}{doc.modified ? relTime(doc.modified) : ''}
          </p>
        )}
      </div>
      {linked && (
        <ExternalLink className="w-3.5 h-3.5 text-[var(--t4)] group-hover:text-brand-500 dark:group-hover:text-brand-400 transition-colors shrink-0 mt-1" />
      )}
    </Tag>
  );
}

// ─── Thinking phrases — status text that MATCHES the request, not a generic loop ─
// Client-side heuristic mirrors the server routing so the wait text is honest:
// part/price/alternative → sheet + web; quote-search signals → quotes; email → triage.
function phrasesFor(q: string): string[] {
  const s = (q || '').toLowerCase();
  const web   = /\b(datasheet|data sheet|spec|specification|alternativ|equivalent|replace|substitut|cross[\s-]?reference|compare|competitor|look ?up|dig it up|double ?check|verify|search (the )?(web|internet|online)|online|latest|newest)\b/.test(s);
  const part  = web || /\b(price|pricing|cost|ntp|catalogue|catalog|cat[\s-]?no|part\s*(no|number)|driver|luminaire|fitting|lumen|bulkhead|exit sign|emergency|\b\d{5,}\b)\b/.test(s);
  const table = /\b(table|tabulate|columns?|grid|side by side|spreadsheet|list them out)\b/.test(s);
  const draft = /\b(draft|write|compose|email|reply|respond|message|letter|note to|send (to|an)|inject)\b/.test(s);
  const pmo   = /\bpmo\b/.test(s);
  const step1 = /\b(step\s*1|extract|run step|upload|sharepoint|quotationfactory)\b/.test(s);
  const quote = /\b(quote|quotes|sr\d|customer|blair|craig|joe bayley|fenton|ollie|ryan|how many|who (made|quoted|did)|my quotes|kva)\b/.test(s);
  const email = /\b(from:|to:|subject:|dear |regards|@)\b/.test(s) || s.length > 400;

  if (table) return ['Reading your message…', 'Gathering the rows…', 'Building the table…', 'Lining up the columns…'];
  if (draft) return ['Reading the thread…', 'Deciding what to say…', 'Drafting the email…', 'Polishing the wording…'];
  if (pmo)   return ['Reading your message…', 'Walking the PMO steps…', 'Lining up PO → Word doc…', 'Putting it together…'];
  if (step1) return ['Reading your message…', 'Checking the PDF queue…', 'Mapping the extraction…', 'Prepping the SharePoint push…'];
  if (part) return [
    'Reading your message…',
    'Checking the Eaton EL price sheet…',
    'Matching the catalogue number…',
    ...(web ? ['Searching the web to verify specs & alternatives…', 'Cross-checking sources…'] : ['Pulling same-family alternatives…']),
    'Putting the details together…',
  ];
  if (quote) return ['Reading your message…', 'Searching your quotes…', 'Digging through the D&Q index…', 'Ranking the matches…'];
  if (email) return ['Reading the email…', 'Working out what it needs…', 'Drafting the response…'];
  return ['Reading your message…', 'Working out what you need…', 'Pulling the details together…', 'Almost there…'];
}
function ThinkingPhrases({ query }: { query: string }) {
  const phrases = React.useMemo(() => phrasesFor(query), [query]);
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [phrases]);
  useEffect(() => {
    const t = setInterval(() => setI(p => Math.min(p + 1, phrases.length - 1)), 1500);
    return () => clearInterval(t);
  }, [phrases]);
  return (
    <span className="text-[11.5px] text-[var(--t3)] italic transition-opacity">
      {phrases[i]}
    </span>
  );
}

// ─── Export menu — PDF/Word/Excel/CSV/TXT/MD/HTML/JSON of an answer or thread ───
function ExportMenu({ content, title, filename, toast, up = false, pill = false, align = 'left' }: {
  content: string; title: string; filename: string; toast: ToastFn; up?: boolean; pill?: boolean; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  async function pick(fmt: ExportFormat) {
    setBusy(fmt);
    try {
      await exportAnswer(fmt, { content, title, filename });
      toast('ok', `Exported ${fmt.toUpperCase()}`);
      setOpen(false);
    } catch (e: any) {
      toast('err', e?.message || 'Export failed');
    }
    setBusy(null);
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          pill
            ? 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-[var(--t3)] ring-1 ring-inset ring-[var(--line-2)] hover:bg-[var(--s3)] transition-colors'
            : 'flex items-center gap-1 text-[10.5px] text-[var(--t3)] hover:text-[var(--t1)] transition-colors',
        )}>
        <Download className={pill ? 'w-3.5 h-3.5' : 'w-3 h-3'} /> Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={cn(
            'absolute z-50 w-40 rounded-xl bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] shadow-lg overflow-hidden py-1',
            up ? 'bottom-full mb-1' : 'top-full mt-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}>
            {EXPORT_FORMATS.map(f => (
              <button
                key={f.id}
                disabled={!!busy}
                onClick={() => pick(f.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--t2)] hover:bg-[var(--s3)] disabled:opacity-50 transition-colors">
                {busy === f.id ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <FileText className="w-3 h-3 shrink-0 text-[var(--t4)]" />}
                <span className="flex-1">{f.label}</span>
                <span className="text-[10px] text-[var(--t4)] mono">.{f.ext}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function Bubble({ msg, onCopy, toast, exportTitle }: {
  msg: Message; onCopy: () => void; toast: ToastFn; exportTitle?: string;
}) {
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
        <div className={cn('rounded-2xl px-4 py-2.5', isUser ? 'rounded-tr-sm' : 'v3-card rounded-tl-sm')}
          style={isUser ? { background: 'var(--t1)', color: 'var(--bg)' } : undefined}>
          {isUser
            ? <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
            : <Markdown text={msg.text} />}
        </div>

        {/* Smart-search result cards */}
        {!isUser && msg.results && msg.results.length > 0 && (
          <div className="mt-1.5 w-full space-y-2">
            {msg.meta && (
              <p className="text-[10.5px] text-[var(--t3)] px-0.5">
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
            className="flex items-center gap-1 text-[10.5px] text-[var(--t3)] hover:text-[var(--t1)] transition-colors">
            {copied
              ? <><Check className="w-3 h-3 text-emerald-500" /> Copied</>
              : <><Copy className="w-3 h-3" /> Copy</>}
          </button>
          {!isUser && (
            <ExportMenu
              content={msg.text}
              title={exportTitle || 'Ask Vector answer'}
              filename={(exportTitle || 'vector-answer').slice(0, 50)}
              toast={toast}
            />
          )}
          <span className="text-[10px] text-[var(--t4)]">
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

      <div className="w-full max-w-2xl bg-[var(--s1)] rounded-2xl shadow-2xl ring-1 ring-inset ring-[var(--line-2)] flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--line)]">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center shrink-0">
            <FolderOpen className="w-4 h-4 text-[var(--accent-text)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold">{mineOnly ? 'Search my quotes' : 'Search the D&Q Store'}</p>
            <p className="text-[11px] text-[var(--t3)]">Customer, KVA, or catalog/fitting — searches inside the quote, not just the name</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--s3)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search input */}
        <div className="px-5 py-3 border-b border-[var(--line)]">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] focus-within:ring-[var(--accent-line)]">
              <Search className="w-3.5 h-3.5 text-[var(--t3)] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search(); }}
                placeholder="e.g.  quotes from Joe Bayley,  4kva,  ACM1,  EC141"
                className="flex-1 bg-transparent text-[12.5px] text-[var(--t1)] placeholder:text-[var(--t3)] outline-none min-w-0"
              />
              {q && <button onClick={() => setQ('')} className="text-[var(--t3)] hover:text-ink-600 dark:hover:text-ink-200 shrink-0"><X className="w-3 h-3" /></button>}
            </div>
            <button
              onClick={() => search()}
              disabled={loading || !q.trim()}
              className="h-9 px-4 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white text-[12px] font-semibold flex items-center gap-1.5 transition-colors shrink-0">
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
                  ? 'bg-[var(--accent-soft)] ring-[var(--accent-line)] text-[var(--accent-text)]'
                  : 'ring-[var(--line-2)] text-[var(--t3)] hover:bg-[var(--s3)]',
              )}>
              <User className="w-3 h-3" />
              Mine only
              {mineOnly && <Check className="w-3 h-3" />}
            </button>
            <span className="text-[10px] text-[var(--t3)]">Searches the full text of each quote, not just its name.</span>
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
            <p className="px-5 pt-3 pb-1 text-[10.5px] text-[var(--t3)]">
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
                <div className="w-12 h-12 rounded-2xl bg-[var(--s3)] flex items-center justify-center">
                  <FolderOpen className="w-5 h-5 text-[var(--t3)]" />
                </div>
                <p className="text-[12px] text-[var(--t3)] text-center max-w-xs">
                  Try a customer (“Joe Bayley”), a rating (“4kva”), or a catalog number (“ACM1”, “EC141”)
                </p>
              </div>
            )}

            {/* Loading skeleton */}
            {loading && (
              <div className="space-y-2 pt-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 rounded-xl bg-[var(--s3)] animate-pulse" />
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
        suggestions: r.suggestions && r.suggestions.length ? r.suggestions : undefined,
        title: r.title || undefined,
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
  // Name the whole-conversation export after its actual topic: prefer the latest AI
  // title, fall back to a derived topic, then the stored conversation title.
  const lastAiTitle = [...messages].reverse().find(m => m.role === 'assistant' && m.title)?.title;
  const lastAiText  = [...messages].reverse().find(m => m.role === 'assistant')?.text;
  const convTitle = lastAiTitle
    || (lastAiText ? deriveTitle(lastAiText) : '')
    || convs.find(c => c.id === activeId)?.title
    || 'Ask Vector conversation';
  const transcript = messages
    .map(m => `## ${m.role === 'user' ? 'You' : 'Ask Vector'}\n\n${m.text}`)
    .join('\n\n---\n\n');

  return (
    // Break out of the parent p-6 to fill the full content area; 2-column shell:
    // chat (left) + SharePoint search panel (right).
    <div className="-mx-6 -my-6 flex" style={{ height: 'calc(100vh - 60px)', background: 'var(--bg)' }}>

      {/* ── Chat column ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-[var(--line)]">

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-5 py-2.5 bg-[var(--s1)] border-b border-[var(--line)]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <div className="leading-none">
            <p className="text-[13px] font-semibold">Ask Vector</p>
            <p className="text-[10.5px] text-[var(--t3)] mt-0.5">One AI brain · knows your app, quotes & Fenton's EL guidance</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cn(
            'hidden sm:inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-0.5 rounded-full ring-1 ring-inset',
            connected
              ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 ring-emerald-200 dark:ring-emerald-700/30'
              : 'bg-[var(--s3)] text-[var(--t3)] ring-[var(--line-2)]',
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
            <ExportMenu content={transcript} title={convTitle} filename={convTitle} toast={toast} pill align="right" />
          )}

          {messages.length > 0 && (
            <button onClick={clear}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium text-[var(--t3)] hover:text-red-600 dark:hover:text-red-400 ring-1 ring-inset ring-[var(--line-2)] hover:ring-red-200 dark:hover:ring-red-700/40 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
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
                  : 'text-[var(--t3)] ring-[var(--line-2)] hover:bg-[var(--s3)]',
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
              <div className="absolute right-0 top-full mt-1.5 w-80 z-50 rounded-xl bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] shadow-lg overflow-hidden">
                {/* New chat button */}
                <div className="p-2 border-b border-[var(--line)]">
                  <button
                    onClick={newChat}
                    className="w-full flex items-center justify-center gap-2 h-8 rounded-lg bg-violet-500 hover:bg-violet-600 text-white text-[12px] font-semibold transition-colors">
                    <Plus className="w-3.5 h-3.5" /> New chat
                  </button>
                </div>

                {/* Conversation list */}
                <div className="max-h-80 overflow-y-auto py-1">
                  {convs.length === 0 ? (
                    <p className="px-3 py-4 text-center text-[11.5px] text-[var(--t3)]">No conversations yet</p>
                  ) : (
                    convs.map(conv => (
                      <div
                        key={conv.id}
                        onClick={() => switchConv(conv.id)}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors',
                          conv.id === activeId
                            ? 'bg-violet-50 dark:bg-violet-900/20'
                            : 'hover:bg-[var(--s3)]',
                        )}>
                        <div className="min-w-0 flex-1">
                          <p className={cn(
                            'text-[13px] font-medium truncate leading-snug',
                            conv.id === activeId
                              ? 'text-violet-700 dark:text-violet-300'
                              : 'text-[var(--t2)]',
                          )}>
                            {conv.title || 'New conversation'}
                          </p>
                          <p className="text-[10.5px] text-[var(--t3)] mt-0.5">
                            {relTime(new Date(conv.ts).toISOString())}
                            {conv.messages.length > 0 && ` · ${conv.messages.length} msg${conv.messages.length !== 1 ? 's' : ''}`}
                          </p>
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); deleteConv(conv.id); }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--t4)] hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Clear all */}
                {convs.length > 0 && (
                  <div className="p-2 border-t border-[var(--line)]">
                    <button
                      onClick={() => {
                        setConvs([]);
                        setActiveId(genId());
                        setHistoryOpen(false);
                      }}
                      className="w-full text-center text-[11px] text-[var(--t3)] hover:text-red-500 dark:hover:text-red-400 transition-colors py-1">
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
            <h2 className="text-[16px] font-semibold text-[var(--t1)] mb-2">
              What can I help with?
            </h2>
            <p className="text-[13px] text-[var(--t3)] max-w-[420px] leading-relaxed">
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
                    'bg-[var(--s1)] ring-[var(--line)] hover:ring-violet-300 dark:hover:ring-violet-600/60 hover:bg-violet-50/60 dark:hover:bg-violet-900/10',
                  )}>
                  <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 transition-colors',
                    'bg-violet-100 dark:bg-violet-900/50 group-hover:bg-violet-200 dark:group-hover:bg-violet-800/60',
                  )}>
                    <p.icon className="w-3.5 h-3.5 text-violet-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold text-[var(--t1)] leading-snug">{p.label}</p>
                    <p className="text-[11px] text-[var(--t3)] mt-0.5 leading-snug">{p.sub}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Conversation ── */
          <div className="px-5 py-5 space-y-5 w-full max-w-3xl mx-auto">
            {messages.map((msg, idx) => {
              const isLast = idx === messages.length - 1;
              const showOffers = msg.role === 'assistant' && isLast && !loading
                && !!msg.suggestions && msg.suggestions.length > 0;
              const exportTitle = msg.role === 'assistant'
                ? (msg.title || deriveTitle(msg.text)) : 'Ask Vector answer';
              return (
                <div key={msg.id} className="space-y-2">
                  <Bubble msg={msg} onCopy={() => toast('ok', 'Copied to clipboard')} toast={toast} exportTitle={exportTitle} />
                  {/* AI quick-action offers — click to have Vector do it next */}
                  {showOffers && (
                    <div className="ml-10 flex flex-wrap gap-1.5">
                      {msg.suggestions!.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => send(s)}
                          disabled={loading || !aiAvailable}
                          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium bg-violet-50 dark:bg-violet-900/20 ring-1 ring-inset ring-violet-200 dark:ring-violet-700/40 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                          <Sparkles className="w-3 h-3 shrink-0" />
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Typing indicator */}
            {loading && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-200 dark:ring-violet-800/50 flex items-center justify-center shrink-0 mt-1">
                  <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin" />
                </div>
                <div className="bg-[var(--s2)] ring-1 ring-inset ring-[var(--line)] rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                  <div className="flex gap-2.5 items-center h-4">
                    <div className="flex gap-1.5 items-center shrink-0">
                      {[0, 1, 2].map(i => (
                        <span key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                          style={{ animationDelay: `${i * 160}ms` }} />
                      ))}
                    </div>
                    <ThinkingPhrases query={[...messages].reverse().find(m => m.role === 'user')?.text || ''} />
                  </div>
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* ── Input area ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[var(--line)] bg-[var(--s1)] px-5 pt-3.5 pb-4">

        {/* Quick prompt chips — shown inside conversation */}
        {!isEmpty && (
          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-0.5 -mx-1 px-1 scrollbar-none">
            {/* Quote search chip — opens the quote-search modal (not a mode toggle) */}
            <button
              onClick={() => setQuoteSearchOpen(true)}
              title="Open quote search (searches your past SharePoint quotes)"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-violet-50 dark:hover:bg-violet-900/20 hover:ring-violet-200 dark:hover:ring-violet-700/40 hover:text-violet-700 dark:hover:text-violet-300 transition-colors">
              <Search className="w-3 h-3 shrink-0" />
              Search for a Quote
            </button>
            {QUICK_PROMPTS.filter(p => !p.emailHint && !p.quoteSearch).map(p => (
              <button key={p.label}
                disabled={loading || !aiAvailable}
                onClick={() => send(p.prompt)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium whitespace-nowrap shrink-0 bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-violet-50 dark:hover:bg-violet-900/20 hover:ring-violet-200 dark:hover:ring-violet-700/40 hover:text-violet-700 dark:hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
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
              className="w-full resize-none rounded-xl px-4 py-2.5 pr-20 bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] text-[13px] text-[var(--t1)] placeholder:text-[var(--t3)] focus:outline-none focus:ring-violet-300 dark:focus:ring-violet-600 disabled:opacity-50 leading-relaxed overflow-y-auto"
              style={{ maxHeight: 200 }}
            />
            {/* Hint overlay */}
            <div className="absolute right-3 bottom-2.5 flex items-center gap-0.5 text-[10px] text-[var(--t4)] pointer-events-none select-none">
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

        <p className="mt-2 text-center text-[10px] text-[var(--t4)] select-none">
          Shift+Enter for new line · history saved locally
        </p>
      </div>
      </div>{/* end chat column */}

      {/* ── SharePoint search column ────────────────────────────────────────── */}
      <aside className="hidden lg:flex w-[340px] shrink-0 flex-col bg-[var(--s1)]">
        <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b border-[var(--line)]">
          <Search className="w-3.5 h-3.5 text-[var(--t3)]" />
          <span className="text-[13px] font-semibold flex-1">SharePoint search</span>
        </div>
        <div className="shrink-0 flex gap-2 px-4 py-3 border-b border-[var(--line)]">
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
            placeholder="SR number, customer, title…"
            className="flex-1 h-8 px-2.5 rounded-md text-[12px] bg-[var(--s1)] ring-1 ring-inset ring-[var(--line-2)] focus:ring-[var(--accent-line)] focus:outline-none" />
          <button onClick={runSearch} disabled={searching}
            style={{ background: 'var(--t1)', color: 'var(--bg)' }}
            className="h-8 px-3.5 rounded-[9px] text-[11.5px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
            Search
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {searching ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--t4)]" /></div>
          ) : searchRes === null ? (
            <p className="text-[11.5px] text-[var(--t3)] text-center py-10 px-4">
              {connected ? 'Search the D&Q Store — try a customer, SR number, kVA rating or fitting code.' : 'Connect to JOE to search SharePoint.'}
            </p>
          ) : searchRes.length === 0 ? (
            <p className="text-[11.5px] text-[var(--t3)] text-center py-10">No results.</p>
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
