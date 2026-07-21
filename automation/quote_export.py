"""
quote_export.py — Clone a REAL Eaton EL quote PDF and overwrite only the fields
that change, keeping the original layout pixel-for-pixel.

Not a rebuilt template: it opens the bundled base quote (docs/quote_template.pdf),
redacts just the values that vary and re-inserts the new ones at the identical
coordinates / fonts, and regenerates the Detail Bill of Material item rows.
Pages 3+ (Terms & Conditions boilerplate) pass through untouched.

Zones that change (everything else is left exactly as the base quote):
  Page 1 (cover letter):  Job name, Job number, Quotation No, Issue/Valid dates,
                          salesman name / telephone / email, signature.
  Page 2 (Bill of Material): header (Project Name, Negotiation No, Bid/Purchase
                          dates) + the item table (item no / qty / product /
                          description / catalog no / unit + extended price) + total.

Input JSON (--input):
  {
    "header": {
      "quoteName", "quoteNumber", "quoteNo", "date", "validDate",
      "salesman": {"name","email","phone"}
    },
    "lines": [{"catNo","product","description","qty","price"}, ...],
    "appendComm": false, "appendTC": false
  }
Prints "__PDF__:<path>" on success, "__ERROR__:<msg>" on failure.
"""
import sys, os, json, argparse
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
TEMPLATE = os.path.join(DOCS, "quote_template.pdf")

# Fonts (Windows). Fall back to PyMuPDF builtins if unavailable.
FONTS = {
    "ar":   r"C:\Windows\Fonts\arial.ttf",
    "arb":  r"C:\Windows\Fonts\arialbd.ttf",
    "arn":  r"C:\Windows\Fonts\ARIALN.TTF",
    "arnb": r"C:\Windows\Fonts\ARIALNB.TTF",
}
BLACK = (0, 0, 0)
WHITE = (1, 1, 1)

# Static legal note that sits under the BOM total (regenerated so it flows below
# a variable number of item rows).
BOM_NOTE = [
    "If Eaton and the buyer entity listed on this purchase order have a separate executed written agreement for the products/services herein, then that",
    "agreement applies. Otherwise, Eaton’s Selling Policy 25000 (https://www.eaton.com/ca/en-gb/support/terms-conditions.html) controls and supersedes",
    "all prior correspondence or communications between Eaton and the buyer, and any additional or different terms proposed by the buyer are rejected.",
]


def base_y(top, size):
    """Baseline y for insert_text given a span's top-left y (empirically ~0.82em)."""
    return top + size * 0.82


def money(v):
    return f"{float(v):,.2f}"


def uk_to_us(d):
    """dd/mm/yyyy -> m/d/yyyy (BOM page uses US-style dates like the real quote)."""
    try:
        dd, mm, yy = d.split("/")
        return f"{int(mm)}/{int(dd)}/{yy}"
    except Exception:
        return d


def add_days_uk(d, days):
    try:
        dt = datetime.strptime(d, "%d/%m/%Y")
        return (dt + timedelta(days=days)).strftime("%d/%m/%Y")
    except Exception:
        return d


class Cloner:
    def __init__(self, fitz, doc):
        self.fitz = fitz
        self.doc = doc
        self._font_ok = {k: os.path.exists(p) for k, p in FONTS.items()}

    def _fontfile(self, key):
        return FONTS[key] if self._font_ok.get(key) else None

    def txt(self, page, x, y, s, key, size, color=BLACK):
        ff = self._fontfile(key)
        if ff:
            page.insert_text((x, y), s, fontfile=ff, fontname=key, fontsize=size, color=color)
        else:
            # builtin fallback (helv / helv-bold) keeps output legible off-Windows
            builtin = "hebo" if key in ("arb", "arnb") else "helv"
            page.insert_text((x, y), s, fontname=builtin, fontsize=size, color=color)

    def font_len(self, key, s, size):
        ff = self._fontfile(key)
        if ff:
            return self.fitz.Font(fontfile=ff).text_length(s, size)
        return self.fitz.Font("helv").text_length(s, size)

    def redact(self, page, rects):
        for r in rects:
            page.add_redact_annot(self.fitz.Rect(r), fill=WHITE)
        page.apply_redactions()

    def wrap(self, key, text, size, maxw):
        f = self.fitz.Font(fontfile=self._fontfile(key)) if self._fontfile(key) else self.fitz.Font("helv")
        lines, cur = [], ""
        for w in str(text).split():
            t = (cur + " " + w).strip()
            if f.text_length(t, size) <= maxw:
                cur = t
            else:
                if cur:
                    lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        return lines or [""]


