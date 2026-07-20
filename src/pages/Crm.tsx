// ─── Mini CRM — account cards with contacts, facts, AI insights, docs, quotes ─
// Accounts are auto-seeded from the customer field of past jobs (today these are
// quote names, later real customer names). Each account claims one or more match
// strings (aliases); duplicate cards can be merged into one account. Quotes,
// opportunities, AI facts/warnings and D&Q documents are all derived live.
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Plus, Search, Mail, Phone, Trash2, Pencil, ArrowLeft,
  Star, Check, X, RefreshCw, Loader2, UserPlus, GitMerge, AlertTriangle,
  Sparkles, FileText, ExternalLink, Pin, CheckSquare, Square, Database, Filter,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { openExternal, isTauri } from '../lib/shell';
import { Card, Pill, Button, fmtMoneyFull, relTime } from '../lib/ui';
import { api } from '../lib/api';
import type { CrmSyncStatus, CrmQuoteHit } from '../lib/api';
import type { CrmCompanyCard, CrmCompanyDetail, CrmContact, CrmQuote, CrmInsight, DqDoc } from '../types';
import type { ToastFn } from '../App';

const inputCls =
  'w-full h-8 px-2.5 rounded-lg text-xs bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ' +
  'ring-ink-200 dark:ring-ink-700 text-ink-900 dark:text-ink-50 placeholder:text-ink-400 ' +
  'focus:outline-none focus:ring-brand-400';

const selectCls =
  'h-7 px-2 rounded-lg bg-ink-50 dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700 ' +
  'text-ink-700 dark:text-ink-200 focus:outline-none focus:ring-brand-400 cursor-pointer';

