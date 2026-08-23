"""
SharePoint CSV Uploader
=======================
Reads QuoteExtra.csv and uploads each row to the Eaton SharePoint list.

SETUP (run once in terminal):
    pip install requests

USAGE:
    1. Paste fresh FedAuth + rtFa cookies below when they expire (~24h)
    2. Run:  python sharepoint_upload.py
    3. First run with empty COLUMN_MAP will print all SharePoint columns
       so you can fill in the mapping, then run again to upload.

HOW TO REFRESH COOKIES:
    1. Log into https://eaton.sharepoint.com in Chrome/Edge
    2. Press F12 -> Application -> Cookies -> https://eaton.sharepoint.com
    3. Copy FedAuth value and rtFa value and paste below
"""

import csv
import json
import os
import re
import shutil
import io
import sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import sys
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────

# ── Paths — read from config.json next to this script ────────────────────────
def _load_cfg():
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    base = os.path.join(os.path.expanduser("~"), "Desktop", "EatonAutomation")
    try:
        cfg = json.loads(open(cfg_path, encoding="utf-8").read())
        base = cfg.get("base", base)
    except Exception:
        pass
    return base

_BASE      = _load_cfg()
CSV_PATH   = os.path.join(_BASE, "QuoteExtra.csv")
PDF_FOLDER = os.path.join(_BASE, "PDF Quotes")

SITE_URL  = "https://eaton.sharepoint.com/sites/QuotationFactoryEMEA"
LIST_NAME = "Quotations List"

# Cookies — auto-refreshed by "Connect to JOE" (refresh_cookies.py).
# Stored encrypted at rest in .cookies.enc; loaded here via cookie_crypto.
# Do not paste cookies here; run Connect to JOE instead.
FED_AUTH = ""
RT_FA = ""
try:
    from cookie_crypto import load_cookies as _load_cookies
    _f, _r = _load_cookies()
    if _f and _r:
        FED_AUTH, RT_FA = _f, _r
except Exception as _e:
    print(f"[WARN] cookie_crypto load failed: {_e}")

# ─────────────────────────────────────────────
#  COLUMN MAPPING
#  Left  = SharePoint internal column name
#  Right = your CSV header (exact match)
#
#  Leave empty {} on first run — the script will
#  print all available SharePoint columns so you
#  can fill this in, then run again to upload.
# ─────────────────────────────────────────────

COLUMN_MAP = {
    # SharePoint Internal Name              : CSV Header
    "Title"                               : "QUOTATION CODE",
    "SALESFORCEID"                        : "SALESFORCE ID",
    "Country"                             : "COUNTRY",
    "ARRIVED_x0020_ON"                    : "ARRIVED ON",
    "ON_x002d_HOLD_x0020_date"            : "ON-HOLD date",
    "RECOVERING_x0020_date_x0020_"        : "STARTING/RECOVERING date",
    "SENT_x0020_ON_x0020_"                : "PROCESSED ON",
    "PRICE"                               : "PRICE [EUR]",
    "DUEDATE"                             : "Due date",
    "REQUEST_x0020_TYPE"                  : "PRODUCT",
    "DIVISION"                            : "DIVISION",      # from UI selection via CSV
    "QUOTATION_x0020_NAME"               : "QUOTATION NAME",
    "CUSTOMER"                            : "CUSTOMER",
}

TIMEOUT = 20  # seconds — fails fast instead of hanging

# ─────────────────────────────────────────────
#  SCRIPT — no need to edit below this line
# ─────────────────────────────────────────────

def get_session():
    s = requests.Session()
    s.cookies.set("FedAuth", FED_AUTH, domain="eaton.sharepoint.com")
    s.cookies.set("rtFa",    RT_FA,    domain="eaton.sharepoint.com")
    s.headers.update({"Accept": "application/json;odata=verbose"})
    s.verify = False  # Bypass corporate SSL inspection
    return s


