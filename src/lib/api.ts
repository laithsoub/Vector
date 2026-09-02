// ─── Axios API wrappers ──────────────────────────────────────────────────────
// axios.defaults.baseURL is set once in main.tsx, after the sidecar port resolves
// and before any component renders. In browser dev it stays unset (relative paths).
import axios from 'axios';

import type {
  Job, DashboardStats, Config, PdfFile, ArchiveDay,
  AnalyticsResponse, SearchResult, DqDoc,
  CrmCompanyCard, CrmCompanyDetail, CrmInsight, CrmMailQuote, CrmMailScanStatus,
  CheckupResponse, JobsReport, JobsReportStatus,
  TodoItem, TodoScanStatus, TodoRecipientOption,
} from '../types';

// How a search term has to sit in the text it matched. Mirrors MATCH_MODES in
// server.ts and outlook_reader.py.
export type MatchMode = 'part' | 'word' | 'start';

// Which text the terms are matched against. 'all' is the whole message, 'meta'
// everything but the body; the rest narrow to one field, for a term that is a
// common word everywhere except where it matters. Mirrors SEARCH_SCOPES.
export type SearchScope = 'all' | 'meta' | 'subject' | 'from' | 'recipients' | 'atts' | 'body';

// Narrowing that runs alongside the terms rather than inside them: who it is
// from, when it landed, where it sits, what it carried. All optional — with none
// set the search is exactly the one it always ran.
export interface SearchFilters {
  from?:   string;                            // sender name or address, substring
  since?:  string;                            // YYYY-MM-DD, inclusive
  until?:  string;                            // YYYY-MM-DD, inclusive
  folder?: string;                            // folder path, substring
  att?:    'any' | 'yes' | 'no' | 'pdf';
  read?:   'any' | 'read' | 'unread';
  sort?:   'new' | 'old';
}

// One address the index has actually seen, with how much of the mail is theirs.
export interface SearchFacets {
  built: boolean;
  total?: number;
  senders: { name: string; email: string; count: number }[];
  folders: { folder: string; count: number }[];
  oldest?: string | null;
  newest?: string | null;
  error?: string;
}

// Where one term was found: the field it landed in, plus the text around it.
export interface SearchMatch { field: string; text: string; }

export interface UserDoc {
  id: string; title: string; category: string;
  file: string; origName: string; ext: string; size: number; date: string;
}

// ─── LSD Pricing ─────────────────────────────────────────────────────────────
// One priced transaction line, straight out of automation/lsd_pricing.py. The
// guardrail columns are carried through so the review table can show WHY each
// price is what it is, not just the number.
export interface LsdLine {
  material: string; description: string | null; group: string | null;
  qty: number; list: number | null; std_disc: number;
  unit_std: number | null; total_std: number | null;
  cost: number | null; total_cost: number | null;
  target_e2e: number | null; net_at_target: number | null; disc_at_target: number | null;
  requested: number | null; req_disc: number | null;
  cust_avg: number | null; cust_qty: number | null;
  ctry_avg: number | null; ctry_qty: number | null;
  rpi_floor: number | null; rpi_before: number | null; rpi_after: number | null;
  add_disc: number; unit_net: number | null; total_net: number | null;
  e2e: number | null; binds: string; raised: boolean;
  severity: 'action' | 'verify' | 'info' | 'ok'; flags: string;
}

export interface LsdSummary {
  lines: number; grand_total: number; total_standard: number;
  overall_add_disc: number | null; overall_e2e: number | null;
  overall_rpi: number | null; total_rpi: number | null;
  // The money behind those two ratios — what the daily register calls RPI Value.
  pv_value: number | null; rpi_value: number | null;
  // Lines held at the previous revision's price.
  carried?: number;
  raised: number; action: number; verify: number; no_py: number;
  currency: 'USD' | 'EUR';
  // One sentence saying what this transaction is — what changed, what it costs,
  // and whether anyone has to decide anything.
  headline?: string;
  rule?: 'requested' | 'e2e'; half?: 'H1' | 'H2'; rpi_rate?: number;
  // Lines priced under their target E2E — the reason an approval is asked for.
  below_target?: number; target_e2e?: number | null;
  // The two stages the approval mail quotes. `at_target` is the CUSTOMER's
  // requested price and what it would land; the table is the proposed price.
  at_target?: { target_price: number; e2e: number | null; rpi_pct: number | null;
                rpi_value: number; pv_value: number };
  groups?: Array<{ group: string; lines: number; add_disc: number | null;
                   net: number; e2e: number | null; target_e2e: number | null;
                   rpi_pct: number | null; rpi_value: number }>;
}

