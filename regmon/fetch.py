"""HTTP retrieval with retry/backoff and conditional requests."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import requests
from urllib.parse import urljoin, urlsplit

from regmon.discovery import canonical

from regmon.security import REDIRECT_STATUSES, validate_public_http_url

RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
MAX_REDIRECTS = 5


@dataclass(frozen=True)
class FetchResult:
    status_code: int
    content_type: str
    content_length: int | None
    etag: str | None
    last_modified: str | None
    raw_hash: str
    body: bytes
    not_modified: bool = False


def _content_length(headers: dict) -> int | None:
    value = headers.get("content-length", "")
    return int(value) if str(value).isdigit() else None


def fetch(
    url: str,
    timeout: int = 30,
    attempts: int = 3,
    backoff_seconds: float = 2,
    etag: str | None = None,
    last_modified: str | None = None,
    allowed_domains: tuple[str, ...] | list[str] | None = None,
    allowed_prefixes: tuple[str, ...] | list[str] | None = None,
    allowed_urls: tuple[str, ...] | list[str] | None = None,
) -> FetchResult:
    last_error = None
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; ChangeSentinel/0.3; "
            "+https://github.com/GauravDarwesh/ChangeSentinel)"
        ),
    }
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    scoped_domains = {
        (urlsplit(f"//{value}").hostname or str(value)).rstrip(".").lower()
        for value in (allowed_domains or [])
    }
    scoped_prefixes = tuple(str(value) for value in (allowed_prefixes or []))
    scoped_urls = {canonical(str(value)) for value in (allowed_urls or [])}

    def enforce_scope(target: str) -> None:
        parsed_target = urlsplit(target)
        if scoped_domains and str(parsed_target.hostname or "").lower() not in scoped_domains:
            raise ValueError(f"Fetch redirect target is outside allowed domains: {target}")
        normalized_target = canonical(target)
        if scoped_prefixes and not any(normalized_target.startswith(prefix) for prefix in scoped_prefixes):
            raise ValueError(f"Fetch redirect target is outside allowed URL prefixes: {target}")
        if scoped_urls and normalized_target not in scoped_urls:
            raise ValueError(f"Fetch redirect target is outside the exact URL allowlist: {target}")

    enforce_scope(url)
    validate_public_http_url(url, resolve_dns=True)
    for attempt in range(1, attempts + 1):
        try:
            current_url = url
            request_headers = dict(headers)
            visited = {current_url}
            response = None
            for redirect_count in range(MAX_REDIRECTS + 1):
                response = requests.get(
                    current_url,
                    timeout=timeout,
                    headers=request_headers,
                    allow_redirects=False,
                )
                if response.status_code not in REDIRECT_STATUSES:
                    break
                location = response.headers.get("location")
                if not location:
                    raise ValueError(f"Redirect from {current_url} did not include a Location header")
                target = urljoin(current_url, location)
                enforce_scope(target)
                validate_public_http_url(target, resolve_dns=True)
                if target in visited:
                    raise ValueError(f"Redirect loop detected at {target}")
                if redirect_count >= MAX_REDIRECTS:
                    raise ValueError(f"Exceeded {MAX_REDIRECTS} redirects for {url}")
                visited.add(target)
                current_url = target
                # Validators apply to the original response, not an unrelated redirect.
                request_headers = {"User-Agent": headers["User-Agent"]}
        except ValueError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                raise
            time.sleep(backoff_seconds * attempt)
            continue

        if response is None:
            raise RuntimeError(f"No response received for {url}")
        if response.status_code == 304:
            return FetchResult(
                status_code=304,
                content_type=response.headers.get("content-type", ""),
                content_length=None,
                etag=response.headers.get("etag") or etag,
                last_modified=response.headers.get("last-modified") or last_modified,
                raw_hash="",
                body=b"",
                not_modified=True,
            )

        if response.status_code >= 400:
            exc = requests.HTTPError(f"HTTP {response.status_code} for {current_url}")
            last_error = exc
            if response.status_code not in RETRYABLE or attempt == attempts:
                raise exc
            time.sleep(backoff_seconds * attempt)
            continue

        return FetchResult(
            status_code=response.status_code,
            content_type=response.headers.get("content-type", ""),
            content_length=_content_length(response.headers),
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
            raw_hash=hashlib.sha256(response.content).hexdigest(),
            body=response.content,
            not_modified=False,
        )

    raise last_error or RuntimeError("fetch failed")
