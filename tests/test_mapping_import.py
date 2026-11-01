"""Mapping import (Phase 4.1): a code → consumer spreadsheet from the dashboard in one request.

The dashboard reads the file in the browser with L.registryMappingRequest, the
same function as regmon.registry.mapping_request, and sends the result as one
registry-update issue. A request too long for a prefilled link travels packed
(raw deflate + base64, with its SHA-256), so a 500-row mapping is one request.
"""
from __future__ import annotations

import csv
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from regmon import find_consumers as D
from regmon import registry as R

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

MESSY = (
    "﻿Item Code,Form,Schedule,Line,Description,Used by,Kind,Owner,Repository,Path,System,Scheme\n"
    "BHCK2170,FR Y-9C,HC,12,Total assets,GL warehouse; Capital model,table,Finance Data,acme/regrep,sql/gl.sql,Teradata,\n"
    "BHCK2170,FR Y-9C,,,,  Capital model ,model,,,,,\n"
    "BHCK3210,FR Y-9C,HC,27a,,GL warehouse,,,,,,\n"
    ",,,,,,,,,,,\n"
    ",FR Y-9C,HC,1,no code here,GL warehouse,,,,,,\n"
    "BHCK3210,FR Y-9C,,,Total equity capital,,,,,,,\n"
    "RCON2170,FFIEC 041,RC,12,Total assets,  _Call   report load ,pipeline,Reg Reporting,,,Airflow,\n"
    "RCON2170,FFIEC 031,RC,12,Total assets,,,Reg Reporting,,,,\n"
    "F_01.01_r380,FINREP,F 01.01,380,Total assets,EBA export,,,,,,DPM\n"
    "X1,Form,,,,Some table,,,,,,Made Up\n"
    "BHCK0010,FR Y-9C,HC,1,Cash,Bad repo,,,not a repo,,,\n"
    "ZQXA1001,,,,,,,,,,,\n"
)


def rows_of(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text)))


def run_node(script: str) -> object:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
        handle.write(f"const L = require({json.dumps(str(ROOT / 'dashboard-lib.js'))});\n(async () => {{ {script} }})().catch(e => {{ console.error(e); process.exit(1); }});")
    try:
        return json.loads(subprocess.run([NODE, handle.name], capture_output=True, text=True, timeout=60, check=True).stdout)
    finally:
        Path(handle.name).unlink()


