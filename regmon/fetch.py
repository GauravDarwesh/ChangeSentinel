"""HTTP retrieval with retry/backoff and conditional requests."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import requests
from urllib.parse import urljoin, urlsplit

from regmon.discovery import canonical

from regmon.security import REDIRECT_STATUSES, USER_AGENT, DNSResolutionError, retry_delay, validate_public_http_url

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
    max_bytes: int | None = None,
) -> FetchResult:
    last_error = None
    headers = {"User-Agent": USER_AGENT}
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
    excluded_paths = tuple(
        (urlsplit(str(value)).path.rstrip("/") or "/") for value in (excluded_prefixes or [])
    )

    def enforce_scope(target: str) -> None:
        parsed_target = urlsplit(target)
        if scoped_domains and str(parsed_target.hostname or "").lower() not in scoped_domains:
            raise ValueError(f"Fetch redirect target is outside allowed domains: {target}")
        normalized_target = canonical(target)
        if (scoped_prefixes or scoped_resource_prefixes) and not any(
            normalized_target.startswith(prefix)
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
            visited = {current_url}
            response = None
            for redirect_count in range(MAX_REDIRECTS + 1):
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
                if target in visited:
                    raise ValueError(f"Redirect loop detected at {target}")
                if redirect_count >= MAX_REDIRECTS:
                    raise ValueError(f"Exceeded {MAX_REDIRECTS} redirects for {url}")
                visited.add(target)
                current_url = target
                # Validators apply to the original response, not an unrelated redirect.
                request_headers = {"User-Agent": headers["User-Agent"]}
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
            response.close()
            exc = requests.HTTPError(f"HTTP {response.status_code} for {current_url}")
            last_error = exc
            if response.status_code not in RETRYABLE or attempt == attempts:
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
        )

    raise last_error or RuntimeError("fetch failed")
