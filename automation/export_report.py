#!/usr/bin/env python
"""export_report.py — turn a Vector Job Report into a designed PDF or Word document.

Reads a job JSON from --job and writes the binary to --out. Unlike export_doc.py
(which renders free-form markdown from a chat answer), this takes the *structured*
report — totals, categories, per-day activity, every job thread — and lays it out:

  cover band → KPI tiles → clickable contents → category bars → activity chart
  → one section per category with a job table → folders scanned

Both formats carry INTERNAL links: the contents jumps to a section, every section
header jumps back. PDF gets named destinations + a bookmark outline (the sidebar
in any reader); DOCX gets bookmarks + w:hyperlink w:anchor, so the Navigation pane
works and the links are clickable in Word.

PDF uses reportlab. DOCX is written by hand (a .docx is a zip of XML) so no
python-docx dependency is needed — same trick as export_doc.py.
"""
import os
import re
import html
import json
import zipfile
import argparse
from datetime import datetime

# ── Print palette — the light-theme Vector tokens, tuned for paper ──────────────
ACCENT   = '#4f7cf7'
ACCENT_D = '#2f55b8'   # accent on white (links, small text) — darker so it reads
INK1     = '#15151d'
INK2     = '#585866'
INK3     = '#8a8a98'
LINE     = '#e2e2ea'
SURFACE  = '#f6f6fa'
OK       = '#059669'
WARN     = '#b45309'
VIOLET   = '#7c3aed'

# Same values, same order as CAT_COLORS in src/pages/Report.tsx, so a printed bar
# is the colour the screen showed. Slot 0 is the screen accent, not the (slightly
# darker) print ACCENT above — otherwise a fallback colour lands next to a
# client-supplied one and the two are indistinguishable.
CAT_PALETTE = ['#5b8cff', OK, VIOLET, WARN, '#e0629b', '#3fb8b0', '#8b7bd8',
               '#d98a3f', '#5aa9e6', '#9aa2b1']


# ── Small helpers ──────────────────────────────────────────────────────────────
def clean(s):
    """Drop control characters — they make Word refuse to open a document."""
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(s or ''))


def esc(s):
    return html.escape(clean(s), quote=False)


def short(s, n):
    s = clean(s).strip()
    return s if len(s) <= n else s[:n - 1].rstrip() + '\u2026'


def day(iso):
    """ISO timestamp → DD/MM."""
    s = clean(iso)[:10]
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    return '%s/%s' % (m.group(3), m.group(2)) if m else s


def day_full(iso):
    s = clean(iso)[:10]
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    return '%s/%s/%s' % (m.group(3), m.group(2), m.group(1)) if m else s


def leaf(folder):
    return clean(folder).split('\\')[-1] or clean(folder)


def who_list(counterpart):
    """A thread's counterpart is a comma-joined address list (server.ts builds it
    from t.others). Reduce each entry to the part a human recognises."""
    names = []
    for p in re.split(r'[;,]', clean(counterpart)):
        p = p.strip()
        if not p:
            continue
        m = re.match(r'^(.*?)\s*<([^>]+)>$', p)          # "Name <a@b.com>"
        p = (m.group(1) or m.group(2)) if m else p
        if '@' in p and ' ' not in p.strip():
            p = p.split('@')[0]                          # bare address → local part
        p = p.strip(' "\'')
        if p and p not in names:
            names.append(p)
    return names


def who(counterpart, keep=2):
    """"a@x.com, b@x.com, c@x.com" → "a, b +1" — printed verbatim the raw list
    wraps into an unreadable column."""
    names = who_list(counterpart)
    if not names:
        return ''
    return ', '.join(names[:keep]) + (' +%d' % (len(names) - keep) if len(names) > keep else '')


def plural(n, one, many=None):
    return one if n == 1 else (many or one + 's')


