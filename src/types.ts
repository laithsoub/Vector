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
  gemini_key?: string;
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

export interface CrmCompanyDetail {
  company:  CrmCompany;
  contacts: CrmContact[];
  facts:    CrmFact[];
  quotes:   CrmQuote[];
  enriched: boolean;   // true when quotes were enriched from SharePoint
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
