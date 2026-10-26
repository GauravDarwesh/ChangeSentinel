"""Opt-in browser rendering and bot-check pages (regmon/browser_fetch.py, regmon/botcheck.py)."""
from __future__ import annotations

import dataclasses
import json
import tempfile
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
        self.assertEqual(botcheck.detect(b"<html><head><title>Blocked</title></head><body>"
                                         b"<script src='https://ct.captcha-delivery.com/c.js'></script></body></html>", 403), "DataDome")
        self.assertEqual(botcheck.detect(b"<html><body><script>window.awsWafCookieDomainList=[]</script></body></html>", 405), "AWS WAF")

    def test_challenges_announced_in_headers_are_recognised(self):
        self.assertEqual(botcheck.detect(b"", 403, {"cf-mitigated": "challenge"}), "Cloudflare")
        self.assertEqual(botcheck.detect(b"<html></html>", 202, {"X-Amzn-Waf-Action": "challenge"}), "AWS WAF")
        self.assertEqual(botcheck.detect(b"", 405, {"x-amzn-waf-action": "captcha"}), "AWS WAF")
        self.assertEqual(botcheck.detect(b"", 429, {"x-kpsdk-ct": "abc", "x-kpsdk-r": "1-AA"}), "Kasada")
        self.assertIsNone(botcheck.detect(b"", 200, {"x-kpsdk-ct": "abc"}))  # a passed Kasada session sends them too
        self.assertIsNone(botcheck.detect(b"", 429, {"retry-after": "60"}))
        self.assertEqual(botcheck.detect(b"<html><body><script>window.KPSDK={};KPSDK.start=1</script></body></html>", 429), "Kasada")
        self.assertEqual(botcheck.detect(b"<html><body><div id='sec-if-cpt-container'></div><script src='/_sec/cp_challenge/ak.js'></script></body></html>", 403), "Akamai")
        self.assertEqual(botcheck.detect(b"<html><body><p>Press &amp; Hold to confirm you are a human</p></body></html>", 403), "PerimeterX")

    def test_errors_are_described_in_plain_words(self):
        self.assertEqual(botcheck.reason("BotCheckError: Cloudflare bot check: it still asked"), "a Cloudflare bot check")
        self.assertEqual(botcheck.reason("AccessRefusedError: HTTP 403 refusal: www.x.gov refused"), "an HTTP 403 refusal")
        self.assertEqual(botcheck.vendor_in("AccessRefusedError: HTTP 429 refusal: slow down"), "HTTP 429")
        self.assertTrue(botcheck.is_error("AccessRefusedError: HTTP 403 refusal"))
        self.assertFalse(botcheck.is_error("HTTPError: HTTP 404"))

    def test_ordinary_pages_are_not(self):
        self.assertIsNone(botcheck.detect(REAL_PAGE_WITH_BEACON))
        self.assertIsNone(botcheck.detect(b"<html><head><title>Access Denied</title></head><body>You need to log in.</body></html>"))
        self.assertIsNone(botcheck.detect(html("<form><div class='g-recaptcha'></div></form>" + "<p>Contact the supervisor about filing. </p>" * 50)))
        self.assertIsNone(botcheck.detect(b""))
        # The gate applies to every monitor, and a false hit freezes the
        # baseline, so short real pages must not trip it either.
        self.assertIsNone(botcheck.detect(b"<html><head><title>Blocked Persons List</title></head><body>"
                                          + b"<p>Designated entity, address and programme.</p>" * 60 + b"</body></html>"))
        self.assertIsNone(botcheck.detect(b"<html><head><title>Subscribe to updates</title></head><body><p>Get email "
                                          b"updates on reporting forms.</p><form><div class='g-recaptcha'></div></form></body></html>"))
        self.assertIsNone(botcheck.detect(b"<html><head><title>Release notes</title><script src='/js/challenge.js'></script>"
                                          b"</head><body><p>Version 2.1 released.</p></body></html>"))

    def test_saved_pages_in_the_repository_are_not_flagged(self):
        files = [path for path in (ROOT / "data" / "snapshots" / "html").rglob("*") if path.is_file()]
        self.assertEqual([path.name for path in files if botcheck.detect(path.read_bytes())], [])


