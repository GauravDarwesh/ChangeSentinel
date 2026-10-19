import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from regmon.notify import build_notifications, enqueue_notifications, load_outbox, load_state, publish, save_outbox, save_state

class TestNotifications(unittest.TestCase):
    def test_relevant_ai_result_becomes_notification(self):
        report={"ai_results":[{
            "event_id":"1","event":"CHANGED_URL","url":"https://example.test/a",
            "ai":{"status":"ok","analysis":{
                "relevant":True,"topic":"Guideline","summary":"Changed",
                "reason":"Requirement updated","impact":"Review"
            }}
        }]}
        self.assertEqual(build_notifications(report)[0]["event_id"],"1")

    def test_explicit_ai_irrelevance_suppresses_generic_change_alert(self):
        event_id = "reviewed-irrelevant"
        report = {
            "ai_results": [{
                "event_id": event_id,
                "event": "CHANGED_URL",
                "ai": {"status": "ok", "analysis": {"relevant": False}},
            }],
            "events": [{
                "event_id": event_id,
                "event_type": "CHANGED_URL",
                "url": "https://example.test/policy",
            }],
        }
        self.assertEqual(build_notifications(report), [])

    def test_ai_error_keeps_generic_change_alert(self):
        event_id = "review-failed"
        report = {
            "ai_results": [{
                "event_id": event_id,
                "event": "CHANGED_URL",
                "ai": {"status": "error", "reason": "provider unavailable"},
            }],
            "events": [{
                "event_id": event_id,
                "event_type": "CHANGED_URL",
                "url": "https://example.test/policy",
            }],
        }
        notifications = build_notifications(report)
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]["topic"], "Technical change detected")

    def test_removed_and_error(self):
        report={"events":[
            {"event_id":"2","event_type":"REMOVED_URL","url":"https://example.test/x"},
            {"event_id":"3","event_type":"FETCH_ERROR","url":"https://example.test/y","evidence":{"error":"HTTP 503"}}
        ]}
        values=build_notifications(report)
        self.assertEqual([x["event_id"] for x in values],["2","3"])
        self.assertIn("HTTP 503",values[1]["reason"])

    @patch("regmon.notify.requests.post")
    def test_publish(self,mock_post):
        mock_post.return_value.raise_for_status.return_value=None
        publish({
            "event_id":"x","kind":"CHANGED_URL","url":"https://example.test",
            "topic":"T","summary":"S","reason":"R","impact":"I",
            "priority":4,"tags":["warning"]
        },"topic","https://ntfy.sh","https://dash")
        kwargs=mock_post.call_args.kwargs
        self.assertEqual(kwargs["json"]["click"],"https://dash")
        self.assertIn("Impact: I",kwargs["json"]["message"])

    def test_discovery_degraded_becomes_operational_alert(self):
        report = {"discovery": [{"source_id": "fed-pilot", "state": "DEGRADED", "unresolved_failures": 3}]}
        notification = build_notifications(report)[0]
        self.assertEqual(notification["kind"], "DISCOVERY_DEGRADED")
        self.assertIn("not authoritative", notification["impact"])

    def test_failed_delivery_stays_in_durable_outbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "notification-outbox.json"
            outbox = {"pending_events": {}, "updated_at": None}
            event = {"event_id": "retry-me", "kind": "CHANGED_URL", "summary": "x"}
            enqueue_notifications(outbox, [event], {})
            save_outbox(outbox, path)
            restored = load_outbox(path)
            self.assertIn("retry-me", restored["pending_events"])
            enqueue_notifications(restored, [event], {})
            self.assertEqual(len(restored["pending_events"]), 1)
            restored["pending_events"].pop("retry-me")
            save_outbox(restored, path)
            self.assertEqual(load_outbox(path)["pending_events"], {})

    def test_outbox_does_not_requeue_already_sent_event(self):
        outbox = {"pending_events": {}, "updated_at": None}
        enqueue_notifications(outbox, [{"event_id": "done"}], {"done": {"sent_at": "now"}})
        self.assertEqual(outbox["pending_events"], {})

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"notifications.json"
            state={"sent_events":{"x":{}},"updated_at":None}
            save_state(state,path)
            self.assertIn("x",load_state(path)["sent_events"])

class TestOperationalAlertsAndDelivery(unittest.TestCase):
    def test_persistent_error_alerts_once_per_episode(self):
        from regmon.notify import enqueue_notifications

        def report(observation):
            return {"events": [{
                "event_id": f"fetch-error-{observation}",
                "notification_id": "op-episode-1",
                "event_type": "FETCH_ERROR",
                "url": "https://example.test/blocked",
                "evidence": {"error": "HTTPError: HTTP 403 for https://example.test/blocked"},
            }]}

        ledger, delivered = {}, []
        for observation in range(4):
            outbox = {"pending_events": {}}
            enqueue_notifications(outbox, build_notifications(report(observation)), ledger)
            for key, item in outbox["pending_events"].items():
                ledger[key] = {"kind": item["kind"]}
                delivered.append(item)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0]["event_id"], "op-episode-1")
        self.assertEqual(delivered[0]["source_event_id"], "fetch-error-0")

    @patch("regmon.notify.publish")
    def test_state_is_persisted_after_every_delivery(self, mock_publish):
        from regmon.notify import deliver_pending

        outbox = {"pending_events": {
            "a": {"event_id": "a", "kind": "CHANGED_URL", "url": "https://example.test/a", "topic": "T", "summary": "S"},
            "b": {"event_id": "b", "kind": "CHANGED_URL"},
            "c": {"event_id": "c", "kind": "CHANGED_URL"},
        }}
        state = {"sent_events": {}}
        snapshots = []
        mock_publish.side_effect = [None, RuntimeError("ntfy unavailable"), None]
        result = deliver_pending(
            outbox, state, "topic", "https://ntfy.sh",
            persist=lambda: snapshots.append(sorted(state["sent_events"])),
        )
        self.assertEqual(result, {"sent": 2, "skipped": 0, "failed": 1, "pending": 1})
        # One durable save per successful send: a crash after "a" can no longer re-send it.
        self.assertEqual(snapshots, [["a"], ["a", "c"]])
        self.assertIn("b", outbox["pending_events"])
        self.assertEqual(state["sent_events"]["a"]["url"], "https://example.test/a")
        self.assertEqual(state["sent_events"]["a"]["topic"], "T")


if __name__ == "__main__":
    unittest.main()
