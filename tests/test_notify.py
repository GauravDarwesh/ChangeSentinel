import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.notify import build_notifications, load_state, publish, save_state


class TestNotifications(unittest.TestCase):
    def test_only_valid_relevant_ai_results_become_change_notifications(self):
        report = {
            "ai_results": [
                {
                    "event_id": "relevant-1",
                    "event": "CHANGED_URL",
                    "url": "https://example.test/a",
                    "ai": {
                        "status": "ok",
                        "analysis": {
                            "relevant": True,
                            "topic": "Guideline update",
                            "summary": "A material change.",
                            "reason": "The page changed.",
                        },
                    },
                },
                {
                    "event_id": "irrelevant-1",
                    "event": "CHANGED_URL",
                    "url": "https://example.test/b",
                    "ai": {
                        "status": "ok",
                        "analysis": {
                            "relevant": False,
                            "topic": "Navigation",
                            "summary": "Not material.",
                            "reason": "The change is not regulatory.",
                        },
                    },
                },
                {
                    "event_id": "invalid-1",
                    "event": "CHANGED_URL",
                    "url": "https://example.test/c",
                    "ai": {"status": "invalid"},
                },
            ]
        }

        notifications = build_notifications(report)

        self.assertEqual([item["event_id"] for item in notifications], ["relevant-1"])

    def test_removed_and_fetch_error_events_are_included(self):
        report = {
            "events": [
                {
                    "event_id": "removed-1",
                    "event_type": "REMOVED_URL",
                    "url": "https://example.test/removed",
                },
                {
                    "event_id": "fetch-1",
                    "event_type": "FETCH_ERROR",
                    "url": "https://example.test/error",
                    "evidence": {"error": "HTTP 503"},
                },
            ]
        }

        notifications = build_notifications(report)

        self.assertEqual(
            [item["event_id"] for item in notifications],
            ["removed-1", "fetch-1"],
        )
        self.assertEqual(notifications[1]["reason"], "HTTP 503")

    @patch("regmon.notify.requests.post")
    def test_publish_sends_expected_ntfy_payload(self, mock_post):
        response = Mock()
        response.raise_for_status.return_value = None
        mock_post.return_value = response

        notification = {
            "event_id": "event-123",
            "kind": "CHANGED_URL",
            "url": "https://example.test/change",
            "topic": "Guideline update",
            "summary": "A material change.",
            "reason": "The regulator updated the page.",
            "priority": 4,
            "tags": ["warning", "bank", "regulatory"],
        }

        publish(notification, "RegMonitoringWebCrawlerNTFY", "https://ntfy.sh", "https://example.test/dashboard")

        mock_post.assert_called_once()
        kwargs = mock_post.call_args.kwargs
        self.assertEqual(mock_post.call_args.args[0], "https://ntfy.sh/")
        self.assertEqual(kwargs["json"]["topic"], "RegMonitoringWebCrawlerNTFY")
        self.assertEqual(kwargs["json"]["priority"], 4)
        self.assertEqual(kwargs["json"]["click"], "https://example.test/dashboard")
        self.assertIn("Event ID: event-123", kwargs["json"]["message"])

    def test_notification_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "notifications.json"
            state = {"sent_events": {"event-123": {"kind": "CHANGED_URL"}}, "updated_at": None}
            save_state(state, path)
            loaded = load_state(path)
            self.assertIn("event-123", loaded["sent_events"])
            self.assertIsNotNone(loaded["updated_at"])


if __name__ == "__main__":
    unittest.main()
