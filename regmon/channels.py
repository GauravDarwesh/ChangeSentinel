"""Alert delivery channels beside ntfy: Slack, Microsoft Teams and a generic webhook.

Each channel is enabled by one GitHub Actions secret and needs no code change:

* ``SLACK_WEBHOOK_URL``  — a Slack incoming-webhook URL (https://hooks.slack.com/...).
* ``TEAMS_WEBHOOK_URL``  — a Teams "Post to a channel when a webhook request is
  received" workflow URL; the message is an Adaptive Card.
* ``ALERT_WEBHOOK_URL``  — any HTTPS endpoint (n8n, Zapier, a ticketing bridge)
  receiving a stable JSON document (``changesentinel.alert.v1``). With
  ``ALERT_WEBHOOK_SECRET`` set, the body is signed:
  ``X-ChangeSentinel-Signature: sha256=<hex HMAC-SHA256 of the raw body>``.

The notifier tracks delivery per channel, so one channel's outage never
re-sends to, or blocks, the others.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Callable, Mapping
from urllib.parse import urlsplit

import requests

ALERT_SCHEMA = "changesentinel.alert.v1"
TIMEOUT_SECONDS = 20
FIELDS = (
    ("Effective", "effective_date"),
    ("Suggested action", "actions"),
    ("Alert condition", "condition"),
    ("Reporting items", "reporting_items"),
    ("Spec changes", "spec_changes"),
    ("Downstream", "downstream"),
)


@dataclass(frozen=True)
class Channel:
    name: str
    send: Callable[[dict, str], None]


def _stated(value) -> str:
    text = str(value or "").strip()
    return "" if not text or text.lower() == "not stated" else text


def _https(url: str, label: str) -> str:
    url = str(url or "").strip()
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError(f"{label} must be an https:// URL without credentials")
    return url


def impact_label(notification: dict) -> str:
    """A digest's "impact" field is its list of changes."""
    return "Changes" if notification.get("kind") == "DIGEST" else "Impact"


def _title(notification: dict) -> str:
    return f"{notification.get('kind') or 'ALERT'}: {notification.get('topic') or 'Regulatory change'}"


def _details(notification: dict) -> list[tuple[str, str]]:
    return [(label, _stated(notification.get(key))) for label, key in FIELDS if _stated(notification.get(key))]


def _body_snippet(response, limit: int = 200) -> str:
    try:
        return " ".join(str(getattr(response, "text", "") or "").split())[:limit]
    except Exception:
        return ""


def check_delivery(response, url_label: str) -> None:
    """Raise unless the receiver accepted the message.

    ``raise_for_status()`` alone recorded two kinds of loss as delivered: a
    redirect (requests would replay the POST as a GET elsewhere; redirects are
    never followed, so a 3xx arrives here) and any 2xx at all.
    """
    status = getattr(response, "status_code", None)
    if isinstance(status, int) and 300 <= status < 400:
        location = (getattr(response, "headers", None) or {}).get("Location") or "no Location header"
        raise RuntimeError(f"{url_label} answered HTTP {status} (redirect to {location}); alert endpoints must accept the POST directly")
    try:
        response.raise_for_status()
    except Exception as exc:
        detail = _body_snippet(response)
        raise RuntimeError(f"{url_label} answered HTTP {status}" + (f": {detail}" if detail else "")) from exc


def _check_slack(response) -> None:
    """Slack incoming webhooks answer ``ok``; workflow triggers answer ``{"ok": true}``.

    Some failures (revoked apps, invalid blocks on workflow triggers) answer
    HTTP 200 with ``{"ok": false, "error": ...}``, which raise_for_status accepts.
    """
    text = str(getattr(response, "text", "") or "").strip()
    if text.lower() == "ok":
        return
    try:
        payload = json.loads(text)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("ok") is True:
        return
    error = payload.get("error") if isinstance(payload, dict) else None
    raise RuntimeError("Slack did not accept the message: " + str(error or text[:200] or "empty response"))


def _post(url: str, body: bytes, headers: dict | None = None, verify: Callable | None = None) -> None:
    response = requests.post(
        url, data=body, timeout=TIMEOUT_SECONDS,
        headers={"Content-Type": "application/json", **(headers or {})},
        allow_redirects=False,
    )
    check_delivery(response, urlsplit(url).hostname or "the alert endpoint")
    if verify is not None:
        verify(response)


