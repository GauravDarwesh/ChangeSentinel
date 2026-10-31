"""Pre-flight: the CDR's edit checks, read from a saved taxonomy and run on a filing."""
from __future__ import annotations

import json
import random
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path

from regmon import preflight as F

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
DAY = date(2026, 9, 30)


def taxonomy(form: str = "041", day: str = "2026-09-30", version: str = "301", edits: list[tuple] | None = None) -> str:
    """A saved CDR taxonomy snapshot as the scan writes it: one [FILE] block per linkbase."""
    edits = edits if edits is not None else [
        ("R2145.2223", "ruleType1", "cc:RCON3300[P0] = cc:RCON2170[P0]", "TOTAL LIABILITIES &amp; EQUITY (RC-29) MUST EQUAL TOTAL ASSETS (RC-12)"),
        ("NegQ.RI.1A1B", "ruleType2", "(cc:RIAD4024[P0] &gt;= 0)", "RI-1A1B SHOULD BE NON-NEGATIVE || Amt Reported ="),
    ]
    formulas = "\n".join(f'<ns3:formula select="{formula}" ns2:label="ffiec{form}_{ident}_formula" ns2:role="https://www.cdr.ffiec.gov/xbrl/rule/{role}" ns2:type="resource" />'
                         for ident, role, formula, _ in edits)
    messages = "\n".join(f'<ns0:label ns2:label="ffiec{form}_{ident}_lbl_{n}" ns2:role="https://www.cdr.ffiec.gov/xbrl/rule/ruleMessage1" ns2:type="resource" xml:lang="en">'
                         f"'{message}' &amp; '' &amp; cc:RCON2170[P0]</ns0:label>" for n, (ident, _, _, message) in enumerate(edits))
    name = f"call-report{form}-{day}-v{version}"
    return (f"[FILE] {name}-calc.xml (xml)\n<ns0:linkbase></ns0:linkbase>\n"
            f"[FILE] {name}-ec.xml (xml)\n<ns0:linkbase>\n{formulas}\n</ns0:linkbase>\n"
            f"[FILE] {name}-ec-mess.xml (xml)\n<ns0:linkbase>\n{messages}\n</ns0:linkbase>\n")


def edit(ident: str, formula: str, kind: str = "Validity") -> dict:
    return {"id": ident, "type": kind, "formula": formula, "message": ""}


class EditsFromTextTest(unittest.TestCase):
    def test_reads_rules_types_and_messages(self):
        payload = F.edits_from_text(taxonomy())
        self.assertEqual((payload["form"], payload["date"], payload["version"]), ("FFIEC 041", "2026-09-30", "301"))
        by_id = {row["id"]: row for row in payload["edits"]}
        self.assertEqual(by_id["R2145.2223"]["type"], "Validity")
        self.assertEqual(by_id["NegQ.RI.1A1B"]["type"], "Quality")
        self.assertEqual(by_id["NegQ.RI.1A1B"]["formula"], "(cc:RIAD4024[P0] >= 0)")
        self.assertEqual(by_id["R2145.2223"]["message"], "TOTAL LIABILITIES & EQUITY (RC-29) MUST EQUAL TOTAL ASSETS (RC-12)")
        # What filing software appends after "||" is not part of the message.
        self.assertEqual(by_id["NegQ.RI.1A1B"]["message"], "RI-1A1B SHOULD BE NON-NEGATIVE")

    def test_not_a_taxonomy(self):
        self.assertIsNone(F.edits_from_text("<html>FFIEC</html>"))
        self.assertIsNone(F.edits_from_text(taxonomy(edits=[])))


