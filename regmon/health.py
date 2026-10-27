"""Fleet health ledger: data/health.json.

One file that answers the questions a team running hundreds of monitors asks
every morning: which monitors are failing and since when, which have not been
scanned, which have gone quiet for weeks (and may point at a retired or
year-stamped page), and how many checks, changes and alerts the fleet produced.

Everything is derived from committed state (config/sources.json,
data/latest.json, data/history/index.json, data/notifications.json), so the
file can be rebuilt at any time and never feeds back into detection.

    python -m regmon.health --data-dir data --config config/sources.json
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from regmon import botcheck, schedule
from regmon.fsutil import atomic_write_text

HEALTH_SCHEMA_VERSION = 1
# A monitor that has been watched this long without a content change is listed
# as inactive (Visualping's equivalent flags pages after weeks without change).
INACTIVE_AFTER_DAYS = 45
# Two missed six-hourly slots, matching the Monitor Freshness Check workflow.
STALE_AFTER_HOURS = 14
SERIES_DAYS = 14
CHECK_COUNT_KEYS = (
    "new", "changed", "source_changed", "unchanged", "baseline_migration",
    "fetch_error", "extraction_error",
)
FAILURE_KEYS = ("fetch_error", "extraction_error")
# New pages are mostly quiet baselines of freshly registered monitors, so they
# are not counted as changes.
CHANGE_KEYS = ("changed", "removed")
YEAR_IN_URL = re.compile(r"(?<![0-9])(20[0-9]{2})(?![0-9])")


def _parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _host(url) -> str:
    from urllib.parse import urlsplit

    try:
        return (urlsplit(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _sum(counts: dict, keys) -> int:
    total = 0
    for key in keys:
        try:
            total += int((counts or {}).get(key, 0) or 0)
        except (TypeError, ValueError):
            continue
    return total


def year_bound(url: str, now: datetime) -> int | None:
    """The latest past year stamped in a URL path, if any (e.g. circulares-2025)."""
    years = [int(match) for match in YEAR_IN_URL.findall(url or "")]
    past = [year for year in years if 2000 <= year < now.year]
    return max(past) if past and max(years) < now.year else None


def build_health(config: dict, latest: dict, history: list, ledger: dict, now: datetime) -> dict:
    sources = {
        str(source.get("id")): source
        for source in (config.get("sources") or [])
        if isinstance(source, dict) and source.get("active", True)
    }
    inventories = (latest or {}).get("sources") or {}
    runs_by_source: dict[str, list[dict]] = {}
    for entry in history if isinstance(history, list) else []:
        if isinstance(entry, dict) and str(entry.get("source_id")) in sources:
            runs_by_source.setdefault(str(entry["source_id"]), []).append(entry)
    for entries in runs_by_source.values():
        entries.sort(key=lambda entry: str(entry.get("generated_at") or ""), reverse=True)

    week_ago = now - timedelta(days=7)
    monitors, failing, stale, inactive, year_flags, protected = [], [], [], [], [], []
    # A refusal is the site blocking us only when several pages on that host
    # are refused; one refused page is more likely removed or made private.
    refused_pages: dict[str, int] = {}
    for source_id in sources:
        for row in (inventories.get(source_id) or {}).values():
            if isinstance(row, dict) and row.get("active", True) and str(row.get("fetch_error") or "").startswith("AccessRefusedError"):
                host = _host(row.get("canonical_url"))
                refused_pages[host] = refused_pages.get(host, 0) + 1
    cadences: dict[str, tuple] = {}
    for source_id in sorted(sources):
        source = sources[source_id]
        rows = [
            row for row in (inventories.get(source_id) or {}).values()
            if isinstance(row, dict) and row.get("active", True)
        ]
        runs = runs_by_source.get(source_id, [])
        last_scan = _parse_time(runs[0].get("generated_at")) if runs else None
        runs_7d = [run for run in runs if (_parse_time(run.get("generated_at")) or now) >= week_ago]
        checks_7d = sum(_sum(run.get("counts"), CHECK_COUNT_KEYS) for run in runs_7d)
        failures_7d = sum(_sum(run.get("counts"), FAILURE_KEYS) for run in runs_7d)
        last_change = max(
            (stamp for stamp in (_parse_time(row.get("last_changed_at")) for row in rows) if stamp),
            default=None,
        )
        watched_since = min(
            (stamp for stamp in (_parse_time(row.get("first_seen")) for row in rows) if stamp),
            default=None,
        )
        quiet_since = last_change or watched_since
        days_quiet = (now - quiet_since).days if quiet_since else None
        name = str(source.get("name") or source_id)
        status = "healthy"
        errors = []
        waiting = []
        for row in rows:
            message = row.get("fetch_error") or row.get("extraction_error")
            if not message:
                continue
            since = _parse_time(row.get("error_since"))
            runs_failing = sum(
                1 for run in runs if since and (_parse_time(run.get("generated_at")) or now) >= since
            ) if since else None
            lone_refusal = (str(row.get("fetch_error") or "").startswith("AccessRefusedError")
                            and refused_pages.get(_host(row.get("canonical_url")), 0) < 2)
            if lone_refusal:
                message = (f"{botcheck.vendor_in(row['fetch_error'])} for this page, also in a browser, while other pages on "
                           f"{_host(row.get('canonical_url'))} are not refused: it may have been removed or made private")
            elif row.get("fetch_error") and botcheck.is_error(row["fetch_error"]):
                # A site showing a bot check (or refusing every page): the scan
                # retries in a browser and keeps the last good copy, so it is a
                # wait, not yet a failure.
                hours = round((now - since).total_seconds() / 3600, 1) if since else None
                vendor = botcheck.vendor_in(row["fetch_error"])
                what = botcheck.reason(row["fetch_error"])
                if botcheck.within_grace(hours):
                    waiting.append({
                        "source_id": source_id, "name": name, "url": row.get("canonical_url"),
                        "vendor": vendor, "reason": what, "since": _iso(since), "hours": hours, "runs": runs_failing,
                        "has_baseline": bool(row.get("normalized_hash")),
                    })
                    continue
                message = (f"Blocked by {what} for {round(hours or 0)} h that the automatic browser "
                           "could not get past; the last good copy is kept and every scan retries")
            errors.append({
                "source_id": source_id,
                "name": name,
                "url": row.get("canonical_url"),
                "kind": "FETCH_ERROR" if row.get("fetch_error") else "EXTRACTION_ERROR",
                "error": str(message)[:300],
                "since": _iso(since),
                "hours": round((now - since).total_seconds() / 3600, 1) if since else None,
                "runs": runs_failing,
            })
        # Overdue is judged against the monitor's own cadence: a weekly monitor
        # scanned four days ago is on time.
        cadence = schedule.Cadence.from_source(source)
        overdue_at = schedule.overdue_after(cadence, last_scan, now)
        protected.extend(waiting)
        if errors:
            status = "failing"
            failing.extend(errors)
        elif waiting:
            status = "protected"
        elif last_scan is None or (overdue_at is not None and now > overdue_at):
            status = "stale"
            stale.append({"source_id": source_id, "name": name, "last_scan": _iso(last_scan),
                          "cadence": cadence.describe(), "overdue_since": _iso(overdue_at)})
        elif watched_since and days_quiet is not None and days_quiet >= INACTIVE_AFTER_DAYS \
                and (now - watched_since).days >= INACTIVE_AFTER_DAYS:
            status = "inactive"
            inactive.append({
                "source_id": source_id, "name": name, "days_without_change": days_quiet,
                "last_change": _iso(last_change), "checks_7d": checks_7d,
            })
        stamped = sorted({
            year for year in (year_bound(row.get("canonical_url") or "", now) for row in rows) if year
        } | ({year_bound(str((source.get("seed_urls") or [""])[0]), now)} - {None}))
        if stamped and (days_quiet is None or days_quiet >= 30):
            year_flags.append({
                "source_id": source_id, "name": name, "years": stamped,
                "url": str((source.get("seed_urls") or [""])[0]),
                "days_without_change": days_quiet,
            })
        monitors.append({
            "source_id": source_id,
            "name": name,
            "regulator": str(source.get("regulator") or ""),
            "status": status,
            "pages": len(rows),
            "last_scan": _iso(last_scan),
            "last_change": _iso(last_change),
            "days_without_change": days_quiet,
            "checks_7d": checks_7d,
            "failures_7d": failures_7d,
            "alert_condition": bool(source.get("alert_condition")),
            "shadow": source.get("shadow") is True,
            "cadence": cadence.as_dict(),
            "next_due": _iso(schedule.next_due(cadence, last_scan, now)),
            "overdue_after": _iso(overdue_at),
        })
        cadences[source_id] = (cadence, last_scan, len(rows))

    def window(days: int) -> dict:
        start = now - timedelta(days=days)
        runs = [
            run for entries in runs_by_source.values() for run in entries
            if (_parse_time(run.get("generated_at")) or now) >= start
        ]
        checks = sum(_sum(run.get("counts"), CHECK_COUNT_KEYS) for run in runs)
        failures = sum(_sum(run.get("counts"), FAILURE_KEYS) for run in runs)
        sent = [
            record for record in ((ledger or {}).get("sent_events") or {}).values()
            if isinstance(record, dict) and (_parse_time(record.get("sent_at")) or start) > start
            and record.get("kind") != "TEST"
        ]
        return {
            "source_runs": len(runs),
            "checks": checks,
            "failed_checks": failures,
            "success_rate": round(1 - failures / checks, 4) if checks else None,
            "changes": sum(_sum(run.get("counts"), CHANGE_KEYS) for run in runs),
            "alerts_sent": len(sent),
        }

    series = []
    for offset in range(SERIES_DAYS - 1, -1, -1):
        day = (now - timedelta(days=offset)).date()
        runs = [
            run for entries in runs_by_source.values() for run in entries
            if (_parse_time(run.get("generated_at")) or now).date() == day
        ]
        alerts = sum(
            1 for record in ((ledger or {}).get("sent_events") or {}).values()
            if isinstance(record, dict) and record.get("kind") != "TEST"
            and (_parse_time(record.get("sent_at")) or now).date() == day
        )
        series.append({
            "date": day.isoformat(),
            "checks": sum(_sum(run.get("counts"), CHECK_COUNT_KEYS) for run in runs),
            "failed_checks": sum(_sum(run.get("counts"), FAILURE_KEYS) for run in runs),
            "changes": sum(_sum(run.get("counts"), CHANGE_KEYS) for run in runs),
            "alerts_sent": alerts,
        })

    # Expected scans per six-hour slot over the next week, so a heavy cadence
    # mix shows up before it makes a run slow.
    slots = schedule.load_slots(cadences, now)
    by_cadence: dict[str, int] = {}
    for cadence, _last, _pages in cadences.values():
        label = cadence.describe()
        by_cadence[label] = by_cadence.get(label, 0) + 1
    schedule_load = {
        "slot_hours": schedule.SLOT_HOURS,
        "slots": slots,
        "page_checks_per_day": round(sum(slot["pages"] for slot in slots) / 7, 1),
        "monitor_checks_per_day": round(sum(slot["monitors"] for slot in slots) / 7, 1),
        "busiest": max(slots, key=lambda slot: slot["pages"], default=None),
        "by_cadence": [
            {"label": label, "monitors": count}
            for label, count in sorted(by_cadence.items(), key=lambda pair: (-pair[1], pair[0]))
        ],
    }

    statuses = [monitor["status"] for monitor in monitors]
    failing.sort(key=lambda item: (item.get("since") or "", item.get("source_id")))
    inactive.sort(key=lambda item: (-(item.get("days_without_change") or 0), item["source_id"]))
    return {
        "schema_version": HEALTH_SCHEMA_VERSION,
        "generated_at": _iso(now),
        "thresholds": {
            "inactive_after_days": INACTIVE_AFTER_DAYS,
            "stale_after_hours": STALE_AFTER_HOURS,
            "overdue_grace_hours": int(schedule.OVERDUE_GRACE.total_seconds() // 3600),
            "bot_check_grace_hours": botcheck.GRACE_HOURS,
        },
        "totals": {
            "monitors": len(monitors),
            "pages": sum(monitor["pages"] for monitor in monitors),
            "healthy": statuses.count("healthy"),
            "failing": statuses.count("failing"),
            # Monitors whose only problem is a bot check still being retried.
            "protected": statuses.count("protected"),
            "stale": statuses.count("stale"),
            "inactive": statuses.count("inactive"),
            "year_bound": len(year_flags),
            "with_alert_condition": sum(1 for monitor in monitors if monitor["alert_condition"]),
        },
        "last_7_days": window(7),
        "last_30_days": window(30),
        "daily": series,
        "failing": failing,
        "protected": sorted(protected, key=lambda item: (item.get("since") or "", item.get("source_id"), item.get("url") or "")),
        "stale": stale,
        "inactive": inactive,
        "year_bound": year_flags,
        "schedule_load": schedule_load,
        "monitors": monitors,
    }


def _load_required(path: Path, default):
    """Like _load, but a file that exists and cannot be read raises.

    A truncated config or inventory used to read as "no monitors", and the
    resulting all-clear replaced the last good health.json in the commit.
    "No monitors" and "could not read the monitors" must not look the same.
    """
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write(data_dir: Path, config_path: Path, now: datetime | None = None) -> dict:
    data_dir = Path(data_dir)
    health = build_health(
        _load_required(Path(config_path), {}),
        _load_required(data_dir / "latest.json", {}),
        _load(data_dir / "history" / "index.json", []),
        _load(data_dir / "notifications.json", {}),
        now or datetime.now(timezone.utc),
    )
    atomic_write_text(data_dir / "health.json", json.dumps(health, indent=2, ensure_ascii=False) + "\n")
    return health


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild data/health.json from committed state")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--config", default="config/sources.json")
    args = parser.parse_args()
    health = write(Path(args.data_dir), Path(args.config))
    print(json.dumps({"totals": health["totals"], "last_7_days": health["last_7_days"]}, indent=2))


if __name__ == "__main__":
    main()
