import unittest

from regmon.config import DEFAULT_CONFIG_PATH, load_config


class TestConfig(unittest.TestCase):
    def test_full_site_source_is_archived_and_pilot_is_bounded(self):
        _, sources = load_config(DEFAULT_CONFIG_PATH)

        self.assertIn("eba-full-site", sources)
        full_site = sources["eba-full-site"]
        self.assertFalse(full_site.active)
        self.assertTrue(full_site.baseline_on_first_run)

        self.assertIn("eba-regulatory-pilot", sources)
        pilot = sources["eba-regulatory-pilot"]
        self.assertTrue(pilot.active)
        self.assertTrue(pilot.baseline_on_first_run)
        self.assertEqual(len(pilot.allowed_urls), 7)
        self.assertEqual(set(pilot.seed_urls), set(pilot.allowed_urls))
        self.assertEqual(pilot.max_urls, 0)
        self.assertEqual(pilot.discovery_http_workers, 3)
        self.assertEqual(pilot.discovery_slice_seconds, 0)
        self.assertEqual(pilot.discovery_max_pages_per_slice, 50)
        self.assertNotIn("https://www.eba.europa.eu/", pilot.seed_urls)
        self.assertTrue(all(url.startswith("https://www.eba.europa.eu/activities/") for url in pilot.allowed_urls))


if __name__ == "__main__":
    unittest.main()
