"""Item catalog (regmon/catalog.py): what regulators say each reporting item is, version by version."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regmon import catalog

MDRM_TEXT = ("[FILE] MDRM_CSV.csv (csv)\n"
             "MDRM | Mnemonic | Item Code | Start Date | End Date | Item Name | Description |\n"
             "BHCK2170 | BHCK | 2170 | 6/30/1981 12:00:00 AM | 12/31/9999 12:00:00 AM | TOTAL ASSETS | The sum of all asset items.\n"
             "BHCK3210 | BHCK | 3210 | 6/30/1986 12:00:00 AM | 12/31/9999 12:00:00 AM | TOTAL EQUITY CAPITAL | Equity capital.\n"
             "BHCK3210 | BHCK | 3210 | 3/31/1981 12:00:00 AM | 3/31/1986 12:00:00 AM | EQUITY CAPITAL | Older definition.\n")
SCHEMA_TEXT = ('[FILE] concepts.xsd (xml)\n<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:xbrli="http://www.xbrl.org/2003/instance">'
               '<element name="RCON2170" type="xbrli:monetaryItemType" xbrli:periodType="instant" xbrli:balance="debit" substitutionGroup="xbrli:item"/>'
               '<element name="EXISTING" type="xbrli:stringItemType"/></schema>\n')
RULE_TABLE = {"rows": [
    {"etype": "Validity", "id": "1090", "field": "BHCK4074", "table": "HI", "line_item": "HI-3", "start": "20150331", "end": "99991231",
     "reads": ["BHCK4107", "BHCK4073"], "page": 12},
    {"etype": "Quality", "id": "9000", "field": "BHCK0081", "table": "HC", "line_item": "HC-1", "start": "20150331", "end": "99991231", "reads": []},
]}


class Workspace:
    """A data/ tree with an inventory whose snapshots the test writes."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        (self.data / "snapshots").mkdir(parents=True)
        self.records: dict = {}

    def put(self, uid: str, url: str, text: str, rule_tables: dict | None = None, raw: str | None = None):
        location = f"data/snapshots/{uid}-{abs(hash(text))}.txt"
        (self.root / location).write_text(text, encoding="utf-8")
        record = {"canonical_url": url, "snapshot_location": location, "normalized_hash": str(abs(hash(text))),
                  "raw_hash": raw or "raw-" + str(abs(hash((text, json.dumps(rule_tables, sort_keys=True)))))}
        if rule_tables is not None:
            pointer = f"data/rule-tables/{uid}.json"
            (self.root / "data" / "rule-tables").mkdir(exist_ok=True)
            (self.root / pointer).write_text(json.dumps(rule_tables), encoding="utf-8")
            record["rule_tables"] = {"rule_tables_location": pointer}
        self.records[uid] = record

    def build(self, at: str, **options):
        return catalog.update(self.data, {"schema_version": 2, "sources": {"s": dict(self.records)}}, root=self.root, now=at, **options)

    def succeed(self, old: str, new: str):
        (self.data / "successions.json").write_text(json.dumps({"schema_version": 1, "successions": [
            {"from": old, "to": new, "follow": True, "rule": "filename_period", "source_id": "s"}]}), encoding="utf-8")