class FetchBodyTests(unittest.TestCase):
    def test_a_challenge_announced_in_headers_is_not_retried_and_keeps_its_headers(self):
        response = MagicMock(status_code=429, headers={"content-type": "text/html", "x-kpsdk-ct": "abc"})
        response.iter_content.return_value = [b"<html></html>"]
        with patch("regmon.fetch.validate_public_http_url"), patch("regmon.fetch.requests.get", return_value=response) as get, \
                patch("regmon.fetch.time.sleep") as sleep:
            with self.assertRaises(HTTPStatusError) as caught:
                fetch("https://example.test/policy", attempts=3, max_bytes=10_000_000)
        self.assertEqual(get.call_count, 1)  # a Kasada 429 is a challenge, not rate limiting
        sleep.assert_not_called()
        self.assertEqual(caught.exception.headers.get("x-kpsdk-ct"), "abc")

    def test_browser_headers_are_used_when_asked(self):
        response = MagicMock(status_code=202, headers={"content-type": "text/html", "x-amzn-waf-action": "challenge"})
        response.iter_content.return_value = [b"<html></html>"]
        with patch("regmon.fetch.validate_public_http_url"), patch("regmon.fetch.requests.get", return_value=response) as get:
            result = fetch("https://example.test/policy", attempts=1, max_bytes=10_000_000, browser_headers=True)
        self.assertIn("Chrome/", get.call_args.kwargs["headers"]["User-Agent"])
        self.assertEqual(result.challenge, "AWS WAF")


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


PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def resource(body, content_type="text/html; charset=utf-8", status=200, challenge="Cloudflare", url="https://example.test/policy", **headers):
    return browser_fetch.Rendered(body if "html" in content_type else b"", url, 0, "", status=status, content_type=content_type,
                                  body=body, headers=headers, challenge=challenge)


