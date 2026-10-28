"""OpenDocument spreadsheets (.ods) and text documents (.odt), and RTF.

An OpenDocument file is a ZIP package whose "mimetype" entry names the kind and
whose content.xml holds the body. A spreadsheet becomes the same structured text
as an Excel workbook (regmon/workbook.py), so its comparison is cell by cell like
any workbook; a text document becomes paragraphs and `| a | b |` table rows like
the .docx extractor's output.

RTF is read as text: control words are dropped, paragraph marks become lines,
\\'hh and \\uN escapes become characters, and non-text groups (font and colour
tables, pictures, document info) are skipped.
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_CONTENT_BYTES = 64 * 1024 * 1024
MAX_REPEAT = 1024           # repeated empty rows/columns are capped (sheets pad to 1,048,576 rows)

_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
}


def _q(prefix: str, name: str) -> str:
    return "{" + _NS[prefix] + "}" + name


def opendocument_kind(body: bytes) -> str | None:
    """'ods' or 'odt' when the ZIP package is an OpenDocument spreadsheet or text."""
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            if "mimetype" not in archive.namelist():
                return None
            mimetype = archive.read("mimetype")[:200].decode("ascii", "ignore").strip()
    except (OSError, zipfile.BadZipFile, KeyError):
        return None
    if mimetype.startswith("application/vnd.oasis.opendocument.spreadsheet"):
        return "ods"
    if mimetype.startswith("application/vnd.oasis.opendocument.text"):
        return "odt"
    return None


def _content(body: bytes):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        info = archive.getinfo("content.xml")
        if info.file_size > MAX_CONTENT_BYTES:
            raise ValueError("The OpenDocument content is too large to read safely")
        return ET.fromstring(archive.read(info))


def _node_text(node) -> str:
    """Text of a paragraph, keeping spaces (<text:s/>), tabs and line breaks."""
    parts = []
    if node.text:
        parts.append(node.text)
    for child in node:
        tag = child.tag
        if tag == _q("text", "s"):
            parts.append(" " * int(child.get(_q("text", "c")) or 1))
        elif tag == _q("text", "tab"):
            parts.append("\t")
        elif tag == _q("text", "line-break"):
            parts.append("\n")
        elif tag in (_q("text", "note"),):
            pass
        else:
            parts.append(_node_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _cell_text(cell) -> str:
    value_type = cell.get(_q("office", "value-type"))
    paragraphs = [_node_text(p) for p in cell.iter(_q("text", "p"))]
    shown = " ".join(" ".join(p.split()) for p in paragraphs).strip()
    if not shown:
        for attribute in ("value", "date-value", "time-value", "boolean-value", "string-value"):
            raw = cell.get(_q("office", attribute))
            if raw is not None:
                shown = raw
                break
    if value_type == "date" and cell.get(_q("office", "date-value")):
        raw = cell.get(_q("office", "date-value"))
        shown = raw[:10] if raw.endswith("T00:00:00") or len(raw) == 10 else raw.replace("T", " ")[:16]
    formula = cell.get(_q("table", "formula"))
    if formula:
        formula = re.sub(r"^of:", "", formula)
        shown = formula + (f" → {shown}" if shown else "")
    return shown


def extract_ods(body: bytes):
    """Return (text, "ods", error) for an OpenDocument spreadsheet."""
    from regmon.workbook import _column_letter, _render

    try:
        root = _content(body)
        hidden_styles = {
            style.get(_q("style", "name"))
            for style in root.iter(_q("style", "style"))
            if style.get(_q("style", "family")) == "table"
            and any(props.get(_q("table", "display")) == "false" for props in style.iter(_q("style", "table-properties")))
        }
        sheets = []
        office_body = root.find(_q("office", "body"))
        spreadsheet = office_body.find(_q("office", "spreadsheet")) if office_body is not None else None
        for table in (spreadsheet.findall(_q("table", "table")) if spreadsheet is not None else []):
            title = table.get(_q("table", "name")) or f"Sheet{len(sheets) + 1}"
            rows: list[list[str]] = []
            merges: list[str] = []
            for row in table.iter(_q("table", "table-row")):
                repeat_rows = min(int(row.get(_q("table", "number-rows-repeated")) or 1), MAX_REPEAT)
                values: list[str] = []
                for cell in row:
                    if cell.tag not in (_q("table", "table-cell"), _q("table", "covered-table-cell")):
                        continue
                    repeat = min(int(cell.get(_q("table", "number-columns-repeated")) or 1), MAX_REPEAT)
                    text = _cell_text(cell) if cell.tag == _q("table", "table-cell") else ""
                    span_c = int(cell.get(_q("table", "number-columns-spanned")) or 1)
                    span_r = int(cell.get(_q("table", "number-rows-spanned")) or 1)
                    if span_c > 1 or span_r > 1:
                        col, top = len(values), len(rows) + 1
                        merges.append(f"{_column_letter(col)}{top}:{_column_letter(col + span_c - 1)}{top + span_r - 1}")
                    values.extend([text] * repeat if text else [""] * repeat)
                while values and not values[-1]:
                    values.pop()
                if not values and repeat_rows > 1:
                    rows.extend([[]] * repeat_rows)
                else:
                    rows.extend([list(values) for _ in range(repeat_rows)])
            while rows and not rows[-1]:
                rows.pop()
            state = "hidden" if table.get(_q("table", "style-name")) in hidden_styles else "visible"
            sheets.append({"title": title, "state": state, "rows": rows, "merges": merges})
        if not sheets:
            raise ValueError("The spreadsheet contains no sheets")
        return _render(sheets, []), "ods", None
    except Exception as exc:
        return None, "ods", f"{type(exc).__name__}: {exc}"


def extract_odt(body: bytes):
    """Return (text, "odt", error) for an OpenDocument text document."""
    from regmon.content import _table_to_markdown, normalize_text

    try:
        root = _content(body)
        office_body = root.find(_q("office", "body"))
        text_root = office_body.find(_q("office", "text")) if office_body is not None else None
        if text_root is None:
            raise ValueError("The document has no text body")
        parts: list[str] = []

        def walk(node):
            for child in node:
                if child.tag in (_q("text", "p"), _q("text", "h")):
                    parts.append(_node_text(child))
                elif child.tag == _q("table", "table"):
                    rows = []
                    for row in child.iter(_q("table", "table-row")):
                        rows.append([
                            "\n".join(_node_text(p) for p in cell.iter(_q("text", "p")))
                            for cell in row if cell.tag == _q("table", "table-cell")
                        ])
                    parts.append(_table_to_markdown(rows))
                elif child.tag in (_q("text", "list"), _q("text", "list-item"), _q("text", "section")):
                    walk(child)

        walk(text_root)
        return normalize_text("\n".join(parts)), "odt", None
    except Exception as exc:
        return None, "odt", f"{type(exc).__name__}: {exc}"


# ----------------------------------------------------------------- RTF
_RTF_SKIP = {
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer",
    "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable",
    "revtbl", "rsidtbl", "generator", "themedata", "colorschememapping", "latentstyles",
    "datastore", "xmlnstbl", "filetbl", "mmathPr", "pgdsctbl",
}
_RTF_TOKEN = re.compile(r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\(.)|([{}])|([^\\{}\r\n]+)|[\r\n]+", re.S)


def extract_rtf(body: bytes):
    """Return (text, "rtf", error) for an RTF document."""
    from regmon.content import normalize_text

    try:
        source = body.decode("latin-1")
        if not source.lstrip().startswith("{\\rtf"):
            raise ValueError("The file is not an RTF document")
        out: list[str] = []
        stack: list[tuple[bool, int]] = []
        skipping, uc, pending_skip = False, 1, 0
        codepage = "cp1252"
        for match in _RTF_TOKEN.finditer(source):
            word, arg, hexcode, symbol, brace, text = match.groups()
            if brace == "{":
                stack.append((skipping, uc))
                continue
            if brace == "}":
                skipping, uc = stack.pop() if stack else (False, 1)
                continue
            if pending_skip and (hexcode or text):
                # Characters after \uN stand in for readers without Unicode.
                if hexcode:
                    pending_skip -= 1
                    continue
                drop = min(pending_skip, len(text))
                text, pending_skip = text[drop:], pending_skip - drop
            if symbol is not None:
                if symbol == "*":
                    skipping = True
                elif not skipping and symbol in "\\{}":
                    out.append(symbol)
                elif not skipping and symbol == "~":
                    out.append("\u00a0")
                elif not skipping and symbol in "-_":
                    out.append("-" if symbol == "_" else "")
                continue
            if word is not None:
                if word in _RTF_SKIP:
                    skipping = True
                elif word == "ansicpg" and arg:
                    codepage = "cp" + arg
                elif word == "uc" and arg:
                    uc = int(arg)
                elif skipping:
                    continue
                elif word in ("par", "line", "sect", "page", "row"):
                    out.append("\n")
                elif word == "cell":
                    out.append(" | ")
                elif word == "tab":
                    out.append("\t")
                elif word == "u" and arg:
                    value = int(arg)
                    out.append(chr(value + 65536 if value < 0 else value))
                    pending_skip = uc
                continue
            if skipping:
                continue
            if hexcode:
                try:
                    out.append(bytes([int(hexcode, 16)]).decode(codepage))
                except (LookupError, UnicodeDecodeError):
                    out.append(bytes([int(hexcode, 16)]).decode("cp1252", "replace"))
            elif text:
                out.append(text)
        lines = []
        for line in "".join(out).split("\n"):
            stripped = line.strip()
            # A table row ends with its last cell's separator: draw it as `| a | b |`.
            lines.append("| " + stripped if stripped.endswith(" |") or stripped == "|" else line)
        result = normalize_text("\n".join(lines))
        if not result.strip():
            return None, "rtf", "The RTF document contains no readable text"
        return result, "rtf", None
    except Exception as exc:
        return None, "rtf", f"{type(exc).__name__}: {exc}"