def get_digest(session):
    url = f"{SITE_URL}/_api/contextinfo"
    try:
        r = session.post(url, timeout=TIMEOUT)
    except requests.exceptions.Timeout:
        print("[ERR] Timed out. Check your network / VPN.")
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        print(f"[ERR] Connection error: {e}")
        sys.exit(1)
    if r.status_code == 403:
        print("[ERR] 403 Forbidden — cookies have expired or are incomplete.")
        print("   -> F12 -> Application -> Cookies -> copy fresh FedAuth + rtFa values.")
        sys.exit(1)
    if r.status_code != 200:
        print(f"[ERR] Auth failed (HTTP {r.status_code}).")
        sys.exit(1)
    digest = r.json()["d"]["GetContextWebInformation"]["FormDigestValue"]
    print(f"[OK] Connected! Digest acquired.")
    return digest


def get_list_metadata(session):
    url = f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')"
    r = session.get(url, timeout=TIMEOUT)
    if r.status_code == 404:
        print(f"[ERR] List '{LIST_NAME}' not found. Check LIST_NAME in the config.")
        sys.exit(1)
    if r.status_code != 200:
        print(f"[ERR] Could not get list metadata (HTTP {r.status_code}).")
        sys.exit(1)
    entity_type = r.json()["d"]["ListItemEntityTypeFullName"]
    print(f"[OK] List found. Entity type: {entity_type}")
    return entity_type


def get_field_choices(session, field_internal_name):
    """Fetch allowed choice values for any field using the working URL format."""
    try:
        url = (f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')/fields"
               f"?$filter=InternalName eq '{field_internal_name}'&$select=Title,InternalName,Choices")
        r = session.get(url, timeout=TIMEOUT)
        if r.status_code == 200:
            results = r.json()["d"]["results"]
            if results and "Choices" in results[0]:
                return results[0]["Choices"].get("results", [])
    except Exception:
        pass
    return []


def discover_columns(session):
    url = (
        f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')/fields"
        f"?$filter=Hidden eq false and ReadOnlyField eq false"
        f"&$select=Title,InternalName,TypeAsString"
    )
    r = session.get(url, timeout=TIMEOUT)
    if r.status_code != 200:
        print(f"[ERR] Could not fetch columns (HTTP {r.status_code}).")
        sys.exit(1)
    cols = r.json()["d"]["results"]

    print("\n" + "=" * 70)
    print(f"  SharePoint columns in '{LIST_NAME}'")
    print("=" * 70)
    print(f"  {'Display Name':<30} {'Internal Name':<28} {'Type'}")
    print("-" * 70)
    for c in cols:
        print(f"  {c['Title']:<30} {c['InternalName']:<28} {c['TypeAsString']}")
    print("=" * 70)
    print("\nYour CSV headers:")
    print("  " + ", ".join(CSV_HEADERS))
    print("\n-> Copy the Internal Names into COLUMN_MAP at the top of this script.")
    print("-> Then run again to upload.\n")


def read_csv():
    rows = []
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(dict(row))
    return rows


DATE_COLUMNS = {
    "ARRIVED_x0020_ON",
    "ON_x002d_HOLD_x0020_date",
    "RECOVERING_x0020_date_x0020_",
    "SENT_x0020_ON_x0020_",
    "DUEDATE",
}

def convert_date(val):
    """Convert DD/MM/YYYY to ISO 8601 for SharePoint date fields.
    Returns None for empty/invalid values so SharePoint accepts null."""
    if val and "/" in val and len(val) == 10:
        try:
            d, m, y = val.split("/")
            return f"{y}-{m}-{d}T00:00:00Z"
        except ValueError:
            pass
    return None



# Cache: name(lower) -> SharePoint user Id, resolved once per run
_USER_ID_CACHE = {}


def _norm_tokens(s):
    """Lowercase, accent-stripped, punctuation-free token SET of a name.

    'Régis GRANDAUD' and 'Grandaud, Regis' both -> {'grandaud', 'regis'}.
    """
    import unicodedata
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # drop accents
    s = re.sub(r"[^a-zA-Z0-9 ]", " ", s).lower()
    return {t for t in s.split() if t}


