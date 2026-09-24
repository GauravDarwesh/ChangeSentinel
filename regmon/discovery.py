"""URL discovery, canonicalization, and resilient crawling."""

from __future__ import annotations

import json
import re
import subprocess
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

from regmon.config import SourceConfig

TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}
NON_HTML_SUFFIXES = {
    ".7z", ".avi", ".bin", ".css", ".doc", ".docx", ".gif", ".gz", ".ico",
    ".jpeg", ".jpg", ".js", ".m3u8", ".mov", ".mp3", ".mp4", ".mpeg",
    ".png", ".ppt", ".pptx", ".rar", ".svg", ".tar", ".tgz", ".ttf",
    ".wav", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xlsx",
    ".xml", ".zip", ".pdf",
}
URL_RE = re.compile(r"https?://[^\\s<>\"']+", re.IGNORECASE)
DISCOVERY_RETRYABLE = {408, 425, 429, 500, 502, 503, 504}


def canonical(url: str) -> str:
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
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        path,
        "",
        urlencode(sorted(params), doseq=True),
        "",
    ))


def in_scope(url: str, source: SourceConfig) -> bool:
    value = canonical(url)
    parsed = urlparse(value)
    host = parsed.netloc.lower()
    if host not in source.allowed_domains:
        return False
    if not any(value.startswith(prefix) for prefix in source.allowed_prefixes):
        return False

    value_path = parsed.path.rstrip("/") or "/"
    for prefix in source.excluded_prefixes:
        excluded_path = urlparse(prefix).path.rstrip("/") or "/"
        if value_path == excluded_path or value_path.startswith(excluded_path + "/"):
            return False
    return True


def parse_discovered_urls(output: str, source: SourceConfig) -> list[str]:
    """Extract URLs even when the crawler surrounds output with progress diagnostics."""
    urls, seen = [], set()
    for line in output.splitlines():
        candidates = []
        value = line.strip()
        if value.startswith(("http://", "https://")):
            candidates.append(value)
        else:
            candidates.extend(URL_RE.findall(value))

        for candidate in candidates:
            candidate = candidate.rstrip(".,;:)]}>\\\"'")
            if "…" in candidate or "..." in candidate:
                continue
            normalized = canonical(candidate)
            if in_scope(normalized, source) and normalized not in seen:
                seen.add(normalized)
                urls.append(normalized)
            if source.max_urls > 0 and len(urls) >= source.max_urls:
                return urls
    return urls


def extract_html_links(page_url: str, html: str, source: SourceConfig) -> list[str]:
    """Extract both relative and absolute HTTP(S) links from an HTML document."""
    soup = BeautifulSoup(html, "html.parser")
    links, seen = [], set()
    for tag in soup.find_all("a", href=True):
        href = str(tag.get("href") or "").strip()
        if not href:
            continue
        absolute = urljoin(page_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            continue
        normalized = canonical(absolute)
        if in_scope(normalized, source) and normalized not in seen:
            seen.add(normalized)
            links.append(normalized)
    return links


def _is_probably_html_url(url: str) -> bool:
    suffix = Path(urlparse(url).path.lower()).suffix
    return suffix not in NON_HTML_SUFFIXES


def _fetch_links(url: str, source: SourceConfig, timeout: int) -> tuple[str, list[str], str | None]:
    last_error: str | None = None
    for attempt in range(1, source.discovery_http_attempts + 1):
        try:
            response = requests.get(
                url,
                timeout=timeout,
                allow_redirects=True,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; ChangeSentinel/0.3; "
                        "+https://github.com/GauravDarwesh/ChangeSentinel)"
                    )
                },
            )
            content_type = (response.headers.get("content-type") or "").lower()
            if response.status_code in {404, 410}:
                return url, [], None
            if response.status_code >= 400:
                last_error = f"HTTP {response.status_code}"
                if response.status_code not in DISCOVERY_RETRYABLE or attempt == source.discovery_http_attempts:
                    return url, [], last_error
                time.sleep(2 * attempt)
                continue
            if not ("html" in content_type or _is_probably_html_url(url)):
                return url, [], None
            return url, extract_html_links(response.url or url, response.text, source), None
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < source.discovery_http_attempts:
                time.sleep(2 * attempt)
                continue
            return url, [], last_error
    return url, [], last_error or "unknown discovery error"