class Model(object):
    """Everything the two renderers need, derived once from the job payload."""

    def __init__(self, job):
        rng            = job.get('range') or {}
        self.frm       = clean(rng.get('from'))
        self.to        = clean(rng.get('to'))
        self.title     = clean(job.get('title')) or 'Job report'
        self.generated = clean(job.get('generatedAt')) or datetime.now().isoformat()
        self.owner     = clean(job.get('owner'))
        self.truncated = bool(job.get('truncated'))
        self.scanned   = int(job.get('scanned') or 0)
        self.threads   = [t for t in (job.get('threads') or []) if isinstance(t, dict)]
        self.filter    = job.get('filter') or {}
        self.total_all = int(self.filter.get('total') or len(self.threads))
        self.filtered  = len(self.threads) < self.total_all

        colors_in = job.get('catColors') or {}

        # Categories, biggest first — derived from what is actually exported, so a
        # filtered export stays internally consistent.
        groups = {}
        for t in self.threads:
            groups.setdefault(clean(t.get('category')) or 'Uncategorised', []).append(t)
        order = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0].lower()))

        n = len(self.threads) or 1
        self.categories = []
        # The screen sends its own colour per category; anything it did not colour
        # takes the next palette slot that is still free, so no two bars match.
        taken = {str(v).lower() for v in colors_in.values()}
        spare = [c for c in CAT_PALETTE if c.lower() not in taken] or CAT_PALETTE
        for i, (name, rows) in enumerate(order):
            rows.sort(key=lambda r: clean(r.get('last')), reverse=True)
            color = colors_in.get(name)
            if not color:
                color = spare.pop(0) if spare else CAT_PALETTE[i % len(CAT_PALETTE)]
            self.categories.append({
                'name':    name,
                'anchor':  'cat%d' % i,
                'color':   color,
                'threads': rows,
                'count':   len(rows),
                'msgs':    sum(int(r.get('msgs') or 0) for r in rows),
                'sent':    sum(int(r.get('sent') or 0) for r in rows),
                'done':    sum(1 for r in rows if r.get('completed')),
                'pct':     int(round(len(rows) * 100.0 / n)),
            })

        self.jobs    = len(self.threads)
        self.msgs    = sum(int(t.get('msgs') or 0) for t in self.threads)
        self.replies = sum(int(t.get('sent') or 0) for t in self.threads)
        self.done    = sum(1 for t in self.threads if t.get('completed'))

        # Per-day activity, dated by the last message of each job.
        daily = {}
        for t in self.threads:
            d = clean(t.get('last'))[:10]
            if d:
                daily[d] = daily.get(d, 0) + 1
        self.daily = sorted(daily.items())

        # Folders, busiest first.
        folders = {}
        for t in self.threads:
            for f in (t.get('folders') or []):
                folders[clean(f)] = folders.get(clean(f), 0) + 1
        self.folders = sorted(folders.items(), key=lambda kv: (-kv[1], kv[0].lower()))

        # Who the work was with — counted per person, not per address list.
        people = {}
        for t in self.threads:
            for c in who_list(t.get('counterpart')):
                people[c] = people.get(c, 0) + 1
        self.people = sorted(people.items(), key=lambda kv: (-kv[1], kv[0].lower()))

    def headline(self):
        """One sentence anyone can grasp without reading a single table."""
        if not self.jobs:
            return 'No jobs were recorded in this period.'
        bits = ['%d %s closed across %d %s' % (
            self.jobs, plural(self.jobs, 'job'),
            len(self.categories), plural(len(self.categories), 'category', 'categories'))]
        bits.append('%d %s written over %d handled %s' % (
            self.replies, plural(self.replies, 'reply', 'replies'),
            self.msgs, plural(self.msgs, 'message')))
        if self.done:
            bits.append('%d filed as completed' % self.done)
        return ', '.join(bits) + '.'

    def highlights(self):
        out = []
        if self.categories:
            c = self.categories[0]
            out.append(('Biggest area of work', '%s — %d %s (%d%%)'
                        % (c['name'], c['count'], plural(c['count'], 'job'), c['pct'])))
        if self.daily:
            d, n = max(self.daily, key=lambda kv: kv[1])
            out.append(('Busiest day', '%s — %d %s closed' % (day_full(d), n, plural(n, 'job'))))
        if self.people:
            p, n = self.people[0]
            out.append(('Most frequent contact', '%s — %d %s' % (short(p, 46), n, plural(n, 'job'))))
        if self.jobs:
            out.append(('Average per job', '%.1f messages, %.1f replies'
                        % (self.msgs / float(self.jobs), self.replies / float(self.jobs))))
        return out


