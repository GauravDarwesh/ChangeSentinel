import json
import unittest
from pathlib import Path, PurePosixPath


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
        for filename in ("index.html",):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                for token in required:
                    self.assertIn(token, source)

    def test_dashboard_loads_durable_outbox_and_sent_ledger(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            'outbox: "data/notification-outbox.json"',
            'notifications: "data/notifications.json"',
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
        # The ledger now stores topic/url; older entries without them must still render.
        self.assertIn("item.topic ?", sent_renderer)
        self.assertIn("safeHttpUrl(item.url) ?", sent_renderer)

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
        for filename in ("index.html",):
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
        for filename in ("index.html",):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn('id="premium-responsive-redesign"', source)
                self.assertIn('id="professional-ux-rebuild"', source)
                self.assertIn('id="dashboard-ux-followup"', source)
                self.assertIn('dashboard.js?v=20261019-mobile-header-2', source)
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



    def test_missing_scan_completeness_metadata_fails_closed(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            "const incompleteDiscovery = discoveryEntries.length === 0 || discoveryEntries.some",
            "const noActiveSources = activeIds.length === 0",
            "state.report.baseline_update_allowed !== true || incompleteDiscovery",
            '" · no active sources configured"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_parseable_but_malformed_dashboard_assets_are_rejected(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            "function isValidDataAssetShape(key, value)",
            'case "report":',
            'case "inventory":',
            'case "history":',
            'case "notifications":',
            'case "outbox":',
            'case "config":',
            "if (!isValidDataAssetShape(key, value))",
            'failures.push(host + " returned JSON with invalid schema")',
            'throw new Error("Invalid monitoring data schema: " + invalid.join(", "))',
            "validateDataAssets({ report, inventory, historyData, notifications, outbox, config })",
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
            'Latest saved scan',
            'Monitoring data stale',
            'Latest scan incomplete',
            'Latest scan partial',
            'const missingActiveSources = activeIds.filter',
            'active sources represented',
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

    def test_mobile_header_brand_stays_visible_and_monitor_rows_have_breathing_room(self):
        for filename in ("index.html",):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn('@media (max-width:760px)', source)
                self.assertIn('.mobile-wordmark {\n      display:flex !important;', source)
                self.assertIn('.mobile-wordmark .brand-name {\n      display:block !important;', source)
                self.assertIn('backdrop-filter:none !important;', source)
                self.assertIn('-webkit-backdrop-filter:none !important;', source)
                self.assertIn('.monitor-card {\n      grid-template-columns:20px minmax(0,1fr) !important;', source)
                self.assertIn('.dashboard-hero { grid-template-columns:minmax(0,1fr);', source)
                self.assertIn('.dashboard-hero .hero-copy > p { margin-top:9px; font-size:13px;', source)
                self.assertIn('.monitor-bottom { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));', source)


    def test_snapshot_and_evidence_references_exist_in_repository_data(self):
        """Raw GitHub is the snapshot/evidence origin; every persisted pointer must resolve."""
        latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
        report = json.loads((ROOT / "data" / "report.json").read_text(encoding="utf-8"))
        dashboard = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        checked = set()

        def check_reference(value, label, *, non_empty=False):
            if not value:
                return
            relative = PurePosixPath(str(value))
            self.assertFalse(relative.is_absolute(), f"{label} must be repository-relative: {value}")
            self.assertNotIn("..", relative.parts, f"{label} must not traverse directories: {value}")
            self.assertTrue(relative.parts and relative.parts[0] == "data", f"{label} must stay in data/: {value}")
            target = ROOT.joinpath(*relative.parts)
            self.assertTrue(target.is_file(), f"{label} points to a missing repository file: {value}")
            if non_empty:
                self.assertGreater(target.stat().st_size, 0, f"{label} points to an empty original file: {value}")
            checked.add(str(relative))

        # Keep the inventory shape check, then walk both JSON documents recursively.
        # Aggregate report events embed before/after inventory records inside
        # event.evidence.previous/current; those references must be checked too.
        for source_id, records in (latest.get("sources") or {}).items():
            self.assertIsInstance(records, dict, f"inventory for {source_id} must be an object")

        def walk_references(value, label):
            if isinstance(value, dict):
                for key, child in value.items():
                    child_label = f"{label}.{key}"
                    if key in (
                        "snapshot_location",
                        "html_snapshot_location",
                        "file_snapshot_location",
                        "evidence_location",
                    ):
                        check_reference(
                            child,
                            child_label,
                            non_empty=(key == "file_snapshot_location"),
                        )
                    else:
                        walk_references(child, child_label)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    walk_references(child, f"{label}[{index}]")

        walk_references(latest, "latest")
        walk_references(report, "report")

        # Integrity alone is not enough if a required pointer is absent. Check
        # completeness for active sources while leaving old/inactive inventories
        # with legacy snapshot gaps readable and non-blocking.
        config = json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))
        active_source_ids = {
            source.get("id")
            for source in (config.get("sources") or [])
            if source.get("id") and source.get("active") is not False
        }
        inventories = latest.get("sources") or {}
        for source_id in sorted(active_source_ids):
            records = inventories.get(source_id) or {}
            self.assertIsInstance(records, dict, f"inventory for active source {source_id} must be an object")
            for url_id, item in records.items():
                self.assertIsInstance(item, dict, f"inventory record {source_id}/{url_id} must be an object")
                label = f"active source {source_id}/{url_id}"
                if item.get("normalized_hash"):
                    self.assertTrue(
                        item.get("snapshot_location"),
                        f"{label} has normalized content but no snapshot_location",
                    )
                # Fetch failures may legitimately prevent creation of a first
                # snapshot. Every successful full/conditional fetch of a known
                # HTML/PDF/ZIP item must retain its source asset pointer.
                if item.get("fetch_error"):
                    continue
                extraction_type = str(item.get("extraction_type") or "").lower()
                if extraction_type == "html":
                    self.assertTrue(
                        item.get("html_snapshot_location"),
                        f"{label} is HTML but has no html_snapshot_location",
                    )
                elif extraction_type in {"pdf", "zip"}:
                    self.assertTrue(
                        item.get("file_snapshot_location"),
                        f"{label} is {extraction_type.upper()} but has no file_snapshot_location",
                    )

        self.assertTrue(checked, "The test fixture should exercise at least one persisted reference")
        # Make the remote asset origin an explicit part of the client contract:
        # Pages ships the UI/core JSON, while snapshot bytes and evidence use raw GitHub.
        self.assertIn(
            'const RAW = "https://raw.githubusercontent.com/" + REPOSITORY.owner + "/" + REPOSITORY.repo + "/main";',
            dashboard,
        )
        self.assertIn('return { owner: "GauravDarwesh", repo: "ChangeSentinel" };', dashboard)
        self.assertIn(
            'function snapshotURL(path) { return path ? bust(RAW + "/" + path) : ""; }',
            dashboard,
        )
        self.assertIn('fetch(bust(RAW + "/" + event.evidence_location)', dashboard)


