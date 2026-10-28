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
from urllib.parse import urlsplit
from typing import Any

from regmon.ai import AIConfig, analyze
from regmon.change import (
    build_event_id,
    change_event_id,
    classify_change,
    error_signature,
    HTML_COMPARISON_HASH_VERSION,
    html_comparison_hash,
    make_diff,
    make_id,
    operational_notification_id,
    write_evidence,
)
from regmon.config import DEFAULT_CONFIG_PATH, SourceConfig, load_config
from regmon.content import CONTENT_EXTRACTOR_VERSION, extract_content
from regmon.discovery import canonical, discover
from regmon.docling_extractor import configure_timeout_registry
from regmon.fetch import FetchResult, HTTPStatusError, fetch
from regmon import botcheck
from regmon.fsutil import atomic_write_bytes, atomic_write_text
from regmon.relevance import triage
from regmon import deadlines, health, item_codes, link_lineage, registry, reviews, schedule, spec_diff, translate, visual

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


# Workbooks monitored on their own use the structured workbook text (regmon/workbook.py).
WORKBOOK_EXTRACTOR_VERSION = CONTENT_EXTRACTOR_VERSION + "-xlsx2"
# Workbooks keep their original file so the dashboard can compare them cell by
# cell; .xls and .ods read into the same structured text as .xlsx.
WORKBOOK_TYPES = {"xlsx", "xls", "ods"}


def is_current_extractor_version(version: object) -> bool:
    """Recognize stable variants of the current hybrid PDF extraction pipeline."""
    value = str(version or "")
    return (
        value in {CONTENT_EXTRACTOR_VERSION, CONTENT_EXTRACTOR_VERSION + "-fallback", WORKBOOK_EXTRACTOR_VERSION}
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
        atomic_write_text(path, text)
    return str(path.relative_to(ROOT))


def write_html_snapshot(uid: str, body: bytes, html_hash: str) -> str:
    """Persist the complete fetched HTML response body without replacing older versions."""
    HTML_SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = HTML_SNAPSHOTS / f"{uid}-{html_hash}.html"
    if not path.exists():
        atomic_write_bytes(path, body)
    return str(path.relative_to(ROOT))


def store_html_snapshot(uid: str, body: bytes, item: dict, old: dict | None) -> str:
    """Save the fetched HTML, reusing the previous file when only volatile tokens differ.

    Pages behind Cloudflare return different bytes on every request, so a new
    ~100 KB snapshot used to be committed per page per run. When the comparison
    signature is unchanged the previous snapshot is equivalent evidence; the
    record then points at it (and its hash) instead of adding a new file.

    html_hash therefore identifies the saved snapshot, not necessarily this
    response's bytes; raw_hash always identifies the fetched response.
    """
    if (
        old
        and old.get("html_snapshot_location")
        and old.get("html_hash")
        and old.get("html_comparison_hash")
        and old.get("html_comparison_hash") == item.get("html_comparison_hash")
        and old.get("html_comparison_hash_version") == item.get("html_comparison_hash_version")
        and (ROOT / str(old["html_snapshot_location"])).is_file()
    ):
        item["html_hash"] = old["html_hash"]
        return str(old["html_snapshot_location"])
    return write_html_snapshot(uid, body, item["html_hash"])


def write_file_snapshot(uid: str, body: bytes, content_hash: str | None, extraction_type: str) -> str:
    """Persist original PDF/ZIP/workbook bytes so the dashboard can preview, compare or download the exact file."""
    suffix = {"pdf": "pdf", "zip": "zip", "xlsx": "xlsx", "xls": "xls", "ods": "ods"}.get(str(extraction_type or "").lower())
    if suffix is None:
        raise ValueError(f"Unsupported original-file snapshot type: {extraction_type!r}")
    directory = SNAPSHOTS / "files"
    directory.mkdir(parents=True, exist_ok=True)
    digest = content_hash or hashlib.sha256(body).hexdigest()
    path = directory / f"{uid}-{digest}.{suffix}"
    if not path.exists():
        atomic_write_bytes(path, body)
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
        "html_comparison_hash_version": old.get("html_comparison_hash_version") if old else None,
        "html_snapshot_location": old.get("html_snapshot_location") if old else None,
        "file_snapshot_location": old.get("file_snapshot_location") if old else None,
        "visual_snapshot_location": old.get("visual_snapshot_location") if old else None,
        "visual_hash": old.get("visual_hash") if old else None,
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
        # Durable per-URL change timeline: reports only hold the latest run, so
        # without this a change vanished from the dashboard within six hours.
        "last_changed_at": old.get("last_changed_at") if old else None,
        "change_history": list(old.get("change_history") or []) if old else [],
        # English reading aid (regmon/translate.py); never part of change detection.
        "language": old.get("language") if old else None,
        "language_of": old.get("language_of") if old else None,
        "language_needs_translation": old.get("language_needs_translation") if old else None,
        "translation_location": old.get("translation_location") if old else None,
        "translation": old.get("translation") if old else None,
        "not_modified": False,
    }


def structured_spec(event_type: str, before_text: str | None, after_text: str | None) -> tuple[dict | None, dict | None]:
    """Row-level rule/field/schema changes, never allowed to break a scan."""
    try:
        if event_type == "CHANGED_URL":
            return spec_diff.diff(before_text, after_text), None
        if event_type == "NEW_URL":
            inventory = spec_diff.inventory(after_text)
            return None, inventory if inventory and inventory.get("declared") else None
    except Exception as exc:  # pragma: no cover - defensive: insights never break detection
        print(f"Structured spec diff skipped: {type(exc).__name__}: {exc}")
    return None, None


_REGISTRY_CACHE: dict = {}


def load_registry() -> dict | None:
    """config/registry.json (with lineage.json folded in), read once per scan; never fatal."""
    path = ROOT / "config" / "registry.json"
    lineage_path = ROOT / "config" / "lineage.json"
    try:
        stamp = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else (str(p), 0, 0) for p in (path, lineage_path))
        if _REGISTRY_CACHE.get("stamp") != stamp:
            _REGISTRY_CACHE.update(stamp=stamp, value=registry.load(path, lineage_path))
        return _REGISTRY_CACHE["value"]
    except Exception as exc:
        print(f"Item registry skipped: {type(exc).__name__}: {exc}")
        return None


def registry_impact(codes: dict | None, spec: dict | None, before_text: str | None, after_text: str | None,
                    effective: str = "") -> dict | None:
    """Registered items the change touched and what reads them (regmon/registry.py)."""
    try:
        current = load_registry()
        if not current or not (current["items"] or current["rules"]):
            return None
        index = registry.Index(current)
        before_lines = set((before_text or "").splitlines())
        after_lines = set((after_text or "").splitlines())
        changed = "\n".join(["+" + line for line in after_lines - before_lines] + ["-" + line for line in before_lines - after_lines])
        touched = registry.touched_codes(codes, spec, changed, index)
        result = registry.impact(touched, current, effective=effective)
        return result if result and result.get("items") else None
    except Exception as exc:  # pragma: no cover - defensive: insights never break detection
        print(f"Registry impact skipped: {type(exc).__name__}: {exc}")
        return None


CHANGE_HISTORY_LIMIT = 20
CONTENT_CHANGE_EVENTS = {"NEW_URL", "CHANGED_URL"}


def record_change(item: dict, event: dict) -> None:
    """Prepend an event to the URL's durable change timeline (newest first)."""
    entry = {
        "event_id": event["event_id"],
        "event_type": event["event_type"],
        "timestamp": event["timestamp"],
        "evidence_location": event.get("evidence_location"),
    }
    if event.get("item_codes"):
        entry["item_codes"] = event["item_codes"]
    if event.get("spec"):
        entry["spec"] = event["spec"]
    if event.get("impact"):
        entry["impact"] = event["impact"]
    if event.get("visual"):
        entry["visual"] = event["visual"]
    history = [old for old in (item.get("change_history") or []) if old.get("event_id") != entry["event_id"]]
    item["change_history"] = [entry, *history][:CHANGE_HISTORY_LIMIT]
    if event["event_type"] in CONTENT_CHANGE_EVENTS:
        item["last_changed_at"] = event["timestamp"]


