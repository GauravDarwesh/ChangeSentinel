"""Dashboard review decisions copied into the committed ledger (regmon/review_sync.py)."""
import json
import tempfile
import unittest
from pathlib import Path

from regmon import review_sync, reviews

EVENT = "c" * 64
OTHER = "d" * 64
APP = "00000000-0000-4000-8000-000000000001"


def decision(**overrides):
    base = {"app_id": APP, "event_id": EVENT, "decision": "action_required", "rationale": "Land ADC rows change our schedule.",
            "owner": "Capital reporting", "ticket": "https://tracker.example.test/REG-1", "reviewed_by": "reviewer",
            "reviewed_at": "2026-11-01T10:00:00.000Z", "event_type": "CHANGED_URL", "url": "https://www.osfi-bsif.gc.ca/x"}
    base.update(overrides)
    return base


class TestReviewSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        item = {"canonical_url": "https://www.osfi-bsif.gc.ca/x",
                "change_history": [{"event_id": EVENT, "event_type": "CHANGED_URL", "timestamp": "2026-10-30T16:51:00+00:00"}]}
        (self.data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"osfi": {"u1": item}}}))

    def tearDown(self):
        self.tmp.cleanup()

    def ledger(self):
        return json.loads(reviews.ledger_path(self.data).read_text())

    def test_a_dashboard_decision_is_recorded_like_a_github_one(self):
        result = review_sync.apply_decisions([decision()], self.data, now="2026-11-01T10:05:00+00:00")
        self.assertEqual((result["added"], result["done"]), (1, [{"id": APP, "note": ""}]))
        record = self.ledger()["reviews"][EVENT]
        self.assertEqual((record["decision"], record["label"], record["reviewed_by"], record["via"], record["request"]),
                         ("action_required", "Action required", "reviewer", "dashboard", "dashboard 00000000"))
        self.assertEqual((record["reviewed_at"], record["detected_at"]), ("2026-11-01T10:00:00+00:00", "2026-10-30T16:51:00+00:00"))
        # Facts come from the committed record, not from the request.
        self.assertEqual(record["url"], "https://www.osfi-bsif.gc.ca/x")

    def test_a_decision_is_never_added_twice(self):
        review_sync.apply_decisions([decision()], self.data)
        result = review_sync.apply_decisions([decision()], self.data)
        self.assertEqual((result["added"], result["done"][0]["note"]), (0, "already in the ledger"))
        self.assertEqual(len(self.ledger()["log"]), 1)

    def test_the_current_decision_is_the_latest_by_time_made(self):
        later = decision(app_id="00000000-0000-4000-8000-000000000002", decision="material", reviewed_at="2026-11-01T12:00:00Z")
        review_sync.apply_decisions([later, decision()], self.data)
        ledger = self.ledger()
        self.assertEqual(ledger["reviews"][EVENT]["decision"], "material")
        self.assertEqual([entry["decision"] for entry in ledger["log"]], ["action_required", "material"])

    def test_invalid_or_unknown_decisions_are_refused_with_a_note_and_not_retried(self):
        result = review_sync.apply_decisions([
            decision(app_id="00000000-0000-4000-8000-000000000003", event_id=OTHER),
            decision(app_id="00000000-0000-4000-8000-000000000004", decision="not_material", rationale="short"),
            decision(app_id="00000000-0000-4000-8000-000000000005", ticket="javascript:alert(1)"),
        ], self.data)
        self.assertEqual(result["added"], 0)
        self.assertEqual([item["note"] for item in result["done"]], [
            "refused: change is not in the committed record", "refused: not material without a rationale", "refused: ticket is not a link"])
        self.assertFalse(reviews.ledger_path(self.data).exists())

    def test_github_and_dashboard_decisions_share_one_ledger(self):
        text = "\n".join([reviews.MARKER, "Decision: not material", "Rationale: Copyright year only; no impact.", f"- {EVENT}"])
        reviews.apply_event({"issue": {"number": 9, "title": "[ChangeSentinel] Change review: x", "body": text, "user": {"login": "owner"}},
                             "repository": {"owner": {"login": "owner"}}}, self.data, now="2026-11-01T09:00:00+00:00")
        review_sync.apply_decisions([decision()], self.data)
        ledger = self.ledger()
        self.assertEqual([entry["request"] for entry in ledger["log"]], ["issue #9", "dashboard 00000000"])
        self.assertEqual(ledger["reviews"][EVENT]["decision"], "action_required")

    def test_the_sync_needs_its_token(self):
        import os
        saved = os.environ.pop("REVIEW_SYNC_TOKEN", None)
        try:
            with self.assertRaises(reviews.ReviewError):
                review_sync._post({"action": "sync-pending"})
        finally:
            if saved is not None:
                os.environ["REVIEW_SYNC_TOKEN"] = saved


if __name__ == "__main__":
    unittest.main()
