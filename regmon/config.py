"""Configuration for the regulatory monitoring engine."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = ROOT / "config" / "sources.json"


@dataclass(frozen=True)
class SourceConfig:
    id: str
    name: str
    regulator: str
    seed_urls: tuple[str, ...]
    allowed_prefixes: tuple[str, ...]
    allowed_domains: tuple[str, ...]
    allowed_urls: tuple[str, ...] = ()
    allowed_resource_prefixes: tuple[str, ...] = ()
    resource_link_text_patterns: tuple[str, ...] = ()
    include_selector: str = ""
    ignore_selectors: tuple[str, ...] = ()
    max_urls: int = 0
    crawl_depth: int = -1
    excluded_urls: tuple[str, ...] = ()
    register_discovered_urls: bool = False
    crawler: str = "stealth-crawler"
    active: bool = True
    baseline_on_first_run: bool = False
    excluded_prefixes: tuple[str, ...] = ()
    discovery_attempts: int = 1
    discovery_timeout_seconds: int = 180
    discovery_retry_delay_seconds: int = 5
    use_http_discovery: bool = True
    discovery_http_timeout_seconds: int = 20
    discovery_http_workers: int = 6
    discovery_http_attempts: int = 2
    discovery_slice_seconds: int = 2700
    discovery_max_pages_per_slice: int = 2000

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SourceConfig":
        if not isinstance(value, dict):
            raise ValueError("Each source configuration must be an object")
        required = ("id", "name", "regulator", "seed_urls", "allowed_prefixes", "allowed_domains")
        missing = [key for key in required if not value.get(key)]
        if missing:
            raise ValueError(f"Source configuration missing: {', '.join(missing)}")
        _validate_source_types(value)
        return cls(
            id=str(value["id"]),
            name=str(value["name"]),
            regulator=str(value["regulator"]),
            seed_urls=tuple(str(x) for x in value["seed_urls"]),
            allowed_prefixes=tuple(str(x).rstrip("/") + "/" for x in value["allowed_prefixes"]),
            allowed_domains=tuple(str(x).lower() for x in value["allowed_domains"]),
            allowed_urls=tuple(str(x) for x in value.get("allowed_urls", [])),
            allowed_resource_prefixes=tuple(
                str(x).rstrip("/") + "/" for x in value.get("allowed_resource_prefixes", [])
            ),
            resource_link_text_patterns=tuple(
                str(x) for x in value.get("resource_link_text_patterns", []) if str(x).strip()
            ),
            include_selector=str(value.get("include_selector", "") or "").strip(),
            ignore_selectors=tuple(
                str(x).strip() for x in value.get("ignore_selectors", []) if str(x).strip()
            ),
            max_urls=int(value.get("max_urls", 0)),
            crawl_depth=int(value.get("crawl_depth", -1)),
            excluded_urls=tuple(str(x) for x in value.get("excluded_urls", [])),
            register_discovered_urls=bool(value.get("register_discovered_urls", False)),
            crawler=str(value.get("crawler", "stealth-crawler")),
            active=bool(value.get("active", True)),
            baseline_on_first_run=bool(value.get("baseline_on_first_run", False)),
            excluded_prefixes=tuple(
                str(x).rstrip("/") + "/" for x in value.get("excluded_prefixes", [])
            ),
            discovery_attempts=max(1, int(value.get("discovery_attempts", 1))),
            discovery_timeout_seconds=max(30, int(value.get("discovery_timeout_seconds", 180))),
            discovery_retry_delay_seconds=max(0, int(value.get("discovery_retry_delay_seconds", 5))),
            use_http_discovery=bool(value.get("use_http_discovery", True)),
            discovery_http_timeout_seconds=max(5, int(value.get("discovery_http_timeout_seconds", 20))),
            discovery_http_workers=max(1, int(value.get("discovery_http_workers", 6))),
            discovery_http_attempts=max(1, int(value.get("discovery_http_attempts", 2))),
            discovery_slice_seconds=max(0, int(value.get("discovery_slice_seconds", 2700))),
            discovery_max_pages_per_slice=max(1, int(value.get("discovery_max_pages_per_slice", 2000))),
        )


SOURCE_KEYS = {field.name for field in fields(SourceConfig)}
BOOL_KEYS = {"active", "baseline_on_first_run", "use_http_discovery", "register_discovered_urls"}
INT_KEYS = {
    "max_urls", "crawl_depth", "discovery_attempts", "discovery_timeout_seconds", "discovery_retry_delay_seconds",
    "discovery_http_timeout_seconds", "discovery_http_workers", "discovery_http_attempts",
    "discovery_slice_seconds", "discovery_max_pages_per_slice",
}
LIST_KEYS = {
    "seed_urls", "allowed_prefixes", "allowed_domains", "allowed_urls", "excluded_urls", "allowed_resource_prefixes",
    "resource_link_text_patterns", "ignore_selectors", "excluded_prefixes",
}
TOP_LEVEL_KEYS = {"version", "defaults", "sources"}
DEFAULT_KEYS = {
    "fetch_timeout_seconds", "fetch_attempts", "fetch_backoff_seconds", "ai_concurrency",
    "ai_timeout_seconds", "ai_attempts", "max_ai_candidates", "max_diff_lines", "max_ai_chars",
    "history_runs", "fetch_workers", "conditional_refresh_interval_hours", "max_removal_ratio",
    "max_response_bytes",
}


def _validate_source_types(value: dict[str, Any]) -> None:
    """Reject configuration that would otherwise be silently misread.

    Unknown keys (typos such as "allowed_url") used to be ignored, the string
    "false" parsed as active, and bad link-text regexes only failed mid-crawl.
    """
    sid = value.get("id", "<unknown>")
    unknown = sorted(set(value) - SOURCE_KEYS)
    if unknown:
        raise ValueError(f"Source {sid}: unknown configuration keys: {', '.join(unknown)}")
    for key in BOOL_KEYS & set(value):
        if not isinstance(value[key], bool):
            raise ValueError(f"Source {sid}: {key} must be true or false, not {value[key]!r}")
    for key in INT_KEYS & set(value):
        if isinstance(value[key], bool) or not isinstance(value[key], int):
            raise ValueError(f"Source {sid}: {key} must be an integer, not {value[key]!r}")
    if "crawl_depth" in value and value["crawl_depth"] not in {-1, 0, 1, 2, 3}:
        raise ValueError(f"Source {sid}: crawl_depth must be -1 (legacy unlimited) or 0, 1, 2, or 3")
    for key in LIST_KEYS & set(value):
        if not isinstance(value[key], list) or not all(isinstance(item, str) for item in value[key]):
            raise ValueError(f"Source {sid}: {key} must be a list of strings")
    for pattern in value.get("resource_link_text_patterns", []):
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ValueError(f"Source {sid}: invalid resource_link_text_patterns entry {pattern!r}: {exc}") from exc


def validate_config(payload: dict[str, Any], sources: list[SourceConfig]) -> None:
    unknown = sorted(set(payload) - TOP_LEVEL_KEYS)
    if unknown:
        raise ValueError(f"Unknown top-level configuration keys: {', '.join(unknown)}")
    defaults = payload.get("defaults", {})
    if not isinstance(defaults, dict):
        raise ValueError("defaults must be an object")
    unknown_defaults = sorted(set(defaults) - DEFAULT_KEYS)
    if unknown_defaults:
        raise ValueError(f"Unknown defaults keys: {', '.join(unknown_defaults)}")
    seen: set[str] = set()
    for source in sources:
        if source.id in seen:
            raise ValueError(f"Duplicate source id: {source.id}")
        seen.add(source.id)
    from regmon.discovery import canonical, in_scope

    for source in sources:
        if not source.active:
            continue
        outside = [url for url in source.seed_urls if not in_scope(canonical(url), source)]
        if outside:
            raise ValueError(f"Source {source.id}: seed URLs outside its own scope: {', '.join(outside)}")


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> tuple[dict[str, Any], dict[str, SourceConfig]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("sources", []), list):
        raise ValueError("Configuration must be an object with a sources list")
    items = [SourceConfig.from_dict(value) for value in payload.get("sources", [])]
    validate_config(payload, items)
    sources = {item.id: item for item in items}
    if not sources:
        raise ValueError("At least one monitoring source must be configured")
    return payload, sources


def get_source(source_id: str, path: Path = DEFAULT_CONFIG_PATH) -> SourceConfig | None:
    _, sources = load_config(path)
    if source_id in {"all", "*"}:
        return None
    try:
        return sources[source_id]
    except KeyError as exc:
        raise ValueError(f"Unknown source_id: {source_id}") from exc