def attach_ai_to_history(current: dict[str, dict], ai_results: list[dict]) -> None:
    """Keep the AI verdict next to its change in the timeline."""
    by_url = {item.get("canonical_url"): item for item in current.values()}
    for result in ai_results:
        ai = result.get("ai") or {}
        analysis = ai.get("analysis") if ai.get("status") == "ok" else None
        item = by_url.get(result.get("url"))
        if not isinstance(analysis, dict) or not item:
            continue
        for entry in item.get("change_history") or []:
            if entry.get("event_id") == result.get("event_id"):
                entry["ai_relevant"] = analysis.get("relevant")
                entry["ai_topic"] = analysis.get("topic")
                entry["ai_summary"] = analysis.get("summary")
                condition = ai.get("condition")
                if isinstance(condition, dict) and isinstance(condition.get("met"), bool):
                    entry["ai_condition_met"] = condition["met"]


def mark_error_episode(kind: str, item: dict, old: dict | None, now: str) -> str:
    """Track when an operational error began; return its notification identity.

    A persistent failure keeps the onset recorded by the first failing run, so
    the notifier alerts once per episode. A different failure class, or a
    failure after a successful run, starts a new episode.
    """
    message = item.get("fetch_error") if kind == "FETCH_ERROR" else item.get("extraction_error")
    signature = error_signature(kind, message)
    since = now
    runs = 1
    warning = (old or {}).get("fetch_warning")
    if kind == "FETCH_ERROR" and isinstance(warning, dict) and warning.get("since"):
        # The previous scan held a first miss (_hold_transient_miss): the
        # episode began then, and that scan counts as a failing run.
        since = str(warning["since"])
        try:
            runs = max(1, int(warning.get("runs") or 1)) + 1
        except (TypeError, ValueError):
            runs = 2
        if warning.get("signature") != signature:
            since, runs = now, 1
    elif old and old.get("error_signature") == signature and old.get("error_since"):
        since = str(old["error_since"])
        # Records from before this counter existed already alerted for their
        # episode; count them as at least one earlier failing run.
        try:
            runs = max(1, int(old.get("error_runs") or 1)) + 1
        except (TypeError, ValueError):
            runs = 2
    item["error_signature"] = signature
    item["error_since"] = since
    item["error_runs"] = runs
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


class BotCheckError(RuntimeError):
    """The response was a bot-check or challenge page, not the monitored page."""


def capture_bot_check(uid: str, body: bytes, vendor: str, now: str, via: str) -> dict:
    """Save the challenge page (content-addressed, never overwritten) for review."""
    digest = hashlib.sha256(body).hexdigest()
    path = SNAPSHOTS / "botcheck" / f"{uid}-{digest[:16]}.html"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, body)
    return {"vendor": vendor, "captured_at": now, "via": via, "location": str(path.relative_to(ROOT)), "sha256": digest}


def _is_html(content_type: str, body: bytes) -> bool:
    kind = str(content_type or "").lower()
    if "html" in kind:
        return True
    return not kind and body[:512].lstrip().lower().startswith((b"<!doctype html", b"<html"))


# Screenshots taken by browser renders (fetch workers) wait here, by URL id,
# until the scan loop stores and compares them; they never enter the inventory.
_SCREENSHOTS: dict[str, bytes] = {}
_SCREENSHOTS_LOCK = __import__("threading").Lock()
VISUAL_REUSE_BELOW = 0.0005  # a render this close to the last one reuses its file


def take_screenshot(uid: str) -> bytes | None:
    with _SCREENSHOTS_LOCK:
        return _SCREENSHOTS.pop(uid, None)


def _store_png(name: str, body: bytes) -> str:
    path = ROOT / "data" / "snapshots" / "visual" / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, body)
    return str(path.relative_to(ROOT))


def apply_visual(uid: str, shot: bytes, old: dict | None, item: dict, now: str, dry_run: bool) -> dict | None:
    """Store this render's screenshot and compare it with the last one.

    Returns the evidence block (before/after/overlay locations, share of the
    page that looks different, regions), or None for a first screenshot or
    when no comparison could be made. Nearly identical renders reuse the
    previous file so a scan does not commit a new image every six hours.
    """
    digest = visual.digest(shot)
    previous_location = (old or {}).get("visual_snapshot_location")
    previous_png = None
    if previous_location:
        try:
            previous_png = (ROOT / previous_location).read_bytes()
        except OSError:
            previous_png = None
    comparison = None
    if previous_png is not None and visual.available():
        try:
            comparison = visual.compare(previous_png, shot)
        except Exception as exc:  # pragma: no cover - a bad image never breaks a scan
            print(f"Visual comparison skipped for {uid}: {type(exc).__name__}: {exc}")
    if comparison is not None and comparison["changed_ratio"] < VISUAL_REUSE_BELOW:
        item["visual_snapshot_location"], item["visual_hash"] = previous_location, (old or {}).get("visual_hash")
        item["visual"] = {"changed_ratio": comparison["changed_ratio"], "region_count": comparison["region_count"], "compared_at": now}
        return None
    if not dry_run:
        item["visual_snapshot_location"] = _store_png(f"{uid}-{digest[:16]}.png", shot)
    item["visual_hash"] = digest
    if comparison is None:
        item["visual"] = {"changed_ratio": None, "region_count": 0, "compared_at": now}
        return None
    overlay = None if dry_run else _store_png(f"{uid}-{digest[:16]}-overlay.png", comparison["overlay_png"])
    item["visual"] = {"changed_ratio": comparison["changed_ratio"], "region_count": comparison["region_count"], "compared_at": now}
    return {"before": previous_location, "after": item.get("visual_snapshot_location"), "overlay": overlay,
            "before_hash": (old or {}).get("visual_hash"), "after_hash": digest,
            "changed_ratio": comparison["changed_ratio"], "region_count": comparison["region_count"],
            "regions": comparison["regions"], "size_before": comparison["size_before"], "size_after": comparison["size_after"]}


# Sites whose bot check the browser could not pass during this scan. After
# BROWSER_GIVE_UP_AFTER refusals the remaining URLs on that host wait for the
# next scan instead of each spending a full challenge wait.
BROWSER_GIVE_UP_AFTER = 2
_BROWSER_GIVEN_UP: dict[str, int] = {}
# Why the browser last failed on each host, so the URLs left for the next scan
# say what actually happened (a check it could not pass, or a browser fault).
_BROWSER_LAST_FAILURE: dict[str, str] = {}
_BROWSER_GATE = __import__("threading").Lock()


def _browser_failed(host: str, reason: str) -> None:
    _BROWSER_GIVEN_UP[host] = _BROWSER_GIVEN_UP.get(host, 0) + 1
    _BROWSER_LAST_FAILURE[host] = reason[:300]


def _browser_recovered(host: str) -> None:
    _BROWSER_GIVEN_UP.pop(host, None)
    _BROWSER_LAST_FAILURE.pop(host, None)


def _given_up_reason(host: str) -> str:
    reason = _BROWSER_LAST_FAILURE.get(host, "")
    return f" (last attempt: {reason})" if reason else ""


def _host_of(url: str) -> str:
    from urllib.parse import urlsplit

    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


# How a URL that served a good copy is asked again when it suddenly answers
# "not found" or a server error: twice more in the same scan (seconds apart),
# then once more on the next scan before it is recorded as a fetch error.
RECHECK_DELAYS_SECONDS = (5.0, 15.0)
TRANSIENT_MISS_CONFIRM_RUNS = 2
TRANSIENT_MISS_STATUSES = {404, 408, 410, 425}


