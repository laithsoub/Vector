"""
lsd_pricing.py — LSD CPQ pricing: transaction in, feedback + working file out.
=============================================================================
Drop a CPQ "Export Line Items" transaction; get back a case folder holding

    <W-number> - <project>/
        <the transaction as dropped>              (untouched)
        Approved Offer - Approved (<W>).xlsx      the Feedback sheet, values only
        Working File (<W>).xlsb                   the master model, filled + toggled
        Working File (<W>) - as pasted.xlsb       the first draft: ONLY pasted

The Working File is the real master CPQ model with this transaction pasted into
'Paste BOM Here', the ledger header set, APRC/currency toggled, and the decided
Add. Discount written into column R — every derived column left LIVE, so the file
shows how the feedback was produced rather than just asserting it.

The "as pasted" copy is the same model with the transaction and the header and
NOTHING ELSE: no values over the ledger's formulas, no decided discount. It is the
first draft — the file as it stands one second after the paste — and it is what
tells a model number from an engine number, so it is written on every build.
Pass "baseline": false to skip it (it costs a 7 MB copy and an Excel pass).

THE RULE — "requested" (default, Dalia, 2026-09-02). Holding the target E2E was
pushing prices far above the prior year: on W262217374E chasing 40% E2E took the
overall and total RPI to 17%. The target E2E is therefore NOT priced to; the
customer's own request is:

    Add. Discount = Requested Discount            (the 20% cap does not apply)
    then, if the line still prices under the RPI gate for the half-year
    (H1 3.5% / H2 6%),  unit net = customer prior-year average x (1 + rate)
                        (country average when the customer has no history)

THE TARGET E2E IS A FLOOR AGAIN (Dalia + Laith, 2026-09-08, on W262223256E).
The uncapped requested rule priced EFM-APS100 at 80.00 against a 79.63 cost —
"we cannot release any item with the cost price" — and two Addressable lines at
29% / 19% where "E2E for Addressable should be at least 35%-37%". So after the
RPI gate the line is lifted again:

    unit net = MAX( unit net , total cost / (1 - target E2E) / qty )

skipped when the line has a real PY CUSTOMER AVERAGE ("except if we have any
customer reference last year" — a country average does NOT excuse it), and
skipped on a carried revision line. The engine lands ON the target, never in the
35-37% band: that band is a CONCESSION the approver grants, so every floored line
carries `e2e_band` with what 37% and 35% would be and the approval mail offers it
— but only where those rungs are actually under that line's target. They are the
ADDRESSABLE band (target 40%); against Notification-UL's 35% there is no band.
A line that still lands below its target — carried, or held down by a customer
reference — is PRICED THAT WAY and flagged for approval, not raised to hide it.

THE APPROVER'S REWORK — "rpi_target" (Kiran on W262232081E, 2026-09-17). An
approver who has seen the summary sends the case back against a number: "rework
to maintain margins above 43% and RPI 4-5%". Pass his ceiling as `rpi_target`
and the case is re-priced to land on it — see `_rework_prices` for the shape and
why the obvious solve is wrong. In short: the lines the customer HAS a price
history for go to last year + the case rate and nothing more, the lines he has
none for carry the move, and the target-E2E floor still holds every one of them,
so the margin never pays for the RPI. `rpi_basis` says WHICH of the working
file's three RPI readings the ceiling is on (`_rpi_readings`); the default is the
one the approval mail prints, because that is the only one the approver was sent.
A case already inside the ceiling is left exactly as the rule priced it.

THE OLD RULE — "e2e" (LSD Daily Work Procedure, 2026-08-05; pass rule="e2e" in
the job to get it back). Measured on 165 case models / 2148 priced lines, it
reproduced the analyst's own number on 42% of lines and 58% of lines with no
prior-year history:

    Add. Discount = MIN( Requested Discount , Add. Discount @Target E2E , 20% )

then every line that has a country prior-year reference is pulled up to the RPI
floor, solved algebraically (see _rpi_target). Target E2E is a FLOOR, not a value
to match — comfortable lines are left alone. Neither rule rounds the result
(rounding was measured and it makes the match worse).

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

CUSTOMER EXCEPTIONS. Some customers are not priced on the half-year RPI rate at
all — see RPI_EXCEPTIONS. They are not one-offs; the same handful of big stock
customers come up every year, on an agreed fixed price with a negotiated
increase, so the rate is a dated standing rule rather than a manual override. The
floor mechanism is unchanged (prior-year average x (1 + rate)); only the rate
moves, and a case priced on one says so in its headline and its log.

LIST PRICE, in order (the source is carried out on the line as `list_src`). The
MODEL'S OWN BOOK WINS over the transaction — Dalia, 2026-09-08: "LP not updated on
working file, as discussed it should be updated manually as per latest LSD pricing
model." CPQ quotes off whatever price book its session loaded, which is routinely
the previous cut. A hard ZERO off CPQ is its price book failing to load, not a
free line, and is treated as a blank — Dalia's decision, 2026-09-07:
    1 'EL Trigger 26' / 'Fire Trigger 26' by material          — the LATEST list
    2 the transaction's own List Price      — only when the material is on no book
    3 an IDENTICAL Trigger entry, same description + same cost — a discontinued
      material reaching the price of whatever replaced it; its own row carries
      #VALUE! in the list column
    4 'Guidance' by country&material (column H)                — the PREVIOUS list
The ledger is list-based end to end (K = I * (1 - J)), so a blank list is not
cosmetic: N and P go #DIV/0!, S and T go 0, and the line puts its whole cost
against zero revenue. Two such lines took W262219747E to 13.85% overall E2E.

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
     "ledger": "R2321", "half": "H1"|"H2"|"auto", "aprc": "525"|"530-535"|"auto",
     "rule": "requested" (default) | "e2e",
     "rpi_target": 0.045,            rework the case to an approver's RPI ceiling
     "rpi_basis": "pivot" (default) | "ledger" | "price",   which reading that is
     "typo_keep": ["1100-0532"],     suspected-typo lines the analyst confirmed as real
     "baseline": false               skip the "as pasted" copy (default: write it)}

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
# Dalia's KPI is the 6% as an AVERAGE over all her cases, and Kiran's flat / 4%
# exceptions pull it down — so a normal case is worked to ~6.8% (2026-09-15).
# Shown against the case RPI as headroom; the gate itself stays at RPI_RATE.
RPI_WORKING_LEVEL = 0.068
ADD_DISC_CAP = 0.20                    # the 20% flatten in the MIN shortcut

# ─── customers the half-year rate does not apply to ──────────────────────────
# Not an exception in the sense of a one-off: it happens every year with the big
# stock customers, so it is a standing rule with a date on it (Laith, 2026-09-07).
#
# Khaled Al Saigh and the two KYR entities are FIRE stock customers — very few
# projects, and only strategic ones around 500k. They hold an agreed FIXED price
# for the whole year, so the price to quote is last year's price, not the book's.
# That is exactly what the RPI floor already does (prior-year average x 1+rate);
# only the rate is different. From September the increase under negotiation is
# 2.5%, NOT the 6% H2 rate, because the delivery invoices in January — and the
# 2.5% itself still has to be approved.
#
# Matched on customer number first (the master's own Customer Master Data) and on
# the name only as a fallback, because a stock order can come through under a
# ship-to whose number is not one of these three.
RPI_EXCEPTIONS = (
    {
        "label": "Khaled Al Saigh / KYR",
        "customers": {"1213394", "586252", "1270464"},
        "names": ("al saigh", "al sayegh", "kyr"),
        "from_month": 9,                 # September onwards, in the quote's own year
        "rate": 0.025,
        "why": ("agreed fixed price for the year and the delivery invoices in "
                "January, so the increase negotiated from September is 2.5%, "
                "not the H2 6%"),
        # The agreed prices themselves — see load_customer_book. The file is the
        # analyst's own order summary, kept out of the repo with the rest of
        # data/; drop a newer cut in beside it and the newest wins.
        "book": "KYR order*.xlsx",
    },
)

# Where a customer fixed-price book is looked for: `<masterdir>/books/`, then
# `<masterdir>/`. A job can name one outright with `customer_book`.
BOOK_DIRS = ("books", "")

# The band Dalia will come down to when the target E2E cannot be held, quoted by
# her on W262223256E: "E2E for Addressable should be at least 35%-37%". It is a
# CONCESSION the approver grants, not a price the engine picks — every line is
# priced at its group target and the band rides along for the ask.
#
# These are ABSOLUTE rungs, and she named them for ADDRESSABLE, whose target is
# 40%. They are not a shape to rescale onto another group: Notification-UL's
# target is 35%, so "concede to 37%, then 35%" is not a concession there — it is
# at or above the target. Nothing here invents a Notification-UL band, because
# she has never quoted one; a rung is only ever offered against a target it
# genuinely sits below, per line (`e2e_band`) and for the quote as a whole.
E2E_CONCESSION = (0.37, 0.35)

FIVEX = 4.9999                         # model gate: QTY/PYctryQTY <= 499.99%
# Proposed 2026-10-01 (Laith on W262253147E, Qatar): a line the customer has
# never bought, measured only against the REGIONAL ledger (R2321 is the whole
# Middle East sold-to ledger, not one country) and quoted at over 5x last year's
# regional qty, reads RPI 0 in the model whatever it is priced at — so the RPI
# floor there buys no KPI, only price, off somebody else's (often another
# country's) last-year price. When on, such a line skips the RPI floor and is
# priced by the target E2E floor instead. OFF until the rule table approves it.
#
# And even when on, ONLY ONCE THE ORDER IS CONFIRMED (Laith, same case, same day):
# the customer can cut the quantity at any moment, and a line priced without the
# RPI that drops back under 5x is then read at full RPI on a price that never had
# it. Until the job says `order_confirmed`, the 6% stays on and the line is
# flagged provisional - conceding it later is easy, adding it back is not.
FIVEX_COUNTRY_NO_GATE = False
STD_DISCOUNT = 0.55                    # default customer condition when the BOM omits it
EPS = 1e-9

# How close a requested price has to sit to an approved one to BE that price.
# Sales re-send the approved figure rounded to the digits CPQ carries, so an
# exact compare would call 2.246037404 a different price from 2.2460374043.
# A relative tolerance, because the prices span 2.24 to 2,943.
REVISION_MATCH_TOL = 0.0001            # 0.01% of the approved price

# A requested price sales could not have meant. W262247243E (Heptagon, 2026-09-29)
# asked 1,500.00 for 1100-0532 against a ~258 standard price — a slipped digit —
# and the requested rule priced it there: one line at 830% Total RPI dragged the
# whole case, and Dalia sent it back ("one line have very high price maybe this by
# mistake from Sales person, we cannot approve such high price"). So a request
# over TYPO_REQ_RATIO x the standard price is NOT copied: the line is priced as if
# nothing was requested (target E2E, then the RPI gate — the agreed balance) and
# the case stops to ask the analyst. `typo_keep` on the job names the lines they
# have confirmed are real, which are then priced as requested.
# TYPO_LINE_RPI catches the same slip arriving another way (a qty or a reference):
# any line whose own Total RPI% is over it is flagged and asked about too.
TYPO_REQ_RATIO = 2.0
TYPO_LINE_RPI = 1.0


# ─── the rule table ──────────────────────────────────────────────────────────
# The constants above are the engine's DEFAULTS. The rules in force live in
# Vector's rule table (server.ts, `rule`), where every one carries who set it,
# where it came from and the dates it holds for, and a change waits in an
# approval queue before it prices anything. The server seeds the table from
# `code_rules()` once, then sends the approved rows with every job; `apply_rules`
# lays the ones valid on the TRANSACTION's date over the defaults. A job with no
# `rules` (the CLI, a ship build without the table) prices on the defaults.
#
# A key is one knob. `rpi_exception.<slug>` is the one family: the set of those
# in force REPLACES RPI_EXCEPTIONS outright, so retiring the last one leaves no
# exception rather than falling back to the code's.
RULE_KEYS = {
    "rpi_rate.H1":       "number",
    "rpi_rate.H2":       "number",
    "rpi_working_level": "number",
    "add_disc_cap":      "number",
    "std_discount":      "number",
    "e2e_concession":    "numbers",
    "revision_match_tol": "number",
    "fivex_country_no_gate": "flag",
}
RULE_FAMILY_EXC = "rpi_exception."
# A working instruction in words — mined from Dalia's and Kiran's mail, or typed.
# The engine does not price by it; it sits in the table so an approved guideline
# is written down with its source, and a number in it can later become a key.
RULE_FAMILY_NOTE = "guideline."


def code_rules():
    """The defaults as rule rows — what the server seeds an empty table with."""
    src = "automation/lsd_pricing.py defaults"
    rows = [
        {"key": "rpi_rate.H1", "value": RPI_RATE["H1"], "title": "RPI gate, H1",
         "why": "Unit net floor = customer prior-year average x (1 + rate) for a first-half transaction.",
         "source": f"LSD Daily Work Procedure ({src})"},
        {"key": "rpi_rate.H2", "value": RPI_RATE["H2"], "title": "RPI gate, H2",
         "why": "Unit net floor = customer prior-year average x (1 + rate) for a second-half transaction.",
         "source": f"LSD Daily Work Procedure ({src})"},
        {"key": "rpi_working_level", "value": RPI_WORKING_LEVEL, "title": "RPI working level",
         "why": "Dalia's KPI is 6% as an average over all cases and the flat/4% exceptions pull it "
                "down, so a normal case is worked to ~6.8%. Shown as headroom; the gate stays at the H1/H2 rate.",
         "source": f"Dalia review 2026-09-15 ({src})"},
        {"key": "add_disc_cap", "value": ADD_DISC_CAP, "title": "Add. Discount cap",
         "why": "The 20% flatten in the old MIN(requested, @target E2E, cap) rule; the requested rule only warns past it.",
         "source": f"E2E Guidelines ({src})"},
        {"key": "std_discount", "value": STD_DISCOUNT, "title": "Default customer condition",
         "why": "Standard discount assumed when the CPQ export omits it.",
         "source": f"CPQ export default ({src})"},
        {"key": "e2e_concession", "value": list(E2E_CONCESSION), "title": "E2E concession band (Addressable)",
         "why": "Where the approver will come down to when the target E2E cannot be held — a concession "
                "offered in the approval mail, never a price the engine picks.",
         "source": f"Dalia on W262223256E ({src})"},
        {"key": "revision_match_tol", "value": REVISION_MATCH_TOL,
         "title": "Revision: requested-vs-approved match tolerance",
         "why": "On a revision of an approved quote every line already quoted must come back at the price "
                "that was approved; this is how close counts as the same price (sales re-send the approved "
                "figure rounded to CPQ's digits). A line outside it is flagged for action, never silently "
                "held. An item NEW on the revision is priced by the rule: capped at the customer's own "
                "reference x (1 + RPI rate) when they have one, with no country-average fallback, and the "
                "target E2E overrides that cap.",
         "source": f"Laith 2026-09-28 on W261999073E ({src})"},
    ]
    for exc in RPI_EXCEPTIONS:
        slug = re.sub(r"[^a-z0-9]+", "-", exc["label"].lower()).strip("-")
        rows.append({
            "key": RULE_FAMILY_EXC + slug,
            "value": {"label": exc["label"], "customers": sorted(exc["customers"]),
                      "names": list(exc["names"]), "from_month": exc["from_month"],
                      "rate": exc["rate"], "why": exc["why"], "book": exc.get("book")},
            "title": f"RPI exception: {exc['label']}",
            "why": exc["why"],
            "source": f"Laith 2026-09-07, standing rule ({src})",
        })
    return rows


def check_rule(key, value):
    """Why this value cannot be used for this key, or None. The server calls this
    before a proposal enters the queue, so a bad value never reaches approval."""
    def rate(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v < 1
    if key.startswith(RULE_FAMILY_EXC):
        if not isinstance(value, dict):
            return "an RPI exception is an object"
        if not str(value.get("label") or "").strip():
            return "label is required"
        if not (value.get("customers") or value.get("names")):
            return "name at least one customer number or name"
        if not rate(value.get("rate")):
            return "rate must be a fraction between 0 and 1 (2.5% = 0.025)"
        fm = value.get("from_month", 1)
        if not (isinstance(fm, int) and 1 <= fm <= 12):
            return "from_month must be 1..12"
        return None
    if key.startswith(RULE_FAMILY_NOTE):
        if not (isinstance(value, dict) and str(value.get("text") or "").strip()):
            return "a guideline is an object with its text"
        return None
    kind = RULE_KEYS.get(key)
    if kind is None:
        return f"unknown rule key '{key}'"
    if kind == "flag" and not isinstance(value, bool):
        return "must be true or false"
    if kind == "number" and not rate(value):
        return "must be a fraction between 0 and 1 (6% = 0.06)"
    if kind == "numbers" and not (isinstance(value, list) and value and all(rate(v) for v in value)):
        return "must be a list of fractions between 0 and 1"
    return None


def _in_force(rule, as_of):
    day = as_of.isoformat()
    return ((not rule.get("valid_from") or rule["valid_from"] <= day)
            and (not rule.get("valid_to") or day < rule["valid_to"]))


def apply_rules(rules, as_of, log=None):
    """Lay the approved rules valid on `as_of` over the defaults. Per key the rule
    that started latest wins (a dated rule over an open-ended one), then the
    newest id. Returns the rows applied, for the result's provenance."""
    global RPI_RATE, RPI_WORKING_LEVEL, ADD_DISC_CAP, STD_DISCOUNT, E2E_CONCESSION, RPI_EXCEPTIONS
    global REVISION_MATCH_TOL, FIVEX_COUNTRY_NO_GATE
    best = {}
    for r in rules:
        key = str(r.get("key") or "")
        if not _in_force(r, as_of):
            continue
        bad = check_rule(key, r.get("value"))
        if bad:
            if log:
                log(f"Rule #{r.get('id')} '{key}' ignored: {bad}", "warn")
            continue
        cur = best.get(key)
        rank = (r.get("valid_from") or "", r.get("id") or 0)
        if cur is None or rank > (cur.get("valid_from") or "", cur.get("id") or 0):
            best[key] = r

    val = {k: r["value"] for k, r in best.items()}
    RPI_RATE = {"H1": val.get("rpi_rate.H1", RPI_RATE["H1"]),
                "H2": val.get("rpi_rate.H2", RPI_RATE["H2"])}
    RPI_WORKING_LEVEL = val.get("rpi_working_level", RPI_WORKING_LEVEL)
    ADD_DISC_CAP = val.get("add_disc_cap", ADD_DISC_CAP)
    STD_DISCOUNT = val.get("std_discount", STD_DISCOUNT)
    E2E_CONCESSION = tuple(val.get("e2e_concession", E2E_CONCESSION))
    REVISION_MATCH_TOL = val.get("revision_match_tol", REVISION_MATCH_TOL)
    FIVEX_COUNTRY_NO_GATE = val.get("fivex_country_no_gate", FIVEX_COUNTRY_NO_GATE)
    RPI_EXCEPTIONS = tuple(
        {**r["value"],
         "customers": {canon(c) for c in r["value"].get("customers") or ()},
         "names": tuple(str(n).lower() for n in r["value"].get("names") or ()),
         "from_month": r["value"].get("from_month", 1)}
        for k, r in sorted(best.items()) if k.startswith(RULE_FAMILY_EXC))

    applied = [{"id": r.get("id"), "key": k, "value": r["value"], "title": r.get("title"),
                "source": r.get("source"), "valid_from": r.get("valid_from")}
               for k, r in sorted(best.items())]
    if log:
        log(f"Rules: {len(applied)} in force on {as_of.isoformat()} from Vector's rule table")
    return applied

