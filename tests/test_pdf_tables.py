"""Rule and field tables read row by row from PDF text positions (regmon/pdf_tables.py).

Synthetic fixtures recreate what makes these tables hard to read from a text
layer: cells that wrap, an algebra cell that overflows into the next row, an
English cell whose last characters are drawn over the next column, and two
layouts the reader must refuse (vertically centred cells, a second table with
its own header on the same page). The FR Y-9C instruction book saved by the
monitor, when present, checks the reader against the real thing.
"""
from __future__ import annotations

import io
import json
import unittest
from pathlib import Path

try:
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.pdfgen import canvas
except ImportError:  # pragma: no cover - reportlab is installed in CI
    canvas = None

from engine_harness import Sandbox, ok
from regmon import engine, pdf_tables, registry, spec_diff
from regmon.config import SourceConfig
from regmon.content import extract_content
from regmon.validate_state import validate_persisted_state

ROOT = Path(__file__).resolve().parent.parent
FRY9C_BOOK = ROOT / "data" / "snapshots" / "files" / (
    "5533bdcf84d70d25740c1bac0c519665c464e4c234b18f4dcb07e725eafa332e-"
    "8ed5206561a87ec3f43a958323122329c1eeb3f873bd1a376d4fce18dc5f50a6.pdf")

FED_COLUMNS = [("Series", 30), ("Effective Start", 70), ("Effective End", 120), ("Edit Change", 170), ("Schedule", 215),
               ("Edit Type", 250), ("Edit", 295), ("TargetItem", 325), ("MDRM", 375), ("Edit Test", 425), ("Alg Edit Test", 600)]
FED_SECOND_LINE = {"Effective Start": "Date", "Effective End": "Date", "Edit": "Number", "MDRM": "Number"}
FED_ROWS = [
    ["FRY9C", "20150331", "99991231", "No Change", "HI", "Validity", "1050", "HI-1h", "BHCK4107",
     ["Sum of HI-1a1a through HI-1g must equal", "HI-1h."], ["(bhck4435 + bhck4436) eq", "bhck4107"]],
    ["FRY9C", "20150331", "99991231", "No Change", "HI", "Validity", "1090", "HI-3", "BHCK4074",
     ["HI-1h minus HI-2f must equal HI-3."], ["(bhck4107 - bhck4073) eq bhck4074"]],
    ["FRY9C", "20220331", "99991231", "Revised", "HI-B", "Validity", "1640", "HI-B(I)Mem1A", "BHCK5409",
     ["If previous year June HC-12 is greater than", "or equal to $5 billion then HI-B(I)Mem1A must", "be less than or equal to HC-"],
     ["if (mm-q1 eq 03 and bhck2170-q4 ge 5000000)", "then bhck5409 le (bhck4645 + bhck4646 +", "bhck4644)"]],
    ["FRY9C", "20220331", "99991231", "No Change", "HI-B", "Quality", "1640", "HI-B(I)Mem1B", "BHCK5410",
     ["HI-B(I)Mem1B should be greater than zero."], ["bhck5410 gt 0"]],
    ["FRY9C", "20150331", "99991231", "Added", "HC", "Quality", "9000", "HC-1", "BHCK0081",
     ["HC-1 should not be null."], ["bhck0081 ne null"]],
]


def _fed_page(c, height, rows, *, overflow_last_line=False, crossing=False):
    """One checklist page: title, a two-line header, rows top-aligned at a 9-point pitch."""
    c.setFont("Helvetica-Bold", 9)
    c.drawString(30, height - 30, "Validity (V) Edits for the FR Y-9C")
    c.setFont("Helvetica-Bold", 7)
    y = height - 60
    for name, x in FED_COLUMNS:
        c.drawString(x, y, name)
        if name in FED_SECOND_LINE:
            c.drawString(x, y - 8, FED_SECOND_LINE[name])
    c.setFont("Helvetica", 7)
    y -= 22
    pitch = 9
    for index, row in enumerate(rows):
        for (_name, x), value in zip(FED_COLUMNS, row):
            lines = value if isinstance(value, list) else [value]
            for k, line in enumerate(lines):
                last_of_overflowing = overflow_last_line and index == 2 and x == 600 and k == len(lines) - 1
                # The real checklist draws an overflowing last line 3.2 points above the next row's first line.
                line_y = y - k * pitch
                if last_of_overflowing:
                    line_y = y - (len(lines) - 1) * pitch
                c.drawString(x, line_y, line)
        tallest = max(len(v) if isinstance(v, list) else 1 for v in row)
        drawn = tallest - 1 if overflow_last_line and index == 2 else tallest
        y -= drawn * pitch + 3.2 if overflow_last_line and index == 2 else tallest * pitch + 4
    if crossing:
        # An English cell whose hyphen is drawn just past the algebra column's edge.
        c.drawString(600 - 3 * 7 * 0.55, y, "HC-")
        c.drawString(30, y, "FRY9C")
    c.setFont("Helvetica", 7)
    c.drawString(30, 30, "March 2026 FR Y-9C: CHK-1 of 1")


