import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync, statSync, unlinkSync, mkdirSync, rmdirSync, createReadStream
} from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { request as httpsRequest } from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import initSqlJs from 'sql.js';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// Corporate SSL inspection proxies present self-signed certs — same reason all
// SharePoint calls use rejectUnauthorized:false. Applies to native fetch too.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DB_PATH    = path.join(__dirname, 'eaton_automation.db');
// All Python scripts + their assets (config.json, el_pricelist.xlsx, docs/, …)
// live together under automation/ so each script's __file__-relative lookups work.
const PY_DIR     = path.join(__dirname, 'automation');
const pyFile     = (name: string) => path.join(PY_DIR, name);

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

// ── Config ─────────────────────────────────────────────────────────────────
function loadPyCfg(): Record<string, string> {
  const defaults: Record<string, string> = {
    base:     path.join(__dirname, 'data'),
    initials: 'LS',
    sp_site:  'https://eaton.sharepoint.com/sites/ELTechsupport',
    sp_list:  'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA',
    dq_store: 'Shared Documents/D&Q Store',
  };
  try {
    const cfgPath = pyFile('config.json');
    if (existsSync(cfgPath))
      return { ...defaults, ...JSON.parse(readFileSync(cfgPath, 'utf8')) };
  } catch {}
  return defaults;
}

// ── sql.js ─────────────────────────────────────────────────────────────────
const SQL = await initSqlJs();
let db: InstanceType<typeof SQL.Database>;

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
  migrateDb();
  migrateCrm();
  saveDb();
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

function saveDb() { writeFileSync(DB_PATH, Buffer.from(db.export())); }
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

loadDb();

