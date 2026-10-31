"""Item catalog: what regulators say each reporting item is, version by version.

The registry (config/registry.json) is the reporting team's side: the items it
reports and what reads them. This is the regulator's side, built from what the
monitors already save, with no model involved:

* field tables of dictionaries and instructions (the MDRM data dictionary,
  FR Y-14 data dictionaries, instruction tables): name, definition, data type,
  schedule, line and the dates the item applies;
* PDF rule tables (data/rule-tables/, the FR Y-9C edit checklist): the edits
  that check the item, how many read it (and a sample of them), with its
  schedule and line;
* XBRL schemas (the Call Report taxonomy's concepts.xsd): the concept's type,
  period type and balance;
* edit formulas (the taxonomy's -ec.xml and other rule tables with logic): how
  many edits read the item (``read_by``, exact), and a sample of them
  (``read_by_sample``, the first 10 alphabetically).

Each source document contributes a *facet* of an item, and each facet keeps
its *versions*: a new version is recorded only when what the document says
changes, with the scan time it was first seen and the document it came from.
A code that leaves a document gets a version marked ``absent``. So the catalog
answers "what did the regulator say BHCK2170 is, and since when" across every
document that defines it.

Status (review §6A): a version from a document that is a proposal, draft or
redline is ``proposed``; otherwise ``final``. A version followed by a newer one
of the same facet is superseded (``history()`` marks it). Dates (review §6B):
a facet carries the regulator's own start and end dates where the source has
them, and a taxonomy's report date from its file name.

Files (one per series, the four-letter MDRM mnemonic), rebuilt only for
documents whose normalized text changed since the last build:

    data/items/index.json      {"schema_version", "updated_at", "sources": {url_id: {...}}, "series": {"BHCK": n}}
    data/items/BHCK.json       {"schema_version", "series",
                                "facets": {"<id>": {"url", "url_id", "source_id", "document", "kind"}},
                                "items": {"BHCK2170": {"<facet id>": [{"at", "attrs", "status"?} | {"at", "absent": true}]}}}

Each source document is listed once under ``facets``; items are written one
per line, so a change rewrites only its own lines in git. ``status`` is left
out when it is ``final``.

    python -m regmon.catalog show BHCK2170     # the item's timeline
    python -m regmon.catalog build             # rebuild from the saved state
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
SCHEMA_VERSION = 1
# Four letters, then an item number of four letters or digits with at least one digit
# (2170, C447, PV23): "EXISTING" in a formula is a word, not a code.
MDRM = re.compile(r"^[A-Z]{4}(?=[A-Z]*\d)[A-Z0-9]{4}$")
# A code inside a formula or rule logic: "cc:RCON2170[P0]", "bhck2170", "BHCK 2170".
CODE_IN_LOGIC = re.compile(r"(?<![A-Za-z0-9])(?:cc:)?([A-Za-z]{4})\s?([A-Za-z0-9]{4})(?![A-Za-z0-9])")
SERIES_FILE = re.compile(r"^[A-Z]{4}\.json$")
MAX_TEXT = 600
MAX_EDITS = 10
PROPOSED = re.compile(r"propos|draft|redline|consultation|for comment|federal ?register notice|\bfrn\b", re.I)
REPORT_DATE = re.compile(r"(?<!\d)(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)")
DICTIONARY_ATTRS = ("name", "description", "dtype", "table", "line_item", "series", "start", "end")
ATTR_NAMES = {"description": "definition", "table": "schedule", "line_item": "line", "series": "form"}


def _clean(value: object, limit: int = MAX_TEXT) -> str:
    return " ".join(str(value or "").split())[:limit]


def _code(value: object) -> str:
    code = re.sub(r"\s+", "", str(value or "")).upper()
    return code if MDRM.match(code) else ""


def status_of(url: str, document: str = "", title: str = "") -> str:
    """'proposed' for a proposal, draft or redline document, else 'final'."""
    return "proposed" if PROPOSED.search(" ".join((url or "", document or "", title or ""))) else "final"


def report_date(document: str) -> str:
    """A taxonomy's report date from its file name (call-report031-2026-09-30-v301.xsd -> 2026-09-30)."""
    match = REPORT_DATE.search(document or "")
    return "-".join(match.groups()) if match else ""


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


def _cell(table, row: list[str], role: str, limit: int | None = MAX_TEXT) -> str:
    index = table.roles.get(role)
    if index is None or index >= len(row):
        return ""
    return " ".join(str(row[index] or "").split()) if limit is None else _clean(row[index], limit)


def _codes_in_logic(text: str) -> set[str]:
    return {code for code in ((a + b).upper() for a, b in CODE_IN_LOGIC.findall(text or "")) if MDRM.match(code)}


def _rule_key(table, row: list[str]) -> str:
    parts = [_cell(table, row, role) for role in ("etype", "id")]
    return " ".join(part for part in parts if part) or _cell(table, row, "id")


