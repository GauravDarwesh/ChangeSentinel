import json
import re
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


class TestDashboardNotificationContract(unittest.TestCase):
    def test_notification_view_is_present(self):
        html = read("index.html")
        for token in (
            'data-view="notifications"',
            'id="notificationsView"',
            'id="notificationPendingItems"',
            'id="notificationSentItems"',
            'id="navNotificationCount"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, html)

    def test_dashboard_loads_durable_outbox_and_sent_ledger(self):
        source = read("dashboard.js")
        for token in (
            'outbox: "data/notification-outbox.json"',
            'notifications: "data/notifications.json"',
            "function renderNotifications()",
            'notificationMap(state.outbox, "pending_events")',
            'notificationMap(state.notifications, "sent_events")',
            "safeHttpUrl(item.url)",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_delivery_history_only_uses_fields_preserved_in_ledger(self):
        source = read("dashboard.js")
        start = source.index('$("notificationSentItems").innerHTML')
        end = source.index("function renderLists()", start)
        sent_renderer = source[start:end]
        self.assertIn("item.kind", sent_renderer)
        self.assertIn("item.sent_at", sent_renderer)
        self.assertIn("item.eventId", sent_renderer)
        # The ledger stores topic/url only for newer entries; older ones must still render.
        self.assertIn("item.topic ?", sent_renderer)
        self.assertIn("safeHttpUrl(item.url) ?", sent_renderer)


class TestDashboardEvidenceContract(unittest.TestCase):
    def test_original_pdf_snapshot_is_previewed_and_text_remains_available(self):
        source = read("dashboard.js")
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

    def test_pdf_reader_expands_and_closes_with_escape(self):
        source = read("dashboard.js")
        for token in (
            'class="pdf-viewer-shell" id="pdfViewerShell"',
            'data-pdf-action="expand"',
            'data-pdf-action="close"',
            "function setPdfViewerExpanded(expanded)",
            'document.body.classList.toggle("pdf-viewer-open", expanded)',
            'event.key === "Escape"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        html = read("index.html")
        self.assertIn(".pdf-viewer-shell.is-expanded .pdf-snapshot-frame", html)
        self.assertIn("height: min(76dvh, 940px)", html)

    def test_extracted_markdown_tables_are_rendered_as_html_tables(self):
        lib = read("dashboard-lib.js")
        self.assertIn("function splitMarkdownTableRow(line)", lib)
        self.assertIn("function isMarkdownTableSeparator(cells)", lib)
        source = read("dashboard.js")
        self.assertIn("L.splitMarkdownTableRow", source)
        self.assertIn('<table class="doc-table"', source)
        self.assertIn('renderCells(header, "th")', source)
        self.assertRegex(read("index.html"), r"\.doc-table-wrap \{[^}]*overflow-x: auto")

    def test_changes_are_shown_as_a_redline_with_raw_diffs_available(self):
        source = read("dashboard.js")
        for token in ("L.renderRedline(evidence.diff", "L.renderUnifiedDiff(evidence.html_diff", 'data-diff-mode="', "Text diff", "HTML diff"):
            with self.subTest(token=token):
                self.assertIn(token, source)
        html = read("index.html")
        for token in (".redline del", ".redline ins", ".rl-changed::before", "--font-doc"):
            with self.subTest(token=token):
                self.assertIn(token, html)


class TestDashboardWorkspaceLayout(unittest.TestCase):
    """The page itself never scrolls: a rail, a list pane and a detail pane."""

    def test_rail_list_and_detail_panes_exist_for_every_view(self):
        html = read("index.html")
        self.assertIn('<nav class="rail" aria-label="Workspace">', html)
        for view in ("overview", "changes", "monitors", "runs", "notifications"):
            with self.subTest(view=view):
                self.assertIn('data-view="' + view + '"', html)
        for view_id in ("overviewView", "changesView", "monitorsView", "runsView", "notificationsView"):
            with self.subTest(view_id=view_id):
                self.assertIn('id="' + view_id + '"', html)
        for split in ("changesView", "monitorsView", "runsView", "notificationsView"):
            with self.subTest(split=split):
                self.assertRegex(html, 'id="' + split + '" class="view view-split"')
        for pane in ("changeDetail", "detailView", "runDetail", "notificationDetail"):
            with self.subTest(pane=pane):
                self.assertIn('id="' + pane + '"', html)

    def test_panes_scroll_independently_and_the_page_does_not(self):
        html = read("index.html")
        self.assertRegex(html, r"body \{[^}]*overflow: hidden")
        self.assertRegex(html, r"\.list-body \{[^}]*overflow-y: auto")
        self.assertRegex(html, r"\.detail-pane \{[^}]*overflow-y: auto")

    def test_responsive_and_accessible_by_default(self):
        html = read("index.html")
        self.assertIn("viewport-fit=cover", html)
        self.assertIn("@media (max-width: 1240px)", html)
        self.assertIn("@media (max-width: 980px)", html)
        self.assertIn(".view-split.has-selection .detail-pane { display: block; }", html)
        self.assertIn("env(safe-area-inset-bottom)", html)
        self.assertIn("@media (prefers-reduced-motion: reduce)", html)
        self.assertIn(":focus-visible", html)
        source = read("dashboard.js")
        self.assertIn('window.matchMedia("(max-width: 980px)")', source)
        self.assertIn("data-back", source)

    def test_dark_and_light_themes_share_one_token_set(self):
        html = read("index.html")
        self.assertIn('<html lang="en" data-theme="dark">', html)
        self.assertIn(':root[data-theme="light"]', html)
        # The saved theme is applied before first paint.
        self.assertLess(html.index('localStorage.getItem("cs-theme")'), html.index("<style"))
        source = read("dashboard.js")
        self.assertIn("data-theme-toggle", source)
        self.assertIn('localStorage.setItem("cs-theme", next)', source)

    def test_one_stylesheet_and_versioned_scripts(self):
        html = read("index.html")
        self.assertEqual(html.count("<style"), 1)
        lib = re.search(r'src="dashboard-lib\.js\?v=([^"]+)"', html)
        app = re.search(r'src="dashboard\.js\?v=([^"]+)"', html)
        self.assertTrue(lib and app)
        self.assertEqual(lib.group(1), app.group(1))
        self.assertLess(html.index('src="dashboard-lib.js'), html.index('src="dashboard.js'))

    def test_pages_publishes_the_helper_library(self):
        workflow = read(".github/workflows/pages.yml")
        self.assertIn("cp dashboard-lib.js site/dashboard-lib.js", workflow)
        self.assertIn('- "dashboard-lib.js"', workflow)

    def test_selection_resets_detail_scroll_and_keyboard_moves_through_lists(self):
        source = read("dashboard.js")
        self.assertIn("function resetDetailScroll(view)", source)
        self.assertGreaterEqual(source.count('window.scrollTo({ top: 0, behavior: "auto" })'), 2)
        self.assertIn('document.addEventListener("keydown"', source)
        self.assertIn('event.key !== "ArrowDown" && event.key !== "ArrowUp"', source)

    def test_page_rows_and_deep_links(self):
        source = read("dashboard.js")
        for token in ("data-status-kind=", "data-monitor-id=", "function readHash()", "monitor=([^&]+)"):
            with self.subTest(token=token):
                self.assertIn(token, source)


class TestDashboardScanSignal(unittest.TestCase):
    def test_led_change_field_uses_real_scans_and_statuses(self):
        source = read("dashboard.js")
        for token in (
            "function renderMonitoringSignal()",
            "L.scanSlots(new Date(), geometry.slots)",
            "L.slotState(slot, page)",
            "scansBySource[item.source_id]",
            "itemChangeEntries(item)",
            "function updateNextRunCountdown()",
            "L.scanCycle(new Date())",
            "window.setInterval(updateNextRunCountdown, 30000)",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        lib = read("dashboard-lib.js")
        self.assertIn("function nextScheduledScan(reference = new Date())", lib)
        self.assertIn("0 */6 * * * (UTC)", lib)
        html = read("index.html")
        self.assertIn('id="signalVisual"', html)
        self.assertIn('id="cycleBar"', html)
        self.assertIn(".led.is-now", html)
        # The old decorative sweep is gone: nothing spins.
        self.assertNotIn("signal-sweep", html + source)


class TestDashboardDataLoading(unittest.TestCase):
    def test_missing_scan_completeness_metadata_fails_closed(self):
        source = read("dashboard.js")
        for token in (
            "const incompleteDiscovery = discoveryEntries.length === 0 || discoveryEntries.some",
            "const noActiveSources = activeIds.length === 0",
            "state.report.baseline_update_allowed !== true || incompleteDiscovery",
            '", no active sources configured"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_parseable_but_malformed_dashboard_assets_are_rejected(self):
        source = read("dashboard.js")
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
        script = read("dashboard.js")
        for token in (
            "const DATA_PATHS = {",
            'report: new URL("./data/report.json", document.baseURI).href',
            'inventory: new URL("./data/latest.json", document.baseURI).href',
            "async function fetchDataAsset(key, required)",
            'RAW + "/" + path',
            "Latest saved scan",
            "Monitoring data stale",
            "Latest scan incomplete",
            "Latest scan partial",
            "const missingActiveSources = activeIds.filter",
            "active sources represented",
        ):
            with self.subTest(token=token):
                self.assertIn(token, script)
        workflow = read(".github/workflows/pages.yml")
        for token in (
            "cp data/report.json site/data/report.json",
            "cp data/latest.json site/data/latest.json",
            "cp data/history/index.json site/data/history/index.json",
            "cp data/notifications.json site/data/notifications.json",
            "cp data/notification-outbox.json site/data/notification-outbox.json",
            "cp config/sources.json site/config/sources.json",
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
                self.assertIn("gh workflow run pages.yml", read(workflow_path))

class TestPersistedReferences(unittest.TestCase):
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
        self.assertIn('fetch(bust(RAW + "/" + location)', dashboard)
        self.assertIn("loadEvidence(event.evidence_location)", dashboard)




class TestSingleDashboardEntry(unittest.TestCase):
    def test_legacy_entry_redirects_to_the_main_dashboard(self):
        legacy = read("dashboard-v2.html")
        self.assertIn('http-equiv="refresh" content="0; url=./"', legacy)
        self.assertLess(len(legacy.splitlines()), 30)


class TestCrossRunChangeLog(unittest.TestCase):
    def test_change_log_and_counters_share_one_definition_and_span_runs(self):
        source = read("dashboard.js")
        self.assertIn("function changeLogEntries()", source)
        self.assertIn("item.change_history", source)
        self.assertIn('$("navChangeCount").textContent = changes;', source)
        route = source[source.index("function renderChangeRoute()"):source.index("function pageRow(item)")]
        self.assertIn("changeLogEntries()", route)
        self.assertIn("parser re-baseline", route)
        status = source[source.index("function itemStatus(item)"):source.index("function canonicalForDashboard")]
        self.assertIn("RECENT_CHANGE_MS", status)
        self.assertIn('event.event_type !== "BASELINE_MIGRATION"', status)


if __name__ == "__main__":
    unittest.main()