# Ledger geometry (V2 master). Data rows 13..500 feed Feedback 12..634.
LEDGER_SHEET = "Model Ledger "
# The Approved Offer as the analyst hands it over: the price build-up hidden
# (F List Price → J Add. Discount), leaving SAP/description/group/qty and the
# net price, and column C wide enough to read the customer name off.
FB_HIDE_FROM, FB_HIDE_TO = "F", "J"
FB_FIT_COL, FB_FIT_MAX = "C", 60.0
# Reading a previous revision back out of its Approved Offer. The header row is
# found rather than assumed — see prior_prices — so only how far to look for it.
FB_HEAD_SCAN = 20
# Trimming the offer's empty tail: lines start on row 12, the SAP number is in
# column B, and the table itself ends at M — everything right of that is the
# terms-and-conditions block, which outlives the line items and must survive.
OFFER_FIRST_ROW, OFFER_COL_SAP, OFFER_TABLE_COLS = 12, 2, 13
# QTY is E, Unit Net K, Total Net L; the header total sits on row 10.
OFFER_COL_NET, OFFER_COL_TOTAL, OFFER_TOTAL_ROW = 11, 12, 10
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
    """Excel-ish number coercion. '26.96', 26.96, '33.27%' → float; junk → None.
    Handles European decimals ('76,68' → 76.68) and thousands grouping, deciding
    the decimal mark from which separator is last — a lone comma with 1-2 trailing
    digits is a decimal, otherwise it is a thousands separator."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    pct = s.endswith("%")
    if pct:
        s = s[:-1].strip()
    if "," in s and "." in s:
        s = (s.replace(".", "").replace(",", ".")
             if s.rfind(",") > s.rfind(".") else s.replace(",", ""))
    elif "," in s:
        head, _, tail = s.rpartition(",")
        s = f"{head}.{tail}" if len(tail) in (1, 2) and head.replace("-", "").isdigit() else s.replace(",", "")
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


def guess_date(bom_path):
    """CPQ exports are named <number>_<YYYY-MM-DD>.xlsx — that is the
    transaction's own date. Fall back to today."""
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", os.path.basename(str(bom_path)))
    if m:
        try:
            return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    return _dt.date.today()


def guess_half(bom_path):
    """The half-year the transaction falls in — it decides the RPI rate."""
    return _half_from_date(guess_date(bom_path))


def rpi_exception(meta):
    """The standing exception covering this customer, or None.

    Keyed on the customer number where the job carries one, and on the customer
    name otherwise — 'kyr' as a whole word, so a name that merely contains those
    three letters does not qualify. The date decides too: the September rule does
    not apply to a June transaction being re-run today, which is why this reads
    the transaction's own date and not the clock."""
    exc = customer_group(meta)
    when = meta.get("as_of") or _dt.date.today()
    return exc if (exc and when.month >= exc["from_month"]) else None


def customer_group(meta):
    """The standing-customer entry this transaction belongs to, WITHOUT the date
    test — the entry also names the accounts that are one commercial customer and
    the fixed-price book they share, and neither of those starts in September.
    `rpi_exception` is this plus the date."""
    cust = canon(meta.get("customer"))
    name = re.sub(r"[^a-z0-9 ]+", " ", str(meta.get("customer_name") or "").lower())
    name = re.sub(r"\s+", " ", name).strip()
    for exc in RPI_EXCEPTIONS:
        if (cust and cust in exc["customers"]) or (
                name and any(re.search(rf"\b{re.escape(n)}\b", name) for n in exc["names"])):
            return exc
    return None


# ─── the customer's own fixed-price book ─────────────────────────────────────
# WHY THIS EXISTS. The ledger's `W PY CUSTOMER AVERAGE` comes off 'PV 2025 ' —
# LAST year. A fixed-price customer's agreement runs the CURRENT year, so a
# material they have bought three times this year and never in 2025 shows a BLANK
# W: the engine reads "no customer history", the whole price lands in mix
# variance, and nothing stops a price being quoted UNDER what they have already
# paid. On W262232081E (KYR) 11 of 20 lines were in the book and 6 of them read
# as no-history — `EFGVS11-PLUS` among them, bought on FIVE orders this year at
# 4,376.31 — and reworking the case to an approver's RPI ceiling cut 52,436 USD
# off prices the customer already knew, that one by 62%.
#
# The book is the analyst's own order summary for the customer (Dalia's "KYR
# order - JAN to SEP 2026.xlsx"): a sheet per entity, a block per transaction,
# and SAP No / Description / Pricing Group / QTY / Unit Net Price under each. It
# is the AGREED price, not a statistic, so it outranks the prior-year average.
#
# It is ONE book across every account in the group. KYR quotes under 1270464
# (FZCO) are priced off the 586252 (Egypt) sheet, and reading them as two
# customers is what hid the history in the first place.
def _book_price_rows(ws):
    """(transaction, title, sap, qty, price) for every priced row on a sheet."""
    entity, txn, title = None, None, None
    for row in ws.iter_rows(values_only=True):
        cells = (list(row) + [None] * 5)[:5]
        a, desc, group, qty, price = cells
        if a is None or not str(a).strip():
            continue
        head = str(a).strip()
        if head.lower() == "sap no":
            continue
        # A transaction block opens with its W-number and the project beside it.
        if re.fullmatch(r"W\d{6,}E\d*", head, re.I):
            txn, title = head, str(desc or "").strip()
            continue
        # A lone cell on its own row names the account the block belongs to.
        if all(c is None or str(c).strip() == "" for c in (desc, group, qty, price)):
            entity = head
            continue
        if txn and isinstance(price, (int, float)):
            yield (txn, title, entity, canon(head),
                   qty if isinstance(qty, (int, float)) else 0.0, float(price))


def load_customer_book(path):
    """Read a fixed-price book into {material: {...}}.

    A material bought more than once at more than one price keeps the LATEST it
    was invoiced at — the book is ordered oldest-first, and a renegotiated price
    supersedes rather than averages. `paid` is the whole history, because what
    an approver argues with is "they paid this, N times"."""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    prices, orders, entities = {}, [], []
    try:
        for ws in wb.worksheets:
            for txn, title, entity, mat, qty, price in _book_price_rows(ws):
                if txn not in orders:
                    orders.append(txn)
                if entity and entity not in entities:
                    entities.append(entity)
                rec = prices.setdefault(mat, {"material": mat, "price": None, "paid": []})
                rec["paid"].append({"transaction": txn, "project": title,
                                    "entity": entity, "qty": qty, "price": price})
                rec["price"] = price                      # latest block wins
    finally:
        wb.close()
    for rec in prices.values():
        seen = [p["price"] for p in rec["paid"]]
        rec["orders"] = len(rec["paid"])
        rec["low"] = min(seen)
        rec["high"] = max(seen)
        # A price that never moved is the agreed one and can be quoted as such;
        # one that has moved is a negotiation the analyst has to look at.
        rec["firm"] = (rec["high"] - rec["low"]) <= max(0.01, rec["high"] * 1e-4)
    return {"path": path, "prices": prices, "orders": orders, "entities": entities}


