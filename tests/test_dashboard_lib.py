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

    def test_durations_are_written_for_people(self):
        out = run_js("console.log(JSON.stringify([L.formatDuration(45), L.formatDuration(120), L.formatDuration(226)]));")
        self.assertEqual(out, ["45 min", "2 h", "3 h 46 min"])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestScanColumns(unittest.TestCase):
    HISTORY = [
        {"run_id": "a", "generated_at": "2026-10-20T04:32:57Z", "source_id": "s1"},
        {"run_id": "a", "generated_at": "2026-10-20T04:33:13Z", "source_id": "s2"},
        {"run_id": "m", "generated_at": "2026-10-20T14:50:52Z", "source_id": "s1", "trigger": "manual"},
        {"run_id": "b", "generated_at": "2026-10-20T21:31:03Z", "source_id": "s1", "trigger": "scheduled"},
        {"run_id": "b", "generated_at": "2026-10-20T21:31:02Z", "source_id": "s2", "trigger": "scheduled"},
    ]

    def columns(self, history=None, runs=None, limit=0):
        return run_js("console.log(JSON.stringify(L.runColumns(" + json.dumps(history or self.HISTORY) + ", {workflowRuns: " +
                      json.dumps(runs or []) + ", limit: " + str(limit) + "})));")

    def test_every_saved_scan_is_one_column_including_manual_runs(self):
        cols = self.columns()
        self.assertEqual([c["id"] for c in cols], ["a", "m", "b"])
        self.assertEqual([c["trigger"] for c in cols], ["unknown", "manual", "scheduled"])
        self.assertEqual(sorted(cols[0]["sources"]), ["s1", "s2"])
        self.assertEqual(sorted(cols[1]["sources"]), ["s1"])
        # Each column owns the events saved since the previous scan.
        self.assertEqual(cols[2]["prevAt"], cols[1]["at"])

    def test_older_history_is_labelled_from_the_actions_api(self):
        runs = [{"id": 7, "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
                 "created_at": "2026-10-20T04:31:27Z", "run_started_at": "2026-10-20T04:31:30Z", "updated_at": "2026-10-20T04:35:00Z",
                 "actor": "GauravDarwesh"}]
        cols = self.columns(runs=runs)
        self.assertEqual((cols[0]["trigger"], cols[0]["workflowRunId"]), ("manual", "7"))

    def test_continuation_dispatches_are_not_counted_as_manual(self):
        runs = [{"id": 8, "event": "workflow_dispatch", "actor": "github-actions[bot]", "created_at": "2026-10-20T04:31:27Z",
                 "updated_at": "2026-10-20T04:35:00Z", "status": "completed"}]
        self.assertEqual(self.columns(runs=runs)[0]["trigger"], "continuation")

    def test_the_limit_keeps_the_newest_columns(self):
        self.assertEqual([c["id"] for c in self.columns(limit=2)], ["m", "b"])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestChangeFieldCells(unittest.TestCase):
    COLUMN = {"id": "b", "at": 1792531863000, "prevAt": 1792507852000, "sources": {"s1": 1792531863000}}  # 2026-10-20 21:31:03Z, prev 14:50:52Z

    def state(self, page: dict) -> str:
        page = dict({"sourceId": "s1"}, **page)
        return run_js("console.log(JSON.stringify(L.columnCellState(" + json.dumps(self.COLUMN) + ", " + json.dumps(page) + ")));")

    def test_a_scan_that_found_a_change_lights_up(self):
        self.assertEqual(self.state({"events": [{"event_type": "CHANGED_URL", "timestamp": "2026-10-20T21:31:03Z"}]}), "on")

    def test_problems_outrank_changes(self):
        page = {"events": [{"event_type": "CHANGED_URL", "timestamp": "2026-10-20T21:31:03Z"},
                           {"event_type": "FETCH_ERROR", "timestamp": "2026-10-20T21:31:03Z"}]}
        self.assertEqual(self.state(page), "bad")

    def test_a_current_error_marks_the_scan_of_the_last_check(self):
        self.assertEqual(self.state({"problemAt": "2026-10-20T21:31:03Z"}), "bad")

    def test_a_new_page_has_its_own_state(self):
        self.assertEqual(self.state({"events": [{"event_type": "NEW_URL", "timestamp": "2026-10-20T21:31:03Z"}]}), "new")

    def test_a_scan_with_no_change_is_dim(self):
        self.assertEqual(self.state({}), "dim")

    def test_an_earlier_scans_event_belongs_to_that_scan(self):
        self.assertEqual(self.state({"events": [{"event_type": "CHANGED_URL", "timestamp": "2026-10-20T14:50:52Z"}]}), "dim")

    def test_other_sources_and_pages_not_yet_monitored_are_not_drawn(self):
        self.assertEqual(self.state({"sourceId": "s2"}), "none")
        self.assertEqual(self.state({"firstSeen": "2026-10-21T00:00:00Z"}), "none")


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestPendingScan(unittest.TestCase):
    def pending(self, now, columns, runs=None):
        return run_js("const p = L.pendingScan(new Date(" + json.dumps(now) + "), " + json.dumps(columns) + ", " + json.dumps(runs or []) +
                      "); console.log(JSON.stringify({due: p.due.toISOString(), phase: p.phase, late: p.lateMinutes, trigger: p.trigger}));")

    SCHEDULED_0433 = {"id": "a", "at": 1792470793000, "trigger": "scheduled"}  # 2026-10-20T04:33:13Z
    MANUAL_0300 = {"id": "m", "at": 1792465200000, "trigger": "manual"}       # 2026-10-20T03:00:00Z

    def test_after_the_slots_scheduled_scan_the_clock_moves_to_the_next_slot(self):
        out = self.pending("2026-10-20T05:00:00Z", [self.SCHEDULED_0433])
        self.assertEqual((out["due"], out["phase"]), ("2026-10-20T06:00:00.000Z", "waiting"))

    def test_a_manual_run_does_not_stand_in_for_the_scheduled_scan(self):
        out = self.pending("2026-10-20T03:30:00Z", [self.MANUAL_0300])
        self.assertEqual((out["due"], out["phase"], out["late"]), ("2026-10-20T00:00:00.000Z", "late", 210))

    def test_just_after_a_slot_starts_the_scan_is_due(self):
        self.assertEqual(self.pending("2026-10-20T06:05:00Z", [self.SCHEDULED_0433])["phase"], "due")

    def test_a_run_in_progress_on_github_shows_as_running(self):
        runs = [{"id": 9, "event": "workflow_dispatch", "actor": "GauravDarwesh", "status": "in_progress",
                 "created_at": "2026-10-20T05:10:00Z", "run_started_at": "2026-10-20T05:10:05Z", "updated_at": "2026-10-20T05:11:00Z"}]
        out = self.pending("2026-10-20T05:12:00Z", [self.SCHEDULED_0433], runs)
        self.assertEqual((out["phase"], out["trigger"]), ("running", "manual"))

    def test_a_finished_run_whose_scan_is_saved_is_not_still_publishing(self):
        # The 8:06 am manual run: results saved at 02:36:32Z, GitHub marked the run done at 02:40:37Z.
        saved = {"id": "x", "at": 1792550192000, "trigger": "manual", "workflowRunId": "39533795876"}
        runs = [{"id": 39533795876, "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
                 "created_at": "2026-10-21T02:34:40Z", "run_started_at": "2026-10-21T02:34:45Z", "updated_at": "2026-10-21T02:40:37Z"}]
        self.assertEqual(self.pending("2026-10-21T02:45:00Z", [saved], runs)["phase"], "late")
        saved.pop("workflowRunId")
        self.assertEqual(self.pending("2026-10-21T02:45:00Z", [saved], runs)["phase"], "late")

    def test_a_finished_run_not_yet_saved_is_publishing(self):
        runs = [{"id": 9, "event": "schedule", "status": "completed", "conclusion": "success",
                 "created_at": "2026-10-20T06:40:00Z", "updated_at": "2026-10-20T06:45:00Z"}]
        self.assertEqual(self.pending("2026-10-20T06:48:00Z", [self.SCHEDULED_0433], runs)["phase"], "publishing")


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


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestCompareDiff(unittest.TestCase):
    def test_diff_runs_reconstruct_both_sequences_and_are_minimal(self):
        out = run_js(r"""
          let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
          let ok = true, optimal = true;
          for (let t = 0; t < 400; t++) {
            const a = Array.from({length: Math.floor(rnd() * 30)}, () => "abcd"[Math.floor(rnd() * 4)]);
            const b = a.filter(() => rnd() > 0.25).map(x => rnd() < 0.1 ? "z" : x);
            const runs = L.diffSequences(a, b);
            let ia = 0, ib = 0, same = 0;
            for (const r of runs) {
              if (r.a[0] !== ia || r.b[0] !== ib) ok = false;
              if (r.type === "same") { same += r.a[1] - r.a[0]; for (let k = 0; k < r.a[1] - r.a[0]; k++) if (a[r.a[0] + k] !== b[r.b[0] + k]) ok = false; }
              ia = r.a[1]; ib = r.b[1];
            }
            if (ia !== a.length || ib !== b.length) ok = false;
            const dp = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
            for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            if (same !== dp[0][0]) optimal = false;
          }
          console.log(JSON.stringify({ok, optimal}));
        """)
        self.assertEqual(out, {"ok": True, "optimal": True})

    def test_large_documents_diff_quickly_through_patience_anchors(self):
        out = run_js(r"""
          const a = Array.from({length: 150000}, (_, i) => "line " + i);
          const b = a.slice(); b.splice(700, 1, "edited"); b.splice(120000, 0, "inserted");
          const t0 = Date.now(); const runs = L.diffSequences(a, b);
          console.log(JSON.stringify({ms: Date.now() - t0, changed: runs.filter(r => r.type !== "same").length}));
        """)
        self.assertLess(out["ms"], 5000)
        self.assertEqual(out["changed"], 3)

    def test_aligned_rows_pair_edits_word_by_word_and_keep_insertions_apart(self):
        out = run_js(r"""
          const r = L.alignLines("Title\nReports are due in 30 days.\nUnchanged\nOld only line here",
                                 "Title\nReports are due in 15 days.\nUnchanged\nA completely new sentence");
          console.log(JSON.stringify({types: r.rows.map(x => x.type), stats: r.stats,
            del: r.rows[1].segments.filter(s => s.type === "del").map(s => s.text.trim()),
            add: r.rows[1].segments.filter(s => s.type === "add").map(s => s.text.trim())}));
        """)
        self.assertEqual(out["types"], ["same", "edit", "same", "del", "add"])
        self.assertEqual(out["del"], ["30"])
        self.assertEqual(out["add"], ["15"])

    def test_changed_words_are_reported_per_side(self):
        out = run_js(r"""
          const w = s => s.split(" ").map(text => ({text}));
          console.log(JSON.stringify(L.changedWords(w("rate of 8.500 percent"), w("rate of 8.750 percent"))));
        """)
        self.assertEqual(out, {"removed": [2], "added": [2]})
