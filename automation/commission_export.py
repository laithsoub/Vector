"""
commission_export.py — Build a customer-facing, single-page commissioning
                       price sheet for CG Line+ or Easicheck.

The workbook (docs/commission_calculators.xlsx) is an INTERNAL tool: every tier
sits on the same sheet next to the day rate, the cover uplift and the margin
scratch cells, so converting it to PDF leaked five pages of pricing internals to
the customer. The tier maths below is the same maths the sheet does (and the
same the UI shows in src/pages/Commission.tsx) — we compute it here and render
only the final price table.
"""
import sys, os, argparse
from datetime import date

# ── Palette (matches automation/export_report.py) ─────────────────────────────
ACCENT  = '#4f7cf7'
INK1    = '#15151d'
INK2    = '#585866'
INK3    = '#8a8a98'
LINE    = '#e2e2ea'
SURFACE = '#f6f6fa'

# ── Rates — mirrors src/pages/Commission.tsx ─────────────────────────────────
CG_DAY = 896.28 * 1.05      # day rate incl. 5% cover
EC_DAY = 896.17
CENTRAL_LONDON = 75.00


def cg_tier(p):
    if p == 1:  return dict(pr=CG_DAY / 1.25, lr=CG_DAY / 175, cr=0.0, sr=CG_DAY / 2)
    if p <= 4:  return dict(pr=CG_DAY / 1.5,  lr=CG_DAY / 175, cr=0.0, sr=CG_DAY / 1.75)
    if p <= 9:  return dict(pr=CG_DAY / 1.5,  lr=CG_DAY / 175, cr=0.0, sr=CG_DAY / 1.5)
    if p <= 15: return dict(pr=CG_DAY / 1.5,  lr=CG_DAY / 175, cr=0.0, sr=CG_DAY / 1.25)
    return None


def ec_tier(p):
    if p == 1:  return dict(pr=EC_DAY / 2, lr=EC_DAY / 175, cr=0.0,    sr=EC_DAY / 2)
    if p <= 4:  return dict(pr=EC_DAY / 2, lr=EC_DAY / 175, cr=150.0,  sr=EC_DAY / 1.25)
    if p <= 9:  return dict(pr=384.90,     lr=3.57,         cr=124.16, sr=EC_DAY / 1)
    if p <= 15: return dict(pr=446.98,     lr=3.57,         cr=124.16, sr=EC_DAY / 0.75)
    return       dict(pr=542.01,           lr=3.57,         cr=124.16, sr=EC_DAY / 0.5)


def calculate(kind, panels, lumis, cards, software, central_london):
    """Return the customer lines plus the total.

    Every amount is rounded to the penny *before* it is summed, so the printed
    column always adds up to the printed total — a total that is a penny off its
    own line items is what a customer queries.
    """
    day  = CG_DAY if kind == 'cg' else EC_DAY
    tier = cg_tier(panels) if kind == 'cg' else ec_tier(panels)
    if tier is None:
        return None
    sw_label = 'CG Vision PC Software' if kind == 'cg' else 'PC Software'
    unit     = 'CG Line+' if kind == 'cg' else 'Easicheck'
    r2       = lambda x: round(x + 1e-9, 2)

    rows = [('%s panel commissioning' % unit, panels, tier['pr'], r2(panels * tier['pr']))]
    if lumis > 0:
        rows.append(('%s luminaire commissioning' % unit, lumis, tier['lr'], r2(lumis * tier['lr'])))
    if cards > 0 and tier['cr'] > 0:
        rows.append(('Network card commissioning', cards, tier['cr'], r2(cards * tier['cr'])))
    if software:
        rows.append((sw_label, 1, tier['sr'], r2(tier['sr'])))

    subtotal = r2(sum(r[3] for r in rows))
    min_adj  = r2(day - subtotal) if subtotal < r2(day) else 0.0

    if central_london:
        rows.append(('Central London site charge', 1, CENTRAL_LONDON, CENTRAL_LONDON))

    total = r2(sum(r[3] for r in rows) + min_adj)
    return dict(rows=rows, subtotal=subtotal, min_adj=min_adj, total=total)


