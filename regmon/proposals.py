"""Proposed revisions: Federal Register notices linked to the forms they revise.

Regulators publish each proposal as a small package on the form's page: the
initial Federal Register notice (comments invited), the final notice (sent to
OMB), redlined draft forms and instructions, a list of the data items it
affects and a letter to filers. Link lineage (data/link-lineage.json) already
records every link of every monitored page with its section heading and when
it appeared, so this module reads proposals from there, with no fetch and no
model:

* a **package** is a section of a form page whose heading names a proposal,
  revision, request for comment or extension ("October 2026 Call Report
  Revisions Related to …"), or, on a page that lists many notices under one
  heading (the Fed's "Information collections under review"), one notice;
* packages that share a Federal Register document number (2024-01532) or the
  same heading on several pages (FFIEC 031, 041 and 051) are one proposal;
* **forms** come from the form page's address (…/reporting-forms/ffiec031,
  …/Report/Index/FR_Y-9C), the heading and the link text ("FFIEC 031, FFIEC
  041, and FFIEC 051", "FR Y-14A/Q/M");
* **stage**: ``final`` once a final notice or final rule is listed,
  ``extension`` for an extension without revision, ``request`` for a request
  for comment or information, otherwise ``proposed``;
* **effective** dates are the ones the heading or a document title states
  after "Effective"; **published** dates come from Federal Register addresses
  (/documents/2026/10/27/…).

data/proposals.json:

    {"schema_version": 1, "updated_at",
     "proposals": [{"id", "title", "titles", "forms", "stage", "effective": [iso], "published": [iso],
                    "date", "date_basis" (published | heading | year | number | first_seen), "pages", "first_seen", "removed_at"?,
                    "documents": [{"url", "text", "kind", "published"?, "first_seen", "removed_at"?}]}],
     "forms": {"FFIEC 031": [proposal ids, newest first]}, "unlinked": n}

``unlinked`` counts notices whose form could not be read (the Fed page's
"link 1" rows); they are kept, under no form.

    python -m regmon.proposals show "FFIEC 031"
    python -m regmon.proposals build
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FILE_NAME = "proposals.json"
SCHEMA_VERSION = 1
MAX_TEXT = 300
# A heading that is a proposal package rather than the page's own content.
PACKAGE_HEADING = re.compile(r"propos|revision|request for (comment|information)|extension|rulemaking|federal register", re.I)
# More notices than this under one heading: a list of notices, each its own proposal.
LIST_HEADING_NOTICES = 12
FR_HOST = re.compile(r"(^|\.)(federalregister\.gov|govinfo\.gov)$", re.I)
FR_NUMBER = re.compile(r"(?<![\w-])((?:C\d-)?(?:19|20)\d\d-\d{4,6})(?![\w-])")
OMB_REFERENCE = re.compile(r"\b(?:R|OP)-\d{3,5}\b")
FR_PUBLISHED = re.compile(r"/documents/((?:19|20)\d\d)/(\d\d)/(\d\d)/")
MONTHS = {name: index for index, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
DATE_TEXT = re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:19|20)\d\d)\b", re.I)
EFFECTIVE = re.compile(r"\beffective\b(?:\s+dates?)?(?:\s+(?:as\s+of|of|on))?\s*", re.I)
FFIEC_FORMS = re.compile(r"\bFFIEC\s?(\d{3}[a-z]?)((?:\s*/\s*\d{3}[a-z]?)*)", re.I)
FR_FORMS = re.compile(r"\bFR\s+(Y-\d+(?:\s?[A-Z]+(?:/[A-Z]+)+|[A-Z]*(?:/[A-Z]+)*)|\d{3,4}[a-z]?(?:/[a-z])?|[A-Z]{1,3}(?:-\d+)?)(?![\w-])")
PAGE_FORM = (
    (re.compile(r"/reporting-forms/ffiec(\d{3}[a-z]?)(?:[-/]|$)", re.I), lambda m: "FFIEC " + m.group(1).upper()),
    (re.compile(r"/reportingforms/Report/Index/FR_([A-Za-z0-9-]+)", re.I), lambda m: "FR " + m.group(1)),
)
KINDS = (
    ("final_notice", re.compile(r"final (federal register )*(register )?notice|final rule|submission for omb|submitted to omb|omb review", re.I)),
    ("initial_notice", re.compile(r"initial (federal register )*(register )?notice|notice of proposed rulemaking|proposed agency information collection|comment request", re.I)),
    ("request", re.compile(r"request for (comment|information)", re.I)),
    ("draft", re.compile(r"draft|redline", re.I)),
    ("impact_list", re.compile(r"data ?elements ?impact|list detailing|items proposed to be", re.I)),
    ("letter", re.compile(r"\bFIL-?\d|letter", re.I)),
)
KIND_WORDS = {"final_notice": "Final notice", "initial_notice": "Initial notice", "notice": "Federal Register notice", "request": "Request for comment",
              "draft": "Draft", "impact_list": "Items affected", "letter": "Letter", "other": "Document"}
STAGE_WORDS = {"final": "Final", "proposed": "Proposed", "under_review": "Under review", "request": "Request for comment",
               "extension": "Extension without revision"}


def _clean(value: object, limit: int = MAX_TEXT) -> str:
    return " ".join(str(value or "").split())[:limit]


def _host(url: str) -> str:
    match = re.match(r"https?://([^/]+)", url or "", re.I)
    return (match.group(1) if match else "").lower()


def is_notice(url: str) -> bool:
    return bool(FR_HOST.search(_host(url)))


def fr_number(url: str, text: str = "") -> str:
    """The Federal Register document number of a notice address (2024-01532), or ''."""
    if not is_notice(url):
        return ""
    match = FR_NUMBER.search(url)
    return match.group(1).upper() if match else ""


def published(url: str) -> str:
    match = FR_PUBLISHED.search(url or "")
    return "-".join(match.groups()) if match else ""


def normalize_form(text: str) -> str:
    """'ffiec031' / 'FFIEC  031' -> 'FFIEC 031'; 'FR_Y-9C' / 'fr y-9c' -> 'FR Y-9C'."""
    text = " ".join(str(text or "").replace("_", " ").split())
    match = re.fullmatch(r"(?i)ffiec\s?(\d{3}[a-z]?)", text)
    if match:
        return "FFIEC " + match.group(1).upper()
    match = re.fullmatch(r"(?i)fr\s?(y-?\d+[a-z]*|\d{3,4}[a-z]?|[a-z]{1,3}(?:-\d+)?)", text)
    if match:
        body = match.group(1)
        if body[:1].lower() == "y":
            body = "Y-" + body[1:].lstrip("-").upper()
        elif re.fullmatch(r"\d{3,4}[a-z]?", body, re.I):
            body = body[:-1] + body[-1].lower() if body[-1].isalpha() else body
        else:
            body = body.upper()
        return "FR " + body
    return text


def forms_in(text: str) -> set[str]:
    """Forms a heading or link text names: 'FFIEC 031, FFIEC 041' / 'FFIEC 031/041' / 'FR Y-14A/Q/M'."""
    found: set[str] = set()
    for match in FFIEC_FORMS.finditer(text or ""):
        found.add("FFIEC " + match.group(1).upper())
        for extra in re.findall(r"\d{3}[a-z]?", match.group(2) or "", re.I):
            found.add("FFIEC " + extra.upper())
    for match in FR_FORMS.finditer(text or ""):
        body = re.sub(r"(Y-\d+)\s(?=[A-Z])", r"\1", match.group(1))
        head, *tails = body.split("/")
        found.add(normalize_form("FR " + head))
        stem = re.match(r"(Y-\d+)", head)
        for tail in tails:
            if stem and re.fullmatch(r"[A-Z]+", tail):
                found.add("FR " + stem.group(1) + tail)
    return {form for form in found if form}


def page_form(url: str) -> str:
    for pattern, name in PAGE_FORM:
        match = pattern.search(url or "")
        if match:
            return normalize_form(name(match))
    return ""


def _iso(month: str, day: str, year: str) -> str:
    try:
        return date(int(year), MONTHS[month.lower()], int(day)).isoformat()
    except (KeyError, ValueError):
        return ""


def effective_dates(text: str) -> list[str]:
    """Dates stated right after 'Effective' ('Effective September 30, 2016, and March 31, 2017')."""
    out: list[str] = []
    for match in EFFECTIVE.finditer(text or ""):
        tail = text[match.end():match.end() + 160]
        position = 0
        for found in DATE_TEXT.finditer(tail):
            between = tail[position:found.start()]
            # The first date follows "Effective" closely ("Effective for the June 30, 2026, report date");
            # later ones only through "and" / commas.
            if position == 0 and len(between) > 20:
                break
            if position and not re.fullmatch(r"[\s,]*(?:and|or|&)?[\s,]*", between, re.I):
                break
            day = _iso(*found.groups())
            if day and day not in out:
                out.append(day)
            position = found.end()
    return sorted(out)


def kind_of(url: str, text: str) -> str:
    probe = " ".join((text or "", url or ""))
    for kind, pattern in KINDS:
        if pattern.search(probe):
            return kind
    return "notice" if is_notice(url) else "other"


def _stage(heading: str, kinds: set[str]) -> str:
    if re.search(r"extension without revision", heading or "", re.I):
        return "extension"
    if "final_notice" in kinds:
        return "final"
    if "request" in kinds or re.search(r"request for (comment|information)", heading or "", re.I):
        return "request"
    if kinds <= {"notice", "other"} and not re.search(r"propos", heading or "", re.I):
        return "under_review"  # a notice listed with no word of its stage (the Fed's collections under review)
    return "proposed"


def _heading_month(heading: str) -> str:
    """'October 2026 Call Report Revisions…' -> 2026-10-01; '2016 FFIEC 009 Extension…' -> 2016-01-01."""
    match = re.match(r"\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d\d)\b", heading or "", re.I)
    if match:
        return f"{match.group(2)}-{MONTHS[match.group(1).lower()]:02d}-01"
    match = re.match(r"\s*((?:19|20)\d\d)\b", heading or "")
    return f"{match.group(1)}-01-01" if match else ""


def _dated(dates: list[str], title: str, docs: list[dict], first_seen: str) -> dict:
    """The proposal's date for ordering, and what it rests on: a Federal Register publication
    date, the heading's month or year, a notice number's year, or when ChangeSentinel first saw it."""
    month = re.match(r"\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s", title or "", re.I)
    for basis, value in (("published", dates[-1] if dates else ""), ("heading" if month else "year", _heading_month(title)),
                         ("number", _number_year(docs)), ("first_seen", first_seen[:10])):
        if value:
            return {"date": value, "date_basis": basis}
    return {"date": "", "date_basis": ""}


def _number_year(documents: list[dict]) -> str:
    """The newest year in the documents' Federal Register numbers (2024-01532 -> 2024-01-01), for ordering only."""
    years = sorted(re.match(r"(?:C\d-)?((?:19|20)\d\d)", fr_number(doc["url"])).group(1) for doc in documents if fr_number(doc["url"]))
    return f"{years[-1]}-01-01" if years else ""


