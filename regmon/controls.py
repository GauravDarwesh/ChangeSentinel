"""CONNECT: the team's own checks, linked to the regulator's edit checks they implement (Phase 4.2-4.3).

A registry consumer of any kind (usually ``check``) can list the regulator's
edit checks it implements:

    {"id": "y9c-hc-checks", "kind": "check", "name": "FR Y-9C HC validation suite",
     "implements": ["FR Y-9C | 0303", "FR Y-9C | 0304", "IR-10000-10.02-001"]}

Each entry is an edit or rule ID, optionally scoped to a form with ``FORM | ID``.
An unscoped ID matches that ID in any form.

Two halves, kept apart like the rest of ASSESS (docs/NEXT-PHASES.md §3):

* **Regulator side** (shared, computed after each scan): ``rule_changes`` adds the
  rules a change added, retired or changed to its facts (data/change-facts.json,
  from the structured spec diff). ``write`` records the edit IDs each form's
  current specification defines, where ChangeSentinel reads the whole set
  (data/rule-index.json): the CDR taxonomy edits per Call Report form and the
  edit checklists read row by row from PDFs.
* **Customer side** (per registry): ``findings(facts, registry, index)`` joins a
  change's rule changes with the checks that implement them:

  - ``retired_in_use``  a rule the change retires or removes is still implemented
  - ``differs``         a rule you implement changed its logic, severity or dates
  - ``missing``         a rule the change adds, in a form you track, has no check
  - ``extra``           a check implements an ID the form's current spec doesn't define

  The dashboard runs the same function (``L.controlFindings``), kept equal by a
  parity test. Everything is deterministic; nothing is applied to anyone's code.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = ROOT / "config"
INDEX_FILE = "rule-index.json"
SCHEMA_VERSION = 1
MAX_RULES = 2000
MAX_SHOWN = 50
MAX_IMPLEMENTS = 5000
SEPARATOR = "|"

# spec_diff categories → what happened to the rule.
RETIRED = {"retired", "removed"}
CHANGED = {"logic", "severity", "effective"}
ADDED = {"added", "added_version", "reinstated"}
CHANGE_WORDS = {"retired": "retired", "removed": "removed from the file", "logic": "logic changed", "severity": "severity changed",
                "effective": "dates changed", "added": "new rule", "added_version": "new version", "reinstated": "reinstated"}
FINDINGS = ("retired_in_use", "differs", "missing", "extra")
FINDING_WORDS = {"retired_in_use": "Retired, still implemented", "differs": "Changed; your check mirrors the old rule",
                 "missing": "New rule, no check", "extra": "Implemented, not in the current spec"}


def norm(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).upper()


def form_key(value: str) -> str:
    """Forms compared loosely: "FR Y-9C", "fr y9c" and "FRY-9C" are one form."""
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def parse_implements(value: str) -> tuple[str, str]:
    """("FR Y-9C", "0303") from "FR Y-9C | 0303"; ("", "0303") from "0303"."""
    text = " ".join(str(value or "").split())
    if SEPARATOR in text:
        form, _, identifier = text.rpartition(SEPARATOR)
        return form.strip(), identifier.strip()
    return "", text


# --------------------------------------------------------------------------- regulator side


def rule_changes(evidence: dict) -> list[list[str]]:
    """[[id, category, level, quarter]] for every rule a structured spec diff added, retired or changed."""
    out: list[list[str]] = []
    seen = set()
    for table in (evidence.get("spec_diff") or {}).get("tables") or []:
        if table.get("kind") != "rules":
            continue
        for change in table.get("changes") or []:
            category = change.get("category")
            categories = [category] + [other for other in change.get("also") or [] if other != category]
            picked = next((name for name in categories if name in RETIRED | CHANGED | ADDED), "")
            identifier = str(change.get("id") or "").strip()
            if not picked or not identifier:
                continue
            if picked == "removed" and str(change.get("note") or "").startswith("Still present"):
                continue  # re-keyed or re-versioned, not gone
            key = (norm(identifier), picked)
            if key in seen:
                continue
            seen.add(key)
            out.append([identifier[:120], picked, str(change.get("level") or ""), str(change.get("quarter") or "")])
            if len(out) >= MAX_RULES:
                return out
    return out


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def build_index(data_dir: Path = DATA, config_dir: Path = CONFIG) -> dict:
    """The edit IDs each form's current specification defines, where the whole set is read."""
    from . import applicability, catalog, proposals

    library = applicability.load_library(config_dir / "reports.json")
    forms: dict[str, dict] = {}

    def add(form: str, source: str, ids: set[str]):
        entry = forms.setdefault(form, {"sources": [], "ids": set()})
        if source not in entry["sources"]:
            entry["sources"].append(source)
        entry["ids"] |= {norm(identifier) for identifier in ids if identifier}

    edits = _read_json(data_dir / "edits" / "index.json", {}) or {}
    for form, sets in (edits.get("forms") or {}).items():
        if not sets:
            continue
        newest = max(sets, key=lambda row: (str(row.get("date") or ""), str(row.get("version") or "")))
        payload = _read_json(data_dir.parent / str(newest.get("file") or ""), {}) if str(newest.get("file") or "").startswith("data/edits/") else {}
        ids = {str(edit.get("id") or "") for edit in payload.get("edits") or [] if isinstance(edit, dict)}
        if ids:
            add(form, f"CDR taxonomy edits {newest.get('date')} (v{newest.get('version')})", ids)

    sources = {source.get("id"): source for source in (_read_json(config_dir / "sources.json", {}) or {}).get("sources") or [] if isinstance(source, dict)}
    latest = (_read_json(data_dir / "latest.json", {}) or {}).get("sources") or {}
    for source_id, records in latest.items():
        for record in (records or {}).values():
            pointer = (record.get("rule_tables") or {}).get("rule_tables_location") or ""
            if record.get("active") is False or not re.match(r"^data/rule-tables/[A-Za-z0-9_.-]+\.json$", pointer):
                continue
            payload = _read_json(data_dir.parent / pointer, {})
            rows = [row for row in payload.get("rows") or [] if isinstance(row, dict) and row.get("id")]
            if not rows:
                continue
            name, url = str((sources.get(source_id) or {}).get("name") or ""), str(record.get("canonical_url") or "")
            # The form each row belongs to: its series ("FRY9C" is FR Y-9C), else the monitor's name or address.
            named = set()
            for text in (name, url):
                for found in proposals.forms_in(text) | library.named_in(text) | catalog.forms_in_name(text):
                    named |= set(library.canonical(found))
            by_key = {form_key(form): form for form in library.reports}
            grouped: dict[str, set[str]] = {}
            for row in rows:
                form = by_key.get(form_key(row.get("series") or ""))
                for target in [form] if form else sorted(named):
                    grouped.setdefault(target, set()).add(str(row["id"]))
            for form, ids in sorted(grouped.items()):
                add(form, "Edit checklist read from the PDF at " + url, ids)
    return {"schema_version": SCHEMA_VERSION,
            "about": "Edit and rule IDs each form's current specification defines, where ChangeSentinel reads the whole set. "
                     "A check implementing an ID not listed for its form is reported as 'extra'. Forms not listed are not checked for extras.",
            "forms": {form: {"sources": entry["sources"], "count": len(entry["ids"]), "ids": sorted(entry["ids"])} for form, entry in sorted(forms.items())}}


