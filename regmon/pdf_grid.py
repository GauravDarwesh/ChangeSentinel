"""Deterministic reconstruction of ruled PDF tables, including rotated header text.

Regulatory report forms are drawn as ruled grids: multi-level column headers with
merged cells, sideways (rotated) option labels, a row of item codes (for example
``QTFL 1596``), a row of column numbers, and blank entry rows. Layout models guess
this structure from pixels and often merge or lose the rotated headers. The ruling
lines already define every cell exactly, so this module rebuilds the grid from them:

* cells and their row/column spans come from the drawn lines (pdfplumber),
* each character is assigned to the cell containing its centre, and upright and
  rotated text are read in their own reading order,
* a fill-in report form becomes one row per reported item
  (No. | Section | Field | Options | Item code | Entry); any other table keeps its
  rows under combined multi-level header labels,
* prose outside the tables, including text beside a narrow table, is kept in
  reading order.

Everything is geometry and text that is already in the PDF: no models, no OCR,
and the output is identical on every machine.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

_LOG = logging.getLogger(__name__)

LINE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 4,
}
ITEM_CODE = re.compile(r"\b[A-Z]{4}\s?[A-Z0-9]{4}\b")
COLUMN_NUMBER = re.compile(r"^\(\d{1,3}[a-z]?\)(?:\s*\(\d{1,3}[a-z]?\))*$")
ROW_NUMBER = re.compile(r"^\(?\d{1,3}[.)]?$")
MIN_GRID_CELLS = 12


@dataclass
class GridCell:
    r0: int
    r1: int
    c0: int
    c1: int
    bbox: tuple
    text: str = ""

    @property
    def colspan(self) -> int:
        return self.c1 - self.c0

    @property
    def rowspan(self) -> int:
        return self.r1 - self.r0


@dataclass
class Grid:
    bbox: tuple
    rows: int
    cols: int
    cells: list = field(default_factory=list)

    def starting_in_row(self, r: int) -> list:
        return sorted((c for c in self.cells if c.r0 == r), key=lambda c: c.c0)

    def owner(self, r: int, c: int):
        """The first cell (in list order) covering grid position (r, c).

        Built once per grid instead of scanning every cell per lookup: column
        grouping asks for every row of every column, which was quadratic on
        dense forms (CS-29). First-match order is kept, so results are identical.
        """
        index = getattr(self, "_owner_index", None)
        if index is None or getattr(self, "_owner_count", -1) != len(self.cells):
            index = {}
            for cell in self.cells:
                for row in range(cell.r0, cell.r1):
                    for col in range(cell.c0, cell.c1):
                        index.setdefault((row, col), cell)
            self._owner_index, self._owner_count = index, len(self.cells)
        return index.get((r, c))


# ---------------------------------------------------------------- text in cells

def _cluster(values, tolerance):
    out: list[float] = []
    for value in sorted(values):
        if not out or value - out[-1] > tolerance:
            out.append(value)
    return out


def _nearest(boundaries, value):
    return min(range(len(boundaries)), key=lambda i: abs(boundaries[i] - value))


def _char_size(char) -> float:
    return float(char.get("size") or (char["bottom"] - char["top"]) or 8.0)


def _direction(char) -> str:
    """'up' for text rotated 90° anticlockwise, 'down' for clockwise, '' for upright."""
    if char.get("upright", True):
        return ""
    matrix = char.get("matrix") or (1, 0, 0, 1, 0, 0)
    return "up" if float(matrix[1]) > 0 else "down"


def _join_lines(lines: list[str]) -> str:
    text = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if text.endswith("-") and line[:1].islower():
            text = text[:-1] + line  # "Prepay-" + "ment"
        else:
            text = (text + " " + line) if text else line
    return re.sub(r"\s+", " ", text).strip()


def _upright_text(chars) -> str:
    if not chars:
        return ""
    size = sorted(_char_size(c) for c in chars)[len(chars) // 2]
    lines = []
    for char in sorted(chars, key=lambda c: (c["top"], c["x0"])):
        mid = (char["top"] + char["bottom"]) / 2
        for line in lines:
            if abs(line["mid"] - mid) <= size * 0.45:
                line["chars"].append(char)
                break
        else:
            lines.append({"mid": mid, "chars": [char]})
    out = []
    for line in sorted(lines, key=lambda l: l["mid"]):
        text, last = "", None
        for char in sorted(line["chars"], key=lambda c: c["x0"]):
            if last is not None and char["x0"] - last["x1"] > _char_size(char) * 0.2 and not text.endswith(" ") and char["text"] != " ":
                text += " "
            text += char["text"]
            last = char
        out.append(text)
    return _join_lines(out)


def _rotated_text(chars, direction: str) -> str:
    if not chars:
        return ""
    size = sorted(_char_size(c) for c in chars)[len(chars) // 2]
    columns = []
    for char in sorted(chars, key=lambda c: c["x0"]):
        mid = (char["x0"] + char["x1"]) / 2
        for column in columns:
            if abs(column["mid"] - mid) <= size * 0.45:
                column["chars"].append(char)
                break
        else:
            columns.append({"mid": mid, "chars": [char]})
    # Text reading bottom-to-top stacks its lines left to right; top-to-bottom, right to left.
    columns.sort(key=lambda col: col["mid"], reverse=(direction == "down"))
    out = []
    for column in columns:
        ordered = sorted(column["chars"], key=lambda c: c["top"], reverse=(direction == "up"))
        text, last = "", None
        for char in ordered:
            gap = (last["top"] - char["bottom"]) if (last is not None and direction == "up") else (char["top"] - last["bottom"]) if last is not None else 0
            if last is not None and gap > _char_size(char) * 0.2 and not text.endswith(" ") and char["text"] != " ":
                text += " "
            text += char["text"]
            last = char
        out.append(text)
    return _join_lines(out)


def cell_text(chars) -> str:
    groups: dict[str, list] = {"": [], "up": [], "down": []}
    for char in chars:
        if char.get("text", "").strip() or char.get("text") == " ":
            groups[_direction(char)].append(char)
    parts = [_upright_text(groups[""]), _rotated_text(groups["up"], "up"), _rotated_text(groups["down"], "down")]
    return re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()


# ---------------------------------------------------------------- grid building

def build_grids(page) -> list[Grid]:
    try:
        tables = page.find_tables(table_settings=LINE_SETTINGS)
    except Exception as exc:
        # The page is then compared as prose; say so in the job log (CS-30).
        _LOG.warning("Ruled-table detection failed on page %s: %s: %s", getattr(page, "page_number", "?"), type(exc).__name__, exc)
        return []
    grids = []
    chars = [c for c in page.chars if c.get("text")]
    for table in tables:
        boxes = [tuple(float(v) for v in cell) for cell in table.cells if cell]
        if len(boxes) < MIN_GRID_CELLS:
            continue
        xs = _cluster([b[0] for b in boxes] + [b[2] for b in boxes], 1.5)
        ys = _cluster([b[1] for b in boxes] + [b[3] for b in boxes], 1.5)
        if len(xs) < 3 or len(ys) < 3:
            continue
        grid = Grid(bbox=tuple(float(v) for v in table.bbox), rows=len(ys) - 1, cols=len(xs) - 1)
        for box in boxes:
            r0, r1 = _nearest(ys, box[1]), _nearest(ys, box[3])
            c0, c1 = _nearest(xs, box[0]), _nearest(xs, box[2])
            if r1 > r0 and c1 > c0:
                grid.cells.append(GridCell(r0, r1, c0, c1, box))
        # Assign each character to the cell that contains its centre.
        x0, top, x1, bottom = grid.bbox
        inside = [c for c in chars if x0 - 1 <= (c["x0"] + c["x1"]) / 2 <= x1 + 1 and top - 1 <= (c["top"] + c["bottom"]) / 2 <= bottom + 1]
        buckets: dict[int, list] = {}
        # Cells indexed by horizontal bands, so each character is tested only
        # against cells that reach its band; candidates keep list order, so the
        # first containing cell wins exactly as with a full scan (CS-29).
        band = 8.0
        bands: dict[int, list[int]] = {}
        for index, cell in enumerate(grid.cells):
            for key in range(int(cell.bbox[1] // band), int(cell.bbox[3] // band) + 1):
                bands.setdefault(key, []).append(index)
        for char in inside:
            cx, cy = (char["x0"] + char["x1"]) / 2, (char["top"] + char["bottom"]) / 2
            for index in bands.get(int(cy // band), ()):
                bx0, btop, bx1, bbottom = grid.cells[index].bbox
                if bx0 <= cx < bx1 and btop <= cy < bbottom:
                    buckets.setdefault(index, []).append(char)
                    break
        for index, cell in enumerate(grid.cells):
            cell.text = cell_text(buckets.get(index, []))
        if any(cell.text for cell in grid.cells):
            grids.append(grid)
    return grids


def _row_kind(cells) -> str:
    texts = [c.text for c in cells if c.text]
    if len(texts) >= 2 and sum(bool(ITEM_CODE.fullmatch(t)) for t in texts) >= max(2, 0.6 * len(texts)):
        return "codes"
    if len(texts) >= 2 and sum(bool(COLUMN_NUMBER.match(t)) for t in texts) >= max(2, 0.6 * len(texts)):
        return "numbers"
    return ""


def header_row_count(grid: Grid) -> int:
    """Leading rows with merged cells, extended through item-code and column-number rows."""
    count = 0
    for r in range(grid.rows):
        row = grid.starting_in_row(r)
        spans = any(c.colspan > 1 or c.rowspan > 1 for c in row)
        continuing = any(c.r0 < r < c.r1 for c in grid.cells)
        if r == 0 or spans or continuing:
            count = r + 1
        else:
            break
    for r in range(min(grid.rows, 8)):
        if _row_kind(grid.starting_in_row(r)):
            count = max(count, r + 1)
    return min(count, grid.rows)


def _is_blank_row(cells) -> bool:
    return all(not c.text or ROW_NUMBER.match(c.text) for c in cells)


# ---------------------------------------------------------------- rendering

def _md(value: str) -> str:
    return value.replace("|", "\\|").strip()


def _form_rows(grid: Grid, header: int):
    """Detect a fill-in report form: a header row of item codes. Returns field rows or None."""
    code_row = number_row = None
    for r in range(header):
        cells = [c for c in grid.starting_in_row(r) if c.text]
        if len(cells) >= 3:
            codes = sum(bool(ITEM_CODE.fullmatch(c.text)) for c in cells)
            numbers = sum(bool(COLUMN_NUMBER.match(c.text)) for c in cells)
            if code_row is None and codes >= 3 and codes >= 0.6 * len(cells):
                code_row = r
            elif number_row is None and numbers >= 3 and numbers >= 0.6 * len(cells):
                number_row = r
    if code_row is None:
        return None
    # A fill-in form has its codes in the header only; codes in later rows mean a data matrix.
    if any(_row_kind(grid.starting_in_row(r)) == "codes" for r in range(code_row + 1, grid.rows)):
        return None
    rows = []
    for item in grid.starting_in_row(code_row):
        if not ITEM_CODE.fullmatch(item.text or ""):
            continue
        overlaps = lambda c: c.c0 < item.c1 and item.c0 < c.c1  # noqa: E731
        number = ""
        if number_row is not None:
            number = " ".join(c.text for c in grid.starting_in_row(number_row) if overlaps(c) and c.text)
        sections, labels, options, entries = [], [], [], []
        for cell in sorted(grid.cells, key=lambda c: (c.r0, c.c0)):
            if not cell.text or not overlaps(cell) or cell.r0 in (code_row, number_row):
                continue
            if cell.r0 > code_row and (number_row is None or cell.r0 > number_row or cell.r0 > code_row):
                if cell.r0 < header:
                    entries.append(cell.text)
                continue
            if cell.c0 <= item.c0 and cell.c1 >= item.c1 and cell.colspan > item.colspan:
                sections.append(cell.text)
            elif cell.c0 == item.c0 and cell.c1 == item.c1:
                labels.append(cell.text)
            elif cell.c0 >= item.c0 and cell.c1 <= item.c1:
                options.append(cell.text)
        dedupe = lambda values: list(dict.fromkeys(v for v in values if v))  # noqa: E731
        labels = dedupe(labels)
        if len(labels) > 1:
            sections, labels = sections + labels[:-1], labels[-1:]
        rows.append([number, " › ".join(dedupe(sections)), " — ".join(labels), "; ".join(dedupe(options)), item.text, " / ".join(dedupe(entries))])
    return rows or None


def render_grid(grid: Grid) -> str:
    header = header_row_count(grid)
    body = [r for r in range(header, grid.rows)]
    blank = sum(1 for r in body if _is_blank_row(grid.starting_in_row(r)))
    lines: list[str] = []
    form = _form_rows(grid, header)
    if form:
        columns = ["No.", "Section", "Field", "Options", "Item code", "Entry"]
        keep = [i for i in range(len(columns)) if any(row[i] for row in form)]
        lines.append("| " + " | ".join(columns[i] for i in keep) + " |")
        lines.append("|" + "|".join(" --- " for _ in keep) + "|")
        for row in form:
            lines.append("| " + " | ".join(_md(row[i]) for i in keep) + " |")
        if blank:
            lines.append(f"({blank} blank entry rows)")
        return "\n".join(lines)

    # Ordinary table: merge leaf columns that no row ever separates.
    groups: list[list[int]] = []
    for c in range(grid.cols):
        if groups:
            prev = groups[-1][-1]
            together = all(grid.owner(r, prev) is grid.owner(r, c) for r in range(grid.rows))
            if together:
                groups[-1].append(c)
                continue
        groups.append([c])
    labels = []
    for group in groups:
        parts = []
        for r in range(header):
            cell = grid.owner(r, group[0])
            if cell and cell.text and cell.r0 == r and cell.text not in parts:
                parts.append(cell.text)
        labels.append(" › ".join(parts))
    rows = []
    for r in body:
        cells = []
        for group in groups:
            cell = grid.owner(r, group[0])
            cells.append(cell.text if cell and cell.r0 == r and cell.c0 == group[0] else "")
        if any(cells) and not all(not v or ROW_NUMBER.match(v) for v in cells):
            rows.append(cells)
    keep = [i for i in range(len(groups)) if labels[i] or any(row[i] for row in rows)]
    if not keep:
        return ""
    lines.append("| " + " | ".join(_md(labels[i]) for i in keep) + " |")
    lines.append("|" + "|".join(" --- " for _ in keep) + "|")
    for row in rows:
        lines.append("| " + " | ".join(_md(row[i]) for i in keep) + " |")
    if blank:
        lines.append(f"({blank} blank entry rows)")
    return "\n".join(lines)


# ---------------------------------------------------------------- page assembly

def _xy_cut(words, depth=0) -> list[list[dict]]:
    """Split words into reading-order blocks: bands by horizontal gaps, columns by gutters."""
    if len(words) <= 1 or depth > 12:
        return [words] if words else []
    size = sorted(w["bottom"] - w["top"] for w in words)[len(words) // 2] or 8.0
    # Horizontal cut: a vertical gap between word bands larger than a line spacing.
    spans = sorted((w["top"], w["bottom"]) for w in words)
    bands, current = [], [spans[0][0], spans[0][1]]
    for top, bottom in spans[1:]:
        if top > current[1] + size * 0.9:
            bands.append(current); current = [top, bottom]
        else:
            current[1] = max(current[1], bottom)
    bands.append(current)
    if len(bands) > 1:
        out = []
        for top, bottom in bands:
            out.extend(_xy_cut([w for w in words if w["top"] >= top - 0.1 and w["bottom"] <= bottom + 0.1], depth + 1))
        return out
    # Vertical cut. Lines that share a gutter form columns; a full-width line above
    # or below them (a title, a "week beginning ____" line) is split off first.
    lines = _make_lines(words, size)
    if len(lines) < 2:
        return [words]
    left_edge = min(w["x0"] for w in words)
    right_edge = max(w["x1"] for w in words)
    threshold = max(size * 1.2, 7.0)

    def gaps(line):
        xs = sorted((w["x0"], w["x1"]) for w in line)
        out, reach = [], left_edge
        for x0, x1 in xs:
            if x0 - reach > threshold or (reach == left_edge and x0 - left_edge > threshold):
                out.append((reach, x0))
            reach = max(reach, x1)
        if right_edge - reach > threshold:
            out.append((reach, right_edge))
        return out

    def intersect(a, b):
        out = []
        for a0, a1 in a:
            for b0, b1 in b:
                lo, hi = max(a0, b0), min(a1, b1)
                if hi - lo > threshold:
                    out.append((lo, hi))
        return out

    line_gaps = [gaps(line) for line in lines]
    best = None
    for start in range(len(lines)):
        common = [g for g in line_gaps[start] if left_edge < g[0] and g[1] < right_edge] or None
        if not common:
            continue
        for end in range(start + 1, len(lines)):
            nxt = intersect(common, line_gaps[end])
            if not nxt:
                break
            common = nxt
            if best is None or end - start > best[1] - best[0]:
                best = (start, end, common)
    if best is None:
        return [words]
    start, end, gutters = best
    inner = [g for g in gutters if left_edge < g[0] and g[1] < right_edge]
    if not inner:
        return [words]
    out = []
    before = [w for line in lines[:start] for w in line]
    after = [w for line in lines[end + 1:] for w in line]
    middle = [w for line in lines[start:end + 1] for w in line]
    if before:
        out.extend(_xy_cut(before, depth + 1))
    edges = [left_edge - 1] + [g for gutter in sorted(inner) for g in gutter] + [right_edge + 1]
    for i in range(0, len(edges), 2):
        lo, hi = edges[i], edges[i + 1]
        column = [w for w in middle if w["x0"] >= lo - 0.1 and w["x1"] <= hi + 0.1]
        if column:
            out.extend(_xy_cut(column, depth + 1))
    if after:
        out.extend(_xy_cut(after, depth + 1))
    return out


def _make_lines(words, size):
    lines = []
    for word in sorted(words, key=lambda w: (w["top"], w["x0"])):
        mid = (word["top"] + word["bottom"]) / 2
        for line in lines:
            if abs(line["mid"] - mid) <= size * 0.5:
                line["words"].append(word)
                break
        else:
            lines.append({"mid": mid, "words": [word]})
    return [l["words"] for l in sorted(lines, key=lambda l: l["mid"])]


def _block_text(words) -> str:
    size = sorted(w["bottom"] - w["top"] for w in words)[len(words) // 2] or 8.0
    lines = []
    for word in sorted(words, key=lambda w: (w["top"], w["x0"])):
        mid = (word["top"] + word["bottom"]) / 2
        for line in lines:
            if abs(line["mid"] - mid) <= size * 0.5:
                line["words"].append(word)
                break
        else:
            lines.append({"mid": mid, "words": [word]})
    return "\n".join(" ".join(w["text"] for w in sorted(l["words"], key=lambda w: w["x0"])) for l in sorted(lines, key=lambda l: l["mid"]))


def _prose(page, bbox, exclude) -> str:
    try:
        # Filter the uncropped page: crop() clips coordinates to the crop box, which would
        # pull characters lying just outside the region onto its edge.
        region = page
        def keep(obj):
            if obj.get("object_type") != "char":
                return True
            if not obj.get("upright", True):
                return False
            cx, cy = (obj["x0"] + obj["x1"]) / 2, (obj["top"] + obj["bottom"]) / 2
            if not (bbox[1] <= cy < bbox[3] and bbox[0] <= cx <= bbox[2]):
                return False
            return not any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in exclude)
        words = region.filter(keep).extract_words(x_tolerance=1.5, y_tolerance=3, keep_blank_chars=False)
    except Exception as exc:
        _LOG.warning("Text around a ruled table could not be read on page %s: %s: %s", getattr(page, "page_number", "?"), type(exc).__name__, exc)
        return ""
    return "\n\n".join(_block_text(block) for block in _xy_cut(words) if block)


PREFIX = re.compile(r"[A-Z]{4}")
SUFFIX = re.compile(r"[A-Z0-9]{4}")
ENUMERATED = re.compile(r"^(?:\(?\d{1,3}[.)]|\(?[a-z][.)]|\([ivx]{1,4}\)|[A-Z]\.)\s")
LEADERS = re.compile(r"(?:\s*\.){3,}\s*$|(?:\s*\.){4,}")


def _inside_cell(grid: Grid, cx: float, cy: float) -> bool:
    return any(c.bbox[0] <= cx < c.bbox[2] and c.bbox[1] <= cy < c.bbox[3] for c in grid.cells)


def _free_words(page, grid: Grid):
    """Words in the grid's vertical extent that are not inside any of its cells."""
    try:
        words = page.extract_words(x_tolerance=1.5, y_tolerance=3, keep_blank_chars=False)
    except Exception as exc:
        _LOG.warning("Labels beside a ruled table could not be read on page %s: %s: %s", getattr(page, "page_number", "?"), type(exc).__name__, exc)
        return []
    x0, top, x1, bottom = grid.bbox
    out = []
    for w in words:
        cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
        if top - 1 <= cy <= bottom + 1 and not _inside_cell(grid, cx, cy):
            out.append(w)
    return out


