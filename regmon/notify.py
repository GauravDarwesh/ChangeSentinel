"""Publish regulatory monitoring events to ntfy with a durable retry outbox."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE_PATH = DATA / "notifications.json"
OUTBOX_PATH = DATA / "notification-outbox.json"
DEFAULT_TOPIC = ""
DEFAULT_SERVER = "https://ntfy.sh"


def _load_state_mapping(path: Path, key: str) -> dict:
    """Load durable notification state without silently resetting corrupted files."""
    if not path.exists():
        return {key: {}, "updated_at": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeError) as exc:
        raise RuntimeError(
            f"Refusing to reset notification state at {path}: file is unreadable or invalid JSON"
        ) from exc
    if not isinstance(value, dict) or not isinstance(value.get(key), dict):
        raise RuntimeError(
            f"Refusing to reset notification state at {path}: expected an object containing '{key}'"
        )
    for event_id, payload in value[key].items():
        if not isinstance(event_id, str) or not event_id.strip() or not isinstance(payload, dict):
            raise RuntimeError(
                f"Refusing to reset notification state at {path}: invalid entry in '{key}'"
            )
        if key == "pending_events" and payload.get("event_id") != event_id:
            raise RuntimeError(
                f"Refusing to process notification outbox at {path}: event ID does not match its key"
            )
    return value


def _atomic_write_json(path: Path, value: dict) -> None:
    """Durably write JSON via a same-directory temporary file and atomic replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except Exception:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise


def _content(value: dict) -> dict:
    """The durable content of a state file, ignoring its write timestamp."""
    return {key: item for key, item in json.loads(json.dumps(value)).items() if key != "updated_at"}


