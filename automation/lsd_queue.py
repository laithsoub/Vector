"""
lsd_queue.py — what is waiting in the analyst's LSD Daily work sheet.

Dalia adds one row to "LSD Daily work -2025 - 2026 - update .xlsx" for every
transaction that needs pricing. A row whose Status is not Done / Cancelled, and
whose Notes do not already say "Done by Laith", is work nobody has picked up —
that is the list this returns, so the LSD tab can offer each one for Fetch.

The workbook lives in her OneDrive (eaton-my). It is read the same way
onedrive_case.py reads her case folders: a credentialed fetch run inside a tab
that is already signed in to the debug-rail Edge, bytes back over CDP.
READ-ONLY — it downloads a copy, it never writes to her drive.

    python lsd_queue.py --job job.json --out result.json

job.json:
    {"port": 9222,                                   (default 9222)
     "file": "<file GUID or server-relative path>"}  (default: her workbook's GUID)

The GUID survives her renaming the file ("- update" has already been added to
its name once); a server-relative path does not, so the id is the default.
"""
import argparse
import base64
import datetime as dt
import io
import json
import os
import re
import sys
import warnings
from urllib.parse import urlparse
from urllib.request import urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpq_fetch as cf                    # the CDP plumbing, already proven

MY_HOST = "eaton-my.sharepoint.com"
ANALYST_SITE = "/personal/dalianabil_eaton_com"
# "LSD Daily work -2025 - 2026 - update .xlsx", Documents/Dalia/Pricing Work/Daily Work.
DEFAULT_FILE = "18f90546-889b-4653-89e5-0660e6b819a2"

# Her header row, matched by text (lower-cased, trimmed) — never by position.
# The sheet has "RPI Comment" twice; only the first of any header is taken.
HEADERS = {
    "country": "country", "bu": "bu", "transaction number": "transaction",
    "transaction name": "name", "customer number": "customer",
    "customer name": "customer_name", "status": "status", "sales name": "sales",
    "cpq last updated": "cpq_updated", "total value": "value", "notes": "notes",
}
CLOSED = ("done", "cancel")               # Done, Cancelled
W_RE = re.compile(r"^W\d{9,}E\d*$", re.I)


def _pages(port):
    try:
        tabs = json.loads(urlopen(f"http://localhost:{port}/json", timeout=5).read())
    except Exception as e:
        raise RuntimeError(f"Edge debug port {port} is not reachable ({e}). Start the app "
                           f"(start-app.ps1) so the debug-rail Edge is running.")
    pages = [t for t in tabs if t.get("type") == "page" and MY_HOST in (t.get("url") or "")]
    if not pages:
        raise RuntimeError(f"No {MY_HOST} tab is open in the debug-rail Edge. Open Dalia's "
                           f"OneDrive or her daily sheet there, sign in, and try again.")
    # The workbook tab goes FIRST. A fetch run inside it does not touch the page,
    # and the keep-alive never reloads it (#noreload) — whereas the Pricing cases
    # tab is reloaded on every sweep, and a read that lands mid-reload comes back
    # empty rather than failing (seen 2026-09-14: "'b64'").
    pages.sort(key=lambda t: "Doc.aspx" not in (t.get("url") or ""))
    return pages


def _activate(t, port):
    """Un-freeze the tab. The keep-alive runs Edge minimized, and Edge freezes a
    hidden tab: a plain expression still answers, but a fetch inside it never
    settles — the read sat 100 s per tab and the server killed it at 180 s
    (2026-09-14). Declaring the page 'active' first brings it back to ~2.5 s."""
    try:
        u = urlparse(t["webSocketDebuggerUrl"])
        s = cf._ws_connect(u.hostname, u.port or port, u.path, timeout=10)
        try:
            cf._ws_send(s, {"id": 1, "method": "Page.setWebLifecycleState",
                            "params": {"state": "active"}})
            for _ in range(500):
                if json.loads(cf._ws_recv(s)).get("id") == 1:
                    break
        finally:
            s.close()
    except Exception:
        pass                     # best effort — the read itself reports a failure


