"""Behavioural tests for dashboard-lib.js, run through Node.

The redline, scan-cycle and LED-field logic decide what a reviewer sees, so
they are exercised directly rather than only pinned as source strings.
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def run_js(body: str):
    """Evaluate `body` with the library bound to `L`; it must print one JSON value."""
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestRedline(unittest.TestCase):
    DIFF = "\n".join([
        "--- before",
        "+++ after",
        "@@ -10,3 +10,3 @@",
        " Submission",
        "-Reports are due 30 calendar days after the as-of date.",
        "+Reports are due 15 calendar days after the as-of date.",
        " Questions",
        "@@ -40,2 +40,3 @@",
        " a",
        "+New <b>line</b>",
        " b",
    ])

    def test_a_one_word_edit_is_marked_inside_the_sentence(self):
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(self.DIFF) + ")));")
        self.assertIn("Reports are due <del>30</del><ins>15</ins> calendar days", out["html"])
        self.assertEqual(out["stats"], {"added": 1, "removed": 0, "edited": 1})
        self.assertEqual(out["summary"], "1 line edited, 1 line added")

    def test_scraped_markup_is_escaped(self):
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(self.DIFF) + ").html));")
        self.assertIn("New &lt;b&gt;line&lt;/b&gt;", out)
        self.assertNotIn("<b>", out)

    def test_unchanged_stretches_are_collapsed_between_hunks(self):
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(self.DIFF) + ").html));")
        self.assertIn("9 unchanged lines before this change", out)
        self.assertIn("27 unchanged lines", out)

    def test_removed_lines_carry_no_current_line_number(self):
        diff = "--- before\n+++ after\n@@ -5,3 +5,1 @@\n keep\n-gone one\n-gone two"
        rows = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(diff) + ").html));")
        self.assertIn('<span class="rl-no" aria-hidden="true"></span><span class="rl-text"><del aria-label="Removed line">gone one</del>', rows)
        self.assertIn('<span class="rl-no" aria-hidden="true">5</span><span class="rl-text">keep', rows)

    def test_a_rewritten_line_is_shown_as_removed_and_added(self):
        diff = "--- before\n+++ after\n@@ -1,1 +1,1 @@\n-Alpha beta gamma delta\n+Completely different wording here"
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(diff) + ").stats));")
        self.assertEqual(out, {"added": 1, "removed": 1, "edited": 0})

    def test_a_truncated_diff_says_so(self):
        diff = self.DIFF + "\n... diff truncated after 250 lines"
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(diff) + ")));")
        self.assertTrue(out["truncated"])
        self.assertIn("stops after 250 lines", out["html"])

    def test_an_empty_diff_explains_itself(self):
        out = run_js('console.log(JSON.stringify(L.renderRedline("")));')
        self.assertIn("No line-level text differences", out["html"])

    def test_the_real_fr_3033p_evidence_renders_as_four_removed_lines(self):
        evidence = ROOT / "data/evidence/1c4171c28c233d33130ce0a35bc8a04167020afadf1f11385d118c6b80e748e1.json"
        if not evidence.exists():
            self.skipTest("historical evidence file not present")
        diff = json.loads(evidence.read_text(encoding="utf-8"))["diff"]
        out = run_js("console.log(JSON.stringify(L.renderRedline(" + json.dumps(diff) + ").summary));")
        self.assertEqual(out, "4 lines removed")


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestScanSchedule(unittest.TestCase):
    def test_next_scan_follows_the_utc_six_hour_schedule(self):
        out = run_js('const c = L.scanCycle(new Date("2026-10-20T07:30:00Z")); console.log(JSON.stringify({next: c.next.toISOString(), progress: c.progress, remaining: c.remainingMinutes}));')
        self.assertEqual(out, {"next": "2026-10-20T12:00:00.000Z", "progress": 0.25, "remaining": 270})

    def test_exactly_on_a_slot_the_next_scan_is_six_hours_away(self):
        out = run_js('console.log(JSON.stringify(L.nextScheduledScan(new Date("2026-10-20T06:00:00Z")).toISOString()));')
        self.assertEqual(out, "2026-10-20T12:00:00.000Z")

    def test_scan_slots_end_with_the_slot_in_progress(self):
        out = run_js('const s = L.scanSlots(new Date("2026-10-20T07:30:00Z"), 4); console.log(JSON.stringify(s.map(x => [new Date(x.start).toISOString(), x.current])));')
        self.assertEqual(out, [
            ["2026-10-19T12:00:00.000Z", False],
            ["2026-10-19T18:00:00.000Z", False],
            ["2026-10-20T00:00:00.000Z", False],
            ["2026-10-20T06:00:00.000Z", True],
        ])

    def test_durations_are_written_for_people(self):
        out = run_js("console.log(JSON.stringify([L.formatDuration(45), L.formatDuration(120), L.formatDuration(226)]));")
        self.assertEqual(out, ["45 min", "2 h", "3 h 46 min"])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestChangeFieldCells(unittest.TestCase):
    SLOT = '{start: Date.parse("2026-10-20T00:00:00Z"), end: Date.parse("2026-10-20T06:00:00Z")}'

    def state(self, page: dict) -> str:
        return run_js("console.log(JSON.stringify(L.slotState(" + self.SLOT + ", " + json.dumps(page) + ")));")

    def test_a_scan_that_found_a_change_lights_up(self):
        page = {"scans": ["2026-10-20T04:33:00Z"], "events": [{"event_type": "CHANGED_URL", "timestamp": "2026-10-20T04:33:00Z"}]}
        self.assertEqual(self.state(page), "on")

    def test_problems_outrank_changes(self):
        page = {"events": [{"event_type": "CHANGED_URL", "timestamp": "2026-10-20T01:00:00Z"},
                           {"event_type": "FETCH_ERROR", "timestamp": "2026-10-20T02:00:00Z"}]}
        self.assertEqual(self.state(page), "bad")

    def test_a_current_error_marks_the_slot_of_the_last_check(self):
        self.assertEqual(self.state({"problemAt": "2026-10-20T04:33:00Z", "scans": ["2026-10-20T04:33:00Z"]}), "bad")

    def test_a_new_page_has_its_own_state(self):
        self.assertEqual(self.state({"events": [{"event_type": "NEW_URL", "timestamp": "2026-10-20T05:00:00Z"}]}), "new")

    def test_a_scan_with_no_change_is_dim(self):
        self.assertEqual(self.state({"scans": ["2026-10-20T04:33:00Z"]}), "dim")

    def test_no_scan_and_before_monitoring_are_unlit(self):
        self.assertEqual(self.state({"scans": ["2026-10-19T22:00:00Z"]}), "none")
        self.assertEqual(self.state({"firstSeen": "2026-10-21T00:00:00Z", "scans": ["2026-10-20T04:33:00Z"]}), "none")

    def test_the_slot_end_is_exclusive(self):
        self.assertEqual(self.state({"scans": ["2026-10-20T06:00:00Z"]}), "none")


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestEventWording(unittest.TestCase):
    def test_every_engine_event_type_has_a_plain_label_and_tone(self):
        types = ["CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED", "FETCH_ERROR", "EXTRACTION_ERROR", "BASELINE_MIGRATION"]
        out = run_js("console.log(JSON.stringify(" + json.dumps(types) + ".map(t => [L.eventLabel(t), L.eventTone(t)])));")
        labels = [label for label, _tone in out]
        self.assertNotIn("Monitoring event", labels)
        self.assertEqual(dict(zip(types, [tone for _label, tone in out])), {
            "CHANGED_URL": "change", "NEW_URL": "change", "REMOVED_URL": "change", "HTML_SOURCE_CHANGED": "change",
            "FETCH_ERROR": "problem", "EXTRACTION_ERROR": "problem", "BASELINE_MIGRATION": "info",
        })

    def test_engine_event_types_are_all_covered(self):
        engine = (ROOT / "regmon/engine.py").read_text(encoding="utf-8")
        lib = (ROOT / "dashboard-lib.js").read_text(encoding="utf-8")
        for event_type in ("CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED", "FETCH_ERROR", "EXTRACTION_ERROR", "BASELINE_MIGRATION"):
            with self.subTest(event_type=event_type):
                self.assertIn(event_type, engine)
                self.assertIn(event_type + ":", lib)


if __name__ == "__main__":
    unittest.main()