def _pp_queries(name):
    """Query strings to feed the people-picker, surname-only first.

    The Eaton directory stores 'Lastname, Firstname' and does NOT match two
    free-text tokens (e.g. 'Omar Labbas' -> 0 hits), but a single surname token
    resolves cleanly. So we try each token alone, then the full string.
    """
    name = name.strip()
    parts = name.split()
    seen, out = set(), []
    # individual tokens, longest first (surname usually longest / most distinctive)
    for tok in sorted(parts, key=len, reverse=True):
        if tok.lower() not in seen:
            seen.add(tok.lower()); out.append(tok)
    if name.lower() not in seen:
        out.append(name)
    return out


def _resolve_via_siteusers(session, name):
    """Exact display-name match against users already in the site collection."""
    url = f"{SITE_URL}/_api/web/siteusers?$select=Id,Title&$top=500"
    r = session.get(url, timeout=TIMEOUT)
    target = _norm_tokens(name)
    for u in r.json().get("d", {}).get("results", []):
        if _norm_tokens(u.get("Title")) == target:
            return u["Id"]
    return None


def _resolve_via_peoplepicker(session, name, digest):
    """Search the directory via the people-picker, confirm the candidate's name
    tokens match (so a multi-hit surname can't grab the wrong person), then
    ensureuser() to obtain a usable site User Id."""
    if not digest:
        return None
    headers = {
        "Accept":          "application/json;odata=verbose",
        "Content-Type":    "application/json;odata=verbose",
        "X-RequestDigest": digest,
    }
    search_url = (f"{SITE_URL}/_api/SP.UI.ApplicationPages."
                  "ClientPeoplePickerWebServiceInterface.ClientPeoplePickerSearchUser")
    want = _norm_tokens(name)
    matches = {}  # login -> display, deduped across queries
    for query in _pp_queries(name):
        params = {"queryParams": {
            "__metadata": {"type": "SP.UI.ApplicationPages.ClientPeoplePickerQueryParameters"},
            "AllowEmailAddresses":      True,
            "AllowMultipleEntities":    False,
            "MaximumEntitySuggestions": 20,
            "PrincipalSource":          15,   # All sources (UserInfo + Windows + AD)
            "PrincipalType":            1,    # User only
            "QueryString":              query,
        }}
        try:
            r = session.post(search_url, json=params, headers=headers, timeout=TIMEOUT)
            raw = r.json().get("d", {}).get("ClientPeoplePickerSearchUser")
            if not raw:
                continue
            for e in json.loads(raw):
                if not e.get("IsResolved"):
                    continue
                login = e.get("Key")
                ed = e.get("EntityData") or {}
                # Match on the full name token-set; emails are reliable too.
                cand = _norm_tokens(e.get("DisplayText")) | _norm_tokens(ed.get("Email"))
                if login and want and want.issubset(cand):
                    matches[login] = e.get("DisplayText")
        except (requests.exceptions.RequestException, ValueError, KeyError):
            continue
        if len(matches) == 1:  # unambiguous hit — stop early
            break

    if len(matches) != 1:
        if len(matches) > 1:
            print(f"  [!] Ambiguous people-picker match for '{name}': {list(matches.values())}")
        return None
    login = next(iter(matches))
    try:
        er = session.post(f"{SITE_URL}/_api/web/ensureuser",
                          json={"logonName": login}, headers=headers, timeout=TIMEOUT)
        if er.status_code in (200, 201):
            return er.json()["d"]["Id"]
        print(f"  [!] ensureuser failed for '{login}': HTTP {er.status_code}")
    except (requests.exceptions.RequestException, ValueError, KeyError) as e:
        print(f"  [!] ensureuser error for '{login}': {e}")
    return None


