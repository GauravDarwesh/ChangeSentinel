"""Documents regulators publish beyond PDF, HTML and .xlsx are read and compared.

Excel 97-2003 (.xls, and the Excel 2003 XML and HTML-table files that carry an
.xls name), Word 97-2003 (.doc), PowerPoint 97-2003 (.ppt), OpenDocument
(.ods/.odt), RTF, TSV, XML served as plain text (XSD, XBRL), XBRL instances and
taxonomy-style ZIP bundles. Fixtures in tests/fixtures/legacy were written by
LibreOffice from the same synthetic content as the .xlsx/.docx built here.
"""
from __future__ import annotations

import datetime
import gzip
import hashlib
import io
import json
import unittest
import zipfile
from pathlib import Path

from engine_harness import Sandbox, ok
from regmon import engine, spec_diff
from regmon.config import SourceConfig
from regmon.content import extract_content
from regmon.validate_state import validate_persisted_state

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "legacy"
XLS = "application/vnd.ms-excel"


def fixture(name: str) -> bytes:
    data = (FIXTURES / name).read_bytes()
    return gzip.decompress(data) if name.endswith(".gz") else data


def template_xlsx() -> bytes:
    """The workbook the .xls/.ods fixtures were converted from."""
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "Schedule HC"
    sheet.append(["Item", "Description", "Amount"])
    sheet.append(["BHCK2170", "Total assets", 1250])
    sheet.append(["BHCK2122", "Loans", 300.5])
    sheet.merge_cells("A5:C5")
    sheet["A5"] = "Memoranda"
    sheet["D2"] = datetime.date(2027, 3, 31)
    codes = book.create_sheet("Codes")
    codes.append(["Code", "Label"])
    codes.append(["Y", "Yes"])
    codes.sheet_state = "hidden"
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def read(name: str, body: bytes, content_type: str = ""):
    return extract_content("https://example.test/" + name, content_type, body)


class TestWorkbookFormats(unittest.TestCase):
    def test_an_excel_97_2003_workbook_reads_exactly_like_the_same_xlsx(self):
        xlsx, kind_x, error_x = read("template.xlsx", template_xlsx())
        xls, kind, error = read("template.xls", fixture("template.xls.gz"), XLS)
        self.assertIsNone(error_x)
        self.assertIsNone(error)
        self.assertEqual((kind_x, kind), ("xlsx", "xls"))
        self.assertEqual(xls, xlsx)
        self.assertIn("[SHEET hidden] Codes", xls)
        self.assertIn("[MERGED] Schedule HC · A5:C5", xls)
        self.assertIn("D: 2027-03-31", xls)

    def test_an_xls_is_recognised_by_its_contents_whatever_it_is_called(self):
        text, kind, error = read("DownloadAttachment?guid=1", fixture("template.xls.gz"), "application/octet-stream")
        self.assertIsNone(error)
        self.assertEqual(kind, "xls")
        self.assertIn("Schedule HC · A: BHCK2170", text)

    def test_excel_2003_xml_and_html_tables_named_xls_are_workbooks(self):
        text, kind, error = read("template.xls", fixture("ssml.xls"), XLS)
        self.assertIsNone(error)
        self.assertEqual(kind, "xls")
        self.assertIn("Schedule HC · A: BHCK2122 · B: Loans · C: =R[-1]C*0.24 → 300.5", text)
        self.assertIn("[MERGED] Schedule HC · A5:C5", text)
        self.assertIn("[SHEET hidden] Codes", text)
        self.assertIn("[NAME] Total = ='Schedule HC'!R2C3", text)
        html, kind, error = read("informe.xls", fixture("table.xls"), XLS)
        self.assertIsNone(error)
        self.assertEqual(kind, "xls")
        self.assertIn("Table 1 · A: 101 · B: Depósitos", html)

    def test_an_opendocument_spreadsheet_reads_like_the_same_xlsx(self):
        xlsx, _, _ = read("template.xlsx", template_xlsx())
        ods, kind, error = read("template.ods", fixture("template.ods"))
        self.assertIsNone(error)
        self.assertEqual(kind, "ods")
        self.assertEqual(ods, xlsx)

    def test_tab_separated_values_read_as_rows(self):
        text, kind, error = read("codes.tsv", b"Code\tLabel\nY\tYes, with a comma\n", "text/tab-separated-values")
        self.assertIsNone(error)
        self.assertEqual(kind, "csv")
        self.assertEqual(text, "Code | Label\nY | Yes, with a comma")


