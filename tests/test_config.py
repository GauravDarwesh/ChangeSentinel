import unittest
from regmon.config import DEFAULT_CONFIG_PATH, load_config

class TestConfig(unittest.TestCase):
    def test_sources_are_valid_and_expandable(self):
        _, sources=load_config(DEFAULT_CONFIG_PATH)
        self.assertIn("eba-full-site",sources)
        source=sources["eba-full-site"]
        self.assertTrue(source.active)
        self.assertTrue(source.baseline_on_first_run)
        self.assertEqual(source.seed_urls, ("https://www.eba.europa.eu/", "https://www.eba.europa.eu/homepage"))
        self.assertEqual(source.max_urls, 0)
        self.assertEqual(source.discovery_attempts, 1)
        self.assertEqual(source.discovery_timeout_seconds, 180)
        self.assertEqual(source.discovery_http_attempts, 2)
        self.assertTrue(source.use_http_discovery)
        self.assertEqual(source.discovery_http_timeout_seconds, 20)
        self.assertEqual(source.discovery_http_workers, 6)
        self.assertEqual(source.discovery_slice_seconds, 2700)
        self.assertIn("https://www.eba.europa.eu/", source.allowed_prefixes)

if __name__=="__main__":
    unittest.main()