def _recheck_sleep(seconds: float) -> None:
    __import__("time").sleep(seconds)


def _is_transient_miss(exc: BaseException) -> bool:
    """A failure that a working URL can show for one request and not the next.

    "Not found", "gone" and server errors (also when answered to the browser),
    timeouts and dropped connections. Bot checks and refusals have their own
    handling (regmon/botcheck.py) and are never treated as a miss.
    """
    import requests

    if isinstance(exc, HTTPStatusError):
        status = int(getattr(exc, "status_code", 0) or 0)
        return status in TRANSIENT_MISS_STATUSES or 500 <= status <= 599
    return isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError))


def _had_good_copy(old: dict | None) -> bool:
    """The URL has a saved baseline to fall back on."""
    return bool(old and old.get("normalized_hash"))


# What a held miss keeps from the last good scan, so the URL reads as unchanged.
_HELD_KEYS = (
    "http_status", "content_type", "content_length", "etag", "last_modified", "raw_hash", "normalized_hash",
    "html_hash", "html_comparison_hash", "html_comparison_hash_version", "html_snapshot_location",
    "file_snapshot_location", "snapshot_location", "evidence_location", "relevance", "extraction_type",
    "extractor_version", "rendered_by", "browser",
)


def _hold_transient_miss(item: dict, old: dict | None, exc: BaseException, message: str, now: str) -> bool:
    """Hold a first miss on a URL whose last scan was good; True when held.

    The URL keeps its last good copy and status, ``fetch_warning`` records what
    happened, and no FETCH_ERROR is raised. A miss on the next scan as well is
    recorded as a normal fetch error whose episode starts at the first miss, so
    an alert for a file that was really removed is not delayed
    (error_alert_after_runs counts the held scan too).
    """
    if not _is_transient_miss(exc) or not _had_good_copy(old) or old.get("fetch_error") or old.get("extraction_error"):
        return False
    prior = old.get("fetch_warning") if isinstance(old.get("fetch_warning"), dict) else None
    try:
        runs = int(prior.get("runs") or 1) + 1 if prior else 1
    except (TypeError, ValueError):
        runs = 2
    if runs >= TRANSIENT_MISS_CONFIRM_RUNS:
        return False
    for key in _HELD_KEYS:
        if key in old:
            item[key] = old[key]
    item["fetch_warning"] = {
        "message": message[:300],
        "signature": error_signature("FETCH_ERROR", message),
        "since": str(prior.get("since")) if prior and prior.get("since") else now,
        "runs": runs,
    }
    return True


class AccessRefusedError(RuntimeError):
    """The site refused the request outright (bare 403/406/429), also when asked as a browser."""


# Bare refusals worth a second try: 403/406 often mean "not your user agent" or
# "not your network"; 429 means slow down and is never pushed through a browser.
REFUSAL_STATUSES = {403, 406, 429}


def _challenge_result(exc: HTTPStatusError, vendor: str) -> FetchResult:
    return FetchResult(exc.status_code, exc.content_type or "text/html", len(exc.body), None, None,
                       hashlib.sha256(exc.body).hexdigest(), exc.body, challenge=vendor)


def _after_refusal(url: str, source: SourceConfig, exc: HTTPStatusError, item: dict, now: str, fetch_options: dict) -> FetchResult:
    """What to do when a site refuses a URL with no challenge page.

    1. Ask once more the way an ordinary browser asks (its headers); many sites
       refuse any agent that is not a browser.
    2. Load it in the browser, which may also take the owner's own route out
       (CHANGESENTINEL_BROWSER_PROXY) for sites that refuse cloud addresses.
    3. Otherwise record an AccessRefusedError: the last good copy stays and the
       next scan tries again (regmon/botcheck.py explains how it is reported).
    A 429 is the site asking to slow down: it is recorded, never pushed harder.
    """
    from regmon import browser_fetch
    from regmon.discovery import in_scope

    host = _host_of(url)
    status = exc.status_code
    if status == 429:
        raise AccessRefusedError(f"HTTP 429 refusal: {host} asked the scanner to slow down; "
                                 "this URL keeps its last good copy and is tried again next scan")
    try:
        retried = fetch(url, **dict(fetch_options, browser_headers=True, attempts=1, etag=None, last_modified=None))
    except HTTPStatusError as again:
        vendor = botcheck.detect(again.body, again.status_code, again.headers)
        if vendor:
            return _challenge_result(again, vendor)
        if again.status_code not in REFUSAL_STATUSES:
            raise
        status = again.status_code
    else:
        item["fetched_with"] = "browser headers"
        return retried
    if not browser_fetch.available():
        raise AccessRefusedError(f"HTTP {status} refusal: {host} refuses automated requests and no browser is available")
    with _BROWSER_GATE:
        if _BROWSER_GIVEN_UP.get(host, 0) >= BROWSER_GIVE_UP_AFTER:
            raise AccessRefusedError(f"HTTP {status} refusal: {host} refused the browser earlier in this scan{_given_up_reason(host)}; "
                                     "this URL keeps its last good copy and is tried again next scan")
        try:
            rendered = browser_fetch.render(url, want="resource", in_scope=lambda target: in_scope(canonical(target), source),
                                            max_bytes=int(DEFAULTS.get("max_response_bytes", 200 * 1024 * 1024)))
        except browser_fetch.ChallengeNotPassed as challenge:
            _browser_failed(host, str(challenge))
            item["bot_check"] = capture_bot_check(item["url_id"], challenge.page or b"", challenge.vendor, now, "browser")
            raise BotCheckError(str(challenge)) from challenge
        except Exception as failure:
            _browser_failed(host, f"the browser failed: {type(failure).__name__}: {failure}")
            raise AccessRefusedError(f"HTTP {status} refusal: {host} refuses automated requests and the browser could not load it: "
                                     f"{type(failure).__name__}: {failure}") from failure
        if rendered.status in REFUSAL_STATUSES or rendered.status == 401:
            _browser_failed(host, f"HTTP {rendered.status} in the browser")
            raise AccessRefusedError(f"HTTP {rendered.status} refusal: {host} refused this URL in a browser too "
                                     "(the site may block this network, or the file was removed or made private)")
        _browser_recovered(host)
    body = rendered.body if rendered.body is not None else rendered.html
    if rendered.status >= 400:
        raise HTTPStatusError(f"HTTP {rendered.status} for {url} (loaded in a browser)", rendered.status, rendered.content_type, body)
    item["rendered_by"] = "browser"
    item["browser"] = {"blocked_requests": rendered.blocked, "consent": "", "final_url": rendered.final_url,
                       "passed_check": rendered.challenge or f"HTTP {exc.status_code} refusal"}
    headers = rendered.headers or {}
    return FetchResult(rendered.status or 200, rendered.content_type, len(body), headers.get("etag") or None,
                       headers.get("last-modified") or None, hashlib.sha256(body).hexdigest(), body)


