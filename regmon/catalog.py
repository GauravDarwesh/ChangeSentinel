"""Item catalog: what regulators say each reporting item is, version by version.

The registry (config/registry.json) is the reporting team's side: the items it
reports and what reads them. This is the regulator's side, built from what the
monitors already save, with no model involved:

* field tables of dictionaries and instructions (the MDRM data dictionary,
  FR Y-14 data dictionaries, instruction tables): name, definition, data type,
  schedule, line and the dates the item applies;
* edit checks, from PDF rule tables (data/rule-tables/, the FR Y-9C edit
  checklist) and from edit workbooks and taxonomy edits: the edits that check
  the item (its target column, e.g. "MDRM Number"), how many edits read it in
  their formula (``read_by``, exact) and a sample (``read_by_sample``, the
  first 10 alphabetically), with schedule, line and start date. Rows that
  ended before the document's newest period are history and are left out;
* XBRL schemas (the Call Report taxonomy's concepts.xsd): the concept's type,
  period type and balance.

Each source document contributes a *facet* of an item, and each facet keeps
its *versions*: a new version is recorded only when what the document says
changes, with the scan time it was first seen and the edition it came from.

Editions. Regulators publish each period under a new name (FFIEC031_202609 →
FFIEC031_202612, a new Fed guid taking over "Current", OSFI's dated BCAR files,
the dated members of a CDR taxonomy ZIP). A facet follows the document across
editions: its identity is the edition chain's first address (data/successions.json
and the ``superseded_by`` of retired records) plus the member file's name with
dates and version numbers removed. So a new edition that says the same thing
about an item adds nothing, and one that moves it to another line adds one
version whose ``changed`` names the line. While its successor is readable, an
old edition is not read; an item it dropped gets an ``absent`` version, and a
document that leaves the inventory without a successor marks its items absent.

Status (review §6A): a version from a document that is a proposal, draft or
redline is ``proposed``; otherwise ``final``. A version followed by a newer one
of the same facet is superseded (``history()`` marks it). Dates (review §6B):
a facet carries the regulator's own start and end dates where the source has
them; an edition carries a taxonomy's report date from its file name.

Parser drift. The fingerprint includes ``CATALOG_VERSION``; a document whose
bytes did not change but is read again (a parser or catalog change) updates
the facts of its newest version in place, marked ``reread``, instead of
adding history the regulator never wrote.

Files (one per series, the four-letter MDRM mnemonic):

    data/items/index.json  {"schema_version", "catalog_version", "updated_at", "series": {"BHCK": n},
                            "sources": {url_id: {"fingerprint", "raw", "url", "source_id", "line"}},
                            "lines": {line: {"url_id", "codes": {facet id: [codes]}, "gone"?}}}
    data/items/BHCK.json   {"schema_version", "series",
                            "facets": {"<id>": {"kind", "line", "document", "current",
                                                "editions": {"<eid>": {"url", "document", "source_id", "first_read",
                                                                       "report_date"?, "status"?}}}},
                            "items": {"BHCK2170": {"<facet id>": [{"at", "attrs", "src", "status"?, "reread"?}
                                                                  | {"at", "absent": true, "src"}]}}}

Items are written one per line, so a change rewrites only its own lines in
git. ``status`` is left out when it is ``final``.

    python -m regmon.catalog show BHCK2170     # the item's timeline
    python -m regmon.catalog build [--force]   # bring it up to date (--force: read every document again)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import spec_diff
from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DIRECTORY = "items"
SCHEMA_VERSION = 2
# Bump when what the catalog reads from a document changes: documents are then
# read again, and unchanged bytes update their newest versions in place.
CATALOG_VERSION = "catalog-3"  # 3: edit checks carry the form (series) they belong to
# Four letters, then an item number of four letters or digits with at least one digit
# (2170, C447, PV23): "EXISTING" in a formula is a word, not a code.
MDRM = re.compile(r"^[A-Z]{4}(?=[A-Z]*\d)[A-Z0-9]{4}$")
# A code inside a formula or rule logic: "cc:RCON2170[P0]", "bhck2170", "BHCK 2170".
CODE_IN_LOGIC = re.compile(r"(?<![A-Za-z0-9])(?:cc:)?([A-Za-z]{4})(\s?)([A-Za-z0-9]{4})(?![A-Za-z0-9])")
# Words that precede a number or a column name in edit text ("less THAN 1000",
# "THEN C10A", "June 2026"); never an MDRM mnemonic.
NOT_SERIES = frozenset("""THEN ELSE THAN WHEN FROM WITH MUST LESS MORE EACH INTO ONLY ALSO BOTH SAME
    JUNE JULY YEAR DATE ITEM LINE PART PAGE NULL TRUE NONE OVER SUCH THAT THIS WERE BEEN HAVE
    SHALL""".split())
# In an edit table, the column with the formula rather than the prose test.
ALGEBRA_HEADER = re.compile(r"boolean|algebra|formula|expression|xpath|assertion test", re.I)
NOT_FORMULA_HEADER = re.compile(r"type|category|class|name|number|\bid\b", re.I)
SERIES_FILE = re.compile(r"^[A-Z]{4}\.json$")
MAX_TEXT = 600
MAX_EDITS = 10
# Citations, not facts: a page shift alone is not a new version.
CITATION_ATTRS = frozenset({"pages"})
PROPOSED = re.compile(r"propos|draft|redline|consultation|for comment|federal ?register notice|\bfrn\b", re.I)
REPORT_DATE = re.compile(r"(?<!\d)(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)")
# A period in a file name (2026-09-30, 20260930, 202609, 2026_09, 2026Q3), never a bare year:
# FR 2052a and the 2027 BCAR package keep their numbers.
NAME_PERIOD = re.compile(r"(?<![0-9])(?:19|20)\d\d(?:[-_.]?(?:0[1-9]|1[0-2])(?:[-_.]?(?:0[1-9]|[12]\d|3[01]))?|[-_.]?q[1-4])(?![0-9])", re.I)
NAME_VERSION = re.compile(r"(?<![a-z0-9])v\d+(?:[._]\d+)*(?![a-z0-9])", re.I)
DICTIONARY_ATTRS = ("name", "description", "dtype", "table", "line_item", "series", "start", "end")
ATTR_NAMES = {"description": "definition", "table": "schedule", "line_item": "line", "series": "form"}


def _clean(value: object, limit: int = MAX_TEXT) -> str:
    return " ".join(str(value or "").split())[:limit]


def _code(value: object) -> str:
    code = re.sub(r"\s+", "", str(value or "")).upper()
    return code if MDRM.match(code) and code[:4] not in NOT_SERIES else ""


def status_of(url: str, document: str = "", title: str = "") -> str:
    """'proposed' for a proposal, draft or redline document, else 'final'."""
    return "proposed" if PROPOSED.search(" ".join((url or "", document or "", title or ""))) else "final"


def report_date(document: str) -> str:
    """A taxonomy's report date from its file name (call-report031-2026-09-30-v301.xsd -> 2026-09-30)."""
    match = REPORT_DATE.search(document or "")
    return "-".join(match.groups()) if match else ""