class EngineTests(unittest.TestCase):
    def scan_twice(self, src, second, render=None, browser=True):
        with Sandbox(source=src) as sandbox:
            sandbox.scan(lambda *a, **k: ok(html("<p>Reporting deadline: 30 days.</p>")))
            with patch("regmon.browser_fetch.render", side_effect=render or AssertionError("no render expected")), \
                    patch("regmon.browser_fetch.available", return_value=browser):
                result = sandbox.scan(second)
            record = next(iter(result["inventory"].values()))
            events = [event["event_type"] for event in result["report"]["events"]]
            files = list((sandbox.data / "snapshots" / "botcheck").glob("*.html"))
            return record, events, files

    def test_without_a_browser_a_challenge_is_a_fetch_problem_and_is_saved(self):
        record, events, files = self.scan_twice(SOURCE, lambda *a, **k: ok(CLOUDFLARE), browser=False)
        self.assertNotIn("CHANGED_URL", events)
        self.assertIn("FETCH_ERROR", events)
        self.assertIn("Cloudflare bot check", record["fetch_error"])
        self.assertIn("no browser", record["fetch_error"])
        self.assertEqual(record["bot_check"]["vendor"], "Cloudflare")
        self.assertEqual(len(files), 1)
        self.assertTrue(record["normalized_hash"])  # the last good baseline is kept

    def test_a_challenge_with_an_error_status_is_also_captured(self):
        def challenge(*_a, **_k):
            raise HTTPStatusError("HTTP 503", 503, "text/html", CLOUDFLARE)
        record, events, files = self.scan_twice(SOURCE, challenge, browser=False)
        self.assertEqual(record["bot_check"]["vendor"], "Cloudflare")
        self.assertEqual(len(files), 1)

    def test_any_monitor_gets_past_a_challenge_in_the_browser_without_a_setting(self):
        calls = []
        def render(url, **kwargs):
            calls.append(kwargs)
            return resource(html("<p>Reporting deadline: 15 days.</p>"))
        def challenge(*_a, **_k):
            raise HTTPStatusError("HTTP 403", 403, "text/html", CLOUDFLARE)
        for mode in ("http", "auto"):
            with self.subTest(mode=mode):
                calls.clear()
                record, events, _files = self.scan_twice(source(fetch_mode=mode), challenge, render=render)
                self.assertIn("CHANGED_URL", events)
                self.assertEqual(calls[0]["want"], "resource")
                self.assertEqual(record["rendered_by"], "browser")
                self.assertEqual(record["browser"]["passed_check"], "Cloudflare")
                self.assertEqual(record["http_status"], 200)
                self.assertNotIn("bot_check", record)
                self.assertIsNone(record.get("fetch_error"))

    def test_a_pdf_behind_a_challenge_is_kept_as_the_pdf(self):
        rendered = resource(PDF, "application/pdf", **{"last-modified": "Mon, 26 Oct 2026 06:00:00 GMT"})
        with Sandbox(source=SOURCE) as sandbox, patch("regmon.browser_fetch.available", return_value=True), \
                patch("regmon.browser_fetch.render", return_value=rendered), \
                patch("regmon.engine.extract_content", return_value=("Instructions text", "pdf", None)) as extract:
            result = sandbox.scan(lambda *a, **k: ok(CLOUDFLARE))
        record = next(iter(result["inventory"].values()))
        self.assertEqual(extract.call_args[0][1:3], ("application/pdf", PDF))
        self.assertEqual(record["content_type"], "application/pdf")
        self.assertEqual(record["last_modified"], "Mon, 26 Oct 2026 06:00:00 GMT")
        self.assertIsNone(record.get("fetch_error"))

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
        self.assertEqual((calls[0]["wait_seconds"], calls[0]["wait_selector"], calls[0]["want"]), (5, "main", "dom"))
        self.assertTrue(all(call.get("etag") is None for call in fetches))

    def test_a_check_the_browser_cannot_pass_keeps_the_baseline_and_saves_what_it_saw(self):
        def render(*_a, **_k):
            raise browser_fetch.ChallengeNotPassed("Cloudflare", CLOUDFLARE + b"<!-- browser -->")
        record, events, files = self.scan_twice(SOURCE, lambda *a, **k: ok(CLOUDFLARE), render=render)
        self.assertNotIn("CHANGED_URL", events)
        self.assertEqual(record["bot_check"]["via"], "browser")
        self.assertIn("still asked for a check", record["fetch_error"])
        self.assertTrue(record["normalized_hash"])
        self.assertEqual(len(files), 1)

    def test_a_challenge_after_loading_is_still_refused(self):
        record, events, _files = self.scan_twice(SOURCE, lambda *a, **k: ok(CLOUDFLARE), render=lambda *a, **k: resource(CLOUDFLARE))
        self.assertNotIn("CHANGED_URL", events)
        self.assertEqual(record["bot_check"]["via"], "browser")
        self.assertIn("still shown after loading in a browser", record["fetch_error"])

    def test_an_error_status_behind_the_check_is_an_ordinary_fetch_error(self):
        record, _events, _files = self.scan_twice(SOURCE, lambda *a, **k: ok(CLOUDFLARE), render=lambda *a, **k: resource(b"gone", "text/plain", 404))
        self.assertIn("HTTP 404", record["fetch_error"])
        self.assertNotIn("bot_check", record)

    def test_a_site_that_refuses_the_browser_twice_is_left_for_the_next_scan(self):
        urls = [f"https://example.test/policy/{index}" for index in range(5)]
        attempts = []
        def render(url, **_k):
            attempts.append(url)
            raise browser_fetch.ChallengeNotPassed("Cloudflare", CLOUDFLARE)
        with Sandbox(source=source(seed_urls=urls)) as sandbox:
            sandbox.discovered = urls
            with patch("regmon.browser_fetch.render", side_effect=render), patch("regmon.browser_fetch.available", return_value=True):
                result = sandbox.scan(lambda *a, **k: ok(CLOUDFLARE))
        self.assertEqual(len(attempts), 2)
        errors = [record["fetch_error"] for record in result["inventory"].values()]
        self.assertEqual(sum("earlier in this scan" in error for error in errors), 3)
        self.assertTrue(all(record.get("bot_check") for record in result["inventory"].values()))

    def refused(self, *statuses):
        """A fetch that answers each call with the next bare refusal status (then the last one)."""
        calls = []
        def side_effect(*_a, **kwargs):
            calls.append(kwargs)
            status = statuses[min(len(calls), len(statuses)) - 1]
            if status == 200:
                return ok(html("<p>Reporting deadline: 10 days.</p>"))
            raise HTTPStatusError(f"HTTP {status}", status, "text/plain", b"Forbidden", {})
        return side_effect, calls

    def test_a_bare_refusal_is_retried_with_browser_headers_first(self):
        side_effect, calls = self.refused(403, 200)
        record, events, _files = self.scan_twice(SOURCE, side_effect, browser=False)
        self.assertIsNone(record.get("fetch_error"))
        self.assertEqual(record["fetched_with"], "browser headers")
        self.assertTrue(calls[-1]["browser_headers"])

    def test_a_refusal_that_persists_goes_to_the_browser_then_becomes_a_calm_error(self):
        side_effect, _calls = self.refused(403, 403)
        rendered = resource(html("<p>Reporting deadline: 12 days.</p>"), challenge="")
        record, events, _files = self.scan_twice(SOURCE, side_effect, render=lambda *a, **k: rendered)
        self.assertIn("CHANGED_URL", events)
        self.assertEqual(record["browser"]["passed_check"], "HTTP 403 refusal")
        record, _events, _files = self.scan_twice(SOURCE, side_effect, render=lambda *a, **k: resource(b"Forbidden", "text/html", 403, challenge=""))
        self.assertTrue(record["fetch_error"].startswith("AccessRefusedError: HTTP 403 refusal"))
        self.assertTrue(record["normalized_hash"])  # the last good copy stays
        record, _events, _files = self.scan_twice(SOURCE, side_effect, browser=False)
        self.assertIn("no browser is available", record["fetch_error"])

    def test_a_429_is_never_pushed_harder(self):
        side_effect, calls = self.refused(429)
        record, _events, _files = self.scan_twice(SOURCE, side_effect)  # render would raise AssertionError if used
        self.assertTrue(record["fetch_error"].startswith("AccessRefusedError: HTTP 429 refusal"))
        self.assertFalse(any(call.get("browser_headers") for call in calls))

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

    def test_only_a_frame_may_come_from_a_challenge_host(self):
        in_scope = lambda url: url.startswith("https://www.ffiec.gov/")
        widget = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc"
        with patch("regmon.browser_fetch.validate_public_http_url"):
            self.assertTrue(browser_fetch._allowed(widget, "Document", in_scope, main_frame=False))
            self.assertFalse(browser_fetch._allowed(widget, "Document", in_scope, main_frame=True))
            self.assertFalse(browser_fetch._allowed("https://evil.test/frame", "Document", in_scope, main_frame=False))

    def test_every_known_vendor_may_draw_its_widget_in_a_frame(self):
        in_scope = lambda url: url.startswith("https://www.ffiec.gov/")
        with patch("regmon.browser_fetch.validate_public_http_url"):
            for widget in ("https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html", "https://geo.captcha-delivery.com/captcha/?x=1",
                           "https://c.captcha-delivery.com/c.html", "https://www.google.com/recaptcha/api2/anchor?k=x",
                           "https://www.recaptcha.net/recaptcha/api2/anchor", "https://client-api.arkoselabs.com/fc/gc/",
                           "https://abc.token.awswaf.com/abc/challenge", "https://captcha.px-cdn.net/PX123/captcha.js"):
                with self.subTest(widget=widget):
                    self.assertTrue(browser_fetch._allowed(widget, "Document", in_scope, main_frame=False))
                    self.assertFalse(browser_fetch._allowed(widget, "Document", in_scope, main_frame=True))
            self.assertFalse(browser_fetch._allowed("https://www.google.com/search?q=x", "Document", in_scope, main_frame=False))
            self.assertFalse(browser_fetch._allowed("https://nothcaptcha.com/x", "Document", in_scope, main_frame=False))

    def test_the_owners_proxy_is_used_for_browser_loads_with_its_credentials_kept_out_of_the_command_line(self):
        with patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": "http://owner:p%40ss@proxy.example.org:3128"}):
            self.assertEqual(browser_fetch.proxy_setting(), ("http://proxy.example.org:3128", "owner", "p@ss"))
            with patch("regmon.browser_fetch.subprocess.run", return_value=MagicMock(stdout="Chrome 141.0.1.2")):
                arguments = browser_fetch.launch_arguments("/fake/chrome")
        self.assertIn("--proxy-server=http://proxy.example.org:3128", arguments)
        self.assertFalse(any("p@ss" in argument or "owner" in argument for argument in arguments))
        with patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": "ftp://x"}), self.assertRaises(RuntimeError):
            browser_fetch.proxy_setting()
        with patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": ""}):
            self.assertEqual(browser_fetch.proxy_setting(), ("", "", ""))

    def test_the_browser_presents_as_ordinary_chrome_with_one_profile(self):
        with patch("regmon.browser_fetch.subprocess.run", return_value=MagicMock(stdout="Google Chrome 141.0.7390.122\n")):
            browser_fetch._VERSIONS.pop("/fake/chrome", None)
            arguments = browser_fetch.launch_arguments("/fake/chrome")
        agent = next(a for a in arguments if a.startswith("--user-agent="))
        self.assertIn("Chrome/141.0.0.0", agent)
        self.assertNotIn("Headless", agent)
        self.assertIn("--disable-blink-features=AutomationControlled", arguments)
        self.assertEqual(browser_fetch.launch_arguments("/fake/chrome")[-2], arguments[-2])  # same profile all run

    def test_render_needs_a_browser(self):
        with patch("regmon.browser_fetch.validate_public_http_url"), patch.dict(os.environ, {"CHANGESENTINEL_CHROME": ""}), \
                patch("regmon.browser_fetch.shutil.which", return_value=None):
            with self.assertRaises(RuntimeError):
                browser_fetch.render("https://example.test/")

    @unittest.skipUnless(os.environ.get("CHANGESENTINEL_BROWSER_TEST") and browser_fetch.available(), "set CHANGESENTINEL_BROWSER_TEST=1 to render in a real browser")
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

    @unittest.skipUnless(os.environ.get("CHANGESENTINEL_BROWSER_TEST") and browser_fetch.available(), "set CHANGESENTINEL_BROWSER_TEST=1 to load pages in a real browser")
    def test_a_real_browser_gets_past_a_managed_challenge(self):
        from challenge_site import PAGE, PDF as BIG_PDF, serve

        with serve() as (site, _widget, _hits), patch("regmon.browser_fetch.validate_public_http_url"), \
                patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", frozenset({"localhost"})):
            in_scope = lambda target: target.startswith(site + "/")
            first = browser_fetch.render(site + "/forms/big.pdf", want="resource", in_scope=in_scope)
            second = browser_fetch.render(site + "/forms/page", want="resource", in_scope=in_scope)
            with patch.object(browser_fetch, "CHALLENGE_WAIT_SECONDS", 4):
                with self.assertRaises(browser_fetch.ChallengeNotPassed):
                    browser_fetch.render(site + "/hard/x.pdf", want="resource", in_scope=in_scope)
        self.assertEqual((first.challenge, first.status, first.body), ("Cloudflare", 200, BIG_PDF))
        self.assertIn("pdf", first.content_type)
        self.assertEqual((second.challenge, second.body), ("", PAGE))  # the clearance carried over

    @unittest.skipUnless(os.environ.get("CHANGESENTINEL_BROWSER_TEST") and browser_fetch.available(), "set CHANGESENTINEL_BROWSER_TEST=1 to load pages in a real browser")
    def test_a_real_seleniumbase_fallback_gets_the_original_pdf_after_a_challenge(self):
        from challenge_site import PDF as BIG_PDF, serve

        # Force the primary backend to report the challenge so this exercises
        # the real SeleniumBase fallback, not just Pydoll's happy path.
        initial_challenge = browser_fetch.ChallengeNotPassed("Cloudflare", CLOUDFLARE)
        with serve() as (site, _widget, _hits), tempfile.TemporaryDirectory() as profile, \
                patch("regmon.browser_fetch.validate_public_http_url"), \\
                patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", frozenset({"localhost"})), \\
                patch.object(browser_fetch, "profile_dir", return_value=profile), \\
                patch("regmon.browser_fetch._render", side_effect=initial_challenge):
            in_scope = lambda target: target.startswith(site + "/")
            result = browser_fetch.render(site + "/forms/big.pdf", want="resource", in_scope=in_scope)

        self.assertEqual((result.challenge, result.status, result.body), ("Cloudflare", 200, BIG_PDF))
        self.assertIn("pdf", result.content_type.lower())

    @unittest.skipUnless(os.environ.get("CHANGESENTINEL_BROWSER_TEST") and browser_fetch.available(), "set CHANGESENTINEL_BROWSER_TEST=1 to load pages in a real browser")
    def test_a_real_browser_handles_other_vendors_and_the_owners_proxy(self):
        from challenge_site import HCAPTCHA_HOST, PAGE, PDF as BIG_PDF, serve, serve_proxy

        original = browser_fetch.launch_arguments
        local = lambda binary: original(binary) + [f"--host-resolver-rules=MAP {HCAPTCHA_HOST} 127.0.0.1", "--proxy-bypass-list=<-loopback>"]
        with serve() as (site, _widget, hits), patch("regmon.browser_fetch.validate_public_http_url"), \
                patch.object(browser_fetch, "launch_arguments", local):
            in_scope = lambda target: target.startswith(site + "/")
            imperva = browser_fetch.render(site + "/imperva/x.pdf", want="resource", in_scope=in_scope)
            waf = browser_fetch.render(site + "/waf/page", want="resource", in_scope=in_scope)
            kasada = browser_fetch.render(site + "/kasada/x.pdf", want="resource", in_scope=in_scope)
            blocked = browser_fetch.render(site + "/net/x.pdf", want="resource", in_scope=in_scope)
            with serve_proxy() as (proxy_url, seen), patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": proxy_url}):
                proxied = browser_fetch.render(site + "/net/x.pdf", want="resource", in_scope=in_scope)
        self.assertEqual((imperva.challenge, imperva.body), ("Imperva", BIG_PDF))
        self.assertEqual((waf.challenge, waf.body), ("AWS WAF", PAGE))
        self.assertEqual((kasada.challenge, kasada.body), ("Kasada", BIG_PDF))
        self.assertEqual(blocked.status, 403)
        self.assertEqual((proxied.status, proxied.body), (200, BIG_PDF))
        self.assertTrue(seen)


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
