"""HTTP retrieval with retry/backoff and conditional requests."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import requests

RETRYABLE = {408, 425, 429, 500, 502, 503, 504}


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

    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(
                url,
                timeout=timeout,
                headers=headers,
            )
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                raise
            time.sleep(backoff_seconds * attempt)
            continue

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
            exc = requests.HTTPError(f"HTTP {response.status_code} for {url}")
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
