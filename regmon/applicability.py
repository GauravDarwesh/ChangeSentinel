"""ASSESS: which recorded changes apply to the entity, which applicable items have no consumer,
and in what order to review them (Phase 3).

Two halves, kept apart as docs/NEXT-PHASES.md §3 asks:

* **Regulator side** (shared): ``facts`` for every change event, written to
  ``data/change-facts.json`` after each scan. The reports a change concerns (named by the
  monitor, the page or file address, the listing page, or the item codes it touched), the
  item codes it touched with their reports, how severe it is (from the structured spec diff)
  and when it takes effect. Nothing here reads the customer's profile or registry. An event's
  facts are computed once from its evidence and kept, keyed by ``FACTS_VERSION`` and a
  fingerprint of the report library and templates (``facts_key``).
* **Customer side** (per entity): ``assess(facts, profile, registry, library)`` joins the
  facts with ``config/profile.json`` and ``config/registry.json``: *applies* / *not
  applicable* / *unknown* with the reason, applicable items with no consumer (gaps), and a
  priority with its reasons. The dashboard runs the same function (``L.assessChange`` in
  dashboard-lib.js, kept equal by a parity test), so editing the profile updates the
  Changes list at once.

The deterministic engine stays the base: assessment never creates, hides or reclassifies a
detected change. A change with no identified report, or a profile that can't decide, is
*unknown*, never *not applicable*.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

from . import catalog, proposals
from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = ROOT / "config"
FILE_NAME = "change-facts.json"
SCHEMA_VERSION = 1
FACTS_VERSION = "facts-2"
CHANGE_TYPES = ("CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED", "VISUAL_CHANGED")
MAX_CODES = 2000
MAX_SAMPLE = 20

# Severity levels, most severe first. Rule tables say a rule's severity ("Validity",
# "Quality", "Error", "Warning"); spec_diff records it on each change as ``level``.
LEVELS = {
    5: ("blocking_edit", "Blocking edit changed"),
    4: ("edit", "Edit check changed"),
    3: ("item", "Reported items changed"),
    2: ("wording", "Wording changed"),
    1: ("text", "Text changed"),
    0: ("cosmetic", "Cosmetic only"),
}
MARKUP_ONLY = ("markup", "Markup only (text unchanged)")
RULE_CATEGORIES = {"added", "added_version", "severity", "logic", "retired", "reinstated", "effective", "removed"}
ITEM_CATEGORIES = {"added", "added_version", "logic", "retired", "reinstated", "effective", "definition", "removed"}
WORDING_CATEGORIES = {"message", "description"}
QUIET = {"cosmetic", "metadata"}
QUARTER = re.compile(r"\bQ([1-4])\s*(20\d\d)\b|\b(20\d\d)\s*Q([1-4])\b", re.I)
ISO_DAY = re.compile(r"\b(20\d\d|19\d\d)-(\d\d)-(\d\d)\b")


# --------------------------------------------------------------------------- the report library


@dataclass
class Library:
    """config/reports.json: who files each report, and the names that identify it."""

    payload: dict

    def __post_init__(self):
        self.reports = {report["form"]: report for report in self.payload.get("reports") or []}
        self.kinds = self.payload.get("kinds") or {}
        self.aliases = self.payload.get("aliases") or {}
        self.patterns = [(report["form"], re.compile(pattern, re.I))
                         for report in self.payload.get("reports") or [] for pattern in report.get("match") or []]

    def canonical(self, form: str) -> list[str]:
        """'FR Y-14' -> the three FR Y-14 reports; 'FR 2028bs' -> 'FR 2028'; other names unchanged."""
        form = " ".join(str(form or "").split())
        if not form:
            return []
        if form in self.aliases:
            return list(self.aliases[form])
        if form in self.reports:
            return [form]
        for name, pattern in self.patterns:
            if pattern.search(form):
                return [name]
        return [form]

    def named_in(self, text: str) -> set[str]:
        return {name for name, pattern in self.patterns if pattern.search(text or "")}


def load_library(path: Path | None = None) -> Library:
    path = path or CONFIG / "reports.json"
    try:
        return Library(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return Library({"reports": [], "kinds": {}, "aliases": {}})


def validate_library(payload: object) -> list[str]:
    errors = []
    if not isinstance(payload, dict) or not isinstance(payload.get("reports"), list):
        return ["config/reports.json must hold a reports list"]
    kinds = payload.get("kinds") or {}
    seen = set()
    for index, report in enumerate(payload["reports"]):
        where = f"reports[{index}]"
        if not isinstance(report, dict) or not str(report.get("form") or "").strip():
            errors.append(f"{where}: form is required")
            continue
        if report["form"] in seen:
            errors.append(f"{where}: {report['form']} is listed twice")
        seen.add(report["form"])
        for pattern in report.get("match") or []:
            try:
                re.compile(pattern)
            except re.error as error:
                errors.append(f"{where}: bad pattern {pattern!r}: {error}")
        rule = report.get("rule")
        if rule is not None:
            if not isinstance(rule, dict) or not isinstance(rule.get("any"), list) or not rule["any"]:
                errors.append(f"{where}: rule needs a non-empty any list")
                continue
            for condition in rule["any"]:
                unknown = set(condition) - {"kinds", "top_tier", "min_assets", "below_assets", "attrs", "categories", "not_categories",
                                            "min_trading", "min_trading_share", "files"}
                if unknown:
                    errors.append(f"{where}: unknown rule keys {sorted(unknown)}")
                for kind in condition.get("kinds") or []:
                    if kind not in kinds:
                        errors.append(f"{where}: unknown entity kind {kind}")
        if not str(report.get("who_files") or "").strip():
            errors.append(f"{where}: who_files is required")
    return errors


# --------------------------------------------------------------------------- regulator side: facts


def _quarter_date(quarter: str) -> str:
    """'Q1 2027' -> '2027-01-01' (the quarter's first day)."""
    match = QUARTER.search(quarter or "")
    if not match:
        return ""
    number = int(match.group(1) or match.group(4))
    year = int(match.group(2) or match.group(3))
    return f"{year:04d}-{(number - 1) * 3 + 1:02d}-01"


def _quarter_of(value: str) -> str:
    match = QUARTER.search(value or "")
    if match:
        return f"Q{match.group(1) or match.group(4)} {match.group(2) or match.group(3)}"
    day = ISO_DAY.search(value or "")
    if day:
        return f"Q{(int(day.group(2)) - 1) // 3 + 1} {day.group(1)}"
    return ""


def code_forms(code: str, templates: list[dict], library: Library) -> list[str]:
    """Reports an item code belongs to, from its code prefix (config/registry-templates.json)."""
    out: list[str] = []
    for form in catalog.item_forms(code, [], templates):
        for name in library.canonical(form):
            if name not in out:
                out.append(name)
    if any(name in {"FFIEC 031", "FFIEC 041"} for name in out) and "FFIEC 051" not in out and code[:4] in {"RCON", "RIAD"}:
        out.append("FFIEC 051")  # RCON/RIAD items are reported on all three Call Report forms
    return out


def _touched(evidence: dict) -> list[dict]:
    """What the change touched, from the engine's own records: [{code, change, quarter}]."""
    from .registry import touched_codes

    rows = []
    for entry in touched_codes(evidence.get("item_codes"), evidence.get("spec_diff")):
        code = entry["code"].replace(" ", "").upper()
        if not catalog.MDRM.match(code):
            continue  # registry-side names (FR Y-14 fields, DPAs) are matched by the registry, not here
        rows.append({"code": code, "change": entry["change"], "quarter": entry.get("quarter") or _quarter_of(entry.get("effective") or "")})
    return rows


def severity_of(event_type: str, evidence: dict) -> dict:
    """How severe the change is, from the structured diff. Never from AI."""
    spec = evidence.get("spec_diff") or {}
    level, detail = 1, ""
    counts: dict[str, int] = {}
    blocking = 0
    for table in spec.get("tables") or []:
        kind = table.get("kind")
        for change in table.get("changes") or []:
            category = change.get("category")
            if category in QUIET:
                continue
            categories = {category, *(change.get("also") or [])}
            if kind == "rules" and categories & RULE_CATEGORIES:
                stated = change.get("level") or ""
                escalated = (change.get("severity") or {}).get("direction") == "escalated"
                if stated == "blocking" or escalated:
                    blocking += 1
                    level = max(level, 5)
                else:
                    level = max(level, 4)
                counts["rules"] = counts.get("rules", 0) + 1
            elif kind in {"fields", "concepts", "codes", "types", "facts"} and categories & ITEM_CATEGORIES:
                level = max(level, 3)
                counts["items"] = counts.get("items", 0) + 1
            elif categories & WORDING_CATEGORIES or category == "definition":
                level = max(level, 2 if category != "definition" else 3)
                counts["wording"] = counts.get("wording", 0) + 1
    codes = evidence.get("item_codes") or {}
    code_counts = codes.get("counts") or {}
    if any(code_counts.get(kind) for kind in ("added", "removed", "amended")):
        level = max(level, 3)
    if spec.get("tables") and level == 1 and not counts:
        level = 0  # a structured diff that found only cosmetic or metadata changes
    if level == 5:
        detail = f"{blocking} blocking rule{'s' if blocking != 1 else ''} changed"
    elif level == 4:
        detail = f"{counts['rules']} edit check{'s' if counts['rules'] != 1 else ''} changed (severity not stated)" if counts.get("rules") else ""
    elif level == 3:
        changed = counts.get("items", 0) + sum(int(code_counts.get(kind) or 0) for kind in ("added", "removed", "amended"))
        detail = f"{changed} item{'s' if changed != 1 else ''} added, retired or redefined" if changed else ""
    kind, label = LEVELS[level]
    if event_type == "HTML_SOURCE_CHANGED" and level <= 1:
        # The page's markup changed and its extracted text did not: the least a change can be.
        level, (kind, label) = 0, MARKUP_ONLY
    out = {"level": level, "kind": kind, "label": label}
    if detail:
        out["detail"] = detail
    return out


def effective_of(touched: list[dict], evidence: dict) -> dict:
    """The quarter the regulator states for most of what changed (spec rows, item codes).

    The most common quarter, not the earliest: one row dated a year earlier shouldn't
    make a release look overdue. Ties go to the earlier quarter.
    """
    counts: dict[str, int] = {}
    for row in touched:
        if row.get("quarter"):
            counts[row["quarter"]] = counts.get(row["quarter"], 0) + 1
    if not counts:
        for table in (evidence.get("spec_diff") or {}).get("tables") or []:
            for change in table.get("changes") or []:
                quarter = change.get("quarter") or _quarter_of(change.get("effective") or "")
                if quarter and change.get("category") not in QUIET:
                    counts[quarter] = counts.get(quarter, 0) + 1
    if not counts:
        return {}
    quarter = sorted(counts, key=lambda name: (-counts[name], _quarter_date(name)))[0]
    return {"quarter": quarter, "date": _quarter_date(quarter), "basis": "spec"}


def facts_key(library: Library, templates: list[dict]) -> str:
    """FACTS_VERSION plus a fingerprint of what identifies reports (config/reports.json names
    and patterns, config/registry-templates.json forms and code prefixes), so kept facts are
    recomputed when either file changes how a change is matched to a report."""
    import hashlib

    basis = {"reports": [[report["form"], report.get("match") or []] for report in library.payload.get("reports") or []],
             "aliases": library.aliases,
             "templates": [[template.get("form") or "", template.get("code_prefixes") or []] for template in templates]}
    digest = hashlib.sha256(json.dumps(basis, sort_keys=True).encode("utf-8")).hexdigest()[:10]
    return f"{FACTS_VERSION}|{digest}"


def event_facts(entry: dict, record: dict, source: dict, evidence: dict, library: Library, templates: list[dict], key: str = FACTS_VERSION) -> dict:
    """The regulator-side facts of one change event."""
    forms: dict[str, list[str]] = {}

    def add(names, basis: str):
        for name in names:
            for form in library.canonical(name):
                bucket = forms.setdefault(form, [])
                if basis not in bucket:
                    bucket.append(basis)

    url = record.get("canonical_url") or entry.get("url") or ""
    name = str(source.get("name") or "")
    add(proposals.forms_in(name) | library.named_in(name), "monitor")
    page = proposals.page_form(url)
    add(({page} if page else set()) | catalog.forms_in_name(url) | library.named_in(url), "address")
    pages = list(source.get("listed_on") or [])
    for side in ("predecessor", "successor"):
        other = entry.get(side) or evidence.get(side) or {}
        if isinstance(other, dict):
            pages.append(other.get("page") or "")
            if other.get("url"):
                add(catalog.forms_in_name(other["url"]) | library.named_in(other["url"]), "address")
    for listing in pages:
        found = proposals.page_form(listing)
        add(({found} if found else set()) | library.named_in(listing), "listing")

    if not forms:
        # An index page (recent updates, forms under review): the reports its changed lines name.
        changed = "\n".join(line[1:] for line in str(evidence.get("diff") or "").splitlines()[:4000]
                            if line[:1] in "+-" and not line.startswith(("+++", "---")))
        add(proposals.forms_in(changed) | library.named_in(changed), "diff")

    touched = _touched(evidence)[:MAX_CODES]
    codes = []
    for row in touched:
        row_forms = code_forms(row["code"], templates, library)
        codes.append([row["code"], row["change"], row.get("quarter") or "", row_forms])
        add(row_forms, "codes")
    facts = {"v": key, "type": entry.get("event_type"), "at": entry.get("timestamp"), "url_id": record.get("url_id"),
             "source_id": record.get("source_id") or source.get("id"),
             "forms": [{"form": form, "basis": basis} for form, basis in sorted(forms.items())],
             "severity": severity_of(entry.get("event_type") or "", evidence)}
    if codes:
        facts["codes"] = codes
    effective = effective_of(touched, evidence)
    if effective:
        facts["effective"] = effective
    return facts


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def load(data_dir: Path = DATA) -> dict:
    payload = _read_json(data_dir / FILE_NAME, {})
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), dict):
        return {"schema_version": SCHEMA_VERSION, "events": {}}
    return payload


