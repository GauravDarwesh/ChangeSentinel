"""Regulatory dates found in detected changes, as data/calendar.json and an .ics feed.

A changed form or notice usually matters because of a date: a comment deadline,
an effective date, the first report date a revised form applies to. This module
collects those dates from what the engine has already recorded, so a reviewer
can subscribe to them in Outlook, Google Calendar or Apple Calendar:

* AI reviews: the structured ``effective_date`` of each relevant change, kept in
  data/history/<run>.json, when it names a calendar date.
* The change itself: added lines of the stored diff that state a date in a
  recognised phrase ("Comments must be received on or before March 2, 2027",
  "effective for the June 30, 2027, report date"). This needs no model, so a
  change the AI has not reviewed still contributes its dates.

Every entry keeps the sentence it came from and links to its change, because a
date read from text is a pointer for a person to check, not a determination.
Changes the AI judged not relevant contribute nothing. The output is rebuilt
from committed records on every run and only rewritten when it changes.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from regmon.fsutil import atomic_write_bytes, atomic_write_text

MONTHS = {name: index for index, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], start=1)}
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
DATE = (
    r"(?P<date>" + MONTH + r"\s+\d{1,2},?\s+\d{4}"
    r"|\d{1,2}\s+" + MONTH + r",?\s+\d{4}"
    r"|\d{4}-\d{2}-\d{2}"
    r"|\d{1,2}/\d{1,2}/\d{4})"
)
# Phrase -> kind. Ordered: the first pattern that matches a stretch of text wins.
PATTERNS = [
    ("comments_due", re.compile(
        r"\bcomments?\b[^.;]{0,80}?\b(?:by|on\s+or\s+before|until|no\s+later\s+than|due(?:\s+on)?|deadline(?:\s+is)?)\s+" + DATE, re.I)),
    ("comments_due", re.compile(r"\bcomment\s+(?:period|deadline)\b[^.;]{0,40}?\b(?:ends?|closes?|is)\s+(?:on\s+)?" + DATE, re.I)),
    ("report_date", re.compile(
        r"\b(?:for|beginning\s+with|starting\s+with|effective\s+(?:for|with)|as\s+of)\s+the\s+" + DATE + r",?\s+(?:report(?:ing)?|as-of)\s+date", re.I)),
    ("effective", re.compile(
        r"\beffective\s+(?:date\b\s*(?:is|of|:)?\s*|as\s+of\s+|on\s+|beginning\s+(?:on\s+)?|starting\s+(?:on\s+)?|from\s+)?" + DATE, re.I)),
    ("due", re.compile(
        r"\b(?:due|must\s+be\s+(?:submitted|filed|received)|submit(?:ted)?|file[ds]?)\b[^.;]{0,40}?\b(?:by|on\s+or\s+before|no\s+later\s+than)\s+" + DATE, re.I)),
]
LABELS = {
    "comments_due": "Comments due", "report_date": "First report date", "effective": "Effective",
    "due": "Due", "ai_effective": "Effective (AI review)",
    "spec_effective": "Spec rows apply", "spec_last": "Spec rows end", "spec_quarter": "Spec rows take effect",
}
SPEC_QUIET = {"metadata", "cosmetic", "removed"}
SPEC_WORDS = {"added": "new", "added_version": "new version", "severity": "severity changed", "logic": "logic changed",
              "retired": "retired", "reinstated": "reinstated", "effective": "dates changed", "message": "message changed",
              "definition": "redefined", "description": "description changed", "new": "marked new", "updated": "marked updated"}
MAX_QUOTE = 220
MAX_ENTRIES = 500
CHANGE_TYPES = {"CHANGED_URL", "NEW_URL"}


def parse_date(text: str) -> date | None:
    """A calendar date written in one of the forms DATE accepts, else None."""
    value = str(text or "").strip().rstrip(".,")
    try:
        match = re.fullmatch(r"(" + MONTH + r")\s+(\d{1,2}),?\s+(\d{4})", value, re.I)
        if match:
            return date(int(match.group(3)), MONTHS[match.group(1).lower()], int(match.group(2)))
        match = re.fullmatch(r"(\d{1,2})\s+(" + MONTH + r"),?\s+(\d{4})", value, re.I)
        if match:
            return date(int(match.group(3)), MONTHS[match.group(2).lower()], int(match.group(1)))
        match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
        if match:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        match = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", value)
        if match:
            first, second, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            # US regulators write month first. A first number above 12 can only
            # be a day (30/06/2026, as Latin American and European regulators
            # write), which used to raise and silently drop the deadline.
            if first > 12 >= second:
                return date(year, second, first)
            return date(year, first, second)
    except ValueError:
        return None
    return None


def first_date(text: str) -> date | None:
    match = re.search(DATE, str(text or ""), re.I)
    return parse_date(match.group("date")) if match else None


def _plausible(value: date, today: date) -> bool:
    return date(2000, 1, 1) <= value <= today + timedelta(days=3660)


def _quote(text: str, start: int, end: int) -> str:
    """The sentence around a match, trimmed to MAX_QUOTE."""
    text = re.sub(r"\s+", " ", text)
    left = 0
    for boundary in re.finditer(r"(?<=[.;!?])\s+(?=[A-Z(•])|•\s*", text):
        if boundary.end() > start:
            break
        left = boundary.end()
    stop = re.search(r"[.;!?](?=\s|$)", text[end:])
    right = end + stop.end() if stop else len(text)
    sentence = text[left:right].strip()
    if len(sentence) <= MAX_QUOTE:
        return sentence
    offset = start - left
    window_left = max(0, offset - 100)
    return ("…" if window_left else "") + sentence[window_left:window_left + MAX_QUOTE].strip() + "…"


def dates_in_text(text: str, today: date | None = None) -> list[dict]:
    """Dated phrases in text: [{kind, date, quote}], each date and kind once."""
    today = today or datetime.now(timezone.utc).date()
    found, seen = [], set()
    lines = [line for line in str(text or "").splitlines() if line.strip()]
    # Each line, then each pair of adjacent lines: PDF and HTML normalisation
    # routinely breaks "received on or before\nMarch 2, 2027" across lines.
    # A date already found on one line is not repeated (seen).
    windows = lines + [lines[index] + " " + lines[index + 1] for index in range(len(lines) - 1)]
    for line in windows:
        flat = re.sub(r"\s+", " ", line)
        taken: list[tuple[int, int]] = []
        for kind, pattern in PATTERNS:
            for match in pattern.finditer(flat):
                span = match.span("date")
                if any(span[0] < end and start < span[1] for start, end in taken):
                    continue
                value = parse_date(match.group("date"))
                if not value or not _plausible(value, today):
                    continue
                taken.append(span)
                key = (kind, value)
                if key in seen:
                    continue
                seen.add(key)
                found.append({"kind": kind, "date": value.isoformat(), "quote": _quote(flat, match.start(), match.end())})
    return found


def added_lines(diff: str) -> str:
    """The text a unified diff added (its '+' lines, without file headers)."""
    return "\n".join(line[1:] for line in str(diff or "").splitlines() if line.startswith("+") and not line.startswith("+++"))


def page_title(url: str) -> str:
    """A readable name for a page from its address ("FR Y-9C reporting form")."""
    path = str(url or "").split("?", 1)[0].split("#", 1)[0].rstrip("/")
    last = path.rsplit("/", 1)[-1] if "/" in path else path
    if re.match(r"^FR[_ ]", last, re.I):
        return last.replace("_", " ") + " reporting form"
    if last.lower() == "recentupdates":
        return "Recent reporting form updates"
    if last.lower() == "review":
        return "Information collections under review"
    if last.lower() == "downloadattachment":
        return "Reporting form attachment"
    return re.sub(r"[-_]+", " ", re.sub(r"\.(html?|pdf|aspx?)$", "", last, flags=re.I)).strip().title() or url


def _quarter_end(quarter: str) -> date | None:
    match = re.fullmatch(r"Q([1-4]) (\d{4})", quarter or "")
    if not match:
        return None
    month = int(match.group(1)) * 3
    return date(int(match.group(2)), month, 30 if month in (6, 9) else 31)


def _spec_when(effective: str, quarter: str) -> tuple[str, date | None]:
    """("spec_effective" | "spec_last" | "spec_quarter", day) for one row's effective text."""
    match = re.search(r"(\d{4}-\d{2}-\d{2})", effective or "")
    if match:
        try:
            day = date.fromisoformat(match.group(1))
        except ValueError:
            return "", None
        return ("spec_last" if effective.startswith("last applies") else "spec_effective"), day
    day = _quarter_end(quarter)
    return ("spec_quarter", day) if day else ("", None)


