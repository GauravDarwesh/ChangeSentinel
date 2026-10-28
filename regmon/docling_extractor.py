"""Quality-gated Docling conversion for difficult, table-heavy PDFs.

Docling is loaded lazily so ordinary text PDFs keep the fast extraction path and
unit tests that do not exercise layout conversion never download model weights.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_CONVERTER: Any | None = None
_CONVERTER_LOCK = threading.Lock()
MAX_DOCLING_PAGES = 100
DOCUMENT_TIMEOUT_SECONDS = 120
MODEL_THREADS = 2
os.environ.setdefault("OMP_NUM_THREADS", str(MODEL_THREADS))

# Exact SHA-256 fingerprints of PDF byte streams that repeatedly consumed the
# full Docling budget in RegMonitor CI (run 39417703259, then the isolated retry).
# In every case Docling returned PARTIAL_SUCCESS and its candidate was rejected;
# ChangeSentinel kept its existing pypdf/pdfplumber extraction instead. Skip only
# identical bytes: a newly published revision has a different hash and is
# evaluated normally. These guards avoid repeating known failed optional work
# during every golden-corpus check without changing text or weakening quality gates.
KNOWN_TIMEOUT_PDF_SHA256 = frozenset({
    "f80f4d4734a67976906f8249f9e9ed713b8336085564914fa61f04aaff4e253a",
    "f21712326d091ffae6f5e9eb9e9c8d5d811081532da0d0c19379a2f7e4670d0d",
    "2ae0ac7cb6ff39be4a1dfd2d9cc8d5df71f7bd5348d9693ad18fe8a047c0b30c",
})

# Learned registry: any PDF whose conversion exhausts the time budget is recorded by
# SHA-256 and skipped on later runs while its bytes are unchanged. Production runs
# persist it to data/docling-timeouts.json (committed with the rest of the monitoring
# state), so a newly republished heavy PDF costs one timeout, not one per scan.
# The hard-coded seeds above keep CI's golden corpus fast without that file.
TIMEOUT_FRACTION = 0.9
MAX_LEARNED_ENTRIES = 500
# A learned skip expires: runner hardware and Docling releases change, and a PDF
# that timed out once would otherwise stay on the lower-fidelity fallback forever
# (its same-bytes profile change is a quiet baseline migration, so nobody notices).
LEARNED_TIMEOUT_DAYS = 30
REGISTRY_SCHEMA_VERSION = 1
_REGISTRY_LOCK = threading.Lock()
_LEARNED: dict[str, dict] = {}
_REGISTRY_PATH: Path | None = None
_LOG = logging.getLogger(__name__)


def configure_timeout_registry(path: Path | None, *, persist: bool = True) -> None:
    """Load learned timeouts from ``path``; write new ones back only when ``persist``.

    A malformed file is reported and left untouched (never overwritten), and the run
    proceeds without learned skips: this is a performance cache, not monitoring state.
    """
    global _REGISTRY_PATH
    learned: dict[str, dict] = {}
    writable = persist
    if path is not None and path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("schema_version", REGISTRY_SCHEMA_VERSION) != REGISTRY_SCHEMA_VERSION:
                raise ValueError(f"unsupported schema_version {data.get('schema_version')!r}")
            entries = data.get("time_budget_exhausted") if isinstance(data, dict) else None
            if not isinstance(entries, dict) or not all(
                isinstance(k, str) and len(k) == 64 and isinstance(v, dict) for k, v in entries.items()
            ):
                raise ValueError("expected {'time_budget_exhausted': {sha256: {...}}}")
            learned = dict(entries)
        except (OSError, ValueError) as exc:
            _LOG.warning("Ignoring unreadable Docling timeout registry %s (%s); it will not be overwritten.", path, exc)
            writable = False
    with _REGISTRY_LOCK:
        _LEARNED.clear()
        _LEARNED.update(learned)
        _REGISTRY_PATH = path if writable else None


def _known_timeout(digest: str, now: datetime | None = None) -> bool:
    with _REGISTRY_LOCK:
        if digest in KNOWN_TIMEOUT_PDF_SHA256:
            return True
        entry = _LEARNED.get(digest)
    if entry is None:
        return False
    try:
        recorded = datetime.fromisoformat(str(entry.get("recorded_at")))
        if recorded.tzinfo is None:
            recorded = recorded.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return True
    age_days = ((now or datetime.now(timezone.utc)) - recorded).total_seconds() / 86400
    return age_days < LEARNED_TIMEOUT_DAYS


def _known_timeout_unlocked(digest: str) -> bool:
    """An entry younger than the expiry (call with the lock held)."""
    entry = _LEARNED.get(digest) or {}
    try:
        recorded = datetime.fromisoformat(str(entry.get("recorded_at")))
        if recorded.tzinfo is None:
            recorded = recorded.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return True
    return (datetime.now(timezone.utc) - recorded).total_seconds() / 86400 < LEARNED_TIMEOUT_DAYS


def _remember_timeout(digest: str, elapsed: float, pages: int) -> None:
    with _REGISTRY_LOCK:
        if digest in _LEARNED and _known_timeout_unlocked(digest):
            return
        _LEARNED[digest] = {
            "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "elapsed_seconds": round(elapsed, 1),
            "pages": pages,
        }
        if len(_LEARNED) > MAX_LEARNED_ENTRIES:
            for old in sorted(_LEARNED, key=lambda k: _LEARNED[k].get("recorded_at", ""))[: len(_LEARNED) - MAX_LEARNED_ENTRIES]:
                del _LEARNED[old]
        path = _REGISTRY_PATH
        snapshot = {"schema_version": REGISTRY_SCHEMA_VERSION, "time_budget_exhausted": dict(sorted(_LEARNED.items()))}
    _LOG.warning("Docling used its %ss budget on SHA-256 %s; later runs will skip Docling for these exact bytes.", DOCUMENT_TIMEOUT_SECONDS, digest)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        _LOG.warning("Could not persist Docling timeout registry %s: %s", path, exc)


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
    result. Exact input hashes with a proven, repeatable timeout are skipped
    before model initialization; revised source bytes are still evaluated.
    No remote AI services are enabled.
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

    digest = hashlib.sha256(body).hexdigest()
    if _known_timeout(digest):
        return None, (
            "Docling intentionally skipped for a previously time-budget-exhausted "
            f"PDF (SHA-256 {digest}); retaining the established extraction result."
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
            started = time.monotonic()
            result = _CONVERTER.convert(
                source,
                max_num_pages=expected_pages,
                max_file_size=len(body) + 1,
            )

        status = getattr(result, "status", None)
        status_name = str(
            getattr(status, "name", str(status).rsplit(".", 1)[-1])
        ).upper()
        elapsed = time.monotonic() - started
        if status_name != "SUCCESS":
            if elapsed >= DOCUMENT_TIMEOUT_SECONDS * TIMEOUT_FRACTION:
                _remember_timeout(digest, elapsed, expected_pages)
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
