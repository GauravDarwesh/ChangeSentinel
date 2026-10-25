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


def detect(body: bytes | str | None, status: int | None = None) -> str | None:
    """The challenge vendor when ``body`` is a bot-check page, else None."""
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
