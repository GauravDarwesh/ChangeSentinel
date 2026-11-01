import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "ask_sentinel_live_eval",
    ROOT / "scripts" / "ask_sentinel_live_eval.py",
)
assert SPEC is not None and SPEC.loader is not None
live_eval = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live_eval)


class TestAskSentinelLiveEvalClassification(unittest.TestCase):
    def test_citation_validation_rejection_is_a_grounding_failure(self):
        response = {
            "http_status": 422,
            "error_code": "citation_validation_failed",
            "citation_validation": {"reason": "unapproved_source"},
            "error": "I could not verify the generated answer against the retrieved source citations.",
        }
        self.assertTrue(live_eval.is_citation_rejection(response))
        self.assertFalse(live_eval.is_unavailable_response(response))

    def test_legacy_502_citation_rejection_is_not_inconclusive(self):
        # The currently deployed function may not return error_code until the backend is deployed.
        response = {
            "http_status": 502,
            "error": "I could not verify the generated answer against the retrieved source citations. Please retry.",
        }
        self.assertTrue(live_eval.is_citation_rejection(response))
        self.assertFalse(live_eval.is_unavailable_response(response))

    def test_provider_failure_is_inconclusive_not_a_grounding_failure(self):
        response = {
            "http_status": 503,
            "error_code": "provider_unavailable",
            "error": "Ask Sentinel could not complete the AI request. Please retry.",
        }
        self.assertFalse(live_eval.is_citation_rejection(response))
        self.assertTrue(live_eval.is_unavailable_response(response))

    def test_generic_legacy_502_remains_inconclusive(self):
        response = {
            "http_status": 502,
            "error": "Ask Sentinel could not complete the AI request. Please retry.",
        }
        self.assertFalse(live_eval.is_citation_rejection(response))
        self.assertTrue(live_eval.is_unavailable_response(response))

    def test_backend_uses_stable_error_codes_and_does_not_log_provider_body(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        evaluator = (ROOT / "scripts/ask_sentinel_live_eval.py").read_text(encoding="utf-8")
        self.assertIn("error_code: 'citation_validation_failed'", backend)
        self.assertIn("error_code: errorCode", backend)
        self.assertIn("citation_validation_failed", backend)
        self.assertIn("422", backend)
        self.assertIn("logStage('provider_failed'", backend)
        self.assertIn('"error_code": str(response.get("error_code")', evaluator)
        self.assertNotIn("ANSWER EXCERPT:", evaluator)
        self.assertNotIn('"answer_excerpt"', evaluator)

    def _run_case_with(self, response):
        results = []
        original = live_eval.ask
        live_eval.ask = lambda _question: response
        try:
            live_eval.run_case(results, "case", "question", lambda _response, _answer: (False, "facts missing"))
        finally:
            live_eval.ask = original
        return results[0]

    def test_evidence_only_fallback_is_inconclusive_not_a_grounding_failure(self):
        # Seen on 28 Oct: OpenRouter failed and the backend answered HTTP 200 with
        # evidence links only; the evaluator graded that text and failed the run.
        response = {
            "http_status": 200,
            "answer": "I could not complete the AI answer. These retrieved records may help: [Source: data/report.json]",
            "model": "evidence-fallback",
            "evidence_fallback": True,
        }
        self.assertTrue(live_eval.is_evidence_fallback(response))
        self.assertIsNone(self._run_case_with(response)["passed"])

    def test_a_real_answer_is_still_graded(self):
        response = {"http_status": 200, "answer": "Run 1 changed 2 URLs.", "model": "openrouter/free"}
        self.assertFalse(live_eval.is_evidence_fallback(response))
        self.assertIs(self._run_case_with(response)["passed"], False)

    def test_health_workflow_checks_remaining_against_the_warm_up(self):
        workflow = (ROOT / ".github/workflows/ask-sentinel-health.yml").read_text(encoding="utf-8")
        self.assertNotIn("not in (2, 999)", workflow)
        self.assertIn("expected_after = before - 1", workflow)

    def test_a_grounding_failure_fails_the_run(self):
        with self.assertRaises(SystemExit):
            live_eval.exit_status(passed=5, failed=1, inconclusive=0)

    def test_one_provider_outage_among_grounded_answers_only_warns(self):
        self.assertEqual(live_eval.exit_status(passed=5, failed=0, inconclusive=1), 0)

    def test_a_run_that_evaluated_nothing_fails(self):
        with self.assertRaises(SystemExit):
            live_eval.exit_status(passed=0, failed=0, inconclusive=6)


if __name__ == "__main__":
    unittest.main()


class TestConfiguredSourceScopeCase(unittest.TestCase):
    """The scope case asks for counts, every inactive ID and a sample of active IDs:
    with 200+ monitors an exhaustive list was not a fair test of grounding."""

    def checks(self):
        captured = {}
        original = live_eval.run_case
        live_eval.run_case = lambda results, name, question, check: captured.setdefault(name, (question, check))
        try:
            live_eval.main()
        except SystemExit:
            pass
        finally:
            live_eval.run_case = original
        return captured

    def test_counts_inactive_ids_and_a_sample(self):
        import json
        sources = json.loads((ROOT / "config" / "sources.json").read_text())["sources"]
        active = sorted(s["id"] for s in sources if s.get("active", True) is not False)
        inactive = sorted(s["id"] for s in sources if s.get("active", True) is False)
        question, check = self.checks()["configured-source-scope"]
        self.assertIn("How many configured sources are active", question)
        good = (f"config/sources.json has {len(active)} active sources and {len(inactive)} with active=false (inactive): "
                + ", ".join(inactive) + ". Five active: " + ", ".join(active[:5]) + ".")
        self.assertEqual(check(None, good)[0], True, check(None, good)[1])
        self.assertFalse(check(None, good.replace(str(len(active)), str(len(active) + 1)))[0])
        if inactive:
            self.assertFalse(check(None, good.replace(inactive[0], "something-else"))[0])
        self.assertFalse(check(None, f"{len(active)} active and {len(inactive)} inactive: " + ", ".join(inactive) + " (inactive).")[0])
        self.assertFalse(check(None, "")[0])
