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
| `cbu_scan_dirs` | Folders searched for CBU Tech Briefs and filled sizing calculators (§6.13). Omit for the default: `~/Downloads`, `~/Desktop`, `<base>/PDF Quotes` |

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
Full Outlook integration via COM automation. Email-detail action bar: **Summarize · Reply · Attach & Send · EL Pricer · CBU Sheet · Quick Quote**. Features:
- **Multi-mailbox** — personal inbox + shared mailboxes shown as tabs
- **15-minute cache** — emails cached client-side, auto-refresh
- **Summarize** (replaces the old Analyze + Chat + Briefing, 2026-07-16) — one panel: a structured AI summary (Summary / What's Requested / Type / Key Data / Next Steps) plus an inline follow-up chat, in the same panel. **Vision is opt-in** (2026-09-01): nothing visual is read unless it is ticked in the "Read images (off)" row — images used to be auto-included and quietly cost tokens on every summary. Ticking applies to both the summary and the chat; inline logos < 12 KB are hidden entirely. Summaries **persist** per email in SQLite (`email_summaries`), so reopening (even after restart) is instant and free; Refresh regenerates.
- **Reply** (reworked 2026-09-01) — the box opens **blank and stays blank**; nothing is generated until asked. **AI Draft** opens an assist box: write the raw idea in your own words → **Polish** turns it into a sendable email, then **Shorten / Formalize / Rewrite** chain off that result. The result is editable and only reaches the reply body via **Insert** (appends if you have already written something). *From email* still writes a draft from the email alone — also into the assist box, never straight into the reply. Feedback loop unchanged (sent/edited/liked/disliked saved to DB); draft-reply token budget raised 600 → 4096 because replies were being cut off mid-sentence.
- **Attach & Send** (reworked 2026-09-01) — suggests the quote PDF *and* who it goes to. Sender ≠ recipient in half the cases (a colleague forwards a customer's request), so the panel offers every address on the thread — sender, real To/Cc SMTP addresses, addresses written in the body — each labelled with where it came from, plus a roster autocomplete from `/api/todo/recipients`. **AI suggest** (`/api/outlook/suggest-send`) picks the recipient *from those candidates only* (it cannot invent an address) and writes a short covering note. Sending: To = the original sender → threaded reply, sent; anyone else → new mail with the files, **left in Outlook Drafts** with the composer open so a human presses Send.
- **Inline images render in the body** — `<img src="cid:…">` refs are rewritten to `/api/outlook/attachment-view/:entryId/:index` using each attachment's Content-ID (see `resolveCidImages` in Inbox.tsx).
- **Inline EL Pricer** — appears in the email detail; prices attached PDFs, **images and Excel/CSV** (Excel routed through a `--mode unified` manifest).
- **CBU Sheet size detection** (`extractCBUHints`, hardened 2026-09-01) — reads the **subject as well as the body** (plenty of enquiries put "20kVA CBU" only in the subject), understands **kVA / kW / VA / W** (kW→kVA at the sheet's own 0.95 PF, W at 950 W per kVA), strips thousands separators, skips numbers sitting next to *heat / dissipation / loss / consumption / standby / per luminaire*, and decides **phase per mention** from the ±90 characters around it (three-phase / 400 V / TPN vs single-phase / 230 V) instead of once for the whole email. Load-derived sizes only count when they land within 15 % of a real system; an explicit kVA figure is always trusted. The badge shows the **text it read** (`read 20kVA`) with the snapped system in the tooltip, so a wrong snap is visible before you generate.
- **CBU sheet data provenance** — `src/lib/cbuData.ts` is GENERATED by `automation/cbu_data_gen.py` from the LoadStar-PS sizing calculator; never hand-edit it. Now on **V3.6** (`OneDrive - Eaton\Copy of UK CSO - LoadStar-PS Sizing Calculator V3.6.xlsm`, 2026-09-01) — regenerating against it produced a **byte-identical** DATA block. V3.6's only data change was correcting the `Tables` ext-battery quantities for 3PH-12KVA (2→3) and 3PH-24KVA (4→6) plus their ventilation rates, i.e. the sheet catching up to what the app already had, because the generator reads quantities from *Pricing Analysis for CSO* (the table the sheet's own quote page XLOOKUPs). Still wrong in V3.6 and still patched in the generator: 1PH-12KVA carries 1PH-10KVA's `2x40A` fuses / `2x 10mm²` cables despite being a 3-cabinet build. If the workbook is open in Excel it is locked exclusively — take a copy through Excel COM (`wb.SaveCopyAs`) before running the generator.
- **⚠ There are TWO CBU data paths, and updating one does not update the other.** `src/lib/cbuData.ts` feeds the on-screen CBU tab and Quick Quote. The **printed Tech Brief PDF** does not read it at all: `automation/cbu_export.py` fills the bundled workbook `automation/cbu_calculator.xlsm`, hides every sheet but `CBU Tech Brief` and lets LibreOffice recalc the XLOOKUPs. That bundled copy sat at **V3.4**, which is why the brief kept printing **2** external battery cabinets for 3PH-12KVA (and 4 for 3PH-24KVA) after the app already had 3 and 6. Replaced with V3.6 on 2026-09-01 → brief now prints 3 / 6 with ventilation 12.096/1.512 and 24.192/3.024. When a new calculator lands, refresh **both**. (`cbu_calculator.xlsm` is on the `prepare-ship.mjs` exclude list, so there is no ship-staging copy to update.)
- **Sheet errors are corrected in code, not in the bundled workbook** — `patch_sheet_errors()` in `cbu_export.py` rewrites the 1PH-12KVA supply row (`2x40A`→`3x40A` fuses, `2x 10mm²`→`3x 10mm²` cables) before rendering, mirroring the same correction `cbu_data_gen.py` applies to `cbuData.ts`; without it the brief printed 2x figures next to its own "3 control cabinets" line. It only rewrites cells still holding the stale value, so it becomes a no-op once the sheet is fixed upstream. Keeping the template a pristine copy of the official workbook means the next revision is a straight file swap.
- **Quick Quote** — see §6.9.
- **PDF Queue** — one-click to queue PDF attachments from SR00 emails
- **Quote-folder search** (added 2026-08-12) — the list-pane search box has two layers. Typing filters the emails already loaded (instant). **Enter** (or the globe button) searches the quote folders: subject, sender, To/CC, **body** and **attachment filenames**. Matched terms are highlighted in the rows, each hit shows the folder it lives in, Esc / "Back to list" returns to the normal view.
  - **Scope is a hard allowlist** — `SEARCH_SCOPE` in `outlook_reader.py`: the `UKQuoteFactoryEL` store, root folders `Inbox` (48 items) and `Completed by Laith` (2 052). Everything else is deliberately out: the personal mailbox, `email drop` (a dump that duplicates Inbox mail), Deleted Items, Public Folders. Matching is on the store's display name + root-level folder name, so the identically named "Completed by Laith" under the personal store's Deleted Items is never picked up.
  - **Filters** (added 2026-08-27) — narrowing that runs *alongside* the terms instead of inside them, in a collapsible panel behind the sliders button (the count on the button is how many are set; each shows as a removable pill when the panel is shut). A filter is a question on its own, so a filtered search runs with an **empty box** ("everything from Fenton with a PDF this month"). None of them persist across sessions — a stale date filter silently answering a different question was the thing to avoid — while the match mode still does.
    - **Match** — Part / Word / Start, as before, moved out of the search row.
    - **In** (`scope=`) — which text the terms match: Everything, Not body, Subject, From, To/CC, Files, Body. `all`/`meta` are the old `fields=all|meta` under a finer name; the rest narrow to one column. On the live path DASL cannot express "subject only", so the hits it returns are re-checked against that field alone — live and index answer the same question.
    - **From** (`from=`) — substring of sender name or address, with a datalist of the senders the index has actually seen (`GET /api/outlook/search/facets`, one `GROUP BY` over `mail`).
    - **When** (`since=` / `until=`, `YYYY-MM-DD`) — presets (7 days … 12 months) or a custom range. Presets are stored as the preset, not as dates, so "30 days" still means 30 days tomorrow. Compared against the index's `stamp` (`YYYYMMDDHHMMSS`), end of range inclusive.
    - **Folder** (`folder=`) — Inbox / Completed / both, a substring of the stored folder path.
    - **Files** (`att=`) — has files / has a PDF / none, off `atts` and `has_pdf`.
    - **State** (`read=`) — unread / read, and **Sort** (`sort=new|old`).
    - The **loaded-list** filter applies the same rules client-side (`passesFilters` / `scopeHaystack` in Inbox.tsx), minus Folder, which only a search hit knows. So switching to "Subject" or "Unread" narrows the list already on screen, not just the next search.
  - **Local index** — those messages are mirrored into `DATA_DIR/mail_index.db` (SQLite, gitignored via `*.db`). A search is then a millisecond `LIKE` over `blob` (subject + sender + recipients + attachment names + first 40 KB of body); `fields=meta` searches `meta_blob` only. Attachment-name search is free, because the names are in the blob.
  - **Why an index**: reading one message through Outlook COM costs ~64 ms, so a live sweep re-reads minutes of mail per query. First build ≈ 2–4 min; incremental syncs walk off the end of the new mail in seconds. Indexing uses `att_info_light()` — the Content-ID probe in `att_info()` is a MAPI round trip per attachment (~5 per quote mail) and dominated the build until it was dropped; cid: resolution only matters when an email is opened, which re-fetches it live anyway.
  - **Sync**: `folder_state.complete` marks a folder that has been read to its oldest message; only then may an incremental run stop at a stretch of already-known mail (otherwise the known part is just the newest slice of a half-built index). Pruning deleted/moved mail happens **only on a full run**, which is the only one that saw every message. Server syncs 20 s after boot, then every 10 min, and after any search that had to answer live.
  - **Live fallback** (`source=live`, or `auto` with a cold index) still walks the same two folders through `Items.Restrict` + DASL — MAPI, **not** the Windows Search index, which is stale on this machine and is why Classic Outlook's own search misses mail that is plainly there. Time-budgeted; partial results come back with `truncated: true`.
  - Endpoints: `GET /api/outlook/search?q=&limit=&scope=&mode=&from=&since=&until=&folder=&att=&read=&sort=&source=auto|index|live` (`fields=all|meta` still accepted), `GET /api/outlook/search/facets`, `GET /api/outlook/index/status`, `POST /api/outlook/index/sync {full}`. Python: `--action search|search-facets|index|index-status --dest <db>`, with `--scope --sender --since --until --folder --att --read --sort` mirroring the query params. The filter SQL lives twice on purpose — `filterClauses()` in server.ts (node:sqlite, the fast path) and `index_where()` in outlook_reader.py (the CLI / older-runtime path); change one, change the other.
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

### 6.13 Past quotes (CBU Sizer → Past quotes) — added 2026-09-10
The CBU tab is three views over one shared system selection (`src/pages/CBU.tsx`, remembered in `localStorage.cbu_view`): **Sizer** configures a system and exports the Tech Brief, **Past quotes** answers which quote was done last at that size, **Modules** prices the inverter modules that ship as-is (§6.14). They were one page at first — a lookup panel under the sizer — which put a second system selector beside the sizer's own and buried the lookup under the data sheet. `Open in sizer` carries the chosen size across.

The exported brief is named `CBU_Tech_Brief_<quote reference>_<system>.pdf`, built server-side and sent in the `Content-Disposition` header as well as set on the download link — the header used to be a hardcoded `CBU_Tech_Brief.pdf`, and in the desktop app the header is what names the file, so the reference and its revision (`A1R`) were lost there entirely. The system is in the name because one opportunity is often quoted at two sizes: without it both exports collide, which is why Downloads holds `…IuXi5YAF-A2R (1).pdf` and `…00xUfRxYAK (10KVA-1PH).pdf` — a browser de-duplication and a hand-typed rename of the same problem.

Pick a system size, get the past LoadStar-PS quote number to copy in Bidman. A repeat CBU enquiry is nearly always the last quote of that size with a different project name on it, and **nothing in the desk records a system size against a quote number** — searching Ask Vector for "10kva-1ph" returns nothing because no mail subject, CRM row or D&Q folder name carries the size. It exists only inside the artefacts the sizer produced.

`automation/cbu_ref_scan.py --job … --out …` reads exactly those two artefacts, and nothing else:
* the **Tech Brief PDF** the CBU tab exports — a labelled page carrying `System size (KVA)`, `Phase's`, `Quote reference`, `Project Title`. A multi-system export is those pages concatenated, so one file legitimately yields several sizes;
* a filled **LoadStar-PS sizing calculator** (`.xlsm`/`.xlsx`), reading `'Sales Engineer Sheet'!B5/C17/C18` — the cells `cbu_export.py` writes.

PMO CBU documents are **DualGuard-S**, not LoadStar, and carry no size; they are ignored. Mail bodies are not used as a source either — a thread offering five options lists five kVA figures with no way to tell which was quoted.

Two passes. **files** walks `cbu_scan_dirs` (default `~/Downloads`, `~/Desktop`, `data/PDF Quotes`) two levels deep, offline. **mail** is opt-in ("Outlook too"): the local mirror picks only the messages whose attachment names look like a brief or a calculator, then those few are opened through COM and the real attachment parsed — `MAGIC_MAIL_INDEX` must be passed or `outlook_reader` looks for a mail index that is not there.

Two things the parser has to get right, both learned from real files. A brief field left blank prints the *next label* on the value line, so every read is rejected if it lands on another label — otherwise the blank template reports its project title as "Quote reference". And reference and project get typed into each other's box often enough that the one which reads as a Salesforce or BidManager id is taken as the reference; whatever is left keeps `confidence: 'weak'` and is badged **unverified** in the tab, which is what the practice exports ("sds", "wewwe") in Downloads become.

The system is chosen from a grouped dropdown (Single / Three phase) that carries a quote count per rating, so an unquoted size reads as — rather than needing a click to find out. A search box beside it cuts across every size at once, on quote number or project name, for when the project is what is remembered and not the rating.

Rows live in `cbu_ref` (unique on `system` + `quoteRef COLLATE NOCASE`). A rescan never clobbers curation: the pin, the note and the hidden flag survive, and blank fields are only filled in. **Pin** is one per size — "pick one, keep it as a resource" is a choice, not a shortlist. **Remove** hides rather than deletes, because a real delete would let the next scan bring the same junk straight back. Sizes with nothing behind them are still shown, greyed: "I have never quoted a 54KVA" is a useful answer, and the chip is where a manual entry goes.

Endpoints: `GET /api/cbu/refs`, `POST /api/cbu/refs` (add/correct by hand) · `/scan` · `/:id/pin` · `/:id/reveal`, `DELETE /api/cbu/refs/:id`. Components: `src/components/CbuRefQuotes.tsx` and `src/CBUCalculator.tsx`, both under `src/pages/CBU.tsx`; the portal dropdown they share is `src/components/Dropdown.tsx`. Locked in the ship build: `/api/cbu/refs` is 403'd in the sidecar and `cbu_ref_scan.py` is excluded from `ship-automation/`, matching the gated CBU tab.

### 6.14 Inverter modules (CBU Sizer → Modules) — added 2026-09-10
The LoadStar inverter modules that ship as-is: 1.25KVA standalone, and 2.5/4KVA master-and-slave pairs, each in a single- and three-phase variant. They are quoted on a part code and a price — there is no cabinet build, no battery sizing and no Tech Brief behind them — so they are their own view rather than entries in the sizer's system list.

Two things the tab has to say out loud. The prices are **Nett Trade**, which is *not* the basis the sizer works in (`cbuData.ts` is Sell Out at a 1.0 multiplier), and mixing the two on one quote line is the failure this guards against. And the list carries no three-phase *slave* code, so a three-phase parallel system needs checking before it is quoted.

Quantities are scratch — nothing is stored, the tab opens clean — and give line totals, a grand total and **Copy lines**, which emits the quantified rows tab-separated so they paste into Bidman or Excel as columns. The phase filter narrows the table but never the quote: a quantity typed under Single still counts while Three is showing, and the footer says how many lines are hidden rather than showing a total with no rows behind it.

Data: `src/lib/inverterModules.ts` — **hand-maintained**, unlike `cbuData.ts` which `cbu_data_gen.py` regenerates. A price-list reissue means retyping the figures and moving `MODULES_PRICED`, which the tab prints so a stale table is visible. Component: `src/components/CbuModules.tsx`.

### 6.12 LSD Pricing (LSD tab) — added 2026-08-26
Drop a CPQ **Export Line Items** transaction (`.csv` / `.xlsx` / `.xlsb`); the tab prices every line and writes a case folder holding the **transaction**, the **Approved Offer** (`.xlsx`) and the **Working File** — the master CPQ model itself, filled with the transaction and toggled, so the file shows how the feedback was produced.

**The rule — `requested`, the default** (Dalia, 2026-09-02). Pricing *to* the target E2E was pushing quotes far above the prior year: on W262217374E, holding 40% E2E took PV to 16.1% and Total RPI to 11.5%. So the target E2E no longer holds the price up, and neither does the 20% cap:
```
Add. Discount = Requested Discount
then, if the line still prices under the half-year RPI gate (H1 3.5% / H2 6%):
    unit net = customer PY average × (1 + rate)      (country average if the customer has none)
```
A line that lands **below** its target E2E is priced that way and flagged `needs approval` — the engine does not raise the price to hide it. On W262217374E that is **34.3% against a 40% target**, which Kiran has to agree to; PV drops to 6.0% and Total RPI to 1.8%. Note the gate is the analyst's own manual check (customer average × 1.06), *not* the algebraic solve below — the solve over-corrects because it also pays for the mix offset.

**2026-09-15 — Dalia's review of Khimji W262144615E** (recorded call; transcript in `LSD Pricing Doc\Recordings and Material`). Laith's decisions:
- **The gate is per line, on the customer.** Every line with a customer PY average prices at least `customer avg × (1 + rate)`, even when the ledger's Total RPI already clears the rate. The 2026-09-10 carve-out that let such a line pass is removed: "the customer doesn't see the ledger, he sees his own reference" — sales' requested discount is often exactly last year's price, and a 0% line becomes the customer's argument for every other line.
- **5× lines keep the floor.** The model reads RPI as 0 over 5× the country PY quantity, but the customer can cut the quantity next revision, so `_rpi_gate` still applies × (1 + rate) and says so in the line's mode (MTL5561: 101.83 × 1.06 = 107.94).
- **`summary.rpi_working_level` = 6.8%.** Dalia's KPI is 6% as a yearly *average* and the approver's flat/4% exceptions pull it down, so a normal case is worked to ~6.8%. Shown on the Total RPI tile as headroom; the gate itself stays 6%.
- **Approved Offer keeps Total Net live** (`_live_totals`): Unit Net (K) stays a value, `L = K × E`, `L10 = SUM` — sales change quantities with the customer and a pasted total would not move. Read cells with `.Value2`: `.Value` returns a Decimal on currency-formatted cells.
- **Negative RPI never passes silently** (added 2026-09-16). A line priced under this customer's own last-year price is an `action` flag: on a **carried** line (revision or customer history — never gated) it says how far under and what last year + rate would be; on any other line it is a safety net. The "customer positive, total negative" mix flag now fires at `>=` the rate, since the gate lands lines at exactly 6% and the old strict `>` let them through unflagged. A line the gate raised says when the requested price read negative total RPI (Khimji CBG370S: −14.8%).
- **The master has TWO "Total RPI" formulas** (read off the V2 master 2026-09-16). The ledger's totals row `AF11 = AE11/(T11-AG11)` — Total RPI value over (Total Net − *RPI value*) — while a line's `AF13 = AE13/(T13-AE13)` and the summary pivot's calculated field `Total RPI % = 'Total RPI Value'/('Total Net Price'-'Total RPI Value')`. Vector follows each where it is shown: `summary.total_rpi` and `at_target.rpi_pct` use the AF11 basis (the number the analyst reads in the ledger), the per-group / Overall rows of the approval-mail table use the pivot basis, lines use AF13. The two case-level readings differ by a few hundredths of a point; do not "fix" one to the other.
- **Customer history on a new number.** Sales re-upload an old deal under a new transaction, so "nothing on file for this number" is not "never priced". When the revision search finds nothing, `/api/lsd/cpq-fetch` runs `onedrive_case.py` with `mode: "history"`: Dalia's daily sheet filtered on the customer (`lsd_queue.customer_rows`, Done rows included) → each of the newest 6 deals' latest approved offer downloaded into the case's `_history/` → the newest one pricing ≥ 60% of this BOM is staged as `meta.history_offer`. The build carries it exactly like a revision (`read_offer_prices`, which also checks the offer's header total against its own lines). "Don't carry" in the tab clears it. Khimji: found W262142622E R1 (25/25 materials, 110,662.08 total check) → 97,373.45 USD, Total RPI 7.4%, against 88,951 / 3.2% from the old run.

**The old rule — `e2e`** (LSD Daily Work Procedure, 2026-08-05; pass `"rule": "e2e"` in the job to get it back):
```
Add. Discount = MIN( Requested Discount , Add. Discount @Target E2E , 20% )
```
then any line with a prior-year *country* reference is pulled up to the half-year RPI floor, solved algebraically. Target E2E is a **floor**, not a value to match — a line whose cost outruns the standard price prices *above* it. Neither rule rounds anything (rounding was measured and it makes the match worse).

The `e2e` rule's RPI solve is **algebraic, not iterative**, because Mix Variance does not move with price. It mirrors ledger columns AB/AD/AE/AF exactly:
- only a country average → `S* = Y × (1 + rate)`
- customer **and** country → `S* = (W·QTY − AD) / ((1 − rate/(1+rate)) · QTY)`, `AD = (QTY − QFC)(W − Y)`
- `QTY ≥ 5 × PY country QTY` → the model forces RPI to 0; nothing can move it
- customer average but **no** country average → the model's AE errors to 0, so RPI reads 0 (flagged)

**Reference data** comes from the master `.xlsb`, from the same sheets the ledger's own XLOOKUPs use: `E2E Guidelines ` (I → N), `PV 2025 ` (J → H/F, customer&material), `MV Ledger 2025` (H → F/D, ledger&material), `Customer Master Data`. Note this master's MV ledger carries **R2321 (UAE) only** — a non-UAE customer gets the UAE ledger as its country base, and the run log says so.

**Which column carries the 55%** (measured 2026-09-07 over 208 archived exports, 2790 line rows). The default belongs to **`Customer Condition %` — the STANDARD discount — and to no other column**: it reads 55 on 1800 rows and blank on 903, while `Suggested Discount %` is 0 or blank on 2721 of them and is never read at all. So `std_pct is None -> 0.55` (procedure 5c) is applied to the right field. A **hard 0** in that column is left alone rather than defaulted — no real CPQ export has ever shown one, and defaulting an unseen case would be guessing at a price — but it is flagged *action*, because a literal 0 makes the standard price read the full list and the case then reports an additional discount nobody asked for.

`Requested Discount %` reading **0 is common — 898 of 2790 rows** — and it is treated as *absent*, never as a genuine 0% request. It never decides anything in practice: all 898 of those rows also carry a requested **price**, and the price always wins (`Net Fixed Amount` -> `Requested Price` -> `Net Price`, then `req_disc = 1 - price / unit_std`). No archived line has a zero requested discount and no price, so the `MIN(@target E2E, 20%)` fallback has yet to fire on real data.

**Customer exceptions to the RPI rate** (`RPI_EXCEPTIONS`, 2026-09-07). Some customers are not priced on the half-year rate at all. Khaled Al Saigh and the two KYR entities are FIRE stock customers holding an agreed **fixed price for the year**, and from **September** the increase under negotiation is **2.5%, not the H2 6%**, because the delivery invoices in January — and that 2.5% itself needs approving. It needs no new machinery: the RPI floor already prices at *prior-year average x (1 + rate)*, which is exactly "last year's agreed price plus the increase", so only the **rate** moves. Matched on the customer number first (`1213394`, `586252`, `1270464`), on the name only as a fallback (`al saigh`, `al sayegh`, `kyr` as whole words), and dated from the **transaction's own date** (`meta["as_of"]`, off the export filename) rather than the clock, so a June case re-run in September still prices as June. It is not a one-off — the same handful of big stock customers come up every year — so it is a standing dated rule rather than a manual override. A case priced on one says so in `summary.rpi_exception`, on the headline, in a warn banner on the tab, and on every raised line as an **action**.

**Where a list price comes from** (reworked 2026-09-04). The ledger is list-based end to end: `K = I × (1 − J)`, and with `I` blank the whole row collapses — `N` and `P` go `#DIV/0!`, `S`/`T` go 0, and the line contributes its full cost against zero revenue, which is what drags the overall E2E and Total RPI off a cliff. A CPQ export of a net-priced FIRE deal carries no list at all, so the list is resolved in this order and **the source is recorded on the line** (`list_src`, shown in the tab as *List from*) — only the first is the customer's own number:

| Order | Source | Note |
|---|---|---|
| 1 | the transaction's own `List Price` | `list_src: null` |
| 2 | `EL Trigger 26` / `Fire Trigger 26` by material | the current list; flagged *info* |
| 3 | an **identical Trigger entry** — same description, same cost to the cent | flagged *action* |
| 4 | `Guidance` by country&material (column H) | the **previous** list, ~6.6% under 2026 Q2; flagged *action* |

Route 3 exists because a **discontinued** material is still on the Trigger sheet but with `#VALUE!` in its List Price cell, while the material that replaced it sits on the same sheet with the same description and the same cost carrying the real price. It is keyed on the *Trigger sheet's own* description and cost, never the BOM's — CPQ spells the description differently (`FXN723 DET/OPT/A` against `Addressable Optical Smoke Sensor`) and rounds the cost. Validated against the analyst's own files: `400002FIRE-0005X` → 36.8225 and `400004FIRE-0007X` → 41.2824, giving unit nets of **13.2561** and **14.8617**, which is what she priced them at in the Starco, Dekheila and Hilton Ghana cases, to the cent.

**A hard `0` in the transaction's List Price column is treated exactly like a blank** (Dalia's decision, 2026-09-07). It is CPQ's price book failing to load, not a free line — it happens on 50 of 749 lines across the archived cases — so the line takes the model's own Trigger price. Because the material matched exactly, that is the price book being read rather than a substitution, so route 2 is flagged *info* and says which of the two cases it was; routes 3 and 4 stay *action*.

