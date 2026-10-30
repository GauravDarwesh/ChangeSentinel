"""Recognise bot-check and challenge pages served instead of a regulator page.

A Cloudflare "Just a moment…" interstitial, an Akamai "Access Denied" page or
a captcha wall is not the page. Comparing it would report a change that never
happened and replace a good baseline with a challenge. The engine treats a
recognised challenge as a fetch problem instead: the last good copy stays the
baseline, the challenge HTML is saved for review, and a browser render can be
tried when the source allows it.

Detection is deliberately conservative. Vendors also inject their scripts into
ordinary pages (Cloudflare's challenge-platform beacon, reCAPTCHA in a contact
form), so a script marker alone only counts on a page with almost no text.
"""
from __future__ import annotations

import re

# (vendor, title pattern): a challenge page's title is decisive on its own.
TITLES = (
    ("Cloudflare", re.compile(r"^\s*(just a moment\.*|attention required!? \| cloudflare|please wait\.*|one more step|verifying you are human)\s*$", re.I)),
    ("Akamai", re.compile(r"^\s*access denied\s*$", re.I)),
    ("Sucuri", re.compile(r"sucuri website firewall", re.I)),
    ("Imperva", re.compile(r"^\s*(request rejected|incapsula)\b", re.I)),
    ("DataDome", re.compile(r"^\s*(datadome|blocked)\b", re.I)),
)
# (vendor, body marker): only decisive on a page with little visible text.
MARKERS = (
    ("Cloudflare", re.compile(r"cf-chl-|cf_chl_opt|/cdn-cgi/challenge-platform/h/|cf-browser-verification|cf-error-details", re.I)),
    ("Akamai", re.compile(r"errors\.edgesuite\.net|akamai reference", re.I)),
    ("Imperva", re.compile(r"incapsula incident id|_incapsula_resource", re.I)),
    ("PerimeterX", re.compile(r"px-captcha|_pxcaptcha|perimeterx", re.I)),
    ("DataDome", re.compile(r"captcha-delivery\.com|datadome", re.I)),
    # Vendor-specific names only: any site may serve its own /js/challenge.js,
    # and a short subscribe or contact page may embed a reCAPTCHA/hCaptcha
    # widget. A real captcha wall also says so ("verify you are human").
    ("AWS WAF", re.compile(r"awswafcookiedomainlist|aws-waf-token|awswaf", re.I)),
    # Kasada's challenge is a near-empty page that starts window.KPSDK and loads /…/ips.js.
    ("Kasada", re.compile(r"window\.KPSDK|KPSDK\.start|/ips\.js\?", re.I)),
    ("Akamai", re.compile(r"bm-verify|/_sec/cp_challenge|sec-if-cpt-container", re.I)),
    # Radware Bot Manager (ShieldSquare) usually redirects (REDIRECT_HOSTS), but
    # can serve its check in place. Protected pages carry its connector too
    # (ssConf("cu", "validate.perfdrive.com…")), hence markers-only.
    ("Radware", re.compile(r"validate\.perfdrive\.com|shieldsquare captcha|radware (bot manager )?captcha", re.I)),
    ("PerimeterX", re.compile(r"_pxAppId|press (&|&amp;|and) hold", re.I)),
    ("Captcha", re.compile(r"cf-turnstile|please (verify|confirm) you are (a )?human|enable javascript and cookies to continue", re.I)),
)
# Titles that ordinary pages also use ("Blocked Persons List", "Access Denied"
# from a plain 403) only count with that vendor's own marker in the page.
TITLE_NEEDS_MARKER = {"Akamai", "DataDome"}
MAX_TEXT_FOR_MARKERS = 1500
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_STRIP = re.compile(r"<(script|style|noscript|template)\b.*?</\1\s*>|<[^>]+>", re.I | re.S)


def visible_text_length(html: str) -> int:
    return len(" ".join(_STRIP.sub(" ", html).split()))


# Some vendors do not answer with a challenge page at all: they redirect the
# request to a check on their own host. Radware Bot Manager (ShieldSquare)
# sends a flagged request to validate.perfdrive.com, which Banco de la
# República uses. That host is never in a monitor's scope and is not followed;
# the redirect itself is the bot check. A host matches itself and its subdomains.
REDIRECT_HOSTS = (
    ("Radware", ("perfdrive.com",)),
)


