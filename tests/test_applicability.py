"""Phase 3 ASSESS (regmon/applicability.py, regmon/profile.py): which changes apply to the entity,
applicable items with no consumer, and priority, the same in Python and in the dashboard."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regmon import applicability as A
from regmon import profile as P
from regmon import registry as R
from regmon import spec_diff

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
TODAY = date(2026, 10, 31)
LIBRARY = A.load_library(ROOT / "config" / "reports.json")
TEMPLATES = R.load_templates(ROOT / "config" / "registry-templates.json")

DEMO = {
    "entities": [
        {"id": "bancorp", "name": "Demo Bancorp", "kind": "bhc", "total_assets": 48_200_000_000, "currency": "USD",
         "advanced_approaches": False, "category": "none", "trading": 300_000_000},
        {"id": "bank", "name": "Demo Bank", "kind": "bank", "parent": "bancorp", "total_assets": 45_000_000_000,
         "foreign_offices": False, "advanced_approaches": False, "category": "none", "trading": 200_000_000},
    ],
    "reports": [],
}


def profile(**changes) -> dict:
    payload = json.loads(json.dumps(DEMO))
    payload.update(changes)
    return P.validate(payload, kinds=LIBRARY.kinds)


def status(form: str, prof: dict) -> dict:
    return A.report_status(form, prof, LIBRARY)


class LibraryTest(unittest.TestCase):
    def test_the_shipped_library_is_valid_and_cites_a_source_for_every_rule(self):
        payload = json.loads((ROOT / "config" / "reports.json").read_text(encoding="utf-8"))
        self.assertEqual(A.validate_library(payload), [])
        for report in payload["reports"]:
            with self.subTest(form=report["form"]):
                self.assertTrue(report["source"].startswith("https://"))
                self.assertTrue(report["who_files"])

    def test_bad_rules_are_refused(self):
        bad = {"kinds": {"bhc": {}}, "reports": [{"form": "X", "who_files": "y", "rule": {"any": [{"kinds": ["martian"], "size": 1}]}},
                                                {"form": "X", "who_files": "", "match": ["("]}]}
        errors = " ".join(A.validate_library(bad))
        for expected in ("unknown rule keys", "unknown entity kind martian", "listed twice", "bad pattern", "who_files is required"):
            self.assertIn(expected, errors)

    def test_names_resolve_to_library_reports(self):
        self.assertEqual(LIBRARY.canonical("FR Y-14"), ["FR Y-14A", "FR Y-14Q", "FR Y-14M"])
        self.assertEqual(LIBRARY.canonical("FR 2028bs"), ["FR 2028"])
        self.assertEqual(LIBRARY.canonical("FR VV-1"), ["FR VV-1"])
        self.assertIn("OSFI BCAR", LIBRARY.named_in("https://www.osfi-bsif.gc.ca/…/bcar27-rnfpb27-tech-spec-data-2026-10-30-en.xlsx"))
        self.assertIn("TIC", LIBRARY.named_in("TIC BL-1 Sample File (XML)"))
        self.assertNotIn("FFIEC 009", LIBRARY.named_in("FFIEC 009a"))


class RulesTest(unittest.TestCase):
    """Who files what, by the regulators' stated thresholds (config/reports.json)."""

    def test_a_48bn_bank_holding_company_and_its_bank(self):
        prof = profile()
        expect = {"FR Y-9C": "files", "FR Y-9LP": "files", "FR Y-9SP": "not_filed", "FFIEC 031": "not_filed", "FFIEC 041": "files",
                  "FFIEC 051": "not_filed", "FR Y-14Q": "not_filed", "FFIEC 101": "not_filed", "FFIEC 102": "not_filed",
                  "FR 2052a": "not_filed", "OSFI BCAR": "not_filed", "FFIEC 002": "not_filed", "FR 2028": "unknown"}
        for form, wanted in expect.items():
            with self.subTest(form=form):
                self.assertEqual(status(form, prof)["status"], wanted)
        self.assertIn("Demo Bancorp (a bank holding company, total assets $48.2 billion)", status("FR Y-9C", prof)["reason"])
        self.assertIn("reports total assets of $48.2 billion, below $100 billion", status("FR Y-14Q", prof)["reason"])
        self.assertIn("Demo Bank has no foreign offices", status("FFIEC 031", prof)["reason"])

    def test_only_the_top_tier_holding_company_files_the_y9c(self):
        payload = json.loads(json.dumps(DEMO))
        payload["entities"] = [{"id": "top", "name": "Top", "kind": "bhc", "total_assets": 9e9},
                               {"id": "mid", "name": "Mid", "kind": "bhc", "parent": "top", "total_assets": 8e9}]
        prof = P.validate(payload, kinds=LIBRARY.kinds)
        self.assertEqual(status("FR Y-9C", prof)["status"], "files")
        only_mid = P.validate({"entities": [payload["entities"][1] | {"parent": ""}], "reports": []}, kinds=LIBRARY.kinds)
        self.assertEqual(status("FR Y-9C", only_mid)["status"], "files")

    def test_call_report_forms_by_offices_size_and_approach(self):
        def bank(**attrs):
            return P.validate({"entities": [{"id": "b", "name": "B", "kind": "bank", **attrs}], "reports": []}, kinds=LIBRARY.kinds)
        small = bank(total_assets=2e9, foreign_offices=False, advanced_approaches=False, category="none")
        self.assertEqual(status("FFIEC 051", small)["status"], "eligible")
        self.assertEqual(status("FFIEC 041", small)["status"], "files")
        self.assertEqual(status("FFIEC 031", small)["status"], "not_filed")
        self.assertEqual(status("FFIEC 031", bank(total_assets=2e9, foreign_offices=True))["status"], "files")
        self.assertEqual(status("FFIEC 031", bank(total_assets=150e9, foreign_offices=False, advanced_approaches=False))["status"], "files")
        self.assertEqual(status("FFIEC 031", bank(total_assets=20e9, foreign_offices=False, advanced_approaches=True))["status"], "files")
        cat3 = bank(total_assets=2e9, foreign_offices=False, advanced_approaches=False, category="III")
        self.assertEqual(status("FFIEC 051", cat3)["status"], "not_filed")

    def test_market_risk_by_trading_amount_or_share(self):
        def hc(trading, assets=20e9):
            return P.validate({"entities": [{"id": "h", "name": "H", "kind": "bhc", "total_assets": assets, "trading": trading}], "reports": []}, kinds=LIBRARY.kinds)
        self.assertEqual(status("FFIEC 102", hc(1.2e9))["status"], "files")
        self.assertEqual(status("FFIEC 102", hc(0.5e9, assets=4e9))["status"], "files")  # 12.5% of total assets
        self.assertEqual(status("FFIEC 102", hc(0.5e9))["status"], "not_filed")
        self.assertIn("$500 million, below $1 billion", status("FFIEC 102", hc(0.5e9))["reason"])

    def test_a_missing_fact_leaves_the_report_undecided(self):
        prof = P.validate({"entities": [{"id": "b", "name": "Example Bank", "kind": "bank"}], "reports": []}, kinds=LIBRARY.kinds)
        result = status("FFIEC 031", prof)
        self.assertEqual(result["status"], "unknown")
        self.assertIn("the profile needs Example Bank's", result["reason"])

    def test_the_profile_list_decides_first_and_a_complete_list_closes_the_rest(self):
        prof = profile(reports=[{"form": "FR Y-9C", "files": False, "note": "Exempt this year"}, {"form": "FR 2028", "entity": "bank"}])
        self.assertEqual(status("FR Y-9C", prof), {"status": "not_filed", "basis": "profile", "reason": "You don't file FR Y-9C: Exempt this year."})
        self.assertEqual(status("FR 2028", prof), {"status": "files", "basis": "profile", "reason": "You file FR 2028 (Demo Bank)."})
        self.assertEqual(status("FR Y-9LP", prof)["status"], "not_filed")  # it follows the Y-9C
        self.assertEqual(status("FR 2004", prof)["status"], "unknown")
        complete = profile(reports=[{"form": "FR 2028"}], reports_complete=True)
        self.assertEqual(status("FR 2004", complete)["basis"], "list")
        self.assertEqual(status("FR Y-9C", complete)["status"], "files")  # a rule still decides


