# Vector — Quote Automation Platform
### Internal Tool · Eaton Corporation · Budapest · Laith Al-Soub

---

## Table of Contents

1. [What is Vector?](#1-what-is-vector)
2. [Tech Stack & Versions](#2-tech-stack--versions)
3. [Project Structure](#3-project-structure)
4. [How to Run](#4-how-to-run)
5. [Configuration](#5-configuration)
6. [Feature Modules](#6-feature-modules)
7. [Key Code Snippets](#7-key-code-snippets)
8. [API Reference](#8-api-reference)
9. [Python Scripts](#9-python-scripts)
10. [Database](#10-database)
11. [Version History](#11-version-history)
12. [Next Updates](#12-next-updates)
13. [Troubleshooting & Help](#13-troubleshooting--help)

---

## 1. What is Vector?

**Vector** (originally MagicUploader) is a personal productivity and automation platform built for Eaton quote engineers in Budapest. It runs locally on Windows 11 at `http://localhost:3000` and automates the most repetitive parts of the quoting and PMO workflow:

- Reads Outlook emails, applies AI triage, drafts replies
- Prices Eaton Emergency Lighting material lists from PDFs, images, or pasted text
- Uploads quote PDFs to SharePoint (JOE / QuotationFactory)
- Processes ServiceNow (SR00xxxxx) quote requests end-to-end
- Tracks all quote activity in a local SQLite database
- Provides an AI assistant that can answer questions and search SharePoint

The application is a single-process Node.js server that serves a React SPA. All automation (Outlook, SharePoint, PDF extraction) is handled server-side via Python scripts and Express API routes.

---

## 2. Tech Stack & Versions

### Frontend
| Package | Version | Purpose |
|---|---|---|
| React | 19.0.0 | UI framework |
| TypeScript | ~5.8.2 | Type safety |
| Vite | 6.2.0 | Dev server + production bundler |
| Tailwind CSS | 3.4.17 | Utility-first styling |
| lucide-react | 0.511.0 | Icon set |
| motion | 12.23.24 | Animations (toast, transitions) |
| recharts | 3.8.0 | Analytics charts |
| axios | 1.13.6 | HTTP client |
| react-dropzone | 15.0.0 | PDF drag-and-drop |
| clsx + tailwind-merge | 2.1.1 / 3.5.0 | Class name utilities |

### Backend
| Package | Version | Purpose |
|---|---|---|
| Express | 4.21.2 | HTTP server + API routes |
| tsx | 4.21.0 | TypeScript execution (no compile step) |
| sql.js | 1.12.0 | SQLite in-memory, persisted to file |
| @google/genai | 1.29.0 | Gemini AI (gemini-2.5-flash) |
| dotenv | 17.2.3 | Environment variables |
| ws | 8.20.1 | WebSocket support |
| https-proxy-agent | 7.0.6 | Corporate proxy handling |

### Python
| Library | Purpose |
|---|---|
| pywin32 (win32com) | Outlook COM automation |
| pdfplumber | PDF text extraction |
| openpyxl / pandas | Excel price list reading |
| requests | SharePoint Graph API calls |
| google-generativeai | Gemini AI from Python |
| urllib | Direct Gemini REST calls (schematic_reader.py) |

### Infrastructure
- **OS**: Windows 11 Enterprise (10.0.22631)
- **Node.js**: runs via `npx tsx` — no separate compile step
- **Python**: system Python, venv recommended
- **Database**: `eaton_automation.db` (SQLite, auto-created on first run)
- **AI**: Google Gemini 2.5 Flash (via `@google/genai` and direct REST)

---

## 3. Project Structure

```
VECTOR/
├── server.ts                  ← Express backend — ALL API routes, Vite middleware, DB
├── schematic_reader.py        ← EL Material Pricer — PDF/image/list extraction + pricing
├── outlook_reader.py          ← Outlook COM automation — read/send emails
├── refresh_cookies.py         ← JOE SharePoint connection (cookie-based auth) — "Connect to JOE"
├── pdf_to_csv.py              ← Step 1a — PDF/Word/Excel quote extraction pipeline
├── Automation_V4.py           ← Step 1b — SharePoint QuotationFactory list upload
├── dq_store_upload.py         ← Step 2 — D&Q Store folder creation + PDF upload
├── pmo_raise.py               ← PMO module — fills Word template from DOCU/PO PDFs
├── cbu_export.py / parse_cbu.py      ← CBU cable sizing export + parsing
├── commission_export.py       ← Commission export
├── xlsx_extractor.py          ← Italian xlsx quote extractor
├── outlook_win32_connector.py ← Outlook COM helper
├── overlay/                   ← Outlook overlay tracker (outlook_overlay.py, overlay_state.json, start-overlay.bat)
├── el_pricelist.xlsx          ← Eaton EL Global Price List July 2026, valid from 1 July 2026 (source data)
├── config.json                ← User config (paths, SharePoint URLs, Gemini key)
├── eaton_automation.db        ← SQLite database (auto-generated)
├── start-app.ps1              ← Windows launcher (PowerShell — kills old process, opens Edge)
├── start-app.vbs              ← VBScript wrapper to launch start-app.ps1 silently
├── setup.bat                  ← Setup (kills node, npm install + build)
├── package.json               ← Node.js dependencies
├── vite.config.ts             ← Vite configuration
├── tailwind.config.js         ← Tailwind configuration
├── index.html                 ← SPA entry point (title: "Vector")
│
├── src/
│   ├── App.tsx                ← App shell: splash screen, sidebar, header, tab routing
│   ├── main.tsx               ← React entry point
│   ├── index.css              ← Global styles, dark mode, fonts
│   ├── types.ts               ← Shared TypeScript types
│   │
│   ├── lib/
│   │   ├── api.ts             ← All Axios wrappers + SSE streaming helper
│   │   ├── ui.tsx             ← Shared UI primitives (Card, Button, Pill, etc.)
│   │   ├── cn.ts              ← clsx + tailwind-merge helper
│   │   ├── i18n.ts            ← Language context (EN/HU)
│   │   └── charts.tsx         ← MiniBars chart component
│   │
│   └── pages/
│       ├── Dashboard.tsx      ← PDF queue, job runner, stats, archive
│       ├── Inbox.tsx          ← Outlook reader + Summarize (vision) + EL Pricer + Quick Quote
│       ├── ELInfo.tsx         ← EL Internal Info tab (updates digest + chat)
│       ├── FentonKB.tsx       ← Ask Fenton tab (Q&A knowledge cards + chat)
│       ├── QuickQuote.tsx     ← Inbox Quick Quote panel (CBU BOM + luminaires → PDF)
│       ├── Assistant.tsx      ← AI assistant + SharePoint search
│       ├── Schematics.tsx     ← EL Material Pricer (standalone page)
│       ├── Analytics.tsx      ← Quote volume charts and trends
│       ├── History.tsx        ← Job history table with filters
│       ├── PMO.tsx            ← PMO document automation
│       ├── CBU.tsx            ← CBU cable sizing calculator
│       ├── Commission.tsx     ← Commission export
│       ├── Docs.tsx           ← Document pack generation
│       ├── Search.tsx         ← SharePoint search
│       ├── Overlay.tsx        ← Outlook overlay tracker view
│       └── Settings.tsx       ← Config editor (paths, keys, initials)
│
└── old-version/               ← Archived dead/duplicate files (22 items)
```

---

## 4. How to Run

### Launch (normal use)
Run **`start-app.vbs`** (or **`start-app.ps1`** directly). It:
1. Kills any process on port 3000
2. Opens Edge with SharePoint (for JOE session)
3. Opens `http://localhost:3000` in a second Edge window
4. Starts the Node.js server silently (no terminal window)

`start-app.vbs` is the silent wrapper that launches `start-app.ps1` without a visible PowerShell window.

### Manual start (development)
```powershell
cd "C:\Users\E0740516\Desktop\VECTOR\VECTOR"
npx tsx server.ts
```

### Build for production
```powershell
npm run build
# Then start:
$env:NODE_ENV="production"; npx tsx server.ts
```
Production mode serves the compiled `dist/` folder — faster, no Vite overhead.

### Requirements
- Node.js 18+ in PATH
- Python 3.10+ with: `pip install pywin32 pdfplumber openpyxl pandas requests`
- Microsoft Outlook desktop app open (for Inbox feature)
- Eaton network or VPN (for JOE/SharePoint connection)
- Gemini API key in `config.json`

---

## 5. Configuration

File: **`config.json`** (in project root)

```json
{
  "base":              "C:/Users/E0740516/Desktop/EatonAutomation",
  "initials":          "LS",
  "sp_site":           "https://eaton.sharepoint.com/sites/ELTechsupport",
  "sp_list":           "https://eaton.sharepoint.com/sites/QuotationFactoryEMEA",
  "dq_store":          "Shared Documents/D&Q Store",
  "azure_di_endpoint": "",
  "azure_di_key":      "",
  "gemini_key":        "AIzaSy..."
}
```

| Key | Description |
|---|---|
| `base` | Root folder for all automation files (PDFs queued here) |
| `initials` | Used to stamp generated documents |
| `sp_site` | SharePoint site for EL Tech Support uploads |
| `sp_list` | SharePoint site for QuotationFactory / JOE |
| `dq_store` | D&Q Store library path within the SharePoint site |
| `gemini_key` | Google AI Studio API key for Gemini 2.5 Flash |

Edit in-app via **Settings** tab (changes saved immediately to `config.json`).

---

## 6. Feature Modules

### 6.1 Splash Screen + Connect to JOE
On every launch, Vector shows a minimal splash screen. Clicking **Connect to JOE** runs the SharePoint authentication script (`refresh_cookies.py`) which captures the session cookies from the already-open Edge browser. Once connected, the splash dismisses and the main app appears. The header button lets you reconnect at any time without restarting.

**State logic:**
```typescript
const [splashDone, setSplashDone] = useState(false);
// Auto-dismiss when connection confirmed
useEffect(() => { if (connected === true) setSplashDone(true); }, [connected]);
```

---

### 6.2 Dashboard
The main workflow page. Contains:
- **PDF Queue** — drag-and-drop PDFs, or they auto-appear if dropped in the `base` folder
- **Step 1** — Reads PDF, extracts quote data, uploads to SharePoint, creates archive folder
- **Step 2** — Fills the QuotationFactory SharePoint list entry, sends confirmation
- **Recent Jobs** — Last 20 processed quotes with status and price
- **Archive** — Browse the last 5 archive days

Steps stream their output line-by-line using Server-Sent Events (SSE):
```typescript
// src/lib/api.ts — streaming runner
export async function runStreamingScript(endpoint, { onLine }) {
  const res = await fetch(url);
  const reader = res.body.getReader();
  // reads SSE chunks, calls onLine() for each output line
}
```

---

### 6.3 Inbox — Email Triage
Full Outlook integration via COM automation. Email-detail action bar: **Summarize · Reply · + Attach · EL Pricer · CBU Sheet · Quick Quote**. Features:
- **Multi-mailbox** — personal inbox + shared mailboxes shown as tabs
- **15-minute cache** — emails cached client-side, auto-refresh
- **Summarize** (replaces the old Analyze + Chat + Briefing, 2026-07-16) — one panel: a structured AI summary (Summary / What's Requested / Type / Key Data / Next Steps) plus an inline follow-up chat, in the same panel. **Vision**: reads photos/diagrams/scanned tables inside the email — inline body images automatically (logos < 12 KB skipped), attachments and PDFs when you tick them in the "Feed to AI" row (applies to both the summary and the chat). Summaries **persist** per email in SQLite (`email_summaries`), so reopening (even after restart) is instant and free; Refresh regenerates.
- **AI Reply Draft** — one-click draft with feedback loop (sends/liked/disliked saved to DB)
- **Inline images render in the body** — `<img src="cid:…">` refs are rewritten to `/api/outlook/attachment-view/:entryId/:index` using each attachment's Content-ID (see `resolveCidImages` in Inbox.tsx).
- **Inline EL Pricer** — appears in the email detail; prices attached PDFs, **images and Excel/CSV** (Excel routed through a `--mode unified` manifest).
- **Quick Quote** — see §6.9.
- **PDF Queue** — one-click to queue PDF attachments from SR00 emails
- **Quote-folder search** (added 2026-08-12) — the list-pane search box has two layers. Typing filters the emails already loaded (instant). **Enter** (or the globe button) searches the quote folders: subject, sender, To/CC, **body** and **attachment filenames**. Matched terms are highlighted in the rows, each hit shows the folder it lives in, Esc / "Back to list" returns to the normal view.
  - **Scope is a hard allowlist** — `SEARCH_SCOPE` in `outlook_reader.py`: the `UKQuoteFactoryEL` store, root folders `Inbox` (48 items) and `Completed by Laith` (2 052). Everything else is deliberately out: the personal mailbox, `email drop` (a dump that duplicates Inbox mail), Deleted Items, Public Folders. Matching is on the store's display name + root-level folder name, so the identically named "Completed by Laith" under the personal store's Deleted Items is never picked up.
  - **Local index** — those messages are mirrored into `DATA_DIR/mail_index.db` (SQLite, gitignored via `*.db`). A search is then a millisecond `LIKE` over `blob` (subject + sender + recipients + attachment names + first 40 KB of body); `fields=meta` searches `meta_blob` only. Attachment-name search is free, because the names are in the blob.
  - **Why an index**: reading one message through Outlook COM costs ~64 ms, so a live sweep re-reads minutes of mail per query. First build ≈ 2–4 min; incremental syncs walk off the end of the new mail in seconds. Indexing uses `att_info_light()` — the Content-ID probe in `att_info()` is a MAPI round trip per attachment (~5 per quote mail) and dominated the build until it was dropped; cid: resolution only matters when an email is opened, which re-fetches it live anyway.
  - **Sync**: `folder_state.complete` marks a folder that has been read to its oldest message; only then may an incremental run stop at a stretch of already-known mail (otherwise the known part is just the newest slice of a half-built index). Pruning deleted/moved mail happens **only on a full run**, which is the only one that saw every message. Server syncs 20 s after boot, then every 10 min, and after any search that had to answer live.
  - **Live fallback** (`source=live`, or `auto` with a cold index) still walks the same two folders through `Items.Restrict` + DASL — MAPI, **not** the Windows Search index, which is stale on this machine and is why Classic Outlook's own search misses mail that is plainly there. Time-budgeted; partial results come back with `truncated: true`.
  - Endpoints: `GET /api/outlook/search?q=&limit=&fields=all|meta&source=auto|index|live`, `GET /api/outlook/index/status`, `POST /api/outlook/index/sync {full}`. Python: `--action search|index|index-status --dest <db>`.
- **Concurrent email fetches are coalesced** — the pane refreshes every 30 s and Outlook COM serialises, so identical in-flight `/api/outlook/emails` requests now share one python process. Without it, slow COM work left ~17 stacked python processes all waiting on Outlook.

**Module-level state** — tab switches don't lose data (`_available`, `_mailboxes`, `_summaryCache`, …). Wrapper setters keep the module var in sync with React state.

**Resize handles** use a full-screen transparent drag-shield (`resizeMode` state → fixed `inset-0` overlay) so the email iframe can't swallow `mousemove` mid-drag.

---

### 6.4 EL Material Pricer (Schematics)
Prices Eaton Emergency Lighting items against the July 2026 price list (`el_pricelist.xlsx`, valid from 1 July 2026). Three input modes:
- **Material List** — paste one item per line (accepts many formats)
- **PDF Schematic** — Gemini reads the PDF and extracts EL items
- **Paste Image** — screenshot/photo, Gemini vision extracts items

**Match types** (shown in results table):
| Type | Meaning | UI indicator |
|---|---|---|
| `exact` | Direct catalogue number match | Clean |
| `fuzzy` | Matched with normalisation (no hyphens, 0↔O swap, etc.) | Shows original input |
| `description` | Matched via family/description keyword search | Shows original input + `⋯` menu |

**`⋯` feedback menu** (appears on fuzzy/description matches):
- "This match is correct" — dismisses
- "Wrong — enter correct catalogue no" — saves correction to localStorage, re-prices
- "Try again with original" — re-sends to server

**Copy email** produces a plain-text schedule with only NTP/Unit (no line totals, no grand total) — ready to paste into an Outlook email:
```
MATERIAL SCHEDULE — EATON EMERGENCY LIGHTING
──────────────────────────────────────────────────────────────────────
Ref      Catalogue No       Description                          Qty   NTP/Unit
──────────────────────────────────────────────────────────────────────
E1       MP2ES230CGS        Micropoint 2 Escape Slave 230V         6     £45.20
...
```

**Inline EL Pricer in Inbox** — when Gemini detects an EL-related email, an amber "EL Material Pricer" panel appears directly in the email detail. Pre-populated from the email body if catalogue numbers are detected. No tab switching needed.

---

### 6.5 AI Assistant
Gemini-powered chat interface with access to SharePoint search. Can:
- Answer questions about Eaton products
- Search the QuotationFactory SharePoint list
- Maintain a conversation history
- Suggest actions (e.g. "go to PMO tab")

---

### 6.6 Analytics
Charts showing quote volume over time (7/30/90 days). Data comes from the local SQLite `jobs` table. Renders per-product bars using Recharts.

---

### 6.7 Internal Tab Architecture
All visited pages stay **mounted** and are hidden/shown with CSS (`display: none`). No page is ever unmounted after first visit. This preserves all React state across navigation.

```typescript
// App.tsx — visited set pattern
const [visited, setVisited] = useState<Set<TabId>>(() => new Set([initialTab]));
const setTab = useCallback((t: TabId) => {
  setTabState(t);
  setVisited(v => v.has(t) ? v : new Set([...v, t])); // mount once, keep forever
  localStorage.setItem('vector_tab', t);
}, []);

// Render: flex-1 min-h-0 gives bounded height; hidden class hides inactive tabs
<div className={cn('flex-1 min-h-0', !isInbox && 'overflow-y-auto', !active && 'hidden')}>
```

**Why `flex-1 min-h-0` and not `h-full`:** `height: 100%` only resolves against an explicit parent height. `flex-1` inside a `flex-col` container gives a computed height, but `h-full` on a grandchild won't see it unless the intermediate elements also propagate height. Using `flex-1 min-h-0` on each tab wrapper (with `main` as `flex flex-col`) is reliable across all browsers.

---

### 6.9 EL Internal Info (EL Info tab) — added 2026-07-16
Aggregates the recurring internal update emails from `EATON_Emergency_Lighting_INTERNAL@Eaton.com` (this year, Inbox) into one AI hub. **Refresh** fetches + stores them in SQLite (`el_internal`), incremental. A consolidated **"current state" AI digest** (New / Discontinued / Stock / Technical, cached in `el_internal_meta`) and an **ask-AI chat** across all updates. Attachments open via `/api/outlook/attachment-view`.
Endpoints: `GET /api/el-internal/list`, `POST /api/el-internal/refresh|digest|chat`. Python: `outlook_reader.py --action emails-from --sender <substr> --since <date>` (Inbox, win32).

### 6.10 Ask Fenton (Fenton tab) — added 2026-07-16
Turns Mark Fenton's (`MarkAFenton@eaton.com`) answers — emails to `laithal-soub`/`UKQuoteFactoryEL`, past year — into a searchable AI knowledge base. **Refresh** fetches (via `emails-from` with the new `--recipient` filter) + AI-extracts each into a **Q&A card** (topic / question / answer / tags) in one batched Gemini call; cards stored in `fenton_kb`. Client-side search + **ask-AI chat** grounded on the cards. **Rebuild** re-extracts all.
Endpoints: `GET /api/fenton/list`, `POST /api/fenton/refresh|chat`.

### 6.11 Quick Quote (Inbox panel) — added 2026-07-16
Generates a quick UK **proposal PDF** (not Bidman) from an email. AI-detects the LoadStar/CBU system (`/api/quote/detect-cbu`), auto-pulls its BOM lines from the shared `src/lib/cbuData.ts` (extracted from `CBUCalculator.tsx`) minus relays, and pulls priced luminaires from the email (`/api/quote/luminaires` → `schematic_reader --mode list` on `extractMaterialHints` output, shared in `src/lib/elHints.ts`). All lines editable (list price), free-form **+ Add line**, then `/api/quote/generate` → `quote_export.py` (openpyxl → LibreOffice → pypdf-merge Commissioning + T&C) → download. Component: `src/pages/QuickQuote.tsx`.

### 6.8 LocalStorage Persistence
| Key | Value | Purpose |
|---|---|---|
| `vector_tab` | Tab ID string | Active tab on last close |
| `inbox_storeId` | Outlook store ID or `"default"` | Selected mailbox |
| `inbox_unreadOnly` | `"true"` / `"false"` | Unread filter state |
| `mu_el_runs` | JSON array | Last 20 EL Pricer run results |
| `el_corrections` | JSON object | User-corrected catalogue number mappings |
| `theme` | `"dark"` / `"light"` | UI theme |
| `mu_lang` | `"en"` / `"hu"` | Language |

---

## 7. Key Code Snippets

### 7.1 Express Server Bootstrap
```typescript
// server.ts — single async IIFE that starts everything
async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // sql.js database (persisted to eaton_automation.db)
  const SQL = await initSqlJs();
  let db = existsSync(DB_PATH)
    ? new SQL.Database(readFileSync(DB_PATH))
    : new SQL.Database();

  // All routes registered here...

  // Development: Vite dev server as middleware (HMR, instant reload)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    // Production: serve compiled dist/
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }

  app.listen(3000, '0.0.0.0');
}
```

### 7.2 Gemini AI Initialisation
```typescript
// server.ts — lazy Gemini client with key from config
function getGemini(): GoogleGenAI | null {
  const key = loadPyCfg().gemini_key || process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

// Usage example (email analysis)
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  config: { maxOutputTokens: 2048, temperature: 0.2 },
});
const text = response.text;
```

### 7.3 Robust JSON Array Extraction
Gemini sometimes wraps JSON in markdown fences or adds trailing text. This parser handles all cases:
```typescript
// server.ts — `firstJsonArray()`, used for Fenton card extraction + other AI responses
function extractArray(text: string): any[] | null {
  // 1. Strip markdown fences, try full parse
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { const p = JSON.parse(stripped); if (Array.isArray(p)) return p; } catch {}

  // 2. Find first '[' and walk to its matching ']' (handles trailing text after array)
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)             { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
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
```

### 7.4 Gemini 502 Retry Logic
```typescript
// server.ts — pattern for AI endpoints (transient 5xx from Gemini)
let lastErr = '';
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const response = await ai.models.generateContent({ ... });
    // ... process and return
    return;
  } catch (e: any) {
    lastErr = e.message;
    const is5xx = /5\d\d/.test(e.message) || e.message.includes('Bad Gateway');
    if (!is5xx || attempt === 3) break;
    await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s
  }
}
res.json({ error: 'Gemini error: ' + lastErr });
```

### 7.5 Python Spawning Pattern
All Python scripts run as child processes. Arguments are passed via files (not command line) to avoid length limits:
```typescript
// server.ts — spawn Python with pyArgs() helper
function pyArgs(script: string): [string, string[]] {
  // Returns ['python', [script]] or ['python3', [script]] depending on platform
  return [process.platform === 'win32' ? 'python' : 'python3', [script]];
}

const [py, base] = pyArgs(pyScript);
const proc = spawn(py, [...base, '--mode', 'list', '--input', tmpFile]);
let out = '', err = '';
proc.stdout.on('data', d => { out += d.toString(); });
proc.stderr.on('data', d => { err += d.toString(); });
proc.on('close', () => {
  try { res.json(JSON.parse(out.trim())); }
  catch { res.json({ error: err || out }); }
});
```

### 7.6 SSE Streaming (Step 1 / Step 2)
```typescript
// server.ts — streams Python output line-by-line to browser
app.get('/api/run/step1', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const proc = spawn(py, [script, '--pdf', pdfPath]);
  proc.stdout.on('data', d => {
    d.toString().split('\n').forEach((line: string) => {
      if (line.trim()) res.write(`data: ${JSON.stringify(line)}\n\n`);
    });
  });
  proc.on('close', code => {
    res.write(`data: __DONE__:${code === 0}\n\n`);
    res.end();
  });
});
```

### 7.7 i-P65 Catalogue Number Normalisation (Python)
```python
# schematic_reader.py — handles "i-P65 O CG-S" → tries IP65OCGS etc.
if re.match(r'^i[-\s]*p65', cat_no, re.I):
    stripped  = re.sub(r'^i[-\s]*', '', cat_no.strip(), flags=re.I)
    clean     = re.sub(r'[\s\-/\.]+', '', stripped.upper())   # P65OCGS
    full_key  = re.sub(r'[\s\-/\.]+', '', cat_no.upper())     # IP65OCGS
    candidates = {clean, full_key,
                  'IP65' + clean[3:] if clean.startswith('P65') else clean,
                  clean.replace('O', '0'), clean.replace('0', 'O'),
                  full_key.replace('O', '0'), full_key.replace('0', 'O')}
    for cand in candidates:
        if cand in lookup:
            return lookup[cand], 'fuzzy'
```

### 7.8 Outlook Email Reading (Python)
```python
# outlook_reader.py — reads emails via COM
import win32com.client

def get_emails(store_id='default', limit=30, unread_only=False):
    outlook = win32com.client.Dispatch('Outlook.Application')
    ns = outlook.GetNamespace('MAPI')

    if store_id == 'default':
        inbox = ns.GetDefaultFolder(6)  # olFolderInbox = 6
    else:
        store = next((s for s in ns.Stores if s.StoreID == store_id), None)
        inbox = store.GetRootFolder().Folders['Inbox']

    messages = inbox.Items
    messages.Sort('[ReceivedTime]', True)  # newest first

    results = []
    for msg in messages:
        if unread_only and not msg.UnRead: continue
        results.append({
            'entryId': msg.EntryID,
            'subject': msg.Subject,
            'sender': msg.SenderName,
            'senderEmail': msg.SenderEmailAddress,
            'received': msg.ReceivedTime.isoformat(),
            'bodyPreview': msg.Body[:200],
            'unread': msg.UnRead,
        })
        if len(results) >= limit: break
    return results
```

---

## 8. API Reference

All endpoints are on `http://localhost:3000`.

### Connection & Session
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/connection` | Returns `{ connected, name, email }` |
| GET | `/api/session` | Returns `{ startedAt }` |
| GET | `/api/run/connect` | Runs `refresh_cookies.py`, returns captured-session result |
| GET | `/api/config` | Read current `config.json` |
| POST | `/api/config` | Save `config.json` |

### PDF Workflow
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/pdfs` | List queued PDFs |
| POST | `/api/pdfs/upload` | Upload a PDF (binary body) |
| DELETE | `/api/pdfs/:name` | Remove a PDF from queue |
| GET | `/api/run/step1` | SSE stream — process one PDF |
| GET | `/api/run/step2` | SSE stream — fill QuotationFactory entry |

### Outlook / Inbox
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/outlook/status` | Check Outlook + pywin32 available |
| GET | `/api/outlook/mailboxes` | List personal + shared mailboxes |
| GET | `/api/outlook/emails` | List emails (`?storeId=&limit=&unread=`) |
| GET | `/api/outlook/email/:id` | Get full email with body + attachments |
| GET | `/api/outlook/search` | Search the quote folders via the local index, live MAPI/DASL fallback (`?q=&limit=&fields=all\|meta&source=auto\|index\|live`) |
| GET | `/api/outlook/index/status` | Local mail index: rows, per-folder state, last sync |
| POST | `/api/outlook/index/sync` | Re-read the scoped folders into the index (`{full:true}` rebuilds) |
| GET | `/api/outlook/summary/:entryId` | Load persisted summary (no AI spend) |
| POST | `/api/outlook/summarize` | AI summary + vision over inline/opted-in images; persists |
| POST | `/api/outlook/draft-reply` | AI draft reply |
| POST | `/api/outlook/send-reply` | Send reply via Outlook COM |
| POST | `/api/outlook/save-attachment` | Save PDF attachments to queue |
| POST | `/api/outlook/feedback` | Save summary/reply feedback to DB |
| POST | `/api/outlook/chat` | Inline chat about an email (+ image context) |
| GET | `/api/outlook/attachment-view/:id/:index` | Stream an attachment inline (image/PDF; used for cid: body images) |

### EL Internal Info / Ask Fenton / Quick Quote
| Method | Endpoint | Description |
|---|---|---|
| GET/POST | `/api/el-internal/list` · `/refresh` · `/digest` · `/chat` | EL Info tab |
| GET/POST | `/api/fenton/list` · `/refresh` · `/chat` | Ask Fenton tab |
| POST | `/api/quote/detect-cbu` · `/luminaires` · `/generate` | Quick Quote (+ `GET /api/download/quote/:id`) |

### EL Material Pricer
| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/schematics/price` | `text/plain` | Price a text material list |
| POST | `/api/schematics/price` | `multipart/form-data` with `pdf` field | Extract + price a PDF schematic |
| POST | `/api/schematics/price` | `multipart/form-data` with `image` field | Extract + price an image |

### Analytics & History
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/stats` | Dashboard stats (queue count, totals) |
| GET | `/api/jobs` | Recent job history |
| GET | `/api/analytics?days=30` | Quote volume over time |
| GET | `/api/archive` | Last 5 archive days |

### AI Assistant
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ai/status` | Check if AI is available |
| POST | `/api/ai` | Ask Gemini a question (with optional history) |
| GET | `/api/search?q=` | Search SharePoint QuotationFactory |

---

## 9. Python Scripts

### `outlook_reader.py`
COM automation for Outlook. Called by all `/api/outlook/*` endpoints. Uses `win32com.client.Dispatch('Outlook.Application')`. Outlook must be open and logged in. Requires `pywin32`.

### `schematic_reader.py`
EL Material Pricer engine. Three modes:
- `--mode list --input <file>` — parse and price a plain-text material list
- `--mode pdf --input <file>` — Gemini vision extracts items from PDF, then prices
- `--mode image --input <file>` — Gemini vision extracts items from image, then prices

Price matching logic (in order):
1. Exact catalogue number match
2. Without hyphens/spaces (`MP2-ES-230-CGS` → `MP2ES230CGS`)
3. i-P65 specific normalisation (multiple variant candidates)
4. Prefix match (up to 4 extra chars in price list key)
5. Suffix match (up to 4 missing leading chars)
6. Substring match (catalogue number within extracted text)
7. 0 ↔ O swap (common OCR misread)
8. Description/family keyword fallback (with i-P65 family boost)
9. Second-pass: Gemini with Google Search for still-unmatched items

Output includes `match_type: 'exact' | 'fuzzy' | 'description'` per item.

### `refresh_cookies.py`
Captures SharePoint session cookies from the running Edge browser (CDP on port 9222). Stores `FedAuth` / `rtFa` cookies. Called by "Connect to JOE" (`/api/run/connect`).

### `pdf_to_csv.py`
Step 1a — the extraction pipeline. Converts Word/Excel to PDF (LibreOffice), detects language, runs Azure Document Intelligence if configured, otherwise falls back to local/language-specific extractors. Produces the CSV consumed by the upload step.

**Salesforce id recovery (UK).** The id is written three different ways and the label patterns are not enough on their own:

- `006QO00000x2HCUYA2` — the full 18-char form SharePoint stores;
- `CR00x2HCUYA2` / `SR00…` / `EU00…` — short form, in BidManager exports and file names;
- `00yduKjYAI`, `00zc0jpYAA` — bare tail, inside project references and quotation names. The last 3 chars are Salesforce's checksum, drawn from `[A-Z0-5]` — **do not** assume it always reads `YAx`, that is only how the ids seen so far happen to look. `_is_sfid_tail()` instead requires mixed case, which is what actually separates an id from a date or order number.

`canonical_sfid()` expands all three to 18 chars and **rejects anything else**, so a customer name after `Project Reference:` ("Eversheds", "RAF", "Wanlip") can no longer land in the SALESFORCE ID column and get dropped downstream. `find_sfid()` then searches page 1, the quotation name, and the file name in that order.

**REQUESTED FROM comes from the mailbox, not the PDF.** No quotation format carries it — a UK quote's page 1 names the *inside sales* contact ("Contact Person: Laith AL-Soub") and the shared mailbox, and `SALESMAN_MAP` only covers 4 people. `find_requester()` therefore searches `mail_index.db` (path via `MAGIC_MAIL_INDEX`, set by `/api/run/step1`) for the SF-id tail, then the quotation code, then the name, and takes the **earliest** `@eaton.com` sender on that thread, skipping the shared accounts in `_SHARED_MAILBOXES` (`ukquotefactoryel@`, `ukcommorders@`, …) which forward requests but do not make them. The index stores senders as `Lastname, Firstname`, which is exactly what the people-picker resolves against. Runs for every language, and is a no-op when the index is absent (ship builds).

`parse_bidmanager_bom()` reads the **"Detail Bill of Material"** layout, which shares no labels with a normal UK quotation — id and name come off the `Project Name:` line (folding in the wrapped continuation line), the code from `Negotiation No` + `Alternate No`. `parse_quote_filename()` is the last-resort fallback; note that `\b` never fires on Eaton's underscore-joined file names, so its patterns use explicit alphanumeric lookarounds.

### `Automation_V4.py`
Step 1b — uploads the extracted quote to the SharePoint QuotationFactory list. Holds the SharePoint cookies (FED_AUTH / RT_FA) that Step 2 also reads.

**Pre-upload check (`--check`)** — emits `__CONFLICTS__:<json>`, one entry per CSV row that needs a decision, keyed by **row index** (not by Salesforce id, which a BidManager quote does not have). Three kinds:

| kind | meaning | default action |
|---|---|---|
| `duplicate` | already in the list, or twice in this batch | `replace` (`add` for a name-only match, `skip` for a batch twin) |
| `blank` | no id, no code, no name — extraction failed | `skip` |
| `incomplete` | uploadable but missing SALESFORCE ID / REQUESTED FROM | `add` |

Duplicates are matched in order: Salesforce id (every stored spelling — expanded `006QO00000…`, short `CR00…`/`SR00…`/`EU00…`/`QR00…`, and `startswith` for the `-A1R` revision suffixes) → quotation code (`Title`, the only identity a BidManager quote has) → quotation name + customer.

**A quotation code is not unique.** `EU1L0806X6K1-0000` belongs to both the Eversheds and the HMP Standford hill quotes — different jobs, different Salesforce ids. `_match_by_code()` therefore drops any candidate whose id disagrees with the row's; without that guard the modal would offer "replace" against an unrelated row. Matching on the id alone missed most real duplicates: 69% of the list has no Salesforce id at all.

### `dq_store_upload.py`
Step 2 — creates the D&Q Store archive folder and uploads the PDF(s) to the SharePoint D&Q Store library. Uses the cookies from `Automation_V4.py`.

### `pmo_raise.py`
PMO module — fills a Word template from a Quote PDF + 1–20 DOCU_ID PDFs + a PO PDF. See `PROJECT_INSTRUCTIONS.md` for the DOCU extraction format and multi-DOCU matching logic.

### `cbu_export.py` / `parse_cbu.py`
CBU cable sizing — parsing and export.

### `commission_export.py`
Commission export. Builds a **one-page, customer-facing** price sheet with reportlab — the tier maths is duplicated from `src/pages/Commission.tsx`, so a rate change has to be made in both. It deliberately does **not** convert `docs/commission_calculators.xlsx` to PDF: that sheet holds every tier, the day rate, the cover uplift and margin scratch cells side by side, so the old LibreOffice conversion shipped 5 pages of internals to the customer.

### `xlsx_extractor.py`
Italian-format xlsx quote extractor, used as a fallback branch by the extraction pipeline.

### `overlay/outlook_overlay.py`
Outlook overlay tracker. Polls the server (~every 2s) to track which email is in focus. Launched via `overlay/start-overlay.bat`; state in `overlay/overlay_state.json`.

---

## 10. Database

File: **`eaton_automation.db`** (SQLite, in project root)

Tables:

### `jobs`
Records every processed quote.
```sql
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL,
  step         TEXT NOT NULL,          -- 'step1' | 'step2'
  pdfName      TEXT,
  sfId         TEXT,                   -- SR00 ticket number
  status       TEXT NOT NULL,          -- 'ok' | 'error' | 'skip'
  items        INTEGER DEFAULT 0,
  note         TEXT,
  product      TEXT,                   -- 'EL' | 'PDC' | 'ICP' etc.
  customer     TEXT,
  price        REAL,
  salesman     TEXT,
  durationSec  INTEGER
);
```

### `email_feedback`
Records user feedback on AI email analysis and replies.
```sql
CREATE TABLE email_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL,
  entryId      TEXT NOT NULL,          -- Outlook entry ID
  subject      TEXT,
  senderEmail  TEXT,
  draftReply   TEXT,
  finalReply   TEXT,
  feedbackType TEXT                    -- 'sent' | 'edited_sent' | 'liked_analysis' | 'disliked_analysis'
);
```

### Feature tables (added 2026-07-16)
| Table | Purpose |
|---|---|
| `email_summaries` | Persisted Inbox AI summary per email (entryId PK, summary, includedIndices, ts) |
| `el_internal` / `el_internal_meta` | EL Info stored updates + cached digest |
| `fenton_kb` / `fenton_meta` | Ask Fenton stored emails + extracted Q&A cards |

The database is saved to disk every time it's written (sql.js writes the whole file). Loaded on server start. Persists across restarts.

---

## 11. Version History

### v2.0 — Current (May 2026)
- **App renamed** to Vector with V logo
- **Splash screen** — standalone "Connect to JOE" screen on launch
- **Internal tab architecture** — all visited pages stay mounted; no state loss on navigation
- **Inbox feature** — full Outlook integration: read, Summarize (vision + inline chat, persisted), draft reply, send
- **EL Info / Ask Fenton / Quick Quote** — see §6.9–6.11 (added 2026-07-16; Summarize replaced the old Analyze/Chat/Briefing)
- **Inline EL Pricer** — EL Pricer appears inside email detail when detected
- **i-P65 normaliser** — handles OCR variants like "i-P65 O CG-S" → correct catalogue number
- **Match confidence** — `⋯` feedback menu on fuzzy/description matches in EL Pricer
- **Copy email fix** — only NTP/Unit in copied schedule (no line totals or grand total)
- **Email header redesign** — Subject prominent, metadata row compact
- **Gemini 502 retry** — up to 3 retries with backoff on transient errors
- **localStorage persistence** — active tab, mailbox, unread filter all persist
- **File cleanup** — 22 dead/duplicate files moved to `old-version/`

### v1.x — Legacy (2024–early 2026)
- Original MagicUploader name
- Basic PDF upload to SharePoint
- SharePoint search
- Step 1 / Step 2 quote processing
- EL Material Pricer (PDF + list modes)
- AI assistant (Gemini)

---

## 12. Next Updates

Planned improvements in rough priority order:

### High Priority
- [ ] **Outlook unread badge** — show count in sidebar Inbox nav item
- [ ] **EL Pricer — save to project** — link a priced schedule to a specific SR00 ticket
- [ ] **Briefing persistence** — remember last briefing result so it survives tab switches
- [ ] **Gemini streaming** — stream AI analysis token-by-token instead of waiting for full response
- [ ] **i-P65 manual override** — if AI still gets it wrong, allow user to fix the extracted text before pricing

### Medium Priority
- [ ] **Email auto-detect EL items** — smarter regex to pre-populate inline EL Pricer from email body
- [ ] **PMO automation** — complete the PMO tab workflow (document generation)
- [ ] **Docs tab** — document pack generation from templates
- [ ] **Price list auto-update** — detect new price list versions (currently hardcoded July 2026)
- [ ] **Dark mode polish** — a few components still have minor dark mode issues

### Low Priority
- [ ] **Multi-language** — Hungarian UI currently incomplete
- [ ] **Keyboard shortcuts** — ⌘K for AI assistant already works; add more
- [ ] **CBU calculator** — complete cable sizing calculations
- [ ] **Export analytics** — download job history as Excel

---

## 13. Troubleshooting & Help

### App won't start
1. Check port 3000 is free: `netstat -ano | findstr :3000`
2. Kill any existing Node: `taskkill /F /IM node.exe`
3. Re-run: `npx tsx server.ts` in the project folder and read the terminal output

### "Outlook not available"
- Make sure Outlook desktop app is **open and logged in**
- Run `pip install pywin32` then `python -m pywin32_postinstall -install`
- Restart Outlook after installing pywin32

### "Connect to JOE" fails
- Edge must be open with the Eaton SharePoint page loaded
- Must be on Eaton network or VPN
- Check `vector.log` in the project folder for detailed errors
- Edge must have launched with `--remote-debugging-port=9222` (start-app.ps1 does this)

### Gemini API errors
- Check the Gemini key in Settings — get a new one from [aistudio.google.com](https://aistudio.google.com)
- 502/503 errors are transient — the briefing endpoint retries 3 times automatically
- If `maxOutputTokens` errors appear, the prompt may be too long (too many emails in briefing)

### EL Pricer — item not found
- Check the catalogue number format against the price list (the July 2026 Excel file)
- Use the `⋯` menu on any row to enter the correct catalogue number — it saves for future use
- Items matched by description show their original input in amber — verify the match is correct
- For i-P65 items: try entering as `IP65OCGS` or `I-P65-O-CG-S` manually

### Email scroll / layout issues
- Hard-refresh the app: `Ctrl+Shift+R` in Edge
- If the Inbox pane is stuck, switch to another tab and back — tab keeps its state

### Database reset
```powershell
Remove-Item "C:\Users\E0740516\Desktop\VECTOR\VECTOR\eaton_automation.db"
# Restart server — DB is recreated automatically
```

### Logs
| File | Contents |
|---|---|
| `vector.log` | All server stdout (from `start-app.ps1`) |
| `vector-err.log` | Server stderr |
| `server.err` | Server error output when started manually |
| `startup-debug.log` | Launcher/startup diagnostics |
| Browser console | React/client errors (F12 → Console) |

### Getting help
- All source code is in `server.ts` (backend) and `src/` (frontend)
- Most logic is commented at section level with `// ──` dividers
- The database can be inspected with any SQLite viewer (e.g. DB Browser for SQLite)
- For AI issues: check the raw Gemini response in `server.log` — look for `[briefing] raw response` or `[pdf] Gemini response`

---

*Document generated: May 2026 · Vector v2.0 · Eaton Corporation Budapest*