def _browser_pass(url: str, source: SourceConfig, result: FetchResult, item: dict, now: str) -> FetchResult:
    """Use a browser when the source asks for one or a bot check blocks the plain request.

    Any monitor whose plain request gets a challenge page is loaded in a
    browser automatically, whatever its fetch mode: the check runs there and
    the server's own response (a PDF as the PDF, a page as its HTML) is kept.
    ``fetch_mode: "browser"`` sources are rendered on every scan.

    Returns the result to extract; raises BotCheckError when the site keeps
    showing its check (the challenge page is saved first, and the last good
    copy stays the baseline).
    """
    announced = getattr(result, "challenge", "")
    announced = announced if isinstance(announced, str) else ""
    if result.not_modified or not (announced or _is_html(result.content_type, result.body)):
        return result
    vendor = announced or botcheck.detect(result.body, result.status_code)
    if source.fetch_mode != "browser" and not vendor:
        return result
    from regmon import browser_fetch
    from regmon.discovery import in_scope

    host = _host_of(url)

    def refuse(message: str, page: bytes | None = None, page_vendor: str | None = None, via: str = "http", cause=None):
        item["bot_check"] = capture_bot_check(item["url_id"], page or result.body, page_vendor or vendor or "Bot check", now, via)
        raise BotCheckError(message) from cause

    if vendor and not browser_fetch.available():
        refuse(f"{vendor} bot check returned instead of the page; no browser is available to get past it")
    # Rendered pages keep the DOM; a page only blocked by a check keeps the
    # server's own response, so the baseline matches a plain request's.
    want = "dom" if source.fetch_mode == "browser" else "resource"
    with _BROWSER_GATE:
        if vendor and _BROWSER_GIVEN_UP.get(host, 0) >= BROWSER_GIVE_UP_AFTER:
            refuse(f"{vendor} bot check: the browser could not get past it on {host} earlier in this scan{_given_up_reason(host)}; "
                   "this URL keeps its last good copy and is tried again next scan")
        try:
            rendered = browser_fetch.render(
                url, wait_seconds=source.browser_wait_seconds, wait_selector=source.browser_wait_selector,
                dismiss_cookies=source.browser_dismiss_cookies, in_scope=lambda target: in_scope(canonical(target), source),
                steps=list(source.browser_actions), screenshot=source.visual_compare, want=want,
                max_bytes=int(DEFAULTS.get("max_response_bytes", 200 * 1024 * 1024)),
            )
        except browser_fetch.ChallengeNotPassed as exc:
            _browser_failed(host, str(exc))
            refuse(str(exc), exc.page or None, exc.vendor, "browser", exc)
        except Exception as exc:
            if vendor:
                _browser_failed(host, f"the browser failed: {type(exc).__name__}: {exc}")
                refuse(f"{vendor} bot check returned instead of the page; the browser could not load it: {type(exc).__name__}: {exc}", cause=exc)
            raise
        _browser_recovered(host)
    body = rendered.body if rendered.body is not None else rendered.html
    content_type = rendered.content_type if rendered.body is not None else "text/html; charset=utf-8"
    if "html" in content_type.lower():
        rendered_vendor = botcheck.detect(body, 200)
        if rendered_vendor:
            refuse(f"{rendered_vendor} bot check still shown after loading in a browser", body, rendered_vendor, "browser")
    if rendered.status >= 400:
        raise HTTPStatusError(f"HTTP {rendered.status} for {url} (loaded in a browser)", rendered.status, content_type, body)
    item["rendered_by"] = "browser"
    item["browser"] = {"blocked_requests": rendered.blocked, "consent": rendered.consent[:80], "final_url": rendered.final_url}
    if rendered.challenge or vendor:
        item["browser"]["passed_check"] = rendered.challenge or vendor
    if rendered.steps:
        item["browser"]["steps"] = rendered.steps
    if rendered.screenshot and source.visual_compare:
        with _SCREENSHOTS_LOCK:
            _SCREENSHOTS[item["url_id"]] = rendered.screenshot
    if rendered.body is not None:
        headers = rendered.headers or {}
        return FetchResult(rendered.status or 200, content_type, len(body), headers.get("etag") or None,
                           headers.get("last-modified") or None, hashlib.sha256(body).hexdigest(), body)
    return FetchResult(200 if result.status_code >= 400 else result.status_code, content_type, len(body),
                       result.etag, result.last_modified, hashlib.sha256(body).hexdigest(), body)


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
            and (old_type in {"pdf", "zip"} | WORKBOOK_TYPES or "pdf" in old_content_type or "zip" in old_content_type)
            and not old.get("file_snapshot_location")
        )
        extractor_baseline_missing = bool(
            old
            and old_type in {"html", "pdf", "zip"} | WORKBOOK_TYPES
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
            # A rendered page can change while the HTML the server sends does not.
            or source.fetch_mode == "browser"
        )
        item["full_fetch_forced"] = force_full_fetch
        item["html_baseline_forced"] = html_baseline_missing and not refresh_required
        item["file_baseline_forced"] = file_baseline_missing
        item["extractor_baseline_forced"] = extractor_baseline_missing
        fetch_options = dict(
            timeout=int(DEFAULTS.get("fetch_timeout_seconds", 30)),
            attempts=int(DEFAULTS.get("fetch_attempts", 3)),
            backoff_seconds=float(DEFAULTS.get("fetch_backoff_seconds", 2)),
            etag=None if force_full_fetch else (old or {}).get("etag"),
            last_modified=None if force_full_fetch else (old or {}).get("last_modified"),
            allowed_domains=source.allowed_domains,
            allowed_prefixes=source.allowed_prefixes,
            allowed_urls=source.allowed_urls,
            allowed_resource_prefixes=source.allowed_resource_prefixes,
            excluded_prefixes=source.excluded_prefixes,
            excluded_urls=source.excluded_urls,
            max_bytes=int(DEFAULTS.get("max_response_bytes", 200 * 1024 * 1024)),
        )
        def obtain() -> FetchResult:
            try:
                fetched = fetch(url, **fetch_options)
            except HTTPStatusError as exc:
                # A challenge served with 403/405/429/503 is a bot check, not an
                # outage; the browser gets one attempt at it. A bare refusal gets a
                # retry with browser headers, then the browser too.
                vendor = botcheck.detect(exc.body, exc.status_code, exc.headers)
                if vendor:
                    fetched = _challenge_result(exc, vendor)
                elif exc.status_code in REFUSAL_STATUSES:
                    fetched = _after_refusal(url, source, exc, item, now, fetch_options)
                else:
                    raise
            return _browser_pass(url, source, fetched, item, now)

        # A URL that served a good copy last time and now answers 404/410/5xx
        # is asked again in this scan before anything is recorded: sites behind
        # a CDN (FFIEC on Cloudflare) occasionally answer one request from a
        # node that does not have the file, and the next request is fine.
        rechecks = 0
        while True:
            try:
                result = obtain()
                break
            except Exception as exc:
                if rechecks >= len(RECHECK_DELAYS_SECONDS) or not (_had_good_copy(old) and _is_transient_miss(exc)):
                    raise
                print(f"Rechecking {url} after {type(exc).__name__}: {exc}")
                _recheck_sleep(RECHECK_DELAYS_SECONDS[rechecks])
                rechecks += 1
        if rechecks:
            item["recovered_on_recheck"] = rechecks
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
                    "raw_hash", "normalized_hash", "html_hash", "html_comparison_hash", "html_comparison_hash_version", "html_snapshot_location",
                    "file_snapshot_location", "extraction_type", "extractor_version", "snapshot_location", "evidence_location", "relevance",
                    "extraction_error", "error_signature", "error_since", "error_runs", "extraction_truncated",
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
        if extraction_type in WORKBOOK_TYPES:
            item["extractor_version"] = WORKBOOK_EXTRACTOR_VERSION
        elif extraction_type in {"html", "pdf", "zip"}:
            parser_profile = str(extraction_profile.get("profile") or "native")
            if extraction_type == "zip" and parser_profile.startswith("zipprofile-"):
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION + "-" + parser_profile
            elif extraction_type in {"pdf", "zip"} and parser_profile == "fallback":
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION + "-fallback"
            else:
                item["extractor_version"] = CONTENT_EXTRACTOR_VERSION
        file_body = result.body if extraction_type in {"pdf", "zip"} | WORKBOOK_TYPES else None
        if extraction_error:
            item["extraction_error"] = extraction_error
            if old:
                for key in ("normalized_hash", "snapshot_location", "first_seen", "evidence_location", "relevance", "extractor_version"):
                    if old.get(key) is not None:
                        item[key] = old[key]
            if extraction_type == "html":
                item["html_hash"] = result.raw_hash
                item["html_comparison_hash"] = html_comparison_hash(result.body)
                item["html_comparison_hash_version"] = HTML_COMPARISON_HASH_VERSION
                return item, None, result.body
            if file_body is not None:
                return item, None, None, file_body
            return item, None, None

        normalized = text or ""
        item["normalized_hash"] = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        # A workbook past the cell limit is compared only up to it; say so on the
        # record instead of leaving a marker inside the text nobody reads (CS-31).
        item["extraction_truncated"] = bool(extraction_type in WORKBOOK_TYPES and "\n[TRUNCATED] " in normalized)
        html_body = result.body if extraction_type == "html" else None
        item["html_hash"] = result.raw_hash if html_body is not None else None
        item["html_comparison_hash"] = html_comparison_hash(html_body)
        item["html_comparison_hash_version"] = HTML_COMPARISON_HASH_VERSION if html_body is not None else None
        if html_body is None:
            item["html_snapshot_location"] = None
        if file_body is None:
            item["file_snapshot_location"] = None
        item["relevance"] = triage(url, normalized, result.content_type)
        if file_body is not None:
            return item, normalized, html_body, file_body
        return item, normalized, html_body
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        if _hold_transient_miss(item, old, exc, message, now):
            # Not confirmed yet: the URL keeps its last good copy and status,
            # and the next scan decides (see _hold_transient_miss).
            print(f"Holding a first miss for {url} until the next scan confirms it: {message}")
            return item, None, None
        item["fetch_error"] = message
        # The traceback goes to the job log only. data/latest.json is published
        # on GitHub Pages, so internal paths and library frames must not be
        # stored in it (and one traceback per failing URL bloated the inventory).
        print(f"Fetch or extraction failed for {url}:\n{traceback.format_exc()}")
        if old:
            for key in (
                "http_status", "content_type", "content_length", "etag", "last_modified",
                "raw_hash", "normalized_hash", "html_hash", "html_comparison_hash", "html_comparison_hash_version", "html_snapshot_location",
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
    suppressed_markup_urls = {canonical(url) for url in reviews.not_material_html_urls(DATA)}

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
    # The links each HTML page lists this scan (None: checked, not re-read), for data/link-lineage.json.
    link_observations: list[dict] = []
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
            if not item.get("fetch_error") and not item.get("extraction_error"):
                if html_body is not None:
                    try:
                        link_observations.append({"page": url, "at": now, "links": link_lineage.extract_links(html_body, url)})
                    except Exception as exc:  # a page whose links can't be read must not stop the scan
                        print(f"Link lineage skipped for {url}: {type(exc).__name__}: {exc}")
                elif item.get("not_modified") and "html" in str(item.get("content_type") or "").lower():
                    link_observations.append({"page": url, "at": now, "links": None})

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
                events.append({"event_id":event_id,"event_type":"FETCH_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"notification_id":notification_id,"error_since":item["error_since"],"error_runs":item["error_runs"],"evidence":{"error":item["fetch_error"]}})
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
                events.append({"event_id":event_id,"event_type":"EXTRACTION_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"notification_id":notification_id,"error_since":item["error_since"],"error_runs":item["error_runs"],"evidence":{"error":item["extraction_error"]}})
                continue

            # Re-hash an older HTML snapshot when the signature algorithm version
            # changes. Comparing its stored old-version digest with a new-version
            # digest would itself create a false HTML_SOURCE_CHANGED event.
            html_signature_rebaseline = False
            if (
                old
                and item.get("html_comparison_hash")
                and old.get("html_comparison_hash_version") != HTML_COMPARISON_HASH_VERSION
            ):
                if item.get("not_modified"):
                    # A 304 gives no body to hash. Keep both sides on the stored
                    # version until a full fetch lets us migrate safely.
                    item["html_comparison_hash"] = old.get("html_comparison_hash")
                    item["html_comparison_hash_version"] = old.get("html_comparison_hash_version")
                else:
                    old_html = read_html_snapshot(old)
                    if old_html is not None:
                        old = dict(old)
                        old["html_comparison_hash"] = html_comparison_hash(old_html)
                        old["html_comparison_hash_version"] = HTML_COMPARISON_HASH_VERSION
                    elif old.get("normalized_hash") == item.get("normalized_hash"):
                        # Without the old body, an HTML-only transition cannot be
                        # classified reliably. Record a one-time baseline migration
                        # instead of presenting signature-algorithm churn as a change.
                        html_signature_rebaseline = True
                        item["migration_reason"] = "html_comparison_hash_version"

            extractor_rebaseline = should_rebaseline_extractor(old, item)
            extraction_drift = not extractor_rebaseline and is_extraction_drift(old, item)
            if extractor_rebaseline:
                item["migration_reason"] = "extractor_version"
            elif extraction_drift:
                item["migration_reason"] = "extraction_drift"
            event_type, migrated = classify_change(
                old, item,
                force_baseline_migration=extractor_rebaseline or extraction_drift or html_signature_rebaseline,
            )
            # A not-material review of a markup-only event is a durable choice
            # for this monitored URL.  Keep the current snapshot/fingerprint so
            # genuine extracted-text changes still alert, but do not reopen the
            # same cosmetic HTML churn on every subsequent fetch.
            if event_type == "HTML_SOURCE_CHANGED" and canonical(url) in suppressed_markup_urls:
                event_type = "UNCHANGED_URL"
            # A screenshot of this render (visual_compare monitors): stored, and
            # compared with the last one. On its own a visual difference raises
            # VISUAL_CHANGED only above the monitor's threshold.
            visual_block = None
            shot = take_screenshot(uid)
            if shot is not None and source.visual_compare:
                visual_block = apply_visual(uid, shot, old, item, now, dry_run)
                threshold = source.visual_alert_threshold
                if (event_type == "UNCHANGED_URL" and not migrated and visual_block and threshold
                        and visual_block["changed_ratio"] >= threshold):
                    event_type = "VISUAL_CHANGED"
            if event_type == "NEW_URL":
                new_items.append(item)
            elif event_type == "CHANGED_URL":
                changed_items.append({"before":old,"after":item})
            elif event_type in {"HTML_SOURCE_CHANGED", "VISUAL_CHANGED"}:
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
                    elif event_type == "VISUAL_CHANGED":
                        before_hash, after_hash = (visual_block or {}).get("before_hash"), (visual_block or {}).get("after_hash")
                    else:
                        before_hash = (old or {}).get("normalized_hash") or (old or {}).get("raw_hash") or (old or {}).get("content_hash")
                        after_hash = item.get("normalized_hash")
                    event_id = change_event_id(event_type, uid, before_hash, after_hash, old)
                    evidence = None
                    codes = None
                    spec = spec_inventory = impact = None
                    if event_type in {"NEW_URL","CHANGED_URL","HTML_SOURCE_CHANGED"}:
                        before_text = old_text if old_text is not None else read_snapshot(old)
                        # Which reporting items the change added, retired or redefined
                        # (deterministic, from the full texts rather than the capped diff).
                        codes = item_codes.diff(before_text, text) if event_type == "CHANGED_URL" else None
                        # Rule, field and schema changes row by row (regmon/spec_diff.py);
                        # for a file seen for the first time, what it declares about itself.
                        spec, spec_inventory = structured_spec(event_type, before_text, text)
                        # Which registered items that touches, and what reads them.
                        impact = registry_impact(codes, spec, before_text if event_type == "CHANGED_URL" else "", text) \
                            if event_type in {"NEW_URL", "CHANGED_URL"} else None
                        evidence = (
                            _write_evidence(
                                ROOT, event_type, event_id, url, now, old, item,
                                before_text,
                                text,
                                before_html=read_html_snapshot(old),
                                after_html=html_body.decode("utf-8", "replace") if html_body is not None else None,
                                item_codes=codes,
                                spec_diff=spec,
                                spec_inventory=spec_inventory,
                                impact=impact,
                                visual=visual_block,
                            )
                            if not dry_run
                            else None
                        )
                        item["evidence_location"] = evidence
                        current[uid] = item
                    elif event_type == "VISUAL_CHANGED":
                        evidence = (
                            _write_evidence(ROOT, event_type, event_id, url, now, old, item, None, None, visual=visual_block)
                            if not dry_run else None
                        )
                        item["evidence_location"] = evidence
                        current[uid] = item
                    event = {"event_id":event_id,"event_type":event_type,"url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":item}}
                    codes_summary = item_codes.summary(codes)
                    if codes_summary:
                        event["item_codes"] = codes_summary
                    spec_summary = spec_diff.summary(spec) or spec_diff.inventory_summary(spec_inventory)
                    if spec_summary:
                        event["spec"] = spec_summary
                    impact_summary = registry.summary(impact)
                    if impact_summary:
                        event["impact"] = impact_summary
                    if item.get("migration_reason"):
                        event["migration_reason"] = item["migration_reason"]
                    if visual_block:
                        event["visual"] = {"changed_ratio": visual_block["changed_ratio"], "region_count": visual_block["region_count"]}
                    if event_type in {"NEW_URL", "CHANGED_URL", "HTML_SOURCE_CHANGED", "VISUAL_CHANGED"}:
                        record_change(item, event)
                        current[uid] = item
                    events.append(event)

    removed_items = []
    removal_guard = None
    removal_pending = []
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
        if missing and discovery.get("method") == "stealth" and not allow_mass_removal:
            # Browser-only discovery depends on JavaScript rendering and timing,
            # so a page it failed to surface once is not proof of removal. Hold
            # the record (marked missing_since) and report REMOVED_URL only if a
            # second consecutive complete browser crawl still misses it. A page
            # that reappears is rebuilt from base_item, which drops the marker.
            confirmed = []
            for uid, old in missing:
                if old.get("missing_since"):
                    confirmed.append((uid, old))
                    continue
                held = dict(old)
                held["missing_since"] = now
                current[uid] = held
                removal_pending.append(uid)
            missing = confirmed
        for uid, old in missing:
            removed_items.append(old)
            url = old.get("canonical_url","")
            event_id = change_event_id("REMOVED_URL", uid, old.get("normalized_hash") or old.get("raw_hash") or old.get("content_hash"), None, old)
            evidence = (
                _write_evidence(ROOT, "REMOVED_URL", event_id, url, now, old, None, read_snapshot(old), None)
                if not dry_run
                else None
            )
            events.append({"event_id":event_id,"event_type":"REMOVED_URL","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":None}})

    new_ids = {item["url_id"] for item in new_items}
    changed_ids = {entry["after"]["url_id"] for entry in changed_items}
    # A parser-only re-baseline (extractor upgrade or extraction drift) changes
    # the normalized text of a page whose AI work is still pending. The pending
    # change is the same; re-key it to the new text so it is resumed with its
    # original event instead of going stale and later re-emitting a CHANGED_URL
    # for unchanged content.
    for entry in migration_items:
        item = entry["after"]
        pending = item.get("ai_pending")
        if isinstance(pending, dict) and pending.get("after_hash") != item.get("normalized_hash"):
            pending = dict(pending)
            pending["after_hash"] = item.get("normalized_hash")
            pending["rekeyed_at"] = now
            item["ai_pending"] = pending
            current[item["url_id"]] = item
    backlog_items = unchanged_items + [
        entry["after"] for entry in migration_items + source_changed_items
        if isinstance(entry["after"].get("ai_pending"), dict)
    ]
    candidate_pool = build_ai_candidate_pool(
        new_items, changed_items, backlog_items, initial_baseline=initial_baseline
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
                else change_event_id(event, item["url_id"], before_hash, item.get("normalized_hash"), old_item)
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
                "before_snapshot_location": old_item.get("snapshot_location") if event == "CHANGED_URL" else None,
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
        old_text = None
        if event == "CHANGED_URL":
            # A change resumed from the backlog must be diffed against the text
            # from BEFORE the change. The previous inventory record already holds
            # the changed text, so diffing against it gave the AI an empty diff
            # and only the current document (it never saw what changed).
            pending = item.get("ai_pending")
            resumed = isinstance(pending, dict) and item["url_id"] not in changed_ids
            if resumed:
                before_location = pending.get("before_snapshot_location")
                if not before_location and pending.get("before_hash"):
                    before_location = f"data/snapshots/{item['url_id']}-{pending['before_hash']}.txt"
                old_text = read_snapshot({"snapshot_location": before_location}) if before_location else None
            else:
                old_text = read_snapshot(previous.get(item["url_id"]))
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
                else change_event_id(
                    event,
                    item["url_id"],
                    (previous.get(item["url_id"]) or {}).get("normalized_hash"),
                    item.get("normalized_hash"),
                    previous.get(item["url_id"]),
                )
            )
        result = {
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
                condition=source.alert_condition,
            ),
        }
        if source.alert_condition:
            # Recorded with the result so the notifier and dashboard apply the
            # condition that was actually judged, not a later edit of it.
            result["alert_condition"] = source.alert_condition
            result["alert_only_on_condition"] = source.alert_only_on_condition
        return result

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
                                    change_event_id(
                                        event, item["url_id"],
                                        old_item.get("normalized_hash") or old_item.get("raw_hash") or old_item.get("content_hash"),
                                        item.get("normalized_hash"),
                                        old_item,
                                    )
                                ),
                                "timestamp": event_record.get("timestamp") if event_record else now,
                                "evidence_location": (
                                    result.get("evidence_location")
                                    or (event_record.get("evidence_location") if event_record else None)
                                    or item.get("evidence_location")
                                ),
                                "before_hash": old_item.get("normalized_hash") or old_item.get("raw_hash") or old_item.get("content_hash"),
                                "before_snapshot_location": old_item.get("snapshot_location") if event == "CHANGED_URL" else None,
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
                            else change_event_id(
                                event, item["url_id"],
                                (previous.get(item["url_id"]) or {}).get("normalized_hash"),
                                item.get("normalized_hash"),
                                previous.get(item["url_id"]),
                            )
                        )
                    ai_results.append({"event":event,"event_id":event_id,"url":item["canonical_url"],"source_id":source.id,"evidence_location":item.get("evidence_location"),"ai":{"status":"error","reason":str(exc)}})

    attach_ai_to_history(current, ai_results)

    # Translations are reading aids written after detection; a failure never fails the scan.
    try:
        translation_counts = translate.translate_pass(current, now, ROOT, DEFAULTS, priority=new_ids | changed_ids, dry_run=dry_run)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Translation pass skipped: {type(exc).__name__}: {exc}")
        translation_counts = {}

    counts = {
        "discovered":len(current),
        "new":len(new_items),
        "changed":len(changed_items),
        "source_changed":len(source_changed_items),
        "visual_changed":sum(1 for event in events if event.get("event_type") == "VISUAL_CHANGED"),
        "removed":len(removed_items),
        "removal_held":removal_guard["held_removals"] if removal_guard else 0,
        "removal_pending_confirmation":len(removal_pending),
        "unchanged":len(unchanged_items),
        "baseline_migration":len(migration_items),
        "extraction_drift":sum(1 for entry in migration_items if entry["after"].get("migration_reason") == "extraction_drift"),
        "fetch_error":sum(1 for x in current.values() if x.get("fetch_error")),
        "extraction_error":sum(1 for x in current.values() if x.get("extraction_error")),
        "extraction_truncated":sum(1 for x in current.values() if x.get("extraction_truncated")),
        "not_modified":sum(1 for x in current.values() if x.get("not_modified")),
        "fetch_held":sum(1 for x in current.values() if isinstance(x.get("fetch_warning"), dict)),
        "fetch_recovered_on_recheck":sum(1 for x in current.values() if x.get("recovered_on_recheck")),
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
        **translation_counts,
    }
    return {
        "report":{
            "schema_version":2,"run_id":run_id,"generated_at":now,
            "source":{"id":source.id,"name":source.name,"regulator":source.regulator,"seeds":list(source.seed_urls),"allowed_prefixes":list(source.allowed_prefixes),"initial_baseline":initial_baseline,**({"shadow":True} if source.shadow else {})},
            "discovery":discovery,
            "removal_guard":removal_guard,
            "baseline_update_allowed":discovery.get("state") == "COMPLETE",
            "change_detector":{"raw_hash":"SHA-256 retrieved response bytes","html_hash":"SHA-256 of the saved HTML snapshot; when only volatile Cloudflare tokens changed, the previous equivalent snapshot is reused (raw_hash is always this response)", "html_comparison_hash":"Versioned HTML signature; known Cloudflare challenge tokens and pageConfig.cacheBuster are normalized","html_comparison_hash_version":HTML_COMPARISON_HASH_VERSION,"normalized_hash":"SHA-256 extracted normalized content","classification_hash":"normalized_hash with separate HTML_SOURCE_CHANGED events","http_validators":"ETag/Last-Modified used only for conditional fetch optimization"},
            "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
            "ai_contract":{"required_keys":["relevant","topic","change_type","summary","impact","effective_date","affected_scope","actions","reason"],"strict":True},
            "counts":counts,"events":events,"new_urls":[] if initial_baseline else new_items,"changed_urls":changed_items,"source_changed_urls":source_changed_items,"removed_urls":removed_items,"baseline_migrations":migration_items,"ai_results":sorted(ai_results,key=lambda x:x.get("event_id",""))
        },
        "inventory":current,
        "link_observations":link_observations,
    }

