"""Fleet health ledger (data/health.json) and the consecutive-failure alert threshold."""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from engine_harness import Sandbox, html, ok
from regmon import health
from regmon.config import SourceConfig, validate_config
from regmon.notify import build_notifications

NOW = datetime(2026, 12, 15, 12, 0, tzinfo=timezone.utc)


def iso(delta: timedelta) -> str:
    return (NOW - delta).isoformat()


def source(source_id, url, **extra):
    return {"id": source_id, "name": source_id.title(), "regulator": "Reg", "active": True, "seed_urls": [url], **extra}


def row(url, **extra):
    return {"canonical_url": url, "active": True, "first_seen": iso(timedelta(days=80)), **extra}


def run(source_id, delta, **counts):
    return {"source_id": source_id, "generated_at": iso(delta), "counts": counts}


class TestHealthLedger(unittest.TestCase):
    def build(self):
        config = {"sources": [
            source("ok", "https://a.test/ok"),
            source("failing", "https://a.test/fail", alert_condition="New guide"),
            source("quiet", "https://a.test/quiet"),
            source("stale", "https://a.test/stale"),
            source("circular", "https://a.test/circulares-2025"),
            source("retired", "https://a.test/off", active=False),
        ]}
        latest = {"sources": {
            "ok": {"1": row("https://a.test/ok", last_changed_at=iso(timedelta(days=2)))},
            "failing": {"2": row(
                "https://a.test/fail", extraction_error="Parser failed",
                error_since=iso(timedelta(hours=13)),
            )},
            "quiet": {"3": row("https://a.test/quiet", last_changed_at=iso(timedelta(days=60)))},
            "stale": {"4": row("https://a.test/stale")},
            "circular": {"5": row("https://a.test/circulares-2025")},
            "retired": {"6": row("https://a.test/off")},
        }}
        history = [
            run("ok", timedelta(hours=1), unchanged=1),
            run("ok", timedelta(days=2), changed=1),
            run("failing", timedelta(hours=1), extraction_error=1),
            run("failing", timedelta(hours=7), extraction_error=1),
            run("failing", timedelta(hours=14), unchanged=1),
            run("quiet", timedelta(hours=1), unchanged=1),
            run("stale", timedelta(hours=30), unchanged=1),
            run("circular", timedelta(hours=1), unchanged=1),
            run("ok", timedelta(days=20), changed=1),
        ]
        ledger = {"sent_events": {
            "a": {"kind": "CHANGED_URL", "sent_at": iso(timedelta(days=2))},
            "b": {"kind": "TEST", "sent_at": iso(timedelta(days=1))},
            "c": {"kind": "CHANGED_URL", "sent_at": iso(timedelta(days=20))},
        }}
        return health.build_health(config, latest, history, ledger, NOW)

    def test_statuses_and_rosters(self):
        result = self.build()
        statuses = {monitor["source_id"]: monitor["status"] for monitor in result["monitors"]}
        self.assertEqual(statuses, {
            "ok": "healthy", "failing": "failing", "quiet": "inactive", "stale": "stale", "circular": "inactive",
        })
        self.assertNotIn("retired", statuses)
        failing = result["failing"][0]
        self.assertEqual((failing["source_id"], failing["kind"], failing["runs"], failing["hours"]), ("failing", "EXTRACTION_ERROR", 2, 13.0))
        self.assertEqual(result["inactive"][0]["source_id"], "circular")
        self.assertEqual(result["year_bound"][0]["years"], [2025])
        self.assertEqual(result["totals"]["with_alert_condition"], 1)
        self.assertEqual(result["totals"]["pages"], 5)

    def test_windows_count_checks_failures_changes_and_real_alerts(self):
        result = self.build()
        week = result["last_7_days"]
        self.assertEqual(week["checks"], 8)
        self.assertEqual(week["failed_checks"], 2)
        self.assertEqual(week["changes"], 1)
        self.assertEqual(week["alerts_sent"], 1)
        self.assertEqual(result["last_30_days"]["alerts_sent"], 2)
        self.assertEqual(len(result["daily"]), health.SERIES_DAYS)
        self.assertEqual(result["daily"][-1]["date"], "2026-12-15")

    def test_current_year_and_fresh_urls_are_not_flagged(self):
        self.assertIsNone(health.year_bound("https://a.test/circulares-2026", NOW))
        self.assertIsNone(health.year_bound("https://a.test/2025-to-2026-plan", NOW))
        self.assertEqual(health.year_bound("https://a.test/guide-12-31-2022.pdf", NOW), 2022)

    def test_write_survives_missing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            config = data / "sources.json"
            config.write_text(json.dumps({"sources": [source("ok", "https://a.test/ok")]}), encoding="utf-8")
            result = health.write(data, config, now=NOW)
            self.assertEqual(json.loads((data / "health.json").read_text())["totals"]["stale"], 1)
            self.assertEqual(result["last_7_days"]["success_rate"], None)