def document_key(document: str) -> str:
    """A member file's name without its period and version, so editions share it.

    call-report031-2026-09-30-v301-ec.xml -> call-report031-ec.xml
    FFIEC031_202609_f.pdf -> ffiec031_f.pdf
    """
    name = NAME_VERSION.sub("", NAME_PERIOD.sub("", (document or "").lower()))
    name = re.sub(r"[-_. ]+\.(?=[a-z0-9]+$)", ".", name)
    name = re.sub(r"([-_. ])[-_. ]+", r"\1", name)
    return name.strip("-_. ")


_DATE_FORMATS = ("%Y%m%d", "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S", "%d/%m/%Y")
OPEN_END = "9999-12-31"


def iso_date(value: object) -> str:
    """A regulator date as YYYY-MM-DD (20150331, 6/30/1981 12:00:00 AM, 2026-09-30); '' when it reads as none."""
    text = " ".join(str(value or "").split())
    if not text:
        return ""
    for pattern in _DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            continue
    return ""


def quarter(day: str) -> str:
    """'2027-03-31' -> '2027Q1'; '' for an open end (9999-12-31) or no date."""
    if not day or day >= OPEN_END:
        return ""
    return f"{day[:4]}Q{(int(day[5:7]) - 1) // 3 + 1}"


def _dated(attrs: dict) -> dict:
    """start/end as ISO dates where they read as dates (the original text is kept when not)."""
    for name in ("start", "end"):
        if attrs.get(name) and iso_date(attrs[name]):
            attrs[name] = iso_date(attrs[name])
    return attrs


FORM_IN_NAME = (
    (re.compile(r"(?<![a-z0-9])call-?report[-_]?(\d{3})(?!\d)", re.I), "FFIEC {}"),
    (re.compile(r"(?<![a-z0-9])ffiec[-_ ]?(\d{3}[a-z]?)(?![a-z0-9])", re.I), "FFIEC {}"),
    (re.compile(r"(?<![a-z0-9])fr[-_ ]?(y-?\d+[a-z]?)(?![a-z0-9])", re.I), "FR {}"),
)


def form_name(value: object) -> str:
    """A report's name as forms are written elsewhere: 'FFIEC102' -> 'FFIEC 102', 'FR Y-9C' stays."""
    from .proposals import normalize_form
    text = " ".join(str(value or "").split())
    if not text or len(text) > 24:
        return ""
    form = normalize_form(text)
    return form if re.match(r"^(FFIEC|FR) ", form) else ""