def spec_dates(evidence: dict, today: date, floor: str) -> list[dict]:
    """Calendar hits from a structured spec diff: one per table, date and kind, naming the rows."""
    groups: dict[tuple[str, str, str], dict] = {}
    spec = evidence.get("spec_diff") if isinstance(evidence.get("spec_diff"), dict) else None
    tables = []
    if spec:
        tables = [(table.get("name") or "Table", table.get("kind") or "", table.get("changes") or []) for table in spec.get("tables") or []
                  if isinstance(table, dict)]
    inventory = evidence.get("spec_inventory") if isinstance(evidence.get("spec_inventory"), dict) else None
    if inventory and not tables:
        # A file seen for the first time: what it declares new, updated or retired.
        tables = [(table.get("name") or "Table", table.get("kind") or "",
                   [{"category": "retired" if item.get("action") == "retired" else item.get("action"), "label": item.get("label"),
                     "effective": item.get("effective", "")} for item in table.get("items") or [] if isinstance(item, dict)])
                  for table in inventory.get("tables") or [] if isinstance(table, dict)]
    for name, kind, changes in tables:
        for change in changes:
            if not isinstance(change, dict) or change.get("category") in SPEC_QUIET:
                continue
            when, day = _spec_when(str(change.get("effective") or ""), str(change.get("quarter") or ""))
            if not day or not _plausible(day, today) or day.isoformat() < floor:
                continue
            group = groups.setdefault((name, when, day.isoformat()), {"table": name, "kind": when, "date": day.isoformat(), "counts": {}, "labels": []})
            category = str(change.get("category") or "")
            group["counts"][category] = group["counts"].get(category, 0) + 1
            if len(group["labels"]) < 4 and change.get("label"):
                group["labels"].append(str(change["label"]))
    hits = []
    for group in groups.values():
        total = sum(group["counts"].values())
        parts = ", ".join(f"{count} {SPEC_WORDS.get(category, category)}" for category, count in
                          sorted(group["counts"].items(), key=lambda item: -item[1]))
        verb = {"spec_last": "last apply on", "spec_quarter": "take effect for the quarter ending", "spec_effective": "apply from"}[group["kind"]]
        quote = f"{group['table']}: {total} changed {'row' if total == 1 else 'rows'} {verb} {group['date']} — {parts}"
        if group["labels"]:
            quote += " (" + ", ".join(group["labels"]) + (", …" if total > len(group["labels"]) else "") + ")"
        hits.append({"kind": group["kind"], "date": group["date"], "quote": quote[:MAX_QUOTE], "basis": "spec", "table": group["table"]})
    return hits


