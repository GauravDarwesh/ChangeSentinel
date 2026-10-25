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
            "fetchImmutable(filePath)",
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

    def test_pdf_full_screen_escapes_the_detail_pane(self):
        # A finished entrance animation that keeps its transform (fill-mode both)
        # makes the element a containing block for position: fixed, which trapped
        # the "full screen" PDF inside its panel.
        html = read("index.html")
        self.assertNotRegex(html, r"animation: rise [^;]* both;")
        source = read("dashboard.js")
        self.assertIn("shell.requestFullscreen || shell.webkitRequestFullscreen", source)
        self.assertIn('"fullscreenchange", "webkitfullscreenchange"', source)

    def test_scan_history_offers_grid_and_timeline_views(self):
        html = read("index.html")
        for token in ('data-field-view="grid"', 'data-field-view="timeline"', 'id="timelineView"', 'data-legend-for="timeline"'):
            with self.subTest(token=token):
                self.assertIn(token, html)
        source = read("dashboard.js")
        self.assertIn("function renderTimeline(columns)", source)
        self.assertIn("view: f.view", source)

    def test_phone_bar_keeps_ask_and_puts_health_in_more(self):
        html = read("index.html")
        for token in ('id="navMore"', 'id="moreSheet"', ".rail-nav > .nav-ask, .rail-nav > .nav-more { display: block; }",
                      ".rail-nav { grid-template-columns: repeat(6, minmax(0, 1fr));"):
            with self.subTest(token=token):
                self.assertIn(token, html)
        source = read("dashboard.js")
        self.assertIn('const MORE_VIEWS = { health: "Health"', source)
        self.assertIn('data-more-go="health"', source)

    def test_phone_overview_and_more_sheet_do_not_repeat_each_other(self):
        # Health lives in More; Reload, Scan now, Add link and the theme live at
        # the top of the phone Overview. Neither place repeats the other.
        html = read("index.html")
        self.assertNotIn('id="mobileHealth"', html)
        self.assertIn('<div class="mobile-actions">', html)
        source = read("dashboard.js")
        self.assertNotIn("more-actions", source)
        # The scan cards sit under the lede without the generic block margin.
        self.assertIn(".overview-text .scan-pair .block { min-width: 0; margin-top: 0;", html)

    def test_scan_history_legend_does_not_move_between_views(self):
        html = read("index.html")
        self.assertIn('<div class="field-legends">', html)
        # [hidden] is display: none !important here, so the idle legend is only made invisible.
        self.assertIn(".field-legends > .field-legend[data-off] { visibility: hidden; }", html)
        self.assertIn('legend.toggleAttribute("data-off", off);', read("dashboard.js"))

    def test_timeline_has_its_own_filters_and_shows_the_next_scan(self):
        html = read("index.html")
        for token in ('data-tools-for="timeline"', 'data-tl-show="changed"', 'data-tl-show="markup"', 'id="tlLanes"', '<option value="page">One lane per page</option>'):
            with self.subTest(token=token):
                self.assertIn(token, html)
        source = read("dashboard.js")
        for token in ('class="tl-next-label"', 'class="tl-next-dot"', 'class="tl-link"', 'class="tl-tail"', "L.timelineGapWords(bead.after)"):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_health_week_numbers_use_dials(self):
        source = read("dashboard.js")
        self.assertIn("function healthDial(days, field, cls, words)", source)
        self.assertNotIn("healthSpark", source)

    def test_health_view_is_interactive(self):
        source = read("dashboard.js")
        for token in ("function healthMatrix(health)", "function healthInsightSheet(health)", "function showHealthCellTip(cell)", "function showHealthChartTip(group)"):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_scan_history_clip_ignores_sticky_scroll_offsets(self):
        # offsetTop of a sticky header includes how far it is stuck, so the clip
        # must come from on-screen edges or the lights vanish after "Show more".
        source = read("dashboard.js")
        self.assertIn("head.getBoundingClientRect().bottom - frameBox.top", source)
        self.assertNotIn("clipTop = pulse ? pulse.offsetTop", source)

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
        self.assertIn('<html lang="en" data-theme="light">', html)
        self.assertIn(':root[data-theme="light"]', html)
        # Every visitor starts in light mode before the dashboard stylesheet renders,
        # even if this browser previously stored a dark-theme preference.
        self.assertIn('document.documentElement.setAttribute("data-theme", "light")', html)
        self.assertIn('localStorage.setItem("cs-theme", "light")', html)
        self.assertLess(html.index('document.documentElement.setAttribute("data-theme", "light")'), html.index("<style"))
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

    def test_html_redlines_scope_table_changes_to_exact_rows(self):
        source = read("dashboard.js")
        lib = read("dashboard-lib.js")
        for token in (
            "function markdownTableCells(line)",
            "function matchingTableRow(doc, cells)",
            "L.tableCellsMatch(cells, actual)",
            "const row = matchingTableRow(doc, target.tableCells)",
            "if (!row) return; // Fail closed instead of highlighting a plausible but wrong match.",
            "directMarked += markEntireTableRow(row, cls)",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertIn("function tableCellsMatch(expected, actual)", lib)

    def test_markup_only_events_have_quieter_visual_tone(self):
        html = read("index.html")
        lib = read("dashboard-lib.js")
        self.assertIn('if (type === "HTML_SOURCE_CHANGED") return "markup";', lib)
        self.assertIn(".tag.tone-markup", html)
        self.assertIn(".row-mark.tone-markup", html)

    def test_select_chevrons_are_inset_from_field_edge(self):
        html = read("index.html")
        start = html.index("select.field-input {")
        end = html.index("}", start)
        select_css = html[start:end]
        self.assertIn("appearance: none", select_css)
        self.assertIn("padding-right: 34px", select_css)
        self.assertIn("right 14px center", select_css)

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
            # The field shows six-hour windows; the countdown still sees every saved scan.
            "L.slotColumns(state.history, { workflowRuns: state.workflowRuns })",
            # The field opens on a lens over a chosen range and folds quiet pages into summary rows.
            "L.fieldWindow(allColumns, prefs.range, new Date())",
            "L.fieldRows(pages, { lens: prefs.lens, query: prefs.query, groupBy: prefs.groupBy, open: prefs.open, closed: prefs.closed, limit: prefs.limit, limits: prefs.limits })",
            "L.pendingScan(new Date(), scans, state.workflowRuns)",
            "pending: Boolean(item.pending_registration)",
            "L.columnCellState(column, page)",
            "itemChangeEntries(item)",
            "function updateNextRunCountdown()",
            "window.setInterval(updateNextRunCountdown, 30000)",
            # Live run status comes from the public Actions API and fails quietly.
            "/actions/workflows/regulatory-monitor.yml/runs?per_page=40",
            "workflowBackoffUntil = Date.now() + 15 * 60000",
            # The lights are painted on a canvas that pauses when off screen.
            "const ledField = (() => {",
            "prefers-reduced-motion: reduce",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        lib = read("dashboard-lib.js")
        self.assertIn("function nextScheduledScan(reference = new Date())", lib)
        self.assertIn("0 */6 * * * (UTC)", lib)
        html = read("index.html")
        for token in ('id="signalVisual"', 'id="cycleBar"', 'id="fieldCanvas"', ".led.s-pending", "--state-change"):
            with self.subTest(token=token):
                self.assertIn(token, html)
        # "No scan" cells are gone: an unscanned cell is simply not drawn.
        self.assertNotIn("No scan</span>", html)
        self.assertNotIn("signal-sweep", html + source)

    def test_development_gate_hides_the_workspace_and_stores_only_a_hash(self):
        html = read("index.html")
        self.assertIn('id="csPasswordGate"', html)
        self.assertIn("html.cs-locked #app", html)
        self.assertIn('crypto.subtle.digest("SHA-256"', html)
        self.assertNotIn("correctPassword", html)

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
            "validateDataAssets({\n      report: values.report, inventory: values.inventory, historyData: values.history,",
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

    def test_registration_requests_for_distinct_issues_are_not_cancelled_by_concurrency(self):
        workflow = read(".github/workflows/register-monitor.yml")
        # GitHub keeps at most one pending run per concurrency group. The group must
        # therefore be issue-scoped so rapid bulk uploads cannot drop intervening requests.
        self.assertIn("group: register-dashboard-monitor-${{ github.event.issue.number }}", workflow)
        self.assertNotIn("group: register-dashboard-monitor\n  cancel-in-progress", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("for attempt in 1 2 3 4 5 6; do", workflow)
        self.assertIn("sleep $((attempt * 2 + RANDOM % 3))", workflow)

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
        # Snapshot and evidence files are content-addressed and immutable, so they
        # are cacheable; a transient raw-CDN 404 is retried once past every cache.
        self.assertIn('function snapshotURL(path) { return path ? RAW + "/" + path : ""; }', dashboard)
        self.assertIn('return response.ok ? response : fetch(bust(url), { cache: "no-store" });', dashboard)
        self.assertIn("fetchImmutable(location)", dashboard)
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

    def test_bulk_link_import_is_an_additive_owner_approved_flow(self):
        html = read("index.html")
        js = read("dashboard.js")
        for token in ('id="bulkMonitorFile"', 'accept=".csv,.xlsx', 'id="bulkImportPreview"',
                      'id="bulkRequests"', 'id="bulkTemplateLink"', 'BULK_REQUEST_MARKER'):
            with self.subTest(token=token):
                self.assertIn(token, html + js)
        for token in ("function parseCsvMatrix(", "function bulkRowsFromMatrix(", "function makeBulkGitHubIssueUrl(",
                      "BULK_DATA_JSON:", "MAX_BULK_LINKS = 25", "L.xlsxFirstSheetRows(",
                      "Continue with", "The dashboard stores no access token"):
            with self.subTest(token=token):
                self.assertIn(token, js + html)
        self.assertIn('$("bulkMonitorFile").addEventListener("change"', js)
        # Spreadsheets are read locally; no third-party parser runs in the dashboard origin.
        self.assertNotIn("cdn.sheetjs.com", js + html)

class TestAddLinkFlow(unittest.TestCase):
    """Add a link: explore a page or follow its links by level, then confirm a checklist."""

    def test_the_whole_flow_lives_in_the_add_a_link_dialog(self):
        html = read("index.html")
        js = read("dashboard.js")
        dialog = html[html.index('id="addMonitorDialog"'):html.index('id="deleteMonitorDialog"')]
        for token in ('name="addMethod" value="explore"', 'name="addMethod" value="crawl"', 'id="newMonitorDepth"', 'id="newPickScope"',
                      'data-add-step-panel="explore"', 'data-add-step-panel="crawl"', 'data-add-step-panel="review"',
                      'id="exploreFrame"', 'id="exploreSelectMode"', 'id="reviewList"', 'id="bulkMonitorFile"', 'id="addExactSubmit"'):
            with self.subTest(token=token):
                self.assertIn(token, dialog)
        # No separate view or tray: everything happens inside Add a link.
        for removed in ('id="pickView"', 'data-view="pick"', 'id="discoverySelectionDialog"', 'id="selectVisibleScout"', 'data-discovery-select'):
            self.assertNotIn(removed, html + js)

    def test_a_closed_dialog_is_never_laid_out(self):
        # Setting display on a <dialog> overrides the browser's rule that hides a
        # closed one; it then covers the dashboard and swallows clicks.
        html = read("index.html")
        for rule in re.findall(r"\.add-link(?:\.[\w-]+)?\s*\{[^}]*\}", html):
            with self.subTest(rule=rule):
                self.assertNotRegex(rule, r"(^|[;{\s])display\s*:", "only .add-link[open] may set display")
        self.assertIn(".add-link[open] { display: flex;", html)

    def test_the_explored_page_runs_only_the_bridge_in_an_opaque_origin(self):
        # Safari never runs listeners the parent attaches inside a script-less
        # sandboxed frame, so clicks are reported from inside the frame by one
        # nonce-locked bridge script. Without allow-same-origin the copy runs in an
        # opaque origin and cannot reach the dashboard, its storage or its cookies.
        html = read("index.html")
        js = read("dashboard.js")
        frame = re.search(r'<iframe id="exploreFrame"[^>]*>', html).group(0)
        self.assertIn('sandbox="allow-scripts"', frame)
        for forbidden in ("allow-same-origin", "allow-forms", "allow-top-navigation", "allow-popups", "allow-modals"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, frame)
                self.assertNotIn(forbidden, js[js.index("function scoutPreviewShell("):js.index("let scoutPreviewTimer")])
        self.assertIn('sandbox="allow-scripts" referrerpolicy="no-referrer"', js)
        self.assertIn("script-src \\'nonce-' + nonce + '\\'", js)
        self.assertIn("connect-src 'none'", js)
        self.assertIn("form-action 'none'", js)
        # The reader's own policy (script-src 'none') is replaced, never combined.
        self.assertIn('http-equiv\\s*=\\s*["\']?content-security-policy', js)
        # Messages count only from the frame itself, with this load's token.
        self.assertIn("event.source !== frame.contentWindow", js)
        self.assertIn("data.token !== state.add.frameToken", js)
        self.assertIn("if (shift || a.selectMode) { addToggle(item); return; }", js)
        self.assertNotIn("contentDocument.documentElement.classList", js)
        reader = read("supabase/functions/page-reader/index.ts")
        self.assertIn("script-src 'none'", reader)
        self.assertIn("checkResolvesPublic(url)", reader)
        self.assertIn("redirect: 'manual'", reader)

    def test_nothing_is_ticked_for_the_owner_and_requests_stay_owner_approved(self):
        js = read("dashboard.js")
        start = js.index("/* ================= Add a link: explore a page or follow its links")
        module = js[start:js.index("function makeGitHubIssueUrl(", start)]
        self.assertIn("a.picked = new Map();", module[module.index("async function crawlStart("):])
        self.assertIn("makeBulkGitHubIssueUrl, MAX_BULK_LINKS, MAX_BULK_REQUEST_URL_LENGTH", module)
        self.assertIn("nothing is registered until you do", module)
        self.assertIn("githubWindow.opener = null", module)
        self.assertNotIn("api.github.com", module)
        self.assertIn("localStorage.setItem(ADD_DRAFT_STORAGE", module)
        self.assertIn("CRAWL_PAGE_LIMITS = { 1: 1, 2: 60, 3: 150 }", module)
        self.assertIn("esc(item.title)", module)
        self.assertNotIn("${", module)

    def test_reader_endpoint_is_configured_without_secrets(self):
        html = read("index.html")
        js = read("dashboard.js")
        self.assertIn('window.CHANGESENTINEL_PAGE_READER_ENDPOINT = "https://pysoukwmnwwgilkwafdy.supabase.co/functions/v1/page-reader";', html)
        self.assertIn("askSentinelIdentityHeaders(identity)", js)
        self.assertNotIn("sb_secret_", html + js)


class TestThirdPartyScripts(unittest.TestCase):
    def test_every_third_party_script_is_pinned_and_integrity_checked(self):
        html = read("index.html")
        for tag in re.findall(r"<script\b[^>]*\bsrc=\"https?://[^>]*>", html):
            with self.subTest(tag=tag):
                self.assertRegex(tag, r'integrity="sha384-[A-Za-z0-9+/=]{64}"')
                self.assertIn('crossorigin="anonymous"', tag)
                self.assertRegex(tag, r"@\d+\.\d+\.\d+/")

    def test_pdf_renderer_is_a_patched_release_loaded_with_integrity(self):
        js = read("dashboard.js")
        version = re.search(r'const PDFJS_VERSION = "(\d+)\.(\d+)\.(\d+)";', js)
        self.assertIsNotNone(version)
        # CVE-2024-4367 (script execution from a crafted PDF font) is fixed in 4.2.67.
        self.assertGreaterEqual(tuple(int(part) for part in version.groups()), (4, 2, 67))
        self.assertIn("script.integrity = PDFJS_INTEGRITY.lib;", js)
        self.assertIn("integrity: PDFJS_INTEGRITY.worker", js)
        self.assertIn("isEvalSupported: false", js)
        self.assertIn("GlobalWorkerOptions.workerPort = new Worker(workerUrl", js)
        self.assertNotIn("workerSrc =", js)

    def test_ci_runs_the_dashboard_in_a_real_browser(self):
        ci = read(".github/workflows/ci.yml")
        self.assertIn("node scripts/dashboard_smoke.mjs", ci)
        smoke = read("scripts/dashboard_smoke.mjs")
        for token in ("window.supabase.createClient", "loadPdfJs()", "scrollWidth", "cs-dev-access-v1"):
            with self.subTest(token=token):
                self.assertIn(token, smoke)

    def test_compare_documents_are_released(self):
        js = read("dashboard.js")
        self.assertIn("function disposeCompare()", js)
        self.assertIn("task.destroy()", js)
        self.assertIn("await releasingPdfs;", js)
        self.assertIn("activeCompare.observer = observer;", js)

class TestBackgroundRefresh(unittest.TestCase):
    def test_polls_small_files_and_skips_unchanged_redraws(self):
        js = read("dashboard.js")
        self.assertIn('const LARGE_ASSETS = ["inventory", "history", "scoutReview"];', js)
        self.assertIn("if (background && signature === state.renderedSignature)", js)
        self.assertIn("refreshDetailIfChanged(state.view);", js)
        self.assertNotIn('if (state.view !== "monitors") renderDetailFor(state.view);', js)

    def test_workflow_polling_runs_one_chain(self):
        js = read("dashboard.js")
        self.assertIn("workflowRefreshInFlight = pollWorkflowRuns().finally(", js)

class TestAskSentinelVirtualSourceLinks(unittest.TestCase):
    def test_virtual_index_sources_become_clickable_repository_files(self):
        source = read("dashboard.js")
        self.assertIn('"__current_report__": ["data/report.json"]', source)
        self.assertIn('"__recent_history__": ["data/history/index.json"]', source)
        self.assertIn('"__current_scope__": ["config/sources.json", "data/latest.json"]', source)
        self.assertIn("function askSentinelLinkSourceCitations(answer)", source)
        self.assertIn("askSentinelMarkdown(askSentinelLinkSourceCitations(answer))", source)
        self.assertIn(".flatMap(askSentinelSourceLinks)", source)

    def test_manual_monitor_controls_include_bounded_crawl_metadata_and_delete(self):
        html = read("index.html")
        js = read("dashboard.js")
        for token in (
            'id="newMonitorDepth"',
            'id="autofillMonitorMetadata"',
            'id="newMonitorMetadataStatus"',
            'id="deleteMonitorDialog"',
            'id="confirmDeleteMonitor"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, html)
        for token in (
            '"Crawl depth: "',
            "async function suggestMonitorMetadata()",
            "function makeGitHubDeleteIssueUrl(",
            "data-stop-monitor=",
            "function submitDeleteMonitor()",
        ):
            with self.subTest(token=token):
                self.assertIn(token, js)

    def test_stop_monitor_has_explicit_github_handoff_and_survives_missing_add_dialog(self):
        html = read("index.html")
        js = read("dashboard.js")
        self.assertIn("The dashboard cannot stop monitoring directly.", html)
        self.assertIn("you must submit it there.", html)
        self.assertIn("function openDeleteMonitorRequest(target)", js)
        start = js.index("function openDeleteMonitorRequest(target)")
        end = js.index("function makeGitHubDeleteIssueUrl(", start)
        handoff = js[start:end]
        self.assertIn('window.open(target, "_blank")', handoff)
        self.assertIn("githubWindow.opener = null", handoff)
        self.assertNotIn("noopener,noreferrer", handoff)
        self.assertIn("monitoring stops after the request is processed", handoff)
        self.assertIn("const addDialog = $(\"addMonitorDialog\");", js)
        self.assertIn("if (addDialog && addDialog.open) addDialog.close();", js)
        self.assertIn("button.dataset.stopUrl", js)
        self.assertIn("button.dataset.stopSource", js)
        stop_start = js.index('document.addEventListener("click", event => {\n  const button = event.target.closest && event.target.closest("[data-stop-monitor]")')
        stop_end = js.index('\n});', stop_start) + 4
        stop_handler = js[stop_start:stop_end]
        self.assertIn('const item = (state.items || []).find(row => row.url_id === button.dataset.stopMonitor);', stop_handler)
        self.assertNotIn("(state.inventory || []).find", stop_handler)

    def test_weekly_check_is_discovery_only_and_owner_approved(self):
        js = read("dashboard.js")
        lib = read("dashboard-lib.js")
        workflow = read(".github/workflows/register-monitor.yml")
        self.assertIn("function reviewOpenWeekly()", js)
        self.assertIn('"Discovery only: yes"', lib)
        self.assertLess(lib.index('"Document hosts: "'), lib.index('"Include selector: "'))
        self.assertIn("--scout-config config/scout.json", workflow)
        self.assertIn("git add config/sources.json config/scout.json", workflow)
        self.assertIn("gh workflow run scout.yml", workflow)
        self.assertIn("steps.register.outputs.discovery_only != 'true'", workflow)
        self.assertIn("No monitor was added", workflow)

    def test_metadata_cors_fallback_keeps_server_side_title_lookup_available(self):
        source = read("dashboard.js")
        start = source.index("async function suggestMonitorMetadata()")
        end = source.index("function openGitHubRequest(", start)
        metadata_flow = source[start:end]
        self.assertIn('if (!nameInput.value.trim())', metadata_flow)
        self.assertIn('nameInput.value = "";', metadata_flow)
        self.assertIn("registration will try the page title server-side", metadata_flow)
        self.assertNotIn('nameInput.value = (suggestion', metadata_flow)

    def test_dashboard_manual_monitor_controls_remain_owner_approved(self):
        html = read("index.html")
        js = read("dashboard.js")
        workflow = read(".github/workflows/register-monitor.yml")
        register = read("regmon/register_monitor.py")
        for token in ('id="newMonitorDepth"', 'id="autofillMonitorMetadata"', 'id="deleteMonitorDialog"', 'id="confirmDeleteMonitor"'):
            with self.subTest(token=token):
                self.assertIn(token, html)
        for token in ('"Crawl depth: "', 'async function suggestMonitorMetadata()', 'function makeGitHubDeleteIssueUrl(', 'data-stop-monitor=', 'function submitDeleteMonitor()'):
            with self.subTest(token=token):
                self.assertIn(token, js)
        self.assertIn("changesentinel:delete-monitor:v1", register)
        self.assertIn("repository_owner", workflow)
        self.assertIn("steps.register.outputs.deleted != 'true'", workflow)

class TestScoutView(unittest.TestCase):
    """Scout sits between Alerts and Ask Sentinel, set apart by a rule above and below."""

    def test_rail_order_and_separators(self):
        html = read("index.html")
        alerts = html.index('data-view="notifications"')
        scout = html.index('data-view="scout"')
        ask = html.index('data-view="askSentinel"')
        self.assertLess(alerts, scout)
        self.assertLess(scout, ask)
        self.assertIn('<li class="nav-scout">', html)
        self.assertIn(".nav-scout { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }", html)
        self.assertIn(".nav-ask { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }", html)
        self.assertIn('id="navScoutCount"', html)

    def test_phone_bar_fits_seven_tabs_without_rules(self):
        html = read("index.html")
        self.assertIn(".rail-nav { grid-template-columns: repeat(8, auto); justify-content: space-between; padding: 0 6px; }", html)
        # The phone shows six tabs (five and More) in equal columns, so every
        # label and its light sit centred in the same width.
        self.assertIn(".rail .rail-nav { grid-template-columns: repeat(6, minmax(0, 1fr)); }", html)
        self.assertIn(".nav-scout, .nav-calendar, .nav-ask { margin-top: 0; padding-top: 0; border-top: 0; }", html)

    def test_scout_is_a_split_view_with_review_filters_and_coverage(self):
        html = read("index.html")
        self.assertRegex(html, 'id="scoutView" class="view view-split"')
        for token in ('id="scoutItems"', 'id="scoutDetail"', 'id="scoutSearch"', "data-scout-coverage",
                      'data-scout-filter="REVIEW"', 'data-scout-filter="BACKLOG"', 'data-scout-filter="EXCLUDED"', 'data-scout-filter="DONE"'):
            with self.subTest(token=token):
                self.assertIn(token, html)

    def test_scout_data_is_optional_published_and_read_only(self):
        source = read("dashboard.js")
        for token in (
            'scoutLatest: new URL("./data/scout/latest.json", document.baseURI).href',
            'scoutReview: new URL("./data/scout/review.json", document.baseURI).href',
            'const OPTIONAL_ASSETS = new Set(["scoutLatest", "scoutReview", "scoutConfig",',
            "fetchDataAsset(key, !OPTIONAL_ASSETS.has(key))",
            'scout: "scout"',
            "function renderScoutCoverage(pane)",
            "L.scoutReviewIssue(verb, items, \"\")",
            "openAddMonitor();",
            "It does not mean every page on a regulator",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        # The dashboard never writes: decisions go through owner-approved GitHub requests.
        self.assertNotIn("api.github.com/repos/\" + REPOSITORY", source.split("Scout: new pages worth monitoring")[1].split("/* ================= Navigation")[0])
        workflow = read(".github/workflows/pages.yml")
        for token in ("cp data/scout/latest.json site/data/scout/latest.json", "cp data/scout/review.json site/data/scout/review.json",
                      '- "data/scout/review.json"'):
            with self.subTest(token=token):
                self.assertIn(token, workflow)

    def test_owners_can_add_sources_and_edit_metadata_through_a_reviewed_request(self):
        html = read("index.html")
        for token in ('id="scoutSourceDialog"', 'id="scoutSourceForm"', 'name="scoutChannelType" value="feed"', 'value="sitemap"', 'value="listing"',
                      'id="scoutRelevantKeywords"', 'id="scoutExcludeKeywords"', 'id="scoutPathHints"', 'id="scoutKnownGaps"', 'id="scoutActive"',
                      "html.cs-locked #scoutSourceDialog"):
            with self.subTest(token=token):
                self.assertIn(token, html)
        source = read("dashboard.js")
        for token in ("data-scout-add-source", "data-scout-add-channel", "data-scout-edit", "L.scoutSourceRequest({",
                      'scoutConfig: new URL("./config/scout.json", document.baseURI).href', '"scoutConfig", "calendar"'):
            with self.subTest(token=token):
                self.assertIn(token, source)
        self.assertIn("cp config/scout.json site/config/scout.json", read(".github/workflows/pages.yml"))

class TestReviewLayerContract(unittest.TestCase):
    """Reporting items, dates, review decisions, exports and integrity checks."""

    def test_new_files_are_optional_and_published(self):
        js = read("dashboard.js")
        for key, path in (("calendar", "data/calendar.json"), ("lineage", "config/lineage.json"), ("reviews", "data/reviews/ledger.json"), ("health", "data/health.json")):
            with self.subTest(key=key):
                self.assertIn(key + ': "' + path + '"', js)
                self.assertIn('new URL("./' + path + '", document.baseURI)', js)
                self.assertIn('case "' + key + '":', js)
        self.assertIn('const OPTIONAL_ASSETS = new Set(["scoutLatest", "scoutReview", "scoutConfig", "calendar", "lineage", "reviews", "regulators", "health", "digests", "digestConfig"]);', js)
        self.assertIn("cp config/regulators.json", read(".github/workflows/pages.yml"))
        self.assertRegex(js, r'const SMALL_ASSETS = \[[^\]]*"calendar", "lineage", "reviews", "regulators", "health", "digests", "digestConfig"\]')
        pages = read(".github/workflows/pages.yml")
        for path in ("config/lineage.json", "data/calendar.json", "data/calendar.ics", "data/reviews/ledger.json", "data/health.json"):
            with self.subTest(path=path):
                self.assertIn(path, pages)

    def test_review_dialog_offers_exactly_the_decisions_the_workflow_accepts(self):
        from regmon import reviews
        html = read("index.html")
        offered = set(re.findall(r'name="reviewDecision" value="([a-z_]+)"', html))
        self.assertEqual(offered, set(reviews.LABELS))
        lib = read("dashboard-lib.js")
        self.assertIn('const CHANGE_REVIEW_MARKER = "' + reviews.MARKER + '";', lib)
        for key, label in reviews.LABELS.items():
            self.assertIn(key + ': "' + label + '"', lib)
        self.assertIn("html.cs-locked #reviewDialog", html)
        for token in ('id="reviewDialog"', 'id="reviewForm"', 'id="reviewRationale"', 'id="reviewOwner"', 'id="reviewTicket"', 'id="reviewStatus"'):
            self.assertIn(token, html)

    def test_actions_are_delegated_and_the_dashboard_never_writes(self):
        js = read("dashboard.js")
        for attribute in ("data-review-change", "data-evidence-pack", "data-export-changes", "data-copy-calendar", "data-verify-fingerprints"):
            with self.subTest(attribute=attribute):
                self.assertIn("[" + attribute + "]", js)
        self.assertIn('REPO + "/issues/new?"', js)
        self.assertIn("L.changeReviewRequest(", js)
        self.assertNotIn("api.github.com/repos/\" + REPOSITORY.owner + \"/\" + REPOSITORY.repo + \"/issues\"", js)

    def test_change_detail_shows_review_dates_and_items(self):
        js = read("dashboard.js")
        self.assertIn("renderVerdict(entry) + reviewSheet(entry) + datesSheet(entry) + '<div id=\"change-items\"></div>' + evidenceSheet(entry, boxId)", js)
        self.assertIn("fillReportingItems(entry, \"change-items\", stillCurrent);", js)
        self.assertIn("L.lineageFor(", js)
        # A new decision or date redraws the open change.
        self.assertIn("reviewLog(entry.event_id),\n        L.datesForChange(state.calendar, entry.event_id)", js)
        self.assertIn('data-change-filter="UNDECIDED"', read("index.html"))

    def test_exports_are_spreadsheet_safe_and_integrity_uses_sha256(self):
        js = read("dashboard.js")
        self.assertIn("L.toCsv(rows)", js)
        self.assertIn('crypto.subtle.digest("SHA-256"', js)
        self.assertIn("fetchImmutable(file.path)", js)
        self.assertIn('format: "changesentinel-evidence-pack/1"', js)
        # Calendar days are built in the viewer's calendar, never parsed as UTC midnight.
        self.assertNotRegex(js, r"new Date\((?:entry|date)\.date\)")

    def test_overview_lists_dates_ahead_with_a_feed(self):
        html = read("index.html")
        self.assertIn('id="upcomingDates"', html)
        self.assertIn("data-copy-calendar", html)
        js = read("dashboard.js")
        self.assertIn('const CALENDAR_FEED = new URL("./data/calendar.ics", document.baseURI).href;', js)
        self.assertIn("renderUpcomingDates();", js)

class TestCadenceCalendarContract(unittest.TestCase):
    """Cadence is an additive regulatory calendar; Scout and existing views remain intact."""

    def test_calendar_is_under_scout_and_before_ask_sentinel(self):
        html = read("index.html")
        scout = html.index('data-view="scout"')
        cadence = html.index('data-view="calendar"')
        ask = html.index('data-view="askSentinel"')
        self.assertLess(scout, cadence)
        self.assertLess(cadence, ask)
        for token in (
            'id="calendarView" class="view cadence-view"',
            'id="cadenceMonthGrid"',
            'id="cadenceAgenda"',
            'id="cadenceSearch"',
            'id="cadenceTypeFilter"',
            'id="cadenceMonthView"',
            'id="cadenceUpcomingView"',
            'id="cadenceUpcomingList"',
            'data-calendar-mode="upcoming"',
            'data-calendar-export',
            'id="navCadenceCount"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, html)

    def test_calendar_navigation_fits_existing_mobile_rail(self):
        html = read("index.html")
        self.assertIn(".rail-nav { grid-template-columns: repeat(8, auto); justify-content: space-between; padding: 0 6px; }", html)
        self.assertIn(".nav-scout, .nav-calendar, .nav-ask { margin-top: 0; padding-top: 0; border-top: 0; }", html)
        self.assertIn("@media (max-width: 620px)", html)
        self.assertIn(".cadence-layout { grid-template-columns: minmax(0, 1fr); }", html)

    def test_upcoming_view_reuses_filters_and_groups_actionable_occurrences(self):
        html = read("index.html")
        source = read("dashboard.js")
        for token in (
            'id="cadenceMonthView"',
            'id="cadenceUpcomingView"',
            'id="cadenceUpcomingList"',
            'data-calendar-mode="month"',
            'data-calendar-mode="upcoming"',
            '.cadence-upcoming-item { grid-template-columns: 48px minmax(0, 1fr);',
        ):
            with self.subTest(token=token):
                self.assertIn(token, html)
        for token in (
            'cadencePanel: "month"',
            "function cadenceFilterEvents(allEvents)",
            "function cadenceUpcomingEvents(today, horizon)",
            "function renderCadenceUpcomingView(today)",
            "function cadenceUpcomingItemMarkup(event, today)",
            "const events = cadenceFilterEvents(allEvents);",
            "const events = cadenceFilterEvents(cadenceUpcomingEvents(today, horizon));",
            'event.title, event.date, event.occurrenceDate, event.category',
            'title: "Overdue"',
            'title: "Next 7 days"',
            'title: "Later · next 90 days"',
            "function jumpCadenceToDate(dateISO)",
            'const thisMonthEvents = allEvents.filter(event => event.date.slice(0, 7) === cadenceDateISO(first).slice(0, 7));',
            'cadenceOccurrenceDates(entry, cadenceAddDays(today, -800), cadenceAddDays(today, -1))',
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_calendar_editor_uses_password_auth_and_does_not_embed_service_credentials(self):
        source = read("dashboard.js")
        for token in (
            'const CADENCE_ENDPOINT = window.CHANGESENTINEL_CALENDAR_ENDPOINT || "";',
            "function cadenceEventsBetween(from, to)",
            "function renderCadenceView()",
            'cadenceSearch: "", cadenceFilter: "ALL"',
            'state.cadenceFilter === "EXPECTED"',
            'entry.source_url, entry.recurrence, event.entryId',
            'item.title, item.event_id, item.url, item.description',
            '.map(value => String(value).toLocaleLowerCase()).join(" ")',
            '$("cadenceTypeFilter").addEventListener("change"',
            "function exportCadenceCalendar()",
            "function saveCadenceEntry(event)",
            "function openCadenceEntry(id, preset)",
            "data-calendar-complete",
            "signInWithPassword",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)
        for forbidden in ("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_", "signInWithOtp", "shouldCreateUser"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)
        html = read("index.html")
        self.assertIn('id="cadenceSignInPassword"', html)
        self.assertNotIn("Email sign-in link", html)
        self.assertNotIn("signInWithOtp", html)

    def test_password_recovery_returns_to_deployed_dashboard_and_updates_password(self):
        html = read("index.html")
        source = read("dashboard.js")
        for token in (
            'id="cadenceForgotPassword"',
            'id="cadenceRecoveryForm"',
            'id="cadenceRecoveryPasswordConfirm"',
            'id="cadenceRecoverySave"',
        ):
            with self.subTest(token=token):
                self.assertIn(token, html)
        for token in (
            'const CADENCE_RECOVERY_REDIRECT_URL = "https://gauravdarwesh.github.io/ChangeSentinel/";',
            "resetPasswordForEmail(emailInput.value.trim().toLowerCase()",
            "redirectTo: CADENCE_RECOVERY_REDIRECT_URL",
            'event === "PASSWORD_RECOVERY"',
            "function isCadenceRecoveryRedirect()",
            'hashParams.get("type") === "recovery"',
            "client.auth.updateUser({ password: passwordInput.value })",
            "if (!options.preserveHash) writeHash();",
            "preserveHash: recoveryRedirect",
        ):
            with self.subTest(token=token):
                self.assertIn(token, source)

    def test_database_and_scheduler_keep_team_entries_private(self):
        migration = read("supabase/migrations/20261021180000_regulatory_calendar.sql")
        for token in (
            "alter table public.regulatory_calendar_members enable row level security",
            "alter table public.regulatory_calendar_entries enable row level security",
            "revoke all on public.regulatory_calendar_entries from public, anon, authenticated",
            "grant all on public.regulatory_calendar_entries to service_role",
            "unique (entry_id, occurrence_date, recipient_email)",
        ):
            with self.subTest(token=token):
                self.assertIn(token, migration)
        edge = read("supabase/functions/calendar-api/index.ts")
        for token in (
            "user?.is_anonymous === true",
            "regulatory_calendar_members",
            "function dueReminderJobs(",
            'req.headers.get("x-calendar-cron-token")',
            'api.resend.com/emails',
        ):
            with self.subTest(token=token):
                self.assertIn(token, edge)
        workflow = read(".github/workflows/regulatory-calendar-reminders.yml")
        self.assertIn('cron: "0 8 * * *"', workflow)
        self.assertIn("REGULATORY_CALENDAR_CRON_TOKEN", workflow)
        self.assertIn('{"action":"send-reminders"}', workflow)
        ci = read(".github/workflows/ci.yml")
        self.assertIn("npx deno check supabase/functions/calendar-api/index.ts", ci)
        self.assertIn("npx deno test --allow-env supabase/functions/calendar-api/index_test.ts", ci)


if __name__ == "__main__":
    unittest.main()


class TestCheckeredFrameGlints(unittest.TestCase):
    def test_edge_glints_are_theme_aware_visible_and_motion_safe(self):
        html = read("index.html")
        self.assertIn('<div class="frame-glints" aria-hidden="true"></div>', html)

        start = html.index("/* Soft, independent glints confined to the existing checkered outer edge. */")
        end = html.index("/* ---------- Shell ---------- */", start)
        css = html[start:end]
        self.assertRegex(css, r"\.frame-glints\s*\{[^}]*z-index:\s*2;")
        self.assertIn("var(--glint-color, var(--led-on))", css)
        self.assertIn("border-radius: 0;", css)
        self.assertIn("background: var(--glint-color, var(--led-on));", css)
        self.assertNotIn("radial-gradient(circle", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)

        script_start = html.index("// Randomly light only tiles along the existing outer frame.")
        script_end = html.index("</script>", script_start)
        script = html[script_start:script_end]
        self.assertIn("Math.random()", script)
        self.assertIn("layer.appendChild(glint)", script)