def get_user_id(session, name, digest=None):
    """Resolve a people-picker (REQUESTED FROM) name to a SharePoint User Id.

    Tries: cache -> existing siteusers -> people-picker directory search.
    Handles AD users not yet in the site, reversed 'LAST FIRST' quote names,
    and the directory's 'Lastname, Firstname' display format.
    """
    key = name.strip().lower()
    if not key:
        return None
    if key in _USER_ID_CACHE:
        return _USER_ID_CACHE[key]

    uid = _resolve_via_siteusers(session, name) or _resolve_via_peoplepicker(session, name, digest)
    if uid:
        print(f"  [OK] Resolved user '{name}' -> ID {uid}")
        _USER_ID_CACHE[key] = uid
        return uid
    print(f"  [!] User not found: {name}")
    return None


# Lookup list ID + field for INSIDE SALES (known from discovery)
INSIDE_SALES_LIST_ID = "279ca0ff-8092-427a-a764-ea831289dde9"
INSIDE_SALES_FIELD   = "INSIDE_x0020_SALES"

# Cache: name(lower) -> id, so we resolve/create each name once per run
_INSIDE_SALES_CACHE = {}


def get_inside_sales_id(session, name):
    """Find the lookup ID for INSIDE SALES by matching display name (no create)."""
    key = name.strip().lower()
    if key in _INSIDE_SALES_CACHE:
        return _INSIDE_SALES_CACHE[key]
    url = (f"{SITE_URL}/_api/web/lists(guid'{INSIDE_SALES_LIST_ID}')/items"
           f"?$select=Id,{INSIDE_SALES_FIELD}&$top=500")
    r = session.get(url, timeout=TIMEOUT)
    for item in r.json().get("d", {}).get("results", []):
        val = (item.get(INSIDE_SALES_FIELD) or "").strip().lower()
        if val == key:
            print(f"  [OK] Resolved INSIDE SALES '{name}' -> ID {item['Id']}")
            _INSIDE_SALES_CACHE[key] = item["Id"]
            return item["Id"]
    return None


def _inside_sales_entity_type(session):
    """ListItemEntityTypeFullName for the INSIDE SALES lookup list."""
    url = (f"{SITE_URL}/_api/web/lists(guid'{INSIDE_SALES_LIST_ID}')"
           f"?$select=ListItemEntityTypeFullName")
    try:
        r = session.get(url, timeout=TIMEOUT)
        return r.json()["d"]["ListItemEntityTypeFullName"]
    except Exception:
        return None


def ensure_inside_sales_id(session, name, digest):
    """Resolve INSIDE SALES lookup ID; create the lookup item if it doesn't exist."""
    name = name.strip()
    if not name:
        return None
    existing = get_inside_sales_id(session, name)
    if existing:
        return existing

    entity_type = _inside_sales_entity_type(session)
    if not entity_type:
        print(f"  [!] INSIDE SALES '{name}' not found and entity type unknown — skipping field")
        return None

    url = f"{SITE_URL}/_api/web/lists(guid'{INSIDE_SALES_LIST_ID}')/items"
    headers = {
        "Accept":          "application/json;odata=verbose",
        "Content-Type":    "application/json;odata=verbose",
        "X-RequestDigest": digest,
    }
    payload = {"__metadata": {"type": entity_type}, INSIDE_SALES_FIELD: name}
    try:
        r = session.post(url, json=payload, headers=headers, timeout=TIMEOUT)
        if r.status_code in (200, 201):
            new_id = r.json()["d"]["Id"]
            print(f"  [+] Created INSIDE SALES entry '{name}' -> ID {new_id}")
            _INSIDE_SALES_CACHE[name.lower()] = new_id
            return new_id
        print(f"  [!] Could not create INSIDE SALES '{name}': HTTP {r.status_code} — {r.text[:200]}")
    except requests.exceptions.RequestException as e:
        print(f"  [!] Error creating INSIDE SALES '{name}': {e}")
    return None


def normalize_sfid(sfid):
    """Strip revision suffix (e.g. -A1R) and expand short form (CR00/SR00/EU00…) to 18 chars."""
    if not sfid:
        return sfid
    sfid = sfid.strip()
    if "-" in sfid:
        sfid = sfid.split("-")[0]
    if len(sfid) >= 4 and sfid[2:4] == "00" and sfid[:2].isalpha():
        sfid = "006QO00000" + sfid[4:]
    return sfid


