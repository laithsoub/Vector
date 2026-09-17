// ─── AI Assistant page ────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Send, Trash2, Copy, Check, Loader2, AlertCircle,
  Mail, ClipboardList, Zap, HelpCircle, ChevronRight, CornerDownLeft,
  MessageSquare, Plus, Search, ExternalLink, FolderOpen, X, FileText, User,
  Download, ChevronDown, Eraser,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { failed } from '../lib/errors';
import { relTime } from '../lib/ui';
import { exportAnswer, EXPORT_FORMATS, type ExportFormat } from '../lib/export';
import type { ToastFn } from '../App';
import type { DqDoc } from '../types';
import {
  AiComposer, AiMessage, AiPromptGrid, AiSuggestions, AiThinking, AiThread, AiWelcome, Badge,
  Button as UiButton, CopyAction, IconButton as UiIconButton, Menu, UserMessage, useThinkingSteps,
  type AiPrompt,
} from '../ui';

const CONVS_KEY  = 'mu_assistant_convs';
const ACTIVE_KEY = 'mu_assistant_active';
// localStorage is ~5 MB for the whole origin and this is not the only thing in it.
const MAX_STORED_CONVS = 40;
let _mid = Date.now();

// Quote cards are the bulk of a stored conversation and can always be searched
// again; the prose answer that referenced them is what is worth keeping.
function stripResults(c: Conversation): Conversation {
  if (!c.messages.some(m => m.results?.length)) return c;
  return { ...c, messages: c.messages.map(m => (m.results ? { ...m, results: undefined } : m)) };
}

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
          <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
            <span className="text-ai shrink-0 select-none mt-0.5">•</span>
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
          <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
            <span className="text-ai font-semibold shrink-0 w-4 text-right mt-0.5 select-none">{i + 1}.</span>
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
      <pre key={out.length} className="my-2 px-3 py-2.5 rounded-lg bg-term text-xs text-ok mono overflow-x-auto leading-relaxed">
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
        <div key={out.length} className="my-2.5 overflow-x-auto rounded-lg ring-1 ring-inset ring-line-2">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>{header.map((h, i) => (
                <th key={i} className="text-left font-semibold text-fg px-2.5 py-1.5 border-b border-line-2 bg-subtle whitespace-nowrap">{inlineRender(h)}</th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri} className="odd:bg-surface even:bg-raised">
                {r.map((c, ci) => <td key={ci} className="px-2.5 py-1.5 text-fg-2 align-top border-b border-line">{inlineRender(c)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
    } else {
      // Not a real table — render the buffered lines as plain paragraphs.
      for (const l of tableBuf) out.push(<p key={out.length} className="text-sm text-fg-2 leading-relaxed">{inlineRender(l)}</p>);
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
    if (/^---+$/.test(raw)) { flushUl(); flushOl(); out.push(<hr key={out.length} className="my-3 border-ai-line " />); continue; }
    if (raw.startsWith('### ')) { flushUl(); flushOl(); out.push(<p key={out.length} className="text-sm font-semibold mt-3 mb-0.5 text-fg">{inlineRender(raw.slice(4))}</p>); continue; }
    if (raw.startsWith('## '))  { flushUl(); flushOl(); out.push(<p key={out.length} className="text-base font-semibold mt-3 mb-0.5 text-fg">{inlineRender(raw.slice(3))}</p>); continue; }
    if (raw.startsWith('# '))   { flushUl(); flushOl(); out.push(<p key={out.length} className="text-lg font-semibold mt-3 mb-1 text-fg">{inlineRender(raw.slice(2))}</p>); continue; }
    if (/^[-*•]\s/.test(raw))  { flushOl(); ulBuf.push(raw.replace(/^[-*•]\s+/, '')); continue; }
    if (/^\d+\.\s/.test(raw))  { flushUl(); olBuf.push(raw.replace(/^\d+\.\s+/, '')); continue; }
    flushUl(); flushOl();
    out.push(<p key={out.length} className="text-sm text-fg-2 leading-relaxed">{inlineRender(raw)}</p>);
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
    if (m[1])      parts.push(<strong key={m.index} className="font-semibold text-fg">{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} className="px-1 py-0.5 rounded bg-subtle text-xs mono text-accent-text">{m[4]}</code>);
    else if (m[5]) parts.push(<img key={m.index} src={m[7]} alt={m[6]} className="inline-block max-h-32 rounded border border-line-2" />);
    else if (m[8]) parts.push(<a key={m.index} href={m[10]} target="_blank" rel="noopener noreferrer" className="text-ai underline underline-offset-2 hover:text-ai ">{m[9]}</a>);
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
        'group flex items-start gap-3 p-3.5 rounded-xl bg-subtle ring-1 ring-inset ring-line transition-all',
        linked && 'hover:bg-accent-soft hover:ring-accent-line',
      )}>
      <div className="w-8 h-8 flex items-center justify-center shrink-0 mt-0.5 text-accent-text">
        <Icon className="w-3.5 h-3.5 text-accent-text" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold text-fg leading-snug truncate">{doc.title || doc.filename}</p>
          {doc.ext && (
            <span className="text-2xs uppercase font-semibold px-1 py-0.5 rounded bg-accent-soft text-accent-text shrink-0">{doc.ext}</span>
          )}
        </div>
        {doc.summary && (
          <p className="text-xs text-fg-3 mt-0.5 line-clamp-2 leading-snug">{doc.summary}</p>
        )}
        {(doc.author || doc.modified) && (
          <p className="text-2xs text-fg-3 mt-0.5">
            {doc.author}{doc.author && doc.modified ? ' · ' : ''}{doc.modified ? relTime(doc.modified) : ''}
          </p>
        )}
      </div>
      {linked && (
        <ExternalLink className="w-3.5 h-3.5 text-fg-4 group-hover:text-accent-text transition-colors shrink-0 mt-1" />
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
  const label = useThinkingSteps(phrases, true);
  return <AiThinking label={label} />;
}

// ─── Export menu — PDF/Word/Excel/CSV/TXT/MD/HTML/JSON of an answer or thread ───
function ExportMenu({ content, title, filename, toast, pill = false }: {
  content: string; title: string; filename: string; toast: ToastFn; up?: boolean; pill?: boolean; align?: 'left' | 'right';
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  async function pick(fmt: ExportFormat) {
    setBusy(fmt);
    try {
      await exportAnswer(fmt, { content, title, filename });
      toast('ok', `Answer exported to ${fmt.toUpperCase()}`);
    } catch (e: any) {
      toast('err', failed(`export the answer to ${fmt.toUpperCase()}`, e));
    }
    setBusy(null);
  }

  return (
    <Menu position={pill ? 'bottom-end' : 'bottom-start'} closeOnItemClick={false}>
      <Menu.Target>
        {pill
          ? <UiButton tone="secondary" icon={Download}>Export</UiButton>
          : <UiIconButton size="xs" icon={Download} label="Export answer" />}
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Export as</Menu.Label>
        {EXPORT_FORMATS.map(f => (
          <Menu.Item key={f.id} disabled={!!busy} onClick={() => pick(f.id)}
            leftSection={busy === f.id ? <Loader2 className="animate-spin" /> : <FileText />}
            rightSection={<span className="mono text-2xs text-fg-4">.{f.ext}</span>}>
            {f.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

// ─── Message ─────────────────────────────────────────────────────────────────
function Bubble({ msg, onCopy, toast, exportTitle }: {
  msg: Message; onCopy: () => void; toast: ToastFn; exportTitle?: string;
}) {
  if (msg.role === 'user') {
    return (
      <UserMessage text={msg.text} time={msg.ts}
        badge={msg.isEmail ? <Badge tone="warn" leftSection={<Mail className="w-3 h-3" />}>Email detected</Badge> : undefined} />
    );
  }
  return (
    <AiMessage time={msg.ts}
      footer={msg.results && msg.results.length > 0 ? (
        <div className="flex flex-col gap-2">
          {msg.meta && (
            <p className="text-xs text-fg-3">
              <span className="mono">{msg.meta.count}</span> match{msg.meta.count !== 1 ? 'es' : ''} for “{msg.meta.term}” · {msg.meta.scope}
              {msg.results.length < msg.meta.count ? ` · showing top ${msg.results.length}` : ''}
            </p>
          )}
          {msg.results.map((doc, i) => <QuoteResultCard key={i} doc={doc} />)}
        </div>
      ) : undefined}
      actions={<>
        <CopyAction text={msg.text} onCopied={onCopy} />
        <ExportMenu
          content={msg.text}
          title={exportTitle || 'Ask Vector answer'}
          filename={(exportTitle || 'vector-answer').slice(0, 50)}
          toast={toast}
        />
      </>}>
      <Markdown text={msg.text} />
    </AiMessage>
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
    <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-overlay "
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="w-full max-w-2xl bg-surface rounded-2xl ring-1 ring-inset ring-line-2 flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <div className="w-8 h-8 flex items-center justify-center shrink-0 text-accent-text">
            <FolderOpen className="w-4 h-4 text-accent-text" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold">{mineOnly ? 'Search my quotes' : 'Search the D&Q Store'}</p>
            <p className="text-xs text-fg-3">Customer, KVA, or catalog/fitting — searches inside the quote, not just the name</p>
          </div>
          <UiIconButton icon={X} label="Close quote search" size="sm" onClick={onClose} />
        </div>

        {/* Search input */}
        <div className="px-5 py-3 border-b border-line">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-lg bg-surface ring-1 ring-inset ring-line-2 focus-within:ring-accent-line">
              <Search className="w-3.5 h-3.5 text-fg-3 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search(); }}
                placeholder="e.g.  quotes from Joe Bayley,  4kva,  ACM1,  EC141"
                className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 outline-none min-w-0"
              />
              {q && <button aria-label="Clear search" onClick={() => setQ('')} className="text-fg-3 hover:text-fg-2 shrink-0"><X className="w-3 h-3" /></button>}
            </div>
            <UiButton tone="primary" size="lg" className="shrink-0" onClick={() => search()} disabled={loading || !q.trim()}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Search
            </UiButton>
          </div>

          {/* Mine-only toggle */}
          <div className="flex items-center gap-2 mt-2.5">
            <button aria-label={mineOnly ? 'Showing only quotes you uploaded — click to search everyone’s' : 'Searching everyone’s quotes — click to show only yours'} onClick={() => toggleMine(!mineOnly)}
              title={mineOnly ? 'Showing only quotes you uploaded — click to search everyone’s' : 'Searching everyone’s quotes — click to show only yours'}
              className={cn(
                'h-6 px-2 rounded-md text-2xs font-medium flex items-center gap-1.5 ring-1 ring-inset transition-colors',
                mineOnly
                  ? 'bg-accent-soft ring-accent-line text-accent-text'
                  : 'ring-line-2 text-fg-3 hover:bg-subtle',
              )}>
              <User className="w-3 h-3" />
              Mine only
              {mineOnly && <Check className="w-3 h-3" />}
            </button>
            <span className="text-2xs text-fg-3">Searches the full text of each quote, not just its name.</span>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {/* Error */}
          {error && (
            <div className="mx-5 mt-4 flex gap-2.5 items-center px-4 py-3 rounded-xl bg-err-soft ring-1 ring-inset ring-err-line text-sm text-err ">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Result count */}
          {searched && !loading && !error && (
            <p className="px-5 pt-3 pb-1 text-2xs text-fg-3">
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
                <div className="w-12 h-12 flex items-center justify-center">
                  <FolderOpen className="w-5 h-5 text-fg-3" />
                </div>
                <p className="text-sm text-fg-3 text-center max-w-xs">
                  Try a customer (“Joe Bayley”), a rating (“4kva”), or a catalog number (“ACM1”, “EC141”)
                </p>
              </div>
            )}

            {/* Loading skeleton */}
            {loading && (
              <div className="space-y-2 pt-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 rounded-xl bg-subtle animate-pulse" />
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

  const endRef       = useRef<HTMLDivElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const historyRef   = useRef<HTMLDivElement>(null);

  // Persist activeId
  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  // Persist convs. Unbounded, this eventually throws QuotaExceededError from
  // inside an effect and takes the tab down with it — the history is full
  // transcripts plus every quote card the search returned. So: keep the most
  // recent conversations, drop the result cards from the ones not open (they are
  // re-fetchable and by far the heaviest part), and if the browser still says no,
  // shed the oldest until it fits.
  useEffect(() => {
    const trimmed = convs.slice(0, MAX_STORED_CONVS).map(c => c.id === activeId ? c : stripResults(c));
    for (let keep = trimmed.length; keep >= 0; keep--) {
      try {
        localStorage.setItem(CONVS_KEY, JSON.stringify(trimmed.slice(0, keep)));
        return;
      } catch { /* quota — try again with fewer */ }
    }
  }, [convs, activeId]);

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
    toast('info', 'Conversation cleared — it stays in your history list');
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

  const prompts: AiPrompt[] = QUICK_PROMPTS.map(p => ({
    icon: p.icon as AiPrompt['icon'],
    label: p.label,
    sub: p.sub,
    onRun: () => {
      if (p.quoteSearch) setQuoteSearchOpen(true);
      else if (p.emailHint) textareaRef.current?.focus();
      else send(p.prompt);
    },
  }));

  const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.text || '';

  return (
    // Full-bleed: PAGE_FRAME marks Assistant 0, so the shell adds no padding.
    // Single column: the D&Q Store is reached from the chat itself (/api/quote-ask
    // searches it and answers with result cards), from the "Search for a Quote"
    // prompt, and from the Search tab.
    <div className="flex flex-col bg-page" style={{ height: 'calc(100vh - var(--header-h))' }}>

      {/* ── Bar ─────────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-page h-h-lg border-b border-line bg-ai-wash">
        <Menu position="bottom-start" width="var(--popover-w)">
          <Menu.Target>
            <UiButton tone="ghost" icon={MessageSquare} trailing={<ChevronDown className="w-3 h-3" />}>
              <span className="truncate max-w-64">{convs.find(c => c.id === activeId)?.title || 'New conversation'}</span>
            </UiButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<Plus />} onClick={newChat}>New conversation</Menu.Item>
            {convs.length > 0 && <Menu.Divider />}
            {convs.length > 0 && <Menu.Label>Recent</Menu.Label>}
            <div className="max-h-80 overflow-y-auto">
              {convs.map(conv => (
                <Menu.Item key={conv.id} component="div" onClick={() => switchConv(conv.id)}
                  className={conv.id === activeId ? 'bg-accent-soft' : undefined}
                  rightSection={
                    <UiIconButton icon={Trash2} label="Delete conversation" tone="danger" size="xs"
                      onClick={e => { e.stopPropagation(); deleteConv(conv.id); }} />
                  }>
                  <span className="block truncate text-fg">{conv.title || 'New conversation'}</span>
                  <span className="block mono text-2xs text-fg-4">
                    {relTime(new Date(conv.ts).toISOString())}
                    {conv.messages.length > 0 && ` · ${conv.messages.length} msg`}
                  </span>
                </Menu.Item>
              ))}
            </div>
            {convs.length > 0 && <Menu.Divider />}
            {convs.length > 0 && (
              <Menu.Item color="err" leftSection={<Trash2 />}
                onClick={() => { setConvs([]); setActiveId(genId()); }}>
                Clear all conversations
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>

        <div className="flex-1" />

        <Badge tone={connected ? 'ok' : 'neutral'} dot>{connected ? 'SharePoint connected' : 'SharePoint offline'}</Badge>
        {!aiAvailable && <Badge tone="warn" leftSection={<AlertCircle className="w-3 h-3" />}>No Gemini key</Badge>}
        {messages.length > 0 && (
          <>
            <ExportMenu content={transcript} title={convTitle} filename={convTitle} toast={toast} pill />
            <UiIconButton icon={Eraser} label="Clear this conversation" onClick={clear} />
          </>
        )}
        <UiButton tone="primary" icon={Plus} onClick={newChat}>New chat</UiButton>
      </div>

      {/* ── Conversation ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-page">
        {isEmpty ? (
          <div className="min-h-full flex items-center justify-center py-10">
            <div className="w-full" style={{ maxWidth: 'var(--measure-chat)' }}>
              <AiWelcome title="What can I help with?"
                sub="Ask anything about your workflow, search your quotes, or paste an email and I'll work out exactly what needs doing.">
                <AiPromptGrid prompts={prompts} disabled={!aiAvailable} />
              </AiWelcome>
            </div>
          </div>
        ) : (
          <div className="py-8">
            <AiThread deps={[messages.length, loading]}>
              {messages.map((msg, idx) => {
                const isLast = idx === messages.length - 1;
                const showOffers = msg.role === 'assistant' && isLast && !loading
                  && !!msg.suggestions && msg.suggestions.length > 0;
                const exportTitle = msg.role === 'assistant'
                  ? (msg.title || deriveTitle(msg.text)) : 'Ask Vector answer';
                return (
                  <div key={msg.id} className="flex flex-col gap-3">
                    <Bubble msg={msg} onCopy={() => toast('ok', 'Answer copied to the clipboard')} toast={toast} exportTitle={exportTitle} />
                    {showOffers && (
                      <div className="pl-9">
                        <AiSuggestions items={msg.suggestions!} onPick={s => send(s)} disabled={loading || !aiAvailable} />
                      </div>
                    )}
                  </div>
                );
              })}
              {loading && <ThinkingPhrases query={lastUserText} />}
            </AiThread>
          </div>
        )}
      </div>

      {/* ── Composer ────────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-page pb-4 pt-2">
        <div className="mx-auto flex flex-col gap-2" style={{ maxWidth: 'var(--measure-chat)' }}>
          {!aiAvailable && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-control bg-warn-soft border border-warn-line text-sm text-warn">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              No Gemini API key — add one in <strong className="font-semibold">Settings</strong>.
            </div>
          )}
          <AiComposer
            inputRef={textareaRef}
            value={input}
            onChange={setInput}
            onSubmit={() => send()}
            loading={loading}
            disabled={!aiAvailable}
            placeholder={isEmpty ? 'Ask anything, or paste an email…' : 'Follow up…'}
            tools={<>
              <UiButton tone="ghost" size="xs" icon={Search} onClick={() => setQuoteSearchOpen(true)}
                hint="Search your past SharePoint quotes">
                Quote search
              </UiButton>
              {!isEmpty && (
                <Menu position="top-start">
                  <Menu.Target>
                    <UiButton tone="ghost" size="xs" icon={Sparkles} trailing={<ChevronDown className="w-3 h-3" />}>Quick asks</UiButton>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {QUICK_PROMPTS.filter(p => !p.emailHint && !p.quoteSearch).map(p => (
                      <Menu.Item key={p.label} leftSection={<p.icon />} disabled={loading || !aiAvailable}
                        onClick={() => send(p.prompt)}>
                        {p.label}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}
            </>}
          />
          <p className="text-center text-2xs text-fg-4 select-none">History is saved on this computer only.</p>
        </div>
      </div>

      {quoteSearchOpen && <QuoteSearchPanel onClose={() => setQuoteSearchOpen(false)} />}
    </div>
  );
}
