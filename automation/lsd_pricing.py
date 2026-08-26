"""
lsd_pricing.py — LSD CPQ pricing: transaction in, feedback + working file out.
=============================================================================
Drop a CPQ "Export Line Items" transaction; get back a case folder holding

    <W-number> - <project>/
        <the transaction as dropped>              (untouched)
        Approved Offer - Approved (<W>).xlsx      the Feedback sheet, values only
        Working File (<W>).xlsb                   the master model, filled + toggled

The Working File is the real master CPQ model with this transaction pasted into
'Paste BOM Here', the ledger header set, APRC/currency toggled, and the decided
Add. Discount written into column R — every derived column left LIVE, so the file
shows how the feedback was produced rather than just asserting it.

THE RULE (LSD Daily Work Procedure, 2026-08-05 — measured on 165 case models /
2148 priced lines, reproduces the analyst's own number on 42% of lines and 58%
of lines with no prior-year history):

    Add. Discount = MIN( Requested Discount , Add. Discount @Target E2E , 20% )

then every line that has a country prior-year reference is pulled up to the RPI
floor for the half-year (H1 3.5% / H2 6%) if it sits below it. Target E2E is a
FLOOR, not a value to match — comfortable lines are left alone — and the result
is never rounded (rounding was measured and it makes the match worse).

The RPI solve is algebraic, not iterative, because Mix Variance does not move
with price. Mirrors the model's own formulas exactly (see _rpi_target):

    AB Price Variance = IF(QTY/PYctryQTY <= 499.99%, (S - W) * QTY, 0)
    AD Mix Variance   = (QTY - QFC) * (W - Y)      when both averages exist
                      = (S - Y) * QTY             when only the country average does
    AE Total RPI Val  = AB + AD          AF Total RPI% = AE / (QTY*S - AE)

Reference data (E2E targets, prior-year customer/ledger averages and quantities,
customer master) is read straight out of the master .xlsb with pyxlsb — the same
sheets the model's own XLOOKUPs use: 'E2E Guidelines ', 'PV 2025 ',
'MV Ledger 2025', 'Customer Master Data'.

Usage
-----
    python lsd_pricing.py --job job.json --out result.json

job.json:
    {"mode": "preview" | "build",
     "bom": "<path to the transaction>",
     "master": "<path to the master CPQ .xlsb>",
     "cases_root": "<folder the case folder is created in>",   (build only)
     "customer": "74895", "country": "UAE", "customer_name": "...",
     "project": "MOPA Project", "transaction": "W262168503E", "crm": "...",
     "ledger": "R2321", "half": "H1"|"H2"|"auto", "aprc": "525"|"530-535"|"auto"}

`preview` needs no Excel — it prices the lines and returns them as JSON.
`build` needs Excel (pywin32 COM) because only Excel can write a .xlsb.
"""
import argparse
import csv
import datetime as _dt
import json
import os
import re
import shutil
import sys
import warnings

warnings.filterwarnings("ignore")

# ─── The rule's locked constants ─────────────────────────────────────────────
RPI_RATE = {"H1": 0.035, "H2": 0.06}   # half-year RPI floor
ADD_DISC_CAP = 0.20                    # the 20% flatten in the MIN shortcut
FIVEX = 4.9999                         # model gate: QTY/PYctryQTY <= 499.99%
STD_DISCOUNT = 0.55                    # default customer condition when the BOM omits it
EPS = 1e-9

# Ledger geometry (V2 master). Data rows 13..500 feed Feedback 12..634.
LEDGER_SHEET = "Model Ledger "
FIRST_ROW = 13
MAX_LINES = 500 - FIRST_ROW            # 487 lines before the ledger runs out of formulas

# Pricing groups that make a transaction FIRE (APRC 530-535 → USD) rather than
# EL (APRC 525 → EUR). From the E2E Guidelines group list.
FIRE_GROUPS = {
    "addressable", "conventional", "notification-ul", "notification-en",
    "notification", "vocall & eas", "voice system ul/en", "voice system",
}


