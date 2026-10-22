import json
import tempfile
import unittest
from pathlib import Path

from regmon.register_monitor import (
    BULK_REQUEST_MARKER,
    MAX_BULK_REQUESTS,
    REQUEST_MARKER,
    canonicalize_url,
    register_request,
    request_from_issue,
    source_for_url,
)


def issue_event(
    url,
    name="Policy updates",
    login="GauravDarwesh",
    title="[ChangeSentinel] Add monitor request",
    include_selector="",
    ignore_selectors=(),
):
    body = [
        REQUEST_MARKER,
        "",
        "URL: " + url,
        "Name: " + name,
        "Include selector: " + include_selector,
        "Ignore selectors:",
    ]
    body.extend("- " + selector for selector in ignore_selectors)
    if not ignore_selectors:
        body.append("(none)")
    body.extend(["", "This request was created from the ChangeSentinel dashboard."])
    return {
        "issue": {
            "title": title,
            "body": "\n".join(body),
            "user": {"login": login},
        }
    }



def bulk_issue_event(rows, login="GauravDarwesh", title="[ChangeSentinel] Add monitor bulk request"):
    body = "\n".join([
        BULK_REQUEST_MARKER,
        "",
        "Please register these links.",
        "",
        "BULK_DATA_JSON:",
        json.dumps(rows, separators=(",", ":")),
        "",
        "This request was created from the ChangeSentinel dashboard bulk upload.",
    ])
    return {"issue": {"title": title, "body": body, "user": {"login": login}}}


