// ─── Shared types ────────────────────────────────────────────────────────────

export type JobStatus = 'ok' | 'err' | 'warn';

export interface Job {
  id: number;
  timestamp: string;        // ISO
  step: string;             // "Step 1" | "Step 2"
  pdfName: string | null;
  sfId: string | null;
  status: JobStatus;
  items: number;
  note: string | null;

  // Optional enrichment columns — populated when known
  product:     string | null;
  customer:    string | null;
  price:       number | null;
  salesman:    string | null;
  durationSec: number | null;
}

export interface DashboardStats {
  pdfsQueued:    number;
  emailsInDrop:  number;
  archivedToday: number;
}

export interface Config {
  base:        string;
  initials:    string;
  sp_site:     string;
  sp_list:     string;
  dq_store:    string;
  gemini_key?:     string;
  gemini_key_set?: boolean;
  ai_model?:       string;   // Ask Vector "smart" model id (Settings dropdown); blank = server default
  job_categories?: string[]; // Report tab buckets; blank = server defaults
  // Salesman roster. Lives here rather than in source because it is colleagues'
  // names, work emails and personal mobiles — config.json is gitignored.
  cbu_salesmen?:   { name: string; email: string; phone: string }[];
  // LSD Pricing. The master model holds every price, cost, E2E target and
  // prior-year average, so the tab cannot price anything without it; blank means
  // "use the newest .xlsb in data/lsd".
  lsd_master_model?: string;
  lsd_cases_root?:   string;   // blank = Desktop\LSD Pricing Doc when it exists
  lsd_ledger?:       string;   // MV Ledger code for the country prior-year lookup
  lsd_cpq_port?:     string;   // Edge remote-debugging port for Fetch-from-CPQ (blank = 9222)
  // The daily register: one row per priced transaction, shaped like the
  // analyst's "LSD Daily work" sheet, uploaded to SharePoint like the quotes.
  lsd_register?:     string;   // blank = <case root>\LSD Daily Work - Vector.xlsx
  lsd_request_type?: string;   // REQUEST TYPE choice used on posted list items (blank = Standard CTO)
  lsd_sales_name?:   string;   // default "Sales Name" column (blank = inside_sales)
  lsd_bu?:           string;   // default BU column (blank = guessed from the APRC)
  // Who a sub-target margin is mailed to. Display names are GAL-resolved, and
  // the mail is always drafted — never sent by Vector.
  lsd_approver?:     string;
  lsd_approver_cc?:  string;
}

// ─── Quick check-up: quote mail vs the Quotations List ───────────────────────

// 'missing'    — SharePoint answered and has no row for this reference
// 'unverified' — has a reference but SharePoint couldn't be asked (not connected)
// 'noref'      — quote-looking mail carrying no reference at all
export type CheckupStatus =
  | 'missing' | 'unverified' | 'uploaded' | 'queued' | 'processed' | 'noref';

export interface CheckupDoc  { index: number; name: string; size: number }

export interface CheckupItem {
  entryId:        string;
  subject:        string;
  sender:         string;
  senderEmail:    string;
  received:       string;
  folder:         string;
  isNotification: boolean;
  refs:           string[];
  sfid:           string | null;
  docs:           CheckupDoc[];
  status:         CheckupStatus;
  spTitle:        string | null;
  spCustomer:     string | null;
}

export interface CheckupResponse {
  items:     CheckupItem[];
  scanned:   number;
  days:      number;
  connected: boolean;
  counts:    { missing: number; unverified: number; uploaded: number; queued: number };
  warning:   string | null;
  error?:    string;
}

// ─── Job report ──────────────────────────────────────────────────────────────

export interface JobThread {
  conv:        string;
  topic:       string;
  category:    string;
  summary:     string;
  counterpart: string;
  msgs:        number;
  sent:        number;
  first:       string;
  last:        string;
  folders:     string[];
  completed:   boolean;
  hasAtt:      boolean;
}

export interface JobsReport {
  range:       { from: string; to: string };
  generatedAt: string;
  totals: {
    threads: number; messages: number; replies: number;
    completedFiled: number; scanned: number;
  };
  byCategory: Array<{ category: string; threads: number; messages: number; replies: number; pct: number }>;
  daily:      Array<{ date: string; count: number }>;
  folders:    Array<{ folder: string; count: number }>;
  threads:    JobThread[];
  truncated:  boolean;
}