class FactsTest(unittest.TestCase):
    def test_dictionary_rows_keep_the_current_period(self):
        facts = catalog.facts_from_text(MDRM_TEXT)[("MDRM_CSV.csv", "dictionary")]
        self.assertEqual(facts["BHCK2170"], {"name": "TOTAL ASSETS", "definition": "The sum of all asset items.",
                                             "start": "1981-06-30", "end": "9999-12-31"})
        self.assertEqual((facts["BHCK3210"]["name"], facts["BHCK3210"]["periods"]), ("TOTAL EQUITY CAPITAL", "2"))

    def test_schema_concepts_and_not_words(self):
        facts = catalog.facts_from_text(SCHEMA_TEXT)[("concepts.xsd", "schema")]
        self.assertEqual(set(facts), {"RCON2170"})
        self.assertEqual(facts["RCON2170"]["type"], "xbrli:monetaryItemType")

    def test_rule_table_checks_and_reads(self):
        facts = catalog.facts_from_rule_tables(RULE_TABLE)
        self.assertEqual(facts["BHCK4074"], {"schedule": "HI", "line": "HI-3", "checked_by": ["Validity 1090"], "start": "2015-03-31", "pages": [12]})
        self.assertEqual(facts["BHCK4107"], {"read_by": "1", "read_by_sample": ["Validity 1090"]})

    def test_codes_in_logic(self):
        self.assertEqual(catalog._codes_in_logic("ExistingOf(cc:RCON0020[P0], 0) >= 0 And (bhck4107 - bhck4073) eq bhck4074"),
                         {"RCON0020", "BHCK4107", "BHCK4073", "BHCK4074"})

    def test_status_and_dates(self):
        self.assertEqual(catalog.status_of("https://x.gov/a.pdf", "", "Redlined Draft FFIEC 031 Reporting Form"), "proposed")
        self.assertEqual(catalog.status_of("https://www.eba.europa.eu/x?phase=consultation"), "proposed")
        self.assertEqual(catalog.status_of("https://www.ffiec.gov/FFIEC031_202609_f.pdf", "", "FFIEC 031 Reporting Form"), "final")
        self.assertEqual(catalog.report_date("call-report031-2026-09-30-v301-ec.xml"), "2026-09-30")
        self.assertEqual((catalog.quarter("2027-03-31"), catalog.quarter("9999-12-31")), ("2027Q1", ""))


    def test_dictionary_dates_the_item_not_its_checks(self):
        current = {"a": {"kind": "checklist", "status": "final", "attrs": {"start": "2015-03-31"}},
                   "b": {"kind": "dictionary", "status": "final", "attrs": {"start": "1981-06-30", "end": "9999-12-31"}}}
        self.assertEqual(catalog.effective(current), {"basis": ["dictionary"], "from": "1981-06-30", "first_quarter": "1981Q2",
                                                      "to": "9999-12-31", "last_quarter": ""})
        del current["b"]
        self.assertEqual(catalog.effective(current)["basis"], ["checklist"])


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.tmp.cleanup()

    def test_versions_only_when_something_changes(self):
        ws = self.ws
        ws.put("mdrm", "https://www.federalreserve.gov/apps/mdrm/pdf/MDRM.zip", MDRM_TEXT)
        ws.put("book", "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=x", "text", RULE_TABLE)
        first = ws.build("2026-10-31T00:00:00+00:00")
        self.assertEqual(first["documents"], 2)
        self.assertEqual(ws.build("2026-11-01T00:00:00+00:00"), {"documents": 0, "versions": 0, "items": 0})
        self.assertEqual(catalog.validate(ws.data), [])

        # The next dictionary: one item renamed, one end-dated, one retired from the file.
        ws.put("mdrm", "https://www.federalreserve.gov/apps/mdrm/pdf/MDRM.zip",
               MDRM_TEXT.replace("| TOTAL ASSETS |", "| TOTAL CONSOLIDATED ASSETS |")
               .replace("BHCK3210 | BHCK | 3210 | 6/30/1986 12:00:00 AM | 12/31/9999", "BHCK3210 | BHCK | 3210 | 6/30/1986 12:00:00 AM | 3/31/2027")
               + "BHCKPZ99 | BHCK | PZ99 | 3/31/2027 12:00:00 AM | 12/31/9999 12:00:00 AM | NEW ITEM | A new item.\n")
        second = ws.build("2026-12-20T00:00:00+00:00")
        self.assertEqual((second["documents"], second["versions"]), (1, 3))

        renamed = catalog.history(ws.data, "BHCK2170")
        self.assertEqual([entry["at"][:10] for entry in renamed["timeline"]], ["2026-12-20", "2026-10-31"])
        self.assertEqual(renamed["timeline"][0]["changed"], ["name"])
        self.assertTrue(renamed["timeline"][1]["superseded"])
        ended = catalog.history(ws.data, "BHCK3210")
        self.assertEqual(ended["effective"], {"basis": ["dictionary"], "from": "1986-06-30", "first_quarter": "1986Q2",
                                               "to": "2027-03-31", "last_quarter": "2027Q1"})
        self.assertEqual(catalog.history(ws.data, "BHCKPZ99")["effective"]["first_quarter"], "2027Q1")
        # Both sources stay in the item's view.
        self.assertEqual({facet["kind"] for facet in catalog.history(ws.data, "BHCK4074")["current"].values()}, {"checklist"})

    def test_a_code_that_leaves_a_document(self):
        ws = self.ws
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT)
        ws.build("2026-10-31T00:00:00+00:00")
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT.replace(
            "BHCK2170 | BHCK | 2170 | 6/30/1981 12:00:00 AM | 12/31/9999 12:00:00 AM | TOTAL ASSETS | The sum of all asset items.\n", ""))
        ws.build("2026-12-20T00:00:00+00:00")
        item = catalog.history(ws.data, "BHCK2170")
        self.assertEqual(item["current"], {})
        self.assertEqual(item["timeline"][0]["status"], "absent")

    def test_unknown_and_invalid(self):
        self.assertIsNone(catalog.history(self.ws.data, "BHCK2170"))
        self.assertIsNone(catalog.history(self.ws.data, "not a code"))
        self.ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT)
        self.ws.build("2026-10-31T00:00:00+00:00")
        (self.ws.data / "items" / "BHCK.json").write_text(json.dumps({"schema_version": 2, "items": {"RCON2170": {"facets": {}}}}))
        self.assertIn("does not belong", " ".join(catalog.validate(self.ws.data)))


