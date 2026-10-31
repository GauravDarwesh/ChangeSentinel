"""The entity profile (Phase 3.1): config/profile.json, the customer side of ASSESS.

It says who the reporting entity is and which reports it files:

* ``entities``: the legal entities (holding company, bank, branch), each with its kind
  (config/reports.json ``kinds``), parent, total assets and the attributes the report rules
  test (foreign offices, advanced approaches, category, trading assets and liabilities).
  A value left out is unknown, never assumed.
* ``reports``: reports the entity files (``files: true``) or doesn't (``files: false``),
  each optionally for one entity and with a note.
* ``reports_complete``: true when ``reports`` lists every report filed, so a report not
  listed is not filed.

The dashboard's profile editor opens a prefilled ``[ChangeSentinel] Profile update`` issue
holding the whole profile; profile-update.yml applies it (owner-opened issues only) through
``validate`` and commits it. regmon/applicability.py reads it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "config" / "profile.json"
SCHEMA_VERSION = 1
REQUEST_MARKER = "<!-- changesentinel:profile-update:v1 -->"
REQUEST_TITLE = "[ChangeSentinel] Profile update"
MAX_ENTITIES = 50
MAX_REPORTS = 200
MAX_TEXT = 200
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
CATEGORIES = ("I", "II", "III", "IV", "none")
CURRENCIES = ("USD", "CAD", "EUR", "GBP", "BRL", "COP", "INR", "BSD", "")
ABOUT = ("Customer side: who the reporting entity is and which reports it files. Edited from the dashboard "
         "(Registry → Profile) or by hand; regmon/applicability.py uses it to mark changes that apply, don't apply, or can't be decided.")


class ProfileError(ValueError):
    pass


def _text(value, where: str, limit: int = MAX_TEXT) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ProfileError(f"{where} must be text")
    text = " ".join(value.split())
    if len(text) > limit:
        raise ProfileError(f"{where} is longer than {limit} characters")
    return text


def _amount(value, where: str):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 1e16:
        raise ProfileError(f"{where} must be a non-negative amount in currency units (e.g. 48200000000)")
    return int(value) if float(value).is_integer() else float(value)


def _flag(value, where: str):
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ProfileError(f"{where} must be true, false or left out")
    return value


def _kinds(library_path: Path | None = None) -> dict:
    path = library_path or ROOT / "config" / "reports.json"
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("kinds") or {}
    except (OSError, ValueError):
        return {}


def validate(payload: object, *, kinds: dict | None = None) -> dict:
    """A clean profile, or ProfileError naming the first problem."""
    if not isinstance(payload, dict):
        raise ProfileError("The profile must be an object")
    if payload.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise ProfileError(f"Unsupported profile schema_version {payload.get('schema_version')}")
    extra = set(payload) - {"schema_version", "about", "updated_at", "entities", "reports", "reports_complete"}
    if extra:
        raise ProfileError(f"Unknown profile keys: {', '.join(sorted(extra))}")
    kinds = kinds if kinds is not None else _kinds()
    entities_in = payload.get("entities") or []
    if not isinstance(entities_in, list) or len(entities_in) > MAX_ENTITIES:
        raise ProfileError(f"entities must be a list of at most {MAX_ENTITIES}")
    entities = []
    ids = set()
    for index, raw in enumerate(entities_in):
        where = f"entities[{index}]"
        if not isinstance(raw, dict):
            raise ProfileError(f"{where} must be an object")
        extra = set(raw) - {"id", "name", "kind", "parent", "total_assets", "currency", "as_of", "foreign_offices",
                            "advanced_approaches", "category", "trading", "note"}
        if extra:
            raise ProfileError(f"{where} has unknown keys: {', '.join(sorted(extra))}")
        identifier = _text(raw.get("id"), f"{where}.id", 40)
        if not ID.match(identifier):
            raise ProfileError(f"{where}.id must be lower-case letters, digits and hyphens")
        if identifier in ids:
            raise ProfileError(f"{where}.id {identifier} is used twice")
        ids.add(identifier)
        kind = _text(raw.get("kind"), f"{where}.kind", 40)
        if kinds and kind not in kinds:
            raise ProfileError(f"{where}.kind must be one of {', '.join(kinds)}")
        category = _text(raw.get("category"), f"{where}.category", 8)
        if category and category not in CATEGORIES:
            raise ProfileError(f"{where}.category must be one of {', '.join(CATEGORIES)}")
        currency = _text(raw.get("currency"), f"{where}.currency", 3).upper()
        if currency not in CURRENCIES:
            raise ProfileError(f"{where}.currency must be one of {', '.join(c for c in CURRENCIES if c)}")
        as_of = _text(raw.get("as_of"), f"{where}.as_of", 10)
        if as_of and not re.match(r"^\d{4}-\d\d-\d\d$", as_of):
            raise ProfileError(f"{where}.as_of must be a date (YYYY-MM-DD)")
        entity = {"id": identifier, "name": _text(raw.get("name"), f"{where}.name") or identifier, "kind": kind}
        for key in ("parent", "note"):
            value = _text(raw.get(key), f"{where}.{key}")
            if value:
                entity[key] = value
        for key in ("total_assets", "trading"):
            value = _amount(raw.get(key), f"{where}.{key}")
            if value is not None:
                entity[key] = value
        for key in ("foreign_offices", "advanced_approaches"):
            value = _flag(raw.get(key), f"{where}.{key}")
            if value is not None:
                entity[key] = value
        if category:
            entity["category"] = category
        if currency:
            entity["currency"] = currency
        if as_of:
            entity["as_of"] = as_of
        entities.append(entity)
    for entity in entities:
        if entity.get("parent") and entity["parent"] not in ids:
            raise ProfileError(f"Entity {entity['id']} names parent {entity['parent']}, which is not in the profile")
        if entity.get("parent") == entity["id"]:
            raise ProfileError(f"Entity {entity['id']} can't be its own parent")
    reports_in = payload.get("reports") or []
    if not isinstance(reports_in, list) or len(reports_in) > MAX_REPORTS:
        raise ProfileError(f"reports must be a list of at most {MAX_REPORTS}")
    reports = []
    seen = set()
    for index, raw in enumerate(reports_in):
        where = f"reports[{index}]"
        if not isinstance(raw, dict):
            raise ProfileError(f"{where} must be an object")
        extra = set(raw) - {"form", "entity", "files", "note"}
        if extra:
            raise ProfileError(f"{where} has unknown keys: {', '.join(sorted(extra))}")
        form = _text(raw.get("form"), f"{where}.form", 40)
        if not form:
            raise ProfileError(f"{where}.form is required")
        entity = _text(raw.get("entity"), f"{where}.entity", 40)
        if entity and entity not in ids:
            raise ProfileError(f"{where}.entity {entity} is not in the profile")
        key = (form, entity)
        if key in seen:
            raise ProfileError(f"{where}: {form}" + (f" for {entity}" if entity else "") + " is listed twice")
        seen.add(key)
        files = raw.get("files", True)
        if not isinstance(files, bool):
            raise ProfileError(f"{where}.files must be true or false")
        report = {"form": form, "files": files}
        if entity:
            report["entity"] = entity
        note = _text(raw.get("note"), f"{where}.note")
        if note:
            report["note"] = note
        reports.append(report)
    complete = payload.get("reports_complete", False)
    if not isinstance(complete, bool):
        raise ProfileError("reports_complete must be true or false")
    out = {"schema_version": SCHEMA_VERSION, "about": ABOUT, "entities": entities, "reports": reports, "reports_complete": complete}
    if isinstance(payload.get("updated_at"), str) and payload["updated_at"]:
        out["updated_at"] = payload["updated_at"][:40]
    return out


def empty() -> dict:
    return {"schema_version": SCHEMA_VERSION, "about": ABOUT, "entities": [], "reports": [], "reports_complete": False}


def load(path: Path = PROFILE_PATH) -> dict:
    if not path.exists():
        return empty()
    return validate(json.loads(path.read_text(encoding="utf-8")), kinds=_kinds(path.parent / "reports.json"))


def dumps(profile: dict) -> str:
    return json.dumps(profile, indent=2, ensure_ascii=False) + "\n"


def parse_request_body(body: str) -> dict:
    text = str(body or "")
    if REQUEST_MARKER not in text:
        raise ProfileError("The issue is not a profile update from the dashboard")
    match = re.search(r"```json\s*\n(.*?)\n```", text, re.S)
    if not match:
        raise ProfileError("The request has no ```json block")
    try:
        request = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ProfileError(f"The request JSON does not parse: {exc.msg} (line {exc.lineno})") from None
    if not isinstance(request, dict) or request.get("version") != 1 or not isinstance(request.get("profile"), dict):
        raise ProfileError("The request must be an object with version 1 and a profile")
    extra = set(request) - {"version", "profile", "summary"}
    if extra:
        raise ProfileError(f"The request has unknown keys: {', '.join(sorted(extra))}")
    return request


def describe(profile: dict) -> str:
    entities = profile["entities"]
    filing = [row["form"] for row in profile["reports"] if row["files"]]
    parts = [f"{len(entities)} entit{'y' if len(entities) == 1 else 'ies'}",
             f"{len(dict.fromkeys(filing))} report{'s' if len(set(filing)) != 1 else ''} filed"]
    if profile["reports_complete"]:
        parts.append("list complete")
    return ", ".join(parts)


def apply_event(event: dict, *, root: Path = ROOT, now: str | None = None) -> dict:
    """Apply an owner-opened profile-update issue to config/profile.json (the whole profile)."""
    issue = event.get("issue") or {}
    actor = str((issue.get("user") or {}).get("login") or "")
    owner = str(((event.get("repository") or {}).get("owner") or {}).get("login") or "")
    if not actor or actor != owner:
        raise ProfileError("Only the repository owner can change the profile")
    if not str(issue.get("title") or "").startswith(REQUEST_TITLE):
        raise ProfileError("The issue title is not a profile update request")
    request = parse_request_body(issue.get("body") or "")
    path = root / "config" / "profile.json"
    current = load(path)
    incoming = validate({**request["profile"], "updated_at": ""}, kinds=_kinds(root / "config" / "reports.json"))
    incoming.pop("updated_at", None)
    unchanged = {key: value for key, value in current.items() if key != "updated_at"} == incoming
    if not unchanged:
        incoming["updated_at"] = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
        path.write_text(dumps(incoming), encoding="utf-8")
    profile = current if unchanged else incoming
    return {"summary": ("no change; " if unchanged else "") + describe(profile), "changed": not unchanged}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.profile", description="Validate or update config/profile.json")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="Validate the profile")
    applier = sub.add_parser("apply-issue", help="Apply a dashboard profile-update issue (GitHub event JSON)")
    applier.add_argument("--event", type=Path, required=True)
    applier.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.command == "check":
        try:
            profile = load()
        except (ProfileError, ValueError) as exc:
            print(f"Invalid: {exc}", file=sys.stderr)
            return 1
        print("OK: " + describe(profile))
        return 0
    try:
        result = apply_event(json.loads(args.event.read_text(encoding="utf-8")))
    except ProfileError as exc:
        print(f"Rejected: {exc}", file=sys.stderr)
        return 1
    if args.output:
        args.output.write_text(json.dumps(result), encoding="utf-8")
    print(result["summary"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
