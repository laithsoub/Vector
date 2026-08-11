#!/usr/bin/env python
"""Export an Ask Vector answer/conversation (light markdown) to a real PDF / DOCX / XLSX.

Reads a job JSON ({"format","title","content"}) from --job and writes the binary to
--out. PDF uses reportlab, XLSX uses openpyxl, DOCX is a dependency-free minimal writer
(a .docx is just a zip of XML) so we don't need python-docx. Supports headings, bold,
bullet/numbered lists and GitHub-style pipe tables — enough for chat answers.
"""
import sys, os, re, json, html, zipfile, argparse


# ── Light markdown → blocks ────────────────────────────────────────────────────
def parse_blocks(md):
    lines = (md or '').replace('\r\n', '\n').split('\n')
    blocks, i, n = [], 0, len(lines)

    def cells(l):
        l = l.strip()
        l = re.sub(r'^\|', '', l)
        l = re.sub(r'\|$', '', l)
        return [c.strip() for c in l.split('|')]

    while i < n:
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        # GFM table: header row, |---| separator, body rows
        if '|' in s and i + 1 < n and '-' in lines[i + 1] and re.match(r'^[\s|:\-]+$', lines[i + 1].strip()):
            headers = cells(s)
            i += 2
            rows = []
            while i < n and '|' in lines[i]:
                rows.append(cells(lines[i]))
                i += 1
            blocks.append({'type': 'table', 'headers': headers, 'rows': rows})
            continue
        m = re.match(r'^(#{1,6})\s+(.*)$', s)
        if m:
            blocks.append({'type': 'h', 'level': len(m.group(1)), 'text': m.group(2)})
            i += 1
            continue
        if re.match(r'^[-*•]\s+', s):
            items = []
            while i < n and re.match(r'^[-*•]\s+', lines[i].strip()):
                items.append(re.sub(r'^[-*•]\s+', '', lines[i].strip()))
                i += 1
            blocks.append({'type': 'ul', 'items': items})
            continue
        if re.match(r'^\d+\.\s+', s):
            items = []
            while i < n and re.match(r'^\d+\.\s+', lines[i].strip()):
                items.append(re.sub(r'^\d+\.\s+', '', lines[i].strip()))
                i += 1
            blocks.append({'type': 'ol', 'items': items})
            continue
        para = [s]
        i += 1
        while i < n and lines[i].strip() and '|' not in lines[i] \
                and not re.match(r'^(#{1,6}\s|[-*•]\s|\d+\.\s)', lines[i].strip()):
            para.append(lines[i].strip())
            i += 1
        blocks.append({'type': 'p', 'text': ' '.join(para)})
    return blocks


def inline_runs(text):
    """Split into (segment, is_bold) runs; links [t](u) become 't (u)'."""
    text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '', text)               # drop images
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1 (\2)', text)    # links → text (url)
    text = text.replace('`', '')
    parts, last = [], 0
    for m in re.finditer(r'\*\*(.+?)\*\*', text):
        if m.start() > last:
            parts.append((text[last:m.start()], False))
        parts.append((m.group(1), True))
        last = m.end()
    if last < len(text):
        parts.append((text[last:], False))
    return parts or [(text, False)]


def strip_inline(text):
    return ''.join(seg for seg, _ in inline_runs(text))


# ── PDF (reportlab) ─────────────────────────────────────────────────────────────
def build_pdf(blocks, title, path):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib import colors
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                    TableStyle, ListFlowable, ListItem)

    def markup(t):
        out = ''
        for seg, b in inline_runs(t):
            seg = html.escape(seg)
            out += ('<b>%s</b>' % seg) if b else seg
        return out

    styles = getSampleStyleSheet()
    body = ParagraphStyle('body', parent=styles['Normal'], fontSize=10, leading=14)
    doc = SimpleDocTemplate(path, pagesize=A4, title=title or 'Vector export',
                            leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm)
    story = []
    if title:
        story.append(Paragraph(html.escape(title), styles['Title']))
        story.append(Spacer(1, 10))
    for b in blocks:
        t = b['type']
        if t == 'h':
            story.append(Paragraph(markup(b['text']), styles['Heading%d' % min(max(b['level'], 1), 4)]))
        elif t == 'p':
            story.append(Paragraph(markup(b['text']), body))
            story.append(Spacer(1, 4))
        elif t in ('ul', 'ol'):
            items = [ListItem(Paragraph(markup(x), body)) for x in b['items']]
            story.append(ListFlowable(items, bulletType='bullet' if t == 'ul' else '1', leftIndent=14))
            story.append(Spacer(1, 4))
        elif t == 'table':
            data = ([[Paragraph(markup(c), body) for c in b['headers']]]
                    + [[Paragraph(markup(c), body) for c in r] for r in b['rows']])
            tbl = Table(data, repeatRows=1)
            tbl.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#EEF0F4')),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#C8CDD6')),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
                ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ]))
            story.append(tbl)
            story.append(Spacer(1, 6))
    doc.build(story or [Spacer(1, 1)])