def _active_source_reports(exclude: set[str]) -> list[dict]:
    """Latest saved per-source reports for active sources not run this time."""
    try:
        _payload, sources = load_config()
    except Exception:
        return []
    reports = []
    for sid, source in sources.items():
        if not source.active or sid in exclude:
            continue
        path = REPORTS / f"{sid}.json"
        if not path.exists():
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(report, dict) and report.get("source", {}).get("id") == sid:
            reports.append(report)
    return reports


def _sort_events(events: list[dict]) -> list[dict]:
    # Thread completion order made identical runs reorder their reports.
    return sorted(events, key=lambda e: (str(e.get("url") or ""), str(e.get("event_type") or ""), str(e.get("event_id") or "")))


def run_trigger(environ: dict | None = None) -> dict:
    """What started this run, so the dashboard can tell scheduled scans from manual ones.

    GitHub sets GITHUB_EVENT_NAME for every Actions job. A paused crawl re-dispatches
    itself with the workflow token, so a dispatch by github-actions[bot] is a
    continuation slice rather than a person pressing "Run workflow".
    """
    env = os.environ if environ is None else environ
    event = str(env.get("GITHUB_EVENT_NAME") or "")
    if event == "schedule":
        trigger = "scheduled"
    elif event == "workflow_dispatch":
        actor = str(env.get("GITHUB_TRIGGERING_ACTOR") or env.get("GITHUB_ACTOR") or "")
        trigger = "continuation" if actor == "github-actions[bot]" else "manual"
    elif event:
        trigger = event
    else:
        trigger = "local"
    run_id = str(env.get("GITHUB_RUN_ID") or "")
    return {"trigger": trigger, "workflow_run_id": run_id if run_id.isdigit() else None}