def detect_redirect(location) -> str | None:
    """The vendor when a redirect ``Location`` points at a bot-check host, else None."""
    from urllib.parse import urlsplit

    try:
        host = (urlsplit(str(location or "")).hostname or "").rstrip(".").lower()
    except ValueError:
        return None
    if not host:
        return None
    for vendor, hosts in REDIRECT_HOSTS:
        if any(host == known or host.endswith("." + known) for known in hosts):
            return vendor
    return None


def detect_headers(headers, status: int | None = None) -> str | None:
    """The vendor when response headers announce a challenge (whatever the body says).

    Cloudflare marks challenge responses ``cf-mitigated: challenge``; AWS WAF
    sends ``x-amzn-waf-action: challenge`` (HTTP 202) or ``captcha`` (405);
    Kasada answers a bare 403/429 carrying ``x-kpsdk-*`` headers; Radware
    redirects (3xx) to its own check host (``REDIRECT_HOSTS``).
    """
    lowered = {str(key).lower(): str(value).lower() for key, value in dict(headers or {}).items()}
    if lowered.get("cf-mitigated") == "challenge":
        return "Cloudflare"
    if lowered.get("x-amzn-waf-action") in {"challenge", "captcha"}:
        return "AWS WAF"
    if status in {403, 429} and any(key.startswith("x-kpsdk-") for key in lowered):
        return "Kasada"
    if status == 403 and "x-datadome" in lowered:
        return "DataDome"
    if status is not None and 300 <= status < 400:
        return detect_redirect(lowered.get("location"))
    return None


def detect(body: bytes | str | None, status: int | None = None, headers=None) -> str | None:
    """The challenge vendor when the response is a bot-check page, else None."""
    from_headers = detect_headers(headers, status) if headers else None
    if from_headers:
        return from_headers
    if not body:
        return None
    html = body if isinstance(body, str) else body[:600_000].decode("utf-8", "replace")
    title_match = _TITLE.search(html[:20_000])
    title = " ".join((title_match.group(1) if title_match else "").split())
    markers = dict(MARKERS)
    for vendor, pattern in TITLES:
        if title and pattern.search(title):
            # "Access Denied" is also an honest 403 from many servers, and
            # "Blocked …" an ordinary title (sanctions lists); only the
            # vendor's own marker makes them a challenge.
            if vendor in TITLE_NEEDS_MARKER and not markers[vendor].search(html):
                continue
            return vendor
    if visible_text_length(html) > MAX_TEXT_FOR_MARKERS:
        return None
    for vendor, pattern in MARKERS:
        if pattern.search(html):
            return vendor
    return None


# ---- A site that keeps showing its check -------------------------------------
# The engine records such a URL as a fetch problem whose message starts with
# "BotCheckError" (regmon/engine.py), keeps the last good copy and retries every
# scan. A check the browser cannot pass usually clears on its own (another
# runner address, the site relaxing a rule), so for GRACE_HOURS it is shown as
# "retrying automatically" and nobody is alerted; after that it is a failure,
# alerted once per site rather than once per page (regmon/notify.py).
#
# A site that refuses automated requests outright (a bare HTTP 403, 406 or
# 429 with no challenge page) is handled the same way, recorded as
# "AccessRefusedError: HTTP 403 refusal …".
GRACE_HOURS = 24
_VENDOR_IN_MESSAGE = re.compile(r"^BotCheckError:\s*(.+?) bot check\b")
_STATUS_IN_REFUSAL = re.compile(r"^AccessRefusedError:\s*HTTP (\d{3})")
ERROR_PREFIXES = ("BotCheckError", "AccessRefusedError")


def is_error(message) -> bool:
    """Whether a recorded fetch error is a bot check or a refusal, not an outage."""
    return str(message or "").startswith(ERROR_PREFIXES)


def vendor_in(message) -> str:
    text = str(message or "")
    match = _VENDOR_IN_MESSAGE.match(text)
    if match:
        return match.group(1)
    refusal = _STATUS_IN_REFUSAL.match(text)
    return f"HTTP {refusal.group(1)}" if refusal else "bot"


def reason(message) -> str:
    """Plain words for what is blocking: "a Cloudflare bot check", "an HTTP 403 refusal"."""
    text = str(message or "")
    refusal = _STATUS_IN_REFUSAL.match(text)
    if refusal:
        return f"an HTTP {refusal.group(1)} refusal"
    return f"a {vendor_in(text)} bot check"


def within_grace(hours: float | None) -> bool:
    return hours is None or hours < GRACE_HOURS
