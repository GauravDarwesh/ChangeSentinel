"""Per-monitor scan cadence: which monitors a scheduled scan should cover.

The Regulatory Monitor workflow wakes every six hours (00, 06, 12 and 18 UTC).
Each monitor may ask to be checked less often (``check_every_hours``), only on
some weekdays (``check_days``) and only inside a local time window
(``check_hours``, read in ``check_timezone``). A scheduled run scans only the
monitors that are due; a manual run of one source, or of "all", still scans
everything it names.

The rules are deliberately coarse and forgiving, because GitHub often starts a
scheduled run an hour or more into its slot:

* A monitor with the default six-hour cadence is due on every tick, exactly as
  before cadences existed.
* A slower monitor is due once ``check_every_hours`` minus half a slot (three
  hours) has passed since its last saved scan, so a late start never pushes a
  daily check to the following day.
* A monitor that has never been scanned, or whose discovery is paused mid-crawl,
  is always due.

Everything here is pure and derived from configuration plus the time of the
last saved scan, so health.json, the freshness check and the dashboard all use
the same answer.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SLOT_HOURS = 6
SLOT = timedelta(hours=SLOT_HOURS)
# How late a scheduled run may start and still count as on time.
LATE_START = timedelta(hours=SLOT_HOURS / 2)
# A monitor is overdue this long after the slot it was expected in, which for
# the default cadence keeps the original 14-hour threshold (6 h + 8 h).
OVERDUE_GRACE = timedelta(hours=8)
# How far in the future a recorded scan time may be before it is distrusted.
FUTURE_SKEW = timedelta(minutes=15)
ALLOWED_INTERVALS = (6, 12, 24, 48, 72, 168)
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
BUSINESS_DAYS = WEEKDAYS[:5]
DEFAULT_TIMEZONE = "UTC"
# How far ahead a next-due search looks before giving up (two weeks of slots).
SEARCH_SLOTS = 14 * 24 // SLOT_HOURS + 1


class Cadence:
    """A monitor's schedule, read from its configuration (all fields optional)."""

    __slots__ = ("every_hours", "days", "hours", "timezone")

    def __init__(self, every_hours: int = 6, days=None, hours=None, tz: str = DEFAULT_TIMEZONE):
        self.every_hours = int(every_hours or 6)
        self.days = tuple(day for day in WEEKDAYS if day in set(days)) if days else WEEKDAYS
        self.hours = tuple(hours) if hours else None
        self.timezone = tz or DEFAULT_TIMEZONE

    @classmethod
    def from_source(cls, source) -> "Cadence":
        get = source.get if isinstance(source, dict) else (lambda key, default=None: getattr(source, key, default))
        days = get("check_days", None) or None
        hours = get("check_hours", None) or None
        return cls(
            every_hours=get("check_every_hours", 6) or 6,
            days=tuple(days) if days else None,
            hours=tuple(hours) if hours else None,
            tz=get("check_timezone", "") or DEFAULT_TIMEZONE,
        )

    @property
    def is_default(self) -> bool:
        return self.every_hours == SLOT_HOURS and self.days == WEEKDAYS and self.hours is None

    def zone(self):
        try:
            return ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            return timezone.utc

    def allows(self, moment: datetime) -> bool:
        """Whether a scan may run at this moment (weekday and local hour window)."""
        local = moment.astimezone(self.zone())
        if WEEKDAYS[local.weekday()] not in self.days:
            return False
        if self.hours is None:
            return True
        start, end = self.hours
        return start <= local.hour < end

    def describe(self) -> str:
        every = {6: "Every 6 hours", 12: "Every 12 hours", 24: "Daily", 48: "Every 2 days", 72: "Every 3 days", 168: "Weekly"}
        words = every.get(self.every_hours, f"Every {self.every_hours} hours")
        if self.days == BUSINESS_DAYS:
            words += ", weekdays"
        elif self.days != WEEKDAYS:
            words += ", " + "/".join(day.capitalize() for day in self.days)
        if self.hours is not None:
            words += f", {self.hours[0]:02d}:00–{self.hours[1]:02d}:00"
        if (self.days != WEEKDAYS or self.hours is not None) and self.timezone != DEFAULT_TIMEZONE:
            words += f" {self.timezone}"
        elif self.hours is not None:
            words += " UTC"
        return words

    def as_dict(self) -> dict:
        return {
            "every_hours": self.every_hours,
            "days": list(self.days),
            "hours": list(self.hours) if self.hours else None,
            "timezone": self.timezone,
            "label": self.describe(),
        }