def rules_spec() -> dict:
    from test_spec_diff import current_edit_rows, edit_rows, edit_workbook, workbook_text

    return spec_diff.diff(workbook_text(edit_workbook(edit_rows())), workbook_text(edit_workbook(current_edit_rows())))


class FactsTest(unittest.TestCase):
    def test_rule_changes_carry_the_rules_stated_severity(self):
        changes = {change["label"]: change for table in rules_spec()["tables"] for change in table["changes"]}
        self.assertEqual(changes["532 v1"]["level"], "blocking")  # Validity
        self.assertEqual(changes["531 v1"]["level"], "blocking")  # Syntax
        self.assertEqual(changes["112 v1"]["level"], "blocking")  # escalated to Validity

    def test_severity_levels(self):
        self.assertEqual(A.severity_of("CHANGED_URL", {"spec_diff": rules_spec()})["kind"], "blocking_edit")
        quality = {"tables": [{"kind": "rules", "changes": [{"category": "logic", "label": "9000", "level": "warning"}]}]}
        self.assertEqual(A.severity_of("CHANGED_URL", {"spec_diff": quality})["kind"], "edit")
        fields = {"tables": [{"kind": "fields", "changes": [{"category": "retired", "label": "10419"}]}]}
        self.assertEqual(A.severity_of("NEW_URL", {"spec_diff": fields})["level"], 3)
        wording = {"tables": [{"kind": "rules", "changes": [{"category": "message", "label": "1"}]}]}
        self.assertEqual(A.severity_of("CHANGED_URL", {"spec_diff": wording})["kind"], "wording")
        cosmetic = {"tables": [{"kind": "rules", "changes": [{"category": "cosmetic", "label": "1"}]}]}
        self.assertEqual(A.severity_of("CHANGED_URL", {"spec_diff": cosmetic})["kind"], "cosmetic")
        self.assertEqual(A.severity_of("CHANGED_URL", {})["kind"], "text")
        self.assertEqual(A.severity_of("HTML_SOURCE_CHANGED", {}), {"level": 0, "kind": "markup", "label": "Markup only (text unchanged)"})
        self.assertEqual(A.severity_of("CHANGED_URL", {"item_codes": {"counts": {"added": 2}}})["kind"], "item")

    def test_forms_come_from_the_monitor_address_listing_codes_and_changed_lines(self):
        record = {"url_id": "u1", "source_id": "s1", "canonical_url": "https://www.ffiec.gov/resources/reporting-forms/ffiec041"}
        entry = {"event_id": "e1", "event_type": "CHANGED_URL", "timestamp": "2026-10-30T00:00:00+00:00"}
        evidence = {"item_codes": {"added": [{"code": "BHCK2170"}], "removed": [{"code": "RCON3210"}]}}
        facts = A.event_facts(entry, record, {"id": "s1", "name": "FFIEC 041 Call Report", "listed_on": ["https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C"]},
                              evidence, LIBRARY, TEMPLATES)
        forms = {row["form"]: row["basis"] for row in facts["forms"]}
        self.assertEqual(forms["FFIEC 041"], ["monitor", "address", "codes"])
        self.assertEqual(forms["FR Y-9C"], ["listing", "codes"])
        self.assertIn("FFIEC 051", forms)  # RCON items are on all three Call Report forms
        self.assertEqual([code[0] for code in facts["codes"]], ["BHCK2170", "RCON3210"])
        index_page = A.event_facts(entry, {"url_id": "u2", "canonical_url": "https://www.federalreserve.gov/apps/reportingforms/recentupdates"},
                                   {"id": "s2", "name": "Reporting forms"},
                                   {"diff": "--- before\n+++ after\n+FR Y-14Q instructions updated\n FR Y-9C unchanged\n"}, LIBRARY, TEMPLATES)
        self.assertEqual(index_page["forms"], [{"form": "FR Y-14Q", "basis": ["diff"]}])

    def test_the_effective_quarter_is_the_one_most_rows_state(self):
        evidence = {"spec_diff": {"tables": [{"kind": "rules", "changes": [
            {"category": "logic", "label": "a", "quarter": "Q1 2027"}, {"category": "logic", "label": "b", "quarter": "Q1 2027"},
            {"category": "added", "label": "c", "quarter": "Q1 2026"}, {"category": "cosmetic", "label": "d", "quarter": "Q4 2025"}]}]}}
        self.assertEqual(A.effective_of([], evidence), {"quarter": "Q1 2027", "date": "2027-01-01", "basis": "spec"})

    def test_a_scan_writes_facts_once_per_event_one_per_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data, config = root / "data", root / "config"
            (data / "evidence").mkdir(parents=True)
            config.mkdir()
            shutil.copy(ROOT / "config" / "reports.json", config)
            shutil.copy(ROOT / "config" / "registry-templates.json", config)
            (config / "sources.json").write_text(json.dumps({"sources": [{"id": "y9c", "name": "FR Y-9C instructions"}]}))
            (data / "evidence" / "e1.json").write_text(json.dumps({"spec_diff": {"tables": [{"kind": "rules", "changes": [{"category": "logic", "label": "1", "level": "blocking"}]}]}}))
            latest = {"schema_version": 2, "sources": {"y9c": {"u1": {"url_id": "u1", "source_id": "y9c", "canonical_url": "https://x.gov/FRY9C_i.pdf", "change_history": [
                {"event_id": "e1", "event_type": "CHANGED_URL", "timestamp": "2026-10-30T00:00:00+00:00", "evidence_location": "data/evidence/e1.json"},
                {"event_id": "e0", "event_type": "FETCH_ERROR", "timestamp": "2026-10-29T00:00:00+00:00"}]}}}}
            (data / "latest.json").write_text(json.dumps(latest))
            first = A.write(data, config, now="2026-10-31T00:00:00+00:00")
            self.assertEqual(list(first["events"]), ["e1"])
            self.assertEqual(first["events"]["e1"]["severity"]["kind"], "blocking_edit")
            text = (data / A.FILE_NAME).read_text()
            self.assertEqual(len(text.splitlines()), 3)
            self.assertEqual(A.validate(data), [])
            (data / "evidence" / "e1.json").write_text("{}")  # kept facts are not recomputed
            self.assertEqual(A.write(data, config)["events"]["e1"]["severity"]["kind"], "blocking_edit")
            self.assertEqual((data / A.FILE_NAME).read_text(), text)
            self.assertEqual(A.write(data, config, force=True)["events"]["e1"]["severity"]["kind"], "text")
            # A change to how reports are identified recomputes kept facts.
            (data / "evidence" / "e1.json").write_text(json.dumps({"spec_diff": {"tables": [{"kind": "rules", "changes": [{"category": "logic", "label": "1", "level": "blocking"}]}]}}))
            library = json.loads((config / "reports.json").read_text())
            library["reports"].append({"form": "FR Y-9X", "who_files": "Test.", "match": ["FRY9C"], "source": "https://x.gov"})
            (config / "reports.json").write_text(json.dumps(library))
            again = A.write(data, config)["events"]["e1"]
            self.assertEqual(again["severity"]["kind"], "blocking_edit")
            self.assertIn("FR Y-9X", [row["form"] for row in again["forms"]])