# ══════════════════════════════════════════════════════════════════════════════
# PDF
# ══════════════════════════════════════════════════════════════════════════════
def build_pdf(m, path):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas as pdfcanvas
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                    TableStyle, Flowable, CondPageBreak, KeepTogether)

    # ── Fonts ──────────────────────────────────────────────────────────────────
    # The built-in Helvetica is Latin-1 only, which mangles accented names from
    # the French/Hungarian mailboxes. Register a real Unicode TTF when Windows
    # has one; fall back to Helvetica otherwise.
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
                pdfmetrics.registerFontFamily(fam, normal=fam, bold=fam + '-Bold',
                                              italic=fam, boldItalic=fam + '-Bold')
                FONT, FONT_B = fam, fam + '-Bold'
                break
        except Exception:
            continue

    C = colors.HexColor
    W_CONTENT = A4[0] - 2 * 1.5 * cm      # 510pt of usable width

    def st(**kw):
        kw.setdefault('fontName', FONT)
        kw.setdefault('textColor', C(INK1))
        return ParagraphStyle(kw.pop('name'), **kw)

    S = {
        'h2':    st(name='h2',   fontName=FONT_B, fontSize=13,   leading=17, spaceAfter=2),
        'h3':    st(name='h3',   fontName=FONT_B, fontSize=10.5, leading=14),
        'body':  st(name='body', fontSize=9.5,  leading=13.5, textColor=C(INK2)),
        'lead':  st(name='lead', fontSize=10.5, leading=15,   textColor=C(INK2)),
        'cell':  st(name='cell', fontSize=8.8,  leading=11.6),
        'sub':   st(name='sub',  fontSize=7.8,  leading=10.4, textColor=C(INK3)),
        'num':   st(name='num',  fontSize=8.8,  leading=11.6, alignment=1, textColor=C(INK2)),
        'th':    st(name='th',   fontName=FONT_B, fontSize=7.6, leading=10, textColor=C(INK3)),
        'thc':   st(name='thc',  fontName=FONT_B, fontSize=7.6, leading=10, textColor=C(INK3), alignment=1),
        'toc':   st(name='toc',  fontSize=9.6,  leading=14),
        'tocn':  st(name='tocn', fontSize=9.6,  leading=14, alignment=TA_RIGHT, textColor=C(INK3)),
        'back':  st(name='back', fontSize=8,    leading=11, alignment=TA_RIGHT),
    }
    link = lambda dest, text, color=ACCENT_D: '<a href="#%s" color="%s">%s</a>' % (dest, color, text)

    # ── Custom flowables ───────────────────────────────────────────────────────
    class Band(Flowable):
        """Cover panel: accent slab with the title, period and provenance."""
        def __init__(self, width):
            Flowable.__init__(self)
            self.width, self.height = width, 78

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c, h = self.canv, self.height
            c.setFillColor(C(ACCENT))
            c.roundRect(0, 0, self.width, h, 10, stroke=0, fill=1)
            c.setFillColor(colors.Color(1, 1, 1, 0.14))          # subtle top highlight
            c.roundRect(0, h - 26, self.width, 26, 10, stroke=0, fill=1)
            c.rect(0, h - 26, self.width, 14, stroke=0, fill=1)

            c.setFillColor(colors.white)
            c.setFont(FONT_B, 20)
            c.drawString(20, h - 34, m.title)
            c.setFont(FONT, 10.5)
            c.setFillColor(colors.Color(1, 1, 1, 0.9))
            c.drawString(20, h - 51, '%s \u2013 %s' % (m.frm, m.to))
            c.setFont(FONT, 8.2)
            c.setFillColor(colors.Color(1, 1, 1, 0.78))
            c.drawString(20, h - 65, 'Every mail folder, grouped into one job per conversation')

            c.setFont(FONT, 8.2)
            c.setFillColor(colors.Color(1, 1, 1, 0.85))
            gen = m.generated[:16].replace('T', ' ')
            c.drawRightString(self.width - 20, h - 34, 'VECTOR')
            c.setFillColor(colors.Color(1, 1, 1, 0.72))
            c.drawRightString(self.width - 20, h - 47, 'Generated %s' % gen)
            if m.owner:
                c.drawRightString(self.width - 20, h - 59, short(m.owner, 40))

    class Kpis(Flowable):
        """Four tiles: the numbers that answer 'how much work was this?'"""
        def __init__(self, width, tiles):
            Flowable.__init__(self)
            self.width, self.height, self.tiles = width, 58, tiles

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c, n = self.canv, len(self.tiles)
            gap = 9
            w = (self.width - gap * (n - 1)) / float(n)
            for i, (label, value, sub, col) in enumerate(self.tiles):
                x = i * (w + gap)
                c.setFillColor(C(SURFACE))
                c.setStrokeColor(C(LINE))
                c.setLineWidth(0.6)
                c.roundRect(x, 0, w, self.height, 7, stroke=1, fill=1)
                c.setFillColor(C(col))
                c.rect(x + 10, self.height - 4, 22, 2.5, stroke=0, fill=1)
                c.setFillColor(C(INK3))
                c.setFont(FONT, 7.4)
                c.drawString(x + 10, self.height - 19, label.upper())
                c.setFillColor(C(INK1))
                c.setFont(FONT_B, 19)
                c.drawString(x + 10, self.height - 40, str(value))
                c.setFillColor(C(INK3))
                c.setFont(FONT, 7.4)
                c.drawString(x + 10, 9, short(sub, 30))

    class Bars(Flowable):
        """Category distribution — label, proportional bar, count, share."""
        ROW = 21

        def __init__(self, width, rows):
            Flowable.__init__(self)
            self.width, self.rows = width, rows
            self.height = self.ROW * len(rows)

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c = self.canv
            label_w, num_w = 168, 78
            bar_x = label_w + 10
            bar_w = self.width - label_w - num_w - 20
            top = self.height
            biggest = max([r['count'] for r in self.rows] or [1])
            for i, r in enumerate(self.rows):
                y = top - (i + 1) * self.ROW + 5
                c.setFillColor(C(r['color']))
                c.roundRect(0, y + 2, 6, 6, 1.5, stroke=0, fill=1)
                c.setFillColor(C(INK1))
                c.setFont(FONT, 9)
                name, cap = r['name'], label_w - 14
                if pdfmetrics.stringWidth(name, FONT, 9) > cap:
                    while len(name) > 3 and pdfmetrics.stringWidth(name + '\u2026', FONT, 9) > cap:
                        name = name[:-1]
                    name += '\u2026'
                c.drawString(11, y + 2, name)

                c.setFillColor(C('#edeef3'))
                c.roundRect(bar_x, y + 1, bar_w, 8, 4, stroke=0, fill=1)
                frac = r['count'] / float(biggest)
                fw = max(8, bar_w * frac)
                c.setFillColor(C(r['color']))
                c.roundRect(bar_x, y + 1, fw, 8, 4, stroke=0, fill=1)

                c.setFillColor(C(INK1))
                c.setFont(FONT_B, 9)
                c.drawRightString(self.width - 34, y + 2, str(r['count']))
                c.setFillColor(C(INK3))
                c.setFont(FONT, 8.2)
                c.drawRightString(self.width, y + 2, '%d%%' % r['pct'])

    class DailyChart(Flowable):
        """Jobs closed per day across the period."""
        def __init__(self, width, daily):
            Flowable.__init__(self)
            self.width, self.height, self.daily = width, 92, daily

        def wrap(self, *_):
            return self.width, self.height

        def draw(self):
            c = self.canv
            base, top = 16, self.height - 12
            span = top - base
            peak = max([n for _, n in self.daily] or [1])
            n = len(self.daily)
            gap = 2 if n <= 60 else 1
            bw = max(1.6, (self.width - gap * (n - 1)) / float(n))

            c.setStrokeColor(C(LINE))
            c.setLineWidth(0.6)
            c.line(0, base, self.width, base)
            c.setDash(1, 2)
            c.line(0, base + span, self.width, base + span)
            c.setDash()
            c.setFillColor(C(INK3))
            c.setFont(FONT, 7)
            c.drawString(0, base + span + 3, 'peak %d %s' % (peak, plural(peak, 'job')))

            for i, (d, v) in enumerate(self.daily):
                x = i * (bw + gap)
                h = max(1.5, span * (v / float(peak)))
                c.setFillColor(C(ACCENT) if v < peak else C(ACCENT_D))
                c.roundRect(x, base, bw, h, min(2, bw / 2.0), stroke=0, fill=1)

            c.setFillColor(C(INK3))
            c.setFont(FONT, 7)
            c.drawString(0, 5, day_full(self.daily[0][0]))
            c.drawRightString(self.width, 5, day_full(self.daily[-1][0]))

    class Tick(Flowable):
        """Drawn, not typed — no text font is guaranteed to carry a check mark."""
        def __init__(self, size=9.5, color=OK):
            Flowable.__init__(self)
            self.size, self.color = size, color
            self.hAlign = 'CENTER'

        def wrap(self, *_):
            return self.size, self.size + 2

        def draw(self):
            c, s = self.canv, self.size
            c.setStrokeColor(C(self.color))
            c.setLineWidth(1.5)
            c.setLineCap(1)
            c.setLineJoin(1)
            p = c.beginPath()
            p.moveTo(0.05 * s, 0.52 * s)
            p.lineTo(0.36 * s, 0.20 * s)
            p.lineTo(0.97 * s, 0.86 * s)
            c.drawPath(p)

    # ── Story ──────────────────────────────────────────────────────────────────
    story = []

    def anchor_heading(text, dest, outline_level=0, back=True):
        """Section header: a named destination + a link back to the contents."""
        head = Paragraph('<a name="%s"/>%s' % (dest, esc(text)), S['h2'])
        outline = (clean(text), dest, outline_level)
        if not back:
            head._outline = outline
            return [head]
        row = Table([[head, Paragraph(link('toc', 'Contents \u2191', INK3), S['back'])]],
                    colWidths=[W_CONTENT - 90, 90])
        row._outline = outline      # the Table is what the doc template sees, not the Paragraph
        row.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        return [row]

    story.append(Band(W_CONTENT))
    story.append(Spacer(1, 12))
    story.append(Paragraph('<a name="top"/>' + esc(m.headline()), S['lead']))
    story.append(Spacer(1, 10))
    story.append(Kpis(W_CONTENT, [
        ('Jobs done',    m.jobs,    '%s \u2013 %s' % (m.frm, m.to), ACCENT),
        ('Replies sent', m.replies, 'messages you wrote',           OK),
        ('Mail handled', m.msgs,    '%d scanned' % m.scanned,       VIOLET),
        ('Filed done',   m.done,    'in a completed folder',        WARN),
    ]))
    story.append(Spacer(1, 12))

    notes = []
    if m.filtered:
        notes.append('Filtered export: %d of %d jobs%s%s.' % (
            m.jobs, m.total_all,
            ' in "%s"' % clean(m.filter.get('category')) if m.filter.get('category') else '',
            ' matching "%s"' % clean(m.filter.get('query')) if m.filter.get('query') else ''))
    if m.truncated:
        notes.append('The scan hit its message cap, so this period is only partly covered.')
    for note in notes:
        story.append(Table([[Paragraph(esc(note), S['body'])]], colWidths=[W_CONTENT],
                           style=TableStyle([
                               ('BACKGROUND', (0, 0), (-1, -1), C('#fdf6ec')),
                               ('LINEBEFORE', (0, 0), (0, -1), 2.5, C(WARN)),
                               ('LEFTPADDING', (0, 0), (-1, -1), 9),
                               ('RIGHTPADDING', (0, 0), (-1, -1), 9),
                               ('TOPPADDING', (0, 0), (-1, -1), 6),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                           ])))
        story.append(Spacer(1, 8))

    # Highlights + contents, side by side.
    hi = m.highlights()
    hi_rows = []
    for label, value in hi:
        hi_rows.append([Paragraph(esc(label), S['sub']), ''])
        hi_rows.append([Paragraph('<b>%s</b>' % esc(value), S['cell']), ''])
    hi_tbl = Table(hi_rows or [['', '']], colWidths=[W_CONTENT / 2 - 20, 0])
    hi_tbl.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
    ] + [('BOTTOMPADDING', (0, i), (-1, i), 7) for i in range(1, len(hi_rows), 2)]))

    toc_rows = [[Paragraph(link('sec-cat', 'Work by category'), S['toc']),
                 Paragraph('%d' % len(m.categories), S['tocn'])]]
    if len(m.daily) > 1:
        toc_rows.append([Paragraph(link('sec-daily', 'Jobs closed per day'), S['toc']),
                         Paragraph('%d %s' % (len(m.daily), plural(len(m.daily), 'day')), S['tocn'])])
    for c in m.categories:
        toc_rows.append([Paragraph('<font color="%s">\u25a0</font>  %s'
                                   % (c['color'], link(c['anchor'], esc(c['name']))), S['toc']),
                         Paragraph(str(c['count']), S['tocn'])])
    if m.folders:
        toc_rows.append([Paragraph(link('sec-folders', 'Folders scanned'), S['toc']),
                         Paragraph(str(len(m.folders)), S['tocn'])])
    toc_tbl = Table(toc_rows, colWidths=[W_CONTENT / 2 - 66, 46])
    toc_tbl.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
        ('LINEBELOW', (0, 0), (-1, -2), 0.4, C('#eeeef3')),
    ]))

    panel = Table([[
        [Paragraph('<a name="toc"/>Highlights', S['h3']), Spacer(1, 6), hi_tbl],
        [Paragraph('Contents', S['h3']), Spacer(1, 6), toc_tbl],
    ]], colWidths=[W_CONTENT / 2, W_CONTENT / 2])
    panel.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, -1), C(SURFACE)),
        ('BOX', (0, 0), (-1, -1), 0.6, C(LINE)),
        ('LINEAFTER', (0, 0), (0, 0), 0.6, C(LINE)),
        ('LEFTPADDING', (0, 0), (-1, -1), 14), ('RIGHTPADDING', (0, 0), (-1, -1), 14),
        ('TOPPADDING', (0, 0), (-1, -1), 12), ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
    ]))
    story.append(panel)
    story.append(Spacer(1, 16))

    # Category breakdown.
    if m.categories:
        story += anchor_heading('Work by category', 'sec-cat', 0, back=False)
        story.append(Paragraph('One job = one email conversation you replied to or filed as done.', S['sub']))
        story.append(Spacer(1, 8))
        story.append(Bars(W_CONTENT, m.categories))
        story.append(Spacer(1, 16))

    # Daily activity.
    if len(m.daily) > 1:
        story.append(CondPageBreak(5 * cm))
        story += anchor_heading('Jobs closed per day', 'sec-daily', 0)
        story.append(Paragraph('Dated by the last message in each conversation.', S['sub']))
        story.append(Spacer(1, 8))
        story.append(DailyChart(W_CONTENT, m.daily))
        story.append(Spacer(1, 16))

    # One section per category.
    COLS = [214, 96, 74, 34, 34, 58]
    head = [Paragraph('JOB', S['th']), Paragraph('WITH', S['th']), Paragraph('PERIOD', S['th']),
            Paragraph('MSG', S['thc']), Paragraph('SENT', S['thc']), Paragraph('FILED', S['thc'])]

    for c in m.categories:
        # Never leave a section header stranded at the foot of a page.
        story.append(CondPageBreak(3.4 * cm))
        block = anchor_heading(c['name'], c['anchor'], 0)
        block.append(Paragraph(
            '%d %s \u00b7 %d %s \u00b7 %d %s sent \u00b7 %d filed as completed'
            % (c['count'], plural(c['count'], 'job'), c['msgs'], plural(c['msgs'], 'message'),
               c['sent'], plural(c['sent'], 'reply', 'replies'), c['done']), S['sub']))
        block.append(Spacer(1, 6))

        data = [head]
        for t in c['threads']:
            lines = ['<b>%s</b>' % esc(short(t.get('topic'), 150))]
            if clean(t.get('summary')):
                lines.append('<font size="7.8" color="%s">%s</font>'
                             % (INK3, esc(short(t.get('summary'), 240))))
            fold = ' \u00b7 '.join(dict.fromkeys(leaf(f) for f in (t.get('folders') or [])))
            if fold:
                lines.append('<font size="7.2" color="%s">in %s</font>' % (INK3, esc(short(fold, 120))))
            data.append([
                Paragraph('<br/>'.join(lines), S['cell']),
                Paragraph(esc(short(who(t.get('counterpart')), 60)) or '\u2014', S['cell']),
                Paragraph('%s \u2013 %s' % (day(t.get('first')), day(t.get('last'))), S['cell']),
                Paragraph(str(int(t.get('msgs') or 0)), S['num']),
                Paragraph(str(int(t.get('sent') or 0)), S['num']),
                Tick() if t.get('completed') else Paragraph('<font color="%s">\u2013</font>' % INK3, S['num']),
            ])

        tbl = Table(data, colWidths=COLS, repeatRows=1)
        style = [
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LINEBELOW', (0, 0), (-1, 0), 1.1, C(c['color'])),
            ('LINEBELOW', (0, 1), (-1, -2), 0.4, C('#ededf3')),
            ('TOPPADDING', (0, 0), (-1, 0), 3), ('BOTTOMPADDING', (0, 0), (-1, 0), 4),
        ]
        for i in range(1, len(data)):
            if i % 2 == 0:
                style.append(('BACKGROUND', (0, i), (-1, i), C('#fafafc')))
        tbl.setStyle(TableStyle(style))
        block.append(tbl)
        block.append(Spacer(1, 15))
        story += block

    # Folders.
    if m.folders:
        story.append(CondPageBreak(3.4 * cm))
        story += anchor_heading('Folders scanned', 'sec-folders', 0)
        story.append(Paragraph('Every mail folder that held a message in this period.', S['sub']))
        story.append(Spacer(1, 6))
        pairs = [(f, n) for f, n in m.folders]
        half = (len(pairs) + 1) // 2
        rows = []
        for i in range(half):
            a = pairs[i]
            b = pairs[i + half] if i + half < len(pairs) else None
            rows.append([
                Paragraph(esc(short(a[0].replace('\\', ' \u203a '), 62)), S['cell']),
                Paragraph(str(a[1]), S['num']),
                Paragraph(esc(short(b[0].replace('\\', ' \u203a '), 62)), S['cell']) if b else '',
                Paragraph(str(b[1]), S['num']) if b else '',
            ])
        ft = Table(rows, colWidths=[210, 45, 210, 45])
        ft.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LINEBELOW', (0, 0), (-1, -2), 0.4, C('#ededf3')),
        ]))
        # A short folder list should not dangle a single row onto its own page.
        story.append(KeepTogether(ft) if len(rows) <= 14 else ft)

    if not m.jobs:
        story.append(Paragraph('No jobs were found in this period.', S['body']))

    # ── Document shell: footer + PDF bookmark outline ──────────────────────────
    class Doc(SimpleDocTemplate):
        def afterFlowable(self, flowable):
            out = getattr(flowable, '_outline', None)
            if out:
                text, key, level = out
                self.canv.addOutlineEntry(text, key, level=level, closed=0)

    class Footer(pdfcanvas.Canvas):
        """Two-pass canvas so the footer can say 'Page 2 of 7'."""
        def __init__(self, *a, **kw):
            pdfcanvas.Canvas.__init__(self, *a, **kw)
            self._pages = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self._footer(total)
                pdfcanvas.Canvas.showPage(self)
            pdfcanvas.Canvas.save(self)

        def _footer(self, total):
            x, y = 1.5 * cm, 1.05 * cm
            self.setStrokeColor(C(LINE))
            self.setLineWidth(0.6)
            self.line(x, y + 12, A4[0] - x, y + 12)
            self.setFont(FONT, 7.4)
            self.setFillColor(C(INK3))
            self.drawString(x, y, 'Vector \u00b7 %s \u00b7 %s \u2013 %s' % (m.title, m.frm, m.to))
            self.drawRightString(A4[0] - x, y, 'Page %d of %d' % (self._pageNumber, total))

    doc = Doc(path, pagesize=A4, title='%s %s - %s' % (m.title, m.frm, m.to),
              author='Vector', subject='Job report',
              leftMargin=1.5 * cm, rightMargin=1.5 * cm,
              topMargin=1.3 * cm, bottomMargin=1.9 * cm)
    doc.build(story, canvasmaker=Footer)