def validate_cadence(value: dict, source_id: str) -> None:
    """Reject cadence settings that would silently never scan."""
    if "check_every_hours" in value:
        every = value["check_every_hours"]
        if isinstance(every, bool) or not isinstance(every, int) or every not in ALLOWED_INTERVALS:
            raise ValueError(
                f"Source {source_id}: check_every_hours must be one of {', '.join(map(str, ALLOWED_INTERVALS))}"
            )
    if "check_days" in value:
        days = value["check_days"]
        if not isinstance(days, list) or not days or not all(isinstance(day, str) for day in days):
            raise ValueError(f"Source {source_id}: check_days must be a non-empty list of weekdays (mon … sun)")
        unknown = sorted({day for day in days if day not in WEEKDAYS})
        if unknown:
            raise ValueError(f"Source {source_id}: check_days has unknown weekdays: {', '.join(unknown)}")
        if len(set(days)) != len(days):
            raise ValueError(f"Source {source_id}: check_days repeats a weekday")
    if "check_hours" in value:
        hours = value["check_hours"]
        if (
            not isinstance(hours, list) or len(hours) != 2
            or not all(isinstance(hour, int) and not isinstance(hour, bool) for hour in hours)
        ):
            raise ValueError(f"Source {source_id}: check_hours must be [start, end] whole hours, e.g. [8, 18]")
        start, end = hours
        if not (0 <= start < end <= 24):
            raise ValueError(f"Source {source_id}: check_hours must satisfy 0 <= start < end <= 24")
        # Scans start at six-hour slots; a narrower window could miss every slot.
        if end - start < SLOT_HOURS:
            raise ValueError(f"Source {source_id}: check_hours must span at least {SLOT_HOURS} hours")
    if "check_timezone" in value:
        name = value["check_timezone"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"Source {source_id}: check_timezone must be an IANA time zone such as America/Sao_Paulo")
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Source {source_id}: unknown check_timezone {name!r}") from exc


def slot_start(moment: datetime) -> datetime:
    moment = moment.astimezone(timezone.utc)
    return moment.replace(hour=moment.hour - moment.hour % SLOT_HOURS, minute=0, second=0, microsecond=0)


def is_due(cadence: Cadence, last_scan: datetime | None, now: datetime, *, paused: bool = False) -> bool:
    """Whether a scheduled run at ``now`` should scan this monitor."""
    if paused or last_scan is None:
        return True
    # A last scan in the future (clock skew, a hand-edited report) would keep
    # the monitor "not due" and never overdue for as long as the skew lasts.
    if last_scan > now + FUTURE_SKEW:
        return True
    if not cadence.allows(slot_start(now)):
        return False
    if cadence.every_hours == SLOT_HOURS:
        return True
    return now >= last_scan + timedelta(hours=cadence.every_hours) - LATE_START


def next_due(cadence: Cadence, last_scan: datetime | None, after: datetime) -> datetime:
    """The first scheduled slot, from the one holding ``after``, that will scan this monitor.

    A monitor already scanned inside a slot is not due again in that slot.
    """
    slot = slot_start(after)
    scanned_slot = slot_start(last_scan) if last_scan else None
    for _ in range(SEARCH_SLOTS):
        if (scanned_slot is None or slot > scanned_slot) and is_due(cadence, last_scan, slot):
            return slot
        slot += SLOT
    return slot


