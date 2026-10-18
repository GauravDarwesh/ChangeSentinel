import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.ai import AI_REQUIRED_KEYS, parse_json, validate_analysis
from regmon.change import build_event_id, classify_change, make_diff, make_id, write_evidence
from regmon.content import extract_content, normalize_html
from regmon.config import SourceConfig
from regmon.discovery import _fetch_links, canonical, extract_html_links, http_discover, in_scope, parse_discovered_urls
from regmon.fetch import fetch
from regmon.monitor import load_previous
from regmon.notify import build_notifications
from regmon.relevance import triage

SOURCE = SourceConfig(
    id="eba-test",
    name="EBA Test",
    regulator="European Banking Authority",
    seed_urls=("https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/start",),
    allowed_prefixes=("https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/",),
    allowed_domains=("www.eba.europa.eu",),
)

class TestContent(unittest.TestCase):
    def test_dynamic_markup_is_ignored(self):
        a="<body><nav>A</nav><main><h1>Guideline</h1><p>Version one.</p></main><footer>A</footer></body>"
        b="<body><nav>B</nav><main><h1>Guideline</h1><p>Version one.</p></main><footer>B</footer></body>"
        self.assertEqual(normalize_html(a), normalize_html(b))

    def test_substantive_change_survives(self):
        self.assertNotEqual(normalize_html("<main>Version one</main>"), normalize_html("<main>Version two</main>"))

    def test_json_is_stably_formatted_and_object_key_order_is_ignored(self):
        first = extract_content(
            "https://example.test/api", "application/json",
            b'{"z": 3, "a": {"y": 2, "x": 1}}',
        )
        reordered = extract_content(
            "https://example.test/api", "application/json",
            b'{ "a": {"x": 1, "y": 2}, "z": 3 }',
        )
        changed = extract_content(
            "https://example.test/api", "application/json",
            b'{"a": {"x": 9, "y": 2}, "z": 3}',
        )
        self.assertEqual(first[1:], ("json", None))
        self.assertEqual(reordered[1:], ("json", None))
        self.assertEqual(first[0], reordered[0])
        self.assertNotEqual(first[0], changed[0])
        self.assertIn('"x": 1', first[0])

    def test_json_parse_failure_is_explicit(self):
        text, kind, error = extract_content(
            "https://example.test/api", "application/json", b'{"missing": ',
        )
        self.assertIsNone(text)
        self.assertEqual(kind, "json")
        self.assertTrue(error)

    def test_xml_is_stably_formatted_across_attribute_and_indentation_changes(self):
        first = extract_content(
            "https://example.test/policy.xml", "application/xml",
            b'<policy z="2" a="1">\n  <title>Rule 1</title>\n  <status>active</status>\n</policy>',
        )
        reordered = extract_content(
            "https://example.test/policy.xml", "application/xml",
            b'<policy a="1" z="2"><title>Rule 1</title><status>active</status></policy>',
        )
        changed = extract_content(
            "https://example.test/policy.xml", "application/xml",
            b'<policy a="1" z="2"><title>Rule 2</title><status>active</status></policy>',
        )
        self.assertEqual(first[1:], ("xml", None))
        self.assertEqual(first[0], reordered[0])
        self.assertNotEqual(first[0], changed[0])
        self.assertIn("<title>Rule 1</title>", first[0])

    def test_xml_parse_failure_is_explicit(self):
        text, kind, error = extract_content(
            "https://example.test/policy.xml", "application/xml", b"<policy>",
        )
        self.assertIsNone(text)
        self.assertEqual(kind, "xml")
        self.assertTrue(error)

    def test_html_include_selector_and_ignore_selectors_scope_comparison(self):
        html = """<html><body>
        <header><p>Site navigation noise</p></header>
        <main>
          <section class="policy-content">
            <h1>Capital requirements draft</h1>
            <p>Minimum ratio rises to 12%.</p>
            <p class="last-visited">Visited today</p>
            <div class="cookie-banner">Accept all cookies</div>
          </section>
          <section class="related"><p>Unrelated article changes often</p></section>
        </main>
        <footer>Footer noise</footer>
        </body></html>"""
        result = normalize_html(
            html,
            include_selector="main .policy-content",
            ignore_selectors=(".last-visited", ".cookie-banner"),
        )
        self.assertEqual(result, "Capital requirements draft\nMinimum ratio rises to 12%")
        self.assertNotIn("navigation", result)
        self.assertNotIn("Unrelated article", result)

    def test_html_include_selector_mismatch_is_an_extraction_error(self):
        result, kind, error = extract_content(
            "https://example.test/policy",
            "text/html",
            b"<main><p>Regulatory content</p></main>",
            include_selector="main .does-not-exist",
        )
        self.assertIsNone(result)
        self.assertEqual(kind, "html")
        self.assertIn("include selector matched no elements", error)

    def test_invalid_html_selector_is_an_extraction_error(self):
        result, kind, error = extract_content(
            "https://example.test/policy",
            "text/html",
            b"<main><p>Regulatory content</p></main>",
            include_selector="[",
        )
        self.assertIsNone(result)
        self.assertEqual(kind, "html")
        self.assertIn("Invalid", error)

    def test_pdf_failure_is_explicit(self):
        text, kind, error = extract_content("https://example.test/a.pdf","application/pdf",b"not-a-pdf")
        self.assertIsNone(text)
        self.assertEqual(kind,"pdf")
        self.assertTrue(error)