def build(data_dir: Path = DATA, config_dir: Path = CONFIG, *, force: bool = False) -> dict:
    """Facts for every change event in the inventory timelines. Kept facts are reused."""
    from .registry import load_templates

    library = load_library(config_dir / "reports.json")
    templates = load_templates(config_dir / "registry-templates.json")
    sources = {source["id"]: source for source in (_read_json(config_dir / "sources.json", {}).get("sources") or [])}
    latest = _read_json(data_dir / "latest.json", {}).get("sources") or {}
    kept = {} if force else load(data_dir)["events"]
    key = facts_key(library, templates)
    events: dict[str, dict] = {}
    for source_id, records in latest.items():
        for record in (records or {}).values():
            for entry in record.get("change_history") or []:
                event_id = entry.get("event_id")
                if not event_id or entry.get("event_type") not in CHANGE_TYPES or event_id in events:
                    continue
                previous = kept.get(event_id)
                if previous and previous.get("v") == key:
                    events[event_id] = previous
                    continue
                evidence = _read_json(data_dir.parent / entry["evidence_location"], {}) if entry.get("evidence_location") else {}
                events[event_id] = event_facts(entry, record, sources.get(source_id, {"id": source_id}), evidence, library, templates, key)
    return {"schema_version": SCHEMA_VERSION, "facts_version": key, "events": dict(sorted(events.items()))}


