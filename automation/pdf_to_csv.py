"""
PDF to CSV Extractor
====================
Reads Eaton quotation PDFs and extracts data into QuoteExtra.csv format.

CSV Headers:
  INSIDE SALES, SALESFORCE ID, REQUESTED FROM EATON (INTERNAL), COUNTRY,
  ARRIVED ON, ON-HOLD date, STARTING/RECOVERING date, PROCESSED ON,
  STATUS, PRICE [EUR], Due date, Request type, PRODUCT, QUOTATION CODE, QUOTATION NAME

SETUP (run once):
    pip install pdfplumber

USAGE:
    1. Put one or more PDF files in the same folder as this script
       OR set PDF_FOLDER below to a specific path
    2. Run: py pdf_to_csv.py
    3. Output: QuoteExtra.csv in the same folder

CTO vs DTO logic:
    - If any BOM page contains inverter keywords (KVA, inverter, UPS, CBU, LoadStar, Loadstar)
      -> CTO (Configure To Order)
    - If only luminaire/lighting products found
      -> DTO (Design To Order)
"""

import csv
import json
import os
import re
import sys
import io
import glob
import shutil
import tempfile
import subprocess

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    import pdfplumber
except ImportError:
    print("[ERR] pdfplumber not installed. Run: pip install pdfplumber")
    sys.exit(1)


# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────

# Folder containing PDF files — defaults to same folder as this script
# ── Paths — read from config.json next to this script ────────────────────────
def _load_config():
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    try:
        import json
        return json.loads(open(cfg_path, encoding="utf-8").read())
    except Exception:
        return {}

_CFG = _load_config()
_BASE = _CFG.get("base", os.path.join(os.path.expanduser("~"), "Desktop", "EatonAutomation"))
_PDF_FOLDER_DEFAULT = os.path.join(_BASE, "PDF Quotes")
PDF_FOLDER = os.environ.get("MAGIC_PDF_FOLDER", _PDF_FOLDER_DEFAULT)
CSV_FOLDER = os.environ.get("MAGIC_CSV_FOLDER", _BASE)

# Output CSV path
CSV_OUTPUT = os.path.join(CSV_FOLDER, "QuoteExtra.csv")

# INSIDE SALES — the uploader for UK quotes (SharePoint lookup field, must resolve).
# Config-driven so each department/uploader sets their own; env var overrides.
# Non-UK quotes use the salesman extracted from the quote instead (set per-extractor).
INSIDE_SALES = os.environ.get("MAGIC_INSIDE_SALES", "").strip() or _CFG.get("inside_sales", "Laith Al-Soub")
# Salesman email → display name mapping
# Detected from page 1: "please do not hesitate to contact the Sales Engineer..."
SALESMAN_MAP = {
    "joebayley@eaton.com":     "Bayley, Joe",
    "markafenton@eaton.com":   "Fenton, Mark A",
    "olliejbailey@eaton.com":  "Bailey, Ollie J",
    "ryanhouston@eaton.com":   "Houston, Ryan",
}
DEFAULT_SALESMAN = ""   # blank if not found — never guess

def detect_salesman(page1_text):
    """Find salesman from the 'contact Sales Engineer' line on page 1."""
    # Look for the trigger phrase, then grab the email on the same or next tokens
    pattern = r"please do not hesitate to contact.*?([a-zA-Z0-9._%+\-]+@eaton\.com)"
    m = re.search(pattern, page1_text, re.IGNORECASE | re.DOTALL)
    if m:
        email = m.group(1).strip().lower()
        return SALESMAN_MAP.get(email, DEFAULT_SALESMAN)
    # Fallback: scan whole page for any known email
    for email, name in SALESMAN_MAP.items():
        if email in page1_text.lower():
            return name
    return DEFAULT_SALESMAN
COUNTRY                   = "UK"
STATUS                    = "Processed"
REQUEST_TYPE              = "Standard CTO"

# CTO keywords — if ANY of these appear in BOM pages, it's CTO
CTO_KEYWORDS = [
    "kva", "inverter", "ups", "cbu", "loadstar", "battery",
    "static inverter", "central battery", "3ph", "1ph",
    "rectifier", "bypass", "commissioning"
]

# ─────────────────────────────────────────────
#  EXTRACTION LOGIC
# ─────────────────────────────────────────────

CSV_HEADERS = [
    "INSIDE SALES", "SALESFORCE ID", "REQUESTED FROM EATON (INTERNAL)",
    "COUNTRY", "ARRIVED ON", "ON-HOLD date", "STARTING/RECOVERING date",
    "PROCESSED ON", "STATUS", "PRICE [EUR]", "Due date",
    "Request type", "PRODUCT", "QUOTATION CODE", "QUOTATION NAME", "CUSTOMER", "DIVISION"
]


def extract_field(text, pattern, group=1, default=""):
    """Extract a field using regex, return default if not found."""
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(group).strip() if m else default


def normalise_date(raw):
    """Convert various date formats to DD/MM/YYYY."""
    raw = raw.strip()
    # Already DD/MM/YYYY
    if re.match(r"\d{2}/\d{2}/\d{4}", raw):
        return raw
    # D/M/YYYY or D/MM/YYYY
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if m:
        return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    return raw


def determine_product_type(all_pages_text):
    """Return Standard CTO or DTO based on content across all BOM pages."""
    lower = all_pages_text.lower()
    for kw in CTO_KEYWORDS:
        if kw in lower:
            return "Standard CTO"
    return "DTO"


def extract_total_price(all_pages_text):
    """
    Extract total price from UK/BE PDFs.
    Handles old format (Total Plant Price) and new OE format (W26/EU4E):
      - "Total Value (Excluding alternates) £ 32,368.89"
      - "Total Buying Price without VAT £ 11552.22"
      - "Project Total Price for Standard products (GBP) £72,468.26"
    """
    patterns = [
        r"total plant price.*?([\d,]+\.\d{2})",
        r"Total Value.*?£\s*([\d,]+\.\d{2})",
        r"Total Buying Price without VAT\s+£\s*([\d,]+\.\d{2})",
        r"Project Total Price.*?£\s*([\d,]+\.\d{2})",
    ]
    for pat in patterns:
        m = re.search(pat, all_pages_text, re.IGNORECASE)
        if m:
            return m.group(1).replace(",", "")
    return ""