def registry_with(*codes_with_consumers) -> dict:
    items = [{"code": code, "scheme": "MDRM", "consumers": consumers} for code, consumers in codes_with_consumers]
    return R.validate({"schema_version": 1, "consumers": [{"id": "gl", "kind": "table", "name": "GL"}], "items": items})


FACTS = {
    "y9c-edit": {"type": "CHANGED_URL", "at": "2026-10-30T00:00:00+00:00",
                 "forms": [{"form": "FFIEC 031", "basis": ["codes"]}, {"form": "FFIEC 041", "basis": ["codes"]}, {"form": "FFIEC 051", "basis": ["codes"]},
                           {"form": "FR Y-9C", "basis": ["monitor", "codes"]}],
                 "severity": {"level": 5, "kind": "blocking_edit", "label": "Blocking edit changed"},
                 "codes": [["BHCK2170", "logic", "Q1 2027", ["FR Y-9C"]], ["BHCK3210", "added", "Q1 2027", ["FR Y-9C"]],
                           ["RCON2170", "logic", "", ["FFIEC 031", "FFIEC 041", "FFIEC 051"]]],
                 "effective": {"quarter": "Q1 2027", "date": "2027-01-01", "basis": "spec"}},
    "y14-text": {"type": "HTML_SOURCE_CHANGED", "at": "2026-10-29T00:00:00+00:00", "forms": [{"form": "FR Y-14Q", "basis": ["address"]}],
                 "severity": {"level": 1, "kind": "text", "label": "Text changed"}},
    "tic": {"type": "NEW_URL", "at": "2026-10-28T00:00:00+00:00", "forms": [{"form": "TIC", "basis": ["monitor"]}],
            "severity": {"level": 1, "kind": "text", "label": "Text changed"}},
    "nothing": {"type": "CHANGED_URL", "at": "2026-10-27T00:00:00+00:00", "forms": [], "severity": {"level": 1, "kind": "text", "label": "Text changed"}},
    "quality-later": {"type": "CHANGED_URL", "at": "2026-10-26T00:00:00+00:00", "forms": [{"form": "FFIEC 041", "basis": ["address"]}],
                      "severity": {"level": 4, "kind": "edit", "label": "Edit check changed"},
                      "effective": {"quarter": "Q4 2027", "date": "2027-10-01", "basis": "spec"}},
}


