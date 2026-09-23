import unittest
from regmon.config import DEFAULT_CONFIG_PATH, load_config

class TestConfig(unittest.TestCase):
    def test_sources_are_valid_and_expandable(self):
        _, sources=load_config(DEFAULT_CONFIG_PATH)
        self.assertIn("eba-consumer-protection",sources)
        self.assertGreater(sources["eba-consumer-protection"].max_urls,50)

if __name__=="__main__":
    unittest.main()