def _dump(payload: dict) -> str:
    """One event per line, so a scan's commit shows only the events it added."""
    head = {key: value for key, value in payload.items() if key != "events"}
    lines = [json.dumps(head, ensure_ascii=False, sort_keys=True)[:-1] + ', "events": {']
    items = list(payload["events"].items())
    for index, (event_id, facts) in enumerate(items):
        lines.append(json.dumps(event_id) + ": " + json.dumps(facts, ensure_ascii=False, sort_keys=True) + ("," if index < len(items) - 1 else ""))
    lines.append("}}")
    return "\n".join(lines) + "\n"


def write(data_dir: Path = DATA, config_dir: Path = CONFIG, now: str | None = None, *, force: bool = False) -> dict:
    payload = build(data_dir, config_dir, force=force)
    old = load(data_dir)
    if old.get("events") == payload["events"] and old.get("facts_version") == payload["facts_version"]:
        return old
    payload["updated_at"] = now or datetime.now(timezone.utc).isoformat()
    atomic_write_text(data_dir / FILE_NAME, _dump(payload))
    return payload


def validate(data_dir: Path = DATA) -> list[str]:
    path = data_dir / FILE_NAME
    if not path.exists():
        return []
    payload = _read_json(path, None)
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), dict):
        return [f"{FILE_NAME} is not a facts file"]
    errors = []
    for event_id, facts in payload["events"].items():
        if not isinstance(facts, dict) or not isinstance(facts.get("forms"), list) or not isinstance(facts.get("severity"), dict):
            errors.append(f"{FILE_NAME}: {event_id[:12]} is malformed")
    return errors[:20]


