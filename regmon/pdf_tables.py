"""Rule and field tables in PDFs, read row by row from where the text sits.

Regulators publish their edit checks, validation rules and data dictionaries
in many layouts: the Federal Reserve's edit checklists (Series, Effective
Start/End, Edit Number, MDRM, Edit Test, Alg Edit Test), the FFIEC's Call
Report edits, field lists with Spanish or Portuguese headings, and so on. When
such a table has no ruled grid (regmon/pdf_grid.py rebuilds the ruled ones), a
PDF's text layer loses its rows: wrapped cells become separate lines, a long
cell of one row is glued to the next row, words and codes are split (the FR
Y-9C checklist reads ``bh k4644)FRY9C …`` and ``bhck43 01``). The structured
comparison (regmon/spec_diff.py) then cannot tell which rule changed.

Nothing here is specific to one regulator. A page is read as a table when:

* a header line names its columns in the vocabulary spec_diff already uses to
  recognise rule and field tables (``Edit Number``, ``Rule ID``, ``MDRM``,
  ``Validation``, ``Campo``, ``Descripción`` ...), giving it a key column (the
  rule id or field code) and at least two other recognised columns;
* the columns are where the body text actually lines up, and every header word
  sits in one of them;
* rows start on each line that has text in the key column. Rule ids and field
  codes do not wrap, so a wrapped cell never starts a false row;
* every glyph of the table body lands in exactly one cell (character
  conservation). A page that fails any of this keeps the ordinary extraction,
  so reading it as a table can never lose text the old path kept.

A page without its own header continues the previous page's table when its text
lines up with the same columns (many rule lists print the header once). Glyphs
are assigned to the column they start in, except that a glyph continuing the
same text run (next in the content stream, same baseline, touching) stays with
its run: English drawn over the algebra column stays English. A cell that
overflows its row is drawn above the next row's first line, so it stays in its
own row.

The PDF itself can be incomplete (a letter missing where an overflowing line is
drawn over the next row, an expression cut off at the cell edge). Such rows are
kept as printed and listed as source defects; nothing is repaired silently.

Each table page is rendered as its title, one markdown table and its footer, so
spec_diff keys rows by their id and the registry (regmon/registry.py) learns
which reporting items a changed rule touches.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from regmon.pdfium_lock import LOCK

PARSER_VERSION = "tables1"

# Cheap test on the fast text layer before any geometry: a page is worth a look
# only when two of these column names appear near its top.
HEADER_PHRASES = re.compile(
    r"edit\s*(number|test|type|change)|alg\s*edit\s*test|rule\s*(id|number|no\b)|validation\s*(rule|id|number)|\bmdrm\b"
    r"|effective\s*(start|end|date)|severity|error\s*(level|message)|data\s*(element|point|type)|field\s*(name|code)"
    r"|item\s*code|line\s*item|\bdpm\b|\bformula\b|\bcampo\b|c[oó]digo|descripci[oó]n|severidad|validaci[oó]n|regla"
    r"|cuenta|formato|tipo\s*de\s*dato|longitud|denomina[cç][aã]o|campo|regra",
    re.I,
)
HEADER_LINES = 25
RUN_GAP = 0.8            # glyphs this close on one baseline are one text run
BASELINE = 0.3
COLUMN_SLACK = 3.0       # a cell starts at most this far left of its column
MIN_ROWS = 3
MAX_PAGES = 3000
_DATE8 = re.compile(r"^\d{8}$")
_CODE = re.compile(r"^[A-Z]{4}[A-Z0-9]{4}$")
_ALG_CODE = re.compile(r"\b[a-z]{4}[a-z0-9]{4}\b")


def looks_like_table(page_text: str) -> bool:
    head = "\n".join(str(page_text or "").splitlines()[:HEADER_LINES])
    return len({match.group(0).lower().replace(" ", "") for match in HEADER_PHRASES.finditer(head)}) >= 2


@dataclass
class Layout:
    starts: list            # x where each column starts
    names: list             # header text of each column
    key: int                # column whose text starts a row (rule id, field code)
    roles: dict             # spec_diff role -> column index
    kind: str               # "rules" or "fields"


@dataclass
class Row:
    page: int
    top: float
    cells: dict = field(default_factory=dict)     # column index -> list of verbatim lines


@dataclass
class Page:
    number: int
    layout: Layout
    title: str
    footer: str
    rows: list
    glyphs: int
    placed: int
    overflow_rows: int
    continued: bool          # no header of its own; the previous page's columns


def join_lines(lines: list[str]) -> str:
    """A cell on one line. A line ending in a letter or digit and a hyphen continues
    without a space (HI-|4, bhck3545-|q2); the verbatim lines are kept too."""
    out = ""
    for line in lines:
        if not out:
            out = line
        elif re.search(r"[A-Za-z0-9]-$", out) and re.match(r"[A-Za-z0-9(]", line):
            out += line
        else:
            out += " " + line
    return out


def _lines(words: list[dict]) -> list[list[dict]]:
    rows: dict[float, list] = {}
    for word in words:
        rows.setdefault(round(word["top"], 1), []).append(word)
    return [sorted(rows[top], key=lambda w: w["x0"]) for top in sorted(rows)]


def _runs(line: list[dict]) -> list[list[dict]]:
    """Words of one line grouped into runs: a gap wider than about a third of the
    text height (more than a word space) starts a new run."""
    runs: list[list[dict]] = []
    for word in line:
        size = max(1.0, word["bottom"] - word["top"])
        if runs and word["x0"] - runs[-1][-1]["x1"] < 0.34 * size:
            runs[-1].append(word)
        else:
            runs.append([word])
    return runs


def _column(x0: float, starts: list[float]) -> int:
    """The last column starting at or left of x0 (allowing COLUMN_SLACK)."""
    return max(0, bisect_right(starts, x0 + COLUMN_SLACK) - 1)


def _cluster(values: list[float], tolerance: float = 2.0) -> list[tuple[float, int]]:
    clusters: list[list[float]] = []
    for value in sorted(values):
        if clusters and value - clusters[-1][-1] <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [(min(cluster), len(cluster)) for cluster in clusters]


def _layout_from_header(lines: list[list[dict]]) -> tuple[Layout, int, int] | None:
    """Find a header line whose runs line up with the body's columns; (layout, first header line, last header line)."""
    from regmon.spec_diff import _kind, _roles

    for index, line in enumerate(lines[:HEADER_LINES]):
        text = " ".join(word["text"] for word in line)
        if not looks_like_table(text) and not (index + 1 < len(lines) and looks_like_table(text + "\n" + " ".join(w["text"] for w in lines[index + 1]))):
            continue
        # The header may wrap onto a second or third line just below.
        # A wrapped header line is close below and sparse (``Date``, ``Number``); a
        # first data row is just as close but fills most of the columns.
        band = [line]
        for follow in lines[index + 1:index + 3]:
            close = follow[0]["top"] - band[-1][0]["top"] < 1.6 * max(1.0, band[-1][0]["bottom"] - band[-1][0]["top"])
            if close and len(_runs(follow)) < 0.7 * len(_runs(line)):
                band.append(follow)
            else:
                break
        body = lines[index + len(band):]
        if len(body) < MIN_ROWS:
            continue
        # Columns: x positions where body text runs start on several lines and a
        # header phrase starts too. A word inside a header phrase ("Edit" in "Alg
        # Edit Test") never starts a column; a header word with no body text
        # under it ("Start" in "Effective Start") does not either.
        header_words = [word for header_line in band for word in header_line]
        support = 3 if len(body) >= 6 else 2
        body_starts = [x for x, count in _cluster([run[0]["x0"] for body_line in body for run in _runs(body_line)]) if count >= support]
        phrase_starts = [run[0]["x0"] for header_line in band for run in _runs(header_line)]
        starts = sorted({min((p for p in phrase_starts if abs(p - x) <= 2.0), default=x)
                         for x in body_starts if any(abs(p - x) <= 2.0 for p in phrase_starts)})
        first_header = min(word["x0"] for word in header_words)
        if not starts or starts[0] > first_header + 2.0:
            starts = [first_header, *starts]
        if len(starts) < 3:
            continue
        names = []
        for column, start in enumerate(starts):
            end = starts[column + 1] if column + 1 < len(starts) else 1e9
            parts = sorted((w for w in header_words if start - COLUMN_SLACK <= w["x0"] < end - COLUMN_SLACK),
                           key=lambda w: (round(w["top"]), w["x0"]))
            names.append(" ".join(w["text"] for w in parts))
        if any(not name for name in names):
            continue
        roles = _roles(names)
        kind = _kind(roles)
        if kind not in {"rules", "fields"}:
            continue
        key = roles["id"] if kind == "rules" else roles["field"]
        if len(roles) < 3:
            continue
        return Layout(starts=starts, names=names, key=key, roles=roles, kind=kind), index, index + len(band) - 1
    return None


