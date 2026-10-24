"""Slack, Teams and webhook delivery with per-channel tracking."""
from __future__ import annotations

import hashlib
import hmac
import json
import unittest
from unittest.mock import patch

from regmon import channels
from regmon.notify import deliver_pending, enabled_channels, enqueue_notifications

NOTE = {
    "event_id": "evt-1", "kind": "CHANGED_URL", "variant": "ai", "url": "https://www.federalreserve.gov/x",
    "topic": "Reporting", "summary": "Line 12 threshold raised <to> $5bn", "impact": "Update the HC-R mapping",
    "reason": "The diff shows the threshold", "effective_date": "2027-03-31", "actions": "Review", "priority": 4,
    "tags": ["warning"], "condition": "Met — new guide",
}
ENV = {
    "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x",
    "TEAMS_WEBHOOK_URL": "https://prod-1.westus.logic.azure.com/workflows/abc",
    "ALERT_WEBHOOK_URL": "https://hooks.example.com/changesentinel",
    "ALERT_WEBHOOK_SECRET": "s3cret",
}
DASH = "https://gauravdarwesh.github.io/ChangeSentinel/"


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")


class TestPayloads(unittest.TestCase):
    def test_slack_blocks_escape_text_and_link_the_change(self):
        payload = channels.slack_payload(NOTE, DASH + "#changes/evt-1")
        section = payload["blocks"][1]["text"]["text"]
        self.assertIn("raised &lt;to&gt; $5bn", section)
        self.assertIn("*Effective:* 2027-03-31", section)
        self.assertIn("*Alert condition:* Met — new guide", section)
        self.assertEqual(payload["blocks"][-1]["elements"][0]["url"], DASH + "#changes/evt-1")

    def test_teams_adaptive_card(self):
        payload = channels.teams_payload(NOTE, DASH)
        card = payload["attachments"][0]["content"]
        self.assertEqual(card["type"], "AdaptiveCard")
        facts = {fact["title"]: fact["value"] for fact in card["body"][3]["facts"]}
        self.assertEqual(facts["Effective"], "2027-03-31")
        self.assertEqual(facts["Page"], NOTE["url"])
        self.assertEqual(card["actions"][0]["url"], DASH)

    def test_webhook_document_is_stable_and_signed(self):
        sent = []
        with patch("regmon.channels.requests.post", side_effect=lambda url, **kw: sent.append((url, kw)) or FakeResponse()):
            configured = channels.configured_channels(ENV, lambda n: DASH + "#changes/" + n["event_id"])
            next(c for c in configured if c.name == "webhook").send(NOTE, DASH)
        url, kwargs = sent[0]
        body = kwargs["data"]
        document = json.loads(body)
        self.assertEqual(document["schema"], "changesentinel.alert.v1")
        self.assertEqual(document["alert"]["effective_date"], "2027-03-31")
        self.assertEqual(document["dashboard_url"], DASH + "#changes/evt-1")
        expected = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
        self.assertEqual(kwargs["headers"]["X-ChangeSentinel-Signature"], expected)

    def test_insecure_channel_urls_are_refused(self):
        for key in ("SLACK_WEBHOOK_URL", "TEAMS_WEBHOOK_URL", "ALERT_WEBHOOK_URL"):
            for bad in ("http://hooks.example.com/x", "https://user:pass@hooks.example.com/x", "file:///etc/passwd"):
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    channels.configured_channels({key: bad}, lambda n: "")

    def test_channel_order_and_ntfy(self):
        names = [channel.name for channel in enabled_channels("topic", "https://ntfy.sh", DASH, env=ENV)]
        self.assertEqual(names, ["ntfy", "slack", "teams", "webhook"])
        self.assertEqual([c.name for c in enabled_channels("", "https://ntfy.sh", DASH, env={})], [])


class TestPerChannelDelivery(unittest.TestCase):
    def channel(self, name, log, fail=False):
        def send(notification, _dashboard):
            if fail:
                raise RuntimeError(f"{name} down")
            log.append((name, notification["event_id"]))
        return channels.Channel(name, send)

    def test_one_channel_outage_neither_blocks_nor_duplicates_the_others(self):
        log = []
        outbox = {"pending_events": {"evt-1": dict(NOTE)}}
        state = {"sent_events": {}}
        first = deliver_pending(outbox, state, "", "", channels=[self.channel("ntfy", log), self.channel("slack", log, fail=True)])
        self.assertEqual(first, {"sent": 0, "skipped": 0, "failed": 1, "pending": 1})
        self.assertIn("ntfy", outbox["pending_events"]["evt-1"]["delivered_channels"])
        second = deliver_pending(outbox, state, "", "", channels=[self.channel("ntfy", log), self.channel("slack", log)])
        self.assertEqual(second["sent"], 1)
        self.assertEqual(log, [("ntfy", "evt-1"), ("slack", "evt-1")])
        self.assertEqual(state["sent_events"]["evt-1"]["channels"], ["ntfy", "slack"])
        self.assertEqual(outbox["pending_events"], {})

    def test_default_channel_is_ntfy_via_publish(self):
        outbox = {"pending_events": {"evt-1": dict(NOTE)}}
        state = {"sent_events": {}}
        with patch("regmon.notify.publish") as publish:
            result = deliver_pending(outbox, state, "topic", "https://ntfy.example")
        publish.assert_called_once()
        self.assertEqual(result["sent"], 1)
        self.assertEqual(state["sent_events"]["evt-1"]["channels"], ["ntfy"])

    def test_partially_delivered_generic_is_kept_and_ai_follows_up(self):
        generic = dict(NOTE, variant="generic", delivered_channels={"ntfy": "2026-10-24T00:00:00+00:00"})
        outbox = {"pending_events": {"evt-1": generic}}
        enqueue_notifications(outbox, [dict(NOTE, variant="ai")], {})
        self.assertEqual(outbox["pending_events"]["evt-1"]["variant"], "generic")
        self.assertEqual(outbox["pending_events"]["evt-1#ai"]["kind"], "AI_ASSESSMENT")

    def test_unsent_generic_is_still_replaced_by_the_ai_version(self):
        outbox = {"pending_events": {"evt-1": dict(NOTE, variant="generic")}}
        enqueue_notifications(outbox, [dict(NOTE, variant="ai")], {})
        self.assertEqual(outbox["pending_events"]["evt-1"]["variant"], "ai")
        self.assertNotIn("evt-1#ai", outbox["pending_events"])


if __name__ == "__main__":
    unittest.main()