# ─── small helpers ───────────────────────────────────────────────────────────
def num(v):
    """Excel-ish number coercion. '26.96', 26.96, '33.27%' → float; junk → None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    pct = s.endswith("%")
    if pct:
        s = s[:-1]
    try:
        f = float(s)
    except ValueError:
        return None
    return f / 100 if pct else f


def canon(v):
    """Render a cell the way Excel's CONCATENATE would: an integral number loses
    its '.0' and never goes scientific. This is what makes the customer/ledger +
    material lookup keys match the sheets."""
    if v is None:
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f = float(v)
        return format(int(f), "d") if f.is_integer() else repr(f)
    s = str(v).strip()
    if re.fullmatch(r"-?\d+\.0", s):        # '17376.0' → '17376'
        s = s[:-2]
    return s


def _half_from_date(d):
    return "H1" if d.month <= 6 else "H2"


def guess_half(bom_path):
    """CPQ exports are named <number>_<YYYY-MM-DD>.xlsx — the transaction's own
    date decides the RPI rate. Fall back to today."""
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", os.path.basename(str(bom_path)))
    if m:
        try:
            return _half_from_date(_dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        except ValueError:
            pass
    return _half_from_date(_dt.date.today())


def safe_name(s, limit=90):
    """A folder/file name Windows will accept."""
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(s or "")).strip(" .")
    s = re.sub(r"\s+", " ", s)
    return s[:limit].strip() or "case"


# ─── reading the transaction ─────────────────────────────────────────────────
# CPQ "Export Line Items" column positions (1-based), identical across .csv and
# the .xlsx you get by opening it. These are the columns the ledger XLOOKUPs.
BOM_COLS = {
    "catalog": 8, "material": 9, "description": 10, "group_code": 14,
    "group": 15, "qty": 16, "list": 18, "std_pct": 21, "net_price": 22,
    "net_fixed": 25, "requested": 27, "req_disc_pct": 31, "cost": 39,
}
HEADER_MARKERS = ("material #", "catalog #", "pricing group description")


def _row_to_line(cells):
    """One raw export row → a line dict, or None when the row carries no material."""
    def at(key):
        i = BOM_COLS[key] - 1
        return cells[i] if i < len(cells) else None

    mat_raw = at("material") or at("catalog")
    if mat_raw in (None, "", 0, "0"):
        return None
    qty = num(at("qty"))
    if qty is None:
        return None

    std_pct = num(at("std_pct"))
    # The export carries 'Customer Condition %' as 55 (a percent), the ledger
    # divides by 100. An empty column means the default 55% (procedure 5c).
    std = (std_pct / 100) if std_pct is not None else STD_DISCOUNT
    if std > 1:                                  # already-fractional guard
        std = std / 100

    req = num(at("net_fixed"))
    if req is None:
        req = num(at("requested"))
    if req is None:
        req = num(at("net_price"))

    return {
        "material": canon(mat_raw),
        "description": at("description"),
        "group": (str(at("group") or "").strip() or None),
        "group_code": at("group_code"),
        "qty": qty,
        "list": num(at("list")),
        "std_disc": std,
        "requested": req,
        "req_disc_pct": num(at("req_disc_pct")),
        "cost": num(at("cost")),
    }


def read_bom(path):
    """Read a CPQ transaction export: .csv (as downloaded), .xlsx or .xlsb.
    Returns (lines, header_row) — header_row is kept verbatim so the Working
    File's 'Paste BOM Here' is a faithful copy of what CPQ produced."""
    path = str(path)
    low = path.lower()
    if low.endswith(".csv"):
        rows = _read_csv_rows(path)
    elif low.endswith(".xlsb"):
        rows = _read_xlsb_rows(path)
    else:
        rows = _read_xlsx_rows(path)

    if not rows:
        raise ValueError("The transaction file is empty.")

    header, body = rows[0], rows[1:]
    joined = " ".join(str(c or "").lower() for c in header)
    if not any(m in joined for m in HEADER_MARKERS):
        # No header row — treat every row as data and synthesise one.
        body = rows
        header = [""] * max(len(r) for r in rows)

    lines = [ln for ln in (_row_to_line(r) for r in body) if ln]
    if not lines:
        raise ValueError(
            "No priceable lines found. Expected a CPQ 'Export Line Items' file "
            "with Material # in column I and Qty in column P.")
    return lines, header, body[:len(body)]


def _read_csv_rows(path):
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        sample = fh.read(8192)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        return [r for r in csv.reader(fh, dialect) if any(str(c).strip() for c in r)]


def _read_xlsx_rows(path):
    # NOT read_only: CPQ writes a bogus <dimension> record (it claims A1:A1), and
    # openpyxl's read-only worksheet trusts it — every export but one came back as
    # a single one-cell row. Normal mode rebuilds the dimensions from the cells.
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    out = []
    for row in ws.iter_rows(values_only=True):
        if row and any(c not in (None, "") for c in row):
            out.append(list(row))
    wb.close()
    return out


