import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.ai import AIConfig, AI_REQUIRED_KEYS, analyze, parse_json, run_smoke_test, validate_analysis
from regmon.change import HTML_COMPARISON_HASH_VERSION, build_event_id, classify_change, html_comparison_hash, make_diff, make_id, write_evidence
from regmon.content import extract_content, normalize_html
from regmon.config import SourceConfig
from regmon.discovery import _config_fingerprint, _fetch_links, _load_inventory, canonical, extract_html_links, http_discover, in_scope, parse_discovered_urls
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

    def test_fetch_accepts_trailing_slash_redirect_variant_as_same_page(self):
        source_url = "https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides"
        trailing_url = source_url + "/"
        response = Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8", "content-length": "37"})
        response.content = b"<main>Reporting Central guides</main>"
        response.url = trailing_url
        with patch("regmon.fetch.requests.get", side_effect=[
            Mock(status_code=301, headers={"location": trailing_url}, close=Mock()),
            response,
        ]), patch("regmon.fetch.validate_public_http_url", return_value=None):
            result = fetch(
                source_url, attempts=1, allowed_domains=["www.frbservices.org"],
                allowed_prefixes=["https://www.frbservices.org/"],
                allowed_urls=[source_url], max_bytes=None,
            )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.body, response.content)

    def test_dynamic_markup_is_ignored(self):
        a="<body><nav>A</nav><main><h1>Guideline</h1><p>Version one.</p></main><footer>A</footer></body>"
        b="<body><nav>B</nav><main><h1>Guideline</h1><p>Version one.</p></main><footer>B</footer></body>"
        self.assertEqual(normalize_html(a), normalize_html(b))

    def test_substantive_change_survives(self):
        self.assertNotEqual(normalize_html("<main>Version one</main>"), normalize_html("<main>Version two</main>"))

    def test_cloudflare_rotating_challenge_tokens_do_not_change_html_signature(self):
        before = """<html><body><a href="/forms/a">Reporting form</a>
        <script>window.__CF$cv$params={r:'a4c58a85e859511c',t:'MTc5MjMwNTUxNg=='};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>
        </body></html>"""
        after = before.replace("a4c58a85e859511c", "a4c61854dad2b091").replace(
            "MTc5MjMwNTUxNg==", "MTc5MjMxMTMyNA=="
        )
        self.assertNotEqual(before, after)
        self.assertEqual(html_comparison_hash(before), html_comparison_hash(after))

    def test_frbservices_rotating_cache_buster_does_not_change_html_signature(self):
        before = """<html><body><main>Reporting Central user guides</main>
        <script>var pageConfig = {}; pageConfig.cacheBuster = '1792627231';</script>
        </body></html>"""
        after = before.replace("1792627231", "1792643276")
        self.assertNotEqual(before, after)
        self.assertEqual(html_comparison_hash(before), html_comparison_hash(after))

    def test_substantive_page_config_change_is_not_suppressed_with_cache_buster(self):
        before = "<script>pageConfig.cacheBuster = '1'; pageConfig.isParentPage = false;</script>"
        after = "<script>pageConfig.cacheBuster = '2'; pageConfig.isParentPage = true;</script>"
        self.assertNotEqual(html_comparison_hash(before), html_comparison_hash(after))

    def test_real_html_link_change_remains_detectable(self):
        before = '<html><body><a href="/forms/a">Reporting form</a></body></html>'
        after = before.replace('/forms/a', '/forms/b')
        self.assertNotEqual(html_comparison_hash(before), html_comparison_hash(after))

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
        self.assertEqual(result, "Capital requirements draft\nMinimum ratio rises to 12%.")
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
        self.assertIn("SelectorSyntaxError", error)

    def test_zip_attachment_extracts_supported_members_deterministically(self):
        import io
        import zipfile

        def bundle(entries):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                for name, value in entries:
                    archive.writestr(name, value)
            return stream.getvalue()

        entries = [
            ("CurrentForm/form.txt", "Capital requirement: 12 percent"),
            ("CurrentForm/fields.csv", "field,value\nminimum_ratio,0.12\n"),
        ]
        first = bundle(entries)
        reordered = bundle(list(reversed(entries)))
        modified = bundle([
            ("CurrentForm/form.txt", "Capital requirement: 15 percent"),
            ("CurrentForm/fields.csv", "field,value\nminimum_ratio,0.12\n"),
        ])

        first_text, first_kind, first_error = extract_content(
            "https://example.test/DownloadAttachment?guid=synthetic",
            "application/octet-stream",
            first,
        )
        reordered_text, reordered_kind, reordered_error = extract_content(
            "https://example.test/DownloadAttachment?guid=synthetic",
            "application/zip",
            reordered,
        )
        modified_text, modified_kind, modified_error = extract_content(
            "https://example.test/DownloadAttachment?guid=synthetic",
            "",
            modified,
        )

        self.assertEqual(first_kind, "zip")
        self.assertEqual(reordered_kind, "zip")
        self.assertEqual(modified_kind, "zip")
        self.assertIsNone(first_error)
        self.assertIsNone(reordered_error)
        self.assertIsNone(modified_error)
        self.assertEqual(first_text, reordered_text)
        self.assertNotEqual(first_text, modified_text)
        self.assertIn("[FILE] CurrentForm/fields.csv (csv)", first_text)
        self.assertIn("Capital requirement: 12 percent", first_text)

    def test_zip_extraction_rejects_unsafe_or_unsupported_members(self):
        import io
        import zipfile

        def bundle(name, value):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(name, value)
            return stream.getvalue()

        traversal_text, traversal_kind, traversal_error = extract_content(
            "https://example.test/download?guid=unsafe",
            "application/zip",
            bundle("../escape.txt", "must not be accepted"),
        )
        unknown_text, unknown_kind, unknown_error = extract_content(
            "https://example.test/download?guid=unknown",
            "application/zip",
            bundle("CurrentForm/opaque.bin", b"opaque bytes"),
        )
        self.assertIsNone(traversal_text)
        self.assertEqual(traversal_kind, "zip")
        self.assertIn("Unsafe ZIP member path", traversal_error)
        self.assertIsNone(unknown_text)
        self.assertEqual(unknown_kind, "zip")
        self.assertIn("Unsupported file type", unknown_error)

    def test_extensionless_pdf_response_uses_pdf_extraction(self):
        text, kind, error = extract_content(
            "https://example.test/DownloadAttachment?guid=pdf",
            "",
            b"%PDF-not-a-real-file",
        )
        self.assertIsNone(text)
        self.assertEqual(kind, "pdf")
        self.assertTrue(error)

    def test_pdf_failure_is_explicit(self):
        text, kind, error = extract_content("https://example.test/a.pdf","application/pdf",b"not-a-pdf")
        self.assertIsNone(text)
        self.assertEqual(kind,"pdf")
        self.assertTrue(error)

PUBLIC_TEST_ADDRESS = [(2, 1, 6, "", ("8.8.8.8", 443))]


