"""One lock for every PDFium call in the process.

PDFium is not thread-safe: two threads may not call into it at the same time,
even on different documents. The scan reads resources on several fetch
workers, so two PDFs read at once (rule tables, OCR rendering) corrupted
PDFium's heap and killed the whole run with SIGTRAP (exit 133).

Docling guards its own PDFium backend with ``docling.utils.locks.pypdfium2_lock``;
that same lock is used here when Docling is installed, so the two never
overlap either. Hold it only around PDFium calls, never while calling Docling
or doing slow work that does not touch PDFium (Tesseract, table parsing).
"""
from __future__ import annotations

import threading

try:  # Docling's lock, so our calls and Docling's PDFium backend never overlap
    from docling.utils.locks import pypdfium2_lock as LOCK
except Exception:  # Docling not installed (or moved its lock): our own
    LOCK = threading.Lock()