class TestSingleDashboardEntry(unittest.TestCase):
    def test_legacy_entry_redirects_to_the_main_dashboard(self):
        legacy = (ROOT / "dashboard-v2.html").read_text(encoding="utf-8")
        self.assertIn('http-equiv="refresh" content="0; url=./"', legacy)
        self.assertLess(len(legacy.splitlines()), 30)


class TestCrossRunChangeLog(unittest.TestCase):
    def test_change_log_and_counters_share_one_definition_and_span_runs(self):
        source = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn("function changeLogEntries()", source)
        self.assertIn("item.change_history", source)
        self.assertIn('$("navChangeCount").textContent = changes;', source)
        route = source[source.index("function renderChangeRoute()"):source.index("function renderRuns()")]
        self.assertIn("changeLogEntries()", route)
        self.assertIn("parser re-baseline", route)
        status = source[source.index("function itemStatus(item)"):source.index("function canonicalForDashboard")]
        self.assertIn("RECENT_CHANGE_MS", status)
        self.assertIn('event.event_type !== "BASELINE_MIGRATION"', status)



class TestDashboardLeftWorkspace(unittest.TestCase):
    def test_primary_navigation_moves_to_a_desktop_left_rail(self):
        source = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="dashboard-left-workspace"', source)
        self.assertIn("grid-template-columns: 248px minmax(0, 1fr);", source)
        self.assertIn(".command-topbar {", source)
        self.assertIn(".command-nav {", source)
        self.assertIn("@media (max-width: 900px)", source)

    def test_radar_sweep_uses_the_chart_center_and_reduced_motion_fallback(self):
        source = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("transform-box: view-box;", source)
        self.assertIn("transform-origin: 50% 49.4%;", source)
        self.assertIn("@media (prefers-reduced-motion: reduce)", source)
        self.assertIn(".signal-svg .signal-sweep { animation: none !important; }", source)


if __name__ == "__main__":
    unittest.main()
