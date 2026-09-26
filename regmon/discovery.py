"""HTTP-first, resumable URL discovery."""
from __future__ import annotations

import hashlib
import json
import re
import signal
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
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
DISCOVERY_RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
INVENTORY_CHUNK_SIZE = 5000
CHECKPOINT_SCHEMA_VERSION = 2
_DISCOVERY_STOP_REQUESTED = False


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
    if parsed.netloc.lower() not in source.allowed_domains:
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
    urls, seen = [], set()
    for line in output.splitlines():
        candidates = []
        value = line.strip()
        if value.startswith(("http://", "https://")):
            candidates.append(value)
        else:
            candidates.extend(URL_RE.findall(value))
        for candidate in candidates:
            normalized = canonical(candidate.rstrip(".,;:)]}>\"'"))
            if "…" in normalized or "..." in normalized:
                continue
            if in_scope(normalized, source) and normalized not in seen:
                seen.add(normalized)
                urls.append(normalized)
            if source.max_urls > 0 and len(urls) >= source.max_urls:
                return urls
    return urls


def extract_html_links(page_url: str, html: str, source: SourceConfig) -> list[str]:
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
    return Path(urlparse(url).path.lower()).suffix not in NON_HTML_SUFFIXES


def _fetch_links(url: str, source: SourceConfig, timeout: int):
    last_error = None
    last_status = None
    attempts_used = 0
    for attempt in range(1, source.discovery_http_attempts + 1):
        attempts_used = attempt
        try:
            response = requests.get(
                url,
                timeout=timeout,
                allow_redirects=True,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; ChangeSentinel/0.4; "
                        "+https://github.com/GauravDarwesh/ChangeSentinel)"
                    )
                },
            )
            last_status = response.status_code
            content_type = (response.headers.get("content-type") or "").lower()
            if response.status_code in {404, 410}:
                return url, [], None
            if response.status_code >= 400:
                last_error = f"HTTP {response.status_code}"
                if response.status_code not in DISCOVERY_RETRYABLE or attempt == source.discovery_http_attempts:
                    break
                time.sleep(2 * attempt)
                continue
            if not ("html" in content_type or _is_probably_html_url(url)):
                return url, [], None
            return url, extract_html_links(response.url or url, response.text, source), None
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt == source.discovery_http_attempts:
                break
            time.sleep(2 * attempt)

    if last_status is not None and 400 <= last_status < 500 and last_status not in DISCOVERY_RETRYABLE:
        classification = "permanent_http"
    elif last_status in DISCOVERY_RETRYABLE or last_status is None:
        classification = "retryable_exhausted"
    else:
        classification = "transport_error"
    return url, [], {
        "url": url,
        "status_code": last_status,
        "attempts": attempts_used,
        "error": last_error or "unknown discovery error",
        "retry_classification": classification,
    }


def _checkpoint_path(source: SourceConfig, data_dir: Path) -> Path:
    return data_dir / "discovery" / f"{source.id}-checkpoint.json"


def _config_fingerprint(source: SourceConfig) -> str:
    payload = {
        "seed_urls": list(source.seed_urls),
        "allowed_prefixes": list(source.allowed_prefixes),
        "allowed_domains": list(source.allowed_domains),
        "excluded_prefixes": list(source.excluded_prefixes),
        "max_urls": source.max_urls,
    }
    material = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _inventory_prefix(source: SourceConfig) -> str:
    return f"{source.id}-inventory-"


def _inventory_paths(source: SourceConfig, data_dir: Path) -> list[Path]:
    return sorted((data_dir / "discovery").glob(f"{_inventory_prefix(source)}*.txt"))


def _reset_inventory(source: SourceConfig, data_dir: Path) -> None:
    for path in _inventory_paths(source, data_dir):
        path.unlink(missing_ok=True)


def _load_inventory(source: SourceConfig, data_dir: Path) -> list[str]:
    urls, seen = [], set()
    for path in _inventory_paths(source, data_dir):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for value in lines:
            value = value.strip()
            if value and value not in seen:
                seen.add(value)
                urls.append(value)
    return urls


