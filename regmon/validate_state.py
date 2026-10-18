"""Validate persisted discovery state for active, selected sources only."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def _has_prior_source_state(source_id: str, discovery_dir: Path) -> bool:
    """Return whether any durable state proves this source has run before."""
    data_dir = discovery_dir.parent

    latest_path = data_dir / "latest.json"
    if latest_path.exists():
        try:
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
            source_groups = latest.get("sources")
            if isinstance(source_groups, dict) and source_id in source_groups:
                return True
            # Compatibility with an older flat inventory.
            if isinstance(latest, dict) and any(
                isinstance(record, dict) and record.get("source_id") == source_id
                for record in latest.values()
            ):
                return True
        except (OSError, json.JSONDecodeError):
            # Invalid persisted inventory is not treated as evidence of a clean bootstrap.
            return True

    report_path = data_dir / "reports" / f"{source_id}.json"
    if report_path.exists():
        return True

    history_path = data_dir / "history" / "index.json"
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text(encoding="utf-8"))
            if isinstance(history, list) and any(
                isinstance(row, dict) and row.get("source_id") == source_id
                for row in history
            ):
                return True
        except (OSError, json.JSONDecodeError):
            return True

    # A checkpoint, shard, or failure ledger means discovery has started and must
    # not be silently treated as a never-run source if its main metadata vanished.
    if any(discovery_dir.glob(f"{source_id}*")):
        return True
    return False


def validate_selected_state(
    requested: str,
    config_path: Path,
    discovery_dir: Path,
) -> tuple[list[tuple[str, str]], list[str]]:
    config: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    source_items = config.get("sources", [])
    source_map = {str(item.get("id")): item for item in source_items if item.get("id")}
    active_ids = {sid for sid, item in source_map.items() if item.get("active", True)}

    if requested in {"all", "*"}:
        selected_ids = sorted(active_ids)
    else:
        if requested not in source_map:
            raise ValueError(f"Unknown source selection: {requested}")
        if requested not in active_ids:
            raise ValueError(f"Source {requested} is inactive and cannot be run by the production workflow")
        selected_ids = [requested]
    if not selected_ids:
        raise ValueError("No active monitoring sources are configured for this run")

    states: list[tuple[str, str]] = []
    paused_sources: list[str] = []
    for source_id in selected_ids:
        metadata_path = discovery_dir / f"{source_id}.json"
        if not metadata_path.exists():
            if _has_prior_source_state(source_id, discovery_dir):
                raise ValueError(f"Discovery metadata missing for previously monitored source {source_id}")
            # A source added to configuration has no state until its first monitoring
            # run. It is safe to bootstrap it; the production workflow will perform
            # discovery before its post-run state validation.
            states.append((source_id, "UNINITIALIZED"))
            continue
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        if str(payload.get("source_id") or source_id) != source_id:
            raise ValueError(f"Discovery metadata source mismatch for {source_id}")
        state = str(payload.get("state") or "FAILED").upper()
        states.append((source_id, state))
        if state != "PAUSED":
            continue

        checkpoint_path = discovery_dir / f"{source_id}-checkpoint.json"
        if not checkpoint_path.exists() or checkpoint_path.stat().st_size == 0:
            raise ValueError(f"{source_id} is PAUSED but its checkpoint is missing or empty")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("state") != "PAUSED" or checkpoint.get("source_id") != source_id:
            raise ValueError(f"{source_id} has an invalid PAUSED checkpoint")
        pending = checkpoint.get("pending")
        retry_pending = checkpoint.get("retry_pending", [])
        if not isinstance(pending, list) or not isinstance(retry_pending, list):
            raise ValueError(f"{source_id} has invalid checkpoint queue types")
        if not pending and not retry_pending:
            raise ValueError(f"{source_id} is PAUSED with no resumable work in its checkpoint")
        paused_sources.append(source_id)

    return states, paused_sources


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.getenv("REGMON_SOURCE", "all"))
    parser.add_argument("--config", type=Path, default=Path("config/sources.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()

    states, paused_sources = validate_selected_state(
        args.source,
        args.config,
        args.data_dir / "discovery",
    )
    paused = bool(paused_sources)
    print(f"states={states}")
    print(f"paused_sources={paused_sources}")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"paused={'true' if paused else 'false'}\n")
            handle.write(f"paused_source={paused_sources[0] if paused_sources else ''}\n")
            handle.write(f"paused_sources={','.join(paused_sources)}\n")


if __name__ == "__main__":
    main()