def find_customer_book(meta, exc):
    """The book file for this customer, or None. `customer_book` in the job wins;
    otherwise the group's own glob is resolved against the master's folder."""
    named = str(meta.get("customer_book") or "").strip()
    if named:
        return named if os.path.exists(named) else None
    if not (exc and exc.get("book")):
        return None
    import glob as _glob
    base = os.path.dirname(os.path.abspath(str(meta.get("master") or "")))
    for sub in BOOK_DIRS:
        hits = [p for p in _glob.glob(os.path.join(base, sub, exc["book"]))
                if not os.path.basename(p).startswith("~$")]
        if hits:
            # Newest cut wins, so dropping a fresher export in is the whole update.
            return max(hits, key=os.path.getmtime)
    return None


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
    "identifier": 1, "notes": 54,
}
# A row cpq_fetch appended because CPQ's Approval History asked for it ("Add QTY
# xx of Item xx") - it is not on CPQ's own BOM. The Identifier carries this mark,
# the Notes column the approver's comment. Keep in step with cpq_fetch.py.
APPROVAL_ADD_MARK = "APPROVAL HISTORY ADD"
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
    #
    # THE 55% BELONGS TO THIS COLUMN AND NO OTHER. Measured across the analyst's
    # 208 archived exports, 2790 line rows (2026-09-07): Customer Condition % is
    # 55 on 1800 rows and blank on 903 — every other discount column is empty or
    # zero (Suggested Discount % is 0 or blank on 2721 of them, and nothing reads
    # it). So the default belongs to the STANDARD discount, never to the requested
    # or the suggested one.
    #
    # A hard ZERO here is left ALONE rather than defaulted, unlike a zero List
    # Price. It has never been seen on a real CPQ export — the 15 rows that look
    # like it (W262032328E Maarfie) are blank, and the analyst's own model prices
    # them at 0.55, which is what the blank already does. Defaulting an unseen
    # case would be guessing at a price; it is flagged instead, because taking a
    # real 0 literally moves the BUILD-UP (standard price reads the full list, so
    # the case reports a 55% additional discount that nobody asked for) even
    # though the net price still lands on what the customer requested.
    std_zero = std_pct is not None and abs(std_pct) < EPS
    std = (std_pct / 100) if std_pct is not None else STD_DISCOUNT
    if std > 1:                                  # already-fractional guard
        std = std / 100

    req = num(at("net_fixed"))
    if req is None:
        req = num(at("requested"))
    if req is None:
        req = num(at("net_price"))

    # Requested Discount % — a hard 0 in that column is CPQ saying "nothing",
    # not the customer asking to pay the standard price. CPQ derives the column
    # from the net price against the standard price, so a transaction whose
    # price book never loaded writes 0 into it on every line (W262219747E,
    # 2026-09-04). Reading that 0 as a real request prices the whole quote at
    # full standard, which is exactly the failure this guard exists to stop.
    req_disc_pct = num(at("req_disc_pct"))
    if req_disc_pct is not None and abs(req_disc_pct) < EPS:
        req_disc_pct = None

    return {
        "material": canon(mat_raw),
        "description": at("description"),
        "group": (str(at("group") or "").strip() or None),
        "group_code": at("group_code"),
        "qty": qty,
        "list": num(at("list")),
        "std_disc": std,
        "std_zero": std_zero,
        "requested": req,
        "req_disc_pct": req_disc_pct,
        "cost": num(at("cost")),
        "approval_add": (str(at("notes") or "").strip() or "approver's request")
                        if str(at("identifier") or "").startswith(APPROVAL_ADD_MARK) else None,
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
def _trigger_cols(v):
    """A Trigger sheet's header row → {mat, desc, cost, list, target} column
    indexes, or None when this row is not the header.

    Both Trigger sheets carry a narrow trigger-price table on the far left (A
    Material, B Trigger Price) and the real price book to the right of it, and
    the price book's own block has moved twice already. So the block is found
    from the list-price column outwards: the material column is the LAST cell
    reading exactly 'Material' to its left, and description and cost are taken
    from between the two. Anything outside that span belongs to another table
    (the left-hand trigger prices, the EL sheet's service price list) and is
    ignored — which is what keeps 'COST MARCH 2026', four columns past the list,
    out of the cost slot.

    'List price 26 Q2 increase' (EL, both cuts) and 'List Price 2026 Q2 (3%
    increase)' (Fire, JULY V2) win over the AUG cut's 'Price list', so a sheet
    carrying both still reads the same column it always did.
    """
    head = {}
    for col, val in v.items():
        t = re.sub(r"\s+", " ", str(val if val is not None else "")).strip().lower()
        if t:
            head[col] = t

    def where(pred):
        return sorted(c for c, t in head.items() if pred(t))

    lst = where(lambda t: t.startswith("list price")) or where(lambda t: t.startswith("price list"))
    if not lst:
        return None
    li = lst[0]
    mats = [c for c in where(lambda t: t == "material") if c < li]
    if not mats:
        return None
    mi = mats[-1]

    def between(pred):
        hit = [c for c in where(pred) if mi < c < li]
        return hit[-1] if hit else None

    # Target price is carried for the record only — nothing prices off it — so it
    # is looked up by name anywhere on the row and left None when the cut drops it.
    tgt = where(lambda t: t.startswith("target price"))
    # Brand ("Eaton: Menvier" / "Eaton: JSB" / "Eaton: Cooper") is metadata only:
    # it names the maker in the cheaper-equivalent flag and nothing prices off
    # it, so a cut that drops the column costs the wording, not the price.
    brand = where(lambda t: t == "brand")
    return {"mat": mi, "list": li,
            "desc": between(lambda t: t == "description"),
            "cost": between(lambda t: "cost" in t),
            "target": tgt[0] if tgt else None,
            "brand": brand[0] if brand else None}


def load_reference(master):
    """Read the lookup tables the ledger uses. Keys are built exactly like the
    model's CONCATENATE so a Python price equals the Excel price."""
    import pyxlsb
    e2e, pv, mv, cust, trig, twin, twin_desc, dead, guide = (
        {}, {}, {}, {}, {}, {}, {}, {}, {})
    with pyxlsb.open_workbook(str(master)) as wb:
        names = {n.strip(): n for n in wb.sheets}

        # Trigger sheets — the list-price / cost reference by material. A CPQ export
        # of a net-priced deal (most FIRE quotes) carries NO list price (or a hard
        # zero, which is CPQ's price book failing to load), so the ledger's list has
        # to come from here instead. Dalia approved that route for every zero on
        # 2026-09-07, and it is now the normal way a FIRE line gets its list.
        #
        # The columns are READ OFF THE HEADER ROW, not assumed — see _trigger_cols.
        # The sheets are re-cut whenever the price book moves, and the AUG 2026 V2
        # master proved it: 'Fire Trigger 26' went from E=material G=cost I=list to
        # F=material K=list ("Price list", effective 1st July 26, +2.5% on the Q2
        # column) with no cost column at all, and 'EL Trigger 26' shifted its header
        # up a row. Hard-coded indexes read 'Range' as a price and silently priced
        # nothing.
        #
        # A row whose list cell is not a number ('Discontd.', or #VALUE! in the older
        # cut) is a DISCONTINUED material. Those rows are indexed in `twin` so the
        # entry that replaced them can be found: on the same description AND cost
        # where the sheet still carries a cost, on the description alone where it
        # does not — and then only when every priced row sharing that description
        # agrees on the price, because 18 of the AUG sheet's descriptions do not.
        for tname, ccy in (("EL Trigger 26", "EUR"), ("Fire Trigger 26", "USD")):
            if tname not in names:
                continue
            with wb.get_sheet(names[tname]) as sh:
                cols = None
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    if cols is None:
                        cols = _trigger_cols(v)
                        continue          # the header row is never data
                    mat = v.get(cols["mat"])
                    if mat in (None, "", "Material"):
                        continue
                    listp = num(v.get(cols["list"]))
                    cost = num(v.get(cols["cost"])) if cols["cost"] is not None else None
                    desc = (str(v.get(cols["desc"]) or "").strip().lower()
                            if cols["desc"] is not None else "")
                    if not listp:
                        # No usable list — the material is discontinued. Remember what
                        # the sheet says it IS, so the twin lookup below can find the
                        # entry that replaced it. Keyed on the sheet's own description
                        # and cost, never the BOM's: CPQ spells the description
                        # differently ('FXN723 DET/OPT/A' against 'Addressable Optical
                        # Smoke Sensor') and rounds the cost to four places.
                        if desc:
                            dead.setdefault(canon(mat),
                                            (desc, round(cost, 6) if cost else None))
                        continue
                    # first spelling wins, like Excel VLOOKUP; EL sheet listed first
                    trig.setdefault(canon(mat), {
                        "list": listp, "cost": cost, "ccy": ccy, "desc": desc,
                        "brand": (str(v.get(cols["brand"]) or "").strip()
                                  if cols.get("brand") is not None else ""),
                        "target": (num(v.get(cols["target"]))
                                   if cols["target"] is not None else None)})
                    rec = {"list": listp, "cost": cost, "ccy": ccy,
                           "material": canon(mat)}
                    if desc and cost:
                        twin.setdefault((desc, round(cost, 6)), rec)
                    if desc:
                        # False = this description carries more than one price, so it
                        # cannot stand in for a discontinued material on its own.
                        seen = twin_desc.get(desc)
                        if seen is None:
                            twin_desc[desc] = rec
                        elif seen and abs(seen["list"] - listp) > 1e-6:
                            twin_desc[desc] = False

        # 'Guidance' — the per-country price book the ledger's own column O reads
        # (O = XLOOKUP(country&material, Guidance!C:C, Guidance!K:K), which is why a
        # material missing from it shows #N/A there in the analyst's files too).
        #   A=country  B=material  C=country&material  H=Price List  I=Standard Price
        #   J=Add. Discount  K=Unit Price
        # It is a list-price source of last resort: its H is the PREVIOUS list, about
        # 6.6% under the Trigger sheet's "2026 Q2 (3% increase)" column, so it is only
        # used when neither the transaction nor the Trigger sheet has anything.
        if "Guidance" in names:
            with wb.get_sheet(names["Guidance"]) as sh:
                for row in sh.rows():
                    v = {c.c: c.v for c in row}
                    key = v.get(2)
                    listp = num(v.get(7))
                    if key in (None, "", "Concatenate") or not listp:
                        continue
                    rec = {"list": listp, "std": num(v.get(8)),
                           "add": num(v.get(9)), "unit": num(v.get(10)),
                           "country": v.get(0)}
                    guide.setdefault(canon(key), rec)
                    # Same material, any country — the list is identical across the
                    # region on every row checked, so this rescues a country the
                    # sheet spells differently from the ledger.
                    guide.setdefault(canon(v.get(1)), rec)

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

    return {"e2e": e2e, "pv": pv, "mv": mv, "cust": cust, "trig": trig,
            "twin": twin, "twin_desc": twin_desc, "dead": dead, "guide": guide}


# ─── the plant-cost price list (lines CPQ's Approval History adds) ───────────
# An item an approver asks to add ("Add QTY xx of Item xx") is not on CPQ's BOM,
# so it arrives with no cost and no pricing group. Laith's manual step reads both
# off this workbook ("Copy of Price list Master file workout Fire plant cost
# V15 NKKP 050326.xlsx"). Its 'Cost SAP 2026 FCT USD FX' column IS CPQ's Cost to
# within 0.3% on every line checked (W262253147E, W262247243E, W262253261E,
# 2026-10-01), so it stands in for the cost CPQ would have carried.
COST_MASTER_GLOB = "Copy of Price list Master file*.xlsx"
COST_MASTER_SHEET = "draft Fire V15 NKKP Clean copy"
# Pricing group code -> the description the E2E table is keyed on. Measured 1:1
# over 206 archived CPQ exports (2026-10-01); the master file carries only the code.
GROUP_NAMES = {
    "M5G": "Software", "M5I": "Spares", "M8A": "Addressable",
    "M8B": "Luminaries Self contained", "M8C": "Modules", "M8D": "Luminaires",
    "M8E": "Batteries", "M8F": "Voice System EN", "M8G": "Systems", "M8I": "Universal",
    "M8J": "Conventional", "M8K": "Notification-EN", "M8L": "Voice System UL",
    "M8M": "PQ Micro DC", "M8N": "Vocall & EAS", "M8P": "Legacy", "MDE": "Notification-UL",
}


def find_cost_master(job):
    """The configured plant-cost list, else the newest one in <case root>/Master Models."""
    p = str(job.get("cost_master") or "").strip()
    if p:
        return p if os.path.exists(p) else None
    import glob
    root = job.get("cases_root") or ""
    hits = [h for h in glob.glob(os.path.join(root, "Master Models", COST_MASTER_GLOB))
            if not os.path.basename(h).startswith("~$")]
    return max(hits, key=os.path.getmtime) if hits else None


def load_cost_master(path):
    """{material: {cost (USD), group_code, description}} off the plant-cost sheet.
    Columns are found by header name, not position - the sheet is re-cut per version."""
    import openpyxl
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = {n.strip().lower(): n for n in wb.sheetnames}
        sheet = names.get(COST_MASTER_SHEET.lower()) or next(
            (n for k, n in names.items() if k.startswith("draft fire")), None)
        if not sheet:
            raise ValueError(f"no '{COST_MASTER_SHEET}' sheet")
        out, cols = {}, None
        for row in wb[sheet].iter_rows(values_only=True):
            if cols is None:
                h = [re.sub(r"\s+", " ", str(v or "")).strip().lower() for v in row]
                if "material" in h and any(t.startswith("cost sap 2026 fct") for t in h):
                    cols = {"mat": h.index("material"),
                            "cost": next(i for i, t in enumerate(h) if t.startswith("cost sap 2026 fct")),
                            "mg5": h.index("mg5") if "mg5" in h else None,
                            "desc": h.index("description") if "description" in h else None}
                continue
            mat = row[cols["mat"]] if cols["mat"] < len(row) else None
            if mat in (None, ""):
                continue
            def at(k):
                i = cols[k]
                return row[i] if i is not None and i < len(row) else None
            cost = num(at("cost"))
            out[canon(mat)] = {"cost": cost if cost and cost > 0 else None,
                               "group_code": (str(at("mg5") or "").strip().upper() or None),
                               "description": (str(at("desc") or "").strip() or None)}
        if cols is None:
            raise ValueError("no header row with Material and 'Cost SAP 2026 FCT USD FX'")
        return out
    finally:
        wb.close()


def fill_approval_adds(lines, rows, job, aprc, log):
    """Give every line CPQ's Approval History added the cost, group and description
    the plant-cost list carries for it. Cost is USD there, so a EUR (525) deal gets
    it through the ledger's own R6 rate. A material the list does not price is left
    without a cost - the engine's no-cost flag then says so."""
    adds = [l for l in lines if l.get("approval_add")]
    if not adds:
        return
    path = find_cost_master(job)
    if not path:
        log(f"{len(adds)} line(s) added from CPQ's Approval History, but no plant-cost price "
            f"list was found (Settings > LSD Pricing > Plant-cost price list) - they carry no cost.",
            "warn")
        return
    try:
        book = load_cost_master(path)
    except Exception as e:                              # noqa: BLE001 - reported
        log(f"Could not read {os.path.basename(path)}: {e} - the added line(s) carry no cost.", "warn")
        return
    fx = float(job.get("fx") or 1.12522)
    for l in adds:
        rec = book.get(l["material"])
        if not rec:
            log(f"{l['material']} (added from Approval History) is not on "
                f"{os.path.basename(path)} - no cost.", "warn")
            continue
        if not l.get("cost") and rec["cost"]:
            l["cost"] = rec["cost"] / fx if aprc == "525" else rec["cost"]
        if not l.get("group") and rec["group_code"]:
            l["group_code"] = rec["group_code"]
            l["group"] = GROUP_NAMES.get(rec["group_code"])
        if not l.get("description"):
            l["description"] = rec["description"]
        # The same values into the raw row, so 'Paste BOM Here' (which the ledger
        # XLOOKUPs) carries them too.
        for i, r in enumerate(rows):
            if (str((r[0] if r else "") or "").startswith(APPROVAL_ADD_MARK)
                    and len(r) >= BOM_COLS["cost"]
                    and canon(r[BOM_COLS["material"] - 1]) == l["material"]):
                r = list(r)
                r[BOM_COLS["description"] - 1] = l.get("description")
                r[BOM_COLS["group_code"] - 1] = l.get("group_code")
                r[BOM_COLS["group"] - 1] = l.get("group")
                r[BOM_COLS["cost"] - 1] = l.get("cost")
                rows[i] = r
        log(f"{l['material']} x{l['qty']:g} added from Approval History: cost "
            f"{l['cost'] if l.get('cost') is not None else 'none'}, group {l.get('group') or '?'}"
            f" (from {os.path.basename(path)})")


def detect_aprc(lines):
    """FIRE transactions price in USD (APRC 530-535); EL in EUR (525). Decide from
    the pricing-group mix, the same signal the analyst reads off the BOM."""
    fire = sum(1 for l in lines if str(l["group"] or "").strip().lower() in FIRE_GROUPS)
    el = len(lines) - fire
    return "530-535" if fire > el else "525"


# ─── the cheaper identical equivalent ────────────────────────────────────────
# Menvier, JSB and Cooper ship the same part under the same code bar one letter
# — M, J and C — and the Trigger sheet names the maker in its Brand column
# ("Eaton: Menvier", "Eaton: JSB", "Eaton: Cooper"). The prices are not always
# equal, and Dalia routinely asks for the dearer one to be dropped for "its
# identical cheaper equivalent" (Laith, on the call 2026-09-10).
#
# This only ever SUGGESTS. Swapping a material changes what the customer is
# offered, so the analyst — and the customer — have to agree to it; the engine
# has no business doing it quietly, the same reason the discontinued-twin
# substitution is flagged rather than applied.
BRAND_LETTERS = ("M", "J", "C")
# How much cheaper the sibling has to be before it is worth an analyst's time.
# Across the 3,325 materials in the V2 master, 9 pairs differ at all and only 5
# differ by more than a rounding: the APS pull stations at 30-46% and JFC6/MFC6
# at 13% are real money, while MJOM/MCOM at 0.03 and the RT2 thermostats at 0.70
# are noise that would train the analyst to skip the flag.
EQUIV_MIN_SAVING = 0.02


def _brand_siblings(mat):
    """Codes differing from `mat` only by a brand letter. ULEFMDO10 →
    ULEFJDO10, ULEFCDO10.

    Only a position already holding M, J or C is swapped, so a code that merely
    contains an M somewhere does not sprout fake siblings. The candidates still
    have to exist in the Trigger sheet AND carry the same description before
    anything is said about them — one letter is not evidence of one part.
    """
    out = []
    for i, ch in enumerate(mat):
        if ch in BRAND_LETTERS:
            for other in BRAND_LETTERS:
                if other != ch:
                    out.append(mat[:i] + other + mat[i + 1:])
    return out


def _cheaper_equivalent(mat, listp, rec, trig, to_deal):
    """The cheapest same-part sibling under another brand letter, or None."""
    if not listp or not rec or not rec.get("desc"):
        return None
    best = None
    for sib in _brand_siblings(mat):
        s = trig.get(sib)
        if not s or not s.get("list") or not s.get("desc"):
            continue
        if s["desc"] != rec["desc"]:            # same description = same part
            continue
        cand = to_deal(s["list"], s["ccy"])
        if cand is None or cand > listp * (1 - EQUIV_MIN_SAVING):
            continue
        if best is None or cand < best["list"]:
            best = {"material": sib, "list": cand, "brand": s.get("brand") or ""}
    return best


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


def _rpi_gate(w, y, qty, py_ctry_qty, rate):
    """The 'requested' rule's RPI gate: the prior-year average this line is
    measured against, lifted by the half-year rate. The analyst's own manual
    check — customer average x 1.06 — not the algebraic mix-variance solve, which
    over-corrects because it also pays for the mix offset.

    Over 5x the model reads RPI as 0, but the floor still holds (Dalia,
    2026-09-15, MTL5561: 101.83 x 1.06 = 107.94): the customer can cut the
    quantity on the next revision, and then the 6% is read on a price that
    never had it."""
    five_x = bool(py_ctry_qty and qty and (qty / py_ctry_qty) > FIVEX)
    note = " - 5x qty, the model reads RPI 0 but the floor is kept in case qty drops" if five_x else ""
    if w:
        return w * (1 + rate), "customer avg x (1 + rate)" + note
    if y:
        return y * (1 + rate), "country avg x (1 + rate)" + note
    return None, None


def _line_variance(l, price):
    """One line's (AG, AE) contribution at `price` — the ledger's AB/AD chain.

    The two branches are NOT the same measurement, and conflating them is how a
    quote reads 36% RPI without anybody having raised a price:
      * with a customer average, AG is a real increase ON THIS CUSTOMER and the
        mix term is the small (QTY - QFC) x (W - Y) offset;
      * with only a COUNTRY average, the whole gap (S - Y) x QTY lands in mix.
        For a customer who bought none of this last year that is a comparison to
        the Gulf's prior-year average, not a price increase to anyone.
    """
    if not l["qty"] or price is None:
        return 0.0, 0.0
    if l["ctry_qty"] and (l["qty"] / l["ctry_qty"]) > FIVEX:
        return 0.0, 0.0                                # 5x: the model zeroes both
    if l["cust_avg"]:
        pv_ = (price - l["cust_avg"]) * l["qty"]
        qfc = ((l["cust_qty"] / l["ctry_qty"]) * l["qty"]
               if (l["cust_qty"] and l["ctry_qty"]) else 0.0)
        return pv_, pv_ + ((l["qty"] - qfc) * (l["cust_avg"] - l["ctry_avg"])
                           if l["ctry_avg"] else 0.0)
    if l["ctry_avg"]:
        return 0.0, (price - l["ctry_avg"]) * l["qty"]
    return 0.0, 0.0


def _variance(lines, price_key):
    """(AG, AE) — price variance and price+mix variance — over `lines` at the
    unit price in `price_key`. The ledger's own AB/AD chain, so the same code
    serves the proposed price and the customer's target price."""
    ag = ae = 0.0
    for l in lines:
        a, e = _line_variance(l, l.get(price_key))
        ag += a
        ae += e
    return ag, ae


def _rpi_readings(lines, price_key):
    """The THREE RPI numbers the working file shows off the same ledger. They are
    not interchangeable and an approver's target has to name one:

        pivot   AE / (T - AE)   the summary PIVOT, and so THE APPROVAL MAIL'S
                                'Total RPI %' column - the only one the approver
                                was actually sent;
        ledger  AE / (T - AG)   the ledger totals row AF11, `summary.total_rpi`;
        price   AG / (T - AG)   header K6 'Overall RPI' - price variance ONLY, so
                                it is the real increase to THIS customer.

    On W262232081E as Dalia sent it: 13.0% / 11.8% / 2.5%. Kiran asked for "RPI
    4-5%" against the 13.0%.
    """
    net = sum((l.get(price_key) or 0) * (l.get("qty") or 0) for l in lines)
    ag, ae = _variance(lines, price_key)
    return {
        "net": net,
        "pv_value": ag,
        "rpi_value": ae,
        "pivot": ae / (net - ae) if abs(net - ae) > EPS else None,
        "ledger": ae / (net - ag) if abs(net - ag) > EPS else None,
        "price": ag / (net - ag) if abs(net - ag) > EPS else None,
    }


# Which reading `rpi_target` is measured on. The approver reads the mail, so the
# mail's basis is the default.
RPI_BASES = ("pivot", "ledger", "price")


def _rework_prices(lines, country_rate, rate):
    """The reworked unit price for every line, at one trial `country_rate`.

    THE SHAPE OF THE REWORK (Kiran on W262232081E, 2026-09-17: "rework to
    maintain margins above 43% and RPI 4-5%"). Do NOT solve the whole book down
    with `_rpi_target` at a low rate: mix variance does not move with price, so
    the solve pays for the mix offset out of the lines that DO have customer
    history and pushes them UNDER last year's price. On that case it cut KYR's
    four known materials 20-25% and turned the price variance negative (-3.4%)
    while their standing agreement says +2.5%. The customer sees his own four
    prices; he never sees the mix. So:

      1 a line with a PY CUSTOMER AVERAGE is SET at last year x (1 + rate) - the
        case rate, exception included. The customer's own reference is honoured
        and the price variance stays positive;
      2 a line with a COUNTRY AVERAGE only is set at that average x (1 + r), and
        `r` is the single scalar solved to land the total on target. These are
        the lines carrying the mix, and the ones the customer has no reference
        for;
      3 a line with no prior-year reference at all keeps the rule's price - there
        is nothing to measure it against, so moving it buys no RPI;
      4 every line WITHOUT a customer reference is then clamped at its target E2E
        by the existing floor, so the margin never pays for the RPI. Laith's own
        note on these customers: "even if RPI has boomed, most importantly,
        margin can't go low... it doesn't make sense to keep RPI within limits
        and go with low margin."

    A carried line is never touched: its price was approved when it was set.
    Returns {id(line): price} so the caller can apply or just measure it."""
    out = {}
    for l in lines:
        if l.get("carried") or l.get("unit_net") is None:
            out[id(l)] = l.get("unit_net")
            continue
        # (0) AN AGREED PRICE IS NOT A LEVER. A line in the customer's own
        # fixed-price book is held there — the RPI is not theirs to pay for, and
        # quoting under a price they have already been invoiced at this year
        # reopens the agreement. See load_customer_book.
        if l.get("book_price"):
            price = max(l["book_price"] * (1 + rate), l["book_price"])
        elif l.get("cust_avg"):
            price = l["cust_avg"] * (1 + rate)
        elif l.get("ctry_avg"):
            price = l["ctry_avg"] * (1 + country_rate)
            # (4) the target-E2E clamp, the same floor the rule applies.
            if l.get("net_at_target") and l.get("qty"):
                price = max(price, l["net_at_target"] / l["qty"])
        else:
            price = l["unit_net"]
        out[id(l)] = price
    return out


def _book_rpi(lines):
    """The increase against what the customer has ACTUALLY PAID this year, over
    the lines their book covers. Same ratio shape as the ledger's RPI so the two
    can be read side by side — but measured on the agreed price rather than on a
    prior-year average the customer never saw. None when nothing is covered."""
    covered = [l for l in lines if l.get("book_price") and l.get("unit_net") is not None]
    if not covered:
        return None
    net = sum(l["unit_net"] * (l["qty"] or 0) for l in covered)
    var = sum((l["unit_net"] - l["book_price"]) * (l["qty"] or 0) for l in covered)
    return round(var / (net - var), 4) if abs(net - var) > EPS else None


def _book_floor(l):
    """The price this customer has ALREADY PAID for the line this year, and so
    the hard floor under everything: the rule, the RPI solve and an approver's
    rework alike. Nothing in the engine may quote under it."""
    return l.get("book_price") or None


def _solve_country_rate(lines, target, rate, basis="pivot"):
    """The scalar the country-average lines move on to land `target`.

    Bisection, not algebra: the target-E2E clamp in `_rework_prices` is a max(),
    so the total is piecewise-linear in `r` rather than linear. It IS monotonic
    in `r`, which is all bisection needs. Returns (rate, achieved, reachable)."""
    def at(r):
        trial = _rework_prices(lines, r, rate)
        probe = [dict(l, unit_net=trial[id(l)]) for l in lines]
        return _rpi_readings(probe, "unit_net")[basis]

    lo, hi = -0.90, 0.90
    lo_v, hi_v = at(lo), at(hi)
    if lo_v is None or hi_v is None:
        return None, None, False
    # Nothing to solve: the clamps hold the whole book, so `r` cannot reach it.
    if target < lo_v - EPS:
        return lo, lo_v, False
    if target > hi_v + EPS:
        return hi, hi_v, False
    for _ in range(60):
        mid = (lo + hi) / 2
        if at(mid) < target:
            lo = mid
        else:
            hi = mid
    r = (lo + hi) / 2
    return r, at(r), True


def _by_group(lines):
    """The mail's table: one row per pricing group, in the order the groups first
    appear on the transaction. Add. Discount is derived from the totals, not
    averaged across lines — an average would not reproduce the net price."""
    rows, seen = [], {}
    for l in lines:
        g = str(l["group"] or "").strip() or "(no group)"
        if g not in seen:
            seen[g] = {"group": g, "_lines": []}
            rows.append(seen[g])
        seen[g]["_lines"].append(l)
    for r in rows:
        ls = r.pop("_lines")
        net = sum(l["total_net"] or 0 for l in ls)
        std = sum(l["total_std"] or 0 for l in ls)
        # E2E over the lines that HAVE a cost, never over all of them: a missing
        # cost is unknown, not zero, and a zero reads as a 100% margin.
        costed = [l for l in ls if l["total_cost"] is not None]
        cost = sum(l["total_cost"] for l in costed)
        cost_net = sum(l["total_net"] or 0 for l in costed)
        _, ae = _variance(ls, "unit_net")
        tgts = [l["target_e2e"] for l in ls if l["target_e2e"] is not None]
        r.update({
            "lines": len(ls),
            "add_disc": round(1 - net / std, 4) if std else None,
            "net": round(net, 2),
            "e2e": round(1 - cost / cost_net, 4) if cost_net else None,
            # Lines in this group the E2E above could not see.
            "cost_missing": len(ls) - len(costed),
            "target_e2e": round(max(tgts), 4) if tgts else None,
            # The summary PIVOT's own calculated field — 'Total RPI Value' /
            # ('Total Net Price' - 'Total RPI Value') — which is NOT the ledger
            # totals row's AF11 (that one subtracts RPI Value). This table mirrors
            # the pivot, so it keeps the pivot's basis. See summary.total_rpi.
            "rpi_pct": round(ae / (net - ae), 4) if abs(net - ae) > EPS else None,
            "rpi_value": round(ae, 2),
        })
    return rows


def headline(summary, meta, diff):
    """One sentence saying what this transaction IS, for someone who will not
    read the table: what changed, what it costs, and whether anyone has to
    decide anything. It goes in the log, on the screen and into the register's
    Notes, so the same words follow the case everywhere."""
    ccy = summary.get("currency") or "USD"
    rev = str(meta.get("revision") or "").strip().upper()
    money_ = f"{summary['grand_total']:,.2f} {ccy}"
    e2e = f"{summary['overall_e2e']:.1%}" if summary.get("overall_e2e") is not None else "n/a"
    rpi = f"{summary['total_rpi']:.1%}" if summary.get("total_rpi") is not None else "n/a"

    if diff:
        bits = []
        if diff["qty_changed"]:
            bits.append(f"{len(diff['qty_changed'])} quantity change"
                        f"{'s' if len(diff['qty_changed']) != 1 else ''}")
        if diff["added"]:
            bits.append(f"{len(diff['added'])} NEW item"
                        f"{'s' if len(diff['added']) != 1 else ''}")
        if diff["removed"]:
            bits.append(f"{len(diff['removed'])} removed")
        what = ", ".join(bits) if bits else "no changes to the lines"
        if diff["qty_changed"] and not diff["added"]:
            what += " — quantities only, every price held from " + diff["prior"]
        elif diff["added"]:
            what += f" — the new item(s) are priced by the rule, the rest held from {diff['prior']}"
        head = f"{rev or 'Revision'} of {diff['prior']}: {what}."
    else:
        head = (f"{'First version' if not rev else rev}: "
                f"{summary['lines']} line{'s' if summary['lines'] != 1 else ''} priced.")

    head += f" {money_}, E2E {e2e}, total RPI {rpi}."
    # A 0% the model cannot see past is not a 0% increase — say which it is.
    blind = summary.get("rpi_blind") or {}
    nb = len(blind.get("fivex") or ()) + len(blind.get("no_ref") or ())
    if nb and abs(summary.get("total_rpi") or 0) < 0.0005:
        bits = []
        if blind.get("fivex"):
            bits.append(f"{len(blind['fivex'])} line(s) are over 5x last year's country qty "
                        f"(the model zeroes RPI there)")
        if blind.get("no_ref"):
            bits.append(f"{len(blind['no_ref'])} line(s) have no prior-year price at all")
        head += (" RPI reads 0 because " + " and ".join(bits)
                 + (" - that is every line, so the 0% says nothing about the increase"
                    + ("; the RPI floor still priced the referenced lines over last year."
                       if summary.get("raised") else
                       "; no line is priced off last year, the target E2E set them.")
                    if nb >= summary["lines"] else "."))
    prov = summary.get("provisional_5x") or []
    if prov:
        head += (f" {len(prov)} line(s) over 5x last year's country qty keep the RPI until "
                 f"the order is confirmed ({', '.join(prov[:4])}{'...' if len(prov) > 4 else ''}).")
    adds = summary.get("approval_adds") or []
    if adds:
        head += (f" {len(adds)} line(s) added from CPQ's Approval History "
                 f"({', '.join(adds[:4])}{'...' if len(adds) > 4 else ''}) - check them.")
    sus = summary.get("suspect") or []
    if sus:
        head = (f"ASK FIRST: {len(sus)} line(s) look like a typo ("
                + ", ".join(s["material"] for s in sus[:3])
                + (", ..." if len(sus) > 3 else "")
                + ") - confirm with sales before sending. " + head)
    miss = summary.get("cost_missing") or 0
    if miss:
        head += (f" No cost on {miss} of {summary['lines']} line(s)"
                 + (" - there is no margin reading on this case"
                    if miss >= summary["lines"] else
                    f", so the E2E covers {summary['cost_cover']:.0%} of the money")
                 + ": the CPQ document carries no cost, so reprice it there "
                   "and fetch it again before quoting a margin.")
    if summary.get("below_target"):
        head += (f" Margin {e2e} against a "
                 f"{summary['target_e2e']:.0%} target — needs approval.")
    elif summary.get("floored"):
        band = ", ".join(f"{r:.0%}" for r in summary.get("e2e_concession") or ())
        head += (f" {summary['floored']} line(s) asked below the "
                 f"{summary['target_e2e']:.0%} target and were priced AT it, "
                 f"+{summary['floored_value']:,.2f} over the ask"
                 + (f" — concede no further than {band} if the customer pushes back."
                    if band else " — needs approval."))
    elif diff and not diff["added"]:
        head += " Nothing to approve: no price on this revision is new."
    elif summary.get("action"):
        head += f" {summary['action']} line(s) need a decision."
    else:
        head += " No line needs a decision."
    # A double-digit RPI is the first thing the approver challenges, and the total
    # on its own does not survive the challenge — say which line it came from and
    # whether it is an increase to anybody at all.
    drv = (summary.get("rpi_drivers") or [None])[0]
    if (summary.get("total_rpi") or 0) > 0.10 and drv and (drv.get("share") or 0) > 0.4:
        head += (f" The {summary['total_rpi']:.1%} RPI is {drv['share']:.0%} "
                 f"{drv['material']} alone")
        if drv.get("ref_below_cost"):
            head += (f", whose prior-year average {drv['ctry_avg']:,.2f} is below its "
                     f"{drv['cost']:,.2f} cost - the material was repriced, so no margin "
                     f"meets the gate")
        if summary.get("rpi_no_history") and abs(summary["rpi_no_history"]
                                                 - (summary.get("rpi_value") or 0)) < 1:
            head += ("; this customer bought none of these last year, so it is a "
                     "comparison to the Gulf average, not an increase to them")
        head += "."
    # The rate is the first thing the approver asks about when it is not the
    # half-year's, so it goes in the headline rather than three tables down.
    xc = summary.get("rpi_exception")
    if xc:
        head += (f" Priced on the {xc['label']} rate: last year's price + "
                 f"{xc['rate']:.1%} instead of the {xc['standard']:.1%} "
                 f"{summary.get('half')} rate — {xc['why']}. The rate itself "
                 f"needs approving.")
    return head


def price_lines(lines, ref, meta):
    """Apply the rule to every line. Returns (priced, summary)."""
    half = meta["half"]
    rate = RPI_RATE[half]
    # A standing customer exception replaces the half-year rate outright — the
    # floor is still prior-year x (1 + rate), only the rate is negotiated.
    exc = rpi_exception(meta)
    if exc:
        rate = exc["rate"]
    # The customer's agreed prices. Loaded off the standing-customer entry, which
    # is matched WITHOUT the date test — the book covers the whole year, and it
    # names every account that is one commercial customer, so a quote under the
    # sibling number reads the same prices. Failure to load is reported, never
    # fatal: a case still prices without it, just without the guard.
    group = customer_group(meta)
    book, book_err = meta.get("_book"), None
    if book is None:
        book_path = find_customer_book(meta, group)
        if book_path:
            try:
                book = load_customer_book(book_path)
            except Exception as e:                      # noqa: BLE001 - reported
                book, book_err = None, f"{os.path.basename(book_path)}: {e}"
    rule = str(meta.get("rule") or "requested").strip().lower()
    if rule not in ("requested", "e2e"):
        rule = "requested"
    # The customer has confirmed the order and its quantities. Until then a 5x
    # line is priced as if the quantity could still drop (see FIVEX_COUNTRY_NO_GATE).
    order_confirmed = bool(meta.get("order_confirmed"))

    # ── the approver's rework ────────────────────────────────────────────────
    # `rpi_target` is a CEILING an approver put on the case after seeing it, not
    # a number to price to: a quote already under it is left exactly where the
    # rule put it. Hitting it needs every line at once (see _rework_prices), so
    # the case is priced by the rule first, the scalar is solved off that, and
    # then the whole thing is re-priced with the scalar fixed — which keeps every
    # flag, every floor and every carry in the one loop below rather than
    # patching numbers afterwards.
    rework = meta.get("_rework")
    if rework is None and meta.get("rpi_target") is not None:
        target = float(meta["rpi_target"])
        basis = str(meta.get("rpi_basis") or "pivot").strip().lower()
        if basis not in RPI_BASES:
            basis = "pivot"
        plain = dict(meta)
        plain["rpi_target"] = None
        plain["_book"] = book            # loaded once, not per pass
        base_out, _ = price_lines(lines, ref, plain)
        before = _rpi_readings(base_out, "unit_net")
        r, achieved, reachable = _solve_country_rate(base_out, target, rate, basis)
        if before[basis] is None or before[basis] <= target + EPS:
            # Already inside the approver's band. Reworking down from here would
            # give away price nobody asked for.
            rework = {"target": target, "basis": basis, "applied": False,
                      "before": before[basis], "achieved": before[basis],
                      "country_rate": None, "reachable": True,
                      "why": "already at or under the target - left as priced"}
        elif r is None:
            rework = {"target": target, "basis": basis, "applied": False,
                      "before": before[basis], "achieved": before[basis],
                      "country_rate": None, "reachable": False,
                      "why": "no line carries a prior-year country average, so no "
                             "price moves this reading"}
        else:
            # WHAT STOPPED IT, when it stopped short. The book comes first: it is
            # a commitment to the customer, where the E2E floor is our own margin
            # rule, and an approver told the two apart needs to know which he is
            # being asked to move.
            held = sum(1 for l in base_out if l.get("book_price"))
            why = None
            if not reachable:
                why = ("the target E2E floor holds the country lines up - this is "
                       "as low as the reading goes without selling under the margin")
                if held:
                    why = (f"{held} line(s) are at prices this customer has already "
                           f"been invoiced this year and cannot be cut - the reading "
                           f"cannot reach the target without reopening the agreed "
                           f"price list")
            rework = {"target": target, "basis": basis, "applied": True,
                      "before": before[basis], "achieved": achieved,
                      "country_rate": r, "reachable": reachable,
                      "book_held": held, "why": why}
        meta = dict(meta)
        meta["_rework"] = rework

    # Prices carried forward from the previous revision, keyed on material.
    carry = meta.get("_carry") or {}
    typo_keep = {str(m).strip() for m in (meta.get("typo_keep") or ()) if str(m).strip()}
    carry_label = meta.get("_carry_label") or "the previous revision"
    carry_hist = meta.get("_carry_hist") or {}
    fx = float(meta.get("fx") or 1.12522)
    usd = meta.get("aprc") != "525"
    customer = canon(meta.get("customer"))
    ledger = canon(meta.get("ledger") or "R2321")

    deal_ccy = "EUR" if meta.get("aprc") == "525" else "USD"

    def _to_deal(value, src_ccy):
        """Trigger prices are stored per sheet currency (EL EUR, Fire USD). Convert
        to the deal currency; R6 = 1.12522 USD per EUR, as the ledger's W/Y do."""
        if value is None or src_ccy == deal_ccy:
            return value
        return value * fx if deal_ccy == "USD" else value / fx

    out = []
    for ln in lines:
        mat = ln["material"]
        qty = ln["qty"] or 0.0
        listp = ln["list"]
        std = ln["std_disc"]
        cost = ln["cost"]

        # List price (and cost) come from the master's own books, in order of how
        # current the number is:
        #   1 the Trigger sheet's own row for this material — THE LATEST LIST;
        #   2 the transaction's own List Price, when the material is on no book;
        #   3 the Trigger row of an IDENTICAL entry — same description, same cost to
        #     the cent — which is how a discontinued material reaches its successor's
        #     price (its own row carries #VALUE! in the list column);
        #   4 the Guidance sheet by country&material, the previous list, ~6.6% under.
        # Anything that lands on a line by route 3 or 4 is flagged, because it is a
        # substitution and the analyst has to agree with it.
        #
        # The Trigger sheet OVERRIDES the transaction (Dalia, 2026-09-08, on
        # W262223256E): "LP not updated on working file, as discussed it should be
        # updated manually as per latest LSD pricing model." CPQ quotes off whatever
        # price book its session loaded, which on that case was the pre-July cut —
        # 5069.88 against the master's 5171.51 on the same material. The manual step
        # she describes is exactly this lookup, so the engine does it.
        # Under the 'requested' rule this does NOT move the price: the customer asks
        # in money, and `req_disc` is re-derived off the new standard price, so the
        # ledger shows a deeper Add. Discount against a higher list for the same
        # unit net. It moves the price only where the customer asked in PERCENT.
        # A hard 0 in the transaction's List Price column is CPQ's price book
        # failing to load, not a free line — it is treated exactly like a blank.
        list_zero = listp is not None and abs(listp) < EPS
        list_src = None
        txn_list = listp or None
        t = ref["trig"].get(mat)
        if t and t["list"]:
            listp = _to_deal(t["list"], t["ccy"])
            list_src = "trigger"
        if (not cost) and t and t["cost"]:
            cost = _to_deal(t["cost"], t["ccy"])

        twin = None
        if not listp:
            key = ref["dead"].get(mat)
            if key:
                desc_k, cost_k = key
                twin = ref["twin"].get((desc_k, cost_k)) if cost_k is not None else None
                # The AUG cut of the Fire sheet dropped its cost column, so a
                # discontinued material can only be matched on its description —
                # and only where every priced row with that description agrees.
                if twin is None:
                    twin = ref["twin_desc"].get(desc_k) or None
            if twin and canon(twin["material"]) != mat:
                listp = _to_deal(twin["list"], twin["ccy"])
                list_src = "twin"
                if not cost:
                    cost = _to_deal(twin["cost"], twin["ccy"])

        grec = None
        if not listp:
            country = canon(meta.get("country"))
            grec = ref["guide"].get(country + mat) or ref["guide"].get(mat)
            if grec:
                # Guidance is a USD book, like the Fire Trigger sheet it sits beside.
                listp = _to_deal(grec["list"], "USD")
                list_src = "guidance"

        unit_std = listp * (1 - std) if listp else None
        total_std = unit_std * qty if unit_std is not None else None
        total_cost = cost * qty if cost is not None else None

        # Requested discount — the ledger reads the BOM's Requested Discount %,
        # and the procedure's step 5d recomputes it from the requested price.
        # Prefer the price (it is what the customer actually asked for).
        req_disc = None
        if ln["requested"] is not None and unit_std:
            req_disc = 1 - ln["requested"] / unit_std
        elif ln["req_disc_pct"] is not None:
            req_disc = ln["req_disc_pct"] / 100

        # A request so far over the standard price it can only be a typo (see
        # TYPO_REQ_RATIO). Not copied unless the analyst has confirmed it.
        typo = None
        if req_disc is not None and req_disc < 1 - TYPO_REQ_RATIO and carry.get(mat) is None:
            asked = ln["requested"] if ln["requested"] is not None else unit_std * (1 - req_disc)
            typo = {"requested": round(asked, 4), "unit_std": round(unit_std, 4),
                    "ratio": round(asked / unit_std, 2), "kept": mat in typo_keep}
            if not typo["kept"]:
                req_disc = None

        # E2E target and the discount that lands the line on it (ledger M and N).
        tgt_e2e = ref["e2e"].get(str(ln["group"] or "").strip().lower())
        net_at_tgt = (total_cost / (1 - tgt_e2e)) if (total_cost is not None and tgt_e2e not in (None, 1)) else None
        disc_at_tgt = (1 - net_at_tgt / total_std) if (net_at_tgt is not None and total_std) else None

        flags = []

        # ── THE DECISION ─────────────────────────────────────────────────────
        # 'requested': the customer's own discount, AS REQUESTED — neither the
        # target E2E nor the 20% cap holds the price up; the RPI gate below is the
        # only thing that lifts it. 'e2e': the old MIN(requested, @target, 20%).
        if rule == "requested" and req_disc is not None:
            candidates = [req_disc]
        else:
            candidates = [c for c in (req_disc, disc_at_tgt, ADD_DISC_CAP) if c is not None]
            if rule == "requested" and ln.get("approval_add"):
                # Not on the BOM at all: an approver asked for it in CPQ's Approval
                # History, so there is no request to copy. MIN(target E2E, 20%),
                # then the RPI and E2E floors below, is the analyst's own handling.
                flags.append(("verify", f"added from CPQ Approval History "
                                        f"({ln['approval_add']}) - no requested price, priced "
                                        f"at MIN(target E2E, 20%) then the floors"))
            elif rule == "requested" and not typo:
                # Nothing was requested, so there is nothing to copy across. Falling
                # through to MIN(@target, 20%) is the only defensible reading, but
                # it is a different rule from the one the case was run under and the
                # analyst has to see that it happened.
                flags.append(("action", "the transaction carries no requested price and no "
                                        "requested discount - priced at MIN(target E2E, 20%) "
                                        "instead, confirm before sending"))
        add_disc = min(candidates) if candidates else 0.0
        # A tolerance, not `< 0`: a line asking for exactly the standard price
        # computes an add. discount of -1e-17 and was reporting itself as "priced
        # 0.0% ABOVE the standard price", which sent the analyst looking at a
        # rounding artefact. Half a basis point is well under anything real.
        if add_disc < -5e-5:
            # Target E2E is a FLOOR: when cost outruns the standard price the
            # discount goes negative and the line is priced ABOVE standard. That
            # is the model's own behaviour, so it is kept — and surfaced.
            flags.append(("verify", f"priced {-add_disc:.1%} ABOVE the standard price to "
                                    f"hold the target E2E - confirm with the customer"))
        binds = ("requested" if req_disc is not None and abs(add_disc - req_disc) < EPS else
                 "target E2E" if disc_at_tgt is not None and abs(add_disc - disc_at_tgt) < EPS else
                 "20% cap" if abs(add_disc - ADD_DISC_CAP) < EPS else "floor 0%")

        # No list (and no trigger fallback) => the list-based model cannot price
        # this line, and the ledger drops it. Leave it unpriced and flagged rather
        # than quietly pricing it at requested — that would inflate the engine
        # total above the ledger and disagree with the three-way check. (These are
        # typically EL spares on a FIRE quote; the analyst prices them elsewhere.)
        unit_net = unit_std * (1 - add_disc) if unit_std else None

        # ── a revision: hold what was already quoted ─────────────────────────
        # The customer changed a quantity, not a price. Repricing the line would
        # move a number they have already seen, so the previous revision's unit
        # net wins outright — no target, no gate. Only lines that are NEW on this
        # revision fall through to the rule above.
        carried = carry.get(mat)
        if carried is not None and unit_std:
            # What sales ASKED for on a line that was already approved. Holding the
            # approved price is right either way, but a request that is not that
            # price is a decision someone made and nobody has seen: it has to be
            # said out loud, not quietly overwritten (Laith, 2026-09-28).
            if ln["requested"] is not None and carried:
                off = abs(ln["requested"] - carried) / carried
                if off > REVISION_MATCH_TOL:
                    way = "under" if ln["requested"] < carried else "over"
                    # An older revision's price is a different story from a number
                    # nobody has approved, so name it when that is what was asked.
                    older = next((lb for lb, net in carry_hist.get(mat, ())
                                  if net and abs(ln["requested"] - net) / net <= REVISION_MATCH_TOL
                                  and lb != carry_label), None)
                    flags.append(("action",
                                  f"requested {ln['requested']:,.4f} is {off:.2%} {way} the "
                                  f"{carry_label} price {carried:,.4f}"
                                  + (f" - it is the {older} price" if older else
                                     " - it matches no approved revision")
                                  + f"; held at {carry_label}, confirm which one the customer was given"))
            add_disc = 1 - carried / unit_std
            unit_net = carried
            binds = f"held from {carry_label}"
        elif carry and unit_std:
            flags.append(("verify", f"new on this revision - priced by the rule, "
                                    f"not carried from {carry_label}"))

        # ── the RPI floor ────────────────────────────────────────────────────
        # Keys are CONCATENATE(customer|ledger, material). With a blank prefix the
        # key degenerates to the bare material and could collide with a real row,
        # so no prefix means no lookup — same as the model showing blanks.
        cust_avg, cust_qty = ref["pv"].get(customer + mat, (None, None)) if customer else (None, None)
        ctry_avg, ctry_qty = ref["mv"].get(ledger + mat, (None, None)) if ledger else (None, None)
        if not usd:                                  # ledger divides by FX in EUR mode
            cust_avg = cust_avg / fx if cust_avg else cust_avg
            ctry_avg = ctry_avg / fx if ctry_avg else ctry_avg

        # What this customer has actually paid for this material THIS year. It is
        # an agreed price, not an average, so it outranks the prior-year lookup
        # above — including on the lines where that lookup came back blank, which
        # is most of them (the book is the current year, 'PV 2025 ' is not).
        bk = (book["prices"].get(mat) if book else None)
        book_price = bk["price"] if bk else None

        rpi_before = _rpi_pct(unit_net, cust_avg, ctry_avg, qty, ctry_qty, cust_qty) if unit_net else None
        # An item ADDED to a quote the customer has already approved. The rest of
        # the quote is frozen at prices he has seen, so this one line is the whole
        # negotiation, and it is priced on what HE has a reference for — nothing
        # else (Laith, 2026-09-28, W261999073E: "if it has customer relevancy then
        # apply max 6% RPI, if not it's okay to go up as long as we meet our E2E,
        # no need to check previous year prices from the ledger sheets").
        #
        # So the country average is NOT a reference here. Measuring a customer who
        # bought none of this against the Gulf's prior-year mean is the no-history
        # trap that read 36% RPI on W262223256E without anyone raising a price.
        rev_new = bool(carry) and carried is None
        rev_ref = book_price or cust_avg              # his own price, or nothing
        if carried is not None:
            rpi_floor, rpi_mode = None, f"held from {carry_label}"
        elif rev_new:
            if rev_ref:
                rpi_floor = rev_ref * (1 + rate)
                rpi_mode = (f"new on this revision, capped at {rate:.1%} over "
                            + (f"the fixed-price book {book_price:,.4f}" if book_price
                               else f"last year on this customer {cust_avg:,.4f}"))
            else:
                rpi_floor = None
                rpi_mode = ("new on this revision and the customer has no price of his "
                            "own for it - target E2E only, no RPI")
        elif book_price:
            # The agreed price plus whatever increase is negotiated for the year —
            # the same shape as the customer-average gate, off a number that is
            # current and agreed rather than last year's mean.
            rpi_floor = book_price * (1 + rate)
            rpi_mode = (f"the fixed-price book x (1 + {rate:.1%}) - "
                        f"{bk['orders']} order(s) at {book_price:,.4f}")
        elif rule == "requested":
            rpi_floor, rpi_mode = _rpi_gate(cust_avg, ctry_avg, qty, ctry_qty, rate)
        else:
            rpi_floor, rpi_mode = _rpi_target(cust_avg, ctry_avg, qty, ctry_qty, cust_qty, rate)
        # Over 5x the regional volume on a line this customer never bought: the
        # model reads RPI 0 at any price, so the floor would only cost price (see
        # FIVEX_COUNTRY_NO_GATE). Standing customer exceptions keep their rate.
        gate_skipped = None
        fivex_ctry = bool(not cust_avg and ctry_avg and ctry_qty and qty / ctry_qty > FIVEX)
        if (FIVEX_COUNTRY_NO_GATE and order_confirmed and rpi_floor is not None and carried is None
                and not rev_new and not book_price and not exc and not cust_avg
                and ctry_avg and ctry_qty and qty / ctry_qty > FIVEX):
            gate_skipped = rpi_floor
            rpi_floor = None
            rpi_mode = (f"no RPI floor: {qty / ctry_qty:.0f}x last year's regional qty "
                        f"({ctry_qty:g}) and no history on this customer - the model reads "
                        f"RPI 0 here at any price; target E2E only")
            flags.append(("info", f"{rpi_mode} (the floor would have been {gate_skipped:,.4f})"))
        elif fivex_ctry and rpi_floor is not None and carried is None and not order_confirmed:
            # Provisional: the model would read RPI 0 here, but the quantity is not
            # confirmed yet, so the floor stays on (W262253147E, 2026-10-01).
            flags.append(("info", f"provisional - {qty / ctry_qty:.0f}x last year's country qty, "
                                  f"so the model reads RPI 0, but the {rate:.1%} RPI is kept "
                                  f"until the order is confirmed (the customer can still cut "
                                  f"the quantity)"))
        elif fivex_ctry and rpi_floor is not None and carried is None and order_confirmed:
            flags.append(("info", f"order confirmed, but the {rate:.1%} RPI is still kept - "
                                  f"dropping it on a 5x line needs the 'fivex_country_no_gate' "
                                  f"rule approved in the rule table"))
        raised = False
        # The gate is applied PER LINE against this customer's own last-year
        # price, even when the ledger's Total RPI already clears the rate. The
        # 2026-09-10 carve-out that let such a line pass was reversed by Dalia on
        # 2026-09-15 (Khimji W262144615E): "the customer doesn't see the ledger,
        # he sees his own reference" — he reviews line by line, and a line at
        # last year's price becomes his argument for every other line. Sales'
        # requested discount is often exactly last year's price. Laith's call.
        if rpi_floor is not None and unit_net is not None and rpi_floor > unit_net + 1e-6:
            unit_net = rpi_floor
            add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
            binds = f"RPI {exc['rate']:.1%} floor" if exc else f"RPI {half} floor"
            raised = True
        # On an added line the rate is a CEILING as well as a floor: the line lands
        # ON the customer's reference + the rate, so a request that runs past it
        # comes back down. Everywhere else the rate only ever lifts a price.
        elif (rev_new and rpi_floor is not None and unit_net is not None
                and unit_net > rpi_floor + 1e-6):
            was = unit_net
            unit_net = rpi_floor
            add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
            binds = f"RPI {rate:.1%} cap on an added line"
            flags.append(("verify", f"added line asked {was:,.4f}, more than {rate:.1%} over the "
                                    f"customer's own {rev_ref:,.4f} - brought down to {unit_net:,.4f}"))

        # ── the approver's rework ────────────────────────────────────────────
        # Same two branches as the solve (see _rework_prices), applied here so the
        # E2E floor below, the flags and the carry all still run over the result.
        # This SETS the price rather than lifting it: bringing the reading down is
        # the whole point, so a line above its branch comes down to it.
        reworked = None
        if rework and rework.get("applied") and carried is None and unit_net is not None:
            if book_price:
                reworked = max(book_price * (1 + rate), book_price)
            elif cust_avg:
                reworked = cust_avg * (1 + rate)
            elif ctry_avg:
                reworked = ctry_avg * (1 + rework["country_rate"])
            if reworked is not None:
                unit_net = reworked
                add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
                binds = (f"reworked to {rework['target']:.1%} RPI - "
                         + ("the fixed-price book" if book_price else
                            "last year on this customer" if cust_avg else
                            "the ledger average"))
                raised = False

        # ── the E2E floor ────────────────────────────────────────────────────
        # The requested rule alone will price a line at cost — EFM-APS100 on
        # W262223256E came out at 80.00 against a 79.63 cost, an E2E of 0.5%, and
        # "we cannot release any item with the cost price" (Dalia, 2026-09-08).
        # So the group's target E2E is a FLOOR again, as it was under the 'e2e'
        # rule: the target is what the line is priced at, and the 35-37% band she
        # will accept is a CONCESSION for the approval mail, never where the engine
        # lands on its own (Laith, 2026-09-08: "ideally it's 40").
        #
        # The carve-out is hers: "except if we have any customer reference last
        # year" — a real PY CUSTOMER AVERAGE (ledger W, off 'PV 2025 ') means this
        # customer has already paid a price for this material, and that history
        # outranks the target. The COUNTRY average (Y) does not: every line on
        # W262223256E has one, and all three of her comments are on lines that do.
        # Carried revision lines keep their approved price, same as the RPI floor.
        #
        # A FIXED-PRICE BOOK ENTRY IS A CUSTOMER REFERENCE and takes the same
        # carve-out: raising a line above the price the customer is already
        # invoiced at, to chase a margin target, is reopening the agreement from
        # our side. The hard floor below still holds it at the agreed price.
        #
        # An ADDED line is the exception to the carve-out: there the target E2E
        # overrides the customer reference outright. It is one new line on a quote
        # whose every other price is frozen, so if the margin cannot be held the
        # approver would rather see it and send it back than have the engine give
        # it away (Laith, 2026-09-28: "let E2E override, if it was too much Kiran
        # will send it back").
        e2e_floor = None
        if (carried is None and unit_std
                and (rev_new or (not cust_avg and not book_price))
                and net_at_tgt is not None and qty):
            e2e_floor = net_at_tgt / qty
        if e2e_floor is not None and unit_net is not None and e2e_floor > unit_net + 1e-6:
            # Say it when the target has just overridden the customer's own
            # reference: it is the one place an added line goes past the RPI rate,
            # and it is what the approver is being asked to accept.
            if rev_new and rev_ref:
                over = e2e_floor / rev_ref - 1
                flags.append(("action",
                              f"added line: the {tgt_e2e:.0%} target E2E needs {e2e_floor:,.4f}, "
                              f"{over:.1%} over the customer's own {rev_ref:,.4f} - past the "
                              f"{rate:.1%} cap, so the approver decides"))
            unit_net = e2e_floor
            add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
            binds = f"target E2E {tgt_e2e:.0%} floor"
            floored = True
        else:
            floored = False

        # ── THE GUARD: never under a price they have already paid ────────────
        # Last, so it survives the rule, the RPI gate, the E2E floor and an
        # approver's rework alike. A carried line is exempt: that price was
        # quoted to this customer and accepted, and the carry rule owns it.
        book_guard = False
        if book_price and carried is None and unit_net is not None and unit_net < book_price - 1e-6:
            unit_net = book_price
            add_disc = (1 - unit_net / unit_std) if unit_std else add_disc
            binds = "the fixed-price book"
            book_guard = True

        rpi_after = _rpi_pct(unit_net, cust_avg, ctry_avg, qty, ctry_qty, cust_qty) if unit_net else None
        total_net = unit_net * qty if unit_net is not None else None
        e2e = (1 - total_cost / total_net) if (total_cost is not None and total_net) else None

        # The ledger shows RPI% and Total RPI% side by side and they are not the
        # same number: RPI% is this customer's own price variance, Total RPI%
        # adds the mix against the ledger average. Both are needed here — the
        # two cases Dalia described are exactly the two ways they disagree.
        var_line = {"qty": qty, "ctry_qty": ctry_qty, "cust_avg": cust_avg,
                    "cust_qty": cust_qty, "ctry_avg": ctry_avg}
        pv_value, ae_value = _line_variance(var_line, unit_net)
        pv_pct = (pv_value / (total_net - pv_value)
                  if total_net and abs(total_net - pv_value) > EPS else None)

        # The cheaper identical equivalent, if this part also ships under another
        # brand letter. Suggestion only — see _cheaper_equivalent.
        cheaper = _cheaper_equivalent(mat, listp, t, ref["trig"], _to_deal)

        # What the line would be worth at each rung of the band Dalia will accept,
        # so the approval mail can offer a concession without anyone reopening the
        # model. Only meaningful where the target floor is what set the price.
        band = None
        if floored and cost is not None and tgt_e2e:
            band = {f"{r:.0%}": round(cost / (1 - r), 4)
                    for r in E2E_CONCESSION if r < tgt_e2e - 1e-9}

        # ── flags: what a human should still look at ─────────────────────────
        if not listp:
            flags.append(("action", "no list price - not on the transaction, and the material "
                                    "is in none of the master's books; cannot price"))
        elif list_src == "trigger":
            # The material matched exactly, so this is the price book being read,
            # not a substitution — it is noted, not queried. Say whether it
            # REPLACED a stale number off CPQ or filled a blank, because those read
            # very differently against the transaction the customer has seen.
            if txn_list and abs(txn_list - listp) > 0.005:
                flags.append(("info",
                              f"list price updated to {listp:,.4f} from the Trigger sheet - "
                              f"the transaction carried {txn_list:,.4f} "
                              f"({listp / txn_list - 1:+.1%}), an older price book"))
            elif not txn_list:
                flags.append(("info", f"list price {listp:,.4f} from the Trigger sheet - the "
                                      + ("transaction priced it at 0"
                                         if list_zero else "transaction carried none")))
        elif list_src == "twin":
            flags.append(("action",
                          f"list price {listp:,.4f} borrowed from {twin['material']} - this "
                          f"material's own Trigger row carries no list (discontinued), and "
                          f"that entry is the same description at the same cost - confirm"))
        elif list_src == "guidance":
            flags.append(("action",
                          f"list price {listp:,.4f} from the Guidance sheet"
                          + (f" ({grec['country']})" if grec.get("country") else "")
                          # No ';' in a flag — flags are joined with '; '.
                          + " - the previous list, not the 2026 Q2 one, and the Trigger "
                            "sheet has nothing for this material - confirm"))
        if tgt_e2e is None and ln["group"]:
            flags.append(("verify", f"pricing group '{ln['group']}' is not in E2E Guidelines"))
        if ln.get("std_zero"):
            flags.append(("action", f"customer condition reads 0 on the transaction, so the "
                                    f"standard price is the full list and this line shows a "
                                    f"{add_disc:.0%} additional discount - if the price book "
                                    f"simply did not load it should be {STD_DISCOUNT:.0%}, "
                                    f"confirm before sending"))
        if listp and total_cost is None:
            # No cost anywhere means no margin on this line, so it cannot be part
            # of an E2E the approver reads. The AUG 2026 cut of 'Fire Trigger 26'
            # dropped its cost column, so a FIRE line whose CPQ export carries no
            # cost has nothing left to fall back on — the model is blind here too,
            # and the engine says so rather than reporting a margin it cannot see.
            flags.append(("verify", "no cost - not on the transaction and the Trigger sheet "
                                    "has none for this material, so this line carries no E2E"))
        if bk:
            paid = ", ".join(p["transaction"] for p in bk["paid"][:4])
            more = f" +{bk['orders'] - 4} more" if bk["orders"] > 4 else ""
            flags.append(("action" if book_guard else "info",
                          (f"HELD at the agreed price {book_price:,.4f} - the rule priced it "
                           f"under a price this customer has already paid. "
                           if book_guard else
                           f"agreed price {book_price:,.4f} in the customer's own book. ")
                          + f"Paid on {bk['orders']} order(s) this year ({paid}{more})"
                          + ("" if bk["firm"] else
                             f" - and NOT at one price: {bk['low']:,.4f} to {bk['high']:,.4f}, "
                             f"so the latest is used and the agreed number needs confirming")
                          + (". The ledger reads no customer history for it - 'PV 2025 ' is "
                             "last year, so its whole price lands in mix variance"
                             if not cust_avg else "")))
        if reworked is not None:
            # An approver moved this price, so every one of these lines is a
            # decision somebody has to own — say what it was measured against and
            # what it does to the price the customer has already been shown.
            was = rpi_before
            flags.append(("info" if cust_avg else "verify",
                          f"reworked to hold the case at {rework['target']:.1%} RPI: "
                          + (f"last year on this customer {cust_avg:,.4f} + {rate:.1%}"
                             if cust_avg else
                             f"the {ctry_avg:,.4f} ledger average "
                             f"{rework['country_rate']:+.1%}")
                          + (f", {reworked / ln['requested'] - 1:+.1%} on what was requested"
                             if ln.get("requested") else "")
                          + (f" - it read {was:.1%} as priced" if was is not None else "")))
        if raised:
            flags.append(("action" if exc else "info",
                          f"raised to last year's price + {exc['rate']:.1%} ({rpi_mode}) - "
                          f"the {exc['label']} rate, which needs approving"
                          if exc else f"raised to the {half} RPI floor ({rpi_mode})"
                          # Say when what was asked read NEGATIVE — the reason it
                          # could not pass as requested (Dalia's 45.77% Universal line).
                          + (f" - the requested price read total RPI {rpi_before:.1%}"
                             if rpi_before is not None and rpi_before < -EPS else "")))
        if floored:
            asked = (f"{ln['requested']:,.4f}" if ln["requested"] is not None else
                     f"{req_disc:.1%} off" if req_disc is not None else "nothing")
            flags.append(("action",
                          f"raised to the {tgt_e2e:.0%} target E2E - the customer asked {asked}"
                          + (" - concede no further than "
                             + ", ".join(f"{k} = {v:,.4f}" for k, v in band.items())
                             if band else "")))
        if rpi_mode and rpi_floor is None and (cust_avg or ctry_avg):
            flags.append(("info", rpi_mode))
        # A prior-year reference that sits BELOW today's cost cannot be priced to
        # — the gate would sell the line at a loss — and every cent of the gap
        # lands in mix variance, so one such line can carry a whole quote's RPI.
        # EFM-APS100 on W262223256E: 62.13 average, 79.63 cost, and its 5,999.23
        # is 69% of that case's 8,683.38. It is not a price rise anyone decided.
        if ctry_avg and not cust_avg and cost and ctry_avg * (1 + rate) < cost:
            flags.append(("verify",
                          f"last year's average {ctry_avg:,.2f} is BELOW today's cost "
                          f"{cost:,.2f} - the material was repriced, so the gate cannot be "
                          f"met at any margin and this line's RPI is a comparison to the "
                          f"prior-year Gulf average, not an increase to this customer"))
        # The mirror of the case above: this customer pays well over their own
        # last-year price, but the mix against the ledger average drags the total
        # negative. Nothing to chase — if the margin is right it goes for approval
        # as it stands. These are usually service-level lines that come out of the
        # calculation altogether, and about nine in ten of them are CBS, not Fire
        # (Dalia, on the call 2026-09-10).
        # `>=`, not `>`: since 2026-09-15 the gate lands these lines at EXACTLY the
        # rate on the customer, and a strict test let every one of them through
        # unflagged (Khimji: five lines at +6.0% customer, -5% to -17% total).
        if (pv_pct is not None and pv_pct >= rate - EPS
                and rpi_after is not None and rpi_after < -EPS):
            flags.append(("action",
                          f"price variance {pv_pct:.1%} on this customer but total RPI "
                          f"{rpi_after:.1%} - the mix against the ledger average is what "
                          f"is negative. If the margin is right this goes for approval as "
                          f"it stands; check first whether it is a service-level line that "
                          f"belongs outside the calculation"))
        # NEGATIVE RPI ON THE CUSTOMER — the price is under what this customer paid
        # last year. Dalia, 2026-09-15: "I absolutely can't give the customer last
        # year's price", let alone less. The gate prevents it on a priced line, so
        # it can only arrive two ways, and both are said out loud:
        #  * a CARRIED price (revision or customer history) — never gated, and an
        #    approved offer older than the PY data can sit under it;
        #  * anything else is a line the gate could not lift (safety net).
        if cust_avg and unit_net is not None and unit_net < cust_avg - 1e-6:
            neg = unit_net / cust_avg - 1
            if carried is not None:
                flags.append(("action",
                              f"held from {carry_label} at {unit_net:,.4f}, which is {neg:.1%} "
                              f"under this customer's own last-year price {cust_avg:,.4f} - "
                              f"negative RPI on the customer; confirm the carried price or "
                              f"raise it to last year + {rate:.1%} ({cust_avg * (1 + rate):,.4f})"))
            else:
                flags.append(("action",
                              f"priced {neg:.1%} under this customer's own last-year price "
                              f"{cust_avg:,.4f} - negative RPI on the customer, which must not "
                              f"go out as it stands"))
        if cheaper:
            flags.append(("verify",
                          f"{cheaper['material']} is the same part at "
                          f"{cheaper['list']:,.2f} against {listp:,.2f}"
                          + (f" ({cheaper['brand']})" if cheaper["brand"] else "")
                          + " - the cheaper equivalent, if the customer will take it"))
        if cust_avg and not ctry_avg:
            flags.append(("verify", "customer average only - no ledger reference, RPI reads 0"))
        if not cust_avg and not ctry_avg:
            flags.append(("verify", "no prior-year reference - new item, negotiation room "
                                    "(the analyst usually caps these near 20%)"))
        if e2e is not None and tgt_e2e and e2e < tgt_e2e - 1e-6:
            if carried is not None:
                # Held from the previous revision, so this margin was signed off
                # once already — flagging it again sends the analyst back to an
                # approver who has nothing new to decide.
                flags.append(("info", f"margin {e2e:.0%} against a {tgt_e2e:.0%} target - "
                                      f"held from {carry_label}, already approved"))
            else:
                # Under the 'requested' rule this is the expected outcome, not a
                # pricing error — but it is the margin somebody has to sign off.
                flags.append(("action",
                              f"margin {e2e:.0%} against a {tgt_e2e:.0%} target - needs approval"
                              if rule == "requested" else
                              f"below target E2E ({e2e:.0%} < {tgt_e2e:.0%})"))
        # Ask, never decide: a price nobody could have meant goes to the analyst.
        line_rpi = (ae_value / (total_net - ae_value)
                    if total_net and abs(total_net - ae_value) > EPS else None)
        suspect = None
        if typo and not typo["kept"]:
            suspect = (f"requested {typo['requested']:,.2f} is {typo['ratio']:.1f}x the "
                       f"{typo['unit_std']:,.2f} standard price - looks like a typo by sales, "
                       f"so it was NOT copied: priced on target E2E + RPI gate instead. "
                       f"Confirm with sales; tick 'real' to price it as requested")
        elif typo:
            flags.append(("verify", f"requested {typo['requested']:,.2f} is {typo['ratio']:.1f}x "
                                    f"the standard price - confirmed real, priced as requested"))
        elif line_rpi is not None and line_rpi > TYPO_LINE_RPI and carried is None:
            suspect = (f"this line's Total RPI is {line_rpi:.0%} - check the requested price, "
                       f"qty and reference for a typo before it goes out")
        if suspect:
            flags.append(("action", "ASK: " + suspect))

        if req_disc is not None and req_disc > ADD_DISC_CAP + EPS:
            flags.append(("info",
                          f"requested {req_disc:.1%} is over the {ADD_DISC_CAP:.0%} guideline "
                          f"- applied as requested"
                          if rule == "requested" else
                          f"requested {req_disc:.1%} flattened to the {ADD_DISC_CAP:.0%} cap"))

        sev = ("action" if any(f[0] == "action" for f in flags) else
               "verify" if any(f[0] == "verify" for f in flags) else
               "info" if flags else "ok")

        out.append({
            "material": mat, "description": ln["description"], "group": ln["group"],
            "qty": qty, "list": listp, "list_src": list_src, "std_disc": std, "unit_std": unit_std,
            "total_std": total_std, "cost": cost, "total_cost": total_cost,
            "target_e2e": tgt_e2e, "net_at_target": net_at_tgt, "disc_at_target": disc_at_tgt,
            "requested": ln["requested"], "req_disc": req_disc,
            "typo": typo, "suspect": suspect, "line_rpi": line_rpi,
            "cust_avg": cust_avg, "cust_qty": cust_qty,
            "ctry_avg": ctry_avg, "ctry_qty": ctry_qty,
            "rpi_floor": rpi_floor, "rpi_before": rpi_before, "rpi_after": rpi_after,
            # This line's own AE contribution, so the tab and the log can name the
            # lines a headline RPI actually came from instead of quoting a total.
            "rpi_value": round(ae_value, 2),
            # This customer's own price variance, beside the total that includes
            # mix — the ledger's RPI% and Total RPI% columns.
            "pv_value": round(pv_value, 2), "pv_pct": pv_pct,
            "cheaper_equiv": cheaper,
            "ref_below_cost": bool(ctry_avg and not cust_avg and cost
                                   and ctry_avg * (1 + rate) < cost),
            "txn_list": txn_list,
            "e2e_floor": e2e_floor, "floored": floored, "e2e_band": band,
            # What the approver's rework set this line to, before the E2E floor
            # had its say — None on a case nobody reworked.
            "reworked": reworked,
            # The customer's own agreed price, how many orders it was invoiced on
            # this year, whether every one of them was at the same number, and
            # whether the guard had to hold the line there.
            "book_price": book_price,
            "book_orders": bk["orders"] if bk else None,
            "book_firm": bk["firm"] if bk else None,
            "book_guard": book_guard,
            "add_disc": add_disc, "unit_net": unit_net, "total_net": total_net,
            "e2e": e2e, "binds": binds, "raised": raised, "severity": sev,
            "carried": carried is not None,
            "approval_add": ln.get("approval_add"),
            "provisional_5x": bool(fivex_ctry and rpi_floor is not None and carried is None
                                   and not order_confirmed),
            "flags": "; ".join(t for _, t in flags),
        })

    grand = sum(l["total_net"] or 0 for l in out)
    std_tot = sum(l["total_std"] or 0 for l in out)
    # A line with no cost has an UNKNOWN margin, not a 100% one. Summing the
    # missing cost as zero is what made W262242719E read "E2E 100.0% - no line
    # needs a decision" (2026-09-21): a FIRE stock order whose CPQ document was
    # saved with nothing but Requested Prices - List Price 0, Customer Condition
    # blank, Cost blank on every line, the same through the spreadsheet export
    # and the REST fetch, so it is the document that was never priced in CPQ and
    # not the export that failed. The list was rescued from the Trigger sheet;
    # the cost cannot be, because 'Fire Trigger 26' carries no cost column at
    # all. So every E2E here is measured over the lines that carry a cost, and
    # how much of the quote that is comes out beside it.
    costed = [l for l in out if l["total_cost"] is not None]
    cost_tot = sum(l["total_cost"] for l in costed)
    cost_net = sum(l["total_net"] or 0 for l in costed)
    # Two RPI readings, because the model shows two and they are not the same:
    #   ledger K6 "Overall RPI" = AG11/(T11-AG11) — PRICE variance only, so it
    #     reads 0 when no line has a customer prior-year average;
    #   "Total RPI" = AE-based, price + mix variance — the number the procedure's
    #     6% gate is quoted against.
    ag, ae = _variance(out, "unit_net")

    # The approval mail quotes TWO stages, and they are different numbers:
    #   "Target Price"  = what the customer asked for (the requested prices), and
    #                     the E2E / RPI that price would land — the RPI is usually
    #                     NEGATIVE, which is the whole reason for the ask;
    #   "Proposed Price"= after the RPI gate lifted the lines. Everything in the
    #                     mail's table is this stage, broken out per pricing group.
    tgt_total = sum((l["requested"] if l["requested"] is not None else l["unit_net"] or 0)
                    * (l["qty"] or 0) for l in out)
    tgt_ag, tgt_ae = _variance(out, "requested")
    # Same stage, same costed lines, so the mail's two E2E readings compare.
    tgt_costed = sum((l["requested"] if l["requested"] is not None else l["unit_net"] or 0)
                     * (l["qty"] or 0) for l in costed)
    at_target = {
        "target_price": round(tgt_total, 2),
        "e2e": round(1 - cost_tot / tgt_costed, 4) if tgt_costed else None,
        # Same basis as the ledger's AF11 — see total_rpi below.
        "rpi_pct": round(tgt_ae / (tgt_total - tgt_ag), 4) if abs(tgt_total - tgt_ag) > EPS else None,
        "rpi_value": round(tgt_ae, 2),
        "pv_value": round(tgt_ag, 2),
    }

    # Only a line priced ON THIS revision can need an approval. A carried line's
    # margin was approved when it was set, whatever the quantity does to it now.
    below = [l for l in out if l["e2e"] is not None and l["target_e2e"]
             and l["e2e"] < l["target_e2e"] - 1e-6 and not l["carried"]]
    floored_lines = [l for l in out if l.get("floored")]
    # The target the approval ask is quoted against — the sub-target lines' when
    # there are any, otherwise the target the floor had to lift lines up to.
    tgts = [l["target_e2e"] for l in (below or floored_lines) if l["target_e2e"]]
    # The LOWEST target among the lines the floor lifted: a concession rung has to
    # clear the strictest of them to be a concession at all.
    floored_tgts = [l["target_e2e"] for l in floored_lines if l["target_e2e"]]
    summary = {
        "lines": len(out),
        "rule": rule,
        "half": half,
        "rpi_rate": rate,          # the mail quotes it: "increased prices by 6% on LY price"
        # Set when a standing customer exception replaced the half-year rate, so
        # the tab and the approval mail can say WHY the number is not 3.5%/6%.
        "rpi_exception": ({"label": exc["label"], "rate": exc["rate"],
                           "why": exc["why"], "standard": RPI_RATE[half]}
                          if exc else None),
        # How far the quote sits under target, for the approval ask.
        "below_target": len(below),
        "target_e2e": round(max(tgts), 4) if tgts else None,
        # Lines the target-E2E floor lifted off the customer's own ask. These are
        # the approval ask now: the margin is fine, the PRICE is above what the
        # customer requested, and the concession band is what Kiran signs off.
        "floored": len(floored_lines),
        "floored_value": round(sum((l["unit_net"] - (l["requested"] if l["requested"] is not None
                                                     else l["unit_net"])) * (l["qty"] or 0)
                                   for l in floored_lines), 2),
        # Only the rungs that are a concession for EVERY floored line. The rungs
        # are absolute and Dalia named them against Addressable's 40% target, so
        # on a quote whose floored lines are Notification-UL (target 35%) there
        # is nothing to offer and the mail must say "needs approval" rather than
        # invite Kiran down to a 37% that is above the target he is approving.
        "e2e_concession": [r for r in E2E_CONCESSION
                           if floored_tgts and r < min(floored_tgts) - EPS],
        "grand_total": round(grand, 2),
        "total_standard": round(std_tot, 2),
        "overall_add_disc": round(1 - grand / std_tot, 4) if std_tot else None,
        "overall_e2e": round(1 - cost_tot / cost_net, 4) if cost_net else None,
        # Lines carrying no cost at all, and the share of the quote's money the
        # E2E above is measured over. cost_missing == lines means this case has
        # NO margin reading: the transaction has to come back from CPQ priced.
        "cost_missing": len(out) - len(costed),
        "cost_cover": round(cost_net / grand, 4) if grand else None,
        "overall_rpi": round(ag / (grand - ag), 4) if abs(grand - ag) > EPS else None,
        # The ledger's totals row is NOT the per-line formula summed: AF11 is
        # =AE11/(T11-AG11) — Total RPI value over (Total Net - RPI VALUE), where
        # a line's AF13 is AE13/(T13-AE13). Read off the master 2026-09-16 (and
        # on Dalia's R2 screen as AG11/(V11-AI11), two columns inserted).
        "total_rpi": round(ae / (grand - ag), 4) if abs(grand - ag) > EPS else None,
        # The level a normal case is worked to so the yearly average survives the
        # approver's exceptions. None under a customer exception — its rate is agreed.
        "rpi_working_level": None if exc else RPI_WORKING_LEVEL,
        # The two variance VALUES behind those percentages. The daily register
        # asks for "RPI Value" in money, not just the ratio, so carry both out
        # rather than making the caller re-derive them from the lines.
        "pv_value": round(ag, 2),
        "rpi_value": round(ae, 2),
        # WHERE the RPI came from. A total on its own is unreadable: a quote to a
        # customer with no history measures every line against the Gulf's
        # prior-year average, and one repriced material can carry the whole
        # number. `no_history` is the share of AE from lines this customer has
        # never bought; `drivers` names the biggest contributors.
        "rpi_no_history": round(sum(l["rpi_value"] for l in out if not l["cust_avg"]), 2),
        "rpi_below_cost": round(sum(l["rpi_value"] for l in out if l["ref_below_cost"]), 2),
        "rpi_drivers": [{"material": l["material"], "rpi_value": l["rpi_value"],
                         "share": round(l["rpi_value"] / ae, 4) if ae else None,
                         "ctry_avg": l["ctry_avg"], "cost": l["cost"],
                         "unit_net": l["unit_net"], "ref_below_cost": l["ref_below_cost"],
                         # A repriced material's RPI is arithmetic, not a decision.
                         # It only needs a warning when the MARGIN is also wrong —
                         # "leave it as long as margin is okay" (Dalia, 2026-09-10).
                         "margin_ok": bool(l["e2e"] is not None and l["target_e2e"]
                                           and l["e2e"] >= l["target_e2e"] - 1e-6)}
                        for l in sorted(out, key=lambda x: -abs(x["rpi_value"] or 0))[:3]
                        if l["rpi_value"]],
        # All three readings at the proposed price, because an approver's target
        # names one of them and `total_rpi` above is only the ledger's.
        "rpi_readings": {k: (round(v, 4) if isinstance(v, float) and k in RPI_BASES
                             else round(v, 2) if isinstance(v, float) else v)
                         for k, v in _rpi_readings(out, "unit_net").items()},
        # The customer's own fixed-price book, when this customer has one.
        # `rpi_vs_book` is the increase measured against what they have ACTUALLY
        # PAID this year, over the lines the book covers — the honest answer to
        # "what did you put this customer's prices up by", and usually nothing
        # like the ledger's RPI, which measures 2026 agreed prices against 2025
        # averages the customer never saw.
        "book": ({"path": os.path.basename(book["path"]),
                  "orders": len(book["orders"]), "materials": len(book["prices"]),
                  "lines": sum(1 for l in out if l.get("book_price")),
                  "held": sum(1 for l in out if l.get("book_guard")),
                  "unpriced_history": sum(1 for l in out
                                          if l.get("book_price") and not l["cust_avg"]),
                  "not_firm": sum(1 for l in out if l.get("book_orders")
                                  and not l.get("book_firm")),
                  "rpi_vs_book": _book_rpi(out)}
                 if book else None),
        "book_error": book_err,
        # Set only when the case was reworked to an approver's ceiling.
        "rework": ({k: v for k, v in rework.items() if not k.startswith("_")}
                   if rework else None),
        "reworked": sum(1 for l in out if l.get("reworked") is not None),
        # Everything the approval mail needs, in its own shape.
        "at_target": at_target,
        "groups": _by_group(out),
        "carried": sum(1 for l in out if str(l["binds"]).startswith("held from")),
        "raised": sum(1 for l in out if l["raised"]),
        "action": sum(1 for l in out if l["severity"] == "action"),
        # Lines the engine will not decide alone — a requested price that reads
        # like a typo, or a line RPI no approver would sign. The tab asks.
        "suspect": [{"material": l["material"], "description": l["description"],
                     "qty": l["qty"], "requested": l["requested"], "unit_std": l["unit_std"],
                     "unit_net": l["unit_net"], "line_rpi": l["line_rpi"],
                     "typo": bool(l["typo"]), "why": l["suspect"]}
                    for l in out if l.get("suspect")],
        "typo_kept": [l["material"] for l in out if l.get("typo") and l["typo"]["kept"]],
        # Lines the model CANNOT measure, so their RPI reads 0 whatever the price:
        # more than 5x last year's country qty (the model's own gate), or no
        # prior-year reference at all. W262253147E (2026-10-01) read "total RPI
        # 0.0%" on all three lines while two were priced +6% over last year.
        "rpi_blind": {
            "fivex": [l["material"] for l in out if l["ctry_avg"] and l["ctry_qty"]
                      and not l["cust_avg"] and l["qty"] / l["ctry_qty"] > FIVEX],
            "no_ref": [l["material"] for l in out if not l["cust_avg"] and not l["ctry_avg"]],
        },
        # 5x country-average lines still carrying the RPI because the order is not
        # confirmed - the price comes down once it is (see FIVEX_COUNTRY_NO_GATE).
        "provisional_5x": [l["material"] for l in out if l.get("provisional_5x")],
        "order_confirmed": bool(meta.get("order_confirmed")),
        # Lines CPQ's Approval History asked to add, not on CPQ's own BOM.
        "approval_adds": [l["material"] for l in out if l.get("approval_add")],
        "verify": sum(1 for l in out if l["severity"] == "verify"),
        "no_py": sum(1 for l in out if not l["cust_avg"] and not l["ctry_avg"]),
        "currency": "EUR" if meta.get("aprc") == "525" else "USD",
    }
    return out, summary


# ─── building the case folder (needs Excel) ──────────────────────────────────
def _locked(path):
    """True when `path` exists and something else holds it open for writing —
    on Windows that is Excel, and opening it 'r+b' is what the write will do.
    A file that is not there yet is not locked."""
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r+b"):
            return False
    except OSError:
        return True


def _excel():
    try:
        import win32com.client as w
    except ImportError:
        raise RuntimeError(
            "pywin32 is not installed, so the Working File cannot be written. "
            "Run:  pip install pywin32")
    # DispatchEx, never Dispatch: Dispatch attaches to the Excel the analyst
    # already has open, and then hiding it or closing books fights the human at
    # the keyboard — a visible instance refuses Visible=False outright
    # ("Property 'Excel.Application.Visible' can not be set."). A private
    # instance leaves their session alone.
    try:
        app = w.DispatchEx("Excel.Application")
    except Exception as e:
        raise RuntimeError(f"Excel could not be started ({e}). The Working File is the "
                           f"master model itself, so Excel is required to produce it.")
    for prop, val in (("Visible", False), ("DisplayAlerts", False),
                      ("ScreenUpdating", False), ("AskToUpdateLinks", False)):
        try:
            setattr(app, prop, val)
        except Exception:
            pass                      # cosmetic only; the build still runs
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
    case_dir = case_folder(meta)
    os.makedirs(case_dir, exist_ok=True)
    log(f"Case folder: {case_dir}")

    # A revision keeps the transaction's folder and prefixes its files R1, R2,
    # R3 … — the analyst's own convention, and it keeps every version of a deal
    # in one place instead of scattering near-identical folders.
    rev = str(meta.get("revision") or "").strip().upper()
    if rev and not re.fullmatch(r"R\d+", rev):
        rev = "R" + re.sub(r"\D", "", rev)
    pre = f"{rev} " if rev else ""
    if rev:
        log(f"Revision {rev} — files are written beside the previous version, not "
            f"into a new folder.")

    # 1 ── the transaction, exactly as dropped. The uploader stages it behind a
    # timestamp so two drops of the same export cannot collide; the case folder
    # gets the name CPQ gave it.
    staged = os.path.basename(str(bom_path))
    bom_copy = os.path.join(case_dir, re.sub(r"^\d{10,}__", "", staged))
    if os.path.abspath(bom_copy) != os.path.abspath(str(bom_path)):
        shutil.copy2(str(bom_path), bom_copy)
    log(f"Saved the transaction: {os.path.basename(bom_copy)}")

    tag = meta.get("transaction") or safe_name(meta.get("project") or "case", 40)
    work_path = os.path.join(case_dir, f"{pre}Working File ({safe_name(tag, 60)}).xlsb")
    fb_path = os.path.join(case_dir, f"{pre}Approved Offer - Approved ({safe_name(tag, 60)}).xlsx")
    # Named the way the approver already receives it, so the attachment on the
    # mail looks like every other one he has been sent.
    led_path = os.path.join(
        case_dir, f"{pre}Working file - {safe_name(meta.get('project') or tag, 60)}.xlsm")

    # Every output this build will overwrite, checked BEFORE Excel is opened.
    # The .xlsm ledger is written last, four minutes in, so leaving it to fail on
    # its own PermissionError threw away the whole run — and only the .xlsb was
    # ever guarded. One check, up front, naming everything that is locked.
    locked = [p for p in (work_path, fb_path, led_path,
                          os.path.join(case_dir,
                                       f"{pre}Working File ({safe_name(tag, 60)}) - as pasted.xlsb"))
              if _locked(p)]
    if locked:
        raise RuntimeError(
            "Open in Excel, so this build cannot overwrite "
            + (f"{len(locked)} of its files" if len(locked) > 1 else "it") + ": "
            + ", ".join(os.path.basename(p) for p in locked)
            + ". Close and build again.")

    # 2 ── the Working File: the master model, filled and toggled
    try:
        shutil.copy2(meta["master"], work_path)
    except PermissionError:
        # Almost always the analyst has the previous build open while rebuilding.
        raise RuntimeError(
            f"{os.path.basename(work_path)} is open in Excel — close it and build again.")
    log("Copied the master model → Working File")

    _check_cancel(meta, "before opening Excel")
    app = _excel()
    wb = None
    base_path = None
    try:
        # 2a ── the "as pasted" Working File, on request. The master with nothing in
        # it but the transaction and the header: every ledger column left as its own
        # formula, so Add. Discount is whatever the MODEL derives (R13 = the export's
        # Requested Discount % / 100) and no decision of ours has been written yet.
        # It is a diagnostic — the file as it stands one second after the paste —
        # and it is the only way to tell a model result from an engine result.
        # Written on every build unless the job says otherwise: the question it
        # answers ("is this number the model's or Vector's?") is asked of every
        # case, and it cannot be answered after the fact from the built file
        # alone, because every column in that one has been written over.
        if meta.get("baseline", True):
            base_path = os.path.join(
                case_dir, f"{pre}Working File ({safe_name(tag, 60)}) - as pasted.xlsb")
            base_path = _build_baseline(app, base_path, meta, log)

        wb = app.Workbooks.Open(os.path.abspath(work_path), UpdateLinks=0)
        _repair_macros(wb, log)
        _fill_working(wb, priced, meta, log)
        _check_cancel(meta, "after filling the ledger")

        ledger = wb.Worksheets(LEDGER_SHEET)
        app.CalculateFullRebuild()
        # The summary table is a PivotTable and does not follow a recalculation:
        # without this it shows whatever the template was left holding, minus any
        # pricing group the template had filtered out.
        _refresh_pivots(wb, ledger, log)
        t11 = num(ledger.Range("T11").Value) or 0.0
        v11 = num(ledger.Range("V11").Value)
        k6 = num(ledger.Range("K6").Value)
        k7 = num(ledger.Range("K7").Value)
        log(f"Ledger recalculated — total net {t11:,.2f}, "
            f"overall RPI {('%.2f%%' % (k6 * 100)) if k6 is not None else 'n/a'}, "
            f"overall E2E {('%.2f%%' % (k7 * 100)) if k7 is not None else 'n/a'}")

        # 1 - V11/T11 off the ledger's own totals. Once the decided discount is
        # written, T11 is the PROPOSED price, so this is the mail's "E2E% @
        # Proposed Price" column. The mail's "E2E @ Target Price" is a different
        # number — the customer's requested price, before the RPI gate lifted
        # anything — and comes from summary['at_target'].
        e2e_at_proposed = (1 - v11 / t11) if (v11 is not None and t11) else None
        if e2e_at_proposed is not None:
            log(f"E2E @ Proposed Price {e2e_at_proposed:.2%} — proposed {t11:,.2f}, "
                f"total cost {v11:,.2f} (ledger T11 / V11)")
        else:
            log("Ledger T11/V11 carry no total — E2E not available from the ledger.", "warn")

        # 3 ── the three-way total check (procedure, PART 3)
        fb = wb.Worksheets("Feedback")
        fb_total = num(fb.Range("L10").Value) or 0.0
        checks = {"ledger_T11": round(t11, 2),
                  "feedback_L10": round(fb_total, 2),
                  "python": summary["grand_total"]}
        # What the approval mail quotes, both stages, straight off the ledger for
        # the proposed side so the mail matches the file Kiran opens.
        approval = {"proposed_price": round(t11, 2),
                    "total_cost": round(v11, 2) if v11 is not None else None,
                    "e2e_at_proposed": round(e2e_at_proposed, 4) if e2e_at_proposed is not None else None,
                    "at_target": summary.get("at_target"),
                    "target_e2e": summary.get("target_e2e"),
                    "currency": summary.get("currency")}
        spread = max(checks.values()) - min(checks.values())
        checks["agree"] = spread < 0.05
        if checks["agree"]:
            log(f"Three-way total check PASSED — {t11:,.2f} on all three.")
        else:
            log(f"Three-way total check FAILED — ledger {t11:,.2f}, feedback "
                f"{fb_total:,.2f}, engine {summary['grand_total']:,.2f}.", "warn")

        _check_cancel(meta, "before saving the Working File")
        wb.Save()
        log(f"Saved {os.path.basename(work_path)}")

        # 4 ── the Feedback file: the Feedback sheet, values only
        _export_feedback(app, wb, fb_path, log)

        # 5 ── the ledger on its own, for the approval mail
        _export_ledger(app, wb, led_path, log)
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
            "feedback": fb_path, "ledger": led_path, "checks": checks,
            "approval": approval, "baseline": base_path}


