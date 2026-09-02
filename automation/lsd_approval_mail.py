"""
lsd_approval_mail.py — the LSD approval ask, in the analyst's own format.

When a case prices BELOW its target E2E the price is not raised to hide it (see
lsd_pricing.py, the 'requested' rule) — the margin goes to the approver instead.
This writes that mail: Dalia's layout, verbatim, with the numbers taken from a
priced result rather than retyped.

    Hi <approver>,
    Regarding a/m request we have increased prices by <rate>% on LY price
    however the E2E drop to <e2e>% , please confirm to release

    Customer Name : ...
    Project Name  : ...
    Target Price  : $40,211.00
    E2E @ Target Price : 32.7% , RPI -0.6%  $ (227.00)

    | Pricing Groups | Add. Discount | Proposed Total Net Price |
      E2E% @ Proposed Price | Target E2E% | Total RPI % | Total RPI Value |

TWO STAGES, and they are different numbers. "Target Price" is what the CUSTOMER
asked for — the requested prices — and the E2E/RPI that price would land; the
RPI there is usually negative, which is the whole reason for the ask. The table
is the PROPOSED price, after the RPI gate lifted the lines, per pricing group.
Both come out of price_lines' summary (`at_target` and `groups`).

The mail is left in Drafts and the composer is popped. It is NEVER sent from
here: mode 'send' exists for a caller that has its own confirmation, and the
default is 'draft'.

Usage
-----
    python lsd_approval_mail.py --job job.json --out result.json

job.json:
    {"result": "<path to lsd_pricing.py's out.json>",   (or "summary"+"meta" inline)
     "to": "Poulose, Kiran" | "kiran@...",   "cc": "Nabil, Dalia",
     "attach": ["<path>", ...],
     "subject": "<optional - one is built from the case>",
     "intro": "<optional - replaces the 'Regarding a/m request ...' line>",
     "mode": "draft" (default) | "send"}

A display name in `to`/`cc` is resolved against the GAL, so "Poulose, Kiran"
works without anyone having to look the address up.
"""
import argparse
import json
import os
import sys


# ─── formatting ──────────────────────────────────────────────────────────────
SYM = {"USD": "$", "EUR": "€"}


def money(v, ccy):
    """Dalia writes negatives in red parentheses, accountant-style."""
    if v is None:
        return ""
    s = SYM.get(ccy, "")
    return f"{s} ({abs(v):,.2f})" if v < 0 else f"{s} {v:,.2f}"


def pct(v, dp=1):
    return "" if v is None else f"{v * 100:.{dp}f}%"


