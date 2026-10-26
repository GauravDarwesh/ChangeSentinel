"""Structured diffs of regulatory specifications: rules, fields, schemas.

A plain redline tells a reporting team that lines moved. The questions they
actually ask about a new edit-check workbook, data dictionary or taxonomy are
row-level: which rules are new, which were retired and from when, which edit
logic changed, which checks became blocking, which fields were added or
redefined. ``diff()`` answers them deterministically from the before and after
text the engine already saves (same answer on every machine, no model).

What it understands
-------------------
* **Rule tables** (edit checks, validation rules, DIM/conventional rules): a
  table whose header has a rule identifier (Edit No, Rule ID, Check ID, ...)
  and logic, a message or a description. Rows are aligned by the smallest key
  that is unique on both sides (rule ID; ID + version; table + ID + version;
  series + table + ID + version), so a rule inserted near the top is one new
  rule, not hundreds of changed rows.
* **Field tables** (data dictionaries, PDF field-spec tables, DPM/measure
  lists): a header with a field code (Technical Field Name / MDRM, Item code,
  Data element, Measure name, DPM, formato, campo, ...), aligned the same way.
* **Schemas**: XSD elements (by path), named types with their facets, code
  lists (xs:enumeration with their labels); XBRL linkbases: concept labels and
  formula assertions (test, messages, severity, FFIEC ruleType).

Text sources: the structured workbook text (``Sheet · A: x · B: y``), the
older row text (``[SHEET]`` then ``a | b | c``), markdown tables written by the
PDF/DOCX extractors and CSV (``| a | b |``), and XML. ``[FILE]`` sections of a
ZIP bundle are separate documents; a document whose name only differs by its
period or version (``..._2026Q2_..._V1.pdf`` → ``..._2026Q3_..._V2.pdf``) is
treated as the same document.

What it reports per changed row
-------------------------------
A category (most important first): added / new version, severity changed
(escalated or relaxed), logic changed, retired, reinstated, effective dates
changed, message changed, definition changed, description changed, removed,
metadata only, cosmetic only. YYYYMMDD sentinels are understood (99991231 =
open-ended, 19000101 = all periods), so an end date going from 99991231 to
20260630 reads "last applies to 2026-06-30 (Q2 2026)" rather than a number
that fell. Retired rules are checked for a live replacement version.

Two things no spreadsheet compare does:

* **Systematic edits** — the same token swap in one column across many rows
  (every comment going from "Q1 2026" to "Q1 2027") — are collapsed into one
  pattern instead of thousands of rows, when the column is commentary.
* **Declared vs detected** — regulators annotate rows ("New Rule - Effective
  Q1 2027", "Updated", "Deprecated", Status "Archived"). Each row's newly
  declared action is reconciled with what actually changed, and mismatches are
  listed: a rule whose logic changed while it still says "Existing Rule -
  Remains Effective", or a rule newly marked "Updated" with nothing different.

Results are capped so a rewritten document cannot bloat evidence files.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path, PurePosixPath

VERSION = 1
MAX_TABLES = 60
MAX_CHANGES_PER_TABLE = 400
MAX_TOTAL_CHANGES = 2000
MAX_VALUE = 600
MAX_TEXT_CHARS = 40_000_000
HEADER_SCAN_ROWS = 40
SYSTEMATIC_MIN_ROWS = 10
SYSTEMATIC_SHARE = 0.25

OPEN_ENDED = {"99991231", "9999-12-31"}
ALL_PERIODS = {"19000101", "1900-01-01"}

# Header names → roles. Matched against the normalized header (lower case,
# punctuation as spaces) with fullmatch, in this order; a role is given to
# the first column that matches it.
ROLE_PATTERNS: list[tuple[str, str]] = [
    ("version", r"(edit |rule |check |validation )?(version|ver)( no| number| #| id)?"),
    ("id", r"(edit|rule|check|validation|validation rule|edit check|assertion|test|business rule)\s?"
           r"(no|nbr|num|number|id|identifier|code|ref|reference|#|name)|id|identifier|edit|rule"),
    ("start", r"(start|begin|effective|effective start|valid from|effective from|start effective|first effective)( date)?( yyyymmdd)?"
              r"|startdate|from date|date effective|effective period"),
    ("end", r"(end|expiry|expiration|effective end|valid to|effective to|end effective|retire|retirement|last effective)( date)?( yyyymmdd)?"
            r"|enddate|to date"),
    ("status", r"(edit |rule |field |item |element |change |dpa )?status|change type|action"),
    ("severity", r"severity( level)?|error level|level|criticality|error (type|class|severity)|blocking|edit severity|rule severity"
                 r"|validation level|severidad|gravedad|severidade"),
    ("etype", r"(edit|check|rule|validation|test) (type|category|class)|type of (edit|check|rule)|category"),
    ("logic", r"((edit|rule|check|validation) )?(logic|formula|expression|test|condition|criteria)|data expression|xpath|assertion test"
              r"|.*derivation.*|calculation"),
    ("message", r"((error|edit|failure|warning|validation) )?(message|text)( en)?|error description|edit text"),
    ("field", r"technical field name( mdrm)?|mdrm( number| code| item| id)?|item code|item id|data element( name| code| id)?"
              r"|field( name| code| id)?|variable( name| code)?|data ?point( id| code)?|dpm( id| code| data ?point( id)?)?"
              r"|measure name.*|concept( name| id)?|element( name| path)?|xbrl (code|element|concept)|formato|c[oó]digo( de campo)?"
              r"|campo|cuenta|account( code| no| number)?|line item code|dpa( id| code)?|key value|code"),
    ("description", r"(rule|edit|check|item|field|element|measure|concept|data ?point|account)? ?(descriptions?|definition|label|explanation)"
                    r"|description|.*english name.*|business name|nombre|descripci[oó]n|denomina[cç][aã]o"),
    ("line_item", r"(report )?(form )?line item( number| no)?|line( no| number)?|item (no|number)|row( code)?|cell( reference| id)?"
                  r"|column code|schedule line"),
    ("table", r"database table|table( name)?|schedule( reference| code| no| number)?|template( code| id)?|xml table|worksheet"
              r"|collection( id)?|record (type|reference)( code)?|module|anexo|reporte|documento|owner"),
    ("series", r"series|report( code| name)?|form( code| name| number)?|return( code)?|survey"),
    ("dtype", r"(data |field |item )?type|attributes( format.*)?|format.*|fieldtype.*|length|precision|scale|decimal point.*|data format"
              r"|allowable values|valid values|mandatory|required|nullable|nillable|primary key|unit|base|facets|period type|balance"
              r"|substitution group|abstract|min occurs|max occurs|tipo( de dato)?|longitud"),
    ("modified", r"(reporting period )?modified date|last modified|date modified|last updated|revision date|reporting period modified"),
    ("comments", r"comments?|notes?|remarks|change (description|details|notes)|details of change|observaciones|observa[cç][oõ]es"),
]
_ROLE_RE = [(role, re.compile(pattern)) for role, pattern in ROLE_PATTERNS]

# Category order is importance order: a row is listed under its first match.
CATEGORIES = ["added", "added_version", "severity", "logic", "retired", "reinstated", "effective", "message",
              "definition", "description", "removed", "metadata", "cosmetic"]
CATEGORY_LABELS = {
    "rules": {"added": "New rule", "added_version": "New version of existing rule", "severity": "Severity changed",
              "logic": "Logic changed", "retired": "Retired", "reinstated": "Reinstated", "effective": "Effective dates changed",
              "message": "Message changed", "definition": "Definition changed", "description": "Description changed",
              "removed": "Removed from file", "metadata": "Metadata only", "cosmetic": "Cosmetic only"},
    "fields": {"added": "New field", "added_version": "New version of existing field", "severity": "Severity changed",
               "logic": "Derivation changed", "retired": "Retired", "reinstated": "Reinstated", "effective": "Effective dates changed",
               "message": "Message changed", "definition": "Definition changed", "description": "Description changed",
               "removed": "Removed from file", "metadata": "Metadata only", "cosmetic": "Cosmetic only"},
    "codes": {"added": "New code", "removed": "Code removed", "description": "Label changed", "definition": "Definition changed",
              "metadata": "Metadata only", "cosmetic": "Cosmetic only"},
}
CATEGORY_LABELS["concepts"] = {**CATEGORY_LABELS["fields"], "added": "New element", "removed": "Element removed"}
CATEGORY_LABELS["types"] = {**CATEGORY_LABELS["fields"], "added": "New type", "removed": "Type removed"}
CATEGORY_LABELS["labels"] = {**CATEGORY_LABELS["codes"], "added": "New label", "removed": "Label removed", "description": "Label changed"}
NOUNS = {"rules": ("rule", "rules"), "fields": ("field", "fields"), "codes": ("code", "codes"), "concepts": ("element", "elements"),
         "types": ("type", "types"), "labels": ("label", "labels")}

ROLE_CATEGORY = {"logic": "logic", "message": "message", "severity": "severity", "description": "description",
                 "dtype": "definition", "line_item": "definition", "field": "definition", "etype": "definition"}

RETIRED_WORDS = re.compile(r"deprecat|archiv|delet|retir|withdr[ae]w|disabl|inactiv|discontinu|expired|obsolete|removed|superseded"
                           r"|eliminad|derogad|desactivad|exclu[ií]d|baja\b|revogad", re.I)
NEW_WORDS = re.compile(r"\bnew\b|\badded\b|introduc|\bnuev[oa]s?\b|\bnov[oa]s?\b|\bincluid", re.I)
UPDATED_WORDS = re.compile(r"\bupdated?\b|\brevised?\b|\bmodif|\bamended?\b|\bchanged?\b|\bactualizad|\balterad", re.I)
UNCHANGED_WORDS = re.compile(r"no change|\bexisting\b|unchanged|\bremains?\b|\bsin cambio|\bsem altera", re.I)
SEVERITY_RANKS = [
    (3, re.compile(r"block|fatal|critical|\berror\b|reject|validity|syntax|mandatory|hard|bloquea|cr[ií]tic", re.I)),
    (2, re.compile(r"warn|quality|intraseries|interseries|soft|alert|advertencia|alerta|aviso", re.I)),
    (1, re.compile(r"info|notice|\bok\b|observation|informativ", re.I)),
]
QUARTER_IN_TEXT = re.compile(r"\b(?:Q([1-4])\s*(20\d\d)|(20\d\d)\s*Q([1-4]))\b", re.I)


# --------------------------------------------------------------------------- text → tables


@dataclass
class Table:
    doc: str
    sheet: str
    header: list[str]
    rows: list[list[str]] = field(default_factory=list)
    kind: str = ""
    roles: dict[str, int] = field(default_factory=dict)   # role → column index
    title: str = ""

    @property
    def name(self) -> str:
        parts = [part for part in (_short_doc(self.doc), self.sheet) if part]
        return " · ".join(parts) or self.title or "Table"


def _clean(value) -> str:
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()


def _norm_header(text: str) -> str:
    return re.sub(r"[^a-z0-9#áéíóúãõç]+", " ", str(text or "").lower()).strip()


_DOC_NOISE = [
    re.compile(r"(?<![a-z0-9])(19|20)\d\d[-_ ]?q[1-4](?![a-z0-9])", re.I),
    re.compile(r"(?<![a-z0-9])q[1-4][-_ ]?(19|20)\d\d(?![a-z0-9])", re.I),
    re.compile(r"(?<![0-9])(19|20)\d\d[-_.]?[01]\d[-_.]?[0-3]\d(?![0-9])"),
    re.compile(r"(?<![a-z0-9])v(er(sion)?)?[-_ ]?\d+([._]\d+)*(?![a-z0-9])", re.I),
    re.compile(r"(?<![a-z0-9])(19|20)\d\d(?![a-z0-9])"),
]


def _doc_identity(name: str) -> str:
    """A document name without its period, date and version tokens."""
    stem = PurePosixPath(str(name or "")).name
    stem = re.sub(r"\.[a-z0-9]{2,5}$", "", stem, flags=re.I)
    for pattern in _DOC_NOISE:
        stem = pattern.sub(" ", stem)
    return re.sub(r"[^a-z0-9]+", " ", stem.lower()).strip()


def _short_doc(name: str) -> str:
    return PurePosixPath(str(name or "")).name


_CELL_SPLIT = re.compile(r" · (?=[A-Z]{1,3}: )")
_CELL = re.compile(r"^([A-Z]{1,3}): (.*)$", re.S)
_FILE = re.compile(r"^\[FILE\] (.+?) \(([a-z0-9]+)\)\s*$")
_SHEET = re.compile(r"^\[SHEET(?: [a-z]+)?\] (.+)$")


def _column_index(letters: str) -> int:
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _split_markdown(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells = re.split(r"(?<!\\)\|", body)
    return [_clean(cell.replace("\\|", "|")) for cell in cells]


def _is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", cell or "") for cell in cells if cell) and any(cells)


def _documents(text: str) -> list[tuple[str, str, str]]:
    """(name, kind, body) for each [FILE] section, or one unnamed document."""
    lines = str(text or "").splitlines()
    if not any(_FILE.match(line) for line in lines[:1] + lines):
        return [("", "", str(text or ""))]
    docs, name, kind, body = [], "", "", []
    for line in lines:
        match = _FILE.match(line)
        if match:
            if name or body:
                docs.append((name, kind, "\n".join(body)))
            name, kind, body = match.group(1), match.group(2), []
        else:
            body.append(line)
    docs.append((name, kind, "\n".join(body)))
    return docs


def _grids(doc: str, body: str) -> list[tuple[str, list[list[str]], str]]:
    """(sheet, rows, mode) blocks of a text document; mode is cells, pipe or markdown."""
    grids: list[tuple[str, list[list[str]], str]] = []
    mode = "cells"
    sheet = ""
    sheet_rows: list[list[str]] | None = None
    markdown: list[list[str]] = []

    def flush_markdown():
        nonlocal markdown
        if markdown:
            grids.append((sheet if sheet_rows is not None else "", markdown, "markdown"))
            markdown = []

    for raw in body.splitlines():
        line = raw.rstrip()
        if line.startswith("[WORKBOOK]") or line.startswith(("[MERGED]", "[VALIDATION]", "[NAME]", "[TRUNCATED]")):
            continue
        match = _SHEET.match(line)
        if match:
            flush_markdown()
            if sheet_rows:
                grids.append((sheet, sheet_rows, mode))
            sheet, sheet_rows, mode = match.group(1).strip(), [], "cells"
            continue
        if sheet_rows is not None and sheet and line.startswith(sheet + " · "):
            cells: dict[int, str] = {}
            for part in _CELL_SPLIT.split(line[len(sheet) + 3:]):
                cell = _CELL.match(part)
                if cell:
                    cells[_column_index(cell.group(1))] = _clean(cell.group(2))
            if cells:
                width = max(cells) + 1
                sheet_rows.append([cells.get(index, "") for index in range(width)])
            continue
        if line.lstrip().startswith("|") and sheet_rows is None:
            cells = _split_markdown(line)
            if not _is_separator(cells) and any(cells):
                markdown.append(cells)
            continue
        flush_markdown()
        if sheet_rows is not None and line.strip():
            # Older workbook text: cells joined with " | " (empty cells kept).
            mode = "pipe"
            sheet_rows.append([_clean(cell) for cell in re.split(r"(?:^|(?<= ))\|(?: |$)", line)])
    flush_markdown()
    if sheet_rows:
        grids.append((sheet, sheet_rows, mode))
    return grids


def _roles(header: list[str]) -> dict[str, int]:
    roles: dict[str, int] = {}
    for index, name in enumerate(header):
        normalized = _norm_header(name)
        if not normalized or len(normalized) > 80:
            continue
        for role, pattern in _ROLE_RE:
            if role in roles:
                continue
            if pattern.fullmatch(normalized):
                roles[role] = index
                break
    return roles


def _kind(roles: dict[str, int]) -> str:
    if "id" in roles and any(role in roles for role in ("logic", "message", "description")):
        return "rules"
    if "field" in roles and any(role in roles for role in ("dtype", "description", "line_item", "end", "status", "comments", "logic")):
        return "fields"
    return ""


def _header_score(row: list[str]) -> tuple[str, dict[str, int], int]:
    filled = [cell for cell in row if cell]
    if len(filled) < 2 or sum(len(cell) > 90 for cell in filled) > 1:
        return "", {}, 0
    # A header is labels, not data: mostly non-numeric short cells.
    if sum(bool(re.fullmatch(r"[-+]?[\d.,%]+", cell)) for cell in filled) > len(filled) / 3:
        return "", {}, 0
    roles = _roles(row)
    kind = _kind(roles)
    return kind, roles, len(roles) if kind else 0


def _pad(row: list[str], width: int) -> list[str]:
    return row + [""] * (width - len(row)) if len(row) < width else row


def _tables_from_grid(doc: str, sheet: str, rows: list[list[str]], mode: str) -> list[Table]:
    tables: list[Table] = []
    current: Table | None = None
    raw_width = 0
    markdown = mode == "markdown"
    for index, row in enumerate(rows):
        # Markdown blocks are short and every page may repeat its header; a sheet
        # has its header near the top (a sheet with none in 200 rows has no table).
        if markdown or index < HEADER_SCAN_ROWS or (current is None and index < 200):
            kind, roles, _score = _header_score(row)
        elif current is None:
            break
        else:
            kind, roles = "", {}
        if kind:
            normalized = [_norm_header(cell) for cell in row]
            if current is not None and [_norm_header(cell) for cell in current.header] == normalized:
                continue  # a header repeated on each PDF page
            header = [_clean(cell) for cell in row]
            raw_width = len(header)
            while header and not header[-1]:
                header.pop()
            current = Table(doc=doc, sheet=sheet, header=header, kind=kind, roles=roles)
            tables.append(current)
            continue
        if current is None:
            continue
        # Every genuine row of the older text has a cell for every sheet column,
        # so in that text a short line is a fragment of a cell holding a line break.
        width = raw_width
        previous = current.rows[-1] if current.rows else None
        if mode == "pipe" and previous is not None and len(previous) < width and len(previous) + len(row) - 1 <= width:
            previous[-1] = _clean(previous[-1] + " " + row[0])
            previous.extend(row[1:])
            continue
        current.rows.append(list(row))
    for table in tables:
        table.rows = [_pad(row, len(table.header)) for row in table.rows]
    return tables


def _merge_continuations(tables: list[Table]) -> list[Table]:
    """Join tables of the same document and sheet that share a header (PDF pages, split blocks)."""
    merged: list[Table] = []
    for table in tables:
        for existing in merged:
            if (existing.doc, existing.sheet, existing.kind) == (table.doc, table.sheet, table.kind) and \
                    [_norm_header(cell) for cell in existing.header] == [_norm_header(cell) for cell in table.header]:
                existing.rows.extend(table.rows)
                break
        else:
            merged.append(table)
    return merged


# --------------------------------------------------------------------------- XML → tables


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _attr(node, name: str) -> str:
    for key, value in node.attrib.items():
        if _local(key) == name:
            return value
    return ""


def _xml_name(value: str) -> str:
    """Decode XML name escapes such as _x0031_001 → 1001."""
    return re.sub(r"_x([0-9A-Fa-f]{4})_", lambda match: chr(int(match.group(1), 16)), str(value or ""))


def _documentation(node) -> str:
    """The node's own xs:annotation text (not a child element's)."""
    for annotation in node:
        if _local(annotation.tag) != "annotation":
            continue
        for child in annotation:
            if _local(child.tag) == "documentation" and "".join(child.itertext()).strip():
                return _clean("".join(child.itertext()))[:MAX_VALUE]
    return ""


def _xsd_tables(doc: str, root) -> list[Table]:
    concepts = Table(doc=doc, sheet="Elements", header=["Element", "Type", "Min occurs", "Max occurs", "Nillable", "Period type",
                                                        "Balance", "Substitution group", "Abstract", "Description"], kind="concepts")
    types = Table(doc=doc, sheet="Types", header=["Type", "Base", "Facets", "Description"], kind="types")
    codes = Table(doc=doc, sheet="Code lists", header=["Code", "Value", "List", "Label"], kind="codes")
    parents = {child: parent for parent in root.iter() for child in parent}

    def owner_path(node) -> list[str]:
        path = []
        current = node
        while current in parents:
            current = parents[current]
            local = _local(current.tag)
            name = _attr(current, "name")
            if name and local in {"element", "complexType", "simpleType", "attributeGroup", "group"}:
                path.append(_xml_name(name) if local == "element" else f"type:{_xml_name(name)}")
        return list(reversed(path))

    def type_of(node) -> str:
        explicit = _attr(node, "type")
        if explicit:
            return _xml_name(explicit)
        # The element's own anonymous type, without descending into child elements.
        stack = list(node)
        while stack:
            child = stack.pop(0)
            local = _local(child.tag)
            if local == "element":
                continue
            if local in {"extension", "restriction"} and _attr(child, "base"):
                return _xml_name(_attr(child, "base"))
            stack.extend(list(child))
        return ""

    for node in root.iter():
        local = _local(node.tag)
        name = _attr(node, "name")
        if local == "element" and name:
            path = "/".join(owner_path(node) + [_xml_name(name)])
            concepts.rows.append([path, type_of(node), _attr(node, "minOccurs"), _attr(node, "maxOccurs"), _attr(node, "nillable"),
                                  _attr(node, "periodType"), _attr(node, "balance"), _attr(node, "substitutionGroup"),
                                  _attr(node, "abstract"), _documentation(node)])
        elif local in {"complexType", "simpleType"} and name:
            facets = []
            base = ""
            for child in node.iter():
                child_local = _local(child.tag)
                if child_local in {"restriction", "extension"} and not base:
                    base = _xml_name(_attr(child, "base"))
                elif child_local in {"totalDigits", "fractionDigits", "maxLength", "minLength", "length", "pattern",
                                     "minInclusive", "maxInclusive", "minExclusive", "maxExclusive", "whiteSpace"}:
                    facets.append(f"{child_local}={_attr(child, 'value')}")
            types.rows.append([_xml_name(name), base, ", ".join(facets), _documentation(node)])
        elif local == "enumeration":
            owner = owner_path(node)
            named_types = [part.split(":", 1)[1] for part in owner if part.startswith("type:")]
            owner_name = named_types[-1] if named_types else (owner[-1] if owner else "")
            value = _attr(node, "value")
            label = _documentation(node)
            label_match = re.match(r"Key '.*?' = Label '(.*)'$", label)
            codes.rows.append([f"{owner_name}={value}", value, owner_name, label_match.group(1) if label_match else label])
    for table in (concepts, types, codes):
        table.roles = _roles(table.header)
        if table.kind == "concepts":
            table.roles = {"field": 0, "dtype": 1, "description": 9}
        elif table.kind == "types":
            table.roles = {"field": 0, "dtype": 1, "description": 3}
        else:
            table.roles = {"field": 0, "line_item": 1, "table": 2, "description": 3}
    return [table for table in (concepts, types, codes) if table.rows]


FFIEC_RULE_TYPES = {"ruletype1": "Validity", "ruletype2": "Quality", "ruletype3": "Reportability rule", "ruletype4": "Reportability edit"}


def _linkbase_tables(doc: str, root) -> list[Table]:
    locators: dict[str, str] = {}
    resources: dict[str, list] = defaultdict(list)
    assertions: dict[str, dict] = {}
    severities: dict[str, str] = {}
    arcs: list[tuple[str, str, str]] = []
    for node in root.iter():
        local = _local(node.tag)
        label = _attr(node, "label")
        if local == "loc":
            href = _attr(node, "href")
            locators[label] = href.split("#", 1)[-1] if href else label
        elif local in {"valueAssertion", "existenceAssertion", "consistencyAssertion"}:
            key = _attr(node, "id") or label
            assertions[label or key] = {"id": key, "type": local.replace("Assertion", ""), "test": _clean(_attr(node, "test")),
                                        "messages": [], "labels": [], "rule_type": "", "severity": ""}
        elif local in {"label", "message"} and label and (node.text or "").strip():
            resources[label].append((_attr(node, "role"), _clean("".join(node.itertext())), _attr(node, "lang")))
        elif local in {"error", "warning", "ok"} and label:
            severities[label] = local.capitalize()
        elif _attr(node, "from") and _attr(node, "to"):
            arcs.append((_attr(node, "from"), _attr(node, "to"), _attr(node, "arcrole")))
    labels = Table(doc=doc, sheet="Labels", header=["Label", "Concept", "Role", "Language", "Text"], kind="labels")
    for source, target, arcrole in arcs:
        if source in assertions:
            assertion = assertions[source]
            if target in severities:
                assertion["severity"] = severities[target]
            for role, text, _lang in resources.get(target, []):
                role_tail = role.rsplit("/", 1)[-1].lower()
                if role_tail in FFIEC_RULE_TYPES:
                    assertion["rule_type"] = FFIEC_RULE_TYPES[role_tail]
                if "message" in arcrole.lower() or role_tail.startswith("rulemessage") or "message" in role.lower():
                    assertion["messages"].append(text)
                else:
                    assertion["labels"].append(text)
        elif source in locators and target in resources:
            concept = _xml_name(locators[source])
            for role, text, lang in resources[target]:
                role_name = role.rsplit("/", 1)[-1] or "label"
                labels.rows.append([f"{concept}|{role_name}|{lang}", concept, role_name, lang, text[:MAX_VALUE]])
    rules = Table(doc=doc, sheet="Assertions", header=["Rule ID", "Assertion type", "Rule type", "Severity", "Test", "Message", "Description"],
                  kind="rules")
    for assertion in assertions.values():
        identifier = assertion["id"]
        match = re.match(r"^[^_]+_(.+?)(?:_formula)?$", identifier)
        display = match.group(1) if match and assertion["rule_type"] else identifier
        rules.rows.append([display, assertion["type"], assertion["rule_type"], assertion["severity"], assertion["test"][:MAX_VALUE * 4],
                           " | ".join(assertion["messages"])[:MAX_VALUE], " | ".join(assertion["labels"])[:MAX_VALUE]])
    rules.roles = {"id": 0, "etype": 2, "severity": 3, "logic": 4, "message": 5, "description": 6}
    labels.roles = {"field": 0, "table": 1, "description": 4}
    return [table for table in (rules, labels) if table.rows]


def _xml_tables(doc: str, body: str) -> list[Table]:
    try:
        root = ET.fromstring(body.strip().encode("utf-8"))
    except (ET.ParseError, ValueError):
        return []
    local = _local(root.tag)
    if local == "schema":
        return _xsd_tables(doc, root)
    if local == "linkbase" or any(_local(node.tag) in {"valueAssertion", "existenceAssertion", "consistencyAssertion", "loc"}
                                  for node in root.iter()):
        return _linkbase_tables(doc, root)
    return []


def tables_from_text(text: str | None) -> list[Table]:
    """Every rule, field, code-list and schema table the text holds."""
    if not text or len(text) > MAX_TEXT_CHARS:
        return []
    found: list[Table] = []
    for name, kind, body in _documents(text):
        stripped = body.lstrip()
        if kind in {"xml", "xsd"} or (stripped.startswith("<") and not stripped.startswith("<!DOCTYPE html")):
            found.extend(_xml_tables(name, body))
            continue
        tables: list[Table] = []
        for sheet, rows, mode in _grids(name, body):
            tables.extend(_tables_from_grid(name, sheet, rows, mode))
        found.extend(_merge_continuations(tables))
    return [table for table in found if table.rows][:MAX_TABLES * 2]


# --------------------------------------------------------------------------- values


def _canon(value: str) -> str:
    text = _clean(value)
    if re.fullmatch(r"-?\d+\.0+", text):
        text = text.split(".", 1)[0]
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})[ T]00:00(:00)?", text)
    if match:
        text = match.group(1)
    return text


def _loose(value: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", _canon(value).casefold())


def _as_date(value: str) -> date | None:
    text = _canon(value)
    match = re.fullmatch(r"(\d{4})-?(\d{2})-?(\d{2})", text)
    if not match:
        match_us = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
        if not match_us:
            return None
        month, day, year = map(int, match_us.groups())
    else:
        year, month, day = map(int, match.groups())
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _is_open(value: str) -> bool:
    text = _canon(value)
    return not text or text in OPEN_ENDED or text.lower() in {"n/a", "na", "open", "none", "-"}


def _quarter(day: date | None) -> str:
    return f"Q{(day.month - 1) // 3 + 1} {day.year}" if day else ""


def _day_text(value: str) -> str:
    day = _as_date(value)
    return day.isoformat() if day else _canon(value)


def _severity_rank(value: str) -> int:
    for rank, pattern in SEVERITY_RANKS:
        if pattern.search(value or ""):
            return rank
    return 0


def _declared(value: str) -> str:
    """What a status or comment cell says happened to the row: new, updated, retired, unchanged."""
    text = _clean(value)
    if not text:
        return ""
    if NEW_WORDS.search(text):
        return "new"
    remains = re.search(r"\bremains?\b", text, re.I)
    if RETIRED_WORDS.search(text):
        return "retired_state" if remains else "retired"
    if UNCHANGED_WORDS.search(text):
        return "unchanged"
    if UPDATED_WORDS.search(text):
        return "updated"
    return ""


def _short(value: str, limit: int = MAX_VALUE) -> str:
    text = _clean(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


# --------------------------------------------------------------------------- alignment


@dataclass
class Side:
    table: Table
    columns: dict[str, int]                  # normalized header → index
    keyed: dict[str, list[str]]
    order: list[str]
    duplicates: int = 0


KEY_PLANS = {
    "rules": [["id"], ["id", "version"], ["table", "id"], ["table", "id", "version"], ["series", "table", "id", "version"],
              ["series", "table", "id", "version", "etype"], ["series", "table", "id", "version", "field"]],
    "fields": [["field"], ["table", "field"], ["series", "table", "field"], ["table", "field", "line_item"],
               ["series", "table", "field", "start"]],
}
for _kind_name in ("concepts", "types", "codes", "labels"):
    KEY_PLANS[_kind_name] = [["field"]]


def _cell(table: Table, row: list[str], role: str) -> str:
    index = table.roles.get(role)
    return row[index] if index is not None and index < len(row) else ""


def _row_key(table: Table, row: list[str], roles: list[str]) -> str:
    return " | ".join(_canon(_cell(table, row, role)).upper() for role in roles)


def _usable_rows(table: Table, roles: list[str]) -> list[list[str]]:
    anchor = "id" if "id" in roles else ("field" if "field" in roles else roles[-1])
    return [row for row in table.rows if re.search(r"[0-9A-Za-z]", _cell(table, row, anchor))]


def _choose_key(before: Table, after: Table) -> list[str]:
    plans = KEY_PLANS.get(after.kind, [["field"]])
    usable = [plan for plan in plans if all(role in before.roles and role in after.roles for role in plan)]
    for plan in usable:
        unique = True
        for table in (before, after):
            keys = [_row_key(table, row, plan) for row in _usable_rows(table, plan)]
            if len(keys) != len(set(keys)):
                unique = False
                break
        if unique:
            return plan
    return usable[-1] if usable else plans[0]


def _side(table: Table, key_roles: list[str]) -> Side:
    keyed: dict[str, list[str]] = {}
    order: list[str] = []
    seen: Counter = Counter()
    duplicates = 0
    for row in _usable_rows(table, key_roles):
        key = _row_key(table, row, key_roles)
        seen[key] += 1
        if seen[key] > 1:
            duplicates += 1
            key = f"{key} #{seen[key]}"
        keyed[key] = row
        order.append(key)
    columns = {}
    for index, name in enumerate(table.header):
        normalized = _norm_header(name) or f"column {index + 1}"
        if normalized in columns:
            normalized = f"{normalized} {index + 1}"
        columns[normalized] = index
    return Side(table=table, columns=columns, keyed=keyed, order=order, duplicates=duplicates)


def _match_tables(before: list[Table], after: list[Table]) -> list[tuple[Table | None, Table | None]]:
    def identity(table: Table) -> tuple:
        return (_doc_identity(table.doc), _norm_header(table.sheet), table.kind)

    def signature(table: Table) -> tuple:
        return tuple(sorted(table.roles))

    pairs: list[tuple[Table | None, Table | None]] = []
    remaining = list(before)
    for table in after:
        candidates = [old for old in remaining if identity(old) == identity(table)]
        if len(candidates) > 1:
            candidates = [old for old in candidates if signature(old) == signature(table)] or candidates
        if not candidates:
            # The same kind of table under a renamed sheet or document.
            same_kind = [old for old in remaining if old.kind == table.kind and _doc_identity(old.doc) == _doc_identity(table.doc)
                         and signature(old) == signature(table)]
            if len(same_kind) == 1 and sum(1 for new in after if new.kind == table.kind and _doc_identity(new.doc) == _doc_identity(table.doc)) == 1:
                candidates = same_kind
        if candidates:
            remaining.remove(candidates[0])
            pairs.append((candidates[0], table))
        else:
            pairs.append((None, table))
    pairs.extend((old, None) for old in remaining)
    return pairs


# --------------------------------------------------------------------------- row classification


def _word_signature(before: str, after: str) -> tuple[tuple[str, ...], tuple[str, ...]] | None:
    old, new = _canon(before).split(), _canon(after).split()
    removed, added = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag != "equal":
            removed.extend(old[i1:i2])
            added.extend(new[j1:j2])
    if len(removed) + len(added) > 6:
        return None
    return tuple(removed), tuple(added)


def _role_of(side: Side, column: str) -> str:
    index = side.columns.get(column)
    for role, role_index in side.table.roles.items():
        if role_index == index:
            return role
    return ""


def _values(table: Table, row: list[str]) -> dict[str, str]:
    out = {}
    for role in ("id", "version", "field", "table", "series", "line_item", "etype", "severity", "start", "end", "status",
                 "logic", "message", "description", "dtype", "comments"):
        value = _cell(table, row, role)
        if value:
            out[role] = _short(value)
    return out


def _effective(table: Table, row: list[str]) -> tuple[str, str]:
    start, end = _cell(table, row, "start"), _cell(table, row, "end")
    end_day = _as_date(end) if not _is_open(end) else None
    if end_day:
        return f"last applies to {end_day.isoformat()}", _quarter(end_day)
    start_text = _canon(start)
    if start_text in ALL_PERIODS:
        return "applies to all periods", ""
    start_day = _as_date(start)
    if start_day:
        return f"applies from {start_day.isoformat()}", _quarter(start_day)
    for value in (_cell(table, row, "status"), _cell(table, row, "comments")):
        match = QUARTER_IN_TEXT.search(value or "")
        if match:
            quarter = f"Q{match.group(1) or match.group(4)} {match.group(2) or match.group(3)}"
            return f"effective {quarter}", quarter
    return "", ""


def _label(table: Table, row: list[str]) -> str:
    if table.kind == "rules":
        identifier = _canon(_cell(table, row, "id"))
        version = _canon(_cell(table, row, "version"))
        return identifier + (f" v{version}" if version and not version.lower().startswith("v") else (f" {version}" if version else ""))
    return _canon(_cell(table, row, "field"))


def _is_retired(table: Table, row: list[str]) -> bool:
    end = _cell(table, row, "end")
    if "end" in table.roles and not _is_open(end) and _as_date(end):
        return True
    status = _cell(table, row, "status")
    if status and RETIRED_WORDS.search(status):
        return True
    return _declared(_cell(table, row, "comments")) in {"retired", "retired_state"}


def _classify_pair(before_side: Side, after_side: Side, old: list[str], new: list[str], systematic: set) -> dict | None:
    table = after_side.table
    columns = []
    roles_changed: set[str] = set()
    substantive = False
    for column, after_index in after_side.columns.items():
        if column not in before_side.columns:
            continue
        before_value = old[before_side.columns[column]] if before_side.columns[column] < len(old) else ""
        after_value = new[after_index] if after_index < len(new) else ""
        if _canon(before_value) == _canon(after_value):
            continue
        role = _role_of(after_side, column)
        if _loose(before_value) == _loose(after_value):
            kind = "cosmetic"
        elif (column, _word_signature(before_value, after_value)) in systematic:
            kind = "systematic"
        else:
            kind = "substantive"
            substantive = True
            if role:
                roles_changed.add(role)
            elif table.kind in {"concepts", "types"}:
                roles_changed.add("dtype")  # every schema attribute (occurrence, facets, period type) defines the item
        columns.append({"column": table.header[after_index], "role": role, "before": _short(before_value), "after": _short(after_value),
                        "kind": kind})
    if not columns:
        return None
    categories: list[str] = []
    severity = None
    if "severity" in roles_changed or "etype" in roles_changed:
        role = "severity" if "severity" in roles_changed else "etype"
        old_value, new_value = _cell(before_side.table, old, role), _cell(table, new, role)
        old_rank, new_rank = _severity_rank(old_value), _severity_rank(new_value)
        if role == "severity" or (old_rank and new_rank and old_rank != new_rank):
            direction = "escalated" if new_rank > old_rank else ("relaxed" if new_rank < old_rank else "changed")
            severity = {"before": _short(old_value, 80), "after": _short(new_value, 80), "direction": direction}
            categories.append("severity")
    if "logic" in roles_changed:
        categories.append("logic")
    if table.kind == "rules" and "logic" not in table.roles and "description" in roles_changed:
        categories.append("logic")  # Rule tables whose description is the expression (OSFI "Rule Description").
    was_retired, now_retired = _is_retired(before_side.table, old), _is_retired(table, new)
    if now_retired and not was_retired:
        categories.append("retired")
    elif was_retired and not now_retired:
        categories.append("reinstated")
    elif {"start", "end"} & roles_changed:
        categories.append("effective")
    if "message" in roles_changed:
        categories.append("message")
    for role in ("dtype", "line_item", "etype", "field"):
        if role in roles_changed and "definition" not in categories and not (role == "etype" and "severity" in categories):
            categories.append("definition")
    if "description" in roles_changed and "logic" not in categories:
        categories.append("description")
    if not categories:
        categories.append("metadata" if substantive else ("cosmetic" if all(c["kind"] == "cosmetic" for c in columns) else "systematic"))
    ordered = sorted(set(categories), key=lambda name: CATEGORIES.index(name) if name in CATEGORIES else len(CATEGORIES))
    if ordered[0] == "systematic":
        return {"systematic_only": True}
    effective, quarter = _effective(table, new)
    change = {"category": ordered[0], "also": ordered[1:], "label": _label(table, new), "columns": columns}
    if severity:
        change["severity"] = severity
    if effective:
        change["effective"] = effective
    if quarter:
        change["quarter"] = quarter
    return change


def _diff_tables(before: Table, after: Table) -> dict:
    key_roles = _choose_key(before, after)
    old_side, new_side = _side(before, key_roles), _side(after, key_roles)
    shared = [key for key in new_side.order if key in old_side.keyed]
    # Systematic edits: the same small token swap in one column across many rows.
    signatures: Counter = Counter()
    for key in shared:
        old, new = old_side.keyed[key], new_side.keyed[key]
        for column, index in new_side.columns.items():
            if column in old_side.columns:
                before_value = old[old_side.columns[column]] if old_side.columns[column] < len(old) else ""
                after_value = new[index] if index < len(new) else ""
                if _canon(before_value) != _canon(after_value) and _loose(before_value) != _loose(after_value):
                    signature = _word_signature(before_value, after_value)
                    if signature and _role_of(new_side, column) in {"comments", "modified", ""}:
                        signatures[(column, signature)] += 1
    threshold = max(SYSTEMATIC_MIN_ROWS, int(len(shared) * SYSTEMATIC_SHARE))
    systematic = {item for item, count in signatures.items() if count >= threshold}
    patterns = [{"column": after.header[new_side.columns[column]], "from": " ".join(signature[0]) or "(nothing)",
                 "to": " ".join(signature[1]) or "(nothing)", "rows": signatures[(column, signature)]}
                for column, signature in sorted(systematic, key=lambda item: -signatures[item])]

    changes: list[dict] = []
    reconciliation = {"changed_not_declared": [], "declared_not_changed": []}
    declared_counts: Counter = Counter()
    old_ids = defaultdict(list)
    new_ids = defaultdict(list)
    if after.kind == "rules":
        for key, row in old_side.keyed.items():
            old_ids[_canon(_cell(before, row, "id")).upper()].append(row)
        for key, row in new_side.keyed.items():
            new_ids[_canon(_cell(after, row, "id")).upper()].append(row)

    def declared_of(table: Table, row: list[str]) -> tuple[str, str]:
        for role in ("status", "comments"):
            value = _cell(table, row, role)
            action = _declared(value)
            if action:
                return action, _short(value, 120)
        return "", ""

    for key in new_side.order:
        new = new_side.keyed[key]
        action, declared_text = declared_of(after, new)
        old = old_side.keyed.get(key)
        if old is None:
            category = "added"
            note = ""
            if after.kind == "rules":
                identifier = _canon(_cell(after, new, "id")).upper()
                earlier = [row for row in old_ids.get(identifier, []) if row is not None]
                if earlier and ("version" in after.roles):
                    category = "added_version"
                    note = "Earlier: " + ", ".join(
                        _label(before, row) + (f" (ends {_day_text(_cell(before, row, 'end'))})" if not _is_open(_cell(before, row, "end")) else "")
                        for row in earlier[:4])
            effective, quarter = _effective(after, new)
            change = {"category": category, "also": [], "label": _label(after, new), "values": _values(after, new)}
            if note:
                change["note"] = note
            if effective:
                change["effective"] = effective
            if quarter:
                change["quarter"] = quarter
            if action == "unchanged":
                change["mismatch"] = f"New in this version but marked “{declared_text}”"
                reconciliation["changed_not_declared"].append(change["label"])
            if _is_retired(after, new):
                change["also"].append("retired")
        else:
            change = _classify_pair(old_side, new_side, old, new, systematic)
            old_action, old_declared = declared_of(before, old)
            newly_declared = action and (declared_text != old_declared)
            if change and change.get("systematic_only"):
                change = None
            if change is None:
                if newly_declared and action in {"new", "updated"}:
                    reconciliation["declared_not_changed"].append(_label(after, new))
                    change = {"category": "metadata", "also": [], "label": _label(after, new), "columns": [],
                              "mismatch": f"Marked “{declared_text}” but nothing else in the row changed"}
                    effective, quarter = _effective(after, new)
                    if effective:
                        change["effective"] = effective
                else:
                    continue
            elif change["category"] in {"logic", "severity", "message", "definition", "description", "effective"} and action == "unchanged":
                change["mismatch"] = f"Changed but marked “{declared_text}”"
                reconciliation["changed_not_declared"].append(change["label"])
            elif change["category"] in {"metadata", "cosmetic"} and newly_declared and action in {"new", "updated"}:
                change["mismatch"] = f"Marked “{declared_text}” but only {change['category']} changes were found"
                reconciliation["declared_not_changed"].append(change["label"])
            if change["category"] == "retired" and after.kind == "rules":
                identifier = _canon(_cell(after, new, "id")).upper()
                live = [row for row in new_ids.get(identifier, []) if row is not new and not _is_retired(after, row)]
                change["note"] = ("Superseded by " + ", ".join(_label(after, row) for row in live[:3])) if live else \
                    "No live replacement version in this file - the rule is being dropped"
        if declared_text and action in {"new", "updated", "retired"} and (old is None or declared_text != declared_of(before, old)[1]):
            declared_counts[action] += 1
        change["key"] = key
        if declared_text:
            change["declared"] = declared_text
        if _cell(after, new, "table"):
            change["table"] = _short(_cell(after, new, "table"), 120)
        if after.kind == "rules" and _cell(after, new, "field"):
            change["field"] = _short(_cell(after, new, "field"), 120)
        changes.append(change)

    for key in old_side.order:
        if key in new_side.keyed:
            continue
        old = old_side.keyed[key]
        change = {"category": "removed", "also": [], "label": _label(before, old), "values": _values(before, old), "key": key}
        if after.kind == "rules":
            identifier = _canon(_cell(before, old, "id")).upper()
            live = [row for row in new_ids.get(identifier, [])]
            if live:
                change["note"] = "Still present as " + ", ".join(_label(after, row) for row in live[:3])
        value = _cell(before, old, "table")
        if value:
            change["table"] = _short(value, 120)
        changes.append(change)

    _mark_rekeyed(changes)
    changes.sort(key=lambda item: (CATEGORIES.index(item["category"]) if item["category"] in CATEGORIES else 99))
    counts = Counter(change["category"] for change in changes)
    escalated = sum(1 for change in changes if (change.get("severity") or {}).get("direction") == "escalated")
    old_columns, new_columns = set(old_side.columns), set(new_side.columns)
    result = {
        "doc": after.doc, "sheet": after.sheet, "name": after.name, "kind": after.kind,
        "key": [after.header[after.roles[role]] for role in key_roles if role in after.roles],
        "rows_before": len(old_side.keyed), "rows_after": len(new_side.keyed),
        "counts": dict(counts),
        "columns_added": [after.header[new_side.columns[name]] for name in new_side.columns if name not in old_columns][:40],
        "columns_removed": [before.header[old_side.columns[name]] for name in old_side.columns if name not in new_columns][:40],
        "patterns": patterns[:10],
        "changes": changes[:MAX_CHANGES_PER_TABLE],
    }
    if escalated:
        result["escalated"] = escalated
    if declared_counts:
        result["declared"] = dict(declared_counts)
    if reconciliation["changed_not_declared"] or reconciliation["declared_not_changed"]:
        result["reconciliation"] = {key: value[:50] for key, value in reconciliation.items()} | {
            "changed_not_declared_count": len(reconciliation["changed_not_declared"]),
            "declared_not_changed_count": len(reconciliation["declared_not_changed"])}
    if len(changes) > MAX_CHANGES_PER_TABLE:
        result["truncated"] = True
    warnings = []
    if old_side.duplicates or new_side.duplicates:
        warnings.append(f"The key ({', '.join(result['key'])}) is not unique; repeated rows are compared in order")
    if warnings:
        result["warnings"] = warnings
    return result


IDENTITY_ROLES = {"id", "version", "field", "line_item"}


def _mark_rekeyed(changes: list[dict]) -> None:
    """An added and a removed row that agree on everything but their key: the same record under a new key."""
    def signature(change: dict) -> tuple:
        values = change.get("values") or {}
        return tuple(sorted((role, _loose(value)) for role, value in values.items() if role not in IDENTITY_ROLES and _loose(value)))

    added: dict[tuple, list[dict]] = defaultdict(list)
    for change in changes:
        if change["category"] in {"added", "added_version"} and signature(change):
            added[signature(change)].append(change)
    for change in changes:
        if change["category"] != "removed":
            continue
        matches = added.get(signature(change)) or []
        if signature(change) and len(matches) == 1 and len(signature(change)) >= 2:
            twin = matches[0]
            change["note"] = f"Likely re-keyed as {twin['label']}"
            twin["note"] = (twin.get("note", "") + "; " if twin.get("note") else "") + f"Likely re-keyed from {change['label']}"
            change["rekeyed"] = twin["label"]
            twin["rekeyed_from"] = change["label"]


def _whole_table(table: Table, category: str) -> dict:
    side = _side(table, KEY_PLANS.get(table.kind, [["field"]])[0] if table.kind != "rules" else ["id"])
    return {"doc": table.doc, "sheet": table.sheet, "name": table.name, "kind": table.kind, "key": [],
            "rows_before": len(side.keyed) if category == "removed" else 0, "rows_after": len(side.keyed) if category == "added" else 0,
            "counts": {category: len(side.keyed)}, "table_" + category: True, "changes": [], "columns_added": [], "columns_removed": [],
            "patterns": []}


# --------------------------------------------------------------------------- public API


def diff(before_text: str | None, after_text: str | None) -> dict | None:
    """Structured changes between two saved texts, or None when neither holds a spec table."""
    before_tables, after_tables = tables_from_text(before_text), tables_from_text(after_text)
    if not before_tables and not after_tables:
        return None
    if not before_tables or not after_tables:
        # One side has no recognisable structure (an extraction failure, a new
        # format): row-level comparison would only report everything as new.
        return None
    tables = []
    total = 0
    for old, new in _match_tables(before_tables, after_tables):
        if old is not None and new is not None:
            result = _diff_tables(old, new)
            if not result["changes"] and not result["columns_added"] and not result["columns_removed"] and not result["patterns"]:
                continue
        elif new is not None:
            result = _whole_table(new, "added")
        else:
            result = _whole_table(old, "removed")
        if total >= MAX_TOTAL_CHANGES:
            result["changes"] = []
            result["truncated"] = True
        total += len(result["changes"])
        tables.append(result)
        if len(tables) >= MAX_TABLES:
            break
    if not tables:
        return None
    counts: Counter = Counter()
    for table in tables:
        if table.get("table_added") or table.get("table_removed"):
            continue
        counts.update(table["counts"])
    out = {"version": VERSION, "counts": dict(counts), "tables": tables,
           "escalated": sum(table.get("escalated", 0) for table in tables),
           "mismatches": sum(table.get("reconciliation", {}).get("changed_not_declared_count", 0)
                             + table.get("reconciliation", {}).get("declared_not_changed_count", 0) for table in tables)}
    out["headline"] = headline(out)
    return out


def inventory(text: str | None) -> dict | None:
    """What a file declares about itself (rows marked new, updated, retired) — for a file seen for the first time."""
    tables = tables_from_text(text)
    if not tables:
        return None
    out_tables = []
    totals: Counter = Counter()
    for table in tables[:MAX_TABLES]:
        declared: Counter = Counter()
        items: list[dict] = []
        for row in table.rows:
            label = _label(table, row)
            if not label:
                continue
            action, text_value = "", ""
            for role in ("status", "comments"):
                action = _declared(_cell(table, row, role))
                if action:
                    text_value = _cell(table, row, role)
                    break
            if action in {"new", "updated", "retired"}:
                declared[action] += 1
                if len(items) < 120:
                    effective, quarter = _effective(table, row)
                    item = {"label": label, "declared": _short(text_value, 120), "action": action}
                    if effective:
                        item["effective"] = effective
                    items.append(item)
        totals.update(declared)
        out_tables.append({"name": table.name, "kind": table.kind, "rows": len(table.rows), "declared": dict(declared), "items": items})
    return {"version": VERSION, "tables": out_tables, "declared": dict(totals)}


def inventory_summary(result: dict | None) -> dict | None:
    """Event-sized summary of what a newly seen file declares (rows marked new, updated, retired)."""
    if not result or not result.get("declared"):
        return None
    declared = result["declared"]
    labels = [item["label"] for table in result.get("tables", []) for item in table.get("items", [])][:8]
    words = {"new": "marked new", "updated": "marked updated", "retired": "marked retired"}
    text = ", ".join(f"{declared[key]} {words[key]}" for key in ("new", "updated", "retired") if declared.get(key))
    return {"declared": dict(declared), "labels": labels, "headline": "Declared in this file: " + text, "counts": {}}


def _plural(count: int, noun: tuple[str, str]) -> str:
    return f"{count} {noun[0] if count == 1 else noun[1]}"


def headline(result: dict | None) -> str:
    """One sentence for alerts and the top of the dashboard sheet."""
    if not result:
        return ""
    parts = []
    for table in result.get("tables", []):
        noun = NOUNS.get(table.get("kind"), ("row", "rows"))
        if table.get("table_added"):
            parts.append(f"{table['name']}: new table ({_plural(table['rows_after'], noun)})")
            continue
        if table.get("table_removed"):
            parts.append(f"{table['name']}: table removed ({_plural(table['rows_before'], noun)})")
            continue
        labels = CATEGORY_LABELS.get(table.get("kind"), CATEGORY_LABELS["fields"])
        bits = []
        for category in CATEGORIES:
            count = table["counts"].get(category)
            if not count or category in {"cosmetic", "metadata"}:
                continue
            examples = [change["label"] for change in table["changes"] if change["category"] == category][:3]
            text = f"{labels.get(category, category).lower()} {count}"
            if examples:
                text += " (" + ", ".join(examples) + (", …" if count > len(examples) else "") + ")"
            bits.append(text)
        if table.get("escalated"):
            bits.append(f"{table['escalated']} escalated")
        if table.get("patterns"):
            pattern = table["patterns"][0]
            bits.append(f"{pattern['column']}: “{pattern['from']}” → “{pattern['to']}” in {pattern['rows']} rows")
        if bits:
            parts.append(f"{table['name']}: " + "; ".join(bits))
    if result.get("mismatches"):
        parts.append(f"{result['mismatches']} declared/detected mismatch{'es' if result['mismatches'] != 1 else ''}")
    text = ". ".join(parts)
    return text if len(text) <= 600 else text[:599] + "…"


def summary(result: dict | None, sample: int = 8) -> dict | None:
    """The small part kept on the event and in the page's change timeline."""
    if not result or not result.get("tables"):
        return None
    labels: list[str] = []
    fields_seen: list[str] = []
    for table in result["tables"]:
        for change in table.get("changes", []):
            if change["category"] in {"cosmetic", "metadata"}:
                continue
            if len(labels) < sample:
                labels.append(change["label"])
            code = change.get("field") or (change["label"] if table.get("kind") in {"fields", "concepts"} else "")
            if code and code not in fields_seen and len(fields_seen) < 60:
                fields_seen.append(code)
    return {"counts": dict(result.get("counts", {})), "tables": len(result["tables"]), "headline": _short(result.get("headline", ""), 300),
            "labels": labels, "fields": fields_seen, "escalated": result.get("escalated", 0), "mismatches": result.get("mismatches", 0)}