class AssessTest(unittest.TestCase):
    def assess(self, key, prof=None, registry=None):
        return A.assess(FACTS[key], profile() if prof is None else prof, registry or R.empty(), LIBRARY, today=TODAY)

    def test_without_a_profile_nothing_is_assessed_or_hidden(self):
        result = A.assess(FACTS["y14-text"], P.empty(), R.empty(), LIBRARY, today=TODAY)
        self.assertEqual(result["applicability"]["status"], "unassessed")
        self.assertNotEqual(result["priority"]["band"], 0)

    def test_a_change_to_an_unfiled_report_is_not_applicable_with_the_reason(self):
        result = self.assess("y14-text")
        self.assertEqual(result["applicability"]["status"], "not_applicable")
        self.assertIn("FR Y-14Q doesn't apply: Demo Bancorp reports total assets of $48.2 billion, below $100 billion", result["applicability"]["reason"])
        self.assertEqual(result["priority"], {"band": 0, "score": 0, "reasons": ["Not applicable"]})

    def test_an_unidentified_or_undecided_report_is_never_not_applicable(self):
        self.assertEqual(self.assess("nothing")["applicability"]["status"], "unknown")
        self.assertEqual(self.assess("tic")["applicability"]["status"], "unknown")
        self.assertEqual(self.assess("tic", profile(reports_complete=True))["applicability"]["status"], "not_applicable")

    def test_changed_items_in_a_filed_report_with_no_consumer_are_gaps(self):
        # Demo Bank files the FFIEC 041 by rule, so its RCON item counts too.
        result = self.assess("y9c-edit", registry=registry_with(("BHCK2170", ["gl"])))
        self.assertEqual(result["applicability"]["status"], "applies")
        self.assertEqual(result["gaps"], {"unmapped": 2, "codes": ["BHCK3210", "RCON2170"], "by_form": {"FFIEC 041": 1, "FR Y-9C": 1}})
        self.assertIn("1 consumer", result["priority"]["reasons"])
        no_call_report = self.assess("y9c-edit", profile(reports=[{"form": "FFIEC 041", "files": False}]))
        self.assertEqual(no_call_report["gaps"], {"unmapped": 2, "codes": ["BHCK2170", "BHCK3210"], "by_form": {"FR Y-9C": 2}})
        mapped = self.assess("y9c-edit", registry=R.validate({"schema_version": 1, "consumers": [{"id": "gl", "kind": "table", "name": "GL"}],
                                                              "rules": [{"match": "BHCK*", "scheme": "MDRM", "consumers": ["gl"]},
                                                                        {"match": "RCON*", "scheme": "MDRM", "consumers": ["gl"]}]}))
        self.assertIsNone(mapped["gaps"])

    def test_priority_bands_and_reasons(self):
        blocking = self.assess("y9c-edit")["priority"]
        self.assertEqual(blocking["band"], 1)
        self.assertEqual(blocking["reasons"][:2], ["Blocking edit changed", "effective Q1 2027"])
        later = self.assess("quality-later")["priority"]
        self.assertEqual((later["band"], later["reasons"]), (2, ["Edit check changed", "effective Q4 2027"]))
        soon = A.assess({**FACTS["quality-later"], "effective": {"quarter": "Q1 2027", "date": "2027-01-01"}}, profile(), R.empty(), LIBRARY, today=TODAY)
        self.assertEqual(soon["priority"]["band"], 1)
        self.assertGreater(blocking["score"], soon["priority"]["score"])
        self.assertEqual(self.assess("nothing")["priority"]["band"], 3)


