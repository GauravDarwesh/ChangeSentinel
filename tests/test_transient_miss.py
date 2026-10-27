"""A good URL that answers 404/5xx once is rechecked, then held for a scan.

Regression for FFIEC 009a instructions (27 Oct 2026) and FFIEC 051 (26 Oct
2026): behind Cloudflare, one browser load answered HTTP 404 for a PDF that
opens fine everywhere else, and the dashboard showed "Couldn't fetch" until
someone re-ran the scan.
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import requests

from engine_harness import Sandbox, html, ok
from regmon.fetch import HTTPStatusError
from regmon.notify import build_notifications

PAGE = html("<p>Reporting deadline: 30 days after quarter end.</p>")


def not_found(*_args, **_kwargs):
    raise HTTPStatusError("HTTP 404 for https://example.test/policy (loaded in a browser)", 404, "text/html", b"<html>Not found</html>")


def sequence(*answers):
    """A fetch that gives each answer in turn (an exception is raised)."""
    queue = list(answers)

    def fetch(*_args, **_kwargs):
        answer = queue.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer
    return fetch


class TransientMissTests(unittest.TestCase):
    def scan_at(self, sandbox, hours, fetch):
        with patch("regmon.engine.datetime") as clock:
            clock.now.return_value = datetime(2026, 10, 27, tzinfo=timezone.utc) + timedelta(hours=hours)
            clock.fromisoformat = datetime.fromisoformat
            return sandbox.scan(fetch)

    def only(self, result):
        return next(iter(result["inventory"].values()))

    def test_a_404_that_clears_on_recheck_is_never_an_error(self):
        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
            miss = HTTPStatusError("HTTP 404 for https://example.test/policy (loaded in a browser)", 404)
            result = self.scan_at(sandbox, 6, sequence(miss, ok(PAGE)))
            record = self.only(result)
            self.assertIsNone(record["fetch_error"])
            self.assertNotIn("fetch_warning", record)
            self.assertEqual(record["recovered_on_recheck"], 1)
            self.assertEqual([e["event_type"] for e in result["report"]["events"]], [])
            self.assertEqual(result["report"]["counts"]["fetch_recovered_on_recheck"], 1)
            sandbox.recheck_sleep.assert_called_once()

    def test_a_404_on_one_scan_keeps_the_good_copy_and_raises_nothing(self):
        with Sandbox() as sandbox:
            first = self.only(self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE)))
            result = self.scan_at(sandbox, 6, not_found)
            record = self.only(result)
            self.assertIsNone(record["fetch_error"])
            self.assertEqual(record["http_status"], 200)
            self.assertEqual(record["normalized_hash"], first["normalized_hash"])
            self.assertEqual(record["snapshot_location"], first["snapshot_location"])
            self.assertEqual(record["fetch_warning"]["runs"], 1)
            self.assertIn("HTTP 404", record["fetch_warning"]["message"])
            self.assertEqual(result["report"]["events"], [])
            self.assertEqual(result["report"]["counts"]["fetch_error"], 0)
            self.assertEqual(result["report"]["counts"]["fetch_held"], 1)
            self.assertEqual(build_notifications(result["report"]), [])
            self.assertEqual(sandbox.recheck_sleep.call_count, 2)  # asked three times in all

            recovered = self.only(self.scan_at(sandbox, 12, lambda *a, **k: ok(PAGE)))
            self.assertNotIn("fetch_warning", recovered)
            self.assertIsNone(recovered["fetch_error"])

    def test_a_file_that_is_really_gone_is_an_error_on_the_next_scan_with_no_alert_delay(self):
        with Sandbox(defaults={"error_alert_after_runs": 2}) as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
            held = self.scan_at(sandbox, 6, not_found)
            confirmed = self.scan_at(sandbox, 12, not_found)
            record = self.only(confirmed)
            self.assertIn("HTTP 404", record["fetch_error"])
            self.assertNotIn("fetch_warning", record)
            event = confirmed["report"]["events"][0]
            self.assertEqual(event["event_type"], "FETCH_ERROR")
            # The episode began with the held miss and that scan counts.
            self.assertEqual(event["error_since"], self.only(held)["fetch_warning"]["since"])
            self.assertEqual(event["error_runs"], 2)
            self.assertEqual(len(build_notifications(confirmed["report"])), 1)
            self.assertTrue(record["normalized_hash"])  # last good copy still the baseline

    def test_server_errors_and_timeouts_are_held_too(self):
        for failure in (HTTPStatusError("HTTP 502 for https://example.test/policy", 502),
                        requests.Timeout("Read timed out. (read timeout=30)")):
            with self.subTest(failure=type(failure).__name__), Sandbox() as sandbox:
                self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
                record = self.only(self.scan_at(sandbox, 6, sequence(failure, failure, failure)))
                self.assertIsNone(record["fetch_error"])
                self.assertEqual(record["fetch_warning"]["runs"], 1)

    def test_refusals_and_new_urls_are_not_held(self):
        with Sandbox() as sandbox:
            record = self.only(self.scan_at(sandbox, 0, not_found))
            self.assertIn("HTTP 404", record["fetch_error"])  # nothing to fall back on
            sandbox.recheck_sleep.assert_not_called()
        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
            refused = requests.HTTPError("HTTP 403 for https://example.test/policy")
            record = self.only(self.scan_at(sandbox, 6, sequence(refused)))
            self.assertIn("403", record["fetch_error"])
            sandbox.recheck_sleep.assert_not_called()

    def test_a_url_already_failing_is_rechecked_but_not_held_again(self):
        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
            self.scan_at(sandbox, 6, not_found)
            self.scan_at(sandbox, 12, not_found)  # confirmed error
            miss = HTTPStatusError("HTTP 404 for https://example.test/policy", 404)
            record = self.only(self.scan_at(sandbox, 18, sequence(miss, ok(PAGE))))
            self.assertIsNone(record["fetch_error"])  # a recheck can still clear it

    def test_a_404_answered_to_the_browser_after_cloudflare_is_rechecked(self):
        # The FFIEC path: the plain request gets a Cloudflare check, the browser
        # passes it, and the first load of the PDF answers 404.
        from regmon import browser_fetch

        challenge = (b"<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id='cf-chl-widget'></div>"
                     b"<script src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'></script></body></html>")
        loads = []

        def render(url, **_kwargs):
            loads.append(url)
            status = 404 if len(loads) == 1 else 200
            return browser_fetch.Rendered(b"", url, 0, "", status=status, content_type="text/html; charset=utf-8",
                                          body=PAGE if status == 200 else b"<html><body>Page not found</body></html>",
                                          headers={}, challenge="Cloudflare")

        with Sandbox() as sandbox:
            self.scan_at(sandbox, 0, lambda *a, **k: ok(PAGE))
            with patch("regmon.browser_fetch.available", return_value=True), \
                    patch("regmon.browser_fetch.render", side_effect=render):
                result = self.scan_at(sandbox, 6, lambda *a, **k: ok(challenge))
            record = self.only(result)
            self.assertEqual(len(loads), 2)
            self.assertIsNone(record["fetch_error"])
            self.assertEqual(record["recovered_on_recheck"], 1)
            self.assertEqual(record["rendered_by"], "browser")
            self.assertEqual(result["report"]["events"], [])


if __name__ == "__main__":
    unittest.main()