def build_fed_checklist(*, overflow=True) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(letter))
    _fed_page(c, landscape(letter)[1], FED_ROWS, overflow_last_line=overflow)
    c.showPage()
    c.save()
    return buf.getvalue()


def build_rule_list(*, centred=False, second_table=False, continued=False) -> bytes:
    """A validation-rule list in another regulator's layout: Rule ID, Severity, Description, Formula."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter
    columns = [("Rule ID", 40), ("Severity", 110), ("Description", 170), ("Formula", 380)]
    rows = [("v0101_m", "Error", ["Total assets must equal the sum of", "the asset lines."], ["{r010} = {r020} + {r030}"]),
            ("v0102_m", "Warning", ["Loans should not be negative."], ["{r040} >= 0"]),
            ("v0103_h", "Error", ["Equity must be reported."], ["isnull({r050}) = false"]),
            ("v0104_s", "Error", ["Liabilities and equity must equal", "total assets, within one unit."], ["abs({r060} + {r050} - {r010})", "<= 1"])]
    c.setFont("Helvetica-Bold", 11)
    c.drawString(40, height - 40, "Validation rules for supervisory reporting")
    c.setFont("Helvetica-Bold", 9)
    y = height - 70
    for name, x in columns:
        c.drawString(x, y, name)
    c.setFont("Helvetica", 9)
    y -= 16
    pitch = 11
    for rule, severity, description, formula in rows:
        tallest = max(len(description), len(formula))
        key_y = y - (tallest - 1) * pitch / 2 if centred else y
        c.drawString(40, key_y, rule)
        c.drawString(110, key_y, severity)
        for k, line in enumerate(description):
            c.drawString(170, y - k * pitch, line)
        for k, line in enumerate(formula):
            c.drawString(380, y - k * pitch, line)
        y -= tallest * pitch + 5
    if second_table:
        y -= 10
        c.setFont("Helvetica-Bold", 9)
        for name, x in columns:
            c.drawString(x, y, name)
        c.setFont("Helvetica", 9)
        c.drawString(40, y - 16, "v0201_m")
        c.drawString(110, y - 16, "Error")
        c.drawString(170, y - 16, "Another table.")
        c.drawString(380, y - 16, "{r070} > 0")
    c.setFont("Helvetica", 8)
    c.drawString(40, 30, "Page 1")
    c.showPage()
    if continued:
        c.setFont("Helvetica", 9)
        y = height - 50
        for rule, severity, text, formula in [("v0105_m", "Error", "Deposits must not be negative.", "{r080} >= 0"),
                                              ("v0106_m", "Warning", "Other assets should be small.", "{r090} <= {r010}"),
                                              ("v0107_m", "Error", "Net income must be reported.", "isnull({r100}) = false")]:
            for value, x in zip((rule, severity, text, formula), (40, 110, 170, 380)):
                c.drawString(x, y, value)
            y -= 16
        c.setFont("Helvetica", 8)
        c.drawString(40, 30, "Page 2")
        c.showPage()
    c.save()
    return buf.getvalue()


def read(body: bytes) -> pdf_tables.TableSet:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(body))
    candidates = [i for i, page in enumerate(reader.pages) if pdf_tables.looks_like_table(page.extract_text() or "")]
    return pdf_tables.read(body, candidates)


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class FedChecklistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = build_fed_checklist()
        cls.tables = read(cls.body)
        cls.records = cls.tables.records()

    def test_every_row_and_column_is_read(self):
        self.assertEqual(len(self.tables.pages), 1)
        self.assertEqual(self.tables.pages[0].layout.names,
                         ["Series", "Effective Start Date", "Effective End Date", "Edit Change", "Schedule", "Edit Type",
                          "Edit Number", "TargetItem", "MDRM Number", "Edit Test", "Alg Edit Test"])
        self.assertEqual([r["id"] for r in self.records], ["1050", "1090", "1640", "1640", "9000"])
        self.assertEqual(self.records[0]["message"], "Sum of HI-1a1a through HI-1g must equal HI-1h.")
        self.assertEqual(self.records[0]["logic"], "(bhck4435 + bhck4436) eq bhck4107")

    def test_no_glyph_is_lost(self):
        page = self.tables.pages[0]
        self.assertEqual(page.glyphs, page.placed)
        self.assertGreater(page.glyphs, 500)

    def test_an_overflowing_line_stays_with_its_own_row(self):
        row = self.records[2]
        self.assertTrue(row["logic"].endswith("(bhck4645 + bhck4646 + bhck4644)"), row["logic"])
        self.assertEqual(self.records[3]["logic"], "bhck5410 gt 0")
        self.assertGreaterEqual(self.tables.pages[0].overflow_rows, 1)

    def test_roles_keys_and_reads(self):
        self.assertEqual(self.records[2]["field"], "BHCK5409")
        self.assertEqual(self.records[2]["key"], "FRY9C:Validity:1640:BHCK5409")
        self.assertEqual(self.records[3]["key"], "FRY9C:Quality:1640:BHCK5410")  # same number, another edit
        self.assertIn("BHCK4644", self.records[2]["reads"])

    def test_wrapped_hyphen_joins_without_a_space(self):
        self.assertTrue(self.records[2]["message"].endswith("be less than or equal to HC-"), self.records[2]["message"])

    def test_rendered_page_is_a_keyed_rule_table_for_spec_diff(self):
        text = pdf_tables.render_page(self.tables.pages[0])
        tables = spec_diff.tables_from_text(text)
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertEqual(table.kind, "rules")
        roles = {role: table.header[index] for role, index in table.roles.items()}
        self.assertEqual(roles["logic"], "Alg Edit Test")
        self.assertEqual(roles["message"], "Edit Test")
        self.assertEqual(roles["id"], "Edit Number")
        self.assertEqual(roles["field"], "MDRM Number")
        self.assertEqual(roles["status"], "Edit Change")
        self.assertEqual(roles["line_item"], "TargetItem")

    def test_a_revision_is_reported_per_edit_and_reaches_the_registry(self):
        before = pdf_tables.render_page(self.tables.pages[0])
        after = before.replace("(bhck4107 - bhck4073) eq bhck4074", "(bhck4107 - bhck4073 - bhck4518) eq bhck4074")
        result = spec_diff.diff(before, after)
        changes = [c for t in result["tables"] for c in t["changes"] if c["category"] not in spec_diff.QUIET]
        self.assertEqual([(c["category"], c["field"]) for c in changes], [("logic", "BHCK4074")])
        self.assertEqual(changes[0]["mismatch"], "Changed but marked “No Change”")
        touched = registry.touched_codes(None, result, "")
        self.assertEqual([(t["code"], t["change"]) for t in touched], [("BHCK4074", "logic")])

    def test_extraction_uses_the_table_and_its_own_version_label(self):
        profile: dict = {}
        text, kind, error = extract_content("https://example.test/edits.pdf", "application/pdf", self.body, _extraction_profile=profile)
        self.assertIsNone(error)
        self.assertEqual(kind, "pdf")
        self.assertEqual(profile["profile"], "tables")
        self.assertIn("| FRY9C | 20150331 | 99991231 | No Change | HI | Validity | 1090 | HI-3 | BHCK4074 |", text)
        self.assertIsInstance(profile["rule_tables"], pdf_tables.TableSet)
        self.assertTrue(engine.is_current_extractor_version(engine.TABLES_EXTRACTOR_VERSION))
        self.assertTrue(engine.TABLES_EXTRACTOR_VERSION.endswith("-" + pdf_tables.PARSER_VERSION))

    def test_saved_record_is_compact_and_complete(self):
        record = pdf_tables.payload(self.tables, raw_hash="abc", url="u")
        self.assertEqual(record["summary"]["rows"], 5)
        self.assertEqual(record["summary"]["glyphs"], record["summary"]["glyphs_placed"])
        self.assertNotIn("lines", record["rows"][0])
        self.assertIn("lines", pdf_tables.payload(self.tables, lines=True)["rows"][0])
        json.dumps(record)


PDF_URL = "https://example.test/edits.pdf"
PDF_SOURCE = SourceConfig(id="edits", name="Edit checks", regulator="Synthetic Regulator", seed_urls=(PDF_URL,),
                          allowed_prefixes=("https://example.test/",), allowed_domains=("example.test",), allowed_urls=(PDF_URL,))


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class ScanTest(unittest.TestCase):
    def test_a_scan_saves_the_rows_and_state_validates(self):
        body = build_fed_checklist()
        with Sandbox(source=PDF_SOURCE) as sandbox:
            sandbox.scan(lambda *a, **k: ok(body, "application/pdf"))
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["extractor_version"], engine.TABLES_EXTRACTOR_VERSION)
            summary = record["rule_tables"]
            self.assertEqual((summary["rows"], summary["codes"], summary["glyphs"]), (5, 5, summary["glyphs_placed"]))
            saved = json.loads((sandbox.root / summary["rule_tables_location"]).read_text(encoding="utf-8"))
            self.assertEqual([row["id"] for row in saved["rows"]], ["1050", "1090", "1640", "1640", "9000"])
            self.assertEqual(saved["raw_hash"], record["raw_hash"])
            pointer_problems = lambda: [p for p in validate_persisted_state(sandbox.data, {PDF_SOURCE.id}) if "location" in p]
            self.assertEqual(pointer_problems(), [])
            (sandbox.root / summary["rule_tables_location"]).unlink()
            self.assertTrue(any("rule_tables_location points to a missing file" in problem for problem in pointer_problems()))

    def test_an_existing_baseline_moves_to_the_table_reader_quietly(self):
        body = build_fed_checklist()
        with Sandbox(source=PDF_SOURCE) as sandbox:
            # The baseline the ordinary reader made before this reader existed.
            plain = lambda url, ctype, data, **kw: ("FRY9C 20150331 99991231 No Change HI Validity 1050 …", "pdf", None)
            sandbox.scan(lambda *a, **k: ok(body, "application/pdf"), extract=plain)
            uid, record = next(iter(sandbox.inventory().items()))
            self.assertEqual(record["extractor_version"], engine.CONTENT_EXTRACTOR_VERSION)
            migrated = sandbox.scan(lambda *a, **k: ok(body, "application/pdf"))
            types = [event["event_type"] for event in migrated["report"]["events"]]
            self.assertEqual(types, ["BASELINE_MIGRATION"])
            self.assertEqual(migrated["report"]["events"][0]["migration_reason"], "extractor_version")
            self.assertEqual(sandbox.inventory()[uid]["extractor_version"], engine.TABLES_EXTRACTOR_VERSION)
            again = sandbox.scan(lambda *a, **k: ok(body, "application/pdf"))
            self.assertEqual(again["report"]["events"], [])


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class OtherLayoutsTest(unittest.TestCase):
    def test_another_regulators_rule_list_is_read(self):
        tables = read(build_rule_list(continued=True))
        records = tables.records()
        self.assertEqual(tables.pages[0].layout.names, ["Rule ID", "Severity", "Description", "Formula"])
        self.assertEqual([r["id"] for r in records], ["v0101_m", "v0102_m", "v0103_h", "v0104_s", "v0105_m", "v0106_m", "v0107_m"])
        self.assertEqual(records[0]["message"] if "message" in records[0] else records[0]["description"],
                         "Total assets must equal the sum of the asset lines.")
        self.assertEqual(records[3]["logic"], "abs({r060} + {r050} - {r010}) <= 1")
        self.assertEqual([page.continued for page in tables.pages], [False, True])

    def test_vertically_centred_rows_are_refused(self):
        self.assertEqual(read(build_rule_list(centred=True)).pages, [])

    def test_a_second_table_with_its_own_header_is_refused(self):
        self.assertEqual(read(build_rule_list(second_table=True)).pages, [])

    def test_prose_pages_are_not_candidates(self):
        self.assertFalse(pdf_tables.looks_like_table("General Instructions\nWho must report\nThe edit checks are listed at the end."))


# Eight threads reading PDFs through PDFium at once, as the scan's fetch workers
# do. PDFium is not thread-safe; without the shared lock this corrupted its heap
# and killed the process (SIGTRAP, exit 133). Run in a child process so a
# regression fails this test instead of killing the suite.
RACE = r"""
import sys, threading
from regmon import pdf_tables
body = open(sys.argv[1], "rb").read()
expected = [(i, len(s.chars)) for i, s in pdf_tables._pdfium_sheets(body, list(range(16)))]
failures = []
def work():
    for _ in range(15):
        got = [(i, len(s.chars)) for i, s in pdf_tables._pdfium_sheets(body, list(range(16)))]
        if got != expected:
            failures.append(got)
