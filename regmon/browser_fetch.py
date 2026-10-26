"""Browser loading: JavaScript-built pages, and getting past bot checks.

Two jobs use the browser. Pydoll is the primary backend; SeleniumBase CDP takes over whenever Pydoll does not deliver the page (it still sees a bot check, or it fails to start or talk to Chrome):

* ``fetch_mode: "browser"`` pages are loaded, given ``browser_wait_seconds``
  to settle (or until ``browser_wait_selector`` appears), a cookie or consent
  banner is answered with its most privacy-preserving choice, recorded steps
  are replayed (``browser_actions``, regmon/browser_actions.py), and the
  rendered DOM replaces the HTTP body for extraction and comparison.
* Any monitor whose plain request gets a bot-check page (Cloudflare "Just a
  moment…", DataDome …) is loaded in the browser instead, automatically. The
  vendor's check runs in a real browser, and once it lets the browser through
  the exact bytes the server sends for the URL are kept: a PDF comes back as
  the PDF, a page as the same HTML a plain request would have got, so the
  baseline does not depend on how the copy was obtained.

How the second job works: the main page's response is intercepted inside the
browser. A challenge response is left alone so its script can run; the first
real response is read in chunks (a large PDF does not fit one DevTools
message) and the page is shown a placeholder instead, so a file never turns
into a download. The browser keeps one profile for the whole run, so after
one check is passed the other URLs on that site load straight away.

The browser presents itself as ordinary Chrome (no "HeadlessChrome" user
agent, no automation flag) because sites refuse those outright. It never
solves an interactive puzzle: when a site insists on a person ticking a box,
the attempt ends, the last good copy stays the baseline and the scan tries
again next time (regmon/engine.py).

Every request the page makes is intercepted: only public http(s)
destinations are allowed, and a document load must stay inside the monitor's
scope. The one exception is a frame from a known challenge host
(``CHALLENGE_FRAME_HOSTS``): blocking it would make every check fail. As with
plain fetching, DNS checks reduce but do not eliminate rebinding risk;
high-assurance deployments need egress controls.
"""
from __future__ import annotations

import asyncio
import atexit
import base64
import os
import re
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from regmon import botcheck
from regmon.browser_actions import describe as describe_step
from regmon.browser_actions import step_expression
from regmon.security import validate_public_http_url

MAX_WAIT_SECONDS = 20
DEFAULT_WAIT_SECONDS = 3
RENDER_TIMEOUT_SECONDS = 60
# A managed challenge usually lets a real browser through in 2-10 s.
CHALLENGE_WAIT_SECONDS = 35
SCREENSHOT_WIDTH = 1366
SCREENSHOT_MAX_HEIGHT = 8000
MAX_RESOURCE_BYTES = 200 * 1024 * 1024
READ_CHUNK_BYTES = 4 * 1024 * 1024  # IO.read answers stay well under pydoll's 10 MB message limit
_LOCK = threading.Lock()  # One browser at a time: renders are rare and heavy.

