"""Consumer discovery: the regulatory items a repository's own code reads, as registry rows."""
from __future__ import annotations

import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from regmon import find_consumers as D
from regmon import registry

ROOT = Path(__file__).resolve().parent.parent

FILES = {
    "models/marts/call_report_rc.sql": "select sum(amount) as rcon2170,  -- total assets\n  RCON_2948, rcon3210 as equity, rate_2024\nfrom {{ ref('gl') }}\n",
    "src/ddl.sql": 'create table if not exists reg.fry9c_hc ("BHCK2170" numeric, bhck3210 numeric);\n'
                   "CREATE OR REPLACE VIEW reg.v_hc AS SELECT BHCK2170 AS assets FROM reg.fry9c_hc;\n",
    "src/validation/checks.py": "def check(row):\n    return row['RCON2170'] == row['RCON2948'] + row['RCON3210']\nFILE_2024 = 1\nhash_sha1 = 2\n",
    "dags/call_report.yaml": "tasks: [{fields: [RCFD2170, RCFD3210]}]\n",
    "src/load.py": "COLUMNS = ['ZQXA1001', 'ZQXA1002', 'ZQXA1003']\n",
    "docs/notes.md": "RCON2170 is total assets\n",
    "node_modules/x/a.js": "rcon2170\n",
    "bin/blob.sql": "\0\0RCON2170",
}


class DiscoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        for name, text in FILES.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def rows(self, **kwargs):
        result = D.scan([self.repo], **kwargs)
        return result, {(row["code"], row["consumer"]): row for row in result["rows"]}

    def test_finds_items_in_any_case_and_names_the_consumer(self):
        result, rows = self.rows()
        self.assertEqual(rows[("RCON2170", "call_report_rc")]["kind"], "table")  # a dbt model
        self.assertIn(("RCON2948", "call_report_rc"), rows)  # rcon_2948
        self.assertEqual(rows[("BHCK2170", "reg.fry9c_hc")]["kind"], "table")
        self.assertEqual(rows[("BHCK2170", "reg.v_hc")]["kind"], "view")
        self.assertEqual(rows[("BHCK2170", "reg.v_hc")]["path"], "src/ddl.sql:2")
        self.assertEqual(rows[("RCON2170", "src/validation/checks.py")]["kind"], "check")
        self.assertEqual(rows[("RCFD2170", "dags/call_report.yaml")]["kind"], "pipeline")
        # Words, docs, vendored code, binaries and series nobody knows are not consumers.
        consumers = {row["consumer"] for row in result["rows"]}
        self.assertFalse(any(name.startswith(("docs/", "node_modules/", "bin/")) for name in consumers))
        self.assertFalse(any(row["code"].startswith(("RATE", "FILE", "HASH", "ZQXA")) for row in result["rows"]))
        self.assertEqual(rows[("BHCK2170", "reg.fry9c_hc")]["form"], "FR Y-9C")

    def test_all_series_accepts_a_family_of_unknown_codes(self):
        _, rows = self.rows(all_series=True)
        self.assertEqual(rows[("ZQXA1001", "src/load.py")]["known"], "pattern")

    def test_rows_import_into_the_registry_and_a_second_run_finds_nothing_new(self):
        current = json.loads((ROOT / "config" / "registry.json").read_text())
        result = D.scan([self.repo], registry_payload=current)
        text = D.to_csv(result, "bank/warehouse")
        header = next(csv.reader(io.StringIO(text)))
        self.assertNotIn("table", header)  # the import reads "table" as the schedule
        self.assertNotIn("name", header)  # and "name" as the label
        merged = registry.import_csv(text, current)
        registry.validate(merged)
        consumer = next(c for c in merged["consumers"] if c["id"] == "reg.v_hc")
        self.assertEqual((consumer["kind"], consumer["repo"], consumer["path"]), ("view", "bank/warehouse", "src/ddl.sql:2"))
        again = D.scan([self.repo], registry_payload=merged)
        self.assertEqual(again["new_links"], 0)
        self.assertEqual(again["unregistered"], 0)

    def test_cli_writes_a_csv_and_merges(self):
        out = Path(self.tmp.name) / "mapping.csv"
        target = Path(self.tmp.name) / "registry.json"
        target.write_text((ROOT / "config" / "registry.json").read_text())
        self.assertEqual(D.main([str(self.repo), "--out", str(out)]), 0)
        self.assertTrue(out.read_text().startswith("code,scheme,form,label,consumer,consumer kind"))
        self.assertEqual(D.main([str(self.repo), "--merge", "--registry", str(target)]), 0)
        self.assertTrue(any(c["id"] == "reg.fry9c_hc" for c in json.loads(target.read_text())["consumers"]))
        self.assertEqual(D.main([str(self.repo / "missing")]), 2)


if __name__ == "__main__":
    unittest.main()