def forms_in_name(name: str) -> set[str]:
    """Forms a file name or address names: call-report031-… -> FFIEC 031; FFIEC102_… -> FFIEC 102."""
    found = set()
    for pattern, template in FORM_IN_NAME:
        for match in pattern.finditer(name or ""):
            found.add(form_name(template.format(match.group(1))))
    return {form for form in found if form}


def _cell(table, row: list[str], role: str, limit: int | None = MAX_TEXT) -> str:
    index = table.roles.get(role)
    if index is None or index >= len(row):
        return ""
    return " ".join(str(row[index] or "").split()) if limit is None else _clean(row[index], limit)


def _codes_in_logic(text: str) -> set[str]:
    """MDRM codes a formula reads. A spaced code ("BHCK 2170") must be written in capitals."""
    codes = set()
    for letters, space, number in CODE_IN_LOGIC.findall(text or ""):
        if space and not letters.isupper():
            continue
        code = (letters + number).upper()
        if MDRM.match(code) and code[:4] not in NOT_SERIES:
            codes.add(code)
    return codes


def _algebra_index(table) -> int | None:
    """The formula column of an edit table: a Boolean Algebra / formula header, else the logic role."""
    for index, name in enumerate(table.header):
        if ALGEBRA_HEADER.search(str(name or "")) and not NOT_FORMULA_HEADER.search(str(name or "")):
            return index
    return table.roles.get("logic")


def _current(rows: list[dict]) -> list[dict]:
    """Rows still in force: those that did not end before the document's newest start date."""
    starts = [iso_date(row.get("start")) for row in rows]
    newest = max((start for start in starts if start), default="")
    if not newest:
        return rows
    return [row for row in rows if not iso_date(row.get("end")) or iso_date(row.get("end")) >= newest]


def edit_facts(rows: list[dict]) -> dict[str, dict]:
    """{code: attrs} from edit rows ``{etype, id, field, table, line_item, start, end, reads, page?}``."""
    targets: dict[str, set] = defaultdict(set)
    read_by: dict[str, set] = defaultdict(set)
    places: dict[str, Counter] = defaultdict(Counter)
    starts: dict[str, set] = defaultdict(set)
    pages: dict[str, set] = defaultdict(set)
    series: dict[str, Counter] = defaultdict(Counter)
    for row in _current([row for row in rows if isinstance(row, dict)]):
        edit = " ".join(part for part in (str(row.get("etype") or ""), str(row.get("id") or "")) if part)
        code = _code(row.get("field"))
        if code:
            targets[code].add(edit)
            places[code][(str(row.get("table") or ""), str(row.get("line_item") or ""))] += 1
            if row.get("start"):
                starts[code].add(iso_date(row["start"]) or str(row["start"]))
            if isinstance(row.get("page"), int) and not isinstance(row.get("page"), bool):
                pages[code].add(row["page"])
            if form_name(row.get("series")):
                series[code][form_name(row.get("series"))] += 1
        for other in row.get("reads") or []:
            other = _code(other)
            if other and other != code:
                read_by[other].add(edit)
    facts: dict[str, dict] = {}
    for code in set(targets) | set(read_by):
        attrs: dict = {}
        if series.get(code):
            attrs["form"] = series[code].most_common(1)[0][0]
        if places.get(code):
            schedule, line = places[code].most_common(1)[0][0]
            attrs.update({key: value for key, value in (("schedule", schedule), ("line", line)) if value})
        if targets.get(code):
            attrs["checked_by"] = sorted(targets[code])[:MAX_EDITS]
            if starts.get(code):
                attrs["start"] = sorted(starts[code])[0]
            if pages.get(code):
                attrs["pages"] = sorted(pages[code])[:MAX_EDITS]  # PDF pages of its checks, for the citation
        if read_by.get(code):
            attrs["read_by"] = str(len(read_by[code]))
            attrs["read_by_sample"] = sorted(read_by[code])[:MAX_EDITS]
        facts[code] = attrs
    return facts