# --------------------------------------------------------------------------- customer side: the join


def money(value) -> str:
    """$48.2 billion / $750 million: how the regulator writes thresholds."""
    if value is None:
        return "unknown"
    amount = float(value)
    for size, word in ((1e12, "trillion"), (1e9, "billion"), (1e6, "million")):
        if amount >= size:
            number = amount / size
            text = f"{number:.1f}".rstrip("0").rstrip(".")
            return f"${text} {word}"
    return f"${amount:,.0f}"


ATTR_WORDS = {"foreign_offices": "foreign offices (yes or no)", "advanced_approaches": "advanced approaches (yes or no)"}
ATTR_FAIL = {
    "foreign_offices": {True: "has foreign offices", False: "has no foreign offices"},
    "advanced_approaches": {True: "is an advanced approaches institution", False: "is not an advanced approaches institution"},
}


def _noun(kind: str, library: Library) -> str:
    return (library.kinds.get(kind) or {}).get("noun") or "a " + kind


def _entity_label(entity: dict) -> str:
    return str(entity.get("name") or entity.get("id") or "Entity")


def _described(entity: dict, library: Library) -> str:
    """'Demo Bancorp (a bank holding company, total assets $48.2 billion)'."""
    bits = [_noun(entity.get("kind") or "", library)] if entity.get("kind") else []
    if entity.get("total_assets") is not None:
        bits.append("total assets " + money(entity["total_assets"]))
    return _entity_label(entity) + (" (" + ", ".join(bits) + ")" if bits else "")