class FormulaTest(unittest.TestCase):
    def value(self, formula: str, values: dict | None = None):
        return F.evaluate(F.parse(formula), values or {}, DAY)

    def test_numbers_strings_and_operators(self):
        self.assertTrue(self.value("cc:RCON0010[P0] * .0125 = 1.25", {("RCON0010", "2026-09-30"): 100}))
        self.assertTrue(self.value('cc:RCONC752[P0] = "FFIEC041" Or cc:RCONC752[P0] = "FFIEC051"', {("RCONC752", "2026-09-30"): "FFIEC041"}))
        self.assertEqual(self.value('"A" & "B"'), "AB")
        self.assertTrue(self.value("1 + 2 * 3 = 7 and not(1 > 2)"))
        self.assertTrue(self.value("-cc:RIAD4024[P0] < 0", {("RIAD4024", "2026-09-30"): 5}))

    def test_contexts_name_earlier_period_ends(self):
        self.assertEqual(F.shift(DAY, "P0"), DAY)
        self.assertEqual(F.shift(DAY, "-P1Q"), date(2026, 6, 30))
        self.assertEqual(F.shift(date(2026, 3, 31), "-P4Q"), date(2025, 3, 31))
        self.assertEqual(F.shift(date(2024, 5, 31), "-P1Q"), date(2024, 2, 29))
        self.assertEqual(F.shift(date(2026, 3, 31), "-P1Y/-06-end"), date(2025, 6, 30))
        self.assertTrue(self.value("cc:RCON2170[-P1Q] = 7", {("RCON2170", "2026-06-30"): 7}))

    def test_a_missing_value_is_not_evaluated_never_passed(self):
        missing = self.value("cc:RCON2170[P0] > 0")
        self.assertIsInstance(missing, F.Missing)
        self.assertEqual(missing.refs, ("RCON2170[P0]",))
        # And/Or decide without the missing side when the other side settles them.
        self.assertFalse(self.value("1 = 2 And cc:RCON2170[P0] > 0"))
        self.assertTrue(self.value("1 = 1 Or cc:RCON2170[P0] > 0"))
        self.assertIsInstance(self.value("1 = 1 And cc:RCON2170[P0] > 0"), F.Missing)
        self.assertIsInstance(self.value("If(cc:RCON2170[P0] > 0, true, false)"), F.Missing)
        # ExistingOf and ExistsNonEmpty are how the CDR tests for an unreported item.
        self.assertTrue(self.value("ExistingOf(cc:RCON2170[P0], 0) >= 0"))
        self.assertFalse(self.value("ExistsNonEmpty(cc:RCON2170[P0])"))
        self.assertIsInstance(self.value("1 / 0 = 1"), F.Missing)

    def test_dates_and_functions(self):
        self.assertTrue(self.value("MonthOf(Context.Period.EndDate) = 9 and YearOf(Context.Period.EndDate) = 2026"))
        self.assertTrue(self.value("Max(1, 4, 2) = 4 and Min(3, 2) = 2 and Truncate(2.7) = 2 and abs(-3) = 3"))
        self.assertTrue(self.value('len("ABCDE") = 5 and UPPER("ab") = "AB"'))

    def test_check_results(self):
        self.assertEqual(F.check(edit("a", "1 = 1"), {}, DAY)["result"], "pass")
        self.assertEqual(F.check(edit("a", "1 = 2"), {}, DAY)["result"], "fail")
        result = F.check(edit("a", "cc:RCON2170[P0] = 1"), {}, DAY)
        self.assertEqual((result["result"], result["missing"]), ("not_evaluated", ["RCON2170[P0]"]))
        self.assertEqual(F.check(edit("a", "1 = = 2"), {}, DAY)["result"], "error")


class FilingTest(unittest.TestCase):
    XBRL = """<?xml version="1.0"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:cc="http://www.ffiec.gov/xbrl/call/concepts">
  <xbrli:context id="CI_P0"><xbrli:entity/><xbrli:period><xbrli:instant>2026-09-30</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="CI_P1"><xbrli:entity/><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
  <cc:RCON2170 contextRef="CI_P0" unitRef="USD" decimals="0">812400</cc:RCON2170>
  <cc:RCON3300 contextRef="CI_P0" unitRef="USD" decimals="0">812400</cc:RCON3300>
  <cc:RCON2170 contextRef="CI_P1" unitRef="USD" decimals="0">790000</cc:RCON2170>
  <cc:RCONC752 contextRef="CI_P0">FFIEC041</cc:RCONC752>
  <cc:RCON9999 contextRef="CI_P0"></cc:RCON9999>
</xbrli:xbrl>"""
    CSV = "code,value,period\nRCON2170,\"812,400\",2026-09-30\nRCON3300,812400,\nRCON2170,790000,2026-06-30\nRCON9999,,2026-09-30\n"

    def test_xbrl_and_csv_read_the_same(self):
        xbrl, xbrl_day = F.read_filing(self.XBRL.encode())
        self.assertEqual(xbrl_day, DAY)
        self.assertEqual(xbrl[("RCON2170", "2026-06-30")], 790000)
        self.assertEqual(xbrl[("RCONC752", "2026-09-30")], "FFIEC041")
        self.assertNotIn(("RCON9999", "2026-09-30"), xbrl)  # blank: not reported
        csv_values, csv_day = F.read_filing(self.CSV)
        self.assertEqual(csv_day, DAY)
        self.assertEqual(csv_values[("RCON2170", "2026-09-30")], 812400)
        self.assertEqual(csv_values[("RCON3300", "P0")], 812400)  # no period: the report date
        self.assertNotIn(("RCON9999", "2026-09-30"), csv_values)
        run = F.run([edit("R2145", "cc:RCON3300[P0] = cc:RCON2170[P0]"), edit("Q", "cc:RCON2170[P0] >= cc:RCON2170[-P1Q]", "Quality")], csv_values, DAY)
        self.assertEqual(run["counts"], {"Validity": {"pass": 1}, "Quality": {"pass": 1}})

    def test_headerless_csv(self):
        values, day = F.read_filing("RCON2170,5\nRIAD4024,-1\n")
        self.assertIsNone(day)
        self.assertEqual(values, {("RCON2170", "P0"): 5, ("RIAD4024", "P0"): -1})