**The Trigger sheets' columns are read off the header row, never assumed** (`_trigger_cols`, 2026-09-07). The AUG 2026 V2 master re-cut `Fire Trigger 26` — `E`/`G`/`I` material/cost/list became `F`/`—`/`K` (`Price list`, effective 1st July 26, +2.5% on every one of the 1985 materials) with **no cost column at all** — and moved `EL Trigger 26`'s header up a row. Hard-coded indexes read `Range` as a price and priced nothing, silently. The block is found from the list column outwards: `list price…` wins over `price list…`, the material column is the last cell reading exactly `Material` to its left, and description and cost are taken from between the two, so another table's `COST MARCH 2026` cannot reach the cost slot. Two consequences: a discontinued Fire material now reads `Discontd.` instead of `#VALUE!` and can only be twinned on its **description**, which is accepted only when every priced row sharing it agrees on the price (43 of 375 resolve, 18 are ambiguous, 314 have no twin); and a FIRE line whose export carries no cost now has **no cost anywhere**, so it carries no E2E and is flagged for it.

`Guidance` is a fourth book nobody was reading: `A` country, `B` material, `C` country&material, `H` Price List, `I` Standard Price, `J` Add. Discount, `K` Unit Price — 34,120 rows. It is the sheet the ledger's own column **O** (Recommended Unit Selling Price) XLOOKUPs, which is why a material missing from it shows `#N/A` in **O** and **P**. That `#N/A` is the model's, not Vector's: it appears on 27 of 742 priced lines across 59 of the analyst's own working files.

