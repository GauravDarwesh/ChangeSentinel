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



    def test_evidence_first_responsive_workspace_is_published_in_both_entries(self):
        required = (
            'id="evidence-first-design-system"',
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
            'color-scheme:light;',
            '--blue:#245e40;',
            '@media(max-width:1100px)',
            '@media(max-width:780px)',
            'viewport-fit=cover',
            'env(safe-area-inset-bottom)',
            '.pdf-viewer-shell.is-expanded',
        )
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                for token in required:
                    self.assertIn(token, source)
                self.assertEqual(source.count("<style"), 1)
                self.assertNotIn('id="premium-responsive-redesign"', source)
                self.assertNotIn('id="professional-ux-rebuild"', source)
                self.assertNotIn('id="dashboard-ux-followup"', source)
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
        self.assertIn('height:min(74dvh,880px)', html)
        self.assertIn('.pdf-viewer-shell.is-expanded .pdf-snapshot-frame', html)
        self.assertIn('@media(max-width:780px)', html)
        self.assertIn('height:66svh', html)

    def test_dashboard_navigation_resets_scroll_when_changing_view_or_opening_a_monitor(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(source.count('window.scrollTo({ top: 0, behavior: "auto" })'), 2)
        self.assertIn('document.addEventListener("keydown"', source)


    def test_dashboard_uses_one_intentional_design_system(self):
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn('id="evidence-first-design-system"', source)
                self.assertIn('dashboard.js?v=20261019-evidence-workspace-1', source)
                self.assertIn('id="monitorListControls"', source)
                self.assertEqual(source.count("<style"), 1)
                self.assertNotIn('id="premium-responsive-redesign"', source)
                self.assertNotIn('id="professional-ux-rebuild"', source)
                self.assertNotIn('id="dashboard-ux-followup"', source)

    def test_detail_tabs_prioritize_snapshot_and_change_evidence_on_all_entrypoints(self):
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                start = source.index('<nav id="detailTabs"')
                end = source.index("</nav>", start)
                tabs = source[start:end]
                snapshot = tabs.index('data-detail-tab="snapshot"')
                changes = tabs.index('data-detail-tab="changes"')
                html_source = tabs.index('data-detail-tab="source"')
                details = tabs.index('data-detail-tab="details"')
                self.assertLess(snapshot, changes)
                self.assertLess(changes, html_source)
                self.assertLess(html_source, details)

    def test_selected_monitor_scrolls_to_the_detail_workspace(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn('detail.scrollIntoView({ block: "start", behavior: "auto" })', source)

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


    def test_inventory_is_the_first_home_section_and_has_a_top_level_add_action(self):
        for filename in ("index.html", "dashboard-v2.html"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                inventory = source.index('<section class="inventory-panel"')
                metrics = source.index('<div class="metrics"')
                hero = source.index('<div class="page-heading dashboard-hero"')
                self.assertLess(inventory, metrics)
                self.assertLess(metrics, hero)
                self.assertIn('id="watchlistAddMonitorBtn"', source)
                self.assertIn('.inventory-tools', source)
        script = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn('$("watchlistAddMonitorBtn").addEventListener("click", openAddMonitor);', script)



if __name__ == "__main__":
    unittest.main()
