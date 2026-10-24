"""Register owner-submitted dashboard monitor requests in the Git-backed source config."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from regmon.safe_http import public_destinations_only
from regmon.security import USER_AGENT, validate_public_http_url

REQUEST_MARKER = "<!-- changesentinel:add-monitor:v1 -->"
BULK_REQUEST_MARKER = "<!-- changesentinel:add-monitor-bulk:v1 -->"
DELETE_REQUEST_MARKER = "<!-- changesentinel:delete-monitor:v1 -->"
MAX_BULK_REQUESTS = 25
ISSUE_TITLE_PREFIX = "[ChangeSentinel] Add monitor"
DELETE_ISSUE_TITLE_PREFIX = "[ChangeSentinel] Delete monitor"
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
    validate_public_http_url(raw)
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


def _metadata_from_html(html: str) -> dict[str, str]:
    """Extract a bounded display title and description from common HTML metadata."""
    soup = BeautifulSoup(str(html or ""), "html.parser")
    title = ""
    for selector in ('meta[property="og:title"]', 'meta[name="twitter:title"]'):
        tag = soup.select_one(selector)
        if tag and tag.get("content"):
            title = str(tag.get("content")).strip()
            if title:
                break
    if not title and soup.title:
        title = soup.title.get_text(" ", strip=True)
    description = ""
    for selector in ('meta[name="description"]', 'meta[property="og:description"]'):
        tag = soup.select_one(selector)
        if tag and tag.get("content"):
            description = str(tag.get("content")).strip()
            if description:
                break
    clean = lambda value, limit: re.sub(r"\s+", " ", str(value or "")).strip()[:limit]
    return {"title": clean(title, 160), "description": clean(description, 500)}


def _fetch_page_metadata(url: str) -> dict[str, str]:
    """Resolve a missing user-provided name without letting metadata fetch bypass URL safety."""
    current = url
    try:
        for redirect_count in range(4):
            validate_public_http_url(current, resolve_dns=True)
            with public_destinations_only():
                response = requests.get(current, timeout=(4, 7), allow_redirects=False,
                                        headers={"User-Agent": USER_AGENT, "Accept": "text/html"}, stream=True)
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                response.close()
                if not location or redirect_count >= 3:
                    return {}
                current = urljoin(current, location)
                continue
            if response.status_code >= 400 or "html" not in str(response.headers.get("content-type") or "").lower():
                response.close()
                return {}
            chunks, total = [], 0
            for chunk in response.iter_content(chunk_size=16 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > 512 * 1024:
                    response.close()
                    return {}
                chunks.append(chunk)
            encoding = response.encoding or "utf-8"
            response.close()
            return _metadata_from_html(b"".join(chunks).decode(encoding, "replace"))
    except Exception:
        # Metadata is advisory; unavailable sites should still be registerable.
        return {}
    return {}


MAX_REGISTRATION_REDIRECTS = 4


def _resolve_redirects(url: str) -> str:
    """The address a link finally serves from, so a monitor watches where the content lives.

    An exact-address monitor never follows a redirect to another host (its scope
    is that one address), so registering an address that now redirects - as old
    www.treasury.gov document links do to ticdata.treasury.gov - would fail on
    every scan. Each hop is checked like any registered URL. Any failure keeps
    the address as submitted: resolution is a convenience, never a gate.
    """
    current = url
    try:
        for _ in range(MAX_REGISTRATION_REDIRECTS + 1):
            validate_public_http_url(current, resolve_dns=True)
            with public_destinations_only():
                response = requests.get(current, timeout=(4, 10), allow_redirects=False, stream=True,
                                        headers={"User-Agent": USER_AGENT})
            status, location = response.status_code, response.headers.get("location")
            response.close()
            if status not in {301, 302, 303, 307, 308} or not location:
                return canonicalize_url(current)
            current = canonicalize_url(urljoin(current, location))
    except Exception:
        return url
    return url


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
    crawl_depth: int = 0,
    document_rule: dict | None = None,
) -> dict:
    parsed = urlparse(url)
    source_id = "manual-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    host = (parsed.hostname or "").rstrip(".").lower()
    authority = parsed.netloc.lower()
    settings = dict(DEFAULT_SOURCE_SETTINGS)
    settings["include_selector"] = str(include_selector or "").strip()
    settings["ignore_selectors"] = list(ignore_selectors or [])
    settings["crawl_depth"] = int(crawl_depth)
    settings["excluded_urls"] = []
    settings["discovery_max_pages_per_slice"] = 1 if crawl_depth == 0 else 200
    source = {
        "id": source_id,
        "name": _display_name(name, url),
        "regulator": parsed.hostname or host,
        **settings,
        "seed_urls": [url],
        "allowed_prefixes": [parsed.scheme + "://" + authority + "/"],
        "allowed_urls": [url] if crawl_depth == 0 else [],
        "allowed_domains": [host],
    }
    if document_rule:
        _apply_document_rule(source, url, document_rule)
    return source


MAX_DOCUMENT_FOLDERS = 5


def _document_rule(body: str, url: str) -> dict | None:
    """An optional monitoring rule taught in the dashboard: watch this page and the
    documents it links to, but only those in the given folders and, optionally,
    only those whose link text matches a pattern (for example ^Current).

    Returns None when the request carries neither field.
    """
    folders_value = _optional_field(body, "Documents under")
    pattern_value = _optional_field(body, "Document link text matches")
    if folders_value is None and pattern_value is None:
        return None
    parsed_page = urlparse(url)
    folders: list[str] = []
    for item in re.split(r"[,\s]+", folders_value or ""):
        value = item.strip()
        if not value or value.lower() in {"none", "(none)"}:
            continue
        prefix = canonicalize_url(value)  # rejects local, internal and private destinations
        parsed = urlparse(prefix)
        # A folder: "…/forms" admits "…/forms/…", not "…/forms-archive". A file's
        # address ("…/forms/FR_Y9C.pdf") names the folder it sits in.
        last = parsed.path.rsplit("/", 1)[-1]
        if parsed.path.endswith("/") or value.rstrip().endswith("/") or "." not in last:
            path = parsed.path.rstrip("/") + "/"
        else:
            path = parsed.path.rsplit("/", 1)[0] + "/"
        folder = urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))
        if folder not in folders:
            folders.append(folder)
    if len(folders) > MAX_DOCUMENT_FOLDERS:
        raise ValueError(f"At most {MAX_DOCUMENT_FOLDERS} document folders can be listed.")
    if not folders:
        # Only a label pattern: documents anywhere on the page's own site.
        folders = [urlunparse((parsed_page.scheme, parsed_page.netloc, "/", "", "", ""))]
    pattern = str(pattern_value or "").strip()
    if pattern.lower() in {"none", "(none)", "(any)"}:
        pattern = ""
    if len(pattern) > 200:
        raise ValueError("Document link text matches must be at most 200 characters.")
    if pattern:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ValueError(f"Document link text matches is not a valid pattern: {exc}") from exc
    return {"folders": folders, "patterns": [pattern] if pattern else []}


def _apply_document_rule(source: dict, url: str, rule: dict) -> None:
    """Watch the listed page plus matching documents; no other page is followed.

    Discovery binds pages to allowed_urls whenever document folders are set, so a
    depth-1 rule never wanders into the site's other pages.
    """
    source["crawl_depth"] = 1
    source["allowed_urls"] = [url]
    source["allowed_resource_prefixes"] = list(rule["folders"])
    source["resource_link_text_patterns"] = list(rule["patterns"])
    source["discovery_max_pages_per_slice"] = 200
    domains = [str(domain) for domain in (source.get("allowed_domains") or [])]
    for folder in rule["folders"]:
        host = (urlparse(folder).hostname or "").rstrip(".").lower()
        if host and host not in domains:
            domains.append(host)
    source["allowed_domains"] = domains


def _validated_issue_body(event: dict, repository: str, marker: str) -> str:
    issue = event.get("issue") or {}
    title = str(issue.get("title") or "")
    expected_prefix = DELETE_ISSUE_TITLE_PREFIX if marker == DELETE_REQUEST_MARKER else ISSUE_TITLE_PREFIX
    if not title.startswith(expected_prefix):
        raise ValueError("This issue is not a matching ChangeSentinel monitor request.")
    repo_owner = str(repository or "").split("/", 1)[0].lower()
    issue_owner = str(((issue.get("user") or {}).get("login")) or "").lower()
    if not repo_owner or issue_owner != repo_owner:
        raise ValueError("Only the repository owner can register a monitor through the dashboard.")
    body = str(issue.get("body") or "")
    if marker not in body:
        raise ValueError("The issue is missing the ChangeSentinel request marker.")
    return body


def _validated_request_values(
    url_value: str,
    name_value: str = "",
    include_value: str = "",
    ignore_values: tuple[str, ...] | list[str] = (),
) -> tuple[str, str, str, tuple[str, ...]]:
    url = canonicalize_url(url_value)
    name = re.sub(r"[\r\n]+", " ", str(name_value or "")).strip()[:100]
    include_selector = str(include_value or "").strip()
    _validate_css_selector(include_selector, "include")
    ignored = []
    values = ignore_values if isinstance(ignore_values, (list, tuple)) else str(ignore_values or "").splitlines()
    for value in values:
        selector = str(value or "").strip()
        if not selector or selector.lower() in {"(none)", "none"}:
            continue
        if selector not in ignored:
            ignored.append(selector)
    if len(ignored) > 20:
        raise ValueError("At most 20 ignore CSS selectors can be configured per monitor.")
    for selector in ignored:
        _validate_css_selector(selector, "ignore")
    return url, name, include_selector, tuple(ignored)


def request_from_issue(event: dict, repository: str) -> tuple[str, str, str, tuple[str, ...]]:
    body = _validated_issue_body(event, repository, REQUEST_MARKER)
    url_match = re.search(r"(?m)^URL:[ \t]*(\S+)[ \t]*$", body)
    if not url_match:
        raise ValueError("No URL field was found in the request body.")
    name_match = re.search(r"(?m)^Name:[ \t]*(.*?)[ \t]*$", body)
    include_match = re.search(r"(?m)^Include selector:[ \t]*(.*?)[ \t]*$", body)
    ignore_match = re.search(
        r"(?ms)^Ignore selectors:\s*\n(.*?)(?=\nCrawl depth:[ \t]*[^\n]*|\n\nThis request was created from the ChangeSentinel dashboard\.|\Z)",
        body,
    )
    raw_ignored = ignore_match.group(1) if ignore_match else ""
    ignored = []
    for line in raw_ignored.splitlines():
        selector = re.sub(r"^\s*(?:-\s*|\*\s*)", "", line).strip()
        if selector and selector.lower() not in {"(none)", "none"} and selector not in ignored:
            ignored.append(selector)
    return _validated_request_values(
        url_match.group(1),
        name_match.group(1) if name_match else "",
        include_match.group(1) if include_match else "",
        ignored,
    )


def bulk_requests_from_issue(event: dict, repository: str) -> list[tuple[str, str, str, tuple[str, ...]]]:
    """Parse an owner-submitted bulk issue. Each row is validated before config is written."""
    body = _validated_issue_body(event, repository, BULK_REQUEST_MARKER)
    payload_match = re.search(
        r"(?ms)^BULK_DATA_JSON:[ \t]*\n(.*?)(?=\n\nThis request was created from the ChangeSentinel dashboard bulk upload\.|\Z)",
        body,
    )
    if not payload_match:
        raise ValueError("No BULK_DATA_JSON payload was found in the bulk request.")
    try:
        rows = json.loads(payload_match.group(1))
    except json.JSONDecodeError as exc:
        raise ValueError(f"The bulk request contains invalid JSON: {exc.msg}.") from exc
    if not isinstance(rows, list) or not rows:
        raise ValueError("The bulk request must contain at least one link.")
    if len(rows) > MAX_BULK_REQUESTS:
        raise ValueError(f"A bulk request can contain at most {MAX_BULK_REQUESTS} links.")
    validated = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Bulk row {index} must be an object containing a URL.")
        try:
            validated.append(_validated_request_values(
                str(row.get("url") or ""),
                str(row.get("name") or ""),
                str(row.get("include_selector") or ""),
                row.get("ignore_selectors") or [],
            ))
        except ValueError as exc:
            raise ValueError(f"Bulk row {index}: {exc}") from exc
    return validated


def _existing_source_for_request(
    sources: list[dict],
    url: str,
    include_selector: str,
    ignore_selectors: tuple[str, ...],
    crawl_depth: int = 0,
    allow_depth_promotion: bool = False,
) -> dict | None:
    """Return an exact active URL match, rejecting implicit selector or scope changes."""
    for source in sources:
        if not source.get("active", True):
            continue
        candidates = list(source.get("seed_urls") or []) + list(source.get("allowed_urls") or [])
        # A crawl source owns same-host discovered pages even when the exact
        # URL list is empty, so avoid accidentally registering a duplicate child.
        if int(source.get("crawl_depth", 0)) > 0:
            candidates += [candidate for candidate in source.get("known_urls", []) if isinstance(candidate, str)]
        for candidate in candidates:
            try:
                candidate_url = canonicalize_url(str(candidate))
            except (ValueError, KeyError):
                continue
            if candidate_url != url:
                continue
            existing_include = str(source.get("include_selector") or "").strip()
            existing_ignore = tuple(
                str(value).strip()
                for value in (source.get("ignore_selectors") or [])
                if str(value).strip()
            )
            if existing_include != include_selector or existing_ignore != ignore_selectors:
                raise ValueError(
                    "This URL is already monitored with different CSS selectors. "
                    "The existing monitor was not changed; update it through an explicit edit flow."
                )
            current_depth = int(source.get("crawl_depth", 0))
            if current_depth != crawl_depth:
                seed_urls = source.get("seed_urls") or []
                try:
                    one_exact_manual_seed = (
                        str(source.get("id") or "").startswith("manual-")
                        and len(seed_urls) == 1
                        and canonicalize_url(str(seed_urls[0])) == url
                    )
                except (TypeError, ValueError, KeyError):
                    one_exact_manual_seed = False
                # Only an explicit dashboard request may promote a standalone
                # manual exact-page monitor from depth 0 to bounded same-host
                # discovery. Never downgrade or alter a multi-seed/source profile.
                can_promote = (
                    allow_depth_promotion
                    and current_depth == 0
                    and crawl_depth in {1, 2, 3}
                    and one_exact_manual_seed
                )
                if not can_promote:
                    raise ValueError(
                        "This URL is already monitored at a different crawl depth. "
                        "Only a standalone manual exact-page monitor can be promoted by an explicit depth request."
                    )
            return source
    return None


def register_bulk_request(event: dict, config_path: Path, repository: str) -> dict:
    """Register a set of exact-page URLs atomically; invalid/conflicting rows write nothing."""
    requests_to_add = bulk_requests_from_issue(event, repository)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    sources = config.setdefault("sources", [])
    if not isinstance(sources, list):
        raise ValueError("config/sources.json must contain a sources array.")

    items: list[dict] = []
    by_url: dict[str, dict] = {}
    source_ids: list[str] = []
    for row_number, (submitted_url, requested_name, include_selector, ignore_selectors) in enumerate(
        requests_to_add, start=1
    ):
        url = _resolve_redirects(submitted_url)
        previous = by_url.get(url)
        if previous is not None:
            if (
                previous["include_selector"] != include_selector
                or tuple(previous["ignore_selectors"]) != ignore_selectors
            ):
                raise ValueError(
                    f"Bulk row {row_number}: the same URL appears with different CSS selectors."
                )
            continue

        # Bulk upload deliberately retains the existing, safe default: each row
        # monitors that exact page. Crawl depth is configured in the single-link
        # dialog and is not implicitly enabled by importing a spreadsheet.
        crawl_depth = 0
        existing = _existing_source_for_request(
            sources, url, include_selector, ignore_selectors, crawl_depth=crawl_depth
        )
        if existing is not None:
            source_id = str(existing["id"])
            item = {
                "source_id": source_id,
                "url": url,
                "name": str(existing.get("name") or requested_name or url),
                "created": False,
            }
        else:
            metadata = _fetch_page_metadata(url) if not requested_name else {}
            display_name = requested_name or metadata.get("title", "")
            new_source = source_for_url(
                url, display_name, include_selector, ignore_selectors, crawl_depth=crawl_depth
            )
            source_ids_in_config = {str(source.get("id")) for source in sources}
            if new_source["id"] in source_ids_in_config:
                existing_collision = next(
                    source for source in sources if str(source.get("id")) == new_source["id"]
                )
                existing_urls = [
                    str(candidate) for candidate in (existing_collision.get("seed_urls") or [])
                ]
                if any(canonicalize_url(candidate) == url for candidate in existing_urls):
                    item = {
                        "source_id": new_source["id"],
                        "url": url,
                        "name": str(existing_collision.get("name") or new_source["name"]),
                        "created": False,
                    }
                    source_id = new_source["id"]
                else:
                    raise ValueError(
                        f"Bulk row {row_number}: a source ID collision was detected; "
                        "no configuration was changed."
                    )
            else:
                sources.append(new_source)
                source_id = new_source["id"]
                item = {
                    "source_id": source_id,
                    "url": url,
                    "name": new_source["name"],
                    "created": True,
                }

        if url != submitted_url:
            item["redirected_from"] = submitted_url
        by_url[url] = {
            **item,
            "include_selector": include_selector,
            "ignore_selectors": list(ignore_selectors),
        }
        items.append(item)
        if source_id not in source_ids:
            source_ids.append(source_id)

    created_count = sum(1 for item in items if item["created"])
    existing_count = len(items) - created_count
    if created_count:
        config_path.write_text(
            json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    return {
        "bulk": True,
        "source_ids": source_ids,
        "items": items,
        "count": len(items),
        "created_count": created_count,
        "existing_count": existing_count,
        # Singular aliases keep downstream tooling compatible with its old output shape.
        "source_id": source_ids[0],
        "url": items[0]["url"],
        "created": bool(created_count),
        "message": (
            f"Processed {len(items)} unique links: {created_count} new "
            f"and {existing_count} already configured."
        ),
    }

def _scout_discovery_flag(body: str) -> bool:
    matches = re.findall(r"(?mi)^Scout discovery:[ \t]*(.*?)[ \t]*$", str(body or ""))
    if len(matches) > 1:
        raise ValueError("The request must contain at most one Scout discovery field.")
    if not matches:
        return False
    value = matches[0].strip().lower()
    if value not in {"yes", "no"}:
        raise ValueError("Scout discovery must be yes or no.")
    return value == "yes"


def _yes_no_field(body: str, label: str) -> bool | None:
    """An optional yes/no field; None when the request does not carry it."""
    matches = re.findall(rf"(?mi)^{re.escape(label)}:[ \t]*(.*?)[ \t]*$", str(body or ""))
    if len(matches) > 1:
        raise ValueError(f"The request must contain at most one {label} field.")
    if not matches:
        return None
    value = matches[0].strip().lower()
    if value not in {"yes", "no"}:
        raise ValueError(f"{label} must be yes or no.")
    return value == "yes"


def _optional_field(body: str, label: str) -> str | None:
    matches = re.findall(rf"(?m)^{re.escape(label)}:[ \t]*(.*?)[ \t]*$", str(body or ""))
    if len(matches) > 1:
        raise ValueError(f"The request must contain at most one {label} field.")
    return matches[0].strip() if matches else None


MAX_DOCUMENT_HOSTS = 10


def _alert_condition_fields(body: str) -> tuple[str | None, bool | None]:
    """Optional "Alert me when" condition and "Alert only when condition met" flag.

    An empty "Alert me when:" line clears a monitor's condition; a missing line
    leaves it unchanged.
    """
    raw = _optional_field(body, "Alert me when")
    only = _yes_no_field(body, "Alert only when condition met")
    condition = None if raw is None else " ".join(raw.split())
    if condition is not None and len(condition) > 500:
        raise ValueError("Alert me when must be at most 500 characters.")
    if only and not condition:
        raise ValueError("Alert only when condition met: yes needs an Alert me when condition.")
    return condition, only


def _apply_alert_condition(source: dict, condition: str | None, only: bool | None) -> bool:
    before = (source.get("alert_condition", ""), source.get("alert_only_on_condition", False))
    if condition is not None:
        if condition:
            source["alert_condition"] = condition
        else:
            source.pop("alert_condition", None)
            source.pop("alert_only_on_condition", None)
    if only is not None and source.get("alert_condition"):
        if only:
            source["alert_only_on_condition"] = True
        else:
            source.pop("alert_only_on_condition", None)
    return (source.get("alert_condition", ""), source.get("alert_only_on_condition", False)) != before


def _discovery_scope(body: str, url: str) -> tuple[list[str] | None, list[str] | None]:
    """Optional Scout discovery scope: where pages may be read, which other hosts may supply documents.

    A field that is absent leaves an existing channel unchanged (None). A field
    present but empty clears it ([]): read anywhere on the host, no other hosts.
    """
    host = (urlparse(url).hostname or "").rstrip(".").lower()
    explore_value = _optional_field(body, "Explore within")
    explore = None
    if explore_value is not None:
        explore = []
        if explore_value and explore_value.lower() not in {"(anywhere on this site)", "none", "(none)"}:
            prefix = canonicalize_url(explore_value)
            if (urlparse(prefix).hostname or "").rstrip(".").lower() != host:
                raise ValueError("Explore within must be an address on the same host as the starting page.")
            parsed = urlparse(prefix)
            # A prefix names a folder: "…/forms" reads "…/forms" and "…/forms/…", not "…/forms-archive".
            path = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
            explore = [urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))]
    hosts_value = _optional_field(body, "Document hosts")
    document_hosts = None
    if hosts_value is not None:
        document_hosts = []
        if hosts_value.lower() not in {"", "none", "(none)"}:
            for item in re.split(r"[,\s]+", hosts_value):
                candidate = item.strip().lower().rstrip(".")
                if not candidate:
                    continue
                if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", candidate):
                    raise ValueError(f"Document host {candidate!r} must be a bare public hostname such as www.example.gov.")
                canonicalize_url(f"https://{candidate}/")  # rejects local, internal and private destinations
                if candidate != host and candidate not in document_hosts:
                    document_hosts.append(candidate)
            if len(document_hosts) > MAX_DOCUMENT_HOSTS:
                raise ValueError(f"At most {MAX_DOCUMENT_HOSTS} document hosts can be listed.")
    return explore, document_hosts


def _apply_scope(channel: dict, explore_prefixes: list[str] | None, document_hosts: list[str] | None) -> None:
    for key, value in (("explore_prefixes", explore_prefixes), ("document_hosts", document_hosts)):
        if value is None:
            continue
        if value:
            channel[key] = list(value)
        else:
            channel.pop(key, None)


def _configure_scout_source(
    scout_config: dict,
    url: str,
    display_name: str,
    crawl_depth: int,
    explore_prefixes: list[str] | None = None,
    document_hosts: list[str] | None = None,
) -> tuple[bool, str, str]:
    """Add/update a bounded weekly Scout listing in memory, then validate the full profile."""
    from regmon.scout.profiles import parse_config

    if not 1 <= crawl_depth <= 3:
        raise ValueError("Scout weekly discovery requires crawl depth 1, 2, or 3.")
    regulators = scout_config.get("regulators")
    if not isinstance(regulators, list):
        raise ValueError("config/scout.json must contain a regulators array.")

    parsed = urlparse(url)
    hostname = str(parsed.hostname or "").lower().rstrip(".")
    if not hostname:
        raise ValueError("Scout discovery requires a public hostname.")
    origin_prefix = f"{parsed.scheme}://{parsed.netloc}/"
    channel_id = "manual-page-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    regulator_id = ""

    # If an ordinary (non-paginated) Scout listing already watches this exact
    # root, extend it instead of creating a duplicate request to the site.
    for regulator in regulators:
        for channel in regulator.get("channels") or []:
            try:
                same_url = canonicalize_url(str(channel.get("url") or "")) == url
            except ValueError:
                same_url = False
            if same_url and channel.get("type") == "listing" and not channel.get("pagination"):
                prefixes = list(channel.get("link_prefixes") or [])
                # Preserve an existing regulator channel's narrower URL scope.
                # Only add the submitted page's origin as a boundary when the
                # existing channel had no explicit link-prefix restriction.
                if not prefixes:
                    prefixes = [origin_prefix]
                new_values = {
                    "crawl_depth": crawl_depth,
                    "link_prefixes": prefixes,
                    "label": channel.get("label") or display_name[:160],
                }
                before = json.dumps(channel, sort_keys=True)
                channel.update(new_values)
                _apply_scope(channel, explore_prefixes, document_hosts)
                changed = json.dumps(channel, sort_keys=True) != before
                regulator_id = str(regulator.get("id") or "")
                parse_config(scout_config)
                return changed, str(channel.get("id") or channel_id), regulator_id

    # A deterministic ID makes repeated requests idempotent. If this exact
    # dashboard-created channel already exists, update its selected depth.
    existing_channel = None
    existing_regulator = None
    for regulator in regulators:
        for channel in regulator.get("channels") or []:
            if str(channel.get("id") or "") == channel_id:
                existing_channel, existing_regulator = channel, regulator
                break
        if existing_channel:
            break
    if existing_channel is not None:
        if canonicalize_url(str(existing_channel.get("url") or "")) != url:
            raise ValueError("A Scout channel ID collision was detected; no configuration was changed.")
        prefixes = list(existing_channel.get("link_prefixes") or [])
        if origin_prefix not in prefixes:
            prefixes.append(origin_prefix)
        new_values = {"crawl_depth": crawl_depth, "link_prefixes": prefixes, "label": display_name[:160]}
        before = json.dumps(existing_channel, sort_keys=True)
        existing_channel.update(new_values)
        _apply_scope(existing_channel, explore_prefixes, document_hosts)
        changed = json.dumps(existing_channel, sort_keys=True) != before
        regulator_id = str(existing_regulator.get("id") or "")
        parse_config(scout_config)
        return changed, channel_id, regulator_id

    channel = {
        "id": channel_id,
        "type": "listing",
        "label": display_name[:160] or hostname,
        "url": url,
        "required": True,
        "link_prefixes": [origin_prefix],
        "crawl_depth": crawl_depth,
    }
    _apply_scope(channel, explore_prefixes, document_hosts)

    # Reuse an existing profile for this exact host when possible. Otherwise
    # create an explicitly labelled custom profile; OTHER is a category, not a
    # guessed jurisdiction. Traversal still cannot leave this single host.
    profile = next(
        (item for item in regulators if hostname in {
            str(value).lower().rstrip(".") for value in (item.get("hosts") or [])
        }),
        None,
    )
    changed = True
    if profile is None:
        regulator_id = "manual-" + hashlib.sha256(hostname.encode("utf-8")).hexdigest()[:12]
        colliding = next((item for item in regulators if str(item.get("id") or "") == regulator_id), None)
        if colliding is not None:
            if hostname not in {str(value).lower().rstrip(".") for value in (colliding.get("hosts") or [])}:
                raise ValueError("A Scout profile ID collision was detected; no configuration was changed.")
            profile = colliding
        else:
            profile = {
                "id": regulator_id,
                "name": f"User-configured source: {display_name[:100] or hostname}",
                "short_name": display_name[:80] or hostname,
                "region": "OTHER",
                "jurisdiction": "User-configured",
                "hosts": [hostname],
                "active": True,
                "channels": [],
                "known_gaps": [
                    f"Dashboard-added listing rooted at {url}; only links on this host through depth {crawl_depth} are discovered. "
                    "Unlinked pages and paths beyond the selected depth are not covered."
                ],
            }
            regulators.append(profile)
    regulator_id = str(profile.get("id") or "")
    channels = profile.setdefault("channels", [])
    if not isinstance(channels, list):
        raise ValueError(f"Scout profile {regulator_id} must contain a channels array.")
    channels.append(channel)
    parse_config(scout_config)
    return changed, channel_id, regulator_id


def register_request(
    event: dict,
    config_path: Path,
    repository: str,
    scout_config_path: Path | None = None,
) -> dict:
    body = str(((event.get("issue") or {}).get("body")) or "")
    if DELETE_REQUEST_MARKER in body:
        return delete_monitor_request(event, config_path, repository)
    if BULK_REQUEST_MARKER in body:
        return register_bulk_request(event, config_path, repository)

    submitted_url, requested_name, include_selector, ignore_selectors = request_from_issue(event, repository)
    crawl_matches = re.findall(r"(?m)^Crawl depth:[ \t]*(.*?)[ \t]*$", body)
    if len(crawl_matches) > 1:
        raise ValueError("The request must contain at most one Crawl depth field.")
    if crawl_matches:
        raw_depth = crawl_matches[0]
        if raw_depth not in {"0", "1", "2", "3"}:
            raise ValueError("Crawl depth must be 0, 1, 2, or 3.")
        crawl_depth = int(raw_depth)
    else:
        crawl_depth = 0
    scout_enabled = _scout_discovery_flag(body)
    # Discovery reads the page as submitted; a monitor watches where it now serves from.
    discovery_only_requested = bool(_yes_no_field(body, "Discovery only"))
    url = submitted_url if discovery_only_requested else _resolve_redirects(submitted_url)
    if scout_enabled and crawl_depth == 0:
        raise ValueError("Scout weekly discovery requires crawl depth 1, 2, or 3.")
    if scout_enabled and scout_config_path is None:
        raise ValueError("Scout discovery was selected, but no Scout config path was supplied to registration.")
    # "Discovery only" sets up link discovery without adding any monitor: the
    # links Scout finds are candidates the owner selects from in the dashboard.
    discovery_only = bool(_yes_no_field(body, "Discovery only"))
    explore_prefixes, document_hosts = _discovery_scope(body, url)
    if (discovery_only or explore_prefixes is not None or document_hosts is not None) and not scout_enabled:
        raise ValueError("Discovery only, Explore within and Document hosts require Scout discovery: yes.")
    alert_condition, alert_only = _alert_condition_fields(body)
    document_rule = _document_rule(body, url)
    if document_rule is not None:
        if scout_enabled:
            raise ValueError("A document rule cannot be combined with Scout discovery in the same request.")
        if crawl_depth != 1:
            raise ValueError("A document rule needs Crawl depth: 1.")

    config = json.loads(config_path.read_text(encoding="utf-8"))
    sources = config.setdefault("sources", [])
    if not isinstance(sources, list):
        raise ValueError("config/sources.json must contain a sources array.")

    metadata = _fetch_page_metadata(url) if not requested_name else {}
    display_name = requested_name or metadata.get("title", "")

    if discovery_only:
        scout_data = json.loads(Path(scout_config_path).read_text(encoding="utf-8"))
        scout_changed, scout_channel_id, scout_regulator_id = _configure_scout_source(
            scout_data, url, str(display_name or url), crawl_depth, explore_prefixes, document_hosts
        )
        if scout_changed:
            Path(scout_config_path).write_text(
                json.dumps(scout_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
        return {
            "source_id": "",
            "source_ids": [],
            "url": url,
            "name": str(display_name or url),
            "created": False,
            "crawl_depth": crawl_depth,
            "crawl_depth_updated": False,
            "discovery_only": True,
            "scout_enabled": True,
            "scout_configured": True,
            "scout_changed": scout_changed,
            "scout_channel_id": scout_channel_id,
            "scout_regulator_id": scout_regulator_id,
            "explore_prefixes": explore_prefixes or [],
            "document_hosts": document_hosts or [],
            "message": (
                f"Link discovery is configured at depth {crawl_depth} (channel {scout_channel_id}). "
                "No monitor was added; discovered links are candidates to select from."
            ),
        }

    existing = _existing_source_for_request(
        sources,
        url,
        include_selector,
        ignore_selectors,
        crawl_depth=crawl_depth,
        allow_depth_promotion=bool(crawl_matches and crawl_depth in {1, 2, 3}),
    )
    source_changed = False
    crawl_depth_updated = False
    if existing is not None and document_rule is not None:
        seed_urls = existing.get("seed_urls") or []
        try:
            own_page = (
                str(existing.get("id") or "").startswith("manual-")
                and len(seed_urls) == 1
                and canonicalize_url(str(seed_urls[0])) == url
            )
        except (TypeError, ValueError, KeyError):
            own_page = False
        if not own_page:
            raise ValueError(
                "This page is already monitored as part of another source; a document rule can only "
                "be set on a page monitored on its own."
            )
        previous_depth = int(existing.get("crawl_depth", 0))
        before = json.dumps(existing, sort_keys=True)
        _apply_document_rule(existing, url, document_rule)
        if requested_name:
            existing["name"] = _display_name(requested_name, url)
        source_changed = json.dumps(existing, sort_keys=True) != before
        crawl_depth_updated = previous_depth != 1
        source_result = {
            "source_id": str(existing["id"]),
            "url": url,
            "name": str(existing.get("name") or display_name or url),
            "created": False,
            "crawl_depth": 1,
            "message": (
                "The existing monitor now follows the document rule." if source_changed
                else "The monitor already follows this document rule."
            ),
        }
    elif existing is not None:
        previous_depth = int(existing.get("crawl_depth", 0))
        if previous_depth != crawl_depth:
            # This promotion is restricted to one manual seed currently watched
            # at depth 0. Preserve ID, selectors, exclusions, schedule, and history.
            existing["crawl_depth"] = crawl_depth
            existing["allowed_urls"] = []
            existing["discovery_max_pages_per_slice"] = 200
            if requested_name:
                existing["name"] = _display_name(requested_name, url)
            source_changed = True
            crawl_depth_updated = True
        source_result = {
            "source_id": str(existing["id"]),
            "url": url,
            "name": str(existing.get("name") or display_name or url),
            "created": False,
            "crawl_depth": int(existing.get("crawl_depth", 0)),
            "message": (
                f"The existing monitor was promoted from depth {previous_depth} to {crawl_depth}."
                if crawl_depth_updated
                else "The URL is already present in an active source."
            ),
        }
    else:
        new_source = source_for_url(
            url, display_name, include_selector, ignore_selectors, crawl_depth=crawl_depth,
            document_rule=document_rule,
        )
        source_ids = {str(source.get("id")) for source in sources}
        if new_source["id"] in source_ids:
            existing_collision = next(source for source in sources if str(source.get("id")) == new_source["id"])
            existing_urls = [str(candidate) for candidate in (existing_collision.get("seed_urls") or [])]
            if any(canonicalize_url(candidate) == url for candidate in existing_urls):
                source_result = {
                    "source_id": new_source["id"],
                    "url": url,
                    "name": str(existing_collision.get("name") or new_source["name"]),
                    "created": False,
                    "crawl_depth": crawl_depth,
                    "message": "The monitor is already configured.",
                }
            else:
                raise ValueError("A source ID collision was detected; no configuration was changed.")
        else:
            sources.append(new_source)
            source_changed = True
            source_result = {
                "source_id": new_source["id"],
                "url": url,
                "name": new_source["name"],
                "created": True,
                "crawl_depth": crawl_depth,
                "message": "The URL has been added to config/sources.json.",
            }

    scout_changed = False
    scout_channel_id = ""
    scout_regulator_id = ""
    scout_data = None
    if scout_enabled:
        scout_data = json.loads(Path(scout_config_path).read_text(encoding="utf-8"))
        scout_changed, scout_channel_id, scout_regulator_id = _configure_scout_source(
            scout_data, url, str(source_result["name"] or display_name or url), crawl_depth,
            explore_prefixes, document_hosts,
        )

    if alert_condition is not None or alert_only is not None:
        target = next(
            (source for source in sources if str(source.get("id")) == str(source_result["source_id"])),
            None,
        )
        if target is not None:
            seeds = [str(seed) for seed in (target.get("seed_urls") or [])]
            try:
                own_page = len(seeds) == 1 and canonicalize_url(seeds[0]) == url
            except (TypeError, ValueError):
                own_page = False
            if not own_page:
                raise ValueError(
                    "An alert condition can only be set on a page monitored on its own; this page "
                    "belongs to a source with other pages."
                )
        if target is not None and _apply_alert_condition(target, alert_condition, alert_only):
            source_changed = True
            if target.get("alert_condition"):
                mode = " It alerts only when the condition is met." if target.get("alert_only_on_condition") else ""
                source_result["message"] += f" Alert condition set: {target['alert_condition']}.{mode}"
            else:
                source_result["message"] += " Alert condition cleared."
        if target is not None:
            source_result["alert_condition"] = target.get("alert_condition", "")
            source_result["alert_only_on_condition"] = bool(target.get("alert_only_on_condition", False))

    # Validate both proposed files before replacing either one. GitHub commits
    # the two config files together in a single owner-approved workflow run.
    if source_changed:
        config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if scout_enabled and scout_changed:
        Path(scout_config_path).write_text(
            json.dumps(scout_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    source_result["crawl_depth_updated"] = crawl_depth_updated
    source_result["discovery_only"] = False
    if document_rule is not None:
        source_result["document_rule"] = document_rule
    if url != submitted_url:
        source_result["redirected_from"] = submitted_url
    source_result["scout_enabled"] = scout_enabled
    source_result["scout_configured"] = scout_enabled
    source_result["scout_changed"] = scout_changed
    source_result["scout_channel_id"] = scout_channel_id
    source_result["scout_regulator_id"] = scout_regulator_id
    if scout_enabled:
        source_result["message"] += (
            f" Weekly Scout discovery is configured at depth {crawl_depth} "
            f"(channel {scout_channel_id}); newly discovered links will appear in Scout for review."
        )
    return source_result

def delete_monitor_request(event: dict, config_path: Path, repository: str) -> dict:
    """Exclude an individual page or disable a crawl root without deleting evidence."""
    body = _validated_issue_body(event, repository, DELETE_REQUEST_MARKER)
    source_match = re.search(r"(?m)^Source ID:[ \t]*([A-Za-z0-9._-]{1,120})[ \t]*$", body)
    url_match = re.search(r"(?m)^URL:[ \t]*(\S+)[ \t]*$", body)
    if not source_match or not url_match:
        raise ValueError("Delete requests need both Source ID and URL fields.")
    target_url = canonicalize_url(url_match.group(1))
    config = json.loads(config_path.read_text(encoding="utf-8"))
    sources = config.get("sources")
    if not isinstance(sources, list):
        raise ValueError("config/sources.json must contain a sources array.")
    source = next((row for row in sources if str(row.get("id")) == source_match.group(1)), None)
    if source is None:
        raise ValueError("The requested source no longer exists.")
    from regmon.discovery import canonical, in_scope
    from regmon.config import SourceConfig
    parsed_source = SourceConfig.from_dict(source)
    if not in_scope(canonical(target_url), parsed_source):
        raise ValueError("The selected page does not belong to this source's active scope.")
    seeds = [str(value) for value in source.get("seed_urls") or []]
    excluded = [canonicalize_url(value) for value in source.get("excluded_urls") or []]
    already_excluded = target_url in excluded
    if not already_excluded:
        excluded.append(target_url)
    remaining_seeds = [seed for seed in seeds if canonicalize_url(seed) != target_url]
    root_deleted = len(remaining_seeds) != len(seeds)
    if root_deleted and not remaining_seeds:
        # Deactivation is the authoritative stop signal for a root. Keep the seed
        # intact so its historical identity and inventory remain available.
        source["active"] = False
    else:
        source["excluded_urls"] = sorted(set(excluded))
        if root_deleted:
            source["seed_urls"] = remaining_seeds
    if not already_excluded or root_deleted:
        config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"source_id": source["id"], "source_ids": [source["id"]], "url": target_url, "name": source.get("name", "Monitored page"), "created": False, "deleted": True, "deactivated": not source.get("active", True), "root_deleted": root_deleted, "bulk": False, "count": 1, "created_count": 0, "existing_count": 1, "message": "The page is excluded from future scans; history and saved evidence are retained."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", type=Path, required=True, help="GitHub issues event JSON")
    parser.add_argument("--config", type=Path, required=True, help="Source configuration JSON")
    parser.add_argument("--scout-config", type=Path, help="Optional Scout profile configuration JSON for weekly discovery")
    parser.add_argument("--output", type=Path, help="Optional JSON output path")
    args = parser.parse_args()

    repository = str(__import__("os").environ.get("GITHUB_REPOSITORY") or "")
    event = json.loads(args.event.read_text(encoding="utf-8"))
    result = register_request(event, args.config, repository, args.scout_config)
    encoded = json.dumps(result, ensure_ascii=False)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
