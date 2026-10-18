"""Register owner-submitted dashboard monitor requests in the Git-backed source config."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from bs4 import BeautifulSoup

REQUEST_MARKER = "<!-- changesentinel:add-monitor:v1 -->"
ISSUE_TITLE_PREFIX = "[ChangeSentinel] Add monitor"
TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}
DEFAULT_SOURCE_SETTINGS = {
    "active": True,
    "baseline_on_first_run": True,
    "include_selector": "",
    "ignore_selectors": [],
    "excluded_prefixes": [],
    "max_urls": 0,
    "crawler": "stealth-crawler",
    "discovery_attempts": 1,
    "discovery_timeout_seconds": 60,
    "discovery_retry_delay_seconds": 2,
    "use_http_discovery": True,
    "discovery_http_timeout_seconds": 20,
    "discovery_http_workers": 1,
    "discovery_http_attempts": 2,
    "discovery_slice_seconds": 0,
    "discovery_max_pages_per_slice": 1,
}


def canonicalize_url(value: str) -> str:
    """Validate and normalize one public HTTP(S) URL using the crawler's canonical rules."""
    raw = str(value or "").strip()
    if not raw or any(char.isspace() for char in raw):
        raise ValueError("The URL must be a complete URL without whitespace.")
    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError("Only http:// and https:// URLs can be monitored.")
    if not parsed.netloc or not parsed.hostname:
        raise ValueError("The URL must include a public hostname.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URLs containing a username or password are not allowed.")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("The URL contains an invalid port.") from exc

    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local", ".internal", ".lan", ".home")):
        raise ValueError("Local or internal hostnames cannot be monitored from this public service.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("Private, loopback, or reserved IP addresses cannot be monitored.")
    if address is None and "." not in host:
        raise ValueError("Enter a public hostname, such as www.example.com.")

    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    query = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered.startswith("utm_") or lowered in TRACKING_PARAMS:
            continue
        query.append((key, item))
    return urlunparse((scheme, netloc, path, "", urlencode(sorted(query), doseq=True), ""))


def _display_name(name: str, url: str) -> str:
    clean = re.sub(r"\s+", " ", str(name or "")).strip()[:100]
    if clean:
        return clean
    parsed = urlparse(url)
    tail = parsed.path.rstrip("/").split("/")[-1] if parsed.path.rstrip("/") else ""
    fallback = re.sub(r"[-_]+", " ", tail).strip()
    return fallback[:100].title() if fallback else (parsed.hostname or "Monitored page")


def _validate_css_selector(selector: str, label: str) -> None:
    if not selector:
        return
    if len(selector) > 500:
        raise ValueError(f"{label} CSS selector exceeds the 500-character limit.")
    try:
        BeautifulSoup("", "html.parser").select(selector)
    except Exception as exc:
        raise ValueError(f"Invalid {label} CSS selector: {exc}") from exc


def source_for_url(
    url: str,
    name: str = "",
    include_selector: str = "",
    ignore_selectors: tuple[str, ...] | list[str] = (),
) -> dict:
    parsed = urlparse(url)
    source_id = "manual-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    host = parsed.netloc.lower()
    settings = dict(DEFAULT_SOURCE_SETTINGS)
    settings["include_selector"] = str(include_selector or "").strip()
    settings["ignore_selectors"] = list(ignore_selectors or [])
    return {
        "id": source_id,
        "name": _display_name(name, url),
        "regulator": parsed.hostname or host,
        **settings,
        "seed_urls": [url],
        "allowed_prefixes": [parsed.scheme + "://" + host + "/"],
        "allowed_urls": [url],
        "allowed_domains": [host],
    }


def request_from_issue(event: dict, repository: str) -> tuple[str, str, str, tuple[str, ...]]:
    issue = event.get("issue") or {}
    title = str(issue.get("title") or "")
    if not title.startswith(ISSUE_TITLE_PREFIX):
        raise ValueError("This issue is not a ChangeSentinel add-monitor request.")
    repo_owner = str(repository or "").split("/", 1)[0].lower()
    issue_owner = str(((issue.get("user") or {}).get("login")) or "").lower()
    if not repo_owner or issue_owner != repo_owner:
        raise ValueError("Only the repository owner can register a monitor through the dashboard.")
    body = str(issue.get("body") or "")
    if REQUEST_MARKER not in body:
        raise ValueError("The issue is missing the ChangeSentinel request marker.")
    url_match = re.search(r"(?m)^URL:[ \t]*(\S+)[ \t]*$", body)
    if not url_match:
        raise ValueError("No URL field was found in the request body.")
    name_match = re.search(r"(?m)^Name:[ \t]*(.*?)[ \t]*$", body)
    include_match = re.search(r"(?m)^Include selector:[ \t]*(.*?)[ \t]*$", body)
    ignore_match = re.search(
        r"(?ms)^Ignore selectors:\s*\n(.*?)(?=\n\nThis request was created from the ChangeSentinel dashboard\.|\Z)",
        body,
    )
    url = canonicalize_url(url_match.group(1))
    name = re.sub(r"[\r\n]+", " ", name_match.group(1)).strip()[:100] if name_match else ""
    include_selector = str(include_match.group(1) if include_match else "").strip()
    _validate_css_selector(include_selector, "include")
    raw_ignored = ignore_match.group(1) if ignore_match else ""
    ignored = []
    for line in raw_ignored.splitlines():
        selector = re.sub(r"^\s*(?:-\s*|\*\s*)", "", line).strip()
        if not selector or selector.lower() in {"(none)", "none"}:
            continue
        if selector not in ignored:
            ignored.append(selector)
    if len(ignored) > 20:
        raise ValueError("At most 20 ignore CSS selectors can be configured per monitor.")
    for selector in ignored:
        _validate_css_selector(selector, "ignore")
    return url, name, include_selector, tuple(ignored)


def register_request(event: dict, config_path: Path, repository: str) -> dict:
    url, requested_name, include_selector, ignore_selectors = request_from_issue(event, repository)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    sources = config.setdefault("sources", [])
    if not isinstance(sources, list):
        raise ValueError("config/sources.json must contain a sources array.")

    # Avoid creating a second source for a page already covered by an active source.
    for source in sources:
        if not source.get("active", True):
            continue
        candidates = list(source.get("seed_urls") or []) + list(source.get("allowed_urls") or [])
        for candidate in candidates:
            try:
                if canonicalize_url(str(candidate)) == url:
                    return {
                        "source_id": str(source["id"]),
                        "url": url,
                        "name": str(source.get("name") or requested_name or url),
                        "created": False,
                        "message": "The URL is already present in an active source.",
                    }
            except (ValueError, KeyError):
                continue

    new_source = source_for_url(url, requested_name, include_selector, ignore_selectors)
    source_ids = {str(source.get("id")) for source in sources}
    if new_source["id"] in source_ids:
        existing = next(source for source in sources if str(source.get("id")) == new_source["id"])
        existing_urls = [str(candidate) for candidate in (existing.get("seed_urls") or [])]
        if any(candidate == url for candidate in existing_urls):
            return {
                "source_id": new_source["id"],
                "url": url,
                "name": str(existing.get("name") or new_source["name"]),
                "created": False,
                "message": "The monitor is already configured.",
            }
        raise ValueError("A source ID collision was detected; no configuration was changed.")

    sources.append(new_source)
    config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {
        "source_id": new_source["id"],
        "url": url,
        "name": new_source["name"],
        "created": True,
        "message": "The URL has been added to config/sources.json.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", type=Path, required=True, help="GitHub issues event JSON")
    parser.add_argument("--config", type=Path, required=True, help="Source configuration JSON")
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    args = parser.parse_args()

    repository = str(__import__("os").environ.get("GITHUB_REPOSITORY") or "")
    event = json.loads(args.event.read_text(encoding="utf-8"))
    result = register_request(event, args.config, repository)
    encoded = json.dumps(result, ensure_ascii=False)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
