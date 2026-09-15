#!/usr/bin/env python
"""
D&Q Store backfill AUDIT — PHASE 0, READ ONLY.

Walks Sent Items for the last N months, finds the quote PDFs that were sent out,
and reconciles each one against the D&Q Store. Writes a CSV with one verdict per
quote so the gap can be reviewed BEFORE anything is created or uploaded.

This script only ever issues HTTP GET. It creates no folders, uploads no files,
moves nothing and deletes nothing. Phase 2 (the writer) is a separate tool.

  py dq_backfill_audit.py --months 3
  py dq_backfill_audit.py --months 24 --out audit_full.csv

Verdicts
  MATCH             quote folder + revision + an identical copy of the PDF
  DIFFERENT_COPY    the PDF is there under the same code but the bytes differ
  MISSING_FILE      folder and revision exist, no quote PDF in QUOTE/
  MISSING_REVISION  folder exists, this revision (A/A1R/A2R…) does not
  MISSING_FOLDER    no opportunity folder for this quote at all
  UNRESOLVED        could not derive a Salesforce ID or works number to match on
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta

import urllib3
import requests

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TIMEOUT = 60

# ── config / session (same sources as dq_store_upload.py) ────────────────────


def _load_cfg():
    import json
    cfg = {"base": os.path.join(os.path.expanduser("~"), "Desktop", "EatonAutomation"),
           "sp_site": "https://eaton.sharepoint.com/sites/ELTechsupport",
           "dq_store": "Shared Documents/D&Q Store"}
    try:
        cfg.update(json.loads(open(os.path.join(_HERE, "config.json"), encoding="utf-8").read()))
    except Exception:
        pass
    return cfg


CFG = _load_cfg()
SITE = CFG["sp_site"]
STORE = CFG.get("dq_store", "Shared Documents/D&Q Store")
STORE_ROOT = f"/sites/ELTechsupport/{STORE}"


def get_session():
    from cookie_crypto import load_cookies
    fed, rt = load_cookies()
    if not fed or not rt:
        print("[ERR] No SharePoint cookies — run Connect to JOE first.")
        sys.exit(1)
    s = requests.Session()
    s.cookies.set("FedAuth", fed, domain="eaton.sharepoint.com")
    s.cookies.set("rtFa", rt, domain="eaton.sharepoint.com")
    s.headers.update({"Accept": "application/json;odata=verbose"})
    s.verify = False
    return s


def sp_get(session, url):
    r = session.get(url, timeout=TIMEOUT)
    if r.status_code == 403:
        print("[ERR] 403 from SharePoint — cookies expired. Reconnect to JOE.")
        sys.exit(1)
    return r


def list_folders(session, rel):
    r = sp_get(session, f"{SITE}/_api/web/GetFolderByServerRelativeUrl('{rel}')/Folders?$select=Name&$top=5000")
    if r.status_code != 200:
        return []
    return [f["Name"] for f in r.json()["d"]["results"]]


def list_files(session, rel):
    r = sp_get(session, f"{SITE}/_api/web/GetFolderByServerRelativeUrl('{rel}')/Files?$select=Name,Length,ServerRelativeUrl")
    if r.status_code != 200:
        return []
    return [(f["Name"], int(f["Length"]), f["ServerRelativeUrl"]) for f in r.json()["d"]["results"]]


# ── quote identification ─────────────────────────────────────────────────────

# Eaton generated quote code: EU1L0727X6K1-0000 / EE3E0203X6K1-0002 / EECL0623X6K1-0000
# NOTE none of these patterns may use \b at a boundary that faces the filename's
# separators: generated names are underscore-joined ("…-0002_CR00xxHR3YAM_A2R_…")
# and "_" is a word character, so \b never fires there.
CODE_RE = re.compile(r"([A-Z]{2}[A-Z0-9]{2}\d{4}X\d[A-Z]\d)-(\d{4})", re.I)
# Salesforce/case id. Two shapes, tried longest-first: the full 18-char id, then
# the short case form. NOT \b-terminated — real filenames glue the revision onto
# the id ("CR00Ay55XYA3R") and Step 1 has produced doubled prefixes
# ("SR006QO00000p3YRBYA2"), both of which a trailing \b would reject outright.
SFID18_RE = re.compile(r"006QO0\d{4}([A-Za-z0-9]{8})")
# No \b on either end: these ids sit between underscores in generated filenames
# ("…X6K1-0000_CR00xsp1xYAA_-_Coventry"), and "_" is a word character, so a
# leading \b would never fire there.
SFID_SHORT_RE = re.compile(r"(?:SR|CR|EU)0[0O]([A-Za-z0-9]{7,8})")
# UK works number: QB27366A, QW28412A2R, QR26490A
WORKS_RE = re.compile(r"(Q[BWVR])(\d{5})([A-Z]\d?R?)?", re.I)
# Works number as it appears in crm_quote's Title ("QW27351A", " QB27353A"). The
# Q-prefix is REQUIRED here on purpose: a bare 5-digit run in a CRM free-text
# field is as likely to be a postcode or a price as a works number, and a wrong
# pair in the bridge would point a quote at another job's folder.
CRM_WORKS_RE = re.compile(r"(?:^|[^A-Za-z0-9])Q[BWVR](\d{5})(?![0-9])", re.I)
REV_RE = re.compile(r"(?:^|[^A-Za-z0-9])A(\d)R(?![A-Za-z0-9])", re.I)
# Same idea for FOLDER names, where the revision is often welded onto a works
# number with no separator at all ("QB28412A2R — RAF Fairford MHA"). A digit may
# precede it; a letter may not, or ids like "CR00Ay55XYA3R" would read as A3R.
FOLDER_REV_RE = re.compile(r"(?:^|[^A-Za-z])A(\d)R(?![A-Za-z0-9])", re.I)


def norm(s):
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def find_sfid(text):
    """The 8-char core shared by every form of one Salesforce id. Used on BOTH
    sides of the match (filenames and folder names) so the two always agree."""
    m = SFID18_RE.search(text or "") or SFID_SHORT_RE.search(text or "")
    return m.group(1).upper() if m else ""


def rev_folder(code_suffix, name):
    """Revision subfolder: '-0000' → A, '-0001' → A1R, '-0002' → A2R. The name
    wins when it spells the revision out (…_A3R_…), since that is what the
    uploader used at the time."""
    m = REV_RE.search(name or "")
    if m:
        return f"A{m.group(1)}R"
    try:
        n = int(code_suffix)
    except (TypeError, ValueError):
        return "A"
    return "A" if n == 0 else f"A{n}R"


def identify(filename, pdf_path=None):
    """Is this attachment an Eaton quote? Return its identifiers or None.

    Fast path reads the generated filename. Slow path hands the PDF to
    pdf_to_csv — the same extractor Step 1a uses — so a quote saved under a
    renamed file is still recognised."""
    sfid = code = suffix = works = ""

    m = CODE_RE.search(filename)
    if m:
        code, suffix = m.group(1).upper(), m.group(2)
    sfid = find_sfid(filename)
    m = WORKS_RE.search(filename)
    if m:
        works = m.group(2)

    # An id alone is NOT enough: without the code's revision suffix every
    # revision of a quote looks identical and would be filed as "A". Fall through
    # to the content extractor unless the filename gave us a code.
    if not code and pdf_path:
        got = _identify_by_content(pdf_path)
        if got:
            sfid = sfid or got.get("sfid", "")
            code, suffix = got.get("code", ""), got.get("suffix", "")
            works = works or got.get("works", "")

    if not (code or sfid or works):
        return None
    return {"sfid": sfid, "code": code, "suffix": suffix, "works": works,
            "rev": rev_folder(suffix, filename)}


def _identify_by_content(pdf_path):
    """Confirm via the Step 1a extractor. Quiet: it prints a report of its own."""
    import contextlib
    import io
    try:
        import pdf_to_csv
    except Exception:
        return None
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            row = pdf_to_csv.process_pdf(pdf_path)
    except Exception:
        return None
    if not row:
        return None
    raw_code = str(row.get("QUOTATION CODE") or "")
    m = CODE_RE.search(raw_code)
    sf = str(row.get("SALESFORCE ID") or "")
    msf = find_sfid(sf)
    w = WORKS_RE.search(str(row.get("QUOTATION NAME") or ""))
    if not (m or msf or w):
        return None
    return {"code": m.group(1).upper() if m else "", "suffix": m.group(2) if m else "",
            "sfid": msf, "works": w.group(2) if w else ""}


# ── store index ──────────────────────────────────────────────────────────────

def build_store_index(session):
    """Map every opportunity folder by BOTH keys it can be found under: the
    Salesforce id core and the UK works number. Folder NAMES are inconsistent
    (hyphen vs em dash, hand-made vs generated) so they are never matched on.

    One id maps to a LIST, not a single folder: the store already holds several
    folders per opportunity — a hyphen/em-dash pair, plus revisions that were
    created as their own root folder ("CR00xxHR3YAM — A1R -(Solid ceiling) …")
    instead of an A1R subfolder. A copy sitting in any of them still counts."""
    names = list_folders(session, STORE_ROOT)
    by_sf, by_works = {}, {}
    for n in names:
        core = find_sfid(n)
        if core:
            by_sf.setdefault(core, []).append(n)
        m = re.match(r"\s*(\d{5})\s*(Q[BWVR])?\b", n)
        if m:
            by_works.setdefault(m.group(1), []).append(n)
        m = WORKS_RE.search(n)
        if m and n not in by_works.get(m.group(2), []):
            by_works.setdefault(m.group(2), []).append(n)
    return names, by_sf, by_works


def _db_path():
    p = os.environ.get("DATA_DIR") or os.path.dirname(_HERE)
    return os.path.join(p, "eaton_automation.db")


def load_crm_bridge():
    """Translate a Salesforce id core into a UK works number and back.

    The store is keyed two ways — 199 folders by Salesforce id, 1616 by works
    number — but a quote normally carries only ONE of them, so a quote holding
    just an SF id can never reach its works-number folder on its own. crm_quote
    (the local mirror of the Quotations List) is the only place both appear on
    the same row, which makes it the bridge.

    Coverage is THIN, measured 2026-07-29: only 20 of 1316 crm_quote rows carry
    both keys, and those rescue 4 audit rows / 2 opportunities out of 138
    MISSING_FOLDER. Worth having — it is an exact key on both sides, so it
    cannot mis-link — but it does NOT explain the bulk of MISSING_FOLDER.
    Missing entirely from the DB is not an error; return empty and carry on."""
    sf2w, w2sf = {}, {}
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{_db_path()}?mode=ro", uri=True)
        rows = con.execute("SELECT sfId, title, quoteName FROM crm_quote").fetchall()
        con.close()
    except Exception as e:
        print(f"[i] crm_quote bridge unavailable ({e}) — matching on direct keys only.")
        return sf2w, w2sf
    for sfid, title, qname in rows:
        core = find_sfid(str(sfid or ""))
        if not core:
            continue
        # Title first: it is the works number field. quoteName is a fallback for
        # rows where the number was typed into the name instead.
        for field in (title, qname):
            m = CRM_WORKS_RE.search(str(field or ""))
            if m:
                sf2w.setdefault(core, set()).add(m.group(1))
                w2sf.setdefault(m.group(1), set()).add(core)
                break
    return sf2w, w2sf


def find_folders(rec, by_sf, by_works, bridge=None):
    """Returns (folders, note). `note` names the bridge hop when one was needed,
    so a reviewer can tell a folder reached via crm_quote from a direct hit —
    Phase 2 must never create a folder for a quote that only matched this way
    without the hop being visible."""
    if rec["sfid"] and rec["sfid"] in by_sf:
        return by_sf[rec["sfid"]], ""
    if rec["works"] and rec["works"] in by_works:
        return by_works[rec["works"]], ""
    if bridge:
        sf2w, w2sf = bridge
        for w in sorted(sf2w.get(rec["sfid"], ()) if rec["sfid"] else ()):
            if w in by_works:
                return by_works[w], f"via crm_quote: {rec['sfid']} -> works {w}"
        for core in sorted(w2sf.get(rec["works"], ()) if rec["works"] else ()):
            if core in by_sf:
                return by_sf[core], f"via crm_quote: works {rec['works']} -> {core}"
    return [], ""


def sha256_bytes(data):
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _quote_dirs(session, folder, rev):
    """Every place this revision's PDF could legitimately be sitting, across all
    folders that belong to the opportunity: <folder>/<rev>/QUOTE, and — for the
    folders whose own NAME carries the revision — <folder>/QUOTE and <folder>/A/
    QUOTE. Returns (paths, revision_seen)."""
    base = f"{STORE_ROOT}/{folder}"
    subs = list_folders(session, base)
    out, seen = [], False

    hit = next((s for s in subs if s.upper() == rev.upper()), None)
    if hit:
        seen = True
        q = next((s for s in list_folders(session, f"{base}/{hit}") if s.upper() == "QUOTE"), None)
        if q:
            out.append(f"{base}/{hit}/{q}")
    if FOLDER_REV_RE.search(folder) and rev.upper() in norm(folder):
        seen = True
        for parent in [base] + [f"{base}/{s}" for s in subs if s.upper() in ("A", rev.upper())]:
            q = next((s for s in list_folders(session, parent) if s.upper() == "QUOTE"), None)
            if q:
                out.append(f"{parent}/{q}")
    return out, seen


def text_fingerprint(path=None, data=None):
    """Hash of the PDF's visible text (first pages). Two renders of the same
    quote differ byte-for-byte — regenerating it changes embedded timestamps —
    while the text stays identical. Bytes alone would call those a mismatch."""
    try:
        import io
        import pdfplumber
        src = io.BytesIO(data) if data is not None else path
        with pdfplumber.open(src) as pdf:
            txt = "\n".join((p.extract_text() or "") for p in pdf.pages[:4])
    except Exception:
        return ""
    txt = re.sub(r"\s+", " ", txt).strip()
    return hashlib.sha256(txt.encode("utf-8", "ignore")).hexdigest() if txt else ""


def reconcile(session, rec, folders, local_path):
    """Compare one sent quote against every folder the opportunity owns."""
    rev = rec["rev"]
    # The code WITHOUT its suffix is shared by every revision (…X6K1-0000 /
    # -0001 / -0002), so matching on it alone would accept a different revision's
    # PDF. Always carry the suffix when there is one.
    want = norm(rec["code"] + rec["suffix"]) or norm(rec["sfid"]) or norm("Q" + rec["works"])
    local_size = os.path.getsize(local_path)
    rev_seen, candidates, scanned = False, [], 0
    msg_here = False

    for folder in folders:
        dirs, seen = _quote_dirs(session, folder, rev)
        rev_seen = rev_seen or seen
        base = f"{STORE_ROOT}/{folder}"
        for d in [base] + [f"{base}/{s}" for s in list_folders(session, base)]:
            if any(f[0].lower().endswith((".msg", ".eml")) for f in list_files(session, d)):
                msg_here = True
                break
        for d in dirs:
            files = list_files(session, d)
            scanned += len(files)
            candidates += [f for f in files if want and want in norm(f[0])]

    if not candidates:
        if not rev_seen:
            return "MISSING_REVISION", msg_here, f"no {rev} in: {', '.join(folders)}"
        return "MISSING_FILE", msg_here, f"{scanned} file(s) in QUOTE/, none carrying {want}"

    local_text = None
    for name, size, rel in candidates:
        r = sp_get(session, f"{SITE}/_api/web/GetFileByServerRelativeUrl('{rel}')/$value")
        if r.status_code != 200:
            continue
        if size == local_size and sha256_bytes(r.content) == sha256_file(local_path):
            return "MATCH", msg_here, name
        if local_text is None:
            local_text = text_fingerprint(path=local_path)
        if local_text and text_fingerprint(data=r.content) == local_text:
            return "MATCH_RERENDER", msg_here, f"{name} — same text, different render ({size}B vs sent {local_size}B)"
    return "DIFFERENT_COPY", msg_here, "; ".join(f"{n} ({s}B vs sent {local_size}B)" for n, s, _ in candidates)


# ── Outlook ──────────────────────────────────────────────────────────────────

SENT_NAMES = {"sent items", "sent", "éléments envoyés", "gesendete elemente",
              "elementi inviati", "elementos enviados", "verzonden items"}


def sent_folders(ns):
    out, seen = [], set()

    def add(f):
        try:
            key = f.EntryID
        except Exception:
            return
        if key not in seen:
            seen.add(key)
            out.append(f)

    try:
        add(ns.GetDefaultFolder(5))          # olFolderSentMail
    except Exception:
        pass
    for i in range(1, ns.Stores.Count + 1):
        try:
            root = ns.Stores.Item(i).GetRootFolder()
            for j in range(1, root.Folders.Count + 1):
                f = root.Folders.Item(j)
                if str(f.Name).strip().lower() in SENT_NAMES:
                    add(f)
        except Exception:
            continue
    return out


def scan_sent(months, max_emails, tmpdir, verbose=False):
    import win32com.client
    ns = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
    since = datetime.now() - timedelta(days=int(months * 30.5))
    flt = "[SentOn] >= '" + since.strftime("%m/%d/%Y %I:%M %p") + "'"

    found, seen_emails, skipped = [], 0, 0
    for folder in sent_folders(ns):
        try:
            items = folder.Items
            items.Sort("[SentOn]", True)
            items = items.Restrict(flt)
        except Exception as e:
            print(f"[WARN] {folder.Name}: {e}")
            continue
        print(f"[*] {folder.Name}: {items.Count} sent item(s) since {since:%Y-%m-%d}")
        for item in items:
            if max_emails and seen_emails >= max_emails:
                break
            seen_emails += 1
            try:
                if int(item.Attachments.Count) == 0:
                    continue
                subject = str(item.Subject or "")
                sent_on = str(item.SentOn)[:19]
            except Exception:
                skipped += 1
                continue
            for k in range(1, item.Attachments.Count + 1):
                try:
                    att = item.Attachments.Item(k)
                    name = str(att.FileName or "")
                except Exception:
                    skipped += 1
                    continue
                if not name.lower().endswith(".pdf"):
                    continue
                rec = identify(name)
                path = None
                if not rec or not rec["code"]:
                    # No quote code in the name — save it and ask the extractor,
                    # which reads the code (and its revision suffix) out of the
                    # PDF itself. Without that, revisions cannot be told apart.
                    path = os.path.join(tmpdir, f"{len(found):04d}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)}")
                    try:
                        att.SaveAsFile(path)
                    except Exception:
                        skipped += 1
                        continue
                    rec = identify(name, path)
                    if not rec:
                        continue
                if path is None:
                    path = os.path.join(tmpdir, f"{len(found):04d}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)}")
                    try:
                        att.SaveAsFile(path)
                    except Exception:
                        skipped += 1
                        continue
                rec.update({"file": name, "path": path, "subject": subject, "sent": sent_on})
                found.append(rec)
                if verbose:
                    print(f"    quote: {sent_on}  {rec['code'] or rec['sfid'] or rec['works']}  {name[:60]}")
        if max_emails and seen_emails >= max_emails:
            break
    return found, seen_emails, skipped


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Audit Sent Items against the D&Q Store (read only).")
    ap.add_argument("--months", type=float, default=3)
    ap.add_argument("--out", default=os.path.join(_HERE, "dq_audit.csv"))
    ap.add_argument("--max-emails", type=int, default=0, help="stop after N sent items (0 = no cap)")
    ap.add_argument("--verbose", action="store_true")
    # Machine-readable copy for the app's filing review. Carries the local path of
    # each saved attachment so an approved item can be filed without re-reading
    # Outlook, and the folder candidates so the reviewer sees where it would go.
    ap.add_argument("--json", default="", help="also write the rows as JSON to this path")
    args = ap.parse_args()

    print(f"[*] READ-ONLY audit — last {args.months} month(s). Nothing will be created or uploaded.")
    tmpdir = tempfile.mkdtemp(prefix="dq_audit_")
    session = get_session()

    print("[*] Indexing the D&Q Store…")
    names, by_sf, by_works = build_store_index(session)
    print(f"    {len(names)} opportunity folders — {len(by_sf)} keyed by Salesforce id, {len(by_works)} by works number")

    bridge = load_crm_bridge()
    print(f"    crm_quote bridge: {len(bridge[0])} Salesforce id(s) carry a works number")

    print("[*] Scanning Sent Items…")
    quotes, seen, skipped = scan_sent(args.months, args.max_emails, tmpdir, args.verbose)
    print(f"    {seen} sent item(s) examined, {len(quotes)} quote attachment(s) found, {skipped} unreadable")

    # One row per QUOTE REVISION, not per email: the same PDF is resent, replied
    # to and forwarded many times. Keep the latest send and count the rest.
    def absorb(store, key, rec):
        prev = store.get(key)
        if prev is None:
            rec.setdefault("times_sent", 1)
            store[key] = rec
            return
        prev["times_sent"] += 1
        if rec["sent"] > prev["sent"]:          # keep the newest send
            rec["times_sent"] = prev["times_sent"]
            store[key] = rec

    uniq = {}
    for rec in (r for r in quotes if r["code"]):
        absorb(uniq, (rec["code"], rec["rev"]), rec)
    # Second pass for attachments whose code could not be read: fold them into
    # the coded row for the same opportunity+revision rather than letting them
    # stand as a phantom duplicate keyed on the Salesforce id.
    by_sf_rev = {(r["sfid"], r["rev"]): k for k, r in uniq.items() if r["sfid"]}
    for rec in (r for r in quotes if not r["code"]):
        k = by_sf_rev.get((rec["sfid"], rec["rev"])) if rec["sfid"] else None
        absorb(uniq, k or (rec["sfid"] or rec["works"], rec["rev"]), rec)
    deduped = sorted(uniq.values(), key=lambda r: r["sent"], reverse=True)
    print(f"    {len(deduped)} distinct quote revision(s) after dedupe")

    rows, tally, json_rows = [], {}, []
    for i, rec in enumerate(deduped, 1):
        folders, bridged = find_folders(rec, by_sf, by_works, bridge)
        if not folders:
            verdict, msg, detail = ("MISSING_FOLDER", "", "no folder for this Salesforce id / works number") \
                if (rec["sfid"] or rec["works"]) else ("UNRESOLVED", "", "no id to match on")
        else:
            try:
                verdict, msg, detail = reconcile(session, rec, folders, rec["path"])
            except Exception as e:
                verdict, msg, detail = "ERROR", "", str(e)[:160]
        if bridged:
            detail = f"{detail} | {bridged}" if detail else bridged
            tally["(via crm_quote bridge)"] = tally.get("(via crm_quote bridge)", 0) + 1
        tally[verdict] = tally.get(verdict, 0) + 1
        if len(folders) > 1:
            tally["(split across folders)"] = tally.get("(split across folders)", 0) + 1
        rows.append({
            "verdict": verdict, "sent": rec["sent"], "times_sent": rec["times_sent"],
            "code": rec["code"], "revision": rec["rev"],
            "sfid": rec["sfid"], "works": rec["works"],
            "folder_count": len(folders), "folders": " | ".join(folders),
            "message_in_folder": "yes" if msg else ("no" if folders else ""),
            "attachment": rec["file"], "subject": rec["subject"][:120], "detail": detail,
        })
        if args.json:
            # Everything the CSV row has, plus what a writer would need: the
            # saved PDF, the code suffix that distinguishes revisions, and the
            # folders as a list rather than a joined string.
            json_rows.append({
                **rows[-1],
                "id": i,
                "folder_list": folders,
                "suffix": rec.get("suffix", ""),
                "local_path": rec.get("path", ""),
                "subject_full": rec["subject"],
            })
        split = f"  [{len(folders)} folders]" if len(folders) > 1 else ""
        print(f"  [{i}/{len(deduped)}] {verdict:<16} {rec['rev']:<4} "
              f"{rec['code'] or rec['sfid'] or rec['works']:<20} {rec['file'][:44]}{split}")

    with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else
                           ["verdict", "sent", "times_sent", "code", "revision", "sfid", "works",
                            "folder_count", "folders", "message_in_folder", "attachment",
                            "subject", "detail"])
        w.writeheader()
        w.writerows(rows)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "generatedAt": datetime.now().isoformat(timespec="seconds"),
                "months": args.months,
                "tmpdir": tmpdir,
                "seen": seen, "quotes": len(quotes), "skipped": skipped,
                "tally": tally,
                "rows": json_rows,
            }, fh, ensure_ascii=False, indent=1)
        print(f"[OK] {len(json_rows)} row(s) → {args.json}")

    print("\n=== SUMMARY ===")
    for k in sorted(tally, key=lambda x: -tally[x]):
        print(f"  {k:<18} {tally[k]}")
    print(f"\n[OK] {len(rows)} row(s) → {args.out}")
    print(f"[i]  Attachments kept for inspection in {tmpdir}")


if __name__ == "__main__":
    main()
