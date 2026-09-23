import difflib
import hashlib
import json
import os
import re
import subprocess
import traceback
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from regmon.relevance import triage

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SNAPSHOTS = DATA / "snapshots"
EVIDENCE = DATA / "evidence"
DATA.mkdir(exist_ok=True)
SNAPSHOTS.mkdir(exist_ok=True)
EVIDENCE.mkdir(exist_ok=True)

SEED = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-product-oversight-and-governance-arrangements-retail-banking-products?phase=consolidated"
BASE = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/"
LIMIT = 50
AI_MAX = 3
MAX_DIFF_LINES = 200
AI_REQUIRED_KEYS = {"relevant", "topic", "summary", "reason"}

# Elements that are presentation/browser noise rather than regulatory content.
REMOVE_SELECTORS = (
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "object",
    "embed",
    "nav",
    "footer",
    "aside",
    "[hidden]",
    "[aria-hidden='true']",
)

# Common CMS/UI wrappers that can change without changing the substantive page.
DYNAMIC_MARKERS = (
    "cookie",
    "consent",
    "breadcrumb",
    "social",
    "share",
    "pagination",
    "pager",
    "toolbar",
    "modal",
    "popup",
    "banner",
)

# Prefer the semantic page body when the site exposes it.
CONTENT_SELECTORS = (
    "main",
    "[role='main']",
    "article",
    "#main-content",
    "#main",
    ".main-content",
    ".region-content",
)


def canonical(url):
    url = url.split("#", 1)[0].strip()
    p = urlparse(url)
    path = p.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    return (
        p.scheme.lower()
        + "://"
        + p.netloc.lower()
        + path
        + (("?" + p.query) if p.query else "")
    )


def is_file(url):
    path = urlparse(url).path.lower()
    return path.endswith(
        (
            ".pdf",
            ".doc",
            ".docx",
            ".xls",
            ".xlsx",
            ".ppt",
            ".pptx",
            ".zip",
            ".csv",
        )
    )


def make_id(url):
    return hashlib.sha256(canonical(url).encode("utf-8")).hexdigest()


def _tag_attrs(tag):
    # BeautifulSoup normally provides a dict, but malformed HTML can yield
    # a tag with attrs=None. Treat it as an empty attribute mapping.
    return getattr(tag, "attrs", None) or {}


def should_remove(tag):
    attrs = _tag_attrs(tag)
    marker = " ".join(
        [
            str(attrs.get("id") or ""),
            *[str(value) for value in (attrs.get("class") or [])],
        ]
    ).lower()
    return any(term in marker for term in DYNAMIC_MARKERS)


def _content_container(soup):
    candidates = []
    for selector in CONTENT_SELECTORS:
        for node in soup.select(selector):
            text_length = len(node.get_text(" ", strip=True))
            if text_length:
                candidates.append((text_length, node))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return soup.body or soup


