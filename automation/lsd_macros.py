"""
lsd_macros.py — repair the master model's own buttons.
=====================================================
The LSD master carries two macro icons: 'Working File' on the ledger (copies the
ledger out as a values-only workbook to send) and the one on Feedback (the same
for the offer letter). Both were recorded against names that no longer exist:

    WorkingFile   Sheets("Model ")                — the sheet is 'Model Ledger ' now
                  pivot source "Model (2)!R12C2…"  — a sheet name from the recording
                  Windows("PMCC 2023 Pricing Model-210224.xlsb").Activate
    OfferLetter   Windows("CPQ Pricing Model- Dec 2024.xlsb").Activate

so every master since July stops on "Run-time error '9': Subscript out of range"
(verified on Dalia's untouched AUG 2026 master, 2026-10-06). This rewrites both
against what the workbook actually holds — ThisWorkbook, the sheet found by name
prefix, the pivot's own source range — and adds a Refresh button beside the
ledger's 'Summary' that recalculates and refreshes the summary pivot.

The code goes into the EXISTING modules (Module16, Module5) so the icons'
[0]!WorkingFile / [0]!OfferLetter keep resolving. Needs "Trust access to the VBA
project object model" (HKCU ...\\Excel\\Security\\AccessVBOM = 1).

    python lsd_macros.py <file.xlsb> [<file.xlsb> ...]     patch files in place
"""
import os
import sys

MARK = "' Vector macros v1"

MODULE_WORKING = MARK + r"""
' Rewritten by Vector, 2026-10-06. The recorded version pointed at a sheet,
' a pivot source and two workbook windows that no longer exist.
Option Explicit

Private Function LedgerSheet() As Worksheet
    Dim ws As Worksheet
    For Each ws In ThisWorkbook.Worksheets
        If LCase(Left(Trim(ws.Name), 5)) = "model" Then
            If ws.PivotTables.Count > 0 Then Set LedgerSheet = ws: Exit Function
        End If
    Next ws
    For Each ws In ThisWorkbook.Worksheets
        If LCase(Left(Trim(ws.Name), 5)) = "model" Then Set LedgerSheet = ws: Exit Function
    Next ws
End Function

Private Function IsJunkItem(ByVal s As String) As Boolean
    s = LCase(Trim(s))
    IsJunkItem = (s = "" Or s = "x" Or s = "#n/a" Or s = "#ref!" Or s = "(blank)")
End Function

' Every real pricing group visible, template debris hidden.
Private Sub ShowRealGroups(pt As PivotTable)
    Dim pf As PivotField, pi As PivotItem
    On Error Resume Next
    For Each pf In pt.PivotFields
        If pf.Orientation <> xlHidden Then
            For Each pi In pf.PivotItems
                If pi.Visible <> (Not IsJunkItem(pi.Name)) Then pi.Visible = Not IsJunkItem(pi.Name)
            Next pi
        End If
    Next pf
    On Error GoTo 0
End Sub

Private Sub DropMacroShapes(ws As Worksheet)
    Dim i As Long, act As String
    For i = ws.Shapes.Count To 1 Step -1
        act = ""
        On Error Resume Next
        act = ws.Shapes(i).OnAction
        On Error GoTo 0
        If Len(Trim(act)) > 0 Then ws.Shapes(i).Delete
    Next i
End Sub

Private Sub DropLinks(wb As Workbook)
    Dim v As Variant, i As Long
    v = wb.LinkSources(xlExcelLinks)
    If IsEmpty(v) Then Exit Sub
    On Error Resume Next
    For i = LBound(v) To UBound(v)
        wb.BreakLink Name:=v(i), Type:=xlLinkTypeExcelLinks
    Next i
    On Error GoTo 0
End Sub

' The Summary's Refresh button.
Sub RefreshSummary()
    Dim ws As Worksheet, pt As PivotTable
    On Error GoTo Fail
    Set ws = LedgerSheet()
    If ws Is Nothing Then Set ws = ActiveSheet
    Application.CalculateFull
    For Each pt In ws.PivotTables
        pt.PivotCache.Refresh
        ShowRealGroups pt
    Next pt
    Exit Sub
Fail:
    MsgBox "Could not refresh the summary: " & Err.Description, vbExclamation, "Refresh"
End Sub

' The 'Working File' icon: the ledger alone, as values, in a new workbook to send.
Sub WorkingFile()
    Dim src As Worksheet, nb As Workbook, ws As Worksheet, pt As PivotTable
    Dim srcData As String, lastCol As Long, lastRow As Long, pivCol As Long
    On Error GoTo Fail
    Set src = LedgerSheet()
    If src Is Nothing Then Err.Raise 9, , "No 'Model Ledger' sheet in this workbook."
    Application.ScreenUpdating = False
    Application.CalculateFull
    src.Copy
    Set nb = ActiveWorkbook
    Set ws = nb.Worksheets(1)

    ' Values over every formula, except the pivot (writing into it raises 1004).
    pivCol = 0
    If ws.PivotTables.Count > 0 Then pivCol = ws.PivotTables(1).TableRange2.Column
    lastRow = ws.UsedRange.Row + ws.UsedRange.Rows.Count - 1
    lastCol = ws.UsedRange.Column + ws.UsedRange.Columns.Count - 1
    If pivCol > 1 Then lastCol = pivCol - 1
    With ws.Range(ws.Cells(1, 1), ws.Cells(lastRow, lastCol))
        .Value = .Value
    End With

    DropMacroShapes ws
    ws.Range("AK4").ClearContents

    ' The copied pivot still reads the master; point it at its own rows.
    For Each pt In ws.PivotTables
        srcData = pt.SourceData
        srcData = Mid(srcData, InStrRev(srcData, "!") + 1)
        pt.ChangePivotCache nb.PivotCaches.Create(SourceType:=xlDatabase, _
            SourceData:="'" & ws.Name & "'!" & srcData)
        pt.RefreshTable
        ShowRealGroups pt
    Next pt

    DropLinks nb
    Application.Goto ws.Range("A1"), True
    Application.ScreenUpdating = True
    Exit Sub
Fail:
    Application.ScreenUpdating = True
    MsgBox "Working File could not be created: " & Err.Description, vbExclamation, "Working File"
End Sub
"""