# Where bot checks draw their widgets, from each vendor's own Content-Security-
# Policy guidance (the frame-src entries a protected site must allow). A host
# matches itself and its subdomains. Frames only: the page itself can never be
# navigated to them.
CHALLENGE_FRAME_HOSTS = frozenset({
    "challenges.cloudflare.com",            # Cloudflare Turnstile / managed challenge
    "captcha-delivery.com",                 # DataDome (*.captcha-delivery.com)
    "hcaptcha.com",                         # hCaptcha (Imperva, others)
    "recaptcha.net", "recaptcha.google.com",  # Google reCAPTCHA
    "arkoselabs.com",                       # Arkose Labs
    "awswaf.com",                           # AWS WAF CAPTCHA
    "perimeterx.net", "px-cdn.net", "px-cloud.net", "pxchk.net", "px-client.net",  # HUMAN / PerimeterX
    "frcapi.com",                           # Friendly Captcha
})
# reCAPTCHA also frames from www.google.com, but only under /recaptcha/.
CHALLENGE_FRAME_PREFIXES = ("https://www.google.com/recaptcha/",)
# Cookies a vendor sets once the browser has passed its check.
CLEARANCE_COOKIES = ("cf_clearance", "datadome")
# Response headers that describe the original transfer, not the body we pass on.
_HOP_HEADERS = {"content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"}
PLACEHOLDER = b"<!DOCTYPE html><html><head><title>Saved</title></head><body>ChangeSentinel saved this file.</body></html>"

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
    screenshot: bytes | None = None
    steps: int = 0
    # The response the server sent for the URL, read inside the browser. Set
    # when the page was loaded to get past a bot check (``want="resource"``)
    # or when a browser-mode URL turned out to be a file.
    status: int = 200
    content_type: str = "text/html; charset=utf-8"
    body: bytes | None = None
    headers: dict = field(default_factory=dict)
    challenge: str = ""  # the bot check the browser passed on the way, if any


class ChallengeNotPassed(RuntimeError):
    """The site kept showing its bot check to the browser."""

    def __init__(self, vendor: str, page: bytes, cleared: bool = False, waited: float | None = None):
        self.vendor = vendor
        self.page = page
        waited = CHALLENGE_WAIT_SECONDS if waited is None else waited
        reason = ("it accepted the browser but did not send the page" if cleared
                  else f"it still asked for a check after {waited:g} s (a check that needs a person is never answered)")
        super().__init__(f"{vendor} bot check: {reason}")


def _value(response) -> object:
    """The value of a Runtime.evaluate answer (pydoll's raw reply)."""
    return ((response or {}).get("result") or {}).get("result", {}).get("value")


async def run_steps(evaluate, steps: list[dict], sleep=asyncio.sleep, clock=None) -> int:
    """Replay recorded steps through ``evaluate(expression)``; raise RuntimeError naming the failing step."""
    clock = clock or (lambda: asyncio.get_running_loop().time())
    for index, step in enumerate(steps, start=1):
        label = f"Step {index} ({describe_step(step)})"
        if step["action"] == "wait":
            await sleep(float(step["seconds"]))
            continue
        if step["action"] == "wait_for":
            deadline = clock() + float(step["seconds"])
            while True:
                outcome = str(await evaluate(step_expression(step)) or "")
                if outcome == "ok":
                    break
                if outcome.startswith("error"):
                    raise RuntimeError(f"{label}: {outcome[7:]}")
                if clock() >= deadline:
                    raise RuntimeError(f"{label}: nothing appeared within {step['seconds']} s")
                await sleep(0.25)
            continue
        outcome = str(await evaluate(step_expression(step)) or "")
        if outcome != "ok":
            raise RuntimeError(f"{label}: {outcome[7:] if outcome.startswith('error') else outcome or 'no answer from the page'}")
        if step["action"] in {"click", "press", "select", "check", "uncheck"}:
            # Let a click that loads a page or refreshes a table settle.
            await sleep(0.6)
            deadline = clock() + 10
            while clock() < deadline and str(await evaluate("document.readyState") or "") != "complete":
                await sleep(0.25)
    return len(steps)


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


def _pydoll_available() -> bool:
    """Whether the primary Pydoll backend is installed."""
    try:
        import pydoll  # noqa: F401
    except ImportError:
        return False
    return True


def _seleniumbase_available() -> bool:
    """Whether SeleniumBase's pure-CDP backend is installed."""
    try:
        from seleniumbase.undetected.cdp_driver import cdp_util  # noqa: F401
        import mycdp.fetch  # noqa: F401
    except ImportError:
        return False
    return True


def available() -> bool:
    """Whether Chrome and at least one supported browser backend are available."""
    return bool(browser_binary()) and (_pydoll_available() or _seleniumbase_available())


_VERSIONS: dict[str, str] = {}