def extract_quotation_name(page1_text, salesforce_id):
    """
    Extract the quotation name from the Project Reference line.
    Handles both:
      'SR00VroMbYAJ - Costco, Gloucester EL'  (with dash separator)
      'SR00f0uvRYAQ ALO YOGA- EDINBURGH'       (space only, no dash before name)
    """
    # Try with dash separator first
    m = re.search(r"Project Reference:\s*" + re.escape(salesforce_id) + r"\s*[-–]\s*(.*)", page1_text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # Try space-only separator (no dash between SF ID and name)
    m2 = re.search(r"Project Reference:\s*" + re.escape(salesforce_id) + r"\s+(.*)", page1_text, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    # Fallback: everything after the last dash on the Project Reference line
    m3 = re.search(r"Project Reference:.*?[-–]\s*(.*)", page1_text, re.IGNORECASE)
    if m3:
        return m3.group(1).strip()
    return ""


def process_pdf(pdf_path, arrived_date="", division="", today=""):
    """Extract all required fields from a single PDF."""
    print(f"  Processing: {os.path.basename(pdf_path)}")

    with pdfplumber.open(pdf_path) as pdf:
        page1_text = pdf.pages[0].extract_text() or ""
        # Combine all pages after page 1 for BOM data (handles multi-page BOMs)
        bom_text = "\n".join(
            (pdf.pages[i].extract_text() or "") for i in range(1, len(pdf.pages))
        )

    # ── Page 1 extractions ──────────────────
    salesforce_id = extract_field(page1_text, r"QUOTATION REF:\s*(\S+?)[-\s]*$", default="")
    if not salesforce_id or len(salesforce_id) < 15:
        salesforce_id = extract_field(page1_text, r"QUOTATION REF:\s*(\S+)")
    # Fallback: Project Reference line
    if not salesforce_id or len(salesforce_id) < 15:
        m_pr = re.search(r"Project Reference:\s*(\S+)", page1_text, re.IGNORECASE)
        if m_pr:
            salesforce_id = m_pr.group(1).rstrip("-")
    # Fallback: extract full 18-char ID from filename (e.g. EU1L..._006QO00000qD1WcYAK_...)
    if not salesforce_id or len(salesforce_id) < 18:
        fname = os.path.splitext(os.path.basename(pdf_path))[0]
        m_fn = re.search(r'(006[A-Za-z0-9]{15})', fname)
        if m_fn:
            salesforce_id = m_fn.group(1)
    # W26/EU4E new OE format: "Request Name: CR00kkISTYA2 Paddock Lane School LV"
    if not salesforce_id or len(salesforce_id) < 10:
        m_rn = re.search(r"Request Name:\s*(\S+)\s+(.+)", page1_text, re.IGNORECASE)
        if m_rn:
            salesforce_id = m_rn.group(1).strip()
    # Also try RFQ Number: "... - CR00kkISTYA2 ..."
    if not salesforce_id or len(salesforce_id) < 10:
        m_rfq = re.search(r"RFQ Number.*?-\s*(CR\S+)", page1_text, re.IGNORECASE)
        if m_rfq:
            salesforce_id = m_rfq.group(1).strip()
    salesforce_id = salesforce_id.rstrip("-")

    # Quotation code: old "Quotation No:" or new "Reference Number :"
    quotation_code = (
        extract_field(page1_text, r"Quotation No:\s*(\S+)")
        or extract_field(page1_text, r"Reference Number\s*[:\-]\s*(\S+)")
        or extract_field(page1_text, r"Quotation Reference:\s*(\S+)")
    )

    # Issue date: old "Issue Date:" or new "Valid From Date:" / "Quotation Date:"
    raw_issue_date = (
        extract_field(page1_text, r"Issue Date:\s*([\d/]+)")
        or extract_field(page1_text, r"Valid From Date:\s*([\d/]+)")
        or extract_field(page1_text, r"Quotation Date:\s*([\d/]+)")
    )
    issue_date = normalise_date(raw_issue_date) if raw_issue_date else ""

    # Valid-to: old "Quotation Valid to:" or new "Valid To" (page 2)
    all_text_uk = page1_text + "\n" + bom_text
    raw_valid_to = (
        extract_field(page1_text, r"Quotation Valid to:\s*([\d/]+)")
        or extract_field(all_text_uk, r"Valid To\s+([\d/]+)")
    )
    valid_to = normalise_date(raw_valid_to) if raw_valid_to else ""

    # Quotation name: old Project Reference pattern or new Request Name
    quotation_name = extract_quotation_name(page1_text, salesforce_id)
    if not quotation_name:
        m_rn2 = re.search(r"Request Name:\s*\S+\s+(.+)", page1_text, re.IGNORECASE)
        if m_rn2:
            quotation_name = m_rn2.group(1).strip()

    # Customer: "Customer Name: CEF" or generic "Customer:"
    customer = (
        extract_field(page1_text, r"Customer Name:\s*(.+?)\s+Eaton Sales Contact")
        or extract_field(page1_text, r"(?:Customer|Client)\s*[:\-]\s*(.+)")
    )

    # Salesman: existing email map or new "Eaton Sales Contact: Name" pattern
    salesman = detect_salesman(page1_text)
    if not salesman:
        m_sc = re.search(r"Eaton Sales Contact:\s*([^\n]+)", page1_text, re.IGNORECASE)
        if m_sc:
            salesman = m_sc.group(1).strip()

    # ── BOM extractions (all pages after page 1, also try all_text_uk for W26) ─────
    price = extract_total_price(bom_text) or extract_total_price(all_text_uk)
    product_type = determine_product_type(bom_text)

    # ── Dates ───────────────────────────────
    from datetime import date as _date
    today_str = today if today else _date.today().strftime("%d/%m/%Y")
    arrival = arrived_date if arrived_date else issue_date

    # ── Build row ───────────────────────────
    row = {
        "INSIDE SALES"                      : INSIDE_SALES,
        "SALESFORCE ID"                     : salesforce_id,
        "REQUESTED FROM EATON (INTERNAL)"   : salesman,
        "COUNTRY"                           : COUNTRY,
        "ARRIVED ON"                        : arrival,
        "ON-HOLD date"                      : arrival,
        "STARTING/RECOVERING date"          : arrival,
        "PROCESSED ON"                      : today_str,
        "STATUS"                            : STATUS,
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quotation_code,
        "QUOTATION NAME"                    : quotation_name,
        "CUSTOMER"                          : customer,
        "DIVISION"                          : division,
    }

    print(f"    SF ID       : {salesforce_id}")
    print(f"    Salesman    : {salesman}")
    print(f"    Quote Code  : {quotation_code}")
    print(f"    Quote Name  : {quotation_name}")
    print(f"    Customer    : {customer}")
    print(f"    Arrived     : {arrival}")
    print(f"    Processed   : {today_str}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price       : {price}")
    print(f"    Product Type: {product_type}")

    return row


# ─────────────────────────────────────────────
#  FILE CONVERSION (Word / Excel → PDF)
# ─────────────────────────────────────────────

# Extensions that can be converted to PDF via LibreOffice
CONVERTIBLE_EXTENSIONS = {
    ".docx", ".doc", ".dotx", ".dotm",   # Word
    ".xlsx", ".xls", ".xlsm", ".xlsb",   # Excel
    ".odt", ".ods",                       # LibreOffice native
}

def find_libreoffice():
    """Find LibreOffice / soffice executable."""
    for cmd in ["soffice", "libreoffice"]:
        p = shutil.which(cmd)
        if p:
            return p
    # Common Windows paths — installed + portable
    for p in [
        r"C:\Users\E0740516\Downloads\LibreOfficePortable\App\libreoffice\program\soffice.exe",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]:
        if os.path.exists(p):
            return p
    return None

def convert_to_pdf(src_path, out_dir):
    """
    Convert a Word or Excel file to PDF using LibreOffice.
    Returns the path to the created PDF, or None on failure.
    """
    lo = find_libreoffice()
    if not lo:
        print(f"    [SKIP] LibreOffice not found — cannot convert {os.path.basename(src_path)}")
        return None
    try:
        result = subprocess.run(
            [lo, "--headless", "--convert-to", "pdf", src_path, "--outdir", out_dir],
            capture_output=True, text=True, timeout=60
        )
        # LibreOffice outputs the pdf path in stdout
        base = os.path.splitext(os.path.basename(src_path))[0]
        pdf_path = os.path.join(out_dir, base + ".pdf")
        if os.path.exists(pdf_path):
            return pdf_path
        print(f"    [WARN] Conversion output not found: {result.stdout} {result.stderr}")
        return None
    except subprocess.TimeoutExpired:
        print(f"    [WARN] Conversion timed out for {os.path.basename(src_path)}")
        return None
    except Exception as e:
        print(f"    [WARN] Conversion failed for {os.path.basename(src_path)}: {e}")
        return None


# ─────────────────────────────────────────────
#  FORMAT CONVERSION  (docx / dotm / xlsx / xlsm → PDF)
# ─────────────────────────────────────────────

def collect_input_files(folder):
    """
    Collect all processable files from folder.
    Returns list of (pdf_path, original_name, was_converted, tmp_dir, orig_path).
    - orig_path: path to the original source file (xlsx/docx/etc.), or None for native PDFs.
      Used so Italian xlsx files can be read directly instead of via the converted PDF.
    Non-PDF files are converted to PDF for language detection and fallback extraction.
    """
    tmp_dir = tempfile.mkdtemp(prefix="magic_convert_")
    result = []
    for f in sorted(os.listdir(folder)):
        if f.startswith("~") or f.startswith("."):
            continue
        full = os.path.join(folder, f)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(f)[1]
        ext_lower = ext.lower()
        if ext_lower == ".pdf":
            result.append((full, f, False, None, None))
        elif ext_lower in CONVERTIBLE_EXTENSIONS:
            print(f"  [→] Converting {f} to PDF...")
            pdf = convert_to_pdf(full, tmp_dir)
            if pdf:
                print(f"      OK: {os.path.basename(pdf)}")
                result.append((pdf, f, True, tmp_dir, full))
            else:
                print(f"  [SKIP] {f} — conversion failed (LibreOffice required for Word/Excel)")
    return result, tmp_dir


# ─────────────────────────────────────────────
#  LANGUAGE / COUNTRY AUTO-DETECTION
# ─────────────────────────────────────────────

# Keyword fingerprints per language — checked against page 1 text
LANGUAGE_SIGNATURES = {
    "FR": [
        "numéro de cotation", "notre référence", "votre demande",
        "hors tva", "hors alternatives", "validité jusqu",
        "modalités de paiement", "établi"
    ],
    "DE": [
        "angebot nr", "unser angebot", "ihre anfrage", "angebots",
        "sehr geehrter", "sehr geehrte", "zahlungsbedingungen",
        "gültig", "netto", "mwst", "inkl. mwst", "exkl. mwst",
        "projektname", "datum", "summe"
    ],
    "IT": [
        "richiesta n°", "richiesta n", "spett.le", "progetto",
        "in riferimento", "condizioni di fornitura", "iva esclusa",
        "offerta n", "numero offerta", "validità", "ns. migliori"
    ],
    "ES": [
        "número de oferta", "referencia", "sin iva", "validez",
        "condiciones de pago", "estimado cliente"
    ],
    "NL": [
        "offertenummer", "uw referentie", "excl. btw", "geldig tot",
        "betalingsvoorwaarden"
    ],
    # UK is the default fallback — no signature needed
}

def detect_language(page1_text, filename=""):
    """
    Score page 1 text against keyword fingerprints for each language.
    Returns language code (FR, IT, DE, ES, BE) or UK as default.
    BE = Belgian project raised by UK office (EU4E... reference prefix).
    """
    # BE detection: EU4E prefix in filename or quote reference line
    if re.search(r'\bEU4[A-Z]\d+', filename, re.IGNORECASE) or \
       re.search(r'\bEU4[A-Z]\d+', page1_text):
        return "BE"

    text_lower = page1_text.lower()
    scores = {}
    for lang, keywords in LANGUAGE_SIGNATURES.items():
        scores[lang] = sum(1 for kw in keywords if kw in text_lower)

    best_lang = max(scores, key=scores.get)
    best_score = scores[best_lang]

    if best_score >= 2:   # need at least 2 keyword hits to be confident
        return best_lang
    return "UK"           # default


# Map language code → country name for SharePoint
COUNTRY_NAMES = {
    "UK": "UK",
    "BE": "BELGIUM",
    "FR": "FRANCE",
    "IT": "ITALY",
    "DE": "GERMANY",
    "ES": "SPAIN",
    "NL": "NETHERLANDS",
}

# Map language code → extractor function (populated after functions are defined)
EXTRACTORS = {}   # filled at bottom of file



# Categories that are pure emergency lighting — anything else = CTO
FR_LIGHTING_ONLY = ["eclairage de securite", "eclairage de sécurité"]

def detect_salesman_fr(page1_text):
    """REQUESTED FROM = 'Votre contact commercial' (the Eaton sales rep)."""
    m = re.search(r"contact commercial\s*[:\s]+([^\n]+)", page1_text, re.IGNORECASE)
    if m:
        # On two-column layouts the value can be followed by another right-column
        # label on the same logical line — cut it off.
        val = re.split(r"\s+(?:Tel Eaton Sales Contact|Email)\s*:", m.group(1))[0]
        return val.strip()
    return DEFAULT_SALESMAN


def detect_inside_sales_fr(page1_text):
    """INSIDE SALES = 'Etabli(e) par' (the Cooper back-office author of the quote)."""
    m = re.search(r"Etabli\(e\) par\s*:\s*([^\n]+)", page1_text, re.IGNORECASE)
    if m:
        # Trim trailing right-column label / email if present on the same line.
        val = re.split(r"\s+(?:Email|Votre contact commercial)\s*:", m.group(1))[0]
        return val.strip()
    return ""


def extract_customer_fr(page1_text):
    """
    Customer NAME only (no client number, no address).

    Two FR layouts:
      A) two-column: "Nom du client: <NAME> Etabli(e) par: ..."
      B) single-col: "Client Final: <NAME>"  (number/address on following lines)
    """
    for label in (r"Nom du client", r"Client Final"):
        m = re.search(label + r"\s*:\s*(.+)", page1_text)
        if m:
            val = m.group(1)
            # Drop any right-column label that bleeds onto the same line, and never
            # let the client number / address get captured as the name.
            val = re.split(
                r"\s+(?:Etabli\(e\) par|Num[ée]ro de client|N°\s*Client Final|Adresse)\s*:",
                val,
            )[0]
            return val.strip()
    return ""


def detect_product_type_fr(page2_text):
    """
    Scan page-2 product categories. If any category other than emergency
    lighting is present → Standard CTO, otherwise → DTO.

    Two layouts:
      A) a "Summary" section listing category names ("Eclairage de sécurité", …).
      B) a "Categorie | Subtotal | Prix total hors TVA" table whose rows hold
         the categories ("SSI", "MISE EN SERVICE …") — variant-B quotes have no
         Summary block, so the whole page-2 text is scanned instead.
    """
    import unicodedata
    def strip_accents(s):
        return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

    # Prefer the Summary block when present; else fall back to the full page text
    # so the variant-B category table is covered.
    summary_m = re.search(r"Summary(.+?)(?:Cooper Securite|Page\s*:|\Z)", page2_text, re.DOTALL | re.IGNORECASE)
    scan_norm = strip_accents((summary_m.group(1) if summary_m else page2_text).lower())

    # Non-lighting category keywords (French). "ssi" = Système de Sécurité Incendie.
    non_lighting = [
        "securite incendie", "alarme technique", "alarme intrusion",
        "detection incendie", "controle acces", "video", "cvc",
        "electricite", "courants forts", "courants faibles",
    ]
    for kw in non_lighting:
        if strip_accents(kw) in scan_norm:
            return "Standard CTO"
    # "ssi" needs word boundaries so it doesn't match inside other words.
    if re.search(r"\bssi\b", scan_norm):
        return "Standard CTO"
    return "DTO"


# Product-line (DIVISION) keyword fingerprints. Map quote content → the UI
# "Product line" picker codes. Per-language because templates/terms differ.
def _norm_text(*texts):
    """Concatenate, lowercase and strip accents for keyword matching."""
    import unicodedata
    blob = " ".join(t or "" for t in texts)
    return "".join(c for c in unicodedata.normalize("NFD", blob) if unicodedata.category(c) != "Mn").lower()


def _hit(blob, subs=(), tokens=()):
    return any(s in blob for s in subs) or any(re.search(t, blob) for t in tokens)


# ── France: emergency lighting (EL) vs fire/SSI (FIRE) ──────────────────────
_FR_FIRE_KW = [
    "securite incendie", "detection incendie", "alarme incendie",
    "declencheur manuel", "centrale de detection", "diffuseur sonore",
    "detecteur optique", "detecteur thermo", "sirene", "cmsi", "sensea",
]
_FR_FIRE_TOKENS = [r"\bssi\b", r"\buga\b"]
_FR_EL_KW = [
    "eclairage de securite", "bloc autonome", "luminaire", "pictogramme",
    "balisage", "evacuation", "planete",
]
_FR_EL_TOKENS = [r"\bbaes\b", r"\bb\.?a\.?e\.?s\b", r"\bsati\b"]

# ── Germany/Austria/CH: MV switchgear vs transformer ───────────────────────
_DE_SW_KW = [
    # NB: no bare "mittelspannung" — it also appears in "Mittelspannungstransformator".
    "xiria", "schaltanlage", "schaltfeld", "lasttrennschalter",
    "leistungsschalter", "schaltraum", "ringkabel",
    "feldrig", "magnefix", "power xpert",
]
_DE_SW_TOKENS = [r"\bsf6\b"]
_DE_TR_KW = [
    "transformator", "trafo", "giessharz", "harztransformator",
    "oeltransformator", "olverteiltransformator", "verteiltransformator",
]
_DE_COMBO_KW = [
    "kompaktstation", "ortsnetzstation", "ubergabestation",
    "transformatorstation", "netzstation",
]

# ── Italy: emergency lighting / fire / MV switchgear ────────────────────────
_IT_EL_KW = [
    "cgline", "flexitech", "crystalway", "corpi illuminanti",
    "illuminazione di emergenza", "luci di emergenza", "lampade",
    "plafoniera", "autonomia",
]
_IT_FIRE_KW = [
    "antincendio", "rivelazione incendio", "rivelatore", "rivelatori",
    "centrale antincendio", "allarme incendio",
]
_IT_SW_KW = [
    "quadri", "quadro", "scomparto", "scomparti", "media tensione",
    "cella", "celle", "xiria",
]

# ── UK/BE: emergency lighting (EL) vs fire (FIRE) ───────────────────────────
# English Eaton-UK template; BE uses the same template, so both share this set.
_UK_EL_KW = [
    "dualguard", "static inverter", "central battery", "emergency lighting",
    "cgline", "self-contained", "self contained", "escape route",
    "exit sign", "exit luminaire", "luminaire", "bulkhead",
]
_UK_EL_TOKENS = [r"\bcbu\b"]
_UK_FIRE_KW = [
    "fire alarm", "fire detection", "smoke detector", "smoke detection",
    "call point", "sounder", "addressable panel", "aspirating",
    "heat detector", "beam detector",
]


def _division_fr(blob):
    has_fire = _hit(blob, _FR_FIRE_KW, _FR_FIRE_TOKENS)
    has_el   = _hit(blob, _FR_EL_KW,   _FR_EL_TOKENS)
    if has_fire and has_el: return "EL & FIRE"
    if has_fire: return "FIRE"
    if has_el:   return "EL"
    return ""


def _division_de(blob):
    # Combo only on explicit packaged-station terms. Switchgear wins over a stray
    # "Transformator" (it shows up as a protection feature in switchgear quotes),
    # so a transformer verdict requires transformer terms with no switchgear ones.
    if _hit(blob, _DE_COMBO_KW): return "MV-COMBINATION"
    if _hit(blob, _DE_SW_KW, _DE_SW_TOKENS): return "MV-SWITCHGEAR"
    if _hit(blob, _DE_TR_KW): return "MV-TRANSFORMER"
    return ""


def _division_it(blob):
    has_el   = _hit(blob, _IT_EL_KW)
    has_fire = _hit(blob, _IT_FIRE_KW)
    if has_el and has_fire: return "EL & FIRE"
    if has_fire: return "FIRE"
    if has_el:   return "EL"
    if _hit(blob, _IT_SW_KW): return "MV-SWITCHGEAR"
    return ""


def _division_uk(blob):
    has_fire = _hit(blob, _UK_FIRE_KW)
    has_el   = _hit(blob, _UK_EL_KW, _UK_EL_TOKENS)
    if has_fire and has_el: return "EL & FIRE"
    if has_fire: return "FIRE"
    if has_el:   return "EL"
    return ""


def detect_division(lang, *texts):
    """Suggest the UI Product-line code from a quote's text, by language.

    UK/BE  → EL / FIRE / EL & FIRE (English Eaton-UK template).
    FR/IT → EL / FIRE / EL & FIRE (lighting & fire-safety quotes).
    IT     → also MV-SWITCHGEAR (quadri / media tensione).
    DE     → MV-SWITCHGEAR / MV-TRANSFORMER / MV-COMBINATION.
    Returns '' when nothing recognisable (UI leaves the picker to the user).
    """
    blob = _norm_text(*texts)
    if lang == "FR": return _division_fr(blob)
    if lang == "DE": return _division_de(blob)
    if lang == "IT": return _division_it(blob)
    if lang in ("UK", "BE"): return _division_uk(blob)
    return ""


# Back-compat alias (FR-only callers).
def detect_division_fr(*texts):
    return _division_fr(_norm_text(*texts))


def _fr_to_float(raw):
    """French number string '18.746,00' / '3 000 000,00' → float."""
    return float(raw.strip().replace(" ", "").replace(".", "").replace(",", "."))


def extract_total_price_fr(page2_text):
    """
    Discounted total (HT) from French quote page 2.

    Variant A (single line): "Valeur totale (hors alternatives produits) 650,18 €".
    Variant B (no 'Valeur totale'): a Summary category table with columns
        'Categorie | Subtotal | Prix total hors TVA'
    where the discounted price is the SUM of the 'Prix total hors TVA' column
    (2nd € amount on each category row), e.g. 18.746 + 1.500 + 1.800 = 22.046.
    """
    m = re.search(r"Valeur totale.*?([\d\s\.]+,\d{2})\s*€", page2_text, re.IGNORECASE | re.DOTALL)
    if m:
        return f"{_fr_to_float(m.group(1)):.2f}"

    # Variant B — sum the second € amount (Prix total hors TVA) of each table row.
    total, found = 0.0, False
    for line in page2_text.splitlines():
        amounts = re.findall(r"€\s*([\d\.\s]+,\d{2})", line)
        if len(amounts) >= 2:
            total += _fr_to_float(amounts[1])
            found = True
    if found:
        return f"{total:.2f}"
    return ""


def process_pdf_fr(pdf_path, arrived_date="", division="", today="", lang="FR"):
    """Extract all required fields from a French Cooper Securite SAS PDF."""
    print(f"  Processing (FR): {os.path.basename(pdf_path)}")

    with pdfplumber.open(pdf_path) as pdf:
        page1_text = pdf.pages[0].extract_text() or ""
        page2_text = pdf.pages[1].extract_text() if len(pdf.pages) > 1 else ""

    # Notre référence → quotation code + Title
    quotation_code = extract_field(page1_text, r"Notre r[ée]f[ée]rence\s*[:\s]+(\S+)")
    if not quotation_code:
        quotation_code = extract_field(page1_text, r"Num[ée]ro de cotation\s*[:\s]+(\S+)")

    # Project name
    quotation_name = extract_field(page1_text, r"Votre demande\s*[:\s]+(.+)")

    # Customer NAME only (handles "Nom du client" and "Client Final", strips address)
    customer = extract_customer_fr(page1_text)

    # INSIDE SALES = Etabli(e) par (Cooper back-office author)
    # REQUESTED FROM = Votre contact commercial (Eaton sales rep)
    inside_sales = detect_inside_sales_fr(page1_text)
    requested_from = detect_salesman_fr(page1_text)

    # Issue date
    raw_date = extract_field(page1_text, r"Date\s*[:\s]+([\d/]+)")
    issue_date = normalise_date(raw_date) if raw_date else ""

    # Validity date
    raw_valid = extract_field(page2_text, r"Validit[ée] jusqu.au\s+([\d/]+)")
    if not raw_valid:
        raw_valid = extract_field(page1_text, r"Validit[ée] jusqu.au\s+([\d/]+)")
    valid_to = normalise_date(raw_valid) if raw_valid else ""

    # Price
    price = extract_total_price_fr(page2_text)

    # Product type — scan summary table
    product_type = detect_product_type_fr(page2_text)

    # Dates
    from datetime import date as _date
    today_str = today if today else _date.today().strftime("%d/%m/%Y")
    arrival = arrived_date if arrived_date else issue_date

    row = {
        "INSIDE SALES"                      : inside_sales,
        "SALESFORCE ID"                     : "",
        "REQUESTED FROM EATON (INTERNAL)"   : requested_from,
        "COUNTRY"                           : COUNTRY_NAMES.get(lang, lang),
        "ARRIVED ON"                        : arrival,
        "ON-HOLD date"                      : arrival,
        "STARTING/RECOVERING date"          : arrival,
        "PROCESSED ON"                      : today_str,
        "STATUS"                            : STATUS,
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quotation_code,
        "QUOTATION NAME"                    : quotation_name,
        "CUSTOMER"                          : customer,
        "DIVISION"                          : division,
    }

    print(f"    Quote Code  : {quotation_code}")
    print(f"    Quote Name  : {quotation_name}")
    print(f"    Customer    : {customer}")
    print(f"    Inside Sales: {inside_sales}")
    print(f"    Requested   : {requested_from}")
    print(f"    Arrived     : {arrival}")
    print(f"    Processed   : {today_str}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price (EUR) : {price}")
    print(f"    Product Type: {product_type}")

    return row




# ─────────────────────────────────────────────
#  GERMAN QUOTE EXTRACTION (DE / AT / CH)
# ─────────────────────────────────────────────

def process_pdf_de(pdf_path, arrived_date="", division="", today="", lang="DE"):
    """
    Extract fields from German-language Eaton quotes.
    Covers: Eaton Industries (Austria) GmbH, Eaton Electric GmbH (Bonn),
            Cellpack Power Systems AG (CH), and similar DE/AT/CH entities.

    Field patterns observed:
      Quote code : "Angebot Nr.:" / "Angebots-Nr.:" / "Unser Angebot Nr."
      Date       : "Datum:" + German month names
      Project    : "Projekt:" / "Projektname:" / "Objekt:"
      Salesman   : "Bearbeiter" block or "Ihre Ansprechpartner" — first name/email pair
      Price      : "Summe: EUR X" / "Gesamtpreis X" / "EUR X exkl. MWST"
                   German number format: 32.639,00 → 32639.00
      Valid until: "Bindefrist:" (binding period, not a date — skip)
                   Some have no explicit expiry date
      Customer   : not reliably labelled — use project name as quote name
    """
    import datetime

    DE_MONTHS = {
        "januar":1,"februar":2,"märz":3,"april":4,"mai":5,"juni":6,
        "juli":7,"august":8,"september":9,"oktober":10,"november":11,"dezember":12
    }

    def parse_de_date(text):
        """Parse German date formats: '16. Februar 2026' or '16.02.2026'"""
        # Written form: DD. Monthname YYYY
        m = re.search(r'(\d{1,2})\.\s+([A-Za-zä]+)\s+(\d{4})', text)
        if m:
            day, month_str, year = m.group(1), m.group(2).lower(), m.group(3)
            month = DE_MONTHS.get(month_str)
            if month:
                return f"{int(day):02d}/{month:02d}/{year}"
        # Numeric: DD.MM.YYYY
        m = re.search(r'(\d{1,2})\.(\d{1,2})\.(\d{4})', text)
        if m:
            return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
        return ""

    def parse_de_price(text):
        """Convert German number format: 32.639,00 → 32639.00"""
        # Find EUR/CHF amounts
        patterns = [
            r'Summe[:\s]+(?:EUR|CHF)\s*([\d\.]+,\d{2})',
            r'(?:EUR|CHF)\s+([\d\'\.]+[,\.]\d{2})\s+exkl',
            r'Gesamtpreis\s+(\d[\d\.]+,\d{2})',
            r'Total[:\s]+(?:EUR|CHF)?\s*([\d\.]+,\d{2})',
        ]
        for pat in patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                raw = m.group(1).replace("'", "").replace(".", "").replace(",", ".")
                try:
                    return str(round(float(raw), 2))
                except:
                    pass
        return ""

    all_text = ""
    page_texts = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                page_texts.append(t)
                all_text += t + "\n"
    except Exception as e:
        raise RuntimeError(f"Cannot read PDF: {e}")

    p1 = page_texts[0] if page_texts else ""

    # ── Quote code ────────────────────────────────────────────────────────────
    quote_code = ""
    for pat in [
        r'Angebots?-?Nr\.?:?\s*([^\s\n]+)',
        r'Unser Angebot Nr\.?\s+([^\s\n]+)',
        r'Angebot Nr\.?:?\s*([^\s\n]+)',
    ]:
        m = re.search(pat, all_text, re.IGNORECASE)
        if m:
            quote_code = m.group(1).strip().rstrip(".,")
            break

    # ── Project / quote name ──────────────────────────────────────────────────
    quote_name = ""
    for pat in [
        r'Projekt(?:name)?:\s*(.+)',
        r'Objekt:\s*(.+)',
    ]:
        m = re.search(pat, p1, re.IGNORECASE)
        if m:
            quote_name = m.group(1).strip()
            break

    # ── Issue date ───────────────────────────────────────────────────────────
    issue_date = ""
    m = re.search(r'Datum[:\s]+(.+)', p1, re.IGNORECASE)
    if m:
        issue_date = parse_de_date(m.group(1).strip())
    if not issue_date:
        issue_date = parse_de_date(p1)

    # ── Salesman ─────────────────────────────────────────────────────────────
    salesman = ""
    # Skip team/department mailboxes — they have no associated person name
    _DEPT_KW = {"projektierung", "design", "sales", "support", "info", "office",
                "service", "team", "ups", "technik", "vertrieb", "qualitat"}
    em = re.search(r'([\w.]+)@eaton\.com', p1) or re.search(r'([\w.]+)@eaton\.com', all_text)
    if em:
        _local_norm = em.group(1).lower().replace(".", "")
        if any(kw in _local_norm for kw in _DEPT_KW):
            em = None  # team mailbox — no person name to extract

    if em:
        local = em.group(1).lower().replace(".", "")  # e.g. "fabricestrevens"
        # Try to match against a "Firstname Lastname" pair appearing near the email
        for name_m in re.finditer(r'([A-Z][a-zäöüß]+ [A-Z][a-zäöüß]+)', p1):
            candidate = name_m.group(1)
            normalized = candidate.lower().replace(" ", "")
            if normalized in local or local in normalized:
                salesman = candidate
                break
        # Fallback: camelCase split if email has uppercase
        if not salesman:
            parts = re.findall(r'[A-Z][a-z]+', em.group(1))
            if len(parts) >= 2:
                salesman = " ".join(parts)
    # Cellpack CH: "Bearbeiter\n<Name>" header — single name on next line
    if not salesman:
        m = re.search(r'Bearbeiter\s*\n([^\n]+)', all_text, re.IGNORECASE)
        if m:
            # Two-column layout gives "CustomerName  OurName" — take last token
            parts = re.split(r'\s{2,}', m.group(1).strip())
            candidate = parts[-1].strip()
            # Validate: must look like a person name (Title Case, 2+ words)
            if re.match(r'[A-Z][a-zäöüß]+ [A-Z]', candidate):
                salesman = candidate
    # Austrian/German sign-off: "Freundliche Grüsse\n<Company>\n<Name>\n<Title>"
    if not salesman:
        m = re.search(
            r'Freundliche Gr[üu]sse[^\n]*\n[^\n]+\n\s*([A-Z][a-zäöüß]+(?:[ ]+[A-Z][a-zäöüß]+)+)',
            all_text, re.IGNORECASE
        )
        if m:
            salesman = m.group(1).strip()
    # Bonn style: name on line immediately before "e-mail" or "telefon" line
    if not salesman:
        m = re.search(r'([A-Z][a-zäöüß]+ [A-Z][a-zäöüß]+)\s*\n[^\n]*(?:e-mail|telefon)', p1, re.IGNORECASE)
        if m:
            salesman = m.group(1).strip()

    # ── Price ────────────────────────────────────────────────────────────────
    price = parse_de_price(all_text)

    # ── Valid-to date ────────────────────────────────────────────────────────
    valid_to = ""
    m = re.search(r'Bindefrist:\s*(\d+)\s*Monat', all_text, re.IGNORECASE)
    if m and issue_date:
        # Calculate validity end from issue date + binding period months
        try:
            months = int(m.group(1))
            parts = issue_date.split("/")
            d = datetime.date(int(parts[2]), int(parts[1]), int(parts[0]))
            month = d.month + months
            year = d.year + (month - 1) // 12
            month = ((month - 1) % 12) + 1
            valid_to = f"{d.day:02d}/{month:02d}/{year}"
        except:
            pass

    # ── CTO/DTO ──────────────────────────────────────────────────────────────
    # DE quotes are MV/Trafo — always CTO
    product_type = "Standard CTO"

    # ── Dates ────────────────────────────────────────────────────────────────
    arr  = arrived_date or issue_date
    proc = today or datetime.date.today().strftime("%d/%m/%Y")

    print(f"  Processing (DE): {os.path.basename(pdf_path)}")
    print(f"    Quote Code  : {quote_code}")
    print(f"    Quote Name  : {quote_name}")
    print(f"    Salesman    : {salesman}")
    print(f"    Arrived     : {arr}")
    print(f"    Processed   : {proc}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price (EUR) : {price}")
    print(f"    Product Type: {product_type}")

    return {
        "INSIDE SALES"                      : salesman,
        "SALESFORCE ID"                     : "",
        "REQUESTED FROM EATON (INTERNAL)"   : salesman,
        "COUNTRY"                           : COUNTRY_NAMES.get(lang, lang),
        "ARRIVED ON"                        : arr,
        "ON-HOLD date"                      : arr,
        "STARTING/RECOVERING date"          : arr,
        "PROCESSED ON"                      : proc,
        "STATUS"                            : "Processed",
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quote_code,
        "QUOTATION NAME"                    : quote_name,
        "CUSTOMER"                          : "",
        "DIVISION"                          : division,
    }


# ─────────────────────────────────────────────
#  ITALIAN QUOTE EXTRACTION (IT)
# ─────────────────────────────────────────────

def extract_xlsx_it(xlsx_path, arrived_date="", division="", today="", lang="IT"):
    """
    Extract fields directly from an Italian Eaton Excel quote (ISE-XX-XXXXX format).
    Reads computed cell values via data_only=True — avoids formula-blank PDF issue.

    Sheet layout (Offerta):
      R1  : ['Richiesta n°', '<code>', 'data:', <datetime>]
      R5  : ['Progetto:', '<name>', 'Compilato da:', '<salesman>']
      R7  : ['Agenzia:', '<customer>', ...]
      R31 : ['Totale offerta:', <float>]  ← computed total
    """
    import datetime, openpyxl

    try:
        wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    except Exception as e:
        raise RuntimeError(f"Cannot read xlsx: {e}")

    # Find the Offerta sheet (may have different name)
    sheet_name = None
    for name in wb.sheetnames:
        if "offerta" in name.lower() or "offer" in name.lower() or name.lower() == "sheet1":
            sheet_name = name
            break
    if not sheet_name:
        sheet_name = wb.sheetnames[0]
    ws = wb[sheet_name]

    rows = list(ws.iter_rows(values_only=True))

    def cell(r, c):
        """0-indexed row, 0-indexed col"""
        try:
            return rows[r][c]
        except:
            return None

    def find_row(keyword):
        """Find first row index where any cell contains keyword (case-insensitive)"""
        kw = keyword.lower()
        for i, row in enumerate(rows):
            for v in row:
                if isinstance(v, str) and kw in v.lower():
                    return i
        return -1

    # ── Quote code ────────────────────────────────────────────────────────────
    quote_code = ""
    ri = find_row("richiesta")
    if ri >= 0:
        # Value is in next non-None cell after 'Richiesta n°'
        for v in rows[ri]:
            if isinstance(v, str) and v.strip() and "richiesta" not in v.lower():
                quote_code = v.strip()
                break
    # Normalise: remove trailing suffix like " EME_Final"
    quote_code = re.sub(r'\s+\S+$', '', quote_code).strip() if " " in quote_code else quote_code

    # ── Date ──────────────────────────────────────────────────────────────────
    issue_date = ""
    if ri >= 0:
        for v in rows[ri]:
            if isinstance(v, datetime.datetime):
                issue_date = v.strftime("%d/%m/%Y")
                break

    # ── Project & salesman ────────────────────────────────────────────────────
    quote_name = ""
    salesman = ""
    pi = find_row("progetto")
    if pi >= 0:
        r = rows[pi]
        # Row: ['Progetto:', '<name>', 'Compilato da:', '<salesman>', ...]
        vals = [v for v in r if v is not None and str(v).strip()]
        for j, v in enumerate(vals):
            if isinstance(v, str) and "progetto" in v.lower():
                if j + 1 < len(vals):
                    quote_name = str(vals[j + 1]).strip()
            if isinstance(v, str) and "compilato" in v.lower():
                if j + 1 < len(vals):
                    salesman = str(vals[j + 1]).strip()

    # ── Customer ──────────────────────────────────────────────────────────────
    customer = ""
    ai = find_row("agenzia")
    if ai >= 0:
        r = rows[ai]
        vals = [v for v in r if v is not None and str(v).strip()]
        for j, v in enumerate(vals):
            if isinstance(v, str) and "agenzia" in v.lower():
                if j + 1 < len(vals):
                    customer = str(vals[j + 1]).strip().rstrip(".")
                break

    # ── Total price ───────────────────────────────────────────────────────────
    price = ""
    ti = find_row("totale offerta")
    if ti >= 0:
        for v in rows[ti]:
            if isinstance(v, (int, float)) and v and v > 0:
                price = str(round(float(v), 2))
                break

    # ── Valid-to ──────────────────────────────────────────────────────────────
    valid_to = ""
    vi = find_row("validità")
    if vi >= 0:
        for v in rows[vi]:
            if isinstance(v, str) and v.strip() and "validità" not in v.lower():
                dm = re.search(r'(\d{1,2})[/\.\-](\d{1,2})[/\.\-](\d{2,4})', v)
                if dm:
                    d, mo, y = dm.group(1), dm.group(2), dm.group(3)
                    if len(y) == 2: y = "20" + y
                    valid_to = f"{int(d):02d}/{int(mo):02d}/{y}"
                break

    # ── CTO/DTO ───────────────────────────────────────────────────────────────
    # EL quotes (cgline, lampade, centrale) → DTO; switchgear/MV → CTO
    all_text = " ".join(str(v) for row in rows for v in row if v).lower()
    cto_kw = ["quadro", "switchgear", "trasformatore", "mv", "pannello"]
    product_type = "Standard CTO" if any(k in all_text for k in cto_kw) else "DTO"

    arr  = arrived_date or issue_date
    proc = today or datetime.date.today().strftime("%d/%m/%Y")

    print(f"  Processing (IT xlsx): {os.path.basename(xlsx_path)}")
    print(f"    Quote Code  : {quote_code}")
    print(f"    Quote Name  : {quote_name}")
    print(f"    Customer    : {customer}")
    print(f"    Salesman    : {salesman}")
    print(f"    Arrived     : {arr}")
    print(f"    Processed   : {proc}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price (EUR) : {price}")
    print(f"    Product Type: {product_type}")

    return {
        "INSIDE SALES"                      : salesman,
        "SALESFORCE ID"                     : "",
        "REQUESTED FROM EATON (INTERNAL)"   : salesman,
        "COUNTRY"                           : COUNTRY_NAMES.get(lang, lang),
        "ARRIVED ON"                        : arr,
        "ON-HOLD date"                      : arr,
        "STARTING/RECOVERING date"          : arr,
        "PROCESSED ON"                      : proc,
        "STATUS"                            : "Processed",
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quote_code,
        "QUOTATION NAME"                    : quote_name,
        "CUSTOMER"                          : customer,
        "DIVISION"                          : division,
    }


def process_pdf_it(pdf_path, arrived_date="", division="", today="", lang="IT"):
    """
    Extract fields from Italian-language Eaton quotes.
    Covers: ISE-XX-XXXXX Excel-based quotes (converted to PDF).

    Field patterns observed:
      Quote code : "Richiesta n°" / "ISE-XX-XXXXX"
      Date       : "data:" + DD/MM/YYYY or datetime
      Project    : "Progetto:"
      Salesman   : "Compilato da:"
      Customer   : "Spett.le:" (addressee) or "Agenzia:"
      Price      : "Totale offerta:" or "Totale:" or last numeric total
      Valid until: "Validità offerta:"
    """
    import datetime

    all_text = ""
    page_texts = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                page_texts.append(t)
                all_text += t + "\n"
    except Exception as e:
        raise RuntimeError(f"Cannot read PDF: {e}")

    p1 = page_texts[0] if page_texts else ""

    # ── Quote code ────────────────────────────────────────────────────────────
    quote_code = ""
    m = re.search(r'Richiesta\s+n[°o]?\s*[:\s]*(ISE-[\w-]+)', all_text, re.IGNORECASE)
    if m:
        quote_code = m.group(1).strip()
    if not quote_code:
        m = re.search(r'\b(ISE-\d{2}-\d+[\w]*)\b', all_text)
        if m:
            quote_code = m.group(1).strip()

    # ── Project / quote name ──────────────────────────────────────────────────
    quote_name = ""
    m = re.search(r'Progetto:\s*(.+)', p1, re.IGNORECASE)
    if m:
        quote_name = m.group(1).strip()

    # ── Salesman ─────────────────────────────────────────────────────────────
    salesman = ""
    m = re.search(r'Compilato\s+da:\s*(.+)', all_text, re.IGNORECASE)
    if m:
        salesman = m.group(1).strip()

    # ── Customer ─────────────────────────────────────────────────────────────
    customer = ""
    # "Agenzia:" is the agency/distributor — use that
    m = re.search(r'Agenzia:\s*(.+)', p1, re.IGNORECASE)
    if m:
        customer = m.group(1).strip().rstrip(".")
    # Fallback: "Spett.le:" line
    if not customer:
        m = re.search(r'Spett\.le:\s*(.+)', p1, re.IGNORECASE)
        if m:
            val = m.group(1).strip()
            if val:
                customer = val

    # ── Issue date ───────────────────────────────────────────────────────────
    issue_date = ""
    m = re.search(r'data[:\s]+(\d{1,2}[/\.\-]\d{1,2}[/\.\-]\d{2,4})', all_text, re.IGNORECASE)
    if m:
        raw = m.group(1).replace(".", "/").replace("-", "/")
        parts = raw.split("/")
        if len(parts) == 3:
            d, mo, y = parts
            if len(y) == 2:
                y = "20" + y
            issue_date = f"{int(d):02d}/{int(mo):02d}/{y}"

    # ── Valid-to ──────────────────────────────────────────────────────────────
    valid_to = ""
    m = re.search(r'[Vv]alidit[àa]\s+offerta[:\s]*(.+)', all_text)
    if m:
        val = m.group(1).strip()
        # Could be a duration like "30 giorni" or a date
        dm = re.search(r'(\d{1,2})[/\.\-](\d{1,2})[/\.\-](\d{2,4})', val)
        if dm:
            d, mo, y = dm.group(1), dm.group(2), dm.group(3)
            if len(y) == 2: y = "20" + y
            valid_to = f"{int(d):02d}/{int(mo):02d}/{y}"

    # ── Price ────────────────────────────────────────────────────────────────
    price = ""
    for pat in [
        r'[Tt]otale\s+offerta[:\s]*([\d\.,]+)',
        r'[Tt]otale[:\s]+([\d\.,]+)',
        r'TOTALE[:\s]+([\d\.,]+)',
    ]:
        m = re.search(pat, all_text)
        if m:
            raw = m.group(1).strip()
            # Italian format: 1.234,56 or 1234.56
            if "," in raw and "." in raw:
                raw = raw.replace(".", "").replace(",", ".")
            elif "," in raw:
                raw = raw.replace(",", ".")
            try:
                price = str(round(float(raw), 2))
                break
            except:
                pass

    # ── CTO/DTO ──────────────────────────────────────────────────────────────
    # IT EL quotes: check for CGLine+, centrali, lampade → EL → DTO default
    cto_keywords = ["quadro", "switchgear", "trasformatore", "mv", "bt", "pannello"]
    product_type = "Standard CTO" if any(kw in all_text.lower() for kw in cto_keywords) else "DTO"

    # ── Dates ────────────────────────────────────────────────────────────────
    arr  = arrived_date or issue_date
    proc = today or datetime.date.today().strftime("%d/%m/%Y")

    print(f"  Processing (IT): {os.path.basename(pdf_path)}")
    print(f"    Quote Code  : {quote_code}")
    print(f"    Quote Name  : {quote_name}")
    print(f"    Customer    : {customer}")
    print(f"    Salesman    : {salesman}")
    print(f"    Arrived     : {arr}")
    print(f"    Processed   : {proc}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price (EUR) : {price}")
    print(f"    Product Type: {product_type}")

    return {
        "INSIDE SALES"                      : salesman,
        "SALESFORCE ID"                     : "",
        "REQUESTED FROM EATON (INTERNAL)"   : salesman,
        "COUNTRY"                           : COUNTRY_NAMES.get(lang, lang),
        "ARRIVED ON"                        : arr,
        "ON-HOLD date"                      : arr,
        "STARTING/RECOVERING date"          : arr,
        "PROCESSED ON"                      : proc,
        "STATUS"                            : "Processed",
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quote_code,
        "QUOTATION NAME"                    : quote_name,
        "CUSTOMER"                          : customer,
        "DIVISION"                          : division,
    }


def process_pdf_be(pdf_path, arrived_date="", division="", today="", lang="BE"):
    """
    Extract fields from Belgian UPS quotes (EU4E... reference prefix).
    Layout: Eaton UK header block → customer address → PROJECT REFERENCE → Quotation Reference.
    """
    print(f"  Processing (BE): {os.path.basename(pdf_path)}")

    with pdfplumber.open(pdf_path) as pdf:
        page1_text = pdf.pages[0].extract_text() or ""
        bom_text = "\n".join(
            (pdf.pages[i].extract_text() or "") for i in range(1, len(pdf.pages))
        )
    all_text = page1_text + "\n" + bom_text

    # Quotation code: "Quotation Reference: EU4E0107X6K1 R4" → strip revision suffix
    code_m = re.search(r'Quotation Reference:\s*(\S+)', page1_text, re.IGNORECASE)
    quotation_code = code_m.group(1).strip() if code_m else ""

    # Issue date
    raw_date = extract_field(page1_text, r"Quotation Date:\s*([\d/]+)")
    issue_date = normalise_date(raw_date) if raw_date else ""

    # PROJECT REFERENCE may span 2 lines; next line may start with "Diegem Quotation Reference:"
    quotation_name = ""
    _p1_lines = page1_text.splitlines()
    for _i, _ln in enumerate(_p1_lines):
        if re.search(r'PROJECT REFERENCE:', _ln, re.IGNORECASE):
            _part1 = re.sub(r'PROJECT REFERENCE:\s*', '', _ln, flags=re.IGNORECASE).strip()
            if _part1:
                quotation_name = _part1
            # Check next line: if it starts before "Quotation Reference:", prepend that prefix
            if _i + 1 < len(_p1_lines):
                _nxt = _p1_lines[_i + 1].strip()
                _qm = re.search(r'^(.+?)\s*Quotation Reference:', _nxt, re.IGNORECASE)
                if _qm and _qm.group(1).strip():
                    quotation_name = (quotation_name + " " + _qm.group(1).strip()).strip()
            break

    # Customer: first non-empty line after Eaton's "Web:" line
    customer = ""
    lines = page1_text.splitlines()
    past_web = False
    for line in lines:
        stripped = line.strip()
        if re.search(r'web\s*:', stripped, re.IGNORECASE) or "www.eaton.com" in stripped.lower():
            past_web = True
            continue
        if past_web and stripped and not stripped.startswith("(") and stripped.lower() not in ("quotation",):
            customer = stripped
            break

    # Valid-to
    raw_valid = (
        extract_field(all_text, r"Quotation Valid to:\s*([\d/]+)")
        or extract_field(all_text, r"Valid To\s+([\d/]+)")
    )
    valid_to = normalise_date(raw_valid) if raw_valid else ""

    # Salesman: "Yours sincerely,\n<Name>" sign-off (page 2+)
    salesman = ""
    m_ys = re.search(r'Yours sincerely[,\s]*\n\s*([A-Z][a-z]+ [A-Z][a-z]+)', all_text, re.IGNORECASE)
    if m_ys:
        salesman = m_ys.group(1).strip()

    # Price
    price = extract_total_price(bom_text) or extract_total_price(all_text)
    product_type = determine_product_type(all_text)

    from datetime import date as _date
    today_str = today if today else _date.today().strftime("%d/%m/%Y")
    arrival = arrived_date if arrived_date else issue_date

    print(f"    Quote Code  : {quotation_code}")
    print(f"    Quote Name  : {quotation_name}")
    print(f"    Customer    : {customer}")
    print(f"    Salesman    : {salesman}")
    print(f"    Arrived     : {arrival}")
    print(f"    Processed   : {today_str}")
    print(f"    Valid To    : {valid_to}")
    print(f"    Price (EUR) : {price}")
    print(f"    Product Type: {product_type}")

    return {
        "INSIDE SALES"                      : salesman,
        "SALESFORCE ID"                     : "",
        "REQUESTED FROM EATON (INTERNAL)"   : salesman,
        "COUNTRY"                           : "BELGIUM",
        "ARRIVED ON"                        : arrival,
        "ON-HOLD date"                      : arrival,
        "STARTING/RECOVERING date"          : arrival,
        "PROCESSED ON"                      : today_str,
        "STATUS"                            : STATUS,
        "PRICE [EUR]"                       : price,
        "Due date"                          : valid_to,
        "Request type"                      : product_type,
        "PRODUCT"                           : product_type,
        "QUOTATION CODE"                    : quotation_code,
        "QUOTATION NAME"                    : quotation_name,
        "CUSTOMER"                          : customer,
        "DIVISION"                          : division,
    }


# Register extractor functions per language
EXTRACTORS["UK"] = process_pdf
EXTRACTORS["BE"] = process_pdf_be
EXTRACTORS["FR"] = process_pdf_fr
EXTRACTORS["DE"] = process_pdf_de
EXTRACTORS["IT"] = process_pdf_it

# ─────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────

def run_suggest_division():
    """Lightweight pass over the queued files: detect each file's language and,
    for French quotes, suggest a Product-line (DIVISION) code. Prints JSON and
    does NOT write the CSV. Used by the UI to pre-fill the product picker."""
    input_files, _tmp_dir = collect_input_files(PDF_FOLDER)
    per_file = []
    try:
        for pdf_path, orig_name, _was_conv, _x, _orig in input_files:
            lang, suggestion = "", ""
            try:
                with pdfplumber.open(pdf_path) as _pdf:
                    p1 = _pdf.pages[0].extract_text() or ""
                    # a few pages are enough to fingerprint the product line
                    blob = "\n".join((_pdf.pages[i].extract_text() or "") for i in range(min(6, len(_pdf.pages))))
                lang = detect_language(p1, filename=orig_name or "")
                suggestion = detect_division(lang, blob)
            except Exception:
                pass
            per_file.append({"name": orig_name, "lang": lang, "suggestion": suggestion})
    finally:
        try:
            if _tmp_dir and os.path.exists(_tmp_dir):
                shutil.rmtree(_tmp_dir, ignore_errors=True)
        except Exception:
            pass

    # Aggregate to one batch suggestion: any FIRE+EL mix → "EL & FIRE",
    # otherwise the single distinct non-empty value, else "".
    vals = {f["suggestion"] for f in per_file if f["suggestion"]}
    flat = set()
    for v in vals:
        flat.update(v.split(" & "))
    if {"EL", "FIRE"}.issubset(flat):
        agg = "EL & FIRE"
    elif len(vals) == 1:
        agg = next(iter(vals))
    elif len(flat) == 1:
        agg = next(iter(flat))
    else:
        agg = ""
    print("__SUGGEST__:" + json.dumps({"suggestion": agg, "perFile": per_file}))


if __name__ == "__main__":
    if "--suggest" in sys.argv:
        run_suggest_division()
        sys.exit(0)

    MAGIC_ARRIVED  = os.environ.get("MAGIC_ARRIVED",  "").strip()
    MAGIC_DIVISION = os.environ.get("MAGIC_DIVISION", "").strip()
    MAGIC_TODAY    = os.environ.get("MAGIC_TODAY",    "").strip()  # DD/MM/YYYY from browser
    # Per-file product line overrides from the UI: {filename: division}
    try:
        MAGIC_DIVISION_MAP = json.loads(os.environ.get("MAGIC_DIVISION_MAP", "") or "{}")
        if not isinstance(MAGIC_DIVISION_MAP, dict):
            MAGIC_DIVISION_MAP = {}
    except Exception:
        MAGIC_DIVISION_MAP = {}

    # Check LibreOffice availability upfront — needed for Word/Excel conversion
    if find_libreoffice():
        print(f"[*] LibreOffice found — Word/Excel conversion enabled")
    else:
        print(f"[WARN] LibreOffice not found — only PDF files will be processed")
        print(f"[WARN] Install from: https://www.libreoffice.org/download/libreoffice/")
        print(f"[WARN] Word (.docx/.dotm) and Excel (.xlsx/.xlsm) files will be SKIPPED")

    # Collect PDFs + convert Word/Excel files to PDF automatically
    input_files, _tmp_dir = collect_input_files(PDF_FOLDER)

    if not input_files:
        print(f"[!] No processable files found in: {PDF_FOLDER}")
        print("    Supported: .pdf .PDF .docx .dotm .doc .xlsx .xlsm .xls")
        sys.exit(0)

    if MAGIC_ARRIVED:
        print(f"[*] Arrival date : {MAGIC_ARRIVED}")
    else:
        print(f"[*] Arrival date : (using quote issue date)")
    if MAGIC_DIVISION:
        print(f"[*] Division     : {MAGIC_DIVISION}")
    print(f"[*] Found {len(input_files)} file(s) to process in {PDF_FOLDER}\n")

    rows = []
    errors = []

    for pdf_path, orig_name, was_converted, _, orig_path in input_files:
        display_name = f"{orig_name} → PDF" if was_converted else orig_name
        orig_ext = os.path.splitext(orig_name)[1].lower() if orig_name else ""
        try:
            # Auto-detect language from converted/native PDF page 1
            with pdfplumber.open(pdf_path) as _pdf:
                _p1 = _pdf.pages[0].extract_text() or ""
            lang = detect_language(_p1, filename=orig_name or "")
            print(f"  [{display_name}] → Detected language: {lang}")

            country = COUNTRY_NAMES.get(lang, lang)

            # ── Try Azure Document Intelligence (optional, skipped if not installed) ──
            row = None
            try:
                from azure_extractor import extract_with_azure
                source_file = orig_path if orig_path else pdf_path
                row = extract_with_azure(
                    source_file,
                    arrived_date=MAGIC_ARRIVED,
                    division=MAGIC_DIVISION,
                    today=MAGIC_TODAY,
                    country=country,
                )
            except ImportError:
                pass  # azure_extractor not available — use local extractors below

            # ── Local extractors ───────────────────────────────────────────
            if row is None:
                if lang == "IT" and orig_ext in (".xlsx", ".xls", ".xlsm") and orig_path:
                    from xlsx_extractor import extract_italian_xlsx
                    q = extract_italian_xlsx(orig_path)
                    d = q.to_dict()
                    row = {
                        "INSIDE SALES"                    : d.get("contact_name") or "",
                        "SALESFORCE ID"                   : "",
                        "REQUESTED FROM EATON (INTERNAL)" : d.get("contact_name") or "",
                        "COUNTRY"                         : COUNTRY_NAMES.get("IT", "ITALY"),
                        "ARRIVED ON"                      : MAGIC_ARRIVED or d.get("quote_date") or "",
                        "ON-HOLD date"                    : MAGIC_ARRIVED or d.get("quote_date") or "",
                        "STARTING/RECOVERING date"        : MAGIC_ARRIVED or d.get("quote_date") or "",
                        "PROCESSED ON"                    : MAGIC_TODAY or "",
                        "STATUS"                          : "Processed",
                        "PRICE [EUR]"                     : str(d.get("total_net") or ""),
                        "Due date"                        : d.get("validity_date") or "",
                        "Request type"                    : "DTO",
                        "PRODUCT"                         : "DTO",
                        "QUOTATION CODE"                  : d.get("quote_reference") or "",
                        "QUOTATION NAME"                  : d.get("customer_address") or "",
                        "CUSTOMER"                        : d.get("customer_name") or "",
                        "DIVISION"                        : MAGIC_DIVISION,
                    }
                else:
                    extractor = EXTRACTORS.get(lang, process_pdf)
                    row = extractor(pdf_path, arrived_date=MAGIC_ARRIVED, division=MAGIC_DIVISION, today=MAGIC_TODAY)
                    if lang != "UK":
                        row["COUNTRY"] = country

            # ── Per-file PRODUCT LINE (DIVISION) ──────────────────────────────
            # Precedence: explicit per-file override from the UI (MAGIC_DIVISION_MAP,
            # keyed by filename) > batch force-all (MAGIC_DIVISION) > auto-detect.
            # So a bulk of mixed quotes uploads each with its own correct line, and
            # the user can fix any mis-read/undetected line from the dropdown.
            file_override = MAGIC_DIVISION_MAP.get(orig_name) or MAGIC_DIVISION_MAP.get(display_name)
            if file_override:
                row["DIVISION"] = file_override
                print(f"    Division    : {file_override} (user-set)")
            elif not MAGIC_DIVISION and lang in ("FR", "DE", "IT"):
                try:
                    with pdfplumber.open(pdf_path) as _pdf:
                        _blob = "\n".join((_pdf.pages[i].extract_text() or "")
                                          for i in range(min(6, len(_pdf.pages))))
                    auto_div = detect_division(lang, _blob)
                    if auto_div:
                        row["DIVISION"] = auto_div
                        print(f"    Division    : {auto_div} (auto-detected)")
                except Exception:
                    pass

            rows.append(row)
            print(f"    [OK]\n")
        except Exception as e:
            print(f"    [ERR] Failed: {e}\n")
            errors.append((display_name, str(e)))

    # Clean up temp conversion dir
    try:
        if _tmp_dir and os.path.exists(_tmp_dir):
            shutil.rmtree(_tmp_dir, ignore_errors=True)
    except Exception:
        pass

    # Write CSV
    with open(CSV_OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"{'='*50}")
    print(f"  Done! {len(rows)} row(s) written to:")
    print(f"  {CSV_OUTPUT}")
    if errors:
        print(f"\n  {len(errors)} file(s) failed:")
        for name, err in errors:
            print(f"    - {name}: {err}")
    print(f"{'='*50}\n")

