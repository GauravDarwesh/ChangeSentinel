"""Regression tests: persistent operational errors alert once per episode."""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import requests

from engine_harness import Sandbox, html, ok
from regmon.notify import build_notifications, enqueue_notifications


def forbidden(*_args, **_kwargs):
    raise requests.HTTPError("HTTP 403 for https://example.test/policy")


def timeout(*_args, **_kwargs):
    raise requests.Timeout("Read timed out. (read timeout=5)")


class TestOperationalErrorEpisodes(unittest.TestCase):
    def scan_at(self, sandbox, hours, fetch):
        with patch("regmon.engine.datetime") as clock:
            clock.now.return_value = datetime(2026, 10, 20, tzinfo=timezone.utc) + timedelta(hours=hours)
            clock.fromisoformat = datetime.fromisoformat
            return sandbox.scan(fetch)

    def deliveries(self, results):
        ledger, delivered = {}, []
        for result in results:
            outbox = {"pending_events": {}}
            enqueue_notifications(outbox, build_notifications(result["report"]), ledger)
            for key, item in outbox["pending_events"].items():
                ledger[key] = {"kind": item["kind"]}
                delivered.append(item)
        return delivered

    def test_a_persistent_403_alerts_once_but_records_every_observation(self):
        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(html("<p>Rule text.</p>")))
            failing = [self.scan_at(sandbox, 6 * i, forbidden) for i in range(1, 5)]
            event_ids = {r["report"]["events"][0]["event_id"] for r in failing}
            notification_ids = {r["report"]["events"][0]["notification_id"] for r in failing}
            self.assertEqual(len(event_ids), 4, "each observation keeps unique evidence")
            self.assertEqual(len(notification_ids), 1, "one alert identity for the whole episode")
            self.assertEqual(len(self.deliveries(failing)), 1)

    def test_recovery_or_a_different_failure_starts_a_new_episode(self):
        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(html("<p>Rule text.</p>")))
            first = self.scan_at(sandbox, 6, forbidden)
            self.scan_at(sandbox, 12, lambda *a, **k: ok(html("<p>Rule text.</p>")))
            self.assertNotIn("error_since", sandbox.inventory()[first["report"]["events"][0]["url_id"]])
            second = self.scan_at(sandbox, 18, forbidden)
            third = self.scan_at(sandbox, 24, timeout)
            ids = [r["report"]["events"][0]["notification_id"] for r in (first, second, third)]
            self.assertEqual(len(set(ids)), 3)
            self.assertEqual(len(self.deliveries([first, second, third])), 3)


if __name__ == "__main__":
    unittest.main()