// One line of the LSD daily register, in the analyst's own column order. Every
// field is optional because the workbook is authoritative: a register swapped
// for a sheet that lacks a column simply never fills it.
export interface LsdRegisterRow {
  country?: string; bu?: string;
  transaction?: string; transaction_name?: string;
  customer?: string | number; customer_name?: string;
  status?: string; sales_name?: string; cpq_updated?: string;
  total_value?: number | null; out_date?: string; notes?: string;
  rpi_comment?: string; rpi_comment_2?: string;
  pv_pct?: number | null; rpi_pct?: number | null; rpi_value?: number | null;
  _row?: number;
}

export interface LsdRegister {
  ok: boolean; error?: string;
  register: string; name: string; exists?: boolean;
  rows?: LsdRegisterRow[]; total?: number; sheet?: string;
  headers?: Array<{ key: string; header: string; present: boolean }>;
  // Where the transactions get posted — the quotes' own list, not a folder.
  sp: { site: string; list: string; requestType: string };
  connected: boolean;
}

// What one push did, per transaction. `skipped` carries the reason — a BU with
// no DIVISION mapping, an INSIDE SALES name that could not be resolved.
export interface LsdPushResult {
  ok: boolean; error?: string;
  site?: string; list?: string;
  added?: number; updated?: number; skipped?: number; failed?: number;
  results?: Array<{ transaction: string; id?: number; reason?: string;
                    action: 'added' | 'updated' | 'skipped' | 'failed' | 'dry-run' }>;
  log?: Array<{ kind: 'info' | 'ok' | 'warn' | 'error'; msg: string }>;
}

// What the analyst's OneDrive already holds for this transaction, looked up the
// moment it is fetched — the first question on any deal is whether it has been
// priced before.
export interface LsdRevisions {
  ok: boolean; error?: string;
  latest?: number;            // 4 when R4 is the newest on file, 0 when only a first version
  next?: string;              // 'R5'
  files?: Array<{ name: string; path: string; type: string; modified: string; size: number }>;
  pulled?: { name: string; path: string; revision: number } | null;
}

// R4 → R5, line by line. Quantity moves carry their price; only a NEW item can
// move the margin, and a dropped one is worth seeing before it is missed.
export interface LsdDiff {
  prior: string; prior_lines: number; lines: number; unchanged: number;
  qty_changed: Array<{ material: string; description?: string; old_qty: number;
                       new_qty: number; delta: number; unit_net?: number }>;
  added: Array<{ material: string; description?: string; qty: number }>;
  removed: Array<{ material: string; qty: number; unit_net?: number }>;
}

export interface LsdResult {
  ok: boolean;
  error?: string;
  // The run was stopped from the tab, not a failure.
  cancelled?: boolean;
  mode?: 'preview' | 'build';
  lines?: LsdLine[];
  summary?: LsdSummary;
  diff?: LsdDiff | null;
  meta?: Record<string, string>;
  log?: Array<{ kind: 'info' | 'ok' | 'warn' | 'error'; msg: string }>;
  case_dir?: string; bom?: string; working?: string; feedback?: string;
  // The ledger alone, values only — what the approval mail attaches.
  ledger?: string;
  checks?: { ledger_T11: number; feedback_L10: number; python: number; agree: boolean };
  approval?: { proposed_price: number; total_cost: number | null;
               e2e_at_proposed: number | null; target_e2e: number | null;
               currency: string;
               at_target?: { target_price: number; e2e: number | null;
                             rpi_pct: number | null; rpi_value: number;
                             pv_value: number } };
  // What the build wrote into the daily register, if anything.
  register?: { ok: boolean; error?: string; action?: 'appended' | 'updated';
               path: string; skipped: string[] };
}

export interface LsdCase {
  name: string; path: string; mtime: number;
  files: Array<{ name: string; size: number; path: string }>;
}

