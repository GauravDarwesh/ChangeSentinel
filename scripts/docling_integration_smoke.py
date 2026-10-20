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


def markdown_tables(text: str) -> list[list[list[str]]]:
    """Parse pipe tables from Markdown with tolerant blank-line handling."""
    lines = str(text or "").splitlines()

    def split_row(line: str) -> list[str]:
        value = line.strip()
        if not (value.startswith("|") and value.endswith("|")):
            return []
        cells: list[str] = []
        cell: list[str] = []
        escaped = False
        for char in value[1:-1]:
            if char == "|" and not escaped:
                cells.append("".join(cell).replace(r"\|", "|").strip())
                cell = []
                continue
            cell.append(char)
            if char == "\\" and not escaped:
                escaped = True
            else:
                escaped = False
        cells.append("".join(cell).replace(r"\|", "|").strip())
        return cells

    def is_separator(cells: list[str]) -> bool:
        return len(cells) >= 2 and all(
            re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells
        )

    tables: list[list[list[str]]] = []
    index = 0
    while index < len(lines):
        separator = split_row(lines[index])
        if not is_separator(separator):
            index += 1
            continue

        # Docling may emit a blank line or a [TABLE] marker around a table.
        # Find the closest preceding pipe row as its header.
        header_index = index - 1
        while header_index >= 0 and not split_row(lines[header_index]):
            header_index -= 1
        if header_index < 0:
            index += 1
            continue

        header = split_row(lines[header_index])
        table = [header]
        data_index = index + 1
        while data_index < len(lines):
            row = split_row(lines[data_index])
            if not row:
                break
            if not is_separator(row):
                table.append(row)
            data_index += 1
        if len(table) > 1:
            tables.append(table)
        index = max(data_index, index + 1)
    return tables


