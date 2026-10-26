"""Cross-jurisdiction item registry: validation, what a change touched, the
impact sentence, CSV import, engine/alert wiring, and the dashboard's half."""
from __future__ import annotations

import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from engine_harness import Sandbox, ok
from regmon import registry
from regmon.config import SourceConfig

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

PAYLOAD = {
    "schema_version": 1,
    "consumers": [
        {"id": "y9c-hc-load", "kind": "pipeline", "name": "FR Y-9C HC load", "owner": "Reg Reporting", "repo": "acme/regrep", "path": "pipelines/y9c/hc_load.py"},
        {"id": "cap-model", "kind": "model", "name": "Capital ratio model"},
        {"id": "wh-hcr", "kind": "table", "name": "warehouse.fr_y9c.hcr", "system": "Snowflake"},
        {"id": "cil-load", "kind": "pipeline", "name": "FR Y-14Q CIL load"},
    ],
    "items": [
        {"code": "BHCK2170", "scheme": "MDRM", "form": "FR Y-9C", "schedule": "HC-R", "label": "Total assets", "aliases": ["BHCK 2170"],
         "equivalents": ["DPM:F 01.01 r380 c010"], "consumers": ["wh-hcr"]},
        {"code": "BHCK3210", "scheme": "MDRM", "form": "FR Y-9C", "schedule": "HC-R", "consumers": ["cap-model"]},
        {"code": "BHCKC447", "scheme": "MDRM", "form": "FR Y-9C", "schedule": "HC-R"},
        {"code": "TaxStatus", "scheme": "FRY14", "form": "FR Y-14Q", "schedule": "CIL", "consumers": ["cil-load"]},
        {"code": "LMBEFD", "scheme": "FRY14", "form": "FR Y-14Q", "schedule": "CIL", "consumers": ["cil-load"]},
        {"code": "Country", "scheme": "FRY14", "form": "FR Y-14Q", "schedule": "CIL"},
        {"code": "F 01.01 r380 c010", "scheme": "DPM", "form": "FINREP", "schedule": "F 01.01", "equivalents": ["MDRM:BHCK2170"]},
    ],
    "rules": [{"match": "BHCK*", "scheme": "MDRM", "consumers": ["y9c-hc-load"]}],
}


class TestValidation(unittest.TestCase):
    def test_a_good_registry_is_canonicalised(self):
        reg = registry.validate(PAYLOAD)
        self.assertEqual(len(reg["items"]), 7)
        self.assertEqual(reg["items"][0]["jurisdiction"], "US")   # from the MDRM scheme
        self.assertEqual(reg["items"][-1]["jurisdiction"], "EU")
        self.assertIn("y9c-hc-load", reg["consumers"])

    def test_problems_are_named(self):
        cases = [
            ({"schema_version": 2}, "schema_version 1"),
            ({**PAYLOAD, "items": [{"code": "X", "scheme": "NOPE"}]}, "scheme 'NOPE' is not known"),
            ({**PAYLOAD, "items": [{"code": "X", "consumers": ["missing"]}]}, "consumer 'missing' is not defined"),
            ({**PAYLOAD, "items": [{"code": "A1", "scheme": "OTHER"}, {"code": "a1", "scheme": "OTHER"}]}, "registered twice"),
            ({**PAYLOAD, "rules": [{"match": "*", "consumers": ["cap-model"]}]}, "lone *"),
            ({**PAYLOAD, "consumers": [{"id": "x", "kind": "spreadsheet"}]}, "kind must be one of"),
            ({**PAYLOAD, "consumers": [{"id": "x", "repo": "not a repo"}]}, "owner/name"),
            ({**PAYLOAD, "surprise": 1}, "unknown keys"),
        ]
        for payload, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(ValueError) as caught:
                    registry.validate(payload)
                self.assertIn(message, str(caught.exception))

    def test_custom_schemes_can_be_declared(self):
        payload = {"schema_version": 1, "schemes": [{"id": "CMF", "name": "Chile CMF", "jurisdiction": "CL"}],
                   "items": [{"code": "C01", "scheme": "CMF"}]}
        self.assertEqual(registry.validate(payload)["items"][0]["jurisdiction"], "CL")

    def test_the_shipped_registry_is_valid(self):
        loaded = registry.load(ROOT / "config" / "registry.json")
        self.assertIsInstance(loaded["items"], list)

    def test_lineage_mappings_are_folded_in_as_rules(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / "registry.json").write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
            (folder / "lineage.json").write_text(json.dumps({"schema_version": 1, "mappings": [
                {"series": ["RCON"], "assets": ["dbt: call_report.rc"], "owner": "Finance"}]}), encoding="utf-8")
            reg = registry.load(folder / "registry.json")
            result = registry.impact([{"code": "RCON2170", "change": "amended"}], reg)
            self.assertEqual([consumer["name"] for consumer in result["consumers"]], ["dbt: call_report.rc"])