# ─────────────────────────────────────────────
#  DUPLICATE DETECTION
#
#  The old check only ever compared an exactly-18-char SALESFORCEID with `eq`.
#  That missed three whole classes of duplicate:
#    * BidManager quotes (QB…/QW…/EE3E…), which carry no Salesforce id at all
#      — the list holds hundreds of same-code rows uploaded over and over;
#    * rows whose id is stored in short form (CR00x2HCUYA2) or with a revision
#      suffix (EU00RP9LWYA1-A5R), which an `eq` on the expanded id never hits;
#    * two identical rows inside the SAME batch.
#  We now match on Salesforce id (all spellings), quotation code, and finally
#  name+customer, and we also compare rows against each other.
# ─────────────────────────────────────────────

SELECT_COLS = "Id,Title,SALESFORCEID,QUOTATION_x0020_NAME,CUSTOMER,Created"

_SFID_PREFIXES = ("CR", "SR", "EU", "QR")


def _odata(v):
    """Escape a value for an OData string literal."""
    return str(v).replace("'", "''")


def _query(session, filt):
    """Run one $filter query. Returns [] on any failure (incl. threshold errors)."""
    url = (f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')/items"
           f"?$filter={filt}&$select={SELECT_COLS}&$top=50")
    try:
        r = session.get(url, timeout=TIMEOUT)
        if r.status_code == 200:
            return r.json()["d"]["results"]
        print(f"  [!] Duplicate query rejected (HTTP {r.status_code}) — {filt[:90]}")
    except requests.exceptions.RequestException as e:
        print(f"  [!] Duplicate query failed: {e}")
    return []


def _sfid_spellings(sfid):
    """Every form the same Salesforce id is stored in across the list."""
    core = normalize_sfid(sfid)
    if not core:
        return []
    out = {core, sfid.strip()}
    if core.startswith("006QO00000"):
        tail = core[10:]
        out.update(f"{p}00{tail}" for p in _SFID_PREFIXES)
    return [s for s in out if s]


def _match_by_sfid(session, sfid):
    spellings = _sfid_spellings(sfid)
    if not spellings:
        return None
    eq = " or ".join(f"SALESFORCEID eq '{_odata(s)}'" for s in spellings)
    # startswith also catches the revision-suffixed spellings (…YA1-A5R).
    sw = " or ".join(f"startswith(SALESFORCEID,'{_odata(s)}')" for s in spellings)
    return _first(_query(session, f"({eq}) or ({sw})") or _query(session, eq))


def _match_by_code(session, code, sfid=""):
    """Quotation code — the only identity a BidManager quote has.

    A code is NOT unique: 'EU1L0806X6K1-0000' is used by both the Eversheds and
    the HMP Standford hill quotes, which are different jobs with different
    Salesforce ids. So when both sides carry an id and the ids disagree, the
    code match is a coincidence and must be discarded — otherwise the modal
    would offer to overwrite an unrelated row.
    """
    code = (code or "").strip()
    if not code:
        return None
    # startswith absorbs the trailing spaces and '-A1R' revisions in the list.
    items = _query(session, f"Title eq '{_odata(code)}' or startswith(Title,'{_odata(code)}')")
    if not items:
        items = _query(session, f"Title eq '{_odata(code)}'")

    mine = normalize_sfid(sfid).upper()
    if mine:
        items = [i for i in items
                 if normalize_sfid(i.get("SALESFORCEID") or "").upper() in ("", mine)]
    return _first(items)


def _match_by_name(session, name, customer):
    """Last resort for rows with neither id nor code.

    Returns (hit, confirmed). Without a customer to confirm against, a name
    match is only a hint — two different jobs at the same site share a name —
    so the caller must not default such a row to 'replace'.
    """
    name = (name or "").strip()
    if not name:
        return None, False
    items = _query(session, f"QUOTATION_x0020_NAME eq '{_odata(name)}'")
    want = (customer or "").strip().lower()
    if want:
        items = [i for i in items if (i.get("CUSTOMER") or "").strip().lower() == want]
    return _first(items), bool(want)