# The FFIEC 101/102 edit workbooks as the scan saves them: a prose "Edit Test", the
# formula in "Boolean Algebra", the target in "MDRM Number", and archived rows.
WORKBOOK_HEAD = ("[WORKBOOK] 1 sheet: Published Validity\n[SHEET] Published Validity\n"
                 "Published Validity · A: Series · B: Effective Start Date · C: Effective End Date · D: Type of Change · F: Schedule · "
                 "G: Edit Type · H: Edit Number · I: Target Item · J: MDRM Number · K: Edit Test · L: Boolean Algebra\n")


def workbook(rows):
    return WORKBOOK_HEAD + "".join(
        f"Published Validity · A: FFIEC102 · B: {start} · C: {end} · D: {change} · F: {schedule} · G: Validity · H: {number} · I: {item} · "
        f"J: {code} · K: {test} · L: {algebra}\n" for start, end, change, schedule, number, item, code, test, algebra in rows)


EDITS = [
    ("20150331", "20160331", "Archived", "Cover Page", "1", "SROFFRNM", "MRRRC490", "SROFFRNM must not be null.", "mrrrc490 ne null"),
    ("20161231", "99991231", "No Change", "MR", "2", "MR1", "MRRRS298", "IF MR1 is reported THEN C10A must be less than 1000.",
     "if mrrrs298 ne null then mrrrs299 lt 1000"),
    ("20161231", "99991231", "No Change", "MR", "3", "MR2", "MRRRS299", "MR2 must not be null.", "mrrrs299 ne null"),
]


