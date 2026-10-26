"""Cross-jurisdiction reporting-item registry (config/registry.json).

A reporting team keeps, somewhere, the list of regulatory data points it
reports and what reads each one: FR Y-9C MDRMs, FR Y-14 data-dictionary
fields, EBA DPM data points and BIRD variables, SBS SUCAVE codes, Banco Central
do Brasil 5050 accounts. This file is that list, linked to the internal tables,
models, pipelines and code paths that consume each item, so a change can say

    These 3 fields in FR Y-9C HC-R change from Q1 2027: BHCK2170, BHCK3210,
    BHCKC447. They are read by 2 pipelines (FR Y-9C HC load, Capital ratio
    model) and 1 table (warehouse.fr_y9c.hcr).

instead of leaving the reader to look it up.

    {
      "schema_version": 1,
      "consumers": [
        {"id": "y9c-hc-load", "kind": "pipeline", "name": "FR Y-9C HC load", "owner": "Reg Reporting",
         "repo": "acme/regrep", "path": "pipelines/y9c/hc_load.py"}
      ],
      "items": [
        {"code": "BHCK2170", "scheme": "MDRM", "jurisdiction": "US", "regulator": "Federal Reserve",
         "form": "FR Y-9C", "schedule": "HC", "line": "12", "label": "Total assets",
         "aliases": ["BHCK 2170"], "equivalents": ["DPM:F 01.01 r380 c010"], "consumers": ["y9c-hc-load"]}
      ],
      "rules": [{"match": "BHCK*", "consumers": ["y9c-hc-load"], "note": "Every FR Y-9C consolidated item"}]
    }

What a change touched is collected deterministically from what the engine
already records: reporting-item codes the change added, removed or amended
(regmon/item_codes.py), rules and fields from the structured spec diff
(regmon/spec_diff.py), and any registered code or alias named on a changed
line of the diff. The registry ships empty; the owner fills it (directly, or
with ``python -m regmon.registry import mapping.csv``).
"""
from __future__ import annotations

import argparse
import csv
import fnmatch
import io
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = ROOT / "config" / "registry.json"

# Built-in identifier schemes. "pattern" is advisory: it is used to recognise
# codes in a CSV import, never to reject a registered item.
SCHEMES = {
    "MDRM": {"name": "Federal Reserve MDRM", "jurisdiction": "US", "pattern": r"^[A-Z]{4}[A-Z0-9]{4}$"},
    "FRY14": {"name": "FR Y-14 data-dictionary field", "jurisdiction": "US", "pattern": r"^[A-Za-z][A-Za-z0-9_]*$"},
    "FFIEC": {"name": "FFIEC Call Report item / edit", "jurisdiction": "US", "pattern": ""},
    "DPM": {"name": "EBA DPM data point / template cell", "jurisdiction": "EU", "pattern": ""},
    "BIRD": {"name": "ECB BIRD variable", "jurisdiction": "EU", "pattern": r"^[A-Z0-9_]+$"},
    "OSFI": {"name": "OSFI return data point (DPA, measure)", "jurisdiction": "CA", "pattern": ""},
    "SUCAVE": {"name": "SBS Peru SUCAVE code", "jurisdiction": "PE", "pattern": ""},
    "BCB5050": {"name": "Banco Central do Brasil document 5050 account", "jurisdiction": "BR", "pattern": ""},
    "OTHER": {"name": "Other identifier", "jurisdiction": "", "pattern": ""},
}
CONSUMER_KINDS = ("table", "view", "model", "pipeline", "report", "code", "check", "dashboard", "submission", "other")
KIND_NOUNS = {"table": ("table", "tables"), "view": ("view", "views"), "model": ("model", "models"), "pipeline": ("pipeline", "pipelines"),
              "report": ("report", "reports"), "code": ("code path", "code paths"), "check": ("check", "checks"),
              "dashboard": ("dashboard", "dashboards"), "submission": ("submission", "submissions"), "other": ("asset", "assets")}
