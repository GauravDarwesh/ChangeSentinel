"""URL identity helpers for Scout (standard library only)."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlparse, urlunparse

# Must match regmon.discovery.canonical so a Scout candidate and a monitored
# inventory row for the same address compare equal. A test pins the equivalence.
TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}

ASSET_SUFFIXES = (
    ".css", ".js", ".mjs", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".webm", ".avi",
)
FORMAT_SUFFIXES = {
    ".pdf": "PDF", ".xlsx": "Spreadsheet", ".xls": "Spreadsheet", ".xlsm": "Spreadsheet", ".csv": "CSV",
    ".docx": "Word", ".doc": "Word", ".pptx": "Slides", ".ppt": "Slides", ".zip": "ZIP",
    ".xml": "XML", ".xsd": "XML", ".json": "JSON", ".txt": "Text", ".xbrl": "XBRL",
}


def canonical(url: str, https_hosts: frozenset[str] | set[str] = frozenset()) -> str:
    """Canonicalize like the monitor; optionally upgrade http to https for declared hosts.

    The upgrade is applied only for hosts a regulator profile explicitly marks
    as serving every page over HTTPS. It is a configured assertion, not a guess.
    """
    url = str(url).split("#", 1)[0].strip()
    parsed = urlparse(url)
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    params = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key.lower().startswith("utm_") or key.lower() in TRACKING_PARAMS:
            continue
        params.append((key, value))
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    if scheme == "http" and (parsed.hostname or "").lower() in https_hosts:
        scheme = "https"
        if netloc.endswith(":80"):
            netloc = netloc[:-3]
    return urlunparse((scheme, netloc, path, "", urlencode(sorted(params), doseq=True), ""))


def absolute(base: str, href: str) -> str | None:
    href = str(href or "").strip()
    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
        return None
    value = urljoin(base, href)
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    return value


def host(url: str) -> str:
    return (urlparse(url).hostname or "").rstrip(".").lower()


def path_and_query(url: str) -> str:
    parsed = urlparse(url)
    return (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")


def candidate_id(url: str) -> str:
    """Stable 16-hex identifier for a canonical URL."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def is_asset(url: str) -> bool:
    return urlparse(url).path.lower().endswith(ASSET_SUFFIXES)


def file_format(url: str, hint: str = "") -> str:
    """Best-effort resource format from the URL, or a link label such as "(PDF)"."""
    path = urlparse(url).path.lower()
    for suffix, label in FORMAT_SUFFIXES.items():
        if path.endswith(suffix):
            return label
    text = str(hint or "").lower()
    for token, label in (("pdf", "PDF"), ("xlsx", "Spreadsheet"), ("excel", "Spreadsheet"), ("zip", "ZIP"), ("docx", "Word")):
        if re.search(r"[\(\[\s]" + token + r"\b", text):
            return label
    return "Web page"


def slug_text(url: str) -> str:
    """Readable words from the last meaningful path segment ("" if none)."""
    parsed = urlparse(url)
    segments = [segment for segment in parsed.path.split("/") if segment]
    while segments:
        segment = unquote(segments.pop())
        segment = re.sub(r"\.[a-z0-9]{2,5}$", "", segment, flags=re.IGNORECASE)
        words = re.sub(r"[-_+.]+", " ", segment).strip()
        # Skip numeric ids and opaque tokens (uuids, hashes) in favour of a parent segment.
        if not words or re.fullmatch(r"[\d\s]+", words) or re.fullmatch(r"[0-9a-f]{8,}( [0-9a-f]{4,})*", words, re.IGNORECASE):
            continue
        return words
    return ""


def slug_title(url: str) -> str:
    words = slug_text(url)
    if not words:
        return host(url)
    return words[:1].upper() + words[1:]