# ══════════════════════════════════════════════════════════════════════════════
# DOCX — a .docx is a zip of XML, so no python-docx needed
# ══════════════════════════════════════════════════════════════════════════════
CONTENT_W = 9638          # A4 minus 1134-twip margins, in twips


def build_docx(m, path):
    hexc = lambda c: clean(c).lstrip('#').upper()[:6] or '000000'
    bookmark_id = [100]

    # NOTE: every helper below emits child elements in the order the OOXML schema
    # demands (CT_RPr / CT_PPr / CT_TcPr / CT_TblPr sequences). Word does not
    # tolerate a swapped pair — it refuses the file as "corrupted".
    def runs(text, bold=False, size=20, color=INK1, italic=False, caps=False):
        rpr = '<w:rPr>'
        if bold:
            rpr += '<w:b/>'
        if italic:
            rpr += '<w:i/>'
        if caps:
            rpr += '<w:caps/>'
        rpr += '<w:color w:val="%s"/>' % hexc(color)
        if caps:
            rpr += '<w:spacing w:val="14"/>'
        rpr += '<w:sz w:val="%d"/><w:szCs w:val="%d"/></w:rPr>' % (size, size)
        return '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(text))

    def para(inner, after=120, before=0, align=None, style=None, outline=None,
             shd=None, ind=None, keep_next=False):
        ppr = '<w:pPr>'
        if style:
            ppr += '<w:pStyle w:val="%s"/>' % style
        if keep_next:
            ppr += '<w:keepNext/>'
        if shd:
            ppr += '<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % hexc(shd)
        ppr += '<w:spacing w:before="%d" w:after="%d"/>' % (before, after)
        if ind:
            ppr += '<w:ind w:left="%d" w:right="%d"/>' % (ind, ind)
        if align:
            ppr += '<w:jc w:val="%s"/>' % align
        if outline is not None:
            ppr += '<w:outlineLvl w:val="%d"/>' % outline
        ppr += '</w:pPr>'
        return '<w:p>%s%s</w:p>' % (ppr, inner)

    def bookmark(name):
        bookmark_id[0] += 1
        i = bookmark_id[0]
        return ('<w:bookmarkStart w:id="%d" w:name="%s"/><w:bookmarkEnd w:id="%d"/>' % (i, name, i))

    def anchor_link(dest, text, size=20, color=ACCENT_D, bold=False):
        rpr = ('<w:rPr>%s<w:color w:val="%s"/>'
               '<w:sz w:val="%d"/><w:szCs w:val="%d"/><w:u w:val="single"/></w:rPr>'
               % ('<w:b/>' if bold else '', hexc(color), size, size))
        return ('<w:hyperlink w:anchor="%s"><w:r>%s<w:t xml:space="preserve">%s</w:t></w:r></w:hyperlink>'
                % (dest, rpr, esc(text)))

    def cell(inner, width, shd=None, valign='top', span=None, borders=True, margin=90,
             top_border=None, left_border=None):
        tcpr = '<w:tcPr><w:tcW w:w="%d" w:type="dxa"/>' % width
        if span:
            tcpr += '<w:gridSpan w:val="%d"/>' % span
        if not borders or top_border or left_border:
            edge = {'top': top_border, 'left': left_border}
            edges = []
            for s in ('top', 'left', 'bottom', 'right'):
                if edge.get(s):
                    edges.append('<w:%s w:val="single" w:sz="%d" w:space="0" w:color="%s"/>'
                                 % (s, edge[s][1], hexc(edge[s][0])))
                else:
                    edges.append('<w:%s w:val="none" w:sz="0" w:space="0" w:color="auto"/>' % s)
            tcpr += '<w:tcBorders>%s</w:tcBorders>' % ''.join(edges)
        if shd:
            tcpr += '<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % hexc(shd)
        tcpr += ('<w:tcMar><w:top w:w="%d" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>'
                 '<w:bottom w:w="%d" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>'
                 % (margin, margin))
        tcpr += '<w:vAlign w:val="%s"/></w:tcPr>' % valign
        return '<w:tc>%s%s</w:tc>' % (tcpr, inner)

    def table(rows, widths, borders='grid', header_rows=0):
        if borders == 'none':
            b = ''.join('<w:%s w:val="none" w:sz="0" w:space="0" w:color="auto"/>' % s
                        for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
        elif borders == 'rows':
            b = (''.join('<w:%s w:val="none" w:sz="0" w:space="0" w:color="auto"/>' % s
                         for s in ('top', 'left', 'bottom', 'right', 'insideV'))
                 + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="EDEDF3"/>')
        else:
            b = ''.join('<w:%s w:val="single" w:sz="4" w:space="0" w:color="E2E2EA"/>' % s
                        for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
        out = ('<w:tbl><w:tblPr><w:tblW w:w="%d" w:type="dxa"/>'
               '<w:tblBorders>%s</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>'
               % (sum(widths), b))
        out += '<w:tblGrid>%s</w:tblGrid>' % ''.join('<w:gridCol w:w="%d"/>' % w for w in widths)
        for i, r in enumerate(rows):
            trpr = '<w:trPr>%s</w:trPr>' % ('<w:tblHeader/>' if i < header_rows else '')
            out += '<w:tr>%s%s</w:tr>' % (trpr, r)
        return out + '</w:tbl>'

    def bar(pct, color, width=2600):
        """A proportional bar — a fixed-width 2-cell nested table."""
        filled = max(60, int(width * max(0, min(100, pct)) / 100.0))
        rest = max(0, width - filled)
        cells = cell(para('', after=0), filled, shd=color, borders=False, margin=0)
        if rest:
            cells += cell(para('', after=0), rest, shd='EDEEF3', borders=False, margin=0)
        # A cell that holds a table must still end with a paragraph, or Word balks.
        return (table([cells], [filled, rest] if rest else [filled], borders='none')
                + para('', after=0))

    def heading(text, dest, sub=None, size=26, color=INK1, top=240):
        """Section title: a bookmark, the text, a link back to the contents, and a
        hairline in the section's colour under the whole block."""
        left = bookmark(dest) + runs(text, bold=True, size=size, color=color)
        right = anchor_link('toc', 'Contents \u2191', size=15, color=INK3)
        row = (cell(para(left, after=0, outline=0), CONTENT_W - 1700, borders=False)
               + cell(para(right, after=0, align='right'), 1700, borders=False, valign='bottom'))
        return ((para('', after=60, before=top) if top else '')
                + table([row], [CONTENT_W - 1700, 1700], borders='none')
                + (para(runs(sub, size=15, color=INK3), after=60) if sub else '')
                + '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" '
                  'w:color="%s"/></w:pBdr><w:spacing w:after="140"/></w:pPr></w:p>' % hexc(color))

    body = []

    # ── Cover band ─────────────────────────────────────────────────────────────
    band = (para(runs(m.title, bold=True, size=40, color='FFFFFF'), after=40, before=120, ind=140)
            + para(runs('%s \u2013 %s' % (m.frm, m.to), size=21, color='FFFFFF'), after=40, ind=140)
            + para(runs('Every mail folder, grouped into one job per conversation \u00b7 generated %s'
                        % m.generated[:16].replace('T', ' '), size=15, color='E4ECFF'),
                   after=140, ind=140))
    body.append(table([cell(band, CONTENT_W, shd=ACCENT, borders=False, margin=0)],
                      [CONTENT_W], borders='none'))
    body.append(para('', after=200))
    body.append(para(bookmark('top') + runs(m.headline(), size=21, color=INK2), after=200))

    # ── KPI tiles ──────────────────────────────────────────────────────────────
    tiles = [('Jobs done', m.jobs, '%s \u2013 %s' % (m.frm, m.to), ACCENT),
             ('Replies sent', m.replies, 'messages you wrote', OK),
             ('Mail handled', m.msgs, '%d scanned' % m.scanned, VIOLET),
             ('Filed done', m.done, 'in a completed folder', WARN)]
    tw = CONTENT_W // 4
    row = ''
    for label, value, sub, col in tiles:
        inner = (para(runs(label, size=13, color=INK3, caps=True), after=40)
                 + para(runs(str(value), bold=True, size=38), after=40)
                 + para(runs(short(sub, 30), size=13, color=INK3), after=0))
        # The tile's accent is its top rule, exactly as on screen and in the PDF.
        row += cell(inner, tw, shd='F6F6FA', borders=False, margin=120,
                    top_border=(col, 18))
    body.append(table([row], [tw] * 4, borders='none'))
    body.append(para('', after=200))

    for note in ([('Filtered export: %d of %d jobs%s%s.' % (
                      m.jobs, m.total_all,
                      ' in "%s"' % clean(m.filter.get('category')) if m.filter.get('category') else '',
                      ' matching "%s"' % clean(m.filter.get('query')) if m.filter.get('query') else ''))]
                 if m.filtered else []) + \
                (['The scan hit its message cap, so this period is only partly covered.']
                 if m.truncated else []):
        body.append(table([cell(para(runs(note, size=18, color=INK2), after=0),
                                CONTENT_W, shd='FDF6EC', borders=False, margin=120,
                                left_border=(WARN, 18))],
                          [CONTENT_W], borders='none'))
        body.append(para('', after=140))

    # ── Highlights + contents ──────────────────────────────────────────────────
    hi = ''
    for label, value in m.highlights():
        hi += para(runs(label, size=14, color=INK3), after=20)
        hi += para(runs(value, bold=True, size=18), after=110)
    toc = ''
    toc += para(anchor_link('sec-cat', 'Work by category'), after=60)
    if len(m.daily) > 1:
        toc += para(anchor_link('sec-daily', 'Jobs closed per day'), after=60)
    for c in m.categories:
        toc += para(runs('\u25a0  ', size=20, color=c['color'])
                    + anchor_link(c['anchor'], '%s  (%d)' % (c['name'], c['count'])), after=60)
    if m.folders:
        toc += para(anchor_link('sec-folders', 'Folders scanned'), after=60)

    half = CONTENT_W // 2
    left = para(bookmark('toc') + runs('Highlights', bold=True, size=21), after=120) + (hi or para('', after=0))
    right = para(runs('Contents', bold=True, size=21), after=120) + toc
    body.append(table([cell(left, half, shd='F6F6FA', borders=False, margin=160)
                       + cell(right, half, shd='F6F6FA', borders=False, margin=160)],
                      [half, half], borders='none'))
    body.append(para('', after=200))

    # ── Category breakdown ─────────────────────────────────────────────────────
    if m.categories:
        body.append(heading('Work by category', 'sec-cat', top=0,
                            sub='One job = one email conversation you replied to or filed as done.'))
        biggest = max(c['count'] for c in m.categories)
        W = [2900, 2900, 700, 700]
        rows = []
        for c in m.categories:
            rows.append(
                cell(para(runs('\u25a0 ', size=20, color=c['color'])
                          + runs(c['name'], size=18), after=0), W[0], borders=False, margin=60)
                + cell(bar(int(round(c['count'] * 100.0 / biggest)), c['color'], W[1] - 200),
                       W[1], borders=False, margin=60, valign='center')
                + cell(para(runs(str(c['count']), bold=True, size=18, color=INK1), after=0, align='right'),
                       W[2], borders=False, margin=60)
                + cell(para(runs('%d%%' % c['pct'], size=16, color=INK3), after=0, align='right'),
                       W[3], borders=False, margin=60))
        body.append(table(rows, W, borders='none'))
        body.append(para('', after=160))

    # ── Busiest days (a full per-day chart is a PDF luxury; Word gets the top 10)
    if len(m.daily) > 1:
        body.append(heading('Jobs closed per day', 'sec-daily',
                            sub='Dated by the last message in each conversation \u00b7 busiest days first.'))
        top_days = sorted(m.daily, key=lambda kv: (-kv[1], kv[0]))[:10]
        peak = max(n for _, n in top_days)
        W = [1700, 5300, 700]
        rows = []
        for d, n in top_days:
            rows.append(
                cell(para(runs(day_full(d), size=17), after=0), W[0], borders=False, margin=60)
                + cell(bar(int(round(n * 100.0 / peak)), ACCENT, W[1] - 300), W[1],
                       borders=False, margin=60, valign='center')
                + cell(para(runs(str(n), bold=True, size=17), after=0, align='right'),
                       W[2], borders=False, margin=60))
        body.append(table(rows, W, borders='none'))
        body.append(para('', after=160))

    # ── One section per category ───────────────────────────────────────────────
    W = [3500, 1750, 1450, 620, 620, 1698]
    for c in m.categories:
        body.append(heading(c['name'], c['anchor'], color=c['color'],
                            sub='%d %s \u00b7 %d %s \u00b7 %d %s sent \u00b7 %d filed as completed'
                                % (c['count'], plural(c['count'], 'job'),
                                   c['msgs'], plural(c['msgs'], 'message'),
                                   c['sent'], plural(c['sent'], 'reply', 'replies'), c['done'])))
        header = ''
        for i, (label, align) in enumerate([('Job', None), ('With', None), ('Period', None),
                                            ('Msg', 'center'), ('Sent', 'center'), ('Filed', 'center')]):
            header += cell(para(runs(label.upper(), bold=True, size=13, color=INK3), after=0, align=align),
                           W[i], shd='F6F6FA', borders=False)
        rows = [header]
        for i, t in enumerate(c['threads']):
            shade = 'FAFAFC' if i % 2 else None
            job = para(runs(short(t.get('topic'), 150), bold=True, size=17), after=20)
            if clean(t.get('summary')):
                job += para(runs(short(t.get('summary'), 240), size=15, color=INK2), after=20)
            fold = ' \u00b7 '.join(dict.fromkeys(leaf(f) for f in (t.get('folders') or [])))
            if fold:
                job += para(runs('in ' + short(fold, 120), size=13, color=INK3), after=0)
            rows.append(
                cell(job, W[0], shd=shade, borders=False)
                + cell(para(runs(short(who(t.get('counterpart')), 60) or '\u2014', size=16, color=INK2), after=0),
                       W[1], shd=shade, borders=False)
                + cell(para(runs('%s \u2013 %s' % (day(t.get('first')), day(t.get('last'))),
                                 size=16, color=INK2), after=0), W[2], shd=shade, borders=False)
                + cell(para(runs(str(int(t.get('msgs') or 0)), size=16, color=INK2), after=0, align='center'),
                       W[3], shd=shade, borders=False)
                + cell(para(runs(str(int(t.get('sent') or 0)), size=16, color=INK2), after=0, align='center'),
                       W[4], shd=shade, borders=False)
                + cell(para(runs('\u2713' if t.get('completed') else '\u2013', bold=bool(t.get('completed')),
                                 size=17, color=OK if t.get('completed') else INK3),
                            after=0, align='center'), W[5], shd=shade, borders=False))
        body.append(table(rows, W, borders='rows', header_rows=1))
        body.append(para('', after=160))

    # ── Folders ────────────────────────────────────────────────────────────────
    if m.folders:
        body.append(heading('Folders scanned', 'sec-folders',
                            sub='Every mail folder that held a message in this period.'))
        W2 = [4000, 819, 4000, 819]
        pairs = m.folders
        half_n = (len(pairs) + 1) // 2
        rows = []
        for i in range(half_n):
            a = pairs[i]
            b = pairs[i + half_n] if i + half_n < len(pairs) else None
            r = (cell(para(runs(short(a[0].replace('\\', ' \u203a '), 62), size=16), after=0), W2[0], borders=False)
                 + cell(para(runs(str(a[1]), size=16, color=INK3), after=0, align='right'), W2[1], borders=False))
            if b:
                r += (cell(para(runs(short(b[0].replace('\\', ' \u203a '), 62), size=16), after=0), W2[2], borders=False)
                      + cell(para(runs(str(b[1]), size=16, color=INK3), after=0, align='right'), W2[3], borders=False))
            else:
                r += cell(para('', after=0), W2[2], borders=False) + cell(para('', after=0), W2[3], borders=False)
            rows.append(r)
        body.append(table(rows, W2, borders='rows'))

    if not m.jobs:
        body.append(para(runs('No jobs were found in this period.', size=20, color=INK2)))

    _write_docx(path, ''.join(body), m)


def _write_docx(path, body_xml, m):
    sect = ('<w:sectPr><w:footerReference w:type="default" r:id="rId3"/>'
            '<w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1021" w:right="1134" w:bottom="1134" w:left="1134" '
            'w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>')
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:document '
                'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<w:body>%s%s</w:body></w:document>' % (body_xml, sect))

    def field(instr, fallback='1'):
        return ('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                '<w:r><w:instrText xml:space="preserve"> %s </w:instrText></w:r>'
                '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                '<w:r><w:t>%s</w:t></w:r>'
                '<w:r><w:fldChar w:fldCharType="end"/></w:r>' % (instr, fallback))

    grey = '<w:rPr><w:color w:val="8A8A98"/><w:sz w:val="14"/></w:rPr>'
    footer = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="E2E2EA"/></w:pBdr>'
              '<w:tabs><w:tab w:val="right" w:pos="9638"/></w:tabs></w:pPr>'
              '<w:r>%s<w:t xml:space="preserve">Vector \u00b7 %s \u00b7 %s \u2013 %s</w:t></w:r>'
              '<w:r>%s<w:tab/><w:t xml:space="preserve">Page </w:t></w:r>%s'
              '<w:r>%s<w:t xml:space="preserve"> of </w:t></w:r>%s'
              '</w:p></w:ftr>'
              % (grey, esc(m.title), esc(m.frm), esc(m.to), grey,
                 field('PAGE'), grey, field('NUMPAGES')))

    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/>'
              '<w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="15151D"/>'
              '</w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/>'
              '</w:pPr></w:pPrDefault></w:docDefaults>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
              '<w:name w:val="Normal"/><w:qFormat/></w:style>'
              '</w:styles>')

    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties '
            'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            '<dc:title>%s %s \u2013 %s</dc:title><dc:creator>Vector</dc:creator>'
            '<cp:lastModifiedBy>Vector</cp:lastModifiedBy>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">%s</dcterms:created>'
            '</cp:coreProperties>'
            % (esc(m.title), esc(m.frm), esc(m.to),
               datetime.now().strftime('%Y-%m-%dT%H:%M:%SZ')))

    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                     '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
                     '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '</Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
                '</Relationships>')

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', rels)
        z.writestr('docProps/core.xml', core)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
        z.writestr('word/styles.xml', styles)
        z.writestr('word/footer1.xml', footer)
        z.writestr('word/document.xml', document)


# ══════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--job', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    with open(args.job, 'r', encoding='utf-8') as f:
        job = json.load(f)
    fmt = str(job.get('format', '')).lower()
    m = Model(job)

    if fmt == 'pdf':
        build_pdf(m, args.out)
    elif fmt == 'docx':
        build_docx(m, args.out)
    else:
        raise SystemExit('unsupported format: %s' % fmt)
    print('OK')


if __name__ == '__main__':
    main()
