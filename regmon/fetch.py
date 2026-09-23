"""HTTP retrieval with retry/backoff."""
from __future__ import annotations
import hashlib
import time
from dataclasses import dataclass
import requests

RETRYABLE = {408,425,429,500,502,503,504}

@dataclass(frozen=True)
class FetchResult:
    status_code: int
    content_type: str
    content_length: int | None
    etag: str | None
    last_modified: str | None
    raw_hash: str
    body: bytes

def fetch(url: str, timeout: int = 30, attempts: int = 3, backoff_seconds: float = 2) -> FetchResult:
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, timeout=timeout, headers={"User-Agent": "regulatory-monitoring-poc/2.0"})
            if response.status_code >= 400:
                exc = requests.HTTPError(f"HTTP {response.status_code} for {url}")
                last_error = exc
                if response.status_code not in RETRYABLE or attempt == attempts:
                    raise exc
            else:
                return FetchResult(
                    status_code=response.status_code,
                    content_type=response.headers.get("content-type", ""),
                    content_length=int(response.headers["content-length"]) if response.headers.get("content-length", "").isdigit() else None,
                    etag=response.headers.get("etag"),
                    last_modified=response.headers.get("last-modified"),
                    raw_hash=hashlib.sha256(response.content).hexdigest(),
                    body=response.content,
                )
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                raise
        time.sleep(backoff_seconds * attempt)
    raise last_error or RuntimeError("fetch failed")