def _first(items):
    if not items:
        return None
    item = items[0]
    return {
        "id":       item["Id"],
        "title":    item.get("Title") or "",
        "name":     item.get("QUOTATION_x0020_NAME") or "",
        "customer": item.get("CUSTOMER") or "",
        "created":  (item.get("Created") or "")[:10],
    }


def _row_identity(row):
    sf   = (row.get("SALESFORCE ID") or "").strip()
    code = (row.get("QUOTATION CODE") or "").strip()
    name = (row.get("QUOTATION NAME") or "").strip()
    cust = (row.get("CUSTOMER") or "").strip()
    return sf, code, name, cust


def check_rows(session, rows):
    """Return the list of conflicts/warnings for this batch.

    Each entry is keyed by CSV row index, because a row without a Salesforce id
    still needs a decision — keying on the id (as before) silently dropped them.
    """
    conflicts = []
    seen = {}                       # identity key -> row index already in this batch

    for i, row in enumerate(rows):
        sf, code, name, cust = _row_identity(row)
        label   = code or name or sf or f"row {i + 1}"
        missing = []
        if not sf:
            missing.append("SALESFORCE ID")
        if not (row.get("REQUESTED FROM EATON (INTERNAL)") or "").strip():
            missing.append("REQUESTED FROM")

        # ── No identity at all: extraction failed, don't create an empty row ──
        if not sf and not code and not name:
            conflicts.append({
                "key": str(i), "kind": "blank", "matchedOn": "",
                "sfid": "", "rowLabel": f"row {i + 1}", "missing": missing,
                "existingId": 0, "existingTitle": "", "existingCustomer": "",
                "existingCreated": "", "defaultAction": "skip",
            })
            print(f"  [!] Row {i + 1}: no SF ID, no quotation code, no name — extraction failed")
            continue

        # ── Duplicate inside this same batch ────────────────────────────────
        batch_key = normalize_sfid(sf).upper() or re.sub(r"[^A-Za-z0-9]", "", code).upper() \
                    or re.sub(r"[^A-Za-z0-9]", "", (name + cust)).upper()
        if batch_key in seen:
            conflicts.append({
                "key": str(i), "kind": "duplicate", "matchedOn": "same batch",
                "sfid": sf, "rowLabel": label, "missing": missing,
                "existingId": 0, "existingTitle": f"row {seen[batch_key] + 1} of this batch",
                "existingCustomer": cust, "existingCreated": "", "defaultAction": "skip",
            })
            print(f"  [!] Row {i + 1} duplicates row {seen[batch_key] + 1} of this batch: {label}")
            continue
        seen[batch_key] = i

        # ── Already in SharePoint? ──────────────────────────────────────────
        hit, matched, certain = None, "", True
        if sf:
            hit, matched = _match_by_sfid(session, sf), "SALESFORCE ID"
        if not hit and code:
            hit, matched = _match_by_code(session, code, sf), "QUOTATION CODE"
        if not hit and name:
            hit, confirmed = _match_by_name(session, name, cust)
            matched = "NAME + CUSTOMER" if confirmed else "QUOTATION NAME"
            certain = confirmed

        if hit:
            conflicts.append({
                "key": str(i), "kind": "duplicate", "matchedOn": matched,
                "sfid": sf, "rowLabel": label, "missing": missing,
                "existingId": hit["id"], "existingTitle": hit["title"] or hit["name"],
                "existingCustomer": hit["customer"], "existingCreated": hit["created"],
                # A name-only match is a hint, not proof — never pre-select an overwrite.
                "defaultAction": "replace" if certain else "add",
            })
            print(f"  [!] Row {i + 1} already in SharePoint (matched on {matched}): "
                  f"{label} -> item {hit['id']}")
        elif missing:
            conflicts.append({
                "key": str(i), "kind": "incomplete", "matchedOn": "",
                "sfid": sf, "rowLabel": label, "missing": missing,
                "existingId": 0, "existingTitle": "", "existingCustomer": cust,
                "existingCreated": "", "defaultAction": "add",
            })
            print(f"  [!] Row {i + 1} incomplete ({', '.join(missing)}): {label}")

    return conflicts


