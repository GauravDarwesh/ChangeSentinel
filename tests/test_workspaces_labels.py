"""Workspaces, labels, dashboard filters and settings presets."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from regmon import monitor_settings, register_monitor
from regmon.config import SourceConfig

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def source(source_id="a", **extra):
    return {
        "id": source_id, "name": source_id.upper(), "regulator": "Reg", "active": True,
        "seed_urls": [f"https://reg.test/{source_id}"], "allowed_prefixes": ["https://reg.test/"],
        "allowed_domains": ["reg.test"], **extra,
    }


def settings_issue(payload):
    body = monitor_settings.REQUEST_MARKER + "\n\nSETTINGS_JSON:\n" + json.dumps(payload, ensure_ascii=False) + "\n\nThis request was created from the ChangeSentinel dashboard."
    return {"issue": {"title": "[ChangeSentinel] Update monitors (1)", "user": {"login": "owner"}, "body": body}}


class ConfigTests(unittest.TestCase):
    def test_workspace_and_labels_are_read(self):
        config = SourceConfig.from_dict(source(workspace="LATAM", labels=["BCB 5050", "São Paulo", "FR Y-9C"]))
        self.assertEqual(config.workspace, "LATAM")
        self.assertEqual(config.labels, ("BCB 5050", "São Paulo", "FR Y-9C"))

    def test_invalid_names_are_rejected(self):
        for extra in (
            {"workspace": ""}, {"workspace": "<script>"}, {"workspace": "x" * 41},
            {"labels": "Specs"}, {"labels": ["a,b"]}, {"labels": ["Specs", "specs"]},
            {"labels": ["-lead"]}, {"labels": ["two  spaces"]}, {"labels": [f"l{i}" for i in range(13)]},
        ):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                SourceConfig.from_dict(source(**extra))


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "sources.json"
        self.path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [
            source("a", labels=["Specs", "Draft"]), source("b", workspace="EMEA"),
        ]}), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def sources(self):
        return {item["id"]: item for item in json.loads(self.path.read_text(encoding="utf-8"))["sources"]}

    def test_labels_are_added_and_removed_without_losing_others(self):
        monitor_settings.update_from_issue(settings_issue({
            "monitors": ["a", "b"], "add_labels": ["Q1 2027", "specs"], "remove_labels": ["draft"],
        }), self.path, "owner/repo")
        self.assertEqual(self.sources()["a"]["labels"], ["Specs", "Q1 2027"])
        self.assertEqual(self.sources()["b"]["labels"], ["Q1 2027", "specs"])

    def test_workspace_is_set_and_cleared(self):
        monitor_settings.update_from_issue(settings_issue({"monitors": ["a"], "set": {"workspace": "NTS"}}), self.path, "owner/repo")
        self.assertEqual(self.sources()["a"]["workspace"], "NTS")
        monitor_settings.update_from_issue(settings_issue({"monitors": ["b"], "clear": ["workspace"]}), self.path, "owner/repo")
        self.assertNotIn("workspace", self.sources()["b"])

    def test_removing_every_label_drops_the_key(self):
        monitor_settings.update_from_issue(settings_issue({"monitors": ["a"], "remove_labels": ["Specs", "Draft"]}), self.path, "owner/repo")
        self.assertNotIn("labels", self.sources()["a"])

    def test_invalid_label_writes_nothing(self):
        before = self.path.read_text(encoding="utf-8")
        for payload in (
            {"monitors": ["a"], "add_labels": ["<b>"]},
            {"monitors": ["a"], "add_labels": [f"x{i}" for i in range(11)]},
            {"monitors": ["a"], "set": {"labels": ["x"]}, "add_labels": ["y"]},
            {"monitors": ["a"], "add_labels": "Specs"},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                monitor_settings.update_from_issue(settings_issue(payload), self.path, "owner/repo")
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_a_preset_sets_schedule_and_adds_labels_together(self):
        monitor_settings.update_from_issue(settings_issue({
            "monitors": ["a", "b"], "set": {"check_every_hours": 24, "check_days": ["mon", "tue", "wed", "thu", "fri"]},
            "clear": ["check_hours", "check_timezone"], "add_labels": ["Specs"],
        }), self.path, "owner/repo")
        self.assertEqual(self.sources()["b"]["check_every_hours"], 24)
        self.assertEqual(self.sources()["b"]["labels"], ["Specs"])
        self.assertEqual(self.sources()["a"]["labels"], ["Specs", "Draft"])


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "sources.json"
        self.path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
        patches = [
            mock.patch.object(register_monitor, "_resolve_redirects", side_effect=lambda url: url),
            mock.patch.object(register_monitor, "_fetch_page_metadata", return_value={"title": "Page"}),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.temporary.cleanup()

    def sources(self):
        return json.loads(self.path.read_text(encoding="utf-8"))["sources"]

    def test_single_request_carries_workspace_and_labels(self):
        body = "\n".join([
            register_monitor.REQUEST_MARKER, "", "URL: https://www.bcb.gov.br/estabilidadefinanceira/leiautedocumento5050",
            "Name: Layout 5050", "Crawl depth: 0", "Scout discovery: no", "Workspace: LATAM", "Labels: BCB 5050, Layouts",
            "Include selector: ", "Ignore selectors:", "(none)", "", "This request was created from the ChangeSentinel dashboard.",
        ])
        event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX + " request", "user": {"login": "owner"}, "body": body}}
        register_monitor.register_request(event, self.path, "owner/repo")
        created = self.sources()[0]
        self.assertEqual(created["workspace"], "LATAM")
        self.assertEqual(created["labels"], ["BCB 5050", "Layouts"])
        SourceConfig.from_dict(created)

    def test_bulk_rows_carry_their_own_workspace_labels_and_cadence(self):
        rows = [
            {"url": "https://www.sbs.gob.pe/sucave/formatos", "name": "SUCAVE", "workspace": "LATAM", "labels": "SUCAVE, Formats", "check_every_hours": 12},
            {"url": "https://www.federalreserve.gov/apps/reportingforms", "name": "FRB"},
        ]
        body = "\n".join([
            register_monitor.BULK_REQUEST_MARKER, "", "Labels: Imported", "", "BULK_DATA_JSON:", json.dumps(rows), "",
            "This request was created from the ChangeSentinel dashboard bulk upload.",
        ])
        event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX + " bulk request", "user": {"login": "owner"}, "body": body}}
        result = register_monitor.register_request(event, self.path, "owner/repo")
        self.assertEqual(result["created_count"], 2)
        by_url = {item["seed_urls"][0]: item for item in self.sources()}
        sucave = by_url["https://www.sbs.gob.pe/sucave/formatos"]
        self.assertEqual((sucave["workspace"], sucave["labels"], sucave["check_every_hours"]), ("LATAM", ["Imported", "SUCAVE", "Formats"], 12))
        frb = by_url["https://www.federalreserve.gov/apps/reportingforms"]
        self.assertEqual(frb["labels"], ["Imported"])
        self.assertNotIn("workspace", frb)

    def test_bad_row_settings_reject_the_whole_batch(self):
        rows = [{"url": "https://www.sbs.gob.pe/sucave/formatos", "check_every_hours": 5}]
        body = "\n".join([register_monitor.BULK_REQUEST_MARKER, "", "BULK_DATA_JSON:", json.dumps(rows), "", "This request was created from the ChangeSentinel dashboard bulk upload."])
        event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX + " bulk request", "user": {"login": "owner"}, "body": body}}
        with self.assertRaises(ValueError):
            register_monitor.register_request(event, self.path, "owner/repo")
        self.assertEqual(self.sources(), [])


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class DashboardLibTests(unittest.TestCase):
    def test_tag_rules_match_the_engine(self):
        names = ["BCB 5050", "São Paulo", "FR Y-9C", "Q1 2027", "<b>", "a,b", "-lead", "two  spaces", "x" * 41, "Specs/XBRL"]
        js = run_js("console.log(JSON.stringify(" + json.dumps(names) + ".map(L.validTag)));")
        python = []
        for name in names:
            try:
                SourceConfig.from_dict(source(labels=[name]))
                python.append(True)
            except ValueError:
                python.append(False)
        self.assertEqual(js, python)

    def test_workspace_falls_back_to_region_and_scope_filters(self):
        out = run_js(
            "const own = L.workspaceOf({ workspace: 'NTS' }, 'NAM'), auto = L.workspaceOf({}, 'LATAM'), none = L.workspaceOf({}, '');"
            "console.log(JSON.stringify([own, auto, none,"
            " L.scopeMatches({ workspace: 'LATAM', label: 'ALL' }, auto, []),"
            " L.scopeMatches({ workspace: 'ALL', label: 'specs' }, own, ['Specs']),"
            " L.scopeMatches({ workspace: 'NTS', label: 'Archive' }, own, ['Specs'])]));"
        )
        self.assertEqual(out[:3], [{"name": "NTS", "auto": False}, {"name": "LATAM", "auto": True}, {"name": "Other", "auto": True}])
        self.assertEqual(out[3:], [True, True, False])

    def test_presets_build_requests_the_workflow_accepts(self):
        out = run_js(
            "const ids = ['a', 'b'];"
            "console.log(JSON.stringify(L.SETTINGS_PRESETS.filter(p => !p.copy).map(p => L.presetPayload(ids, p, { timezone: 'America/Lima' }))"
            ".concat([L.presetPayload(ids, L.SETTINGS_PRESETS.find(p => p.copy), { from: { check_every_hours: 48, workspace: 'EMEA', labels: ['Specs'] } }),"
            " L.organisePayload(ids, { workspace: 'LATAM', add: ['Q1 2027'], remove: ['Draft'] })])));"
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [source("a", labels=["Draft"]), source("b")]}), encoding="utf-8")
            for payload in out:
                with self.subTest(payload=payload):
                    monitor_settings.update_from_issue(settings_issue(payload), path, "owner/repo")
            final = {item["id"]: item for item in json.loads(path.read_text(encoding="utf-8"))["sources"]}
        self.assertEqual(final["a"]["workspace"], "LATAM")
        self.assertEqual(final["a"]["check_every_hours"], 48)
        self.assertNotIn("Draft", final["a"]["labels"])
        self.assertIn("Q1 2027", final["b"]["labels"])


class DashboardContractTests(unittest.TestCase):
    def test_scope_selection_and_dialogs_are_wired(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertEqual(html.count("data-scope-bar"), 3)  # Pages, Changes, Health
        for element in ("selectMonitorsBtn", "selectBar", "organiseDialog", "organiseWorkspace", "organiseAdd", "presetDialog", "presetList", "presetCopyFrom"):
            self.assertIn('id="' + element + '"', html)
        self.assertIn('<option value="workspace">By workspace</option>', html)
        for hook in ("if (!inScope(item.source_id)) return false;", "if (!inScope(entrySourceId(entry))) return false;",
                     "healthMonitors().filter(monitor => inScope(String(monitor.source_id)))", "if (data.bulk === \"organise\") return openOrganise(ids);"):
            self.assertIn(hook, js)


if __name__ == "__main__":
    unittest.main()
