"""Evaluate end-to-end regulatory relevance decisions on known cases.

Historical parser-artifact events are passed through the deterministic extraction-drift
guard first, matching the production engine. Only source changes that survive that
guard are sent to semantic AI. The report includes both end-to-end and model-only
accuracy so deterministic suppressions cannot be mistaken for model performance.

Usage: OPENROUTER_API_KEY=... python scripts/ai_eval.py [--min-accuracy 0.8]
Exit status 1 when end-to-end accuracy is below the threshold or the key is missing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from regmon.ai import AIConfig, analyze  # noqa: E402

CASES = Path(__file__).with_name("ai_eval_cases.json")


def load_evidence(case: dict) -> dict | None:
    """Load the immutable event evidence for cases backed by a real observation."""
    relative_path = case.get("evidence")
    if not relative_path:
        return None
    evidence = json.loads((ROOT / relative_path).read_text(encoding="utf-8"))
    if not isinstance(evidence, dict):
        raise ValueError(f"Evidence for case {case.get('id')} is not a JSON object")
    return evidence


def load_case(case: dict) -> tuple[str, str, str]:
    evidence = load_evidence(case)
    if evidence is not None:
        return evidence["url"], evidence.get("event_type", "CHANGED_URL"), evidence.get("diff", "")
    return case["url"], case.get("event", "CHANGED_URL"), case["diff"]


def extraction_drift_reason(evidence: dict | None) -> str | None:
    """Mirror the engine's deterministic guard for historical evidence.

    If the normalized text changed while the exact source bytes or the stable HTML
    comparison signature remained identical, the observation is extraction drift,
    not a regulatory change. Such evidence must never be sent to semantic AI.
    """
    if not isinstance(evidence, dict):
        return None
    before = evidence.get("before")
    after = evidence.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None

    before_normalized = before.get("normalized_hash")
    after_normalized = after.get("normalized_hash")
    if not before_normalized or not after_normalized or before_normalized == after_normalized:
        return None

    before_raw = before.get("raw_hash") or before.get("content_hash")
    after_raw = after.get("raw_hash") or after.get("content_hash")
    if before_raw and after_raw and before_raw == after_raw:
        return "identical source bytes with changed normalized extraction"

    before_html = before.get("html_comparison_hash")
    after_html = after.get("html_comparison_hash")
    if before_html and after_html and before_html == after_html:
        return "identical HTML comparison signature with changed normalized extraction"
    return None


def evaluate_case(case: dict, config: AIConfig) -> dict:
    """Return one auditable end-to-end decision and its source."""
    url, event, diff = load_case(case)
    evidence = load_evidence(case)
    drift_reason = extraction_drift_reason(evidence)

    if drift_reason:
        verdict = False
        status = "suppressed"
        decision_source = "deterministic_extraction_drift_guard"
        reason = drift_reason
    else:
        result = analyze(
            "Board of Governors of the Federal Reserve System",
            url,
            event,
            diff,
            diff,
            config,
        )
        status = result.get("status", "unknown")
        verdict = result.get("analysis", {}).get("relevant") if status == "ok" else None
        decision_source = "ai_model"
        analysis = result.get("analysis") if isinstance(result.get("analysis"), dict) else {}
        reason = analysis.get("reason") or result.get("reason") or "AI did not return a usable relevance verdict"

    verdict_correct = verdict is case["expected_relevant"]
    expected_source = case.get("expected_decision_source")
    source_correct = not expected_source or decision_source == expected_source
    return {
        "id": case["id"],
        "expected": case["expected_relevant"],
        "got": verdict,
        "status": status,
        "decision_source": decision_source,
        "expected_decision_source": expected_source,
        "reason": reason,
        "verdict_correct": verdict_correct,
        "decision_source_correct": source_correct,
        "correct": verdict_correct and source_correct,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--min-accuracy", type=float, default=0.8)
    args = parser.parse_args()
    if not os.getenv("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY is required for the AI evaluation")

    config = AIConfig(
        timeout_seconds=int(os.getenv("AI_TIMEOUT_SECONDS", "60")),
        attempts=int(os.getenv("AI_ATTEMPTS", "2")),
        model=os.getenv("OPENROUTER_MODEL", "openrouter/free"),
    )
    cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
    rows = [evaluate_case(case, config) for case in cases]
    correct = sum(row["correct"] for row in rows)
    accuracy = correct / max(1, len(rows))
    model_rows = [row for row in rows if row["decision_source"] == "ai_model"]
    model_correct = sum(row["verdict_correct"] for row in model_rows)
    model_accuracy = model_correct / len(model_rows) if model_rows else None
    suppressed = sum(row["decision_source"] == "deterministic_extraction_drift_guard" for row in rows)

    print(json.dumps({
        "model": config.model,
        "decision_pipeline": "deterministic extraction-drift guard followed by semantic AI",
        "accuracy": round(accuracy, 3),
        "correct": correct,
        "total": len(rows),
        "deterministic_extraction_drift_suppressions": suppressed,
        "model_only": {
            "accuracy": round(model_accuracy, 3) if model_accuracy is not None else None,
            "correct": model_correct,
            "total": len(model_rows),
        },
        "cases": rows,
    }, indent=2))
    if accuracy < args.min_accuracy:
        raise SystemExit(
            f"End-to-end relevance accuracy {accuracy:.1%} is below the {args.min_accuracy:.1%} threshold"
        )


if __name__ == "__main__":
    main()