def _read(page, number: int, words: list[dict], lines: list[list[dict]], layout: Layout,
          body_from: float, title: str, continued: bool) -> Page | None:
    starts = layout.starts
    footer_from = page.height
    # The footer: the lowest line(s), when separated from the table by a clear gap.
    if len(lines) >= 2 and lines[-1][0]["top"] - lines[-2][0]["top"] > 3 * max(1.0, lines[-2][0]["bottom"] - lines[-2][0]["top"]):
        footer_from = lines[-1][0]["top"] - BASELINE
    body_lines = [line for line in lines if body_from < line[0]["top"] < footer_from]
    anchors = []
    for line in body_lines:
        if any(_column(word["x0"], starts) == layout.key and word["x0"] >= starts[layout.key] - COLUMN_SLACK for word in line):
            anchors.append(line[0]["top"])
    if len(anchors) < MIN_ROWS:
        return None
    # Text above the first row that is not part of any row would be lost: refuse.
    if any(line[0]["top"] < anchors[0] - BASELINE for line in body_lines):
        return None
    tops = sorted({round(line[0]["top"], 2) for line in body_lines})
    gaps = Counter(round(b - a, 1) for a, b in zip(tops, tops[1:]) if b - a > 2)
    pitch = gaps.most_common(1)[0][0] if gaps else 9.0
    # A table ends at a gap far larger than its line pitch: what follows is not rows.
    end = footer_from
    for a, b in zip(tops, tops[1:]):
        if a >= anchors[-1] and b - a > 4 * pitch:
            end = b - BASELINE
            break
    rows = [Row(page=number, top=round(top, 2)) for top in anchors]
    row_tops = [row.top for row in rows]
    cells: list[dict] = [dict() for _ in rows]
    glyphs = [c for c in page.chars if body_from < c["top"] < end]
    previous = previous_column = None
    overflow = set()
    for char in glyphs:
        column = _column(char["x0"], starts)
        if (previous is not None and abs(char["top"] - previous["top"]) < BASELINE
                and -0.5 <= char["x0"] - previous["x1"] < RUN_GAP and column != previous_column):
            column = previous_column
        previous, previous_column = char, column
        band = max(0, bisect_right(row_tops, char["top"] + BASELINE) - 1)
        if char["text"].strip() and band + 1 < len(rows) and rows[band + 1].top - char["top"] < pitch * 0.6:
            overflow.add(band)
        cells[band].setdefault(column, []).append(char)
    if not _shaped_like_rows(rows, cells, layout, pitch):
        return None
    placed = 0
    for row, row_cells in zip(rows, cells):
        for column, chars in row_cells.items():
            by_line: dict[float, list] = {}
            for char in chars:
                by_line.setdefault(round(char["top"], 1), []).append(char)
            texts = []
            for top in sorted(by_line):
                text, last = "", None
                for char in sorted(by_line[top], key=lambda c: c["x0"]):
                    if last is not None and char["x0"] - last["x1"] > 1.0 and not text.endswith(" ") and char["text"] != " ":
                        text += " "
                    text += char["text"]
                    last = char
                    placed += bool(char["text"].strip())
                text = " ".join(text.split())
                if text:
                    texts.append(text)
            if texts:
                row.cells[column] = texts
    trailing = [line for line in lines if end <= line[0]["top"] < footer_from]
    footer_lines = trailing + [line for line in lines if line[0]["top"] >= footer_from]
    footer = "\n".join(" ".join(word["text"] for word in line) for line in footer_lines)
    return Page(number=number, layout=layout, title=title, footer=footer, rows=rows,
                glyphs=sum(1 for c in glyphs if c["text"].strip()), placed=placed,
                overflow_rows=len(overflow), continued=continued)