def describe(result_or_summary: dict | None) -> str:
    """"Spec: 2 new, 1 retired, 1 severity escalated" for alerts; "" when nothing substantive changed."""
    if not result_or_summary:
        return ""
    if result_or_summary.get("declared") and not result_or_summary.get("counts"):
        return result_or_summary.get("headline", "")
    counts = result_or_summary.get("counts") or {}
    names = {"added": "new", "added_version": "new versions", "severity": "severity changed", "logic": "logic changed",
             "retired": "retired", "reinstated": "reinstated", "effective": "dates changed", "message": "message changed",
             "definition": "redefined", "description": "description changed", "removed": "removed"}
    parts = [f"{counts[key]} {'new version' if key == 'added_version' and counts[key] == 1 else label}"
             for key, label in names.items() if counts.get(key)]
    if not parts:
        return ""
    labels = result_or_summary.get("labels") or []
    shown = ", ".join(labels[:4]) + (", …" if len(labels) > 4 else "")
    text = ", ".join(parts)
    if result_or_summary.get("escalated"):
        text += f" ({result_or_summary['escalated']} escalated)"
    return text + (f" — {shown}" if shown else "")


# --------------------------------------------------------------------------- offline compare (CLI)


def _read_file(path: Path) -> str:
    from regmon.content import extract_content

    text, _kind, error = extract_content(path.name, "", path.read_bytes())
    if error or text is None:
        raise ValueError(f"Could not read {path.name}: {error or 'no text extracted'}")
    return text


