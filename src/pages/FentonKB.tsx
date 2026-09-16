// ─── Ask Fenton — Mark Fenton's answers as an AI knowledge base ───────────────
import React, { useState, useEffect, useRef, useCallback, KeyboardEvent } from 'react';
import {
  Lightbulb, RefreshCw, Loader2, Sparkles, Send, FileText, Image as ImageIcon,
  FileSpreadsheet, Paperclip, ChevronDown, ChevronRight, Search, MailX,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { ToastFn } from '../App';

interface FenAtt { index: number; name: string; size: number; isPdf: boolean; isImage?: boolean }
interface FenCard {
  entryId: string; received: string; subject: string; senderEmail: string;
  body: string; attachments: FenAtt[];
  topic: string; question: string; answer: string; tags: string[]; extracted: number;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'];
const EXCEL_EXTS = ['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv'];
const extIs = (n: string, e: string[]) => e.some(x => n.toLowerCase().endsWith(x));
const fmtSize = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const fmtDate = (s: string) => { try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return (s || '').slice(0, 10); } };
const attUrl = (entryId: string, index: number) => `/api/outlook/attachment-view/${encodeURIComponent(entryId)}/${index}`;

function Md({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} className="font-semibold text-[var(--t1)]">{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>);
  const out: React.ReactNode[] = []; let ul: string[] = [];
  const flush = () => { if (!ul.length) return; out.push(<ul key={out.length} className="my-1 space-y-1">{ul.map((it, i) =>
    <li key={i} className="flex gap-2 text-[12px] text-[var(--t2)] leading-relaxed"><span className="text-violet-400 shrink-0 mt-0.5">•</span><span>{inline(it)}</span></li>)}</ul>); ul = []; };
  for (const raw of (text || '').split('\n')) { const l = raw.trimEnd();
    if (/^[-*]\s+/.test(l)) ul.push(l.replace(/^[-*]\s+/, ''));
    else if (!l.trim()) flush();
    else { flush(); out.push(<p key={out.length} className="my-1 text-[12px] text-[var(--t2)] leading-relaxed">{inline(l)}</p>); } }
  flush(); return <div>{out}</div>;
}

function AttChip({ entryId, att }: { entryId: string; att: FenAtt }) {
  const img = att.isImage || extIs(att.name, IMAGE_EXTS);
  const xls = extIs(att.name, EXCEL_EXTS);
  const Icon = xls ? FileSpreadsheet : img ? ImageIcon : att.isPdf ? FileText : Paperclip;
  const tone = xls ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 ring-green-200 dark:ring-green-700/40'
    : img ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-700/40'
    : 'bg-[var(--accent-soft)] text-[var(--accent-text)] ring-[var(--accent-line)]';
  return (
    <a href={attUrl(entryId, att.index)} target="_blank" rel="noopener noreferrer" title={`Open ${att.name}`}
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset hover:brightness-95 transition-all', tone)}>
      <Icon className="w-2.5 h-2.5 shrink-0" /><span className="truncate max-w-[220px]">{att.name}</span><span className="opacity-50">{fmtSize(att.size)}</span>
    </a>
  );
}

export function FentonKBPage({ toast }: { toast: ToastFn }) {
  const [cards, setCards]           = useState<FenCard[]>([]);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ]                   = useState('');
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [chat, setChat]             = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [chatInput, setChatInput]   = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { const r = await api.fentonList(); setCards(r.cards || []); setLastRefresh(r.lastRefreshAt); } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function refresh(force = false) {
    setRefreshing(true);
    try {
      const r = await api.fentonRefresh(force);
      if (r.error) toast('warn', failed('refresh the knowledge base', r.error));
      const kept = (r.cards || []).length;
      setCards(r.cards || []); setLastRefresh(r.lastRefreshAt);
      // r.total counts every email swept; only the ones carrying real expertise
      // become cards, so report what actually landed in the knowledge base.
      const filtered = r.skipped ? ` (${r.skipped} admin emails filtered out)` : '';
      toast('ok', force
        ? `Knowledge base rebuilt — ${plural(kept, 'card')}${filtered}`
        : (r.added > 0 ? `${plural(r.added, 'new email')} swept — ${plural(kept, 'answer')} in the base${filtered}`
                       : `Already up to date — ${plural(kept, 'answer')} stored${filtered}`));
    } catch (e: any) { toast('err', failed('refresh the knowledge base', e)); }
    setRefreshing(false);
  }

  async function sendChat() {
    const question = chatInput.trim();
    if (!question || chatLoading) return;
    setChatInput('');
    setChat(prev => [...prev, { role: 'user', text: question }]);
    setChatLoading(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const r = await api.fentonChat({ history: chat, question });
      setChat(prev => [...prev, { role: 'ai', text: r.answer || r.error || 'No response.' }]);
    } catch (e: any) { setChat(prev => [...prev, { role: 'ai', text: 'Error: ' + e.message }]); }
    setChatLoading(false);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? cards.filter(c => `${c.topic} ${c.question} ${c.answer} ${c.subject} ${(c.tags || []).join(' ')}`.toLowerCase().includes(needle))
    : cards;

  if (loading) return <div className="flex items-center justify-center py-24 text-[var(--t3)]"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="space-y-[17px]">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-900/30 ring-1 ring-inset ring-amber-200 dark:ring-amber-700/40 flex items-center justify-center shrink-0">
          <Lightbulb className="w-4.5 h-4.5 text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-bold text-[var(--t1)] leading-tight">Ask Fenton</h1>
          <p className="text-[12px] text-[var(--t3)]">
            {cards.length} answer{cards.length !== 1 ? 's' : ''} from Mark Fenton (Senior Lighting Application Engineer)
            {lastRefresh && <> · refreshed {fmtDate(lastRefresh)}</>}
          </p>
        </div>
        {cards.length > 0 && (
          <button aria-label="Re-run AI extraction on all emails" onClick={() => refresh(true)} disabled={refreshing} title="Re-run AI extraction on all emails"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11.5px] font-medium ring-1 ring-inset ring-[var(--line-2)] text-[var(--t2)] hover:bg-[var(--s3)] disabled:opacity-50 transition-colors">
            <Sparkles className="w-3.5 h-3.5" /> Rebuild
          </button>
        )}
        <button onClick={() => refresh(false)} disabled={refreshing}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors">
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> {refreshing ? 'Working…' : 'Refresh'}
        </button>
      </div>

      {cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <MailX className="w-10 h-10 text-[var(--t4)]" />
          <p className="text-[13px] text-[var(--t3)]">No knowledge built yet.</p>
          <button onClick={() => refresh(false)} disabled={refreshing}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> Build from the past year
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-[17px] items-start">
          {/* Knowledge cards */}
          <div className="lg:col-span-3 space-y-2.5">
            <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[var(--s3)] ring-1 ring-inset ring-[var(--line)] focus-within:ring-violet-400/60">
              <Search className="w-3.5 h-3.5 text-[var(--t3)] shrink-0" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Mark's answers…"
                className="flex-1 bg-transparent text-[12px] focus:outline-none placeholder:text-[var(--t3)] text-[var(--t1)]" />
              {q && <span className="text-[10.5px] text-[var(--t3)]">{shown.length}</span>}
            </div>
            {shown.map(c => {
              const open = expanded.has(c.entryId);
              return (
                <div key={c.entryId} className="rounded-xl ring-1 ring-inset ring-[var(--line)] bg-[var(--s1)] p-3.5">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--t1)] leading-snug">{c.topic || c.subject}</p>
                      {c.question && <p className="text-[11.5px] text-[var(--t3)] mt-0.5 italic">Q: {c.question}</p>}
                    </div>
                    <span className="text-[10px] text-[var(--t3)] shrink-0 mt-0.5">{fmtDate(c.received)}</span>
                  </div>
                  {c.answer
                    ? <div className="mt-1.5"><Md text={c.answer} /></div>
                    : <p className="text-[11.5px] text-[var(--t3)] mt-1.5">Not yet extracted — hit Refresh.</p>}
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {(c.tags || []).map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 dark:bg-violet-900/25 text-violet-600 dark:text-violet-300">{t}</span>
                    ))}
                    <button onClick={() => toggle(c.entryId)} className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-[var(--t3)] hover:text-violet-600 dark:hover:text-violet-300 transition-colors">
                      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} email
                    </button>
                  </div>
                  {open && (
                    <div className="mt-2 pt-2 border-t border-[var(--line)] space-y-2">
                      <p className="text-[11px] font-medium text-[var(--t3)]">{c.subject}</p>
                      {c.attachments.length > 0 && <div className="flex flex-wrap gap-1.5">{c.attachments.map(a => <AttChip key={a.index} entryId={c.entryId} att={a} />)}</div>}
                      <pre className="text-[11.5px] text-[var(--t2)] leading-relaxed whitespace-pre-wrap font-sans max-h-72 overflow-y-auto">{c.body || '(no text)'}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Ask-AI chat */}
          <div className="lg:col-span-2 lg:sticky lg:top-2">
            <div className="rounded-xl ring-1 ring-inset ring-[var(--line)] bg-[var(--s1)] flex flex-col" style={{ maxHeight: '72vh' }}>
              <div className="px-3.5 py-2.5 border-b border-[var(--line)] flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-violet-500" />
                <p className="text-[12px] font-semibold text-[var(--t1)]">Ask Mark (AI)</p>
              </div>
              <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-2 min-h-[180px]">
                {chat.length === 0 && (
                  <p className="text-[11.5px] text-[var(--t3)] leading-relaxed">
                    Ask anything Mark has covered — e.g. "how do I quote a Salesforce opportunity in Bidman?", "what's the DualGuard order check?", "latest Loadstar PS pricing guidance?"
                  </p>
                )}
                {chat.map((m, i) => (
                  <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[92%] px-3 py-1.5 rounded-xl text-[12px]',
                      m.role === 'user' ? 'bg-violet-600 text-white rounded-br-sm' : 'bg-[var(--s3)] text-[var(--t1)] rounded-bl-sm')}>
                      {m.role === 'ai' ? <Md text={m.text} /> : m.text}
                    </div>
                  </div>
                ))}
                {chatLoading && <div className="flex justify-start"><div className="px-3 py-1.5 rounded-xl bg-[var(--s3)] text-[12px] text-[var(--t3)] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Thinking…</div></div>}
                <div ref={chatEndRef} />
              </div>
              <div className="px-3 py-2.5 border-t border-[var(--line)] flex gap-2">
                <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                  placeholder="Ask Mark…"
                  className="flex-1 h-8 px-2.5 rounded-lg text-[12px] bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)] focus:outline-none focus:ring-violet-400 placeholder:text-[var(--t3)] text-[var(--t1)]" />
                <button aria-label="Send message" onClick={sendChat} disabled={!chatInput.trim() || chatLoading}
                  className="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 transition-colors shrink-0">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
