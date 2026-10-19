"""Real Docling table-structure smoke test using generated, synthetic regulatory data.

This does not read production state or contact a regulator. It exercises the
actual local Docling models and fails if a simple ruled table is not preserved.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from regmon.content import _markdown_table_count
from regmon.docling_extractor import extract_pdf_with_docling


def build_synthetic_pdf() -> bytes:
    stream = io.BytesIO()
    document = SimpleDocTemplate(
        stream,
        pagesize=letter,
        leftMargin=48,
        rightMargin=48,
        topMargin=48,
        bottomMargin=48,
        title="Synthetic ChangeSentinel Docling table test",
    )
    styles = getSampleStyleSheet()
    elements = [
        Paragraph("Synthetic reporting instructions", styles["Title"]),
        Paragraph(
            "This generated document is solely a parser integration fixture. "
            "It contains no actual regulatory instructions.",
            styles["BodyText"],
        ),
        Spacer(1, 16),
    ]
    rows = [
        ["Form Code", "Reporting Frequency", "Threshold"],
        ["FR 2028D", "Quarterly", "15 percent"],
        ["FR Y-9C", "Quarterly", "50 percent"],
    ]
    table = Table(rows, colWidths=[130, 190, 140], repeatRows=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.8, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    elements.extend([table, Spacer(1, 14), Paragraph(
        "The values above are synthetic test values.", styles["BodyText"]
    )])
    document.build(elements)
    return stream.getvalue()


def main() -> None:
    pdf_bytes = build_synthetic_pdf()
    markdown, error = extract_pdf_with_docling(pdf_bytes, expected_pages=1)
    if error:
        raise SystemExit(f"Docling integration smoke test failed: {error}")
    if not markdown:
        raise SystemExit("Docling integration smoke test failed: empty Markdown")
    if _markdown_table_count(markdown) < 1:
        raise SystemExit(
            "Docling integration smoke test failed: no structured Markdown table found"
        )
    for expected in ("FR 2028D", "Quarterly", "15 percent", "FR Y-9C", "50 percent"):
        if expected.casefold() not in markdown.casefold():
            raise SystemExit(
                f"Docling integration smoke test failed: missing expected table value {expected!r}"
            )
    results = [{
        "fixture": "synthetic-one-page-regulatory-table",
        "input_bytes": len(pdf_bytes),
        "markdown_characters": len(markdown),
        "markdown_tables": _markdown_table_count(markdown),
        "values_verified": 5,
    }]

    # Test a real, already-saved Federal Reserve PDF from the repository's
    # evidence corpus. This is local extraction only: no HTTP request is made,
    # no monitoring state is read or written, and no notifications are sent.
    corpus_pdf = Path(
        "data/snapshots/files/"
        "b6f72f741a1c310ad512e3f1482069fbd7f08af4b0e35d12535f15804e72c7e0-"
        "4ccc5bb26f325b80df4fc87d6e84f047b9a2124a3ca59f5cd595473420134b4a.pdf"
    )
    if not corpus_pdf.is_file():
        raise SystemExit(f"Saved PDF corpus fixture is missing: {corpus_pdf}")
    from pypdf import PdfReader
    saved_pdf = corpus_pdf.read_bytes()
    expected_pages = len(PdfReader(io.BytesIO(saved_pdf), strict=False).pages)
    corpus_markdown, corpus_error = extract_pdf_with_docling(
        saved_pdf, expected_pages=expected_pages
    )
    if corpus_error:
        raise SystemExit(f"Docling saved-PDF smoke test failed: {corpus_error}")
    if not corpus_markdown or _markdown_table_count(corpus_markdown) < 1:
        raise SystemExit(
            "Docling saved-PDF smoke test failed: FR 2028B output has no structured Markdown table"
        )
    for expected in ("FR 2028B", "Rate of Interest", "Next Date"):
        if expected.casefold() not in corpus_markdown.casefold():
            raise SystemExit(
                f"Docling saved-PDF smoke test failed: missing expected source text {expected!r}"
            )
    results.append({
        "fixture": "saved-federal-reserve-fr-2028b-pdf",
        "input_bytes": len(saved_pdf),
        "pages": expected_pages,
        "markdown_characters": len(corpus_markdown),
        "markdown_tables": _markdown_table_count(corpus_markdown),
        "values_verified": 3,
    })

    print(json.dumps({"ok": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
