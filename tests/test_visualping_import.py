"""Importing another tool's export, shadow mode, and the shadow comparison."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from regmon import health, monitor_settings, register_monitor
from regmon.config import SourceConfig
from regmon.notify import build_notifications

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def source(source_id="a", **extra):
    return {
        "id": source_id, "name": source_id.upper(), "regulator": "Reg", "active": True,
        "seed_urls": [f"https://reg.test/{source_id}"], "allowed_prefixes": ["https://reg.test/"],
        "allowed_domains": ["reg.test"], **extra,
    }


class ShadowModeTests(unittest.TestCase):
    def report(self, shadow: bool):
        return {
            "sources": [{"id": "quiet", "shadow": True} if shadow else {"id": "quiet"}, {"id": "loud"}],
            "events": [
                {"event_id": "e1", "event_type": "CHANGED_URL", "url": "https://reg.test/q", "source_id": "quiet"},
                {"event_id": "e2", "event_type": "CHANGED_URL", "url": "https://reg.test/l", "source_id": "loud"},
                {"event_id": "e3", "event_type": "FETCH_ERROR", "url": "https://reg.test/q", "source_id": "quiet",
                 "notification_id": "n3", "error_runs": 3, "evidence": {"error": "timeout"}},
            ],
            "ai_results": [],
            "error_alert_after_runs": 1,
        }

    def test_shadow_sources_send_no_change_alerts_but_keep_operational_ones(self):
        ids = {item["event_id"] for item in build_notifications(self.report(shadow=True))}
        self.assertEqual(ids, {"e2", "n3"})

    def test_without_shadow_every_alert_is_kept(self):
        ids = {item["event_id"] for item in build_notifications(self.report(shadow=False))}
        self.assertEqual(ids, {"e1", "e2", "n3"})

    def test_ai_alerts_of_a_shadow_source_are_muted(self):
        report = self.report(shadow=True)
        report["ai_results"] = [{"event_id": "e1", "event": "CHANGED_URL", "url": "https://reg.test/q", "ai": {"status": "ok", "analysis": {
            "relevant": True, "topic": "t", "change_type": "c", "summary": "s", "impact": "i", "effective_date": "d",
            "affected_scope": "a", "actions": "x", "reason": "r"}}}]
        self.assertNotIn("e1", {item["event_id"] for item in build_notifications(report)})

    def test_config_settings_and_health_carry_shadow(self):
        self.assertTrue(SourceConfig.from_dict(source(shadow=True)).shadow)
        with self.assertRaises(ValueError):
            SourceConfig.from_dict(source(shadow="yes"))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [source("a", shadow=True)]}), encoding="utf-8")
            body = monitor_settings.REQUEST_MARKER + "\n\nSETTINGS_JSON:\n" + json.dumps({"monitors": ["a"], "clear": ["shadow"]}) + "\n"
            monitor_settings.update_from_issue({"issue": {"title": "[ChangeSentinel] Update monitors (1)", "user": {"login": "o"}, "body": body}}, path, "o/r")
            self.assertNotIn("shadow", json.loads(path.read_text(encoding="utf-8"))["sources"][0])
        from datetime import datetime, timezone
        built = health.build_health({"sources": [source("a", shadow=True)]}, {"sources": {}}, [], {}, datetime.now(timezone.utc))
        self.assertTrue(built["monitors"][0]["shadow"])

    def test_bulk_request_starts_only_new_monitors_in_shadow(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            existing = source("manual-existing")
            existing["seed_urls"] = ["https://www.bcb.gov.br/existing"]
            existing["allowed_prefixes"] = ["https://www.bcb.gov.br/"]
            existing["allowed_domains"] = ["www.bcb.gov.br"]
            existing["allowed_urls"] = ["https://www.bcb.gov.br/existing"]
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [existing]}), encoding="utf-8")
            rows = [{"url": "https://www.bcb.gov.br/new", "name": "New"}, {"url": "https://www.bcb.gov.br/existing", "name": "Old"}]
            body = "\n".join([register_monitor.BULK_REQUEST_MARKER, "", "Shadow mode: yes", "", "BULK_DATA_JSON:", json.dumps(rows), "",
                              "This request was created from the ChangeSentinel dashboard bulk upload."])
            event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX + " bulk request", "user": {"login": "owner"}, "body": body}}
            with mock.patch.object(register_monitor, "_resolve_redirects", side_effect=lambda url: url), \
                    mock.patch.object(register_monitor, "_fetch_page_metadata", return_value={}):
                register_monitor.register_request(event, path, "owner/repo")
            by_url = {item["seed_urls"][0]: item for item in json.loads(path.read_text(encoding="utf-8"))["sources"]}
        self.assertTrue(by_url["https://www.bcb.gov.br/new"].get("shadow"))
        self.assertNotIn("shadow", by_url["https://www.bcb.gov.br/existing"])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ImportTests(unittest.TestCase):
    def test_frequencies_map_to_the_nearest_supported_cadence(self):
        texts = ["Every 12 hours", "Daily", "1 week", "720", "hourly", "5 minutes", "2 days", "Monthly", "every hour", "", "sometimes"]
        self.assertEqual(run_js("console.log(JSON.stringify(" + json.dumps(texts) + ".map(L.importFrequencyHours)));"),
                         [12, 24, 168, 12, 6, 6, 48, 168, 6, None, None])

    def test_an_export_is_read_by_its_headers(self):
        matrix = [
            ["Description", "URL", "Workspace", "Tags", "Check frequency", "Status", "Alert me when"],
            ["Leiaute 5050", "https://www.bcb.gov.br/leiaute5050?utm_source=x", "LATAM", "BCB; Layouts", "Every 12 hours", "Active", "A field changes"],
            ["Paused one", "https://www.bcb.gov.br/old", "LATAM", "", "Daily", "Paused", ""],
            ["Known", "https://www.federalreserve.gov/apps/reportingforms/review", "NAM", "", "", "", ""],
            ["Dup", "https://www.bcb.gov.br/leiaute5050", "LATAM", "", "", "", ""],
            ["Bad tag", "https://www.sbs.gob.pe/x", "<b>", "", "", "", ""],
            ["Not a url", "ftp://x", "", "", "", "", ""],
        ]
        out = run_js("const known = new Set([L.canonicalUrl('https://www.federalreserve.gov/apps/reportingforms/review')]);"
                     "console.log(JSON.stringify(L.importRows(" + json.dumps(matrix) + ", known)));")
        self.assertEqual(len(out["rows"]), 1)
        row = out["rows"][0]
        self.assertEqual((row["workspace"], row["labels"], row["check_every_hours"]), ("LATAM", ["BCB", "Layouts"], 12))
        self.assertNotIn("utm_source", row["url"])
        self.assertEqual([entry["name"] for entry in out["skipped"]["paused"]], ["Paused one"])
        self.assertEqual([entry["name"] for entry in out["skipped"]["existing"]], ["Known"])
        self.assertEqual(out["conditions"], 1)
        self.assertEqual(len(out["errors"]), 2)

    def test_a_paused_column_means_yes_is_paused(self):
        # "Paused: Yes" is paused; "Active: No" / "Status: Paused" are paused too.
        out = run_js(
            "const rows = h => L.importRows([['URL', h], ['https://www.bcb.gov.br/a', 'Yes'], ['https://www.bcb.gov.br/b', 'No'], ['https://www.bcb.gov.br/c', 'false']], new Set());"
            "const names = r => [r.rows.map(x => x.url.slice(-1)), r.skipped.paused.map(x => x.url.slice(-1))];"
            "console.log(JSON.stringify([names(rows('Paused')), names(rows('Active'))]));"
        )
        self.assertEqual(out[0], [["b", "c"], ["a"]])
        self.assertEqual(out[1], [["a"], ["b", "c"]])

    def test_a_plain_list_still_imports(self):
        out = run_js("console.log(JSON.stringify(L.importRows([['https://www.bcb.gov.br/a', 'Page A']], new Set())));")
        self.assertEqual(out["rows"][0]["name"], "Page A")
        self.assertFalse(out["header"])

    def test_imported_rows_are_accepted_by_registration(self):
        out = run_js("console.log(JSON.stringify(L.importRows([['URL','Name','Workspace','Labels','Frequency'],"
                     "['https://www.sbs.gob.pe/sucave','SUCAVE','LATAM','SUCAVE','Daily']], new Set()).rows));")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            body = "\n".join([register_monitor.BULK_REQUEST_MARKER, "", "BULK_DATA_JSON:", json.dumps(out), "",
                              "This request was created from the ChangeSentinel dashboard bulk upload."])
            event = {"issue": {"title": register_monitor.ISSUE_TITLE_PREFIX + " bulk request", "user": {"login": "owner"}, "body": body}}
            with mock.patch.object(register_monitor, "_resolve_redirects", side_effect=lambda url: url), \
                    mock.patch.object(register_monitor, "_fetch_page_metadata", return_value={}):
                register_monitor.register_request(event, path, "owner/repo")
            created = json.loads(path.read_text(encoding="utf-8"))["sources"][0]
        self.assertEqual((created["workspace"], created["labels"], created["check_every_hours"]), ("LATAM", ["SUCAVE"], 24))


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class ShadowCompareTests(unittest.TestCase):
    def test_matches_misses_and_unmonitored_pages(self):
        out = run_js("""
