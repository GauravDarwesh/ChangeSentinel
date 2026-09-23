import unittest
from unittest.mock import Mock, patch

from regmon.monitor import build_event_id, classify_change, discover, fetch, make_diff, normalize_html, parse_discovered_urls, validate_ai_analysis
from regmon.relevance import triage


class TestNormalization(unittest.TestCase):
    def test_dynamic_markup_does_not_change_normalized_content(self):
        html_a = """
        <html>
          <body>
            <nav>Navigation</nav>
            <main>
              <h1>Consumer protection</h1>
              <p>Guidelines on credit services.</p>
            </main>
            <footer>Footer A</footer>
          </body>
        </html>
        """
        html_b = """
        <html>
          <body>
            <nav>Different navigation</nav>
            <main>
              <h1>Consumer protection</h1>
              <p>Guidelines on credit services.</p>
            </main>
            <footer>Footer B</footer>
          </body>
        </html>
        """
        self.assertEqual(normalize_html(html_a), normalize_html(html_b))

    def test_substantive_text_change_is_preserved(self):
        html_a = "<html><main><h1>Guidelines</h1><p>Version one.</p></main></html>"
        html_b = "<html><main><h1>Guidelines</h1><p>Version two.</p></main></html>"
        self.assertNotEqual(normalize_html(html_a), normalize_html(html_b))

    def test_class_none_does_not_break_normalization(self):
        html = '<html><main><div class="">Regulatory content</div></main></html>'
        self.assertEqual(normalize_html(html), "Regulatory content")

    def test_none_attrs_do_not_break_dynamic_filter(self):
        from bs4 import BeautifulSoup

        soup = BeautifulSoup("<main><div>Regulatory content</div></main>", "html.parser")
        tag = soup.find("div")
        tag.attrs = None
        self.assertFalse(__import__("regmon.monitor", fromlist=["should_remove"]).should_remove(tag))

    def test_legacy_baseline_is_migrated(self):
        old = {"content_hash": "legacy-raw"}
        current = {"raw_hash": "new-raw", "normalized_hash": "new-normalized"}
        event, migrated = classify_change(old, current)
        self.assertEqual(event, "BASELINE_MIGRATION")
        self.assertTrue(migrated)

    def test_normalized_hash_is_authoritative_after_migration(self):
        old = {"normalized_hash": "same"}
        current = {"normalized_hash": "same", "raw_hash": "different"}
        event, migrated = classify_change(old, current)
        self.assertEqual(event, "UNCHANGED_URL")
        self.assertFalse(migrated)



    def test_diff_captures_substantive_edit(self):
        diff = make_diff("Line one\nVersion one", "Line one\nVersion two")
        self.assertIn("-Version one", diff)
        self.assertIn("+Version two", diff)

    def test_event_id_is_deterministic(self):
        a = build_event_id("CHANGED_URL", "abc", "old", "new")
        b = build_event_id("CHANGED_URL", "abc", "old", "new")
        self.assertEqual(a, b)
        self.assertNotEqual(a, build_event_id("CHANGED_URL", "abc", "old", "different"))

    def test_parse_discovered_urls_keeps_only_in_scope_urls(self):
        output = """
        progress
        https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-example
        https://example.test/outside
        https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-example
        """
        urls = parse_discovered_urls(output)
        self.assertEqual(
            urls,
            [
                "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-example"
            ],
        )

    @patch("regmon.monitor.time.sleep")
    @patch("regmon.monitor.subprocess.run")
    def test_discover_retries_empty_crawler_output(self, mock_run, mock_sleep):
        mock_run.side_effect = [
            Mock(returncode=0, stdout="progress only\n", stderr=""),
            Mock(
                returncode=0,
                stdout="https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-example\n",
                stderr="",
            ),
        ]
        urls = discover()
        self.assertEqual(
            urls,
            [
                "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-example"
            ],
        )
        mock_sleep.assert_called_once()

    @patch("regmon.monitor.requests.get")
    def test_http_error_is_not_treated_as_content(self, mock_get):
        response = Mock()
        response.status_code = 500
        response.headers = {}
        mock_get.return_value = response

        with self.assertRaises(Exception) as ctx:
            fetch("https://example.test/page")

        self.assertIn("HTTP 500", str(ctx.exception))

    def test_valid_ai_schema_is_accepted(self):
        value = {
            "relevant": True,
            "topic": "Consumer protection",
            "summary": "A concise summary.",
            "reason": "The page describes a regulatory change.",
        }
        self.assertEqual(validate_ai_analysis(value), value)

    def test_wrong_ai_relevant_type_is_rejected(self):
        value = {
            "relevant": "true",
            "topic": "Consumer protection",
            "summary": "A concise summary.",
            "reason": "The page describes a regulatory change.",
        }
        with self.assertRaises(ValueError):
            validate_ai_analysis(value)

    def test_extra_ai_key_is_rejected(self):
        value = {
            "relevant": True,
            "topic": "Consumer protection",
            "summary": "A concise summary.",
            "reason": "The page describes a regulatory change.",
            "confidence": 0.9,
        }
        with self.assertRaises(ValueError):
            validate_ai_analysis(value)
if __name__ == "__main__":
    unittest.main()
