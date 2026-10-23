"""Regulator discovery profiles (config/scout.json).

A profile declares where a regulator publishes: feeds, sitemaps and listing
pages, plus the hosts Scout may read and a few optional path hints. Adding a
regulator is a configuration change, never a crawler rewrite.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

REGIONS = ("NAM", "LATAM", "EMEA", "APAC", "OTHER")
CHANNEL_TYPES = ("sitemap", "feed", "listing")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Defaults:
    min_delay_seconds: float = 3.0
    max_crawl_delay_seconds: float = 30.0
    request_timeout_seconds: float = 30.0
    max_requests_per_regulator: int = 60
    max_seconds_per_regulator: float = 900.0
    max_response_bytes: int = 15_000_000
    max_sitemap_urls: int = 100_000
    max_child_sitemaps: int = 50
    max_enrich_per_regulator: int = 25
    retry_after_cap_seconds: float = 120.0
    review_new_days: int = 120
    review_backlog_limit: int = 150
    history_sweeps: int = 52


@dataclass(frozen=True)
class Pagination:
    param: str
    start: int = 0
    step: int = 1
    max_pages: int = 5
    baseline_pages: int = 2


@dataclass(frozen=True)
class Channel:
    id: str
    type: str
    url: str
    label: str
    required: bool = True
    content_selector: str = ""
    link_prefixes: tuple[str, ...] = ()
    exclude_link_patterns: tuple[str, ...] = ()
    pagination: Pagination | None = None
    newest_first: bool = False
    # Optional recursive link discovery for user-configured listing roots.
    # None preserves the existing one-page listing behaviour.
    crawl_depth: int | None = None
    # Optional for depth-limited listings only. explore_prefixes narrows which
    # HTML pages are fetched to find more links (empty: any in-scope page, the
    # original behaviour); candidates are still governed by link_prefixes.
    # document_hosts lets document links (PDF, spreadsheet, ...) on another
    # declared host surface as candidates. Those hosts are never fetched.
    explore_prefixes: tuple[str, ...] = ()
    document_hosts: tuple[str, ...] = ()


@dataclass(frozen=True)
class PathHint:
    prefix: str
    publication_type: str = ""
    topic: str = ""
    effect: str = "positive"  # positive | negative


@dataclass(frozen=True)
class Regulator:
    id: str
    name: str
    short_name: str
    region: str
    jurisdiction: str
    hosts: tuple[str, ...]
    channels: tuple[Channel, ...]
    active: bool = True
    languages: tuple[str, ...] = ("en",)
    review_languages: tuple[str, ...] = ("en",)
    language_paths: dict = field(default_factory=dict)
    https_hosts: frozenset[str] = frozenset()
    path_hints: tuple[PathHint, ...] = ()
    exclude_paths: tuple[str, ...] = ()
    known_gaps: tuple[str, ...] = ()
    relevant_keywords: tuple[str, ...] = ()
    exclude_keywords: tuple[str, ...] = ()
    max_requests: int | None = None
    max_seconds: float | None = None


@dataclass(frozen=True)
class Objective:
    id: str
    description: str
    priority_types: tuple[str, ...]
    out_of_objective_types: tuple[str, ...]


@dataclass(frozen=True)
class ScoutConfig:
    defaults: Defaults
    objective: Objective
    regulators: tuple[Regulator, ...]

    def regulator(self, regulator_id: str) -> Regulator:
        for regulator in self.regulators:
            if regulator.id == regulator_id:
                return regulator
        raise KeyError(regulator_id)

    def selected(self, requested: str | None) -> list[Regulator]:
        active = [regulator for regulator in self.regulators if regulator.active]
        value = str(requested or "all").strip()
        if value in {"", "all", "*"}:
            return active
        wanted = {item.strip() for item in value.split(",") if item.strip()}
        unknown = wanted - {regulator.id for regulator in self.regulators}
        if unknown:
            raise ConfigError("Unknown Scout regulator id(s): " + ", ".join(sorted(unknown)))
        return [regulator for regulator in active if regulator.id in wanted]


def _strings(value, label: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ConfigError(f"{label} must be a list of non-empty strings")
    return tuple(item.strip() for item in value)


def _url(value, label: str, hosts: tuple[str, ...]) -> str:
    text = str(value or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigError(f"{label} must be an absolute http(s) URL")
    if parsed.username or parsed.password:
        raise ConfigError(f"{label} must not contain credentials")
    if parsed.hostname.lower() not in hosts:
        raise ConfigError(f"{label} host {parsed.hostname} is not one of the regulator hosts")
    return text


def _positive(value, default, label: str, kind=int):
    if value is None:
        return default
    try:
        number = kind(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{label} must be a number") from exc
    if number <= 0:
        raise ConfigError(f"{label} must be positive")
    return number


def _channel(raw: dict, regulator_id: str, hosts: tuple[str, ...], seen: set[str]) -> Channel:
    if not isinstance(raw, dict):
        raise ConfigError(f"{regulator_id}: each channel must be an object")
    channel_id = str(raw.get("id") or "")
    if not ID_RE.match(channel_id):
        raise ConfigError(f"{regulator_id}: channel id {channel_id!r} must be lowercase letters, digits and hyphens")
    if channel_id in seen:
        raise ConfigError(f"Duplicate Scout channel id {channel_id}")
    seen.add(channel_id)
    kind = str(raw.get("type") or "")
    if kind not in CHANNEL_TYPES:
        raise ConfigError(f"{channel_id}: type must be one of {', '.join(CHANNEL_TYPES)}")
    label = str(raw.get("label") or "").strip()
    if not label:
        raise ConfigError(f"{channel_id}: label is required")
    pagination = None
    if raw.get("pagination") is not None:
        page = raw["pagination"]
        if kind != "listing" or not isinstance(page, dict):
            raise ConfigError(f"{channel_id}: pagination applies only to listing channels")
        param = str(page.get("param") or "")
        if not re.fullmatch(r"[A-Za-z0-9_\-\[\]]{1,40}", param):
            raise ConfigError(f"{channel_id}: pagination.param is invalid")
        pagination = Pagination(
            param=param,
            start=int(page.get("start", 0)),
            step=_positive(page.get("step"), 1, f"{channel_id}: pagination.step"),
            max_pages=_positive(page.get("max_pages"), 5, f"{channel_id}: pagination.max_pages"),
            baseline_pages=_positive(page.get("baseline_pages"), 2, f"{channel_id}: pagination.baseline_pages"),
        )
        if pagination.max_pages > 50 or pagination.baseline_pages > pagination.max_pages:
            raise ConfigError(f"{channel_id}: pagination pages must satisfy baseline_pages <= max_pages <= 50")
    if pagination and not raw.get("newest_first"):
        raise ConfigError(f"{channel_id}: paginated listings must declare newest_first so Scout knows when it has caught up")
    depth_value = raw.get("crawl_depth")
    crawl_depth = None
    if depth_value is not None:
        if kind != "listing":
            raise ConfigError(f"{channel_id}: crawl_depth applies only to listing channels")
        if type(depth_value) is not int or not 1 <= depth_value <= 3:
            raise ConfigError(f"{channel_id}: crawl_depth must be an integer from 1 to 3")
        crawl_depth = depth_value
    patterns = _strings(raw.get("exclude_link_patterns"), f"{channel_id}: exclude_link_patterns")
    for pattern in patterns:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ConfigError(f"{channel_id}: invalid exclude_link_patterns entry {pattern!r}: {exc}") from exc
    prefixes = tuple(_url(prefix, f"{channel_id}: link_prefixes", hosts) for prefix in _strings(raw.get("link_prefixes"), f"{channel_id}: link_prefixes"))
    selector = str(raw.get("content_selector") or "").strip()
    if len(selector) > 200:
        raise ConfigError(f"{channel_id}: content_selector is too long")
    explore = tuple(_url(prefix, f"{channel_id}: explore_prefixes", hosts)
                    for prefix in _strings(raw.get("explore_prefixes"), f"{channel_id}: explore_prefixes"))
    document_hosts = tuple(item.lower().rstrip(".") for item in _strings(raw.get("document_hosts"), f"{channel_id}: document_hosts"))
    if (explore or document_hosts) and crawl_depth is None:
        raise ConfigError(f"{channel_id}: explore_prefixes and document_hosts apply only to depth-limited listings (crawl_depth)")
    if len(explore) > 10 or len(document_hosts) > 10:
        raise ConfigError(f"{channel_id}: at most 10 explore_prefixes and 10 document_hosts are allowed")
    for item in document_hosts:
        if "/" in item or ":" in item or "." not in item or not re.fullmatch(r"[a-z0-9.-]+", item):
            raise ConfigError(f"{channel_id}: document host {item!r} must be a bare hostname")
    return Channel(
        id=channel_id,
        type=kind,
        url=_url(raw.get("url"), f"{channel_id}: url", hosts),
        label=label,
        required=bool(raw.get("required", True)),
        content_selector=selector,
        link_prefixes=prefixes,
        exclude_link_patterns=patterns,
        pagination=pagination,
        newest_first=bool(raw.get("newest_first", False)),
        crawl_depth=crawl_depth,
        explore_prefixes=explore,
        document_hosts=document_hosts,
    )


def _regulator(raw: dict, channel_ids: set[str], regulator_ids: set[str]) -> Regulator:
    if not isinstance(raw, dict):
        raise ConfigError("Each regulator must be an object")
    regulator_id = str(raw.get("id") or "")
    if not ID_RE.match(regulator_id):
        raise ConfigError(f"Regulator id {regulator_id!r} must be lowercase letters, digits and hyphens")
    if regulator_id in regulator_ids:
        raise ConfigError(f"Duplicate Scout regulator id {regulator_id}")
    regulator_ids.add(regulator_id)
    region = str(raw.get("region") or "")
    if region not in REGIONS:
        raise ConfigError(f"{regulator_id}: region must be one of {', '.join(REGIONS)}")
    hosts = tuple(item.lower().rstrip(".") for item in _strings(raw.get("hosts"), f"{regulator_id}: hosts"))
    if not hosts:
        raise ConfigError(f"{regulator_id}: at least one host is required")
    for item in hosts:
        if "/" in item or ":" in item or "." not in item:
            raise ConfigError(f"{regulator_id}: host {item!r} must be a bare hostname")
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, list) or not channels_raw:
        raise ConfigError(f"{regulator_id}: at least one channel is required")
    channels = tuple(_channel(item, regulator_id, hosts, channel_ids) for item in channels_raw)
    hints = []
    for item in raw.get("path_hints") or []:
        if not isinstance(item, dict) or not str(item.get("prefix") or "").startswith("/"):
            raise ConfigError(f"{regulator_id}: path_hints entries need a prefix starting with /")
        effect = str(item.get("effect") or "positive")
        if effect not in {"positive", "negative"}:
            raise ConfigError(f"{regulator_id}: path hint effect must be positive or negative")
        hint = PathHint(prefix=item["prefix"], publication_type=str(item.get("publication_type") or ""),
                        topic=str(item.get("topic") or ""), effect=effect)
        from regmon.scout.assess import PUBLICATION_TYPES, TOPICS

        if hint.publication_type and hint.publication_type not in {kind.id for kind in PUBLICATION_TYPES}:
            raise ConfigError(f"{regulator_id}: unknown publication type {hint.publication_type!r} in path_hints")
        if hint.topic and hint.topic not in {kind.id for kind in TOPICS}:
            raise ConfigError(f"{regulator_id}: unknown topic {hint.topic!r} in path_hints")
        hints.append(hint)
    language_paths = raw.get("language_paths") or {}
    if not isinstance(language_paths, dict) or not all(
        isinstance(key, str) and isinstance(value, str) and value.startswith("/") for key, value in language_paths.items()
    ):
        raise ConfigError(f"{regulator_id}: language_paths maps a language code to a path prefix")
    https_hosts = frozenset(hosts) if raw.get("prefer_https") else frozenset()
    keywords = raw.get("keywords") or {}
    if not isinstance(keywords, dict) or set(keywords) - {"relevant", "exclude"}:
        raise ConfigError(f"{regulator_id}: keywords must be an object with optional relevant and exclude lists")
    relevant_keywords = _strings(keywords.get("relevant"), f"{regulator_id}: keywords.relevant")
    exclude_keywords = _strings(keywords.get("exclude"), f"{regulator_id}: keywords.exclude")
    for term in relevant_keywords + exclude_keywords:
        if len(term) > 80:
            raise ConfigError(f"{regulator_id}: keyword {term[:20]!r}… is longer than 80 characters")
    overlap = {term.lower() for term in relevant_keywords} & {term.lower() for term in exclude_keywords}
    if overlap:
        raise ConfigError(f"{regulator_id}: keywords cannot be both relevant and excluded: {', '.join(sorted(overlap))}")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ConfigError(f"{regulator_id}: name is required")
    return Regulator(
        id=regulator_id,
        name=name,
        short_name=str(raw.get("short_name") or name).strip(),
        region=region,
        jurisdiction=str(raw.get("jurisdiction") or "").strip(),
        hosts=hosts,
        channels=channels,
        active=bool(raw.get("active", True)),
        languages=_strings(raw.get("languages"), f"{regulator_id}: languages") or ("en",),
        review_languages=_strings(raw.get("review_languages"), f"{regulator_id}: review_languages") or ("en",),
        language_paths=dict(language_paths),
        https_hosts=https_hosts,
        path_hints=tuple(hints),
        exclude_paths=_strings(raw.get("exclude_paths"), f"{regulator_id}: exclude_paths"),
        known_gaps=_strings(raw.get("known_gaps"), f"{regulator_id}: known_gaps"),
        relevant_keywords=relevant_keywords,
        exclude_keywords=exclude_keywords,
        max_requests=_positive(raw.get("max_requests"), None, f"{regulator_id}: max_requests"),
        max_seconds=_positive(raw.get("max_seconds"), None, f"{regulator_id}: max_seconds", float),
    )


def parse_config(data: dict) -> ScoutConfig:
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ConfigError("config/scout.json must be an object with schema_version 1")
    raw_defaults = data.get("defaults") or {}
    if not isinstance(raw_defaults, dict):
        raise ConfigError("defaults must be an object")
    known = Defaults.__dataclass_fields__
    unknown = set(raw_defaults) - set(known)
    if unknown:
        raise ConfigError("Unknown Scout defaults: " + ", ".join(sorted(unknown)))
    values = {}
    for key, spec in known.items():
        if key in raw_defaults:
            kind = float if isinstance(spec.default, float) else int
            values[key] = _positive(raw_defaults[key], spec.default, f"defaults.{key}", kind)
    defaults = Defaults(**values)
    raw_objective = data.get("objective") or {}
    objective = Objective(
        id=str(raw_objective.get("id") or "default"),
        description=str(raw_objective.get("description") or ""),
        priority_types=_strings(raw_objective.get("priority_types"), "objective.priority_types"),
        out_of_objective_types=_strings(raw_objective.get("out_of_objective_types"), "objective.out_of_objective_types"),
    )
    regulators_raw = data.get("regulators")
    if not isinstance(regulators_raw, list) or not regulators_raw:
        raise ConfigError("regulators must be a non-empty list")
    channel_ids: set[str] = set()
    regulator_ids: set[str] = set()
    regulators = tuple(_regulator(item, channel_ids, regulator_ids) for item in regulators_raw)
    return ScoutConfig(defaults=defaults, objective=objective, regulators=regulators)


def load_config(path: str | Path) -> ScoutConfig:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"Could not read Scout configuration {path}: {exc}") from exc
    return parse_config(data)