def _aggregate_report(reports: list[dict], run_id: str, generated_at: str | None = None) -> dict:
    count_keys = set().union(*(report["counts"].keys() for report in reports))
    return {
        "schema_version":2,"run_id":run_id,
        "generated_at":generated_at or max(report["generated_at"] for report in reports),
        "sources":[report["source"] for report in reports],
        "source_runs":{report["source"]["id"]: {"run_id": report.get("run_id"), "generated_at": report.get("generated_at"), "trigger": report.get("trigger")} for report in reports},
        "counts":{k:sum(int(report["counts"].get(k,0)) for report in reports) for k in sorted(count_keys)},
        "discovery":[report.get("discovery",{}) for report in reports],
        "removal_guards":[report["removal_guard"] for report in reports if report.get("removal_guard") and report.get("run_id") == run_id],
        "baseline_update_allowed":all(report.get("baseline_update_allowed",False) for report in reports),
        "change_detector":{"classification_hash":"normalized_hash","html_hash":"SHA-256 of the saved HTML snapshot (reused when only volatile tokens changed; raw_hash is always the fetched response)", "html_comparison_hash":"Versioned HTML signature; known Cloudflare challenge tokens and pageConfig.cacheBuster are normalized","html_comparison_hash_version":HTML_COMPARISON_HASH_VERSION,"http_validators":"ETag/Last-Modified are optimization hints only"},
        "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
        "ai_contract":reports[0]["ai_contract"],
        "new_urls":[x for report in reports for x in report.get("new_urls",[])],
        "changed_urls":[x for report in reports for x in report.get("changed_urls",[])],
        "source_changed_urls":[x for report in reports for x in report.get("source_changed_urls",[])],
        "removed_urls":[x for report in reports for x in report.get("removed_urls",[])],
        "baseline_migrations":[x for report in reports for x in report.get("baseline_migrations",[])],
        "events":_sort_events([x for report in reports for x in report.get("events",[])]),
        "ai_results":[x for report in reports for x in report.get("ai_results",[])],
        "error_alert_after_runs":error_alert_after_runs(),
    }