def _save_if_changed(path: Path, value: dict) -> bool:
    """Write only when the content differs from what is already on disk.

    Bumping updated_at on every run produced a timestamp-only "Record
    notification deliveries" commit (and a Pages deploy) after every scan, even
    when nothing was queued or sent. An unchanged file keeps its timestamp.
    """
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeError):
            existing = None
        if isinstance(existing, dict) and _content(existing) == _content(value):
            value["updated_at"] = existing.get("updated_at")
            return False
    value["updated_at"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(path, value)
    return True


def load_state(path: Path = STATE_PATH) -> dict:
    return _load_state_mapping(path, "sent_events")


def save_state(state: dict, path: Path = STATE_PATH) -> bool:
    return _save_if_changed(path, state)


def load_outbox(path: Path = OUTBOX_PATH) -> dict:
    return _load_state_mapping(path, "pending_events")


def save_outbox(outbox: dict, path: Path = OUTBOX_PATH) -> bool:
    return _save_if_changed(path, outbox)


AI_VARIANTS = {"ai", "ai_irrelevant"}


def _follow_up(notification: dict, key: str) -> dict:
    """An AI assessment for a change whose generic alert was already delivered."""
    relevant = notification.get("variant") == "ai"
    return {
        **notification,
        "event_id": key + "#ai",
        "source_event_id": key,
        "kind": "AI_ASSESSMENT",
        "topic": ("AI assessment: " + str(notification.get("topic") or "change reviewed")) if relevant
        else "AI assessment: not relevant",
        "priority": 4 if relevant else 2,
    }


def enqueue_notifications(outbox: dict, candidates: list[dict], sent_events: dict) -> dict:
    """Add new candidates without dropping previously failed deliveries.

    When AI analysis completes after a generic "Technical change detected" alert
    for the same event was already delivered (because AI was deferred, invalid
    or unavailable at the time), the assessment is queued as a follow-up instead
    of being dropped as a duplicate. A generic alert still waiting in the outbox
    is replaced by the AI version.
    """
    pending = outbox.setdefault("pending_events", {})
    for notification in candidates:
        event_id = str(notification.get("event_id") or "").strip()
        if not event_id:
            continue
        variant = notification.get("variant")
        if event_id in sent_events:
            delivered = sent_events[event_id]
            if variant in AI_VARIANTS and isinstance(delivered, dict) and delivered.get("variant") == "generic":
                follow_up = _follow_up(notification, event_id)
                if follow_up["event_id"] not in sent_events:
                    pending.setdefault(follow_up["event_id"], follow_up)
            continue
        if variant == "ai_irrelevant":
            # Only meaningful as a follow-up to a delivered generic alert.
            queued = pending.get(event_id)
            if isinstance(queued, dict) and queued.get("variant") == "generic":
                pending.pop(event_id, None)
            continue
        queued = pending.get(event_id)
        if variant == "ai" and isinstance(queued, dict) and queued.get("variant") == "generic":
            pending[event_id] = notification
            continue
        pending.setdefault(event_id, notification)
    return outbox


def build_notifications(report: dict) -> list[dict]:
    # Deterministic high-confidence exclusions (such as /contact or /careers)
    # must be excluded from delivery as well as AI analysis. Otherwise the
    # generic CHANGED_URL fallback would still alert even though triage rejected
    # the page before any model call.
    deterministically_excluded_events = set()
    for event in report.get("events", []):
        if event.get("event_type") not in {"CHANGED_URL", "NEW_URL"}:
            continue
        evidence = event.get("evidence")
        current = evidence.get("current") if isinstance(evidence, dict) else None
        relevance = current.get("relevance") if isinstance(current, dict) else None
        if isinstance(relevance, dict) and relevance.get("candidate") is False:
            event_id = event.get("event_id")
            if event_id:
                deterministically_excluded_events.add(event_id)

    output = []
    seen = set()
    explicitly_irrelevant = set()
    for result in report.get("ai_results", []):
        if result.get("event_id") in deterministically_excluded_events:
            continue
        ai = result.get("ai", {})
        analysis = ai.get("analysis", {}) if isinstance(ai, dict) else {}
        if (
            ai.get("status") == "ok"
            and isinstance(analysis, dict)
            and analysis.get("relevant") is False
            and result.get("event_id")
        ):
            explicitly_irrelevant.add(result["event_id"])
            output.append({
                "event_id": result["event_id"], "kind": result.get("event", "CHANGED_URL"),
                "variant": "ai_irrelevant", "url": result.get("url"),
                "topic": str(analysis.get("topic") or "Change reviewed"),
                "summary": str(analysis.get("summary") or ""),
                "reason": str(analysis.get("reason") or "AI assessed this change as not relevant."),
                "impact": "No action suggested by the AI review; the evidence remains available.",
                "priority": 2, "tags": ["information_source", "regulatory"],
            })
        if ai.get("status") == "ok" and analysis.get("relevant") is True:
            item = {
                "event_id": result["event_id"], "kind": result.get("event", "CHANGED_URL"),
                "variant": "ai", "url": result.get("url"), "topic": analysis["topic"],
                "summary": analysis["summary"], "reason": analysis["reason"],
                "impact": analysis["impact"], "priority": 4,
                "effective_date": analysis.get("effective_date"), "actions": analysis.get("actions"),
                "tags": ["warning", "bank", "regulatory"],
            }
            output.append(item)
            seen.add(item["event_id"])

    for event in report.get("events", []):
        event_id = event.get("event_id")
        kind = event.get("event_type")
        if event_id in deterministically_excluded_events:
            continue
        if event_id in seen:
            continue
        if event_id in explicitly_irrelevant and kind in {"CHANGED_URL", "NEW_URL"}:
            # AI completed successfully and explicitly classified this change as
            # irrelevant. Keep generic alerts for unavailable/failed AI results.
            continue
        if kind == "REMOVED_URL":
            output.append({
                "event_id": event_id, "kind": kind, "url": event.get("url"),
                "topic": "Monitored URL removed",
                "summary": "A previously monitored regulator URL is no longer discoverable.",
                "reason": "The URL was absent from the current successful crawl.",
                "impact": "Review whether the regulator moved, retired, or reorganized the material.",
                "priority": 4, "tags": ["warning", "link", "regulatory"],
            })
        elif kind in {"CHANGED_URL", "NEW_URL"}:
            output.append({
                "event_id": event_id, "kind": kind, "variant": "generic", "url": event.get("url"),
                "topic": "Technical change detected",
                "summary": "A monitored regulator resource changed and was detected by deterministic content comparison.",
                "reason": "The change remains visible even when semantic AI review is unavailable, invalid, or deferred.",
                "impact": "Review the evidence and diff to determine regulatory significance.",
                "priority": 3, "tags": ["warning", "change", "regulatory"],
            })
        elif kind in {"FETCH_ERROR", "EXTRACTION_ERROR"}:
            error = (event.get("evidence") or {}).get("error", "Unknown operational error")
            # Operational events get a unique ID per observation (so evidence is
            # never overwritten), but an unchanged, persistent error must alert
            # once per episode, not on every scheduled run. The engine supplies an
            # onset-based notification ID; older reports fall back to the event ID.
            notification_id = str(event.get("notification_id") or event_id)
            if notification_id in seen:
                continue
            seen.add(notification_id)
            output.append({
                "event_id": notification_id, "source_event_id": event_id,
                "kind": kind, "url": event.get("url"),
                "topic": "Monitoring operational alert",
                "summary": "The current run could not fully process a monitored regulator resource.",
                "reason": error, "impact": "The previous known-good baseline was preserved.",
                "priority": 3, "tags": ["warning", "monitoring"],
            })

    for guard in report.get("removal_guards") or []:
        if not isinstance(guard, dict):
            continue
        source_id = str(guard.get("source_id") or "unknown-source")
        output.append({
            "event_id": str(guard.get("notification_id") or f"removal-guard-{source_id}"),
            "kind": "REMOVAL_HELD", "url": None,
            "topic": f"Mass removal held for review in {source_id}",
            "summary": (
                f"{guard.get('held_removals')} of {guard.get('previous_count')} monitored URLs were not "
                "discovered in this run. They were kept in the baseline instead of being reported as removed."
            ),
            "reason": "More than the allowed share of a source disappeared at once; this usually means a crawler, scope or site-layout problem.",
            "impact": "Check the source. If the pages really were retired, re-run with REGMON_ALLOW_MASS_REMOVAL set to this source ID.",
            "priority": 4, "tags": ["warning", "monitoring", "discovery"],
        })

    discovery = report.get("discovery", [])
    if isinstance(discovery, dict):
        discovery = [discovery]
    for item in discovery if isinstance(discovery, list) else []:
        if not isinstance(item, dict):
            continue
        state = str(item.get("state") or "").upper()
        if state not in {"DEGRADED", "FAILED"}:
            continue
        source_id = str(item.get("source_id") or "unknown-source")
        reason = str(item.get("reason") or item.get("unresolved_failures") or "Discovery did not complete cleanly")
        # The reason text alone is not an episode: a later degradation with the
        # same failure count was suppressed forever. Re-alert at most once a day.
        day = str(report.get("generated_at") or "")[:10]
        identity = json.dumps({"source_id": source_id, "state": state, "reason": reason, "day": day}, sort_keys=True)
        output.append({
            "event_id": "discovery-" + hashlib.sha256(identity.encode("utf-8")).hexdigest(),
            "kind": "DISCOVERY_" + state, "url": None,
            "topic": f"Discovery {state.lower()} for {source_id}",
            "summary": f"URL discovery for {source_id} finished in {state} state.",
            "reason": reason,
            "impact": "Change and removal detection is not authoritative until discovery completes successfully.",
            "priority": 4, "tags": ["warning", "monitoring", "discovery"],
        })
    return output


CHANGE_LINK_KINDS = {"CHANGED_URL", "NEW_URL", "REMOVED_URL", "FETCH_ERROR", "EXTRACTION_ERROR", "AI_ASSESSMENT"}
RUN_LINK_KINDS = {"REMOVAL_HELD", "DISCOVERY_DEGRADED", "DISCOVERY_FAILED"}


def dashboard_link(notification: dict, dashboard_url: str) -> str:
    """Open the alert's own change in the dashboard, not just its front page.

    The dashboard routes "#changes/<event id>" to that change's redline and
    evidence. Follow-ups and once-per-episode operational alerts carry their own
    notification IDs, so they link through source_event_id.
    """
    if not dashboard_url:
        return ""
    base = dashboard_url.split("#", 1)[0]
    kind = str(notification.get("kind") or "")
    if kind in CHANGE_LINK_KINDS:
        event_id = str(notification.get("source_event_id") or notification.get("event_id") or "")
        if event_id and not event_id.startswith("test-"):
            return base + "#changes/" + quote(event_id, safe="")
    if kind in RUN_LINK_KINDS:
        return base + "#runs"
    return base


def _stated(value) -> str:
    text = str(value or "").strip()
    return "" if not text or text.lower() == "not stated" else text


def publish(notification: dict, topic: str, server: str, dashboard_url: str = "") -> None:
    details = ""
    if _stated(notification.get("effective_date")):
        details += f"Effective: {_stated(notification.get('effective_date'))}\n"
    if _stated(notification.get("actions")):
        details += f"Suggested action: {_stated(notification.get('actions'))}\n"
    message = (
        f"Event: {notification['kind']}\n"
        f"Topic: {notification['topic']}\n"
        f"URL: {notification.get('url') or '(not available)'}\n\n"
        f"{notification['summary']}\n\n"
        f"Impact: {notification.get('impact', '')}\n\n"
        + (details + "\n" if details else "") +
        f"Why: {notification['reason']}\n\n"
        f"Event ID: {notification['event_id']}"
    )
    payload = {
        "topic": topic, "title": f"Regulatory Monitor — {notification['kind']}",
        "message": message, "priority": notification["priority"], "tags": notification["tags"],
    }
    link = dashboard_link(notification, dashboard_url)
    if link:
        payload["click"] = link
    response = requests.post(
        server.rstrip("/") + "/", json=payload,
        headers={"Content-Type": "application/json"}, timeout=20,
    )
    response.raise_for_status()


def ledger_record(notification: dict) -> dict:
    """Keep enough of a delivered notification to trace it back to its page."""
    return {
        "kind": notification.get("kind"),
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "url": notification.get("url"),
        "topic": notification.get("topic"),
        "summary": notification.get("summary"),
        "source_event_id": notification.get("source_event_id"),
        "variant": notification.get("variant"),
    }


def deliver_pending(
    outbox: dict,
    state: dict,
    topic: str,
    server: str,
    dashboard_url: str = "",
    persist=None,
) -> dict:
    """Deliver queued notifications, persisting state after every success.

    Saving after each delivery bounds the duplicate window to one message if
    the job is cancelled or crashes mid-loop (previously every message already
    delivered in that loop would be sent again on the next run).
    """
    sent = skipped = failed = 0
    pending = outbox["pending_events"]
    for event_id, notification in list(pending.items()):
        if event_id in state["sent_events"]:
            pending.pop(event_id, None)
            skipped += 1
            if persist:
                persist()
            continue
        try:
            publish(notification, topic, server, dashboard_url)
        except Exception as exc:
            failed += 1
            print(f"notification failed for {event_id}; retained in outbox: {exc}")
            continue
        state["sent_events"][event_id] = ledger_record(notification)
        pending.pop(event_id, None)
        sent += 1
        if persist:
            persist()
    return {"sent": sent, "skipped": skipped, "failed": failed, "pending": len(pending)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--enqueue-only", action="store_true",
        help="Add the current report's notification candidates to the durable outbox without sending",
    )
    mode.add_argument(
        "--deliver-only", action="store_true",
        help="Send already-queued notifications without reading the current report",
    )
    args = parser.parse_args()
    topic = os.getenv("NTFY_TOPIC", DEFAULT_TOPIC).strip()
    server = os.getenv("NTFY_SERVER", DEFAULT_SERVER).strip()
    require_delivery = os.getenv("REQUIRE_NTFY", "0").strip() == "1"
    dashboard_url = os.getenv("DASHBOARD_URL", "").strip()

    if args.test:
        if not topic:
            print(json.dumps({"enabled": False, "reason": "NTFY_TOPIC is not configured"}, indent=2))
            if require_delivery:
                raise RuntimeError("NTFY_TOPIC is required for this notification test")
            return
        notification = {
            "event_id": f"test-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            "kind": "TEST", "url": dashboard_url, "topic": "Controlled notification test",
            "summary": "This is a controlled end-to-end ntfy delivery test. No monitoring baseline is changed.",
            "reason": "Manual GitHub Actions test requested.", "impact": "None",
            "priority": 3, "tags": ["white_check_mark", "test"],
        }
        publish(notification, topic, server, dashboard_url)
        print(json.dumps({"test": True, "sent": True, "event_id": notification["event_id"]}, indent=2))
        return

    state = load_state()
    outbox = load_outbox()
    candidates = []
    if not args.deliver_only:
        report_path = DATA / "report.json"
        if not report_path.exists():
            raise FileNotFoundError("data/report.json does not exist")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        candidates = build_notifications(report)
        enqueue_notifications(outbox, candidates, state["sent_events"])
        save_outbox(outbox)

    if args.enqueue_only:
        print(json.dumps({
            "candidate_notifications": len(candidates),
            "pending": len(outbox["pending_events"]),
        }, indent=2))
        return

    if not topic:
        save_outbox(outbox)
        print(json.dumps({
            "enabled": False,
            "reason": "NTFY_TOPIC is not configured; candidates remain queued",
            "pending": len(outbox["pending_events"]),
        }, indent=2))
        if require_delivery:
            raise RuntimeError("NTFY_TOPIC is required for delivery")
        return

    def persist() -> None:
        save_state(state)
        save_outbox(outbox)

    result = deliver_pending(outbox, state, topic, server, dashboard_url, persist=persist)
    persist()
    print(json.dumps({"candidate_notifications": len(candidates), **result}, indent=2))
    if result["failed"] and require_delivery:
        raise RuntimeError(f"{result['failed']} notification(s) failed; failed events remain queued")


if __name__ == "__main__":
    main()