def user_agent(binary: str) -> str:
    """An ordinary desktop Chrome user agent for ``binary``'s major version ("" when unknown).

    Headless Chrome announces itself as "HeadlessChrome", which bot checks
    refuse on sight; the browser is the same Chrome either way.
    """
    if binary not in _VERSIONS:
        try:
            output = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15).stdout
        except (OSError, subprocess.SubprocessError):
            output = ""
        match = re.search(r"(\d+)\.\d+\.\d+", output or "")
        _VERSIONS[binary] = match.group(1) if match else ""
    major = _VERSIONS[binary]
    if not major:
        return ""
    return f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"


_PROFILE: list[str] = []


def profile_dir() -> str:
    """One Chrome profile per process, so a passed check carries over to the next URL on that site."""
    if not _PROFILE:
        path = tempfile.mkdtemp(prefix="changesentinel-chrome-")
        atexit.register(shutil.rmtree, path, True)
        _PROFILE.append(path)
    return _PROFILE[0]


def proxy_setting() -> tuple[str, str, str]:
    """(server, user, password) from CHANGESENTINEL_BROWSER_PROXY, or empty strings.

    The owner's own route out (an office proxy, a gateway on their network) for
    sites that refuse cloud addresses; only browser loads use it.
    """
    from urllib.parse import unquote

    value = os.environ.get("CHANGESENTINEL_BROWSER_PROXY", "").strip()
    if not value:
        return "", "", ""
    if "://" not in value:
        value = "http://" + value
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https", "socks5"} or not parts.hostname:
        raise RuntimeError("CHANGESENTINEL_BROWSER_PROXY must look like http://host:port (optionally user:password@)")
    server = f"{parts.scheme}://{parts.hostname}" + (f":{parts.port}" if parts.port else "")
    return server, unquote(parts.username or ""), unquote(parts.password or "")


def launch_arguments(binary: str) -> list[str]:
    arguments = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
                 "--disable-extensions", "--disable-background-networking", "--mute-audio", "--window-size=1366,900",
                 "--disable-blink-features=AutomationControlled", "--lang=en-US", f"--user-data-dir={profile_dir()}"]
    agent = user_agent(binary)
    if agent:
        arguments.append(f"--user-agent={agent}")
    server = proxy_setting()[0]
    if server:
        arguments.append(f"--proxy-server={server}")
    return arguments


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def is_challenge_frame(url: str) -> bool:
    host = _host(url)
    if any(host == known or host.endswith("." + known) for known in CHALLENGE_FRAME_HOSTS):
        return True
    return url.startswith(CHALLENGE_FRAME_PREFIXES)


# Query parameters a bot check adds to the page's own URL while it runs and
# when it hands the browser back (Cloudflare: __cf_chl_rt_tk while checking,
# __cf_chl_f_tk / __cf_chl_tk on the return). They are the vendor's, not the
# site's, so scope is judged on the URL without them; otherwise a monitor
# scoped to one exact URL blocks the return and the check can never finish.
CHALLENGE_QUERY_PREFIXES = ("__cf_chl_",)


def without_challenge_tokens(url: str) -> str:
    """``url`` with any bot-check query parameters removed (other parameters kept in order)."""
    from urllib.parse import parse_qsl, urlencode, urlunsplit

    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.query or "__" not in parts.query:
        return url
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    kept = [(key, value) for key, value in pairs if not key.lower().startswith(CHALLENGE_QUERY_PREFIXES)]
    if len(kept) == len(pairs):
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))


def _allowed(url: str, resource_type: str, in_scope, main_frame: bool = True) -> bool:
    if not url.startswith(("http://", "https://")):
        # data:, blob: and about: never leave the browser.
        return url.startswith(("data:", "blob:", "about:"))
    try:
        validate_public_http_url(url, resolve_dns=True)
    except Exception:
        return False
    if resource_type == "Document" and in_scope is not None and not in_scope(without_challenge_tokens(url)):
        # A bot check draws its widget in a frame from the vendor's host;
        # blocking that frame means the check can never pass.
        return not main_frame and is_challenge_frame(url)
    return True