def patch_item(session, item_id, payload, digest):
    """MERGE-update an existing SharePoint list item."""
    url = f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')/items({item_id})"
    headers = {
        "Accept": "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose",
        "X-RequestDigest": digest,
        "IF-MATCH": "*",
        "X-HTTP-Method": "MERGE",
    }
    r = session.post(url, json=payload, headers=headers, timeout=TIMEOUT)
    return r.status_code in (200, 201, 204)



def upload_rows(session, rows, entity_type, digest, decisions=None):
    # decisions: dict of CSV row index (as a string) -> {"action": ..., "existingId": int}
    # Older callers keyed this by SALESFORCEID; both are accepted.
    url = f"{SITE_URL}/_api/web/lists/getbytitle('{LIST_NAME}')/items"
    post_headers = {
        "Accept": "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose",
        "X-RequestDigest": digest,
    }

    status_choices = get_field_choices(session, 'STATUS')
    processed_value = next((c for c in status_choices if "process" in c.lower()), None)
    if status_choices:
        print(f"[STATUS] Allowed values: {status_choices}")
    if processed_value:
        print(f"[STATUS] Will use: '{processed_value}'")

    req_type_choices = get_field_choices(session, 'REQUEST_x0020_TYPE')
    if req_type_choices:
        print(f"[REQUEST_TYPE] Allowed: {req_type_choices}")
    division_choices = get_field_choices(session, 'DIVISION')
    if division_choices:
        print(f"[DIVISION] Allowed: {division_choices}")
    if not processed_value:
        print(f"[STATUS] No matching choice found. Status will not be set.")

    success, fail, skipped = 0, 0, 0
    no_sfid, no_requester = [], []
    for i, row in enumerate(rows, 1):
        payload = {"__metadata": {"type": entity_type}}
        for sp_col, csv_col in COLUMN_MAP.items():
            if csv_col not in row:
                # The CSV has no such column — leave the field empty. (This used
                # to write the header NAME into SharePoint as the value.)
                print(f"  [!] CSV column '{csv_col}' missing — leaving {sp_col} empty")
                payload[sp_col] = None
            elif sp_col in DATE_COLUMNS:
                raw_date = row.get(csv_col, "")
                payload[sp_col] = convert_date(raw_date)
            elif sp_col == "PRICE":
                val = row.get(csv_col, "")
                try:
                    payload[sp_col] = float(val) if val else None
                except (ValueError, TypeError):
                    payload[sp_col] = None
            else:
                val = row.get(csv_col, "")
                payload[sp_col] = val if val else None

        inside_sales_name = row.get("INSIDE SALES", "").strip()
        if inside_sales_name:
            is_id = ensure_inside_sales_id(session, inside_sales_name, digest)
            if is_id:
                payload["INSIDE_x0020_SALES0Id"] = is_id
        label = row.get("QUOTATION NAME") or row.get("QUOTATION CODE") \
                or row.get("SALESFORCE ID") or f"row {i}"

        internal_requester = (row.get("REQUESTED FROM EATON (INTERNAL)") or "").strip()
        if internal_requester:
            uid = get_user_id(session, internal_requester, digest)
            if uid:
                payload["REQUESTEDFROM_x0028_INTERNAL_x00Id"] = uid
            else:
                no_requester.append(f"{label} (unresolved: {internal_requester})")
        else:
            no_requester.append(label)

        sfid = normalize_sfid(payload.get("SALESFORCEID", ""))
        payload["SALESFORCEID"] = sfid
        if sfid and len(sfid) < 18:
            print(f"  [!] SALESFORCEID '{sfid}' is {len(sfid)} chars (need 18) — skipping field, fill manually")
            payload.pop("SALESFORCEID", None)
            sfid = ""
        if not sfid:
            no_sfid.append(label)

        if processed_value:
            payload["STATUS"] = processed_value

        payload = {k: v for k, v in payload.items() if v is not None}

        # Apply conflict decision for this row — keyed by CSV row index, so a
        # row with no Salesforce id still gets its decision applied.
        decision = (decisions or {}).get(str(i - 1)) or (decisions or {}).get(sfid) or {}
        action   = decision.get("action", "add") if decision else "add"

        if action == "skip":
            print(f"  [SKIP] [{i}/{len(rows)}] {label}")
            skipped += 1
            continue

        try:
            if action == "replace":
                existing_id = decision.get("existingId")
                if not existing_id:
                    fail += 1
                    print(f"  [ERR] [{i}/{len(rows)}] Replace requested with no target item: {label}")
                elif patch_item(session, existing_id, payload, digest):
                    success += 1
                    print(f"  [OK] [{i}/{len(rows)}] REPLACED: {label}")
                else:
                    fail += 1
                    print(f"  [ERR] [{i}/{len(rows)}] Replace failed: {label}")
            else:
                r = session.post(url, json=payload, headers=post_headers, timeout=TIMEOUT)
                if r.status_code in (200, 201):
                    success += 1
                    print(f"  [OK] [{i}/{len(rows)}] {label}")
                else:
                    fail += 1
                    print(f"  [ERR] [{i}/{len(rows)}] HTTP {r.status_code} — {r.text[:300]}")
                    print(f"  [PAYLOAD] {json.dumps({k: v for k, v in payload.items() if k != '__metadata'}, default=str)}")
        except requests.exceptions.Timeout:
            fail += 1
            print(f"  [ERR] [{i}/{len(rows)}] Timed out.")

    print(f"\n{'='*45}")
    print(f"  Done — {success} uploaded, {skipped} skipped, {fail} failed.")
    # Name the rows that landed incomplete, so the gap shows up in the Vector
    # log instead of only in SharePoint weeks later.
    if no_sfid:
        print(f"  [!] {len(no_sfid)} row(s) uploaded WITHOUT a Salesforce id:")
        for lbl in no_sfid[:20]:
            print(f"        - {lbl}")
    if no_requester:
        print(f"  [!] {len(no_requester)} row(s) uploaded WITHOUT 'Requested from Eaton':")
        for lbl in no_requester[:20]:
            print(f"        - {lbl}")
    print(f"{'='*45}\n")
    return success, fail, skipped


