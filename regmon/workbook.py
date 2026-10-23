"""Workbook extraction that keeps an Excel template's structure.

Regulatory templates and taxonomies are workbooks of many sheets where a change
can be a value, a formula, a merged heading, a drop-down list or a named range,
and where the sheet a line belongs to matters as much as the line. This turns a
workbook into stable text for change detection and the redline:

    [WORKBOOK] 3 sheets: Schedule HC, Instructions, Codes (hidden)
    [SHEET] Schedule HC
    Schedule HC · A: Item · B: Description · C: Amount
    Schedule HC · A: Total · C: =SUM(C2:C4) → 1250
    [MERGED] Schedule HC · A10:C10
    [VALIDATION] Schedule HC · F2:F5 · list · "Yes,No"
    [NAME] TotalAmount = 'Schedule HC'!$C$5

Every row line names its sheet and its columns but not its row number, so a row
inserted near the top of a sheet is one inserted line rather than a renumbering
of everything below it. Formulas are kept with their saved result, so a changed
formula is a change even when the number it produces is not. The cell-by-cell
comparison itself is drawn by the dashboard from the saved original files.
"""
from __future__ import annotations

import datetime
import io
import re
import zipfile
from xml.sax.saxutils import unescape

MAX_CELLS = 2_000_000
MAX_PART_BYTES = 64 * 1024 * 1024
PROFILE = "xlsx2"


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, datetime.datetime):
        if value.time() == datetime.time(0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="minutes")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat(timespec="minutes")
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else format(value, ".15g")
    return re.sub(r"\s+", " ", str(value)).strip()


def _attr(tag: str, name: str) -> str:
    match = re.search(r"\b" + re.escape(name) + r'="([^"]*)"', tag)
    return unescape(match.group(1), {"&quot;": '"', "&apos;": "'"}) if match else ""


def _structure(body: bytes) -> tuple[dict[str, str], dict[str, list[str]], dict[str, list[str]]]:
    """Sheet visibility, merged ranges and data-validation rules, read from the package XML.

    openpyxl's streaming reader (needed for large templates) exposes none of these.
    """
    states: dict[str, str] = {}
    merges: dict[str, list[str]] = {}
    validations: dict[str, list[str]] = {}
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        def read(name: str) -> str:
            try:
                info = archive.getinfo(name)
            except KeyError:
                return ""
            if info.file_size > MAX_PART_BYTES:
                raise ValueError(f"Workbook part {name} is too large to read safely")
            return archive.read(info).decode("utf-8", errors="replace")

        workbook = read("xl/workbook.xml")
        rels = read("xl/_rels/workbook.xml.rels")
        targets = {}
        for tag in re.findall(r"<Relationship\b[^>]*>", rels):
            target = _attr(tag, "Target")
            targets[_attr(tag, "Id")] = target[1:] if target.startswith("/") else "xl/" + target.lstrip("./")
        for tag in re.findall(r"<sheet\b[^>]*>", workbook):
            name = _attr(tag, "name")
            states[name] = _attr(tag, "state") or "visible"
            path = targets.get(_attr(tag, "r:id"), "")
            if "worksheets/" not in path:
                continue
            xml = read(path)
            merges[name] = re.findall(r'<mergeCell\b[^>]*\bref="([^"]+)"', xml)
            rules = []
            for attrs, inner in re.findall(r"<dataValidation\b([^>]*)>([\s\S]*?)</dataValidation>", xml):
                first = re.search(r"<formula1>([\s\S]*?)</formula1>", inner)
                second = re.search(r"<formula2>([\s\S]*?)</formula2>", inner)
                rule = unescape(first.group(1)) if first else ""
                if second:
                    rule += " … " + unescape(second.group(1))
                rules.append(" · ".join(part for part in (_attr(attrs, "sqref"), _attr(attrs, "type") or "any", rule) if part))
            validations[name] = rules
    return states, merges, validations


def extract_workbook(body: bytes):
    """Return (text, "xlsx", error) for an .xlsx/.xlsm workbook."""
    try:
        from openpyxl import load_workbook
        from openpyxl.utils import get_column_letter

        states, merges, validations = _structure(body)
        values = load_workbook(io.BytesIO(body), read_only=True, data_only=True)
        formulas = load_workbook(io.BytesIO(body), read_only=True, data_only=False)
        try:
            names = []
            try:
                defined = formulas.defined_names
                items = defined.items() if hasattr(defined, "items") else [(entry.name, entry) for entry in defined.definedName]
                for name, entry in sorted(items, key=lambda pair: pair[0]):
                    if name.startswith("_xlnm._FilterDatabase"):
                        continue
                    names.append(f"[NAME] {name} = {entry.attr_text}")
            except Exception:
                names = []
            titles = [sheet.title for sheet in values.worksheets]
            labels = [title + ("" if states.get(title, "visible") == "visible" else f" ({states[title]})") for title in titles]
            lines = [f"[WORKBOOK] {len(titles)} sheet{'s' if len(titles) != 1 else ''}: " + ", ".join(labels)]
            cells = 0
            truncated = False
            for sheet, formula_sheet in zip(values.worksheets, formulas.worksheets):
                state = states.get(sheet.title, "visible")
                lines.append(f"[SHEET] {sheet.title}" if state == "visible" else f"[SHEET {state}] {sheet.title}")
                for value_row, formula_row in zip(sheet.iter_rows(values_only=True), formula_sheet.iter_rows(values_only=True)):
                    parts = []
                    for index, (value, formula) in enumerate(zip(value_row, formula_row)):
                        shown = _text(value)
                        if isinstance(formula, str) and formula.startswith("="):
                            shown = formula + (f" → {shown}" if shown else "")
                        elif formula is not None and not shown:
                            shown = _text(formula)
                        if not shown:
                            continue
                        parts.append(f"{get_column_letter(index + 1)}: {shown}")
                        cells += 1
                    if parts:
                        lines.append(f"{sheet.title} · " + " · ".join(parts))
                    if cells >= MAX_CELLS:
                        truncated = True
                        break
                for merged in merges.get(sheet.title, []):
                    lines.append(f"[MERGED] {sheet.title} · {merged}")
                for rule in validations.get(sheet.title, []):
                    lines.append(f"[VALIDATION] {sheet.title} · {rule}")
                if truncated:
                    lines.append(f"[TRUNCATED] Stopped after {MAX_CELLS:,} filled cells")
                    break
            lines.extend(names)
        finally:
            values.close()
            formulas.close()
        from regmon.content import normalize_text

        return normalize_text("\n".join(lines)), "xlsx", None
    except Exception as exc:
        return None, "xlsx", f"{type(exc).__name__}: {exc}"