class TestDiscovery(unittest.TestCase):
    def setUp(self):
        # Discovery validates every target with a DNS preflight. Tests must not
        # depend on the runner's resolver (they failed offline before), so
        # resolution is stubbed to a public address; IP-literal checks still run.
        patcher = patch("regmon.security.socket.getaddrinfo", return_value=PUBLIC_TEST_ADDRESS)
        patcher.start()
        self.addCleanup(patcher.stop)

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


    def test_depth_limited_manual_scope_includes_root_and_same_directory_descendants_only(self):
        root = "https://home.treasury.gov/data/treasury-international-capital-tic-system/tic-forms-instructions"
        source = SourceConfig(
            id="manual-tic",
            name="US TIC Forms & Instructions",
            regulator="home.treasury.gov",
            seed_urls=(root,),
            allowed_prefixes=("https://home.treasury.gov/data/treasury-international-capital-tic-system/",),
            allowed_domains=("home.treasury.gov",),
            crawl_depth=2,
        )
        self.assertTrue(in_scope(root, source))
        self.assertTrue(in_scope(
            "https://home.treasury.gov/data/treasury-international-capital-tic-system/tic-forms-instructions/form-s",
            source,
        ))
        self.assertFalse(in_scope(
            "https://home.treasury.gov/data/treasury-open-data",
            source,
        ))
        self.assertFalse(in_scope(
            "https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions",
            source,
        ))

    def test_scope_handles_custom_ports_and_legacy_port_domains(self):
        url = "https://www.example.com:8443/policy"
        for configured_domain in ("www.example.com", "www.example.com:8443"):
            source = SourceConfig(
                id="port-test",
                name="Port Test",
                regulator="example.com",
                seed_urls=(url,),
                allowed_prefixes=("https://www.example.com:8443/",),
                allowed_domains=(configured_domain,),
                allowed_urls=(url,),
            )
            self.assertTrue(in_scope(url, source))
            self.assertFalse(in_scope("https://www.example.com:8444/policy", source))

    def test_current_attachment_scope_does_not_open_the_form_catalogue(self):
        page = "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14M"
        current_file = "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=current"
        history_file = "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=historical"
        source = SourceConfig(
            id="fed-current-files-test",
            name="Federal Reserve Current Files Test",
            regulator="Federal Reserve",
            seed_urls=(page,),
            allowed_prefixes=("https://www.federalreserve.gov/apps/reportingforms/Report/Index/",),
            allowed_domains=("www.federalreserve.gov",),
            allowed_urls=(page,),
            allowed_resource_prefixes=("https://www.federalreserve.gov/apps/reportingforms/Download/",),
            resource_link_text_patterns=("^Current",),
        )
        self.assertTrue(in_scope(page, source))
        self.assertTrue(in_scope(current_file, source))
        self.assertFalse(in_scope(
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR-Y-14A",
            source,
        ))
        html = """
          <a href="/apps/reportingforms/Download/DownloadAttachment?guid=current">Current (2 MB .ZIP)</a>
          <a href="/apps/reportingforms/Download/DownloadAttachment?guid=historical">Historical (1 MB .ZIP)</a>
          <a href="/apps/reportingforms/Report/Index/FR-Y-14A">Related form</a>
        """
        self.assertEqual(
            extract_html_links(page, html, source),
            [current_file],
        )

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
    def test_discovery_redirect_between_trailing_slash_variants_is_not_a_loop(self, mock_get):
        source = SourceConfig(
            id="frbservices-test",
            name="FRBServices user guides",
            regulator="www.frbservices.org",
            seed_urls=("https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides",),
            allowed_prefixes=("https://www.frbservices.org/",),
            allowed_domains=("www.frbservices.org",),
            allowed_urls=("https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides",),
            discovery_http_workers=1,
        )
        mock_get.side_effect = [
            Mock(status_code=301, headers={"location": "https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides/"}),
            Mock(status_code=200, headers={"content-type": "text/html; charset=UTF-8"},
                 text="<main><h1>Reporting Central</h1><a href='/central-bank/reporting-central/other'>Other</a></main>",
                 url="https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides/"),
        ]
        url, links, failure = _fetch_links(source.seed_urls[0], source, 10)
        self.assertIsNone(failure)
        self.assertEqual(url, source.seed_urls[0])
        self.assertEqual(links, [])
        self.assertEqual(mock_get.call_count, 2)

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

            # Keep the resume pass inside its discovery time budget. The first
            # pass above deliberately advances the mocked clock to force PAUSED;
            # the resumed scan should not depend on real CI-runner speed.
            with patch("regmon.discovery.time.monotonic", return_value=0):
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
            self.assertEqual(checkpoint["schema_version"], 3)
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
        self.assertEqual(checkpoint["schema_version"], 3)
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
    def test_successful_recovery_resolves_a_previous_permanent_failure(self, mock_get):
        """A fixed redirect must clear the prior failure ledger entry.

        FRBServices initially redirected the exact URL to its trailing-slash
        variant.  The old redirect code logged that as a permanent loop.  Once
        the redirect code was fixed, discovery still remained DEGRADED because
        an ordinary recovery fetch never replaced the old failure ledger row.
        """
        source = SourceConfig(
            id="frbservices-test",
            name="FRBServices user guides",
            regulator="www.frbservices.org",
            seed_urls=("https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides",),
            allowed_prefixes=("https://www.frbservices.org/",),
            allowed_domains=("www.frbservices.org",),
            allowed_urls=("https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides",),
            discovery_http_workers=1,
        )
        url = source.seed_urls[0]
        mock_get.return_value = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<main>Reporting Central</main>",
            url=url,
        )
        with tempfile.TemporaryDirectory() as tmp:
            discovery_dir = Path(tmp) / "discovery"
            discovery_dir.mkdir(parents=True)
            (discovery_dir / "frbservices-test-inventory-0000.txt").write_text(url + "\n", encoding="utf-8")
            (discovery_dir / "frbservices-test.json").write_text(json.dumps({
                "source_id": source.id, "state": "DEGRADED", "discovered": 1,
                "html_processed": 1, "successful_pages": 0, "failed_pages": 1,
            }), encoding="utf-8")
            (discovery_dir / "frbservices-test-failures.jsonl").write_text(json.dumps({
                "url": url, "status_code": 301,
                "error": "ValueError: Redirect loop detected",
                "retry_classification": "permanent_http",
            }) + "\n", encoding="utf-8")
            urls = http_discover(source, Path(tmp))
            metadata = json.loads((discovery_dir / "frbservices-test.json").read_text(encoding="utf-8"))
            latest_failure = json.loads((discovery_dir / "frbservices-test-failures.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(urls, [url])
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertTrue(latest_failure["resolved"])

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
    def test_discovery_rejects_private_initial_target_before_request(self, mock_get):
        url = "http://127.0.0.1/admin"
        source = SourceConfig(
            id="private-target-test",
            name="Private target test",
            regulator="localhost",
            seed_urls=(url,),
            allowed_prefixes=("http://127.0.0.1/",),
            allowed_domains=("127.0.0.1",),
            allowed_urls=(url,),
        )
        requested_url, links, failure = _fetch_links(url, source, timeout=1)
        self.assertEqual(requested_url, url)
        self.assertEqual(links, [])
        self.assertIn("Private", failure["error"])
        mock_get.assert_not_called()

    @patch("regmon.discovery.requests.get")
    def test_discovery_rejects_out_of_scope_redirect(self, mock_get):
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/activities/single-rulebook/start",),
            allowed_prefixes=("https://www.eba.europa.eu/activities/single-rulebook/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_attempts=3,
        )
        response = Mock(status_code=302, headers={"location": "https://evil.test/landing"})
        mock_get.return_value = response
        url, links, failure = _fetch_links(source.seed_urls[0], source, timeout=5)
        self.assertEqual(url, source.seed_urls[0])
        self.assertEqual(links, [])
        self.assertIn("outside the configured monitor scope", failure["error"])
        self.assertEqual(failure["retry_classification"], "permanent_http")
        mock_get.assert_called_once()

    @patch("regmon.discovery.requests.get")
    def test_scope_change_invalidates_checkpoint(self, mock_get):
        previous_scope = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            discovery_http_workers=1,
            discovery_slice_seconds=0,
        )
        source = SourceConfig(
            id="eba-test",
            name="EBA Test",
            regulator="European Banking Authority",
            seed_urls=("https://www.eba.europa.eu/homepage",),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            allowed_urls=("https://www.eba.europa.eu/homepage",),
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
                    "config_fingerprint": _config_fingerprint(previous_scope),
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


    @patch("regmon.discovery.validate_public_http_url", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_http_discovery_honors_each_configured_crawl_depth(self, mock_get, _validate):
        root = "https://www.eba.europa.eu/homepage"
        pages = {
            root: '<a href="/level-1">Level one</a><a href="https://outside.example.org/not-followed">Offsite</a>',
            "https://www.eba.europa.eu/level-1": '<a href="/level-2">Level two</a>',
            "https://www.eba.europa.eu/level-2": '<a href="/level-3">Level three</a>',
            "https://www.eba.europa.eu/level-3": '<a href="/level-4">Level four</a>',
        }

        def response_for(url, **kwargs):
            return Mock(
                status_code=200,
                headers={"content-type": "text/html; charset=UTF-8"},
                text=pages[url],
                url=url,
            )

        for depth in range(4):
            with self.subTest(depth=depth), tempfile.TemporaryDirectory() as tmp:
                mock_get.reset_mock()
                mock_get.side_effect = response_for
                source = SourceConfig(
                    id="depth-test",
                    name="Depth test",
                    regulator="European Banking Authority",
                    seed_urls=(root,),
                    allowed_prefixes=("https://www.eba.europa.eu/",),
                    allowed_domains=("www.eba.europa.eu",),
                    crawl_depth=depth,
                    discovery_http_workers=1,
                    discovery_slice_seconds=0,
                    discovery_max_pages_per_slice=200,
                )
                urls = http_discover(source, Path(tmp))
                metadata = json.loads(
                    (Path(tmp) / "discovery" / "depth-test.json").read_text(encoding="utf-8")
                )

            expected = [root] + [
                f"https://www.eba.europa.eu/level-{level}" for level in range(1, depth + 1)
            ]
            self.assertEqual(urls, expected)
            # To discover distance N, pages at distances 0..N-1 must be fetched.
            self.assertEqual(mock_get.call_count, depth)
            self.assertEqual(metadata["state"], "COMPLETE")
            self.assertFalse(any("outside.example.org" in url for url in urls))
            self.assertNotIn("level-4", urls)

    @patch("regmon.discovery.time.sleep", return_value=None)
    @patch("regmon.discovery.validate_public_http_url", return_value=None)
    @patch("regmon.discovery.requests.get")
    def test_retry_after_failure_does_not_bypass_crawl_depth(self, mock_get, _validate, _sleep):
        root = "https://www.eba.europa.eu/homepage"
        child = "https://www.eba.europa.eu/level-1"
        first_failure = Mock(
            status_code=503,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="temporary failure",
            url=root,
        )
        recovered = Mock(
            status_code=200,
            headers={"content-type": "text/html; charset=UTF-8"},
            text='<a href="/level-1">Level one</a>',
            url=root,
        )
        mock_get.side_effect = [first_failure, recovered]
        source = SourceConfig(
            id="depth-retry-test",
            name="Depth retry test",
            regulator="European Banking Authority",
            seed_urls=(root,),
            allowed_prefixes=("https://www.eba.europa.eu/",),
            allowed_domains=("www.eba.europa.eu",),
            crawl_depth=1,
            discovery_http_workers=1,
            discovery_http_attempts=1,
            discovery_slice_seconds=0,
            discovery_max_pages_per_slice=200,
        )

        with tempfile.TemporaryDirectory() as tmp:
            urls = http_discover(source, Path(tmp))
            metadata = json.loads(
                (Path(tmp) / "discovery" / "depth-retry-test.json").read_text(encoding="utf-8")
            )

        self.assertEqual(urls, [root, child])
        self.assertEqual(mock_get.call_count, 2)
        self.assertEqual(metadata["state"], "COMPLETE")
        self.assertEqual(metadata["failed_pages"], 1)


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
    def test_evidence_for_an_existing_event_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            relative = write_evidence(
                root, "EXTRACTION_ERROR", "immutable-id", "https://example.test/a",
                "2026-10-18T00:00:00+00:00", None, None, "before", None, "selector mismatch"
            )
            evidence_file = root / relative
            original = evidence_file.read_text(encoding="utf-8")
            write_evidence(
                root, "EXTRACTION_ERROR", "immutable-id", "https://example.test/a",
                "2026-10-18T01:00:00+00:00", None, None, "different before", None, "changed error"
            )
            self.assertEqual(evidence_file.read_text(encoding="utf-8"), original)

    def test_observation_id_makes_operational_event_ids_unique(self):
        first = build_event_id("FETCH_ERROR", "url-id", error="HTTP 503", observation_id="run-1")
        second = build_event_id("FETCH_ERROR", "url-id", error="HTTP 503", observation_id="run-2")
        self.assertNotEqual(first, second)

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

    def test_cloudflare_only_html_variation_is_classified_unchanged(self):
        before = "<script>window.__CF$cv$params={r:'ray-one',t:'time-one'};</script>"
        after = "<script>window.__CF$cv$params={r:'ray-two',t:'time-two'};</script>"
        self.assertEqual(
            classify_change(
                {
                    "normalized_hash": "same-text",
                    "html_hash": "raw-before",
                    "html_comparison_hash": html_comparison_hash(before),
                },
                {
                    "normalized_hash": "same-text",
                    "html_hash": "raw-after",
                    "html_comparison_hash": html_comparison_hash(after),
                },
            ),
            ("UNCHANGED_URL", False),
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
    @patch("regmon.ai.requests.post")
    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    def test_openrouter_401_returns_actionable_auth_diagnostic(self, mock_post):
        from regmon.ai import analyze
        response = Mock()
        response.status_code = 401
        response.json.return_value = {"error": {"message": "Invalid API key"}}
        mock_post.return_value = response
        result = analyze(
            "Synthetic regulator",
            "https://example.invalid/test",
            "CHANGED_URL",
            "- old\\n+ new",
            "new",
            AIConfig(timeout_seconds=5, attempts=2),
        )
        self.assertEqual(result["status"], "error")
        self.assertIn("HTTP 401", result["reason"])
        self.assertIn("OPENROUTER_API_KEY", result["reason"])
        self.assertIn("Invalid API key", result["reason"])
        self.assertEqual(mock_post.call_count, 1)

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

    @patch("regmon.ai.analyze")
    def test_smoke_test_uses_only_synthetic_evidence(self, mock_analyze):
        mock_analyze.return_value = {
            "status": "ok",
            "analysis": {key: (True if key == "relevant" else "validated")
                         for key in AI_REQUIRED_KEYS},
        }
        config = AIConfig(timeout_seconds=5, attempts=1, model="test/model")
        result = run_smoke_test(config)
        arguments = mock_analyze.call_args.kwargs
        self.assertEqual(result["status"], "ok")
        self.assertEqual(arguments["url"], "https://example.invalid/change-sentinel-ai-smoke-test")
        self.assertIn("Synthetic", arguments["regulator"])
        self.assertIn("Periodic Reporting\n+Synthetic fixture heading: Quarterly Reporting", arguments["diff"])
        self.assertEqual(arguments["config"], config)

class TestNotifications(unittest.TestCase):
    def test_deterministically_excluded_utility_change_does_not_notify(self):
        url = "https://www.eba.europa.eu/contact"
        event_id = build_event_id("CHANGED_URL", make_id(url), "old", "new")
        event = {
            "event_id": event_id,
            "event_type": "CHANGED_URL",
            "url": url,
            "evidence": {
                "current": {
                    "relevance": {
                        "candidate": False,
                        "reason": "Obvious site utility page",
                        "signals": ["contact"],
                    }
                }
            },
        }
        report = {
            "events": [event],
            # Even a stale/erroneous AI result must not override deterministic exclusion.
            "ai_results": [{
                "event": "CHANGED_URL",
                "event_id": event_id,
                "url": url,
                "ai": {
                    "status": "ok",
                    "analysis": {
                        "relevant": True,
                        "topic": "Should not escape deterministic exclusion",
                        "summary": "Synthetic test only",
                        "reason": "Synthetic test only",
                        "impact": "Synthetic test only",
                    },
                },
            }],
        }
        self.assertEqual(build_notifications(report), [])

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
    @patch("regmon.fetch.validate_public_http_url")
    @patch("regmon.fetch.requests.get")
    def test_fetch_allows_scoped_attachment_outside_page_prefix(self, mock_get, _validate_url):
        url = "https://example.test/Download/DownloadAttachment?guid=current"
        mock_get.return_value = Mock(
            status_code=200,
            content=b"%PDF-synthetic",
            headers={
                "content-type": "application/pdf",
                "content-length": "14",
                "etag": None,
                "last-modified": None,
            },
        )
        result = fetch(
            url,
            attempts=1,
            allowed_domains=("example.test",),
            allowed_prefixes=("https://example.test/Report/Index/",),
            allowed_urls=("https://example.test/Report/Index/FR-Y-14M",),
            allowed_resource_prefixes=("https://example.test/Download/",),
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.body, b"%PDF-synthetic")
        mock_get.assert_called_once()

    @patch("regmon.fetch.validate_public_http_url")
    @patch("regmon.fetch.requests.get")
    def test_resource_redirect_cannot_escape_the_allowed_download_route(self, mock_get, _validate_url):
        url = "https://example.test/Download/DownloadAttachment?guid=current"
        mock_get.return_value = Mock(
            status_code=302,
            content=b"",
            headers={"location": "https://evil.test/DownloadAttachment?guid=external"},
        )
        with self.assertRaisesRegex(ValueError, "outside allowed domains"):
            fetch(
                url,
                attempts=1,
                allowed_domains=("example.test",),
                allowed_prefixes=("https://example.test/Report/Index/",),
                allowed_urls=("https://example.test/Report/Index/FR-Y-14M",),
                allowed_resource_prefixes=("https://example.test/Download/",),
            )
        mock_get.assert_called_once()

    @patch("regmon.fetch.requests.get")
    def test_http_500_retries_and_fails(self,mock_get):
        mock_get.return_value=Mock(status_code=500,content=b"bad",headers={})
        with self.assertRaises(Exception):
            fetch("https://example.test",attempts=2,backoff_seconds=0)
        self.assertEqual(mock_get.call_count,2)

    @patch("regmon.fetch.requests.get")
    def test_redirect_to_private_address_is_rejected(self, mock_get):
        response = Mock()
        response.status_code = 302
        response.headers = {"location": "http://127.0.0.1/admin"}
        mock_get.return_value = response
        with self.assertRaises(ValueError):
            fetch("https://example.test/page")
        mock_get.assert_called_once()

    @patch("regmon.fetch.requests.get")
    def test_redirect_outside_configured_source_scope_is_rejected(self, mock_get):
        response = Mock()
        response.status_code = 302
        response.headers = {"location": "https://evil.test/landing"}
        mock_get.return_value = response
        with self.assertRaisesRegex(ValueError, "outside allowed domains"):
            fetch(
                "https://example.test/page",
                attempts=2,
                allowed_domains=("example.test",),
                allowed_prefixes=("https://example.test/",),
                allowed_urls=("https://example.test/page",),
            )
        mock_get.assert_called_once()

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

    def test_not_material_markup_review_suppresses_future_html_only_events(self):
        """A decision must prevent cosmetic markup churn from reopening work."""
        from regmon.engine import process_source

        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a"
        uid = make_id(url)
        old = {
            "url_id": uid,
            "canonical_url": url,
            "normalized_hash": "stable-text",
            "raw_hash": "old-html",
            "html_hash": "old-html",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        current = {
            "url_id": uid,
            "source_id": SOURCE.id,
            "regulator": SOURCE.regulator,
            "canonical_url": url,
            "normalized_hash": "stable-text",
            "raw_hash": "new-html",
            "html_hash": "new-html",
            "relevance": {"candidate": False},
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": SOURCE.id, "state": "COMPLETE", "method": "test"
        }), patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current, "same regulatory text", b"<main>same regulatory text</main>")), \
             patch("regmon.engine.reviews.not_material_html_urls", return_value={url}):
            result = process_source(SOURCE, "reviewed-markup-change", dry_run=True)

        self.assertEqual(result["report"]["counts"]["source_changed"], 0)
        self.assertEqual(result["report"]["counts"]["unchanged"], 1)
        self.assertEqual(result["report"]["events"], [])

    def test_old_html_signature_is_rehashed_before_cache_buster_comparison(self):
        """Upgrading the HTML hash must not alert on an unchanged page with a rotating cache-buster."""
        import hashlib
        import regmon.engine as mod
        from regmon.engine import process_source

        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/cache-buster"
        uid = make_id(url)
        before = ("<html><body><main>Reporting Central user guides</main>"
                  "<script>var pageConfig = {}; pageConfig.cacheBuster = '1792627231';</script></body></html>")
        after = before.replace("1792627231", "1792643276")
        old = {
            "url_id": uid, "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_comparison_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_snapshot_location": "data/snapshots/html/old.html",
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        current = {
            "url_id": uid, "source_id": SOURCE.id, "regulator": SOURCE.regulator,
            "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": hashlib.sha256(after.encode()).hexdigest(),
            "html_hash": hashlib.sha256(after.encode()).hexdigest(),
            "html_comparison_hash": html_comparison_hash(after),
            "html_comparison_hash_version": HTML_COMPARISON_HASH_VERSION,
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "relevance": {"candidate": False}, "first_seen": "2026-01-01T00:00:00+00:00",
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": SOURCE.id, "state": "COMPLETE", "method": "test"
        }), patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current, "same regulatory text", after.encode())), \
             patch("regmon.engine.read_html_snapshot", return_value=before), \
             patch("regmon.engine.reviews.not_material_html_urls", return_value=set()):
            result = process_source(SOURCE, "html-signature-version-migration", dry_run=True)

        self.assertEqual(result["report"]["counts"]["source_changed"], 0)
        self.assertEqual(result["report"]["counts"]["baseline_migration"], 0)
        self.assertEqual(result["report"]["counts"]["unchanged"], 1)
        self.assertEqual(result["report"]["events"], [])
        self.assertEqual(result["inventory"][uid]["html_comparison_hash_version"], HTML_COMPARISON_HASH_VERSION)

    def test_old_html_signature_migration_still_detects_a_real_html_change(self):
        import hashlib
        import regmon.engine as mod
        from regmon.engine import process_source

        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/markup-change"
        uid = make_id(url)
        before = ("<html><body><main class='old'>Reporting Central user guides</main>"
                  "<script>pageConfig.cacheBuster = '1';</script></body></html>")
        after = ("<html><body><main class='new'>Reporting Central user guides</main>"
                 "<script>pageConfig.cacheBuster = '2';</script></body></html>")
        old = {
            "url_id": uid, "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_comparison_hash": hashlib.sha256(before.encode()).hexdigest(),
            "html_snapshot_location": "data/snapshots/html/old.html",
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        current = {
            "url_id": uid, "source_id": SOURCE.id, "regulator": SOURCE.regulator,
            "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": hashlib.sha256(after.encode()).hexdigest(),
            "html_hash": hashlib.sha256(after.encode()).hexdigest(),
            "html_comparison_hash": html_comparison_hash(after),
            "html_comparison_hash_version": HTML_COMPARISON_HASH_VERSION,
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "relevance": {"candidate": False}, "first_seen": "2026-01-01T00:00:00+00:00",
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": SOURCE.id, "state": "COMPLETE", "method": "test"
        }), patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current, "same regulatory text", after.encode())), \
             patch("regmon.engine.read_html_snapshot", return_value=before), \
             patch("regmon.engine.reviews.not_material_html_urls", return_value=set()):
            result = process_source(SOURCE, "html-signature-version-real-change", dry_run=True)

        self.assertEqual(result["report"]["counts"]["source_changed"], 1)
        self.assertEqual(result["report"]["counts"]["changed"], 0)
        self.assertEqual(result["report"]["counts"]["baseline_migration"], 0)
        self.assertEqual(result["report"]["events"][0]["event_type"], "HTML_SOURCE_CHANGED")

    def test_old_html_signature_without_snapshot_uses_visible_baseline_migration(self):
        import hashlib
        from regmon.engine import process_source

        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/missing-html-snapshot"
        uid = make_id(url)
        before_hash = hashlib.sha256(b"old response").hexdigest()
        current_html = "<html><body><main>Reporting Central user guides</main></body></html>"
        current = {
            "url_id": uid, "source_id": SOURCE.id, "regulator": SOURCE.regulator,
            "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": hashlib.sha256(current_html.encode()).hexdigest(),
            "html_hash": hashlib.sha256(current_html.encode()).hexdigest(),
            "html_comparison_hash": html_comparison_hash(current_html),
            "html_comparison_hash_version": HTML_COMPARISON_HASH_VERSION,
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "relevance": {"candidate": False}, "first_seen": "2026-01-01T00:00:00+00:00",
        }
        old = {
            "url_id": uid, "canonical_url": url, "normalized_hash": "same-text",
            "raw_hash": before_hash, "html_hash": before_hash,
            "html_comparison_hash": before_hash,
            "html_snapshot_location": "data/snapshots/html/missing.html",
            "extraction_type": "html", "extractor_version": "content-extractor-v7",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": SOURCE.id, "state": "COMPLETE", "method": "test"
        }), patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current, "same regulatory text", current_html.encode())), \
             patch("regmon.engine.read_html_snapshot", return_value=None), \
             patch("regmon.engine.reviews.not_material_html_urls", return_value=set()):
            result = process_source(SOURCE, "html-signature-version-missing-snapshot", dry_run=True)

        self.assertEqual(result["report"]["counts"]["source_changed"], 0)
        self.assertEqual(result["report"]["counts"]["baseline_migration"], 1)
        self.assertEqual(result["report"]["events"][0]["event_type"], "BASELINE_MIGRATION")
        self.assertEqual(result["report"]["events"][0]["migration_reason"], "html_comparison_hash_version")

    @patch("regmon.engine.analyze", return_value={"status": "skipped", "reason": "API key missing"})
    def test_skipped_ai_analysis_is_counted(self, mock_analyze):
        from regmon.engine import process_source
        import regmon.engine as mod
        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/a"
        uid = make_id(url)
        old = {
            "url_id": uid,
            "canonical_url": url,
            "normalized_hash": "oldhash",
            "raw_hash": "oldraw",
            "snapshot_location": "data/snapshots/old.txt",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        current_item = {
            "url_id": uid,
            "source_id": "eba-test",
            "regulator": "European Banking Authority",
            "canonical_url": url,
            "normalized_hash": "newhash",
            "raw_hash": "newraw",
            "relevance": {"candidate": True, "reason": "test"},
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={"source_id": "eba-test", "state": "COMPLETE", "method": "test"}), \
             patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current_item, "new text")), \
             patch("regmon.engine.read_snapshot", side_effect=lambda record: "new text" if record.get("normalized_hash") == "newhash" else "old text"), \
             patch("regmon.engine.write_snapshot", return_value="data/snapshots/new.txt"), \
             patch("regmon.engine.write_evidence", return_value="data/evidence/test.json"):
            result = process_source(SOURCE, "run-ai-skipped-test", dry_run=False)
        self.assertEqual(result["report"]["counts"]["ai_skipped"], 1)
        self.assertEqual(mock_analyze.call_count, 1)


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

    def test_dry_run_does_not_write_error_or_removal_evidence(self):
        from regmon.engine import process_source

        failing_url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/fetch-failure"
        extraction_url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/extraction-failure"
        removed_url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/removed"
        failing_id, extraction_id, removed_id = map(make_id, (failing_url, extraction_url, removed_url))
        previous = {
            failing_id: {"url_id": failing_id, "canonical_url": failing_url, "normalized_hash": "old-fetch"},
            extraction_id: {"url_id": extraction_id, "canonical_url": extraction_url, "normalized_hash": "old-extraction"},
            removed_id: {"url_id": removed_id, "canonical_url": removed_url, "normalized_hash": "old-removed"},
        }

        def current_item(url, old, source, now):
            uid = make_id(url)
            if url == failing_url:
                return ({"url_id": uid, "canonical_url": url, "fetch_error": "synthetic timeout"}, None, None)
            return ({"url_id": uid, "canonical_url": url, "raw_hash": "bad-payload", "extraction_error": "synthetic parse failure"}, None, None)

        with patch("regmon.engine.load_discovery_metadata", return_value={"source_id": SOURCE.id, "state": "COMPLETE"}), \
             patch("regmon.engine.load_previous", return_value=previous), \
             patch("regmon.engine.discover", return_value=[failing_url, extraction_url]), \
             patch("regmon.engine.make_current_item", side_effect=current_item), \
             patch("regmon.engine.write_evidence") as write_evidence:
            result = process_source(SOURCE, "dry-run-evidence-test", dry_run=True)

        self.assertEqual(result["report"]["counts"]["fetch_error"], 1)
        self.assertEqual(result["report"]["counts"]["extraction_error"], 1)
        self.assertEqual(result["report"]["counts"]["removed"], 1)
        write_evidence.assert_not_called()

    def test_dry_run_uses_temporary_discovery_copy(self):
        from regmon.engine import run
        import regmon.engine as mod

        with tempfile.TemporaryDirectory() as tmp:
            persistent_discovery = Path(tmp) / "persisted-discovery"
            persistent_discovery.mkdir()
            marker = persistent_discovery / "marker.json"
            marker.write_text("original", encoding="utf-8")
            captured = {}

            def fake_process(source, run_id, dry_run=False, discovery_data_dir=None):
                captured["path"] = str(discovery_data_dir)
                marker_copy = discovery_data_dir / "discovery" / "marker.json"
                self.assertEqual(marker_copy.read_text(encoding="utf-8"), "original")
                marker_copy.write_text("mutated in dry-run", encoding="utf-8")
                return {
                    "report": {
                        "source": {"id": source.id, "regulator": source.regulator},
                        "baseline_update_allowed": False,
                        "counts": {},
                    },
                    "inventory": {},
                }

            with patch("regmon.engine.DISCOVERY", persistent_discovery), \
                 patch("regmon.engine.load_config", return_value=({}, {SOURCE.id: SOURCE})), \
                 patch("regmon.engine.process_source", side_effect=fake_process), \
                 patch("regmon.engine.save_outputs", return_value={"dry_run": True}):
                result = run(SOURCE.id, dry_run=True)

            self.assertTrue(result["outcome"]["dry_run"])
            self.assertEqual(marker.read_text(encoding="utf-8"), "original")
            self.assertFalse(Path(captured["path"]).exists())

    def test_synthetic_change_flows_through_ai_to_durable_notification_outbox(self):
        from regmon.engine import process_source
        from regmon.notify import enqueue_notifications, load_outbox, save_outbox

        url = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/synthetic-update"
        uid = make_id(url)
        old = {
            "url_id": uid,
            "canonical_url": url,
            "normalized_hash": "old-normalized-hash",
            "raw_hash": "old-raw-hash",
            "snapshot_location": "data/snapshots/old.txt",
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        current_item = {
            "url_id": uid,
            "source_id": SOURCE.id,
            "regulator": SOURCE.regulator,
            "canonical_url": url,
            "normalized_hash": "new-normalized-hash",
            "raw_hash": "new-raw-hash",
            "relevance": {"candidate": True, "reason": "synthetic test candidate"},
            "first_seen": "2026-01-01T00:00:00+00:00",
        }
        analysis = {
            "relevant": True,
            "topic": "Synthetic reporting requirement",
            "change_type": "amendment",
            "summary": "The synthetic reporting requirement changed.",
            "impact": "Review the changed reporting requirement.",
            "effective_date": "Not stated",
            "affected_scope": "Not stated",
            "actions": "Review the evidence.",
            "reason": "The synthetic diff identifies a reporting change.",
        }

        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": SOURCE.id, "state": "COMPLETE", "method": "synthetic-test"
        }), patch("regmon.engine.load_previous", return_value={uid: old}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(current_item, "new regulation text")), \
             patch("regmon.engine.read_snapshot", side_effect=lambda record:
                   "new regulation text" if record and record.get("normalized_hash") == "new-normalized-hash"
                   else "old regulation text"), \
             patch("regmon.engine.write_snapshot", return_value="data/snapshots/synthetic.txt"), \
             patch("regmon.engine.write_evidence", return_value="data/evidence/synthetic.json"), \
             patch("regmon.engine.analyze", return_value={"status": "ok", "analysis": analysis}):
            result = process_source(SOURCE, "synthetic-ai-notification-pipeline", dry_run=False)

        report = result["report"]
        self.assertEqual(report["counts"]["changed"], 1)
        self.assertEqual(report["counts"]["ai_ok"], 1)
        event = next(item for item in report["events"] if item["event_type"] == "CHANGED_URL")
        ai_result = report["ai_results"][0]
        self.assertEqual(event["event_id"], ai_result["event_id"])

        notifications = build_notifications(report)
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]["event_id"], event["event_id"])
        self.assertEqual(notifications[0]["topic"], "Synthetic reporting requirement")

        with tempfile.TemporaryDirectory() as tmp:
            outbox_path = Path(tmp) / "notification-outbox.json"
            outbox = {"pending_events": {}, "updated_at": None}
            enqueue_notifications(outbox, notifications, {})
            save_outbox(outbox, outbox_path)
            restored = load_outbox(outbox_path)
            self.assertIn(event["event_id"], restored["pending_events"])
            self.assertEqual(restored["pending_events"][event["event_id"]]["summary"],
                             "The synthetic reporting requirement changed.")

    def test_first_successful_baseline_creates_snapshot_without_ai_or_alerts(self):
        from regmon.engine import process_source

        url = "https://example.test/regulatory/initial-page"
        source = SourceConfig(
            id="new-baseline-test",
            name="New source baseline test",
            regulator="Example Regulator",
            seed_urls=(url,),
            allowed_prefixes=("https://example.test/regulatory/",),
            allowed_domains=("example.test",),
            allowed_urls=(url,),
            baseline_on_first_run=True,
        )
        item = {
            "source_id": source.id,
            "regulator": source.regulator,
            "canonical_url": url,
            "normalized_hash": "initial-baseline-hash",
            "raw_hash": "initial-raw-hash",
            "first_seen": "2026-10-18T00:00:00+00:00",
            "relevance": {"candidate": True, "reason": "synthetic baseline fixture"},
        }

        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": source.id, "state": "COMPLETE", "method": "synthetic-test"
        }), patch("regmon.engine.load_previous", return_value={}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(item, "Initial regulatory text", None)), \
             patch("regmon.engine.write_snapshot", return_value="data/snapshots/initial-baseline.txt") as write_snapshot, \
             patch("regmon.engine.write_evidence") as write_evidence, \
             patch("regmon.engine.analyze") as analyze:
            result = process_source(source, "synthetic-first-baseline", dry_run=False)

        report = result["report"]
        self.assertTrue(report["source"]["initial_baseline"])
        self.assertEqual(report["counts"]["new"], 1)
        self.assertEqual(report["events"], [])
        self.assertEqual(report["new_urls"], [])
        self.assertEqual(report["ai_results"], [])
        write_snapshot.assert_called_once()
        write_evidence.assert_not_called()
        analyze.assert_not_called()
        self.assertEqual(build_notifications(report), [])

    def test_original_file_snapshot_preserves_pdf_bytes(self):
        from regmon.engine import write_file_snapshot

        body = b"%PDF-1.7\\noriginal pdf bytes\\n%%EOF"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("regmon.engine.ROOT", root), patch("regmon.engine.SNAPSHOTS", root / "data" / "snapshots"):
                relative = write_file_snapshot("url-id", body, "pdf-sha256", "pdf")
            self.assertEqual(relative, "data/snapshots/files/url-id-pdf-sha256.pdf")
            self.assertEqual((root / relative).read_bytes(), body)

    def test_pdf_without_saved_original_forces_full_fetch_for_backfill(self):
        from regmon.engine import make_current_item

        url = "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=pdf-test"
        old = {
            "content_type": "application/pdf",
            "extraction_type": "pdf",
            "last_full_fetch": "2026-10-18T10:00:00+00:00",
            "etag": '"old-etag"',
            "last_modified": "Sat, 17 Oct 2026 12:00:00 GMT",
            "normalized_hash": "old-text-hash",
            "snapshot_location": "data/snapshots/old.txt",
        }
        body = b"%PDF-1.7\\nvalid-by-test-fixture\\n%%EOF"
        response = Mock(
            status_code=200,
            content_type="application/pdf",
            content_length=len(body),
            etag='"new-etag"',
            last_modified="Sun, 18 Oct 2026 10:00:00 GMT",
            raw_hash="new-pdf-hash",
            not_modified=False,
            body=body,
        )
        with patch("regmon.engine.should_force_full_fetch", return_value=False), \
             patch("regmon.engine.fetch", return_value=response) as mock_fetch, \
             patch("regmon.engine.extract_content", return_value=("Extracted PDF text", "pdf", None)):
            item, text, html_body, file_body = make_current_item(
                url, old, SOURCE, "2026-10-18T10:10:00+00:00"
            )

        self.assertTrue(item["file_baseline_forced"])
        self.assertTrue(item["full_fetch_forced"])
        self.assertIsNone(mock_fetch.call_args.kwargs["etag"])
        self.assertIsNone(mock_fetch.call_args.kwargs["last_modified"])
        self.assertEqual(text, "Extracted PDF text")
        self.assertIsNone(html_body)
        self.assertEqual(file_body, body)

    def test_pdf_snapshot_path_is_added_to_inventory(self):
        from regmon.engine import process_source

        url = "https://example.test/regulatory/form.pdf"
        uid = make_id(url)
        source = SourceConfig(
            id="pdf-snapshot-test",
            name="PDF snapshot test",
            regulator="Example Regulator",
            seed_urls=(url,),
            allowed_prefixes=("https://example.test/regulatory/",),
            allowed_domains=("example.test",),
            allowed_urls=(url,),
            baseline_on_first_run=True,
        )
        body = b"%PDF-1.7\\noriginal bytes\\n%%EOF"
        item = {
            "url_id": uid,
            "source_id": source.id,
            "regulator": source.regulator,
            "canonical_url": url,
            "extraction_type": "pdf",
            "raw_hash": "pdf-content-hash",
            "normalized_hash": "extracted-text-hash",
            "relevance": {"candidate": True, "reason": "synthetic PDF fixture"},
        }
        with patch("regmon.engine.load_discovery_metadata", return_value={
            "source_id": source.id, "state": "COMPLETE", "method": "synthetic-test"
        }), patch("regmon.engine.load_previous", return_value={}), \
             patch("regmon.engine.discover", return_value=[url]), \
             patch("regmon.engine.make_current_item", return_value=(item, "PDF extracted text", None, body)), \
             patch("regmon.engine.write_snapshot", return_value="data/snapshots/text.txt"), \
             patch("regmon.engine.write_file_snapshot", return_value="data/snapshots/files/file.pdf") as write_file:
            result = process_source(source, "synthetic-pdf-snapshot", dry_run=False)

        self.assertEqual(result["inventory"][uid]["file_snapshot_location"], "data/snapshots/files/file.pdf")
        write_file.assert_called_once_with(uid, body, "pdf-content-hash", "pdf")



