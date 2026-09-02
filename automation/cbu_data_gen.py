# Regenerates the DATA block of src/lib/cbuData.ts from the LoadStar-PS sizing
# calculator, so the app never drifts from the sheet by hand-editing again.
#
#   python automation/cbu_data_gen.py [path\to\calculator.xlsm] > DATA.ts
#
# then paste the output over the `export const DATA ... };` block in
# src/lib/cbuData.ts. Diff before committing: the sheet is maintained by hand
# and gains as many errors per revision as it fixes (see below).
#
# If the workbook is open in Excel it is locked exclusively and openpyxl cannot
# read it (PermissionError). Ask the running Excel for a copy first:
#   wb.SaveCopyAs(r'<temp>\calc.xlsm')  via win32com GetObject('Excel.Application')
#
# Authoritative sheets, in order of precedence:
#   'Pricing Analysis for CSO' -> part numbers, quantities, prices  (what the
#                                 Sales Engineer Sheet actually XLOOKUPs)
#   'Tables'                   -> electrical / tech-brief data
#   'Table 1'                  -> expansion + parallel kit prices
# Quantities come from Pricing Analysis only, and the per-cabinet ventilation
# rate from Tables is re-multiplied by that quantity. That rule was written for
# the stale ext-battery quantities the 'Tables' sheet carried for 3PH-12KVA (2)
# and 3PH-24KVA (4); V3.6 finally corrected them to Pricing Analysis's 3 and 6
# (with ventilation 12.096/1.512 and 24.192/3.024). Keep reading quantities from
# Pricing Analysis anyway — it is the table the sheet's own quote page uses.
#
# V3.4 -> V3.6 changed nothing else the app reads: a full cell-level diff of the
# two workbooks found only those quantities, their ventilation, the version
# string and the sample project typed into the Sales Engineer Sheet. The
# generated DATA block came out byte-identical.
import openpyxl, sys

DEFAULT_XL = r"C:\Users\E0740516\OneDrive - Eaton\Copy of UK CSO - LoadStar-PS Sizing Calculator V3.6.xlsm"
XL = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XL
wb = openpyxl.load_workbook(XL, read_only=True, data_only=True)


def s(v, dflt=''):
    if v is None:
        return dflt
    t = str(v).strip()
    return dflt if t in ('', '#N/A') else t


