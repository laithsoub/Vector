"""
D&Q Store backfill writer
=========================
Files quotes that the audit found missing from the D&Q Store.

This is the WRITE half of dq_backfill_audit.py, and it is deliberately narrow:

  * It only ever acts on an explicit list of row ids handed to it in a job file.
    There is no "fix everything" mode and no discovery of its own — the audit
    decides what is wrong, a person decides what gets touched.
  * It refuses any verdict that is not a missing-file case. DIFFERENT_COPY means
    a file carrying that reference is already filed and differs from what was
    sent; deciding which one is right is a human's job, not a script's.
  * It re-checks the destination immediately before uploading. The audit that
    produced the job may be hours old, and somebody else may have filed the
    quote in the meantime.
  * --dry-run reports exactly what it would do and writes nothing. The app runs
    this first and shows the plan.

Folder layout matches dq_store_upload.py, which is the tool that creates these
folders during normal Step 2 operation:

  D&Q Store/{SALESFORCE_ID} — {QUOTE_NAME}/{A|A1R}/QUOTE/

Usage:
  python dq_backfill_file.py --job job.json --out result.json [--dry-run]

Job file:
  {"auditPath": "...dq_audit.json", "ids": [3, 7, 12]}
"""
import argparse
import json
import os
import sys
from datetime import datetime

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

TIMEOUT = 60


# ── config / session (same sources as dq_backfill_audit.py) ──────────────────
def _load_cfg():
    cfg = {"sp_site": "https://eaton.sharepoint.com/sites/ELTechsupport",
           "dq_store": "Shared Documents/D&Q Store"}
    try:
        cfg.update(json.loads(open(os.path.join(_HERE, "config.json"), encoding="utf-8").read()))
    except Exception:
        pass
    return cfg


CFG = _load_cfg()
SITE_URL = CFG["sp_site"]
# Server-relative prefix of the site, derived from the configured URL rather
# than hardcoded, so a site rename does not silently write to the wrong path.
SITE_PATH = "/" + SITE_URL.split("//", 1)[-1].split("/", 1)[-1].strip("/")
DQ_STORE = CFG.get("dq_store", "Shared Documents/D&Q Store")

# The only verdicts this tool will act on. Each means "the quote was sent, and
# nothing carrying its reference is in the store" — the gap a backfill closes.
FILEABLE = {"MISSING_FOLDER", "MISSING_REVISION", "MISSING_FILE"}


def log(msg):
    """Progress goes to stderr so stdout stays a clean JSON document."""
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


# ── SharePoint session ───────────────────────────────────────────────────────
def get_session():
    """Authenticated session using the stored JOE cookies."""
    from cookie_crypto import load_cookies
    fed, rt = load_cookies()
    if not fed or not rt:
        raise RuntimeError("No SharePoint cookies — run Connect to JOE first.")
    s = requests.Session()
    s.verify = False
    s.cookies.set("FedAuth", fed, domain="eaton.sharepoint.com")
    s.cookies.set("rtFa", rt, domain="eaton.sharepoint.com")
    s.headers.update({"Accept": "application/json;odata=verbose"})
    return s


