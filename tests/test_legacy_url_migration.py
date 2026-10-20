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
        # The next scan may discover the alternate query order. It must resolve
        # to the migrated survivor rather than report the duplicate as removed.
        from regmon.engine import resolve_previous
        resolved_id, resolved_record = resolve_previous(
            self.reversed_url, migrated["sources"]["eba-test"]
        )
        self.assertEqual(resolved_id, self.preferred_id)
        self.assertEqual(resolved_record["normalized_hash"], record["normalized_hash"])
        self.assertEqual(self.latest, original)
        self.assertTrue((self.data_dir / "snapshots" / "legacy.txt").is_file())

    def test_historical_new_removed_query_order_pair_is_surfaced_by_audit(self):
        evidence_dir = self.data_dir / "evidence"
        evidence_dir.mkdir()
        (evidence_dir / "a431099f2de955a79fffe1262db8da5099eb7821cfed11a784dd53fc8994a42e.json").write_text(
            json.dumps({
                "event_id": "a431099f2de955a79fffe1262db8da5099eb7821cfed11a784dd53fc8994a42e",
                "event_type": "NEW_URL",
                "url": self.preferred_url,
                "timestamp": "2026-09-23T16:33:35+00:00",
            }),
            encoding="utf-8",
        )
        (evidence_dir / "f1126207731898f9066089114d3212c305a84a854acd0647fa31f882912a834e.json").write_text(
            json.dumps({
                "event_id": "f1126207731898f9066089114d3212c305a84a854acd0647fa31f882912a834e",
                "event_type": "REMOVED_URL",
                "url": self.reversed_url,
                "timestamp": "2026-09-23T16:33:35+00:00",
            }),
            encoding="utf-8",
        )

        collisions = self.module.audit_historical_evidence_collisions(
            self.latest, self.data_dir, source_filter="eba-test"
        )
        self.assertEqual(len(collisions), 1)
        self.assertEqual(collisions[0]["source_ids_in_current_inventory"], ["eba-test"])
        self.assertEqual(set(collisions[0]["event_types"]), {"NEW_URL", "REMOVED_URL"})
        self.assertEqual(set(collisions[0]["url_variants"]), {self.preferred_url, self.reversed_url})
        self.assertEqual(len(collisions[0]["evidence"]), 2)

    def test_committed_eba_history_surfaces_the_known_query_order_pair(self):
        repo_root = Path(__file__).resolve().parents[1]
        latest = json.loads((repo_root / "data" / "latest.json").read_text(encoding="utf-8"))
        data_dir = repo_root / "data"
        canonical_url = self.module.canonical(
            "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/"
            "consumer-protection/guidelines-product-oversight-and-governance-arrangements-retail-banking-products"
            "?phase=consultation&version=2015"
        )

        current_records = [
            record for record in latest["sources"]["eba-consumer-protection"].values()
            if self.module.canonical(record.get("canonical_url", "")) == canonical_url
        ]
        self.assertEqual(len(current_records), 1, "the live inventory should have one authoritative record for this canonical URL")

        historical = self.module.audit_historical_evidence_collisions(
            latest, data_dir, source_filter="eba-consumer-protection"
        )
        target = next(
            (entry for entry in historical if entry["canonical_url"] == canonical_url),
            None,
        )
        self.assertIsNotNone(target, "dry-run should surface the historical NEW_URL/REMOVED_URL collision")
        event_ids = {entry["event_id"] for entry in target["evidence"]}
        self.assertIn("a431099f2de955a79fffe1262db8da5099eb7821cfed11a784dd53fc8994a42e", event_ids)
        self.assertIn("f1126207731898f9066089114d3212c305a84a854acd0647fa31f882912a834e", event_ids)

    def test_unconfigured_legacy_source_can_be_audited_without_reactivating_it(self):
        plans = self.module.audit_collisions(self.latest, {}, self.data_dir, source_filter="eba-test")
        self.assertEqual(len(plans), 1)
        self.assertTrue(plans[0]["safe_to_migrate"], plans[0]["reasons"])
        self.assertFalse(plans[0]["source_active"])
        self.assertEqual(plans[0]["survivor_url_id"], self.preferred_id)

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
