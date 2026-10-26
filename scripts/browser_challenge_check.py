#!/usr/bin/env python3
"""Real-browser check of the bot-check and refusal paths on simulated protected sites.

The engine drives Chrome with pydoll; this check drives the same ``_drive``
code through Playwright's DevTools session, so it runs wherever Playwright's
Chromium is installed. ``tests/test_browser_fetch.py`` runs the pydoll path
itself when CHANGESENTINEL_BROWSER_TEST=1. The sites are in
``tests/challenge_site.py``.

    python scripts/browser_challenge_check.py
"""
from __future__ import annotations

import asyncio
import dataclasses
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from challenge_site import HCAPTCHA_HOST, PAGE, PDF, serve, serve_proxy  # noqa: E402

from regmon import browser_fetch  # noqa: E402

try:
    from playwright.async_api import async_playwright
except ImportError:  # pragma: no cover
    print("SKIP playwright is not installed")
    sys.exit(0)


class PlaywrightPage(browser_fetch._Page):
    def __init__(self, session):
        self.session = session

    async def send(self, method, params=None):
        return await self.session.send(method, params or {})

    async def on(self, event, handler):
        self.session.on(event, lambda params: asyncio.ensure_future(handler(params)))


FAILURES: list[str] = []
BINARY = ""


def check(condition, message):
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        FAILURES.append(message)


async def open_page(playwright, binary, profile, *, stealth=True):
    arguments = [a for a in browser_fetch.launch_arguments(binary) if not a.startswith("--user-data-dir")]
    if not stealth:
        arguments = [a for a in arguments if not a.startswith(("--user-agent", "--disable-blink-features"))]
    # The test's vendor host lives on this machine; the proxy must also carry loopback traffic.
    arguments += [f"--host-resolver-rules=MAP {HCAPTCHA_HOST} 127.0.0.1", "--proxy-bypass-list=<-loopback>"]
    context = await playwright.chromium.launch_persistent_context(
        profile, executable_path=binary, headless=False, args=arguments,
        ignore_default_args=["--enable-automation", "--headless"] if stealth else ["--headless"])
    page = context.pages[0] if context.pages else await context.new_page()
    return context, PlaywrightPage(await context.new_cdp_session(page))


async def load(playwright, url, profile=None, **options):
    context, page = await open_page(playwright, BINARY, profile or tempfile.mkdtemp())
    try:
        return await browser_fetch._drive(page, url, **options)
    finally:
        await context.close()


async def browser_checks(site, hits):
    in_scope = lambda url: url.startswith(site + "/")
    async with async_playwright() as playwright:
        # 1. A PDF behind a managed challenge: the check passes, the PDF comes back whole.
        profile = tempfile.mkdtemp()
        started = time.monotonic()
        result = await load(playwright, site + "/forms/big.pdf", profile, want="resource", in_scope=in_scope)
        check(result.challenge == "Cloudflare", f"Cloudflare: the managed check was met and passed ({time.monotonic() - started:.1f}s)")
        check(result.body == PDF and result.status == 200, f"Cloudflare: the PDF came back byte for byte ({len(result.body or b'')} bytes)")
        check("pdf" in result.content_type and result.headers.get("last-modified"), "Cloudflare: content type and Last-Modified were kept")
        # 2. The next URL on the site reuses the clearance: no check, the server's own HTML.
        started = time.monotonic()
        result = await load(playwright, site + "/forms/page", profile, want="resource", in_scope=in_scope)
        check(result.challenge == "" and result.body == PAGE, f"a second URL reused the clearance and kept the server's HTML ({time.monotonic() - started:.1f}s)")
        # 3. Browser mode still renders, after the check.
        result = await load(playwright, site + "/forms/page", profile, want="dom", in_scope=in_scope, wait_seconds=0.5, dismiss=False)
        check(b"Rendered by script" in result.html, "browser mode returns the rendered page")

        # 4-5. What went wrong before: the widget frame was blocked, and headless Chrome announced itself.
        with patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", frozenset()):
            try:
                await load(playwright, site + "/forms/big.pdf", want="resource", in_scope=in_scope, challenge_wait=6)
                check(False, "blocking the widget frame makes the check fail")
            except browser_fetch.ChallengeNotPassed as exc:
                check(exc.vendor == "Cloudflare", "blocking the widget frame makes the check fail (the old behaviour)")
        context, page = await open_page(playwright, BINARY, tempfile.mkdtemp(), stealth=False)
        try:
            await browser_fetch._drive(page, site + "/forms/big.pdf", want="resource", in_scope=in_scope, challenge_wait=6)
            check(False, "a HeadlessChrome user agent is refused")
        except browser_fetch.ChallengeNotPassed:
            check(True, "a HeadlessChrome user agent is refused (the old behaviour)")
        await context.close()
        # 6. A check that wants a person ends cleanly, with the page saved for review.
        started = time.monotonic()
        try:
            await load(playwright, site + "/hard/forms.pdf", want="resource", in_scope=in_scope, challenge_wait=4)
            check(False, "an unsolvable check raises ChallengeNotPassed")
        except browser_fetch.ChallengeNotPassed as exc:
            check(b"Just a moment" in exc.page and time.monotonic() - started < 15,
                  f"an unsolvable check gives up after its wait ({time.monotonic() - started:.1f}s) with the page kept")

        # 7. Other vendors.
        result = await load(playwright, site + "/imperva/forms.pdf", want="resource", in_scope=in_scope)
        check(result.challenge == "Imperva" and result.body == PDF, "Imperva with an hCaptcha frame from *.hcaptcha.com: passed, PDF kept")
        check(any(kind == "WIDGET" and entry.startswith(HCAPTCHA_HOST) for kind, entry in hits), "the hCaptcha frame was allowed by its domain suffix")
        result = await load(playwright, site + "/waf/forms/page", want="resource", in_scope=in_scope)
        check(result.challenge == "AWS WAF" and result.body == PAGE, "AWS WAF: a 202 announced only by x-amzn-waf-action is recognised and passed")
        result = await load(playwright, site + "/kasada/forms.pdf", want="resource", in_scope=in_scope)
        check(result.challenge == "Kasada" and result.body == PDF, "Kasada: a bare 429 with x-kpsdk-* headers is recognised and passed")

        # 8. A site that refuses this network: refused directly, served through the owner's proxy (with a password).
        result = await load(playwright, site + "/net/forms.pdf", want="resource", in_scope=in_scope)
        check(result.status == 403, "a site blocking this network refuses the browser too, without the owner's route")
        with serve_proxy() as (proxy_url, seen), patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": proxy_url}):
            result = await load(playwright, site + "/net/forms.pdf", want="resource", in_scope=in_scope)
            check(result.status == 200 and result.body == PDF and bool(seen), f"through the owner's password-protected proxy the PDF arrives ({len(seen)} proxied requests)")


