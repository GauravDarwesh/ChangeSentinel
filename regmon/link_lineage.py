"""Link lineage: which monitored page lists which link, since when, and when it went.

Every scan reads the links on each HTML page it fetches. data/link-lineage.json
keeps, per page, every link it has listed since tracking began: when the link
was first seen there and, once the page stops listing it, when it was removed.
So when a regulator deletes a link (a user guide, a sample file), the record
still says which page it was on, under what text, and the scan in which it
disappeared, and the dashboard can show "removed from <page> on <date>" for any
address, monitored or not.

    {
      "schema_version": 1,
      "updated_at": "...",
      "pages": {
        "<page url>": {
          "tracking_since": "...", "last_scan": "...", "listing": true,
          "links": {"<link url>": {"text": "...", "menu": false, "first_seen": "...", "removed_at": "..."}}
        }
      },
      "events": [{"at": "...", "page": "...", "url": "...", "text": "...", "change": "removed" | "added" | "restored"}]
    }

Pages come from two places: monitored HTML pages, read as part of their own
scan, and the pages a monitored link is listed on (the source's ``listed_on``:
the forms page a PDF was found on), read each scan for their links only and
marked ``"listing": true``. Monitored pages missing from the record are seeded
from their saved HTML copies automatically.

Only page-level times change on an ordinary scan, so the file does not churn in
git. A page that suddenly lists no links at all (a stub, an error page served
with 200) is not taken as every link having been removed.

    python -m regmon.link_lineage find fr2028      # where an address was (or is) listed
    python -m regmon.link_lineage backfill         # seed from the saved HTML snapshots
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FILE_NAME = "link-lineage.json"
SCHEMA_VERSION = 1
MAX_LINKS_PER_PAGE = 3000
MAX_REMOVED_PER_PAGE = 600
MAX_EVENTS = 3000
MAX_TEXT = 200
# Listing pages (a monitor's ``listed_on``) read per scan, links only.
MAX_LISTING_PAGES = 40
# A page whose link count falls to zero (or below this share of what it listed)
# in one scan is more likely broken than emptied; its links are not marked removed.
COLLAPSE_SHARE = 0.2
COLLAPSE_MIN_LINKS = 8
GENERIC_TEXT = re.compile(r"^(?:|link|here|click here|download|view|open|pdf|xlsx?|docx?|csv|xml|zip|more|details|n/?a)$", re.I)


def canonical_link(href: str, base: str) -> str:
    """An absolute http(s) address without its #fragment, or ''."""
    try:
        absolute = urljoin(base, str(href or "").strip())
        parts = urlsplit(absolute)
    except ValueError:
        return ""
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path or "/", parts.query, ""))


def extract_links(html: bytes | str, page_url: str) -> dict[str, dict]:
    """Every link on a page: address -> {"text", "menu"}, in page order."""
    if isinstance(html, bytes):
        html = html.decode("utf-8", "replace")
    soup = BeautifulSoup(html or "", "html.parser")
    base_tag = soup.find("base", href=True)
    base = canonical_link(base_tag["href"], page_url) if base_tag else ""
    base = base or page_url
    self_url = canonical_link(page_url, page_url)
    links: dict[str, dict] = {}
    for anchor in soup.find_all(["a", "area"], href=True):
        if str(anchor.get("href") or "").strip().startswith("#"):
            continue  # a jump within the page
        url = canonical_link(anchor.get("href"), base)
        if not url or url == self_url:
            continue
        text = " ".join(anchor.get_text(" ", strip=True).split())
        if not text:
            text = str(anchor.get("title") or anchor.get("aria-label") or "")
            image = anchor.find("img", alt=True)
            if not text and image:
                text = str(image.get("alt") or "")
        if GENERIC_TEXT.match(text or ""):
            # "link", "PDF", "Download" in a table: name it by its row ("FFIEC 031 · link").
            row = anchor.find_parent("tr")
            first = row.find(["th", "td"]) if row else None
            label = " ".join(first.get_text(" ", strip=True).split()) if first else ""
            if label and label != text:
                text = f"{label} · {text}" if text else label
        menu = bool(anchor.find_parent(["nav", "header", "footer"])) and not anchor.find_parent(["main", "article"])
        entry = links.get(url)
        if entry is None:
            if len(links) >= MAX_LINKS_PER_PAGE:
                break
            links[url] = {"text": text[:MAX_TEXT], "menu": menu}
        else:
            if not entry["text"] and text:
                entry["text"] = text[:MAX_TEXT]
            # Linked from the content as well as a menu: it is content.
            entry["menu"] = entry["menu"] and menu
    return links


