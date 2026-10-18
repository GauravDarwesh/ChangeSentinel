"""Content extraction and deterministic normalization."""
from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup

REMOVE_TAGS = {
    "script", "style", "noscript", "template", "svg", "canvas", "iframe",
    "object", "embed", "nav", "footer", "aside",
}
DYNAMIC_MARKERS = {
    "cookie", "consent", "breadcrumb", "social", "share", "pagination",
    "pager", "toolbar", "modal", "popup", "banner",
}
CONTENT_SELECTORS = (
    "main", "[role='main']", "article", "#main-content", "#main",
    ".main-content", ".region-content",
)


def _attrs(tag):
    return getattr(tag, "attrs", None) or {}


def _should_remove(tag) -> bool:
    attrs = _attrs(tag)
    classes = attrs.get("class") or []
    marker = " ".join(
        [str(attrs.get("id") or ""), *[str(value) for value in classes]]
    ).lower()
    return any(term in marker for term in DYNAMIC_MARKERS)


def normalize_text(text: str) -> str:
    lines = []
    for line in text.splitlines():
        line = unicodedata.normalize("NFKC", line).replace("\u00a0", " ")
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _remove_default_noise(root) -> None:
    for tag in list(root.find_all(True)):
        attrs = _attrs(tag)
        if (
            tag.name in REMOVE_TAGS
            or "hidden" in attrs
            or str(attrs.get("aria-hidden") or "").lower() == "true"
            or _should_remove(tag)
        ):
            tag.decompose()


def _remove_ignored_nodes(root, ignore_selectors: tuple[str, ...]) -> None:
    for selector in ignore_selectors:
        for node in reversed(root.select(selector)):
            if node.parent is not None:
                node.decompose()


def normalize_html(
    html: str,
    include_selector: str | None = None,
    ignore_selectors: tuple[str, ...] | list[str] | None = None,
) -> str:
    """Extract stable text from a page or a configured CSS-selected region.

    A configured inclusion selector that matches nothing raises an explicit
    error instead of silently falling back to whole-page monitoring. Ignore
    selectors apply inside the included fragment, or to the page before
    default main-content detection when no inclusion selector is configured.
    """
    soup = BeautifulSoup(html, "html.parser")
    include_selector = str(include_selector or "").strip()
    ignored = tuple(
        str(selector).strip()
        for selector in (ignore_selectors or ())
        if str(selector).strip()
    )

    # Validate CSS syntax before noise removal. Ignore selectors are allowed
    # not to match; malformed selectors are reported as extraction errors.
    if include_selector:
        soup.select(include_selector)
    for selector in ignored:
        soup.select(selector)

    _remove_default_noise(soup)

    if include_selector:
        selected = soup.select(include_selector)
        if not selected:
            raise ValueError(
                f"Configured include selector matched no elements: {include_selector}"
            )
        selected_set = set(selected)
        selected_roots = [
            node for node in selected
            if not any(parent in selected_set for parent in node.parents)
        ]
        fragments = []
        for node in selected_roots:
            fragment = BeautifulSoup(str(node), "html.parser")
            _remove_default_noise(fragment)
            _remove_ignored_nodes(fragment, ignored)
            value = normalize_text(fragment.get_text("\n", strip=True))
            if value:
                fragments.append(value)
        return normalize_text("\n".join(fragments))

    _remove_ignored_nodes(soup, ignored)
    candidates = []
    for selector in CONTENT_SELECTORS:
        for node in soup.select(selector):
            length = len(node.get_text(" ", strip=True))
            if length:
                candidates.append((length, node))
    content = max(candidates, key=lambda item: item[0])[1] if candidates else (soup.body or soup)
    return normalize_text(content.get_text("\n", strip=True))


def _extension(url: str) -> str:
    return Path(urlparse(url).path.lower()).suffix


def extract_content(
    url: str,
    content_type: str,
    body: bytes,
    include_selector: str | None = None,
    ignore_selectors: tuple[str, ...] | list[str] | None = None,
):
    ctype, suffix = (content_type or "").lower(), _extension(url)
    decoded = body.decode("utf-8-sig", "replace")

    if "json" in ctype or suffix == ".json":
        try:
            payload = json.loads(decoded)
            normalized_json = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2)
            return normalized_json, "json", None
        except (json.JSONDecodeError, UnicodeError) as exc:
            return None, "json", f"{type(exc).__name__}: {exc}"

    if "xml" in ctype or suffix == ".xml":
        try:
            canonical_xml = ET.canonicalize(xml_data=decoded)
            root = ET.fromstring(canonical_xml)
            for node in root.iter():
                if node.text is not None and not node.text.strip():
                    node.text = None
                if node.tail is not None and not node.tail.strip():
                    node.tail = None
            ET.indent(root, space="  ")
            return ET.tostring(root, encoding="unicode"), "xml", None
        except (ET.ParseError, ValueError) as exc:
            return None, "xml", f"{type(exc).__name__}: {exc}"

    if "html" in ctype or suffix in {".html", ".htm"} or (not ctype and suffix == ""):
        try:
            return normalize_html(
                body.decode("utf-8", "replace"),
                include_selector=include_selector,
                ignore_selectors=ignore_selectors,
            ), "html", None
        except Exception as exc:
            return None, "html", f"HTML normalization failed: {type(exc).__name__}: {exc}"

    if "pdf" in ctype or suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(body))
            return normalize_text("\n".join(page.extract_text() or "" for page in reader.pages)), "pdf", None
        except Exception as exc:
            return None, "pdf", f"{type(exc).__name__}: {exc}"
    if "wordprocessingml.document" in ctype or suffix == ".docx":
        try:
            from docx import Document
            return normalize_text("\n".join(p.text for p in Document(io.BytesIO(body)).paragraphs)), "docx", None
        except Exception as exc:
            return None, "docx", f"{type(exc).__name__}: {exc}"
    if "spreadsheetml.sheet" in ctype or suffix == ".xlsx":
        try:
            from openpyxl import load_workbook
            wb = load_workbook(io.BytesIO(body), read_only=True, data_only=True)
            rows = []
            for sheet in wb.worksheets:
                rows.append(f"[SHEET] {sheet.title}")
                for row in sheet.iter_rows(values_only=True):
                    line = " | ".join("" if value is None else str(value) for value in row).strip()
                    if line:
                        rows.append(line)
            return normalize_text("\n".join(rows)), "xlsx", None
        except Exception as exc:
            return None, "xlsx", f"{type(exc).__name__}: {exc}"
    if "presentationml.presentation" in ctype or suffix == ".pptx":
        try:
            from pptx import Presentation
            parts = []
            for index, slide in enumerate(Presentation(io.BytesIO(body)).slides, start=1):
                parts.append(f"[SLIDE] {index}")
                parts.extend(
                    getattr(shape, "text", "")
                    for shape in slide.shapes
                    if getattr(shape, "text", "")
                )
            return normalize_text("\n".join(parts)), "pptx", None
        except Exception as exc:
            return None, "pptx", f"{type(exc).__name__}: {exc}"
    if "csv" in ctype or suffix == ".csv":
        try:
            rows = [" | ".join(row) for row in csv.reader(io.StringIO(body.decode("utf-8-sig", "replace")))]
            return normalize_text("\n".join(rows)), "csv", None
        except Exception as exc:
            return None, "csv", f"{type(exc).__name__}: {exc}"
    if ctype.startswith("text/") or suffix == ".txt":
        return normalize_text(body.decode("utf-8", "replace")), "text", None
    return None, "binary", "Unsupported content type for text extraction"
