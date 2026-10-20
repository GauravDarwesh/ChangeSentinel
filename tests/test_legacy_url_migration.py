from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from regmon.config import SourceConfig


def load_migration_module():
    script = Path(__file__).resolve().parents[1] / "scripts" / "migrate_legacy_url_collisions.py"
    spec = importlib.util.spec_from_file_location("migrate_legacy_url_collisions", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestLegacyUrlCollisionMigration(unittest.TestCase):
    preferred_url = (
        "https://www.eba.europa.eu/guidelines?phase=consultation&version=2015"
    )
    reversed_url = (
        "https://www.eba.europa.eu/guidelines?version=2015&phase=consultation"
    )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data_dir = self.root / "data"
        snapshots = self.data_dir / "snapshots"
        snapshots.mkdir(parents=True)
        (snapshots / "preferred.txt").write_text("same normalized source text\n", encoding="utf-8")
        (snapshots / "legacy.txt").write_text("same normalized source text\n", encoding="utf-8")
        self.module = load_migration_module()
        self.source = SourceConfig.from_dict({
            "id": "eba-test",
            "name": "EBA test source",
            "regulator": "European Banking Authority",
            "active": False,
            "seed_urls": [self.preferred_url],
            "allowed_urls": [self.preferred_url],
            "allowed_prefixes": ["https://www.eba.europa.eu/"],
            "allowed_domains": ["www.eba.europa.eu"],
        })
        self.configured_sources = {"eba-test": self.source}
        self.preferred_id = hashlib.sha256(self.preferred_url.encode("utf-8")).hexdigest()
        self.legacy_id = hashlib.sha256(self.reversed_url.encode("utf-8")).hexdigest()
        same_hash = hashlib.sha256(b"same normalized source text\n").hexdigest()
        self.preferred = {
            "canonical_url": self.preferred_url,
            "normalized_hash": same_hash,
            "raw_hash": "raw-preferred",
            "snapshot_location": "data/snapshots/preferred.txt",
            "last_checked": "2026-09-23T16:33:35+00:00",
            "last_full_fetch": "2026-09-23T16:33:30+00:00",
            "first_seen": "2026-09-01T00:00:00+00:00",
            "change_history": [{
                "event_id": "event-new",
                "event_type": "NEW_URL",
                "timestamp": "2026-09-23T16:33:35+00:00",
                "evidence_location": "data/evidence/event-new.json",
            }],
        }
        self.legacy = {
            "canonical_url": self.reversed_url,
            "normalized_hash": same_hash,
            "raw_hash": "raw-legacy",
            "snapshot_location": "data/snapshots/legacy.txt",
            "last_checked": "2026-09-23T16:33:35+00:00",
            "last_full_fetch": "2026-09-23T16:33:30+00:00",
            "first_seen": "2026-09-03T00:00:00+00:00",
            "change_history": [{
                "event_id": "event-removed",
                "event_type": "REMOVED_URL",
                "timestamp": "2026-09-23T16:33:35+00:00",
                "evidence_location": "data/evidence/event-removed.json",
            }],
        }
        self.latest = {
            "schema_version": 2,
            "sources": {
                "eba-test": {
                    self.legacy_id: copy.deepcopy(self.legacy),
                    self.preferred_id: copy.deepcopy(self.preferred),
                },
                "unrelated": {
                    "other-id": {"canonical_url": "https://example.com/a", "normalized_hash": "x"}
                },
            },
        }

    def test_dry_run_identifies_query_order_collision_and_prefers_configured_spelling(self):
        plans = self.module.audit_collisions(self.latest, self.configured_sources, self.data_dir)
        self.assertEqual(len(plans), 1)
        plan = plans[0]
        self.assertTrue(plan["safe_to_migrate"], plan["reasons"])
        self.assertEqual(plan["source_id"], "eba-test")
        self.assertEqual(plan["record_count"], 2)
        self.assertEqual(plan["survivor_url_id"], self.preferred_id)
        self.assertEqual(plan["merged_url_ids"], [self.legacy_id])
        self.assertFalse(self.source.active)

    def test_migration_retains_both_timelines_and_does_not_mutate_input(self):
        original = copy.deepcopy(self.latest)
        plans = self.module.audit_collisions(self.latest, self.configured_sources, self.data_dir)
        migrated, applied = self.module.migrate_collisions(
            self.latest, plans, migrated_at="2026-10-20T00:00:00+00:00"
        )

        self.assertEqual(len(applied), 1)
        records = migrated["sources"]["eba-test"]
        self.assertEqual(list(records), [self.preferred_id])
        record = records[self.preferred_id]
        self.assertEqual(
            {entry["event_id"] for entry in record["change_history"]},
            {"event-new", "event-removed"},
        )
        self.assertEqual(record["first_seen"], "2026-09-01T00:00:00+00:00")
        self.assertEqual(
            record["canonical_url_collision_migration"]["merged_url_ids"],
            [self.legacy_id],
        )
        self.assertEqual(record["canonical_url_collision_migration"]["normalized_hash"], record["normalized_hash"])
        self.assertEqual(migrated["sources"]["unrelated"], original["sources"]["unrelated"])
        self.assertEqual(self.latest, original)
        self.assertTrue((self.data_dir / "snapshots" / "legacy.txt").is_file())

    def test_conflicting_normalized_hashes_are_reported_but_not_migrated(self):
        self.latest["sources"]["eba-test"][self.legacy_id]["normalized_hash"] = "different-hash"
        plans = self.module.audit_collisions(self.latest, self.configured_sources, self.data_dir)
        self.assertEqual(len(plans), 1)
        self.assertFalse(plans[0]["safe_to_migrate"])
        self.assertTrue(any("normalized content hash" in reason for reason in plans[0]["reasons"]))

        migrated, applied = self.module.migrate_collisions(self.latest, plans)
        self.assertEqual(applied, [])
        self.assertEqual(len(migrated["sources"]["eba-test"]), 2)

    def test_active_source_collision_is_never_migrated(self):
        active_source = SourceConfig.from_dict({
            "id": "eba-test",
            "name": "EBA test source",
            "regulator": "European Banking Authority",
            "active": True,
            "seed_urls": [self.preferred_url],
            "allowed_urls": [self.preferred_url],
            "allowed_prefixes": ["https://www.eba.europa.eu/"],
            "allowed_domains": ["www.eba.europa.eu"],
        })
        plans = self.module.audit_collisions(self.latest, {"eba-test": active_source}, self.data_dir)
        self.assertFalse(plans[0]["safe_to_migrate"])
        self.assertTrue(any("active-source inventory migration is prohibited" in reason for reason in plans[0]["reasons"]))
        migrated, applied = self.module.migrate_collisions(self.latest, plans)
        self.assertEqual(applied, [])
        self.assertEqual(len(migrated["sources"]["eba-test"]), 2)

    def test_missing_snapshot_or_distinct_pending_work_blocks_migration(self):
        record = self.latest["sources"]["eba-test"][self.legacy_id]
        record["snapshot_location"] = "data/snapshots/missing.txt"
        plans = self.module.audit_collisions(self.latest, self.configured_sources, self.data_dir)
        self.assertFalse(plans[0]["safe_to_migrate"])
        self.assertTrue(any("snapshots are missing" in reason for reason in plans[0]["reasons"]))

        record["snapshot_location"] = "data/snapshots/legacy.txt"
        self.latest["sources"]["eba-test"][self.preferred_id]["ai_pending"] = {"after_hash": "a"}
        record["ai_pending"] = {"after_hash": "b"}
        plans = self.module.audit_collisions(self.latest, self.configured_sources, self.data_dir)
        self.assertFalse(plans[0]["safe_to_migrate"])
        self.assertTrue(any("different pending AI work" in reason for reason in plans[0]["reasons"]))


if __name__ == "__main__":
    unittest.main()