def facts_from_text(text: str) -> dict[tuple[str, str], dict[str, dict]]:
    """{(document, kind): {code: attrs}} from a saved document's normalized text."""
    out: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    edits: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for table in spec_diff.tables_from_text(text):
        document = table.doc or ""
        if table.kind == "fields" and "field" in table.roles:
            facts = out[(document, "dictionary")]
            for row in table.rows:
                code = _code(_cell(table, row, "field"))
                if not code:
                    continue
                attrs = {ATTR_NAMES.get(role, role): _cell(table, row, role) for role in DICTIONARY_ATTRS if role in table.roles}
                attrs = _dated({key: value for key, value in attrs.items() if value})
                previous = facts.get(code)
                # A code listed once per period (MDRM): keep the open-ended or latest row.
                if previous is None or (attrs.get("end", "") or OPEN_END) >= (previous.get("end", "") or OPEN_END):
                    if previous is not None:
                        attrs["periods"] = str(int(previous.get("periods", "1")) + 1)
                    facts[code] = attrs
                else:
                    previous["periods"] = str(int(previous.get("periods", "1")) + 1)
        elif table.kind == "concepts" and "field" in table.roles:
            facts = out[(document, "schema")]
            header = [name.lower() for name in table.header]
            for row in table.rows:
                code = _code(_cell(table, row, "field").split(":")[-1])
                if not code:
                    continue
                attrs = {"type": _cell(table, row, "dtype")}
                for column, name in (("period type", "period_type"), ("balance", "balance")):
                    if column in header and header.index(column) < len(row) and row[header.index(column)]:
                        attrs[name] = _clean(row[header.index(column)])
                facts[code] = {key: value for key, value in attrs.items() if value}
        elif table.kind == "rules" and ("logic" in table.roles or "field" in table.roles):
            logic = _algebra_index(table)
            for row in table.rows:
                formula = " ".join(str(row[logic] or "").split()) if logic is not None and logic < len(row) else ""
                edits[(document, "edits")].append({
                    "series": _cell(table, row, "series"), "etype": _cell(table, row, "etype"), "id": _cell(table, row, "id"), "field": _cell(table, row, "field"),
                    "table": _cell(table, row, "table"), "line_item": _cell(table, row, "line_item"),
                    "start": _cell(table, row, "start"), "end": _cell(table, row, "end"),
                    "reads": sorted(_codes_in_logic(formula))})
    for key, rows in edits.items():
        out[key].update(edit_facts(rows))
    return {key: value for key, value in out.items() if value}


def facts_from_rule_tables(payload: dict) -> dict[str, dict]:
    """{code: attrs} from a data/rule-tables/ file (PDF edit checklists)."""
    return edit_facts([row for row in payload.get("rows") or [] if isinstance(row, dict)])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _directory(data_dir: Path) -> Path:
    return data_dir / DIRECTORY


def _empty_index() -> dict:
    return {"schema_version": SCHEMA_VERSION, "catalog_version": CATALOG_VERSION, "updated_at": None,
            "series": {}, "sources": {}, "lines": {}}


def load_index(data_dir: Path) -> dict:
    path = _directory(data_dir) / "index.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION:
            for key in ("sources", "lines", "series"):
                payload.setdefault(key, {})
            return payload
    except (OSError, ValueError):
        pass
    return _empty_index()


def facet_id(line: str, document: str, kind: str) -> str:
    """A short, stable id for one document's facet, shared by its editions."""
    return hashlib.sha256(f"{line}|{document_key(document)}|{kind}".encode("utf-8")).hexdigest()[:12]


def edition_id(url_id: str, document: str) -> str:
    """A short id for one edition (address and member file) of a facet."""
    return hashlib.sha256(f"{url_id}|{document}".encode("utf-8")).hexdigest()[:10]