class MappingRequestTest(unittest.TestCase):
    def test_messy_sheet(self):
        request, report = R.mapping_request(rows_of(MESSY))
        self.assertEqual(report["rows"], 11)  # blank rows are not counted
        self.assertEqual(report["skipped"], 1)  # the row with no code
        self.assertEqual(len(report["errors"]), 2)
        self.assertIn("Row 11: scheme MADEUP is not known", report["errors"][0])
        self.assertIn("Row 12: repository 'not a repo'", report["errors"][1])
        items = {(item["code"], item.get("form", "")): item for item in request["items"]}
        y9c = items[("BHCK2170", "FR Y-9C")]
        self.assertEqual(y9c["consumers"], ["GL-warehouse", "Capital-model"])
        self.assertEqual((y9c["schedule"], y9c["line"], y9c["label"]), ("HC", "12", "Total assets"))
        self.assertEqual(items[("BHCK3210", "FR Y-9C")]["label"], "Total equity capital")  # filled from a later row
        self.assertEqual(items[("RCON2170", "FFIEC 031")]["owner"], "Reg Reporting")  # no consumer: the owner is the item's
        self.assertNotIn("owner", items[("RCON2170", "FFIEC 041")])  # with a consumer: the owner is the consumer's
        self.assertEqual(items[("F_01.01_r380", "FINREP")]["scheme"], "DPM")
        self.assertEqual(items[("ZQXA1001", "")]["scheme"], "MDRM")
        consumers = {consumer["id"]: consumer for consumer in request["consumers"]}
        self.assertEqual(consumers["GL-warehouse"], {"id": "GL-warehouse", "kind": "table", "name": "GL warehouse", "owner": "Finance Data",
                                                     "system": "Teradata", "repo": "acme/regrep", "path": "sql/gl.sql"})
        self.assertEqual(consumers["Capital-model"]["kind"], "table")  # the first row with a kind decides
        self.assertEqual(consumers["Call-report-load"], {"id": "Call-report-load", "kind": "pipeline", "name": "_Call report load", "owner": "Reg Reporting", "system": "Airflow"})
        self.assertEqual(consumers["EBA-export"]["kind"], "table")

    def test_existing_consumers_keep_their_kind_unless_the_sheet_says(self):
        request, _ = R.mapping_request(rows_of("code,consumer\nBHCK2170,GL warehouse\n"), existing_consumers={"GL-warehouse"})
        self.assertEqual(request["consumers"], [{"id": "GL-warehouse", "name": "GL warehouse"}])

    def test_no_code_column_and_wide_items(self):
        _, report = R.mapping_request(rows_of("Name,Owner\nx,y\n"))
        self.assertIn("No code column", report["errors"][0])
        wide = "code,consumer\n" + "".join(f"BHCK2170,c{n}\n" for n in range(61))
        _, report = R.mapping_request(rows_of(wide))
        self.assertIn("at most 60", report["errors"][0])

    def test_import_csv_upserts_and_is_idempotent(self):
        current = {"schema_version": 1, "consumers": [{"id": "GL-warehouse", "kind": "view", "name": "GL warehouse"}], "items": []}
        ok = "\n".join(line for line in MESSY.splitlines() if "Made Up" not in line and "not a repo" not in line) + "\n"
        merged, counts = R.import_rows(rows_of(ok), current)
        self.assertEqual(counts["items_added"], 6)
        self.assertEqual(counts["consumers_added"], 3)
        self.assertEqual(counts["consumers_updated"], 1)
        gl = next(consumer for consumer in merged["consumers"] if consumer["id"] == "GL-warehouse")
        self.assertEqual(gl["kind"], "table")  # the sheet states it
        again, counts = R.import_rows(rows_of(ok), merged)
        self.assertEqual(again, merged)
        self.assertEqual((counts["items_added"], counts["items_updated"], counts["consumers_updated"]), (0, 0, 0))
        with self.assertRaisesRegex(ValueError, "scheme MADEUP"):
            R.import_rows(rows_of(MESSY), current)

    def test_cli_reads_xlsx(self):
        from openpyxl import Workbook

        with tempfile.TemporaryDirectory() as tmp:
            book = Workbook()
            sheet = book.active
            for row in rows_of(MESSY)[:4]:
                sheet.append([int(cell) if cell.isdigit() else cell for cell in row])
            book.save(Path(tmp) / "mapping.xlsx")
            registry_path = Path(tmp) / "registry.json"
            registry_path.write_text('{"schema_version": 1}\n')
            self.assertEqual(R.main(["import", str(Path(tmp) / "mapping.xlsx"), "--path", str(registry_path), "--write"]), 0)
            written = json.loads(registry_path.read_text())
            self.assertEqual([item["line"] for item in written["items"]], ["12", "27a"])