def taxonomy_edits(date: str, extra: tuple = ()) -> str:
    """A CDR taxonomy's edit linkbase as the scan saves it (one dated member of the ZIP)."""
    rules = (("0110", "cc:RCON2170[P0] eq cc:RCON2948[P0] + cc:RCON3210[P0]"), ("0120", "cc:RCON3210[P0] ge 0")) + extra
    links = "".join(f'<loc xlink:type="locator" xlink:href="call-report031.xsd#ffiec031_{n}" xlink:label="ffiec031_{n}" />'
                    f'<formulaArc xlink:type="arc" xlink:from="ffiec031_{n}" xlink:to="ffiec031_{n}_formula" />'
                    f'<formula xlink:type="resource" xlink:role="https://www.cdr.ffiec.gov/xbrl/rule/ruleType2" '
                    f'xlink:label="ffiec031_{n}_formula" select="{logic}" />' for n, logic in rules)
    return (f"[FILE] call-report031-{date}-v301-ec.xml (xml)\n"
            '<?xml version="1.0"?><link:linkbase xmlns="https://www.cdr.ffiec.gov/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'xmlns:link="http://www.xbrl.org/2003/linkbase"><formulaLink xlink:type="extended">{links}</formulaLink></link:linkbase>\n')


class EditTablesTest(unittest.TestCase):
    def test_a_workbook_is_read_from_its_target_and_formula_columns(self):
        facts = catalog.facts_from_text(workbook(EDITS))[("", "edits")]
        self.assertEqual(set(facts), {"MRRRS298", "MRRRS299"})  # MRRRC490 only has an archived row
        self.assertEqual(facts["MRRRS298"], {"schedule": "MR", "line": "MR1", "checked_by": ["Validity 2"], "start": "2016-12-31"})
        self.assertEqual(facts["MRRRS299"]["read_by_sample"], ["Validity 2"])
        self.assertEqual(facts["MRRRS299"]["checked_by"], ["Validity 3"])

    def test_words_in_edit_text_are_not_codes(self):
        self.assertEqual(catalog._codes_in_logic("IF MR1 THEN C10A ELSE MR18 less than 1000 in June 2026; BHCK 2170 and bhck 3210"),
                         {"BHCK2170"})
        self.assertEqual(catalog._code("THENC10A"), "")

    def test_document_key_drops_periods_and_versions_not_form_numbers(self):
        self.assertEqual(catalog.document_key("call-report031-2026-09-30-v301-ec.xml"), "call-report031-ec.xml")
        self.assertEqual(catalog.document_key("FFIEC031_202609_f.pdf"), "ffiec031_f.pdf")
        self.assertEqual(catalog.document_key("FR_2052a_2026Q3.xlsx"), "fr_2052a.xlsx")
        self.assertEqual(catalog.document_key("2027-bcar-rnfpb-rtn-rel-2026-09-10-en.xlsx"), "2027-bcar-rnfpb-rtn-rel-en.xlsx")


class EditionTest(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.tmp.cleanup()

    def test_next_quarters_taxonomy_at_the_same_address(self):
        ws = self.ws
        url = "https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx?form=031"
        ws.put("t", url, taxonomy_edits("2026-09-30"))
        self.assertEqual(ws.build("2026-10-31T00:00:00+00:00")["versions"], 3)
        ws.put("t", url, taxonomy_edits("2026-12-31"))
        self.assertEqual(ws.build("2027-01-15T00:00:00+00:00")["versions"], 0)  # says the same: no new version
        item = catalog.history(ws.data, "RCON3210")
        self.assertEqual(len(item["current"]), 1)
        self.assertEqual(item["effective"]["report_date"], "2026-12-31")  # confirmed by the newest edition
        ws.put("t", url, taxonomy_edits("2027-03-31", (("0130", "cc:RCON3210[P0] le cc:RCON2170[P0]"),)))
        self.assertEqual(ws.build("2027-04-15T00:00:00+00:00")["versions"], 2)  # a new edit reads RCON3210 and RCON2170
        latest = catalog.history(ws.data, "RCON3210")["timeline"][0]
        self.assertEqual((latest["changed"], latest["document"]), (["read_by", "read_by_sample"], "call-report031-2027-03-31-v301-ec.xml"))
        self.assertEqual(catalog.history(ws.data, "RCON2948")["timeline"][0]["at"][:10], "2026-10-31")  # untouched
        self.assertEqual(catalog.validate(ws.data), [])

    def test_a_new_edition_at_a_new_address_continues_the_item(self):
        ws = self.ws
        old, new = "https://x.gov/FRY9C_checklist_202609.pdf", "https://x.gov/FRY9C_checklist_202612.pdf"
        ws.put("old", old, "text", RULE_TABLE)
        ws.build("2026-10-31T00:00:00+00:00")
        moved = json.loads(json.dumps(RULE_TABLE))
        moved["rows"][0]["line_item"] = "HI-4"
        moved["rows"][0]["page"] = 13
        ws.put("new", new, "text", moved)
        ws.succeed(old, new)
        built = ws.build("2027-01-15T00:00:00+00:00")
        self.assertEqual((built["documents"], built["versions"]), (1, 1))  # only the moved line; the old edition is not read
        item = catalog.history(ws.data, "BHCK4074")
        self.assertEqual([facet["url"] for facet in item["current"].values()], [new])
        self.assertEqual(item["timeline"][0]["changed"], ["line"])
        self.assertEqual((item["timeline"][0]["url"], item["timeline"][1]["url"]), (new, old))
        self.assertTrue(item["timeline"][1]["superseded"])
        self.assertEqual(catalog.history(ws.data, "BHCK0081")["current"][next(iter(item["current"]))]["first_read_in"]["url"], old)
        # The regulator deletes the old file (#264 retires it): nothing becomes absent.
        ws.records["old"].update(active=False, superseded_by=new)
        self.assertEqual(ws.build("2027-01-16T00:00:00+00:00")["versions"], 0)
        self.assertEqual(catalog.validate(ws.data), [])

    def test_a_retired_file_without_a_successor_ends_its_items(self):
        ws = self.ws
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT)
        ws.build("2026-10-31T00:00:00+00:00")
        del ws.records["mdrm"]
        self.assertEqual(ws.build("2026-11-30T00:00:00+00:00")["versions"], 2)
        self.assertEqual(catalog.history(ws.data, "BHCK2170")["current"], {})
        self.assertEqual(ws.build("2026-12-01T00:00:00+00:00")["versions"], 0)
        self.assertEqual(catalog.validate(ws.data), [])

    def test_the_same_bytes_read_again_fix_facts_in_place(self):
        ws = self.ws
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT, raw="r1")
        ws.build("2026-10-31T00:00:00+00:00")
        # A parser change reads the unchanged file differently.
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT.replace("The sum of all asset items.", "The sum of all asset items (read better)."), raw="r1")
        self.assertEqual(ws.build("2026-11-01T00:00:00+00:00")["versions"], 0)
        item = catalog.history(ws.data, "BHCK2170")
        self.assertEqual(len(item["timeline"]), 1)
        self.assertEqual(item["timeline"][0]["reread"], "2026-11-01T00:00:00+00:00")
        self.assertIn("read better", item["timeline"][0]["attrs"]["definition"])
        # A catalog version bump re-reads everything; nothing new is said.
        self.assertEqual(ws.build("2026-11-02T00:00:00+00:00", force=True), {"documents": 1, "versions": 0, "items": 2})

    def test_an_older_catalog_is_rebuilt(self):
        ws = self.ws
        (ws.data / "items").mkdir()
        (ws.data / "items" / "THEN.json").write_text('{"schema_version":1,"items":{}}')
        (ws.data / "items" / "index.json").write_text('{"schema_version":1,"sources":{}}')
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT)
        ws.build("2026-10-31T00:00:00+00:00")
        self.assertFalse((ws.data / "items" / "THEN.json").exists())
        self.assertEqual(catalog.validate(ws.data), [])


NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class DashboardTest(unittest.TestCase):
    """The Registry's item sheet reads a series file the way catalog.history() does."""

    def test_the_dashboard_reads_the_same_timeline(self):
        ws = Workspace()
        self.addCleanup(ws.tmp.cleanup)
        old, new = "https://x.gov/FRY9C_checklist_202609.pdf", "https://x.gov/FRY9C_checklist_202612.pdf"
        ws.put("mdrm", "https://x.gov/MDRM.zip", MDRM_TEXT)
        ws.put("old", old, "text", RULE_TABLE)
        ws.build("2026-10-31T00:00:00+00:00")
        moved = json.loads(json.dumps(RULE_TABLE))
        moved["rows"][0]["line_item"] = "HI-4"
        ws.put("new", new, "text", moved)
        ws.succeed(old, new)
        ws.build("2027-01-15T00:00:00+00:00")
        lib = Path(catalog.__file__).resolve().parent.parent / "dashboard-lib.js"
        series = (ws.data / "items" / "BHCK.json").read_text(encoding="utf-8")
        script = (f"const L = require({json.dumps(str(lib))}); const doc = {series};"
                  "const item = L.catalogItem(doc, 'bhck 4074'); const two = L.catalogItem(doc, 'BHCK2170');"
                  "console.log(JSON.stringify({item, two, labels: item.timeline.map(L.catalogEntryLabel), missing: L.catalogItem(doc, 'BHCK9999'),"
                  "facts: L.catalogFacts(two.current[0].attrs).map(f => f[0]), date: L.catalogDate('2027-03-31'), q: L.catalogQuarter('2027-03-31')}));")
        out = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)
        py = catalog.history(ws.data, "BHCK4074")
        item = out["item"]
        self.assertEqual([(e["at"], e["status"], e["url"], e.get("changed")) for e in item["timeline"]],
                         [(e["at"], e["status"], e["url"], e.get("changed")) for e in py["timeline"]])
        self.assertEqual(out["labels"], ["Changed", "First read"])
        self.assertEqual([facet["url"] for facet in item["current"]], [facet["url"] for facet in py["current"].values()])
        self.assertEqual(out["two"]["effective"], {"basis": ["dictionary"], "from": "1981-06-30", "firstQuarter": "1981 Q2", "to": "9999-12-31", "lastQuarter": ""})
        self.assertIsNone(out["missing"])
        self.assertEqual(out["facts"], ["Name", "Definition", "From", "To"])
        self.assertEqual((out["date"], out["q"]), ("31 Mar 2027", "2027 Q1"))


