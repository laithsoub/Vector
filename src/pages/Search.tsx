// ─── Search page — wired to /api/search + Copilot ────────────────────────────
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search as SearchIcon, ArrowRight, X, Sparkles, Loader2, AlertCircle,
  Clock, Boxes, User, Calendar, CircleDot, ChevronDown, Check, ExternalLink,
  Download, LayoutGrid, Table as TableIcon, SearchX, FileText, Mail,
} from 'lucide-react';

import { cn } from '../lib/cn';
import {
  Card, CardTitle, Pill, Segmented, Button,
  fmtMoneyFull, relTime,
} from '../lib/ui';
import { PRODUCT_COLORS } from '../lib/charts';
import { api } from '../lib/api';
import type { SearchResult, DqDoc } from '../types';
import type { ToastFn } from '../App';

type StatusFilter   = 'any' | 'Pending' | 'Processed' | 'On Hold' | 'Error';
type ProductFilter  = 'any' | string;
type SalesmanFilter = 'any' | string;

const RECENT_KEY = 'magic_recent_searches';

// ── Copilot markdown renderer — handles images, links, bold, lists, citations ──
function CopilotMarkdown({ text }: { text: string }) {
  const blocks = text.split('\n');
  const elements: React.ReactNode[] = [];

  blocks.forEach((line, i) => {
    const key = i;
    // Blank line
    if (!line.trim()) { elements.push(<div key={key} className="h-2" />); return; }
    // Horizontal rule / citation separator
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={key} className="my-2 border-violet-200 dark:border-violet-700/40" />);
      return;
    }
    // Images: ![alt](url)
    if (/^!\[.*?\]\(.*?\)$/.test(line.trim())) {
      const m = line.match(/^!\[(.*?)\]\((.*?)\)/);
      if (m) {
        elements.push(
          <img key={key} src={m[2]} alt={m[1] || 'Copilot image'}
            className="max-w-full rounded-lg mt-2 mb-2 border border-ink-200 dark:border-ink-700" />
        );
        return;
      }
    }
    // Headers
    if (line.startsWith('### ')) {
      elements.push(<p key={key} className="text-[12px] font-bold mt-2 text-ink-800 dark:text-ink-100">{line.slice(4)}</p>);
      return;
    }
    if (line.startsWith('## ')) {
      elements.push(<p key={key} className="text-[13px] font-bold mt-2 text-ink-800 dark:text-ink-100">{line.slice(3)}</p>);
      return;
    }
    if (line.startsWith('**') && line.endsWith('**')) {
      elements.push(<p key={key} className="text-[12px] font-bold mt-1 text-ink-800 dark:text-ink-100">{line.slice(2, -2)}</p>);
      return;
    }
    // Bullet lists
    if (/^[\-\*•]\s/.test(line.trim()) || /^\d+\.\s/.test(line.trim())) {
      const content = line.replace(/^[\s\-\*•]+/, '').replace(/^\d+\.\s*/, '');
      elements.push(
        <div key={key} className="flex gap-1.5 text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">
          <span className="text-violet-400 mt-0.5 shrink-0">•</span>
          <span>{renderInline(content)}</span>
        </div>
      );
      return;
    }
    // Regular text with inline formatting
    elements.push(<p key={key} className="text-[12px] text-ink-700 dark:text-ink-200 leading-relaxed">{renderInline(line)}</p>);
  });

  return <div className="space-y-0.5">{elements}</div>;
}

