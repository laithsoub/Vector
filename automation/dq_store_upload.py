"""
D&Q Store Uploader
==================
For each PDF in the PDF Quotes folder:
  1. Creates the full folder structure under D&Q Store on SharePoint
  2. Uploads the PDF into the correct QUOTE subfolder
  3. Detects A1R revision from the quote name

Folder structure created:
  D&Q Store/
  └── {SALESFORCE_ID} — {QUOTE_NAME}/
      ├── A/
      │   ├── CBU/
      │   ├── DESIGN/
      │   ├── QUOTE/        ← PDF here (non-A1R quotes)
      │   ├── RX/
      │   └── SUBMITTED BY - {DATE} LS/
      └── A1R/
          ├── CBU/
          ├── DESIGN/
          ├── QUOTE/        ← PDF here (A1R quotes)
          ├── RX/
          └── SUBMITTED BY - {DATE} LS/

SETUP: Uses same FedAuth + rtFa cookies as Automation_V4.py
"""

import os
import json
import shutil
import sys
import io
import re
import glob
import tempfile
import requests
import urllib3
from datetime import datetime

# Outlook win32com connector (optional — skipped if pywin32 not installed)
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from outlook_win32_connector import find_matching_emails
    OUTLOOK_ENABLED = True
    print("[*] Outlook win32 connector loaded OK", flush=True)
except Exception as _oe:
    OUTLOOK_ENABLED = False
    print(f"[!] Outlook connector not loaded: {_oe}", flush=True)
    def find_matching_emails(*a, **kw): return []

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

try:
    import pdfplumber
except ImportError:
    print("[ERR] pdfplumber not installed. Run: pip install pdfplumber")
    sys.exit(1)

# ─────────────────────────────────────────────
#  CONFIG — update cookies when they expire
# ─────────────────────────────────────────────

# ── Paths — read from config.json next to this script ────────────────────────
def _load_cfg():
    import json
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    base = os.path.join(os.path.expanduser("~"), "Desktop", "EatonAutomation")
    cfg = {"base": base, "initials": "LS",
            "sp_site": "https://eaton.sharepoint.com/sites/ELTechsupport",
            "dq_store": "Shared Documents/D&Q Store"}
    try:
        cfg.update(json.loads(open(cfg_path, encoding="utf-8").read()))
    except Exception:
        pass
    return cfg

_CFG         = _load_cfg()
PDF_FOLDER   = os.path.join(_CFG["base"], "PDF Quotes")
ARCHIVE_BASE = os.path.join(_CFG["base"], "Archive")
SITE_URL     = _CFG["sp_site"]
DQ_STORE     = _CFG["dq_store"]
INITIALS     = _CFG["initials"]
TIMEOUT     = 30

# Cookies live encrypted in .cookies.enc (loaded via cookie_crypto). Do not paste
# cookies here; run Connect to JOE instead.
FED_AUTH = ""
RT_FA    = ""

# ─────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────

def _read_cookies_from_v4() -> tuple:
    """Load FedAuth + rtFa from the encrypted store (cookie_crypto)."""
    try:
        from cookie_crypto import load_cookies
        fed, rt = load_cookies()
        if fed and rt:
            return fed, rt
    except Exception as e:
        print(f"[WARN] Could not load cookies: {e}")
    return FED_AUTH, RT_FA


def get_session():
    fed, rt = _read_cookies_from_v4()
    s = requests.Session()
    s.cookies.set("FedAuth", fed, domain="eaton.sharepoint.com")
    s.cookies.set("rtFa",    rt,  domain="eaton.sharepoint.com")
    s.headers.update({"Accept": "application/json;odata=verbose"})
    s.verify = False
    return s


def get_digest(session):
    print("[*] Connecting to SharePoint (ELTechsupport)...")
    try:
        r = session.post(f"{SITE_URL}/_api/contextinfo", timeout=TIMEOUT)
    except Exception as e:
        print(f"[ERR] Connection failed: {e}")
        sys.exit(1)
    if r.status_code == 403:
        print("[ERR] 403 Forbidden — cookies have expired.")
        print("   -> Log into https://eaton.sharepoint.com/sites/ELTechsupport")
        print("   -> F12 > Application > Cookies > copy fresh FedAuth + rtFa into dq_store_upload.py")
        sys.exit(1)
    if r.status_code != 200:
        print(f"[ERR] Auth failed (HTTP {r.status_code}): {r.text[:200]}")
        sys.exit(1)
    print("[OK] Connected to ELTechsupport!")
    return r.json()["d"]["GetContextWebInformation"]["FormDigestValue"]