_KEY_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/()\-]{0,24}$")


def _shaped_like_rows(rows: list[Row], cells: list[dict], layout: Layout, pitch: float) -> bool:
    """Structure checks beyond character conservation, which proves nothing was
    lost but not that each glyph is in the right row. A page is a table of rows
    only when:

    * every row's key cell is one code on one line (rule ids and field codes do
      not wrap or contain spaces), and none repeats a column name (a second
      table with its own header further down the page);
    * every cell starts on its row's first line, within half a line (top-aligned
      rows). A layout that centres cells vertically puts part of a row a line
      or more above or below its key, where it would be read into another row.
    """
    names = {"".join(name.lower().split()) for name in layout.names}
    for row, row_cells in zip(rows, cells):
        key_chars = [c for c in row_cells.get(layout.key, []) if c["text"].strip()]
        if not key_chars:
            return False
        key_lines = {round(c["top"], 1) for c in key_chars}
        key_text = "".join(c["text"] for c in sorted(key_chars, key=lambda c: c["x0"])) if len(key_lines) == 1 else ""
        if not _KEY_VALUE.match(key_text) or key_text.lower() in names or any(
                "".join(c["text"] for c in sorted(chars, key=lambda c: c["x0"]) if c["text"].strip()).lower() in names
                for column, chars in row_cells.items() if column != layout.key):
            return False
        for chars in row_cells.values():
            visible = [c for c in chars if c["text"].strip()]
            if visible and abs(min(c["top"] for c in visible) - row.top) > 0.6 * pitch:
                return False
    return True