class TestAdaptiveContentExtraction(unittest.TestCase):
    def test_html_inline_elements_do_not_break_sentences(self):
        from regmon.content import normalize_html

        html = """
        <html><body><main>
          <p>The Federal <strong>Reserve</strong> uses data from
          <em>this survey</em> to measure the cost of borrowing.</p>
          <p>Second paragraph stays separate.</p>
        </main></body></html>
        """
        extracted = normalize_html(html)
        self.assertIn(
            "The Federal Reserve uses data from this survey to measure the cost of borrowing.",
            extracted,
        )
        self.assertIn("borrowing.\nSecond paragraph stays separate.", extracted)

    def test_html_table_preserves_row_and_column_relationships(self):
        from regmon.content import normalize_html

        html = """
        <html><body><main>
          <p>Reporting schedule</p>
          <table>
            <tr><th>Form</th><th>Frequency</th></tr>
            <tr><td>FR 2028B</td><td>Quarterly</td></tr>
            <tr><td>FR 2028S</td><td>Weekly</td></tr>
          </table>
        </main></body></html>
        """
        extracted = normalize_html(html)
        self.assertIn("| Form | Frequency |", extracted)
        self.assertIn("| FR 2028B | Quarterly |", extracted)
        self.assertIn("| FR 2028S | Weekly |", extracted)


    def test_configured_html_selector_keeps_inline_sentences_and_tables(self):
        from regmon.content import normalize_html

        html = """
        <html><body>
          <aside>Ignore this content.</aside>
          <main id="regulatory-content">
            <p>Data from <strong>this survey</strong> measures costs.</p>
            <table><tr><th>Form</th><th>Period</th></tr>
              <tr><td>FR 2028B</td><td>Quarterly</td></tr></table>
          </main>
        </body></html>
        """
        extracted = normalize_html(html, include_selector="#regulatory-content")
        self.assertIn("Data from this survey measures costs.", extracted)
        self.assertIn("| Form | Period |", extracted)
        self.assertIn("| FR 2028B | Quarterly |", extracted)
        self.assertNotIn("Ignore this content.", extracted)


    def test_pdf_wrapped_sentences_and_split_words_are_repaired(self):
        from regmon.content import normalize_pdf_prose

        raw = (
            "The Federal Reserve System uses data from this survey\n"
            "to measure the cost of agricul-\n"
            "tural borrowing from banks.\n"
            "\n"
            "A separate paragraph follows."
        )
        extracted = normalize_pdf_prose(raw)
        self.assertIn(
            "The Federal Reserve System uses data from this survey to measure the cost of agricultural borrowing from banks.",
            extracted,
        )
        self.assertIn("banks.\nA separate paragraph follows.", extracted)


    def test_narrow_pdf_table_preserves_prose_in_same_vertical_band(self):
        from regmon.content import _extract_pdfplumber_page

        page = Mock()
        page.width = 1000
        page.height = 1000
        fast_text = (
            "The form explains the purpose of reporting before the small table.\n"
            "Please enter the daily prime rate in the table at right."
        )
        detected_tables = [
            (
                (700.0, 400.0, 930.0, 650.0),
                [
                    ["Day", "Prime Rate"],
                    ["Monday", "8.500"],
                    ["Tuesday", "8.375"],
                ],
                6,
            )
        ]
        with patch("regmon.content._find_pdf_tables", return_value=detected_tables):
            extracted = _extract_pdfplumber_page(page, fast_text)

        self.assertIn("purpose of reporting", extracted)
        self.assertIn("daily prime rate in the table at right", extracted)
        self.assertIn("| Day | Prime Rate |", extracted)
        self.assertIn("| Monday | 8.500 |", extracted)
        page.crop.assert_not_called()


    def test_fragmented_regulatory_form_is_routed_to_layout_fallback(self):
        from regmon.content import _looks_like_fragmented_pdf_page

        lines = [
            "QTFL", "9912", "Insured or Guaranteed", "by Consolidated",
            "Farm Service Agency", "Nominal", "Rate of", "Interest",
            "QTFL", "7924", "Percent", "Frequency", "with which",
            "Interest is", "Compounded", "or Paid", "QTFL", "1917",
            "Next Date", "Loan Rate", "Recalculated", "QTFL", "A341",
        ]
        self.assertTrue(_looks_like_fragmented_pdf_page("\n".join(lines)))


    def test_pdf_table_detector_rejects_layout_cells_that_split_words(self):
        from regmon.content import _table_score

        fragmented_rows = [
            ["PLEASE READ INSTR", "UCTIONS BEFORE CO", "MPLETING", "THIS FORM."],
            ["Board of Gover", "rnor", "s of the Federal", "Reserve System"],
            ["Small Business L", "endi", "ng Su", "rvey"],
            ["INSTRUCTIONS FOR PREPARA", "TION O", "F", "Small Business Lending"],
        ]
        self.assertEqual(_table_score(fragmented_rows), 0)

        coherent_rows = [
            ["Form", "Period", "Status"],
            ["FR 2028D", "Quarterly", "Current"],
            ["FR 2028B", "Quarterly", "Current"],
        ]
        self.assertGreater(_table_score(coherent_rows), 0)


    def test_pdf_table_renderer_keeps_values_in_cells(self):
        from regmon.content import _table_to_markdown

        output = _table_to_markdown([
            ["Date", "Prime rate", "Day"],
            ["08/24", "8.500", "Monday"],
            ["08/25", "8.375", "Tuesday"],
        ])
        self.assertIn("| Date | Prime rate | Day |", output)
        self.assertIn("| 08/24 | 8.500 | Monday |", output)
        self.assertIn("| 08/25 | 8.375 | Tuesday |", output)


    def test_nested_form_xobject_image_triggers_ocr_detection(self):
        from regmon.content import _page_has_image_xobject

        class PdfObject(dict):
            def get_object(self):
                return self

        class PdfReference:
            def __init__(self, target):
                self.target = target

            def get_object(self):
                return self.target

        image = PdfObject({"/Subtype": "/Image"})
        image_map = PdfObject({"Image1": PdfReference(image)})
        inner_resources = PdfObject({"/XObject": PdfReference(image_map)})
        form = PdfObject({
            "/Subtype": "/Form",
            "/Resources": PdfReference(inner_resources),
        })
        outer_map = PdfObject({"Form1": PdfReference(form)})
        root_resources = PdfObject({"/XObject": PdfReference(outer_map)})
        page = Mock()
        page.get.return_value = PdfReference(root_resources)

        self.assertTrue(_page_has_image_xobject(page))
        page.get_contents.assert_not_called()

    def test_ocr_result_keeps_form_fields_on_separate_lines(self):
        import sys
        from types import SimpleNamespace

        from regmon.content import _ocr_pdf_pages

        class FakeImage:
            def close(self):
                pass

        class FakeBitmap:
            def to_pil(self):
                return FakeImage()

            def close(self):
                pass

        class FakePage:
            def render(self, scale):
                return FakeBitmap()

            def close(self):
                pass

        class FakeDocument:
            def __getitem__(self, index):
                return FakePage()

            def close(self):
                pass

        recognized = (
            "Insured or Guaranteed\n"
            "Farm Service Agency\n"
            "Nominal\n"
            "Rate of Interest"
        )
        image_to_string = Mock(return_value=recognized)
        pytesseract_module = SimpleNamespace(image_to_string=image_to_string)
        pdfium_module = SimpleNamespace(PdfDocument=lambda body: FakeDocument())
        monotonic_values = iter([0.0, 0.0])

        with patch.dict(sys.modules, {
            "pytesseract": pytesseract_module,
            "pypdfium2": pdfium_module,
        }), patch("regmon.content.time.monotonic", side_effect=lambda: next(monotonic_values)):
            result = _ocr_pdf_pages(b"%PDF-1.7", [0])

        self.assertEqual(
            result[0],
            "Insured or Guaranteed\nFarm Service Agency\nNominal\nRate of Interest",
        )


    def test_parser_upgrade_can_rebaseline_without_false_change(self):
        from regmon.change import classify_change

        old = {
            "normalized_hash": "old-layout-hash",
            "raw_hash": "same-original-pdf-bytes",
            "extractor_version": "legacy",
        }
        current = {
            "normalized_hash": "new-layout-hash",
            "raw_hash": "same-original-pdf-bytes",
            "extractor_version": "layout-pdf-html-v2",
        }
        self.assertEqual(
            classify_change(old, current, force_baseline_migration=True),
            ("BASELINE_MIGRATION", True),
        )
        self.assertEqual(
            classify_change(old, current),
            ("CHANGED_URL", False),
        )






    def test_pdf_binary_is_routed_before_utf8_decode(self):
        class NoUtf8DecodeBytes(bytes):
            def decode(self, *args, **kwargs):
                raise AssertionError("Binary PDF bytes must not be decoded as UTF-8")

        body = NoUtf8DecodeBytes(b"%PDF-1.7 binary payload")
        with patch("regmon.content._extract_pdf", return_value=("Readable PDF text", None)) as extract_pdf:
            result = extract_content("https://example.test/large.pdf", "application/pdf", body)

        self.assertEqual(result, ("Readable PDF text", "pdf", None))
        extract_pdf.assert_called_once_with(body)

    def test_normal_text_pdf_does_not_inspect_visual_content_streams(self):
        from pypdf import PdfReader

        page = Mock()
        page.extract_text.return_value = (
            "This is a normal digital PDF page with enough meaningful text to stay on the fast path."
        )
        reader = Mock()
        reader.is_encrypted = False
        reader.pages = [page]

        with patch("pypdf.PdfReader", return_value=reader), \
             patch("regmon.content._page_has_image_xobject") as inspect_visual_content:
            text, kind, error = extract_content(
                "https://example.test/ordinary.pdf",
                "application/pdf",
                b"%PDF-1.7 synthetic body",
            )

        self.assertIsNone(error)
        self.assertEqual(kind, "pdf")
        self.assertIn("normal digital PDF page", text)
        inspect_visual_content.assert_not_called()


    def test_large_scanned_pdfs_use_time_budget_not_a_low_page_cap(self):
        from regmon.content import MAX_OCR_PAGES, MAX_OCR_TOTAL_SECONDS

        self.assertGreaterEqual(MAX_OCR_PAGES, 1000)
        self.assertEqual(MAX_OCR_TOTAL_SECONDS, 120)


    def test_ocr_total_time_budget_stops_before_next_page(self):
        import sys
        from types import SimpleNamespace

        from regmon.content import _ocr_pdf_pages

        class FakeImage:
            def close(self):
                pass

        class FakeBitmap:
            def to_pil(self):
                return FakeImage()

            def close(self):
                pass

        class FakePage:
            def render(self, scale):
                return FakeBitmap()

            def close(self):
                pass

        class FakeDocument:
            def __init__(self):
                self.pages = [FakePage(), FakePage()]

            def __getitem__(self, index):
                return self.pages[index]

            def close(self):
                pass

        image_to_string = Mock(return_value="Recognized page text.")
        pytesseract_module = SimpleNamespace(image_to_string=image_to_string)
        pdfium_module = SimpleNamespace(PdfDocument=lambda body: FakeDocument())
        monotonic_values = iter([0.0, 0.0, 121.0])

        with patch.dict(sys.modules, {
            "pytesseract": pytesseract_module,
            "pypdfium2": pdfium_module,
        }), patch("regmon.content.time.monotonic", side_effect=lambda: next(monotonic_values)):
            with self.assertRaisesRegex(TimeoutError, "total time budget"):
                _ocr_pdf_pages(b"%PDF-1.7", [0, 1])

        self.assertEqual(image_to_string.call_count, 1)
        self.assertEqual(image_to_string.call_args.kwargs["timeout"], 15)


