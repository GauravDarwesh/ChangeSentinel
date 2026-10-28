"""Regressions for the 25 Oct 2026 audit findings fixed after #221 and #238.

Each test names its finding. Together with tests/test_audit_2026_10_25.py they
cover every finding that applied to main and was changed.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from engine_harness import Sandbox, ok

ROOT = Path(__file__).resolve().parents[1]


class TestDoclingTimeoutsExpire(unittest.TestCase):
    """CS-27 / CS-142."""

    def setUp(self):
        from regmon import docling_extractor

        self.module = docling_extractor
        self.addCleanup(docling_extractor.configure_timeout_registry, None)

    def test_a_learned_timeout_is_retried_after_thirty_days(self):
        digest = "a" * 64
        recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(timespec="seconds")
        old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(timespec="seconds")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "docling-timeouts.json"
            for recorded, skipped in ((recent, True), (old, False)):
                path.write_text(json.dumps({"time_budget_exhausted": {digest: {"recorded_at": recorded}}}), encoding="utf-8")
                self.module.configure_timeout_registry(path)
                self.assertIs(self.module._known_timeout(digest), skipped, recorded)

    def test_the_registry_is_versioned_and_a_future_version_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "docling-timeouts.json"
            self.module.configure_timeout_registry(path)
            self.module._remember_timeout("b" * 64, 120.0, 10)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["schema_version"], 1)
            path.write_text(json.dumps({"schema_version": 9, "time_budget_exhausted": {}}), encoding="utf-8")
            self.module.configure_timeout_registry(path)
            self.module._remember_timeout("c" * 64, 120.0, 10)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["schema_version"], 9)


class TestPdfGridLookups(unittest.TestCase):
    """CS-29: indexed lookups keep first-match order."""

    def test_owner_returns_the_first_covering_cell(self):
        from regmon.pdf_grid import Grid, GridCell

        first = GridCell(0, 2, 0, 2, (0, 0, 20, 20))
        overlapping = GridCell(1, 2, 1, 2, (10, 10, 20, 20))
        grid = Grid(bbox=(0, 0, 20, 20), rows=2, cols=2, cells=[first, overlapping])
        self.assertIs(grid.owner(1, 1), first)
        self.assertIsNone(grid.owner(5, 5))
        grid.cells.append(GridCell(2, 3, 0, 1, (0, 20, 10, 30)))
        self.assertIs(grid.owner(2, 0), grid.cells[-1])   # the index follows new cells


class TestPdfGridFailuresAreLogged(unittest.TestCase):
    """CS-30."""

    def test_a_table_detection_failure_says_so(self):
        from regmon import pdf_grid

        page = MagicMock(page_number=7)
        page.find_tables.side_effect = RuntimeError("bad content stream")
        with self.assertLogs("regmon.pdf_grid", level="WARNING") as logs:
            self.assertEqual(pdf_grid.build_grids(page), [])
        self.assertIn("page 7", logs.output[0])


class TestWebhookSignatures(unittest.TestCase):
    """CS-33."""

    def test_the_timestamp_is_inside_the_signed_bytes(self):
        import hashlib
        import hmac

        from regmon.channels import signature_headers

        body = b'{"schema":"changesentinel.alert.v1"}'
        headers = signature_headers("x" * 32, body, now=1_800_000_000)
        self.assertEqual(headers["X-ChangeSentinel-Timestamp"], "1800000000")
        expected = hmac.new(b"x" * 32, b"1800000000." + body, hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-ChangeSentinel-Signature-256"], "t=1800000000,v1=" + expected)
        # Receivers built before the timestamp keep working.
        self.assertEqual(headers["X-ChangeSentinel-Signature"], "sha256=" + hmac.new(b"x" * 32, body, hashlib.sha256).hexdigest())

    def test_a_short_secret_is_warned_about_but_still_delivers(self):
        from regmon.channels import configured_channels

        with patch("builtins.print") as printed:
            channels = configured_channels({"ALERT_WEBHOOK_URL": "https://hooks.example.test/x", "ALERT_WEBHOOK_SECRET": "short"}, lambda n: "", [])
        self.assertEqual([channel.name for channel in channels], ["webhook"])
        self.assertIn("shorter than 16", printed.call_args[0][0])


class TestUndeliveredAlertsInHealth(unittest.TestCase):
    """CS-35 / CS-42."""

    def test_a_partly_delivered_alert_is_listed(self):
        from regmon import health

        outbox = {"pending_events": {"e1": {"kind": "CHANGED_URL", "url": "https://x.test/a", "delivered_channels": {"ntfy": "t"},
                                             "delivery_attempts": 3, "first_failed_at": "2026-10-27T00:00:00Z", "last_errors": {"slack": "HTTP 500"}}}}
        result = health.build_health({}, {}, [], {}, datetime.now(timezone.utc), outbox)
        self.assertEqual(result["totals"]["undelivered_alerts"], 1)
        self.assertEqual(result["totals"]["partially_delivered_alerts"], 1)
        self.assertEqual(result["undelivered_alerts"][0]["delivered_to"], ["ntfy"])
        self.assertEqual(result["undelivered_alerts"][0]["last_errors"], {"slack": "HTTP 500"})
        self.assertNotIn("stale_after_hours", result["thresholds"])


class TestAlertsSurviveSchemaDrift(unittest.TestCase):
    """CS-36."""

    def test_an_analysis_missing_fields_still_alerts(self):
        from regmon.notify import build_notifications

        report = {"schema_version": 2, "events": [{"event_id": "e1", "event_type": "CHANGED_URL", "url": "https://x.test/a",
                                                   "url_id": "u1", "source_id": "s", "timestamp": "2026-10-28T00:00:00Z"}],
                  "ai_results": [{"event_id": "e1", "event": "CHANGED_URL", "url": "https://x.test/a", "source_id": "s",
                                  "ai": {"status": "ok", "analysis": {"relevant": True, "summary": "Deadline moved"}}}]}
        notes = build_notifications(report)
        ai = [note for note in notes if note.get("variant") == "ai"]
        self.assertEqual(len(ai), 1)
        self.assertEqual(ai[0]["summary"], "Deadline moved")
        self.assertEqual(ai[0]["topic"], "Regulatory change")


class TestDeadlineWinnerIsStable(unittest.TestCase):
    """CS-39."""

    def test_the_documents_own_date_wins_over_the_ai_on_the_same_change(self):
        from regmon import deadlines

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "evidence").mkdir(parents=True)
            (root / "config").mkdir()
            evidence = {"diff": "+The amendments are effective March 2, 2027."}
            (root / "data" / "evidence" / "e1.json").write_text(json.dumps(evidence), encoding="utf-8")
            (root / "config" / "sources.json").write_text(json.dumps({"sources": [{"id": "s", "active": True}]}), encoding="utf-8")
            latest = {"schema_version": 2, "sources": {"s": {"u1": {"url_id": "u1", "canonical_url": "https://x.test/a", "active": True,
                      "change_history": [{"event_id": "e1", "event_type": "CHANGED_URL", "timestamp": "2026-10-28T00:00:00Z",
                                          "evidence_location": "data/evidence/e1.json"}]}}}}
            (root / "data" / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
            analysis = {"relevant": True, "effective_date": "March 2, 2027", "topic": "Comment period"}
            with patch.object(deadlines, "_ai_results", return_value={"e1": analysis}):
                calendar = deadlines.build(root / "data", root / "config" / "sources.json", today=datetime(2026, 10, 28).date())
        hits = [entry for entry in calendar["entries"] if entry["date"] == "2027-03-02"]
        self.assertEqual(len(hits), 1, hits)            # one entry for the AI and the text stating the same date
        self.assertEqual(hits[0]["basis"], "text")      # and it quotes the document, not the AI
        self.assertIn("effective March 2, 2027", hits[0]["quote"])


class TestNeverScannedMonitorsAreOverdue(unittest.TestCase):
    """CS-45."""

    def test_a_registered_monitor_with_no_scan_is_overdue_after_its_schedule(self):
        from regmon import schedule

        now = datetime(2026, 10, 28, 12, tzinfo=timezone.utc)
        config = {"sources": [
            {"id": "fresh", "name": "Fresh", "registered_at": "2026-10-28T10:00:00Z"},
            {"id": "stuck", "name": "Stuck", "registered_at": "2026-10-25T10:00:00Z"},
            {"id": "legacy", "name": "Legacy"},
            {"id": "off", "name": "Off", "active": False, "registered_at": "2026-10-01T00:00:00Z"},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            overdue = schedule.overdue_sources(config, Path(tmp), now)
        self.assertEqual([entry["source_id"] for entry in overdue], ["stuck"])
        self.assertTrue(overdue[0]["never_scanned"])
        self.assertIsNone(overdue[0]["last_scan"])

    def test_registration_records_when_and_config_checks_it(self):
        from regmon.config import is_active, validate_config

        self.assertTrue(is_active({"id": "x"}))
        self.assertFalse(is_active({"id": "x", "active": False}))
        base = {"id": "s", "name": "S", "regulator": "R", "seed_urls": ["https://x.test/a"], "allowed_prefixes": ["https://x.test/"],
                "allowed_domains": ["x.test"]}
        from regmon.config import SourceConfig

        with self.assertRaises(ValueError):
            source = dict(base, registered_at="last tuesday")
            validate_config({"version": 4, "sources": [source]}, [SourceConfig.from_dict(source)])


class TestDigestsRetryAndIsolate(unittest.TestCase):
    """CS-46 / CS-143."""

    def test_a_failed_digest_is_not_marked_done_and_does_not_stop_others(self):
        from regmon import digest

        now = datetime(2026, 10, 28, 9, 30, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            (root / "data" / "digests").mkdir(parents=True)
            (root / "config" / "sources.json").write_text(json.dumps({"sources": []}), encoding="utf-8")
            specs = [{"id": "bad", "workspace": "A"}, {"id": "good", "workspace": "B"}]
            moment = now - timedelta(hours=1)
            index = {"schema_version": 1, "digests": {d["id"]: {"latest_moment": (moment - timedelta(days=1)).isoformat(), "history": []} for d in specs}}
            (root / "data" / "digests" / "index.json").write_text(json.dumps(index), encoding="utf-8")

            def fake_build(spec, when, *_a, **_k):
                if spec["id"] == "bad":
                    raise RuntimeError("history unreadable")
                return {"id": f"{spec['id']}-1", "period": {"from": "a", "to": "b"}, "counts": {}, "overview": "", "digest_id": spec["id"]}

            with patch.object(digest, "validate_digests", return_value=[dict(d, frequency="daily") for d in specs]), \
                    patch.object(digest, "latest_moment", return_value=moment), patch.object(digest, "build", side_effect=fake_build), \
                    patch.object(digest, "Regions"), patch("builtins.print"):
                built = digest.run_due(root / "data", root / "config", now=now, enqueue=False)
            saved = json.loads((root / "data" / "digests" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual([record["id"] for record in built], ["good-1"])
        self.assertEqual(saved["digests"]["bad"]["latest_moment"], (moment - timedelta(days=1)).isoformat())
        self.assertEqual(saved["digests"]["good"]["latest_moment"], moment.isoformat())
        self.assertFalse(Path(saved["digests"]["good"]["history"][0]["path"]).is_absolute())


class TestScopeResolvesDotSegments(unittest.TestCase):
    """CS-50."""

    def test_a_dot_segment_cannot_climb_out_of_an_allowed_prefix(self):
        from regmon.config import SourceConfig
        from regmon.discovery import in_scope

        source = SourceConfig(id="s", name="S", regulator="R", seed_urls=("https://x.test/forms/",),
                              allowed_prefixes=("https://x.test/forms/",), allowed_domains=("x.test",))
        self.assertTrue(in_scope("https://x.test/forms/fr-y9c.pdf", source))
        self.assertFalse(in_scope("https://x.test/forms/../admin/users", source))
        self.assertFalse(in_scope("https://x.test/forms/%2e%2e/admin/users", source))
        self.assertTrue(in_scope("https://x.test/forms/a/../fr-y9c.pdf", source))

    def test_a_redirect_through_dot_segments_is_refused(self):
        from regmon.fetch import fetch

        redirect = MagicMock(status_code=302, headers={"location": "/forms/../admin"})
        with patch("regmon.fetch.requests.get", return_value=redirect), patch("regmon.fetch.validate_public_http_url"):
            with self.assertRaisesRegex(ValueError, "outside allowed URL prefixes"):
                fetch("https://x.test/forms/a", allowed_domains=("x.test",), allowed_prefixes=("https://x.test/forms/",), attempts=1)


class TestFetchRedirectLimits(unittest.TestCase):
    """CS-150: the redirect loop and hop limit had no tests."""

    def test_a_redirect_loop_is_refused(self):
        from regmon.fetch import fetch

        hop = lambda target: MagicMock(status_code=302, headers={"location": target})
        responses = [hop("https://x.test/b"), hop("https://x.test/a")]
        with patch("regmon.fetch.requests.get", side_effect=responses), patch("regmon.fetch.validate_public_http_url"):
            with self.assertRaisesRegex(ValueError, "Redirect loop"):
                fetch("https://x.test/a", allowed_domains=("x.test",), attempts=1)

    def test_more_than_five_redirects_are_refused(self):
        from regmon.fetch import MAX_REDIRECTS, fetch

        responses = [MagicMock(status_code=301, headers={"location": f"https://x.test/{n}"}) for n in range(1, MAX_REDIRECTS + 3)]
        with patch("regmon.fetch.requests.get", side_effect=responses), patch("regmon.fetch.validate_public_http_url"):
            with self.assertRaisesRegex(ValueError, f"Exceeded {MAX_REDIRECTS} redirects"):
                fetch("https://x.test/0", allowed_domains=("x.test",), attempts=1)

    def test_validators_are_not_sent_to_a_redirect_target(self):
        from regmon.fetch import fetch

        final = MagicMock(status_code=200, headers={"content-type": "text/html"})
        final.iter_content.return_value = [b"<html>ok</html>"]
        final.raw = MagicMock()
        calls = []

        def get(url, **kwargs):
            calls.append(kwargs["headers"])
            return MagicMock(status_code=302, headers={"location": "https://x.test/b"}) if len(calls) == 1 else final

        with patch("regmon.fetch.requests.get", side_effect=get), patch("regmon.fetch.validate_public_http_url"):
            try:
                fetch("https://x.test/a", allowed_domains=("x.test",), attempts=1, etag='"v1"')
            except Exception:
                pass
        self.assertIn("If-None-Match", calls[0])
        self.assertNotIn("If-None-Match", calls[1])


class TestCrawlerAllowlist(unittest.TestCase):
    """CS-53."""

    def test_only_known_crawlers_can_be_configured_or_run(self):
        from regmon.config import SourceConfig, validate_config
        from regmon.discovery_browser import _stealth_discover

        source = {"id": "s", "name": "S", "regulator": "R", "seed_urls": ["https://x.test/a"], "allowed_prefixes": ["https://x.test/"],
                  "allowed_domains": ["x.test"], "crawler": "/bin/sh"}
        with self.assertRaisesRegex(ValueError, "crawler must be one of"):
            validate_config({"version": 4, "sources": [source]}, [SourceConfig.from_dict(source)])
        crafted = SourceConfig(id="s", name="S", regulator="R", seed_urls=("https://x.test/a",), allowed_prefixes=("https://x.test/",),
                               allowed_domains=("x.test",), crawler="/bin/sh")
        with self.assertRaisesRegex(ValueError, "refusing to run"):
            _stealth_discover(crafted, Path(tempfile.gettempdir()))


class TestRegistrationCanonicalOnFailure(unittest.TestCase):
    """CS-57."""

    def test_a_failed_redirect_probe_still_returns_the_canonical_address(self):
        from regmon import register_monitor

        with patch.object(register_monitor, "validate_public_http_url"), \
                patch.object(register_monitor.requests, "get", side_effect=OSError("connection reset")):
            self.assertEqual(register_monitor._resolve_redirects("HTTPS://X.Test/Forms/?utm_source=a&b=1"),
                             register_monitor.canonicalize_url("HTTPS://X.Test/Forms/?utm_source=a&b=1"))


class TestBoundedDiffAndAtomicWrites(unittest.TestCase):
    """CS-23 / CS-153."""

    def test_a_failed_write_leaves_the_old_file(self):
        from regmon.fsutil import atomic_write_text

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text('{"good": true}', encoding="utf-8")
            with patch("regmon.fsutil.os.replace", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    atomic_write_text(path, '{"half": ')
            self.assertEqual(path.read_text(encoding="utf-8"), '{"good": true}')
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["state.json"])


class TestReportAndBaselineAgree(unittest.TestCase):
    """CS-145: every event in a scan's report is on its URL's timeline."""

    def test_events_are_in_the_inventory(self):
        with Sandbox() as sandbox:
            sandbox.scan(lambda *a, **k: ok(b"<html><body><main><p>Version one of the rule.</p></main></body></html>"))
            result = sandbox.scan(lambda *a, **k: ok(b"<html><body><main><p>Version two of the rule.</p></main></body></html>"))
            inventory = sandbox.inventory()
            for event in result["report"]["events"]:
                if event["event_type"] in {"CHANGED_URL", "NEW_URL"}:
                    timeline = {entry.get("event_id") for entry in inventory[event["url_id"]].get("change_history") or []}
                    self.assertIn(event["event_id"], timeline)


class TestNotifierCommandLine(unittest.TestCase):
    """CS-144: the two notifier commands the workflow runs, as the workflow runs them."""

    def test_enqueue_then_deliver_with_no_channel_keeps_the_alert_queued(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(ROOT / "regmon", root / "regmon", ignore=shutil.ignore_patterns("__pycache__"))
            (root / "data").mkdir()
            (root / "config").mkdir()
            shutil.copy(ROOT / "config" / "sources.json", root / "config" / "sources.json")
            report = {"schema_version": 2, "generated_at": "2026-10-28T00:00:00Z", "events": [{
                "event_id": "e" * 64, "event_type": "CHANGED_URL", "url": "https://example.test/page", "url_id": "u1",
                "source_id": "not-configured", "timestamp": "2026-10-28T00:00:00Z"}], "ai_results": []}
            (root / "data" / "report.json").write_text(json.dumps(report), encoding="utf-8")
            env = {k: v for k, v in os.environ.items() if not k.startswith(("NTFY", "SLACK", "TEAMS", "ALERT_WEBHOOK"))}
            env.update({"NTFY_TOPIC": "", "PYTHONPATH": str(root)})
            run = lambda *args: subprocess.run([sys.executable, "-m", "regmon.notify", *args], cwd=root, env=env,
                                               capture_output=True, text=True, timeout=120)
            first = run("--enqueue-only")
            self.assertEqual(first.returncode, 0, first.stderr)
            outbox = json.loads((root / "data" / "notification-outbox.json").read_text(encoding="utf-8"))
            self.assertIn("e" * 64, json.dumps(outbox["pending_events"]))
            second = run("--deliver-only")
            self.assertEqual(second.returncode, 0, second.stderr)
            outbox = json.loads((root / "data" / "notification-outbox.json").read_text(encoding="utf-8"))
            self.assertTrue(outbox["pending_events"])


class TestCadenceAcrossDaylightSaving(unittest.TestCase):
    """CS-151: a business-hours monitor in a DST zone keeps its local hours across the change."""

    def test_new_york_business_hours_through_the_november_change(self):
        from regmon import schedule

        cadence = schedule.Cadence.from_source({"check_every_hours": 24, "check_hours": [9, 17], "check_timezone": "America/New_York"})
        # Saturday 31 Oct (EDT, UTC-4) then Monday 2 Nov (EST, UTC-5).
        before = schedule.next_due(cadence, datetime(2026, 10, 30, 14, tzinfo=timezone.utc), datetime(2026, 10, 30, 14, tzinfo=timezone.utc))
        after = schedule.next_due(cadence, datetime(2026, 11, 2, 15, tzinfo=timezone.utc), datetime(2026, 11, 2, 15, tzinfo=timezone.utc))
        from zoneinfo import ZoneInfo

        for due in (before, after):
            local = due.astimezone(ZoneInfo("America/New_York"))
            self.assertTrue(9 <= local.hour < 17, local)


class TestNodeIsRequiredInCi(unittest.TestCase):
    """CS-147: the dashboard library tests skip without Node; in CI that would hide 100+ tests."""

    def test_node_is_present_when_running_in_ci(self):
        if os.getenv("CI") != "true":
            self.skipTest("only enforced in CI")
        self.assertIsNotNone(shutil.which("node"), "CI must install Node so tests/test_dashboard_lib.py runs")


if __name__ == "__main__":
    unittest.main()
