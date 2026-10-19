"""D-01: changes must stay visible after the next run."""
import unittest

from engine_harness import ANALYSIS, Sandbox, html, ok


class TestChangeTimeline(unittest.TestCase):
    def test_a_change_and_its_ai_verdict_survive_later_unchanged_runs(self):
        with Sandbox() as sandbox:
            sandbox.scan(lambda *a, **k: ok(html("<p>Threshold 10 percent.</p>")))
            changed = sandbox.scan(lambda *a, **k: ok(html("<p>Threshold 25 percent.</p>")))
            event_id = changed["report"]["events"][0]["event_id"]
            for _ in range(3):
                quiet = sandbox.scan(lambda *a, **k: ok(html("<p>Threshold 25 percent.</p>")))
            self.assertEqual(quiet["report"]["events"], [])
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["change_history"][0]["event_id"], event_id)
            self.assertEqual(record["change_history"][0]["event_type"], "CHANGED_URL")
            self.assertEqual(record["change_history"][0]["ai_summary"], ANALYSIS["summary"])
            self.assertEqual(record["last_changed_at"], changed["report"]["events"][0]["timestamp"])

    def test_timeline_is_bounded_and_newest_first(self):
        with Sandbox() as sandbox:
            for index in range(25):
                sandbox.scan(lambda *a, index=index, **k: ok(html(f"<p>Version {index}.</p>")))
            history = next(iter(sandbox.inventory().values()))["change_history"]
            self.assertEqual(len(history), 20)
            self.assertGreaterEqual(history[0]["timestamp"], history[-1]["timestamp"])


if __name__ == "__main__":
    unittest.main()
