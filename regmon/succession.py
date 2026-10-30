"""Next-period documents: the new file that replaces a monitored one.

Regulators publish each period's form, instructions or taxonomy under a new
name rather than overwriting the old file:

    .../reporting-forms/FFIEC031_202609_f.pdf   ->  .../FFIEC031_202612_f.pdf
    .../bcar27-rnfpb27-2026-09-10-bil.xsd       ->  .../bcar27-rnfpb27-2026-12-15-bil.xsd

A monitor of the old address never changes again, and the new address would
arrive as an unrelated NEW_URL, so the quarterly revision (the change a
reporting team most needs read item by item) was never compared with anything.

This module finds those successors deterministically, from what the scan
already records: every link each monitored or listing page lists
(data/link-lineage.json). Two addresses are the same document in different
periods when they are equal once their period tokens are blanked out:

* same scheme, host, directory and query; same file name and extension;
* period tokens: dates (2026-09-10, 20260910), months (202609, 2026-09),
  quarters (2026Q3, Q3 2026), years (2027) and versions (_v2), in the same
  places on both sides;
* a trailing ``_0``/``_1`` before the extension (a CMS de-duplication suffix)
  is ignored.

The successor is the listed address whose periods are the smallest step after
the monitored one's: no period goes backwards and at least one goes forward.
A tie that cannot be settled is recorded as ambiguous and not followed.

What is found is saved in data/successions.json (one entry per predecessor,
never rewritten). The engine then fetches the successor as part of the
predecessor's monitor, and compares it with the predecessor's text: item codes,
the structured spec diff and the registry impact, exactly as for a changed page.
The predecessor stays monitored.

    {"schema_version": 1, "updated_at": "...",
     "successions": [{"from": "...", "to": "...", "source_id": "...", "page": "...",
                      "rule": "filename_period", "from_period": "2026-09", "to_period": "2026-12",
                      "found_at": "...", "follow": true}]}

``follow`` is false when the successor is already monitored elsewhere
(``monitored_by``) or the match was ambiguous (``candidates``).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import unquote, urlsplit

from .fsutil import atomic_write_text

FILE_NAME = "successions.json"
SCHEMA_VERSION = 1
MAX_SUCCESSIONS = 5000
RULE = "filename_period"

# Most specific first. A token is bounded by non-alphanumerics on both sides, so
# 202609 is never the year 2026 followed by "09", and a number glued to letters
# is a form number, not a period (FR_2028D, FR_2004A).
_TOKEN = re.compile(
    r"(?<![0-9A-Za-z])(?:"
    r"(?P<ymd>(?P<y1>20\d\d)(?P<s1>[-_.]?)(?P<m1>0[1-9]|1[0-2])(?P=s1)(?P<d1>0[1-9]|[12]\d|3[01]))"
    r"|(?P<mdy>(?P<m7>0[1-9]|1[0-2])(?P<s7>[-_.])(?P<d7>0[1-9]|[12]\d|3[01])(?P=s7)(?P<y7>20\d\d))"
    r"|(?P<ym>(?P<y2>20\d\d)[-_.]?(?P<m2>0[1-9]|1[0-2]))"
    r"|(?P<yq>(?P<y3>20\d\d)[-_. ]?[Qq](?P<q3>[1-4]))"
    r"|(?P<qy>[Qq](?P<q4>[1-4])[-_. ]?(?P<y4>20\d\d))"
    # A bare year, unless it is a document number's prefix (2026-10302).
    r"|(?P<y>(?P<y5>20\d\d))(?![-_]\d{3,})"
    r"|(?P<v>[Vv](?:er)?\.?(?P<n6>\d{1,3}))"
    r")(?![0-9A-Za-z])"
)
# Form numbers that look like years: FR 2028, FR 2004, FR 2052.
_FORM_PREFIX = re.compile(r"(?:^|[^0-9a-z])(?:fr|ffiec|form)[-_ ]?$", re.I)
# A CMS de-duplication suffix right before the extension: FFIEC030_202503_f_0.pdf.
_DEDUP = re.compile(r"(?<=[A-Za-z])_\d{1,2}(?=\.[A-Za-z0-9]{2,5}$)")


@dataclass(frozen=True)
class Identity:
    key: str                      # the address with every period token blanked out
    periods: tuple[tuple, ...]    # one comparable tuple per token, in address order
    labels: tuple[str, ...]       # the tokens as written, for display


def _period(match: re.Match) -> tuple[str, tuple, str]:
    g = match.groupdict()
    if g["ymd"]:
        return "{date}", (int(g["y1"]), int(g["m1"]), int(g["d1"])), f"{g['y1']}-{g['m1']}-{g['d1']}"
    if g["mdy"]:
        return "{date}", (int(g["y7"]), int(g["m7"]), int(g["d7"])), f"{g['y7']}-{g['m7']}-{g['d7']}"
    if g["ym"]:
        return "{month}", (int(g["y2"]), int(g["m2"])), f"{g['y2']}-{g['m2']}"
    if g["yq"]:
        return "{quarter}", (int(g["y3"]), int(g["q3"])), f"{g['y3']}Q{g['q3']}"
    if g["qy"]:
        return "{quarter}", (int(g["y4"]), int(g["q4"])), f"{g['y4']}Q{g['q4']}"
    if g["y"]:
        return "{year}", (int(g["y5"]),), g["y5"]
    return "{version}", (int(g["n6"]),), f"v{int(g['n6'])}"


def identity(url: str) -> Identity | None:
    """The address's document identity and periods, or None when it names no period."""
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    path = unquote(parts.path or "/")
    directory, _, name = path.rpartition("/")
    name = _DEDUP.sub("", name)
    path = f"{directory}/{name}"
    pieces: list[str] = []
    periods: list[tuple] = []
    labels: list[str] = []
    cursor = 0
    for match in _TOKEN.finditer(path):
        placeholder, value, label = _period(match)
        if placeholder == "{year}" and _FORM_PREFIX.search(path[max(0, match.start() - 8):match.start()]):
            continue
        pieces.append(path[cursor:match.start()])
        pieces.append(placeholder)
        periods.append(value)
        labels.append(label)
        cursor = match.end()
    if not periods:
        return None
    pieces.append(path[cursor:])
    key = f"{parts.scheme.lower()}://{parts.netloc.lower()}{''.join(pieces).lower()}"
    if parts.query:
        key += "?" + parts.query
    return Identity(key=key, periods=tuple(periods), labels=tuple(labels))


