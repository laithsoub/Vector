# Vector — Project Instructions

## What this project is
A React + Express + Vite web app built for Laith at Eaton Corporation (Budapest) to automate the quoting and PMO workflow. It runs locally on Windows, served at localhost:3000, launched via `start-app.vbs` (silent wrapper around `start-app.ps1`). The UI is served by Vite middleware inside the Express server (single process, port 3000).

## User
Laith Al-Soub, Technical Sales & Systems Engineer, Eaton, Budapest. Casual communication style — no fluff. The app is his personal tool, not distributed company-wide.

## Install location on user's machine
`C:\Users\E0740516\Desktop\VECTOR\VECTOR\`

## Development
Development now happens in-place in the install folder above — edit files directly, then restart the server (`npx tsx server.ts` or the launcher). No sandbox/zip packaging step. (Historically the app was built in a `/home/claude` sandbox and shipped as a `MagicUploader.zip`; that workflow is retired.)

## Tech stack
- **Frontend**: React 19, TypeScript, Tailwind CSS v3, Vite
- **Backend**: Express + TypeScript, run via `tsx` (ES modules — NO `require()`, use named imports from 'fs')
- **Python scripts**: Python 3, pdfplumber, openpyxl, requests
- **Runtime**: Node.js + Python on Windows

## File structure (inside VECTOR/)
```
server.ts          — Express backend + Vite middleware (single process)
src/App.tsx        — Full React UI (single file, all tabs)
src/types.ts       — TypeScript types
src/index.css      — Tailwind v3
vite.config.ts     — Vite config (no proxy — same server)
package.json
tsconfig.json
config.json        — base path + SP credentials (user fills in)

# Python scripts
pdf_to_csv.py        — Main extraction pipeline (PDF→CSV)
Automation_V4.py     — Step 1: SharePoint Quotation List upload
dq_store_upload.py   — Step 2: D&Q Store folder + PDF upload
pmo_raise.py         — PMO module (fills Word template from PDFs)
xlsx_extractor.py    — Italian xlsx extractor
refresh_cookies.py   — Connect to JOE: captures SharePoint session cookies from Edge
outlook_reader.py    — Outlook COM automation (Inbox feature)
outlook_win32_connector.py — Outlook COM helper
schematic_reader.py  — EL Material Pricer (list/PDF/image → priced)
cbu_export.py / parse_cbu.py — CBU cable sizing
commission_export.py — Commission export
overlay/outlook_overlay.py  — Outlook overlay tracker (+ overlay_state.json, start-overlay.bat)
# NOTE: Azure DI extraction is inlined in pdf_to_csv.py — there is no separate azure_extractor.py.

# Launchers
setup.bat          — Pure ASCII, kills node, npm install + build
start-app.ps1      — Kills old port 3000, launches Edge + server (PowerShell)
start-app.vbs      — Silent launcher (runs start-app.ps1 with no window)

# Config
config.json
```

## Server architecture
- Single Express app, Vite added as middleware AFTER all API routes
- ES modules throughout — use `import { createReadStream, ... } from 'fs'`, never `require('fs')`
- `pmoDownloads` is a `Map<string, { filePath: string; filename: string; tmpDir: string }>` declared inside `startServer()`
- PMO temp files go into `os.tmpdir()/pmo_<timestamp>/` — passed to Python via `MAGIC_PMO_OUTDIR` env var
- After Python finishes, tmpDir is NOT deleted immediately — kept until download completes or 10min timeout

## PMO module — current state
Upload flow: Quote PDF + 1–20 DOCU_ID PDFs + PO PDF → `POST /api/run/pmo` → `pmo_raise.py` → filled Word docx → download

### pmo_raise.py extraction (DOCU PDF format — BidManager output)
Real PDF structure discovered from actual files:
- **Cat Ref**: `DESIGNATION QB28154-S8 Right hand side` (all-caps label on page 1)
- **Description**: `Cabinet type: DualGuard-S 12C` or `Cabinet: DualGuard-S 12C`
- **Qty**: `Number of identical cabinets: N` (often blank → default "1")
- **NTP + ACP same line**: `Total Price with €26,128.30 Total Cost €4,392.12 83.19`
- Old regex patterns for `^Designation\s+` and `DualGuard` BOM line were wrong — real data uses DESIGNATION and Cabinet type fields

### Multi-DOCU support
- UI: "Add another DOCU_ID" button, sends `docu_pdf_0`, `docu_pdf_1`, etc.
- Server: collects up to 20 `docu_pdf_N` fields + legacy `price_pdf` fallback
- Python: splits `MAGIC_PMO_DOCU_PDFS` on `|`, processes each, matches to PO lines
- PO matching: Cat Ref substring → qty match → first unclaimed line (3-pass)
- Output log: `[OK] CatRef:`, `[OK] CatRef2:`, etc. (no suffix for first item)
- Word doc: first item fills template slots, additional items clone the last row

### Download flow (fixed)
1. Python writes docx to `MAGIC_PMO_OUTDIR` (same tmpDir as input files)
2. Python prints `__DOCX__:<path>` on stdout
3. Server registers path in `pmoDownloads` map, sends `__DOCX_ID__:<id>:<filename>` then `__DONE_OK__`
4. UI processes `__DOCX_ID__` BEFORE `__DONE_OK__` (ordering matters for React state)
5. Download button does `fetch(blob)` with `type: 'application/octet-stream'` — avoids Edge blocking `.docx` from localhost
6. `createReadStream` (imported from 'fs') — NOT `require('fs').createReadStream`

## Step 1 / Step 2 (main workflow)
- Step 1: `pdf_to_csv.py` (PDF extraction) → `Automation_V4.py` (SharePoint upload)
- Step 2: `dq_store_upload.py` (D&Q Store folder creation + file upload)
- Cookies for SharePoint read from hardcoded values in `Automation_V4.py` (FED_AUTH, RT_FA)
- Step 2 also reads cookies from Automation_V4.py (not hardcoded separately)

## PDF extraction pipeline (pdf_to_csv.py)
1. LibreOffice converts Word/Excel → PDF
2. Language detection from page 1 text (FR, IT, DE, ES keywords; default UK)
3. Azure Document Intelligence (skipped if credentials empty)
4. Local fallback: IT + xlsx → xlsx_extractor.py; others → language-specific extractor
5. LibreOffice portable path: `C:\Users\E0740516\Downloads\LibreOfficePortable\...`

## Known pending items
- UK W26 format needs second extractor branch (price on page 2)
- Azure DI setup pending (user said "forget it for now, stick to old method")
- SharePoint cookies need periodic refresh (user reconnects manually)

## Config (config.json)
```json
{
  "base": "path to EatonAutomation folder",
  "sp_site": "https://eaton.sharepoint.com/sites/ELTechsupport",
  "sp_list": "https://eaton.sharepoint.com/sites/QuotationFactoryEMEA",
  "dq_store": "Shared Documents/D&Q Store"
}
```

## Important gotchas
1. App lives at the NESTED path `Desktop\VECTOR\VECTOR\`. `automation/config.json` `base` must be the absolute inner data dir (`C:/Users/E0740516/Desktop/VECTOR/VECTOR/data`) — if it points one level up, runs write to a stray empty `data` folder and orphan the history
2. `require('fs')` crashes — ES modules only, use named imports
3. `rmdirSync` must be imported from 'fs' explicitly
4. Vite middleware is added AFTER all API routes — don't move it
5. PMO tmpDir cleanup: only delete after download completes, not on script close
6. setup.bat is pure ASCII (no UTF-8 box-drawing chars — caused cmd.exe crash)