def _read_xlsb_rows(path):
    import pyxlsb
    out = []
    with pyxlsb.open_workbook(path) as wb:
        with wb.get_sheet(wb.sheets[0]) as sh:
            for row in sh.rows():
                cells = {c.c: c.v for c in row}
                if not cells:
                    continue
                width = max(cells) + 1
                vals = [cells.get(i) for i in range(width)]
                if any(v not in (None, "") for v in vals):
                    out.append(vals)
    return out


# ─── reference data out of the master model ──────────────────────────────────
def load_reference(master):
    """Read the four lookup tables the ledger uses. Keys are built exactly like
    the model's CONCATENATE so a Python price equals the Excel price."""
    import pyxlsb
    e2e, pv, mv, cust = {}, {}, {}, {}
    with pyxlsb.open_workbook(str(master)) as wb:
        names = {n.strip(): n for n in wb.sheets}

        # 'E2E Guidelines ' — I = pricing group description, N = E2E% target
        if "E2E Guidelines" in names:
            with wb.get_sheet(names["E2E Guidelines"]) as sh:
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    desc, tgt = v.get(8), num(v.get(13))
                    if desc and tgt is not None and str(desc).strip().lower() != "pricing group/":
                        e2e.setdefault(str(desc).strip().lower(), tgt)

        # 'PV 2025 ' — J = customer&material, H = Cust ASP 25, F = Sales Qty
        if "PV 2025" in names:
            with wb.get_sheet(names["PV 2025"]) as sh:
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    key = v.get(9)
                    if key not in (None, "", "conc"):
                        pv.setdefault(canon(key), (num(v.get(7)), num(v.get(5))))

        # 'MV Ledger 2025' — H = ledger&material, F = ledger ASP 25, D = Sales Qty
        if "MV Ledger 2025" in names:
            with wb.get_sheet(names["MV Ledger 2025"]) as sh:
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    key = v.get(7)
                    if key not in (None, "", "conc"):
                        mv.setdefault(canon(key), (num(v.get(5)), num(v.get(3))))

        # 'Customer Master Data' — A = customer #, B = name, C = country
        if "Customer Master Data" in names:
            with wb.get_sheet(names["Customer Master Data"]) as sh:
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    cid = v.get(0)
                    if cid not in (None, "", "Custmer #"):
                        cust.setdefault(canon(cid), (v.get(1), v.get(2)))

    return {"e2e": e2e, "pv": pv, "mv": mv, "cust": cust}


def detect_aprc(lines):
    """FIRE transactions price in USD (APRC 530-535); EL in EUR (525). Decide from
    the pricing-group mix, the same signal the analyst reads off the BOM."""
    fire = sum(1 for l in lines if str(l["group"] or "").strip().lower() in FIRE_GROUPS)
    el = len(lines) - fire
    return "530-535" if fire > el else "525"


# ─── the pricing rule ────────────────────────────────────────────────────────
def _rpi_target(w, y, qty, py_ctry_qty, py_cust_qty, rate):
    """Unit net price that lands this line exactly on the RPI floor, solved from
    the model's own AB/AD/AE/AF chain. Returns (price, mode) or (None, reason).

    Both averages present (mix variance is a constant offset, so this is exact):
        AD  = (QTY - QFC) * (W - Y),  QFC = (PYcustQTY / PYctryQTY) * QTY
        AE  = (S - W)*QTY + AD  and  AE = rate*QTY*S/(1+rate)
        =>  S* = (W*QTY - AD) / ((1 - rate/(1+rate)) * QTY)
    Country average only (the model's W term errors to 0):
        AE  = (S - Y)*QTY  =>  S* = Y * (1 + rate)
    """
    if py_ctry_qty and qty and (qty / py_ctry_qty) > FIVEX:
        return None, "5x qty - the model forces RPI to 0"
    if not y:
        # No country reference: Mix Variance is "" so Total RPI reads 0 and no
        # price can move it. Nothing to chase (procedure step 3d).
        return None, ("customer avg only - model reads RPI 0" if w else None)
    if not w:
        return y * (1 + rate), "country avg x (1 + rate)"
    qfc = ((py_cust_qty / py_ctry_qty) * qty) if (py_cust_qty and py_ctry_qty) else 0.0
    ad = (qty - qfc) * (w - y)
    denom = (1 - rate / (1 + rate)) * qty
    if abs(denom) < EPS:
        return None, "cannot solve RPI (zero quantity)"
    return (w * qty - ad) / denom, "solved for the mix-variance offset"


