"""Suggested updates (Phase 4.4): what to change in your checks, drafted from the spec diff.

For every change where Your checks (regmon/controls.py) finds a rule retired but still
implemented, a rule you implement that changed, or a new rule with no check, this writes
``data/suggestions/<event_id>.json``:

* **Briefs, deterministic, always.** Per rule: the finding, the checks it concerns (from the
  registry), the regulator's own before/after text for each changed column (rule
  description, formula, severity, dates), the quarter it takes effect, and what to do in
  one sentence. No model is involved.
* **Drafts, AI, optional.** One call per change asks a free OpenRouter model to draft the
  updated check for each rule, in the language its check's path suggests (SQL, Python,
  ...) or as pseudo-code. Only free models are ever called: ``openrouter/free`` or a model
  id ending in ``:free`` (OPENROUTER_MODEL); anything else is refused, not billed. When the
  free route is down the change keeps its briefs and the draft is retried on a later scan.

A draft is never applied to anything. It is labelled as unreviewed until the owner approves
or rejects it from the dashboard, which opens a ``[ChangeSentinel] Suggestion decision``
issue; suggestion-review.yml records the decision in data/reviews/suggestions.json (beside the
change review ledger, outside the scan's state path; owner-opened issues only), with the
draft's hash so a regenerated draft shows as undecided.

Briefs are rebuilt when the registry's implements entries or the change's facts change;
drafts are kept while the rules and checks they were written for are the same.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import controls
from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = ROOT / "config"
DIRECTORY = "suggestions"
SCHEMA_VERSION = 1
FINDINGS = ("retired_in_use", "differs", "missing")
MAX_RULES_PER_CHANGE = 12
MAX_AI_CHANGES_PER_RUN = 3
MAX_TEXT = 1500
MAX_DRAFT = 4000
ROLES = ("logic", "formula", "description", "severity", "etype", "start", "end", "effective", "message", "comments", "line_item", "field")
REQUEST_MARKER = "<!-- changesentinel:suggestion-decision:v1 -->"
REQUEST_TITLE = "[ChangeSentinel] Suggestion decision"
DECISIONS = ("approved", "rejected")
DECISIONS_FILE = "suggestions.json"
LANGUAGES = {".sql": "SQL", ".py": "Python", ".sas": "SAS", ".r": "R", ".scala": "Scala", ".java": "Java", ".js": "JavaScript", ".ts": "TypeScript",
             ".yml": "YAML", ".yaml": "YAML", ".xlsx": "spreadsheet formula", ".xls": "spreadsheet formula", ".dax": "DAX"}
ACTIONS = {
    "retired_in_use": "Retire or disable {checks} for {rule}{when}; the regulator has {change} it.",
    "differs": "Update {checks} so {rule} tests what the regulator now states{when}.",
    "missing": "Add a check for the new rule {rule}{when}, or record that you don't implement it.",
}
SYSTEM_PROMPT = (
    "You draft updates to a bank's internal regulatory-reporting validation checks. For each rule you are given the "
    "regulator's text before and after a change (or the new rule), and the internal check that implements it. Write the "
    "updated check in the language given, as a short self-contained snippet a reporting engineer would adapt, using the "
    "regulator's own item codes and thresholds exactly as written. Never invent codes, thresholds or dates that are not in "
    "the rule text; if the text is ambiguous, say so in notes. Return only a JSON object: "
    '{"drafts": [{"id": "<rule id as given>", "language": "<language>", "draft": "<code or pseudo-code>", "notes": "<one sentence>"}]}.'
)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _short(value, limit: int = MAX_TEXT) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def free_model(model: str) -> bool:
    """Only free OpenRouter models: the free router, or a model id ending in ':free'."""
    model = str(model or "").strip()
    return model == "openrouter/free" or model.endswith(":free")


def language_for(consumer: dict) -> str:
    path = str(consumer.get("path") or "").split(":", 1)[0].lower()
    for suffix, language in LANGUAGES.items():
        if path.endswith(suffix):
            return language
    system = str(consumer.get("system") or "").lower()
    if any(word in system for word in ("snowflake", "teradata", "oracle", "postgres", "sql", "dbt", "redshift", "bigquery")):
        return "SQL"
    if "axiom" in system:
        return "AxiomSL rule (pseudo-code)"
    return "pseudo-code"


def rule_details(evidence: dict) -> dict[str, dict]:
    """Rule id (normalised) → {table, before/after columns or values} from the structured spec diff."""
    out: dict[str, dict] = {}
    for table in (evidence.get("spec_diff") or {}).get("tables") or []:
        if table.get("kind") != "rules":
            continue
        for change in table.get("changes") or []:
            identifier = controls.norm(change.get("id") or "")
            if not identifier or identifier in out:
                continue
            columns = []
            for column in change.get("columns") or []:
                if not isinstance(column, dict) or column.get("kind") == "cosmetic":
                    continue
                columns.append({"column": _short(column.get("column"), 80), "role": str(column.get("role") or ""),
                                "before": _short(column.get("before")), "after": _short(column.get("after"))})
            values = {str(key): _short(value) for key, value in (change.get("values") or {}).items() if value not in (None, "")}
            out[identifier] = {"table": _short(table.get("name"), 120), "columns": columns[:12], "values": dict(list(values.items())[:12]),
                               "declared": _short(change.get("declared"), 300), "note": _short(change.get("note"), 300)}
    return out


def briefs(facts: dict, registry: dict, index: dict | None, evidence: dict) -> list[dict]:
    """One brief per rule a change asks you to act on, for the checks that implement it."""
    result = controls.findings(facts, registry, index)
    if not result:
        return []
    consumers = {str(consumer.get("id")): consumer for consumer in (registry or {}).get("consumers") or [] if isinstance(consumer, dict)}
    details = rule_details(evidence)
    out = []
    for finding in FINDINGS:
        for row in result.get(finding) or []:
            ids = row.get("consumers") or []
            checks = [{"id": key, "name": str((consumers.get(key) or {}).get("name") or key), "kind": str((consumers.get(key) or {}).get("kind") or ""),
                       "owner": str((consumers.get(key) or {}).get("owner") or ""), "system": str((consumers.get(key) or {}).get("system") or ""),
                       "path": str((consumers.get(key) or {}).get("path") or ""), "language": language_for(consumers.get(key) or {})} for key in ids]
            names = ", ".join(check["name"] for check in checks) or "your checks"
            when = f" from {row['quarter']}" if row.get("quarter") else ""
            brief = {"id": row["id"], "finding": finding, "change": row["change"], "level": row.get("level") or "", "quarter": row.get("quarter") or "",
                     "checks": checks,
                     "action": ACTIONS[finding].format(checks=names, rule=row["id"], when=when,
                                                       change=controls.CHANGE_WORDS.get(row["change"], row["change"]))}
            detail = details.get(controls.norm(row["id"]))
            if detail:
                brief.update({key: value for key, value in detail.items() if value})
            out.append(brief)
    return out


def _prompt(event: dict, rules: list[dict]) -> str:
    lines = [f"Form(s): {', '.join(event.get('forms') or []) or 'not stated'}", f"Regulator file: {event.get('url') or ''}", ""]
    for brief in rules:
        check = brief["checks"][0] if brief["checks"] else {"name": "a new check", "language": "pseudo-code"}
        lines.append(f"Rule {brief['id']} ({controls.CHANGE_WORDS.get(brief['change'], brief['change'])}"
                     + (f", effective {brief['quarter']}" if brief.get("quarter") else "") + ")")
        lines.append(f"  Internal check: {check['name']}; language: {check['language']}")
        for column in brief.get("columns") or []:
            lines.append(f"  {column['column']} before: {column['before']}")
            lines.append(f"  {column['column']} after: {column['after']}")
        for key, value in (brief.get("values") or {}).items():
            lines.append(f"  {key}: {value}")
        lines.append("")
    return "\n".join(lines)


def draft(event: dict, rules: list[dict], *, model: str | None = None, post=None) -> dict:
    """Ask a free model for one draft per rule. Never raises; returns {status, drafts, model, ...}."""
    model = model or os.getenv("OPENROUTER_MODEL", "openrouter/free")
    if not free_model(model):
        return {"status": "skipped", "reason": f"Only free OpenRouter models are used; {model!r} is not one", "model": model}
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        return {"status": "skipped", "reason": "OPENROUTER_API_KEY is not configured", "model": model}
    wanted = [brief for brief in rules if brief["finding"] in ("differs", "missing")][:MAX_RULES_PER_CHANGE]
    if not wanted:
        return {"status": "skipped", "reason": "Nothing to draft: retired rules only need their checks retired", "model": model}
    if post is None:
        import requests

        post = requests.post
    payload = {"model": model, "temperature": 0, "response_format": {"type": "json_object"},
               "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": _prompt(event, wanted)}]}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
               "HTTP-Referer": "https://github.com/GauravDarwesh/ChangeSentinel", "X-Title": "ChangeSentinel suggested updates"}
    try:
        response = post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload, timeout=90)
        if getattr(response, "status_code", 200) >= 400:
            return {"status": "unavailable", "reason": f"OpenRouter returned HTTP {response.status_code}", "model": model}
        body = response.json()
        content = body["choices"][0]["message"].get("content") or ""
        provider_model = str(body.get("model") or "")
    except Exception as exc:  # the free route is often busy; the briefs stand on their own
        return {"status": "unavailable", "reason": f"{type(exc).__name__}: {str(exc)[:200]}", "model": model}
    if provider_model and not free_model(provider_model) and model != "openrouter/free":
        return {"status": "skipped", "reason": f"The provider answered with a non-free model ({provider_model}); discarded", "model": model}
    match = re.search(r"\{.*\}", content, re.S)
    try:
        parsed = json.loads(match.group(0)) if match else None
    except ValueError:
        parsed = None
    asked = {controls.norm(brief["id"]): brief["id"] for brief in wanted}
    drafts = {}
    rows = parsed.get("drafts") if isinstance(parsed, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        identifier = asked.get(controls.norm(row.get("id") or ""))
        text = str(row.get("draft") or "").strip()
        if not identifier or not text or identifier in drafts:
            continue
        clean = {"language": _short(row.get("language"), 60), "draft": text[:MAX_DRAFT], "notes": _short(row.get("notes"), 400)}
        clean["hash"] = _hash([identifier, clean["draft"]])
        drafts[identifier] = clean
    if not drafts:
        return {"status": "invalid", "reason": "The model returned no usable draft", "model": model, "provider_model": provider_model}
    return {"status": "ok", "model": model, "provider_model": provider_model, "generated_at": _now(), "drafts": drafts,
            "rules": sorted(drafts), "missing": sorted(set(asked.values()) - set(drafts))}


def _fingerprint(event_facts: dict, rule_briefs: list[dict]) -> str:
    return _hash({"rules": event_facts.get("rules") or [], "briefs": [[brief["id"], brief["finding"], [check["id"] for check in brief["checks"]],
                                                                       [check["language"] for check in brief["checks"]]] for brief in rule_briefs]})


def build(data_dir: Path = DATA, config_dir: Path = CONFIG, *, ai: bool = True, now: str | None = None, post=None) -> dict:
    """Write briefs for every change that asks you to act, and drafts for up to three of them per run."""
    now = now or _now()
    registry = _read_json(config_dir / "registry.json", {}) or {}
    folder = data_dir / DIRECTORY
    if not controls.implemented(registry):
        return {"changes": 0, "written": 0, "drafted": 0}
    facts = (_read_json(data_dir / "change-facts.json", {}) or {}).get("events") or {}
    index = controls.load_index(data_dir)
    latest = (_read_json(data_dir / "latest.json", {}) or {}).get("sources") or {}
    locations = {}
    for records in latest.values():
        for record in (records or {}).values():
            for entry in record.get("change_history") or []:
                if entry.get("event_id") and entry.get("evidence_location"):
                    locations[entry["event_id"]] = (entry["evidence_location"], record.get("canonical_url") or "")
    summary = (_read_json(folder / "index.json", {}) or {}).get("changes") or {}
    written = drafted = 0
    pending_ai = []
    keep = set()
    for event_id, event_facts in sorted(facts.items(), key=lambda item: str(item[1].get("at") or ""), reverse=True):
        if not event_facts.get("rules"):
            continue
        location, url = locations.get(event_id, ("", ""))
        evidence = _read_json(data_dir / location[len("data/"):], {}) if location.startswith("data/evidence/") else {}
        rule_briefs = briefs(event_facts, registry, index, evidence)
        if not rule_briefs:
            continue
        keep.add(event_id)
        fingerprint = _fingerprint(event_facts, rule_briefs)
        path = folder / f"{event_id}.json"
        current = _read_json(path, {}) or {}
        ai_part = current.get("ai") if current.get("fingerprint") == fingerprint else None
        doc = {"schema_version": SCHEMA_VERSION, "event_id": event_id, "at": event_facts.get("at") or "", "url": url,
               "forms": [row.get("form") for row in event_facts.get("forms") or [] if row.get("form")],
               "fingerprint": fingerprint, "briefs": rule_briefs,
               "ai": ai_part or {"status": "pending", "reason": "Not drafted yet"}}
        if doc != {key: value for key, value in current.items() if key != "updated_at"}:
            doc["updated_at"] = now
            folder.mkdir(parents=True, exist_ok=True)
            atomic_write_text(path, json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
            written += 1
        else:
            doc = current
        if (doc["ai"].get("status") in ("pending", "unavailable", "invalid")) and any(brief["finding"] in ("differs", "missing") for brief in rule_briefs):
            pending_ai.append((event_id, doc))
        summary[event_id] = {"at": doc["at"], "rules": len(rule_briefs), "findings": {finding: sum(1 for brief in rule_briefs if brief["finding"] == finding) for finding in FINDINGS},
                             "ai": doc["ai"].get("status")}
    if ai:
        for event_id, doc in pending_ai[:MAX_AI_CHANGES_PER_RUN]:
            result = draft(doc, doc["briefs"], post=post)
            result["attempted_at"] = now
            if result["status"] == "skipped" and doc["ai"].get("status") == "pending":
                result["status"] = "pending"  # no key or a paid model configured: try again when that changes
            doc["ai"] = result
            doc["updated_at"] = now
            atomic_write_text(folder / f"{event_id}.json", json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
            summary[event_id]["ai"] = result["status"]
            drafted += int(result["status"] == "ok")
    for event_id in list(summary):
        if event_id not in keep:
            summary.pop(event_id)
            stale = folder / f"{event_id}.json"
            if stale.exists():
                stale.unlink()  # the registry no longer implements anything this change touches
    if keep or (folder / "index.json").exists():
        folder.mkdir(parents=True, exist_ok=True)
        text = json.dumps({"schema_version": SCHEMA_VERSION, "changes": dict(sorted(summary.items()))}, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        if _read_json(folder / "index.json", None) != json.loads(text):
            atomic_write_text(folder / "index.json", text)
    return {"changes": len(keep), "written": written, "drafted": drafted}


# --------------------------------------------------------------------------- decisions


class DecisionError(ValueError):
    pass


def parse_request_body(body: str) -> dict:
    text = str(body or "")
    if REQUEST_MARKER not in text:
        raise DecisionError("The issue is not a suggestion decision from the dashboard")
    match = re.search(r"```json\s*\n(.*?)\n```", text, re.S)
    if not match:
        raise DecisionError("The request has no ```json block")
    try:
        request = json.loads(match.group(1))
    except ValueError as exc:
        raise DecisionError(f"The request JSON does not parse: {exc}") from None
    if not isinstance(request, dict) or request.get("version") != 1 or set(request) - {"version", "event_id", "rule", "decision", "draft_hash", "note"}:
        raise DecisionError("The request must be {version: 1, event_id, rule, decision, draft_hash, note}")
    if request.get("decision") not in DECISIONS:
        raise DecisionError("decision must be approved or rejected")
    if not re.fullmatch(r"[0-9a-f]{64}", str(request.get("event_id") or "")):
        raise DecisionError("event_id must be a change's 64-character id")
    return request


def apply_event(event: dict, *, data_dir: Path = DATA, now: str | None = None) -> dict:
    """Record an owner-opened decision on a suggested update in data/reviews/suggestions.json."""
    issue = event.get("issue") or {}
    actor = str((issue.get("user") or {}).get("login") or "")
    owner = str(((event.get("repository") or {}).get("owner") or {}).get("login") or "")
    if not actor or actor != owner:
        raise DecisionError("Only the repository owner can decide on a suggested update")
    if not str(issue.get("title") or "").startswith(REQUEST_TITLE):
        raise DecisionError("The issue title is not a suggestion decision")
    request = parse_request_body(issue.get("body") or "")
    doc = _read_json(data_dir / DIRECTORY / f"{request['event_id']}.json", None)
    if not isinstance(doc, dict):
        raise DecisionError("There is no suggested update for that change")
    rule = str(request.get("rule") or "")
    brief = next((row for row in doc.get("briefs") or [] if controls.norm(row["id"]) == controls.norm(rule)), None)
    if brief is None:
        raise DecisionError(f"The suggested update has no rule {rule!r}")
    drafted = ((doc.get("ai") or {}).get("drafts") or {}).get(brief["id"]) or {}
    draft_hash = str(request.get("draft_hash") or "")
    if draft_hash and draft_hash != drafted.get("hash"):
        raise DecisionError("The draft changed since the request was opened; open it again from the dashboard")
    path = data_dir / "reviews" / DECISIONS_FILE
    ledger = _read_json(path, {}) or {}
    ledger.setdefault("schema_version", SCHEMA_VERSION)
    decisions = ledger.setdefault("decisions", {})
    record = {"decision": request["decision"], "at": now or _now(), "by": actor, "issue": issue.get("number"),
              "draft_hash": draft_hash or None, "note": _short(request.get("note"), 500)}
    decisions.setdefault(request["event_id"], {})[brief["id"]] = record
    ledger.setdefault("log", []).append({"event_id": request["event_id"], "rule": brief["id"], **record})
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(ledger, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    return {"summary": f"{request['decision']} the suggested update for {brief['id']}", "event_id": request["event_id"], "rule": brief["id"]}


def validate(data_dir: Path = DATA) -> list[str]:
    folder = data_dir / DIRECTORY
    if not folder.exists():
        return []
    errors = []
    index = _read_json(folder / "index.json", None)
    if not isinstance(index, dict) or not isinstance(index.get("changes"), dict):
        return [f"data/{DIRECTORY}/index.json is missing or malformed"]
    for event_id in index["changes"]:
        doc = _read_json(folder / f"{event_id}.json", None)
        if not isinstance(doc, dict) or doc.get("event_id") != event_id or not isinstance(doc.get("briefs"), list):
            errors.append(f"data/{DIRECTORY}/{event_id}.json is missing or malformed")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.suggestions", description="Suggested updates to your checks")
    sub = parser.add_subparsers(dest="command", required=True)
    builder = sub.add_parser("build", help="Write briefs, and drafts with a free model")
    builder.add_argument("--no-ai", action="store_true")
    applier = sub.add_parser("apply-issue", help="Record a dashboard suggestion decision (GitHub event JSON)")
    applier.add_argument("--event", type=Path, required=True)
    applier.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.command == "build":
        print(json.dumps(build(DATA, CONFIG, ai=not args.no_ai)))
        return 0
    try:
        result = apply_event(json.loads(args.event.read_text(encoding="utf-8")))
    except DecisionError as exc:
        print(f"Rejected: {exc}", file=sys.stderr)
        return 1
    if args.output:
        args.output.write_text(json.dumps(result), encoding="utf-8")
    print(result["summary"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
