import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync, statSync, unlinkSync, mkdirSync, rmdirSync, createReadStream, copyFileSync, renameSync
} from 'fs';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { request as httpsRequest } from 'https';
import { createServer as netCreateServer } from 'net';
import { AsyncLocalStorage } from 'async_hooks';
import { createRequire } from 'module';
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'crypto';
import initSqlJs from 'sql.js';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// Corporate SSL inspection presents self-signed certs on the Eaton hosts, so the
// three SharePoint/Graph helpers pass rejectUnauthorized:false themselves (spPost,
// spGet, graphPost). That stays scoped to those calls on purpose: this used to be
// a process-wide NODE_TLS_REJECT_UNAUTHORIZED='0', which also stopped verifying
// the Gemini connection the API key travels on.
// If the proxy turns out to intercept Google too, the fix is to trust the
// corporate root — set NODE_EXTRA_CA_CERTS to its .pem — not to switch checking
// off again. VECTOR_INSECURE_TLS=1 restores the old behaviour as a last resort and
// says so loudly on startup.
if (process.env.VECTOR_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[tls] VECTOR_INSECURE_TLS=1 — certificate verification is OFF for every outbound request, including Gemini.');
} else if (!process.env.NODE_EXTRA_CA_CERTS) {
  // Eaton's Zscaler proxy re-signs every HTTPS connection, so Node — which does
  // not use the Windows trust store — rejects them with SELF_SIGNED_CERT_IN_CHAIN
  // unless it is given the corporate root. `npm run certs` exports it and the dev
  // scripts point this variable at the result. Setting it here would be too late:
  // Node reads it once, at startup, before any of this runs.
  console.warn('[tls] NODE_EXTRA_CA_CERTS is not set — behind the corporate proxy every AI call will fail with SELF_SIGNED_CERT_IN_CHAIN. Run `npm run certs`, then start via `npm run dev`.');
}

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
// In Tauri sidecar mode Rust passes RESOURCE_DIR + DATA_DIR; fall back to __dirname for local dev.
const RESOURCE_DIR = process.env.RESOURCE_DIR ?? __dirname;
const DATA_DIR     = process.env.DATA_DIR     ?? __dirname;
const DB_PATH      = path.join(DATA_DIR, 'eaton_automation.db');
// All Python scripts + their assets (config.json, el_pricelist.xlsx, docs/, …)
// live together under automation/ so each script's __file__-relative lookups work.
const PY_DIR       = path.join(RESOURCE_DIR, 'automation');
const pyFile       = (name: string) => path.join(PY_DIR, name);
// Writable config: DATA_DIR/config.json in sidecar, automation/config.json in dev.
const APP_CFG_PATH = process.env.DATA_DIR
  ? path.join(DATA_DIR, 'config.json')
  : path.join(PY_DIR, 'config.json');

// ── Product → colour map (shared with /api/analytics + frontend) ───────────
const PRODUCT_META: Record<string, { label: string; color: string }> = {
  'PDC':             { label: 'PDC',             color: '#0044a7' },
  'ICP':             { label: 'ICP',             color: '#3f63f0' },
  'EL':              { label: 'EL',              color: '#6366f1' },
  'FIRE':            { label: 'Fire',            color: '#dc2626' },
  'MV-COMBINATION':  { label: 'MV Combination',  color: '#7c3aed' },
  'MV-SWITCHGEAR':   { label: 'MV Switchgear',   color: '#a855f7' },
  'MV-TRANSFORMER':  { label: 'MV Transformer',  color: '#c026d3' },
  'DPQ':             { label: 'DPQ',             color: '#0891b2' },
  'CPS':             { label: 'CPS',             color: '#0d9488' },
  'EVCI':            { label: 'EVCI',            color: '#059669' },
  'ENERGY STORAGE':  { label: 'Energy Storage',  color: '#65a30d' },
  'EL & FIRE':       { label: 'EL & Fire',       color: '#ca8a04' },
};

// ── Session tracking ───────────────────────────────────────────────────────
let sessionStartedAt: string | null = null;

// Truncate-then-write leaves nothing behind if the process dies mid-write, and
// config.json holds credentials that are painful to re-enter. Write beside the
// target, then rename — atomic on NTFS.
function writeFileAtomic(target: string, data: string | Buffer) {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

// ── Content-Disposition ──────────────────────────────────────────────────────
// A quote or a newline in a stored filename breaks out of the quoted parameter,
// and the browser then saves the file under something other than what the header
// says. Every download used to build this header by hand and they disagreed about
// it — some stripped quotes, most did not.
//
// The shape here is the one /api/pmo/download already used: an ASCII-safe
// `filename` that any client can parse, plus RFC 5987 `filename*` carrying the
// real name with its accents and spaces intact. Modern browsers prefer the
// second; anything older still gets a sane name.
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const clean = String(name || 'download').replace(/[\r\n]/g, ' ').trim() || 'download';
  const ascii = clean.replace(/[^\w\s().,-]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

// Extensions end up in a filesystem path and in the MIME lookup, so they get to
// be letters and digits and nothing else. `[^.]+` used to allow path separators.
function safeExt(name: string, fallback = 'bin'): string {
  const raw = (String(name || '').match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : fallback;
}

// ── Swallowed errors ─────────────────────────────────────────────────────────
// Plenty of the empty catches in this file are correct — a COM property that may
// not exist, a cookie file that may not be there. The problem was that they were
// indistinguishable from the ones hiding a real failure, and nothing counted
// them, so a sweep quietly returning half the mail left no trace anywhere.
//
// swallow() keeps the catch silent by default but makes it *countable*: the
// tallies show up on /api/debug, and VECTOR_DEBUG=1 prints each one as it lands.
// Being converted gradually — mail and SharePoint paths first.
const _swallowed = new Map<string, { n: number; last: string }>();
function swallow(where: string, e?: unknown) {
  const msg = e instanceof Error ? e.message : e ? String(e) : '';
  const prev = _swallowed.get(where);
  _swallowed.set(where, { n: (prev?.n ?? 0) + 1, last: msg || prev?.last || '' });
  if (process.env.VECTOR_DEBUG === '1') console.warn(`[swallow] ${where}: ${msg}`);
}
function swallowReport() {
  return [..._swallowed.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([where, v]) => ({ where, count: v.n, last: v.last }));
}

// ── Config ─────────────────────────────────────────────────────────────────
// The only keys the app owns. POST /api/config used to spread the whole request
// body into the saved file, so any caller could set keys Settings never shows —
// sp_site and dq_store among them, which decide where quotes get uploaded.
const CONFIG_KEYS = [
  'base', 'initials', 'sp_site', 'sp_list', 'dq_store',
  'inside_sales', 'azure_di_endpoint', 'azure_di_key',
  'gemini_key', 'ai_model', 'job_categories', 'cbu_salesmen',
  'lsd_master_model', 'lsd_cases_root', 'lsd_ledger', 'lsd_cpq_port',
  'lsd_register', 'lsd_sales_name', 'lsd_bu', 'lsd_request_type',
  'lsd_approver', 'lsd_approver_cc',
  'lsd_keepalive', 'lsd_keepalive_min', 'lsd_keepalive_urls',
  'lsd_queue', 'lsd_queue_min', 'lsd_daily_file', 'lsd_queue_bu',
] as const;

// ── Salesman roster ──────────────────────────────────────────────────────────
// Colleagues' names, work emails and personal mobile numbers. This lived as a
// hardcoded array in three source files, which put it in the repository — and the
// repository was public for a while. It belongs in config.json, which is
// gitignored, so it is entered once per install and never committed again.
// Everything that needs it (this file, the CBU sizer, the Inbox generator) now
// reads it from there through /api/config.
export interface Salesman { name: string; email: string; phone: string }

function salesmenRoster(): Salesman[] {
  const raw = (loadPyCfg() as any).cbu_salesmen;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(r => r && typeof r.name === 'string' && r.name.trim())
    .map(r => ({
      name:  String(r.name).trim(),
      email: String(r.email || '').trim(),
      phone: String(r.phone || '').trim(),
    }));
}

function loadPyCfg(): Record<string, string> {
  const defaults: Record<string, string> = {
    base:     path.join(DATA_DIR, 'data'),
    initials: 'LS',
    sp_site:  'https://eaton.sharepoint.com/sites/ELTechsupport',
    sp_list:  'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA',
    dq_store: 'Shared Documents/D&Q Store',
  };
  for (const cfgPath of [APP_CFG_PATH, pyFile('config.json')]) {
    try {
      if (existsSync(cfgPath))
        return { ...defaults, ...JSON.parse(readFileSync(cfgPath, 'utf8')) };
    } catch {}
  }
  return defaults;
}

// ── sql.js — initialized inside startServer() to avoid top-level await ────────
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let db: any;

function loadDb() {
  db = existsSync(DB_PATH)
    ? new SQL.Database(readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL, step TEXT NOT NULL,
    pdfName TEXT, sfId TEXT, status TEXT NOT NULL,
    items INTEGER DEFAULT 0, note TEXT,
    product TEXT, customer TEXT, price REAL, salesman TEXT, durationSec INTEGER
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS email_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    entryId TEXT NOT NULL,
    subject TEXT,
    senderEmail TEXT,
    emailType TEXT,
    draftReply TEXT,
    finalReply TEXT,
    feedbackType TEXT NOT NULL
  );`);
  // ── Persisted per-email AI summaries (survives restart, keyed by entryId) ────
  db.run(`CREATE TABLE IF NOT EXISTS email_summaries (
    entryId TEXT PRIMARY KEY,
    summary TEXT,
    includedIndices TEXT,
    ts TEXT NOT NULL
  );`);
  // ── EL Internal Info: stored EATON_Emergency_Lighting_INTERNAL updates ──────
  db.run(`CREATE TABLE IF NOT EXISTS el_internal (
    entryId TEXT PRIMARY KEY,
    received TEXT,
    subject TEXT,
    sender TEXT,
    senderEmail TEXT,
    body TEXT,
    attachments TEXT,
    ts TEXT NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS el_internal_meta (
    id INTEGER PRIMARY KEY,
    digest TEXT,
    digestAt TEXT,
    lastRefreshAt TEXT
  );`);
  // ── Fenton KB: Mark Fenton's answers → extracted Q&A knowledge cards ─────────
  db.run(`CREATE TABLE IF NOT EXISTS fenton_kb (
    entryId TEXT PRIMARY KEY,
    received TEXT,
    subject TEXT,
    senderEmail TEXT,
    body TEXT,
    attachments TEXT,
    topic TEXT,
    question TEXT,
    answer TEXT,
    tags TEXT,
    extracted INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    folder TEXT,
    ts TEXT NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fenton_meta (
    id INTEGER PRIMARY KEY,
    lastRefreshAt TEXT
  );`);
  // ── In-app user feedback (team rollout) ──────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS app_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    category TEXT,
    message TEXT NOT NULL,
    page TEXT,
    userName TEXT,
    userEmail TEXT,
    appVersion TEXT,
    emailed INTEGER DEFAULT 0
  );`);
  // ── Mini CRM (multi-tenant: every row scoped by the SharePoint user's id) ────
  db.run(`CREATE TABLE IF NOT EXISTS crm_company (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerId INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    country TEXT, tags TEXT, notes TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS crm_contact (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId INTEGER NOT NULL,
    name TEXT NOT NULL, role TEXT, email TEXT, phone TEXT, notes TEXT,
    createdAt TEXT NOT NULL
  );`);
  // Match strings an account claims — the jobs.customer values (today these are
  // quote names; later, real customer names). Merging moves aliases between
  // accounts so one account can aggregate the quotes of several names.
  db.run(`CREATE TABLE IF NOT EXISTS crm_alias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId INTEGER NOT NULL,
    name TEXT NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS crm_fact (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    createdAt TEXT NOT NULL
  );`);
  // Per-quote pipeline state keyed by ownerId + quote key: 'won' | 'lost'.
  db.run(`CREATE TABLE IF NOT EXISTS crm_quote_state (
    ownerId INTEGER NOT NULL DEFAULT 0,
    sfId TEXT NOT NULL,
    state TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (ownerId, sfId)
  );`);
  // Full snapshot of each user's SharePoint Quotations List (populated by sync).
  // spId = the SharePoint list item Id (for incremental upsert); modified = its
  // SP Modified time (for incremental "changed since last sync").
  db.run(`CREATE TABLE IF NOT EXISTS crm_quote (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerId INTEGER NOT NULL DEFAULT 0,
    spId INTEGER, modified TEXT,
    sfId TEXT, title TEXT, customer TEXT, quoteName TEXT,
    account TEXT, salesman TEXT, price REAL,
    status TEXT, division TEXT, country TEXT, arrivedOn TEXT,
    raw TEXT, syncedAt TEXT NOT NULL
  );`);
  // Quotes found by sweeping the MAILBOX rather than SharePoint — one row per
  // quote reference, deduped across every message that mentions it. `side` is the
  // scanner's verdict (mine = this desk issued/filed it, team = a colleague did);
  // `override` is the user's correction and always wins.
  db.run(`CREATE TABLE IF NOT EXISTS crm_mail_quote (
    ownerId INTEGER NOT NULL DEFAULT 0,
    qkey TEXT NOT NULL,
    kind TEXT, ref TEXT,
    subject TEXT, sender TEXT, senderEmail TEXT, recipients TEXT,
    firstSeen TEXT, lastSeen TEXT,
    entryId TEXT, folder TEXT, store TEXT, folders TEXT, docs TEXT,
    msgs INTEGER DEFAULT 0,
    side TEXT NOT NULL DEFAULT 'team', sideWhy TEXT, sideFolder TEXT,
    override TEXT,
    companyId INTEGER, account TEXT, matchedBy TEXT,
    scannedAt TEXT NOT NULL,
    PRIMARY KEY (ownerId, qkey)
  );`);
  // Per-user sync bookkeeping for incremental syncs.
  db.run(`CREATE TABLE IF NOT EXISTS crm_sync_meta (
    ownerId INTEGER PRIMARY KEY,
    ownerTitle TEXT,
    lastModified TEXT,
    lastFullSync TEXT,
    lastSyncAt TEXT,
    count INTEGER
  );`);
  // Per-browser sessions (vec_sid → JOE cookies + resolved owner). Persisted so
  // sessions survive a server restart (no forced reconnect).
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    fed TEXT NOT NULL, rt TEXT NOT NULL,
    ownerId INTEGER, ownerTitle TEXT, hash TEXT,
    ts INTEGER NOT NULL
  );`);
  // ── Job report: one row per mail CONVERSATION (a thread = one job done), with
  // its AI category cached. `sig` fingerprints the thread's size + last date, so a
  // thread is only re-classified when it actually moved on — a re-run over the
  // same period costs no AI calls at all.
  db.run(`CREATE TABLE IF NOT EXISTS mail_job (
    conv TEXT PRIMARY KEY,
    topic TEXT,
    category TEXT,
    summary TEXT,
    counterpart TEXT,
    firstDate TEXT, lastDate TEXT,
    msgs INTEGER DEFAULT 0, sent INTEGER DEFAULT 0,
    folders TEXT, completed INTEGER DEFAULT 0,
    hasAtt INTEGER DEFAULT 0,
    sig TEXT, ts TEXT NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mail_job_meta (
    id INTEGER PRIMARY KEY,
    lastFrom TEXT, lastTo TEXT, lastScanAt TEXT, report TEXT
  );`);
  // ── To-Do: one row per thing still owed, whether the AI triage found it in the
  // shared mailbox or it was added by hand from the Inbox. `bucket` is the triage
  // verdict (direct / needs_info / needs_team). A row carries an unsent delegation
  // draft — nothing is ever mailed until the user presses Send on the item.
  db.run(`CREATE TABLE IF NOT EXISTS todo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv TEXT, entryId TEXT,
    subject TEXT, sender TEXT, senderEmail TEXT, received TEXT,
    bucket TEXT NOT NULL DEFAULT 'direct',
    title TEXT NOT NULL, summary TEXT, action TEXT, blocker TEXT, notes TEXT,
    recipients TEXT, attachments TEXT,
    draftSubject TEXT, draftBody TEXT,
    due TEXT, priority TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, doneAt TEXT, sentAt TEXT
  );`);
  // Everyone this desk actually corresponds with, ranked by traffic — the source
  // of the recipient picker. Harvested from Outlook, refreshed on demand.
  db.run(`CREATE TABLE IF NOT EXISTS mail_contact (
    email TEXT PRIMARY KEY,
    name TEXT,
    count INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, received INTEGER DEFAULT 0,
    lastSeen TEXT, updatedAt TEXT
  );`);
  // Survives a restart so the To-Do tab can show the last scan's outcome instead
  // of a blank "never scanned" panel — same contract as crm_sync_meta.
  db.run(`CREATE TABLE IF NOT EXISTS todo_meta (
    id INTEGER PRIMARY KEY,
    lastScanAt TEXT, lastContactsAt TEXT,
    lastScanDays INTEGER, lastScanMailbox TEXT,
    lastScanThreads INTEGER, lastScanCreated INTEGER, lastScanUpdated INTEGER,
    lastScanMessage TEXT, lastScanError TEXT, lastScanStartedAt TEXT
  );`);
  // Small named values that belong to the desk rather than to any one feature
  // (which price list issue was acknowledged, and so on). A generic key/value
  // table beats another single-row table per fact.
  db.run(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updatedAt TEXT
  );`);
  // Reply snippets: the sentences typed every week (lead times, commissioning
  // terms, the standard questions back). Stored here rather than in config.json
  // so they are queryable and survive a config rewrite.
  db.run(`CREATE TABLE IF NOT EXISTS snippet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tag TEXT,
    useCount INTEGER DEFAULT 0,
    lastUsedAt TEXT,
    createdAt TEXT, updatedAt TEXT
  );`);
  // CBU reference quotes: which past LoadStar-PS quote was for which system
  // size. A new 10KVA single-phase enquiry is nearly always a copy of the last
  // one, and nothing else in the desk records a SIZE against a quote number —
  // the mail index cannot answer "10kva-1ph" because the size only exists
  // inside the Tech Brief PDF the sizer exported. Filled by cbu_ref_scan.py
  // reading those briefs; `pinned` is the one the user chose to keep per size.
  db.run(`CREATE TABLE IF NOT EXISTS cbu_ref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system TEXT NOT NULL,
    kva REAL, phase TEXT,
    quoteRef TEXT NOT NULL,
    project TEXT,
    duration TEXT,
    dated TEXT,
    source TEXT,
    detail TEXT,
    confidence TEXT,
    note TEXT,
    pinned INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    createdAt TEXT, updatedAt TEXT
  );`);
  // NOCASE on the reference: the same opportunity is written "CR00us2z3YAA"
  // and "cr00us2z3yaa" depending on who typed it, and they are one quote.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cbu_ref_key
          ON cbu_ref(system, quoteRef COLLATE NOCASE);`);
  migrateDb();
  migrateTodo();
  migrateCrm();
  migrateFenton();
  ensureIndexes();
  saveDb();
}

// ── Indexes ──────────────────────────────────────────────────────────────────
// Until these existed the only indexes in the file were the automatic ones behind
// primary keys, so every lookup was a table scan. The CRM sync felt it worst: it
// checks `WHERE ownerId = ? AND spId = ?` once per incoming item against 1.3k
// rows, which is quadratic in the number of quotes. Run after the migrations so
// the columns being indexed are guaranteed to exist.
function ensureIndexes() {
  const idx: Array<[string, string]> = [
    ['crm_quote_owner_sp',    'crm_quote(ownerId, spId)'],
    ['crm_quote_owner_sfid',  'crm_quote(ownerId, sfId)'],
    ['crm_quote_owner_acct',  'crm_quote(ownerId, account)'],
    ['crm_company_owner',     'crm_company(ownerId)'],
    ['crm_alias_company',     'crm_alias(companyId)'],
    ['crm_alias_name',        'crm_alias(name)'],
    ['crm_mail_quote_owner',  'crm_mail_quote(ownerId)'],
    ['jobs_timestamp',        'jobs(timestamp DESC)'],
    ['mail_job_last',         'mail_job(lastDate DESC)'],
    ['todo_status',           'todo(status, bucket)'],
    ['fenton_kb_received',    'fenton_kb(received DESC)'],
    // The extraction pass scans `WHERE extracted = 0` over every card.
    ['fenton_kb_extracted',   'fenton_kb(extracted)'],
  ];
  for (const [name, on] of idx) {
    try { db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`); }
    catch (e: any) { console.warn(`[index] ${name} skipped:`, e.message); }
  }
}

// ── One-shot migration: add new columns to existing jobs table ─────────────
function migrateDb() {
  try {
    const cols = queryAll(`PRAGMA table_info(jobs)`).map(r => r.name as string);
    const additions: Array<[string, string]> = [
      ['product',     'TEXT'],
      ['customer',    'TEXT'],
      ['price',       'REAL'],
      ['salesman',    'TEXT'],
      ['durationSec', 'INTEGER'],
    ];
    for (const [name, type] of additions) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
        console.log(`[migrate] added jobs.${name} (${type})`);
      }
    }
  } catch (e: any) {
    console.warn('[migrate] skipped:', e.message);
  }
}

// ── To-Do migration: the first build of todo_meta only held the two timestamps.
// The scan outcome columns were added afterwards, so an existing DB needs them
// bolted on — otherwise every status read after a restart throws.
function migrateTodo() {
  try {
    const cols = queryAll(`PRAGMA table_info(todo_meta)`).map(r => r.name as string);
    const additions: Array<[string, string]> = [
      ['lastScanDays',      'INTEGER'],
      ['lastScanMailbox',   'TEXT'],
      ['lastScanThreads',   'INTEGER'],
      ['lastScanCreated',   'INTEGER'],
      ['lastScanUpdated',   'INTEGER'],
      ['lastScanMessage',   'TEXT'],
      ['lastScanError',     'TEXT'],
      ['lastScanStartedAt', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE todo_meta ADD COLUMN ${name} ${type}`);
        console.log(`[migrate] added todo_meta.${name} (${type})`);
      }
    }
  } catch (e: any) {
    console.warn('[migrate] todo_meta skipped:', e.message);
  }
}

// ── Fenton migration: `skipped` marks an email the extractor judged to carry no
// reusable engineering knowledge (auto-replies, order confirmations, pure
// logistics). Those rows stay in the table — so a refresh never re-fetches them
// — but never become cards. `folder` records where the mail was found now that
// the fetch spans both mailboxes. ───────────────────────────────────────────
function migrateFenton() {
  try {
    const cols = queryAll(`PRAGMA table_info(fenton_kb)`).map(r => r.name as string);
    const additions: Array<[string, string]> = [
      ['skipped', 'INTEGER DEFAULT 0'],
      ['folder',  'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE fenton_kb ADD COLUMN ${name} ${type}`);
        console.log(`[migrate] added fenton_kb.${name} (${type})`);
      }
    }
  } catch (e: any) {
    console.warn('[migrate] fenton_kb skipped:', e.message);
  }
}

// ── CRM migration: add crm_fact.source, and backfill an alias for any company
//    created by the first CRM version (which matched purely by name). ────────
function migrateCrm() {
  try {
    const factCols = queryAll(`PRAGMA table_info(crm_fact)`).map(r => r.name as string);
    if (!factCols.includes('source')) {
      db.run(`ALTER TABLE crm_fact ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
    }
    const orphans = queryAll(
      `SELECT c.id, c.name FROM crm_company c
        WHERE NOT EXISTS (SELECT 1 FROM crm_alias a WHERE a.companyId = c.id)`);
    for (const o of orphans as any[]) {
      db.run(`INSERT INTO crm_alias (companyId, name) VALUES (?,?)`, [o.id, o.name]);
    }

    // ── Multi-tenant migration: add ownerId/spId/modified, backfill from raw ──
    const addCol = (table: string, col: string, type: string) => {
      const cols = queryAll(`PRAGMA table_info(${table})`).map(r => r.name as string);
      if (!cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    };
    addCol('crm_quote', 'ownerId', 'INTEGER NOT NULL DEFAULT 0');
    addCol('crm_quote', 'spId', 'INTEGER');
    addCol('crm_quote', 'modified', 'TEXT');
    addCol('crm_company', 'ownerId', 'INTEGER NOT NULL DEFAULT 0');
    addCol('crm_quote_state', 'ownerId', 'INTEGER NOT NULL DEFAULT 0');

    // Backfill ownerId/spId/modified for existing snapshot rows from their raw JSON.
    const needBackfill = queryAll(`SELECT id, raw FROM crm_quote WHERE ownerId = 0 OR ownerId IS NULL`);
    let owner0 = 0;
    for (const r of needBackfill as any[]) {
      let it: any = {};
      try { it = JSON.parse(r.raw || '{}'); } catch { /* ignore */ }
      const oid = Number(it.AuthorId) || 0;
      if (oid && !owner0) owner0 = oid;
      db.run(`UPDATE crm_quote SET ownerId = ?, spId = ?, modified = ? WHERE id = ?`,
        [oid, Number(it.Id) || null, it.Modified || null, r.id]);
    }
    // Existing accounts + state belong to that single legacy owner.
    if (owner0) {
      db.run(`UPDATE crm_company SET ownerId = ? WHERE ownerId = 0 OR ownerId IS NULL`, [owner0]);
      db.run(`UPDATE crm_quote_state SET ownerId = ? WHERE ownerId = 0 OR ownerId IS NULL`, [owner0]);
      // Seed sync meta so the first sync after upgrade runs incrementally.
      const mx = (queryAll(`SELECT MAX(modified) AS m, COUNT(*) AS n FROM crm_quote WHERE ownerId = ?`, [owner0])[0] as any);
      if (!queryAll(`SELECT ownerId FROM crm_sync_meta WHERE ownerId = ?`, [owner0])[0]) {
        db.run(`INSERT INTO crm_sync_meta (ownerId, lastModified, lastFullSync, lastSyncAt, count) VALUES (?,?,?,?,?)`,
          [owner0, mx.m || null, new Date().toISOString(), new Date().toISOString(), mx.n || 0]);
      }
    }
  } catch (e: any) {
    console.warn('[migrate-crm] skipped:', e.message);
  }
}

// ── Persisting the sql.js database ───────────────────────────────────────────
// sql.js keeps the whole database in memory, so persisting means exporting the
// entire file — ~10 MB and growing. Two problems came with doing that inline on
// every write:
//
//   1. Cost. Every single-row insert paid for the whole file. 60 call sites do it.
//   2. Safety. writeFileSync over the live path truncates it first, so a crash
//      mid-write left a broken database rather than the previous good one.
//
// So: write to a temp file and rename over the original (rename is atomic on
// NTFS), and coalesce bursts behind a short timer instead of flushing per row.
// A .prev copy is kept as the one-generation fallback.
const DB_TMP  = DB_PATH + '.tmp';
const DB_PREV = DB_PATH + '.prev';
let _saveTimer: NodeJS.Timeout | null = null;

function saveDbNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const buf = Buffer.from(db.export());
  writeFileSync(DB_TMP, buf);
  try { if (existsSync(DB_PATH)) copyFileSync(DB_PATH, DB_PREV); } catch { /* fallback copy is best-effort */ }
  renameSync(DB_TMP, DB_PATH);
}

// Callers that just changed a row use this. The flush lands a tick later, which
// is invisible to the HTTP response but turns a bulk loop into one write.
function saveDb() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { saveDbNow(); } catch (e: any) { console.error('[db] flush failed:', e.message); }
  }, 150);
  // Node keeps running for a pending timer; this one must never hold the process open.
  _saveTimer.unref?.();
}

// A debounced write must not be the reason a shutdown loses the last edit.
let _flushed = false;
function flushDbOnExit() {
  if (_flushed) return;
  _flushed = true;
  try { saveDbNow(); } catch { /* nothing useful left to do while exiting */ }
}
process.on('exit', flushDbOnExit);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { flushDbOnExit(); process.exit(0); });
}
function queryAll(sql: string, params: any[] = []): Record<string, any>[] {
  const stmt = db.prepare(sql);
  const out: Record<string, any>[] = [];
  stmt.bind(params);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}
function runWrite(sql: string, params: any[] = []): number {
  db.run(sql, params);
  const [{ id }] = queryAll('SELECT last_insert_rowid() AS id');
  saveDb();
  return id as number;
}

// Insert a job with the new optional columns
function insertJob(j: {
  step: string;
  status: 'ok' | 'err' | 'warn';
  pdfName?: string | null;
  sfId?: string | null;
  items?: number;
  note?: string | null;
  product?: string | null;
  customer?: string | null;
  price?: number | null;
  salesman?: string | null;
  durationSec?: number | null;
}) {
  return runWrite(
    `INSERT INTO jobs (timestamp,step,pdfName,sfId,status,items,note,product,customer,price,salesman,durationSec)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      new Date().toISOString(), j.step,
      j.pdfName ?? null, j.sfId ?? null, j.status,
      j.items ?? 0, j.note ?? null,
      j.product ?? null, j.customer ?? null, j.price ?? null,
      j.salesman ?? null, j.durationSec ?? null,
    ],
  );
}

// ── Log file ───────────────────────────────────────────────────────────────
const LOG_PATH     = path.join(DATA_DIR, 'vector.log');
const LOG_MAX_LINES = 2000;

function appendLog(line: string) {
  const ts    = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `[${ts}] ${line}\n`;
  try {
    if (existsSync(LOG_PATH)) {
      const prev  = readFileSync(LOG_PATH, 'utf8').split('\n');
      const trimmed = prev.length > LOG_MAX_LINES ? prev.slice(-LOG_MAX_LINES) : prev;
      writeFileSync(LOG_PATH, trimmed.join('\n') + entry);
    } else {
      writeFileSync(LOG_PATH, entry);
    }
  } catch {}
}

// ── Retry queue ─────────────────────────────────────────────────────────────
interface RetryItem {
  id: string; timestamp: string; script: 'step2';
  attempts: number; maxAttempts: number; lastError: string;
}
const RETRY_PATH = path.join(DATA_DIR, 'retry_queue.json');

function loadRetryQueue(): RetryItem[] {
  try { if (existsSync(RETRY_PATH)) return JSON.parse(readFileSync(RETRY_PATH, 'utf8')); } catch {}
  return [];
}
function saveRetryQueue(q: RetryItem[]) {
  try { writeFileSync(RETRY_PATH, JSON.stringify(q, null, 2)); } catch {}
}
function addToRetryQueue(script: 'step2', error: string) {
  const q = loadRetryQueue();
  if (q.some(x => x.script === script && x.attempts < x.maxAttempts)) return; // already queued
  q.push({ id: Date.now().toString(), timestamp: new Date().toISOString(), script, attempts: 1, maxAttempts: 5, lastError: error });
  saveRetryQueue(q);
  appendLog(`[retry] Queued ${script} for auto-retry (${error.slice(0, 80)})`);
}

// Background auto-retry (every 5 min)
let _retrying = false;
function runSilent(scriptPath: string): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    if (!existsSync(scriptPath)) { resolve({ ok: false, output: 'Script not found' }); return; }
    const [cmd, args] = pyArgs(scriptPath);
    const py = spawn(cmd, args, { cwd: PY_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '';
    py.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    py.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    py.on('close', code => resolve({ ok: code === 0, output: out }));
    py.on('error', err => resolve({ ok: false, output: err.message }));
  });
}
setInterval(async () => {
  if (_retrying || !getSpCookies()) return;
  const q = loadRetryQueue().filter(x => x.attempts < x.maxAttempts);
  if (!q.length) return;
  _retrying = true;
  for (const item of q) {
    const script = item.script === 'step2' ? pyFile('dq_store_upload.py') : '';
    if (!script) continue;
    appendLog(`[retry] Attempt ${item.attempts + 1}/${item.maxAttempts} for ${item.script}`);
    const { ok, output } = await runSilent(script);
    const all = loadRetryQueue();
    const idx = all.findIndex(x => x.id === item.id);
    if (idx > -1) {
      if (ok) {
        appendLog(`[retry] ${item.script} succeeded`);
        all.splice(idx, 1);
        insertJob({ step: 'Step 2', status: 'ok', note: 'D&Q Store built (auto-retry)', durationSec: null });
      } else {
        all[idx].attempts++;
        all[idx].lastError = output.slice(-200);
        appendLog(`[retry] ${item.script} failed again (attempt ${all[idx].attempts})`);
      }
      saveRetryQueue(all);
    }
  }
  _retrying = false;
}, 5 * 60 * 1000);

// ── In-memory caches ──────────────────────────────────────────────────────
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return String(h >>> 0);
}

const _aiCache   = new Map<string, { answer: string; ts: number }>();
const AI_TTL     = 3 * 60 * 1000;   // 3 min

// ── Python launcher ────────────────────────────────────────────────────────
// Windows ships an App-Execution-Alias stub at
//   %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe
// that silently no-ops (prints nothing, exits 0) when its stdout is piped by a
// non-interactive parent like Node's spawn — which surfaces as "No output" for
// every Python feature. Resolve a CONCRETE python.exe once (via the `py`
// launcher, which is a real launcher, not a stub) and reuse it everywhere.
let _pythonCmd: string | null = null;
const _isAliasStub = (p: string) => /[\\/]WindowsApps[\\/]/i.test(p);

function resolvePythonCmd(): string {
  if (_pythonCmd) return _pythonCmd;

  const env = process.env.PYTHON;
  if (env && !_isAliasStub(env)) { _pythonCmd = env; return env; }

  // Ask the py launcher for the concrete interpreter path (never the stub).
  for (const args of [['-3'], []] as string[][]) {
    try {
      const exe = execFileSync('py', [...args, '-c', 'import sys;print(sys.executable)'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
      if (exe && !_isAliasStub(exe) && existsSync(exe)) { _pythonCmd = exe; return exe; }
    } catch { /* py not present — fall through */ }
  }

  _pythonCmd = env || 'python';
  return _pythonCmd;
}

function pyArgs(scriptPath: string): [string, string[]] {
  return [resolvePythonCmd(), [scriptPath]];
}

// ── SSE: run a Python script and stream its output ─────────────────────────
function runPyScript(
  res: Response, scriptPath: string,
  onDone: (ok: boolean, durationSec: number) => void,
  req?: Request,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (line: string) => { res.write(`data: ${JSON.stringify(line)}\n\n`); appendLog(line); };
  const t0 = Date.now();

  if (!existsSync(scriptPath)) {
    send(`[ERR] Script not found: ${scriptPath}`);
    res.write(`data: __DONE__:false\n\n`);
    res.end();
    onDone(false, 0);
    return;
  }

  const [cmd, args] = pyArgs(scriptPath);
  const py = spawn(cmd, args, {
    cwd: PY_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  req?.on('close', () => { try { py.kill(); } catch {} });

  py.stdout.on('data', d =>
    String(d).split('\n').filter(l => l.trim()).forEach(send));
  py.stderr.on('data', d =>
    String(d).split('\n').filter(l => l.trim()).forEach(l => send(`[WARN] ${l}`)));
  py.on('error', err => {
    send(`[ERR] Could not start Python: ${err.message}`);
    res.write(`data: __DONE__:false\n\n`);
    res.end();
    onDone(false, Math.round((Date.now() - t0) / 1000));
  });
  py.on('close', code => {
    const ok = code === 0;
    res.write(`data: __DONE__:${ok}\n\n`);
    res.end();
    onDone(ok, Math.round((Date.now() - t0) / 1000));
  });
}

// ── SharePoint HTTP helpers (Node built-in https) ──────────────────────────
function spPost(url: string, cookies: string): Promise<{ ok: boolean; status: number }> {
  return new Promise(resolve => {
    const p = new URL(url);
    const req = httpsRequest({
      hostname: p.hostname, path: p.pathname + p.search, method: 'POST',
      headers: { Cookie: cookies, Accept: 'application/json;odata=verbose', 'Content-Length': '0' },
      rejectUnauthorized: false,
    }, res => { resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0 }); res.resume(); });
    req.on('error', e => { swallow('spPost', e); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

function spGet(url: string, cookies: string): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise(resolve => {
    const p = new URL(url);
    const req = httpsRequest({
      hostname: p.hostname, path: p.pathname + p.search, method: 'GET',
      headers: { Cookie: cookies, Accept: 'application/json;odata=verbose' },
      rejectUnauthorized: false,
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, body }));
    });
    req.on('error', e => { swallow('spGet', e); resolve({ ok: false, status: 0, body: '' }); });
    req.end();
  });
}

// ── Per-session SharePoint cookies ───────────────────────────────────────────
// Each browser session (vec_sid cookie) carries its own JOE cookies, so a shared
// server can serve many Eaton users at once. Cookies are bound to the request via
// AsyncLocalStorage. Falls back to the shared cookie file for local single-user
// and background tasks (set SESSION_ONLY=1 to forbid that fallback inside a
// request — strict multi-user isolation).
interface SpCookies { fed: string; rt: string }
interface Session { fed: string; rt: string; ts: number; ownerId?: number; ownerTitle?: string; hash?: string }
const SESSIONS = new Map<string, Session>();
const reqCtx = new AsyncLocalStorage<{ sid: string; cookies: SpCookies | null; owner?: { id: number; title: string } }>();
function currentSid(): string | null { return reqCtx.getStore()?.sid ?? null; }
function inRequest(): boolean { return !!reqCtx.getStore(); }

function parseReqCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// The shared cookie store (refresh_cookies.py writes it, encrypted) — local /
// background path. Reads the encrypted .cookies.enc first, falling back to any
// legacy plaintext in Automation_V4.py.
function fileCookies(): SpCookies | null {
  try {
    const enc = pyFile('.cookies.enc');
    if (existsSync(enc)) {
      const d = JSON.parse(readFileSync(enc, 'utf8'));
      const fed = decSecret(d.fed || ''); const rt = decSecret(d.rt || '');
      if (fed && rt) return { fed, rt };
    }
  } catch {}
  try {
    const src = readFileSync(pyFile('Automation_V4.py'), 'utf8');
    const fed = src.match(/FED_AUTH\s*=\s*"([^"]+)"/)?.[1];
    const rt  = src.match(/RT_FA\s*=\s*"([^"]+)"/)?.[1];
    if (fed && rt) return { fed, rt };
  } catch {}
  return null;
}

function getSpCookies(): SpCookies | null {
  const s = reqCtx.getStore()?.cookies;
  if (s) return s;
  if (process.env.SESSION_ONLY === '1' && inRequest()) return null; // no file leak across sessions
  return fileCookies();
}

// ── At-rest encryption for stored cookies (AES-256-GCM) ──────────────────────
// Key from VECTOR_SECRET env (recommended for prod), else a generated key file
// (.session_key, 0600) so it persists across restarts.
function sessionKey(): Buffer {
  const env = process.env.VECTOR_SECRET;
  if (env) return scryptSync(env, 'vector-session-v1', 32);
  // Must match cookie_crypto.py's _KEYFILE (automation/../.session_key = RESOURCE_DIR).
  const kp = path.join(RESOURCE_DIR, '.session_key');
  try { if (existsSync(kp)) return Buffer.from(readFileSync(kp, 'utf8').trim(), 'hex'); } catch {}
  const k = randomBytes(32);
  try { writeFileSync(kp, k.toString('hex'), { mode: 0o600 }); } catch {}
  return k;
}
const SESSION_KEY = sessionKey();
function encSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decSecret(blob: string): string | null {
  if (!blob) return null;
  if (!blob.startsWith('v1:')) { console.warn('[security] decSecret: returning legacy plaintext token — re-save session to encrypt'); return blob; }
  try {
    const raw = Buffer.from(blob.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', SESSION_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; } // wrong key / tampered → unusable
}

// Same unwrap for config secrets, minus decSecret's warning — this one runs on
// every AI request, and a config written before encryption is a normal state to
// be in, not something to log about each time.
function readSecret(blob: string): string {
  const s = String(blob || '').trim();
  if (!s) return '';
  if (!s.startsWith('v1:')) return s;      // written before the key was encrypted
  return (decSecret(s) ?? '').trim();
}

// The Gemini key as the SDK needs it: decrypted from config, or the env var.
function geminiKey(): string {
  const fromCfg = readSecret(String((loadPyCfg() as any).gemini_key || ''));
  return fromCfg || String(process.env.GEMINI_API_KEY || '').trim();
}

// ── Session persistence (survives restart; cookies encrypted at rest) ────────
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days, matches the cookie Max-Age
function persistSession(sid: string) {
  const s = SESSIONS.get(sid);
  if (!s) return;
  runWrite(
    `INSERT INTO sessions (sid, fed, rt, ownerId, ownerTitle, hash, ts) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(sid) DO UPDATE SET fed=excluded.fed, rt=excluded.rt, ownerId=excluded.ownerId,
       ownerTitle=excluded.ownerTitle, hash=excluded.hash, ts=excluded.ts`,
    [sid, encSecret(s.fed), encSecret(s.rt), s.ownerId ?? null, s.ownerTitle ?? null, s.hash ?? null, s.ts]);
}
function dropSession(sid: string) { SESSIONS.delete(sid); runWrite('DELETE FROM sessions WHERE sid = ?', [sid]); }
function loadSessions() {
  try {
    const cutoff = Date.now() - SESSION_TTL;
    let pruned = false;
    for (const r of queryAll('SELECT * FROM sessions') as any[]) {
      const fed = decSecret(r.fed), rt = decSecret(r.rt);
      if ((r.ts || 0) < cutoff || !fed || !rt) { db.run('DELETE FROM sessions WHERE sid = ?', [r.sid]); pruned = true; continue; }
      SESSIONS.set(r.sid, { fed, rt, ts: r.ts, ownerId: r.ownerId || undefined, ownerTitle: r.ownerTitle || undefined, hash: r.hash || undefined });
    }
    if (pruned) saveDb();
  } catch { /* table may not exist on very first run */ }
}
loadSessions();

// ── One-time migration: encrypt any legacy plaintext cookies + scrub config ──
function migrateCookieFile() {
  try {
    const enc = pyFile('.cookies.enc');
    const v4  = pyFile('Automation_V4.py');
    const cfgPath = APP_CFG_PATH;
    if (!existsSync(enc)) {
      // Source legacy plaintext cookies from the script file, else config.json.
      let fed: string | undefined, rt: string | undefined;
      if (existsSync(v4)) {
        const s = readFileSync(v4, 'utf8');
        fed = s.match(/FED_AUTH\s*=\s*"([^"]+)"/)?.[1];
        rt  = s.match(/RT_FA\s*=\s*"([^"]+)"/)?.[1];
      }
      if ((!fed || !rt) && existsSync(cfgPath)) {
        const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (c.sp_fed_auth && c.sp_rt_fa) { fed = c.sp_fed_auth; rt = c.sp_rt_fa; }
      }
      if (fed && rt) {
        writeFileSync(enc, JSON.stringify({ fed: encSecret(fed), rt: encSecret(rt) }), { mode: 0o600 });
        if (existsSync(v4)) {
          const s = readFileSync(v4, 'utf8');
          writeFileSync(v4, s.replace(/(FED_AUTH = ")[^"]*(")/, '$1$2').replace(/(RT_FA = ")[^"]*(")/, '$1$2'), 'utf8');
        }
        console.log('[migrate] encrypted cookies → .cookies.enc');
      }
    }
    // Always scrub plaintext cookies left in config.json.
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.sp_fed_auth !== undefined || cfg.sp_rt_fa !== undefined) {
        delete cfg.sp_fed_auth; delete cfg.sp_rt_fa;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        console.log('[migrate] scrubbed plaintext cookies from config.json');
      }
    }

    // Encrypt any remaining plaintext token files in place.
    const encInPlace = (p: string) => {
      try {
        if (!existsSync(p)) return;
        const c = readFileSync(p, 'utf8').trim();
        if (!c || c.startsWith('v1:')) return; // empty or already encrypted
        writeFileSync(p, encSecret(c), { mode: 0o600 });
        console.log('[migrate] encrypted ' + path.basename(p));
      } catch { /* skip */ }
    };
    for (const f of ['.graph_token', '.copilot_token', '.copilot_cookies', 'graph_token_cache.json']) encInPlace(pyFile(f));
    encInPlace(path.join(__dirname, '.graph_token'));
  } catch { /* best-effort */ }
}
migrateCookieFile();

// ── Helper: try to infer customer & product from filename like
//    SR00xxxxx_CustomerName_PRODUCT.pdf
function parseFilenameMeta(filename: string | null | undefined): { customer: string | null; product: string | null } {
  if (!filename) return { customer: null, product: null };
  const base = filename.replace(/\.(pdf|xlsx|xls|xlsm|docx|doc)$/i, '');
  // Split on _ and try to extract: SF-id, customer, product
  const parts = base.split('_');
  if (parts.length < 2) return { customer: null, product: null };
  // The product is the last segment if it matches one of our keys
  const last = parts[parts.length - 1].toUpperCase().replace(/-/g, '-');
  const product = PRODUCT_META[last] ? last : null;
  const customer = parts.length >= 3 ? parts.slice(1, -1).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2') : null;
  return { customer, product };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Gemini AI ─────────────────────────────────────────────────────────────────
let _gemini: InstanceType<typeof GoogleGenAI> | null = null;
let _geminiKey = '';
function getGemini() {
  const key = geminiKey();
  if (!key) return null;
  if (!_gemini || _geminiKey !== key) {
    _gemini = new GoogleGenAI({ apiKey: key });
    _geminiKey = key;
  }
  return _gemini;
}

// Google's front end returns 503 UNAVAILABLE / "Deadline expired before operation
// could complete" when a big request (a 12k email body plus image parts) lands on a
// busy region. It is transient and a plain re-send usually succeeds, so retry the
// whole call with backoff instead of surfacing the raw error to the user.
const AI_TRANSIENT = /\b(429|500|502|503|504)\b|UNAVAILABLE|Deadline expired|deadline exceeded|overloaded|RESOURCE_EXHAUSTED|INTERNAL|fetch failed|ECONNRESET|ETIMEDOUT/i;
type GenReq = Parameters<InstanceType<typeof GoogleGenAI>['models']['generateContent']>[0];
async function generateWithRetry(
  ai: InstanceType<typeof GoogleGenAI>, req: GenReq, tries = 3,
): Promise<Awaited<ReturnType<InstanceType<typeof GoogleGenAI>['models']['generateContent']>>> {
  let last: any;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await ai.models.generateContent(req);
    } catch (e: any) {
      last = e;
      const msg = `${e?.message || ''} ${e?.cause?.message || ''}`;
      if (attempt === tries - 1 || !AI_TRANSIENT.test(msg)) throw e;
      const wait = 1500 * 2 ** attempt;
      appendLog(`[ai] ${req.model} transient failure (${msg.trim().slice(0, 120)}) — retry ${attempt + 1}/${tries - 1} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

// Turn a Gemini exception into something an engineer can act on, instead of
// leaking a raw JSON envelope into the summary panel.
function aiErrorText(e: any): string {
  const msg = `${e?.message || ''} ${e?.cause?.message || ''}`;
  if (/Deadline expired|deadline exceeded|\b503\b|UNAVAILABLE|overloaded/i.test(msg))
    return 'Gemini is overloaded right now (timed out after 3 tries). Wait a moment and hit Summarize again — nothing was lost.';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg))
    return 'Gemini quota/rate limit hit. Wait a minute, or switch the model in Settings → AI model.';
  if (/API key|\b401\b|\b403\b|PERMISSION_DENIED/i.test(msg))
    return 'Gemini rejected the API key — check it in Settings.';
  return 'Gemini error: ' + (e?.message || String(e)) + (e?.cause?.message ? ` (${e.cause.message})` : '');
}

// One brain, two engines. The SMART model (Ask Vector chat, email summaries, inbox
// follow-up chat) is now CONFIGURABLE — Settings → "AI model" writes cfg.ai_model, so
// Laith can point it at whatever his key exposes (gemini-3-flash, a pro tier, …) with
// NO code edit. GET /api/ai-models lists what the key actually supports. Fallback below
// is the safe default: gemini-2.5-pro is retired for new keys (404), flash always works.
// AI_MODEL_FAST = routing / classification / tiny extraction — kept fixed & cheap.
const AI_MODEL_FALLBACK = 'gemini-2.5-flash';
function smartModel(): string {
  return String((loadPyCfg() as any).ai_model || '').trim() || AI_MODEL_FALLBACK;
}
const AI_MODEL_FAST = 'gemini-2.5-flash';

// Mark Fenton's distilled EL guidance, folded into the unified brain so Ask Vector
// (and the inbox chat) can answer EL application questions without a separate tab.
function fentonKnowledgeBlock(limit = 30): string {
  try {
    const fen = queryAll(
      `SELECT received, topic, question, answer FROM fenton_kb
        WHERE answer IS NOT NULL AND answer != '' AND COALESCE(skipped, 0) = 0
        ORDER BY received DESC LIMIT ?`, [limit]);
    if (!fen.length) return '';
    return [
      "Mark Fenton EL knowledge base (his distilled guidance, newest first — cite the date when you use one):",
      ...fen.map((f: any) => `  [${String(f.received).slice(0, 10)}] ${f.topic || f.question || ''} → ${f.answer}`),
    ].join('\n');
  } catch { return ''; }
}

function buildSystemPrompt(appContext: string): string {
  const lines = [
    'You are Ask Vector — the single AI brain inside Vector, a quote & PMO automation app for Eaton (Budapest). The same brain answers in this chat, summarises the Inbox, and helps across the app, so behave as one consistent, self-aware assistant.',
    'Vector was designed and built by Laith Al-Soub (Technical Sales & Systems Engineer, Eaton Budapest) — its creator and owner. If asked who made/owns it: Laith Al-Soub. (Formerly "MagicUploader".)',
    '',
    '## How to answer (read this first)',
    '- Lead with the answer or the bottom line. No preamble, no restating the question, no "I am an AI", no "this is an email".',
    '- Say only what is useful. Never pad with the obvious. If one sentence does it, use one sentence.',
    '- Be specific and confident. When you point at the app, name the exact tab/button ("Dashboard → Run Step 1", "PMO tab", "Connect to JOE").',
    '- You are ALREADY inside the app. Never tell the user to "open Ask Vector", "go to the Inbox", or "click Summarize" — they are already there.',
    '- Use short numbered steps ONLY when the user genuinely needs a procedure; otherwise just answer.',
    '- If something is truly missing or ambiguous, ask one sharp question instead of guessing.',
    '- Formatting: when comparing parts/options or asked to "tabulate / put in a table", output a GitHub-style markdown table (| col | col | with a |---|---| separator) — the app renders it. When asked to draft/inject an email, write the actual email (Subject + body) ready to copy. Keep tables tight: only the columns that matter.',
    '',
    '## What Vector does',
    '- **Dashboard**: drop queue + recent jobs; Run Step 1 / Run Step 2.',
    '- **Step 1**: extracts pricing from dropped quotes (UK/BE/FR/IT/DE/ES; PDF/Word/Excel) → uploads to the SharePoint QuotationFactory list.',
    '- **Step 2**: creates the D&Q Store folder on SharePoint and uploads the quote PDF.',
    '- **PMO tab**: quote PDF + customer PO + BidManager DOCU_ID PDFs → a PMO Word doc, ready to email the PMO team.',
    // Named from the workbook actually on disk. Hardcoding the issue here meant
    // the brain kept quoting "July 2026" after the sheet had been replaced.
    `- **EL Pricer** (Schematics tab): prices Eaton emergency-lighting items from schematics/images/pasted lists against ${pricelistLabel(_plVersion?.v ?? null)}.`,
    '- **CBU Sizer** (CBU tab): LoadStar-PS battery/UPS sizing WITH a built-in list-price table per kVA system (hard-coded LoadStar-PS configurator prices — no live feed), plus a printable tech brief.',
    '- **Inbox**: reads Outlook email; one Summarize gives a structured read (incl. photos/diagrams/PDFs) + inline follow-up chat; also AI reply drafting and an inline EL Pricer.',
    '- **CRM tab**: account cards auto-seeded from past quotes — contacts, facts, D&Q docs, and live quotes/opportunities (an opportunity is an open priced quote, not won/lost). Duplicate cards can be MERGED. You can EDIT from chat: "add contact John Smith (buyer, john@acme.com) to <account>", "note that <account> pays at 60 days", "mark SR0012345 as won", "create account Acme", "tag <account> key-account" — you execute it and confirm.',
    '- **Connect to JOE** (header): SharePoint auth. **Settings**: Gemini key + base folder.',
    '',
    '## Quote search',
    "The app can search the user's quotes by customer, salesman, kVA rating, catalogue/fitting number, or ANY text inside the quote PDF/email (the D&Q Store is full-text indexed). Never claim search is limited to Salesforce ID or customer name, or that you cannot search a spec like \"4kVA\".",
    'But in THIS reply you cannot run the search yourself and have no results in hand — so NEVER say "searching…", "one moment", "retrieving", or pretend results are loading. If the user wants to find quotes, tell them in ONE line to type the thing itself (e.g. "4kVA", a customer, a salesman name) and the app runs the real search and shows result cards.',
    '',
    '## Web search & finding alternatives',
    'PRIMARY SOURCE: if a "## Eaton EL price sheet" block appears in the live context below, it is AUTHORITATIVE — trust it over the web. An [exact] row means the part IS a real Eaton item (give its real description/price, flag "Phase-out planned" if shown); [description-match] rows are real Eaton alternatives from the same family — offer those first. Only use the web to supplement or when the sheet has NO match. NEVER contradict the sheet (e.g. never call a sheet part another brand).',
    'You ALWAYS have live Google Search — every single turn. NEVER say "I cannot perform a live web search", "I can\'t browse", or ask the user to rephrase so search turns on. If the user says check/verify/"dig it up online"/"double check", or you are unsure, just SEARCH NOW and answer with sources. Pull real Eaton/Cooper catalogue numbers, datasheets, specs, cross-references from manufacturer pages and reputable distributors, and cite them (the app renders the sources under your answer).',
    '- Finding alternatives/equivalents: identify the exact part (sheet first), then name concrete Eaton equivalents with the spec that matters (lumen output, IP/IK rating, wattage, duration, mounting). Say WHY each is a valid swap. Never invent a catalogue number — ground it in the sheet or a cited source, or say you could not confirm one.',
    '- Any price from the web is an EXTERNAL figure, NOT the Eaton NTP. Say so and point the user to the EL Pricer / configurator for the real number.',
    '- "double check / verify this online / dig it up" = go search the web right now and confirm or correct what you said, with sources. Do it — never deflect or ask them to rephrase.',
    '',
    '## Mark Fenton knowledge',
    "You carry Mark Fenton's (Senior Lighting Application Engineer, Eaton UK) accumulated EL guidance as a knowledge base (supplied below when present). Use it for EL application questions and cite the date (YYYY-MM-DD) of the answer you draw on. If a topic isn't covered there, say so plainly rather than inventing.",
    '',
    '## Sales reps (people in the quote data, NOT the app team)',
    'Blair McDonald, Craig Donaldson, Joe Bayley, Mark Fenton, Ollie Bailey, Ryan Houston.',
    '',
    '## Honesty & data care',
    "Never deny a feature that exists (e.g. the CBU Sizer DOES have prices). Don't invent a price-validity date the app doesn't store — say CBU prices are the hard-coded LoadStar-PS configurator list prices and to confirm currency check the latest configurator. Eaton data is confidential: give the specific figure asked, don't dump whole price tables, every part number, or internal filenames unprompted, and flag before any external export/share.",
    '',
    '## Common fixes',
    '- FedAuth / 401 / SharePoint 403 / cookie expired → click Connect to JOE.',
    '- PDF format not recognised → only UK/BE/FR/IT/DE/ES quotes are supported.',
    '- Step 1 uploaded nothing → check the CSV in the base folder; re-run if empty.',
  ];
  if (appContext) lines.push('', '## Live app state (use for specific answers)', appContext);
  return lines.join('\n');
}

// ─── Tolerant single-JSON-object parser (classify step) ────────────────────────
// Gemini may wrap the object in ```json fences or add stray text. Strip fences,
// try a full parse, then walk to the first balanced {…}.
function extractObject(text: string): any | null {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { const p = JSON.parse(stripped); if (p && typeof p === 'object') return p; } catch {}
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)                 { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ─── EL price list: which issue is on disk ────────────────────────────────────
// Every price this app quotes traces to one issue of the EL global price list.
// That issue used to exist only as a sentence hardcoded into the AI prompt, so
// replacing el_pricelist.xlsx left the app confidently citing the old date, and
// a quote could go out on superseded pricing with nothing to show it had.
//
// schematic_reader --mode version reads the workbook's own header (it states its
// label, valid-from, currency and the EUR→GBP rate the £ columns were built
// with) plus a content hash. Cached because the hash reads the whole file.
interface PriceListVersion {
  label: string; validFrom: string; currency: string; exchangeRate: number | null;
  fingerprint: string; fileSize: number; modified: string; rows: number; error?: string;
}
let _plVersion: { v: PriceListVersion; ts: number } | null = null;
const PL_TTL = 5 * 60 * 1000;

function pricelistVersion(force = false): Promise<PriceListVersion> {
  return new Promise((resolve) => {
    const empty: PriceListVersion = {
      label: '', validFrom: '', currency: '', exchangeRate: null,
      fingerprint: '', fileSize: 0, modified: '', rows: 0, error: 'price list not found',
    };
    if (!force && _plVersion && Date.now() - _plVersion.ts < PL_TTL) { resolve(_plVersion.v); return; }
    const script = pyFile('schematic_reader.py');
    if (!existsSync(script)) { resolve(empty); return; }
    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--mode', 'version'],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '';
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 20_000);
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(killer); resolve(empty); });
    proc.on('close', () => {
      clearTimeout(killer);
      try {
        const v = JSON.parse(out.trim()) as PriceListVersion;
        _plVersion = { v, ts: Date.now() };
        resolve(v);
      } catch { resolve(empty); }
    });
  });
}

// One line naming the issue in force, for the AI prompts that must not invent
// their own. Falls back to saying nothing rather than to a stale hardcoded date.
function pricelistLabel(v: PriceListVersion | null): string {
  if (!v || !v.label) return 'the EL Global Price List';
  return `the EL Global Price List (${v.label}${v.validFrom ? `, valid from ${v.validFrom}` : ''})`;
}

// The fingerprint of the issue this desk last acknowledged. When the file on
// disk stops matching, the app says so instead of quietly repricing.
function seenPricelistFingerprint(): string {
  const r = queryAll(`SELECT value FROM meta WHERE key = 'pricelist_fingerprint'`)[0] as any;
  return r ? String(r.value || '') : '';
}
function ackPricelistFingerprint(fp: string) {
  db.run(`INSERT INTO meta (key, value, updatedAt) VALUES ('pricelist_fingerprint', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    [fp, new Date().toISOString()]);
  saveDb();
}

// ─── EL price-sheet lookup (authoritative internal source) ─────────────────────
// Spawns schematic_reader.py --mode search against el_pricelist.xlsx and returns real
// rows. Hoisted to module scope so BOTH the Inbox pricing chat AND the main Ask Vector
// brain (chatAnswer) consult the same sheet — the sheet is the ONLY trustworthy source
// of Eaton EL catalogue numbers; anything not here must NOT be invented.
interface ElSheetRow { catNo: string; description: string; family: string; listPrice: number; ntp: number; status: string; matchType: string; score: number; }
const _elSearchCache = new Map<string, ElSheetRow[]>();
function elSheetSearch(query: string, cacheKey?: string): Promise<ElSheetRow[]> {
  return new Promise((resolve) => {
    const q = String(query || '').trim();
    if (cacheKey && _elSearchCache.has(cacheKey)) { resolve(_elSearchCache.get(cacheKey)!); return; }
    const script = pyFile('schematic_reader.py');
    if (!existsSync(script) || !q) { resolve([]); return; }
    const tmpDir = path.join(os.tmpdir(), `elsearch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    try { mkdirSync(tmpDir, { recursive: true }); } catch {}
    const inp = path.join(tmpDir, 'q.txt');
    try { writeFileSync(inp, q); } catch { resolve([]); return; }
    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--mode', 'search', '--input', inp], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '';
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 30_000);
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const done = (matches: any[]) => {
      clearTimeout(killer);
      try { unlinkSync(inp); } catch {}
      try { rmdirSync(tmpDir); } catch {}
      const rows: ElSheetRow[] = (matches || []).map((m: any) => ({
        catNo: m.cat_no, description: m.description, family: m.family || '',
        listPrice: m.list_price || 0, ntp: m.ntp || 0, status: m.status || '',
        matchType: m.match_type || '', score: m.score || 0,
      }));
      if (cacheKey) _elSearchCache.set(cacheKey, rows);
      resolve(rows);
    };
    proc.on('error', () => done([]));
    proc.on('close', () => {
      // schematic_reader can emit bare NaN / Infinity (invalid JSON) for a missing
      // NTP — sanitize to null so JSON.parse doesn't throw and drop the whole result.
      const safe = out.trim().replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null');
      try { done(JSON.parse(safe).matches || []); } catch { done([]); }
    });
  });
}
function fmtElRow(r: ElSheetRow): string {
  const tag = r.matchType === 'exact' ? '[exact]' : `[description-match, score ${r.score}]`;
  const price = `list £${r.listPrice.toFixed(2)}${r.ntp ? ` | NTP £${r.ntp.toFixed(2)}` : ''}`;
  return `${r.catNo} — ${r.description}${r.family ? ` (${r.family})` : ''}: ${price} ${tag}`;
}

// ─── Answer meta: a smart title + quick-action offers ──────────────────────────
// One fast call after each answer returns BOTH: (1) a short, topic-based TITLE naming
// what the answer/thread is actually about (used to name exports — NOT the literal last
// message like "put them on a table"); and (2) 2-4 creative next-action offers rendered
// as clickable chips (clicking sends it as the next message → endless follow-ups).
async function answerMeta(
  ai: any, query: string, answer: string,
  history?: Array<{ role: string; text: string }>,
): Promise<{ title: string; suggestions: string[] }> {
  try {
    const convo = [
      ...(history || []).slice(-4).map(h => `${h.role === 'user' ? 'User' : 'Vector'}: ${String(h.text).replace(/\s+/g, ' ').slice(0, 280)}`),
      `User: ${String(query).replace(/\s+/g, ' ').slice(0, 280)}`,
      `Vector: ${String(answer).replace(/\s+/g, ' ').slice(0, 700)}`,
    ].join('\n');
    const prompt =
      'You are Ask Vector inside Vector, an Eaton quote/PMO automation app. Read the conversation and return TWO things as JSON.\n' +
      '1) "title": a short, specific, human title for what this answer/thread is ABOUT — used to name an exported file. Describe the SUBJECT, never the user\'s phrasing or the action. E.g. "Eaton V-CG-SLU 490 Alternatives", "PMO Raising Walkthrough", "FedAuth Reconnect Fix", "4kVA Quote Search". 3-7 words, Title Case, no dates, no file extension, no quotes, no "Ask Vector".\n' +
      '2) "actions": the 2-4 most useful NEXT ACTIONS the user may want next — creative, specific to THIS conversation, short imperative offers the assistant will carry out if clicked (e.g. put the options in a comparison table; draft an email to the customer; price the alternatives; pull a datasheet; list phase-out replacements; explain the differences). Each 3-7 words, imperative, no trailing punctuation, no numbering, no quotes. [] if none fit.\n\n' +
      `Conversation:\n${convo}\n\nReturn ONLY a JSON object: {"title": "...", "actions": ["...", "..."]}.`;
    const r = await generateWithRetry(ai, {
      model: AI_MODEL_FAST,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 300, temperature: 0.6, thinkingConfig: { thinkingBudget: 0 } },
    });
    const obj = extractObject(r.text ?? '') || {};
    const title = typeof obj.title === 'string'
      ? obj.title.trim().replace(/^["'\s]+|["'\s.]+$/g, '').replace(/\.(pdf|docx?|xlsx?|csv|txt|md|html|json)$/i, '').slice(0, 70)
      : '';
    const suggestions = Array.isArray(obj.actions)
      ? obj.actions
          .filter((s: any) => typeof s === 'string' && s.trim())
          .map((s: string) => s.trim().replace(/^[-*\d.\s]+/, '').replace(/[.]+$/, '').slice(0, 60))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    return { title, suggestions };
  } catch {}
  return { title: '', suggestions: [] };
}

// ─── Shared chat brain (used by /api/ai and /api/quote-ask chat fallback) ──────
// Builds live app context from the local jobs DB + queue, then asks Gemini. Google
// Search grounding is ALWAYS attached — the model self-decides when to actually search,
// so Ask Vector can always verify, find alternatives or pull datasheets and NEVER has to
// say "I can't search". Cited sources are appended whenever it grounded. Full access,
// every time (Laith's explicit ask). Also returns creative quick-action offers.
async function chatAnswer(
  query: string,
  history?: Array<{ role: string; text: string }>,
): Promise<{ answer: string | null; error?: string; source?: string; suggestions?: string[]; title?: string }> {
  const ai = getGemini();
  if (!ai) return { answer: null, error: 'No Gemini API key — add gemini_key in Settings' };

  let appContext = '';
  try {
    const recentJobs = queryAll('SELECT step, pdfName, status, product, customer, timestamp, note, price, salesman FROM jobs ORDER BY id DESC LIMIT 20');
    const stats = queryAll(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='err' THEN 1 ELSE 0 END) AS failed FROM jobs WHERE timestamp >= date('now','-7 days')`)[0];
    const cfg = loadPyCfg();
    const queueFiles = existsSync(path.join(cfg.base, 'PDF Quotes'))
      ? readdirSync(path.join(cfg.base, 'PDF Quotes')).filter((f: string) => /\.(pdf|xlsx)$/i.test(f))
      : [];
    const spOk = !!getSpCookies();
    const contextLines = [
      'SharePoint: ' + (spOk ? 'connected' : 'DISCONNECTED'),
      'PDF queue: ' + queueFiles.length + ' file(s)' + (queueFiles.length ? ' - ' + (queueFiles as string[]).slice(0, 8).join(', ') : ''),
      'Last 7 days: ' + stats.total + ' jobs | ' + stats.ok + ' processed | ' + stats.failed + ' failed',
      'Recent jobs:',
      ...recentJobs.map((j: any) => {
        let l = '  ' + j.timestamp + ' | ' + j.step + ' | ' + (j.pdfName || '-') + ' | ' + j.status;
        if (j.customer) l += ' | ' + j.customer;
        if (j.product) l += ' | ' + j.product;
        if (j.price)    l += ' | £' + j.price;
        if (j.note)     l += ' | NOTE: ' + j.note;
        return l;
      }),
    ];
    const fenBlock = fentonKnowledgeBlock();
    if (fenBlock) contextLines.push('', fenBlock);
    appContext = contextLines.join('\n');
  } catch {}

  // ── Consult the AUTHORITATIVE Eaton EL price sheet whenever a product/part/price is
  // in play. The sheet is the only trustworthy source of real Eaton EL catalogue numbers
  // — without it the model guesses (mislabels real Eaton parts / invents cat-nos). We
  // look at the message + recent user turns so a cat-no mentioned EARLIER still resolves
  // on a chatty follow-up ("dig it up online and double check", "give me the codes").
  const userHist = (history || []).filter(h => h.role === 'user').slice(-3).map(h => h.text);
  const lookupText = [query, ...userHist].join('  ');
  // Catalogue-number-like tokens (6+ digit runs, or alnum codes with a digit).
  const catTokens = Array.from(new Set(
    (lookupText.match(/\b(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9-]{4,}\b/g) || []).slice(0, 5),
  ));
  // Run the (python-spawning) sheet lookup only when there's an actual product signal —
  // a cat-no anywhere in the thread, or product/price wording. Pure chit-chat skips it.
  const wantSheet = catTokens.length > 0
    || /\b(price|pricing|cost|ntp|list price|catalogue|catalog|cat[\s-]?no|part\s*(?:no|number)|fitting|luminaire|lumen|wattage|bulkhead|exit sign|emergency|driver|led|tube|equivalent|alternativ|replace|substitut|phase[\s-]?out|datasheet|data sheet|spec)\b/i.test(lookupText);
  if (wantSheet) {
    try {
      // Search EACH bare token on its own — a chatty blob otherwise buries the exact row
      // under junk description-matches; the bare token gives a clean [exact] hit.
      const byCat = new Map<string, ElSheetRow>();
      const exacts: ElSheetRow[] = [];
      for (const tok of catTokens) {
        const rows = await elSheetSearch(tok, `tok:${tok}`);
        const ex = rows.find(r => r.matchType === 'exact');
        if (ex && !byCat.has(ex.catNo)) { byCat.set(ex.catNo, ex); exacts.push(ex); }
      }
      // Always also run a description search on the raw question for close candidates.
      for (const r of (await elSheetSearch(query)).slice(0, 6)) {
        if (r.catNo && !byCat.has(r.catNo)) byCat.set(r.catNo, r);
      }
      // Each exact hit → pull its family siblings from the sheet as real alternatives.
      for (const ex of exacts) {
        const seed = ex.family || ex.description.split(/[-(]/)[0].trim();
        if (!seed) continue;
        for (const r of (await elSheetSearch(seed, `fam:${seed}`)).slice(0, 12)) {
          if (r.catNo && !byCat.has(r.catNo)) byCat.set(r.catNo, r);
        }
      }
      const uniq = Array.from(byCat.values());
      const sheetBlock = uniq.length
        ? [
            'Eaton EL price-sheet matches (ex VAT — AUTHORITATIVE internal source; the ONLY place real Eaton EL catalogue numbers come from — NEVER invent one, NEVER call these parts another brand):',
            ...uniq.slice(0, 16).map(fmtElRow),
            '[exact] = confirmed Eaton EL part — it IS a real Eaton item; state its real description/price and note "Phase-out planned" if flagged. [description-match] = real sheet rows in the SAME FAMILY. When the user asks for an alternative/equivalent/replacement, you MUST list these same-family rows with their catalogue number + description (+ price if asked) as "same-family options in the sheet" — NEVER answer "no alternatives" while such rows exist; let the user pick and note the variant difference (e.g. output/size) where clear. Prices are internal Eaton — give the figures asked, don\'t dump every column.',
          ].join('\n')
        : 'Eaton EL price-sheet: NO row matched. It may be a non-EL Eaton product (this sheet is emergency-lighting only) — say you can\'t confirm it in the EL sheet and offer to check the web / EL Pricer. Do NOT assign it to another brand from a guess, and NEVER invent an Eaton catalogue number.';
      appContext += (appContext ? '\n\n' : '') + '## Eaton EL price sheet (authoritative — read before answering)\n' + sheetBlock;
    } catch {}
  }

  const turns: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (history?.length) {
    for (const h of history.slice(-10)) {
      turns.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] });
    }
  }
  turns.push({ role: 'user', parts: [{ text: query }] });

  try {
    const response = await generateWithRetry(ai, {
      model: smartModel(),
      contents: turns,
      // Thinking models draw reasoning tokens from maxOutputTokens — keep it generous so
      // the visible answer is never starved. Google Search grounding is ALWAYS attached;
      // the model decides when to actually search, so it can always verify / find specs.
      config: {
        systemInstruction: buildSystemPrompt(appContext),
        maxOutputTokens: 8192,
        temperature: 0.5,
        tools: [{ googleSearch: {} }],
      },
    });
    let answer = response.text ?? null;

    // Append clickable, deduped source citations (ChatGPT-style) when it grounded.
    if (answer) {
      const chunks = (response as any)?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const seen = new Set<string>();
      const cites: string[] = [];
      for (const c of chunks) {
        const url = c?.web?.uri;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        let title = c?.web?.title || '';
        try { title = title || new URL(url).hostname.replace(/^www\./, ''); } catch {}
        cites.push(`- [${title}](${url})`);
        if (cites.length >= 6) break;
      }
      if (cites.length && !/\bsources?\b\s*[:\n]/i.test(answer)) {
        answer += `\n\n**Sources**\n${cites.join('\n')}`;
      }
    }

    const meta = answer ? await answerMeta(ai, query, answer, history) : { title: '', suggestions: [] };
    return { answer, source: 'gemini+web', suggestions: meta.suggestions, title: meta.title };
  } catch (e: any) {
    const detail = e.cause?.message ? ` (${e.cause.message})` : '';
    return { answer: null, error: 'Gemini error: ' + e.message + detail };
  }
}

// ─── D&Q Store full-text search (name + PDF/email content via SharePoint index) ─
// Returns matched docs plus `total` = SharePoint's TotalRows (the true match count,
// accurate even past the row limit — used to answer "how many …" questions).
async function dqFullTextSearch(
  q: string, mine: boolean, cookieStr: string, cfg: Record<string, string>,
): Promise<{ results: any[]; total: number; author: string | null }> {
  const dqStore = cfg.dq_store || 'Shared Documents/D&Q Store';
  const dqUrl   = `${cfg.sp_site}/${dqStore}`;

  // Resolve the connected user's display name to filter by Author (Created By).
  let author: string | null = null;
  if (mine) {
    try {
      const me = await spGet(`${cfg.sp_list}/_api/web/currentUser`, cookieStr);
      if (me.ok) author = JSON.parse(me.body)?.d?.Title || null;
    } catch { /* fall through — search unscoped if we can't resolve the user */ }
  }
  const authorFilter = author ? ` Author:"${author.replace(/"/g, '')}"` : '';

  // Neutralise KQL operators inside the user/caller term: a leading "-" is NOT,
  // ":" starts a property restriction, quotes/parens change grouping. Project
  // names like "24-7 Group" or "A - MANCHESTER, …" otherwise silently turn into
  // a different query than the one asked for.
  const term = String(q || '').replace(/["():]+/g, ' ').replace(/(^|\s)[-+~]+/g, '$1')
    .replace(/\s+/g, ' ').trim();
  // A 1-2 character term is not a restriction at all — SharePoint answers with
  // the whole store and the caller attaches whatever ranks first. Refuse it.
  if (term.replace(/[^A-Za-z0-9]/g, '').length < 3) return { results: [], total: 0, author };

  const kql   = `${term} path:"${dqUrl}" IsDocument:1${authorFilter}`;
  const props = 'Title,Path,Filename,FileExtension,LastModifiedTime,Author,HitHighlightedSummary';
  const searchUrl = `${cfg.sp_site}/_api/search/query`
    + `?querytext=${encodeURIComponent(`'${kql.replace(/'/g, "''")}'`)}`
    + `&selectproperties='${props}'`
    + `&rowlimit=50&trimduplicates=false`;

  const sr = await spGet(searchUrl, cookieStr);
  if (!sr.ok) throw new Error(`D&Q search failed (HTTP ${sr.status}) — reconnect to JOE`);

  const data    = JSON.parse(sr.body);
  const relevant = data?.d?.query?.PrimaryQueryResult?.RelevantResults;
  const rows    = relevant?.Table?.Rows?.results ?? [];
  const total   = Number(relevant?.TotalRows ?? rows.length) || rows.length;

  const results = rows.map((row: any) => {
    const cells: any[] = row.Cells?.results ?? [];
    const get = (k: string) => cells.find((c: any) => c.Key === k)?.Value ?? '';
    const url      = get('Path');
    const filename = get('Filename') || decodeURIComponent((url.split('/').pop() || '').split('?')[0]);
    const summary  = String(get('HitHighlightedSummary') || '')
      .replace(/<\/?c\d+>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return {
      title:    get('Title') || filename,
      filename,
      ext:      String(get('FileExtension') || '').toLowerCase(),
      url,
      author:   get('Author'),
      modified: get('LastModifiedTime'),
      summary,
    };
  }).filter((r: any) => r.url);

  return { results, total, author };
}

// ─── Quotations List metadata search (customer / salesman / price / division) ──
async function quotationsListSearch(
  q: string, cookieStr: string, cfg: Record<string, string>,
): Promise<any[]> {
  const safe   = q.replace(/'/g, "''");
  const select = 'Id,Title,SALESFORCEID,CUSTOMER,QUOTATION_x0020_NAME,ARRIVED_x0020_ON,STATUS,PRICE,DUEDATE,DIVISION,Country,REQUESTED_x0020_BY,REQUEST_x0020_TYPE';

  const trySearch = async (filter: string) => {
    try {
      const url = `${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items`
                + `?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=30&$orderby=ARRIVED_x0020_ON%20desc`;
      const r = await spGet(url, cookieStr);
      if (r.ok) return (JSON.parse(r.body)?.d?.results ?? []) as any[];
    } catch {}
    return [] as any[];
  };

  const [bySfId, byTitle, byQuoteName, byCustomer] = await Promise.all([
    trySearch(`SALESFORCEID eq '${safe}'`),
    trySearch(`substringof('${safe}',Title)`),
    trySearch(`substringof('${safe}',QUOTATION_x0020_NAME)`),
    trySearch(`substringof('${safe}',CUSTOMER)`),
  ]);

  const seen = new Set<number>();
  const merged: any[] = [];
  for (const item of [...bySfId, ...byTitle, ...byQuoteName, ...byCustomer]) {
    if (!seen.has(item.Id)) { seen.add(item.Id); merged.push(item); }
  }

  if (merged.length === 0) {
    const fallbackUrl = `${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items`
                      + `?$select=${select}&$top=200&$orderby=ARRIVED_x0020_ON%20desc`;
    const fb = await spGet(fallbackUrl, cookieStr);
    if (fb.ok) {
      const all   = (JSON.parse(fb.body)?.d?.results ?? []) as any[];
      const lower = q.toLowerCase();
      return all.filter((item: any) =>
        (item.SALESFORCEID || '').toLowerCase().includes(lower) ||
        (item.Title || '').toLowerCase().includes(lower) ||
        (item.QUOTATION_x0020_NAME || '').toLowerCase().includes(lower) ||
        (item.CUSTOMER || '').toLowerCase().includes(lower) ||
        (item.REQUESTED_x0020_BY || '').toLowerCase().includes(lower)
      );
    }
  }
  return merged;
}

// ─── Quotations List via the SharePoint SEARCH API (KQL) ──────────────────────
// Unlike the list REST $select, the search index returns people-picker fields
// (REQUESTED_x0020_BY, inside-sales, author) as plain strings — so this is how we
// recover the salesman. Returns the same item shape as quotationsListSearch.
async function spSearchQuotes(term: string, cookieStr: string, cfg: Record<string, string>): Promise<any[]> {
  const props = "Title,SALESFORCEID,CUSTOMER,QUOTATION_x0020_NAME,ARRIVED_x0020_ON,STATUS,PRICE,REQUEST_x0020_TYPE,"
              + "DIVISION,Country,REQUESTED_x0020_BY,Author,EditorOWSUSER";
  const encoded = encodeURIComponent(`"${String(term).replace(/"/g, '')}"`);
  const url = `${cfg.sp_list}/_api/search/query?querytext=${encoded}`
            + `&selectproperties='${props}'&sourceid='8413cd39-2156-4e00-b54d-11efd9abdb89'&rowlimit=30`;
  try {
    const sr = await spGet(url, cookieStr);
    if (!sr.ok) return [];
    const rows = JSON.parse(sr.body)?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows?.results ?? [];
    return (rows as any[]).map(row => {
      const cells: any[] = row.Cells?.results ?? [];
      const get = (k: string) => cells.find((c: any) => c.Key === k)?.Value ?? '';
      return {
        Id: get('DocId') || get('SALESFORCEID') || get('Title'),
        SALESFORCEID: get('SALESFORCEID'), CUSTOMER: get('CUSTOMER'),
        QUOTATION_x0020_NAME: get('QUOTATION_x0020_NAME'), Title: get('Title'),
        STATUS: get('STATUS'), PRICE: get('PRICE'), ARRIVED_x0020_ON: get('ARRIVED_x0020_ON'),
        DIVISION: get('DIVISION'), REQUESTED_x0020_BY: get('REQUESTED_x0020_BY'),
        INSIDE_x0020_SALES: get('INSIDE_x0020_SALES'), INSIDESALES: get('INSIDESALES'),
        Author: get('Author'), EditorOWSUSER: get('EditorOWSUSER'), AuthorOWSUSER: get('AuthorOWSUSER'),
      };
    });
  } catch { return []; }
}

// Resolve the connected user's SharePoint identity (numeric Id + display name).
async function spCurrentUser(cookieStr: string, cfg: Record<string, string>): Promise<{ id: number; title: string } | null> {
  try {
    const me = await spGet(`${cfg.sp_list}/_api/web/currentUser`, cookieStr);
    if (me.ok) { const d = JSON.parse(me.body)?.d; if (d?.Id) return { id: d.Id, title: d.Title || '' }; }
  } catch { /* ignore */ }
  return null;
}

// Display name of whoever is currently connected to JOE, cached 5 min. Used to
// stamp the salesman on quotes and personalise inbox AI prompts, so the app
// follows the logged-in Eaton employee instead of a hardcoded owner.
let _connectedUser: { name: string; ts: number } | null = null;
async function connectedUserName(): Promise<string | null> {
  if (_connectedUser && Date.now() - _connectedUser.ts < 5 * 60_000) return _connectedUser.name || null;
  const cookies = getSpCookies();
  if (!cookies) return null;
  const me = await spCurrentUser(`FedAuth=${cookies.fed}; rtFa=${cookies.rt}`, loadPyCfg());
  if (me?.title) { _connectedUser = { name: me.title, ts: Date.now() }; return me.title; }
  return null;
}

// ─── Scan the Quotations List via the LIST REST API, scoped to one author ─────
// The search API does NOT return the list's custom columns and isn't list-scoped,
// so we page the list itself (real CUSTOMER/PRICE/SALESFORCEID/salesman) and keep
// only rows authored by the connected user (matched on AuthorId — exact, no name
// guessing). Pages via the REST __next link. `useReqBy` expands the salesman
// people-field; if that expand is invalid for this list it retries without it.
interface ScanOpts {
  useReqBy?: boolean;
  maxPages?: number;
  since?: string;   // ISO time — only items Modified after this (incremental)
  onPage?: (pages: number, fetched: number, kept: number) => void;
  shouldStop?: () => boolean;
}
// Total item count of the list, for progress %.
async function spListItemCount(cookieStr: string, cfg: Record<string, string>): Promise<number | null> {
  try {
    const r = await spGet(`${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')?$select=ItemCount`, cookieStr);
    if (r.ok) return JSON.parse(r.body)?.d?.ItemCount ?? null;
  } catch { /* ignore */ }
  return null;
}
// People-field that holds the salesman ("Requested From (internal)"), as a user Id.
const REQ_FROM_ID = 'REQUESTEDFROM_x0028_INTERNAL_x00Id';
const INSIDE_SALES_ID = 'INSIDE_x0020_SALES0Id';

async function spScanMyQuotes(cookieStr: string, cfg: Record<string, string>, ownerId: number, opts: ScanOpts = {}): Promise<any[]> {
  const maxPages = opts.maxPages ?? 300;
  // No $select/$expand — the default item payload already includes every column
  // (CUSTOMER, PRICE, the salesman user-Id fields, AuthorId), so we avoid guessing
  // fragile internal field names. When `since` is set we filter by Modified (an
  // indexed column → no list-view-threshold error) for an incremental pull.
  const base = `${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items?$top=1000`;
  let url: string = opts.since
    ? `${base}&$filter=${encodeURIComponent(`Modified gt datetime'${opts.since}'`)}&$orderby=Modified%20desc`
    : base;
  const out: any[] = [];
  let pages = 0, fetched = 0;
  while (url && pages < maxPages) {
    if (opts.shouldStop?.()) break;
    const r = await spGet(url, cookieStr);
    if (!r.ok) {
      if (out.length) break;
      throw new Error(`Quotations List query failed (HTTP ${r.status})`);
    }
    const j = JSON.parse(r.body);
    const results = j?.d?.results ?? [];
    fetched += results.length;
    for (const it of results) if (it.AuthorId === ownerId) out.push(it);
    pages++;
    opts.onPage?.(pages, fetched, out.length);
    url = j?.d?.__next || '';
  }
  return out;
}

// Resolve SharePoint user Ids → display names (cached, one call per distinct Id).
async function spResolveUsers(ids: number[], cookieStr: string, cfg: Record<string, string>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const distinct = [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))];
  for (const id of distinct) {
    try {
      // Resolve against the LIST's site (sp_list), where these user Ids live.
      const r = await spGet(`${cfg.sp_list}/_api/web/getuserbyid(${id})?$select=Title`, cookieStr);
      if (r.ok) { const t = JSON.parse(r.body)?.d?.Title; if (t) map.set(id, t); }
    } catch { /* skip */ }
  }
  return map;
}

// ─── Local saved-jobs keyword search (the already-processed quotes DB) ────────
// Always available (no SharePoint needed). Matches keywords across every useful
// column of the `jobs` table — salesman, customer, product, SR00 id, file name,
// notes. ALL keywords must hit; if that finds nothing, relax to ANY keyword.
const _JOB_FILLER = new Set([
  'quote', 'quotes', 'from', 'with', 'the', 'a', 'an', 'of', 'for', 'in', 'it',
  'that', 'has', 'have', 'had', 'and', 'any', 'all', 'show', 'find', 'me', 'my',
  'how', 'many', 'did', 'do', 'does', 'made', 'make', 'to', 'search', 'list',
  'get', 'give', 'about', 'i', 'system', 'systems', 'on', 'is', 'are', 'who',
]);
function searchLocalJobs(rawTerms: string[]): any[] {
  const kw = rawTerms.map(t => t.toLowerCase().trim()).filter(t => t.length > 1 && !_JOB_FILLER.has(t));
  if (!kw.length) return [];
  let rows: any[] = [];
  try {
    rows = queryAll('SELECT timestamp, step, pdfName, sfId, status, product, customer, price, salesman, note FROM jobs ORDER BY id DESC LIMIT 2000');
  } catch { return []; }
  const hay = (r: any) =>
    [r.pdfName, r.sfId, r.product, r.customer, r.salesman, r.note, r.status]
      .map((x: any) => String(x || '').toLowerCase()).join(' ');
  const all = rows.filter(r => { const h = hay(r); return kw.every(k => h.includes(k)); });
  if (all.length) return all;
  return rows.filter(r => { const h = hay(r); return kw.some(k => h.includes(k)); });
}

// ─── Local job row → result card (DqDoc shape) ────────────────────────────────
function jobToCard(j: any): any {
  return {
    title:    `${j.sfId || j.pdfName || 'quote'}${j.customer ? ` — ${j.customer}` : ''}`,
    filename: j.pdfName || '',
    ext:      'job',
    url:      '',
    author:   j.salesman || '',
    modified: j.timestamp || '',
    summary:  [j.product, j.price ? '£' + j.price : '', j.status, j.note].filter(Boolean).join(' · '),
  };
}


function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.listen(start, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', () => findFreePort(start + 1).then(resolve).catch(reject));
  });
}

async function startServer() {
  // Initialize sql.js here (avoids top-level await, required for esbuild CJS bundling).
  // In the SEA sidecar, DATA_DIR holds sql-wasm.wasm (copied by Rust on first run).
  // In dev (tsx server.ts), no locateFile — sql.js finds its own wasm in node_modules.
  SQL = await initSqlJs(
    process.env.TAURI_SIDECAR
      ? { locateFile: (file: string) => path.join(DATA_DIR, file) }
      : undefined,
  );
  loadDb();

  const isSidecar = !!process.env.TAURI_SIDECAR;
  // VECTOR_PORT lets a second instance run beside the dev server (own DATA_DIR,
  // own port) — the only way to exercise routes end-to-end without stopping the
  // one you are working in. Still bound to 127.0.0.1 like every other mode.
  const portEnv   = Number(process.env.VECTOR_PORT) || 0;
  const PORT      = portEnv || (isSidecar ? await findFreePort(7331) : 3000);
  const app       = express();

  // ── Security: only accept requests addressed to localhost ──────────────────
  // The server binds 127.0.0.1, but a malicious website can still reach it via
  // DNS rebinding (a domain that resolves to 127.0.0.1 — the browser then sends
  // requests with a foreign Host header). Rejecting non-local Host kills that.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // Browser-originated cross-site requests carry an Origin header; same-origin
    // GETs and non-browser clients (curl, Python) don't. Block foreign origins.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // ── Stripped ship build: gate AI + unreleased tools server-side ────────────
  // The UI hides these behind "Coming Soon", but the endpoints must also refuse,
  // otherwise anyone can drive them with curl against the sidecar port.
  if (isSidecar) {
    const SHIP_BLOCKED = [
      // /api/quote-ask is the one the Ask Vector tab actually sends on — blocking
      // /api/ai alone left the whole brain reachable with one curl.
      '/api/ai', '/api/ai-models', '/api/quote-ask',
      '/api/search', '/api/schematics', '/api/pmo',
      '/api/docs', '/api/docs-xlsx',
      '/api/run/cbu', '/api/run/commission', '/api/run/pmo',
      '/api/outlook/summarize', '/api/outlook/draft-reply', '/api/outlook/chat',
      '/api/outlook/polish-reply', '/api/outlook/suggest-send',
      '/api/outlook/attachment-price',
      '/api/el-internal/digest', '/api/el-internal/chat',
      '/api/fenton/refresh', '/api/fenton/chat',
      '/api/quote/detect-cbu', '/api/quote/luminaires',
      // CBU reference quotes: same gated tab, and the scanner script is not
      // staged into ship-automation either.
      '/api/cbu/refs',
      '/api/crm/command',
      // To-Do: the AI triage and the AI draft writer only. The board itself
      // (/api/todo, /api/todo/:id/send) stays usable in the ship build.
      '/api/todo/scan', '/api/todo/draft',
      // LSD Pricing: the tab is locked in the ship and lsd_pricing.py is not
      // staged into ship-automation, so the whole surface refuses here too.
      '/api/lsd',
    ];
    app.use((req, res, next) => {
      if (SHIP_BLOCKED.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        res.status(403).json({ error: 'This feature is not available in this build.' });
        return;
      }
      next();
    });
  }

  app.use(express.json());

  // ── Session binding ─────────────────────────────────────────────────────────
  // Give each browser a vec_sid cookie and run the request inside an ALS context
  // carrying that session's SharePoint cookies, so getSpCookies() is per-user.
  app.use((req, res, next) => {
    let sid = parseReqCookie(req.headers.cookie, 'vec_sid');
    if (!sid) {
      sid = randomUUID();
      res.setHeader('Set-Cookie', `vec_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    }
    const sess = SESSIONS.get(sid);
    reqCtx.run({ sid, cookies: sess ? { fed: sess.fed, rt: sess.rt } : null }, () => next());
  });

  // POST /api/session/cookies — inject this session's JOE cookies (multi-user web
  // client supplies its own); empty body clears them.
  app.post('/api/session/cookies', (req, res) => {
    const sid = currentSid();
    if (!sid) { res.status(400).json({ error: 'no active session — restart Vector' }); return; }
    const { fed, rt } = req.body || {};
    if (!fed || !rt) { dropSession(sid); const st = reqCtx.getStore(); if (st) { st.cookies = null; st.owner = undefined; } res.json({ ok: true, cleared: true }); return; }
    SESSIONS.set(sid, { fed, rt, ts: Date.now() });
    persistSession(sid);
    const store = reqCtx.getStore(); if (store) { store.cookies = { fed, rt }; store.owner = undefined; }
    res.json({ ok: true });
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get('/api/ping', (_req, res) => res.json({ version: 'Vector', pmo: true, analytics: true }));

  app.get('/api/stats', (_req, res) => {
    const cfg = loadPyCfg();
    let pdfsQueued = 0, emailsInDrop = 0, archivedToday = 0;
    try {
      const d = path.join(cfg.base, 'PDF Quotes');
      if (existsSync(d)) pdfsQueued = readdirSync(d).filter(f => ['.pdf','.xlsx','.xls','.xlsm','.docx','.doc','.dotm','.dotx'].some(e => f.toLowerCase().endsWith(e))).length;
    } catch {}
    try {
      const d = path.join(cfg.base, 'Email Drop');
      if (existsSync(d)) emailsInDrop = readdirSync(d).filter(f => /\.(eml|msg)$/i.test(f)).length;
    } catch {}
    try {
      const today = new Date().toISOString().slice(0, 10);
      const d     = path.join(cfg.base, 'Archive', today);
      if (existsSync(d)) archivedToday = readdirSync(d).filter(f => ['.pdf','.xlsx','.xls','.xlsm','.docx','.doc','.dotm','.dotx'].some(e => f.toLowerCase().endsWith(e))).length;
    } catch {}
    res.json({ pdfsQueued, emailsInDrop, archivedToday });
  });

  // ── Jobs ───────────────────────────────────────────────────────────────────
  app.get('/api/jobs', (_req, res) => {
    res.json(queryAll('SELECT * FROM jobs ORDER BY id DESC LIMIT 200'));
  });
  app.post('/api/jobs', (req, res) => {
    const { step, pdfName, sfId, status, items, note, product, customer, price, salesman, durationSec } = req.body;
    const id = insertJob({ step, pdfName, sfId, status, items, note, product, customer, price, salesman, durationSec });
    res.json({ id });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Mini CRM ───────────────────────────────────────────────────────────────
  // "Accounts" are seeded from the customer field of past jobs — today those are
  // quote names, later real customer names. Each account claims one or more match
  // strings (aliases); merging folds several accounts' aliases together so a real
  // customer can aggregate the quotes of several quote-name cards. Quotes, opps,
  // facts (AI) and documents are all derived LIVE so nothing goes stale.
  // ══════════════════════════════════════════════════════════════════════════

  function crmAliases(companyId: number): string[] {
    const rows = queryAll('SELECT name FROM crm_alias WHERE companyId = ?', [companyId]);
    return rows.map((r: any) => String(r.name));
  }

  // Order-independent name match (handles "Bayley, Joe" vs "Joe Bayley" and middle
  // initials), so the roster's email/phone attaches to the resolved salesman.
  function matchSalesman(name: string): Salesman | null {
    const toks = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const nt = new Set(toks(name));
    if (!nt.size) return null;
    return salesmenRoster().find(r => { const rt = toks(r.name); return rt.length > 0 && rt.every(t => nt.has(t)); }) || null;
  }

  // Pull the salesman from any of a SharePoint row's people fields (claims/OWSUSER
  // prefixes stripped); prefer a roster match for a clean name.
  function spSalesman(it: any): string | null {
    const cands = [it.REQUESTED_x0020_BY, it.INSIDE_x0020_SALES, it.INSIDESALES, it.Author, it.EditorOWSUSER, it.AuthorOWSUSER]
      .map(v => (v && typeof v === 'object') ? (v.Title || v.Email || '') : String(v || ''))
      .map(s => s.replace(/^[^|;]*[|]/, '').replace(/^\d+;#/, '').trim())
      .filter(Boolean);
    for (const c of cands) { const r = matchSalesman(c); if (r) return r.name; }
    const named = cands.find(c => /[a-z]{2,}\s+[a-z]{2,}/i.test(c));
    return named || cands[0] || null;
  }
  function spPrice(it: any): number | null {
    const n = parseFloat(String(it.PRICE ?? '').replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  // Strip a trailing customer/quote code in parentheses, e.g.
  // "EDMUNDSON ELECTRICAL LTD(194285)" → "EDMUNDSON ELECTRICAL LTD".
  function stripAccountCode(raw: string): string {
    return String(raw || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
  }

  // Account name from the project field (QUOTATION_NAME), aggressively cleaned:
  // fix bad encoding, drop a leading quote code, cut option/AKA suffixes, strip
  // trailing code/date. Falls back to the distributor (CUSTOMER) when the project
  // is empty or just a quote number/code.
  function cleanProjectName(quoteName: string, customer: string): string {
    let s = String(quoteName || '')
      .replace(/[^ -~]/g, ' ')   // replacement char + control chars
      .replace(/\s+/g, ' ').trim();
    s = s.replace(/^[A-Za-z]{1,4}\d{3,}[A-Za-z0-9.\-]*\s*[-:]\s*/, '').trim(); // leading quote code "QW27313A - "
    s = s.replace(/^[-\s]*A\d+R\b[-\s]*/i, '').trim();  // leading region code "A1R- "
    s = s.split(/\s+AKA\s+/i)[0];                       // "X AKA Y" → "X"

    // Tidy one candidate name: trailing code/date/qualifier, stray punctuation.
    const tidy = (v: string) => v
      .replace(/\s*\([^()]*\)\s*$/, '')                 // trailing (code)
      .replace(/\s*\([^()]*$/, '')                      // dangling "(…" — SP truncates this field
      .replace(/[\s\-#]+\d{4,}(?:-\d+)?\s*$/, '')       // trailing date
      .replace(/\s+(only|stock|ele|EL|additions|renewal)\s*$/i, '') // order qualifiers
      .replace(/^[\s\-#/,]+/, '')
      .trim();
    // Junk = empty, too short, or a bare quote number/code (e.g. "27352", "QW27411").
    const junk = (v: string) => !v || v.length < 3 || /^[A-Za-z]{0,4}\d{2,}[A-Za-z0-9]*$/.test(v);

    // "A - MANCHESTER, …", "QR - Cross Manufacturing", "507660 - Hindle Court":
    // the first segment is a revision marker or works number, not the project.
    // Take the first segment that is a REAL name and never keep a 1-2 char
    // fragment — as an account alias it matches every lookup and turns the D&Q
    // search into "return the whole store".
    for (const seg of s.split(/\s+-\s+/)) {
      const v = tidy(seg);
      if (!junk(v)) return v;
    }
    const cust = stripAccountCode(customer);
    if (!junk(cust)) return cust;
    const whole = tidy(s);
    return junk(whole) ? '' : whole;
  }

  // The raw jobs.customer values are OCR-noisy quote names: a Salesforce/case ID
  // (SR00…, CR00…, EU00…, 006QO0000…, QB…) + a YA-record-type token + the project/
  // customer name + a trailing date. Strip the ID and trailing date → clean name.
  function cleanQuoteName(raw: string): string {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    // Leading ID ending at the "…YAx" record-type token (prefix must contain a digit).
    const m = s.match(/^[A-Za-z0-9][A-Za-z0-9 ]*?\d[A-Za-z0-9 ]*?YA[A-Za-z0-9](?:-[A-Za-z0-9]+)*\s*-?\s*/i);
    if (m) s = s.slice(m[0].length);
    else {
      const m2 = s.match(/^[A-Za-z0-9]*\d[A-Za-z0-9]*\s*-\s*/); // "QB28412A2R - name"
      if (m2) s = s.slice(m2[0].length);
    }
    // Strip leftover region/product codes like "A1R", "A4R" (with surrounding
    // dashes/spaces) that sit between the ID token and the real name.
    s = s.replace(/^[-\s]*A\d+R\b[-\s]*/i, '').trim();
    s = s.replace(/[\s\-#]+\d{4,}(?:-\d+)?\s*$/, '').trim(); // full/truncated long date
    s = s.replace(/[\s\-#]+\d{1,3}\s*$/, '').trim();         // short truncated remainder
    s = s.replace(/^[\-#\s]+/, '').trim();
    return s || String(raw).trim();
  }

  // The leading ID blob, for display as the quote reference.
  function quoteRef(raw: string): string {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = s.match(/^([A-Za-z0-9][A-Za-z0-9 ]*?\d[A-Za-z0-9 ]*?YA[A-Za-z0-9](?:-[A-Za-z0-9]+)*)/i);
    if (m) return m[1].replace(/\s+/g, '');
    const m2 = s.match(/^([A-Za-z0-9]*\d[A-Za-z0-9]*)\s*-/);
    return m2 ? m2[1] : '';
  }

  // Does a job's cleaned customer name match an account (full or partial overlap)?
  function nameMatches(jobClean: string, aliasClean: string): boolean {
    const a = jobClean.toLowerCase(), b = aliasClean.toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
    return false;
  }

  // ── Active SharePoint user (tenant key) ──────────────────────────────────────
  // The CRM is multi-tenant: every row is scoped by the SP user's id. The active
  // owner = whoever is currently connected to JOE, resolved from their cookies
  // (any Eaton/JOE user — no hardcoded identity). It's cached and re-resolved only
  // when the cookies change (a different user connects). Offline, it falls back to
  // the most-recently-synced owner so saved data still shows. resolveOwner() (async)
  // is called by middleware before each CRM request to keep the cache current.
  function metaOwner(): { id: number; title: string } {
    const m = queryAll('SELECT ownerId AS id, ownerTitle AS title FROM crm_sync_meta ORDER BY lastSyncAt DESC LIMIT 1')[0] as any;
    return (m && m.id) ? { id: m.id, title: m.title || '' } : { id: 0, title: '' };
  }
  // The owner for THIS request's session (set by resolveOwner middleware); falls
  // back to the most-recently-synced owner for background tasks / offline reads.
  function activeOwner(): { id: number; title: string } { return reqCtx.getStore()?.owner || metaOwner(); }
  const ownerId = () => activeOwner().id;

  function setActiveOwner(o: { id: number; title: string }) {
    const store = reqCtx.getStore(); if (store) store.owner = o;
    const sid = currentSid(); const sess = sid ? SESSIONS.get(sid) : null;
    if (sess && sid) { sess.ownerId = o.id; sess.ownerTitle = o.title; const ck = getSpCookies(); sess.hash = ck ? hashStr(ck.fed) : ''; persistSession(sid); }
  }

  // Resolve this session's owner from its connected JOE cookies (any Eaton user).
  // Cached per session by cookie hash → only hits SharePoint when cookies change.
  async function resolveOwner(): Promise<{ id: number; title: string }> {
    const store = reqCtx.getStore();
    const cookies = store?.cookies || null;
    if (!cookies) { const o = metaOwner(); if (store) store.owner = o; return o; }
    const sid = store!.sid;
    const h = hashStr(cookies.fed);
    const sess = SESSIONS.get(sid);
    if (sess && sess.ownerId && sess.hash === h) {
      const o = { id: sess.ownerId, title: sess.ownerTitle || '' }; store!.owner = o; return o;
    }
    const who = await spCurrentUser(`FedAuth=${cookies.fed}; rtFa=${cookies.rt}`, loadPyCfg());
    const o = who || metaOwner();
    if (who && sess) { sess.ownerId = who.id; sess.ownerTitle = who.title; sess.hash = h; persistSession(sid); }
    if (store) store.owner = o;
    return o;
  }

  function stateMap(oid: number): Map<string, any> {
    return new Map(queryAll('SELECT sfId AS k, state FROM crm_quote_state WHERE ownerId = ?', [oid]).map((r: any) => [String(r.k), r.state]));
  }

  function crmSynced(oid = ownerId()): boolean {
    return (queryAll('SELECT COUNT(*) AS n FROM crm_quote WHERE ownerId = ?', [oid])[0] as any).n > 0;
  }

  // Build a quote object from a crm_quote row.
  function snapshotQuote(r: any, states: Map<string, any>): any {
    const acct = r.account || cleanQuoteName(r.quoteName || r.customer || r.title || '');
    const key = String(r.sfId || r.title || r.id);
    return {
      id: r.id, key, ref: r.sfId || '', name: acct, accountKey: String(acct).toLowerCase(),
      timestamp: r.arrivedOn || '', sfId: r.sfId || null, product: r.division || null,
      price: r.price ?? null, salesman: r.salesman ?? null, status: r.status || null,
      customer: r.customer || null, runs: 1, state: states.get(key) || 'open',
    };
  }

  // Index every snapshot quote (for one owner) by its lowercased account name —
  // built ONCE per request so the grid is O(quotes), not O(accounts × quotes).
  function buildSnapshotIndex(oid = ownerId()): Map<string, any[]> {
    const rows = queryAll('SELECT * FROM crm_quote WHERE ownerId = ?', [oid]);
    const states = stateMap(oid);
    const idx = new Map<string, any[]>();
    for (const r of rows as any[]) {
      const q = snapshotQuote(r, states);
      const arr = idx.get(q.accountKey);
      if (arr) arr.push(q); else idx.set(q.accountKey, [q]);
    }
    return idx;
  }

  // Quotes for an account from the snapshot. With an index → exact account match
  // (fast, for the grid). Without → partial match too (for a single open card).
  function quotesFromSnapshot(aliases: string[], oid: number, index?: Map<string, any[]>): any[] {
    const out: any[] = [];
    if (index) {
      for (const a of aliases) { const hit = index.get(a.toLowerCase()); if (hit) out.push(...hit); }
    } else {
      const rows = queryAll('SELECT * FROM crm_quote WHERE ownerId = ?', [oid]);
      const states = stateMap(oid);
      for (const r of rows as any[]) {
        const acct = r.account || cleanQuoteName(r.quoteName || r.customer || r.title || '');
        if (aliases.some(a => nameMatches(acct, a))) out.push(snapshotQuote(r, states));
      }
    }
    return out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  }

  // Distinct quotes for an account. Uses the synced SharePoint snapshot when it
  // exists (full data: price + salesman); else falls back to local job names.
  // Pass `index` (from buildSnapshotIndex) for fast grid rollups.
  function quotesForCompany(companyId: number, index?: Map<string, any[]>): any[] {
    const oid = ownerId();
    const aliases = crmAliases(companyId).map(cleanQuoteName).filter(Boolean);
    if (!aliases.length) return [];
    if (index || crmSynced(oid)) return quotesFromSnapshot(aliases, oid, index);
    const rows = queryAll(
      `SELECT id, timestamp, sfId, status, product, price, salesman, customer, step, note
         FROM jobs WHERE customer IS NOT NULL AND TRIM(customer) <> '' ORDER BY id DESC`);
    const states = stateMap(oid);
    const byQuote = new Map<string, any>();
    for (const r of rows as any[]) {
      const clean = cleanQuoteName(r.customer);
      if (!aliases.some(a => nameMatches(clean, a))) continue;
      const key = String(r.sfId || r.customer); // distinct quote identity (state key)
      const prev = byQuote.get(key);
      if (!prev) {
        byQuote.set(key, {
          id: r.id, key, ref: r.sfId || quoteRef(r.customer) || '', name: clean,
          timestamp: r.timestamp, sfId: r.sfId, product: r.product,
          price: r.price ?? null, salesman: r.salesman ?? null,
          runs: 1, state: states.get(key) || 'open',
        });
      } else {
        prev.runs++;
        if (prev.price == null && r.price != null) prev.price = r.price;
        if (!prev.salesman && r.salesman) prev.salesman = r.salesman;
        if (!prev.product && r.product) prev.product = r.product;
      }
    }
    return [...byQuote.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  }

  // Enrich quote rows with PRICE + salesman + status from the SharePoint
  // Quotations List (the jobs table never stored them). Matches by Salesforce ID
  // or normalised name, and appends list quotes not seen in local jobs.
  async function enrichFromSp(quotes: any[], aliases: string[], cookieStr: string, cfg: Record<string, string>): Promise<any[]> {
    const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const priceOf = spPrice;
    const salesmanOf = spSalesman;

    // Prefer the search index (returns people fields as strings); fall back to the
    // list REST when search yields nothing.
    const pool = new Map<string, any>();
    for (const a of aliases.slice(0, 5)) {
      for (const it of await spSearchQuotes(a, cookieStr, cfg)) { const k = String(it.Id); if (!pool.has(k)) pool.set(k, it); }
    }
    if (pool.size === 0) {
      for (const a of aliases.slice(0, 5)) {
        try { for (const it of await quotationsListSearch(a, cookieStr, cfg)) { const k = String(it.Id); if (!pool.has(k)) pool.set(k, it); } }
        catch { /* ignore */ }
      }
    }
    const items = [...pool.values()];
    const states = new Map(queryAll('SELECT sfId AS k, state FROM crm_quote_state').map((r: any) => [String(r.k), r.state]));
    const used = new Set<string>();
    const itemName = (it: any) => norm(it.QUOTATION_x0020_NAME || it.CUSTOMER || it.Title);

    for (const q of quotes) {
      const qn = norm(q.name), qr = norm(q.ref);
      const match = items.find(it => !used.has(String(it.Id)) && (
        (qr && it.SALESFORCEID && norm(it.SALESFORCEID).includes(qr)) ||
        (qn && itemName(it) && (itemName(it).includes(qn) || qn.includes(itemName(it))))
      ));
      if (match) {
        used.add(String(match.Id));
        q.price    = priceOf(match);
        q.salesman = salesmanOf(match) || q.salesman || null;
        q.sfId     = match.SALESFORCEID || q.sfId;
        q.status   = match.STATUS || null;
        q.customer = match.CUSTOMER || null;
        q.product  = match.DIVISION || q.product || null;
      }
    }
    // List quotes for this account that have no local job row.
    let synth = -1000;
    for (const it of items) {
      if (used.has(String(it.Id))) continue;
      const itn = itemName(it);
      if (!aliases.some(a => { const an = norm(a); return an && itn && (itn.includes(an) || an.includes(itn)); })) continue;
      const key = String(it.SALESFORCEID || it.Id);
      quotes.push({
        id: synth--, key, ref: it.SALESFORCEID || '', name: it.QUOTATION_x0020_NAME || it.CUSTOMER || it.Title || '',
        timestamp: it.ARRIVED_x0020_ON || '', sfId: it.SALESFORCEID || null, product: it.DIVISION || null,
        price: priceOf(it), salesman: salesmanOf(it), status: it.STATUS || null,
        customer: it.CUSTOMER || null, runs: 1, state: states.get(key) || 'open',
      });
    }
    return quotes.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  }

  // All raw job rows whose cleaned customer matches the account — to brief the AI.
  function jobsForCompany(companyId: number): any[] {
    const aliases = crmAliases(companyId).map(cleanQuoteName).filter(Boolean);
    if (!aliases.length) return [];
    const rows = queryAll(
      `SELECT timestamp, step, status, product, price, salesman, sfId, note, customer
         FROM jobs WHERE customer IS NOT NULL ORDER BY id DESC LIMIT 1000`);
    return (rows as any[]).filter(r => {
      const clean = cleanQuoteName(r.customer);
      return aliases.some(a => nameMatches(clean, a));
    }).slice(0, 400);
  }

  // Resolve an account from a free-text name (for chat commands). Exact alias/name
  // beats prefix beats substring. Returns the company row or null.
  function resolveCompany(qRaw: string): any | null {
    const q = String(qRaw || '').trim().toLowerCase();
    if (!q) return null;
    const companies = queryAll('SELECT * FROM crm_company WHERE ownerId = ?', [ownerId()]);
    let best: any = null, bestScore = 0;
    for (const c of companies as any[]) {
      const ns = [String(c.name), ...crmAliases(c.id)].map(s => s.toLowerCase());
      let score = 0;
      for (const n of ns) {
        // Fuzzy tiers need enough characters on BOTH sides to mean anything —
        // a 1-2 char account name otherwise matched every query that contained
        // that letter (see nameMatches, which already guards the same way).
        const fuzzy = n.length >= 4 && q.length >= 3;
        if (n === q) score = Math.max(score, 3);
        else if (fuzzy && (n.startsWith(q) || q.startsWith(n))) score = Math.max(score, 2);
        else if (fuzzy && (n.includes(q) || q.includes(n))) score = Math.max(score, 1);
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // Pure card builder — all inputs precomputed once by the caller (no per-card
  // queries), so the grid scales.
  function cardFrom(c: any, aliases: string[], quotes: any[], manualContacts: number): any {
    const open = quotes.filter(q => q.state === 'open');
    const salesmen = [...new Set(quotes.map(q => q.salesman).filter(Boolean))];
    return {
      ...c, aliases, aliasCount: aliases.length,
      // Salesmen become auto-contacts in the card, so count them too.
      contactCount: manualContacts + salesmen.length,
      quoteCount:  quotes.length,
      openCount:   open.length,
      totalValue:  quotes.reduce((s, q) => s + (q.price || 0), 0),
      openValue:   open.reduce((s, q) => s + (q.price || 0), 0),
      salesmen,
      lastQuote:   quotes[0]?.timestamp || null,
    };
  }

  // Seed one account per cleaned name, from the synced snapshot when present
  // (covers ALL quotes), otherwise from local job customer strings.
  function seedAccounts(oid = ownerId()) {
    const now = new Date().toISOString();
    let dirty = false;
    // One-time cleanup: drop pre-clean auto-seeded cards (raw titles) never enriched.
    const stale = queryAll(
      `SELECT c.id, c.name FROM crm_company c
        WHERE c.ownerId = ?
          AND NOT EXISTS (SELECT 1 FROM crm_contact ct WHERE ct.companyId = c.id)
          AND NOT EXISTS (SELECT 1 FROM crm_fact   f  WHERE f.companyId  = c.id)`, [oid]);
    for (const s of stale as any[]) {
      if (cleanQuoteName(s.name) !== s.name) {
        db.run('DELETE FROM crm_alias WHERE companyId = ?', [s.id]);
        db.run('DELETE FROM crm_company WHERE id = ?', [s.id]);
        dirty = true;
      }
    }
    const names = crmSynced(oid)
      ? queryAll(`SELECT DISTINCT account AS c FROM crm_quote WHERE ownerId = ? AND account IS NOT NULL AND TRIM(account) <> ''`, [oid]).map((r: any) => r.c)
      : queryAll(`SELECT DISTINCT customer AS c FROM jobs WHERE customer IS NOT NULL AND TRIM(customer) <> ''`).map((r: any) => cleanQuoteName(r.c));
    const claimed = new Set(queryAll(
      `SELECT a.name FROM crm_alias a JOIN crm_company c ON c.id = a.companyId WHERE c.ownerId = ?`, [oid])
      .map((r: any) => String(r.name).toLowerCase()));
    for (const clean of names) {
      if (clean && !claimed.has(clean.toLowerCase())) {
        db.run('INSERT INTO crm_company (ownerId, name, createdAt, updatedAt) VALUES (?,?,?,?)', [oid, clean, now, now]);
        const cid = (queryAll('SELECT last_insert_rowid() AS id')[0] as any).id;
        db.run('INSERT INTO crm_alias (companyId, name) VALUES (?,?)', [cid, clean]);
        claimed.add(clean.toLowerCase());
        dirty = true;
      }
    }
    if (dirty) saveDb(); // one file write instead of one per row
  }

  // Bind every CRM request to the connected JOE user (any Eaton user). Re-resolves
  // only when the cookies change, so it's a no-op cost on the steady path.
  app.use('/api/crm', async (_req, _res, next) => {
    try { await resolveOwner(); } catch { /* keep last-known owner */ }
    next();
  });

  // GET /api/crm/companies — auto-seed and return cards (with rollups). All the
  // shared data (snapshot index, aliases, contact counts) is built ONCE so the
  // endpoint is O(quotes + accounts), never O(accounts × quotes).
  app.get('/api/crm/companies', (_req, res) => {
    const oid = ownerId();
    seedAccounts(oid);
    const companies = queryAll('SELECT * FROM crm_company WHERE ownerId = ? ORDER BY name COLLATE NOCASE', [oid]);
    const index = crmSynced(oid) ? buildSnapshotIndex(oid) : undefined;

    const aliasMap = new Map<number, string[]>();
    for (const r of queryAll('SELECT a.companyId, a.name FROM crm_alias a JOIN crm_company c ON c.id = a.companyId WHERE c.ownerId = ?', [oid]) as any[]) {
      const arr = aliasMap.get(r.companyId); if (arr) arr.push(r.name); else aliasMap.set(r.companyId, [r.name]);
    }
    const contactMap = new Map<number, number>();
    for (const r of queryAll('SELECT ct.companyId, COUNT(*) AS n FROM crm_contact ct JOIN crm_company c ON c.id = ct.companyId WHERE c.ownerId = ? GROUP BY ct.companyId', [oid]) as any[]) {
      contactMap.set(r.companyId, r.n);
    }

    const cards = (companies as any[]).map(c => {
      const aliases = aliasMap.get(c.id) || [];
      const cleaned = aliases.map(cleanQuoteName).filter(Boolean);
      const quotes = index
        ? quotesFromSnapshot(cleaned, oid, index)
        : quotesForCompany(c.id); // job-name fallback (small, only before first sync)
      return cardFrom(c, aliases, quotes, contactMap.get(c.id) || 0);
    });
    res.json(cards);
  });

  // ── Background CRM sync (non-blocking, cancellable, with live progress) ──────
  type SyncPhase = 'idle' | 'scanning' | 'saving' | 'seeding' | 'done' | 'canceled' | 'error';
  const crmSync = {
    running: false, phase: 'idle' as SyncPhase, message: '', mode: 'full' as 'full' | 'incremental',
    pages: 0, fetched: 0, kept: 0, total: null as number | null,
    accounts: 0, owner: null as string | null, error: null as string | null,
    startedAt: null as string | null, finishedAt: null as string | null, cancel: false,
  };
  const csvPath = path.join(__dirname, 'crm_quotations.csv');

  function syncStatusPayload() {
    const oid = ownerId();
    const meta = queryAll('SELECT lastSyncAt, lastFullSync, count FROM crm_sync_meta WHERE ownerId = ?', [oid])[0] as any;
    const count = (queryAll('SELECT COUNT(*) AS n FROM crm_quote WHERE ownerId = ?', [oid])[0] as any).n;
    const pct = crmSync.total ? Math.min(99, Math.round((crmSync.fetched / crmSync.total) * 100)) : null;
    return { ...crmSync, pct, snapshotCount: count, lastSyncedAt: meta?.lastSyncAt || null, csvExists: existsSync(csvPath) };
  }

  // Regenerate the CSV export from a user's snapshot rows.
  function writeOwnerCsv(oid: number) {
    const cols = ['sfId', 'account', 'quoteName', 'customer', 'salesman', 'price', 'status', 'division', 'country', 'arrivedOn', 'title'];
    const esc  = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = queryAll(`SELECT ${cols.join(',')} FROM crm_quote WHERE ownerId = ? ORDER BY arrivedOn DESC`, [oid]);
    const lines = (rows as any[]).map(r => cols.map(c => esc(r[c])).join(','));
    try { writeFileSync(csvPath, [cols.join(','), ...lines].join('\r\n'), 'utf8'); } catch { /* non-fatal */ }
  }

  async function runCrmSync(cookieStr: string, cfg: Record<string, string>, owner: { id: number; title: string }) {
    setActiveOwner(owner);
    const meta = queryAll('SELECT * FROM crm_sync_meta WHERE ownerId = ?', [owner.id])[0] as any;
    const incremental = !!(meta && meta.lastModified && crmSynced(owner.id));
    Object.assign(crmSync, {
      running: true, phase: 'scanning' as SyncPhase, mode: incremental ? 'incremental' : 'full',
      message: incremental ? 'Checking for updates…' : 'Reading list size…',
      pages: 0, fetched: 0, kept: 0, total: null, accounts: 0, owner: owner.title,
      error: null, startedAt: new Date().toISOString(), finishedAt: null, cancel: false,
    });
    try {
      if (!incremental) crmSync.total = await spListItemCount(cookieStr, cfg);
      crmSync.message = incremental ? `Fetching changes for ${owner.title}…` : `Scanning Quotations List for ${owner.title}…`;
      const items = await spScanMyQuotes(cookieStr, cfg, owner.id, {
        since: incremental ? meta.lastModified : undefined,
        onPage: (pages, fetched, kept) => {
          crmSync.pages = pages; crmSync.fetched = fetched; crmSync.kept = kept;
          crmSync.message = incremental
            ? `Checking changes… ${fetched.toLocaleString()} scanned, ${kept.toLocaleString()} yours`
            : `Scanning… ${fetched.toLocaleString()} rows read, ${kept.toLocaleString()} yours`;
        },
        shouldStop: () => crmSync.cancel,
      });

      if (crmSync.cancel) { crmSync.phase = 'canceled'; crmSync.message = 'Stopped — previous data kept.'; return; }

      // Resolve salesman ("Requested From" user-id → name; fall back Inside Sales, creator).
      crmSync.message = 'Resolving salesmen…';
      const userIds = items.flatMap(it => [it[REQ_FROM_ID], it[INSIDE_SALES_ID], it.AuthorId]);
      const users = await spResolveUsers(userIds as number[], cookieStr, cfg);
      const salesmanOf = (it: any) => users.get(it[REQ_FROM_ID]) || users.get(it[INSIDE_SALES_ID]) || users.get(it.AuthorId) || null;

      crmSync.phase = 'saving'; crmSync.message = `Saving ${items.length.toLocaleString()} quotes…`;
      const now = new Date().toISOString();
      const rowFor = (it: any) => {
        const customer = String(it.CUSTOMER || '').trim();
        return {
          sfId: it.SALESFORCEID || null, title: it.Title || null, customer: customer || null,
          quoteName: it.QUOTATION_x0020_NAME || null,
          account: cleanProjectName(it.QUOTATION_x0020_NAME, customer) || null,
          salesman: salesmanOf(it), price: spPrice(it), status: it.STATUS || null,
          division: it.DIVISION || null, country: it.Country || null, arrivedOn: it.ARRIVED_x0020_ON || null,
        };
      };

      if (!incremental) db.run('DELETE FROM crm_quote WHERE ownerId = ?', [owner.id]);
      let maxMod = (meta && meta.lastModified) || '';
      for (const it of items) {
        const r = rowFor(it);
        const spId = Number(it.Id) || null;
        const modified = it.Modified || null;
        if (modified && modified > maxMod) maxMod = modified;
        const existing = spId != null ? queryAll('SELECT id FROM crm_quote WHERE ownerId = ? AND spId = ?', [owner.id, spId])[0] as any : null;
        if (existing) {
          db.run(`UPDATE crm_quote SET sfId=?,title=?,customer=?,quoteName=?,account=?,salesman=?,price=?,status=?,division=?,country=?,arrivedOn=?,modified=?,raw=?,syncedAt=? WHERE id=?`,
            [r.sfId, r.title, r.customer, r.quoteName, r.account, r.salesman, r.price, r.status, r.division, r.country, r.arrivedOn, modified, JSON.stringify(it), now, existing.id]);
        } else {
          db.run(`INSERT INTO crm_quote (ownerId,spId,modified,sfId,title,customer,quoteName,account,salesman,price,status,division,country,arrivedOn,raw,syncedAt)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [owner.id, spId, modified, r.sfId, r.title, r.customer, r.quoteName, r.account, r.salesman, r.price, r.status, r.division, r.country, r.arrivedOn, JSON.stringify(it), now]);
        }
      }
      const count = (queryAll('SELECT COUNT(*) AS n FROM crm_quote WHERE ownerId = ?', [owner.id])[0] as any).n;
      db.run(
        `INSERT INTO crm_sync_meta (ownerId, ownerTitle, lastModified, lastFullSync, lastSyncAt, count)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(ownerId) DO UPDATE SET ownerTitle=excluded.ownerTitle, lastModified=excluded.lastModified,
           lastSyncAt=excluded.lastSyncAt, count=excluded.count`
         + (incremental ? '' : ', lastFullSync=excluded.lastFullSync'),
        [owner.id, owner.title, maxMod || null, now, now, count]);
      saveDb();
      writeOwnerCsv(owner.id);

      crmSync.phase = 'seeding'; crmSync.message = 'Building accounts…';
      const purge = queryAll(
        `SELECT id FROM crm_company c
          WHERE c.ownerId = ?
            AND NOT EXISTS (SELECT 1 FROM crm_contact ct WHERE ct.companyId = c.id)
            AND NOT EXISTS (SELECT 1 FROM crm_fact   f  WHERE f.companyId  = c.id)`, [owner.id]);
      for (const p of purge as any[]) {
        db.run('DELETE FROM crm_alias WHERE companyId = ?', [p.id]);
        db.run('DELETE FROM crm_company WHERE id = ?', [p.id]);
      }
      saveDb();
      seedAccounts(owner.id);
      crmSync.accounts = (queryAll('SELECT COUNT(*) AS n FROM crm_company WHERE ownerId = ?', [owner.id])[0] as any).n;
      crmSync.phase = 'done';
      crmSync.message = `${incremental ? 'Updated' : 'Synced'} ${items.length.toLocaleString()} quote${items.length === 1 ? '' : 's'} → ${crmSync.accounts.toLocaleString()} accounts`;
    } catch (e: any) {
      crmSync.phase = 'error'; crmSync.error = e.message; crmSync.message = 'Failed: ' + e.message;
    } finally {
      crmSync.running = false; crmSync.finishedAt = new Date().toISOString();
    }
  }

  // GET /api/crm/sync/status — live progress + snapshot info.
  app.get('/api/crm/sync/status', (_req, res) => res.json(syncStatusPayload()));

  // POST /api/crm/sync/stop — request cancellation (current data is preserved).
  app.post('/api/crm/sync/stop', (_req, res) => {
    if (crmSync.running) { crmSync.cancel = true; crmSync.message = 'Stopping…'; }
    res.json({ ok: true });
  });

  // POST /api/crm/sync — START a background sync (returns immediately).
  app.post('/api/crm/sync', async (_req, res) => {
    if (crmSync.running) { res.json({ started: false, ...syncStatusPayload() }); return; }
    const cookies = getSpCookies();
    if (!cookies) { res.status(400).json({ error: 'Not connected — click "Connect to JOE" first.' }); return; }
    const cfg = loadPyCfg();
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    const owner = await spCurrentUser(cookieStr, cfg);
    if (!owner) { res.status(400).json({ error: "Couldn't resolve your SharePoint user — reconnect to JOE." }); return; }
    runCrmSync(cookieStr, cfg, owner); // fire-and-forget; progress via /status
    res.json({ started: true, ...syncStatusPayload() });
  });

  // GET /api/crm/quote-search?q= — fast local search across every quote in the
  // snapshot (account, customer, project, salesman, SF id). Returns matched quotes
  // with the owning account id for one-click navigation.
  app.get('/api/crm/quote-search', (req, res) => {
    const oid = ownerId();
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) { res.json({ quotes: [] }); return; }
    const like = `%${q}%`;
    const states = stateMap(oid);
    const rows = queryAll(
      `SELECT id, account, customer, quoteName, salesman, price, status, sfId, arrivedOn FROM crm_quote
        WHERE ownerId = ? AND (lower(account) LIKE ? OR lower(IFNULL(customer,'')) LIKE ? OR lower(IFNULL(quoteName,'')) LIKE ?
           OR lower(IFNULL(salesman,'')) LIKE ? OR lower(IFNULL(sfId,'')) LIKE ?)
        ORDER BY arrivedOn DESC LIMIT 60`,
      [oid, like, like, like, like, like]);
    const comp = new Map(queryAll('SELECT a.name, a.companyId FROM crm_alias a JOIN crm_company c ON c.id = a.companyId WHERE c.ownerId = ?', [oid]).map((r: any) => [String(r.name).toLowerCase(), r.companyId]));
    const quotes = (rows as any[]).map(r => {
      const key = String(r.sfId || r.id);
      return {
        id: r.id, name: cleanProjectName(r.quoteName, r.customer || '') || r.account, account: r.account,
        companyId: comp.get(String(r.account).toLowerCase()) ?? null,
        salesman: r.salesman || null, price: r.price ?? null, status: r.status || null,
        ref: r.sfId || '', timestamp: r.arrivedOn || '', state: states.get(key) || 'open',
      };
    });
    res.json({ quotes });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Mailbox CRM: the quotes visible from this desk, wherever they sit ──────
  // ══════════════════════════════════════════════════════════════════════════
  // The Accounts tab is fed by the SharePoint Quotations List, which only ever
  // holds what was pushed to it. This second source sweeps every Outlook folder
  // (personal box + the shared quote-factory box, "Completed by …" folders and
  // all) and indexes the quote references it finds, split into the work this desk
  // issued and the work the rest of the team issued.
  const mailScan = {
    running: false,
    phase: 'idle' as 'idle' | 'scanning' | 'matching' | 'done' | 'error',
    message: '', error: null as string | null,
    days: 90, scanned: 0, found: 0, mine: 0, team: 0,
    startedAt: null as string | null, finishedAt: null as string | null,
  };

  // A mail subject reduced to something that can be matched against an account
  // name: reply/forward marks, [EXTERNAL] banners and the reference itself are
  // all noise.
  function mailAccountGuess(subject: string, ref: string): string {
    let s = String(subject || '')
      .replace(/\bhttps?:\/\/\S+/gi, ' ')                  // Salesforce links etc.
      .replace(/^\s*(?:(?:re|fw|fwd|tr|aw|wg)\s*:\s*)+/i, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    for (const r of [ref, normalizeSfid(ref)].filter(Boolean)) {
      s = s.replace(new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    }
    s = s.replace(/\b(?:00[A-Za-z0-9]{6,})\b/g, ' ')       // leftover short SF ids
         .replace(/\s*[-–|]\s*$/, '').replace(/^\s*[-–|]\s*/, '')
         .replace(/\s+/g, ' ').trim();
    const guess = cleanQuoteName(s).slice(0, 90);
    // A subject is only sometimes a project name. Anything that reads like a
    // sentence, a URL or a scrap is worse than showing nothing at all.
    if (guess.length < 4) return '';
    if (!/[A-Za-z]{3}/.test(guess)) return '';
    if (/[/\\]{2}|www\./i.test(guess)) return '';
    if (guess.split(/\s+/).length > 10) return '';
    return guess;
  }

  // Tie a mailbox quote to an account: first through the SharePoint snapshot
  // (the reference is the reliable join), then by name against the aliases an
  // account already claims.
  function matchMailQuote(row: { kind: string; qkey: string; ref: string; subject: string }, oid: number) {
    const aliasRows = queryAll(
      'SELECT a.name AS name, a.companyId AS companyId FROM crm_alias a JOIN crm_company c ON c.id = a.companyId WHERE c.ownerId = ?',
      [oid]) as any[];
    const aliases = new Map(aliasRows.map(r => [String(r.name).toLowerCase(), r.companyId as number]));

    let snap: any = null;
    if (row.kind === 'sfid') {
      const norm = normalizeSfid(row.qkey).toLowerCase();
      snap = queryAll(
        `SELECT account, customer, quoteName FROM crm_quote
          WHERE ownerId = ? AND lower(IFNULL(sfId,'')) IN (?, ?) LIMIT 1`,
        [oid, norm, row.qkey.toLowerCase()])[0] as any;
    } else {
      snap = queryAll(
        `SELECT account, customer, quoteName FROM crm_quote
          WHERE ownerId = ? AND upper(IFNULL(title,'')) LIKE ? LIMIT 1`,
        [oid, `%${row.qkey.toUpperCase()}%`])[0] as any;
    }
    if (snap) {
      const account = snap.account || cleanQuoteName(snap.quoteName || snap.customer || '');
      if (account) {
        return { companyId: aliases.get(String(account).toLowerCase()) ?? null, account, matchedBy: 'reference' };
      }
    }
    // No snapshot row — this quote never reached the Quotations List, which is
    // exactly the case this feature exists to surface. Fall back to the subject.
    const guess = mailAccountGuess(row.subject, row.ref);
    if (guess) {
      const hit = aliases.get(guess.toLowerCase());
      if (hit) return { companyId: hit, account: guess, matchedBy: 'name' };
      const low = guess.toLowerCase();
      for (const [name, cid] of aliases) {
        if (name.length >= 6 && (low.includes(name) || name.includes(low))) {
          return { companyId: cid, account: guess, matchedBy: 'name' };
        }
      }
    }
    return { companyId: null, account: guess || null, matchedBy: guess ? 'subject' : null };
  }

  async function runMailScan(days: number, oid: number) {
    mailScan.running = true;
    mailScan.phase = 'scanning';
    mailScan.error = null;
    mailScan.days = days;
    mailScan.scanned = mailScan.found = mailScan.mine = mailScan.team = 0;
    mailScan.startedAt = new Date().toISOString();
    mailScan.finishedAt = null;
    mailScan.message = `Reading every mail folder over the last ${days} days…`;
    try {
      // The sweep reports "[scan-crm-quotes] <folder>: <hits>" per folder — turn
      // that into live progress instead of a silent multi-minute spinner.
      let folders = 0, hits = 0;
      const scan = await runOutlookPy(
        ['--action', 'scan-crm-quotes', '--days', String(days), '--backend', 'win32'],
        line => {
          const m = /^\[scan-crm-quotes\]\s+(.*):\s*(\d+)\s*$/.exec(line);
          if (!m) return;
          folders++;
          hits += Number(m[2]) || 0;
          // `found` stays the deduped quote count, set once the sweep returns —
          // the running tally here is per MESSAGE, so it only goes in the message.
          mailScan.message = `Reading ${m[1].split('\\').pop()} — ${hits} quote mail${hits === 1 ? '' : 's'} so far (${folders} folder${folders === 1 ? '' : 's'})`;
        });
      if (scan?.error) throw new Error(scan.error);
      const rows: any[] = scan?.quotes || [];
      mailScan.scanned = Number(scan?.scanned) || 0;
      mailScan.found = rows.length;
      mailScan.phase = 'matching';
      mailScan.message = `Matching ${rows.length} quote${rows.length === 1 ? '' : 's'} to accounts…`;

      const now = new Date().toISOString();
      // A re-scan refreshes what it sees and drops what it no longer sees for the
      // same window, but never touches the user's own side overrides.
      const kept = new Map<string, string>(
        (queryAll('SELECT qkey, override FROM crm_mail_quote WHERE ownerId = ? AND override IS NOT NULL', [oid]) as any[])
          .map(r => [String(r.qkey), String(r.override)]));
      db.run('DELETE FROM crm_mail_quote WHERE ownerId = ?', [oid]);

      for (const q of rows) {
        const m = matchMailQuote({ kind: q.kind, qkey: q.key, ref: q.ref || '', subject: q.subject || '' }, oid);
        const override = kept.get(String(q.key)) ?? null;
        db.run(
          `INSERT INTO crm_mail_quote
             (ownerId,qkey,kind,ref,subject,sender,senderEmail,recipients,firstSeen,lastSeen,
              entryId,folder,store,folders,docs,msgs,side,sideWhy,sideFolder,override,
              companyId,account,matchedBy,scannedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [oid, q.key, q.kind || null, q.ref || null, q.subject || null, q.sender || null,
           q.senderEmail || null, q.to || null, q.first || null, q.last || null,
           q.entryId || null, q.folder || null, q.store || null,
           JSON.stringify(q.folders || []), JSON.stringify(q.docs || []),
           Number(q.msgs) || 0, q.side === 'mine' ? 'mine' : 'team', q.why || null,
           q.sideFolder || q.folder || null, override,
           m.companyId, m.account, m.matchedBy, now]);
        const side = override || (q.side === 'mine' ? 'mine' : 'team');
        if (side === 'mine') mailScan.mine++; else mailScan.team++;
      }
      saveDb();
      mailScan.phase = 'done';
      mailScan.message = `${rows.length} quote${rows.length === 1 ? '' : 's'} found — ${mailScan.mine} yours, ${mailScan.team} the team's`;
    } catch (e: any) {
      mailScan.phase = 'error';
      mailScan.error = e.message;
      mailScan.message = `Scan failed: ${e.message}`;
      console.warn('[crm-mailbox]', e.message);
    } finally {
      mailScan.running = false;
      mailScan.finishedAt = new Date().toISOString();
    }
  }

  function mailScanPayload(oid = ownerId()) {
    const row = queryAll(
      `SELECT COUNT(*) AS n, MAX(scannedAt) AS at,
              SUM(CASE WHEN IFNULL(override, side) = 'mine' THEN 1 ELSE 0 END) AS mine
         FROM crm_mail_quote WHERE ownerId = ?`, [oid])[0] as any;
    const total = Number(row?.n) || 0;
    const mine  = Number(row?.mine) || 0;
    return {
      ...mailScan,
      counts: { total, mine, team: total - mine },
      lastScanAt: row?.at || null,
    };
  }

  // GET /api/crm/mailbox/status — progress + what is already indexed.
  app.get('/api/crm/mailbox/status', (_req, res) => res.json(mailScanPayload()));

  // POST /api/crm/mailbox/scan { days } — start a background sweep.
  app.post('/api/crm/mailbox/scan', (req, res) => {
    if (mailScan.running) { res.json({ started: false, ...mailScanPayload() }); return; }
    const days = Math.min(730, Math.max(1, Number((req.body || {}).days) || 90));
    runMailScan(days, ownerId());          // fire-and-forget; progress via /status
    res.json({ started: true, ...mailScanPayload() });
  });

  // GET /api/crm/mailbox/quotes?side=mine|team|all&q=&limit=
  app.get('/api/crm/mailbox/quotes', (req, res) => {
    const oid  = ownerId();
    const side = String(req.query.side || 'all').toLowerCase();
    const q    = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));

    const where: string[] = ['ownerId = ?'];
    const args: any[] = [oid];
    if (side === 'mine' || side === 'team') { where.push(`IFNULL(override, side) = ?`); args.push(side); }
    if (q.length >= 2) {
      const like = `%${q}%`;
      where.push(`(lower(IFNULL(subject,'')) LIKE ? OR lower(IFNULL(qkey,'')) LIKE ?
                   OR lower(IFNULL(account,'')) LIKE ? OR lower(IFNULL(sender,'')) LIKE ?
                   OR lower(IFNULL(senderEmail,'')) LIKE ? OR lower(IFNULL(folder,'')) LIKE ?)`);
      args.push(like, like, like, like, like, like);
    }
    const rows = queryAll(
      `SELECT * FROM crm_mail_quote WHERE ${where.join(' AND ')} ORDER BY lastSeen DESC LIMIT ?`,
      [...args, limit]) as any[];

    const payload = mailScanPayload(oid);
    res.json({
      quotes: rows.map(mailQuoteOut),
      counts: payload.counts,
      lastScanAt: payload.lastScanAt,
    });
  });

  // POST /api/crm/mailbox/quote/side { qkey, side } — user correction; '' clears
  // it and hands the row back to the scanner's own verdict.
  app.post('/api/crm/mailbox/quote/side', (req, res) => {
    const { qkey, side } = req.body as { qkey?: string; side?: string };
    if (!qkey) { res.status(400).json({ error: 'the request had no quote key' }); return; }
    const want = side === 'mine' || side === 'team' ? side : null;
    db.run('UPDATE crm_mail_quote SET override = ? WHERE ownerId = ? AND qkey = ?', [want, ownerId(), qkey]);
    saveDb();
    const row = queryAll('SELECT * FROM crm_mail_quote WHERE ownerId = ? AND qkey = ?', [ownerId(), qkey])[0] as any;
    if (!row) { res.status(404).json({ error: 'that quote is not in the CRM' }); return; }
    res.json({ ok: true, quote: mailQuoteOut(row), counts: mailScanPayload().counts });
  });

  // Shape a crm_mail_quote row for the UI.
  function mailQuoteOut(r: any) {
    const parse = (s: any, fallback: any) => { try { return JSON.parse(s || ''); } catch { return fallback; } };
    return {
      key: r.qkey, kind: r.kind || 'sfid', ref: r.ref || r.qkey,
      subject: r.subject || '(no subject)',
      account: r.account || null, companyId: r.companyId ?? null, matchedBy: r.matchedBy || null,
      sender: r.sender || '', senderEmail: r.senderEmail || '', recipients: r.recipients || '',
      first: r.firstSeen || '', last: r.lastSeen || '',
      entryId: r.entryId || '', folder: r.folder || '', store: r.store || '',
      folders: parse(r.folders, []) as string[],
      docs: parse(r.docs, []) as Array<{ index: number; name: string; size: number }>,
      msgs: Number(r.msgs) || 0,
      side: (r.override || r.side || 'team') as 'mine' | 'team',
      scannerSide: (r.side || 'team') as 'mine' | 'team',
      overridden: !!r.override,
      why: r.sideWhy || '', whyFolder: r.sideFolder || '',
    };
  }

  // POST /api/crm/rebuild-accounts — re-derive account names from the stored
  // snapshot (no SharePoint re-scan), then rebuild accounts. Used after changing
  // the naming rule.
  app.post('/api/crm/rebuild-accounts', (_req, res) => {
    const oid = ownerId();
    const rows = queryAll('SELECT id, raw, customer, account FROM crm_quote WHERE ownerId = ?', [oid]);
    let updated = 0;
    for (const r of rows as any[]) {
      let it: any = {};
      try { it = JSON.parse(r.raw || '{}'); } catch { /* ignore */ }
      const account = cleanProjectName(it.QUOTATION_x0020_NAME, r.customer || '') || null;
      if (account !== r.account) { db.run('UPDATE crm_quote SET account = ? WHERE id = ?', [account, r.id]); updated++; }
    }
    // Drop auto-seeded accounts (no manual contacts/facts) so they rebuild cleanly.
    const purge = queryAll(
      `SELECT id FROM crm_company c
        WHERE c.ownerId = ?
          AND NOT EXISTS (SELECT 1 FROM crm_contact ct WHERE ct.companyId = c.id)
          AND NOT EXISTS (SELECT 1 FROM crm_fact   f  WHERE f.companyId  = c.id)`, [oid]);
    for (const p of purge as any[]) {
      db.run('DELETE FROM crm_alias WHERE companyId = ?', [p.id]);
      db.run('DELETE FROM crm_company WHERE id = ?', [p.id]);
    }
    saveDb();
    seedAccounts(oid);
    const accounts = (queryAll('SELECT COUNT(*) AS n FROM crm_company WHERE ownerId = ?', [oid])[0] as any).n;
    res.json({ ok: true, updated, accounts });
  });

  // GET /api/crm/company/:id — full card: contacts, facts, live quotes + opps.
  // When connected to JOE, quotes are enriched with price/salesman/status from
  // the SharePoint Quotations List (the local jobs table never stored them).
  app.get('/api/crm/company/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const company = queryAll('SELECT * FROM crm_company WHERE id = ?', [id])[0];
    if (!company) { res.status(404).json({ error: 'that account no longer exists' }); return; }
    const contacts = queryAll('SELECT * FROM crm_contact WHERE companyId = ? ORDER BY id', [id]);
    const facts    = queryAll('SELECT * FROM crm_fact WHERE companyId = ? ORDER BY id DESC', [id]);
    let quotes     = quotesForCompany(id);
    // Synced snapshot already carries price + salesman; only hit SharePoint live
    // when there is no snapshot yet.
    let enriched   = crmSynced();
    const cookies  = getSpCookies();
    if (!enriched && cookies) {
      try {
        quotes = await enrichFromSp(
          quotes, crmAliases(id).map(cleanQuoteName).filter(Boolean),
          `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`, loadPyCfg());
        enriched = true;
      } catch { /* fall back to local-only quotes */ }
    }
    const open = quotes.filter(q => q.state === 'open');

    // The account's contact IS the salesman: derive one auto-contact per distinct
    // salesman on its quotes (email/phone from the roster), unless already added.
    const manualNames = new Set((contacts as any[]).map(c => String(c.name).toLowerCase()));
    const salesNames  = [...new Set(quotes.map(q => q.salesman).filter(Boolean).map((s: string) => s.trim()))];
    let synthId = -1;
    const autoContacts = salesNames
      .filter(sn => !manualNames.has(sn.toLowerCase()))
      .map(sn => {
        const r = matchSalesman(sn);
        return {
          id: synthId--, companyId: id, name: r?.name || sn, role: 'Salesman',
          email: r?.email || null, phone: r?.phone || null, notes: null,
          createdAt: '', auto: true,
        };
      });

    // Anything the mailbox sweep tied to this account — including quotes that
    // never reached the Quotations List, which is the whole point of that sweep.
    const mailQuotes = (queryAll(
      'SELECT * FROM crm_mail_quote WHERE ownerId = ? AND companyId = ? ORDER BY lastSeen DESC LIMIT 60',
      [ownerId(), id]) as any[]).map(mailQuoteOut);

    res.json({
      company: { ...company, aliases: crmAliases(id) },
      contacts: [...autoContacts, ...contacts], facts, quotes, enriched, mailQuotes,
      opp: { count: open.length, value: open.reduce((s, q) => s + (q.price || 0), 0) },
    });
  });

  // POST /api/crm/company — create (no id) or update (with id).
  app.post('/api/crm/company', (req, res) => {
    const { id, name, country, tags, notes } = req.body || {};
    if (!name || !String(name).trim()) { res.status(400).json({ error: 'an account needs a name' }); return; }
    const now = new Date().toISOString();
    if (id) {
      runWrite('UPDATE crm_company SET name=?, country=?, tags=?, notes=?, updatedAt=? WHERE id=?',
        [name, country ?? null, tags ?? null, notes ?? null, now, id]);
      res.json({ id });
    } else {
      const newId = runWrite('INSERT INTO crm_company (ownerId, name, country, tags, notes, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)',
        [ownerId(), name, country ?? null, tags ?? null, notes ?? null, now, now]);
      // Claim its own name as an alias so it matches quotes with that customer.
      runWrite('INSERT INTO crm_alias (companyId, name) VALUES (?,?)', [newId, name]);
      res.json({ id: newId });
    }
  });

  app.delete('/api/crm/company/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    runWrite('DELETE FROM crm_contact WHERE companyId = ?', [id]);
    runWrite('DELETE FROM crm_fact WHERE companyId = ?', [id]);
    runWrite('DELETE FROM crm_alias WHERE companyId = ?', [id]);
    runWrite('DELETE FROM crm_company WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  // POST /api/crm/merge — fold sourceIds into targetId (aliases, contacts, facts).
  app.post('/api/crm/merge', (req, res) => {
    const { targetId, sourceIds } = req.body || {};
    const tid = parseInt(targetId, 10);
    const sids = (Array.isArray(sourceIds) ? sourceIds : []).map((x: any) => parseInt(x, 10)).filter(s => s && s !== tid);
    if (!tid || !sids.length) { res.status(400).json({ error: 'pick a target account and at least one account to merge' }); return; }
    if (!queryAll('SELECT id FROM crm_company WHERE id = ?', [tid])[0]) { res.status(404).json({ error: 'the target account no longer exists' }); return; }
    for (const sid of sids) {
      runWrite('UPDATE crm_alias   SET companyId = ? WHERE companyId = ?', [tid, sid]);
      runWrite('UPDATE crm_contact SET companyId = ? WHERE companyId = ?', [tid, sid]);
      runWrite('UPDATE crm_fact    SET companyId = ? WHERE companyId = ?', [tid, sid]);
      runWrite('DELETE FROM crm_company WHERE id = ?', [sid]);
    }
    runWrite('UPDATE crm_company SET updatedAt = ? WHERE id = ?', [new Date().toISOString(), tid]);
    res.json({ ok: true, merged: sids.length });
  });

  // POST /api/crm/contact — create or update a contact.
  app.post('/api/crm/contact', (req, res) => {
    const { id, companyId, name, role, email, phone, notes } = req.body || {};
    if (!companyId || !name || !String(name).trim()) { res.status(400).json({ error: 'a contact needs a name' }); return; }
    if (id) {
      runWrite('UPDATE crm_contact SET name=?, role=?, email=?, phone=?, notes=? WHERE id=?',
        [name, role ?? null, email ?? null, phone ?? null, notes ?? null, id]);
      res.json({ id });
    } else {
      const newId = runWrite('INSERT INTO crm_contact (companyId, name, role, email, phone, notes, createdAt) VALUES (?,?,?,?,?,?,?)',
        [companyId, name, role ?? null, email ?? null, phone ?? null, notes ?? null, new Date().toISOString()]);
      res.json({ id: newId });
    }
  });

  app.delete('/api/crm/contact/:id', (req, res) => {
    runWrite('DELETE FROM crm_contact WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  });

  // POST /api/crm/fact — add an interesting fact (source 'manual' | 'ai').
  app.post('/api/crm/fact', (req, res) => {
    const { companyId, text, source } = req.body || {};
    if (!companyId || !text || !String(text).trim()) { res.status(400).json({ error: 'a fact needs some text' }); return; }
    const newId = runWrite('INSERT INTO crm_fact (companyId, text, source, createdAt) VALUES (?,?,?,?)',
      [companyId, text, source === 'ai' ? 'ai' : 'manual', new Date().toISOString()]);
    res.json({ id: newId });
  });

  app.delete('/api/crm/fact/:id', (req, res) => {
    runWrite('DELETE FROM crm_fact WHERE id = ?', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  });

  // POST /api/crm/quote-state — mark a quote won/lost (or '' to reopen). The key
  // is the quote's stable identity (Salesforce ID when present, else raw name);
  // stored in crm_quote_state.sfId which is treated as a generic key column.
  app.post('/api/crm/quote-state', (req, res) => {
    const { key, sfId, state } = req.body || {};
    const k = String(key || sfId || '');
    if (!k) { res.status(400).json({ error: 'the request had no quote key' }); return; }
    const oid = ownerId();
    if (state === 'won' || state === 'lost') {
      runWrite('INSERT INTO crm_quote_state (ownerId, sfId, state, updatedAt) VALUES (?,?,?,?) ON CONFLICT(ownerId, sfId) DO UPDATE SET state=excluded.state, updatedAt=excluded.updatedAt',
        [oid, k, state, new Date().toISOString()]);
    } else {
      runWrite('DELETE FROM crm_quote_state WHERE ownerId = ? AND sfId = ?', [oid, k]);
    }
    res.json({ ok: true });
  });

  // Locate a quote's PDF in the local archive. CRM quotes come from the
  // SharePoint snapshot (crm_quote) or local jobs. When THIS machine processed a
  // quote, its PDF lives under base/Archive/<date>/ or the base/PDF Quotes/ queue,
  // with filenames embedding the quote/Salesforce code. Match on normalised tokens.
  function findQuotePdfFile(id: number): string | null {
    const oid  = ownerId();
    const norm = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tokens: string[] = [];
    let exactName: string | null = null;
    const q = queryAll('SELECT title, sfId, quoteName FROM crm_quote WHERE id = ? AND ownerId = ?', [id, oid])[0] as any;
    if (q) {
      if (q.title) { tokens.push(norm(q.title), norm(String(q.title).replace(/-\d+$/, ''))); }
      if (q.sfId)  tokens.push(norm(q.sfId));
    } else {
      const j = queryAll('SELECT pdfName, sfId FROM jobs WHERE id = ?', [id])[0] as any;
      if (j) { if (j.pdfName) exactName = j.pdfName; if (j.sfId) tokens.push(norm(j.sfId)); }
    }
    const keys = tokens.filter(t => t.length >= 6);
    if (!keys.length && !exactName) return null;

    const base  = loadPyCfg().base;
    const isPdf = (f: string) => /\.pdf$/i.test(f);
    const dirs: string[] = [];
    const archDir = path.join(base, 'Archive');
    try { if (existsSync(archDir)) for (const d of readdirSync(archDir)) { const p = path.join(archDir, d); if (statSync(p).isDirectory()) dirs.push(p); } } catch {}
    dirs.push(path.join(base, 'PDF Quotes'));

    let best: { path: string; score: number } | null = null;
    for (const dir of dirs) {
      let files: string[] = [];
      try { if (existsSync(dir)) files = readdirSync(dir).filter(isPdf); } catch { continue; }
      for (const f of files) {
        if (exactName && f === exactName) return path.join(dir, f);
        const nf = norm(f);
        for (const k of keys) if (nf.includes(k) && (!best || k.length > best.score)) best = { path: path.join(dir, f), score: k.length };
      }
    }
    return best?.path ?? null;
  }

  // GET /api/crm/quote/:id/pdf — resolve where to open a quote's PDF.
  // 1) Local archive (quotes processed on this machine). 2) D&Q Store on
  // SharePoint, searched by the quote number / name (most synced JOE quotes were
  // never processed locally — their PDF lives only in the D&Q Store).
  app.get('/api/crm/quote/:id/pdf', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) { res.status(400).json({ error: 'that account id is not valid' }); return; }

    const local = findQuotePdfFile(id);
    if (local) { res.json({ url: `/api/crm/quote/${id}/file`, source: 'local', name: path.basename(local) }); return; }

    // No local copy — try the D&Q Store (needs a live JOE session).
    const q = queryAll('SELECT sfId, title, quoteName, customer FROM crm_quote WHERE id = ? AND ownerId = ?', [id, ownerId()])[0] as any;
    const cookies = getSpCookies();
    if (!cookies) {
      res.status(404).json({ error: 'No local PDF. Click "Connect to JOE" to open it from the D&Q Store.' }); return;
    }
    const cfg = loadPyCfg();
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    // Search by a STRONG identifier only (Salesforce id / quote code: no spaces,
    // has a digit) and accept a hit ONLY if the filename carries that identifier.
    // Searching by project or customer name and taking results[0] is how one
    // unrelated quote ended up attached to hundreds of entries.
    const strong = (v: any) => {
      const s = String(v || '').trim();
      return /^[A-Za-z0-9][A-Za-z0-9-]{5,}$/.test(s) && /\d/.test(s) ? s : '';
    };
    const norm  = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // ONE reference has several forms. The Quotations List stores the 18-char
    // Salesforce id (006QO00000WokMzYAJ); D&Q filenames use the short case form
    // (CR00WokMzYAJ / SR00… / EU00…) — same trailing 8-char core. Quote codes
    // carry a revision suffix ("EU1L0603X6K2-0000") the store may not repeat.
    // Search every form and accept a hit that carries ANY of them, so the long
    // id no longer fails against a file named with the short one.
    const sf    = strong(q?.sfId);
    const code  = strong(q?.title);
    const base  = code.replace(/-\d+$/, '');            // drop the revision suffix
    const core  = sf.length >= 12 ? sf.slice(-8) : '';  // shared by every id form
    const terms = [...new Set([sf, code, base].filter(Boolean))].slice(0, 3);
    const refs  = [...new Set([sf, code, base, core].filter(Boolean))].map(norm);
    if (!terms.length) {
      res.status(404).json({ error: 'No local PDF, and this quote has no Salesforce ID or quote code to look it up with.' });
      return;
    }
    const carries = (r: any) => refs.some(w => norm(r.filename).includes(w));
    try {
      for (const term of terms) {
        const { results } = await dqFullTextSearch(term, false, cookieStr, cfg);
        // Accept in order of evidence: a reference in the PDF's own filename,
        // then in any file's name, then in the indexed document TEXT (works
        // numbers like "QB28479A" live inside the quote, not in the filename).
        // Never accept a hit that carries the reference nowhere.
        const hit = results.find((r: any) => r.ext === 'pdf' && carries(r))
                 || results.find((r: any) => carries(r))
                 || results.find((r: any) => r.ext === 'pdf' && refs.some(w => norm(r.summary).includes(w)));
        if (hit?.url) { res.json({ url: hit.url, source: 'sharepoint', name: hit.filename }); return; }
      }
      res.status(404).json({ error: `No D&Q Store document carries this quote's reference (tried ${terms.join(', ')}).` });
    } catch (e: any) {
      res.status(502).json({ error: 'D&Q Store search failed: ' + e.message });
    }
  });

  // GET /api/crm/quote/:id/file — stream the locally-archived PDF bytes.
  app.get('/api/crm/quote/:id/file', (req, res) => {
    const file = findQuotePdfFile(parseInt(req.params.id, 10));
    if (!file) { res.status(404).json({ error: 'PDF not found on this machine.' }); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('inline', path.basename(file)));
    res.sendFile(file);
  });

  // GET /api/crm/company/:id/insights — AI-generated facts & warnings from the
  // account's full run history (not persisted unless the user pins one).
  const _crmInsightCache = new Map<number, { ts: number; items: any[] }>();
  app.get('/api/crm/company/:id/insights', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const company = queryAll('SELECT * FROM crm_company WHERE id = ?', [id])[0] as any;
    if (!company) { res.status(404).json({ error: 'that account no longer exists' }); return; }
    const ai = getGemini();
    if (!ai) { res.json({ items: [], error: 'No Gemini API key — add gemini_key in Settings' }); return; }

    const cached = _crmInsightCache.get(id);
    if (cached && Date.now() - cached.ts < 5 * 60_000 && !req.query.refresh) {
      res.json({ items: cached.items, source: 'cache' }); return;
    }

    const jobs   = jobsForCompany(id);
    const quotes = quotesForCompany(id);
    if (!jobs.length) { res.json({ items: [] }); return; }
    const open    = quotes.filter(q => q.state === 'open');
    const won     = quotes.filter(q => q.state === 'won');
    const lost    = quotes.filter(q => q.state === 'lost');
    const errs    = jobs.filter(j => j.status === 'err');
    const ctx = [
      `Account: ${company.name}`,
      `Aliases (source quote/customer names): ${crmAliases(id).join(' | ')}`,
      `Total job runs: ${jobs.length} | priced quotes: ${quotes.length} | open: ${open.length} | won: ${won.length} | lost: ${lost.length} | failed runs: ${errs.length}`,
      `Open pipeline value: £${open.reduce((s, q) => s + (q.price || 0), 0).toLocaleString()}`,
      'Quote rows (newest first):',
      ...quotes.slice(0, 40).map((q: any) =>
        `  ${String(q.timestamp).slice(0, 10)} | ${q.ref || '-'} | ${q.name || '-'} | ${q.salesman || '-'} | £${q.price ?? '-'} | ${q.state}${q.runs > 1 ? ` | ${q.runs} runs` : ''}`),
      errs.length ? 'Recent failed runs:' : '',
      ...errs.slice(0, 10).map((j: any) => `  ${String(j.timestamp).slice(0, 10)} | ${j.step} | ${j.note || 'error'}`),
    ].filter(Boolean).join('\n');

    try {
      const r = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text:
          `You are a sales-ops analyst for an Eaton quote engineer. Below is the run history for ONE account `
          + `in his quote-automation tool. Produce a short list of genuinely useful, specific observations: `
          + `interesting facts (patterns, biggest quote, favourite division, most active salesman, cadence) `
          + `and warnings (stale open quotes, repeated extraction failures, high-value quote with no follow-up, lopsided win/loss).\n\n`
          + `Data:\n${ctx}\n\n`
          + `Reply with ONLY a JSON array, no prose, max 6 items, each: {"type":"fact"|"warning","text":"<one concise sentence>"}.\n`
          + `Rules: ground every item ONLY in the data above — never invent numbers, names, or prices. `
          + `If nothing noteworthy, return []. Money in £. Keep each text under 140 chars.`
        }] }],
        config: { maxOutputTokens: 700, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      });
      let items: any[] = [];
      const txt = (r.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      try { const p = JSON.parse(txt); if (Array.isArray(p)) items = p; } catch {}
      items = items
        .filter(i => i && typeof i.text === 'string')
        .map(i => ({ type: i.type === 'warning' ? 'warning' : 'fact', text: String(i.text).slice(0, 200) }))
        .slice(0, 6);
      _crmInsightCache.set(id, { ts: Date.now(), items });
      res.json({ items, source: 'gemini' });
    } catch (e: any) {
      res.json({ items: [], error: 'Gemini error: ' + e.message });
    }
  });

  // GET /api/crm/company/:id/docs — D&Q Store full-text hits for this account's
  // aliases (file name + PDF/email body via the SharePoint index).
  app.get('/api/crm/company/:id/docs', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const company = queryAll('SELECT * FROM crm_company WHERE id = ?', [id])[0] as any;
    if (!company) { res.status(404).json({ error: 'that account no longer exists' }); return; }
    const cookies = getSpCookies();
    if (!cookies) { res.json({ results: [], error: 'Not connected — click "Connect to JOE" first.' }); return; }
    const cfg = loadPyCfg();
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    const mineOnly = req.query.mine !== '0' && req.query.mine !== 'false';
    const aliases = crmAliases(id).slice(0, 6); // cap SP calls
    const seen = new Set<string>();
    const out: any[] = [];
    try {
      for (const alias of aliases) {
        const { results } = await dqFullTextSearch(alias, mineOnly, cookieStr, cfg);
        for (const d of results) {
          if (d.url && !seen.has(d.url)) { seen.add(d.url); out.push(d); }
        }
      }
      res.json({ results: out.slice(0, 50) });
    } catch (e: any) {
      res.json({ results: out, error: e.message });
    }
  });

  // ── Chat assistant → CRM edits ──────────────────────────────────────────────
  // Parses a natural-language instruction into one structured CRM action and
  // executes it. Shared by POST /api/crm/command and the Assistant chat router.
  async function runCrmCommand(query: string): Promise<{ ok: boolean; answer: string; changed?: boolean }> {
    const ai = getGemini();
    if (!ai) return { ok: false, answer: 'No Gemini API key — add gemini_key in Settings.' };
    const accounts = queryAll('SELECT id, name FROM crm_company ORDER BY name COLLATE NOCASE LIMIT 200') as any[];
    const accountList = accounts.map(a => a.name).slice(0, 120).join(' | ');
    let parsed: any = null;
    try {
      const r = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text:
          `Convert the user's instruction into ONE CRM action for an Eaton account manager.\n`
          + `Existing accounts: ${accountList || '(none yet)'}\n\n`
          + `Instruction: "${query.replace(/"/g, "'")}"\n\n`
          + `Reply with ONLY JSON, no prose:\n`
          + `{"op":"add_contact"|"add_fact"|"mark_quote"|"create_account"|"set_note"|"add_tag"|"none",`
          + `"account":"<existing account name this targets, or new name for create_account>",`
          + `"contact":{"name":"","role":"","email":"","phone":"","notes":""},`
          + `"fact":"","sfId":"","state":"won"|"lost"|"open","note":"","tag":""}\n`
          + `Rules: pick the closest existing account name for the "account" field. op="none" if it is not a CRM edit. `
          + `Only fill the fields the chosen op needs.`
        }] }],
        config: { maxOutputTokens: 400, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      });
      parsed = extractObject(r.text ?? '');
    } catch (e: any) {
      return { ok: false, answer: 'Could not parse that command: ' + e.message };
    }
    if (!parsed || parsed.op === 'none' || !parsed.op) {
      return { ok: false, answer: '' }; // signal: not a CRM command
    }

    const op = String(parsed.op);
    // create_account doesn't need an existing match.
    if (op === 'create_account') {
      const name = String(parsed.account || '').trim();
      if (!name) return { ok: false, answer: 'I need a name to create an account.' };
      const now = new Date().toISOString();
      const cid = runWrite('INSERT INTO crm_company (ownerId, name, createdAt, updatedAt) VALUES (?,?,?,?)', [ownerId(), name, now, now]);
      runWrite('INSERT INTO crm_alias (companyId, name) VALUES (?,?)', [cid, name]);
      return { ok: true, changed: true, answer: `Created account "${name}".` };
    }

    const target = resolveCompany(parsed.account || '');
    if (!target) return { ok: false, answer: `I couldn't find an account matching "${parsed.account || ''}". Try the exact card name.` };

    switch (op) {
      case 'add_contact': {
        const c = parsed.contact || {};
        if (!c.name?.trim()) return { ok: false, answer: 'I need at least a contact name.' };
        runWrite('INSERT INTO crm_contact (companyId, name, role, email, phone, notes, createdAt) VALUES (?,?,?,?,?,?,?)',
          [target.id, c.name, c.role || null, c.email || null, c.phone || null, c.notes || null, new Date().toISOString()]);
        return { ok: true, changed: true, answer: `Added contact ${c.name}${c.role ? ` (${c.role})` : ''} to ${target.name}.` };
      }
      case 'add_fact': {
        const t = String(parsed.fact || '').trim();
        if (!t) return { ok: false, answer: 'What fact should I add?' };
        runWrite('INSERT INTO crm_fact (companyId, text, source, createdAt) VALUES (?,?,?,?)',
          [target.id, t, 'manual', new Date().toISOString()]);
        return { ok: true, changed: true, answer: `Noted on ${target.name}: "${t}".` };
      }
      case 'set_note': {
        runWrite('UPDATE crm_company SET notes = ?, updatedAt = ? WHERE id = ?',
          [String(parsed.note || ''), new Date().toISOString(), target.id]);
        return { ok: true, changed: true, answer: `Updated notes on ${target.name}.` };
      }
      case 'add_tag': {
        const tag = String(parsed.tag || '').trim();
        if (!tag) return { ok: false, answer: 'Which tag?' };
        const cur = String(target.tags || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!cur.some(x => x.toLowerCase() === tag.toLowerCase())) cur.push(tag);
        runWrite('UPDATE crm_company SET tags = ?, updatedAt = ? WHERE id = ?', [cur.join(', '), new Date().toISOString(), target.id]);
        return { ok: true, changed: true, answer: `Tagged ${target.name} "${tag}".` };
      }
      case 'mark_quote': {
        const sfId = String(parsed.sfId || '').trim();
        const state = ['won', 'lost', 'open'].includes(parsed.state) ? parsed.state : '';
        if (!sfId || !state) return { ok: false, answer: 'Tell me which Salesforce ID and the state (won/lost/open).' };
        if (state === 'open') runWrite('DELETE FROM crm_quote_state WHERE ownerId = ? AND sfId = ?', [ownerId(), sfId]);
        else runWrite('INSERT INTO crm_quote_state (ownerId, sfId, state, updatedAt) VALUES (?,?,?,?) ON CONFLICT(ownerId, sfId) DO UPDATE SET state=excluded.state, updatedAt=excluded.updatedAt',
          [ownerId(), sfId, state, new Date().toISOString()]);
        return { ok: true, changed: true, answer: `Marked quote ${sfId} as ${state}.` };
      }
      default:
        return { ok: false, answer: '' };
    }
  }

  app.post('/api/crm/command', async (req, res) => {
    const { query } = req.body || {};
    if (!query?.trim()) { res.status(400).json({ error: 'type something to search for' }); return; }
    res.json(await runCrmCommand(query));
  });

  app.get('/api/export/jobs.csv', (_req, res) => {
    const jobs = queryAll('SELECT * FROM jobs ORDER BY id DESC LIMIT 10000') as any[];
    const cols = ['id', 'timestamp', 'step', 'product', 'customer', 'sfId', 'status', 'durationSec', 'items', 'price', 'salesman', 'note'];
    const esc  = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = cols.join(',');
    const rows   = jobs.map(j => cols.map(c => esc(c === 'customer' ? (j.customer || j.pdfName || '') : j[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vector-jobs.csv"');
    res.send([header, ...rows].join('\r\n'));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Analytics (new) ────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  app.get('/api/analytics', (req, res) => {
    const days = Math.max(1, Math.min(365, parseInt(String(req.query.days || '30'), 10) || 30));
    const now = Date.now();
    const cutoff      = new Date(now - days * 86400_000).toISOString();
    const prevCutoff  = new Date(now - 2 * days * 86400_000).toISOString();

    const allRows = queryAll(
      `SELECT * FROM jobs WHERE timestamp >= ? ORDER BY timestamp ASC`,
      [prevCutoff],
    );
    const inRange   = allRows.filter(r => (r.timestamp as string) >= cutoff);
    const inPrev    = allRows.filter(r => (r.timestamp as string) <  cutoff);

    // Enrich rows with parsed product/customer from filename if missing
    const enrich = (r: any) => {
      if (!r.product || !r.customer) {
        const m = parseFilenameMeta(r.pdfName);
        if (!r.product)  r.product  = m.product;
        if (!r.customer) r.customer = m.customer;
      }
      return r;
    };
    inRange.forEach(enrich);
    inPrev.forEach(enrich);

    // ── Totals ────────────────────────────────────────────────────────────
    const sumPrice = (rs: any[]) => rs.reduce((s, j) => s + (Number(j.price) || 0), 0);
    const sumItems = (rs: any[]) => rs.reduce((s, j) => s + (Number(j.items) || 0), 0);
    const sumDur   = (rs: any[]) => rs.reduce((s, j) => s + (Number(j.durationSec) || 0), 0);

    const makeTotals = (rs: any[]) => {
      const ok    = rs.filter(j => j.status === 'ok').length;
      const warn  = rs.filter(j => j.status === 'warn').length;
      const err   = rs.filter(j => j.status === 'err').length;
      const count = rs.length;
      const withDur = rs.filter(j => Number(j.durationSec) > 0);
      return {
        count, ok, warn, err,
        okPct:  count === 0 ? 0 : (ok / count) * 100,
        value:  sumPrice(rs.filter(j => j.status === 'ok')),
        avgDur: withDur.length === 0 ? 0 : sumDur(withDur) / withDur.length,
        items:  sumItems(rs),
      };
    };
    const totals     = makeTotals(inRange);
    const prevTotals = makeTotals(inPrev);

    // ── Daily series ──────────────────────────────────────────────────────
    const daily: Array<{ date: string; label: string; ok: number; warn: number; err: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400_000);
      d.setHours(0, 0, 0, 0);
      daily.push({
        date: d.toISOString(),
        label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        ok: 0, warn: 0, err: 0,
      });
    }
    for (const r of inRange) {
      const t = new Date(r.timestamp as string);
      t.setHours(0, 0, 0, 0);
      const idx = daily.findIndex(d => +new Date(d.date) === +t);
      if (idx >= 0) daily[idx][r.status as 'ok'|'warn'|'err']++;
    }

    // ── By product ────────────────────────────────────────────────────────
    const productAgg = new Map<string, { code: string; label: string; color: string; ok: number; warn: number; err: number; total: number; value: number }>();
    for (const r of inRange) {
      const code = r.product as string | null;
      if (!code) continue;
      if (!productAgg.has(code)) {
        const meta = PRODUCT_META[code] || { label: code, color: '#65656c' };
        productAgg.set(code, { code, label: meta.label, color: meta.color, ok: 0, warn: 0, err: 0, total: 0, value: 0 });
      }
      const agg = productAgg.get(code)!;
      agg[r.status as 'ok'|'warn'|'err']++;
      agg.total++;
      if (r.status === 'ok') agg.value += Number(r.price) || 0;
    }
    const byProduct = [...productAgg.values()].sort((a, b) => b.total - a.total);

    // ── By customer ───────────────────────────────────────────────────────
    const customerAgg = new Map<string, { customer: string; count: number; value: number; err: number }>();
    for (const r of inRange) {
      const c = r.customer as string | null;
      if (!c) continue;
      if (!customerAgg.has(c)) customerAgg.set(c, { customer: c, count: 0, value: 0, err: 0 });
      const a = customerAgg.get(c)!;
      a.count++;
      if (r.status === 'ok') a.value += Number(r.price) || 0;
      if (r.status === 'err') a.err++;
    }
    const byCustomer = [...customerAgg.values()].sort((a, b) => b.value - a.value).slice(0, 12);

    // ── By salesman ───────────────────────────────────────────────────────
    const salesmanAgg = new Map<string, { salesman: string; count: number; value: number; err: number }>();
    for (const r of inRange) {
      const s = r.salesman as string | null;
      if (!s) continue;
      if (!salesmanAgg.has(s)) salesmanAgg.set(s, { salesman: s, count: 0, value: 0, err: 0 });
      const a = salesmanAgg.get(s)!;
      a.count++;
      if (r.status === 'ok') a.value += Number(r.price) || 0;
      if (r.status === 'err') a.err++;
    }
    const bySalesman = [...salesmanAgg.values()].sort((a, b) => b.value - a.value).slice(0, 10);

    // ── By step ───────────────────────────────────────────────────────────
    const byStep = { 'Step 1': 0, 'Step 2': 0 } as Record<string, number>;
    for (const r of inRange) {
      const s = r.step as string;
      if (s in byStep) byStep[s]++;
    }

    // ── Error reasons ─────────────────────────────────────────────────────
    const errAgg = new Map<string, number>();
    for (const r of inRange) {
      if (r.status === 'err' && r.note) {
        errAgg.set(r.note as string, (errAgg.get(r.note as string) || 0) + 1);
      }
    }
    const errorReasons = [...errAgg.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // ── Activity heatmap (Mon..Sun × hour buckets) ────────────────────────
    const hourBuckets = ['07', '09', '11', '13', '15', '17', '19'];
    const hourInts    = [7, 9, 11, 13, 15, 17, 19];
    const dayLabels   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const grid: number[][] = dayLabels.map(() => hourBuckets.map(() => 0));
    for (const r of inRange) {
      const d = new Date(r.timestamp as string);
      const dow = (d.getDay() + 6) % 7; // Mon=0
      const h = d.getHours();
      let hi = -1;
      for (let i = 0; i < hourInts.length; i++) {
        if (h >= hourInts[i] - 1 && h <= hourInts[i] + 1) { hi = i; break; }
      }
      if (hi >= 0) grid[dow][hi]++;
    }
    const heatmap = { grid, hours: hourBuckets, days: dayLabels, max: Math.max(1, ...grid.flat()) };

    res.json({
      range: {
        days,
        from: cutoff,
        to:   new Date().toISOString(),
      },
      totals, prevTotals,
      daily, byProduct, byCustomer, bySalesman, byStep, errorReasons, heatmap,
    });
  });

  // ── Config ─────────────────────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    const { gemini_key, ...safe } = loadPyCfg() as any;
    res.json({ ...safe, gemini_key_set: !!gemini_key });
  });
  app.post('/api/config', (req, res) => {
    try {
      const current  = loadPyCfg() as any;
      const body     = (req.body || {}) as Record<string, unknown>;
      // Take only the keys the app owns; anything else the caller sent is dropped
      // rather than merged into the saved file.
      const incoming: Record<string, unknown> = {};
      for (const k of CONFIG_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) incoming[k] = body[k];
      }
      // The key is stored encrypted (AES-256-GCM, the same envelope as the JOE
      // cookies), so compare plaintext to plaintext — ciphertext carries a random
      // IV and would look changed on every save.
      const beforeKey = readSecret(String(current.gemini_key || ''));
      const sentKey   = String(incoming.gemini_key || '').trim();
      const nextKey   = sentKey || beforeKey;   // blank from the client = keep what's stored
      incoming.gemini_key = nextKey ? encSecret(nextKey) : '';

      const nextCfg = { ...current, ...incoming };
      writeFileAtomic(APP_CFG_PATH, JSON.stringify(nextCfg, null, 2));
      if (nextKey !== beforeKey) {
        _gemini = null;
        _geminiKey = '';
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── AI models: what this key actually exposes ──────────────────────────────
  // Powers the Settings "AI model" dropdown. Asks Google's ListModels with the
  // configured key and returns only chat-capable models (generateContent), so the
  // list is authoritative for THIS key — no guessing which gemini-3.x ids exist.
  app.get('/api/ai-models', async (_req, res) => {
    const key = geminiKey();
    if (!key) { res.json({ models: [], current: smartModel(), fallback: AI_MODEL_FALLBACK, error: 'No Gemini API key — save your key above first.' }); return; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`);
      const j: any = await r.json();
      if (j?.error) { res.json({ models: [], current: smartModel(), fallback: AI_MODEL_FALLBACK, error: j.error.message }); return; }
      const models = (j?.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || String(m.name).replace(/^models\//, '') }))
        .filter((m: any) => !/embedding|aqa|imagen|veo|tts|image-generation/i.test(m.id));
      res.json({ models, current: smartModel(), fallback: AI_MODEL_FALLBACK });
    } catch (e: any) {
      res.json({ models: [], current: smartModel(), fallback: AI_MODEL_FALLBACK, error: e.message });
    }
  });

  // ── Session ────────────────────────────────────────────────────────────────
  app.get('/api/session', (_req, res) => {
    res.json({ startedAt: sessionStartedAt });
  });

  // ── EL price list version ──────────────────────────────────────────────────
  // `changed` is the point of this: it means the workbook on disk is a different
  // issue from the one this desk last acknowledged, so anything quoted before
  // now was priced on the older sheet.
  app.get('/api/pricelist/version', async (req, res) => {
    const v    = await pricelistVersion(req.query.force === '1');
    const seen = seenPricelistFingerprint();
    res.json({
      ...v,
      seenFingerprint: seen,
      // First run has nothing to compare against — that is not a change.
      changed: !!(seen && v.fingerprint && seen !== v.fingerprint),
      acknowledged: !!seen && seen === v.fingerprint,
    });
  });

  // Record that the current sheet is the one being worked to.
  app.post('/api/pricelist/acknowledge', async (_req, res) => {
    const v = await pricelistVersion(true);
    if (!v.fingerprint) { res.status(400).json({ ok: false, error: v.error || 'price list not readable' }); return; }
    ackPricelistFingerprint(v.fingerprint);
    res.json({ ok: true, fingerprint: v.fingerprint, label: v.label });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── D&Q filing: audit sent quotes, then file the approved ones ────────────
  // ══════════════════════════════════════════════════════════════════════════
  // The audit has been read-only since it was written, and it reported that only
  // ~26% of sent quotes are filed correctly. Closing that gap means writing to a
  // store the whole team shares, so the write path here is deliberately gated:
  //
  //   * the audit proposes, a person disposes — /file acts ONLY on ids passed in
  //   * a dry run is available and the UI runs it before offering to write
  //   * the writer re-checks each destination immediately before uploading
  //   * every batch is logged to the jobs table, filed or not
  //
  // There is no "fix everything" call, by design.
  const DQ_DIR = path.join(DATA_DIR, 'dq');
  const dqAuditPath  = () => path.join(DQ_DIR, 'audit.json');

  // Mirrors FILEABLE in dq_backfill_file.py. Any other verdict either needs no
  // action (MATCH) or needs a human decision the script must not make
  // (DIFFERENT_COPY: something carrying that reference is already filed).
  const DQ_FILEABLE = new Set(['MISSING_FOLDER', 'MISSING_REVISION', 'MISSING_FILE']);

  type DqAuditState = {
    running: boolean; phase: 'idle' | 'scanning' | 'done' | 'error';
    message: string; startedAt: string; finishedAt: string; error: string;
    months: number; lines: string[];
  };
  const dqAudit: DqAuditState = {
    running: false, phase: 'idle', message: '', startedAt: '', finishedAt: '',
    error: '', months: 3, lines: [],
  };

  function dqAuditSummary() {
    // The stored audit is the source of truth for the review list; the state
    // object only describes the run that produced it.
    let generatedAt = '', tally: Record<string, number> = {}, rows = 0;
    try {
      const a = JSON.parse(readFileSync(dqAuditPath(), 'utf8'));
      generatedAt = a.generatedAt || '';
      tally = a.tally || {};
      rows = (a.rows || []).length;
    } catch { /* no audit yet */ }
    return { ...dqAudit, lines: dqAudit.lines.slice(-40), generatedAt, tally, rows };
  }

  app.get('/api/dq/audit/status', (_req, res) => res.json(dqAuditSummary()));

  app.post('/api/dq/audit', (req, res) => {
    if (dqAudit.running) { res.json({ started: false, ...dqAuditSummary() }); return; }
    const months = Math.min(24, Math.max(0.5, Number((req.body ?? {}).months) || 3));
    const script = pyFile('dq_backfill_audit.py');
    if (!existsSync(script)) { res.status(500).json({ started: false, error: 'dq_backfill_audit.py not found' }); return; }

    try { mkdirSync(DQ_DIR, { recursive: true }); } catch {}
    Object.assign(dqAudit, {
      running: true, phase: 'scanning', message: 'Scanning Sent Items…',
      startedAt: new Date().toISOString(), finishedAt: '', error: '', months, lines: [],
    });

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base,
      '--months', String(months),
      '--out',  path.join(DQ_DIR, 'audit.csv'),
      '--json', dqAuditPath(),
    ], { cwd: PY_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

    // The audit walks months of Sent Items and indexes the whole store, so it
    // runs for minutes. Its stdout is the only progress a caller can see.
    let tail = '';
    const onText = (b: Buffer) => {
      tail += b.toString();
      const parts = tail.split(/\r?\n/);
      tail = parts.pop() || '';
      for (const l of parts) {
        const line = l.trim();
        if (!line) continue;
        dqAudit.lines.push(line);
        if (dqAudit.lines.length > 400) dqAudit.lines.shift();
        if (/^\[\*\]|^\s*\[\d+\/\d+\]/.test(line)) dqAudit.message = line.slice(0, 160);
      }
    };
    proc.stdout.on('data', onText);
    proc.stderr.on('data', onText);

    proc.on('error', (e: Error) => {
      Object.assign(dqAudit, { running: false, phase: 'error', error: e.message, message: 'Failed: ' + e.message, finishedAt: new Date().toISOString() });
    });
    proc.on('close', (code: number) => {
      const ok = code === 0 && existsSync(dqAuditPath());
      Object.assign(dqAudit, {
        running: false,
        phase: ok ? 'done' : 'error',
        error: ok ? '' : (dqAudit.lines.slice(-3).join(' ') || `exit ${code}`),
        message: ok ? 'Audit complete' : 'The audit did not finish',
        finishedAt: new Date().toISOString(),
      });
    });

    res.json({ started: true, ...dqAuditSummary() });
  });

  // The review list. Rows are returned without the local file path — that stays
  // server-side; the browser has no use for it and it is not its business.
  app.get('/api/dq/audit/result', (req, res) => {
    const verdict = String(req.query.verdict || '').trim().toUpperCase();
    try {
      const a = JSON.parse(readFileSync(dqAuditPath(), 'utf8'));
      let rows = (a.rows || []) as any[];
      if (verdict) rows = rows.filter(r => String(r.verdict).toUpperCase() === verdict);
      res.json({
        generatedAt: a.generatedAt || '', months: a.months ?? null,
        tally: a.tally || {}, total: (a.rows || []).length,
        fileable: (a.rows || []).filter((r: any) => DQ_FILEABLE.has(String(r.verdict))).length,
        rows: rows.map(r => ({
          id: r.id, verdict: r.verdict, sent: r.sent, timesSent: r.times_sent,
          code: r.code, revision: r.revision, sfid: r.sfid, works: r.works,
          folders: r.folder_list || [], folderCount: r.folder_count,
          attachment: r.attachment, subject: r.subject, detail: r.detail,
          messageInFolder: r.message_in_folder,
          // Whether this row is even a candidate for the writer, decided here so
          // the UI cannot offer to file something the writer would refuse.
          fileable: DQ_FILEABLE.has(String(r.verdict)) && !!r.local_path,
        })),
      });
    } catch {
      res.json({ generatedAt: '', tally: {}, total: 0, fileable: 0, rows: [], error: 'no audit has been run yet' });
    }
  });

  // The write. `ids` is mandatory and never defaulted: this endpoint has no
  // concept of "all". `dryRun` reports the plan and touches nothing.
  app.post('/api/dq/file', async (req, res) => {
    const { ids, dryRun } = (req.body ?? {}) as { ids?: number[]; dryRun?: boolean };
    const list = Array.isArray(ids) ? ids.map(Number).filter(n => Number.isFinite(n)) : [];
    if (!list.length) { res.status(400).json({ ok: false, error: 'no rows were approved' }); return; }
    if (!existsSync(dqAuditPath())) { res.status(400).json({ ok: false, error: 'run the audit first' }); return; }

    const script = pyFile('dq_backfill_file.py');
    if (!existsSync(script)) { res.status(500).json({ ok: false, error: 'dq_backfill_file.py not found' }); return; }

    const stamp   = Date.now();
    const jobPath = path.join(DQ_DIR, `file_job_${stamp}.json`);
    const outPath = path.join(DQ_DIR, `file_out_${stamp}.json`);
    try {
      mkdirSync(DQ_DIR, { recursive: true });
      writeFileSync(jobPath, JSON.stringify({ auditPath: dqAuditPath(), ids: list }));
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const args = [...base, '--job', jobPath, '--out', outPath];
    if (dryRun) args.push('--dry-run');

    const proc = spawn(py, args, { cwd: PY_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // Uploading a batch of PDFs to SharePoint over the corporate proxy is slow;
    // give it room but never hang forever.
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 15 * 60 * 1000);

    proc.on('error', (e: Error) => {
      clearTimeout(killer);
      res.status(500).json({ ok: false, error: e.message });
    });
    proc.on('close', () => {
      clearTimeout(killer);
      let out: any = null;
      try { out = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* reported below */ }
      for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} }

      if (!out) {
        res.status(500).json({ ok: false, error: err.trim().slice(-400) || 'the filer returned nothing' });
        return;
      }
      // A real write is worth a row in the job log; a dry run is not.
      if (!out.dryRun) {
        insertJob({
          step: 'D&Q backfill',
          status: out.failed ? 'warn' : 'ok',
          items: out.filed || 0,
          note: `filed ${out.filed}, skipped ${out.skipped}, failed ${out.failed} of ${out.approved} approved`,
        });
      }
      res.json({ ok: true, ...out, log: err.trim().split(/\r?\n/).slice(-60) });
    });
  });

  // ── Customer history ───────────────────────────────────────────────────────
  // "What have we quoted this customer before, at what price, did they buy" —
  // the question asked mid-reply, which otherwise means leaving the app for D&Q
  // or old mail. Everything here is already synced; this only joins it up.
  //
  // Keyed on crm_quote.customer, NOT on crm_company. crm_company holds the
  // PROJECT ("University of Warwick", "Winkworth Arboretum") — 885 of 885 of its
  // names match an `account` value and only 15 match a `customer`. The repeat
  // buyer is the customer column: Rexel, Edmundson, CEF, the wholesalers.
  //
  // Those names arrive spelled many ways — 14 spellings of Edmundson across 48
  // quotes, 6 of Rexel across 45 — so they are folded on a normalised key. Only
  // legal forms and account codes are stripped: industry words are load-bearing
  // ("Park Electrical" and "Park Electrical Distributors" are different firms).
  const CUST_LEGAL = /\b(ltd|limited|plc|llp|llc|inc|incorporated|gmbh|bv|nv|sa|srl)\b\.?/gi;
  function customerKey(s: string): string {
    let v = String(s || '').replace(/\([^)]*\)/g, ' ');   // (P05669) account codes
    v = v.replace(CUST_LEGAL, ' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    v = v.replace(CUST_LEGAL, ' ');
    return v.split(/\s+/).filter(Boolean).join(' ');
  }

  // Free/shared providers say nothing about which company someone buys for.
  const GENERIC_MAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
    'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'aol.com', 'icloud.com',
    'me.com', 'msn.com', 'btinternet.com', 'sky.com', 'protonmail.com',
  ]);

  app.get('/api/customer/history', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const name  = String(req.query.name || '').trim();
    const q     = String(req.query.q || '').trim();       // explicit pick from the UI
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const empty = {
      matched: false, customer: '', matchedOn: '' as const, spellings: [] as string[],
      quotes: [], projects: [], suggestions: [] as { customer: string; count: number }[],
      totals: { count: 0, won: 0, lost: 0, open: 0, value: 0, wonValue: 0 },
    };

    try {
      // Same binding the /api/crm routes get from their middleware — this reads
      // the same multi-tenant tables, so it must resolve the same owner.
      try { await resolveOwner(); } catch { /* keep last-known owner */ }
      const oid = ownerId();

      // Every distinct customer this desk has quoted, folded to its key.
      const byKey = new Map<string, { display: string; spellings: Set<string>; count: number }>();
      for (const r of queryAll(
        `SELECT customer, COUNT(*) AS n FROM crm_quote
          WHERE ownerId = ? AND customer IS NOT NULL AND TRIM(customer) != ''
          GROUP BY customer`, [oid]) as any[]) {
        const key = customerKey(r.customer);
        if (!key) continue;
        const e = byKey.get(key) || { display: '', spellings: new Set<string>(), count: 0 };
        const raw = String(r.customer);
        e.spellings.add(raw);
        e.count += Number(r.n) || 0;
        // Pick the spelling a person would write. A trailing "(P05669)" is an
        // internal account code, so any spelling without one wins outright;
        // among equals the longest reads most like a full company name.
        const clean  = (s: string) => !/\([^)]*\)/.test(s);
        const better = !e.display
          || (clean(raw) && !clean(e.display))
          || (clean(raw) === clean(e.display) && raw.length > e.display.length);
        if (better) e.display = raw;
        byKey.set(key, e);
      }

      let key = '';
      let matchedOn: 'picked' | 'sender-name' | 'domain' | '' = '';

      // An explicit pick always wins — it is the user telling us who this is.
      if (q) {
        const qk = customerKey(q);
        if (byKey.has(qk)) { key = qk; matchedOn = 'picked'; }
      }

      // The display name usually carries the company ("Dave — Rexel Bristol").
      // Longest key first so "park electrical distributors" beats "park electrical".
      if (!key && name) {
        const hay = customerKey(name);
        const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
        for (const k of keys) {
          if (k.length < 4) continue;                  // "cef" would match anything
          if (hay === k || hay.includes(k)) { key = k; matchedOn = 'sender-name'; break; }
        }
      }

      // Then the domain label: rexel.co.uk → "rexel". Weakest of the three, so
      // it runs last and still requires a real word.
      //
      // Here the SHORTEST match wins, the opposite of the name path above: a
      // domain names the parent company, so "rexel" must land on Rexel (45
      // quotes) and not on the longer "rexel cambridge cowley road" (1).
      if (!key && email.includes('@')) {
        const domain = email.split('@')[1] || '';
        if (domain && !GENERIC_MAIL_DOMAINS.has(domain)) {
          const label = customerKey(domain.split('.')[0] || '');
          if (label.length >= 4) {
            const hits = [...byKey.keys()]
              .filter(k => k === label || k.startsWith(label + ' '))
              .sort((a, b) => a.length - b.length);
            if (hits.length) { key = hits[0]; matchedOn = 'domain'; }
          }
        }
      }

      // Nothing identified them: offer the biggest customers to pick from rather
      // than guessing. A wrong customer's history beside a reply box is worse
      // than none, so this never falls back to a fuzzy best-effort match.
      if (!key) {
        const suggestions = [...byKey.entries()]
          .sort((a, b) => b[1].count - a[1].count).slice(0, 8)
          .map(([, v]) => ({ customer: v.display, count: v.count }));
        res.json({ ...empty, suggestions });
        return;
      }

      const entry     = byKey.get(key)!;
      const spellings = [...entry.spellings];
      const ph        = spellings.map(() => '?').join(',');
      const states    = stateMap(oid);

      const rows = queryAll(
        `SELECT * FROM crm_quote
          WHERE ownerId = ? AND customer IN (${ph})
          ORDER BY COALESCE(arrivedOn, syncedAt) DESC LIMIT ?`,
        [oid, ...spellings, limit]);

      const quotes = rows.map((r: any) => ({
        sfId: r.sfId || null, title: r.title || null,
        quoteName: r.quoteName || null, account: r.account || null,
        customer: r.customer || null, salesman: r.salesman || null,
        price: r.price != null ? Number(r.price) : null,
        status: r.status || null, arrivedOn: r.arrivedOn || null,
        state: (states.get(String(r.sfId || '')) || 'open') as 'open' | 'won' | 'lost',
      }));

      // Totals cover the whole relationship, so they run over every quote for
      // this customer — not just the page returned above.
      const totals = { count: 0, won: 0, lost: 0, open: 0, value: 0, wonValue: 0 };
      for (const r of queryAll(
        `SELECT sfId, price FROM crm_quote WHERE ownerId = ? AND customer IN (${ph})`,
        [oid, ...spellings]) as any[]) {
        const st = states.get(String(r.sfId || '')) || 'open';
        const p  = Number(r.price) || 0;
        totals.count++; totals.value += p;
        if (st === 'won')       { totals.won++; totals.wonValue += p; }
        else if (st === 'lost')   totals.lost++;
        else                      totals.open++;
      }

      // Which projects this customer has bought for — the useful second axis.
      const projects = queryAll(
        `SELECT account AS name, COUNT(*) AS n FROM crm_quote
          WHERE ownerId = ? AND customer IN (${ph}) AND account IS NOT NULL AND TRIM(account) != ''
          GROUP BY account ORDER BY n DESC LIMIT 6`, [oid, ...spellings])
        .map((r: any) => ({ name: String(r.name), count: Number(r.n) || 0 }));

      res.json({
        matched: true,
        customer: entry.display,
        matchedOn,
        spellings,
        quotes, projects, totals,
        suggestions: [],
      });
    } catch (e: any) {
      res.json({ ...empty, error: e.message });
    }
  });

  // ── Reply snippets ─────────────────────────────────────────────────────────
  // The sentences typed every week — lead times, commissioning terms, the
  // standard questions back. AI drafting regenerates prose each time; these are
  // the fixed wordings that should come out identical every time.
  const snippetRow = (r: any) => ({
    id: r.id, title: r.title, body: r.body, tag: r.tag || null,
    useCount: r.useCount || 0, lastUsedAt: r.lastUsedAt || null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  });

  app.get('/api/snippets', (_req, res) => {
    // Most-used first: the list is a palette, not a filing cabinet.
    const rows = queryAll(`SELECT * FROM snippet ORDER BY useCount DESC, title COLLATE NOCASE ASC`);
    res.json({ snippets: rows.map(snippetRow) });
  });

  app.post('/api/snippets', (req, res) => {
    const { id, title, body, tag } = (req.body ?? {}) as
      { id?: number; title?: string; body?: string; tag?: string };
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t || !b) { res.status(400).json({ ok: false, error: 'a snippet needs a title and a body' }); return; }
    const now = new Date().toISOString();
    try {
      let rowId = Number(id) || 0;
      if (rowId) {
        db.run(`UPDATE snippet SET title=?, body=?, tag=?, updatedAt=? WHERE id=?`,
          [t, b, tag || null, now, rowId]);
      } else {
        rowId = runWrite(`INSERT INTO snippet (title, body, tag, createdAt, updatedAt) VALUES (?,?,?,?,?)`,
          [t, b, tag || null, now, now]);
      }
      saveDb();
      const row = queryAll(`SELECT * FROM snippet WHERE id = ?`, [rowId])[0];
      res.json({ ok: true, snippet: snippetRow(row) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/snippets/:id', (req, res) => {
    try {
      db.run(`DELETE FROM snippet WHERE id = ?`, [Number(req.params.id) || 0]);
      saveDb();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Bumped on insert so the palette orders itself by what actually gets used.
  app.post('/api/snippets/:id/used', (req, res) => {
    try {
      db.run(`UPDATE snippet SET useCount = COALESCE(useCount,0) + 1, lastUsedAt = ? WHERE id = ?`,
        [new Date().toISOString(), Number(req.params.id) || 0]);
      saveDb();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── CBU reference quotes ───────────────────────────────────────────────────
  // "Which quote did I do last for a 10KVA single phase?" — the question that
  // sends the desk hunting through Downloads, because the size lives only in
  // the Tech Brief PDF and never in the mail subject Ask Vector searches.
  // cbu_ref_scan.py reads those briefs (and any filled sizing calculator) and
  // reports system + reference + project; this stores the answers so the CBU
  // tab can hand back a quote number the moment a size is picked.
  const cbuRefRow = (r: any) => ({
    id: r.id, system: r.system, kva: r.kva, phase: r.phase,
    quoteRef: r.quoteRef, project: r.project || '', duration: r.duration || '',
    dated: r.dated || '', source: r.source || '', detail: r.detail || '',
    confidence: r.confidence || 'exact', note: r.note || '',
    pinned: !!r.pinned, hidden: !!r.hidden,
  });

  // Where the briefs pile up. Downloads first because that is where the tab's
  // own export lands; a config override exists for anyone filing elsewhere.
  function cbuScanDirs(): string[] {
    const cfg = loadPyCfg() as any;
    const fromCfg = cfg.cbu_scan_dirs;
    if (Array.isArray(fromCfg) && fromCfg.length) return fromCfg.map(String);
    const home = os.homedir();
    return [
      path.join(home, 'Downloads'),
      path.join(home, 'Desktop'),
      path.join(String(cfg.base || ''), 'PDF Quotes'),
    ].filter(Boolean);
  }

  app.get('/api/cbu/refs', (_req, res) => {
    try {
      // Pinned first inside a size, then newest — the pin is the one the user
      // decided to reuse, and it should not move when a newer job lands.
      const rows = queryAll(
        `SELECT * FROM cbu_ref WHERE hidden = 0
         ORDER BY pinned DESC, dated DESC, id DESC`);
      const meta = queryAll(`SELECT value FROM meta WHERE key = 'cbu_ref_scan'`)[0];
      let lastScan: any = null;
      try { lastScan = meta ? JSON.parse(String(meta.value)) : null; } catch { /* ignore */ }
      res.json({ refs: rows.map(cbuRefRow), lastScan, dirs: cbuScanDirs() });
    } catch (e: any) { res.status(500).json({ refs: [], error: e.message }); }
  });

  // Upsert one record. Rescanning must not clobber what the user curated, so a
  // row that already exists keeps its pin, its note and its hidden flag, and
  // only gains fields the scan filled in that were previously blank.
  function upsertCbuRef(r: any, now: string): 'created' | 'updated' | 'skipped' {
    const system = String(r.system || '').trim();
    const ref    = String(r.quoteRef || '').trim();
    if (!system || !ref) return 'skipped';
    const existing = queryAll(
      `SELECT * FROM cbu_ref WHERE system = ? AND quoteRef = ? COLLATE NOCASE`,
      [system, ref])[0];
    if (existing) {
      db.run(
        `UPDATE cbu_ref SET project = COALESCE(NULLIF(?, ''), project),
                            duration = COALESCE(NULLIF(?, ''), duration),
                            dated    = COALESCE(NULLIF(?, ''), dated),
                            source   = COALESCE(NULLIF(?, ''), source),
                            detail   = COALESCE(NULLIF(?, ''), detail),
                            confidence = ?, updatedAt = ?
         WHERE id = ?`,
        [String(r.project || ''), String(r.duration || ''), String(r.dated || ''),
         String(r.source || ''), String(r.detail || ''),
         String(r.confidence || 'exact'), now, existing.id]);
      return 'updated';
    }
    runWrite(
      `INSERT INTO cbu_ref (system, kva, phase, quoteRef, project, duration, dated,
                            source, detail, confidence, pinned, hidden, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
      [system, Number(r.kva) || null, String(r.phase || ''), ref,
       String(r.project || ''), String(r.duration || ''), String(r.dated || ''),
       String(r.source || 'manual'), String(r.detail || ''),
       String(r.confidence || 'exact'), now, now]);
    return 'created';
  }

  app.post('/api/cbu/refs/scan', (req, res) => {
    const body = (req.body ?? {}) as { dirs?: string[]; scanMail?: boolean };
    const dirs = Array.isArray(body.dirs) && body.dirs.length
      ? body.dirs.map(String) : cbuScanDirs();
    const script = pyFile('cbu_ref_scan.py');
    if (!existsSync(script)) {
      res.status(500).json({ ok: false, error: 'cbu_ref_scan.py is missing from the automation folder.' });
      return;
    }
    const tmp     = path.join(os.tmpdir(), `cbu_ref_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const jobPath = path.join(tmp, 'job.json');
    const outPath = path.join(tmp, 'out.json');
    const cleanup = () => {
      for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} }
      try { rmdirSync(tmp); } catch {}
    };
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(jobPath, JSON.stringify({
        dirs,
        scan_mail: !!body.scanMail,
        mail_db:   path.join(DATA_DIR, 'mail_index.db'),
        mail_limit: 200,
      }), 'utf8');
    } catch (e: any) { cleanup(); res.status(500).json({ ok: false, error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
               MAGIC_MAIL_INDEX: path.join(DATA_DIR, 'mail_index.db') } });
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    // The mail pass opens messages one at a time through COM; the files pass is
    // seconds. Ten minutes covers the slow one without leaving the tab spinning.
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 10 * 60_000);
    proc.on('error', (e: any) => {
      clearTimeout(killer); cleanup();
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
    proc.on('close', () => {
      clearTimeout(killer);
      let out: any = null;
      try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
      cleanup();
      if (!out || !out.ok) {
        const err = (out && out.error) || errBuf.trim().slice(-600) || 'The scan produced no result.';
        if (!res.headersSent) res.status(500).json({ ok: false, error: err });
        return;
      }
      const now = new Date().toISOString();
      let created = 0, updated = 0;
      try {
        for (const r of (out.found || [])) {
          const what = upsertCbuRef(r, now);
          if (what === 'created') created++;
          else if (what === 'updated') updated++;
        }
        const summary = {
          at: now, created, updated,
          found: (out.found || []).length,
          filesScanned: out.filesScanned || 0,
          mailsScanned: out.mailsScanned || 0,
          errors: (out.errors || []).slice(0, 20),
          dirs,
        };
        db.run(`INSERT INTO meta (key, value, updatedAt) VALUES ('cbu_ref_scan', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
          [JSON.stringify(summary), now]);
        saveDb();
        const rows = queryAll(
          `SELECT * FROM cbu_ref WHERE hidden = 0 ORDER BY pinned DESC, dated DESC, id DESC`);
        if (!res.headersSent) res.json({ ok: true, ...summary, refs: rows.map(cbuRefRow) });
      } catch (e: any) {
        if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
      }
    });
  });

  // Add or correct one by hand — for the quote whose brief was never saved.
  app.post('/api/cbu/refs', (req, res) => {
    const b = (req.body ?? {}) as any;
    const system = String(b.system || '').trim();
    const ref    = String(b.quoteRef || '').trim();
    if (!system || !ref) {
      res.status(400).json({ ok: false, error: 'a reference needs a system and a quote number' });
      return;
    }
    const m = /^([13])PH-\s*([\d.]+)KVA$/i.exec(system.replace(/\s+/g, ' ').replace(' ', ''));
    const now = new Date().toISOString();
    try {
      if (Number(b.id)) {
        db.run(`UPDATE cbu_ref SET system = ?, quoteRef = ?, project = ?, note = ?, dated = ?, updatedAt = ?
                WHERE id = ?`,
          [system, ref, String(b.project || ''), String(b.note || ''),
           String(b.dated || ''), now, Number(b.id)]);
      } else {
        upsertCbuRef({
          system, quoteRef: ref,
          kva: m ? Number(m[2]) : null,
          phase: m ? `${m[1]}PH` : '',
          project: b.project, dated: b.dated, source: 'manual', confidence: 'exact',
        }, now);
        if (b.note) {
          db.run(`UPDATE cbu_ref SET note = ? WHERE system = ? AND quoteRef = ? COLLATE NOCASE`,
            [String(b.note), system, ref]);
        }
      }
      saveDb();
      const row = queryAll(
        `SELECT * FROM cbu_ref WHERE system = ? AND quoteRef = ? COLLATE NOCASE`, [system, ref])[0];
      res.json({ ok: true, ref: row ? cbuRefRow(row) : null });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Pin the one to reuse. Exactly one per size, so pinning clears the others —
  // "pick one, keep it as a resource" is a choice, not a shortlist.
  app.post('/api/cbu/refs/:id/pin', (req, res) => {
    const id = Number(req.params.id) || 0;
    const on = (req.body ?? {}).pinned !== false;
    try {
      const row = queryAll(`SELECT system FROM cbu_ref WHERE id = ?`, [id])[0];
      if (!row) { res.status(404).json({ ok: false, error: 'no such reference' }); return; }
      db.run(`UPDATE cbu_ref SET pinned = 0 WHERE system = ?`, [row.system]);
      if (on) db.run(`UPDATE cbu_ref SET pinned = 1, updatedAt = ? WHERE id = ?`,
        [new Date().toISOString(), id]);
      saveDb();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Hidden rather than deleted: the practice exports ("sds", "wewwe") sit in
  // Downloads forever, and a real delete would let the next scan bring them
  // straight back.
  app.delete('/api/cbu/refs/:id', (req, res) => {
    try {
      db.run(`UPDATE cbu_ref SET hidden = 1, pinned = 0, updatedAt = ? WHERE id = ?`,
        [new Date().toISOString(), Number(req.params.id) || 0]);
      saveDb();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Show the brief this row came from. Only paths the scan itself recorded are
  // openable, so this cannot be pointed at an arbitrary file.
  app.post('/api/cbu/refs/:id/reveal', (req, res) => {
    const row = queryAll(`SELECT detail, source FROM cbu_ref WHERE id = ?`,
      [Number(req.params.id) || 0])[0];
    const target = String(row?.detail || '');
    if (!row || row.source === 'mail' || !target || !existsSync(target)) {
      res.status(400).json({ ok: false, error: 'no file was recorded for this reference' });
      return;
    }
    try {
      spawn('explorer.exe', ['/select,', path.resolve(target)],
        { detached: true, stdio: 'ignore' }).unref();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── PDF list / delete / upload ─────────────────────────────────────────────
  app.get('/api/pdfs', (_req, res) => {
    const dir = path.join(loadPyCfg().base, 'PDF Quotes');
    try {
      res.json(existsSync(dir)
        ? readdirSync(dir).filter(f => ['.pdf','.xlsx','.xls','.xlsm','.docx','.doc','.dotm','.dotx'].some(e => f.toLowerCase().endsWith(e)))
            .map(f => { const st = statSync(path.join(dir, f)); return { name: f, size: st.size, modified: st.mtime.toISOString() }; })
        : []);
    } catch { res.json([]); }
  });

  app.delete('/api/pdfs/:name', (req, res) => {
    const file = path.join(loadPyCfg().base, 'PDF Quotes', path.basename(req.params.name));
    try { if (existsSync(file)) unlinkSync(file); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/pdfs/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const pdfDir   = path.join(loadPyCfg().base, 'PDF Quotes');
    const filename = decodeURIComponent((req.headers['x-filename'] as string) || 'upload.pdf');
    try {
      mkdirSync(pdfDir, { recursive: true });
      writeFileSync(path.join(pdfDir, path.basename(filename)), req.body as Buffer);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── LSD Pricing ────────────────────────────────────────────────────────────
  // Drop a CPQ transaction, get a case folder holding the transaction, the
  // Approved Offer and the Working File (the master model itself, filled and
  // toggled). automation/lsd_pricing.py does the pricing and drives Excel; this
  // is only plumbing — staging the upload, running the script, guarding paths.
  const LSD_DIR    = path.join(DATA_DIR, 'data', 'lsd');
  const LSD_UPLOAD = path.join(LSD_DIR, '_incoming');

  function lsdMaster(): string {
    const cfg = loadPyCfg() as any;
    const set = String(cfg.lsd_master_model || '').trim();
    if (set && existsSync(set)) return set;
    // Otherwise take the newest .xlsb sitting in data/lsd.
    try {
      const found = readdirSync(LSD_DIR)
        .filter(f => f.toLowerCase().endsWith('.xlsb') && !f.startsWith('~$'))
        .map(f => path.join(LSD_DIR, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (found.length) return found[0];
    } catch {}
    return '';
  }

  function lsdCasesRoot(): string {
    const cfg = loadPyCfg() as any;
    const set = String(cfg.lsd_cases_root || '').trim();
    if (set) return set;
    // Default to the analyst's own case archive when it exists, so generated
    // folders land beside the real ones rather than somewhere new.
    const desktop = path.join(os.homedir(), 'Desktop', 'LSD Pricing Doc');
    return existsSync(desktop) ? desktop : path.join(loadPyCfg().base, 'LSD Cases');
  }

  // Every path that comes back from the client is re-checked against the case
  // root before it is opened or streamed — the client must not be able to name
  // an arbitrary file on disk.
  function insideCasesRoot(p: string): string | null {
    try {
      const root = path.resolve(lsdCasesRoot());
      const abs  = path.resolve(p);
      const rel  = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
    } catch {}
    return null;
  }

  // Pricing runs currently in flight, so Cancel has something to cancel. Keyed
  // on the id the tab generates, because the tab is what holds the button.
  const lsdRuns = new Map<string, { proc: ReturnType<typeof spawn>; cancelPath: string }>();

  function runLsd(job: Record<string, unknown>, timeoutMs: number,
                  res: Response, onOk?: (r: any) => void | Promise<void>) {
    const script = pyFile('lsd_pricing.py');
    if (!existsSync(script)) {
      res.status(500).json({ ok: false, error: 'lsd_pricing.py is missing from this install' });
      return;
    }
    const master = lsdMaster();
    if (!master) {
      res.status(400).json({
        ok: false,
        error: 'No master CPQ model. Put the "CPQ Pricing Model LSD … V2" .xlsb in '
             + `${LSD_DIR}, or set its path in Settings → LSD Pricing.`,
      });
      return;
    }
    const tmp     = path.join(os.tmpdir(), `lsd_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const jobPath = path.join(tmp, 'job.json');
    const outPath = path.join(tmp, 'out.json');
    const cancelPath = path.join(tmp, 'cancel');
    const cleanup = () => {
      for (const p of [jobPath, outPath, cancelPath]) { try { unlinkSync(p); } catch {} }
      try { rmdirSync(tmp); } catch {}
    };
    const runId = String((job as any).job_id || randomUUID());
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(jobPath, JSON.stringify({
        ...job,
        // The client calls the staged upload `file`; the engine calls it `bom`.
        bom: (job as any).bom || (job as any).file,
        master, cases_root: lsdCasesRoot(),
        ledger: (job as any).ledger || (loadPyCfg() as any).lsd_ledger || 'R2321',
        // Cancel is cooperative: the engine watches for this file and unwinds,
        // closing Excel behind it. See _check_cancel in lsd_pricing.py.
        cancel_file: cancelPath,
      }), 'utf8');
    } catch (e: any) { cleanup(); res.status(500).json({ ok: false, error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    lsdRuns.set(runId, { proc, cancelPath });
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    // Excel can hang on a repair prompt; kill rather than leave the tab spinning.
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('error', (e: any) => {
      clearTimeout(killer); lsdRuns.delete(runId); cleanup();
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    });
    proc.on('close', () => {
      clearTimeout(killer);
      lsdRuns.delete(runId);
      let out: any = null;
      try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
      cleanup();
      if (!out) {
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: errBuf.trim().slice(-600) || 'The pricing run produced no result.' });
        }
        return;
      }
      // onOk may be async (the build registers the case before answering), so a
      // promise it returns is waited on — the tab must not be told the case is
      // done while the register row is still being written.
      const finish = () => { if (!res.headersSent) res.json(out); };
      if (out.ok && onOk) {
        try {
          const r = onOk(out) as unknown;
          if (r && typeof (r as Promise<void>).then === 'function') {
            (r as Promise<void>).then(finish, finish);
            return;
          }
        } catch {}
      }
      finish();
    });
  }

  // What the tab needs to know before it lets you drop anything.
  app.get('/api/lsd/status', (_req, res) => {
    const master = lsdMaster();
    const root   = lsdCasesRoot();
    res.json({
      master, masterName: master ? path.basename(master) : '',
      masterDir: LSD_DIR, casesRoot: root, casesRootExists: existsSync(root),
      ledger: (loadPyCfg() as any).lsd_ledger || 'R2321',
    });
  });

  // Stage the dropped transaction. It is copied into the case folder verbatim by
  // the build step, so keep the original filename — CPQ encodes the date in it
  // and that is what picks H1 vs H2.
  app.post('/api/lsd/upload', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
    const raw  = decodeURIComponent((req.headers['x-filename'] as string) || 'transaction.xlsx');
    const name = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!/\.(csv|xlsx|xlsb)$/i.test(name)) {
      res.status(400).json({ ok: false, error: 'Drop the CPQ line-item export (.csv, .xlsx or .xlsb).' });
      return;
    }
    try {
      mkdirSync(LSD_UPLOAD, { recursive: true });
      // A build consumes its staged file, but a preview that is never built
      // leaves one behind. Sweep anything older than a day on the way in.
      const cutoff = Date.now() - 864e5;
      for (const f of readdirSync(LSD_UPLOAD)) {
        const p = path.join(LSD_UPLOAD, f);
        try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch {}
      }
      const dest = path.join(LSD_UPLOAD, `${Date.now()}__${name}`);
      writeFileSync(dest, req.body as Buffer);
      res.json({ ok: true, file: dest, name });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Price without writing anything — this is what fills the review table.
  app.post('/api/lsd/preview', (req, res) => {
    const b = (req.body || {}) as any;
    if (!b.file || !existsSync(b.file)) {
      res.status(400).json({ ok: false, error: 'Upload the transaction first.' }); return;
    }
    runLsd({ ...b, mode: 'preview' }, 120_000, res);
  });

  // Price and write the case folder. Needs Excel, so it gets a long leash.
  app.post('/api/lsd/build', (req, res) => {
    const b = (req.body || {}) as any;
    // A rebuild names no file: the transaction is the one already sitting in the
    // case folder, which is the only copy once the staged upload was consumed.
    if (!b.file && b.rebuild) {
      const dir = lsdCaseDir(String(b.transaction || ''), String(b.project || ''));
      try {
        const exports_ = readdirSync(dir)
          .filter(f => /^\d{8,}_\d{4}-\d{2}-\d{2}\.xlsx?$/i.test(f) || /\.(csv|xlsx|xlsb)$/i.test(f))
          .filter(f => !/approved|working/i.test(f) && !f.startsWith('~$'))
          .map(f => path.join(dir, f))
          .sort((a, c) => statSync(c).mtimeMs - statSync(a).mtimeMs);
        if (exports_.length) b.file = exports_[0];
      } catch {}
      // Nothing in the case folder — fall back to a staged export stamped with
      // this transaction (the case files may have been deleted on purpose, which
      // is exactly when Rebuild is wanted).
      if (!b.file) {
        try {
          const want = String(b.transaction || '').trim().toLowerCase();
          const staged = readdirSync(LSD_UPLOAD)
            .filter(f => f.toLowerCase().endsWith('.meta.json'))
            .map(f => path.join(LSD_UPLOAD, f))
            .filter(m => {
              try {
                const j = JSON.parse(readFileSync(m, 'utf8'));
                return String(j.transaction || '').trim().toLowerCase() === want;
              } catch { return false; }
            })
            .map(m => m.replace(/\.meta\.json$/i, ''))
            .filter(p => existsSync(p))
            .sort((a, c) => statSync(c).mtimeMs - statSync(a).mtimeMs);
          if (staged.length) b.file = staged[0];
        } catch {}
      }
      if (!b.file) {
        res.status(400).json({ ok: false, error: 'Nothing to rebuild from — no transaction file in the case folder and no staged export for this number. Fetch it from CPQ again.' });
        return;
      }
    }
    if (!b.file || !existsSync(b.file)) {
      res.status(400).json({ ok: false, error: 'Upload the transaction first.' }); return;
    }
    if (!String(b.transaction || '').trim() && !String(b.project || '').trim()) {
      res.status(400).json({ ok: false, error: 'Give the case a transaction number or a project name — it names the folder.' });
      return;
    }
    runLsd({ ...b, mode: 'build' }, 600_000, res, async out => {
      // The staged upload has been copied into the case folder; drop the copy.
      // ONLY if it is a staged upload: a rebuild is handed the transaction that
      // already lives in the case folder, and deleting that would take the case's
      // own record of what was priced with it.
      const staged = path.resolve(b.file).toLowerCase()
                       .startsWith(path.resolve(LSD_UPLOAD).toLowerCase() + path.sep);
      if (staged) { try { unlinkSync(b.file); } catch {} }
      // Every built case is registered. A register that cannot be written (the
      // workbook open in Excel, say) must not fail the build — the case folder
      // is already on disk — so the failure rides back on the response and the
      // tab offers to register it again.
      if (b.register === false) return;
      const reg = await runRegister({ mode: 'append', row: lsdRegisterRow(b, out),
                                      extra: lsdRegisterExtra(b, out) });
      out.register = {
        ok: !!reg.ok, error: reg.error, action: reg.action,
        path: lsdRegisterPath(), skipped: reg.skipped || [],
      };
    });
  });

  // Stop a run in flight. The flag file goes down first so the engine can close
  // Excel on its way out; the process is only killed if it ignores that, which
  // would leave an orphaned Excel holding the master model open.
  app.post('/api/lsd/cancel', (req, res) => {
    const id = String((req.body || {}).job_id || '');
    const run = lsdRuns.get(id);
    if (!run) { res.json({ ok: false, error: 'That run has already finished.' }); return; }
    try { writeFileSync(run.cancelPath, 'cancel', 'utf8'); } catch {}
    setTimeout(() => {
      if (lsdRuns.has(id)) { try { run.proc.kill(); } catch {} }
    }, 20_000);
    res.json({ ok: true });
  });

  // The approval mail. A case priced under its target E2E is not repriced — the
  // margin goes to the approver, in his own format, with the LEDGER-ONLY .xlsm
  // attached (the Working File is the whole master model). Draft only: the mail
  // lands in Drafts with the composer open, and a human presses Send.
  app.post('/api/lsd/approval-mail', (req, res) => {
    const b = (req.body || {}) as any;
    const cfg = loadPyCfg() as any;
    const to = String(b.to || cfg.lsd_approver || '').trim();
    if (!to) { res.status(400).json({ ok: false, error: 'No approver — set one in Settings → LSD Pricing.' }); return; }
    if (!b.summary || !b.meta) { res.status(400).json({ ok: false, error: 'Price and build the case first.' }); return; }

    // Only a file inside the case root may be attached — the client names it.
    const attach = (Array.isArray(b.attach) ? b.attach : [b.attach])
      .filter(Boolean).map((p: string) => insideCasesRoot(String(p))).filter(Boolean);

    const script = pyFile('lsd_approval_mail.py');
    if (!existsSync(script)) { res.status(500).json({ ok: false, error: 'lsd_approval_mail.py is missing from this install' }); return; }

    const tmp     = path.join(os.tmpdir(), `lsdmail_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const jobPath = path.join(tmp, 'job.json');
    const outPath = path.join(tmp, 'out.json');
    const cleanup = () => { for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} } try { rmdirSync(tmp); } catch {} };
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(jobPath, JSON.stringify({
        summary: b.summary, meta: b.meta, attach,
        to, cc: b.cc ?? cfg.lsd_approver_cc ?? '',
        subject: b.subject || '', intro: b.intro || undefined,
        // Never 'send' from here, whatever the client asks for.
        mode: 'draft',
      }), 'utf8');
    } catch (e: any) { cleanup(); res.status(500).json({ ok: false, error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 120_000);
    proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); });
    proc.on('close', () => {
      clearTimeout(killer);
      let out: any = null;
      try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
      cleanup();
      if (!res.headersSent) res.json(out || { ok: false, error: errBuf.trim().slice(-500) || 'The mail draft produced no result.' });
    });
  });

  // Windows-safe folder name, byte for byte what lsd_pricing.safe_name() makes —
  // the two have to agree or the revision lands in a folder of its own.
  function lsdSafeName(s: string, limit = 90): string {
    let out = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
    out = out.replace(/\s+/g, ' ');
    return out.slice(0, limit).trim() || 'case';
  }
  function lsdCaseDir(transaction: string, project: string): string {
    const name = transaction && project ? `${transaction} - ${project}`
                                        : (transaction || project || 'case');
    return path.join(lsdCasesRoot(), lsdSafeName(name));
  }

  // Which revisions of this transaction the analyst already has, and the
  // approved file of the newest one pulled down so the pricing run can diff
  // against it. Read-only against her OneDrive — see automation/onedrive_case.py.
  function runOneDrive(job: Record<string, unknown>, timeoutMs = 180_000): Promise<any> {
    return new Promise(resolve => {
      const script = pyFile('onedrive_case.py');
      if (!existsSync(script)) { resolve({ ok: false, error: 'onedrive_case.py is missing' }); return; }
      const tmp     = path.join(os.tmpdir(), `odcase_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const jobPath = path.join(tmp, 'job.json');
      const outPath = path.join(tmp, 'out.json');
      const cleanup = () => { for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} } try { rmdirSync(tmp); } catch {} };
      try {
        mkdirSync(tmp, { recursive: true });
        writeFileSync(jobPath, JSON.stringify({
          port: Number((loadPyCfg() as any).lsd_cpq_port) || 9222, ...job,
        }), 'utf8');
      } catch (e: any) { cleanup(); resolve({ ok: false, error: e.message }); return; }
      const [py, base] = pyArgs(script);
      const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      let errBuf = '';
      proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
      const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
      proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); resolve({ ok: false, error: e.message }); });
      proc.on('close', () => {
        clearTimeout(killer);
        let out: any = null;
        try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
        cleanup();
        resolve(out || { ok: false, error: errBuf.trim().slice(-300) || 'No result from the OneDrive lookup.' });
      });
    });
  }

  // ── Keep the LSD work tabs alive ───────────────────────────────────────────
  // CPQ, the analyst's OneDrive and the SharePoint site all sign out when their
  // tab sits idle, and every LSD fetch reads those tabs. A timer reloads them in
  // the background (minimized debug-rail Edge) so the first fetch of the day
  // works without anyone clicking the browser awake — see tab_keepalive.py.
  const KEEPALIVE_DEFAULT_URLS = [
    'https://eaton.bigmachines.com/',
    'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA',
  ];
  function keepaliveUrls(): string[] {
    const raw = (loadPyCfg() as any).lsd_keepalive_urls;
    const list = Array.isArray(raw) ? raw
      : String(raw || '').split(/[\r\n]+/);
    const clean = list.map((s: string) => String(s || '').trim()).filter(Boolean);
    return clean.length ? clean : KEEPALIVE_DEFAULT_URLS;
  }
  let keepaliveState: any = { ran: null, ok: null, tabs: [], needs_signin: [], log: [] };
  let keepaliveBusy = false;

  // What the session strip is sent, from BOTH endpoints. tab_keepalive.py reports
  // only on the sweep it just ran — tabs, needs_signin, log — and knows nothing
  // about the configuration around it. The GET used to add `urls`, `enabled` and
  // `everyMin` on top and the POST did not, so pressing Connect swapped a
  // complete object for a partial one and the next render read `ka.urls.length`
  // off undefined, which the error boundary turned into a dead tab.
  const keepalivePayload = (state: any) => {
    const cfg = loadPyCfg() as any;
    return {
      enabled: cfg.lsd_keepalive !== false && String(cfg.lsd_keepalive ?? '') !== 'off',
      everyMin: Number(cfg.lsd_keepalive_min) || 10,
      urls: keepaliveUrls(),
      running: keepaliveBusy,
      tabs: [], needs_signin: [], log: [],
      ...state,
    };
  };

  function runKeepalive(force = false): Promise<any> {
    return new Promise(resolve => {
      if (keepaliveBusy && !force) { resolve({ ...keepaliveState, skipped: 'already running' }); return; }
      const script = pyFile('tab_keepalive.py');
      if (!existsSync(script)) { resolve({ ok: false, error: 'tab_keepalive.py is missing from this install' }); return; }
      keepaliveBusy = true;
      const cfg     = loadPyCfg() as any;
      const tmp     = path.join(os.tmpdir(), `kajob_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const jobPath = path.join(tmp, 'job.json');
      const outPath = path.join(tmp, 'out.json');
      const cleanup = () => { for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} } try { rmdirSync(tmp); } catch {} };
      try {
        mkdirSync(tmp, { recursive: true });
        writeFileSync(jobPath, JSON.stringify({
          port: Number(cfg.lsd_cpq_port) || 9222,
          urls: keepaliveUrls(),
          launch: true, minimized: true, reload: true,
        }), 'utf8');
      } catch (e: any) { keepaliveBusy = false; cleanup(); resolve({ ok: false, error: e.message }); return; }
      const [py, base] = pyArgs(script);
      const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      let errBuf = '';
      proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
      const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 180_000);
      const finish = (out: any) => {
        keepaliveBusy = false;
        keepaliveState = { ran: new Date().toISOString(), ...out };
        resolve(keepaliveState);
      };
      proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); finish({ ok: false, error: e.message }); });
      proc.on('close', () => {
        clearTimeout(killer);
        let out: any = null;
        try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
        cleanup();
        finish(out || { ok: false, error: errBuf.trim().slice(-300) || 'The keep-alive produced no result.' });
      });
    });
  }

  // What the LSD tab shows in its session strip: which pages are warm, which
  // need a human to sign in once, and when the last sweep ran.
  app.get('/api/lsd/keepalive', (_req, res) => {
    res.json(keepalivePayload(keepaliveState));
  });
  app.post('/api/lsd/keepalive/run', async (_req, res) => {
    res.json(keepalivePayload(await runKeepalive(true)));
  });

  // The timer itself. Off by config, never off by accident: a failed sweep just
  // records itself and the next one tries again.
  if (!(global as any).__vectorKeepaliveTimer) {
    const tick = async () => {
      const cfg = loadPyCfg() as any;
      if (cfg.lsd_keepalive === false || String(cfg.lsd_keepalive ?? '') === 'off') return;
      try { await runKeepalive(); } catch {}
    };
    const mins = Number((loadPyCfg() as any).lsd_keepalive_min) || 10;
    (global as any).__vectorKeepaliveTimer = setInterval(tick, Math.max(2, mins) * 60_000);
    setTimeout(tick, 20_000);   // one sweep shortly after boot
  }

  // ── What is waiting in the analyst's daily sheet ───────────────────────────
  // Dalia adds a row to her "LSD Daily work" workbook for every transaction that
  // needs pricing. automation/lsd_queue.py reads it READ-ONLY through the signed-in
  // eaton-my tab and returns the rows that are not Done/Cancelled and not noted
  // "Done by Laith". This keeps the last answer, stamps when each transaction first
  // showed up, and marks the ones that already have a case folder here.
  const LSD_QUEUE_SEEN = path.join(LSD_DIR, 'queue_seen.json');
  let queueState: any = { ran: null, ok: null, rows: [] };
  let queueBusy = false;

  const queuePayload = (state: any) => {
    const cfg = loadPyCfg() as any;
    return {
      enabled: cfg.lsd_queue !== false && String(cfg.lsd_queue ?? '') !== 'off',
      everyMin: Math.max(2, Number(cfg.lsd_queue_min) || 5),
      rows: [],
      ...state,
      running: queueBusy,
    };
  };

  // Case folders on disk, keyed on the transaction number their name opens with
  // ("W262072585E2 - Taiba …" → W262072585E2).
  function localCases(): Map<string, string> {
    const m = new Map<string, string>();
    try {
      const root = lsdCasesRoot();
      for (const d of readdirSync(root, { withFileTypes: true })) {
        const w = d.isDirectory() ? d.name.match(/^(W\d{9,}E\d*)(?:\s|$)/i) : null;
        if (w) m.set(w[1].toUpperCase(), path.join(root, d.name));
      }
    } catch {}
    return m;
  }

  function runQueue(force = false): Promise<any> {
    return new Promise(resolve => {
      if (queueBusy) { resolve(queueState); return; }
      // The keep-alive reloads the OneDrive tabs this read goes through, and a read
      // started mid-reload fails for nothing. The timer just tries again next tick.
      if (keepaliveBusy && !force) { resolve(queueState); return; }
      const script = pyFile('lsd_queue.py');
      if (!existsSync(script)) {
        resolve({ ...queueState, ok: false, error: 'lsd_queue.py is missing from this install' });
        return;
      }
      queueBusy = true;
      const cfg     = loadPyCfg() as any;
      const tmp     = path.join(os.tmpdir(), `lsdq_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const jobPath = path.join(tmp, 'job.json');
      const outPath = path.join(tmp, 'out.json');
      const cleanup = () => { for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} } try { rmdirSync(tmp); } catch {} };
      const finish = (out: any) => {
        queueBusy = false;
        const now = new Date().toISOString();
        if (out?.ok) {
          const cases = localCases();
          // First sighting per transaction. The very first read stamps nothing, or
          // every open row in her sheet would arrive flagged as new.
          let seen: Record<string, string> = {};
          let baseline = false;
          try { seen = JSON.parse(readFileSync(LSD_QUEUE_SEEN, 'utf8')); } catch { baseline = true; }
          const counts: Record<string, number> = {};
          for (const r of out.rows || []) {
            const key = r.transaction || `name:${r.name}`;
            if (!(key in seen)) seen[key] = baseline ? '' : now;
            r.first_seen = seen[key] || null;
            r.case_folder = (r.transaction && cases.get(r.transaction)) || null;
            // Priced here but her Status is still open: done by Laith, not yet noted.
            if (r.case_folder && r.kind === 'fetch') r.kind = 'priced';
            counts[r.kind] = (counts[r.kind] || 0) + 1;
          }
          try { writeFileSync(LSD_QUEUE_SEEN, JSON.stringify(seen), 'utf8'); } catch {}
          queueState = { ...out, counts, ran: now };
        } else {
          // Keep the last good rows on screen; only the error is new.
          queueState = { ...queueState, ran: now, ok: false,
                         error: out?.error || 'The daily sheet read produced no result.' };
        }
        resolve(queueState);
      };
      try {
        mkdirSync(tmp, { recursive: true });
        writeFileSync(jobPath, JSON.stringify({
          port: Number(cfg.lsd_cpq_port) || 9222,
          file: String(cfg.lsd_daily_file || '').trim(),
          bu: String(cfg.lsd_queue_bu || '').trim(),          // blank = FIRE
        }), 'utf8');
      } catch (e: any) { cleanup(); finish({ ok: false, error: e.message }); return; }
      const [py, base] = pyArgs(script);
      const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      let errBuf = '';
      proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
      const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 180_000);
      proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); finish({ ok: false, error: e.message }); });
      proc.on('close', () => {
        clearTimeout(killer);
        let out: any = null;
        try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
        cleanup();
        finish(out || { ok: false, error: errBuf.trim().slice(-300) || 'The daily sheet read produced no result.' });
      });
    });
  }

  app.get('/api/lsd/queue', (_req, res) => {
    res.json(queuePayload(queueState));
  });
  app.post('/api/lsd/queue/refresh', async (_req, res) => {
    res.json(queuePayload(await runQueue(true)));
  });

  if (!(global as any).__vectorLsdQueueTimer) {
    const tick = async () => {
      const cfg = loadPyCfg() as any;
      if (cfg.lsd_queue === false || String(cfg.lsd_queue ?? '') === 'off') return;
      try { await runQueue(); } catch {}
    };
    const mins = Math.max(2, Number((loadPyCfg() as any).lsd_queue_min) || 5);
    (global as any).__vectorLsdQueueTimer = setInterval(tick, mins * 60_000);
    setTimeout(tick, 45_000);   // after the boot keep-alive sweep has woken the tabs
  }

  // Pull a transaction straight from Oracle CPQ (its REST API, driven through the
  // debug-rail Edge the user is already signed into — see cpq_fetch.py). Writes a
  // CPQ-shaped .xlsx into the same staging dir an upload lands in, so the priced
  // path downstream is identical whether the BOM came from a drop or from CPQ.
  app.post('/api/lsd/cpq-fetch', (req, res) => {
    const transaction = String((req.body || {}).transaction || '').trim();
    if (!transaction) { res.status(400).json({ ok: false, error: 'Enter a transaction number.' }); return; }
    const script = pyFile('cpq_fetch.py');
    if (!existsSync(script)) { res.status(500).json({ ok: false, error: 'cpq_fetch.py is missing from this install' }); return; }

    const tmp     = path.join(os.tmpdir(), `cpqjob_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const jobPath = path.join(tmp, 'job.json');
    const outPath = path.join(tmp, 'out.json');
    const cleanup = () => { for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} } try { rmdirSync(tmp); } catch {} };
    try {
      mkdirSync(LSD_UPLOAD, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      writeFileSync(jobPath, JSON.stringify({
        transaction,
        port: Number((loadPyCfg() as any).lsd_cpq_port) || 9222,
        out_dir: LSD_UPLOAD,
      }), 'utf8');
    } catch (e: any) { cleanup(); res.status(500).json({ ok: false, error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    // Long enough to survive one tab reload and retry inside cpq_fetch — a 90s
    // cap used to kill the fetch mid-recovery, which read as "it timed out".
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 180_000);
    proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); });
    proc.on('close', async () => {
      clearTimeout(killer);
      let out: any = null;
      try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
      cleanup();
      if (!out) { if (!res.headersSent) res.status(500).json({ ok: false, error: errBuf.trim().slice(-500) || 'CPQ fetch produced no result.' }); return; }
      // Hand the written export back as `file`, the same shape /preview and /build expect.
      if (out.ok) out.file = out.xlsx;
      // Stamp the export with the transaction it belongs to. The file is named
      // after CPQ's document id, so without this a rebuild cannot tell one
      // staged export from another.
      if (out.ok && out.xlsx) {
        try {
          writeFileSync(`${out.xlsx}.meta.json`, JSON.stringify({
            transaction: (out.header || {}).transaction || transaction,
            project: (out.header || {}).project || '',
          }), 'utf8');
        } catch {}
      }

      // FIRST QUESTION ON ANY TRANSACTION: has this been priced before? The
      // answer lives in the analyst's OneDrive, so it is looked up here rather
      // than left to whoever is at the keyboard to go and check by hand. A
      // failure is reported, never fatal — the fetch itself already succeeded.
      if (out.ok && (loadPyCfg() as any).lsd_skip_revision_check !== true) {
        const h = out.header || {};
        // Bounded well inside the client's own patience: the CPQ read has
        // already succeeded by this point, and a slow OneDrive must not turn a
        // good fetch into a failed one.
        const od = await runOneDrive({
          transaction: h.transaction || transaction,
          out_dir: lsdCaseDir(h.transaction || transaction, h.project || ''),
          pattern: 'approved',
        }, 90_000);
        out.revisions = od.ok
          ? { ok: true, latest: od.latest_revision, next: od.next_revision,
              files: od.files, pulled: od.downloaded }
          : { ok: false, error: od.error };

        // Nothing under this number is not the same as never priced: sales
        // re-upload an old deal under a NEW transaction (Khimji W262144615E was
        // W262142622E in July). So the customer's own history is searched too —
        // Dalia's sheet by customer, then that deal's approved offer — and the
        // best-matching one is staged for the build to carry from.
        if (od.ok && !(od.latest_revision > 0) && !(od.files || []).length && h.customer) {
          const hist = await runOneDrive({
            mode: 'history',
            customer: h.customer, customer_name: h.customer_name || '',
            transaction: h.transaction || transaction,
            bom: out.xlsx,
            out_dir: path.join(lsdCaseDir(h.transaction || transaction, h.project || ''), '_history'),
          }, 150_000);
          out.history = hist.ok
            ? { ok: true, pick: hist.pick || null, candidates: hist.candidates || [] }
            : { ok: false, error: hist.error };
        }
      }
      if (!res.headersSent) res.json(out);
    });
  });

  // Case folders already on disk, newest first.
  app.get('/api/lsd/cases', (_req, res) => {
    const root = lsdCasesRoot();
    try {
      if (!existsSync(root)) { res.json({ root, cases: [] }); return; }
      const cases = readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map(d => {
          const dir = path.join(root, d.name);
          let files: { name: string; size: number; path: string }[] = [];
          try {
            files = readdirSync(dir)
              .filter(f => !f.startsWith('~$'))
              .map(f => ({ name: f, size: statSync(path.join(dir, f)).size, path: path.join(dir, f) }));
          } catch {}
          return { name: d.name, path: dir, mtime: statSync(dir).mtimeMs, files };
        })
        .filter(c => c.files.length > 0)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 60);
      res.json({ root, cases });
    } catch (e: any) { res.status(500).json({ root, cases: [], error: e.message }); }
  });

  // Open a case folder (or a file in one) in Explorer.
  app.post('/api/lsd/reveal', (req, res) => {
    const asked  = String((req.body || {}).path || '');
    // The register may be configured to live outside the case root, so it is
    // allowed by identity as well as by containment.
    const target = path.resolve(asked) === path.resolve(lsdRegisterPath())
      ? path.resolve(asked) : insideCasesRoot(asked);
    if (!target || !existsSync(target)) {
      res.status(400).json({ ok: false, error: 'That path is not inside the case folder root.' });
      return;
    }
    try {
      const isDir = statSync(target).isDirectory();
      // explorer.exe returns exit code 1 even when it succeeds, so nothing is
      // read back from it — fire and forget.
      spawn('explorer.exe', isDir ? [target] : ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── LSD daily register ─────────────────────────────────────────────────────
  // Every transaction that gets a case folder also gets a row in a register
  // workbook shaped like the analyst's "LSD Daily work" sheet, which is then
  // pushed to SharePoint the same way quotes are. automation/lsd_register.py
  // owns the workbook and the upload; this is the plumbing around it.
  const REGISTER_NAME = 'LSD Daily Work - Vector.xlsx';

  function lsdRegisterPath(): string {
    const set = String((loadPyCfg() as any).lsd_register || '').trim();
    if (set) return set;
    return path.join(lsdCasesRoot(), REGISTER_NAME);
  }

  // Which business unit a transaction belongs to, read from the pricing groups
  // the lines actually carry rather than from the APRC toggle — APRC only says
  // which currency the model is in, and a UAE EL deal prices in USD too. The
  // list's DIVISION is derived from this downstream (FIRE-only → FIRE, anything
  // with EL in it → 'EL & FIRE').
  const EL_GROUPS = /luminaire|luminarie|self contained|module|universal|emergency|central battery/i;
  function lsdBu(lines: any[]): string {
    let el = false, fire = false;
    for (const l of lines || []) {
      const g = String(l?.group || '').trim();
      if (!g) continue;
      if (EL_GROUPS.test(g)) el = true; else fire = true;
    }
    if (el) return 'EL';
    return fire ? 'FIRE' : '';
  }

  // Same job-file/out-file contract as runLsd, but resolved rather than piped to
  // a response, because the build has to await it mid-request.
  function runRegister(job: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
    return new Promise(resolve => {
      const script = pyFile('lsd_register.py');
      if (!existsSync(script)) {
        resolve({ ok: false, error: 'lsd_register.py is missing from this install' });
        return;
      }
      const tmp     = path.join(os.tmpdir(), `lsdreg_${Date.now()}_${randomUUID().slice(0, 8)}`);
      const jobPath = path.join(tmp, 'job.json');
      const outPath = path.join(tmp, 'out.json');
      const cleanup = () => {
        for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} }
        try { rmdirSync(tmp); } catch {}
      };
      try {
        mkdirSync(tmp, { recursive: true });
        writeFileSync(jobPath, JSON.stringify({ register: lsdRegisterPath(), ...job }), 'utf8');
      } catch (e: any) { cleanup(); resolve({ ok: false, error: e.message }); return; }

      const [py, base] = pyArgs(script);
      const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      let errBuf = '';
      proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
      const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
      proc.on('error', (e: any) => { clearTimeout(killer); cleanup(); resolve({ ok: false, error: e.message }); });
      proc.on('close', () => {
        clearTimeout(killer);
        let out: any = null;
        try { if (existsSync(outPath)) out = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
        cleanup();
        resolve(out || { ok: false, error: errBuf.trim().slice(-400) || 'The register run produced no result.' });
      });
    });
  }

  // Turn a priced result plus whatever the form carried into one register row.
  // The engine owns the numbers; the form owns the words (status, notes, who
  // the deal belongs to) — nothing here invents a value the analyst would have
  // to correct in the sheet afterwards.
  function lsdRegisterRow(body: any, out: any): Record<string, unknown> {
    const cfg  = loadPyCfg() as any;
    const meta = out?.meta || {};
    const sum  = out?.summary || {};
    const ccy  = sum.currency || 'USD';
    // The daily sheet has no currency column, so a run that prices in the other
    // currency says so in the note rather than silently mixing the totals.
    // The engine's own one-liner is the note — it already says what changed,
    // what it costs and whether anything needs approving, which is exactly what
    // the register's Notes column is read for.
    const auto = sum.headline
      || [`Vector · ${sum.lines ?? 0} lines`,
          sum.overall_e2e != null ? `E2E ${(sum.overall_e2e * 100).toFixed(1)}%` : '',
          ccy].filter(Boolean).join(' · ');
    return {
      country:          body.country || meta.country || '',
      bu:               body.bu || cfg.lsd_bu || lsdBu(out?.lines || []),
      transaction:      body.transaction || meta.transaction || '',
      transaction_name: body.project || meta.project || '',
      customer:         body.customer || meta.customer || '',
      customer_name:    body.customer_name || meta.customer_name || '',
      status:           body.status || 'Priced',
      sales_name:       body.sales_name || cfg.lsd_sales_name || cfg.inside_sales || '',
      cpq_updated:      body.cpq_updated || '',
      total_value:      sum.grand_total ?? null,
      out_date:         body.out_date || new Date().toISOString().slice(0, 10),
      notes:            body.notes || auto,
      rpi_comment:      body.rpi_comment || '',
      rpi_comment_2:    body.rpi_comment_2 || '',
      pv_pct:           sum.overall_rpi ?? null,     // price variance only (ledger K6)
      rpi_pct:          sum.total_rpi ?? null,       // price + mix, the 6% gate
      rpi_value:        sum.rpi_value ?? null,
    };
  }

  // What the Quotations List needs and the daily sheet has no column for. It is
  // stored in a sidecar JSON beside the register, keyed on transaction number,
  // so the workbook stays exactly the analyst's layout.
  function lsdRegisterExtra(body: any, out: any): Record<string, unknown> {
    const meta = out?.meta || {};
    const sum  = out?.summary || {};
    return {
      crm:      body.crm || meta.crm || '',
      currency: sum.currency || '',
      country:  body.country || meta.country || '',
      lines:    sum.lines ?? null,
      e2e:      sum.overall_e2e ?? null,
    };
  }

  // The register as the tab shows it.
  app.get('/api/lsd/register', async (req, res) => {
    const out = await runRegister({ mode: 'rows', limit: Number(req.query.limit) || 300 });
    res.json({
      ...out,
      register: lsdRegisterPath(),
      name: path.basename(lsdRegisterPath()),
      sp: { site: (loadPyCfg() as any).sp_list || '', list: 'Quotations List',
            requestType: (loadPyCfg() as any).lsd_request_type || 'Standard CTO' },
      connected: !!getSpCookies(),
    });
  });

  // Register (or correct) one row by hand — the same upsert the build runs.
  app.post('/api/lsd/register', async (req, res) => {
    const row = (req.body || {}).row || req.body || {};
    if (!String(row.transaction || '').trim() && !String(row.transaction_name || '').trim()) {
      res.status(400).json({ ok: false, error: 'A register row needs a transaction number or name.' });
      return;
    }
    res.json(await runRegister({ mode: 'append', row, extra: (req.body || {}).extra || {} }));
  });

  // Post the register's transactions to SharePoint as list items — the same
  // 'Quotations List' the quote uploader writes to, so an LSD transaction reads
  // like every other quote in the factory list. The register file itself never
  // leaves the machine. Uses this session's JOE cookies, so a remote user posts
  // as themselves rather than as whoever the box belongs to.
  app.post('/api/lsd/register/push', async (req, res) => {
    const cookies = getSpCookies();
    if (!cookies) {
      res.status(400).json({ ok: false, error: 'Not connected to SharePoint — run Connect to JOE first.' });
      return;
    }
    const b   = (req.body || {}) as any;
    const cfg = loadPyCfg() as any;
    res.json(await runRegister({
      mode: 'push', fed: cookies.fed, rt: cookies.rt,
      sp_list: cfg.sp_list || '',
      // No list — post every row. A list of transaction numbers posts just those.
      transactions: Array.isArray(b.transactions) ? b.transactions : [],
      request_type: b.request_type || cfg.lsd_request_type || '',
      dry_run: !!b.dry_run,
    }, 300_000));
  });

  // Download the register itself. It lives outside the case root (it spans every
  // case), so it gets its own guard rather than insideCasesRoot().
  app.get('/api/lsd/register/file', (_req, res) => {
    const p = lsdRegisterPath();
    if (!existsSync(p)) { res.status(404).send('No register yet'); return; }
    res.setHeader('Content-Disposition', contentDisposition('attachment', path.basename(p)));
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(p).pipe(res);
  });

  // Download one produced file.
  app.get('/api/lsd/file', (req, res) => {
    const target = insideCasesRoot(String(req.query.path || ''));
    if (!target || !existsSync(target) || statSync(target).isDirectory()) {
      res.status(404).send('Not found'); return;
    }
    res.setHeader('Content-Disposition', contentDisposition('attachment', path.basename(target)));
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(target).pipe(res);
  });

  // ── Debug ──────────────────────────────────────────────────────────────────
  app.get('/api/debug', async (_req, res) => {
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    const hasCookies = !!cookies;
    let spStatus = 0, spBody = '', userName = null;
    if (cookies) {
      const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
      try {
        const r = await spGet(`${cfg.sp_list}/_api/web/currentUser`, cookieStr);
        spStatus = r.status;
        spBody   = r.body.slice(0, 500);
        if (r.ok) {
          const data = JSON.parse(r.body);
          userName = data?.d?.Title || data?.d?.LoginName || null;
        }
      } catch (e: any) { spBody = e.message; }
    }
    res.json({ hasCookies, fedLen: cookies?.fed?.length, rtLen: cookies?.rt?.length, spStatus, spBody, userName,
               // Errors that were caught and hidden since startup. An empty list is
               // the healthy case; a climbing count is where to look first.
               swallowed: swallowReport() });
  });

  // ── Current user from SharePoint ──────────────────────────────────────────
  app.get('/api/me', async (_req, res) => {
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) { res.json({ name: null }); return; }
    try {
      const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
      const r = await spGet(`${cfg.sp_list}/_api/web/currentUser`, cookieStr);
      if (r.ok) {
        const data = JSON.parse(r.body);
        const name = data?.d?.Title || data?.d?.LoginName?.split('|').pop() || null;
        res.json({ name });
      } else {
        res.json({ name: null, status: r.status });
      }
    } catch (e: any) { res.json({ name: null }); }
  });

  // ── Connection check ──────────────────────────────────────────────────────
  app.get('/api/connection', async (_req, res) => {
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) { res.json({ connected: false, name: null }); return; }
    try {
      const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
      const r = await spGet(`${cfg.sp_list}/_api/web/currentUser`, cookieStr);
      if (r.ok) {
        const data = JSON.parse(r.body);
        const name  = data?.d?.Title || null;
        const login = data?.d?.LoginName?.split('|').pop() || null;
        const email = login?.includes('@') ? login : null;
        res.json({ connected: true, name, email });
      } else {
        res.json({ connected: false, name: null, email: null });
      }
    } catch (e: any) { res.json({ connected: false, name: null, email: null }); }
  });

  // ── Debug: raw fields ─────────────────────────────────────────────────────
  app.get('/api/debug/fields', async (_req, res) => {
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) { res.json({ error: 'not connected to JOE — click Connect to JOE first' }); return; }
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    const r = await spGet(`${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items?$top=1`, cookieStr);
    if (r.ok) {
      const item = JSON.parse(r.body)?.d?.results?.[0] ?? {};
      const fields = Object.fromEntries(
        Object.entries(item).filter(([k]) => !k.startsWith('__') && k !== 'odata.metadata')
      );
      res.json({ fields, status: r.status });
    } else {
      res.json({ error: r.body.slice(0, 500), status: r.status });
    }
  });

  // ── Graph Bearer token helper ──────────────────────────────────────────────
  function getGraphToken(): string | null {
    for (const p of [pyFile('.graph_token'), path.join(__dirname, '.graph_token')]) {
      try {
        if (!existsSync(p)) continue;
        const t = (decSecret(readFileSync(p, 'utf8').trim()) || '').trim();
        if (t.length > 50) return t;
      } catch {}
    }
    return null;
  }

  function graphPost(endpoint: string, token: string, payload: object): Promise<{ ok: boolean; status: number; body: string }> {
    return new Promise(resolve => {
      const body = JSON.stringify(payload);
      const req  = httpsRequest({
        hostname: 'graph.microsoft.com',
        path: endpoint,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      }, res => {
        let b = '';
        res.on('data', d => { b += d; });
        res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', e => { swallow('graphPost', e); resolve({ ok: false, status: 0, body: '' }); });
      req.write(body);
      req.end();
    });
  }

  // ── Copilot / AI Search ────────────────────────────────────────────────────
  app.post('/api/copilot', async (req, res) => {
    const { query } = req.body as { query: string };
    if (!query?.trim()) { res.json({ answer: null, error: 'no question was sent' }); return; }

    const token = getGraphToken();
    const q     = query.trim();

    if (token) {
      try {
        const r = await graphPost('/v1.0/copilot/chat', token, {
          messages: [{ role: 'user', content: q }]
        });
        if (r.ok) {
          const data   = JSON.parse(r.body);
          const answer = data?.message?.content ?? data?.choices?.[0]?.message?.content;
          if (answer) { res.json({ answer, source: 'copilot' }); return; }
        }
      } catch {}

      try {
        const r = await graphPost('/v1.0/search/query', token, {
          requests: [{
            entityTypes: ['listItem'],
            query: { queryString: q },
            from: 0, size: 10,
            fields: ['Title', 'SALESFORCEID', 'CUSTOMER', 'QUOTATION_x0020_NAME',
                     'STATUS', 'PRICE', 'ARRIVED_x0020_ON', 'DIVISION', 'Country',
                     'REQUESTED_x0020_BY'],
          }]
        });
        if (r.ok) {
          const data = JSON.parse(r.body);
          const hits = data?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
          if (hits.length > 0) {
            const lines = hits.map((h: any) => {
              const f = h.resource?.fields ?? {};
              return `• ${[
                f.CUSTOMER             ? `Customer: ${f.CUSTOMER}` : '',
                f.QUOTATION_x0020_NAME ? `Quote: ${f.QUOTATION_x0020_NAME}` : '',
                f.Title                ? `Ref: ${f.Title}` : '',
                f.STATUS               ? `Status: ${f.STATUS}` : '',
                f.PRICE                ? `Price: €${f.PRICE}` : '',
                f.ARRIVED_x0020_ON     ? `Arrived: ${f.ARRIVED_x0020_ON.split('T')[0]}` : '',
              ].filter(Boolean).join(' · ')}`;
            }).join('\n');
            res.json({ answer: `Found ${hits.length} result(s) via Graph Search:\n\n${lines}`, source: 'graph-search' });
            return;
          }
        }
      } catch {}
    }

    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) { res.json({ answer: null, error: 'Not connected — click "Connect to JOE" first.' }); return; }

    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;

    try {
      const encoded = encodeURIComponent(`"${q}"`);
      const searchUrl = `${cfg.sp_list}/_api/search/query?querytext=${encoded}&selectproperties='Title,SALESFORCEID,CUSTOMER,QUOTATION_x0020_NAME,ARRIVED_x0020_ON,STATUS,PRICE,REQUEST_x0020_TYPE,DIVISION,Country,REQUESTED_x0020_BY'&sourceid='8413cd39-2156-4e00-b54d-11efd9abdb89'&rowlimit=20`;

      const sr = await spGet(searchUrl, cookieStr);

      if (sr.ok) {
        const data = JSON.parse(sr.body);
        const rows = data?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows?.results ?? [];

        if (rows.length > 0) {
          const items = rows.map((row: any) => {
            const cells: any[] = row.Cells?.results ?? [];
            const get = (k: string) => cells.find((c: any) => c.Key === k)?.Value ?? '';
            return {
              CUSTOMER:             get('CUSTOMER'),
              QUOTATION_x0020_NAME: get('QUOTATION_x0020_NAME'),
              Title:                get('Title'),
              SALESFORCEID:         get('SALESFORCEID'),
              STATUS:               get('STATUS'),
              PRICE:                get('PRICE'),
              ARRIVED_x0020_ON:     get('ARRIVED_x0020_ON'),
              DIVISION:             get('DIVISION'),
              Country:              get('Country'),
              REQUEST_x0020_TYPE:   get('REQUEST_x0020_TYPE'),
              REQUESTED_x0020_BY:   get('REQUESTED_x0020_BY'),
            };
          });

          const lines = items.slice(0, 10).map((item: any) =>
            `• ${[
              item.CUSTOMER             ? `Customer: ${item.CUSTOMER}` : '',
              item.QUOTATION_x0020_NAME ? `Quote: ${item.QUOTATION_x0020_NAME}` : '',
              item.Title                ? `Ref: ${item.Title}` : '',
              item.SALESFORCEID         ? `SF: ${item.SALESFORCEID}` : '',
              item.STATUS               ? `Status: ${item.STATUS}` : '',
              item.PRICE                ? `Price: €${item.PRICE}` : '',
              item.ARRIVED_x0020_ON     ? `Arrived: ${item.ARRIVED_x0020_ON.split('T')[0]}` : '',
            ].filter(Boolean).join(' · ')}`
          );

          const note = !token ? '\n\n_Tip: Reconnect to Joe to try Copilot for smarter answers._' : '';
          res.json({
            answer: `Found ${rows.length} result(s) for "${q}":\n\n${lines.join('\n')}${rows.length > 10 ? `\n…and ${rows.length - 10} more.` : ''}${note}`,
            results: items,
            source: 'sp-search'
          });
          return;
        }
      }

      const select = 'Id,Title,SALESFORCEID,CUSTOMER,QUOTATION_x0020_NAME,ARRIVED_x0020_ON,STATUS,PRICE,REQUEST_x0020_TYPE,DIVISION,Country,REQUESTED_x0020_BY';
      const ql     = q.toLowerCase();
      const words  = ql.split(/\s+/).filter(w => w.length > 1);

      const p1 = await spGet(`${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items?$select=${select}&$top=500&$orderby=Id desc`, cookieStr);
      const parse = (r: { ok: boolean; body: string }) => r.ok ? (JSON.parse(r.body)?.d?.results ?? []) : [];

      const scored = parse(p1).map((item: any) => {
        const text = [item.CUSTOMER, item.QUOTATION_x0020_NAME, item.Title, item.SALESFORCEID,
          item.DIVISION, item.Country, item.STATUS, item.REQUESTED_x0020_BY].filter(Boolean).join(' ').toLowerCase();
        return { item, score: words.filter(w => text.includes(w)).length };
      }).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score);

      if (scored.length === 0) {
        res.json({ answer: `No results found for "${q}".`, results: [], source: 'sp' });
        return;
      }

      const items = scored.map((x: any) => x.item);
      const lines = items.slice(0, 10).map((item: any) =>
        `• ${[
          item.CUSTOMER             ? `Customer: ${item.CUSTOMER}` : '',
          item.QUOTATION_x0020_NAME ? `Quote: ${item.QUOTATION_x0020_NAME}` : '',
          item.Title                ? `Ref: ${item.Title}` : '',
          item.SALESFORCEID         ? `SF: ${item.SALESFORCEID}` : '',
        ].filter(Boolean).join(' · ')}`
      );
      res.json({ answer: `Found ${scored.length} result(s) for "${q}":\n\n${lines.join('\n')}`, results: items.slice(0, 10), source: 'sp' });

    } catch (e: any) {
      res.json({ answer: null, error: `Search error: ${e.message}` });
    }
  });

  app.get('/api/copilot/status', (_req, res) => {
    res.json({ available: !!getGraphToken() });
  });

  // ── Search (now returns CUSTOMER, DIVISION, REQUESTED_x0020_BY too) ───────
  // ── Ask AI (Gemini) ────────────────────────────────────────────────────────
  app.post('/api/ai', async (req, res) => {
    const { query, history } = req.body as {
      query: string;
      history?: Array<{ role: string; text: string }>;
    };
    if (!query?.trim()) { res.json({ answer: null, error: 'no question was sent' }); return; }
    res.json(await chatAnswer(query, history));
  });

  app.get('/api/ai/status', (_req, res) => {
    res.json({ available: !!getGemini() });
  });

  // ── Binary exports (PDF / DOCX / XLSX) ──────────────────────────────────────
  // Text formats (txt/md/csv/html/json) are generated client-side; these three need
  // reportlab/openpyxl or OOXML zipping, so a Python script writes the file and we
  // stream the bytes back. Shared by the answer exporter and the job-report one.
  const EXPORT_MIME: Record<string, string> = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  function runExporter(res: Response, scriptName: string, fmt: string,
                       job: Record<string, unknown>, filename: string, timeoutMs = 60_000) {
    const script = pyFile(scriptName);
    if (!existsSync(script)) { res.status(500).json({ error: 'export_doc.py is missing from this install' }); return; }

    const tmpDir  = path.join(os.tmpdir(), `export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    try { mkdirSync(tmpDir, { recursive: true }); } catch {}
    const jobPath = path.join(tmpDir, 'job.json');
    const outPath = path.join(tmpDir, `out.${fmt}`);
    const cleanup = () => {
      for (const p of [jobPath, outPath]) { try { unlinkSync(p); } catch {} }
      try { rmdirSync(tmpDir); } catch {}
    };
    try {
      writeFileSync(jobPath, JSON.stringify({ ...job, format: fmt }), 'utf8');
    } catch (e: any) { cleanup(); res.status(500).json({ error: e.message }); return; }

    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--job', jobPath, '--out', outPath],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let errBuf = '';
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('error', (e: any) => {
      clearTimeout(killer); cleanup();
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
    proc.on('close', (code: number) => {
      clearTimeout(killer);
      if (code !== 0 || !existsSync(outPath)) {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: errBuf.trim() || 'Export failed' });
        return;
      }
      try {
        const buf  = readFileSync(outPath);
        const safe = String(filename || 'vector-export').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'vector-export';
        res.setHeader('Content-Type', EXPORT_MIME[fmt]);
        res.setHeader('Content-Disposition', contentDisposition('attachment', `${safe}.${fmt}`));
        res.end(buf);
      } catch (e: any) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
      } finally { cleanup(); }
    });
  }

  // Body: { format, content (light markdown), title, filename }.
  app.post('/api/export', (req, res) => {
    const { format, content, title, filename } = req.body as {
      format?: string; content?: string; title?: string; filename?: string;
    };
    const fmt = String(format || '').toLowerCase();
    if (!EXPORT_MIME[fmt]) { res.status(400).json({ error: 'that export format is not supported' }); return; }
    runExporter(res, 'export_doc.py', fmt,
      { title: title || '', content: content || '' }, String(filename || 'vector-export'), 30_000);
  });

  // ── Export the Job Report as a designed PDF / Word document ─────────────────
  // export_report.py lays the structured report out with KPI tiles, category bars,
  // an activity chart and a clickable contents page. The report itself is read from
  // the DB — the browser only says WHICH jobs are on screen (`convs`, in display
  // order) plus the colours it drew them in, so the request stays a few KB.
  app.post('/api/export/job-report', (req, res) => {
    const { format, convs, catColors, filter, owner, filename } = req.body as {
      format?: string; convs?: string[]; catColors?: Record<string, string>;
      filter?: { category?: string | null; query?: string }; owner?: string; filename?: string;
    };
    const fmt = String(format || '').toLowerCase();
    if (fmt !== 'pdf' && fmt !== 'docx') {
      res.status(400).json({ error: 'The job report exports to PDF or Word only' }); return;
    }

    const row = queryAll(`SELECT report FROM mail_job_meta WHERE id = 1`)[0] as any;
    let report: any = null;
    try { report = row?.report ? JSON.parse(row.report) : null; } catch { /* corrupt row */ }
    if (!report?.threads?.length) {
      res.status(400).json({ error: 'No report to export — build one first' }); return;
    }

    // Keep the on-screen selection and order; fall back to the whole report.
    const byConv = new Map<string, any>(report.threads.map((t: any) => [t.conv, t]));
    const picked = Array.isArray(convs) && convs.length
      ? convs.map(c => byConv.get(c)).filter(Boolean)
      : report.threads;
    if (!picked.length) { res.status(400).json({ error: 'No jobs to export' }); return; }

    runExporter(res, 'export_report.py', fmt, {
      title:       'Job report',
      range:       report.range,
      generatedAt: report.generatedAt,
      scanned:     report.totals?.scanned || 0,
      truncated:   !!report.truncated,
      owner:       String(owner || '').slice(0, 80),
      threads:     picked,
      catColors:   catColors && typeof catColors === 'object' ? catColors : {},
      filter: {
        total:    report.threads.length,
        category: filter?.category || null,
        query:    filter?.query || '',
      },
    }, String(filename || 'vector-job-report'), 90_000);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Outlook integration (win32com or Microsoft Graph) ─────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let outlookBackend = 'auto'; // 'auto' | 'imap' | 'graph' | 'win32'

  // `onProgress` receives each stderr line as it arrives — the long sweeps
  // (scan-jobs, scan-crm-quotes) report the folder they are on that way, which is
  // the only signal a caller has during a multi-minute walk of the mailbox.
  // `stdinPayload` is for anything that must NOT appear in the child's command
  // line. On Windows any process running as this user can read another process's
  // arguments, so a password passed as --body is readable machine-wide for as long
  // as the child lives; sent this way it stays in the pipe.
  async function runOutlookPy(
    args: string[],
    onProgress?: (line: string) => void,
    stdinPayload?: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const script = pyFile('outlook_reader.py');
      if (!existsSync(script)) { reject(new Error('outlook_reader.py not found')); return; }
      const [cmd, base] = pyArgs(script);
      const proc = spawn(cmd, [...base, '--backend', outlookBackend, ...args],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
                 // Lets any action re-read the mail index — used to re-find a
                 // message whose indexed EntryID went stale after a move.
                 MAGIC_MAIL_INDEX: path.join(DATA_DIR, 'mail_index.db') } });
      // Always close stdin: a reader waiting on EOF would otherwise hang forever.
      try {
        if (stdinPayload) proc.stdin.write(stdinPayload);
        proc.stdin.end();
      } catch { /* child already gone; 'error'/'close' below reports it */ }
      let out = '', err = '', tail = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        err += s;
        if (!onProgress) return;
        tail += s;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop() || '';
        for (const l of lines) { if (l.trim()) { try { onProgress(l.trim()); } catch { /* never kill the scan */ } } }
      });
      proc.on('error', (e: Error) => reject(e));
      proc.on('close', () => {
        // Surface the reader's own diagnostics (stale-EntryID recovery, etc.)
        for (const l of err.split(/\r?\n/)) if (l.startsWith('[outlook]')) console.log(l);
        try { resolve(JSON.parse(out.trim())); }
        catch { reject(new Error(err.trim() || out.trim() || 'No output')); }
      });
    });
  }

  // Fetch email attachments (images / PDFs) as Gemini inlineData parts so the
  // AI can actually read photos, diagrams and scanned tables inside an email.
  const VISION_MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.pdf': 'application/pdf',
  };
  async function attachmentParts(entryId: string, indices: number[]): Promise<any[]> {
    const parts: any[] = [];
    const tmpDir = path.join(os.tmpdir(), 'vector_sum');
    for (const idx of indices) {
      try {
        const att = await runOutlookPy(['--action', 'get-attachment', '--id', entryId, '--index', String(idx), '--dest', tmpDir]);
        if (att.error || !att.path) continue;
        const ext  = path.extname(att.path).toLowerCase();
        const mime = VISION_MIME[ext];
        if (!mime) continue;
        parts.push({ inlineData: { mimeType: mime, data: readFileSync(att.path).toString('base64') } });
        try { unlinkSync(att.path); } catch {}
      } catch { /* skip a bad attachment, keep the rest */ }
    }
    return parts;
  }

  app.get('/api/outlook/status', async (_req, res) => {
    try {
      const r = await runOutlookPy(['--action', 'status']);
      if (r.backend) outlookBackend = r.backend;
      if (!r.available) outlookBackend = 'auto';
      res.json(r);
    }
    catch (e: any) { res.json({ available: false, error: e.message }); }
  });

  // Current Outlook selection — used by the floating overlay companion app
  // (outlook_overlay.py) which polls this every ~2s to track what email
  // the user has highlighted.
  app.get('/api/outlook/current', async (_req, res) => {
    try {
      const r = await runOutlookPy(['--action', 'current-selection', '--backend', 'win32']);
      res.json(r);
    } catch (e: any) {
      res.json({ selected: false, error: e.message });
    }
  });

  // Stream the raw bytes of an Outlook attachment. The overlay uses this to
  // bundle attachments into a multipart submission to /api/schematics/price.
  app.get('/api/outlook/get-attachment', async (req, res) => {
    try {
      const entryId = String(req.query.entryId || '');
      const index   = parseInt(String(req.query.index || '0'), 10);
      if (!entryId || !index) { res.status(400).json({ error: 'the request did not say which attachment' }); return; }
      const tmpDir = path.join(os.tmpdir(), 'vector_overlay_att');
      const att = await runOutlookPy(['--action', 'get-attachment', '--id', entryId, '--index', String(index), '--dest', tmpDir]);
      if (att.error || !att.path || !existsSync(att.path)) {
        res.status(404).json({ error: att.error || 'attachment not found' });
        return;
      }
      const ext = path.extname(att.path).toLowerCase();
      const mime =
        ext === '.pdf'  ? 'application/pdf' :
        ext === '.png'  ? 'image/png'  :
        (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' :
        ext === '.gif'  ? 'image/gif'  :
        ext === '.webp' ? 'image/webp' :
        ext === '.bmp'  ? 'image/bmp'  :
                          'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', contentDisposition('inline', path.basename(att.path)));
      const buf = readFileSync(att.path);
      res.send(buf);
      try { unlinkSync(att.path); } catch {}
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // IMAP auth: test credentials and save imap_config.json
  app.post('/api/outlook/imap-config', async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) { res.json({ ok: false, error: 'Email and password required' }); return; }
    try {
      // Over stdin, never --body: command lines are readable by other processes.
      const r = await runOutlookPy(
        ['--action', 'imap-config', '--body-stdin', '1'], undefined,
        JSON.stringify({ email, password }),
      );
      if (r.ok) outlookBackend = 'imap';
      res.json(r);
    } catch (e: any) { res.json({ ok: false, error: e.message }); }
  });

  // Graph auth: opens browser for interactive Microsoft 365 sign-in
  app.post('/api/outlook/graph-connect', (_req, res) => {
    const script = pyFile('outlook_reader.py');
    if (!existsSync(script)) { res.json({ ok: false, error: 'outlook_reader.py is missing from this install' }); return; }
    const [cmd, base] = pyArgs(script);
    const proc = spawn(cmd, [...base, '--backend', 'graph', '--action', 'graph-connect'],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '', err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', (e: Error) => res.json({ ok: false, error: e.message }));
    proc.on('close', () => {
      try {
        const r = JSON.parse(out.trim());
        if (r.ok) outlookBackend = 'graph';
        res.json(r);
      } catch { res.json({ ok: false, error: err.trim() || out.trim() || 'No output' }); }
    });
  });

  app.get('/api/outlook/mailboxes', async (_req, res) => {
    try { res.json(await runOutlookPy(['--action', 'mailboxes'])); }
    catch (e: any) { res.json({ mailboxes: [], error: e.message }); }
  });

  // The Inbox pane silently refreshes every 30s. Outlook COM serialises, so when
  // anything slow is running (an index sync, a search) those refreshes used to
  // stack up as python processes all waiting on the same Outlook — 17 of them was
  // an observed steady state. Identical in-flight fetches now share one process.
  const emailsInFlight = new Map<string, Promise<any>>();

  app.get('/api/outlook/emails', async (req, res) => {
    const storeId = String(req.query.storeId || 'default');
    const limit   = String(Math.min(500, parseInt(String(req.query.limit || '30'), 10) || 30));
    const unread  = String(req.query.unread) === 'true' ? '1' : '0';
    const key     = `${storeId}:${limit}:${unread}`;
    try {
      let pending = emailsInFlight.get(key);
      if (!pending) {
        pending = runOutlookPy(['--action', 'emails', '--store', storeId, '--limit', limit, '--unread', unread])
          .finally(() => emailsInFlight.delete(key));
        emailsInFlight.set(key, pending);
      }
      res.json(await pending);
    }
    catch (e: any) { res.json({ emails: [], error: e.message }); }
  });

  // ── Mail search over the local index ──────────────────────────────────────
  // Scope is a hard allowlist (UKQuoteFactoryEL → Inbox + "Completed by Laith",
  // see SEARCH_SCOPE in outlook_reader.py), and those ~2.1k messages are mirrored
  // into SQLite. Reading a message through Outlook COM costs ~64 ms, so a live
  // search re-reads minutes' worth of mail every time; against the index the same
  // query is a millisecond LIKE. `--source auto` uses the index when it exists and
  // falls back to the live MAPI sweep while it is still being built.
  const MAIL_INDEX = path.join(DATA_DIR, 'mail_index.db');
  let indexSyncing: Promise<any> | null = null;

  // Reading the index from node (node:sqlite, built in since 22.5) keeps a search
  // at ~30 ms. Going through python instead costs ~1.6 s of interpreter startup
  // per keystroke-triggered query, which is most of what "slow" felt like.
  let SqliteDb: any = null;
  try { SqliteDb = createRequire(import.meta.url)('node:sqlite').DatabaseSync; }
  catch { /* older runtime — python does the reading instead */ }

  // "quoted phrases" stay whole; every term must match. Mirrors search_tokens().
  function searchTerms(q: string): string[] {
    const out: string[] = [];
    for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
      const t = (m[1] || m[2] || '').trim();
      if (t) out.push(t);
    }
    return out;
  }
  // % and _ are LIKE wildcards; a literal one in a search term must not widen it.
  const likeParam = (t: string) =>
    '%' + t.toLowerCase().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';

  // How a term has to sit in the text. LIKE '%term%' is always a substring, so
  // "gate" matches "delegate"; 'word' and 'start' narrow that. The boundary is
  // deliberately not \b — Eaton joins words with underscores and \w counts `_`
  // as a word character, so \bquote\b never fires inside EL_quote_2026_R2.
  // Mirrors MATCH_MODES / term_pattern() in outlook_reader.py.
  type MatchMode = 'part' | 'word' | 'start';
  const MATCH_MODES: MatchMode[] = ['part', 'word', 'start'];
  const WORD_CHAR = '[A-Za-z0-9]';
  const rxEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function termRegex(term: string, mode: MatchMode): RegExp {
    const esc = rxEscape(term);
    if (mode === 'word')  return new RegExp(`(?<!${WORD_CHAR})${esc}(?!${WORD_CHAR})`, 'i');
    if (mode === 'start') return new RegExp(`(?<!${WORD_CHAR})${esc}`, 'i');
    return new RegExp(esc, 'i');
  }
  const matchesMode = (text: string, rx: RegExp[]) => rx.every(r => r.test(text || ''));

  // A narrowing mode cannot be counted in SQL, so it post-filters LIKE
  // candidates; this caps what a query like "a" costs. Mirrors INDEX_SCAN_CAP.
  const INDEX_SCAN_CAP = 4000;
  const SNIPPET_PAD = 55;
  const SNIPPET_MAX = 3;

  // Where each term was actually found. A row only ever shows sender, subject and
  // the first 300 body characters, so a hit in the recipients, an attachment name
  // or 20 kB into the body used to arrive with nothing highlighted — the search
  // looked broken while being right. Mirrors match_snippets().
  function matchSnippets(fields: [string, string][], rx: RegExp[]) {
    const out: { field: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const [label, text] of fields) {
      if (!text) continue;
      for (const r of rx) {
        const m = r.exec(text);
        if (!m) continue;
        const a = Math.max(0, m.index - SNIPPET_PAD);
        const b = Math.min(text.length, m.index + m[0].length + SNIPPET_PAD);
        let snip = text.slice(a, b).replace(/\s+/g, ' ').trim();
        if (a > 0) snip = '…' + snip;
        if (b < text.length) snip = snip + '…';
        const key = label + '\u0000' + snip.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ field: label, text: snip });
        if (out.length >= SNIPPET_MAX) return out;
      }
    }
    return out;
  }

  // ─── Search filters ─────────────────────────────────────────────────────
  // Narrowing that runs alongside the terms instead of inside them. A query is
  // one question ("QW28237"); who it is from, when it landed and whether it
  // carried a PDF are separate axes. Mirrors index_where() in outlook_reader.py.
  type SearchScope = 'all' | 'meta' | 'subject' | 'from' | 'recipients' | 'atts' | 'body';
  const SEARCH_SCOPES: SearchScope[] = ['all', 'meta', 'subject', 'from', 'recipients', 'atts', 'body'];
  // The SQL each scope matches on. Lowercase throughout: meta_blob/blob already
  // are, and LIKE has to see the same case on both sides.
  const SCOPE_SQL: Record<SearchScope, string> = {
    all:        'blob',
    meta:       'meta_blob',
    subject:    "lower(coalesce(subject, ''))",
    from:       "lower(coalesce(sender, '') || ' ' || coalesce(sender_email, ''))",
    recipients: "lower(coalesce(recipients, ''))",
    atts:       "lower(coalesce(atts, ''))",
    body:       "lower(coalesce(body_text, ''))",
  };
  // The same text, off a fetched row, for the match-mode re-check.
  function scopeText(r: any, scope: SearchScope): string {
    switch (scope) {
      case 'meta':       return r.meta_blob || '';
      case 'subject':    return r.subject || '';
      case 'from':       return `${r.sender || ''} ${r.sender_email || ''}`;
      case 'recipients': return r.recipients || '';
      case 'atts':       return r.atts || '';
      case 'body':       return r.body_text || '';
      default:           return r.blob || '';
    }
  }

  type SearchFilters = {
    from?: string;                       // substring of sender name or address
    since?: string; until?: string;      // YYYY-MM-DD, inclusive
    folder?: string;                     // substring of the folder path
    att?: 'any' | 'yes' | 'no' | 'pdf';
    read?: 'any' | 'read' | 'unread';
    sort?: 'new' | 'old';
  };

  // 'YYYY-MM-DD' (what a date input sends) or 'DD/MM/YYYY' -> the index's
  // 'YYYYMMDD' stamp prefix. Anything else is treated as no bound at all.
  function stampDay(s: string): string | null {
    const t = (s || '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    let y: number, mo: number, d: number;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${String(y).padStart(4, '0')}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  }

  // The filter half of the WHERE clause. `active` is echoed back so the UI can
  // state what was applied rather than trust that a flag survived the trip.
  function filterClauses(f: SearchFilters) {
    const where: string[] = [];
    const params: any[] = [];
    const active: Record<string, string> = {};

    const from = (f.from || '').trim();
    if (from) {
      where.push(`(lower(coalesce(sender, '')) LIKE ? ESCAPE '\\'`
               + ` OR lower(coalesce(sender_email, '')) LIKE ? ESCAPE '\\')`);
      params.push(likeParam(from), likeParam(from));
      active.from = from;
    }
    const lo = stampDay(f.since || '');
    const hi = stampDay(f.until || '');
    if (lo) { where.push('stamp >= ?'); params.push(lo + '000000'); active.since = lo; }
    if (hi) { where.push('stamp <= ?'); params.push(hi + '235959'); active.until = hi; }

    const folder = (f.folder || '').trim();
    if (folder) {
      where.push(`lower(coalesce(folder, '')) LIKE ? ESCAPE '\\'`);
      params.push(likeParam(folder));
      active.folder = folder;
    }
    if (f.att === 'yes')      { where.push(`coalesce(atts, '[]') NOT IN ('[]', '')`); active.att = 'yes'; }
    else if (f.att === 'no')  { where.push(`coalesce(atts, '[]') IN ('[]', '')`);     active.att = 'no'; }
    else if (f.att === 'pdf') { where.push('has_pdf = 1');                            active.att = 'pdf'; }

    if (f.read === 'unread')    { where.push('unread = 1'); active.read = 'unread'; }
    else if (f.read === 'read') { where.push('unread = 0'); active.read = 'read'; }

    return { where, params, active };
  }

  // What is actually IN the index. The From filter offers real addresses rather
  // than making someone guess how Outlook spells a name.
  function mailIndexFacets(limit = 60): any {
    if (!SqliteDb || !existsSync(MAIL_INDEX)) return null;
    let db: any = null;
    try {
      db = new SqliteDb(MAIL_INDEX);
      const total = db.prepare('SELECT COUNT(*) AS c FROM mail').get().c as number;
      const senders = db.prepare(
        'SELECT sender AS name, sender_email AS email, COUNT(*) AS count FROM mail'
        + ' GROUP BY lower(coalesce(sender_email, sender)) ORDER BY count DESC LIMIT ?').all(limit);
      const folders = db.prepare(
        'SELECT folder, COUNT(*) AS count FROM mail GROUP BY folder ORDER BY count DESC').all();
      const span = db.prepare("SELECT MIN(stamp) AS lo, MAX(stamp) AS hi FROM mail WHERE stamp <> ''").get();
      const iso = (s: string) => (s && s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
      return { built: total > 0, total, senders, folders,
               oldest: iso(span?.lo || ''), newest: iso(span?.hi || '') };
    } catch (e: any) {
      swallow('mailIndex.facets', e);
      return null;
    } finally {
      try { db?.close(); } catch (e) { swallow('mailIndex.close', e); }
    }
  }

  function searchMailIndex(q: string, limit: number, scope: SearchScope, mode: MatchMode,
                           filters: SearchFilters): any | null {
    if (!SqliteDb || !existsSync(MAIL_INDEX)) return null;
    const terms = searchTerms(q);
    const flt = filterClauses(filters);
    // A filter narrows on its own — "everything from Fenton with a PDF this
    // month" needs no term — so only a request with neither is empty.
    if (!terms.length && !flt.where.length) return null;
    let db: any = null;
    try {
      db = new SqliteDb(MAIL_INDEX);
      const indexTotal = db.prepare('SELECT COUNT(*) AS c FROM mail').get().c as number;
      if (!indexTotal) return null;
      const metaOnly = scope !== 'all' && scope !== 'body';
      const col     = SCOPE_SQL[scope];
      const clauses = terms.map(() => `${col} LIKE ? ESCAPE '\\'`).concat(flt.where);
      const where   = clauses.length ? clauses.join(' AND ') : '1';
      const params  = terms.map(likeParam).concat(flt.params);
      const rx      = terms.map(t => termRegex(t, mode));
      const order   = filters.sort === 'old' ? 'ASC' : 'DESC';
      // body_text arrived with the match-snippet work; an index written before it
      // has no such column, and reading it would throw instead of degrading.
      const hasBodyText = (db.prepare('PRAGMA table_info(mail)').all() as any[])
        .some(c => c.name === 'body_text');
      const sql = 'SELECT entry_id, store, store_id, folder, subject, sender, sender_email, received,' +
        ' body_preview, atts, unread, has_pdf, recipients, meta_blob, blob' +
        (hasBodyText ? ', body_text' : ', NULL AS body_text') +
        ` FROM mail WHERE ${where} ORDER BY stamp ${order} LIMIT ?`;
      let total: number;
      let rows: any[];
      let truncated = false;
      if (mode === 'part' || !terms.length) {
        // LIKE already IS the answer, so the count stays one cheap query.
        total = db.prepare(`SELECT COUNT(*) AS c FROM mail WHERE ${where}`).get(...params).c as number;
        rows  = db.prepare(sql).all(...params, limit) as any[];
      } else {
        const cand = db.prepare(sql).all(...params, INDEX_SCAN_CAP) as any[];
        truncated  = cand.length >= INDEX_SCAN_CAP;
        const kept = cand.filter(r => matchesMode(scopeText(r, scope), rx));
        total = kept.length;
        rows  = kept.slice(0, limit);
      }
      const last = db.prepare("SELECT v FROM meta WHERE k = 'last_sync'").get() as any;
      return {
        emails: rows.map(r => {
          const atts = (() => { try { return JSON.parse(r.atts || '[]'); } catch { return []; } })();
          // Attribute the hit to a real field rather than to the search blob, so
          // the UI can say "found in Attachments" and quote the line it hit.
          const snipFields: [string, string][] = [
            ['Subject', r.subject || ''], ['From', r.sender || ''], ['Email', r.sender_email || ''],
            ['To/CC', r.recipients || ''],
            ['Attachments', atts.map((a: any) => a?.name || '').join(' ')],
          ];
          if (!metaOnly) {
            // body_text is NULL on rows written before the column existed; the
            // lowercase blob minus its meta prefix is the same text, flattened.
            const body = r.body_text || String(r.blob || '').slice(String(r.meta_blob || '').length + 1);
            snipFields.push(['Body', body]);
          }
          return {
            entryId: r.entry_id, store: r.store, storeId: r.store_id, folder: r.folder,
            subject: r.subject, sender: r.sender, senderEmail: r.sender_email, received: r.received,
            bodyPreview: r.body_preview,
            attachments: atts,
            unread: !!r.unread, hasPdf: !!r.has_pdf,
            matches: matchSnippets(snipFields, rx),
          };
        }),
        total, source: 'index', indexTotal, lastSync: last?.v ?? null,
        truncated, degraded: 0, query: q, mode,
        scope, sort: order === 'ASC' ? 'old' : 'new', filters: flt.active,
      };
    } catch (e: any) {
      swallow('mailIndex.read', e);
      console.warn('[mail-index] read failed:', e.message);
      return null;
    } finally {
      try { db?.close(); } catch (e) { swallow('mailIndex.close', e); }
    }
  }

  function syncMailIndex(full = false): Promise<any> {
    // One sync at a time — Outlook COM serialises anyway, and overlapping runs
    // just pile up python processes waiting on it.
    if (indexSyncing) return indexSyncing;
    const args = ['--action', 'index', '--dest', MAIL_INDEX, '--timeout', '900', '--backend', 'win32'];
    if (full) args.push('--full', '1');
    indexSyncing = runOutlookPy(args)
      .then(r => { if (r?.error) console.warn('[mail-index]', r.error); return r; })
      .catch(e => { console.warn('[mail-index] sync failed:', e.message); return { ok: false, error: e.message }; })
      .finally(() => { indexSyncing = null; });
    return indexSyncing;
  }

  app.get('/api/outlook/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit   = String(Math.min(500, parseInt(String(req.query.limit || '200'), 10) || 200));
    // `scope` is the finer way of saying what `fields` said: all/meta stay, and
    // subject/from/recipients/atts/body narrow the terms to one field.
    const scope: SearchScope = (SEARCH_SCOPES as string[]).includes(String(req.query.scope))
      ? String(req.query.scope) as SearchScope
      : (req.query.fields === 'meta' ? 'meta' : 'all');
    const source  = ['index', 'live', 'auto'].includes(String(req.query.source)) ? String(req.query.source) : 'auto';
    const mode    = (MATCH_MODES as string[]).includes(String(req.query.mode))
      ? String(req.query.mode) as MatchMode : 'part';
    const timeout = String(Math.min(280, parseInt(String(req.query.timeout || '200'), 10) || 200));
    const one = <T extends string>(v: any, allowed: T[], dflt: T): T =>
      (allowed as string[]).includes(String(v)) ? String(v) as T : dflt;
    const filters: SearchFilters = {
      from:   String(req.query.from || '').trim().slice(0, 200),
      since:  String(req.query.since || '').trim(),
      until:  String(req.query.until || '').trim(),
      folder: String(req.query.folder || '').trim().slice(0, 200),
      att:    one(req.query.att,  ['any', 'yes', 'no', 'pdf'] as const, 'any'),
      read:   one(req.query.read, ['any', 'read', 'unread'] as const, 'any'),
      sort:   one(req.query.sort, ['new', 'old'] as const, 'new'),
    };
    // A filter narrows on its own, so an empty box is only an error when nothing
    // else was asked for either.
    const anyFilter = !!(filters.from || filters.since || filters.until || filters.folder
      || (filters.att && filters.att !== 'any') || (filters.read && filters.read !== 'any'));
    if (!q && !anyFilter) { res.json({ emails: [], error: 'type something to search for, or set a filter' }); return; }
    if (source !== 'live') {
      const hit = searchMailIndex(q, Number(limit), scope, mode, filters);
      if (hit) { res.json(hit); return; }
      if (source === 'index') {
        res.json({ emails: [], total: 0, source: 'index',
                   error: 'The local mail index has not been built yet' });
        if (!indexSyncing) void syncMailIndex();
        return;
      }
    }
    try {
      const r = await runOutlookPy([
        '--action', 'search', '--query', q, '--limit', limit,
        '--fields', scope === 'all' || scope === 'body' ? 'all' : 'meta', '--scope', scope,
        '--since', filters.since || '', '--until', filters.until || '',
        '--sender', filters.from || '', '--folder', filters.folder || '',
        '--att', filters.att || '', '--read', filters.read || '', '--sort', filters.sort || 'new',
        '--source', source, '--dest', MAIL_INDEX, '--mode', mode,
        '--attachments', '1', '--timeout', timeout, '--backend', 'win32',
      ]);
      // A live answer means the index was cold — start building it so the next
      // search is instant.
      if (r && r.source !== 'index' && !indexSyncing) void syncMailIndex();
      res.json(r);
    } catch (e: any) { res.json({ emails: [], error: e.message }); }
  });

  // The values the filters offer: who has actually written, which folders the
  // index covers, and how far back it reaches.
  app.get('/api/outlook/search/facets', async (_req, res) => {
    const local = mailIndexFacets();
    if (local) { res.json(local); return; }
    try { res.json(await runOutlookPy(['--action', 'search-facets', '--dest', MAIL_INDEX, '--limit', '60'])); }
    catch (e: any) { res.json({ built: false, senders: [], folders: [], error: e.message }); }
  });

  app.get('/api/outlook/index/status', async (_req, res) => {
    try {
      const r = await runOutlookPy(['--action', 'index-status', '--dest', MAIL_INDEX]);
      res.json({ ...r, syncing: !!indexSyncing });
    } catch (e: any) { res.json({ built: false, total: 0, folders: [], error: e.message }); }
  });

  app.post('/api/outlook/index/sync', async (req, res) => {
    const full = !!(req.body || {}).full;
    try { res.json(await syncMailIndex(full)); }
    catch (e: any) { res.json({ ok: false, error: e.message }); }
  });

  // Keep the index warm: a first pass shortly after boot, then top-ups. An
  // incremental run walks off the end of the new mail in seconds.
  setTimeout(() => { void syncMailIndex(); }, 20_000);
  setInterval(() => { void syncMailIndex(); }, 10 * 60_000);

  app.get('/api/outlook/email/:id', async (req, res) => {
    // `store` comes from the search hit that was clicked. Without it Outlook
    // resolves the EntryID against the DEFAULT store only, which fails for any
    // message living in a shared mailbox.
    const store = String(req.query.store || 'default');
    console.log(`[outlook] open id=${req.params.id.slice(0, 40)}… store=${store.slice(0, 24)}…`);
    try { res.json(await runOutlookPy(['--action', 'email', '--id', req.params.id, '--store', store])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  app.post('/api/outlook/save-attachment', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'the request did not say which email' }); return; }
    const dest = path.join(loadPyCfg().base, 'PDF Quotes');
    try { res.json(await runOutlookPy(['--action', 'save-attachment', '--id', entryId, '--dest', dest])); }
    catch (e: any) { res.json({ error: e.message, saved: [] }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Quick check-up: quote mail that never reached the Quotations List ─────
  // ══════════════════════════════════════════════════════════════════════════
  // The scan finds quote mail in the Inbox tree; THIS decides what is missing,
  // and it asks SharePoint live rather than trusting the local crm_quote mirror
  // (that snapshot is only as fresh as the last CRM sync, and a stale "missing"
  // verdict here means re-uploading a quote that is already filed).

  // Mirror of Automation_V4.normalize_sfid: drop the revision suffix, expand the
  // short SR00…/CR00… form to the 18-char id SharePoint stores.
  function normalizeSfid(ref: string): string {
    let s = (ref || '').trim();
    if (!s) return s;
    if (s.includes('-')) s = s.split('-')[0];
    if (s.length >= 4 && s.slice(2, 4) === '00' && /^[A-Za-z]{2}$/.test(s.slice(0, 2))) {
      s = '006QO00000' + s.slice(4);
    }
    return s;
  }

  // Is this reference already a row in the Quotations List? Cached per run so
  // several mails carrying the same reference cost one HTTP call, not N.
  //
  // TWO identifier systems are in play and both must be checked:
  //   - Salesforce ids (SR00…/CR00… → 006QO00000…) live in SALESFORCEID.
  //   - BidManager numbers (QW28237, QB27005A2R) live in TITLE, and those rows
  //     usually have NO SALESFORCEID at all. Manualnotification quote mail —
  //     the main source — is identified this way, so checking only SALESFORCEID
  //     reports every BidManager quote as unverifiable and invites a re-upload.
  // Title is matched with substringof, not eq: stored titles carry revision
  // suffixes ("QW27351A") and sometimes a leading space.
  async function refOnSharePoint(
    kind: 'sfid' | 'bm', ref: string, cookieStr: string, cfg: Record<string, string>,
    cache: Map<string, any>,
  ): Promise<{ known: boolean; item: any | null; checked: boolean }> {
    const key = `${kind}:${ref}`;
    if (cache.has(key)) return cache.get(key);
    const safe   = ref.replace(/'/g, "''");
    const select = 'Id,Title,SALESFORCEID,QUOTATION_x0020_NAME,CUSTOMER,STATUS';
    const filter = kind === 'sfid'
      ? `SALESFORCEID eq '${safe}'`
      : `substringof('${safe}',Title)`;
    const url = `${cfg.sp_list}/_api/web/lists/getbytitle('Quotations%20List')/items`
              + `?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=1`;
    let out = { known: false, item: null as any, checked: false };
    try {
      const r = await spGet(url, cookieStr);
      if (r.ok) {
        const rows = JSON.parse(r.body)?.d?.results ?? [];
        out = { known: rows.length > 0, item: rows[0] || null, checked: true };
      }
    } catch { /* leave checked:false — reported as "couldn't verify", never as "missing" */ }
    cache.set(key, out);
    return out;
  }

  // GET /api/quotes/checkup?days=30
  app.get('/api/quotes/checkup', async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const cfg  = loadPyCfg();

    let scan: any;
    try {
      scan = await runOutlookPy(['--action', 'scan-quotes', '--days', String(days), '--backend', 'win32']);
    } catch (e: any) {
      res.json({ items: [], error: `Couldn't read Outlook: ${e.message}` }); return;
    }
    if (scan?.error) { res.json({ items: [], error: scan.error }); return; }

    const cookies   = getSpCookies();
    const cookieStr = cookies ? `FedAuth=${cookies.fed}; rtFa=${cookies.rt}` : '';
    const cache     = new Map<string, any>();

    // Already sitting in the local queue, or already run through Step 1 here.
    const queueDir = path.join(cfg.base, 'PDF Quotes');
    let queued: string[] = [];
    try { queued = readdirSync(queueDir).map(f => f.toLowerCase()); } catch {}
    const doneSfids = new Set(
      queryAll(`SELECT DISTINCT sfId FROM jobs WHERE sfId IS NOT NULL AND sfId != '' AND status = 'ok'`)
        .map(r => normalizeSfid(String(r.sfId)).toLowerCase()),
    );

    const items: any[] = [];
    for (const q of (scan.quotes || [])) {
      const refs:   Array<{ raw: string; norm: string }> = q.refs || [];
      const bmRefs: Array<{ raw: string; base: string }> = q.bmRefs || [];

      const lookups: Array<['sfid' | 'bm', string]> = [
        ...refs.map(r => ['sfid', r.norm] as ['sfid', string]),
        ...bmRefs.map(b => ['bm', b.base] as ['bm', string]),
      ];

      let onSp = false, spItem: any = null, verified = false;
      for (const [kind, value] of lookups) {
        if (!cookieStr) break;
        const hit = await refOnSharePoint(kind, value, cookieStr, cfg, cache);
        if (hit.checked) verified = true;
        if (hit.known) { onSp = true; spItem = hit.item; break; }
      }

      const inQueue  = (q.docs || []).some((d: any) => queued.includes(String(d.name).toLowerCase()));
      const ranLocal = refs.some(r => doneSfids.has(r.norm.toLowerCase()));

      // Only ever call something "missing" when SharePoint actually answered.
      const status = onSp ? 'uploaded'
        : inQueue          ? 'queued'
        : ranLocal         ? 'processed'
        : verified         ? 'missing'
        : lookups.length   ? 'unverified'
        : 'noref';

      items.push({
        entryId:  q.entryId,
        subject:  q.subject,
        sender:   q.sender,
        senderEmail: q.senderEmail,
        received: q.received,
        folder:   q.folder,
        isNotification: q.isNotification,
        refs:     [...refs.map(r => r.raw), ...bmRefs.map(b => b.raw)],
        sfid:     refs[0]?.norm || bmRefs[0]?.base || null,
        docs:     q.docs || [],
        status,
        spTitle:    spItem?.Title || spItem?.QUOTATION_x0020_NAME || null,
        spCustomer: spItem?.CUSTOMER || null,
      });
    }

    res.json({
      items,
      scanned:   scan.scanned ?? 0,
      days,
      connected: !!cookieStr,
      counts: {
        missing:    items.filter(i => i.status === 'missing').length,
        unverified: items.filter(i => i.status === 'unverified').length,
        uploaded:   items.filter(i => i.status === 'uploaded').length,
        queued:     items.filter(i => i.status === 'queued').length,
      },
      warning: cookieStr ? null
        : 'Not connected to JOE — Vector could not check SharePoint, so nothing is confirmed missing. Connect and re-run.',
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Job report: what work actually got done over a period ─────────────────
  // ══════════════════════════════════════════════════════════════════════════
  // Sweeps EVERY mail folder (including hand-made ones like "Completed by
  // Laith"), groups messages into conversations — one thread = one job — and
  // sorts each into a generic category. A full-mailbox sweep takes minutes, so
  // it runs in the background with a polled status, like the CRM sync.

  const DEFAULT_JOB_CATEGORIES = [
    'Technical response',
    'Pricing / quotation',
    'PMO',
    'Forwarding / routing',
    'Quote upload / SharePoint',
    'D&Q filing',
    'Meetings / internal',
    'Admin / other',
  ];

  function jobCategories(): string[] {
    const raw = (loadPyCfg() as any).job_categories;
    if (Array.isArray(raw) && raw.length) {
      const clean = raw.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 20);
      if (clean.length) return clean;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const clean = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean).slice(0, 20);
      if (clean.length) return clean;
    }
    return DEFAULT_JOB_CATEGORIES;
  }

  type JobsReportState = {
    running: boolean;
    phase: 'idle' | 'scanning' | 'grouping' | 'classifying' | 'done' | 'error';
    message: string;
    messages: number; threads: number; classified: number; toClassify: number;
    from: string; to: string;
    error: string | null;
    truncated: boolean;
    startedAt: string | null;
  };
  const jobsReport: JobsReportState = {
    running: false, phase: 'idle', message: '', messages: 0, threads: 0,
    classified: 0, toClassify: 0, from: '', to: '', error: null,
    truncated: false, startedAt: null,
  };

  // Ask the fast model to sort a batch of threads into the configured buckets.
  async function classifyThreadBatch(
    batch: Array<{ i: number; topic: string; counterpart: string; folders: string; sample: string }>,
    cats: string[],
  ): Promise<Map<number, { category: string; summary: string }>> {
    const out = new Map<number, { category: string; summary: string }>();
    const ai  = getGemini();
    if (!ai) return out;

    const lines = batch.map(b =>
      `${b.i}. SUBJECT: ${b.topic.replace(/\s+/g, ' ').slice(0, 150)}\n`
      + `   WITH: ${b.counterpart.slice(0, 90)} | FILED IN: ${b.folders.slice(0, 90)}\n`
      + `   OPENING: ${b.sample.replace(/\s+/g, ' ').slice(0, 320)}`,
    ).join('\n\n');

    const prompt =
      'You are classifying the work an Eaton emergency-lighting quote/PMO engineer did, one email THREAD per entry. '
      + 'For each thread decide which single category best describes THE WORK HE DID, and write a very short factual line saying what was done.\n\n'
      + `Categories (use EXACTLY one of these strings, nothing else):\n${cats.map(c => `- ${c}`).join('\n')}\n\n`
      + 'Rules:\n'
      + '- Judge by the work, not the wording. A thread where he sent specs/product advice is a technical response; one where he issued or chased a price is pricing; project-management coordination is PMO; simply passing a mail to someone else is forwarding.\n'
      + '- IGNORE boilerplate in the opening text — out-of-office notices, ticket auto-acknowledgements, signatures, confidentiality footers. Classify the underlying job the thread is about, never the auto-reply. If the opening text is ONLY boilerplate, judge from the subject alone.\n'
      + `- If nothing fits, use "${cats[cats.length - 1]}". Never invent a category.\n`
      + '- "summary": max 12 words, factual, no pronouns, e.g. "Quoted CGLine+ replacement for Glasgow refurb".\n\n'
      + `Threads:\n${lines}\n\n`
      + 'Return ONLY a JSON array: [{"i":<number>,"category":"<exact category>","summary":"<short line>"}]';

    try {
      const r = await generateWithRetry(ai, {
        model: AI_MODEL_FAST,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 4000, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      });
      const txt = r.text ?? '';
      const m   = txt.match(/\[[\s\S]*\]/);
      if (!m) return out;
      const arr = JSON.parse(m[0]);
      const valid = new Set(cats.map(c => c.toLowerCase()));
      for (const row of (Array.isArray(arr) ? arr : [])) {
        const i = Number(row?.i);
        if (!Number.isFinite(i)) continue;
        let cat = String(row?.category || '').trim();
        if (!valid.has(cat.toLowerCase())) cat = cats[cats.length - 1];
        else cat = cats.find(c => c.toLowerCase() === cat.toLowerCase())!;
        out.set(i, { category: cat, summary: String(row?.summary || '').trim().slice(0, 120) });
      }
    } catch (e: any) {
      console.warn('[jobs-report] classify batch failed:', e.message);
    }
    return out;
  }

  async function runJobsReport(from: string, to: string) {
    jobsReport.running = true;
    jobsReport.phase = 'scanning';
    jobsReport.error = null;
    jobsReport.messages = jobsReport.threads = jobsReport.classified = jobsReport.toClassify = 0;
    jobsReport.truncated = false;
    jobsReport.from = from; jobsReport.to = to;
    jobsReport.startedAt = new Date().toISOString();
    jobsReport.message = 'Reading every mail folder…';

    try {
      const scan = await runOutlookPy([
        '--action', 'scan-jobs', '--since', from, '--until', to,
        '--max', '20000', '--backend', 'win32',
      ]);
      if (scan?.error) throw new Error(scan.error);

      const msgs: any[] = scan.messages || [];
      jobsReport.messages  = msgs.length;
      jobsReport.truncated = !!scan.truncated;
      jobsReport.phase     = 'grouping';
      jobsReport.message   = `Grouping ${msgs.length} messages into threads…`;

      const me = String(scan.me || '').toLowerCase();

      // The shared quote-factory mailbox holds one "Completed by <person>" folder
      // per engineer. Filing a thread in MY completed folder is proof I did it;
      // finding it in a colleague's is proof I did NOT. Getting this wrong would
      // silently credit Rida's and Josh's work to this report.
      const meTokens = String(scan.meName || '')
        .toLowerCase().split(/[^a-z]+/).filter(t => t.length > 2);
      const localPart = me.split('@')[0].toLowerCase();
      for (const t of localPart.split(/[^a-z]+/)) if (t.length > 2) meTokens.push(t);

      // 'mine' | 'theirs' | null (not a completed-style folder at all)
      function completedOwner(leaf: string): 'mine' | 'theirs' | null {
        const m = /^(?:completed|done|finished)\b(.*)$/i.exec(leaf.trim());
        if (!m) return null;
        const who = m[1].replace(/^[\s-]*by[\s-]*/i, '').trim().toLowerCase();
        if (!who) return 'mine';                                  // a plain "Completed" folder
        if (meTokens.some(t => who.includes(t))) return 'mine';
        return 'theirs';
      }

      // ── Group into conversations ────────────────────────────────────────────
      type Thread = {
        conv: string; topic: string; msgs: number; sent: number;
        first: string; last: string; folders: Set<string>;
        others: Set<string>; sample: string; hasAtt: boolean;
        completed: boolean; foreign: boolean; human: boolean;
      };
      const samples: Record<string, string> = scan.samples || {};
      const threads = new Map<string, Thread>();
      for (const m of msgs) {
        let t = threads.get(m.conv);
        if (!t) {
          t = {
            conv: m.conv, topic: m.topic || m.subject, msgs: 0, sent: 0,
            first: m.date, last: m.date, folders: new Set(), others: new Set(),
            sample: samples[m.conv] || '', hasAtt: false,
            completed: false, foreign: false, human: false,
          };
          threads.set(m.conv, t);
        }
        t.msgs++;
        // An out-of-office bounce or a ticket auto-acknowledgement is not work.
        // It must not count as a reply, and a thread made only of them is not a job.
        if (!m.auto) t.human = true;
        if (m.direction === 'sent' && !m.auto) t.sent++;
        if (m.date && m.date < t.first) t.first = m.date;
        if (m.date && m.date > t.last)  t.last  = m.date;
        if (m.folder) {
          const leaf = String(m.folder).split('\\').pop() || m.folder;
          t.folders.add(leaf);
          const owner = completedOwner(leaf);
          if (owner === 'mine')   t.completed = true;
          if (owner === 'theirs') t.foreign   = true;
        }
        const addr = String(m.senderEmail || '').toLowerCase();
        if (addr && addr !== me && !m.auto) t.others.add(m.senderEmail);
        if (m.atts) t.hasAtt = true;
      }

      // A "job done" = a thread actually worked here: replied to, or filed into
      // MY completed folder. Threads only ever received and never touched are
      // noise; threads filed under a colleague's name are their work, not mine —
      // unless I also replied in them.
      const worked = [...threads.values()]
        .filter(t => t.human
                  && (t.sent > 0 || t.completed)
                  && !(t.foreign && !t.completed && t.sent === 0));
      jobsReport.threads = worked.length;

      // ── Classify only what changed since last time ──────────────────────────
      const sigOf = (t: Thread) => hashStr(`${t.msgs}|${t.last}|${t.sent}`);
      const cats  = jobCategories();
      // Bump CLASSIFIER_REV whenever the prompt or the sampling rule changes, so
      // rows cached under the old behaviour are re-classified instead of served stale.
      const CLASSIFIER_REV = 2;
      const catKey = hashStr(`v${CLASSIFIER_REV}|${cats.join('|')}`);

      const pending: Array<{ i: number; topic: string; counterpart: string; folders: string; sample: string; t: Thread }> = [];
      const cached  = new Map<string, { category: string; summary: string }>();
      for (const t of worked) {
        const row = queryAll(`SELECT category, summary, sig FROM mail_job WHERE conv = ?`, [t.conv])[0] as any;
        const want = `${sigOf(t)}:${catKey}`;
        if (row && row.sig === want && row.category) {
          cached.set(t.conv, { category: row.category, summary: row.summary || '' });
        } else {
          pending.push({
            i: pending.length,
            topic: t.topic,
            counterpart: [...t.others].slice(0, 3).join(', '),
            folders: [...t.folders].slice(0, 3).join(', '),
            sample: t.sample,
            t,
          });
        }
      }
      jobsReport.toClassify = pending.length;
      jobsReport.phase   = 'classifying';
      jobsReport.message = pending.length
        ? `Sorting ${pending.length} threads into categories…`
        : 'All threads already categorised.';

      const BATCH = 20;
      for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH).map((p, k) => ({ ...p, i: k }));
        const got   = await classifyThreadBatch(slice, cats);
        const now   = new Date().toISOString();
        for (const p of slice) {
          const hit = got.get(p.i) || { category: cats[cats.length - 1], summary: '' };
          cached.set(p.t.conv, hit);
          db.run(
            `INSERT INTO mail_job (conv, topic, category, summary, counterpart, firstDate, lastDate,
                                   msgs, sent, folders, completed, hasAtt, sig, ts)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(conv) DO UPDATE SET
               topic=excluded.topic, category=excluded.category, summary=excluded.summary,
               counterpart=excluded.counterpart, firstDate=excluded.firstDate, lastDate=excluded.lastDate,
               msgs=excluded.msgs, sent=excluded.sent, folders=excluded.folders,
               completed=excluded.completed, hasAtt=excluded.hasAtt, sig=excluded.sig, ts=excluded.ts`,
            [p.t.conv, p.t.topic, hit.category, hit.summary, p.counterpart,
             p.t.first, p.t.last, p.t.msgs, p.t.sent, p.folders,
             p.t.completed ? 1 : 0, p.t.hasAtt ? 1 : 0,
             `${sigOf(p.t)}:${catKey}`, now],
          );
        }
        jobsReport.classified = Math.min(pending.length, i + BATCH);
        jobsReport.message = `Sorting threads… ${jobsReport.classified}/${pending.length}`;
      }
      saveDb();

      // ── Build the report ────────────────────────────────────────────────────
      const rows = worked.map(t => {
        const c = cached.get(t.conv) || { category: cats[cats.length - 1], summary: '' };
        return {
          conv: t.conv,
          topic: t.topic || '(no subject)',
          category: c.category,
          summary: c.summary,
          counterpart: [...t.others].slice(0, 3).join(', '),
          msgs: t.msgs, sent: t.sent,
          first: t.first, last: t.last,
          folders: [...t.folders],
          completed: t.completed,
          hasAtt: t.hasAtt,
        };
      }).sort((a, b) => (b.last || '').localeCompare(a.last || ''));

      const byCategory = cats.map(c => {
        const hits = rows.filter(r => r.category === c);
        return {
          category: c,
          threads: hits.length,
          messages: hits.reduce((s, r) => s + r.msgs, 0),
          replies: hits.reduce((s, r) => s + r.sent, 0),
          pct: rows.length ? Math.round((hits.length / rows.length) * 100) : 0,
        };
      }).filter(c => c.threads > 0).sort((a, b) => b.threads - a.threads);

      // Per-day activity, keyed off the last touch of each thread.
      const perDay = new Map<string, number>();
      for (const r of rows) {
        const d = (r.last || '').slice(0, 10);
        if (d) perDay.set(d, (perDay.get(d) || 0) + 1);
      }
      const daily = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count }));

      const report = {
        range: { from, to },
        generatedAt: new Date().toISOString(),
        totals: {
          threads: rows.length,
          messages: rows.reduce((s, r) => s + r.msgs, 0),
          replies: rows.reduce((s, r) => s + r.sent, 0),
          completedFiled: rows.filter(r => r.completed).length,
          scanned: msgs.length,
        },
        byCategory,
        daily,
        folders: scan.folders || [],
        threads: rows,
        truncated: !!scan.truncated,
      };

      db.run(
        `INSERT INTO mail_job_meta (id, lastFrom, lastTo, lastScanAt, report) VALUES (1,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET lastFrom=excluded.lastFrom, lastTo=excluded.lastTo,
           lastScanAt=excluded.lastScanAt, report=excluded.report`,
        [from, to, new Date().toISOString(), JSON.stringify(report)],
      );
      saveDb();

      jobsReport.phase   = 'done';
      jobsReport.message = `${rows.length} jobs across ${byCategory.length} categories.`;
    } catch (e: any) {
      jobsReport.phase   = 'error';
      jobsReport.error   = e.message;
      jobsReport.message = `Scan failed: ${e.message}`;
      console.warn('[jobs-report]', e.message);
    } finally {
      jobsReport.running = false;
    }
  }

  // POST /api/jobs-report/scan { from, to }  (DD/MM/YYYY) — fire and forget.
  app.post('/api/jobs-report/scan', (req, res) => {
    if (jobsReport.running) { res.json({ started: false, ...jobsReport }); return; }
    const { from, to } = req.body as { from: string; to: string };
    const ok = (s: string) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(s || '').trim());
    if (!ok(from) || !ok(to)) {
      res.status(400).json({ started: false, error: 'from and to must be DD/MM/YYYY' }); return;
    }
    runJobsReport(String(from).trim(), String(to).trim());   // background
    res.json({ started: true, ...jobsReport });
  });

  app.get('/api/jobs-report/status', (_req, res) => res.json({ ...jobsReport }));

  // GET /api/jobs-report/result — the last report built, so reopening the tab is instant.
  app.get('/api/jobs-report/result', (_req, res) => {
    const row = queryAll(`SELECT lastFrom, lastTo, lastScanAt, report FROM mail_job_meta WHERE id = 1`)[0] as any;
    if (!row?.report) { res.json({ report: null, categories: jobCategories() }); return; }
    try {
      res.json({
        report: JSON.parse(row.report),
        lastScanAt: row.lastScanAt,
        categories: jobCategories(),
      });
    } catch {
      res.json({ report: null, categories: jobCategories() });
    }
  });

  // ══ To-Do ══════════════════════════════════════════════════════════════════
  // Triage of the SHARED quote-factory mailbox into things still owed. Scoped to
  // that one store on purpose (see scan-todo in outlook_reader.py) — the personal
  // inbox is out of scope. Each unanswered thread is sorted into:
  //   direct     — doable here, start to finish, no one else needed
  //   needs_info — blocked on a missing fact; usually the sender has to supply it
  //   needs_team — needs a colleague (sales, customer service, technical)
  // Nothing is emailed by the scan: it only ever writes rows.

  const TODO_BUCKETS = ['direct', 'needs_info', 'needs_team'] as const;
  type TodoBucket = typeof TODO_BUCKETS[number];

  // The mailbox the To-Do scan reads. Overridable in config.json for a different
  // shared box; the default is the UK quote factory.
  function todoStoreFilter(): string {
    return String((loadPyCfg() as any).todo_mailbox || '').trim() || 'quotefactory';
  }

  type TodoScanState = {
    running: boolean;
    phase: 'idle' | 'scanning' | 'triaging' | 'done' | 'error';
    message: string;
    threads: number; triaged: number; created: number; updated: number;
    days: number;
    mailbox: string;
    error: string | null;
    startedAt: string | null;
  };
  const todoScan: TodoScanState = {
    running: false, phase: 'idle', message: '', threads: 0, triaged: 0,
    created: 0, updated: 0, days: 30, mailbox: '', error: null, startedAt: null,
  };

  // Re-seed the in-memory state from the last completed run, so a server restart
  // (or a browser refresh) shows what the last scan found rather than a blank
  // panel. `running` is never restored — a process that died mid-scan is not
  // still scanning.
  (function hydrateTodoScan() {
    try {
      const m = queryAll(`SELECT * FROM todo_meta WHERE id = 1`)[0] as any;
      if (!m?.lastScanAt) return;
      todoScan.phase     = m.lastScanError ? 'error' : 'done';
      todoScan.message   = m.lastScanMessage || '';
      todoScan.error     = m.lastScanError || null;
      todoScan.threads   = Number(m.lastScanThreads) || 0;
      todoScan.triaged   = (Number(m.lastScanCreated) || 0) + (Number(m.lastScanUpdated) || 0);
      todoScan.created   = Number(m.lastScanCreated) || 0;
      todoScan.updated   = Number(m.lastScanUpdated) || 0;
      todoScan.days      = Number(m.lastScanDays) || 30;
      todoScan.mailbox   = m.lastScanMailbox || '';
      todoScan.startedAt = m.lastScanStartedAt || m.lastScanAt;
    } catch (e: any) {
      console.warn('[todo] could not restore last scan:', e.message);
    }
  })();

  // Live board counts + the persisted facts about the last run, merged over the
  // in-flight state — the CRM sync/status contract, applied to the To-Do board.
  function todoScanPayload() {
    const m = queryAll(`SELECT lastScanAt, lastContactsAt FROM todo_meta WHERE id = 1`)[0] as any;
    const c = queryAll(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status <> 'done'   THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status =  'waiting' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN status =  'done'    THEN 1 ELSE 0 END) AS done
         FROM todo`)[0] as any;
    return {
      ...todoScan,
      counts: {
        total:   Number(c?.total)   || 0,
        open:    Number(c?.open)    || 0,
        waiting: Number(c?.waiting) || 0,
        done:    Number(c?.done)    || 0,
      },
      lastScanAt:     m?.lastScanAt || null,
      lastContactsAt: m?.lastContactsAt || null,
    };
  }

  // One place that writes the outcome of a finished run, success or failure.
  function saveTodoScanMeta() {
    db.run(
      `INSERT INTO todo_meta (id, lastScanAt, lastScanDays, lastScanMailbox,
                              lastScanThreads, lastScanCreated, lastScanUpdated,
                              lastScanMessage, lastScanError, lastScanStartedAt)
       VALUES (1,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         lastScanAt=excluded.lastScanAt, lastScanDays=excluded.lastScanDays,
         lastScanMailbox=excluded.lastScanMailbox, lastScanThreads=excluded.lastScanThreads,
         lastScanCreated=excluded.lastScanCreated, lastScanUpdated=excluded.lastScanUpdated,
         lastScanMessage=excluded.lastScanMessage, lastScanError=excluded.lastScanError,
         lastScanStartedAt=excluded.lastScanStartedAt`,
      [new Date().toISOString(), todoScan.days, todoScan.mailbox,
       todoScan.threads, todoScan.created, todoScan.updated,
       todoScan.message, todoScan.error, todoScan.startedAt],
    );
    saveDb();
  }

  const todoRow = (r: any) => ({
    id: r.id,
    conv: r.conv || '',
    entryId: r.entryId || '',
    subject: r.subject || '',
    sender: r.sender || '',
    senderEmail: r.senderEmail || '',
    received: r.received || '',
    bucket: (TODO_BUCKETS as readonly string[]).includes(r.bucket) ? r.bucket : 'direct',
    title: r.title || '',
    summary: r.summary || '',
    action: r.action || '',
    blocker: r.blocker || '',
    notes: r.notes || '',
    recipients: safeParse(r.recipients, [] as Array<{ name: string; email: string }>),
    attachments: safeParse(r.attachments, [] as Array<{ index: number; name: string; size?: number }>),
    draftSubject: r.draftSubject || '',
    draftBody: r.draftBody || '',
    due: r.due || '',
    priority: r.priority || 'normal',
    status: r.status || 'open',
    source: r.source || '',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    doneAt: r.doneAt || null, sentAt: r.sentAt || null,
  });

  function safeParse<T>(s: any, fallback: T): T {
    try { const v = JSON.parse(s || ''); return v ?? fallback; } catch { return fallback; }
  }

  // Urgency word → concrete date, so the UI never has to interpret AI prose.
  function dueFromUrgency(u: string): string {
    const days = u === 'today' ? 0 : u === 'soon' ? 2 : 7;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Ask the fast model to sort a batch of unanswered threads. Returns i → verdict.
  async function triageThreadBatch(
    batch: Array<{ i: number; subject: string; from: string; days: number; atts: string; body: string }>,
    me: string | null,
  ): Promise<Map<number, { bucket: TodoBucket; title: string; action: string; blocker: string; who: string; urgency: string }>> {
    const out = new Map<number, any>();
    const ai  = getGemini();
    if (!ai) return out;

    const lines = batch.map(b =>
      `${b.i}. SUBJECT: ${b.subject.replace(/\s+/g, ' ').slice(0, 160)}\n`
      + `   FROM: ${b.from.slice(0, 90)} | WAITING: ${b.days} day(s) | ATTACHMENTS: ${b.atts.slice(0, 120) || 'none'}\n`
      + `   BODY: ${b.body.replace(/\s+/g, ' ').slice(0, 900)}`,
    ).join('\n\n');

    const prompt =
      `You are triaging the UNANSWERED emails in the shared UK quote-factory mailbox of ${me ? me + ', ' : ''}an Eaton emergency-lighting quote engineer in Budapest. `
      + 'Each entry is one email thread nobody has replied to yet. Decide what it will take to close it.\n\n'
      + 'Buckets (use EXACTLY one of these strings):\n'
      + '- direct — the engineer can finish this himself with what is already in the email: price a quote from an attached BOM/schematic, raise a PMO, send a document, answer a product question, forward a file he has.\n'
      + '- needs_info — he cannot start until someone supplies a missing fact: no drawing/BOM attached, unclear quantities, missing Salesforce ID or PO, unreadable spec, no delivery address, ambiguous product reference.\n'
      + '- needs_team — the work itself belongs to somebody else, or cannot be decided alone: pricing approval or a discount beyond his authority, a commercial/contract question for sales, order status or credit for customer service, a technical design sign-off, anything about another engineer\'s project.\n\n'
      + 'Rules:\n'
      + '- Judge from the actual content, never the tone. Being long or urgent does not make it needs_team.\n'
      + '- Prefer "direct" when in doubt: only use needs_info if something concrete is genuinely MISSING, and needs_team only if another person must act.\n'
      + '- "title": max 9 words, factual, names the customer/project if present, e.g. "Price CGLine+ replacement — Glasgow refurb".\n'
      + '- "action": one short sentence, the concrete next step, imperative.\n'
      + '- "blocker": for needs_info/needs_team ONLY, name exactly what is missing or who must act. Empty string for direct.\n'
      + '- "who": for needs_team ONLY, the role that must act — one of "sales", "customer service", "technical", "management". Empty otherwise.\n'
      + '- "urgency": "today" if a deadline, chase or escalation is stated; "soon" if a customer is waiting on a normal request; "later" for FYI-ish threads.\n'
      + '- Never invent facts that are not in the email.\n\n'
      + `Threads:\n${lines}\n\n`
      + 'Return ONLY a JSON array: [{"i":<number>,"bucket":"<bucket>","title":"...","action":"...","blocker":"...","who":"...","urgency":"today|soon|later"}]';

    try {
      const r = await generateWithRetry(ai, {
        model: AI_MODEL_FAST,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 6000, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      });
      const txt = r.text ?? '';
      const m   = txt.match(/\[[\s\S]*\]/);
      if (!m) return out;
      for (const row of (JSON.parse(m[0]) as any[])) {
        const i = Number(row?.i);
        if (!Number.isFinite(i)) continue;
        let bucket = String(row?.bucket || '').trim().toLowerCase().replace(/[\s-]+/g, '_') as TodoBucket;
        if (!(TODO_BUCKETS as readonly string[]).includes(bucket)) bucket = 'direct';
        out.set(i, {
          bucket,
          title:   String(row?.title || '').trim().slice(0, 140),
          action:  String(row?.action || '').trim().slice(0, 300),
          blocker: bucket === 'direct' ? '' : String(row?.blocker || '').trim().slice(0, 300),
          who:     bucket === 'needs_team' ? String(row?.who || '').trim().slice(0, 40) : '',
          urgency: ['today', 'soon', 'later'].includes(String(row?.urgency)) ? String(row.urgency) : 'soon',
        });
      }
    } catch (e: any) {
      console.warn('[todo] triage batch failed:', e.message);
    }
    return out;
  }

  async function runTodoScan(days: number) {
    todoScan.running = true;
    todoScan.phase = 'scanning';
    todoScan.error = null;
    todoScan.threads = todoScan.triaged = todoScan.created = todoScan.updated = 0;
    todoScan.days = days;
    todoScan.mailbox = todoStoreFilter();
    todoScan.startedAt = new Date().toISOString();
    todoScan.message = 'Reading the shared mailbox…';

    try {
      const since = new Date(Date.now() - days * 864e5);
      const sinceStr = `${String(since.getDate()).padStart(2, '0')}/${String(since.getMonth() + 1).padStart(2, '0')}/${since.getFullYear()}`;

      const scan = await runOutlookPy([
        '--action', 'scan-todo', '--since', sinceStr,
        '--store-filter', todoScan.mailbox, '--max', '20000', '--backend', 'win32',
      ]);
      if (scan?.error) throw new Error(scan.error);

      const threads: any[] = scan.threads || [];
      todoScan.threads = threads.length;
      todoScan.phase   = 'triaging';
      todoScan.message = `Sorting ${threads.length} unanswered thread(s)…`;

      // A thread already carrying an OPEN to-do only needs its facts refreshed —
      // re-triaging it would overwrite the user's own edits and cost AI calls.
      const existing = new Map<string, any>();
      for (const r of queryAll(`SELECT * FROM todo WHERE conv <> ''`)) existing.set(r.conv as string, r);

      const me  = await connectedUserName();
      const now = new Date().toISOString();
      const pending: Array<{ i: number; subject: string; from: string; days: number; atts: string; body: string; t: any }> = [];

      for (const t of threads) {
        const prev = existing.get(t.conv);
        // Same thread, nothing new since the row was written → leave it alone.
        if (prev && prev.status !== 'done' && (prev.received || '') >= (t.received || '')) {
          continue;
        }
        if (prev && prev.status === 'done' && (prev.received || '') >= (t.received || '')) {
          continue;   // already finished, and the thread has not moved on
        }
        const waited = t.received
          ? Math.max(0, Math.round((Date.now() - new Date(t.received).getTime()) / 864e5))
          : 0;
        pending.push({
          i: pending.length,
          subject: t.subject || t.topic || '(no subject)',
          from: `${t.sender || ''} <${t.senderEmail || ''}>`,
          days: waited,
          atts: (t.attachments || []).map((a: any) => a.name).join(', '),
          body: t.body || '',
          t,
        });
      }

      if (!pending.length) todoScan.message = 'Nothing new — the queue is already up to date.';

      const BATCH = 10;
      for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH).map((p, k) => ({ ...p, i: k }));
        const got   = await triageThreadBatch(slice, me);
        for (const p of slice) {
          const v = got.get(p.i) || {
            bucket: 'direct' as TodoBucket, title: p.subject.slice(0, 140),
            action: '', blocker: '', who: '', urgency: 'soon',
          };
          const t    = p.t;
          const prev = existing.get(t.conv);
          // A blocked item defaults to asking the person who wrote — the sender is
          // almost always the one holding the missing fact. Never a send, just a
          // pre-filled recipient the user can change.
          const recips = v.bucket === 'needs_info' && t.senderEmail
            ? [{ name: t.sender || t.senderEmail, email: t.senderEmail }]
            : [];

          if (prev) {
            db.run(
              `UPDATE todo SET entryId=?, subject=?, sender=?, senderEmail=?, received=?,
                 bucket=?, title=?, summary=?, action=?, blocker=?, attachments=?,
                 due=COALESCE(NULLIF(due,''),?), priority=?, status='open', doneAt=NULL, updatedAt=?
               WHERE id=?`,
              [t.entryId, t.subject, t.sender, t.senderEmail, t.received,
               v.bucket, v.title || t.subject, t.body ? String(t.body).slice(0, 600) : '',
               v.action, v.blocker, JSON.stringify(t.attachments || []),
               dueFromUrgency(v.urgency), v.urgency === 'today' ? 'high' : 'normal',
               now, prev.id],
            );
            todoScan.updated++;
          } else {
            db.run(
              `INSERT INTO todo (conv, entryId, subject, sender, senderEmail, received,
                                 bucket, title, summary, action, blocker, notes,
                                 recipients, attachments, draftSubject, draftBody,
                                 due, priority, status, source, createdAt, updatedAt)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,'',?,?,'','',?,?,'open','scan',?,?)`,
              [t.conv, t.entryId, t.subject, t.sender, t.senderEmail, t.received,
               v.bucket, v.title || t.subject, t.body ? String(t.body).slice(0, 600) : '',
               v.action, v.blocker,
               JSON.stringify(recips), JSON.stringify(t.attachments || []),
               dueFromUrgency(v.urgency), v.urgency === 'today' ? 'high' : 'normal',
               now, now],
            );
            todoScan.created++;
          }
        }
        todoScan.triaged = Math.min(pending.length, i + BATCH);
        todoScan.message = `Triaging… ${todoScan.triaged}/${pending.length}`;
      }

      saveDb();

      todoScan.phase   = 'done';
      todoScan.message = pending.length
        ? `${todoScan.created} new, ${todoScan.updated} updated — ${threads.length} unanswered thread(s).`
        : `Queue up to date — ${threads.length} unanswered thread(s), nothing new.`;
    } catch (e: any) {
      todoScan.phase   = 'error';
      todoScan.error   = e.message;
      todoScan.message = `Scan failed: ${e.message}`;
      console.warn('[todo]', e.message);
    } finally {
      todoScan.running = false;
      // Persist the outcome either way — a failed scan the user never saw is
      // worth showing after a refresh too.
      try { saveTodoScanMeta(); } catch (e: any) { console.warn('[todo] meta save failed:', e.message); }
    }
  }

  // POST /api/todo/scan { days } — fire and forget; poll /api/todo/scan/status.
  app.post('/api/todo/scan', (req, res) => {
    if (todoScan.running) { res.json({ started: false, ...todoScanPayload() }); return; }
    const days = Math.min(365, Math.max(1, Number((req.body as any)?.days) || 30));
    runTodoScan(days);
    res.json({ started: true, ...todoScanPayload() });
  });

  app.get('/api/todo/scan/status', (_req, res) => res.json(todoScanPayload()));

  // GET /api/todo?status=open|done|all — the whole board in one call.
  app.get('/api/todo', (req, res) => {
    const want = String(req.query.status || 'all');
    const rows = queryAll(`SELECT * FROM todo ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
        CASE priority WHEN 'high' THEN 0 ELSE 1 END,
        COALESCE(NULLIF(due,''),'9999') ASC, received DESC`)
      .map(todoRow)
      .filter(r => want === 'all' ? true : want === 'open' ? r.status !== 'done' : r.status === 'done');
    const meta = queryAll(`SELECT lastScanAt, lastContactsAt FROM todo_meta WHERE id = 1`)[0] as any;
    res.json({
      items: rows,
      lastScanAt: meta?.lastScanAt || null,
      lastContactsAt: meta?.lastContactsAt || null,
      mailbox: todoStoreFilter(),
    });
  });

  // POST /api/todo — create (no id) or patch (id + only the fields to change).
  app.post('/api/todo', (req, res) => {
    const b   = (req.body || {}) as any;
    const now = new Date().toISOString();
    try {
      if (b.id) {
        const prev = queryAll(`SELECT * FROM todo WHERE id = ?`, [b.id])[0];
        if (!prev) { res.status(404).json({ error: 'that to-do no longer exists' }); return; }
        const pick = (k: string, fallback: any) => (b[k] === undefined ? fallback : b[k]);
        const status = String(pick('status', prev.status));
        db.run(
          `UPDATE todo SET bucket=?, title=?, summary=?, action=?, blocker=?, notes=?,
             recipients=?, attachments=?, draftSubject=?, draftBody=?, due=?, priority=?,
             status=?, doneAt=?, updatedAt=? WHERE id=?`,
          [
            String(pick('bucket', prev.bucket)),
            String(pick('title', prev.title)).slice(0, 300),
            String(pick('summary', prev.summary || '')),
            String(pick('action', prev.action || '')),
            String(pick('blocker', prev.blocker || '')),
            String(pick('notes', prev.notes || '')),
            JSON.stringify(pick('recipients', safeParse(prev.recipients, []))),
            JSON.stringify(pick('attachments', safeParse(prev.attachments, []))),
            String(pick('draftSubject', prev.draftSubject || '')),
            String(pick('draftBody', prev.draftBody || '')),
            String(pick('due', prev.due || '')),
            String(pick('priority', prev.priority || 'normal')),
            status,
            status === 'done' ? (prev.doneAt || now) : null,
            now, b.id,
          ],
        );
        saveDb();
        res.json({ ok: true, item: todoRow(queryAll(`SELECT * FROM todo WHERE id = ?`, [b.id])[0]) });
        return;
      }

      const title = String(b.title || b.subject || '').trim();
      if (!title) { res.status(400).json({ error: 'title is required' }); return; }
      const id = runWrite(
        `INSERT INTO todo (conv, entryId, subject, sender, senderEmail, received,
                           bucket, title, summary, action, blocker, notes,
                           recipients, attachments, draftSubject, draftBody,
                           due, priority, status, source, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          String(b.conv || ''), String(b.entryId || ''), String(b.subject || ''),
          String(b.sender || ''), String(b.senderEmail || ''), String(b.received || ''),
          (TODO_BUCKETS as readonly string[]).includes(b.bucket) ? b.bucket : 'direct',
          title.slice(0, 300), String(b.summary || ''), String(b.action || ''),
          String(b.blocker || ''), String(b.notes || ''),
          JSON.stringify(b.recipients || []), JSON.stringify(b.attachments || []),
          String(b.draftSubject || ''), String(b.draftBody || ''),
          String(b.due || ''), String(b.priority || 'normal'),
          String(b.status || 'open'), String(b.source || 'manual'), now, now,
        ],
      );
      res.json({ ok: true, item: todoRow(queryAll(`SELECT * FROM todo WHERE id = ?`, [id])[0]) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/todo/:id', (req, res) => {
    db.run(`DELETE FROM todo WHERE id = ?`, [Number(req.params.id)]);
    saveDb();
    res.json({ ok: true });
  });

  // POST /api/todo/:id/send { draft } — the ONLY path that puts mail in Outlook.
  // draft:true stops at the Drafts folder and pops the composer; otherwise it
  // sends. Attachments are pulled live off the source email by index.
  app.post('/api/todo/:id/send', async (req, res) => {
    const row = queryAll(`SELECT * FROM todo WHERE id = ?`, [Number(req.params.id)])[0];
    if (!row) { res.status(404).json({ error: 'that to-do no longer exists' }); return; }
    const item  = todoRow(row);
    const draft = !!(req.body as any)?.draft;

    const to = item.recipients.map(r => r.email).filter(Boolean).join('; ');
    if (!to) { res.status(400).json({ error: 'Pick at least one recipient first' }); return; }

    const subject = item.draftSubject || (item.subject ? `FW: ${item.subject}` : item.title);
    const body    = item.draftBody;
    if (!body.trim()) { res.status(400).json({ error: 'The message is empty' }); return; }

    // Only attachments that came from the source email can be re-attached.
    const attSources = item.entryId
      ? item.attachments.map(a => ({ entryId: item.entryId, index: a.index }))
      : [];

    try {
      const r = await runOutlookPy([
        '--action', 'send-new', '--to', to, '--subject', subject, '--body', body,
        '--att-sources', JSON.stringify(attSources),
        ...(draft ? ['--draft', '1'] : []),
      ]);
      if (r?.error) { res.json({ ok: false, error: r.error }); return; }
      if (!draft) {
        const now = new Date().toISOString();
        db.run(`UPDATE todo SET status='waiting', sentAt=?, updatedAt=? WHERE id=?`, [now, now, item.id]);
        saveDb();
      }
      res.json({
        ok: true, draft,
        item: todoRow(queryAll(`SELECT * FROM todo WHERE id = ?`, [item.id])[0]),
      });
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /api/todo/recipients — the picker list: harvested Outlook correspondents
  // merged with the CRM's stored contacts, most-corresponded-with first.
  app.get('/api/todo/recipients', (_req, res) => {
    const byEmail = new Map<string, { name: string; email: string; count: number; lastSeen: string; source: string }>();

    for (const r of queryAll(`SELECT * FROM mail_contact ORDER BY count DESC LIMIT 500`)) {
      const email = String(r.email || '').toLowerCase();
      if (!email) continue;
      byEmail.set(email, {
        name: String(r.name || '') || email,
        email: String(r.email),
        count: Number(r.count) || 0,
        lastSeen: String(r.lastSeen || ''),
        source: 'outlook',
      });
    }
    for (const r of queryAll(
      `SELECT c.name AS name, c.email AS email, co.name AS company
         FROM crm_contact c LEFT JOIN crm_company co ON co.id = c.companyId
        WHERE c.email IS NOT NULL AND c.email <> ''`)) {
      const email = String(r.email || '').toLowerCase();
      if (!email) continue;
      const prev = byEmail.get(email);
      if (prev) { prev.source = 'both'; if (!prev.name || prev.name === email) prev.name = String(r.name || prev.name); continue; }
      byEmail.set(email, {
        name: String(r.name || '') || email,
        email: String(r.email),
        count: 0,
        lastSeen: '',
        source: 'crm',
      });
    }

    const meta = queryAll(`SELECT lastContactsAt FROM todo_meta WHERE id = 1`)[0] as any;
    res.json({
      recipients: [...byEmail.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      lastContactsAt: meta?.lastContactsAt || null,
    });
  });

  // POST /api/todo/recipients/refresh { days } — re-harvest from Outlook history.
  app.post('/api/todo/recipients/refresh', async (req, res) => {
    const days = Math.min(1095, Math.max(30, Number((req.body as any)?.days) || 365));
    const since = new Date(Date.now() - days * 864e5);
    const sinceStr = `${String(since.getDate()).padStart(2, '0')}/${String(since.getMonth() + 1).padStart(2, '0')}/${since.getFullYear()}`;
    try {
      const r = await runOutlookPy([
        '--action', 'contacts', '--since', sinceStr, '--max', '8000', '--backend', 'win32',
      ]);
      if (r?.error) { res.json({ ok: false, error: r.error }); return; }
      const now = new Date().toISOString();
      for (const c of (r.contacts || [])) {
        db.run(
          `INSERT INTO mail_contact (email, name, count, sent, received, lastSeen, updatedAt)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(email) DO UPDATE SET
             name=excluded.name, count=excluded.count, sent=excluded.sent,
             received=excluded.received, lastSeen=excluded.lastSeen, updatedAt=excluded.updatedAt`,
          [String(c.email).toLowerCase(), c.name || '', c.count || 0,
           c.sent || 0, c.received || 0, c.lastSeen || '', now],
        );
      }
      db.run(
        `INSERT INTO todo_meta (id, lastContactsAt) VALUES (1,?)
         ON CONFLICT(id) DO UPDATE SET lastContactsAt=excluded.lastContactsAt`,
        [now],
      );
      saveDb();
      res.json({ ok: true, count: (r.contacts || []).length, scanned: r.scanned || 0 });
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });

  // POST /api/todo/draft { id } — write the delegation/chase message for an item.
  app.post('/api/todo/draft', async (req, res) => {
    const row = queryAll(`SELECT * FROM todo WHERE id = ?`, [Number((req.body as any)?.id)])[0];
    if (!row) { res.status(404).json({ error: 'that to-do no longer exists' }); return; }
    const item = todoRow(row);
    const ai   = getGemini();
    if (!ai) { res.json({ error: 'No Gemini API key — add it in Settings' }); return; }

    const me   = await connectedUserName();
    const to   = item.recipients.map(r => r.name || r.email).join(', ') || 'a colleague';
    const kind = item.bucket === 'needs_team'
      ? 'hand this over to / get help from a colleague'
      : item.bucket === 'needs_info'
        ? 'ask for the missing information so the work can start'
        : 'pass this on with context';

    const prompt = [
      `Write a short internal Eaton email from ${me || 'the quote engineer'} to ${to} to ${kind}.`,
      ``,
      `Item: ${item.title}`,
      item.action  ? `Next step: ${item.action}` : '',
      item.blocker ? `What is missing / who must act: ${item.blocker}` : '',
      item.notes   ? `My notes: ${item.notes}` : '',
      item.subject ? `Original email subject: ${item.subject}` : '',
      item.sender  ? `Original sender: ${item.sender} <${item.senderEmail}>` : '',
      item.summary ? `Original email (extract):\n${item.summary.slice(0, 800)}` : '',
      item.attachments.length ? `Attached: ${item.attachments.map(a => a.name).join(', ')}` : '',
      ``,
      `Rules: plain text, no markdown, no subject line in the body, British English.`,
      `Open with the ask in the first sentence. State only facts given above — invent nothing.`,
      `Keep it under 120 words. End with "Thanks," and the sender's first name on the next line.`,
    ].filter(Boolean).join('\n');

    try {
      const r = await generateWithRetry(ai, {
        model: smartModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // The 2.5 models spend thinking tokens out of this same budget — a tight
        // cap here truncates the message mid-sentence rather than shortening it.
        config: { maxOutputTokens: 4096, temperature: 0.3 },
      });
      const body = (r.text || '').trim();
      if (!body) { res.json({ error: 'the AI returned an empty draft' }); return; }
      const subject = item.draftSubject
        || (item.subject ? `FW: ${item.subject}` : item.title).slice(0, 200);
      const now = new Date().toISOString();
      db.run(`UPDATE todo SET draftSubject=?, draftBody=?, updatedAt=? WHERE id=?`,
             [subject, body, now, item.id]);
      saveDb();
      res.json({ ok: true, subject, body });
    } catch (e: any) {
      res.json({ error: 'Gemini error: ' + e.message });
    }
  });

  // POST /api/quotes/checkup/queue { entryIds: [] } — bundle every selected mail's
  // quote documents into the Dashboard upload queue in one go.
  app.post('/api/quotes/checkup/queue', async (req, res) => {
    const { entryIds } = req.body as { entryIds: string[] };
    if (!Array.isArray(entryIds) || !entryIds.length) {
      res.json({ ok: false, error: 'No emails selected' }); return;
    }
    const dest = path.join(loadPyCfg().base, 'PDF Quotes');
    const saved: string[] = [];
    const failed: Array<{ entryId: string; error: string }> = [];
    for (const id of entryIds.slice(0, 100)) {
      try {
        const r = await runOutlookPy(['--action', 'save-attachment', '--id', id, '--dest', dest]);
        if (r?.error) failed.push({ entryId: id, error: r.error });
        else for (const s of (r?.saved || [])) saved.push(s.name);
      } catch (e: any) {
        failed.push({ entryId: id, error: e.message });
      }
    }
    res.json({ ok: failed.length === 0, saved, count: saved.length, failed });
  });

  // ── Attachment bytes, with a disk cache in front of the COM fetch ─────────
  // Every hit here used to spawn outlook_reader.py, which initialises COM and
  // walks to the message before it can save one file. That was tolerable while
  // the only caller was "open this PDF"; now the Inbox draws a thumbnail on
  // every image chip, so an eight-picture mail would have meant eight COM
  // round-trips just to paint the header.
  //
  // The extracted bytes are therefore kept on disk, keyed by the message's
  // EntryID. Attachment N of a given message never changes, and a message that
  // moves gets a new EntryID, so a stale key can't serve the wrong file.
  const ATT_DIR          = path.join(os.tmpdir(), 'vector_att');
  const ATT_CACHE_DIR    = path.join(ATT_DIR, 'cache');
  const ATT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const ATT_MIME: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.gif': 'image/gif',
    '.bmp': 'image/bmp',  '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff', '.tif': 'image/tiff',
  };

  function attKey(entryId: string, index: string): string {
    // EntryIDs are long and not filename-safe; the hash only has to be stable
    // and collision-free across one mailbox.
    return createHash('sha1').update(entryId).digest('hex').slice(0, 16) + '-' + index;
  }

  // Nothing has ever deleted from these temp dirs, so they grew for as long as
  // the app had been used. Run once at boot: a week is far longer than anyone
  // keeps an email pane open.
  function pruneAttCache() {
    const cutoff = Date.now() - ATT_CACHE_TTL_MS;
    for (const dir of [ATT_CACHE_DIR, ATT_DIR, path.join(os.tmpdir(), 'vector_sum')]) {
      try {
        for (const f of readdirSync(dir)) {
          const p = path.join(dir, f);
          try {
            const st = statSync(p);
            if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
          } catch { /* vanished under us, or locked — next boot gets it */ }
        }
      } catch { /* dir not created yet */ }
    }
  }
  pruneAttCache();

  // Serve a single attachment inline (PDF or image). `?thumb=N` asks for a copy
  // downscaled to N px on its longest side — see _write_thumb in outlook_reader.
  app.get('/api/outlook/attachment-view/:entryId/:index', async (req, res) => {
    const entryId = decodeURIComponent(req.params.entryId);
    const index   = req.params.index;
    const thumb   = Math.min(512, Math.max(0, parseInt(String(req.query.thumb ?? '0'), 10) || 0));

    const key      = attKey(entryId, index);
    const metaPath = path.join(ATT_CACHE_DIR, `${key}.json`);
    const fullPath = path.join(ATT_CACHE_DIR, `${key}.bin`);
    const blobPath = thumb ? path.join(ATT_CACHE_DIR, `${key}-t${thumb}.bin`) : fullPath;

    // `jpegThumb` is false when the reader could not shrink the file and the
    // cached "thumb" is really the original — labelling those image/jpeg would
    // hand an SVG to the browser under the wrong type and break the chip.
    const serve = (name: string, jpegThumb: boolean) => {
      const mime = (thumb && jpegThumb) ? 'image/jpeg'
                 : (ATT_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', contentDisposition('inline', name));
      // The bytes behind an EntryID never change, so this can be cached hard —
      // it is what keeps a re-render of the chip strip free.
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      // sendFile (not a raw stream) so PDFs in an iframe get Range and 304s.
      res.sendFile(blobPath);
    };

    try {
      if (existsSync(metaPath) && existsSync(blobPath)) {
        let name = 'attachment', jpegThumb = false;
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          name = meta.name || name;
          jpegThumb = !!meta.thumbOk;
        } catch { /* keep defaults */ }
        serve(name, jpegThumb);
        return;
      }

      mkdirSync(ATT_CACHE_DIR, { recursive: true });
      const r = await runOutlookPy([
        '--action', 'get-attachment', '--id', entryId, '--index', index, '--dest', ATT_DIR,
        ...(thumb ? ['--thumb', String(thumb)] : []),
      ]);
      if (r.error || !r.path) { res.status(404).send(r.error || 'Attachment not found'); return; }

      // A thumbnail the reader declined to build (an SVG, a corrupt file) falls
      // back to the original bytes, so the chip shows the picture either way.
      const jpegThumb = !!(thumb && r.thumbPath && existsSync(r.thumbPath));
      copyFileSync(jpegThumb ? r.thumbPath : r.path, blobPath);
      // The full file is in hand regardless of what was asked for; cache it too
      // so clicking the chip through to the lightbox costs no second COM trip.
      if (blobPath !== fullPath && !existsSync(fullPath)) copyFileSync(r.path, fullPath);
      writeFileSync(metaPath, JSON.stringify({ name: r.name, size: r.size ?? null, thumbOk: jpegThumb }));

      // The staging copies outside the cache have served their purpose.
      for (const p of [r.path, r.thumbPath]) {
        if (p && p !== blobPath && p !== fullPath) { try { unlinkSync(p); } catch { /* best effort */ } }
      }
      serve(r.name, jpegThumb);
    } catch (e: any) { res.status(500).send(e.message); }
  });

  // Price a PDF attachment via schematic_reader (Gemini vision)
  app.post('/api/outlook/attachment-price', async (req, res) => {
    try {
      const { entryId, index, isImage } = (req.body ?? {}) as { entryId: string; index: number; isImage?: boolean };
      if (!entryId || !index) { res.json({ error: 'the request did not say which attachment' }); return; }
      const tmpDir   = path.join(os.tmpdir(), 'vector_att');
      const pyScript = pyFile('schematic_reader.py');
      if (!existsSync(pyScript)) { res.json({ error: 'schematic_reader.py is missing from this install' }); return; }

      const att = await runOutlookPy(['--action', 'get-attachment', '--id', entryId, '--index', String(index), '--dest', tmpDir]);
      if (att.error || !att.path) { res.json({ error: att.error || 'Could not save attachment' }); return; }

      const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
      const excelExts = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']);
      const ext = path.extname(att.path).toLowerCase();

      // Excel/CSV can't be priced by --mode image/pdf — route through a unified
      // manifest (kind:'excel') which extract_from_excel parses with no AI.
      let mode: string, input: string, manifestPath = '';
      if (excelExts.has(ext)) {
        manifestPath = path.join(path.dirname(att.path), `manifest_${Date.now()}.json`);
        writeFileSync(manifestPath, JSON.stringify({ text: '', files: [{ path: att.path, kind: 'excel', name: att.name }] }));
        mode = 'unified'; input = manifestPath;
      } else {
        mode = (isImage || imageExts.has(ext)) ? 'image' : 'pdf';
        input = att.path;
      }

      const [py, base] = pyArgs(pyScript);
      await new Promise<void>(resolve => {
        const proc = spawn(py, [...base, '--mode', mode, '--input', input], { env: { ...process.env } });
        let out = '', err = '';
        // Hard cap so a pathological spreadsheet (huge pricing model, not a list)
        // can never hang the request.
        const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 120_000);
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        proc.on('error', (e: Error) => {
          clearTimeout(killTimer);
          if (!res.headersSent) res.json({ error: e.message });
          resolve();
        });
        proc.on('close', () => {
          clearTimeout(killTimer);
          if (manifestPath) { try { unlinkSync(manifestPath); } catch {} }
          if (!res.headersSent) {
            try { res.json(JSON.parse(out.trim())); }
            catch { res.json({ error: err.trim() || out.trim() || 'Could not price this file — it may be too large or not a material list.' }); }
          }
          resolve();
        });
      });
    } catch (e: any) {
      if (!res.headersSent) res.json({ error: String(e?.message || e) });
    }
  });

  // ── Load a persisted summary (no AI spend) ────────────────────────────────
  app.get('/api/outlook/summary/:entryId', (req, res) => {
    try {
      const row = queryAll('SELECT summary, includedIndices, ts FROM email_summaries WHERE entryId = ?', [req.params.entryId])[0];
      if (!row) { res.json({ summary: null }); return; }
      let included: number[] = [];
      try { included = JSON.parse(row.includedIndices || '[]'); } catch {}
      res.json({ summary: row.summary, includedIndices: included, ts: row.ts });
    } catch (e: any) { res.json({ summary: null, error: e.message }); }
  });

  // ── Summarize: structured summary + vision over inline / opted-in images ──
  // Replaces the old text-only /analyze + the batch /briefing. Reads photos,
  // scans and diagrams inside the email, and persists per-entryId so re-opening
  // (even after restart) is instant and costs no tokens.
  app.post('/api/outlook/summarize', async (req, res) => {
    const { entryId, subject, sender, senderEmail, received, body, attachments, includeIndices, force } = req.body as {
      entryId: string; subject: string; sender: string; senderEmail: string;
      received: string; body: string; attachments?: Array<{ name: string }>;
      includeIndices?: number[]; force?: boolean;
    };
    const ai = getGemini();
    if (!ai) { res.json({ summary: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const indices = Array.from(new Set((includeIndices || []).filter(n => Number.isFinite(n)))).sort((a, b) => a - b);
    const indicesKey = JSON.stringify(indices);

    // Serve the persisted summary unless the caller forces a regenerate or the
    // set of included attachments changed since it was generated.
    if (!force) {
      const row = queryAll('SELECT summary, includedIndices FROM email_summaries WHERE entryId = ?', [entryId])[0];
      if (row && row.summary && (row.includedIndices || '[]') === indicesKey) {
        res.json({ summary: row.summary, cached: true }); return;
      }
    }

    const me = await connectedUserName();
    const attList = attachments?.map(a => a.name).join(', ') || 'none';

    // Dedicated summariser persona — NOT the generic Ask Vector chat prompt, whose
    // "go to X tab" scripting used to leak into summaries as nonsense like
    // "go to the Inbox and click Summarize". The engineer is already reading this
    // email in the Inbox, so lead with the conclusion and skip the obvious.
    const summarizeSystem = [
      `You are Ask Vector, reading an email for ${me ? me + ', ' : ''}an Eaton quote engineer in Budapest who is ALREADY looking at this email open in the app's Inbox.`,
      `Give the bottom line first. No filler, no "this is an email", no restating the sender/subject/date already on screen, no "I have analysed…".`,
      `NEVER tell the user to open the Inbox, select this email, or click Summarize — they are already here. Only mention ANOTHER tab when a real next action needs it (Dashboard → Step 1, PMO tab, EL Pricer, Draft Reply).`,
      `Be adaptive and proportional: cover only what matters for THIS email. A one-line email gets a one-line answer. Omit any heading that would be empty. Never invent facts that aren't in the email or images.`,
    ].join('\n');

    const prompt = [
      `**From:** ${sender} <${senderEmail}>`,
      `**Subject:** ${subject}`,
      `**Received:** ${received}`,
      `**Attachments:** ${attList}`,
      ``,
      `**Email body:**`,
      (body || '').slice(0, 12000),
      ``,
      indices.length
        ? `Image(s)/document(s) from this email are attached below. Read them fully — text, tables, drawings, part numbers, photos — and fold what you see into the answer. Questions in the body may refer to them.`
        : ``,
      ``,
      `Write the summary in markdown, shaped to the email (skip anything that doesn't apply):`,
      `- Open with **Bottom line** — 1-2 sentences: what this is and what, if anything, ${me ? me.split(' ')[0] : 'the engineer'} needs to do about it.`,
      `- If the sender asks explicit questions, answer each one directly (from the body and images).`,
      `- **Key data** — only the fields actually present: customer, project, Salesforce ID (SR00xxxxx), amount, deadline, product (EL/PDC/ICP/MV/…), part numbers/quantities from images.`,
      `- **Next step** — the single most useful concrete action, naming the exact Vector tab/button. Omit entirely if the email needs no action.`,
    ].filter(Boolean).join('\n');

    try {
      const imageParts = indices.length ? await attachmentParts(entryId, indices) : [];
      const response = await generateWithRetry(ai, {
        model: smartModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
        config: { systemInstruction: summarizeSystem, maxOutputTokens: 8192, temperature: 0.2 },
      });
      const summary = response.text;
      if (summary) {
        runWrite(
          `INSERT OR REPLACE INTO email_summaries (entryId, summary, includedIndices, ts) VALUES (?, ?, ?, ?)`,
          [entryId, summary, indicesKey, new Date().toISOString()],
        );
      }
      res.json({ summary, cached: false, imagesRead: indices.length });
    } catch (e: any) {
      appendLog(`[summarize] ${e?.message || e}`);
      res.json({ summary: null, error: aiErrorText(e) });
    }
  });


  // ── Draft reply using Gemini (learns from past accepted replies) ─────────
  app.post('/api/outlook/draft-reply', async (req, res) => {
    const { subject, sender, senderEmail, received, body, analysis } = req.body as {
      subject: string; sender: string; senderEmail: string;
      received: string; body: string; analysis?: string;
    };
    const ai = getGemini();
    if (!ai) { res.json({ draft: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const me = await connectedUserName();
    const firstName = me ? me.split(' ')[0] : '';

    // Fetch last 5 accepted/sent replies for style context
    const pastReplies = queryAll(
      `SELECT subject, finalReply FROM email_feedback WHERE feedbackType IN ('sent','edited_sent') ORDER BY id DESC LIMIT 5`
    );

    const examplesBlock = pastReplies.length > 0
      ? '\n\n**Your past approved replies (style reference):**\n' +
        pastReplies.map((r, i) => `Example ${i + 1} (re: "${r.subject}"):\n${r.finalReply}`).join('\n\n')
      : '';

    const prompt = [
      `You are drafting a professional email reply on behalf of ${me ? me + ', ' : ''}an Eaton quote engineer in Budapest.`,
      ``,
      `**Original email:**`,
      `From: ${sender} <${senderEmail}>`,
      `Subject: ${subject}`,
      `Received: ${received}`,
      ``,
      (body || '').slice(0, 2500),
      analysis ? `\n**AI analysis of the email:**\n${analysis}` : '',
      examplesBlock,
      ``,
      `Write a professional, concise reply in the same language as the original email.`,
      `- Be direct and actionable. Use ${firstName ? firstName + "'s" : 'a'} tone (professional, friendly, efficient).`,
      `- If quoting timelines or next steps, be specific.`,
      `- Do NOT include a subject line or "Re:" prefix — just the reply body.`,
      `- Do NOT add placeholder text like "[Your Name]" — sign off as "${firstName ? firstName + ' / Eaton Budapest' : 'Eaton Budapest'}".`,
    ].join('\n');

    try {
      const response = await generateWithRetry(ai, {
        model: AI_MODEL_FAST,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // 600 tokens cut real replies off mid-sentence — a thinking model spends
        // part of the budget before it writes a word, so give it real headroom.
        config: { maxOutputTokens: 4096, temperature: 0.3 },
      });
      res.json({ draft: response.text });
    } catch (e: any) {
      res.json({ draft: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── Polish a reply the user actually wrote ────────────────────────────────
  // The Reply box starts blank on purpose: nothing is generated until the user
  // asks. This endpoint takes THEIR raw idea (bullet points, half a sentence,
  // whatever) and returns a sendable email body. `mode` reshapes an existing
  // text instead of writing from scratch — the same call powers Shorten /
  // Formalize / Rewrite on the result, so the user can iterate without
  // re-typing the idea.
  const POLISH_MODES: Record<string, string> = {
    polish:    'Turn the note below into a clean, sendable email. Keep every fact and every commitment; fix grammar, structure and flow. Do not invent new information, dates, prices or promises.',
    shorten:   'Rewrite the text below as short as it can be while keeping every fact and commitment. Cut pleasantries and repetition. Aim for under half the original length.',
    formalize: 'Rewrite the text below in a more formal, corporate register suitable for an external customer. Keep the same content — no new facts.',
    rewrite:   'Rewrite the text below from scratch in different words: same meaning, same facts, clearer structure and a fresh phrasing.',
  };

  app.post('/api/outlook/polish-reply', async (req, res) => {
    const { text, mode, subject, sender, senderEmail, body, analysis } = req.body as {
      text: string; mode?: string; subject?: string; sender?: string;
      senderEmail?: string; body?: string; analysis?: string;
    };
    const raw = String(text || '').trim();
    if (!raw) { res.json({ text: null, error: 'write your idea first' }); return; }
    const ai = getGemini();
    if (!ai) { res.json({ text: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const instruction = POLISH_MODES[String(mode || 'polish')] || POLISH_MODES.polish;
    const me        = await connectedUserName();
    const firstName = me ? me.split(' ')[0] : '';

    const pastReplies = queryAll(
      `SELECT subject, finalReply FROM email_feedback WHERE feedbackType IN ('sent','edited_sent') ORDER BY id DESC LIMIT 5`
    );
    const examplesBlock = pastReplies.length
      ? '\n**Past approved replies (style reference only — do not copy their content):**\n' +
        pastReplies.map((r, i) => `Example ${i + 1} (re: "${r.subject}"):\n${r.finalReply}`).join('\n\n')
      : '';

    const prompt = [
      `You are helping ${me ? me + ', ' : ''}an Eaton quote engineer in Budapest, write an email reply.`,
      instruction,
      ``,
      subject ? `**The email being replied to:**\nFrom: ${sender || ''} <${senderEmail || ''}>\nSubject: ${subject}\n\n${(body || '').slice(0, 2000)}` : '',
      analysis ? `\n**AI summary of that email:**\n${analysis.slice(0, 1500)}` : '',
      examplesBlock,
      ``,
      `**The engineer's own text — this is what you rewrite:**`,
      raw.slice(0, 6000),
      ``,
      `Rules:`,
      `- Reply in the same language as the original email.`,
      `- Output the email BODY only — no subject line, no "Re:", no commentary about what you changed, no markdown fences.`,
      `- Never add facts, dates, prices, part numbers or promises that are not in the engineer's text or the original email.`,
      `- No placeholders like "[Your Name]" — sign off as "${firstName ? firstName + ' / Eaton Budapest' : 'Eaton Budapest'}" unless the text already ends with a sign-off.`,
    ].filter(Boolean).join('\n');

    try {
      const response = await generateWithRetry(ai, {
        model: AI_MODEL_FAST,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 4096, temperature: mode === 'rewrite' ? 0.6 : 0.3 },
      });
      res.json({ text: response.text || null });
    } catch (e: any) {
      appendLog(`[polish-reply] ${e?.message || e}`);
      res.json({ text: null, error: aiErrorText(e) });
    }
  });

  // ── Suggest who to send a quote to, plus a short covering note ────────────
  // Half the "please forward this quote" mails come from a colleague, not from
  // the person who actually needs the PDF, so replying to the sender is the
  // wrong default. Candidates are supplied by the caller (thread recipients,
  // addresses written in the body, harvested contacts) — the model only PICKS
  // from them and never invents an address.
  app.post('/api/outlook/suggest-send', async (req, res) => {
    const { subject, sender, senderEmail, body, analysis, candidates, attachmentNames } = req.body as {
      subject?: string; sender?: string; senderEmail?: string; body?: string; analysis?: string;
      candidates?: Array<{ name?: string; email: string; why?: string }>;
      attachmentNames?: string[];
    };
    const pool = (candidates || []).filter(c => c && c.email).slice(0, 25);
    const ai = getGemini();
    if (!ai) { res.json({ error: 'No Gemini API key — add it in Settings' }); return; }

    const me        = await connectedUserName();
    const firstName = me ? me.split(' ')[0] : '';

    const prompt = [
      `An Eaton quote engineer${me ? ' (' + me + ')' : ''} in Budapest is about to send a quote/document out of Outlook.`,
      ``,
      `**The email that triggered this:**`,
      `From: ${sender || ''} <${senderEmail || ''}>`,
      `Subject: ${subject || ''}`,
      ``,
      (body || '').slice(0, 3000),
      analysis ? `\n**AI summary:**\n${analysis.slice(0, 1200)}` : '',
      attachmentNames?.length ? `\n**Files being attached:** ${attachmentNames.join(', ')}` : '',
      ``,
      `**Address candidates (you MUST pick from this list — never invent an address):**`,
      ...pool.map(c => `- ${c.email}${c.name ? ` (${c.name})` : ''}${c.why ? ` — ${c.why}` : ''}`),
      ``,
      `Decide who should actually RECEIVE the files. If the sender is only asking you to forward something on to someone else, the recipient is that someone else, not the sender.`,
      `Then write a SHORT covering email (3-5 lines, no waffle) to that person, in the language of the original email.`,
      ``,
      `Return STRICT JSON, nothing else:`,
      `{"to":"<one email from the list>","cc":["<optional emails from the list>"],"subject":"<email subject>","body":"<the covering note>","why":"<one short line on why this recipient>"}`,
      `- The body must not invent prices, dates or commitments.`,
      `- No placeholders — sign off as "${firstName ? firstName + ' / Eaton Budapest' : 'Eaton Budapest'}".`,
    ].filter(Boolean).join('\n');

    try {
      const response = await generateWithRetry(ai, {
        model: AI_MODEL_FAST,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 2048, temperature: 0.2, responseMimeType: 'application/json' },
      });
      let parsed: any = {};
      try { parsed = JSON.parse((response.text || '{}').replace(/^```(?:json)?|```$/g, '').trim()); }
      catch { res.json({ error: 'the model did not return usable JSON' }); return; }
      // Never let a hallucinated address through: the recipient must be one of
      // the candidates we handed in.
      const known = new Set(pool.map(c => c.email.toLowerCase()));
      const to  = String(parsed.to || '').trim();
      const cc  = (Array.isArray(parsed.cc) ? parsed.cc : []).map((x: any) => String(x || '').trim())
                    .filter((x: string) => x && known.has(x.toLowerCase()) && x.toLowerCase() !== to.toLowerCase());
      res.json({
        to:      known.has(to.toLowerCase()) ? to : '',
        cc,
        subject: String(parsed.subject || '').trim(),
        body:    String(parsed.body || '').trim(),
        why:     String(parsed.why || '').trim(),
      });
    } catch (e: any) {
      appendLog(`[suggest-send] ${e?.message || e}`);
      res.json({ error: aiErrorText(e) });
    }
  });

  // ── Send reply via Outlook COM ────────────────────────────────────────────
  app.post('/api/outlook/send-reply', async (req, res) => {
    const { entryId, body: replyBody } = req.body as { entryId: string; body: string };
    if (!entryId || !replyBody) { res.json({ error: 'the reply had no text' }); return; }
    try { res.json(await runOutlookPy(['--action', 'send-reply', '--id', entryId, '--body', replyBody])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Store email feedback to improve future drafts ─────────────────────────
  app.post('/api/outlook/feedback', (req, res) => {
    const { entryId, subject, senderEmail, emailType, draftReply, finalReply, feedbackType } = req.body as {
      entryId: string; subject?: string; senderEmail?: string; emailType?: string;
      draftReply?: string; finalReply?: string; feedbackType: string;
    };
    if (!entryId || !feedbackType) { res.json({ error: 'the request was missing the feedback type' }); return; }
    try {
      runWrite(
        `INSERT INTO email_feedback (timestamp, entryId, subject, senderEmail, emailType, draftReply, finalReply, feedbackType)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [new Date().toISOString(), entryId, subject || '', senderEmail || '', emailType || '', draftReply || '', finalReply || '', feedbackType],
      );
      res.json({ ok: true });
    } catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Inline email chat (context-aware follow-up questions) ─────────────────
  // Offline EL price-sheet SEARCH for chat context. Runs schematic_reader in
  // 'search' mode: exact catalogue-number matches PLUS weighted description
  // matches (so a luminaire named only by description in the email — not by
  // part number — is still found in the real sheet instead of guessed). Every
  // row is real sheet data the assistant MUST cite as "EL price sheet".
  // Does the question actually ask about a product / catalogue number / price?
  // Gates the (slower) web search so casual "what does this email want?" turns
  // stay fast and never trigger an external lookup.
  function isPriceProductQuestion(q: string): boolean {
    return /\b(price|pricing|cost|costs|£|\$|€|eur|gbp|quote|list price|ntp|discount|catalogue|catalog|cat[\s\-]?no|part\s*(no|number)|model|alternativ|equivalent|replace|substitut|instead of|cheaper|lumen|ip\s*\d|wattage|spec|datasheet|which product|what product|does eaton|is there a)\b/i.test(q || '');
  }

  // Web-grounded product/price lookup — Gemini + Google Search. Used ONLY when
  // the item isn't found locally in the EL price sheet. Returns the answer text
  // plus clickable citations (grounding source links) so the user can see where
  // each figure came from, ChatGPT/Claude-style.
  async function webGroundedLookup(
    question: string, context: string,
  ): Promise<{ text: string | null; citations: Array<{ title: string; url: string }> }> {
    const ai = getGemini();
    if (!ai) return { text: null, citations: [] };
    const prompt = [
      'You are Ask Vector, helping an Eaton emergency-lighting quote engineer. The item below was NOT found in the internal Eaton EL price sheet, so use Google Search to answer.',
      'Search Eaton product catalogues, datasheets and reputable distributor pages. Identify the correct Eaton/Cooper catalogue number and give what you find.',
      'STRICT RULES:',
      '- Ground every fact in a search result. NEVER invent a catalogue number or a price. If you cannot find it, say so plainly.',
      '- Any price you give is an EXTERNAL/web figure, NOT the Eaton NTP — say so, and tell the user to confirm against the configurator or run the EL Pricer.',
      '- Never say "I was trained on this" or similar — cite the web source.',
      '- Be concise: lead with the answer.',
      context ? `\nEmail context:\n${context.slice(0, 2000)}` : '',
      `\nQuestion: ${question}`,
    ].filter(Boolean).join('\n');
    try {
      const resp = await generateWithRetry(ai, {
        model: smartModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { tools: [{ googleSearch: {} }], maxOutputTokens: 4096, temperature: 0.3 },
      });
      const chunks = (resp as any)?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const seen = new Set<string>();
      const citations: Array<{ title: string; url: string }> = [];
      for (const c of chunks) {
        const url = c?.web?.uri; if (!url || seen.has(url)) continue;
        seen.add(url);
        let title = c?.web?.title || '';
        try { title = title || new URL(url).hostname.replace(/^www\./, ''); } catch {}
        citations.push({ title, url });
      }
      return { text: resp.text ?? null, citations: citations.slice(0, 6) };
    } catch (e: any) {
      console.error(`[web-lookup] ${e.message}`);
      return { text: null, citations: [] };
    }
  }

  app.post('/api/outlook/chat', async (req, res) => {
    const { entryId, subject, sender, senderEmail, body, analysis, history, question, includeIndices } = req.body as {
      entryId?: string; subject: string; sender: string; senderEmail: string; body: string;
      analysis?: string; history: Array<{ role: 'user' | 'ai'; text: string }>; question: string;
      includeIndices?: number[];
    };
    const ai = getGemini();
    if (!ai) { res.json({ answer: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const chatIndices = Array.from(new Set((includeIndices || []).filter(n => Number.isFinite(n))));

    const me = await connectedUserName();
    // Real EL price-sheet rows: search on the QUESTION (what they're asking about)
    // and on the BODY (ambient context, cached per email). Dedup, question first.
    const [qRows, bodyRows] = await Promise.all([
      elSheetSearch(question, undefined),
      elSheetSearch(body || '', entryId ? `body:${entryId}` : undefined),
    ]);
    const sheetRows: ElSheetRow[] = [];
    const seenCat = new Set<string>();
    for (const r of [...qRows, ...bodyRows]) {
      if (r.catNo && !seenCat.has(r.catNo)) { seenCat.add(r.catNo); sheetRows.push(r); }
    }
    const sheetBlock = sheetRows.length
      ? [
          `Eaton EL price-sheet rows relevant to this email / question (ex VAT — the AUTHORITATIVE internal source; cite as "EL price sheet"):`,
          ...sheetRows.slice(0, 14).map(fmtElRow),
          `[exact] = confirmed part-number match. [description-match] = a candidate found by description; present it as "closest match in the sheet", not a confirmed part.`,
        ].join('\n')
      : `No catalogue number or description from this email/question matched the Eaton EL price sheet. Do NOT invent one — say it isn't in the sheet and offer to run the EL Pricer or search the web.`;
    const fenBlock = fentonKnowledgeBlock(20);
    const systemCtx = [
      `You are Ask Vector — the same AI brain used across this app — now helping ${me ? me + ', ' : ''}an Eaton quote engineer in Budapest with the email they have open in the Inbox.`,
      `Answer directly and concisely: bottom line first, no filler, no restating the question, no "this is an email". The user is already in the Inbox — never tell them to open it or click Summarize.`,
      ``,
      `## Sourcing rules (MANDATORY — the user complained about invented numbers)`,
      `- Every catalogue number or price you state MUST name its source in the answer: EL price-sheet rows → "(EL price sheet)"; the LoadStar-PS table below → "(LoadStar-PS list)".`,
      `- NEVER invent or approximate a catalogue number or a price. If it isn't in the data below, say "that's not in the EL price sheet" and offer to run the EL Pricer or search the web — do NOT guess a figure.`,
      `- NEVER say you were "trained on" a price, that you "just know" it, or anything about your training. If you can't source it from the data below, you don't state it.`,
      `- A [description-match] row is a CANDIDATE, not a confirmed part — say so.`,
      ``,
      `## Price source 1 — Eaton LoadStar-PS CBU list prices (3hr autonomy, ex VAT):`,
      `Single Phase: 0.5KVA=£5,501 | 1KVA=£7,452 | 2KVA=£8,961 | 4KVA=£12,085 | 5KVA=£13,475 | 8KVA=£24,432 | 10KVA=£27,214 | 12KVA=£36,780 | 15KVA=£40,952 | 16KVA=£49,128 | 20KVA=£54,690`,
      `Three Phase: 6KVA=£14,939 | 8KVA=£21,048 | 10KVA=£22,913 | 12KVA=£31,483 | 14KVA=£36,225 | 16KVA=£37,996 | 18KVA=£39,457 | 20KVA=£45,780 | 24KVA=£63,228 | 28KVA=£72,713 | 30KVA=£69,265 | 32KVA=£76,256 | 36KVA=£79,177 | 40KVA=£91,824 | 42KVA=£109,201 | 48KVA=£114,515 | 54KVA=£118,897 | 56KVA=£145,689 | 60KVA=£137,867 | 64KVA=£152,775 | 72KVA=£158,617 | 80KVA=£183,910`,
      `Note: No 50KVA system exists — nearest are 48KVA (£114,515) and 54KVA (£118,897).`,
      ``,
      `## Price source 2 — Eaton EL luminaire price sheet`,
      sheetBlock,
      fenBlock ? `\n${fenBlock}` : '',
      ``,
      `Current email:`,
      `From: ${sender} <${senderEmail}>`,
      `Subject: ${subject}`,
      ``,
      (body || '').slice(0, 8000),
      analysis ? `\nEmail summary so far:\n${analysis}` : '',
      chatIndices.length ? `\nImage(s)/document(s) from this email are attached to the latest question — read them to answer.` : '',
    ].join('\n');

    try {
      // Web fallback: fires ONLY when the item isn't found locally with CONFIDENCE
      // (an exact cat-no or a strong description score — loose keyword overlap like
      // "emergency luminaire" matching many rows doesn't count as "found") and the
      // question is about a product/price (and no image attached — those go the
      // multimodal route below). Returns clickable sources.
      const strongLocal = qRows.some(r => r.matchType === 'exact' || r.score >= 9);
      const wantWeb = isPriceProductQuestion(question) && !strongLocal && chatIndices.length === 0;
      if (wantWeb) {
        const web = await webGroundedLookup(question, `${subject}\n${(body || '').slice(0, 2000)}`);
        if (web.text) {
          const cites = web.citations.length
            ? '\n\n**Sources:**\n' + web.citations.map(c => `- [${c.title}](${c.url})`).join('\n')
            : '';
          res.json({ answer: web.text + cites, sourced: 'web' });
          return;
        }
        // web found nothing usable → fall through to the grounded local answer.
      }

      const imageParts = (entryId && chatIndices.length) ? await attachmentParts(entryId, chatIndices) : [];
      const contents = [
        ...history.map(m => ({
          role: m.role === 'user' ? 'user' : 'model' as const,
          parts: [{ text: m.text }],
        })),
        { role: 'user' as const, parts: [{ text: question }, ...imageParts] },
      ];
      const response = await generateWithRetry(ai, {
        model: smartModel(),
        contents,
        // 2.5-pro thinking tokens share the output budget in this SDK — keep headroom.
        config: { systemInstruction: systemCtx, maxOutputTokens: 6144, temperature: 0.3 },
      });
      res.json({ answer: response.text, sourced: sheetRows.length ? 'price_sheet' : 'none' });
    } catch (e: any) {
      res.json({ answer: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── EL Internal Info — EATON_Emergency_Lighting_INTERNAL updates ────────────
  const EL_SENDER_MATCH = 'emergency_lighting_internal';
  const elParseAtts = (s: string) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  const elRows = () =>
    queryAll('SELECT entryId, received, subject, sender, senderEmail, body, attachments FROM el_internal ORDER BY received DESC')
      .map(r => ({ ...r, attachments: elParseAtts(r.attachments) }));
  const elMeta = () => queryAll('SELECT digest, digestAt, lastRefreshAt FROM el_internal_meta WHERE id = 1')[0] || {};
  const elWriteMeta = (patch: { digest?: string | null; digestAt?: string | null; lastRefreshAt?: string | null }) => {
    const cur = elMeta();
    runWrite('INSERT OR REPLACE INTO el_internal_meta (id, digest, digestAt, lastRefreshAt) VALUES (1, ?, ?, ?)', [
      patch.digest        !== undefined ? patch.digest        : (cur.digest ?? null),
      patch.digestAt      !== undefined ? patch.digestAt      : (cur.digestAt ?? null),
      patch.lastRefreshAt !== undefined ? patch.lastRefreshAt : (cur.lastRefreshAt ?? null),
    ]);
  };
  // Corpus text for the AI (subjects + bodies + file names), newest first.
  const elCorpus = (rows: any[], perBody = 2500) => rows.map((e, i) =>
    `### ${i + 1}. ${String(e.received || '').slice(0, 10)} — ${e.subject}\n${String(e.body || '').slice(0, perBody)}`
    + ((e.attachments || []).length ? `\n[attached files: ${e.attachments.map((a: any) => a.name).join(', ')}]` : '')
  ).join('\n\n');

  app.get('/api/el-internal/list', (_req, res) => {
    const m = elMeta();
    res.json({ emails: elRows(), digest: m.digest ?? null, digestAt: m.digestAt ?? null, lastRefreshAt: m.lastRefreshAt ?? null });
  });

  // Pull this year's emails from the sender, upsert new ones (incremental).
  app.post('/api/el-internal/refresh', async (_req, res) => {
    try {
      const since = `01/01/${new Date().getFullYear()}`;
      const r = await runOutlookPy(['--action', 'emails-from', '--sender', EL_SENDER_MATCH, '--since', since]);
      const fetched = (r.emails || []) as any[];
      const existing = new Set(queryAll('SELECT entryId FROM el_internal').map((x: any) => x.entryId));
      const now = new Date().toISOString();
      let added = 0;
      for (const e of fetched) {
        runWrite(
          `INSERT OR REPLACE INTO el_internal (entryId, received, subject, sender, senderEmail, body, attachments, ts) VALUES (?,?,?,?,?,?,?,?)`,
          [e.entryId, e.received || '', e.subject || '', e.sender || '', e.senderEmail || '', e.body || '', JSON.stringify(e.attachments || []), now],
        );
        if (!existing.has(e.entryId)) added++;
      }
      elWriteMeta({ lastRefreshAt: now });
      res.json({ added, total: fetched.length, emails: elRows(), lastRefreshAt: now, error: r.error });
    } catch (e: any) {
      res.json({ error: e.message, emails: elRows() });
    }
  });

  // Consolidated "current state" digest across all stored updates.
  app.post('/api/el-internal/digest', async (_req, res) => {
    const ai = getGemini();
    if (!ai) { res.json({ digest: null, error: 'No Gemini API key — add it in Settings' }); return; }
    const rows = elRows();
    if (rows.length === 0) { res.json({ digest: null, error: 'No EL internal emails stored yet — hit Refresh first.' }); return; }
    const me = await connectedUserName();
    const prompt = [
      `You are compiling a living internal-updates brief for ${me ? me + ', ' : ''}an Eaton Emergency Lighting (EL) engineer in Budapest,`,
      `from ALL ${rows.length} internal update emails sent this year by EATON_Emergency_Lighting_INTERNAL.`,
      ``,
      `Produce a concise Markdown digest of the CURRENT state, grouped under these exact headings (skip a heading if it has nothing):`,
      `## 🆕 New / Launched`,
      `## ⛔ Discontinued / Phased out`,
      `## 📦 Stock & Availability`,
      `## 🔧 Technical / Other`,
      ``,
      `Rules: one bullet per item, prefix each with its date (YYYY-MM-DD). When the same product/topic was updated multiple times, MERGE into one bullet reflecting the latest status. Be factual, no filler. Mention key part numbers/product names.`,
      ``,
      `--- UPDATE EMAILS (newest first) ---`,
      elCorpus(rows),
    ].join('\n');
    try {
      const response = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 4096, temperature: 0.2 },
      });
      const digest = response.text; const now = new Date().toISOString();
      if (digest) elWriteMeta({ digest, digestAt: now });
      res.json({ digest, digestAt: now });
    } catch (e: any) {
      const detail = e.cause?.message ? ` (${e.cause.message})` : '';
      res.json({ digest: null, error: 'Gemini error: ' + e.message + detail });
    }
  });

  // Ask-AI across all stored EL internal updates.
  app.post('/api/el-internal/chat', async (req, res) => {
    const { history, question } = req.body as { history: Array<{ role: 'user' | 'ai'; text: string }>; question: string };
    const ai = getGemini();
    if (!ai) { res.json({ answer: null, error: 'No Gemini API key — add it in Settings' }); return; }
    const rows = elRows();
    if (rows.length === 0) { res.json({ answer: null, error: 'No EL internal emails stored yet — hit Refresh first.' }); return; }
    const me = await connectedUserName();
    const systemCtx = [
      `You help ${me ? me + ', ' : ''}an Eaton Emergency Lighting engineer using Vector.`,
      `Answer questions about EL division internal updates using ONLY the emails below. Cite the update date (YYYY-MM-DD) you drew from. If something isn't covered, say so plainly. Be concise and direct.`,
      ``,
      `--- EL INTERNAL UPDATE EMAILS (newest first) ---`,
      elCorpus(rows, 2000),
    ].join('\n');
    const contents = [
      ...(history || []).map(m => ({ role: m.role === 'user' ? 'user' : 'model' as const, parts: [{ text: m.text }] })),
      { role: 'user' as const, parts: [{ text: question }] },
    ];
    try {
      const response = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents,
        config: { systemInstruction: systemCtx, maxOutputTokens: 1200, temperature: 0.3 },
      });
      res.json({ answer: response.text });
    } catch (e: any) {
      res.json({ answer: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── Fenton KB — Mark Fenton's expert answers → Q&A knowledge cards ──────────
  const FENTON_SENDER    = 'markafenton';
  const FENTON_RECIPIENTS = 'laithal-soub,ukquotefactoryel';
  const fenParseJson = (s: string, fb: any) => { try { return JSON.parse(s || ''); } catch { return fb; } };
  // Cards for the tab and the chat corpus: admin traffic the extractor rejected
  // stays in the table (so a refresh never re-fetches it) but never surfaces.
  const fenCards = () =>
    queryAll(`SELECT entryId, received, subject, senderEmail, body, attachments, topic, question, answer, tags, extracted, folder
                FROM fenton_kb WHERE COALESCE(skipped, 0) = 0 ORDER BY received DESC`)
      .map(r => ({ ...r, attachments: fenParseJson(r.attachments, []), tags: fenParseJson(r.tags, []) }));
  const fenMeta = () => queryAll('SELECT lastRefreshAt FROM fenton_meta WHERE id = 1')[0] || {};

  // Pull the first JSON array out of a model response (handles ``` fences / prose).
  function firstJsonArray(text: string): any[] | null {
    const stripped = (text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try { const p = JSON.parse(stripped); if (Array.isArray(p)) return p; } catch {}
    const start = text.indexOf('[');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
  }

  // AI-extract Q&A cards for rows that don't have one yet.
  //
  // Chunked: the sweep now spans both mailboxes, so a first run has hundreds of
  // emails — one prompt would blow past the output cap and lose every card in
  // it. Each batch is written before the next runs, so a failure mid-way keeps
  // what already succeeded and a later refresh picks up the rest.
  const FENTON_BATCH = 20;
  async function fentonExtract(force: boolean): Promise<void> {
    const ai = getGemini();
    if (!ai) return;
    const rows = queryAll(
      `SELECT entryId, received, subject, body FROM fenton_kb ${force ? '' : 'WHERE extracted = 0'} ORDER BY received DESC`
    );
    if (rows.length === 0) return;

    for (let start = 0; start < rows.length; start += FENTON_BATCH) {
      const batch = rows.slice(start, start + FENTON_BATCH);
      const list = batch.map((r: any, i: number) =>
        `#### idx ${i} · ${String(r.received).slice(0, 10)} · ${r.subject}\n${String(r.body || '').slice(0, 2500)}`
      ).join('\n\n');
      const prompt = [
        `You are cataloguing the ENGINEERING EXPERTISE of Mark Fenton (Senior Lighting Application Engineer, Eaton UK) from emails he sent to the EL quote team.`,
        `The knowledge base must contain only what a colleague could REUSE later: technical judgement, product/application rules, pricing and quoting conventions, process rules.`,
        ``,
        `For EACH email below output one JSON object with:`,
        `- "idx": the email's idx number`,
        `- "keep": true only if the email carries reusable technical or expertise content; false otherwise`,
        `- "topic": a short title (max 8 words)`,
        `- "question": what was asked or the situation/problem being addressed (infer from the quoted thread/subject if needed; max 30 words)`,
        `- "answer": Mark's guidance/answer as reusable knowledge, 1-3 sentences. Capture the ACTIONABLE fact/rule, not pleasantries.`,
        `- "tags": array of 2-4 lowercase keywords (e.g. "bidman", "loadstar", "dualguard", "pricing", "salesforce")`,
        ``,
        `Set "keep": false (and leave the other fields empty) for pure ADMIN traffic with no expertise in it:`,
        `out-of-office and automatic replies, holiday/cover notices, order confirmations and despatch notes,`,
        `"thanks"/"noted"/"see attached" with no explanation, meeting invites and logistics, chasing for an update,`,
        `and plain forwards that add no comment of Mark's own.`,
        `A technical answer buried in an otherwise routine email still counts as keep: true.`,
        `Output ONLY a JSON array of these objects, nothing else.`,
        ``,
        `--- EMAILS ---`,
        list,
      ].join('\n');
      try {
        const resp = await generateWithRetry(ai, {
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 8192, temperature: 0.2, responseMimeType: 'application/json' },
        });
        const arr = firstJsonArray(resp.text || '');
        if (!arr) continue;
        const now = new Date().toISOString();
        for (const card of arr) {
          const row = batch[card.idx];
          if (!row) continue;
          // An email the model kept but left without an answer carries nothing
          // to recall, so it is admin in practice — drop it too.
          const answer = String(card.answer || '').trim();
          const keep = card.keep !== false && !!answer;
          runWrite(
            `UPDATE fenton_kb SET topic=?, question=?, answer=?, tags=?, extracted=1, skipped=?, ts=? WHERE entryId=?`,
            [String(card.topic || ''), String(card.question || ''), answer,
             JSON.stringify(Array.isArray(card.tags) ? card.tags : []), keep ? 0 : 1, now, row.entryId],
          );
        }
      } catch { /* leave this batch unextracted; a later refresh retries it */ }
    }
  }

  app.get('/api/fenton/list', (_req, res) => {
    res.json({ cards: fenCards(), lastRefreshAt: fenMeta().lastRefreshAt ?? null });
  });

  // Fetch Mark Fenton's recent emails → upsert → AI-extract Q&A. Shared by the
  // (now headless) refresh endpoint and the background timer below, so the Fenton
  // knowledge base stays fresh for Ask Vector even though the tab is gone.
  async function refreshFentonKB(force: boolean): Promise<{ added: number; total: number; skipped: number; lastRefreshAt: string; error?: string }> {
    const since = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; })();
    const r = await runOutlookPy(['--action', 'emails-from', '--sender', FENTON_SENDER,
      '--recipient', FENTON_RECIPIENTS, '--since', since, '--skip-auto']);
    const fetched = (r.emails || []) as any[];
    const existing = new Set(queryAll('SELECT entryId FROM fenton_kb').map((x: any) => x.entryId));
    const now = new Date().toISOString();
    let added = 0;
    for (const e of fetched) {
      if (existing.has(e.entryId)) {
        runWrite(`UPDATE fenton_kb SET received=?, subject=?, senderEmail=?, body=?, attachments=?, folder=? WHERE entryId=?`,
          [e.received || '', e.subject || '', e.senderEmail || '', e.body || '', JSON.stringify(e.attachments || []), e.folder || '', e.entryId]);
      } else {
        runWrite(
          `INSERT INTO fenton_kb (entryId, received, subject, senderEmail, body, attachments, folder, topic, question, answer, tags, extracted, skipped, ts)
           VALUES (?,?,?,?,?,?,?,'','','','[]',0,0,?)`,
          [e.entryId, e.received || '', e.subject || '', e.senderEmail || '', e.body || '',
           JSON.stringify(e.attachments || []), e.folder || '', now]);
        added++;
      }
    }
    await fentonExtract(force);
    runWrite('INSERT OR REPLACE INTO fenton_meta (id, lastRefreshAt) VALUES (1, ?)', [now]);
    const skipped = Number(queryAll('SELECT COUNT(*) c FROM fenton_kb WHERE skipped = 1')[0]?.c || 0);
    return { added, total: fetched.length, skipped, lastRefreshAt: now, error: r.error };
  }

  app.post('/api/fenton/refresh', async (req, res) => {
    try {
      const out = await refreshFentonKB(!!(req.body && req.body.force));
      res.json({ ...out, cards: fenCards() });
    } catch (e: any) {
      res.json({ error: e.message, cards: fenCards() });
    }
  });

  // Keep the KB fresh without a tab: kick once ~90s after boot if stale (>12h),
  // then every 6h, but only when Outlook + a JOE session are actually available.
  let _fentonRefreshing = false;
  async function maybeRefreshFenton() {
    if (_fentonRefreshing || !getSpCookies()) return;
    // Gate matched to the 6h interval, so each tick actually refreshes and the
    // base is never more than a working half-day behind. Incremental runs are
    // cheap: only genuinely new emails reach the extractor.
    const last = fenMeta().lastRefreshAt as string | undefined;
    if (last && Date.now() - new Date(last).getTime() < 6 * 3600 * 1000 - 60_000) return;
    _fentonRefreshing = true;
    try { await refreshFentonKB(false); appendLog('[fenton] background KB refresh done'); }
    catch (e: any) { appendLog('[fenton] background refresh failed: ' + e.message); }
    _fentonRefreshing = false;
  }
  setTimeout(maybeRefreshFenton, 90_000);
  setInterval(maybeRefreshFenton, 6 * 3600 * 1000);

  app.post('/api/fenton/chat', async (req, res) => {
    const { history, question } = req.body as { history: Array<{ role: 'user' | 'ai'; text: string }>; question: string };
    const ai = getGemini();
    if (!ai) { res.json({ answer: null, error: 'No Gemini API key — add it in Settings' }); return; }
    const rows = fenCards();
    if (rows.length === 0) { res.json({ answer: null, error: 'No Fenton emails stored yet — hit Refresh first.' }); return; }
    const me = await connectedUserName();
    const corpus = rows.map((r: any, i: number) =>
      `### ${i + 1}. ${String(r.received).slice(0, 10)} — ${r.subject}\n${r.answer ? `Mark's guidance: ${r.answer}\n` : ''}${String(r.body || '').slice(0, 1800)}`
    ).join('\n\n');
    const systemCtx = [
      `You are the knowledge base of Mark Fenton (Senior Lighting Application Engineer, Eaton UK) — the EL team's go-to expert.`,
      `Answer ${me ? me + "'s" : 'the user\'s'} questions using ONLY Mark's emails/answers below. Speak as a distilled reference of what Mark has advised. Cite the date (YYYY-MM-DD) of the relevant answer. If it isn't covered, say so plainly. Be concise and practical.`,
      ``,
      `--- MARK FENTON'S EMAILS & ANSWERS (newest first) ---`,
      corpus,
    ].join('\n');
    const contents = [
      ...(history || []).map(m => ({ role: m.role === 'user' ? 'user' : 'model' as const, parts: [{ text: m.text }] })),
      { role: 'user' as const, parts: [{ text: question }] },
    ];
    try {
      const response = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash', contents,
        config: { systemInstruction: systemCtx, maxOutputTokens: 1200, temperature: 0.3 },
      });
      res.json({ answer: response.text });
    } catch (e: any) {
      res.json({ answer: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── Flag / unflag email ───────────────────────────────────────────────────
  app.post('/api/outlook/flag', async (req, res) => {
    const { entryId, flagged } = req.body as { entryId: string; flagged: boolean };
    if (!entryId) { res.json({ error: 'the request did not say which email' }); return; }
    try { res.json(await runOutlookPy(['--action', 'flag', '--id', entryId, '--flagged', flagged ? '1' : '0'])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Mark email as unread ──────────────────────────────────────────────────
  app.post('/api/outlook/mark-unread', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'the request did not say which email' }); return; }
    try { res.json(await runOutlookPy(['--action', 'mark-unread', '--id', entryId])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Delete email ──────────────────────────────────────────────────────────
  app.delete('/api/outlook/email/:id', async (req, res) => {
    try { res.json(await runOutlookPy(['--action', 'delete', '--id', decodeURIComponent(req.params.id)])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Forward email ─────────────────────────────────────────────────────────
  app.post('/api/outlook/forward', async (req, res) => {
    const { entryId, to, body: fwdBody } = req.body as { entryId: string; to: string; body?: string };
    if (!entryId || !to) { res.json({ error: 'no forward address was given' }); return; }
    try { res.json(await runOutlookPy(['--action', 'forward', '--id', entryId, '--to', to, '--body', fwdBody || ''])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Open in Outlook ───────────────────────────────────────────────────────
  app.post('/api/outlook/open-in-outlook', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'the request did not say which email' }); return; }
    try { res.json(await runOutlookPy(['--action', 'open-in-outlook', '--id', entryId])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Categorize email ──────────────────────────────────────────────────────
  app.post('/api/outlook/categorize', async (req, res) => {
    const { entryId, category } = req.body as { entryId: string; category: string };
    if (!entryId) { res.json({ error: 'the request did not say which email' }); return; }
    try { res.json(await runOutlookPy(['--action', 'categorize', '--id', entryId, '--category', category || ''])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Suggest attachments from Outlook (PDF search) ────────────────────────
  app.get('/api/outlook/suggest-attachments', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) { res.json({ results: [] }); return; }
    try { res.json(await runOutlookPy(['--action', 'suggest-attachments', '--query', q])); }
    catch (e: any) { res.json({ results: [], error: e.message }); }
  });

  // ── Reply with Outlook-sourced attachments ────────────────────────────────
  app.post('/api/outlook/reply-with-attachments', async (req, res) => {
    const { entryId, body: replyBody, attSources } = req.body as {
      entryId: string; body: string; attSources: Array<{ entryId: string; index: number }>;
    };
    if (!entryId || !replyBody) { res.json({ error: 'the reply had no text' }); return; }
    try {
      res.json(await runOutlookPy([
        '--action', 'reply-with-attachments',
        '--id', entryId,
        '--body', replyBody,
        '--att-sources', JSON.stringify(attSources || []),
      ]));
    } catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Send new email (with optional Outlook-sourced attachments) ─────────────
  app.post('/api/outlook/send-new', async (req, res) => {
    const { to, cc, subject, body: emailBody, attSources, draft } = req.body as {
      to: string; cc?: string; subject: string; body?: string;
      attSources?: Array<{ entryId: string; index: number }>; draft?: boolean;
    };
    if (!to || !subject) { res.json({ error: 'fill in both To and Subject' }); return; }
    try {
      res.json(await runOutlookPy([
        '--action', 'send-new',
        '--to', to,
        ...(cc ? ['--cc', cc] : []),
        '--subject', subject,
        '--body', emailBody || '',
        '--att-sources', JSON.stringify(attSources || []),
        ...(draft ? ['--draft', '1'] : []),
      ]));
    } catch (e: any) { res.json({ error: e.message }); }
  });

  // ── In-app feedback: store locally + best-effort email to the maintainer ──────
  const FEEDBACK_TO  = 'laith.soub90@gmail.com';
  const APP_VERSION  = process.env.APP_VERSION || '2.0';
  app.post('/api/feedback', async (req, res) => {
    const { message, category, page, userName, userEmail } = req.body as {
      message?: string; category?: string; page?: string; userName?: string; userEmail?: string;
    };
    const msg = String(message || '').trim();
    if (!msg) { res.status(400).json({ error: 'type your feedback first' }); return; }

    const ts = new Date().toISOString();
    let emailed = 0;

    // Best-effort send via Outlook COM (team is on Eaton Outlook). Never blocks save.
    try {
      const subject = `Vector Feedback${category ? ` [${category}]` : ''} — ${userName || userEmail || 'user'}`;
      const body = [
        msg, '',
        '──────────────',
        `From:    ${userName || '—'} <${userEmail || '—'}>`,
        `Page:    ${page || '—'}`,
        `Version: ${APP_VERSION}`,
        `Time:    ${ts}`,
      ].join('\n');
      const r = await runOutlookPy(['--action', 'send-new', '--to', FEEDBACK_TO,
        '--subject', subject, '--body', body, '--att-sources', '[]']);
      if (r && r.ok) emailed = 1;
    } catch { /* stored locally regardless */ }

    try {
      db.run(`INSERT INTO app_feedback
              (timestamp, category, message, page, userName, userEmail, appVersion, emailed)
              VALUES (?,?,?,?,?,?,?,?)`,
        [ts, category || '', msg, page || '', userName || '', userEmail || '', APP_VERSION, emailed]);
      saveDb();
    } catch (e: any) {
      res.json({ ok: emailed === 1, stored: false, emailed: !!emailed, error: e.message });
      return;
    }
    res.json({ ok: true, stored: true, emailed: !!emailed });
  });

  app.get('/api/search', async (req, res) => {
    const q       = String(req.query.q || '').trim();
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!q) { res.json({ results: [] }); return; }
    if (!cookies) { res.json({ results: [], error: 'Not connected — run "Connect to Joe" first.' }); return; }

    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    try {
      res.json({ results: await quotationsListSearch(q, cookieStr, cfg) });
    } catch (e: any) { res.json({ results: [], error: e.message }); }
  });

  // ── D&Q Store full-text search (name + PDF content via SharePoint index) ───
  // Unlike Outlook, SharePoint's search index covers the *body text* of quote
  // PDFs and emails, so "4kva" matches even when it only appears inside the file.
  app.get('/api/dq-search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) { res.json({ results: [], total: 0 }); return; }

    // "Mine only" (default on): restrict to quotes whose SharePoint Created By is
    // the connected user. Pass ?mine=0 to search the whole store.
    const mineOnly = req.query.mine !== '0' && req.query.mine !== 'false';

    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) {
      res.json({ results: [], error: 'Not connected — click "Connect to JOE" first.' });
      return;
    }
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;
    try {
      const { results, total, author } = await dqFullTextSearch(q, mineOnly, cookieStr, cfg);
      res.json({ results, total, mine: mineOnly && !!author, author });
    } catch (e: any) {
      res.json({ results: [], error: e.message });
    }
  });

  // ── Smart quote search in the AI chat ─────────────────────────────────────
  // Single brain for the Assistant chat. Classifies each typed message as a
  // search or normal chat; for searches it runs the D&Q full-text index +
  // Quotations List metadata (mine-scoped) and lets Gemini answer in prose
  // (count from TotalRows, salesmen, materials) with clickable result cards.
  app.post('/api/quote-ask', async (req, res) => {
    const { query, history } = req.body as {
      query: string;
      history?: Array<{ role: string; text: string }>;
    };
    if (!query?.trim()) { res.json({ answer: null, error: 'no question was sent' }); return; }

    const ai = getGemini();
    if (!ai) { res.json({ answer: null, error: 'No Gemini API key — add gemini_key in Settings' }); return; }

    // ── 1. Classify intent + extract a clean search term ────────────────────
    let intent: 'search' | 'chat' | 'crm' = 'chat';
    let term = query.trim();
    let scope: 'mine' | 'all' = 'mine';
    let mode: 'list' | 'count' | 'who' | 'material' = 'list';
    let salesman = '';   // set when the query is about a specific salesman's quotes
    // Recent conversation so follow-ups ("try again", "do it", "yes") resolve to
    // the prior search instead of being misread as a fresh, intentless message.
    const histCtx = (history || []).slice(-4)
      .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.text).replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    try {
      const cls = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text:
          `You route messages for an Eaton quote-automation app. The user can search their quotes `
          + `(stored on SharePoint — searchable by customer, salesman, KVA rating, catalogue/fitting `
          + `number, or any text inside the quote PDF/email) OR ask a general question about the app/workflow.\n`
          + (salesmenRoster().length
              ? `Known sales reps (salesmen whose names appear in quotes, for salesman-scoped searches): ${salesmenRoster().map(s => s.name).join(', ')}.\n\n`
              : '')
          + (histCtx ? `Recent conversation (for context, oldest first):\n${histCtx}\n\n` : '')
          + `New message: "${query.replace(/"/g, "'")}"\n\n`
          + `Reply with ONLY a JSON object, no prose:\n`
          + `{"intent":"search"|"chat"|"crm","term":"<keywords to search, filler removed>",`
          + `"scope":"mine"|"all","mode":"list"|"count"|"who"|"material","salesman":"<full name or empty>"}\n`
          + `Rules (apply in order):\n`
          + `- CONVERSATION CONTINUITY IS DECISIVE. Read the recent conversation. If the assistant's last reply was answering a PRODUCT / PART / PRICE / ALTERNATIVE / DATASHEET question (about a catalogue number or a product — NOT about the user's past quotes), then a short follow-up that refines or continues it STAYS intent="chat". Examples that MUST stay chat in that context: "family names and part codes", "give me the codes", "list them", "cut the crap", "just the codes", "what about cheaper ones", "in the sheet", "and the prices", "search the web", "more options". NEVER flip to quote-search just because such a follow-up contains the words "family", "part", "code", "price", or "name".\n`
          + `- DEFAULT to intent="chat" when unsure. Choose intent="search" ONLY when the user clearly wants their OWN PAST QUOTES — signalled by a customer/company name, a salesman name, an SR/quote number, "my quotes", "quotes for/from…", or "how many quotes". A product / price / alternative / datasheet question is NEVER a quote search.\n`
          + `- intent="crm" if they want to EDIT the CRM: add/update a contact, note a fact about a customer/account, mark a quote won/lost, create an account, set a note, or tag an account.\n`
          + `- intent="search" if they want to find/count their past quotes, who made them, or what's inside them.\n`
          + `- A message that is JUST a bare spec/rating (e.g. "4kVA"), a customer name, or a salesman name — with no product or how-to question and no conversation implying otherwise — is intent="search". (A bare catalogue number IS a product lookup → intent="chat", see below.)\n`
          + `- BUT a message asking to FIND AN ALTERNATIVE / EQUIVALENT / REPLACEMENT / SUBSTITUTE / CROSS-REFERENCE for a part, to COMPARE parts, for a DATASHEET / SPEC of a part, or to look a part up in the PRICE SHEET / PRICE LIST / PRICING SHEET / EL sheet (its price, description, whether it exists, whether it is an Eaton item), is intent="chat" (a product question answered from the internal EL price sheet + knowledge + live web) — NOT a quote search — EVEN IF it contains a catalogue/part number. The "quote search" is ONLY for the user's own past SharePoint quotes; it is NOT the product price sheet. E.g. "alternative to 40071352916", "equivalent of <cat-no>", "datasheet for <cat-no>", "look it up in the pricing sheet", "is <cat-no> an Eaton item", "what's the price of <cat-no>" are ALL intent="chat".\n`
          + `- FOLLOW-UPS: if the new message is "try again", "do it", "again", "yes", "retry", "go", or similar, repeat the intent (chat OR search) and term of the MOST RECENT request in the conversation above — if the last exchange was a product/alternative chat, "try again" stays chat (do NOT use the literal words "try again" as the term).\n`
          + `- salesman = the team member's full name ONLY if the query is about quotes a specific salesman made/raised/owns (e.g. "quotes from Joe Bayley", "how many did Ryan do"); else "".\n`
          + `- scope="all" only if they explicitly ask about everyone/the whole team, else "mine".\n`
          + `- mode="count" for "how many", "who" for who-quoted/salesman, "material" for catalogue/fitting/part questions, else "list".\n`
          + `- term = the core search words only (drop "find/show/how many/quotes/that have"); for a salesman query, term may be the salesman name.`
        }] }],
        // gemini-2.5-flash is a thinking model; without thinkingBudget:0 the
        // reasoning tokens consume the whole budget and resp.text comes back
        // empty, silently defaulting every message to chat. Disable thinking
        // so classification is fast, deterministic, and actually returns JSON.
        config: { maxOutputTokens: 256, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      });
      const parsed = extractObject(cls.text ?? '');
      if (parsed) {
        if (parsed.intent === 'search') intent = 'search';
        if (parsed.intent === 'crm')    intent = 'crm';
        if (typeof parsed.term === 'string' && parsed.term.trim()) term = parsed.term.trim();
        if (parsed.scope === 'all') scope = 'all';
        if (['list', 'count', 'who', 'material'].includes(parsed.mode)) mode = parsed.mode;
        if (typeof parsed.salesman === 'string' && parsed.salesman.trim()) salesman = parsed.salesman.trim();
      }
    } catch { /* fall through to chat on classify failure */ }

    // ── 2a. CRM edit → execute the instruction, confirm in prose ────────────
    if (intent === 'crm') {
      const cr = await runCrmCommand(query);
      if (cr.answer) { res.json({ answer: cr.answer, results: [], crmChanged: !!cr.changed }); return; }
      // Not actually a CRM command → fall through to plain chat.
    }

    // ── 2. Plain chat → shared chat brain, no cards ─────────────────────────
    if (intent !== 'search') {
      const r = await chatAnswer(query, history);
      res.json({ ...r, results: [] });
      return;
    }

    // ── 3. Search → needs JOE ───────────────────────────────────────────────
    const cfg     = loadPyCfg();
    const cookies = getSpCookies();
    if (!cookies) {
      res.json({
        answer: 'I can search your quotes, but you are not connected to SharePoint yet. '
          + 'Click **Connect to JOE** in the top header, then ask me again.',
        results: [],
      });
      return;
    }
    const cookieStr = `FedAuth=${cookies.fed}; rtFa=${cookies.rt}`;

    // Keywords for the search: combine any detected salesman name with the
    // extracted term so compound asks ("Joe Bayley with 4kVA") keep BOTH the
    // person and the spec. These drive the SharePoint full-text index AND the
    // local jobs DB — we never throw one source's hits away.
    const keywords = Array.from(new Set(`${salesman} ${term}`.trim().split(/\s+/).filter(Boolean)));
    const searchTerm = keywords.join(' ') || term;

    try {
      // Two sources in parallel: SharePoint content index + local saved jobs DB.
      // Either can be empty (offline, stale cookies, term not in one) — we merge
      // whatever each returns and only report "nothing" when BOTH are empty.
      const [dq, localJobs] = await Promise.all([
        dqFullTextSearch(searchTerm, scope === 'mine', cookieStr, cfg)
          .catch(() => ({ results: [] as any[], total: 0, author: null as string | null })),
        Promise.resolve(searchLocalJobs(keywords)),
      ]);

      const scopeLabel = scope === 'mine' ? (dq.author ? `yours (${dq.author})` : 'yours') : 'all quotes';
      const dqCount    = dq.total;
      const localCount = localJobs.length;

      // Merge cards: SharePoint files (clickable) first, then local job rows.
      const cards = [...dq.results, ...localJobs.map(jobToCard)];

      const fileLines = dq.results.slice(0, 12).map((r: any, i: number) =>
        `${i + 1}. ${r.title}${r.ext ? ` [${r.ext}]` : ''}${r.summary ? ` — ${r.summary.slice(0, 160)}` : ''}`
      );
      const jobLines = localJobs.slice(0, 15).map((j: any) =>
        `- ${j.sfId || '?'} | ${j.customer || '-'} | salesman: ${j.salesman || '-'} | ${j.product || '-'} | ${j.price ? '£' + j.price : '-'} | ${j.status || '-'} | ${j.timestamp ? String(j.timestamp).slice(0, 10) : '-'}`
      );

      const ctx = [
        `User question: "${query}"`,
        `Search keywords: "${searchTerm}"  ·  Scope: ${scopeLabel}  ·  Intent: ${mode}${salesman ? `  ·  Salesman filter: ${salesman}` : ''}`,
        `Local saved-jobs DB matches: ${localCount}`,
        `SharePoint D&Q content-index matches (TotalRows): ${dqCount}`,
        localJobs.length ? `\nLocal saved jobs (these are quotes already processed through this app — the salesman field here is the reliable "who raised it"):\n${jobLines.join('\n')}` : '',
        dq.results.length ? `\nD&Q Store file matches (content-indexed — reliable for what's INSIDE the quote, e.g. KVA / catalogue):\n${fileLines.join('\n')}` : '',
      ].join('\n');

      const sys =
        'You answer quote-search questions for an Eaton quote engineer using ONLY the supplied results from two sources: the local saved-jobs DB and the SharePoint D&Q content index. '
        + 'Be direct and confident — do NOT say "please wait" or pretend to search; the results are already here. '
        + 'The D&Q content index is the main source: it matches everything inside the quote — customer, salesman names, KVA ratings, catalogue numbers, materials. When it returns matches, present them confidently as the answer (e.g. "Here are your N quotes mentioning Joe Bayley and 4kVA"). '
        + 'The local jobs DB is only a bonus cross-check; if it is empty, IGNORE it silently — do NOT tell the user it had no salesman data or apologise for it. Never undercut real D&Q matches by dwelling on the local DB. '
        + 'For "how many"/count questions give a clear number from the match counts above. Reference SR00 IDs and customer names. Never invent quotes or numbers not present. '
        + 'The result cards are shown to the user separately, so summarise — do not list every row. '
        + 'Only if BOTH sources returned 0 matches, say nothing was found and suggest dropping a keyword or widening scope to all quotes.';

      const resp = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: ctx }] }],
        config: { systemInstruction: sys, maxOutputTokens: 1024, temperature: 0.3 },
      });

      res.json({
        answer: resp.text ?? null,
        results: cards.slice(0, 12),
        meta: { count: dqCount > 0 ? dqCount : localCount, scope: scopeLabel, term: searchTerm },
      });
    } catch (e: any) {
      res.json({ answer: null, error: 'Search failed: ' + e.message, results: [] });
    }
  });

  // ── Connect to Joe ────────────────────────────────────────────────────────
  app.get('/api/run/connect', (req, res) => {
    const script = pyFile('refresh_cookies.py');
    if (!existsSync(script)) {
      res.json({ ok: false, error: 'refresh_cookies.py is missing from this install' }); return;
    }
    const [cmd, args] = pyArgs(script);
    const py = spawn(cmd, args, {
      cwd: PY_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const lines: string[] = [];
    py.stdout.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => { lines.push(l); }));
    py.stderr.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => { lines.push(`[WARN] ${l}`); }));
    py.on('error', err => { res.json({ ok: false, error: err.message, lines }); });
    py.on('close', code => {
      const ok = code === 0;
      if (ok) {
        sessionStartedAt = new Date().toISOString();
        // Bind the freshly-acquired cookies to THIS browser session.
        const fc = fileCookies(); const sid = currentSid();
        if (fc && sid) {
          SESSIONS.set(sid, { fed: fc.fed, rt: fc.rt, ts: Date.now() });
          persistSession(sid);
          const store = reqCtx.getStore(); if (store) { store.cookies = fc; store.owner = undefined; }
        }
      }
      res.json({ ok, code, lines });
    });
  });

  // ── Step 1 — now records product + duration ───────────────────────────────
  app.get('/api/run/step1', async (req, res) => {
    const pdfScript = pyFile('pdf_to_csv.py');
    const upScript  = pyFile('Automation_V4.py');
    const division  = String(req.query.division || '').toUpperCase();
    const lines     = String(req.query.lines    || '');   // JSON {filename: division} per-file
    const arrived   = String(req.query.arrived  || '');
    const today     = String(req.query.today    || '');
    const t0        = Date.now();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (line: string) => res.write(`data: ${JSON.stringify(line)}\n\n`);
    const fail = (msg: string) => { send(msg); res.write(`data: __DONE__:false\n\n`); res.end(); };

    if (!existsSync(pdfScript)) { fail(`[ERR] pdf_to_csv.py not found`); return; }
    if (!existsSync(upScript))  { fail(`[ERR] Automation_V4.py not found`); return; }

    const cfg1      = loadPyCfg();
    const pdfFolder = path.join(cfg1.base, 'PDF Quotes');
    const csvFolder = cfg1.base;

    // Capture filenames in queue at start, so we can record per-file jobs
    let queuedNames: string[] = [];
    try {
      queuedNames = readdirSync(pdfFolder)
        .filter(f => ['.pdf','.xlsx','.xls','.xlsm','.docx','.doc','.dotm','.dotx'].some(e => f.toLowerCase().endsWith(e)));
    } catch {}

    // Kill active child process if client disconnects mid-run
    let activeProc: ReturnType<typeof spawn> | null = null;
    req.on('close', () => { try { activeProc?.kill(); } catch {} });

    if (division) send(`[*] Division: ${division}`);
    if (arrived)  send(`[*] Arrival date: ${arrived}`);
    send(`[*] PDF folder: ${pdfFolder}`);
    send('[*] Phase 1 — Extracting PDFs to CSV...');
    const [c1, a1] = pyArgs(pdfScript);
    // Stamp the salesman with the connected JOE user, not a hardcoded owner.
    const salesman = await connectedUserName();
    const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
                    MAGIC_PDF_FOLDER: pdfFolder,
                    MAGIC_CSV_FOLDER: csvFolder,
                    // REQUESTED FROM is not in any quotation PDF — the extractor
                    // reads it off the originating mail thread in the index.
                    MAGIC_MAIL_INDEX: MAIL_INDEX,
                    ...(salesman ? { MAGIC_INSIDE_SALES: salesman } : {}),
                    ...(division ? { MAGIC_DIVISION: division } : {}),
                    ...(lines    ? { MAGIC_DIVISION_MAP: lines } : {}),
                    ...(arrived  ? { MAGIC_ARRIVED:  arrived  } : {}),
                    ...(today    ? { MAGIC_TODAY:    today    } : {}) };
    activeProc = spawn(c1, a1, { cwd: PY_DIR, env: pyEnv });
    const p1 = activeProc;
    p1.stdout.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(send));
    p1.stderr.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => send(`[WARN] ${l}`)));
    p1.on('error', err => fail(`[ERR] Could not start Python: ${err.message}`));

    p1.on('close', code1 => {
      if (code1 !== 0) {
        fail('[ERR] PDF extraction failed — stopping.');
        insertJob({
          step: 'Step 1', status: 'err', items: 0,
          note: 'PDF extraction failed',
          product: division || null,
          durationSec: Math.round((Date.now() - t0) / 1000),
        });
        return;
      }

      // Phase 1.5 — duplicate check before upload
      send('[*] Checking for duplicates...');
      const [cc, ac] = pyArgs(upScript);
      activeProc = spawn(cc, [...ac, '--check'], { cwd: PY_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      const pCheck = activeProc;
      let conflictsJson = '';
      pCheck.stdout.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => {
        if (l.startsWith('__CONFLICTS__:')) { conflictsJson = l.slice('__CONFLICTS__:'.length); }
        else { send(l); }
      }));
      pCheck.stderr.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => send(`[WARN] ${l}`)));
      pCheck.on('close', () => {
        if (conflictsJson) {
          res.write(`data: ${JSON.stringify('__CONFLICTS__:' + conflictsJson)}\n\n`);
          res.write(`data: __DONE__:conflicts\n\n`);
          res.end();
          return;
        }
        runStep1Upload(res, upScript, {}, t0, queuedNames, division, send, req);
      });
    });
  });

  function runStep1Upload(
    res: Response, upScript: string, decisions: Record<string, unknown>,
    t0: number, queuedNames: string[], division: string,
    send: (l: string) => void,
    req?: Request,
  ) {
    send('[*] Phase 2 — Uploading to Quotation List...');
    const [c2, a2] = pyArgs(upScript);
    const env2 = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      ...(Object.keys(decisions).length ? { CONFLICT_DECISIONS: JSON.stringify(decisions) } : {}),
    };
    const p2 = spawn(c2, a2, { cwd: PY_DIR, env: env2 });
    // Kill the child only on a genuine client disconnect. We listen on `res`
    // (not `req`): on a POST the request body is already fully consumed by
    // express.json() before we get here, so `req` 'close' fires immediately and
    // would kill Python the instant it spawns. `res` 'close' fires when the
    // SSE response actually ends — either we finished (guarded below) or the
    // client really went away.
    let finished = false;
    res.on('close', () => { if (!finished) { try { p2.kill(); } catch {} } });
    let items = 0;
    p2.stdout.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => { send(l); if (l.includes('[OK]')) items++; }));
    p2.stderr.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => send(`[WARN] ${l}`)));
    p2.on('error', err => { finished = true; send(`[ERR] Could not start Python: ${err.message}`); res.write(`data: __DONE__:false\n\n`); res.end(); });
    p2.on('close', code2 => {
      finished = true;
      const ok = code2 === 0;
      const dur = Math.round((Date.now() - t0) / 1000);
      res.write(`data: __DONE__:${ok}\n\n`); res.end();
      if (queuedNames.length > 0 && ok) {
        const itemsPer = items > 0 ? Math.max(1, Math.floor(items / queuedNames.length)) : 0;
        for (const name of queuedNames) {
          const meta = parseFilenameMeta(name);
          insertJob({
            step: 'Step 1', status: 'ok',
            pdfName: name,
            product: division || meta.product || null,
            customer: meta.customer,
            items: itemsPer,
            note: `${itemsPer} item(s) uploaded`,
            durationSec: dur,
          });
        }
      } else {
        insertJob({
          step: 'Step 1', status: ok ? 'ok' : 'err',
          items,
          product: division || null,
          note: ok ? `${items} item(s) uploaded` : 'Upload failed',
          durationSec: dur,
        });
      }
    });
  }

  // ── Step 1 upload (after conflict resolution) ─────────────────────────────
  app.post('/api/run/step1/upload', (req, res) => {
    const upScript    = pyFile('Automation_V4.py');
    const decisions   = req.body?.decisions || {};
    const division    = String(req.body?.division || '');
    const queuedNames = (req.body?.queuedNames || []) as string[];
    const t0          = Date.now();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (line: string) => res.write(`data: ${JSON.stringify(line)}\n\n`);
    runStep1Upload(res, upScript, decisions, t0, queuedNames, division, send, req);
  });

  // ── Auto product-line suggestion (reads queued files, no CSV write) ─────────
  app.get('/api/suggest-product', (req, res) => {
    const pdfScript = pyFile('pdf_to_csv.py');
    if (!existsSync(pdfScript)) { res.json({ suggestion: '', perFile: [] }); return; }
    const cfg       = loadPyCfg();
    const pdfFolder = path.join(cfg.base, 'PDF Quotes');
    const [cmd, baseArgs] = pyArgs(pdfScript);
    const proc = spawn(cmd, [...baseArgs, '--suggest'], {
      cwd: PY_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', MAGIC_PDF_FOLDER: pdfFolder },
    });
    let out = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.on('error', () => res.json({ suggestion: '', perFile: [] }));
    proc.on('close', () => {
      const line = out.split('\n').find(l => l.startsWith('__SUGGEST__:'));
      if (!line) { res.json({ suggestion: '', perFile: [] }); return; }
      try { res.json(JSON.parse(line.slice('__SUGGEST__:'.length))); }
      catch { res.json({ suggestion: '', perFile: [] }); }
    });
  });

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  app.get('/api/run/step2', (req, res) => {
    const script = pyFile('dq_store_upload.py');
    runPyScript(res, script, (ok, dur) => {
      insertJob({
        step: 'Step 2', status: ok ? 'ok' : 'err',
        note: ok ? 'D&Q Store built' : 'D&Q Store failed',
        durationSec: dur,
      });
      if (!ok) addToRetryQueue('step2', 'D&Q Store upload failed — will auto-retry when reconnected');
    }, req);
  });

  // ── PMO ────────────────────────────────────────────────────────────────────
  const pmoDownloads = new Map<string, { filePath: string; filename: string; tmpDir: string }>();

  app.get('/api/pmo/download/:id', (req, res) => {
    const id = req.params.id;
    const entry = pmoDownloads.get(id);
    if (!entry) { res.status(404).send('File not found or expired'); return; }
    const { filePath, filename } = entry;
    if (!existsSync(filePath)) { res.status(404).send(`File missing on disk: ${filePath}`); return; }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
    res.setHeader('Cache-Control', 'no-store');
    // Deliberately NOT deleted here: the user may download first and only then
    // decide to file it into the PMO folder (or the other way round). The
    // 10-minute sweep set up by /api/run/pmo cleans both up either way.
    const stream = createReadStream(filePath);
    stream.on('error', (err: any) => {
      if (!res.headersSent) res.status(500).send(`Read error: ${err.message}`);
      else res.destroy();
    });
    stream.pipe(res);
  });

  // Where a checked PMO belongs. NOT next to the log: the log lives in
  // Z:\_PMO-Pending Folder but the documents themselves are filed in the shared
  // Y:\CBU\1 - PMO folder, which is what the PMO team actually reads.
  const PMO_DOC_FOLDER = String.raw`Y:\CBU\1 - PMO`;
  function pmoFolder(): string {
    return loadPyCfg().pmo_out_dir || PMO_DOC_FOLDER;
  }

  // GET /api/pmo/folder — is the shared folder reachable right now?
  app.get('/api/pmo/folder', (_req, res) => {
    const folder = pmoFolder();
    res.json({ folder, available: existsSync(folder) });
  });

  // POST /api/pmo/save/:id { overwrite? } — copy the generated document into the
  // shared PMO folder. Only ever called from the button the user presses after
  // checking the document, and it refuses to clobber an existing file unless the
  // caller explicitly says so.
  app.post('/api/pmo/save/:id', (req, res) => {
    const entry = pmoDownloads.get(req.params.id);
    if (!entry) { res.status(404).json({ error: 'That document has expired — re-run the PMO.' }); return; }
    if (!existsSync(entry.filePath)) { res.status(404).json({ error: 'Generated file is no longer on disk.' }); return; }

    const folder = pmoFolder();
    if (!existsSync(folder)) {
      res.status(400).json({ error: `PMO folder not reachable: ${folder}. Check the Z: drive is connected.` });
      return;
    }
    const target = path.join(folder, entry.filename);
    if (existsSync(target) && !(req.body || {}).overwrite) {
      res.status(409).json({ error: 'A file with that name is already in the PMO folder.', exists: true, path: target });
      return;
    }
    try {
      copyFileSync(entry.filePath, target);
      res.json({ ok: true, path: target, folder });
    } catch (e: any) {
      res.status(500).json({ error: `Couldn't write to ${folder}: ${e.message}` });
    }
  });

  // ── Doc Packs ─────────────────────────────────────────────────────────────
  const DOCS: Record<string, { file: string; name: string }> = {
    'commissioning':        { file: 'commissioning.pdf',        name: 'Service_and_Commissioning_Information.pdf' },
    'terms_and_conditions': { file: 'terms_and_conditions.pdf', name: 'UK_Terms_and_Conditions.pdf' },
    'bidman_urls':          { file: 'bidman_urls.pdf',          name: 'BidMan_URLs_DualGuard_Configurator.pdf' },
  };
  const DOCS_XLSX: Record<string, { file: string; name: string }> = {
    'commission_calculators': { file: 'commission_calculators.xlsx', name: 'Commission_Calculators.xlsx' },
  };

  app.get('/api/docs/:id', (req, res, next) => {
    // Don't shadow the user-doc routes registered below (/api/docs/user...).
    if (req.params.id === 'user') return next();
    const doc = DOCS[req.params.id];
    if (!doc) { res.status(404).json({ error: 'that document is not in the library' }); return; }
    const filePath = path.join(PY_DIR, 'docs', doc.file);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'the file is no longer on disk' }); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('inline', doc.name));
    createReadStream(filePath).pipe(res);
  });

  app.get('/api/docs-xlsx/:id', (req, res) => {
    const doc = DOCS_XLSX[req.params.id];
    if (!doc) { res.status(404).json({ error: 'that document is not in the library' }); return; }
    const filePath = path.join(PY_DIR, 'docs', doc.file);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'the file is no longer on disk' }); return; }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition('attachment', doc.name));
    createReadStream(filePath).pipe(res);
  });

  // ── User-added Doc Packs (uploaded, persisted to docs/user) ────────────────
  const userDocsDir   = path.join(PY_DIR, 'docs', 'user');
  const userDocsIndex = path.join(userDocsDir, '_index.json');
  type UserDoc = { id: string; title: string; category: string; file: string; origName: string; ext: string; size: number; date: string };
  const loadUserDocs = (): UserDoc[] => {
    try { return existsSync(userDocsIndex) ? JSON.parse(readFileSync(userDocsIndex, 'utf8')) : []; }
    catch { return []; }
  };
  const saveUserDocs = (list: UserDoc[]) => {
    mkdirSync(userDocsDir, { recursive: true });
    writeFileSync(userDocsIndex, JSON.stringify(list, null, 2));
  };
  const DOC_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
  };

  app.get('/api/docs/user', (_req, res) => { res.json(loadUserDocs()); });

  app.post('/api/docs/user/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    try {
      const origName = decodeURIComponent((req.headers['x-filename'] as string) || 'document');
      const title    = decodeURIComponent((req.headers['x-title']    as string) || origName.replace(/\.[^.]+$/, ''));
      const category = decodeURIComponent((req.headers['x-category'] as string) || 'Custom');
      const ext = safeExt(origName);
      const id  = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const body = req.body as Buffer;
      if (!body || !body.length) { res.status(400).json({ ok: false, error: 'the uploaded file was empty' }); return; }
      mkdirSync(userDocsDir, { recursive: true });
      const file = `${id}.${ext}`;
      writeFileSync(path.join(userDocsDir, file), body);
      const doc: UserDoc = { id, title, category, file, origName: path.basename(origName), ext, size: body.length, date: new Date().toISOString() };
      const list = loadUserDocs(); list.unshift(doc); saveUserDocs(list);
      res.json({ ok: true, doc });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/docs/user/:id', (req, res) => {
    const doc = loadUserDocs().find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: 'that document is not in the library' }); return; }
    const filePath = path.join(userDocsDir, doc.file);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'the file is no longer on disk' }); return; }
    const viewable = doc.ext === 'pdf' || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(doc.ext);
    res.setHeader('Content-Type', DOC_MIME[doc.ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(viewable ? 'inline' : 'attachment', doc.origName));
    createReadStream(filePath).pipe(res);
  });

  app.delete('/api/docs/user/:id', (req, res) => {
    try {
      const list = loadUserDocs();
      const doc  = list.find(d => d.id === req.params.id);
      if (doc) { try { unlinkSync(path.join(userDocsDir, doc.file)); } catch {} }
      saveUserDocs(list.filter(d => d.id !== req.params.id));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── CBU Tech Brief export ──────────────────────────────────────────────────
  const cbuDownloads = new Map<string, { filePath: string; tmpDir: string; fileName: string }>();

  // What the exported brief is called. Both halves matter and both were missing:
  //
  //  * the QUOTE REFERENCE as typed, revision included. The header below used to
  //    be a hardcoded "CBU_Tech_Brief.pdf", and in the desktop app that header is
  //    what names the file — so "CR00xxHR3YAM A1R" arrived as a generic name with
  //    no reference on it at all.
  //  * the SYSTEM. One opportunity is often quoted at two sizes, and with the
  //    reference alone both exports are the same name: Downloads has
  //    "…IuXi5YAF-A2R (1).pdf" from the browser de-duplicating them, and
  //    "…00xUfRxYAK (10KVA-1PH).pdf" from the size being typed back in by hand.
  //
  // Windows rejects <>:"/\|?* and control characters in a name, and silently
  // drops a trailing dot or space, so anything pasted into the reference box is
  // reduced to a safe equivalent rather than breaking the save.
  const cbuFileName = (quote: string, systems: string[]) => {
    const clean = (s: string) => String(s || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[-\s.]+|[-\s.]+$/g, '');
    const ref = clean(quote);
    // '1PH- 4KVA' → '1PH-4KVA'. Several systems in one export are all named, so
    // the file still says what is inside it.
    // Repeats are counted rather than listed, so four identical systems read
    // "4x1PH-10KVA" instead of the same size four times over.
    const counts = new Map<string, number>();
    for (const s of systems.map(s => clean(s).replace(/^([13]PH)-\s*/i, '$1-')).filter(Boolean))
      counts.set(s, (counts.get(s) || 0) + 1);
    const sys = [...counts].map(([s, n]) => n > 1 ? `${n}x${s}` : s);
    return ['CBU_Tech_Brief', ref, sys.join('_')].filter(Boolean).join('_') + '.pdf';
  };

  app.get('/api/download/cbu/:id', (req, res) => {
    const entry = cbuDownloads.get(req.params.id);
    if (!entry || !existsSync(entry.filePath)) {
      res.status(404).json({ error: 'that download has expired — generate it again' }); return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    // Both spellings: the plain one for anything old, and RFC 5987's filename*
    // for the reference as actually typed — quote references carry spaces and
    // the odd non-ASCII dash, which a bare filename= cannot express.
    const name = entry.fileName || 'CBU_Tech_Brief.pdf';
    res.setHeader('Content-Disposition',
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; `
      + `filename*=UTF-8''${encodeURIComponent(name)}`);
    const stream = createReadStream(entry.filePath);
    stream.on('end', () => {
      cbuDownloads.delete(req.params.id);
      try { unlinkSync(entry.filePath); } catch {}
      try { rmdirSync(entry.tmpDir); } catch {}
    });
    stream.pipe(res);
  });

  app.post('/api/run/cbu', express.json(), (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { system, systems: systemsRaw, project, quote, engineer, email, phone } = req.body || {};
    // Accept either systems[] array or legacy system string
    const systems: string[] = Array.isArray(systemsRaw) ? systemsRaw : (system ? [system] : []);
    if (!systems.length || !project || !quote || !engineer || !email || !phone) {
      res.status(400).json({ error: 'pick a system and fill in the project, quote and engineer details' }); return;
    }
    const tmpDir = path.join(os.tmpdir(), `cbu_${Date.now()}`);
    const script = pyFile('cbu_export.py');
    const [py, base] = pyArgs(script);
    // --system may appear multiple times (one per system)
    const systemArgs = systems.flatMap((s: string) => ['--system', s]);
    const child = spawn(py, [
      ...base,
      ...systemArgs,
      '--project',  project,
      '--quote',    quote,  '--engineer', engineer,
      '--email',    email,  '--phone',    phone,
      '--outdir',   tmpDir,
    ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

    let stdout = '', stderr = '', settled = false;

    const finish = (send: () => void) => {
      if (settled) return; settled = true;
      clearTimeout(hardTimer);
      send();
    };

    // 120 s hard wall — kills LibreOffice if it hangs and returns a clean error
    const hardTimer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => {
        if (!res.headersSent)
          res.status(504).json({ error: 'Export timed out (>120 s). LibreOffice may have hung — please try again.' });
      });
    }, 120_000);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => finish(() => {
      if (!res.headersSent) res.status(500).json({ error: `Could not start Python: ${e.message}` });
    }));
    child.on('close', () => finish(() => {
      const lines   = stdout.split('\n');
      const pdfLine = lines.find((l: string) => l.startsWith('__PDF__:'));
      const errLine = lines.find((l: string) => l.startsWith('__ERROR__:'));
      if (pdfLine) {
        const filePath = pdfLine.slice('__PDF__:'.length).trim();
        const dlId = randomUUID();
        const fileName = cbuFileName(quote, systems);
        cbuDownloads.set(dlId, { filePath, tmpDir, fileName });
        setTimeout(() => cbuDownloads.delete(dlId), 10 * 60 * 1000);
        // Handed back so the browser's own save uses the same name the header
        // carries, instead of the two paths naming the file differently.
        if (!res.headersSent) res.json({ id: dlId, fileName });
      } else {
        const msg = errLine ? errLine.slice('__ERROR__:'.length) : (stderr.trim() || stdout.trim() || 'No output from script');
        if (!res.headersSent) res.status(500).json({ error: msg });
      }
    }));
  });

  // ── Commission calculator export ──────────────────────────────────────────
  const commDownloads = new Map<string, { filePath: string; tmpDir: string }>();

  app.get('/api/download/commission/:id', (req, res) => {
    const entry = commDownloads.get(req.params.id);
    if (!entry || !existsSync(entry.filePath)) {
      res.status(404).json({ error: 'that download has expired — generate it again' }); return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Commission_Calculation.pdf"');
    const stream = createReadStream(entry.filePath);
    stream.on('end', () => {
      commDownloads.delete(req.params.id);
      try { unlinkSync(entry.filePath); } catch {}
      try { rmdirSync(entry.tmpDir); } catch {}
    });
    stream.pipe(res);
  });

  app.post('/api/run/commission', express.json(), (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { type, panels, lumis, cards = 0, software, centralLondon, ref = '' } = req.body || {};
    if (!type || panels == null || !software || !centralLondon) {
      res.status(400).json({ error: 'the calculator sent an incomplete request — reload Vector and try again' }); return;
    }
    const tmpDir = path.join(os.tmpdir(), `comm_${Date.now()}`);
    const script = pyFile('commission_export.py');
    const [py, base] = pyArgs(script);
    const child = spawn(py, [
      ...base,
      '--type',           type,
      '--panels',         String(panels),
      '--lumis',          String(lumis ?? 0),
      '--cards',          String(cards),
      '--software',       software,
      '--central-london', centralLondon,
      '--ref',            String(ref).slice(0, 64),
      '--outdir',         tmpDir,
    ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

    let stdout = '', stderr = '', settled = false;
    const finish = (send: () => void) => { if (settled) return; settled = true; clearTimeout(hardTimer); send(); };
    const hardTimer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => { if (!res.headersSent) res.status(504).json({ error: 'Export timed out, please try again.' }); });
    }, 60_000);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => finish(() => {
      if (!res.headersSent) res.status(500).json({ error: `Could not start Python: ${e.message}` });
    }));
    child.on('close', () => finish(() => {
      const lines   = stdout.split('\n');
      const pdfLine = lines.find((l: string) => l.startsWith('__PDF__:'));
      const errLine = lines.find((l: string) => l.startsWith('__ERROR__:'));
      if (pdfLine) {
        const filePath = pdfLine.slice('__PDF__:'.length).trim();
        const dlId = randomUUID();
        commDownloads.set(dlId, { filePath, tmpDir });
        setTimeout(() => commDownloads.delete(dlId), 10 * 60 * 1000);
        if (!res.headersSent) res.json({ id: dlId });
      } else {
        const msg = errLine ? errLine.slice('__ERROR__:'.length) : (stderr.trim() || stdout.trim() || 'No output from script');
        if (!res.headersSent) res.status(500).json({ error: msg });
      }
    }));
  });

  // ── Quick Quote — Inbox proposal generator (CBU BOM + luminaires → PDF) ─────
  const quoteDownloads = new Map<string, { filePath: string; tmpDir: string; filename: string }>();

  app.get('/api/download/quote/:id', (req, res) => {
    const entry = quoteDownloads.get(req.params.id);
    if (!entry || !existsSync(entry.filePath)) { res.status(404).json({ error: 'that download has expired — generate it again' }); return; }
    res.setHeader('Content-Type', 'application/pdf');
    const safe = (entry.filename || 'Quote').replace(/[^\w\s.\-()&]/g, '_').trim() || 'Quote';
    res.setHeader('Content-Disposition', contentDisposition('attachment', `${safe}.pdf`));
    const stream = createReadStream(entry.filePath);
    stream.on('end', () => { quoteDownloads.delete(req.params.id); try { unlinkSync(entry.filePath); } catch {} });
    stream.pipe(res);
  });

  // AI: which CBU/LoadStar system (if any) does this email discuss?
  app.post('/api/quote/detect-cbu', express.json(), async (req, res) => {
    const { body, systems } = req.body as { body: string; systems: string[] };
    const ai = getGemini();
    if (!ai || !Array.isArray(systems) || systems.length === 0) { res.json({ system: '' }); return; }
    const prompt = [
      `An Eaton EL engineer is drafting a proposal. From the email below, decide whether a LoadStar-PS / CBU (central battery UPS) system is being requested, and which size.`,
      `Valid system keys (phase + kVA): ${systems.join(' | ')}`,
      `Reply with ONLY the single best-matching key EXACTLY as written above, or "NONE" if no CBU/LoadStar system is clearly referenced. No other text.`,
      ``,
      `Email:`,
      (body || '').slice(0, 6000),
    ].join('\n');
    try {
      const r = await generateWithRetry(ai, {
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 40, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      });
      const t = (r.text || '').trim().replace(/["'`]/g, '');
      const hit = systems.find(s => s === t) || systems.find(s => t.includes(s)) || '';
      res.json({ system: hit });
    } catch { res.json({ system: '' }); }
  });

  // Extract + price luminaires from the email text via schematic_reader (list mode).
  app.post('/api/quote/luminaires', express.json(), (req, res) => {
    const { body } = req.body as { body: string };
    const script = pyFile('schematic_reader.py');
    if (!existsSync(script)) { res.json({ items: [], error: 'schematic_reader.py is missing from this install' }); return; }
    const tmpDir = path.join(os.tmpdir(), `qlum_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const inp = path.join(tmpDir, 'body.txt');
    writeFileSync(inp, String(body || ''));
    const [py, base] = pyArgs(script);
    const proc = spawn(py, [...base, '--mode', 'list', '--input', inp], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '', err = '';
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 120_000);
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const cleanup = () => { try { unlinkSync(inp); } catch {} try { rmdirSync(tmpDir); } catch {} };
    proc.on('error', () => { clearTimeout(killer); cleanup(); if (!res.headersSent) res.json({ items: [], error: 'Python did not start — check the Python install' }); });
    proc.on('close', () => {
      clearTimeout(killer); cleanup();
      try {
        const j = JSON.parse(out.trim());
        const items = (j.items || [])
          .filter((it: any) => it.matched)
          .map((it: any) => ({ catNo: it.cat_no, description: it.description, qty: it.qty || 1, price: it.list_price || it.ntp || 0 }));
        if (!res.headersSent) res.json({ items, unmatched: (j.unmatched || []).length });
      } catch { if (!res.headersSent) res.json({ items: [], error: err.trim() || 'no output' }); }
    });
  });

  // Generate the proposal PDF from assembled line items.
  app.post('/api/quote/generate', express.json({ limit: '2mb' }), (req, res) => {
    const { header, lines, appendComm, appendTC } = req.body as { header: any; lines: any[]; appendComm?: boolean; appendTC?: boolean };
    if (!Array.isArray(lines) || lines.length === 0) { res.status(400).json({ error: 'No line items to quote' }); return; }
    const script = pyFile('quote_export.py');
    if (!existsSync(script)) { res.status(500).json({ error: 'quote_export.py is missing from this install' }); return; }
    const tmpDir = path.join(os.tmpdir(), `quote_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const inp = path.join(tmpDir, 'in.json');
    // Base template already includes T&C pages, so extras default OFF (opt-in only).
    writeFileSync(inp, JSON.stringify({ header: header || {}, lines, appendComm: appendComm === true, appendTC: appendTC === true }));
    const [py, base] = pyArgs(script);
    const child = spawn(py, [...base, '--input', inp, '--outdir', tmpDir], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let stdout = '', stderr = '', settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(hardTimer); fn(); };
    const hardTimer = setTimeout(() => { try { child.kill(); } catch {} finish(() => { if (!res.headersSent) res.status(504).json({ error: 'Quote export timed out' }); }); }, 120_000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => finish(() => { if (!res.headersSent) res.status(500).json({ error: `Could not start Python: ${e.message}` }); }));
    child.on('close', () => finish(() => {
      const pdfLine = stdout.split('\n').find(l => l.startsWith('__PDF__:'));
      const errLine = stdout.split('\n').find(l => l.startsWith('__ERROR__:'));
      if (pdfLine) {
        const filePath = pdfLine.slice('__PDF__:'.length).trim();
        const dlId = randomUUID();
        // Filename = "<quote name> - <quote number>" (whatever is present).
        const filename = [header?.quoteName, header?.quoteNumber].map(s => String(s || '').trim()).filter(Boolean).join(' - ') || 'Quote';
        quoteDownloads.set(dlId, { filePath, tmpDir, filename });
        setTimeout(() => quoteDownloads.delete(dlId), 10 * 60 * 1000);
        if (!res.headersSent) res.json({ id: dlId });
      } else {
        const msg = errLine ? errLine.slice('__ERROR__:'.length) : (stderr.trim() || 'No output from quote export');
        if (!res.headersSent) res.status(500).json({ error: msg });
      }
    }));
  });

  app.post('/api/run/pmo', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (txt: string) => { res.write(`data: ${txt}\n\n`); };

    send('[*] Parsing uploaded files…');

    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      send('[ERR] Request body empty — upload failed to reach server');
      send('__DONE_ERR__'); res.end(); return;
    }

    const boundary = (() => {
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=([^\s;]+)/);
      return m ? m[1] : null;
    })();

    if (!boundary) { send('[ERR] No multipart boundary'); send('__DONE_ERR__'); res.end(); return; }

    const tmpDir = path.join(os.tmpdir(), `pmo_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const body = req.body as Buffer;
    const parts: Record<string, { filename?: string; value: Buffer }> = {};

    const bndBuf = Buffer.from('--' + boundary);
    let pos = 0;
    while (pos < body.length) {
      const start = body.indexOf(bndBuf, pos);
      if (start === -1) break;
      pos = start + bndBuf.length;
      if (body[pos] === 45 && body[pos + 1] === 45) break;
      if (body[pos] === 13) pos += 2;
      const hdrEnd = body.indexOf('\r\n\r\n', pos);
      if (hdrEnd === -1) break;
      const hdrs = body.slice(pos, hdrEnd).toString();
      pos = hdrEnd + 4;
      const nextBnd = body.indexOf('\r\n' + '--' + boundary, pos);
      const partBody = nextBnd === -1 ? body.slice(pos) : body.slice(pos, nextBnd);
      const nameM = hdrs.match(/name="([^"]+)"/);
      const fileM = hdrs.match(/filename="([^"]+)"/);
      if (nameM) parts[nameM[1]] = { filename: fileM?.[1], value: partBody };
      pos = nextBnd === -1 ? body.length : nextBnd + 2;
    }

    const getField = (name: string) => parts[name]?.value.toString().trim() || '';
    const saveFile = (name: string): string => {
      const p = parts[name];
      if (!p || !p.filename) return '';
      const dest = path.join(tmpDir, p.filename);
      writeFileSync(dest, p.value);
      return dest;
    };

    const quotePdfPath = saveFile('quote_pdf');
    const poPdfPath    = saveFile('po_pdf');
    const docuPdfPaths: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = saveFile(`docu_pdf_${i}`);
      if (p) docuPdfPaths.push(p);
    }
    const legacyPrice = saveFile('price_pdf');
    if (legacyPrice) docuPdfPaths.push(legacyPrice);
    const seqOverride = getField('seq_override');

    if (!quotePdfPath) { send('[ERR] Quote PDF missing'); send('__DONE_ERR__'); res.end(); return; }
    if (!poPdfPath)    { send('[ERR] PO PDF missing');    send('__DONE_ERR__'); res.end(); return; }
    if (docuPdfPaths.length === 0) { send('[ERR] At least one DOCU_ID PDF required'); send('__DONE_ERR__'); res.end(); return; }

    send(`[*] Files received — starting extraction…`);

    const [pmoCmd, pmoArgs] = pyArgs(pyFile('pmo_raise.py'));

    const pyEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      MAGIC_PMO_QUOTE_PDF:     quotePdfPath,
      MAGIC_PMO_PO_PDF:        poPdfPath,
      ...(seqOverride ? { MAGIC_PMO_SEQ: seqOverride } : {}),
      MAGIC_PMO_DOCU_PDFS:     docuPdfPaths.join('|'),
      MAGIC_PMO_OUTDIR:        tmpDir,
      // Only set when configured — an empty string would override the script's
      // own defaults (e.g. the Z:\ PMO log path) and force the CBU placeholder.
      ...(loadPyCfg().pmo_log           ? { MAGIC_PMO_LOG:           loadPyCfg().pmo_log }           : {}),
      ...(loadPyCfg().pmo_sales_contact ? { MAGIC_PMO_SALES_CONTACT: loadPyCfg().pmo_sales_contact } : {}),
    };

    let docxPath = '';
    const py = spawn(pmoCmd, pmoArgs, { cwd: PY_DIR, env: pyEnv });

    py.stdout.on('data', d => {
      d.toString().split('\n').filter(Boolean).forEach((l: string) => {
        if (l.startsWith('__DOCX__:')) {
          docxPath = l.slice('__DOCX__:'.length).trim();
        } else {
          send(l);
        }
      });
    });
    py.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach((l: string) => send(`[ERR] ${l}`)));

    py.on('close', code => {
      if (code === 0 && docxPath && existsSync(docxPath)) {
        const dlId = randomUUID();
        const filename = path.basename(docxPath);
        pmoDownloads.set(dlId, { filePath: docxPath, filename, tmpDir });
        setTimeout(() => {
          try { readdirSync(tmpDir).forEach(f => { try { unlinkSync(path.join(tmpDir, f)); } catch {} }); rmdirSync(tmpDir); } catch {}
          pmoDownloads.delete(dlId);
        }, 600_000);
        send(`__DOCX_ID__:${dlId}:${filename}`);
        send('__DONE_OK__');
      } else {
        try { readdirSync(tmpDir).forEach(f => { try { unlinkSync(path.join(tmpDir, f)); } catch {} }); rmdirSync(tmpDir); } catch {}
        send('__DONE_ERR__');
      }
      res.end();
    });
  });

  // ── Schematic / Material List Pricer ────────────────────────────────────────
  // Unified: accepts ANY mix of (1) free text and (2) N attachments (PDF / image)
  // in a single multipart request. Falls back to plain-text and legacy single-file
  // multipart for backward compatibility with older callers.
  app.post('/api/schematics/price', express.raw({ type: () => true, limit: '50mb' }), async (req: any, res) => {
    const ct       = req.headers['content-type'] || '';
    const pyScript = pyFile('schematic_reader.py');
    if (!existsSync(pyScript)) { res.json({ error: 'schematic_reader.py is missing from this install' }); return; }

    const tmpPaths: string[] = [];   // for cleanup
    let   args: string[] = [];

    function cleanup() {
      for (const p of tmpPaths) {
        if (p && existsSync(p)) { try { unlinkSync(p); } catch {} }
      }
    }

    if (ct.includes('multipart/form-data')) {
      const boundary = ct.split('boundary=')[1]?.trim();
      if (!boundary) { res.json({ error: 'the upload was malformed' }); return; }
      const buf: Buffer = req.body;
      const marker = Buffer.from('--' + boundary);

      type ParsedPart = { name: string; filename?: string; contentType?: string; body: Buffer };
      const parts: ParsedPart[] = [];

      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(marker, pos);
        if (start === -1) break;
        pos = start + marker.length;
        if (buf[pos] === 45 && buf[pos + 1] === 45) break;          // '--' → end
        if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;       // CRLF
        const hdrEnd = buf.indexOf('\r\n\r\n', pos);
        if (hdrEnd === -1) break;
        const headers = buf.slice(pos, hdrEnd).toString('utf8');
        pos = hdrEnd + 4;
        const next = buf.indexOf(Buffer.from('\r\n--' + boundary), pos);
        const body = next === -1 ? buf.slice(pos) : buf.slice(pos, next);

        const nameMatch = headers.match(/name="([^"]+)"/i);
        const fileMatch = headers.match(/filename="([^"]*)"/i);
        const ctMatch   = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        parts.push({
          name:        nameMatch ? nameMatch[1] : '',
          filename:    fileMatch ? fileMatch[1] : undefined,
          contentType: ctMatch   ? ctMatch[1].trim() : undefined,
          body,
        });

        pos = next === -1 ? buf.length : next + 2;
      }

      // Split into text field + file attachments
      let textVal    = '';
      let streamReq  = false;
      const files: { path: string; kind: 'pdf' | 'image' | 'excel'; name: string }[] = [];

      for (const p of parts) {
        const isFile = !!p.filename || /^(application\/pdf|image\/)/i.test(p.contentType || '');
        if (!isFile) {
          if (p.name === 'stream') { streamReq = p.body.toString('utf-8').trim() === '1'; continue; }
          // Treat any non-file part as text (commonly name="text" or name="description")
          if (p.name === 'text' || p.name === 'description' || textVal === '') {
            textVal = (textVal ? textVal + '\n' : '') + p.body.toString('utf-8');
          }
          continue;
        }
        if (p.body.length === 0) continue;

        const ctLower = (p.contentType || '').toLowerCase();
        let kind: 'pdf' | 'image' | 'excel' = 'pdf';
        let ext = 'bin';
        if (/^application\/pdf/.test(ctLower) || /\.pdf$/i.test(p.filename || '')) {
          kind = 'pdf'; ext = 'pdf';
        } else if (/spreadsheet|excel|ms-excel|csv/.test(ctLower) || /\.(xlsx?|xlsm|csv)$/i.test(p.filename || '')) {
          kind = 'excel';
          ext = ((p.filename || '').match(/\.(xlsx?|xlsm|csv)$/i)?.[1] || 'xlsx').toLowerCase();
        } else if (/^image\//.test(ctLower) || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(p.filename || '')) {
          kind = 'image';
          const mt = ctLower.split('/')[1] || (p.filename || '').split('.').pop() || 'png';
          ext = mt.replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        } else {
          continue; // unsupported attachment type
        }
        const tmp = path.join(os.tmpdir(), `mu_el_${Date.now()}_${files.length}.${ext}`);
        writeFileSync(tmp, p.body);
        tmpPaths.push(tmp);
        files.push({ path: tmp, kind, name: p.filename || `attachment.${ext}` });
      }

      if (!textVal.trim() && files.length === 0) {
        cleanup();
        res.json({ error: 'Enter a description, cat numbers, or attach a PDF/image' });
        return;
      }

      // ── Streaming path: NDJSON per-item progress ───────────────────────────
      // Forwards a live read-out so the UI shows items as they're priced instead
      // of a frozen spinner. Text-only → list mode; attachments → unified mode
      // (extract, then stream pricing of every extracted row).
      if (streamReq && (textVal.trim() || files.length > 0)) {
        const streamTmps: string[] = [];
        let streamArgs: string[];
        if (files.length > 0) {
          const manifestPath = path.join(os.tmpdir(), `mu_el_smanifest_${Date.now()}.json`);
          writeFileSync(manifestPath, JSON.stringify({ text: textVal, files }), 'utf-8');
          streamTmps.push(manifestPath, ...tmpPaths);   // clean up uploaded files too
          streamArgs = ['--mode', 'unified', '--stream', '--input', manifestPath];
        } else {
          const tmp = path.join(os.tmpdir(), `mu_el_stream_${Date.now()}.txt`);
          writeFileSync(tmp, textVal, 'utf-8');
          streamTmps.push(tmp);
          streamArgs = ['--mode', 'list', '--stream', '--input', tmp];
        }
        const [py, base] = pyArgs(pyScript);
        const proc = spawn(py, [...base, ...streamArgs], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
        const cleanStream = () => { for (const p of streamTmps) { try { if (existsSync(p)) unlinkSync(p); } catch {} } };
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

        // Kill the child only if the client actually disconnects mid-stream —
        // NOT when express.raw finishes reading the POST body (req 'close' fires
        // early for consumed request bodies and would abort pricing instantly).
        res.on('close', () => { if (!res.writableEnded) { try { proc.kill(); } catch {} } });

        let buf = '';
        proc.stdout.on('data', (d: Buffer) => {
          buf += d.toString('utf-8');
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) res.write(line + '\n');   // forward each complete NDJSON event
          }
        });
        proc.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        proc.on('error', (e: any) => {
          try { res.write(JSON.stringify({ t: 'error', error: e.message }) + '\n'); } catch {}
          cleanStream();
          res.end();
        });
        proc.on('close', () => {
          if (buf.trim()) res.write(buf.trim() + '\n');
          cleanStream();
          res.end();
        });
        return;
      }

      // Always route multipart through unified mode so every request gets the
      // grounded candidate reranker (no hallucinated cat-numbers).
      const manifestPath = path.join(os.tmpdir(), `mu_el_manifest_${Date.now()}.json`);
      writeFileSync(manifestPath, JSON.stringify({ text: textVal, files }), 'utf-8');
      tmpPaths.push(manifestPath);
      args = ['--mode', 'unified', '--input', manifestPath];
    } else {
      // Plain text body — backward-compat for old callers.
      const text = req.body?.toString('utf-8') || '';
      if (!text.trim()) { res.json({ error: 'Provide a material list or upload a PDF' }); return; }
      const tmp = path.join(os.tmpdir(), `matlist_${Date.now()}.txt`);
      writeFileSync(tmp, text, 'utf-8');
      tmpPaths.push(tmp);
      args = ['--mode', 'list', '--input', tmp];
    }

    const [py, base] = pyArgs(pyScript);
    const proc = spawn(py, [...base, ...args], { env: { ...process.env } });
    let out = '', err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('close', () => {
      cleanup();
      try {
        res.json(JSON.parse(out.trim()));
      } catch {
        res.json({ error: 'the pricer returned nothing usable — ' + (err || out).trim().slice(0, 300) });
      }
    });
  });

  app.get('/api/archive', (_req, res) => {
    const archDir = path.join(loadPyCfg().base, 'Archive');
    const result: any[] = [];
    try {
      if (existsSync(archDir))
        readdirSync(archDir).sort().reverse().slice(0, 5).forEach(d => {
          const dp = path.join(archDir, d);
          if (statSync(dp).isDirectory()) {
            const files = readdirSync(dp);
            result.push({ date: d, files: files.slice(0, 5), total: files.length });
          }
        });
    } catch {}
    res.json(result);
  });

  // ── Retry queue endpoints ──────────────────────────────────────────────────
  app.get('/api/retry', (_req, res) => {
    res.json(loadRetryQueue());
  });
  app.delete('/api/retry/:id', (req, res) => {
    const q = loadRetryQueue().filter(x => x.id !== req.params.id);
    saveRetryQueue(q);
    res.json({ ok: true });
  });
  app.post('/api/retry/now', async (req, res) => {
    const q = loadRetryQueue().filter(x => x.attempts < x.maxAttempts);
    if (!q.length) { res.json({ ok: true, ran: 0 }); return; }
    if (!getSpCookies()) { res.json({ ok: false, error: 'not connected to JOE — click Connect to JOE first' }); return; }
    let ran = 0;
    for (const item of q) {
      const script = item.script === 'step2' ? pyFile('dq_store_upload.py') : '';
      if (!script) continue;
      appendLog(`[retry/manual] Running ${item.script}...`);
      const { ok, output } = await runSilent(script);
      const all = loadRetryQueue();
      const idx = all.findIndex(x => x.id === item.id);
      if (idx > -1) {
        if (ok) { all.splice(idx, 1); insertJob({ step: 'Step 2', status: 'ok', note: 'D&Q Store built (manual retry)', durationSec: null }); }
        else { all[idx].attempts++; all[idx].lastError = output.slice(-200); }
        saveRetryQueue(all);
      }
      ran++;
    }
    res.json({ ok: true, ran });
  });

  // ── Log viewer ─────────────────────────────────────────────────────────────
  app.get('/api/logs', (req, res) => {
    const tail = parseInt(String(req.query.tail || '150'), 10) || 150;
    try {
      if (!existsSync(LOG_PATH)) { res.json({ lines: [] }); return; }
      const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
      res.json({ lines: lines.slice(-tail) });
    } catch (e: any) {
      res.json({ lines: [], error: e.message });
    }
  });

  // ── Static frontend ───────────────────────────────────────────────────────
  // Sidecar serves the built frontend so the Tauri window loads same-origin
  // (no CORS, session cookie persists). FRONTEND_DIR is set by the Rust host.
  if (isSidecar) {
    const frontendDir = process.env.FRONTEND_DIR || path.join(__dirname, 'dist');
    app.use(express.static(frontendDir));
    app.get('*', (_req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
  } else if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }

  app.listen(PORT, '127.0.0.1', () => {
    if (isSidecar) {
      // Tauri reads this line from stdout to get the API port
      process.stdout.write(`VECTOR_PORT:${PORT}\n`);
    } else {
      console.log(`\n  Vector v2  →  http://localhost:${PORT}\n`);
    }
    // Warm the price-list identity so the AI prompt names the issue actually on
    // disk from the first question, and say so when it differs from the one
    // this desk acknowledged.
    void pricelistVersion(true).then(v => {
      if (v.error || !v.label) return;
      const seen = seenPricelistFingerprint();
      console.log(`[pricelist] ${v.label}${v.validFrom ? ` (valid from ${v.validFrom})` : ''}`
        + ` — ${v.rows} rows, rate ${v.exchangeRate ?? '?'}`);
      if (seen && seen !== v.fingerprint) {
        console.warn('[pricelist] CHANGED since last acknowledged — quotes priced before now used the previous issue.');
      }
    }).catch(() => { /* never block startup on this */ });
  });
}

startServer().catch(err => { console.error(err); process.exit(1); });
