"""Dashboard UI for alert conditions, fleet health and alert channels.

The requests the dashboard builds are run through the real owner workflow
parser, so a UI field the workflow cannot read fails here, not in production.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from regmon.config import SourceConfig

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
CONDITION = "A new XML user guide is added"


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def js_function(source: str, name: str) -> str:
    start = source.index("function " + name + "(")
    depth, index = 0, source.index("{", start)
    while True:
        char = source[index]
        depth += char == "{"
        depth -= char == "}"
        index += 1
        if depth == 0:
            return source[start:index]


def issue_body(call: str) -> str:
    js = read("dashboard.js")
    script = (
        'const REPO = "https://github.com/o/r";\n'
        + 'const BULK_REQUEST_MARKER = "<!-- changesentinel:add-monitor-bulk:v1 -->";\n'
        + js_function(js, "makeGitHubIssueUrl") + "\n" + js_function(js, "makeBulkGitHubIssueUrl") + "\n"
        + "const url = new URL(" + call + ");\nprocess.stdout.write(url.searchParams.get('body'));"
    )
    return subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout


class TestMarkup(unittest.TestCase):
    def test_health_view_is_wired(self):
        html, js = read("index.html"), read("dashboard.js")
        for marker in ('data-view="health"', 'id="healthView"', 'id="healthItems"', 'id="healthDetail"',
                       'id="navHealthCount"', 'id="overviewHealth"', 'data-go="health"'):
            with self.subTest(marker=marker):
                self.assertIn(marker, html)
        self.assertRegex(js, r'const VIEWS = \[[^\]]*"health"')
        for fragment in ('health: "healthView"', 'health: "healthDetail"', 'else if (view === "health") renderHealthDetail();',
                         "renderHealth();", '[data-select-health]'):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, js)

    def test_condition_dialog_and_channel_guide_exist(self):
        html = read("index.html")
        for marker in ('id="conditionDialog"', 'id="conditionText"', 'id="conditionOnly"', 'id="conditionClear"',
                       'id="conditionSuggestions"', 'id="reviewCondition"', 'id="reviewConditionOnly"',
                       'id="newMonitorAlertCondition"', 'id="channelBar"', 'id="channelGuide"',
                       "SLACK_WEBHOOK_URL", "TEAMS_WEBHOOK_URL", "ALERT_WEBHOOK_URL"):
            with self.subTest(marker=marker):
                self.assertIn(marker, html)

    def test_phone_bar_keeps_eight_tabs(self):
        self.assertRegex(read("index.html"), r"\.nav-health \{ display: none; \}")


@unittest.skipUnless(NODE, "node is required to build the dashboard requests")
class TestRequestsRoundTrip(unittest.TestCase):
    def setUp(self):
        import regmon.register_monitor as module

        self.module = module
        self._resolve = module._resolve_redirects
        module._resolve_redirects = lambda url: url
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / "sources.json"
        source = {
            "id": "manual-abc", "name": "Guides", "regulator": "frbservices.org", "active": True,
            "seed_urls": ["https://www.frbservices.org/guides"], "allowed_urls": ["https://www.frbservices.org/guides"],
            "allowed_prefixes": ["https://www.frbservices.org/"], "allowed_domains": ["www.frbservices.org"],
            "include_selector": "main .content", "ignore_selectors": [".cookie"], "crawl_depth": 1,
        }
        self.config.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [source]}), encoding="utf-8")

    def tearDown(self):
        self.module._resolve_redirects = self._resolve
        self.tmp.cleanup()

    def register(self, body: str) -> dict:
        event = {"issue": {"title": "[ChangeSentinel] Add monitor request", "body": body, "user": {"login": "GauravDarwesh"}}}
        return self.module.register_request(event, self.config, "GauravDarwesh/ChangeSentinel")

    def source(self) -> dict:
        return json.loads(self.config.read_text())["sources"][0]

    def test_edit_and_clear_from_a_monitor_page(self):
        # The page's own selectors and depth are sent back, so the request edits
        # the existing monitor instead of being refused as a different one.
        edit = 'makeGitHubIssueUrl("https://www.frbservices.org/guides", "Guides", "main .content", [".cookie"], 1, false, ' \
               '{ condition: ' + json.dumps(CONDITION) + ', only: true })'
        self.register(issue_body(edit))
        source = self.source()
        self.assertEqual((source["alert_condition"], source["alert_only_on_condition"]), (CONDITION, True))
        self.assertEqual(source["crawl_depth"], 1)
        SourceConfig.from_dict(source)

        clear = 'makeGitHubIssueUrl("https://www.frbservices.org/guides", "Guides", "main .content", [".cookie"], 1, false, ' \
                '{ condition: "", only: false, clear: true })'
        result = self.register(issue_body(clear))
        self.assertNotIn("alert_condition", self.source())
        self.assertIn("cleared", result["message"])

    def test_request_without_condition_leaves_it_alone(self):
        self.register(issue_body(
            'makeGitHubIssueUrl("https://www.frbservices.org/guides", "Guides", "main .content", [".cookie"], 1, false, '
            '{ condition: ' + json.dumps(CONDITION) + ', only: false })'))
        self.register(issue_body('makeGitHubIssueUrl("https://www.frbservices.org/guides", "Guides", "main .content", [".cookie"], 1, false)'))
        self.assertEqual(self.source()["alert_condition"], CONDITION)

    def test_review_step_condition_applies_to_every_new_monitor(self):
        rows = [{"url": "https://www.bcb.gov.br/a", "name": "A"}, {"url": "https://www.bcb.gov.br/b", "name": "B"}]
        body = issue_body("makeBulkGitHubIssueUrl(" + json.dumps(rows) + ", { condition: " + json.dumps(CONDITION) + ", only: true })")
        event = {"issue": {"title": "[ChangeSentinel] Add monitor bulk request", "body": body, "user": {"login": "GauravDarwesh"}}}
        result = self.module.register_request(event, self.config, "GauravDarwesh/ChangeSentinel")
        created = [source for source in json.loads(self.config.read_text())["sources"] if source["id"] != "manual-abc"]
        self.assertEqual(len(created), 2)
        self.assertTrue(all(source["alert_condition"] == CONDITION and source["alert_only_on_condition"] for source in created))
        self.assertEqual(result["alert_conditions_changed"], 2)
        self.assertNotIn("alert_condition", self.source())

    def test_bulk_without_condition_is_unchanged(self):
        body = issue_body("makeBulkGitHubIssueUrl(" + json.dumps([{"url": "https://www.bcb.gov.br/a"}]) + ")")
        self.assertNotIn("Alert me when", body)
        self.assertTrue(re.search(r"BULK_DATA_JSON:\n\[", body))


if __name__ == "__main__":
    unittest.main()
