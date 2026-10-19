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
engine records such transitions as baseline migrations.

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
from regmon.engine import is_current_extractor_version  # noqa: E402


def profile_version(extraction_type: str, profile: str) -> str:
    """Mirror engine.make_current_item's extractor_version labelling."""
    if extraction_type == "zip" and profile.startswith("zipprofile-"):
        return CONTENT_EXTRACTOR_VERSION + "-" + profile
    if extraction_type in {"pdf", "zip"} and profile == "fallback":
        return CONTENT_EXTRACTOR_VERSION + "-fallback"
    return CONTENT_EXTRACTOR_VERSION


def check(data_dir: Path, config_path: Path) -> dict:
    _payload, sources = load_config(config_path)
    latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8"))
    results = {"checked": 0, "matched": 0, "mismatched": [], "profile_changed": [], "skipped_old_version": 0}
    for source_id, records in (latest.get("sources") or {}).items():
        source = sources.get(source_id)
        if source is None or not source.active:
            continue
        for record in records.values():
            if record.get("fetch_error") or record.get("extraction_error") or not record.get("normalized_hash"):
                continue
            kind = str(record.get("extraction_type") or "")
            if not is_current_extractor_version(record.get("extractor_version")):
                results["skipped_old_version"] += 1
                continue
            pointer = record.get("file_snapshot_location") if kind in {"pdf", "zip"} else record.get("html_snapshot_location")
            if kind not in {"html", "pdf", "zip"} or not pointer:
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
            produced_version = profile_version(extracted_kind, str(profile.get("profile") or "native"))
            digest = hashlib.sha256((text or "").encode("utf-8")).hexdigest() if not error else None
            if digest == record["normalized_hash"]:
                results["matched"] += 1
            elif produced_version != record.get("extractor_version"):
                results["profile_changed"].append({
                    "url": record["canonical_url"],
                    "baseline_version": record.get("extractor_version"),
                    "produced_version": produced_version,
                })
            else:
                results["mismatched"].append({
                    "url": record["canonical_url"],
                    "reason": error or "extracted text no longer matches the baseline hash",
                    "extractor_version": record.get("extractor_version"),
                })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "sources.json")
    args = parser.parse_args()
    results = check(args.data_dir, args.config)
    print(json.dumps(results, indent=2))
    if results["mismatched"]:
        raise SystemExit(
            f"{len(results['mismatched'])} record(s) no longer reproduce their extracted baseline. "
            "Bump CONTENT_EXTRACTOR_VERSION if the change is intended, or pin the dependency that drifted."
        )


if __name__ == "__main__":
    main()