def _top_tier(entity: dict, entities: dict[str, dict], library: Library) -> bool:
    parent = entities.get(entity.get("parent") or "")
    return not parent or not (library.kinds.get(parent.get("kind") or "") or {}).get("holding")


def _condition(condition: dict, entity: dict, entities: dict[str, dict], library: Library, filed) -> tuple[bool | None, str, int]:
    """One rule condition against one entity: (True / False / None for unknown, why, stage).

    ``stage`` is 0 when the entity is simply the wrong kind, 1 when it failed a later
    test, so the reason shown is the most specific one.
    """
    kinds = condition.get("kinds")
    if kinds and entity.get("kind") not in kinds:
        nouns = [_noun(kind, library) for kind in kinds]
        return False, "is not " + (", ".join(nouns[:-1]) + " or " + nouns[-1] if len(nouns) > 1 else nouns[0]), 0
    unknown = ""
    if condition.get("top_tier") and not _top_tier(entity, entities, library):
        return False, "is not the top-tier holding company", 1
    assets = entity.get("total_assets")
    if "min_assets" in condition:
        if assets is None:
            unknown = unknown or "total assets"
        elif assets < condition["min_assets"]:
            return False, f"reports total assets of {money(assets)}, below {money(condition['min_assets'])}", 1
    if "below_assets" in condition:
        if assets is None:
            unknown = unknown or "total assets"
        elif assets >= condition["below_assets"]:
            return False, f"reports total assets of {money(assets)}, not below {money(condition['below_assets'])}", 1
    for name, wanted in (condition.get("attrs") or {}).items():
        value = entity.get(name)
        if value is None:
            unknown = unknown or ATTR_WORDS.get(name, name.replace("_", " "))
        elif bool(value) != bool(wanted):
            return False, ATTR_FAIL[name][bool(value)], 1
    category = str(entity.get("category") or "")
    for key in ("categories", "not_categories"):
        if key not in condition:
            continue
        if not category:
            unknown = unknown or "category"
        elif key == "categories" and category not in condition[key]:
            return False, ("is not subject to Category " + "/".join(condition[key]) + " standards"), 1
        elif key == "not_categories" and category in condition[key]:
            return False, f"is subject to Category {category} standards", 1
    trading = entity.get("trading")
    if "min_trading" in condition:
        if trading is None:
            unknown = unknown or "trading assets and liabilities"
        elif trading < condition["min_trading"]:
            return False, f"reports trading assets and liabilities of {money(trading)}, below {money(condition['min_trading'])}", 1
    if "min_trading_share" in condition:
        if trading is None or not assets:
            unknown = unknown or "trading assets and liabilities"
        elif trading / assets < condition["min_trading_share"]:
            return False, f"has trading assets and liabilities under {round(condition['min_trading_share'] * 100)}% of total assets", 1
    if "files" in condition:
        state = filed(condition["files"])
        if state is None:
            unknown = unknown or (condition["files"] + " filing")
        elif not state:
            return False, "does not file " + condition["files"], 1
    if unknown:
        return None, "needs " + unknown, 1
    return True, "", 1