def _esc(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ─── the mail ────────────────────────────────────────────────────────────────
HEAD_BG, HEAD_BG_RPI = "#1F4E79", "#F4B183"
TD = "border:1px solid #000;padding:4px 8px;font-family:Calibri,sans-serif;font-size:11pt;"
TH = (TD + f"background:{HEAD_BG};color:#fff;font-weight:bold;text-align:center;")
TH_RPI = (TD + f"background:{HEAD_BG_RPI};color:#000;font-weight:bold;text-align:center;")


def _row(cells, bold=False, bg=""):
    w = "font-weight:bold;" if bold else ""
    b = f"background:{bg};" if bg else ""
    out = []
    for i, (val, align) in enumerate(cells):
        out.append(f'<td style="{TD}{w}{b}text-align:{align};">{val}</td>')
    return "<tr>" + "".join(out) + "</tr>"


def build_html(summary, meta, intro=None, approver=""):
    ccy = summary.get("currency") or "USD"
    at = summary.get("at_target") or {}
    groups = summary.get("groups") or []
    rate = summary.get("rpi_rate")
    e2e = summary.get("overall_e2e")

    if intro is None:
        intro = (f"Regarding a/m request we have increased prices by "
                 f"{pct(rate, 0) if rate is not None else '6%'} on LY price however the "
                 f"E2E drop to {pct(e2e, 0) if e2e is not None else ''} , "
                 f"please confirm to release")

    head = [
        ("Customer Name", meta.get("customer_name")),
        ("Project Name", meta.get("project")),
        ("Target Price", money(at.get("target_price"), ccy)),
    ]
    head_html = "".join(
        f'<div style="font-family:Calibri,sans-serif;font-size:11pt;font-weight:bold;">'
        f'{_esc(k)} : {_esc(v)}</div>' for k, v in head if v not in (None, ""))

    rpi_val = at.get("rpi_value")
    red = ' style="color:#C00000;"' if (rpi_val or 0) < 0 else ""
    head_html += (
        f'<div style="font-family:Calibri,sans-serif;font-size:11pt;font-weight:bold;">'
        f'E2E @ Target Price :  {pct(at.get("e2e"))} , RPI {pct(at.get("rpi_pct"))} '
        f'<span{red}>{money(rpi_val, ccy)}</span></div>')

    cols = ["Pricing Groups", "Add. Discount", "Proposed Total Net Price",
            "E2E% @ Proposed Price", "Target E2E%", "Total RPI %", "Total RPI Value"]
    header = "<tr>" + "".join(
        f'<th style="{TH_RPI if c.startswith("Total RPI") else TH}">{_esc(c)}</th>'
        for c in cols) + "</tr>"

    body_rows = "".join(
        _row([(_esc(g["group"]), "left"), (pct(g["add_disc"]), "center"),
              (money(g["net"], ccy), "right"), (pct(g["e2e"]), "center"),
              (pct(g["target_e2e"], 0), "center"), (pct(g["rpi_pct"]), "center"),
              (money(g["rpi_value"], ccy), "right")])
        for g in groups)

    # The Overall row is the quote, not a sum of the group percentages.
    overall = _row([("Overall", "left"),
                    (pct(summary.get("overall_add_disc")), "center"),
                    (money(summary.get("grand_total"), ccy), "right"),
                    (pct(summary.get("overall_e2e")), "center"),
                    (pct(summary.get("target_e2e"), 0), "center"),
                    (pct(summary.get("total_rpi")), "center"),
                    (money(summary.get("rpi_value"), ccy), "right")],
                   bold=True, bg="#EDEDED")

    return (
        f'<div style="font-family:Calibri,sans-serif;font-size:11pt;">'
        f'<p>Hi {_esc(approver) or "there"},<br>{_esc(intro)}</p>'
        f'<p>{head_html}</p>'
        f'<table style="border-collapse:collapse;">{header}{body_rows}{overall}</table>'
        f'</div>')


# ─── Outlook ─────────────────────────────────────────────────────────────────
def _resolve(ns, who):
    """A display name ('Poulose, Kiran') → its SMTP address off the GAL. Left as
    typed when it does not resolve — Outlook shows it unresolved rather than
    guessing at a wrong mailbox."""
    who = str(who or "").strip()
    if not who or "@" in who:
        return who
    try:
        r = ns.CreateRecipient(who)
        if r.Resolve():
            try:
                return r.AddressEntry.GetExchangeUser().PrimarySmtpAddress or who
            except Exception:
                return r.Address or who
    except Exception:
        pass
    return who


def first_name(who):
    """'Poulose, Kiran' → 'Kiran'; 'Kiran Poulose' → 'Kiran'; an address → ''."""
    who = str(who or "").strip()
    if not who or "@" in who:
        return ""
    return (who.split(",")[1] if "," in who else who.split(" ")[0]).strip()


def compose(job, summary, meta, log):
    import win32com.client as w

    app = w.Dispatch("Outlook.Application")
    ns = app.GetNamespace("MAPI")

    to = _resolve(ns, job.get("to"))
    cc = ", ".join(_resolve(ns, p) for p in
                   ([job["cc"]] if isinstance(job.get("cc"), str) else (job.get("cc") or []))
                   if str(p or "").strip())

    tag = meta.get("transaction") or ""
    subject = job.get("subject") or " - ".join(
        x for x in (tag, meta.get("project"), "approval to release") if x)

    mail = app.CreateItem(0)
    mail.To = to
    if cc:
        mail.CC = cc
    mail.Subject = subject
    mail.HTMLBody = build_html(summary, meta, job.get("intro"),
                               first_name(job.get("to")))

    attached = []
    for p in job.get("attach") or []:
        if not os.path.exists(p):
            log(f"Attachment not found, skipped: {p}", "warn")
            continue
        try:
            mail.Attachments.Add(os.path.abspath(p))
            attached.append(os.path.basename(p))
            log(f"Attached {os.path.basename(p)} "
                f"({os.path.getsize(p) / 1_048_576:.1f} MB)")
        except Exception as e:
            log(f"Could not attach {os.path.basename(p)}: {e}", "warn")

    if str(job.get("mode") or "draft").lower() == "send":
        mail.Send()
        log(f"Sent to {to}.", "ok")
        return {"sent": True, "to": to, "cc": cc, "subject": subject,
                "attached": attached}

    mail.Save()
    try:
        mail.Display()
    except Exception:
        pass
    log(f"Draft saved and opened — nothing is sent until you press Send.", "ok")
    return {"sent": False, "draft": True, "entry_id": mail.EntryID, "to": to,
            "cc": cc, "subject": subject, "attached": attached}


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

    result = {"ok": False}
    try:
        summary, meta = job.get("summary"), job.get("meta")
        if job.get("result"):
            with open(job["result"], encoding="utf-8-sig") as fh:
                priced = json.load(fh)
            summary = summary or priced.get("summary")
            meta = meta or priced.get("meta")
            # Default attachment: the LEDGER-ONLY .xlsm the build wrote, never the
            # Working File — that is the whole master model, ~7 MB of reference
            # sheets the approver has no use for.
            if not job.get("attach") and priced.get("ledger"):
                job["attach"] = [priced["ledger"]]
        if not summary or not meta:
            raise RuntimeError("No priced result to mail — pass 'result' or "
                               "'summary' + 'meta'.")
        if not job.get("to"):
            raise RuntimeError("No approver to send to.")

        if job.get("html_only"):
            result = {"ok": True, "html": build_html(summary, meta, job.get("intro"),
                                                     first_name(job.get("to")))}
        else:
            result = {"ok": True, **compose(job, summary, meta, log)}
    except Exception as e:
        log(str(e), "error")
        result = {"ok": False, "error": str(e)}
    finally:
        result["log"] = log_lines
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, default=str)

    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
