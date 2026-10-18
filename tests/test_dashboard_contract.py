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

    def test_original_pdf_snapshot_is_previewed_and_text_remains_available(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            "file_snapshot_location",
            "function snapshotURL(path)",
            "snapshotURL(filePath)",
            "response.arrayBuffer()",
            'new Blob([bytes], { type: "application/pdf" })',
            "URL.createObjectURL",
            "URL.revokeObjectURL",
            'title="Saved PDF snapshot"',
            'data-snapshot-mode="preview"',
            'data-snapshot-mode="text"',
            'const filePath = item.file_snapshot_location || "";',
            "const snapshotPath = filePath || htmlPath || textPath;",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)



    def test_extracted_markdown_tables_are_rendered_as_html_tables(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn("function splitMarkdownTableRow(line)", source)
        self.assertIn("function isMarkdownTableSeparator(cells)", source)
        self.assertIn("<table style=", source)
        self.assertIn('renderCells(header, "th")', source)
        self.assertIn("overflow-x:auto", source)



    def test_premium_responsive_system_is_published_in_both_dashboard_entries(self):
        required = (
            'id="premium-responsive-redesign"',
            'class="mobile-wordmark"',
            'class="topbar-context"',
            "@media (max-width: 900px)",
            "@media (max-width: 650px)",
            "env(safe-area-inset-bottom)",
            "prefers-reduced-motion: reduce",
            ".nav-list",
            "overflow-wrap: anywhere",
            "function splitMarkdownTableRow(line)",
        )
        for filename in ("index.html", "dashboard-v2.html"):
            source = (ROOT / filename).read_text(encoding="utf-8")
            with self.subTest(filename=filename):
                for token in required:
                    self.assertIn(token, source)

    def test_mobile_navigation_has_four_equal_destinations_and_is_not_side_scroll_only(self):
        source = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("position: fixed; inset: auto 14px calc(10px + env(safe-area-inset-bottom)) 14px", source)
        self.assertIn("grid-template-columns: repeat(4, minmax(0, 1fr))", source)
        self.assertIn("class=\\"nav-button active\\" data-view=\\"monitors\\"", source)
        self.assertIn('data-view="changes"', source)
        self.assertIn('data-view="runs"', source)
        self.assertIn('data-view="notifications"', source)


if __name__ == "__main__":
    unittest.main()
