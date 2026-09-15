"""
onedrive_case.py — find a transaction's case folder in the analyst's OneDrive
and pull the approved file of the previous revision.

A revision is priced against what the customer was already quoted, and that
lives in the analyst's own OneDrive (`eaton-my`), not in Vector's case root. So
this reads her folder the same way cpq_fetch reads CPQ: through the CPQ/SharePoint
tab already signed in inside the debug-rail Edge, via CDP. Vector holds no
eaton-my credentials of its own, and everything here is READ-ONLY — it lists and
downloads, it never writes into her drive.

    python onedrive_case.py --job job.json --out result.json

job.json:
    {"transaction": "W262089818E",
     "port": 9222,                       (default 9222)
     "out_dir": "<folder to download into>",   (omit to only list)
     "pattern": "approved"}              which file to pull; default the newest
                                         'approved' .xlsx, i.e. the previous
                                         revision's Approved Offer

The result carries every file found, which revision numbers exist, and — when a
download was asked for — the local path and the revision it came from, so the
caller can name the next one (R4 present → R5 next).
"""
import argparse
import base64
import json
import os
import re
import sys
from urllib.parse import urlparse
from urllib.request import urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpq_fetch as cf                    # the CDP plumbing, already proven

MY_HOST = "eaton-my.sharepoint.com"
# Whose drive counts as the source of truth for a revision. Vector's own case
# folder is synced to the user's OneDrive and comes back in the same search, so
# results are scoped to this path or the revision numbering reads its own output.
ANALYST_PATH = "/personal/dalianabil_eaton_com/"


def _tab(port):
    """A signed-in tab on the analyst's OneDrive host, else any Eaton tab that
    can carry the credentialed fetch."""
    try:
        tabs = json.loads(urlopen(f"http://localhost:{port}/json", timeout=5).read())
    except Exception as e:
        raise RuntimeError(
            f"Edge debug port {port} is not reachable ({e}). Start the app "
            f"(start-app.ps1) so the debug-rail Edge is running.")
    pages = [t for t in tabs if t.get("type") == "page" and MY_HOST in (t.get("url") or "")]
    if not pages:
        raise RuntimeError(
            f"No {MY_HOST} tab is open in the debug-rail Edge. Open the analyst's "
            f"OneDrive there, sign in, and try again.")
    pages.sort(key=lambda t: ("/query?" not in (t.get("url") or ""),))
    return pages[0]


def _evaluate(port, expr, timeout_ms=45000, log=None):
    """Same wake-and-retry as the CPQ read: a slept tab answers nothing, and a
    reload both wakes it and renews the session."""
    target = _tab(port)
    try:
        return cf.evaluate_on(target, port, expr, js_timeout_ms=timeout_ms)
    except Exception as first:
        if not cf.wake_target(target, port, log):
            raise RuntimeError(
                f"The OneDrive tab did not come back after a reload ({first}). Open "
                f"the analyst's OneDrive in the debug-rail Edge and try again.")
        return cf.evaluate_on(_tab(port), port, expr, js_timeout_ms=timeout_ms)


def _search_js(transaction):
    """Her drive is searched, not walked: the case folders are nested and the
    search index is the only thing that knows where a transaction lives."""
    q = json.dumps(transaction)
    return f"""(async () => {{
      const site = location.origin + "/personal/dalianabil_eaton_com";
      const url = site + "/_api/search/query?querytext='" + encodeURIComponent({q})
                + "'&rowlimit=200&selectproperties='Title,Path,FileType,Write,Size'";
      const r = await fetch(url, {{headers:{{Accept:"application/json;odata=nometadata"}},
                                  credentials:"include"}});
      if (!r.ok) return JSON.stringify({{error:r.status + " " + (await r.text()).slice(0,200)}});
      const j = await r.json();
      const rows = (((j.PrimaryQueryResult||{{}}).RelevantResults||{{}}).Table||{{}}).Rows||[];
      return JSON.stringify({{files: rows.map(row => {{
        const o = {{}}; (row.Cells||[]).forEach(c => o[c.Key] = c.Value);
        return {{name:o.Title, path:o.Path, type:o.FileType,
                modified:(o.Write||"").slice(0,10), size:Number(o.Size||0)}};
      }})}});
    }})()"""


