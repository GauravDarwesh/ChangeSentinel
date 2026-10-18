"""Content extraction and deterministic normalization."""
from __future__ import annotations

import csv
import io
import json
import re
import stat
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
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


MAX_ZIP_MEMBERS = 256
MAX_ZIP_MEMBER_BYTES = 32 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 1000
ZIP_IGNORED_EXTENSIONS = {
    ".bmp", ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js",
    ".png", ".svg", ".webp",
}
ZIP_MEMBER_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".htm": "text/html",
    ".html": "text/html",
    ".json": "application/json",
    ".xml": "application/xml",
    ".xsd": "application/xml",
    ".txt": "text/plain",
}


def _validated_zip_infos(body: bytes):
    """Return validated archive metadata without extracting members to disk."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise ValueError(f"Invalid ZIP archive: {type(exc).__name__}: {exc}") from exc

    try:
        infos = archive.infolist()
        if not infos:
            raise ValueError("ZIP archive contains no entries")
        if len(infos) > MAX_ZIP_MEMBERS:
            raise ValueError(f"ZIP archive contains more than {MAX_ZIP_MEMBERS} entries")

        seen_names = set()
        total_uncompressed = 0
        for info in infos:
            name = info.filename.replace("\\\\", "/")
            path = PurePosixPath(name)
            if (
                not name
                or path.is_absolute()
                or name.startswith("/")
                or re.match(r"^[A-Za-z]:", name)
                or ".." in path.parts
            ):
                raise ValueError(f"Unsafe ZIP member path: {info.filename!r}")
            if name in seen_names:
                raise ValueError(f"Duplicate ZIP member path: {name!r}")
            seen_names.add(name)

            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise ValueError(f"Symbolic links are not supported in ZIP archives: {name}")
            if info.flag_bits & 0x1:
                raise ValueError(f"Encrypted ZIP members are not supported: {name}")
            if info.is_dir():
                continue
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise ValueError(f"ZIP member exceeds {MAX_ZIP_MEMBER_BYTES} bytes: {name}")
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_ZIP_TOTAL_BYTES:
                raise ValueError(f"ZIP contents exceed {MAX_ZIP_TOTAL_BYTES} uncompressed bytes")
            if info.file_size and info.file_size / max(1, info.compress_size) > MAX_ZIP_COMPRESSION_RATIO:
                raise ValueError(f"ZIP member has an unsafe compression ratio: {name}")
        return archive, infos
    except Exception:
        archive.close()
        raise


def _office_open_xml_suffix(names: set[str]) -> str | None:
    if "word/document.xml" in names and "[Content_Types].xml" in names:
        return ".docx"
    if "xl/workbook.xml" in names and "[Content_Types].xml" in names:
        return ".xlsx"
    if "ppt/presentation.xml" in names and "[Content_Types].xml" in names:
        return ".pptx"
    return None


def _extract_zip_bundle(body: bytes):
    archive, infos = _validated_zip_infos(body)
    try:
        extracted = []
        skipped_assets = []
        for info in sorted(infos, key=lambda entry: (entry.filename.casefold(), entry.filename)):
            if info.is_dir():
                continue
            name = info.filename.replace("\\\\", "/")
            lowered_name = name.casefold()
            if lowered_name.startswith("__macosx/") or PurePosixPath(name).name.casefold() in {
                ".ds_store", "thumbs.db", "desktop.ini"
            }:
                continue
            suffix = PurePosixPath(name).suffix.lower()
            if suffix in ZIP_IGNORED_EXTENSIONS:
                skipped_assets.append(name)
                continue
            if suffix not in {
                ".csv", ".docx", ".htm", ".html", ".json", ".pdf",
                ".pptx", ".txt", ".xlsx", ".xml", ".xsd",
            }:
                raise ValueError(f"Unsupported file type inside ZIP archive: {name}")

            member_bytes = archive.read(info)
            media_type = ZIP_MEMBER_MEDIA_TYPES.get(suffix, "")
            text, kind, error = extract_content(name, media_type, member_bytes)
            if error:
                raise ValueError(f"Could not extract ZIP member {name}: {error}")
            if text is not None and text.strip():
                extracted.append((name, kind, text))

        if not extracted:
            suffix_note = f" (ignored {len(skipped_assets)} media/style assets)" if skipped_assets else ""
            raise ValueError("ZIP archive contains no supported extractable documents" + suffix_note)

        parts = []
        for name, kind, text in extracted:
            parts.append(f"[FILE] {name} ({kind})\n{text}")
        return normalize_text("\n\n".join(parts)), "zip", None
    except Exception as exc:
        return None, "zip", f"ZIP extraction failed: {type(exc).__name__}: {exc}"
    finally:
        archive.close()


def extract_content(
    url: str,
    content_type: str,
    body: bytes,
    include_selector: str | None = None,
    ignore_selectors: tuple[str, ...] | list[str] | None = None,
):
    ctype, suffix = (content_type or "").lower(), _extension(url)
    zip_signature = body.startswith((b"PK\\x03\\x04", b"PK\\x05\\x06", b"PK\\x07\\x08"))
    if "zip" in ctype or suffix == ".zip" or zip_signature:
        try:
            archive, infos = _validated_zip_infos(body)
            try:
                names = {info.filename.replace("\\\\", "/") for info in infos}
                office_suffix = _office_open_xml_suffix(names)
            finally:
                archive.close()
        except Exception as exc:
            return None, "zip", f"ZIP validation failed: {type(exc).__name__}: {exc}"
        if office_suffix is not None:
            suffix = office_suffix
            ctype = {
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            }[office_suffix]
        else:
            return _extract_zip_bundle(body)

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
