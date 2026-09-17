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
  Inbox, Users, User, Paperclip, FolderOpen, ArrowLeftRight, Building2,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { openExternal, isTauri } from '../lib/shell';
import { Card, Pill, Button, fmtMoneyFull, relTime } from '../lib/ui';
import { EmptyState, Input as UiInput, Select as UiSelect, Switch as UiSwitch, Button as UiButton, IconButton as UiIconButton } from '../ui';
import { api } from '../lib/api';
import { confirmAsync } from '../lib/notify';
import { failed, plural } from '../lib/errors';
import type { CrmSyncStatus, CrmQuoteHit } from '../lib/api';
import type {
  CrmCompanyCard, CrmCompanyDetail, CrmContact, CrmQuote, CrmInsight, DqDoc,
  CrmMailQuote, CrmMailScanStatus,
} from '../types';
import type { ToastFn } from '../App';

const inputCls =
  'w-full h-8 px-2.5 rounded-panel text-xs bg-surface border border-line-2 ' +
  'text-fg placeholder:text-fg-3 focus:outline-none focus:border-accent-line';

const selectCls =
  'h-7 px-2 rounded-panel bg-surface border border-line-2 ' +
  'text-fg-2 focus:outline-none focus:border-accent-line cursor-pointer';

export function CrmPage({ toast }: { toast: ToastFn }) {
  // Two sources of truth sit side by side: the SharePoint Quotations List
  // (Accounts) and the mailbox sweep (Mailbox quotes). They answer different
  // questions — "who is this customer?" vs "what quotes can I see from here?".
  const [tab, setTab]             = useState<'accounts' | 'mailbox'>('accounts');
  const [mailCounts, setCounts]   = useState<{ total: number; mine: number; team: number } | null>(null);
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
    catch (e: any) { toast('err', failed('load the CRM accounts', e)); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const loadSync = useCallback(async () => {
    try { const s = await api.crmSyncStatus(); setSync(s); return s; } catch { return null; }
  }, []);
  useEffect(() => { loadSync(); }, [loadSync]);

  // Tab badge only — the mailbox tab loads its own rows when it opens.
  useEffect(() => { api.crmMailStatus().then(s => setCounts(s.counts)).catch(() => {}); }, []);

  // Poll while a sync is running; on completion refresh + toast once.
  useEffect(() => {
    if (!sync?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        if (sync?.phase === 'done')     { toast('ok', sync.message || 'CRM sync finished'); refresh(); }
        else if (sync?.phase === 'error')    toast('err', failed('finish the CRM sync', sync.message));
        else if (sync?.phase === 'canceled') toast('info', 'CRM sync cancelled — nothing was changed');
      }
      return;
    }
    wasRunning.current = true;
    // 1.5s is right for a progress bar being watched, wasteful for one that is not.
    const tick = () => { if (!document.hidden) loadSync(); };
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, [sync?.running, sync?.phase, sync?.message, loadSync, refresh, toast]);

  async function startSync() {
    try { const r = await api.crmSync(); if ((r as any).error) { toast('err', failed('start the CRM sync', (r as any).error)); return; } setSync(r); }
    catch (e: any) { toast('err', failed('start the CRM sync', e)); }
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
      toast('ok', `Merged ${plural(sources.length, 'account')} into ${companies.find(c => c.id === targetId)?.name || 'the target account'}`);
      toggleMerge(); refresh();
    } catch (e: any) { toast('err', failed('merge the accounts', e)); }
    setMerging(false);
  }

  const targetName = companies.find(c => c.id === targetId)?.name;

  return (
    <div className="space-y-5">
      {/* ── Source switch ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 p-0.5 rounded-control w-fit bg-subtle border border-line">
        <TabBtn active={tab === 'accounts'} Icon={Database} onClick={() => setTab('accounts')}
                label="Accounts" sub="from SharePoint" count={companies.length || null} />
        <TabBtn active={tab === 'mailbox'} Icon={Inbox} onClick={() => setTab('mailbox')}
                label="Mailbox quotes" sub="from Outlook" count={mailCounts?.total || null} />
      </div>

      {tab === 'mailbox' ? (
        <MailboxQuotes
          toast={toast}
          onCounts={setCounts}
          onOpenAccount={id => { setSelected(id); setTab('accounts'); }} />
      ) : (
      <>
      <div className="flex items-center gap-3 flex-wrap">
        <UiInput icon={Search} className="flex-1 min-w-48 max-w-md"
          value={query} onChange={e => setQuery(e.currentTarget.value)}
          placeholder="Search accounts & quotes — name, salesman, ref…" />
        <span className="mono text-xs text-fg-3">
          {filtered.length} {filtered.length === 1 ? 'account' : 'accounts'}
        </span>
        {sync && sync.snapshotCount > 0 && !sync.running && (
          <span className="text-xs text-fg-4">· {sync.snapshotCount} synced{sync.lastSyncedAt ? ` ${relTime(sync.lastSyncedAt)}` : ''}</span>
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
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Filter className="w-3.5 h-3.5 text-fg-3" />
        <UiSelect searchable w="calc(var(--sp-16) * 3)" aria-label="Filter by salesman"
          value={salesman || '__all'} onChange={v => setSalesman(!v || v === '__all' ? '' : v)}
          data={[{ value: '__all', label: 'All salesmen' }, ...salesmenList.map(s => ({ value: s, label: s }))]} />
        <UiSelect w="calc(var(--sp-16) * 2.75)" aria-label="Sort"
          value={sortBy} onChange={v => v && setSortBy(v as any)}
          data={[
            { value: 'name', label: 'Sort: Name A–Z' },
            { value: 'quotes', label: 'Sort: Most quotes' },
            { value: 'total', label: 'Sort: Highest total' },
            { value: 'recent', label: 'Sort: Most recent' },
          ]} />
        <UiSwitch label="Open opps only" checked={openOnly} onChange={e => setOpenOnly(e.currentTarget.checked)} />
        {(salesman || openOnly || sortBy !== 'name' || query || browseAll) && (
          <button onClick={() => { setSalesman(''); setOpenOnly(false); setSortBy('name'); setQuery(''); setBrowseAll(false); }}
            className="h-7 px-2 rounded-panel text-fg-3 hover:text-fg inline-flex items-center gap-1">
            <X className="w-3 h-3" /> {browseAll && !salesman && !openOnly && !query ? 'Back to highlights' : 'Clear'}
          </button>
        )}
      </div>

      {sync && (sync.running || sync.phase === 'error') && (
        <div className="rounded-panel v3-card px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {sync.running && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />}
            {sync.phase === 'error' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--err)' }} />}
            <span className="flex-1" style={{ color: sync.phase === 'error' ? 'var(--err)' : 'var(--t2)' }}>{sync.message}</span>
            {sync.pct != null && <span className="text-fg-4 tabular-nums">{sync.pct}%</span>}
          </div>
          {sync.running && (
            <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
              <div className="h-full rounded-full transition-all duration"
                style={{ width: `${sync.pct ?? 8}%`, background: 'var(--accent)' }} />
            </div>
          )}
        </div>
      )}

      {mergeMode && (
        <div className="flex items-center gap-3 flex-wrap p-3 rounded-panel text-sm" style={{ border: 'var(--hairline) solid var(--accent-line)', background: 'var(--accent-soft)' }}>
          <GitMerge className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-text)' }} />
          <span className="text-fg-2">
            {picked.size < 2 ? 'Pick 2+ cards to merge into one account.' : `${picked.size} selected — keep as:`}
          </span>
          {picked.size >= 2 && (
            <select value={targetId ?? ''} onChange={e => setTargetId(Number(e.target.value))}
              className="h-7 px-2 rounded-panel text-xs bg-surface border border-line-2 text-fg">
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
            try { await api.crmSaveCompany(vals); toast('ok', `Account "${vals.name}" added`); setAdding(false); refresh(); }
            catch (e: any) { toast('err', failed('add the account', e)); }
          }} />
      )}

      <div className="grid grid-cols-12 gap-6 items-start">
      <div className="col-span-12 lg:col-span-4 space-y-6 min-w-0">
      {(() => {
        if (loading) return <div className="flex items-center justify-center py-20 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>;
        if (companies.length === 0) return (
          <EmptyState icon={Database} title="No accounts yet"
            description={<>Use <b className="font-medium text-fg-2">Sync from SharePoint</b> to pull your quotes.</>} />
        );

        const renderGrid = (list: CrmCompanyCard[]) => (
          <div className="flex flex-col">
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
                    className="mt-3 text-sm hover:underline" style={{ color: 'var(--accent-text)' }}>
                    +{filtered.length - accs.length} more accounts — browse all →
                  </button>
                )}
              </Section>
              <Section title="Quotes" count={quoteHits.length}>
                {quoteHits.length ? (
                  <div className="flex flex-col divide-y divide-line">
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

      <div className="col-span-12 lg:col-span-8 lg:border-l lg:border-line lg:pl-6 min-w-0">
        {selectedId != null ? (
          <CompanyDetail id={selectedId} toast={toast} onBack={() => { setSelected(null); refresh(); }} />
        ) : (
          <div className="py-16">
            <EmptyState icon={Database} title="Select an account"
              description="Pick one on the left to see contacts, quotes, facts and documents." />
          </div>
        )}
      </div>
      </div>
      </>
      )}
    </div>
  );
}

// ─── Source tab button ───────────────────────────────────────────────────────
function TabBtn({ active, Icon, label, sub, count, onClick }: {
  active: boolean; Icon: typeof Database; label: string; sub: string;
  count: number | null; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={cn('flex items-center gap-2 h-9 px-3 rounded-control transition-colors',
        active ? 'bg-surface ring-1 ring-line-2' : 'hover:bg-hover')}>
      <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: active ? 'var(--accent)' : 'var(--t3)' }} />
      <span className="text-left leading-tight">
        <span className={cn('block text-sm', active ? 'font-semibold text-fg' : 'text-fg-2')}>
          {label}
        </span>
        <span className="block text-2xs text-fg-4">{sub}</span>
      </span>
      {count != null && (
        <span className="mono text-2xs text-fg-3">
          {count}
        </span>
      )}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Mailbox quotes — everything quoted that this desk can see ──────────────
// ═══════════════════════════════════════════════════════════════════════════
// Two lists off one sweep: "Mine" is the work this desk issued or filed, "Team"
// is what colleagues issued and merely shared here (the UKQuoteFactoryEL box,
// their "Completed by …" folders, cc'd mail in the personal box). Every row
// carries the reason for its verdict, and any row can be moved by hand.
function MailboxQuotes({ toast, onOpenAccount, onCounts }: {
  toast: ToastFn;
  onOpenAccount: (id: number) => void;
  onCounts: (c: { total: number; mine: number; team: number }) => void;
}) {
  const [side, setSide]       = useState<'mine' | 'team'>('mine');
  const [quotes, setQuotes]   = useState<CrmMailQuote[]>([]);
  const [counts, setCounts]   = useState({ total: 0, mine: 0, team: 0 });
  const [lastScan, setLast]   = useState<string | null>(null);
  const [query, setQuery]     = useState('');
  const [days, setDays]       = useState(90);
  const [loading, setLoading] = useState(true);
  const [status, setStatus]   = useState<CrmMailScanStatus | null>(null);
  const wasRunning            = useRef(false);

  const applyCounts = useCallback((c: { total: number; mine: number; team: number }) => {
    setCounts(c); onCounts(c);
  }, [onCounts]);

  const load = useCallback(async (q = query, s = side) => {
    setLoading(true);
    try {
      const r = await api.crmMailQuotes(s, q.trim());
      setQuotes(r.quotes); applyCounts(r.counts); setLast(r.lastScanAt);
    } catch (e: any) { toast('err', failed('load the quote list', e)); }
    setLoading(false);
  }, [query, side, applyCounts, toast]);

  useEffect(() => { load(query, side); /* eslint-disable-next-line */ }, [side]);

  // Debounce typing, then re-query the server (the list can run to hundreds).
  useEffect(() => {
    const t = setTimeout(() => load(query, side), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const loadStatus = useCallback(async () => {
    try { const s = await api.crmMailStatus(); setStatus(s); return s; } catch { return null; }
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll while a sweep runs; refresh the list once it lands.
  useEffect(() => {
    if (!status?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        if (status?.phase === 'done')  { toast('ok', status.message || 'Mailbox scan finished'); load(query, side); }
        if (status?.phase === 'error')   toast('err', failed('finish the mailbox scan', status.message));
      }
      return;
    }
    wasRunning.current = true;
    const tick = () => { if (!document.hidden) loadStatus(); };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running, status?.phase, status?.message, loadStatus]);

  async function scan() {
    try {
      const s = await api.crmMailScan(days);
      setStatus(s);
      toast('info', `Scanning every mail folder from the last ${days} days — keep Outlook open`);
    } catch (e: any) { toast('err', failed('start the mailbox scan', e)); }
  }

  async function move(q: CrmMailQuote, to: 'mine' | 'team' | '') {
    try {
      const r = await api.crmMailSide(q.key, to);
      applyCounts(r.counts);
      // It just left this list unless the override put it back where it was.
      setQuotes(prev => r.quote.side === side
        ? prev.map(x => (x.key === q.key ? r.quote : x))
        : prev.filter(x => x.key !== q.key));
      toast('ok', to ? `Quote moved to ${to === 'mine' ? 'Mine' : 'Team'}` : "Override cleared — back to the scan's own verdict");
    } catch (e: any) { toast('err', failed('move the quote', e)); }
  }

  const running = !!status?.running;
  const never   = !lastScan && !running;

  return (
    <div className="space-y-4">
      {/* ── Mine / Team + controls ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 p-1 rounded-panel"
             style={{ background: 'var(--s3)', border: 'var(--hairline) solid var(--line)' }}>
          <SideBtn active={side === 'mine'} Icon={User} label="Mine" count={counts.mine}
                   onClick={() => setSide('mine')} />
          <SideBtn active={side === 'team'} Icon={Users} label="Team" count={counts.team}
                   onClick={() => setSide('team')} />
        </div>

        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search reference, project, sender, folder…"
            className={cn(inputCls, 'pl-8')} />
        </div>

        <div className="flex-1" />

        <select value={days} onChange={e => setDays(Number(e.target.value))}
                className={selectCls} title="How far back to sweep" disabled={running}>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 6 months</option>
          <option value={365}>Last year</option>
        </select>
        <Button tone={never ? 'primary' : 'outline'} size="sm"
                Icon={running ? Loader2 : RefreshCw} disabled={running} onClick={scan}
                className={running ? '[&_svg]:animate-spin' : ''}>
          {running ? 'Scanning…' : lastScan ? 'Re-scan mailbox' : 'Scan mailbox'}
        </Button>
        <Button tone="ghost" size="sm" Icon={RefreshCw} onClick={() => load(query, side)}>Refresh</Button>
      </div>

      {lastScan && !running && (
        <p className="text-xs text-fg-4">
          {counts.total} quote{counts.total === 1 ? '' : 's'} indexed · swept {relTime(lastScan)}
          {status?.scanned ? ` · ${status.scanned.toLocaleString()} messages read` : ''}
        </p>
      )}

      {status && (running || status.phase === 'error') && (
        <div className="rounded-panel v3-card px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {running && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />}
            {status.phase === 'error' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--err)' }} />}
            <span className="flex-1" style={{ color: status.phase === 'error' ? 'var(--err)' : 'var(--t2)' }}>
              {status.message}
            </span>
          </div>
          {running && (
            <p className="text-2xs text-fg-4">
              Outlook must stay open. Every folder of every mailbox is read, so a long window takes a few minutes.
            </p>
          )}
        </div>
      )}

      {/* ── The list ───────────────────────────────────────────────────────── */}
      {never ? (
        <Card className="text-center py-16">
          <Inbox className="w-8 h-8 text-fg-4 mx-auto mb-3" />
          <p className="text-base font-medium text-fg-2">No mailbox sweep yet</p>
          <p className="text-xs text-fg-4 mt-1 max-w-md mx-auto">
            Vector will read every folder of every mailbox you have open — your own and the shared
            quote factory — and index every quote reference it finds, split into your work and the team’s.
          </p>
        </Card>
      ) : loading ? (
        <div className="flex items-center justify-center py-16 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : quotes.length === 0 ? (
        <Card className="text-center py-14 text-base text-fg-3">
          {query.trim()
            ? <>No {side === 'mine' ? 'quote of yours' : 'team quote'} matches “{query.trim()}”.</>
            : side === 'mine'
              ? <>Nothing here yet — no quote in the swept window was sent or filed by you.</>
              : <>Nothing here yet — every quote found in the swept window is yours.</>}
        </Card>
      ) : (
        <div className="rounded-panel v3-card divide-y divide-line overflow-hidden">
          {quotes.map(q => (
            <MailQuoteRow key={q.key} q={q} side={side} toast={toast}
                          onOpenAccount={onOpenAccount} onMove={move} />
          ))}
        </div>
      )}
    </div>
  );
}

function SideBtn({ active, Icon, label, count, onClick }: {
  active: boolean; Icon: typeof User; label: string; count: number; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      style={active ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : undefined}
      className={cn('h-7 px-3 rounded-panel text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
        active ? '' : 'text-fg-2 hover:bg-hover')}>
      <Icon className="w-3.5 h-3.5" />
      {label}
      <span className="tabular-nums text-2xs px-1.5 rounded-full"
            style={active ? { background: 'rgba(255,255,255,.22)' } : { background: 'var(--s2)', color: 'var(--t3)' }}>
        {count}
      </span>
    </button>
  );
}

// ─── One quote found in the mailbox ──────────────────────────────────────────
function MailQuoteRow({ q, side, toast, onOpenAccount, onMove }: {
  q: CrmMailQuote; side: 'mine' | 'team'; toast: ToastFn;
  onOpenAccount: (id: number) => void;
  onMove: (q: CrmMailQuote, to: 'mine' | 'team' | '') => void;
}) {
  const [open, setOpen] = useState(false);
  const other = side === 'mine' ? 'team' : 'mine';

  async function openInOutlook() {
    try {
      const r = await api.outlookOpenInOutlook(q.entryId);
      if ((r as any).error) toast('err', failed('open the quote email in Outlook', (r as any).error));
    } catch (e: any) { toast('err', failed('open the quote email in Outlook', e)); }
  }

  return (
    <div className="px-4 py-2.5 hover:bg-subtle transition-colors">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-px px-1.5 py-0.5 rounded-control text-2xs font-semibold mono"
              style={q.kind === 'bm'
                ? { background: 'var(--violet-soft)', color: 'var(--violet)' }
                : { background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
              title={q.kind === 'bm' ? 'BidManager number' : 'Salesforce reference'}>
          {q.ref || q.key}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg truncate">{q.subject}</p>
          <div className="flex items-center gap-2 flex-wrap mt-0.5 text-2xs text-fg-3">
            {q.account && (
              q.companyId
                ? <button onClick={() => onOpenAccount(q.companyId!)}
                          className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent-text)' }}>
                    <Building2 className="w-3 h-3" />{q.account}
                  </button>
                : <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{q.account}</span>
            )}
            <span>{q.sender || q.senderEmail || 'unknown sender'}</span>
            <span className="tabular-nums">{(q.last || '').slice(0, 10)}</span>
            <span className="tabular-nums">{q.msgs} msg</span>
            {q.docs.length > 0 && (
              <span className="inline-flex items-center gap-1"><Paperclip className="w-3 h-3" />{q.docs.length}</span>
            )}
            {q.overridden && <Pill tone="neutral">moved by hand</Pill>}
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-1">
          <UiButton tone="ghost" size="xs" onClick={() => setOpen(o => !o)}>
            {open ? 'Less' : 'Why?'}
          </UiButton>
          <UiButton tone="ghost" size="xs" aria-label="Open this mail in Outlook" onClick={openInOutlook} hint="Open this mail in Outlook">
            <ExternalLink className="w-3 h-3" /> Open
          </UiButton>
          <UiButton tone="ghost" size="xs" aria-label={`Move this quote to ${other === 'mine' ? 'Mine' : 'Team'}`} onClick={() => onMove(q, other)} hint={`Move this quote to ${other === 'mine' ? 'Mine' : 'Team'}`}>
            <ArrowLeftRight className="w-3 h-3" /> {other === 'mine' ? 'Mine' : 'Team'}
          </UiButton>
        </div>
      </div>

      {open && (
        <div className="mt-2 ml-1 pl-3 space-y-1 text-2xs text-fg-2"
             style={{ borderLeft: 'var(--focus-w) solid var(--line-2)' }}>
          <p>
            <span className="text-fg-3">Filed as {side === 'mine' ? 'yours' : 'the team’s'} because </span>
            {q.why || 'no reason recorded'}
            {q.whyFolder && <span className="text-fg-3"> ({q.whyFolder})</span>}
          </p>
          {q.overridden && (
            <p className="text-fg-3">
              You moved this one — the scan itself said {q.scannerSide === 'mine' ? 'yours' : 'the team’s'}.{' '}
              <button onClick={() => onMove(q, '')} className="hover:underline" style={{ color: 'var(--accent-text)' }}>
                Undo
              </button>
            </p>
          )}
          <p className="flex items-start gap-1.5">
            <FolderOpen className="w-3 h-3 shrink-0 mt-px text-fg-3" />
            <span>{q.folders.join(' · ') || q.folder || '—'}</span>
          </p>
          {q.recipients && <p><span className="text-fg-3">To:</span> {q.recipients}</p>}
          <p><span className="text-fg-3">Seen:</span>{' '}
            <span className="tabular-nums">{(q.first || '').slice(0, 10)} → {(q.last || '').slice(0, 10)}</span>
          </p>
          {q.docs.length > 0 && (
            <p className="flex items-start gap-1.5">
              <Paperclip className="w-3 h-3 shrink-0 mt-px text-fg-3" />
              <span>{q.docs.map(d => d.name).join(' · ')}</span>
            </p>
          )}
          {!q.companyId && q.account && (
            <p className="text-fg-3">Not matched to an account yet — no card claims “{q.account}”.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Account row ─────────────────────────────────────────────────────────────
function AccountCard({ c, mergeMode, picked, selected, onClick }: { c: CrmCompanyCard; mergeMode: boolean; picked: boolean; selected?: boolean; onClick: () => void }) {
  const on = (mergeMode && picked) || selected;
  return (
    <button onClick={onClick} aria-pressed={on}
      className={cn(
        'relative w-full text-left px-3 py-2.5 border-b border-line transition-colors',
        on ? 'bg-accent-soft before:absolute before:left-0 before:inset-y-2 before:w-0.5 before:rounded-full before:bg-accent'
           : 'hover:bg-hover',
      )}>
      <div className="flex items-start gap-2.5">
        {mergeMode && (picked
          ? <CheckSquare className="w-4 h-4 mt-0.5 shrink-0 text-accent-text" />
          : <Square className="w-4 h-4 mt-0.5 shrink-0 text-fg-4" />)}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0">
            <h3 className="text-md font-medium text-fg truncate flex-1">{c.name}</h3>
            {c.country && <span className="mono text-2xs text-fg-3 shrink-0">{c.country}</span>}
          </div>
          <div className="flex items-baseline gap-3 mt-0.5 text-xs text-fg-3">
            <span className="mono">{c.quoteCount} q</span>
            <span className="mono">{c.contactCount} c</span>
            <span className="mono text-fg-2 ml-auto">{c.totalValue ? fmtMoneyFull(c.totalValue, '€') : '—'}</span>
          </div>
          <p className="text-2xs text-fg-4 mt-0.5 truncate">
            {c.lastQuote ? `Last quote ${relTime(c.lastQuote)}` : 'No quotes yet'}
            {c.aliasCount > 1 && ` · ${c.aliasCount} names`}
            {c.salesmen.length > 0 && ` · ${c.salesmen.join(', ')}`}
          </p>
        </div>
      </div>
    </button>
  );
}

// ─── Section wrapper + quote-hit row + empty state ───────────────────────────
function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 pb-1.5 border-b border-line">
        <h2 className="eyebrow">{title}</h2>
        {count != null && <span className="mono text-2xs text-fg-4">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <EmptyState compact title={children} />;
}

function QuoteHitRow({ q, onOpen }: { q: CrmQuoteHit; onOpen: () => void }) {
  const stateTone = q.state === 'won' ? 'ok' : q.state === 'lost' ? 'err' : 'brand';
  return (
    <button onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-hover transition-colors">
      <FileText className="w-3.5 h-3.5 text-fg-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg truncate">{q.name || q.account}</div>
        <div className="text-xs text-fg-3 truncate">
          {q.account}{q.salesman ? ` · ${q.salesman}` : ''}{q.ref ? ` · ${q.ref}` : ''}
        </div>
      </div>
      <span className="mono text-sm text-fg shrink-0">{q.price == null ? '—' : fmtMoneyFull(q.price, '€')}</span>
      <Pill tone={stateTone as any}>{q.state}</Pill>
    </button>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'brand' | 'muted' }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mono text-lg leading-tight mt-0.5" style={{ color: tone === 'brand' ? 'var(--accent-text)' : 'var(--t1)' }}>{value}</div>
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
    catch (e: any) { toast('err', failed('load this account', e)); }
    setLoading(false);
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <div className="flex items-center justify-center py-20 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }
  const { company, contacts, facts, quotes, opp, enriched } = data;
  const mailQuotes = data.mailQuotes ?? [];

  async function saveContact(vals: Partial<CrmContact>) {
    try {
      await api.crmSaveContact({ companyId: id, name: vals.name!, role: vals.role, email: vals.email, phone: vals.phone, notes: vals.notes, id: vals.id });
      toast('ok', `Contact ${vals.name} ${vals.id ? 'updated' : 'added'}`); setContactForm(null); load();
    } catch (e: any) { toast('err', failed(`save the contact ${vals.name}`, e)); }
  }
  async function delContact(cid: number) { await api.crmDeleteContact(cid); load(); }
  async function addFact() {
    const t = factText.trim(); if (!t) return;
    try { await api.crmAddFact(id, t); setFactText(''); load(); }
    catch (e: any) { toast('err', failed('add the fact', e)); }
  }
  async function delFact(fid: number) { await api.crmDeleteFact(fid); load(); }
  async function setState(q: CrmQuote, state: 'open' | 'won' | 'lost') {
    try { await api.crmQuoteState(q.key, state); load(); }
    catch (e: any) { toast('err', failed(`mark quote ${q.key} as ${state}`, e)); }
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
        toast('warn', failed(`open the PDF for ${q.key}`, j.error || 'no copy found locally or in the D&Q Store'));
        return;
      }
      if (pre) pre.location.href = j.url; else await openExternal(j.url);
    } catch (e: any) { pre?.close(); toast('err', failed(`open the PDF for ${q.key}`, e)); }
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
            if (!await confirmAsync({
              title: 'Delete account',
              message: `Delete "${company.name}" and its contacts and facts?\n\nQuotes in history are not affected.`,
              confirmLabel: 'Delete account', danger: true,
            })) return;
            await api.crmDeleteCompany(id); toast('ok', `Account "${company.name}" deleted`); onBack();
          }}>Delete</Button>
      </div>

      {editing && (
        <CompanyForm initial={company}
          onCancel={() => setEditing(false)}
          onSave={async vals => {
            try { await api.crmSaveCompany({ ...vals, id }); toast('ok', `Account "${vals.name}" saved`); setEditing(false); load(); }
            catch (e: any) { toast('err', failed('save the account', e)); }
          }} />
      )}

      {/* Header */}
      <Card className="animate-fade-up">
        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-panel grid place-items-center text-2xl font-semibold shrink-0"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
            {company.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold text-fg">{company.name}</h2>
              {company.country && <Pill tone="neutral">{company.country}</Pill>}
            </div>
            {(company.aliases?.length ?? 0) > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <span className="text-2xs uppercase tracking-wide text-fg-3">Names:</span>
                {company.aliases!.map(a => <Pill key={a} tone="neutral">{a}</Pill>)}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {(company.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => (
                <Pill key={t} tone="violet">{t}</Pill>
              ))}
            </div>
            {company.notes && <p className="text-sm text-fg-2 mt-2 whitespace-pre-wrap">{company.notes}</p>}
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
            <h3 className="text-base font-semibold text-fg">Contacts</h3>
            <Button tone="ghost" size="sm" Icon={UserPlus} onClick={() => setContactForm({})}>Add</Button>
          </div>
          {contactForm && <ContactForm initial={contactForm} onCancel={() => setContactForm(null)} onSave={saveContact} />}
          {contacts.length === 0 && !contactForm ? (
            <p className="text-sm text-fg-3 py-4 text-center">
              {enriched ? 'No contacts yet.' : 'Connect to JOE to pull the salesman as a contact, or add one.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {contacts.map(ct => (
                <li key={ct.id} className="group flex items-start gap-2.5 p-2.5 rounded-lg bg-subtle">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-fg truncate">{ct.name}</span>
                      {ct.role && <span className="text-xs text-fg-3">· {ct.role}</span>}
                      {ct.auto && <Pill tone="brand">from quotes</Pill>}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs">
                      {ct.email && <a href={`mailto:${ct.email}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline"><Mail className="w-3 h-3" />{ct.email}</a>}
                      {ct.phone && <a href={`tel:${ct.phone}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg-2"><Phone className="w-3 h-3" />{ct.phone}</a>}
                    </div>
                    {ct.notes && <p className="text-xs text-fg-3 mt-1 whitespace-pre-wrap">{ct.notes}</p>}
                  </div>
                  {!ct.auto && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button aria-label="Edit contact" onClick={() => setContactForm(ct)} className="p-1 text-fg-3 hover:text-accent-text"><Pencil className="w-3.5 h-3.5" /></button>
                      <UiIconButton icon={Trash2} label="Delete contact" tone="danger" onClick={() => delContact(ct.id)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Facts */}
        <Card>
          <h3 className="text-base font-semibold text-fg mb-3">Facts</h3>
          <div className="flex gap-2 mb-3">
            <input value={factText} onChange={e => setFactText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addFact(); }}
              placeholder="e.g. pays at 60 days, prefers EL kits…" className={inputCls} />
            <Button tone="primary" size="sm" Icon={Plus} onClick={addFact}>Add</Button>
          </div>
          {facts.length === 0 ? (
            <p className="text-sm text-fg-3 py-2 text-center">No facts noted yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {facts.map(f => (
                <li key={f.id} className="group flex items-start gap-2 text-sm text-fg-2">
                  {f.source === 'ai'
                    ? <Sparkles className="w-3 h-3 text-ai mt-1 shrink-0" />
                    : <Star className="w-3 h-3 text-warn mt-1 shrink-0" />}
                  <span className="flex-1">{f.text}</span>
                  <UiIconButton icon={X} label="Delete fact" tone="danger" className="opacity-0 group-hover:opacity-100" onClick={() => delFact(f.id)} />
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
          <h3 className="text-base font-semibold text-fg">Quotes &amp; opportunities</h3>
          <span className="text-xs text-fg-3 text-right">
            {enriched ? 'Prices & salesmen from the Quotations List' : 'Connect to JOE to load prices & salesmen'}
          </span>
        </div>
        {quotes.length === 0 ? (
          <p className="text-sm text-fg-3 py-6 text-center">No quotes recorded for this account yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs uppercase tracking-wide text-fg-3 border-y border-line">
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
                  <tr key={q.id} className="border-b border-line">
                    <td className="px-5 py-2 mono text-2xs text-fg-3 whitespace-nowrap">{q.ref || '—'}</td>
                    <td className="px-3 py-2 text-fg">
                      <button aria-label="Open archived PDF" onClick={() => openPdf(q)} title="Open archived PDF"
                        className="inline-flex items-center gap-1 text-left hover:text-accent-text hover:underline">
                        <FileText className="w-3 h-3 shrink-0 opacity-60" />
                        {q.name || '—'}
                      </button>
                      {q.status && <span className="ml-1.5 text-2xs text-fg-3">· {q.status}</span>}
                    </td>
                    <td className="px-3 py-2 text-fg-2">{q.salesman || '—'}</td>
                    <td className="px-3 py-2 text-right font-medium mono text-fg">{q.price == null ? '—' : fmtMoneyFull(q.price, '€')}</td>
                    <td className="px-3 py-2 text-fg-3 whitespace-nowrap">
                      {relTime(q.timestamp)}{q.runs > 1 && <span className="text-fg-3"> · {q.runs}×</span>}
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
                <tr className="border-t border-line text-xs">
                  <td className="px-5 py-2 text-fg-3 uppercase tracking-wide text-2xs" colSpan={3}>Total issued</td>
                  <td className="px-3 py-2 text-right font-semibold mono" style={{ color: 'var(--accent-text)' }}>{enriched ? fmtMoneyFull(totalIssued, '€') : '—'}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Quotes the mailbox sweep tied to this account — including any that never
          reached the Quotations List, which is precisely what makes them worth
          showing next to the table above. */}
      {mailQuotes.length > 0 && (
        <Card padded={false}>
          <div className="flex items-center justify-between px-5 pt-4 pb-3 gap-3">
            <h3 className="text-base font-semibold text-fg inline-flex items-center gap-2">
              <Inbox className="w-3.5 h-3.5 text-fg-3" /> From the mailbox
              <span className="text-xs font-normal text-fg-3 tabular-nums">{mailQuotes.length}</span>
            </h3>
            <span className="text-xs text-fg-3">Found in Outlook, not in the Quotations List</span>
          </div>
          <div className="divide-y divide-line border-t border-line">
            {mailQuotes.map(q => (
              <div key={q.key} className="px-5 py-2 flex items-center gap-3">
                <span className="shrink-0 px-1.5 py-0.5 rounded-control text-2xs font-semibold mono"
                      style={q.kind === 'bm'
                        ? { background: 'var(--violet-soft)', color: 'var(--violet)' }
                        : { background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
                  {q.ref || q.key}
                </span>
                <span className="min-w-0 flex-1 text-sm text-fg truncate" title={q.subject}>
                  {q.subject}
                </span>
                <Pill tone={q.side === 'mine' ? 'brand' : 'neutral'}>{q.side === 'mine' ? 'Mine' : 'Team'}</Pill>
                {q.docs.length > 0 && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-2xs text-fg-3">
                    <Paperclip className="w-3 h-3" />{q.docs.length}
                  </span>
                )}
                <span className="shrink-0 text-2xs text-fg-3 mono w-16 text-right">
                  {(q.last || '').slice(0, 10)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
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
      if (r.error) toast('warn', failed('generate the AI insights', r.error));
      setItems(r.items || []);
    } catch (e: any) { toast('err', failed('generate the AI insights', e)); }
    setLoad(false);
  }, [id, toast]);

  async function pin(text: string) {
    try { await api.crmAddFact(id, text, 'ai'); toast('ok', "Insight pinned to this account's facts"); onPinned(); }
    catch (e: any) { toast('err', failed('pin the insight to the facts', e)); }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-fg inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-ai" /> AI insights
        </h3>
        <Button tone="ghost" size="sm" Icon={loading ? Loader2 : RefreshCw} disabled={loading}
          onClick={() => run(items != null)} className={loading ? '[&_svg]:animate-spin' : ''}>
          {items == null ? 'Generate' : 'Regenerate'}
        </Button>
      </div>
      {items == null ? (
        <p className="text-sm text-fg-3 py-4 text-center">Generate facts &amp; warnings from this account's run history.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-3 py-4 text-center">Nothing noteworthy in the data yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="group flex items-start gap-2 p-2 rounded-panel text-sm text-fg-2"
              style={{ background: it.type === 'warning' ? 'var(--warn-soft)' : 'var(--violet-soft)' }}>
              {it.type === 'warning'
                ? <AlertTriangle className="w-3.5 h-3.5 text-warn mt-0.5 shrink-0" />
                : <Sparkles className="w-3.5 h-3.5 text-ai mt-0.5 shrink-0" />}
              <span className="flex-1">{it.text}</span>
              <button aria-label="Pin to facts" onClick={() => pin(it.text)} title="Pin to facts"
                className="p-0.5 text-fg-4 hover:text-accent-text opacity-0 group-hover:opacity-100"><Pin className="w-3.5 h-3.5" /></button>
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
      if (r.error) toast('warn', failed('search the D&Q Store', r.error));
      setDocs(r.results || []);
    } catch (e: any) { toast('err', failed('search the D&Q Store', e)); }
    setLoad(false);
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-fg inline-flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-accent-text" /> D&amp;Q documents
        </h3>
        <Button tone="ghost" size="sm" Icon={loading ? Loader2 : RefreshCw} disabled={loading}
          onClick={run} className={loading ? '[&_svg]:animate-spin' : ''}>
          {docs == null ? 'Load' : 'Reload'}
        </Button>
      </div>
      {docs == null ? (
        <p className="text-sm text-fg-3 py-4 text-center">Search the D&amp;Q Store for this account's documents (needs JOE connection).</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-fg-3 py-4 text-center">No matching documents found.</p>
      ) : (
        <ul className="space-y-1.5">
          {docs.map((d, i) => (
            <li key={i}>
              <a href={d.url} target="_blank" rel="noreferrer"
                className="group flex items-center gap-2 p-2 rounded-lg hover:bg-subtle text-sm">
                <FileText className="w-3.5 h-3.5 text-fg-3 shrink-0" />
                <span className="flex-1 truncate text-fg-2">{d.title || d.filename}</span>
                {d.ext && <span className="text-2xs uppercase text-fg-3">{d.ext}</span>}
                <ExternalLink className="w-3 h-3 text-fg-4 opacity-0 group-hover:opacity-100" />
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
    <div className="rounded-panel bg-subtle px-3 py-2 text-right min-w-20">
      <div className="text-lg font-semibold tabular-nums leading-none" style={{ color: tone === 'brand' ? 'var(--accent-text)' : 'var(--t1)' }}>{value}</div>
      <div className="text-2xs uppercase tracking-[0.05em] text-fg-3 mt-1">{label}</div>
    </div>
  );
}

function StateBtn({ active, tone, onClick, children }: { active: boolean; tone: 'brand' | 'ok' | 'err'; onClick: () => void; children: React.ReactNode }) {
  const on: Record<string, string> = { brand: 'var(--accent)', ok: 'var(--ok)', err: 'var(--err)' };
  return (
    <button onClick={onClick}
      style={active ? { background: on[tone], color: tone === 'brand' ? 'var(--accent-ink)' : 'var(--on-status)' } : undefined}
      className={cn('px-2 h-6 rounded-panel text-2xs font-medium transition-colors',
        active ? '' : 'text-fg-3 hover:bg-subtle')}>
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
    <div className="mb-3 p-3 rounded-panel" style={{ border: 'var(--hairline) solid var(--accent-line)', background: 'var(--accent-soft)' }}>
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
      <span className="block text-2xs uppercase tracking-wide text-fg-3 mb-1">{label}</span>
      {children}
    </label>
  );
}