class TestErrorAlertThreshold(unittest.TestCase):
    def failing_scan(self, box):
        def fail(*_args, **_kwargs):
            raise RuntimeError("HTTP 500 from regulator")
        return box.scan(fail)

    def test_error_runs_count_consecutive_failures_and_reset(self):
        with Sandbox() as box:
            box.scan(lambda *_a, **_k: ok(html("<p>v1</p>")))
            first = self.failing_scan(box)
            second = self.failing_scan(box)
            events = [first["report"]["events"][0], second["report"]["events"][0]]
            self.assertEqual([event["error_runs"] for event in events], [1, 2])
            self.assertEqual(events[0]["notification_id"], events[1]["notification_id"])
            box.scan(lambda *_a, **_k: ok(html("<p>v1</p>")))
            third = self.failing_scan(box)
            self.assertEqual(third["report"]["events"][0]["error_runs"], 1)

    def test_notifier_waits_for_the_threshold_then_alerts_once(self):
        event = {
            "event_id": "e1", "event_type": "FETCH_ERROR", "url": "https://a.test", "notification_id": "episode-1",
            "error_since": "2026-12-15T00:00:00+00:00", "evidence": {"error": "HTTP 500"},
        }
        first = build_notifications({"error_alert_after_runs": 2, "events": [dict(event, error_runs=1)]})
        self.assertEqual(first, [])
        second = build_notifications({"error_alert_after_runs": 2, "events": [dict(event, error_runs=2)]})
        self.assertEqual([n["event_id"] for n in second], ["episode-1"])
        self.assertIn("failed 2 consecutive scans", second[0]["summary"])
        # Default and legacy reports alert on the first failure, as before.
        self.assertEqual(len(build_notifications({"events": [dict(event, error_runs=1)]})), 1)
        self.assertEqual(len(build_notifications({"error_alert_after_runs": 3, "events": [event]})), 1)

    def test_bot_checks_alert_once_per_site_and_only_after_the_grace_period(self):
        def bot(index, hours, runs=3, host="www.ffiec.gov"):
            return {"event_id": f"b{index}", "event_type": "FETCH_ERROR", "url": f"https://{host}/forms/{index}.pdf",
                    "timestamp": "2026-12-15T12:00:00+00:00", "error_since": iso(timedelta(hours=hours)),
                    "error_runs": runs, "notification_id": f"episode-{index}",
                    "evidence": {"error": "BotCheckError: Cloudflare bot check: it still asked for a check after 35 s"}}
        report = {"error_alert_after_runs": 2, "events": [bot(index, 6) for index in range(43)]}
        self.assertEqual(build_notifications(report), [])  # 6 h: still retrying, nobody is alerted
        report = {"error_alert_after_runs": 2, "events": [bot(index, 30) for index in range(43)] + [bot(99, 30, host="other.test")]}
        alerts = build_notifications(report)
        self.assertEqual(len(alerts), 2)  # one per site, not 44
        ffiec = next(alert for alert in alerts if "www.ffiec.gov" in alert["topic"])
        self.assertIn("43 monitored pages wait", ffiec["summary"])
        self.assertIn("Cloudflare", ffiec["summary"])
        self.assertEqual(build_notifications(report)[0]["event_id"], alerts[0]["event_id"])  # stable: the ledger sends it once
        self.assertEqual(build_notifications({"error_alert_after_runs": 5, "events": [bot(1, 30, runs=3)]}), [])

    def test_a_bot_check_is_a_wait_not_a_failure_until_the_grace_period_ends(self):
        message = "BotCheckError: Cloudflare bot check: it still asked for a check after 35 s"
        config = {"sources": [source("fresh", "https://www.ffiec.gov/a"), source("long", "https://www.ffiec.gov/b")]}
        latest = {"sources": {
            "fresh": {"1": row("https://www.ffiec.gov/a", fetch_error=message, error_since=iso(timedelta(hours=3)))},
            "long": {"2": row("https://www.ffiec.gov/b", fetch_error=message, error_since=iso(timedelta(hours=30)),
                              normalized_hash="abc")},
        }}
        history = [run("fresh", timedelta(hours=1), fetch_error=1), run("long", timedelta(hours=1), fetch_error=1)]
        result = health.build_health(config, latest, history, {}, NOW)
        statuses = {monitor["source_id"]: monitor["status"] for monitor in result["monitors"]}
        self.assertEqual(statuses, {"fresh": "protected", "long": "failing"})
        self.assertEqual((result["totals"]["protected"], result["totals"]["failing"]), (1, 1))
        self.assertEqual(result["protected"][0]["vendor"], "Cloudflare")
        self.assertFalse(result["protected"][0]["has_baseline"])
        self.assertIn("Blocked by a Cloudflare bot check for 30 h", result["failing"][0]["error"])

    def test_a_refusal_is_a_site_block_only_when_several_pages_on_the_host_are_refused(self):
        message = "AccessRefusedError: HTTP 403 refusal: refused this URL in a browser too"
        config = {"sources": [source("a", "https://blocked.test/a"), source("b", "https://blocked.test/b"), source("c", "https://files.test/old.pdf")]}
        latest = {"sources": {
            "a": {"1": row("https://blocked.test/a", fetch_error=message, error_since=iso(timedelta(hours=2)))},
            "b": {"2": row("https://blocked.test/b", fetch_error=message, error_since=iso(timedelta(hours=2)))},
            "c": {"3": row("https://files.test/old.pdf", fetch_error=message, error_since=iso(timedelta(hours=2)))},
        }}
        result = health.build_health(config, latest, [], {}, NOW)
        statuses = {monitor["source_id"]: monitor["status"] for monitor in result["monitors"]}
        self.assertEqual(statuses, {"a": "protected", "b": "protected", "c": "failing"})
        self.assertEqual(result["protected"][0]["reason"], "an HTTP 403 refusal")
        self.assertIn("may have been removed or made private", result["failing"][0]["error"])

        def refused(index, url, runs):
            return {"event_id": f"r{index}", "event_type": "FETCH_ERROR", "url": url, "timestamp": "2026-12-15T12:00:00+00:00",
                    "error_since": iso(timedelta(hours=2)), "error_runs": runs, "notification_id": f"episode-r{index}",
                    "evidence": {"error": message}}
        alerts = build_notifications({"error_alert_after_runs": 2, "events": [
            refused(1, "https://blocked.test/a", 2), refused(2, "https://blocked.test/b", 2), refused(3, "https://files.test/old.pdf", 2)]})
        # The blocked site waits out its grace period; the lone refused file alerts like any failing page.
        self.assertEqual([alert["event_id"] for alert in alerts], ["episode-r3"])

    def test_threshold_is_validated(self):
        base = SourceConfig.from_dict({
            "id": "x", "name": "x", "regulator": "r", "seed_urls": ["https://a.test/"],
            "allowed_prefixes": ["https://a.test/"], "allowed_domains": ["a.test"],
        })
        validate_config({"defaults": {"error_alert_after_runs": 4}, "sources": []}, [base])
        for bad in (0, 29, "2", True):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_config({"defaults": {"error_alert_after_runs": bad}, "sources": []}, [base])


if __name__ == "__main__":
    unittest.main()
