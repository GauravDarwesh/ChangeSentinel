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


HTML_BLOCK_TAGS = {
    "address", "article", "blockquote", "dd", "details", "dialog", "div", "dl",
    "dt", "fieldset", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5",
    "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section", "summary",
    "ul",
}


def _html_inline_text(node) -> str:
    """Collect inline HTML text without inserting separators inside sentences."""
    from bs4 import NavigableString

    if isinstance(node, NavigableString):
        return str(node)
    name = getattr(node, "name", None)
    if not name:
        return ""
    if name == "br":
        return "\n"
    if name == "table":
        return "\n" + _html_table_markdown(node) + "\n"
    if name == "li":
        value = "".join(_html_inline_text(child) for child in node.children).strip()
        return "\n- " + value + "\n"
    value = "".join(_html_inline_text(child) for child in node.children)
    if name in HTML_BLOCK_TAGS:
        return "\n" + value.strip() + "\n"
    return value


def _html_cell_text(cell) -> str:
    value = "".join(
        _html_inline_text(child)
        for child in cell.children
        if getattr(child, "name", None) != "table"
    )
    value = re.sub(r"\s+", " ", value).strip()
    return value.replace("|", r"\|")


def _html_table_markdown(table) -> str:
    """Render a DOM table as row/column-preserving Markdown."""
    rows = []
    for row in table.find_all("tr"):
        # Do not accidentally absorb rows from nested tables.
        if row.find_parent("table") is not table:
            continue
        cells = [
            _html_cell_text(cell)
            for cell in row.find_all(["th", "td"], recursive=False)
        ]
        if any(cells):
            rows.append((cells, bool(row.find("th", recursive=False))))
    if not rows:
        return ""
    width = max(len(cells) for cells, _ in rows)
    rendered = []
    for index, (cells, has_header) in enumerate(rows):
        cells = cells + [""] * (width - len(cells))
        rendered.append("| " + " | ".join(cells) + " |")
        if index == 0:
            rendered.append("| " + " | ".join(["---"] * width) + " |")
    return "\n".join(rendered)