# ── XLSX (openpyxl) ─────────────────────────────────────────────────────────────
def build_xlsx(blocks, title, path):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    wb = Workbook()
    ws = wb.active
    ws.title = 'Export'
    head_fill = PatternFill('solid', fgColor='EEF0F4')
    tables = [b for b in blocks if b['type'] == 'table']

    def autosize(sheet):
        for col in sheet.columns:
            width = max((len(str(c.value)) if c.value is not None else 0) for c in col)
            sheet.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 70)

    if tables:
        first = True
        for ti, b in enumerate(tables):
            sheet = ws if first else wb.create_sheet('Table%d' % (ti + 1))
            first = False
            sheet.append([strip_inline(c) for c in b['headers']])
            for c in range(1, len(b['headers']) + 1):
                cell = sheet.cell(row=1, column=c)
                cell.font = Font(bold=True)
                cell.fill = head_fill
                cell.alignment = Alignment(vertical='top')
            for r in b['rows']:
                sheet.append([strip_inline(x) for x in r])
            autosize(sheet)
    else:
        for b in blocks:
            if b['type'] in ('ul', 'ol'):
                for x in b['items']:
                    ws.append([strip_inline(x)])
            elif b['type'] == 'h':
                ws.append([strip_inline(b['text'])])
                ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
            elif b['type'] == 'p':
                ws.append([strip_inline(b['text'])])
        ws.column_dimensions['A'].width = 90
    wb.save(path)


# ── DOCX (dependency-free: a .docx is a zip of XML) ─────────────────────────────
def build_docx(blocks, title, path):
    def esc(s):
        return html.escape(s, quote=False)

    def runs_xml(text, force_bold=False):
        out = ''
        for seg, b in inline_runs(text):
            rpr = '<w:rPr><w:b/></w:rPr>' if (b or force_bold) else ''
            out += '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(seg))
        return out

    def para(text, force_bold=False, size=None, space_after=120):
        rpr_size = '<w:sz w:val="%d"/><w:szCs w:val="%d"/>' % (size, size) if size else ''
        # apply size via a paragraph-mark rPr and per-run below
        body = ''
        for seg, b in inline_runs(text):
            rpr = ''
            if b or force_bold or rpr_size:
                rpr = '<w:rPr>%s%s</w:rPr>' % ('<w:b/>' if (b or force_bold) else '', rpr_size)
            body += '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(seg))
        return '<w:p><w:pPr><w:spacing w:after="%d"/></w:pPr>%s</w:p>' % (space_after, body)

    def cell(text, bold=False):
        return ('<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>'
                '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>%s</w:p></w:tc>'
                % runs_xml(text, force_bold=bold))

    body = ''
    if title:
        body += para(title, force_bold=True, size=36)
    for b in blocks:
        t = b['type']
        if t == 'h':
            body += para(b['text'], force_bold=True, size=max(32 - (b['level'] - 1) * 4, 22))
        elif t == 'p':
            body += para(b['text'])
        elif t == 'ul':
            for x in b['items']:
                body += para('•  ' + x)
        elif t == 'ol':
            for idx, x in enumerate(b['items']):
                body += para('%d.  %s' % (idx + 1, x))
        elif t == 'table':
            borders = ''.join('<w:%s w:val="single" w:sz="4" w:space="0" w:color="C8CDD6"/>' % s
                              for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
            tbl = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>%s</w:tblBorders></w:tblPr>' % borders
            tbl += '<w:tr>' + ''.join(cell(h, bold=True) for h in b['headers']) + '</w:tr>'
            for r in b['rows']:
                tbl += '<w:tr>' + ''.join(cell(c) for c in r) + '</w:tr>'
            tbl += '</w:tbl>'
            body += tbl + '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'

    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
                '</w:body></w:document>' % (body or para('')))

    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" '
                     'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
        z.writestr('word/document.xml', document)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--job', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    with open(args.job, 'r', encoding='utf-8') as f:
        job = json.load(f)
    fmt = str(job.get('format', '')).lower()
    title = job.get('title') or ''
    blocks = parse_blocks(job.get('content') or '')
    if fmt == 'pdf':
        build_pdf(blocks, title, args.out)
    elif fmt == 'docx':
        build_docx(blocks, title, args.out)
    elif fmt == 'xlsx':
        build_xlsx(blocks, title, args.out)
    else:
        sys.stderr.write('unsupported format: %s\n' % fmt)
        sys.exit(2)
    print('OK')


if __name__ == '__main__':
    main()