// ── Log file ───────────────────────────────────────────────────────────────
const LOG_PATH     = path.join(__dirname, 'vector.log');
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
const RETRY_PATH = path.join(__dirname, 'retry_queue.json');

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
    const py = spawn(cmd, args, { cwd: __dirname, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
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
function pyArgs(scriptPath: string): [string, string[]] {
  return [process.env.PYTHON || 'python', [scriptPath]];
}

// ── SSE: run a Python script and stream its output ─────────────────────────
function runPyScript(res: Response, scriptPath: string, onDone: (ok: boolean, durationSec: number) => void) {
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
    cwd: __dirname,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

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
    req.on('error', () => resolve({ ok: false, status: 0 }));
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
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
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
  const kp = path.join(__dirname, '.session_key');
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
  if (!blob.startsWith('v1:')) return blob; // tolerate legacy plaintext rows
  try {
    const raw = Buffer.from(blob.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', SESSION_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; } // wrong key / tampered → unusable
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
    const cfgPath = pyFile('config.json');
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
  const key = String((loadPyCfg() as any).gemini_key || process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  if (!_gemini || _geminiKey !== key) {
    _gemini = new GoogleGenAI({ apiKey: key });
    _geminiKey = key;
  }
  return _gemini;
}

function buildSystemPrompt(appContext: string): string {
  const lines = [
    'You are the AI assistant embedded in Vector — a quote automation tool for Eaton Corporation Budapest.',
    'You are helpful, concise, and specific. You know the app inside-out.',
    '',
    '## About Vector',
    'Vector was designed and built by Laith Al-Soub (Technical Sales & Systems Engineer, Eaton Budapest) — he is the creator and owner of this app. If asked who made/created/owns the app, the answer is Laith Al-Soub. (The app was formerly called "MagicUploader"; the current name is Vector.)',
    '',
    '## What Vector does (every part of the app)',
    '- **Dashboard**: Drop queue + Recent Jobs (last 20 processed quotes, status, customer, price). Run Step 1 / Run Step 2 from here.',
    '- **Step 1**: Drops quotes (UK/BE/FR/IT/DE/ES, PDF/Word/Excel) into the queue → extracts pricing → uploads to SharePoint QuotationFactory list',
    '- **Step 2**: Creates D&Q Store folder on SharePoint and uploads the quote PDF',
    '- **PMO Raise** (PMO tab): Upload a quote PDF + customer PO + BidManager DOCU_ID PDFs → generates a PMO Word doc → ready to email the PMO team',
    '- **EL Pricer** (Schematics tab): Prices Eaton emergency lighting items from uploaded schematics, images, or pasted material lists, against the Eaton EL Global Price List (July 2026, valid from 1 July 2026), which is the source data this feature uses.',
    '- **CBU Sizer** (CBU tab): LoadStar-PS (battery/UPS) sizing calculator. It DOES contain prices: a built-in list-price table covering each kVA system (control cabinet, internal/external batteries, parallel + expansion kits) with per-line list prices and a system total. These figures come from the UK CSO LoadStar-PS Quote Configurator and are hard-coded into the app (no live/auto price feed). The tab shows the full breakdown and a printable tech brief.',
    '- **Inbox** (Inbox tab): Reads Outlook email, AI triage + reply drafting, morning briefing, and an inline EL Pricer that appears when an email contains EL material items.',
    '- **CRM** (CRM tab): Account cards auto-seeded from the customer field of past quotes (today these are quote names; later, real customer names). Each card holds contacts (name, role, email, phone), facts (some AI-generated, plus warnings), D&Q documents, and the account\'s quotes + opportunities pulled live from job history. An "opportunity" is an open priced quote (not marked won/lost). Duplicate cards can be MERGED into one account. You CAN edit cards from this chat: just tell me e.g. "add contact John Smith (buyer, john@acme.com) to <account>", "note that <account> pays at 60 days", "mark SR0012345 as won", "create account Acme", or "tag <account> key-account" — I execute it and confirm.',
    '- **AI Assistant** (this chat): answers app questions and searches the user\'s quotes (see Quote search below).',
    '- **Connect to JOE** (header): SharePoint authentication. **Settings**: Gemini API key + base folder config.',
    '',
    '## Sales reps (NOT the app team — these are salesmen whose names appear in the quote data)',
    'Blair McDonald, Craig Donaldson, Joe Bayley, Mark Fenton, Ollie Bailey, Ryan Houston. These are Eaton sales engineers/quote owners you may see referenced in quotes — they did NOT build the app and are not who to contact about it.',
    '',
    '## Email triage — IMPORTANT',
    'When the user pastes an email (you will see it as a large block of text), you MUST:',
    '1. Confirm you can see it is an email',
    '2. Extract key fields: sender, customer name, Salesforce ID (SR00xxxxx format), quote ref, amount, any deadlines',
    '3. Identify the request type:',
    '   - New quote PDF attached → "Go to Dashboard, drop the PDF into the queue, select the Division, click Run Step 1 then Run Step 2"',
    '   - Customer PO received against a quote → "Go to PMO tab, upload the quote PDF, the PO PDF, and all BidManager DOCU_ID PDFs, then click Raise PMO"',
    '   - Query about quote status → "Go to AI Assistant, type the Salesforce ID or customer name to look it up"',
    '',
    '## Quote search — capabilities, and what NOT to say',
    'The app CAN search the user\'s quotes by customer, salesman, KVA rating, catalogue/fitting number, or ANY text inside the quote PDF/email (the D&Q Store is full-text indexed). So never tell the user searching is limited to Salesforce ID or customer name, and never claim you cannot search by a specification like "4kVA".',
    'CRITICAL: In THIS chat reply you cannot run a search yourself and you have NO results in front of you. So you must NEVER say "searching…", "please wait", "retrieving", "one moment", or pretend results are loading — that is a lie and nothing will appear. Instead, if the user wants to find quotes, tell them to type the actual thing they are looking for (e.g. just "4kVA", a customer, a salesman name, or "how many quotes have 4kVA") and the app will run the real search automatically and show result cards. Keep it to one short sentence.',
    '   - Pricing / EL schematic request → "Go to EL Pricer tab, upload the schematic PDF"',
    '4. Give numbered, actionable steps referencing exact tab names and button labels',
    '5. Flag anything missing (e.g. "You will need the DOCU_ID PDFs from BidManager before you can raise the PMO")',
    '',
    '## Common issues & fixes',
    '- **FedAuth / 401 / cookie expired**: Click "Connect to JOE" in the top header bar',
    '- **PDF format not recognised**: Only UK, BE, FR, IT, DE, ES language quotes are supported',
    '- **SharePoint 403**: Cookies expired — click Connect to JOE',
    '- **Step 1 no items uploaded**: Check the CSV was generated in the base folder; re-run if empty',
    '',
    '## Response style',
    '- Be concise. Use numbered lists for steps, bullet points for options.',
    '- Always name the exact UI tab or button: "PMO tab", "Run Step 1", "Connect to JOE".',
    '- If something is unclear, ask one focused clarifying question.',
    '',
    '## Accuracy — never deny a feature that exists',
    'You know the whole app (listed above). Never tell the user a feature does not exist or "has no prices" when it does — e.g. the CBU Sizer DOES contain a built-in list-price table. If asked when CBU prices were "last updated" or their cutoff date: the app does not store a price-validity date, so do not invent one. Say the CBU prices are the hard-coded LoadStar-PS configurator list prices (no auto-update), and to confirm they are current they should check against the latest LoadStar-PS Quote Configurator / their pricing team. Same honesty for the EL Pricer: its source is the July 2026 EL Global Price List (valid from 1 July 2026).',
    '',
    '## Data sensitivity & not oversharing',
    'Eaton data is confidential. If the user wants to export or share data externally, remind them first. Answer at the level asked: explain what a feature does and where to find it, but do not dump entire raw price tables, every catalogue/part number, or internal source filenames unprompted. Give the specific figure or item the user asked for, not the whole dataset.',
  ];
  if (appContext) lines.push('', '## Live app state (use this to give specific answers)', appContext);
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

// ─── Shared chat brain (used by /api/ai and /api/quote-ask chat fallback) ──────
// Builds live app context from the local jobs DB + queue, then asks Gemini.
async function chatAnswer(
  query: string,
  history?: Array<{ role: string; text: string }>,
): Promise<{ answer: string | null; error?: string; source?: string }> {
  const ai = getGemini();
  if (!ai) return { answer: null, error: 'No Gemini API key — add gemini_key in Settings' };

  const cacheKey = hashStr(query + JSON.stringify((history || []).slice(-3)));
  const cached   = _aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_TTL && !history?.length) {
    return { answer: cached.answer, source: 'cache' };
  }

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
    appContext = contextLines.join('\n');
  } catch {}

  const turns: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (history?.length) {
    for (const h of history.slice(-10)) {
      turns.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] });
    }
  }
  turns.push({ role: 'user', parts: [{ text: query }] });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: turns,
      config: { systemInstruction: buildSystemPrompt(appContext), maxOutputTokens: 2048, temperature: 0.7 },
    });
    const answer = response.text ?? null;
    if (answer && !history?.length) _aiCache.set(cacheKey, { answer, ts: Date.now() });
    return { answer, source: 'gemini' };
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

  const kql   = `${q} path:"${dqUrl}" IsDocument:1${authorFilter}`;
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


