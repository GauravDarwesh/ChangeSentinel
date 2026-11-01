"""CONNECT (Phase 4.2-4.3): the team's own checks against the regulator's edit checks."""
from __future__ import annotations

import csv
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from regmon import applicability as A
from regmon import controls as K
from regmon import registry as R

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

SPEC = {"spec_diff": {"tables": [
    {"kind": "rules", "changes": [
        {"category": "retired", "id": "R-1", "quarter": "Q1 2027"},
        {"category": "removed", "id": "R-2"},
        {"category": "removed", "id": "R-3", "note": "Still present as R-3 v2"},
        {"category": "logic", "also": ["message"], "id": "R-4", "level": "blocking", "quarter": "Q1 2027"},
        {"category": "message", "also": ["severity"], "id": "R-5"},
        {"category": "added", "id": "R-6", "quarter": "Q1 2027"},
        {"category": "description", "id": "R-7"},
        {"category": "added", "key": "no-id"},
    ]},
    {"kind": "fields", "changes": [{"category": "removed", "id": "F-1"}]},
]}}

REGISTRY = {"schema_version": 1, "consumers": [
    {"id": "suite", "kind": "check", "name": "BCAR suite", "implements": ["OSFI BCAR | R-1", "OSFI BCAR | R-4", "R-5", "OSFI BCAR | R-99"]},
    {"id": "legacy", "kind": "check", "name": "Legacy checks", "implements": ["OSFI BCAR | R-2", "FR Y-9C | R-4"]},
    {"id": "gl", "kind": "table", "name": "GL"}]}

INDEX = {"forms": {"OSFI BCAR": {"ids": ["R-1", "R-2", "R-4", "R-5", "R-6"], "count": 5, "sources": ["fixture"]}}}


def facts(forms=("OSFI BCAR",), rules=None):
    return {"forms": [{"form": form, "basis": ["monitor"]} for form in forms], "rules": K.rule_changes(SPEC) if rules is None else rules}


def run_node(script: str):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
        handle.write(f"const L = require({json.dumps(str(ROOT / 'dashboard-lib.js'))});\n{script}")
    try:
        return json.loads(subprocess.run([NODE, handle.name], capture_output=True, text=True, timeout=60, check=True).stdout)
    finally:
        Path(handle.name).unlink()


class RuleChangesTest(unittest.TestCase):
    def test_rules_a_spec_diff_added_retired_or_changed(self):
        self.assertEqual(K.rule_changes(SPEC), [["R-1", "retired", "", "Q1 2027"], ["R-2", "removed", "", ""], ["R-4", "logic", "blocking", "Q1 2027"],
                                                 ["R-5", "severity", "", ""], ["R-6", "added", "", "Q1 2027"]])
        self.assertEqual(K.rule_changes({}), [])

    def test_event_facts_carry_them(self):
        library = A.load_library()
        entry = {"event_type": "NEW_URL", "timestamp": "2026-10-30T00:00:00+00:00"}
        out = A.event_facts(entry, {"canonical_url": "https://x/bcar.xlsx"}, {"id": "s", "name": "OSFI BCAR technical specification"}, SPEC, library, [])
        self.assertEqual(out["rules"][0], ["R-1", "retired", "", "Q1 2027"])
        self.assertEqual(A.FACTS_VERSION, "facts-4")