@dataclass
class Sheet:
    """A page as positioned glyphs, in reading orientation (top-left origin)."""
    chars: list          # dicts: text, x0, x1, top, bottom; content-stream order
    height: float

    @property
    def words(self) -> list[dict]:
        """Glyphs joined into words: one baseline, touching (gap up to 1.5), no space glyph between."""
        lines: list[list[dict]] = []
        for char in sorted(self.chars, key=lambda c: (c["top"], c["x0"])):
            if lines and abs(lines[-1][0]["top"] - char["top"]) <= BASELINE:
                lines[-1].append(char)
            else:
                lines.append([char])
        words = []
        for line in lines:
            current = None
            for char in sorted(line, key=lambda c: c["x0"]):
                if not char["text"].strip():
                    current = None
                    continue
                if current is not None and char["x0"] - current["x1"] <= 1.5:
                    current["text"] += char["text"]
                    current["x1"] = max(current["x1"], char["x1"])
                    current["bottom"] = max(current["bottom"], char["bottom"])
                else:
                    current = {"text": char["text"], "x0": char["x0"], "x1": char["x1"], "top": char["top"], "bottom": char["bottom"]}
                    words.append(current)
        return words


def _pdfium_sheets(body: bytes, indexes: list[int]):
    """(index, Sheet) for the given 0-based pages, read with PDFium: about sixteen
    times faster than pdfminer, which a long rule list would otherwise spend most
    of its extraction time in.

    PDFium is not thread-safe, so each call into it holds ``pdfium_lock.LOCK``;
    the lock is released before each page is yielded, so the caller's own work
    never runs under it."""
    import pypdfium2 as pdfium

    with LOCK:
        document = pdfium.PdfDocument(body)
    try:
        for index in indexes:
            with LOCK:
                if index >= len(document):
                    continue
                sheet = _pdfium_sheet(document, index)
            yield index, sheet
    finally:
        with LOCK:
            document.close()


