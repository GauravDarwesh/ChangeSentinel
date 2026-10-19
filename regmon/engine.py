"""Scalable monitoring orchestration."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from regmon.ai import AIConfig, analyze
from regmon.change import (
    build_event_id,
    classify_change,
    error_signature,
    html_comparison_hash,
    make_diff,
    make_id,
    operational_notification_id,
    write_evidence,
)
from regmon.config import DEFAULT_CONFIG_PATH, SourceConfig, load_config
from regmon.content import CONTENT_EXTRACTOR_VERSION, extract_content
from regmon.discovery import canonical, discover
from regmon.fetch import fetch
from regmon.relevance import triage

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SNAPSHOTS = DATA / "snapshots"
HTML_SNAPSHOTS = SNAPSHOTS / "html"
HISTORY = DATA / "history"
REPORTS = DATA / "reports"
DISCOVERY = DATA / "discovery"
CONFIG_PAYLOAD = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
DEFAULTS = CONFIG_PAYLOAD.get("defaults", {})

def load_previous(source_id: str) -> dict[str, dict]:
    path = DATA / "latest.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") == 2 and isinstance(payload.get("sources"), dict):
        return payload["sources"].get(source_id, {})
    return payload if all(isinstance(v, dict) for v in payload.values()) else {}

def resolve_previous(url: str, previous: dict[str, dict]) -> tuple[str, dict | None]:
    """Resolve prior state by URL id, then by canonicalized URL for legacy/query-order compatibility."""
    uid = make_id(url)
    direct = previous.get(uid)
    if direct is not None:
        return uid, direct
    target = canonical(url)
    for previous_uid, record in previous.items():
        prior_url = record.get("canonical_url")
        if prior_url and canonical(prior_url) == target:
            return previous_uid, record
    return uid, None

def should_force_full_fetch(old: dict | None, now: str, interval_hours: float) -> bool:
    if not old or not old.get("last_full_fetch"):
        return True
    try:
        last_full = datetime.fromisoformat(str(old["last_full_fetch"]))
        current = datetime.fromisoformat(now)
        age_hours = (current - last_full).total_seconds() / 3600
    except (TypeError, ValueError):
        return True
    return age_hours >= max(0.0, interval_hours)


def is_current_extractor_version(version: object) -> bool:
    """Recognize stable variants of the current hybrid PDF extraction pipeline."""
    value = str(version or "")
    return (
        value in {CONTENT_EXTRACTOR_VERSION, CONTENT_EXTRACTOR_VERSION + "-fallback"}
        or value.startswith(CONTENT_EXTRACTOR_VERSION + "-zipprofile-")
    )


def source_unchanged(old: dict | None, current: dict) -> bool:
    """True when the fetched source is provably identical to the trusted baseline.

    Exact raw-byte equality is the strongest signal and covers PDFs/ZIPs. For
    HTML the response may carry rotating request metadata (Cloudflare challenge
    IDs/timestamps), so an unchanged comparison signature also counts. A baseline
    recorded during an extraction error is not comparable: its raw hash belongs
    to the failed response while its text belongs to an older one.
    """
    if not old or old.get("extraction_error") or not old.get("raw_hash"):
        return False
    if old.get("raw_hash") == current.get("raw_hash"):
        return True
    if (
        str(old.get("extraction_type") or "").lower() == "html"
        and str(current.get("extraction_type") or "").lower() == "html"
    ):
        old_signature = old.get("html_comparison_hash")
        current_signature = current.get("html_comparison_hash")
        return bool(old_signature and current_signature and old_signature == current_signature)
    return False


def should_rebaseline_extractor(old: dict | None, current: dict) -> bool:
    """Avoid treating extractor upgrades as content changes when source content is stable."""
    if not old or old.get("extractor_version") == current.get("extractor_version"):
        return False
    # Docling can be unavailable temporarily (for example, on a cold model cache).
    # Mark that parser profile explicitly so a same-bytes transition between
    # Docling and the deterministic PDF fallback is a baseline migration, not a
    # regulatory change. Never hide a source-byte change behind this rule.
    if not is_current_extractor_version(current.get("extractor_version")):
        return False
    return source_unchanged(old, current)


def is_extraction_drift(old: dict | None, current: dict) -> bool:
    """Same source, different extracted text, no extractor version change.

    Library upgrades, OCR engine builds and wall-clock-limited Docling runs can
    change extracted text for byte-identical sources. That is a parser event,
    not a regulatory change: 15 false CHANGED_URL alerts (18-19 Oct 2026) came
    from exactly this. It is recorded as a baseline migration with its reason.
    """
    if not old or not old.get("normalized_hash") or not current.get("normalized_hash"):
        return False
    if old["normalized_hash"] == current["normalized_hash"]:
        return False
    return source_unchanged(old, current)


def _write_evidence(*args, **kwargs) -> str:
    """Evidence diffs use the configured line budget (the same one the AI sees)."""
    return write_evidence(*args, max_diff_lines=int(DEFAULTS.get("max_diff_lines", 250)), **kwargs)


def read_snapshot(record: dict | None) -> str | None:
    if not record or not record.get("snapshot_location"):
        return None
    try:
        return (ROOT / record["snapshot_location"]).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def read_html_snapshot(record: dict | None) -> str | None:
    if not record or not record.get("html_snapshot_location"):
        return None
    try:
        return (ROOT / record["html_snapshot_location"]).read_bytes().decode("utf-8", "replace")
    except FileNotFoundError:
        return None


def load_discovery_metadata(source_id: str, data_dir: Path = DATA) -> dict[str, Any]:
    path = data_dir / "discovery" / f"{source_id}.json"
    if not path.exists():
        return {
            "source_id": source_id,
            "method": "unknown",
            "state": "FAILED",
            "reason": "discovery metadata missing",
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "source_id": source_id,
            "method": "unknown",
            "state": "FAILED",
            "reason": f"invalid discovery metadata: {exc}",
        }
    if payload.get("source_id") != source_id:
        payload["state"] = "FAILED"
        payload["reason"] = "discovery metadata source mismatch"
    return payload


def write_snapshot(uid: str, text: str, content_hash: str | None = None) -> str:
    """Persist an immutable normalized-text snapshot keyed by content hash."""
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    digest = content_hash or hashlib.sha256(text.encode("utf-8")).hexdigest()
    path = SNAPSHOTS / f"{uid}-{digest}.txt"
    if not path.exists():
        path.write_text(text, encoding="utf-8")
    return str(path.relative_to(ROOT))


def write_html_snapshot(uid: str, body: bytes, html_hash: str) -> str:
    """Persist the complete fetched HTML response body without replacing older versions."""
    HTML_SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = HTML_SNAPSHOTS / f"{uid}-{html_hash}.html"
    if not path.exists():
        path.write_bytes(body)
    return str(path.relative_to(ROOT))


def store_html_snapshot(uid: str, body: bytes, item: dict, old: dict | None) -> str:
    """Save the fetched HTML, reusing the previous file when only volatile tokens differ.

    Pages behind Cloudflare return different bytes on every request, so a new
    ~100 KB snapshot used to be committed per page per run. When the comparison
    signature is unchanged the previous snapshot is equivalent evidence; the
    record then points at it (and its hash) instead of adding a new file.
    """
    if (
        old
        and old.get("html_snapshot_location")
        and old.get("html_hash")
        and old.get("html_comparison_hash")
        and old.get("html_comparison_hash") == item.get("html_comparison_hash")
        and (ROOT / str(old["html_snapshot_location"])).is_file()
    ):
        item["html_hash"] = old["html_hash"]
        return str(old["html_snapshot_location"])
    return write_html_snapshot(uid, body, item["html_hash"])


def write_file_snapshot(uid: str, body: bytes, content_hash: str | None, extraction_type: str) -> str:
    """Persist original PDF/ZIP bytes so the dashboard can preview or download the exact file."""
    suffix = {"pdf": "pdf", "zip": "zip"}.get(str(extraction_type or "").lower())
    if suffix is None:
        raise ValueError(f"Unsupported original-file snapshot type: {extraction_type!r}")
    directory = SNAPSHOTS / "files"
    directory.mkdir(parents=True, exist_ok=True)
    digest = content_hash or hashlib.sha256(body).hexdigest()
    path = directory / f"{uid}-{digest}.{suffix}"
    if not path.exists():
        path.write_bytes(body)
    return str(path.relative_to(ROOT))

def base_item(url: str, old: dict | None, now: str, source: SourceConfig) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "url_id": make_id(url),
        "source_id": source.id,
        "regulator": source.regulator,
        "canonical_url": url,
        "first_seen": old.get("first_seen", now) if old else now,
        "last_seen": now,
        "last_checked": now,
        "last_full_fetch": old.get("last_full_fetch") if old else None,
        "active": True,
        "terminal_file": False,
        "http_status": None,
        "content_type": None,
        "content_length": None,
        "etag": None,
        "last_modified": None,
        "raw_hash": None,
        "normalized_hash": None,
        "html_hash": old.get("html_hash") if old else None,
        "html_comparison_hash": old.get("html_comparison_hash") if old else None,
        "html_snapshot_location": old.get("html_snapshot_location") if old else None,
        "file_snapshot_location": old.get("file_snapshot_location") if old else None,
        "extraction_type": None,
        "extractor_version": old.get("extractor_version") if old else None,
        "extraction_error": None,
        "fetch_error": None,
        "snapshot_location": old.get("snapshot_location") if old else None,
        "evidence_location": old.get("evidence_location") if old else None,
        "relevance": old.get("relevance") if old else None,
        # Keep deferred AI work in the durable URL inventory so a later scan can
        # resume it even when the source content itself no longer changes.
        "ai_pending": old.get("ai_pending") if old else None,
        "not_modified": False,
    }


def mark_error_episode(kind: str, item: dict, old: dict | None, now: str) -> str:
    """Track when an operational error began; return its notification identity.

    A persistent failure keeps the onset recorded by the first failing run, so
    the notifier alerts once per episode. A different failure class, or a
    failure after a successful run, starts a new episode.
    """
    message = item.get("fetch_error") if kind == "FETCH_ERROR" else item.get("extraction_error")
    signature = error_signature(kind, message)
    since = now
    if old and old.get("error_signature") == signature and old.get("error_since"):
        since = str(old["error_since"])
    item["error_signature"] = signature
    item["error_since"] = since
    return operational_notification_id(item["url_id"], signature, since)


def build_ai_candidate_pool(
    new_items: list[dict],
    changed_items: list[dict],
    unchanged_items: list[dict],
    *,
    initial_baseline: bool = False,
) -> list[dict]:
    """Select new/changed pages plus unchanged pages with deferred AI work."""
    if initial_baseline:
        return []
    candidates: dict[str, dict] = {}
    for item in new_items:
        candidates[item["url_id"]] = item
    for entry in changed_items:
        item = entry["after"]
        candidates[item["url_id"]] = item
    for item in unchanged_items:
        if item.get("ai_pending") and item["url_id"] not in candidates:
            candidates[item["url_id"]] = item
    eligible = [
        item for item in candidates.values()
        if item.get("relevance", {}).get("candidate", True)
    ]

    def scheduling_key(item: dict) -> tuple[int, str, str]:
        pending = item.get("ai_pending")
        if isinstance(pending, dict) and pending.get("after_hash") == item.get("normalized_hash"):
            # Resume oldest/least-recently-attempted backlog first. A stable URL
            # tie-breaker keeps the ordering deterministic without starving later work.
            last_attempt = str(
                pending.get("last_attempt_at")
                or pending.get("first_deferred_at")
                or pending.get("timestamp")
                or ""
            )
            return (0, last_attempt, item["url_id"])
        return (1, "", item["url_id"])

    return sorted(eligible, key=scheduling_key)


def candidate_event_type(item: dict, new_ids: set[str], changed_ids: set[str]) -> str:
    """Retain the original event type when retrying deferred work on unchanged content."""
    uid = item["url_id"]
    if uid in new_ids:
        return "NEW_URL"
    if uid in changed_ids:
        return "CHANGED_URL"
    pending = item.get("ai_pending")
    if isinstance(pending, dict) and pending.get("event_type") in {"NEW_URL", "CHANGED_URL"}:
        return pending["event_type"]
    return "CHANGED_URL"


def make_current_item(url: str, old: dict | None, source: SourceConfig, now: str):
    item = base_item(url, old, now, source)
    try:
        refresh_interval = float(DEFAULTS.get("conditional_refresh_interval_hours", 24))
        refresh_required = should_force_full_fetch(old, now, refresh_interval)
        html_baseline_missing = bool(
            old
            and "html" in str(old.get("content_type") or "").lower()
            and not old.get("html_snapshot_location")
        )
        old_type = str((old or {}).get("extraction_type") or "").lower()
        old_content_type = str((old or {}).get("content_type") or "").lower()
        file_baseline_missing = bool(
            old
            and (old_type in {"pdf", "zip"} or "pdf" in old_content_type or "zip" in old_content_type)
            and not old.get("file_snapshot_location")
        )
        extractor_baseline_missing = bool(
            old
            and old_type in {"html", "pdf", "zip"}
            and not is_current_extractor_version(old.get("extractor_version"))
        )
        # A record that failed extraction must be re-fetched and re-extracted on
        # every run: a 304 would otherwise report the unextractable response as
        # unchanged and hide the error until the next full refresh.
        error_retry_required = bool(old and old.get("extraction_error"))
        force_full_fetch = (
            refresh_required
            or html_baseline_missing
            or file_baseline_missing
            or extractor_baseline_missing
            or error_retry_required
        )
        item["full_fetch_forced"] = force_full_fetch
        item["html_baseline_forced"] = html_baseline_missing and not refresh_required
        item["file_baseline_forced"] = file_baseline_missing
        item["extractor_baseline_forced"] = extractor_baseline_missing
        result = fetch(
            url,
            timeout=int(DEFAULTS.get("fetch_timeout_seconds", 30)),
            attempts=int(DEFAULTS.get("fetch_attempts", 3)),
            backoff_seconds=float(DEFAULTS.get("fetch_backoff_seconds", 2)),
            etag=None if force_full_fetch else (old or {}).get("etag"),
            last_modified=None if force_full_fetch else (old or {}).get("last_modified"),
            allowed_domains=source.allowed_domains,
            allowed_prefixes=source.allowed_prefixes,
            allowed_urls=source.allowed_urls,
            allowed_resource_prefixes=source.allowed_resource_prefixes,
        )
        item.update({
            "http_status": result.status_code,
            "content_type": result.content_type,
            "content_length": result.content_length,
            "etag": result.etag,
            "last_modified": result.last_modified,
            "raw_hash": result.raw_hash or (old or {}).get("raw_hash"),
            "not_modified": result.not_modified,
        })
        if not result.not_modified:
            item["last_full_fetch"] = now
        if result.not_modified:
            if old:
                for key in (
                    "raw_hash", "normalized_hash", "html_hash", "html_comparison_hash", "html_snapshot_location",
                    "file_snapshot_location", "extraction_type", "extractor_version", "snapshot_location", "evidence_location", "relevance",
                    "extraction_error", "error_signature", "error_since",
                ):
                    if key in old:
                        item[key] = old[key]
                # 304 responses usually omit entity headers; keep the known ones.
                if not item.get("content_type"):
                    item["content_type"] = old.get("content_type")
                if item.get("content_length") is None:
                    item["content_length"] = old.get("content_length")
            return item, None, None

        extraction_profile = {}
        text, extraction_type, extraction_error = extract_content(
            url,
            result.content_type,
            result.body,
            include_selector=source.include_selector,
            ignore_selectors=source.ignore_selectors,
            _extraction_profile=extraction_profile,
        )
        item["extraction_type"] = extraction_type
        if extraction_type in {"html", "pdf", "zip"}:
            parser_profile = str(extraction_profile.get("profile") or "native")
            if extraction_type == "zip" and parser_profile.startswith("zipprofile-"):
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION + "-" + parser_profile
            elif extraction_type in {"pdf", "zip"} and parser_profile == "fallback":
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION + "-fallback"
            else:
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION
        file_body = result.body if extraction_type in {"pdf", "zip"} else None
        if extraction_error:
            item["extraction_error"] = extraction_error
            if old:
                for key in ("normalized_hash", "snapshot_location", "first_seen", "evidence_location", "relevance", "extractor_version"):
                    if old.get(key) is not None:
                        item[key] = old[key]
            if extraction_type == "html":
                item["html_hash"] = result.raw_hash
                item["html_comparison_hash"] = html_comparison_hash(result.body)
                return item, None, result.body
            if file_body is not None:
                return item, None, None, file_body
            return item, None, None

        normalized = text or ""
        item["normalized_hash"] = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        html_body = result.body if extraction_type == "html" else None
        item["html_hash"] = result.raw_hash if html_body is not None else None
        item["html_comparison_hash"] = html_comparison_hash(html_body)
        if html_body is None:
            item["html_snapshot_location"] = None
        if file_body is None:
            item["file_snapshot_location"] = None
        item["relevance"] = triage(url, normalized, result.content_type)
        if file_body is not None:
            return item, normalized, html_body, file_body
        return item, normalized, html_body
    except Exception as exc:
        item["fetch_error"] = f"{type(exc).__name__}: {exc}"
        item["fetch_traceback"] = traceback.format_exc()
        if old:
            for key in (
                "http_status", "content_type", "content_length", "etag", "last_modified",
                "raw_hash", "normalized_hash", "html_hash", "html_comparison_hash", "html_snapshot_location",
                "first_seen", "snapshot_location", "evidence_location", "relevance", "extraction_type", "extractor_version"
            ):
                if key in old:
                    item[key] = old[key]
        return item, None, None


def process_source(
    source: SourceConfig,
    run_id: str,
    dry_run: bool = False,
    discovery_data_dir: Path | None = None,
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    previous = load_previous(source.id)
    initial_baseline = source.baseline_on_first_run and not previous

    discovery_root = discovery_data_dir or DATA
    urls = discover(source, discovery_root)
    discovery = load_discovery_metadata(source.id, discovery_root)
    if discovery.get("state") == "COMPLETE" and not urls:
        # A "complete" crawl that found nothing is a discovery failure, never
        # proof that every monitored URL was removed. Treating it as complete
        # used to wipe the whole baseline and alert REMOVED_URL for every page.
        discovery = dict(discovery)
        discovery["state"] = "FAILED"
        discovery["reason"] = "discovery reported COMPLETE but returned no in-scope URLs"

    # Discovery integrity is a hard gate. A PAUSED, DEGRADED, or FAILED
    # inventory is never fed into the expensive content-processing stage.
    # Doing so would turn partial discovery into a huge pseudo-complete crawl
    # and was a major source of long/cancelled Actions runs.
    if discovery.get("state") != "COMPLETE":
        state = str(discovery.get("state") or "FAILED")
        counts = {
            "discovered": int(discovery.get("discovered", len(urls))),
            "new": 0,
            "changed": 0,
            "source_changed": 0,
            "removed": 0,
            "unchanged": 0,
            "baseline_migration": 0,
            "extraction_drift": 0,
            "fetch_error": 0,
            "extraction_error": 0,
            "not_modified": 0,
            "forced_full_fetch": 0,
            "relevance_candidates": 0,
            "ai_ok": 0,
            "ai_invalid": 0,
            "ai_error": 0,
            "ai_skipped": 0,
            "ai_deferred": 0,
            "crawl_paused": 1 if state == "PAUSED" else 0,
            "crawl_degraded": 1 if state == "DEGRADED" else 0,
            "crawl_failed": 1 if state == "FAILED" else 0,
            "discovery_incomplete": 1,
        }
        return {
            "report": {
                "schema_version": 2,
                "run_id": run_id,
                "generated_at": now,
                "source": {
                    "id": source.id,
                    "name": source.name,
                    "regulator": source.regulator,
                    "seeds": list(source.seed_urls),
                    "allowed_prefixes": list(source.allowed_prefixes),
                    "initial_baseline": initial_baseline,
                },
                "discovery": discovery,
                "baseline_update_allowed": False,
                "change_detector": {
                    "raw_hash": "SHA-256 retrieved bytes",
                    "normalized_hash": "SHA-256 extracted normalized content",
                    "classification_hash": "normalized_hash",
                    "http_validators": "ETag/Last-Modified used only for conditional fetch optimization",
                },
                "relevance_gate": {"mode": "high_recall", "ai_final_semantic_decision": True},
                "ai_contract": {
                    "required_keys": [
                        "relevant",
                        "topic",
                        "change_type",
                        "summary",
                        "impact",
                        "effective_date",
                        "affected_scope",
                        "actions",
                        "reason",
                    ],
                    "strict": True,
                },
                "counts": counts,
                "events": [],
                "new_urls": [],
                "changed_urls": [],
                "removed_urls": [],
                "baseline_migrations": [],
                "ai_results": [],
            },
            "inventory": {},
        }

    # Do not preload every historical snapshot into RAM. A full-site source can
    # contain tens of thousands of URLs; snapshots are read only for events that
    # actually need before/after evidence or AI context.
    current = {}
    events, new_items, changed_items, source_changed_items, migration_items, unchanged_items = [], [], [], [], [], []
    resolved = {url: resolve_previous(url, previous) for url in urls}

    workers = min(int(DEFAULTS.get("fetch_workers", 8)), max(1, len(urls)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(make_current_item, url, resolved[url][1], source, now):
            (url, resolved[url][0], resolved[url][1])
            for url in urls
        }
        for future in as_completed(futures):
            url, uid, old = futures[future]
            result = future.result()
            # Preserve compatibility with tests/extensions that return the legacy two-item tuple.
            if len(result) == 2:
                item, text = result
                html_body = None
                file_body = None
            elif len(result) == 3:
                item, text, html_body = result
                file_body = None
            else:
                item, text, html_body, file_body = result
            item["url_id"] = uid
            if file_body is not None and not dry_run:
                item["file_snapshot_location"] = write_file_snapshot(
                    uid, file_body, item.get("raw_hash"), item.get("extraction_type")
                )
            current[uid] = item
            old_text = None

            if item.get("fetch_error"):
                event_id = build_event_id("FETCH_ERROR", uid, (old or {}).get("normalized_hash") or (old or {}).get("raw_hash"), error=item["fetch_error"], observation_id=now)
                evidence = None
                if not dry_run:
                    evidence = _write_evidence(
                        ROOT, "FETCH_ERROR", event_id, url, now, old, item,
                        old_text if old_text is not None else read_snapshot(old),
                        None,
                        item["fetch_error"],
                    )
                item["evidence_location"] = evidence
                notification_id = mark_error_episode("FETCH_ERROR", item, old, now)
                events.append({"event_id":event_id,"event_type":"FETCH_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"notification_id":notification_id,"error_since":item["error_since"],"evidence":{"error":item["fetch_error"]}})
                continue

            if item.get("extraction_error"):
                if html_body is not None and item.get("html_hash") and not dry_run:
                    item["html_snapshot_location"] = store_html_snapshot(uid, html_body, item, old)
                event_id = build_event_id("EXTRACTION_ERROR", uid, (old or {}).get("normalized_hash") or (old or {}).get("raw_hash"), after_hash=item.get("raw_hash"), error=item["extraction_error"], observation_id=now)
                evidence = None
                if not dry_run:
                    evidence = _write_evidence(
                        ROOT, "EXTRACTION_ERROR", event_id, url, now, old, item,
                        old_text if old_text is not None else read_snapshot(old),
                        None,
                        item["extraction_error"],
                        before_html=read_html_snapshot(old),
                        after_html=html_body.decode("utf-8", "replace") if html_body is not None else None,
                    )
                item["evidence_location"] = evidence
                notification_id = mark_error_episode("EXTRACTION_ERROR", item, old, now)
                current[uid] = item
                events.append({"event_id":event_id,"event_type":"EXTRACTION_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"notification_id":notification_id,"error_since":item["error_since"],"evidence":{"error":item["extraction_error"]}})
                continue

            # Migrate older HTML inventory records lazily from their immutable
            # snapshot so the first run with comparison signatures does not
            # mistake a rotating Cloudflare challenge token for a source change.
            if old and item.get("html_comparison_hash") and not old.get("html_comparison_hash"):
                old_html = read_html_snapshot(old)
                if old_html is not None:
                    old = dict(old)
                    old["html_comparison_hash"] = html_comparison_hash(old_html)

            extractor_rebaseline = should_rebaseline_extractor(old, item)
            extraction_drift = not extractor_rebaseline and is_extraction_drift(old, item)
            if extractor_rebaseline:
                item["migration_reason"] = "extractor_version"
            elif extraction_drift:
                item["migration_reason"] = "extraction_drift"
            event_type, migrated = classify_change(
                old, item, force_baseline_migration=extractor_rebaseline or extraction_drift
            )
            if event_type == "NEW_URL":
                new_items.append(item)
            elif event_type == "CHANGED_URL":
                changed_items.append({"before":old,"after":item})
            elif event_type == "HTML_SOURCE_CHANGED":
                source_changed_items.append({"before":old,"after":item})
            elif event_type == "BASELINE_MIGRATION":
                migration_items.append({"before":old,"after":item})
            else:
                unchanged_items.append(item)

            if text is not None:
                if not dry_run:
                    item["snapshot_location"] = write_snapshot(uid, text, item["normalized_hash"])
                    if html_body is not None and item.get("html_hash"):
                        item["html_snapshot_location"] = store_html_snapshot(uid, html_body, item, old)
                current[uid] = item

            if event_type != "UNCHANGED_URL" or migrated:
                suppress_baseline_event = initial_baseline and event_type == "NEW_URL"
                if not suppress_baseline_event:
                    if event_type == "HTML_SOURCE_CHANGED":
                        before_hash = (old or {}).get("html_hash") or (old or {}).get("raw_hash")
                        after_hash = item.get("html_hash") or item.get("raw_hash")
                    else:
                        before_hash = (old or {}).get("normalized_hash") or (old or {}).get("raw_hash") or (old or {}).get("content_hash")
                        after_hash = item.get("normalized_hash")
                    event_id = build_event_id(event_type, uid, before_hash, after_hash)
                    evidence = None
                    if event_type in {"NEW_URL","CHANGED_URL","HTML_SOURCE_CHANGED"}:
                        evidence = (
                            _write_evidence(
                                ROOT, event_type, event_id, url, now, old, item,
                                old_text if old_text is not None else read_snapshot(old),
                                text,
                                before_html=read_html_snapshot(old),
                                after_html=html_body.decode("utf-8", "replace") if html_body is not None else None,
                            )
                            if not dry_run
                            else None
                        )
                        item["evidence_location"] = evidence
                        current[uid] = item
                    event = {"event_id":event_id,"event_type":event_type,"url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":item}}
                    if item.get("migration_reason"):
                        event["migration_reason"] = item["migration_reason"]
                    events.append(event)

    removed_items = []
    removal_guard = None
    if discovery.get("state") == "COMPLETE":
        missing = [(uid, old) for uid, old in previous.items() if uid not in current]
        max_ratio = float(DEFAULTS.get("max_removal_ratio", 0.5))
        allow_mass_removal = source.id in {
            value.strip() for value in os.getenv("REGMON_ALLOW_MASS_REMOVAL", "").split(",") if value.strip()
        }
        if (
            missing
            and not allow_mass_removal
            and len(missing) >= 3
            and len(missing) / max(1, len(previous)) > max_ratio
        ):
            # Losing most of a source in one run is far more often a crawler,
            # scope or site-layout problem than a regulator retiring pages. Hold
            # the removals: keep the records, mark them missing, alert once, and
            # let an operator confirm with REGMON_ALLOW_MASS_REMOVAL=<source id>.
            since = min(str(old.get("missing_since") or now) for _uid, old in missing)
            for uid, old in missing:
                held = dict(old)
                held["missing_since"] = old.get("missing_since") or now
                current[uid] = held
            removal_guard = {
                "source_id": source.id,
                "held_removals": len(missing),
                "previous_count": len(previous),
                "ratio": round(len(missing) / max(1, len(previous)), 3),
                "max_ratio": max_ratio,
                "missing_since": since,
                "notification_id": "removal-guard-" + hashlib.sha256(
                    "|".join([source.id, since, *sorted(uid for uid, _old in missing)]).encode("utf-8")
                ).hexdigest(),
            }
            missing = []
        for uid, old in missing:
            removed_items.append(old)
            url = old.get("canonical_url","")
            event_id = build_event_id("REMOVED_URL", uid, old.get("normalized_hash") or old.get("raw_hash") or old.get("content_hash"))
            evidence = (
                _write_evidence(ROOT, "REMOVED_URL", event_id, url, now, old, None, read_snapshot(old), None)
                if not dry_run
                else None
            )
            events.append({"event_id":event_id,"event_type":"REMOVED_URL","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":None}})

    new_ids = {item["url_id"] for item in new_items}
    changed_ids = {entry["after"]["url_id"] for entry in changed_items}
    candidate_pool = build_ai_candidate_pool(
        new_items, changed_items, unchanged_items, initial_baseline=initial_baseline
    )

    # A resumed AI item needs its original change event in the current report so
    # the dashboard can attach the eventual assessment to the page and evidence.
    existing_event_ids = {event.get("event_id") for event in events}
    for item in candidate_pool:
        pending = item.get("ai_pending")
        if (
            not isinstance(pending, dict)
            or item["url_id"] in new_ids
            or item["url_id"] in changed_ids
            or pending.get("event_id") in existing_event_ids
        ):
            continue
        event_type = candidate_event_type(item, new_ids, changed_ids)
        event_id = str(pending.get("event_id") or "")
        if not event_id:
            continue
        events.append({
            "event_id": event_id,
            "event_type": event_type,
            "url": item["canonical_url"],
            "url_id": item["url_id"],
            "source_id": source.id,
            "timestamp": pending.get("timestamp") or pending.get("first_deferred_at") or now,
            "evidence_location": pending.get("evidence_location") or item.get("evidence_location"),
            "evidence": {"ai_backlog_retry": True},
        })
        existing_event_ids.add(event_id)
    ai_cfg = AIConfig(
        timeout_seconds=int(DEFAULTS.get("ai_timeout_seconds",60)),
        attempts=int(DEFAULTS.get("ai_attempts",2)),
        max_chars=int(DEFAULTS.get("max_ai_chars",14000)),
    )
    max_candidates = int(DEFAULTS.get("max_ai_candidates",100))
    ai_results = []

    candidates = candidate_pool[:max_candidates]
    deferred = candidate_pool[max_candidates:]
    for item in deferred:
        event = candidate_event_type(item, new_ids, changed_ids)
        prior_pending = item.get("ai_pending")
        prior_pending = prior_pending if isinstance(prior_pending, dict) else {}
        event_record = next(
            (
                value for value in events
                if value.get("url_id") == item["url_id"]
                and value.get("event_type") == event
            ),
            None,
        )
        is_resumed = (
            item["url_id"] not in new_ids
            and item["url_id"] not in changed_ids
            and prior_pending.get("after_hash") == item.get("normalized_hash")
            and prior_pending.get("event_type") == event
        )
        if is_resumed and prior_pending.get("event_id"):
            pending = dict(prior_pending)
        else:
            old_item = previous.get(item["url_id"]) or {}
            before_hash = old_item.get("normalized_hash") or old_item.get("raw_hash") or old_item.get("content_hash")
            event_id = (
                event_record.get("event_id")
                if event_record
                else build_event_id(event, item["url_id"], before_hash, item.get("normalized_hash"))
            )
            pending = {
                "event_type": event,
                "event_id": event_id,
                "timestamp": event_record.get("timestamp") if event_record else now,
                "evidence_location": (
                    event_record.get("evidence_location")
                    if event_record else item.get("evidence_location")
                ),
                "before_hash": before_hash,
                "after_hash": item.get("normalized_hash"),
                "first_deferred_at": now,
                "attempt_count": 0,
                "deferral_count": 0,
            }
        pending["last_deferred_at"] = now
        pending["deferral_count"] = int(pending.get("deferral_count", 0)) + 1
        pending["after_hash"] = item.get("normalized_hash")
        item["ai_pending"] = pending
        current[item["url_id"]] = item
        ai_results.append({
            "event": event,
            "event_id": pending["event_id"],
            "url": item["canonical_url"],
            "source_id": source.id,
            "evidence_location": pending.get("evidence_location") or item.get("evidence_location"),
            "ai":{
                "status":"deferred",
                "reason":f"Exceeded per-run AI limit of {max_candidates}",
            },
        })

    # Only materialize the current/previous text for the bounded AI set.
    # Ordinary unchanged pages never enter this structure.
    ai_inputs = {}
    for item in candidates:
        event = candidate_event_type(item, new_ids, changed_ids)
        current_text = read_snapshot(item) or ""
        old_text = read_snapshot(previous.get(item["url_id"])) if event == "CHANGED_URL" else None
        ai_inputs[item["url_id"]] = {
            "event": event,
            "current_text": current_text[:ai_cfg.max_chars],
            "diff": make_diff(
                old_text,
                current_text,
                int(DEFAULTS.get("max_diff_lines", 200)),
            ) if event == "CHANGED_URL" else "",
        }

    def analyze_item(item: dict) -> dict:
        context = ai_inputs[item["url_id"]]
        event = context["event"]
        pending = item.get("ai_pending")
        if (
            isinstance(pending, dict)
            and pending.get("event_type") == event
            and pending.get("after_hash") == item.get("normalized_hash")
            and pending.get("event_id")
        ):
            event_id = pending["event_id"]
        else:
            event_record = next(
                (
                    value for value in events
                    if value.get("url_id") == item["url_id"]
                    and value.get("event_type") == event
                ),
                None,
            )
            event_id = (
                event_record.get("event_id")
                if event_record
                else build_event_id(
                    event,
                    item["url_id"],
                    (previous.get(item["url_id"]) or {}).get("normalized_hash"),
                    item.get("normalized_hash"),
                )
            )
        return {
            "event": event,
            "event_id": event_id,
            "url": item["canonical_url"],
            "source_id": source.id,
            "evidence_location": item.get("evidence_location"),
            "ai": analyze(
                source.regulator,
                item["canonical_url"],
                event,
                context["diff"],
                context["current_text"],
                ai_cfg,
            ),
        }

    if not dry_run and candidates:
        with ThreadPoolExecutor(max_workers=int(DEFAULTS.get("ai_concurrency",4))) as pool:
            future_map = {pool.submit(analyze_item,item): item for item in candidates}
            for future in as_completed(future_map):
                item = future_map[future]
                try:
                    result = future.result()
                    ai_results.append(result)
                    # Once the model returns a valid structured answer, the item
                    # is no longer pending. Provider/schema failures retain the
                    # marker so a later run can retry within the normal scan budget.
                    ai = result.get("ai", {}) if isinstance(result, dict) else {}
                    if ai.get("status") == "ok":
                        item.pop("ai_pending", None)
                        current[item["url_id"]] = item
                    else:
                        event = candidate_event_type(item, new_ids, changed_ids)
                        prior = item.get("ai_pending")
                        if (
                            isinstance(prior, dict)
                            and prior.get("event_type") == event
                            and prior.get("after_hash") == item.get("normalized_hash")
                            and prior.get("event_id") == result.get("event_id")
                        ):
                            pending = dict(prior)
                            pending["attempt_count"] = int(pending.get("attempt_count", 0)) + 1
                            pending["last_attempt_at"] = now
                        else:
                            event_record = next(
                                (
                                    value for value in events
                                    if value.get("url_id") == item["url_id"]
                                    and value.get("event_type") == event
                                ),
                                None,
                            )
                            old_item = previous.get(item["url_id"]) or {}
                            pending = {
                                "event_type": event,
                                "event_id": result.get("event_id") or (
                                    event_record.get("event_id") if event_record else
                                    build_event_id(
                                        event, item["url_id"],
                                        old_item.get("normalized_hash") or old_item.get("raw_hash") or old_item.get("content_hash"),
                                        item.get("normalized_hash"),
                                    )
                                ),
                                "timestamp": event_record.get("timestamp") if event_record else now,
                                "evidence_location": (
                                    result.get("evidence_location")
                                    or (event_record.get("evidence_location") if event_record else None)
                                    or item.get("evidence_location")
                                ),
                                "before_hash": old_item.get("normalized_hash") or old_item.get("raw_hash") or old_item.get("content_hash"),
                                "after_hash": item.get("normalized_hash"),
                                "first_deferred_at": now,
                                "attempt_count": 1,
                                "deferral_count": 0,
                                "last_attempt_at": now,
                            }
                        item["ai_pending"] = pending
                        current[item["url_id"]] = item
                except Exception as exc:
                    event = candidate_event_type(item, new_ids, changed_ids)
                    pending = item.get("ai_pending")
                    if (
                        isinstance(pending, dict)
                        and pending.get("event_type") == event
                        and pending.get("after_hash") == item.get("normalized_hash")
                        and pending.get("event_id")
                    ):
                        event_id = pending["event_id"]
                        updated_pending = dict(pending)
                        updated_pending["attempt_count"] = int(updated_pending.get("attempt_count", 0)) + 1
                        updated_pending["last_attempt_at"] = now
                        item["ai_pending"] = updated_pending
                        current[item["url_id"]] = item
                    else:
                        event_record = next(
                            (
                                value for value in events
                                if value.get("url_id") == item["url_id"]
                                and value.get("event_type") == event
                            ),
                            None,
                        )
                        event_id = (
                            event_record.get("event_id")
                            if event_record
                            else build_event_id(
                                event, item["url_id"],
                                (previous.get(item["url_id"]) or {}).get("normalized_hash"),
                                item.get("normalized_hash"),
                            )
                        )
                    ai_results.append({"event":event,"event_id":event_id,"url":item["canonical_url"],"source_id":source.id,"evidence_location":item.get("evidence_location"),"ai":{"status":"error","reason":str(exc)}})

    counts = {
        "discovered":len(current),
        "new":len(new_items),
        "changed":len(changed_items),
        "source_changed":len(source_changed_items),
        "removed":len(removed_items),
        "removal_held":removal_guard["held_removals"] if removal_guard else 0,
        "unchanged":len(unchanged_items),
        "baseline_migration":len(migration_items),
        "extraction_drift":sum(1 for entry in migration_items if entry["after"].get("migration_reason") == "extraction_drift"),
        "fetch_error":sum(1 for x in current.values() if x.get("fetch_error")),
        "extraction_error":sum(1 for x in current.values() if x.get("extraction_error")),
        "not_modified":sum(1 for x in current.values() if x.get("not_modified")),
        "forced_full_fetch":sum(1 for x in current.values() if x.get("full_fetch_forced")),
        "relevance_candidates":len([x for x in new_items + [c["after"] for c in changed_items] if x.get("relevance",{}).get("candidate",True)]),
        "ai_ok":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="ok"),
        "ai_invalid":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="invalid"),
        "ai_error":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="error"),
        "ai_skipped":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="skipped"),
        "ai_deferred":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="deferred"),
        "ai_backlog_pending":sum(
            1 for item in current.values()
            if isinstance(item.get("ai_pending"), dict)
        ),
        "crawl_paused":0,
    }
    return {
        "report":{
            "schema_version":2,"run_id":run_id,"generated_at":now,
            "source":{"id":source.id,"name":source.name,"regulator":source.regulator,"seeds":list(source.seed_urls),"allowed_prefixes":list(source.allowed_prefixes),"initial_baseline":initial_baseline},
            "discovery":discovery,
            "removal_guard":removal_guard,
            "baseline_update_allowed":discovery.get("state") == "COMPLETE",
            "change_detector":{"raw_hash":"SHA-256 retrieved response bytes","html_hash":"SHA-256 full HTML response body; retained for raw snapshots and evidence", "html_comparison_hash":"HTML comparison signature with volatile Cloudflare challenge IDs/timestamps stabilized","normalized_hash":"SHA-256 extracted normalized content","classification_hash":"normalized_hash with separate HTML_SOURCE_CHANGED events","http_validators":"ETag/Last-Modified used only for conditional fetch optimization"},
            "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
            "ai_contract":{"required_keys":["relevant","topic","change_type","summary","impact","effective_date","affected_scope","actions","reason"],"strict":True},
            "counts":counts,"events":events,"new_urls":[] if initial_baseline else new_items,"changed_urls":changed_items,"source_changed_urls":source_changed_items,"removed_urls":removed_items,"baseline_migrations":migration_items,"ai_results":sorted(ai_results,key=lambda x:x.get("event_id",""))
        },
        "inventory":current
    }

def save_outputs(source_results: list[dict], run_id: str, dry_run: bool=False) -> dict:
    if dry_run:
        return {"dry_run":True}
    for path in (DATA,SNAPSHOTS,HISTORY,REPORTS):
        path.mkdir(parents=True,exist_ok=True)
    latest_path = DATA / "latest.json"
    payload = json.loads(latest_path.read_text(encoding="utf-8")) if latest_path.exists() else {"schema_version":2,"sources":{}}
    if payload.get("schema_version") != 2 or not isinstance(payload.get("sources"),dict):
        payload = {"schema_version":2,"sources":{}}
    # Never prune a previously trusted source inventory merely because the
    # current configuration changed or the new crawl is degraded. Explicit
    # cleanup can be performed later after a successful migration.
    history_path = HISTORY / "index.json"
    history = json.loads(history_path.read_text(encoding="utf-8")) if history_path.exists() else []
    for result in source_results:
        report = result["report"]
        sid = report["source"]["id"]
        if report.get("baseline_update_allowed"):
            payload["sources"][sid] = result["inventory"]
        (REPORTS / f"{sid}.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
        history.append({"run_id":report["run_id"],"generated_at":report["generated_at"],"source_id":sid,"regulator":report["source"]["regulator"],"counts":report["counts"]})
    history.sort(key=lambda x:x.get("generated_at",""),reverse=True)
    history = history[:int(DEFAULTS.get("history_runs",90))*max(1,len(source_results))]
    history_path.write_text(json.dumps(history,indent=2),encoding="utf-8")
    latest_path.write_text(json.dumps(payload,indent=2),encoding="utf-8")

    count_keys = set().union(*(r["report"]["counts"].keys() for r in source_results))
    aggregate_counts = {k:sum(int(r["report"]["counts"].get(k,0)) for r in source_results) for k in sorted(count_keys)}
    aggregate = {
        "schema_version":2,"run_id":run_id,
        "generated_at":max(r["report"]["generated_at"] for r in source_results),
        "sources":[r["report"]["source"] for r in source_results],
        "counts":aggregate_counts,
        "discovery":[r["report"].get("discovery",{}) for r in source_results],
        "removal_guards":[r["report"]["removal_guard"] for r in source_results if r["report"].get("removal_guard")],
        "baseline_update_allowed":all(r["report"].get("baseline_update_allowed",False) for r in source_results),
        "change_detector":{"classification_hash":"normalized_hash","html_hash":"stored full HTML response body", "html_comparison_hash":"volatile Cloudflare challenge IDs/timestamps stabilized before markup-only classification","http_validators":"ETag/Last-Modified are optimization hints only"},
        "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
        "ai_contract":source_results[0]["report"]["ai_contract"],
        "new_urls":[x for r in source_results for x in r["report"]["new_urls"]],
        "changed_urls":[x for r in source_results for x in r["report"]["changed_urls"]],
        "source_changed_urls":[x for r in source_results for x in r["report"].get("source_changed_urls",[])],
        "removed_urls":[x for r in source_results for x in r["report"]["removed_urls"]],
        "baseline_migrations":[x for r in source_results for x in r["report"]["baseline_migrations"]],
        "events":[x for r in source_results for x in r["report"]["events"]],
        "ai_results":[x for r in source_results for x in r["report"]["ai_results"]],
    }
    (DATA / "report.json").write_text(json.dumps(aggregate,indent=2),encoding="utf-8")
    (HISTORY / f"{run_id}.json").write_text(json.dumps(aggregate,indent=2),encoding="utf-8")
    md = ["# Regulatory Monitoring Report","",f"Run: {run_id}",f"Generated: {aggregate['generated_at']}","","## Aggregate counts","","| Metric | Value |","| --- | ---: |"]
    md += [f"| {k} | {v} |" for k,v in aggregate_counts.items()]
    md += ["","## Sources",""]
    for r in source_results:
        c=r["report"]["counts"]; s=r["report"]["source"]
        md += [f"### {s['name']}","",f"- Regulator: {s['regulator']}",f"- Discovered: {c['discovered']}",f"- Changed content: {c['changed']}",f"- HTML source-only changes: {c.get('source_changed',0)}",f"- New: {c['new']}",f"- Removed: {c['removed']}",f"- Fetch errors: {c['fetch_error']}", ""]
    (DATA / "report.md").write_text("\n".join(md),encoding="utf-8")
    return {"dry_run":False,"sources":[r["report"]["source"]["id"] for r in source_results],"run_id":run_id}

def run(source_id: str="all", dry_run: bool=False) -> dict:
    _, sources = load_config()
    selected = [source for source in sources.values() if source.active] if source_id in {"all","*"} else [sources[source_id]]
    if not selected:
        raise ValueError("No active monitoring sources are configured")
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"

    if dry_run:
        # Discovery writes checkpoints, inventories, and failure ledgers. Work on
        # a temporary copy so even discovery side effects disappear after the run.
        with tempfile.TemporaryDirectory(prefix="changesentinel-dry-run-") as temporary:
            discovery_data_dir = Path(temporary) / "data"
            discovery_data_dir.mkdir(parents=True, exist_ok=True)
            if DISCOVERY.is_dir():
                shutil.copytree(DISCOVERY, discovery_data_dir / "discovery", dirs_exist_ok=True)
            results = [
                process_source(source, run_id, dry_run=True, discovery_data_dir=discovery_data_dir)
                for source in selected
            ]
    else:
        results = [process_source(source, run_id, dry_run=False) for source in selected]

    return {"run_id":run_id,"results":results,"outcome":save_outputs(results,run_id,dry_run=dry_run)}

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",default=os.getenv("REGMON_SOURCE","all"))
    parser.add_argument("--dry-run",action="store_true")
    args=parser.parse_args()
    result=run(args.source,args.dry_run)
    print(json.dumps({"run_id":result["run_id"],"sources":args.source,"outcome":result["outcome"]},indent=2))

if __name__ == "__main__":
    main()
