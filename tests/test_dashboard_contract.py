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



    def test_professional_responsive_workspace_is_published_in_both_entries(self):
        required = (
            'id="professional-ux-rebuild"',
            'class="app-shell command-shell"',
            'class="topbar command-topbar"',
            'class="nav-list command-nav"',
            'class="page-heading dashboard-hero"',
            'class="inventory-panel"',
            'id="signalVisual"',
            'id="signalChangedCount"',
            'id="signalLinksCount"',
            'id="nextRunTime"',
            'id="nextRunCountdown"',
            'color-scheme: light;',
            '--blue: #2d6a50;',
            '@media (max-width:1020px)',
            '@media (max-width:760px)',
            'viewport-fit=cover',
            'position:fixed; inset:auto 12px calc(9px + env(safe-area-inset-bottom)) 12px',
            '.pdf-viewer-shell.is-expanded',
        )
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                for token in required:
                    self.assertIn(token, source)
                self.assertNotIn('<aside class="sidebar"', source)
                self.assertNotIn('class="hero-radar"', source)
                self.assertNotIn('class="signal-panel"', source)
                for view_id in ("monitorsView", "detailView", "changesView", "runsView", "notificationsView"):
                    self.assertIn('id="' + view_id + '"', source)
                for signal_id in ("signalStableCount", "signalChangedCount", "signalIssueCount", "signalWaitingCount"):
                    self.assertIn('id="' + signal_id + '"', source)

    def test_monitor_inventory_uses_compact_metadata_rows(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'class="monitor-number"',
            'class="monitor-meta-key"',
            'data-status-kind=',
            'data-monitor-id=',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_monitor_signal_uses_real_inventory_statuses_and_utc_schedule(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'function nextScheduledScan(reference = new Date())',
            '0 */6 * * * (UTC)',
            'function updateNextRunCountdown()',
            'function renderMonitoringSignal()',
            'const statuses = items.map(item => ({ item, status: itemStatus(item) }))',
            'statuses.slice(0, maxDots)',
            'signalLinksCount',
            'signalChangedCount',
            'signalIssueCount',
            'window.setInterval(updateNextRunCountdown, 60000)',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_mobile_pdf_reader_can_expand_and_close_without_losing_text_mode(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'class="pdf-viewer-shell" id="pdfViewerShell"',
            'data-pdf-action="expand"',
            'data-pdf-action="close"',
            'function setPdfViewerExpanded(expanded)',
            'document.body.classList.toggle("pdf-viewer-open", expanded)',
            'event.key === "Escape"',
            'new Blob([bytes], { type: "application/pdf" })',
            'data-snapshot-mode="text"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('height:min(76dvh,940px)', html)
        self.assertIn('.pdf-viewer-shell.is-expanded .pdf-snapshot-frame', html)
        self.assertIn('@media (max-width:760px)', html)
        self.assertIn('height:64svh', html)

    def test_dashboard_navigation_resets_scroll_when_changing_view_or_opening_a_monitor(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(source.count('window.scrollTo({ top: 0, behavior: "auto" })'), 2)
        self.assertIn('document.addEventListener("keydown"', source)


    def test_dashboard_restores_the_intentional_style_cascade_and_versions_the_script(self):
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn('id="premium-responsive-redesign"', source)
                self.assertIn('id="professional-ux-rebuild"', source)
                self.assertIn('id="dashboard-ux-followup"', source)
                self.assertIn('dashboard.js?v=20261019-data-origin-1', source)
                self.assertIn('id="monitorListControls"', source)

    def test_mobile_inventory_progressively_discloses_the_full_watchlist(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'state.showAllMonitorsMobile',
            'data-monitor-list-toggle=',
            'all.slice(0, 6)',
            'Show all " + all.length + " monitors',
            'Federal Reserve " + label',
            'cs-title:v3:',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)



    def test_dashboard_data_is_published_same_origin_with_raw_fallback(self):
        script = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'const DATA_PATHS = {',
            'report: new URL("./data/report.json", document.baseURI).href',
            'inventory: new URL("./data/latest.json", document.baseURI).href',
            'async function fetchDataAsset(key, required)',
            'RAW + "/" + path',
            'Dashboard data loaded',
        ):
            with self.subTest(token=token):
                self.assertIn(token, script)
        workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
        for token in (
            'cp data/report.json site/data/report.json',
            'cp data/latest.json site/data/latest.json',
            'cp data/history/index.json site/data/history/index.json',
            'cp data/notifications.json site/data/notifications.json',
            'cp data/notification-outbox.json site/data/notification-outbox.json',
            'cp config/sources.json site/config/sources.json',
            '"data/report.json"',
            '"data/latest.json"',
            '"config/sources.json"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, workflow)

            for workflow_path in (
            ".github/workflows/regulatory-monitor.yml",
            ".github/workflows/register-monitor.yml",
        ):
            with self.subTest(workflow_path=workflow_path):
                workflow_source = (ROOT / workflow_path).read_text(encoding="utf-8")
                self.assertIn("gh workflow run pages.yml", workflow_source)

def test_mobile_monitor_rows_use_three_direct_columns_and_readable_type(self):
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn('@media (max-width:760px)', source)
                self.assertIn('.monitor-card { grid-template-columns:20px minmax(0,1fr) auto !important;', source)
                self.assertIn('.dashboard-hero { grid-template-columns:minmax(0,1fr);', source)
                self.assertIn('.dashboard-hero .hero-copy > p { font-size:12px;', source)


if __name__ == "__main__":
    unittest.main()
