"""
cbu_export.py — Fill CBU Tech Brief, convert to PDF, then append Commissioning
                and T&C PDFs from the docs/ folder (T&C always last).
"""
import sys, os, argparse, subprocess


def find_libreoffice():
    import shutil as sh
    for cmd in ["soffice", "libreoffice"]:
        p = sh.which(cmd)
        if p:
            return p
    for p in [
        r"C:\Users\E0740516\Downloads\LibreOfficePortable\App\libreoffice\program\soffice.exe",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]:
        if os.path.exists(p):
            return p
    return None


def find_doc(docs_dir, *candidates):
    for name in candidates:
        p = os.path.join(docs_dir, name)
        if os.path.exists(p):
            return p
    return None


def merge_pdfs(output_path, paths):
    """Merge PDFs using pypdf (falls back to PyPDF2).  Returns (ok, errmsg)."""
    try:
        from pypdf import PdfWriter, PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfWriter, PdfReader
        except ImportError:
            return False, "pypdf not installed — brief exported without appendices"

    writer = PdfWriter()
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        try:
            for page in PdfReader(p).pages:
                writer.add_page(page)
        except Exception as e:
            sys.stderr.write(f"[warn] could not read {p}: {e}\n")

    with open(output_path, "wb") as f:
        writer.write(f)
    return True, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--system",   required=True)
    ap.add_argument("--project",  required=True)
    ap.add_argument("--quote",    required=True)
    ap.add_argument("--engineer", required=True)
    ap.add_argument("--email",    required=True)
    ap.add_argument("--phone",    required=True)
    ap.add_argument("--outdir",   required=True)
    args = ap.parse_args()

    here     = os.path.dirname(os.path.abspath(__file__))
    template = os.path.join(here, "cbu_calculator.xlsm")
    docs_dir = os.path.join(here, "docs")

    if not os.path.exists(template):
        print(f"__ERROR__:cbu_calculator.xlsm not found at {template}")
        sys.exit(1)

    lo = find_libreoffice()
    if not lo:
        print("__ERROR__:LibreOffice not found")
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    work_file = os.path.join(args.outdir, "CBU_Tech_Brief.xlsx")

    # ── Fill template ─────────────────────────────────────────────────────────
    try:
        import openpyxl
        from openpyxl.worksheet.page import PrintPageSetup
        from openpyxl.worksheet.properties import WorksheetProperties, PageSetupProperties

        wb = openpyxl.load_workbook(template, keep_vba=True)

        if "Sales Engineer Sheet" in wb.sheetnames:
            ws = wb["Sales Engineer Sheet"]
            ws["B5"]  = args.system
            ws["C17"] = args.project
            ws["C18"] = args.quote
            ws["C19"] = args.engineer

        if "CBU Tech Brief" in wb.sheetnames:
            ws2 = wb["CBU Tech Brief"]
            ws2["F5"] = args.project
            ws2["F6"] = args.quote
            ws2["F7"] = args.engineer
            ws2["F8"] = args.email
            ws2["F9"] = args.phone
            ws2.page_setup = PrintPageSetup(
                paperSize=9, orientation="portrait",
                fitToWidth=1, fitToHeight=0,
            )
            if ws2.sheet_properties is None:
                ws2.sheet_properties = WorksheetProperties()
            ws2.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)

        # HIDE every other sheet — do NOT delete them.
        # CBU Tech Brief has XLOOKUP formulas that reference Sales Engineer Sheet;
        # deleting it makes every lookup produce Err:504 before LibreOffice can calc.
        # LibreOffice skips hidden sheets when exporting to PDF, so only the brief appears.
        for name in wb.sheetnames:
            if name != "CBU Tech Brief":
                wb[name].sheet_state = "hidden"

        # Make CBU Tech Brief the active/selected sheet
        wb.active = wb["CBU Tech Brief"]

        wb.calculation.fullCalcOnLoad = True
        wb.save(work_file)

    except Exception as e:
        print(f"__ERROR__:Failed to fill template: {e}")
        sys.exit(1)

    # ── Convert to PDF via LibreOffice ────────────────────────────────────────
    try:
        result = subprocess.run(
            [lo, "--headless", "--convert-to", "pdf", "--outdir", args.outdir, work_file],
            capture_output=True, text=True, timeout=90,
        )
        if result.returncode != 0:
            print(f"__ERROR__:LibreOffice failed: {result.stderr.strip()}")
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print("__ERROR__:LibreOffice timed out after 90 s")
        sys.exit(1)
    except Exception as e:
        print(f"__ERROR__:LibreOffice error: {e}")
        sys.exit(1)

    brief_pdf = os.path.join(args.outdir, "CBU_Tech_Brief.pdf")
    if not os.path.exists(brief_pdf):
        alt = work_file.replace(".xlsx", ".pdf")
        if os.path.exists(alt):
            os.rename(alt, brief_pdf)
        else:
            print("__ERROR__:PDF not found after conversion")
            sys.exit(1)

    # ── Append Commissioning + T&C from docs/ folder ─────────────────────────
    comm_pdf = find_doc(docs_dir,
        "commissioning.pdf",
        "GENERAL SERVICE & COMMISSIONING.pdf",
    )
    tc_pdf = find_doc(docs_dir,
        "terms_and_conditions.pdf",
        "United Kingdom TCs English March 2023.pdf",
    )

    if comm_pdf or tc_pdf:
        merged = os.path.join(args.outdir, "CBU_Brief_Complete.pdf")
        to_merge = [brief_pdf]
        if comm_pdf:
            to_merge.append(comm_pdf)
        if tc_pdf:
            to_merge.append(tc_pdf)   # T&C always last

        ok, err = merge_pdfs(merged, to_merge)
        if ok and os.path.exists(merged):
            brief_pdf = merged
        else:
            sys.stderr.write(f"[warn] PDF merge skipped: {err}\n")

    print(f"__PDF__:{brief_pdf}")
    sys.exit(0)


if __name__ == "__main__":
    main()
