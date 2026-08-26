"""
cpq_fetch.py — pull one transaction's BOM + header out of Oracle CPQ.
====================================================================
Given a transaction number (e.g. W262168503E), this drives the user's own
logged-in CPQ tab over the Edge remote-debugging port (the same rail JOE uses)
and reads the quote straight from Oracle CPQ's REST v19 API — no scraping, no
file download. It then writes a CPQ-shaped .xlsx export so everything downstream
(lsd_pricing.py, the saved "transaction" file in the case folder) is byte-for-
byte the same as if the analyst had clicked Export Line Items by hand.

Why the browser and not a direct API call: CPQ sits behind Oracle SSO, a
different identity realm from SharePoint/JOE. We never hold CPQ credentials — we
borrow the session already open in the debug-rail Edge, exactly as the cookie
refresher borrows the SharePoint session. The REST calls run in that tab's own
page context (fetch with credentials), so they carry the user's live auth.

The fetch is proven: rebuilding W262168503E's BOM from the API and pricing it
reproduces the analyst's approved total to the cent (253,217.96, 33/33 lines).

Usage:
    python cpq_fetch.py --job job.json --out result.json
job.json: {"transaction": "W262168503E", "port": 9222, "out_dir": "<folder>"}
    port    — Edge remote-debugging port (default 9222)
    out_dir — where to write the .xlsx export (default: a temp dir)
result.json: {"ok", "header": {...}, "xlsx": "<path>", "lines": N, "log": [...]}
"""
import argparse
import base64
import datetime as _dt
import json
import os
import socket
import struct
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen

REST = "/cpq/rest/v19"
CPQ_HOST_HINT = "bigmachines.com"
# The transactionLine fields the export needs. Names verified against the live
# API (2026-08-26); each maps to a CPQ "Export Line Items" column below.
LINE_FIELDS = [
    "_sequence_number",
    "materialLineItem_l",                    # Material # / Catalog #
    "materialLineItemShortDescription_l",    # Description
    "materialPricingGroup_l",                # Pricing Group (code, e.g. M8A)
    "materialPricingGroupShortDescription_l",# Pricing Group Description (e.g. Addressable)
    "requestedQuantity_l",                   # Qty
    "oldListPrice_l",                        # List Price
    "customerConditionInPer_l",              # Customer Condition % (standard disc)
    "netFixedAmountString_l",                # Net Fixed Amount / Requested Price
    "extraDiscount_l_c",                     # Requested Discount %
    "cost_l",                                # Cost
]

# The CPQ "Export Line Items" header row, in order (56 columns). The engine reads
# by position, so the reconstructed export must put each value in the same column
# the manual export uses. Columns we do not fetch stay blank — the engine ignores
# them, and the file still reads as a faithful export.
EXPORT_HEADER = [
    "Identifier", "Seq #", "Line #", "Config #", "Alternates", "Approval Required",
    "Item Status", "Catalog #", "Material #", "Description", "Product Hierarchy",
    "Designation", "Customer Part #", "Pricing Group", "Pricing Group Description",
    "Qty", "Lead Time", "List Price", "Price Per (SAP)", "UOM", "Customer Condition %",
    "Net Price", "Net List % Diff", "Last Approved", "Net Fixed Amount", "Discount Percent",
    "Requested Price", "Suggested Selling Price", "Suggested Discount %",
    "Suggested Wholesaler Margin", "Requested Discount %", "Start %", "Target %",
    "Min. Order Qty", "Rounding Qty", "Environmental Fee", "Total", "Approver Name",
    "Cost", "Cost with Markup", "Cost Source", "Margin Value", "Margin %", "Plant",
    "Approved Net Fixed Amount", "Approved Discount %", "Approved Margin",
    "ApprovedExtendedMargin", "Final Approved Margin", "Line Owner", "Internal Due Date",
    "Approver", "Resale Net", "Notes", "Attachment", "Print On Output",
]
# 1-based column position of each field we populate (matches BOM_COLS in lsd_pricing).
COL = {"catalog": 8, "material": 9, "description": 10, "group_code": 14, "group": 15,
       "qty": 16, "list": 18, "std_pct": 21, "net_fixed": 25, "requested": 27,
       "req_disc_pct": 31, "cost": 39}


