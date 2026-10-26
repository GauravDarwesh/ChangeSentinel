"""Publish regulatory monitoring events (ntfy, Slack, Teams, webhook) with a durable retry outbox."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import tempfile

import requests

from regmon import channels as alert_channels
from regmon import botcheck, item_codes, spec_diff

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


AI_VARIANTS = {"ai", "ai_irrelevant", "condition_not_met"}
# Variants that never alert on their own: they only follow up a generic alert
# that was already delivered, and replace one still waiting in the outbox.
QUIET_VARIANTS = {"ai_irrelevant", "condition_not_met"}


def _follow_up(notification: dict, key: str) -> dict:
    """An AI assessment for a change whose generic alert was already delivered."""
    relevant = notification.get("variant") == "ai"
    return {
        **notification,
        "event_id": key + "#ai",
        "source_event_id": key,
        "kind": "AI_ASSESSMENT",
        "topic": ("AI assessment: " + str(notification.get("topic") or "change reviewed")) if relevant
        else (
            "AI assessment: alert condition not met"
            if notification.get("variant") == "condition_not_met"
            else "AI assessment: not relevant"
        ),
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
        queued = pending.get(event_id)
        if (
            variant in AI_VARIANTS
            and isinstance(queued, dict)
            and queued.get("variant") == "generic"
            and queued.get("delivered_channels")
        ):
            # The generic alert already reached some channels; keep it queued
            # for the rest and send the assessment as a follow-up everywhere.
            follow_up = _follow_up(notification, event_id)
            if follow_up["event_id"] not in sent_events:
                pending.setdefault(follow_up["event_id"], follow_up)
            continue
        if variant in QUIET_VARIANTS:
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


def _hours_between(start, end) -> float | None:
    try:
        first = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        last = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return max(0.0, (last - first).total_seconds() / 3600)


def _operational_alert(event: dict, threshold: int, seen: set) -> dict | None:
    """The once-per-episode alert for a page that keeps failing, or None while it is too early."""
    # A failure alerts only once it has persisted for the configured number
    # of consecutive scans, so a one-off timeout on a regulator site is
    # recorded (and visible in data/health.json) without an alert. The
    # notification ID is per episode, so it alerts once.
    try:
        failing_runs = int(event.get("error_runs") or threshold)
    except (TypeError, ValueError):
        failing_runs = threshold
    if failing_runs < threshold:
        return None
    error = (event.get("evidence") or {}).get("error", "Unknown operational error")
    # Operational events get a unique ID per observation (so evidence is never
    # overwritten), but an unchanged, persistent error must alert once per
    # episode, not on every scheduled run. The engine supplies an onset-based
    # notification ID; older reports fall back to the event ID.
    event_id = event.get("event_id")
    notification_id = str(event.get("notification_id") or event_id)
    if notification_id in seen:
        return None
    seen.add(notification_id)
    return {
        "event_id": notification_id, "source_event_id": event_id,
        "kind": event.get("event_type"), "url": event.get("url"),
        "topic": "Monitoring operational alert",
        "summary": (
            "The current run could not fully process a monitored regulator resource."
            if failing_runs <= 1 else
            f"A monitored regulator resource has failed {failing_runs} consecutive scans"
            + (f" (since {event.get('error_since')})." if event.get("error_since") else ".")
        ),
        "reason": error, "impact": "The previous known-good baseline was preserved.",
        "priority": 3, "tags": ["warning", "monitoring"],
    }


def _bot_check_alerts(events: list[dict], threshold: int, seen: set) -> list[dict]:
    """One operational alert per site whose bot check has outlasted the grace period.

    Every scan retries a blocked page in a browser and keeps its last good
    copy, so a short block needs nobody. A block that lasts
    ``botcheck.GRACE_HOURS`` (and at least ``threshold`` scans) alerts once
    for the site, naming how many pages wait, instead of once per page.
    """
    from urllib.parse import urlsplit

    sites: dict[str, list[dict]] = {}
    for event in events:
        host = (urlsplit(str(event.get("url") or "")).hostname or "unknown site").lower()
        sites.setdefault(host, []).append(event)
    alerts = []
    for host, group in sorted(sites.items()):
        refusals_only = all(str((event.get("evidence") or {}).get("error") or "").startswith("AccessRefusedError") for event in group)
        if refusals_only and len({event.get("url") for event in group}) < 2:
            # One refused page on a site is more likely a removed or private
            # file than a block: it alerts like any other failing page.
            for event in group:
                alert = _operational_alert(event, threshold, seen)
                if alert:
                    alerts.append(alert)
            continue
        since = min(str(event.get("error_since") or event.get("timestamp") or "") for event in group)
        latest = max(str(event.get("timestamp") or "") for event in group)
        hours = _hours_between(since, latest)
        runs = max(int(event.get("error_runs") or 1) for event in group)
        if botcheck.within_grace(hours) or runs < threshold:
            continue
        notification_id = "BOT_CHECK:" + hashlib.sha256(f"{host}|{since}".encode()).hexdigest()[:24]
        if notification_id in seen:
            continue
        seen.add(notification_id)
        what = botcheck.reason((group[0].get("evidence") or {}).get("error"))
        pages = len({event.get("url") for event in group})
        alerts.append({
            "event_id": notification_id, "source_event_id": group[0].get("event_id"),
            "kind": "FETCH_ERROR", "url": group[0].get("url"),
            "topic": f"{host} is blocking automatic checks",
            "summary": (f"{host} has answered with {what} for {round(hours)} hours that the automatic browser could not get past. "
                        f"{pages} monitored {'page waits' if pages == 1 else 'pages wait'} with the last good copy kept, and every scan tries again."),
            "reason": str((group[0].get("evidence") or {}).get("error") or "Bot check"),
            "impact": ("Changes on these pages can be missed while the block lasts. Nothing needs doing if it clears on its own; "
                       "if it persists, check the pages by hand or ask the site to allow the scanner."),
            "priority": 3, "tags": ["warning", "monitoring"],
        })
    return alerts


def build_notifications(report: dict) -> list[dict]:
    try:
        threshold = max(1, int(report.get("error_alert_after_runs") or 1))
    except (TypeError, ValueError):
        threshold = 1
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

    # Reporting-item (MDRM) changes are deterministic, so they ride along on
    # every alert for the change: AI, generic fallback, or follow-up.
    item_lines = {}
    for event in report.get("events", []):
        line = item_codes.describe(event.get("item_codes")) if isinstance(event.get("item_codes"), dict) else ""
        if line and event.get("event_id"):
            item_lines[event["event_id"]] = line
    # Structured rule/field changes ride along the same way.
    spec_lines = {}
    for event in report.get("events", []):
        line = spec_diff.describe(event.get("spec")) if isinstance(event.get("spec"), dict) else ""
        if line and event.get("event_id"):
            spec_lines[event["event_id"]] = line
    # Registered items the change touched and what reads them (regmon/registry.py).
    impact_lines = {}
    for event in report.get("events", []):
        impact = event.get("impact") if isinstance(event.get("impact"), dict) else {}
        if impact.get("sentence") and event.get("event_id"):
            impact_lines[event["event_id"]] = str(impact["sentence"])

    output = []
    seen = set()
    explicitly_irrelevant = set()
    for result in report.get("ai_results", []):
        if result.get("event_id") in deterministically_excluded_events:
            continue
        ai = result.get("ai", {})
        analysis = ai.get("analysis", {}) if isinstance(ai, dict) else {}
        condition = ai.get("condition") if isinstance(ai, dict) and ai.get("status") == "ok" else None
        condition_met = condition.get("met") if isinstance(condition, dict) else None
        if not isinstance(condition_met, bool):
            condition_met = None
        condition_line = ""
        if condition_met is not None:
            condition_line = (
                ("Met" if condition_met else "Not met")
                + f" — {condition.get('text') or result.get('alert_condition') or ''}".rstrip(" —")
            )
            if str(condition.get("reason") or "").strip():
                condition_line += f" ({str(condition['reason']).strip()})"
        if (
            ai.get("status") == "ok"
            and isinstance(analysis, dict)
            and condition_met is False
            and result.get("alert_only_on_condition") is True
            and result.get("event_id")
        ):
            # The owner asked to be alerted only when their condition is met.
            # The change and its evidence stay recorded; nothing alerts.
            explicitly_irrelevant.add(result["event_id"])
            output.append({
                "event_id": result["event_id"], "kind": result.get("event", "CHANGED_URL"),
                "variant": "condition_not_met", "url": result.get("url"),
                "topic": str(analysis.get("topic") or "Change reviewed"),
                "summary": str(analysis.get("summary") or ""),
                "reason": str(condition.get("reason") or "The AI found the monitor's alert condition was not met."),
                "impact": "Recorded without an alert because this monitor alerts only when its condition is met.",
                "condition": condition_line,
                "priority": 2, "tags": ["information_source", "regulatory"],
            })
            continue
        if (
            ai.get("status") == "ok"
            and isinstance(analysis, dict)
            and analysis.get("relevant") is False
            and condition_met is not True
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
        if ai.get("status") == "ok" and (analysis.get("relevant") is True or condition_met is True):
            item = {
                "event_id": result["event_id"], "kind": result.get("event", "CHANGED_URL"),
                "variant": "ai", "url": result.get("url"), "topic": analysis["topic"],
                "summary": analysis["summary"], "reason": analysis["reason"],
                "impact": analysis["impact"], "priority": 4,
                "effective_date": analysis.get("effective_date"), "actions": analysis.get("actions"),
                "tags": ["warning", "bank", "regulatory"],
            }
            if result["event_id"] in item_lines:
                item["reporting_items"] = item_lines[result["event_id"]]
            if result["event_id"] in spec_lines:
                item["spec_changes"] = spec_lines[result["event_id"]]
            if result["event_id"] in impact_lines:
                item["downstream"] = impact_lines[result["event_id"]]
            if condition_line:
                item["condition"] = condition_line
            output.append(item)
            seen.add(item["event_id"])

    bot_checks: list[dict] = []
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
            generic = {
                "event_id": event_id, "kind": kind, "variant": "generic", "url": event.get("url"),
                "topic": "Technical change detected",
                "summary": "A monitored regulator resource changed and was detected by deterministic content comparison.",
                "reason": "The change remains visible even when semantic AI review is unavailable, invalid, or deferred.",
                "impact": "Review the evidence and diff to determine regulatory significance.",
                "priority": 3, "tags": ["warning", "change", "regulatory"],
            }
            if event_id in item_lines:
                generic["reporting_items"] = item_lines[event_id]
            if event_id in spec_lines:
                generic["spec_changes"] = spec_lines[event_id]
            if event_id in impact_lines:
                generic["downstream"] = impact_lines[event_id]
            output.append(generic)
        elif kind == "VISUAL_CHANGED":
            # Opt-in per monitor (visual_alert_threshold): the page looks different
            # while its text and markup are the same, e.g. a chart or image changed.
            share = (event.get("visual") or {}).get("changed_ratio")
            output.append({
                "event_id": event_id, "kind": kind, "variant": "generic", "url": event.get("url"),
                "topic": "Page looks different",
                "summary": "The rendered page differs visually from the last screenshot while its text and markup are unchanged"
                           + (f" ({share:.1%} of the page)." if isinstance(share, (int, float)) else "."),
                "reason": "The monitor compares a screenshot of each render and alerts above its visual threshold.",
                "impact": "Open the change to see the marked regions on the before and after screenshots.",
                "priority": 3, "tags": ["eyes", "regulatory"],
            })
        elif kind == "FETCH_ERROR" and botcheck.is_error((event.get("evidence") or {}).get("error")):
            # Bot checks and refusals are retried automatically and collected
            # per site below: one alert for the site, once the block has lasted.
            bot_checks.append(event)
        elif kind in {"FETCH_ERROR", "EXTRACTION_ERROR"}:
            alert = _operational_alert(event, threshold, seen)
            if alert:
                output.append(alert)

    output.extend(_bot_check_alerts(bot_checks, threshold, seen))

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
    return _without_shadow_changes(report, output)


# Content alerts a shadow-mode source does not send. Operational alerts
# (fetch and extraction failures, held removals) still go out: they are about
# ChangeSentinel itself, which a trial run needs to know.
SHADOW_MUTED_KINDS = {"CHANGED_URL", "NEW_URL", "REMOVED_URL", "VISUAL_CHANGED"}


def _without_shadow_changes(report: dict, output: list[dict]) -> list[dict]:
    shadow_sources = {
        str(source.get("id")) for source in report.get("sources") or []
        if isinstance(source, dict) and source.get("shadow") is True
    }
    if not shadow_sources:
        return output
    event_sources = {
        str(event.get("event_id")): str(event.get("source_id") or "")
        for event in report.get("events") or [] if isinstance(event, dict)
    }
    return [
        item for item in output
        if not (item.get("kind") in SHADOW_MUTED_KINDS and event_sources.get(str(item.get("event_id"))) in shadow_sources)
    ]


CHANGE_LINK_KINDS = {"CHANGED_URL", "NEW_URL", "REMOVED_URL", "VISUAL_CHANGED", "FETCH_ERROR", "EXTRACTION_ERROR", "AI_ASSESSMENT"}
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
    if kind == "DIGEST" and notification.get("digest_id"):
        return base + "#alerts/" + quote("digest:" + str(notification["digest_id"]), safe="")
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
    if _stated(notification.get("condition")):
        details += f"Alert condition: {_stated(notification.get('condition'))}\n"
    if _stated(notification.get("reporting_items")):
        details += f"Reporting items: {_stated(notification.get('reporting_items'))}\n"
    if _stated(notification.get("spec_changes")):
        details += f"Spec changes: {_stated(notification.get('spec_changes'))}\n"
    if _stated(notification.get("downstream")):
        details += f"Downstream: {_stated(notification.get('downstream'))}\n"
    message = (
        f"Event: {notification['kind']}\n"
        f"Topic: {notification['topic']}\n"
        f"URL: {notification.get('url') or '(not available)'}\n\n"
        f"{notification['summary']}\n\n"
        f"{alert_channels.impact_label(notification)}: {notification.get('impact', '')}\n\n"
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
        **({"digest_id": notification["digest_id"]} if notification.get("digest_id") else {}),
    }


def ntfy_channel(topic: str, server: str) -> alert_channels.Channel:
    return alert_channels.Channel("ntfy", lambda notification, dashboard: publish(notification, topic, server, dashboard))


def enabled_channels(topic: str, server: str, dashboard_url: str = "", env=None) -> list[alert_channels.Channel]:
    """ntfy (when NTFY_TOPIC is set) plus every webhook channel configured in the environment."""
    found = [ntfy_channel(topic, server)] if topic else []
    found.extend(alert_channels.configured_channels(
        os.environ if env is None else env,
        lambda notification: dashboard_link(notification, dashboard_url),
    ))
    return found


def deliver_pending(
    outbox: dict,
    state: dict,
    topic: str,
    server: str,
    dashboard_url: str = "",
    persist=None,
    channels: list | None = None,
) -> dict:
    """Deliver queued notifications to every enabled channel, persisting after each send.

    Delivery is tracked per channel on the queued notification
    ("delivered_channels"), so a Slack outage neither blocks nor re-sends the
    ntfy copy: the notification stays queued with what was delivered, and the
    next run sends only the missing channels. It moves to the sent ledger once
    every enabled channel has it. Saving after every send bounds the duplicate
    window to one message per channel if the job is cancelled mid-loop.
    """
    if channels is None:
        channels = [ntfy_channel(topic, server)] if topic else []
    names = [channel.name for channel in channels]
    sent = skipped = failed = 0
    pending = outbox["pending_events"]
    for event_id, notification in list(pending.items()):
        if event_id in state["sent_events"]:
            pending.pop(event_id, None)
            skipped += 1
            if persist:
                persist()
            continue
        if not channels:
            continue
        delivered = notification.get("delivered_channels")
        delivered = dict(delivered) if isinstance(delivered, dict) else {}
        had_failure = False
        for channel in channels:
            if channel.name in delivered:
                continue
            try:
                channel.send(notification, dashboard_url)
            except Exception as exc:
                had_failure = True
                print(f"notification failed on {channel.name} for {event_id}; retained in outbox: {exc}")
                continue
            delivered[channel.name] = datetime.now(timezone.utc).isoformat()
            notification["delivered_channels"] = delivered
            # Record a partial delivery durably; when this was the last channel
            # the ledger write below persists it instead.
            if persist and any(name not in delivered for name in names):
                persist()
        if had_failure or any(name not in delivered for name in names):
            failed += 1
            continue
        record = ledger_record(notification)
        record["channels"] = sorted(delivered)
        state["sent_events"][event_id] = record
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

    channels = enabled_channels(topic, server, dashboard_url)
    if args.test:
        if not channels:
            print(json.dumps({"enabled": False, "reason": "No alert channel is configured"}, indent=2))
            if require_delivery:
                raise RuntimeError("NTFY_TOPIC or another alert channel is required for this notification test")
            return
        notification = {
            "event_id": f"test-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            "kind": "TEST", "url": dashboard_url, "topic": "Controlled notification test",
            "summary": "This is a controlled end-to-end alert delivery test. No monitoring baseline is changed.",
            "reason": "Manual GitHub Actions test requested.", "impact": "None",
            "priority": 3, "tags": ["white_check_mark", "test"],
        }
        results = {}
        for channel in channels:
            try:
                channel.send(notification, dashboard_url)
                results[channel.name] = "sent"
            except Exception as exc:
                results[channel.name] = f"failed: {exc}"
        print(json.dumps({"test": True, "event_id": notification["event_id"], "channels": results}, indent=2))
        if require_delivery and any(value != "sent" for value in results.values()):
            raise RuntimeError("The notification test failed on at least one channel")
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

    if not channels:
        save_outbox(outbox)
        print(json.dumps({
            "enabled": False,
            "reason": "No alert channel (NTFY_TOPIC, SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL, ALERT_WEBHOOK_URL) is configured; candidates remain queued",
            "pending": len(outbox["pending_events"]),
        }, indent=2))
        if require_delivery:
            raise RuntimeError("NTFY_TOPIC is required for delivery")
        return

    def persist() -> None:
        save_state(state)
        save_outbox(outbox)

    result = deliver_pending(outbox, state, topic, server, dashboard_url, persist=persist, channels=channels)
    persist()
    print(json.dumps({
        "candidate_notifications": len(candidates), **result, "channels": [channel.name for channel in channels],
    }, indent=2))
    if result["failed"] and require_delivery:
        raise RuntimeError(f"{result['failed']} notification(s) failed; failed events remain queued")


if __name__ == "__main__":
    main()
