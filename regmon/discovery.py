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


def _checkpoint_path(source: SourceConfig, data_dir: Path) -> Path:
    return data_dir / "discovery" / f"{source.id}-checkpoint.json"


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temp.replace(path)


def _load_http_checkpoint(source: SourceConfig, data_dir: Path) -> dict | None:
    path = _checkpoint_path(source, data_dir)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if payload.get("source_id") != source.id or payload.get("state") != "PAUSED":
        return None
    if not isinstance(payload.get("pending"), list) or not isinstance(payload.get("discovered"), list):
        return None
    return payload


def _remove_http_checkpoint(source: SourceConfig, data_dir: Path) -> None:
    _checkpoint_path(source, data_dir).unlink(missing_ok=True)


def _write_http_metadata(
    source: SourceConfig,
    data_dir: Path,
    *,
    state: str,
    discovered: int,
    processed: int,
    successful_pages: int,
    failed_pages: int,
    capped: bool,
    pending: int,
) -> None:
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(
        discovery_dir / f"{source.id}.json",
        {
            "source_id": source.id,
            "method": "http-resumable",
            "state": state,
            "discovered": discovered,
            "html_processed": processed,
            "successful_pages": successful_pages,
            "failed_pages": failed_pages,
            "capped": capped,
            "pending": pending,
        },
    )


def _write_http_checkpoint(
    source: SourceConfig,
    data_dir: Path,
    *,
    discovered: list[str],
    pending: deque[str],
    processed: set[str],
    errors: list[str],
    successful_pages: int,
    started_at: str,
) -> None:
    _atomic_write_json(
        _checkpoint_path(source, data_dir),
        {
            "schema_version": 1,
            "source_id": source.id,
            "state": "PAUSED",
            "started_at": started_at,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "discovered": discovered,
            "pending": list(pending),
            "processed": sorted(processed),
            "errors": errors[:250],
            "successful_pages": successful_pages,
        },
    )


def http_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Recursively discover same-host links, checkpointing before the job budget is exhausted."""
    worker_count = max(1, min(int(source.discovery_http_workers), 32))
    timeout = max(5, int(source.discovery_http_timeout_seconds))
    slice_seconds = max(0, int(source.discovery_slice_seconds))
    deadline = time.monotonic() + slice_seconds if slice_seconds else None
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    checkpoint = _load_http_checkpoint(source, data_dir)
    if checkpoint:
        discovered = list(dict.fromkeys(str(url) for url in checkpoint.get("discovered", [])))
        discovered_set = set(discovered)
        pending = deque(str(url) for url in checkpoint.get("pending", []))
        processed = set(str(url) for url in checkpoint.get("processed", []))
        queued = set(pending)
        errors = [str(error) for error in checkpoint.get("errors", [])]
        successful_pages = int(checkpoint.get("successful_pages", 0))
        started_at = str(checkpoint.get("started_at") or started_at)
        print(
            f"HTTP discovery resume: discovered={len(discovered)} "
            f"processed={len(processed)} pending={len(pending)}"
        )
    else:
        discovered = []
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

    while pending:
        if deadline is not None and time.monotonic() >= deadline:
            _write_http_checkpoint(
                source, data_dir,
                discovered=discovered,
                pending=pending,
                processed=processed,
                errors=errors,
                successful_pages=successful_pages,
                started_at=started_at,
            )
            _write_http_metadata(
                source, data_dir,
                state="PAUSED", discovered=len(discovered), processed=len(processed),
                successful_pages=successful_pages, failed_pages=len(errors),
                capped=False, pending=len(pending),
            )
            print(f"HTTP discovery paused: pending={len(pending)} discovered={len(discovered)}")
            return discovered

        batch: list[str] = []
        while pending and len(batch) < worker_count:
            batch.append(pending.popleft())

        with ThreadPoolExecutor(max_workers=worker_count) as pool:
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

        capped = source.max_urls > 0 and len(discovered) >= source.max_urls
        if capped or not pending:
            state = "DEGRADED" if errors or capped else "COMPLETE"
            _remove_http_checkpoint(source, data_dir)
            _write_http_metadata(
                source, data_dir,
                state=state, discovered=len(discovered), processed=len(processed),
                successful_pages=successful_pages, failed_pages=len(errors),
                capped=capped, pending=len(pending),
            )
            if successful_pages == 0:
                return []
            return discovered

        if deadline is not None and time.monotonic() >= deadline:
            _write_http_checkpoint(
                source, data_dir,
                discovered=discovered,
                pending=pending,
                processed=processed,
                errors=errors,
                successful_pages=successful_pages,
                started_at=started_at,
            )
            _write_http_metadata(
                source, data_dir,
                state="PAUSED", discovered=len(discovered), processed=len(processed),
                successful_pages=successful_pages, failed_pages=len(errors),
                capped=False, pending=len(pending),
            )
            print(f"HTTP discovery paused: pending={len(pending)} discovered={len(discovered)}")
            return discovered

    _remove_http_checkpoint(source, data_dir)
    state = "DEGRADED" if errors else "COMPLETE"
    _write_http_metadata(
        source, data_dir,
        state=state, discovered=len(discovered), processed=len(processed),
        successful_pages=successful_pages, failed_pages=len(errors),
        capped=False, pending=0,
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


def _read_discovery_metadata(source_id: str, data_dir: Path) -> dict:
    path = data_dir / "discovery" / f"{source_id}.json"
    if not path.exists():
        return {"source_id": source_id, "state": "FAILED", "method": "unknown"}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"source_id": source_id, "state": "FAILED", "method": "unknown", "reason": str(exc)}


def _write_combined_discovery_metadata(
    source: SourceConfig,
    data_dir: Path,
    http_meta: dict,
    http_urls: list[str],
    stealth_urls: list[str],
) -> None:
    state = http_meta.get("state", "FAILED")
    if state == "COMPLETE":
        final_state = "COMPLETE"
    elif http_urls or stealth_urls:
        final_state = "DEGRADED"
    else:
        final_state = "FAILED"
    payload = {
        "source_id": source.id,
        "method": "http+stealth-enrichment",
        "state": final_state,
        "discovered": len(dict.fromkeys(http_urls + stealth_urls)),
        "http_discovered": len(http_urls),
        "stealth_discovered": len(stealth_urls),
        "http_state": http_meta.get("state"),
        "http_successful_pages": http_meta.get("successful_pages", 0),
        "http_failed_pages": http_meta.get("failed_pages", 0),
        "http_capped": http_meta.get("capped", False),
    }
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / f"{source.id}.json").write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Discover using HTTP first, enriching degraded crawls with the browser path."""
    http_urls: list[str] = []
    http_meta: dict = {"state": "FAILED", "method": "unknown"}

    if source.use_http_discovery:
        http_urls = http_discover(source, data_dir)
        http_meta = _read_discovery_metadata(source.id, data_dir)
        if http_meta.get("state") in {"COMPLETE", "PAUSED"}:
            return http_urls

    stealth_urls = _stealth_discover(source, data_dir)
    combined = list(dict.fromkeys(http_urls + stealth_urls))
    _write_combined_discovery_metadata(source, data_dir, http_meta, http_urls, stealth_urls)

    if combined:
        return combined

    raise RuntimeError(
        f"No in-scope URLs discovered for {source.id}; state was not updated."
    )