def normalize_html(html):
    """
    Extract and normalize meaningful page text so presentation-layer changes
    do not create CHANGED_URL events.

    The raw HTML representation remains available through raw_hash for audit
    and diagnostics; normalized_hash drives change classification.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup.find_all(True):
        if tag.name in {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "nav", "footer", "aside"}:
            tag.decompose()
            continue
        attrs = _tag_attrs(tag)
        if "hidden" in attrs or str(attrs.get("aria-hidden") or "").lower() == "true":
            tag.decompose()
            continue
        if should_remove(tag):
            tag.decompose()

    content = _content_container(soup)
    text = content.get_text("\n", strip=True)

    lines = []
    for line in text.splitlines():
        line = unicodedata.normalize("NFKC", line)
        line = line.replace("\u00a0", " ")
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)

    return "\n".join(lines)


def classify_change(old, current):
    """
    Return the deterministic event for a URL and whether this is a legacy
    baseline migration.

    Old POC snapshots stored content_hash (raw HTML). The first run with the
    new detector establishes normalized_hash instead of treating every raw
    HTML difference as a regulatory change.
    """
    if old is None:
        return "NEW_URL", False

    if old.get("normalized_hash"):
        if old["normalized_hash"] != current.get("normalized_hash"):
            return "CHANGED_URL", False
        return "UNCHANGED_URL", False

    legacy_raw_hash = old.get("raw_hash") or old.get("content_hash")
    if legacy_raw_hash == current.get("raw_hash"):
        return "UNCHANGED_URL", True

    return "BASELINE_MIGRATION", True


DISCOVERY_ATTEMPTS = 3
DISCOVERY_RETRY_DELAY_SECONDS = 5
DISCOVERY_TIMEOUT_SECONDS = 180


def parse_discovered_urls(output):
    urls = []
    seen = set()
    for line in output.splitlines():
        value = line.strip()
        if not value.startswith("http"):
            continue
        value = canonical(value)
        if value.startswith(BASE) and value not in seen:
            seen.add(value)
            urls.append(value)
        if len(urls) >= LIMIT:
            break
    return urls


def discover():
    cmd = ["stealth-crawler", "crawl", SEED, "--base", BASE, "--urls-only"]
    attempts_log = []

    for attempt in range(1, DISCOVERY_ATTEMPTS + 1):
        try:
            result = subprocess.run(
                cmd,
                text=True,
                capture_output=True,
                check=False,
                timeout=DISCOVERY_TIMEOUT_SECONDS,
            )
            stdout = result.stdout or ""
            stderr = result.stderr or ""
            urls = parse_discovered_urls(stdout)
            attempts_log.append(
                "\n".join(
                    [
                        f"ATTEMPT {attempt}",
                        f"EXIT_CODE={result.returncode}",
                        "STDOUT:",
                        stdout,
                        "STDERR:",
                        stderr,
                    ]
                )
            )
            if urls:
                (DATA / "stealth-output.txt").write_text(
                    "\n\n".join(attempts_log),
                    encoding="utf-8",
                )
                return urls
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout or ""
            stderr = exc.stderr or ""
            attempts_log.append(
                "\n".join(
                    [
                        f"ATTEMPT {attempt}",
                        f"TIMEOUT_AFTER_SECONDS={DISCOVERY_TIMEOUT_SECONDS}",
                        "STDOUT:",
                        stdout if isinstance(stdout, str) else stdout.decode("utf-8", "replace"),
                        "STDERR:",
                        stderr if isinstance(stderr, str) else stderr.decode("utf-8", "replace"),
                    ]
                )
            )

        if attempt < DISCOVERY_ATTEMPTS:
            import time
            time.sleep(DISCOVERY_RETRY_DELAY_SECONDS)

    (DATA / "stealth-output.txt").write_text(
        "\n\n".join(attempts_log),
        encoding="utf-8",
    )
    raise RuntimeError(
        f"No EBA URLs were discovered by Stealth Crawler after {DISCOVERY_ATTEMPTS} attempts. "
        "The crawl returned no parseable in-scope URLs; monitoring state was not updated."
    )


def load_previous():
    path = DATA / "latest.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


class HttpStatusError(requests.HTTPError):
    """Raised when the regulator returns a non-success HTTP status."""


def fetch(url):
    response = requests.get(
        url,
        timeout=30,
        headers={"User-Agent": "regulatory-monitoring-poc/1.2"},
    )
    if response.status_code >= 400:
        raise HttpStatusError(f"HTTP {response.status_code} for {url}")
    return (
        response.status_code,
        response.headers.get("content-type", ""),
        response.headers.get("content-length"),
        response.headers.get("etag"),
        response.headers.get("last-modified"),
        response.content,
        response.text,
    )

def snapshot_path(url_id):
    return SNAPSHOTS / f"{url_id}.txt"


def evidence_path(event_id):
    return EVIDENCE / f"{event_id}.json"


def read_snapshot(url_id, record=None):
    location = (record or {}).get("snapshot_location")
    path = ROOT / location if location else snapshot_path(url_id)
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def write_snapshot(url_id, text):
    path = snapshot_path(url_id)
    path.write_text(text, encoding="utf-8")
    return str(path.relative_to(ROOT))


def build_event_id(event_type, url_id, before_hash=None, after_hash=None, error=None):
    material = "|".join([event_type, url_id, before_hash or "", after_hash or "", error or ""])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def make_diff(before_text, after_text):
    diff_lines = list(difflib.unified_diff(
        (before_text or "").splitlines(),
        (after_text or "").splitlines(),
        fromfile="before",
        tofile="after",
        lineterm="",
    ))
    if len(diff_lines) > MAX_DIFF_LINES:
        diff_lines = diff_lines[:MAX_DIFF_LINES]
        diff_lines.append(f"... diff truncated after {MAX_DIFF_LINES} lines")
    return "\n".join(diff_lines)


def write_evidence(event_type, event_id, url, timestamp, before_record, after_record, before_text, after_text, error=None):
    payload = {
        "event_id": event_id,
        "event_type": event_type,
        "url": url,
        "timestamp": timestamp,
        "before": {
            "normalized_hash": (before_record or {}).get("normalized_hash"),
            "raw_hash": (before_record or {}).get("raw_hash") or (before_record or {}).get("content_hash"),
            "text": before_text,
        },
        "after": {
            "normalized_hash": (after_record or {}).get("normalized_hash"),
            "raw_hash": (after_record or {}).get("raw_hash") or (after_record or {}).get("content_hash"),
            "text": after_text,
        },
        "diff": make_diff(before_text, after_text),
    }
    if error:
        payload["error"] = error
    path = evidence_path(event_id)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path.relative_to(ROOT))


def validate_ai_analysis(value):
    if not isinstance(value, dict):
        raise ValueError("AI output must be a JSON object")
    if set(value.keys()) != AI_REQUIRED_KEYS:
        raise ValueError("AI output must contain exactly these keys: " + ", ".join(sorted(AI_REQUIRED_KEYS)))
    if not isinstance(value["relevant"], bool):
        raise ValueError("AI field relevant must be a boolean")
    for field in ("topic", "summary", "reason"):
        if not isinstance(value[field], str) or not value[field].strip():
            raise ValueError("AI field " + field + " must be a non-empty string")
    return value


def _parse_ai_json(content):
    cleaned = content.strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        lines = cleaned.splitlines()
        if len(lines) >= 3 and lines[0].strip().lower() in {"```", "```json"}:
            cleaned = "\n".join(lines[1:-1]).strip()
    return validate_ai_analysis(json.loads(cleaned))

def ai_analyse(url, page_text):
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        return {"status": "skipped", "reason": "OPENROUTER_API_KEY is not configured"}

    page_text = page_text[:10000]
    payload = {
        "model": "openrouter/free",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a regulatory monitoring assistant. "
                    "Return JSON only with exactly these keys: relevant, topic, summary, reason. "
                    "relevant must be a boolean. topic, summary, and reason must be non-empty strings. "
                    "Use only evidence in the supplied page text. Do not invent facts."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Regulator: European Banking Authority\n"
                    "URL: " + url + "\n\n"
                    "Page text:\n" + page_text
                ),
            },
        ],
    }

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/GauravDarwesh/WEB-MONITORING-CRAWLER",
            "X-Title": "EBA Regulatory Monitoring POC",
        },
        json=payload,
        timeout=60,
    )
    response.raise_for_status()

    content = response.json()["choices"][0]["message"]["content"]
    try:
        return {"status": "ok", "analysis": _parse_ai_json(content)}
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return {"status": "invalid", "reason": str(exc), "analysis_raw": content}

def main():
    previous = load_previous()
    urls = discover()
    now = datetime.now(timezone.utc).isoformat()

    current = {}
    new_items = []
    changed_items = []
    unchanged_items = []
    migration_items = []
    event_records = []
    fetched_text = {}

    for url in urls:
        uid = make_id(url)
        old = previous.get(uid)
        old_text = read_snapshot(uid, old)
        item = {
            "url_id": uid,
            "canonical_url": url,
            "parent_url_id": old.get("parent_url_id") if old else None,
            "depth": old.get("depth") if old else None,
            "terminal_file": is_file(url),
            "http_status": None,
            "content_type": None,
            "content_length": None,
            "etag": None,
            "last_modified": None,
            "raw_hash": None,
            "normalized_hash": None,
            "first_seen": old.get("first_seen", now) if old else now,
            "last_seen": now,
            "last_checked": now,
            "active": True,
            "evidence_location": old.get("evidence_location") if old else None,
            "snapshot_location": old.get("snapshot_location") if old else None,
        }

        if not item["terminal_file"]:
            try:
                (
                    code,
                    content_type,
                    content_length,
                    etag,
                    last_modified,
                    body_bytes,
                    body_text,
                ) = fetch(url)

                normalized_text = normalize_html(body_text)
                item.update(
                    {
                        "http_status": code,
                        "content_type": content_type,
                        "content_length": int(content_length) if content_length and content_length.isdigit() else None,
                        "etag": etag,
                        "last_modified": last_modified,
                        "raw_hash": hashlib.sha256(body_bytes).hexdigest(),
                        "normalized_hash": hashlib.sha256(
                            normalized_text.encode("utf-8")
                        ).hexdigest(),
                    }
                )
                fetched_text[uid] = normalized_text
            except Exception as exc:
                item["fetch_error"] = f"{type(exc).__name__}: {exc}"
                item["fetch_traceback"] = traceback.format_exc()
                if old:
                    # Preserve the last known good content baseline on transient
                    # fetch failures. The failed check is recorded separately.
                    item.update(
                        {
                            key: old.get(key)
                            for key in (
                                "http_status",
                                "content_type",
                                "content_length",
                                "etag",
                                "last_modified",
                                "raw_hash",
                                "normalized_hash",
                                "first_seen",
                                "parent_url_id",
                                "depth",
                                "evidence_location",
                            )
                        }
                    )

        current[uid] = item

        if item.get("fetch_error"):
            event_id = build_event_id(
                "FETCH_ERROR",
                uid,
                (old or {}).get("normalized_hash") or (old or {}).get("raw_hash") or (old or {}).get("content_hash"),
                error=item["fetch_error"],
            )
            evidence = write_evidence("FETCH_ERROR", event_id, url, now, old, item, old_text, None, item["fetch_error"])
            item["evidence_location"] = evidence
            current[uid] = item
            event_records.append(
                {
                    "event_id": event_id,
                    "event_type": "FETCH_ERROR",
                    "url": url,
                    "url_id": uid,
                    "timestamp": now,
                    "evidence_location": evidence,
                    "evidence": {"error": item["fetch_error"], "traceback": item.get("fetch_traceback")},
                }
            )
            continue

        event_type, migrated = classify_change(old, item)
        relevance = triage(
            url,
            fetched_text.get(uid, ""),
            item.get("content_type", ""),
        )
        item["relevance"] = relevance

        if event_type == "NEW_URL":
            new_items.append(item)
        elif event_type == "CHANGED_URL":
            changed_items.append({"before": old, "after": item})
        elif event_type == "BASELINE_MIGRATION":
            migration_items.append({"before": old, "after": item})
        else:
            unchanged_items.append(item)

        if fetched_text.get(uid) is not None:
            item["snapshot_location"] = write_snapshot(uid, fetched_text[uid])
            current[uid] = item

        if event_type != "UNCHANGED_URL" or migrated:
            before_hash = (old or {}).get("normalized_hash") or (old or {}).get("raw_hash") or (old or {}).get("content_hash")
            event_id = build_event_id(event_type, uid, before_hash, item.get("normalized_hash"))
            evidence = None
            if event_type in {"NEW_URL", "CHANGED_URL"}:
                evidence = write_evidence(
                    event_type,
                    event_id,
                    url,
                    now,
                    old,
                    item,
                    old_text,
                    fetched_text.get(uid),
                )
                item["evidence_location"] = evidence
                current[uid] = item
            event_records.append(
                {
                    "event_id": event_id,
                    "event_type": event_type,
                    "url": url,
                    "url_id": uid,
                    "timestamp": now,
                    "evidence_location": evidence,
                    "evidence": {"previous": old, "current": item},
                }
            )

    removed_items = [
        old
        for uid, old in previous.items()
        if uid not in current
    ]
    for old in removed_items:
        uid = old.get("url_id") or make_id(old.get("canonical_url", ""))
        url = old.get("canonical_url")
        event_id = build_event_id("REMOVED_URL", uid, old.get("normalized_hash") or old.get("raw_hash") or old.get("content_hash"))
        evidence = write_evidence("REMOVED_URL", event_id, url, now, old, None, read_snapshot(uid, old), None)
        event_records.append(
            {
                "event_id": event_id,
                "event_type": "REMOVED_URL",
                "url": url,
                "url_id": uid,
                "timestamp": now,
                "evidence_location": evidence,
                "evidence": {"previous": old, "current": None},
            }
        )

    ai_results = []
    all_candidates = new_items + [change["after"] for change in changed_items]
    candidates = [item for item in all_candidates if item.get("relevance", {}).get("candidate", True)]

    for item in candidates[:AI_MAX]:
        if item.get("terminal_file"):
            continue

        page_text = fetched_text.get(item["url_id"])
        event = "NEW_URL" if item in new_items else "CHANGED_URL"
        event_id = build_event_id(
            event,
            item["url_id"],
            (previous.get(item["url_id"]) or {}).get("normalized_hash"),
            item.get("normalized_hash"),
        )

        if page_text is None:
            ai_results.append(
                {
                    "event": "AI_ERROR",
                    "event_id": event_id,
                    "url": item["canonical_url"],
                    "evidence_location": item.get("evidence_location"),
                    "ai": {"status": "error", "reason": "No normalized page text available"},
                }
            )
            continue

        try:
            ai_results.append(
                {
                    "event": event,
                    "event_id": event_id,
                    "url": item["canonical_url"],
                    "evidence_location": item.get("evidence_location"),
                    "ai": ai_analyse(item["canonical_url"], page_text),
                }
            )
        except Exception as exc:
            ai_results.append(
                {
                    "event": "AI_ERROR",
                    "event_id": event_id,
                    "url": item["canonical_url"],
                    "evidence_location": item.get("evidence_location"),
                    "ai": {"status": "error", "reason": str(exc)},
                }
            )
    report = {
        "generated_at": now,
        "seed": SEED,
        "base": BASE,
        "crawler": "stealth-crawler",
        "change_detector": {
            "raw_hash": "SHA-256 of retrieved HTTP bytes",
            "normalized_hash": "SHA-256 of extracted and normalized regulatory content",
            "classification_hash": "normalized_hash",
        },
        "evidence": {
            "snapshot_directory": "data/snapshots/",
            "event_directory": "data/evidence/",
            "diff_format": "unified_diff",
            "max_diff_lines": MAX_DIFF_LINES,
        },
        "relevance_gate": {
            "mode": "high_recall",
            "ai_final_semantic_decision": True,
        },
        "ai_contract": {
            "required_keys": sorted(AI_REQUIRED_KEYS),
            "strict": True,
        },
        "counts": {
            "discovered": len(current),
            "new": len(new_items),
            "changed": len(changed_items),
            "removed": len(removed_items),
            "unchanged": len(unchanged_items),
            "baseline_migration": len(migration_items),
            "fetch_error": sum(1 for item in current.values() if item.get("fetch_error")),
            "relevance_candidates": len([item for item in (new_items + [change["after"] for change in changed_items]) if item.get("relevance", {}).get("candidate", True)]),
            "relevance_excluded": len([item for item in (new_items + [change["after"] for change in changed_items]) if not item.get("relevance", {}).get("candidate", True)]),
        },
        "new_urls": new_items,
        "changed_urls": changed_items,
        "removed_urls": removed_items,
        "baseline_migrations": migration_items,
        "events": event_records,
        "ai_results": ai_results,
    }

    (DATA / "latest.json").write_text(
        json.dumps(current, indent=2),
        encoding="utf-8",
    )
    (DATA / "report.json").write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )

    markdown = [
        "# EBA Regulatory Monitoring Report",
        "",
        "Seed: " + SEED,
        "",
        "## Change detector",
        "",
        "Raw HTML is retained as an audit signal, while normalized regulatory content drives change classification.",
        "",
        "## Event counts",
        "",
        "Discovered: " + str(len(current)),
        "New: " + str(len(new_items)),
        "Changed: " + str(len(changed_items)),
        "Removed: " + str(len(removed_items)),
        "Unchanged: " + str(len(unchanged_items)),
        "Baseline migration: " + str(len(migration_items)),
        "Fetch errors: " + str(sum(1 for item in current.values() if item.get("fetch_error"))),
        "Relevance candidates: " + str(len([item for item in (new_items + [change["after"] for change in changed_items]) if item.get("relevance", {}).get("candidate", True)])),
        "Relevance excluded: " + str(len([item for item in (new_items + [change["after"] for change in changed_items]) if not item.get("relevance", {}).get("candidate", True)])),
        "",
        "## Explicit events",
        "",
    ]

    if event_records:
        for event in event_records:
            markdown.extend(
                [
                    "### " + event["event_type"],
                    "",
                    event.get("url") or "(unknown URL)",
                    "",
                    "Event ID: " + event["event_id"],
                    "",
                    "Evidence: " + str(event.get("evidence_location")),
                    "",
                ]
            )
    else:
        markdown.append("No URL events were detected.")

    markdown.extend(["## AI results", ""])

    if ai_results:
        for result in ai_results:
            markdown.extend(
                [
                    "### " + result["event"],
                    "",
                    result["url"],
                    "",
                    "Event ID: " + result["event_id"],
                    "",
                    "Evidence: " + str(result.get("evidence_location")),
                    "",
                    json.dumps(result["ai"], indent=2),
                    "",
                ]
            )
    else:
        markdown.append("No new or changed HTML pages were sent to AI.")

    (DATA / "report.md").write_text(
        "\n".join(markdown),
        encoding="utf-8",
    )

    print(json.dumps(report["counts"], indent=2))


if __name__ == "__main__":
    main()