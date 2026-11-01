"""Copy review decisions recorded in the dashboard into data/reviews/ledger.json.

A signed-in team member records a decision in the dashboard; review-api saves
it at once in Supabase (change_review_decisions, append-only). This module is
the other half: the Review Sync workflow fetches the decisions not yet copied,
adds them to the committed ledger with the same rules as a GitHub review
request (regmon/reviews.py), commits, and only then marks them copied. A run
that fails before the commit leaves them pending for the next run, and a
decision already in the log (same app id) is never added twice.

    python -m regmon.review_sync fetch --output pending.json
    python -m regmon.review_sync apply --input pending.json --data-dir data --output done.json
    python -m regmon.review_sync ack --input done.json

The endpoint is REVIEW_API_URL (default: the project's review-api function) and
the shared secret is REVIEW_SYNC_TOKEN; GitHub never holds the database key.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from regmon.fsutil import atomic_write_text
from regmon.reviews import LABELS, ReviewError, known_changes, ledger_path, load_ledger

DEFAULT_ENDPOINT = "https://pysoukwmnwwgilkwafdy.supabase.co/functions/v1/review-api"
EVENT_ID = re.compile(r"^[0-9a-f]{64}$")
APP_ID = re.compile(r"^[0-9a-f-]{36}$")
MAX_TEXT = 600


def _text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:MAX_TEXT]


def _when(value: object) -> str:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def check(decision: dict) -> str:
    """Why a decision can't be recorded, or "" when it can."""
    if not APP_ID.match(str(decision.get("app_id") or "")):
        return "no dashboard id"
    if not EVENT_ID.match(str(decision.get("event_id") or "")):
        return "not a change id"
    if decision.get("decision") not in LABELS:
        return "unknown decision"
    if decision.get("decision") == "not_material" and len(_text(decision.get("rationale"))) < 10:
        return "not material without a rationale"
    ticket = _text(decision.get("ticket"))
    if ticket and not re.match(r"^https?://\S+$", ticket):
        return "ticket is not a link"
    if not _when(decision.get("reviewed_at")):
        return "no decision time"
    if not _text(decision.get("reviewed_by")):
        return "no reviewer"
    return ""


def apply_decisions(decisions: list[dict], data_dir: Path, now: str | None = None) -> dict:
    """Add pending dashboard decisions to the ledger. Returns what to acknowledge.

    ``done`` lists every decision the sync has finished with: recorded, already
    present, or refused with a note (a refused one would be refused again on
    every run). Nothing is written when there is nothing new.
    """
    ledger = load_ledger(data_dir)
    known = known_changes(data_dir)
    logged = {str(entry.get("app_id")) for entry in ledger["log"] if isinstance(entry, dict) and entry.get("app_id")}
    done: list[dict] = []
    added = 0
    for decision in sorted((d for d in decisions if isinstance(d, dict)), key=lambda d: _when(d.get("reviewed_at"))):
        app_id = str(decision.get("app_id") or "")
        problem = check(decision)
        if problem:
            if APP_ID.match(app_id):
                done.append({"id": app_id, "note": "refused: " + problem})
            continue
        if app_id in logged:
            done.append({"id": app_id, "note": "already in the ledger"})
            continue
        event_id = decision["event_id"]
        facts = known.get(event_id)
        if not facts:
            done.append({"id": app_id, "note": "refused: change is not in the committed record"})
            continue
        record = {
            "decision": decision["decision"], "label": LABELS[decision["decision"]],
            "rationale": _text(decision.get("rationale")), "owner": _text(decision.get("owner")), "ticket": _text(decision.get("ticket")),
            "reviewed_by": _text(decision.get("reviewed_by"))[:120], "reviewed_at": _when(decision["reviewed_at"]),
            "request": "dashboard " + app_id[:8], "via": "dashboard", "app_id": app_id,
            "event_type": facts.get("event_type"), "url": facts.get("url"), "detected_at": facts.get("timestamp"),
        }
        current = ledger["reviews"].get(event_id)
        # The current decision is the latest one by when it was made, whichever
        # way it arrived; the log keeps every one.
        if not isinstance(current, dict) or str(current.get("reviewed_at") or "") <= record["reviewed_at"]:
            ledger["reviews"][event_id] = record
        ledger["log"].append({"event_id": event_id, **record})
        logged.add(app_id)
        done.append({"id": app_id, "note": ""})
        added += 1
    if added:
        ledger["updated_at"] = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        path = ledger_path(data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, json.dumps(ledger, indent=2) + "\n")
    return {"added": added, "done": done}


def _post(payload: dict) -> dict:
    token = os.environ.get("REVIEW_SYNC_TOKEN", "")
    if len(token) < 24:
        raise ReviewError("REVIEW_SYNC_TOKEN is not set (at least 24 characters)")
    endpoint = os.environ.get("REVIEW_API_URL", DEFAULT_ENDPOINT)
    request = urllib.request.Request(endpoint, data=json.dumps({**payload, "token": token}).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed https endpoint
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--output", required=True)
    apply = sub.add_parser("apply")
    apply.add_argument("--input", required=True)
    apply.add_argument("--data-dir", default="data")
    apply.add_argument("--output", required=True)
    ack = sub.add_parser("ack")
    ack.add_argument("--input", required=True)
    args = parser.parse_args()
    if args.command == "fetch":
        decisions = _post({"action": "sync-pending"}).get("decisions") or []
        Path(args.output).write_text(json.dumps(decisions), encoding="utf-8")
        print(f"{len(decisions)} pending decision(s)")
    elif args.command == "apply":
        result = apply_decisions(json.loads(Path(args.input).read_text(encoding="utf-8")), Path(args.data_dir))
        Path(args.output).write_text(json.dumps(result), encoding="utf-8")
        print(json.dumps({"added": result["added"], "done": len(result["done"])}))
    else:
        done = json.loads(Path(args.input).read_text(encoding="utf-8")).get("done") or []
        if done:
            print(json.dumps(_post({"action": "sync-done", "done": done})))


if __name__ == "__main__":
    main()
