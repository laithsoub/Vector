// ─── EL Internal Info — EATON_Emergency_Lighting_INTERNAL updates + AI ────────
import React, { useState, useEffect, useRef, useCallback, KeyboardEvent } from 'react';
import {
  Megaphone, RefreshCw, Loader2, Sparkles, Send, FileText, Image as ImageIcon,
  FileSpreadsheet, Paperclip, ChevronDown, ChevronRight, MailX,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { ToastFn } from '../App';

interface ElAtt { index: number; name: string; size: number; isPdf: boolean; isImage?: boolean; isInline?: boolean }
interface ElEmail {
  entryId: string; received: string; subject: string;
  sender: string; senderEmail: string; body: string; attachments: ElAtt[];
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'];
const EXCEL_EXTS = ['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv'];
const extIs = (name: string, exts: string[]) => exts.some(e => name.toLowerCase().endsWith(e));
const fmtSize = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const fmtDate = (s: string) => { try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s.slice(0, 10); } };
const attUrl = (entryId: string, index: number) => `/api/outlook/attachment-view/${encodeURIComponent(entryId)}/${index}`;

// Tiny Markdown renderer (headings, bullets, bold) — matches the app's ink/violet look.
function Md({ text }: { text: string }) {
  const lines = (text || '').split('\n');
  const out: React.ReactNode[] = [];
  let ul: string[] = [];
  const inline = (s: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} className="font-semibold text-[var(--t1)]">{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>);
  };
  const flush = () => {
    if (!ul.length) return;
    out.push(<ul key={out.length} className="my-1.5 space-y-1">{ul.map((it, i) => (
      <li key={i} className="flex gap-2 text-[12.5px] text-[var(--t2)] leading-relaxed">
        <span className="text-violet-400 shrink-0 mt-0.5">•</span><span>{inline(it)}</span>
      </li>))}</ul>);
    ul = [];
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^#{1,6}\s/.test(l)) { flush(); const t = l.replace(/^#{1,6}\s/, '');
      out.push(<p key={out.length} className="mt-3 mb-1 text-[13px] font-bold text-[var(--t1)]">{inline(t)}</p>); }
    else if (/^[-*]\s+/.test(l)) ul.push(l.replace(/^[-*]\s+/, ''));
    else if (!l.trim()) flush();
    else { flush(); out.push(<p key={out.length} className="my-1 text-[12.5px] text-[var(--t2)] leading-relaxed">{inline(l)}</p>); }
  }
  flush();
  return <div>{out}</div>;
}

function AttChip({ email, att }: { email: ElEmail; att: ElAtt }) {
  const img = att.isImage || extIs(att.name, IMAGE_EXTS);
  const xls = extIs(att.name, EXCEL_EXTS);
  const Icon = xls ? FileSpreadsheet : img ? ImageIcon : att.isPdf ? FileText : Paperclip;
  const tone = xls ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 ring-green-200 dark:ring-green-700/40'
    : img ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-700/40'
    : 'bg-[var(--accent-soft)] text-[var(--accent-text)] ring-[var(--accent-line)]';
  return (
    <a href={attUrl(email.entryId, att.index)} target="_blank" rel="noopener noreferrer" title={`Open ${att.name}`}
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium ring-1 ring-inset hover:brightness-95 transition-all', tone)}>
      <Icon className="w-2.5 h-2.5 shrink-0" />
      <span className="truncate max-w-[220px]">{att.name}</span>
      <span className="opacity-50">{fmtSize(att.size)}</span>
    </a>
  );
}