class ScanTest(unittest.TestCase):
    def test_a_scan_builds_the_catalog(self):
        from unittest.mock import patch
        from engine_harness import Sandbox, ok
        from regmon import engine
        from regmon.config import SourceConfig
        url = "https://www.example.gov/dictionary.csv"
        source = SourceConfig(id="dictionary", name="Dictionary", regulator="Example", seed_urls=(url,),
                              allowed_prefixes=("https://www.example.gov/",), allowed_domains=("www.example.gov",), allowed_urls=(url,))
        body = b"MDRM,Schedule,Line,Description\nBHCK2170,HC,12,Total assets\nBHCK3210,HC,27a,Total equity capital\n"
        with Sandbox(source=source) as sandbox:
            result = sandbox.scan(lambda *a, **k: ok(body, "text/csv"))
            with patch("regmon.engine.load_config", return_value=({}, {source.id: source})):
                engine.save_outputs([result], "catalog-run")
            item = catalog.history(sandbox.data, "BHCK3210")
            self.assertEqual(next(iter(item["current"].values()))["attrs"], {"definition": "Total equity capital", "schedule": "HC", "line": "27a"})
            self.assertEqual(catalog.validate(sandbox.data), [])


class WiringTest(unittest.TestCase):
    def test_the_scan_builds_the_catalog_and_the_assistant_reads_it(self):
        engine_source = (Path(catalog.__file__).parent / "engine.py").read_text(encoding="utf-8")
        self.assertIn("catalog.update(DATA, payload, root=ROOT)", engine_source)
        from regmon import mcp_server
        self.assertIn("catalog.history", Path(mcp_server.__file__).read_text(encoding="utf-8"))

    def test_the_registry_item_sheet_shows_it_and_pages_publishes_it(self):
        root = Path(catalog.__file__).resolve().parent.parent
        dashboard = (root / "dashboard.js").read_text(encoding="utf-8")
        self.assertEqual(dashboard.count('<div id="registryCatalog"></div>'), 2)  # registered items and unregistered codes
        self.assertEqual(dashboard.count("fillCatalog("), 3)
        pages = (root / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn('"data/items/**"', pages)
        self.assertIn("cp data/items/*.json site/data/items/", pages)


if __name__ == "__main__":
    unittest.main()
