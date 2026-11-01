"""Operations fixes of 1 Nov 2026: scan starts every three hours, nothing-due runs skip the
scanner, migration files carry the recorded versions, and rls_auto_enable is not callable."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from regmon import schedule

ROOT = Path(__file__).resolve().parent.parent


class ScheduleTest(unittest.TestCase):
    def test_workflow_starts_every_three_hours_and_plans_first(self):
        text = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text()
        self.assertIn('cron: "23 */3 * * *"', text)
        self.assertNotIn('cron: "0 */6 * * *"', text)
        self.assertIn("python3 -m regmon.schedule --due", text)
        self.assertIn("needs: plan", text)
        self.assertIn("!cancelled() && (github.event_name != 'schedule' || needs.plan.outputs.due != '0')", text)
        self.assertNotIn("always()", text.split("monitor:", 1)[1].split("steps:", 1)[0])

    def test_due_now_matches_the_engine_and_runs_on_a_sparse_checkout(self):
        config = json.loads((ROOT / "config" / "sources.json").read_text())
        reports = ROOT / "data" / "reports"
        last = max(schedule.parse_time(json.loads(path.read_text()).get("generated_at")) for path in reports.glob("*.json"))
        same_slot = schedule.slot_start(last) + timedelta(hours=3, minutes=23)
        next_slot = schedule.slot_start(last) + timedelta(hours=6, minutes=23)
        from regmon import engine
        from regmon.config import load_config

        _, sources = load_config(ROOT / "config" / "sources.json")
        active = [source for source in sources.values() if source.active]
        for now in (same_slot, next_slot):
            with self.subTest(now=now.isoformat()):
                due, _ = engine.due_sources(active, now, ROOT / "data")
                self.assertEqual(sorted(schedule.due_now(config, ROOT / "data", now)), sorted(source.id for source in due))
        self.assertGreater(len(schedule.due_now(config, ROOT / "data", next_slot)), 100)
        with tempfile.TemporaryDirectory() as tmp:
            for part in ("config", "regmon", "data/reports", "data/discovery"):
                shutil.copytree(ROOT / part, Path(tmp) / part)
            out = Path(tmp) / "out"
            result = subprocess.run([sys.executable, "-m", "regmon.schedule", "--due", "--github-output", str(out)], cwd=tmp,
                                    capture_output=True, text=True, timeout=60, check=True)
            self.assertIn("due_monitors=", result.stdout)
            self.assertRegex(out.read_text(), r"^due=\d+\n$")


class MigrationsTest(unittest.TestCase):
    RECORDED = ["20261020100010", "20261020115225", "20261021143135", "20261022040127"]

    def test_files_carry_the_recorded_versions_and_are_unique(self):
        versions = [path.name.split("_", 1)[0] for path in sorted((ROOT / "supabase" / "migrations").glob("*.sql"))]
        self.assertEqual(len(versions), len(set(versions)))
        self.assertEqual(versions[:4], self.RECORDED)
        self.assertIn("20261101100000", versions)

    def test_rls_auto_enable_is_not_callable_over_the_api(self):
        sql = (ROOT / "supabase" / "migrations" / "20261101100000_revoke_rls_auto_enable.sql").read_text()
        self.assertIn("revoke execute on function public.rls_auto_enable() from public, anon, authenticated;", sql)
        ops = (ROOT / "docs" / "OPERATIONS.md").read_text()
        self.assertIn("supabase migration repair --status applied 20261027120000 20261027160000 20261031180000", ops)


if __name__ == "__main__":
    unittest.main()