def _header(headers: list[dict] | None, name: str) -> str:
    for entry in headers or []:
        if str(entry.get("name", "")).lower() == name:
            return str(entry.get("value", ""))
    return ""


class _Page:
    """What ``_drive`` needs from a browser tab: DevTools commands and events.

    ``send(method, params)`` returns the command's result (raising on a
    DevTools error); ``on(event, handler)`` calls ``await handler(params)``
    for each event. pydoll provides it in production, Playwright in tests.
    """

    async def send(self, method: str, params: dict | None = None) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    async def on(self, event: str, handler) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class _PydollPage(_Page):
    def __init__(self, page):
        self.page = page

    async def send(self, method, params=None):
        response = await self.page._execute_command({"method": method, "params": params or {}})
        if isinstance(response, dict) and response.get("error"):
            raise RuntimeError(f"{method}: {(response['error'] or {}).get('message', response['error'])}")
        return (response or {}).get("result") or {}

    async def on(self, event, handler):
        async def wrapped(message):
            await handler((message or {}).get("params") or {})

        await self.page.on(event, wrapped)


def _raw_cdp_command(method: str, params: dict | None = None):
    """Build a MyCDP command from the same raw method/params pair used by Pydoll."""
    result = yield {"method": method, "params": params or {}}
    return result


def _enum_value(value: object) -> str:
    """Return the protocol value of a MyCDP enum or a plain value."""
    if value is None:
        return ""
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str) and enum_value:
        return enum_value
    enum_name = getattr(value, "name", None)
    if isinstance(enum_name, str) and enum_name:
        return enum_name.replace("_", " ").title()
    return str(value)


class _SeleniumBasePage(_Page):
    """Adapt SeleniumBase's CDP tab to browser_fetch's small raw-CDP interface.

    Keeping _drive as the shared implementation preserves its URL-scope and
    public-destination checks, response capture, size limits, and challenge
    detection for both browser backends.
    """

    def __init__(self, page):
        self.page = page

    async def send(self, method, params=None):
        return await self.page.send(_raw_cdp_command(method, params or {}))

    @staticmethod
    def _request_paused_params(event) -> dict:
        request = getattr(event, "request", None)
        resource_type = _enum_value(getattr(event, "resource_type", ""))
        if resource_type.lower() == "document":
            resource_type = "Document"
        params = {
            "requestId": str(getattr(event, "request_id", "")),
            "request": {"url": str(getattr(request, "url", "") or "")},
            "frameId": str(getattr(event, "frame_id", "") or ""),
            "resourceType": resource_type,
        }
        status = getattr(event, "response_status_code", None)
        if status is not None:
            params["responseStatusCode"] = status
        error = getattr(event, "response_error_reason", None)
        if error is not None:
            params["responseErrorReason"] = _enum_value(error)
        headers = getattr(event, "response_headers", None) or []
        params["responseHeaders"] = [
            {"name": str(getattr(item, "name", "")), "value": str(getattr(item, "value", ""))}
            for item in headers
        ]
        return params

    @staticmethod
    def _auth_required_params(event) -> dict:
        challenge = getattr(event, "auth_challenge", None)
        params = {
            "requestId": str(getattr(event, "request_id", "")),
            "authChallenge": {
                "source": _enum_value(getattr(challenge, "source", "")),
                "origin": str(getattr(challenge, "origin", "") or ""),
                "scheme": str(getattr(challenge, "scheme", "") or ""),
                "realm": str(getattr(challenge, "realm", "") or ""),
            },
        }
        return params

    async def on(self, event, handler):
        import mycdp.fetch as cdp_fetch

        event_types = {
            "Fetch.requestPaused": (cdp_fetch.RequestPaused, self._request_paused_params),
            "Fetch.authRequired": (cdp_fetch.AuthRequired, self._auth_required_params),
        }
        if event not in event_types:
            raise RuntimeError(f"Unsupported SeleniumBase CDP event: {event}")
        event_type, convert = event_types[event]

        async def wrapped(payload):
            await handler(convert(payload))

        self.page.add_handler(event_type, wrapped)


