"""Golden-file extraction check: re-extract saved originals and compare to the baseline.

Every active inventory record produced by the current extractor version stores
the hash of its extracted text and a pointer to the original response (PDF/ZIP
file or HTML). Re-extracting those originals with the code and dependencies of
the checkout must reproduce the same text. If it does not, a library, runner or
parser change would alter extracted text for unchanged sources; that is caught
here, in CI, instead of becoming a false change alert (assessment H-01, E-01).

Records from an older extractor version are skipped: they are re-baselined by
the next scheduled scan. Records whose parser profile differs (for example,
Docling fell back on a slow runner) are reported but not failed, because the
engine records such transitions as baseline migrations. Docling (layout model)
output is not guaranteed bit-identical across CPUs, so a mismatch on a Docling
or ZIP-profile record is a warning; native, fallback and HTML extraction is
deterministic and must reproduce exactly.

Usage: python scripts/golden_corpus_check.py [--data-dir data] [--config config/sources.json]
Exit status 1 when any same-profile record no longer reproduces its baseline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from regmon.config import load_config  # noqa: E402
from regmon.content import CONTENT_EXTRACTOR_VERSION, extract_content  # noqa: E402
from regmon.engine import TABLES_EXTRACTOR_VERSION, is_current_extractor_version  # noqa: E402


# Immutable originals that exposed difficult, table-heavy extraction paths. These
# sentinels complement hash reproducibility: a stable but incomplete baseline must
# not pass merely because the same incomplete text is reproduced on every run.
# Key by original response hash so future source versions do not inherit stale
# document-specific expectations; add a new reviewed sentinel when needed.
PDF_QUALITY_SENTINELS = {
    "f80f4d4734a67976906f8249f9e9ed713b8336085564914fa61f04aaff4e253a": {
        "min_characters": 150_000,
        "required_markers": [
            "FR Y-9C",
            "total consolidated assets of $3 billion or more",
            "Page 1 of 73",
            "Page 73 of 73",
            "B028",
        ],
    },
    "8ed5206561a87ec3f43a958323122329c1eeb3f873bd1a376d4fce18dc5f50a6": {
        "min_characters": 1_500_000,
        "required_markers": [
            "Instructions for Preparation of Consolidated Financial Statements",
            "FR Y-9C Contents-1",
            "General Instructions",
            "Line Item Instructions",
        ],
    },
    "29bd3a812aaab10ffc4848b3410037d1961be60ced0f468e6ea85ce31dd8f9ef": {
        "min_characters": 500_000,
        "required_markers": [
            "Reporting Form FR Y-14Q",
            "WHO MUST REPORT",
            "WHERE TO SUBMIT THE REPORTS",
            "WHEN TO SUBMIT THE REPORTS",
        ],
    },
}


def quality_sentinel_failure(raw_hash: object, text: str | None) -> dict | None:
    """Return a diagnostic when a known, immutable PDF extracts incomplete text."""
    sentinel = PDF_QUALITY_SENTINELS.get(str(raw_hash or ""))
    if sentinel is None:
        return None
    normalized_text = text or ""
    missing_markers = [
        marker for marker in sentinel["required_markers"]
        if marker.casefold() not in normalized_text.casefold()
    ]
    if len(normalized_text) < sentinel["min_characters"] or missing_markers:
        return {
            "characters": len(normalized_text),
            "minimum_characters": sentinel["min_characters"],
            "missing_markers": missing_markers,
        }
    return None


# Every workbook format keeps its original and uses the workbook extractor version.
WORKBOOK_KINDS = {"xlsx", "xls", "ods"}
ORIGINAL_KINDS = {"pdf", "zip"} | WORKBOOK_KINDS


def profile_version(extraction_type: str, profile: str) -> str:
    """Mirror engine.make_current_item's extractor_version labelling."""
    if extraction_type == "zip" and profile.startswith("zipprofile-"):
        return CONTENT_EXTRACTOR_VERSION + "-" + profile
    if extraction_type in {"pdf", "zip"} and profile == "fallback":
        return CONTENT_EXTRACTOR_VERSION + "-fallback"
    if extraction_type == "pdf" and profile == "tables":
        return TABLES_EXTRACTOR_VERSION
    if extraction_type in WORKBOOK_KINDS:
        return CONTENT_EXTRACTOR_VERSION + "-xlsx2"
    return CONTENT_EXTRACTOR_VERSION


