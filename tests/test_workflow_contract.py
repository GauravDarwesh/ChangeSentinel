import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
COMMIT_SCRIPT = ROOT / "scripts" / "commit_state.sh"


def monitor_workflow() -> str:
    return (WORKFLOWS / "regulatory-monitor.yml").read_text(encoding="utf-8")


def step_index(workflow: str, name: str) -> int:
    return workflow.index(f"- name: {name}")


class TestRegulatoryMonitorWorkflowContract(unittest.TestCase):
    def test_queued_production_run_checks_out_latest_main(self):
        workflow = monitor_workflow()
        start = workflow.index("- name: Checkout current main after concurrency queueing")
        end = workflow.index("- name: Setup Python", start)
        checkout = workflow[start:end]

        self.assertIn("cancel-in-progress: true", workflow)
        self.assertNotIn("queue: max", workflow)
        self.assertIn("ref: main", checkout)
        self.assertIn("possibly stale GITHUB_SHA", checkout)

    def test_alerts_are_queued_then_state_committed_before_any_delivery(self):
        workflow = monitor_workflow()
        queue = step_index(workflow, "Queue notifications")
        commit = step_index(workflow, "Commit monitoring state")
        deliver = step_index(workflow, "Publish notifications")
        record = step_index(workflow, "Commit notification delivery state")
        self.assertLess(step_index(workflow, "Validate monitoring state"), queue)
        self.assertLess(queue, commit)
        self.assertLess(commit, deliver)
        self.assertLess(deliver, record)

        queue_step = workflow[queue:commit]
        self.assertIn("python -m regmon.notify --enqueue-only", queue_step)
        # Paused continuations must still queue alerts for the sources that finished.
        self.assertIn("steps.crawl-status.outputs.paused != 'true'", queue_step)
        deliver_step = workflow[deliver:record]
        self.assertIn("python -m regmon.notify --deliver-only", deliver_step)
        self.assertIn("if:", deliver_step.split("run:", 1)[0])

    def test_state_commit_uses_the_guarded_data_only_helper(self):
        workflow = monitor_workflow()
        commit_step = workflow[step_index(workflow, "Commit monitoring state"):step_index(workflow, "Publish notifications")]
        self.assertIn("bash scripts/commit_state.sh", commit_step)
        self.assertIn("steps.base.outputs.sha", commit_step)
        script = COMMIT_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("refusing to rebase a generated state snapshot", script.lower())
        self.assertIn('git diff --name-only "$base_sha" origin/main -- "${pathspec[@]}"', script)
        # The monitor's state excludes Scout's directory, so the two never block each other.
        self.assertIn("pathspec=(data ':(exclude)data/scout' ':(exclude)data/reviews')", script)

    def test_failures_are_alerted_and_liveness_is_pinged(self):
        workflow = monitor_workflow()
        failure_step = workflow[step_index(workflow, "Alert on workflow failure"):]
        self.assertIn("if: ${{ failure() }}", failure_step)
        self.assertIn("https://ntfy.sh/$NTFY_TOPIC", failure_step)
        heartbeat = workflow[step_index(workflow, "Heartbeat ping"):step_index(workflow, "Alert on workflow failure")]
        self.assertIn("HEALTHCHECK_PING_URL", heartbeat)

    def test_pages_publish_only_after_a_commit(self):
        workflow = monitor_workflow()
        pages = workflow[step_index(workflow, "Publish latest monitoring data to Pages"):step_index(workflow, "Report paused crawl without auto-dispatching another run")]
        self.assertIn("steps.state-commit.outputs.committed == 'true'", pages)

    def test_workflows_pin_runner_image_and_action_commits(self):
        for path in sorted(WORKFLOWS.glob("*.yml")):
            text = path.read_text(encoding="utf-8")
            with self.subTest(workflow=path.name):
                self.assertNotIn("ubuntu-latest", text)
                for action in re.findall(r"uses:\s*(\S+)", text):
                    self.assertRegex(action, r"@[0-9a-f]{40}$", f"{action} must be pinned to a commit SHA")


    def test_bulk_registration_workflow_installs_small_dependency_and_queues_each_source(self):
        workflow = (WORKFLOWS / "register-monitor.yml").read_text(encoding="utf-8")
        for token in (
            "beautifulsoup4==4.14.3",
            "Preflight registration imports",
            "source_ids",
            "for SOURCE_ID in",
            "Bulk registration processed $COUNT unique links",
            "gh workflow run regulatory-monitor.yml",
        ):
            with self.subTest(token=token):
                self.assertIn(token, workflow)
        self.assertNotIn("pip install --disable-pip-version-check -r requirements.txt", workflow)



    def test_paused_discovery_does_not_auto_dispatch(self):
        workflow = monitor_workflow()
        self.assertNotIn("gh workflow run regulatory-monitor.yml", workflow)
        self.assertIn("Report paused crawl without auto-dispatching another run", workflow)