def title_of(text: str, url: str = "") -> str:
    """A notice's link text as a title: 'FR 4205 R-1746 · link' -> 'FR 4205 R-1746'; 'link 1' -> 'Federal Register notice 2023-16896'."""
    text = re.sub(r"\s*·\s*link\b.*$|^link\s*\d*$", "", _clean(text), flags=re.I).strip()
    return text or ("Federal Register notice " + fr_number(url) if fr_number(url) else "Federal Register notice")


def _candidates(lineage: dict) -> list[dict]:
    """Proposal packages, one per qualifying (page, heading) or per listed notice."""
    packages: list[dict] = []
    for page_url, page in sorted((lineage.get("pages") or {}).items()):
        by_section: dict[str, list[tuple[str, dict]]] = {}
        for url, entry in sorted((page.get("links") or {}).items()):
            if not isinstance(entry, dict) or entry.get("menu"):
                continue
            by_section.setdefault(_clean(entry.get("section")), []).append((url, entry))
        form = page_form(page_url)
        for heading, links in sorted(by_section.items()):
            notices = [(url, entry) for url, entry in links if is_notice(url)]
            if not notices:
                continue
            if len(notices) > LIST_HEADING_NOTICES or not PACKAGE_HEADING.search(heading):
                # A page of notices (or a notice outside a proposal heading): each notice alone.
                groups = [(title_of(entry.get("text"), url), [(url, entry)]) for url, entry in notices]
            else:
                groups = [(heading, links)]
            for title, members in groups:
                packages.append({"page": page_url, "page_form": form, "heading": heading if len(members) > 1 or title == heading else "",
                                 "title": title, "links": members})
    return packages


