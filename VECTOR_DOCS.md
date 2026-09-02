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

### 6.12 LSD Pricing (LSD tab) — added 2026-08-26
Drop a CPQ **Export Line Items** transaction (`.csv` / `.xlsx` / `.xlsb`); the tab prices every line and writes a case folder holding the **transaction**, the **Approved Offer** (`.xlsx`) and the **Working File** — the master CPQ model itself, filled with the transaction and toggled, so the file shows how the feedback was produced.

**The rule — `requested`, the default** (Dalia, 2026-09-02). Pricing *to* the target E2E was pushing quotes far above the prior year: on W262217374E, holding 40% E2E took PV to 16.1% and Total RPI to 11.5%. So the target E2E no longer holds the price up, and neither does the 20% cap:
```
Add. Discount = Requested Discount
then, if the line still prices under the half-year RPI gate (H1 3.5% / H2 6%):
    unit net = customer PY average × (1 + rate)      (country average if the customer has none)
```
A line that lands **below** its target E2E is priced that way and flagged `needs approval` — the engine does not raise the price to hide it. On W262217374E that is **34.3% against a 40% target**, which Kiran has to agree to; PV drops to 6.0% and Total RPI to 1.8%. Note the gate is the analyst's own manual check (customer average × 1.06), *not* the algebraic solve below — the solve over-corrects because it also pays for the mix offset.

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

Config: `lsd_master_model` (blank = newest `.xlsb` in `data/lsd`), `lsd_cases_root` (blank = `Desktop\LSD Pricing Doc`), `lsd_ledger` (default `R2321`), `lsd_cpq_port` (default `9222`), `lsd_register` (blank = `<case root>\LSD Daily Work - Vector.xlsx`), `lsd_request_type` (blank = `Standard CTO`), `lsd_sales_name`, `lsd_bu`.
Endpoints: `GET /api/lsd/status|cases|file|register|register/file`, `POST /api/lsd/upload|preview|build|reveal|cpq-fetch|register|register/push`. Python: `lsd_pricing.py`, `cpq_fetch.py`, `lsd_register.py` (all `--job … --out …`). Component: `src/pages/LSD.tsx`.
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