def _download_js(path):
    p = json.dumps(path)
    return f"""(async () => {{
      const r = await fetch({p}, {{credentials:"include"}});
      if (!r.ok) return JSON.stringify({{error:r.status}});
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ""; const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH)
        s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      return JSON.stringify({{b64: btoa(s), bytes: buf.length}});
    }})()"""


def revision_of(name):
    """'R4 Approved …' → 4; an unprefixed file is the first version, 0."""
    m = re.match(r"^R(\d+)\b", str(name or "").strip(), re.I)
    return int(m.group(1)) if m else 0


def run(job, log):
    port = int(job.get("port") or 9222)
    transaction = str(job.get("transaction") or "").strip()
    if not transaction:
        raise RuntimeError("No transaction number given.")

    log(f"Searching the analyst's OneDrive for {transaction}")
    res = json.loads(_evaluate(port, _search_js(transaction), log=log) or "{}")
    if res.get("error"):
        raise RuntimeError(f"OneDrive search failed: {res['error']}")

    files = [f for f in res.get("files", []) if f.get("type")]     # drop folders
    # Search returns everything the user can see, and Laith's own case folder is
    # synced to HIS OneDrive — so Vector's own output came back as 'R5' and the
    # next revision was computed as R6. Only the analyst's drive counts.
    scope = str(job.get("analyst_path") or ANALYST_PATH).lower()
    outside = [f for f in files if scope not in (f.get("path") or "").lower()]
    files = [f for f in files if scope in (f.get("path") or "").lower()]
    if outside:
        log(f"Ignored {len(outside)} hit(s) outside {scope} (Vector's own copies).")
    files.sort(key=lambda f: (revision_of(f["name"]), f.get("modified") or ""))
    for f in files:
        log(f"  {f.get('modified')}  {round((f.get('size') or 0)/1024):>6} KB  {f['name']}")

    revs = sorted({revision_of(f["name"]) for f in files})
    latest = max(revs) if revs else 0
    out = {"ok": True, "transaction": transaction, "files": files,
           "revisions": revs, "latest_revision": latest,
           "next_revision": f"R{latest + 1}"}
    log(f"Latest revision on file is "
        f"{('R%d' % latest) if latest else 'the first version'} — the next one is "
        f"{out['next_revision']}.")

    if not job.get("out_dir"):
        return out

    # The file to carry from: the newest one whose name says it is the approved
    # offer. Her R4 is 'R4 Approved <project>.xlsx', Vector's own is
    # 'R4 Approved Offer - Approved (<W>).xlsx' — 'approved' matches both.
    pat = str(job.get("pattern") or "approved").lower()
    picks = [f for f in files
             if pat in f["name"].lower() and f["type"].lower() in ("xlsx", "xlsm")]
    if not picks:
        log(f"Nothing matching {pat!r} to download.", "warn")
        out["downloaded"] = None
        return out
    pick = picks[-1]                                   # already sorted by revision

    got = json.loads(_evaluate(port, _download_js(pick["path"]), 120000) or "{}")
    if got.get("error"):
        raise RuntimeError(f"Could not download {pick['name']}: HTTP {got['error']}")
    os.makedirs(job["out_dir"], exist_ok=True)
    local = os.path.join(job["out_dir"], f"{pick['name']}.{pick['type']}")
    with open(local, "wb") as fh:
        fh.write(base64.b64decode(got["b64"]))
    log(f"Downloaded {os.path.basename(local)} ({got['bytes'] / 1024:.0f} KB) — "
        f"revision {revision_of(pick['name']) or 'first'}")
    out["downloaded"] = {"name": pick["name"], "path": local,
                         "revision": revision_of(pick["name"])}
    return out


MAX_HISTORY = 6          # the customer's newest earlier deals worth opening
MIN_OVERLAP = 0.6        # share of this BOM's materials the old offer must price