async def pw_render(url, binary, **options):
    async with async_playwright() as playwright:
        context, page = await open_page(playwright, BINARY, pw_render.profile)
        try:
            return await browser_fetch._drive(page, url, **options)
        finally:
            await context.close()


def engine_checks(site):
    """Whole scans through regmon.engine, with the real fetch() and a real browser."""
    from engine_harness import SOURCE, Sandbox
    from regmon import fetch as fetch_module

    def scan(urls, proxy=None, browser=True):
        pw_render.profile = tempfile.mkdtemp()
        src = dataclasses.replace(SOURCE, seed_urls=tuple(urls), allowed_urls=tuple(urls), allowed_prefixes=(site + "/",), allowed_domains=("127.0.0.1",))
        with Sandbox(source=src) as box, patch.dict(os.environ, {"CHANGESENTINEL_BROWSER_PROXY": proxy or ""}), \
                patch("regmon.browser_fetch._render", pw_render), patch("regmon.browser_fetch.available", return_value=browser), \
                patch("regmon.browser_fetch.browser_binary", return_value="chrome"), \
                patch("regmon.fetch.validate_public_http_url"), \
                patch("regmon.fetch.public_destinations_only", lambda: __import__("contextlib").nullcontext()), \
                patch("regmon.discovery.in_scope", lambda u, s: u.startswith(site + "/")):
            box.discovered = list(urls)
            result = box.scan(lambda url, **kw: fetch_module.fetch(url, **kw))
            return {record["canonical_url"].replace(site, ""): record for record in result["inventory"].values()}

    record = scan([site + "/ua/forms.pdf"], browser=False)["/ua/forms.pdf"]
    check(not record.get("fetch_error") and record.get("fetched_with") == "browser headers" and record.get("extraction_type") == "pdf",
          "engine: a site refusing non-browser agents is read with browser headers, no browser needed")
    records = scan([site + "/waf/forms/page", site + "/kasada/forms.pdf"])
    check(all(not r.get("fetch_error") and r.get("browser", {}).get("passed_check") for r in records.values()),
          "engine: AWS WAF (202) and Kasada (429) go to the browser automatically and are stored ("
          + ", ".join(f"{k} via {r.get('browser', {}).get('passed_check')}" for k, r in records.items()) + ")")
    records = scan([site + "/net/a.pdf", site + "/net/b.pdf"])
    check(all(str(r.get("fetch_error") or "").startswith("AccessRefusedError: HTTP 403") for r in records.values()),
          "engine: a site blocking this network becomes a calm AccessRefusedError (last good copy kept)")
    with serve_proxy() as (proxy_url, seen):
        record = scan([site + "/net/a.pdf"], proxy=proxy_url)["/net/a.pdf"]
    check(not record.get("fetch_error") and record.get("extraction_type") == "pdf" and bool(seen),
          "engine: with the owner's proxy set, the refused PDF is fetched through it and stored")


def main() -> int:
    with serve() as (site, _widget, hits), patch("regmon.browser_fetch.validate_public_http_url"), \
            patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", browser_fetch.CHALLENGE_FRAME_HOSTS | {"localhost"}):
        asyncio.run(browser_checks(site, hits))
        engine_checks(site)
    print(f"{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    BINARY = browser_fetch.browser_binary()
    if not BINARY:
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                BINARY = p.chromium.executable_path
        except Exception:
            BINARY = ""
    if not BINARY:
        print("SKIP no Chrome or Chromium found")
        sys.exit(0)
    sys.exit(main())