MODULE_OFFER = MARK + r"""
' Rewritten by Vector, 2026-10-06. The recorded version ended by activating
' 'CPQ Pricing Model- Dec 2024.xlsb', which no longer exists.
Option Explicit

' The Feedback icon: the offer letter alone, as values, in a new workbook.
Sub OfferLetter()
    Dim nb As Workbook, ws As Worksheet, i As Long, act As String, v As Variant
    On Error GoTo Fail
    Application.ScreenUpdating = False
    Application.CalculateFull
    ThisWorkbook.Worksheets("Feedback").Copy
    Set nb = ActiveWorkbook
    Set ws = nb.Worksheets(1)
    With ws.UsedRange
        .Value = .Value
    End With
    For i = ws.Shapes.Count To 1 Step -1
        act = ""
        On Error Resume Next
        act = ws.Shapes(i).OnAction
        On Error GoTo Fail
        If Len(Trim(act)) > 0 Then ws.Shapes(i).Delete
    Next i
    v = nb.LinkSources(xlExcelLinks)
    If Not IsEmpty(v) Then
        On Error Resume Next
        For i = LBound(v) To UBound(v)
            nb.BreakLink Name:=v(i), Type:=xlLinkTypeExcelLinks
        Next i
        On Error GoTo Fail
    End If
    Application.Goto ws.Range("A1"), True
    Application.ScreenUpdating = True
    Exit Sub
Fail:
    Application.ScreenUpdating = True
    MsgBox "Offer letter could not be created: " & Err.Description, vbExclamation, "Offer Letter"
End Sub
"""

REFRESH_SHAPE = "Vector Refresh"