// Inline markdown: **bold**, [link](url), `code`, ![img](url)
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Combined regex for inline elements
  const regex = /(\*\*(.+?)\*\*)|(\[([^\]]+?)\]\(([^)]+?)\))|(!\[([^\]]*?)\]\(([^)]+?)\))|(`([^`]+?)`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    if (match[1]) {
      // **bold**
      parts.push(<strong key={match.index} className="font-semibold text-ink-800 dark:text-ink-100">{match[2]}</strong>);
    } else if (match[6]) {
      // ![img](url)
      parts.push(
        <img key={match.index} src={match[8]} alt={match[7] || 'image'}
          className="inline-block max-h-40 rounded mt-1 border border-ink-200 dark:border-ink-700" />
      );
    } else if (match[3]) {
      // [link](url)
      parts.push(
        <a key={match.index} href={match[5]} target="_blank" rel="noopener noreferrer"
          className="text-brand-600 dark:text-brand-400 underline underline-offset-2 hover:text-brand-700">
          {match[4]}
        </a>
      );
    } else if (match[9]) {
      // `code`
      parts.push(
        <code key={match.index} className="px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-[11px] font-mono">{match[10]}</code>
      );
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export function SearchPage({
  connected, toast,
}: {
  connected: boolean;
  toast: ToastFn;
}) {
  const [query, setQuery]             = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [results, setResults]         = useState<SearchResult[]>([]);
  const [searching, setSearching]     = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // D&Q Store full-text results (file name + PDF/email content)
  const [dqResults, setDqResults]     = useState<DqDoc[]>([]);
  const [dqSearching, setDqSearching] = useState(false);
  const [mineOnly, setMineOnly]       = useState(true);   // only quotes I created

  const [status, setStatus]     = useState<StatusFilter>('any');
  const [productF, setProductF] = useState<ProductFilter>('any');
  const [salesmanF, setSalesmanF] = useState<SalesmanFilter>('any');
  const [sort, setSort]         = useState<'recent' | 'value-desc' | 'value-asc'>('recent');
  const [view, setView]         = useState<'cards' | 'table'>('cards');

  const [aiOpen, setAiOpen]     = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMessages, setAiMessages] = useState<Array<{role:'user'|'ai'; text:string}>>([]);
  const [aiInput, setAiInput]   = useState('');

  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
    catch { return []; }
  });

  const inputRef   = useRef<HTMLInputElement>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);
  const aiEndRef   = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    api.aiStatus().then(r => setAiAvailable(r.available)).catch(() => setAiAvailable(false));
  }, [connected, aiOpen]);
  // Also check once on mount
  useEffect(() => {
    api.aiStatus().then(r => setAiAvailable(r.available)).catch(() => {});
  }, []);
  useEffect(() => {
    aiEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages]);

  // D&Q Store full-text search (name + PDF/email content). Separate from the
  // Quotations-list metadata search so the "Mine only" toggle can re-run just this.
  function fetchDq(term: string, mine: boolean) {
    if (!term) return;
    setDqResults([]); setDqSearching(true);
    api.dqSearch(term, mine)
      .then(r => setDqResults(r.results || []))
      .catch(() => {})
      .finally(() => setDqSearching(false));
  }

  function toggleMine(next: boolean) {
    setMineOnly(next);
    if (activeQuery) fetchDq(activeQuery, next);
  }

  async function doSearch(q?: string) {
    const term = (q ?? query).trim();
    if (!term) return;
    setSearching(true); setError(null); setResults([]); setActiveQuery(term);
    fetchDq(term, mineOnly);

    try {
      const r = await api.search(term);
      setResults(r.results || []);
      if (r.error) setError(r.error);
      else if ((r.results || []).length === 0) setError('No results found.');
      const next = [term, ...recents.filter(x => x !== term)].slice(0, 6);
      setRecents(next);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (e: any) {
      setError(e.message);
    }
    setSearching(false);
  }

  async function askAI(q?: string) {
    const term = (q ?? aiInput ?? query).trim();
    if (!term || aiLoading) return;
    setAiInput('');
    setAiLoading(true);
    setAiMessages(prev => [...prev, { role: 'user', text: term }]);
    try {
      const history = aiMessages.map(m => ({ role: m.role === 'ai' ? 'model' : 'user', text: m.text }));
      const r = await api.ai(term, history);
      const answer = r.answer || r.error || 'No response';
      if (!r.error) setAiAvailable(true);
      setAiMessages(prev => [...prev, { role: 'ai', text: answer }]);
    } catch (e: any) {
      setAiMessages(prev => [...prev, { role: 'ai', text: '[Error] ' + e.message }]);
    }
    setAiLoading(false);
    setTimeout(() => aiInputRef.current?.focus(), 50);
  }

  function clearAll() {
    setQuery(''); setActiveQuery(''); setResults([]); setError(null);
    setDqResults([]); setDqSearching(false);
    setStatus('any'); setProductF('any'); setSalesmanF('any'); setSort('recent');
  }

  // Derived: available filters from results
  const productOptions = useMemo(() => {
    const set = new Set<string>();
    results.forEach(r => { if (r.DIVISION) set.add(r.DIVISION); });
    return ['any', ...Array.from(set).sort()];
  }, [results]);
  const salesmanOptions = useMemo(() => {
    const set = new Set<string>();
    results.forEach(r => { if (r.REQUESTED_x0020_BY) set.add(r.REQUESTED_x0020_BY); });
    return ['any', ...Array.from(set).sort()];
  }, [results]);
  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    results.forEach(r => { if (r.STATUS) set.add(r.STATUS); });
    return ['any', ...Array.from(set).sort()];
  }, [results]);

  // Filter + sort
  const filtered = useMemo(() => {
    let out = results;
    if (status !== 'any')    out = out.filter(r => r.STATUS === status);
    if (productF !== 'any')  out = out.filter(r => r.DIVISION === productF);
    if (salesmanF !== 'any') out = out.filter(r => r.REQUESTED_x0020_BY === salesmanF);
    const priceNum = (r: SearchResult) => Number(r.PRICE) || 0;
    if (sort === 'recent')      out = [...out].sort((a, b) => (b.ARRIVED_x0020_ON || '').localeCompare(a.ARRIVED_x0020_ON || ''));
    if (sort === 'value-desc')  out = [...out].sort((a, b) => priceNum(b) - priceNum(a));
    if (sort === 'value-asc')   out = [...out].sort((a, b) => priceNum(a) - priceNum(b));
    return out;
  }, [results, status, productF, salesmanF, sort]);

  // Summary
  const summary = useMemo(() => {
    const total = filtered.length;
    const value = filtered.reduce((s, r) => s + (Number(r.PRICE) || 0), 0);
    return { total, value };
  }, [filtered]);

  const hasFilters = activeQuery || status !== 'any' || productF !== 'any' || salesmanF !== 'any';

  function exportCsv() {
    if (filtered.length === 0) return;
    const cols = ['SALESFORCEID', 'CUSTOMER', 'QUOTATION_x0020_NAME', 'DIVISION', 'STATUS', 'PRICE', 'ARRIVED_x0020_ON', 'REQUESTED_x0020_BY'];
    const rows = [cols.join(',')];
    for (const r of filtered) {
      rows.push(cols.map(c => {
        const v = (r as any)[c];
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
      }).join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quotes_${activeQuery.replace(/\s+/g, '_')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('ok', `${filtered.length} row${filtered.length !== 1 ? 's' : ''} exported`);
  }

  return (
    <div className="space-y-5">

      {/* Hero search input */}
      <Card>
        {!connected && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/15 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/30 text-[11.5px] text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Not connected to JOE — searches will fail. Click "Connect to JOE" in the header.
          </div>
        )}

        <div className="flex items-center gap-2">
          <SearchIcon className="w-4 h-4 text-ink-400 ml-2" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
            placeholder="SF ID, quote name, customer, salesman…"
            className="flex-1 h-9 bg-transparent text-[14px] focus:outline-none placeholder:text-ink-400 dark:text-ink-50" />
          {(query || activeQuery) && (
            <button onClick={clearAll}
              className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 px-2">
              <X className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => { setAiOpen(o => !o); setTimeout(() => aiInputRef.current?.focus(), 50); }}
              className={cn('h-8 px-3 rounded-md text-[11.5px] font-medium ring-1 ring-inset flex items-center gap-1.5 transition-colors',
                aiOpen
                  ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 ring-violet-300 dark:ring-violet-600'
                  : 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-300 ring-violet-200 dark:ring-violet-700/40 hover:bg-violet-100')}>
              <Sparkles className="w-3.5 h-3.5" />
              Ask AI
              {aiMessages.length > 0 && (
                <span className="ml-0.5 w-4 h-4 rounded-full bg-violet-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {aiMessages.filter(m => m.role === 'ai').length}
                </span>
              )}
            </button>
          <Button tone="primary" size="md" onClick={() => doSearch()} disabled={!connected || searching || !query.trim()}
            Icon={searching ? Loader2 : ArrowRight}>{searching ? 'Searching…' : 'Search'}</Button>
        </div>

        {!activeQuery && recents.length > 0 && (
          <div className="mt-3 pt-3 border-t border-ink-100 dark:border-ink-800 flex items-center gap-2 flex-wrap">
            <span className="text-[10.5px] text-ink-400 uppercase tracking-wider font-semibold">Recent</span>
            {recents.map(s => (
              <button key={s} onClick={() => { setQuery(s); doSearch(s); }}
                className="text-[11px] px-2 py-0.5 rounded-md bg-ink-100 dark:bg-ink-800 hover:bg-ink-200 dark:hover:bg-ink-700 text-ink-700 dark:text-ink-200 flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-ink-400" /> {s}
              </button>
            ))}
            <button onClick={() => { setRecents([]); localStorage.removeItem(RECENT_KEY); }}
              className="text-[10.5px] text-ink-400 hover:text-red-500 ml-1">Clear</button>
          </div>
        )}

        {/* Ask AI conversation panel */}
        {aiOpen && (
          <div className="mt-3 border-t border-violet-100 dark:border-violet-800/40 pt-3">
            {!aiAvailable && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/40 text-[11.5px] text-amber-700 dark:text-amber-300">
                No Gemini API key set — go to <strong>Settings</strong> → add your key in the <strong>Gemini API key</strong> field → Save.
                Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="underline">aistudio.google.com</a>
              </div>
            )}
            {/* Conversation history */}
            {aiMessages.length > 0 && (
              <div className="max-h-80 overflow-y-auto space-y-3 mb-3 pr-1">
                {aiMessages.map((m, i) => (
                  <div key={i} className={cn('flex gap-2.5', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {m.role === 'ai' && (
                      <div className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0 mt-0.5">
                        <Sparkles className="w-3 h-3 text-violet-500" />
                      </div>
                    )}
                    <div className={cn('max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed',
                      m.role === 'user'
                        ? 'bg-ink-800 dark:bg-ink-200 text-white dark:text-ink-900 rounded-br-sm'
                        : 'bg-violet-50 dark:bg-violet-900/20 text-ink-800 dark:text-ink-100 ring-1 ring-inset ring-violet-100 dark:ring-violet-800/40 rounded-bl-sm')}>
                      {m.role === 'ai' ? <CopilotMarkdown text={m.text} /> : m.text}
                    </div>
                  </div>
                ))}
                {aiLoading && (
                  <div className="flex gap-2.5 justify-start">
                    <div className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0">
                      <Loader2 className="w-3 h-3 text-violet-500 animate-spin" />
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-900/20 ring-1 ring-inset ring-violet-100 dark:ring-violet-800/40 rounded-xl rounded-bl-sm px-3 py-2">
                      <div className="flex gap-1">
                        {[0,1,2].map(i => (
                          <div key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{animationDelay: `${i*150}ms`}} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={aiEndRef} />
              </div>
            )}
            {/* Input row */}
            <div className="flex gap-2 items-center">
              <input
                ref={aiInputRef}
                value={aiInput}
                onChange={e => setAiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAI(); }}}
                placeholder={aiMessages.length === 0 ? 'Ask anything about your jobs, quotes, or workflow…' : 'Follow up…'}
                className="flex-1 h-8 px-3 rounded-lg bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 text-[12px] focus:outline-none focus:ring-violet-300 dark:focus:ring-violet-700 placeholder:text-ink-400"
              />
              {aiMessages.length > 0 && (
                <button onClick={() => setAiMessages([])}
                  className="text-[10.5px] text-ink-400 hover:text-red-500 px-1 whitespace-nowrap">
                  Clear
                </button>
              )}
              <button onClick={() => askAI()}
                disabled={aiLoading || !aiInput.trim()}
                className="h-8 w-8 rounded-lg bg-violet-500 hover:bg-violet-600 text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* Quick prompts */}
            {aiMessages.length === 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['What went wrong with the last failed job?', 'Walk me through raising a PMO', 'How do I fix a FedAuth error?', 'What\'s in the queue right now?'].map(p => (
                  <button key={p} onClick={() => { setAiInput(p); askAI(p); }}
                    className="text-[10.5px] px-2 py-1 rounded-md bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-300 ring-1 ring-inset ring-violet-100 dark:ring-violet-800/40 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors">
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* D&Q Store documents — full-text (name + PDF/email content) */}
      {activeQuery && (
        <Card padded={false} className="overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ink-100 dark:border-ink-800 flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-brand-500" />
            <span className="text-[12px] font-semibold">{mineOnly ? 'My quotes' : 'D&Q Store'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-500">name + content</span>
            {dqSearching && <Loader2 className="w-3 h-3 text-ink-400 animate-spin ml-0.5" />}
            <div className="flex-1" />
            {dqResults.length > 0 && (
              <span className="text-[11px] text-ink-500 num mr-1">{dqResults.length} file{dqResults.length !== 1 ? 's' : ''}</span>
            )}
            {/* Mine-only toggle */}
            <button onClick={() => toggleMine(!mineOnly)}
              title={mineOnly ? 'Showing only quotes you created — click to search everyone’s' : 'Searching everyone’s quotes — click to show only yours'}
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
          </div>

          {dqResults.length > 0 ? (
            <div className="divide-y divide-ink-100 dark:divide-ink-800/70">
              {dqResults.map((d, i) => {
                const isMail = ['msg', 'eml'].includes(d.ext);
                const Icon = isMail ? Mail : FileText;
                return (
                  <a key={i} href={d.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-start gap-3 px-4 py-2.5 hover:bg-ink-50/60 dark:hover:bg-ink-800/30 group">
                    <Icon className="w-4 h-4 text-ink-400 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[12.5px] font-medium truncate">{d.title || d.filename}</p>
                        {d.ext && (
                          <span className="text-[9px] uppercase font-semibold px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-500 shrink-0">{d.ext}</span>
                        )}
                      </div>
                      {d.summary && (
                        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5 line-clamp-2">{d.summary}</p>
                      )}
                      {(d.author || d.modified) && (
                        <p className="text-[10px] text-ink-400 mt-0.5 num">
                          {d.author}{d.author && d.modified ? ' · ' : ''}{d.modified ? relTime(d.modified) : ''}
                        </p>
                      )}
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 text-ink-300 group-hover:text-brand-500 shrink-0 mt-0.5" />
                  </a>
                );
              })}
            </div>
          ) : dqSearching ? (
            <p className="px-4 py-3 text-[11.5px] text-ink-400">Searching quote files…</p>
          ) : (
            <p className="px-4 py-3 text-[11.5px] text-ink-400">
              {mineOnly
                ? 'No quotes you created matched — try turning off “Mine only”.'
                : 'No files matched in the D&Q Store.'}
            </p>
          )}
        </Card>
      )}

      {/* Filters bar — only if we have results */}
      {results.length > 0 && (
        <Card className="!py-3" padded={false}>
          <div className="px-4 py-2.5 flex items-center gap-4 flex-wrap">
            <FilterChip label="Status" Icon={CircleDot} value={status} setValue={v => setStatus(v as StatusFilter)}
              options={statusOptions.map(o => ({ value: o, label: o === 'any' ? 'Any' : o }))} />
            <FilterChip label="Division" Icon={Boxes} value={productF} setValue={v => setProductF(v as ProductFilter)}
              options={productOptions.map(o => ({ value: o, label: o === 'any' ? 'Any' : o }))} />
            <FilterChip label="Salesman" Icon={User} value={salesmanF} setValue={v => setSalesmanF(v as SalesmanFilter)}
              options={salesmanOptions.map(o => ({ value: o, label: o === 'any' ? 'Any' : o }))} />

            <div className="flex-1" />

            {hasFilters && (
              <button onClick={() => { setStatus('any'); setProductF('any'); setSalesmanF('any'); }}
                className="text-[11px] font-medium text-ink-500 hover:text-red-600 flex items-center gap-1">
                <X className="w-3 h-3" /> Clear filters
              </button>
            )}

            <Segmented value={sort} onChange={v => setSort(v as typeof sort)} options={[
              { value: 'recent',     label: 'Recent' },
              { value: 'value-desc', label: 'Value ↓' },
              { value: 'value-asc',  label: 'Value ↑' },
            ]} />

            <div className="flex items-center rounded-md ring-1 ring-inset ring-ink-200 dark:ring-ink-700 p-0.5">
              {[
                { id: 'cards' as const, I: LayoutGrid },
                { id: 'table' as const, I: TableIcon },
              ].map(v => (
                <button key={v.id} onClick={() => setView(v.id)}
                  className={cn('w-7 h-7 rounded-sm flex items-center justify-center',
                    view === v.id ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-900' : 'text-ink-500 hover:text-ink-800')}>
                  <v.I className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 py-2 border-t border-ink-100 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-950/30 flex items-center gap-3 text-[11.5px]">
            <span className="text-ink-600 dark:text-ink-300">
              <span className="font-semibold text-ink-900 dark:text-ink-50 num">{summary.total.toLocaleString()}</span> result{summary.total !== 1 ? 's' : ''}
            </span>
            {summary.value > 0 && <>
              <span className="text-ink-300 dark:text-ink-700">·</span>
              <span className="text-ink-600 dark:text-ink-300">
                Combined value <span className="font-semibold text-ink-900 dark:text-ink-50 num">{fmtMoneyFull(summary.value, '€')}</span>
              </span>
            </>}
            <div className="flex-1" />
            <button onClick={exportCsv} className="text-[11px] font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200 flex items-center gap-1">
              <Download className="w-3 h-3" /> Export CSV
            </button>
          </div>
        </Card>
      )}

      {/* Results */}
      {error && results.length === 0 && dqResults.length === 0 ? (
        <Card className="text-center py-16">
          <div className="w-12 h-12 rounded-full bg-ink-100 dark:bg-ink-800 flex items-center justify-center mx-auto mb-3">
            <SearchX className="w-5 h-5 text-ink-400" />
          </div>
          <p className="text-[14px] font-semibold">{error}</p>
          <p className="text-[12px] text-ink-500 dark:text-ink-400 mt-1">Try a different term, or clear filters.</p>
        </Card>
      ) : filtered.length === 0 && results.length === 0 && !activeQuery ? (
        <Card className="text-center py-12">
          <div className="w-12 h-12 rounded-full bg-brand-50 dark:bg-brand-900/30 text-brand-600 flex items-center justify-center mx-auto mb-3">
            <SearchIcon className="w-5 h-5" />
          </div>
          <p className="text-[13px] font-semibold">Search the SharePoint Quotations list</p>
          <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-1 max-w-md mx-auto">
            Try a Salesforce ID like <code className="mono text-brand-600">SR00MzKQ8</code>, a customer name like <em>Heathrow</em>, or a quote name.
          </p>
        </Card>
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map(r => <ResultCard key={r.Id ?? r.SALESFORCEID} r={r} />)}
        </div>
      ) : (
        <Card padded={false} className="overflow-hidden">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-ink-50 dark:bg-ink-950/30 border-b border-ink-200/70 dark:border-ink-800">
                {['SF ID', 'Customer', 'Quote', 'Division', 'Status', 'Value', 'Arrived', ''].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.Id ?? r.SALESFORCEID} className="border-b border-ink-100 dark:border-ink-800/70 hover:bg-ink-50/60 dark:hover:bg-ink-800/30">
                  <td className="px-4 py-2.5 mono text-brand-600 dark:text-brand-300 font-semibold">{r.SALESFORCEID}</td>
                  <td className="px-4 py-2.5 font-medium truncate max-w-[180px]">{r.CUSTOMER || '—'}</td>
                  <td className="px-4 py-2.5 text-ink-600 dark:text-ink-300 truncate max-w-[180px]">{r.QUOTATION_x0020_NAME || r.Title || '—'}</td>
                  <td className="px-4 py-2.5">
                    {r.DIVISION ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-3.5 rounded-sm" style={{ background: PRODUCT_COLORS[r.DIVISION] || '#65656c' }} />
                        {r.DIVISION}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5">{r.STATUS ? <Pill tone="neutral">{r.STATUS}</Pill> : '—'}</td>
                  <td className="px-4 py-2.5 num font-medium text-right">{r.PRICE ? fmtMoneyFull(Number(r.PRICE), '€') : '—'}</td>
                  <td className="px-4 py-2.5 text-ink-500 num">{r.ARRIVED_x0020_ON ? relTime(r.ARRIVED_x0020_ON) : '—'}</td>
                  <td className="px-4 py-2.5 text-ink-400"><ExternalLink className="w-3.5 h-3.5" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function FilterChip<V extends string>({
  label, Icon, value, setValue, options,
}: {
  label: string;
  Icon: typeof CircleDot;
  value: V;
  setValue: (v: V) => void;
  options: Array<{ value: V; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value);
  const isActive = value !== 'any';
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className={cn(
          'h-8 px-2.5 rounded-md text-[11.5px] flex items-center gap-1.5 ring-1 ring-inset transition-colors',
          isActive
            ? 'bg-brand-50 dark:bg-brand-900/30 ring-brand-200 dark:ring-brand-700/50 text-brand-700 dark:text-brand-300 font-medium'
            : 'ring-ink-200 dark:ring-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800',
        )}>
        <Icon className="w-3.5 h-3.5" />
        <span className="text-ink-400">{label}:</span>
        <span>{current?.label}</span>
        <ChevronDown className="w-3 h-3 text-ink-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 min-w-[180px] max-h-72 overflow-y-auto rounded-lg bg-white dark:bg-ink-900 ring-1 ring-ink-200 dark:ring-ink-700 shadow-lg py-1">
            {options.map(o => (
              <button key={o.value} onClick={() => { setValue(o.value); setOpen(false); }}
                className={cn('w-full px-2.5 py-1.5 text-left text-[11.5px] flex items-center gap-2',
                  o.value === value
                    ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 font-medium'
                    : 'text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800')}>
                {o.label}
                {o.value === value && <Check className="w-3 h-3 ml-auto" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ResultCard({ r }: { r: SearchResult }) {
  const productColor = r.DIVISION ? (PRODUCT_COLORS[r.DIVISION] || '#65656c') : '#65656c';
  const statusBg = r.STATUS === 'Processed' ? 'bg-emerald-500'
                 : r.STATUS === 'Error' ? 'bg-red-500'
                 : r.STATUS === 'On Hold' ? 'bg-amber-500'
                 : 'bg-brand-500';
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 ring-1 ring-inset ring-ink-200/70 dark:ring-ink-800 hover:ring-ink-300 dark:hover:ring-ink-700 transition-all overflow-hidden">
      <div className="flex">
        <div className="w-1 shrink-0" style={{ background: productColor }} />
        <div className="flex-1 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] mono font-semibold text-brand-600 dark:text-brand-300">{r.SALESFORCEID || '—'}</p>
              <h4 className="text-[13.5px] font-semibold mt-0.5 truncate">{r.CUSTOMER || r.QUOTATION_x0020_NAME || '(no name)'}</h4>
              <p className="text-[11.5px] text-ink-500 dark:text-ink-400 mt-0.5 truncate">
                {r.QUOTATION_x0020_NAME || r.Title || '—'}
                {r.DIVISION && <> · {r.DIVISION}</>}
              </p>
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <span className={cn('w-2 h-2 rounded-full', statusBg)} />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
                {r.STATUS || '—'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 mt-4 text-[11px]">
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-400 font-semibold">Value</p>
              <p className="num font-semibold mt-0.5">{r.PRICE ? fmtMoneyFull(Number(r.PRICE), '€') : '—'}</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-400 font-semibold">Salesman</p>
              <p className="font-medium mt-0.5 truncate">{r.REQUESTED_x0020_BY ? r.REQUESTED_x0020_BY.split(' ')[0] : '—'}</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-400 font-semibold">Country</p>
              <p className="font-medium mt-0.5 truncate">{r.Country || '—'}</p>
            </div>
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-400 font-semibold">Arrived</p>
              <p className="font-medium mt-0.5">{r.ARRIVED_x0020_ON ? relTime(r.ARRIVED_x0020_ON) : '—'}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