class TestWordAndSlideFormats(unittest.TestCase):
    def test_a_word_97_2003_document_keeps_paragraphs_and_table_rows(self):
        text, kind, error = read("instructions.doc", fixture("instructions.doc.gz"), "application/msword")
        self.assertIsNone(error)
        self.assertEqual(kind, "doc")
        self.assertEqual(text.splitlines(), [
            "Reporting instructions",
            "Report FR Y-9C by 30 days after quarter end.",
            "| Item | Code | Description |",
            "| Total assets | BHCK2170 | Sum of all assets |",
            "| Loans | BHCK2122 | Net loans and leases |",
            "Effective for the March 31, 2027 report date.",
        ])

    def test_a_powerpoint_97_2003_deck_keeps_slides_and_notes(self):
        text, kind, error = read("deck.ppt", fixture("deck.ppt.gz"), "application/vnd.ms-powerpoint")
        self.assertIsNone(error)
        self.assertEqual(kind, "ppt")
        self.assertEqual(text.splitlines(), [
            "[SLIDE] 1", "FR Y-9C changes", "New item BHCK9999", "Effective Q1 2027",
            "[SLIDE] 2", "Timeline", "Comments due March 2, 2027", "[NOTES] Speaker note",
        ])

    def test_opendocument_text_and_rtf_read_their_text_and_tables(self):
        odt, kind, error = read("instructions.odt", fixture("instructions.odt"))
        self.assertIsNone(error)
        self.assertEqual(kind, "odt")
        self.assertIn("| Total assets | BHCK2170 | Sum of all assets |", odt)
        rtf, kind, error = read("instructions.rtf", fixture("instructions.rtf"), "application/rtf")
        self.assertIsNone(error)
        self.assertEqual(kind, "rtf")
        self.assertIn("| Total assets | BHCK2170 | Sum of all assets |", rtf)
        self.assertIn("Effective for the March 31, 2027 report date.", rtf)
        self.assertNotIn("\\", rtf)

    def test_a_doc_that_is_really_rtf_reads_as_rtf(self):
        text, kind, error = read("instructions.doc", fixture("instructions.rtf"), "application/msword")
        self.assertIsNone(error)
        self.assertEqual(kind, "rtf")
        self.assertIn("Reporting instructions", text)

    def test_an_office_container_with_no_known_part_is_a_clear_error(self):
        from regmon import legacy_office

        saved = legacy_office.ole_kind
        legacy_office.ole_kind = lambda _body: None   # as for an Outlook .msg or an installer
        try:
            text, kind, error = read("mail.msg", fixture("template.xls.gz"), "application/vnd.ms-outlook")
        finally:
            legacy_office.ole_kind = saved
        self.assertIsNone(text)
        self.assertEqual(kind, "binary")
        self.assertIn("Office 97-2003", error)


class TestXmlFormats(unittest.TestCase):
    XSD = b'<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="BA" type="xs:string"/></xs:schema>'

    def test_xml_served_as_plain_text_or_octet_stream_is_xml(self):
        for name, content_type in (("bcar.xsd", "text/plain"), ("filing.xbrl", "application/octet-stream"), ("schema", "text/plain; charset=utf-8")):
            text, kind, error = read(name, self.XSD, content_type)
            self.assertIsNone(error, name)
            self.assertEqual(kind, "xml", name)
            self.assertIn('<xs:element name="BA" type="xs:string" />', text)

    def test_plain_text_that_is_not_xml_stays_text(self):
        text, kind, _ = read("notes.txt", b"<b> is bold\nnot xml", "text/plain")
        self.assertEqual(kind, "text")
        page = b'<?xml version="1.0"?><html><body>Hi</body></html>'
        _, kind, _ = read("page", page, "text/plain")
        self.assertEqual(kind, "text")

    def test_an_xhtml_file_reads_as_a_page(self):
        text, kind, error = read("report.xhtml", b"<html><body><main><p>Inline XBRL report</p></main></body></html>")
        self.assertIsNone(error)
        self.assertEqual(kind, "html")
        self.assertIn("Inline XBRL report", text)