async def _read_stream(page: _Page, handle: str, max_bytes: int) -> bytes:
    chunks, total = [], 0
    try:
        while True:
            answer = await page.send("IO.read", {"handle": handle, "size": READ_CHUNK_BYTES})
            data = answer.get("data") or ""
            chunk = base64.b64decode(data) if answer.get("base64Encoded") else data.encode("latin-1", "replace")
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError(f"the file is larger than {max_bytes} bytes")
            chunks.append(chunk)
            if answer.get("eof"):
                return b"".join(chunks)
    finally:
        try:
            await page.send("IO.close", {"handle": handle})
        except Exception:
            pass


async def _drive(page: _Page, url: str, *, want: str = "dom", wait_seconds: float = 0, wait_selector: str = "",
                 dismiss: bool = True, in_scope=None, steps: list[dict] | None = None, screenshot: bool = False,
                 challenge_wait: float | None = None, max_bytes: int = MAX_RESOURCE_BYTES,
                 sleep=asyncio.sleep) -> Rendered:
    """Load ``url`` in ``page`` and return what ``want`` asks for.

    ``want="resource"``: the bytes the server sends once any bot check has let
    the browser through (no settle wait, no steps). ``want="dom"``: the
    rendered page after the usual wait, consent answer and steps; a URL that
    turns out to be a file comes back as the file.
    """
    loop = asyncio.get_running_loop()
    challenge_wait = CHALLENGE_WAIT_SECONDS if challenge_wait is None else challenge_wait
    tree = await page.send("Page.getFrameTree")
    main_frame = (((tree or {}).get("frameTree") or {}).get("frame") or {}).get("id", "")
    blocked = 0
    seen: list[str] = []          # bot-check vendors met on the way
    captured: dict = {}           # the real main-document response
    arrived = asyncio.Event()
    failure: list[BaseException] = []

    async def on_paused(params):
        nonlocal blocked
        request_id = params.get("requestId")
        request = params.get("request") or {}
        target = str(request.get("url") or "")
        is_main = str(params.get("frameId") or "") == main_frame
        try:
            if "responseStatusCode" not in params and "responseErrorReason" not in params:
                # Request stage: every document load (the page, its redirects
                # and any frame) must stay in scope; other resources only need
                # to be public.
                if _allowed(target, str(params.get("resourceType") or ""), in_scope, main_frame=is_main):
                    await page.send("Fetch.continueRequest", {"requestId": request_id})
                else:
                    blocked += 1
                    await page.send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
                return
            # Response stage (main-frame documents only, see the patterns below).
            status = int(params.get("responseStatusCode") or 0)
            headers = params.get("responseHeaders") or []
            if not is_main or captured or params.get("responseErrorReason") or 300 <= status < 400:
                await page.send("Fetch.continueRequest", {"requestId": request_id})
                return
            content_type = _header(headers, "content-type")
            if "html" in content_type.lower() or not content_type:
                answer = await page.send("Fetch.getResponseBody", {"requestId": request_id})
                body = base64.b64decode(answer.get("body") or "") if answer.get("base64Encoded") else str(answer.get("body") or "").encode("utf-8")
                vendor = botcheck.detect(body, status, {str(h.get("name", "")).lower(): str(h.get("value", "")) for h in headers})
                if vendor:
                    # Leave the check alone so its script can run.
                    if vendor not in seen:
                        seen.append(vendor)
                    await page.send("Fetch.continueRequest", {"requestId": request_id})
                    return
                shown = body
            else:
                stream = await page.send("Fetch.takeResponseBodyAsStream", {"requestId": request_id})
                body = await _read_stream(page, stream["stream"], max_bytes)
                shown = PLACEHOLDER  # a file shown as a page would become a download
            captured.update(status=status, url=without_challenge_tokens(target), content_type=content_type, body=body,
                            headers={str(h.get("name", "")).lower(): str(h.get("value", "")) for h in headers})
            passed = [h for h in headers if str(h.get("name", "")).lower() not in _HOP_HEADERS]
            if shown is PLACEHOLDER:
                passed = [{"name": "Content-Type", "value": "text/html; charset=utf-8"}]
            await page.send("Fetch.fulfillRequest", {"requestId": request_id, "responseCode": status or 200,
                                                     "responseHeaders": passed, "body": base64.b64encode(shown).decode("ascii")})
            arrived.set()
        except Exception as exc:  # pragma: no cover - surfaced below
            failure.append(exc)
            arrived.set()
            try:
                await page.send("Fetch.failRequest", {"requestId": request_id, "errorReason": "Failed"})
            except Exception:
                pass

    async def evaluate(expression: str):
        answer = await page.send("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        return ((answer or {}).get("result") or {}).get("value")

    async def source() -> bytes:
        return str(await evaluate("document.documentElement ? document.documentElement.outerHTML : ''") or "").encode("utf-8")

    async def cleared() -> bool:
        try:
            cookies = (await page.send("Network.getAllCookies")).get("cookies") or []
        except Exception:
            return False
        host = _host(url)
        return any(c.get("name") in CLEARANCE_COOKIES and host.endswith(str(c.get("domain", "")).lstrip(".")) for c in cookies)

    _server, proxy_user, proxy_password = proxy_setting()
    auth_answered: set[str] = set()

    async def on_auth(params):
        # Only the configured proxy gets credentials, and only once per request;
        # a site's own login prompt is cancelled.
        request_id = params.get("requestId")
        challenge = params.get("authChallenge") or {}
        if challenge.get("source") == "Proxy" and proxy_user and request_id not in auth_answered:
            auth_answered.add(request_id)
            answer = {"response": "ProvideCredentials", "username": proxy_user, "password": proxy_password}
        else:
            answer = {"response": "CancelAuth"}
        try:
            await page.send("Fetch.continueWithAuth", {"requestId": request_id, "authChallengeResponse": answer})
        except Exception:
            pass

    await page.on("Fetch.requestPaused", on_paused)
    await page.on("Fetch.authRequired", on_auth)
    await page.send("Fetch.enable", {"handleAuthRequests": True, "patterns": [
        {"urlPattern": "*", "requestStage": "Request"},
        {"urlPattern": "*", "resourceType": "Document", "requestStage": "Response"},
    ]})
    navigation = await page.send("Page.navigate", {"url": url})
    if navigation.get("errorText") and navigation["errorText"] != "net::ERR_ABORTED":
        raise RuntimeError(f"Browser could not load the page: {navigation['errorText']}")

    # Wait for the real document: at once without a check, after the check otherwise.
    deadline = loop.time() + RENDER_TIMEOUT_SECONDS
    check_started = False
    while not arrived.is_set():
        if seen and not check_started:
            check_started = True
            deadline = min(deadline, loop.time() + challenge_wait)
        if loop.time() >= deadline:
            break
        try:
            await asyncio.wait_for(arrived.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass
    if failure:
        raise RuntimeError(f"Browser could not read the response: {type(failure[0]).__name__}: {failure[0]}")
    if not captured:
        page_now = await source()
        vendor = (seen[0] if seen else "") or botcheck.detect(page_now) or ""
        if vendor:
            raise ChallengeNotPassed(vendor, page_now, cleared=await cleared(), waited=challenge_wait)
        raise RuntimeError("Browser got no response for the page in time")
    challenge = seen[0] if seen else ""
    is_file = bool(captured["content_type"]) and "html" not in captured["content_type"].lower()
    if want == "resource" or is_file:
        return Rendered(html=captured["body"] if not is_file else b"", final_url=captured["url"], blocked=blocked, consent="",
                        status=captured["status"], content_type=captured["content_type"] or "text/html; charset=utf-8",
                        body=captured["body"], headers=captured["headers"], challenge=challenge)

    # Rendered page: let it finish loading, then the usual settle, consent and steps.
    ready_by = loop.time() + 15
    while loop.time() < ready_by and str(await evaluate("document.readyState") or "") != "complete":
        await sleep(0.25)
    consent_text = ""
    if dismiss:
        await sleep(0.8)
        consent_text = str(await evaluate(DISMISS_SCRIPT) or "")
    settle_by = loop.time() + wait_seconds
    if wait_selector:
        import json

        while loop.time() < settle_by:
            if await evaluate("!!document.querySelector(" + json.dumps(str(wait_selector)) + ")"):
                break
            await sleep(0.25)
    else:
        await sleep(max(0.0, wait_seconds))
    replayed = await run_steps(evaluate, steps or [], sleep=sleep)
    image = await _screenshot(page, evaluate) if screenshot else None
    html = await source()
    final = str(await evaluate("location.href") or url)
    return Rendered(html=html, final_url=final, blocked=blocked, consent=consent_text, screenshot=image, steps=replayed,
                    status=captured["status"], headers=captured["headers"], challenge=challenge)


async def _screenshot(page: _Page, evaluate) -> bytes | None:
    """A PNG of the whole page (up to SCREENSHOT_MAX_HEIGHT), or None when Chrome declines."""
    try:
        height = int(float(await evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)") or 0))
        height = max(1, min(height or 900, SCREENSHOT_MAX_HEIGHT))
        await evaluate("window.scrollTo(0, 0)")
        response = await page.send("Page.captureScreenshot", {
            "format": "png", "captureBeyondViewport": True, "fromSurface": True,
            "clip": {"x": 0, "y": 0, "width": SCREENSHOT_WIDTH, "height": height, "scale": 1}})
        data = (response or {}).get("data")
        return base64.b64decode(data) if data else None
    except Exception:
        return None


def _pydoll_default_arguments() -> set[str]:
    """The switches Pydoll adds by itself when it starts Chrome.

    Pydoll 3 appends them after ours and refuses any it finds already present
    (ArgumentAlreadyExistsInOptions), so they must not be passed twice.
    """
    try:
        from pydoll import ChromiumOptions
        from pydoll.browser.managers import ChromiumOptionsManager

        probe = ChromiumOptions()
        ChromiumOptionsManager(probe).add_default_arguments()
        return set(probe.arguments)
    except Exception:
        return {"--no-first-run", "--no-default-browser-check"}


def pydoll_options(binary: str):
    """Pydoll ChromiumOptions carrying launch_arguments() without the switches Pydoll adds itself."""
    from pydoll import ChromiumOptions

    chrome_options = ChromiumOptions()
    if binary:
        chrome_options.binary_location = binary
    skip = _pydoll_default_arguments()
    for argument in launch_arguments(binary):
        if argument not in skip and argument not in chrome_options.arguments:
            chrome_options.add_argument(argument)
    return chrome_options


async def _render(url: str, binary: str, **options) -> Rendered:
    # Pydoll 3 exposes Chrome/ChromiumOptions at the package level. Its
    # start() returns the initial Tab directly; _drive still uses the same
    # raw CDP commands and scope checks through _PydollPage.
    from pydoll import Chrome

    async with Chrome(options=pydoll_options(binary)) as browser:
        page = await browser.start()
        return await _drive(_PydollPage(page), url, **options)


async def _render_seleniumbase(url: str, binary: str, **options) -> Rendered:
    """Use SeleniumBase CDP as a second browser backend, sharing the run profile."""
    from seleniumbase.undetected.cdp_driver import cdp_util

    arguments = [
        argument for argument in launch_arguments(binary)
        if not argument.startswith("--user-data-dir=")
        and argument not in {"--headless=new", "--no-sandbox"}
    ]
    browser = await cdp_util.start_async(
        user_data_dir=profile_dir(),
        headless=True,
        browser_executable_path=binary,
        browser_args=arguments,
        sandbox=False,
        lang="en-US",
    )
    try:
        page = await browser.get("about:blank")
        return await _drive(_SeleniumBasePage(page), url, **options)
    finally:
        # stop() also terminates the browser process; the profile persists for
        # this run so clearance cookies can be reused by later URLs. A cleanup
        # hiccup must not mask a successful capture or the original challenge.
        try:
            browser.stop()
        except Exception:
            pass


async def _render_with_fallback(url: str, binary: str, **options) -> Rendered:
    """Try Pydoll first; use SeleniumBase CDP whenever Pydoll does not deliver the page.

    That covers a challenge Pydoll could not pass and also Pydoll failing on
    its own (a launch or protocol error after a library upgrade): one broken
    backend must not leave every protected monitor without a browser.
    """
    if not _pydoll_available():
        if _seleniumbase_available():
            return await _render_seleniumbase(url, binary, **options)
        raise RuntimeError("Browser fetch needs Pydoll or SeleniumBase CDP to be installed")

    try:
        return await _render(url, binary, **options)
    except asyncio.CancelledError:
        raise
    except Exception as primary:
        if not _seleniumbase_available():
            raise
        try:
            return await _render_seleniumbase(url, binary, **options)
        except ChallengeNotPassed:
            # Prefer the last backend's evidence; it may have progressed further
            # through the challenge than the primary browser.
            raise
        except Exception as fallback_error:
            if isinstance(primary, ChallengeNotPassed):
                # Keep the known bot-check classification and saved challenge page.
                # The chained exception retains the SeleniumBase failure for debugging.
                raise primary from fallback_error
            raise RuntimeError(f"both browsers failed: Pydoll {type(primary).__name__}: {primary}; "
                               f"SeleniumBase {type(fallback_error).__name__}: {fallback_error}") from fallback_error


def render(url: str, *, wait_seconds: float = DEFAULT_WAIT_SECONDS, wait_selector: str = "", dismiss_cookies: bool = True,
           in_scope=None, steps: list[dict] | None = None, screenshot: bool = False, want: str = "dom",
           max_bytes: int = MAX_RESOURCE_BYTES) -> Rendered:
    """Load one URL in headless Chrome, using SeleniumBase CDP if Pydoll cannot deliver it.

    ``want="resource"`` returns the server's original response (including PDFs)
    when the browser clears the check; unresolved challenges remain fetch errors.
    """
    validate_public_http_url(url, resolve_dns=True)
    binary = browser_binary()
    if not binary:
        raise RuntimeError("Browser fetch needs Chrome or Chromium (set CHANGESENTINEL_CHROME)")
    if not available():
        raise RuntimeError("Browser fetch needs Pydoll or SeleniumBase CDP to be installed")
    wait = 0.0 if want == "resource" else max(0.0, min(float(wait_seconds), MAX_WAIT_SECONDS))
    with _LOCK:
        loop = asyncio.new_event_loop()
        try:
            step_wait = sum(float(step.get("seconds", 0)) for step in steps or []) + 12 * len(steps or [])
            timeout = RENDER_TIMEOUT_SECONDS + CHALLENGE_WAIT_SECONDS + wait + step_wait + 30
            # The fallback only starts after Pydoll reports a challenge. Reserve
            # a second bounded attempt without increasing normal successful scans.
            if _pydoll_available() and _seleniumbase_available():
                timeout *= 2
            return loop.run_until_complete(asyncio.wait_for(
                _render_with_fallback(
                    url, binary, want=want, wait_seconds=wait, wait_selector=wait_selector, dismiss=dismiss_cookies,
                    in_scope=in_scope, steps=steps, screenshot=screenshot, max_bytes=max_bytes,
                ),
                timeout=timeout,
            ))
        finally:
            loop.close()