def _rpi_pct(s, w, y, qty, py_ctry_qty, py_cust_qty):
    """Total RPI% at unit net price `s`, exactly as ledger column AF computes it."""
    if not y and not w:
        return None
    if py_ctry_qty and qty and (qty / py_ctry_qty) > FIVEX:
        return 0.0
    ab = (s - w) * qty if w else 0.0
    if w and y:
        qfc = ((py_cust_qty / py_ctry_qty) * qty) if (py_cust_qty and py_ctry_qty) else 0.0
        ad = (qty - qfc) * (w - y)
    elif y:
        ad = (s - y) * qty
    else:
        return 0.0                      # W only → AD errors → AE 0 → AF 0
    ae = ab + ad
    total = s * qty
    return (ae / (total - ae)) if abs(total - ae) > EPS else None


def price_lines(lines, ref, meta):
    """Apply the rule to every line. Returns (priced, summary)."""
    half = meta["half"]
    rate = RPI_RATE[half]
    fx = float(meta.get("fx") or 1.12522)
    usd = meta.get("aprc") != "525"
    customer = canon(meta.get("customer"))
    ledger = canon(meta.get("ledger") or "R2321")

    out = []
    for ln in lines:
        mat = ln["material"]
        qty = ln["qty"] or 0.0
        listp = ln["list"]
        std = ln["std_disc"]
        unit_std = listp * (1 - std) if listp is not None else None
        total_std = unit_std * qty if unit_std is not None else None
        cost = ln["cost"]
        total_cost = cost * qty if cost is not None else None

        # Requested discount — the ledger reads the BOM's Requested Discount %,
        # and the procedure's step 5d recomputes it from the requested price.
        # Prefer the price (it is what the customer actually asked for).
        req_disc = None
        if ln["requested"] is not None and unit_std:
            req_disc = 1 - ln["requested"] / unit_std
        elif ln["req_disc_pct"] is not None:
            req_disc = ln["req_disc_pct"] / 100

        # E2E target and the discount that lands the line on it (ledger M and N).
        tgt_e2e = ref["e2e"].get(str(ln["group"] or "").strip().lower())
        net_at_tgt = (total_cost / (1 - tgt_e2e)) if (total_cost is not None and tgt_e2e not in (None, 1)) else None
        disc_at_tgt = (1 - net_at_tgt / total_std) if (net_at_tgt is not None and total_std) else None

        flags = []

        # ── THE DECISION: MIN(requested, @target E2E, 20%) ───────────────────
        candidates = [c for c in (req_disc, disc_at_tgt, ADD_DISC_CAP) if c is not None]
        add_disc = min(candidates) if candidates else 0.0
        if add_disc < 0:
            # Target E2E is a FLOOR: when cost outruns the standard price the
            # discount goes negative and the line is priced ABOVE standard. That
            # is the model's own behaviour, so it is kept — and surfaced.
            flags.append(("verify", f"priced {-add_disc:.1%} ABOVE the standard price to "
                                    f"hold the target E2E - confirm with the customer"))
        binds = ("requested" if req_disc is not None and abs(add_disc - req_disc) < EPS else
                 "target E2E" if disc_at_tgt is not None and abs(add_disc - disc_at_tgt) < EPS else
                 "20% cap" if abs(add_disc - ADD_DISC_CAP) < EPS else "floor 0%")

        unit_net = unit_std * (1 - add_disc) if unit_std is not None else ln["requested"]

        # ── the RPI floor ────────────────────────────────────────────────────
        # Keys are CONCATENATE(customer|ledger, material). With a blank prefix the
        # key degenerates to the bare material and could collide with a real row,
        # so no prefix means no lookup — same as the model showing blanks.
        cust_avg, cust_qty = ref["pv"].get(customer + mat, (None, None)) if customer else (None, None)
        ctry_avg, ctry_qty = ref["mv"].get(ledger + mat, (None, None)) if ledger else (None, None)
        if not usd:                                  # ledger divides by FX in EUR mode
            cust_avg = cust_avg / fx if cust_avg else cust_avg
            ctry_avg = ctry_avg / fx if ctry_avg else ctry_avg

        rpi_before = _rpi_pct(unit_net, cust_avg, ctry_avg, qty, ctry_qty, cust_qty) if unit_net else None
        rpi_floor, rpi_mode = _rpi_target(cust_avg, ctry_avg, qty, ctry_qty, cust_qty, rate)
        raised = False
        if rpi_floor is not None and unit_net is not None and rpi_floor > unit_net + 1e-6:
            unit_net = rpi_floor
            add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
            binds = f"RPI {half} floor"
            raised = True

        rpi_after = _rpi_pct(unit_net, cust_avg, ctry_avg, qty, ctry_qty, cust_qty) if unit_net else None
        total_net = unit_net * qty if unit_net is not None else None
        e2e = (1 - total_cost / total_net) if (total_cost is not None and total_net) else None

        # ── flags: what a human should still look at ─────────────────────────
        if listp is None:
            flags.append(("action", "no list price on the transaction - cannot price"))
        if tgt_e2e is None and ln["group"]:
            flags.append(("verify", f"pricing group '{ln['group']}' is not in E2E Guidelines"))
        if raised:
            flags.append(("info", f"raised to the {half} RPI floor ({rpi_mode})"))
        if rpi_mode and rpi_floor is None and (cust_avg or ctry_avg):
            flags.append(("info", rpi_mode))
        if cust_avg and not ctry_avg:
            flags.append(("verify", "customer average only - no ledger reference, RPI reads 0"))
        if not cust_avg and not ctry_avg:
            flags.append(("verify", "no prior-year reference - new item, negotiation room "
                                    "(the analyst usually caps these near 20%)"))
        if e2e is not None and tgt_e2e and e2e < tgt_e2e - 1e-6:
            flags.append(("action", f"below target E2E ({e2e:.0%} < {tgt_e2e:.0%})"))
        if req_disc is not None and req_disc > ADD_DISC_CAP + EPS:
            flags.append(("info", f"requested {req_disc:.1%} flattened to the {ADD_DISC_CAP:.0%} cap"))

        sev = ("action" if any(f[0] == "action" for f in flags) else
               "verify" if any(f[0] == "verify" for f in flags) else
               "info" if flags else "ok")

        out.append({
            "material": mat, "description": ln["description"], "group": ln["group"],
            "qty": qty, "list": listp, "std_disc": std, "unit_std": unit_std,
            "total_std": total_std, "cost": cost, "total_cost": total_cost,
            "target_e2e": tgt_e2e, "net_at_target": net_at_tgt, "disc_at_target": disc_at_tgt,
            "requested": ln["requested"], "req_disc": req_disc,
            "cust_avg": cust_avg, "cust_qty": cust_qty,
            "ctry_avg": ctry_avg, "ctry_qty": ctry_qty,
            "rpi_floor": rpi_floor, "rpi_before": rpi_before, "rpi_after": rpi_after,
            "add_disc": add_disc, "unit_net": unit_net, "total_net": total_net,
            "e2e": e2e, "binds": binds, "raised": raised, "severity": sev,
            "flags": "; ".join(t for _, t in flags),
        })

    grand = sum(l["total_net"] or 0 for l in out)
    cost_tot = sum(l["total_cost"] or 0 for l in out)
    std_tot = sum(l["total_std"] or 0 for l in out)
    # Two RPI readings, because the model shows two and they are not the same:
    #   ledger K6 "Overall RPI" = AG11/(T11-AG11) — PRICE variance only, so it
    #     reads 0 when no line has a customer prior-year average;
    #   "Total RPI" = AE-based, price + mix variance — the number the procedure's
    #     6% gate is quoted against.
    ag = ae = 0.0
    for l in out:
        if not l["qty"] or l["unit_net"] is None:
            continue
        if l["ctry_qty"] and (l["qty"] / l["ctry_qty"]) > FIVEX:
            continue                                   # 5x: the model zeroes both
        if l["cust_avg"]:
            pv_ = (l["unit_net"] - l["cust_avg"]) * l["qty"]
            ag += pv_
            qfc = ((l["cust_qty"] / l["ctry_qty"]) * l["qty"]
                   if (l["cust_qty"] and l["ctry_qty"]) else 0.0)
            ae += pv_ + ((l["qty"] - qfc) * (l["cust_avg"] - l["ctry_avg"])
                         if l["ctry_avg"] else 0.0)
        elif l["ctry_avg"]:
            ae += (l["unit_net"] - l["ctry_avg"]) * l["qty"]
    summary = {
        "lines": len(out),
        "grand_total": round(grand, 2),
        "total_standard": round(std_tot, 2),
        "overall_add_disc": round(1 - grand / std_tot, 4) if std_tot else None,
        "overall_e2e": round(1 - cost_tot / grand, 4) if grand else None,
        "overall_rpi": round(ag / (grand - ag), 4) if abs(grand - ag) > EPS else None,
        "total_rpi": round(ae / (grand - ae), 4) if abs(grand - ae) > EPS else None,
        "raised": sum(1 for l in out if l["raised"]),
        "action": sum(1 for l in out if l["severity"] == "action"),
        "verify": sum(1 for l in out if l["severity"] == "verify"),
        "no_py": sum(1 for l in out if not l["cust_avg"] and not l["ctry_avg"]),
        "currency": "EUR" if meta.get("aprc") == "525" else "USD",
    }
    return out, summary