CHANGE_WORDS = {
    "added": "added", "added_version": "new version", "removed": "removed", "amended": "amended", "retired": "retired",
    "reinstated": "reinstated", "severity": "severity changed", "logic": "logic changed", "effective": "dates changed",
    "message": "message changed", "definition": "redefined", "description": "relabelled", "mentioned": "named in the change",
}
QUIET = {"metadata", "cosmetic"}
MAX_ITEMS = 20000
MAX_CONSUMERS = 2000
MAX_RULES = 2000
MAX_TEXT = 300
MAX_LIST = 60
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
QUARTER = re.compile(r"\b(?:Q([1-4])\s*(20\d\d)|(20\d\d)\s*Q([1-4]))\b", re.I)
ISO_DAY = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")


def norm(code: str) -> str:
    """Comparable form of a code: upper case, no spaces."""
    return re.sub(r"\s+", "", str(code or "")).upper()


def _text(value, where: str, key: str, limit: int = MAX_TEXT) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{where}: {key} must be text of at most {limit} characters")
    return " ".join(value.split())


def _list(value, where: str, key: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_LIST or not all(isinstance(entry, str) and entry.strip() and len(entry) <= MAX_TEXT for entry in value):
        raise ValueError(f"{where}: {key} must be a list of at most {MAX_LIST} non-empty texts")
    return [" ".join(entry.split()) for entry in value]


def validate(payload: object) -> dict:
    """The registry in a canonical shape, or ValueError naming the first problem."""
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("registry.json must be an object with schema_version 1")
    unknown = set(payload) - {"schema_version", "about", "schemes", "consumers", "items", "rules"}
    if unknown:
        raise ValueError(f"registry.json has unknown keys: {', '.join(sorted(unknown))}")
    schemes = dict(SCHEMES)
    for index, scheme in enumerate(payload.get("schemes") or [], start=1):
        if not isinstance(scheme, dict) or not isinstance(scheme.get("id"), str) or not re.fullmatch(r"[A-Z0-9_]{2,20}", scheme["id"]):
            raise ValueError(f"scheme {index} needs an id such as SUCAVE (capitals, digits, underscore)")
        schemes[scheme["id"]] = {"name": _text(scheme.get("name"), f"scheme {scheme['id']}", "name") or scheme["id"],
                                 "jurisdiction": _text(scheme.get("jurisdiction"), f"scheme {scheme['id']}", "jurisdiction", 20), "pattern": ""}
    consumers: "OrderedDict[str, dict]" = OrderedDict()
    raw_consumers = payload.get("consumers") or []
    if not isinstance(raw_consumers, list) or len(raw_consumers) > MAX_CONSUMERS:
        raise ValueError(f"consumers must be a list of at most {MAX_CONSUMERS}")
    for index, consumer in enumerate(raw_consumers, start=1):
        where = f"consumer {index}"
        if not isinstance(consumer, dict):
            raise ValueError(f"{where} must be an object")
        extra = set(consumer) - {"id", "kind", "name", "owner", "system", "repo", "path", "ref", "url", "note"}
        if extra:
            raise ValueError(f"{where} has unknown keys: {', '.join(sorted(extra))}")
        identifier = consumer.get("id")
        if not isinstance(identifier, str) or not ID.match(identifier):
            raise ValueError(f"{where} needs an id (letters, digits, . _ : -)")
        if identifier in consumers:
            raise ValueError(f"{where}: id {identifier!r} is used twice")
        kind = consumer.get("kind") or "other"
        if kind not in CONSUMER_KINDS:
            raise ValueError(f"{where}: kind must be one of {', '.join(CONSUMER_KINDS)}")
        repo = _text(consumer.get("repo"), where, "repo", 140)
        if repo and not REPO.match(repo):
            raise ValueError(f"{where}: repo must look like owner/name")
        url = _text(consumer.get("url"), where, "url", 500)
        if url and not re.match(r"^https?://\S+$", url):
            raise ValueError(f"{where}: url must be a link (https://…)")
        consumers[identifier] = {"id": identifier, "kind": kind, "name": _text(consumer.get("name"), where, "name") or identifier,
                                 "owner": _text(consumer.get("owner"), where, "owner"), "system": _text(consumer.get("system"), where, "system"),
                                 "repo": repo, "path": _text(consumer.get("path"), where, "path", 400), "ref": _text(consumer.get("ref"), where, "ref", 100),
                                 "url": url, "note": _text(consumer.get("note"), where, "note")}

    def consumer_ids(value, where):
        ids = _list(value, where, "consumers")
        for identifier in ids:
            if identifier not in consumers:
                raise ValueError(f"{where}: consumer {identifier!r} is not defined in consumers")
        return ids

    items = []
    seen: dict[str, str] = {}
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ITEMS:
        raise ValueError(f"items must be a list of at most {MAX_ITEMS}")
    for index, item in enumerate(raw_items, start=1):
        where = f"item {index}"
        if not isinstance(item, dict):
            raise ValueError(f"{where} must be an object")
        extra = set(item) - {"code", "scheme", "jurisdiction", "regulator", "form", "schedule", "line", "label", "aliases",
                             "equivalents", "consumers", "owner", "note"}
        if extra:
            raise ValueError(f"{where} has unknown keys: {', '.join(sorted(extra))}")
        code = _text(item.get("code"), where, "code", 80)
        if not code:
            raise ValueError(f"{where} needs a code")
        scheme = item.get("scheme") or "OTHER"
        if scheme not in schemes:
            raise ValueError(f"{where}: scheme {scheme!r} is not known; add it under schemes")
        clean = {
            "code": code, "scheme": scheme,
            "jurisdiction": _text(item.get("jurisdiction"), where, "jurisdiction", 20) or schemes[scheme]["jurisdiction"],
            "regulator": _text(item.get("regulator"), where, "regulator"), "form": _text(item.get("form"), where, "form"),
            "schedule": _text(item.get("schedule"), where, "schedule"), "line": _text(item.get("line"), where, "line"),
            "label": _text(item.get("label"), where, "label"), "aliases": _list(item.get("aliases"), where, "aliases"),
            "equivalents": _list(item.get("equivalents"), where, "equivalents"), "consumers": consumer_ids(item.get("consumers"), where),
            "owner": _text(item.get("owner"), where, "owner"), "note": _text(item.get("note"), where, "note"),
        }
        key = f"{scheme}:{norm(code)}|{norm(clean['form'])}"
        if key in seen:
            raise ValueError(f"{where}: {scheme} {code} for {clean['form'] or 'no form'} is registered twice (also {seen[key]})")
        seen[key] = where
        items.append(clean)
    rules = []
    raw_rules = payload.get("rules") or []
    if not isinstance(raw_rules, list) or len(raw_rules) > MAX_RULES:
        raise ValueError(f"rules must be a list of at most {MAX_RULES}")
    for index, rule in enumerate(raw_rules, start=1):
        where = f"rule {index}"
        if not isinstance(rule, dict) or set(rule) - {"match", "scheme", "consumers", "note", "form"}:
            raise ValueError(f"{where} must be an object with match, consumers and optional scheme, form, note")
        pattern = _text(rule.get("match"), where, "match", 80)
        if not pattern or pattern.strip("*?") == "":
            raise ValueError(f"{where} needs a match pattern such as BHCK* (a lone * would match everything)")
        ids = consumer_ids(rule.get("consumers"), where)
        if not ids:
            raise ValueError(f"{where} needs at least one consumer")
        rules.append({"match": pattern, "scheme": _text(rule.get("scheme"), where, "scheme", 20), "form": _text(rule.get("form"), where, "form"),
                      "consumers": ids, "note": _text(rule.get("note"), where, "note")})
    return {"schema_version": 1, "schemes": schemes, "consumers": consumers, "items": items, "rules": rules}


def empty() -> dict:
    return validate({"schema_version": 1})


def load(path: Path = REGISTRY_PATH, lineage_path: Path | None = None) -> dict:
    """The registry, with config/lineage.json mappings folded in as rules."""
    registry = validate(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else empty()
    lineage_path = lineage_path if lineage_path is not None else path.parent / "lineage.json"
    if lineage_path.exists():
        from regmon import lineage

        for index, mapping in enumerate(lineage.load(lineage_path), start=1):
            ids = []
            for asset in mapping["assets"]:
                identifier = "lineage:" + re.sub(r"[^A-Za-z0-9_.:-]+", "-", asset)[:70]
                registry["consumers"].setdefault(identifier, {"id": identifier, "kind": "other", "name": asset, "owner": mapping["owner"],
                                                              "system": "", "repo": "", "path": "", "ref": "", "url": "", "note": mapping["note"]})
                ids.append(identifier)
            for code in mapping["codes"]:
                registry["rules"].append({"match": code, "scheme": "MDRM", "form": "", "consumers": ids, "note": mapping["note"]})
            for series in mapping["series"]:
                registry["rules"].append({"match": series + "*", "scheme": "MDRM", "form": "", "consumers": ids, "note": mapping["note"]})
    return registry


class Index:
    """Fast lookup of registered codes and aliases."""

    def __init__(self, registry: dict):
        self.registry = registry
        self.by_code: dict[str, list[dict]] = {}
        for item in registry["items"]:
            for name in [item["code"], *item["aliases"]]:
                bucket = self.by_code.setdefault(norm(name), [])
                if not any(existing is item for existing in bucket):
                    bucket.append(item)

    def lookup(self, code: str) -> list[dict]:
        return self.by_code.get(norm(code), [])

    def rule_consumers(self, code: str, scheme: str = "") -> list[str]:
        out = []
        value = norm(code)
        for rule in self.registry["rules"]:
            if rule["scheme"] and scheme and rule["scheme"] != scheme:
                continue
            if fnmatch.fnmatchcase(value, norm(rule["match"])):
                out.extend(identifier for identifier in rule["consumers"] if identifier not in out)
        return out

    def mentioned(self, text: str) -> list[str]:
        """Registered codes and aliases named in a piece of text, matched exactly as written.

        Case matters here: an FR Y-14 field such as ``Country`` is a registered
        item, the word "country" in a sentence is not.
        """
        found = []
        exact = {name: item for item in self.registry["items"] for name in [item["code"], *item["aliases"]] if " " not in name.strip()}
        for token in dict.fromkeys(re.findall(r"[A-Za-z0-9][A-Za-z0-9_.\-]*[A-Za-z0-9]|[A-Za-z0-9]", text or "")):
            item = exact.get(token)
            if item and item["code"] not in found:
                found.append(item["code"])
        squashed = " ".join((text or "").split())
        for item in self.registry["items"]:
            for alias in [name for name in [item["code"], *item["aliases"]] if " " in name.strip()]:
                if re.search(r"(?<![A-Za-z0-9])" + re.escape(" ".join(alias.split())) + r"(?![A-Za-z0-9])", squashed) and item["code"] not in found:
                    found.append(item["code"])
        return found


def _quarter_of(value: str) -> str:
    text = str(value or "")
    match = QUARTER.search(text)
    if match:
        return f"Q{match.group(1) or match.group(4)} {match.group(2) or match.group(3)}"
    day = ISO_DAY.search(text)
    if day:
        return f"Q{(int(day.group(2)) - 1) // 3 + 1} {day.group(1)}"
    return ""


def _quarter_key(quarter: str) -> tuple[int, int]:
    match = re.match(r"Q(\d) (\d{4})", quarter or "")
    return (int(match.group(2)), int(match.group(1))) if match else (9999, 9)


def touched_codes(item_codes: dict | None = None, spec: dict | None = None, diff_text: str = "", index: Index | None = None) -> list[dict]:
    """What a change touched: [{code, change, quarter, effective}] from the engine's own records."""
    touched: "OrderedDict[str, dict]" = OrderedDict()

    def add(code: str, change: str, quarter: str = "", effective: str = "", context: str = ""):
        code = " ".join(str(code or "").split())
        if not code:
            return
        key = norm(code)
        existing = touched.get(key)
        if existing and existing["change"] != "mentioned":
            return
        touched[key] = {"code": code, "change": change, "quarter": quarter, "effective": effective, "context": context[:MAX_TEXT]}

    for kind in ("added", "removed", "amended"):
        for entry in (item_codes or {}).get(kind) or []:
            if isinstance(entry, dict) and entry.get("code"):
                add(entry["code"], kind)
    for table in (spec or {}).get("tables") or []:
        kind = table.get("kind")
        for change in table.get("changes") or []:
            if change.get("category") in QUIET:
                continue
            code = change.get("field") or (change.get("label") if kind in {"fields", "concepts", "codes"} else "")
            if kind == "concepts" and code:
                code = code.rsplit("/", 1)[-1]
            add(code, change.get("category") or "amended", change.get("quarter") or _quarter_of(change.get("effective", "")),
                change.get("effective") or "", table.get("name") or "")
    if index is not None and diff_text:
        changed_lines = "\n".join(line[1:] for line in str(diff_text).splitlines()
                                  if line[:1] in "+-" and not line.startswith(("+++", "---")))
        for code in index.mentioned(changed_lines):
            add(code, "mentioned")
    return list(touched.values())


def _plural(count: int, noun: tuple[str, str]) -> str:
    return f"{count} {noun[0] if count == 1 else noun[1]}"


def _where(item: dict) -> str:
    form = item.get("form") or ""
    schedule = item.get("schedule") or ""
    if form and schedule:
        return f"{form} {schedule}"
    return form or schedule or SCHEMES.get(item.get("scheme"), {}).get("name", item.get("scheme", ""))


def code_link(consumer: dict) -> str:
    if consumer.get("url"):
        return consumer["url"]
    if consumer.get("repo") and consumer.get("path"):
        return f"https://github.com/{consumer['repo']}/blob/{consumer.get('ref') or 'HEAD'}/{consumer['path'].lstrip('/')}"
    return ""


def impact(touched: list[dict], registry: dict, *, effective: str = "") -> dict | None:
    """Registered items a change touched, who reads them, and one sentence saying so."""
    if not touched:
        return None
    index = Index(registry)
    items = []
    consumers: "OrderedDict[str, dict]" = OrderedDict()
    unregistered = []
    for entry in touched:
        matches = index.lookup(entry["code"])
        rule_ids = index.rule_consumers(entry["code"], matches[0]["scheme"] if matches else "")
        if not matches and not rule_ids:
            unregistered.append(entry["code"])
            continue
        records = matches or [{"code": entry["code"], "scheme": "", "jurisdiction": "", "regulator": "", "form": "", "schedule": "", "line": "",
                               "label": "", "aliases": [], "equivalents": [], "consumers": [], "owner": "", "note": ""}]
        for record in records:
            ids = list(dict.fromkeys(record["consumers"] + rule_ids))
            items.append({"code": record["code"], "scheme": record["scheme"], "jurisdiction": record["jurisdiction"], "form": record["form"],
                          "schedule": record["schedule"], "line": record["line"], "label": record["label"], "registered": bool(matches),
                          "equivalents": record["equivalents"], "change": entry["change"], "quarter": entry.get("quarter", ""),
                          "effective": entry.get("effective", ""), "consumers": ids, "owner": record["owner"]})
            for identifier in ids:
                consumer = registry["consumers"].get(identifier)
                if not consumer:
                    continue
                row = consumers.setdefault(identifier, {**consumer, "link": code_link(consumer), "codes": []})
                if record["code"] not in row["codes"]:
                    row["codes"].append(record["code"])
    if not items:
        return {"items": [], "consumers": [], "unregistered": unregistered[:MAX_LIST], "unregistered_count": len(unregistered), "sentence": ""}
    result = {"items": items[:500], "consumers": list(consumers.values())[:200], "unregistered": unregistered[:MAX_LIST],
              "unregistered_count": len(unregistered)}
    result["sentence"] = sentence(result, effective=effective)
    return result


def sentence(result: dict, *, effective: str = "") -> str:
    items = [item for item in result.get("items") or []]
    if not items:
        return ""
    groups: "OrderedDict[str, list[dict]]" = OrderedDict()
    for item in items:
        groups.setdefault(_where(item) or "registered items", []).append(item)
    fallback = _quarter_of(effective)
    parts = []
    for where, group in list(groups.items())[:3]:
        many = len(group) > 1
        changes = {item["change"] for item in group}
        quarters = sorted({item["quarter"] for item in group if item.get("quarter")}, key=_quarter_key)
        when = quarters[0] if quarters else fallback
        if not (changes <= {"retired", "removed"} or changes <= {"added", "added_version"} or changes == {"mentioned"}):
            when = fallback
        codes = ", ".join(item["code"] for item in group[:6]) + (", …" if len(group) > 6 else "")
        head = f"These {len(group)} fields" if many else "This field"
        if changes <= {"retired", "removed"}:
            parts.append(f"{head} in {where} {'are' if many else 'is'} retired" + (f" (last reported {when})" if when and "retired" in changes else "") + f": {codes}")
        elif changes <= {"added", "added_version"}:
            parts.append(f"{head} in {where} {'are' if many else 'is'} new" + (f" from {when}" if when else "") + f": {codes}")
        elif changes == {"mentioned"}:
            parts.append(f"{head} in {where} {'are' if many else 'is'} named in the change: {codes}")
        elif not changes & {"retired", "removed", "added", "added_version"}:
            when = quarters[0] if quarters else fallback
            parts.append(f"{head} in {where} {'change' if many else 'changes'}" + (f" from {when}" if when else "") + f": {codes}")
        else:
            # A mix: say what happens to each kind, each with its own quarter.
            clauses = []
            for label, kinds, verb_one, verb_many in (("retired", {"retired", "removed"}, "is retired", "are retired"),
                                                      ("new", {"added", "added_version"}, "is new", "are new"),
                                                      ("changed", None, "changes", "change")):
                members = [item for item in group if (item["change"] in kinds if kinds else item["change"] not in {"retired", "removed", "added", "added_version"})]
                if not members:
                    continue
                member_quarters = sorted({item["quarter"] for item in members if item.get("quarter")}, key=_quarter_key)
                member_when = member_quarters[0] if member_quarters else (fallback if label != "retired" else "")
                suffix = (f" (last reported {member_when})" if label == "retired" else f" from {member_when}") if member_when else ""
                names = ", ".join(item["code"] for item in members[:4]) + (", …" if len(members) > 4 else "")
                clauses.append(f"{names} {verb_many if len(members) > 1 else verb_one}{suffix}")
            parts.append(f"{head} in {where} change: " + "; ".join(clauses))
    if len(groups) > 3:
        parts.append(f"{len(groups) - 3} more forms or schedules are affected")
    text = ". ".join(parts) + "."
    consumers = result.get("consumers") or []
    if consumers:
        by_kind: "OrderedDict[str, list[str]]" = OrderedDict()
        for consumer in consumers:
            by_kind.setdefault(consumer["kind"], []).append(consumer["name"])
        bits = []
        for kind, names in by_kind.items():
            shown = ", ".join(names[:3]) + (", …" if len(names) > 3 else "")
            bits.append(f"{_plural(len(names), KIND_NOUNS.get(kind, KIND_NOUNS['other']))} ({shown})")
        reader = "It is" if len(items) == 1 else "They are"
        text += f" {reader} read by " + (", ".join(bits[:-1]) + " and " + bits[-1] if len(bits) > 1 else bits[0]) + "."
    else:
        text += " No consumer is mapped yet."
    equivalents = list(dict.fromkeys(equivalent for item in items for equivalent in item.get("equivalents") or []))
    if equivalents:
        text += " Equivalent items elsewhere: " + ", ".join(equivalents[:4]) + (", …" if len(equivalents) > 4 else "") + "."
    return text[:900]


def summary(result: dict | None) -> dict | None:
    """The part kept on the event and in alerts."""
    if not result or not result.get("items"):
        return None
    return {"sentence": result["sentence"], "items": len(result["items"]), "codes": [item["code"] for item in result["items"]][:12],
            "consumers": [consumer["id"] for consumer in result["consumers"]][:20]}


# --------------------------------------------------------------------------- CSV import


IMPORT_COLUMNS = {
    "code": ("code", "item", "item code", "mdrm", "field", "field name", "technical field name", "data point", "datapoint", "variable", "account"),
    "scheme": ("scheme", "code type", "identifier type"),
    "jurisdiction": ("jurisdiction", "country"),
    "regulator": ("regulator", "authority"),
    "form": ("form", "report", "return", "template"),
    "schedule": ("schedule", "table", "database table", "sheet"),
    "line": ("line", "line item", "report form line item", "row"),
    "label": ("label", "description", "name", "item description"),
    "consumer": ("consumer", "consumers", "asset", "assets", "used by", "pipeline", "table name", "target"),
    "consumer_kind": ("consumer kind", "asset kind", "kind", "type"),
    "repo": ("repo", "repository"),
    "path": ("path", "code path", "file"),
    "owner": ("owner", "team"),
}


def import_csv(text: str, registry_payload: dict | None = None) -> dict:
    """Merge a mapping spreadsheet (one row per item and consumer) into a registry payload."""
    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        raise ValueError("The CSV is empty")
    header = [re.sub(r"\s+", " ", cell.strip().lower()) for cell in rows[0]]
    columns = {}
    for key, names in IMPORT_COLUMNS.items():
        for index, name in enumerate(header):
            if name in names and index not in columns.values():
                columns[key] = index
                break
    if "code" not in columns:
        raise ValueError("No code column found (expected one of: " + ", ".join(IMPORT_COLUMNS["code"]) + ")")
    payload = json.loads(json.dumps(registry_payload or {"schema_version": 1}))
    payload.setdefault("schema_version", 1)
    payload.setdefault("consumers", [])
    payload.setdefault("items", [])
    consumers = {consumer["id"]: consumer for consumer in payload["consumers"]}
    items = {(item.get("scheme") or "OTHER", norm(item["code"]), norm(item.get("form", ""))): item for item in payload["items"]}

    def cell(row, key):
        index = columns.get(key)
        return row[index].strip() if index is not None and index < len(row) else ""

    for row in rows[1:]:
        code = cell(row, "code")
        if not code:
            continue
        scheme = cell(row, "scheme").upper().replace(" ", "")
        if not scheme:
            scheme = next((name for name in ("MDRM", "BIRD") if re.match(SCHEMES[name]["pattern"], code)), "OTHER")
        key = (scheme, norm(code), norm(cell(row, "form")))
        item = items.get(key)
        if item is None:
            item = {"code": code, "scheme": scheme}
            for field_name in ("jurisdiction", "regulator", "form", "schedule", "line", "label", "owner"):
                if cell(row, field_name):
                    item[field_name] = cell(row, field_name)
            items[key] = item
            payload["items"].append(item)
        for consumer_name in [part.strip() for part in re.split(r"[;\n]", cell(row, "consumer")) if part.strip()]:
            identifier = re.sub(r"[^A-Za-z0-9_.:-]+", "-", consumer_name).strip("-")[:80] or "consumer"
            if identifier not in consumers:
                kind = cell(row, "consumer_kind").lower()
                consumer = {"id": identifier, "kind": kind if kind in CONSUMER_KINDS else ("code" if cell(row, "path") else "table"),
                            "name": consumer_name}
                if cell(row, "repo"):
                    consumer["repo"] = cell(row, "repo")
                if cell(row, "path"):
                    consumer["path"] = cell(row, "path")
                if cell(row, "owner"):
                    consumer["owner"] = cell(row, "owner")
                consumers[identifier] = consumer
                payload["consumers"].append(consumer)
            item.setdefault("consumers", [])
            if identifier not in item["consumers"]:
                item["consumers"].append(identifier)
    validate(payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.registry", description="Validate or extend config/registry.json")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="Validate the registry (and lineage.json)")
    check.add_argument("--path", type=Path, default=REGISTRY_PATH)
    importer = sub.add_parser("import", help="Merge a CSV mapping into the registry")
    importer.add_argument("csv", type=Path)
    importer.add_argument("--path", type=Path, default=REGISTRY_PATH)
    importer.add_argument("--write", action="store_true", help="Write the merged registry (default: print it)")
    lookup = sub.add_parser("lookup", help="Show what reads a code")
    lookup.add_argument("code")
    lookup.add_argument("--path", type=Path, default=REGISTRY_PATH)
    args = parser.parse_args(argv)
    if args.command == "check":
        registry = load(args.path)
        print(f"OK: {len(registry['items'])} items, {len(registry['consumers'])} consumers, {len(registry['rules'])} rules")
        return 0
    if args.command == "import":
        current = json.loads(args.path.read_text(encoding="utf-8")) if args.path.exists() else {"schema_version": 1}
        merged = import_csv(args.csv.read_text(encoding="utf-8-sig"), current)
        text = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
        if args.write:
            args.path.write_text(text, encoding="utf-8")
            print(f"Wrote {args.path}: {len(merged['items'])} items, {len(merged['consumers'])} consumers")
        else:
            sys.stdout.write(text)
        return 0
    registry = load(args.path)
    result = impact([{"code": args.code, "change": "amended"}], registry)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
