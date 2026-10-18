"""Publish regulatory monitoring events to ntfy with a durable retry outbox."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE_PATH = DATA / "notifications.json"
OUTBOX_PATH = DATA / "notification-outbox.json"
DEFAULT_TOPIC = ""
DEFAULT_SERVER = "https://ntfy.sh"


def load_state(path: Path = STATE_PATH) -> dict:
    if not path.exists():
        return {"sent_events": {}, "updated_at": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("sent_events", {}), dict):
            return value
    except (json.JSONDecodeError, OSError):
        pass
    return {"sent_events": {}, "updated_at": None}


def save_state(state: dict, path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def load_outbox(path: Path = OUTBOX_PATH) -> dict:
    if not path.exists():
        return {"pending_events": {}, "updated_at": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("pending_events"), dict):
            return value
    except (json.JSONDecodeError, OSError):
        pass
    return {"pending_events": {}, "updated_at": None}


def save_outbox(outbox: dict, path: Path = OUTBOX_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    outbox["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(outbox, indent=2), encoding="utf-8")


def enqueue_notifications(outbox: dict, candidates: list[dict], sent_events: dict) -> dict:
    """Add new candidates without dropping previously failed deliveries."""
    pending = outbox.setdefault("pending_events", {})
    for notification in candidates:
        event_id = str(notification.get("event_id") or "").strip()
        if event_id and event_id not in sent_events:
            pending.setdefault(event_id, notification)
    return outbox


def build_notifications(report: dict) -> list[dict]:
    output = []
    seen = set()
    explicitly_irrelevant = set()
    for result in report.get("ai_results", []):
        ai = result.get("ai", {})
        analysis = ai.get("analysis", {}) if isinstance(ai, dict) else {}
        if (
            ai.get("status") == "ok"
            and isinstance(analysis, dict)
            and analysis.get("relevant") is False
            and result.get("event_id")
        ):
            explicitly_irrelevant.add(result["event_id"])
        if ai.get("status") == "ok" and analysis.get("relevant") is True:
            item = {
                "event_id": result["event_id"], "kind": result.get("event", "CHANGED_URL"),
                "url": result.get("url"), "topic": analysis["topic"],
                "summary": analysis["summary"], "reason": analysis["reason"],
                "impact": analysis["impact"], "priority": 4,
                "tags": ["warning", "bank", "regulatory"],
            }
            output.append(item)
            seen.add(item["event_id"])

    for event in report.get("events", []):
        event_id = event.get("event_id")
        kind = event.get("event_type")
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
                "event_id": event_id, "kind": kind, "url": event.get("url"),
                "topic": "Technical change detected",
                "summary": "A monitored regulator resource changed and was detected by deterministic content comparison.",
                "reason": "The change remains visible even when semantic AI review is unavailable, invalid, or deferred.",
                "impact": "Review the evidence and diff to determine regulatory significance.",
                "priority": 3, "tags": ["warning", "change", "regulatory"],
            })
        elif kind in {"FETCH_ERROR", "EXTRACTION_ERROR"}:
            error = (event.get("evidence") or {}).get("error", "Unknown operational error")
            output.append({
                "event_id": event_id, "kind": kind, "url": event.get("url"),
                "topic": "Monitoring operational alert",
                "summary": "The current run could not fully process a monitored regulator resource.",
                "reason": error, "impact": "The previous known-good baseline was preserved.",
                "priority": 3, "tags": ["warning", "monitoring"],
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
        identity = json.dumps({"source_id": source_id, "state": state, "reason": reason}, sort_keys=True)
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


def publish(notification: dict, topic: str, server: str, dashboard_url: str = "") -> None:
    message = (
        f"Event: {notification['kind']}\n"
        f"Topic: {notification['topic']}\n"
        f"URL: {notification.get('url') or '(not available)'}\n\n"
        f"{notification['summary']}\n\n"
        f"Impact: {notification.get('impact', '')}\n\n"
        f"Why: {notification['reason']}\n\n"
        f"Event ID: {notification['event_id']}"
    )
    payload = {
        "topic": topic, "title": f"Regulatory Monitor — {notification['kind']}",
        "message": message, "priority": notification["priority"], "tags": notification["tags"],
    }
    if dashboard_url:
        payload["click"] = dashboard_url
    response = requests.post(
        server.rstrip("/") + "/", json=payload,
        headers={"Content-Type": "application/json"}, timeout=20,
    )
    response.raise_for_status()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
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

    report_path = DATA / "report.json"
    if not report_path.exists():
        raise FileNotFoundError("data/report.json does not exist")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    state = load_state()
    outbox = load_outbox()
    enqueue_notifications(outbox, build_notifications(report), state["sent_events"])

    if not topic:
        save_state(state)
        save_outbox(outbox)
        print(json.dumps({
            "enabled": False,
            "reason": "NTFY_TOPIC is not configured; candidates remain queued",
            "pending": len(outbox["pending_events"]),
        }, indent=2))
        if require_delivery:
            raise RuntimeError("NTFY_TOPIC is required for delivery")
        return

    sent = skipped = failed = 0
    pending = outbox["pending_events"]
    for event_id, notification in list(pending.items()):
        if event_id in state["sent_events"]:
            pending.pop(event_id, None)
            skipped += 1
            continue
        try:
            publish(notification, topic, server, dashboard_url)
            state["sent_events"][event_id] = {
                "kind": notification.get("kind"),
                "sent_at": datetime.now(timezone.utc).isoformat(),
            }
            pending.pop(event_id, None)
            sent += 1
        except Exception as exc:
            failed += 1
            print(f"notification failed for {event_id}; retained in outbox: {exc}")

    save_state(state)
    save_outbox(outbox)
    print(json.dumps({
        "candidate_notifications": len(build_notifications(report)),
        "sent": sent, "skipped": skipped, "failed": failed, "pending": len(pending),
    }, indent=2))
    if failed and require_delivery:
        raise RuntimeError(f"{failed} notification(s) failed; failed events remain queued")


if __name__ == "__main__":
    main()