// What the tab sends before it prices anything.
export interface LsdMeta {
  file: string;
  customer: string; customer_name: string; country: string;
  project: string; transaction: string; crm: string;
  half: 'auto' | 'H1' | 'H2';
  aprc: 'auto' | '525' | '530-535';
  ledger: string;
  // R1, R2, R3 … — a revision of a transaction already priced. Files are written
  // into the same case folder with that prefix, and every line the previous
  // revision already carried keeps its price.
  revision?: string;
  // Register fields. They ride along with the build, which registers the case
  // as soon as it is written; `register: false` builds without registering.
  bu?: string; status?: string; sales_name?: string; cpq_updated?: string;
  notes?: string; rpi_comment?: string;
  register?: boolean;
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

  // LSD Pricing — transaction in, case folder out
  lsdStatus:  () => axios.get<{
    master: string; masterName: string; masterDir: string;
    casesRoot: string; casesRootExists: boolean; ledger: string;
  }>('/api/lsd/status').then(r => r.data),
  lsdUpload:  async (file: File) => {
    const r = await fetch('/api/lsd/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    return r.json() as Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
  },
  // Pricing is pure Python and quick; the build drives Excel, so it gets minutes.
  // `job_id` is the handle Cancel uses; the AbortSignal only drops the client's
  // interest in the answer, it cannot stop Excel — /api/lsd/cancel does that.
  lsdPreview: (meta: LsdMeta & { job_id?: string }, signal?: AbortSignal) =>
    axios.post<LsdResult>('/api/lsd/preview', meta, { timeout: 180_000, signal }).then(r => r.data),
  lsdBuild:   (meta: LsdMeta & { job_id?: string; rebuild?: boolean }, signal?: AbortSignal) =>
    axios.post<LsdResult>('/api/lsd/build', meta, { timeout: 600_000, signal }).then(r => r.data),
  lsdCancel:  (jobId: string) =>
    axios.post<{ ok: boolean; error?: string }>('/api/lsd/cancel', { job_id: jobId },
      { timeout: 15_000 }).then(r => r.data),
  // Pull a transaction from Oracle CPQ (drives the logged-in debug-rail tab).
  lsdCpqFetch: (transaction: string) =>
    axios.post<LsdResult & { header?: Record<string, string>; file?: string; lines?: number;
                             revisions?: LsdRevisions }>(
      // CPQ (up to a reload and retry) plus the OneDrive revision check. The
      // server caps both well below this, so this only ever fires if the box
      // itself has stopped answering.
      '/api/lsd/cpq-fetch', { transaction }, { timeout: 300_000 }).then(r => r.data),
  // The approval ask. Always a DRAFT — it opens in Outlook and a human sends it.
  lsdApprovalMail: (body: { summary: unknown; meta: unknown; attach?: string[];
                            to?: string; cc?: string; subject?: string; intro?: string }) =>
    axios.post<{ ok: boolean; error?: string; draft?: boolean; to?: string; cc?: string;
                 subject?: string; attached?: string[];
                 log?: Array<{ kind: 'info' | 'ok' | 'warn' | 'error'; msg: string }> }>(
      '/api/lsd/approval-mail', body, { timeout: 180_000 }).then(r => r.data),
  lsdCases:   () => axios.get<{ root: string; cases: LsdCase[]; error?: string }>('/api/lsd/cases').then(r => r.data),
  lsdReveal:  (p: string) => axios.post<{ ok: boolean; error?: string }>('/api/lsd/reveal', { path: p }).then(r => r.data),
  lsdFileUrl: (p: string) => `/api/lsd/file?path=${encodeURIComponent(p)}`,
  // The daily register: read it, correct a row by hand, push it to SharePoint.
  lsdRegister:       () => axios.get<LsdRegister>('/api/lsd/register').then(r => r.data),
  lsdRegisterSave:   (row: LsdRegisterRow) =>
    axios.post<{ ok: boolean; error?: string; action?: string; rows?: LsdRegisterRow[] }>(
      '/api/lsd/register', { row }, { timeout: 60_000 }).then(r => r.data),
  // Post register rows to the Quotations List. No transactions = post them all.
  lsdRegisterPush:   (transactions: string[] = []) =>
    axios.post<LsdPushResult>('/api/lsd/register/push', { transactions },
      { timeout: 300_000 }).then(r => r.data),
  lsdRegisterFileUrl: () => '/api/lsd/register/file',

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
  // 240s, not 60s: the main brain now decides for itself whether to ground an answer
  // on the web, and a grounded multi-part question (search + fetch + cite, plus the
  // server's two backoff retries on a Gemini 503) runs well past a minute. At 60s the
  // client gave up mid-answer and reported "timeout of 60000ms exceeded" for a request
  // that was still working. The route itself has no deadline — see /api/ai in server.ts.
  ai:            (query: string, history?: Array<{role:string;text:string}>) =>
                   axios.post<{ answer: string | null; error?: string; source?: string; suggestions?: string[]; title?: string }>(
                     '/api/ai', { query, history }, { timeout: 240_000 }).then(r => r.data),
  aiStatus:      () => axios.get<{ available: boolean }>('/api/ai/status').then(r => r.data),
  aiModels:      () => axios.get<{ models: Array<{ id: string; label: string }>; current: string; fallback: string; error?: string }>('/api/ai-models').then(r => r.data),
  // Smart in-chat quote search: classifies the message, searches the D&Q Store +
  // Quotations List when it's a search, and returns a prose answer + result cards.
  // 240s for the same reason as `ai` above, and this is the one the Ask Vector tab
  // actually sends on: a search-classified message hits SharePoint (D&Q Store + the
  // Quotations List) before Gemini writes a word, so it is the slower of the two.
  quoteAsk:      (query: string, history?: Array<{role:string;text:string}>) =>
                   axios.post<{ answer: string | null; results?: DqDoc[]; meta?: { count: number; scope: string; term: string }; error?: string; suggestions?: string[]; title?: string }>(
                     '/api/quote-ask', { query, history }, { timeout: 240_000 }).then(r => r.data),

  // Analytics
  analytics: (days: number) => axios.get<AnalyticsResponse>('/api/analytics', { params: { days } }).then(r => r.data),

  // Outlook
  outlookStatus:      () => axios.get<{ available: boolean; backend?: string; newOutlook?: boolean; graphAuth?: boolean; imapSetup?: boolean; name?: string; email?: string; error?: string }>('/api/outlook/status', { timeout: 15_000 }).then(r => r.data),
  outlookGraphConnect: () => axios.post<{ ok: boolean; name?: string; email?: string; error?: string }>('/api/outlook/graph-connect', {}, { timeout: 120_000 }).then(r => r.data),
  outlookImapConfig:  (email: string, password: string) => axios.post<{ ok: boolean; email?: string; error?: string }>('/api/outlook/imap-config', { email, password }, { timeout: 30_000 }).then(r => r.data),
  outlookMailboxes:   () => axios.get<{ mailboxes: any[]; error?: string }>('/api/outlook/mailboxes', { timeout: 20_000 }).then(r => r.data),
  outlookEmails:      (storeId: string, limit = 30, unread = false, signal?: AbortSignal) =>
                        axios.get<{ emails: any[]; error?: string }>('/api/outlook/emails', { params: { storeId, limit, unread }, timeout: 60_000, signal }).then(r => r.data),
  // `storeId` is the mailbox the hit came from; a shared-mailbox EntryID does
  // not resolve against the default store, so opening fails without it.
  outlookEmail:       (id: string, storeId?: string, signal?: AbortSignal) =>
                        axios.get<any>(`/api/outlook/email/${encodeURIComponent(id)}`, { params: { store: storeId || 'default' }, timeout: 30_000, signal }).then(r => r.data),
  // Searches the scoped mail index (UKQuoteFactoryEL → Inbox + Completed by
  // Laith): subject, sender, recipients, body and attachment names. Falls back to
  // a live Outlook sweep while the index is still cold.
  // `mode` decides what counts as a hit for each term: 'part' (substring, the
  // default), 'word' (the term on its own) or 'start' (the term starting a word).
  // `scope` decides which text the terms are matched against, and `filters`
  // narrow the hits by sender, date, folder, attachments and read state — a
  // filter is a question on its own, so a filtered search runs with an empty box.
  // Every hit comes back with `matches` — the field it landed in and the text
  // around it, so a body/recipient/attachment hit can be shown, not just claimed.
  outlookSearch:      (q: string, opts: { limit?: number; fields?: 'all' | 'meta'; scope?: SearchScope; source?: 'auto' | 'index' | 'live'; mode?: MatchMode; filters?: SearchFilters } = {}, signal?: AbortSignal) =>
                        axios.get<{ emails: any[]; total?: number; source?: string; indexTotal?: number; lastSync?: string | null; folders?: number; truncated?: boolean; degraded?: number; mode?: MatchMode; scope?: SearchScope; sort?: 'new' | 'old'; filters?: Record<string, string>; error?: string }>(
                          '/api/outlook/search',
                          { params: { q, limit: opts.limit ?? 200, fields: opts.fields || 'all',
                                      scope: opts.scope || '', source: opts.source || 'auto', mode: opts.mode || 'part',
                                      from:   opts.filters?.from   || '',
                                      since:  opts.filters?.since  || '',
                                      until:  opts.filters?.until  || '',
                                      folder: opts.filters?.folder || '',
                                      att:    opts.filters?.att    || 'any',
                                      read:   opts.filters?.read   || 'any',
                                      sort:   opts.filters?.sort   || 'new' },
                            timeout: 300_000, signal }).then(r => r.data),
  // The values the filters offer — senders the mailbox has actually seen, the
  // folders covered, and how far back the index reaches.
  outlookSearchFacets: (signal?: AbortSignal) =>
                        axios.get<SearchFacets>('/api/outlook/search/facets', { timeout: 20_000, signal }).then(r => r.data),
  outlookIndexStatus: (signal?: AbortSignal) =>
                        axios.get<{ built: boolean; total: number; lastSync?: string | null; syncing?: boolean; folders: { folder: string; items: number; lastSync: string }[]; error?: string }>(
                          '/api/outlook/index/status', { timeout: 20_000, signal }).then(r => r.data),
  outlookIndexSync:   (full = false) =>
                        axios.post<{ ok?: boolean; added?: number; removed?: number; total?: number; seconds?: number; error?: string }>(
                          '/api/outlook/index/sync', { full }, { timeout: 900_000 }).then(r => r.data),
  // 240s, not 90s: a multimodal summarize can run ~60s on its own and the server now retries
  // a Gemini 503 twice with backoff — a short client timeout would abort mid-retry and show
  // "timeout exceeded" instead of letting the retry succeed.
  outlookSummarize:      (payload: any, signal?: AbortSignal) => axios.post<{ summary: string | null; cached?: boolean; imagesRead?: number; error?: string }>('/api/outlook/summarize', payload, { timeout: 240_000, signal }).then(r => r.data),
  outlookGetSummary:     (entryId: string, signal?: AbortSignal) => axios.get<{ summary: string | null; includedIndices?: number[]; ts?: string }>(`/api/outlook/summary/${encodeURIComponent(entryId)}`, { timeout: 15_000, signal }).then(r => r.data),
  outlookSaveAttachment: (entryId: string) => axios.post<{ saved: any[]; count: number; error?: string }>('/api/outlook/save-attachment', { entryId }, { timeout: 30_000 }).then(r => r.data),
  outlookDraftReply:     (payload: any, signal?: AbortSignal) => axios.post<{ draft: string | null; error?: string }>('/api/outlook/draft-reply', payload, { timeout: 150_000, signal }).then(r => r.data),
  // Rewrites text the USER wrote — the Reply box never fills itself in.
  outlookPolishReply:    (payload: { text: string; mode?: 'polish' | 'shorten' | 'formalize' | 'rewrite'; subject?: string; sender?: string; senderEmail?: string; body?: string; analysis?: string }, signal?: AbortSignal) =>
                           axios.post<{ text: string | null; error?: string }>('/api/outlook/polish-reply', payload, { timeout: 150_000, signal }).then(r => r.data),
  // Picks the real recipient (often NOT the sender) out of supplied candidates
  // and writes the covering note that goes with the attached quote.
  outlookSuggestSend:    (payload: { subject?: string; sender?: string; senderEmail?: string; body?: string; analysis?: string; candidates: Array<{ name?: string; email: string; why?: string }>; attachmentNames?: string[] }, signal?: AbortSignal) =>
                           axios.post<{ to?: string; cc?: string[]; subject?: string; body?: string; why?: string; error?: string }>('/api/outlook/suggest-send', payload, { timeout: 120_000, signal }).then(r => r.data),
  outlookSendReply:      (entryId: string, body: string) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/send-reply', { entryId, body }, { timeout: 30_000 }).then(r => r.data),
  outlookFeedback:       (payload: any) => axios.post<{ ok?: boolean; error?: string }>('/api/outlook/feedback', payload, { timeout: 10_000 }).then(r => r.data),
  feedback:              (payload: { message: string; category?: string; page?: string; userName?: string | null; userEmail?: string | null }) =>
                           axios.post<{ ok?: boolean; stored?: boolean; emailed?: boolean; error?: string }>('/api/feedback', payload, { timeout: 30_000 }).then(r => r.data),
  outlookChat:           (payload: any, signal?: AbortSignal) => axios.post<{ answer: string | null; error?: string }>('/api/outlook/chat', payload, { timeout: 150_000, signal }).then(r => r.data),
  // EL Internal Info tab
  elInternalList:        (signal?: AbortSignal) => axios.get<{ emails: any[]; digest: string | null; digestAt: string | null; lastRefreshAt: string | null }>('/api/el-internal/list', { timeout: 15_000, signal }).then(r => r.data),
  elInternalRefresh:     (signal?: AbortSignal) => axios.post<{ added: number; total: number; emails: any[]; lastRefreshAt: string; error?: string }>('/api/el-internal/refresh', {}, { timeout: 120_000, signal }).then(r => r.data),
  elInternalDigest:      (signal?: AbortSignal) => axios.post<{ digest: string | null; digestAt?: string; error?: string }>('/api/el-internal/digest', {}, { timeout: 90_000, signal }).then(r => r.data),
  elInternalChat:        (payload: { history: any[]; question: string }, signal?: AbortSignal) => axios.post<{ answer: string | null; error?: string }>('/api/el-internal/chat', payload, { timeout: 60_000, signal }).then(r => r.data),
  // Fenton KB tab
  fentonList:            (signal?: AbortSignal) => axios.get<{ cards: any[]; lastRefreshAt: string | null }>('/api/fenton/list', { timeout: 15_000, signal }).then(r => r.data),
  fentonRefresh:         (force = false, signal?: AbortSignal) => axios.post<{ added: number; total: number; skipped: number; cards: any[]; lastRefreshAt: string; error?: string }>('/api/fenton/refresh', { force }, { timeout: 600_000, signal }).then(r => r.data),
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
  // draft:true stops in the Outlook Drafts folder and pops the composer.
  outlookSendNew:        (to: string, subject: string, body: string, attSources: any[], opts: { cc?: string; draft?: boolean } = {}) =>
                           axios.post<{ ok?: boolean; draft?: boolean; error?: string }>('/api/outlook/send-new', { to, subject, body, attSources, cc: opts.cc, draft: opts.draft }, { timeout: 60_000 }).then(r => r.data),

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

  // ── CRM · mailbox source (quotes swept out of Outlook, mine vs the team's) ──
  // The sweep walks every folder of every store, so give it real time.
  crmMailStatus:  () => axios.get<CrmMailScanStatus>('/api/crm/mailbox/status', { timeout: 15_000 }).then(r => r.data),
  crmMailScan:    (days = 90) =>
                    axios.post<CrmMailScanStatus>('/api/crm/mailbox/scan', { days }, { timeout: 30_000 }).then(r => r.data),
  crmMailQuotes:  (side: 'mine' | 'team' | 'all', q = '') =>
                    axios.get<{ quotes: CrmMailQuote[]; counts: { total: number; mine: number; team: number }; lastScanAt: string | null }>(
                      '/api/crm/mailbox/quotes', { params: { side, q }, timeout: 20_000 }).then(r => r.data),
  crmMailSide:    (qkey: string, side: 'mine' | 'team' | '') =>
                    axios.post<{ ok: boolean; quote: CrmMailQuote; counts: { total: number; mine: number; team: number } }>(
                      '/api/crm/mailbox/quote/side', { qkey, side }).then(r => r.data),

  // ── Quick check-up (quote mail not yet on the Quotations List) ─────────────
  // Scans Outlook then checks SharePoint per reference, so allow real time.
  quotesCheckup:      (days = 30, signal?: AbortSignal) =>
                        axios.get<CheckupResponse>('/api/quotes/checkup', { params: { days }, timeout: 300_000, signal }).then(r => r.data),
  quotesCheckupQueue: (entryIds: string[]) =>
                        axios.post<{ ok: boolean; saved: string[]; count: number; failed: any[]; error?: string }>(
                          '/api/quotes/checkup/queue', { entryIds }, { timeout: 180_000 }).then(r => r.data),

  // ── Job report (whole-mailbox work log over a period) ──────────────────────
  jobsReportScan:   (from: string, to: string) =>
                      axios.post<JobsReportStatus>('/api/jobs-report/scan', { from, to }, { timeout: 30_000 }).then(r => r.data),
  jobsReportStatus: () => axios.get<JobsReportStatus>('/api/jobs-report/status', { timeout: 15_000 }).then(r => r.data),
  jobsReportResult: () => axios.get<{ report: JobsReport | null; lastScanAt?: string; categories: string[] }>(
                            '/api/jobs-report/result', { timeout: 20_000 }).then(r => r.data),

  // ── To-Do (triage of the shared mailbox into things still owed) ────────────
  // The scan sweeps every folder of the shared box, so give it real time.
  todoList:       (status: 'all' | 'open' | 'done' = 'all') =>
                    axios.get<{ items: TodoItem[]; lastScanAt: string | null; lastContactsAt: string | null; mailbox: string }>(
                      '/api/todo', { params: { status }, timeout: 20_000 }).then(r => r.data),
  todoScan:       (days = 30) =>
                    axios.post<TodoScanStatus>('/api/todo/scan', { days }, { timeout: 30_000 }).then(r => r.data),
  todoScanStatus: () => axios.get<TodoScanStatus>('/api/todo/scan/status', { timeout: 15_000 }).then(r => r.data),
  todoSave:       (patch: Partial<TodoItem> & { id?: number }) =>
                    axios.post<{ ok: boolean; item: TodoItem; error?: string }>('/api/todo', patch, { timeout: 20_000 }).then(r => r.data),
  todoDelete:     (id: number) => axios.delete<{ ok: boolean }>(`/api/todo/${id}`, { timeout: 15_000 }).then(r => r.data),
  // draft:true stops in the Outlook Drafts folder; otherwise the mail is sent.
  todoSend:       (id: number, draft = false) =>
                    axios.post<{ ok: boolean; draft?: boolean; item?: TodoItem; error?: string }>(
                      `/api/todo/${id}/send`, { draft }, { timeout: 60_000 }).then(r => r.data),
  todoWriteDraft: (id: number, signal?: AbortSignal) =>
                    axios.post<{ ok?: boolean; subject?: string; body?: string; error?: string }>(
                      '/api/todo/draft', { id }, { timeout: 60_000, signal }).then(r => r.data),
  todoRecipients: () => axios.get<{ recipients: TodoRecipientOption[]; lastContactsAt: string | null }>(
                          '/api/todo/recipients', { timeout: 20_000 }).then(r => r.data),
  todoRefreshRecipients: (days = 365) =>
                    axios.post<{ ok: boolean; count?: number; scanned?: number; error?: string }>(
                      '/api/todo/recipients/refresh', { days }, { timeout: 300_000 }).then(r => r.data),

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

// ─── One row of the batch that needs a decision before upload ────────────────
// 'duplicate'  — already in SharePoint (or twice in this batch)
// 'blank'      — extraction found no id, no code and no name
// 'incomplete' — uploadable, but missing SALESFORCE ID / REQUESTED FROM
export interface ConflictItem {
  key:              string;   // CSV row index — the decision key
  kind:             'duplicate' | 'blank' | 'incomplete';
  matchedOn:        string;   // which field matched the existing item
  sfid:             string;
  rowLabel:         string;
  missing:          string[];
  existingId:       number;
  existingTitle:    string;
  existingCustomer: string;
  existingCreated:  string;
  defaultAction:    'replace' | 'add' | 'skip';
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
