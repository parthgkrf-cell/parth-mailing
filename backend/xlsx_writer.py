"""Minimal .xlsx writer used for campaign reports. No third-party packages."""

import zipfile
from io import BytesIO
from xml.sax.saxutils import escape


def _col_letter(index):
    number = index + 1
    letters = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _cell_text(value):
    text = "" if value is None else str(value)
    cleaned = []
    for char in text:
        code = ord(char)
        if char in "\t\n\r" or code >= 32:
            cleaned.append(char)
    return escape("".join(cleaned))


def workbook_bytes(headers, rows, sheet_name="Campaign Report"):
    """Build a single-sheet workbook. Header cells are bold."""
    safe_name = "".join(ch for ch in sheet_name if ch not in '[]:*?/\\')[:31] or "Report"
    header_cells = []
    for index, header in enumerate(headers):
        ref = f"{_col_letter(index)}1"
        header_cells.append(
            f'<c r="{ref}" t="inlineStr" s="1"><is><t>{_cell_text(header)}</t></is></c>'
        )
    body_rows = [
        '<row r="1">' + "".join(header_cells) + "</row>"
    ]
    for row_index, row in enumerate(rows, start=2):
        cells = []
        for col_index, value in enumerate(row):
            ref = f"{_col_letter(col_index)}{row_index}"
            cells.append(
                f'<c r="{ref}" t="inlineStr"><is><t>{_cell_text(value)}</t></is></c>'
            )
        body_rows.append(f'<row r="{row_index}">' + "".join(cells) + "</row>")

    last_col = _col_letter(max(len(headers) - 1, 0))
    last_row = max(len(rows) + 1, 1)
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{last_col}{last_row}"/>'
        "<sheetData>"
        + "".join(body_rows)
        + "</sheetData></worksheet>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font>'
        "</fonts>"
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        "</cellXfs></styleSheet>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{escape(safe_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
        "</Relationships>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        "</Types>"
    )
    blob = BytesIO()
    with zipfile.ZipFile(blob, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", rels_xml)
        archive.writestr("xl/styles.xml", styles_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return blob.getvalue()