def _build_baseline(app, path, meta, log):
    """The master with the transaction pasted and nothing else — no values written
    over the ledger's formulas, no decided discount.

    This is the file the analyst would see one second after pasting the BOM, and it
    is deliberately NOT corrected: the duplicate-material trap is live (every repeat
    of a material XLOOKUPs the first row's quantity), Add. Discount is whatever the
    model itself reads out of the export's Requested Discount % column, and a
    material the transaction carries no list price for shows the model's own
    #DIV/0!. Comparing it with the built Working File is how you tell which numbers
    the model produced and which ones Vector decided."""
    try:
        shutil.copy2(meta["master"], path)
    except PermissionError:
        log(f"{os.path.basename(path)} is open in Excel — skipped the as-pasted copy.", "warn")
        return None
    wb = None
    try:
        wb = app.Workbooks.Open(os.path.abspath(path), UpdateLinks=0)
        _repair_macros(wb, log)
        _paste_bom(wb, meta)
        _set_header(wb, meta, log)
        app.CalculateFullRebuild()
        led = wb.Worksheets(LEDGER_SHEET)
        _refresh_pivots(wb, led, log)
        t11 = num(led.Range("T11").Value) or 0.0
        log(f"Wrote {os.path.basename(path)} — the model on its own, before any "
            f"decision: total net {t11:,.2f}")
        wb.Save()
    except Exception as e:
        log(f"Could not write the as-pasted copy: {e}", "warn")
        path = None
    finally:
        try:
            if wb is not None:
                wb.Close(SaveChanges=False)
        except Exception:
            pass
    return path