def _site_rel(path):
    """
    Normalise any path to a clean site-relative string, e.g.
      "Shared Documents/D&Q Store"  (no leading slash, no /sites/... prefix)
    Handles: leading slash, /sites/ELTechsupport/ prefix, ^& artifacts from CMD.
    """
    p = path.strip("/").replace("^&", "&")
    for prefix in ("sites/ELTechsupport/", "sites/eltechsupport/"):
        if p.lower().startswith(prefix):
            p = p[len(prefix):]
    return p.strip("/")


def ensure_folder(session, digest, parent_path, folder_name):
    """
    Create a folder under parent_path if it doesn't already exist.
    parent_path  — site-relative path (e.g. "Shared Documents/D&Q Store")
    folder_name  — the new subfolder name
    Returns the site-relative path of the new folder (no leading slash).
    """
    clean_parent = _site_rel(parent_path)
    full_path    = f"{clean_parent}/{folder_name}"
    server_rel   = f"/sites/ELTechsupport/{full_path}"   # absolute server-relative

    url = f"{SITE_URL}/_api/web/folders"
    payload = {
        "__metadata": {"type": "SP.Folder"},
        "ServerRelativeUrl": server_rel,
    }
    headers = {
        "Accept":          "application/json;odata=verbose",
        "Content-Type":    "application/json;odata=verbose",
        "X-RequestDigest": digest,
    }
    r = session.post(url, json=payload, headers=headers, timeout=TIMEOUT)
    if r.status_code in (200, 201):
        print(f"  [+] Created: {folder_name}", flush=True)
    elif r.status_code == 409:
        print(f"  [=] Exists:  {folder_name}", flush=True)
    else:
        print(f"  [!] Failed '{folder_name}': {r.status_code} {r.text[:160]}", flush=True)
    return full_path   # site-relative, no leading slash


_FOLDER_IDS = {}


def _odata_str(s):
    """A value for inside an OData '...' literal: apostrophe doubled (St Paul's), URL-encoded."""
    return requests.utils.quote(s.replace("'", "''"), safe="")


def folder_id(session, folder_path):
    """UniqueId of a site-relative folder, resolved one segment at a time.

    Addressing a file by its full path put folder + file name in the URL twice
    and hit SharePoint's maxUrlLength on long project names. Walking down by id
    keeps every request to one short name: GetFolderById(parent)/Folders/GetByUrl(name).
    """
    rel = _site_rel(folder_path)
    if rel in _FOLDER_IDS:
        return _FOLDER_IDS[rel]
    root = _site_rel(DQ_STORE)
    hdr = {"Accept": "application/json;odata=verbose"}
    if rel == root or "/" not in rel:
        enc = requests.utils.quote(f"/sites/ELTechsupport/{rel}".replace("'", "''"), safe="/")
        url = f"{SITE_URL}/_api/web/GetFolderByServerRelativeUrl('{enc}')?$select=UniqueId"
    else:
        parent, _, name = rel.rpartition("/")
        pid = folder_id(session, parent)
        url = (f"{SITE_URL}/_api/web/GetFolderById('{pid}')/Folders/GetByUrl('{_odata_str(name)}')"
               f"?$select=UniqueId")
    r = session.get(url, headers=hdr, timeout=TIMEOUT)
    r.raise_for_status()
    _FOLDER_IDS[rel] = r.json()["d"]["UniqueId"]
    return _FOLDER_IDS[rel]


def upload_file(session, digest, folder_server_path, file_path):
    """Upload a file into a SharePoint folder."""
    filename = os.path.basename(file_path)
    try:
        fid = folder_id(session, folder_server_path)
    except Exception as e:
        print(f"  [ERR] {filename}: folder not found on SharePoint ({_site_rel(folder_server_path)}): {e}")
        return False
    # Folder by id, so the URL carries only the file name — not the whole
    # D&Q Store path, which pushed long project names past maxUrlLength.
    url = f"{SITE_URL}/_api/web/GetFolderById('{fid}')/Files/add(url='{_odata_str(filename)}',overwrite=true)"
    headers = {
        "Accept": "application/json;odata=verbose",
        "X-RequestDigest": digest,
        "Content-Type": "application/octet-stream",
    }
    with open(file_path, "rb") as f:
        data = f.read()
    r = session.post(url, data=data, headers=headers, timeout=60)
    if r.status_code in (200, 201):
        print(f"  [OK] Uploaded: {filename}")
        return True
    else:
        try:
            why = r.json()["error"]["message"]["value"]
        except Exception:
            why = f"HTTP {r.status_code} {r.text[:150]}"
        print(f"  [ERR] {filename}: {why}")
        return False