def _line(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def dump_series(doc: dict) -> str:
    """One item per line, so a change rewrites only its own lines in git."""
    items = doc.get("items") or {}
    body = ",\n".join(f"{_line(code)}:{_line(items[code])}" for code in sorted(items))
    return ('{"schema_version":' + str(SCHEMA_VERSION) + ',"series":' + _line(doc.get("series")) +
            ',\n"facets":' + json.dumps(doc.get("facets") or {}, sort_keys=True, ensure_ascii=False, indent=1) +
            ',\n"items":{\n' + body + "\n}}\n")


def dump_index(index: dict) -> str:
    def block(name: str) -> str:
        entries = index.get(name) or {}
        return ",\n".join(f"{_line(key)}:{_line(entries[key])}" for key in sorted(entries))
    return ('{"schema_version":' + str(SCHEMA_VERSION) + ',"catalog_version":' + _line(index.get("catalog_version")) +
            ',"updated_at":' + _line(index.get("updated_at")) + ',"series":' + _line(index.get("series") or {}) +
            ',\n"sources":{\n' + block("sources") + '\n},\n"lines":{\n' + block("lines") + "\n}}\n")


def load_series(data_dir: Path, series: str) -> dict:
    path = _directory(data_dir) / f"{series}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION:
            payload.setdefault("items", {})
            payload.setdefault("facets", {})
            return payload
    except (OSError, ValueError):
        pass
    return {"schema_version": SCHEMA_VERSION, "series": series, "facets": {}, "items": {}}


def _source_facts(record: dict, root: Path) -> dict[str, dict[str, dict]] | None:
    """{facet_suffix "<document>|<kind>": {code: attrs}} for one inventory record, or None if unreadable."""
    location = record.get("snapshot_location")
    if not location:
        return None
    try:
        text = (root / location).read_text(encoding="utf-8")
    except OSError:
        return None
    facets: dict[str, dict[str, dict]] = {}
    pointer = (record.get("rule_tables") or {}).get("rule_tables_location")
    for (document, kind), facts in facts_from_text(text).items():
        if pointer and kind == "edits" and not document:
            continue  # the same checklist, read row by row from its rule-table file below
        facets[f"{document}|{kind}"] = facts
    if pointer:
        try:
            payload = json.loads((root / pointer).read_text(encoding="utf-8"))
            facts = facts_from_rule_tables(payload)
            if facts:
                facets["|checklist"] = facts
        except (OSError, ValueError):
            pass
    return facets


def _link_texts(data_dir: Path) -> dict[str, str]:
    """Each address's link text on the pages that list it (data/link-lineage.json), for its status."""
    try:
        lineage = json.loads((data_dir / "link-lineage.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    texts: dict[str, str] = {}
    for page in (lineage.get("pages") or {}).values():
        for url, entry in (page.get("links") or {}).items():
            if entry.get("text"):
                texts[url] = " ".join(filter(None, (texts.get(url), str(entry["text"]))))[:MAX_TEXT]
    return texts


def edition_chain(data_dir: Path, latest: dict) -> dict[str, str]:
    """Successor address -> predecessor address: followed successions and retired records' successors."""
    edges: dict[str, str] = {}
    try:
        recorded = json.loads((data_dir / "successions.json").read_text(encoding="utf-8")).get("successions") or []
    except (OSError, ValueError, AttributeError):
        recorded = []
    for entry in recorded:
        if isinstance(entry, dict) and entry.get("follow") and entry.get("from") and entry.get("to") and entry["from"] != entry["to"]:
            edges.setdefault(str(entry["to"]), str(entry["from"]))
    for records in (latest.get("sources") or {}).values():
        for record in (records or {}).values():
            url, successor = str(record.get("canonical_url") or ""), str(record.get("superseded_by") or "")
            if url and successor and url != successor:
                edges.setdefault(successor, url)
    return edges


def _root(url: str, edges: dict[str, str]) -> str:
    seen = {url}
    while url in edges and edges[url] not in seen:
        url = edges[url]
        seen.add(url)
    return url


def _readable(record: dict) -> bool:
    return record.get("active") is not False and bool(record.get("normalized_hash")) and bool(record.get("snapshot_location"))


def _superseded(url: str, forward: dict[str, list[str]], readable: set[str]) -> bool:
    """True when a later edition of this address can be read."""
    stack, seen = list(forward.get(url, ())), {url}
    while stack:
        nxt = stack.pop()
        if nxt in seen:
            continue
        seen.add(nxt)
        if nxt in readable:
            return True
        stack.extend(forward.get(nxt, ()))
    return False


def _bare(attrs: dict | None) -> dict:
    return {key: value for key, value in (attrs or {}).items() if key not in CITATION_ATTRS}


def update(data_dir: Path, latest: dict, *, now: str | None = None, root: Path | None = None, force: bool = False) -> dict:
    """Bring data/items/ up to date with the inventory; returns counts. Only changed documents are re-read."""
    at = now or _now()
    root = root or data_dir.parent
    directory = _directory(data_dir)
    index = load_index(data_dir)
    if index["updated_at"] is None and directory.exists():
        # A catalog of an older schema (or none): rebuild from scratch.
        for path in directory.glob("*.json"):
            path.unlink()
    index["catalog_version"] = CATALOG_VERSION
    titles = _link_texts(data_dir)
    known, lines = index["sources"], index["lines"]
    loaded: dict[str, dict] = {}
    touched_series: set[str] = set()
    counts = {"documents": 0, "versions": 0, "items": 0}

    def series_doc(series: str) -> dict:
        if series not in loaded:
            loaded[series] = load_series(data_dir, series)
        return loaded[series]

    def facet_meta(series: str, fid: str, kind: str, line: str, eid: str, edition: dict) -> None:
        facets = series_doc(series)["facets"]
        meta = facets.setdefault(fid, {"kind": kind, "line": line, "document": document_key(edition.get("document", "")), "editions": {}})
        if eid not in meta["editions"]:
            meta["editions"][eid] = {**edition, "first_read": at}
            touched_series.add(series)
        if meta.get("current") != eid:
            meta["current"] = eid
            touched_series.add(series)

    def cite(series: str, fid: str, eid: str, edition: dict, *, current: bool) -> None:
        """The edition an absent version cites, in the series file that holds it."""
        meta = series_doc(series)["facets"].get(fid)
        if meta is not None:
            meta.setdefault("editions", {}).setdefault(eid, {**edition, "first_read": at})
            if current:
                meta["current"] = eid

    def mark_absent(code: str, fid: str, eid: str, *, reread: bool = False) -> None:
        versions = (series_doc(code[:4])["items"].get(code) or {}).get(fid)
        if versions and not versions[-1].get("absent"):
            versions.append({"at": at, "absent": True, "src": eid, **({"reread": at} if reread else {})})
            touched_series.add(code[:4])
            counts["versions"] += 1

    edges = edition_chain(data_dir, latest)
    forward: dict[str, list[str]] = defaultdict(list)
    for successor, predecessor in edges.items():
        forward[predecessor].append(successor)
    records = [(source_id, url_id, record) for source_id, by_id in sorted((latest.get("sources") or {}).items())
               for url_id, record in sorted((by_id or {}).items()) if isinstance(record, dict)]
    readable = {str(record.get("canonical_url") or "") for _sid, _uid, record in records if _readable(record)}

    for source_id, url_id, record in records:
        url = str(record.get("canonical_url") or "")
        if not _readable(record) or _superseded(url, forward, readable):
            continue
        line = _root(url, edges)
        fingerprint = "|".join((CATALOG_VERSION, str(record.get("normalized_hash")),
                                str((record.get("rule_tables") or {}).get("rule_tables_location") or "")))
        previous = known.get(url_id) or {}
        state = lines.get(line) or {}
        if not force and previous.get("fingerprint") == fingerprint and state.get("url_id") == url_id and not state.get("gone"):
            continue
        facets = _source_facts(record, root)
        if facets is None:
            continue
        counts["documents"] += 1
        raw = str(record.get("raw_hash") or "")
        # The same bytes read again (a parser or catalog change): fix the facts, add no history.
        reread = bool(raw) and state.get("url_id") == url_id and previous.get("raw") == raw and not state.get("gone")
        seen: dict[str, set] = defaultdict(set)
        editions: dict[str, tuple[str, dict]] = {}
        for suffix, facts in facets.items():
            document, kind = suffix.split("|", 1)
            fid = facet_id(line, document, kind)
            status = status_of(url, document, titles.get(url, ""))
            eid = edition_id(url_id, document)
            edition = {"url": url, "document": document, "source_id": source_id,
                       **({"report_date": report_date(document)} if report_date(document) else {}),
                       **({"status": status} if status != "final" else {})}
            editions[fid] = (eid, edition)
            for code, attrs in facts.items():
                seen[fid].add(code)
                facet_meta(code[:4], fid, kind, line, eid, edition)
                versions = series_doc(code[:4])["items"].setdefault(code, {}).setdefault(fid, [])
                last = versions[-1] if versions else None
                live = last is not None and not last.get("absent")
                if reread and live:
                    if last.get("attrs") != attrs:
                        last["attrs"], last["reread"] = attrs, at
                        touched_series.add(code[:4])
                    continue
                if live and _bare(last.get("attrs")) == _bare(attrs) and last.get("status", "final") == status:
                    continue
                versions.append({"at": at, "attrs": attrs, "src": eid,
                                 **({"status": status} if status != "final" else {}), **({"reread": at} if reread else {})})
                touched_series.add(code[:4])
                counts["versions"] += 1
        # Codes this document (or its previous edition) listed and no longer does.
        for fid, codes in (state.get("codes") or {}).items():
            dropped = set(codes) - seen.get(fid, set())
            if not dropped:
                continue
            eid, edition = editions.get(fid) or (edition_id(url_id, ""), {"url": url, "document": "", "source_id": source_id})
            for code in dropped:
                cite(code[:4], fid, eid, edition, current=fid in editions)
                mark_absent(code, fid, eid, reread=reread)
        known[url_id] = {"fingerprint": fingerprint, "raw": raw, "url": url, "source_id": source_id, "line": line}
        lines[line] = {"url_id": url_id, "codes": {key: sorted(codes) for key, codes in seen.items()}}

    # A document that left the inventory (or was retired) with no readable successor:
    # what it said no longer stands.
    present = {url_id for _sid, url_id, record in records if _readable(record)}
    ended = 0
    for line, state in sorted(lines.items()):
        url_id = str(state.get("url_id") or "")
        if state.get("gone") or url_id in present:
            continue
        source = known.get(url_id) or {}
        url = str(source.get("url") or "")
        if url and _superseded(url, forward, readable):
            continue
        eid = edition_id(url_id, "")
        edition = {"url": url, "document": "", "source_id": str(source.get("source_id") or ""), "gone": True}
        for fid, codes in (state.get("codes") or {}).items():
            for code in codes:
                cite(code[:4], fid, eid, edition, current=True)
                mark_absent(code, fid, eid)
        state["gone"] = at
        ended += 1

    if not touched_series and not counts["documents"] and not ended:
        return counts
    directory.mkdir(parents=True, exist_ok=True)
    for series in sorted(touched_series):
        doc = loaded[series]
        atomic_write_text(directory / f"{series}.json", dump_series(doc))
        index.setdefault("series", {})[series] = len(doc["items"])
    counts["items"] = sum(index.get("series", {}).values())
    index["updated_at"] = at
    atomic_write_text(directory / "index.json", dump_index(index))
    return counts


def _edition(facet: dict, eid: str | None) -> dict:
    return ((facet.get("editions") or {}).get(eid or "") or {}) if facet else {}


def history(data_dir: Path, code: str) -> dict | None:
    """The item's facets and a merged timeline, newest first; None when the catalog does not know it."""
    code = _code(code)
    if not code:
        return None
    return _history(load_series(data_dir, code[:4]), code)


def _history(doc: dict, code: str) -> dict | None:
    """history() for an item of an already-loaded series file."""
    item = doc["items"].get(code)
    if not item:
        return None
    timeline = []
    current = {}
    for fid, versions in sorted(item.items()):
        facet = doc["facets"].get(fid) or {}
        for number, version in enumerate(versions):
            source = _edition(facet, version.get("src"))
            entry = {"at": version.get("at"), "kind": facet.get("kind"), "url": source.get("url"), "document": source.get("document"),
                     "status": "absent" if version.get("absent") else version.get("status", "final"),
                     "superseded": number < len(versions) - 1}
            if version.get("reread"):
                entry["reread"] = version["reread"]
            if source.get("report_date"):
                entry["report_date"] = source["report_date"]
            if not version.get("absent"):
                entry["attrs"] = version.get("attrs")
                if number:
                    before = next((v.get("attrs") or {} for v in reversed(versions[:number]) if not v.get("absent")), None)
                    if before is not None:
                        after = version.get("attrs") or {}
                        entry["changed"] = sorted(name for name in set(before) | set(after)
                                                  if name not in CITATION_ATTRS and before.get(name) != after.get(name))
            timeline.append(entry)
        if versions and not versions[-1].get("absent"):
            latest = _edition(facet, facet.get("current"))
            first = _edition(facet, versions[-1].get("src"))
            current[fid] = {"kind": facet.get("kind"), "url": latest.get("url") or first.get("url"),
                            "document": latest.get("document", first.get("document")),
                            "status": versions[-1].get("status", "final"), "since": versions[-1].get("at"), "attrs": versions[-1].get("attrs"),
                            **({"report_date": latest["report_date"]} if latest.get("report_date") else {}),
                            **({"first_read_in": {"url": first.get("url"), "document": first.get("document")}}
                               if first and first.get("url") != latest.get("url") else {})}
    timeline.sort(key=lambda entry: str(entry.get("at") or ""), reverse=True)
    return {"code": code, "series": code[:4], "current": current, "effective": effective(current), "timeline": timeline,
            "forms": item_forms(code, current.values())}


_TEMPLATES: list | None = None


def _templates() -> list[dict]:
    global _TEMPLATES
    if _TEMPLATES is None:
        try:
            from . import registry
            _TEMPLATES = registry.load_templates()
        except (OSError, ValueError):
            _TEMPLATES = []
    return _TEMPLATES


def item_forms(code: str, current, templates: list[dict] | None = None) -> list[str]:
    """The forms an item is reported on: its edit checks' series, the documents that define it
    (call-report031 → FFIEC 031) and, for its code prefix, config/registry-templates.json."""
    forms: set[str] = set()
    for facet in current:
        attrs = facet.get("attrs") or {}
        if form_name(attrs.get("form")):
            forms.add(form_name(attrs.get("form")))
        forms |= forms_in_name(str(facet.get("document") or "")) | forms_in_name(str(facet.get("url") or ""))
    for template in templates if templates is not None else _templates():
        if any(code.startswith(prefix) for prefix in template.get("code_prefixes") or ()):
            for part in re.split(r"\s*/\s*", str(template.get("form") or "")):
                # "FFIEC 031/041" lists two forms
                part = part if re.match(r"(?i)^(ffiec|fr)\b", part) else (str(template.get("form") or "").split(" ")[0] + " " + part)
                if form_name(part):
                    forms.add(form_name(part))
    return sorted(forms)


def effective(current: dict) -> dict:
    """When the item applies, from the current facets that state dates (final ones first).

    ``basis`` names the kinds of document the dates come from (the data
    dictionary when it dates the item, otherwise edit checks). ``from``/``to``
    are ISO dates, ``first_quarter``/``last_quarter`` report quarters
    (``last_quarter`` empty while open-ended), ``report_date`` the newest
    taxonomy report date that defines it, ``proposed`` when only a proposal
    states the dates.
    """
    dated = [facet for facet in current.values() if (facet.get("attrs") or {}).get("start") or (facet.get("attrs") or {}).get("end")]
    # The data dictionary (MDRM) dates the item itself; an edit check's start
    # date only says when that check applies, so it is used only without one.
    dated = [facet for facet in dated if facet.get("kind") == "dictionary"] or dated
    final = [facet for facet in dated if facet.get("status") == "final"] or dated
    out: dict = {}
    if final:
        out["basis"] = sorted({facet.get("kind") for facet in final})
    starts = sorted(iso_date(facet["attrs"].get("start")) for facet in final if iso_date(facet["attrs"].get("start")))
    ends = sorted(iso_date(facet["attrs"].get("end")) for facet in final if iso_date(facet["attrs"].get("end")))
    if starts:
        out["from"] = starts[0]
        out["first_quarter"] = quarter(starts[0])
    if ends:
        out["to"] = ends[-1]
        out["last_quarter"] = quarter(ends[-1])
    reports = sorted(str(facet.get("report_date") or "") for facet in current.values())
    if reports and reports[-1]:
        out["report_date"] = reports[-1]
    if dated and not any(facet.get("status") == "final" for facet in dated):
        out["proposed"] = True
    return out


def dated_items(data_dir: Path) -> list[dict]:
    """Every catalog item with its effective dates and forms: {code, forms, from, to, basis, url, at}."""
    directory = _directory(data_dir)
    out: list[dict] = []
    if not directory.exists():
        return out
    for path in sorted(directory.glob("*.json")):
        if not SERIES_FILE.match(path.name):
            continue
        doc = load_series(data_dir, path.stem)
        for code in sorted(doc["items"]):
            item = _history(doc, code)
            if not item or not item["current"]:
                continue
            dates = item["effective"]
            if not dates.get("from") and not dates.get("to"):
                continue
            basis = (dates.get("basis") or [""])[0]
            source = next((facet for facet in item["current"].values() if facet.get("kind") == basis), next(iter(item["current"].values())))
            out.append({"code": code, "forms": item["forms"], "from": dates.get("from", ""), "to": dates.get("to", ""),
                        "basis": basis, "proposed": bool(dates.get("proposed")), "url": source.get("url") or "", "at": source.get("since") or ""})
    return out


def validate(data_dir: Path) -> list[str]:
    """Structural problems in data/items/ (empty when valid or absent)."""
    directory = _directory(data_dir)
    if not directory.exists():
        return []
    errors: list[str] = []
    index = load_index(data_dir)
    if not (directory / "index.json").exists() or index.get("updated_at") is None:
        errors.append("data/items/index.json is missing or invalid")
    for path in sorted(directory.glob("*.json")):
        if path.name == "index.json":
            continue
        if not SERIES_FILE.match(path.name):
            errors.append(f"data/items/{path.name}: unexpected file")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            errors.append(f"data/items/{path.name}: not JSON")
            continue
        if payload.get("schema_version") != SCHEMA_VERSION or not isinstance(payload.get("items"), dict):
            errors.append(f"data/items/{path.name}: schema_version {SCHEMA_VERSION} with an items object is required")
            continue
        facets = payload.get("facets") or {}
        for code, item in payload["items"].items():
            if not MDRM.match(code) or code[:4] != path.stem:
                errors.append(f"data/items/{path.name}: {code} does not belong in this file")
            for fid, versions in (item or {}).items():
                if fid not in facets:
                    errors.append(f"data/items/{path.name}: {code} names an unknown facet {fid}")
                    continue
                if not isinstance(versions, list) or not versions:
                    errors.append(f"data/items/{path.name}: {code} facet {fid} has no versions")
                    continue
                editions = facets[fid].get("editions") or {}
                for version in versions:
                    if version.get("src") not in editions:
                        errors.append(f"data/items/{path.name}: {code} facet {fid} cites an unknown edition {version.get('src')}")
                        break
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    show = sub.add_parser("show", help="an item's facets and timeline")
    show.add_argument("code")
    build = sub.add_parser("build", help="bring data/items/ up to date with data/latest.json")
    build.add_argument("--data-dir", type=Path, default=DATA)
    build.add_argument("--force", action="store_true", help="read every document again (same bytes update in place)")
    args = parser.parse_args(argv)
    if args.command == "show":
        result = history(DATA, args.code)
        if result is None:
            print(f"{args.code}: not in the catalog", file=sys.stderr)
            return 1
        print(json.dumps(result, indent=1, ensure_ascii=False))
        return 0
    latest = json.loads((args.data_dir / "latest.json").read_text(encoding="utf-8"))
    print(json.dumps(update(args.data_dir, latest, force=args.force)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
