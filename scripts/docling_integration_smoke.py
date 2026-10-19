"""Real Docling table-structure smoke test using generated, synthetic regulatory data.

This does not read production state or contact a regulator. It exercises the
actual local Docling models and fails if a simple ruled table is not preserved.
"""
from __future__ import annotations

import io
import json

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
    print(json.dumps({
        "ok": True,
        "fixture": "synthetic-one-page-regulatory-table",
        "input_bytes": len(pdf_bytes),
        "markdown_characters": len(markdown),
        "markdown_tables": _markdown_table_count(markdown),
        "values_verified": 5,
    }, indent=2))


if __name__ == "__main__":
    main()