def num(v, dflt=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return dflt


PA = {}
for r in wb['Pricing Analysis for CSO'].iter_rows(min_row=4, max_row=40, values_only=True):
    r = list(r) + [None] * 40
    k = s(r[2])
    if k.endswith('KVA'):
        PA[k] = r
T = {}
for r in wb['Tables'].iter_rows(min_row=22, max_row=54, values_only=True):
    r = list(r) + [None] * 50
    k = s(r[0])
    if k.endswith('KVA'):
        T[k] = r
# Known error in the 'Tables' sheet, carried from V2.8 and STILL WRONG in V3.6
# (re-checked 2026-09-01): 1PH-12KVA is a 3x 5KVA parallel build, so it needs
# three sets of supply fuses and cables the way 1PH-15KVA (also 3 cabinets) does,
# but the row still holds the 2x figures copied down from 1PH-10KVA. Every other
# multi-cabinet row follows the Nx rule.
T['1PH- 12KVA'][8] = T['1PH- 12KVA'][9] = '3x40A'          # rectifier / bypass fuse
T['1PH- 12KVA'][10] = T['1PH- 12KVA'][11] = '3x 10mm²'  # input / output cable

# Table 1 rows 54-56 = expansion kit price per housing type, row 59 = parallel kit
t1 = list(wb['Table 1'].iter_rows(min_row=54, max_row=59, values_only=True))
EXP = {s(row[2]): (s(row[0]), num(row[1])) for row in t1[:3]}   # 'Type A' -> (PN, price)
PAR_PN, PAR_PRICE = s(t1[5][0]), num(t1[5][1])
wb.close()


def dims_hwd(wxdxh):
    """'W480 x D750 x H1750' -> '1750H x 480W x 750D'"""
    parts = {}
    for chunk in (wxdxh or '').split(' x '):
        chunk = chunk.strip()
        if chunk[:1] in ('W', 'D', 'H'):
            parts[chunk[0]] = chunk[1:]
    if not all(k in parts for k in 'WDH'):
        return wxdxh
    return parts['H'] + 'H x ' + parts['W'] + 'W x ' + parts['D'] + 'D'


def q(v):
    t = str(v).replace(chr(92), chr(92) * 2)
    if "'" in t:          # "3x 4 KVA's" reads better than an escaped apostrophe
        return '"' + t.replace('"', chr(92) + '"') + '"'
    return "'" + t + "'"


def money(v):
    return '%.2f' % round(num(v), 2)


out = []
for k in PA:
    p, t = PA[k], T.get(k, [None] * 50)
    ctrlPN, ctrlQty, ctrlDesc = s(p[14]), int(num(p[15])), s(p[16])
    ctrlType, ctrlWeight, ctrlPrice = s(p[17]), s(p[19], 'N/A'), num(p[20])
    parQty = max(ctrlQty - 1, 0)
    intRaw = s(p[21], 'N/A')
    intPN = {'Not needed': 'N/A', 'Included in unit': 'Included'}.get(intRaw, intRaw)
    intQty, intDesc = int(num(p[22])), s(p[23])
    intWeight, intPrice = s(p[24]), num(p[25])
    extRaw = s(p[26], 'N/A')
    extPN = 'N/A' if extRaw in ('No External Cabinet', 'None') else extRaw
    extQty, extDesc = int(num(p[27])), s(p[28])
    extType = s(p[29], 'N/A')
    if extType == 'None':
        extType = 'N/A'
    extStrings = s(p[30], 'N/A')
    extWeight, extPrice = s(p[31], 'N/A'), num(p[32])
    hasExt = extPN != 'N/A' and extQty > 0
    expPN, expPrice = EXP.get(ctrlType, ('', 0.0))
    total = (ctrlQty * ctrlPrice + intQty * intPrice + extQty * extPrice
             + ctrlQty * expPrice + parQty * PAR_PRICE)
    # Ventilation: per-cabinet rate from Tables x the corrected cabinet count.
    ventB = ('%.3f m\u00b3/h' % (num(t[40]) * extQty)) if hasExt and t[40] is not None else 'N/A'
    ventF = ('%.3f m\u00b3/h' % (num(t[42]) * extQty)) if hasExt and t[42] is not None else 'N/A'
    fault = s(t[17]).replace(' per phase', '/ph')
    ctrlDims, extDims = s(t[25]), s(t[37], 'N/A')
    if intQty > 0:
        intSep = intRaw + ' x' + str(intQty)
    elif intRaw == 'Included in unit':
        intSep = 'Included in unit'
    else:
        intSep = 'N/A'

    L = []
    L.append("%s: { system:%s, build:%s, duration:%s, total:%s,"
             % (q(k), q(k), q(s(p[6])), q(s(p[3])), money(total)))
    L.append("  kva:%g,capW:%g,phases:%s,supplyV:%g,outputA:%g,heatKW:%g,fuseRect:%s,fuseBypass:%s,"
             "inCable:%s,outCable:%s,fault:%s,cRear:%s,cFront:%s,cTop:%s,"
             % (num(t[1]), num(t[3]), q(s(t[4])), num(t[5]), round(num(t[13]), 2), num(t[14]),
                q(s(t[8])), q(s(t[9])), q(s(t[10])), q(s(t[11])), q(fault),
                q(s(t[18])), q(s(t[19])), q(s(t[20]))))
    L.append("  ctrlPN:%s,ctrlQty:%d,parallelQty:%d,intPN:%s,intQty:%d,extPN:%s,extQty:%d,"
             % (q(ctrlPN), ctrlQty, parQty, q(intPN), intQty, q(extPN), extQty))
    L.append("  ctrlType:%s,ctrlDims:%s,ctrlWeight:%s,extType:%s,extDims:%s,extWeight:%s,extStrings:%s,"
             "intIncl:%s,intSep:%s,ventBoost:%s,ventFloat:%s,"
             % (q(ctrlType), q(ctrlDims), q(ctrlWeight), q(extType), q(extDims), q(extWeight),
                q(extStrings), q(s(p[18], 'N/A')), q(intSep), q(ventB), q(ventF)))
    L.append("  rows:[")

    def row(label, catNo, qty, price, desc, pid, cab='', dims='', wt=''):
        tail = (',%s,%s,%s' % (q(cab), q(dims), q(wt))) if (cab or dims or wt) else ''
        return ("    mkRow(%-38s%-20s%d,%s,%-42s%s%s),"
                % (q(label) + ',', q(catNo) + ',', qty, money(price), q(desc) + ',', q(pid), tail))

    L.append(row('Control cabinet Item code', ctrlPN, ctrlQty, ctrlPrice, ctrlDesc,
                 'Control Cabinet(s)', ctrlType, dims_hwd(ctrlDims), ctrlWeight))
    L.append(row('External parallel kit', PAR_PN, parQty, PAR_PRICE if parQty else 0,
                 'Kit 93PM External Parallel', 'Kit 93PM External Parallel'))
    L.append(row('Connection area expansion kit', expPN, ctrlQty, expPrice, '', ''))
    if intQty > 0:
        L.append(row('Internal batteries Item Code', intRaw, intQty, intPrice, intDesc,
                     'Internal Batteries', '', '', intWeight))
    else:
        L.append(row('Internal batteries Item Code', intPN, 0, 0, '', 'Internal Batteries'))
    if hasExt:
        L.append(row('External battery cabinet', extPN, extQty, extPrice, extDesc,
                     'External Battery Cabinet(s)', extType, dims_hwd(extDims), extWeight))
    else:
        L.append(row('External battery cabinet', '\u2014', 0, 0, '', 'External Battery Cabinet(s)'))
    L.append("  ]},")
    out.append("\n".join(L))

sys.stdout.write("export const DATA: Record<string,Cfg> = {\n" + "\n".join(out) + "\n};\n")
