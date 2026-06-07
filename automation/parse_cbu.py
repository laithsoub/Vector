"""
parse_cbu.py — Parse a CBU configurator xlsx and output system block JSON.
Usage: py parse_cbu.py <xlsx_path> <output_json_path>

Reads the "UK CSO Loadstar-PS Quote Configurator" style xlsx.
Outputs a JSON array of system blocks:
[
  {
    "system": "1PH- 2KVA",
    "designation": "1PH- 2KVA",
    "items": [
      {
        "row_label": "Control cabinet Item code",
        "catalogue":   "LSPS1P2KB0",
        "qty":         1,
        "list_price":  3838.22,
        "product_id":  "Control Cabinet(s)",
        "cabinet_type":"Type A",
        "dimensions":  "950H x 335W x 750D (mm)",
        "weight":      "67 / 92 kg",
        "note_description": "Type A  950H x 335W x 750D (mm)  67/92 kg"
      },
      ...
    ]
  },
  ...
]
"""

import sys, json, re
import openpyxl

def clean(v):
    if v is None:
        return ""
    s = str(v).strip()
    # strip currency symbol
    s = s.replace("£", "").replace("€", "").replace("$", "").strip()
    return s

def to_float(v):
    try:
        s = clean(v).replace(",", "")
        if s in ("", "-", "N/A", "N/a"):
            return None
        return float(s)
    except Exception:
        return None

def to_int(v):
    f = to_float(v)
    if f is None:
        return None
    return int(round(f))

ROW_LABELS = [
    "Control cabinet",
    "External parallel kit",
    "Connection area expansion kit",
    "Internal batter",
    "External battery cabinet",
]

def is_item_row(val):
    if not val:
        return False
    v = str(val).strip().lower()
    return any(v.startswith(lbl.lower()) for lbl in ROW_LABELS)

def find_col(headers, *keywords):
    """Find column index by keyword match in header row (0-indexed)."""
    for kw in keywords:
        for i, h in enumerate(headers):
            if h and kw.lower() in str(h).lower():
                return i
    return None

def parse_xlsx(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    # Try first sheet
    ws = wb.worksheets[0]

    rows = list(ws.iter_rows(values_only=True))

    # ── Find system name ──────────────────────────────────────────────────
    # The system name is a yellow/bold cell, typically in col A or B,
    # labelled "System" in same or previous row.
    # Strategy: find row with "System" label and read the next cell or same row.
    system_name = None
    system_row_idx = None
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            if cell and str(cell).strip().lower() == "system":
                # Look at same row remaining cells or next row col B
                # Try same row, next few cols
                for k in range(j+1, min(j+5, len(row))):
                    if row[k]:
                        system_name = str(row[k]).strip()
                        system_row_idx = i
                        break
                # Try next row, same col
                if not system_name and i+1 < len(rows):
                    nrow = rows[i+1]
                    if j < len(nrow) and nrow[j]:
                        system_name = str(nrow[j]).strip()
                        system_row_idx = i+1
                break
        if system_name:
            break

    if not system_name:
        # fallback: look for any non-empty cell in first ~15 rows col A or B
        # that looks like a system name (e.g. "1PH- 2KVA")
        for i, row in enumerate(rows[:15]):
            for j in range(min(3, len(row))):
                if row[j] and re.search(r'\d+\s*(?:PH|KVA)', str(row[j]), re.I):
                    system_name = str(row[j]).strip()
                    system_row_idx = i
                    break
            if system_name:
                break

    if not system_name:
        system_name = "Unknown System"

    # ── Find header row ───────────────────────────────────────────────────
    # Look for row containing "Catalogue #" or "Catalog #"
    header_row_idx = None
    headers = []
    for i, row in enumerate(rows):
        row_text = [str(c).strip() if c else "" for c in row]
        if any("catalogue" in c.lower() or "catalog" in c.lower() for c in row_text if c):
            header_row_idx = i
            headers = row_text
            break

    if header_row_idx is None:
        print(json.dumps({"error": "Could not find header row with 'Catalogue #'"}))
        sys.exit(1)

    # Identify column indices
    col_label    = 0   # Row label always col A (index 0)
    col_cat      = find_col(headers, "catalogue", "catalog")
    col_qty      = find_col(headers, "qty")
    col_price    = find_col(headers, "unit price", "price for bidman", "bidman")
    col_pid      = find_col(headers, "product id")
    col_cab_type = find_col(headers, "cabinet type", "cab type")
    col_dims     = find_col(headers, "dimension", "(mm)")
    col_weight   = find_col(headers, "weight")

    # ── Collect item rows ─────────────────────────────────────────────────
    items = []
    for i in range(header_row_idx + 1, len(rows)):
        row = rows[i]
        if not row:
            continue
        label_val = row[col_label] if col_label < len(row) else None
        if not is_item_row(label_val):
            continue

        def get(idx):
            if idx is None or idx >= len(row):
                return None
            return row[idx]

        cat      = clean(get(col_cat))
        qty_raw  = to_int(get(col_qty))
        price    = to_float(get(col_price))
        pid      = clean(get(col_pid))
        cab_type = clean(get(col_cab_type))
        dims     = clean(get(col_dims))
        weight   = clean(get(col_weight))

        # Skip rows where catalogue is blank AND price is blank AND qty is 0
        if not cat and price is None and (qty_raw == 0 or qty_raw is None):
            continue

        # Build note description for Bid Manager
        note_parts = [p for p in [cab_type, dims, weight] if p]
        note_desc = "  ".join(note_parts)

        items.append({
            "row_label":        str(label_val).strip(),
            "catalogue":        cat,
            "qty":              qty_raw if qty_raw is not None else 1,
            "list_price":       price,
            "product_id":       pid,
            "cabinet_type":     cab_type,
            "dimensions":       dims,
            "weight":           weight,
            "note_description": note_desc,
        })

    result = [{
        "system":      system_name,
        "designation": system_name,
        "items":       items,
    }]

    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: py parse_cbu.py <xlsx_path> <output_json>")
        sys.exit(1)
    try:
        data = parse_xlsx(sys.argv[1])
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"[OK] Parsed {len(data)} system(s) → {sys.argv[2]}")
        for s in data:
            print(f"     {s['system']}: {len(s['items'])} item(s)")
    except Exception as e:
        import traceback
        print(f"[ERR] {e}")
        traceback.print_exc()
        sys.exit(1)