def _append_inventory(source: SourceConfig, data_dir: Path, urls: list[str], existing_count: int) -> None:
    if not urls:
        return
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    chunk_index = existing_count // INVENTORY_CHUNK_SIZE
    offset = existing_count % INVENTORY_CHUNK_SIZE
    handle = None
    try:
        for url in urls:
            if offset >= INVENTORY_CHUNK_SIZE:
                if handle is not None:
                    handle.close()
                    handle = None
                chunk_index += 1
                offset = 0
            if handle is None:
                handle = (discovery_dir / f"{_inventory_prefix(source)}{chunk_index:04d}.txt").open("a", encoding="utf-8")
            handle.write(url + "\n")
            offset += 1
    finally:
        if handle is not None:
            handle.close()


def _failure_ledger_path(source: SourceConfig, data_dir: Path) -> Path:
    return data_dir / "discovery" / f"{source.id}-failures.jsonl"


def _reset_failure_ledger(source: SourceConfig, data_dir: Path) -> None:
    path = _failure_ledger_path(source, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def _record_failure(source: SourceConfig, data_dir: Path, failure: dict) -> None:
    path = _failure_ledger_path(source, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        record = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **failure}
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_latest_failure_records(source: SourceConfig, data_dir: Path) -> dict[str, dict]:
    path = _failure_ledger_path(source, data_dir)
    if not path.exists():
        return {}
    latest = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            url = str(record.get("url") or "").strip()
            if url:
                latest[url] = record
    except OSError:
        return {}
    return latest


def _retryable_failure_urls(source: SourceConfig, data_dir: Path) -> list[str]:
    latest = _load_latest_failure_records(source, data_dir)
    return sorted(
        url for url, record in latest.items()
        if not record.get("resolved")
        and int(record.get("retry_round", 0)) == 0
        and record.get("retry_classification") in {"retryable_exhausted", "transport_error"}
    )


def _record_retry_resolution(source: SourceConfig, data_dir: Path, url: str, status_code: int | None) -> None:
    _record_failure(
        source,
        data_dir,
        {
            "url": url,
            "status_code": status_code,
            "attempts": 1,
            "error": None,
            "retry_classification": "retry_resolved",
            "resolved": True,
        },
    )


def _unresolved_failure_count(source: SourceConfig, data_dir: Path) -> int:
    latest = _load_latest_failure_records(source, data_dir)
    return sum(1 for record in latest.values() if not record.get("resolved"))


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
    if not isinstance(payload.get("pending"), list):
        return None
    if "retry_pending" in payload and not isinstance(payload.get("retry_pending"), list):
        return None
    if payload.get("schema_version") == CHECKPOINT_SCHEMA_VERSION:
        if payload.get("config_fingerprint") != _config_fingerprint(source):
            path.unlink(missing_ok=True)
            return None
        return payload
    discovered = payload.get("discovered")
    if not isinstance(discovered, list):
        return None
    payload["_legacy_discovered"] = discovered
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
    _atomic_write_json(
        data_dir / "discovery" / f"{source.id}.json",
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
            "unresolved_failures": _unresolved_failure_count(source, data_dir),
            "checkpoint_schema_version": CHECKPOINT_SCHEMA_VERSION,
            "config_fingerprint": _config_fingerprint(source),
            "inventory": f"data/discovery/{_inventory_prefix(source)}*.txt",
            "failure_ledger": f"data/discovery/{source.id}-failures.jsonl",
        },
    )


def _write_http_checkpoint(
    source: SourceConfig,
    data_dir: Path,
    *,
    pending: deque[str],
    retry_pending: deque[str],
    discovered_count: int,
    processed_count: int,
    failed_pages: int,
    successful_pages: int,
    started_at: str,
) -> None:
    _atomic_write_json(
        _checkpoint_path(source, data_dir),
        {
            "schema_version": CHECKPOINT_SCHEMA_VERSION,
            "source_id": source.id,
            "state": "PAUSED",
            "config_fingerprint": _config_fingerprint(source),
            "started_at": started_at,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "discovered_count": discovered_count,
            "processed_count": processed_count,
            "pending": list(pending),
            "retry_pending": list(retry_pending),
            "failed_pages": failed_pages,
            "successful_pages": successful_pages,
            "inventory_glob": f"data/discovery/{_inventory_prefix(source)}*.txt",
            "failure_ledger": f"data/discovery/{source.id}-failures.jsonl",
        },
    )


