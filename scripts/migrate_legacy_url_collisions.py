"""Dry-run-first migration for legacy URL IDs that collide under current canonicalization.

The audit never rewrites historical reports, immutable evidence, snapshots, run
history, or the notification ledger. Applying a safe plan changes only
data/latest.json, merging duplicate change timelines into a single inventory
record. Active sources are never mutated by this tool.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from regmon.config import DEFAULT_CONFIG_PATH, SourceConfig, load_config  # noqa: E402
from regmon.discovery import canonical  # noqa: E402
from regmon.fsutil import atomic_write_text  # noqa: E402


def _timestamp(value: object) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _record_snapshot_exists(record: dict, data_dir: Path) -> bool:
    pointer = record.get("snapshot_location")
    if not isinstance(pointer, str) or not pointer:
        return False
    repository_root = data_dir.resolve().parent
    resolved = (repository_root / pointer).resolve()
    if resolved != repository_root and repository_root not in resolved.parents:
        return False
    return resolved.is_file()


def _pending_signature(record: dict) -> str | None:
    pending = record.get("ai_pending")
    if pending is None:
        return None
    return json.dumps(pending, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _history_key(entry: dict) -> str:
    event_id = entry.get("event_id")
    if event_id:
        return "event:" + str(event_id)
    return "entry:" + json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _preferred_survivor(
    records: list[tuple[str, dict]],
    source: SourceConfig,
    canonical_url: str,
    data_dir: Path,
) -> tuple[str, dict]:
    configured_spellings = set(source.seed_urls) | set(source.allowed_urls)

    def rank(pair: tuple[str, dict]) -> tuple:
        url_id, record = pair
        url = str(record.get("canonical_url") or "")
        has_trusted_baseline = bool(
            record.get("normalized_hash")
            and _record_snapshot_exists(record, data_dir)
        )
        exact_configured_spelling = url in configured_spellings
        return (
            0 if has_trusted_baseline else 1,
            0 if exact_configured_spelling else 1,
            -_timestamp(record.get("last_checked")),
            -_timestamp(record.get("last_full_fetch")),
            0 if url == canonical_url else 1,
            url,
            url_id,
        )

    return sorted(records, key=rank)[0]


def audit_collisions(
    latest: dict,
    sources: dict[str, SourceConfig],
    data_dir: Path,
    source_filter: str | None = None,
) -> list[dict]:
    """Return deterministic collision plans without changing any files."""
    source_inventory = latest.get("sources")
    if not isinstance(source_inventory, dict):
        raise ValueError("data/latest.json must contain a sources object")

    plans = []
    for source_id in sorted(source_inventory):
        if source_filter and source_id != source_filter:
            continue
        records = source_inventory.get(source_id)
        if not isinstance(records, dict):
            continue
        source = sources.get(source_id)
        groups: dict[str, list[tuple[str, dict]]] = {}
        for url_id, record in records.items():
            if not isinstance(record, dict) or not record.get("canonical_url"):
                continue
            normalized_url = canonical(str(record["canonical_url"]))
            groups.setdefault(normalized_url, []).append((str(url_id), record))

        for canonical_url, group in sorted(groups.items()):
            if len(group) < 2:
                continue

            hashes = {str(record.get("normalized_hash") or "") for _, record in group}
            pending = {_pending_signature(record) for _, record in group if record.get("ai_pending") is not None}
            missing_snapshots = [
                url_id for url_id, record in group
                if not record.get("normalized_hash") or not _record_snapshot_exists(record, data_dir)
            ]
            reasons = []
            if source is None:
                reasons.append("source is not present in current configuration")
            elif source.active:
                reasons.append("source is active; active-source inventory migration is prohibited")
            if len(hashes) != 1 or "" in hashes:
                reasons.append("records do not share one non-empty normalized content hash")
            if missing_snapshots:
                reasons.append("one or more normalized-text snapshots are missing or unsafe")
            if len(pending) > 1:
                reasons.append("records contain different pending AI work items")

            survivor_id = ""
            if source is not None:
                survivor_id, _ = _preferred_survivor(group, source, canonical_url, data_dir)

            plans.append({
                "source_id": source_id,
                "source_active": bool(source.active) if source is not None else None,
                "canonical_url": canonical_url,
                "record_count": len(group),
                "survivor_url_id": survivor_id or None,
                "merged_url_ids": sorted(url_id for url_id, _ in group if url_id != survivor_id),
                "normalized_hash": next(iter(hashes)) if len(hashes) == 1 and "" not in hashes else None,
                "safe_to_migrate": not reasons,
                "reasons": reasons,
                "records": [
                    {
                        "url_id": url_id,
                        "canonical_url": record.get("canonical_url"),
                        "normalized_hash": record.get("normalized_hash"),
                        "last_checked": record.get("last_checked"),
                        "snapshot_location": record.get("snapshot_location"),
                        "snapshot_exists": _record_snapshot_exists(record, data_dir),
                    }
                    for url_id, record in sorted(group, key=lambda item: item[0])
                ],
            })
    return plans


def _merge_records(
    survivor: dict,
    duplicates: list[dict],
    *,
    canonical_url: str,
    survivor_id: str,
    migrated_at: str,
) -> dict:
    result = copy.deepcopy(survivor)
    all_records = [survivor, *duplicates]

    histories: dict[str, dict] = {}
    for record in all_records:
        for entry in record.get("change_history") or []:
            if isinstance(entry, dict):
                histories.setdefault(_history_key(entry), copy.deepcopy(entry))
    result["change_history"] = sorted(
        histories.values(),
        key=lambda entry: (_timestamp(entry.get("timestamp")), str(entry.get("event_id") or "")),
        reverse=True,
    )

    for field in ("first_seen",):
        values = [str(record[field]) for record in all_records if record.get(field)]
        if values:
            result[field] = min(values, key=_timestamp)
    for field in ("last_checked", "last_full_fetch", "last_changed_at"):
        values = [str(record[field]) for record in all_records if record.get(field)]
        if values:
            result[field] = max(values, key=_timestamp)

    if not result.get("ai_pending"):
        pending = [record.get("ai_pending") for record in all_records if record.get("ai_pending") is not None]
        if pending:
            result["ai_pending"] = copy.deepcopy(pending[0])

    result.pop("missing_since", None)
    result["canonical_url_collision_migration"] = {
        "migrated_at": migrated_at,
        "canonical_url": canonical_url,
        "survivor_url_id": survivor_id,
        "merged_url_ids": sorted(record_id for record_id, _ in []),
        "original_urls": sorted({str(record.get("canonical_url") or "") for record in all_records}),
        "normalized_hash": result.get("normalized_hash"),
        "policy": "same normalized hash and valid snapshots; preserve merged change history and immutable audit records",
    }
    return result


def migrate_collisions(latest: dict, plans: list[dict], migrated_at: str | None = None) -> tuple[dict, list[dict]]:
    """Apply only safe plans to a copy of the inventory; never mutate active sources."""
    migrated_at = migrated_at or datetime.now(timezone.utc).isoformat()
    result = copy.deepcopy(latest)
    applied = []
    inventory = result.get("sources") or {}
    for plan in plans:
        if not plan.get("safe_to_migrate") or plan.get("source_active") is not False:
            continue
        source_id = plan["source_id"]
        records = inventory.get(source_id)
        if not isinstance(records, dict):
            continue
        survivor_id = plan.get("survivor_url_id")
        merged_ids = plan.get("merged_url_ids") or []
        if not survivor_id or survivor_id not in records or any(url_id not in records for url_id in merged_ids):
            continue
        group_ids = [survivor_id, *merged_ids]
        if len(group_ids) != plan["record_count"]:
            continue
        group_records = [records[url_id] for url_id in group_ids]
        merged = _merge_records(
            records[survivor_id],
            [records[url_id] for url_id in merged_ids],
            canonical_url=plan["canonical_url"],
            survivor_id=survivor_id,
            migrated_at=migrated_at,
        )
        merged["canonical_url_collision_migration"]["merged_url_ids"] = sorted(merged_ids)
        records[survivor_id] = merged
        for url_id in merged_ids:
            records.pop(url_id, None)
        applied.append({
            "source_id": source_id,
            "canonical_url": plan["canonical_url"],
            "survivor_url_id": survivor_id,
            "merged_url_ids": sorted(merged_ids),
        })
    return result, applied


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--source", help="Audit one configured source ID")
    parser.add_argument("--apply", action="store_true", help="Apply only safe collisions in inactive sources")
    args = parser.parse_args()

    try:
        _payload, sources = load_config(args.config)
        if args.source and args.source not in sources:
            raise ValueError(f"Unknown source ID: {args.source}")
        latest_path = args.data_dir / "latest.json"
        latest = json.loads(latest_path.read_text(encoding="utf-8"))
        plans = audit_collisions(latest, sources, args.data_dir, args.source)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise SystemExit(f"Legacy URL collision audit failed: {exc}") from exc

    output = {
        "mode": "apply" if args.apply else "dry-run",
        "source_filter": args.source,
        "collision_groups": len(plans),
        "safe_groups": sum(1 for plan in plans if plan["safe_to_migrate"]),
        "unsafe_groups": sum(1 for plan in plans if not plan["safe_to_migrate"]),
        "plans": plans,
        "applied": [],
        "historical_reports_evidence_snapshots_and_notification_ledger_modified": False,
    }
    if args.apply:
        migrated, applied = migrate_collisions(latest, plans)
        if applied:
            atomic_write_text(latest_path, json.dumps(migrated, ensure_ascii=False, indent=2) + "\n")
        output["applied"] = applied
        output["inventory_written"] = bool(applied)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
