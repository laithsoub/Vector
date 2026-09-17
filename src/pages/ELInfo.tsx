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
import { AiSidePanel, Button as UiButton, IconButton as UiIconButton } from '../ui';

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
      ? <strong key={i} className="font-semibold text-fg">{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>);
  };
  const flush = () => {
    if (!ul.length) return;
    out.push(<ul key={out.length} className="my-1.5 space-y-1">{ul.map((it, i) => (
      <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
        <span className="text-ai shrink-0 mt-0.5">•</span><span>{inline(it)}</span>
      </li>))}</ul>);
    ul = [];
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^#{1,6}\s/.test(l)) { flush(); const t = l.replace(/^#{1,6}\s/, '');
      out.push(<p key={out.length} className="mt-3 mb-1 text-base font-semibold text-fg">{inline(t)}</p>); }
    else if (/^[-*]\s+/.test(l)) ul.push(l.replace(/^[-*]\s+/, ''));
    else if (!l.trim()) flush();
    else { flush(); out.push(<p key={out.length} className="my-1 text-sm text-fg-2 leading-relaxed">{inline(l)}</p>); }
  }
  flush();
  return <div>{out}</div>;
}

function AttChip({ email, att }: { email: ElEmail; att: ElAtt }) {
  const img = att.isImage || extIs(att.name, IMAGE_EXTS);
  const xls = extIs(att.name, EXCEL_EXTS);
  const Icon = xls ? FileSpreadsheet : img ? ImageIcon : att.isPdf ? FileText : Paperclip;
  const tone = xls ? 'bg-ok-soft text-ok ring-ok-line '
    : img ? 'bg-ok-soft text-ok ring-ok-line '
    : 'bg-accent-soft text-accent-text ring-accent-line';
  return (
    <a href={attUrl(email.entryId, att.index)} target="_blank" rel="noopener noreferrer" title={`Open ${att.name}`}
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-medium ring-1 ring-inset hover:opacity-80 transition-opacity', tone)}>
      <Icon className="w-2.5 h-2.5 shrink-0" />
      <span className="truncate max-w-56">{att.name}</span>
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

  if (loading) return <div className="flex items-center justify-center py-24 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 flex items-center justify-center shrink-0 text-ai">
          <Megaphone className="w-4.5 h-4.5 text-ai" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-fg leading-tight">EL Internal Info</h1>
          <p className="text-sm text-fg-3">
            {emails.length} update{emails.length !== 1 ? 's' : ''} this year from EATON_Emergency_Lighting_INTERNAL
            {lastRefresh && <> · refreshed {fmtDate(lastRefresh)}</>}
          </p>
        </div>
        <UiButton tone="primary" size="md" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> {refreshing ? 'Fetching…' : 'Refresh'}
        </UiButton>
      </div>

      {emails.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <MailX className="w-10 h-10 text-fg-4" />
          <p className="text-base text-fg-3">No updates fetched yet.</p>
          <UiButton tone="primary" size="md" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} /> Fetch this year's updates
          </UiButton>
        </div>
      ) : (
        <>
          {/* AI digest */}
          <div className="border-l-2 border-ai pl-4 py-1">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-ai shrink-0" />
              <p className="text-sm font-semibold text-fg flex-1">Current state — AI digest</p>
              {digesting && <Loader2 className="w-3.5 h-3.5 animate-spin text-ai" />}
              <button onClick={makeDigest} disabled={digesting}
                className="text-xs font-medium text-ai hover:underline disabled:opacity-50">
                {digest ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {digest
              ? <><Md text={digest} />{digestAt && <p className="text-2xs text-fg-3 mt-2">Generated {fmtDate(digestAt)}</p>}</>
              : <p className="text-sm text-fg-3">Click Generate to build a consolidated brief of what's new, discontinued, and in stock across all {emails.length} updates.</p>}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
            {/* Updates feed */}
            <div className="lg:col-span-3 space-y-2">
              <p className="text-xs font-semibold text-fg-3 uppercase tracking-wide px-0.5">Updates</p>
              {emails.map(e => {
                const open = expanded.has(e.entryId);
                return (
                  <div key={e.entryId} className="rounded-xl ring-1 ring-inset ring-line bg-surface overflow-hidden">
                    <button onClick={() => toggle(e.entryId)} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5 hover:bg-subtle transition-colors">
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-fg-3 shrink-0 mt-0.5" /> : <ChevronRight className="w-3.5 h-3.5 text-fg-3 shrink-0 mt-0.5" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-fg leading-snug">{e.subject}</p>
                        <p className="text-2xs text-fg-3 mt-0.5">{fmtDate(e.received)}{e.attachments.length > 0 && <> · {e.attachments.length} file{e.attachments.length !== 1 ? 's' : ''}</>}</p>
                      </div>
                    </button>
                    {open && (
                      <div className="px-3.5 pb-3 pt-0.5 border-t border-line space-y-2">
                        {e.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-2">
                            {e.attachments.map(a => <AttChip key={a.index} email={e} att={a} />)}
                          </div>
                        )}
                        <pre className="text-sm text-fg-2 leading-relaxed whitespace-pre-wrap font-sans max-h-72 overflow-y-auto">{e.body || '(no text)'}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Ask-AI chat */}
            <div className="lg:col-span-2 lg:sticky lg:top-2">
              <AiSidePanel
              title="Ask about EL updates"
              sub="Across every internal update this year"
              intro={<>Ask anything across all {emails.length} updates — e.g. “latest on CBS batteries?”, “when did FlexiTech launch?”, “what's been discontinued?”</>}
              messages={chat}
              renderAnswer={t => <Md text={t} />}
              loading={chatLoading}
              input={chatInput}
              onInput={setChatInput}
              onSend={sendChat}
              placeholder="Ask about EL updates…"
              maxHeight="70vh"
            />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