def _attached_labels(page, grid: Grid):
    """Line-item layout: labels outside the boxes, one per row, ending in dot leaders next to them."""
    text_cells = [c for c in grid.cells if c.text]
    if len(text_cells) < 3:
        return None
    # The box column is where most of the text cells start; small entry boxes inside the
    # label area (for example "TEXT 8562") must not move the label boundary.
    from collections import Counter
    # Labels may run up to the busiest box column; words inside boxes (codes, entry
    # boxes, description boxes) are never label text because they belong to cells.
    counts = Counter(c.c0 for c in text_cells)
    busiest = max(counts.values())
    column = max(col for col, n in counts.items() if n == busiest)
    box_left = min(c.bbox[0] for c in text_cells if c.c0 == column)
    box_right = max(c.bbox[2] for c in text_cells)
    free = _free_words(page, grid)
    left = [w for w in free if w["x1"] <= box_left + 2]
    if len(left) < 4:
        return None
    anchors = sorted({c.r0 for c in text_cells})
    ys = {}
    for c in grid.cells:
        ys.setdefault(c.r0, [c.bbox[1], c.bbox[3]])
        ys[c.r0][0] = min(ys[c.r0][0], c.bbox[1])
        ys[c.r0][1] = min(ys[c.r0][1], c.bbox[3])
    hits = 0
    for r in anchors:
        top, bottom = ys[r]
        row_left = min(c.bbox[0] for c in grid.cells if c.r0 <= r < c.r1)
        if r + 1 in ys and r + 1 not in anchors:
            bottom = ys[r + 1][1]  # code printed above its entry box: the label sits beside the box
        if any(top - 2 <= (w["top"] + w["bottom"]) / 2 <= bottom + 2 and -2 <= row_left - w["x1"] < 40 for w in left):
            hits += 1
    if hits < max(2, 0.5 * len(anchors)):
        return None
    return {"left": left, "right": [w for w in free if w["x0"] >= box_right - 2], "box_left": box_left, "anchors": anchors, "bands": ys}


