"""Opt-in browser rendering for pages that build their content with JavaScript.

A source with ``fetch_mode: "browser"`` still fetches every URL over plain
HTTP first (status, validators, documents). For an HTML page, the page is then
loaded in headless Chrome (pydoll, already used for crawl discovery), given
``browser_wait_seconds`` to settle (or until ``browser_wait_selector``
appears), a cookie or consent banner is answered with its most
privacy-preserving choice, and the rendered DOM replaces the HTTP body for
extraction and comparison.

Every request the page makes is intercepted: only public http(s)
destinations are allowed, and a top-level navigation must stay inside the
monitor's scope. As with plain fetching, DNS checks reduce but do not
eliminate rebinding risk; high-assurance deployments need egress controls.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import threading
from dataclasses import dataclass

from regmon.security import validate_public_http_url

MAX_WAIT_SECONDS = 20
DEFAULT_WAIT_SECONDS = 3
RENDER_TIMEOUT_SECONDS = 60
_LOCK = threading.Lock()  # One browser at a time: renders are rare and heavy.

# Consent banners: reject/necessary-only first, then a plain close. Matching is
# on button text in the languages regulators publish in, or on well-known ids.
DISMISS_SCRIPT = r"""
(() => {
  const ids = ['#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '.cc-deny', '#cookie-reject',
    '[data-cookiefirst-action="reject"]', '#didomi-notice-disagree-button', '.cky-btn-reject', '#truste-consent-required'];
  for (const sel of ids) { const el = document.querySelector(sel); if (el) { el.click(); return 'id:' + sel; } }
  const words = /^(reject( all)?|decline( all)?|refuse|only (necessary|essential)( cookies)?|necessary only|use necessary cookies only|rechazar( todo| todas)?|solo (necesarias|esenciales)|recusar( todos)?|rejeitar( todos)?|apenas (necess[aá]rios|essenciais)|refuser( tout)?|tout refuser|ablehnen|alle ablehnen|nur notwendige|rifiuta( tutto)?)$/i;
  const close = /^(close|dismiss|ok|got it|cerrar|fechar|fermer|schlie(ss|ß)en|chiudi|×|x)$/i;
  const buttons = Array.from(document.querySelectorAll('button, [role=button], a.button, input[type=button]'))
    .filter(el => el.offsetParent !== null);
  const text = el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  const reject = buttons.find(el => words.test(text(el)));
  if (reject) { reject.click(); return 'text:' + text(reject); }
  const banner = buttons.find(el => close.test(text(el)) && /cookie|consent|privacy|gdpr|lgpd/i.test((el.closest('[class],[id]') || {}).outerHTML ? el.closest('[class],[id]').className + ' ' + el.closest('[class],[id]').id : ''));
  if (banner) { banner.click(); return 'close:' + text(banner); }
  return '';
})()
"""


@dataclass(frozen=True)
class Rendered:
    html: bytes
    final_url: str
    blocked: int
    consent: str


def browser_binary() -> str:
    """Chrome to use: CHANGESENTINEL_CHROME, else a Chrome/Chromium on PATH."""
    explicit = os.environ.get("CHANGESENTINEL_CHROME", "").strip()
    if explicit:
        return explicit
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def _allowed(url: str, resource_type: str, in_scope) -> bool:
    if not url.startswith(("http://", "https://")):
        # data:, blob: and about: never leave the browser.
        return url.startswith(("data:", "blob:", "about:"))
    try:
        validate_public_http_url(url, resolve_dns=True)
    except Exception:
        return False
    if resource_type == "Document" and in_scope is not None and not in_scope(url):
        return False
    return True


async def _render(url: str, wait_seconds: float, wait_selector: str, dismiss: bool, in_scope, binary: str) -> Rendered:
    from pydoll.browser.chrome import Chrome
    from pydoll.browser.options import Options
    from pydoll.commands.fetch import FetchCommands
    from pydoll.commands.runtime import RuntimeCommands

    options = Options()
    if binary:
        options.binary_location = binary
    for argument in ("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
                     "--disable-extensions", "--disable-background-networking", "--mute-audio", "--window-size=1366,900"):
        options.add_argument(argument)
    blocked = 0
    async with Chrome(options=options) as browser:
        await browser.start()
        page = await browser.get_page()

        async def on_request(event):
            nonlocal blocked
            params = event.get("params", {})
            request_id = params.get("requestId")
            target = str((params.get("request") or {}).get("url") or "")
            # Every document load (the page, its redirects and any frame) must
            # stay in the monitor's scope; other resources only need to be public.
            if _allowed(target, str(params.get("resourceType") or ""), in_scope):
                await page._execute_command(FetchCommands.continue_request(request_id))
            else:
                blocked += 1
                await page._execute_command(FetchCommands.fail_request(request_id, "BlockedByClient"))

        await page.enable_fetch_events(resource_type="")
        await page.on("Fetch.requestPaused", on_request)
        await page.go_to(url, timeout=RENDER_TIMEOUT_SECONDS)
        if dismiss:
            await asyncio.sleep(0.8)
            consent = await page._execute_command(RuntimeCommands.evaluate_script(DISMISS_SCRIPT))
            consent_text = str(((consent or {}).get("result") or {}).get("result", {}).get("value") or "")
        else:
            consent_text = ""
        deadline = asyncio.get_running_loop().time() + wait_seconds
        if wait_selector:
            while asyncio.get_running_loop().time() < deadline:
                found = await page._execute_command(RuntimeCommands.evaluate_script(
                    "!!document.querySelector(" + _js_string(wait_selector) + ")"))
                if ((found or {}).get("result") or {}).get("result", {}).get("value"):
                    break
                await asyncio.sleep(0.25)
        else:
            await asyncio.sleep(max(0.0, wait_seconds))
        html = await page.page_source
        final = await page.current_url
        return Rendered(html=html.encode("utf-8"), final_url=str(final or url), blocked=blocked, consent=consent_text)


def _js_string(value: str) -> str:
    import json

    return json.dumps(str(value))


def render(url: str, *, wait_seconds: float = DEFAULT_WAIT_SECONDS, wait_selector: str = "", dismiss_cookies: bool = True,
           in_scope=None) -> Rendered:
    """Render one page in headless Chrome. Raises RuntimeError when no browser is available."""
    validate_public_http_url(url, resolve_dns=True)
    binary = browser_binary()
    if not binary:
        raise RuntimeError("Browser fetch needs Chrome or Chromium (set CHANGESENTINEL_CHROME)")
    wait = max(0.0, min(float(wait_seconds), MAX_WAIT_SECONDS))
    with _LOCK:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(asyncio.wait_for(
                _render(url, wait, wait_selector, dismiss_cookies, in_scope, binary),
                timeout=RENDER_TIMEOUT_SECONDS + wait + 15,
            ))
        finally:
            loop.close()
