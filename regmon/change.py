"""Deterministic change classification and immutable evidence."""
from __future__ import annotations
import difflib
import itertools
import hashlib
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

from regmon.fsutil import atomic_write_text

MAX_DIFF_LINES = 200
MAX_HTML_DIFF_LINES = 1000

# Version the HTML signature algorithm so old snapshots can be re-hashed before
# comparing them with signatures that normalize the pageConfig cache-buster.
# Version 3 also stabilizes per-request CMS tokens (Drupal view DOM ids and form
# build ids, ASP.NET view state, CSRF tokens, script nonces).
HTML_COMPARISON_HASH_VERSION = 3

def make_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


# Some sites put a per-request timestamp in a dedicated cache-buster config
# field. It is transport/cache metadata rather than page content. Stabilize only
# known volatile fields (not arbitrary timestamps or query strings), preserving
# every other source byte in the comparison signature.
_CF_CV_PARAMS = re.compile(r"window\.__CF\$cv\$params\s*=\s*\{[^}]*\}", re.DOTALL)
_PAGE_CACHE_BUSTER = re.compile(
    r"(\bpageConfig\s*\.\s*cacheBuster\s*=\s*)(['\"])[^'\"]*\2",
    re.IGNORECASE,
)


# Per-request values that content-management frameworks write into otherwise
# identical pages. Each pattern replaces only the token value, never the element
# or its other attributes, so any real markup difference still changes the hash.
# Evidence (25 Oct 2026): an OSFI Drupal page produced a new HTML_SOURCE_CHANGED
# event and a new snapshot on every fetch because of js-view-dom-id-<64 hex>.
_DRUPAL_VIEW_DOM_ID = re.compile(r"\b(js-view-dom-id-)[0-9a-f]{32,}\b")
_DRUPAL_VIEW_DOM_ID_SETTING = re.compile(r"""(["']view_dom_id["']\s*:\s*["'])[0-9a-f]{32,}(["'])""")
_DRUPAL_FORM_ID_ATTRIBUTE = re.compile(
    r"""(\b(?:value|id|data-drupal-selector)\s*=\s*["'])form-[A-Za-z0-9_-]{20,}(["'])"""
)
VOLATILE_INPUT_NAMES = frozenset({
    "form_build_id", "form_token", "__viewstate", "__viewstategenerator", "__eventvalidation",
    "__requestverificationtoken", "csrf_token", "csrfmiddlewaretoken", "authenticity_token", "_token",
})
VOLATILE_META_NAMES = frozenset({"csrf-token", "csrf-param", "_csrf", "_csrf_header"})
_INPUT_TAG = re.compile(r"<input\b[^>]*>", re.IGNORECASE)
_META_TAG = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_NAME_ATTRIBUTE = re.compile(r"""\bname\s*=\s*["']([^"']*)["']""", re.IGNORECASE)
_VALUE_ATTRIBUTE = re.compile(r"""(\bvalue\s*=\s*)(["'])[^"']*\2""", re.IGNORECASE)
_CONTENT_ATTRIBUTE = re.compile(r"""(\bcontent\s*=\s*)(["'])[^"']*\2""", re.IGNORECASE)
_NONCE_ATTRIBUTE = re.compile(r"""(\bnonce\s*=\s*)(["'])[^"']*\2""", re.IGNORECASE)