def _answer(t, port, expr):
    """One tab's reply, or an exception. An empty value — a page navigating
    under the script — is a failure too, so the next tab gets its turn."""
    _activate(t, port)
    # Short leash: an active tab answers in seconds, and two tabs plus a reload
    # must fit inside the server's 180 s kill.
    v = cf.evaluate_on(t, port, expr, socket_timeout=40, js_timeout_ms=35000)
    if not isinstance(v, str) or not v.startswith("{"):
        raise RuntimeError(f"{t.get('title') or 'tab'} returned nothing (page busy or reloading)")
    return v


def _evaluate(port, expr, log):
    last = None
    for t in _pages(port):
        try:
            return _answer(t, port, expr)
        except Exception as e:
            last = e
            log(f"{t.get('title') or t.get('url')}: {e}", "warn")
    # Every tab slept or signed out. Waking means reloading, so never the
    # workbook itself — someone may be typing in it.
    wake = next((t for t in _pages(port) if "Doc.aspx" not in (t.get("url") or "")), None)
    if wake and cf.wake_target(wake, port, log):
        return _answer(wake, port, expr)
    raise RuntimeError(f"No OneDrive tab answered ({last}). Click the debug-rail Edge awake "
                       f"or sign in to OneDrive there, and try again.")


def _download_js(ref):
    r = json.dumps(ref)
    return f"""(async () => {{
      const ref = {r};
      const site = location.origin + "{ANALYST_SITE}";
      const api = /^[0-9a-f-]{{36}}$/i.test(ref)
        ? site + "/_api/web/GetFileById('" + ref + "')"
        : site + "/_api/web/GetFileByServerRelativePath(decodedurl='"
               + encodeURIComponent(ref.replace(/'/g, "''")) + "')";
      const m = await fetch(api, {{headers:{{Accept:"application/json;odata=nometadata"}},
                                  credentials:"include"}});
      if (!m.ok) return JSON.stringify({{error: "file lookup HTTP " + m.status}});
      const meta = await m.json();
      const r = await fetch(api + "/$value", {{credentials:"include"}});
      if (!r.ok) return JSON.stringify({{error: "download HTTP " + r.status}});
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ""; const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH)
        s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      return JSON.stringify({{b64: btoa(s), bytes: buf.length,
        meta: {{name: meta.Name, modified: meta.TimeLastModified,
                url: meta.ServerRelativeUrl}}}});
    }})()"""


def _text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace(" ", " ").strip()