def _pdfium_sheet(document, index: int) -> "Sheet":
    """One page's glyphs. The caller holds ``pdfium_lock.LOCK``."""
    import pypdfium2.raw as raw

    page = document[index]
    text_page = page.get_textpage()
    try:
        left, bottom, right, top = page.get_mediabox()
        width0, height0 = right - left, top - bottom
        rotation = page.get_rotation() % 360
        count = text_page.count_chars()
        chars = []
        for k in range(count):
            if raw.FPDFText_IsGenerated(text_page.raw, k) == 1:
                continue  # a space or line break PDFium inferred, not a glyph in the file
            text = chr(raw.FPDFText_GetUnicode(text_page.raw, k))
            if text == "\x02":
                text = "-"  # PDFium reports a hyphen at a line end as U+0002; the page prints "-"
            if text in "\r\n\x00\ufffe\uffff":
                continue
            l, b, r, t = text_page.get_charbox(k, loose=True)
            l, r, b, t = l - left, r - left, b - bottom, t - bottom
            if rotation == 90:
                box = (b, t, l, r)
            elif rotation == 180:
                box = (width0 - r, width0 - l, b, t)
            elif rotation == 270:
                box = (height0 - t, height0 - b, width0 - r, width0 - l)
            else:
                box = (l, r, height0 - t, height0 - b)
            chars.append({"text": text, "x0": box[0], "x1": box[1], "top": box[2], "bottom": box[3]})
        return Sheet(chars=chars, height=width0 if rotation in (90, 270) else height0)
    finally:
        text_page.close()
        page.close()


def _pdfplumber_sheets(body: bytes, indexes: list[int]):
    import pdfplumber

    with pdfplumber.open(io.BytesIO(body)) as document:
        for index in indexes:
            if index < len(document.pages):
                page = document.pages[index]
                yield index, Sheet(chars=[{key: c[key] for key in ("text", "x0", "x1", "top", "bottom")} for c in page.chars], height=page.height)


def read_page(page, number: int, carried: Layout | None = None) -> Page | None:
    """One table page from a Sheet (or a pdfplumber page), or None when it is not one or does not reconcile."""
    if not isinstance(page, Sheet):
        page = Sheet(chars=[{key: c[key] for key in ("text", "x0", "x1", "top", "bottom")} for c in page.chars], height=page.height)
    words = page.words
    if not words:
        return None
    lines = _lines(words)
    found = _layout_from_header(lines)
    if found is not None:
        layout, first, last = found
        title = "\n".join(" ".join(word["text"] for word in line) for line in lines[:first])
        body_from = max(word["bottom"] for line in lines[first:last + 1] for word in line)
        return _read(page, number, words, lines, layout, body_from, title, continued=False)
    if carried is not None:
        # A continuation page: same columns, no header. Its first row must start at the top of the text.
        return _read(page, number, words, lines, carried, lines[0][0]["top"] - 1, "", continued=True)
    return None


def defects(record: dict) -> list[dict]:
    """What the PDF renders incompletely in this row, from the row alone. Nothing is changed."""
    found = []

    def add(kind: str, detail: str):
        found.append({"kind": kind, "detail": detail})

    for key in ("start", "end"):
        value = record.get(key, "")
        if value and re.fullmatch(r"\d{6,9}", value) and not _DATE8.match(value):
            add("unreadable_date", f"{key}: {value}")
    logic = record.get("logic", "")
    if logic:
        if logic.count("(") != logic.count(")"):
            add("unbalanced_parentheses", f"{logic.count('(')} open, {logic.count(')')} close")
        if re.search(r"(\belse,? if|\bthen|\band|\bor|\+|\()\s*\(*\s*(\(mm-q1 eq \d\d)?\s*$", logic):
            add("expression_cut_off", logic[-40:])
        tokens = re.findall(r"[A-Za-z0-9-]+\)*", logic)
        codes = [token for token in tokens if _ALG_CODE.fullmatch(token.lower())]
        prefixes = {code[:2].lower() for code in codes}
        for index, token in enumerate(tokens):
            # A code cut short (a letter missing from the text layer): a stub of a
            # known code prefix, followed by the rest of it as another token.
            if prefixes and token[:2].lower() in prefixes and 2 <= len(token) < 8 and re.fullmatch(r"[a-z]{2,4}", token):
                follower = tokens[index + 1] if index + 1 < len(tokens) else ""
                add("code_missing_a_letter", f"{token} {follower}".strip())
    message = record.get("message", "")
    for match in re.finditer(r"\b(HC|HI)\s+([A-Z]{1,3}[0-9][A-Za-z0-9()]*)", message):
        add("hyphen_clipped", match.group(0))
    return found