# ─── building the case folder (needs Excel) ──────────────────────────────────
def _excel():
    try:
        import win32com.client as w
    except ImportError:
        raise RuntimeError(
            "pywin32 is not installed, so the Working File cannot be written. "
            "Run:  pip install pywin32")
    try:
        app = w.Dispatch("Excel.Application")
    except Exception as e:
        raise RuntimeError(f"Excel could not be started ({e}). The Working File is the "
                           f"master model itself, so Excel is required to produce it.")
    app.Visible = False
    app.DisplayAlerts = False
    app.ScreenUpdating = False
    app.AskToUpdateLinks = False
    return app


def _com_value(v):
    """COM chokes on numpy/None mixes; hand it plain str/float/empty."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return float(v)
    return str(v)


def build_case(bom_path, priced, summary, meta, log):
    """Copy the master, fill it with this transaction, write the case folder."""
    root = meta["cases_root"]
    folder_name = safe_name(f"{meta['transaction']} - {meta['project']}"
                            if meta.get("transaction") and meta.get("project")
                            else (meta.get("transaction") or meta.get("project") or "case"))
    case_dir = os.path.join(root, folder_name)
    os.makedirs(case_dir, exist_ok=True)
    log(f"Case folder: {case_dir}")

    # 1 ── the transaction, exactly as dropped. The uploader stages it behind a
    # timestamp so two drops of the same export cannot collide; the case folder
    # gets the name CPQ gave it.
    staged = os.path.basename(str(bom_path))
    bom_copy = os.path.join(case_dir, re.sub(r"^\d{10,}__", "", staged))
    if os.path.abspath(bom_copy) != os.path.abspath(str(bom_path)):
        shutil.copy2(str(bom_path), bom_copy)
    log(f"Saved the transaction: {os.path.basename(bom_copy)}")

    tag = meta.get("transaction") or safe_name(meta.get("project") or "case", 40)
    work_path = os.path.join(case_dir, f"Working File ({safe_name(tag, 60)}).xlsb")
    fb_path = os.path.join(case_dir, f"Approved Offer - Approved ({safe_name(tag, 60)}).xlsx")

    # 2 ── the Working File: the master model, filled and toggled
    shutil.copy2(meta["master"], work_path)
    log("Copied the master model → Working File")

    app = _excel()
    wb = None
    try:
        wb = app.Workbooks.Open(os.path.abspath(work_path), UpdateLinks=0)
        _fill_working(wb, priced, meta, log)

        ledger = wb.Worksheets(LEDGER_SHEET)
        app.CalculateFullRebuild()
        t11 = num(ledger.Range("T11").Value) or 0.0
        k6 = num(ledger.Range("K6").Value)
        k7 = num(ledger.Range("K7").Value)
        log(f"Ledger recalculated — total net {t11:,.2f}, "
            f"overall RPI {('%.2f%%' % (k6 * 100)) if k6 is not None else 'n/a'}, "
            f"overall E2E {('%.2f%%' % (k7 * 100)) if k7 is not None else 'n/a'}")

        # 3 ── the three-way total check (procedure, PART 3)
        fb = wb.Worksheets("Feedback")
        fb_total = num(fb.Range("L10").Value) or 0.0
        checks = {"ledger_T11": round(t11, 2),
                  "feedback_L10": round(fb_total, 2),
                  "python": summary["grand_total"]}
        spread = max(checks.values()) - min(checks.values())
        checks["agree"] = spread < 0.05
        if checks["agree"]:
            log(f"Three-way total check PASSED — {t11:,.2f} on all three.")
        else:
            log(f"Three-way total check FAILED — ledger {t11:,.2f}, feedback "
                f"{fb_total:,.2f}, engine {summary['grand_total']:,.2f}.", "warn")

        wb.Save()
        log(f"Saved {os.path.basename(work_path)}")

        # 4 ── the Feedback file: the Feedback sheet, values only
        _export_feedback(app, wb, fb_path, log)
    finally:
        try:
            if wb is not None:
                wb.Close(SaveChanges=False)
        except Exception:
            pass
        try:
            app.Quit()
        except Exception:
            pass

    return {"case_dir": case_dir, "bom": bom_copy, "working": work_path,
            "feedback": fb_path, "checks": checks}


def _fill_working(wb, priced, meta, log):
    """Paste the transaction, set the header, toggle APRC, and write the decision.

    Source columns (SAP, qty, list, std disc, cost, requested + add. discount) are
    written as VALUES row by row — that is the procedure's own fix for the
    duplicate-material trap, where the ledger's XLOOKUPs give every repeat of a
    material the FIRST row's quantity. Every derived column is left as a live
    formula so the file still shows its work."""
    paste = wb.Worksheets("Paste BOM Here")
    paste.Cells.ClearContents()
    rows = meta["_bom_rows"]
    header = meta["_bom_header"]
    width = max(len(header), max((len(r) for r in rows), default=0), 40)

    block = [[_com_value(header[i] if i < len(header) else None) for i in range(width)]]
    for r in rows:
        block.append([_com_value(r[i] if i < len(r) else None) for i in range(width)])
    paste.Range(paste.Cells(1, 1), paste.Cells(len(block), width)).Value = block
    log(f"Pasted the transaction into 'Paste BOM Here' ({len(rows)} rows)")

    led = wb.Worksheets(LEDGER_SHEET)
    led.Range("C5").Value = _com_value(num(meta.get("customer")) or meta.get("customer"))
    led.Range("D5").Value = _com_value(meta.get("ledger") or "R2321")
    led.Range("C8").Value = _com_value(meta.get("project"))
    led.Range("C9").Value = _com_value(meta.get("transaction"))
    led.Range("C10").Value = _com_value(meta.get("crm"))
    # C6/C7 are VLOOKUPs off C5. When the customer is not in Customer Master Data
    # they come back blank, so fall back to what the user typed.
    wb.Application.CalculateFullRebuild()
    if not str(led.Range("C6").Value or "").strip() and meta.get("customer_name"):
        led.Range("C6").Value = _com_value(meta["customer_name"])
        log("Customer not in Customer Master Data — wrote the name you entered.", "warn")
    if not str(led.Range("C7").Value or "").strip() and meta.get("country"):
        led.Range("C7").Value = _com_value(meta["country"])
        log("Country not resolved from the master — wrote the country you entered.", "warn")

    # APRC drives the currency: P5 = IF(P6=525,"EUR","USD"). Never touch P5.
    aprc = meta.get("aprc") or "525"
    led.Range("P6").Value = 525.0 if str(aprc) == "525" else "530-535"
    log(f"APRC set to {aprc} → {'EUR' if str(aprc) == '525' else 'USD'}")

    # Per-row values over the XLOOKUP columns + the decision in Q and R.
    n = len(priced)
    b = [[_com_value(l["material"])] for l in priced]
    h = [[_com_value(l["qty"])] for l in priced]
    i_ = [[_com_value(l["list"])] for l in priced]
    j = [[_com_value(l["std_disc"])] for l in priced]
    u = [[_com_value(l["cost"])] for l in priced]
    q = [[_com_value(l["req_disc"])] for l in priced]
    r = [[_com_value(l["add_disc"])] for l in priced]
    last = FIRST_ROW + n - 1
    led.Range(f"B{FIRST_ROW}:B{last}").Value = b
    led.Range(f"H{FIRST_ROW}:H{last}").Value = h
    led.Range(f"I{FIRST_ROW}:I{last}").Value = i_
    led.Range(f"J{FIRST_ROW}:J{last}").Value = j
    led.Range(f"U{FIRST_ROW}:U{last}").Value = u
    led.Range(f"Q{FIRST_ROW}:Q{last}").Value = q
    led.Range(f"R{FIRST_ROW}:R{last}").Value = r
    log(f"Wrote {n} lines: SAP/QTY/List/STD/Cost as values (kills the duplicate-material "
        f"trap), Requested + Add. Discount as the decision")

    # Highlight every line an approver has to look at, in the ledger itself.
    for idx, l in enumerate(priced):
        if l["severity"] in ("action", "verify"):
            colour = 0xB0B6F4 if l["severity"] == "action" else 0x8AE0FF   # BGR
            led.Range(f"B{FIRST_ROW + idx}:R{FIRST_ROW + idx}").Interior.Color = colour
    flagged = sum(1 for l in priced if l["severity"] in ("action", "verify"))
    if flagged:
        log(f"Highlighted {flagged} line(s) that need a human decision")


def _export_feedback(app, wb, out_path, log):
    """Copy the Feedback sheet to its own workbook and paste values over it —
    the procedure's manual output step (both model macros are broken in V2)."""
    fb = wb.Worksheets("Feedback")
    fb.Copy()                                    # → a new single-sheet workbook
    new = app.ActiveWorkbook
    ws = new.Worksheets(1)
    used = ws.UsedRange
    used.Copy()
    ws.Range(used.Address).PasteSpecial(Paste=-4163)   # xlPasteValues
    app.CutCopyMode = False
    ws.Range("A1").Select()
    if os.path.exists(out_path):
        os.remove(out_path)
    new.SaveAs(os.path.abspath(out_path), FileFormat=51)   # xlOpenXMLWorkbook
    new.Close(SaveChanges=False)
    log(f"Saved {os.path.basename(out_path)} (values only, logo and terms kept)")