# Short (SR00…/CR00…) or full (006…) Salesforce id. Explicit lookarounds, not
# \b: underscore is a word character, so \b never fires in Eaton file names.
_SFID_RE = re.compile(
    r"(?<![A-Za-z0-9])((?:CR|SR|EU|QR)00[A-Za-z0-9]{6,12}|006[A-Za-z0-9]{15})(?![A-Za-z0-9])"
)
# Bare tail inside a project name ("Eversheds … - EL - 00yduKjYAI") = record
# 006QO00000yduKjYAI. Same rule as pdf_to_csv._SFID_TAIL_RE: mixed case, so
# dates and order numbers don't pass.
_SFID_TAIL_RE = re.compile(r"(?<![A-Za-z0-9])00([A-Za-z0-9]{5}[A-Z0-5]{3})(?![A-Za-z0-9])")
# No Salesforce id at all: BidManager code (QW28237) or the quotation number.
_BM_CODE_RE = re.compile(r"(?<![A-Za-z0-9])(Q[BWV]\d{5}[A-Z]?\d{0,2}R?)(?![A-Za-z0-9])")
_QUOTE_NO_RE = re.compile(r"Quotation No:\s*([A-Z0-9]{2}[A-Z0-9]{2}\d{4}X\d[A-Z]\d(?:-\d{4})?)", re.IGNORECASE)


def _find_key(text):
    """(key, token-as-written) for the first Salesforce id in text, else ('', '')."""
    m = _SFID_RE.search(text)
    if m:
        return m.group(1), m.group(1)
    for m in _SFID_TAIL_RE.finditer(text):
        t = m.group(1)
        if any(c.islower() for c in t) and any(c.isupper() for c in t):
            return "006QO00000" + t, m.group(0)
    return "", ""


def extract_quote_info(pdf_path):
    """Extract Salesforce ID and Quotation Name from PDF."""
    with pdfplumber.open(pdf_path) as pdf:
        page1 = pdf.pages[0].extract_text() or ""

    sf_id = ""
    quote_name = ""

    # QUOTATION REF usually opens with the id ("SR00kE7n7YAC - Eton"), but some
    # quotes carry only the project name there ("St Paul's Cat") — taking its
    # first word made "St" the id and the folder "St — Paul's …". Accept only a
    # token shaped like a Salesforce id, wherever it sits on the page.
    ref  = re.search(r"QUOTATION REF:\s*(.*)", page1, re.IGNORECASE)
    proj = re.search(r"Project Reference:\s*(.*)", page1, re.IGNORECASE)
    ref_line  = ref.group(1).strip() if ref else ""
    proj_line = proj.group(1).strip() if proj else ""
    fname = os.path.splitext(os.path.basename(pdf_path))[0]
    token = ""
    for text in (ref_line, proj_line, page1, fname):
        sf_id, token = _find_key(text)
        if sf_id:
            break
    if not sf_id:
        m = _BM_CODE_RE.search(ref_line) or _BM_CODE_RE.search(proj_line) or _QUOTE_NO_RE.search(page1)
        if m:
            sf_id = token = m.group(1)

    # Quote name = the project reference with the id taken out.
    if proj_line:
        quote_name = proj_line.replace(token, "") if token else proj_line
        quote_name = re.sub(r"\s{2,}", " ", quote_name).strip(" -–—")
    elif sf_id and fname.startswith(sf_id):
        # e.g. "SR00kE7n7YAC Eton College.pdf"
        quote_name = fname[len(sf_id):].strip(" -_–")

    return sf_id, quote_name


def is_revision(quote_name):
    """Return True if quote name contains A1R (first revision)."""
    return bool(re.search(r'\bA1R\b', quote_name, re.IGNORECASE))


def sanitise_folder_name(name):
    """Remove characters not allowed in SharePoint folder names."""
    return re.sub(r'[\\/*?:"<>|#%{}~&]', '', name).strip()


# ─────────────────────────────────────────────
#  MAIN LOGIC
# ─────────────────────────────────────────────

def move_to_archive(pdf_path):
    """Move a successfully processed PDF to a full-date archive folder."""
    from datetime import datetime
    date_folder = datetime.now().strftime("%Y-%m-%d")
    archive_dir = os.path.join(ARCHIVE_BASE, date_folder)
    os.makedirs(archive_dir, exist_ok=True)
    dst = os.path.join(archive_dir, os.path.basename(pdf_path))
    try:
        shutil.move(pdf_path, dst)
        print(f"  [>>] Archived to: Archive/{date_folder}/{os.path.basename(pdf_path)}", flush=True)
    except Exception as e:
        print(f"  [!] Could not archive {os.path.basename(pdf_path)}: {e}", flush=True)