def _stabilize_tag(pattern: re.Pattern[str], names: frozenset[str], value: re.Pattern[str], html: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tag = match.group(0)
        name = _NAME_ATTRIBUTE.search(tag)
        if not name or name.group(1).strip().lower() not in names:
            return tag
        return value.sub(lambda item: item.group(1) + item.group(2) + "<volatile>" + item.group(2), tag, count=1)

    return pattern.sub(replace, html)


def stabilize_volatile_markup(html: str) -> str:
    """Replace known per-request CMS tokens with fixed placeholders (version 3)."""
    html = _DRUPAL_VIEW_DOM_ID.sub(lambda match: match.group(1) + "<volatile>", html)
    html = _DRUPAL_VIEW_DOM_ID_SETTING.sub(lambda match: match.group(1) + "<volatile>" + match.group(2), html)
    html = _DRUPAL_FORM_ID_ATTRIBUTE.sub(lambda match: match.group(1) + "form-<volatile>" + match.group(2), html)
    html = _stabilize_tag(_INPUT_TAG, VOLATILE_INPUT_NAMES, _VALUE_ATTRIBUTE, html)
    html = _stabilize_tag(_META_TAG, VOLATILE_META_NAMES, _CONTENT_ATTRIBUTE, html)
    return _NONCE_ATTRIBUTE.sub(lambda match: match.group(1) + match.group(2) + "<volatile>" + match.group(2), html)


def html_comparison_hash(value: str | bytes | None) -> str | None:
    """Hash HTML after stabilizing specifically identified volatile fields.

    Raw HTML remains preserved for snapshots and evidence. The comparison
    signature ignores known Cloudflare challenge tokens, the pageConfig
    cache-buster assignment and per-request CMS tokens (stabilize_volatile_markup),
    preventing transport-only churn from creating false HTML_SOURCE_CHANGED
    events while retaining other source differences.
    """
    if value is None:
        return None
    html = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)

    def stabilize_params(match: re.Match[str]) -> str:
        block = match.group(0)
        block = re.sub(
            r"""(?<![\w$])r\s*:\s*(['"])[^'"]*\1""",
            lambda item: "r:'<volatile-ray-id>'",
            block,
            count=1,
        )
        block = re.sub(
            r"""(?<![\w$])t\s*:\s*(['"])[^'"]*\1""",
            lambda item: "t:'<volatile-timestamp>'",
            block,
            count=1,
        )
        return block

    stable_html = _CF_CV_PARAMS.sub(stabilize_params, html)
    stable_html = _PAGE_CACHE_BUSTER.sub(
        lambda match: match.group(1) + match.group(2) + "<volatile-cache-buster>" + match.group(2),
        stable_html,
    )
    stable_html = stabilize_volatile_markup(stable_html)
    return hashlib.sha256(stable_html.encode("utf-8")).hexdigest()

def classify_change(
    old: dict | None,
    current: dict,
    *,
    force_baseline_migration: bool = False,
) -> tuple[str, bool]:
    if old is None:
        return "NEW_URL", False
    # A parser upgrade can change normalized text without changing the source
    # bytes. Rebaseline that output without reporting a regulatory change.
    if force_baseline_migration:
        return "BASELINE_MIGRATION", True
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
    # Stop reading the generator once the cap is reached instead of building the
    # whole diff of a large document and discarding most of it.
    produced = difflib.unified_diff((before_text or "").splitlines(), (after_text or "").splitlines(), fromfile="before", tofile="after", lineterm="")
    lines = list(itertools.islice(produced, max_lines + 1))
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


def change_event_id(
    event_type: str,
    url_id: str,
    before_hash: str | None,
    after_hash: str | None,
    previous_record: dict | None,
) -> str:
    """The ID of one occurrence of a content transition.

    A pure (type, before, after) hash repeats when a page flips A->B->A->B: the
    third change reused the first change's ID, so its evidence was never
    written, it vanished from the timeline and the notification ledger treated
    it as already sent. Chaining on the newest entry of the URL's timeline makes
    every occurrence distinct while staying deterministic: a run that crashes
    before the baseline advances re-derives the same ID on the next scan, so
    retries still de-duplicate. A URL with no timeline yet (its first event)
    keeps the original formula, so existing IDs are unchanged.
    """
    history = (previous_record or {}).get("change_history") or []
    head = history[0].get("event_id") if history and isinstance(history[0], dict) else None
    if not head:
        return build_event_id(event_type, url_id, before_hash, after_hash)
    return build_event_id(event_type, url_id, before_hash, after_hash, observation_id="after:" + str(head))

_HTTP_STATUS = re.compile(r"\bHTTP (\d{3})\b")