class TestExtractorVersionMigration(unittest.TestCase):

    def test_layout_pdf_v3_rebaselines_existing_pdf_bytes_after_table_fix(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        self.assertEqual(CONTENT_EXTRACTOR_VERSION, "content-extractor-v7")
        old = {
            "extraction_type": "pdf",
            "extractor_version": "layout-pdf-html-v2",
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "fragmented-table-text",
        }
        current = {
            "extraction_type": "pdf",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "corrected-table-text",
        }
        self.assertTrue(should_rebaseline_extractor(old, current))

    def test_docling_profile_transition_on_identical_bytes_is_a_migration(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        old = {
            "extraction_type": "pdf",
            "extractor_version": CONTENT_EXTRACTOR_VERSION + "-fallback",
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "fallback-layout-text",
        }
        current = {
            "extraction_type": "pdf",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "docling-layout-text",
        }
        self.assertTrue(should_rebaseline_extractor(old, current))

        reverse = dict(old)
        reverse["raw_hash"] = "different-pdf-bytes"
        self.assertFalse(should_rebaseline_extractor(current, reverse))

    def test_fallback_profile_is_persisted_in_extractor_version(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import make_current_item, should_rebaseline_extractor

        url = "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=fallback-profile"
        body = b"%PDF-1.7 synthetic bytes"
        response = Mock(
            status_code=200,
            content_type="application/pdf",
            content_length=len(body),
            etag=None,
            last_modified=None,
            raw_hash="same-pdf-hash",
            not_modified=False,
            body=body,
        )

        def fallback_extract(*args, **kwargs):
            kwargs["_extraction_profile"]["profile"] = "fallback"
            return "Flattened text", "pdf", None

        with (
            patch("regmon.engine.should_force_full_fetch", return_value=False),
            patch("regmon.engine.fetch", return_value=response),
            patch("regmon.engine.extract_content", side_effect=fallback_extract),
        ):
            item, text, html_body, file_body = make_current_item(
                url, None, SOURCE, "2026-10-19T10:10:00+00:00"
            )

        self.assertEqual(
            item["extractor_version"], CONTENT_EXTRACTOR_VERSION + "-fallback"
        )
        self.assertEqual(text, "Flattened text")
        self.assertEqual(file_body, body)
        self.assertIsNone(html_body)

        old = {
            "extractor_type": "pdf",
            "extraction_type": "pdf",
            "extractor_version": CONTENT_EXTRACTOR_VERSION + "-fallback",
            "raw_hash": "same-pdf-hash",
            "normalized_hash": "Flattened text",
        }
        current = dict(old)
        current["extractor_version"] = CONTENT_EXTRACTOR_VERSION
        current["normalized_hash"] = "Structured Docling text"
        self.assertTrue(should_rebaseline_extractor(old, current))


    def test_pdf_parser_upgrade_forces_unconditional_refetch(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import make_current_item

        url = "https://www.federalreserve.gov/apps/reportingforms/Download/DownloadAttachment?guid=version-test"
        body = b"%PDF-1.7 synthetic bytes"
        old = {
            "content_type": "application/pdf",
            "extraction_type": "pdf",
            "extractor_version": "legacy",
            "raw_hash": "same-pdf-hash",
            "normalized_hash": "old-layout-text",
            "snapshot_location": "data/snapshots/old.txt",
            "file_snapshot_location": "data/snapshots/files/old.pdf",
            "last_full_fetch": "2026-10-18T10:00:00+00:00",
            "etag": '"old-etag"',
            "last_modified": "Sat, 17 Oct 2026 12:00:00 GMT",
        }
        response = Mock(
            status_code=200,
            content_type="application/pdf",
            content_length=len(body),
            etag='"same-etag"',
            last_modified="Sun, 18 Oct 2026 10:00:00 GMT",
            raw_hash="same-pdf-hash",
            not_modified=False,
            body=body,
        )
        with patch("regmon.engine.should_force_full_fetch", return_value=False), \
             patch("regmon.engine.fetch", return_value=response) as mock_fetch, \
             patch("regmon.engine.extract_content", return_value=("Reflowed text", "pdf", None)):
            item, text, html_body, file_body = make_current_item(
                url, old, SOURCE, "2026-10-18T10:10:00+00:00"
            )

        self.assertTrue(item["extractor_baseline_forced"])
        self.assertTrue(item["full_fetch_forced"])
        self.assertIsNone(mock_fetch.call_args.kwargs["etag"])
        self.assertIsNone(mock_fetch.call_args.kwargs["last_modified"])
        self.assertEqual(item["extractor_version"], CONTENT_EXTRACTOR_VERSION)
        self.assertEqual(text, "Reflowed text")
        self.assertEqual(file_body, body)
        self.assertIsNone(html_body)


    def test_html_parser_upgrade_rebaselines_when_only_volatile_html_bytes_differ(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        before_html = (
            "<html><body><main><h1>Reporting form</h1></main>"
            "<script>window.__CF$cv$params={r:'ray-before',t:'time-before'};</script>"
            "</body></html>"
        )
        after_html = before_html.replace("ray-before", "ray-after").replace(
            "time-before", "time-after"
        )
        old = {
            "extraction_type": "html",
            "extractor_version": None,
            "raw_hash": "raw-before",
            "normalized_hash": "old-parser-output",
            "html_comparison_hash": html_comparison_hash(before_html),
        }
        current = {
            "extraction_type": "html",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "raw_hash": "raw-after",
            "normalized_hash": "new-parser-output",
            "html_comparison_hash": html_comparison_hash(after_html),
        }

        self.assertNotEqual(old["raw_hash"], current["raw_hash"])
        self.assertEqual(old["html_comparison_hash"], current["html_comparison_hash"])
        self.assertTrue(should_rebaseline_extractor(old, current))
        self.assertEqual(
            classify_change(old, current, force_baseline_migration=True),
            ("BASELINE_MIGRATION", True),
        )

    def test_real_html_content_change_is_not_hidden_by_extractor_rebaseline(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        before_html = "<html><body><main><p>Reporting threshold is 10 percent.</p></main></body></html>"
        after_html = "<html><body><main><p>Reporting threshold is 15 percent.</p></main></body></html>"
        old = {
            "extraction_type": "html",
            "extractor_version": None,
            "raw_hash": "raw-before",
            "normalized_hash": "old-parser-output",
            "html_comparison_hash": html_comparison_hash(before_html),
        }
        current = {
            "extraction_type": "html",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "raw_hash": "raw-after",
            "normalized_hash": "new-parser-output",
            "html_comparison_hash": html_comparison_hash(after_html),
        }

        self.assertNotEqual(old["html_comparison_hash"], current["html_comparison_hash"])
        self.assertFalse(should_rebaseline_extractor(old, current))
        self.assertEqual(classify_change(old, current), ("CHANGED_URL", False))

    def test_pdf_parser_upgrade_still_rebaselines_on_identical_file_bytes(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        old = {
            "extraction_type": "pdf",
            "extractor_version": "legacy",
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "old-layout-output",
        }
        current = {
            "extraction_type": "pdf",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "raw_hash": "same-pdf-bytes",
            "normalized_hash": "new-layout-output",
        }
        self.assertTrue(should_rebaseline_extractor(old, current))


if __name__=="__main__":
    unittest.main()