export function CrmPage({ toast }: { toast: ToastFn }) {
  const [companies, setCompanies] = useState<CrmCompanyCard[]>([]);
  const [loading, setLoading]     = useState(true);
  const [query, setQuery]         = useState('');
  const [salesman, setSalesman]   = useState('');                 // '' = all
  const [sortBy, setSortBy]        = useState<'name' | 'quotes' | 'total' | 'recent'>('name');
  const [openOnly, setOpenOnly]   = useState(false);
  const [browseAll, setBrowseAll] = useState(false);
  const [quoteHits, setQuoteHits] = useState<CrmQuoteHit[]>([]);
  const [selectedId, setSelected] = useState<number | null>(null);
  const [adding, setAdding]       = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [picked, setPicked]       = useState<Set<number>>(new Set());
  const [targetId, setTargetId]   = useState<number | null>(null);
  const [merging, setMerging]     = useState(false);
  const [sync, setSync]           = useState<CrmSyncStatus | null>(null);
  const wasRunning                = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setCompanies(await api.crmCompanies()); }
    catch (e: any) { toast('err', `Couldn't load CRM: ${e.message}`); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const loadSync = useCallback(async () => {
    try { const s = await api.crmSyncStatus(); setSync(s); return s; } catch { return null; }
  }, []);
  useEffect(() => { loadSync(); }, [loadSync]);

  // Poll while a sync is running; on completion refresh + toast once.
  useEffect(() => {
    if (!sync?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        if (sync?.phase === 'done')     { toast('ok', sync.message); refresh(); }
        else if (sync?.phase === 'error')    toast('err', sync.message);
        else if (sync?.phase === 'canceled') toast('info', sync.message);
      }
      return;
    }
    wasRunning.current = true;
    const id = window.setInterval(loadSync, 1500);
    return () => window.clearInterval(id);
  }, [sync?.running, sync?.phase, sync?.message, loadSync, refresh, toast]);

  async function startSync() {
    try { const r = await api.crmSync(); if ((r as any).error) { toast('err', (r as any).error); return; } setSync(r); }
    catch (e: any) { toast('err', e.response?.data?.error || e.message); }
  }
  async function stopSync() { try { await api.crmSyncStop(); await loadSync(); } catch { /* ignore */ } }

  // Distinct salesmen across all accounts, for the filter dropdown.
  const salesmenList = useMemo(() => {
    const s = new Set<string>();
    companies.forEach(c => c.salesmen?.forEach(x => s.add(x)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [companies]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = companies.filter(c => {
      if (q && !(
        c.name.toLowerCase().includes(q) ||
        (c.tags || '').toLowerCase().includes(q) ||
        (c.country || '').toLowerCase().includes(q) ||
        (c.aliases || []).some(a => a.toLowerCase().includes(q)) ||
        (c.salesmen || []).some(s => s.toLowerCase().includes(q)))) return false;
      if (salesman && !(c.salesmen || []).includes(salesman)) return false;
      if (openOnly && !c.openCount) return false;
      return true;
    });
    const cmp: Record<typeof sortBy, (a: CrmCompanyCard, b: CrmCompanyCard) => number> = {
      name:   (a, b) => a.name.localeCompare(b.name),
      quotes: (a, b) => b.quoteCount - a.quoteCount,
      total:  (a, b) => b.totalValue - a.totalValue,
      recent: (a, b) => String(b.lastQuote || '').localeCompare(String(a.lastQuote || '')),
    };
    return [...list].sort(cmp[sortBy]);
  }, [companies, query, salesman, openOnly, sortBy]);

  const inSearch = query.trim().length >= 2;
  const inBrowse = browseAll || !!salesman || openOnly;

  // Debounced global quote search (local snapshot, instant) while typing.
  useEffect(() => {
    if (!inSearch) { setQuoteHits([]); return; }
    const t = setTimeout(() => { api.crmQuoteSearch(query.trim()).then(r => setQuoteHits(r.quotes)).catch(() => setQuoteHits([])); }, 180);
    return () => clearTimeout(t);
  }, [query, inSearch]);

  // Curated "best of" for the default view (no search, no filter).
  const highlights = useMemo(() => {
    const withQuotes = companies.filter(c => c.quoteCount > 0);
    const by = (f: (c: CrmCompanyCard) => number) => [...withQuotes].sort((a, b) => f(b) - f(a));
    return {
      open:   companies.filter(c => c.openCount > 0).sort((a, b) => b.openValue - a.openValue).slice(0, 8),
      top:    by(c => c.totalValue).slice(0, 8),
      recent: [...withQuotes].sort((a, b) => String(b.lastQuote || '').localeCompare(String(a.lastQuote || ''))).slice(0, 8),
    };
  }, [companies]);

  function toggleMerge() {
    setMergeMode(m => !m); setPicked(new Set()); setTargetId(null);
  }
  function togglePick(id: number) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size && (targetId == null || !next.has(targetId))) setTargetId([...next][0]);
      if (!next.size) setTargetId(null);
      return next;
    });
  }
  async function doMerge() {
    if (!targetId || picked.size < 2) return;
    setMerging(true);
    try {
      const sources = [...picked].filter(id => id !== targetId);
      await api.crmMerge(targetId, sources);
      toast('ok', `Merged ${sources.length} card${sources.length > 1 ? 's' : ''}`);
      toggleMerge(); refresh();
    } catch (e: any) { toast('err', e.response?.data?.error || e.message); }
    setMerging(false);
  }

  const targetName = companies.find(c => c.id === targetId)?.name;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search accounts & quotes — name, salesman, ref…"
            className={cn(inputCls, 'pl-8')} />
        </div>
        <span className="text-[11.5px] text-ink-500 dark:text-ink-400 tabular-nums">
          {filtered.length} {filtered.length === 1 ? 'account' : 'accounts'}
        </span>
        {sync && sync.snapshotCount > 0 && !sync.running && (
          <span className="text-[11px] text-ink-400">· {sync.snapshotCount} synced{sync.lastSyncedAt ? ` ${relTime(sync.lastSyncedAt)}` : ''}</span>
        )}
        <div className="flex-1" />
        {sync?.running ? (
          <Button tone="danger" size="sm" Icon={X} onClick={stopSync}>Stop sync</Button>
        ) : (
          <Button tone="outline" size="sm" Icon={Database} onClick={startSync}>
            {sync && sync.snapshotCount > 0 ? 'Update from SharePoint' : 'Sync from SharePoint'}
          </Button>
        )}
        <Button tone={mergeMode ? 'dark' : 'ghost'} size="sm" Icon={GitMerge} onClick={toggleMerge}>
          {mergeMode ? 'Cancel merge' : 'Merge'}
        </Button>
        <Button tone="ghost" size="sm" Icon={RefreshCw} onClick={refresh}>Refresh</Button>
        <Button tone="primary" size="sm" Icon={Plus} onClick={() => setAdding(true)}>Add account</Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap text-[11.5px]">
        <Filter className="w-3.5 h-3.5 text-ink-400" />
        <select value={salesman} onChange={e => setSalesman(e.target.value)} className={selectCls} title="Filter by salesman">
          <option value="">All salesmen</option>
          {salesmenList.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className={selectCls} title="Sort">
          <option value="name">Sort: Name A–Z</option>
          <option value="quotes">Sort: Most quotes</option>
          <option value="total">Sort: Highest total</option>
          <option value="recent">Sort: Most recent</option>
        </select>
        <button onClick={() => setOpenOnly(v => !v)}
          className={cn('h-7 px-2.5 rounded-lg ring-1 ring-inset transition-colors',
            openOnly ? 'bg-brand-600 text-white ring-brand-600' : 'ring-ink-200 dark:ring-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800')}>
          Open opps only
        </button>
        {(salesman || openOnly || sortBy !== 'name' || query || browseAll) && (
          <button onClick={() => { setSalesman(''); setOpenOnly(false); setSortBy('name'); setQuery(''); setBrowseAll(false); }}
            className="h-7 px-2 rounded-lg text-ink-500 hover:text-ink-800 dark:hover:text-ink-100 inline-flex items-center gap-1">
            <X className="w-3 h-3" /> {browseAll && !salesman && !openOnly && !query ? 'Back to highlights' : 'Clear'}
          </button>
        )}
      </div>

      {sync && (sync.running || sync.phase === 'error') && (
        <div className="rounded-lg ring-1 ring-ink-200/70 dark:ring-ink-800 bg-white dark:bg-ink-900 px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 text-[12px]">
            {sync.running && <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-500 shrink-0" />}
            {sync.phase === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
            <span className={cn('flex-1', sync.phase === 'error' ? 'text-red-600 dark:text-red-300' : 'text-ink-700 dark:text-ink-200')}>{sync.message}</span>
            {sync.pct != null && <span className="text-ink-400 tabular-nums">{sync.pct}%</span>}
          </div>
          {sync.running && (
            <div className="h-1.5 rounded-full bg-ink-100 dark:bg-ink-800 overflow-hidden">
              <div className="h-full bg-brand-500 rounded-full transition-all duration-500"
                style={{ width: `${sync.pct ?? 8}%` }} />
            </div>
          )}
        </div>
      )}

      {mergeMode && (
        <div className="flex items-center gap-3 flex-wrap p-3 rounded-lg ring-1 ring-brand-200 dark:ring-brand-800 bg-brand-50/50 dark:bg-brand-900/10 text-[12px]">
          <GitMerge className="w-4 h-4 text-brand-600 dark:text-brand-300 shrink-0" />
          <span className="text-ink-700 dark:text-ink-200">
            {picked.size < 2 ? 'Pick 2+ cards to merge into one account.' : `${picked.size} selected — keep as:`}
          </span>
          {picked.size >= 2 && (
            <select value={targetId ?? ''} onChange={e => setTargetId(Number(e.target.value))}
              className="h-7 px-2 rounded-lg text-[11.5px] bg-white dark:bg-ink-800 ring-1 ring-inset ring-ink-200 dark:ring-ink-700">
              {[...picked].map(id => <option key={id} value={id}>{companies.find(c => c.id === id)?.name}</option>)}
            </select>
          )}
          <div className="flex-1" />
          <Button tone="primary" size="sm" Icon={merging ? Loader2 : GitMerge} disabled={picked.size < 2 || merging}
            onClick={doMerge} className={merging ? '[&_svg]:animate-spin' : ''}>
            Merge into {targetName ? `"${targetName}"` : '…'}
          </Button>
        </div>
      )}

      {adding && (
        <CompanyForm
          onCancel={() => setAdding(false)}
          onSave={async vals => {
            try { await api.crmSaveCompany(vals); toast('ok', 'Account added'); setAdding(false); refresh(); }
            catch (e: any) { toast('err', e.response?.data?.error || e.message); }
          }} />
      )}

      <div className="grid grid-cols-12 gap-5 items-start">
      <div className="col-span-12 lg:col-span-4 space-y-5">
      {(() => {
        if (loading) return <div className="flex items-center justify-center py-20 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /></div>;
        if (companies.length === 0) return (
          <Card className="text-center py-16 text-ink-500 dark:text-ink-400 text-[13px]">
            No accounts yet. Click <b>Sync from SharePoint</b> to pull your quotes.
          </Card>
        );

        const renderGrid = (list: CrmCompanyCard[]) => (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {list.map(c => (
              <AccountCard key={c.id} c={c} mergeMode={mergeMode} picked={picked.has(c.id)}
                selected={selectedId === c.id}
                onClick={() => mergeMode ? togglePick(c.id) : setSelected(c.id)} />
            ))}
          </div>
        );

        // ── Search mode: matching accounts + matching quotes ──────────────────
        if (inSearch) {
          const accs = filtered.slice(0, 12);
          return (
            <div className="space-y-5">
              <Section title="Accounts" count={filtered.length}>
                {accs.length ? renderGrid(accs) : <Empty>No accounts match “{query}”.</Empty>}
                {filtered.length > accs.length && (
                  <button onClick={() => { setBrowseAll(true); setQuery(''); }}
                    className="mt-3 text-[12px] text-brand-600 dark:text-brand-300 hover:underline">
                    +{filtered.length - accs.length} more accounts — browse all →
                  </button>
                )}
              </Section>
              <Section title="Quotes" count={quoteHits.length}>
                {quoteHits.length ? (
                  <div className="rounded-xl ring-1 ring-ink-200/70 dark:ring-ink-800 divide-y divide-ink-100 dark:divide-ink-800 overflow-hidden">
                    {quoteHits.map(q => <QuoteHitRow key={q.id} q={q} onOpen={() => q.companyId && setSelected(q.companyId)} />)}
                  </div>
                ) : <Empty>No quotes match “{query}”.</Empty>}
              </Section>
            </div>
          );
        }

        // ── Browse-all / filtered mode ────────────────────────────────────────
        if (inBrowse) {
          return (
            <Section title={salesman ? `Accounts · ${salesman}` : 'All accounts'} count={filtered.length}>
              {filtered.length ? renderGrid(filtered) : <Empty>No accounts match the filters.</Empty>}
            </Section>
          );
        }

        // ── Default: curated "best of" ────────────────────────────────────────
        return (
          <div className="space-y-6">
            {highlights.open.length > 0 && (
              <Section title="Open opportunities" count={companies.filter(c => c.openCount > 0).length}>
                {renderGrid(highlights.open)}
              </Section>
            )}
            <Section title="Biggest accounts">{renderGrid(highlights.top)}</Section>
            <Section title="Recently quoted">{renderGrid(highlights.recent)}</Section>
            <div className="flex justify-center pt-1">
              <Button tone="outline" size="md" onClick={() => setBrowseAll(true)}>
                Browse all {companies.length} accounts →
              </Button>
            </div>
          </div>
        );
      })()}
      </div>

      <div className="col-span-12 lg:col-span-8 lg:border-l-2 lg:border-l-violet-300 dark:lg:border-l-violet-500/40 lg:pl-5">
        {selectedId != null ? (
          <CompanyDetail id={selectedId} toast={toast} onBack={() => { setSelected(null); refresh(); }} />
        ) : (
          <div className="rounded-xl ring-1 ring-ink-200/70 dark:ring-ink-800 bg-white dark:bg-ink-900 py-24 px-6 flex flex-col items-center justify-center text-center">
            <Database className="w-8 h-8 text-ink-300 dark:text-ink-600 mb-3" />
            <p className="text-[13px] font-medium text-ink-500 dark:text-ink-400">Select an account</p>
            <p className="text-[11.5px] text-ink-400 mt-1">Pick a card on the left to see contacts, quotes, facts and documents.</p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ─── Account card ────────────────────────────────────────────────────────────
function AccountCard({ c, mergeMode, picked, selected, onClick }: { c: CrmCompanyCard; mergeMode: boolean; picked: boolean; selected?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn(
        'w-full text-left ring-1 rounded-xl p-4 transition-all',
        mergeMode && picked ? 'bg-white dark:bg-ink-900 ring-2 ring-brand-500 dark:ring-brand-400 shadow-sm'
          : selected ? 'ring-2 ring-violet-500 dark:ring-violet-400 bg-ink-100 dark:bg-ink-800 shadow-md'
          : 'bg-white dark:bg-ink-900 ring-ink-200/70 dark:ring-ink-800 hover:ring-brand-300 dark:hover:ring-brand-700 hover:shadow-sm')}>
      <div className="flex items-start gap-2.5 mb-3">
        {mergeMode ? (
          picked ? <CheckSquare className="w-5 h-5 text-brand-600 dark:text-brand-300 shrink-0" />
                 : <Square className="w-5 h-5 text-ink-300 dark:text-ink-600 shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 grid place-items-center text-[12px] font-bold text-white shrink-0">
            {c.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 truncate leading-tight">{c.name}</h3>
          <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">
            {c.lastQuote ? `Last quote ${relTime(c.lastQuote)}` : 'No quotes yet'}
            {c.aliasCount > 1 && ` · ${c.aliasCount} names`}
          </p>
        </div>
        {c.country && <Pill tone="neutral">{c.country}</Pill>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Quotes"   value={String(c.quoteCount)} />
        <Stat label="Contacts" value={String(c.contactCount)} />
        <Stat label="Total"    value={c.totalValue ? fmtMoneyFull(c.totalValue, '€') : '—'} tone={c.totalValue ? 'brand' : 'muted'} />
      </div>
      {c.salesmen.length > 0 && (
        <p className="text-[10.5px] text-ink-400 mt-2 truncate">{c.salesmen.join(', ')}</p>
      )}
    </button>
  );
}

// ─── Section wrapper + quote-hit row + empty state ───────────────────────────
function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">{title}</h2>
        {count != null && <span className="text-[11px] text-ink-400 tabular-nums">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-ink-400 py-6 text-center">{children}</p>;
}

function QuoteHitRow({ q, onOpen }: { q: CrmQuoteHit; onOpen: () => void }) {
  const stateTone = q.state === 'won' ? 'ok' : q.state === 'lost' ? 'err' : 'brand';
  return (
    <button onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-3.5 py-2.5 bg-white dark:bg-ink-900 hover:bg-ink-50 dark:hover:bg-ink-800/50 transition-colors">
      <FileText className="w-3.5 h-3.5 text-ink-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink-900 dark:text-ink-50 truncate">{q.name || q.account}</div>
        <div className="text-[11px] text-ink-500 dark:text-ink-400 truncate">
          {q.account}{q.salesman ? ` · ${q.salesman}` : ''}{q.ref ? ` · ${q.ref}` : ''}
        </div>
      </div>
      <span className="text-[12px] font-medium tabular-nums text-ink-800 dark:text-ink-100 shrink-0">{q.price == null ? '—' : fmtMoneyFull(q.price, '€')}</span>
      <Pill tone={stateTone as any}>{q.state}</Pill>
    </button>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'brand' | 'muted' }) {
  return (
    <div className="rounded-lg bg-ink-50 dark:bg-ink-800/60 py-1.5">
      <div className={cn('text-[13px] font-semibold tabular-nums leading-none',
        tone === 'brand' ? 'text-brand-600 dark:text-brand-300' : 'text-ink-800 dark:text-ink-100')}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wide text-ink-400 mt-1">{label}</div>
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
function CompanyDetail({ id, toast, onBack }: { id: number; toast: ToastFn; onBack: () => void }) {
  const [data, setData]       = useState<CrmCompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [contactForm, setContactForm] = useState<Partial<CrmContact> | null>(null);
  const [factText, setFactText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.crmCompany(id)); }
    catch (e: any) { toast('err', e.message); }
    setLoading(false);
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <div className="flex items-center justify-center py-20 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }
  const { company, contacts, facts, quotes, opp, enriched } = data;

  async function saveContact(vals: Partial<CrmContact>) {
    try {
      await api.crmSaveContact({ companyId: id, name: vals.name!, role: vals.role, email: vals.email, phone: vals.phone, notes: vals.notes, id: vals.id });
      toast('ok', vals.id ? 'Contact updated' : 'Contact added'); setContactForm(null); load();
    } catch (e: any) { toast('err', e.response?.data?.error || e.message); }
  }
  async function delContact(cid: number) { await api.crmDeleteContact(cid); load(); }
  async function addFact() {
    const t = factText.trim(); if (!t) return;
    try { await api.crmAddFact(id, t); setFactText(''); load(); }
    catch (e: any) { toast('err', e.message); }
  }
  async function delFact(fid: number) { await api.crmDeleteFact(fid); load(); }
  async function setState(q: CrmQuote, state: 'open' | 'won' | 'lost') {
    try { await api.crmQuoteState(q.key, state); load(); }
    catch (e: any) { toast('err', e.message); }
  }
  // Open a quote's PDF — local archive if this machine processed it, else the
  // D&Q Store copy on SharePoint. In a plain browser we pre-open a blank tab
  // synchronously (inside the click) so the popup isn't blocked after the await;
  // under Tauri window.open is broken, so we resolve the URL first and route it
  // through the OS browser via openExternal.
  async function openPdf(q: CrmQuote) {
    const pre = isTauri() ? null : window.open('', '_blank');
    try {
      const res = await fetch(`/api/crm/quote/${q.id}/pdf`);
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok || !j.url) {
        pre?.close();
        toast('warn', j.error || 'PDF not found for this quote.');
        return;
      }
      if (pre) pre.location.href = j.url; else await openExternal(j.url);
    } catch (e: any) { pre?.close(); toast('err', e.message); }
  }
  const totalIssued = quotes.reduce((s, q) => s + (q.price || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button tone="ghost" size="sm" Icon={ArrowLeft} onClick={onBack}>All accounts</Button>
        <div className="flex-1" />
        <Button tone="outline" size="sm" Icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>
        <Button tone="ghost" size="sm" Icon={Trash2}
          onClick={async () => {
            if (!confirm(`Delete "${company.name}" and its contacts/facts? Quotes in history are not affected.`)) return;
            await api.crmDeleteCompany(id); toast('ok', 'Account deleted'); onBack();
          }}>Delete</Button>
      </div>

      {editing && (
        <CompanyForm initial={company}
          onCancel={() => setEditing(false)}
          onSave={async vals => {
            try { await api.crmSaveCompany({ ...vals, id }); toast('ok', 'Saved'); setEditing(false); load(); }
            catch (e: any) { toast('err', e.response?.data?.error || e.message); }
          }} />
      )}

      {/* Header */}
      <Card className="animate-fade-up">
        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 grid place-items-center text-[18px] font-bold text-white shrink-0">
            {company.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-semibold text-ink-900 dark:text-ink-50">{company.name}</h2>
              {company.country && <Pill tone="neutral">{company.country}</Pill>}
            </div>
            {(company.aliases?.length ?? 0) > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <span className="text-[10px] uppercase tracking-wide text-ink-400">Names:</span>
                {company.aliases!.map(a => <Pill key={a} tone="neutral">{a}</Pill>)}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {(company.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => (
                <Pill key={t} tone="violet">{t}</Pill>
              ))}
            </div>
            {company.notes && <p className="text-[12px] text-ink-600 dark:text-ink-300 mt-2 whitespace-pre-wrap">{company.notes}</p>}
          </div>
          <div className="flex gap-2 shrink-0">
            <HeaderStat label="Quotes" value={String(quotes.length)} />
            <HeaderStat label="Total issued" value={enriched ? fmtMoneyFull(totalIssued, '€') : '—'} tone="brand" />
            <HeaderStat label="Open opps" value={String(opp.count)} />
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Contacts */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">Contacts</h3>
            <Button tone="ghost" size="sm" Icon={UserPlus} onClick={() => setContactForm({})}>Add</Button>
          </div>
          {contactForm && <ContactForm initial={contactForm} onCancel={() => setContactForm(null)} onSave={saveContact} />}
          {contacts.length === 0 && !contactForm ? (
            <p className="text-[12px] text-ink-400 py-4 text-center">
              {enriched ? 'No contacts yet.' : 'Connect to JOE to pull the salesman as a contact, or add one.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {contacts.map(ct => (
                <li key={ct.id} className="group flex items-start gap-2.5 p-2.5 rounded-lg bg-ink-50 dark:bg-ink-800/50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-ink-900 dark:text-ink-50 truncate">{ct.name}</span>
                      {ct.role && <span className="text-[11px] text-ink-500 dark:text-ink-400">· {ct.role}</span>}
                      {ct.auto && <Pill tone="brand">from quotes</Pill>}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11.5px]">
                      {ct.email && <a href={`mailto:${ct.email}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-300 hover:underline"><Mail className="w-3 h-3" />{ct.email}</a>}
                      {ct.phone && <a href={`tel:${ct.phone}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-600 dark:text-ink-300"><Phone className="w-3 h-3" />{ct.phone}</a>}
                    </div>
                    {ct.notes && <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 whitespace-pre-wrap">{ct.notes}</p>}
                  </div>
                  {!ct.auto && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setContactForm(ct)} className="p-1 text-ink-400 hover:text-brand-600"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => delContact(ct.id)} className="p-1 text-ink-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Facts */}
        <Card>
          <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 mb-3">Facts</h3>
          <div className="flex gap-2 mb-3">
            <input value={factText} onChange={e => setFactText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addFact(); }}
              placeholder="e.g. pays at 60 days, prefers EL kits…" className={inputCls} />
            <Button tone="primary" size="sm" Icon={Plus} onClick={addFact}>Add</Button>
          </div>
          {facts.length === 0 ? (
            <p className="text-[12px] text-ink-400 py-2 text-center">No facts noted yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {facts.map(f => (
                <li key={f.id} className="group flex items-start gap-2 text-[12px] text-ink-700 dark:text-ink-200">
                  {f.source === 'ai'
                    ? <Sparkles className="w-3 h-3 text-violet-500 mt-1 shrink-0" />
                    : <Star className="w-3 h-3 text-amber-500 mt-1 shrink-0" />}
                  <span className="flex-1">{f.text}</span>
                  <button onClick={() => delFact(f.id)} className="p-0.5 text-ink-300 hover:text-red-600 opacity-0 group-hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <InsightsCard id={id} toast={toast} onPinned={load} />
        <DocsCard id={id} toast={toast} />
      </div>

      {/* Quotes / opportunities */}
      <Card padded={false}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 gap-3">
          <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50">Quotes &amp; opportunities</h3>
          <span className="text-[11px] text-ink-400 text-right">
            {enriched ? 'Prices & salesmen from the Quotations List' : 'Connect to JOE to load prices & salesmen'}
          </span>
        </div>
        {quotes.length === 0 ? (
          <p className="text-[12px] text-ink-400 py-6 text-center">No quotes recorded for this account yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-ink-400 border-y border-ink-100 dark:border-ink-800">
                  <th className="text-left font-medium px-5 py-2">Ref</th>
                  <th className="text-left font-medium px-3 py-2">Quote</th>
                  <th className="text-left font-medium px-3 py-2">Salesman</th>
                  <th className="text-right font-medium px-3 py-2">Price</th>
                  <th className="text-left font-medium px-3 py-2">Last run</th>
                  <th className="text-right font-medium px-5 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => (
                  <tr key={q.id} className="border-b border-ink-50 dark:border-ink-800/60">
                    <td className="px-5 py-2 font-mono text-[10.5px] text-ink-500 dark:text-ink-400 whitespace-nowrap">{q.ref || '—'}</td>
                    <td className="px-3 py-2 text-ink-800 dark:text-ink-100">
                      <button onClick={() => openPdf(q)} title="Open archived PDF"
                        className="inline-flex items-center gap-1 text-left hover:text-brand-600 dark:hover:text-brand-300 hover:underline">
                        <FileText className="w-3 h-3 shrink-0 opacity-60" />
                        {q.name || '—'}
                      </button>
                      {q.status && <span className="ml-1.5 text-[10px] text-ink-400">· {q.status}</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-600 dark:text-ink-300">{q.salesman || '—'}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-ink-800 dark:text-ink-100">{q.price == null ? '—' : fmtMoneyFull(q.price, '€')}</td>
                    <td className="px-3 py-2 text-ink-500 dark:text-ink-400 whitespace-nowrap">
                      {relTime(q.timestamp)}{q.runs > 1 && <span className="text-ink-400"> · {q.runs}×</span>}
                    </td>
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <StateBtn active={q.state === 'open'} tone="brand" onClick={() => setState(q, 'open')}>Open</StateBtn>
                        <StateBtn active={q.state === 'won'}  tone="ok"   onClick={() => setState(q, 'won')}>Won</StateBtn>
                        <StateBtn active={q.state === 'lost'} tone="err"  onClick={() => setState(q, 'lost')}>Lost</StateBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-100 dark:border-ink-800 text-[11.5px]">
                  <td className="px-5 py-2 text-ink-400 uppercase tracking-wide text-[10px]" colSpan={3}>Total issued</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-brand-600 dark:text-brand-300">{enriched ? fmtMoneyFull(totalIssued, '€') : '—'}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── AI insights ─────────────────────────────────────────────────────────────
function InsightsCard({ id, toast, onPinned }: { id: number; toast: ToastFn; onPinned: () => void }) {
  const [items, setItems]   = useState<CrmInsight[] | null>(null);
  const [loading, setLoad]  = useState(false);

  const run = useCallback(async (refresh = false) => {
    setLoad(true);
    try {
      const r = await api.crmInsights(id, refresh);
      if (r.error) toast('warn', r.error);
      setItems(r.items || []);
    } catch (e: any) { toast('err', e.message); }
    setLoad(false);
  }, [id, toast]);

  async function pin(text: string) {
    try { await api.crmAddFact(id, text, 'ai'); toast('ok', 'Pinned to facts'); onPinned(); }
    catch (e: any) { toast('err', e.message); }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-violet-500" /> AI insights
        </h3>
        <Button tone="ghost" size="sm" Icon={loading ? Loader2 : RefreshCw} disabled={loading}
          onClick={() => run(items != null)} className={loading ? '[&_svg]:animate-spin' : ''}>
          {items == null ? 'Generate' : 'Regenerate'}
        </Button>
      </div>
      {items == null ? (
        <p className="text-[12px] text-ink-400 py-4 text-center">Generate facts &amp; warnings from this account's run history.</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-ink-400 py-4 text-center">Nothing noteworthy in the data yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className={cn('group flex items-start gap-2 p-2 rounded-lg text-[12px]',
              it.type === 'warning' ? 'bg-amber-50 dark:bg-amber-900/15 text-amber-800 dark:text-amber-200'
                                    : 'bg-violet-50 dark:bg-violet-900/15 text-ink-700 dark:text-ink-200')}>
              {it.type === 'warning'
                ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                : <Sparkles className="w-3.5 h-3.5 text-violet-500 mt-0.5 shrink-0" />}
              <span className="flex-1">{it.text}</span>
              <button onClick={() => pin(it.text)} title="Pin to facts"
                className="p-0.5 text-ink-300 hover:text-brand-600 opacity-0 group-hover:opacity-100"><Pin className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── D&Q documents ───────────────────────────────────────────────────────────
function DocsCard({ id, toast }: { id: number; toast: ToastFn }) {
  const [docs, setDocs]    = useState<DqDoc[] | null>(null);
  const [loading, setLoad] = useState(false);

  async function run() {
    setLoad(true);
    try {
      const r = await api.crmDocs(id);
      if (r.error) toast('warn', r.error);
      setDocs(r.results || []);
    } catch (e: any) { toast('err', e.message); }
    setLoad(false);
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-ink-900 dark:text-ink-50 inline-flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-brand-500" /> D&amp;Q documents
        </h3>
        <Button tone="ghost" size="sm" Icon={loading ? Loader2 : RefreshCw} disabled={loading}
          onClick={run} className={loading ? '[&_svg]:animate-spin' : ''}>
          {docs == null ? 'Load' : 'Reload'}
        </Button>
      </div>
      {docs == null ? (
        <p className="text-[12px] text-ink-400 py-4 text-center">Search the D&amp;Q Store for this account's documents (needs JOE connection).</p>
      ) : docs.length === 0 ? (
        <p className="text-[12px] text-ink-400 py-4 text-center">No matching documents found.</p>
      ) : (
        <ul className="space-y-1.5">
          {docs.map((d, i) => (
            <li key={i}>
              <a href={d.url} target="_blank" rel="noreferrer"
                className="group flex items-center gap-2 p-2 rounded-lg hover:bg-ink-50 dark:hover:bg-ink-800/50 text-[12px]">
                <FileText className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                <span className="flex-1 truncate text-ink-700 dark:text-ink-200">{d.title || d.filename}</span>
                {d.ext && <span className="text-[10px] uppercase text-ink-400">{d.ext}</span>}
                <ExternalLink className="w-3 h-3 text-ink-300 opacity-0 group-hover:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HeaderStat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'brand' | 'muted' }) {
  return (
    <div className="rounded-lg bg-ink-50 dark:bg-ink-800/60 px-3 py-2 text-right min-w-[88px]">
      <div className={cn('text-[15px] font-semibold tabular-nums leading-none',
        tone === 'brand' ? 'text-brand-600 dark:text-brand-300' : 'text-ink-800 dark:text-ink-100')}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wide text-ink-400 mt-1">{label}</div>
    </div>
  );
}

function StateBtn({ active, tone, onClick, children }: { active: boolean; tone: 'brand' | 'ok' | 'err'; onClick: () => void; children: React.ReactNode }) {
  const on = { brand: 'bg-brand-600 text-white', ok: 'bg-emerald-600 text-white', err: 'bg-red-600 text-white' }[tone];
  return (
    <button onClick={onClick}
      className={cn('px-2 h-6 rounded-md text-[10.5px] font-medium transition-colors',
        active ? on : 'text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800')}>
      {children}
    </button>
  );
}

// ─── Forms ───────────────────────────────────────────────────────────────────
function CompanyForm({
  initial, onSave, onCancel,
}: {
  initial?: { name: string; country: string | null; tags: string | null; notes: string | null };
  onSave: (v: { name: string; country: string; tags: string; notes: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName]       = useState(initial?.name || '');
  const [country, setCountry] = useState(initial?.country || '');
  const [tags, setTags]       = useState(initial?.tags || '');
  const [notes, setNotes]     = useState(initial?.notes || '');
  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account name *"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
        <Field label="Country"><input className={inputCls} value={country} onChange={e => setCountry(e.target.value)} placeholder="UK, BE, FR…" /></Field>
        <Field label="Tags (comma-separated)" full><input className={inputCls} value={tags} onChange={e => setTags(e.target.value)} placeholder="installer, key account, EL" /></Field>
        <Field label="Notes" full>
          <textarea className={cn(inputCls, 'h-auto py-2 resize-y')} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button tone="ghost" size="sm" Icon={X} onClick={onCancel}>Cancel</Button>
        <Button tone="primary" size="sm" Icon={Check} onClick={() => name.trim() && onSave({ name, country, tags, notes })}>Save</Button>
      </div>
    </Card>
  );
}

function ContactForm({
  initial, onSave, onCancel,
}: {
  initial: Partial<CrmContact>;
  onSave: (v: Partial<CrmContact>) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<Partial<CrmContact>>(initial);
  const set = (k: keyof CrmContact) => (e: React.ChangeEvent<HTMLInputElement>) => setV(p => ({ ...p, [k]: e.target.value }));
  return (
    <div className="mb-3 p-3 rounded-lg ring-1 ring-brand-200 dark:ring-brand-800 bg-brand-50/40 dark:bg-brand-900/10">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={inputCls} placeholder="Name *" value={v.name || ''} onChange={set('name')} autoFocus />
        <input className={inputCls} placeholder="Role (Buyer, Engineer…)" value={v.role || ''} onChange={set('role')} />
        <input className={inputCls} placeholder="Email" value={v.email || ''} onChange={set('email')} />
        <input className={inputCls} placeholder="Phone" value={v.phone || ''} onChange={set('phone')} />
        <input className={cn(inputCls, 'sm:col-span-2')} placeholder="Notes" value={v.notes || ''} onChange={set('notes')} />
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <Button tone="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button tone="primary" size="sm" Icon={Check} onClick={() => v.name?.trim() && onSave(v)}>Save</Button>
      </div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={cn('block', full && 'sm:col-span-2')}>
      <span className="block text-[10.5px] uppercase tracking-wide text-ink-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