def build(fitz, header, lines):
    doc = fitz.open(TEMPLATE)
    c = Cloner(fitz, doc)

    sm = header.get("salesman") or {}
    job_no   = str(header.get("quoteNumber", "")).strip()
    job_name = str(header.get("quoteName", "")).strip()
    quote_no = str(header.get("quoteNo", "")).strip()
    date     = str(header.get("date", "")).strip()
    valid    = str(header.get("validDate", "")).strip() or (add_days_uk(date, 30) if date else "")
    sm_name  = str(sm.get("name", "")).strip()
    sm_tel   = str(sm.get("phone", "")).strip()
    sm_email = str(sm.get("email", "")).strip()

    # ================= PAGE 1 — cover letter =================
    # NOTE: the top-right Contact Person / Telephone / Email block and the
    # signature are FIXED to the quote author (Laith / quote factory) and stay
    # baked in the template — the engine does NOT touch them. The salesman
    # (name + email + phone) appears only in the body "Sales Engineer" line.
    p1 = doc[0]
    c.redact(p1, [
        (382, 142, 565, 156),    # QUOTATION REF value
        (382, 153, 565, 167),    # Quotation No
        (366, 163, 565, 177),    # Issue Date
        (382, 173, 565, 187),    # Valid to
        (85,  261, 565, 276),    # left bold Project Reference line
    ])
    c.txt(p1, 384.7, base_y(148.4, 9.2), job_no,   "ar", 9.2)
    if quote_no:
        c.txt(p1, 384.7, base_y(159.0, 9.2), quote_no, "ar", 9.2)
    c.txt(p1, 368.5, base_y(169.5, 8.5), date,     "ar", 8.5)
    c.txt(p1, 384.7, base_y(179.5, 9.2), valid,    "ar", 9.2)
    ref_line = "Project Reference: " + " ".join(x for x in (job_no, job_name) if x)
    c.txt(p1, 85.3, base_y(267.7, 9.2), ref_line, "arb", 9.2)
    # Body: "…contact the Sales Engineer for this Project, <name>, <email>, <phone>
    #        or me by email, UKQuoteFactoryEL@Eaton.com or telephone 01302 303303."
    # The salesman slot + the fixed "or me…" tail are rewritten together and
    # word-wrapped across the two lines (name makes it too wide for the old inline gap).
    if sm_name or sm_email or sm_tel:
        anchors = p1.search_for("for this Project,")
        if anchors:
            a = anchors[0]
            c.redact(p1, [(a.x1, 591.4, 528, 602.6),  # rest of line 1 (old salesman slot + "or me")
                          (83, 602.6, 528, 613.5)])    # line 2 ("by email … 303303.")
            ME_TAIL = "or me by email, UKQuoteFactoryEL@Eaton.com or telephone 01302 303303."
            contact = ", ".join(x for x in (sm_name, sm_email, sm_tel) if x)
            words = (contact + " " + ME_TAIL).split()
            penx, liney, maxx = a.x1 + 2.5, a.y0, 527.0
            space = c.font_len("ar", " ", 9.2)
            for w in words:
                ww = c.font_len("ar", w, 9.2)
                if penx + ww > maxx:
                    penx, liney = 85.3, liney + 10.6
                c.txt(p1, penx, base_y(liney, 9.2), w, "ar", 9.2)
                penx += ww + space

    # ================= PAGE 2 — Detail Bill of Material =================
    p2 = doc[1]
    # header values (y0 >= 51.5 so the tall "Material" title glyph is untouched)
    c.redact(p2, [
        (274, 53.7, 420, 68),    # Project Name (up to 2 lines); y0 clears title glyphs
        (513, 53.7, 600, 61),    # Negotiation No
        (274, 77,   420, 88),    # Bid Date
        (513, 77,   600, 88),    # Est. Purchase Date
        (44,  128,  600, 300),   # item region + total + legal note
    ])
    pn = " - ".join(x for x in (job_no, job_name) if x)   # Project Name = "<quote number> - <quote name>"
    for i, ln in enumerate(c.wrap("ar", pn, 8.2, 145)[:2]):
        c.txt(p2, 275.6, base_y(54.1 + i * 9.0, 8.2), ln, "ar", 8.2)
    if quote_no:
        c.txt(p2, 515.1, base_y(54.1, 8.2), quote_no.split("-")[0], "ar", 8.2)
    if date:
        c.txt(p2, 275.6, base_y(82.6, 8.2), uk_to_us(date),  "ar", 8.2)
    if valid:
        c.txt(p2, 515.1, base_y(82.6, 8.2), uk_to_us(valid), "ar", 8.2)

    # item rows
    COL_NO, COL_QTY, COL_PROD, COL_DESC = 45.0, 86.3, 117.9, 217.0
    UNIT_R, EXT_R = 526.0, 595.5     # right edges for the two price columns
    y = 135.7
    total = 0.0
    for idx, it in enumerate(lines, 1):
        qty   = float(it.get("qty") or 0)
        price = float(it.get("price") or 0)
        ext   = round(qty * price, 2)
        total += ext
        item_no = it.get("itemNo") or f"{idx * 10:03d}"
        qty_s   = str(int(qty)) if qty == int(qty) else str(qty)
        product = str(it.get("product") or it.get("designation") or "")
        catno   = str(it.get("catNo") or "")

        c.txt(p2, COL_NO,   base_y(y, 9), str(item_no), "arn", 9)
        c.txt(p2, COL_QTY,  base_y(y, 9), qty_s,        "arn", 9)
        if product:
            c.txt(p2, COL_PROD, base_y(y, 9), product,  "arn", 9)
        dl = c.wrap("arn", it.get("description", ""), 9, 235)
        for i, ln in enumerate(dl):
            c.txt(p2, COL_DESC, base_y(y + i * 9.8, 9), ln, "arn", 9)
        us, ue = money(price), money(ext)
        c.txt(p2, UNIT_R - c.font_len("arnb", us, 9), base_y(y, 9), us, "arnb", 9)
        c.txt(p2, EXT_R  - c.font_len("arnb", ue, 9), base_y(y, 9), ue, "arnb", 9)

        ny = y + max(len(dl), 1) * 9.8 + 3
        if catno:
            c.txt(p2, 164.4, base_y(ny, 9), "Catalog No", "arnb", 9)
            c.txt(p2, 214.8, base_y(ny, 9), catno,        "arn", 9)
            ny += 18
        else:
            ny += 9
        y = ny

    # total
    ty = y + 4
    c.txt(p2, 314.6, base_y(ty, 9), "Total Plant Price ( GBP )", "arnb", 9)
    ts = money(total)
    c.txt(p2, EXT_R - c.font_len("arnb", ts, 9), base_y(ty, 9), ts, "arnb", 9)

    # legal note flows beneath the total
    notey = ty + 22
    for i, ln in enumerate(BOM_NOTE):
        c.txt(p2, 45.0, base_y(notey + i * 11.3, 9), ln, "arnb", 9)

    return doc


