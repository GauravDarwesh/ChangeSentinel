import unittest

from regmon.config import DEFAULT_CONFIG_PATH, SourceConfig, load_config


class TestConfig(unittest.TestCase):
    def test_source_config_parses_css_selection_options(self):
        source = SourceConfig.from_dict({
            "id": "manual-test",
            "name": "Example policy",
            "regulator": "example.com",
            "seed_urls": ["https://example.com/policy"],
            "allowed_prefixes": ["https://example.com/"],
            "allowed_domains": ["example.com"],
            "include_selector": "main .policy",
            "ignore_selectors": [".cookie-banner", ".breadcrumb"],
        })
        self.assertEqual(source.include_selector, "main .policy")
        self.assertEqual(source.ignore_selectors, (".cookie-banner", ".breadcrumb"))

    def test_selected_reporting_forms_detail_pilot_is_bounded(self):
        _, sources = load_config(DEFAULT_CONFIG_PATH)
        source_id = "fed-reporting-forms-detail-pilot"
        self.assertIn(source_id, sources)
        source = sources[source_id]
        expected_urls = (
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C",
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028bs",
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028D",
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14M",
            "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14Q",
        )
        self.assertTrue(source.active)
        self.assertTrue(source.baseline_on_first_run)
        self.assertEqual(source.seed_urls, expected_urls)
        self.assertEqual(set(source.allowed_urls), set(expected_urls))
        self.assertEqual(len(source.allowed_urls), 5)
        self.assertEqual(source.max_urls, 0)
        self.assertEqual(
            source.allowed_prefixes,
            ("https://www.federalreserve.gov/apps/reportingforms/Report/Index/",),
        )
        self.assertEqual(source.allowed_domains, ("www.federalreserve.gov",))
        self.assertEqual(
            source.allowed_resource_prefixes,
            ("https://www.federalreserve.gov/apps/reportingforms/Download/",),
        )
        self.assertEqual(source.resource_link_text_patterns, ("^Current",))

    def test_eba_sources_are_inactive_and_federal_reserve_pilot_is_bounded(self):
        _, sources = load_config(DEFAULT_CONFIG_PATH)

        self.assertIn("eba-full-site", sources)
        self.assertFalse(sources["eba-full-site"].active)
        self.assertTrue(sources["eba-full-site"].baseline_on_first_run)

        self.assertIn("eba-regulatory-pilot", sources)
        self.assertFalse(sources["eba-regulatory-pilot"].active)
        self.assertEqual(len(sources["eba-regulatory-pilot"].allowed_urls), 7)

        self.assertIn("fed-reporting-forms-pilot", sources)
        pilot = sources["fed-reporting-forms-pilot"]
        expected_urls = (
            "https://www.federalreserve.gov/apps/reportingforms/review",
            "https://www.federalreserve.gov/apps/reportingforms/recentupdates",
        )
        self.assertTrue(pilot.active)
        self.assertTrue(pilot.baseline_on_first_run)
        self.assertEqual(pilot.seed_urls, expected_urls)
        self.assertEqual(set(pilot.allowed_urls), set(expected_urls))
        self.assertEqual(len(pilot.allowed_urls), 2)
        self.assertEqual(pilot.max_urls, 0)
        self.assertEqual(pilot.discovery_http_workers, 2)
        self.assertEqual(pilot.discovery_slice_seconds, 0)
        self.assertEqual(pilot.discovery_max_pages_per_slice, 10)
        self.assertTrue(all(
            url.startswith("https://www.federalreserve.gov/apps/reportingforms/")
            for url in pilot.allowed_urls
        ))


if __name__ == "__main__":
    unittest.main()
