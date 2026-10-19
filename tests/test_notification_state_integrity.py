import json
import tempfile
import unittest
from pathlib import Path

from regmon.notify import load_outbox, load_state, save_outbox, save_state


class TestNotificationStateIntegrity(unittest.TestCase):
    def test_missing_state_files_bootstrap_empty_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(load_state(root / "notifications.json")["sent_events"], {})
            self.assertEqual(load_outbox(root / "outbox.json")["pending_events"], {})

    def test_corrupt_json_fails_closed_instead_of_resetting_deduplication(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "notifications.json"
            path.write_text('{"sent_events": ', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Refusing to reset notification state"):
                load_state(path)

    def test_invalid_schema_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "outbox.json"
            path.write_text(json.dumps({"pending_events": []}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "expected an object"):
                load_outbox(path)

    def test_outbox_rejects_mismatched_event_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "outbox.json"
            path.write_text(json.dumps({
                "pending_events": {"event-a": {"event_id": "event-b"}},
                "updated_at": None,
            }), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "event ID does not match"):
                load_outbox(path)

    def test_state_and_outbox_are_round_tripped_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_path = root / "notifications.json"
            outbox_path = root / "outbox.json"
            state = {"sent_events": {"event-a": {"kind": "CHANGED_URL", "sent_at": "now"}}}
            outbox = {"pending_events": {"event-b": {
                "event_id": "event-b", "kind": "EXTRACTION_ERROR"
            }}}
            save_state(state, state_path)
            save_outbox(outbox, outbox_path)
            self.assertIn("event-a", load_state(state_path)["sent_events"])
            self.assertIn("event-b", load_outbox(outbox_path)["pending_events"])
            self.assertTrue(state_path.read_text(encoding="utf-8").endswith("\n"))
            self.assertTrue(outbox_path.read_text(encoding="utf-8").endswith("\n"))
            self.assertEqual(list(root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