def _ai_results(data_dir: Path) -> dict[str, dict]:
    """Latest successful AI analysis per event id, from every saved run."""
    analyses: dict[str, dict] = {}
    history = data_dir / "history"
    for path in sorted(history.glob("*.json")) if history.is_dir() else []:
        if path.name == "index.json":
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for result in report.get("ai_results") or []:
            ai = result.get("ai") if isinstance(result, dict) else None
            if isinstance(ai, dict) and ai.get("status") == "ok" and isinstance(ai.get("analysis"), dict) and result.get("event_id"):
                analyses[str(result["event_id"])] = ai["analysis"]
    return analyses


def build(data_dir: Path, config_path: Path, today: date | None = None) -> dict:
    """Every dated entry from recorded changes of active sources, newest scan first."""
    today = today or datetime.now(timezone.utc).date()
    # An unreadable config or inventory raises instead of reading as "no active
    # sources": that emptied the calendar and the subscribed .ics feed, and the
    # next run reported 0 entries as if it were true. write() is never allowed
    # to fail a scan, so the published files simply stay as they were.
    config = json.loads(config_path.read_text(encoding="utf-8"))
    active = {str(source.get("id")) for source in config.get("sources", []) if source.get("active") is True}
    latest_path = data_dir / "latest.json"
    inventory = json.loads(latest_path.read_text(encoding="utf-8")).get("sources", {}) if latest_path.exists() else {}
    analyses = _ai_results(data_dir)
    root = data_dir.parent
    entries: dict[str, dict] = {}
    for source_id, items in inventory.items():
        if source_id not in active or not isinstance(items, dict):
            continue
        for url_id, item in items.items():
            if not isinstance(item, dict) or item.get("active") is False:
                continue
            url = str(item.get("canonical_url") or "")
            for change in item.get("change_history") or []:
                if not isinstance(change, dict) or change.get("event_type") not in CHANGE_TYPES:
                    continue
                event_id = str(change.get("event_id") or "")
                analysis = analyses.get(event_id)
                if change.get("ai_relevant") is False or (analysis and analysis.get("relevant") is False):
                    continue
                found = []
                if analysis and analysis.get("relevant") is True:
                    stated = str(analysis.get("effective_date") or "")
                    value = first_date(stated)
                    if value and _plausible(value, today):
                        found.append({"kind": "ai_effective", "date": value.isoformat(), "quote": stated[:MAX_QUOTE], "basis": "ai"})
                location = change.get("evidence_location")
                if location:
                    try:
                        evidence = json.loads((root / location).read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        evidence = {}
                    # Text the change added can restate old history ("effective as of
                    # July 21, 2011"); only dates near or after the change are kept.
                    detected = str(change.get("timestamp") or "")[:10]
                    floor = (date.fromisoformat(detected) - timedelta(days=90)).isoformat() if re.match(r"\d{4}-\d{2}-\d{2}$", detected) else ""
                    for hit in dates_in_text(added_lines(evidence.get("diff", "")), today):
                        if hit["date"] >= floor:
                            found.append({**hit, "basis": "text"})
                    found.extend(spec_dates(evidence, today, floor))
                title = str((analysis or {}).get("topic") or change.get("ai_topic") or page_title(url))
                for hit in found:
                    identity = "|".join([url_id, hit["kind"].replace("ai_", ""), hit["date"]] + ([hit["table"]] if hit.get("table") else []))
                    entry_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
                    previous = entries.get(entry_id)
                    if previous and previous["detected_at"] <= str(change.get("timestamp") or ""):
                        continue
                    entries[entry_id] = {
                        "id": entry_id, "date": hit["date"], "kind": hit["kind"], "label": LABELS[hit["kind"]],
                        "title": title, "url": url, "url_id": url_id, "source_id": source_id,
                        "event_id": event_id, "event_type": change.get("event_type"),
                        "detected_at": str(change.get("timestamp") or ""), "evidence_location": location,
                        "basis": hit["basis"], "quote": hit["quote"],
                    }
    ordered = sorted(entries.values(), key=lambda entry: (entry["date"], entry["title"], entry["kind"]))
    return {"schema_version": 1, "entries": ordered[-MAX_ENTRIES:]}


def dashboard_url() -> str:
    explicit = os.environ.get("DASHBOARD_URL", "").strip()
    if explicit:
        return explicit.split("#", 1)[0].rstrip("/") + "/"
    repository = os.environ.get("GITHUB_REPOSITORY", "GauravDarwesh/ChangeSentinel")
    owner, _, name = repository.partition("/")
    return f"https://{owner.lower()}.github.io/{name}/"


def _ics_text(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r", "").replace("\n", "\\n")


def _fold(line: str) -> str:
    """RFC 5545 line folding at 75 octets."""
    out, current = [], ""
    for ch in line:
        if len((current + ch).encode("utf-8")) > (75 if not out else 74):
            out.append(current)
            current = ch
        else:
            current += ch
    out.append(current)
    return "\r\n ".join(out)


def to_ics(calendar: dict, generated_at: str, base_url: str) -> str:
    stamp = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ChangeSentinel//Regulatory dates//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "X-WR-CALNAME:ChangeSentinel regulatory dates",
        "X-WR-CALDESC:" + _ics_text("Dates stated in regulatory changes ChangeSentinel detected. Each links to the change it came from; check the source before relying on a date."),
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
    ]
    for entry in calendar.get("entries", []):
        day = date.fromisoformat(entry["date"])
        link = base_url + "#changes/" + entry["event_id"] if entry.get("event_id") else base_url
        basis = {"ai": "the AI review of the change", "spec": "the row-by-row comparison of the specification file"}.get(
            entry["basis"], "the text the change added")
        description = (entry.get("quote") or "") + "\n\nRead from " + basis + " detected on " + str(entry.get("detected_at", ""))[:10] + \
            ". Page: " + entry.get("url", "") + "\nChange and evidence: " + link
        lines += [
            "BEGIN:VEVENT",
            "UID:" + entry["id"] + "@changesentinel",
            "DTSTAMP:" + stamp,
            "DTSTART;VALUE=DATE:" + day.strftime("%Y%m%d"),
            "DTEND;VALUE=DATE:" + (day + timedelta(days=1)).strftime("%Y%m%d"),
            "SUMMARY:" + _ics_text(entry["label"] + ": " + entry["title"]),
            "DESCRIPTION:" + _ics_text(description),
            "URL:" + link,
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


# Bump when to_ics() or the published fields change, so the fix reaches the
# feed even when no deadline changed (write() otherwise keeps unchanged files).
FEED_VERSION = 2


def write(data_dir: Path, config_path: Path, today: date | None = None, force: bool = False) -> bool:
    """Rebuild data/calendar.json and data/calendar.ics; rewrite only on change.

    "Change" covers the entries, the feed format (FEED_VERSION) and the
    subscribe address; ``force`` rewrites regardless.
    """
    calendar = build(data_dir, config_path, today)
    calendar["feed_version"] = FEED_VERSION
    subscribe = dashboard_url() + "data/calendar.ics"
    json_path = data_dir / "calendar.json"
    try:
        existing = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        existing = None
    if (
        not force
        and isinstance(existing, dict)
        and existing.get("entries") == calendar["entries"]
        and existing.get("feed_version") == FEED_VERSION
        and existing.get("subscribe") == subscribe
        and (data_dir / "calendar.ics").exists()
    ):
        return False
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    calendar["generated_at"] = generated_at
    calendar["subscribe"] = subscribe
    # The .ics is written first: if the run stops between the two, the next
    # run sees calendar.json unchanged-or-older and rebuilds both.
    atomic_write_bytes(data_dir / "calendar.ics", to_ics(calendar, generated_at, dashboard_url()).encode("utf-8"))
    atomic_write_text(json_path, json.dumps(calendar, indent=2) + "\n")
    return True


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Rebuild data/calendar.json and data/calendar.ics.")
    parser.add_argument("--force", action="store_true", help="Rewrite both files even when nothing changed")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    changed = write(root / "data", root / "config" / "sources.json", force=args.force)
    entries = json.loads((root / "data" / "calendar.json").read_text(encoding="utf-8"))["entries"]
    print(json.dumps({"rewritten": changed, "entries": len(entries)}, indent=2))


if __name__ == "__main__":
    main()
