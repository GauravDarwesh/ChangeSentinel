import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TestRegulatoryMonitorWorkflowContract(unittest.TestCase):
    def test_queued_production_run_checks_out_latest_main(self):
        workflow = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text(encoding="utf-8")
        start = workflow.index("- name: Checkout current main after concurrency queueing")
        end = workflow.index("- name: Setup Python", start)
        checkout = workflow[start:end]

        self.assertIn("queue: max", workflow)
        self.assertIn("ref: main", checkout)
        self.assertIn("possibly stale GITHUB_SHA", checkout)

    def test_state_commit_does_not_rebase_generated_snapshot(self):
        workflow = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text(encoding="utf-8")
        start = workflow.index("- name: Commit monitoring state")
        end = workflow.index("- name: Continue paused crawl", start)
        commit_step = workflow[start:end]

        self.assertIn("refusing to rebase a generated state snapshot", commit_step.lower())
        self.assertNotIn("git rebase origin/main", commit_step)


if __name__ == "__main__":
    unittest.main()
