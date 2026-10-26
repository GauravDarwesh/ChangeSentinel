"""Human review decisions on detected changes (data/reviews/ledger.json).

Detection and the AI's reading are only half of regulatory change management;
an examiner also asks who looked at a change, what they decided and why. The
dashboard's "Record review" opens a prefilled GitHub issue; the owner-only
"Change Review Decision" workflow passes the issue event here, and the decision
is committed to data/reviews/ledger.json:

* ``reviews`` holds the current decision per change (event id),
* ``log`` keeps every decision ever recorded, append-only, so a later decision
  never erases an earlier one.

Decisions: ``material`` (it changes what we must do), ``not_material`` (a
rationale is required), ``acknowledged`` (seen, assessment pending) and
``action_required`` (material, with work to track; an owner or ticket link is
expected). A decision names changes by id only; it never becomes a rule.

A reviewer can also report a change the monitor missed entirely (a
``missed-change`` request naming the monitor, the page, when it was seen and
what changed). Reports are kept in ``misses``, append-only, and count against
the monitor's recall (regmon/precision.py).
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from regmon.fsutil import atomic_write_text

MARKER = "<!-- changesentinel:change-review:v1 -->"
MISSED_MARKER = "<!-- changesentinel:missed-change:v1 -->"
TITLE_PREFIX = "[ChangeSentinel] Change review"
MAX_EVENTS = 50
MAX_TEXT = 600
EVENT_LINE = re.compile(r"^\s*[-*]\s+([0-9a-f]{64})(?:\s+\|\s+(\S+))?\s*$")
DECISIONS = {
    "material": "material", "not material": "not_material", "not_material": "not_material",
    "acknowledged": "acknowledged", "acknowledge": "acknowledged",
    "action required": "action_required", "action_required": "action_required",
}
LABELS = {"material": "Material", "not_material": "Not material", "acknowledged": "Acknowledged", "action_required": "Action required"}


class ReviewError(ValueError):
    pass


def ledger_path(data_dir: Path) -> Path:
    return Path(data_dir) / "reviews" / "ledger.json"


def load_ledger(data_dir: Path) -> dict:
    path = ledger_path(data_dir)
    if not path.exists():
        return {"schema_version": 1, "reviews": {}, "log": []}
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ReviewError(f"Refusing to overwrite an unreadable review ledger at {path}") from exc
    if not isinstance(ledger, dict) or ledger.get("schema_version") != 1 or not isinstance(ledger.get("reviews"), dict) or not isinstance(ledger.get("log"), list):
        raise ReviewError(f"Refusing to overwrite a review ledger with an unexpected shape at {path}")
    if not isinstance(ledger.get("misses", []), list):
        raise ReviewError(f"Refusing to overwrite a review ledger whose misses are not a list at {path}")
    return ledger


def parse_missed(body: str) -> dict:
    """A missed-change report: Monitor, URL, Seen on, What was missed."""
    text = str(body or "").replace("\r\n", "\n")
    if MISSED_MARKER not in text:
        raise ReviewError("The issue is not a missed-change report (marker missing)")
    fields = {"monitor": "", "url": "", "seen on": "", "what was missed": "", "evidence": ""}
    for line in text.split("\n"):
        key, separator, value = line.strip().partition(":")
        if separator and key.strip().lower() in fields:
            fields[key.strip().lower()] = _field(value)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", fields["monitor"]):
        raise ReviewError("The report needs the monitor id (Monitor: ...)")
    if fields["url"] and not re.match(r"^https?://\S+$", fields["url"]):
        raise ReviewError("URL must be a link (https://…)")
    if fields["evidence"] and not re.match(r"^https?://\S+$", fields["evidence"]):
        raise ReviewError("Evidence must be a link (https://…)")
    if fields["seen on"] and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fields["seen on"]):
        raise ReviewError("Seen on must be a date such as 2026-10-20")
    if len(fields["what was missed"]) < 10:
        raise ReviewError("Say what was missed (at least 10 characters)")
    return {"source_id": fields["monitor"], "url": fields["url"], "seen_on": fields["seen on"],
            "description": fields["what was missed"], "evidence": fields["evidence"]}


def _field(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return "" if text.lower() in {"", "(none)", "none", "-"} else text[:MAX_TEXT]


def parse_request(body: str) -> dict:
    text = str(body or "").replace("\r\n", "\n")
    if MARKER not in text:
        raise ReviewError("The issue is not a change review request (marker missing)")
    fields = {"decision": None, "rationale": "", "owner": "", "ticket": ""}
    events = []
    for line in text.split("\n"):
        stripped = line.strip()
        key, separator, value = stripped.partition(":")
        lowered = key.strip().lower()
        if lowered == "decision" and separator:
            verb = value.strip().lower()
            if verb not in DECISIONS:
                raise ReviewError(f"Unknown decision {verb!r}; use material, not material, acknowledged or action required")
            fields["decision"] = DECISIONS[verb]
        elif lowered in {"rationale", "owner", "ticket"} and separator:
            fields[lowered] = _field(value)
        else:
            match = EVENT_LINE.match(line)
            if match:
                events.append({"event_id": match.group(1), "url": match.group(2) or ""})
    if fields["decision"] is None:
        raise ReviewError("The request has no Decision line")
    if not events:
        raise ReviewError("The request lists no changes")
    if len(events) > MAX_EVENTS:
        raise ReviewError(f"At most {MAX_EVENTS} changes can be reviewed in one request")
    if len({event["event_id"] for event in events}) != len(events):
        raise ReviewError("The request lists a change more than once")
    if fields["decision"] == "not_material" and len(fields["rationale"]) < 10:
        raise ReviewError("A not-material decision needs a rationale of at least 10 characters")
    if fields["ticket"] and not re.match(r"^https?://\S+$", fields["ticket"]):
        raise ReviewError("Ticket must be a link (https://…)")
    return {**fields, "events": events}


def known_changes(data_dir: Path) -> dict[str, dict]:
    """Every change the record knows: page timelines plus the latest report."""
    known: dict[str, dict] = {}
    try:
        inventory = json.loads((Path(data_dir) / "latest.json").read_text(encoding="utf-8")).get("sources", {})
    except (OSError, ValueError):
        inventory = {}
    for group in inventory.values():
        for item in (group or {}).values() if isinstance(group, dict) else []:
            for change in (item or {}).get("change_history") or []:
                if isinstance(change, dict) and change.get("event_id"):
                    known[str(change["event_id"])] = {"event_type": change.get("event_type"), "url": item.get("canonical_url"),
                                                      "timestamp": change.get("timestamp")}
    try:
        report = json.loads((Path(data_dir) / "report.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        report = {}
    for event in report.get("events") or []:
        if isinstance(event, dict) and event.get("event_id"):
            known.setdefault(str(event["event_id"]), {"event_type": event.get("event_type"), "url": event.get("url"),
                                                      "timestamp": event.get("timestamp")})
    return known


def not_material_html_urls(data_dir: Path) -> set[str]:
    """Return URLs whose current review suppresses markup-only repeat events.

    ``HTML_SOURCE_CHANGED`` means the extracted regulatory text stayed stable
    while the source markup changed.  When an examiner records that such an
    event is not material, treating every later cosmetic markup revision as a
    fresh change only recreates the same false positive.  The current review is
    authoritative: a later material decision removes the suppression.
    """
    try:
        records = load_ledger(data_dir).get("reviews", {})
    except ReviewError:
        # A bad optional review ledger must never block regulatory monitoring.
        return set()
    return {
        str(record.get("url") or "").strip()
        for record in records.values()
        if isinstance(record, dict)
        and record.get("decision") == "not_material"
        and record.get("event_type") == "HTML_SOURCE_CHANGED"
        and str(record.get("url") or "").strip()
    }


def apply_event(event: dict, data_dir: Path, now: str | None = None) -> dict:
    issue = event.get("issue") or {}
    repository = event.get("repository") or {}
    actor = str((issue.get("user") or {}).get("login") or "")
    owner = str((repository.get("owner") or {}).get("login") or "")
    if not actor or actor != owner:
        raise ReviewError("Only the repository owner can record review decisions")
    if not str(issue.get("title") or "").startswith(TITLE_PREFIX):
        raise ReviewError("The issue title is not a change review request")
    if MISSED_MARKER in str(issue.get("body") or ""):
        return _apply_missed(issue, actor, data_dir, now)
    request = parse_request(issue.get("body") or "")
    known = known_changes(data_dir)
    for item in request["events"]:
        if item["event_id"] not in known:
            raise ReviewError(f"Change {item['event_id'][:12]}… is not in the committed record")
    ledger = load_ledger(data_dir)
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    reference = f"issue #{issue.get('number')}" if issue.get("number") else "issue"
    for item in request["events"]:
        facts = known[item["event_id"]]
        record = {
            "decision": request["decision"], "label": LABELS[request["decision"]],
            "rationale": request["rationale"], "owner": request["owner"], "ticket": request["ticket"],
            "reviewed_by": actor, "reviewed_at": now, "request": reference,
            "event_type": facts.get("event_type"), "url": facts.get("url"), "detected_at": facts.get("timestamp"),
        }
        ledger["reviews"][item["event_id"]] = record
        ledger["log"].append({"event_id": item["event_id"], **record})
    ledger["updated_at"] = now
    path = ledger_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(ledger, indent=2) + "\n")
    return {"decision": request["decision"], "label": LABELS[request["decision"]], "count": len(request["events"])}


def _apply_missed(issue: dict, actor: str, data_dir: Path, now: str | None) -> dict:
    report = parse_missed(issue.get("body") or "")
    try:
        sources = json.loads((Path(data_dir).parent / "config" / "sources.json").read_text(encoding="utf-8")).get("sources") or []
        known = {str(source.get("id")) for source in sources if isinstance(source, dict)}
    except (OSError, ValueError):
        known = set()
    if known and report["source_id"] not in known:
        raise ReviewError(f"Monitor {report['source_id']!r} is not in config/sources.json")
    ledger = load_ledger(data_dir)
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    reference = f"issue #{issue.get('number')}" if issue.get("number") else "issue"
    ledger.setdefault("misses", []).append({**report, "reported_by": actor, "reported_at": now, "request": reference})
    ledger["updated_at"] = now
    path = ledger_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(ledger, indent=2) + "\n")
    return {"decision": "missed", "label": "Missed change", "count": 1}


def main() -> None:
    parser = argparse.ArgumentParser(description="Record a change review decision from a GitHub issue event")
    parser.add_argument("--event", required=True)
    parser.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    parser.add_argument("--output")
    args = parser.parse_args()
    result = apply_event(json.loads(Path(args.event).read_text(encoding="utf-8")), Path(args.data_dir))
    if args.output:
        Path(args.output).write_text(json.dumps(result), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
