import json
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
        # The irrelevant verdict is carried only as a possible follow-up; with no
        # generic alert delivered earlier, nothing is queued.
        outbox = {"pending_events": {}}
        enqueue_notifications(outbox, build_notifications(report), {})
        self.assertEqual(outbox["pending_events"], {})
        self.assertNotIn("generic", [n.get("variant") for n in build_notifications(report)])

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
        # The alert opens its own change, not the dashboard's front page.
        self.assertEqual(kwargs["json"]["click"],"https://dash#changes/x")
        self.assertIn("Impact: I",kwargs["json"]["message"])

    def test_links_follow_the_change_behind_follow_ups_and_episodes(self):
        from regmon.notify import dashboard_link
        base = "https://dash/"
        self.assertEqual(dashboard_link({"kind": "AI_ASSESSMENT", "event_id": "e1#ai", "source_event_id": "e1"}, base), base + "#changes/e1")
        self.assertEqual(dashboard_link({"kind": "FETCH_ERROR", "event_id": "op-9", "source_event_id": "e2"}, base), base + "#changes/e2")
        self.assertEqual(dashboard_link({"kind": "REMOVAL_HELD", "event_id": "removal-guard-x"}, base), base + "#runs")
        self.assertEqual(dashboard_link({"kind": "TEST", "event_id": "test-1"}, base), base)
        self.assertEqual(dashboard_link({"kind": "CHANGED_URL", "event_id": "a/b"}, base + "#overview"), base + "#changes/a%2Fb")
        self.assertEqual(dashboard_link({"kind": "CHANGED_URL", "event_id": "x"}, ""), "")

    @patch("regmon.notify.requests.post")
    def test_relevant_change_alert_states_its_date_and_action(self, mock_post):
        mock_post.return_value.raise_for_status.return_value = None
        report = {"ai_results": [{"event_id": "e", "event": "CHANGED_URL", "url": "https://x.gov/f", "ai": {"status": "ok", "analysis": {
            "relevant": True, "topic": "Deadline", "change_type": "deadline", "summary": "Due date moved", "impact": "Earlier filing",
            "effective_date": "March 31, 2027", "affected_scope": "Filers", "actions": "Update the filing calendar", "reason": "Diff"}}}]}
        notification = build_notifications(report)[0]
        publish(notification, "topic", "https://ntfy.sh", "https://dash")
        message = mock_post.call_args.kwargs["json"]["message"]
        self.assertIn("Effective: March 31, 2027", message)
        self.assertIn("Suggested action: Update the filing calendar", message)

    @patch("regmon.notify.requests.post")
    def test_reporting_item_changes_ride_along_on_ai_and_generic_alerts(self, mock_post):
        mock_post.return_value.raise_for_status.return_value = None
        codes = {"counts": {"added": 1, "removed": 0, "amended": 2}, "codes": ["RCON1234", "RCON2170", "RCFD3210"], "series": ["RCON", "RCFD"]}
        report = {
            "events": [
                {"event_id": "a", "event_type": "CHANGED_URL", "url": "https://x.gov/a", "item_codes": codes},
                {"event_id": "g", "event_type": "CHANGED_URL", "url": "https://x.gov/g", "item_codes": codes},
                {"event_id": "plain", "event_type": "CHANGED_URL", "url": "https://x.gov/p"},
            ],
            "ai_results": [{"event_id": "a", "event": "CHANGED_URL", "url": "https://x.gov/a", "ai": {"status": "ok", "analysis": {
                "relevant": True, "topic": "Schedule RC", "summary": "Items changed", "impact": "Filing", "reason": "Diff"}}}],
        }
        notifications = {n["event_id"]: n for n in build_notifications(report)}
        self.assertEqual(notifications["a"]["reporting_items"], "1 added, 2 amended (RCON1234, RCON2170, RCFD3210)")
        self.assertEqual(notifications["g"]["variant"], "generic")
        self.assertEqual(notifications["g"]["reporting_items"], notifications["a"]["reporting_items"])
        self.assertNotIn("reporting_items", notifications["plain"])
        publish(notifications["a"], "topic", "https://ntfy.sh", "")
        self.assertIn("Reporting items: 1 added, 2 amended (RCON1234", mock_post.call_args.kwargs["json"]["message"])
        publish(notifications["plain"], "topic", "https://ntfy.sh", "")
        self.assertNotIn("Reporting items:", mock_post.call_args.kwargs["json"]["message"])

    @patch("regmon.notify.requests.post")
    def test_not_stated_fields_are_left_out(self, mock_post):
        mock_post.return_value.raise_for_status.return_value = None
        publish({"event_id": "x", "kind": "CHANGED_URL", "topic": "T", "summary": "S", "reason": "R", "impact": "I",
                 "effective_date": "Not stated", "actions": "", "priority": 4, "tags": []}, "t", "https://ntfy.sh", "")
        message = mock_post.call_args.kwargs["json"]["message"]
        self.assertNotIn("Effective:", message)
        self.assertNotIn("click", mock_post.call_args.kwargs["json"])

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

class TestNoOpStateWrites(unittest.TestCase):
    """Regression: every scan committed notification files whose only change was updated_at."""

    def test_unchanged_state_and_outbox_are_not_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "notifications.json"
            outbox_path = Path(tmp) / "notification-outbox.json"
            self.assertTrue(save_state({"sent_events": {"x": {"kind": "CHANGED_URL"}}, "updated_at": None}, state_path))
            self.assertTrue(save_outbox({"pending_events": {}, "updated_at": None}, outbox_path))
            before = (state_path.read_bytes(), outbox_path.read_bytes())

            state, outbox = load_state(state_path), load_outbox(outbox_path)
            enqueue_notifications(outbox, [], state["sent_events"])
            self.assertFalse(save_outbox(outbox, outbox_path))
            self.assertFalse(save_state(state, state_path))
            self.assertEqual((state_path.read_bytes(), outbox_path.read_bytes()), before)
            # The in-memory copy keeps the on-disk timestamp rather than a fresh one.
            self.assertEqual(outbox["updated_at"], json.loads(before[1])["updated_at"])

    def test_empty_delivery_pass_leaves_files_untouched(self):
        from regmon.notify import deliver_pending

        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "notifications.json"
            outbox_path = Path(tmp) / "notification-outbox.json"
            save_state({"sent_events": {}, "updated_at": None}, state_path)
            save_outbox({"pending_events": {}, "updated_at": None}, outbox_path)
            before = (state_path.read_bytes(), outbox_path.read_bytes())
            state, outbox = load_state(state_path), load_outbox(outbox_path)

            def persist():
                save_state(state, state_path)
                save_outbox(outbox, outbox_path)

            with patch("regmon.notify.publish") as publish_mock:
                result = deliver_pending(outbox, state, "topic", "https://ntfy.example", persist=persist)
                persist()
            publish_mock.assert_not_called()
            self.assertEqual(result["sent"], 0)
            self.assertEqual((state_path.read_bytes(), outbox_path.read_bytes()), before)

    def test_real_change_is_written_with_a_new_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "notification-outbox.json"
            save_outbox({"pending_events": {}, "updated_at": None}, path)
            first = json.loads(path.read_text())["updated_at"]
            outbox = load_outbox(path)
            enqueue_notifications(outbox, [{"event_id": "new-event", "kind": "CHANGED_URL"}], {})
            self.assertTrue(save_outbox(outbox, path))
            saved = json.loads(path.read_text())
            self.assertIn("new-event", saved["pending_events"])
            self.assertIsNotNone(saved["updated_at"])
            self.assertGreaterEqual(saved["updated_at"], first)


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