class TestImpact(unittest.TestCase):
    def setUp(self):
        self.reg = registry.validate(PAYLOAD)

    def test_the_roadmap_sentence(self):
        touched = [{"code": "BHCK2170", "change": "amended", "quarter": "Q1 2027"}, {"code": "BHCK3210", "change": "amended"},
                   {"code": "BHCKC447", "change": "amended"}, {"code": "ZZZZ9999", "change": "added"}]
        result = registry.impact(touched, self.reg)
        self.assertEqual(result["sentence"],
                         "These 3 fields in FR Y-9C HC-R change from Q1 2027: BHCK2170, BHCK3210, BHCKC447. "
                         "They are read by 1 table (warehouse.fr_y9c.hcr), 1 pipeline (FR Y-9C HC load) and 1 model (Capital ratio model). "
                         "Equivalent items elsewhere: DPM:F 01.01 r380 c010.")
        self.assertEqual(result["unregistered"], ["ZZZZ9999"])
        pipeline = next(consumer for consumer in result["consumers"] if consumer["id"] == "y9c-hc-load")
        self.assertEqual(pipeline["codes"], ["BHCK2170", "BHCK3210", "BHCKC447"])  # through the BHCK* rule
        self.assertEqual(pipeline["link"], "https://github.com/acme/regrep/blob/HEAD/pipelines/y9c/hc_load.py")

    def test_mixed_changes_say_what_happens_to_each(self):
        touched = [{"code": "TaxStatus", "change": "retired", "quarter": "Q2 2026"}, {"code": "LMBEFD", "change": "added", "quarter": "Q3 2026"}]
        text = registry.impact(touched, self.reg)["sentence"]
        self.assertTrue(text.startswith("These 2 fields in FR Y-14Q CIL change: TaxStatus is retired (last reported Q2 2026); LMBEFD is new from Q3 2026."), text)
        single = registry.impact([{"code": "TaxStatus", "change": "retired", "quarter": "Q2 2026"}], self.reg)["sentence"]
        self.assertEqual(single, "This field in FR Y-14Q CIL is retired (last reported Q2 2026): TaxStatus. It is read by 1 pipeline (FR Y-14Q CIL load).")

    def test_codes_named_on_changed_lines_match_exactly(self):
        index = registry.Index(self.reg)
        found = index.mentioned("BHCK 2170 moved; the country field; F 01.01 r380 c010 and Country.")
        self.assertEqual(sorted(found), ["BHCK2170", "Country", "F 01.01 r380 c010"])
        self.assertEqual(index.mentioned("the country of the obligor"), [])

    def test_touched_codes_come_from_item_codes_spec_rows_and_the_diff(self):
        item_codes = {"added": [{"code": "BHCKC447"}], "removed": [], "amended": [{"code": "BHCK2170"}]}
        spec = {"tables": [{"kind": "fields", "name": "CIL", "changes": [
            {"category": "retired", "label": "TaxStatus", "effective": "last applies to 2026-06-30", "quarter": "Q2 2026"},
            {"category": "cosmetic", "label": "City"}]},
            {"kind": "rules", "name": "Edits", "changes": [{"category": "logic", "label": "531 v1", "field": "LMBEFD"}]}]}
        diff = "--- before\n+++ after\n-old line with BHCK3210\n+new line\n context with BHCK2170"
        touched = registry.touched_codes(item_codes, spec, diff, registry.Index(self.reg))
        self.assertEqual([(entry["code"], entry["change"]) for entry in touched],
                         [("BHCKC447", "added"), ("BHCK2170", "amended"), ("TaxStatus", "retired"), ("LMBEFD", "logic"), ("BHCK3210", "mentioned")])
        self.assertEqual(touched[2]["quarter"], "Q2 2026")

    def test_nothing_registered_means_no_sentence(self):
        result = registry.impact([{"code": "QQQQ0001", "change": "added"}], self.reg)
        self.assertEqual(result["sentence"], "")
        self.assertIsNone(registry.summary(result))