class ProfileTest(unittest.TestCase):
    def test_validation(self):
        kinds = LIBRARY.kinds
        cases = [({"entities": [{"id": "Bad Id", "kind": "bhc"}]}, "lower-case"),
                 ({"entities": [{"id": "a", "kind": "martian"}]}, "kind must be one of"),
                 ({"entities": [{"id": "a", "kind": "bhc", "parent": "b"}]}, "not in the profile"),
                 ({"entities": [{"id": "a", "kind": "bhc", "total_assets": -1}]}, "non-negative"),
                 ({"entities": [{"id": "a", "kind": "bhc", "category": "V"}]}, "category"),
                 ({"entities": [{"id": "a", "kind": "bhc", "foreign_offices": "yes"}]}, "true, false"),
                 ({"reports": [{"form": "FR Y-9C"}, {"form": "FR Y-9C"}]}, "listed twice"),
                 ({"reports": [{"form": "FR Y-9C", "entity": "ghost"}]}, "not in the profile"),
                 ({"surprise": 1}, "Unknown profile keys")]
        for payload, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(P.ProfileError) as caught:
                    P.validate(payload, kinds=kinds)
                self.assertIn(message, str(caught.exception))
        clean = P.validate({"entities": [{"id": "a", "name": "  A  Co ", "kind": "bhc", "total_assets": 5e9, "foreign_offices": None}]}, kinds=kinds)
        self.assertEqual(clean["entities"], [{"id": "a", "name": "A Co", "kind": "bhc", "total_assets": 5000000000}])

    def test_the_shipped_profile_is_empty_so_nothing_changes_until_it_is_filled(self):
        shipped = P.load(ROOT / "config" / "profile.json")
        self.assertFalse(A.has_profile(shipped))

    def event(self, body, login="owner", title=P.REQUEST_TITLE + ": Demo"):
        return {"issue": {"user": {"login": login}, "title": title, "body": body}, "repository": {"owner": {"login": "owner"}}}

    def test_an_owner_issue_replaces_the_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            shutil.copy(ROOT / "config" / "reports.json", root / "config")
            body = P.REQUEST_MARKER + "\n\n```json\n" + json.dumps({"version": 1, "summary": "Demo", "profile": DEMO}) + "\n```\n"
            result = P.apply_event(self.event(body), root=root, now="2026-10-31T10:00:00+00:00")
            self.assertEqual(result["summary"], "2 entities, 0 reports filed")
            saved = json.loads((root / "config" / "profile.json").read_text())
            self.assertEqual(saved["updated_at"], "2026-10-31T10:00:00+00:00")
            self.assertEqual(P.apply_event(self.event(body), root=root)["changed"], False)
            with self.assertRaises(P.ProfileError):
                P.apply_event(self.event(body, login="someone"), root=root)
            with self.assertRaises(P.ProfileError):
                P.apply_event(self.event("no marker"), root=root)
            bad = P.REQUEST_MARKER + "\n```json\n" + json.dumps({"version": 1, "profile": {"entities": [{"id": "x", "kind": "martian"}]}}) + "\n```"
            with self.assertRaises(P.ProfileError):
                P.apply_event(self.event(bad), root=root)

    def test_the_workflow_only_runs_for_the_owner_and_commits_only_the_profile(self):
        workflow = (ROOT / ".github" / "workflows" / "profile-update.yml").read_text()
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("startsWith(github.event.issue.title, '[ChangeSentinel] Profile update')", workflow)
        self.assertIn("python -m regmon.profile apply-issue", workflow)
        self.assertIn("git add -- config/profile.json", workflow)
        self.assertNotIn("registry", workflow)

    def test_pages_publishes_the_assessment_files(self):
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        for path in ("data/change-facts.json", "config/reports.json", "config/profile.json"):
            with self.subTest(path=path):
                self.assertIn('"' + path + '"', pages)
                self.assertIn(path, pages.split("for f in ")[-1].split("; do")[0] + pages.split("Phase 3 assessment")[1].split("done")[0])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ParityTest(unittest.TestCase):
    """L.assessChange in the dashboard gives exactly what assess() gives."""

    def run_js(self, facts: dict, profiles: list[dict], registry_payload: dict) -> list:
        lib = ROOT / "dashboard-lib.js"
        library = json.loads((ROOT / "config" / "reports.json").read_text())
        script = (f"const L = require({json.dumps(str(lib))});"
                  f"const facts = {json.dumps(facts)}; const profiles = {json.dumps(profiles)}; const library = L.reportLibrary({json.dumps(library)});"
                  f"const model = L.registryModel({json.dumps(registry_payload)}, null);"
                  "const out = profiles.map(p => Object.keys(facts).sort().map(id => [id, L.assessChange(facts[id], p, model, library, '2026-10-31')]));"
                  "const forms = profiles.map(p => library.reports.size && Array.from(library.reports.keys()).concat(['FR VV-1']).map(f => [f, L.assessReportStatus(f, p, library)]));"
                  "console.log(JSON.stringify({out, forms}));")
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
            handle.write(script)
        self.addCleanup(Path(handle.name).unlink)
        return json.loads(subprocess.run([NODE, handle.name], capture_output=True, text=True, timeout=60, check=True).stdout)

    def test_same_results_on_fixtures_and_on_the_real_record(self):
        real = A.load(ROOT / "data")["events"]
        facts = {**FACTS, **real}
        payload = {"schema_version": 1, "consumers": [{"id": "gl", "kind": "table", "name": "GL"}],
                   "items": [{"code": "BHCK2170", "scheme": "MDRM", "consumers": ["gl"]}], "rules": [{"match": "RCON*", "scheme": "MDRM", "consumers": ["gl"]}]}
        registry = R.validate(payload)
        profiles = [P.empty(), profile(), profile(reports=[{"form": "FFIEC 041", "files": True}, {"form": "TIC", "files": False, "note": "Below threshold"}], reports_complete=True),
                    P.validate({"entities": [{"id": "c", "name": "Maple Bank", "kind": "ca_bank", "total_assets": 12e9, "currency": "CAD"}], "reports": []}, kinds=LIBRARY.kinds),
                    P.validate({"entities": [{"id": "b", "name": "Small Bank", "kind": "bank", "total_assets": 2e9}], "reports": []}, kinds=LIBRARY.kinds)]
        js = self.run_js(facts, profiles, payload)
        for index, prof in enumerate(profiles):
            py = [[event_id, A.assess(facts[event_id], prof, registry, LIBRARY, today=TODAY)] for event_id in sorted(facts)]
            with self.subTest(profile=index):
                self.assertEqual(js["out"][index], json.loads(json.dumps(py)))
                forms = list(LIBRARY.reports) + ["FR VV-1"]
                self.assertEqual(js["forms"][index], [[form, A.report_status(form, prof, LIBRARY)] for form in forms])

    def test_the_editor_request_is_applied_by_the_workflow(self):
        lib = ROOT / "dashboard-lib.js"
        script = (f"const L = require({json.dumps(str(lib))}); console.log(JSON.stringify(L.profileRequest({json.dumps(DEMO)})));")
        request = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)
        self.assertEqual(request["errors"], [])
        self.assertTrue(request["title"].startswith(P.REQUEST_TITLE))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            shutil.copy(ROOT / "config" / "reports.json", root / "config")
            event = {"issue": {"user": {"login": "o"}, "title": request["title"], "body": request["body"]}, "repository": {"owner": {"login": "o"}}}
            self.assertTrue(P.apply_event(event, root=root)["changed"])
            self.assertEqual(json.loads((root / "config" / "profile.json").read_text())["entities"], P.validate(DEMO, kinds=LIBRARY.kinds)["entities"])


