"""Deterministic change classification and immutable evidence."""
from __future__ import annotations
import difflib
import hashlib
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

MAX_DIFF_LINES = 200
MAX_HTML_DIFF_LINES = 1000

def make_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


# Cloudflare's JavaScript-detection challenge injects per-response Ray IDs and
# encoded timestamps into an inline script. They change on virtually every
# request but carry no page-content meaning. Stabilize only those two fields;
# retain the rest of the HTML signature so real source/DOM changes are visible.
_CF_CV_PARAMS = re.compile(r"window\.__CF\$cv\$params\s*=\s*\{[^}]*\}", re.DOTALL)


def html_comparison_hash(value: str | bytes | None) -> str | None:
    """Hash HTML after stabilizing Cloudflare's per-response challenge tokens.

    Raw HTML remains preserved for snapshots and evidence. This comparison
    signature prevents rotating Ray IDs/timestamps from creating false
    HTML_SOURCE_CHANGED events while retaining other source differences.
    """
    if value is None:
        return None
    html = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)

    def stabilize_params(match: re.Match[str]) -> str:
        block = match.group(0)
        block = re.sub(
            r"(?<![\w$])r\s*:\s*(['"])[^'"]*\1",
            lambda item: "r:'<volatile-ray-id>'",
            block,
            count=1,
        )
        block = re.sub(
            r"(?<![\w$])t\s*:\s*(['"])[^'"]*\1",
            lambda item: "t:'<volatile-timestamp>'",
            block,
            count=1,
        )
        return block

    stable_html = _CF_CV_PARAMS.sub(stabilize_params, html)
    return hashlib.sha256(stable_html.encode("utf-8")).hexdigest()

def classify_change(old: dict | None, current: dict) -> tuple[str, bool]:
    if old is None:
        return "NEW_URL", False
    if old.get("normalized_hash"):
        if old["normalized_hash"] != current.get("normalized_hash"):
            return "CHANGED_URL", False
        old_html = old.get("html_comparison_hash") or old.get("html_hash")
        new_html = current.get("html_comparison_hash") or current.get("html_hash")
        if old_html and new_html and old_html != new_html:
            return "HTML_SOURCE_CHANGED", False
        return "UNCHANGED_URL", False
    legacy = old.get("raw_hash") or old.get("content_hash")
    return ("UNCHANGED_URL", True) if legacy == current.get("raw_hash") else ("BASELINE_MIGRATION", True)

def make_diff(before_text: str | None, after_text: str | None, max_lines: int = MAX_DIFF_LINES) -> str:
    lines = list(difflib.unified_diff((before_text or "").splitlines(), (after_text or "").splitlines(), fromfile="before", tofile="after", lineterm=""))
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... diff truncated after {max_lines} lines"]
    return "\n".join(lines)

def _format_html_for_diff(value: str | None) -> str:
    if not value:
        return ""
    try:
        return BeautifulSoup(value, "html.parser").prettify()
    except Exception:
        return value

def build_event_id(
    event_type: str,
    url_id: str,
    before_hash: str | None = None,
    after_hash: str | None = None,
    error: str | None = None,
    observation_id: str | None = None,
) -> str:
    """Use stable IDs for change events and unique IDs for repeat observations."""
    material = "|".join([
        event_type, url_id, before_hash or "", after_hash or "", error or "",
        observation_id or "",
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()

def write_evidence(
    root: Path,
    event_type: str,
    event_id: str,
    url: str,
    timestamp: str,
    before_record: dict | None,
    after_record: dict | None,
    before_text: str | None,
    after_text: str | None,
    error: str | None = None,
    before_html: str | None = None,
    after_html: str | None = None,
) -> str:
    path = root / "data" / "evidence" / f"{event_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Evidence is append-only. Repeated operational observations use unique IDs.
    if path.exists():
        return str(path.relative_to(root))
    payload = {
        "event_id": event_id,
        "event_type": event_type,
        "url": url,
        "timestamp": timestamp,
        "before": {
            "normalized_hash": (before_record or {}).get("normalized_hash"),
            "raw_hash": (before_record or {}).get("raw_hash") or (before_record or {}).get("content_hash"),
            "html_hash": (before_record or {}).get("html_hash"),
            "html_comparison_hash": (before_record or {}).get("html_comparison_hash"),
            "snapshot_location": (before_record or {}).get("snapshot_location"),
            "html_snapshot_location": (before_record or {}).get("html_snapshot_location"),
        },
        "after": {
            "normalized_hash": (after_record or {}).get("normalized_hash"),
            "raw_hash": (after_record or {}).get("raw_hash") or (after_record or {}).get("content_hash"),
            "html_hash": (after_record or {}).get("html_hash"),
            "html_comparison_hash": (after_record or {}).get("html_comparison_hash"),
            "snapshot_location": (after_record or {}).get("snapshot_location"),
            "html_snapshot_location": (after_record or {}).get("html_snapshot_location"),
        },
        "diff": make_diff(before_text, after_text),
        "html_diff": make_diff(_format_html_for_diff(before_html), _format_html_for_diff(after_html), MAX_HTML_DIFF_LINES)
            if before_html is not None or after_html is not None else "",
        "html_diff_note": "The source diff is a formatted DOM-level diff. The separately saved .html snapshot preserves the fetched response body.",
    }
    if error:
        payload["error"] = error
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path.relative_to(root))
