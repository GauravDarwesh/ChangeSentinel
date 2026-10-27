"""Regressions for the findings of the 25 Oct 2026 repository audit.

Each test names its finding (CS-nn) so a failure points back at the audit.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from regmon.change import html_comparison_hash, stabilize_volatile_markup, write_evidence
from regmon.config import SourceConfig

EBA_SOURCE = SourceConfig(
    id="eba-test", name="EBA", regulator="EBA",
    seed_urls=("https://docs.example.test/a",),
    allowed_prefixes=("https://docs.example.test/",),
    allowed_domains=("docs.example.test",),
)

DRUPAL_PAGE = """<html><head><script nonce="{nonce}">var x=1;</script></head><body>
<div class="search-block js-view-dom-id-{dom}" data-x="1"><p>Capital adequacy returns</p></div>
<form><input data-drupal-selector="form-{sel}" type="hidden" name="form_build_id" value="form-{build}"/>
<input type="hidden" name="form_token" value="{token}"/></form>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="{token}"/>
<meta name="csrf-token" content="{token}">
<script>jQuery.extend(drupalSettings, {{"views":{{"ajaxViews":{{"x":{{"view_dom_id":"{dom}"}}}}}}}});</script>
</body></html>"""


def drupal(dom: str, build: str, token: str, nonce: str, body: str = "") -> str:
    page = DRUPAL_PAGE.format(dom=dom, sel=build.lower(), build=build, token=token, nonce=nonce)
    return page.replace("Capital adequacy returns", body or "Capital adequacy returns")


class TestVolatileMarkup(unittest.TestCase):
    """CS-10: per-request CMS tokens made every fetch an HTML_SOURCE_CHANGED."""

    def test_two_fetches_of_the_same_drupal_page_have_one_signature(self):
        first = drupal("1718f68b9f25a59885d826cc301fb45220dd820481ee8aab94c660aa67276070",
                       "SxBpsAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-", "tok-111", "abc==")
        second = drupal("538d8945d5dd34751878226248aba073d714ee628d61b02f39355052f3017a3d",
                        "ZFvN2mO5AbCdEfGhIjKlMnOpQrStUvWxYz012345678", "tok-222", "xyz==")
        self.assertNotEqual(first, second)
        self.assertEqual(html_comparison_hash(first), html_comparison_hash(second))

    def test_a_real_content_change_still_changes_the_signature(self):
        dom = "1718f68b9f25a59885d826cc301fb45220dd820481ee8aab94c660aa67276070"
        build = "SxBpsAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-"
        self.assertNotEqual(
            html_comparison_hash(drupal(dom, build, "t", "n")),
            html_comparison_hash(drupal(dom, build, "t", "n", body="Leverage ratio returns")),
        )

    def test_ordinary_inputs_and_short_form_ids_are_kept(self):
        page = '<input name="q" value="capital"/><form id="form-search"></form>'
        self.assertEqual(stabilize_volatile_markup(page), page)
        self.assertNotEqual(
            html_comparison_hash('<input name="q" value="capital"/>'),
            html_comparison_hash('<input name="q" value="leverage"/>'),
        )


class TestEvidenceWrites(unittest.TestCase):
    """CS-24: a truncated evidence file was treated as complete forever."""

    def test_truncated_evidence_is_rewritten_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "data" / "evidence" / "abc.json"
            path.parent.mkdir(parents=True)
            path.write_text('{"event_id": "abc", "bef', encoding="utf-8")
            location = write_evidence(root, "CHANGED_URL", "abc", "https://example.test/a", "2026-10-27T00:00:00+00:00",
                                      {"normalized_hash": "1"}, {"normalized_hash": "2"}, "one", "two")
            self.assertEqual(location, "data/evidence/abc.json")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["event_id"], "abc")

    def test_complete_evidence_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "data" / "evidence" / "abc.json"
            path.parent.mkdir(parents=True)
            path.write_text('{"event_id": "abc", "original": true}', encoding="utf-8")
            write_evidence(root, "CHANGED_URL", "abc", "https://example.test/a", "t", None, None, "x", "y")
            self.assertTrue(json.loads(path.read_text(encoding="utf-8"))["original"])


class TestDiscoveryBodyCap(unittest.TestCase):
    """CS-07: link discovery held whole bodies in memory with no cap."""

    def _response(self, body: bytes, declared: int | None = None) -> requests.Response:
        response = requests.Response()
        response.status_code = 200
        response.headers["content-type"] = "text/html; charset=utf-8"
        if declared is not None:
            response.headers["content-length"] = str(declared)
        response.url = "https://docs.example.test/a"
        response.raw = __import__("io").BytesIO(body)
        return response

    def test_an_oversized_page_is_skipped_without_reading_it_all(self):
        from regmon import discovery

        big = b"<a href='/x'>x</a>" + b" " * 2048
        with patch.object(discovery, "DISCOVERY_MAX_HTML_BYTES", 1024), \
                patch("regmon.discovery.requests.get", return_value=self._response(big)):
            url, links, failure = discovery._fetch_links("https://docs.example.test/a", EBA_SOURCE, 5)
        self.assertEqual((links, failure), ([], None))

    def test_a_declared_oversized_page_is_skipped(self):
        from regmon import discovery

        response = self._response(b"<a href='/x'>x</a>", declared=50 * 1024 * 1024)
        self.assertIsNone(discovery._bounded_html(response, "https://docs.example.test/a"))

    def test_a_normal_page_is_decoded_and_parsed(self):
        from regmon import discovery

        response = self._response("<a href='/b'>é</a>".encode("utf-8"))
        self.assertEqual(discovery._bounded_html(response, "https://docs.example.test/a"), "<a href='/b'>é</a>")


class FakePost:
    def __init__(self, status: int = 200, text: str = "ok", headers: dict | None = None):
        self.status_code, self.text, self.headers = status, text, headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


NOTE = {
    "event_id": "evt-1", "kind": "CHANGED_URL", "variant": "ai", "url": "https://www.federalreserve.gov/x",
    "topic": "Reporting", "summary": "Summary", "impact": "Impact", "reason": "Reason", "priority": 4, "tags": ["warning"],
}


class TestDeliveryVerification(unittest.TestCase):
    """CS-04: a 2xx with {"ok": false}, or a redirect, was recorded as delivered."""

    def _send(self, name: str, env: dict, response: FakePost):
        from regmon import channels

        with patch("regmon.channels.requests.post", return_value=response) as post:
            channel = next(c for c in channels.configured_channels(env, lambda n: "") if c.name == name)
            channel.send(NOTE, "")
        self.assertIs(post.call_args.kwargs["allow_redirects"], False)

    def test_slack_ok_false_is_a_failure(self):
        env = {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/triggers/T/1/x"}
        with self.assertRaisesRegex(RuntimeError, "invalid_blocks"):
            self._send("slack", env, FakePost(200, '{"ok": false, "error": "invalid_blocks"}'))
        self._send("slack", env, FakePost(200, "ok"))
        self._send("slack", env, FakePost(200, '{"ok": true}'))

    def test_a_redirected_webhook_is_a_failure(self):
        env = {"ALERT_WEBHOOK_URL": "https://hooks.example.com/x"}
        with self.assertRaisesRegex(RuntimeError, "redirect"):
            self._send("webhook", env, FakePost(302, "", {"Location": "https://elsewhere.example.com/"}))

    def test_an_error_names_the_status_and_body(self):
        env = {"TEAMS_WEBHOOK_URL": "https://prod.example.com/workflows/x"}
        with self.assertRaisesRegex(RuntimeError, "HTTP 400: Bad card"):
            self._send("teams", env, FakePost(400, "Bad card"))

    def test_ntfy_checks_redirects_and_shortens_long_messages(self):
        from regmon import notify

        long_note = dict(NOTE, summary="é" * 5000)
        with patch("regmon.notify.requests.post", return_value=FakePost(200, "{}")) as post:
            notify.publish(long_note, "topic", "https://ntfy.sh")
        message = post.call_args.kwargs["json"]["message"]
        self.assertLessEqual(len(message.encode("utf-8")), notify.NTFY_MAX_MESSAGE_BYTES)
        self.assertIn("Event ID: evt-1", message)
        self.assertIs(post.call_args.kwargs["allow_redirects"], False)
        with patch("regmon.notify.requests.post", return_value=FakePost(301, "", {"Location": "x"})), \
                self.assertRaises(RuntimeError):
            notify.publish(NOTE, "topic", "https://ntfy.sh")


class TestChannelIsolation(unittest.TestCase):
    """CS-05: one malformed optional channel URL stopped the run before enqueue."""

    def test_a_bad_channel_is_reported_and_the_others_still_work(self):
        from regmon import notify

        errors: list[str] = []
        env = {"SLACK_WEBHOOK_URL": "http://hooks.slack.com/x", "ALERT_WEBHOOK_URL": "https://hooks.example.com/x"}
        names = [channel.name for channel in notify.enabled_channels("topic", "https://ntfy.sh", env=env, errors=errors)]
        self.assertEqual(names, ["ntfy", "webhook"])
        self.assertEqual(len(errors), 1)
        self.assertIn("SLACK_WEBHOOK_URL", errors[0])

    def test_enqueue_only_never_builds_channels(self):
        from regmon import notify

        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "report.json").write_text(json.dumps({"events": [{
                "event_id": "e1", "event_type": "CHANGED_URL", "url": "https://example.test/a",
                "source_id": "s", "timestamp": "2026-10-27T00:00:00+00:00",
            }]}), encoding="utf-8")
            saved = {}
            with patch.object(notify, "DATA", data), \
                    patch.object(notify, "load_state", return_value={"sent_events": {}}), \
                    patch.object(notify, "load_outbox", return_value={"pending_events": {}}), \
                    patch.object(notify, "save_outbox", side_effect=lambda value: saved.update(value)), \
                    patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "http://insecure.example.com/x"}), \
                    patch("sys.argv", ["notify", "--enqueue-only"]):
                notify.main()
            outbox = saved
        self.assertIn("e1", outbox["pending_events"])

    def test_failed_attempts_are_recorded_on_the_queued_alert(self):
        from regmon import channels, notify

        def refuse(_notification, _dashboard):
            raise RuntimeError("HTTP 503")

        outbox = {"pending_events": {"evt-1": dict(NOTE)}}
        state = {"sent_events": {}}
        for _ in range(2):
            notify.deliver_pending(outbox, state, "", "", channels=[channels.Channel("slack", refuse)])
        queued = outbox["pending_events"]["evt-1"]
        self.assertEqual(queued["delivery_attempts"], 2)
        self.assertIn("HTTP 503", queued["last_errors"]["slack"])
        self.assertTrue(queued["first_failed_at"])


class TestConfigWrites(unittest.TestCase):
    """CS-03 / CS-22 / CS-54: config/sources.json writes are validated and atomic."""

    def test_an_invalid_config_is_never_written(self):
        from regmon.register_monitor import write_sources_config

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text('{"sources": []}\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                write_sources_config(path, {"sources": [], "unexpected_top_level_key": True})
            self.assertEqual(path.read_text(encoding="utf-8"), '{"sources": []}\n')

    def test_a_failed_write_leaves_the_previous_file(self):
        from regmon.register_monitor import write_sources_config

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text('{"sources": []}\n', encoding="utf-8")
            with patch("regmon.fsutil.os.replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
                write_sources_config(path, {"sources": []})
            self.assertEqual(path.read_text(encoding="utf-8"), '{"sources": []}\n')
            self.assertEqual([item.name for item in Path(tmp).iterdir()], ["sources.json"])

    def test_crlf_issue_bodies_are_read(self):
        from regmon import register_monitor

        event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX, "user": {"login": "owner"},
                           "body": register_monitor.REQUEST_MARKER + "\r\nURL: https://example.test/a\r\nName: A page\r\n"}}
        url, name, _include, _ignore = register_monitor.request_from_issue(event, "owner/repo")
        self.assertEqual((url, name), ("https://example.test/a", "A page"))

    def test_a_host_resolving_to_a_private_address_is_refused_at_registration(self):
        from regmon import register_monitor

        with patch("regmon.security.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("10.0.0.7", 443))]), \
                self.assertRaisesRegex(ValueError, "non-public"):
            register_monitor._resolve_redirects("https://intranet.example.com/page")

    def test_an_unresolvable_host_is_not_a_registration_failure(self):
        from regmon import register_monitor
        from regmon.security import DNSResolutionError

        with patch("regmon.register_monitor.validate_public_http_url", side_effect=DNSResolutionError("no answer")):
            self.assertEqual(register_monitor._resolve_redirects("https://new.example.com/p"), "https://new.example.com/p")


class TestDeadlines(unittest.TestCase):
    """CS-37 / CS-38 / CS-40 / CS-41."""

    def test_day_first_numeric_dates(self):
        from datetime import date
        from regmon.deadlines import parse_date

        self.assertEqual(parse_date("30/06/2026"), date(2026, 6, 30))
        self.assertEqual(parse_date("06/30/2026"), date(2026, 6, 30))
        self.assertEqual(parse_date("05/06/2026"), date(2026, 5, 6))  # ambiguous: US order, as before

    def test_a_date_split_across_lines_is_found(self):
        from datetime import date
        from regmon.deadlines import dates_in_text

        hits = dates_in_text("Comments must be received on\nor before March 2, 2027.", today=date(2026, 10, 27))
        self.assertIn("2027-03-02", [hit["date"] for hit in hits])

    def _tree(self, tmp: str) -> tuple[Path, Path]:
        data = Path(tmp) / "data"
        data.mkdir()
        config = Path(tmp) / "sources.json"
        config.write_text(json.dumps({"sources": []}), encoding="utf-8")
        (data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {}}), encoding="utf-8")
        return data, config

    def test_an_unreadable_config_keeps_the_published_calendar(self):
        from regmon import deadlines

        with tempfile.TemporaryDirectory() as tmp:
            data, config = self._tree(tmp)
            deadlines.write(data, config)
            before = (data / "calendar.json").read_text(encoding="utf-8")
            config.write_text('{"sources": [', encoding="utf-8")
            with self.assertRaises(ValueError):
                deadlines.write(data, config)
            self.assertEqual((data / "calendar.json").read_text(encoding="utf-8"), before)

    def test_a_feed_format_change_reaches_the_published_files(self):
        from regmon import deadlines

        with tempfile.TemporaryDirectory() as tmp:
            data, config = self._tree(tmp)
            self.assertTrue(deadlines.write(data, config))
            self.assertFalse(deadlines.write(data, config))
            with patch.object(deadlines, "FEED_VERSION", deadlines.FEED_VERSION + 1):
                self.assertTrue(deadlines.write(data, config))
            self.assertTrue(deadlines.write(data, config, force=True))


class TestHealthAndSchedule(unittest.TestCase):
    """CS-43 / CS-44."""

    def test_an_unreadable_inventory_does_not_publish_an_all_clear(self):
        from regmon import health

        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            config = data / "sources.json"
            config.write_text(json.dumps({"sources": []}), encoding="utf-8")
            (data / "latest.json").write_text('{"schema_version": 2, "sour', encoding="utf-8")
            with self.assertRaises(ValueError):
                health.write(data, config)
            self.assertFalse((data / "health.json").exists())

    def test_a_scan_time_in_the_future_is_due_and_overdue(self):
        from datetime import datetime, timedelta, timezone
        from regmon import schedule

        now = datetime(2026, 10, 27, 7, 0, tzinfo=timezone.utc)
        future = now + timedelta(days=2)
        cadence = schedule.Cadence.from_source({})
        self.assertTrue(schedule.is_due(cadence, future, now))
        self.assertLess(schedule.overdue_after(cadence, future, now), now)


class TestScoutRobots(unittest.TestCase):
    """CS-13 / CS-15 / CS-16 / CS-18."""

    def setUp(self):
        from test_scout import config_for

        self.config = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}])
        self.regulator, self.defaults = self.config.regulators[0], self.config.defaults

    def test_a_byte_order_mark_does_not_disable_the_rules(self):
        from regmon.scout import robots

        policy = robots.parse("﻿User-agent: *\nDisallow: /private\n")
        self.assertFalse(policy.allowed("/private"))
        self.assertTrue(policy.allowed("/public"))

    def test_rate_limited_robots_is_not_allow_all(self):
        from regmon.scout.net import AccessBlocked
        from test_scout import FakeSite

        site = FakeSite({"https://reg.example.org/feed": b"x"}, robots_txt=(429, {}, b""))
        with self.assertRaises(AccessBlocked):
            site.client(self.regulator, self.defaults).get("https://reg.example.org/feed")

    def test_one_failed_robots_request_is_retried(self):
        from test_scout import FakeSite

        answers = [(503, {}, b""), (200, {}, b"User-agent: *\nDisallow: /search/\n")]
        site = FakeSite({"https://reg.example.org/feed": b"x"})
        original = site.transport

        def transport(url, headers, timeout, cap):
            if url.endswith("/robots.txt"):
                site.calls.append(url)
                return answers.pop(0)
            return original(url, headers, timeout, cap)

        site.transport = transport
        self.assertEqual(site.client(self.regulator, self.defaults).get("https://reg.example.org/feed").body, b"x")

    def test_listing_items_that_share_the_listing_path_are_candidates(self):
        from regmon.scout.sweep import in_candidate_scope
        from test_scout import config_for

        config = config_for([{"id": "l", "type": "listing", "label": "L", "url": "https://reg.example.org/pubs"}])
        regulator, channel = config.regulators[0], config.regulators[0].channels[0]
        self.assertTrue(in_candidate_scope("https://reg.example.org/pubs?docId=123", regulator, channel))
        self.assertFalse(in_candidate_scope("https://reg.example.org/pubs?page=2", regulator, channel))


class TestQualityGates(unittest.TestCase):
    """CS-19: the golden corpus passed while checking nothing."""

    def test_an_empty_or_mostly_skipped_corpus_fails(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("golden", Path(__file__).resolve().parents[1] / "scripts" / "golden_corpus_check.py")
        golden = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(golden)
        self.assertTrue(golden.gate_failures({"eligible": 120, "checked": 0, "skipped_old_version": 120}))
        self.assertEqual(golden.gate_failures({"eligible": 120, "checked": 0, "skipped_old_version": 120}, allow_empty=True), [])
        self.assertTrue(golden.gate_failures({"eligible": 100, "checked": 30, "skipped_old_version": 70}))
        self.assertEqual(golden.gate_failures({"eligible": 100, "checked": 100, "skipped_old_version": 0}), [])


class TestMcpPaths(unittest.TestCase):
    """CS-48: recorded locations could read any file in the checkout."""

    def test_recorded_locations_stay_inside_data(self):
        from regmon.mcp_server import Record, ToolError

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data").mkdir()
            (root / "config").mkdir()
            (root / "config" / "sources.json").write_text('{"sources": []}', encoding="utf-8")
            record = Record(root)
            with self.assertRaises(ToolError):
                record.data_path("config/sources.json")
            with self.assertRaises(ToolError):
                record.data_path("data/../.git/config")
            self.assertEqual(record.data_json(".git/config", "fallback"), "fallback")
            self.assertEqual(record.data_path("data/evidence/x.json"), (root / "data" / "evidence" / "x.json").resolve())


NODE = __import__("shutil").which("node")
ROOT = Path(__file__).resolve().parents[1]


def run_js(body: str):
    import subprocess

    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestDashboardLib(unittest.TestCase):
    """CS-20 / CS-21."""

    def test_no_regex_lookbehind_in_classic_scripts(self):
        import re

        for name in ("dashboard-lib.js", "dashboard.js"):
            source = (ROOT / name).read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"\(\?<[=!]", source), f"{name} uses a regex lookbehind (Safari <= 16.3 cannot parse it)")

    def test_report_codes_drop_a_trailing_edition_year(self):
        self.assertEqual(run_js("console.log(JSON.stringify(L.reportCodes('BCAR 2027 and BCAR-2026')));"), ["BCAR"])

    def test_changed_lines_beginning_with_dashes_or_pluses_are_kept(self):
        diff = "--- before\n+++ after\n@@ -1,3 +1,3 @@\n keep\n--- separate the sections\n+++ add the appendix\n"
        parsed = run_js("console.log(JSON.stringify(L.parseUnifiedDiff(" + json.dumps(diff) + ")));")
        lines = parsed["hunks"][0]["lines"]
        self.assertEqual(lines, [
            {"type": "ctx", "text": "keep"},
            {"type": "del", "text": "-- separate the sections"},
            {"type": "add", "text": "++ add the appendix"},
        ])


if __name__ == "__main__":
    unittest.main()