def write(data_dir: Path = DATA, config_dir: Path = CONFIG) -> dict:
    index = build_index(data_dir, config_dir)
    text = json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    path = data_dir / INDEX_FILE
    try:
        unchanged = path.read_text(encoding="utf-8") == text
    except OSError:
        unchanged = False
    if not unchanged:
        atomic_write_text(path, text)
    return {"forms": len(index["forms"]), "written": not unchanged}


def load_index(data_dir: Path = DATA) -> dict:
    payload = _read_json(data_dir / INDEX_FILE, {})
    return payload if isinstance(payload, dict) and isinstance(payload.get("forms"), dict) else {"forms": {}}


def validate(data_dir: Path = DATA) -> list[str]:
    path = data_dir / INDEX_FILE
    if not path.exists():
        return []
    payload = _read_json(path, None)
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION or not isinstance(payload.get("forms"), dict):
        return [f"data/{INDEX_FILE}: not a schema {SCHEMA_VERSION} rule index"]
    return [f"data/{INDEX_FILE}: {form} lists {len(entry.get('ids') or [])} ids but counts {entry.get('count')}"
            for form, entry in payload["forms"].items() if not isinstance(entry, dict) or entry.get("count") != len(entry.get("ids") or [])]


# --------------------------------------------------------------------------- customer side


def implemented(registry: dict | None) -> list[dict]:
    """[{consumer, form, id}] for every implements entry in a (raw or validated) registry."""
    consumers = (registry or {}).get("consumers") or []
    if isinstance(consumers, dict):
        consumers = list(consumers.values())
    out = []
    for consumer in consumers:
        if not isinstance(consumer, dict):
            continue
        for value in consumer.get("implements") or []:
            form, identifier = parse_implements(value)
            if identifier:
                out.append({"consumer": str(consumer.get("id") or ""), "form": form, "id": norm(identifier), "raw": identifier})
    return out