class FindingsTest(unittest.TestCase):
    def test_every_finding(self):
        result = K.findings(facts(), REGISTRY, INDEX)
        self.assertEqual(result["counts"], {"retired_in_use": 2, "differs": 2, "missing": 1, "extra": 1})
        self.assertEqual([(row["id"], row["consumers"]) for row in result["retired_in_use"]], [("R-1", ["suite"]), ("R-2", ["legacy"])])
        self.assertEqual([(row["id"], row["change"], row["consumers"]) for row in result["differs"]], [("R-4", "logic", ["suite"]), ("R-5", "severity", ["suite"])])
        self.assertEqual(result["missing"], [{"id": "R-6", "change": "added", "level": "", "quarter": "Q1 2027"}])
        self.assertEqual(result["extra"], [{"id": "R-99", "form": "OSFI BCAR", "consumers": ["suite"]}])
        self.assertEqual((result["tracked"], result["checked"], result["consumers"]), (["OSFI BCAR"], ["OSFI BCAR"], ["legacy", "suite"]))
        self.assertEqual(K.summary(result), "Your checks: 2 retired rules still implemented; 2 rules you implement changed; 1 new rule with no check; 1 implemented rule not in the current spec")

    def test_form_scope(self):
        # FR Y-9C's R-4 is another rule: a Y-9C change touches only the "FR Y-9C | R-4" and unscoped R-5 entries.
        result = K.findings(facts(forms=("FR Y-9C",)), REGISTRY, INDEX)
        self.assertEqual([(row["id"], row["consumers"]) for row in result["differs"]], [("R-4", ["legacy"]), ("R-5", ["suite"])])
        self.assertEqual(result["retired_in_use"], [])
        self.assertEqual(result["missing"], [{"id": "R-6", "change": "added", "level": "", "quarter": "Q1 2027"}])  # tracked: "FR Y-9C | R-4"
        self.assertEqual(result["extra"], [])  # FR Y-9C is not in the index

    def test_quiet_when_it_says_nothing(self):
        self.assertIsNone(K.findings(facts(), {"schema_version": 1, "consumers": [{"id": "gl", "kind": "table"}]}, INDEX))  # nothing implemented
        self.assertIsNone(K.findings(facts(rules=[]), REGISTRY, INDEX))  # a page edit on a tracked form
        self.assertIsNone(K.findings(facts(forms=("FFIEC 031",), rules=[["X-1", "added", "", ""]]), REGISTRY, INDEX))  # untracked form, no hit
        up_to_date = K.findings(facts(rules=[["R-77", "message", "", ""], ["R-1", "added_version", "", ""]]), REGISTRY, {"forms": {}})
        self.assertEqual(up_to_date["counts"], {"retired_in_use": 0, "differs": 0, "missing": 0, "extra": 0})
        self.assertEqual(K.summary(up_to_date), "")

    def test_consumer_extras(self):
        self.assertEqual(K.consumer_extras(REGISTRY["consumers"][0], INDEX), [{"id": "R-99", "form": "OSFI BCAR"}])
        self.assertEqual(K.consumer_extras(REGISTRY["consumers"][1], INDEX), [])


class RegistryTest(unittest.TestCase):
    def test_validate_and_merge_implements(self):
        validated = R.validate(REGISTRY)
        self.assertEqual(validated["consumers"]["suite"]["implements"], ["OSFI BCAR | R-1", "OSFI BCAR | R-4", "R-5", "OSFI BCAR | R-99"])
        with self.assertRaisesRegex(ValueError, "edit ID after the form"):
            R.validate({"schema_version": 1, "consumers": [{"id": "c", "implements": ["FR Y-9C |"]}]})
        with self.assertRaisesRegex(ValueError, "implements must be a list"):
            R.validate({"schema_version": 1, "consumers": [{"id": "c", "implements": "R-1"}]})
        merged, counts = R.apply_request(REGISTRY, {"version": 1, "consumers": [
            {"id": "suite", "implements": ["OSFI BCAR | R-6", "R-5"], "remove_implements": ["OSFI BCAR | R-99"]},
            {"id": "new", "kind": "check", "name": "New", "implements": ["FR Y-9C | 0303", "FR Y-9C  |  0303"]}]}, templates=[])
        suite = next(consumer for consumer in merged["consumers"] if consumer["id"] == "suite")
        self.assertEqual(suite["implements"], ["OSFI BCAR | R-1", "OSFI BCAR | R-4", "R-5", "OSFI BCAR | R-6"])
        self.assertEqual(next(consumer for consumer in merged["consumers"] if consumer["id"] == "new")["implements"], ["FR Y-9C | 0303", "FR Y-9C | 0303"][:1])
        self.assertEqual((counts["consumers_updated"], counts["consumers_added"]), (1, 1))

    def test_mapping_import_reads_an_implements_column(self):
        sheet = list(csv.reader(io.StringIO(
            "Check,Form,Edit check,Owner\n"
            "BCAR suite,OSFI BCAR,R-1; R-4,Controls\n"
            "BCAR suite,,FR Y-9C | 0303,\n"
            "Y-9C suite,FR Y-9C,0303\n")))
        request, report = R.mapping_request(sheet)
        self.assertEqual(report["errors"], [])
        self.assertEqual((report["used"], report["implements"], report["items"]), (3, 4, 0))
        self.assertEqual(request["consumers"], [
            {"id": "BCAR-suite", "kind": "check", "name": "BCAR suite", "owner": "Controls", "implements": ["OSFI BCAR | R-1", "OSFI BCAR | R-4", "FR Y-9C | 0303"]},
            {"id": "Y-9C-suite", "kind": "check", "name": "Y-9C suite", "implements": ["FR Y-9C | 0303"]}])
        merged, _ = R.import_rows(sheet, {"schema_version": 1})
        self.assertEqual(R.validate(merged)["consumers"]["BCAR-suite"]["implements"][2], "FR Y-9C | 0303")