def error_signature(kind: str, message: str | None) -> str:
    """Reduce an operational error to a stable class for alert de-duplication.

    Messages often embed volatile detail (object addresses, retry counts), so
    only the exception class and any HTTP status are kept. Two runs failing for
    the same reason produce the same signature; a different failure does not.
    """
    text = str(message or "")
    exception = text.split(":", 1)[0].strip() if ":" in text else text.strip()[:80]
    status = _HTTP_STATUS.search(text)
    return "|".join([kind, exception, status.group(1) if status else ""])


def operational_notification_id(url_id: str, signature: str, since: str) -> str:
    """One notification identity per error episode (URL + error class + onset)."""
    material = "|".join(["OPERATIONAL_ALERT", url_id, signature, since])
    return "op-" + hashlib.sha256(material.encode("utf-8")).hexdigest()


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
    max_diff_lines: int = MAX_DIFF_LINES,
    item_codes: dict | None = None,
    spec_diff: dict | None = None,
    spec_inventory: dict | None = None,
    impact: dict | None = None,
    visual: dict | None = None,
    predecessor: dict | None = None,
) -> str:
    path = root / "data" / "evidence" / f"{event_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Evidence is append-only. Repeated operational observations use unique IDs.
    # A file left truncated by an older non-atomic write is not evidence: it is
    # rewritten once instead of being kept forever as corrupt JSON.
    if path.exists():
        try:
            json.loads(path.read_text(encoding="utf-8"))
            return str(path.relative_to(root))
        except (OSError, ValueError):
            pass
    payload = {
        "event_id": event_id,
        "event_type": event_type,
        "url": url,
        "timestamp": timestamp,
        "before": {
            "normalized_hash": (before_record or {}).get("normalized_hash"),
            "extraction_type": (before_record or {}).get("extraction_type"),
            "extractor_version": (before_record or {}).get("extractor_version"),
            "extraction_failed": bool((before_record or {}).get("extraction_error")),
            "raw_hash": (before_record or {}).get("raw_hash") or (before_record or {}).get("content_hash"),
            "html_hash": (before_record or {}).get("html_hash"),
            "html_comparison_hash": (before_record or {}).get("html_comparison_hash"),
            "snapshot_location": (before_record or {}).get("snapshot_location"),
            "html_snapshot_location": (before_record or {}).get("html_snapshot_location"),
            "file_snapshot_location": (before_record or {}).get("file_snapshot_location"),
            "visual_snapshot_location": (before_record or {}).get("visual_snapshot_location"),
        },
        "after": {
            "normalized_hash": (after_record or {}).get("normalized_hash"),
            "extraction_type": (after_record or {}).get("extraction_type"),
            "extractor_version": (after_record or {}).get("extractor_version"),
            "extraction_failed": bool((after_record or {}).get("extraction_error")),
            "raw_hash": (after_record or {}).get("raw_hash") or (after_record or {}).get("content_hash"),
            "html_hash": (after_record or {}).get("html_hash"),
            "html_comparison_hash": (after_record or {}).get("html_comparison_hash"),
            "snapshot_location": (after_record or {}).get("snapshot_location"),
            "html_snapshot_location": (after_record or {}).get("html_snapshot_location"),
            "file_snapshot_location": (after_record or {}).get("file_snapshot_location"),
            "visual_snapshot_location": (after_record or {}).get("visual_snapshot_location"),
        },
        "diff": make_diff(before_text, after_text, max_diff_lines),
        "html_diff": make_diff(_format_html_for_diff(before_html), _format_html_for_diff(after_html), MAX_HTML_DIFF_LINES)
            if before_html is not None or after_html is not None else "",
        "html_diff_note": "The source diff is a formatted DOM-level diff. The separately saved .html snapshot preserves the fetched response body.",
    }
    if error:
        payload["error"] = error
    if item_codes:
        payload["item_codes"] = item_codes
    if spec_diff:
        payload["spec_diff"] = spec_diff
    if spec_inventory:
        payload["spec_inventory"] = spec_inventory
    if impact:
        payload["impact"] = impact
    if visual:
        payload["visual"] = visual
    if predecessor:
        # A new URL read against the file it succeeds: "before" is that file.
        payload["predecessor"] = predecessor
    atomic_write_text(path, json.dumps(payload, indent=2))
    return str(path.relative_to(root))