def report_status(form: str, profile: dict, library: Library, _depth: int = 0) -> dict:
    """Whether the entity files a report: {status: files | not_filed | eligible | unknown, basis, reason}.

    The profile's list decides first; then the report's rule; then a complete list
    means unlisted reports aren't filed. Otherwise unknown.
    """
    entities = {entity["id"]: entity for entity in profile.get("entities") or []}
    names = {entity["id"]: _entity_label(entity) for entity in entities.values()}
    report = library.reports.get(form) or {}
    listed = [row for row in profile.get("reports") or [] if row.get("form") == form]
    if listed:
        filing = [row for row in listed if row.get("files", True)]
        if filing:
            who = ", ".join(dict.fromkeys(names.get(row.get("entity") or "", "") for row in filing if row.get("entity")))
            return {"status": "files", "basis": "profile", "reason": f"You file {form}" + (f" ({who})" if who else "") + "."}
        note = next((str(row.get("note") or "").strip() for row in listed if row.get("note")), "")
        return {"status": "not_filed", "basis": "profile", "reason": f"You don't file {form}" + (f": {note}" if note else "") + "."}

    def filed(other: str):
        if _depth >= 1:
            state = next((row.get("files", True) for row in profile.get("reports") or [] if row.get("form") == other), None)
            return state
        status = report_status(other, profile, library, _depth + 1)["status"]
        return True if status == "files" else False if status == "not_filed" else None

    rule = report.get("rule")
    if rule and entities:
        results = []
        for entity in entities.values():
            for condition in rule["any"]:
                state, why, stage = _condition(condition, entity, entities, library, filed)
                results.append((state, why, stage, entity))
        hit = next((entity for state, _, _, entity in results if state), None)
        if hit:
            if rule.get("optional"):
                return {"status": "eligible", "basis": "rule", "reason": f"{_described(hit, library)} may file {form}; list it in your profile if it does. {report['who_files']}"}
            return {"status": "files", "basis": "rule", "reason": f"{form} applies to {_described(hit, library)}. {report['who_files']}"}
        if all(state is False for state, _, _, _ in results):
            # The most specific reason: a condition the entity got past the kind test on.
            _, why, _, entity = max(results, key=lambda row: row[2])
            return {"status": "not_filed", "basis": "rule", "reason": f"{form} doesn't apply: {_entity_label(entity)} {why}. {report['who_files']}"}
        if profile.get("reports_complete"):
            return {"status": "not_filed", "basis": "list", "reason": f"{form} isn't in your list of reports filed."}
        _, why, _, entity = next(row for row in results if row[0] is None)
        return {"status": "unknown", "basis": "rule", "reason": f"{form}: the profile needs {_entity_label(entity)}'s {why[6:]} to decide. {report['who_files']}"}
    if profile.get("reports_complete"):
        return {"status": "not_filed", "basis": "list", "reason": f"{form} isn't in your list of reports filed."}
    if report:
        return {"status": "unknown", "basis": "", "reason": f"{form}: {report['who_files']}"}
    return {"status": "unknown", "basis": "", "reason": f"{form} is not in the report library; list it in your profile if you file it."}