# ─── CLI ─────────────────────────────────────────────────────────────────────
def resolve_meta(job, lines, bom_path, ref):
    meta = dict(job)
    meta["half"] = job.get("half") if job.get("half") in ("H1", "H2") else guess_half(bom_path)
    aprc = str(job.get("aprc") or "auto")
    meta["aprc"] = aprc if aprc in ("525", "530-535") else detect_aprc(lines)
    meta["ledger"] = job.get("ledger") or "R2321"
    # Fill the customer name / country from the master when the user left them blank.
    hit = ref["cust"].get(canon(job.get("customer")))
    if hit:
        meta.setdefault("customer_name", None)
        meta["customer_name"] = meta.get("customer_name") or hit[0]
        meta["country"] = meta.get("country") or hit[1]
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    # The log carries arrows and currency signs; a cp1252 console must not be
    # able to kill a run that has already copied files.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    with open(args.job, "r", encoding="utf-8") as fh:
        job = json.load(fh)

    log_lines = []

    def log(msg, kind="info"):
        log_lines.append({"kind": kind, "msg": msg})
        print(f"[{kind}] {msg}", flush=True)

    result = {"ok": False}
    try:
        master = job.get("master")
        if not master or not os.path.exists(master):
            raise RuntimeError(
                "The master CPQ model was not found. Set it in Settings → LSD Pricing "
                "(it is the 'CPQ Pricing Model LSD ... V2' .xlsb).")
        bom = job.get("bom")
        if not bom or not os.path.exists(bom):
            raise RuntimeError("The transaction file was not found.")

        lines, header, rows = read_bom(bom)
        if len(lines) > MAX_LINES:
            raise RuntimeError(f"{len(lines)} lines — the model's ledger only carries "
                               f"{MAX_LINES}. Split the transaction.")
        log(f"Read {len(lines)} line(s) from {os.path.basename(bom)}")

        ref = load_reference(master)
        log(f"Reference loaded: {len(ref['e2e'])} E2E targets, {len(ref['pv'])} customer "
            f"prior-year rows, {len(ref['mv'])} ledger prior-year rows")

        meta = resolve_meta(job, lines, bom, ref)
        log(f"Half-year {meta['half']} (RPI floor {RPI_RATE[meta['half']]:.1%}) · "
            f"APRC {meta['aprc']} · ledger {meta['ledger']}")

        # This master's MV Ledger 2025 carries R2321 (UAE) only, so a customer
        # outside the UAE gets the UAE ledger as its "country" prior-year base.
        # The analyst's model has the same limitation — say so rather than hide it.
        ctry = str(meta.get("country") or "").strip().lower()
        if ctry and ctry not in ("uae", "united arab emirates") and meta["ledger"] == "R2321":
            log(f"Country is {meta['country']} but the only ledger in this master is R2321 "
                f"(UAE) — prior-year country averages come from the UAE ledger.", "warn")

        priced, summary = price_lines(lines, ref, meta)
        log(f"Priced {summary['lines']} line(s) — total {summary['grand_total']:,.2f} "
            f"{summary['currency']}")
        if summary["overall_e2e"] is not None:
            log(f"Overall E2E {summary['overall_e2e']:.1%} · overall RPI "
                f"{summary['overall_rpi']:.1%}" if summary["overall_rpi"] is not None
                else f"Overall E2E {summary['overall_e2e']:.1%}")
        if summary["raised"]:
            log(f"{summary['raised']} line(s) pulled up to the {meta['half']} RPI floor")
        if summary["action"] or summary["verify"]:
            log(f"{summary['action']} line(s) need a decision, {summary['verify']} need a "
                f"reference check", "warn")
        else:
            log("No line needs a human decision.", "ok")

        result = {"ok": True, "mode": job.get("mode", "preview"), "lines": priced,
                  "summary": summary,
                  "meta": {k: v for k, v in meta.items() if not k.startswith("_")}}

        if job.get("mode") == "build":
            if not job.get("cases_root"):
                raise RuntimeError("No case folder root configured.")
            meta["_bom_header"] = header
            meta["_bom_rows"] = rows
            built = build_case(bom, priced, summary, meta, log)
            result.update(built)
            log("Done.", "ok")
    except Exception as e:
        log(str(e), "error")
        result = {"ok": False, "error": str(e), **({"lines": []} if True else {})}
    finally:
        result["log"] = log_lines
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, default=str)

    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
