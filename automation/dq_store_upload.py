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


def upload_file(session, digest, folder_server_path, file_path):
    """Upload a file into a SharePoint folder."""
    filename   = os.path.basename(file_path)
    rel        = _site_rel(folder_server_path)          # clean site-relative
    server_rel = f"/sites/ELTechsupport/{rel}"          # full server-relative
    enc_path   = requests.utils.quote(server_rel, safe="/")
    enc_file   = requests.utils.quote(filename, safe="")
    url = (
        f"{SITE_URL}/_api/web/GetFolderByServerRelativeUrl"
        f"('{enc_path}')"
        f"/Files/add(url='{enc_file}',overwrite=true)"
    )
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
        print(f"  [ERR] Upload failed: {r.status_code} {r.text[:150]}")
        return False


def extract_quote_info(pdf_path):
    """Extract Salesforce ID and Quotation Name from PDF."""
    with pdfplumber.open(pdf_path) as pdf:
        page1 = pdf.pages[0].extract_text() or ""

    sf_id = ""
    quote_name = ""

    m = re.search(r"QUOTATION REF:\s*(\S+)", page1, re.IGNORECASE)
    if m:
        sf_id = m.group(1).rstrip("-")

    # Fallback: extract SF ID from filename (e.g. "SR00kE7n7YAC Eton College.pdf")
    if not sf_id:
        fname = os.path.splitext(os.path.basename(pdf_path))[0]
        # Match SF ID pattern: starts with 2 letters + digits + letters
        mf = re.match(r"([A-Z]{2}\d{2}[A-Za-z0-9]+)", fname)
        if mf:
            sf_id = mf.group(1)
            # Quote name = rest of filename after SF ID
            rest = fname[len(sf_id):].strip(" -_–")
            if rest:
                quote_name = rest

    # Try dash-separated name
    m2 = re.search(r"Project Reference:\s*" + re.escape(sf_id) + r"\s*[-–]\s*(.*)", page1, re.IGNORECASE)
    if m2:
        quote_name = m2.group(1).strip()
    else:
        # Space-only separator
        m3 = re.search(r"Project Reference:\s*" + re.escape(sf_id) + r"\s+(.*)", page1, re.IGNORECASE)
        if m3:
            quote_name = m3.group(1).strip()

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
        print(f"  [!] Could not extract SF ID — skipping.")
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

    except Exception as e:
        print(f"[FATAL ERROR] {e}")
        traceback.print_exc()