def _repair_macros(wb, log):
    """The model's own buttons, rewritten against the names the workbook holds
    now (lsd_macros.py). The master is already patched; this keeps a build right
    when someone drops in an unpatched master. A blocked VBA project only costs
    the buttons, never the build."""
    try:
        import lsd_macros
        lsd_macros.install(wb, LEDGER_SHEET, log)
    except Exception as e:
        log(f"Could not repair the model's macro buttons ({e}) — the file is fine, "
            f"but its Working File / Offer Letter icons may error.", "warn")


def _paste_bom(wb, meta):
    """The transaction into 'Paste BOM Here', verbatim, header row included."""
    paste = wb.Worksheets("Paste BOM Here")
    paste.Cells.ClearContents()
    rows = meta["_bom_rows"]
    header = meta["_bom_header"]
    width = max(len(header), max((len(r) for r in rows), default=0), 40)
    block = [[_com_value(header[i] if i < len(header) else None) for i in range(width)]]
    for r in rows:
        block.append([_com_value(r[i] if i < len(r) else None) for i in range(width)])
    paste.Range(paste.Cells(1, 1), paste.Cells(len(block), width)).Value = block
    return len(rows)


def _set_header(wb, meta, log):
    """Customer / ledger / project / transaction / CRM and the APRC toggle."""
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


