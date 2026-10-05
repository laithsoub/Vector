"""
lsd_approvals.py — the LSD queue read from CPQ's own approval mail.

Laith 2026-09-30: fetch the transactions from the approval emails, not from
Dalia's daily sheet — she updates that by hand, so it lags and misses. CPQ sends
every approver "W… - Approval Required - <customer> - <number>" (and a REMINDER
every day it stays pending), and "Approval No Longer Required" once somebody
else has decided it or sales withdrew it. Laith's Outlook files them in
Inbox\\CPQ Approvals.

Each mail carries the whole line table (line, approver, PRICING GROUP, brand,
material, catalog, list, requested, qty, net fixed, discount), so the BU is read
off the lines themselves: a transaction is listed only when it has FIRE lines.
Pure CBS / EL deals (M8B/C/D/E/G/M, M5I …) are counted and skipped.

    python lsd_approvals.py --job job.json --out result.json

job.json:
    {"days": 45,                       how far back to read (default 45)
     "folder": "CPQ Approvals",        the Inbox subfolder (default)
     "bu": "",                         "" = FIRE only, "all" = every transaction
     "cache": "<path>.json"}           parsed-mail cache, so a tick opens only new mail

Rows come back in the same shape as lsd_queue.py's, so the LSD tab's queue panel
shows them unchanged. READ-ONLY: nothing in Outlook is moved, read-marked or sent.
"""
import argparse
import datetime as dt
import json
import re
import sys

# Pricing group code -> description, read off every CPQ export in the case
# archive 2026-09-30. FIRE is the set Laith prices; the rest is CBS / EL.
FIRE_CODES = {
    "M8A": "Addressable", "M8F": "Voice System EN", "M8I": "Universal",
    "M8J": "Conventional", "M8K": "Notification-EN", "M8L": "Voice System UL",
    "M8N": "Vocall & EAS", "MDE": "Notification-UL",
}
OTHER_CODES = {
    "M8B": "Luminaries Self contained", "M8C": "Modules", "M8D": "Luminaires",
    "M8E": "Batteries", "M8G": "Systems", "M8M": "PQ Micro DC", "M8P": "Legacy",
    "M5I": "Spares", "M5G": "Software",
}

W_RE = re.compile(r"\b(W\d{9}E\d*)\b", re.I)
NBSP = "\xa0"


def _clean(s):
    return str(s or "").replace(NBSP, " ").strip()


def _money(s):
    """'$12,349.83' / '€ 39.331,47' -> float. The decimal mark is whichever
    separator comes last, the same reading lsd_pricing.num uses."""
    t = re.sub(r"[^\d.,-]", "", _clean(s))
    if not t:
        return None
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif "," in t:
        head, _, tail = t.rpartition(",")
        t = f"{head.replace(',', '')}.{tail}" if len(tail) <= 2 else t.replace(",", "")
    try:
        return float(t)
    except ValueError:
        return None


def _field(lines, label):
    """The value line under 'Label:' in the mail's two-line layout."""
    for i, ln in enumerate(lines):
        if _clean(ln).lower() == label.lower() + ":":
            for nxt in lines[i + 1:i + 3]:
                if _clean(nxt):
                    # An empty field is followed straight by the next label.
                    return "" if _clean(nxt).endswith(":") else _clean(nxt)
            return ""
    return ""