def instance(context_id: str, assets: int, extra: str = "") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:link="http://www.xbrl.org/2003/linkbase"
 xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
 xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:frb="http://www.ffiec.gov/xbrl/call/concepts">
 <link:schemaRef xlink:type="simple" xlink:href="call.xsd"/>
 <xbrli:context id="{context_id}"><xbrli:entity><xbrli:identifier scheme="http://www.ffiec.gov/cdr">12345</xbrli:identifier></xbrli:entity>
  <xbrli:period><xbrli:instant>2027-03-31</xbrli:instant></xbrli:period></xbrli:context>
 <xbrli:context id="{context_id}d"><xbrli:entity><xbrli:identifier scheme="http://www.ffiec.gov/cdr">12345</xbrli:identifier>
  <xbrli:segment><xbrldi:explicitMember dimension="frb:LoanTypeAxis">frb:CommercialMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity>
  <xbrli:period><xbrli:startDate>2027-01-01</xbrli:startDate><xbrli:endDate>2027-03-31</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
 <frb:BHCK2170 contextRef="{context_id}" unitRef="USD" decimals="0">{assets}</frb:BHCK2170>
 <frb:BHCK2122 contextRef="{context_id}d" unitRef="USD" decimals="0">300</frb:BHCK2122>
 {extra}
