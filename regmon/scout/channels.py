"""Parsers for the three discovery channels: sitemaps, feeds and listing pages.

Each parser turns publisher bytes into Observations: a URL plus whatever
context came with it (title, link text, surrounding listing text, dates,
categories, language alternates). Nothing here fetches; the sweep does that.
"""
from __future__ import annotations

import gzip
import io
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from regmon.scout.urls import absolute

GENERIC_ANCHORS = {
    "", "download", "download document", "download file", "download pdf", "pdf", "here", "click here", "read more",
    "more", "view", "view press release", "press release", "link", "details", "see more", "learn more", "full text",
    "en savoir plus", "lire la suite", "télécharger", "ver más", "leia mais", "saiba mais", "next", "previous",
}
DATE_PATTERNS = (
    re.compile(r"\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s*,?\s+(\d{4})\b", re.I),
    re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b", re.I),
    re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"),
)
MONTHS = {name: index for index, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
CONTEXT_TAGS = ("li", "tr", "article", "dd", "dt", "p", "figure", "section")
CONTEXT_CLASS_RE = re.compile(r"(row|item|card|teaser|result|entry|listing|views-row|publication|document)", re.I)
MAX_CONTEXT = 320
MAX_SITEMAP_BYTES_EXPANDED = 60_000_000


class ParseError(ValueError):
    pass


@dataclass
class Observation:
    url: str
    original_url: str
    channel_id: str
    channel_type: str
    title: str = ""
    anchor_text: str = ""
    title_attr: str = ""
    context: str = ""
    parent_url: str = ""
    description: str = ""
    categories: list[str] = field(default_factory=list)
    published: str = ""
    lastmod: str = ""
    date_hint: str = ""
    language: str = ""
    alternates: dict = field(default_factory=dict)


def clean(text, limit: int = 600) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def iso(value) -> str:
    """Normalise an RFC 822, W3C or ISO date to ISO 8601 UTC; "" if unparseable."""
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = None
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        parsed = None
    if parsed is None:
        candidate = text.replace("Z", "+00:00")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", candidate):
            candidate += "T00:00:00+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def date_in_text(text: str) -> str:
    """First calendar date written in listing text, as YYYY-MM-DD ("" if none)."""
    value = str(text or "")
    for pattern in DATE_PATTERNS:
        match = pattern.search(value)
        if not match:
            continue
        groups = match.groups()
        try:
            if pattern is DATE_PATTERNS[0]:
                day, month, year = int(groups[0]), MONTHS[groups[1].lower()], int(groups[2])
            elif pattern is DATE_PATTERNS[1]:
                month, day, year = MONTHS[groups[0].lower()], int(groups[1]), int(groups[2])
            else:
                year, month, day = int(groups[0]), int(groups[1]), int(groups[2])
            return datetime(year, month, day).strftime("%Y-%m-%d")
        except (ValueError, KeyError):
            continue
    return ""


# ---------------------------------------------------------------- XML safety

def _maybe_gunzip(body: bytes) -> bytes:
    if body[:2] != b"\x1f\x8b":
        return body
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
            data = stream.read(MAX_SITEMAP_BYTES_EXPANDED + 1)
    except (OSError, EOFError) as exc:
        raise ParseError(f"Compressed sitemap could not be read: {exc}") from exc
    if len(data) > MAX_SITEMAP_BYTES_EXPANDED:
        raise ParseError("Compressed sitemap expands beyond the safety limit")
    return data


def safe_xml(body: bytes) -> ET.Element:
    """Parse publisher XML, refusing entity declarations (no XXE, no entity bombs).

    Sitemaps and feeds never need a DTD internal subset; a document that
    declares entities is rejected rather than expanded.
    """
    data = _maybe_gunzip(body)
    lowered = data.lower()
    if b"<!entity" in lowered:
        raise ParseError("XML declares entities; refusing to parse it")
    doctype = lowered.find(b"<!doctype", 0, 8192)
    if doctype >= 0:
        declaration = lowered[doctype: doctype + 8192]
        close, subset = declaration.find(b">"), declaration.find(b"[")
        if subset != -1 and (close == -1 or subset < close):
            raise ParseError("XML has an internal DTD subset; refusing to parse it")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ParseError(f"Not well-formed XML: {exc}") from exc


def _local(tag) -> str:
    return str(tag).rsplit("}", 1)[-1].split(":")[-1].lower()


def _children(element, name: str):
    return [child for child in list(element) if _local(child.tag) == name]


def _child_text(element, *names: str) -> str:
    for child in list(element):
        if _local(child.tag) in names and (child.text or "").strip():
            return child.text.strip()
    return ""


# ---------------------------------------------------------------- sitemaps

@dataclass
class SitemapDocument:
    kind: str  # "index" or "urlset"
    entries: list[dict]


def parse_sitemap(body: bytes, base_url: str) -> SitemapDocument:
    root = safe_xml(body)
    name = _local(root.tag)
    if name == "sitemapindex":
        entries = []
        for item in _children(root, "sitemap"):
            loc = absolute(base_url, _child_text(item, "loc"))
            if loc:
                entries.append({"loc": loc, "lastmod": iso(_child_text(item, "lastmod"))})
        return SitemapDocument("index", entries)
    if name == "urlset":
        entries = []
        for item in _children(root, "url"):
            loc = absolute(base_url, _child_text(item, "loc"))
            if not loc:
                continue
            alternates = {}
            for link in list(item):
                if _local(link.tag) != "link":
                    continue
                if str(link.get("rel") or "").lower() != "alternate":
                    continue
                language = str(link.get("hreflang") or "").strip().lower()
                href = absolute(base_url, link.get("href") or "")
                if language and href and language != "x-default":
                    alternates[language] = href
            entries.append({"loc": loc, "lastmod": iso(_child_text(item, "lastmod")), "alternates": alternates})
        return SitemapDocument("urlset", entries)
    raise ParseError(f"Expected <urlset> or <sitemapindex>, found <{name}>")


# ---------------------------------------------------------------- feeds

@dataclass
class FeedItem:
    link: str
    title: str = ""
    description: str = ""
    published: str = ""
    categories: list[str] = field(default_factory=list)
    description_links: list[tuple[str, str]] = field(default_factory=list)


def _html_text_and_links(fragment: str, base_url: str) -> tuple[str, list[tuple[str, str]]]:
    if "<" not in fragment:
        return clean(fragment, 800), []
    from bs4 import BeautifulSoup  # lazy: review tooling imports this module without bs4

    soup = BeautifulSoup(fragment, "html.parser")
    links = []
    for tag in soup.find_all("a", href=True):
        url = absolute(base_url, tag.get("href"))
        if url:
            links.append((url, clean(tag.get_text(" ", strip=True), 200)))
    return clean(soup.get_text(" ", strip=True), 800), links


def parse_feed(body: bytes, base_url: str) -> list[FeedItem]:
    root = safe_xml(body)
    name = _local(root.tag)
    if name == "rss":
        channels = _children(root, "channel")
        nodes = _children(channels[0], "item") if channels else []
    elif name == "rdf":
        nodes = _children(root, "item")
    elif name == "feed":
        nodes = _children(root, "entry")
    else:
        raise ParseError(f"Expected an RSS, RDF or Atom feed, found <{name}>")
    items = []
    for node in nodes:
        link = ""
        if name == "feed":
            for candidate in _children(node, "link"):
                rel = str(candidate.get("rel") or "alternate").lower()
                if rel == "alternate" and candidate.get("href"):
                    link = candidate.get("href")
                    break
            categories = [str(item.get("term") or item.text or "").strip() for item in _children(node, "category")]
            raw_description = _child_text(node, "summary", "content")
            published = _child_text(node, "published", "updated")
        else:
            link = _child_text(node, "link") or str(node.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about") or "")
            if not link:
                guid = _children(node, "guid")
                if guid and str(guid[0].get("isPermaLink", "true")).lower() != "false":
                    link = (guid[0].text or "").strip()
            categories = [(item.text or "").strip() for item in list(node) if _local(item.tag) in {"category", "subject"}]
            raw_description = _child_text(node, "description", "encoded")
            published = _child_text(node, "pubdate", "date", "published", "updated")
        description, description_links = _html_text_and_links(raw_description, base_url)
        items.append(FeedItem(
            link=absolute(base_url, link.strip()) or "",
            title=clean(_child_text(node, "title"), 400),
            description=description,
            published=iso(published),
            categories=[clean(item, 120) for item in categories if item],
            description_links=description_links,
        ))
    return items


# ---------------------------------------------------------------- listing pages

@dataclass
class ListingLink:
    url: str
    anchor_text: str
    context: str
    title_attr: str = ""
    date_hint: str = ""


def _context_for(tag) -> str:
    node = tag.parent
    depth = 0
    while node is not None and getattr(node, "name", None) not in (None, "[document]") and depth < 6:
        classes = " ".join(node.get("class") or []) if hasattr(node, "get") else ""
        if node.name in CONTEXT_TAGS or (node.name == "div" and CONTEXT_CLASS_RE.search(classes)):
            text = clean(node.get_text(" ", strip=True), 2000)
            if len(text) <= 900:
                return clean(text, MAX_CONTEXT)
            break
        node = node.parent
        depth += 1
    return ""


def harvest_listing(html: str, page_url: str, content_selector: str = "") -> list[ListingLink]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for element in soup(["script", "style", "noscript", "template", "svg"]):
        element.decompose()
    # Drop site-wide chrome, but keep <header>/<footer> that belong to a listed
    # item (Drupal and similar themes wrap each teaser's title in <header>).
    for element in soup.find_all(["header", "footer", "nav"]):
        if getattr(element, "decomposed", False):
            continue
        if element.find_parent(["article", "main", "li", "tr"]) is None:
            element.decompose()
    roots = soup.select(content_selector) if content_selector else []
    if content_selector and not roots:
        raise ParseError(f"The content selector {content_selector!r} matched nothing on {page_url}; the page layout may have changed")
    scope = roots or [soup.find("main") or soup.body or soup]
    found: dict[str, ListingLink] = {}
    order: list[str] = []
    for root in scope:
        for tag in root.find_all("a", href=True):
            url = absolute(page_url, tag.get("href"))
            if not url:
                continue
            anchor = clean(tag.get_text(" ", strip=True), 300)
            context = _context_for(tag)
            link = ListingLink(url=url, anchor_text=anchor, context=context,
                               title_attr=clean(tag.get("title") or "", 300), date_hint=date_in_text(context))
            existing = found.get(url)
            if existing is None:
                found[url] = link
                order.append(url)
            elif anchor.lower() not in GENERIC_ANCHORS and (existing.anchor_text.lower() in GENERIC_ANCHORS or len(anchor) > len(existing.anchor_text)):
                # Keep the most descriptive label when the same URL is linked twice
                # ("Title" and "Download document").
                found[url] = ListingLink(url, anchor, existing.context or context, existing.title_attr or link.title_attr,
                                         existing.date_hint or link.date_hint)
    return [found[url] for url in order]


def page_metadata(html: str) -> dict:
    """Title, heading, description, dates and language from one fetched HTML page."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")

    def meta(*names):
        for item in names:
            tag = soup.find("meta", attrs={"property": item}) or soup.find("meta", attrs={"name": item})
            if tag and tag.get("content"):
                return clean(tag["content"], 400)
        return ""

    heading = soup.find("h1")
    canonical_link = soup.find("link", rel=lambda value: value and "canonical" in str(value).lower())
    html_tag = soup.find("html")
    published = meta("article:published_time", "dcterms.date", "dc.date", "dcterms.issued", "date", "publication_date")
    modified = meta("article:modified_time", "dcterms.modified", "last-modified")
    return {
        "page_title": clean(soup.title.get_text(" ", strip=True) if soup.title else "", 300),
        "heading": clean(heading.get_text(" ", strip=True) if heading else "", 300),
        "meta_description": meta("description", "og:description", "dcterms.description"),
        "page_type": meta("og:type", "dcterms.type", "dc.type"),
        "page_published": iso(published) or (date_in_text(published) if published else ""),
        "page_modified": iso(modified),
        "page_language": clean(html_tag.get("lang") if html_tag else "", 20).lower(),
        "canonical_link": str(canonical_link.get("href") or "").strip() if canonical_link else "",
        "keywords": meta("keywords", "dcterms.subject", "dc.subject"),
    }
