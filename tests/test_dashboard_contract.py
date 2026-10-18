import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TestDashboardNotificationContract(unittest.TestCase):
    def test_notification_view_is_present_in_both_published_html_entries(self):
        required = (
            'data-view="notifications"',
            'id="notificationsView"',
            'id="notificationPendingItems"',
            'id="notificationSentItems"',
            'id="navNotificationCount"',
        )
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                for token in required:
                    self.assertIn(token, source)

    def test_dashboard_loads_durable_outbox_and_sent_ledger(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'outbox: RAW + "/data/notification-outbox.json"',
            'notifications: RAW + "/data/notifications.json"',
            'function renderNotifications()',
            'notificationMap(state.outbox, "pending_events")',
            'notificationMap(state.notifications, "sent_events")',
            'safeHttpUrl(item.url)',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_delivery_history_only_uses_fields_preserved_in_ledger(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        start = source.index('$("notificationSentItems").innerHTML')
        end = source.index("function renderViews()", start)
        sent_renderer = source[start:end]
        self.assertIn("item.kind", sent_renderer)
        self.assertIn("item.sent_at", sent_renderer)
        self.assertIn("item.eventId", sent_renderer)
        self.assertNotIn("item.topic", sent_renderer)
        self.assertNotIn("item.url", sent_renderer)


if __name__ == "__main__":
    unittest.main()