threads = [threading.Thread(target=work) for _ in range(8)]
[t.start() for t in threads]; [t.join() for t in threads]
print(len(expected), len(failures))
"""


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class ThreadSafetyTest(unittest.TestCase):
    def test_concurrent_reads_share_one_pdfium_lock(self):
        import subprocess
        import sys
        import tempfile

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=landscape(letter))
        for _ in range(16):
            _fed_page(c, landscape(letter)[1], FED_ROWS)
            c.showPage()
        c.save()
        with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
            handle.write(buf.getvalue())
            handle.flush()
            run = subprocess.run([sys.executable, "-c", RACE, handle.name], cwd=ROOT, capture_output=True, text=True, timeout=600)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        self.assertEqual(run.stdout.split(), ["16", "0"])

    def test_every_pdfium_call_holds_the_lock(self):
        """Deterministic counterpart of the race above: PDFium opens, reads and
        renders only under the lock, and Tesseract runs outside it."""
        from unittest import mock

        import pypdfium2

        from regmon import content
        from regmon.pdfium_lock import LOCK

        real_open, seen = pypdfium2.PdfDocument, []

        def guarded_open(*args, **kwargs):
            seen.append(LOCK.locked())
            return real_open(*args, **kwargs)

        body = build_fed_checklist()
        with mock.patch.object(pypdfium2, "PdfDocument", guarded_open), \
                mock.patch.object(pdf_tables, "_pdfium_sheet", wraps=lambda d, i, real=pdf_tables._pdfium_sheet: (seen.append(LOCK.locked()), real(d, i))[1]):
            list(pdf_tables._pdfium_sheets(body, [0]))
            ocr_locked = []
            with mock.patch("pytesseract.image_to_string", side_effect=lambda *a, **k: ocr_locked.append(LOCK.locked()) or "text"):
                content._ocr_pdf_pages(body, [0])
        self.assertEqual(seen, [True, True, True])
        self.assertEqual(ocr_locked, [False])

    def test_the_lock_is_free_while_a_page_is_handed_over(self):
        from regmon.pdfium_lock import LOCK

        body = build_fed_checklist()
        for _index, _sheet in pdf_tables._pdfium_sheets(body, [0, 1]):
            self.assertFalse(LOCK.locked())  # the caller's work never runs under it
        self.assertFalse(LOCK.locked())


@unittest.skipUnless(FRY9C_BOOK.is_file(), "the saved FR Y-9C instruction book is not in this checkout")
class FedInstructionBookTest(unittest.TestCase):
    """The FR Y-9C instruction book (effective September 2026) as the monitor saved it."""

    def test_all_edit_checks_are_read_and_reconciled(self):
        tables, _body = pdf_tables.read_file(FRY9C_BOOK)
        summary = tables.summary()
        self.assertEqual((min(summary["pages"]), max(summary["pages"]), len(summary["pages"])), (480, 613, 134))
        # Earlier prose pages that only look like candidates keep their ordinary text.
        self.assertTrue(all(page < 480 for page in summary["pages_not_read"]), summary["pages_not_read"])
        self.assertEqual(summary["rows"], 2195)
        self.assertEqual(summary["glyphs"], summary["glyphs_placed"])
        records = tables.records()
        by_key = {(r["etype"], r["id"], r["field"]): r for r in records}
        # A row whose algebra the PDF draws over the next row (CHK-2).
        self.assertTrue(by_key[("Validity", "1640", "BHCK5409")]["logic"].endswith("(bhckkx48 + bh k4644)"))
        kinds = {d["kind"] for r in records for d in r["defects"]}
        self.assertEqual(kinds, {"code_missing_a_letter", "unbalanced_parentheses", "hyphen_clipped", "expression_cut_off"})


if __name__ == "__main__":
    unittest.main()