class CompareTest(unittest.TestCase):
    def test_lists_what_newly_fails_under_the_new_set(self):
        old = [edit("same", "cc:RCON2170[P0] > 0"), edit("changed", "1 = 1"), edit("gone", "1 = 1")]
        new = [edit("same", "cc:RCON2170[P0] > 0"), edit("changed", "cc:RCON2170[P0] > 10"), edit("added", "cc:RCON2170[P0] > 100", "Quality"),
               edit("passes", "1 = 1")]
        result = F.compare(old, new, {("RCON2170", "P0"): 5}, DAY)
        self.assertEqual([(row["id"], row["change"]) for row in result["newly_failing"]], [("changed", "formula changed"), ("added", "new edit")])
        self.assertEqual(result["edits"], {"added": 2, "changed": 1, "removed": 1})
        text = F.to_csv(result, new)
        self.assertIn("changed,Validity,fail,formula changed", text)


class BuildTest(unittest.TestCase):
    def make(self, tmp: Path, snapshots: dict[str, str], history: dict[str, str] | None = None) -> Path:
        data = tmp / "data"
        (data / "snapshots").mkdir(parents=True)
        (data / "evidence").mkdir()
        sources = {}
        for n, (form, text) in enumerate(snapshots.items()):
            location = f"data/snapshots/{form}.txt"
            (tmp / location).write_text(text, encoding="utf-8")
            record = {"canonical_url": f"https://cdr.ffiec.gov/public/{form}", "snapshot_location": location, "change_history": []}
            if history and form in history:
                before = f"data/snapshots/{form}-before.txt"
                (tmp / before).write_text(history[form], encoding="utf-8")
                evidence = f"data/evidence/{form}.json"
                (tmp / evidence).write_text(json.dumps({"before": {"snapshot_location": before}}), encoding="utf-8")
                record["change_history"] = [{"evidence_location": evidence}]
            sources[f"u{n}"] = record
        (data / "latest.json").write_text(json.dumps({"sources": {"cdr": sources}}), encoding="utf-8")
        return data

    def test_one_file_per_edit_set_shared_by_forms_and_earlier_sets_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            older = [("R1", "ruleType1", "1 = 1", "OLD")]
            data = self.make(tmp, {"041": taxonomy("041"), "051": taxonomy("051")}, history={"041": taxonomy("041", "2026-06-30", "300", older)})
            built = F.build(data, now="2026-10-31T00:00:00+00:00")
            self.assertEqual(built["written"], 2)
            files = sorted(path.name for path in (data / "edits").glob("cdr-*.json"))
            self.assertEqual(len(files), 2)
            index = json.loads((data / "edits" / "index.json").read_text())
            self.assertEqual([row["date"] for row in index["forms"]["FFIEC 041"]], ["2026-09-30", "2026-06-30"])
            self.assertEqual(index["forms"]["FFIEC 041"][0]["file"], index["forms"]["FFIEC 051"][0]["file"])
            self.assertEqual(index["forms"]["FFIEC 041"][0]["counts"], {"Quality": 1, "Validity": 1})
            current = json.loads((tmp / index["forms"]["FFIEC 041"][0]["file"]).read_text())
            self.assertEqual(current["forms"], ["FFIEC 041", "FFIEC 051"])
            # A second build changes nothing; the earlier set stays when its snapshot is gone.
            self.assertEqual(F.build(data, now="2026-11-01T00:00:00+00:00")["written"], 0)
            (tmp / "data/snapshots/041-before.txt").unlink()
            F.build(data)
            index = json.loads((data / "edits" / "index.json").read_text())
            self.assertEqual(len(index["forms"]["FFIEC 041"]), 2)
            self.assertEqual(index["updated_at"], "2026-10-31T00:00:00+00:00")
            self.assertEqual(F.validate(data), [])
            (tmp / index["forms"]["FFIEC 041"][1]["file"]).unlink()
            self.assertTrue(any("missing file" in error for error in F.validate(data)))

    def test_the_published_sets_validate(self):
        self.assertEqual(F.validate(ROOT / "data"), [])