def parse_body(body):
    lines = str(body or "").replace("\r", "").split("\n")
    out = {
        "submitted_by": "",
        "customer": _field(lines, "Customer #").lstrip("0"),
        "customer_name": _field(lines, "Customer Name"),
        "name": _field(lines, "Transaction Name"),
        "type": _field(lines, "Transaction Type"),
        "status": _field(lines, "Transaction Status"),
        "currency": _field(lines, "Currency"),
        "value": _money(_field(lines, "Transaction Total")),
        "comments": _field(lines, "Requester's comments"),
        "reason": _field(lines, "Approval Request Reason"),
        "country": "",
        "lines": [],
    }
    m = re.search(r"\n\s*(.+?) has submitted transaction", "\n" + "\n".join(lines))
    if m:
        out["submitted_by"] = _clean(m.group(1))
    # "CAIRO, Egypt, Egypt" / "DUBAI, , Utd.Arab Emir." — the line under the name.
    for i, ln in enumerate(lines):
        if _clean(ln).lower() == "customer name:":
            rest = [_clean(x) for x in lines[i + 2:i + 4] if _clean(x)]
            if rest and "," in rest[0]:
                out["country"] = [p.strip() for p in rest[0].split(",") if p.strip()][-1]
            break

    # The line table: each row opens with its line number "1.0", "2.0", … and
    # the cells follow one per line. Rows are split on the NEXT expected number
    # (a net fixed amount can read "2.0" too), and inside a row the cells are
    # found by shape — the pricing group is the first 3-character code, the two
    # currency cells are list then requested, the qty the number after them —
    # because a row can drop a cell (no brand, no approver). Ends at "Account Type:".
    try:
        end = next(i for i, ln in enumerate(lines) if _clean(ln).lower() == "account type:")
    except StopIteration:
        end = len(lines)
    start = next((i for i, ln in enumerate(lines) if _clean(ln).lower() == "percent"), None)
    if start is None:
        return out
    cells = [_clean(x) for x in lines[start + 1:end]]
    # A row number rises, and is followed by the approver then the group code
    # (or the group straight away). Numbering need not start at 1 — a reminder
    # can list only the lines still pending ("4.0" first).
    code = lambda c: bool(re.fullmatch(r"[A-Z][A-Z0-9]{2}", c))
    marks, last = [], 0
    for i, c in enumerate(cells):
        m = re.fullmatch(r"(\d+)\.0", c)
        if m and int(m.group(1)) > last and (
                (i + 1 < len(cells) and code(cells[i + 1])) or
                (i + 2 < len(cells) and code(cells[i + 2]) and not code(cells[i + 1]))):
            marks.append(i)
            last = int(m.group(1))
    for k, at in enumerate(marks):
        row = cells[at + 1:marks[k + 1] if k + 1 < len(marks) else len(cells)]
        g = next((j for j, c in enumerate(row) if re.fullmatch(r"[A-Z][A-Z0-9]{2}", c)), None)
        cur = [j for j, c in enumerate(row) if re.match(r"^(\$|€|£|USD|EUR)", c)]
        after = row[cur[1] + 1:] if len(cur) >= 2 else []
        qty = next((_money(c) for c in after if re.fullmatch(r"[\d.,]+", c)), None)
        rest = [c for c in (row[g + 1:cur[0]] if g is not None and cur else [])]
        out["lines"].append({
            "line": cells[at], "group": row[g] if g is not None else "",
            "brand": rest[0] if len(rest) >= 3 else "",
            "material": rest[-2] if len(rest) >= 2 else (rest[0] if rest else ""),
            "catalog": rest[-1] if rest else "",
            "list": _money(row[cur[0]]) if cur else None,
            "requested": _money(row[cur[1]]) if len(cur) >= 2 else None,
            "qty": qty,
        })
    return out


def classify(lines):
    fire = [l for l in lines if l["group"] in FIRE_CODES]
    other = [l for l in lines if l["group"] not in FIRE_CODES]
    val = lambda ls: sum((l["requested"] or 0) * (l["qty"] or 0) for l in ls)
    groups = sorted({FIRE_CODES[l["group"]] for l in fire})
    bu = ("FIRE" if fire and not other else "FIRE + CBS/EL" if fire else
          "CBS/EL" if lines else "")
    return {"bu": bu, "fire_lines": len(fire), "other_lines": len(other),
            "fire_value": round(val(fire), 2), "other_value": round(val(other), 2),
            "fire_groups": groups,
            "unknown_groups": sorted({l["group"] for l in other if l["group"] not in OTHER_CODES})}


def read_mail(folder_name, days, log, cache):
    """Group the approval mail by transaction. Light on Outlook: the list comes
    from the folder's Table (subject / time / id — no item is opened), and a body
    is opened only for a mail whose parsed lines are not already in `cache`
    (EntryID -> parse_body result). A 5-minute timer runs this, so after the
    first read a tick opens only the mail that arrived since the last one."""
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    ns = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
    inbox = ns.GetDefaultFolder(6)
    try:
        folder = inbox.Folders[folder_name]
    except Exception:
        raise RuntimeError(f"No '{folder_name}' folder under the Inbox — the CPQ approval "
                           f"mail is filed there by an Outlook rule.")
    since = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%m/%d/%Y")
    tbl = folder.GetTable(f"[ReceivedTime] >= '{since} 00:00'")
    tbl.Columns.RemoveAll()
    for c in ("EntryID", "Subject", "ReceivedTime"):
        tbl.Columns.Add(c)
    tbl.Sort("[ReceivedTime]", True)                         # newest first
    mails = []
    while not tbl.EndOfTable:
        r = tbl.GetNextRow()
        try:
            recv = r["ReceivedTime"]
            mails.append((r["EntryID"], _clean(r["Subject"]),
                          dt.datetime(recv.year, recv.month, recv.day, recv.hour, recv.minute)))
        except Exception:
            continue
    mails.sort(key=lambda m: m[2], reverse=True)

    opened = 0

    def parsed(eid):
        nonlocal opened
        if eid not in cache:
            try:
                cache[eid] = parse_body(ns.GetItemFromID(eid).Body)
            except Exception:
                cache[eid] = parse_body("")
            opened += 1
        return cache[eid]

    by_w = {}
    n = 0
    for eid, subj, stamp in mails:
        w = W_RE.search(subj)
        if not w:
            continue
        n += 1
        w = w.group(1).upper()
        rec = by_w.setdefault(w, {"transaction": w, "mails": 0, "reminders": 0,
                                  "closed_at": None, "last": None, "first": None,
                                  "req": [], "entry_id": None, "req_at": None})
        rec["mails"] += 1
        rec["first"] = stamp                                 # walking newest -> oldest
        rec["last"] = rec["last"] or stamp
        if "no longer required" in subj.lower():
            rec["closed_at"] = rec["closed_at"] or stamp
            continue
        if "reminder" in subj.lower():
            rec["reminders"] += 1
        if rec["entry_id"] is None:
            rec["entry_id"], rec["req_at"] = eid, stamp
        rec["req"].append(eid)

    for rec in by_w.values():
        if not rec["req"] or (rec["closed_at"] and rec["closed_at"] >= rec["req_at"]):
            rec["parsed"] = None
            continue
        # The newest request carries the latest lines. Some reminders arrive with
        # the table cut off; up to three older requests are the fallback.
        p = dict(parsed(rec["req"][0]))
        for eid in rec["req"][1:4]:
            if p["lines"]:
                break
            p["lines"] = parsed(eid)["lines"]
        rec["parsed"] = p
    log(f"Read {n} approval mail(s) over {days} days: {len(by_w)} transaction(s), "
        f"opened {opened} new")
    keep = {m[0] for m in mails}
    for eid in [e for e in cache if e not in keep]:
        del cache[eid]
    return by_w