</xbrli:xbrl>""".encode("utf-8")


class TestXbrlInstanceComparison(unittest.TestCase):
    def text(self, body: bytes) -> str:
        text, kind, error = read("filing.xbrl", body, "application/octet-stream")
        self.assertIsNone(error)
        self.assertEqual(kind, "xml")
        return text

    def test_facts_are_compared_by_concept_period_dimensions_and_unit(self):
        before = self.text(instance("c1", 1250))
        after = self.text(instance("c1", 1300, '<frb:RCON9999 contextRef="c1">Yes</frb:RCON9999>'))
        result = spec_diff.diff(before, after)
        facts = next(table for table in result["tables"] if table["kind"] == "facts")
        categories = {change["label"]: change["category"] for change in facts["changes"]}
        self.assertEqual(categories, {"BHCK2170 · 2027-03-31 · iso4217:USD · cdr:12345": "definition",
                                      "RCON9999 · 2027-03-31 · cdr:12345": "added"})
        self.assertIn("value changed 1", spec_diff.headline(result))

    def test_renumbered_contexts_are_not_a_change(self):
        result = spec_diff.diff(self.text(instance("c1", 1250)), self.text(instance("C_2027Q1", 1250)))
        for table in result["tables"]:
            self.assertEqual({change["category"] for change in table["changes"]} - {"metadata"}, set(), table["kind"])


def zip_of(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class TestBundles(unittest.TestCase):
    def test_a_taxonomy_package_is_read_and_an_unreadable_member_is_fingerprinted(self):
        dtd = b"<!ELEMENT note (#PCDATA)>"
        body = zip_of({
            "META-INF/taxonomyPackage.xml": b"<taxonomyPackage><name>Call</name></taxonomyPackage>",
            "call/call.xsd": TestXmlFormats.XSD,
            "call/sample.xbrl": instance("c1", 1250),
            "call/legacy.xls": fixture("template.xls.gz"),
            "call/entities.dtd": dtd,
        })
        text, kind, error = read("taxonomy.zip", body, "application/zip")
        self.assertIsNone(error)
        self.assertEqual(kind, "zip")
        self.assertIn("[FILE] call/call.xsd (xml)", text)
        self.assertIn("[FILE] call/sample.xbrl (xml)", text)
        self.assertIn("[FILE] call/legacy.xls (xls)", text)
        self.assertIn("Schedule HC · A: BHCK2170", text)
        self.assertIn(f"[FILE] call/entities.dtd (binary)\nNot readable as text · {len(dtd):,} bytes · SHA-256 {hashlib.sha256(dtd).hexdigest()}", text)
        changed, _, _ = read("taxonomy.zip", zip_of({"call/call.xsd": TestXmlFormats.XSD, "call/entities.dtd": dtd + b" "}), "application/zip")
        self.assertNotIn(hashlib.sha256(dtd).hexdigest(), changed)

    def test_a_bundle_of_already_supported_members_reads_as_before(self):
        text, _, error = read("bundle.zip", zip_of({"b.csv": b"a,b\n1,2\n", "a.txt": b"Hello"}), "application/zip")
        self.assertIsNone(error)
        self.assertEqual(text, "[FILE] a.txt (text)\nHello\n[FILE] b.csv (csv)\na | b\n1 | 2")

    def test_a_bundle_with_nothing_readable_still_fails(self):
        _, kind, error = read("bundle.zip", zip_of({"x.dtd": b"<!ELEMENT x ANY>"}), "application/zip")
        self.assertEqual(kind, "zip")
        self.assertIn("no supported extractable documents", error)
        self.assertIn("1 file(s) of a type no extractor reads", error)


URL = "https://example.test/dcip-83-informe.xls"
XLS_SOURCE = SourceConfig(
    id="legacy-xls", name="Legacy workbook", regulator="Synthetic Regulator", seed_urls=(URL,),
    allowed_prefixes=("https://example.test/",), allowed_domains=("example.test",), allowed_urls=(URL,),
)


class TestLegacyWorkbookMonitoring(unittest.TestCase):
    def test_an_xls_keeps_its_original_and_a_change_is_detected(self):
        first, second = fixture("template.xls.gz"), fixture("template_v2.xls.gz")
        with Sandbox(source=XLS_SOURCE) as sandbox:
            sandbox.scan(lambda *a, **k: ok(first, XLS))
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["extraction_type"], "xls")
            self.assertEqual(record["extractor_version"], engine.WORKBOOK_EXTRACTOR_VERSION)
            self.assertTrue(record["file_snapshot_location"].endswith(".xls"))
            self.assertEqual((sandbox.root / record["file_snapshot_location"]).read_bytes(), first)
            quiet = sandbox.scan(lambda *a, **k: ok(first, XLS))
            self.assertFalse([e for e in quiet["report"]["events"] if e["event_type"] == "CHANGED_URL"])
            changed = sandbox.scan(lambda *a, **k: ok(second, XLS))
            events = [e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL"]
            self.assertEqual(len(events), 1)
            evidence = json.loads((sandbox.root / events[0]["evidence_location"]).read_text(encoding="utf-8"))
            self.assertEqual(evidence["before"]["extraction_type"], "xls")
            self.assertTrue(evidence["before"]["file_snapshot_location"].endswith(".xls"))
            self.assertTrue(evidence["after"]["file_snapshot_location"].endswith(".xls"))
            self.assertIn("+Schedule HC · A: BHCK9999 · B: New item", evidence["diff"])

    def test_an_xls_that_used_to_fail_starts_its_baseline_without_an_alert(self):
        body = fixture("template.xls.gz")
        with Sandbox(source=XLS_SOURCE) as sandbox:
            sandbox.scan(lambda *a, **k: ok(body, XLS))
            inventory = sandbox.inventory()
            uid, record = next(iter(inventory.items()))
            # The shape every .xls monitor had before: unsupported, no text, no original.
            record.update({"extraction_type": "binary", "extraction_error": "Unsupported content type for text extraction",
                           "normalized_hash": None, "snapshot_location": None, "file_snapshot_location": None, "extractor_version": None})
            sandbox.write_inventory(inventory)
            recovered = sandbox.scan(lambda *a, **k: ok(body, XLS))
            types = [e["event_type"] for e in recovered["report"]["events"]]
            self.assertNotIn("CHANGED_URL", types)
            self.assertNotIn("EXTRACTION_ERROR", types)
            record = sandbox.inventory()[uid]
            self.assertIsNone(record["extraction_error"])
            self.assertTrue(record["snapshot_location"])
            self.assertTrue(record["file_snapshot_location"].endswith(".xls"))

    def test_state_validation_expects_the_original_of_an_xls(self):
        with Sandbox(source=XLS_SOURCE) as sandbox:
            sandbox.scan(lambda *a, **k: ok(fixture("template.xls.gz"), XLS))
            data_dir = sandbox.root / "data"
            snapshot_problems = lambda: [p for p in validate_persisted_state(data_dir, {XLS_SOURCE.id}) if "snapshot_location" in p]
            self.assertEqual(snapshot_problems(), [])
            inventory = sandbox.inventory()
            next(iter(inventory.values()))["file_snapshot_location"] = None
            sandbox.write_inventory(inventory)
            self.assertTrue(any("is XLS but has no file_snapshot_location" in problem for problem in snapshot_problems()))


class TestDiffIsBounded(unittest.TestCase):
    def test_a_large_rewrite_stops_at_the_line_cap(self):
        from regmon.change import make_diff

        before = "\n".join(f"line {i}" for i in range(20000))
        after = "\n".join(f"row {i}" for i in range(20000))
        diff = make_diff(before, after, max_lines=50)
        self.assertEqual(len(diff.splitlines()), 51)
        self.assertTrue(diff.endswith("... diff truncated after 50 lines"))


if __name__ == "__main__":
    unittest.main()