def overdue_after(cadence: Cadence, last_scan: datetime | None, now: datetime | None = None) -> datetime | None:
    """When a monitor counts as overdue: the slot it was expected in, plus a grace period."""
    if last_scan is None:
        return None
    if now is not None and last_scan > now + FUTURE_SKEW:
        # An impossible future scan time cannot vouch for freshness: already overdue.
        return now - OVERDUE_GRACE
    # Never stricter than "interval + grace" after the last scan, which for the
    # default cadence is the original 14-hour freshness threshold.
    return max(
        next_due(cadence, last_scan, last_scan),
        last_scan + timedelta(hours=cadence.every_hours),
    ) + OVERDUE_GRACE


def load_slots(cadences: dict[str, tuple[Cadence, datetime | None, int]], now: datetime, days: int = 7) -> list[dict]:
    """Expected scans per scheduled slot for the coming days.

    ``cadences`` maps source id to (cadence, last scan, pages). Each monitor is
    assumed to be scanned at every slot it becomes due in, which is how the
    workflow behaves when its runs start on time.
    """
    first = slot_start(now) + SLOT
    slots = [first + SLOT * index for index in range(days * 24 // SLOT_HOURS)]
    out = [{"at": slot.isoformat(), "monitors": 0, "pages": 0} for slot in slots]
    for cadence, last_scan, pages in cadences.values():
        last = last_scan
        for index, slot in enumerate(slots):
            if (last is None or slot > slot_start(last)) and is_due(cadence, last, slot):
                out[index]["monitors"] += 1
                out[index]["pages"] += pages
                last = slot
    return out


def parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def overdue_sources(config: dict, reports_dir, now: datetime) -> list[dict]:
    """Active monitors whose expected scan slot passed more than the grace period ago."""
    import json
    from pathlib import Path

    from regmon.config import is_active

    out = []
    for source in config.get("sources") or []:
        if not is_active(source):
            continue
        source_id = str(source.get("id"))
        never_scanned = False
        try:
            report = json.loads((Path(reports_dir) / f"{source_id}.json").read_text(encoding="utf-8"))
            last = parse_time((report or {}).get("generated_at")) if isinstance(report, dict) else None
        except (OSError, ValueError):
            # Never completed a scan: the most overdue case of all, measured from
            # when it was registered (CS-45). Older monitors without a
            # registration time cannot be judged and are left out.
            last = parse_time(source.get("registered_at"))
            never_scanned = last is not None
            if last is None:
                continue
        cadence = Cadence.from_source(source)
        limit = overdue_after(cadence, last, now)
        if limit is not None and now > limit:
            entry = {
                "source_id": source_id,
                "name": str(source.get("name") or source_id),
                "cadence": cadence.describe(),
                "last_scan": None if never_scanned else last.isoformat(),
                "overdue_since": limit.isoformat(),
                "hours_since_scan": round((now - last).total_seconds() / 3600, 1),
            }
            if never_scanned:
                entry["never_scanned"] = True
                entry["registered_at"] = last.isoformat()
            out.append(entry)
    return out


def main() -> None:
    """Print monitors overdue for a scan; used by the Monitor Freshness Check."""
    import argparse
    import json
    import os
    from pathlib import Path

    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--config", default="config/sources.json")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    overdue = overdue_sources(config, Path(args.data_dir) / "reports", datetime.now(timezone.utc))
    for entry in overdue:
        when = "never scanned since it was registered" if entry.get("never_scanned") else "last scanned"
        print(f"overdue: {entry['source_id']} ({entry['cadence']}) {when} {entry['hours_since_scan']} h ago")
    print(f"overdue_monitors={len(overdue)}")
    if args.github_output:
        worst = max((entry["hours_since_scan"] for entry in overdue), default=0)
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write(f"stale={'true' if overdue else 'false'}\n")
            handle.write(f"count={len(overdue)}\n")
            handle.write(f"hours={worst}\n")


if __name__ == "__main__":
    main()