def has_profile(profile: dict | None) -> bool:
    return bool(profile and (profile.get("entities") or profile.get("reports")))


def _days_until(day: str, today: date) -> int | None:
    try:
        return (date.fromisoformat(day[:10]) - today).days
    except (TypeError, ValueError):
        return None


def assess(facts: dict, profile: dict | None, registry: dict | None, library: Library, *, today: date | None = None) -> dict:
    """Applicability, gaps and priority of one change for one entity."""
    from .registry import Index

    today = today or datetime.now(timezone.utc).date()
    forms = [row["form"] for row in facts.get("forms") or []]
    if not has_profile(profile):
        applicability = {"status": "unassessed", "reason": "No entity profile yet: add the reports you file to see which changes apply.", "forms": {}}
    elif not forms:
        applicability = {"status": "unknown", "reason": "No report identified for this change.", "forms": {}}
    else:
        statuses = {form: report_status(form, profile, library) for form in forms}
        filing = [form for form, status in statuses.items() if status["status"] == "files"]
        if filing:
            status, reasons = "applies", [statuses[form]["reason"] for form in filing]
        elif all(status["status"] == "not_filed" for status in statuses.values()):
            status, reasons = "not_applicable", [status["reason"] for status in statuses.values()]
        else:
            status = "unknown"
            reasons = [status_["reason"] for status_ in statuses.values() if status_["status"] in {"unknown", "eligible"}]
        applicability = {"status": status, "reason": " ".join(reasons[:2]) + (f" (+{len(reasons) - 2} more)" if len(reasons) > 2 else ""),
                         "forms": {form: value["status"] for form, value in statuses.items()}}

    filed = {form for form, value in applicability["forms"].items() if value == "files"}
    gaps = None
    consumers: list[str] = []
    if applicability["status"] == "applies" and facts.get("codes"):
        index = Index(registry) if registry and registry.get("items") is not None else None
        unmapped: list[str] = []
        by_form: dict[str, int] = {}
        for code, _change, _quarter, code_forms_ in facts["codes"]:
            in_filed = [form for form in code_forms_ if form in filed] or ([] if code_forms_ else sorted(filed))
            if not in_filed:
                continue
            ids: list[str] = []
            if index is not None:
                for item in index.lookup(code):
                    ids.extend(item.get("consumers") or [])
                ids.extend(index.rule_consumers(code, "MDRM"))
            if ids:
                consumers.extend(identifier for identifier in ids if identifier not in consumers)
            else:
                unmapped.append(code)
                for form in in_filed:
                    by_form[form] = by_form.get(form, 0) + 1
        if unmapped:
            gaps = {"unmapped": len(unmapped), "codes": unmapped[:MAX_SAMPLE], "by_form": dict(sorted(by_form.items()))}

    severity = facts.get("severity") or {"level": 1, "label": LEVELS[1][1]}
    level = int(severity.get("level", 1))
    reasons = [severity.get("label") or LEVELS.get(level, LEVELS[1])[1]]
    score = level * 100
    effective = facts.get("effective") or {}
    days = _days_until(effective.get("date", ""), today) if effective else None
    if days is not None:
        urgency = 30 if days <= 0 else 25 if days <= 90 else 20 if days <= 180 else 10 if days <= 365 else 5
        score += urgency
        reasons.append(("in effect since " if days <= 0 else "effective ") + effective.get("quarter", effective.get("date", "")))
    if consumers:
        score += min(len(consumers), 20)
        reasons.append(f"{len(consumers)} consumer{'s' if len(consumers) != 1 else ''}")
    if gaps:
        score += 5
        reasons.append(f"{gaps['unmapped']} unmapped item{'s' if gaps['unmapped'] != 1 else ''}")
    if applicability["status"] == "not_applicable":
        band = 0
        reasons = ["Not applicable"]
    elif level >= 5 or (level >= 4 and ((days is not None and days <= 180) or consumers)):
        band = 1
    elif level >= 3 or level == 4:
        band = 2
    else:
        band = 3
    if applicability["status"] == "unknown" and band == 1 and not consumers:
        band = 2  # it may not apply: one step down until the profile decides
    priority = {"band": band, "score": score if band else 0, "reasons": reasons}
    return {"applicability": applicability, "gaps": gaps, "priority": priority}