def build(lineage: dict) -> dict:
    """data/proposals.json from a link-lineage record."""
    packages = _candidates(lineage)
    # Union packages that share a Federal Register document or a proposal heading.
    parent = list(range(len(packages)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    owner: dict[str, int] = {}
    for index, package in enumerate(packages):
        keys = {"fr:" + number for number in (fr_number(url) for url, _entry in package["links"]) if number}
        if package["heading"]:
            keys.add("heading:" + package["heading"].lower())
        # Notices of one information collection (its OMB control number, R-1867 / OP-1882) are one proposal.
        clearance = OMB_REFERENCE.search(package["title"] or "")
        if clearance and forms_in(package["title"]):
            keys.add("omb:" + clearance.group(0).upper() + "|" + ",".join(sorted(forms_in(package["title"]))))
        for key in keys:
            if key in owner:
                parent[find(index)] = find(owner[key])
            else:
                owner[key] = index
    merged: dict[int, list[dict]] = {}
    for index, package in enumerate(packages):
        merged.setdefault(find(index), []).append(package)

    proposals: list[dict] = []
    unlinked = 0
    for group in merged.values():
        documents: dict[str, dict] = {}
        titles: list[str] = []
        forms: set[str] = set()
        pages: set[str] = set()
        for package in group:
            pages.add(package["page"])
            if package["title"] and package["title"] not in titles:
                titles.append(package["title"])
            if package["page_form"]:
                forms.add(package["page_form"])
            forms |= forms_in(package["heading"] or package["title"])
            for url, entry in package["links"]:
                text = _clean(entry.get("text"))
                if is_notice(url):
                    forms |= forms_in(text)
                key = ("fr:" + fr_number(url)) if fr_number(url) else url
                document = documents.get(key)
                first, removed = str(entry.get("first_seen") or ""), entry.get("removed_at")
                if document is None:
                    documents[key] = document = {"url": url, "text": text, "kind": kind_of(url, text), "first_seen": first}
                    if published(url):
                        document["published"] = published(url)
                    if removed:
                        document["removed_at"] = str(removed)
                else:
                    if published(url) and not document.get("published"):
                        document.update(url=url, published=published(url))
                    if len(text) > len(document["text"]) and not re.fullmatch(r"(link \d+|[^·]*· link)", text):
                        document["text"] = text
                        document["kind"] = kind_of(document["url"], text)
                    if first and (not document["first_seen"] or first < document["first_seen"]):
                        document["first_seen"] = first
                    if not removed:
                        document.pop("removed_at", None)
        docs = sorted(documents.values(), key=lambda doc: (doc.get("published") or doc.get("first_seen") or "", doc["url"]))
        heading_text = " ".join(titles)
        effective = sorted({day for text in [heading_text] + [doc["text"] for doc in docs] for day in effective_dates(text)})
        dates = sorted(doc["published"] for doc in docs if doc.get("published"))
        title = max(titles, key=lambda text: (bool(PACKAGE_HEADING.search(text)), not re.search(r"\blink\b", text), len(text))) if titles else docs[0]["text"]
        if not forms:
            unlinked += 1
        first_seen = min((doc["first_seen"] for doc in docs if doc["first_seen"]), default="")
        proposal = {
            "id": hashlib.sha256("|".join(sorted(doc["url"] for doc in docs)).encode("utf-8")).hexdigest()[:12],
            "title": title, "titles": titles, "forms": sorted(forms), "stage": _stage(heading_text, {doc["kind"] for doc in docs}),
            "effective": effective, "published": dates,
            **_dated(dates, title, docs, first_seen),
            "pages": sorted(pages), "first_seen": first_seen, "documents": docs,
        }
        if all(doc.get("removed_at") for doc in docs):
            proposal["removed_at"] = max(doc["removed_at"] for doc in docs)
        proposals.append(proposal)
    proposals.sort(key=lambda item: (item["date"], item["id"]), reverse=True)
    by_form: dict[str, list[str]] = {}
    for proposal in proposals:
        for form in proposal["forms"]:
            by_form.setdefault(form, []).append(proposal["id"])
    return {"schema_version": SCHEMA_VERSION, "proposals": proposals, "forms": dict(sorted(by_form.items())), "unlinked": unlinked}


def load(data_dir: Path) -> dict:
    try:
        payload = json.loads((data_dir / FILE_NAME).read_text(encoding="utf-8"))
        if isinstance(payload, dict) and payload.get("schema_version") == SCHEMA_VERSION:
            return payload
    except (OSError, ValueError):
        pass
    return {"schema_version": SCHEMA_VERSION, "proposals": [], "forms": {}, "unlinked": 0}


def for_forms(payload: dict, forms, limit: int = 10) -> list[dict]:
    """Proposals that revise any of these forms, newest first."""
    wanted = {normalize_form(form) for form in forms or ()}
    return [proposal for proposal in payload.get("proposals") or [] if wanted & set(proposal.get("forms") or [])][:limit]


def write(data_dir: Path, now: str | None = None) -> dict:
    """Rebuild data/proposals.json from data/link-lineage.json; rewrite only on change."""
    try:
        lineage = json.loads((data_dir / "link-lineage.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"proposals": 0, "written": False}
    built = build(lineage)
    existing = load(data_dir)
    if {key: existing.get(key) for key in ("proposals", "forms", "unlinked")} == {key: built[key] for key in ("proposals", "forms", "unlinked")}:
        return {"proposals": len(built["proposals"]), "written": False}
    built["updated_at"] = now or datetime.now(timezone.utc).isoformat()
    atomic_write_text(data_dir / FILE_NAME, json.dumps(built, indent=1, ensure_ascii=False) + "\n")
    return {"proposals": len(built["proposals"]), "written": True}


def validate(data_dir: Path) -> list[str]:
    path = data_dir / FILE_NAME
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [f"data/{FILE_NAME}: not JSON"]
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION or not isinstance(payload.get("proposals"), list):
        return [f"data/{FILE_NAME}: schema_version {SCHEMA_VERSION} with a proposals list is required"]
    ids = {proposal.get("id") for proposal in payload["proposals"] if isinstance(proposal, dict)}
    errors = [f"data/{FILE_NAME}: {form} lists an unknown proposal {pid}"
              for form, listed in (payload.get("forms") or {}).items() for pid in listed if pid not in ids]
    return errors[:20]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    show = sub.add_parser("show", help="proposals that revise a form")
    show.add_argument("form")
    sub.add_parser("build", help="rebuild data/proposals.json from data/link-lineage.json")
    args = parser.parse_args(argv)
    if args.command == "show":
        found = for_forms(load(DATA), [args.form], limit=100)
        if not found:
            print(f"{args.form}: no proposals recorded", file=sys.stderr)
            return 1
        for proposal in found:
            print(f"{proposal['date']}  {STAGE_WORDS.get(proposal['stage'], proposal['stage']):<26} {proposal['title']}"
                  + (f"  (effective {', '.join(proposal['effective'])})" if proposal["effective"] else ""))
        return 0
    print(json.dumps(write(DATA)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