def parse(data, today=None, bus=("FIRE",)):
    """Open rows from the workbook bytes. Normal (not read_only) mode: read_only
    trusts the <dimension> record, which is how a CPQ export once read as empty.

    `bus` keeps only those BU values (Laith prices FIRE — "You should be fetching
    Fire only", 2026-09-14). A row with a BU outside it is dropped and counted; a
    row with NO BU is kept as `no_bu`, so a new row she has not labelled yet is
    shown rather than silently lost. Empty `bus` = every BU."""
    import openpyxl
    today = today or dt.date.today()
    bus = {b.strip().upper() for b in (bus or ()) if b and b.strip()}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")          # "Conditional Formatting extension…"
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)

    ws, hdr_row, cols = None, None, {}
    for sheet in wb.worksheets:
        for r in range(1, 6):
            names = {c.column: _text(c.value).lower() for c in sheet[r]}
            if "transaction number" in names.values():
                ws, hdr_row = sheet, r
                for col, name in names.items():
                    key = HEADERS.get(name)
                    if key and key not in cols:
                        cols[key] = col
                break
        if ws:
            break
    if not ws:
        raise RuntimeError("No sheet in the workbook has a 'Transaction Number' header — "
                           "has the layout changed?")

    rows, closed, other_bu, by_txn = [], 0, 0, {}
    for r in range(hdr_row + 1, ws.max_row + 1):
        cell = lambda k: ws.cell(r, cols[k]).value if k in cols else None
        status = _text(cell("status"))
        txn_raw = _text(cell("transaction"))
        name = _text(cell("name"))
        if not (txn_raw or name):
            continue
        sl = status.lower()
        if sl.startswith(CLOSED):
            closed += 1
            continue
        bu = _text(cell("bu"))
        if bus and bu and bu.upper() not in bus:
            other_bu += 1
            continue
        notes = _text(cell("notes"))
        # Her sheet pastes numbers with a trailing no-break space ('W262232087E\xa0').
        txn = re.sub(r"\s+", "", txn_raw).upper()
        if "laith" in notes.lower():
            kind = "laith"
        elif sl.startswith("hold"):
            kind = "hold"
        elif bus and not bu:
            kind = "no_bu"
        elif not W_RE.match(txn):
            kind = "no_number"
        else:
            kind = "fetch"

        upd = cell("cpq_updated")
        upd_d = upd.date() if isinstance(upd, dt.datetime) else upd if isinstance(upd, dt.date) else None
        value = cell("value")
        fill = ws.cell(r, cols["transaction"]).fill if "transaction" in cols else None
        row = {
            "row": r, "transaction": txn if W_RE.match(txn) else "", "raw_transaction": txn_raw,
            "country": _text(cell("country")), "bu": bu, "name": name,
            "customer": _text(cell("customer")), "customer_name": _text(cell("customer_name")),
            "status": status, "sales": _text(cell("sales")), "notes": notes,
            "cpq_updated": upd_d.isoformat() if upd_d else (_text(upd) or None),
            "age_days": (today - upd_d).days if upd_d else None,
            "value": (float(value) if isinstance(value, (int, float)) else (_text(value) or None)),
            # Her own colour code on the number cell (green = done, yellow / red / blue
            # for the rest). Carried, not interpreted.
            "fill": (fill.fgColor.rgb if fill is not None and fill.fill_type and
                     isinstance(fill.fgColor.rgb, str) else None),
            "kind": kind,
        }
        # A transaction entered twice while open: the later row is the current one.
        if row["transaction"] and row["transaction"] in by_txn:
            rows[by_txn[row["transaction"]]] = None
        if row["transaction"]:
            by_txn[row["transaction"]] = len(rows)
        rows.append(row)

    rows = [x for x in rows if x][::-1]          # her newest rows are at the bottom
    return {"sheet": ws.title, "header_row": hdr_row, "closed": closed,
            "other_bu": other_bu, "bu_filter": sorted(bus), "rows": rows}


def run(job, log):
    port = int(job.get("port") or 9222)
    ref = str(job.get("file") or "").strip() or DEFAULT_FILE
    got = json.loads(_evaluate(port, _download_js(ref), log) or "{}")
    if got.get("error"):
        raise RuntimeError(f"Could not read Dalia's daily sheet: {got['error']}")
    if not got.get("b64"):
        raise RuntimeError("Dalia's daily sheet came back empty — the OneDrive tab was busy. "
                           "Press refresh again in a minute.")
    data = base64.b64decode(got["b64"])
    log(f"Downloaded {got['meta'].get('name')} ({len(data) / 1024:.0f} KB, "
        f"last saved {got['meta'].get('modified')})")
    # "FIRE" by default; "all" (or "*") switches the filter off; a comma list widens it.
    want = job.get("bu")
    if isinstance(want, str):
        want = [] if want.strip().lower() in ("all", "*") else (want.split(",") if want.strip() else None)
    out = parse(data, bus=("FIRE",) if want is None else want)
    kinds = {}
    for x in out["rows"]:
        kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
    log(f"{len(out['rows'])} open {'/'.join(out['bu_filter']) or 'any-BU'} row(s) on "
        f"'{out['sheet']}' ({out['other_bu']} open in other BUs skipped, {out['closed']} "
        f"done/cancelled): " + ", ".join(f"{v} {k}" for k, v in kinds.items()))
    return {"ok": True, "file": got["meta"], **out}


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
        result = run(job, log)
    except Exception as e:
        log(str(e), "error")
        result = {"ok": False, "error": str(e)}
    result["log"] = log_lines
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, default=str)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
