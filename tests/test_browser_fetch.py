"""Opt-in browser rendering and bot-check pages (regmon/browser_fetch.py, regmon/botcheck.py)."""
from __future__ import annotations

import dataclasses
import json
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from engine_harness import SOURCE, Sandbox, html, ok
from regmon import botcheck, browser_fetch, monitor_settings
from regmon.config import SourceConfig
from regmon.fetch import HTTPStatusError, fetch

ROOT = Path(__file__).resolve().parents[1]
CLOUDFLARE = (b"<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id='cf-chl-widget'></div>"
              b"<script src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'></script>Checking your browser.</body></html>")
REAL_PAGE_WITH_BEACON = html("<h1>Circular</h1>" + "<p>Reporting deadline paragraph with substantive text. </p>" * 60 +
                             "<script src='/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js'></script>")


class DetectTests(unittest.TestCase):
    def test_challenge_pages_are_recognised(self):
        self.assertEqual(botcheck.detect(CLOUDFLARE, 503), "Cloudflare")
        self.assertEqual(botcheck.detect(b"<html><head><title>Access Denied</title></head><body>Reference #18.abc "
                                         b"https://errors.edgesuite.net/18.abc</body></html>"), "Akamai")
        self.assertEqual(botcheck.detect(b"<html><body><div class='g-recaptcha'></div>Please verify you are a human</body></html>"), "Captcha")
        self.assertEqual(botcheck.detect(b"<html><body>Incapsula incident ID: 123</body></html>"), "Imperva")

    def test_ordinary_pages_are_not(self):
        self.assertIsNone(botcheck.detect(REAL_PAGE_WITH_BEACON))
        self.assertIsNone(botcheck.detect(b"<html><head><title>Access Denied</title></head><body>You need to log in.</body></html>"))
        self.assertIsNone(botcheck.detect(html("<form><div class='g-recaptcha'></div></form>" + "<p>Contact the supervisor about filing. </p>" * 50)))
        self.assertIsNone(botcheck.detect(b""))

    def test_saved_pages_in_the_repository_are_not_flagged(self):
        files = [path for path in (ROOT / "data" / "snapshots" / "html").rglob("*") if path.is_file()]
        self.assertEqual([path.name for path in files if botcheck.detect(path.read_bytes())], [])


class FetchBodyTests(unittest.TestCase):
    def test_challenge_status_keeps_the_body(self):
        response = MagicMock(status_code=403, headers={"content-type": "text/html"})
        response.iter_content.return_value = [CLOUDFLARE]
        response.content = CLOUDFLARE
        with patch("regmon.fetch.validate_public_http_url"), patch("regmon.fetch.requests.get", return_value=response):
            with self.assertRaises(HTTPStatusError) as caught:
                fetch("https://example.test/policy", attempts=1, max_bytes=10_000_000)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.body, CLOUDFLARE)


def source(**extra):
    return dataclasses.replace(SOURCE, **extra)


class EngineTests(unittest.TestCase):
    def scan_twice(self, src, second, render=None):
        with Sandbox(source=src) as sandbox:
            sandbox.scan(lambda *a, **k: ok(html("<p>Reporting deadline: 30 days.</p>")))
            with patch("regmon.browser_fetch.render", side_effect=render or AssertionError("no render expected")):
                result = sandbox.scan(second)
            record = next(iter(result["inventory"].values()))
            events = [event["event_type"] for event in result["report"]["events"]]
            files = list((sandbox.data / "snapshots" / "botcheck").glob("*.html"))
            return record, events, files

    def test_plain_mode_turns_a_challenge_into_a_fetch_problem_and_saves_it(self):
        record, events, files = self.scan_twice(SOURCE, lambda *a, **k: ok(CLOUDFLARE))
        self.assertNotIn("CHANGED_URL", events)
        self.assertIn("FETCH_ERROR", events)
        self.assertIn("Cloudflare bot check", record["fetch_error"])
        self.assertEqual(record["bot_check"]["vendor"], "Cloudflare")
        self.assertEqual(len(files), 1)
        self.assertTrue(record["normalized_hash"])  # the last good baseline is kept

    def test_a_challenge_with_an_error_status_is_also_captured(self):
        def challenge(*_a, **_k):
            raise HTTPStatusError("HTTP 503", 503, "text/html", CLOUDFLARE)
        record, events, files = self.scan_twice(SOURCE, challenge)
        self.assertEqual(record["bot_check"]["vendor"], "Cloudflare")
        self.assertEqual(len(files), 1)

    def test_auto_mode_renders_only_on_a_challenge(self):
        rendered = browser_fetch.Rendered(html("<p>Reporting deadline: 15 days.</p>"), "https://example.test/policy", 2, "text:Reject all")
        record, events, _files = self.scan_twice(source(fetch_mode="auto"), lambda *a, **k: ok(CLOUDFLARE), render=lambda *a, **k: rendered)
        self.assertIn("CHANGED_URL", events)
        self.assertEqual(record["rendered_by"], "browser")
        self.assertEqual(record["browser"]["blocked_requests"], 2)
        self.assertNotIn("bot_check", record)

    def test_browser_mode_renders_every_html_page_and_skips_validators(self):
        calls = []
        def render(url, **kwargs):
            calls.append(kwargs)
            return browser_fetch.Rendered(html("<p>Rendered text.</p>"), url, 0, "")
        src = source(fetch_mode="browser", browser_wait_seconds=5, browser_wait_selector="main")
        with Sandbox(source=src) as sandbox:
            fetches = []
            def first(*_a, **kwargs):
                fetches.append(kwargs)
                return ok(html("<div id='app'>Loading…</div>"))
            with patch("regmon.browser_fetch.render", side_effect=render):
                sandbox.scan(first)
                sandbox.scan(first)
        self.assertEqual(len(calls), 2)
        self.assertEqual((calls[0]["wait_seconds"], calls[0]["wait_selector"]), (5, "main"))
        self.assertTrue(all(call.get("etag") is None for call in fetches))

    def test_a_challenge_after_rendering_is_still_refused(self):
        rendered = browser_fetch.Rendered(CLOUDFLARE, "https://example.test/policy", 0, "")
        record, events, files = self.scan_twice(source(fetch_mode="auto"), lambda *a, **k: ok(CLOUDFLARE), render=lambda *a, **k: rendered)
        self.assertNotIn("CHANGED_URL", events)
        self.assertEqual(record["bot_check"]["via"], "browser")
        self.assertIn("still shown after rendering", record["fetch_error"])

    def test_documents_are_never_rendered(self):
        pdf = ok(b"%PDF-1.4 not really", "application/pdf")
        with Sandbox(source=source(fetch_mode="browser")) as sandbox:
            with patch("regmon.browser_fetch.render", side_effect=AssertionError("documents are not rendered")):
                sandbox.scan(lambda *a, **k: pdf)


