"""Content extraction and deterministic normalization."""
from __future__ import annotations

import csv
import io
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlparse
from bs4 import BeautifulSoup

REMOVE_TAGS = {"script","style","noscript","template","svg","canvas","iframe","object","embed","nav","footer","aside"}
DYNAMIC_MARKERS = {"cookie","consent","breadcrumb","social","share","pagination","pager","toolbar","modal","popup","banner"}
CONTENT_SELECTORS = ("main","[role='main']","article","#main-content","#main",".main-content",".region-content")

def _attrs(tag):
    return getattr(tag, "attrs", None) or {}

def _should_remove(tag) -> bool:
    attrs = _attrs(tag)
    marker = " ".join([str(attrs.get("id") or ""), *[str(v) for v in (attrs.get("class") or [])]]).lower()
    return any(term in marker for term in DYNAMIC_MARKERS)

def normalize_text(text: str) -> str:
    lines = []
    for line in text.splitlines():
        line = unicodedata.normalize("NFKC", line).replace("\u00a0", " ")
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)

def normalize_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(True):
        if tag.name in REMOVE_TAGS or "hidden" in _attrs(tag) or str(_attrs(tag).get("aria-hidden") or "").lower() == "true" or _should_remove(tag):
            tag.decompose()
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

def extract_content(url: str, content_type: str, body: bytes):
    ctype, suffix = (content_type or "").lower(), _extension(url)
    if "html" in ctype or suffix in {"", ".html", ".htm"}:
        return normalize_html(body.decode("utf-8", "replace")), "html", None
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
                    line = " | ".join("" if v is None else str(v) for v in row).strip()
                    if line:
                        rows.append(line)
            return normalize_text("\n".join(rows)), "xlsx", None
        except Exception as exc:
            return None, "xlsx", f"{type(exc).__name__}: {exc}"
    if "presentationml.presentation" in ctype or suffix == ".pptx":
        try:
            from pptx import Presentation
            parts = []
            for i, slide in enumerate(Presentation(io.BytesIO(body)).slides, start=1):
                parts.append(f"[SLIDE] {i}")
                parts.extend(getattr(shape, "text", "") for shape in slide.shapes if getattr(shape, "text", ""))
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
