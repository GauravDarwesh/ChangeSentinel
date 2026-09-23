"""Publish validated regulatory monitoring events to ntfy.sh without exposing evidence text."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE_PATH = DATA / "notifications.json"

DEFAULT_TOPIC = "RegMonitoringWebCrawlerNTFY"
DEFAULT_SERVER = "https://ntfy.sh"
REQUEST_TIMEOUT = 20


def load_state(path=STATE_PATH):
    if not path.exists():
        return {"sent_events": {}, "updated_at": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"sent_events": {}, "updated_at": None}
    if not isinstance(value, dict) or not isinstance(value.get("sent_events", {}), dict):
        return {"sent_events": {}, "updated_at": None}
    return value


def save_state(state, path=STATE_PATH):
    DATA.mkdir(exist_ok=True)
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def build_notifications(report):
    """Return only events safe and useful to publish to a human alert channel."""
    notifications = []
    ai_by_event = {
        result.get("event_id"): result
        for result in report.get("ai_results", [])
        if result.get("event_id")
    }

    for result in report.get("ai_results", []):
        ai = result.get("ai", {})
        analysis = ai.get("analysis", {}) if isinstance(ai, dict) else {}
        if ai.get("status") == "ok" and analysis.get("relevant") is True:
            notifications.append(
                {
                    "event_id": result["event_id"],
                    "kind": result.get("event", "CHANGED_URL"),
                    "url": result.get("url"),
                    "topic": analysis.get("topic", "Regulatory change"),
                    "summary": analysis.get("summary", ""),
                    "reason": analysis.get("reason", ""),
                    "priority": 4,
                    "tags": ["warning", "bank", "regulatory"],
                }
            )

    for event in report.get("events", []):
        if event.get("event_type") != "REMOVED_URL":
            continue
        if event.get("event_id") in ai_by_event:
            continue
        notifications.append(
            {
                "event_id": event["event_id"],
                "kind": "REMOVED_URL",
                "url": event.get("url"),
                "topic": "Monitored URL removed",
                "summary": "A URL previously present in the monitored EBA inventory is no longer discoverable.",
                "reason": "The crawler no longer discovered this URL in the current crawl.",
                "priority": 4,
                "tags": ["warning", "link", "regulatory"],
            }
        )

    for event in report.get("events", []):
        if event.get("event_type") != "FETCH_ERROR":
            continue
        notifications.append(
            {
                "event_id": event["event_id"],
                "kind": "FETCH_ERROR",
                "url": event.get("url"),
                "topic": "Monitoring fetch error",
                "summary": "The regulator URL could not be fetched during this monitoring run.",
                "reason": (event.get("evidence") or {}).get("error", "Unknown fetch error"),
                "priority": 3,
                "tags": ["warning", "monitoring"],
            }
        )

    return notifications


def publish(notification, topic, server, dashboard_url=""):
    message = (
        f"Event: {notification['kind']}\n"
        f"Topic: {notification['topic']}\n"
        f"URL: {notification.get('url') or '(not available)'}\n\n"
        f"{notification['summary']}\n\n"
        f"Why: {notification['reason']}\n\n"
        f"Event ID: {notification['event_id']}"
    )
    payload = {
        "topic": topic,
        "title": f"EBA Regulatory Monitor — {notification['kind']}",
        "message": message,
        "priority": notification["priority"],
        "tags": notification["tags"],
    }
    if dashboard_url:
        payload["click"] = dashboard_url

    response = requests.post(
        server.rstrip("/") + "/",
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()


def main():
    topic = os.getenv("NTFY_TOPIC", DEFAULT_TOPIC).strip()
    server = os.getenv("NTFY_SERVER", DEFAULT_SERVER).strip()
    dashboard_url = os.getenv("DASHBOARD_URL", "").strip()

    report_path = DATA / "report.json"
    if not report_path.exists():
        raise FileNotFoundError("data/report.json does not exist; run the monitor first.")

    report = json.loads(report_path.read_text(encoding="utf-8"))
    state = load_state()
    candidates = build_notifications(report)

    sent = []
    skipped = []
    failed = []

    for notification in candidates:
        event_id = notification["event_id"]
        if event_id in state["sent_events"]:
            skipped.append({"event_id": event_id, "reason": "already sent"})
            continue

        try:
            publish(notification, topic, server, dashboard_url)
        except Exception as exc:
            failed.append({"event_id": event_id, "reason": str(exc)})
            continue

        state["sent_events"][event_id] = {
            "kind": notification["kind"],
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }
        sent.append(event_id)

    save_state(state)

    print(
        json.dumps(
            {
                "topic_configured": bool(topic),
                "candidate_notifications": len(candidates),
                "sent": len(sent),
                "skipped": len(skipped),
                "failed": len(failed),
            },
            indent=2,
        )
    )

    if failed:
        raise RuntimeError(f"{len(failed)} ntfy notification(s) failed; successful deliveries were saved.")


if __name__ == "__main__":
    main()
