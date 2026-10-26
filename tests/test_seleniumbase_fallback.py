"""Regression tests for the isolated SeleniumBase CDP browser fallback."""
from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from regmon import browser_fetch


URL = "https://www.ffiec.gov/forms/reporting"


def rendered():
    return browser_fetch.Rendered(
        html=b"<html><body><main>FFIEC reporting forms</main></body></html>",
        final_url=URL,
        blocked=0,
        consent="",
        status=200,
        content_type="text/html; charset=utf-8",
        body=b"<html><body><main>FFIEC reporting forms</main></body></html>",
        headers={"content-type": "text/html; charset=utf-8"},
        challenge="Cloudflare",
    )


class SeleniumBaseFallbackTests(unittest.TestCase):
    def test_pydoll_success_does_not_start_seleniumbase(self):
        expected = rendered()
        with (
            patch.object(browser_fetch, "_pydoll_available", return_value=True),
            patch.object(browser_fetch, "_seleniumbase_available", return_value=True),
            patch.object(browser_fetch, "_render", new_callable=AsyncMock, return_value=expected) as primary,
            patch.object(browser_fetch, "_render_seleniumbase", new_callable=AsyncMock) as fallback,
        ):
            actual = asyncio.run(browser_fetch._render_with_fallback(URL, "/usr/bin/chrome", want="resource"))

        self.assertIs(actual, expected)
        primary.assert_awaited_once_with(URL, "/usr/bin/chrome", want="resource")
        fallback.assert_not_awaited()

    def test_seleniumbase_is_used_only_after_pydoll_reports_a_challenge(self):
        challenge = browser_fetch.ChallengeNotPassed("Cloudflare", b"Just a moment")
        expected = rendered()
        with (
            patch.object(browser_fetch, "_pydoll_available", return_value=True),
            patch.object(browser_fetch, "_seleniumbase_available", return_value=True),
            patch.object(browser_fetch, "_render", new_callable=AsyncMock, side_effect=challenge) as primary,
            patch.object(browser_fetch, "_render_seleniumbase", new_callable=AsyncMock, return_value=expected) as fallback,
        ):
            actual = asyncio.run(browser_fetch._render_with_fallback(URL, "/usr/bin/chrome", want="resource"))

        self.assertIs(actual, expected)
        primary.assert_awaited_once()
        fallback.assert_awaited_once_with(URL, "/usr/bin/chrome", want="resource")

    def test_seleniumbase_is_the_primary_backend_when_pydoll_is_not_installed(self):
        expected = rendered()
        with (
            patch.object(browser_fetch, "_pydoll_available", return_value=False),
            patch.object(browser_fetch, "_seleniumbase_available", return_value=True),
            patch.object(browser_fetch, "_render", new_callable=AsyncMock) as primary,
            patch.object(browser_fetch, "_render_seleniumbase", new_callable=AsyncMock, return_value=expected) as fallback,
        ):
            actual = asyncio.run(browser_fetch._render_with_fallback(URL, "/usr/bin/chrome", want="resource"))

        self.assertIs(actual, expected)
        primary.assert_not_awaited()
        fallback.assert_awaited_once_with(URL, "/usr/bin/chrome", want="resource")

    def test_unresolved_seleniumbase_challenge_is_reported_not_misread_as_content(self):
        primary_challenge = browser_fetch.ChallengeNotPassed("Cloudflare", b"primary challenge")
        seleniumbase_challenge = browser_fetch.ChallengeNotPassed("Cloudflare", b"second challenge")
        with (
            patch.object(browser_fetch, "_pydoll_available", return_value=True),
            patch.object(browser_fetch, "_seleniumbase_available", return_value=True),
            patch.object(browser_fetch, "_render", new_callable=AsyncMock, side_effect=primary_challenge),
            patch.object(browser_fetch, "_render_seleniumbase", new_callable=AsyncMock, side_effect=seleniumbase_challenge),
        ):
            with self.assertRaises(browser_fetch.ChallengeNotPassed) as caught:
                asyncio.run(browser_fetch._render_with_fallback(URL, "/usr/bin/chrome", want="resource"))

        self.assertIs(caught.exception, seleniumbase_challenge)
        self.assertEqual(caught.exception.page, b"second challenge")

    def test_seleniumbase_startup_error_keeps_the_original_bot_check_classification(self):
        primary_challenge = browser_fetch.ChallengeNotPassed("Cloudflare", b"saved challenge")
        fallback_error = RuntimeError("SeleniumBase failed to launch")
        with (
            patch.object(browser_fetch, "_pydoll_available", return_value=True),
            patch.object(browser_fetch, "_seleniumbase_available", return_value=True),
            patch.object(browser_fetch, "_render", new_callable=AsyncMock, side_effect=primary_challenge),
            patch.object(browser_fetch, "_render_seleniumbase", new_callable=AsyncMock, side_effect=fallback_error),
        ):
            with self.assertRaises(browser_fetch.ChallengeNotPassed) as caught:
                asyncio.run(browser_fetch._render_with_fallback(URL, "/usr/bin/chrome", want="resource"))

        self.assertIs(caught.exception, primary_challenge)
        self.assertIs(caught.exception.__cause__, fallback_error)

    def test_raw_cdp_command_preserves_method_params_and_result(self):
        command = browser_fetch._raw_cdp_command("Page.navigate", {"url": URL})
        self.assertEqual(next(command), {"method": "Page.navigate", "params": {"url": URL}})
        with self.assertRaises(StopIteration) as returned:
            command.send({"frameId": "frame-1"})
        self.assertEqual(returned.exception.value, {"frameId": "frame-1"})

    def test_seleniumbase_fetch_event_is_normalized_for_shared_safety_checks(self):
        event = SimpleNamespace(
            request_id="request-7",
            request=SimpleNamespace(url=URL),
            frame_id="main-frame",
            resource_type=SimpleNamespace(value="Document"),
            response_status_code=403,
            response_error_reason=None,
            response_headers=[SimpleNamespace(name="cf-mitigated", value="challenge")],
        )
        params = browser_fetch._SeleniumBasePage._request_paused_params(event)
        self.assertEqual(params["requestId"], "request-7")
        self.assertEqual(params["request"]["url"], URL)
        self.assertEqual(params["frameId"], "main-frame")
        self.assertEqual(params["resourceType"], "Document")
        self.assertEqual(params["responseStatusCode"], 403)
        self.assertEqual(params["responseHeaders"], [{"name": "cf-mitigated", "value": "challenge"}])

    def test_proxy_auth_event_is_normalized_for_the_existing_auth_handler(self):
        event = SimpleNamespace(
            request_id="auth-1",
            auth_challenge=SimpleNamespace(source=SimpleNamespace(value="Proxy"), origin="http://proxy", scheme="basic", realm=""),
        )
        params = browser_fetch._SeleniumBasePage._auth_required_params(event)
        self.assertEqual(params["requestId"], "auth-1")
        self.assertEqual(params["authChallenge"]["source"], "Proxy")
        self.assertEqual(params["authChallenge"]["origin"], "http://proxy")


if __name__ == "__main__":
    unittest.main()