def load_profile(path: Path | None = None) -> dict:
    from . import profile as profile_module

    return profile_module.load(path or CONFIG / "profile.json")


def assess_all(data_dir: Path = DATA, config_dir: Path = CONFIG, *, today: date | None = None) -> dict[str, dict]:
    from .registry import load as load_registry

    library = load_library(config_dir / "reports.json")
    profile = load_profile(config_dir / "profile.json")
    registry = load_registry(config_dir / "registry.json")
    return {event_id: assess(facts, profile, registry, library, today=today) for event_id, facts in load(data_dir)["events"].items()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.applicability", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build", help="write data/change-facts.json from the inventory and evidence")
    build_cmd.add_argument("--force", action="store_true", help="recompute every event's facts")
    sub.add_parser("validate", help="check config/reports.json and data/change-facts.json")
    show = sub.add_parser("assess", help="print the assessment of recorded changes for config/profile.json")
    show.add_argument("--event", help="one event id (prefix)")
    show.add_argument("--limit", type=int, default=20)
    args = parser.parse_args(argv)
    if args.command == "build":
        payload = write(force=args.force)
        print(f"{len(payload['events'])} change events; facts {payload['facts_version']}.")
        return 0
    if args.command == "validate":
        errors = validate_library(_read_json(CONFIG / "reports.json", None)) + validate()
        print("\n".join(errors) or "ok")
        return 1 if errors else 0
    results = assess_all()
    facts = load()["events"]
    rows = [(event_id, result) for event_id, result in results.items() if not args.event or event_id.startswith(args.event)]
    rows.sort(key=lambda row: (-(4 - row[1]["priority"]["band"]) if row[1]["priority"]["band"] else 0, -row[1]["priority"]["score"],
                               str(facts[row[0]].get("at") or "")), reverse=False)
    for event_id, result in rows[:args.limit]:
        print(json.dumps({"event": event_id[:12], "at": facts[event_id].get("at"), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