export interface JobsReportStatus {
  running:     boolean;
  phase:       'idle' | 'scanning' | 'grouping' | 'classifying' | 'done' | 'error';
  message:     string;
  messages:    number;
  threads:     number;
  classified:  number;
  toClassify:  number;
  from:        string;
  to:          string;
  error:       string | null;
  truncated:   boolean;
  startedAt:   string | null;
  started?:    boolean;
}

// ─── To-Do (unanswered mail triaged into things still owed) ──────────────────

/** direct = doable here · needs_info = blocked on a fact · needs_team = someone else must act */
export type TodoBucket = 'direct' | 'needs_info' | 'needs_team';
/** open = still owed · waiting = delegated, awaiting an answer · done = closed */
export type TodoStatus = 'open' | 'waiting' | 'done';

export interface TodoAttachment { index: number; name: string; size?: number; }
export interface TodoRecipient   { name: string; email: string; }

export interface TodoItem {
  id:           number;
  conv:         string;
  entryId:      string;          // source email — where attachments are pulled from
  subject:      string;
  sender:       string;
  senderEmail:  string;
  received:     string;
  bucket:       TodoBucket;
  title:        string;
  summary:      string;          // extract of the source email
  action:       string;          // the concrete next step
  blocker:      string;          // what is missing / who must act
  notes:        string;
  recipients:   TodoRecipient[];
  attachments:  TodoAttachment[];
  draftSubject: string;
  draftBody:    string;          // never sent until the user presses Send
  due:          string;          // YYYY-MM-DD
  priority:     'high' | 'normal';
  status:       TodoStatus;
  source:       'scan' | 'manual' | 'inbox' | string;
  createdAt:    string;
  updatedAt:    string;
  doneAt:       string | null;
  sentAt:       string | null;
}

export interface TodoScanStatus {
  running:   boolean;
  phase:     'idle' | 'scanning' | 'triaging' | 'done' | 'error';
  message:   string;
  threads:   number;
  triaged:   number;
  created:   number;
  updated:   number;
  days:      number;
  mailbox:   string;
  error:     string | null;
  startedAt: string | null;
  started?:  boolean;
  // Persisted alongside the run, so a restart or refresh still shows the last
  // scan's outcome instead of an empty panel.
  counts:         { total: number; open: number; waiting: number; done: number };
  lastScanAt:     string | null;
  lastContactsAt: string | null;
}

export interface TodoRecipientOption {
  name:     string;
  email:    string;
  count:    number;               // messages exchanged — drives the ranking
  lastSeen: string;
  source:   'outlook' | 'crm' | 'both';
}

export interface PdfFile    { name: string; size: number; modified: string; }
export interface ArchiveDay { date: string; files: string[]; total: number; }

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsResponse {
  range:        { days: number; from: string; to: string };
  totals:       AnalyticsTotals;
  prevTotals:   AnalyticsTotals;
  daily:        Array<{ date: string; label: string; ok: number; warn: number; err: number }>;
  byProduct:    Array<{ code: string; label: string; color: string; ok: number; warn: number; err: number; total: number; value: number }>;
  byCustomer:   Array<{ customer: string; count: number; value: number; err: number }>;
  bySalesman:   Array<{ salesman: string; count: number; value: number; err: number }>;
  byStep:       { 'Step 1': number; 'Step 2': number };
  errorReasons: Array<{ reason: string; count: number }>;
  heatmap:      { days: string[]; hours: string[]; grid: number[][]; max: number };
}

export interface AnalyticsTotals {
  count:    number;
  ok:       number;
  warn:     number;
  err:      number;
  okPct:    number;
  value:    number;
  avgDur:   number;
  items:    number;
}

// ─── Enriched search result (matches new /api/search response) ───────────────

export interface SearchResult {
  Id:                     number;
  Title:                  string;
  SALESFORCEID:           string;
  QUOTATION_x0020_NAME?:  string;
  CUSTOMER?:              string;
  DIVISION?:              string;
  STATUS?:                string;
  PRICE?:                 number | string;
  ARRIVED_x0020_ON?:      string;
  REQUESTED_x0020_BY?:    string;
  REQUEST_x0020_TYPE?:    string;
  Country?:               string;
  DUEDATE?:               string;
}

