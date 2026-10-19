"""Score the configured AI model on known relevant / not-relevant changes.

The negative cases are the 15 CHANGED_URL alerts delivered on 18-19 Oct 2026
that were parser artifacts; the model rated all of them "relevant". Run this
after any prompt, model or provider change (assessment M-02, E-02).

Usage: OPENROUTER_API_KEY=... python scripts/ai_eval.py [--min-accuracy 0.8]
Exit status 1 when accuracy is below the threshold or the key is missing.
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


def load_case(case: dict) -> tuple[str, str, str]:
    if case.get("evidence"):
        evidence = json.loads((ROOT / case["evidence"]).read_text(encoding="utf-8"))
        return evidence["url"], evidence.get("event_type", "CHANGED_URL"), evidence.get("diff", "")
    return case["url"], case.get("event", "CHANGED_URL"), case["diff"]


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
    rows, correct = [], 0
    for case in json.loads(CASES.read_text(encoding="utf-8"))["cases"]:
        url, event, diff = load_case(case)
        result = analyze("Board of Governors of the Federal Reserve System", url, event, diff, diff, config)
        verdict = result.get("analysis", {}).get("relevant") if result.get("status") == "ok" else None
        hit = verdict is case["expected_relevant"]
        correct += hit
        rows.append({"id": case["id"], "expected": case["expected_relevant"], "got": verdict,
                     "status": result.get("status"), "correct": hit})
    accuracy = correct / max(1, len(rows))
    print(json.dumps({"model": config.model, "accuracy": round(accuracy, 3), "cases": rows}, indent=2))
    if accuracy < args.min_accuracy:
        raise SystemExit(f"AI accuracy {accuracy:.0%} is below the {args.min_accuracy:.0%} threshold")


if __name__ == "__main__":
    main()