class TestImport(unittest.TestCase):
    def test_a_mapping_spreadsheet_merges_into_the_registry(self):
        text = "MDRM,Form,Schedule,Description,Used by,Repo,Path,Owner\n" \
               "BHCK2170,FR Y-9C,HC,Total assets,warehouse.y9c.hc;y9c_load.py,acme/regrep,pipelines/y9c.py,Reg Reporting\n" \
               "BHCK3210,FR Y-9C,HC,Total equity,warehouse.y9c.hc,,,\n"
        merged = registry.import_csv(text, {"schema_version": 1})
        reg = registry.validate(merged)
        self.assertEqual([item["code"] for item in reg["items"]], ["BHCK2170", "BHCK3210"])
        self.assertEqual(reg["items"][0]["scheme"], "MDRM")
        self.assertEqual(reg["items"][0]["consumers"], ["warehouse.y9c.hc", "y9c_load.py"])
        self.assertEqual(reg["consumers"]["y9c_load.py"]["kind"], "code")
        again = registry.import_csv(text, merged)
        self.assertEqual(len(again["items"]), 2)  # importing twice changes nothing

    def test_a_csv_without_a_code_column_is_refused(self):
        with self.assertRaises(ValueError):
            registry.import_csv("Name,Owner\nx,y\n")

    def test_command_line(self):
        from contextlib import redirect_stdout

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "registry.json"
            path.write_text(json.dumps(PAYLOAD), encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(registry.main(["check", "--path", str(path)]), 0)
            self.assertIn("OK: 7 items, 4 consumers, 1 rules", out.getvalue())


URL = "https://example.test/fr-y9c-form.txt"
SOURCE = SourceConfig(id="y9c", name="FR Y-9C", regulator="Synthetic Regulator", seed_urls=(URL,),
                      allowed_prefixes=("https://example.test/",), allowed_domains=("example.test",), allowed_urls=(URL,))


def form_text(new_label: str) -> bytes:
    rows = ["| BHCK2170 | Total assets | 12 |", "| BHCK3210 | Total equity capital | 27 |", "| BHCKC447 | " + new_label + " | 28 |",
            "| BHCK4000 | Something else | 30 |"]
    return ("\n".join(rows) + "\n").encode("utf-8")


class TestEngineAndAlerts(unittest.TestCase):
    def test_a_change_records_its_downstream_impact(self):
        with Sandbox(source=SOURCE) as sandbox:
            config = sandbox.root / "config"
            config.mkdir()
            (config / "registry.json").write_text(json.dumps(PAYLOAD), encoding="utf-8")
            text = "text/plain"
            sandbox.scan(lambda *a, **k: ok(form_text("Minority interest"), text))
            changed = sandbox.scan(lambda *a, **k: ok(form_text("Noncontrolling interests"), text))
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL")
            self.assertIn("BHCKC447", event["impact"]["codes"])
            self.assertEqual(event["impact"]["sentence"], "This field in FR Y-9C HC-R changes: BHCKC447. It is read by 1 pipeline (FR Y-9C HC load).")
            evidence = json.loads((sandbox.root / event["evidence_location"]).read_text(encoding="utf-8"))
            self.assertEqual(evidence["impact"]["items"][0]["code"], "BHCKC447")
            entry = next(iter(sandbox.inventory().values()))["change_history"][0]
            self.assertEqual(entry["impact"]["codes"], event["impact"]["codes"])

    def test_a_broken_registry_never_breaks_the_scan(self):
        with Sandbox(source=SOURCE) as sandbox:
            config = sandbox.root / "config"
            config.mkdir()
            (config / "registry.json").write_text("{not json", encoding="utf-8")
            sandbox.scan(lambda *a, **k: ok(form_text("A"), "text/plain"))
            changed = sandbox.scan(lambda *a, **k: ok(form_text("B"), "text/plain"))
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL")
            self.assertNotIn("impact", event)

    def test_alerts_carry_a_downstream_line(self):
        from regmon import channels, notify

        report = {"events": [{"event_id": "e1", "event_type": "CHANGED_URL", "url": URL,
                              "impact": {"sentence": "This field in FR Y-9C HC-R changes: BHCKC447.", "codes": ["BHCKC447"]}}], "ai_results": []}
        alert = next(item for item in notify.build_notifications(report) if item["event_id"] == "e1")
        self.assertEqual(alert["downstream"], "This field in FR Y-9C HC-R changes: BHCKC447.")
        self.assertIn("downstream", channels.webhook_payload(alert, "https://example.test")["alert"])
        with patch("regmon.notify.requests.post") as post:
            notify.publish(alert, "topic", "https://ntfy.example")
        self.assertIn("Downstream: This field in FR Y-9C HC-R changes", json.dumps(post.call_args.kwargs["json"], ensure_ascii=False))


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestDashboardHalf(unittest.TestCase):
    """The dashboard reads the registry and words the impact exactly as the Python half."""

    CASES = [
        [{"code": "BHCK2170", "change": "amended", "quarter": "Q1 2027"}, {"code": "BHCK3210", "change": "amended"}, {"code": "ZZZZ9999", "change": "added"}],
        [{"code": "TaxStatus", "change": "retired", "quarter": "Q2 2026"}, {"code": "LMBEFD", "change": "added", "quarter": "Q3 2026"}],
        [{"code": "TaxStatus", "change": "retired", "quarter": "Q2 2026"}],
        [{"code": "LMBEFD", "change": "added", "quarter": "Q3 2026"}, {"code": "TaxStatus", "change": "added"}],
        [{"code": "F 01.01 r380 c010", "change": "mentioned"}],
    ]

    def test_impact_and_sentence_match(self):
        reg = registry.validate(PAYLOAD)
        out = run_js("const model = L.registryModel(" + json.dumps(PAYLOAD) + ", null);\nconsole.log(JSON.stringify(" + json.dumps(self.CASES) +
                     ".map(t => { const r = L.registryImpact(t, model, ''); return [r.sentence, r.consumers.map(c => [c.id, c.codes, c.link]), r.unregistered]; })));")
        for case, (sentence, consumers, unregistered) in zip(self.CASES, out):
            expected = registry.impact(case, reg)
            self.assertEqual(sentence, expected["sentence"])
            self.assertEqual(consumers, [[c["id"], c["codes"], c["link"]] for c in expected["consumers"]])
            self.assertEqual(unregistered, expected["unregistered"])

    def test_touched_codes_match(self):
        item_codes = {"added": [{"code": "BHCKC447"}], "removed": [], "amended": [{"code": "BHCK2170"}]}
        spec = {"tables": [{"kind": "fields", "name": "CIL", "changes": [{"category": "retired", "label": "TaxStatus", "effective": "last applies to 2026-06-30"}]},
                           {"kind": "concepts", "name": "Elements", "changes": [{"category": "definition", "label": "BA/BA-1/1001"}]}]}
        out = run_js("console.log(JSON.stringify(L.registryTouched(" + json.dumps(item_codes) + ", " + json.dumps(spec) + ")));")
        expected = registry.touched_codes(item_codes, spec)
        self.assertEqual(out, [{key: entry[key] for key in ("code", "change", "quarter", "effective")} for entry in expected])

    def test_lineage_is_read_as_rules(self):
        lineage = {"schema_version": 1, "mappings": [{"series": ["RCON"], "assets": ["dbt: call_report.rc"], "owner": "Finance"}]}
        out = run_js("const m = L.registryModel(null, " + json.dumps(lineage) + "); console.log(JSON.stringify(L.registryImpact([{code: 'RCON2170', change: 'amended'}], m, '').consumers.map(c => c.name)));")
        self.assertEqual(out, ["dbt: call_report.rc"])


if __name__ == "__main__":
    unittest.main()
