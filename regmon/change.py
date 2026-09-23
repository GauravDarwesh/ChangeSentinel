"""Deterministic change classification and immutable evidence."""
from __future__ import annotations
import difflib
import hashlib
import json
from pathlib import Path

MAX_DIFF_LINES = 200

def make_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()

def classify_change(old: dict | None, current: dict) -> tuple[str, bool]:
    if old is None:
        return "NEW_URL", False
    if old.get("normalized_hash"):
        return ("CHANGED_URL", False) if old["normalized_hash"] != current.get("normalized_hash") else ("UNCHANGED_URL", False)
    legacy = old.get("raw_hash") or old.get("content_hash")
    return ("UNCHANGED_URL", True) if legacy == current.get("raw_hash") else ("BASELINE_MIGRATION", True)

def make_diff(before_text: str | None, after_text: str | None, max_lines: int = MAX_DIFF_LINES) -> str:
    lines = list(difflib.unified_diff((before_text or "").splitlines(), (after_text or "").splitlines(), fromfile="before", tofile="after", lineterm=""))
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... diff truncated after {max_lines} lines"]
    return "\n".join(lines)

def build_event_id(event_type: str, url_id: str, before_hash: str | None = None, after_hash: str | None = None, error: str | None = None) -> str:
    material = "|".join([event_type, url_id, before_hash or "", after_hash or "", error or ""])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()

def write_evidence(root: Path, event_type: str, event_id: str, url: str, timestamp: str, before_record: dict | None, after_record: dict | None, before_text: str | None, after_text: str | None, error: str | None = None) -> str:
    path = root / "data" / "evidence" / f"{event_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "event_id": event_id,
        "event_type": event_type,
        "url": url,
        "timestamp": timestamp,
        "before": {
            "normalized_hash": (before_record or {}).get("normalized_hash"),
            "raw_hash": (before_record or {}).get("raw_hash") or (before_record or {}).get("content_hash"),
            "snapshot_location": (before_record or {}).get("snapshot_location"),
        },
        "after": {
            "normalized_hash": (after_record or {}).get("normalized_hash"),
            "raw_hash": (after_record or {}).get("raw_hash") or (after_record or {}).get("content_hash"),
            "snapshot_location": (after_record or {}).get("snapshot_location"),
        },
        "diff": make_diff(before_text, after_text),
    }
    if error:
        payload["error"] = error
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path.relative_to(root))
