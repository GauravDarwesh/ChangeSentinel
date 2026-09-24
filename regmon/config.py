"""Configuration for the regulatory monitoring engine."""
from __future__ import annotations

import json
from dataclasses import dataclass
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
    max_urls: int = 0
    crawler: str = "stealth-crawler"
    active: bool = True
    baseline_on_first_run: bool = False
    excluded_prefixes: tuple[str, ...] = ()
    discovery_attempts: int = 1
    discovery_timeout_seconds: int = 180
    discovery_retry_delay_seconds: int = 5
    use_http_discovery: bool = True
    discovery_http_timeout_seconds: int = 20
    discovery_http_workers: int = 12

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SourceConfig":
        required = ("id", "name", "regulator", "seed_urls", "allowed_prefixes", "allowed_domains")
        missing = [key for key in required if not value.get(key)]
        if missing:
            raise ValueError(f"Source configuration missing: {', '.join(missing)}")
        return cls(
            id=str(value["id"]),
            name=str(value["name"]),
            regulator=str(value["regulator"]),
            seed_urls=tuple(str(x) for x in value["seed_urls"]),
            allowed_prefixes=tuple(str(x).rstrip("/") + "/" for x in value["allowed_prefixes"]),
            allowed_domains=tuple(str(x).lower() for x in value["allowed_domains"]),
            max_urls=int(value.get("max_urls", 0)),
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
            discovery_http_workers=max(1, int(value.get("discovery_http_workers", 12))),
        )


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> tuple[dict[str, Any], dict[str, SourceConfig]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    sources = {item.id: item for item in (SourceConfig.from_dict(v) for v in payload.get("sources", []))}
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