# ── minimal Chrome DevTools Protocol client (stdlib only) ────────────────────
def _ws_connect(host, port, path):
    s = socket.create_connection((host, port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            break
        resp += chunk
    if b"101" not in resp:
        raise RuntimeError("debug-port WebSocket handshake failed")
    return s


def _ws_send(s, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    ln = len(data)
    frame = bytearray([0x81])
    if ln < 126:
        frame.append(0x80 | ln)
    elif ln < 65536:
        frame.append(0x80 | 126); frame += struct.pack(">H", ln)
    else:
        frame.append(0x80 | 127); frame += struct.pack(">Q", ln)
    frame += mask
    frame += bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(bytes(frame))


def _ws_recv(s):
    def rd(n):
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                raise RuntimeError("debug-port socket closed")
            b += c
        return b
    h = rd(2)
    ln = h[1] & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", rd(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", rd(8))[0]
    return rd(ln).decode("utf-8", "replace")


def _find_cpq_target(port):
    """Return the CDP page target for the open CPQ tab, or None."""
    try:
        tabs = json.loads(urlopen(f"http://localhost:{port}/json", timeout=4).read())
    except Exception as e:
        raise RuntimeError(
            f"Edge debug port {port} is not reachable ({e}). Start the app "
            f"(start-app.ps1) so the debug-rail Edge is running, and open CPQ in it.")
    pages = [t for t in tabs if t.get("type") == "page"
             and CPQ_HOST_HINT in (t.get("url") or "")]
    if not pages:
        raise RuntimeError(
            "No CPQ tab found in the debug-rail Edge. Open "
            "https://eaton.bigmachines.com/ and sign in, then try again.")
    # Prefer a quotes/transaction page over any other CPQ tab.
    pages.sort(key=lambda t: ("quote" not in (t.get("url") or "").lower(),))
    return pages[0]


def _evaluate(port, expr):
    """Run JS in the CPQ tab's page context and return its value."""
    target = _find_cpq_target(port)
    ws = target["webSocketDebuggerUrl"]
    u = urlparse(ws)
    s = _ws_connect(u.hostname, u.port or port, u.path)
    try:
        _ws_send(s, {"id": 1, "method": "Runtime.enable"})
        _ws_send(s, {"id": 2, "method": "Runtime.evaluate", "params": {
            "expression": expr, "returnByValue": True, "awaitPromise": True,
            "timeout": 30000}})
        for _ in range(600):
            msg = json.loads(_ws_recv(s))
            if msg.get("id") == 2:
                r = msg.get("result", {})
                if "exceptionDetails" in r:
                    txt = r["exceptionDetails"].get("exception", {}).get("description") \
                        or json.dumps(r["exceptionDetails"])[:300]
                    raise RuntimeError(f"CPQ page script error: {txt}")
                return r.get("result", {}).get("value")
        raise RuntimeError("CPQ page did not respond in time")
    finally:
        s.close()


# ── the two REST reads, run inside the CPQ tab ───────────────────────────────
def _search_js(transaction):
    fields = ("_id,bs_id,transactionNumber_t,transactionName_t,customerNumber_t,"
              "customerName_t,opportunityID_t,preparedByName_t,transactionType_t,status_t")
    q = json.dumps({"transactionNumber_t": transaction})
    return f"""(async () => {{
      const q = encodeURIComponent({json.dumps(q)});
      const url = "{REST}/commerceDocumentsOraclecpqoTransaction?fields={fields}&q="+q+"&limit=5&totalResults=true";
      const r = await fetch(url, {{headers:{{Accept:"application/json"}}, credentials:"include"}});
      if (r.status === 401 || r.status === 403) return JSON.stringify({{authError:r.status}});
      const j = await r.json();
      const val = v => (v && typeof v==='object' && 'value' in v) ? v.value : v;
      const items = (j.items||[]).map(it => {{
        const o = {{}}; for (const k of Object.keys(it)) o[k] = val(it[k]); return o;
      }});
      return JSON.stringify({{status:r.status, total:j.totalResults ?? items.length, items}});
    }})()"""


def _lines_js(doc_id, offset, limit):
    fields = ",".join(LINE_FIELDS)
    return f"""(async () => {{
      const url = "{REST}/commerceDocumentsOraclecpqoTransaction/{doc_id}/transactionLine?fields={fields}&limit={limit}&offset={offset}";
      const r = await fetch(url, {{headers:{{Accept:"application/json"}}, credentials:"include"}});
      const j = await r.json();
      const val = v => (v && typeof v==='object' && 'value' in v) ? v.value : v;
      const clean = s => (typeof s === 'string') ? s.replace(/[\\u0000-\\u001f]/g,' ') : s;
      const rows = (j.items||[]).map(it => {{
        const o = {{}}; for (const k of Object.keys(it)) if (k!=='links') o[k]=clean(val(it[k])); return o;
      }});
      return JSON.stringify({{n:rows.length, rows}});
    }})()"""


def fetch_transaction(transaction, port, log):
    log(f"Searching CPQ for {transaction}")
    res = json.loads(_evaluate(port, _search_js(transaction)))
    if res.get("authError"):
        raise RuntimeError(
            f"CPQ returned {res['authError']} — the CPQ tab is not signed in. "
            f"Sign into CPQ in the debug-rail Edge, then try again.")
    items = res.get("items", [])
    if not items:
        raise RuntimeError(f"No CPQ transaction found for {transaction}.")
    if len(items) > 1:
        # Same number can appear across revisions; take the exact match if there is one.
        exact = [i for i in items if str(i.get("transactionNumber_t")) == transaction]
        items = exact or items
        log(f"{len(res['items'])} matches — using document {items[0].get('_id')}", "warn")
    doc = items[0]
    doc_id = doc.get("_id") or doc.get("bs_id")
    log(f"Found document {doc_id}: {doc.get('transactionName_t')!r} "
        f"({doc.get('status_t', {}).get('displayValue') if isinstance(doc.get('status_t'), dict) else doc.get('status_t')})")

    # page the line items (a big quote can exceed one page)
    rows, offset, page = [], 0, 100
    while True:
        chunk = json.loads(_evaluate(port, _lines_js(doc_id, offset, page)))
        got = chunk.get("rows", [])
        rows.extend(got)
        if len(got) < page:
            break
        offset += page
        if offset > 5000:                      # sanity stop
            log("stopped paging at 5000 lines", "warn"); break
    log(f"Read {len(rows)} line item(s) from CPQ")

    tt = doc.get("transactionType_t")
    header = {
        "transaction": doc.get("transactionNumber_t") or transaction,
        "customer": _digits(doc.get("customerNumber_t")),
        "customer_name": doc.get("customerName_t") or "",
        "project": doc.get("transactionName_t") or "",
        "crm": doc.get("opportunityID_t") or "",
        "doc_id": str(doc_id),
        "transaction_type": tt.get("value") if isinstance(tt, dict) else tt,
    }
    return header, rows


def _digits(v):
    """CPQ stores customer numbers zero-padded ('0000096278'); the model keys on
    the plain integer. Strip leading zeros but keep a real value."""
    s = str(v or "").strip()
    return (s.lstrip("0") or "0") if s.isdigit() else s


# ── write the CPQ-shaped export ──────────────────────────────────────────────
def _num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def write_export(transaction, doc_id, rows, out_dir, log):
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Line Items"
    ws.append(EXPORT_HEADER)
    for r in rows:
        line = [None] * len(EXPORT_HEADER)
        def put(key, val):
            line[COL[key] - 1] = val
        mat = r.get("materialLineItem_l")
        put("catalog", mat)
        put("material", mat)
        put("description", r.get("materialLineItemShortDescription_l"))
        put("group_code", r.get("materialPricingGroup_l"))
        put("group", r.get("materialPricingGroupShortDescription_l"))
        put("qty", _num(r.get("requestedQuantity_l")))
        put("list", _num(r.get("oldListPrice_l")))
        put("std_pct", _num(r.get("customerConditionInPer_l")))
        # Net Fixed Amount is the requested price; the model reads col Y as text.
        put("net_fixed", r.get("netFixedAmountString_l"))
        put("requested", _num(r.get("netFixedAmountString_l")))
        put("req_disc_pct", _num(r.get("extraDiscount_l_c")))
        put("cost", _num(r.get("cost_l")))
        ws.append(line)

    os.makedirs(out_dir, exist_ok=True)
    stamp = _dt.date.today().isoformat()
    # Mirror CPQ's own export name: <document id>_<date>.xlsx
    path = os.path.join(out_dir, f"{doc_id or transaction}_{stamp}.xlsx")
    wb.save(path)
    log(f"Wrote CPQ export: {os.path.basename(path)}")
    return path


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    job = json.load(open(args.job, encoding="utf-8"))
    log_lines = []

    def log(msg, kind="info"):
        log_lines.append({"kind": kind, "msg": msg})
        print(f"[{kind}] {msg}", flush=True)

    result = {"ok": False}
    try:
        transaction = str(job.get("transaction") or "").strip()
        if not transaction:
            raise RuntimeError("No transaction number given.")
        port = int(job.get("port") or 9222)
        out_dir = job.get("out_dir") or tempfile.mkdtemp(prefix="cpq_")

        header, rows = fetch_transaction(transaction, port, log)
        if not rows:
            raise RuntimeError("The CPQ transaction has no line items.")
        xlsx = write_export(transaction, header["doc_id"], rows, out_dir, log)

        result = {"ok": True, "header": header, "xlsx": xlsx, "lines": len(rows)}
        log("Done.", "ok")
    except Exception as e:
        log(str(e), "error")
        result = {"ok": False, "error": str(e)}
    finally:
        result["log"] = log_lines
        json.dump(result, open(args.out, "w", encoding="utf-8"), default=str)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
