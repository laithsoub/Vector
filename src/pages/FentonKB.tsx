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
import { AiSidePanel, Button as UiButton, IconButton as UiIconButton } from '../ui';

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
      ? <strong key={i} className="font-semibold text-fg">{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>);
  const out: React.ReactNode[] = []; let ul: string[] = [];
  const flush = () => { if (!ul.length) return; out.push(<ul key={out.length} className="my-1 space-y-1">{ul.map((it, i) =>
    <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed"><span className="text-ai shrink-0 mt-0.5">•</span><span>{inline(it)}</span></li>)}</ul>); ul = []; };
  for (const raw of (text || '').split('\n')) { const l = raw.trimEnd();
    if (/^[-*]\s+/.test(l)) ul.push(l.replace(/^[-*]\s+/, ''));
    else if (!l.trim()) flush();
    else { flush(); out.push(<p key={out.length} className="my-1 text-sm text-fg-2 leading-relaxed">{inline(l)}</p>); } }
  flush(); return <div>{out}</div>;
}

function AttChip({ entryId, att }: { entryId: string; att: FenAtt }) {
  const img = att.isImage || extIs(att.name, IMAGE_EXTS);
  const xls = extIs(att.name, EXCEL_EXTS);
  const Icon = xls ? FileSpreadsheet : img ? ImageIcon : att.isPdf ? FileText : Paperclip;
  const tone = xls ? 'bg-ok-soft text-ok ring-ok-line '
    : img ? 'bg-ok-soft text-ok ring-ok-line '
    : 'bg-accent-soft text-accent-text ring-accent-line';
  return (
    <a href={attUrl(entryId, att.index)} target="_blank" rel="noopener noreferrer" title={`Open ${att.name}`}
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-medium ring-1 ring-inset hover:opacity-80 transition-opacity', tone)}>
      <Icon className="w-2.5 h-2.5 shrink-0" /><span className="truncate max-w-56">{att.name}</span><span className="opacity-50">{fmtSize(att.size)}</span>
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

  if (loading) return <div className="flex items-center justify-center py-24 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 flex items-center justify-center shrink-0 text-warn">
          <Lightbulb className="w-4.5 h-4.5 text-warn" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-fg leading-tight">Ask Fenton</h1>
          <p className="text-sm text-fg-3">
            {cards.length} answer{cards.length !== 1 ? 's' : ''} from Mark Fenton (Senior Lighting Application Engineer)
            {lastRefresh && <> · refreshed {fmtDate(lastRefresh)}</>}
          </p>
        </div>
        {cards.length > 0 && (
          <UiButton tone="secondary" size="md" aria-label="Re-run AI extraction on all emails" onClick={() => refresh(true)} disabled={refreshing} hint="Re-run AI extraction on all emails">
            <Sparkles className="w-3.5 h-3.5" /> Rebuild
          </UiButton>
        )}
        <UiButton tone="primary" size="md" onClick={() => refresh(false)} disabled={refreshing}>
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> {refreshing ? 'Working…' : 'Refresh'}
        </UiButton>
      </div>

      {cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <MailX className="w-10 h-10 text-fg-4" />
          <p className="text-base text-fg-3">No knowledge built yet.</p>
          <UiButton tone="primary" size="md" onClick={() => refresh(false)} disabled={refreshing}>
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> Build from the past year
          </UiButton>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
          {/* Knowledge cards */}
          <div className="lg:col-span-3 space-y-2.5">
            <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-control bg-subtle ring-1 ring-inset ring-line focus-within:ring-ai">
              <Search className="w-3.5 h-3.5 text-fg-3 shrink-0" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Mark's answers…"
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-fg-3 text-fg" />
              {q && <span className="text-2xs text-fg-3">{shown.length}</span>}
            </div>
            {shown.map(c => {
              const open = expanded.has(c.entryId);
              return (
                <div key={c.entryId} className="rounded-xl ring-1 ring-inset ring-line bg-surface p-3.5">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold text-fg leading-snug">{c.topic || c.subject}</p>
                      {c.question && <p className="text-xs text-fg-3 mt-0.5 italic">Q: {c.question}</p>}
                    </div>
                    <span className="text-2xs text-fg-3 shrink-0 mt-0.5">{fmtDate(c.received)}</span>
                  </div>
                  {c.answer
                    ? <div className="mt-1.5"><Md text={c.answer} /></div>
                    : <p className="text-xs text-fg-3 mt-1.5">Not yet extracted — hit Refresh.</p>}
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {(c.tags || []).map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-2xs font-medium bg-ai-soft text-ai">{t}</span>
                    ))}
                    <button onClick={() => toggle(c.entryId)} className="ml-auto inline-flex items-center gap-0.5 text-2xs text-fg-3 hover:text-ai transition-colors">
                      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} email
                    </button>
                  </div>
                  {open && (
                    <div className="mt-2 pt-2 border-t border-line space-y-2">
                      <p className="text-xs font-medium text-fg-3">{c.subject}</p>
                      {c.attachments.length > 0 && <div className="flex flex-wrap gap-1.5">{c.attachments.map(a => <AttChip key={a.index} entryId={c.entryId} att={a} />)}</div>}
                      <pre className="text-xs text-fg-2 leading-relaxed whitespace-pre-wrap font-sans max-h-72 overflow-y-auto">{c.body || '(no text)'}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Ask-AI chat */}
          <div className="lg:col-span-2 lg:sticky lg:top-2">
            <AiSidePanel
              title="Ask Mark"
              sub="Answers grounded in his past replies"
              intro={<>Ask anything Mark has covered — e.g. “how do I quote a Salesforce opportunity in Bidman?”, “what's the DualGuard order check?”, “latest Loadstar PS pricing guidance?”</>}
              messages={chat}
              renderAnswer={t => <Md text={t} />}
              loading={chatLoading}
              input={chatInput}
              onInput={setChatInput}
              onSend={sendChat}
              placeholder="Ask Mark…"
              maxHeight="72vh"
            />
          </div>
        </div>
      )}
    </div>
  );
}