# ─── MAIN ────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--check", action="store_true", help="Check for duplicates and output __CONFLICTS__ JSON")
    args, _ = parser.parse_known_args()

    print("\n[*] Connecting to SharePoint...")
    session = get_session()
    digest  = get_digest(session)

    rows = read_csv()
    CSV_HEADERS = list(rows[0].keys()) if rows else []
    print(f"[CSV] Loaded {len(rows)} row(s) from CSV.\n")

    if not COLUMN_MAP:
        print("[!]  COLUMN_MAP is empty — running discovery mode.\n")
        discover_columns(session)
        sys.exit(0)

    if not rows:
        print("[ERR] QuoteExtra.csv is empty — nothing to upload.")
        sys.exit(1)

    if args.check:
        print("[*] Checking for duplicates and missing fields...")
        conflicts = check_rows(session, rows)
        if conflicts:
            print(f"__CONFLICTS__:{json.dumps(conflicts)}")
        else:
            print("[OK] No duplicates found, all rows complete.")
        sys.exit(0)

    # Normal upload — read optional conflict decisions from env
    decisions_raw = os.environ.get("CONFLICT_DECISIONS", "")
    decisions = json.loads(decisions_raw) if decisions_raw else {}

    entity_type = get_list_metadata(session)
    print(f"[>>] Uploading {len(rows)} row(s)...\n")
    success, fail, skipped = upload_rows(session, rows, entity_type, digest, decisions)

    if success == 0 and fail > 0:
        print("[ERR] 0 rows uploaded successfully — cookies may be expired. Refresh them in Settings.")
        sys.exit(1)