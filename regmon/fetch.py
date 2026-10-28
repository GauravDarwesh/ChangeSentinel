"""HTTP retrieval with retry/backoff and conditional requests."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import requests
from urllib.parse import urljoin, urlsplit, urlunsplit

from regmon.discovery import canonical, without_dot_segments

from regmon.safe_http import public_destinations_only
from regmon import botcheck
from regmon.security import BROWSER_HEADERS, REDIRECT_STATUSES, USER_AGENT, DNSResolutionError, retry_delay, validate_public_http_url

RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
MAX_REDIRECTS = 5
# Challenge pages (Cloudflare, Akamai, captcha walls) usually arrive as 403/429/503;
# AWS WAF's CAPTCHA as 405, and some firewalls refuse with 406. Their body is
# kept, capped, so the engine can recognise and save them.
CHALLENGE_STATUSES = {401, 403, 405, 406, 429, 503}
MAX_ERROR_BODY_BYTES = 2 * 1024 * 1024


class HTTPStatusError(requests.HTTPError):
    """An HTTP error status, with the response body when it may be a challenge page."""

    def __init__(self, message: str, status_code: int, content_type: str = "", body: bytes = b"", headers: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.content_type = content_type
        self.body = body
        self.headers = dict(headers or {})


def _redirect_key(url: str) -> str:
    """Identify HTTP redirect loops while preserving trailing-slash variants."""
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))


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
    # A challenge announced only in the headers (AWS WAF answers 202 with one).
    challenge: str = ""


def _content_length(headers: dict) -> int | None:
    value = headers.get("content-length", "")
    return int(value) if str(value).isdigit() else None


def _read_body(response, max_bytes: int | None, url: str) -> bytes:
    """Read the response body, stopping as soon as it exceeds max_bytes.

    A Content-Length check alone does not bound memory: servers may omit or
    understate it, and compressed bodies expand on decoding. Streaming caps
    the decoded size actually held in memory.
    """
    if not max_bytes:
        return response.content
    chunks, total = [], 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            response.close()
            raise ValueError(f"Response for {url} exceeded {max_bytes} bytes; limit is {max_bytes}")
        chunks.append(chunk)
    return b"".join(chunks)


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
    allowed_resource_prefixes: tuple[str, ...] | list[str] | None = None,
    excluded_prefixes: tuple[str, ...] | list[str] | None = None,
    excluded_urls: tuple[str, ...] | list[str] | None = None,
    max_bytes: int | None = None,
    browser_headers: bool = False,
) -> FetchResult:
    last_error = None
    headers = dict(BROWSER_HEADERS) if browser_headers else {"User-Agent": USER_AGENT}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    scoped_domains = {
        (urlsplit(f"//{value}").hostname or str(value)).rstrip(".").lower()
        for value in (allowed_domains or [])
    }
    scoped_prefixes = tuple(str(value) for value in (allowed_prefixes or []))
    scoped_resource_prefixes = tuple(str(value) for value in (allowed_resource_prefixes or []))
    scoped_urls = {canonical(str(value)) for value in (allowed_urls or [])}
    excluded_exact_urls = {canonical(str(value)) for value in (excluded_urls or [])}
    excluded_paths = tuple(
        (urlsplit(str(value)).path.rstrip("/") or "/") for value in (excluded_prefixes or [])
    )

    def enforce_scope(target: str) -> None:
        parsed_target = urlsplit(target)
        if scoped_domains and str(parsed_target.hostname or "").lower() not in scoped_domains:
            raise ValueError(f"Fetch redirect target is outside allowed domains: {target}")
        normalized_target = canonical(target)
        if normalized_target in excluded_exact_urls:
            raise ValueError(f"Fetch target is explicitly excluded from this monitor: {target}")
        resolved_target = without_dot_segments(normalized_target)
        if (scoped_prefixes or scoped_resource_prefixes) and not any(
            normalized_target.startswith(prefix) and resolved_target.startswith(prefix)
            for prefix in (*scoped_prefixes, *scoped_resource_prefixes)
        ):
            raise ValueError(f"Fetch redirect target is outside allowed URL prefixes: {target}")
        resource_target = any(normalized_target.startswith(prefix) for prefix in scoped_resource_prefixes)
        if scoped_urls and normalized_target not in scoped_urls and not resource_target:
            raise ValueError(f"Fetch redirect target is outside the exact URL allowlist: {target}")
        # Same exclusion rule as discovery.in_scope: a redirect into an excluded
        # area (for example a login page) must not be fetched and compared.
        target_path = urlsplit(normalized_target).path.rstrip("/") or "/"
        for excluded in excluded_paths:
            if target_path == excluded or target_path.startswith(excluded.rstrip("/") + "/"):
                raise ValueError(f"Fetch redirect target is in an excluded area: {target}")

    enforce_scope(url)
    for attempt in range(1, attempts + 1):
        try:
            # Resolve inside the retry loop: a transient resolver failure used to
            # fail the fetch immediately with no retry.
            validate_public_http_url(url, resolve_dns=True)
            current_url = url
            request_headers = dict(headers)
            visited = {_redirect_key(current_url)}
            response = None
            for redirect_count in range(MAX_REDIRECTS + 1):
                # The connection itself refuses non-public addresses, closing the
                # gap between the DNS preflight above and the socket (rebinding).
                with public_destinations_only():
                    response = requests.get(
                        current_url,
                        timeout=timeout,
                        headers=request_headers,
                        allow_redirects=False,
                        # Stream when a size cap applies so the body can be cut off.
                        stream=bool(max_bytes),
                    )
                if response.status_code not in REDIRECT_STATUSES:
                    break
                response.close()
                location = response.headers.get("location")
                if not location:
                    raise ValueError(f"Redirect from {current_url} did not include a Location header")
                target = urljoin(current_url, location)
                enforce_scope(target)
                validate_public_http_url(target, resolve_dns=True)
                target_key = _redirect_key(target)
                if target_key in visited:
                    raise ValueError(f"Redirect loop detected at {target}")
                if redirect_count >= MAX_REDIRECTS:
                    raise ValueError(f"Exceeded {MAX_REDIRECTS} redirects for {url}")
                visited.add(target_key)
                current_url = target
                # Validators apply to the original response, not an unrelated redirect.
                request_headers = {key: value for key, value in headers.items() if key not in {"If-None-Match", "If-Modified-Since"}}
        except DNSResolutionError as exc:
            last_error = exc
            if attempt == attempts:
                raise
            time.sleep(backoff_seconds * attempt)
            continue
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
            # A streamed response holds its connection until closed.
            response.close()
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
            body = b""
            response_headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
            announced = botcheck.detect_headers(response_headers, response.status_code)
            content_type = response.headers.get("content-type", "").lower()
            if response.status_code in CHALLENGE_STATUSES and ("html" in content_type or not content_type or announced):
                try:
                    body = _read_body(response, MAX_ERROR_BODY_BYTES, current_url)
                except Exception:
                    body = b""
            response.close()
            exc = HTTPStatusError(f"HTTP {response.status_code} for {current_url}", response.status_code,
                                  response.headers.get("content-type", ""), body, response_headers)
            last_error = exc
            # A challenge (Kasada answers 429) is not rate limiting: retrying it
            # only repeats the challenge, so it goes straight to the engine.
            if response.status_code not in RETRYABLE or attempt == attempts or announced:
                raise exc
            time.sleep(retry_delay(response, backoff_seconds * attempt))
            continue

        declared = _content_length(response.headers)
        if max_bytes and declared and declared > max_bytes:
            response.close()
            raise ValueError(f"Response for {current_url} declares {declared} bytes; limit is {max_bytes}")
        body = _read_body(response, max_bytes, current_url)
        return FetchResult(
            status_code=response.status_code,
            content_type=response.headers.get("content-type", ""),
            content_length=_content_length(response.headers),
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
            raw_hash=hashlib.sha256(body).hexdigest(),
            body=body,
            not_modified=False,
            challenge=botcheck.detect_headers({str(k).lower(): str(v) for k, v in response.headers.items()}, response.status_code) or "",
        )

    raise last_error or RuntimeError("fetch failed")