class PackedRequestTest(unittest.TestCase):
    def body(self, block: str, sha: str = "") -> str:
        return "\n".join([R.REQUEST_MARKER, "", "Summary: test", f"Request SHA-256: {sha}" if sha else "", "", "```packed", block, "```"])

    def test_round_trip_and_damage(self):
        import base64
        import hashlib
        import zlib

        text = json.dumps({"version": 1, "items": [{"code": "BHCK2170"}]})
        deflater = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = base64.b64encode(deflater.compress(text.encode()) + deflater.flush()).decode()
        sha = hashlib.sha256(text.encode()).hexdigest()
        self.assertEqual(R.parse_request_body(self.body(packed, sha))["items"], [{"code": "BHCK2170"}])
        self.assertEqual(R.parse_request_body(self.body("\n".join(packed[i:i + 10] for i in range(0, len(packed), 10)))), json.loads(text))
        with self.assertRaisesRegex(R.RequestError, "SHA-256"):
            R.parse_request_body(self.body(packed, "0" * 64))
        with self.assertRaisesRegex(R.RequestError, "cut short|does not decode"):
            R.parse_request_body(self.body(packed[: len(packed) // 2 // 4 * 4], sha))
        with self.assertRaisesRegex(R.RequestError, "does not decode"):
            R.parse_request_body(self.body("not base64 at all!"))
        bomb = zlib.compressobj(9, zlib.DEFLATED, -15)
        big = base64.b64encode(bomb.compress(b" " * (R.PACKED_LIMIT + 10)) + bomb.flush()).decode()
        with self.assertRaisesRegex(R.RequestError, "larger than 8 MB"):
            R.parse_request_body(self.body(big))


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ParityTest(unittest.TestCase):
    def js_requests(self, sheets: list[list[list[str]]], existing: list[str]) -> list:
        return run_node(f"const sheets = {json.dumps(sheets)};"
                        f"console.log(JSON.stringify(sheets.map(m => L.registryMappingRequest(m, {{ existingConsumers: {json.dumps(existing)}, knownSchemes: ['SUCAVE'] }}))));")

    def test_same_request_and_report_as_python(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "sql").mkdir()
            (repo / "sql" / "hc.sql").write_text("create table reg.hc (bhck2170 numeric, BHCK3210 numeric);\nselect rcon2170 from x;\n")
            (repo / "checks.py").write_text("assert row['RCON2170'] >= row['RCON3210']\n")
            found = D.to_csv(D.scan([repo]), repo="acme/regrep")
        sheets = [rows_of(MESSY), rows_of(found), rows_of("Name,Owner\nx,y\n"), [], rows_of("code\n" + "\n".join(f"BHCK{n:04d}" for n in range(500)))]
        existing = ["GL-warehouse"]
        js = self.js_requests(sheets, existing)
        for index, sheet in enumerate(sheets):
            request, report = R.mapping_request(sheet, known_schemes={"SUCAVE"}, existing_consumers=set(existing))
            with self.subTest(sheet=index):
                self.assertEqual(js[index]["request"], request)
                self.assertEqual(js[index]["report"], report)

    def test_xlsx_read_in_the_browser_matches_openpyxl(self):
        from openpyxl import Workbook

        with tempfile.TemporaryDirectory() as tmp:
            book = Workbook()
            sheet = book.active
            for row in rows_of(MESSY):
                sheet.append([int(cell) if cell.isdigit() else cell for cell in row])
            path = Path(tmp) / "m.xlsx"
            book.save(path)
            js = run_node(f"const fs = require('fs'); const m = await L.xlsxFirstSheetRows(fs.readFileSync({json.dumps(str(path))}));"
                          "console.log(JSON.stringify(L.registryMappingRequest(m, {})));")
            request, report = R.mapping_request(R.read_mapping_file(path))
        self.assertEqual(js["request"], request)
        self.assertEqual(js["report"], report)

    def test_a_500_row_mapping_is_one_request_the_workflow_applies(self):
        lines = ["code,form,schedule,line,consumer,kind,owner,path"]
        for n in range(500):
            lines.append(f"BHCK{1000 + n * 7:04d},FR Y-9C,HC-{'ABCDEFGH'[n % 8]},{n % 40 + 1},{['GL warehouse', 'Capital model', 'Y-9C load', 'Liquidity mart'][n % 4]},"
                         f"{['table', 'model', 'pipeline', 'view'][n % 4]},Reg Reporting,{['sql/gl.sql', 'models/cap.py', 'dags/y9c.py', 'sql/liq.sql'][n % 4]}")
        sheet = rows_of("\n".join(lines) + "\n")
        out = run_node(f"const m = {json.dumps(sheet)}; const r = L.registryMappingRequest(m, {{ summary: 'Mapping import: big.csv (500 rows)' }});"
                       "const json = JSON.stringify(r.request); const packed = await L.packRequest(json); const sha = await L.sha256Hex(json);"
                       "const plain = L.registryRequestBody(r.request); const body = L.registryRequestBody(r.request, packed, sha);"
                       "console.log(JSON.stringify({ body, plain: plain.length, packed: body.length, title: L.REGISTRY_REQUEST_TITLE, report: r.report }));")
        self.assertEqual(out["report"]["items"], 500)
        self.assertLess(out["packed"], out["plain"] / 4)
        self.assertLess(out["packed"], 7000)  # fits a prefilled link with room to spare
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            (root / "config" / "registry.json").write_text('{"schema_version": 1}\n')
            event = {"issue": {"user": {"login": "o"}, "title": out["title"] + ": Mapping import", "body": out["body"]}, "repository": {"owner": {"login": "o"}}}
            result = R.apply_event(event, root=root)
            self.assertEqual(result["items_added"], 500)
            self.assertEqual(result["consumers_added"], 4)
            written = json.loads((root / "config" / "registry.json").read_text())
            self.assertEqual(written, R.import_rows(sheet, {"schema_version": 1}, root=root)[0])


class DashboardTest(unittest.TestCase):
    def test_registry_offers_the_import(self):
        html = (ROOT / "index.html").read_text()
        js = (ROOT / "dashboard.js").read_text()
        self.assertIn('id="registryImportDialog"', html)
        self.assertIn('id="importRegistryBtn"', html)
        self.assertIn("L.registryMappingRequest(", js)
        self.assertIn("L.packRequest(", js)


if __name__ == "__main__":
    unittest.main()