@unittest.skipIf(os.name == "nt", "bash helper")
class TestCommitStateHelper(unittest.TestCase):
    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.origin = root / "origin.git"
        self.seed = root / "seed"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.seed)], check=True, capture_output=True)
        for repo in (self.seed,):
            self.git(repo, "config", "user.email", "seed@example.test")
            self.git(repo, "config", "user.name", "seed")
        (self.seed / "data").mkdir()
        (self.seed / "data" / "state.json").write_text("1\n", encoding="utf-8")
        (self.seed / "app.py").write_text("code\n", encoding="utf-8")
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-q", "-m", "init")
        self.git(self.seed, "push", "-q", "origin", "main")

    def job_clone(self):
        job = Path(self.tmp.name) / "job"
        subprocess.run(["git", "clone", "-q", "--depth", "1", self.origin.as_uri(), str(job)], check=True, capture_output=True)
        self.git(job, "config", "user.email", "bot@example.test")
        self.git(job, "config", "user.name", "bot")
        return job, self.git(job, "rev-parse", "HEAD")

    def advance_origin(self, path, content):
        self.git(self.seed, "pull", "-q")
        (self.seed / path).write_text(content, encoding="utf-8")
        self.git(self.seed, "commit", "-q", "-am", f"change {path}")
        self.git(self.seed, "push", "-q", "origin", "main")

    def run_helper(self, job, base):
        output = Path(self.tmp.name) / "github-output"
        output.write_text("", encoding="utf-8")
        env = dict(os.environ, GITHUB_OUTPUT=str(output))
        result = subprocess.run(["bash", str(COMMIT_SCRIPT), "state", base], cwd=job, env=env, capture_output=True, text=True)
        return result, output.read_text(encoding="utf-8")

    def test_code_only_advance_is_rebased_and_pushed(self):
        job, base = self.job_clone()
        (job / "data" / "state.json").write_text("2\n", encoding="utf-8")
        self.advance_origin("app.py", "code v2\n")
        result, output = self.run_helper(job, base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("committed=true", output)
        self.git(self.seed, "pull", "-q")
        self.assertEqual((self.seed / "data" / "state.json").read_text(encoding="utf-8"), "2\n")
        self.assertEqual((self.seed / "app.py").read_text(encoding="utf-8"), "code v2\n")

    def test_competing_state_commit_is_refused(self):
        job, base = self.job_clone()
        (job / "data" / "state.json").write_text("2\n", encoding="utf-8")
        self.advance_origin("data/state.json", "from another run\n")
        result, output = self.run_helper(job, base)
        self.assertEqual(result.returncode, 1)
        self.assertIn("refusing to rebase a generated state snapshot", result.stdout)
        self.assertIn("committed=false", output)

    def test_no_changes_is_a_successful_no_op(self):
        job, base = self.job_clone()
        result, output = self.run_helper(job, base)
        self.assertEqual(result.returncode, 0)
        self.assertIn("committed=false", output)


class TestScoutWorkflowContract(unittest.TestCase):
    def test_add_monitor_option_updates_scout_config_and_starts_a_baseline(self):
        workflow = (WORKFLOWS / "register-monitor.yml").read_text(encoding="utf-8")
        register = workflow[workflow.index("- name: Register URL and commit source configuration"):
                            workflow.index("- name: Publish updated source configuration to Pages")]
        self.assertIn("--scout-config config/scout.json", register)
        self.assertIn("git diff --quiet -- config/sources.json config/scout.json", register)
        self.assertIn("git add config/sources.json config/scout.json", register)
        self.assertIn("SCOUT_REGULATOR_ID", register)
        initial = workflow[workflow.index("- name: Start initial Scout discovery baseline"):
                           workflow.index("- name: Confirm registration on the request")]
        self.assertIn("if: steps.register.outputs.scout_enabled == 'true'", initial)
        self.assertIn("gh workflow run scout.yml", initial)
        # The regular weekly schedule remains the source of future recrawls.
        scout = (WORKFLOWS / "scout.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "17 4 * * 1"', scout)


    def test_weekly_sweep_commits_only_scout_state_with_no_token_during_parsing(self):
        workflow = (WORKFLOWS / "scout.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "17 4 * * 1"', workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("group: scout", workflow)
        self.assertIn("queue: max", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("requests==2.34.2 beautifulsoup4==4.14.3", workflow)
        sweep = workflow.index("- name: Sweep regulator channels")
        validate = workflow.index("- name: Validate Scout state")
        commit = workflow.index("- name: Commit Scout state")
        self.assertLess(sweep, validate)
        self.assertLess(validate, commit)
        self.assertIn('bash scripts/commit_state.sh "Update Scout discovery state" "${{ steps.base.outputs.sha }}" data/scout', workflow)
        self.assertIn("steps.commit.outputs.committed == 'true'", workflow)
        self.assertIn("gh workflow run pages.yml", workflow)
        # Scout never touches monitoring configuration or monitoring state.
        for forbidden in ("config/sources.json", "regmon.monitor", "regmon.notify", "regulatory-monitor.yml"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, workflow)

    def test_review_decisions_are_owner_only_and_queue_behind_sweeps(self):
        workflow = (WORKFLOWS / "scout-review.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("startsWith(github.event.issue.title, '[ChangeSentinel] Scout review')", workflow)
        job = workflow[workflow.index("jobs:"):]
        self.assertIn("group: scout", job)
        self.assertIn("queue: max", job)
        self.assertIn('python -m regmon.scout review --event "$GITHUB_EVENT_PATH"', workflow)
        self.assertIn("git add -A -- data/scout", workflow)
        self.assertNotIn("pip install", workflow, "recording a decision needs only the standard library")


class TestScoutSourceWorkflowContract(unittest.TestCase):
    def test_source_requests_are_owner_only_validated_and_swept(self):
        workflow = (WORKFLOWS / "scout-source.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("startsWith(github.event.issue.title, '[ChangeSentinel] Scout source')", workflow)
        job = workflow[workflow.index("jobs:"):]
        self.assertIn("group: scout", job)
        self.assertIn("queue: max", job)
        apply = workflow.index('python -m regmon.scout source --event "$GITHUB_EVENT_PATH"')
        self.assertLess(apply, workflow.index("python -m regmon.scout validate"))
        self.assertIn("git add -A -- config/scout.json data/scout", workflow)
        self.assertIn('gh workflow run scout.yml --repo "$GITHUB_REPOSITORY" --ref main -f regulator="$REGULATOR"', workflow)
        self.assertNotIn("config/sources.json", workflow)
        self.assertNotIn("pip install", workflow)


class TestAIEvaluationWorkflowContract(unittest.TestCase):
    def test_ai_evaluation_runs_on_same_repository_prs_with_both_gates(self):
        workflow = (ROOT / ".github" / "workflows" / "ai-smoke-test.yml").read_text(encoding="utf-8")
        self.assertIn("pull_request:", workflow)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", workflow)
        pull_request_trigger = workflow[workflow.index("  pull_request:"):workflow.index("  push:")]
        self.assertNotIn("paths:", pull_request_trigger)
        self.assertIn("Check whether this PR changes AI-relevant files", workflow)
        self.assertIn("gh api --paginate", workflow)
        self.assertIn("steps.ai-scope.outputs.relevant == 'true'", workflow)
        self.assertEqual(workflow.count("- name: Score end-to-end relevance and free-router stability"), 1)
        self.assertEqual(workflow.count('<<< "$changed_files"; then'), 1)
        self.assertIn("python scripts/ai_eval.py --min-accuracy 0.8 --min-model-accuracy 0.8 --min-model-agreement 0.8 --min-model-cases 12 --repeats 2", workflow)
        self.assertIn('AI_TIMEOUT_SECONDS: "20"', workflow)
        self.assertIn('AI_ATTEMPTS: "2"', workflow)
        self.assertIn('AI_EVAL_REPEATS: "2"', workflow)
        self.assertIn("cancel-in-progress: true", workflow)
        self.assertIn('"scripts/ai_eval_cases.json"', workflow)


if __name__ == "__main__":
    unittest.main()