class TestDiscovery(unittest.TestCase):
    def test_canonical_removes_tracking_but_preserves_semantic_query(self):
        self.assertEqual(canonical("HTTPS://WWW.EBA.EUROPA.EU/a/?phase=consolidated&utm_source=x&version=2015#x"),"https://www.eba.europa.eu/a?phase=consolidated&version=2015")

    def test_legacy_query_order_resolves_same_identity(self):
        from regmon.engine import resolve_previous
        previous={"legacy-id":{"canonical_url":"https://www.eba.europa.eu/a?version=2015&phase=consultation"}}
        uid,record=resolve_previous("https://www.eba.europa.eu/a?phase=consultation&version=2015",previous)
        self.assertEqual(uid,"legacy-id")
        self.assertIsNotNone(record)

    def test_scope_filters_external_and_duplicates(self):
        output="\n".join([
            "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a?x=1&utm_source=x",
            "https://example.test/outside",
            "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a?x=1",
        ])
        self.assertEqual(len(parse_discovered_urls(output,SOURCE)),1)
        self.assertTrue(in_scope("https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a",SOURCE))


    def test_exact_url_allowlist_rejects_nearby_pages_and_query_variants(self):
        allowed = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/operational-risk/regulatory-technical-standards-operational-risk-management-framework"
        source = SourceConfig(
            id="eba-pilot-test",
            name="EBA Pilot Test",
            regulator="European Banking Authority",
            seed_urls=(allowed,),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            allowed_urls=(allowed,),
        )
        self.assertTrue(in_scope(allowed, source))
        self.assertFalse(in_scope(allowed + "?phase=consultation", source))
        self.assertFalse(in_scope(allowed + "-nearby-page", source))
        self.assertFalse(in_scope("https://www.eba.europa.eu/homepage", source))

    def test_html_links_handle_absolute_relative_and_excluded_urls(self):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            excluded_prefixes=("https://www.eba.europa.eu/search/",),
        )
        html = """<a href="/a">relative</a>
        <a href="https://www.eba.europa.eu/b?phase=consultation">absolute</a>
        <a href="https://www.eba.europa.eu/search?query=rules">excluded</a>
        <a href="https://example.test/outside">external</a>
        <a href="mailto:test@example.test">mail</a>"""
        links = extract_html_links("https://www.eba.europa.eu/homepage", html, source)
        self.assertEqual(
            links,
            [
                "https://www.eba.europa.eu/a",
                "https://www.eba.europa.eu/b?phase=consultation",
            ],
        )

    @patch("regmon.discovery.requests.get")
    def test_json_endpoint_is_not_parsed_as_html_links(self, mock_get):
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "application/json"},
            text='{"next": "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/other"}',
            url="https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/api",
        )
        url, links, failure = _fetch_links(
            "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/api",
            SOURCE,
            10,
        )
        self.assertEqual(url, mock_get.return_value.url)
        self.assertEqual(links, [])
        self.assertIsNone(failure)

    @patch("regmon.discovery.requests.get")
    def test_http_discovery_retries_transient_errors(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_http_attempts=2,
        )
        success = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<a href='/a'>A</a>",
            url="https://www.eba.europa.eu/homepage",
        )
        success_child = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<p>Done</p>",
            url="https://www.eba.europa.eu/a",
        )
        mock_get.side_effect = [
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            success,
            success_child,
        ]
        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads((Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8"))
        self.assertIn("https://www.eba.europa.eu/homepage", urls)
        self.assertEqual(mock_get.call_count, 3)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(metadata["failed_pages"], 0)

    @patch("regmon.discovery.requests.get")
    def test_http_discovery_pauses_and_resumes(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=1,
        )
        first = Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                     text="<a href='/a'>A</a>", url="https://www.eba.europa.eu/homepage")
        child = Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                     text="<a href='/b'>B</a>", url="https://www.eba.europa.eu/a")
        done = Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                    text="<p>Done</p>", url="https://www.eba.europa.eu/b")
        mock_get.side_effect = [first, child, done]
        with tempfile.TemporaryDirectory() as tmp:
            with patch("regmon.discovery.time.monotonic", side_effect=[0, 0, 9999]):
                paused_urls = http_discover(source, Path(tmp))
            metadata = json.loads((Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["state"], "PAUSED")
            self.assertEqual(paused_urls, ["https://www.eba.europa.eu/homepage", "https://www.eba.europa.eu/a"])
            self.assertTrue((Path(tmp) / "discovery" / "eba-test-checkpoint.json").exists())

            completed_urls = http_discover(source, Path(tmp))
            metadata = json.loads((Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8"))
            checkpoint_path = Path(tmp) / "discovery" / "eba-test-checkpoint.json"

        self.assertEqual(completed_urls, [
            "https://www.eba.europa.eu/homepage",
            "https://www.eba.europa.eu/a",
            "https://www.eba.europa.eu/b",
        ])
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertFalse(checkpoint_path.exists())


    @patch("regmon.discovery.requests.get")
    def test_compact_checkpoint_uses_sharded_inventory(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=1,
        )
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<a href='/a'>A</a>",
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            with patch("regmon.discovery.time.monotonic", side_effect=[0, 0, 9999]):
                http_discover(source, Path(tmp))
            checkpoint = json.loads(
                (Path(tmp) / "discovery" / "eba-test-checkpoint.json").read_text(encoding="utf-8")
            )
            inventory_files = sorted((Path(tmp) / "discovery").glob("eba-test-inventory-*.txt"))
            self.assertEqual(checkpoint["schema_version"], 2)
            self.assertNotIn("discovered", checkpoint)
            self.assertNotIn("processed", checkpoint)
            self.assertTrue(inventory_files)
            self.assertIn("https://www.eba.europa.eu/homepage", inventory_files[0].read_text(encoding="utf-8"))

    @patch("regmon.discovery.requests.get")
    def test_legacy_checkpoint_migrates_to_full_revalidation(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=0,
            discovery_max_pages_per_slice=1,
        )
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<p>Verified</p>",
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir(parents=True)
            (discovery_dir / "eba-test-checkpoint.json").write_text(
                json.dumps({
                    "schema_version": 1,
                    "source_id": "eba-test",
                    "state": "PAUSED",
                    "started_at": "2026-09-24T00:00:00Z",
                    "updated_at": "2026-09-24T01:00:00Z",
                    "discovered": [
                        "https://www.eba.europa.eu/homepage",
                        "https://www.eba.europa.eu/a",
                        "https://www.eba.europa.eu/documents/a.pdf",
                    ],
                    "pending": ["https://www.eba.europa.eu/a"],
                    "processed": ["https://www.eba.europa.eu/homepage"],
                    "errors": ["https://www.eba.europa.eu/a\\tHTTP 500"],
                    "failed_pages": 1,
                    "successful_pages": 0,
                }),
                encoding="utf-8",
            )
            urls = http_discover(source, Path(tmp))
            metadata = json.loads((discovery_dir / "eba-test.json").read_text(encoding="utf-8"))
            checkpoint = json.loads((discovery_dir / "eba-test-checkpoint.json").read_text(encoding="utf-8"))
            inventory = "\n".join(
                p.read_text(encoding="utf-8") for p in sorted(discovery_dir.glob("eba-test-inventory-*.txt"))
            )
        self.assertEqual(urls, [
            "https://www.eba.europa.eu/homepage",
            "https://www.eba.europa.eu/a",
            "https://www.eba.europa.eu/documents/a.pdf",
        ])
        self.assertEqual(metadata["state"], "PAUSED")
        self.assertEqual(metadata["html_processed"], 1)
        self.assertEqual(metadata["failed_pages"], 0)
        self.assertEqual(checkpoint["schema_version"], 2)
        self.assertEqual(checkpoint["processed_count"], 1)
        self.assertEqual(checkpoint["pending"], ["https://www.eba.europa.eu/a"])
        self.assertIn("https://www.eba.europa.eu/documents/a.pdf", inventory)

    @patch("regmon.discovery.time.sleep", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_retry_work_is_bounded_by_page_budget(self, mock_get, _sleep):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_http_attempts=1,
            discovery_slice_seconds=0,
            discovery_max_pages_per_slice=1,
        )
        mock_get.side_effect = [
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                 text="<p>Recovered</p>", url="https://www.eba.europa.eu/homepage"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            first_urls = http_discover(source, tmp_path)
            first_meta = json.loads((tmp_path / "discovery" / "eba-test.json").read_text(encoding="utf-8"))
            first_checkpoint = json.loads((tmp_path / "discovery" / "eba-test-checkpoint.json").read_text(encoding="utf-8"))
            second_urls = http_discover(source, tmp_path)
            second_meta = json.loads((tmp_path / "discovery" / "eba-test.json").read_text(encoding="utf-8"))
        self.assertEqual(first_urls, ["https://www.eba.europa.eu/homepage"])
        self.assertEqual(first_meta["state"], "PAUSED")
        self.assertEqual(first_checkpoint["retry_pending"], ["https://www.eba.europa.eu/homepage"])
        self.assertEqual(second_urls, ["https://www.eba.europa.eu/homepage"])
        self.assertEqual(second_meta["state"], "COMPLETE")

    @patch("regmon.discovery.requests.get")
    def test_url_cap_is_always_degraded_and_never_complete(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            max_urls=1,
            discovery_http_workers=1,
            discovery_slice_seconds=0,
        )
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text='<a href="/a">A</a>',
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8")
            )
        self.assertEqual(urls, ["https://www.eba.europa.eu/homepage"])
        self.assertTrue(metadata["capped"])
        self.assertEqual(metadata["state"], "DEGRADED")

    @patch("regmon.discovery.requests.get")
    def test_paused_inventory_recovers_when_checkpoint_is_empty(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=1,
        )
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<p>Recovered</p>",
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir(parents=True)
            (discovery_dir / "eba-test-inventory-0000.txt").write_text(
                "https://www.eba.europa.eu/homepage\nhttps://www.eba.europa.eu/a\n",
                encoding="utf-8",
            )
            (discovery_dir / "eba-test-checkpoint.json").write_text("", encoding="utf-8")
            (discovery_dir / "eba-test.json").write_text(
                json.dumps({
                    "source_id": "eba-test",
                    "state": "PAUSED",
                    "discovered": 2,
                    "html_processed": 1,
                    "failed_pages": 0,
                    "successful_pages": 1,
                }),
                encoding="utf-8",
            )
            urls = http_discover(source, Path(tmp))
        self.assertIn("https://www.eba.europa.eu/homepage", urls)
        self.assertIn("https://www.eba.europa.eu/a", urls)
        self.assertNotEqual(mock_get.call_count, 0)

    @patch("regmon.discovery.requests.get")
    def test_degraded_inventory_recovers_when_checkpoint_is_missing(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=0,
        )
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<p>Recovered</p>",
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir(parents=True)
            inventory_file = discovery_dir / "eba-test-inventory-0000.txt"
            inventory_file.write_text(
                "https://www.eba.europa.eu/homepage\nhttps://www.eba.europa.eu/a\n",
                encoding="utf-8",
            )
            (discovery_dir / "eba-test.json").write_text(
                json.dumps({
                    "source_id": "eba-test",
                    "state": "DEGRADED",
                    "discovered": 2,
                    "html_processed": 1,
                    "failed_pages": 1,
                    "successful_pages": 0,
                }),
                encoding="utf-8",
            )

            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (discovery_dir / "eba-test.json").read_text(encoding="utf-8")
            )

        self.assertIn("https://www.eba.europa.eu/homepage", urls)
        self.assertIn("https://www.eba.europa.eu/a", urls)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(mock_get.call_count, 2)

    @patch("regmon.discovery.requests.get")
    def test_scope_change_invalidates_checkpoint(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=0,
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir(parents=True)
            (discovery_dir / "eba-test-inventory-0000.txt").write_text(
                "https://www.eba.europa.eu/old\n", encoding="utf-8"
            )
            (discovery_dir / "eba-test-checkpoint.json").write_text(
                json.dumps({
                    "schema_version": 2,
                    "source_id": "eba-test",
                    "state": "PAUSED",
                    "config_fingerprint": "stale",
                    "pending": ["https://www.eba.europa.eu/old"],
                    "discovered_count": 1,
                    "processed_count": 0,
                    "failed_pages": 0,
                    "successful_pages": 0,
                }),
                encoding="utf-8",
            )
            mock_get.return_value = Mock(
                status_code=200,
                headers={"content-type": "text/html; charset=UTF-8"},
                text="<p>Done</p>",
                url="https://www.eba.europa.eu/homepage",
            )
            urls = http_discover(source, Path(tmp))
            self.assertEqual(urls, ["https://www.eba.europa.eu/homepage"])
            self.assertTrue((discovery_dir / "eba-test.json").exists())
            self.assertFalse((discovery_dir / "eba-test-checkpoint.json").exists())
            self.assertNotIn("old", (discovery_dir / "eba-test-inventory-0000.txt").read_text(encoding="utf-8"))

    @patch("regmon.discovery.time.sleep", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_retryable_discovery_failure_is_retried_before_complete(self, mock_get, _sleep):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_http_attempts=2,
            discovery_slice_seconds=0,
        )
        mock_get.side_effect = [
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                 text="<p>Recovered</p>", url="https://www.eba.europa.eu/homepage"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8")
            )
            ledger = [
                json.loads(line)
                for line in (Path(tmp) / "discovery" / "eba-test-failures.jsonl")
                .read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        self.assertEqual(urls, ["https://www.eba.europa.eu/homepage"])
        self.assertEqual(mock_get.call_count, 3)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(metadata["unresolved_failures"], 0)
        self.assertEqual(ledger[-1]["retry_classification"], "retry_resolved")
        self.assertTrue(ledger[-1]["resolved"])

    @patch("regmon.discovery.time.sleep", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_retry_success_discovers_links_from_recovered_page(self, mock_get, _sleep):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_http_attempts=2,
            discovery_slice_seconds=0,
        )
        mock_get.side_effect = [
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            Mock(status_code=503, headers={}, text="", url="https://www.eba.europa.eu/homepage"),
            Mock(
                status_code=200,
                headers={"content-type": "text/html; charset=UTF-8"},
                text="<a href='/recovered-child'>Child</a>",
                url="https://www.eba.europa.eu/homepage",
            ),
            Mock(
                status_code=200,
                headers={"content-type": "text/html; charset=UTF-8"},
                text="<p>Recovered child</p>",
                url="https://www.eba.europa.eu/recovered-child",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8")
            )
        self.assertEqual(
            urls,
            [
                "https://www.eba.europa.eu/homepage",
                "https://www.eba.europa.eu/recovered-child",
            ],
        )
        self.assertEqual(mock_get.call_count, 4)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(metadata["unresolved_failures"], 0)

    @patch("regmon.discovery.time.sleep", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_failure_ledger_records_structured_retry_failure(self, mock_get, _sleep):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_http_attempts=2,
            discovery_slice_seconds=0,
        )
        mock_get.return_value = Mock(
            status_code=503,
            headers={},
            text="",
            url="https://www.eba.europa.eu/homepage",
        )
        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8")
            )
            ledger = (Path(tmp) / "discovery" / "eba-test-failures.jsonl").read_text(encoding="utf-8").splitlines()
        record = json.loads(ledger[0])
        self.assertEqual(urls, [])
        self.assertEqual(metadata["state"], "DEGRADED")
        self.assertEqual(record["status_code"], 503)
        self.assertEqual(record["attempts"], 2)
        self.assertEqual(record["retry_classification"], "retryable_exhausted")
    @patch("regmon.discovery.requests.get")
    def test_http_discovery_recurses_and_keeps_document_links(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            excluded_prefixes=("https://www.eba.europa.eu/search/",),
            discovery_http_workers=2,
        )

        pages = {
            "https://www.eba.europa.eu/homepage": """
                <a href="/a">A</a>
                <a href="https://www.eba.europa.eu/b">B</a>
                <a href="/documents/example.pdf">PDF</a>
                <a href="/search?query=rules">Search</a>
            """,
            "https://www.eba.europa.eu/a": '<a href="/c">C</a>',
            "https://www.eba.europa.eu/b": '<p>No new links</p>',
            "https://www.eba.europa.eu/c": '<p>Done</p>',
        }

        def response_for(url, **kwargs):
            return Mock(
                status_code=200,
                headers={"content-type": "text/html; charset=UTF-8"},
                text=pages[url],
                url=url,
            )

        mock_get.side_effect = response_for

        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads((Path(tmp) / "discovery" / "eba-test.json").read_text(encoding="utf-8"))

        self.assertEqual(
            urls,
            [
                "https://www.eba.europa.eu/homepage",
                "https://www.eba.europa.eu/a",
                "https://www.eba.europa.eu/b",
                "https://www.eba.europa.eu/documents/example.pdf",
                "https://www.eba.europa.eu/c",
            ],
        )
        self.assertEqual(mock_get.call_count, 4)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(metadata["failed_pages"], 0)

    @patch("regmon.discovery._stealth_discover")
    @patch("regmon.discovery.http_discover")
    def test_discover_does_not_fallback_on_degraded_http(self, mock_http, mock_stealth):
        from regmon.discovery import discover
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
        )
        mock_http.return_value = ["https://www.eba.europa.eu/homepage"]
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir()
            (discovery_dir / "eba-test.json").write_text(
                json.dumps({
                    "source_id": "eba-test",
                    "method": "http",
                    "state": "DEGRADED",
                    "discovered": 1,
                    "successful_pages": 1,
                    "failed_pages": 1,
                    "capped": False,
                }),
                encoding="utf-8",
            )
            urls = discover(source, Path(tmp))
        self.assertEqual(urls, ["https://www.eba.europa.eu/homepage"])
        mock_stealth.assert_not_called()

    @patch("regmon.discovery._stealth_discover")
    @patch("regmon.discovery.http_discover")
    def test_discover_prefers_http_path(self, mock_http, mock_stealth):
        from regmon.discovery import discover
        mock_http.return_value = ["https://www.eba.europa.eu/homepage"]
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir()
            (discovery_dir / "eba-test.json").write_text(
                json.dumps({
                    "source_id": "eba-test",
                    "method": "http",
                    "state": "COMPLETE",
                    "discovered": 1,
                    "successful_pages": 1,
                    "failed_pages": 0,
                    "capped": False,
                }),
                encoding="utf-8",
            )
            urls = discover(source, Path(tmp))
        self.assertEqual(urls, ["https://www.eba.europa.eu/homepage"])
        mock_stealth.assert_not_called()

    def test_excluded_exact_path_is_not_in_scope(self):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            excluded_prefixes=("https://www.eba.europa.eu/search/",),
        )
        self.assertFalse(in_scope("https://www.eba.europa.eu/search?query=rules", source))
        self.assertFalse(in_scope("https://www.eba.europa.eu/search/results", source))
        self.assertTrue(in_scope("https://www.eba.europa.eu/searching/rules", source))

class TestChange(unittest.TestCase):
    def test_new(self):
        self.assertEqual(classify_change(None,{"normalized_hash":"a"}),("NEW_URL",False))

    def test_normalized_hash_is_authoritative(self):
        self.assertEqual(classify_change({"normalized_hash":"same","raw_hash":"old"},{"normalized_hash":"same","raw_hash":"new"}),("UNCHANGED_URL",False))

    def test_html_source_change_is_distinct_from_text_change(self):
        self.assertEqual(
            classify_change(
                {"normalized_hash":"same-text","html_hash":"old-html"},
                {"normalized_hash":"same-text","html_hash":"new-html"},
            ),
            ("HTML_SOURCE_CHANGED", False),
        )

    def test_html_evidence_contains_source_diff_and_snapshot_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = {"normalized_hash":"same","html_hash":"old","html_snapshot_location":"data/snapshots/html/old.html","snapshot_location":"data/snapshots/old.txt"}
            after = {"normalized_hash":"same","html_hash":"new","html_snapshot_location":"data/snapshots/html/new.html","snapshot_location":"data/snapshots/new.txt"}
            path = write_evidence(
                Path(tmp), "HTML_SOURCE_CHANGED", "event-id", "https://example.test/page", "now",
                before, after, "same text", "same text",
                before_html="<html><body><p>Old markup</p></body></html>",
                after_html="<html><body><p>New markup</p></body></html>",
            )
            evidence = json.loads((Path(tmp) / path).read_text(encoding="utf-8"))
            self.assertEqual(evidence["before"]["html_snapshot_location"], before["html_snapshot_location"])
            self.assertIn("Old markup", evidence["html_diff"])
            self.assertIn("New markup", evidence["html_diff"])

    def test_legacy_baseline_migrates(self):
        self.assertEqual(classify_change({"content_hash":"old"},{"raw_hash":"new","normalized_hash":"n"}),("BASELINE_MIGRATION",True))

    def test_diff(self):
        diff=make_diff("old","new")
        self.assertIn("-old",diff)
        self.assertIn("+new",diff)

    def test_event_id_deterministic(self):
        self.assertEqual(build_event_id("CHANGED_URL","u","a","b"),build_event_id("CHANGED_URL","u","a","b"))

    def test_snapshot_paths_are_immutable_by_content_hash(self):
        from regmon import engine
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(engine, "ROOT", root), patch.object(engine, "SNAPSHOTS", root / "data" / "snapshots"), patch.object(engine, "HTML_SNAPSHOTS", root / "data" / "snapshots" / "html"):
                old_text_path = engine.write_snapshot("url-id", "old", "hash-old")
                new_text_path = engine.write_snapshot("url-id", "new", "hash-new")
                old_html_path = engine.write_html_snapshot("url-id", b"<html>old</html>", "html-old")
                new_html_path = engine.write_html_snapshot("url-id", b"<html>new</html>", "html-new")
                self.assertNotEqual(old_text_path, new_text_path)
                self.assertNotEqual(old_html_path, new_html_path)
                self.assertEqual((root / old_text_path).read_text(encoding="utf-8"), "old")
                self.assertEqual((root / old_html_path).read_bytes(), b"<html>old</html>")

class TestSourceOnlyNotifications(unittest.TestCase):
    def test_source_only_html_changes_do_not_trigger_notifications(self):
        notifications = build_notifications({
            "events": [{"event_id":"source-event","event_type":"HTML_SOURCE_CHANGED","url":"https://example.test/page"}],
            "ai_results": [],
        })
        self.assertEqual(notifications, [])


class TestAI(unittest.TestCase):
    def test_schema(self):
        value={key:(True if key=="relevant" else "x") for key in AI_REQUIRED_KEYS}
        self.assertEqual(validate_analysis(value),value)

    def test_json_code_fence(self):
        value={key:(True if key=="relevant" else "x") for key in AI_REQUIRED_KEYS}
        fence=chr(96)*3
        self.assertEqual(parse_json(f"{fence}json\n"+json.dumps(value)+f"\n{fence}"),value)

    def test_extra_key_rejected(self):
        value={key:(True if key=="relevant" else "x") for key in AI_REQUIRED_KEYS}
        value["extra"]="x"
        with self.assertRaises(ValueError):
            validate_analysis(value)

class TestNotifications(unittest.TestCase):
    def test_technical_change_remains_visible_when_ai_is_unavailable(self):
        event = {
            "event_id": build_event_id("CHANGED_URL", make_id("https://www.eba.europa.eu/a"), "old", "new"),
            "event_type": "CHANGED_URL",
            "url": "https://www.eba.europa.eu/a",
        }
        report = {
            "events": [event],
            "ai_results": [{
                "event": "CHANGED_URL",
                "event_id": event["event_id"],
                "url": event["url"],
                "ai": {"status": "error", "reason": "provider timeout"},
            }],
        }
        notifications = build_notifications(report)
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]["kind"], "CHANGED_URL")
        self.assertEqual(notifications[0]["topic"], "Technical change detected")