def check(data_dir: Path, config_path: Path) -> dict:
    _payload, sources = load_config(config_path)
    latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8"))
    results = {"eligible": 0, "checked": 0, "matched": 0, "mismatched": [], "quality_failures": [], "model_variance": [], "profile_changed": [], "skipped_old_version": 0}
    for source_id, records in (latest.get("sources") or {}).items():
        source = sources.get(source_id)
        if source is None or not source.active:
            continue
        for record in records.values():
            if record.get("fetch_error") or record.get("extraction_error") or not record.get("normalized_hash"):
                continue
            kind = str(record.get("extraction_type") or "")
            pointer = record.get("file_snapshot_location") if kind in ORIGINAL_KINDS else record.get("html_snapshot_location")
            if kind not in {"html"} | ORIGINAL_KINDS or not pointer:
                continue
            # Eligible: a record this gate can re-extract from its saved original.
            results["eligible"] += 1
            if not is_current_extractor_version(record.get("extractor_version")):
                results["skipped_old_version"] += 1
                continue
            original = data_dir.parent / pointer
            if not original.is_file():
                results["mismatched"].append({"url": record["canonical_url"], "reason": f"missing original {pointer}"})
                continue
            profile: dict = {}
            text, extracted_kind, error = extract_content(
                record["canonical_url"], record.get("content_type") or "", original.read_bytes(),
                include_selector=source.include_selector, ignore_selectors=source.ignore_selectors,
                _extraction_profile=profile,
            )
            results["checked"] += 1
            produced_profile = str(profile.get("profile") or "native")
            produced_version = profile_version(extracted_kind, produced_profile)
            digest = hashlib.sha256((text or "").encode("utf-8")).hexdigest() if not error else None
            quality_failure = quality_sentinel_failure(record.get("raw_hash"), text if not error else None)
            if quality_failure:
                results["quality_failures"].append({
                    "url": record["canonical_url"],
                    "raw_hash": record.get("raw_hash"),
                    **quality_failure,
                })
            if digest == record["normalized_hash"]:
                results["matched"] += 1
            elif produced_version != record.get("extractor_version"):
                results["profile_changed"].append({
                    "url": record["canonical_url"],
                    "baseline_version": record.get("extractor_version"),
                    "produced_version": produced_version,
                })
            elif not error and (produced_profile == "docling" or produced_profile.startswith("zipprofile-")):
                results["model_variance"].append({
                    "url": record["canonical_url"],
                    "extractor_version": record.get("extractor_version"),
                })
            else:
                results["mismatched"].append({
                    "url": record["canonical_url"],
                    "reason": error or "extracted text no longer matches the baseline hash",
                    "extractor_version": record.get("extractor_version"),
                })
    return results


def gate_failures(results: dict, *, allow_empty: bool = False, max_skipped_share: float = 0.5) -> list[str]:
    """Reasons the gate must fail although nothing mismatched.

    Bumping CONTENT_EXTRACTOR_VERSION made every record skip as "older version",
    so the gate checked nothing and passed: the operation the corpus exists to
    police silenced it. An empty or mostly-skipped run now fails unless allowed.
    """
    eligible, checked, skipped = results.get("eligible", 0), results.get("checked", 0), results.get("skipped_old_version", 0)
    if not eligible or allow_empty:
        return []
    if checked == 0:
        return [f"The golden extraction corpus re-checked 0 of {eligible} eligible record(s) "
                f"({skipped} skipped as an older extractor version), so it enforced nothing. "
                "Re-baseline with a scan, or pass --allow-empty for a deliberate version bump."]
    if skipped / eligible > max_skipped_share:
        return [f"The golden extraction corpus skipped {skipped} of {eligible} eligible record(s) "
                f"as an older extractor version (limit {max_skipped_share:.0%}); the corpus is stale. "
                "Re-baseline with a scan, or raise --max-skipped-share deliberately."]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "sources.json")
    parser.add_argument(
        "--allow-empty", action="store_true",
        help="Pass even when no record was re-checked (only for a deliberate extractor-version bump "
             "before the next scan re-baselines the corpus)",
    )
    parser.add_argument(
        "--max-skipped-share", type=float, default=0.5,
        help="Fail when more than this share of eligible records was skipped as an older extractor version",
    )
    args = parser.parse_args()
    results = check(args.data_dir, args.config)
    print(json.dumps(results, indent=2))
    for failure in gate_failures(results, allow_empty=args.allow_empty, max_skipped_share=args.max_skipped_share):
        raise SystemExit(failure)
    if results["mismatched"]:
        raise SystemExit(
            f"{len(results['mismatched'])} record(s) no longer reproduce their extracted baseline. "
            "Bump CONTENT_EXTRACTOR_VERSION if the change is intended, or pin the dependency that drifted."
        )
    if results["quality_failures"]:
        raise SystemExit(
            f"{len(results['quality_failures'])} known PDF extraction quality sentinel(s) failed. "
            "Inspect extraction fidelity before accepting or re-baselining the output."
        )


if __name__ == "__main__":
    main()