// ─── D&Q Store full-text document hit ────────────────────────────────────────
export interface DqDoc {
  title:     string;
  filename:  string;
  ext:       string;
  url:       string;
  author?:   string;
  modified?: string;
  summary?:  string;
}

// ─── Mini CRM ────────────────────────────────────────────────────────────────

export interface CrmContact {
  id:        number;
  companyId: number;
  name:      string;
  role:      string | null;
  email:     string | null;
  phone:     string | null;
  notes:     string | null;
  createdAt: string;
  auto?:     boolean;   // derived from the quote salesman (not user-saved)
}

export interface CrmFact {
  id:        number;
  companyId: number;
  text:      string;
  source:    'manual' | 'ai';
  createdAt: string;
}

export interface CrmCompany {
  id:        number;
  name:      string;
  country:   string | null;
  tags:      string | null;
  notes:     string | null;
  aliases?:  string[];   // jobs.customer strings this account claims
  createdAt: string;
  updatedAt: string;
}

// Row in the account grid — account plus rollups derived live from jobs.
export interface CrmCompanyCard extends CrmCompany {
  aliases:      string[];
  aliasCount:   number;
  contactCount: number;
  quoteCount:   number;
  openCount:    number;
  totalValue:   number;
  openValue:    number;
  salesmen:     string[];
  lastQuote:    string | null;
}

// AI-generated observation about an account.
export interface CrmInsight {
  type: 'fact' | 'warning';
  text: string;
}

// A distinct quote derived live from the jobs table, with pipeline state.
export interface CrmQuote {
  id:        number;
  key:       string;          // stable identity (sfId or raw customer string)
  ref:       string;          // leading Salesforce/case ID, for display
  name:      string;          // cleaned quote/customer name
  timestamp: string;
  sfId:      string | null;
  product:   string | null;
  price:     number | null;
  salesman:  string | null;
  status?:   string | null;   // SharePoint quote status (when enriched)
  customer?: string | null;
  runs:      number;          // how many job runs share this quote
  state:     'open' | 'won' | 'lost';
}

// A quote found by sweeping Outlook rather than SharePoint. `side` is who the
// job belongs to — 'mine' = this desk issued or filed it, 'team' = a colleague
// did and it is merely visible from here.
export interface CrmMailQuote {
  key:         string;              // normalised SF id, or BidManager number
  kind:        'sfid' | 'bm';
  ref:         string;              // the reference as it was written in the mail
  subject:     string;
  account:     string | null;
  companyId:   number | null;
  matchedBy:   'reference' | 'name' | 'subject' | null;
  sender:      string;
  senderEmail: string;
  recipients:  string;
  first:       string;
  last:        string;
  entryId:     string;
  folder:      string;              // where the representative message sits
  store:       string;
  folders:     string[];            // every folder this quote turned up in
  docs:        Array<{ index: number; name: string; size: number }>;
  msgs:        number;
  side:        'mine' | 'team';     // effective side (override wins)
  scannerSide: 'mine' | 'team';     // what the scan itself decided
  overridden:  boolean;
  why:         string;              // plain-English reason for the verdict
  whyFolder:   string;              // the folder that reason came from
}

export interface CrmMailScanStatus {
  running:    boolean;
  phase:      'idle' | 'scanning' | 'matching' | 'done' | 'error';
  message:    string;
  error:      string | null;
  days:       number;
  scanned:    number;
  found:      number;
  mine:       number;
  team:       number;
  startedAt:  string | null;
  finishedAt: string | null;
  counts:     { total: number; mine: number; team: number };
  lastScanAt: string | null;
  started?:   boolean;
}

export interface CrmCompanyDetail {
  company:  CrmCompany;
  contacts: CrmContact[];
  facts:    CrmFact[];
  quotes:   CrmQuote[];
  enriched: boolean;   // true when quotes were enriched from SharePoint
  mailQuotes?: CrmMailQuote[];
  opp:      { count: number; value: number };
}

// ─── Legacy CBU types — kept for CBUCalculator.tsx ───────────────────────────

export type QuotationStatus = 'Pending' | 'Processed' | 'Error' | 'On Hold';

export interface Quotation {
  id:             string;
  salesforceId:   string;
  quotationCode:  string;
  quotationName:  string;
  price:          number;
  currency:       string;
  status:         QuotationStatus;
  arrivedOn:      string;
  dueDate:        string;
  insideSales:    string;
  requestedBy:    string;
  productType:    'CTO' | 'DTO';
}