def _module_with(vbp, sub):
    """The standard module whose code declares `Sub <sub>()`."""
    for comp in vbp.VBComponents:
        if comp.Type != 1:                       # vbext_ct_StdModule
            continue
        cm = comp.CodeModule
        n = cm.CountOfLines
        if n and f"sub {sub.lower()}(" in cm.Lines(1, n).lower():
            return comp
    return None


def _set_code(vbp, sub, code, fallback_name):
    comp = _module_with(vbp, sub)
    if comp is None:
        comp = vbp.VBComponents.Add(1)
        try:
            comp.Name = fallback_name
        except Exception:
            pass
    cm = comp.CodeModule
    if cm.CountOfLines:
        cm.DeleteLines(1, cm.CountOfLines)
    cm.AddFromString(code)


def _refresh_button(ws):
    """A 'Refresh' button beside the ledger's 'Summary' heading."""
    for i in range(ws.Shapes.Count, 0, -1):
        if ws.Shapes(i).Name == REFRESH_SHAPE:
            ws.Shapes(i).Delete()
    anchor = None
    for addr in ("AK9", "AK8", "AK10"):
        if str(ws.Range(addr).Value or "").strip().lower().startswith("summary"):
            anchor = ws.Range(addr)
            break
    if anchor is None:
        anchor = ws.Range("AK9")
    cell = anchor.Offset(1, 2)                    # the column right of the heading
    h = max(float(cell.Height) - 2, 16.0)
    shp = ws.Shapes.AddShape(5, float(cell.Left) + 4, float(cell.Top) + 1, 72.0, h)  # rounded rect
    shp.Name = REFRESH_SHAPE
    shp.Fill.ForeColor.RGB = 0x9C4F1F             # BGR → Eaton-ish blue #1F4F9C
    shp.Line.Visible = 0
    tr = shp.TextFrame2.TextRange
    tr.Text = "Refresh"
    tr.Font.Size = 10
    tr.Font.Bold = -1
    tr.Font.Fill.ForeColor.RGB = 0xFFFFFF
    shp.TextFrame2.VerticalAnchor = 3             # middle
    tr.ParagraphFormat.Alignment = 2              # centre
    shp.Placement = 3                             # free-floating
    shp.OnAction = "RefreshSummary"


def install(wb, ledger_name="Model Ledger ", log=None):
    """Rewrite WorkingFile / OfferLetter and add the Summary Refresh button.
    Idempotent. Raises when the VBA project cannot be reached."""
    vbp = wb.VBProject
    _set_code(vbp, "WorkingFile", MODULE_WORKING, "Module16")
    _set_code(vbp, "OfferLetter", MODULE_OFFER, "Module5")
    led = wb.Worksheets(ledger_name)
    _refresh_button(led)
    # Bare macro names: a workbook-qualified OnAction breaks the moment the file
    # is renamed or opened from a mail.
    for ws, macro in ((led, "WorkingFile"), (wb.Worksheets("Feedback"), "OfferLetter")):
        for i in range(1, ws.Shapes.Count + 1):
            shp = ws.Shapes(i)
            try:
                act = str(shp.OnAction or "")
            except Exception:
                act = ""
            if act.lower().endswith("!" + macro.lower()) or act.lower() == macro.lower():
                shp.OnAction = macro
    if log:
        log("Repaired the model's Working File / Offer Letter buttons and added the "
            "Summary Refresh button")


def main(paths):
    import win32com.client as w
    app = w.DispatchEx("Excel.Application")
    for prop, val in (("Visible", False), ("DisplayAlerts", False),
                      ("ScreenUpdating", False), ("AskToUpdateLinks", False)):
        try:
            setattr(app, prop, val)
        except Exception:
            pass
    app.AutomationSecurity = 3                    # never run the file's own macros on open
    try:
        for p in paths:
            p = os.path.abspath(p)
            wb = app.Workbooks.Open(p, UpdateLinks=0)
            try:
                install(wb, log=lambda m: print(f"{os.path.basename(p)}: {m}"))
                wb.Save()
            finally:
                wb.Close(SaveChanges=False)
    finally:
        app.Quit()


if __name__ == "__main__":
    main(sys.argv[1:])