def compare_files(previous: Path, current: Path) -> dict:
    """Compare two local files exactly as a monitored change would be compared."""
    before, after = _read_file(previous), _read_file(current)
    result = diff(before, after)
    files = []
    for label, path in (("previous", previous), ("current", current)):
        body = path.read_bytes()
        files.append({"role": label, "name": path.name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    return {"files": files, "result": result, "found": {"previous": len(tables_from_text(before)), "current": len(tables_from_text(after))}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m regmon.spec_diff",
        description="Compare two versions of an edit-check workbook, data dictionary, PDF field spec, XSD or XBRL linkbase.")
    parser.add_argument("previous", type=Path)
    parser.add_argument("current", type=Path)
    parser.add_argument("-o", "--output", type=Path, help="Write an analyst workbook (.xlsx) with Impact and Comment columns")
    parser.add_argument("--json", type=Path, help="Write the full result as JSON")
    parser.add_argument("--exit-code", action="store_true", help="Exit 2 when substantive changes are found")
    args = parser.parse_args(argv)
    outcome = compare_files(args.previous, args.current)
    result = outcome["result"]
    print(f"{args.previous.name} → {args.current.name}")
    print(f"Tables recognised: {outcome['found']['previous']} before, {outcome['found']['current']} after")
    if not result:
        print("No rule, field or schema table changed.")
    else:
        print(result["headline"])
        for table in result["tables"]:
            print(f"  {table['name']} [{table['kind']}] key={', '.join(table['key']) or '-'} "
                  f"rows {table['rows_before']}→{table['rows_after']} " + ", ".join(f"{k}={v}" for k, v in table["counts"].items()))
    if args.json:
        args.json.write_text(json.dumps(outcome, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"JSON: {args.json}")
    if args.output:
        from regmon.spec_report import write_workbook

        written = write_workbook(outcome, args.output)
        print(f"Workbook: {written}")
    substantive = bool(result) and any(k not in {"cosmetic", "metadata"} for k in result.get("counts", {}))
    return 2 if args.exit_code and substantive else 0


if __name__ == "__main__":
    sys.exit(main())