def merge_extra(fitz, doc, outdir, want_comm, want_tc):
    """Append optional Commissioning / extra T&C PDFs after the cloned quote."""
    def find_doc(*names):
        for n in names:
            p = os.path.join(DOCS, n)
            if os.path.exists(p):
                return p
        return None
    extra = []
    if want_comm:
        p = find_doc("commissioning.pdf", "GENERAL SERVICE & COMMISSIONING.pdf")
        if p:
            extra.append(p)
    if want_tc:
        p = find_doc("terms_and_conditions.pdf", "United Kingdom TCs English March 2023.pdf")
        if p:
            extra.append(p)
    for p in extra:
        try:
            doc.insert_pdf(fitz.open(p))
        except Exception as e:
            sys.stderr.write(f"[warn] append {p}: {e}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    try:
        import fitz
    except ImportError:
        print("__ERROR__:PyMuPDF (fitz) not installed"); sys.exit(1)

    if not os.path.exists(TEMPLATE):
        print(f"__ERROR__:Base quote template missing: {TEMPLATE}"); sys.exit(1)

    try:
        data = json.loads(open(args.input, encoding="utf-8").read())
    except Exception as e:
        print(f"__ERROR__:Could not read input: {e}"); sys.exit(1)

    header = data.get("header") or {}
    lines = [l for l in (data.get("lines") or []) if (l.get("description") or l.get("catNo") or l.get("product"))]
    if not lines:
        print("__ERROR__:No line items to quote"); sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    out = os.path.join(args.outdir, "Quote.pdf")
    try:
        doc = build(fitz, header, lines)
        merge_extra(fitz, doc, args.outdir,
                    bool(data.get("appendComm", False)),
                    bool(data.get("appendTC", False)))
        doc.save(out, garbage=4, deflate=True)
        doc.close()
    except Exception as e:
        import traceback
        sys.stderr.write(traceback.format_exc())
        print(f"__ERROR__:Failed to build quote: {e}"); sys.exit(1)

    if not os.path.exists(out):
        print("__ERROR__:Quote PDF not produced"); sys.exit(1)
    print(f"__PDF__:{out}")
    sys.exit(0)


if __name__ == "__main__":
    main()
