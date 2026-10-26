"""Measured precision: reviewer verdicts against what each monitor alerted,
the 95% ranges, tuning suggestions, missed-change reports, and the
dashboard's half of the same arithmetic."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from regmon import precision, reviews

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def event_id(n: int) -> str:
    return f"{n:064x}"


def history(entries: list[dict]) -> dict:
    return {"canonical_url": "https://example.test/page", "change_history": entries}


def change(n: int, **extra) -> dict:
    return {"event_id": event_id(n), "event_type": "CHANGED_URL", "timestamp": f"2026-10-{n:02d}T06:00:00+00:00", **extra}


NOISE = {"ai_relevant": True, "ai_topic": "Website navigation menu redesign", "ai_summary": "The navigation menu and footer links were redesigned."}
SIGNAL = {"ai_relevant": True, "ai_topic": "Filing deadline moved", "ai_summary": "The filing deadline for the quarterly submission moved to 45 days."}


def fixture():
    inventory = {"schema_version": 2, "sources": {
        "noisy": {"u1": history([change(1, **NOISE), change(2, **NOISE), change(3, **NOISE), change(4, **SIGNAL),
                                 change(5, ai_relevant=False, ai_topic="Filing deadline extension", ai_summary="Deadline for submission extended."),
                                 change(6, ai_relevant=False, ai_topic="Typo fix", ai_summary="A typo was corrected."),
                                 {**change(7), "event_type": "HTML_SOURCE_CHANGED"}, change(8, **SIGNAL)])},
        "strict": {"u2": history([change(11, ai_relevant=True, ai_condition_met=False, ai_topic="Validation rules for derivatives", ai_summary="New validation rules for derivatives exposures."),
                                  change(12, ai_relevant=True, ai_condition_met=False, ai_topic="Validation rules for derivatives", ai_summary="Validation rules for derivatives changed."),
                                  change(13, ai_relevant=True, ai_condition_met=True, ai_topic="Capital ratio threshold", ai_summary="Capital ratio threshold changed.")])},
        "shadowed": {"u3": history([change(21, ai_relevant=True), change(22, ai_relevant=False)])},
    }}
    sent = {event_id(n): {"kind": "CHANGED_URL", "variant": "ai"} for n in (1, 2, 3, 4, 13)}
    sent[event_id(8)] = {"kind": "CHANGED_URL", "variant": "generic"}
    sent[event_id(8) + "#ai"] = {"kind": "AI_ASSESSMENT", "variant": "ai"}
    decisions = {1: "not_material", 2: "not_material", 3: "not_material", 4: "material", 5: "action_required", 6: "not_material",
                 7: "not_material", 8: "acknowledged", 11: "material", 12: "material", 13: "material", 21: "not_material", 22: "material"}
    ledger = {"schema_version": 1, "reviews": {event_id(n): {"decision": d, "rationale": "x" * 12} for n, d in decisions.items()}, "log": [],
              "misses": [{"source_id": "strict", "description": "Missed a new schedule"}]}
    sources = [{"id": "noisy", "name": "Noisy page"},
               {"id": "strict", "name": "Strict page", "alert_condition": "Alert me when capital ratios change", "alert_only_on_condition": True,
                "check_every_hours": 24},
               {"id": "shadowed", "name": "Shadow page", "shadow": True}]
    return inventory, sent, ledger, sources


class TestScores(unittest.TestCase):
    def setUp(self):
        self.result = precision.build(*fixture())
        self.by_id = {row["source_id"]: row for row in self.result["monitors"]}

    def test_the_confusion_matrix_per_monitor(self):
        noisy = self.by_id["noisy"]
        self.assertEqual((noisy["tp"], noisy["fp"], noisy["fn"], noisy["tn"]), (1, 3, 1, 2))   # markup-only change is a quiet negative
        self.assertEqual(noisy["precision"], 0.25)
        self.assertEqual(noisy["recall"], 0.5)
        self.assertEqual(noisy["unreviewed_alerts"], 1)      # acknowledged is not counted
        strict = self.by_id["strict"]
        self.assertEqual((strict["tp"], strict["fn"], strict["missed"]), (1, 2, 1))
        self.assertEqual(strict["recall"], 0.25)

    def test_shadow_monitors_are_scored_on_what_would_have_alerted(self):
        shadowed = self.by_id["shadowed"]
        self.assertEqual((shadowed["fp"], shadowed["fn"]), (1, 1))

    def test_wilson_ranges(self):
        self.assertEqual(precision.wilson(1, 4), [0.046, 0.699])
        self.assertIsNone(precision.wilson(0, 0))
        self.assertEqual(self.by_id["noisy"]["precision_ci"], precision.wilson(1, 4))
        self.assertEqual(self.result["totals"]["tp"], 2)


class TestSuggestions(unittest.TestCase):
    def setUp(self):
        self.result = precision.build(*fixture())
        self.by_id = {row["source_id"]: row for row in self.result["monitors"]}

    def test_noise_becomes_an_exclusion_and_signal_a_condition(self):
        tip = self.by_id["noisy"]["suggestions"][0]
        self.assertEqual(tip["kind"], "add_condition")
        self.assertIn("filing, deadline", tip["condition"])
        self.assertIn("Ignore changes about navigation, menu", tip["condition"])
        self.assertTrue(tip["only"])
        self.assertIn("3 of 4 reviewed alerts were not material", tip["why"])
        self.assertIn("would also have alerted on 1 material change(s)", tip["why"])
        self.assertEqual([t["kind"] for t in self.by_id["noisy"]["suggestions"]], ["add_condition"])

    def test_a_condition_that_hid_material_changes_is_broadened(self):
        kinds = [tip["kind"] for tip in self.by_id["strict"]["suggestions"]]
        self.assertEqual(kinds, ["broaden_condition", "missed"])
        broaden = self.by_id["strict"]["suggestions"][0]
        self.assertEqual(broaden["condition"], "Alert me when capital ratios change. Also alert when it concerns validation, rules or derivatives.")
        self.assertIn("every 24 hours", self.by_id["strict"]["suggestions"][1]["why"])

    def test_no_suggestion_without_enough_evidence(self):
        inventory, sent, ledger, sources = fixture()
        ledger["reviews"] = {event_id(1): {"decision": "not_material"}}
        result = precision.build(inventory, sent, ledger, sources)
        noisy = next(row for row in result["monitors"] if row["source_id"] == "noisy")
        self.assertEqual(noisy["suggestions"], [])


class TestMissedReports(unittest.TestCase):
    BODY = "\n".join([reviews.MISSED_MARKER, "", "Monitor: strict", "URL: https://example.test/page", "Seen on: 2026-10-20",
                      "What was missed: A new schedule 40.250a was added", "Evidence: (none)"])

    def event(self, body: str, author: str = "owner") -> dict:
        return {"issue": {"number": 7, "title": "[ChangeSentinel] Change review: missed change on strict", "body": body, "user": {"login": author}},
                "repository": {"owner": {"login": "owner"}}}

    def test_a_report_is_appended_to_the_ledger(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config").mkdir()
            (root / "config" / "sources.json").write_text(json.dumps({"sources": [{"id": "strict"}]}), encoding="utf-8")
            data = root / "data"
            result = reviews.apply_event(self.event(self.BODY), data, now="2026-10-26T00:00:00+00:00")
            self.assertEqual(result, {"decision": "missed", "label": "Missed change", "count": 1})
            ledger = reviews.load_ledger(data)
            self.assertEqual(ledger["misses"][0]["source_id"], "strict")
            self.assertEqual(ledger["misses"][0]["seen_on"], "2026-10-20")
            self.assertEqual(ledger["misses"][0]["request"], "issue #7")
            with self.assertRaises(reviews.ReviewError):
                reviews.apply_event(self.event(self.BODY.replace("Monitor: strict", "Monitor: unknown")), data)
            with self.assertRaises(reviews.ReviewError):
                reviews.apply_event(self.event(self.BODY, author="someone"), data)
            with self.assertRaises(reviews.ReviewError):
                reviews.parse_missed(self.BODY.replace("A new schedule 40.250a was added", "short"))

    def test_an_older_ledger_without_misses_still_loads(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "reviews" / "ledger.json"
            path.parent.mkdir()
            path.write_text(json.dumps({"schema_version": 1, "reviews": {}, "log": []}), encoding="utf-8")
            self.assertEqual(reviews.load_ledger(Path(folder)).get("misses", []), [])


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestDashboardHalf(unittest.TestCase):
    def test_the_dashboard_computes_the_same_result(self):
        inventory, sent, ledger, sources = fixture()
        expected = precision.build(inventory, sent, ledger, sources)
        out = run_js("console.log(JSON.stringify(L.precisionBuild(" + ",".join(json.dumps(value) for value in (inventory, sent, ledger, sources)) + ")));")
        self.assertEqual(out, json.loads(json.dumps(expected)))

    def test_the_missed_request_is_what_the_workflow_parses(self):
        out = run_js("console.log(JSON.stringify(L.missedChangeRequest({monitor: 'strict', url: 'https://example.test/page', seenOn: '2026-10-20', "
                     "what: 'A new schedule 40.250a was added', evidence: ''})));")
        self.assertEqual(out["errors"], [])
        self.assertTrue(out["title"].startswith(reviews.TITLE_PREFIX))
        parsed = reviews.parse_missed(out["body"])
        self.assertEqual(parsed, {"source_id": "strict", "url": "https://example.test/page", "seen_on": "2026-10-20",
                                  "description": "A new schedule 40.250a was added", "evidence": ""})
        bad = run_js("console.log(JSON.stringify(L.missedChangeRequest({monitor: 'strict', what: 'x'}).errors));")
        self.assertEqual(bad, ["Say what was missed (at least 10 characters)."])


if __name__ == "__main__":
    unittest.main()