class TestRelevance(unittest.TestCase):
    def test_utility_excluded(self):
        self.assertFalse(triage("https://www.eba.europa.eu/contact")["candidate"])

    def test_regulatory_candidate(self):
        result=triage("https://www.eba.europa.eu/a","New regulatory guideline requirement")
        self.assertTrue(result["candidate"])
        self.assertIn("guideline",result["signals"])

class TestFetch(unittest.TestCase):
    @patch("regmon.fetch.requests.get")
    def test_http_500_retries_and_fails(self,mock_get):
        mock_get.return_value=Mock(status_code=500,content=b"bad",headers={})
        with self.assertRaises(Exception):
            fetch("https://example.test",attempts=2,backoff_seconds=0)
        self.assertEqual(mock_get.call_count,2)

    @patch("regmon.fetch.requests.get")
    def test_304_uses_validators_without_download(self,mock_get):
        mock_get.return_value=Mock(
            status_code=304,
            content=b"",
            headers={"etag": "new-etag", "last-modified": "Thu, 24 Sep 2026 04:00:00 GMT"},
        )
        result=fetch(
            "https://example.test",
            attempts=1,
            etag="old-etag",
            last_modified="Wed, 23 Sep 2026 04:00:00 GMT",
        )
        self.assertTrue(result.not_modified)
        self.assertEqual(result.status_code,304)
        headers=mock_get.call_args.kwargs["headers"]
        self.assertEqual(headers["If-None-Match"],"old-etag")
        self.assertEqual(headers["If-Modified-Since"],"Wed, 23 Sep 2026 04:00:00 GMT")