def load(data_dir: Path = DATA) -> dict:
    path = data_dir / FILE_NAME
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION:
                payload.setdefault("pages", {})
                payload.setdefault("events", [])
                return payload
        except (OSError, ValueError):
            pass
    return {"schema_version": SCHEMA_VERSION, "updated_at": None, "pages": {}, "events": []}


def observe(lineage: dict, page_url: str, links: dict[str, dict] | None, at: str, listing: bool = False) -> list[dict]:
    """Record one scan of one page; returns the link events it produced.

    links=None means the page was checked but not re-read (an HTTP 304): its
    links are as they were.
    """
    pages = lineage.setdefault("pages", {})
    page = pages.get(page_url)
    if links is None:
        if page is not None:
            page["last_scan"] = at
        return []
    if page is None:
        # The first reading is the baseline: its links are where tracking starts, not additions.
        pages[page_url] = {
            "tracking_since": at, "last_scan": at,
            "links": {url: {"text": info["text"], "menu": info["menu"], "first_seen": at} for url, info in links.items()},
        }
        if listing:
            pages[page_url]["listing"] = True
        return []
    known: dict[str, dict] = page.setdefault("links", {})
    listed_before = [url for url, entry in known.items() if not entry.get("removed_at")]
    if listed_before and len(links) < max(1, len(listed_before) * COLLAPSE_SHARE) and len(listed_before) >= COLLAPSE_MIN_LINKS:
        page["last_scan"] = at
        page["last_collapse"] = {"at": at, "links": len(links), "before": len(listed_before)}
        return []
    events: list[dict] = []
    for url, info in links.items():
        entry = known.get(url)
        if entry is None:
            known[url] = {"text": info["text"], "menu": info["menu"], "first_seen": at}
            events.append({"at": at, "page": page_url, "url": url, "text": info["text"], "change": "added", "menu": info["menu"]})
        elif entry.get("removed_at"):
            entry.pop("removed_at", None)
            entry["restored_at"] = at
            if info["text"]:
                entry["text"] = info["text"]
            events.append({"at": at, "page": page_url, "url": url, "text": entry.get("text", ""), "change": "restored", "menu": entry.get("menu", False)})
        elif info["text"] and info["text"] != entry.get("text"):
            entry["text"] = info["text"]
    for url in listed_before:
        if url not in links:
            entry = known[url]
            entry["removed_at"] = at
            events.append({"at": at, "page": page_url, "url": url, "text": entry.get("text", ""), "change": "removed", "menu": entry.get("menu", False)})
    # Bound the record: the oldest removals go first, current links are never dropped.
    removed = sorted((entry["removed_at"], url) for url, entry in known.items() if entry.get("removed_at"))
    for _, url in removed[:max(0, len(removed) - MAX_REMOVED_PER_PAGE)]:
        known.pop(url, None)
    page["last_scan"] = at
    return events


def apply(data_dir: Path, observations: list[dict], now: str | None = None) -> dict:
    """Fold a scan's observations into data/link-lineage.json and save it."""
    lineage = load(data_dir)
    events: list[dict] = []
    for observation in sorted(observations, key=lambda entry: (str(entry.get("at") or ""), str(entry.get("page") or ""))):
        page = str(observation.get("page") or "")
        if not page:
            continue
        events.extend(observe(lineage, page, observation.get("links"), str(observation.get("at") or now or _now()), bool(observation.get("listing"))))
    if events:
        lineage["events"] = (events[::-1] + list(lineage.get("events") or []))[:MAX_EVENTS]
    lineage["updated_at"] = now or _now()
    atomic_write_text(data_dir / FILE_NAME, json.dumps(lineage, indent=1, sort_keys=True))
    return {"events": len(events), "pages": len(lineage["pages"])}


def find(lineage: dict, query: str) -> list[dict]:
    """Every page that lists, or listed, an address containing the query."""
    needle = str(query or "").strip().lower()
    out = []
    if not needle:
        return out
    for page_url, page in (lineage.get("pages") or {}).items():
        for url, entry in (page.get("links") or {}).items():
            if needle in url.lower() or needle in str(entry.get("text") or "").lower():
                out.append({"url": url, "page": page_url, "text": entry.get("text", ""), "first_seen": entry.get("first_seen"),
                            "removed_at": entry.get("removed_at"), "tracking_since": page.get("tracking_since")})
    out.sort(key=lambda row: (row["removed_at"] is None, str(row["removed_at"] or ""), row["url"]))
    return out


