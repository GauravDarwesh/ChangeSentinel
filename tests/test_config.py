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

    def test_frbservices_user_guides_monitor_is_removed(self):
        _, sources = load_config(DEFAULT_CONFIG_PATH)
        self.assertNotIn("manual-fe66388fe452", sources)
        removed_url = "https://www.frbservices.org/central-bank/reporting-central/reporting-central-structure-central-user-guides"
        self.assertFalse(any(
            removed_url in source.seed_urls or removed_url in source.allowed_urls
            for source in sources.values()
        ))

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


    def test_crawl_depth_values_are_validated_and_defaults_remain_legacy(self):
        from regmon.config import SourceConfig
        source = {
            "id": "manual", "name": "Manual page", "regulator": "example.com",
            "seed_urls": ["https://example.com/policy"],
            "allowed_prefixes": ["https://example.com/"],
            "allowed_domains": ["example.com"],
        }
        parsed = SourceConfig.from_dict(source)
        self.assertEqual(parsed.crawl_depth, -1)
        bounded = SourceConfig.from_dict({**source, "crawl_depth": 2,
                                          "excluded_urls": ["https://example.com/policy/annex"]})
        self.assertEqual(bounded.crawl_depth, 2)
        self.assertEqual(bounded.excluded_urls, ("https://example.com/policy/annex",))
        with self.assertRaisesRegex(ValueError, "crawl_depth"):
            SourceConfig.from_dict({**source, "crawl_depth": 4})


if __name__ == "__main__":
    unittest.main()


class TestListedOn(unittest.TestCase):
    BASE = {"id": "manual-x", "name": "Form A", "regulator": "x.gov", "seed_urls": ["https://x.gov/a.pdf"],
            "allowed_prefixes": ["https://x.gov/"], "allowed_domains": ["x.gov"]}

    def test_listing_pages_are_http_addresses_and_at_most_five(self):
        self.assertEqual(SourceConfig.from_dict({**self.BASE, "listed_on": ["https://x.gov/forms?y=1"]}).listed_on, ("https://x.gov/forms?y=1",))
        for bad in (["javascript:alert(1)"], ["https://x.gov/" + "a" * 600], ["https://x.gov/p"] * 6, "https://x.gov/forms"):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(ValueError):
                SourceConfig.from_dict({**self.BASE, "listed_on": bad})

    def test_the_dashboard_can_set_and_clear_listing_pages(self):
        from regmon.monitor_settings import apply_settings

        config = {"version": 4, "defaults": {}, "sources": [dict(self.BASE)]}
        apply_settings(config, {"monitors": ["manual-x"], "set": {"listed_on": ["https://x.gov/forms", "https://x.gov/forms"]}, "clear": []})
        self.assertEqual(config["sources"][0]["listed_on"], ["https://x.gov/forms"])
        apply_settings(config, {"monitors": ["manual-x"], "set": {}, "clear": ["listed_on"]})
        self.assertNotIn("listed_on", config["sources"][0])