def _lines_of(words):
    if not words:
        return []
    size = sorted(w["bottom"] - w["top"] for w in words)[len(words) // 2] or 8.0
    return [{"mid": sum((w["top"] + w["bottom"]) / 2 for w in line) / len(line), "text": " ".join(w["text"] for w in sorted(line, key=lambda w: w["x0"]))}
            for line in _make_lines(words, size)]


def _split_enumerated(lines) -> list[str]:
    """Group lines into entries, each starting at an enumerated line."""
    entries: list[str] = []
    for text in lines:
        if not entries or ENUMERATED.match(text):
            entries.append(text)
        else:
            entries[-1] += " " + text
    return [re.sub(r"\s+", " ", LEADERS.sub(" ", e)).strip() for e in entries if e.strip()]


def render_line_items(grid: Grid, attached) -> str:
    """One row per line item: the label outside the boxes, the box contents, the item number."""
    groups: list[list[int]] = []
    for c in range(grid.cols):
        if groups and all(grid.owner(r, groups[-1][-1]) is grid.owner(r, c) for r in range(grid.rows)):
            groups[-1].append(c)
        else:
            groups.append([c])
    used = [g for g in groups if any((grid.owner(r, g[0]) or GridCell(0, 0, 0, 0, ())).text for r in range(grid.rows))]
    left_lines = _lines_of(attached["left"])
    right_lines = _lines_of(attached["right"])
    anchors = attached["anchors"]
    bands = attached["bands"]

    def items_at(top, bottom):
        return " ".join(l["text"] for l in right_lines if top - 2 <= l["mid"] <= bottom + 2)

    def emit(pending, item, cells):
        # Split at the last enumerated line: earlier lines are a heading or a note
        # ("5. Outstanding Term C&I Loans" above "a. Number"); later ones continue the label.
        texts = [l["text"] for l in pending]
        start = max((k for k, text in enumerate(texts) if ENUMERATED.match(text)), default=0)
        for heading in _split_enumerated(texts[:start]):
            rows.append(["", heading] + [""] * len(used))
        label = re.sub(r"\s+", " ", LEADERS.sub(" ", " ".join(texts[start:]))).strip()
        rows.append([item, label] + cells)

    def anchor_cells(r):
        out = []
        for g in used:
            cell = grid.owner(r, g[0])
            out.append(cell.text if cell and cell.r0 == r and cell.c0 == g[0] else "")
        return out

    def reach(ai):
        """Bottom of an anchor's label zone: its own row, or the entry-box row below it
        when the code is printed above the box ("BHCK H289" over the box of item 7)."""
        r = anchors[ai]
        nxt = r + 1
        if nxt in bands and nxt not in anchors and (ai + 1 >= len(anchors) or anchors[ai + 1] > nxt):
            # Entry boxes directly below the codes, in the same columns as the codes.
            code_cols = {(c.c0, c.c1) for c in grid.cells if c.r0 == r and c.text}
            box_cols = {(c.c0, c.c1) for c in grid.cells if c.r0 == nxt and not c.text}
            if code_cols and code_cols <= box_cols:
                return bands[nxt][1]
        return bands[r][1]

    rows, pending, ai = [], [], 0
    for line in left_lines:
        # Close box rows whose label zone ends above this line.
        def starts_item():
            return bool(ENUMERATED.match(line["text"])) and any(ENUMERATED.match(p["text"]) for p in pending)
        while ai < len(anchors) and (reach(ai) + 2 < line["mid"] or (starts_item() and bands[anchors[ai]][1] + 2 < line["mid"])):
            top, bottom = bands[anchors[ai]][0], reach(ai)
            emit(pending, items_at(top, bottom), anchor_cells(anchors[ai]))
            pending, ai = [], ai + 1
        in_band = ai < len(anchors) and bands[anchors[ai]][0] - 2 <= line["mid"] <= reach(ai) + 2
        item = "" if in_band else items_at(line["mid"] - 3, line["mid"] + 3)
        pending.append(line)
        if item:
            # A labelled line with its own line number but no box ("j. Other").
            emit(pending, item, [""] * len(used))
            pending = []
    while ai < len(anchors):
        top, bottom = bands[anchors[ai]][0], reach(ai)
        emit(pending, items_at(top, bottom), anchor_cells(anchors[ai]))
        pending, ai = [], ai + 1
    if pending:
        rows.append(["", re.sub(r"\s+", " ", LEADERS.sub(" ", " ".join(l["text"] for l in pending))).strip()] + [""] * len(used))
    # A label that wraps across a code-prefix row ("2. Federal funds sold and securities"
    # over "purchased under agreements to resell") is one line item.
    joined = []
    for row in rows:
        if (joined and not joined[-1][0] and joined[-1][1] and row[0] and row[1] and not ENUMERATED.match(row[1])
                and ENUMERATED.match(joined[-1][1])):
            prev = joined.pop()
            row = [row[0], prev[1] + " " + row[1]] + [(" ".join(v for v in (p, c) if v)) for p, c in zip(prev[2:], row[2:])]
        joined.append(row)
    rows = joined
    # A row holding only a description box ("TEXT 8562") belongs to the next line item.
    merged = []
    for row in rows:
        if merged and not merged[-1][0] and not merged[-1][1] and sum(bool(v) for v in merged[-1][2:]) == 1:
            box = merged.pop()
            row = row[:2] + [" ".join(x for x in (b, v) if x) for b, v in zip(box[2:], row[2:])]
        merged.append(row)
    rows = merged
    # Header row inside the grid (for example "BHCK | Amount") names the box columns.
    names = ["Item", "Line item"] + [""] * len(used)
    first = rows[0] if rows else None
    if first and not first[0] and all(not v or len(v) <= 12 for v in first[2:]) and any(first[2:]):
        names = ["Item", first[1] or "Line item"] + list(first[2:])
        rows = rows[1:]
    # A bare code prefix box (BHCK, BHDM) above a code box belongs to that code: "BHDM 1420".
    for i in range(len(rows) - 1):
        for j in range(2, len(rows[i])):
            if PREFIX.fullmatch(rows[i][j] or "") and SUFFIX.fullmatch(rows[i + 1][j] or ""):
                rows[i + 1][j] = rows[i][j] + " " + rows[i + 1][j]
                rows[i][j] = ""
    rows = [row for row in rows if any(row)]
    keep = [i for i in range(2 + len(used)) if any(row[i] for row in rows) or names[i]]
    lines = ["| " + " | ".join(_md(names[i]) for i in keep) + " |", "|" + "|".join(" --- " for _ in keep) + "|"]
    lines += ["| " + " | ".join(_md(row[i]) for i in keep) + " |" for row in rows]
    return "\n".join(lines)


def rebuild_page(page, normalize_prose) -> str | None:
    """Return page text with ruled tables rebuilt, or None when the page has no grid."""
    grids = [g for g in build_grids(page) if render_grid(g)]
    if not grids:
        return None
    grids.sort(key=lambda g: (g.bbox[1], g.bbox[0]))
    width, height = float(page.width), float(page.height)
    blocks, cursor = [], 0.0
    for grid in grids:
        x0, top, x1, bottom = grid.bbox
        if top - cursor >= 2:
            text = normalize_prose(_prose(page, (0, cursor, width, top), []))
            if text:
                blocks.append(text)
        attached = _attached_labels(page, grid)
        if attached:
            blocks.append(render_line_items(grid, attached))
            consumed = [w["bottom"] for w in attached["left"] + attached["right"]]
            cursor = max([cursor, bottom] + consumed)
            continue
        # Text beside a narrow table shares its vertical band.
        if x1 - x0 < width * 0.9:
            side = normalize_prose(_prose(page, (0, max(cursor, top), width, bottom), [grid.bbox]))
            if side:
                blocks.append(side)
        blocks.append(render_grid(grid))
        cursor = max(cursor, bottom)
    if cursor < height - 2:
        text = normalize_prose(_prose(page, (0, cursor, width, height), []))
        if text:
            blocks.append(text)
    return "\n\n".join(block for block in blocks if block.strip())