def backfill(data_dir: Path = DATA) -> dict:
    """Seed the record from what is already saved, so past removals keep their dates.

    For each monitored page, its saved HTML copies are replayed in time order:
    the "before" copy of its oldest recorded change, the "after" copy of every
    change (at that change's time), then its latest copy. Pages already in the
    record are left alone.
    """
    root = data_dir.parent
    latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8")) if (data_dir / "latest.json").exists() else {}
    lineage = load(data_dir)
    items = {}
    for source_items in (latest.get("sources") or {}).values():
        for item in (source_items or {}).values():
            if item.get("canonical_url") and item.get("active") is not False:
                items[item["canonical_url"]] = item
    timeline: dict[str, list[tuple[str, str]]] = {}
    for path in sorted((data_dir / "evidence").glob("*.json")) if (data_dir / "evidence").is_dir() else []:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        url = record.get("url")
        if record.get("event_type") not in {"CHANGED_URL", "HTML_SOURCE_CHANGED"} or url not in items:
            continue
        before = (record.get("before") or {}).get("html_snapshot_location")
        after = (record.get("after") or {}).get("html_snapshot_location")
        at = str(record.get("timestamp") or "")
        if before:
            timeline.setdefault(url, []).append(("", before))
        if after and at:
            timeline.setdefault(url, []).append((at, after))
    for url, item in items.items():
        if item.get("html_snapshot_location"):
            timeline.setdefault(url, []).append((str(item.get("last_full_fetch") or item.get("last_checked") or _now()), item["html_snapshot_location"]))
    observations = []
    for url, copies in timeline.items():
        if url in lineage["pages"]:
            continue
        dated = sorted({copy for copy in copies if copy[0]})
        first = item_first = str(items[url].get("first_seen") or (dated[0][0] if dated else _now()))
        oldest_before = next((location for at, location in copies if not at), None)
        sequence = ([(first, oldest_before)] if oldest_before else []) + dated
        seen_locations = set()
        for at, location in sequence:
            if location in seen_locations and location != sequence[-1][1]:
                continue
            seen_locations.add(location)
            path = root / location
            if not path.exists():
                continue
            observations.append({"page": url, "at": at or item_first, "links": extract_links(path.read_bytes(), url)})
    if not observations:
        # Nothing new to seed: the record is left as it is (no churn in git).
        return {"events": 0, "pages": len(lineage["pages"])}
    return apply(data_dir, observations)


def listing_pages(sources, skip: set[str] | None = None, limit: int = MAX_LISTING_PAGES) -> list[str]:
    """The pages that list the scanned monitors' links (their ``listed_on``), once each.

    Pages the scan has already read as monitors are skipped: their links are
    recorded from that reading.
    """
    skip = set(skip or ())
    pages: list[str] = []
    for source in sources:
        for page in getattr(source, "listed_on", None) or ():
            page = str(page or "").strip()
            if page and page not in skip and page not in pages:
                pages.append(page)
    return pages[:limit]


def read_listing_pages(pages: list[str], fetch_page, at: str, budget_seconds: float = 120.0) -> list[dict]:
    """Read each listing page for its links only; returns observations for apply().

    ``fetch_page(url)`` returns the page's HTML (bytes or str), or None when the
    page could not be read as a page (an error, a bot check, a document).
    Pages that fail are skipped: their links are left as last recorded.
    """
    import time

    started = time.monotonic()
    observations = []
    for page in pages:
        if time.monotonic() - started > budget_seconds:
            break
        try:
            body = fetch_page(page)
        except Exception as exc:  # one unreadable page never stops the others
            print(f"Link lineage: listing page {page} not read: {type(exc).__name__}: {exc}")
            continue
        if not body:
            continue
        links = extract_links(body, page)
        if links:
            observations.append({"page": page, "at": at, "links": links, "listing": True})
    return observations


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    finder = sub.add_parser("find", help="where an address was or is listed")
    finder.add_argument("query")
    sub.add_parser("backfill", help="seed the record from the saved HTML snapshots")
    args = parser.parse_args()
    if args.command == "find":
        rows = find(load(DATA), args.query)
        if not rows:
            print("No monitored page lists or listed an address matching that.")
        for row in rows:
            state = f"removed {row['removed_at']}" if row["removed_at"] else "listed now"
            print(f"{row['url']}\n  on {row['page']} ({state}; first seen {row['first_seen']})")
    else:
        print(json.dumps(backfill(DATA)))


if __name__ == "__main__":
    main()