@dataclass
class TableSet:
    pages: list
    failed_pages: list

    def records(self) -> list[dict]:
        """One dict per row: the header's own column names, plus role-named copies, id, provenance, defects."""
        out, seen = [], Counter()
        for page in self.pages:
            layout = page.layout
            for row in page.rows:
                cells = {name: join_lines(row.cells.get(index, [])) for index, name in enumerate(layout.names)}
                record: dict = {"columns": cells}
                for role, index in layout.roles.items():
                    record[role] = cells[layout.names[index]]
                identity = [record.get(role, "") for role in ("series", "etype", "id", "field") if role in layout.roles]
                record["key"] = ":".join(identity)
                seen[record["key"]] += 1
                record["variant"] = seen[record["key"]]
                record["row_id"] = hashlib.sha256("\x1f".join(cells.values()).encode("utf-8")).hexdigest()[:16]
                record["page"] = row.page
                record["lines"] = {layout.names[index]: lines for index, lines in row.cells.items() if len(lines) > 1}
                out.append(record)
        prefixes = {r["field"][:4] for r in out if _CODE.match(r.get("field", ""))}
        for record in out:
            reads = {code.upper() for code in _ALG_CODE.findall(record.get("logic", "").lower()) if code[:4].upper() in prefixes}
            record["reads"] = sorted(reads - {record.get("field", "")})
            record["defects"] = defects(record)
        return out

    def summary(self, records: list[dict] | None = None) -> dict:
        records = self.records() if records is None else records
        headers = Counter(" | ".join(page.layout.names) for page in self.pages)
        return {
            "parser": PARSER_VERSION,
            "pages": [page.number for page in self.pages],
            "pages_not_read": self.failed_pages,
            "tables": [{"columns": header.split(" | "), "pages": count} for header, count in headers.most_common()],
            "rows": len(records),
            "glyphs": sum(page.glyphs for page in self.pages),
            "glyphs_placed": sum(page.placed for page in self.pages),
            "overflow_rows": sum(page.overflow_rows for page in self.pages),
            "codes": len({r["field"] for r in records if r.get("field")}),
            "rows_with_source_defects": sum(1 for r in records if r["defects"]),
        }


def read(body: bytes, candidates: list[int]) -> TableSet:
    """Read the candidate 0-based pages of a PDF, following continuation pages."""
    wanted = sorted(set(candidates))[:MAX_PAGES]
    if not wanted:
        return TableSet(pages=[], failed_pages=[])
    try:
        return _read_with(_pdfium_sheets, body, wanted)
    except Exception:  # PDFium could not open or read it: the slower reader
        return _read_with(_pdfplumber_sheets, body, wanted)


def _read_with(sheets, body: bytes, wanted: list[int]) -> TableSet:
    pages, failed = [], []
    wanted_set = set(wanted)
    done: set[int] = set()
    queue = list(wanted)
    while queue:
        batch = [index for index in queue if index not in done]
        queue = []
        for index, sheet in sheets(body, batch):
            done.add(index)
            previous = next((page for page in pages if page.number == index), None)
            carried = previous.layout if previous is not None else None
            try:
                page = read_page(sheet, index + 1, carried)
            except Exception:  # a malformed page keeps the ordinary extraction
                page = None
            if page is None or page.glyphs != page.placed:
                if index in wanted_set:
                    failed.append(index + 1)
                continue
            pages.append(page)
            # A table may run onto the next page without repeating its header.
            if index + 1 not in done and index + 1 not in wanted_set and len(done) < MAX_PAGES:
                queue.append(index + 1)
    pages.sort(key=lambda page: page.number)
    return TableSet(pages=pages, failed_pages=sorted(failed))