**The Working File** is built by Excel COM (only Excel can write `.xlsb`, via `DispatchEx` — a **private** instance, because attaching to the analyst's own open Excel makes `Visible = False` fail outright). The transaction is pasted into `Paste BOM Here`, the header and APRC are set (`P6` 525 → EUR / `530-535` → USD; never touch `P5`), and SAP/QTY/List/STD/Cost are written as **values** per row — the procedure's own fix for the duplicate-material trap, where the ledger's XLOOKUPs hand every repeat of a material the first row's quantity. Every derived column stays a live formula. Flagged lines are highlighted in the ledger. **The Approved Offer** is the Feedback sheet copied out and then cleaned the way the analyst does it by hand: every formula flattened to a value (`_values_only` — PasteSpecial alone left the first data row carrying `='[1]Model Ledger '` **external links**, so the file asked the recipient to update links and read `#REF` once it moved), the stored link definition removed (`_drop_links`), the master's macro icon deleted, columns **F:J** (the price build-up) hidden and column **C** autofitted so the customer name is readable. The macro shape is identified by its **`OnAction`** (`…V2.xlsb'!WorkingFile` / `!OfferLetter`), never by name — and shapes must be stripped **before** breaking links, because `BreakLink` blanks that `OnAction` and the icon then looks like an ordinary picture. The same strip runs on the ledger `.xlsm` attachment, which is where the icon was actually shipping.

`1 − V11/T11` is read off the ledger's own totals and comes back on the build result as `approval` — note that once the decided discount is written, **T11 is the proposed price**, so that is the mail's `E2E% @ Proposed Price`, not its `E2E @ Target Price`. A **three-way total check** (ledger `T11` = Feedback `L10` = engine) runs before saving, and the Approved Offer is the Feedback sheet copied and pasted as values (both model macros are broken in V2).

**Accuracy, honestly:** the engine reproduces the documented procedure to the cent (MOPA W262168503E: 33/33 lines exact, 253,217.96, E2E 52.35%, Total RPI 16.04%). Against a *real* analyst approval it lands ~40% of lines exactly — the rest are per-line negotiated discounts and carried-forward prices that exist in neither the CSV nor the model. Those lines are the ones flagged REVIEW/VERIFY.

**Revisions** (added 2026-09-02). A revision of a transaction already priced keeps the **same case folder** and prefixes its files `R1`, `R2`, `R3` … — the analyst's own convention (her `W262089818E JANADRIYAH CULTURAL QUARTER` folder holds the original plus `R1`/`R2`/`R3`). Set `revision` on the job. Before pricing, `prior_prices()` reads the newest file in the folder whose name contains **`approved`** — Vector writes `R4 Approved Offer - Approved (W…).xlsx`, the analyst writes `R4 Approved <project>.xlsx`. Columns are located **by header, never by position**: Vector *hides* the price build-up so Unit Net Price stays in **K**, while the analyst *deletes* those columns, which slides the same field to **F**. Both label it, so the reader finds `SAP No` and `Unit Net Price` on the header row and works from there. Every material found is **held at that price** — a quantity change must not move a number the customer has already been quoted, so neither the target E2E nor the RPI gate is applied to it. Lines that are **new** on the revision fall through to the normal rule and are flagged `new on this revision`. `summary.carried` counts what was held.

**The revision check runs on every CPQ fetch** — it is the first question a transaction asks, not something the analyst should go and check by hand. `/api/lsd/cpq-fetch` follows the CPQ read with `onedrive_case.py`, which reports the revisions already on file (`R4` → `next: R5`, prefilled into the form) and downloads that revision's approved file into the case folder. Pricing then emits `revision_diff()`: **unchanged / quantity changed / new / removed**, per line, with the carried price shown against each quantity move. Only a **new** item can move the margin — a carried line's margin was signed off when it was set, so it is flagged `held from R4, already approved` and does **not** re-trigger the approval band (`summary.below_target` counts only lines priced on this revision).

**Pulling the previous revision** (`automation/onedrive_case.py`, added 2026-09-02). The version the customer actually holds lives in the **analyst's own OneDrive** (`eaton-my`), not in Vector's case root — a different auth realm, and Vector has no credentials for it. So it is read the way CPQ is: `Runtime.evaluate` through the **debug-rail Edge** (port 9222) against a signed-in `eaton-my` tab, running the SharePoint **search API** (`/_api/search/query`) in that page's context — her case folders are nested, so the index is the only thing that knows where a transaction lives. `list` reports every file and the revision numbers present (`R4` on file → `next_revision: R5`); with `out_dir` it downloads the newest `approved` file (fetched with `credentials:"include"`, returned base64 over CDP) into the case folder so `prior_prices` can carry from it. **Read-only** — it never writes into her drive.

**The approval mail** (`automation/lsd_approval_mail.py`, added 2026-09-02). A case under its target E2E is not repriced — it is mailed to the approver in Dalia's own layout, numbers taken from the priced result rather than retyped. It quotes **two stages, which are different numbers**:
- **Target Price** = what the *customer* asked for (the requested prices summed), with the E2E and RPI that price would land. The RPI here is usually **negative** — that is the reason for the ask. From `summary.at_target`.
- **the table** = the **proposed** price after the RPI gate lifted the lines, one row per pricing group plus an Overall row (`Add. Discount | Proposed Total Net Price | E2E% @ Proposed Price | Target E2E% | Total RPI % | Total RPI Value`). From `summary.groups`.

**The attachment is the ledger alone** — `Working file - <project>.xlsm`, written by every build beside the Working File. The Working File is the whole master model (~7 MB of reference sheets); the analyst strips it to the ledger before mailing, so `_export_ledger` copies that one sheet into its own workbook and pastes **values** over it (its XLOOKUPs point at sheets that are not coming along, and live formulas would arrive as `#REF`). 0.12 MB against 6.93 MB.

Reproduced Dalia's own W262217374E mail to the cent: target 40,211.00 / E2E 32.7% / RPI −0.6% / (227.00), Addressable 25.5% / 41,182.46 / 34.3% / 40% / 1.8% / 744.46. Recipients given as display names (`"Poulose, Kiran"`) are resolved against the **GAL**; defaults come from `lsd_approver` / `lsd_approver_cc` in Settings. In the tab it is the **Draft the approval mail** button, which appears in the case-folder card whenever `summary.below_target > 0`. `POST /api/lsd/approval-mail` forces `mode: 'draft'` whatever the client asks and only attaches paths inside the case root — Vector never sends this mail, it opens it.

**Reading the requested discount out of CPQ** (fixed 2026-09-04). The ledger's own `R13` is `XLOOKUP(B13, 'Paste BOM Here'!I:I, 'Paste BOM Here'!AE:AE)/100` — column **AE is `Requested Discount %`**, so *the master model itself* copies the requested discount into Add. Discount. (`Q`, Requested Discount, carries **no formula** in the master; it is a column the analyst fills, and Vector writes it.) The export column behind `AE` is `extraDiscount_l_c`, which CPQ derives from the net price against the standard price — so on a transaction whose **price book never loaded** (list price 0, no customer condition, no net fixed amount) it reads a hard **0** on every line while the discount the salesman actually typed sits in `discountOffList_l`. `cpq_fetch.py` now takes the first of the two that is non-zero. Where both are populated they agree to the rounding (W262217374E: 26.6/26.6, 27.82/27.83). Do **not** reach for `discountPercentNetRequested_l` — that is the discount off **list** (66.97% on the same line), not the additional discount.

Downstream, `_row_to_line` treats a literal `0` in Requested Discount % as **absent**, not as a 0% request. Reading it as a real request is what priced W262219747E at full standard price on every line. With nothing requested the `requested` rule has nothing to copy, so it falls through to `MIN(@target E2E, 20%)` and says so on every line.

**The first draft — the Working File "as pasted"** (added 2026-09-04). **Every build writes one**, beside the final file: `Working File (W…) - as pasted.xlsb`, the master with the transaction pasted and the header set and **nothing else** — no values written over the ledger's formulas, no decided discount. It is deliberately *not* corrected, so the duplicate-material trap is live and Add. Discount is whatever the model itself reads out of the export. Open it beside the built file when a number looks wrong: **what it shows is the model's, what differs is Vector's.** That question is asked of every case and cannot be answered after the fact from the built file alone, because every column in that one has been written over — which is why it is a default rather than an option (`"baseline": false` on the job, or clearing the tab's *Keep the first draft* checkbox, skips it; it costs a 7 MB copy and an Excel pass). On W262219747E it settles the question outright — every line reads `I=0, K=0, S=0, T=0`, `N` and `P` are `#DIV/0!`, and `R` is `0.4`, proving the DIV/0 is the model's response to an export with no prices and that the 40% request was never Vector's to lose.

