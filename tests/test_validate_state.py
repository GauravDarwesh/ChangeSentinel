import json
import tempfile
import unittest
from pathlib import Path

from regmon.validate_state import validate_selected_state


class TestWorkflowStateValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "sources.json"
        self.discovery = self.root / "discovery"
        self.discovery.mkdir()
        self.config.write_text(json.dumps({"sources": [
            {"id": "fed-pilot", "active": True},
            {"id": "eba-legacy", "active": False},
        ]}), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def metadata(self, source_id, state):
        (self.discovery / f"{source_id}.json").write_text(
            json.dumps({"source_id": source_id, "state": state}), encoding="utf-8"
        )

    def test_all_ignores_inactive_historical_paused_metadata(self):
        self.metadata("fed-pilot", "COMPLETE")
        self.metadata("eba-legacy", "PAUSED")
        states, paused = validate_selected_state("all", self.config, self.discovery)
        self.assertEqual(states, [("fed-pilot", "COMPLETE")])
        self.assertEqual(paused, [])

    def test_inactive_source_cannot_be_selected_by_production_workflow(self):
        self.metadata("eba-legacy", "COMPLETE")
        with self.assertRaisesRegex(ValueError, "inactive"):
            validate_selected_state("eba-legacy", self.config, self.discovery)

    def test_active_paused_source_requires_valid_resume_checkpoint(self):
        self.metadata("fed-pilot", "PAUSED")
        with self.assertRaisesRegex(ValueError, "checkpoint is missing"):
            validate_selected_state("fed-pilot", self.config, self.discovery)
        checkpoint = self.discovery / "fed-pilot-checkpoint.json"
        checkpoint.write_text(json.dumps({
            "source_id": "fed-pilot", "state": "PAUSED",
            "pending": ["https://example.test/page"], "retry_pending": [],
        }), encoding="utf-8")
        states, paused = validate_selected_state("fed-pilot", self.config, self.discovery)
        self.assertEqual(states, [("fed-pilot", "PAUSED")])
        self.assertEqual(paused, ["fed-pilot"])


if __name__ == "__main__":
    unittest.main()