def is_later(after: Identity, before: Identity) -> bool:
    """Same document, no period earlier and at least one later."""
    if after.key != before.key or len(after.periods) != len(before.periods):
        return False
    return all(a >= b for a, b in zip(after.periods, before.periods)) and after.periods != before.periods


def load(data_dir: Path) -> dict:
    path = data_dir / FILE_NAME
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION \
                    and isinstance(payload.get("successions"), list):
                return payload
        except (OSError, ValueError):
            pass
    return {"schema_version": SCHEMA_VERSION, "updated_at": None, "successions": []}


def _listed_links(lineage: dict) -> Iterable[tuple[str, str]]:
    """(link, page) for every link a recorded page lists now (menus and removed links left out)."""
    for page_url, page in (lineage.get("pages") or {}).items():
        for url, entry in (page.get("links") or {}).items():
            if entry.get("removed_at") or entry.get("menu"):
                continue
            yield url, page_url


def find(lineage: dict, monitored: dict[str, str], known: list[dict], *, canon: Callable[[str], str] = str,
         at: str = "") -> list[dict]:
    """New successions: for each monitored address with no successor yet, its next-period listed address.

    ``monitored`` maps each monitored canonical address to its monitor (source id);
    ``known`` is what data/successions.json already holds.
    """
    has_successor = {entry.get("from") for entry in known}
    known_targets = {entry.get("to") for entry in known}
    by_key: dict[str, dict[str, set[str]]] = {}
    for url, page in _listed_links(lineage):
        url = canon(url)
        ident = identity(url)
        if ident is not None:
            by_key.setdefault(ident.key, {}).setdefault(url, set()).add(page)
    pages_listing: dict[str, set[str]] = {}
    for url, page in _listed_links(lineage):
        pages_listing.setdefault(canon(url), set()).add(page)
    found: list[dict] = []
    for url, source_id in sorted(monitored.items()):
        if url in has_successor:
            continue
        ident = identity(url)
        if ident is None:
            continue
        later = []
        for candidate, pages in (by_key.get(ident.key) or {}).items():
            if candidate == url:
                continue
            other = identity(candidate)
            if other is not None and is_later(other, ident):
                later.append((other.periods, candidate, pages, other))
        if not later:
            continue
        nearest = min(periods for periods, *_ in later)
        tied = [entry for entry in later if entry[0] == nearest]
        if len(tied) > 1:
            # Prefer a candidate listed on a page that lists (or listed) the monitored file.
            sharing = [entry for entry in tied if entry[2] & pages_listing.get(url, set())]
            tied = sharing if len(sharing) == 1 else tied
        _periods, target, pages, target_ident = tied[0]
        entry = {
            "from": url,
            "to": target,
            "source_id": source_id,
            "page": sorted(pages)[0],
            "rule": RULE,
            "from_period": " ".join(ident.labels),
            "to_period": " ".join(target_ident.labels),
            "found_at": at,
            "follow": True,
        }
        if len(tied) > 1:
            entry["follow"] = False
            entry["candidates"] = sorted(candidate for _p, candidate, _pg, _i in tied)[:10]
        elif target in monitored:
            entry["follow"] = False
            entry["monitored_by"] = monitored[target]
        elif target in known_targets:
            # Already the successor of another monitored file (two monitors of one series).
            entry["follow"] = False
        known_targets.add(target)
        found.append(entry)
    return found