def _fill_working(wb, priced, meta, log):
    """Paste the transaction, set the header, toggle APRC, and write the decision.

    Source columns (SAP, qty, list, std disc, cost, requested + add. discount) are
    written as VALUES row by row — that is the procedure's own fix for the
    duplicate-material trap, where the ledger's XLOOKUPs give every repeat of a
    material the FIRST row's quantity. Every derived column is left as a live
    formula so the file still shows its work."""
    n_rows = _paste_bom(wb, meta)
    log(f"Pasted the transaction into 'Paste BOM Here' ({n_rows} rows)")
    _set_header(wb, meta, log)
    led = wb.Worksheets(LEDGER_SHEET)

    # Per-row values over the XLOOKUP columns + the decision in Q and R.
    n = len(priced)
    b = [[_com_value(l["material"])] for l in priced]
    h = [[_com_value(l["qty"])] for l in priced]
    i_ = [[_com_value(l["list"])] for l in priced]
    j = [[_com_value(l["std_disc"])] for l in priced]
    u = [[_com_value(l["cost"])] for l in priced]
    # A typo request priced as nothing-asked still shows what sales typed, so the
    # file carries the reason the line was not priced on it.
    q = [[_com_value(l["req_disc"] if not l.get("typo")
                     else 1 - l["typo"]["requested"] / l["typo"]["unit_std"])] for l in priced]
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

    # The Working File goes out unmarked (Laith, 2026-09-16). The lines an
    # approver has to look at are still carried by `severity` — the LSD tab
    # flags them and the approval mail is still drafted from them — so only the
    # fill is gone, not the decision itself.
    flagged = sum(1 for l in priced if l["severity"] in ("action", "verify"))
    if flagged:
        log(f"{flagged} line(s) need a human decision (not highlighted in the file)")