class SafetyTests(unittest.TestCase):
    def test_requests_are_limited_to_public_hosts_and_documents_to_scope(self):
        with patch("regmon.browser_fetch.validate_public_http_url", side_effect=lambda url, resolve_dns=True: None if "public" in url else (_ for _ in ()).throw(ValueError("private"))):
            in_scope = lambda url: url.startswith("https://public.test/scope/")
            self.assertTrue(browser_fetch._allowed("https://public.test/app.js", "Script", in_scope))
            self.assertFalse(browser_fetch._allowed("http://169.254.169.254/latest", "Image", in_scope))
            self.assertFalse(browser_fetch._allowed("https://public.test/elsewhere", "Document", in_scope))
            self.assertTrue(browser_fetch._allowed("https://public.test/scope/page", "Document", in_scope))
            self.assertFalse(browser_fetch._allowed("file:///etc/passwd", "Document", in_scope))
            self.assertTrue(browser_fetch._allowed("data:image/png;base64,AA", "Image", in_scope))

    def test_render_needs_a_browser(self):
        with patch("regmon.browser_fetch.validate_public_http_url"), patch.dict(os.environ, {"CHANGESENTINEL_CHROME": ""}), \
                patch("regmon.browser_fetch.shutil.which", return_value=None):
            with self.assertRaises(RuntimeError):
                browser_fetch.render("https://example.test/")

    @unittest.skipUnless(os.environ.get("CHANGESENTINEL_BROWSER_TEST") and browser_fetch.browser_binary(), "set CHANGESENTINEL_BROWSER_TEST=1 to render in a real browser")
    def test_a_real_render(self):
        import http.server
        import socketserver
        import tempfile
        import threading

        with tempfile.TemporaryDirectory() as root:
            Path(root, "index.html").write_text(
                "<html><body><div id='cookie-banner' class='cookie-consent'><button onclick=\"this.parentNode.remove()\">Reject all</button></div>"
                "<main id='app'>Loading</main><script>setTimeout(()=>{app.innerHTML='<h1>Circular 4,321</h1>'},300)</script>"
                "<img src='http://169.254.169.254/latest/meta-data/'></body></html>", encoding="utf-8")
            handler = lambda *args: http.server.SimpleHTTPRequestHandler(*args, directory=root)
            with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
                threading.Thread(target=server.serve_forever, daemon=True).start()
                url = f"http://127.0.0.1:{server.server_address[1]}/index.html"
                allow_local = lambda target, resolve_dns=True: (_ for _ in ()).throw(ValueError("private")) if "169.254" in target else None
                with patch("regmon.browser_fetch.validate_public_http_url", side_effect=allow_local):
                    result = browser_fetch.render(url, wait_seconds=1, in_scope=lambda target: target.startswith(url.rsplit("/", 1)[0]))
                server.shutdown()
        self.assertIn(b"Circular 4,321", result.html)
        self.assertNotIn(b"cookie-banner", result.html)
        self.assertGreaterEqual(result.blocked, 1)


class ConfigTests(unittest.TestCase):
    def test_fetch_settings_are_validated_and_defaults_not_written(self):
        base = {"id": "a", "name": "A", "regulator": "r", "seed_urls": ["https://r.test/"], "allowed_prefixes": ["https://r.test/"], "allowed_domains": ["r.test"]}
        self.assertEqual(SourceConfig.from_dict({**base, "fetch_mode": "auto"}).fetch_mode, "auto")
        for bad in ({"fetch_mode": "chrome"}, {"browser_wait_seconds": 30}, {"browser_wait_selector": "x" * 201}, {"browser_dismiss_cookies": "yes"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                SourceConfig.from_dict({**base, **bad})
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [base]}), encoding="utf-8")
            body = monitor_settings.REQUEST_MARKER + "\n\nSETTINGS_JSON:\n" + json.dumps({"monitors": ["a"], "set": {"fetch_mode": "browser", "browser_wait_seconds": 3}}) + "\n"
            monitor_settings.update_from_issue({"issue": {"title": "[ChangeSentinel] Update monitors (1)", "user": {"login": "o"}, "body": body}}, path, "o/r")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]
        self.assertEqual(saved["fetch_mode"], "browser")
        self.assertNotIn("browser_wait_seconds", saved)

    def test_dashboard_offers_the_settings(self):
        html_text = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for element in ("scanLoading", "scanFetchMode", "scanWait", "scanWaitSelector", "scanDismiss"):
            self.assertIn('id="' + element + '"', html_text)
        self.assertIn('["Saved bot-check page"', js)


if __name__ == "__main__":
    unittest.main()
