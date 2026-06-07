"""
xlsx_extractor.py — Vector
Extracts quote data from Italian .xlsx files (ISE-XX-XXXXX template).
Outputs the same schema as the PDF pipeline.
"""

import re
import logging
from openpyxl import load_workbook
from dataclasses import dataclass, field, asdict
from typing import Optional
import datetime

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# Output schema
# ─────────────────────────────────────────────
@dataclass
class QuoteLineItem:
    position:    Optional[str]   = None
    part_number: Optional[str]   = None
    description: Optional[str]   = None
    quantity:    Optional[float] = None
    unit_price:  Optional[float] = None
    total_price: Optional[float] = None
    currency:    Optional[str]   = None


@dataclass
class ExtractedQuote:
    quote_reference:  Optional[str]   = None
    customer_name:    Optional[str]   = None
    customer_address: Optional[str]   = None
    contact_name:     Optional[str]   = None
    quote_date:       Optional[str]   = None
    validity_date:    Optional[str]   = None
    currency:         Optional[str]   = "EUR"
    total_net:        Optional[float] = None
    discount_pct:     Optional[float] = None
    source_language:  str             = "it"
    source_format:    str             = "xlsx"
    template_variant: Optional[str]   = None
    line_items:       list            = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        d["line_items"] = [asdict(li) if isinstance(li, QuoteLineItem) else li
                           for li in self.line_items]
        return d


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _clean_number(val) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace("€", "").replace(" ", "")
    s = re.sub(r"\.(?=\d{3})", "", s)
    s = s.replace(",", ".")
    s = re.sub(r"[^\d.\-]", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def _fmt_date(val) -> Optional[str]:
    if val is None:
        return None
    if isinstance(val, (datetime.date, datetime.datetime)):
        return val.strftime("%d/%m/%Y")
    return str(val).strip()


def _cell(ws, row, col):
    """Return stripped string value of a cell, or None."""
    v = ws.cell(row=row, column=col).value
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def _find_label_row(ws, label: str, max_row=60, col=2) -> Optional[int]:
    """Find the row where col contains label (case-insensitive)."""
    label_l = label.lower()
    for r in range(1, max_row + 1):
        v = ws.cell(row=r, column=col).value
        if v and label_l in str(v).lower():
            return r
    return None


def _find_value_near(ws, label: str, max_row=60, search_cols=16) -> Optional[str]:
    """
    Find label anywhere in first search_cols columns, return the first
    non-empty cell to the right on the same row.
    """
    label_l = label.lower()
    for r in range(1, max_row + 1):
        for c in range(1, search_cols + 1):
            v = ws.cell(row=r, column=c).value
            if v and label_l in str(v).lower():
                # scan right for a value
                for offset in range(1, search_cols - c + 1):
                    right = ws.cell(row=r, column=c + offset).value
                    if right not in (None, "", 0):
                        return str(right).strip()
    return None


# ─────────────────────────────────────────────
# ISE template extractor  (ISE-XX-XXXXX format)
# ─────────────────────────────────────────────
# Known layout (data_only=True):
#   R2:  col2="Richiesta n°"  col3=<ref>   col5="data:"  col6=<date>
#   R6:  col2="Progetto:"     col3=<proj>  col5="Compilato da:"  col6=<name>
#   R8:  col2="Agenzia:"      col3=<agent>
#   R14: column headers for line items
#   R32: col5="Totale offerta:"  col8=<total>

def _extract_ise(ws) -> ExtractedQuote:
    # ── Header fields ────────────────────────────────────────────
    _ref_raw   = _cell(ws, 2, 3)
    ref        = re.sub(r'\s+\S+$', '', _ref_raw).strip() if _ref_raw and ' ' in _ref_raw else _ref_raw
    date_val   = _fmt_date(ws.cell(row=2, column=6).value)
    project    = _cell(ws, 6, 3)
    salesman   = _cell(ws, 6, 6)
    agency     = _cell(ws, 8, 3)
    discount   = _clean_number(ws.cell(row=8, column=11).value)

    # Total: scan rows 30-40 for "Totale offerta:"
    total = None
    for r in range(28, 45):
        v = ws.cell(row=r, column=5).value
        if v and "totale" in str(v).lower():
            total = _clean_number(ws.cell(row=r, column=8).value)
            break

    # Validity: scan for "Validità offerta:"
    validity = None
    for r in range(33, 55):
        v = ws.cell(row=r, column=2).value
        if v and "valid" in str(v).lower():
            validity = _fmt_date(ws.cell(row=r, column=4).value)
            break

    # ── Line items ───────────────────────────────────────────────
    # Header row is R14:
    # col2=position, col3=part_number, col4=description,
    # col5=quantity, col6=UM, col7=unit_price, col8=total_price
    items = []
    for r in range(15, 32):
        pos  = _cell(ws, r, 2)
        pn   = _cell(ws, r, 3)
        desc = _cell(ws, r, 4)
        qty  = _clean_number(ws.cell(row=r, column=5).value)
        up   = _clean_number(ws.cell(row=r, column=7).value)
        tp   = _clean_number(ws.cell(row=r, column=8).value)

        # Skip section headers (no part number, no qty) and zero-qty rows
        if pn is None or qty is None or qty == 0:
            continue
        # Skip separator rows (desc == "-")
        if desc == "-":
            continue

        items.append(QuoteLineItem(
            position=pos, part_number=pn, description=desc,
            quantity=qty, unit_price=up, total_price=tp, currency="EUR"
        ))

    return ExtractedQuote(
        template_variant="ise_standard",
        quote_reference=ref,
        customer_name=agency,
        contact_name=salesman,
        quote_date=date_val,
        validity_date=validity,
        total_net=total,
        discount_pct=discount,
        currency="EUR",
        line_items=items,
        # quote_name (project) mapped into customer_address for now
        customer_address=project,
    )


# ─────────────────────────────────────────────
# XMOEM template extractor  (Eaton Italy MV tool)
# ─────────────────────────────────────────────
# Sheet structure (filled file):
#   Riassuntivo:  Offerta n. / Data / PROGETTO / Spett.le / TOTALE
#   Preventivo:   line items with Pos, Codice, Tipo/Descrizione, Prezzo Netto

def _is_xmoem_template(wb) -> bool:
    """XMOEM: workbook has both 'Preventivo' and 'Riassuntivo' sheets."""
    names_lower = [s.lower() for s in wb.sheetnames]
    return "preventivo" in names_lower and "riassuntivo" in names_lower


def _row_value(ws, row_idx, after_col=1, max_col=16):
    """First non-empty cell value to the right of after_col on the given row."""
    for c in range(after_col + 1, max_col + 1):
        v = ws.cell(row=row_idx, column=c).value
        if v not in (None, "", 0):
            return v
    return None


def _label_value(ws, label, max_row=80, max_col=16):
    """Find the row whose label cell contains `label`; return value to its right (same row)."""
    label_l = label.lower()
    for r in range(1, max_row + 1):
        for c in range(1, max_col + 1):
            v = ws.cell(row=r, column=c).value
            if v and label_l in str(v).lower():
                return _row_value(ws, r, after_col=c, max_col=max_col)
    return None


def _extract_xmoem(wb) -> ExtractedQuote:
    ws_r = wb["Riassuntivo"] if "Riassuntivo" in wb.sheetnames else None
    ws_p = wb["Preventivo"]  if "Preventivo"  in wb.sheetnames else None

    ref = validity = customer = project = salesman = date_val = None
    total = None

    if ws_r:
        # Header fields — value sits to the right of each label on the same row
        ref      = _label_value(ws_r, "offerta n")
        raw_date = _label_value(ws_r, "data:")
        date_val = _fmt_date(raw_date) if raw_date else None
        project  = _label_value(ws_r, "progetto")
        customer = _label_value(ws_r, "spett")
        validity = _label_value(ws_r, "validit")

        # Total: value on the "TOTALE" row (label R28C5, amount to its right)
        for r in range(1, ws_r.max_row + 1):
            for c in range(1, ws_r.max_column + 1):
                v = ws_r.cell(row=r, column=c).value
                if v and "totale" in str(v).lower():
                    amt = _row_value(ws_r, r, after_col=c, max_col=ws_r.max_column)
                    total = _clean_number(amt) if amt is not None else None
                    break
            if total is not None:
                break

    # Salesman — "OFFERTA REDATTA DA:" on Preventivo (value is in the cell BELOW the label),
    # else the sign-off name under "EATON INDUSTRIES (Italy)" on Riassuntivo.
    def _looks_like_name(s):
        if not s:
            return False
        s = str(s).strip()
        low = s.lower()
        if any(b in low for b in ("eaton", "via ", "tel", "www", "@", "s.r.l", "srl")):
            return False
        if any(ch.isdigit() for ch in s):
            return False
        return " " in s  # "Surname Name"

    if ws_p:
        for r in range(1, 25):
            for c in range(1, ws_p.max_column + 1):
                v = ws_p.cell(row=r, column=c).value
                if v and "redatta da" in str(v).lower():
                    below = ws_p.cell(row=r + 1, column=c).value
                    if _looks_like_name(below):
                        salesman = str(below).strip()
                    break
            if salesman:
                break
    if not salesman and ws_r:
        # Sign-off near bottom: take the name following "EATON INDUSTRIES (Italy)" that is a person
        for r in range(1, ws_r.max_row + 1):
            for c in range(1, ws_r.max_column + 1):
                v = ws_r.cell(row=r, column=c).value
                if v and "eaton industries (italy)" in str(v).lower():
                    nxt = ws_r.cell(row=r + 1, column=c).value
                    if _looks_like_name(nxt):
                        salesman = str(nxt).strip()
            # keep scanning — last valid name (the sign-off) wins over header

    return ExtractedQuote(
        template_variant="xmoem",
        quote_reference=str(ref).strip() if ref else None,
        customer_name=str(customer).strip() if customer else None,
        customer_address=str(project).strip() if project else None,
        contact_name=str(salesman).strip() if salesman else None,
        quote_date=date_val,
        validity_date=str(validity).strip() if validity else None,
        total_net=total,
        currency="EUR",
    )


# ─────────────────────────────────────────────
# Template detection + dispatch
# ─────────────────────────────────────────────

def _is_ise_template(ws) -> bool:
    """ISE template: cell R2C2 contains 'Richiesta n°'"""
    v = ws.cell(row=2, column=2).value
    return v is not None and "richiesta" in str(v).lower()


def extract_italian_xlsx(file_path: str) -> ExtractedQuote:
    wb = load_workbook(file_path, data_only=True)

    if _is_xmoem_template(wb):
        logger.info("Detected XMOEM template")
        return _extract_xmoem(wb)

    ws = wb.active

    if _is_ise_template(ws):
        logger.info("Detected ISE template")
        return _extract_ise(ws)

    # Fallback: generic label scan
    logger.warning("Unknown template — using generic label scan")
    ref      = _find_value_near(ws, "richiesta")  or _find_value_near(ws, "offerta n")
    customer = _find_value_near(ws, "agenzia")    or _find_value_near(ws, "cliente")
    date_str = _find_value_near(ws, "data:")
    total_s  = _find_value_near(ws, "totale")

    return ExtractedQuote(
        template_variant="generic",
        quote_reference=ref,
        customer_name=customer,
        quote_date=_fmt_date(date_str),
        total_net=_clean_number(total_s),
        currency="EUR",
    )


if __name__ == "__main__":
    import sys, json, logging
    logging.basicConfig(level=logging.INFO)
    path = sys.argv[1] if len(sys.argv) > 1 else "test_quote_it.xlsx"
    q = extract_italian_xlsx(path)
    print(json.dumps(q.to_dict(), ensure_ascii=False, indent=2, default=str))