**Fetch from CPQ** (added 2026-08-26): type a transaction number and the BOM + header (customer #, name, project, CRM ID) come straight from **Oracle CPQ's REST v19 API** — no manual Export Line Items. CPQ is Oracle SSO (a different realm from SharePoint/JOE), so `cpq_fetch.py` holds no CPQ credentials: it drives the CPQ tab already open in the **debug-rail Edge** (port 9222, the JOE rail) via CDP and runs the REST reads in that tab's page context. Two reads — `commerceDocumentsOraclecpqoTransaction?q={transactionNumber_t}` for the doc id, then its `transactionLine` child for the BOM — then it writes a CPQ-shaped `.xlsx` (values in the manual export's column positions) so the priced path is identical to a dropped file. Proven: W262168503E rebuilt from the API prices to 253,217.96 / 33 lines, zero line diffs. **Note:** CPQ's header customer is the sold-to; the analyst sometimes prices a different account CPQ doesn't carry (MOPA's approved used 74895, absent from CPQ), so the fetched customer is auto-filled, flagged, and editable.

**Daily register** (added 2026-08-26): every case that gets built also gets one row in a register workbook shaped like the analyst's own *LSD Daily work -2025 -2026.xlsx*, in her column order:

```
Country | BU | Transaction Number | Transaction Name | Customer Number | Customer Name |
Status | Sales Name | CPQ Last Updated | Total Value | Out Date | Notes |
RPI Comment | RPI Comment | PV% | RPI% | RPI Value
```

("RPI Comment" is duplicated in her sheet; both boxes are kept so the column count matches and a paste lines up. `PV%` is the price-variance-only ratio — ledger `K6`; `RPI%` is price + mix, the number the 6% gate is quoted against; `RPI Value` is the `AE` total in money. All three now come out of `price_lines`' summary as `overall_rpi` / `total_rpi` / `rpi_value`.)

`automation/lsd_register.py` owns the workbook (openpyxl, so no Excel needed) with three modes — `append`, `rows`, `upload`. **The existing header row wins**: values are matched to columns by header text, so pointing `lsd_register` at a copy of the real daily sheet writes into *her* columns without reshaping them; only a register created from scratch gets the layout above. An append is an **upsert keyed on Transaction Number** — rebuilding a transaction updates its row instead of adding a second, and a blank field on an update never wipes a cell someone filled by hand. Percentages are stored as real fractions with `0.0%` formats, dates as dates.

Auto-registration rides on the build (`runLsd`'s `onOk` is awaited before the response), so the tab learns in one round trip whether the row landed. A register that cannot be written — the workbook open in Excel — is a **warning on a successful build**, never a failed one; the tab offers **Register this one** to retry. BU is taken from `lsd_bu`, else guessed from the APRC toggle (`530-535` → FIRE); Sales Name from `lsd_sales_name`, else `inside_sales`; Notes default to line count / overall E2E / currency, because her sheet has no currency column.

**The register file never leaves the machine.** What goes to SharePoint is the *data*: **Upload to SharePoint** posts one **list item per transaction** into the same `Quotations List` on `sp_list` (`sites/QuotationFactoryEMEA`) that the quote uploader writes to, so an LSD transaction reads like every other quote in the factory list. Session JOE cookies, `_api/contextinfo` digest, then POST (or `MERGE` when a list item already carries that `Title`), so re-posting updates instead of duplicating.

Field mapping — `Title` ← Transaction Number, `QUOTATION NAME` ← Transaction Name, `CUSTOMER` ← Customer Name, `C360 ID` ← Customer Number, `PRICE` ← Total Value, `SALESFORCEID` ← the CRM id from CPQ (through `Automation_V4.normalize_sfid`; under 18 chars it goes to COMMENTS instead), `INSIDE SALES` ← Sales Name through the quote path's own `ensure_inside_sales_id` (creates the lookup entry when new). The four the list requires and an LSD transaction has no direct answer for:

| List column | Rule | Why |
|---|---|---|
| `DIVISION` | FIRE-only pricing groups → `FIRE`; anything carrying EL/luminaires → `EL & FIRE` | Laith's call. CBU/CBS has no mapping yet, so those rows are **skipped with a reason**, never guessed. BU is read from the lines' pricing groups (`lsdBu`), not the APRC toggle — APRC only says which currency the model is in. |
| `Country` | the list's own choice when the deal's country is one of them, else `EMEA`, with the real country in `COMMENTS` | The choice list is European; UAE/Saudi/Bahrain are not in it. |
| `REQUEST TYPE` | `lsd_request_type`, default `Standard CTO` | Required; what most existing W-number rows carry. Validated against the live choices before anything posts. |
| `ARRIVED ON` | the day it was priced, same as `PROCESSED ON` | The tab never sees a request-arrival date. |

`PRICE` is labelled [EUR] but takes the **raw deal total unconverted**, with the currency named in `COMMENTS` — deliberate, so nothing is silently rebased at an FX rate nobody sees. `COMMENTS` also carries PV%, RPI%, RPI value and the register's own notes.

CRM id and deal currency have no column in the analyst's sheet, so they ride in a sidecar `.lsd_register_meta.json` beside the register, keyed on transaction number — the workbook stays exactly her layout.

**The list validates on save, and a rejected item returns only "List data validation failed."** Three rules cost a failed post before they were read off the list itself (`$select=ValidationFormula` on the list and on its fields):
- **the date chain** — `ARRIVED ON <= ON-HOLD <= STARTING/RECOVERING`, and when STATUS is Processed, `STARTING/RECOVERING <= PROCESSED ON`. A blank middle date does **not** pass (blank reads as 1899), which is why the quote CSV carries all four. An LSD transaction has no hold or recovery, so all four are written as the same day and the chain holds on equality; when the status is not Processed, PROCESSED ON is left out entirely, as the same rule requires.
- **`C360 ID`** — blank, or `1-` plus 7 characters (`1-ZPFA533`). The SAP customer number is not a C360 id, so it goes to COMMENTS and the column stays blank unless the value really matches.
- **`SALESFORCE ID`** — blank or **exactly** 18 characters, not "at least".

`dry_run` renders every payload and posts nothing; it also resolves INSIDE SALES **without** creating a missing lookup entry (an early build did create one, which is precisely what a dry run must not do). Verified live 2026-08-26 against the real list.


**Keeping the work tabs alive** (added 2026-09-09): every LSD read — Fetch from CPQ, the revision lookup, the register upload — goes through a tab that is *already signed in* inside the debug-rail Edge, and those sessions expire while nobody is looking. So the first fetch of the morning used to fail with "no CPQ tab" or a login redirect until someone clicked the browser awake. `automation/tab_keepalive.py` now does that clicking: it starts the debug Edge if the port is down, makes sure every configured URL has a tab, reloads each one, and reports which are showing a sign-in page. The server sweeps every `lsd_keepalive_min` minutes (default 10, floor 2, first sweep 20 s after boot), and the LSD strip shows one dot per tab — green signed in, amber needs a password typed once, red errored — with a **Refresh now** button.

Four tabs are held by default on this machine (`lsd_keepalive_urls`, one URL per line): the CPQ quotes container, Dalia's *Pricing cases* OneDrive folder, her *LSD Daily work* workbook, and the QuotationFactoryEMEA site. A URL ending ` #noreload` is opened and reported on but never reloaded — that is how the workbook is held, since a reload of a page someone may be typing in is rude even though Excel Online autosaves.

Two things it deliberately does not do. It is **minimized, not headless**: Edge only binds the debugging port on a dedicated `--user-data-dir`, and a headless instance would hold the same profile lock while never being signable-in by hand — an SSO login has to be typed by a human once. And it never closes a tab: it matches an existing one (host plus first path segment, falling back to host alone when this sweep wants a single page on that host) rather than opening a second, so sweeping repeatedly leaves the tab count where it was.

**Waiting in Dalia's sheet** (added 2026-09-14): the pricing work arrives as rows Dalia adds to her *LSD Daily work -2025 - 2026 - update .xlsx* (eaton-my, `Documents/Dalia/Pricing Work/Daily Work`). `automation/lsd_queue.py` downloads it READ-ONLY through a signed-in eaton-my tab in the debug-rail Edge — by file GUID `18f90546-889b-4653-89e5-0660e6b819a2`, which survives her renaming it — and returns every **FIRE** row whose Status is not `Done`/`Cancelled` — Laith prices Fire only (2026-09-14), so rows whose BU is CBS/EL are dropped and only counted (`other_bu`); a row with a BLANK BU is kept as `no_bu` so an unlabelled new row is not lost (`lsd_queue_bu`: blank = FIRE, `all` = every BU, or a comma list). Each is classed `fetch` (open, nobody on it), `laith` (Notes already say "Done by Laith" — that is how she records his cases, there is no owner column), `hold` (`Hold`, `Hold Sales`, `Hold by Kiran`) or `no_number`. The server adds `priced` — a case folder for that W-number already exists in the case root — and a `first_seen` stamp per transaction in `data/lsd/queue_seen.json` (the first read stamps nothing, so her backlog does not all arrive as NEW). It reads every `lsd_queue_min` minutes (default 5, floor 2, first read 45 s after boot) and skips a tick while the keep-alive is reloading tabs. The script never uses the workbook tab itself if another eaton-my tab can carry the fetch, and never reloads it. The LSD tab shows the `fetch` rows above the transaction box with a **Fetch** button each (NEW badge for 24 h, a toast when a new one lands while the tab is open); the rest fold under "other open rows". Her numbers carry a trailing no-break space (`W262232087E\xa0`) — stripped before matching. **Minimized Edge freezes hidden tabs**: a plain `Runtime.evaluate` still answers, but a `fetch` inside a frozen tab never settles, so the first live read sat 100 s per tab and the server's 180 s kill turned it into "produced no result" (and an earlier empty reply surfaced as the bare error `'b64'`). The script now sends `Page.setWebLifecycleState {state:"active"}` to each tab before reading (download back to ~2.5 s), tries the workbook tab first (never reloaded, so never caught mid-reload), treats an empty reply as a failure, and caps each tab at 35–40 s.

Config: `lsd_master_model` (blank = newest `.xlsb` in `data/lsd`), `lsd_cases_root` (blank = `Desktop\LSD Pricing Doc`), `lsd_ledger` (default `R2321`), `lsd_cpq_port` (default `9222`), `lsd_register` (blank = `<case root>\LSD Daily Work - Vector.xlsx`), `lsd_request_type` (blank = `Standard CTO`), `lsd_sales_name`, `lsd_bu`, `lsd_keepalive` (false = no sweeps), `lsd_keepalive_min` (default 10), `lsd_keepalive_urls`, `lsd_queue` (false = no reads of her sheet), `lsd_queue_min` (default 5), `lsd_daily_file` (blank = her workbook's GUID; a GUID or server-relative path), `lsd_queue_bu` (blank = FIRE, `all` = every BU).
Endpoints: `GET /api/lsd/status|cases|file|register|register/file`, `GET /api/lsd/keepalive|queue`, `POST /api/lsd/upload|preview|build|reveal|cpq-fetch|register|register/push|keepalive/run|queue/refresh`. Python: `lsd_pricing.py`, `cpq_fetch.py`, `lsd_register.py`, `tab_keepalive.py`, `lsd_queue.py` (all `--job … --out …`). Component: `src/pages/LSD.tsx`.
Locked in the ship build: the tab is gated, `/api/lsd` is 403'd in the sidecar (the register routes included), and `lsd_pricing.py` / `cpq_fetch.py` / `lsd_register.py` are excluded from `ship-automation/`.

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
| POST | `/api/outlook/summarize` | AI summary + vision over the images you ticked (none by default); persists |
| POST | `/api/outlook/draft-reply` | AI draft reply written from the email alone |
| POST | `/api/outlook/polish-reply` | Rewrite text the user wrote (`mode=polish\|shorten\|formalize\|rewrite`) |
| POST | `/api/outlook/suggest-send` | Pick the real recipient from supplied candidates + write the covering note |
| POST | `/api/outlook/send-new` | New mail with Outlook-sourced attachments (`{to,cc,subject,body,attSources,draft}`; `draft:true` stops in Drafts) |
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
| GET/POST/DELETE | `/api/cbu/refs` · `/scan` · `/:id/pin` · `/:id/reveal` | CBU reference quotes (§6.13) |

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

### `cbu_ref_scan.py`
Finds past LoadStar-PS quotes and the system size each was for, by reading the Tech Brief PDFs and filled sizing calculators the sizer itself produced. See §6.13.

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