class ScanTest(unittest.TestCase):
    def test_a_scan_writes_change_facts_and_state_validation_checks_them(self):
        from unittest.mock import patch
        from engine_harness import Sandbox, ok
        from regmon import engine
        from regmon.config import SourceConfig
        url = "https://www.example.gov/FFIEC041_instructions.html"
        source = SourceConfig(id="call", name="FFIEC 041 instructions", regulator="Example", seed_urls=(url,),
                              allowed_prefixes=("https://www.example.gov/",), allowed_domains=("www.example.gov",), allowed_urls=(url,))
        with Sandbox(source=source) as sandbox:
            sandbox.scan(lambda *a, **k: ok(b"<html><body><p>Line 1: total assets</p></body></html>", "text/html"))
            result = sandbox.scan(lambda *a, **k: ok(b"<html><body><p>Line 1: total assets, revised</p></body></html>", "text/html"))
            with patch("regmon.engine.load_config", return_value=({}, {source.id: source})):
                engine.save_outputs([result], "assess-run")
            facts = A.load(engine.DATA)["events"]
            self.assertTrue(facts)
            self.assertEqual({row["form"] for one in facts.values() for row in one["forms"]}, {"FFIEC 041"})


class ItemChangesTest(unittest.TestCase):
    """A new version of a data dictionary or edit checklist, read by the catalog's readers."""

    def test_dictionary_and_checklist_versions_give_item_changes_codes_and_severity(self):
        from test_catalog import MDRM_TEXT, RULE_TABLE
        newer = MDRM_TEXT.replace("The sum of all asset items.", "The sum of all asset items, revised.") + \
            "BHCKC999 | BHCK | C999 | 3/31/2027 12:00:00 AM | 12/31/9999 12:00:00 AM | NEW ITEM | A new item.\n"
        moved = json.loads(json.dumps(RULE_TABLE))
        moved["rows"][0]["reads"] = ["BHCK4107"]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "snapshots").mkdir(parents=True)
            (root / "data" / "rule-tables").mkdir(parents=True)
            (root / "data" / "snapshots" / "u1-a.txt").write_text(MDRM_TEXT)
            (root / "data" / "snapshots" / "u1-b.txt").write_text(newer)
            (root / "data" / "rule-tables" / "u2-r1.json").write_text(json.dumps(RULE_TABLE))
            (root / "data" / "rule-tables" / "u2-r2.json").write_text(json.dumps(moved))
            (root / "data" / "snapshots" / "u2-c.txt").write_text("checklist")
            (root / "data" / "snapshots" / "u2-d.txt").write_text("checklist")
            entry = {"event_id": "e", "event_type": "CHANGED_URL", "timestamp": "2026-11-01T00:00:00+00:00"}
            dictionary = {"before": {"snapshot_location": "data/snapshots/u1-a.txt"}, "after": {"snapshot_location": "data/snapshots/u1-b.txt"}}
            facts = A.event_facts(entry, {"url_id": "u1", "canonical_url": "https://x.gov/MDRM.zip"}, {"id": "m", "name": "MDRM data dictionary"},
                                  dictionary, LIBRARY, TEMPLATES, root=root)
            codes = {code: change for code, change, _q, _f in facts["codes"]}
            self.assertEqual(codes, {"BHCK2170": "amended", "BHCKC999": "added"})
            self.assertEqual([code[2] for code in facts["codes"] if code[0] == "BHCKC999"], ["Q1 2027"])
            self.assertEqual(facts["items"], {"count": 2, "changes": {"added": 1, "amended": 1}, "edits": 0})
            self.assertEqual(facts["severity"]["kind"], "item")
            self.assertIn({"form": "FR Y-9C", "basis": ["codes"]}, facts["forms"])
            checklist = {"before": {"snapshot_location": "data/snapshots/u2-c.txt", "raw_hash": "r1"},
                         "after": {"snapshot_location": "data/snapshots/u2-d.txt", "raw_hash": "r2"}}
            facts = A.event_facts(entry, {"url_id": "u2", "canonical_url": "https://x.gov/FRY9C_checklist.pdf"}, {"id": "c", "name": "FR Y-9C edits"},
                                  checklist, LIBRARY, TEMPLATES, root=root)
            self.assertEqual(facts["severity"]["kind"], "edit")
            self.assertEqual(sorted(code[0] for code in facts["codes"]), ["BHCK4073"])  # no longer read by edit 1090
            same = A.event_facts(entry, {"url_id": "u2"}, {"id": "c"}, {"before": checklist["before"], "after": checklist["before"]}, LIBRARY, TEMPLATES, root=root)
            self.assertNotIn("codes", same)


