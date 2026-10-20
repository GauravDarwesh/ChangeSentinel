"""Evaluate end-to-end regulatory relevance decisions on known cases.

Historical parser-artifact events are passed through the deterministic extraction-drift
guard first, matching the production engine. Only source changes that survive that
guard are sent to semantic AI. The report includes both end-to-end and model-only
accuracy so deterministic suppressions cannot be mistaken for model performance.

Usage: OPENROUTER_API_KEY=... python scripts/ai_eval.py [--min-accuracy 0.8] [--min-model-accuracy 0.8]
Exit status 1 when either accuracy threshold is missed or the key is missing.
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
from regmon.engine import is_extraction_drift  # noqa: E402

CASES = Path(__file__).with_name("ai_eval_cases.json")
EXPECTED_DECISION_SOURCES = frozenset({"ai_model", "deterministic_extraction_drift_guard"})


def validate_case(case: object, index: int | None = None) -> dict:
    """Fail closed when a fixture omits or corrupts expected evaluation metadata."""
    label = f"Case {index}" if index is not None else "Evaluation case"
    if not isinstance(case, dict):
        raise ValueError(f"{label} must be a JSON object")
    raw_id = case.get("id")
    if not isinstance(raw_id, str) or not raw_id.strip():
        raise ValueError(f"{label} id must be a non-empty string")
    case_id = raw_id.strip()
    label = f"Case {case_id}"
    if type(case.get("expected_relevant")) is not bool:
        raise ValueError(f"{label} expected_relevant must be a boolean")
    expected_source = case.get("expected_decision_source")
    if not isinstance(expected_source, str) or expected_source not in EXPECTED_DECISION_SOURCES:
        allowed = ", ".join(sorted(EXPECTED_DECISION_SOURCES))
        raise ValueError(f"{label} expected_decision_source must be one of: {allowed}")
    return case


def validate_cases(cases: object) -> list[dict]:
    """Validate the complete fixture set before performing any paid/model calls."""
    if not isinstance(cases, list) or not cases:
        raise ValueError("AI evaluation fixture must contain a non-empty cases list")
    validated = []
    seen_ids = set()
    for index, candidate in enumerate(cases, start=1):
        case = validate_case(candidate, index)
        case_id = case["id"].strip()
        if case_id in seen_ids:
            raise ValueError(f"Duplicate AI evaluation case id: {case_id}")
        seen_ids.add(case_id)
        validated.append(case)
    return validated


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
    """Use the production extraction-drift predicate on immutable evidence.

    Legacy evidence predates explicit extraction-state metadata, while new
    evidence records whether either extraction had failed. The compatibility
    path restores only metadata that is implied by the saved HTML signature.
    """
    if not isinstance(evidence, dict):
        return None
    before = evidence.get("before")
    after = evidence.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None

    guard_before = dict(before)
    guard_after = dict(after)
    for record in (guard_before, guard_after):
        # Historical evidence only stored this signature for HTML records.
        if not record.get("extraction_type") and record.get("html_comparison_hash"):
            record["extraction_type"] = "html"
    if guard_before.get("extraction_failed") is True:
        guard_before["extraction_error"] = "Previous extraction failed"

    if not is_extraction_drift(guard_before, guard_after):
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
    case = validate_case(case)
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
    source_correct = decision_source == expected_source
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



def threshold_failures(
    *,
    accuracy: float,
    model_accuracy: float | None,
    model_case_count: int,
    min_accuracy: float,
    min_model_accuracy: float,
    decision_source_failures: int = 0,
) -> list[str]:
    """Keep aggregate accuracy from hiding model or decision-routing regressions."""
    failures = []
    if decision_source_failures:
        failures.append(
            f"{decision_source_failures} case(s) used a decision source different from the expected pipeline"
        )
    if accuracy < min_accuracy:
        failures.append(
            f"End-to-end relevance accuracy {accuracy:.1%} is below the {min_accuracy:.1%} threshold"
        )
    if model_case_count <= 0:
        failures.append("No evaluation cases reached semantic AI; model-only quality could not be measured")
    elif model_accuracy is None or model_accuracy < min_model_accuracy:
        value = "unavailable" if model_accuracy is None else f"{model_accuracy:.1%}"
        failures.append(
            f"Semantic-AI-only relevance accuracy {value} is below the {min_model_accuracy:.1%} threshold"
        )
    return failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--min-accuracy", type=float, default=0.8, help="Minimum end-to-end pipeline accuracy")
    parser.add_argument("--min-model-accuracy", type=float, default=0.8, help="Minimum semantic-AI-only accuracy")
    args = parser.parse_args()
    if not 0.0 <= args.min_accuracy <= 1.0:
        parser.error("--min-accuracy must be between 0 and 1")
    if not 0.0 <= args.min_model_accuracy <= 1.0:
        parser.error("--min-model-accuracy must be between 0 and 1")
    try:
        payload = json.loads(CASES.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("AI evaluation fixture must be a JSON object")
        cases = validate_cases(payload.get("cases"))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise SystemExit(f"Invalid AI evaluation fixture: {exc}") from exc

    if not os.getenv("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY is required for the AI evaluation")

    config = AIConfig(
        timeout_seconds=int(os.getenv("AI_TIMEOUT_SECONDS", "60")),
        attempts=int(os.getenv("AI_ATTEMPTS", "2")),
        model=os.getenv("OPENROUTER_MODEL", "openrouter/free"),
    )
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
        "decision_source_mismatches": sum(
            1 for row in rows
            if row["expected_decision_source"] and not row["decision_source_correct"]
        ),
        "model_only": {
            "accuracy": round(model_accuracy, 3) if model_accuracy is not None else None,
            "correct": model_correct,
            "total": len(model_rows),
        },
        "cases": rows,
    }, indent=2))
    failures = threshold_failures(
        accuracy=accuracy,
        model_accuracy=model_accuracy,
        model_case_count=len(model_rows),
        min_accuracy=args.min_accuracy,
        min_model_accuracy=args.min_model_accuracy,
        decision_source_failures=sum(
            1 for row in rows
            if row["expected_decision_source"] and not row["decision_source_correct"]
        ),
    )
    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
