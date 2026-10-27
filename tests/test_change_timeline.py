"""D-01: changes must stay visible after the next run."""
import unittest

from engine_harness import ANALYSIS, Sandbox, html, ok

from regmon import notify


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

    def test_a_repeated_transition_is_a_new_occurrence_that_alerts_again(self):
        # Audit CS-02: A->B->A->B reused the first change's event ID, so the
        # third change had no evidence, left no timeline entry and was dropped
        # by the notification ledger as already sent.
        a, b = "<p>Consultation open.</p>", "<p>Consultation closed.</p>"
        with Sandbox() as sandbox:
            sandbox.scan(lambda *x, **k: ok(html(a)))
            ids, delivered = [], []
            state = {"sent_events": {}}
            for body in (b, a, b):
                result = sandbox.scan(lambda *x, body=body, **k: ok(html(body)))
                events = [event for event in result["report"]["events"] if event["event_type"] == "CHANGED_URL"]
                self.assertEqual(len(events), 1)
                ids.append(events[0]["event_id"])
                self.assertTrue(events[0]["evidence_location"])
                outbox = {"pending_events": {}}
                notify.enqueue_notifications(outbox, notify.build_notifications(result["report"]), state["sent_events"])
                sent = []
                channel = notify.alert_channels.Channel("test", lambda n, _d: sent.append(n["event_id"]))
                notify.deliver_pending(outbox, state, "", "", channels=[channel])
                delivered.append(sent)
            self.assertEqual(len(set(ids)), 3)
            self.assertTrue(all(len(sent) == 1 for sent in delivered), delivered)
            history = next(iter(sandbox.inventory().values()))["change_history"]
            self.assertEqual([entry["event_id"] for entry in history[:3]], list(reversed(ids)))

    def test_a_rescan_before_the_baseline_advances_keeps_the_same_event_id(self):
        # Determinism: a run that crashes after detecting a change re-derives
        # the same ID on the next scan, so retries still de-duplicate.
        with Sandbox() as sandbox:
            sandbox.scan(lambda *x, **k: ok(html("<p>One.</p>")))
            sandbox.scan(lambda *x, **k: ok(html("<p>Two.</p>")))
            first = sandbox.scan(lambda *x, **k: ok(html("<p>Three.</p>")), persist=False)
            again = sandbox.scan(lambda *x, **k: ok(html("<p>Three.</p>")), persist=False)
            self.assertEqual(first["report"]["events"][0]["event_id"], again["report"]["events"][0]["event_id"])


if __name__ == "__main__":
    unittest.main()
