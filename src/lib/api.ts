// ─── Axios API wrappers ──────────────────────────────────────────────────────
// axios.defaults.baseURL is set once in main.tsx, after the sidecar port resolves
// and before any component renders. In browser dev it stays unset (relative paths).
import axios from 'axios';

import type {
  Job, DashboardStats, Config, PdfFile, ArchiveDay,
  AnalyticsResponse, SearchResult, DqDoc,
  CrmCompanyCard, CrmCompanyDetail, CrmInsight,
} from '../types';

export interface UserDoc {
  id: string; title: string; category: string;
  file: string; origName: string; ext: string; size: number; date: string;
}

export const api = {
  // Stats / Jobs
  stats:    () => axios.get<DashboardStats>('/api/stats').then(r => r.data),
  jobs:     () => axios.get<Job[]>('/api/jobs').then(r => r.data),
  archive:  () => axios.get<ArchiveDay[]>('/api/archive').then(r => r.data),

  // Config
  config:     () => axios.get<Config>('/api/config').then(r => r.data),
  saveConfig: (c: Config) => axios.post('/api/config', c).then(r => r.data),

  // Per-session JOE cookies (remote connect — supply your own SharePoint cookies)
  sessionSetCookies:   (fed: string, rt: string) => axios.post<{ ok: boolean; error?: string }>('/api/session/cookies', { fed, rt }).then(r => r.data),
  sessionClearCookies: () => axios.post<{ ok: boolean; cleared?: boolean }>('/api/session/cookies', {}).then(r => r.data),

  // Session / connection
  session:    () => axios.get<{ startedAt: string | null }>('/api/session').then(r => r.data),
  connection: () => axios.get<{ connected: boolean; name: string | null; email: string | null }>('/api/connection').then(r => r.data),
  connect:    () => axios.get<{ ok: boolean; lines?: string[]; code?: number; error?: string }>('/api/run/connect', { timeout: 180_000 }).then(r => r.data),

  // PDFs
  pdfs:      () => axios.get<PdfFile[]>('/api/pdfs').then(r => r.data),
  suggestProduct: () => axios.get<{ suggestion: string; perFile: { name: string; lang: string; suggestion: string }[] }>('/api/suggest-product').then(r => r.data),
  deletePdf: (name: string) => axios.delete(`/api/pdfs/${encodeURIComponent(name)}`).then(r => r.data),
  uploadPdf: async (file: File) => {
    await fetch('/api/pdfs/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
      body: await file.arrayBuffer(),
    });
  },

  // Doc Packs (user-uploaded, persisted)
  docsUser:       () => axios.get<UserDoc[]>('/api/docs/user').then(r => r.data),
  docsUserUpload: async (file: File, title: string, category: string) => {
    const r = await fetch('/api/docs/user/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-Title':    encodeURIComponent(title),
        'X-Category': encodeURIComponent(category),
      },
      body: await file.arrayBuffer(),
    });
    return r.json() as Promise<{ ok: boolean; doc?: UserDoc; error?: string }>;
  },
  docsUserDelete: (id: string) => axios.delete<{ ok: boolean }>(`/api/docs/user/${id}`).then(r => r.data),

  // Search & Copilot
  search:        (q: string) => axios.get<{ results: SearchResult[]; error?: string }>('/api/search', { params: { q } }).then(r => r.data),
  ai:            (query: string, history?: Array<{role:string;text:string}>) =>
                   axios.post<{ answer: string | null; error?: string; source?: string }>(
                     '/api/ai', { query, history }, { timeout: 60_000 }).then(r => r.data),
  aiStatus:      () => axios.get<{ available: boolean }>('/api/ai/status').then(r => r.data),
  // Smart in-chat quote search: classifies the message, searches the D&Q Store +
  // Quotations List when it's a search, and returns a prose answer + result cards.
  quoteAsk:      (query: string, history?: Array<{role:string;text:string}>) =>
                   axios.post<{ answer: string | null; results?: DqDoc[]; meta?: { count: number; scope: string; term: string }; error?: string }>(
                     '/api/quote-ask', { query, history }, { timeout: 60_000 }).then(r => r.data),

  // Analytics
  analytics: (days: number) => axios.get<AnalyticsResponse>('/api/analytics', { params: { days } }).then(r => r.data),

  // Outlook
  outlookStatus:      () => axios.get<{ available: boolean; backend?: string; newOutlook?: boolean; graphAuth?: boolean; imapSetup?: boolean; name?: string; email?: string; error?: string }>('/api/outlook/status', { timeout: 15_000 }).then(r => r.data),
  outlookGraphConnect: () => axios.post<{ ok: boolean; name?: string; email?: string; error?: string }>('/api/outlook/graph-connect', {}, { timeout: 120_000 }).then(r => r.data),
  outlookImapConfig:  (email: string, password: string) => axios.post<{ ok: boolean; email?: string; error?: string }>('/api/outlook/imap-config', { email, password }, { timeout: 30_000 }).then(r => r.data),
  outlookMailboxes:   () => axios.get<{ mailboxes: any[]; error?: string }>('/api/outlook/mailboxes', { timeout: 20_000 }).then(r => r.data),
  outlookEmails:      (storeId: string, limit = 30, unread = false, signal?: AbortSignal) =>
                        axios.get<{ emails: any[]; error?: string }>('/api/outlook/emails', { params: { storeId, limit, unread }, timeout: 60_000, signal }).then(r => r.data),
  outlookEmail:       (id: string, signal?: AbortSignal) => axios.get<any>(`/api/outlook/email/${encodeURIComponent(id)}`, { timeout: 15_000, signal }).then(r => r.data),
  outlookSummarize:      (payload: any, signal?: AbortSignal) => axios.post<{ summary: string | null; cached?: boolean; imagesRead?: number; error?: string }>('/api/outlook/summarize', payload, { timeout: 90_000, signal }).then(r => r.data),
  outlookGetSummary:     (entryId: string, signal?: AbortSignal) => axios.get<{ summary: string | null; includedIndices?: number[]; ts?: string }>(`/api/outlook/summary/${encodeURIComponent(entryId)}`, { timeout: 15_000, signal }).then(r => r.data),
  outlookSaveAttachment: (entryId: string) => axios.post<{ saved: any[]; count: number; error?: string }>('/api/outlook/save-attachment', { entryId }, { timeout: 30_000 }).then(r => r.data),
  outlookDraftReply:     (payload: any, signal?: AbortSignal) => axios.post<{ draft: string | null; error?: string }>('/api/outlook/draft-reply', payload, { timeout: 60_000, signal }).then(r => r.data),
  outlookSendReply:      (entryId: string, body: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/send-reply', { entryId, body }, { timeout: 30_000 }).then(r => r.data),
  outlookFeedback:       (payload: any) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/feedback', payload, { timeout: 10_000 }).then(r => r.data),
  feedback:              (payload: { message: string; category?: string; page?: string; userName?: string | null; userEmail?: string | null }) =>
                           axios.post<{ ok?: boolean; stored?: boolean; emailed?: boolean; error?: string }>('/api/feedback', payload, { timeout: 30_000 }).then(r => r.data),
  outlookChat:           (payload: any, signal?: AbortSignal) => axios.post<{ answer: string | null; error?: string }>('/api/outlook/chat', payload, { timeout: 60_000, signal }).then(r => r.data),
  // EL Internal Info tab
  elInternalList:        (signal?: AbortSignal) => axios.get<{ emails: any[]; digest: string | null; digestAt: string | null; lastRefreshAt: string | null }>('/api/el-internal/list', { timeout: 15_000, signal }).then(r => r.data),
  elInternalRefresh:     (signal?: AbortSignal) => axios.post<{ added: number; total: number; emails: any[]; lastRefreshAt: string; error?: string }>('/api/el-internal/refresh', {}, { timeout: 120_000, signal }).then(r => r.data),
  elInternalDigest:      (signal?: AbortSignal) => axios.post<{ digest: string | null; digestAt?: string; error?: string }>('/api/el-internal/digest', {}, { timeout: 90_000, signal }).then(r => r.data),
  elInternalChat:        (payload: { history: any[]; question: string }, signal?: AbortSignal) => axios.post<{ answer: string | null; error?: string }>('/api/el-internal/chat', payload, { timeout: 60_000, signal }).then(r => r.data),
  // Fenton KB tab
  fentonList:            (signal?: AbortSignal) => axios.get<{ cards: any[]; lastRefreshAt: string | null }>('/api/fenton/list', { timeout: 15_000, signal }).then(r => r.data),
  fentonRefresh:         (force = false, signal?: AbortSignal) => axios.post<{ added: number; total: number; cards: any[]; lastRefreshAt: string; error?: string }>('/api/fenton/refresh', { force }, { timeout: 180_000, signal }).then(r => r.data),
  fentonChat:            (payload: { history: any[]; question: string }, signal?: AbortSignal) => axios.post<{ answer: string | null; error?: string }>('/api/fenton/chat', payload, { timeout: 60_000, signal }).then(r => r.data),
  // Quick Quote (Inbox proposal generator)
  quoteDetectCbu:        (body: string, systems: string[], signal?: AbortSignal) => axios.post<{ system: string }>('/api/quote/detect-cbu', { body, systems }, { timeout: 30_000, signal }).then(r => r.data),
  quoteLuminaires:       (body: string, signal?: AbortSignal) => axios.post<{ items: any[]; unmatched?: number; error?: string }>('/api/quote/luminaires', { body }, { timeout: 120_000, signal }).then(r => r.data),
  quoteGenerate:         (payload: { header: any; lines: any[]; appendComm?: boolean; appendTC?: boolean }, signal?: AbortSignal) => axios.post<{ id?: string; error?: string }>('/api/quote/generate', payload, { timeout: 130_000, signal }).then(r => r.data),
  outlookFlag:           (entryId: string, flagged: boolean) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/flag', { entryId, flagged }, { timeout: 15_000 }).then(r => r.data),
  outlookMarkUnread:     (entryId: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/mark-unread', { entryId }, { timeout: 15_000 }).then(r => r.data),
  outlookDelete:         (entryId: string) => axios.delete<{ ok?: boolean; error?: string }>(`/api/outlook/email/${encodeURIComponent(entryId)}`, { timeout: 15_000 }).then(r => r.data),
  outlookForward:        (entryId: string, to: string, body?: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/forward', { entryId, to, body }, { timeout: 20_000 }).then(r => r.data),
  outlookOpenInOutlook:  (entryId: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/open-in-outlook', { entryId }, { timeout: 15_000 }).then(r => r.data),
  outlookCategorize:     (entryId: string, category: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/categorize', { entryId, category }, { timeout: 15_000 }).then(r => r.data),
  outlookSuggestAtts:    (q: string) => axios.get<{ results: any[]; error?: string }>('/api/outlook/suggest-attachments', { params: { q }, timeout: 30_000 }).then(r => r.data),
  outlookReplyWithAtts:  (entryId: string, body: string, attSources: any[]) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/reply-with-attachments', { entryId, body, attSources }, { timeout: 30_000 }).then(r => r.data),
  outlookSendNew:        (to: string, subject: string, body: string, attSources: any[]) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/send-new', { to, subject, body, attSources }, { timeout: 30_000 }).then(r => r.data),

  // D&Q Store full-text search (file name + PDF/email content via SharePoint index)
  dqSearch: (q: string, mine = true) =>
    axios.get<{ results: DqDoc[]; total?: number; mine?: boolean; author?: string | null; error?: string }>(
      '/api/dq-search', { params: { q, mine: mine ? 1 : 0 }, timeout: 30_000 }
    ).then(r => r.data),

  // ── Mini CRM ───────────────────────────────────────────────────────────────
  crmCompanies:   () => axios.get<CrmCompanyCard[]>('/api/crm/companies').then(r => r.data),
  crmCompany:     (id: number) => axios.get<CrmCompanyDetail>(`/api/crm/company/${id}`).then(r => r.data),
  crmSaveCompany: (c: { id?: number; name: string; country?: string | null; tags?: string | null; notes?: string | null }) =>
                    axios.post<{ id: number }>('/api/crm/company', c).then(r => r.data),
  crmDeleteCompany: (id: number) => axios.delete<{ ok: boolean }>(`/api/crm/company/${id}`).then(r => r.data),
  crmSaveContact: (c: { id?: number; companyId: number; name: string; role?: string | null; email?: string | null; phone?: string | null; notes?: string | null }) =>
                    axios.post<{ id: number }>('/api/crm/contact', c).then(r => r.data),
  crmDeleteContact: (id: number) => axios.delete<{ ok: boolean }>(`/api/crm/contact/${id}`).then(r => r.data),
  crmAddFact:     (companyId: number, text: string, source: 'manual' | 'ai' = 'manual') => axios.post<{ id: number }>('/api/crm/fact', { companyId, text, source }).then(r => r.data),
  crmDeleteFact:  (id: number) => axios.delete<{ ok: boolean }>(`/api/crm/fact/${id}`).then(r => r.data),
  crmQuoteState:  (key: string, state: 'open' | 'won' | 'lost') =>
                    axios.post<{ ok: boolean }>('/api/crm/quote-state', { key, state: state === 'open' ? '' : state }).then(r => r.data),
  crmMerge:       (targetId: number, sourceIds: number[]) => axios.post<{ ok: boolean; merged: number }>('/api/crm/merge', { targetId, sourceIds }).then(r => r.data),
  crmSync:        () => axios.post<CrmSyncStatus & { started?: boolean; error?: string }>('/api/crm/sync', {}, { timeout: 30_000 }).then(r => r.data),
  crmSyncStop:    () => axios.post<{ ok: boolean }>('/api/crm/sync/stop', {}).then(r => r.data),
  crmQuoteSearch: (q: string) => axios.get<{ quotes: CrmQuoteHit[] }>('/api/crm/quote-search', { params: { q } }).then(r => r.data),
  crmSyncStatus:  () => axios.get<CrmSyncStatus>('/api/crm/sync/status').then(r => r.data),
  crmInsights:    (id: number, refresh = false) =>
                    axios.get<{ items: CrmInsight[]; error?: string; source?: string }>(`/api/crm/company/${id}/insights`, { params: refresh ? { refresh: 1 } : {}, timeout: 60_000 }).then(r => r.data),
  crmDocs:        (id: number, mine = true) =>
                    axios.get<{ results: DqDoc[]; error?: string }>(`/api/crm/company/${id}/docs`, { params: { mine: mine ? 1 : 0 }, timeout: 45_000 }).then(r => r.data),

  // Retry queue
  retryQueue:     () => axios.get<any[]>('/api/retry').then(r => r.data),
  retryNow:       () => axios.post<{ ok: boolean; ran: number; error?: string }>('/api/retry/now').then(r => r.data),
  retryDismiss:   (id: string) => axios.delete(`/api/retry/${encodeURIComponent(id)}`).then(r => r.data),

  // Server log
  logs: (tail = 150) => axios.get<{ lines: string[]; error?: string }>('/api/logs', { params: { tail } }).then(r => r.data),
};

// ─── CRM global quote-search hit ─────────────────────────────────────────────
export interface CrmQuoteHit {
  id:        number;
  name:      string;
  account:   string;
  companyId: number | null;
  salesman:  string | null;
  price:     number | null;
  status:    string | null;
  ref:       string;
  timestamp: string;
  state:     'open' | 'won' | 'lost';
}

// ─── CRM background sync status ──────────────────────────────────────────────
export interface CrmSyncStatus {
  running:       boolean;
  phase:         'idle' | 'scanning' | 'saving' | 'seeding' | 'done' | 'canceled' | 'error';
  mode:          'full' | 'incremental';
  message:       string;
  pages:         number;
  fetched:       number;
  kept:          number;
  total:         number | null;
  pct:           number | null;
  accounts:      number;
  owner:         string | null;
  error:         string | null;
  snapshotCount: number;
  lastSyncedAt:  string | null;
  csvExists:     boolean;
}

// ─── Conflict item returned when a duplicate is found in SharePoint ──────────
export interface ConflictItem {
  sfid:             string;
  existingId:       number;
  existingTitle:    string;
  existingCustomer: string;
}

// ─── SSE runner for /api/run/step1, /api/run/step2 ──────────────────────────
export async function runStreamingScript(
  endpoint: string,
  opts: {
    params?: Record<string, string>;
    body?: unknown;        // if provided → POST with JSON body
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: boolean; conflicts?: ConflictItem[] }> {
  const _apiBase = (window as any).__VECTOR_PORT__
    ? `http://localhost:${(window as any).__VECTOR_PORT__}`
    : location.origin;
  const url = new URL(endpoint, _apiBase);
  if (!opts.body) {
    Object.entries(opts.params || {}).forEach(([k, v]) => v && url.searchParams.set(k, v));
  }

  const fetchInit: RequestInit = { signal: opts.signal };
  if (opts.body) {
    fetchInit.method  = 'POST';
    fetchInit.headers = { 'Content-Type': 'application/json' };
    fetchInit.body    = JSON.stringify(opts.body);
  }
  const res    = await fetch(url.toString(), fetchInit);
  const reader = res.body!.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';
  let   capturedConflicts: ConflictItem[] | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim();
      if (!line) continue;
      if (line === '__DONE__:conflicts') {
        return { ok: false, conflicts: capturedConflicts };
      }
      if (line.startsWith('__DONE__:')) {
        return { ok: line.endsWith('true') };
      }
      let cleaned = line;
      try { cleaned = JSON.parse(line); } catch {}
      const str = typeof cleaned === 'string' ? cleaned : line;
      if (str.startsWith('__CONFLICTS__:')) {
        try { capturedConflicts = JSON.parse(str.slice('__CONFLICTS__:'.length)); } catch {}
        continue; // don't forward to onLine
      }
      opts.onLine?.(str);
    }
  }
  return { ok: false };
}
