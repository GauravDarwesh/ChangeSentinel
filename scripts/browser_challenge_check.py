#!/usr/bin/env python3
"""Real-browser check of the bot-check path (regmon/browser_fetch.py) on a simulated Cloudflare site.

The engine drives Chrome with pydoll; this check drives the same ``_drive``
code through Playwright's DevTools session, so it runs wherever Playwright's
Chromium is installed. ``tests/test_browser_fetch.py`` runs the pydoll path
itself when CHANGESENTINEL_BROWSER_TEST=1.

    python scripts/browser_challenge_check.py
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from challenge_site import PAGE, PDF, serve  # noqa: E402

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


def check(condition, message):
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        FAILURES.append(message)


async def open_page(playwright, binary, profile, *, stealth=True):
    arguments = [a for a in browser_fetch.launch_arguments(binary) if not a.startswith("--user-data-dir")]
    if not stealth:
        arguments = [a for a in arguments if not a.startswith(("--user-agent", "--disable-blink-features"))]
    context = await playwright.chromium.launch_persistent_context(
        profile, executable_path=binary, headless=False, args=arguments,
        ignore_default_args=["--enable-automation", "--headless"] if stealth else ["--headless"])
    page = context.pages[0] if context.pages else await context.new_page()
    return context, PlaywrightPage(await context.new_cdp_session(page))


async def main(binary: str) -> int:
    import tempfile

    with serve() as (site, widget, hits), patch("regmon.browser_fetch.validate_public_http_url"), \
            patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", frozenset({"localhost"})):
        in_scope = lambda url: url.startswith(site + "/")
        async with async_playwright() as playwright:
            # 1. A PDF behind a managed challenge: the check passes, the PDF comes back whole.
            profile = tempfile.mkdtemp()
            context, page = await open_page(playwright, binary, profile)
            started = time.monotonic()
            result = await browser_fetch._drive(page, site + "/forms/big.pdf", want="resource", in_scope=in_scope)
            check(result.challenge == "Cloudflare", f"the Cloudflare check was met and passed ({time.monotonic() - started:.1f}s)")
            check(result.body == PDF and result.status == 200, f"the PDF came back byte for byte ({len(result.body or b'')} bytes)")
            check("pdf" in result.content_type and result.headers.get("last-modified"), "its content type and Last-Modified were kept")
            # 2. The next URL on the site reuses the clearance: no check, the server's own HTML.
            await context.close()
            context, page = await open_page(playwright, binary, profile)
            started = time.monotonic()
            result = await browser_fetch._drive(page, site + "/forms/page", want="resource", in_scope=in_scope)
            check(result.challenge == "" and b"FFIEC 031 reporting forms" in result.body, f"a second URL reused the clearance ({time.monotonic() - started:.1f}s)")
            check(result.body == PAGE, "resource mode keeps the server's HTML, not the rendered DOM")
            # 3. Browser mode still renders, after the check.
            await context.close()
            context, page = await open_page(playwright, binary, profile)
            result = await browser_fetch._drive(page, site + "/forms/page", want="dom", in_scope=in_scope, wait_seconds=0.5, dismiss=False)
            check(b"Rendered by script" in result.html, "browser mode returns the rendered page")
            await context.close()

            # 4. What went wrong before: the widget frame was blocked as out of scope.
            with patch.object(browser_fetch, "CHALLENGE_FRAME_HOSTS", frozenset()):
                context, page = await open_page(playwright, binary, tempfile.mkdtemp())
                try:
                    await browser_fetch._drive(page, site + "/forms/big.pdf", want="resource", in_scope=in_scope, challenge_wait=6)
                    check(False, "blocking the widget frame makes the check fail")
                except browser_fetch.ChallengeNotPassed as exc:
                    check(exc.vendor == "Cloudflare", "blocking the widget frame makes the check fail (the old behaviour)")
                await context.close()
            # 5. ...and so did announcing headless Chrome.
            context, page = await open_page(playwright, binary, tempfile.mkdtemp(), stealth=False)
            try:
                await browser_fetch._drive(page, site + "/forms/big.pdf", want="resource", in_scope=in_scope, challenge_wait=6)
                check(False, "a HeadlessChrome user agent is refused")
            except browser_fetch.ChallengeNotPassed:
                check(True, "a HeadlessChrome user agent is refused (the old behaviour)")
            await context.close()
            # 6. A check that wants a person ends cleanly, with the page saved for review.
            context, page = await open_page(playwright, binary, tempfile.mkdtemp())
            started = time.monotonic()
            try:
                await browser_fetch._drive(page, site + "/hard/forms.pdf", want="resource", in_scope=in_scope, challenge_wait=4)
                check(False, "an unsolvable check raises ChallengeNotPassed")
            except browser_fetch.ChallengeNotPassed as exc:
                check(b"Just a moment" in exc.page and time.monotonic() - started < 15,
                      f"an unsolvable check gives up after its wait ({time.monotonic() - started:.1f}s) with the page kept")
            await context.close()
    print(f"{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    binary = browser_fetch.browser_binary()
    if not binary:
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                binary = p.chromium.executable_path
        except Exception:
            binary = ""
    if not binary:
        print("SKIP no Chrome or Chromium found")
        sys.exit(0)
    sys.exit(asyncio.run(main(binary)))
