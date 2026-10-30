"""Registry updates from the dashboard: report templates, the request the
dashboard builds, the workflow's parser and merge, seeding from a rule table,
and the dashboard's reading of rule tables.

Requests are built by the real dashboard library (through Node) and applied by
the real parser, so a field the UI sends that the workflow cannot read fails here.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from regmon import registry

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

TABLE = {
    "schema_version": 1, "url": "https://www.federalreserve.gov/checklist.pdf", "raw_hash": "ab",
    "summary": {"rows": 4, "codes": 3},
    "rows": [
        {"field": "BHCK2170", "table": "HC", "line_item": "HC-12", "etype": "Validity", "id": "2080", "logic": "bhck2170 gt 0", "reads": [], "page": 483,
         "status": "No Change", "start": "20150331", "end": "99991231", "defects": []},
        {"field": "BHCK2170", "table": "HC", "line_item": "HC-12", "etype": "Validity", "id": "2070", "logic": "(bhck0081 + bhck0395) eq bhck2170",
         "reads": ["BHCK0081", "BHCK0395"], "page": 483, "status": "Revised", "start": "20190331", "end": "99991231", "defects": []},
        {"field": "BHCK0081", "table": "HC", "line_item": "HC-1a", "etype": "Quality", "id": "9340", "logic": "bhck0081 ne null", "reads": [], "page": 540,
         "status": "Added", "defects": [{"kind": "unbalanced_parentheses", "detail": "1 open, 0 close"}]},
        {"field": "TEXT0001", "table": "Page 1", "line_item": "", "etype": "Validity", "id": "0100", "logic": "text0001 ne null", "reads": [], "page": 480},
    ],
}
LOCATION = "data/rule-tables/abc-ab.json"


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


class Workspace:
    """A temporary checkout: config/ with the real templates, data/rule-tables/ with TABLE."""

    def __init__(self, registry_payload: dict | None = None):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "config").mkdir()
        (self.root / "data" / "rule-tables").mkdir(parents=True)
        shutil.copy(ROOT / "config" / "registry-templates.json", self.root / "config")
        (self.root / LOCATION).write_text(json.dumps(TABLE), encoding="utf-8")
        (self.root / "config" / "registry.json").write_text(json.dumps(registry_payload or {"schema_version": 1, "consumers": [], "items": [], "rules": []}), encoding="utf-8")

    def registry(self) -> dict:
        return json.loads((self.root / "config" / "registry.json").read_text(encoding="utf-8"))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def event(title: str, body: str, actor: str = "GauravDarwesh", owner: str = "GauravDarwesh") -> dict:
    return {"issue": {"number": 7, "title": title, "body": body, "user": {"login": actor}}, "repository": {"owner": {"login": owner}}}


def body_for(request: dict) -> str:
    return registry.REQUEST_MARKER + "\n\nSummary: test\n\n```json\n" + json.dumps(request) + "\n```\n"


class TestTemplates(unittest.TestCase):
    def test_the_shipped_templates_validate(self):
        templates = registry.load_templates()
        self.assertIn("fr-y9c", {template["id"] for template in templates})
        self.assertEqual(registry.main(["check"]), 0)

    def test_a_code_finds_its_report_by_longest_prefix(self):
        templates = registry.load_templates()
        self.assertEqual(registry.template_for_code("bhdm1234", templates)["form"], "FR Y-9C")
        self.assertEqual(registry.template_for_code("RCON2170", templates)["id"], "ffiec-call")
        self.assertIsNone(registry.template_for_code("ZZZZ0001", templates))

    def test_a_template_with_an_unknown_scheme_or_bad_prefix_is_refused(self):
        with self.assertRaisesRegex(ValueError, "scheme"):
            registry.validate_templates({"schema_version": 1, "templates": [{"id": "x", "scheme": "NOPE"}]})
        with self.assertRaisesRegex(ValueError, "code_prefixes"):
            registry.validate_templates({"schema_version": 1, "templates": [{"id": "x", "scheme": "MDRM", "code_prefixes": ["BH*"]}]})
        with self.assertRaisesRegex(ValueError, "unique id"):
            registry.validate_templates({"schema_version": 1, "templates": [{"id": "x"}, {"id": "x"}]})


class TestApplyRequest(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.cleanup()

    def apply(self, request, current=None):
        return registry.apply_request(current or self.ws.registry(), {"version": 1, **request}, root=self.ws.root)

    def test_template_fills_what_the_item_leaves_empty(self):
        merged, counts = self.apply({"template": "fr-y9c", "consumers": [{"id": "load", "kind": "pipeline", "name": "Load"}],
                                     "items": [{"code": "BHCK2170", "schedule": "HC", "consumers": ["load"]}]})
        item = merged["items"][0]
        self.assertEqual((item["scheme"], item["form"], item["regulator"], item["jurisdiction"]), ("MDRM", "FR Y-9C", "Federal Reserve", "US"))
        self.assertEqual((counts["items_added"], counts["consumers_added"]), (1, 1))

    def test_an_update_never_clears_a_field_and_unions_consumers(self):
        first, _ = self.apply({"template": "fr-y9c", "consumers": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
                               "items": [{"code": "BHCK2170", "label": "Total assets", "schedule": "HC", "consumers": ["a"]}]})
        second, counts = self.apply({"template": "fr-y9c", "items": [{"code": "BHCK2170", "label": "", "line": "12", "consumers": ["b"]}]}, first)
        item = second["items"][0]
        self.assertEqual((item["label"], item["schedule"], item["line"], item["consumers"]), ("Total assets", "HC", "12", ["a", "b"]))
        self.assertEqual((counts["items_added"], counts["items_updated"]), (0, 1))

    def test_the_same_code_in_another_form_is_another_item(self):
        merged, _ = self.apply({"items": [{"code": "BHCK2170", "scheme": "MDRM", "form": "FR Y-9C"}, {"code": "BHCK2170", "scheme": "MDRM", "form": "FR Y-9LP"}]})
        self.assertEqual(len(merged["items"]), 2)

    def test_patterns_are_upserted_by_match(self):
        first, _ = self.apply({"consumers": [{"id": "a"}, {"id": "b"}], "rules": [{"match": "BHCK*", "scheme": "MDRM", "consumers": ["a"]}]})
        second, counts = self.apply({"rules": [{"match": "bhck*", "scheme": "MDRM", "consumers": ["b"]}]}, first)
        self.assertEqual(second["rules"], [{"match": "BHCK*", "scheme": "MDRM", "consumers": ["a", "b"]}])
        self.assertEqual(counts["rules_updated"], 1)

    def test_an_unknown_consumer_or_template_is_refused_and_nothing_merges(self):
        with self.assertRaisesRegex(registry.RequestError, "not defined in consumers"):
            self.apply({"items": [{"code": "BHCK2170", "consumers": ["ghost"]}]})
        with self.assertRaisesRegex(registry.RequestError, "Template 'nope'"):
            self.apply({"template": "nope", "items": [{"code": "BHCK2170"}]})

    def test_seed_adds_every_code_with_the_rows_own_schedule_and_line(self):
        merged, counts = self.apply({"consumers": [{"id": "load", "name": "Load"}], "seed": {"rule_tables": LOCATION, "template": "fr-y9c", "consumers": ["load"]}})
        by_code = {item["code"]: item for item in merged["items"]}
        self.assertEqual(sorted(by_code), ["BHCK0081", "BHCK0395", "BHCK2170"])  # TEXT0001 is a free-text column
        self.assertEqual((by_code["BHCK2170"]["schedule"], by_code["BHCK2170"]["line"], by_code["BHCK2170"]["form"]), ("HC", "HC-12", "FR Y-9C"))
        self.assertEqual(by_code["BHCK0395"].get("schedule"), None)  # only read by a rule, never placed
        self.assertEqual(by_code["BHCK0081"]["consumers"], ["load"])
        self.assertEqual(counts["seeded_from"], LOCATION)

    def test_seed_only_fills_blanks(self):
        current = {"schema_version": 1, "consumers": [], "rules": [],
                   "items": [{"code": "BHCK2170", "scheme": "MDRM", "form": "FR Y-9C", "schedule": "HC-R", "label": "Mine"}]}
        merged, counts = self.apply({"seed": {"rule_tables": LOCATION, "template": "fr-y9c"}}, current)
        item = next(entry for entry in merged["items"] if entry["code"] == "BHCK2170")
        self.assertEqual((item["schedule"], item["label"], item["line"]), ("HC-R", "Mine", "HC-12"))
        self.assertEqual(counts["items_added"], 2)

    def test_seed_reads_only_rule_table_files_that_exist(self):
        for path in ("config/registry.json", "data/rule-tables/../latest.json", "/etc/passwd"):
            with self.subTest(path=path), self.assertRaisesRegex(registry.RequestError, "data/rule-tables"):
                self.apply({"seed": {"rule_tables": path}})
        with self.assertRaisesRegex(registry.RequestError, "not in the repository"):
            self.apply({"seed": {"rule_tables": "data/rule-tables/missing.json"}})

    def test_removing_a_consumer_unlinks_it_and_drops_patterns_left_empty(self):
        first, _ = self.apply({"consumers": [{"id": "a"}, {"id": "b"}], "items": [{"code": "BHCK2170", "consumers": ["a", "b"]}],
                               "rules": [{"match": "BHCK*", "consumers": ["a"]}]})
        second, counts = self.apply({"remove_consumers": ["a"]}, first)
        self.assertEqual(second["items"][0]["consumers"], ["b"])
        self.assertEqual(second["rules"], [])
        third, counts = self.apply({"remove_items": [{"code": "bhck2170", "scheme": "OTHER"}]}, second)
        self.assertEqual((third["items"], counts["items_removed"]), ([], 1))


class TestApplyEvent(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.cleanup()

    def test_only_the_owner_and_only_registry_requests_are_applied(self):
        body = body_for({"version": 1, "items": [{"code": "BHCK2170"}]})
        with self.assertRaisesRegex(registry.RequestError, "owner"):
            registry.apply_event(event(registry.REQUEST_TITLE, body, actor="someone"), root=self.ws.root)
        with self.assertRaisesRegex(registry.RequestError, "title"):
            registry.apply_event(event("[ChangeSentinel] Change review", body), root=self.ws.root)
        with self.assertRaisesRegex(registry.RequestError, "json block"):
            registry.apply_event(event(registry.REQUEST_TITLE, registry.REQUEST_MARKER + "\nno request"), root=self.ws.root)
        self.assertEqual(self.ws.registry()["items"], [])

    def test_a_rejected_request_leaves_the_file_untouched(self):
        before = (self.ws.root / "config" / "registry.json").read_text(encoding="utf-8")
        with self.assertRaises(registry.RequestError):
            registry.apply_event(event(registry.REQUEST_TITLE, body_for({"version": 1, "items": [{"code": "X", "consumers": ["ghost"]}]})), root=self.ws.root)
        self.assertEqual((self.ws.root / "config" / "registry.json").read_text(encoding="utf-8"), before)

    def test_an_applied_request_writes_a_valid_registry(self):
        result = registry.apply_event(event(registry.REQUEST_TITLE + ": Add 1 item", body_for({"version": 1, "template": "fr-y9c", "items": [{"code": "BHCK2170"}]})),
                                      root=self.ws.root)
        self.assertIn("1 item added", result["summary"])
        stored = self.ws.registry()
        registry.validate(stored)
        self.assertEqual(stored["items"][0]["form"], "FR Y-9C")


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestDashboardRequests(unittest.TestCase):
    """What the dashboard library builds is what the workflow applies."""

    def setUp(self):
        self.ws = Workspace({"schema_version": 1, "consumers": [{"id": "y9c-load", "kind": "pipeline", "name": "Y-9C load"}], "items": [], "rules": []})

    def tearDown(self):
        self.ws.cleanup()

    def build(self, values: dict) -> dict:
        return run_js("console.log(JSON.stringify(L.registryRequest(" + json.dumps(values) + ")));")

    def test_an_add_request_round_trips_through_the_workflow_parser(self):
        built = self.build({"template": "fr-y9c", "knownConsumers": ["y9c-load"], "summary": "Add 2 items to FR Y-9C HC; new model Capital model",
                            "consumers": [{"id": "capital-model", "kind": "model", "name": "Capital model", "repo": "acme/models"}],
                            "items": [{"code": "BHCK2170", "label": "Total assets", "schedule": "HC", "consumers": ["y9c-load", "capital-model"]},
                                      {"code": "BHCK3210", "schedule": "HC", "consumers": ["capital-model"]}],
                            "rules": [{"match": "BHDM*", "scheme": "MDRM", "consumers": ["y9c-load"]}]})
        self.assertEqual(built["errors"], [])
        self.assertTrue(built["title"].startswith(registry.REQUEST_TITLE))
        self.assertEqual(registry.parse_request_body(built["body"]), built["request"])
        result = registry.apply_event(event(built["title"], built["body"]), root=self.ws.root)
        self.assertIn("2 items added", result["summary"])
        stored = self.ws.registry()
        self.assertEqual([item["consumers"] for item in stored["items"]], [["y9c-load", "capital-model"], ["capital-model"]])
        self.assertEqual(stored["rules"][0]["match"], "BHDM*")

    def test_a_seed_request_round_trips(self):
        built = self.build({"template": "fr-y9c", "knownConsumers": ["y9c-load"], "seed": {"rule_tables": LOCATION, "template": "fr-y9c", "consumers": ["y9c-load"]}})
        self.assertEqual(built["errors"], [])
        registry.apply_event(event(built["title"], built["body"]), root=self.ws.root)
        self.assertEqual(len(self.ws.registry()["items"]), 3)

    def test_requests_the_workflow_would_refuse_are_caught_in_the_browser(self):
        cases = [
            ({"items": [{"code": "BHCK2170", "consumers": ["ghost"]}]}, "is not defined"),
            ({"consumers": [{"id": "x", "repo": "not a repo"}], "items": [{"code": "A"}]}, "owner/name"),
            ({"consumers": [{"id": "x"}], "rules": [{"match": "*", "consumers": ["x"]}]}, "lone *"),
            ({"seed": {"rule_tables": "../config/registry.json"}}, "data/rule-tables"),
            ({}, "nothing to change"),
        ]
        for values, message in cases:
            with self.subTest(message=message):
                self.assertTrue(any(message in error for error in self.build(values)["errors"]), self.build(values)["errors"])

    def test_codes_are_parsed_one_per_line_with_an_optional_label(self):
        out = run_js("console.log(JSON.stringify(L.registryParseCodes(" + json.dumps("BHCK2170, Total assets\nbhck2170\n\nF 01.01 r380 c010\tCash\nBHCK3210") + ")));")
        self.assertEqual(out["codes"], [{"code": "BHCK2170", "label": "Total assets"}, {"code": "F 01.01 r380 c010", "label": "Cash"}, {"code": "BHCK3210"}])

    def test_the_template_for_a_code_matches_the_backend(self):
        templates = json.loads((ROOT / "config" / "registry-templates.json").read_text(encoding="utf-8"))
        codes = ["BHCK2170", "bhdm1234", "RCON2170", "BHCP0001", "ZZZZ0001"]
        js = run_js("const t = L.registryTemplates(" + json.dumps(templates) + "); console.log(JSON.stringify(" + json.dumps(codes) +
                    ".map(code => (L.registryTemplateForCode(code, t) || {}).id || null)));")
        py = [(registry.template_for_code(code, registry.load_templates()) or {}).get("id") for code in codes]
        self.assertEqual(js, py)

    def test_consumer_ids_are_slugs_that_do_not_collide(self):
        out = run_js("console.log(JSON.stringify([L.registryConsumerId('FR Y-9C HC load', []), L.registryConsumerId('FR Y-9C HC load', ['fr-y-9c-hc-load']), L.registryConsumerId('***', [])]));")
        self.assertEqual(out, ["fr-y-9c-hc-load", "fr-y-9c-hc-load-2", "consumer"])
        for identifier in out:
            self.assertRegex(identifier, registry.ID.pattern)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestRuleTableIndex(unittest.TestCase):
    def test_rows_are_found_by_the_code_they_are_about_and_the_codes_they_read(self):
        out = run_js("const i = L.ruleTableIndex(" + json.dumps(TABLE) + "); console.log(JSON.stringify({about: (i.byField.get('BHCK2170') || []).map(L.ruleCheckName), " +
                     "reads: (i.byRead.get('BHCK0081') || []).map(L.ruleCheckName), none: i.byField.has('BHCK0395'), dates: [L.ruleCheckDate('20150331'), L.ruleCheckDate('99991231')]}));")
        self.assertEqual(out, {"about": ["Validity 2080", "Validity 2070"], "reads": ["Validity 2070"], "none": False, "dates": ["31 Mar 2015", ""]})

    def test_every_defect_kind_the_reader_records_has_words(self):
        source = (ROOT / "regmon" / "pdf_tables.py").read_text(encoding="utf-8")
        import re
        kinds = set(re.findall(r'add\("([a-z_]+)"', source))
        words = run_js("console.log(JSON.stringify(Object.keys(L.RULE_DEFECT_WORDS)));")
        self.assertTrue(kinds, "no defect kinds found in pdf_tables.py")
        self.assertLessEqual(kinds, set(words))


class TestWorkflowAndPublishing(unittest.TestCase):
    def test_the_workflow_applies_owner_requests_and_commits_only_the_registry(self):
        workflow = (ROOT / ".github" / "workflows" / "registry-update.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("startsWith(github.event.issue.title, '" + registry.REQUEST_TITLE + "')", workflow)
        self.assertIn("python -m regmon.registry apply-issue --event \"$GITHUB_EVENT_PATH\"", workflow)
        self.assertIn("git add -- config/registry.json", workflow)
        self.assertIn("gh workflow run pages.yml", workflow)

    def test_the_dashboard_uses_the_same_marker_and_title(self):
        lib = (ROOT / "dashboard-lib.js").read_text(encoding="utf-8")
        self.assertIn('const REGISTRY_REQUEST_MARKER = "' + registry.REQUEST_MARKER + '";', lib)
        self.assertIn('const REGISTRY_REQUEST_TITLE = "' + registry.REQUEST_TITLE + '";', lib)

    def test_the_dialog_offers_every_consumer_kind_the_registry_accepts(self):
        kinds = run_js("console.log(JSON.stringify(L.REGISTRY_KINDS));") if NODE else list(registry.CONSUMER_KINDS)
        self.assertEqual(tuple(kinds), registry.CONSUMER_KINDS)

    def test_templates_are_published_and_rule_tables_are_read_from_the_repository(self):
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn('- "config/registry-templates.json"', pages)
        self.assertIn("config/registry-templates.json config/registry.json", pages)
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        # Content-addressed like evidence, so fetched once from the repository, not copied to Pages.
        self.assertIn("fetchImmutable(location)", js)
        for element in ("registryDialog", "registryForm", "registryTemplate", "registryCodes", "registryConsumerPick", "addRegistryBtn"):
            with self.subTest(element=element):
                self.assertIn('id="' + element + '"', (ROOT / "index.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
