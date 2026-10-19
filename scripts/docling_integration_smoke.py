"""Real Docling table-structure smoke test using generated, synthetic regulatory data.

This does not read production state or contact a regulator. It exercises the
actual local Docling models and fails if a simple ruled table is not preserved.
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from regmon.content import _markdown_table_count, extract_content
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
    saved_pdf = corpus_pdf.read_bytes()
    extraction_profile = {}
    corpus_markdown, corpus_kind, corpus_error = extract_content(
        "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=58f18be6-92e4-497c-ad0d-db006caa2e03",
        "application/pdf",
        saved_pdf,
        _extraction_profile=extraction_profile,
    )
    if corpus_error:
        raise SystemExit(f"Hybrid FR 2028B extraction failed: {corpus_error}")
    if corpus_kind != "pdf" or not corpus_markdown:
        raise SystemExit("Hybrid FR 2028B extraction failed: no normalized PDF text returned")
    if _markdown_table_count(corpus_markdown) < 1:
        raise SystemExit(
            "Hybrid FR 2028B extraction failed: no structured Markdown table was preserved"
        )
    for expected in ("FR 2028B", "Rate of Interest", "Next Date"):
        if expected.casefold() not in corpus_markdown.casefold():
            raise SystemExit(
                f"Hybrid FR 2028B extraction failed: missing expected source text {expected!r}"
            )

    # Compare the hybrid output against the previously trusted extraction of the
    # same original PDF bytes. This catches severe content loss from any table
    # reconstruction model even when the resulting Markdown looks structured.
    prior_text_path = Path(
        "data/snapshots/"
        "b6f72f741a1c310ad512e3f1482069fbd7f08af4b0e35d12535f15804e72c7e0-"
        "ded2cc403a02db9d5b29e4baa14ce4f8a4bee3da548b793d440bab8aa4ed6f41.txt"
    )
    if not prior_text_path.is_file():
        raise SystemExit(f"Trusted FR 2028B comparison text is missing: {prior_text_path}")
    prior_text = prior_text_path.read_text(encoding="utf-8")
    token_pattern = re.compile(r"[a-z0-9]+(?:[/%._-][a-z0-9]+)*", re.IGNORECASE)
    prior_tokens = {token.casefold() for token in token_pattern.findall(prior_text) if len(token) >= 3}
    candidate_tokens = {token.casefold() for token in token_pattern.findall(corpus_markdown) if len(token) >= 3}
    missing_tokens = sorted(prior_tokens - candidate_tokens)
    token_coverage = (
        (len(prior_tokens) - len(missing_tokens)) / len(prior_tokens)
        if prior_tokens else 1.0
    )
    if token_coverage < 0.90:
        raise SystemExit(
            "Hybrid FR 2028B extraction lost too much previously trusted text: "
            f"token coverage={token_coverage:.1%}; missing sample={missing_tokens[:30]}"
        )
    results.append({
        "fixture": "saved-federal-reserve-fr-2028b-pdf-through-hybrid-pipeline",
        "input_bytes": len(saved_pdf),
        "selected_extractor_profile": extraction_profile.get("profile", "unknown"),
        "markdown_characters": len(corpus_markdown),
        "markdown_tables": _markdown_table_count(corpus_markdown),
        "trusted_token_coverage": round(token_coverage, 4),
        "missing_trusted_token_sample": missing_tokens[:10],
        "values_verified": 3,
    })

    print(json.dumps({"ok": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