def gbp(n):
    return '\u00a3{:,.2f}'.format(n)


# ── PDF ───────────────────────────────────────────────────────────────────────
def build_pdf(path, kind, calc, panels, ref):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                    TableStyle, Flowable)

    # Helvetica is Latin-1 only; use a real Unicode TTF when Windows has one.
    FONT, FONT_B = 'Helvetica', 'Helvetica-Bold'
    fdir = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'Fonts')
    for fam, reg, bold in (('SegoeUI', 'segoeui.ttf', 'segoeuisb.ttf'),
                           ('SegoeUI', 'segoeui.ttf', 'segoeuib.ttf'),
                           ('Arial',   'arial.ttf',   'arialbd.ttf'),
                           ('DejaVu',  'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf')):
        try:
            rp, bp = os.path.join(fdir, reg), os.path.join(fdir, bold)
            if os.path.exists(rp) and os.path.exists(bp):
                pdfmetrics.registerFont(TTFont(fam, rp))
                pdfmetrics.registerFont(TTFont(fam + '-Bold', bp))
                FONT, FONT_B = fam, fam + '-Bold'
                break
        except Exception:
            continue

    C = colors.HexColor
    MARGIN    = 1.6 * cm
    W_CONTENT = A4[0] - 2 * MARGIN
    product   = 'CG Line+' if kind == 'cg' else 'Easicheck'

    def st(name, **kw):
        kw.setdefault('fontName', FONT)
        kw.setdefault('textColor', C(INK1))
        return ParagraphStyle(name, **kw)

    S = {
        'cell':  st('cell',  fontSize=9.2, leading=12.5, textColor=C(INK1)),
        'num':   st('num',   fontSize=9.2, leading=12.5, alignment=TA_RIGHT, textColor=C(INK2)),
        'numb':  st('numb',  fontSize=9.2, leading=12.5, alignment=TA_RIGHT,
                    fontName=FONT_B, textColor=C(INK1)),
        'th':    st('th',    fontSize=7.6, leading=10, fontName=FONT_B, textColor=C(INK3)),
        'thr':   st('thr',   fontSize=7.6, leading=10, fontName=FONT_B, textColor=C(INK3),
                    alignment=TA_RIGHT),
        'note':  st('note',  fontSize=7.8, leading=11.5, textColor=C(INK3)),
    }

    class Band(Flowable):
        """Title slab: what this document prices, for which reference, and when."""
        def __init__(self, width):
            Flowable.__init__(self)
            self.width, self.height = width, 66

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c, h = self.canv, self.height
            c.setFillColor(C(ACCENT))
            c.roundRect(0, 0, self.width, h, 9, stroke=0, fill=1)
            c.setFillColor(colors.white)
            c.setFont(FONT_B, 17)
            c.drawString(18, h - 30, 'Commissioning Quotation')
            c.setFont(FONT, 10)
            c.setFillColor(colors.Color(1, 1, 1, 0.9))
            c.drawString(18, h - 47, '%s Emergency Lighting System' % product)
            c.setFont(FONT, 8.4)
            c.setFillColor(colors.Color(1, 1, 1, 0.85))
            c.drawRightString(self.width - 18, h - 30, date.today().strftime('%d %B %Y'))
            if ref:
                c.drawRightString(self.width - 18, h - 45, 'Ref: %s' % ref[:48])

    class TotalBar(Flowable):
        """The one number the customer is looking for."""
        def __init__(self, width, total):
            Flowable.__init__(self)
            self.width, self.height, self.total = width, 46, total

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c, h = self.canv, self.height
            c.setFillColor(C(SURFACE))
            c.setStrokeColor(C(ACCENT))
            c.setLineWidth(1)
            c.roundRect(0, 0, self.width, h, 7, stroke=1, fill=1)
            c.setFillColor(C(INK1))
            c.setFont(FONT_B, 10.5)
            c.drawString(16, h - 21, 'Total Commissioning Value')
            c.setFillColor(C(INK3))
            c.setFont(FONT, 8)
            c.drawString(16, h - 33, 'Excluding VAT')
            c.setFillColor(C(ACCENT))
            c.setFont(FONT_B, 18)
            c.drawRightString(self.width - 16, h - 29, gbp(self.total))

    P = lambda t, s: Paragraph(t, S[s])
    data = [[P('Description', 'th'), P('Qty', 'thr'), P('Unit Price', 'thr'), P('Amount', 'thr')]]
    for label, qty, rate, amount in calc['rows']:
        data.append([P(label, 'cell'), P(str(qty), 'num'), P(gbp(rate), 'num'), P(gbp(amount), 'num')])
    if calc['min_adj'] > 0:
        data.append([P('Minimum charge adjustment', 'cell'), P('', 'num'), P('', 'num'),
                     P(gbp(calc['min_adj']), 'num')])

    table = Table(data, colWidths=[W_CONTENT - 250, 55, 95, 100], hAlign='LEFT')
    table.setStyle(TableStyle([
        ('VALIGN',        (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING',    (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('LEFTPADDING',   (0, 0), (-1, -1), 6),
        ('RIGHTPADDING',  (0, 0), (-1, -1), 6),
        ('BACKGROUND',    (0, 0), (-1, 0), C(SURFACE)),
        ('LINEBELOW',     (0, 0), (-1, 0), 0.6, C(LINE)),
        ('LINEBELOW',     (0, 1), (-1, -2), 0.5, C(LINE)),
        ('LINEBELOW',     (0, -1), (-1, -1), 0.8, C(LINE)),
    ]))

    doc = SimpleDocTemplate(
        path, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN,
        title='Commissioning Quotation \u2014 %s' % product, author='Eaton',
    )
    notes = [
        'All prices are in GBP and exclude VAT.',
        'A minimum charge of one commissioning day applies to each visit.',
    ]
    doc.build([
        Band(W_CONTENT),
        Spacer(1, 16),
        table,
        Spacer(1, 14),
        TotalBar(W_CONTENT, calc['total']),
        Spacer(1, 12),
    ] + [P(n, 'note') for n in notes])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type",           required=True, choices=["cg", "easicheck"])
    ap.add_argument("--panels",         required=True, type=int)
    ap.add_argument("--lumis",          required=True, type=int)
    ap.add_argument("--cards",          required=True, type=int)
    ap.add_argument("--software",       required=True, choices=["yes", "no"])
    ap.add_argument("--central-london", required=True, choices=["yes", "no"], dest="central_london")
    ap.add_argument("--ref",            default="")
    ap.add_argument("--outdir",         required=True)
    args = ap.parse_args()

    if args.panels <= 0:
        print("__ERROR__:enter at least one panel")
        sys.exit(1)
    if args.type == "cg" and args.panels > 15:
        print("__ERROR__:CG Line+ supports up to 15 panels only")
        sys.exit(1)

    calc = calculate(args.type, args.panels, max(0, args.lumis), max(0, args.cards),
                     args.software == "yes", args.central_london == "yes")
    if calc is None:
        print("__ERROR__:no pricing tier matches that panel count")
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    pdf = os.path.join(args.outdir, "Commission_Calculation.pdf")

    try:
        build_pdf(pdf, args.type, calc, args.panels, args.ref.strip())
    except ImportError:
        print("__ERROR__:reportlab not installed \u2014 run: pip install reportlab")
        sys.exit(1)
    except Exception as e:
        print(f"__ERROR__:the PDF could not be built: {e}")
        sys.exit(1)

    if not os.path.exists(pdf):
        print("__ERROR__:the PDF was not written to disk")
        sys.exit(1)

    print(f"__PDF__:{pdf}")
    sys.exit(0)


if __name__ == "__main__":
    main()