export function ELInfoPage({ toast }: { toast: ToastFn }) {
  const [emails, setEmails]         = useState<ElEmail[]>([]);
  const [digest, setDigest]         = useState<string | null>(null);
  const [digestAt, setDigestAt]     = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [digesting, setDigesting]   = useState(false);
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [chat, setChat]             = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [chatInput, setChatInput]   = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.elInternalList();
      setEmails(r.emails || []); setDigest(r.digest); setDigestAt(r.digestAt); setLastRefresh(r.lastRefreshAt);
    } catch { /* silent */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.elInternalRefresh();
      if (r.error) toast('warn', failed('check for new EL updates', r.error));
      setEmails(r.emails || []); setLastRefresh(r.lastRefreshAt);
      toast('ok', r.added > 0
        ? `${plural(r.added, 'new update')} found — ${r.total} in total`
        : `Already up to date — ${plural(r.total, 'update')} stored`);
    } catch (e: any) { toast('err', failed('check for new EL updates', e)); }
    setRefreshing(false);
  }

  async function makeDigest() {
    setDigesting(true);
    try {
      const r = await api.elInternalDigest();
      if (r.error) { toast('warn', failed('write the AI digest', r.error)); }
      else { setDigest(r.digest); setDigestAt(r.digestAt || new Date().toISOString()); }
    } catch (e: any) { toast('err', failed('write the AI digest', e)); }
    setDigesting(false);
  }

  async function sendChat() {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    setChatInput('');
    setChat(prev => [...prev, { role: 'user', text: q }]);
    setChatLoading(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const r = await api.elInternalChat({ history: chat, question: q });
      setChat(prev => [...prev, { role: 'ai', text: r.answer || r.error || 'No response.' }]);
    } catch (e: any) { setChat(prev => [...prev, { role: 'ai', text: failed('answer that', e) }]); }
    setChatLoading(false);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (loading) return <div className="flex items-center justify-center py-24 text-[var(--t3)]"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/30 ring-1 ring-inset ring-violet-200 dark:ring-violet-700/40 flex items-center justify-center shrink-0">
          <Megaphone className="w-4.5 h-4.5 text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-bold text-[var(--t1)] leading-tight">EL Internal Info</h1>
          <p className="text-[12px] text-[var(--t3)]">
            {emails.length} update{emails.length !== 1 ? 's' : ''} this year from EATON_Emergency_Lighting_INTERNAL
            {lastRefresh && <> · refreshed {fmtDate(lastRefresh)}</>}
          </p>
        </div>
        <button onClick={refresh} disabled={refreshing}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors">
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> {refreshing ? 'Fetching…' : 'Refresh'}
        </button>
      </div>

      {emails.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <MailX className="w-10 h-10 text-[var(--t4)]" />
          <p className="text-[13px] text-[var(--t3)]">No updates fetched yet.</p>
          <button onClick={refresh} disabled={refreshing}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> Fetch this year's updates
          </button>
        </div>
      ) : (
        <>
          {/* AI digest */}
          <div className="rounded-xl ring-1 ring-inset ring-violet-200/70 dark:ring-violet-700/30 bg-violet-50/40 dark:bg-violet-900/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
              <p className="text-[12px] font-semibold text-[var(--t1)] flex-1">Current state — AI digest</p>
              {digesting && <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />}
              <button onClick={makeDigest} disabled={digesting}
                className="text-[11px] font-medium text-violet-600 dark:text-violet-300 hover:underline disabled:opacity-50">
                {digest ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {digest
              ? <><Md text={digest} />{digestAt && <p className="text-[10px] text-[var(--t3)] mt-2">Generated {fmtDate(digestAt)}</p>}</>
              : <p className="text-[12px] text-[var(--t3)]">Click Generate to build a consolidated brief of what's new, discontinued, and in stock across all {emails.length} updates.</p>}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
            {/* Updates feed */}
            <div className="lg:col-span-3 space-y-2">
              <p className="text-[11px] font-semibold text-[var(--t3)] uppercase tracking-wide px-0.5">Updates</p>
              {emails.map(e => {
                const open = expanded.has(e.entryId);
                return (
                  <div key={e.entryId} className="rounded-xl ring-1 ring-inset ring-[var(--line)] bg-[var(--s1)] overflow-hidden">
                    <button onClick={() => toggle(e.entryId)} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5 hover:bg-[var(--s3)] transition-colors">
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-[var(--t3)] shrink-0 mt-0.5" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--t3)] shrink-0 mt-0.5" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] font-semibold text-[var(--t1)] leading-snug">{e.subject}</p>
                        <p className="text-[10.5px] text-[var(--t3)] mt-0.5">{fmtDate(e.received)}{e.attachments.length > 0 && <> · {e.attachments.length} file{e.attachments.length !== 1 ? 's' : ''}</>}</p>
                      </div>
                    </button>
                    {open && (
                      <div className="px-3.5 pb-3 pt-0.5 border-t border-[var(--line)] space-y-2">
                        {e.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-2">
                            {e.attachments.map(a => <AttChip key={a.index} email={e} att={a} />)}
                          </div>
                        )}
                        <pre className="text-[12px] text-[var(--t2)] leading-relaxed whitespace-pre-wrap font-sans max-h-72 overflow-y-auto">{e.body || '(no text)'}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Ask-AI chat */}
            <div className="lg:col-span-2 lg:sticky lg:top-2">
              <div className="rounded-xl ring-1 ring-inset ring-[var(--line)] bg-[var(--s1)] flex flex-col" style={{ maxHeight: '70vh' }}>
                <div className="px-3.5 py-2.5 border-b border-[var(--line)] flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-violet-500" />
                  <p className="text-[12px] font-semibold text-[var(--t1)]">Ask about EL updates</p>
                </div>
                <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-2 min-h-[160px]">
                  {chat.length === 0 && (
                    <p className="text-[11.5px] text-[var(--t3)] leading-relaxed">
                      Ask anything across all {emails.length} updates — e.g. "latest on CBS batteries?", "when did FlexiTech launch?", "what's been discontinued?"
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
                    placeholder="Ask about EL updates…"
                    className="flex-1 h-8 px-2.5 rounded-lg text-[12px] bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)] focus:outline-none focus:ring-violet-400 placeholder:text-[var(--t3)] text-[var(--t1)]" />
                  <button aria-label="Send message" onClick={sendChat} disabled={!chatInput.trim() || chatLoading}
                    className="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 transition-colors shrink-0">
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