def normalize_html(
    html: str,
    include_selector: str | None = None,
    ignore_selectors: tuple[str, ...] | list[str] | None = None,
) -> str:
    """Extract stable, block-aware text while preserving inline sentences and tables.

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
            value = normalize_text(_html_inline_text(fragment))
            if value:
                fragments.append(value)
        return normalize_text("\n\n".join(fragments))

    _remove_ignored_nodes(soup, ignored)
    candidates = []
    for selector in CONTENT_SELECTORS:
        for node in soup.select(selector):
            length = len(node.get_text(" ", strip=True))
            if length:
                candidates.append((length, node))
    content = max(candidates, key=lambda item: item[0])[1] if candidates else (soup.body or soup)
    return normalize_text(_html_inline_text(content))

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
            name = info.filename.replace(chr(92), "/")
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
            name = info.filename.replace(chr(92), "/")
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
                ".pptx", ".txt", ".xlsm", ".xlsx", ".xml", ".xsd",
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


# Bump this when PDF/HTML normalized output changes. The engine re-fetches these
# records and records a baseline migration (not a regulatory change) if the
# original response bytes are identical.
CONTENT_EXTRACTOR_VERSION = "layout-pdf-html-v2"
LOW_TEXT_PAGE_CHARS = 40
MAX_OCR_PAGES = 100
OCR_PAGE_TIMEOUT_SECONDS = 15


def normalize_pdf_prose(text: str) -> str:
    """Join ordinary PDF line wraps while preserving paragraph and heading boundaries."""
    raw_lines = []
    for source_line in str(text or "").replace("\r", "\n").splitlines():
        line = unicodedata.normalize("NFKC", source_line).replace("\u00a0", " ")
        line = re.sub(r"[ \t]+", " ", line).strip()
        if line:
            raw_lines.append(line)
        elif raw_lines and raw_lines[-1] != "":
            raw_lines.append("")

    paragraphs = []
    current = ""

    def flush():
        nonlocal current
        if current.strip():
            paragraphs.append(current.strip())
        current = ""

    for line in raw_lines:
        if not line:
            flush()
            continue
        if not current:
            current = line
            continue

        # Wrapped words split by a PDF line-end hyphen are usually hyphenation,
        # not a true word boundary. Keep the normalized word as one token.
        if current.endswith("-") and line[:1].islower():
            current = current[:-1] + line
            continue

        # Preserve numbered items, bullets, all-caps section headings and
        # explicit paragraph endings. Other hard line breaks are usually layout
        # wraps, so join them with a space.
        starts_new_item = bool(re.match(r"^(?:[-•▪◦]|\(?\d{1,3}[.)])\s+", line))
        current_is_heading = bool(
            re.fullmatch(r"[A-Z][A-Z0-9 /&()’'–—:.-]{3,}", current)
            or re.match(r"^(?:GENERAL INSTRUCTIONS|LINE ITEM INSTRUCTIONS|QUESTIONS AND ANSWERS)\b", current, re.I)
        )
        if current.endswith((".", "!", "?", ";")) or starts_new_item or current_is_heading:
            flush()
            current = line
        else:
            current += " " + line
    flush()
    return "\n".join(paragraphs)


def _looks_like_fragmented_pdf_page(text: str) -> bool:
    """Fast heuristic to route likely forms/tables to geometry-aware extraction."""
    lines = [re.sub(r"\s+", " ", line).strip() for line in str(text or "").splitlines()]
    lines = [line for line in lines if line]
    if len(lines) < 18:
        return False
    short_lines = sum(len(line) <= 32 for line in lines)
    fragment_lines = sum(
        len(line.split()) <= 3 and len(line) <= 45
        for line in lines
    )
    coded_fields = len(re.findall(r"\b[A-Z]{2,5}\s+[A-Z0-9]{3,5}\b", text))
    return (
        (short_lines / len(lines) >= 0.62 and fragment_lines / len(lines) >= 0.38)
        or coded_fields >= 4
    )


def _pdf_text_quality(text: str) -> float:
    """Rank text candidates by useful content versus excessive fragmentation."""
    value = str(text or "").strip()
    if not value:
        return 0.0
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not lines:
        return 0.0
    fragments = sum(
        1 for line in lines
        if len(line) <= 18 and len(line.split()) <= 2
    )
    replacement_chars = value.count("\ufffd")
    return (
        min(len(value), 12000)
        + min(len(lines), 300) * 1.5
        - fragments * 7
        - replacement_chars * 20
    )


def _table_to_markdown(rows) -> str:
    """Render extracted PDF table cells as an explicit grid."""
    cleaned = []
    for row in rows or []:
        cells = [
            re.sub(r"\s+", " ", str(cell or "")).strip().replace("|", r"\|")
            for cell in (row or [])
        ]
        while cells and not cells[-1]:
            cells.pop()
        if any(cells):
            cleaned.append(cells)
    if not cleaned:
        return ""
    width = max(len(row) for row in cleaned)
    output = ["[TABLE]"]
    for row_index, row in enumerate(cleaned):
        row = row + [""] * (width - len(row))
        output.append("| " + " | ".join(row) + " |")
        if row_index == 0:
            output.append("| " + " | ".join(["---"] * width) + " |")
    return "\n".join(output)


def _table_score(rows) -> int:
    cleaned = [
        [str(cell or "").strip() for cell in (row or [])]
        for row in (rows or [])
    ]
    cleaned = [row for row in cleaned if any(row)]
    if len(cleaned) < 2:
        return 0
    width = max((len(row) for row in cleaned), default=0)
    filled = sum(bool(cell) for row in cleaned for cell in row)
    if width < 2 or filled < 4:
        return 0
    # Avoid interpreting body paragraphs as tables merely because text-based
    # table detection returned a two-column guess.
    nonempty_ratio = filled / max(1, sum(len(row) for row in cleaned))
    return filled if nonempty_ratio >= 0.20 else 0


def _find_pdf_tables(page):
    """Try ruled-table detection first, then alignment-based detection."""
    candidates = []
    settings_list = (
        {
            "vertical_strategy": "lines",
            "horizontal_strategy": "lines",
            "snap_tolerance": 4,
            "join_tolerance": 4,
            "intersection_tolerance": 5,
        },
        {
            "vertical_strategy": "text",
            "horizontal_strategy": "text",
            "min_words_vertical": 3,
            "min_words_horizontal": 1,
            "intersection_tolerance": 5,
            "text_x_tolerance": 3,
            "text_y_tolerance": 3,
        },
    )
    for settings in settings_list:
        try:
            tables = page.find_tables(table_settings=settings)
        except Exception:
            continue
        chosen = []
        total_score = 0
        for table in tables:
            try:
                rows = table.extract()
                score = _table_score(rows)
                bbox = tuple(float(value) for value in table.bbox)
            except Exception:
                continue
            if not score:
                continue
            if any(
                all(abs(left - right) < 4 for left, right in zip(bbox, existing[0]))
                for existing in chosen
            ):
                continue
            chosen.append((bbox, rows, score))
            total_score += score
        candidates.append((total_score, chosen))
    return max(candidates, key=lambda item: item[0])[1] if candidates else []


def _extract_pdfplumber_page(page, fast_text: str) -> str:
    """Recover page text and table cells while retaining their vertical order."""
    tables = _find_pdf_tables(page)
    if tables:
        tables.sort(key=lambda entry: (entry[0][1], entry[0][0]))
        blocks = []
        cursor = 0.0
        for bbox, rows, _score in tables:
            top = max(cursor, max(0.0, min(float(page.height), bbox[1])))
            bottom = max(top, max(0.0, min(float(page.height), bbox[3])))
            if top - cursor >= 2:
                try:
                    region_text = page.crop((0, cursor, page.width, top)).extract_text()
                except Exception:
                    region_text = ""
                region_text = normalize_pdf_prose(region_text or "")
                if region_text:
                    blocks.append(region_text)
            table_text = _table_to_markdown(rows)
            if table_text:
                blocks.append(table_text)
            cursor = max(cursor, bottom)
        if cursor < float(page.height) - 2:
            try:
                region_text = page.crop((0, cursor, page.width, page.height)).extract_text()
            except Exception:
                region_text = ""
            region_text = normalize_pdf_prose(region_text or "")
            if region_text:
                blocks.append(region_text)
        if blocks:
            return "\n\n".join(blocks)

    candidates = [normalize_pdf_prose(fast_text)]
    for kwargs in (
        {"layout": False, "x_tolerance": 2.5, "y_tolerance": 3},
        {"layout": True, "x_tolerance": 2.5, "y_tolerance": 3},
    ):
        try:
            candidate = page.extract_text(**kwargs)
        except Exception:
            continue
        if candidate:
            candidates.append(normalize_pdf_prose(candidate))
    return max(candidates, key=_pdf_text_quality)


def _page_has_image_xobject(page) -> bool:
    try:
        resources = page.get("/Resources")
        if resources is None:
            return False
        resources = resources.get_object()
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return False
        for reference in xobjects.get_object().values():
            obj = reference.get_object()
            if str(obj.get("/Subtype")) == "/Image":
                return True
    except Exception:
        return False
    return False


def _ocr_pdf_pages(body: bytes, page_indexes: list[int]) -> dict[int, str]:
    """OCR only pages that appear image-based; native-text pages stay on the fast path."""
    import pytesseract
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(body)
    results = {}
    try:
        for index in page_indexes:
            page = None
            bitmap = None
            try:
                page = document[index]
                bitmap = page.render(scale=1.8)
                image = bitmap.to_pil()
                try:
                    text = pytesseract.image_to_string(
                        image,
                        config="--psm 3",
                        timeout=OCR_PAGE_TIMEOUT_SECONDS,
                    )
                finally:
                    image.close()
                results[index] = normalize_pdf_prose(text or "")
            finally:
                if bitmap is not None:
                    try:
                        bitmap.close()
                    except Exception:
                        pass
                if page is not None:
                    try:
                        page.close()
                    except Exception:
                        pass
    finally:
        document.close()
    return results


def _extract_pdf(body: bytes) -> tuple[str | None, str | None]:
    """Fast-first PDF extraction with layout/table and selective OCR fallbacks."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(body), strict=False)
        if reader.is_encrypted:
            decrypted = reader.decrypt("")
            if not decrypted:
                return None, "PDF is encrypted and requires a password; refusing to replace the trusted baseline."
        pages = list(reader.pages)
        if not pages:
            return None, "PDF contains no readable pages."

        page_texts = []
        raw_page_texts = []
        low_text_indexes = []
        page_images = []
        for index, page in enumerate(pages):
            try:
                raw_text = page.extract_text() or ""
            except Exception:
                raw_text = ""
            raw_page_texts.append(raw_text)
            page_texts.append(normalize_pdf_prose(raw_text))
            has_image = _page_has_image_xobject(page)
            page_images.append(has_image)
            if len((raw_text or "").strip()) < LOW_TEXT_PAGE_CHARS and has_image:
                low_text_indexes.append(index)

        # Run geometry-aware parsing only on pages whose fast text is highly
        # fragmented (common for forms, multi-column PDFs and table-heavy pages).
        suspicious_indexes = [
            index for index, raw in enumerate(raw_page_texts)
            if _looks_like_fragmented_pdf_page(raw)
        ]
        if suspicious_indexes:
            try:
                import pdfplumber

                with pdfplumber.open(io.BytesIO(body)) as document:
                    for index in suspicious_indexes:
                        if index >= len(document.pages):
                            continue
                        try:
                            candidate = _extract_pdfplumber_page(document.pages[index], page_texts[index])
                            # Successful table reconstruction wins even if it is
                            # shorter than the linear text stream: the cell grid
                            # is the useful semantic structure, not text length.
                            if "[TABLE]" in candidate or _pdf_text_quality(candidate) > _pdf_text_quality(page_texts[index]) * 1.03:
                                page_texts[index] = candidate
                        except Exception:
                            # Keep the fast extraction if a malformed page defeats
                            # table reconstruction. OCR/quality logic still applies.
                            pass
            except Exception:
                pass

        if low_text_indexes:
            if len(low_text_indexes) > MAX_OCR_PAGES:
                return None, (
                    f"PDF has {len(low_text_indexes)} image-only/low-text pages; "
                    f"OCR safety limit is {MAX_OCR_PAGES}. Increase MAX_OCR_PAGES for this workload."
                )
            try:
                ocr_results = _ocr_pdf_pages(body, low_text_indexes)
            except Exception as exc:
                return None, (
                    "PDF contains image-based pages with no usable text layer, but the OCR fallback failed: "
                    f"{type(exc).__name__}: {exc}"
                )
            for index, ocr_text in ocr_results.items():
                if ocr_text.strip():
                    # Preserve the PDFium-rendered/OCR result only when it yields
                    # real text; otherwise retain an existing sparse text stream.
                    if _pdf_text_quality(ocr_text) > _pdf_text_quality(page_texts[index]):
                        page_texts[index] = ocr_text
                elif page_images[index] and not page_texts[index].strip():
                    return None, (
                        f"OCR returned no readable text for image-based page {index + 1}; "
                        "trusted baseline was left unchanged."
                    )

        text = normalize_text("\n\n".join(page_texts))
        if not text.strip():
            return None, (
                "PDF produced no usable text. It may contain outlines, damaged text, or scans that OCR could not read."
            )
        return text, None
    except Exception as exc:
        return None, f"PDF extraction failed: {type(exc).__name__}: {exc}"


