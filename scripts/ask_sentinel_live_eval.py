#!/usr/bin/env python3
"""Live Ask Sentinel grounding evaluation against committed dashboard facts.

This intentionally calls the deployed Edge Function. It is a baseline/live-deployment
check, not a local unit test of the code currently present in a pull request.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = os.environ["ASK_SENTINEL_URL"].rstrip("/")
PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]


def load_json(path: str) -> Any:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def ask(question: str) -> dict[str, Any]:
    # The deployed Groq model has an 8k-token/minute quota. The preceding workflow smoke
    # question plus six rapid evaluation calls exceeded TPM, masking real grounding results.
    # Pace requests to stay within that provider quota instead of misreporting 429 as hallucination.
    time.sleep(50)
    payload = json.dumps({"question": question, "conversation": []}).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        method="POST",
        headers={
            "apikey": PUBLISHABLE_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Fresh visitor per case: each evaluation question gets its own daily quota.
            "x-ask-sentinel-visitor-id": str(uuid.uuid4()),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = json.loads(response.read().decode("utf-8"))
            return {"http_status": response.status, **body}
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8", "replace"))
        except Exception:
            body = {"error": "non-JSON HTTP error"}
        return {"http_status": error.code, **body}
    except Exception as error:
        return {"http_status": "ERROR", "error": type(error).__name__ + ": " + str(error)[:180]}


def count_mentioned(text: str, field: str, expected: Any) -> bool:
    aliases = {
        "changed": ["changed"],
        "source_changed": ["source_changed", "source changed", "source-level change", "source level change"],
        "unchanged": ["unchanged"],
        "fetch_error": ["fetch_error", "fetch error", "fetch errors"],
        "extraction_error": ["extraction_error", "extraction error", "extraction errors"],
        "new": ["new"],
    }[field]
    escaped_value = re.escape(str(expected))
    for alias in aliases:
        label = re.escape(alias).replace(r"\ ", r"\s+")
        patterns = (
            rf"(?is)\b{label}\b[^\n]{{0,70}}\b{escaped_value}\b",
            rf"(?is)\b{escaped_value}\b[^\n]{{0,70}}\b{label}\b",
        )
        if any(re.search(pattern, text) for pattern in patterns):
            return True
    return False


def run_case(results: list[dict[str, Any]], name: str, question: str, check) -> None:
    response = ask(question)
    answer = str(response.get("answer") or "")
    status = response.get("http_status")
    # Provider/runtime failures are unavailable evidence, not hallucinations. Keep them visible
    # as inconclusive and still fail the strict post-deployment gate, but do not mislabel them
    # as bad factual answers.
    unavailable = status == "ERROR" or (
        isinstance(status, int) and status in {429, 500, 502, 503, 504}
    )
    if not answer and unavailable:
        passed = None
        detail = "provider/endpoint unavailable; grounding could not be evaluated: " + str(response.get("error") or "no answer")[:200]
    else:
        try:
            checked, detail = check(response, answer)
            passed = bool(checked)
        except Exception as error:
            passed = False
            detail = "evaluation error: " + type(error).__name__ + ": " + str(error)[:160]
    results.append({
        "name": name,
        "passed": passed,
        "detail": str(detail),
        "http_status": status,
        "answer_excerpt": (answer or str(response.get("error") or ""))[:1300],
    })


def main() -> int:
    report = load_json("data/report.json")
    source_config = load_json("config/sources.json")
    history = load_json("data/history/index.json")
    run_id = str(report.get("run_id") or "")
    if not run_id:
        raise SystemExit("Evaluation refused: data/report.json has no run ID.")

    config = {str(source.get("id")): source for source in source_config.get("sources", [])}
    active_ids = sorted(key for key, source in config.items() if source.get("active") is True)
    inactive_ids = sorted(key for key, source in config.items() if source.get("active") is not True)
    counts = report.get("counts") or {}
    current_events = report.get("events") or []
    first_event = next((event for event in current_events if event.get("evidence_location")), None)
    evidence_path = str(first_event.get("evidence_location")) if first_event else ""
    evidence = load_json(evidence_path) if evidence_path else {}
    historical = next(
        (
            row for row in history
            if row.get("run_id") != run_id
            and row.get("source_id") in active_ids
            and isinstance(row.get("counts"), dict)
        ),
        None,
    )

    results: list[dict[str, Any]] = []

    latest_question = (
        "From the committed ChangeSentinel records, summarize exact monitoring run " + run_id
        + ". State exact values for changed, source_changed, unchanged, fetch_error and extraction_error. "
        + "Identify any affected source ID. Distinguish content changes from source-level changes; do not substitute another run."
    )

    def check_latest(_response, answer):
        required = ["changed", "source_changed", "unchanged", "fetch_error", "extraction_error"]
        missing = [field for field in required if field not in counts or not count_mentioned(answer, field, counts[field])]
        normalize_id_text = lambda value: re.sub(r"[\u2010-\u2015\u2212]", "-", value)
        if normalize_id_text(run_id) not in normalize_id_text(answer):
            return False, "exact current run ID missing (allowing typographic hyphens)"
        event_source = str((current_events[0] if current_events else {}).get("source_id") or "")
        if event_source and event_source not in answer:
            return False, "affected source ID missing: " + event_source
        return not missing, "missing or incorrect count labels: " + ", ".join(missing) if missing else "run ID, counters and source identified"

    run_case(results, "latest-run-facts", latest_question, check_latest)

    active_question = (
        "Use config/sources.json as the authority. List every source ID with active=true and every source ID with active=false, "
        + "using exact IDs. Do not classify leftover data/latest.json registry rows as currently configured active sources."
    )

    def check_scope(_response, answer):
        missing_active = [source_id for source_id in active_ids if source_id not in answer]
        missing_inactive = [source_id for source_id in inactive_ids if source_id not in answer]
        if missing_active or missing_inactive:
            return False, "missing active IDs=" + str(missing_active) + "; missing inactive IDs=" + str(missing_inactive)
        if inactive_ids and not re.search(r"inactive|archived|active=false|not active", answer, re.I):
            return False, "inactive sources were not clearly distinguished"
        stale_id = "eba-consumer-protection"
        if stale_id in answer:
            pos = answer.lower().find(stale_id)
            nearby = answer[max(0, pos - 100):pos + 180].lower()
            if not any(mark in nearby for mark in ("not configured", "inactive", "archived", "legacy", "not active", "unconfigured")):
                return False, "stale EBA registry ID was not labeled non-active"
        return True, "configured active and inactive source IDs distinguished"

    run_case(results, "configured-source-scope", active_question, check_scope)

    eba_question = (
        "The source eba-full-site is active and was scanned in run " + run_id
        + ". How many URLs changed in that run? Check config/sources.json active status and source_runs first; correct the premise if false."
    )

    def check_eba(_response, answer):
        if not answer:
            return False, "no answer returned"
        acknowledged = re.search(
            r"inactive|archived|not active|not currently monitored|not in (?:the )?current scope|not part of (?:the )?run",
            answer,
            re.I,
        )
        return bool(acknowledged), "inactive-source premise corrected" if acknowledged else "false active-source premise not corrected"

    run_case(results, "inactive-eba-false-premise", eba_question, check_eba)

    fake_id = "20991231T235959Z-deadbeef"
    fake_question = (
        "Summarize ChangeSentinel run " + fake_id
        + ". Give exact changed count, source_changed count, source ID and evidence path. If no committed record exists, "
        + "state you cannot verify it and do not use another run's data."
    )

    def check_fake(response, answer):
        # Models often use typographic apostrophes; normalize before scoring abstentions.
        content = (answer or str(response.get("error") or "")).lower().replace("’", "'").replace("‘", "'")
        abstains = any(phrase in content for phrase in (
            "cannot verify", "can't verify", "cannot find", "can't find", "no committed record", "not found",
            "no record", "not in the indexed", "not available in the indexed", "could not find",
            "cannot provide", "can't provide",
        ))
        return abstains, "explicit abstention on nonexistent run" if abstains else "unsupported details answered instead of abstaining"

    run_case(results, "nonexistent-run-abstention", fake_question, check_fake)

    if historical:
        historical_counts = historical.get("counts") or {}
        historical_id = str(historical.get("run_id"))
        historical_source = str(historical.get("source_id"))
        historical_question = (
            "Using data/history/index.json only, report exact counters for source " + historical_source
            + " in historical run " + historical_id
            + ": new, changed, source_changed, fetch_error and extraction_error. If a value is missing, say so."
        )

        def check_history(_response, answer):
            missing = [
                field for field in ("new", "changed", "source_changed", "fetch_error", "extraction_error")
                if field not in historical_counts or not count_mentioned(answer, field, historical_counts[field])
            ]
            if historical_id not in answer or historical_source not in answer:
                return False, "historical run or source ID missing"
            return not missing, "missing or incorrect historical counters: " + ", ".join(missing) if missing else "historical per-source counters reproduced"

        run_case(results, "historical-run-facts", historical_question, check_history)

    if first_event and evidence_path:
        event_type = str(evidence.get("event_type") or first_event.get("event_type") or "")
        diff_empty = evidence.get("diff") in ("", None)
        note = str(evidence.get("html_diff_note") or "")
        evidence_question = (
            "Inspect exactly " + evidence_path
            + ". Report event_type, whether the diff field is empty, and html_diff_note. State whether this record alone proves "
            + "the text of a specific regulatory provision changed; do not infer beyond its fields."
        )

        def check_evidence(_response, answer):
            lower = answer.lower()
            if event_type and event_type.lower() not in lower:
                return False, "exact event_type missing"
            if diff_empty and not any(phrase in lower for phrase in (
                "diff is empty", "empty diff", "diff field is empty", "no text-level diff", "blank diff", "diff field was blank",
            )):
                return False, "empty diff field was not characterized"
            if note and not any(phrase in lower for phrase in ("dom-level diff", "formatted dom", "dom diff")):
                return False, "html_diff_note not recognized"
            if not any(phrase in lower for phrase in (
                "does not prove", "cannot establish", "does not establish", "not established", "not by itself", "insufficient to prove",
            )):
                return False, "evidence limits were not stated"
            return True, "evidence fields and limits distinguished"

        run_case(results, "exact-change-evidence", evidence_question, check_evidence)

    passed = sum(1 for result in results if result["passed"] is True)
    failed = sum(1 for result in results if result["passed"] is False)
    inconclusive = sum(1 for result in results if result["passed"] is None)
    for result in results:
        marker = "PASS" if result["passed"] is True else "INCONCLUSIVE" if result["passed"] is None else "FAIL"
        print(f"{marker} [{result['name']}] HTTP={result['http_status']} - {result['detail']}")
        print("ANSWER EXCERPT: " + result["answer_excerpt"].replace("\n", " ")[:1300])

    summary = {
        "dashboard_run_tested": run_id,
        "case_count": len(results),
        "passed": passed,
        "failed": failed,
        "inconclusive": inconclusive,
        "results": results,
    }
    Path(".ask-sentinel-eval-result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as file:
            file.write("# Ask Sentinel live data-grounding evaluation\n\n")
            file.write(f"- Dashboard run tested: {run_id}\n")
            file.write(f"- Cases: {len(results)} | Passed: {passed} | Failed: {failed} | Inconclusive: {inconclusive}\n\n")
            for result in results:
                marker = "PASS" if result["passed"] is True else "INCONCLUSIVE" if result["passed"] is None else "FAIL"
                file.write(f"### {marker} - {result['name']}\n\n")
                file.write(result["detail"] + "\n\n")
                file.write("Answer excerpt: " + result["answer_excerpt"].replace("\n", " ")[:1300] + "\n\n")

    print(f"Ask Sentinel data-grounding evaluation: {passed} passed, {failed} failed, {inconclusive} inconclusive out of {len(results)}.")
    if failed or inconclusive:
        raise SystemExit(f"Live Ask Sentinel grounding evaluation: {failed} failed and {inconclusive} inconclusive out of {len(results)} cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