const h = 3600000, t = Date.UTC(2026, 9, 20, 12);
const theirs = [
  { url: 'https://reg.test/a', at: t }, { url: 'https://reg.test/a', at: t + 2 * h },
  { url: 'https://reg.test/b', at: t }, { url: 'https://other.test/x', at: t }
];
const ours = [{ url: 'https://reg.test/a', at: t + 5 * h, event_type: 'CHANGED_URL' }, { url: 'https://reg.test/c', at: t, event_type: 'CHANGED_URL' },
  { url: 'https://reg.test/a', at: t + 30 * 24 * h, event_type: 'CHANGED_URL' }];
const r = L.shadowCompare(theirs, ours, new Set(['https://reg.test/a', 'https://reg.test/b', 'https://reg.test/c']));
console.log(JSON.stringify({ totals: r.totals, lag: r.medianLagHours, only: r.theirsOnly.map(x => x.url), mine: r.oursOnly.map(x => x.url) }));
""")
        self.assertEqual(out["totals"]["both"], 1)
        self.assertEqual(out["totals"]["ours"], 2)  # the change a month later is outside the period
        # Visualping's second alert on /a two hours later is a repeat of the
        # change already matched, not a miss.
        self.assertEqual(out["only"], ["https://reg.test/b"])
        self.assertEqual(out["totals"]["repeats"], 1)
        self.assertEqual(out["mine"], ["https://reg.test/c"])
        self.assertEqual(out["totals"]["notMonitored"], 1)
        # The earliest Visualping alert is paired first, so the lag is from it.
        self.assertEqual(out["lag"], 5)

    def test_alert_history_rows_are_read_with_dates(self):
        out = run_js("console.log(JSON.stringify(L.shadowRows([['Job','URL','Date','Workspace'],['x','https://reg.test/a','2026-10-22 03:10','NAM'],"
                     "['y','https://reg.test/b', 46317.5, ''],['z','', '2026-10-22','']])));")
        self.assertEqual(len(out["rows"]), 2)
        self.assertEqual(out["unreadable"], 1)
        self.assertEqual(out["rows"][0]["workspace"], "NAM")
        self.assertIn("error", run_js("console.log(JSON.stringify(L.shadowRows([['Page','When'],['a','b']])));"))


class ContractTests(unittest.TestCase):
    def test_import_and_comparison_are_wired(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for element in ("bulkImportSummary", "bulkImportOptions", "bulkShadow", "bulkRequests", "shadowEntry", "organiseAlerts"):
            self.assertIn('id="' + element + '"', html)
        for hook in ("L.importRows(matrix, known)", 'if (organise && organise.shadow) bodyLines.push("Shadow mode: yes");',
                     "if (state.selectedNotificationId === SHADOW_KEY) return renderShadowDetail(pane);",
                     'if (event.target.id === "shadowFile") readShadowFile(', "L.shadowCompare(parsed.rows, shadowOurChanges(), shadowMonitoredUrls()"):
            self.assertIn(hook, js)
        # The alert export is read locally, never posted anywhere.
        start = js.index("/* ================= Shadow comparison with Visualping")
        module = js[start:js.index("/* ================= Alert channels", start)]
        self.assertNotIn("fetch(", module)


if __name__ == "__main__":
    unittest.main()