def process_pdf(session, digest, pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"\n  Processing: {filename}")

    sf_id, quote_name = extract_quote_info(pdf_path)
    if not sf_id:
        print(f"  [ERR] {filename}: no Salesforce id found in the file or its name — skipped.")
        return False

    revision = is_revision(quote_name)
    active_subfolder = "A1R" if revision else "A"
    today = datetime.now().strftime("%d-%m-%Y")

    # Full quote folder name: "SR00VroMbYAJ — Costco Gloucester EL"
    raw_folder_name = f"{sf_id} \u2014 {quote_name}" if quote_name else sf_id
    folder_name = sanitise_folder_name(raw_folder_name)

    print(f"  SF ID      : {sf_id}")
    print(f"  Quote Name : {quote_name}")
    print(f"  Revision   : {'A1R' if revision else 'A (standard)'}")
    print(f"  Folder     : {folder_name}")

    subfolders = ["CBU", "DESIGN", "QUOTE", "RX", f"SUBMITTED BY - {today} {INITIALS}"]

    # Create root quote folder under D&Q Store
    root = ensure_folder(session, digest, DQ_STORE, folder_name)

    # Create both A and A1R with all subfolders
    for variant in ["A", "A1R"]:
        variant_path = ensure_folder(session, digest, root, variant)
        for sub in subfolders:
            ensure_folder(session, digest, variant_path, sub)

    quote_folder_path = f"{root}/{active_subfolder}/QUOTE"
    rx_folder_path    = f"{root}/{active_subfolder}/RX"

    # -- Upload PDF into QUOTE/ ————————————————
    success = upload_file(session, digest, quote_folder_path, pdf_path)

    # -- Find matching emails via Outlook win32com ——————————
    if OUTLOOK_ENABLED:
        print(f"  [*] Searching Outlook for emails matching this quote...", flush=True)
        with tempfile.TemporaryDirectory() as tmp_dir:
            matched = find_matching_emails(sf_id, quote_name, tmp_dir, max_emails=3)
            if not matched:
                print("  [*] No matching emails found.", flush=True)
            for item in matched:
                subj = item["subject"]
                # Upload .msg email file into QUOTE/ alongside the PDF
                print(f"  [>>] Uploading email to QUOTE/: {subj}", flush=True)
                upload_file(session, digest, quote_folder_path, item["email_path"])
                # Upload non-PDF attachments into RX/
                if item["attachments"]:
                    n_att = len(item["attachments"])
                    print(f"  [>>] Uploading {n_att} attachment(s) to RX/", flush=True)
                    for att_name, att_path in item["attachments"]:
                        print(f"       - {att_name}", flush=True)
                        upload_file(session, digest, rx_folder_path, att_path)
    else:
        print("  [!] Outlook not available (pywin32 not installed) — skipping email search.", flush=True)

    if success:
        move_to_archive(pdf_path)
    return success


if __name__ == "__main__":
    import traceback
    try:
        exts = ["*.pdf", "*.PDF", "*.xlsx", "*.xls", "*.xlsm", "*.docx", "*.doc", "*.dotm", "*.dotx"]
        pdf_files = []
        for pat in exts:
            pdf_files.extend(glob.glob(os.path.join(PDF_FOLDER, pat)))
        pdf_files = sorted(set(pdf_files))
        print(f"[*] Found {len(pdf_files)} file(s) in PDF Quotes folder:", flush=True)

        if not pdf_files:
            print(f"[!] No pending files in manifest.", flush=True)
            print(f"__SUMMARY__:{json.dumps({'uploaded': 0, 'failed': 0})}", flush=True)
            sys.exit(0)

        for f in pdf_files:
            print(f"    - {os.path.basename(f)}", flush=True)

        print(f"\n[*] Connecting to SharePoint (ELTechsupport)...")
        session = get_session()
        digest  = get_digest(session)

        print("=" * 55)

        success_count = 0
        for pdf_path in pdf_files:
            ok = process_pdf(session, digest, pdf_path)
            if ok:
                success_count += 1

        print(f"\n{'='*55}")
        print(f"  Done — {success_count}/{len(pdf_files)} processed successfully.")
        print(f"{'='*55}\n")
        # Machine-readable tally for the Dashboard toast.
        print(f"__SUMMARY__:{json.dumps({'uploaded': success_count, 'failed': len(pdf_files) - success_count})}", flush=True)
        # Used to exit 0 even when every file failed, so the app said "built".
        if success_count == 0:
            print("[ERR] No quote reached the D&Q Store — see the errors above.", flush=True)
            sys.exit(1)

    except SystemExit:
        raise
    except Exception as e:
        print(f"[ERR] {e}")
        traceback.print_exc()
        sys.exit(1)