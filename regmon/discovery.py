"""URL discovery and canonicalization."""
from __future__ import annotations

import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from regmon.config import SourceConfig

TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}

def canonical(url: str) -> str:
    url = str(url).split("#", 1)[0].strip()
    parsed = urlparse(url)
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    params = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key.lower().startswith("utm_") or key.lower() in TRACKING_PARAMS:
            continue
        params.append((key, value))
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        path,
        "",
        urlencode(sorted(params), doseq=True),
        "",
    ))

def in_scope(url: str, source: SourceConfig) -> bool:
    value = canonical(url)
    host = urlparse(value).netloc.lower()
    if host not in source.allowed_domains:
        return False
    if not any(value.startswith(prefix) for prefix in source.allowed_prefixes):
        return False
    if any(value == prefix.rstrip("/") or value.startswith(prefix) for prefix in source.excluded_prefixes):
        return False
    return True

def parse_discovered_urls(output: str, source: SourceConfig) -> list[str]:
    urls, seen = [], set()
    for line in output.splitlines():
        value = line.strip()
        if not value.startswith(("http://", "https://")):
            continue
        value = canonical(value)
        if in_scope(value, source) and value not in seen:
            seen.add(value)
            urls.append(value)
        if source.max_urls > 0 and len(urls) >= source.max_urls:
            break
    return urls

def discover(source: SourceConfig, data_dir: Path) -> list[str]:
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
                ",".join(urlparse(prefix).path.rstrip("/") or "/" for prefix in source.excluded_prefixes),
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
                seed_urls = parse_discovered_urls(stdout, source)
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
    (data_dir / "stealth-output.txt").write_text("\n\n".join(attempts_log), encoding="utf-8")
    if not discovered:
        raise RuntimeError(
            f"No in-scope URLs discovered for {source.id} after {source.discovery_attempts} attempts; "
            "state was not updated."
        )
    return discovered