class TestState(unittest.TestCase):
    def test_flat_legacy_loader_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"latest.json"
            path.write_text(json.dumps({"id":{"canonical_url":"x"}}),encoding="utf-8")
            with patch("regmon.engine.DATA",Path(tmp)):
                self.assertIn("id",load_previous("eba-test"))

class TestEngineFlow(unittest.TestCase):
    def test_changed_event_uses_previous_snapshot(self):
        from regmon.engine import process_source
        url="https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a"
        uid=make_id(url)
        import regmon.engine as mod
        with patch("regmon.engine.load_discovery_metadata", return_value={"source_id":"eba-test","state":"COMPLETE","method":"test"}),              patch("regmon.engine.load_previous", return_value={uid:{
                 "url_id":uid,"canonical_url":url,"normalized_hash":"oldhash","raw_hash":"oldraw",
                 "snapshot_location":f"data/snapshots/{uid}.txt","first_seen":"2026-01-01T00:00:00+00:00"
             }}),              patch("regmon.engine.discover", return_value=[url]),              patch("regmon.engine.make_current_item", return_value=(
                 {"url_id":uid,"source_id":"eba-test","regulator":"European Banking Authority","canonical_url":url,
                  "normalized_hash":"newhash","raw_hash":"newraw","relevance":{"candidate":False},
                  "first_seen":"2026-01-01T00:00:00+00:00"},"new text"
             )),              patch("regmon.engine.write_snapshot", return_value="data/snapshots/test.txt"),              patch("regmon.engine.write_evidence") as mock_evidence:
            old_file=mod.ROOT/"data"/"snapshots"/f"{uid}.txt"
            old_file.parent.mkdir(parents=True,exist_ok=True)
            old_file.write_text("old text",encoding="utf-8")
            try:
                result=process_source(SOURCE,"run-test",dry_run=False)
                args=mock_evidence.call_args.args
                self.assertIn("old text",args)
                self.assertIn("new text",args)
                self.assertEqual(result["report"]["counts"]["changed"],1)
            finally:
                old_file.unlink(missing_ok=True)

    def test_missing_html_baseline_forces_full_fetch(self):
        from regmon.engine import make_current_item
        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a"
        old = {
            "content_type": "text/html; charset=UTF-8",
            "last_full_fetch": "2026-10-18T06:30:00+00:00",
            "etag": '"old-etag"',
            "last_modified": "Sat, 17 Oct 2026 12:00:00 GMT",
            "normalized_hash": "old-text-hash",
        }
        response = Mock(
            status_code=200,
            content_type="text/html; charset=UTF-8",
            content_length=61,
            etag='"new-etag"',
            last_modified="Sun, 18 Oct 2026 06:30:00 GMT",
            raw_hash="new-html-hash",
            not_modified=False,
            body=b"<html><body><main>Reporting update</main></body></html>",
        )
        with patch("regmon.engine.should_force_full_fetch", return_value=False), \
             patch("regmon.engine.fetch", return_value=response) as mock_fetch:
            item, text, html_body = make_current_item(url, old, SOURCE, "2026-10-18T06:35:00+00:00")
        self.assertIsNone(mock_fetch.call_args.kwargs["etag"])
        self.assertIsNone(mock_fetch.call_args.kwargs["last_modified"])
        self.assertTrue(item["html_baseline_forced"])
        self.assertEqual(item["html_hash"], "new-html-hash")
        self.assertIn("Reporting update", text)
        self.assertTrue(html_body.startswith(b"<html>"))

    def test_degraded_discovery_skips_content_fetch(self):
        from regmon.engine import process_source
        previous = {
            make_id("https://www.eba.europa.eu/a"): {
                "url_id": make_id("https://www.eba.europa.eu/a"),
                "canonical_url": "https://www.eba.europa.eu/a",
                "normalized_hash": "old",
            }
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": "eba-test",
            "state": "DEGRADED",
            "method": "test",
            "discovered": 10,
        }), patch("regmon.engine.load_previous", return_value=previous), patch("regmon.engine.discover", return_value=["https://www.eba.europa.eu/a"]), patch("regmon.engine.make_current_item") as mock_current:
            result = process_source(SOURCE, "run-degraded-gate", dry_run=True)
        mock_current.assert_not_called()
        self.assertEqual(result["report"]["counts"]["discovery_incomplete"], 1)
        self.assertEqual(result["report"]["counts"]["crawl_degraded"], 1)
        self.assertFalse(result["report"]["baseline_update_allowed"])

    def test_degraded_discovery_never_emits_removal(self):
        from regmon.engine import process_source
        present="https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a"
        missing="https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/b"
        present_uid=make_id(present)
        missing_uid=make_id(missing)
        previous={
            present_uid: {"url_id":present_uid,"canonical_url":present,"normalized_hash":"same","raw_hash":"raw"},
            missing_uid: {"url_id":missing_uid,"canonical_url":missing,"normalized_hash":"old","raw_hash":"old"},
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={"source_id":"eba-test","state":"DEGRADED","method":"test"}),              patch("regmon.engine.load_previous", return_value=previous),              patch("regmon.engine.discover", return_value=[present]),              patch("regmon.engine.make_current_item", return_value=(
                 {"url_id":present_uid,"source_id":"eba-test","regulator":"European Banking Authority",
                  "canonical_url":present,"normalized_hash":"same","raw_hash":"new",
                  "relevance":{"candidate":False}},"same text"
             )):
            result=process_source(SOURCE,"run-degraded",dry_run=True)
            self.assertEqual(result["report"]["counts"]["removed"],0)
            self.assertFalse(result["report"]["baseline_update_allowed"])

if __name__=="__main__":
    unittest.main()
