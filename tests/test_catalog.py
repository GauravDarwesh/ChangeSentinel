"""Item catalog (regmon/catalog.py): what regulators say each reporting item is, version by version."""
from __future__ import annotations

import json
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

    def put(self, uid: str, url: str, text: str, rule_tables: dict | None = None):
        location = f"data/snapshots/{uid}-{abs(hash(text))}.txt"
        (self.root / location).write_text(text, encoding="utf-8")
        record = {"canonical_url": url, "snapshot_location": location, "normalized_hash": str(abs(hash(text)))}
        if rule_tables is not None:
            pointer = f"data/rule-tables/{uid}.json"
            (self.root / "data" / "rule-tables").mkdir(exist_ok=True)
            (self.root / pointer).write_text(json.dumps(rule_tables), encoding="utf-8")
            record["rule_tables"] = {"rule_tables_location": pointer}
        self.records[uid] = record

    def build(self, at: str):
        return catalog.update(self.data, {"schema_version": 2, "sources": {"s": dict(self.records)}}, root=self.root, now=at)


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
        (self.ws.data / "items" / "BHCK.json").write_text(json.dumps({"schema_version": 1, "items": {"RCON2170": {"facets": {}}}}))
        self.assertIn("does not belong", " ".join(catalog.validate(self.ws.data)))


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


if __name__ == "__main__":
    unittest.main()