def history(job, log):
    """The customer's earlier deal, when this transaction number has no case.

    Dalia's own steps (2026-09-15): filter her daily sheet on the customer, take
    the latest transactions, open that case's approved offer, check its total,
    carry the prices. Each candidate's newest approved offer is downloaded into
    `out_dir` and scored by how many of THIS BOM's materials it prices; the first
    (newest) one pricing at least MIN_OVERLAP of them is the pick. A stock order is
    ~90% the same items as the last one, so a real match is not borderline.
    READ-ONLY against her drive, like run()."""
    import lsd_queue as lq
    from lsd_pricing import read_bom, read_offer_prices

    port = int(job.get("port") or 9222)
    customer = str(job.get("customer") or "").strip()
    name = str(job.get("customer_name") or "").strip()
    current = str(job.get("transaction") or "").strip().upper()
    if not (customer or name):
        raise RuntimeError("No customer to search the history for.")

    log(f"Nothing on file under {current} — looking for {customer or name}'s earlier "
        f"deals in Dalia's daily sheet (a re-upload carries a new number).")
    got = json.loads(lq._evaluate(port, lq._download_js(lq.DEFAULT_FILE), log) or "{}")
    if not got.get("b64"):
        raise RuntimeError(f"Could not read Dalia's daily sheet: {got.get('error') or 'empty reply'}")
    rows = [r for r in lq.customer_rows(base64.b64decode(got["b64"]), customer, name, current)
            if not r["status"].lower().startswith("cancel")]
    out = {"ok": True, "customer": customer, "candidates": [], "pick": None}
    if not rows:
        log(f"{customer or name} has no earlier transaction in her sheet — a genuinely new deal.")
        return out
    log(f"{len(rows)} earlier transaction(s) for this customer; opening the newest "
        f"{min(len(rows), MAX_HISTORY)}.")

    mats = set()
    if job.get("bom") and os.path.exists(str(job["bom"])):
        lines, _, _ = read_bom(job["bom"])
        mats = {l["material"] for l in lines if l.get("material")}
    scope = ANALYST_PATH.lower()
    os.makedirs(job["out_dir"], exist_ok=True)

    for r in rows[:MAX_HISTORY]:
        cand = {**r, "offer": None, "overlap": None}
        out["candidates"].append(cand)
        res = json.loads(_evaluate(port, _search_js(r["transaction"]), log=log) or "{}")
        if res.get("error"):
            log(f"{r['transaction']}: OneDrive search failed ({res['error']})", "warn")
            continue
        files = [f for f in res.get("files", [])
                 if f.get("type") and scope in (f.get("path") or "").lower()
                 and "approved" in (f.get("name") or "").lower()
                 and f["type"].lower() in ("xlsx", "xlsm")]
        if not files:
            log(f"{r['transaction']} ({r['name']}): no approved offer in her case folders.")
            continue
        files.sort(key=lambda f: (revision_of(f["name"]), f.get("modified") or ""))
        f = files[-1]
        dl = json.loads(_evaluate(port, _download_js(f["path"]), 120000) or "{}")
        if dl.get("error") or not dl.get("b64"):
            log(f"{r['transaction']}: could not download {f['name']} ({dl.get('error')})", "warn")
            continue
        local = os.path.join(job["out_dir"], f"{r['transaction']} - {f['name']}.{f['type']}")
        with open(local, "wb") as fh:
            fh.write(base64.b64decode(dl["b64"]))
        rev = revision_of(f["name"])
        label = (f"{r['transaction']}{(' R%d' % rev) if rev else ''} "
                 f"({r['cpq_updated'] or f.get('modified')}, customer history)")
        prices, check = read_offer_prices(local, label, log)
        hit = len(mats & prices.keys())
        overlap = (hit / len(mats)) if mats else None
        cand.update(offer=local, offer_name=f["name"], label=label, check=check,
                    matched=hit, overlap=round(overlap, 3) if overlap is not None else None)
        log(f"{label}: prices {hit} of this BOM's {len(mats)} material(s)"
            + (f" ({overlap:.0%})" if overlap is not None else ""))
        if overlap is not None and overlap >= MIN_OVERLAP:
            out["pick"] = cand
            log(f"Carrying from {label} — {f['name']}", "ok")
            break
    if not out["pick"]:
        log(f"None of the customer's earlier offers prices {MIN_OVERLAP:.0%} of this BOM — "
            f"priced from scratch.")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    with open(args.job, encoding="utf-8-sig") as fh:
        job = json.load(fh)

    log_lines = []

    def log(msg, kind="info"):
        log_lines.append({"kind": kind, "msg": msg})
        print(f"[{kind}] {msg}", flush=True)

    try:
        result = history(job, log) if job.get("mode") == "history" else run(job, log)
    except Exception as e:
        log(str(e), "error")
        result = {"ok": False, "error": str(e)}
    result["log"] = log_lines
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, default=str)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
