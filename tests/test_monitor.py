import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.ai import AI_REQUIRED_KEYS, parse_json, validate_analysis
from regmon.change import build_event_id, classify_change, make_diff, make_id
from regmon.content import extract_content, normalize_html
from regmon.config import SourceConfig
from regmon.discovery import canonical, extract_html_links, http_discover, in_scope, parse_discovered_urls
from regmon.fetch import fetch
from regmon.monitor import load_previous
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

    def test_legacy_baseline_migrates(self):
        self.assertEqual(classify_change({"content_hash":"old"},{"raw_hash":"new","normalized_hash":"n"}),("BASELINE_MIGRATION",True))

    def test_diff(self):
        diff=make_diff("old","new")
        self.assertIn("-old",diff)
        self.assertIn("+new",diff)

    def test_event_id_deterministic(self):
        self.assertEqual(build_event_id("CHANGED_URL","u","a","b"),build_event_id("CHANGED_URL","u","a","b"))

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