class IndexTest(unittest.TestCase):
    def test_index_from_cdr_edits_and_pdf_checklists(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            (data / "edits").mkdir(parents=True)
            (data / "rule-tables").mkdir()
            (data / "edits" / "old.json").write_text(json.dumps({"edits": [{"id": "Old.1"}]}))
            (data / "edits" / "new.json").write_text(json.dumps({"edits": [{"id": "Neg.RIB.Part2"}, {"id": "Q-1"}]}))
            (data / "edits" / "index.json").write_text(json.dumps({"forms": {"FFIEC 031": [
                {"date": "2026-06-30", "version": "300", "file": "data/edits/old.json"}, {"date": "2026-09-30", "version": "301", "file": "data/edits/new.json"}]}}))
            (data / "rule-tables" / "abc-1.json").write_text(json.dumps({"rows": [{"id": "0303", "series": "FRY9C"}, {"id": "0304", "series": "FRY9C"}, {"id": "", "series": "FRY9C"}]}))
            (data / "latest.json").write_text(json.dumps({"sources": {"s": {"abc": {"canonical_url": "https://www.federalreserve.gov/x.pdf",
                                                                                    "rule_tables": {"rule_tables_location": "data/rule-tables/abc-1.json"}}}}}))
            config = Path(tmp) / "config"
            config.mkdir()
            shutil.copy(ROOT / "config" / "reports.json", config / "reports.json")
            (config / "sources.json").write_text(json.dumps({"sources": [{"id": "s", "name": "Pilot (Exact URL Allowlist)"}]}))
            self.assertEqual(K.write(data, config), {"forms": 2, "written": True})
            self.assertEqual(K.write(data, config)["written"], False)
            index = K.load_index(data)
            self.assertEqual(index["forms"]["FFIEC 031"]["ids"], ["NEG.RIB.PART2", "Q-1"])
            self.assertEqual(index["forms"]["FR Y-9C"]["ids"], ["0303", "0304"])
            self.assertEqual(K.validate(data), [])

    def test_real_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            for name in ("latest.json",):
                shutil.copy(ROOT / "data" / name, data / name)
            for folder in ("edits", "rule-tables"):
                shutil.copytree(ROOT / "data" / folder, data / folder)
            K.write(data, ROOT / "config")
            forms = K.load_index(data)["forms"]
            for form in ("FFIEC 031", "FFIEC 041", "FFIEC 051", "FR Y-9C"):
                with self.subTest(form=form):
                    self.assertGreater(forms[form]["count"], 1000)
        evidence = next(json.loads(path.read_text()) for path in sorted((ROOT / "data" / "evidence").glob("99420995*.json")))
        rules = K.rule_changes(evidence)
        self.assertGreaterEqual(len(rules), 50)  # OSFI BCAR v4.1: 38 logic changes, retired and removed rules, 1 new rule
        self.assertTrue({row[1] for row in rules} >= {"logic", "added"})


class WiringTest(unittest.TestCase):
    def test_scan_pages_state_and_dashboard(self):
        engine = (ROOT / "regmon" / "engine.py").read_text()
        self.assertLess(engine.index("applicability.write(DATA"), engine.index("controls.write(DATA"))
        self.assertLess(engine.index("preflight.build(DATA)"), engine.index("controls.write(DATA"))
        self.assertIn("data/rule-index.json", (ROOT / ".github" / "workflows" / "pages.yml").read_text())
        self.assertIn("controls.validate(data_dir)", (ROOT / "regmon" / "validate_state.py").read_text())
        js = (ROOT / "dashboard.js").read_text()
        for needle in ("L.controlFindings(", "controlsSheet(entry)", "consumerControlsSheet(consumer)", "registryConsumerImplements"):
            self.assertIn(needle, js)
        self.assertIn('id="registryConsumerImplements"', (ROOT / "index.html").read_text())


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ParityTest(unittest.TestCase):
    def test_dashboard_gives_the_same_findings(self):
        cases = [facts(), facts(forms=("FR Y-9C",)), facts(rules=[]), facts(forms=("FFIEC 031",), rules=[["X-1", "added", "", ""]]),
                 facts(forms=("OSFI BCAR", "FR Y-9C")), facts(rules=[["R-77", "message", "", ""], ["R-1", "added_version", "", ""]])]
        evidence = next(json.loads(path.read_text()) for path in sorted((ROOT / "data" / "evidence").glob("99420995*.json")))
        real = K.rule_changes(evidence)
        registry = {"schema_version": 1, "consumers": REGISTRY["consumers"] + [
            {"id": "osfi", "kind": "check", "name": "OSFI library", "implements": ["OSFI BCAR | " + row[0] for row in real[::3]] + ["OSFI BCAR | NOT-A-RULE"]}]}
        cases.append({"forms": [{"form": "OSFI BCAR", "basis": ["monitor"]}], "rules": real})
        out = run_node(f"const model = L.registryModel({json.dumps(registry)}, null); const index = {json.dumps(INDEX)};"
                       f"const cases = {json.dumps(cases)};"
                       "const results = cases.map(f => L.controlFindings(f, model, index));"
                       "console.log(JSON.stringify({ results, summaries: results.map(L.controlSummary),"
                       " extras: model.consumers.size && Array.from(model.consumers.values()).map(c => L.controlConsumerExtras(c, index)) }));")
        for index, case in enumerate(cases):
            with self.subTest(case=index):
                expected = K.findings(case, registry, INDEX)
                self.assertEqual(out["results"][index], expected)
                self.assertEqual(out["summaries"][index], K.summary(expected))
        self.assertEqual(out["extras"], [K.consumer_extras(consumer, INDEX) for consumer in registry["consumers"]])
        self.assertTrue(out["results"][-1]["counts"]["differs"] > 0)

    def test_import_with_implements_matches_python(self):
        sheet = list(csv.reader(io.StringIO("Check,Form,Edit check,Owner,Code\nBCAR suite,OSFI BCAR,R-1; R-4,Controls,\nGL,FR Y-9C,,Finance,BHCK2170\n"
                                            "Y-9C suite,FR Y-9C,0303,,BHCK2170\n,FR Y-9C,0304,,\n")))
        out = run_node(f"console.log(JSON.stringify(L.registryMappingRequest({json.dumps(sheet)}, {{}})));")
        request, report = R.mapping_request(sheet)
        self.assertEqual(out["request"], request)
        self.assertEqual(out["report"], report)


if __name__ == "__main__":
    unittest.main()


class AlertTest(unittest.TestCase):
    def test_alerts_name_what_a_change_means_for_your_checks(self):
        from regmon import channels, notify

        with tempfile.TemporaryDirectory() as tmp:
            data, config = Path(tmp) / "data", Path(tmp) / "config"
            data.mkdir()
            config.mkdir()
            (data / "change-facts.json").write_text(json.dumps({"schema_version": 1, "events": {"e1": facts()}}))
            (data / "rule-index.json").write_text(json.dumps({"schema_version": 1, **INDEX}))
            output = [{"event_id": "e1", "kind": "NEW_URL", "summary": "s"}, {"event_id": "e2", "kind": "FETCH_ERROR", "summary": "f"},
                      {"event_id": "e3", "kind": "CHANGED_URL", "summary": "t"}]
            report = {"events": [{"event_id": "e3", "evidence": {"spec_diff": {"tables": [{"kind": "rules", "changes": [{"category": "logic", "id": "R-5"}]}]}}}]}
            self.assertEqual(notify._with_checks(report, output, data, config), output)  # no registry: unchanged
            (config / "registry.json").write_text(json.dumps(REGISTRY))
            labelled = notify._with_checks(report, output, data, config)
            self.assertEqual(labelled[0]["checks"], "2 retired rules still implemented; 2 rules you implement changed; 1 new rule with no check; 1 implemented rule not in the current spec")
            self.assertNotIn("checks", labelled[1])
            self.assertEqual(labelled[2]["checks"], "1 rule you implement changed")  # from the event's own evidence
            self.assertIn("checks", channels.webhook_payload(labelled[0], "https://x")["alert"])
            self.assertIn(("Your checks", "checks"), channels.FIELDS)
