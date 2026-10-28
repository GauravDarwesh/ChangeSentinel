"""Optional browser-based discovery fallback and metadata helpers."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from regmon.config import SourceConfig
from regmon.fsutil import atomic_write_text
from regmon.discovery import canonical, parse_discovered_urls


def _stealth_discover(source: SourceConfig, data_dir: Path) -> list[str]:
    """Run stealth-crawler and record whether every requested seed completed."""
    import time

    attempts_log, discovered, seen = [], [], set()
    successful_seeds = 0
    failed_seeds = 0
    capped = False

    from regmon.config import ALLOWED_CRAWLERS

    if source.crawler not in ALLOWED_CRAWLERS:
        raise ValueError(f"Unknown crawler {source.crawler!r}; refusing to run it")
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
        seed_succeeded = False
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
                attempt_urls = parse_discovered_urls(stdout + "\n" + stderr, source)
                if result.returncode == 0:
                    # Only a zero exit status establishes successful coverage.
                    # A successful empty result is still a completed seed crawl.
                    seed_urls = attempt_urls
                    seed_succeeded = True
                    break
                # Preserve useful partial results for reporting, but retry and
                # keep the inventory DEGRADED if every attempt exits non-zero.
                seed_urls = list(dict.fromkeys(seed_urls + attempt_urls))
            except subprocess.TimeoutExpired as exc:
                out, err = exc.stdout or "", exc.stderr or ""
                out = out if isinstance(out, str) else out.decode("utf-8", "replace")
                err = err if isinstance(err, str) else err.decode("utf-8", "replace")
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"TIMEOUT_AFTER_SECONDS={source.discovery_timeout_seconds}",
                    "STDOUT:",
                    out,
                    "STDERR:",
                    err,
                ]))
                partial_urls = parse_discovered_urls(out + "\n" + err, source)
                seed_urls = list(dict.fromkeys(seed_urls + partial_urls))
            except (OSError, subprocess.SubprocessError) as exc:
                attempts_log.append("\n".join([
                    f"SOURCE={source.id}",
                    f"SEED={seed}",
                    f"ATTEMPT={attempt}",
                    f"ERROR={type(exc).__name__}: {exc}",
                ]))
            if attempt < source.discovery_attempts and not seed_succeeded:
                time.sleep(source.discovery_retry_delay_seconds)

        if seed_succeeded:
            successful_seeds += 1
        else:
            failed_seeds += 1

        for url in seed_urls:
            if url not in seen:
                seen.add(url)
                discovered.append(url)
                if source.max_urls > 0 and len(discovered) >= source.max_urls:
                    capped = True
                    break
        if source.max_urls > 0 and len(discovered) >= source.max_urls:
            # As with HTTP discovery, a configured cap is not proof that the
            # frontier was exhausted; retain URLs but prevent baseline updates.
            capped = True
            break

    if discovered and failed_seeds == 0 and not capped:
        state = "COMPLETE"
    elif discovered:
        state = "DEGRADED"
    else:
        state = "FAILED"

    data_dir.mkdir(parents=True, exist_ok=True)
    # Crawler stdout/stderr belongs in the job log, not in data/: everything
    # under data/ is committed and published, and one shared file was
    # overwritten by every source that used browser discovery.
    print("\n\n".join(attempts_log))
    discovery_dir = data_dir / "discovery"
    discovery_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_text(
        discovery_dir / f"{source.id}.json",
        json.dumps({
            "source_id": source.id,
            "method": "stealth",
            "state": state,
            "discovered": len(discovered),
            "successful_pages": successful_seeds,
            "failed_pages": failed_seeds,
            "successful_seeds": successful_seeds,
            "failed_seeds": failed_seeds,
            "attempted_seeds": successful_seeds + failed_seeds,
            "capped": capped,
        }, indent=2),
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
    atomic_write_text(
        discovery_dir / f"{source.id}.json",
        json.dumps(payload, indent=2),
    )