def get_digest(session):
    r = session.post(f"{SITE_URL}/_api/contextinfo", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["d"]["GetContextWebInformation"]["FormDigestValue"]


def _site_rel(path):
    p = str(path).strip("/").replace("^&", "&")
    lead = SITE_PATH.strip("/").lower() + "/"
    if p.lower().startswith(lead):
        p = p[len(lead):]
    return p.strip("/")


def list_files(session, rel):
    """Filenames directly inside a site-relative folder ([] if it doesn't exist)."""
    url = (f"{SITE_URL}/_api/web/GetFolderByServerRelativeUrl"
           f"('{requests.utils.quote(SITE_PATH + '/' + _site_rel(rel), safe='/')}')/Files")
    try:
        r = session.get(url, timeout=TIMEOUT)
        if r.status_code != 200:
            return []
        return [f["Name"] for f in r.json()["d"]["results"]]
    except Exception:
        return []


def folder_exists(session, rel):
    url = (f"{SITE_URL}/_api/web/GetFolderByServerRelativeUrl"
           f"('{requests.utils.quote(SITE_PATH + '/' + _site_rel(rel), safe='/')}')")
    try:
        return session.get(url, timeout=TIMEOUT).status_code == 200
    except Exception:
        return False


def ensure_folder(session, digest, parent_path, folder_name):
    """Create parent_path/folder_name if absent. Returns its site-relative path."""
    full_path = f"{_site_rel(parent_path)}/{folder_name}"
    r = session.post(
        f"{SITE_URL}/_api/web/folders",
        json={"__metadata": {"type": "SP.Folder"},
              "ServerRelativeUrl": f"{SITE_PATH}/{full_path}"},
        headers={"Accept": "application/json;odata=verbose",
                 "Content-Type": "application/json;odata=verbose",
                 "X-RequestDigest": digest},
        timeout=TIMEOUT)
    if r.status_code not in (200, 201, 409):        # 409 = already there
        raise RuntimeError(f"could not create '{folder_name}': {r.status_code} {r.text[:160]}")
    return full_path


def upload_file(session, digest, folder_rel, file_path):
    filename = os.path.basename(file_path)
    enc_path = requests.utils.quote(f"{SITE_PATH}/{_site_rel(folder_rel)}", safe="/")
    enc_file = requests.utils.quote(filename, safe="")
    # overwrite=false: a backfill must never replace a file already in the store.
    # If the name is taken, that is a case for a person, not for this tool.
    url = (f"{SITE_URL}/_api/web/GetFolderByServerRelativeUrl('{enc_path}')"
           f"/Files/add(url='{enc_file}',overwrite=false)")
    with open(file_path, "rb") as fh:
        data = fh.read()
    r = session.post(url, data=data,
                     headers={"Accept": "application/json;odata=verbose",
                              "X-RequestDigest": digest,
                              "Content-Type": "application/octet-stream"},
                     timeout=TIMEOUT * 3)
    if r.status_code in (200, 201):
        return True, len(data)
    raise RuntimeError(f"upload failed: {r.status_code} {r.text[:200]}")


def sanitise(name):
    out = str(name)
    for ch in '\\/:*?"<>|':
        out = out.replace(ch, "-")
    return out.strip().rstrip(".")[:120]


def target_folder(row):
    """Where this quote belongs.

    Prefers a folder the audit already matched for the opportunity, so a
    backfill lands beside the quote's siblings instead of creating a rival root
    folder for the same job. Falls back to the dq_store_upload naming.
    """
    folders = row.get("folder_list") or []
    if folders:
        return folders[0], False
    sfid = (row.get("sfid") or "").strip()
    if not sfid:
        return "", False
    name = sanitise(f"{sfid} — {row.get('subject_full') or row.get('code') or ''}".strip(" — "))
    return name or sanitise(sfid), True


def plan_one(session, row):
    """Decide what would happen to one row, without writing anything."""
    verdict = row.get("verdict", "")
    if verdict not in FILEABLE:
        return {"skip": f"verdict {verdict} is not a missing-file case"}

    local = row.get("local_path") or ""
    if not local or not os.path.exists(local):
        return {"skip": "the sent attachment is no longer on disk — re-run the audit"}

    folder, is_new = target_folder(row)
    if not folder:
        return {"skip": "no Salesforce id to build a folder from"}

    rev = (row.get("revision") or "A").strip() or "A"
    quote_dir = f"{DQ_STORE}/{folder}/{rev}/QUOTE"
    filename = os.path.basename(local)

    # Re-check now: the audit may be hours old and someone else may have filed
    # this in the meantime.
    existing = list_files(session, quote_dir)
    if filename in existing:
        return {"skip": "already in the store under this name"}

    want = (row.get("code") or "") + (row.get("suffix") or "")
    if want:
        norm = lambda s: "".join(c for c in str(s).lower() if c.isalnum())
        if any(norm(want) in norm(f) for f in existing):
            return {"skip": f"a file carrying {want} is already filed here"}

    return {
        "folder": folder, "newFolder": is_new, "revision": rev,
        "quoteDir": quote_dir, "filename": filename,
        "size": os.path.getsize(local), "localPath": local,
    }


def main():
    ap = argparse.ArgumentParser(description="File audited quotes into the D&Q Store.")
    ap.add_argument("--job", required=True, help="JSON: {auditPath, ids:[...]}")
    ap.add_argument("--out", required=True, help="where to write the result JSON")
    ap.add_argument("--dry-run", action="store_true", help="report the plan, write nothing")
    args = ap.parse_args()

    with open(args.job, encoding="utf-8") as fh:
        job = json.load(fh)
    ids = set(int(i) for i in job.get("ids", []))
    if not ids:
        json.dump({"error": "no ids were approved"}, open(args.out, "w", encoding="utf-8"))
        return

    with open(job["auditPath"], encoding="utf-8") as fh:
        audit = json.load(fh)
    rows = [r for r in audit.get("rows", []) if int(r.get("id", 0)) in ids]
    missing = ids - {int(r.get("id", 0)) for r in rows}

    log(f"[*] {'DRY RUN — nothing will be written' if args.dry_run else 'FILING'}: "
        f"{len(rows)} approved row(s)")
    if missing:
        log(f"[!] {len(missing)} approved id(s) are not in this audit: {sorted(missing)}")

    session = get_session()
    digest = None if args.dry_run else get_digest(session)

    results, filed, skipped, failed = [], 0, 0, 0
    for n, row in enumerate(rows, 1):
        label = row.get("code") or row.get("sfid") or row.get("attachment") or f"row {row.get('id')}"
        try:
            plan = plan_one(session, row)
            if "skip" in plan:
                skipped += 1
                log(f"  [{n}/{len(rows)}] SKIP {label} — {plan['skip']}")
                results.append({"id": row.get("id"), "label": label,
                                "status": "skipped", "detail": plan["skip"]})
                continue

            if args.dry_run:
                log(f"  [{n}/{len(rows)}] WOULD FILE {label} → {plan['quoteDir']}/{plan['filename']}")
                results.append({"id": row.get("id"), "label": label, "status": "would-file",
                                "detail": f"{plan['quoteDir']}/{plan['filename']}",
                                "newFolder": plan["newFolder"]})
                continue

            # Create the tree only as far as it is missing. ensure_folder treats
            # an existing folder as success, so this is safe to repeat.
            root = ensure_folder(session, digest, DQ_STORE, plan["folder"])
            variant = ensure_folder(session, digest, root, plan["revision"])
            for sub in ("CBU", "DESIGN", "QUOTE", "RX"):
                ensure_folder(session, digest, variant, sub)

            _, size = upload_file(session, digest, plan["quoteDir"], plan["localPath"])
            filed += 1
            log(f"  [{n}/{len(rows)}] FILED {label} → {plan['quoteDir']}/{plan['filename']} ({size}B)")
            results.append({"id": row.get("id"), "label": label, "status": "filed",
                            "detail": f"{plan['quoteDir']}/{plan['filename']}",
                            "newFolder": plan["newFolder"], "size": size})
        except Exception as e:
            failed += 1
            log(f"  [{n}/{len(rows)}] FAILED {label} — {e}")
            results.append({"id": row.get("id"), "label": label,
                            "status": "failed", "detail": str(e)[:300]})

    out = {
        "dryRun": bool(args.dry_run),
        "finishedAt": datetime.now().isoformat(timespec="seconds"),
        "approved": len(ids), "considered": len(rows),
        "filed": filed, "skipped": skipped, "failed": failed,
        "notInAudit": sorted(missing),
        "results": results,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    log(f"[OK] filed={filed} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[FATAL] {e}\n")
        sys.exit(1)