def _set_signal_handlers():
    global _DISCOVERY_STOP_REQUESTED
    _DISCOVERY_STOP_REQUESTED = False
    previous = {}
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue

        def _handler(signum, _frame):
            global _DISCOVERY_STOP_REQUESTED
            _DISCOVERY_STOP_REQUESTED = True
            print(f"HTTP discovery received signal {signum}; checkpointing after the current batch")

        try:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, _handler)
        except ValueError:
            pass
    return previous


def _restore_signal_handlers(previous) -> None:
    for sig, handler in previous.items():
        try:
            signal.signal(sig, handler)
        except ValueError:
            pass


def http_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Recursively discover same-host links with durable, compact pause/resume state."""
    worker_count = max(1, min(int(source.discovery_http_workers), 32))
    timeout = max(5, int(source.discovery_http_timeout_seconds))
    slice_seconds = max(0, int(source.discovery_slice_seconds))
    grace_seconds = 60 if slice_seconds >= 120 else 0
    budget_seconds = max(1, slice_seconds - grace_seconds) if slice_seconds else 0
    deadline = time.monotonic() + budget_seconds if budget_seconds else None
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    previous_signals = _set_signal_handlers()

    try:
        checkpoint = _load_http_checkpoint(source, data_dir)
        if checkpoint:
            if "_legacy_discovered" in checkpoint:
                discovered = list(dict.fromkeys(str(x) for x in checkpoint["_legacy_discovered"]))
                _reset_inventory(source, data_dir)
                _append_inventory(source, data_dir, discovered, 0)
                pending = deque(str(x) for x in checkpoint.get("pending", []))
                retry_pending = deque(str(x) for x in checkpoint.get("retry_pending", []))
                processed_count = int(
                    checkpoint.get("processed_count", len(checkpoint.get("processed", [])))
                )
                failed_pages = int(checkpoint.get("failed_pages", 0))
                successful_pages = int(checkpoint.get("successful_pages", 0))
                started_at = str(checkpoint.get("started_at") or started_at)
                print(
                    f"HTTP discovery migrated legacy checkpoint: discovered={len(discovered)} "
                    f"processed={processed_count} pending={len(pending)}"
                )
            else:
                discovered = _load_inventory(source, data_dir)
                pending = deque(str(x) for x in checkpoint.get("pending", []))
                processed_count = int(checkpoint.get("processed_count", 0))
                failed_pages = int(checkpoint.get("failed_pages", 0))
                successful_pages = int(checkpoint.get("successful_pages", 0))
                started_at = str(checkpoint.get("started_at") or started_at)
                retry_pending = deque(str(x) for x in checkpoint.get("retry_pending", []))
                print(
                    f"HTTP discovery resume: discovered={len(discovered)} "
                    f"processed={processed_count} pending={len(pending)}"
                )
        else:
            _reset_inventory(source, data_dir)
            _reset_failure_ledger(source, data_dir)
            discovered, pending, retry_pending = [], deque(), deque()
            processed_count = 0
            failed_pages = successful_pages = 0
            for seed in source.seed_urls:
                value = canonical(seed)
                if not in_scope(value, source) or value in discovered:
                    continue
                discovered.append(value)
                if _is_probably_html_url(value):
                    pending.append(value)
            _append_inventory(source, data_dir, discovered, 0)

        discovered_set = set(discovered)
        queued = set(pending)

        while pending:
            if _DISCOVERY_STOP_REQUESTED or (deadline is not None and time.monotonic() >= deadline):
                _write_http_checkpoint(
                    source, data_dir, pending=pending, retry_pending=retry_pending, discovered_count=len(discovered),
                    processed_count=processed_count, failed_pages=failed_pages,
                    successful_pages=successful_pages, started_at=started_at,
                )
                _write_http_metadata(
                    source, data_dir, state="PAUSED", discovered=len(discovered),
                    processed=processed_count, successful_pages=successful_pages,
                    failed_pages=failed_pages, capped=False, pending=len(pending),
                )
                print(f"HTTP discovery paused: pending={len(pending)} discovered={len(discovered)}")
                return discovered

            batch = [pending.popleft() for _ in range(min(worker_count, len(pending)))]
            for url in batch:
                queued.discard(url)

            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                futures = {pool.submit(_fetch_links, url, source, timeout): url for url in batch}
                batch_links: set[str] = set()
                for future in as_completed(futures):
                    processed_count += 1
                    url = futures[future]
                    try:
                        _, links, failure = future.result()
                    except Exception as exc:
                        links, failure = [], {
                            "url": url,
                            "status_code": None,
                            "attempts": source.discovery_http_attempts,
                            "error": f"{type(exc).__name__}: {exc}",
                            "retry_classification": "transport_error",
                        }
                    if failure:
                        failed_pages += 1
                        _record_failure(source, data_dir, failure)
                    else:
                        successful_pages += 1
                    batch_links.update(links)

            new_links = []
            for link in sorted(batch_links):
                if source.max_urls > 0 and len(discovered) >= source.max_urls:
                    break
                if link not in discovered_set:
                    discovered_set.add(link)
                    discovered.append(link)
                    new_links.append(link)
                    if _is_probably_html_url(link):
                        pending.append(link)
                        queued.add(link)

            _append_inventory(source, data_dir, new_links, len(discovered) - len(new_links))
            print(
                f"HTTP discovery: processed={processed_count} successful={successful_pages} "
                f"discovered={len(discovered)} pending={len(pending)} failures={failed_pages}"
            )

            capped = source.max_urls > 0 and len(discovered) >= source.max_urls
            if capped:
                _remove_http_checkpoint(source, data_dir)
                _write_http_metadata(
                    source, data_dir, state="DEGRADED" if _unresolved_failure_count(source, data_dir) else "COMPLETE",
                    discovered=len(discovered), processed=processed_count,
                    successful_pages=successful_pages, failed_pages=failed_pages,
                    capped=True, pending=0,
                )
                return [] if successful_pages == 0 else discovered
            if not pending:
                break

            if _DISCOVERY_STOP_REQUESTED or (deadline is not None and time.monotonic() >= deadline):
                _write_http_checkpoint(
                    source, data_dir, pending=pending, retry_pending=retry_pending, discovered_count=len(discovered),
                    processed_count=processed_count, failed_pages=failed_pages,
                    successful_pages=successful_pages, started_at=started_at,
                )
                _write_http_metadata(
                    source, data_dir, state="PAUSED", discovered=len(discovered),
                    processed=processed_count, successful_pages=successful_pages,
                    failed_pages=failed_pages, capped=False, pending=len(pending),
                )
                print(f"HTTP discovery paused: pending={len(pending)} discovered={len(discovered)}")
                return discovered

        if not retry_pending:
            retry_pending = deque(_retryable_failure_urls(source, data_dir))

        while retry_pending:
            if _DISCOVERY_STOP_REQUESTED or (deadline is not None and time.monotonic() >= deadline):
                _write_http_checkpoint(
                    source, data_dir,
                    pending=deque(),
                    retry_pending=retry_pending,
                    discovered_count=len(discovered),
                    processed_count=processed_count,
                    failed_pages=failed_pages,
                    successful_pages=successful_pages,
                    started_at=started_at,
                )
                _write_http_metadata(
                    source, data_dir, state="PAUSED", discovered=len(discovered),
                    processed=processed_count, successful_pages=successful_pages,
                    failed_pages=failed_pages, capped=False, pending=0,
                )
                print(
                    f"HTTP discovery paused during failure retry: "
                    f"retry_pending={len(retry_pending)} discovered={len(discovered)}"
                )
                return discovered

            batch = [retry_pending.popleft() for _ in range(min(worker_count, len(retry_pending)))]
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                futures = {
                    pool.submit(_fetch_links, url, source, timeout): url
                    for url in batch
                }
                for future in as_completed(futures):
                    url = futures[future]
                    try:
                        _, links, failure = future.result()
                    except Exception as exc:
                        failure = {
                            "url": url,
                            "status_code": None,
                            "attempts": source.discovery_http_attempts,
                            "error": f"{type(exc).__name__}: {exc}",
                            "retry_classification": "transport_error",
                        }
                    if failure:
                        failed_pages += 1
                        _record_failure(
                            source,
                            data_dir,
                            {
                                **failure,
                                "retry_round": 1,
                            },
                        )
                    else:
                        successful_pages += 1
                        _record_retry_resolution(source, data_dir, url, 200)
                        # A recovered page may contain links that the failed first
                        # attempt never exposed. Keep those links in the same
                        # resumable work queue so recursive discovery remains complete.
                        links = links
                        new_links = []
                        for link in sorted(links):
                            if source.max_urls > 0 and len(discovered) >= source.max_urls:
                                break
                            if link not in discovered_set:
                                discovered_set.add(link)
                                discovered.append(link)
                                new_links.append(link)
                                if _is_probably_html_url(link):
                                    retry_pending.append(link)
                        _append_inventory(
                            source,
                            data_dir,
                            new_links,
                            len(discovered) - len(new_links),
                        )

            if _DISCOVERY_STOP_REQUESTED or (deadline is not None and time.monotonic() >= deadline):
                _write_http_checkpoint(
                    source, data_dir,
                    pending=deque(),
                    retry_pending=retry_pending,
                    discovered_count=len(discovered),
                    processed_count=processed_count,
                    failed_pages=failed_pages,
                    successful_pages=successful_pages,
                    started_at=started_at,
                )
                _write_http_metadata(
                    source, data_dir, state="PAUSED", discovered=len(discovered),
                    processed=processed_count, successful_pages=successful_pages,
                    failed_pages=failed_pages, capped=False, pending=0,
                )
                print(
                    f"HTTP discovery paused during failure retry: "
                    f"retry_pending={len(retry_pending)} discovered={len(discovered)}"
                )
                return discovered

        _remove_http_checkpoint(source, data_dir)
        unresolved_failures = _unresolved_failure_count(source, data_dir)
        state = "DEGRADED" if unresolved_failures else "COMPLETE"
        _write_http_metadata(
            source, data_dir, state=state, discovered=len(discovered),
            processed=processed_count, successful_pages=successful_pages,
            failed_pages=failed_pages, capped=False, pending=0,
        )
        return [] if successful_pages == 0 else discovered

    finally:
        _restore_signal_handlers(previous_signals)
def _read_discovery_metadata(source_id: str, data_dir: Path) -> dict:
    path = data_dir / "discovery" / f"{source_id}.json"
    if not path.exists():
        return {"source_id": source_id, "state": "FAILED", "method": "unknown"}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"source_id": source_id, "state": "FAILED", "method": "unknown", "reason": str(exc)}


def _stealth_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Compatibility hook for callers/tests; implementation lives in discovery_browser."""
    from regmon.discovery_browser import _stealth_discover as browser_discover
    return browser_discover(source, data_dir)


def discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Discover HTTP-first, preserving stealth fallback for degraded HTTP discovery."""
    http_urls = http_discover(source, data_dir) if source.use_http_discovery else []
    http_meta = _read_discovery_metadata(source.id, data_dir)
    if http_meta.get("state") in {"COMPLETE", "PAUSED"}:
        return http_urls

    from regmon.discovery_browser import write_combined_discovery_metadata
    stealth_urls = _stealth_discover(source, data_dir)
    combined = list(dict.fromkeys(http_urls + stealth_urls))
    write_combined_discovery_metadata(source, data_dir, http_meta, http_urls, stealth_urls)
    if combined:
        return combined
    raise RuntimeError(f"No in-scope URLs discovered for {source.id}; state was not updated.")
