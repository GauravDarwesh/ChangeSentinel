"""Reporting-item impact: which form items a change added, retired or redefined."""
import json
import unittest

from regmon import item_codes, lineage
from tests.engine_harness import Sandbox, URL, ok

HEADER = "| No. | Section | Field | Options | Item code | Entry |\n| --- | --- | --- | --- | --- | --- |"
BEFORE = HEADER + """
| 1 | Positions | Total loans |  | QTFL 1596 |  |
| 2 | Positions | Securities |  | QTFL 1917 |  |
| 3 | Positions | Deposits |  | QTFL 6130 |  |
Report QTFL 1596 as of the report date. Effective June 2026, Form 2028 applies. Year 2026."""
AFTER = HEADER + """
| 1 | Positions | Total loans |  | QTFL 1596 |  |
| 2 | Positions | Securities (AFS and HTM) |  | QTFL 1917 |  |
| 3 | Positions | Brokered deposits |  | QTFL 6131 |  |
Report QTFL 1596 as of the report date. Effective June 2026, Form 2028 applies. Year 2026."""


class TestItemCodeDiff(unittest.TestCase):
    def test_added_removed_and_amended_items(self):
        result = item_codes.diff(BEFORE, AFTER)
        self.assertEqual(result["counts"], {"added": 1, "removed": 1, "amended": 1})
        self.assertEqual([entry["code"] for entry in result["added"]], ["QTFL6131"])
        self.assertEqual([entry["code"] for entry in result["removed"]], ["QTFL6130"])
        amended = result["amended"][0]
        self.assertEqual(amended["code"], "QTFL1917")
        self.assertIn("Securities |", amended["before"])
        self.assertIn("Securities (AFS and HTM)", amended["after"])
        self.assertEqual(result["series"], ["QTFL"])

    def test_ordinary_words_and_numbers_are_not_items(self):
        codes = item_codes.codes_in(BEFORE)
        self.assertEqual(codes, {"QTFL1596", "QTFL1917", "QTFL6130"})
        self.assertFalse(any(code.startswith(("FORM", "JUNE", "YEAR")) for code in codes))

    def test_a_series_needs_a_family_of_items(self):
        self.assertEqual(item_codes.codes_in("See BHCK2170 and BHCK3210 in the instructions."), set())
        self.assertEqual(item_codes.codes_in("BHCK2170 BHCK3210 BHCKC447 are reported."), {"BHCK2170", "BHCK3210", "BHCKC447"})

    def test_a_re_segmented_row_is_not_an_amendment(self):
        resplit = AFTER.replace("| 2 | Positions | Securities (AFS and HTM) |", "| 2 | Positions | Secur | ities (AFS and  HTM) |")
        self.assertEqual(item_codes.diff(AFTER, resplit)["counts"], {"added": 0, "removed": 0, "amended": 0})

    def test_no_items_on_either_side_gives_nothing(self):
        self.assertIsNone(item_codes.diff("Plain prose.", "Other prose."))
        self.assertIsNone(item_codes.summary(item_codes.diff(BEFORE, BEFORE)))

    def test_alert_wording(self):
        text = item_codes.describe(item_codes.summary(item_codes.diff(BEFORE, AFTER)))
        self.assertEqual(text, "1 added, 1 removed, 1 amended (QTFL6131, QTFL6130, QTFL1917)")
        self.assertEqual(item_codes.describe(None), "")

    def test_results_are_capped(self):
        many = "\n".join(f"| {i} | A | Field {i} |  | BHCK{i:04d} |  |" for i in range(1, 700))
        result = item_codes.diff("", many)
        self.assertEqual(len(result["added"]), item_codes.MAX_ENTRIES)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["counts"]["added"], 699)


class TestLineage(unittest.TestCase):
    def test_exact_codes_before_series(self):
        mappings = lineage.validate({"schema_version": 1, "mappings": [
            {"series": ["QTFL"], "assets": ["dbt: fr_2028.positions"]},
            {"codes": ["QTFL1917"], "assets": ["warehouse.securities"], "owner": "Reg reporting"},
        ]})
        self.assertEqual(lineage.assets_for("QTFL1917", mappings), [
            {"asset": "warehouse.securities", "owner": "Reg reporting", "via": "QTFL1917"},
            {"asset": "dbt: fr_2028.positions", "owner": "", "via": "QTFL*"},
        ])
        self.assertEqual(lineage.assets_for("BHCK2170", mappings), [])

    def test_invalid_mappings_are_rejected(self):
        for bad in ({"schema_version": 2, "mappings": []},
                    {"schema_version": 1, "mappings": [{"codes": ["bhck2170"], "assets": ["x"]}]},
                    {"schema_version": 1, "mappings": [{"series": ["QTFL"], "assets": []}]},
                    {"schema_version": 1, "mappings": [{"codes": ["QTFL1917"], "assets": ["x"], "extra": 1}]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                lineage.validate(bad)

    def test_the_shipped_file_is_valid_and_empty(self):
        self.assertEqual(lineage.load(), [])


class TestEngineRecordsItemImpact(unittest.TestCase):
    def test_a_changed_form_carries_its_item_impact_into_evidence_event_and_timeline(self):
        before = ok(BEFORE.encode(), "text/plain")
        after = ok(AFTER.encode(), "text/plain")
        with Sandbox() as box:
            box.scan(lambda *a, **k: before)
            result = box.scan(lambda *a, **k: after)
            event = next(e for e in result["report"]["events"] if e["event_type"] == "CHANGED_URL")
            self.assertEqual(event["item_codes"]["counts"], {"added": 1, "removed": 1, "amended": 1})
            evidence = json.loads((box.root / event["evidence_location"]).read_text())
            self.assertEqual(evidence["item_codes"]["amended"][0]["code"], "QTFL1917")
            item = next(iter(result["inventory"].values()))
            self.assertEqual(item["canonical_url"], URL)
            self.assertEqual(item["change_history"][0]["item_codes"]["codes"][:1], ["QTFL6131"])


if __name__ == "__main__":
    unittest.main()