class Cancelled(Exception):
    """The user pressed Cancel."""


def _check_cancel(meta, where=""):
    """Cooperative cancellation.

    The caller drops a flag file when the user hits Cancel. Killing the process
    instead would leave the Excel instance this run started alive and invisible —
    with the master model open — so the run stops at a checkpoint and unwinds
    through its own `finally`, closing Excel behind it."""
    flag = meta.get("cancel_file") if isinstance(meta, dict) else None
    if flag and os.path.exists(flag):
        raise Cancelled(f"Cancelled{(' at ' + where) if where else ''}.")


def case_folder(meta):
    """Where this transaction's case lives. A revision does NOT get its own
    folder — the analyst keeps one folder per transaction and prefixes the files
    R1, R2, R3 …, so a revision lands beside the version it supersedes."""
    name = safe_name(f"{meta['transaction']} - {meta['project']}"
                     if meta.get("transaction") and meta.get("project")
                     else (meta.get("transaction") or meta.get("project") or "case"))
    return os.path.join(meta["cases_root"], name)


def revision_diff(lines, prior, label, log):
    """What actually changed between the previous revision and this one.

    This is the first question on a revision and nobody should have to answer it
    by opening two workbooks side by side: which lines only moved quantity (the
    price is carried, so nothing to decide), which are NEW (priced by the rule,
    and the only lines that can move the margin), and which the customer dropped.
    """
    cur = {}
    for ln in lines:
        mat = str(ln["material"] or "").strip()
        if not mat:
            continue
        e = cur.setdefault(mat, {"qty": 0.0, "description": ln["description"]})
        e["qty"] += ln["qty"] or 0.0

    same, changed, added = [], [], []
    for mat, e in cur.items():
        was = prior.get(mat)
        if not was:
            added.append({"material": mat, "description": e["description"], "qty": e["qty"]})
        elif abs((was.get("qty") or 0) - e["qty"]) > 1e-9:
            changed.append({"material": mat, "description": e["description"],
                            "old_qty": was.get("qty"), "new_qty": e["qty"],
                            "delta": e["qty"] - (was.get("qty") or 0),
                            "unit_net": was.get("net")})
        else:
            same.append(mat)
    removed = [{"material": m, "qty": (v.get("qty") or 0), "unit_net": v.get("net")}
               for m, v in prior.items() if m not in cur]

    diff = {"prior": label, "prior_lines": len(prior), "lines": len(cur),
            "unchanged": len(same), "qty_changed": changed,
            "added": added, "removed": removed}

    log(f"{label} → this revision: {len(same)} line(s) unchanged, "
        f"{len(changed)} quantity change(s), {len(added)} new item(s), "
        f"{len(removed)} removed.",
        "warn" if (added or removed) else "info")
    for c in changed:
        log(f"  qty  {c['material']}: {c['old_qty']:,.0f} → {c['new_qty']:,.0f} "
            f"({c['delta']:+,.0f}) — price held at {c['unit_net']:,.4f}"
            if c.get("unit_net") else
            f"  qty  {c['material']}: {c['old_qty']:,.0f} → {c['new_qty']:,.0f}")
    for a in added:
        log(f"  NEW  {a['material']} x{a['qty']:,.0f} — {a['description'] or ''} "
            f"(priced by the rule; this is what can move the margin)", "warn")
    for r in removed:
        log(f"  GONE {r['material']} (was x{r['qty']:,.0f})", "warn")
    return diff


def _offer_files(case_dir, before=None):
    """(revision number, filename) for every Approved Offer in the folder that this
    run may read, oldest first. `before` is this run's own revision number: R5 may
    read R4 and below, never an earlier attempt at R5 sitting in the same folder —
    otherwise a rebuild quietly reads its own output and the diff disappears."""
    if not os.path.isdir(case_dir):
        return []
    offers = []
    for f in os.listdir(case_dir):
        # 'approved', not 'approved offer': the analyst's own file is named
        # 'R4 Approved <project>.xlsx', Vector's is 'R4 Approved Offer - …'.
        if not f.lower().endswith((".xlsx", ".xlsm")) or "approved" not in f.lower():
            continue
        if f.startswith("~$"):
            continue
        m = re.match(r"^R(\d+)\b", f)
        n = int(m.group(1)) if m else 0
        if before is not None and n >= before:
            continue
        offers.append((n, f))
    return sorted(offers)


def _offer_label(rev):
    return f"R{rev}" if rev else "the first version"


def prior_prices(case_dir, log, before=None):
    """{material: {net, qty}} from the newest revision already in the folder.

    A revision usually only changes quantities, and a quantity change must not
    move the price the customer was already quoted — so the previous revision's
    Approved Offer is the reference, and it is read from the file rather than
    recomputed. Returns (label, prices); ('', {}) when there is nothing to carry.
    """
    offers = _offer_files(case_dir, before)
    if not offers:
        return "", {}
    rev, fname = offers[-1]
    label = _offer_label(rev)
    prices, _ = read_offer_prices(os.path.join(case_dir, fname), label, log)
    return (label, prices) if prices else ("", {})


def prior_prices_history(case_dir, log, before=None):
    """{material: [(label, net), …]} over EVERY earlier revision, oldest first.

    The carry comes from the newest revision alone — that is the price the customer
    last saw. But when a requested price does not match it, the useful question is
    whether it matches an OLDER one: sales re-quoting the R1 price on R3 is a
    different mistake from inventing a number, and the flag should say which."""
    hist = {}
    for rev, fname in _offer_files(case_dir, before):
        label = _offer_label(rev)
        prices, _ = read_offer_prices(os.path.join(case_dir, fname), label, log)
        for mat, v in (prices or {}).items():
            hist.setdefault(mat, []).append((label, v["net"]))
    return hist


def read_offer_prices(path, label, log):
    """{material: {net, qty}} from one Approved Offer, plus the total check.

    The check is Dalia's before she carries anything (2026-09-15): the approved
    total must be the lines' own Unit x QTY, or something was edited after the
    offer went to sales. Returns (prices, check); ({}, None) when unreadable."""
    fname = os.path.basename(path)
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb[wb.sheetnames[0]]
        # Columns are found by HEADER, never by position. Vector hides the price
        # build-up and leaves Unit Net Price in K; the analyst DELETES those
        # columns, which slides the same field to F. Both files still label it.
        head_row = col_sap = col_net = col_qty = None
        for row in range(1, min(FB_HEAD_SCAN, ws.max_row) + 1):
            for c in range(1, min(30, ws.max_column) + 1):
                v = str(ws.cell(row, c).value or "").strip().lower()
                if v.startswith("sap no"):
                    head_row, col_sap = row, c
                elif v.startswith("unit net price"):
                    col_net = c
                elif v.startswith("qty"):
                    col_qty = c
            if head_row and col_net:
                break
        if not (head_row and col_sap and col_net):
            log(f"{fname} does not look like an Approved Offer (no 'SAP No' / "
                f"'Unit Net Price' header) — nothing carried.", "warn")
            return {}, None
        prices, lines_total = {}, 0.0
        for row in range(head_row + 1, ws.max_row + 1):
            mat = ws.cell(row, col_sap).value
            net = num(ws.cell(row, col_net).value)
            if mat and str(mat).strip() not in ("0", "") and net:
                qty = num(ws.cell(row, col_qty).value) if col_qty else None
                prices[str(mat).strip()] = {"net": net, "qty": qty}
                lines_total += net * (qty or 0)
        # Total Net sits right of Unit Net in both layouts (Vector's K→L, the
        # analyst's F→G), and its header total two rows above the header.
        header_total = num(ws.cell(head_row - 1, col_net + 1).value)
        check = {"lines_total": round(lines_total, 2),
                 "header_total": round(header_total, 2) if header_total else None,
                 "match": bool(header_total and abs(header_total - lines_total) <= 1.0)}
        from openpyxl.utils import get_column_letter
        log(f"Carrying {len(prices)} price(s) from {label} ({fname}), read from "
            f"column {get_column_letter(col_net)}")
        if check["header_total"] and not check["match"]:
            log(f"{fname}: its header total {check['header_total']:,.2f} is not the lines' "
                f"own {check['lines_total']:,.2f} — the offer was edited after it was "
                f"approved; check which prices are real before trusting the carry.", "warn")
        return prices, check
    except Exception as e:
        log(f"Could not read the previous offer ({fname}): {e}", "warn")
        return {}, None


def _strip_macro_shapes(ws, log):
    """Drop the master's macro buttons from an exported sheet, keep the logo.

    The V2 master carries two shapes on both the ledger and the Feedback sheet:
    'Picture 1' (the Eaton logo, no macro) and 'Graphic 2' (an icon wired to
    'CPQ Pricing Model LSD - V2.xlsb'!WorkingFile / !OfferLetter). Copy the sheet
    out and the icon comes along as a dead image pointing at a macro in a
    workbook the recipient does not have. So the test is the macro, not the name:
    anything with an OnAction goes, anything without it stays."""
    dropped = []
    for i in range(ws.Shapes.Count, 0, -1):            # backwards: deleting reindexes
        shp = ws.Shapes(i)
        try:
            action = str(shp.OnAction or "").strip()
        except Exception:
            action = ""
        if not action:
            continue
        try:
            name = shp.Name
            shp.Delete()
            dropped.append(name)
        except Exception as e:
            log(f"Could not remove the shape {shp.Name!r}: {e}", "warn")
    if dropped:
        log(f"Removed the macro shape(s): {', '.join(dropped)}")


def _values_only(ws, log):
    """Every formula on the sheet replaced by what it currently shows.

    PasteSpecial alone left the first data row still carrying ='[1]Model Ledger '
    external links — the file then asks the recipient to update links to a
    workbook they do not have, and reads #REF when it moves. Assigning a range
    to itself is total and does not depend on the clipboard."""
    used = ws.UsedRange
    used.Value = used.Value
    log(f"Formulas flattened to values across {used.Address} "
        f"(no links back to the model)")


# Pivot items that are template debris, not pricing groups. Everything else is
# forced visible — see _refresh_pivots.
PIVOT_JUNK = {"", "x", "#n/a", "#ref!", "(blank)"}


def _refresh_pivots(wb, ws, log, relink=False):
    """Make the sheet's summary table tell the truth.

    Two faults, both from the master template:

    1. The master's pivot carries a SAVED ITEM FILTER — 'Voice System UL' is set
       invisible. A deal containing that group is then summarised without it, and
       the summary's Overall silently disagrees with the ledger's own total (on
       W262089818E R5, by 9,511.21 USD). So every item that is a real pricing
       group is forced visible and only the debris stays hidden.
    2. `relink` — copying a sheet out repoints its pivot cache at the workbook it
       came from, so Refresh on the copy fails with 'the source range cannot be
       accessed'. The cache is rebuilt against the copy's own data.
    """
    try:
        count = ws.PivotTables().Count
    except Exception:
        return
    for i in range(1, count + 1):
        pt = ws.PivotTables(i)
        try:
            if relink:
                src = str(pt.PivotCache().SourceData)
                m = re.search(r"!\s*(R\d+C\d+:R\d+C\d+)\s*$", src)
                if not m:
                    log(f"Pivot {pt.Name!r} has an unexpected source ({src[:60]}) — "
                        f"left as is.", "warn")
                else:
                    pt.ChangePivotCache(wb.PivotCaches().Create(
                        SourceType=1, SourceData=f"'{ws.Name}'!{m.group(1)}"))
                    log(f"Pivot {pt.Name!r} repointed at this workbook's own {m.group(1)}")
            pt.RefreshTable()

            shown = []
            for f in pt.PivotFields():
                if f.Orientation == 0:               # not on the report
                    continue
                for it in f.PivotItems():
                    want = str(it.Name).strip().lower() not in PIVOT_JUNK
                    try:
                        if bool(it.Visible) != want:
                            it.Visible = want
                            if want:
                                shown.append(str(it.Name))
                    except Exception:
                        pass                          # last visible item cannot be hidden
            if shown:
                log(f"Pivot {pt.Name!r}: un-hid {', '.join(shown)} — the template had "
                    f"them filtered out of the summary", "warn")
        except Exception as e:
            log(f"Could not refresh the pivot {pt.Name!r}: {e}", "warn")