def update(data_dir: Path, latest: dict, *, canon: Callable[[str], str] = str, now: str | None = None) -> dict:
    """Record successors of every active monitored address; returns {"added": n, "total": n}.

    Reads data/link-lineage.json; the file is only rewritten when something was added.
    """
    at = now or datetime.now(timezone.utc).isoformat()
    lineage_path = data_dir / "link-lineage.json"
    try:
        lineage = json.loads(lineage_path.read_text(encoding="utf-8")) if lineage_path.exists() else {}
    except (OSError, ValueError):
        lineage = {}
    monitored: dict[str, str] = {}
    for source_id, items in (latest.get("sources") or {}).items():
        for item in (items or {}).values():
            if item.get("canonical_url") and item.get("active") is not False:
                monitored.setdefault(canon(item["canonical_url"]), source_id)
    payload = load(data_dir)
    added = find(lineage, monitored, payload["successions"], canon=canon, at=at)
    if added:
        payload["successions"] = (payload["successions"] + added)[-MAX_SUCCESSIONS:]
        payload["updated_at"] = at
        atomic_write_text(data_dir / FILE_NAME, json.dumps(payload, indent=1, sort_keys=True))
    return {"added": len(added), "total": len(payload["successions"])}


def followed(data_dir: Path, source_id: str, allowed_domains: Iterable[str] = (),
             allowed_prefixes: Iterable[str] = ()) -> list[str]:
    """Successor addresses this monitor fetches in addition to its own (oldest first).

    Only addresses inside the monitor's own domains and prefixes: following a
    successor never widens what a monitor may fetch beyond its scope.
    """
    domains = {str(domain).lower() for domain in allowed_domains or ()}
    prefixes = tuple(str(prefix) for prefix in allowed_prefixes or ())
    out: list[str] = []
    for entry in load(data_dir)["successions"]:
        if entry.get("source_id") != source_id or not entry.get("follow"):
            continue
        target = str(entry.get("to") or "")
        host = (urlsplit(target).hostname or "").lower()
        if not target or target in out:
            continue
        if (domains and host not in domains) or (prefixes and not target.startswith(prefixes)):
            continue
        out.append(target)
    return out


def predecessors(data_dir: Path) -> dict[str, dict]:
    """Successor address -> its succession entry, for every recorded succession."""
    return {str(entry["to"]): entry for entry in load(data_dir)["successions"] if entry.get("to") and entry.get("from")}


def validate(payload: object) -> list[str]:
    """Structural problems in data/successions.json (empty when valid)."""
    errors: list[str] = []
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return [f"{FILE_NAME}: schema_version must be {SCHEMA_VERSION}"]
    entries = payload.get("successions")
    if not isinstance(entries, list):
        return [f"{FILE_NAME}: successions must be a list"]
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        where = f"{FILE_NAME} successions[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{where} must be an object")
            continue
        for key in ("from", "to", "source_id"):
            if not isinstance(entry.get(key), str) or not entry.get(key):
                errors.append(f"{where}.{key} is required")
        if entry.get("from") == entry.get("to"):
            errors.append(f"{where} succeeds itself")
        if entry.get("from") in seen:
            errors.append(f"{where}: {entry.get('from')} has more than one successor")
        seen.add(entry.get("from"))
        if not isinstance(entry.get("follow"), bool):
            errors.append(f"{where}.follow must be true or false")
    return errors