def findings(facts: dict, registry: dict | None, index: dict | None = None) -> dict | None:
    """What a change means for the team's own checks; None when no check is linked to its forms or rules."""
    entries = implemented(registry)
    if not entries:
        return None
    forms = [row.get("form") for row in facts.get("forms") or [] if row.get("form")]
    keys = {form_key(form) for form in forms}
    relevant = [entry for entry in entries if not entry["form"] or form_key(entry["form"]) in keys]
    by_id: dict[str, list[str]] = {}
    for entry in relevant:
        bucket = by_id.setdefault(entry["id"], [])
        if entry["consumer"] not in bucket:
            bucket.append(entry["consumer"])
    rules = [row for row in facts.get("rules") or [] if isinstance(row, list) and len(row) >= 2]
    tracked = sorted({form for form in forms if any(entry["form"] and form_key(entry["form"]) == form_key(form) for entry in entries)})
    hit = any(norm(row[0]) in by_id for row in rules)
    out: dict = {finding: [] for finding in FINDINGS}
    for row in rules:
        identifier, change = str(row[0]), str(row[1])
        level = str(row[2]) if len(row) > 2 else ""
        quarter = str(row[3]) if len(row) > 3 else ""
        consumers = sorted(by_id.get(norm(identifier), []))
        base = {"id": identifier, "change": change, "level": level, "quarter": quarter}
        if change in RETIRED and consumers:
            out["retired_in_use"].append({**base, "consumers": consumers})
        elif change in CHANGED and consumers:
            out["differs"].append({**base, "consumers": consumers})
        elif change in ADDED and not consumers and (tracked or hit):
            out["missing"].append(base)
    index_forms = {form_key(form): (form, entry) for form, entry in ((index or {}).get("forms") or {}).items() if isinstance(entry, dict)}
    checked = []
    # Extras only on a change to the specification itself (it has rule changes), not on every page edit.
    for form in forms if rules else []:
        known = index_forms.get(form_key(form))
        if not known:
            continue
        checked.append(known[0])
        defined = set(known[1].get("ids") or [])
        extra: dict[str, list[str]] = {}
        for entry in entries:
            if entry["form"] and form_key(entry["form"]) == form_key(form) and entry["id"] not in defined:
                bucket = extra.setdefault(entry["raw"], [])
                if entry["consumer"] not in bucket:
                    bucket.append(entry["consumer"])
        out["extra"].extend({"id": identifier, "form": form, "consumers": sorted(consumers)} for identifier, consumers in sorted(extra.items()))
    # Only a change to the specification itself (rule changes in a form you track, or in a rule you
    # implement) says anything about your checks; a page edit on a tracked form says nothing.
    if not (rules and (tracked or hit)) and not any(out.values()):
        return None
    counts = {finding: len(out[finding]) for finding in FINDINGS}
    result = {"counts": counts, "tracked": tracked, "checked": sorted(set(checked)),
              "consumers": sorted({consumer for finding in ("retired_in_use", "differs") for row in out[finding] for consumer in row["consumers"]})}
    for finding in FINDINGS:
        result[finding] = out[finding][:MAX_SHOWN]
    return result


def consumer_extras(consumer: dict, index: dict | None) -> list[dict]:
    """Implements entries scoped to a form whose current spec, as read whole, doesn't define them."""
    index_forms = {form_key(form): (form, entry) for form, entry in ((index or {}).get("forms") or {}).items() if isinstance(entry, dict)}
    out = []
    for value in consumer.get("implements") or []:
        form, identifier = parse_implements(value)
        known = index_forms.get(form_key(form)) if form else None
        if known and norm(identifier) not in set(known[1].get("ids") or []):
            out.append({"id": identifier, "form": known[0]})
    return out


def summary(result: dict | None) -> str:
    """One line for an alert or a list: "Your checks: 2 retired rules still implemented; 5 rules you implement changed"."""
    if not result:
        return ""
    counts = result["counts"]
    parts = []
    if counts["retired_in_use"]:
        parts.append(f"{counts['retired_in_use']} retired rule{'s' if counts['retired_in_use'] != 1 else ''} still implemented")
    if counts["differs"]:
        parts.append(f"{counts['differs']} rule{'s' if counts['differs'] != 1 else ''} you implement changed")
    if counts["missing"]:
        parts.append(f"{counts['missing']} new rule{'s' if counts['missing'] != 1 else ''} with no check")
    if counts["extra"]:
        parts.append(f"{counts['extra']} implemented rule{'s' if counts['extra'] != 1 else ''} not in the current spec")
    return ("Your checks: " + "; ".join(parts)) if parts else ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.controls", description="The team's checks against the regulator's edit checks")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("index", help="Rebuild data/rule-index.json")
    report = sub.add_parser("report", help="Findings for every recorded change")
    report.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "index":
        result = write(DATA, CONFIG)
        print(f"Rule index: {result['forms']} forms" + (" (written)" if result["written"] else " (unchanged)"))
        return 0
    from .registry import REGISTRY_PATH

    registry = _read_json(REGISTRY_PATH, {})
    index = load_index(DATA)
    events = (_read_json(DATA / "change-facts.json", {}) or {}).get("events") or {}
    rows = {event_id: result for event_id, facts in events.items() if (result := findings(facts, registry, index))}
    if args.json:
        print(json.dumps(rows, indent=1))
    else:
        for event_id, result in rows.items():
            print(event_id[:12], summary(result) or "tracked, nothing to do")
    return 0


if __name__ == "__main__":
    sys.exit(main())