class TestRegisterMonitor(unittest.TestCase):
    def test_canonicalize_public_url_and_remove_tracking(self):
        self.assertEqual(
            canonicalize_url("HTTPS://WWW.Example.com/policy/?version=2&utm_source=news&fbclid=x#section"),
            "https://www.example.com/policy?version=2",
        )

    def test_rejects_non_http_local_and_private_urls(self):
        for value in [
            "file:///etc/passwd",
            "https://localhost/admin",
            "http://127.0.0.1/status",
            "http://10.0.0.8/internal",
            "https://user:pass@example.com/path",
            "https://host-only/path",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonicalize_url(value)

    def test_source_is_bounded_to_one_exact_url(self):
        source = source_for_url("https://www.example.com/policy", "Policy updates")
        self.assertEqual(source["seed_urls"], ["https://www.example.com/policy"])
        self.assertEqual(source["allowed_urls"], ["https://www.example.com/policy"])
        self.assertEqual(source["allowed_domains"], ["www.example.com"])
        self.assertEqual(source["allowed_prefixes"], ["https://www.example.com/"])
        self.assertEqual(source["max_urls"], 0)
        self.assertTrue(source["active"])
        self.assertTrue(source["baseline_on_first_run"])
        self.assertEqual(source["include_selector"], "")
        self.assertEqual(source["ignore_selectors"], [])
        self.assertTrue(source["id"].startswith("manual-"))

    def test_custom_port_is_kept_in_url_scope_but_not_domain(self):
        url = "https://www.example.com:8443/policy"
        source = source_for_url(url, "Custom port policy")
        self.assertEqual(source["allowed_urls"], [url])
        self.assertEqual(source["allowed_domains"], ["www.example.com"])
        self.assertEqual(source["allowed_prefixes"], ["https://www.example.com:8443/"])

    def test_registers_include_and_ignore_css_selectors(self):
        url = "https://www.example.com/policy"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            event = issue_event(
                url,
                include_selector="main .policy-content",
                ignore_selectors=[".cookie-banner", ".last-visited"],
            )
            result = register_request(event, path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]
        self.assertTrue(result["created"])
        self.assertEqual(saved["include_selector"], "main .policy-content")
        self.assertEqual(saved["ignore_selectors"], [".cookie-banner", ".last-visited"])

    def test_rejects_invalid_css_selector(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid include CSS selector"):
                register_request(
                    issue_event("https://www.example.com/policy", include_selector="["),
                    path,
                    "GauravDarwesh/ChangeSentinel",
                )

    def test_only_repository_owner_can_register(self):
        event = issue_event("https://www.example.com/policy", login="someone-else")
        with self.assertRaisesRegex(ValueError, "Only the repository owner"):
            request_from_issue(event, "GauravDarwesh/ChangeSentinel")

    def test_rejects_issue_without_request_marker(self):
        event = issue_event("https://www.example.com/policy")
        event["issue"]["body"] = "URL: https://www.example.com/policy"
        with self.assertRaisesRegex(ValueError, "marker"):
            request_from_issue(event, "GauravDarwesh/ChangeSentinel")

    def test_registers_new_source_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "sources.json"
            config_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            event = issue_event("https://www.example.com/policy?utm_campaign=x", "Policy updates")
            first = register_request(event, config_path, "GauravDarwesh/ChangeSentinel")
            payload = json.loads(config_path.read_text(encoding="utf-8"))
            second = register_request(event, config_path, "GauravDarwesh/ChangeSentinel")
            self.assertTrue(first["created"])
            self.assertFalse(second["created"])
            self.assertEqual(first["source_id"], second["source_id"])
            self.assertEqual(len(payload["sources"]), 1)
            self.assertEqual(payload["sources"][0]["seed_urls"], ["https://www.example.com/policy"])

    def test_duplicate_url_with_different_selectors_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            source = source_for_url("https://example.test/page", include_selector="main")
            path.write_text(json.dumps({"sources": [source]}), encoding="utf-8")
            event = issue_event("https://example.test/page", include_selector="article")
            with self.assertRaisesRegex(ValueError, "different CSS selectors"):
                register_request(event, path, "GauravDarwesh/ChangeSentinel")

    def test_active_exact_duplicate_reuses_existing_source(self):
        url = "https://www.example.com/policy"
        existing = source_for_url(url, "Existing policy")
        config = {"version": 4, "defaults": {}, "sources": [existing]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            result = register_request(issue_event(url, "Another name"), path, "GauravDarwesh/ChangeSentinel")
            self.assertFalse(result["created"])
            self.assertEqual(result["source_id"], existing["id"])
            self.assertEqual(len(json.loads(path.read_text(encoding="utf-8"))["sources"]), 1)


    def test_bulk_registration_adds_multiple_sources_in_one_atomic_write(self):
        rows = [
            {"url": "https://www.example.com/one", "name": "One"},
            {"url": "https://www.example.com/two", "name": "Two"},
            {"url": "https://www.example.com/one?utm_source=repeat", "name": "Duplicate"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            result = register_request(bulk_issue_event(rows), path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"]
        self.assertTrue(result["bulk"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["created_count"], 2)
        self.assertEqual(result["existing_count"], 0)
        self.assertEqual(len(result["source_ids"]), 2)
        self.assertEqual(len(saved), 2)
        self.assertEqual({source["name"] for source in saved}, {"One", "Two"})

    def test_bulk_registration_reuses_existing_sources_and_is_idempotent(self):
        existing = source_for_url("https://www.example.com/one", "Existing one")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [existing]}), encoding="utf-8")
            event = bulk_issue_event([
                {"url": "https://www.example.com/one", "name": "Other name"},
                {"url": "https://www.example.com/two", "name": "Two"},
            ])
            first = register_request(event, path, "GauravDarwesh/ChangeSentinel")
            second = register_request(event, path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"]
        self.assertEqual(first["created_count"], 1)
        self.assertEqual(first["existing_count"], 1)
        self.assertEqual(first["source_ids"][0], existing["id"])
        self.assertEqual(second["created_count"], 0)
        self.assertEqual(second["count"], 2)
        self.assertEqual(len(saved), 2)

    def test_bulk_invalid_row_does_not_partially_write_config(self):
        original = {"version": 4, "defaults": {}, "sources": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            before = json.dumps(original)
            path.write_text(before, encoding="utf-8")
            event = bulk_issue_event([
                {"url": "https://www.example.com/valid"},
                {"url": "file:///etc/passwd"},
            ])
            with self.assertRaisesRegex(ValueError, "Bulk row 2"):
                register_request(event, path, "GauravDarwesh/ChangeSentinel")
            self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_bulk_selector_conflict_does_not_partially_write_config(self):
        original = {"version": 4, "defaults": {}, "sources": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            before = json.dumps(original)
            path.write_text(before, encoding="utf-8")
            event = bulk_issue_event([
                {"url": "https://www.example.com/one", "include_selector": "main"},
                {"url": "https://www.example.com/one", "include_selector": "article"},
            ])
            with self.assertRaisesRegex(ValueError, "Bulk row 2"):
                register_request(event, path, "GauravDarwesh/ChangeSentinel")
            self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_bulk_request_is_owner_only_and_limited(self):
        with self.assertRaisesRegex(ValueError, "Only the repository owner"):
            register_request(bulk_issue_event([{"url": "https://www.example.com/one"}], login="someone-else"),
                             Path("unused.json"), "GauravDarwesh/ChangeSentinel")
        event = bulk_issue_event([{"url": f"https://www.example.com/{i}"} for i in range(MAX_BULK_REQUESTS + 1)])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"sources": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "at most 25 links"):
                register_request(event, path, "GauravDarwesh/ChangeSentinel")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["sources"], [])


    def test_crawl_depth_scope_is_configured_without_changing_default(self):
        url = "https://www.example.com/policy"
        exact = source_for_url(url, "Policy page")
        crawl = source_for_url(url, "Policy pages", crawl_depth=2)
        self.assertEqual(exact["crawl_depth"], 0)
        self.assertEqual(exact["allowed_urls"], [url])
        self.assertEqual(crawl["crawl_depth"], 2)
        self.assertEqual(crawl["allowed_urls"], [])
        self.assertEqual(crawl["allowed_domains"], ["www.example.com"])
        self.assertEqual(crawl["discovery_max_pages_per_slice"], 200)

    def test_metadata_parser_prefers_open_graph_title_and_bounds_text(self):
        from regmon.register_monitor import _metadata_from_html
        result = _metadata_from_html(
            '<html><head><title>Document title</title>'
            '<meta property="og:title" content="  Consultation   Update  ">'
            '<meta name="description" content="  A useful description  "></head></html>'
        )
        self.assertEqual(result["title"], "Consultation Update")
        self.assertEqual(result["description"], "A useful description")

    def test_metadata_parser_falls_back_to_document_title(self):
        from regmon.register_monitor import _metadata_from_html
        self.assertEqual(_metadata_from_html("<title>FR 1867 Changes</title>")["title"], "FR 1867 Changes")

    def test_delete_child_page_excludes_future_scans_and_keeps_source_active(self):
        import re
        from regmon.register_monitor import DELETE_REQUEST_MARKER, delete_monitor_request
        root = "https://www.example.com/policy"
        child = "https://www.example.com/policy/annex"
        source = source_for_url(root, "Policy crawl", crawl_depth=2)
        config = {"version": 4, "defaults": {}, "sources": [source]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            body = "\n".join([
                DELETE_REQUEST_MARKER, "", "Source ID: " + source["id"],
                "URL: " + child, "Name: Annex",
            ])
            event = {"issue": {
                "title": "[ChangeSentinel] Delete monitor request",
                "body": body, "user": {"login": "GauravDarwesh"},
            }}
            result = delete_monitor_request(event, path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]
        self.assertTrue(result["deleted"])
        self.assertFalse(result["deactivated"])
        self.assertTrue(saved["active"])
        self.assertIn(child, saved["excluded_urls"])

    def test_delete_root_deactivates_source_without_erasing_seed_or_history(self):
        from regmon.register_monitor import DELETE_REQUEST_MARKER, delete_monitor_request
        root = "https://www.example.com/policy"
        source = source_for_url(root, "Policy crawl", crawl_depth=2)
        config = {"version": 4, "defaults": {}, "sources": [source]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            body = "\n".join([
                DELETE_REQUEST_MARKER, "", "Source ID: " + source["id"],
                "URL: " + root, "Name: Policy crawl",
            ])
            event = {"issue": {
                "title": "[ChangeSentinel] Delete monitor request",
                "body": body, "user": {"login": "GauravDarwesh"},
            }}
            result = delete_monitor_request(event, path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]
        self.assertTrue(result["deactivated"])
        self.assertFalse(saved["active"])
        self.assertEqual(saved["seed_urls"], [root])


    def test_manual_registration_respects_all_supported_crawl_depths(self):
        url = "https://www.example.com/policy"
        for depth in range(4):
            with self.subTest(depth=depth), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "sources.json"
                path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
                event = issue_event(url, name="Policy")
                event["issue"]["body"] = event["issue"]["body"].replace(
                    "\n\nThis request was created from the ChangeSentinel dashboard.",
                    f"\nCrawl depth: {depth}\n\nThis request was created from the ChangeSentinel dashboard.",
                )
                result = register_request(event, path, "GauravDarwesh/ChangeSentinel")
                saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]

                self.assertTrue(result["created"])
                self.assertEqual(result["crawl_depth"], depth)
                self.assertEqual(saved["crawl_depth"], depth)
                self.assertEqual(saved["allowed_urls"], [url] if depth == 0 else [])
                self.assertEqual(saved["discovery_max_pages_per_slice"], 1 if depth == 0 else 200)

    def test_explicit_depth_promotes_existing_manual_monitor_and_enables_scout(self):
        url = "https://www.example.com/user-guides"
        excluded = "https://www.example.com/user-guides/retired"
        existing_source = source_for_url(url, "Previous title")
        existing_source["excluded_urls"] = [excluded]
        source_id = existing_source["id"]
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "sources.json"
            scout_path = Path(tmp) / "scout.json"
            source_path.write_text(
                json.dumps({"version": 4, "defaults": {}, "sources": [existing_source]}),
                encoding="utf-8",
            )
            scout_path.write_text(
                (Path(__file__).resolve().parents[1] / "config" / "scout.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            event = issue_event(url + "/", name="FRB User Guides")
            footer = "\n\nThis request was created from the ChangeSentinel dashboard."
            event["issue"]["body"] = event["issue"]["body"].replace(
                footer, "\nCrawl depth: 1\nScout discovery: yes" + footer
            )

            result = register_request(
                event, source_path, "GauravDarwesh/ChangeSentinel", scout_path
            )
            saved_config = json.loads(source_path.read_text(encoding="utf-8"))
            saved_source = saved_config["sources"][0]
            saved_scout = json.loads(scout_path.read_text(encoding="utf-8"))
            profile = next(
                row for row in saved_scout["regulators"]
                if "www.example.com" in row.get("hosts", [])
            )
            channel = next(
                row for row in profile["channels"]
                if row["url"].rstrip("/") == url
            )

        self.assertFalse(result["created"])
        self.assertTrue(result["crawl_depth_updated"])
        self.assertEqual(result["source_id"], source_id)
        self.assertEqual(len(saved_config["sources"]), 1)
        self.assertEqual(saved_source["id"], source_id)
        self.assertEqual(saved_source["name"], "FRB User Guides")
        self.assertEqual(saved_source["crawl_depth"], 1)
        self.assertEqual(saved_source["allowed_urls"], [])
        self.assertEqual(saved_source["discovery_max_pages_per_slice"], 200)
        self.assertEqual(saved_source["excluded_urls"], [excluded])
        self.assertTrue(result["scout_enabled"])
        self.assertEqual(channel["type"], "listing")
        self.assertEqual(channel["crawl_depth"], 1)

    def test_manual_registration_rejects_invalid_or_duplicate_crawl_depth(self):
        for fields, message in [
            (["Crawl depth: 4"], "Crawl depth must be 0, 1, 2, or 3"),
            (["Crawl depth: 1", "Crawl depth: 2"], "at most one Crawl depth field"),
        ]:
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "sources.json"
                original = {"version": 4, "defaults": {}, "sources": []}
                before = json.dumps(original)
                path.write_text(before, encoding="utf-8")
                event = issue_event("https://www.example.com/policy", name="Policy")
                footer = "\n\nThis request was created from the ChangeSentinel dashboard."
                event["issue"]["body"] = event["issue"]["body"].replace(
                    footer, "\n" + "\n".join(fields) + footer
                )
                with self.assertRaisesRegex(ValueError, message):
                    register_request(event, path, "GauravDarwesh/ChangeSentinel")
                self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_missing_display_name_uses_backend_metadata_title(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            event = issue_event("https://www.example.com/policy", name="")
            with patch(
                "regmon.register_monitor._fetch_page_metadata",
                return_value={"title": "Metadata-derived policy title", "description": "Description"},
            ) as fetch_metadata:
                result = register_request(event, path, "GauravDarwesh/ChangeSentinel")
            saved = json.loads(path.read_text(encoding="utf-8"))["sources"][0]

        fetch_metadata.assert_called_once_with("https://www.example.com/policy")
        self.assertTrue(result["created"])
        self.assertEqual(saved["name"], "Metadata-derived policy title")



    def test_add_link_can_opt_into_weekly_scout_with_the_same_depth(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "sources.json"
            scout_path = Path(tmp) / "scout.json"
            source_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            baseline_scout = Path(__file__).resolve().parents[1] / "config" / "scout.json"
            original_scout_text = baseline_scout.read_text(encoding="utf-8")
            scout_path.write_text(original_scout_text, encoding="utf-8")

            event = issue_event("https://www.example.com/user-guides", name="User guides")
            footer = "\n\nThis request was created from the ChangeSentinel dashboard."
            event["issue"]["body"] = event["issue"]["body"].replace(
                footer, "\nCrawl depth: 2\nScout discovery: yes" + footer
            )
            result = register_request(
                event, source_path, "GauravDarwesh/ChangeSentinel", scout_path
            )
            sources = json.loads(source_path.read_text(encoding="utf-8"))["sources"]
            scout = json.loads(scout_path.read_text(encoding="utf-8"))
            profile = next(item for item in scout["regulators"] if "www.example.com" in item.get("hosts", []))
            channel = next(item for item in profile["channels"] if item["url"] == "https://www.example.com/user-guides")

        self.assertTrue(result["created"])
        self.assertTrue(result["scout_enabled"])
        self.assertTrue(result["scout_changed"])
        self.assertEqual(result["crawl_depth"], 2)
        self.assertEqual(sources[0]["crawl_depth"], 2)
        self.assertEqual(channel["type"], "listing")
        self.assertEqual(channel["crawl_depth"], 2)
        self.assertEqual(channel["link_prefixes"], ["https://www.example.com/"])
        self.assertEqual(profile["region"], "OTHER")

    def test_weekly_scout_registration_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "sources.json"
            scout_path = Path(tmp) / "scout.json"
            source_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            scout_path.write_text(
                (Path(__file__).resolve().parents[1] / "config" / "scout.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            event = issue_event("https://www.example.com/user-guides", name="User guides")
            footer = "\n\nThis request was created from the ChangeSentinel dashboard."
            event["issue"]["body"] = event["issue"]["body"].replace(
                footer, "\nCrawl depth: 1\nScout discovery: yes" + footer
            )
            first = register_request(event, source_path, "GauravDarwesh/ChangeSentinel", scout_path)
            second = register_request(event, source_path, "GauravDarwesh/ChangeSentinel", scout_path)

        self.assertTrue(first["scout_changed"])
        self.assertFalse(second["created"])
        self.assertTrue(second["scout_configured"])
        self.assertFalse(second["scout_changed"])
        self.assertEqual(first["scout_channel_id"], second["scout_channel_id"])

    def test_scout_cannot_be_enabled_for_depth_zero_and_files_remain_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "sources.json"
            scout_path = Path(tmp) / "scout.json"
            source_before = json.dumps({"version": 4, "defaults": {}, "sources": []})
            scout_before = (Path(__file__).resolve().parents[1] / "config" / "scout.json").read_text(encoding="utf-8")
            source_path.write_text(source_before, encoding="utf-8")
            scout_path.write_text(scout_before, encoding="utf-8")
            event = issue_event("https://www.example.com/user-guides", name="User guides")
            footer = "\n\nThis request was created from the ChangeSentinel dashboard."
            event["issue"]["body"] = event["issue"]["body"].replace(
                footer, "\nCrawl depth: 0\nScout discovery: yes" + footer
            )
            with self.assertRaisesRegex(ValueError, "requires crawl depth 1, 2, or 3"):
                register_request(event, source_path, "GauravDarwesh/ChangeSentinel", scout_path)
            self.assertEqual(source_path.read_text(encoding="utf-8"), source_before)
            self.assertEqual(scout_path.read_text(encoding="utf-8"), scout_before)


if __name__ == "__main__":
    unittest.main()