class WiringTest(unittest.TestCase):
    def test_scan_validation_ci_and_pages(self):
        engine = (ROOT / "regmon" / "engine.py").read_text()
        self.assertIn("preflight.build(DATA)", engine)
        self.assertIn("preflight.validate(data_dir)", (ROOT / "regmon" / "validate_state.py").read_text())
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        self.assertIn('"data/edits/**"', pages)
        self.assertIn("cp data/edits/*.json site/data/edits/", pages)

    def test_dashboard_offers_the_pre_flight(self):
        js = (ROOT / "dashboard.js").read_text()
        self.assertIn('const keys = ["profile", "preflight"];', js)
        for text in ("Pre-flight a filing", 'data-preflight="file"', "data-preflight-csv", "data-preflight-template", "L.preflightCompare(", "Read in this browser and never uploaded"):
            self.assertIn(text, js)
        self.assertIn(".preflight-controls", (ROOT / "index.html").read_text())


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ParityTest(unittest.TestCase):
    """dashboard-lib.js checks a filing exactly as regmon/preflight.py does."""

    def node(self, payload: dict, body: str):
        script = f"const L = require({json.dumps(str(ROOT / 'dashboard-lib.js'))}); const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));\n{body}"
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "run.js").write_text(script, encoding="utf-8")
            (Path(tmp) / "data.json").write_text(json.dumps(payload), encoding="utf-8")
            out = subprocess.run([NODE, str(Path(tmp) / "run.js"), str(Path(tmp) / "data.json")], capture_output=True, text=True, timeout=120, check=True).stdout
        return json.loads(out)

    def edit_set(self) -> list[dict]:
        index = ROOT / "data" / "edits" / "index.json"
        if index.exists():
            forms = json.loads(index.read_text())["forms"]
            if forms:
                first = next(iter(forms.values()))[0]["file"]
                return json.loads((ROOT / first).read_text())["edits"]
        payload = F.edits_from_text(taxonomy())
        return payload["edits"]

    def test_every_published_formula_with_random_values(self):
        edits = self.edit_set()
        refs = sorted({(code.upper(), ctx) for row in edits for code, ctx in re.findall(r"cc:([A-Za-z0-9]+)\[([^\]]+)\]", row["formula"])})
        cases = []
        for seed in range(3):
            rnd = random.Random(seed)
            values = {}
            for code, ctx in refs:
                if rnd.random() < 0.2 * seed:
                    continue
                pick = rnd.random()
                values[(code, (F.shift(DAY, ctx) or DAY).isoformat())] = (0 if pick < 0.4 else rnd.choice([1, -5, 250, 1000.5, "FFIEC041", "Y", 3]) if pick < 0.6
                                                                        else rnd.randint(-1000, 100000))
            expected = [F.check(row, values, DAY) for row in edits]
            cases.append({"values": {f"{code}|{period}": value for (code, period), value in values.items()}, "expected": expected})
        mismatches = self.node({"edits": edits, "cases": cases}, """
const bad = [];
d.cases.forEach(c => d.edits.forEach((e, k) => { const a = L.preflightCheck(e, c.values, '2026-09-30'), b = c.expected[k];
  if (a.result !== b.result || (a.result === 'not_evaluated' && JSON.stringify(a.missing) !== JSON.stringify(b.missing))) bad.push([e.id, a.result, b.result]); }));
console.log(JSON.stringify(bad.slice(0, 10)));""")
        self.assertEqual(mismatches, [])

    def test_filings_runs_and_comparisons(self):
        old = [edit("same", "cc:RCON2170[P0] > 0"), edit("changed", "1 = 1")]
        new = [edit("same", "cc:RCON2170[P0] > 0"), edit("changed", "cc:RCON2170[P0] > cc:RCON2170[-P1Q]"), edit("added", "cc:RCON3300[P0] = 1", "Quality")]
        out = self.node({"xbrl": FilingTest.XBRL, "csv": FilingTest.CSV, "old": old, "new": new}, """
const x = L.preflightReadFiling(d.xbrl), c = L.preflightReadFiling(d.csv);
console.log(JSON.stringify({ x, c, cmp: L.preflightCompare(d.old, d.new, c.values, c.reportDate) }));""")
        for name, content in (("x", FilingTest.XBRL), ("c", FilingTest.CSV)):
            values, day = F.read_filing(content)
            self.assertEqual(out[name]["reportDate"], day.isoformat())
            self.assertEqual(out[name]["values"], {f"{code}|{period}": value for (code, period), value in values.items()})
        values, day = F.read_filing(FilingTest.CSV)
        expected = F.compare(old, new, values, day)
        self.assertEqual(out["cmp"]["counts"], expected["counts"])
        self.assertEqual(out["cmp"]["edits"], expected["edits"])
        self.assertEqual([row["id"] for row in out["cmp"]["newly_failing"]], [row["id"] for row in expected["newly_failing"]])


if __name__ == "__main__":
    unittest.main()