def facts_from_text(text: str) -> dict[tuple[str, str], dict[str, dict]]:
    """{(document, kind): {code: attrs}} from a saved document's normalized text."""
    out: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    reads: dict[tuple[str, str], dict[str, set]] = defaultdict(lambda: defaultdict(set))
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
                if report_date(document):
                    attrs["report_date"] = report_date(document)
                facts[code] = {key: value for key, value in attrs.items() if value}
        elif table.kind == "rules" and "logic" in table.roles:
            key = (document, "edits")
            for row in table.rows:
                edit = _rule_key(table, row)
                for code in _codes_in_logic(_cell(table, row, "logic", limit=None)):
                    reads[key][code].add(edit)
    for key, by_code in reads.items():
        facts = out[key]
        for code, edits in by_code.items():
            attrs = {"read_by": str(len(edits)), "read_by_sample": sorted(edits)[:MAX_EDITS]}
            if report_date(key[0]):
                attrs["report_date"] = report_date(key[0])
            facts[code] = attrs
    return {key: value for key, value in out.items() if value}


def facts_from_rule_tables(payload: dict) -> dict[str, dict]:
    """{code: attrs} from a data/rule-tables/ file (PDF edit checklists)."""
    targets: dict[str, set] = defaultdict(set)
    read_by: dict[str, set] = defaultdict(set)
    places: dict[str, Counter] = defaultdict(Counter)
    dates: dict[str, set] = defaultdict(set)
    pages: dict[str, set] = defaultdict(set)
    for row in payload.get("rows") or []:
        if not isinstance(row, dict):
            continue
        edit = " ".join(part for part in (str(row.get("etype") or ""), str(row.get("id") or "")) if part)
        code = _code(row.get("field"))
        if code:
            targets[code].add(edit)
            places[code][(str(row.get("table") or ""), str(row.get("line_item") or ""))] += 1
            dates[code].add((str(row.get("start") or ""), str(row.get("end") or "")))
            if isinstance(row.get("page"), int) and not isinstance(row.get("page"), bool):
                pages[code].add(row["page"])
        for other in row.get("reads") or []:
            other = _code(other)
            if other:
                read_by[other].add(edit)
    facts: dict[str, dict] = {}
    for code in set(targets) | set(read_by):
        attrs: dict = {}
        if places.get(code):
            schedule, line = places[code].most_common(1)[0][0]
            attrs.update({key: value for key, value in (("schedule", schedule), ("line", line)) if value})
        if targets.get(code):
            attrs["checked_by"] = sorted(targets[code])[:MAX_EDITS]
            starts = sorted(iso_date(start) or start for start, _end in dates[code] if start)
            if starts:
                attrs["start"] = starts[0]
            if pages.get(code):
                attrs["pages"] = sorted(pages[code])[:MAX_EDITS]  # PDF pages of its checks, for the citation
        if read_by.get(code):
            attrs["read_by"] = str(len(read_by[code]))
            attrs["read_by_sample"] = sorted(read_by[code])[:MAX_EDITS]
        facts[code] = attrs
    return facts


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _directory(data_dir: Path) -> Path:
    return data_dir / DIRECTORY


def load_index(data_dir: Path) -> dict:
    path = _directory(data_dir) / "index.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION:
            payload.setdefault("sources", {})
            return payload
    except (OSError, ValueError):
        pass
    return {"schema_version": SCHEMA_VERSION, "updated_at": None, "sources": {}, "series": {}}


def facet_id(url_id: str, document: str, kind: str) -> str:
    """A short, stable id for one source document's facet."""
    return hashlib.sha256(f"{url_id}|{document}|{kind}".encode("utf-8")).hexdigest()[:12]


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
    sources = index.get("sources") or {}
    body = ",\n".join(f"{_line(url_id)}:{_line(sources[url_id])}" for url_id in sorted(sources))
    return ('{"schema_version":' + str(SCHEMA_VERSION) + ',"updated_at":' + _line(index.get("updated_at")) +
            ',"series":' + _line(index.get("series") or {}) + ',\n"sources":{\n' + body + "\n}}\n")


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


