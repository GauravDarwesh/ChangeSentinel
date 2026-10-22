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


class TestAskSentinelLiveEvalExit(unittest.TestCase):
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