def error_alert_after_runs() -> int:
    """Consecutive failing scans of a resource before its error alerts (default 1)."""
    try:
        return max(1, int(DEFAULTS.get("error_alert_after_runs", 1)))
    except (TypeError, ValueError):
        return 1


def _listing_page_html(url: str) -> bytes | None:
    """One listing page, read for its links: a plain request on the page's own host.

    Not a monitor: one attempt, no browser, and a bot check or a document is
    skipped (its links stay as last recorded).
    """
    host = urlsplit(url).hostname or ""
    result = fetch(url, timeout=min(20, int(DEFAULTS.get("fetch_timeout_seconds", 30))), attempts=1,
                   allowed_domains=(host,), max_bytes=8 * 1024 * 1024, browser_headers=True)
    if result.status_code != 200 or "html" not in str(result.content_type or "").lower() or result.challenge:
        return None
    if botcheck.detect(result.body, result.status_code, None):
        return None
    return result.body


def _listing_page_observations(source_results: list[dict], already_read: set[str]) -> list[dict]:
    ids = {str(result["report"]["source"]["id"]) for result in source_results}
    try:
        _, sources = load_config()
    except Exception as exc:
        print(f"Link lineage: listing pages skipped: {type(exc).__name__}: {exc}")
        return []
    pages = link_lineage.listing_pages([source for sid, source in sources.items() if sid in ids and source.active], already_read)
    if not pages:
        return []
    observations = link_lineage.read_listing_pages(pages, _listing_page_html, datetime.now(timezone.utc).isoformat())
    print(f"Link lineage: read {len(observations)} of {len(pages)} listing page(s)")
    return observations