def normalize_label_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


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
    tables = markdown_tables(corpus_markdown)
    if len(tables) < 1:
        table_lines = [
            line.strip() for line in corpus_markdown.splitlines()
            if line.strip().startswith("|") and line.strip().endswith("|")
        ]
        raise SystemExit(
            "Hybrid FR 2028B extraction failed: no structured Markdown table was recognized "
            f"(detected_separator_rows={_markdown_table_count(corpus_markdown)}, "
            f"candidate_table_lines={len(table_lines)}, sample={table_lines[:8]!r})"
        )

    # Key reporting fields must survive inside table cells, not merely appear
    # somewhere in body text. This guards against a superficially successful
    # extraction that flattens the form's actual row/column relationships.
    table_cell_text = normalize_label_text(
        " ".join(cell for table in tables for row in table for cell in row)
    )
    # The ruled-grid extractor rebuilds the FR 2028B form from its drawn lines,
    # including the sideways option labels that layout models drop. Every reported
    # item, its item code and its rotated options must sit inside table cells.
    expected_table_labels = (
        "Date Made",
        "Face Amount of Loan in Dollars",
        "Rate of Interest",
        "Next Date",
        "Maturity Date (",
        "Risk Rating",
        "QTFL 6136",
        "Prepayment Penalty",
        "Feeder Livestock",
        "Not Insured by U.S. Agencies or Departments",
    )
    missing_table_labels = [
        label for label in expected_table_labels
        if normalize_label_text(label) not in table_cell_text
    ]
    if missing_table_labels:
        table_preview = [
            line.strip()[:260]
            for line in corpus_markdown.splitlines()
            if line.strip().startswith("|") and line.strip().endswith("|")
        ][:50]
        field_context = {}
        for label in missing_table_labels:
            found_at = corpus_markdown.casefold().find(label.casefold())
            if found_at >= 0:
                field_context[label] = corpus_markdown[
                    max(0, found_at - 160):found_at + 260
                ].replace("\n", " ")
        raise SystemExit(
            "Hybrid FR 2028B extraction failed: critical field labels are not present "
            "inside structured table cells: " + ", ".join(missing_table_labels) +
            f"; selected_profile={extraction_profile.get('profile', 'unknown')}; "
            f"table_preview={table_preview!r}; field_context={field_context!r}"
        )

    nonempty_cells = [
        cell for table in tables for row in table for cell in row if cell.strip()
    ]
    widest_table = max((max((len(row) for row in table), default=0) for table in tables), default=0)
    if len(nonempty_cells) < 30 or widest_table < 5:
        raise SystemExit(
            "Hybrid FR 2028B extraction failed: the detected table grid is unexpectedly "
            f"sparse (non-empty cells={len(nonempty_cells)}, widest table={widest_table} columns)"
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
        "markdown_tables": len(tables),
        "structured_nonempty_cells": len(nonempty_cells),
        "widest_table_columns": widest_table,
        "critical_table_labels_verified": list(expected_table_labels),
        "trusted_token_coverage": round(token_coverage, 4),
        "missing_trusted_token_sample": missing_tokens[:10],
        "values_verified": 3,
    })

    # A second saved regulator form covers a different layout: FR 2028D is a
    # seven-page survey with both binary selection grids and a multi-row rating
    # grid. This guards against overfitting the table fallback to FR 2028B/S.
    second_pdf = Path(
        "data/snapshots/files/"
        "5ccb64a08420a94259ab9286787d345cf0ec757a33ff3919d6d8efe4bcbd41db-"
        "db4bcb7b0f68a4208041e61f6fb6800f8e82ded8b26e1f7cfc461ebd06bb9cf4.pdf"
    )
    if not second_pdf.is_file():
        raise SystemExit(f"Saved FR 2028D PDF fixture is missing: {second_pdf}")
    second_bytes = second_pdf.read_bytes()
    second_profile = {}
    second_markdown, second_kind, second_error = extract_content(
        "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=f59446fb-8250-4fbe-9db3-411d107bda3a",
        "application/pdf",
        second_bytes,
        _extraction_profile=second_profile,
    )
    if second_error:
        raise SystemExit(f"Hybrid FR 2028D extraction failed: {second_error}")
    if second_kind != "pdf" or not second_markdown:
        raise SystemExit("Hybrid FR 2028D extraction failed: no normalized PDF text returned")

    second_tables = markdown_tables(second_markdown)
    if not second_tables:
        raise SystemExit(
            "Hybrid FR 2028D extraction failed: no structured Markdown table was preserved"
        )
    second_cell_text = normalize_label_text(
        " ".join(cell for table in second_tables for row in table for cell in row)
    )
    second_expected_labels = ("QSBL", "Not Important", "Very Important", "HR19")
    second_missing_labels = [
        label for label in second_expected_labels
        if normalize_label_text(label) not in second_cell_text
    ]
    if second_missing_labels:
        raise SystemExit(
            "Hybrid FR 2028D extraction failed: expected rating-grid labels are not "
            "inside structured table cells: " + ", ".join(second_missing_labels)
        )

    second_nonempty_cells = [
        cell for table in second_tables for row in table for cell in row if cell.strip()
    ]
    second_widest_table = max(
        (max((len(row) for row in table), default=0) for table in second_tables),
        default=0,
    )
    if len(second_nonempty_cells) < 12 or second_widest_table < 4:
        raise SystemExit(
            "Hybrid FR 2028D extraction failed: rating-grid structure is unexpectedly "
            f"sparse (non-empty cells={len(second_nonempty_cells)}, "
            f"widest table={second_widest_table} columns)"
        )
    for expected in ("FR 2028D", "Regulatory policy", "Interest rates"):
        if expected.casefold() not in second_markdown.casefold():
            raise SystemExit(
                f"Hybrid FR 2028D extraction failed: missing expected source text {expected!r}"
            )

    second_prior_path = Path(
        "data/snapshots/"
        "5ccb64a08420a94259ab9286787d345cf0ec757a33ff3919d6d8efe4bcbd41db-"
        "c18a579e49c192f6fa2fcb43d3dd6d796ada1c10dbaf119937aff0d455774f47.txt"
    )
    if not second_prior_path.is_file():
        raise SystemExit(f"Trusted FR 2028D comparison text is missing: {second_prior_path}")
    second_prior_text = second_prior_path.read_text(encoding="utf-8")
    second_prior_tokens = {
        token.casefold()
        for token in token_pattern.findall(second_prior_text)
        if len(token) >= 3
    }
    second_candidate_tokens = {
        token.casefold()
        for token in token_pattern.findall(second_markdown)
        if len(token) >= 3
    }
    second_missing_tokens = sorted(second_prior_tokens - second_candidate_tokens)
    second_token_coverage = (
        (len(second_prior_tokens) - len(second_missing_tokens)) / len(second_prior_tokens)
        if second_prior_tokens else 1.0
    )
    if second_token_coverage < 0.90:
        raise SystemExit(
            "Hybrid FR 2028D extraction lost too much previously trusted text: "
            f"token coverage={second_token_coverage:.1%}; "
            f"missing sample={second_missing_tokens[:30]}"
        )
    results.append({
        "fixture": "saved-federal-reserve-fr-2028d-pdf-through-hybrid-pipeline",
        "input_bytes": len(second_bytes),
        "selected_extractor_profile": second_profile.get("profile", "unknown"),
        "markdown_characters": len(second_markdown),
        "markdown_tables": len(second_tables),
        "structured_nonempty_cells": len(second_nonempty_cells),
        "widest_table_columns": second_widest_table,
        "critical_table_labels_verified": list(second_expected_labels),
        "trusted_token_coverage": round(second_token_coverage, 4),
        "missing_trusted_token_sample": second_missing_tokens[:10],
    })

    print(json.dumps({"ok": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