async function startServer() {
  const app  = express();
  const PORT = 3000;
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
    if (!sid) { res.status(400).json({ error: 'no session' }); return; }
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

  // Known Eaton salesmen (same roster as CBUCalculator) — used to attach email +
  // phone to the salesman contact derived from each account's quotes.
  const SALESMEN_ROSTER = [
    { name: 'Blair McDonald',  email: 'blairgmcdonald@eaton.com', phone: '07890954552' },
    { name: 'Craig Donaldson', email: 'craigdonaldson@eaton.com', phone: '07811692079' },
    { name: 'Joe Bayley',      email: 'joebayley@eaton.com',      phone: '07713325534' },
    { name: 'Mark Fenton',     email: 'MarkAFenton@Eaton.com',    phone: '07713325528' },
    { name: 'Ollie Bailey',    email: 'olliejbailey@eaton.com',   phone: '07866893068' },
    { name: 'Ryan Houston',    email: 'ryanhouston@eaton.com',    phone: '07773949386' },
  ];
  // Order-independent name match (handles "Bayley, Joe" vs "Joe Bayley" and middle
  // initials), so the roster's email/phone attaches to the resolved salesman.
  function matchSalesman(name: string): { name: string; email: string; phone: string } | null {
    const toks = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const nt = new Set(toks(name));
    if (!nt.size) return null;
    return SALESMEN_ROSTER.find(r => { const rt = toks(r.name); return rt.length > 0 && rt.every(t => nt.has(t)); }) || null;
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
    s = s.split(/\s+-\s+/)[0].trim();                   // "X - Option 2" → "X"
    s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();      // trailing (code)
    s = s.replace(/[\s\-#]+\d{4,}(?:-\d+)?\s*$/, '').trim(); // trailing date
    s = s.replace(/\s+(only|stock|ele|EL|additions|renewal)\s*$/i, '').trim(); // order qualifiers
    s = s.replace(/^[\s\-#/,]+/, '').trim();            // leading punctuation
    // Junk = empty, too short, or a bare quote number/code (e.g. "27352", "QW27411").
    const junk = !s || s.length < 3 || /^[A-Za-z]{0,4}\d{2,}[A-Za-z0-9]*$/.test(s);
    if (junk) return stripAccountCode(customer) || s || '';
    return s;
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
        if (n === q) score = Math.max(score, 3);
        else if (n.startsWith(q) || q.startsWith(n)) score = Math.max(score, 2);
        else if (n.includes(q) || q.includes(n)) score = Math.max(score, 1);
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
    if (!company) { res.status(404).json({ error: 'Account not found' }); return; }
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

    res.json({
      company: { ...company, aliases: crmAliases(id) },
      contacts: [...autoContacts, ...contacts], facts, quotes, enriched,
      opp: { count: open.length, value: open.reduce((s, q) => s + (q.price || 0), 0) },
    });
  });

  // POST /api/crm/company — create (no id) or update (with id).
  app.post('/api/crm/company', (req, res) => {
    const { id, name, country, tags, notes } = req.body || {};
    if (!name || !String(name).trim()) { res.status(400).json({ error: 'Name required' }); return; }
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
    if (!tid || !sids.length) { res.status(400).json({ error: 'targetId and sourceIds required' }); return; }
    if (!queryAll('SELECT id FROM crm_company WHERE id = ?', [tid])[0]) { res.status(404).json({ error: 'Target not found' }); return; }
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
    if (!companyId || !name || !String(name).trim()) { res.status(400).json({ error: 'companyId and name required' }); return; }
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
    if (!companyId || !text || !String(text).trim()) { res.status(400).json({ error: 'companyId and text required' }); return; }
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
    if (!k) { res.status(400).json({ error: 'key required' }); return; }
    const oid = ownerId();
    if (state === 'won' || state === 'lost') {
      runWrite('INSERT INTO crm_quote_state (ownerId, sfId, state, updatedAt) VALUES (?,?,?,?) ON CONFLICT(ownerId, sfId) DO UPDATE SET state=excluded.state, updatedAt=excluded.updatedAt',
        [oid, k, state, new Date().toISOString()]);
    } else {
      runWrite('DELETE FROM crm_quote_state WHERE ownerId = ? AND sfId = ?', [oid, k]);
    }
    res.json({ ok: true });
  });

  // GET /api/crm/company/:id/insights — AI-generated facts & warnings from the
  // account's full run history (not persisted unless the user pins one).
  const _crmInsightCache = new Map<number, { ts: number; items: any[] }>();
  app.get('/api/crm/company/:id/insights', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const company = queryAll('SELECT * FROM crm_company WHERE id = ?', [id])[0] as any;
    if (!company) { res.status(404).json({ error: 'Account not found' }); return; }
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
      const r = await ai.models.generateContent({
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
    if (!company) { res.status(404).json({ error: 'Account not found' }); return; }
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
      const r = await ai.models.generateContent({
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
    if (!query?.trim()) { res.status(400).json({ error: 'query required' }); return; }
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
  app.get('/api/config', (_req, res) => res.json(loadPyCfg()));
  app.post('/api/config', (req, res) => {
    try {
      const beforeKey = String((loadPyCfg() as any).gemini_key || '');
      const nextCfg = { ...loadPyCfg(), ...req.body };
      writeFileSync(pyFile('config.json'), JSON.stringify(nextCfg, null, 2));
      if (String((nextCfg as any).gemini_key || '') !== beforeKey) {
        _gemini = null;
        _geminiKey = '';
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Session ────────────────────────────────────────────────────────────────
  app.get('/api/session', (_req, res) => {
    res.json({ startedAt: sessionStartedAt });
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
    res.json({ hasCookies, fedLen: cookies?.fed?.length, rtLen: cookies?.rt?.length, spStatus, spBody, userName });
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
    if (!cookies) { res.json({ error: 'not connected' }); return; }
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
      req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
      req.write(body);
      req.end();
    });
  }

  // ── Copilot / AI Search ────────────────────────────────────────────────────
  app.post('/api/copilot', async (req, res) => {
    const { query } = req.body as { query: string };
    if (!query?.trim()) { res.json({ answer: null, error: 'No query' }); return; }

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
    if (!query?.trim()) { res.json({ answer: null, error: 'No query' }); return; }
    res.json(await chatAnswer(query, history));
  });

  app.get('/api/ai/status', (_req, res) => {
    res.json({ available: !!getGemini() });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Outlook integration (win32com or Microsoft Graph) ─────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let outlookBackend = 'auto'; // 'auto' | 'imap' | 'graph' | 'win32'

  async function runOutlookPy(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const script = pyFile('outlook_reader.py');
      if (!existsSync(script)) { reject(new Error('outlook_reader.py not found')); return; }
      const [cmd, base] = pyArgs(script);
      const proc = spawn(cmd, [...base, '--backend', outlookBackend, ...args],
        { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', (e: Error) => reject(e));
      proc.on('close', () => {
        try { resolve(JSON.parse(out.trim())); }
        catch { reject(new Error(err.trim() || out.trim() || 'No output')); }
      });
    });
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
      if (!entryId || !index) { res.status(400).json({ error: 'entryId and index required' }); return; }
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
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(att.path)}"`);
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
      const r = await runOutlookPy(['--action', 'imap-config', '--body', JSON.stringify({ email, password })]);
      if (r.ok) outlookBackend = 'imap';
      res.json(r);
    } catch (e: any) { res.json({ ok: false, error: e.message }); }
  });

  // Graph auth: opens browser for interactive Microsoft 365 sign-in
  app.post('/api/outlook/graph-connect', (_req, res) => {
    const script = pyFile('outlook_reader.py');
    if (!existsSync(script)) { res.json({ ok: false, error: 'outlook_reader.py not found' }); return; }
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

  app.get('/api/outlook/emails', async (req, res) => {
    const storeId = String(req.query.storeId || 'default');
    const limit   = String(Math.min(50, parseInt(String(req.query.limit || '30'), 10) || 30));
    const unread  = String(req.query.unread) === 'true' ? '1' : '0';
    try { res.json(await runOutlookPy(['--action', 'emails', '--store', storeId, '--limit', limit, '--unread', unread])); }
    catch (e: any) { res.json({ emails: [], error: e.message }); }
  });

  app.get('/api/outlook/email/:id', async (req, res) => {
    try { res.json(await runOutlookPy(['--action', 'email', '--id', req.params.id])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  app.post('/api/outlook/save-attachment', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'entryId required' }); return; }
    const dest = path.join(loadPyCfg().base, 'PDF Quotes');
    try { res.json(await runOutlookPy(['--action', 'save-attachment', '--id', entryId, '--dest', dest])); }
    catch (e: any) { res.json({ error: e.message, saved: [] }); }
  });

  // Serve a single attachment inline (PDF or image)
  app.get('/api/outlook/attachment-view/:entryId/:index', async (req, res) => {
    const entryId = decodeURIComponent(req.params.entryId);
    const index   = req.params.index;
    const tmpDir  = path.join(os.tmpdir(), 'vector_att');
    try {
      const r = await runOutlookPy(['--action', 'get-attachment', '--id', entryId, '--index', index, '--dest', tmpDir]);
      if (r.error || !r.path) { res.status(404).send(r.error || 'Attachment not found'); return; }
      const ext  = path.extname(r.name).toLowerCase();
      const mime: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif': 'image/gif',
        '.bmp': 'image/bmp',  '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.tiff': 'image/tiff', '.tif': 'image/tiff',
      };
      res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${r.name.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      createReadStream(r.path).pipe(res);
    } catch (e: any) { res.status(500).send(e.message); }
  });

  // Price a PDF attachment via schematic_reader (Gemini vision)
  app.post('/api/outlook/attachment-price', async (req, res) => {
    try {
      const { entryId, index, isImage } = (req.body ?? {}) as { entryId: string; index: number; isImage?: boolean };
      if (!entryId || !index) { res.json({ error: 'entryId and index required' }); return; }
      const tmpDir   = path.join(os.tmpdir(), 'vector_att');
      const pyScript = pyFile('schematic_reader.py');
      if (!existsSync(pyScript)) { res.json({ error: 'schematic_reader.py not found' }); return; }

      const att = await runOutlookPy(['--action', 'get-attachment', '--id', entryId, '--index', String(index), '--dest', tmpDir]);
      if (att.error || !att.path) { res.json({ error: att.error || 'Could not save attachment' }); return; }

      const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
      const ext = path.extname(att.path).toLowerCase();
      const mode = (isImage || imageExts.has(ext)) ? 'image' : 'pdf';

      const [py, base] = pyArgs(pyScript);
      await new Promise<void>(resolve => {
        const proc = spawn(py, [...base, '--mode', mode, '--input', att.path], { env: { ...process.env } });
        let out = '', err = '';
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        proc.on('error', (e: Error) => {
          if (!res.headersSent) res.json({ error: e.message });
          resolve();
        });
        proc.on('close', () => {
          if (!res.headersSent) {
            try { res.json(JSON.parse(out.trim())); }
            catch { res.json({ error: err.trim() || out.trim() || 'No output from schematic reader' }); }
          }
          resolve();
        });
      });
    } catch (e: any) {
      if (!res.headersSent) res.json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/outlook/analyze', async (req, res) => {
    const { subject, sender, senderEmail, received, body, attachments } = req.body as {
      subject: string; sender: string; senderEmail: string;
      received: string; body: string; attachments: Array<{ name: string }>;
    };
    const ai = getGemini();
    if (!ai) { res.json({ analysis: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const attList = attachments?.map(a => a.name).join(', ') || 'none';
    const prompt = [
      `Analyze this email for an Eaton quote engineer (Laith Al-Soub, Budapest) using Vector.`,
      ``,
      `**From:** ${sender} <${senderEmail}>`,
      `**Subject:** ${subject}`,
      `**Received:** ${received}`,
      `**Attachments:** ${attList}`,
      ``,
      `**Email body:**`,
      (body || '').slice(0, 3000),
      ``,
      `Provide a concise structured analysis with these exact sections:`,
      ``,
      `## Summary`,
      `1-2 sentences: what this email is about.`,
      ``,
      `## What's Requested`,
      `What is specifically being asked or needed from the quote team.`,
      ``,
      `## Type`,
      `One of: Quote request / Customer PO / EL pricing request / Status query / Technical query / FYI / Other`,
      ``,
      `## Key Data`,
      `Extract any present: customer name, project name, Salesforce ID (SR00xxxxx), quoted amount, deadline, product type (EL/PDC/ICP/MV/etc.)`,
      ``,
      `## Next Steps`,
      `Numbered, specific actions using exact Vector UI names: "Dashboard → Step 1", "EL Pricer tab", "Raise PMO", "Draft Reply". Skip steps that don't apply.`,
      ``,
      `Tone: direct and factual. Skip sections if there is nothing to say.`,
    ].join('\n');

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { systemInstruction: buildSystemPrompt(''), maxOutputTokens: 2048, temperature: 0.2 },
      });
      res.json({ analysis: response.text });
    } catch (e: any) {
      const detail = e.cause?.message ? ` (${e.cause.message})` : '';
      res.json({ analysis: null, error: 'Gemini error: ' + e.message + detail });
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

    // Fetch last 5 accepted/sent replies for style context
    const pastReplies = queryAll(
      `SELECT subject, finalReply FROM email_feedback WHERE feedbackType IN ('sent','edited_sent') ORDER BY id DESC LIMIT 5`
    );

    const examplesBlock = pastReplies.length > 0
      ? '\n\n**Your past approved replies (style reference):**\n' +
        pastReplies.map((r, i) => `Example ${i + 1} (re: "${r.subject}"):\n${r.finalReply}`).join('\n\n')
      : '';

    const prompt = [
      `You are drafting a professional email reply on behalf of an Eaton quote engineer (Laith Al-Soub, Budapest).`,
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
      `- Be direct and actionable. Use Laith's tone (professional, friendly, efficient).`,
      `- If quoting timelines or next steps, be specific.`,
      `- Do NOT include a subject line or "Re:" prefix — just the reply body.`,
      `- Do NOT add placeholder text like "[Your Name]" — sign off as "Laith / Eaton Budapest".`,
    ].join('\n');

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 600, temperature: 0.3 },
      });
      res.json({ draft: response.text });
    } catch (e: any) {
      res.json({ draft: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── Send reply via Outlook COM ────────────────────────────────────────────
  app.post('/api/outlook/send-reply', async (req, res) => {
    const { entryId, body: replyBody } = req.body as { entryId: string; body: string };
    if (!entryId || !replyBody) { res.json({ error: 'entryId and body required' }); return; }
    try { res.json(await runOutlookPy(['--action', 'send-reply', '--id', entryId, '--body', replyBody])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Store email feedback to improve future drafts ─────────────────────────
  app.post('/api/outlook/feedback', (req, res) => {
    const { entryId, subject, senderEmail, emailType, draftReply, finalReply, feedbackType } = req.body as {
      entryId: string; subject?: string; senderEmail?: string; emailType?: string;
      draftReply?: string; finalReply?: string; feedbackType: string;
    };
    if (!entryId || !feedbackType) { res.json({ error: 'entryId and feedbackType required' }); return; }
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
  app.post('/api/outlook/chat', async (req, res) => {
    const { subject, sender, senderEmail, body, analysis, history, question } = req.body as {
      subject: string; sender: string; senderEmail: string; body: string;
      analysis?: string; history: Array<{ role: 'user' | 'ai'; text: string }>; question: string;
    };
    const ai = getGemini();
    if (!ai) { res.json({ answer: null, error: 'No Gemini API key — add it in Settings' }); return; }

    const systemCtx = [
      `You are an AI assistant helping an Eaton quote engineer (Laith Al-Soub, Budapest) handle emails.`,
      `Answer questions about the current email concisely and directly.`,
      ``,
      `Eaton LoadStar-PS CBU list prices (3hr autonomy, ex VAT):`,
      `Single Phase: 0.5KVA=£5,501 | 1KVA=£7,452 | 2KVA=£8,961 | 4KVA=£12,085 | 5KVA=£13,475 | 8KVA=£24,432 | 10KVA=£27,214 | 12KVA=£36,780 | 15KVA=£40,952 | 16KVA=£49,128 | 20KVA=£54,690`,
      `Three Phase: 6KVA=£14,939 | 8KVA=£21,048 | 10KVA=£22,913 | 12KVA=£31,483 | 14KVA=£36,225 | 16KVA=£37,996 | 18KVA=£39,457 | 20KVA=£45,780 | 24KVA=£63,228 | 28KVA=£72,713 | 30KVA=£69,265 | 32KVA=£76,256 | 36KVA=£79,177 | 40KVA=£91,824 | 42KVA=£109,201 | 48KVA=£114,515 | 54KVA=£118,897 | 56KVA=£145,689 | 60KVA=£137,867 | 64KVA=£152,775 | 72KVA=£158,617 | 80KVA=£183,910`,
      `Note: No 50KVA system exists — nearest are 48KVA (£114,515) and 54KVA (£118,897).`,
      `When asked about CBU or LoadStar-PS prices, answer directly from this table. Do not say you lack access to pricing data.`,
      ``,
      `Current email:`,
      `From: ${sender} <${senderEmail}>`,
      `Subject: ${subject}`,
      ``,
      (body || '').slice(0, 3000),
      analysis ? `\nPrevious analysis:\n${analysis}` : '',
    ].join('\n');

    const contents = [
      ...history.map(m => ({
        role: m.role === 'user' ? 'user' : 'model' as const,
        parts: [{ text: m.text }],
      })),
      { role: 'user' as const, parts: [{ text: question }] },
    ];

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: { systemInstruction: systemCtx, maxOutputTokens: 800, temperature: 0.3 },
      });
      res.json({ answer: response.text });
    } catch (e: any) {
      res.json({ answer: null, error: 'Gemini error: ' + e.message });
    }
  });

  // ── Morning Briefing ──────────────────────────────────────────────────────
  app.post('/api/outlook/briefing', async (req, res) => {
    const { emails } = req.body as {
      emails: Array<{
        entryId: string; subject: string; sender: string; senderEmail: string;
        received: string; bodyPreview: string; hasPdf: boolean;
      }>;
    };
    const ai = getGemini();
    if (!ai) { res.json({ briefing: null, error: 'No Gemini API key — add it in Settings' }); return; }
    if (!emails || emails.length === 0) { res.json({ briefing: [] }); return; }

    // Use short numeric ids in the prompt to avoid 140-char entryIds blowing the token budget
    const idMap = emails.map((e, i) => ({ idx: i + 1, entryId: e.entryId }));
    const emailList = emails.map((e, i) =>
      `${i + 1}. Subject: ${e.subject}\n   From: ${e.sender} <${e.senderEmail}>\n   Preview: ${e.bodyPreview.slice(0, 120)}${e.hasPdf ? '\n   [PDF attached]' : ''}`
    ).join('\n\n');

    const prompt =
`You are helping Laith Al-Soub, an Eaton quote engineer in Budapest, triage his inbox.

For each email, output one JSON object with:
- "id": the email number (integer, 1-${emails.length})
- "priority": "high", "medium", or "low"
- "tag": one of "Quote Request", "PDF Received", "Action Required", "Follow Up", "Info Only", "FYI"
- "action": one imperative sentence (max 12 words)
- "summary": one sentence (max 15 words)

Output ONLY a JSON array. No prose, no markdown.

Emails:
${emailList}`;

    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 8192, temperature: 0.1 },
      });
      const raw = (response.text || '').trim();
      console.log('[briefing] raw response (%d chars): %s', raw.length, raw.slice(0, 300));

      // Robust JSON array extraction: find first '[' and walk to its matching ']'
      function extractArray(text: string): any[] | null {
        // First try: maybe the whole response (stripped of fences) is already valid JSON
        const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        try {
          const p = JSON.parse(stripped);
          if (Array.isArray(p)) return p;
        } catch {}
        // Second try: find first '[' and count brackets to find matching ']'
        const start = text.indexOf('[');
        if (start === -1) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (esc)             { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true;  continue; }
          if (c === '"')       { inStr = !inStr; continue; }
          if (inStr)           continue;
          if (c === '[')       depth++;
          else if (c === ']') {
            depth--;
            if (depth === 0) {
              try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
            }
          }
        }
        return null;
      }

      const parsed = extractArray(raw);
      if (parsed) {
        // Map short numeric ids back to real Outlook entryIds
        const briefing = parsed.map((item: any) => ({
          ...item,
          entryId: idMap.find(m => m.idx === item.id)?.entryId ?? '',
        })).filter((item: any) => item.entryId);
        console.log('[briefing] parsed %d items', briefing.length);
        res.json({ briefing });
        return;
      } else {
        console.log('[briefing] parse failed, raw:', raw.slice(0, 500));
        res.json({ briefing: null, error: 'Could not parse AI response. Raw: ' + raw.slice(0, 200) });
        return;
      }
      } catch (e: any) {
        lastErr = e.message;
        const is5xx = /5\d\d/.test(e.message) || e.message.includes('Bad Gateway') || e.message.includes('unavailable');
        console.warn(`[briefing] attempt ${attempt} failed: ${e.message}`);
        if (!is5xx || attempt === 3) break;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    console.error('[briefing] Gemini error after retries:', lastErr);
    res.json({ briefing: null, error: 'Gemini error: ' + lastErr });
  });

  // ── Flag / unflag email ───────────────────────────────────────────────────
  app.post('/api/outlook/flag', async (req, res) => {
    const { entryId, flagged } = req.body as { entryId: string; flagged: boolean };
    if (!entryId) { res.json({ error: 'entryId required' }); return; }
    try { res.json(await runOutlookPy(['--action', 'flag', '--id', entryId, '--flagged', flagged ? '1' : '0'])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Mark email as unread ──────────────────────────────────────────────────
  app.post('/api/outlook/mark-unread', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'entryId required' }); return; }
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
    if (!entryId || !to) { res.json({ error: 'entryId and to required' }); return; }
    try { res.json(await runOutlookPy(['--action', 'forward', '--id', entryId, '--to', to, '--body', fwdBody || ''])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Open in Outlook ───────────────────────────────────────────────────────
  app.post('/api/outlook/open-in-outlook', async (req, res) => {
    const { entryId } = req.body as { entryId: string };
    if (!entryId) { res.json({ error: 'entryId required' }); return; }
    try { res.json(await runOutlookPy(['--action', 'open-in-outlook', '--id', entryId])); }
    catch (e: any) { res.json({ error: e.message }); }
  });

  // ── Categorize email ──────────────────────────────────────────────────────
  app.post('/api/outlook/categorize', async (req, res) => {
    const { entryId, category } = req.body as { entryId: string; category: string };
    if (!entryId) { res.json({ error: 'entryId required' }); return; }
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
    if (!entryId || !replyBody) { res.json({ error: 'entryId and body required' }); return; }
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
    const { to, subject, body: emailBody, attSources } = req.body as {
      to: string; subject: string; body?: string; attSources?: Array<{ entryId: string; index: number }>;
    };
    if (!to || !subject) { res.json({ error: 'to and subject required' }); return; }
    try {
      res.json(await runOutlookPy([
        '--action', 'send-new',
        '--to', to,
        '--subject', subject,
        '--body', emailBody || '',
        '--att-sources', JSON.stringify(attSources || []),
      ]));
    } catch (e: any) { res.json({ error: e.message }); }
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
    if (!query?.trim()) { res.json({ answer: null, error: 'No query' }); return; }

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
      const cls = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text:
          `You route messages for an Eaton quote-automation app. The user can search their quotes `
          + `(stored on SharePoint — searchable by customer, salesman, KVA rating, catalogue/fitting `
          + `number, or any text inside the quote PDF/email) OR ask a general question about the app/workflow.\n`
          + `Known sales reps (salesmen whose names appear in quotes, for salesman-scoped searches): Blair McDonald, Craig Donaldson, Joe Bayley, Mark Fenton, Ollie Bailey, Ryan Houston.\n\n`
          + (histCtx ? `Recent conversation (for context, oldest first):\n${histCtx}\n\n` : '')
          + `New message: "${query.replace(/"/g, "'")}"\n\n`
          + `Reply with ONLY a JSON object, no prose:\n`
          + `{"intent":"search"|"chat"|"crm","term":"<keywords to search, filler removed>",`
          + `"scope":"mine"|"all","mode":"list"|"count"|"who"|"material","salesman":"<full name or empty>"}\n`
          + `Rules:\n`
          + `- intent="crm" if they want to EDIT the CRM: add/update a contact, note a fact about a customer/account, mark a quote won/lost, create an account, set a note, or tag an account.\n`
          + `- intent="search" if they want to find/count quotes, who made them, or what's inside them.\n`
          + `- A message that is JUST a spec/rating (e.g. "4kVA"), a catalogue/fitting number, a customer name, or a salesman name — with no app/how-to question — is intent="search".\n`
          + `- FOLLOW-UPS: if the new message is "try again", "do it", "again", "yes", "retry", "go", or similar, repeat the intent and term of the MOST RECENT search request in the conversation above (do NOT use the literal words "try again" as the term).\n`
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

      const resp = await ai.models.generateContent({
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
      res.json({ ok: false, error: 'refresh_cookies.py not found' }); return;
    }
    const [cmd, args] = pyArgs(script);
    const py = spawn(cmd, args, {
      cwd: __dirname,
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
  app.get('/api/run/step1', (req, res) => {
    const pdfScript = pyFile('pdf_to_csv.py');
    const upScript  = pyFile('Automation_V4.py');
    const division  = String(req.query.division || '').toUpperCase();
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

    if (division) send(`[*] Division: ${division}`);
    if (arrived)  send(`[*] Arrival date: ${arrived}`);
    send(`[*] PDF folder: ${pdfFolder}`);
    send('[*] Phase 1 — Extracting PDFs to CSV...');
    const [c1, a1] = pyArgs(pdfScript);
    const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
                    MAGIC_PDF_FOLDER: pdfFolder,
                    MAGIC_CSV_FOLDER: csvFolder,
                    ...(division ? { MAGIC_DIVISION: division } : {}),
                    ...(arrived  ? { MAGIC_ARRIVED:  arrived  } : {}),
                    ...(today    ? { MAGIC_TODAY:    today    } : {}) };
    const p1 = spawn(c1, a1, { cwd: __dirname, env: pyEnv });
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
      const pCheck = spawn(cc, [...ac, '--check'], { cwd: __dirname, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
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
        runStep1Upload(res, upScript, {}, t0, queuedNames, division, send);
      });
    });
  });

  function runStep1Upload(
    res: Response, upScript: string, decisions: Record<string, unknown>,
    t0: number, queuedNames: string[], division: string,
    send: (l: string) => void,
  ) {
    send('[*] Phase 2 — Uploading to Quotation List...');
    const [c2, a2] = pyArgs(upScript);
    const env2 = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      ...(Object.keys(decisions).length ? { CONFLICT_DECISIONS: JSON.stringify(decisions) } : {}),
    };
    const p2 = spawn(c2, a2, { cwd: __dirname, env: env2 });
    let items = 0;
    p2.stdout.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => { send(l); if (l.includes('[OK]')) items++; }));
    p2.stderr.on('data', d => String(d).split('\n').filter(l => l.trim()).forEach(l => send(`[WARN] ${l}`)));
    p2.on('error', err => { send(`[ERR] Could not start Python: ${err.message}`); res.write(`data: __DONE__:false\n\n`); res.end(); });
    p2.on('close', code2 => {
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
    runStep1Upload(res, upScript, decisions, t0, queuedNames, division, send);
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
    });
  });

  // ── PMO ────────────────────────────────────────────────────────────────────
  const pmoDownloads = new Map<string, { filePath: string; filename: string; tmpDir: string }>();

  app.get('/api/pmo/download/:id', (req, res) => {
    const id = req.params.id;
    const entry = pmoDownloads.get(id);
    if (!entry) { res.status(404).send('File not found or expired'); return; }
    const { filePath, filename } = entry;
    if (!existsSync(filePath)) { res.status(404).send(`File missing on disk: ${filePath}`); return; }
    const safeName = filename.replace(/[^\w\s().,-]/g, '_');
    const encoded  = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Cache-Control', 'no-store');
    pmoDownloads.delete(id);
    const stream = createReadStream(filePath);
    stream.on('error', (err: any) => {
      if (!res.headersSent) res.status(500).send(`Read error: ${err.message}`);
      else res.destroy();
    });
    stream.on('end', () => {
      try { unlinkSync(filePath); } catch {}
      try { rmdirSync(entry.tmpDir); } catch {}
    });
    stream.pipe(res);
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

  app.get('/api/docs/:id', (req, res) => {
    const doc = DOCS[req.params.id];
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    const filePath = path.join(__dirname, 'docs', doc.file);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'File missing' }); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.name}"`);
    createReadStream(filePath).pipe(res);
  });

  app.get('/api/docs-xlsx/:id', (req, res) => {
    const doc = DOCS_XLSX[req.params.id];
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    const filePath = path.join(__dirname, 'docs', doc.file);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'File missing' }); return; }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.name}"`);
    createReadStream(filePath).pipe(res);
  });

  // ── CBU Tech Brief export ──────────────────────────────────────────────────
  const cbuDownloads = new Map<string, { filePath: string; tmpDir: string }>();

  app.get('/api/download/cbu/:id', (req, res) => {
    const entry = cbuDownloads.get(req.params.id);
    if (!entry || !existsSync(entry.filePath)) {
      res.status(404).json({ error: 'Not found or expired' }); return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="CBU_Tech_Brief.pdf"');
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
    const { system, project, quote, engineer, email, phone } = req.body || {};
    if (!system || !project || !quote || !engineer || !email || !phone) {
      res.status(400).json({ error: 'Missing fields' }); return;
    }
    const tmpDir = path.join(os.tmpdir(), `cbu_${Date.now()}`);
    const script = pyFile('cbu_export.py');
    const [py, base] = pyArgs(script);
    const child = spawn(py, [
      ...base,
      '--system',   system, '--project',  project,
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
        const dlId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        cbuDownloads.set(dlId, { filePath, tmpDir });
        setTimeout(() => cbuDownloads.delete(dlId), 10 * 60 * 1000);
        if (!res.headersSent) res.json({ id: dlId });
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
      res.status(404).json({ error: 'Not found or expired' }); return;
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
    const { type, panels, lumis, cards = 0, software, centralLondon } = req.body || {};
    if (!type || panels == null || !software || !centralLondon) {
      res.status(400).json({ error: 'Missing fields' }); return;
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
      '--outdir',         tmpDir,
    ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

    let stdout = '', stderr = '', settled = false;
    const finish = (send: () => void) => { if (settled) return; settled = true; clearTimeout(hardTimer); send(); };
    const hardTimer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => { if (!res.headersSent) res.status(504).json({ error: 'Export timed out — LibreOffice may have hung, please try again.' }); });
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
        const dlId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        commDownloads.set(dlId, { filePath, tmpDir });
        setTimeout(() => commDownloads.delete(dlId), 10 * 60 * 1000);
        if (!res.headersSent) res.json({ id: dlId });
      } else {
        const msg = errLine ? errLine.slice('__ERROR__:'.length) : (stderr.trim() || stdout.trim() || 'No output from script');
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

    const cmd    = process.platform === 'win32' ? 'python' : 'python3';
    const script = pyFile('pmo_raise.py');

    const pyEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      MAGIC_PMO_QUOTE_PDF:  quotePdfPath,
      MAGIC_PMO_PO_PDF:     poPdfPath,
      ...(seqOverride ? { MAGIC_PMO_SEQ: seqOverride } : {}),
      MAGIC_PMO_DOCU_PDFS:  docuPdfPaths.join('|'),
      MAGIC_PMO_OUTDIR:     tmpDir,
    };

    let docxPath = '';
    const py = spawn(cmd, [script], { cwd: __dirname, env: pyEnv });

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
        const dlId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    if (!existsSync(pyScript)) { res.json({ error: 'schematic_reader.py not found' }); return; }

    const tmpPaths: string[] = [];   // for cleanup
    let   args: string[] = [];

    function cleanup() {
      for (const p of tmpPaths) {
        if (p && existsSync(p)) { try { unlinkSync(p); } catch {} }
      }
    }

    if (ct.includes('multipart/form-data')) {
      const boundary = ct.split('boundary=')[1]?.trim();
      if (!boundary) { res.json({ error: 'No boundary in multipart' }); return; }
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
      let textVal = '';
      const files: { path: string; kind: 'pdf' | 'image'; name: string }[] = [];

      for (const p of parts) {
        const isFile = !!p.filename || /^(application\/pdf|image\/)/i.test(p.contentType || '');
        if (!isFile) {
          // Treat any non-file part as text (commonly name="text" or name="description")
          if (p.name === 'text' || p.name === 'description' || textVal === '') {
            textVal = (textVal ? textVal + '\n' : '') + p.body.toString('utf-8');
          }
          continue;
        }
        if (p.body.length === 0) continue;

        const ctLower = (p.contentType || '').toLowerCase();
        let kind: 'pdf' | 'image' = 'pdf';
        let ext = 'bin';
        if (/^application\/pdf/.test(ctLower) || /\.pdf$/i.test(p.filename || '')) {
          kind = 'pdf'; ext = 'pdf';
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
        res.json({ error: 'Error: ' + (err || out).slice(0, 400) });
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
    if (!getSpCookies()) { res.json({ ok: false, error: 'Not connected' }); return; }
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

  // ── Vite ───────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Vector v2  →  http://localhost:${PORT}\n`);
    console.log(`  /api/analytics      — NEW`);
    console.log(`  /api/search         — enriched with CUSTOMER, DIVISION, REQUESTED_x0020_BY`);
    console.log(`  /api/quote-ask      — smart in-chat quote search (classify + D&Q + metadata)\n`);
  });
}

startServer().catch(err => { console.error(err); process.exit(1); });
