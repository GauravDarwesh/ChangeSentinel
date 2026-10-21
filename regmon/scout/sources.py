"""Add a Scout source or edit a regulator's metadata from an owner-opened issue.

The dashboard's "Add source" and "Edit details" forms open a prefilled issue
whose body carries one JSON request. The owner-only workflow passes the issue
event here. A request can:

* create a regulator profile (it must bring its first channel),
* add a channel (feed, site map or listing page) to an existing regulator,
* replace an existing regulator's metadata: names, region, jurisdiction,
  languages, path hints, relevant and exclusion keywords, known gaps, active.

Channels are never removed or rewritten here; that stays a reviewed edit of
config/scout.json. The merged configuration must pass the same validation as
every sweep before it is written. Standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

from regmon.fsutil import atomic_write_text
from regmon.scout.profiles import CHANNEL_TYPES, ID_RE, REGIONS, ConfigError, parse_config
from regmon.scout.urls import canonical
from regmon.security import validate_public_http_url

MARKER = "<!-- changesentinel:scout-source:v1 -->"
TITLE_PREFIX = "[ChangeSentinel] Scout source"
JSON_BLOCK = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)
METADATA_FIELDS = ("name", "short_name", "region", "jurisdiction", "languages", "review_languages", "path_hints",
                   "keywords", "known_gaps", "active", "prefer_https")
LIMITS = {"text": 160, "list": 40, "term": 80, "gap": 400}


class SourceRequestError(ValueError):
    pass


def dump_config(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _text(value, label: str, limit: int = LIMITS["text"], required: bool = False) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if required and not text:
        raise SourceRequestError(f"{label} is required")
    if len(text) > limit:
        raise SourceRequestError(f"{label} is longer than {limit} characters")
    return text


def _list(value, label: str, limit: int = LIMITS["term"]) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = [item for item in re.split(r"[\n,]", value)]
    if not isinstance(value, list):
        raise SourceRequestError(f"{label} must be a list")
    items, seen = [], set()
    for item in value:
        text = _text(item, label, limit)
        if text and text.lower() not in seen:
            seen.add(text.lower())
            items.append(text)
    if len(items) > LIMITS["list"]:
        raise SourceRequestError(f"{label} has more than {LIMITS['list']} entries")
    return items


def _public(url: str, label: str, resolve_dns: bool) -> str:
    try:
        validate_public_http_url(url, resolve_dns=resolve_dns)
    except ValueError as exc:
        raise SourceRequestError(f"{label}: {exc}") from exc
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SourceRequestError(f"{label} must be a full http(s) URL")
    return url


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:40] or "source"


def parse_request(body: str) -> dict:
    text = str(body or "").replace("\r\n", "\n")
    if MARKER not in text:
        raise SourceRequestError("The issue is not a Scout source request (marker missing)")
    match = JSON_BLOCK.search(text)
    if not match:
        raise SourceRequestError("The request has no ```json block")
    try:
        request = json.loads(match.group(1))
    except ValueError as exc:
        raise SourceRequestError(f"The request JSON is not valid: {exc}") from exc
    if not isinstance(request, dict) or request.get("version") != 1 or not isinstance(request.get("regulator"), dict):
        raise SourceRequestError("The request must be a version 1 object with a regulator")
    return request


def _channel(raw: dict, regulator_id: str, existing_ids: set[str], resolve_dns: bool) -> dict:
    kind = str(raw.get("type") or "")
    if kind not in CHANNEL_TYPES:
        raise SourceRequestError(f"Channel type must be one of {', '.join(CHANNEL_TYPES)}")
    url = _public(_text(raw.get("url"), "Channel URL", 1000, True), "Channel URL", resolve_dns)
    label = _text(raw.get("label"), "Channel label", 120, True)
    channel_id = f"{regulator_id}-{_slug(label)}"[:60].rstrip("-")
    base, counter = channel_id, 2
    while channel_id in existing_ids:
        channel_id = f"{base[:56]}-{counter}"
        counter += 1
    channel = {"id": channel_id, "type": kind, "label": label, "url": url}
    if raw.get("required") is False:
        channel["required"] = False
    if kind == "listing":
        selector = _text(raw.get("content_selector"), "Content selector", 200)
        if selector:
            channel["content_selector"] = selector
        prefixes = [_public(item, "Link prefix", False) for item in _list(raw.get("link_prefixes"), "Link prefixes", 300)]
        if prefixes:
            channel["link_prefixes"] = prefixes
        patterns = _list(raw.get("exclude_link_patterns"), "Excluded link patterns", 200)
        for pattern in patterns:
            try:
                re.compile(pattern)
            except re.error as exc:
                raise SourceRequestError(f"Excluded link pattern {pattern!r} is not a valid regular expression: {exc}") from exc
        if patterns:
            channel["exclude_link_patterns"] = patterns
        page = raw.get("pagination")
        if page:
            if not isinstance(page, dict) or not re.fullmatch(r"[A-Za-z0-9_\-\[\]]{1,40}", str(page.get("param") or "")):
                raise SourceRequestError("Pagination needs the name of the page parameter (for example page)")
            try:
                max_pages = int(page.get("max_pages") or 5)
                baseline_pages = int(page.get("baseline_pages") or min(2, max_pages))
                start = int(page.get("start") or 0)
            except (TypeError, ValueError) as exc:
                raise SourceRequestError("Pagination numbers must be whole numbers") from exc
            channel["newest_first"] = True
            channel["pagination"] = {"param": str(page["param"]), "start": start, "max_pages": max_pages,
                                     "baseline_pages": baseline_pages}
    return channel


def _metadata(raw: dict, current: dict) -> dict:
    """Replace the metadata fields a request carries; keep the rest of the profile."""
    profile = dict(current)
    if "name" in raw:
        profile["name"] = _text(raw.get("name"), "Regulator name", required=True)
    if "short_name" in raw:
        profile["short_name"] = _text(raw.get("short_name"), "Short name") or profile.get("name", "")
    if "region" in raw:
        region = str(raw.get("region") or "")
        if region not in REGIONS:
            raise SourceRequestError(f"Region must be one of {', '.join(REGIONS)}")
        profile["region"] = region
    if "jurisdiction" in raw:
        profile["jurisdiction"] = _text(raw.get("jurisdiction"), "Jurisdiction")
    for key, label in (("languages", "Languages"), ("review_languages", "Languages to review")):
        if key in raw:
            values = [item.lower() for item in _list(raw.get(key), label, 12)]
            if any(not re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", item) for item in values):
                raise SourceRequestError(f"{label} must be language codes such as en, fr or es")
            profile[key] = values or ["en"]
    if "path_hints" in raw:
        hints = []
        for item in raw.get("path_hints") or []:
            if not isinstance(item, dict):
                raise SourceRequestError("Each path hint must be an object")
            prefix = _text(item.get("prefix"), "Path hint prefix", 200, True)
            if not prefix.startswith("/"):
                raise SourceRequestError(f"Path hint {prefix!r} must start with /")
            hint = {"prefix": prefix}
            effect = str(item.get("effect") or "positive")
            if effect == "negative":
                hint["effect"] = "negative"
            else:
                for key in ("publication_type", "topic"):
                    if item.get(key):
                        hint[key] = _text(item.get(key), key, 40)
                if len(hint) == 1:
                    raise SourceRequestError(f"Path hint {prefix!r} needs a kind of page, a topic, or 'exclude'")
            hints.append(hint)
        if len(hints) > LIMITS["list"]:
            raise SourceRequestError("Too many path hints")
        profile["path_hints"] = hints
    if "keywords" in raw:
        keywords = raw.get("keywords") or {}
        if not isinstance(keywords, dict):
            raise SourceRequestError("Keywords must be an object with relevant and exclude lists")
        cleaned = {key: _list(keywords.get(key), f"{key.capitalize()} keywords") for key in ("relevant", "exclude")}
        profile["keywords"] = {key: value for key, value in cleaned.items() if value}
        if not profile["keywords"]:
            profile.pop("keywords")
    if "known_gaps" in raw:
        profile["known_gaps"] = _list(raw.get("known_gaps"), "Known gaps", LIMITS["gap"])
    if "active" in raw:
        profile["active"] = bool(raw.get("active"))
    if "prefer_https" in raw:
        profile["prefer_https"] = bool(raw.get("prefer_https"))
    return profile


def apply_request(request: dict, config_data: dict, *, resolve_dns: bool = True) -> tuple[dict, dict]:
    """Return (new config data, summary). Raises SourceRequestError when anything is invalid."""
    data = json.loads(json.dumps(config_data))
    regulators = data.setdefault("regulators", [])
    raw = request["regulator"]
    regulator_id = str(raw.get("id") or "").strip()
    if not ID_RE.match(regulator_id):
        raise SourceRequestError("Regulator id must be lowercase letters, digits and hyphens (for example mas)")
    current = next((item for item in regulators if item.get("id") == regulator_id), None)
    created = current is None
    if created:
        if not request.get("channel"):
            raise SourceRequestError("A new regulator needs its first channel")
        current = {"id": regulator_id, "hosts": [], "channels": []}
        for key in ("name", "region"):
            if key not in raw:
                raise SourceRequestError(f"A new regulator needs a {key}")
    profile = _metadata(raw, current)
    existing_ids = {channel.get("id") for item in regulators for channel in item.get("channels") or []}
    added = None
    if request.get("channel"):
        if not isinstance(request["channel"], dict):
            raise SourceRequestError("The channel must be an object")
        added = _channel(request["channel"], regulator_id, existing_ids, resolve_dns)
        target = canonical(added["url"])
        for item in regulators:
            for channel in item.get("channels") or []:
                if canonical(channel.get("url", "")) == target:
                    raise SourceRequestError(f"{added['url']} is already Scout channel {channel.get('id')} ({item.get('id')})")
        profile["channels"] = list(profile.get("channels") or []) + [added]
    hosts = [str(item).lower() for item in profile.get("hosts") or []]
    extra = [str(item).lower() for item in _list(raw.get("extra_hosts"), "Extra hosts", 120)]
    for host in [urlparse(channel["url"]).hostname for channel in profile["channels"]] + extra:
        if host and host not in hosts:
            _public(f"https://{host}/", f"Host {host}", resolve_dns)
            hosts.append(host)
    profile["hosts"] = hosts
    if not profile.get("known_gaps"):
        # Coverage is always stated against a plan; say what a hand-added profile does not cover.
        profile["known_gaps"] = ["Reads only the channels listed for this regulator; pages announced anywhere else are not covered."]
    for prefix in (added or {}).get("link_prefixes") or []:
        if urlparse(prefix).hostname not in hosts:
            raise SourceRequestError(f"Link prefix {prefix} is not on one of the regulator's hosts")
    ordered = {key: profile[key] for key in ("id", "name", "short_name", "region", "jurisdiction", "hosts", "prefer_https",
                                              "active", "languages", "review_languages", "language_paths", "max_requests",
                                              "max_seconds", "channels", "path_hints", "keywords", "exclude_paths", "known_gaps")
               if key in profile}
    ordered.update({key: value for key, value in profile.items() if key not in ordered})
    if created:
        regulators.append(ordered)
    else:
        regulators[[item.get("id") for item in regulators].index(regulator_id)] = ordered
    try:
        parse_config(data)
    except ConfigError as exc:
        raise SourceRequestError(f"The resulting configuration is not valid: {exc}") from exc
    summary = {"regulator_id": regulator_id, "created": created, "channel_id": (added or {}).get("id", ""),
               "channel_url": (added or {}).get("url", ""), "active": ordered.get("active", True)}
    return data, summary


def apply_event(event: dict, config_path: Path, *, resolve_dns: bool = True) -> dict:
    issue = event.get("issue") or {}
    actor = str((issue.get("user") or {}).get("login") or "")
    owner = str(((event.get("repository") or {}).get("owner") or {}).get("login") or "")
    if not actor or actor != owner:
        raise SourceRequestError("Only the repository owner can change Scout's sources")
    if not str(issue.get("title") or "").startswith(TITLE_PREFIX):
        raise SourceRequestError("The issue title is not a Scout source request")
    request = parse_request(issue.get("body") or "")
    config_path = Path(config_path)
    data, summary = apply_request(request, json.loads(config_path.read_text(encoding="utf-8")), resolve_dns=resolve_dns)
    atomic_write_text(config_path, dump_config(data))
    return summary