class LibraryCoverageTest(unittest.TestCase):
    def test_more_fed_reports_and_conditions_left_to_the_instructions(self):
        prof = profile()
        self.assertEqual(status("FR Y-6", prof)["status"], "files")
        self.assertEqual(status("FR Y-10", prof)["status"], "files")
        self.assertEqual(status("FR Y-12", prof)["status"], "eligible")  # files the Y-9C; the instructions add conditions
        self.assertEqual(status("FR Y-7Q", prof)["status"], "not_filed")
        self.assertEqual(status("FR VV-1", prof)["status"], "not_filed")
        fbo = P.validate({"entities": [{"id": "f", "name": "Global Bank plc", "kind": "fbo", "trading": 30e9}], "reports": []}, kinds=LIBRARY.kinds)
        self.assertEqual(status("FR Y-7", fbo)["status"], "files")
        self.assertEqual(status("FR VV-1", fbo)["status"], "files")
        y8 = status("FR Y-8", fbo)
        self.assertEqual(y8["status"], "unknown")
        self.assertIn("depends on conditions in the instructions", y8["reason"])
        self.assertEqual(status("FR Y-8", P.validate({**fbo, "reports_complete": True}, kinds=LIBRARY.kinds))["status"], "not_filed")


class AlertsTest(unittest.TestCase):
    """Alerts and digests say whether a change applies; a profile can mute what doesn't."""

    def workspace(self, tmp: str, **profile_changes) -> tuple[Path, Path]:
        root = Path(tmp)
        data, config = root / "data", root / "config"
        data.mkdir()
        config.mkdir()
        for name in ("reports.json", "registry-templates.json"):
            shutil.copy(ROOT / "config" / name, config)
        (config / "sources.json").write_text(json.dumps({"sources": [{"id": "y14", "name": "FR Y-14Q instructions"}, {"id": "y9c", "name": "FR Y-9C instructions"}]}))
        (config / "profile.json").write_text(P.dumps(profile(**profile_changes)))
        (config / "registry.json").write_text(json.dumps({"schema_version": 1}))
        return data, config

    def report(self):
        events = [{"event_id": "a" * 64, "event_type": "CHANGED_URL", "source_id": "y14", "url": "https://x.gov/FRY14Q_i.pdf", "timestamp": "2026-10-31T00:00:00+00:00"},
                  {"event_id": "b" * 64, "event_type": "CHANGED_URL", "source_id": "y9c", "url": "https://x.gov/FRY9C_i.pdf", "timestamp": "2026-10-31T00:00:00+00:00"},
                  {"event_id": "c" * 64, "event_type": "FETCH_ERROR", "source_id": "y9c", "url": "https://x.gov/FRY9C_i.pdf", "timestamp": "2026-10-31T00:00:00+00:00"}]
        output = [{"event_id": event["event_id"], "kind": event["event_type"], "summary": "s"} for event in events]
        return {"events": events}, output

    def test_alerts_carry_the_assessment_and_muting_drops_what_does_not_apply(self):
        from regmon import notify
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.workspace(tmp)
            report, output = self.report()
            labelled = notify._with_applicability(report, output, A.Assessor(data, config, today=TODAY))
            self.assertEqual(len(labelled), 3)
            self.assertTrue(labelled[0]["applicability"].startswith("Not applicable: FR Y-14Q doesn't apply"))
            self.assertTrue(labelled[1]["applicability"].startswith("Applies (P3): FR Y-9C applies to Demo Bancorp"))
            self.assertNotIn("applicability", labelled[2])
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.workspace(tmp, alerts={"not_applicable": "mute"})
            report, output = self.report()
            muted = notify._with_applicability(report, output, A.Assessor(data, config, today=TODAY))
            self.assertEqual([item["event_id"][0] for item in muted], ["b", "c"])
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.workspace(tmp, entities=[], reports=[])
            report, output = self.report()
            self.assertEqual(notify._with_applicability(report, output, A.Assessor(data, config)), output)

    def test_alert_channels_show_the_line(self):
        from regmon import channels
        self.assertIn(("Applies to you", "applicability"), channels.FIELDS)
        payload = channels.webhook_payload({"event_id": "e", "kind": "CHANGED_URL", "applicability": "Applies (P1): x"}, "")
        self.assertEqual(payload["alert"]["applicability"], "Applies (P1): x")

    def test_the_mcp_tool_answers_from_the_profile(self):
        from regmon import mcp_server
        result = mcp_server.change_assessment(mcp_server.Record(ROOT), {"limit": 3})
        self.assertIn("basis", result)
        self.assertLessEqual(len(result["changes"]), 3)
        self.assertEqual(result["profile"]["set_up"], A.has_profile(P.load(ROOT / "config" / "profile.json")))

    def test_profile_alert_setting_is_validated(self):
        self.assertEqual(profile(alerts={"not_applicable": "mute"})["alerts"], {"not_applicable": "mute"})
        self.assertNotIn("alerts", profile(alerts={"not_applicable": "label"}))
        with self.assertRaises(P.ProfileError):
            profile(alerts={"not_applicable": "drop"})

    def test_digest_lines_say_what_does_not_apply(self):
        from regmon import digest
        record = {"id": "d-1", "digest_id": "d", "workspace": "*", "frequency": "daily", "overview": "o", "counts": {"changes": 2, "relevant": 1},
                  "items": [{"monitor": "FR Y-9C", "summary": "Edits revised", "event_type": "CHANGED_URL", "quote": "", "relevant": True, "applies": "applies", "priority": 1},
                            {"monitor": "FR Y-14Q", "summary": "", "event_type": "CHANGED_URL", "quote": "", "relevant": None, "applies": "not_applicable", "priority": 0}],
                  "period": {"from": "2026-10-30T00:00:00+00:00", "to": "2026-10-31T00:00:00+00:00"}}
        text = json.dumps(digest.notification_for(record))
        self.assertIn("Edits revised (applies, P1)", text)
        self.assertIn("\\u2013 FR Y-14Q: changed url (doesn't apply to you)", text)