def update(data_dir: Path, latest: dict, *, now: str | None = None, root: Path | None = None) -> dict:
    """Bring data/items/ up to date with the inventory; returns counts. Only changed documents are re-read."""
    at = now or _now()
    root = root or data_dir.parent
    index = load_index(data_dir)
    titles = _link_texts(data_dir)
    known = index["sources"]
    loaded: dict[str, dict] = {}
    touched_series: set[str] = set()
    counts = {"documents": 0, "versions": 0, "items": 0}

    def series_doc(series: str) -> dict:
        if series not in loaded:
            loaded[series] = load_series(data_dir, series)
        return loaded[series]

    for source_id, records in sorted((latest.get("sources") or {}).items()):
        for url_id, record in sorted((records or {}).items()):
            if record.get("active") is False or not record.get("normalized_hash"):
                continue
            fingerprint = "|".join((str(record.get("normalized_hash")),
                                    str((record.get("rule_tables") or {}).get("rule_tables_location") or "")))
            previous = known.get(url_id) or {}
            if previous.get("fingerprint") == fingerprint:
                continue
            facets = _source_facts(record, root)
            if facets is None:
                continue
            counts["documents"] += 1
            url = str(record.get("canonical_url") or "")
            seen: dict[str, set] = defaultdict(set)
            for suffix, facts in facets.items():
                document, kind = suffix.split("|", 1)
                status = status_of(url, document, titles.get(url, ""))
                fid = facet_id(url_id, document, kind)
                meta = {"url": url, "url_id": url_id, "source_id": source_id, "document": document, "kind": kind}
                for code, attrs in facts.items():
                    seen[fid].add(code)
                    doc = series_doc(code[:4])
                    if doc["facets"].get(fid) != meta:
                        doc["facets"][fid] = meta
                        touched_series.add(code[:4])
                    versions = doc["items"].setdefault(code, {}).setdefault(fid, [])
                    last = versions[-1] if versions else None
                    if last is None or last.get("absent") or last.get("attrs") != attrs or last.get("status", "final") != status:
                        versions.append({"at": at, "attrs": attrs, **({"status": status} if status != "final" else {})})
                        touched_series.add(code[:4])
                        counts["versions"] += 1
            # Codes this document no longer lists.
            for fid, codes in (previous.get("codes") or {}).items():
                for code in set(codes) - seen.get(fid, set()):
                    versions = (series_doc(code[:4])["items"].get(code) or {}).get(fid)
                    if versions and not versions[-1].get("absent"):
                        versions.append({"at": at, "absent": True})
                        touched_series.add(code[:4])
                        counts["versions"] += 1
            known[url_id] = {"fingerprint": fingerprint, "url": url, "source_id": source_id,
                             "codes": {key: sorted(codes) for key, codes in seen.items()}}
    if not touched_series and not counts["documents"]:
        return counts
    directory = _directory(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    for series in sorted(touched_series):
        doc = loaded[series]
        atomic_write_text(directory / f"{series}.json", dump_series(doc))
        index.setdefault("series", {})[series] = len(doc["items"])
    counts["items"] = sum(index.get("series", {}).values())
    index["updated_at"] = at
    atomic_write_text(directory / "index.json", dump_index(index))
    return counts


def history(data_dir: Path, code: str) -> dict | None:
    """The item's facets and a merged timeline, newest first; None when the catalog does not know it."""
    code = _code(code)
    if not code:
        return None
    doc = load_series(data_dir, code[:4])
    item = doc["items"].get(code)
    if not item:
        return None
    timeline = []
    current = {}
    for fid, versions in sorted(item.items()):
        facet = doc["facets"].get(fid) or {}
        for number, version in enumerate(versions):
            entry = {"at": version.get("at"), "url": facet.get("url"), "document": facet.get("document"), "kind": facet.get("kind"),
                     "status": "absent" if version.get("absent") else version.get("status", "final"),
                     "superseded": number < len(versions) - 1}
            if not version.get("absent"):
                entry["attrs"] = version.get("attrs")
                if number:
                    before = next((v.get("attrs") or {} for v in reversed(versions[:number]) if not v.get("absent")), {})
                    entry["changed"] = sorted(name for name in set(before) | set(version.get("attrs") or {})
                                              if before.get(name) != (version.get("attrs") or {}).get(name))
            timeline.append(entry)
        if versions and not versions[-1].get("absent"):
            current[fid] = {"url": facet.get("url"), "document": facet.get("document"), "kind": facet.get("kind"),
                            "status": versions[-1].get("status", "final"), "since": versions[-1].get("at"), "attrs": versions[-1].get("attrs")}
    timeline.sort(key=lambda entry: str(entry.get("at") or ""), reverse=True)
    return {"code": code, "series": code[:4], "current": current, "effective": effective(current), "timeline": timeline}


def effective(current: dict) -> dict:
    """When the item applies, from the current facets that state dates (final ones first).

    ``basis`` names the kinds of document the dates come from (the data
    dictionary when it dates the item, otherwise edit checks). ``from``/``to`` are ISO dates, ``first_quarter``/``last_quarter`` report
    quarters (``last_quarter`` empty while open-ended), ``report_date`` the
    newest taxonomy report date that defines it, ``proposed`` when only a
    proposal states the dates.
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
    reports = sorted((facet.get("attrs") or {}).get("report_date", "") for facet in current.values())
    if reports and reports[-1]:
        out["report_date"] = reports[-1]
    if dated and not any(facet.get("status") == "final" for facet in dated):
        out["proposed"] = True
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
                if not isinstance(versions, list) or not versions:
                    errors.append(f"data/items/{path.name}: {code} facet {fid} has no versions")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    show = sub.add_parser("show", help="an item's facets and timeline")
    show.add_argument("code")
    build = sub.add_parser("build", help="bring data/items/ up to date with data/latest.json")
    build.add_argument("--data-dir", type=Path, default=DATA)
    args = parser.parse_args(argv)
    if args.command == "show":
        result = history(DATA, args.code)
        if result is None:
            print(f"{args.code}: not in the catalog", file=sys.stderr)
            return 1
        print(json.dumps(result, indent=1, ensure_ascii=False))
        return 0
    latest = json.loads((args.data_dir / "latest.json").read_text(encoding="utf-8"))
    print(json.dumps(update(args.data_dir, latest)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