def extract_content(
    url: str,
    content_type: str,
    body: bytes,
    include_selector: str | None = None,
    ignore_selectors: tuple[str, ...] | list[str] | None = None,
):
    ctype, suffix = (content_type or "").lower(), _extension(url)
    zip_signature = body.startswith(b"PK")
    if "zip" in ctype or suffix == ".zip" or zip_signature:
        try:
            archive, infos = _validated_zip_infos(body)
            try:
                names = {info.filename.replace(chr(92), "/") for info in infos}
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

    if "html" in ctype or suffix in {".html", ".htm"} or (
        not ctype and suffix == "" and not body.startswith(b"%PDF-")
    ):
        try:
            return normalize_html(
                body.decode("utf-8", "replace"),
                include_selector=include_selector,
                ignore_selectors=ignore_selectors,
            ), "html", None
        except Exception as exc:
            return None, "html", f"HTML normalization failed: {type(exc).__name__}: {exc}"

    if "pdf" in ctype or suffix == ".pdf" or body.startswith(b"%PDF-"):
        text, error = _extract_pdf(body)
        return text, "pdf", error
    if "wordprocessingml.document" in ctype or suffix == ".docx":
        try:
            from docx import Document
            return normalize_text("\n".join(p.text for p in Document(io.BytesIO(body)).paragraphs)), "docx", None
        except Exception as exc:
            return None, "docx", f"{type(exc).__name__}: {exc}"
    if "spreadsheetml.sheet" in ctype or suffix in {".xlsx", ".xlsm"}:
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