def save_outputs(source_results: list[dict], run_id: str, dry_run: bool=False, not_due: list[dict] | None = None) -> dict:
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
        report["events"] = _sort_events(report.get("events", []))
        sid = report["source"]["id"]
        if report.get("baseline_update_allowed"):
            payload["sources"][sid] = result["inventory"]
        origin = run_trigger()
        report.setdefault("trigger", origin["trigger"])
        report.setdefault("workflow_run_id", origin["workflow_run_id"])
        atomic_write_text(REPORTS / f"{sid}.json", json.dumps(report,indent=2))
        history.append({"run_id":report["run_id"],"generated_at":report["generated_at"],"source_id":sid,"regulator":report["source"]["regulator"],
                        "trigger":report["trigger"],"workflow_run_id":report["workflow_run_id"],"counts":report["counts"]})
    # Keep the newest N entries PER SOURCE. A global cap of N x (sources in this
    # run) truncated the other sources' history on every single-source run.
    history.sort(key=lambda x:x.get("generated_at",""),reverse=True)
    per_source_limit = int(DEFAULTS.get("history_runs",90))
    kept, seen_per_source = [], {}
    for entry in history:
        sid = str(entry.get("source_id"))
        seen_per_source[sid] = seen_per_source.get(sid, 0) + 1
        if seen_per_source[sid] <= per_source_limit:
            kept.append(entry)
    atomic_write_text(history_path, json.dumps(kept,indent=2))

    # report.json is the latest state of EVERY active source: sources not run
    # this time contribute their last saved report, so a single-source run no
    # longer makes the dashboard report the other sources as missing. The
    # per-run history file keeps only what this run produced.
    reports = [r["report"] for r in source_results]
    carried = _active_source_reports({report["source"]["id"] for report in reports})
    all_reports = reports + carried
    aggregate = _aggregate_report(all_reports, run_id, generated_at=max(report["generated_at"] for report in reports))
    aggregate["trigger"] = run_trigger()["trigger"]
    # Which active sources this run scanned and which were left for a later run
    # because their cadence did not make them due.
    run_schedule = {
        "scanned": sorted(report["source"]["id"] for report in reports),
        "not_due": sorted(not_due or [], key=lambda entry: entry["source_id"]),
    }
    aggregate["schedule"] = run_schedule
    # The aggregate report (what the notifier reads) is written BEFORE the new
    # baseline. Interrupted between the two, the change is still un-baselined
    # and the next scan re-detects it under the same event ID; the reverse
    # order could advance the baseline with no report to alert from.
    atomic_write_text(DATA / "report.json", json.dumps(aggregate,indent=2))
    atomic_write_text(latest_path, json.dumps(payload,indent=2))
    run_report = _aggregate_report(reports, run_id)
    run_report["schedule"] = run_schedule
    atomic_write_text(HISTORY / f"{run_id}.json", json.dumps(run_report, indent=2))
    aggregate_counts = aggregate["counts"]
    md = ["# Regulatory Monitoring Report","",f"Run: {run_id}",f"Generated: {aggregate['generated_at']}","","## Aggregate counts","","| Metric | Value |","| --- | ---: |"]
    md += [f"| {k} | {v} |" for k,v in aggregate_counts.items()]
    md += ["","## Sources",""]
    for report in all_reports:
        c=report["counts"]; src=report["source"]
        md += [f"### {src['name']}","",f"- Regulator: {src['regulator']}",f"- Report run: {report.get('run_id')} ({report.get('generated_at')})",f"- Discovered: {c.get('discovered',0)}",f"- Changed content: {c.get('changed',0)}",f"- HTML source-only changes: {c.get('source_changed',0)}",f"- New: {c.get('new',0)}",f"- Removed: {c.get('removed',0)}",f"- Fetch errors: {c.get('fetch_error',0)}", ""]
    atomic_write_text(DATA / "report.md", "\n".join(md))
    # Which page lists which link, and when links leave a page (data/link-lineage.json).
    # Only sources whose crawl completed are trusted; never allowed to fail a scan.
    # The pages the scanned monitors' links are listed on (listed_on) are read
    # for their links too, and monitored pages missing from the record are
    # seeded from their saved copies, so every monitor has a lineage without
    # anyone running a command.
    try:
        observations = [observation for result in source_results if result["report"].get("baseline_update_allowed")
                        for observation in result.get("link_observations") or []]
        observations += _listing_page_observations(source_results, {str(o.get("page")) for o in observations})
        if observations:
            link_lineage.apply(DATA, observations)
        link_lineage.backfill(DATA)
    except Exception as exc:
        print(f"Link lineage not updated: {type(exc).__name__}: {exc}")
    # Dates stated in detected changes, as data/calendar.json and a subscribable
    # .ics feed. Rebuilt from the committed records; never allowed to fail a scan.
    try:
        deadlines.write(DATA, DEFAULT_CONFIG_PATH)
    except Exception as exc:
        print(f"Regulatory calendar not rebuilt: {type(exc).__name__}: {exc}")
    # Fleet health ledger (failing, stale, inactive and year-stamped monitors,
    # check and alert volumes). Derived from committed state; never fails a scan.
    try:
        health.write(DATA, DEFAULT_CONFIG_PATH)
    except Exception as exc:
        print(f"Fleet health ledger not rebuilt: {type(exc).__name__}: {exc}")
    return {"dry_run":False,"sources":[r["report"]["source"]["id"] for r in source_results],"run_id":run_id}

def last_scan_at(source_id: str, reports_dir: Path | None = None) -> datetime | None:
    """When this source's last report was saved, from data/reports/<id>.json."""
    path = (reports_dir or REPORTS) / f"{source_id}.json"
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(report, dict) or (report.get("source") or {}).get("id") != source_id:
        return None
    return schedule.parse_time(report.get("generated_at"))


def due_sources(
    sources: list[SourceConfig], now: datetime, data_dir: Path | None = None
) -> tuple[list[SourceConfig], list[dict]]:
    """Split active sources into those a scheduled run should scan and those not due yet.

    A source whose discovery is paused mid-crawl, or that has never been
    scanned, is always due.
    """
    data_dir = data_dir or DATA
    due, waiting = [], []
    for source in sources:
        cadence = schedule.Cadence.from_source(source)
        last = last_scan_at(source.id, data_dir / "reports")
        paused = str(load_discovery_metadata(source.id, data_dir).get("state") or "").upper() == "PAUSED"
        if schedule.is_due(cadence, last, now, paused=paused):
            due.append(source)
        else:
            waiting.append({
                "source_id": source.id,
                "cadence": cadence.describe(),
                "last_scan": last.isoformat() if last else None,
                "next_due": schedule.next_due(cadence, last, now).isoformat(),
            })
    return due, waiting


def run(source_id: str="all", dry_run: bool=False, due_only: bool=False, now: datetime | None = None) -> dict:
    _, sources = load_config()
    selected = [source for source in sources.values() if source.active] if source_id in {"all","*"} else [sources[source_id]]
    if not selected:
        raise ValueError("No active monitoring sources are configured")
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    waiting: list[dict] = []
    if due_only and source_id in {"all", "*"}:
        selected, waiting = due_sources(selected, now or datetime.now(timezone.utc))
        print(f"Scan cadence: {len(selected)} source(s) due, {len(waiting)} not due yet")
        if not selected:
            # Nothing is due: no state is written, so the next due run still sees
            # the same last-scan times.
            return {"run_id": run_id, "results": [], "outcome": {"dry_run": dry_run, "sources": [], "not_due": waiting}}
    # Learned Docling timeouts are read on every run; dry runs never write them back.
    configure_timeout_registry(DATA / "docling-timeouts.json", persist=not dry_run)

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

    outcome = save_outputs(results, run_id, dry_run=dry_run, not_due=waiting)
    if waiting:
        outcome["not_due"] = waiting
    return {"run_id":run_id,"results":results,"outcome":outcome}

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",default=os.getenv("REGMON_SOURCE","all"))
    parser.add_argument("--dry-run",action="store_true")
    parser.add_argument("--due-only",action="store_true",
                        help="With --source all, scan only the sources whose cadence makes them due (scheduled runs)")
    args=parser.parse_args()
    result=run(args.source,args.dry_run,due_only=args.due_only)
    print(json.dumps({"run_id":result["run_id"],"sources":args.source,"outcome":result["outcome"]},indent=2))

if __name__ == "__main__":
    main()
