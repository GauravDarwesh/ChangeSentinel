"""Quality-gated Docling conversion for difficult, table-heavy PDFs.

Docling is loaded lazily so ordinary text PDFs keep the fast extraction path and
unit tests that do not exercise layout conversion never download model weights.
"""
from __future__ import annotations

import io
import threading
from typing import Any

_CONVERTER: Any | None = None
_CONVERTER_LOCK = threading.Lock()
MAX_DOCLING_PAGES = 100
DOCUMENT_TIMEOUT_SECONDS = 120
MODEL_THREADS = 2


def _build_converter():
    """Build a CPU-conscious converter with accurate table reconstruction."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions(
        do_ocr=False,             # The existing selective Tesseract path owns OCR.
        do_table_structure=True,
        document_timeout=DOCUMENT_TIMEOUT_SECONDS,
        queue_max_size=1,
    )
    options.table_structure_options.mode = TableFormerMode.ACCURATE
    try:
        options.accelerator_options.num_threads = MODEL_THREADS
    except (AttributeError, TypeError, ValueError):
        # Keep compatibility with Docling releases that move accelerator settings.
        pass
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options)
        }
    )


def extract_pdf_with_docling(
    body: bytes, *, expected_pages: int
) -> tuple[str | None, str | None]:
    """Return full-document Markdown only when Docling completed every page.

    Conversion errors, partial successes, page-count mismatches, and empty
    output are rejected so the caller can retain the established extraction
    result. No remote AI services are enabled; model artifacts may be downloaded
    by Docling on first use and can be cached by the CI runner.
    """
    global _CONVERTER
    if not body or not body.startswith(b"%PDF-"):
        return None, "Docling input is not a PDF response."
    if expected_pages < 1:
        return None, "Docling requires a positive expected page count."
    if expected_pages > MAX_DOCLING_PAGES:
        return None, (
            f"Docling safety limit is {MAX_DOCLING_PAGES} pages; "
            "the existing fast/layout extraction path will be retained."
        )

    try:
        from docling.datamodel.base_models import DocumentStream

        # Serialize model initialization and inference. The monitoring engine
        # processes resources concurrently; concurrent Docling model instances
        # would increase memory use and risk exhausting the hosted runner.
        with _CONVERTER_LOCK:
            if _CONVERTER is None:
                _CONVERTER = _build_converter()
            source = DocumentStream(
                name="changesentinel-input.pdf",
                stream=io.BytesIO(body),
            )
            result = _CONVERTER.convert(
                source,
                max_num_pages=expected_pages,
                max_file_size=len(body) + 1,
            )

        status = getattr(result, "status", None)
        status_name = str(
            getattr(status, "name", str(status).rsplit(".", 1)[-1])
        ).upper()
        if status_name != "SUCCESS":
            return None, f"Docling conversion did not complete successfully (status={status_name or 'UNKNOWN'})."

        document = getattr(result, "document", None)
        pages = getattr(document, "pages", None)
        if document is None or pages is None or len(pages) != expected_pages:
            actual_pages = len(pages) if pages is not None else 0
            return None, (
                f"Docling page-count mismatch: expected {expected_pages}, "
                f"received {actual_pages}; partial output rejected."
            )

        markdown = document.export_to_markdown()
        if not isinstance(markdown, str) or not markdown.strip():
            return None, "Docling produced no usable Markdown."
        return markdown, None
    except Exception as exc:
        return None, f"Docling layout extraction failed: {type(exc).__name__}: {exc}"
