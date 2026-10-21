"""Human review decisions recorded from owner-opened issues."""
import json
import tempfile
import unittest
from pathlib import Path

from regmon import reviews

EVENT = "b" * 64


def body(decision="not material", rationale="Copyright year only; no reporting impact.", events=(EVENT,), ticket="(none)"):
    lines = [reviews.MARKER, "", f"Decision: {decision}", f"Rationale: {rationale}", "Owner: Regulatory Reporting", f"Ticket: {ticket}", "", "Changes:"]
    lines += [f"- {event} | https://fed.example/FR_Y-9C" for event in events]
    return "\n".join(lines)


def issue_event(text, login="owner", title="[ChangeSentinel] Change review: not material"):
    return {"issue": {"number": 7, "title": title, "body": text, "user": {"login": login}},
            "repository": {"owner": {"login": "owner"}}}


class TestReviewLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        item = {"canonical_url": "https://fed.example/FR_Y-9C",
                "change_history": [{"event_id": EVENT, "event_type": "CHANGED_URL", "timestamp": "2026-10-20T06:00:00+00:00"}]}
        (self.data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"fed": {"u1": item}}}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_decision_is_recorded_and_logged(self):
        result = reviews.apply_event(issue_event(body()), self.data, now="2026-10-21T10:00:00+00:00")
        self.assertEqual(result, {"decision": "not_material", "label": "Not material", "count": 1})
        ledger = json.loads(reviews.ledger_path(self.data).read_text())
        record = ledger["reviews"][EVENT]
        self.assertEqual((record["decision"], record["reviewed_by"], record["request"], record["owner"], record["ticket"]),
                         ("not_material", "owner", "issue #7", "Regulatory Reporting", ""))
        self.assertEqual(record["detected_at"], "2026-10-20T06:00:00+00:00")

    def test_a_later_decision_replaces_the_current_one_but_not_the_log(self):
        reviews.apply_event(issue_event(body()), self.data, now="2026-10-21T10:00:00+00:00")
        reviews.apply_event(issue_event(body("material", "Threshold changed")), self.data, now="2026-10-22T10:00:00+00:00")
        ledger = json.loads(reviews.ledger_path(self.data).read_text())
        self.assertEqual(ledger["reviews"][EVENT]["decision"], "material")
        self.assertEqual([entry["decision"] for entry in ledger["log"]], ["not_material", "material"])

    def test_only_the_owner_can_record(self):
        with self.assertRaises(reviews.ReviewError):
            reviews.apply_event(issue_event(body(), login="someone-else"), self.data)

    def test_not_material_needs_a_rationale(self):
        with self.assertRaises(reviews.ReviewError):
            reviews.apply_event(issue_event(body(rationale="(none)")), self.data)

    def test_unknown_changes_and_bad_tickets_are_rejected(self):
        with self.assertRaises(reviews.ReviewError):
            reviews.apply_event(issue_event(body(events=("c" * 64,))), self.data)
        with self.assertRaises(reviews.ReviewError):
            reviews.apply_event(issue_event(body("action required", ticket="javascript:alert(1)")), self.data)
        with self.assertRaises(reviews.ReviewError):
            reviews.parse_request(body(decision="maybe"))

    def test_a_corrupt_ledger_is_never_overwritten(self):
        path = reviews.ledger_path(self.data)
        path.parent.mkdir(parents=True)
        path.write_text("{not json")
        with self.assertRaises(reviews.ReviewError):
            reviews.apply_event(issue_event(body()), self.data)
        self.assertEqual(path.read_text(), "{not json")


if __name__ == "__main__":
    unittest.main()
