"""State files that grow every run stay readable and bounded (25 Oct audit,
CS-138, CS-139, CS-140)."""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone

from regmon import engine, notify
from regmon.scout.registry import dump_compact, dump_review


class TestHistoryIndex(unittest.TestCase):
    def test_one_entry_per_line_and_the_same_json(self):
        entries = [{"run_id": f"r{i}", "source_id": "s", "counts": {"changed": i, "new": 0}} for i in range(3)]
        text = engine.dump_history_index(entries)
        self.assertEqual(json.loads(text), entries)
        self.assertEqual(text.splitlines()[1:-1], [json.dumps(e, separators=(",", ":")) + ("," if i < 2 else "") for i, e in enumerate(entries)])
        self.assertEqual(json.loads(engine.dump_history_index([])), [])


class TestScoutReview(unittest.TestCase):
    def test_one_candidate_per_line_and_the_same_json(self):
        review = {"generated_at": "2026-10-28T00:00:00Z", "candidates": [{"url": "https://a.test/1", "b": 1}, {"url": "https://a.test/2"}], "omitted_backlog": {"x": 2}, "regulators": []}
        text = dump_review(review)
        self.assertEqual(json.loads(text), json.loads(dump_compact(review)))
        self.assertIn('{"b":1,"url":"https://a.test/1"},\n{"url":"https://a.test/2"}', text)


class TestDeliveryLedgerRetention(unittest.TestCase):
    NOW = datetime(2026, 10, 28, tzinfo=timezone.utc)

    def state(self):
        return {"sent_events": {
            "old": {"kind": "CHANGED_URL", "sent_at": "2025-06-01T00:00:00+00:00"},
            "old-but-live": {"kind": "CHANGED_URL", "sent_at": "2025-06-01T00:00:00+00:00"},
            "old-but-queued": {"kind": "CHANGED_URL", "sent_at": "2025-06-01T00:00:00Z"},
            "recent": {"kind": "NEW_URL", "sent_at": "2026-10-01T00:00:00+00:00"},
            "undated": {"kind": "NEW_URL"},
        }, "updated_at": None}

    def test_old_records_go_but_live_ones_stay(self):
        state = self.state()
        report = {"events": [{"event_id": "old-but-live"}]}
        outbox = {"pending_events": {"old-but-queued": {"event_id": "old-but-queued"}}}
        removed = notify.prune_sent_events(state, notify.live_event_ids(report, outbox), now=self.NOW)
        self.assertEqual(removed, 1)
        self.assertEqual(sorted(state["sent_events"]), ["old-but-live", "old-but-queued", "recent", "undated"])

    def test_an_expired_event_that_comes_back_is_still_known_while_live(self):
        state = self.state()
        notify.prune_sent_events(state, {"old-but-live"}, now=self.NOW)
        outbox = {"pending_events": {}}
        notify.enqueue_notifications(outbox, [{"event_id": "old-but-live", "variant": "generic"}], state["sent_events"])
        self.assertEqual(outbox["pending_events"], {})


if __name__ == "__main__":
    unittest.main()