def _md(value: str) -> str:
    return value.replace("|", "\\|")


def render_page(page: Page) -> str:
    """The page as its title, one markdown table and whatever follows the table."""
    names = page.layout.names
    lines = []
    if page.title:
        lines.append(page.title)
    lines.append("| " + " | ".join(_md(name) for name in names) + " |")
    lines.append("|" + "|".join(" --- " for _ in names) + "|")
    for row in page.rows:
        lines.append("| " + " | ".join(_md(join_lines(row.cells.get(index, []))) for index in range(len(names))) + " |")
    if page.footer:
        lines.append(page.footer)
    return "\n".join(lines)


def payload(tables: TableSet, raw_hash: str = "", url: str = "", lines: bool = False) -> dict:
    """The structured record kept beside the snapshot (data/rule-tables/).

    Every glyph is in the cell values; ``lines`` adds each multi-line cell's
    verbatim line breaks (about 40% more), which the saved original also holds.
    """
    records = tables.records()
    if not lines:
        for record in records:
            record.pop("lines", None)
    return {"schema_version": 1, "url": url, "raw_hash": raw_hash, "summary": tables.summary(records), "rows": records}


# --------------------------------------------------------------------------- command line


def read_file(path: Path) -> tuple[TableSet, bytes]:
    from pypdf import PdfReader

    body = path.read_bytes()
    reader = PdfReader(io.BytesIO(body), strict=False)
    candidates = [index for index, page in enumerate(reader.pages) if looks_like_table(page.extract_text() or "")]
    return read(body, candidates), body


def registry_rows(records: list[dict], form: str, scheme: str = "MDRM") -> str:
    """CSV text for `python -m regmon.registry import`: every code a row is about or reads."""
    places: dict[str, Counter] = {}
    for record in records:
        code = record.get("field", "")
        if not code:
            continue
        places.setdefault(code, Counter())[(record.get("table", ""), record.get("line_item", ""))] += 1
        for other in record.get("reads", []):
            places.setdefault(other, Counter())
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["code", "scheme", "form", "schedule", "line"])
    for code in sorted(places):
        schedule, line = places[code].most_common(1)[0][0] if places[code] else ("", "")
        writer.writerow([code, scheme, form, schedule, line])
    return out.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read the rule and field tables of a PDF row by row.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--csv", type=Path, help="write one row per table row to this CSV")
    parser.add_argument("--json", type=Path, help="write the structured record (rows, line breaks, defects) to this file")
    parser.add_argument("--registry", type=Path, help="merge every code into this registry.json (with --write)")
    parser.add_argument("--form", default="", help="form name for registry items, e.g. FR Y-9C")
    parser.add_argument("--write", action="store_true", help="write the merged registry instead of printing it")
    args = parser.parse_args(argv)
    tables, body = read_file(args.pdf)
    records = tables.records()
    summary = tables.summary(records)
    shown = dict(summary, pages=f"{len(summary['pages'])} pages")
    print(json.dumps(shown, indent=2))
    if args.csv:
        names = list(dict.fromkeys(name for record in records for name in record["columns"]))
        with args.csv.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["row_id", "key", "variant", *names, "Reads", "Source defects", "PDF page"])
            for record in records:
                writer.writerow([record["row_id"], record["key"], record["variant"], *[record["columns"].get(name, "") for name in names],
                                 " ".join(record["reads"]), "; ".join(f"{d['kind']}: {d['detail']}" for d in record["defects"]), record["page"]])
    if args.json:
        args.json.write_text(json.dumps(payload(tables, hashlib.sha256(body).hexdigest(), str(args.pdf), lines=True),
                                        ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if args.registry:
        from regmon import registry

        current = json.loads(args.registry.read_text(encoding="utf-8")) if args.registry.exists() else {"schema_version": 1}
        merged = registry.import_csv(registry_rows(records, args.form), current)
        text = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
        if args.write:
            args.registry.write_text(text, encoding="utf-8")
            print(f"{args.registry}: {len(merged['items'])} items")
        else:
            sys.stdout.write(text)
    return 0 if summary["glyphs"] == summary["glyphs_placed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