def http_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Recursively discover same-host links using direct HTTP as the reliable path."""
    worker_count = max(1, min(int(source.discovery_http_workers), 32))
    timeout = max(5, int(source.discovery_http_timeout_seconds))

    discovered: list[str] = []
    discovered_set: set[str] = set()
    queued: set[str] = set()
    processed: set[str] = set()
    pending: deque[str] = deque()
    errors: list[str] = []
    successful_pages = 0

    for seed in source.seed_urls:
        value = canonical(seed)
        if not in_scope(value, source) or value in discovered_set:
            continue
        discovered_set.add(value)
        discovered.append(value)
        if _is_probably_html_url(value):
            pending.append(value)
            queued.add(value)

    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        while pending:
            batch: list[str] = []
            while pending and len(batch) < worker_count:
                batch.append(pending.popleft())

            futures = {
                pool.submit(_fetch_links, url, source, timeout): url
                for url in batch
            }
            batch_links: set[str] = set()
            for future in as_completed(futures):
                url = futures[future]
                processed.add(url)
                try:
                    _, links, error = future.result()
                except Exception as exc:
                    links, error = [], f"{type(exc).__name__}: {exc}"

                if error:
                    errors.append(f"{url}\t{error}")
                else:
                    successful_pages += 1
                batch_links.update(links)

            for link in sorted(batch_links):
                if source.max_urls > 0 and len(discovered) >= source.max_urls:
                    break
                if link not in discovered_set:
                    discovered_set.add(link)
                    discovered.append(link)
                if (
                    link not in processed
                    and link not in queued
                    and _is_probably_html_url(link)
                ):
                    pending.append(link)
                    queued.add(link)

            print(
                f"HTTP discovery: processed={len(processed)} "
                f"successful={successful_pages} discovered={len(discovered)} "
                f"pending={len(pending)}"
            )

            if source.max_urls > 0 and len(discovered) >= source.max_urls:
                break

    state = "FAILED"
    if successful_pages > 0:
        state = "DEGRADED" if errors else "COMPLETE"

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "http-discovery-output.txt").write_text(
        "\n".join([
            f"SOURCE={source.id}",
            f"DISCOVERED={len(discovered)}",
            f"HTML_PROCESSED={len(processed)}",
            f"SUCCESSFUL_PAGES={successful_pages}",
            f"ERRORS={len(errors)}",
            f"STATE={state}",
            *errors[:250],
        ]),
        encoding="utf-8",
    )
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / f"{source.id}.json").write_text(
        json.dumps({
            "source_id": source.id,
            "method": "http",
            "state": state,
            "discovered": len(discovered),
            "successful_pages": successful_pages,
            "failed_pages": len(errors),
        }, indent=2),
        encoding="utf-8",
    )
    if successful_pages == 0:
        return []
    return discovered


def _stealth_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Run stealth-crawler as an optional browser fallback/enrichment path."""
    attempts_log, discovered, seen = [], [], set()

    for seed in source.seed_urls:
        cmd = [
            source.crawler,
            "crawl",
            seed,
            "--base",
            source.allowed_prefixes[0],
            "--urls-only",
        ]
        if source.excluded_prefixes:
            cmd.extend([
                "--exclude",
                ",".join(
                    canonical(prefix).rstrip("/")
                    for prefix in source.excluded_prefixes
                ),
            ])

        seed_urls = []
        for attempt in range(1, source.discovery_attempts + 1):
            try:
                result = subprocess.run(
                    cmd,
                    text=True,
                    capture_output=True,
                    check=False,
                    timeout=source.discovery_timeout_seconds,
                )
                stdout, stderr = result.stdout or "", result.stderr or ""
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"EXIT_CODE={result.returncode}",
                    "STDOUT:",
                    stdout,
                    "STDERR:",
                    stderr,
                ]))
                seed_urls = parse_discovered_urls(stdout + "\n" + stderr, source)
                if seed_urls:
                    break
            except subprocess.TimeoutExpired as exc:
                out, err = exc.stdout or "", exc.stderr or ""
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"TIMEOUT_AFTER_SECONDS={source.discovery_timeout_seconds}",
                    "STDOUT:",
                    out if isinstance(out, str) else out.decode("utf-8", "replace"),
                    "STDERR:",
                    err if isinstance(err, str) else err.decode("utf-8", "replace"),
                ]))
            if attempt < source.discovery_attempts and not seed_urls:
                time.sleep(source.discovery_retry_delay_seconds)

        for url in seed_urls:
            if url not in seen:
                seen.add(url)
                discovered.append(url)
                if source.max_urls > 0 and len(discovered) >= source.max_urls:
                    break
        if source.max_urls > 0 and len(discovered) >= source.max_urls:
            break

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "stealth-output.txt").write_text(
        "\n\n".join(attempts_log),
        encoding="utf-8",
    )
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / f"{source.id}.json").write_text(
        json.dumps({
            "source_id": source.id,
            "method": "stealth-fallback",
            "state": "DEGRADED" if discovered else "FAILED",
            "discovered": len(discovered),
            "successful_pages": len(discovered),
            "failed_pages": 0 if discovered else 1,
        }, indent=2),
        encoding="utf-8",
    )
    return discovered


def discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Discover a source safely without allowing browser failures to block monitoring."""
    if source.use_http_discovery:
        discovered = http_discover(source, data_dir)
        if discovered:
            return discovered

    discovered = _stealth_discover(source, data_dir)
    if discovered:
        return discovered

    raise RuntimeError(
        f"No in-scope URLs discovered for {source.id}; state was not updated."
    )