def _drop_links(wb, log):
    """Remove the workbook's stored link to the model.

    Flattening the formulas is not enough on its own: the link DEFINITION
    survives in the file, so Excel still greets the recipient with 'this workbook
    contains links to other data sources — update?'. BreakLink deletes it."""
    try:
        sources = wb.LinkSources(1)          # xlExcelLinks
    except Exception:
        sources = None
    for src in list(sources or []):
        try:
            wb.BreakLink(Name=src, Type=1)   # xlLinkTypeExcelLinks
            log(f"Broke the link to {os.path.basename(str(src))}")
        except Exception as e:
            log(f"Could not break the link to {src}: {e}", "warn")


def _export_ledger(app, wb, out_path, log):
    """The ledger ALONE, values only, as .xlsm — the file that goes to the
    approver. The Working File is the whole master model (~7 MB of reference
    sheets nobody outside pricing needs); Dalia strips it to the ledger before
    mailing, so this does the same. Values, not formulas: every XLOOKUP in the
    ledger points at sheets that are not coming along, and a live formula would
    arrive as #REF."""
    led = wb.Worksheets(LEDGER_SHEET)
    led.Copy()                                   # → a new single-sheet workbook
    new = app.ActiveWorkbook
    ws = new.Worksheets(1)
    _values_only(ws, log)
    # Shapes BEFORE links: the macro shape is identified by its OnAction, and
    # that OnAction points into the master — breaking the link first blanks it
    # and the icon then looks like an innocent picture and survives.
    _strip_macro_shapes(ws, log)
    # Pivots BEFORE links too: their cache is an external reference to the
    # workbook this sheet was copied from, and it has to be rebuilt, not broken.
    _refresh_pivots(new, ws, log, relink=True)
    _drop_links(new, log)
    ws.Range("A1").Select()
    if os.path.exists(out_path):
        os.remove(out_path)
    new.SaveAs(os.path.abspath(out_path), FileFormat=52)  # xlOpenXMLWorkbookMacroEnabled
    new.Close(SaveChanges=False)
    size = os.path.getsize(out_path) / 1_048_576
    log(f"Saved {os.path.basename(out_path)} — the ledger only, values, {size:.1f} MB "
        f"(this is what the approval mail attaches)")


def _trim_offer(ws, log):
    """Drop the template's empty tail.

    The Feedback sheet carries a line for every ledger row — 620-odd of them —
    each holding the string '0' in a column formatted 0.00E+00, so an offer for
    two lines renders a wall of '0.00E+00' underneath it, plus an 'x' sentinel on
    the last row. They cannot simply be deleted: the terms and conditions sit in
    the note columns to the right and run further down than the line items do. So
    the table columns are cleared beside the notes, and only the rows past
    everything are removed."""
    scan_to = ws.UsedRange.Row + ws.UsedRange.Rows.Count - 1
    last_line = OFFER_FIRST_ROW - 1
    for r in range(OFFER_FIRST_ROW, scan_to + 1):
        v = str(ws.Cells(r, OFFER_COL_SAP).Value or "").strip()
        if v and v not in ("0", "x"):
            last_line = r

    # How far the notes to the right of the table reach. Scanned by absolute row
    # and column — UsedRange.Rows.Count is a COUNT, and the sheet's used range
    # does not have to start at A1, so counting is not the same as the last row.
    used = ws.UsedRange
    first_row = used.Row
    first_col = used.Column
    end_row = first_row + used.Rows.Count - 1
    end_col = first_col + used.Columns.Count - 1
    last_note = 0
    for c in range(OFFER_TABLE_COLS + 1, end_col + 1):
        for r in range(end_row, 0, -1):
            if str(ws.Cells(r, c).Value or "").strip():
                last_note = max(last_note, r)
                break

    end = end_row
    keep = max(last_line, last_note)
    if last_line < last_note:
        ws.Range(ws.Cells(last_line + 1, 1),
                 ws.Cells(last_note, OFFER_TABLE_COLS)).ClearContents()
    if end > keep:
        ws.Range(f"{keep + 1}:{end}").EntireRow.Delete()
    log(f"Trimmed the empty tail — {end - keep} row(s) deleted, "
        f"{max(0, last_note - last_line)} cleared beside the terms "
        f"(last line row {last_line}, terms reach row {last_note})")


def _live_totals(ws, log):
    """Put Total Net back as a formula: Unit Net (K) stays a pasted value, Total
    Net (L) becomes =K*E and the header total (L10) a SUM.

    Sales change quantities with the customer ("200 → 150 to reach his budget"),
    and a pasted total does not move with them (Dalia, 2026-09-15). Written after
    _trim_offer so the SUM covers exactly the line rows that survived."""
    last = OFFER_FIRST_ROW - 1
    for r in range(OFFER_FIRST_ROW, ws.UsedRange.Row + ws.UsedRange.Rows.Count):
        sap = str(ws.Cells(r, OFFER_COL_SAP).Value2 or "").strip()
        if not sap or sap in ("0", "x"):
            continue
        # Value2, not Value: a currency-formatted cell comes back through .Value as
        # a Decimal, which is not an int/float, and every line was skipped.
        if isinstance(ws.Cells(r, OFFER_COL_NET).Value2, (int, float)):
            ws.Cells(r, OFFER_COL_TOTAL).Formula = f"=K{r}*E{r}"
            last = r
    if last >= OFFER_FIRST_ROW:
        ws.Cells(OFFER_TOTAL_ROW, OFFER_COL_TOTAL).Formula = f"=SUM(L{OFFER_FIRST_ROW}:L{last})"
        log(f"Total Net kept live: L{OFFER_FIRST_ROW}:L{last} = Unit Net x QTY, "
            f"L{OFFER_TOTAL_ROW} = SUM — a quantity change by sales updates the total")


def _export_feedback(app, wb, out_path, log):
    """Copy the Feedback sheet to its own workbook and paste values over it —
    the procedure's manual output step (both model macros are broken in V2)."""
    fb = wb.Worksheets("Feedback")
    fb.Copy()                                    # → a new single-sheet workbook
    new = app.ActiveWorkbook
    ws = new.Worksheets(1)

    # The offer that leaves the building: numbers, not formulas, and none of the
    # model's machinery. Unit Net Price (K) is a value like every other cell.
    _values_only(ws, log)
    _strip_macro_shapes(ws, log)      # before _drop_links — see _export_ledger
    _refresh_pivots(new, ws, log, relink=True)   # no-op on Feedback, which has none
    _drop_links(new, log)
    _trim_offer(ws, log)
    _live_totals(ws, log)

    # The customer never sees how the price was built: list, standard discount,
    # unit standard and total standard, and the add. discount that got there.
    ws.Range(f"{FB_HIDE_FROM}:{FB_HIDE_TO}").EntireColumn.Hidden = True
    log(f"Hid columns {FB_HIDE_FROM}:{FB_HIDE_TO} (the build-up)")

    # Column C carries both the customer name and the line descriptions, and the
    # template's width truncates the name. Autofit reads the widest cell, so it
    # is capped — a 90-character description must not push the offer off a page.
    col_c = ws.Columns(FB_FIT_COL)
    col_c.AutoFit()
    if col_c.ColumnWidth > FB_FIT_MAX:
        col_c.ColumnWidth = FB_FIT_MAX
    log(f"Autofitted column {FB_FIT_COL} to {col_c.ColumnWidth:.1f}")

    ws.Range("A1").Select()
    if os.path.exists(out_path):
        os.remove(out_path)
    new.SaveAs(os.path.abspath(out_path), FileFormat=51)   # xlOpenXMLWorkbook
    new.Close(SaveChanges=False)
    log(f"Saved {os.path.basename(out_path)} (values only, logo and terms kept)")


# ─── CLI ─────────────────────────────────────────────────────────────────────
def resolve_meta(job, lines, bom_path, ref):
    meta = dict(job)
    # The transaction's own date, not the clock — a June case re-run in September
    # is still a June case, and the customer exceptions are dated.
    meta["as_of"] = guess_date(bom_path)
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
    ap.add_argument("--job")
    ap.add_argument("--out")
    # The server's two calls into the rule table: seed it, and vet a proposal.
    ap.add_argument("--dump-rules", action="store_true")
    ap.add_argument("--check-rule", metavar="JSON")
    args = ap.parse_args()

    if args.dump_rules:
        print(json.dumps(code_rules()))
        return
    if args.check_rule:
        r = json.loads(args.check_rule)
        print(json.dumps({"error": check_rule(str(r.get("key") or ""), r.get("value"))}))
        return
    if not (args.job and args.out):
        ap.error("--job and --out are required")

    # The log carries arrows and currency signs; a cp1252 console must not be
    # able to kill a run that has already copied files.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    # utf-8-sig: a job file written by anything Windows (PowerShell included)
    # carries a BOM, and json.load refuses it outright.
    with open(args.job, "r", encoding="utf-8-sig") as fh:
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

        _check_cancel(job, "before reading the transaction")
        lines, header, rows = read_bom(bom)
        if len(lines) > MAX_LINES:
            raise RuntimeError(f"{len(lines)} lines — the model's ledger only carries "
                               f"{MAX_LINES}. Split the transaction.")
        log(f"Read {len(lines)} line(s) from {os.path.basename(bom)}")

        # Before anything reads a constant. Dated by the transaction, like the
        # exceptions themselves — a June case re-run today gets June's rules.
        rules = job.pop("rules", None)
        applied = apply_rules(rules, guess_date(bom), log) if rules is not None else None

        ref = load_reference(master)
        log(f"Reference loaded: {len(ref['e2e'])} E2E targets, {len(ref['pv'])} customer "
            f"prior-year rows, {len(ref['mv'])} ledger prior-year rows, "
            f"{len(ref['trig'])} Trigger list prices, {len(ref['guide'])} Guidance rows")

        meta = resolve_meta(job, lines, bom, ref)
        fill_approval_adds(lines, rows, meta, meta["aprc"], log)
        _exc = rpi_exception(meta)
        _rate = _exc["rate"] if _exc else RPI_RATE[meta["half"]]
        log(f"Half-year {meta['half']} (RPI floor {_rate:.1%}) · "
            f"APRC {meta['aprc']} · ledger {meta['ledger']}")
        if _exc:
            log(f"{_exc['label']}: {_rate:.1%} in place of the {meta['half']} "
                f"{RPI_RATE[meta['half']]:.1%} — {_exc['why']}. Needs approving.")
        log("Rule: requested discount as asked, then the prior-year average "
            f"x {1 + _rate:.3f} where the line prices under the gate, then the "
            "group's target E2E as a floor — except on a line the customer has "
            "a prior-year price of its own for."
            if str(meta.get("rule") or "requested").lower() != "e2e" else
            "Rule: MIN(requested, @target E2E, 20%) with the algebraic RPI solve (old).")

        # A revision of a transaction already priced: carry the prices forward so
        # a quantity change moves no number the customer has already seen.
        rev = str(meta.get("revision") or "").strip().upper()
        diff = None
        if rev and meta.get("cases_root"):
            mine = int(re.sub(r"\D", "", rev) or 0) or None
            lbl, prior = prior_prices(case_folder(meta), log, before=mine)
            meta["_carry"] = {m: v["net"] for m, v in prior.items()}
            meta["_carry_label"] = lbl
            # Every earlier revision, so a requested price that is not the carried
            # one can still be named as an older approved price.
            meta["_carry_hist"] = prior_prices_history(case_folder(meta), log, before=mine)
            if prior:
                # What changed comes FIRST — it is the question a revision asks.
                diff = revision_diff(lines, prior, lbl, log)
            else:
                log(f"{rev}: no previous Approved Offer in the case folder — every "
                    f"line is priced from scratch.", "warn")
        elif meta.get("history_offer") and os.path.exists(str(meta["history_offer"])):
            # Not a revision of THIS number, but the same customer's earlier deal:
            # sales re-uploaded it under a new transaction (Khimji W262144615E was
            # W262142622E in July, all 25 materials the same). Dalia carries the
            # last approved prices exactly as she would for a revision.
            lbl = str(meta.get("history_label") or "the customer's last approved offer")
            prices, check = read_offer_prices(str(meta["history_offer"]), lbl, log)
            if prices:
                meta["_carry"] = {m: v["net"] for m, v in prices.items()}
                meta["_carry_label"] = lbl
                meta["_history_check"] = check
                diff = revision_diff(lines, prices, lbl, log)

        # This master's MV Ledger 2025 carries R2321 (UAE) only, so a customer
        # outside the UAE gets the UAE ledger as its "country" prior-year base.
        # The analyst's model has the same limitation — say so rather than hide it.
        ctry = str(meta.get("country") or "").strip().lower()
        if ctry and ctry not in ("uae", "united arab emirates") and meta["ledger"] == "R2321":
            log(f"Country is {meta['country']} but the only ledger in this master is R2321 "
                f"(UAE) — prior-year country averages come from the UAE ledger.", "warn")

        _check_cancel(meta, "before pricing")
        priced, summary = price_lines(lines, ref, meta)
        bk = summary.get("book")
        if bk:
            log(f"Fixed-price book: {bk['path']} — {bk['materials']} materials over "
                f"{bk['orders']} order(s). It covers {bk['lines']} line(s) on this "
                f"transaction"
                + (f", {bk['unpriced_history']} of which the ledger reads as having "
                   f"no customer history (the book is this year, 'PV 2025 ' is last)"
                   if bk["unpriced_history"] else "")
                + ".")
            if bk["held"]:
                log(f"{bk['held']} line(s) were priced UNDER what this customer has "
                    f"already paid this year and were held at the agreed price.", "warn")
            if bk["not_firm"]:
                log(f"{bk['not_firm']} line(s) were invoiced at more than one price this "
                    f"year — the latest is used, and the agreed number needs confirming.",
                    "warn")
            if bk["rpi_vs_book"] is not None:
                log(f"Against the agreed prices themselves, this quote is "
                    f"{bk['rpi_vs_book']:+.1%} — that is the increase this customer "
                    f"can actually see.")
        if summary.get("book_error"):
            log(f"The customer's fixed-price book could not be read ({summary['book_error']}) "
                f"— priced without it, so nothing guards against quoting under an "
                f"agreed price.", "warn")
        log(f"Priced {summary['lines']} line(s) — total {summary['grand_total']:,.2f} "
            f"{summary['currency']}")
        if summary["overall_e2e"] is not None:
            log(f"Overall E2E {summary['overall_e2e']:.1%} · overall RPI "
                f"{summary['overall_rpi']:.1%}" if summary["overall_rpi"] is not None
                else f"Overall E2E {summary['overall_e2e']:.1%}")
        if summary.get("cost_missing"):
            miss, tot = summary["cost_missing"], summary["lines"]
            log(f"No cost on {miss} of {tot} line(s): "
                + ("no E2E can be read on this transaction"
                   if miss >= tot else
                   f"the E2E above is measured over {summary['cost_cover']:.0%} "
                   f"of the money")
                + ". Neither the transaction nor the master carries a cost for "
                  "these materials. A transaction whose List Price is 0 and "
                  "Customer Condition blank was never priced in CPQ - reprice "
                  "the document there and fetch it again.", "warn")
        if summary.get("total_rpi") is not None:
            log(f"Total RPI {summary['total_rpi']:.1%}")
        rw = summary.get("rework")
        if rw and rw.get("applied"):
            log(f"Reworked to the approver's {rw['target']:.1%} ceiling on the "
                f"{rw['basis']} reading: {rw['before']:.1%} → {rw['achieved']:.1%}, "
                f"{summary['reworked']} line(s) moved."
                + (f" {rw['book_held']} line(s) held at the customer's own agreed "
                   f"price + {summary['rpi_rate']:.1%}"
                   if rw.get("book_held") else
                   f" Lines with history went to last year + {summary['rpi_rate']:.1%}")
                + f"; the rest to the ledger average {rw['country_rate']:+.1%}.",
                "warn" if not rw.get("reachable") else "info")
            if not rw.get("reachable"):
                log(f"It does NOT reach {rw['target']:.1%}: {rw['why']}.", "warn")
        elif rw:
            log(f"Not reworked: {rw['why']}.")
        if summary.get("carried"):
            log(f"{summary['carried']} line(s) held at the price from "
                f"{meta.get('_carry_label')}, {summary['lines'] - summary['carried']} "
                f"priced fresh")
        if summary["raised"]:
            log(f"{summary['raised']} line(s) pulled up to the {meta['half']} RPI floor")
        if summary.get("below_target"):
            log(f"{summary['below_target']} line(s) price under their target E2E "
                f"(overall {summary['overall_e2e']:.0%} against "
                f"{summary['target_e2e']:.0%}) — this margin needs approval.", "warn")
        for d in (summary.get("rpi_drivers") or []):
            if (d.get("share") or 0) > 0.25:
                log(f"RPI: {d['material']} carries {d['rpi_value']:,.2f} of "
                    f"{summary['rpi_value']:,.2f} ({d['share']:.0%}) — priced "
                    f"{d['unit_net']:,.2f} against a {d['ctry_avg']:,.2f} prior-year average"
                    + (f", which is below its {d['cost']:,.2f} cost: the material was "
                       f"repriced and no margin can meet the gate"
                       + (" - the margin is on target, so this is left as it is; "
                          "the price history is in the PV book" if d.get("margin_ok")
                          else "")
                       if d.get("ref_below_cost") else ""),
                    "warn" if (d.get("ref_below_cost") and not d.get("margin_ok")) else "info")
        if summary.get("rpi_no_history") and abs(summary["rpi_no_history"]
                                                 - (summary.get("rpi_value") or 0)) < 1:
            log(f"All {summary['rpi_value']:,.2f} of the RPI is against the ledger's "
                f"prior-year COUNTRY average — this customer bought none of these lines "
                f"last year, so no price was raised on them.", "info")
        if summary.get("floored"):
            # The band can legitimately be empty — every rung at or above the
            # strictest floored target is no concession — and the sentence has to
            # end rather than trail off into nothing.
            conc = ", ".join(f"{r:.0%}" for r in summary.get("e2e_concession") or ())
            log(f"{summary['floored']} line(s) asked for a price under their target E2E "
                f"and were raised to it, {summary['floored_value']:,.2f} over what the "
                f"customer asked — nothing is released at cost."
                + (f" Concede no further than {conc}." if conc
                   else " There is no concession rung under that target — it needs approval."),
                "warn")
        if summary["action"] or summary["verify"]:
            log(f"{summary['action']} line(s) need a decision, {summary['verify']} need a "
                f"reference check", "warn")
        else:
            log("No line needs a human decision.", "ok")

        # The one-liner that follows this case everywhere.
        summary["headline"] = headline(summary, meta, diff)
        log(summary["headline"], "ok")

        result = {"ok": True, "mode": job.get("mode", "preview"), "lines": priced,
                  "summary": summary, "diff": diff, "rules": applied,
                  "meta": {k: v for k, v in meta.items() if not k.startswith("_")}}

        if job.get("mode") == "build":
            if not job.get("cases_root"):
                raise RuntimeError("No case folder root configured.")
            meta["_bom_header"] = header
            meta["_bom_rows"] = rows
            built = build_case(bom, priced, summary, meta, log)
            result.update(built)
            log("Done.", "ok")
    except Cancelled as e:
        # Not a failure: the case folder may hold a half-written Working File, so
        # say so plainly rather than reporting an error the analyst has to read.
        log(str(e), "warn")
        result = {"ok": False, "cancelled": True, "error": str(e), "lines": []}
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