def run(job, log):
    days = int(job.get("days") or 45)
    folder = str(job.get("folder") or "CPQ Approvals")
    want_all = str(job.get("bu") or "").strip().lower() in ("all", "*")
    today = dt.date.today()
    rows, closed, other_bu = [], 0, 0
    cache_path = str(job.get("cache") or "").strip()
    cache = {}
    if cache_path:
        try:
            with open(cache_path, encoding="utf-8") as fh:
                cache = json.load(fh)
        except Exception:
            cache = {}
    got = read_mail(folder, days, log, cache)
    if cache_path:
        try:
            with open(cache_path, "w", encoding="utf-8") as fh:
                json.dump(cache, fh)
        except Exception as e:                               # noqa: BLE001 - reported
            log(f"Could not save the parse cache: {e}", "warn")
    for w, rec in got.items():
        # Closed when the newest word from CPQ is "no longer required".
        if rec["closed_at"] and (not rec.get("req_at") or rec["closed_at"] >= rec["req_at"]):
            closed += 1
            continue
        p = rec.get("parsed")
        if p is None:
            continue
        cls = classify(p["lines"])
        if not want_all and not cls["fire_lines"]:
            other_bu += 1
            continue
        notes = [f"{cls['fire_lines']} of {len(p['lines'])} line(s) FIRE"
                 + (f" ({', '.join(cls['fire_groups'])})" if cls["fire_groups"] else "")]
        if cls["other_lines"] and cls["fire_lines"]:
            notes.append(f"{cls['other_lines']} CBS/EL line(s) worth {cls['other_value']:,.0f} — not ours")
        if cls["unknown_groups"]:
            notes.append(f"unknown group(s) {', '.join(cls['unknown_groups'])}")
        if p["comments"] and p["comments"].lower() not in ("please approve", "plz approve", "null", "n/a"):
            notes.append(f"sales: \"{p['comments']}\"")
        first = rec["first"].date()
        rows.append({
            "row": 0, "transaction": w, "raw_transaction": w,
            "country": p["country"], "bu": cls["bu"], "name": p["name"],
            "customer": p["customer"], "customer_name": p["customer_name"],
            "status": p["status"] + (f" · {rec['reminders']} reminder(s)" if rec["reminders"] else ""),
            "sales": p["submitted_by"], "notes": " · ".join(notes),
            "cpq_updated": rec["req_at"].date().isoformat(),
            "age_days": (today - first).days,
            "value": p["value"], "currency": p["currency"], "fill": None,
            "kind": "fetch" if cls["fire_lines"] else "no_bu",
            "entry_id": rec["entry_id"], "requested_at": rec["req_at"].isoformat(),
            "first_mail": rec["first"].isoformat(), "reminders": rec["reminders"],
            "fire_lines": cls["fire_lines"], "other_lines": cls["other_lines"],
            "fire_value": cls["fire_value"], "type": p["type"],
        })
    rows.sort(key=lambda r: r["requested_at"], reverse=True)
    log(f"{len(rows)} open {'' if want_all else 'FIRE '}transaction(s); {other_bu} CBS/EL-only "
        f"skipped, {closed} no longer required")
    return {"ok": True, "source": "mail", "folder": folder, "closed": closed,
            "other_bu": other_bu, "bu_filter": [] if want_all else ["FIRE"], "rows": rows}


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
    except Exception as e:                                   # noqa: BLE001 - reported
        log(str(e), "error")
        result = {"ok": False, "error": str(e)}
    result["log"] = log_lines
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, default=str)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
