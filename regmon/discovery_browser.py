"""Optional browser-based discovery fallback and metadata helpers."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from regmon.config import SourceConfig
from regmon.discovery import canonical, parse_discovered_urls


def _stealth_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Run stealth-crawler as an optional browser fallback/enrichment path."""
    attempts_log, discovered, seen = [], [], set()

    for seed in source.seed_urls:
        cmd = [
            source.crawler,
            "crawl",
            seed,
            "--base",
            source.allowed_prefixes[0],
            "--urls-only",
        ]
        if source.excluded_prefixes:
            cmd.extend([
                "--exclude",
                ",".join(
                    canonical(prefix).rstrip("/")
                    for prefix in source.excluded_prefixes
                ),
            ])

        seed_urls = []
        for attempt in range(1, source.discovery_attempts + 1):
            try:
                result = subprocess.run(
                    cmd,
                    text=True,
                    capture_output=True,
                    check=False,
                    timeout=source.discovery_timeout_seconds,
                )
                stdout, stderr = result.stdout or "", result.stderr or ""
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"EXIT_CODE={result.returncode}",
                    "STDOUT:",
                    stdout,
                    "STDERR:",
                    stderr,
                ]))
                seed_urls = parse_discovered_urls(stdout + "\n" + stderr, source)
                if seed_urls:
                    break
            except subprocess.TimeoutExpired as exc:
                out, err = exc.stdout or "", exc.stderr or ""
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"TIMEOUT_AFTER_SECONDS={source.discovery_timeout_seconds}",
                    "STDOUT:",
                    out if isinstance(out, str) else out.decode("utf-8", "replace"),
                    "STDERR:",
                    err if isinstance(err, str) else err.decode("utf-8", "replace"),
                ]))
            if attempt < source.discovery_attempts and not seed_urls:
                import time
                time.sleep(source.discovery_retry_delay_seconds)

        for url in seed_urls:
            if url not in seen:
                seen.add(url)
                discovered.append(url)
                if source.max_urls > 0 and len(discovered) >= source.max_urls:
                    break
        if source.max_urls > 0 and len(discovered) >= source.max_urls:
            break

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "stealth-output.txt").write_text(
        "\n\n".join(attempts_log),
        encoding="utf-8",
    )
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / f"{source.id}.json").write_text(
        json.dumps({
            "source_id": source.id,
            "method": "stealth-fallback",
            "state": "DEGRADED" if discovered else "FAILED",
            "discovered": len(discovered),
            "successful_pages": len(discovered),
            "failed_pages": 0 if discovered else 1,
        }, indent=2),
        encoding="utf-8",
    )
    return discovered


def write_combined_discovery_metadata(
    source: SourceConfig,
    data_dir: Path,
    http_meta: dict,
    http_urls: list[str],
    stealth_urls: list[str],
) -> None:
    state = http_meta.get("state", "FAILED")
    if state == "COMPLETE":
        final_state = "COMPLETE"
    elif http_urls or stealth_urls:
        final_state = "DEGRADED"
    else:
        final_state = "FAILED"
    payload = {
        "source_id": source.id,
        "method": "http+stealth-enrichment",
        "state": final_state,
        "discovered": len(dict.fromkeys(http_urls + stealth_urls)),
        "http_discovered": len(http_urls),
        "stealth_discovered": len(stealth_urls),
        "http_state": http_meta.get("state"),
        "http_successful_pages": http_meta.get("successful_pages", 0),
        "http_failed_pages": http_meta.get("failed_pages", 0),
        "http_capped": http_meta.get("capped", False),
    }
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / f"{source.id}.json").write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )
