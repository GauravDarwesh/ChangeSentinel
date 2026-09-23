import unittest
from regmon.config import DEFAULT_CONFIG_PATH, load_config

class TestConfig(unittest.TestCase):
    def test_sources_are_valid_and_expandable(self):
        _, sources=load_config(DEFAULT_CONFIG_PATH)
        self.assertIn("eba-full-site",sources)
        source=sources["eba-full-site"]
        self.assertTrue(source.active)
        self.assertTrue(source.baseline_on_first_run)
        self.assertEqual(source.seed_urls, ("https://www.eba.europa.eu/homepage",))
        self.assertEqual(source.max_urls, 0)
        self.assertIn("https://www.eba.europa.eu/", source.allowed_prefixes)

if __name__=="__main__":
    unittest.main()