def _escape_slack(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slack_payload(notification: dict, link: str) -> dict:
    lines = [f"*{_escape_slack(notification.get('summary') or '')}*"] if notification.get("summary") else []
    if _stated(notification.get("impact")):
        lines.append(f"*{impact_label(notification)}:* {_escape_slack(notification['impact'])}")
    for label, value in _details(notification):
        lines.append(f"*{label}:* {_escape_slack(value)}")
    if _stated(notification.get("reason")):
        lines.append(f"*Why:* {_escape_slack(notification['reason'])}")
    url = notification.get("url")
    context = [f"<{url}|{_escape_slack(url)}>" if url else "No page URL", f"Event `{notification.get('event_id')}`"]
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": _title(notification)[:150]}},
        {"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)[:2900] or " "}},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": " · ".join(context)[:2900]}]},
    ]
    if link:
        blocks.append({"type": "actions", "elements": [{
            "type": "button", "text": {"type": "plain_text", "text": "Open in ChangeSentinel"}, "url": link,
        }]})
    return {"text": _title(notification), "blocks": blocks, "unfurl_links": False}


def teams_payload(notification: dict, link: str) -> dict:
    facts = [{"title": label, "value": value} for label, value in _details(notification)]
    if notification.get("url"):
        facts.append({"title": "Page", "value": str(notification["url"])})
    body = [
        {"type": "TextBlock", "text": _title(notification), "weight": "Bolder", "size": "Medium", "wrap": True},
    ]
    if notification.get("summary"):
        body.append({"type": "TextBlock", "text": str(notification["summary"]), "wrap": True})
    if _stated(notification.get("impact")):
        body.append({"type": "TextBlock", "text": impact_label(notification) + ": " + str(notification["impact"]), "wrap": True, "isSubtle": True})
    if facts:
        body.append({"type": "FactSet", "facts": facts})
    if _stated(notification.get("reason")):
        body.append({"type": "TextBlock", "text": "Why: " + str(notification["reason"]), "wrap": True, "size": "Small"})
    card = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard", "version": "1.4", "body": body,
    }
    if link:
        card["actions"] = [{"type": "Action.OpenUrl", "title": "Open in ChangeSentinel", "url": link}]
    return {"type": "message", "attachments": [{
        "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None, "content": card,
    }]}


def webhook_payload(notification: dict, link: str) -> dict:
    keep = (
        "event_id", "source_event_id", "kind", "variant", "url", "topic", "summary", "impact", "reason",
        "effective_date", "actions", "condition", "reporting_items", "spec_changes", "downstream", "priority", "tags",
    )
    return {
        "schema": ALERT_SCHEMA,
        "alert": {key: notification[key] for key in keep if notification.get(key) not in (None, "", [])},
        "dashboard_url": link or None,
    }


def signature(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def _encode(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def configured_channels(
    env: Mapping[str, str],
    link_for: Callable[[dict], str],
    errors: list[str] | None = None,
) -> list[Channel]:
    """Channels enabled by the environment, in a fixed order. ntfy is added by the notifier.

    With ``errors`` given, a misconfigured channel (for example an http:// Slack
    URL) is reported there and left out, so one bad optional secret cannot stop
    the other channels or the run. Without it the error is raised.
    """
    channels = []

    def url_for(key: str) -> str:
        value = str(env.get(key) or "").strip()
        if not value:
            return ""
        try:
            return _https(value, key)
        except ValueError as exc:
            if errors is None:
                raise
            errors.append(str(exc))
            return ""

    slack = url_for("SLACK_WEBHOOK_URL")
    if slack:
        channels.append(Channel("slack", lambda n, _d, u=slack: _post(
            u, _encode(slack_payload(n, link_for(n))), verify=_check_slack,
        )))
    teams = url_for("TEAMS_WEBHOOK_URL")
    if teams:
        channels.append(Channel("teams", lambda n, _d, u=teams: _post(u, _encode(teams_payload(n, link_for(n))))))
    webhook = url_for("ALERT_WEBHOOK_URL")
    if webhook:
        secret = str(env.get("ALERT_WEBHOOK_SECRET") or "")

        def send_webhook(notification: dict, _dashboard: str, url: str = webhook) -> None:
            body = _encode(webhook_payload(notification, link_for(notification)))
            _post(url, body, {"X-ChangeSentinel-Signature": signature(secret, body)} if secret else None)

        channels.append(Channel("webhook", send_webhook))
    return channels
